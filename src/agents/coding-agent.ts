/**
 * 编码 Agent - 阶段5（单故事 TDD 生成）
 *
 * 职责（混合 TDD，方案丙：可替换工具层，v1 默认内存工作区 + 静态推断 runner）：
 *   RED：生成测试 + mock（标准 execute，只写测试不写实现）→ 工作区内运行，预期失败（红）
 *   GREEN：生成最小实现 → 运行通过（绿）；失败则把失败信息喂回，在 maxGreenAttempts 内修复
 *   单故事产出 CodingResult；逐故事循环与部分成功出口（#40）由 Harness.runCodingPhase 负责
 *
 * 设计约束：
 * - 规范 8.3：TDD 的 red/green 是"同一产物的不同阶段"，这里不按 input.type 分发，
 *   red 走标准 execute，green 通过独立构造 runAgentCycle hooks 实现；CR 内修改（revise）随后续迭代
 * - 规范 1.14：测试是否通过以 TestRunner 结果为准、AC 覆盖以程序化映射校验，不采信 LLM 自报
 */

import { BaseAgent } from './base';
import type { AgentContext, AgentError, AgentResult, AgentConfig } from './types';
import type { LLMProvider } from '../llm/provider';
import type { Logger } from '../observability/logger';
import type { KnowledgeItem } from '../types/knowledge';
import type {
  CodingTask,
  CodingResult,
  GeneratedFile,
  TestResult,
  TddCycle,
} from '../types/coding-task';
import { InMemoryWorkspace, StaticTestRunner, type Workspace, type TestRunner } from '../tools';
import {
  findMissingTestedAcs,
  coveredAcsFromMapping,
  mergeGeneratedFiles,
  deriveStoryStatus,
} from '../core/coding-validation';
import { findUnansweredIssues } from '../core/review-policy';
import type { ReviewIssue } from '../types/review-and-delivery';
import type { CodeRevision, IssueResponse } from '../types/review-dialog';
import {
  CODING_RED_SYSTEM_PROMPT,
  CODING_GREEN_SYSTEM_PROMPT,
  CODING_REVISE_SYSTEM_PROMPT,
} from '../prompts/coding/system-prompts';
import {
  renderCodingRedUserPrompt,
  renderCodingGreenUserPrompt,
  renderCodeReviseUserPrompt,
} from '../prompts/coding/user-prompts';

/** RED 阶段 LLM 原始输出 */
interface RawRedOutput {
  testFiles?: GeneratedFile[];
  mockFiles?: GeneratedFile[];
  acTestMapping?: Record<string, string[]>;
}

interface RedTddOutput {
  testFiles: GeneratedFile[];
  mockFiles: GeneratedFile[];
  acTestMapping: Record<string, string[]>;
}

/** GREEN 阶段一次 LLM 周期的输入（任务 + red 摘要 + 上轮失败） */
interface GreenCycleInput {
  task: CodingTask;
  redSummary: string;
  lastFailures: NonNullable<TestResult['failures']>;
  attempt: number;
}

interface RawGreenOutput {
  implFiles?: GeneratedFile[];
  updatedTestFiles?: GeneratedFile[];
  needsDesignFallback?: boolean;
  fallbackReason?: string;
}

interface GreenTddOutput {
  implFiles: GeneratedFile[];
  updatedTestFiles: GeneratedFile[];
  needsDesignFallback: boolean;
  fallbackReason?: string;
}

/** CR 修订阶段输入（独立于 generate，规范 8.3） */
export interface CodeReviseInput {
  type: 'revise-code';
  task: CodingTask;
  currentResult: CodingResult;
  previousIssues: ReviewIssue[];
  /** 当前评审轮次（revise 发生在第 round 轮评审之后，从 2 开始） */
  round: number;
}

interface RawCodeReviseOutput {
  changeSummary?: string;
  changedFiles?: string[];
  issueResponses?: Array<Partial<IssueResponse> & { issueId?: string }>;
  updatedFiles?: GeneratedFile[];
  needsDesignFallback?: boolean;
  fallbackReason?: string;
}

