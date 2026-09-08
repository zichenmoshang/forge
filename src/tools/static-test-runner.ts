import type { TestResult } from '../types/coding-task';
import type { TestRunner, Workspace } from './types';

const TEST_FILE_RE = /\.(test|spec)\.[jt]sx?$/;
const TEST_DIR_RE = /__tests__\//;
// mock 数据文件不算业务实现（red 阶段允许与测试同时存在）
const MOCK_FILE_RE = /\.mock\.[jt]sx?$|__mocks__\//;
const SOURCE_RE = /\.[jt]sx?$/;
/** 静态统计用例数：匹配 it( / test( 调用 */
const TEST_CASE_RE = /\b(?:it|test)\s*\(/g;

function isTestFile(path: string): boolean {
  return TEST_FILE_RE.test(path) || TEST_DIR_RE.test(path);
}

function isMockFile(path: string): boolean {
  return MOCK_FILE_RE.test(path);
}

/**
 * 静态推断测试执行器（v1 默认）。
 *
 * 不真实起子进程，而是依据工作区内"测试文件/实现文件是否齐备、每个期望 AC 是否被某测试引用、
 * 测试用例计数"确定性推断 TestResult，并在 outputSummary 明确标注"未真实执行"。
 * 真实执行能力由 v2 的子进程 runner 提供；编排层只消费 TestResult，不关心其来源。
 */
export class StaticTestRunner implements TestRunner {
  readonly kind = 'static' as const;

  async run(
    workspace: Workspace,
    options: { phase: 'red' | 'green'; expectedAcIds?: string[] },
  ): Promise<TestResult> {
    const allPaths = workspace.listFiles();
    const testPaths = allPaths.filter(isTestFile);
    const implPaths = allPaths.filter((p) => SOURCE_RE.test(p) && !isTestFile(p) && !isMockFile(p));

    const totalTests = testPaths.reduce((sum, p) => {
      const content = workspace.readFile(p) ?? '';
      return sum + (content.match(TEST_CASE_RE)?.length ?? 0);
    }, 0);

    const testContents = testPaths.map((p) => workspace.readFile(p) ?? '').join('\n');
    const missingAcCoverage = (options.expectedAcIds ?? []).filter(
      (acId) => !testContents.includes(acId),
    );

    const base = {
      totalTests,
      skippedTests: 0,
      environment: 'sandbox' as const,
    };

    if (options.phase === 'red') {
      // red 阶段：只有测试、尚无实现，预期失败（实现缺失导致无法通过）
      const implMissing = implPaths.length === 0;
      const failures =
        implMissing && totalTests > 0
          ? [{ testName: 'red-phase', errorMessage: '实现代码尚不存在，测试无法通过（预期的红）' }]
          : [];
      const allPassed = !implMissing && totalTests > 0 && missingAcCoverage.length === 0;
      return {
        ...base,
        passedTests: allPassed ? totalTests : 0,
        failedTests: allPassed ? 0 : totalTests,
        allPassed,
        failures,
        outputSummary: `[static] red 阶段静态推断：测试文件 ${testPaths.length} 个、实现文件 ${implPaths.length} 个、用例 ${totalTests} 个（未真实执行测试命令）`,
      };
    }

    // green 阶段：测试与实现都应齐备，且每个期望 AC 都有测试引用
    const failures: NonNullable<TestResult['failures']> = [];
    if (testPaths.length === 0)
      failures.push({ testName: 'workspace', errorMessage: '缺少测试文件' });
    if (implPaths.length === 0)
      failures.push({ testName: 'workspace', errorMessage: '缺少实现文件' });
    if (totalTests === 0)
      failures.push({
        testName: 'workspace',
        errorMessage: '测试文件中未发现 it/test 用例（疑似假测试）',
      });
    for (const acId of missingAcCoverage) {
      failures.push({
        testName: 'ac-coverage',
        errorMessage: `验收标准 ${acId} 没有任何测试引用`,
        relatedAcId: acId,
      });
    }

    const allPassed = failures.length === 0;
    return {
      ...base,
      passedTests: allPassed ? totalTests : 0,
      failedTests: allPassed ? 0 : totalTests,
      allPassed,
      failures: allPassed ? undefined : failures,
      outputSummary: `[static] green 阶段静态推断：测试文件 ${testPaths.length} 个、实现文件 ${implPaths.length} 个、用例 ${totalTests} 个、缺失AC覆盖 ${missingAcCoverage.length} 个（未真实执行测试命令）`,
    };
  }
}
