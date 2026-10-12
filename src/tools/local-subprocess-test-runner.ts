/**
 * 本地子进程测试执行器（issue #83 落地：TDD 从"静态推断"升级为"真实执行"）
 *
 * 设计：
 * - 把工作区（内存 Workspace）内容落盘到临时目录，真实调用 vitest 子进程运行测试；
 * - 解析 vitest JSON reporter 输出，得到真实通过/失败/跳过/失败原因，喂回 TDD 红绿循环；
 * - red 阶段：只有测试无实现 → vitest 真实报 import 解析失败 → 红（真实）；
 *   假测试（不引用实现也能通过）→ 真实全绿 → CodingAgent 的 RED_SHOULD_FAIL 质量门捕获；
 * - 环境兜底：vitest 不可用 / spawn 失败 / 超时 / 无有效输出 → 降级 StaticTestRunner 并明确标注，
 *   保证"子进程执行不了"不会让流程整体失败（fallbackToStatic=false 时返回环境失败结果）。
 *
 * 与 v1"测试到 mock 级、保证基本逻辑"的约定一致：不依赖外部前端库的测试可真实跑通；
 * import 外部库的测试会真实失败并反馈错误信息，交由 CodingAgent 修复或如实标注。
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { TestResult } from '../types/coding-task';
import type { Workspace, TestRunner, TestRunOptions } from './types';
import { StaticTestRunner } from './static-test-runner';

/** LocalSubprocessTestRunner 选项 */
export interface LocalSubprocessOptions {
  /** 子进程执行超时（毫秒，默认 60000） */
  timeoutMs?: number;
  /** vitest 不可用/无有效输出时降级静态推断（默认 true） */
  fallbackToStatic?: boolean;
  /** 调试：保留临时目录（默认清理） */
  keepTempDir?: boolean;
  /** 显式指定 vitest 入口（默认在 forge 项目根 node_modules 定位） */
  vitestEntry?: string;
  /** 测试环境（默认 node，组件测试可传 jsdom） */
  environment?: 'node' | 'jsdom';
}

interface VitestAssertion {
  status: 'passed' | 'failed' | 'skipped';
  title: string;
  failureMessages?: string[];
}

interface VitestJsonOutput {
  testResults: Array<{
    assertionResults: VitestAssertion[];
    /** 文件级失败信息（收集/import 解析失败时 assertionResults 为空但有 message） */
    status?: string;
    message?: string;
    name?: string;
  }>;
  /** 顶层收集错误（部分 vitest 版本输出在此） */
  errors?: Array<{ message?: string; name?: string }>;
}

/** 解析 vitest JSON 输出为 TestResult 计数 */
function parseVitestOutput(json: string): {
  totalTests: number;
  passedTests: number;
  failedTests: number;
  skippedTests: number;
  failures: Array<{ testName: string; errorMessage: string }>;
} {
  let data: VitestJsonOutput;
  try {
    data = JSON.parse(json) as VitestJsonOutput;
  } catch {
    throw new Error('vitest 输出不是有效 JSON');
  }
  const suites = data.testResults ?? [];
  const assertions = suites.flatMap((r) => r.assertionResults ?? []);
  const passedTests = assertions.filter((a) => a.status === 'passed').length;
  const failedTests = assertions.filter((a) => a.status === 'failed').length;
  const skippedTests = assertions.filter((a) => a.status === 'skipped').length;
  const failures = assertions
    .filter((a) => a.status === 'failed')
    .map((a) => ({
      testName: a.title,
      errorMessage: a.failureMessages?.[0] ?? '测试失败（无错误信息）',
    }));

  // 收集级失败（import 解析失败、配置错误等）：该 suite 断言列表为空但 status=failed 且有 message。
  // 折算为失败项，保证 red/green 判定能看到真实失败原因。
  const collectErrors: Array<{ name: string; message: string }> = [];
  for (const s of suites) {
    if (s.status === 'failed' && (s.assertionResults ?? []).length === 0 && s.message) {
      collectErrors.push({ name: s.name ?? 'collect', message: s.message });
    }
  }
  for (const e of data.errors ?? []) {
    if (e.message) collectErrors.push({ name: e.name ?? 'collect', message: e.message });
  }
  if (assertions.length === 0 && collectErrors.length > 0) {
    for (const e of collectErrors) {
      failures.push({ testName: e.name, errorMessage: e.message });
    }
  }

  return {
    totalTests: assertions.length,
    passedTests,
    failedTests: assertions.length > 0 ? failedTests : collectErrors.length,
    skippedTests,
    failures,
  };
}

