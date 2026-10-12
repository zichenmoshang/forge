import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  MockEmbeddingProvider,
  OpenAIEmbeddingProvider,
  createEmbeddingProvider,
} from '../../src/llm/embedding-provider';
import type { EmbeddingConfig } from '../../src/config/schema';

describe('EmbeddingProvider', () => {
  describe('MockEmbeddingProvider', () => {
    it('应该生成指定维度的向量', async () => {
      const provider = new MockEmbeddingProvider(1024);
      const result = await provider.embed({ input: ['测试文本'] });

      expect(result.embeddings).toHaveLength(1);
      expect(result.embeddings[0]).toHaveLength(1024);
    });

    it('相同输入应该生成相同向量（确定性）', async () => {
      const provider = new MockEmbeddingProvider(1024);
      const result1 = await provider.embed({ input: ['相同文本'] });
      const result2 = await provider.embed({ input: ['相同文本'] });

      expect(result1.embeddings[0]).toEqual(result2.embeddings[0]);
    });

    it('不同输入应该生成不同向量', async () => {
      const provider = new MockEmbeddingProvider(1024);
      const result1 = await provider.embed({ input: ['文本A'] });
      const result2 = await provider.embed({ input: ['文本B'] });

      expect(result1.embeddings[0]).not.toEqual(result2.embeddings[0]);
    });

    it('应该支持批量嵌入', async () => {
      const provider = new MockEmbeddingProvider(512);
      const result = await provider.embed({ input: ['文本1', '文本2', '文本3'] });

      expect(result.embeddings).toHaveLength(3);
      result.embeddings.forEach((emb) => expect(emb).toHaveLength(512));
    });

    it('向量应该是归一化的（L2 范数接近 1）', async () => {
      const provider = new MockEmbeddingProvider(1024);
      const result = await provider.embed({ input: ['归一化测试'] });
      const embedding = result.embeddings[0];
      const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
      expect(norm).toBeCloseTo(1, 3);
    });

    it('embedSync 应该返回正确维度', () => {
      const provider = new MockEmbeddingProvider(1024);
      const syncResult = provider.embedSync('同步测试');
      expect(syncResult).toHaveLength(1024);
    });
  });

  describe('OpenAIEmbeddingProvider', () => {
    const mockFetch = vi.fn();

    beforeEach(() => {
      mockFetch.mockReset();
      vi.stubGlobal('fetch', mockFetch);
    });

    it('应该调用正确的 API 端点并返回向量', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ embedding: [0.1, 0.2, 0.3] }],
          usage: { total_tokens: 10 },
          model: 'Doubao-embedding',
        }),
      });

      const config: EmbeddingConfig = {
        provider: 'openai',
        model: 'Doubao-embedding',
        dimensions: 3,
        apiKey: 'test-key',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      };
      const provider = new OpenAIEmbeddingProvider(config);
      const result = await provider.embed({ input: ['测试文本'] });

      expect(result.embeddings).toHaveLength(1);
      expect(result.embeddings[0]).toEqual([0.1, 0.2, 0.3]);
      expect(result.model).toBe('Doubao-embedding');
      expect(result.promptTokens).toBe(10);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://ark.cn-beijing.volces.com/api/v3/embeddings',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
        }),
      );
    });

    it('应该支持批量嵌入', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }],
          usage: { total_tokens: 20 },
        }),
      });

      const config: EmbeddingConfig = {
        provider: 'openai',
        model: 'test-model',
        dimensions: 2,
        apiKey: 'test-key',
        baseUrl: 'https://api.openai.com/v1',
      };
      const provider = new OpenAIEmbeddingProvider(config);
      const result = await provider.embed({ input: ['文本1', '文本2'] });

      expect(result.embeddings).toHaveLength(2);
      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.input).toEqual(['文本1', '文本2']);
    });

    it('API 错误时应该抛出异常', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

      const config: EmbeddingConfig = {
        provider: 'openai',
        model: 'test-model',
        dimensions: 2,
        apiKey: 'invalid-key',
        baseUrl: 'https://api.openai.com/v1',
      };
      const provider = new OpenAIEmbeddingProvider(config);

      await expect(provider.embed({ input: ['test'] })).rejects.toThrow(
        'OpenAI Embedding API 错误',
      );
    });
  });

  describe('createEmbeddingProvider 工厂', () => {
    it('provider=mock 应该返回 MockEmbeddingProvider', () => {
      const config: EmbeddingConfig = {
        provider: 'mock',
        model: 'mock',
        dimensions: 1024,
        apiKey: '',
        baseUrl: '',
      };
      const provider = createEmbeddingProvider(config);
      expect(provider).toBeInstanceOf(MockEmbeddingProvider);
    });

    it('provider=qwen 应该返回 QwenEmbeddingProvider', () => {
      const config: EmbeddingConfig = {
        provider: 'qwen',
        model: 'text-embedding-v3',
        dimensions: 1024,
        apiKey: 'test-key',
        baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
      };
      const provider = createEmbeddingProvider(config);
      expect(provider.name).toBe('qwen-embedding');
    });

    it('provider=openai 应该返回 OpenAIEmbeddingProvider', () => {
      const config: EmbeddingConfig = {
        provider: 'openai',
        model: 'Doubao-embedding',
        dimensions: 1024,
        apiKey: 'test-key',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      };
      const provider = createEmbeddingProvider(config);
      expect(provider).toBeInstanceOf(OpenAIEmbeddingProvider);
      expect(provider.name).toBe('openai-embedding');
    });

    it('未知 provider 应该抛出错误', () => {
      const config = {
        provider: 'unknown',
        model: 'test',
        dimensions: 1024,
        apiKey: '',
        baseUrl: '',
      } as EmbeddingConfig;
      expect(() => createEmbeddingProvider(config)).toThrow('不支持的 Embedding Provider');
    });
  });
});
