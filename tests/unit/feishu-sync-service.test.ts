/**
 * FeishuSyncService（飞书文档同步服务）单元测试
 *
 * 使用 mock FeishuClient 和 KnowledgeService。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeishuSyncService } from '../../src/integrations/feishu/feishu-sync-service';
import type { FeishuClient, WikiNode, DocumentContent } from '../../src/integrations/feishu';
import type { KnowledgeService } from '../../src/services/knowledge-service';
import type { KnowledgeDocument } from '../../src/types/knowledge';

// Mock FeishuClient
const mockListWikiNodes = vi.fn();
const mockGetDocumentContent = vi.fn();
const mockFeishuClient = {
  listWikiNodes: mockListWikiNodes,
  getDocumentContent: mockGetDocumentContent,
} as unknown as FeishuClient;

// Mock KnowledgeService
const mockIndexDocument = vi.fn();
const mockKnowledgeService = {
  indexDocument: mockIndexDocument,
} as unknown as KnowledgeService;

function createSyncService(): FeishuSyncService {
  return new FeishuSyncService({
    client: mockFeishuClient,
    knowledgeService: mockKnowledgeService,
    projectScope: 'global',
    chunkConfig: { maxChars: 1000, overlapChars: 100, minChars: 50 },
  });
}

function createWikiNode(partial: Partial<WikiNode> = {}): WikiNode {
  return {
    nodeToken: 'node-1',
    objToken: 'doc-1',
    objType: 'docx',
    title: '测试文档',
    hasChild: false,
    ...partial,
  };
}

describe('FeishuSyncService', () => {
  beforeEach(() => {
    mockListWikiNodes.mockClear();
    mockGetDocumentContent.mockClear();
    mockIndexDocument.mockClear();
  });

  describe('syncSpace', () => {
    it('成功同步单个文档', async () => {
      const service = createSyncService();

      const nodes: WikiNode[] = [
        createWikiNode({ nodeToken: 'node-1', objToken: 'doc-1', title: '文档一' }),
      ];

      mockListWikiNodes.mockResolvedValueOnce(nodes);
      mockGetDocumentContent.mockResolvedValueOnce({
        documentId: 'doc-1',
        title: '文档一',
        content: '这是文档一的内容。',
      } as DocumentContent);
      mockIndexDocument.mockResolvedValueOnce({ success: true, id: 'chunk-0' });

      const result = await service.syncSpace('space-1');

      expect(result.totalNodes).toBe(1);
      expect(result.totalDocuments).toBe(1);
      expect(result.successChunks).toBe(1);
      expect(result.failedDocuments).toBe(0);
      expect(result.skippedNodes).toBe(0);
      expect(result.errors).toEqual([]);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);

      // 验证调用
      expect(mockListWikiNodes).toHaveBeenCalledWith('space-1');
      expect(mockGetDocumentContent).toHaveBeenCalledWith('doc-1', 'docx');
      expect(mockIndexDocument).toHaveBeenCalledTimes(1);

      // 验证入库的文档内容
      const indexedDoc = mockIndexDocument.mock.calls[0][0] as KnowledgeDocument;
      expect(indexedDoc.type).toBe('doc');
      expect(indexedDoc.source).toBe('feishu');
      expect(indexedDoc.projectScope).toBe('global');
      expect(indexedDoc.content).toContain('这是文档一的内容');
    });

    it('跳过非文档节点（Folder/Sheet 等）', async () => {
      const service = createSyncService();

      const nodes: WikiNode[] = [
        createWikiNode({
          nodeToken: 'folder-1',
          objToken: 'folder-1',
          objType: 'folder',
          title: '文件夹',
        }),
        createWikiNode({ nodeToken: 'doc-1', objToken: 'doc-1', objType: 'docx', title: '文档' }),
        createWikiNode({ nodeToken: 'sheet-1', objToken: 'sheet-1', objType: 'sheet', title: '表格' }),
      ];

      mockListWikiNodes.mockResolvedValueOnce(nodes);
      mockGetDocumentContent.mockResolvedValueOnce({
        documentId: 'doc-1',
        title: '文档',
        content: '内容',
      } as DocumentContent);
      mockIndexDocument.mockResolvedValueOnce({ success: true, id: 'chunk-0' });

      const result = await service.syncSpace('space-1');

      expect(result.totalNodes).toBe(3);
      expect(result.totalDocuments).toBe(1);
      expect(result.skippedNodes).toBe(2);
      expect(mockGetDocumentContent).toHaveBeenCalledTimes(1);
    });

    it('文档获取失败时记录错误', async () => {
      const service = createSyncService();

      const nodes: WikiNode[] = [createWikiNode({ objToken: 'doc-1', title: '失败文档' })];

      mockListWikiNodes.mockResolvedValueOnce(nodes);
      mockGetDocumentContent.mockRejectedValueOnce(new Error('API 调用失败'));

      const result = await service.syncSpace('space-1');

      expect(result.totalDocuments).toBe(1);
      expect(result.failedDocuments).toBe(1);
      expect(result.successChunks).toBe(0);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].documentId).toBe('doc-1');
      expect(result.errors[0].title).toBe('失败文档');
      expect(result.errors[0].error).toContain('API 调用失败');
    });

    it('空文档不产生块但不算失败', async () => {
      const service = createSyncService();

      const nodes: WikiNode[] = [createWikiNode({ objToken: 'doc-empty', title: '空文档' })];

      mockListWikiNodes.mockResolvedValueOnce(nodes);
      mockGetDocumentContent.mockResolvedValueOnce({
        documentId: 'doc-empty',
        title: '空文档',
        content: '',
      } as DocumentContent);

      const result = await service.syncSpace('space-1');

      expect(result.totalDocuments).toBe(1);
      expect(result.failedDocuments).toBe(0);
      expect(result.successChunks).toBe(0);
      expect(mockIndexDocument).not.toHaveBeenCalled();
    });

    it('长文档分块后多次入库', async () => {
      const service = new FeishuSyncService({
        client: mockFeishuClient,
        knowledgeService: mockKnowledgeService,
        projectScope: 'global',
        chunkConfig: { maxChars: 50, overlapChars: 10, minChars: 5 },
      });

      const nodes: WikiNode[] = [createWikiNode({ objToken: 'doc-long', title: '长文档' })];

      const longContent = '这是一段很长的内容，用于测试分块。'.repeat(10);

      mockListWikiNodes.mockResolvedValueOnce(nodes);
      mockGetDocumentContent.mockResolvedValueOnce({
        documentId: 'doc-long',
        title: '长文档',
        content: longContent,
      } as DocumentContent);
      mockIndexDocument.mockResolvedValue({ success: true, id: 'chunk' });

      const result = await service.syncSpace('space-1');

      expect(result.totalDocuments).toBe(1);
      expect(result.successChunks).toBeGreaterThan(1);
      expect(mockIndexDocument).toHaveBeenCalledTimes(result.successChunks);
    });
  });

  describe('syncSpaces', () => {
    it('同步多个空间', async () => {
      const service = createSyncService();

      // 空间 1
      mockListWikiNodes.mockResolvedValueOnce([
        createWikiNode({ objToken: 'doc-1', title: '空间1文档' }),
      ]);
      mockGetDocumentContent.mockResolvedValueOnce({
        documentId: 'doc-1',
        title: '空间1文档',
        content: '内容1',
      } as DocumentContent);
      mockIndexDocument.mockResolvedValueOnce({ success: true, id: '1' });

      // 空间 2
      mockListWikiNodes.mockResolvedValueOnce([
        createWikiNode({ objToken: 'doc-2', title: '空间2文档' }),
      ]);
      mockGetDocumentContent.mockResolvedValueOnce({
        documentId: 'doc-2',
        title: '空间2文档',
        content: '内容2',
      } as DocumentContent);
      mockIndexDocument.mockResolvedValueOnce({ success: true, id: '2' });

      const result = await service.syncSpaces(['space-1', 'space-2']);

      expect(result.totalDocuments).toBe(2);
      expect(result.successChunks).toBe(2);
      expect(result.failedDocuments).toBe(0);
    });

    it('某个空间失败不影响其他空间', async () => {
      const service = createSyncService();

      // 空间 1 失败
      mockListWikiNodes.mockRejectedValueOnce(new Error('空间不存在'));

      // 空间 2 成功
      mockListWikiNodes.mockResolvedValueOnce([
        createWikiNode({ objToken: 'doc-2', title: '文档' }),
      ]);
      mockGetDocumentContent.mockResolvedValueOnce({
        documentId: 'doc-2',
        title: '文档',
        content: '内容',
      } as DocumentContent);
      mockIndexDocument.mockResolvedValueOnce({ success: true, id: '1' });

      const result = await service.syncSpaces(['space-fail', 'space-ok']);

      expect(result.totalDocuments).toBe(1);
      expect(result.successChunks).toBe(1);
      expect(result.failedDocuments).toBe(1); // 空间失败算一个
      expect(result.errors.length).toBe(1);
    });
  });

  describe('配置', () => {
    it('使用自定义 projectScope', async () => {
      const service = new FeishuSyncService({
        client: mockFeishuClient,
        knowledgeService: mockKnowledgeService,
        projectScope: 'my-project',
      });

      mockListWikiNodes.mockResolvedValueOnce([
        createWikiNode({ objToken: 'doc-1', title: '文档' }),
      ]);
      mockGetDocumentContent.mockResolvedValueOnce({
        documentId: 'doc-1',
        title: '文档',
        content: '内容',
      } as DocumentContent);
      mockIndexDocument.mockResolvedValueOnce({ success: true, id: '1' });

      await service.syncSpace('space-1');

      const indexedDoc = mockIndexDocument.mock.calls[0][0] as KnowledgeDocument;
      expect(indexedDoc.projectScope).toBe('my-project');
    });

    it('sourceRef 包含文档 ID 和块索引', async () => {
      const service = createSyncService();

      mockListWikiNodes.mockResolvedValueOnce([
        createWikiNode({ objToken: 'doc-123', title: '文档' }),
      ]);
      mockGetDocumentContent.mockResolvedValueOnce({
        documentId: 'doc-123',
        title: '文档',
        content: '内容',
      } as DocumentContent);
      mockIndexDocument.mockResolvedValueOnce({ success: true, id: '1' });

      await service.syncSpace('space-1');

      const indexedDoc = mockIndexDocument.mock.calls[0][0] as KnowledgeDocument;
      expect(indexedDoc.sourceRef).toContain('doc-123');
      expect(indexedDoc.sourceRef).toContain('chunk-0');
    });
  });
});
