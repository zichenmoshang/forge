/**
 * 评审多轮对话 Runner（issue #47 Harness 拆分）
 *
 * 从 Harness 拆出的方案评审（design）与代码 CR（code）两套多轮对话循环：
 * - runDesignReviewDialog / runCodeReviewDialog：Reviewer ↔ 修改方 多轮对话
 * - suspend/advance/resume：暂停等待人工、推进、恢复续跑
 *
 * 设计要点：
 * - 无内部可变状态（每次 run 从头构造），Harness 门面持有单例并按需调用；
 * - 依赖注入：共享字段走 deps（agents/artifactStore/stateMachine/...），
 *   跨类回调走 callbacks（failExecution/runExecutionLoop/resume/...），避免与 Harness 循环依赖；
 * - 行为与原 Harness 内实现完全一致（#47 纯拆分，不改语义）。
 */

import { isHardBlockingState } from './state-machine';
import { getNextState } from './state-transitions';
import type { StateMachine } from './state-machine';
import type { ArtifactStore } from './artifact-store';
import type { ContextManager } from './context-manager';
import type { TokenBudgetTracker } from './token-budget';
import type { MetricsCollector } from '../observability/metrics';
import type { Logger } from '../observability/logger';
import type { BaseAgent } from '../agents/base';
import type { CodingAgent } from '../agents/coding-agent';
import type { AgentContext, GlobalContext } from '../agents/types';
import type { PipelineStateName } from '../types/state';
import type { UserStorySet } from '../types/user-story';
import type { FrontendDesignDoc } from '../types/frontend-design';
import type { CodingPhaseResult, CodingResult, CodingTask } from '../types/coding-task';
import type { ReviewResult, ReviewIssue } from '../types/review-and-delivery';
import type {
  DesignRevision,
  ReviewDialogHistory,
  DialogMessage,
  IssueResponse,
} from '../types/review-dialog';
import type { CodeReviewInput } from '../agents/review-agent';
import { aggregateCodingResults } from './coding-aggregator';
import type { KnowledgeService } from '../services/knowledge-service';
import type {
  AgentRegistry,
  HarnessExecutionResult,
  HumanInterventionCallback,
  WeakInterventionDecision,
} from './harness';

/** 共享依赖（由 Harness 门面构建并注入） */
export interface ReviewDialogDeps {
  agents: AgentRegistry;
  artifactStore: ArtifactStore;
  stateMachine: StateMachine;
  contextManager: ContextManager;
  instanceId: string;
  logger?: Logger;
  maxReviewRounds: number;
  interruptAfterEachRound: boolean;
  knowledgeService?: KnowledgeService;
  projectId?: string;
  tokenBudget: TokenBudgetTracker;
  /** 链路追踪根 ID（Harness 生成，注入全部 AgentContext） */
  traceId: string;
  /** Metrics 指标聚合器（Harness 单例，注入全部 AgentContext） */
  metrics: MetricsCollector;
}

/** 跨类回调（指向 Harness 门面，避免循环依赖） */
export interface ReviewDialogCallbacks {
  failExecution(message: string): HarnessExecutionResult;
  attachInstanceId(data: unknown): void;
  runExecutionLoop(): Promise<HarnessExecutionResult>;
  fallback(to: PipelineStateName, reason: string): Promise<HarnessExecutionResult>;
  resume(answer?: string): Promise<HarnessExecutionResult>;
  invokeWeakIntervention(
    state: PipelineStateName,
    artifact: unknown,
  ): Promise<WeakInterventionDecision>;
  buildBlockingQuestion(state: PipelineStateName): string;
  /** 构建 CR 修订用的逐故事编码任务（编码任务装配逻辑归属 Harness/ContextManager） */
  buildCodingTaskForStory(
    story: UserStorySet['stories'][number],
    index: number,
    total: number,
  ): CodingTask | undefined;
  onHumanIntervention?: HumanInterventionCallback;
}

export class ReviewDialogRunner {
  constructor(
    private readonly deps: ReviewDialogDeps,
    private readonly callbacks: ReviewDialogCallbacks,
  ) {}

  // ============================================================
  // 方案评审多轮对话循环（#42，详见 docs/08-review-dialog.md）
  // ============================================================