export interface CodingAgentOptions {
  config?: AgentConfig;
  logger?: Logger; /** 文件工作区，默认内存实现 */
  workspace?: Workspace;
  /** 测试执行器，默认静态推断 runner */
  testRunner?: TestRunner;
  /** green 最大修复尝试次数，默认 5 */
  maxGreenAttempts?: number;
}

const FILE_TYPES = new Set<GeneratedFile['type']>([
  'component',
  'test',
  'store',
  'type',
  'api',
  'util',
  'config',
  'mock',
]);

/** 测试文件路径正则（用于 LLM 未显式指定 type 时按路径推断） */
const TEST_FILE_PATH_RE = /\.(test|spec)\.[jt]sx?$|__tests__\//;

function normalizeFiles(files: unknown, expectedType: GeneratedFile['type']): GeneratedFile[] {
  if (!Array.isArray(files)) return [];
  return files
    .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
    .map((f) => ({
      path: String(f.path ?? ''),
      type: (FILE_TYPES.has(f.type as GeneratedFile['type'])
        ? f.type
        : expectedType) as GeneratedFile['type'],
      operation: (f.operation === 'modify' || f.operation === 'reuse'
        ? f.operation
        : 'create') as GeneratedFile['operation'],
      summary: String(f.summary ?? ''),
      content: f.content === undefined ? undefined : String(f.content),
      componentId: f.componentId === undefined ? undefined : String(f.componentId),
      relatedAcIds: Array.isArray(f.relatedAcIds) ? f.relatedAcIds.map(String) : undefined,
    }));
}

export class CodingAgent extends BaseAgent<CodingTask, RedTddOutput> {
  readonly name = 'coding-agent';
  readonly version = '0.1.0';

  private readonly workspace: Workspace;
  private readonly testRunner: TestRunner;
  private readonly maxGreenAttempts: number;

  constructor(llm: LLMProvider, options?: CodingAgentOptions) {
    super(llm, options);
    this.workspace = options?.workspace ?? new InMemoryWorkspace();
    this.testRunner = options?.testRunner ?? new StaticTestRunner();
    this.maxGreenAttempts = options?.maxGreenAttempts ?? 5;
  }

  // ============================================================
  // RED 阶段（标准 execute 模板方法）
  // ============================================================

  protected validateInput(input: CodingTask): AgentError[] {
    const errors: AgentError[] = [];
    if (!input?.storyId)
      errors.push({ code: 'NO_STORY', message: '编码任务缺少 storyId', severity: 'error' });
    if (!input.acceptanceCriteria?.some((ac) => ac.testable)) {
      errors.push({
        code: 'NO_TESTABLE_AC',
        message: `故事 ${input.storyId ?? ''} 没有可测试的 AC`,
        severity: 'error',
      });
    }
    if (!input.techStack?.testFramework) {
      errors.push({ code: 'NO_TEST_FRAMEWORK', message: '技术栈缺少测试框架', severity: 'error' });
    }
    return errors;
  }

  protected async retrieveKnowledge(
    input: CodingTask,
    context: AgentContext,
  ): Promise<KnowledgeItem[]> {
    return this.searchKnowledge(context, [
      { query: `${input.storyTitle} 前端组件实现规范`, topK: 5 },
      {
        query: `${input.techStack.framework} ${input.techStack.stateLibrary} 状态管理用法`,
        topK: 3,
      },
    ]);
  }

  protected buildSystemPrompt(): string {
    return CODING_RED_SYSTEM_PROMPT;
  }

  protected async buildUserPrompt(input: CodingTask): Promise<string> {
    return renderCodingRedUserPrompt(input);
  }

