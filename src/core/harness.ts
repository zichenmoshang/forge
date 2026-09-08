/**
 * Harness 主类 - 状态机执行器与 Agent 调度器
 *
 * 职责：
 * - 维护全局状态机
 * - 根据当前状态调度对应 Agent
 * - 管理产物存储
 * - 处理硬卡点（人工介入等待）
 * - 异常处理与兜底
 */

import {
  StateMachine,
  createInitialState,
  isHardBlockingState,
  isTerminalState,
} from './state-machine';
import { InMemoryArtifactStore } from './artifact-store';
import type { ArtifactStore } from './artifact-store';
import { ContextManager } from './context-manager';
import type { BaseAgent } from '../agents/base';
import type { AgentContext, AgentResult, GlobalContext } from '../agents/types';
import type { RequirementAgent } from '../agents/requirement-agent';
import type { DesignAgent } from '../agents/design-agent';
import type { CodingAgent } from '../agents/coding-agent';
import type { PipelineState, PipelineStateName, ArtifactStage } from '../types/state';
import type { StructuredRequirement } from '../types/requirement';
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
import type { ReviewResult, ReviewIssue } from '../types/review-and-delivery';
import type {
  DesignRevision,
  ReviewDialogHistory,
  DialogMessage,
  IssueResponse,
} from '../types/review-dialog';
import type { CodeReviewInput } from '../agents/review-agent';
import { buildFreezeChecklist } from './freeze-checklist';
import type { Logger } from '../observability/logger';
import { Logger as LoggerImpl } from '../observability/logger';
import type { ObservabilityConfig } from '../config';
import type { KnowledgeService } from '../services/knowledge-service';

/** 人工介入回调：返回人工回答的内容 */
export type HumanInterventionCallback = (
  state: PipelineStateName,
  question: string,
  context: { instanceId: string; artifact?: unknown },
) => Promise<string>;

/** 弱介入决策：继续执行或回退到指定状态 */
export type WeakInterventionDecision =
  { action: 'continue' } | { action: 'fallback'; to: PipelineStateName; reason: string };

/** 弱介入回调：在弱介入窗口内人工可决定继续或回退 */
export type WeakInterventionCallback = (
  state: PipelineStateName,
  context: { instanceId: string; artifact?: unknown },
) => Promise<WeakInterventionDecision>;

/**
 * 需要弱介入窗口的状态（Agent 执行完成后、推进前）。
 * 注：DESIGN_REVIEWING 的弱介入已内聚到 runDesignReviewDialog 多轮对话循环
 *（interruptAfterEachRound + 终止条件暂停），不再走主循环的通用弱介入。
 */
// 主循环通用弱介入仅覆盖 STORIES_GENERATING；
// DESIGN_REVIEWING / CODE_REVIEWING 的弱介入在各自多轮对话循环内通过 interruptAfterEachRound 实现，
// 不走主循环的通用弱介入路径（这两个状态在主循环顶部即被拦截）。
const WEAK_INTERVENTION_STATES: PipelineStateName[] = ['STORIES_GENERATING'];

/** Agent 注册表 */
export interface AgentRegistry {
  requirement?: RequirementAgent;
  /** DesignAgent 同时承担方案生成（execute）与评审对话内修订（revise） */
  design?: DesignAgent;
  /** CodingAgent 承担单故事 TDD 生成（generateCode），逐故事循环由 Harness 编排 */
  coding?: CodingAgent;
  review?: BaseAgent;
  delivery?: BaseAgent;
}

/** Harness 配置 */
export interface HarnessConfig {
  agents: AgentRegistry;
  artifactStore?: ArtifactStore;
  /** 全局上下文（技术栈、规范等约束） */
  globalContext?: GlobalContext;
  /** 当前项目 ID，用于知识库检索时按项目范围隔离（注入 AgentContext） */
  projectId?: string;
  /** 知识库服务（可选，注入 AgentContext，由 Agent 内部按需检索，Harness/ContextManager 不做检索） */
  knowledgeService?: KnowledgeService;
  /** 硬卡点人工介入回调 */
  onHumanIntervention?: HumanInterventionCallback;
  /** 弱介入窗口回调（故事拆解/方案评审/代码CR后触发） */
  onWeakIntervention?: WeakInterventionCallback;
  logger?: Logger;
  /** 实例 ID，不填则自动生成 */
  instanceId?: string;
  /** Agent 执行异常时的最大重试次数（默认 2，不含首次执行）。注意：BaseAgent 内部的输出解析失败重试不计入此层 */
  maxRetries?: number;
  /** 评审阶段最大对话轮次（默认 3，详见 docs/08-review-dialog.md）。应用层应从 config.coding.maxDesignReviewRounds/maxCodeReviewRounds 映射传入 */
  maxReviewRounds?: number;
  /** 每轮评审后是否暂停等人工（默认 false，只在终止条件触发时暂停） */
  interruptAfterEachRound?: boolean;
  /** 编码阶段目标项目上下文（CODING 逐故事构建 CodingTask 用；缺省用进程目录并告警） */
  projectContext?: ProjectContext;
  /** 编码阶段测试要求（缺省：vitest + 每 AC 一测 + unit/integration-mock + msw） */
  testRequirements?: TestRequirements;
  /** 单故事 green 最大修复尝试次数（默认 5） */
  maxGreenAttempts?: number;
  /** 单流程 token 预算上限（0 表示不限制，超限暂停等人工；ADR-014，落地见 issue #39） */
  maxTokensPerRun?: number;
  /**
   * 弱介入窗口等待人工决策的超时（毫秒，默认 30000）。
   * 超时未决策则自动 continue；设为 0 表示不超时、一直等待回调。
   * 对应 config.humanInteraction.weakConfirmationTimeoutMs。
   */
  weakConfirmationTimeoutMs?: number;
}

/** 执行结果 */
export interface HarnessExecutionResult {
  success: boolean;
  finalState: PipelineStateName;
  message?: string;
  /** 是否在等待人工介入 */
  waitingForHuman: boolean;
  /** 等待的问题 */
  waitingQuestion?: string;
}

