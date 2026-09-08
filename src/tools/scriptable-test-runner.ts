import type { TestResult } from '../types/coding-task';
import type { TestRunner, Workspace, TestRunOptions } from './types';

/**
 * 脚本化测试执行器（仅用于单元/集成测试）：按调用顺序返回预置结果，
 * 用于确定性模拟"red 失败 → green 一次失败再修复 → green 通过"等 TDD 过程。
 */
export class ScriptableTestRunner implements TestRunner {
  readonly kind = 'scriptable' as const;
  private queue: TestResult[];
  private calls: Array<{ phase: TestRunOptions['phase']; fileCount: number }> = [];

  constructor(scripted: TestResult[]) {
    this.queue = [...scripted];
  }

  async run(workspace: Workspace, options: TestRunOptions): Promise<TestResult> {
    this.calls.push({ phase: options.phase, fileCount: workspace.listFiles().length });
    const next = this.queue.shift();
    if (!next) {
      throw new Error('ScriptableTestRunner: 预置结果已耗尽，请检查测试编排的调用次数');
    }
    return next;
  }

  /** 测试断言用：记录每次 run 的阶段与当时工作区文件数 */
  getCallLog(): ReadonlyArray<{ phase: TestRunOptions['phase']; fileCount: number }> {
    return this.calls;
  }
}
