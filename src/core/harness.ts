/**
 * Harness 主类（门面）- 状态机执行器与 Agent 调度器（issue #47 拆分瘦身）
 *
 * 拆分后职责：
 * - 生命周期与状态机：构造、start、resume、fallback、cancel、continueFromSnapshot
 * - 主执行循环（runExecutionLoop）：按当前状态分发到 评审 Runner / 编码 Runner / 通用 Agent 执行
 * - 硬卡点等待与人工介入回调
 * - 状态持久化（#82）：state.json 快照 + --resume 恢复
 *
 * 已拆出的子模块（行为不变，#47 纯重构）：
 * - ReviewDialogRunner（src/core/review-dialog.ts）：方案评审/代码 CR 多轮对话
 * - CodingPhaseRunner（src/core/coding-phase.ts）：逐故事 TDD 编排
 * - state-transitions.ts：状态→阶段/Agent/下一状态 纯函数
 * - human-interaction.ts：硬卡点提问/回答/弱介入 纯逻辑
 */

import {
  StateMachine,
  createInitialState,
  isHardBlockingState,
  isTerminalState,
} from './state-machine';
import { randomUUID } from 'crypto';
import { InMemoryArtifactStore } from './artifact-store';
import type { ArtifactStore } from './artifact-store';
import {
  FileSystemArtifactStore,
  loadStateSnapshot,
  saveStateSnapshot,
  isTerminalSnapshot,
} from './state-snapshot';
import * as fs from 'fs';
import * as path from 'path';
import { ContextManager } from './context-manager';
import { ReviewDialogRunner } from './review-dialog';
import { CodingPhaseRunner } from './coding-phase';
import {
  getNextState,
  getNextStateAfterBlocking,
  getAgentForState,
  getArtifactStage,
  stateToStage,
} from './state-transitions';
import {
  buildBlockingQuestion,
  handleHumanAnswer,
  invokeWeakIntervention,
} from './human-interaction';
import type { BaseAgent } from '../agents/base';
import type { AgentContext, AgentResult, GlobalContext } from '../agents/types';
import type { RequirementAgent } from '../agents/requirement-agent';
import type { DesignAgent } from '../agents/design-agent';
import type { CodingAgent } from '../agents/coding-agent';
import type { PipelineState, PipelineStateName, ArtifactStage } from '../types/state';
import type { StructuredRequirement } from '../types/requirement';
import type { ProjectContext, TestRequirements } from '../types/coding-task';
import { buildFreezeChecklist } from './freeze-checklist';
import { TokenBudgetTracker } from './token-budget';
import type { Logger } from '../observability/logger';
import { Logger as LoggerImpl } from '../observability/logger';
import { MetricsCollector } from '../observability/metrics';
import type { RunSummary } from '../observability/metrics';
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
  | { action: 'continue' }
  | { action: 'fallback'; to: PipelineStateName; reason: string };

/** 弱介入回调：在弱介入窗口内人工可决定继续或回退 */
export type WeakInterventionCallback = (
  state: PipelineStateName,
  context: { instanceId: string; artifact?: unknown },
) => Promise<WeakInterventionDecision>;