export class Harness {
  private stateMachine: StateMachine;
  private agents: AgentRegistry;
  private artifactStore: ArtifactStore;
  private contextManager: ContextManager;
  private onHumanIntervention?: HumanInterventionCallback;
  private onWeakIntervention?: WeakInterventionCallback;
  private logger?: Logger;
  private maxRetries: number;
  /** 评审最大轮次（issue #42 评审对话循环实现时消费） */
  private readonly maxReviewRounds: number;
  /** 每轮评审后是否中断等人工（issue #42 消费） */
  private readonly interruptAfterEachRound: boolean;
  private readonly projectContext: ProjectContext;
  private readonly testRequirements?: TestRequirements;
  private readonly maxGreenAttempts: number;
  /** 单流程 token 预算（issue #39 落地时消费） */
  private readonly maxTokensPerRun: number;
  /** 弱介入窗口超时（毫秒，0 表示不超时） */
  private readonly weakConfirmationTimeoutMs: number;
  private knowledgeService?: KnowledgeService;
  private projectId?: string;
  private readonly globalContext: GlobalContext;
  readonly instanceId: string;

  constructor(config: HarnessConfig) {
    this.instanceId = config.instanceId ?? `forge-${Date.now()}`;
    this.agents = config.agents;
    this.artifactStore = config.artifactStore ?? new InMemoryArtifactStore();
    this.maxRetries = config.maxRetries ?? 2;
    this.maxReviewRounds = config.maxReviewRounds ?? 3;
    this.interruptAfterEachRound = config.interruptAfterEachRound ?? false;
    this.maxGreenAttempts = config.maxGreenAttempts ?? 5;
    this.testRequirements = config.testRequirements;
    this.projectContext = config.projectContext ?? {
      projectRoot: process.cwd(),
      srcDir: 'src',
      projectType: 'new',
    };
    if (!config.projectContext) {
      // 不阻断流程，但明确告知使用了默认项目上下文
      config.logger?.warn?.(
        '[Harness] 未配置 projectContext，编码阶段使用默认值（进程目录/src/new）',
      );
    }
    this.maxTokensPerRun = config.maxTokensPerRun ?? 0;
    this.weakConfirmationTimeoutMs = config.weakConfirmationTimeoutMs ?? 30000;
    this.knowledgeService = config.knowledgeService;
    this.projectId = config.projectId;
    this.globalContext = config.globalContext ?? {};
    // ADR-014：ContextManager 只做产物装配，不再承担知识库检索（检索由 Agent 内部控制）
    this.contextManager = new ContextManager({
      artifactStore: this.artifactStore,
      globalContext: this.globalContext,
    });
    this.onHumanIntervention = config.onHumanIntervention;
    this.onWeakIntervention = config.onWeakIntervention;

    // 如果没有传入 Logger，自动创建按实例分目录的 Logger
    if (config.logger) {
      this.logger = config.logger;
    } else {
      const obsConfig: ObservabilityConfig = {
        logLevel: 'info',
        logDir: `./data/instances/${this.instanceId}/logs`,
        logLLMRequests: true,
      };
      this.logger = new LoggerImpl(obsConfig);
    }

    const initialState = createInitialState(this.instanceId);
    this.stateMachine = new StateMachine(initialState);

    this.logger?.info(`[Harness] 实例创建: ${this.instanceId}`);
  }

  /** 获取当前状态（深拷贝） */
  getState(): PipelineState {
    return this.stateMachine.getState();
  }

  /** 获取产物 */
  getArtifact<T>(stage: ArtifactStage): T | undefined {
    return this.artifactStore.get<T>(stage, this.instanceId);
  }

  /** 获取所有产物 */
  listArtifacts() {
    return this.artifactStore.list(this.instanceId);
  }

  /**
   * 开始执行流程
   * @param prdText PRD 文本内容
   * @param source PRD 来源（文件名/链接）
   */
  async start(prdText: string, source?: string): Promise<HarnessExecutionResult> {
    this.logger?.info(`[Harness] 开始执行，PRD 来源: ${source ?? '未知'}`);

    // INIT → REQUIREMENT_PARSING
    const advanceResult = this.stateMachine.transition({
      type: 'ADVANCE',
      to: 'REQUIREMENT_PARSING',
    });

    if (!advanceResult.success) {
      return this.failExecution(`初始化失败: ${advanceResult.message}`);
    }

    return this.runExecutionLoop({ prdText, prdSource: source ?? '未知' });
  }

  /**
   * 人工确认后继续执行
   * @param humanAnswer 人工回答的内容（可选）
   */
  async resume(humanAnswer?: string): Promise<HarnessExecutionResult> {
    const state = this.stateMachine.getState();

    if (state.status !== 'waiting_human') {
      return {
        success: false,
        finalState: state.currentState,
        message: `当前状态不是等待人工介入（status: ${state.status}）`,
        waitingForHuman: false,
      };
    }

    this.logger?.info(`[Harness] 人工确认，继续执行，当前状态: ${state.currentState}`);

    // 需求澄清：多轮问答，人工回答后调用 followup 判断是否还有未澄清问题
    if (state.currentState === 'REQUIREMENT_CLARIFICATION') {
      const followupResult = await this.handleClarificationFollowup(humanAnswer);
      if (followupResult) return followupResult;
    } else if (state.currentState === 'DESIGN_REVIEWING') {
      // 方案评审多轮对话中途暂停（request_human / max_rounds）后的恢复
      return this.resumeDesignReviewDialog();
    } else if (state.currentState === 'CODE_REVIEWING') {
      // 代码 CR 多轮对话中途暂停（request_human / max_rounds）后的恢复
      return this.resumeCodeReviewDialog();
    } else {
      // 其他硬卡点：直接处理人工回答
      await this.handleHumanAnswer(state.currentState, humanAnswer);
    }

    // 从硬卡点状态前进
    const nextState = this.getNextStateAfterBlocking(state.currentState);
    if (!nextState) {
      return this.failExecution(`无法确定 ${state.currentState} 的下一个状态`);
    }

    const advanceResult = this.stateMachine.transition({
      type: 'ADVANCE',
      to: nextState,
    });

    if (!advanceResult.success) {
      return this.failExecution(`状态推进失败: ${advanceResult.message}`);
    }

    return this.runExecutionLoop();
  }