  /**
   * 方案评审对话循环：Reviewer 评审 →（approve 退出 / request_human 暂停 /
   * request_changes 由 Designer.revise 修改）→ 下一轮，直到通过、升级人工或达到最大轮次。
   */
  async runDesignReviewDialog(): Promise<HarnessExecutionResult> {
    const { agents, artifactStore, stateMachine, contextManager, instanceId, logger } = this.deps;
    const reviewAgent = agents.review;
    const designAgent = agents.design;
    if (!reviewAgent) {
      return this.callbacks.failExecution('状态 DESIGN_REVIEWING 缺少 ReviewAgent');
    }

    const currentDesign0 = artifactStore.get<FrontendDesignDoc>('design', instanceId);
    const stories = artifactStore.get<UserStorySet>('stories', instanceId);
    if (!currentDesign0 || !stories) {
      return this.callbacks.failExecution('方案评审缺少上游产物（design/stories）');
    }

    const dialogStart = Date.now();
    let currentDesign = currentDesign0;
    let previousIssues: ReviewIssue[] = [];
    let issueResponses = [] as DesignRevision['issueResponses'];
    const dialogMessages: DialogMessage[] = [];

    // 恢复未结束的对话历史（resume 续跑场景），否则新建
    let history =
      artifactStore.get<ReviewDialogHistory>('design-review-history', instanceId) ?? undefined;
    if (!history || history.finalVerdict === 'approved') {
      history = {
        reviewType: 'design-review',
        maxRounds: this.deps.maxReviewRounds,
        rounds: [],
        finalVerdict: 'needs_human',
        finalVersion: 0,
        totalDurationMs: 0,
      };
    }
    const startRound = history.rounds.length + 1;
    // resume 续跑时从上一轮恢复 previousIssues（否则第 2 轮起 previousIssues 为空，触发 #49 MISSING_PREVIOUS_ISSUES）
    if (history.rounds.length > 0) {
      previousIssues = history.rounds[history.rounds.length - 1].review.issues;
    }

    for (let round = startRound; round <= this.deps.maxReviewRounds; round++) {
      // 1. Reviewer 评审
      const reviewCtx: AgentContext = {
        instanceId,
        stage: 'design-reviewing',
        input: {
          type: 'review-design',
          design: currentDesign,
          round,
          previousIssues,
          issueResponses,
        },
        globalContext: contextManager.getGlobalContext(),
        knowledgeService: this.deps.knowledgeService,
        projectId: this.deps.projectId,
        tokenBudget: this.deps.tokenBudget,
        traceId: this.deps.traceId,
        metrics: this.deps.metrics,
      };

      const reviewResult = await reviewAgent.execute(reviewCtx);
      if (!reviewResult.success || !reviewResult.data) {
        return this.callbacks.failExecution(
          `第 ${round} 轮方案评审失败: ${reviewResult.errors.map((e) => e.message).join('; ')}`,
        );
      }
      const review = reviewResult.data as ReviewResult;
      this.callbacks.attachInstanceId(review);
      artifactStore.save('design-review', instanceId, review);
      dialogMessages.push({
        role: 'reviewer',
        content: review.summary,
        structuredOutput: review,
        round,
        timestamp: new Date().toISOString(),
      });

      // 2. 以程序化仲裁动作为准
      if (review.resolvedAction === 'approve') {
        history.rounds.push({
          round,
          review,
          messages: [...dialogMessages],
          allBlockingResolved: true,
          durationMs: Date.now() - dialogStart,
        });
        history.finalVerdict = 'approved';
        history.finalVersion = currentDesign.version;
        history.totalDurationMs = Date.now() - dialogStart;
        artifactStore.save('design-review-history', instanceId, history);
        logger?.info(`[Harness] 方案评审第 ${round} 轮通过，进入 API 契约确认`);
        return this.advanceAfterReview();
      }

      if (review.resolvedAction === 'request_human') {
        history.rounds.push({
          round,
          review,
          messages: [...dialogMessages],
          allBlockingResolved: false,
          durationMs: Date.now() - dialogStart,
        });
        history.finalVerdict = 'needs_human';
        history.suspendReason = '评审请求人工裁决（request_human）';
        history.totalDurationMs = Date.now() - dialogStart;
        artifactStore.save('design-review-history', instanceId, history);
        return this.suspendReviewForHuman(history.suspendReason);
      }

      // 3. request_changes：需要 Designer 修订
      if (!designAgent) {
        history.finalVerdict = 'needs_human';
        history.suspendReason = '评审要求修改但未注册 DesignAgent，无法自动修订';
        artifactStore.save('design-review-history', instanceId, history);
        return this.suspendReviewForHuman(history.suspendReason);
      }

      const openIssues = review.issues.filter((i) => i.status === 'open');
      const reviseCtx: AgentContext = {
        instanceId,
        stage: 'design-reviewing',
        input: {
          type: 'revise-design',
          previousDesign: currentDesign,
          previousIssues: openIssues,
          round,
          stories,
        },
        globalContext: contextManager.getGlobalContext(),
        knowledgeService: this.deps.knowledgeService,
        projectId: this.deps.projectId,
        tokenBudget: this.deps.tokenBudget,
        traceId: this.deps.traceId,
        metrics: this.deps.metrics,
      };
      const reviseResult = await designAgent.revise(reviseCtx);
      if (!reviseResult.success || !reviseResult.data) {
        return this.callbacks.failExecution(
          `第 ${round} 轮方案修订失败: ${reviseResult.errors.map((e) => e.message).join('; ')}`,
        );
      }
      const revision = reviseResult.data as DesignRevision;
      currentDesign = revision.updatedDesign;
      this.callbacks.attachInstanceId(currentDesign);
      artifactStore.save('design', instanceId, currentDesign);
      issueResponses = revision.issueResponses;
      // 下一轮闭环校验以本轮全部问题为基准（findUnverifiedIssues 内部跳过已闭环项）
      previousIssues = review.issues;
      dialogMessages.push({
        role: 'designer',
        content: revision.changeSummary,
        structuredOutput: revision,
        round,
        timestamp: new Date().toISOString(),
      });

      history.rounds.push({
        round,
        review,
        revision,
        messages: [...dialogMessages],
        allBlockingResolved: false,
        durationMs: Date.now() - dialogStart,
      });
      artifactStore.save('design-review-history', instanceId, history);

      // 4. 每轮后可选弱介入（默认关闭；invokeWeakIntervention 内部处理无回调场景）
      if (this.deps.interruptAfterEachRound) {
        const decision = await this.callbacks.invokeWeakIntervention('DESIGN_REVIEWING', history);
        if (decision.action === 'fallback') {
          return this.callbacks.fallback(decision.to, decision.reason);
        }
      }
    }

    // 5. 达到最大轮次仍未通过 → 暂停等人工
    history.finalVerdict = 'max_rounds_reached';
    history.suspendReason = `已达到最大评审轮次（${this.deps.maxReviewRounds}）仍存在 blocking 问题，需要人工决策`;
    history.totalDurationMs = Date.now() - dialogStart;
    this.deps.artifactStore.save('design-review-history', this.deps.instanceId, history);
    return this.suspendReviewForHuman(history.suspendReason);
  }

