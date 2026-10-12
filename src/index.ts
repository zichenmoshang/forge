/**
 * Forge - 从需求 PRD 到高质量前端代码的自动化智能体
 *
 * 程序入口
 */

export * from './core';
export * from './types';
export * from './agents';
export * from './llm';
export * from './services';
export { getConfig, loadConfig } from './config';
export type { ForgeConfig, LLMConfig } from './config';
import { runKnowledgeCli } from './cli/knowledge-cli';
import { runForgeCli } from './cli/run-cli';
export { runKnowledgeCli, runForgeCli };

// CLI 入口
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args[0] === 'kb') {
    // 知识库维护命令
    runKnowledgeCli(args.slice(1)).catch((err) => {
      console.error('知识库命令执行失败:', err);
      process.exit(1);
    });
  } else if (args[0] === 'run') {
    // 主流程流水线
    runForgeCli(args.slice(1)).catch((err) => {
      console.error('流水线执行失败:', err);
      process.exit(1);
    });
  } else {
    console.log('Forge - 需求到代码自动化智能体');
    console.log('');
    console.log('用法:');
    console.log('  forge run <prd-path>  运行需求流水线');
    console.log('  forge kb <command>    知识库维护（sync/rebuild/search/status）');
    console.log('');
    console.log('运行 "forge run --help" 或 "forge kb help" 查看帮助');
  }
}
