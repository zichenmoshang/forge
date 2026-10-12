/**
 * Forge 主流程 CLI（forge run）
 *
 * 用法：
 *   node dist/index.js run <prd-path> [options]
 *
 * 选项：
 *   --output <dir>       输出目录（默认 ./output）
 *   --project <name>     项目名称（用于知识库隔离和输出子目录）
 *   --no-knowledge       禁用知识库检索
 *   --verbose            详细日志
 *
 * 流程：PRD → 需求澄清(硬卡点) → 故事拆解 → 技术方案 → 方案评审
 *       → API确认(硬卡点) → 逐故事TDD编码 → 代码CR → 交付(落盘+Git)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { getConfig } from '../config';
import { createLLMProvider } from '../llm/factory';
import { createEmbeddingProvider } from '../llm/embedding-provider';
import { KnowledgeService } from '../services/knowledge-service';
import { Harness } from '../core/harness';
import type { AgentRegistry } from '../core/harness';
import { RequirementAgent } from '../agents/requirement-agent';
import { DesignAgent } from '../agents/design-agent';
import { ReviewAgent } from '../agents/review-agent';
import { CodingAgent } from '../agents/coding-agent';
import { DeliveryAgent } from '../agents/delivery-agent';
import { InMemoryWorkspace } from '../tools/in-memory-workspace';
import { StaticTestRunner } from '../tools/static-test-runner';
import { LocalSubprocessTestRunner } from '../tools/local-subprocess-test-runner';
import { Logger } from '../observability/logger';

/** CLI 参数解析结果 */
interface RunCliOptions {
  prdPath: string;
  outputDir: string;
  projectName: string;
  useKnowledge: boolean;
  verbose: boolean;
  /** 自动确认所有硬卡点（非交互模式，适合端到端验证） */
  autoConfirm: boolean;
  /** 恢复指定实例（issue #82：崩溃/重启后从状态快照续跑），优先于 PRD 路径 */
  resumeInstanceId?: string;
  /** 测试执行模式：subprocess=真实执行 vitest（默认，TDD 真实验证）；static=静态推断（快速通道） */
  testMode: 'static' | 'subprocess';
}

/** 解析 CLI 参数 */
function parseArgs(args: string[]): RunCliOptions {
  const options: RunCliOptions = {
    prdPath: '',
    outputDir: './output',
    projectName: 'default',
    useKnowledge: true,
    verbose: false,
    autoConfirm: false,
    resumeInstanceId: undefined,
    testMode: 'subprocess',
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--output' && args[i + 1]) {
      options.outputDir = args[++i];
    } else if (arg === '--project' && args[i + 1]) {
      options.projectName = args[++i];
    } else if (arg === '--no-knowledge') {
      options.useKnowledge = false;
    } else if (arg === '--verbose') {
      options.verbose = true;
    } else if (arg === '--auto-confirm') {
      options.autoConfirm = true;
    } else if (arg === '--resume' && args[i + 1]) {
      options.resumeInstanceId = args[++i];
    } else if (arg === '--test-mode' && args[i + 1]) {
      const mode = args[++i];
      if (mode === 'static' || mode === 'subprocess') options.testMode = mode;
      else console.warn(`[参数] 忽略未知测试模式 ${mode}（支持 static/subprocess），使用默认 subprocess`);
    } else if (!arg.startsWith('--')) {
      options.prdPath = arg;
    }
    i++;
  }

  return options;
}

