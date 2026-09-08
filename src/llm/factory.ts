/**
 * LLM Provider 工厂
 *
 * 根据配置创建对应的 Provider 实例，支持运行时切换。
 * 配置类型统一从 config 层导入，避免重复定义。
 */

import type { LLMConfig } from '../config';
import type { LLMProvider } from './provider';
import { OpenAIProvider } from './implementations/openai-provider';
import type { Logger } from '../observability/logger';

export type { LLMConfig } from '../config';

export interface CreateProviderOptions {
  logger?: Logger;
  maxRetries?: number;
  baseDelayMs?: number;
}

/**
 * 根据配置创建 LLM Provider
 */
export function createLLMProvider(config: LLMConfig, options?: CreateProviderOptions): LLMProvider {
  switch (config.provider) {
    case 'openai':
      return new OpenAIProvider(config, options);
    case 'anthropic':
      throw new Error('Anthropic provider 尚未实现');
    case 'custom':
      throw new Error('Custom provider 需要通过扩展机制注册');
    default:
      throw new Error(`不支持的 provider: ${config.provider}`);
  }
}
