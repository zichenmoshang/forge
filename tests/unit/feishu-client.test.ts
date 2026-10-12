/**
 * FeishuClient（飞书 API 客户端）单元测试
 *
 * 使用 mock fetch 模拟飞书 API 响应。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeishuClient } from '../../src/integrations/feishu/feishu-client';

// Mock fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function createClient(): FeishuClient {
  return new FeishuClient({
    appId: 'test-app-id',
    appSecret: 'test-app-secret',
    baseUrl: 'https://open.feishu.cn',
    timeoutMs: 5000,
  });
}

function mockResponse(data: unknown, ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? 'OK' : 'Internal Server Error',
    json: async () => data,
  };
}

describe('FeishuClient', () => {
  beforeEach(() => {
    mockFetch.mockClear();
  });

  describe('初始化', () => {
    it('缺少 appId 抛出错误', () => {
      expect(() => new FeishuClient({ appId: '', appSecret: 'secret' })).toThrow(
        'appId 和 appSecret 不能为空',
      );
    });

    it('缺少 appSecret 抛出错误', () => {
      expect(() => new FeishuClient({ appId: 'id', appSecret: '' })).toThrow(
        'appId 和 appSecret 不能为空',
      );
    });
  });

  describe('getAccessToken', () => {
    it('成功获取 tenant_access_token', async () => {
      const client = createClient();
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          code: 0,
          msg: 'success',
          tenant_access_token: 'test-token-123',
          expire: 7200,
        }),
      );

      const token = await client.getAccessToken();
      expect(token).toBe('test-token-123');

      // 验证请求
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).toContain('/auth/v3/tenant_access_token/internal');
      expect(callArgs[1].method).toBe('POST');
    });

    it('token 缓存：第二次调用不重新请求', async () => {
      const client = createClient();
      mockFetch.mockResolvedValue(
        mockResponse({
          code: 0,
          msg: 'success',
          tenant_access_token: 'cached-token',
          expire: 7200,
        }),
      );

      await client.getAccessToken();
      await client.getAccessToken();

      // 只调用一次（第二次用缓存）
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('API 返回错误码时抛出异常', async () => {
      const client = createClient();
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          code: 10003,
          msg: 'invalid app_id',
        }),
      );

      await expect(client.getAccessToken()).rejects.toThrow('飞书认证错误');
    });
  });

  describe('listWikiSpaces', () => {
    it('成功获取空间列表', async () => {
      const client = createClient();
      // 第一次：获取 token
      mockFetch.mockResolvedValueOnce(
        mockResponse({ code: 0, tenant_access_token: 'token', expire: 7200 }),
      );
      // 第二次：获取空间列表
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          code: 0,
          data: {
            items: [
              { space_id: 'space-1', name: '技术文档' },
              { space_id: 'space-2', name: '产品需求' },
            ],
            has_more: false,
          },
        }),
      );

      const spaces = await client.listWikiSpaces();
      expect(spaces.length).toBe(2);
      expect(spaces[0].spaceId).toBe('space-1');
      expect(spaces[0].name).toBe('技术文档');
      expect(spaces[1].spaceId).toBe('space-2');
    });

    it('分页：has_more=true 时继续请求', async () => {
      const client = createClient();
      mockFetch.mockResolvedValueOnce(
        mockResponse({ code: 0, tenant_access_token: 'token', expire: 7200 }),
      );
      // 第一页
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          code: 0,
          data: {
            items: [{ space_id: 'space-1', name: '第一页' }],
            has_more: true,
            page_token: 'page-2',
          },
        }),
      );
      // 第二页
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          code: 0,
          data: {
            items: [{ space_id: 'space-2', name: '第二页' }],
            has_more: false,
          },
        }),
      );

      const spaces = await client.listWikiSpaces();
      expect(spaces.length).toBe(2);
      expect(mockFetch).toHaveBeenCalledTimes(3); // 1 token + 2 pages
    });
  });

  describe('getDocumentContent', () => {
    it('Docx 文档获取纯文本', async () => {
      const client = createClient();
      mockFetch.mockResolvedValueOnce(
        mockResponse({ code: 0, tenant_access_token: 'token', expire: 7200 }),
      );
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          code: 0,
          data: {
            content: '这是文档的纯文本内容。',
            title: '测试文档',
          },
        }),
      );

      const doc = await client.getDocumentContent('doc-123', 'docx');
      expect(doc.documentId).toBe('doc-123');
      expect(doc.title).toBe('测试文档');
      expect(doc.content).toBe('这是文档的纯文本内容。');
    });

    it('不支持的文档类型抛出错误', async () => {
      const client = createClient();
      await expect(client.getDocumentContent('doc-123', 'unknown')).rejects.toThrow('不支持的文档类型');
    });

    it('HTTP 错误时抛出异常', async () => {
      const client = createClient();
      mockFetch.mockResolvedValueOnce(
        mockResponse({ code: 0, tenant_access_token: 'token', expire: 7200 }),
      );
      mockFetch.mockResolvedValueOnce(mockResponse({}, false));

      await expect(client.getDocumentContent('doc-123', 'docx')).rejects.toThrow('飞书 API 请求失败');
    });
  });

  describe('认证头', () => {
    it('请求携带 Authorization 头', async () => {
      const client = createClient();
      mockFetch.mockResolvedValueOnce(
        mockResponse({ code: 0, tenant_access_token: 'my-token', expire: 7200 }),
      );
      mockFetch.mockResolvedValueOnce(
        mockResponse({ code: 0, data: { items: [], has_more: false } }),
      );

      await client.listWikiSpaces();

      const secondCall = mockFetch.mock.calls[1];
      expect(secondCall[1].headers.Authorization).toBe('Bearer my-token');
    });
  });
});
