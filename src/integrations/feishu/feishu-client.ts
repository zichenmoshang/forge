/**
 * 飞书 API 客户端
 *
 * 负责与飞书开放平台交互：
 * - tenant_access_token 认证
 * - Wiki 空间列表 / 节点列表
 * - 文档内容获取（docx raw_content）
 *
 * v1 使用 raw_content API 获取纯文本，不解析块结构。
 * v2 可扩展 blocks API 做结构化解析。
 */

import type { Logger } from '../../observability/logger';

/** 飞书客户端配置 */
export interface FeishuClientConfig {
  appId: string;
  appSecret: string;
  /** 飞书开放平台基础 URL，默认 https://open.feishu.cn */
  baseUrl?: string;
  logger?: Logger;
  /** 请求超时（毫秒），默认 30000 */
  timeoutMs?: number;
}

/** Wiki 空间信息 */
export interface WikiSpace {
  spaceId: string;
  name: string;
  description?: string;
}

/** Wiki 节点 */
export interface WikiNode {
  nodeToken: string;
  objToken: string;
  objType: string; // 'doc'=旧版文档, 'docx'=新版文档, 'sheet'=表格, 'bitable'=多维表格, 'folder'=文件夹
  title: string;
  hasChild: boolean;
  parentNodeToken?: string;
}

/** 文档内容 */
export interface DocumentContent {
  documentId: string;
  title: string;
  content: string; // 纯文本
}

/** 飞书 API 通用响应 */
interface FeishuApiResponse<T> {
  code: number;
  msg: string;
  data?: T;
}

/** Wiki 空间列表响应 */
interface WikiSpacesResponse {
  items?: Array<{
    space_id: string;
    name: string;
    description?: string;
  }>;
  has_more?: boolean;
  page_token?: string;
}

/** Wiki 节点列表响应 */
interface WikiNodesResponse {
  items?: Array<{
    node_token: string;
    obj_token: string;
    obj_type: string;
    title: string;
    has_child: boolean;
    parent_node_token?: string;
  }>;
  has_more?: boolean;
  page_token?: string;
}

/** Docx raw_content 响应 */
interface DocxRawContentResponse {
  content: string;
  title?: string;
}

/**
 * 飞书 API 客户端
 *
 * 所有方法自动处理 token 认证和分页。
 */
export class FeishuClient {
  private config: Required<Omit<FeishuClientConfig, 'logger'>> & { logger?: Logger };
  private accessToken: string | null = null;
  private tokenExpireAt: number = 0;

  constructor(config: FeishuClientConfig) {
    if (!config.appId || !config.appSecret) {
      throw new Error('FeishuClient: appId 和 appSecret 不能为空');
    }
    this.config = {
      appId: config.appId,
      appSecret: config.appSecret,
      baseUrl: config.baseUrl ?? 'https://open.feishu.cn',
      timeoutMs: config.timeoutMs ?? 30000,
      logger: config.logger,
    };
  }

