import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, resetConfigCache } from '../../src/config/loader';
import { forgeConfigSchema } from '../../src/config/schema';

describe('配置加载与校验', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetConfigCache();
    // 清理所有配置相关环境变量
    const keys = Object.keys(process.env).filter((k) =>
      [
        'LLM_',
        'PG_',
        'FIGMA_',
        'DATA_DIR',
        'WEAK_',
        'HARD_',
        'MAX_',
        'LOG_',
        'RETRY_',
        'AGENT_',
      ].some((prefix) => k.startsWith(prefix)),
    );
    keys.forEach((k) => delete process.env[k]);
  });

  afterEach(() => {
    // 恢复原始环境
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k];
    });
    Object.assign(process.env, originalEnv);
    resetConfigCache();
  });

  describe('数字环境变量校验', () => {
    it('无效的数字环境变量应该报错（不静默降级）', () => {
      process.env.LLM_API_KEY = 'test-key';
      process.env.LLM_TEMPERATURE = 'abc';

      expect(() => loadConfig()).toThrow('配置校验失败');
      expect(() => loadConfig()).toThrow('defaultTemperature');
    });

    it('无效的端口应该报错', () => {
      process.env.LLM_API_KEY = 'test-key';
      process.env.PG_PORT = 'not-a-number';

      expect(() => loadConfig()).toThrow('port');
    });

    it('有效的数字环境变量应该正常解析', () => {
      process.env.LLM_API_KEY = 'test-key';
      process.env.LLM_TEMPERATURE = '0.5';
      process.env.PG_PORT = '5433';

      const config = loadConfig();
      expect(config.llm.defaultTemperature).toBe(0.5);
      expect(config.postgres.port).toBe(5433);
    });

    it('未设置的数字配置应该使用默认值', () => {
      process.env.LLM_API_KEY = 'test-key';

      const config = loadConfig();
      expect(config.llm.defaultTemperature).toBe(0.7);
      expect(config.postgres.port).toBe(5432);
    });
  });

  describe('布尔环境变量解析', () => {
    it('应该支持 "false" 关闭日志', () => {
      process.env.LLM_API_KEY = 'test-key';
      process.env.LOG_LLM_REQUESTS = 'false';

      const config = loadConfig();
      expect(config.observability.logLLMRequests).toBe(false);
    });

    it('应该支持 "0" 关闭日志', () => {
      process.env.LLM_API_KEY = 'test-key';
      process.env.LOG_LLM_REQUESTS = '0';

      const config = loadConfig();
      expect(config.observability.logLLMRequests).toBe(false);
    });

    it('应该支持 "no" 关闭日志', () => {
      process.env.LLM_API_KEY = 'test-key';
      process.env.LOG_LLM_REQUESTS = 'no';

      const config = loadConfig();
      expect(config.observability.logLLMRequests).toBe(false);
    });

    it('应该支持 "true" 开启日志', () => {
      process.env.LLM_API_KEY = 'test-key';
      process.env.LOG_LLM_REQUESTS = 'true';

      const config = loadConfig();
      expect(config.observability.logLLMRequests).toBe(true);
    });

    it('无效的布尔值应该报错', () => {
      process.env.LLM_API_KEY = 'test-key';
      process.env.LOG_LLM_REQUESTS = 'invalid';

      expect(() => loadConfig()).toThrow('logLLMRequests');
    });
  });

  describe('必填字段校验', () => {
    it('缺少 LLM_API_KEY 应该报错', () => {
      expect(() => loadConfig()).toThrow('apiKey');
    });

    it('空字符串的 LLM_API_KEY 应该报错', () => {
      process.env.LLM_API_KEY = '   ';
      expect(() => loadConfig()).toThrow('apiKey');
    });
  });

  describe('正常配置加载', () => {
    it('应该能加载完整配置并返回所有字段', () => {
      process.env.LLM_API_KEY = 'test-key';

      const config = loadConfig();
      expect(config.llm.provider).toBe('openai');
      expect(config.llm.model).toBe('gpt-4o');
      expect(config.postgres.host).toBe('localhost');
      expect(config.humanInteraction.weakConfirmationTimeoutMs).toBe(30000);
      expect(config.retry.llmMaxRetries).toBe(3);
      expect(config.coding.maxTestRetriesPerStory).toBe(5);
      expect(config.observability.logLevel).toBe('info');
    });
  });

  describe('zod schema 直接校验', () => {
    it('应该拒绝空 apiKey', () => {
      const result = forgeConfigSchema.safeParse({
        llm: { apiKey: '' },
      });
      expect(result.success).toBe(false);
    });

    it('应该接受完整有效配置', () => {
      const result = forgeConfigSchema.safeParse({
        llm: { apiKey: 'test-key' },
        postgres: {},
        figma: {},
        humanInteraction: {},
        retry: {},
        coding: {},
        observability: {},
      });
      expect(result.success).toBe(true);
    });
  });
});
