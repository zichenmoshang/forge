/**
 * Agent 通用类型定义
 */

import type { KnowledgeItem } from '../types/knowledge';
import type { KnowledgeService } from '../services/knowledge-service';
import type { TokenBudgetTracker } from '../core/token-budget';
import type { MetricsCollector } from '../observability/metrics';

/**
 * 全局上下文（跨阶段始终携带的团队/项目约束）
 *
 * 由 Harness 从配置接收，注入每个 AgentContext，Agent 生成产物时必须遵循。
 * 定义在此中立位置以避免 Agent 层反向依赖 core/context-manager。
 */
export interface GlobalContext {
  /** 技术栈约束（如 React + TypeScript + Vite） */
  techStack?: string;
  /** 团队编码规范 */
  codingStandards?: string;
  /** 项目配置 */
  projectConfig?: Record<string, unknown>;
  /** 其他全局约束 */
  constraints?: string[];
}

/** Agent 执行上下文 */
export interface AgentContext {
  /** 流程实例 ID */
  instanceId: string;
  /** 链路追踪 ID */
  traceId?: string;
  /** 当前阶段（如 'requirement'、'design'） */
  stage: string;
  /** 输入数据（上游产物或原始输入） */
  input: unknown;
  /** 全局约束（技术栈、团队规范等，跨阶段始终携带） */
  globalContext?: GlobalContext;
  /** 预检索的知识结果（一般为空；ADR-014 后检索由 Agent 内部通过 knowledgeService 自主完成） */
  knowledge?: KnowledgeItem[];
  /** 知识库服务（由 Harness 注入，Agent 在 retrieveKnowledge 中按需多路检索） */
  knowledgeService?: KnowledgeService;
  /** 当前项目 ID，知识库检索时用于 projectScope 过滤（当前项目 + global） */
  projectId?: string;
  /** Token 预算跟踪器（由 Harness 注入，BaseAgent 在 LLM 调用前后检查/累计，issue #39） */
  tokenBudget?: TokenBudgetTracker;
  /** Metrics 指标聚合器（由 Harness 注入，BaseAgent 每次 LLM 调用后记录，终态产出 run-summary） */
  metrics?: MetricsCollector;
  /** 额外参数 */
  params?: Record<string, unknown>;
}

/** Agent 错误 */
export interface AgentError {
  /** 错误码 */
  code: string;
  /** 错误信息 */
  message: string;
  /** 严重程度 */
  severity: 'error' | 'warning';
  /** 相关字段/位置 */
  field?: string;
}

/** Agent 执行结果 */
export interface AgentResult<O = unknown> {
  /** 是否成功 */
  success: boolean;
  /** 输出数据 */
  data?: O;
  /** 错误列表 */
  errors: AgentError[];
  /** 执行耗时（毫秒） */
  durationMs: number;
  /** LLM 调用次数 */
  llmCalls: number;
  /** 重试次数 */
  retries: number;
}

/** Agent 执行配置 */
export interface AgentConfig {
  /** 最大重试次数（输出校验失败时） */
  maxRetries?: number;
  /** 重试基础延迟（毫秒） */
  retryBaseDelayMs?: number;
  /** LLM 温度 */
  temperature?: number;
  /** LLM 最大 token */
  maxTokens?: number;
}
