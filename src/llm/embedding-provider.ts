/**
 * Embedding Provider（向量模型接入）
 *
 * 支持多模型切换，v1 默认使用通义 Qwen3-Embedding。
 * 测试时使用 MockEmbeddingProvider，不调用真实 API。
 */

import type { EmbeddingConfig } from '../config';

/** 向量模型请求 */
export interface EmbeddingRequest {
  input: string | string[];
  model?: string;
}

/** 向量模型响应 */
export interface EmbeddingResponse {
  embeddings: number[][];
  model: string;
  /** 输入 token 数（如果 API 返回） */
  promptTokens?: number;
  /** 耗时（毫秒） */
  durationMs: number;
}

/** 向量模型 Provider 接口 */
export interface EmbeddingProvider {
  readonly name: string;
  embed(request: EmbeddingRequest): Promise<EmbeddingResponse>;
}

/**
 * Mock Embedding Provider（用于测试和开发）
 *
 * 不调用真实 API，基于输入文本的哈希生成确定性的伪向量。
 * 相同的输入始终生成相同的向量，保证测试可复现。
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'mock-embedding';
  private dimensions: number;

  constructor(dimensions = 1024) {
    this.dimensions = dimensions;
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const startTime = Date.now();
    const inputs = Array.isArray(request.input) ? request.input : [request.input];

    const embeddings = inputs.map((text) => this.generatePseudoVector(text));

    return {
      embeddings,
      model: 'mock-embedding',
      promptTokens: inputs.reduce((sum, t) => sum + t.length, 0),
      durationMs: Date.now() - startTime,
    };
  }

  /** 同步生成单个文本的向量（用于测试数据准备） */
  embedSync(text: string): number[] {
    return this.generatePseudoVector(text);
  }

  /** 基于文本哈希生成确定性伪向量 */
  private generatePseudoVector(text: string): number[] {
    const vector: number[] = new Array(this.dimensions).fill(0);

    // 简单的哈希：每个字符影响多个维度
    for (let i = 0; i < text.length; i++) {
      const charCode = text.charCodeAt(i);
      const dim = charCode % this.dimensions;
      vector[dim] += Math.sin(charCode * (i + 1)) * 0.1;
    }

    // 归一化
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
    return vector.map((v) => v / norm);
  }
}

/**
 * 通义千问 Embedding Provider
 *
 * 调用阿里云 DashScope API，使用 text-embedding-v3 模型。
 * 文档：https://help.aliyun.com/zh/model-studio/developer-reference/text-embedding-api
 */
export class QwenEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'qwen-embedding';
  private config: EmbeddingConfig;

  constructor(config: EmbeddingConfig) {
    this.config = config;
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const startTime = Date.now();
    const inputs = Array.isArray(request.input) ? request.input : [request.input];
    const model = request.model || this.config.model;

    const baseUrl = this.config.baseUrl || 'https://dashscope.aliyuncs.com/api/v1';
    const url = `${baseUrl}/embeddings`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: { texts: inputs },
        parameters: { dimension: this.config.dimensions },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Qwen Embedding API 错误 (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as {
      output?: { embeddings?: Array<{ embedding: number[] }> };
      usage?: { total_tokens?: number };
    };
    const embeddings: number[][] = data.output?.embeddings?.map((item) => item.embedding) ?? [];

    return {
      embeddings,
      model,
      promptTokens: data.usage?.total_tokens,
      durationMs: Date.now() - startTime,
    };
  }
}

/**
 * Embedding Provider 工厂方法
 */
export function createEmbeddingProvider(config: EmbeddingConfig): EmbeddingProvider {
  switch (config.provider) {
    case 'qwen':
      return new QwenEmbeddingProvider(config);
    case 'mock':
      return new MockEmbeddingProvider(config.dimensions);
    default:
      throw new Error(`不支持的 Embedding Provider: ${config.provider}`);
  }
}
