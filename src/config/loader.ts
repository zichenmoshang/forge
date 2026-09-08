/**
 * 配置加载器
 * 加载 .env 文件，从环境变量构建配置，用 zod 校验
 *
 * 设计原则：
 * - 环境变量存在且非空时才传入，缺失时由 zod 的 default 提供默认值
 * - 数字/布尔类型不做手动转换，由 zod 的 z.coerce / preprocess 负责
 * - 无效值（如 LLM_TEMPERATURE=abc）会被 zod 捕获并 fail-fast
 */

import * as dotenv from 'dotenv';
import { forgeConfigSchema, type ForgeConfig } from './schema';

// 加载 .env 文件（如果存在）
dotenv.config();

/**
 * 读取环境变量，空字符串视为未设置（让 zod 用 default）
 */
function env(key: string): string | undefined {
  const val = process.env[key];
  if (val === undefined || val.trim() === '') return undefined;
  return val;
}

/**
 * 从环境变量构建配置对象（只传非空值，其余由 zod default 处理）
 */
function buildConfigFromEnv(): Record<string, unknown> {
  return {
    llm: {
      provider: env('LLM_PROVIDER'),
      apiKey: env('LLM_API_KEY'),
      baseUrl: env('LLM_BASE_URL'),
      model: env('LLM_MODEL'),
      defaultTemperature: env('LLM_TEMPERATURE'),
      defaultMaxTokens: env('LLM_MAX_TOKENS'),
    },
    postgres: {
      host: env('PG_HOST'),
      port: env('PG_PORT'),
      database: env('PG_DATABASE'),
      user: env('PG_USER'),
      password: env('PG_PASSWORD'),
    },
    figma: {
      apiToken: env('FIGMA_API_TOKEN'),
    },
    dataDir: env('DATA_DIR'),
    humanInteraction: {
      weakConfirmationTimeoutMs: env('WEAK_CONFIRMATION_TIMEOUT_MS'),
      hardConfirmationTimeoutMs: env('HARD_CONFIRMATION_TIMEOUT_MS'),
    },
    retry: {
      llmMaxRetries: env('LLM_MAX_RETRIES'),
      agentMaxRetries: env('AGENT_MAX_RETRIES'),
      baseDelayMs: env('RETRY_BASE_DELAY_MS'),
    },
    coding: {
      maxTestRetriesPerStory: env('MAX_TEST_RETRIES_PER_STORY'),
      maxClarificationRounds: env('MAX_CLARIFICATION_ROUNDS'),
      maxDesignReviewRounds: env('MAX_DESIGN_REVIEW_ROUNDS'),
      maxCodeReviewRounds: env('MAX_CODE_REVIEW_ROUNDS'),
    },
    observability: {
      logLevel: env('LOG_LEVEL'),
      logLLMRequests: env('LOG_LLM_REQUESTS'),
      logDir: env('LOG_DIR'),
    },
    embedding: {
      provider: env('EMBEDDING_PROVIDER'),
      apiKey: env('EMBEDDING_API_KEY'),
      baseUrl: env('EMBEDDING_BASE_URL'),
      model: env('EMBEDDING_MODEL'),
      dimensions: env('EMBEDDING_DIMENSIONS'),
    },
    knowledgeBase: {
      searchTopK: env('KB_SEARCH_TOP_K'),
      rerankEnabled: env('KB_RERANK_ENABLED'),
    },
    feishu: {
      appId: env('FEISHU_APP_ID'),
      appSecret: env('FEISHU_APP_SECRET'),
      wikiSpaceIds: env('FEISHU_WIKI_SPACE_IDS'),
    },
  };
}

/**
 * 加载并校验配置
 * @throws 如果配置校验失败，抛出包含详细错误信息的异常
 */
export function loadConfig(): ForgeConfig {
  const rawConfig = buildConfigFromEnv();
  const result = forgeConfigSchema.safeParse(rawConfig);

  if (!result.success) {
    const errors = result.error.issues.map((issue) => {
      const path = issue.path.join('.');
      return `  - ${path}: ${issue.message}`;
    });
    throw new Error(`配置校验失败:\n${errors.join('\n')}`);
  }

  return result.data;
}

// 单例：启动时加载一次
let cachedConfig: ForgeConfig | null = null;

/**
 * 获取全局配置（单例）
 */
export function getConfig(): ForgeConfig {
  if (!cachedConfig) {
    cachedConfig = loadConfig();
  }
  return cachedConfig;
}

/**
 * 重置配置缓存（仅用于测试）
 */
export function resetConfigCache(): void {
  cachedConfig = null;
}
