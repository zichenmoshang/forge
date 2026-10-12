/**
 * 飞书文档同步服务（FeishuSyncService）
 *
 * 负责将飞书 Wiki 文档同步到知识库：
 * 1. 从飞书 Wiki 空间拉取文档节点列表
 * 2. 逐个获取文档纯文本内容
 * 3. 用 DocChunker 分块
 * 4. 构造 KnowledgeDocument，调用 KnowledgeService 入库
 *
 * v1 支持全量同步，v2 可扩展增量同步（基于文档更新时间）。
 */

import type { FeishuClient, WikiNode } from './feishu-client';
import { DocChunker } from './doc-chunker';
import type { ChunkConfig } from './doc-chunker';
import type { KnowledgeService } from '../../services/knowledge-service';
import type { KnowledgeDocument, KnowledgeType } from '../../types/knowledge';
import type { Logger } from '../../observability/logger';

/** 同步服务配置 */
export interface FeishuSyncConfig {
  /** 飞书 API 客户端 */
  client: FeishuClient;
  /** KnowledgeService 实例 */
  knowledgeService: KnowledgeService;
  /** 文档分块配置 */
  chunkConfig?: ChunkConfig;
  /** 日志器 */
  logger?: Logger;
  /** 同步时的项目范围，默认 'global' */
  projectScope?: string;
  /** 同步时的知识类型，默认 'doc' */
  knowledgeType?: KnowledgeType;
}

/** 同步结果统计 */
export interface SyncResult {
  /** 扫描的 Wiki 节点总数 */
  totalNodes: number;
  /** 同步的文档数（Doc + Docx） */
  totalDocuments: number;
  /** 成功入库的文档块数 */
  successChunks: number;
  /** 失败的文档数 */
  failedDocuments: number;
  /** 跳过的节点数（非文档类型） */
  skippedNodes: number;
  /** 失败详情 */
  errors: Array<{ documentId: string; title: string; error: string }>;
  /** 同步耗时（毫秒） */
  durationMs: number;
}

/** 单个文档同步结果 */
interface DocumentSyncResult {
  documentId: string;
  title: string;
  chunkCount: number;
  success: boolean;
  error?: string;
}

/**
 * 飞书文档同步服务
 */
export class FeishuSyncService {
  private client: FeishuClient;
  private knowledgeService: KnowledgeService;
  private chunker: DocChunker;
  private logger?: Logger;
  private projectScope: string;
  private knowledgeType: KnowledgeType;

  constructor(config: FeishuSyncConfig) {
    this.client = config.client;
    this.knowledgeService = config.knowledgeService;
    this.chunker = new DocChunker(config.chunkConfig);
    this.logger = config.logger;
    this.projectScope = config.projectScope ?? 'global';
    this.knowledgeType = config.knowledgeType ?? 'doc';
  }

