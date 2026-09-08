import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAIProvider } from '../../src/llm/implementations/openai-provider';
import { createLLMProvider } from '../../src/llm/factory';
import type { LLMConfig } from '../../src/config';
import type { Logger } from '../../src/observability/logger';

// 使用 hoisted 定义 mock 函数，确保在 vi.mock 中可用
const { mockCreate } = vi.hoisted(() => {
  return { mockCreate: vi.fn() };
});

vi.mock('openai', () => {
  return {
    default: class {
      chat = {
        completions: {
          create: mockCreate,
        },
      };
    },
  };
});

const mockConfig: LLMConfig = {
  provider: 'openai',
  apiKey: 'test-key',
  baseUrl: '',
  model: 'gpt-4o',
  defaultTemperature: 0.7,
  defaultMaxTokens: 4096,
};

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    logLLMCall: vi.fn(),
  } as unknown as Logger;
}

function mockOpenAIResponse(content: string = 'Hello, world!') {
  return {
    choices: [
      {
        message: { content },
        finish_reason: 'stop',
      },
    ],
    model: 'gpt-4o',
    usage: {
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
    },
  };
}

describe('OpenAIProvider', () => {
  let provider: OpenAIProvider;
  let logger: Logger;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = createMockLogger();
    provider = new OpenAIProvider(mockConfig, { logger, maxRetries: 2, baseDelayMs: 10 });
  });

  it('应该能成功调用 LLM 并返回响应', async () => {
    mockCreate.mockResolvedValue(mockOpenAIResponse());

    const response = await provider.complete({
      prompt: '你好',
      systemPrompt: '你是助手',
      caller: 'test-agent',
      instanceId: 'inst-001',
    });

    expect(response.content).toBe('Hello, world!');
    expect(response.model).toBe('gpt-4o');
    expect(response.totalTokens).toBe(30);
    expect(response.promptTokens).toBe(10);
    expect(response.completionTokens).toBe(20);
    expect(response.durationMs).toBeGreaterThanOrEqual(0);
    expect(response.finishReason).toBe('stop');
  });

  it('应该构建正确的 messages（包含 system prompt）', async () => {
    mockCreate.mockResolvedValue(mockOpenAIResponse());

    await provider.complete({
      prompt: '用户问题',
      systemPrompt: '系统提示',
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: '系统提示' },
          { role: 'user', content: '用户问题' },
        ],
        temperature: 0.7,
        max_tokens: 4096,
      }),
    );
  });

  it('没有 systemPrompt 时应该只有 user 消息', async () => {
    mockCreate.mockResolvedValue(mockOpenAIResponse());

    await provider.complete({ prompt: '你好' });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: 'user', content: '你好' }],
      }),
    );
  });

  it('应该支持单次调用覆盖 model 参数', async () => {
    mockCreate.mockResolvedValue(mockOpenAIResponse());

    await provider.complete({ prompt: 'hi', model: 'gpt-3.5-turbo' });

    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-3.5-turbo' }));
  });

  it('应该记录 LLM 调用日志', async () => {
    mockCreate.mockResolvedValue(mockOpenAIResponse('测试响应'));

    await provider.complete({
      prompt: '测试请求',
      caller: 'test-agent',
      instanceId: 'inst-001',
    });

    expect(logger.logLLMCall).toHaveBeenCalledTimes(1);
    const logCall = (logger.logLLMCall as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(logCall.prompt).toBe('测试请求');
    expect(logCall.response).toBe('测试响应');
    expect(logCall.success).toBe(true);
    expect(logCall.provider).toBe('openai');
    expect(logCall.totalTokens).toBe(30);
  });

  it('失败后应该重试并最终成功', async () => {
    mockCreate
      .mockRejectedValueOnce(new Error('API Error'))
      .mockResolvedValueOnce(mockOpenAIResponse('重试成功'));

    const response = await provider.complete({ prompt: 'test' });

    expect(response.content).toBe('重试成功');
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('重试耗尽后应该抛出错误', async () => {
    mockCreate.mockRejectedValue(new Error('持续失败'));

    await expect(provider.complete({ prompt: 'test' })).rejects.toThrow('持续失败');
    expect(mockCreate).toHaveBeenCalledTimes(3); // 1次初始 + 2次重试
  });

  it('重试耗尽后应该记录失败的 LLM 调用', async () => {
    mockCreate.mockRejectedValue(new Error('持续失败'));

    try {
      await provider.complete({ prompt: 'test', instanceId: 'inst-002' });
    } catch {
      // 预期失败
    }

    expect(logger.logLLMCall).toHaveBeenCalledTimes(1);
    const logCall = (logger.logLLMCall as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(logCall.success).toBe(false);
    expect(logCall.error).toBe('持续失败');
  });

  it('provider name 应该是 openai', () => {
    expect(provider.name).toBe('openai');
  });
});

describe('createLLMProvider 工厂', () => {
  it('应该能创建 OpenAI provider', () => {
    const provider = createLLMProvider(mockConfig);
    expect(provider).toBeInstanceOf(OpenAIProvider);
    expect(provider.name).toBe('openai');
  });

  it('应该能传入 logger 选项', () => {
    const logger = createMockLogger();
    const provider = createLLMProvider(mockConfig, { logger });
    expect(provider).toBeInstanceOf(OpenAIProvider);
  });

  it('不支持的 provider 应该抛出错误', () => {
    expect(() =>
      createLLMProvider({ ...mockConfig, provider: 'anthropic' as LLMConfig['provider'] }),
    ).toThrow('尚未实现');
  });
});
