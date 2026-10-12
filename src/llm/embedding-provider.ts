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
 * OpenAI 兼容 Embedding Provider
 *
 * 调用任何兼容 OpenAI Embedding API 的服务（火山引擎、OpenAI、本地部署等）。
 * 文档：https://platform.openai.com/docs/api-reference/embeddings
 *
 * 特殊支持：火山引擎 Doubao-embedding-vision 多模态模型只支持 /embeddings/multimodal API，
 * 当模型名包含 "vision" 时自动切换到多模态 API 格式。
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai-embedding';
  private config: EmbeddingConfig;

  constructor(config: EmbeddingConfig) {
    this.config = config;
  }

  /**
   * 判断是否为多模态向量化模型（如 doubao-embedding-vision）
   * 多模态模型只支持 /embeddings/multimodal API，不支持标准 /embeddings API
   */
  private isMultimodalModel(model: string): boolean {
    return model.toLowerCase().includes('vision');
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const startTime = Date.now();
    const inputs = Array.isArray(request.input) ? request.input : [request.input];
    const model = request.model || this.config.model;

    const baseUrl = this.config.baseUrl || 'https://api.openai.com/v1';
    const useMultimodal = this.isMultimodalModel(model);
    const url = useMultimodal ? `${baseUrl}/embeddings/multimodal` : `${baseUrl}/embeddings`;

    // 多模态 API 的 input 格式是对象数组，标准 API 是字符串数组
    const requestBody = useMultimodal
      ? {
          model,
          input: inputs.map((text) => ({ type: 'text', text })),
        }
      : {
          model,
          input: inputs,
        };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI Embedding API 错误 (${response.status}): ${errorText}`);
    }

    if (useMultimodal) {
      // 多模态 API 响应格式：data 是单个对象 { embedding, object }，不是数组
      const data = (await response.json()) as {
        data?: { embedding: number[]; object?: string };
        usage?: { prompt_tokens?: number; total_tokens?: number };
        model?: string;
      };
      const embedding = data.data?.embedding;
      const embeddings: number[][] = embedding ? [embedding] : [];

      return {
        embeddings,
        model: data.model || model,
        promptTokens: data.usage?.prompt_tokens ?? data.usage?.total_tokens,
        durationMs: Date.now() - startTime,
      };
    }

    // 标准 OpenAI 兼容 API 响应格式：data 是数组 [{ embedding, index, object }]
    const data = (await response.json()) as {
      data?: Array<{ embedding: number[] }>;
      usage?: { total_tokens?: number; prompt_tokens?: number };
      model?: string;
    };
    const embeddings: number[][] = data.data?.map((item) => item.embedding) ?? [];

    return {
      embeddings,
      model: data.model || model,
      promptTokens: data.usage?.total_tokens ?? data.usage?.prompt_tokens,
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
    case 'openai':
      return new OpenAIEmbeddingProvider(config);
    case 'mock':
      return new MockEmbeddingProvider(config.dimensions);
    default:
      throw new Error(`不支持的 Embedding Provider: ${config.provider}`);
  }
}
