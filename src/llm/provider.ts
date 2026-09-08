/**
 * LLM Provider 接口
 *
 * 所有模型实现此接口，支持配置化切换。
 * 每次调用自动记录 prompt/response/token/耗时（可观测性）。
 */

export interface LLMRequest {
  prompt: string;
  systemPrompt?: string;
  /** 单次调用覆盖默认模型 */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** 链路追踪 ID */
  traceId?: string;
  /** 调用方（用于日志和统计） */
  caller?: string;
  /** 关联的流程实例 */
  instanceId?: string;
}

export interface LLMResponse {
  content: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs: number;
  finishReason: string;
}

export interface LLMProvider {
  readonly name: string;
  complete(request: LLMRequest): Promise<LLMResponse>;
}