  /**
   * 处理需求澄清的多轮问答
   * @returns 如果还有未澄清问题，返回等待状态；否则返回 null 继续推进
   */
  private async handleClarificationFollowup(
    humanAnswer?: string,
  ): Promise<HarnessExecutionResult | null> {
    if (!humanAnswer) return null;

    const requirement = this.artifactStore.get<StructuredRequirement>(
      'requirement',
      this.instanceId,
    );
    if (!requirement || !this.agents.requirement) {
      return null; // 没有需求或 Agent，直接推进
    }

    // 把人工回答记录为统一回答（多问题澄清时不逐个匹配）
    const now = new Date().toISOString();
    const updatedRequirement: StructuredRequirement = {
      ...requirement,
      humanAnswers: [...(requirement.humanAnswers ?? []), { answer: humanAnswer, answeredAt: now }],
      clarificationLog: requirement.clarificationLog.map((q) =>
        q.status === 'pending' ? { ...q, status: 'resolved' as const, answeredAt: now } : q,
      ),
      updatedAt: now,
    };

    // 调用 RequirementAgent 的 followup 模式
    const context: AgentContext = {
      instanceId: this.instanceId,
      stage: 'requirement-clarification',
      input: {
        type: 'clarify-followup',
        previousRequirement: updatedRequirement,
        // v1 用统一回答（humanAnswers），answers 字段 v2 按问题匹配时使用
      },
      globalContext: this.contextManager.getGlobalContext(),
      knowledgeService: this.knowledgeService,
      projectId: this.projectId,
    };

    try {
      const result = await this.agents.requirement.execute(context);
      if (!result.success || !result.data) {
        this.logger?.warn(
          `[Harness] 澄清 followup 失败，直接推进: ${result.errors.map((e) => e.message).join('; ')}`,
        );
        return null;
      }

      const newRequirement: StructuredRequirement = {
        ...(result.data as StructuredRequirement),
        // 保留人工回答历史（Agent 返回结果中不包含此字段）
        humanAnswers: updatedRequirement.humanAnswers,
      };
      this.attachInstanceId(newRequirement);
      this.artifactStore.save('requirement', this.instanceId, newRequirement);

      // 检查是否还有 pending 的澄清问题
      const pendingQuestions = newRequirement.clarificationLog.filter(
        (q) => q.status === 'pending',
      );

      if (pendingQuestions.length > 0) {
        // 还有未澄清问题，停留在澄清状态，继续等待人工
        this.logger?.info(`[Harness] 还有 ${pendingQuestions.length} 个澄清问题待回答，继续等待`);
        return {
          success: true,
          finalState: 'REQUIREMENT_CLARIFICATION',
          message:
            `还有 ${pendingQuestions.length} 个澄清问题待回答:\n` +
            pendingQuestions.map((q, i) => `${i + 1}. [${q.priority}] ${q.question}`).join('\n'),
          waitingForHuman: true,
          waitingQuestion: pendingQuestions.map((q) => q.question).join('\n'),
        };
      }

      // 没有 pending 问题了，标记冻结，继续推进
      this.logger?.info('[Harness] 所有澄清问题已回答，标记需求冻结');
      const frozenRequirement: StructuredRequirement = {
        ...newRequirement,
        frozen: {
          frozen: true,
          frozenAt: now,
          checklist: buildFreezeChecklist(newRequirement),
        },
        updatedAt: now,
      };
      this.attachInstanceId(frozenRequirement);
      this.artifactStore.save('requirement', this.instanceId, frozenRequirement);
      return null; // 继续推进
    } catch (err) {
      this.logger?.error(
        `[Harness] 澄清 followup 异常: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null; // 异常时直接推进
    }
  }

  /**
   * 回退到指定状态并继续执行
   *
   * 用于人工介入时要求回退（如需求澄清时发现需求不足，回退到需求解析）。
   * 回退后版本号 +1，目标状态之后的所有确认和评审必须重新执行。
   *
   * @param to 回退目标状态
   * @param reason 回退原因
   */
  async fallback(to: PipelineStateName, reason: string): Promise<HarnessExecutionResult> {
    const state = this.stateMachine.getState();

    if (isTerminalState(state.currentState)) {
      return {
        success: false,
        finalState: state.currentState,
        message: `终态 ${state.currentState} 不允许回退`,
        waitingForHuman: false,
      };
    }

    this.logger?.warn(`[Harness] 人工回退: ${state.currentState} -> ${to}, 原因: ${reason}`);

    const fallbackResult = this.stateMachine.transition({
      type: 'FALLBACK',
      to,
      reason,
    });

    if (!fallbackResult.success) {
      return {
        success: false,
        finalState: state.currentState,
        message: `回退失败: ${fallbackResult.message}`,
        waitingForHuman: false,
      };
    }

    // 回退后从目标状态重新执行
    return this.runExecutionLoop();
  }

  /**
   * 取消流程（人工主动终止）
   *
   * 进入 CANCELLED 终态，不可恢复。产物保留用于审计，但不再继续执行。
   * 终态（COMPLETED/FAILED/CANCELLED）下调用返回失败。
   *
   * @param reason 取消原因
   */
  cancel(reason: string): HarnessExecutionResult {
    const state = this.stateMachine.getState();

    if (isTerminalState(state.currentState)) {
      return {
        success: false,
        finalState: state.currentState,
        message: `终态 ${state.currentState} 不允许取消`,
        waitingForHuman: false,
      };
    }

    this.logger?.warn(`[Harness] 流程取消: ${reason}`);
    const result = this.stateMachine.transition({ type: 'CANCEL', reason });
    return {
      success: result.success,
      finalState: 'CANCELLED',
      message: reason,
      waitingForHuman: false,
    };
  }

  // ============================================================
  // 核心执行循环
  // ============================================================

  private async runExecutionLoop(extra?: Record<string, unknown>): Promise<HarnessExecutionResult> {
    let state = this.stateMachine.getState();

    while (!isTerminalState(state.currentState) && state.status === 'running') {
      this.logger?.info(`[Harness] 执行状态: ${state.currentState}`);

      // 方案评审走多轮对话循环（Reviewer ↔ Designer，#42），不走通用单次执行路径
      if (state.currentState === 'DESIGN_REVIEWING') {
        return this.runDesignReviewDialog();
      }

      // 编码为逐故事 TDD 循环 + 部分成功出口（#40），不走通用单次执行路径
      if (state.currentState === 'CODING') {
        return this.runCodingPhase();
      }

      // 代码 CR 走多轮对话循环（Reviewer ↔ Coder，复用 #42 模式），不走通用单次执行路径
      if (state.currentState === 'CODE_REVIEWING') {
        return this.runCodeReviewDialog();
      }

      // 检查是否有对应 Agent
      const agent = this.getAgentForState(state.currentState);
      if (!agent) {
        // ADR-014：Agent 未实现属于开发期错误，直接 FAILED；
        // SUSPENDED 只保留给运行时原因（外部依赖不可用、评审达最大轮次等人工决策场景）
        return this.failExecution(`状态 ${state.currentState} 对应的 Agent 尚未实现`);
      }

      // 构建 Agent 输入（ContextManager 只做产物装配，知识库检索由 Agent 内部完成）
      const agentInput = this.contextManager.buildAgentInput(
        state.currentState,
        this.instanceId,
        extra,
      );
      if (!agentInput) {
        return this.failExecution(`无法构建 ${state.currentState} 的 Agent 输入（缺少上游产物）`);
      }

      // 调用 Agent
      const context: AgentContext = {
        instanceId: this.instanceId,
        stage: this.stateToStage(state.currentState),
        input: agentInput,
        globalContext: this.contextManager.getGlobalContext(),
        // ADR-014：知识库检索职责收归 Agent，服务通过上下文注入，由 Agent 内部按需检索
        knowledgeService: this.knowledgeService,
        projectId: this.projectId,
      };

      let result: AgentResult;
      try {
        result = await agent.execute(context);
      } catch (err) {
        // Agent 执行异常（网络错误、未捕获异常）→ Harness 层重试
        const retryCount = this.stateMachine.incrementRetry();
        if (retryCount < this.maxRetries) {
          this.logger?.warn(
            `[Harness] Agent 执行异常，第 ${retryCount} 次重试: ${err instanceof Error ? err.message : String(err)}`,
          );
          state = this.stateMachine.getState();
          continue;
        }
        return this.failExecution(
          `Agent 执行异常（重试 ${retryCount} 次）: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (!result.success) {
        // 业务失败（BaseAgent 内部输出解析/校验重试已耗尽）→ 不再重试，直接失败
        return this.failExecution(
          `Agent 执行失败: ${result.errors.map((e) => e.message).join('; ')}`,
        );
      }

      // 保存产物（回填 instanceId，保证产物对象自描述、持久化后可判断归属）
      const artifactStage = this.getArtifactStage(state.currentState);
      if (artifactStage && result.data) {
        this.attachInstanceId(result.data);
        const artifactId = this.artifactStore.save(artifactStage, this.instanceId, result.data);
        this.logger?.info(`[Harness] 产物已保存: ${artifactStage} -> ${artifactId}`);

        // 方案（重新）生成后，其下游评审产物与对话历史一律失效，避免回退重生成后沿用旧评审
        if (artifactStage === 'design') {
          this.artifactStore.remove('design-review', this.instanceId);
          this.artifactStore.remove('design-review-history', this.instanceId);
        }
      }

      // 弱介入窗口：特定状态完成后，人工可介入决定继续或回退（超时自动继续）
      if (WEAK_INTERVENTION_STATES.includes(state.currentState) && this.onWeakIntervention) {
        this.logger?.info(`[Harness] 进入弱介入窗口: ${state.currentState}`);
        const decision = await this.invokeWeakIntervention(state.currentState, result.data);

        if (decision.action === 'fallback') {
          this.logger?.warn(
            `[Harness] 弱介入回退: ${state.currentState} -> ${decision.to}, 原因: ${decision.reason}`,
          );
          const fallbackResult = this.stateMachine.transition({
            type: 'FALLBACK',
            to: decision.to,
            reason: decision.reason,
          });
          if (fallbackResult.success) {
            state = this.stateMachine.getState();
            continue; // 回退后重新执行目标状态
          }
          return this.failExecution(`弱介入回退失败: ${fallbackResult.message}`);
        }
        // continue: 继续推进
      }

      // 推进到下一个状态
      const nextState = this.getNextState(state.currentState);
      if (!nextState) {
        return this.failExecution(`无法确定 ${state.currentState} 的下一个状态`);
      }

      const advanceResult = this.stateMachine.transition({
        type: 'ADVANCE',
        to: nextState,
      });

      if (!advanceResult.success) {
        return this.failExecution(`状态推进失败: ${advanceResult.message}`);
      }

      state = this.stateMachine.getState();

      // 检查是否进入硬卡点
      if (isHardBlockingState(state.currentState)) {
        const question = this.buildBlockingQuestion(state.currentState);
        this.logger?.info(`[Harness] 进入硬卡点: ${state.currentState}，等待人工介入`);

        // 如果有回调，自动调用；否则返回等待状态
        if (this.onHumanIntervention) {
          const answer = await this.onHumanIntervention(state.currentState, question, {
            instanceId: this.instanceId,
          });
          return this.resume(answer);
        }

        return {
          success: true,
          finalState: state.currentState,
          message: question,
          waitingForHuman: true,
          waitingQuestion: question,
        };
      }
    }

    // 终态
    return {
      success: state.currentState === 'COMPLETED',
      finalState: state.currentState,
      waitingForHuman: false,
    };
  }

  // ============================================================
  // 方案评审多轮对话循环（#42，详见 docs/08-review-dialog.md）
  // ============================================================

  /**
   * 方案评审对话循环：Reviewer 评审 →（approve 退出 / request_human 暂停 /
   * request_changes 由 Designer.revise 修改）→ 下一轮，直到通过、升级人工或达到最大轮次。
   *
   * - 程序化判定：是否通过只看 ReviewResult.resolvedAction（review-policy 已按 blocking issue 仲裁）
   * - 每轮落盘 design（版本递增）、design-review（最新一轮）、design-review-history（只增）
   * - 中途暂停 currentState 停在 DESIGN_REVIEWING、status=waiting_human，resume 从 history 续跑
   */
  private async runDesignReviewDialog(): Promise<HarnessExecutionResult> {
    const reviewAgent = this.agents.review;
    const designAgent = this.agents.design;
    if (!reviewAgent) {
      return this.failExecution('状态 DESIGN_REVIEWING 缺少 ReviewAgent');
    }

    const currentDesign0 = this.artifactStore.get<FrontendDesignDoc>('design', this.instanceId);
    const stories = this.artifactStore.get<UserStorySet>('stories', this.instanceId);
    if (!currentDesign0 || !stories) {
      return this.failExecution('方案评审缺少上游产物（design/stories）');
    }

    const dialogStart = Date.now();
    let currentDesign = currentDesign0;
    let previousIssues: ReviewIssue[] = [];
    let issueResponses = [] as DesignRevision['issueResponses'];
    const dialogMessages: DialogMessage[] = [];

    // 恢复未结束的对话历史（resume 续跑场景），否则新建
    let history =
      this.artifactStore.get<ReviewDialogHistory>('design-review-history', this.instanceId) ??
      undefined;
    if (!history || history.finalVerdict === 'approved') {
      history = {
        reviewType: 'design-review',
        maxRounds: this.maxReviewRounds,
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

    for (let round = startRound; round <= this.maxReviewRounds; round++) {
      // 1. Reviewer 评审
      const reviewCtx: AgentContext = {
        instanceId: this.instanceId,
        stage: 'design-reviewing',
        input: {
          type: 'review-design',
          design: currentDesign,
          round,
          previousIssues,
          issueResponses,
        },
        globalContext: this.contextManager.getGlobalContext(),
        knowledgeService: this.knowledgeService,
        projectId: this.projectId,
      };

      const reviewResult = await reviewAgent.execute(reviewCtx);
      if (!reviewResult.success || !reviewResult.data) {
        return this.failExecution(
          `第 ${round} 轮方案评审失败: ${reviewResult.errors.map((e) => e.message).join('; ')}`,
        );
      }
      const review = reviewResult.data as ReviewResult;
      this.attachInstanceId(review);
      this.artifactStore.save('design-review', this.instanceId, review);
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
        this.artifactStore.save('design-review-history', this.instanceId, history);
        this.logger?.info(`[Harness] 方案评审第 ${round} 轮通过，进入 API 契约确认`);
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
        this.artifactStore.save('design-review-history', this.instanceId, history);
        return this.suspendReviewForHuman(history.suspendReason);
      }

      // 3. request_changes：需要 Designer 修订
      if (!designAgent) {
        history.finalVerdict = 'needs_human';
        history.suspendReason = '评审要求修改但未注册 DesignAgent，无法自动修订';
        this.artifactStore.save('design-review-history', this.instanceId, history);
        return this.suspendReviewForHuman(history.suspendReason);
      }

      const openIssues = review.issues.filter((i) => i.status === 'open');
      const reviseCtx: AgentContext = {
        instanceId: this.instanceId,
        stage: 'design-reviewing',
        input: {
          type: 'revise-design',
          previousDesign: currentDesign,
          previousIssues: openIssues,
          round,
          stories,
        },
        globalContext: this.contextManager.getGlobalContext(),
        knowledgeService: this.knowledgeService,
        projectId: this.projectId,
      };
      const reviseResult = await designAgent.revise(reviseCtx);
      if (!reviseResult.success || !reviseResult.data) {
        return this.failExecution(
          `第 ${round} 轮方案修订失败: ${reviseResult.errors.map((e) => e.message).join('; ')}`,
        );
      }
      const revision = reviseResult.data as DesignRevision;
      currentDesign = revision.updatedDesign;
      this.attachInstanceId(currentDesign);
      this.artifactStore.save('design', this.instanceId, currentDesign);
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
      this.artifactStore.save('design-review-history', this.instanceId, history);

      // 4. 每轮后可选弱介入（默认关闭）
      if (this.interruptAfterEachRound && this.onWeakIntervention) {
        const decision = await this.invokeWeakIntervention('DESIGN_REVIEWING', history);
        if (decision.action === 'fallback') {
          return this.fallback(decision.to, decision.reason);
        }
      }
    }

    // 5. 达到最大轮次仍未通过 → 暂停等人工
    history.finalVerdict = 'max_rounds_reached';
    history.suspendReason = `已达到最大评审轮次（${this.maxReviewRounds}）仍存在 blocking 问题，需要人工决策`;
    history.totalDurationMs = Date.now() - dialogStart;
    this.artifactStore.save('design-review-history', this.instanceId, history);
    return this.suspendReviewForHuman(history.suspendReason);
  }

  /** 评审通过后推进到 API_CONFIRMATION 硬卡点并处理等待/回调 */
  private async advanceAfterReview(): Promise<HarnessExecutionResult> {
    const nextState = this.getNextState('DESIGN_REVIEWING');
    if (!nextState) return this.failExecution('无法确定 DESIGN_REVIEWING 的下一状态');
    const advance = this.stateMachine.transition({ type: 'ADVANCE', to: nextState });
    if (!advance.success) return this.failExecution(`状态推进失败: ${advance.message}`);

    if (isHardBlockingState(nextState)) {
      const question = this.buildBlockingQuestion(nextState);
      this.logger?.info(`[Harness] 进入硬卡点: ${nextState}，等待人工介入`);
      if (this.onHumanIntervention) {
        const answer = await this.onHumanIntervention(nextState, question, {
          instanceId: this.instanceId,
        });
        return this.resume(answer);
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
    return this.runExecutionLoop();
  }

  /** 评审对话中途暂停：currentState 不变，仅置 waiting_human */
  private suspendReviewForHuman(reason: string): HarnessExecutionResult {
    this.stateMachine.pauseForHuman(reason);
    this.logger?.warn(`[Harness] 方案评审暂停等待人工: ${reason}`);
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
  private async resumeDesignReviewDialog(): Promise<HarnessExecutionResult> {
    const history = this.artifactStore.get<ReviewDialogHistory>(
      'design-review-history',
      this.instanceId,
    );
    this.stateMachine.markRunning();

    if (history?.finalVerdict === 'max_rounds_reached') {
      this.logger?.info('[Harness] 人工在最大轮次后放行方案评审，推进到 API 确认');
      return this.advanceAfterReview();
    }
    // 续跑对话循环（startRound 由已保存 rounds 数推导）
    return this.runExecutionLoop();
  }

  // ============================================================
  // 编码阶段：逐故事 TDD 循环 + 部分成功出口（#40）
  // ============================================================

  /**
   * 逐故事编码：按依赖拓扑排序，对每个故事构建 CodingTask 并调 CodingAgent.generateCode；
   * 单故事失败不阻塞整体，最后聚合并按 all-success / partial / all-failed 分流。
   */
  private async runCodingPhase(): Promise<HarnessExecutionResult> {
    const codingAgent = this.agents.coding;
    if (!codingAgent) return this.failExecution('状态 CODING 缺少 CodingAgent');

    const stories = this.artifactStore.get<UserStorySet>('stories', this.instanceId);
    const design = this.artifactStore.get<FrontendDesignDoc>('design', this.instanceId);
    if (!stories || !design) return this.failExecution('编码缺少上游产物（stories/design）');

    const { sorted: ordered, cyclicStoryIds } = topoSortStories(stories.stories);
    const total = ordered.length;
    if (total === 0) return this.failExecution('用户故事为空，无法编码');
    if (cyclicStoryIds.length > 0) {
      this.logger?.warn(
        `[Harness] 故事依赖存在循环，涉及 ${cyclicStoryIds.length} 个故事（${cyclicStoryIds.join(', ')}），按输入顺序保底追加，可能导致编码时引用未生成组件`,
      );
    }

    const results: CodingResult[] = [];
    for (let i = 0; i < total; i++) {
      const story = ordered[i];
      const task = this.contextManager.buildCodingTaskForStory(this.instanceId, story, i, total, {
        projectContext: this.projectContext,
        testRequirements: this.testRequirements,
      });
      if (!task) {
        return this.failExecution(`无法为故事 ${story.id} 构建编码任务（缺少技术方案）`);
      }

      const ctx: AgentContext = {
        instanceId: this.instanceId,
        stage: 'coding',
        input: task,
        globalContext: this.contextManager.getGlobalContext(),
        knowledgeService: this.knowledgeService,
        projectId: this.projectId,
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
        this.logger?.error(`[Harness] 故事 ${story.id} 编码异常，跳过: ${reason}`);
        results.push(this.failedStoryResult(task, reason));
      }
    }

    const phase = aggregateCodingResults(results, {
      id: `coding-phase-${this.instanceId}`,
      instanceId: this.instanceId,
      designDocId: design.id,
    });
    this.attachInstanceId(phase);
    this.artifactStore.save('coding', this.instanceId, phase);
    this.logger?.info(
      `[Harness] 编码阶段完成: ${phase.overallStatus}，成功 ${phase.successStoryIds.length}/部分 ${phase.partialStoryIds.length}/失败 ${phase.failedStories.length}`,
    );

    // 全部失败（无任何成功/部分）→ FAILED，不进入 CR
    if (!hasAnySuccessStory(phase)) {
      return this.failExecution(
        `编码全部故事失败: ${phase.failedStories.map((f) => `${f.storyId}(${f.reason})`).join('; ')}`,
      );
    }

    // 部分成功：弱介入窗口，人工决定带失败继续 / 回退（超时默认继续）
    if (phase.overallStatus === 'partial-success') {
      const decision = await this.invokeWeakIntervention('CODING', phase);
      if (decision.action === 'fallback') {
        const fb = this.stateMachine.transition({
          type: 'FALLBACK',
          to: decision.to,
          reason: decision.reason,
        });
        if (!fb.success) return this.failExecution(`编码部分成功回退失败: ${fb.message}`);
        this.logger?.warn(`[Harness] 编码部分成功，回退到 ${decision.to}`);
        return this.runExecutionLoop();
      }
    }

    return this.advanceAfterCoding(phase);
  }

  /** 编码完成推进到 CODE_REVIEWING，进入代码 CR 多轮对话 */
  private async advanceAfterCoding(phase: CodingPhaseResult): Promise<HarnessExecutionResult> {
    const nextState = this.getNextState('CODING');
    if (!nextState) return this.failExecution('无法确定 CODING 的下一状态');
    const advance = this.stateMachine.transition({ type: 'ADVANCE', to: nextState });
    if (!advance.success) return this.failExecution(`状态推进失败: ${advance.message}`);
    this.logger?.info(
      `[Harness] 编码阶段完成（成功 ${phase.successStoryIds.length}、部分 ${phase.partialStoryIds.length}、失败 ${phase.failedStories.length}），进入代码 CR`,
    );
    return this.runExecutionLoop();
  }

  // ============================================================
  // 代码 CR 多轮对话（Reviewer ↔ Coder，复用 #42 模式）
  // ============================================================

  private async runCodeReviewDialog(): Promise<HarnessExecutionResult> {
    const reviewAgent = this.agents.review;
    const codingAgent = this.agents.coding;
    if (!reviewAgent) return this.failExecution('状态 CODE_REVIEWING 缺少 ReviewAgent');

    const design = this.artifactStore.get<FrontendDesignDoc>('design', this.instanceId);
    let coding = this.artifactStore.get<CodingPhaseResult>('coding', this.instanceId);
    const stories = this.artifactStore.get<UserStorySet>('stories', this.instanceId);
    if (!design || !coding || !stories)
      return this.failExecution('代码 CR 缺少上游产物（design/coding/stories）');

    const dialogStart = Date.now();
    let previousIssues: ReviewIssue[] = [];
    let issueResponses: IssueResponse[] = [];
    const dialogMessages: DialogMessage[] = [];

    // 恢复未结束的对话历史（resume 续跑场景），否则新建
    let history =
      this.artifactStore.get<ReviewDialogHistory>('code-review-history', this.instanceId) ??
      undefined;
    if (!history || history.finalVerdict === 'approved') {
      history = {
        reviewType: 'code-review',
        maxRounds: this.maxReviewRounds,
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

    for (let round = startRound; round <= this.maxReviewRounds; round++) {
      // 1. Reviewer CR（只针对 success/partial 故事）
      const reviewCtx: AgentContext = {
        instanceId: this.instanceId,
        stage: 'code-reviewing',
        input: {
          type: 'review-code',
          design,
          coding,
          round,
          previousIssues,
          issueResponses,
        } as CodeReviewInput,
        globalContext: this.contextManager.getGlobalContext(),
        knowledgeService: this.knowledgeService,
        projectId: this.projectId,
      };

      const reviewResult = await reviewAgent.execute(reviewCtx);
      if (!reviewResult.success || !reviewResult.data) {
        return this.failExecution(
          `第 ${round} 轮代码 CR 失败: ${reviewResult.errors.map((e) => e.message).join('; ')}`,
        );
      }
      const review = reviewResult.data as ReviewResult;
      this.attachInstanceId(review);
      this.artifactStore.save('code-review', this.instanceId, review);
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
        this.artifactStore.save('code-review-history', this.instanceId, history);
        this.logger?.info(`[Harness] 代码 CR 第 ${round} 轮通过`);
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
        this.artifactStore.save('code-review-history', this.instanceId, history);
        return this.suspendCodeReviewForHuman(history.suspendReason);
      }

      // 3. request_changes：Coder 修订受影响的故事
      if (!codingAgent) {
        history.finalVerdict = 'needs_human';
        history.suspendReason = '代码 CR 要求修改但未注册 CodingAgent，无法自动修订';
        this.artifactStore.save('code-review-history', this.instanceId, history);
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
        const task = this.contextManager.buildCodingTaskForStory(
          this.instanceId,
          story,
          storyIndex,
          stories.stories.length,
          { projectContext: this.projectContext, testRequirements: this.testRequirements },
        );
        if (!task) continue;

        const reviseCtx: AgentContext = {
          instanceId: this.instanceId,
          stage: 'code-reviewing',
          input: {
            type: 'revise-code',
            task,
            currentResult,
            previousIssues: openIssues,
            round,
          },
          globalContext: this.contextManager.getGlobalContext(),
          knowledgeService: this.knowledgeService,
          projectId: this.projectId,
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
          this.logger?.error(`[Harness] 故事 ${currentResult.storyId} CR 修订异常: ${reason}`);
        }
      }

      if (!anyRevised) {
        return this.failExecution(`第 ${round} 轮代码 CR 要求修改，但没有任何故事成功修订`);
      }

      // 重新聚合并更新 coding 产物（CR revise 后版本 +1，单调递增）
      issueResponses = Array.from(responseMap.values());
      coding = aggregateCodingResults(coding.results, {
        id: coding.id,
        instanceId: this.instanceId,
        designDocId: design.id,
        version: (coding.version ?? 1) + 1,
      });
      this.attachInstanceId(coding);
      this.artifactStore.save('coding', this.instanceId, coding);
      previousIssues = review.issues;

      history.rounds.push({
        round,
        review,
        messages: [...dialogMessages],
        allBlockingResolved: false,
        durationMs: Date.now() - dialogStart,
      });
      this.artifactStore.save('code-review-history', this.instanceId, history);

      // 4. 每轮后可选弱介入（默认关闭）
      if (this.interruptAfterEachRound && this.onWeakIntervention) {
        const decision = await this.invokeWeakIntervention('CODE_REVIEWING', history);
        if (decision.action === 'fallback') {
          return this.fallback(decision.to, decision.reason);
        }
      }
    }

    // 5. 达到最大轮次仍未通过 → 暂停等人工
    history.finalVerdict = 'max_rounds_reached';
    history.suspendReason = `已达到最大代码 CR 轮次（${this.maxReviewRounds}）仍存在 blocking 问题，需要人工决策`;
    history.totalDurationMs = Date.now() - dialogStart;
    this.artifactStore.save('code-review-history', this.instanceId, history);
    return this.suspendCodeReviewForHuman(history.suspendReason);
  }

  /** CR 通过后推进到 DELIVERING；交付阶段（PR）未实现，停在阶段边界等人工 */
  private async advanceAfterCodeReview(): Promise<HarnessExecutionResult> {
    const nextState = this.getNextState('CODE_REVIEWING');
    if (!nextState) return this.failExecution('无法确定 CODE_REVIEWING 的下一状态');
    const advance = this.stateMachine.transition({ type: 'ADVANCE', to: nextState });
    if (!advance.success) return this.failExecution(`状态推进失败: ${advance.message}`);

    this.logger?.info('[Harness] 代码 CR 通过，进入交付阶段（DELIVERING）');
    // 继续执行主循环：DeliveryAgent 执行 → 保存 delivery 产物 → 推进到 DELIVERY_CONFIRMATION 硬卡点
    return this.runExecutionLoop();
  }

  /** 代码 CR 对话中途暂停：currentState 不变，仅置 waiting_human */
  private suspendCodeReviewForHuman(reason: string): HarnessExecutionResult {
    this.stateMachine.pauseForHuman(reason);
    this.logger?.warn(`[Harness] 代码 CR 暂停等待人工: ${reason}`);
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
  private async resumeCodeReviewDialog(): Promise<HarnessExecutionResult> {
    const history = this.artifactStore.get<ReviewDialogHistory>(
      'code-review-history',
      this.instanceId,
    );
    if (!history) {
      return this.failExecution('恢复代码 CR 对话失败：缺少 code-review-history 产物');
    }
    this.stateMachine.markRunning();
    if (history.finalVerdict === 'max_rounds_reached') {
      this.logger?.info('[Harness] 代码 CR 达最大轮次，人工确认接受当前版本，推进到交付');
      return this.advanceAfterCodeReview();
    }
    this.logger?.info(`[Harness] 代码 CR 从第 ${history.rounds.length + 1} 轮续跑`);
    return this.runCodeReviewDialog();
  }

  /** 构造单故事失败结果（异常/Agent 失败时占位，保证聚合输入完整） */
  private failedStoryResult(task: CodingTask, reason: string): CodingResult {
    return {
      id: `coding-${task.storyId}`,
      instanceId: this.instanceId,
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

  // ============================================================
  // 状态到 Agent 的映射
  // ============================================================

  private getAgentForState(state: PipelineStateName): BaseAgent | undefined {
    switch (state) {
      case 'REQUIREMENT_PARSING':
      case 'STORIES_GENERATING':
        return this.agents.requirement;
      case 'DESIGN_GENERATING':
        return this.agents.design;
      case 'DESIGN_REVIEWING':
      case 'CODE_REVIEWING':
        return this.agents.review;
      case 'CODING':
        return this.agents.coding;
      case 'DELIVERING':
        return this.agents.delivery;
      default:
        return undefined;
    }
  }

  private getArtifactStage(state: PipelineStateName): ArtifactStage | undefined {
    switch (state) {
      case 'REQUIREMENT_PARSING':
        return 'requirement';
      case 'STORIES_GENERATING':
        return 'stories';
      case 'DESIGN_GENERATING':
        return 'design';
      case 'DESIGN_REVIEWING':
        return 'design-review';
      case 'CODING':
        return 'coding';
      case 'CODE_REVIEWING':
        return 'code-review';
      case 'DELIVERING':
        return 'delivery';
      default:
        return undefined;
    }
  }

  private getNextState(state: PipelineStateName): PipelineStateName | undefined {
    const transitions: Record<PipelineStateName, PipelineStateName> = {
      INIT: 'REQUIREMENT_PARSING',
      REQUIREMENT_PARSING: 'REQUIREMENT_CLARIFICATION',
      REQUIREMENT_CLARIFICATION: 'STORIES_GENERATING',
      STORIES_GENERATING: 'DESIGN_GENERATING',
      // ADR-014：方案生成 → 方案评审 → API 确认 → 编码
      DESIGN_GENERATING: 'DESIGN_REVIEWING',
      DESIGN_REVIEWING: 'API_CONFIRMATION',
      API_CONFIRMATION: 'CODING',
      CODING: 'CODE_REVIEWING',
      CODE_REVIEWING: 'DELIVERING',
      DELIVERING: 'DELIVERY_CONFIRMATION',
      DELIVERY_CONFIRMATION: 'COMPLETED',
      COMPLETED: 'COMPLETED',
      FAILED: 'FAILED',
      CANCELLED: 'CANCELLED',
      SUSPENDED: 'SUSPENDED',
    };
    return transitions[state];
  }

  private getNextStateAfterBlocking(state: PipelineStateName): PipelineStateName | undefined {
    // 硬卡点确认后，直接进入下一个执行状态
    return this.getNextState(state);
  }

  // ============================================================
  // 人工介入处理
  // ============================================================

  private buildBlockingQuestion(state: PipelineStateName): string {
    switch (state) {
      case 'REQUIREMENT_CLARIFICATION': {
        const requirement = this.artifactStore.get<StructuredRequirement>(
          'requirement',
          this.instanceId,
        );
        const pendingQuestions = requirement?.clarificationLog.filter(
          (q) => q.status === 'pending',
        );
        if (pendingQuestions && pendingQuestions.length > 0) {
          return (
            `需求澄清：有 ${pendingQuestions.length} 个问题需要确认\n` +
            pendingQuestions.map((q, i) => `${i + 1}. [${q.priority}] ${q.question}`).join('\n')
          );
        }
        return '需求澄清：请确认需求分析结果是否准确完整';
      }
      case 'API_CONFIRMATION':
        return 'API 契约确认：方案已通过 AI 评审，请确认 API 接口定义是否正确（确认后进入编码）';
      case 'DELIVERY_CONFIRMATION':
        return '交付确认：请确认代码变更是否符合预期，是否创建 PR';
      default:
        return '请确认是否继续';
    }
  }

  private async handleHumanAnswer(state: PipelineStateName, answer?: string): Promise<void> {
    // REQUIREMENT_CLARIFICATION 走 handleClarificationFollowup（多轮澄清），不进入本方法。
    // API_CONFIRMATION / DELIVERY_CONFIRMATION 的人工回答当前仅作为放行信号（直接推进）；
    // 若未来需要保存人工对 API 契约/交付说明的修改，在此按 state 分别处理。
    this.logger?.info(
      `[Harness] 硬卡点 ${state} 收到人工确认${answer ? '（含回答内容，当前版本仅放行不消费）' : ''}`,
    );
  }

  // ============================================================
  // 工具方法
  // ============================================================

  /**
   * 弱介入窗口调用：回调决策与超时竞速，超时自动 continue，避免流程无限等待。
   * weakConfirmationTimeoutMs <= 0 时不超时，一直等待人工回调。
   */
  private async invokeWeakIntervention(
    state: PipelineStateName,
    artifact: unknown,
  ): Promise<WeakInterventionDecision> {
    if (!this.onWeakIntervention) return { action: 'continue' };

    const decisionPromise = this.onWeakIntervention(state, {
      instanceId: this.instanceId,
      artifact,
    });
    if (this.weakConfirmationTimeoutMs <= 0) return decisionPromise;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<WeakInterventionDecision>((resolve) => {
      timer = setTimeout(() => {
        this.logger?.warn(
          `[Harness] 弱介入窗口 ${this.weakConfirmationTimeoutMs}ms 内无决策，自动继续`,
        );
        resolve({ action: 'continue' });
      }, this.weakConfirmationTimeoutMs);
    });

    try {
      return await Promise.race([decisionPromise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 回填产物对象内部的 instanceId 字段（若存在该字段） */
  private attachInstanceId(data: unknown): void {
    if (data && typeof data === 'object' && 'instanceId' in data) {
      (data as { instanceId: string }).instanceId = this.instanceId;
    }
  }

  /** 评审相关配置（issue #42 评审对话循环消费） */
  getReviewConfig(): { maxReviewRounds: number; interruptAfterEachRound: boolean } {
    return {
      maxReviewRounds: this.maxReviewRounds,
      interruptAfterEachRound: this.interruptAfterEachRound,
    };
  }

  /** 单流程 token 预算（0 不限，issue #39 消费） */
  getTokenBudget(): number {
    return this.maxTokensPerRun;
  }

  /**
   * 状态名转换为 stage 格式（kebab-case）
   * REQUIREMENT_PARSING → requirement-parsing
   */
  private stateToStage(state: PipelineStateName): string {
    return state.toLowerCase().replace(/_/g, '-');
  }

  private failExecution(message: string): HarnessExecutionResult {
    this.logger?.error(`[Harness] 执行失败: ${message}`);
    this.stateMachine.transition({ type: 'FAIL', reason: message });
    return {
      success: false,
      finalState: 'FAILED',
      message,
      waitingForHuman: false,
    };
  }
}
