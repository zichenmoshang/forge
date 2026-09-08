import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BaseAgent } from '../../src/agents/base';
import type { AgentContext, AgentError } from '../../src/agents/types';
import type { LLMProvider, LLMRequest, LLMResponse } from '../../src/llm/provider';
import type { Logger } from '../../src/observability/logger';

// Mock LLM Provider
function createMockLLM(response: Partial<LLMResponse> = {}): LLMProvider {
  return {
    name: 'mock-llm',
    complete: vi.fn().mockResolvedValue({
      content: '{"result": "ok"}',
      model: 'mock-model',
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
      durationMs: 100,
      finishReason: 'stop',
      ...response,
    }),
  };
}

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    logLLMCall: vi.fn(),
  } as unknown as Logger;
}

interface MockInput {
  value: string;
}

interface MockOutput {
  result: string;
}

/** 测试用 MockAgent */
class MockAgent extends BaseAgent<MockInput, MockOutput> {
  readonly name = 'mock-agent';
  readonly version = '1.0.0';

  validateInputFn = vi.fn((): AgentError[] => []);
  buildSystemPromptFn = vi.fn((): string => 'You are a mock agent.');
  buildUserPromptFn = vi.fn(async (input: MockInput): Promise<string> => `Input: ${input.value}`);
  parseOutputFn = vi.fn((content: string): MockOutput => JSON.parse(content));
  validateOutputFn = vi.fn((): AgentError[] => []);
  selfCheckFn = vi.fn((): AgentError[] => []);

  protected validateInput(input: MockInput): AgentError[] {
    return this.validateInputFn(input);
  }
  protected buildSystemPrompt(input: MockInput): string {
    return this.buildSystemPromptFn(input);
  }
  protected async buildUserPrompt(input: MockInput): Promise<string> {
    return this.buildUserPromptFn(input);
  }
  protected parseOutput(content: string): MockOutput {
    return this.parseOutputFn(content);
  }
  protected validateOutput(output: MockOutput): AgentError[] {
    return this.validateOutputFn(output);
  }
  protected selfCheck(output: MockOutput): AgentError[] {
    return this.selfCheckFn(output);
  }

  /** 暴露 protected searchKnowledge 供测试 */
  async runSearch(
    context: AgentContext,
    queries: Array<{ query: string; types?: never[]; topK?: number }>,
  ) {
    return this.searchKnowledge(context, queries as Parameters<typeof this.searchKnowledge>[1]);
  }
}

function createContext(input: MockInput = { value: 'test' }): AgentContext {
  return {
    instanceId: 'test-instance',
    traceId: 'trace-001',
    stage: 'test',
    input,
  };
}