  protected parseOutput(content: string): RedTddOutput {
    const parsed = this.parseJsonWithRecovery<RawRedOutput>(this.extractJsonObject(content));
    const testFiles = normalizeFiles(parsed.testFiles, 'test');
    const mockFiles = normalizeFiles(parsed.mockFiles, 'mock');
    const acTestMapping: Record<string, string[]> = {};
    for (const [acId, tests] of Object.entries(parsed.acTestMapping ?? {})) {
      acTestMapping[acId] = Array.isArray(tests) ? tests.map(String) : [];
    }
    return { testFiles, mockFiles, acTestMapping };
  }

  protected validateOutput(output: RedTddOutput, input: CodingTask): AgentError[] {
    const errors: AgentError[] = [];
    if (output.testFiles.length === 0) {
      errors.push({
        code: 'NO_TEST_FILES',
        message: 'RED 阶段必须产出至少一个测试文件',
        severity: 'error',
      });
    }
    const noContent = output.testFiles.filter((f) => !f.path || !f.content);
    if (noContent.length > 0) {
      errors.push({
        code: 'EMPTY_TEST',
        message: `存在缺少路径或内容的测试文件: ${noContent.map((f) => f.path).join(',')}`,
        severity: 'error',
      });
    }
    const covered = coveredAcsFromMapping(output.acTestMapping);
    const missing = findMissingTestedAcs(input, covered);
    if (missing.length > 0) {
      errors.push({
        code: 'MISSING_AC_TEST',
        message: `以下可测试 AC 缺少测试映射: ${missing.join(', ')}`,
        severity: 'error',
      });
    }
    return errors;
  }

  protected selfCheck(output: RedTddOutput, input: CodingTask): AgentError[] {
    const warnings: AgentError[] = [];
    if (input.apiContracts.length > 0 && output.mockFiles.length === 0) {
      warnings.push({
        code: 'NO_MOCK',
        message: `故事 ${input.storyId} 涉及 API 但未产出 mock 文件`,
        severity: 'warning',
      });
    }
    return warnings;
  }

  // ============================================================
  // GREEN 阶段 hooks（独立构造，不走 input.type 分发）
  // ============================================================

  private validateGreenInput(): AgentError[] {
    return [];
  }

  private parseGreenOutput(content: string): GreenTddOutput {
    const parsed = this.parseJsonWithRecovery<RawGreenOutput>(this.extractJsonObject(content));
    return {
      implFiles: normalizeFiles(parsed.implFiles, 'component'),
      updatedTestFiles: normalizeFiles(parsed.updatedTestFiles, 'test'),
      needsDesignFallback: parsed.needsDesignFallback === true,
      fallbackReason: parsed.fallbackReason ? String(parsed.fallbackReason) : undefined,
    };
  }

  private validateGreenOutput(output: GreenTddOutput): AgentError[] {
    const errors: AgentError[] = [];
    if (!output.needsDesignFallback && output.implFiles.length === 0) {
      errors.push({
        code: 'NO_IMPL_FILES',
        message: 'GREEN 阶段必须产出实现文件，或显式 needsDesignFallback',
        severity: 'error',
      });
    }
    const bad = output.implFiles.filter((f) => !f.path || !f.content);
    if (bad.length > 0) {
      errors.push({
        code: 'EMPTY_IMPL',
        message: `存在缺少路径或内容的实现文件: ${bad.map((f) => f.path).join(',')}`,
        severity: 'error',
      });
    }
    return errors;
  }

  // ============================================================
  // 单故事 TDD 编排（Harness 逐故事调用）
  // ============================================================

