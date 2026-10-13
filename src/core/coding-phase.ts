/**
 * 编码阶段 Runner（issue #47 Harness 拆分）
 *
 * 从 Harness 拆出的逐故事 TDD 编排：
 * - runCodingPhase：按依赖拓扑逐故事调 CodingAgent.generateCode，单故事失败隔离，
 *   聚合 CodingPhaseResult 并按 all-success / partial / all-failed 三分支出口（#40）；
 * - 部分成功时进入弱介入窗口，人工决定带失败继续或回退；
 * - 行为与原 Harness 内实现完全一致（#47 纯拆分，不改语义）。
 */

import { getNextState } from './state-transitions';
import type { StateMachine } from './state-machine';
import type { ArtifactStore } from './artifact-store';
import type { ContextManager } from './context-manager';
import type { TokenBudgetTracker } from './token-budget';
import type { MetricsCollector } from '../observability/metrics';
import type { Logger } from '../observability/logger';
import type { AgentContext } from '../agents/types';
import type { PipelineStateName } from '../types/state';
import type { UserStorySet } from '../types/user-story';
import type { FrontendDesignDoc } from '../types/frontend-design';
import type {
  CodingPhaseResult,
  CodingResult,
  CodingTask,
  ProjectContext,
  TestRequirements,
} from '../types/coding-task';
import { topoSortStories, aggregateCodingResults, hasAnySuccessStory } from './coding-aggregator';
import type { KnowledgeService } from '../services/knowledge-service';
import type {
  AgentRegistry,
  HarnessExecutionResult,
  WeakInterventionDecision,
} from './harness';

/** 共享依赖（由 Harness 门面构建并注入） */
export interface CodingPhaseDeps {
  agents: AgentRegistry;
  artifactStore: ArtifactStore;
  stateMachine: StateMachine;
  contextManager: ContextManager;
  instanceId: string;
  logger?: Logger;
  knowledgeService?: KnowledgeService;
  projectId?: string;
  tokenBudget: TokenBudgetTracker;
  projectContext: ProjectContext;
  testRequirements?: TestRequirements;
  /** 链路追踪根 ID（Harness 生成，注入全部 AgentContext） */
  traceId: string;
  /** Metrics 指标聚合器（Harness 单例，注入全部 AgentContext） */
  metrics: MetricsCollector;
}

/** 跨类回调（指向 Harness 门面，避免循环依赖） */
export interface CodingPhaseCallbacks {
  failExecution(message: string): HarnessExecutionResult;
  attachInstanceId(data: unknown): void;
  runExecutionLoop(): Promise<HarnessExecutionResult>;
  fallback(to: PipelineStateName, reason: string): Promise<HarnessExecutionResult>;
  invokeWeakIntervention(
    state: PipelineStateName,
    artifact: unknown,
  ): Promise<WeakInterventionDecision>;
}

export class CodingPhaseRunner {
  constructor(
    private readonly deps: CodingPhaseDeps,
    private readonly callbacks: CodingPhaseCallbacks,
  ) {}