/**
 * 需要弱介入窗口的状态（Agent 执行完成后、推进前）。
 * 注：DESIGN_REVIEWING / CODE_REVIEWING 的弱介入已内聚到各自多轮对话循环
 *（interruptAfterEachRound + 终止条件暂停），不走主循环的通用弱介入。
 */
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
  /** 自由文本人工输入回调（新项目技术栈反问等；非交互模式应返回 undefined 以走推荐默认） */
  onRequestHumanInput?: (question: string) => Promise<string | undefined>;
  /** 弱介入窗口回调（故事拆解/方案评审/代码CR后触发） */
  onWeakIntervention?: WeakInterventionCallback;
  logger?: Logger;
  /** 实例 ID，不填则自动生成 */
  instanceId?: string;
  /** 实例目录（产物/状态快照/日志落盘位置），默认 ./data/instances/{instanceId}（issue #82） */
  instanceDir?: string;
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
  /** 单次 LLM 调用 token 上限（0 表示不限制，防单次输出异常膨胀；issue #39） */
  maxTokensPerCall?: number;
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
  private onRequestHumanInput?: (question: string) => Promise<string | undefined>;
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
  /** 单次调用 token 上限（issue #39 落地时消费） */
  private readonly maxTokensPerCall: number;
  /** 流程级 Token 预算跟踪器（注入每个 AgentContext，BaseAgent 在 LLM 调用前后检查/累计） */
  private readonly tokenBudget: TokenBudgetTracker;
  /** 弱介入窗口超时（毫秒，0 表示不超时） */
  private readonly weakConfirmationTimeoutMs: number;
  private knowledgeService?: KnowledgeService;
  private projectId?: string;
  private readonly globalContext: GlobalContext;
  readonly instanceId: string;
  /** 实例目录（产物/快照/日志落盘根） */
  private readonly instanceDir: string;
  /** 链路追踪根 ID（全流程不变，快照恢复时保持一致，独立持久化 trace-id.txt） */
  readonly traceId: string;
  /** Metrics 指标聚合器（终态产出 run-summary.json） */
  private readonly metrics: MetricsCollector;
  /** 评审多轮对话 Runner（issue #47 拆分） */
  private readonly reviewDialog: ReviewDialogRunner;
  /** 编码阶段 Runner（issue #47 拆分） */
  private readonly codingPhase: CodingPhaseRunner;

  constructor(config: HarnessConfig) {
    this.instanceId = config.instanceId ?? `forge-${Date.now()}`;
    this.agents = config.agents;
    // 实例目录：产物、状态快照、日志的落盘根目录（issue #82）
    this.instanceDir = config.instanceDir ?? path.join('data', 'instances', this.instanceId);

    // traceId：全流程链路根 ID。独立持久化 trace-id.txt，保证快照恢复后链路 ID 一致
    this.traceId = this.resolveOrCreateTraceId(this.instanceDir);

    // Metrics：进程内按 stage/agent 聚合调用指标，终态落盘 run-summary.json
    this.metrics = new MetricsCollector(this.instanceId, this.traceId);

    // 默认文件系统产物存储：产物落盘，进程重启后可恢复；测试场景仍可显式传入 InMemoryArtifactStore
    this.artifactStore =
      config.artifactStore ??
      new FileSystemArtifactStore(path.join(this.instanceDir, 'artifacts'));
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
    this.maxTokensPerCall = config.maxTokensPerCall ?? 0;
    this.tokenBudget = new TokenBudgetTracker(this.maxTokensPerRun, this.maxTokensPerCall);
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
    this.onRequestHumanInput = config.onRequestHumanInput;
    this.onWeakIntervention = config.onWeakIntervention;

    // 如果没有传入 Logger，自动创建按实例分目录的 Logger
    if (config.logger) {
      this.logger = config.logger;
    } else {
      const obsConfig: ObservabilityConfig = {
        logLevel: 'info',
        logDir: path.join(this.instanceDir, 'logs'),
        logLLMRequests: true,
      };
      this.logger = new LoggerImpl(obsConfig);
    }

    // 状态持久化（issue #82）：每次状态变更原子写 state.json 快照
    const persistState = (state: PipelineState): void => {
      try {
        saveStateSnapshot(this.instanceDir, state);
      } catch (err) {
        this.logger?.warn(
          `[Harness] 状态快照写入失败（不影响内存执行）: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    };
    const snapshot = loadStateSnapshot(this.instanceDir);
    if (snapshot) {
      // 存在历史快照：恢复到上次状态（崩溃/重启续跑场景）
      this.logger?.info(
        `[Harness] 检测到历史快照，恢复实例状态: ${snapshot.currentState} (status=${snapshot.status})`,
      );
      this.stateMachine = new StateMachine(snapshot, { onStateChange: persistState });
      this.restoredFromSnapshot = !isTerminalSnapshot(snapshot);
    } else {
      const initialState = createInitialState(this.instanceId);
      this.stateMachine = new StateMachine(initialState, { onStateChange: persistState });
      // 初始状态也落一次盘，保证进程一旦创建实例即具备可恢复快照
      persistState(this.stateMachine.getState());
    }

    // issue #47 拆分：评审对话与编码阶段 Runner 注入共享依赖与跨类回调
    this.reviewDialog = new ReviewDialogRunner(
      {
        agents: this.agents,
        artifactStore: this.artifactStore,
        stateMachine: this.stateMachine,
        contextManager: this.contextManager,
        instanceId: this.instanceId,
        logger: this.logger,
        maxReviewRounds: this.maxReviewRounds,
        interruptAfterEachRound: this.interruptAfterEachRound,
        knowledgeService: this.knowledgeService,
        projectId: this.projectId,
        tokenBudget: this.tokenBudget,
        traceId: this.traceId,
        metrics: this.metrics,
      },
      {
        failExecution: (m) => this.failExecution(m),
        attachInstanceId: (d) => this.attachInstanceId(d),
        runExecutionLoop: () => this.runExecutionLoop(),
        fallback: (to, reason) => this.fallback(to, reason),
        resume: (a) => this.resume(a),
        invokeWeakIntervention: (s, a) =>
          invokeWeakIntervention(
            this.onWeakIntervention,
            this.logger,
            this.instanceId,
            this.weakConfirmationTimeoutMs,
            s,
            a,
          ),
        buildBlockingQuestion: (s) =>
          buildBlockingQuestion(this.artifactStore, this.instanceId, s),
        buildCodingTaskForStory: (story, index, total) =>
          this.contextManager.buildCodingTaskForStory(this.instanceId, story, index, total, {
            projectContext: this.projectContext,
            testRequirements: this.testRequirements,
          }),
        onHumanIntervention: this.onHumanIntervention,
      },
    );
    this.codingPhase = new CodingPhaseRunner(
      {
        agents: this.agents,
        artifactStore: this.artifactStore,
        stateMachine: this.stateMachine,
        contextManager: this.contextManager,
        instanceId: this.instanceId,
        logger: this.logger,
        knowledgeService: this.knowledgeService,
        projectId: this.projectId,
        tokenBudget: this.tokenBudget,
        projectContext: this.projectContext,
        testRequirements: this.testRequirements,
        traceId: this.traceId,
        metrics: this.metrics,
      },
      {
        failExecution: (m) => this.failExecution(m),
        attachInstanceId: (d) => this.attachInstanceId(d),
        runExecutionLoop: () => this.runExecutionLoop(),
        fallback: (to, reason) => this.fallback(to, reason),
        invokeWeakIntervention: (s, a) =>
          invokeWeakIntervention(
            this.onWeakIntervention,
            this.logger,
            this.instanceId,
            this.weakConfirmationTimeoutMs,
            s,
            a,
          ),
      },
    );

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
   * 从快照续跑（issue #82）：进程崩溃/重启后，CLI --resume 使用。
   *
   * 恢复语义：
   * - 终态（COMPLETED/FAILED/CANCELLED）：直接返回结果，不继续执行；
   * - waiting_human（硬卡点/评审对话框暂停）：返回等待人工，由调用方 resume() 续跑；
   * - running（阶段执行中崩溃）：按当前状态重新进入对应执行分支（runExecutionLoop 按 currentState 分发）。
   */
  async continueFromSnapshot(): Promise<HarnessExecutionResult> {
    const state = this.stateMachine.getState();
    this.logger?.info(`[Harness] 快照续跑: ${state.currentState} (status=${state.status})`);

    if (isTerminalState(state.currentState)) {
      return {
        success: state.currentState === 'COMPLETED',
        finalState: state.currentState,
        message: `实例已处于终态 ${state.currentState}，无需续跑`,
        waitingForHuman: false,
      };
    }

    if (state.status === 'waiting_human') {
      const question = buildBlockingQuestion(
        this.artifactStore,
        this.instanceId,
        state.currentState,
      );
      return {
        success: true,
        finalState: state.currentState,
        message: question,
        waitingForHuman: true,
        waitingQuestion: question,
      };
    }

    // running：从当前状态重新执行（runExecutionLoop 按 currentState 分发对应阶段）
    return this.runExecutionLoop();
  }

  /** 是否本次构造时从历史快照恢复了未完成实例 */
  restoredFromSnapshot: boolean = false;

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
      return this.reviewDialog.resumeDesignReviewDialog();
    } else if (state.currentState === 'CODE_REVIEWING') {
      // 代码 CR 多轮对话中途暂停（request_human / max_rounds）后的恢复
      return this.reviewDialog.resumeCodeReviewDialog();
    } else {
      // 其他硬卡点：直接处理人工回答
      handleHumanAnswer(this.logger, state.currentState, humanAnswer);
    }

    // 从硬卡点状态前进
    const nextState = getNextStateAfterBlocking(state.currentState);
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
      humanAnswers: [
        ...(requirement.humanAnswers ?? []),
        { answer: humanAnswer, answeredAt: now },
      ],
      clarificationLog: requirement.clarificationLog.map((q) =>
        q.status === 'pending' ? { ...q, status: 'resolved' as const, answeredAt: now } : q,
      ),
      updatedAt: now,
    };

    // 调用 RequirementAgent 的 followup 模式
    const context: AgentContext = {
      instanceId: this.instanceId,
      traceId: this.traceId,
      stage: 'requirement-clarification',
      input: {
        type: 'clarify-followup',
        previousRequirement: updatedRequirement,
        // v1 用统一回答（humanAnswers），answers 字段 v2 按问题匹配时使用
      },
      globalContext: this.contextManager.getGlobalContext(),
      knowledgeService: this.knowledgeService,
      projectId: this.projectId,
      tokenBudget: this.tokenBudget,
      metrics: this.metrics,
      requestHumanInput: this.onRequestHumanInput,
    };

    try {
      const result = await this.agents.requirement.execute(context);
      if (!result.success || !result.data) {
        this.logger?.warn(
          `[Harness] 澄清 followup 失败，直接推进: ${result.errors
            .map((e: { message: string }) => e.message)
            .join('; ')}`,
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
        this.logger?.info(
          `[Harness] 还有 ${pendingQuestions.length} 个澄清问题待回答，继续等待`,
        );
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
    this.finalizeSummary('CANCELLED');
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
        return this.reviewDialog.runDesignReviewDialog();
      }

      // 编码为逐故事 TDD 循环 + 部分成功出口（#40），不走通用单次执行路径
      if (state.currentState === 'CODING') {
        return this.codingPhase.runCodingPhase();
      }

      // 代码 CR 走多轮对话循环（Reviewer ↔ Coder，复用 #42 模式），不走通用单次执行路径
      if (state.currentState === 'CODE_REVIEWING') {
        return this.reviewDialog.runCodeReviewDialog();
      }

      // 检查是否有对应 Agent
      const agent = getAgentForState(state.currentState, this.agents);
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
        traceId: this.traceId,
        stage: stateToStage(state.currentState),
        input: agentInput,
        globalContext: this.contextManager.getGlobalContext(),
        // ADR-014：知识库检索职责收归 Agent，服务通过上下文注入，由 Agent 内部按需检索
        knowledgeService: this.knowledgeService,
        projectId: this.projectId,
        tokenBudget: this.tokenBudget,
        metrics: this.metrics,
        requestHumanInput: this.onRequestHumanInput,
      };

      let result: AgentResult;
      try {
        result = await agent.execute(context);
      } catch (err) {
        // Agent 执行异常（网络错误、未捕获异常）→ Harness 层重试
        const retryCount = this.stateMachine.incrementRetry();
        if (retryCount < this.maxRetries) {
          this.logger?.warn(
            `[Harness] Agent 执行异常，第 ${retryCount} 次重试: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          state = this.stateMachine.getState();
          continue;
        }
        return this.failExecution(
          `Agent 执行异常（重试 ${retryCount} 次）: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      if (!result.success) {
        // 业务失败（BaseAgent 内部输出解析/校验重试已耗尽）→ 不再重试，直接失败
        return this.failExecution(
          `Agent 执行失败: ${result.errors.map((e) => e.message).join('; ')}`,
        );
      }

      // 保存产物（回填 instanceId，保证产物对象自描述、持久化后可判断归属）
      const artifactStage = getArtifactStage(state.currentState);
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
        const decision = await invokeWeakIntervention(
          this.onWeakIntervention,
          this.logger,
          this.instanceId,
          this.weakConfirmationTimeoutMs,
          state.currentState,
          result.data,
        );

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
      const nextState = getNextState(state.currentState);
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
        const question = buildBlockingQuestion(
          this.artifactStore,
          this.instanceId,
          state.currentState,
        );
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

    // 终态：聚合指标落盘 run-summary.json 并打印摘要
    const summary = this.finalizeSummary(state.currentState);
    return {
      success: state.currentState === 'COMPLETED',
      finalState: state.currentState,
      message: summary ? this.formatSummaryMessage(summary) : undefined,
      waitingForHuman: false,
    };
  }

  // ============================================================
  // 工具方法
  // ============================================================

  /** 回填产物对象内部的 instanceId 字段（若存在该字段） */
  private attachInstanceId(data: unknown): void {
    if (data && typeof data === 'object' && 'instanceId' in data) {
      (data as { instanceId: string }).instanceId = this.instanceId;
    }
  }

  private failExecution(message: string): HarnessExecutionResult {
    this.logger?.error(`[Harness] 执行失败: ${message}`);
    this.stateMachine.transition({ type: 'FAIL', reason: message });
    const summary = this.finalizeSummary('FAILED');
    return {
      success: false,
      finalState: 'FAILED',
      message: summary ? `${message}\n${this.formatSummaryMessage(summary)}` : message,
      waitingForHuman: false,
    };
  }

  // ============================================================
  // Trace / Metrics 辅助
  // ============================================================

  /** 读取实例目录下 trace-id.txt；不存在则生成 UUID 并持久化（快照恢复后链路 ID 保持一致） */
  private resolveOrCreateTraceId(instanceDir: string): string {
    try {
      if (!fs.existsSync(instanceDir)) fs.mkdirSync(instanceDir, { recursive: true });
      const traceFile = path.join(instanceDir, 'trace-id.txt');
      if (fs.existsSync(traceFile)) {
        const existing = fs.readFileSync(traceFile, 'utf-8').trim();
        if (existing) return existing;
      }
      const id = randomUUID();
      fs.writeFileSync(traceFile, id, 'utf-8');
      return id;
    } catch {
      // 持久化失败不阻断流程，退回内存生成（进程内仍可追踪）
      return randomUUID();
    }
  }

  /** 终态聚合指标并原子落盘 run-summary.json；失败不阻断终态返回 */
  private finalizeSummary(finalState: string): RunSummary | null {
    try {
      const summary = this.metrics.writeSummary(this.instanceDir, finalState);
      this.logger?.info(
        `[Harness] 指标汇总已落盘: ${path.join(this.instanceDir, 'run-summary.json')}`,
        { instanceId: this.instanceId, traceId: this.traceId },
      );
      return summary;
    } catch (err) {
      this.logger?.warn(
        `[Harness] run-summary 落盘失败（不影响终态）: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /** 控制台摘要文本：总调用/总 token/总耗时 + 按阶段明细 */
  private formatSummaryMessage(summary: RunSummary): string {
    const lines = [
      `指标汇总：LLM 调用 ${summary.totalCalls} 次（失败 ${summary.failedCalls}），` +
        `共 ${summary.totalTokens} tokens（prompt ${summary.totalPromptTokens} / completion ${summary.totalCompletionTokens}），` +
        `LLM 累计耗时 ${(summary.totalDurationMs / 1000).toFixed(1)}s`,
      '按阶段：' +
        summary.byStage
          .map((s) => `${s.name}=${s.totalTokens}tokens/${s.calls}次`)
          .join('，'),
    ];
    return lines.join('\n');
  }
}
