import { describe, it, expect, vi } from 'vitest';
import * as path from 'path';
import { LocalSubprocessTestRunner } from '../../src/tools/local-subprocess-test-runner';
import { InMemoryWorkspace } from '../../src/tools/in-memory-workspace';
import type { Workspace } from '../../src/tools/types';

function ws(files: Record<string, string>): Workspace {
  const w = new InMemoryWorkspace();
  for (const [p, content] of Object.entries(files)) w.writeFile(p, content);
  return w;
}

// 纯逻辑实现 + 测试（不依赖外部库，可被真实 vitest 跑通）
const MATH_IMPL = 'export function add(a: number, b: number): number { return a + b; }\n';
const MATH_TEST = `
import { describe, it, expect } from 'vitest';
import { add } from './math';
describe('math', () => {
  it('adds two numbers', () => {
    expect(add(1, 2)).toBe(3);
  });
  it('adds negatives', () => {
    expect(add(-1, -2)).toBe(-3);
  });
});
`;

// red 阶段：只有测试，实现缺失 → 真实失败
const TEST_ONLY = `
import { describe, it, expect } from 'vitest';
import { add } from './math';
describe('math', () => {
  it('adds', () => { expect(add(1, 1)).toBe(2); });
});
`;

// 假测试：不引用实现，任何情况下都通过
const FAKE_TEST = `
import { describe, it, expect } from 'vitest';
describe('fake', () => {
  it('always passes', () => { expect(1).toBe(1); });
});
`;

describe('LocalSubprocessTestRunner（issue #83 真实测试执行）', () => {
  it('green：实现+测试齐备时真实跑通', async () => {
    const runner = new LocalSubprocessTestRunner({ timeoutMs: 30000 });
    const result = await runner.run(ws({ 'math.ts': MATH_IMPL, 'math.test.ts': MATH_TEST }), {
      phase: 'green',
      expectedAcIds: ['ac-1'],
    });
    expect(result.allPassed).toBe(true);
    expect(result.totalTests).toBe(2);
    expect(result.passedTests).toBe(2);
    expect(result.failedTests).toBe(0);
    expect(result.outputSummary).toContain('真实执行');
  });

  it('red：只有测试无实现时真实失败（import 解析失败）', async () => {
    const runner = new LocalSubprocessTestRunner({ timeoutMs: 30000 });
    const result = await runner.run(ws({ 'math.test.ts': TEST_ONLY }), {
      phase: 'red',
      expectedAcIds: ['ac-1'],
    });
    expect(result.allPassed).toBe(false);
    expect(result.failedTests).toBeGreaterThan(0);
    expect(result.failures).toBeDefined();
    expect(result.failures?.[0]?.errorMessage).toContain('Cannot find module');  });

  it('red：假测试（不引用实现）真实全绿，暴露假测试问题', async () => {
    const runner = new LocalSubprocessTestRunner({ timeoutMs: 30000 });
    const result = await runner.run(ws({ 'fake.test.ts': FAKE_TEST }), {
      phase: 'red',
      expectedAcIds: [],
    });
    // 真实执行下假测试通过 → CodingAgent 的 RED_SHOULD_FAIL 质量门会拦截
    expect(result.allPassed).toBe(true);
    expect(result.passedTests).toBe(1);
  });

  it('green：实现逻辑有 bug 时真实失败并带出错误信息', async () => {
    const runner = new LocalSubprocessTestRunner({ timeoutMs: 30000 });
    const buggyImpl = 'export function add(a: number, b: number): number { return a - b; }\n';
    const result = await runner.run(ws({ 'math.ts': buggyImpl, 'math.test.ts': MATH_TEST }), {
      phase: 'green',
      expectedAcIds: [],
    });
    expect(result.allPassed).toBe(false);
    expect(result.failedTests).toBe(2);
    expect(result.failures?.[0]?.errorMessage).toContain('expected -1 to be 3');
  });

  it('环境不可用时降级静态推断并明确标注（fallbackToStatic 默认开启）', async () => {
    const runner = new LocalSubprocessTestRunner({
      vitestEntry: path.join(process.cwd(), 'node_modules', 'vitest', 'not-exist.mjs'),
      timeoutMs: 5000,
    });
    const result = await runner.run(ws({ 'a.test.ts': FAKE_TEST }), {
      phase: 'green',
      expectedAcIds: [],
    });
    expect(result.outputSummary).toContain('降级静态推断');
    expect(result.outputSummary).toContain('[static]');
  });

  it('环境不可用且 fallbackToStatic=false 时返回环境失败', async () => {
    const runner = new LocalSubprocessTestRunner({
      vitestEntry: path.join(process.cwd(), 'node_modules', 'vitest', 'not-exist.mjs'),
      fallbackToStatic: false,
      timeoutMs: 5000,
    });
    const result = await runner.run(ws({ 'a.test.ts': FAKE_TEST }), {
      phase: 'green',
      expectedAcIds: [],
    });
    expect(result.allPassed).toBe(false);
    expect(result.outputSummary).toContain('未降级');
  });
});
