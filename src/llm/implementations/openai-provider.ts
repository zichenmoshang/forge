/**
 * OpenAI Provider 实现
 *
 * 支持 OpenAI 兼容接口（包括 Azure OpenAI、本地部署的兼容服务）
 * 自动记录每次调用的 prompt/response/token/耗时
 * 内置指数退避重试
 */

import OpenAI from 'openai';
import type { LLMProvider, LLMRequest, LLMResponse } from '../provider';
import type { LLMConfig } from '../../config';
import type { Logger } from '../../observability/logger';

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';

  private client: OpenAI;
  private config: LLMConfig;
  private logger?: Logger;
  private maxRetries: number;
  private baseDelayMs: number;

  constructor(
    config: LLMConfig,
    options?: { logger?: Logger; maxRetries?: number; baseDelayMs?: number },
  ) {
    this.config = config;
    this.logger = options?.logger;
    this.maxRetries = options?.maxRetries ?? 3;
    this.baseDelayMs = options?.baseDelayMs ?? 1000;

    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl || undefined,
      // 大输出量场景（故事拆解、技术方案）可能需要较长生成时间，设置 30 分钟超时
      timeout: 30 * 60 * 1000,
    });
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const startTime = Date.now();
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.client.chat.completions.create({
          model: request.model || this.config.model,
          messages: this.buildMessages(request),
          temperature: request.temperature ?? this.config.defaultTemperature,
          max_tokens: request.maxTokens ?? this.config.defaultMaxTokens,
        });

        const durationMs = Date.now() - startTime;
        const content = response.choices[0]?.message.content || '';

        const result: LLMResponse = {
          content,
          model: response.model,
          promptTokens: response.usage?.prompt_tokens ?? 0,
          completionTokens: response.usage?.completion_tokens ?? 0,
          totalTokens: response.usage?.total_tokens ?? 0,
          durationMs,
          finishReason: response.choices[0]?.finish_reason || 'unknown',
        };

        // 记录 LLM 调用
        this.logger?.logLLMCall({
          timestamp: new Date().toISOString(),
          traceId: request.traceId,
          instanceId: request.instanceId,
          agent: request.caller,
          provider: this.name,
          model: result.model,
          prompt: request.prompt,
          systemPrompt: request.systemPrompt,
          response: content,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          totalTokens: result.totalTokens,
          durationMs,
          success: true,
          finishReason: result.finishReason,
        });

        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // 记录失败
        this.logger?.warn(
          `LLM 调用失败 (尝试 ${attempt + 1}/${this.maxRetries + 1}): ${lastError.message}`,
          {
            instanceId: request.instanceId,
            agent: request.caller,
          },
        );

        // 如果是最后一次尝试，不再重试
        if (attempt >= this.maxRetries) break;

        // 指数退避等待
        const delay = this.baseDelayMs * Math.pow(2, attempt);
        await this.sleep(delay);
      }
    }

    // 所有重试都失败
    const durationMs = Date.now() - startTime;
    this.logger?.logLLMCall({
      timestamp: new Date().toISOString(),
      traceId: request.traceId,
      instanceId: request.instanceId,
      agent: request.caller,
      provider: this.name,
      model: this.config.model,
      prompt: request.prompt,
      systemPrompt: request.systemPrompt,
      response: '',
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      durationMs,
      success: false,
      error: lastError?.message,
    });

    throw lastError;
  }

  /** 构建 messages 数组 */
  private buildMessages(request: LLMRequest): Array<{ role: 'system' | 'user'; content: string }> {
    const messages: Array<{ role: 'system' | 'user'; content: string }> = [];

    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt });
    }
    messages.push({ role: 'user', content: request.prompt });

    return messages;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
