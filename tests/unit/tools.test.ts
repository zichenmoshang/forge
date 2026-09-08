import { describe, it, expect } from 'vitest';
import { InMemoryWorkspace } from '../../src/tools/in-memory-workspace';
import { StaticTestRunner } from '../../src/tools/static-test-runner';
import { ScriptableTestRunner } from '../../src/tools/scriptable-test-runner';
import type { TestResult } from '../../src/types/coding-task';

describe('InMemoryWorkspace', () => {
  it('路径规范化（反斜杠/./前导斜杠视为同一文件），读写列举清空', () => {
    const ws = new InMemoryWorkspace();
    ws.writeFile('src\\a.ts', 'A');
    expect(ws.readFile('./src/a.ts')).toBe('A');
    expect(ws.exists('/src/a.ts')).toBe(true);
    ws.writeFiles([
      { path: 'src/b.ts', content: 'B' },
      { path: 'src/c.ts', content: 'C' },
    ]);
    expect(ws.listFiles()).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    ws.clear();
    expect(ws.listFiles()).toEqual([]);
  });

  it('空路径抛错', () => {
    const ws = new InMemoryWorkspace();
    expect(() => ws.writeFile('  ', 'x')).toThrow();
  });
});

describe('StaticTestRunner', () => {
  const runner = new StaticTestRunner();

  it('red 阶段：有测试无实现 → 失败（预期的红）', async () => {
    const ws = new InMemoryWorkspace();
    ws.writeFile('src/a.test.ts', "it('t', () => {})");
    const r = await runner.run(ws, { phase: 'red', expectedAcIds: ['ac1'] });
    expect(r.allPassed).toBe(false);
    expect(r.failedTests).toBe(1);
    expect(r.outputSummary).toContain('未真实执行');
  });

  it('red 阶段：只有测试和 mock（无业务实现）仍判定失败，mock 不算实现', async () => {
    const ws = new InMemoryWorkspace();
    ws.writeFile('src/a.test.ts', "it('ac1', () => {})");
    ws.writeFile('src/api/a.mock.ts', 'export const m = {}');
    const r = await runner.run(ws, { phase: 'red', expectedAcIds: ['ac1'] });
    expect(r.allPassed).toBe(false);
  });

  it('red 阶段竟然已齐备实现 → allPassed=true（供 Agent 判"假测试"）', async () => {
    const ws = new InMemoryWorkspace();
    ws.writeFile('src/a.test.ts', "it('t', () => { expect('ac1').toBeTruthy() })");
    ws.writeFile('src/a.ts', 'export const a = 1');
    const r = await runner.run(ws, { phase: 'red', expectedAcIds: ['ac1'] });
    expect(r.allPassed).toBe(true);
  });

  it('green 阶段：测试+实现齐备且覆盖全部 AC → 通过，用例数按 it/test 统计', async () => {
    const ws = new InMemoryWorkspace();
    ws.writeFile('src/a.test.ts', "it('t1', () => {}); test('t2', () => {}); // covers ac1");
    ws.writeFile('src/a.ts', 'export const a = 1');
    const r = await runner.run(ws, { phase: 'green', expectedAcIds: ['ac1'] });
    expect(r.allPassed).toBe(true);
    expect(r.totalTests).toBe(2);
    expect(r.passedTests).toBe(2);
  });

  it('green 阶段：缺 AC 覆盖 / 无用例 / 缺实现 → 失败并给出 failures', async () => {
    const ws = new InMemoryWorkspace();
    ws.writeFile('src/a.test.ts', '// no test case, no ac ref');
    ws.writeFile('src/a.ts', 'x');
    const r = await runner.run(ws, { phase: 'green', expectedAcIds: ['ac1'] });
    expect(r.allPassed).toBe(false);
    const messages = (r.failures ?? []).map((f) => f.errorMessage).join('|');
    expect(messages).toContain('ac1');
    expect(messages).toContain('it/test');
  });
});

describe('ScriptableTestRunner', () => {
  it('按调用顺序返回预置结果并记录调用', async () => {
    const fail: TestResult = {
      totalTests: 1,
      passedTests: 0,
      failedTests: 1,
      skippedTests: 0,
      environment: 'sandbox',
      outputSummary: 'red',
      allPassed: false,
    };
    const pass: TestResult = {
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      skippedTests: 0,
      environment: 'sandbox',
      outputSummary: 'green',
      allPassed: true,
    };
    const runner = new ScriptableTestRunner([fail, pass]);
    const ws = new InMemoryWorkspace();
    const r1 = await runner.run(ws, { phase: 'red' });
    const r2 = await runner.run(ws, { phase: 'green' });
    expect(r1.allPassed).toBe(false);
    expect(r2.allPassed).toBe(true);
    expect(runner.getCallLog().map((c) => c.phase)).toEqual(['red', 'green']);
    await expect(runner.run(ws, { phase: 'green' })).rejects.toThrow();
  });
});