  /** 评审通过后推进到 API_CONFIRMATION 硬卡点并处理等待/回调 */
  private async advanceAfterReview(): Promise<HarnessExecutionResult> {
    const nextState = getNextState('DESIGN_REVIEWING');
    if (!nextState) return this.callbacks.failExecution('无法确定 DESIGN_REVIEWING 的下一状态');
    const advance = this.deps.stateMachine.transition({ type: 'ADVANCE', to: nextState });
    if (!advance.success) return this.callbacks.failExecution(`状态推进失败: ${advance.message}`);

    if (isHardBlockingState(nextState)) {
      const question = this.callbacks.buildBlockingQuestion(nextState);
      this.deps.logger?.info(`[Harness] 进入硬卡点: ${nextState}，等待人工介入`);
      if (this.callbacks.onHumanIntervention) {
        const answer = await this.callbacks.onHumanIntervention(nextState, question, {
          instanceId: this.deps.instanceId,
        });
        return this.callbacks.resume(answer);
      }
      return {
        success: true,
        finalState: nextState,
        message: question,
        waitingForHuman: true,
        waitingQuestion: question,
      };
    }
    // 非硬卡点则继续主循环
    return this.callbacks.runExecutionLoop();
  }

  /** 评审对话中途暂停：currentState 不变，仅置 waiting_human */
  private suspendReviewForHuman(reason: string): HarnessExecutionResult {
    this.deps.stateMachine.pauseForHuman(reason);
    this.deps.logger?.warn(`[Harness] 方案评审暂停等待人工: ${reason}`);
    return {
      success: true,
      finalState: 'DESIGN_REVIEWING',
      message: reason,
      waitingForHuman: true,
      waitingQuestion: reason,
    };
  }

