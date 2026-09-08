/**
 * KnowledgeService（知识库核心服务）
 *
 * 团队级中心化服务，单例模式，所有 Harness 实例共享。
 * 组合 VectorStore（向量存储）、EmbeddingProvider（向量模型）、ASTParser（代码反解析）。
 *
 * Agent 只调用 search()，不直接操作向量库或 AST 解析。
 */

import * as fs from 'fs';
import * as path from 'path';
import type { EmbeddingProvider } from '../llm/embedding-provider';
import type { VectorStore } from './vector-store';
import { InMemoryVectorStore } from './vector-store';
import { ASTParser } from './ast-parser';
import type {
  KnowledgeItem,
  KnowledgeFilter,
  KnowledgeDocument,
  IndexResult,
  FileChange,
  KnowledgeStatus,
  KnowledgeType,
  KnowledgeSource,
} from '../types/knowledge';
import type { Logger } from '../observability/logger';

/** KnowledgeService 配置 */
export interface KnowledgeServiceConfig {
  vectorStore?: VectorStore;
  embeddingProvider: EmbeddingProvider;
  astParser?: ASTParser;
  logger?: Logger;
  /** 代码文件扩展名 */
  codeExtensions?: string[];
  /** 排除的目录 */
  excludeDirs?: string[];
}

/** 全量重建时单个仓库的索引目标（可带项目范围与技术栈标签） */
export interface RepoIndexTarget {
  path: string;
  /** 'global' 或项目 ID，默认 global */
  projectScope?: string;
  techStack?: string;
}

/** 归一化 rebuild 入参：兼容纯路径字符串与带 scope 的目标对象 */
function normalizeRepoTarget(target: string | RepoIndexTarget): {
  repoPath: string;
  projectScope: string;
  techStack?: string;
} {
  if (typeof target === 'string') {
    return { repoPath: target, projectScope: 'global' };
  }
  return {
    repoPath: target.path,
    projectScope: target.projectScope ?? 'global',
    techStack: target.techStack,
  };
}

export class KnowledgeService {
  private static instance: KnowledgeService | null = null;

  private vectorStore: VectorStore;
  private embeddingProvider: EmbeddingProvider;
  private astParser: ASTParser;
  private logger?: Logger;
  private codeExtensions: string[];
  private excludeDirs: string[];
  private lastSyncAt: string = '';
  private lastRebuildAt?: string;

  private constructor(config: KnowledgeServiceConfig) {
    this.vectorStore = config.vectorStore ?? new InMemoryVectorStore();
    this.embeddingProvider = config.embeddingProvider;
    this.astParser = config.astParser ?? new ASTParser();
    this.logger = config.logger;
    this.codeExtensions = config.codeExtensions ?? ['.ts', '.tsx', '.js', '.jsx'];
    this.excludeDirs = config.excludeDirs ?? ['node_modules', 'dist', '.git', 'test', 'tests'];
  }

  /**
   * 获取单例实例
   * 首次调用时需要传入配置，后续调用直接返回已创建的实例
   */
  static getInstance(config?: KnowledgeServiceConfig): KnowledgeService {
    if (!KnowledgeService.instance) {
      if (!config) {
        throw new Error('KnowledgeService 首次初始化需要传入配置');
      }
      KnowledgeService.instance = new KnowledgeService(config);
    }
    return KnowledgeService.instance;
  }

  /** 重置单例（仅用于测试） */
  static resetInstance(): void {
    KnowledgeService.instance = null;
  }

  /**
   * 检索知识库
   *
   * 流程：query → embedding → vector search → 返回 top K
   * v1 不做 rerank，直接返回向量检索结果。
   *
   * @param query 查询文本
   * @param filter 元数据过滤器
   * @param topK 返回数量（默认 10）
   */
  async search(query: string, filter?: KnowledgeFilter, topK?: number): Promise<KnowledgeItem[]> {
    if (!query || query.trim().length === 0) return [];

    // 1. 生成查询向量
    const embeddingResult = await this.embeddingProvider.embed({ input: query });
    if (embeddingResult.embeddings.length === 0) return [];
    const queryEmbedding = embeddingResult.embeddings[0];

    // 2. 向量检索
    const results = await this.vectorStore.search(queryEmbedding, filter, topK);

    // 3. 更新使用统计（异步，不阻塞检索）
    for (const item of results) {
      this.updateUsage(item.id).catch(() => {});
    }

    this.logger?.debug(`[KnowledgeService] 检索 "${query}" 返回 ${results.length} 条结果`);
    return results;
  }