  /**
   * 逐故事编码：按依赖拓扑排序，对每个故事构建 CodingTask 并调 CodingAgent.generateCode；
   * 单故事失败不阻塞整体，最后聚合并按 all-success / partial / all-failed 分流。
   */
  async runCodingPhase(): Promise<HarnessExecutionResult> {
    const { agents, artifactStore, stateMachine, contextManager, instanceId, logger } = this.deps;
    const codingAgent = agents.coding;
    if (!codingAgent) return this.callbacks.failExecution('状态 CODING 缺少 CodingAgent');

    const stories = artifactStore.get<UserStorySet>('stories', instanceId);
    const design = artifactStore.get<FrontendDesignDoc>('design', instanceId);
    if (!stories || !design) return this.callbacks.failExecution('编码缺少上游产物（stories/design）');

    const { sorted: ordered, cyclicStoryIds } = topoSortStories(stories.stories);
    const total = ordered.length;
    if (total === 0) return this.callbacks.failExecution('用户故事为空，无法编码');
    if (cyclicStoryIds.length > 0) {
      logger?.warn(
        `[Harness] 故事依赖存在循环，涉及 ${cyclicStoryIds.length} 个故事（${cyclicStoryIds.join(', ')}），按输入顺序保底追加，可能导致编码时引用未生成组件`,
      );
    }

    const results: CodingResult[] = [];
    for (let i = 0; i < total; i++) {
      const story = ordered[i];
      const task = contextManager.buildCodingTaskForStory(instanceId, story, i, total, {
        projectContext: this.deps.projectContext,
        testRequirements: this.deps.testRequirements,
      });
      if (!task) {
        return this.callbacks.failExecution(`无法为故事 ${story.id} 构建编码任务（缺少技术方案）`);
      }

      const ctx: AgentContext = {
        instanceId,
        traceId: this.deps.traceId,
        stage: 'coding',
        input: task,
        globalContext: contextManager.getGlobalContext(),
        knowledgeService: this.deps.knowledgeService,
        projectId: this.deps.projectId,
        tokenBudget: this.deps.tokenBudget,
        metrics: this.deps.metrics,
      };

      try {
        const r = await codingAgent.generateCode(ctx);
        if (r.data) {
          results.push(r.data);
        } else {
          results.push(
            this.failedStoryResult(task, r.errors.map((e) => e.message).join('; ') || '编码失败'),
          );
        }
      } catch (err) {
        // 单故事异常隔离：记录失败后继续后续故事（#40 不阻塞整体）
        const reason = err instanceof Error ? err.message : String(err);
        logger?.error(`[Harness] 故事 ${story.id} 编码异常，跳过: ${reason}`);
        results.push(this.failedStoryResult(task, reason));
      }
    }

    const phase = aggregateCodingResults(results, {
      id: `coding-phase-${instanceId}`,
      instanceId,
      designDocId: design.id,
    });
    this.callbacks.attachInstanceId(phase);
    artifactStore.save('coding', instanceId, phase);
    logger?.info(
      `[Harness] 编码阶段完成: ${phase.overallStatus}，成功 ${phase.successStoryIds.length}/部分 ${phase.partialStoryIds.length}/失败 ${phase.failedStories.length}`,
    );

    // 全部失败（无任何成功/部分）→ FAILED，不进入 CR
    if (!hasAnySuccessStory(phase)) {
      return this.callbacks.failExecution(
        `编码全部故事失败: ${phase.failedStories.map((f) => `${f.storyId}(${f.reason})`).join('; ')}`,
      );
    }

    // 部分成功：弱介入窗口，人工决定带失败继续 / 回退（超时默认继续）
    if (phase.overallStatus === 'partial-success') {
      const decision = await this.callbacks.invokeWeakIntervention('CODING', phase);
      if (decision.action === 'fallback') {
        const fb = stateMachine.transition({
          type: 'FALLBACK',
          to: decision.to,
          reason: decision.reason,
        });
        if (!fb.success) return this.callbacks.failExecution(`编码部分成功回退失败: ${fb.message}`);
        logger?.warn(`[Harness] 编码部分成功，回退到 ${decision.to}`);
        return this.callbacks.runExecutionLoop();
      }
    }

    return this.advanceAfterCoding(phase);
  }

  /** 编码完成推进到 CODE_REVIEWING，进入代码 CR 多轮对话 */
  private async advanceAfterCoding(phase: CodingPhaseResult): Promise<HarnessExecutionResult> {
    const nextState = getNextState('CODING');
    if (!nextState) return this.callbacks.failExecution('无法确定 CODING 的下一状态');
    const advance = this.deps.stateMachine.transition({ type: 'ADVANCE', to: nextState });
    if (!advance.success) return this.callbacks.failExecution(`状态推进失败: ${advance.message}`);
    this.deps.logger?.info(
      `[Harness] 编码阶段完成（成功 ${phase.successStoryIds.length}、部分 ${phase.partialStoryIds.length}、失败 ${phase.failedStories.length}），进入代码 CR`,
    );
    return this.callbacks.runExecutionLoop();
  }

  /** 构造单故事失败结果（异常/Agent 失败时占位，保证聚合输入完整） */
  private failedStoryResult(task: CodingTask, reason: string): CodingResult {
    return {
      id: `coding-${task.storyId}`,
      instanceId: this.deps.instanceId,
      taskId: task.taskId,
      storyId: task.storyId,
      status: 'failed',
      files: [],
      testResult: {
        totalTests: 0,
        passedTests: 0,
        failedTests: 0,
        skippedTests: 0,
        environment: 'sandbox',
        outputSummary: reason,
        allPassed: false,
      },
      tddCycles: [],
      issues: [reason],
      completedAt: new Date().toISOString(),
    };
  }
}