  /**
   * 方案评审对话暂停后的恢复：
   * - max_rounds_reached：人工 resume 视为接受当前版本，推进到 API 确认硬卡点
   * - needs_human（request_human，轮次未用完）：从 history 续跑下一轮评审
   */
  async resumeDesignReviewDialog(): Promise<HarnessExecutionResult> {
    const history = this.deps.artifactStore.get<ReviewDialogHistory>(
      'design-review-history',
      this.deps.instanceId,
    );
    this.deps.stateMachine.markRunning();

    if (history?.finalVerdict === 'max_rounds_reached') {
      this.deps.logger?.info('[Harness] 人工在最大轮次后放行方案评审，推进到 API 确认');
      return this.advanceAfterReview();
    }
    // 续跑对话循环（startRound 由已保存 rounds 数推导）
    return this.callbacks.runExecutionLoop();
  }

  // ============================================================
  // 代码 CR 多轮对话（Reviewer ↔ Coder，复用 #42 模式）
  // ============================================================

  async runCodeReviewDialog(): Promise<HarnessExecutionResult> {
    const { agents, artifactStore, stateMachine, contextManager, instanceId, logger } = this.deps;
    const reviewAgent = agents.review;
    const codingAgent = agents.coding;
    if (!reviewAgent) return this.callbacks.failExecution('状态 CODE_REVIEWING 缺少 ReviewAgent');

    const design = artifactStore.get<FrontendDesignDoc>('design', instanceId);
    let coding = artifactStore.get<CodingPhaseResult>('coding', instanceId);
    const stories = artifactStore.get<UserStorySet>('stories', instanceId);
    if (!design || !coding || !stories)
      return this.callbacks.failExecution('代码 CR 缺少上游产物（design/coding/stories）');

    const dialogStart = Date.now();
    let previousIssues: ReviewIssue[] = [];
    let issueResponses: IssueResponse[] = [];
    const dialogMessages: DialogMessage[] = [];

    // 恢复未结束的对话历史（resume 续跑场景），否则新建
    let history =
      artifactStore.get<ReviewDialogHistory>('code-review-history', instanceId) ?? undefined;
    if (!history || history.finalVerdict === 'approved') {
      history = {
        reviewType: 'code-review',
        maxRounds: this.deps.maxReviewRounds,
        rounds: [],
        finalVerdict: 'needs_human',
        finalVersion: 0,
        totalDurationMs: 0,
      };
    }
    const startRound = history.rounds.length + 1;
    // resume 续跑时从上一轮恢复 previousIssues（否则第 2 轮起 previousIssues 为空，触发 #49 MISSING_PREVIOUS_ISSUES）
    if (history.rounds.length > 0) {
      previousIssues = history.rounds[history.rounds.length - 1].review.issues;
    }

    for (let round = startRound; round <= this.deps.maxReviewRounds; round++) {
      // 1. Reviewer CR（只针对 success/partial 故事）
      const reviewCtx: AgentContext = {
        instanceId,
        stage: 'code-reviewing',
        input: {
          type: 'review-code',
          design,
          coding,
          round,
          previousIssues,
          issueResponses,
        } as CodeReviewInput,
        globalContext: contextManager.getGlobalContext(),
        knowledgeService: this.deps.knowledgeService,
        projectId: this.deps.projectId,
        tokenBudget: this.deps.tokenBudget,
        traceId: this.deps.traceId,
        metrics: this.deps.metrics,
      };

      const reviewResult = await reviewAgent.execute(reviewCtx);
      if (!reviewResult.success || !reviewResult.data) {
        return this.callbacks.failExecution(
          `第 ${round} 轮代码 CR 失败: ${reviewResult.errors.map((e) => e.message).join('; ')}`,
        );
      }
      const review = reviewResult.data as ReviewResult;
      this.callbacks.attachInstanceId(review);
      artifactStore.save('code-review', instanceId, review);
      dialogMessages.push({
        role: 'reviewer',
        content: review.summary,
        structuredOutput: review,
        round,
        timestamp: new Date().toISOString(),
      });

      // 2. 以程序化仲裁动作为准
      if (review.resolvedAction === 'approve') {
        history.rounds.push({
          round,
          review,
          messages: [...dialogMessages],
          allBlockingResolved: true,
          durationMs: Date.now() - dialogStart,
        });
        history.finalVerdict = 'approved';
        history.totalDurationMs = Date.now() - dialogStart;
        artifactStore.save('code-review-history', instanceId, history);
        logger?.info(`[Harness] 代码 CR 第 ${round} 轮通过`);
        return this.advanceAfterCodeReview();
      }

      if (review.resolvedAction === 'request_human') {
        history.rounds.push({
          round,
          review,
          messages: [...dialogMessages],
          allBlockingResolved: false,
          durationMs: Date.now() - dialogStart,
        });
        history.finalVerdict = 'needs_human';
        history.suspendReason = '代码 CR 请求人工裁决（request_human）';
        history.totalDurationMs = Date.now() - dialogStart;
        artifactStore.save('code-review-history', instanceId, history);
        return this.suspendCodeReviewForHuman(history.suspendReason);
      }

      // 3. request_changes：Coder 修订受影响的故事
      if (!codingAgent) {
        history.finalVerdict = 'needs_human';
        history.suspendReason = '代码 CR 要求修改但未注册 CodingAgent，无法自动修订';
        artifactStore.save('code-review-history', instanceId, history);
        return this.suspendCodeReviewForHuman(history.suspendReason);
      }

      const openIssues = review.issues.filter((i) => i.status === 'open');
      const affectedStoryIds = new Set(openIssues.flatMap((i) => i.relatedStoryIds ?? []));
      const reviewable = coding.results.filter((r) => r.status !== 'failed');
      const targets =
        affectedStoryIds.size > 0
          ? reviewable.filter((r) => affectedStoryIds.has(r.storyId))
          : reviewable;

      const responseMap = new Map<string, IssueResponse>();
      let anyRevised = false;
      for (const currentResult of targets) {
        const story = stories.stories.find((s) => s.id === currentResult.storyId);
        if (!story) continue;
        const storyIndex = stories.stories.findIndex((s) => s.id === currentResult.storyId);
        const task = this.buildCodingTaskForStory(story, storyIndex, stories.stories.length);
        if (!task) continue;

        const reviseCtx: AgentContext = {
          instanceId,
          stage: 'code-reviewing',
          input: {
            type: 'revise-code',
            task,
            currentResult,
            previousIssues: openIssues,
            round,
          },
          globalContext: contextManager.getGlobalContext(),
          knowledgeService: this.deps.knowledgeService,
          projectId: this.deps.projectId,
          tokenBudget: this.deps.tokenBudget,
          traceId: this.deps.traceId,
          metrics: this.deps.metrics,
        };

        try {
          const reviseResult = await codingAgent.revise(reviseCtx);
          if (reviseResult.success && reviseResult.data) {
            const idx = coding.results.findIndex((r) => r.storyId === currentResult.storyId);
            if (idx >= 0) coding.results[idx] = reviseResult.data.updatedResult;
            for (const resp of reviseResult.data.issueResponses)
              responseMap.set(resp.issueId, resp);
            dialogMessages.push({
              role: 'coder',
              content: reviseResult.data.changeSummary,
              structuredOutput: reviseResult.data,
              round,
              timestamp: new Date().toISOString(),
            });
            anyRevised = true;
          }
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          logger?.error(`[Harness] 故事 ${currentResult.storyId} CR 修订异常: ${reason}`);
        }
      }

      if (!anyRevised) {
        return this.callbacks.failExecution(
          `第 ${round} 轮代码 CR 要求修改，但没有任何故事成功修订`,
        );
      }

      // 重新聚合并更新 coding 产物（CR revise 后版本 +1，单调递增）
      issueResponses = Array.from(responseMap.values());
      coding = aggregateCodingResults(coding.results, {
        id: coding.id,
        instanceId,
        designDocId: design.id,
        version: (coding.version ?? 1) + 1,
      });
      this.callbacks.attachInstanceId(coding);
      artifactStore.save('coding', instanceId, coding);
      previousIssues = review.issues;

      history.rounds.push({
        round,
        review,
        messages: [...dialogMessages],
        allBlockingResolved: false,
        durationMs: Date.now() - dialogStart,
      });
      artifactStore.save('code-review-history', instanceId, history);

      // 4. 每轮后可选弱介入（默认关闭；invokeWeakIntervention 内部处理无回调场景）
      if (this.deps.interruptAfterEachRound) {
        const decision = await this.callbacks.invokeWeakIntervention('CODE_REVIEWING', history);
        if (decision.action === 'fallback') {
          return this.callbacks.fallback(decision.to, decision.reason);
        }
      }
    }

    // 5. 达到最大轮次仍未通过 → 暂停等人工
    history.finalVerdict = 'max_rounds_reached';
    history.suspendReason = `已达到最大代码 CR 轮次（${this.deps.maxReviewRounds}）仍存在 blocking 问题，需要人工决策`;
    history.totalDurationMs = Date.now() - dialogStart;
    artifactStore.save('code-review-history', instanceId, history);
    return this.suspendCodeReviewForHuman(history.suspendReason);
  }