/** 从 stdin 读取一行用户输入 */
function readLine(prompt: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * 运行 Forge 主流程
 */
export async function runForgeCli(args: string[]): Promise<void> {
  const options = parseArgs(args);

  const isResume = !!options.resumeInstanceId;
  if (!isResume && !options.prdPath) {
    console.error('错误: 请指定 PRD 文件路径（或使用 --resume <instanceId> 恢复实例）');
    console.error('用法: forge run <prd-path> [--output <dir>] [--project <name>] [--no-knowledge]');
    console.error('用法: forge run --resume <instanceId> [--output <dir>] [--project <name>]');
    process.exit(1);
  }

  // 1. 读取 PRD（仅新建流程需要；resume 从快照续跑不依赖 PRD 原文）
  let prdText = '';
  let prdFileName = '';
  if (!isResume) {
    const prdFullPath = path.resolve(options.prdPath);
    if (!fs.existsSync(prdFullPath)) {
      console.error(`错误: PRD 文件不存在: ${prdFullPath}`);
      process.exit(1);
    }
    prdText = fs.readFileSync(prdFullPath, 'utf-8');
    prdFileName = path.basename(prdFullPath);
  }

  console.log('========================================');
  console.log('  Forge - 需求到代码自动化智能体');
  console.log('========================================');
  if (isResume) {
    console.log(`恢复实例: ${options.resumeInstanceId}`);
  } else {
    console.log(`PRD 文件: ${path.resolve(options.prdPath)}`);
    console.log(`PRD 大小: ${prdText.length} 字符`);
  }
  console.log(`输出目录: ${path.resolve(options.outputDir)}`);
  console.log(`项目名称: ${options.projectName}`);
  console.log(`知识库: ${options.useKnowledge ? '启用' : '禁用'}`);
  console.log(`自动确认: ${options.autoConfirm ? '启用（非交互模式）' : '禁用（交互式）'}`);
  console.log(`测试模式: ${options.testMode === 'static' ? 'static 静态推断' : 'subprocess 真实执行 vitest'}`);
  console.log('========================================\n');

  // 2. 加载配置
  const config = getConfig();

  // 3. 创建输出目录和 Logger
  const projectOutputDir = path.join(options.outputDir, options.projectName);
  fs.mkdirSync(projectOutputDir, { recursive: true });

  const logger = new Logger({
    logDir: path.join(projectOutputDir, 'logs'),
    logLevel: options.verbose ? 'debug' : 'info',
    logLLMRequests: true,
  });

  // 4. 创建 LLM Provider（真实火山引擎）
  const llm = createLLMProvider(config.llm, { logger });
  console.log(`[初始化] LLM: ${config.llm.model} (${config.llm.provider})`);

  // 5. 创建知识库（可选）
  let knowledgeService: KnowledgeService | undefined;
  if (options.useKnowledge) {
    try {
      const embeddingProvider = createEmbeddingProvider(config.embedding);
      knowledgeService = KnowledgeService.getInstance({
        embeddingProvider,
        logger,
      });
      console.log(`[初始化] 知识库: 已启用 (${config.embedding.model}, ${config.embedding.dimensions}维)`);
      console.log('[初始化] 注意: v1 内存向量库，需在同进程内同步飞书文档后检索才有效');
    } catch (err) {
      console.warn(`[初始化] 知识库初始化失败，继续无知识库模式: ${(err as Error).message}`);
    }
  }

  // 7. 创建 Agents
  const workspace = new InMemoryWorkspace();
  // TDD 真实执行（issue #83）：默认子进程运行 vitest 验证代码逻辑，static 为快速通道（显式 --test-mode static）
  const testRunner =
    options.testMode === 'static'
      ? new StaticTestRunner()
      : new LocalSubprocessTestRunner({ fallbackToStatic: true });

  const agents: AgentRegistry = {
    requirement: new RequirementAgent(llm, { logger }),
    design: new DesignAgent(llm, { logger }),
    review: new ReviewAgent(llm, { logger }),
    coding: new CodingAgent(llm, {
      logger,
      workspace,
      testRunner,
      maxGreenAttempts: config.coding.maxTestRetriesPerStory,
    }),
    delivery: new DeliveryAgent(llm, {
      logger,
      deliveryConfig: {
        ...config.delivery,
        targetProjectPath: projectOutputDir,
      },
    }),
  };
  console.log('[初始化] Agents: requirement / design / review / coding / delivery 全部就绪');

  // 8. 创建 Harness（resume 时固定实例 ID，复用其磁盘产物与状态快照）
  const harness = new Harness({
    agents,
    knowledgeService,
    projectId: options.projectName,
    instanceId: isResume ? options.resumeInstanceId : undefined,
    globalContext: {
      techStack: 'React + TypeScript',
      projectConfig: { projectName: options.projectName },
    },
    projectContext: {
      projectRoot: projectOutputDir,
      srcDir: 'src',
      projectType: 'new',
    },
    maxRetries: config.retry.agentMaxRetries,
    maxReviewRounds: config.coding.maxDesignReviewRounds,
    maxGreenAttempts: config.coding.maxTestRetriesPerStory,
    weakConfirmationTimeoutMs: config.humanInteraction.weakConfirmationTimeoutMs,
    maxTokensPerRun: config.budget.maxTokensPerRun,
    maxTokensPerCall: config.budget.maxTokensPerCall,
    logger,

    // 硬卡点人工介入回调
    onHumanIntervention: async (state, question) => {
      console.log('\n' + '='.repeat(50));
      console.log(`🔴 硬卡点: ${state}`);
      console.log('='.repeat(50));
      console.log(question);
      console.log('');
      if (options.autoConfirm) {
        console.log('（自动确认模式，直接通过）');
        return '确认';
      }
      const answer = await readLine('请输入回答（直接回车表示确认/无补充）: ');
      return answer || '确认';
    },

    // 弱介入窗口回调（v1 自动 continue，不暂停）
    onWeakIntervention: async (_state, _context) => {
      // v1 弱介入模式：自动 continue，不阻塞
      return { action: 'continue' as const };
    },
  });

  console.log('[初始化] Harness 就绪，开始执行流水线...\n');
  console.log('-'.repeat(50));

  // 9. 启动流水线（resume：从快照续跑，不重复 start）
  const startTime = Date.now();
  let result = isResume
    ? await harness.continueFromSnapshot()
    : await harness.start(prdText, prdFileName);

  // 10. 处理硬卡点循环
  while (result.waitingForHuman) {
    console.log(`\n[状态] 当前: ${result.finalState}`);
    result = await harness.resume();
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  // 11. 输出最终结果
  console.log('\n' + '='.repeat(50));
  if (result.success) {
    console.log('✅ 流水线执行成功');
  } else {
    console.log('❌ 流水线执行失败');
  }
  console.log(`最终状态: ${result.finalState}`);
  console.log(`总耗时: ${duration}s`);
  if (result.message) {
    console.log(`消息: ${result.message}`);
  }
  console.log('='.repeat(50));

  // 12. 列出产物
  const artifacts = harness.listArtifacts();
  console.log('\n📦 产物列表:');
  for (const artifact of artifacts) {
    const data = artifact.data as Record<string, unknown>;
    const summary = typeof data?.summary === 'string' ? data.summary.slice(0, 60) : '';
    console.log(`  - [${artifact.stage}] ${artifact.id} (v${artifact.version}) ${summary}`);
  }

  // 13. 保存产物到输出目录
  const artifactsDir = path.join(projectOutputDir, 'artifacts');
  fs.mkdirSync(artifactsDir, { recursive: true });
  for (const artifact of artifacts) {
    const artifactPath = path.join(artifactsDir, `${artifact.stage}.json`);
    fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2), 'utf-8');
  }
  console.log(`\n💾 产物已保存到: ${artifactsDir}`);
  console.log(`📁 代码输出目录: ${projectOutputDir}`);

  if (!result.success) {
    process.exit(1);
  }
}
