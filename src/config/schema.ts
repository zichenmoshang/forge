/**
 * 配置 Schema 定义
 * 使用 zod 做运行时校验，启动时 fail-fast
 *
 * 设计原则：
 * - 环境变量原始字符串直接传入，由 zod 负责转换和校验
 * - 数字用 z.coerce.number()，无效值（如 "abc"）直接报错
 * - 布尔用自定义 preprocess，支持 true/false/1/0/yes/no
 * - 环境变量缺失时由 default 提供默认值
 */

import { z } from 'zod';

/** 布尔值解析：支持 true/false/1/0/yes/no/on/off（不区分大小写） */
const booleanFromString = z.preprocess((val) => {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') {
    const lower = val.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(lower)) return true;
    if (['false', '0', 'no', 'off'].includes(lower)) return false;
  }
  return val; // 交给后续 z.boolean() 报错
}, z.boolean());

// LLM 配置
const providerTypeSchema = z.enum(['openai', 'anthropic', 'custom']);
export type ProviderType = z.infer<typeof providerTypeSchema>;

export const llmConfigSchema = z.object({
  provider: providerTypeSchema.default('openai'),
  apiKey: z.string().min(1, 'LLM_API_KEY 不能为空'),
  baseUrl: z.string().url().optional().or(z.literal('')),
  model: z.string().min(1).default('gpt-4o'),
  defaultTemperature: z.coerce.number().min(0).max(2).default(0.7),
  defaultMaxTokens: z.coerce.number().int().positive().default(4096),
});

// PostgreSQL 配置
export const postgresConfigSchema = z.object({
  host: z.string().min(1).default('localhost'),
  port: z.coerce.number().int().positive().default(5432),
  database: z.string().min(1).default('forge'),
  user: z.string().min(1).default('postgres'),
  password: z.string().default(''),
});

// Figma 配置
export const figmaConfigSchema = z.object({
  apiToken: z.string().default(''),
});

// 人工介入配置
export const humanInteractionConfigSchema = z.object({
  weakConfirmationTimeoutMs: z.coerce.number().int().positive().default(30000),
  hardConfirmationTimeoutMs: z.coerce.number().int().min(0).default(0),
});

// 重试配置
export const retryConfigSchema = z.object({
  llmMaxRetries: z.coerce.number().int().min(0).default(3),
  agentMaxRetries: z.coerce.number().int().min(0).default(2),
  baseDelayMs: z.coerce.number().int().positive().default(1000),
});

// 编码阶段配置
export const codingConfigSchema = z.object({
  maxTestRetriesPerStory: z.coerce.number().int().positive().default(5),
  maxClarificationRounds: z.coerce.number().int().positive().default(5),
  maxDesignReviewRounds: z.coerce.number().int().positive().default(3),
  maxCodeReviewRounds: z.coerce.number().int().positive().default(3),
});

// 成本与预算配置（ADR-014：事前预算控制，0 表示不限制）
export const budgetConfigSchema = z.object({
  /** 单个流程实例的 token 总量上限（输入+输出），0 表示不限制；超限时暂停等人工 */
  maxTokensPerRun: z.coerce.number().int().min(0).default(0),
  /** 单次 LLM 调用的 token 上限兜底（防 prompt 异常膨胀），0 表示不限制 */
  maxTokensPerCall: z.coerce.number().int().min(0).default(0),
});

// 可观测性配置
export const observabilityConfigSchema = z.object({
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  logLLMRequests: booleanFromString.default(true),
  logDir: z.string().min(1).default('./data/logs'),
});

// 向量模型配置（知识库嵌入）
const embeddingProviderSchema = z.enum(['qwen', 'mock']);
export type EmbeddingProviderType = z.infer<typeof embeddingProviderSchema>;

export const embeddingConfigSchema = z.object({
  provider: embeddingProviderSchema.default('qwen'),
  apiKey: z.string().default(''),
  baseUrl: z.string().url().optional().or(z.literal('')),
  model: z.string().min(1).default('text-embedding-v3'),
  dimensions: z.coerce.number().int().positive().default(1024),
});

// 知识库检索配置
export const knowledgeBaseConfigSchema = z.object({
  searchTopK: z.coerce.number().int().positive().default(10),
  rerankEnabled: booleanFromString.default(false),
});

