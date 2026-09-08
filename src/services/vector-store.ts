/**
 * VectorStore（向量存储）
 *
 * v1 使用内存版 InMemoryVectorStore，用于开发和测试。
 * 预留 PgVectorStore 接口，后续有 PostgreSQL 时实现。
 *
 * 知识库向量和代码索引向量共用 VectorStore 接口，分表/分集合存储。
 */

import type { KnowledgeItem, KnowledgeFilter } from '../types/knowledge';

/** 向量存储接口 */
export interface VectorStore {
  /** 插入或更新知识条目（含向量） */
  upsert(item: KnowledgeItem): Promise<void>;

  /** 批量插入或更新 */
  upsertMany(items: KnowledgeItem[]): Promise<void>;

  /** 根据 ID 删除 */
  delete(id: string): Promise<void>;

  /** 根据 ID 获取 */
  get(id: string): Promise<KnowledgeItem | null>;

  /**
   * 向量检索
   * @param queryEmbedding 查询向量
   * @param filter 元数据过滤器
   * @param topK 返回数量
   */
  search(
    queryEmbedding: number[],
    filter?: KnowledgeFilter,
    topK?: number,
  ): Promise<KnowledgeItem[]>;

  /** 获取所有条目（用于状态统计） */
  getAll(filter?: KnowledgeFilter): Promise<KnowledgeItem[]>;

  /** 清空所有数据 */
  clear(): Promise<void>;

  /** 条目总数 */
  count(): Promise<number>;
}

/**
 * 内存版 VectorStore
 *
 * 使用数组存储，检索时计算余弦相似度。
 * 适用于开发、测试和小规模知识库（< 10000 条）。
 */
export class InMemoryVectorStore implements VectorStore {
  private items: Map<string, KnowledgeItem> = new Map();

  async upsert(item: KnowledgeItem): Promise<void> {
    this.items.set(item.id, item);
  }

  async upsertMany(items: KnowledgeItem[]): Promise<void> {
    for (const item of items) {
      this.items.set(item.id, item);
    }
  }

  async delete(id: string): Promise<void> {
    this.items.delete(id);
  }

  async get(id: string): Promise<KnowledgeItem | null> {
    return this.items.get(id) ?? null;
  }

  async search(
    queryEmbedding: number[],
    filter?: KnowledgeFilter,
    topK = 10,
  ): Promise<KnowledgeItem[]> {
    const allItems = Array.from(this.items.values());

    // 元数据过滤
    const filtered = allItems.filter((item) => this.matchesFilter(item, filter));

    // 计算余弦相似度
    const scored = filtered
      .map((item) => {
        if (!item.embedding) return null;
        const similarity = cosineSimilarity(queryEmbedding, item.embedding);
        const result: KnowledgeItem = {
          ...item,
          relevanceScore: similarity * (item.weight || 1), // 权重影响排序
        };
        return result;
      })
      .filter((item): item is KnowledgeItem => item !== null);

    // 按相似度降序排序
    scored.sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0));

    return scored.slice(0, topK);
  }

  async getAll(filter?: KnowledgeFilter): Promise<KnowledgeItem[]> {
    const allItems = Array.from(this.items.values());
    if (!filter) return allItems;
    return allItems.filter((item) => this.matchesFilter(item, filter));
  }

  async clear(): Promise<void> {
    this.items.clear();
  }

  async count(): Promise<number> {
    return this.items.size;
  }

  /** 检查条目是否匹配过滤器 */
  private matchesFilter(item: KnowledgeItem, filter?: KnowledgeFilter): boolean {
    // 默认只查 active（即使没有传 filter）
    const includeDeprecated = filter?.includeDeprecated ?? false;
    if (!includeDeprecated && item.status !== 'active') return false;

    if (!filter) return true;

    if (filter.types && !filter.types.includes(item.type)) return false;
    if (filter.sources && !filter.sources.includes(item.source)) return false;
    if (
      filter.projectScope &&
      item.projectScope !== filter.projectScope &&
      item.projectScope !== 'global'
    ) {
      return false;
    }
    if (filter.techStack && item.techStack !== filter.techStack) return false;
    if (filter.businessDomain && item.businessDomain !== filter.businessDomain) return false;
    if (filter.minWeight && item.weight < filter.minWeight) return false;

    return true;
  }
}

/**
 * 余弦相似度计算
 * 两个向量的点积 / (向量A的模 * 向量B的模)
 * 结果范围 [-1, 1]，1 表示完全相同
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  if (magnitude === 0) return 0;

  return dotProduct / magnitude;
}