  /**
   * 获取 tenant_access_token（带缓存）
   * token 有效期 2 小时，提前 5 分钟刷新
   *
   * 注意：认证接口的响应格式是 { code, msg, tenant_access_token, expire }（顶层），
   * 与其他 API 的 { code, msg, data: {...} } 不同，因此单独处理，不走通用 request 方法。
   */
  async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.accessToken && now < this.tokenExpireAt - 5 * 60 * 1000) {
      return this.accessToken;
    }

    const url = `${this.config.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`;
    const body = {
      app_id: this.config.appId,
      app_secret: this.config.appSecret,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`飞书认证请求失败: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as {
        code: number;
        msg: string;
        tenant_access_token?: string;
        expire?: number;
      };

      if (data.code !== 0) {
        throw new Error(`飞书认证错误: code=${data.code}, msg=${data.msg}`);
      }

      if (!data.tenant_access_token) {
        throw new Error('飞书认证响应中缺少 tenant_access_token');
      }

      this.accessToken = data.tenant_access_token;
      this.tokenExpireAt = now + (data.expire ?? 7200) * 1000;

      this.config.logger?.debug(
        `飞书 tenant_access_token 已获取，有效期 ${data.expire ?? 7200}s`,
      );
      return this.accessToken;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`飞书认证请求超时: ${url}`, { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * 获取 Wiki 空间列表
   */
  async listWikiSpaces(): Promise<WikiSpace[]> {
    const spaces: WikiSpace[] = [];
    let pageToken: string | undefined;

    do {
      const url = new URL(`${this.config.baseUrl}/open-apis/wiki/v2/spaces`);
      url.searchParams.set('page_size', '50');
      if (pageToken) url.searchParams.set('page_token', pageToken);

      const response = await this.request<WikiSpacesResponse>(url.toString(), 'GET');
      if (response.items) {
        for (const item of response.items) {
          spaces.push({
            spaceId: item.space_id,
            name: item.name,
            description: item.description,
          });
        }
      }
      pageToken = response.has_more ? response.page_token : undefined;
    } while (pageToken);

    return spaces;
  }

  /**
   * 获取 Wiki 空间下的节点列表（递归遍历所有子节点）
   * @param spaceId 空间 ID
   * @param parentNodeToken 父节点 token，不传则从根节点开始
   */
  async listWikiNodes(spaceId: string, parentNodeToken?: string): Promise<WikiNode[]> {
    const nodes: WikiNode[] = [];
    let pageToken: string | undefined;

    do {
      const url = new URL(`${this.config.baseUrl}/open-apis/wiki/v2/spaces/${spaceId}/nodes`);
      url.searchParams.set('page_size', '50');
      if (parentNodeToken) url.searchParams.set('parent_node_token', parentNodeToken);
      if (pageToken) url.searchParams.set('page_token', pageToken);

      const response = await this.request<WikiNodesResponse>(url.toString(), 'GET');
      if (response.items) {
        for (const item of response.items) {
          const node: WikiNode = {
            nodeToken: item.node_token,
            objToken: item.obj_token,
            objType: item.obj_type,
            title: item.title,
            hasChild: item.has_child,
            parentNodeToken: item.parent_node_token,
          };
          nodes.push(node);

          // 递归遍历子节点（文件夹或有子节点的文档）
          if (item.has_child) {
            const children = await this.listWikiNodes(spaceId, item.node_token);
            nodes.push(...children);
          }
        }
      }
      pageToken = response.has_more ? response.page_token : undefined;
    } while (pageToken);

    return nodes;
  }

  /**
   * 获取文档内容（纯文本）
   * 支持 Docx（新版，obj_type='docx'）和 Doc（旧版，obj_type='doc'）
   * @param documentId 文档 ID（obj_token）
   * @param objType 文档类型，'docx'=新版文档，'doc'=旧版文档
   */
  async getDocumentContent(documentId: string, objType: string = 'docx'): Promise<DocumentContent> {
    if (objType === 'docx') {
      return this.getDocxContent(documentId);
    }
    if (objType === 'doc') {
      return this.getDocContent(documentId);
    }
    throw new Error(`不支持的文档类型 obj_type=${objType}，仅支持 doc 和 docx`);
  }

  /**
   * 获取 Docx（新版文档）纯文本内容
   */
  private async getDocxContent(documentId: string): Promise<DocumentContent> {
    const url = `${this.config.baseUrl}/open-apis/docx/v1/documents/${documentId}/raw_content`;
    const response = await this.request<DocxRawContentResponse>(url, 'GET');

    return {
      documentId,
      title: response.title ?? documentId,
      content: response.content ?? '',
    };
  }

  /**
   * 获取 Doc（旧版文档）纯文本内容
   */
  private async getDocContent(documentId: string): Promise<DocumentContent> {
    const url = `${this.config.baseUrl}/open-apis/doc/v2/${documentId}/raw_content`;
    const response = await this.request<{ content: string; title?: string }>(url, 'GET');

    return {
      documentId,
      title: response.title ?? documentId,
      content: response.content ?? '',
    };
  }

  /**
   * 通用请求方法
   * @param url 请求 URL
   * @param method HTTP 方法
   * @param body 请求体（GET 请求忽略）
   * @param auth 是否需要认证（默认 true）
   */
  private async request<T>(
    url: string,
    method: 'GET' | 'POST',
    body?: Record<string, unknown>,
    auth: boolean = true,
  ): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (auth) {
      const token = await this.getAccessToken();
      headers['Authorization'] = `Bearer ${token}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: method === 'POST' && body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        let errorBody = '';
        try {
          errorBody = await response.text();
        } catch {
          // 忽略读取响应体失败
        }
        throw new Error(
          `飞书 API 请求失败: ${response.status} ${response.statusText}${errorBody ? `, body: ${errorBody.slice(0, 500)}` : ''}`,
        );
      }

      const data = (await response.json()) as FeishuApiResponse<T>;

      if (data.code !== 0) {
        throw new Error(`飞书 API 错误: code=${data.code}, msg=${data.msg}`);
      }

      return data.data as T;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`飞书 API 请求超时: ${url}`, { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