/** 定位 vitest 可执行入口：优先项目根 node_modules，找不到返回 undefined 由调用方降级 */
function resolveVitestEntry(cwd: string): string | undefined {
  const candidates = [
    path.join(cwd, 'node_modules', 'vitest', 'vitest.mjs'),
    path.join(cwd, 'node_modules', '.bin', 'vitest.cmd'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // 逐级向上查找（monorepo/上级安装场景）
  let dir = path.dirname(cwd);
  while (dir && dir !== path.dirname(dir)) {
    const up = path.join(dir, 'node_modules', 'vitest', 'vitest.mjs');
    if (fs.existsSync(up)) return up;
    dir = path.dirname(dir);
  }
  return undefined;
}

/** 工作区相对路径写盘时的安全转换：拒绝绝对路径与路径穿越 */
function safeJoin(root: string, rel: string): string {
  const normalized = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  const target = path.resolve(root, normalized);
  const rootResolved = path.resolve(root);
  if (!target.startsWith(rootResolved + path.sep) && target !== rootResolved) {
    throw new Error(`非法文件路径（路径穿越）: ${rel}`);
  }
  return target;
}

/**
 * 本地子进程测试执行器：真实运行 vitest，解析输出。
 */
export class LocalSubprocessTestRunner implements TestRunner {
  readonly kind = 'subprocess' as const;
  private readonly timeoutMs: number;
  private readonly fallbackToStatic: boolean;
  private readonly keepTempDir: boolean;
  private readonly vitestEntry?: string;
  private readonly environment: 'node' | 'jsdom';
  private readonly staticRunner: StaticTestRunner;

  constructor(options?: LocalSubprocessOptions) {
    this.timeoutMs = options?.timeoutMs ?? 60000;
    this.fallbackToStatic = options?.fallbackToStatic ?? true;
    this.keepTempDir = options?.keepTempDir ?? false;
    this.vitestEntry = options?.vitestEntry;
    this.environment = options?.environment ?? 'node';
    this.staticRunner = new StaticTestRunner();
  }

  async run(workspace: Workspace, options: TestRunOptions): Promise<TestResult> {
    // 环境不可用降级点：spawn 失败 / vitest 不存在 / 超时 / 无有效输出
    try {
      return await this.runSubprocess(workspace, options);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (this.fallbackToStatic) {
        const staticResult = await this.staticRunner.run(workspace, options);
        return {
          ...staticResult,
          environment: 'sandbox',
          outputSummary:
            `[subprocess] 子进程执行失败，已降级静态推断: ${reason}。` + staticResult.outputSummary,
        };
      }
      return {
        totalTests: 0,
        passedTests: 0,
        failedTests: 0,
        skippedTests: 0,
        environment: 'sandbox',
        allPassed: false,
        outputSummary: `[subprocess] 测试执行失败（未降级）: ${reason}`,
        failures: [{ testName: 'subprocess', errorMessage: reason }],
      };
    }
  }

  private async runSubprocess(
    workspace: Workspace,
    options: TestRunOptions,
  ): Promise<TestResult> {
    // 临时目录建在项目根 .sandbox 下：测试文件 import 'vitest' 等依赖可沿目录树向上解析到项目 node_modules。
    // （放在系统临时目录会导致 import 'vitest' 解析失败，全部测试报模块找不到）
    const sandboxRoot = path.join(process.cwd(), '.sandbox');
    fs.mkdirSync(sandboxRoot, { recursive: true });
    const tmpDir = fs.mkdtempSync(path.join(sandboxRoot, 'tdd-'));
    const keep = this.keepTempDir;
    try {
      // 1. 落盘工作区文件（跳过空路径）
      const files = workspace.listFiles();
      if (files.length === 0) {
        return {
          totalTests: 0,
          passedTests: 0,
          failedTests: 0,
          skippedTests: 0,
          environment: 'sandbox',
          allPassed: false,
          outputSummary: '[subprocess] 工作区为空，无测试可执行',
          failures: [{ testName: 'workspace', errorMessage: '工作区没有文件' }],
        };
      }
      for (const rel of files) {
        const content = workspace.readFile(rel);
        if (content === undefined) continue;
        const target = safeJoin(tmpDir, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content, 'utf-8');
      }

      // 2. 写 vitest 配置（include 测试文件，环境 node/jsdom）
      const vitestConfig = path.join(tmpDir, 'vitest.config.ts');
      fs.writeFileSync(
        vitestConfig,
        [
          "import { defineConfig } from 'vitest/config';",
          'export default defineConfig({',
          `  test: { include: ['**/*.{test,spec}.{ts,tsx,js,jsx}'], environment: '${this.environment}' },`,
          '});',
          '',
        ].join('\n'),
        'utf-8',
      );

      // 3. 定位 vitest 入口并启动子进程
      const entry =
        this.vitestEntry ?? resolveVitestEntry(process.cwd());
      if (!entry) {
        throw new Error('未找到 vitest 可执行入口（node_modules/vitest 不存在）');
      }
      const outputFile = path.join(tmpDir, 'vitest-output.json');
      const args = [
        entry,
        'run',
        '--root',
        tmpDir,
        '--config',
        vitestConfig,
        '--reporter=json',
        '--outputFile',
        outputFile,
      ];
      const stdout = await this.execNode(args, outputFile);

      // 4. 解析输出
      let jsonText = '';
      if (fs.existsSync(outputFile)) {
        jsonText = fs.readFileSync(outputFile, 'utf-8');
      } else {
        // 兼容 stdout 直接输出 JSON 的情况
        jsonText = stdout;
      }
      if (!jsonText.trim()) {
        throw new Error('vitest 无输出（测试可能未匹配到文件或启动异常）');
      }
      const parsed = parseVitestOutput(jsonText);
      const base = {
        totalTests: parsed.totalTests,
        skippedTests: parsed.skippedTests,
        environment: 'sandbox' as const,
      };

      // 5. red 阶段语义与 green 一致：真实结果为准（CodingAgent 负责 RED_SHOULD_FAIL 判定）
      const allPassed = parsed.failedTests === 0 && parsed.totalTests > 0;
      return {
        ...base,
        passedTests: parsed.passedTests,
        failedTests: parsed.failedTests,
        allPassed,
        failures: parsed.failures.length > 0 ? parsed.failures : undefined,
        outputSummary:
          `[subprocess] ${options.phase} 阶段真实执行 vitest：共 ${parsed.totalTests} 个用例，` +
          `通过 ${parsed.passedTests}、失败 ${parsed.failedTests}、跳过 ${parsed.skippedTests}`,
      };
    } finally {
      if (!keep) {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // 清理失败不影响结果
        }
      }
    }
  }

  /** spawn node 执行 vitest，带超时；返回 stdout */
  private execNode(args: string[], outputFile?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: process.cwd(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(new Error(`测试执行超时（${this.timeoutMs}ms）`));
      }, this.timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf-8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8');
      });
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`无法启动 vitest 子进程: ${err.message}`));
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // 非零退出且连输出文件都没写出来：属于环境错误（vitest 不可用/配置损坏），而非测试失败。
        // vitest 用例失败时 exit code 非 0，但 JSON reporter 仍会写出 outputFile，以 JSON 为准。
        if (code !== 0 && outputFile && !fs.existsSync(outputFile)) {
          reject(new Error(`vitest 运行失败（exit ${code}）: ${stderr.slice(0, 500) || '无错误输出'}`));
          return;
        }
        resolve(stdout);
      });
    });
  }
}
