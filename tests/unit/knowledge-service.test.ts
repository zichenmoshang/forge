import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { KnowledgeService } from '../../src/services/knowledge-service';
import { InMemoryVectorStore } from '../../src/services/vector-store';
import { MockEmbeddingProvider } from '../../src/llm/embedding-provider';
import { ASTParser } from '../../src/services/ast-parser';
import type { KnowledgeItem } from '../../src/types/knowledge';

/** 测试用：访问 KnowledgeService 的私有属性 */
type KnowledgeServiceInternal = KnowledgeService & {
  vectorStore: InMemoryVectorStore;
};

function createService(): KnowledgeService {
  KnowledgeService.resetInstance();
  const vectorStore = new InMemoryVectorStore();
  const embeddingProvider = new MockEmbeddingProvider(1024);
  const astParser = new ASTParser();
  return KnowledgeService.getInstance({ vectorStore, embeddingProvider, astParser });
}

function createItem(overrides: Partial<KnowledgeItem> = {}): KnowledgeItem {
  return {
    id: `item-${Date.now()}-${Math.random()}`,
    type: 'api',
    title: '测试 API',
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

describe('KnowledgeService', () => {
  let service: KnowledgeService;

  beforeEach(() => {
    service = createService();
  });

  describe('单例模式', () => {
    it('getInstance 应该返回同一个实例', () => {
      const instance1 = KnowledgeService.getInstance();
      const instance2 = KnowledgeService.getInstance();
      expect(instance1).toBe(instance2);
    });

    it('resetInstance 后应该创建新实例', () => {
      const instance1 = KnowledgeService.getInstance();
      KnowledgeService.resetInstance();
      const instance2 = KnowledgeService.getInstance({
        vectorStore: new InMemoryVectorStore(),
        embeddingProvider: new MockEmbeddingProvider(1024),
        astParser: new ASTParser(),
      });
      expect(instance1).not.toBe(instance2);
    });
  });

  describe('search', () => {
    it('应该返回相关知识条目', async () => {
      // 直接通过 vectorStore 插入，控制 embedding
      const store = (service as KnowledgeServiceInternal).vectorStore as InMemoryVectorStore;
      const item = createItem({
        id: 'search-test-1',
        title: '用户登录 API',
        content: 'POST /api/auth/login，用于用户登录',
        summary: '用户登录 API 接口',
        embedding: new MockEmbeddingProvider(1024).embedSync('用户登录'),
      });
      await store.upsert(item);

      const results = await service.search('用户登录');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].id).toBe('search-test-1');
      expect(results[0].relevanceScore).toBeGreaterThan(0);
    });

    it('应该支持类型过滤', async () => {
      await service.indexDocument(
        createItem({
          id: 'filter-api',
          type: 'api',
          title: 'API 条目',
          embedding: [1, 0, 0],
        }),
      );
      await service.indexDocument(
        createItem({
          id: 'filter-component',
          type: 'component',
          title: '组件条目',
          embedding: [1, 0, 0],
        }),
      );

      const results = await service.search('test', { types: ['api'] });
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('api');
    });

    it('应该支持项目范围过滤', async () => {
      await service.indexDocument(
        createItem({
          id: 'scope-global',
          projectScope: 'global',
          embedding: [1, 0, 0],
        }),
      );
      await service.indexDocument(
        createItem({
          id: 'scope-a',
          projectScope: 'project-a',
          embedding: [1, 0, 0],
        }),
      );

      const results = await service.search('test', { projectScope: 'project-a' });
      expect(results).toHaveLength(2); // global + project-a
    });

    it('应该限制返回数量', async () => {
      for (let i = 0; i < 5; i++) {
        await service.indexDocument(
          createItem({
            id: `limit-${i}`,
            embedding: [1, 0, 0],
          }),
        );
      }

      const results = await service.search('test', undefined, 2);
      expect(results).toHaveLength(2);
    });
  });

  describe('indexDocument', () => {
    it('应该能入库知识文档', async () => {
      const item = createItem({ title: '技术规范文档' });
      const result = await service.indexDocument(item);

      expect(result.success).toBe(true);
      expect(result.id).toBeDefined();

      const status = await service.getStatus();
      expect(status.totalItems).toBe(1);
    });

    it('应该自动生成 embedding（如果未提供）', async () => {
      const item = createItem({ id: 'doc-no-embedding', embedding: undefined });
      const result = await service.indexDocument(item);

      expect(result.success).toBe(true);
      const retrieved = await service.search('测试');
      expect(retrieved[0].embedding).toBeDefined();
    });
  });

  describe('indexCode', () => {
    it('应该能索引代码文件', async () => {
      // 创建临时代码文件
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-'));
      const codeFile = path.join(tmpDir, 'api.ts');
      fs.writeFileSync(
        codeFile,
        `
        import request from './request';
        export const getUser = request.get('/api/user');
        export const createUser = request.post('/api/user');
      `,
      );

      const result = await service.indexCode(tmpDir, 'test-project');
      expect(result.total).toBeGreaterThan(0);
      expect(result.success).toBeGreaterThan(0);

      // 清理
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('getStatus', () => {
    it('应该返回正确的统计信息', async () => {
      // 直接通过 vectorStore 插入，测试状态统计
      const store = (service as KnowledgeServiceInternal).vectorStore as InMemoryVectorStore;
      await store.upsert(createItem({ id: 'status-1', type: 'api', status: 'active' }));
      await store.upsert(createItem({ id: 'status-2', type: 'component', status: 'active' }));
      await store.upsert(createItem({ id: 'status-3', type: 'api', status: 'deprecated' }));

      const status = await service.getStatus();
      expect(status.totalItems).toBe(3);
      expect(status.activeCount).toBe(2);
      expect(status.deprecatedCount).toBe(1);
      expect(status.byType.api).toBe(2);
      expect(status.byType.component).toBe(1);
    });

    it('空知识库应该返回零统计', async () => {
      const status = await service.getStatus();
      expect(status.totalItems).toBe(0);
      expect(status.activeCount).toBe(0);
    });
  });

  describe('updateWeight', () => {
    it('应该能更新条目的权重', async () => {
      const store = (service as KnowledgeServiceInternal).vectorStore as InMemoryVectorStore;
      await store.upsert(createItem({ id: 'weight-1', weight: 0.5 }));

      const result = await service.updateWeight('weight-1', 0.2);
      expect(result).toBe(true);

      const updated = await store.get('weight-1');
      expect(updated?.weight).toBeCloseTo(0.7, 5);
    });

    it('不存在的条目应该返回 false', async () => {
      const result = await service.updateWeight('non-existent', 0.9);
      expect(result).toBe(false);
    });
  });

  describe('rebuild', () => {
    it('应该清空并重建知识库', async () => {
      await service.indexDocument(createItem({ id: 'rebuild-old' }));
      expect((await service.getStatus()).totalItems).toBe(1);

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-rebuild-'));
      const codeFile = path.join(tmpDir, 'api.ts');
      fs.writeFileSync(
        codeFile,
        `
        import request from './request';
        export const newApi = request.get('/api/new');
      `,
      );

      const result = await service.rebuild([tmpDir]);
      expect(result.total).toBeGreaterThan(0);

      const status = await service.getStatus();
      expect(status.totalItems).toBe(result.success);
      // 旧条目应该被清空
      const oldItem = await service.search('rebuild-old');
      expect(oldItem.find((i) => i.id === 'rebuild-old')).toBeUndefined();

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('多仓库 rebuild 时各自携带 projectScope，不全部落到 global（#3）', async () => {
      const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-rebuild-a-'));
      const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-rebuild-b-'));
      fs.writeFileSync(
        path.join(dirA, 'a.ts'),
        `import request from './request'; export const apiA = request.get('/api/a');`,
      );
      fs.writeFileSync(
        path.join(dirB, 'b.ts'),
        `import request from './request'; export const apiB = request.get('/api/b');`,
      );

      await service.rebuild([
        { path: dirA, projectScope: 'project-a' },
        { path: dirB, projectScope: 'project-b' },
      ]);

      const store = (service as KnowledgeServiceInternal).vectorStore as InMemoryVectorStore;
      const all = await store.getAll({ includeDeprecated: true });
      const scopes = new Set(all.map((i) => i.projectScope));
      expect(scopes.has('project-a')).toBe(true);
      expect(scopes.has('project-b')).toBe(true);
      expect(scopes.has('global')).toBe(false);

      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    });

    it('字符串路径入参向后兼容，默认 global', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-rebuild-str-'));
      fs.writeFileSync(
        path.join(dir, 'c.ts'),
        `import request from './request'; export const apiC = request.get('/api/c');`,
      );
      await service.rebuild([dir]);
      const store = (service as KnowledgeServiceInternal).vectorStore as InMemoryVectorStore;
      const all = await store.getAll({ includeDeprecated: true });
      expect(all.every((i) => i.projectScope === 'global')).toBe(true);
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('syncIncremental', () => {
    it('新增/修改条目透传 change.projectScope，不错误落到 global（#3）', async () => {
      await service.syncIncremental([
        {
          path: '/repo-x/user.ts',
          action: 'added',
          projectScope: 'project-x',
          content: `import request from './request'; export const userApi = request.get('/api/user');`,
        },
      ]);

      const store = (service as KnowledgeServiceInternal).vectorStore as InMemoryVectorStore;
      const all = await store.getAll({ includeDeprecated: true });
      expect(all.length).toBeGreaterThan(0);
      expect(all.every((i) => i.projectScope === 'project-x')).toBe(true);
    });
  });
});
