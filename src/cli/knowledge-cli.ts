/**
 * 知识库维护 CLI
 *
 * 用法：
 *   forge kb sync <repo-path> [--scope <project-id>] [--tech <tech-stack>]
 *   forge kb rebuild <repo-path...>
 *   forge kb search <query> [--type <type>] [--limit <n>]
 *   forge kb status
 *
 * 这些命令独立于 Harness 流程，直接调用 KnowledgeService。
 */

import { getConfig } from '../config';
import { createEmbeddingProvider, MockEmbeddingProvider } from '../llm/embedding-provider';
import { KnowledgeService } from '../services/knowledge-service';
import { InMemoryVectorStore } from '../services/vector-store';
import { ASTParser } from '../services/ast-parser';
import type { KnowledgeType } from '../types/knowledge';

/** 初始化 KnowledgeService（CLI 用） */
function initKnowledgeService(): KnowledgeService {
  const config = getConfig();

  // v1 使用内存版 VectorStore，后续切换为 pgvector
  const vectorStore = new InMemoryVectorStore();

  // Embedding Provider：配置了 API Key 用真实模型，否则用 Mock
  const embeddingProvider = config.embedding.apiKey
    ? createEmbeddingProvider(config.embedding)
    : new MockEmbeddingProvider(config.embedding.dimensions);

  const astParser = new ASTParser();

  return KnowledgeService.getInstance({
    vectorStore,
    embeddingProvider,
    astParser,
  });
}

/** 解析命令行参数 */
function parseArgs(args: string[]): {
  command: string;
  positional: string[];
  options: Record<string, string>;
} {
  const positional: string[] = [];
  const options: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = args[i + 1];
      if (value && !value.startsWith('--')) {
        options[key] = value;
        i++;
      } else {
        options[key] = 'true';
      }
    } else {
      positional.push(arg);
    }
  }

  return { command: positional[0] || '', positional: positional.slice(1), options };
}

/** 执行知识库 CLI 命令 */
export async function runKnowledgeCli(args: string[]): Promise<void> {
  const { command, positional, options } = parseArgs(args);

  if (!command || command === 'help') {
    printHelp();
    return;
  }

  const service = initKnowledgeService();

  switch (command) {
    case 'sync': {
      const repoPath = positional[0];
      if (!repoPath) {
        console.error('错误: 请指定代码仓库路径');
        console.error(
          '用法: forge kb sync <repo-path> [--scope <project-id>] [--tech <tech-stack>]',
        );
        process.exit(1);
      }
      const scope = options.scope || 'global';
      const techStack = options.tech;
      console.log(`开始索引代码仓库: ${repoPath}`);
      console.log(`项目范围: ${scope}, 技术栈: ${techStack || '自动检测'}`);
      const result = await service.indexCode(repoPath, scope, techStack);
      console.log(`\n索引完成:`);
      console.log(`  总文件数: ${result.total}`);
      console.log(`  成功: ${result.success}`);
      console.log(`  失败: ${result.failed}`);
      if (result.errors.length > 0) {
        console.log(`\n错误详情:`);
        for (const err of result.errors.slice(0, 10)) {
          console.log(`  - ${err.file}: ${err.error}`);
        }
        if (result.errors.length > 10) {
          console.log(`  ... 还有 ${result.errors.length - 10} 个错误`);
        }
      }
      break;
    }

    case 'rebuild': {
      const repoPaths = positional;
      if (repoPaths.length === 0) {
        console.error('错误: 请指定至少一个代码仓库路径');
        console.error('用法: forge kb rebuild <repo-path...>');
        process.exit(1);
      }
      console.log(`开始全量重建，共 ${repoPaths.length} 个仓库`);
      const result = await service.rebuild(repoPaths);
      console.log(`\n重建完成:`);
      console.log(`  总文件数: ${result.total}`);
      console.log(`  成功: ${result.success}`);
      console.log(`  失败: ${result.failed}`);
      break;
    }

    case 'search': {
      const query = positional.join(' ');
      if (!query) {
        console.error('错误: 请指定检索查询');
        console.error('用法: forge kb search <query> [--type <type>] [--limit <n>]');
        process.exit(1);
      }
      const type = options.type as KnowledgeType | undefined;
      const limit = parseInt(options.limit || '10', 10);
      console.log(`检索: "${query}"`);
      if (type) console.log(`类型过滤: ${type}`);
      console.log('');

      const results = await service.search(query, type ? { types: [type] } : undefined, limit);

      if (results.length === 0) {
        console.log('未找到相关知识');
      } else {
        console.log(`找到 ${results.length} 条结果:\n`);
        results.forEach((item, index) => {
          console.log(`${index + 1}. [${item.type}] ${item.title}`);
          console.log(`   来源: ${item.source} (${item.sourceRef})`);
          console.log(`   相似度: ${(item.relevanceScore || 0).toFixed(4)}, 权重: ${item.weight}`);
          console.log(
            `   摘要: ${item.summary.slice(0, 100)}${item.summary.length > 100 ? '...' : ''}`,
          );
          console.log('');
        });
      }
      break;
    }

    case 'status': {
      const status = await service.getStatus();
      console.log('知识库状态:');
      console.log(`  总条目数: ${status.totalItems}`);
      console.log(`  活跃: ${status.activeCount}`);
      console.log(`  已废弃: ${status.deprecatedCount}`);
      console.log(`  已移除: ${status.removedCount}`);
      console.log(`  最后同步: ${status.lastSyncAt}`);
      if (status.lastRebuildAt) {
        console.log(`  最后重建: ${status.lastRebuildAt}`);
      }
      console.log(`\n按类型分布:`);
      for (const [type, count] of Object.entries(status.byType)) {
        console.log(`  ${type}: ${count}`);
      }
      console.log(`\n按来源分布:`);
      for (const [source, count] of Object.entries(status.bySource)) {
        console.log(`  ${source}: ${count}`);
      }
      break;
    }

    default:
      console.error(`未知命令: ${command}`);
      printHelp();
      process.exit(1);
  }
}

/** 打印帮助信息 */
function printHelp(): void {
  console.log(`
Forge 知识库维护 CLI

用法:
  forge kb sync <repo-path> [--scope <project-id>] [--tech <tech-stack>]
    增量索引代码仓库，提取 API 接口和组件

  forge kb rebuild <repo-path...>
    全量重建知识库（清空现有数据）

  forge kb search <query> [--type <type>] [--limit <n>]
    手动检索知识库，验证检索效果
    type 可选: api, component, model, design, spec, exception, pattern, doc

  forge kb status
    查看知识库状态统计

  forge kb help
    显示此帮助信息

示例:
  forge kb sync ./src --scope my-project --tech react
  forge kb search "用户登录 API" --type api
  forge kb status
`);
}
