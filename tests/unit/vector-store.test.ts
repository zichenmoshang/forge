import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryVectorStore, cosineSimilarity } from '../../src/services/vector-store';
import type { KnowledgeItem } from '../../src/types/knowledge';

function createItem(overrides: Partial<KnowledgeItem> = {}): KnowledgeItem {
  return {
    id: `item-${Date.now()}-${Math.random()}`,
    type: 'api',
    title: '测试条目',
    content: '测试内容',
    summary: '测试摘要',
    source: 'code',
    sourceRef: '/path/to/file.ts',
    projectScope: 'global',
    weight: 0.9,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    usageCount: 0,
    ...overrides,
  };
}

describe('VectorStore', () => {
  describe('InMemoryVectorStore', () => {
    let store: InMemoryVectorStore;

    beforeEach(() => {
      store = new InMemoryVectorStore();
    });

    it('应该能插入和获取条目', async () => {
      const item = createItem({ id: 'test-1', title: 'API 1' });
      await store.upsert(item);

      const retrieved = await store.get('test-1');
      expect(retrieved).toBeDefined();
      expect(retrieved?.title).toBe('API 1');
    });

    it('应该能批量插入', async () => {
      const items = [
        createItem({ id: 'batch-1' }),
        createItem({ id: 'batch-2' }),
        createItem({ id: 'batch-3' }),
      ];
      await store.upsertMany(items);

      expect(await store.count()).toBe(3);
    });

    it('应该能删除条目', async () => {
      const item = createItem({ id: 'delete-me' });
      await store.upsert(item);
      expect(await store.get('delete-me')).toBeDefined();

      await store.delete('delete-me');
      expect(await store.get('delete-me')).toBeNull();
    });

    it('应该能清空所有数据', async () => {
      await store.upsert(createItem({ id: 'clear-1' }));
      await store.upsert(createItem({ id: 'clear-2' }));
      expect(await store.count()).toBe(2);

      await store.clear();
      expect(await store.count()).toBe(0);
    });

    it('应该按类型过滤', async () => {
      await store.upsert(createItem({ id: 'api-1', type: 'api', embedding: [1, 0, 0] }));
      await store.upsert(createItem({ id: 'comp-1', type: 'component', embedding: [0, 1, 0] }));

      const results = await store.search([1, 0, 0], { types: ['api'] });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('api-1');
    });

    it('应该按状态过滤（默认只查 active）', async () => {
      await store.upsert(createItem({ id: 'active-1', status: 'active', embedding: [1, 0, 0] }));
      await store.upsert(
        createItem({ id: 'deprecated-1', status: 'deprecated', embedding: [1, 0, 0] }),
      );

      const results = await store.search([1, 0, 0]);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('active-1');
    });

    it('includeDeprecated 应该返回所有状态', async () => {
      await store.upsert(createItem({ id: 'active-2', status: 'active', embedding: [1, 0, 0] }));
      await store.upsert(
        createItem({ id: 'deprecated-2', status: 'deprecated', embedding: [1, 0, 0] }),
      );

      const results = await store.search([1, 0, 0], { includeDeprecated: true });
      expect(results).toHaveLength(2);
    });

    it('应该按项目范围过滤（global 始终返回）', async () => {
      await store.upsert(
        createItem({ id: 'global-1', projectScope: 'global', embedding: [1, 0, 0] }),
      );
      await store.upsert(
        createItem({ id: 'project-a', projectScope: 'project-a', embedding: [1, 0, 0] }),
      );
      await store.upsert(
        createItem({ id: 'project-b', projectScope: 'project-b', embedding: [1, 0, 0] }),
      );

      const results = await store.search([1, 0, 0], { projectScope: 'project-a' });
      expect(results).toHaveLength(2); // global + project-a
      expect(results.map((r) => r.id)).toContain('global-1');
      expect(results.map((r) => r.id)).toContain('project-a');
    });

    it('应该按权重影响排序', async () => {
      await store.upsert(createItem({ id: 'low-weight', weight: 0.1, embedding: [1, 0, 0] }));
      await store.upsert(createItem({ id: 'high-weight', weight: 0.9, embedding: [1, 0, 0] }));

      const results = await store.search([1, 0, 0]);
      expect(results[0].id).toBe('high-weight');
      expect(results[1].id).toBe('low-weight');
    });

    it('应该限制返回数量', async () => {
      for (let i = 0; i < 10; i++) {
        await store.upsert(createItem({ id: `limit-${i}`, embedding: [1, 0, 0] }));
      }

      const results = await store.search([1, 0, 0], undefined, 3);
      expect(results).toHaveLength(3);
    });

    it('没有向量的条目不参与检索', async () => {
      await store.upsert(createItem({ id: 'no-embedding', embedding: undefined }));
      await store.upsert(createItem({ id: 'with-embedding', embedding: [1, 0, 0] }));

      const results = await store.search([1, 0, 0]);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('with-embedding');
    });

    it('getAll 应该返回所有匹配的条目', async () => {
      await store.upsert(createItem({ id: 'all-1', type: 'api' }));
      await store.upsert(createItem({ id: 'all-2', type: 'component' }));
      await store.upsert(createItem({ id: 'all-3', type: 'api', status: 'deprecated' }));

      const all = await store.getAll();
      expect(all).toHaveLength(3);

      const apis = await store.getAll({ types: ['api'], includeDeprecated: true });
      expect(apis).toHaveLength(2);
    });
  });

  describe('cosineSimilarity', () => {
    it('相同向量相似度为 1', () => {
      const a = [1, 0, 0];
      expect(cosineSimilarity(a, a)).toBeCloseTo(1, 5);
    });

    it('正交向量相似度为 0', () => {
      const a = [1, 0, 0];
      const b = [0, 1, 0];
      expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
    });

    it('相反向量相似度为 -1', () => {
      const a = [1, 0, 0];
      const b = [-1, 0, 0];
      expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 5);
    });

    it('长度不同的向量返回 0', () => {
      const a = [1, 0];
      const b = [1, 0, 0];
      expect(cosineSimilarity(a, b)).toBe(0);
    });

    it('零向量返回 0', () => {
      const a = [0, 0, 0];
      const b = [1, 0, 0];
      expect(cosineSimilarity(a, b)).toBe(0);
    });
  });
});