// 飞书文档同步配置（v2）
export const feishuConfigSchema = z.object({
  appId: z.string().default(''),
  appSecret: z.string().default(''),
  wikiSpaceIds: z.string().default(''),
});

// 交付阶段配置（阶段7：代码落盘 + Git + 构建验证 + PR）
export const deliveryConfigSchema = z.object({
  /** 目标项目路径（代码落盘位置），默认 ./target-project */
  targetProjectPath: z.string().min(1).default('./target-project'),
  /** 交付场景：不填自动推断（检查目标项目状态） */
  scenario: z.enum(['new-project', 'new-module', 'code-modification']).optional(),
  git: z
    .object({
      /** 远程仓库地址（初始化时设置，v1 不 push） */
      remoteUrl: z.string().default(''),
      /** 基础分支，默认 main */
      baseBranch: z.string().min(1).default('main'),
      /** 分支前缀，默认 feature/forge */
      branchPrefix: z.string().min(1).default('feature/forge'),
      /** Git 用户名（提交时使用） */
      userName: z.string().default('forge-bot'),
      /** Git 邮箱（提交时使用） */
      userEmail: z.string().default('forge-bot@users.noreply.github.com'),
    })
    .default({
      remoteUrl: '',
      baseBranch: 'main',
      branchPrefix: 'feature/forge',
      userName: 'forge-bot',
      userEmail: 'forge-bot@users.noreply.github.com',
    }),
  build: z
    .object({
      /** 是否启用构建验证，默认 true */
      enabled: booleanFromString.default(true),
      /** 自定义构建命令（不填自动检测 package.json scripts.build） */
      command: z.string().default(''),
      /** 构建超时（毫秒），默认 300000（5分钟） */
      timeoutMs: z.coerce.number().int().positive().default(300000),
      /** 构建前是否安装依赖，默认 false（假设已安装） */
      installDeps: booleanFromString.default(false),
    })
    .default({
      enabled: true,
      command: '',
      timeoutMs: 300000,
      installDeps: false,
    }),
});

// 完整配置
export const forgeConfigSchema = z.object({
  llm: llmConfigSchema,
  postgres: postgresConfigSchema,
  figma: figmaConfigSchema,
  dataDir: z.string().min(1).default('./data'),
  humanInteraction: humanInteractionConfigSchema,
  retry: retryConfigSchema,
  coding: codingConfigSchema,
  budget: budgetConfigSchema.default({
    maxTokensPerRun: 0,
    maxTokensPerCall: 0,
  }),
  observability: observabilityConfigSchema,
  embedding: embeddingConfigSchema.default({
    provider: 'qwen',
    apiKey: '',
    baseUrl: '',
    model: 'text-embedding-v3',
    dimensions: 1024,
  }),
  knowledgeBase: knowledgeBaseConfigSchema.default({
    searchTopK: 10,
    rerankEnabled: false,
  }),
  feishu: feishuConfigSchema.default({
    appId: '',
    appSecret: '',
    wikiSpaceIds: '',
  }),
  delivery: deliveryConfigSchema.default({
    targetProjectPath: './target-project',
    git: {
      remoteUrl: '',
      baseBranch: 'main',
      branchPrefix: 'feature/forge',
      userName: 'forge-bot',
      userEmail: 'forge-bot@users.noreply.github.com',
    },
    build: { enabled: true, command: '', timeoutMs: 300000, installDeps: false },
  }),
});

// 导出类型
export type LLMConfig = z.infer<typeof llmConfigSchema>;
export type PostgresConfig = z.infer<typeof postgresConfigSchema>;
export type FigmaConfig = z.infer<typeof figmaConfigSchema>;
export type HumanInteractionConfig = z.infer<typeof humanInteractionConfigSchema>;
export type RetryConfig = z.infer<typeof retryConfigSchema>;
export type CodingConfig = z.infer<typeof codingConfigSchema>;
export type BudgetConfig = z.infer<typeof budgetConfigSchema>;
export type ObservabilityConfig = z.infer<typeof observabilityConfigSchema>;
export type EmbeddingConfig = z.infer<typeof embeddingConfigSchema>;
export type KnowledgeBaseConfig = z.infer<typeof knowledgeBaseConfigSchema>;
export type FeishuConfig = z.infer<typeof feishuConfigSchema>;
export type DeliveryConfig = z.infer<typeof deliveryConfigSchema>;
export type ForgeConfig = z.infer<typeof forgeConfigSchema>;