  /**
   * 同步指定 Wiki 空间的所有文档
   * @param spaceId Wiki 空间 ID
   */
  async syncSpace(spaceId: string): Promise<SyncResult> {
    const startTime = Date.now();
    this.logger?.info(`开始同步飞书 Wiki 空间: ${spaceId}`);

    // 第一步：获取所有节点
    this.logger?.debug('获取 Wiki 节点列表...');
    const nodes = await this.client.listWikiNodes(spaceId);
    this.logger?.debug(`共获取 ${nodes.length} 个节点`);

    // 第二步：筛选文档节点（Doc=2, Docx=22）
    const docNodes = nodes.filter((node) => node.objType === 'doc' || node.objType === 'docx');
    const skippedNodes = nodes.length - docNodes.length;

    this.logger?.info(`筛选出 ${docNodes.length} 个文档（跳过 ${skippedNodes} 个非文档节点）`);

    // 第三步：逐个同步文档
    const results: DocumentSyncResult[] = [];
    let successChunks = 0;

    for (let i = 0; i < docNodes.length; i++) {
      const node = docNodes[i];
      this.logger?.info(`同步文档 ${i + 1}/${docNodes.length}: ${node.title}`);

      try {
        const result = await this.syncDocument(node);
        results.push(result);
        if (result.success) {
          successChunks += result.chunkCount;
        }
      } catch (error) {
        results.push({
          documentId: node.objToken,
          title: node.title,
          chunkCount: 0,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // 第四步：汇总结果
    const failedDocuments = results.filter((r) => !r.success).length;
    const durationMs = Date.now() - startTime;

    const syncResult: SyncResult = {
      totalNodes: nodes.length,
      totalDocuments: docNodes.length,
      successChunks,
      failedDocuments,
      skippedNodes,
      errors: results
        .filter((r) => !r.success)
        .map((r) => ({
          documentId: r.documentId,
          title: r.title,
          error: r.error ?? '未知错误',
        })),
      durationMs,
    };

    this.logger?.info(
      `同步完成: ${syncResult.totalDocuments} 个文档, ${syncResult.successChunks} 个块成功, ` +
        `${syncResult.failedDocuments} 个失败, 耗时 ${(durationMs / 1000).toFixed(1)}s`,
    );

    return syncResult;
  }

  /**
   * 同步多个 Wiki 空间
   * @param spaceIds Wiki 空间 ID 列表
   */
  async syncSpaces(spaceIds: string[]): Promise<SyncResult> {
    const startTime = Date.now();
    const combined: SyncResult = {
      totalNodes: 0,
      totalDocuments: 0,
      successChunks: 0,
      failedDocuments: 0,
      skippedNodes: 0,
      errors: [],
      durationMs: 0,
    };

    for (const spaceId of spaceIds) {
      try {
        const result = await this.syncSpace(spaceId);
        combined.totalNodes += result.totalNodes;
        combined.totalDocuments += result.totalDocuments;
        combined.successChunks += result.successChunks;
        combined.failedDocuments += result.failedDocuments;
        combined.skippedNodes += result.skippedNodes;
        combined.errors.push(...result.errors);
      } catch (error) {
        combined.failedDocuments++;
        combined.errors.push({
          documentId: spaceId,
          title: `空间 ${spaceId}`,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    combined.durationMs = Date.now() - startTime;
    return combined;
  }

  /**
   * 同步单个文档
   */
  private async syncDocument(node: WikiNode): Promise<DocumentSyncResult> {
    // 获取文档内容
    const docContent = await this.client.getDocumentContent(node.objToken, node.objType);

    if (!docContent.content || docContent.content.trim().length === 0) {
      return {
        documentId: node.objToken,
        title: node.title,
        chunkCount: 0,
        success: true, // 空文档不算失败
      };
    }

    // 文档分块
    const chunks = this.chunker.chunk(docContent.content, docContent.title);

    if (chunks.length === 0) {
      return {
        documentId: node.objToken,
        title: node.title,
        chunkCount: 0,
        success: true,
      };
    }

    // 逐个块入库
    let successCount = 0;
    for (const chunk of chunks) {
      const knowledgeDoc: KnowledgeDocument = {
        type: this.knowledgeType,
        title: chunk.title ? `${docContent.title} - ${chunk.title}` : docContent.title,
        content: chunk.content,
        summary: this.generateSummary(chunk.content),
        source: 'feishu',
        sourceRef: `${node.objToken}#chunk-${chunk.index}`,
        projectScope: this.projectScope,
      };

      try {
        await this.knowledgeService.indexDocument(knowledgeDoc);
        successCount++;
      } catch (error) {
        this.logger?.warn(
          `文档块入库失败: ${knowledgeDoc.title} (chunk-${chunk.index}): ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }

    return {
      documentId: node.objToken,
      title: node.title,
      chunkCount: successCount,
      success: successCount > 0,
      error: successCount === 0 ? '所有块入库失败' : undefined,
    };
  }

  /**
   * 生成文档摘要（取前 200 个字符）
   */
  private generateSummary(content: string): string {
    const trimmed = content.trim().replace(/\s+/g, ' ');
    return trimmed.length > 200 ? trimmed.slice(0, 200) + '...' : trimmed;
  }
}