  async generateCode(context: AgentContext): Promise<AgentResult<CodingResult>> {
    const startTime = Date.now();
    const task = context.input as CodingTask;
    let llmCalls = 0;
    const tddCycles: TddCycle[] = [];

    // 每故事独立沙箱
    this.workspace.clear();

    // ---------- RED ----------
    const redResult = await this.execute({ ...context, input: task });
    llmCalls += redResult.llmCalls;
    if (!redResult.success || !redResult.data) {
      return {
        success: false,
        errors: redResult.errors,
        durationMs: Date.now() - startTime,
        llmCalls,
        retries: redResult.retries,
      };
    }
    const red = redResult.data;
    const expectedAcIds = task.acceptanceCriteria.filter((ac) => ac.testable).map((ac) => ac.id);
    this.writeToWorkspace([...red.testFiles, ...red.mockFiles]);

    const redStart = Date.now();
    const redRun = await this.testRunner.run(this.workspace, { phase: 'red', expectedAcIds });
    tddCycles.push({
      cycle: 1,
      phase: 'red',
      action: '生成测试与 mock 并运行（预期失败）',
      testResult: redRun.allPassed ? 'pass' : 'fail',
      durationMs: Date.now() - redStart,
    });

    // 质量门：red 必须失败；若直接通过，说明测试未依赖实现（假测试）
    if (redRun.allPassed) {
      return {
        success: false,
        errors: [
          {
            code: 'RED_SHOULD_FAIL',
            message: 'RED 阶段在缺少实现时测试竟然通过，疑似假测试',
            severity: 'error',
          },
        ],
        durationMs: Date.now() - startTime,
        llmCalls,
        retries: 0,
      };
    }

    // ---------- GREEN / FIX 循环 ----------
    const redSummary = JSON.stringify({
      testFiles: red.testFiles.map((f) => ({ path: f.path, relatedAcIds: f.relatedAcIds })),
      mockFiles: red.mockFiles.map((f) => f.path),
      acTestMapping: red.acTestMapping,
    });

    let lastRun: TestResult = redRun;
    let green: GreenTddOutput | undefined;
    let lastFailures: NonNullable<TestResult['failures']> = redRun.failures ?? [];
    let cycleErrors: AgentError[] = [];

    for (let attempt = 1; attempt <= this.maxGreenAttempts; attempt++) {
      const greenInput: GreenCycleInput = { task, redSummary, lastFailures, attempt };
      const cycle = await this.runAgentCycle<GreenCycleInput, GreenTddOutput>({
        input: greenInput,
        context,
        validateInput: () => this.validateGreenInput(),
        retrieveKnowledge: (i, ctx) => this.retrieveKnowledge(i.task, ctx),
        buildSystemPrompt: () => CODING_GREEN_SYSTEM_PROMPT,
        buildUserPrompt: (i) =>
          Promise.resolve(
            renderCodingGreenUserPrompt(i.task, {
              redSummary: i.redSummary,
              lastFailures: i.lastFailures,
              attempt: i.attempt,
            }),
          ),
        parseOutput: (content) => this.parseGreenOutput(content),
        validateOutput: (out) => this.validateGreenOutput(out),
        selfCheck: () => [],
      });
      llmCalls += cycle.llmCalls;

      if (!cycle.success || !cycle.data) {
        cycleErrors = cycle.errors;
        lastFailures = cycle.errors.map((e) => ({ testName: e.code, errorMessage: e.message }));
        continue;
      }

      const candidate = cycle.data;
      this.writeToWorkspace([...candidate.implFiles, ...candidate.updatedTestFiles]);
      const gStart = Date.now();
      lastRun = await this.testRunner.run(this.workspace, { phase: 'green', expectedAcIds });
      tddCycles.push({
        cycle: attempt + 1,
        phase: 'green',
        action:
          attempt === 1
            ? '生成最小实现并运行（预期转绿）'
            : `根据第 ${attempt - 1} 次失败最小修复后重跑`,
        testResult: lastRun.allPassed ? 'pass' : 'fail',
        durationMs: Date.now() - gStart,
      });

      if (candidate.needsDesignFallback) {
        // 方案性问题：停止编码，交由 Harness 决定是否回退阶段3
        green = candidate;
        lastRun = { ...lastRun, allPassed: false, failedTests: lastRun.totalTests, passedTests: 0 };
        break;
      }

      if (lastRun.allPassed) {
        green = candidate;
        break;
      }
      lastFailures = lastRun.failures ?? [];
    }

    // ---------- 汇总 ----------
    const coveredAcs = new Set(coveredAcsFromMapping(red.acTestMapping));
    for (const f of green?.updatedTestFiles ?? []) {
      for (const ac of f.relatedAcIds ?? []) coveredAcs.add(ac);
    }
    const missingAcIds = findMissingTestedAcs(task, coveredAcs);
    const greenPassed = !!green && !green.needsDesignFallback && lastRun.allPassed;
    const attemptsExhausted = !greenPassed;
    const status = deriveStoryStatus({ greenPassed, missingAcIds, attemptsExhausted });

    const files = mergeGeneratedFiles(
      red.testFiles,
      red.mockFiles,
      green?.implFiles ?? [],
      green?.updatedTestFiles ?? [],
    );

    const issues: string[] = [];
    issues.push(...redResult.errors.filter((e) => e.severity === 'warning').map((e) => e.message));
    issues.push(...cycleErrors.map((e) => e.message));
    if (green?.needsDesignFallback && green.fallbackReason) issues.push(green.fallbackReason);
    if (!greenPassed) {
      issues.push(...(lastRun.failures ?? []).map((f) => `${f.testName}: ${f.errorMessage}`));
    }

    const result: CodingResult = {
      id: `coding-${task.storyId}`,
      instanceId: task.instanceId,
      taskId: task.taskId,
      storyId: task.storyId,
      status,
      files,
      testResult: lastRun,
      tddCycles,
      failedAcIds: missingAcIds.length > 0 ? missingAcIds : undefined,
      issues: issues.length > 0 ? issues : undefined,
      needsDesignFallback: green?.needsDesignFallback === true,
      fallbackReason: green?.fallbackReason,
      completedAt: new Date().toISOString(),
    };

    return {
      // partial 仍交付可用产物，算成功；failed 才算 Agent 失败
      success: status !== 'failed',
      data: result,
      errors: redResult.errors.filter((e) => e.severity === 'warning'),
      durationMs: Date.now() - startTime,
      llmCalls,
      retries: 0,
    };
  }

