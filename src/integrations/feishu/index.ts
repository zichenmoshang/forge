/**
 * 飞书集成模块
 *
 * 提供飞书文档同步到知识库的能力：
 * - FeishuClient：飞书 API 客户端（认证 + Wiki + 文档）
 * - DocChunker：文档分块器
 * - FeishuSyncService：飞书文档同步服务
 */

export { FeishuClient } from './feishu-client';
export type { FeishuClientConfig, WikiSpace, WikiNode, DocumentContent } from './feishu-client';

export { DocChunker } from './doc-chunker';
export type { ChunkConfig, DocumentChunk } from './doc-chunker';

export { FeishuSyncService } from './feishu-sync-service';
export type { FeishuSyncConfig, SyncResult } from './feishu-sync-service';
