// 状态机类型定义
// 对应 docs/schema/00-state-machine.md

/**
 * 流水线状态名称
 *
 * 阶段顺序（ADR-014 调整）：API_CONFIRMATION 位于 DESIGN_REVIEWING 之后，
 * 人工确认的是经过 AI 评审的稳定版 API 契约：
 *   DESIGN_GENERATING → DESIGN_REVIEWING → API_CONFIRMATION → CODING
 */
export type PipelineStateName =
  | 'INIT'
  | 'REQUIREMENT_PARSING'
  | 'REQUIREMENT_CLARIFICATION'
  | 'STORIES_GENERATING'
  | 'DESIGN_GENERATING'
  | 'DESIGN_REVIEWING'
  | 'API_CONFIRMATION'
  | 'CODING'
  | 'CODE_REVIEWING'
  | 'DELIVERING'
  | 'DELIVERY_CONFIRMATION'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'SUSPENDED';

/** 流水线运行状态 */
export type PipelineStatus =
  'running' | 'waiting_human' | 'suspended' | 'completed' | 'failed' | 'cancelled';

/** 产物阶段名，用于 artifactIds 的 key */
export type ArtifactStage =
  | 'requirement'
  | 'stories'
  | 'design'
  | 'design-review'
  /** 方案多轮评审对话历史（只增，独立于被评审方案，#42） */
  | 'design-review-history'
  | 'coding'
  | 'code-review'
  /** 代码 CR 多轮对话历史（预留，随 CodingAgent 落地） */
  | 'code-review-history'
  | 'delivery';

/** 流水线状态数据 */
export interface PipelineState {
  /** 流程实例ID */
  instanceId: string;
  /** 当前状态 */
  currentState: PipelineStateName;
  /** 运行状态 */
  status: PipelineStatus;
  /** 产物版本号，回退 +1 */
  currentVersion: number;
  /** CODING 阶段当前故事索引 */
  currentStoryIndex?: number;
  /** CODING 阶段总故事数 */
  totalStories?: number;
  /** 各状态重试次数，key 为状态名 */
  retryCount: Partial<Record<PipelineStateName, number>>;
  /** SUSPENDED 时记录挂起前的状态，用于恢复 */
  suspendedFromState?: PipelineStateName;
  /** 创建时间（ISO 8601） */
  createdAt: string;
  /** 更新时间（ISO 8601） */
  updatedAt: string;
  /** 挂起原因 */
  suspendedReason?: string;
  /** 等待人工输入的说明 */
  waitingFor?: string;
  /** 各阶段产物ID，key 为 ArtifactStage；产物在对应阶段完成后才存在，因此为 Partial */
  artifactIds: Partial<Record<ArtifactStage, string>>;
}

/** 状态流转动作 */
export type StateAction =
  | { type: 'ADVANCE'; to: PipelineStateName }
  | { type: 'FALLBACK'; to: PipelineStateName; reason: string }
  | { type: 'SUSPEND'; reason: string; waitingFor?: string }
  | { type: 'RESUME'; fromState: PipelineStateName }
  | { type: 'FAIL'; reason: string }
  | { type: 'CANCEL'; reason: string }
  | { type: 'COMPLETE' };

/** 状态流转结果 */
export interface StateTransitionResult {
  success: boolean;
  from: PipelineStateName;
  to: PipelineStateName;
  action: StateAction;
  message?: string;
}

/** 人工介入类型 */
export type HumanInterventionType =
  'requirement_clarification' | 'api_confirmation' | 'delivery_confirmation' | 'weak_intervention'; // 弱介入窗口内的人工介入

/** 人工介入记录 */
export interface HumanIntervention {
  id: string;
  instanceId: string;
  type: HumanInterventionType;
  /** 是否硬卡点（必须人工确认） */
  blocking: boolean;
  /** 等待的问题/内容 */
  question: string;
  /** 人工回答 */
  answer?: string;
  status: 'pending' | 'answered' | 'timeout' | 'skipped';
  createdAt: string;
  answeredAt?: string;
  /** 超时时间（毫秒），0 表示不超时 */
  timeoutMs: number;
}