  private writeToWorkspace(files: GeneratedFile[]): void {
    for (const f of files) {
      if (f.path && f.content !== undefined) this.workspace.writeFile(f.path, f.content);
    }
  }

  // ============================================================
  // CR 修订阶段（评审多轮对话内的代码修改，规范 8.3）
  // ============================================================

  /**
   * 复用 runAgentCycle 的重试/日志骨架，使用 revise 专属的输入输出与钩子。
   * parseOutput 构造 CodeRevision（文件已合并，testResult 暂用当前值），
   * 方法返回前异步重跑 TestRunner 并更新 updatedResult 的 testResult/status/tddCycles。
   */
  async revise(context: AgentContext): Promise<AgentResult<CodeRevision>> {
    const input = context.input as CodeReviseInput;
    const result = await this.runAgentCycle<CodeReviseInput, CodeRevision>({
      input,
      context,
      validateInput: (i) => this.validateReviseInput(i),
      retrieveKnowledge: (i, ctx) =>
        this.searchKnowledge(ctx, [
          {
            query: `代码修订 ${i.task.storyTitle}`,
            types: ['component', 'api', 'pattern'],
            topK: 5,
          },
        ]),
      buildSystemPrompt: () => CODING_REVISE_SYSTEM_PROMPT,
      buildUserPrompt: async (i) =>
        renderCodeReviseUserPrompt({
          task: i.task,
          currentResult: i.currentResult,
          previousIssues: i.previousIssues,
          round: i.round,
        }),
      parseOutput: (content, i) => this.parseReviseOutput(content, i),
      validateOutput: (output, i) => this.validateReviseOutput(output, i),
      selfCheck: () => [],
    });

    if (!result.success || !result.data) return result;

    // 后处理：把合并后的文件写入工作区，重跑测试，更新状态
    const revision = result.data;
    const updated = revision.updatedResult;
    this.workspace.clear();
    this.writeToWorkspace(updated.files);
    // expectedAcIds 为任务中所有可测试 AC（与 generateCode 一致），StaticTestRunner 据此检查覆盖
    const expectedAcIds = input.task.acceptanceCriteria
      .filter((ac) => ac.testable)
      .map((ac) => ac.id);
    const testResult = await this.testRunner.run(this.workspace, {
      phase: 'green',
      expectedAcIds,
    });
    // coveredAcIds 仅从测试文件提取（实现文件的 relatedAcIds 不代表测试覆盖），与 generateCode 一致
    const coveredAcIds = updated.files
      .filter((f) => f.type === 'test')
      .flatMap((f) => f.relatedAcIds ?? []);
    updated.testResult = testResult;
    updated.tddCycles.push({
      cycle: updated.tddCycles.length + 1,
      phase: 'refactor',
      action: `CR 第 ${input.round} 轮修订`,
      testResult: testResult.allPassed ? 'pass' : 'fail',
      durationMs: 0,
    });
    const missingAcIds = findMissingTestedAcs(input.task, coveredAcIds);
    updated.failedAcIds = missingAcIds.length > 0 ? missingAcIds : undefined;
    updated.status = deriveStoryStatus({
      greenPassed: testResult.allPassed,
      missingAcIds,
      attemptsExhausted: false,
    });
    updated.completedAt = new Date().toISOString();
    return result;
  }