describe('BaseAgent', () => {
  let llm: LLMProvider;
  let logger: Logger;
  let agent: MockAgent;

  beforeEach(() => {
    vi.clearAllMocks();
    llm = createMockLLM();
    logger = createMockLogger();
    agent = new MockAgent(llm, { logger, config: { maxRetries: 2, retryBaseDelayMs: 10 } });
  });

  describe('正常执行流程', () => {
    it('应该成功执行完整流程并返回结果', async () => {
      const result = await agent.execute(createContext());

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ result: 'ok' });
      expect(result.errors).toHaveLength(0);
      expect(result.llmCalls).toBe(1);
      expect(result.retries).toBe(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('应该按顺序调用所有钩子方法', async () => {
      await agent.execute(createContext());

      expect(agent.validateInputFn).toHaveBeenCalledTimes(1);
      expect(agent.buildSystemPromptFn).toHaveBeenCalledTimes(1);
      expect(agent.buildUserPromptFn).toHaveBeenCalledTimes(1);
      expect(agent.parseOutputFn).toHaveBeenCalledTimes(1);
      expect(agent.validateOutputFn).toHaveBeenCalledTimes(1);
      expect(agent.selfCheckFn).toHaveBeenCalledTimes(1);
      expect(llm.complete).toHaveBeenCalledTimes(1);
    });

    it('应该将正确的参数传给 LLM', async () => {
      await agent.execute(createContext({ value: 'hello' }));

      const call = (llm.complete as ReturnType<typeof vi.fn>).mock.calls[0][0] as LLMRequest;
      expect(call.systemPrompt).toBe('You are a mock agent.');
      expect(call.prompt).toBe('Input: hello');
      expect(call.caller).toBe('mock-agent');
      expect(call.instanceId).toBe('test-instance');
      expect(call.traceId).toBe('trace-001');
    });

    it('应该记录开始和结束日志', async () => {
      await agent.execute(createContext());

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('开始执行'),
        expect.any(Object),
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('执行成功'),
        expect.any(Object),
      );
    });
  });

  describe('输入校验', () => {
    it('输入校验失败时应该直接返回错误，不调用 LLM', async () => {
      agent.validateInputFn.mockReturnValue([
        { code: 'INVALID_INPUT', message: '输入不能为空', severity: 'error' },
      ]);

      const result = await agent.execute(createContext({ value: '' }));

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe('INVALID_INPUT');
      expect(llm.complete).not.toHaveBeenCalled();
      expect(result.llmCalls).toBe(0);
    });

    it('输入校验只有 warning 时应该继续执行', async () => {
      agent.validateInputFn.mockReturnValue([
        { code: 'WARNING', message: '警告', severity: 'warning' },
      ]);

      const result = await agent.execute(createContext());
      expect(result.success).toBe(true);
      expect(llm.complete).toHaveBeenCalledTimes(1);
    });
  });

  describe('输出解析与重试', () => {
    it('解析失败时应该重试，最终成功', async () => {
      agent.parseOutputFn
        .mockImplementationOnce(() => {
          throw new Error('JSON 解析失败');
        })
        .mockImplementationOnce((content: string) => JSON.parse(content));

      const result = await agent.execute(createContext());

      expect(result.success).toBe(true);
      expect(result.llmCalls).toBe(2);
      expect(result.retries).toBe(1);
      expect(agent.parseOutputFn).toHaveBeenCalledTimes(2);
    });

    it('解析失败重试耗尽后应该返回失败', async () => {
      agent.parseOutputFn.mockImplementation(() => {
        throw new Error('持续解析失败');
      });

      const result = await agent.execute(createContext());

      expect(result.success).toBe(false);
      expect(result.llmCalls).toBe(3); // 1次初始 + 2次重试
      expect(result.retries).toBe(2);
      expect(result.errors[0].code).toBe('PARSE_ERROR');
    });
  });

  describe('输出校验与重试', () => {
    it('校验失败时应该重试，最终成功', async () => {
      agent.validateOutputFn
        .mockReturnValueOnce([{ code: 'INVALID', message: '格式不对', severity: 'error' }])
        .mockReturnValueOnce([]);

      const result = await agent.execute(createContext());

      expect(result.success).toBe(true);
      expect(result.llmCalls).toBe(2);
      expect(result.retries).toBe(1);
    });

    it('校验失败重试耗尽后应该返回失败', async () => {
      agent.validateOutputFn.mockReturnValue([
        { code: 'INVALID', message: '持续校验失败', severity: 'error' },
      ]);

      const result = await agent.execute(createContext());

      expect(result.success).toBe(false);
      expect(result.llmCalls).toBe(3);
      expect(result.errors[0].code).toBe('INVALID');
    });
  });

  describe('质量自检', () => {
    it('自检返回 warning 不应该阻塞执行', async () => {
      agent.selfCheckFn.mockReturnValue([
        { code: 'QUALITY_WARN', message: '质量警告', severity: 'warning' },
      ]);

      const result = await agent.execute(createContext());

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].severity).toBe('warning');
    });

    it('自检返回 error 应该记录在 errors 中（但不重试）', async () => {
      agent.selfCheckFn.mockReturnValue([
        { code: 'QUALITY_ERROR', message: '质量错误', severity: 'error' },
      ]);

      const result = await agent.execute(createContext());

      // selfCheck 的 error 目前只记录不重试（设计决策：自检问题不重试，直接返回）
      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(1);
      expect(result.llmCalls).toBe(1);
    });
  });

  describe('异常处理', () => {
    it('LLM 调用异常时应该捕获并返回失败', async () => {
      (llm.complete as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('API 调用失败'));

      const result = await agent.execute(createContext());

      expect(result.success).toBe(false);
      expect(result.errors[0].code).toBe('EXECUTION_ERROR');
      expect(result.errors[0].message).toContain('API 调用失败');
    });

    it('buildUserPrompt 异常时应该捕获并返回失败', async () => {
      agent.buildUserPromptFn.mockRejectedValueOnce(new Error('构建 prompt 失败'));

      const result = await agent.execute(createContext());

      expect(result.success).toBe(false);
      expect(result.errors[0].code).toBe('EXECUTION_ERROR');
    });
  });

  describe('配置', () => {
    it('应该使用自定义配置', async () => {
      const customAgent = new MockAgent(llm, {
        logger,
        config: { maxRetries: 0, temperature: 0.5, maxTokens: 2048 },
      });

      await customAgent.execute(createContext());

      const call = (llm.complete as ReturnType<typeof vi.fn>).mock.calls[0][0] as LLMRequest;
      expect(call.temperature).toBe(0.5);
      expect(call.maxTokens).toBe(2048);
    });

    it('maxRetries=0 时解析失败不重试', async () => {
      const customAgent = new MockAgent(llm, {
        logger,
        config: { maxRetries: 0, retryBaseDelayMs: 10 },
      });
      customAgent.parseOutputFn.mockImplementation(() => {
        throw new Error('失败');
      });

      const result = await customAgent.execute(createContext());
      expect(result.success).toBe(false);
      expect(result.llmCalls).toBe(1);
      expect(result.retries).toBe(0);
    });
  });

  describe('searchKnowledge 知识库多路检索（ADR-014）', () => {
    function createKnowledgeItem(id: string, type = 'api' as never) {
      return {
        id,
        type,
        title: `知识-${id}`,
        content: 'content',
        summary: 'summary',
        source: 'code' as const,
        sourceRef: `/src/${id}.ts`,
        projectScope: 'global',
        weight: 1,
        status: 'active' as const,
      };
    }

    function createMockKnowledgeService(resultsByQuery: Record<string, unknown[]>) {
      const search = vi.fn(async (query: string) => resultsByQuery[query] ?? []);
      return { search } as unknown as AgentContext['knowledgeService'];
    }

    it('未注入 knowledgeService 时降级返回 context.knowledge', async () => {
      const ctx = createContext();
      const result = await agent.runSearch(ctx, [{ query: '登录 API' }]);
      expect(result).toEqual([]);
    });

    it('多路查询并行检索并按 id 去重', async () => {
      const shared = createKnowledgeItem('shared', 'component' as never);
      const service = createMockKnowledgeService({
        '登录 API': [createKnowledgeItem('a'), shared],
        '登录 组件': [shared, createKnowledgeItem('b', 'component' as never)],
      });
      const ctx: AgentContext = { ...createContext(), knowledgeService: service };

      const result = await agent.runSearch(ctx, [{ query: '登录 API' }, { query: '登录 组件' }]);

      const ids = result.map((item) => item.id);
      expect(ids).toEqual(['a', 'shared', 'b']); // 去重且保持首次出现顺序
    });

    it('有 projectId 时检索带 projectScope 过滤', async () => {
      const search = vi.fn(async () => [createKnowledgeItem('a')]);
      const service = { search } as unknown as AgentContext['knowledgeService'];
      const ctx: AgentContext = {
        ...createContext(),
        knowledgeService: service,
        projectId: 'proj-1',
      };

      await agent.runSearch(ctx, [{ query: 'q' }]);

      expect(search).toHaveBeenCalledWith('q', { projectScope: 'proj-1' }, 5);
    });

    it('空查询列表直接返回 context.knowledge', async () => {
      const service = createMockKnowledgeService({});
      const ctx: AgentContext = {
        ...createContext(),
        knowledgeService: service,
        knowledge: [createKnowledgeItem('preset')],
      };
      const result = await agent.runSearch(ctx, []);
      expect(result.map((item) => item.id)).toEqual(['preset']);
    });
  });
});