  /**
   * 代码反解析入库
   *
   * 遍历指定目录，解析所有代码文件，提取 API 接口和组件，向量化后入库。
   *
   * @param repoPath 代码仓库路径
   * @param projectScope 项目范围（'global' 或项目 ID）
   * @param techStack 技术栈标签
   */
  async indexCode(
    repoPath: string,
    projectScope: string = 'global',
    techStack?: string,
  ): Promise<IndexResult> {
    const result: IndexResult = {
      total: 0,
      success: 0,
      failed: 0,
      errors: [],
      itemIds: [],
    };

    if (!fs.existsSync(repoPath)) {
      result.failed = 1;
      result.errors.push({ file: repoPath, error: '目录不存在' });
      return result;
    }

    // 遍历所有代码文件
    const files = this.collectCodeFiles(repoPath);
    result.total = files.length;

    this.logger?.info(
      `[KnowledgeService] 开始索引代码仓库: ${repoPath}，共 ${files.length} 个文件`,
    );

    for (const filePath of files) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const parseResult = this.astParser.parse(content, filePath);
        const items = this.astParser.toKnowledgeItems(
          parseResult,
          filePath,
          projectScope,
          techStack,
        );

        // 向量化并入库
        for (const item of items) {
          try {
            const embeddingResult = await this.embeddingProvider.embed({ input: item.summary });
            if (embeddingResult.embeddings.length > 0) {
              item.embedding = embeddingResult.embeddings[0];
            }
            await this.vectorStore.upsert(item);
            result.itemIds.push(item.id);
            result.success++;
          } catch (err) {
            result.failed++;
            result.errors.push({
              file: filePath,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } catch (err) {
        result.failed++;
        result.errors.push({
          file: filePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.lastSyncAt = new Date().toISOString();
    this.logger?.info(
      `[KnowledgeService] 代码索引完成: 成功 ${result.success}，失败 ${result.failed}`,
    );
    return result;
  }

  /**
   * 文档入库（飞书同步、手动录入）
   */
  async indexDocument(doc: KnowledgeDocument): Promise<{ success: boolean; id: string }> {
    const now = new Date().toISOString();
    const id = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // 生成摘要（如果没有提供，用内容前 200 字）
    const summary = doc.summary ?? doc.content.slice(0, 200);

    const item: KnowledgeItem = {
      id,
      type: doc.type,
      title: doc.title,
      content: doc.content,
      summary,
      source: doc.source,
      sourceRef: doc.sourceRef,
      projectScope: doc.projectScope ?? 'global',
      techStack: doc.techStack,
      businessDomain: doc.businessDomain,
      weight: doc.source === 'manual' ? 0.8 : 0.7,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      usageCount: 0,
    };

    // 向量化
    const embeddingResult = await this.embeddingProvider.embed({ input: summary });
    if (embeddingResult.embeddings.length > 0) {
      item.embedding = embeddingResult.embeddings[0];
    }

    await this.vectorStore.upsert(item);
    this.logger?.info(`[KnowledgeService] 文档入库: ${doc.title} (${id})`);
    return { success: true, id };
  }

  /**
   * 增量更新
   *
   * 根据文件变更列表，只重新解析变更的文件。
   */
  async syncIncremental(changes: FileChange[]): Promise<IndexResult> {
    const result: IndexResult = {
      total: changes.length,
      success: 0,
      failed: 0,
      errors: [],
      itemIds: [],
    };

    for (const change of changes) {
      try {
        if (change.action === 'deleted') {
          // 删除：标记为 removed（不物理删除）
          const items = await this.vectorStore.getAll({
            sources: ['code'],
            includeDeprecated: true,
          });
          for (const item of items) {
            if (
              item.sourceRef === change.path &&
              (!change.projectScope ||
                item.projectScope === change.projectScope ||
                item.projectScope === 'global')
            ) {
              item.status = 'removed';
              item.updatedAt = new Date().toISOString();
              await this.vectorStore.upsert(item);
            }
          }
          result.success++;
        } else if (change.content) {
          // 新增/修改：重新解析（透传 projectScope，避免增量条目错误落到 global）
          const parseResult = this.astParser.parse(change.content, change.path);
          const items = this.astParser.toKnowledgeItems(
            parseResult,
            change.path,
            change.projectScope ?? 'global',
          );

          for (const item of items) {
            const embeddingResult = await this.embeddingProvider.embed({ input: item.summary });
            if (embeddingResult.embeddings.length > 0) {
              item.embedding = embeddingResult.embeddings[0];
            }
            await this.vectorStore.upsert(item);
            result.itemIds.push(item.id);
          }
          result.success++;
        }
      } catch (err) {
        result.failed++;
        result.errors.push({
          file: change.path,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.lastSyncAt = new Date().toISOString();
    return result;
  }

  /**
   * 全量重建
   *
   * 清空现有数据，重新索引所有代码仓库。每个仓库可单独指定 projectScope/techStack，
   * 避免多仓库全部落到 global 破坏项目隔离（一致性审计修复）。
   * @param repoTargets 代码仓库路径，或带 projectScope/techStack 的目标描述
   */
  async rebuild(repoTargets: Array<string | RepoIndexTarget>): Promise<IndexResult> {
    this.logger?.warn('[KnowledgeService] 开始全量重建，清空现有数据');
    await this.vectorStore.clear();

    const totalResult: IndexResult = {
      total: 0,
      success: 0,
      failed: 0,
      errors: [],
      itemIds: [],
    };

    for (const target of repoTargets) {
      const { repoPath, projectScope, techStack } = normalizeRepoTarget(target);
      const result = await this.indexCode(repoPath, projectScope, techStack);
      totalResult.total += result.total;
      totalResult.success += result.success;
      totalResult.failed += result.failed;
      totalResult.errors.push(...result.errors);
      totalResult.itemIds.push(...result.itemIds);
    }

    this.lastRebuildAt = new Date().toISOString();
    this.logger?.info(
      `[KnowledgeService] 全量重建完成: 成功 ${totalResult.success}，失败 ${totalResult.failed}`,
    );
    return totalResult;
  }

  /**
   * 获取知识库状态统计
   */
  async getStatus(): Promise<KnowledgeStatus> {
    const allItems = await this.vectorStore.getAll({ includeDeprecated: true });

    const byType: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    let activeCount = 0;
    let deprecatedCount = 0;
    let removedCount = 0;

    for (const item of allItems) {
      byType[item.type] = (byType[item.type] ?? 0) + 1;
      bySource[item.source] = (bySource[item.source] ?? 0) + 1;

      if (item.status === 'active') activeCount++;
      else if (item.status === 'deprecated') deprecatedCount++;
      else if (item.status === 'removed') removedCount++;
    }

    return {
      totalItems: allItems.length,
      byType: byType as Partial<Record<KnowledgeType, number>>,
      bySource: bySource as Partial<Record<KnowledgeSource, number>>,
      activeCount,
      deprecatedCount,
      removedCount,
      lastSyncAt: this.lastSyncAt || '从未同步',
      lastRebuildAt: this.lastRebuildAt,
    };
  }

  /**
   * 调整知识条目的权重（使用反馈闭环）
   *
   * @param id 知识条目 ID
   * @param delta 权重变化量（正数提升，负数降低）
   */
  async updateWeight(id: string, delta: number): Promise<boolean> {
    const item = await this.vectorStore.get(id);
    if (!item) return false;

    item.weight = Math.max(0.1, Math.min(1.0, item.weight + delta));
    item.updatedAt = new Date().toISOString();
    await this.vectorStore.upsert(item);

    this.logger?.debug(
      `[KnowledgeService] 权重调整: ${id} ${delta > 0 ? '+' : ''}${delta} → ${item.weight}`,
    );
    return true;
  }

  /**
   * 更新使用统计（被检索时调用）
   */
  private async updateUsage(id: string): Promise<void> {
    const item = await this.vectorStore.get(id);
    if (!item) return;

    item.usageCount++;
    item.lastUsedAt = new Date().toISOString();
    await this.vectorStore.upsert(item);
  }

  /**
   * 收集目录下所有代码文件
   */
  private collectCodeFiles(dirPath: string): string[] {
    const files: string[] = [];

    const walk = (currentPath: string) => {
      const entries = fs.readdirSync(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);

        if (entry.isDirectory()) {
          if (!this.excludeDirs.includes(entry.name)) {
            walk(fullPath);
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (this.codeExtensions.includes(ext)) {
            files.push(fullPath);
          }
        }
      }
    };

    walk(dirPath);
    return files;
  }
}