  /** CR 通过后推进到 DELIVERING；交付阶段（PR）未实现，停在阶段边界等人工 */
  private async advanceAfterCodeReview(): Promise<HarnessExecutionResult> {
    const nextState = getNextState('CODE_REVIEWING');
    if (!nextState) return this.callbacks.failExecution('无法确定 CODE_REVIEWING 的下一状态');
    const advance = this.deps.stateMachine.transition({ type: 'ADVANCE', to: nextState });
    if (!advance.success) return this.callbacks.failExecution(`状态推进失败: ${advance.message}`);

    this.deps.logger?.info('[Harness] 代码 CR 通过，进入交付阶段（DELIVERING）');
    // 继续执行主循环：DeliveryAgent 执行 → 保存 delivery 产物 → 推进到 DELIVERY_CONFIRMATION 硬卡点
    return this.callbacks.runExecutionLoop();
  }

  /** 代码 CR 对话中途暂停：currentState 不变，仅置 waiting_human */
  private suspendCodeReviewForHuman(reason: string): HarnessExecutionResult {
    this.deps.stateMachine.pauseForHuman(reason);
    this.deps.logger?.warn(`[Harness] 代码 CR 暂停等待人工: ${reason}`);
    return {
      success: true,
      finalState: 'CODE_REVIEWING',
      message: reason,
      waitingForHuman: true,
      waitingQuestion: reason,
    };
  }