  private validateReviseInput(input: CodeReviseInput): AgentError[] {
    const errors: AgentError[] = [];
    if (!input.task)
      errors.push({ code: 'NO_TASK', message: 'revise 需要编码任务', severity: 'error' });
    if (!input.currentResult)
      errors.push({
        code: 'NO_CURRENT_RESULT',
        message: 'revise 需要当前编码结果',
        severity: 'error',
      });
    if (!input.previousIssues || input.previousIssues.length === 0)
      errors.push({
        code: 'NO_PREVIOUS_ISSUES',
        message: '没有上一轮 open 问题却触发了 revise，请确认流程是否正确',
        severity: 'error',
      });
    return errors;
  }

  private parseReviseOutput(content: string, input: CodeReviseInput): CodeRevision {
    const jsonStr = this.extractJsonObject(content);
    const parsed = this.parseJsonWithRecovery<RawCodeReviseOutput>(jsonStr);
    // normalizeFiles 默认类型为 component；若 LLM 未显式指定 type，则按路径推断测试文件
    const updatedFiles = normalizeFiles(parsed.updatedFiles, 'component').map((f) => {
      if (f.type !== 'component') return f; // LLM 已指定类型，不覆盖
      if (TEST_FILE_PATH_RE.test(f.path)) return { ...f, type: 'test' as const };
      return f;
    });
    const mergedFiles = mergeGeneratedFiles(input.currentResult.files, updatedFiles);
    const issueResponses: IssueResponse[] = (parsed.issueResponses ?? []).map((r) => ({
      issueId: String(r.issueId ?? ''),
      action:
        r.action === 'wont-fix' || r.action === 'needs-discussion' ? r.action : ('fixed' as const),
      explanation: String(r.explanation ?? ''),
    }));
    return {
      changeSummary: parsed.changeSummary ?? '',
      changedFiles: parsed.changedFiles ?? updatedFiles.map((f) => f.path),
      issueResponses,
      updatedResult: {
        ...input.currentResult,
        files: mergedFiles,
        needsDesignFallback: parsed.needsDesignFallback ?? input.currentResult.needsDesignFallback,
        fallbackReason: parsed.fallbackReason ?? input.currentResult.fallbackReason,
      },
    };
  }

  private validateReviseOutput(output: CodeRevision, input: CodeReviseInput): AgentError[] {
    const errors: AgentError[] = [];
    const unanswered = findUnansweredIssues(input.previousIssues, output.issueResponses);
    for (const u of unanswered) {
      errors.push({
        code: 'MISSING_ISSUE_RESPONSE',
        message: `问题 ${u.issueId} 缺少逐项回应：${u.reason}`,
        severity: 'error',
      });
    }
    if (output.updatedResult.files.length === 0) {
      errors.push({ code: 'NO_UPDATED_FILES', message: '修订后没有任何文件', severity: 'error' });
    }
    return errors;
  }
}