  /**
   * 代码 CR 对话暂停后的恢复：
   * - max_rounds_reached：人工 resume 视为接受当前版本，推进到 DELIVERING
   * - needs_human（request_human，轮次未用完）：从 history 续跑下一轮 CR
   */
  async resumeCodeReviewDialog(): Promise<HarnessExecutionResult> {
    const history = this.deps.artifactStore.get<ReviewDialogHistory>(
      'code-review-history',
      this.deps.instanceId,
    );
    if (!history) {
      return this.callbacks.failExecution('恢复代码 CR 对话失败：缺少 code-review-history 产物');
    }
    this.deps.stateMachine.markRunning();
    if (history.finalVerdict === 'max_rounds_reached') {
      this.deps.logger?.info('[Harness] 代码 CR 达最大轮次，人工确认接受当前版本，推进到交付');
      return this.advanceAfterCodeReview();
    }
    this.deps.logger?.info(`[Harness] 代码 CR 从第 ${history.rounds.length + 1} 轮续跑`);
    return this.runCodeReviewDialog();
  }

  /**
   * 构建 CR 修订用的逐故事编码任务（依赖注入 CodingAgent 构建逻辑的上下文：
   * projectContext/testRequirements 由 Harness 通过 deps 之外的专用回调提供）。
   * 说明：此处通过 this.buildCodingTaskForStory 委托给注入的函数（见 callbacks 扩展），
   * 为避免拆分类承担 ContextManager 职责，实际构建由 Harness 注入。
   */
  private buildCodingTaskForStory(
    story: UserStorySet['stories'][number],
    index: number,
    total: number,
  ): CodingTask | undefined {
    return this.callbacks.buildCodingTaskForStory(story, index, total);
  }
}
