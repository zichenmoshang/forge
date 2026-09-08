import { describe, it, expect, vi } from 'vitest';
import { CodingAgent } from '../../src/agents/coding-agent';
import { ScriptableTestRunner } from '../../src/tools/scriptable-test-runner';
import { InMemoryWorkspace } from '../../src/tools/in-memory-workspace';
import type { LLMProvider, LLMResponse } from '../../src/llm/provider';
import type { AgentContext } from '../../src/agents/types';
import type {
  CodingTask,
  TestResult,
  CodingResult,
  GeneratedFile,
} from '../../src/types/coding-task';
import type { ReviewIssue } from '../../src/types/review-and-delivery';

function makeTask(): CodingTask {
  return {
    taskId: 'coding-task-s1',
    instanceId: 'inst-1',
    storyId: 's1',
    storyTitle: '用户登录',
    storyDescription: { role: '用户', action: '登录', benefit: '进入' },
    acceptanceCriteria: [
      {
        id: 'ac1',
        given: [],
        when: '提交正确信息',
        then: ['成功'],
        scenarioType: 'normal',
        testable: true,
      },
    ],
    components: [
      {
        componentId: 'c1',
        name: 'LoginForm',
        type: 'feature',
        filePath: 'src/Login.tsx',
        description: '登录',
        props: [],
        children: [],
        reuseStatus: 'new',
        relatedAcIds: ['ac1'],
      },
    ],
    apiContracts: [
      {
        id: 'api-login',
        name: '登录',
        method: 'POST',
        path: '/login',
        description: '',
        request: {},
        response: { success: { httpStatus: 200, fields: [] } },
        relatedStoryIds: ['s1'],
        relatedComponentIds: ['c1'],
        source: 'new',
      },
    ],
    dataModels: [],
    stateManagement: { library: 'zustand' },
    exceptionRequirements: [],
    techStack: {
      framework: 'React',
      frameworkVersion: '18',
      language: 'TypeScript',
      stateLibrary: 'zustand',
      testFramework: 'vitest',
      buildTool: 'vite',
    },
    projectContext: { projectRoot: '/w', srcDir: 'src', projectType: 'new' },
    testRequirements: {
      framework: 'vitest',
      testPerAc: true,
      testTypes: ['unit'],
      mockStrategy: 'msw',
    },
    storyIndex: 0,
    totalStories: 1,
    dependencies: [],
  };
}

const RED_JSON = JSON.stringify({
  testFiles: [
    {
      path: 'src/Login.test.ts',
      type: 'test',
      operation: 'create',
      summary: '登录测试',
      content: "describe('Login', () => { it('ac1 登录成功', () => {}) })",
      relatedAcIds: ['ac1'],
    },
  ],
  mockFiles: [
    {
      path: 'src/api/login.mock.ts',
      type: 'mock',
      operation: 'create',
      summary: '登录mock',
      content: 'export const m = 1',
    },
  ],
  acTestMapping: { ac1: ['ac1 登录成功'] },
});

const GREEN_JSON = JSON.stringify({
  implFiles: [
    {
      path: 'src/Login.tsx',
      type: 'component',
      operation: 'create',
      summary: '登录实现',
      content: 'export const Login = () => null',
      componentId: 'c1',
      relatedAcIds: ['ac1'],
    },
  ],
  updatedTestFiles: [],
  needsDesignFallback: false,
  fallbackReason: '',
});

function rr(allPassed: boolean, failures?: TestResult['failures']): TestResult {
  return {
    totalTests: 1,
    passedTests: allPassed ? 1 : 0,
    failedTests: allPassed ? 0 : 1,
    skippedTests: 0,
    environment: 'sandbox',
    outputSummary: allPassed ? 'pass' : 'fail',
    allPassed,
    failures,
  };
}

function createMockLLM(contents: string[]): LLMProvider {
  let i = 0;
  return {
    name: 'mock-llm',
    complete: vi.fn().mockImplementation(async () => {
      const content = contents[i++] ?? contents[contents.length - 1];
      return {
        content,
        model: 'mock-model',
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
        durationMs: 5,
        finishReason: 'stop',
      } satisfies LLMResponse;
    }),
  } as unknown as LLMProvider;
}

function context(task: CodingTask): AgentContext {
  return { instanceId: 'inst-1', stage: 'coding', input: task };
}

describe('CodingAgent TDD', () => {
  it('red 失败 → green 一次通过：success，文件齐备，记录 red+green 两个 TDD 周期', async () => {
    const runner = new ScriptableTestRunner([rr(false), rr(true)]);
    const ws = new InMemoryWorkspace();
    const agent = new CodingAgent(createMockLLM([RED_JSON, GREEN_JSON]), {
      config: { maxRetries: 0, retryBaseDelayMs: 1 },
      testRunner: runner,
      workspace: ws,
    });
    const result = await agent.generateCode(context(makeTask()));
    expect(result.success).toBe(true);
    expect(result.data?.status).toBe('success');
    const paths = result.data?.files.map((f) => f.path);
    expect(paths).toContain('src/Login.test.ts');
    expect(paths).toContain('src/Login.tsx');
    expect(paths).toContain('src/api/login.mock.ts');
    expect(result.data?.testResult.allPassed).toBe(true);
    expect(result.data?.tddCycles.map((c) => c.phase)).toEqual(['red', 'green']);
    expect(result.llmCalls).toBe(2);
    // green 后工作区同时含测试与实现
    expect(ws.listFiles()).toContain('src/Login.tsx');
  });

  it('green 首次失败、二次修复通过：success，经历 1 红 2 绿', async () => {
    const runner = new ScriptableTestRunner([
      rr(false),
      rr(false, [{ testName: 'ac1', errorMessage: '未实现' }]),
      rr(true),
    ]);
    const agent = new CodingAgent(createMockLLM([RED_JSON, GREEN_JSON, GREEN_JSON]), {
      config: { maxRetries: 0, retryBaseDelayMs: 1 },
      testRunner: runner,
    });
    const result = await agent.generateCode(context(makeTask()));
    expect(result.success).toBe(true);
    expect(result.data?.status).toBe('success');
    expect(result.data?.tddCycles.map((c) => c.phase)).toEqual(['red', 'green', 'green']);
    expect(result.llmCalls).toBe(3);
  });

  it('达到 green 上限仍失败：status=failed 且 AgentResult 失败，issues 记录原因', async () => {
    const runner = new ScriptableTestRunner([
      rr(false),
      rr(false, [{ testName: 'ac1', errorMessage: '依然失败' }]),
    ]);
    const agent = new CodingAgent(createMockLLM([RED_JSON, GREEN_JSON]), {
      config: { maxRetries: 0, retryBaseDelayMs: 1 },
      testRunner: runner,
      maxGreenAttempts: 1,
    });
    const result = await agent.generateCode(context(makeTask()));
    expect(result.success).toBe(false);
    expect(result.data?.status).toBe('failed');
    expect(result.data?.issues?.join('|')).toContain('依然失败');
  });

  it('RED 阶段测试竟然通过（假测试）→ RED_SHOULD_FAIL 拦截', async () => {
    const runner = new ScriptableTestRunner([rr(true)]);
    const agent = new CodingAgent(createMockLLM([RED_JSON]), {
      config: { maxRetries: 0, retryBaseDelayMs: 1 },
      testRunner: runner,
    });
    const result = await agent.generateCode(context(makeTask()));
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.code === 'RED_SHOULD_FAIL')).toBe(true);
  });

  it('green 判定方案不可行：needsDesignFallback=true 且状态 failed，供 Harness 回退阶段3', async () => {
    const fallbackGreen = JSON.stringify({
      implFiles: [],
      updatedTestFiles: [],
      needsDesignFallback: true,
      fallbackReason: '方案要求的接口与已确认契约冲突',
    });
    const runner = new ScriptableTestRunner([rr(false), rr(true)]);
    const agent = new CodingAgent(createMockLLM([RED_JSON, fallbackGreen]), {
      config: { maxRetries: 0, retryBaseDelayMs: 1 },
      testRunner: runner,
    });
    const result = await agent.generateCode(context(makeTask()));
    expect(result.data?.needsDesignFallback).toBe(true);
    expect(result.data?.fallbackReason).toContain('契约冲突');
    expect(result.data?.status).toBe('failed');
  });

  it('RED 缺少 AC 测试映射时，输出校验失败（MISSING_AC_TEST）', async () => {
    const badRed = JSON.stringify({
      testFiles: [{ path: 'x.test.ts', type: 'test', content: "it('a',()=>{})" }],
      mockFiles: [],
      acTestMapping: {},
    });
    const runner = new ScriptableTestRunner([]);
    const agent = new CodingAgent(createMockLLM([badRed]), {
      config: { maxRetries: 0, retryBaseDelayMs: 1 },
      testRunner: runner,
    });
    const result = await agent.generateCode(context(makeTask()));
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.code === 'MISSING_AC_TEST')).toBe(true);
  });
});

// ============================================================
// CodingAgent.revise（代码 CR 多轮内的代码修改）
// ============================================================

function makeCurrentResult(): CodingResult {
  const files: GeneratedFile[] = [
    {
      path: 'src/Login.tsx',
      type: 'component',
      operation: 'create',
      summary: '登录实现',
      content: 'export const Login = () => null',
      relatedAcIds: ['ac1'],
    },
    {
      path: 'src/Login.test.ts',
      type: 'test',
      operation: 'create',
      summary: '测试',
      content: "it('ac1', () => {})",
      relatedAcIds: ['ac1'],
    },
  ];
  return {
    id: 'cr-s1',
    instanceId: 'inst-1',
    taskId: 'task-s1',
    storyId: 's1',
    status: 'success',
    files,
    testResult: rr(true),
    tddCycles: [{ cycle: 1, phase: 'red', action: '写测试', testResult: 'fail', durationMs: 0 }],
    completedAt: '2026-09-06T00:00:00Z',
  };
}

const prevIssue: ReviewIssue = {
  issueId: 'C1',
  severity: 'major',
  category: 'code-style',
  description: '命名不规范',
  location: { target: 'src/Login.tsx', detail: 'L1' },
  suggestion: '重命名为 LoginForm',
  status: 'open',
  blocking: false,
};

const REVISE_JSON = JSON.stringify({
  changeSummary: '重命名组件',
  changedFiles: ['src/Login.tsx'],
  issueResponses: [{ issueId: 'C1', action: 'fixed', explanation: '已重命名' }],
  updatedFiles: [
    {
      path: 'src/Login.tsx',
      type: 'component',
      operation: 'modify',
      summary: '重命名',
      content: 'export const LoginForm = () => null',
      relatedAcIds: ['ac1'],
    },
  ],
  needsDesignFallback: false,
  fallbackReason: '',
});

function reviseContext(
  task: CodingTask,
  currentResult: CodingResult,
  previousIssues: ReviewIssue[],
  round = 2,
): AgentContext {
  return {
    instanceId: 'inst-1',
    stage: 'code-reviewing',
    input: { type: 'revise-code', task, currentResult, previousIssues, round },
  };
}

describe('CodingAgent.revise', () => {
  it('正常修订：合并文件、重跑测试、追加 refactor 周期、返回 issueResponses', async () => {
    const runner = new ScriptableTestRunner([rr(true)]);
    const agent = new CodingAgent(createMockLLM([REVISE_JSON]), {
      config: { maxRetries: 0, retryBaseDelayMs: 1 },
      testRunner: runner,
    });
    const result = await agent.revise(reviseContext(makeTask(), makeCurrentResult(), [prevIssue]));
    expect(result.success).toBe(true);
    const rev = result.data!;
    expect(rev.changeSummary).toBe('重命名组件');
    expect(rev.issueResponses).toHaveLength(1);
    expect(rev.issueResponses[0].action).toBe('fixed');
    // 文件合并：Login.tsx 被覆盖，Login.test.ts 保留
    const paths = rev.updatedResult.files.map((f) => f.path).sort();
    expect(paths).toEqual(['src/Login.test.ts', 'src/Login.tsx']);
    expect(rev.updatedResult.files.find((f) => f.path === 'src/Login.tsx')?.content).toContain(
      'LoginForm',
    );
    // 重跑测试
    expect(rev.updatedResult.testResult.allPassed).toBe(true);
    // 追加 refactor 周期
    expect(rev.updatedResult.tddCycles.map((c) => c.phase)).toContain('refactor');
    expect(rev.updatedResult.status).toBe('success');
  });

  it('缺少 issueResponses 时 MISSING_ISSUE_RESPONSE 错误', async () => {
    const badJson = JSON.stringify({
      changeSummary: 'x',
      changedFiles: [],
      issueResponses: [],
      updatedFiles: [{ path: 'src/Login.tsx', type: 'component', content: 'x' }],
    });
    const runner = new ScriptableTestRunner([rr(true)]);
    const agent = new CodingAgent(createMockLLM([badJson]), {
      config: { maxRetries: 0, retryBaseDelayMs: 1 },
      testRunner: runner,
    });
    const result = await agent.revise(reviseContext(makeTask(), makeCurrentResult(), [prevIssue]));
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.code === 'MISSING_ISSUE_RESPONSE')).toBe(true);
  });

  it('没有 previousIssues 时 NO_PREVIOUS_ISSUES 错误', async () => {
    const runner = new ScriptableTestRunner([]);
    const agent = new CodingAgent(createMockLLM([REVISE_JSON]), {
      config: { maxRetries: 0, retryBaseDelayMs: 1 },
      testRunner: runner,
    });
    const result = await agent.revise(reviseContext(makeTask(), makeCurrentResult(), []));
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.code === 'NO_PREVIOUS_ISSUES')).toBe(true);
  });

  it('修订后测试失败时 status=failed', async () => {
    const runner = new ScriptableTestRunner([rr(false)]);
    const agent = new CodingAgent(createMockLLM([REVISE_JSON]), {
      config: { maxRetries: 0, retryBaseDelayMs: 1 },
      testRunner: runner,
    });
    const result = await agent.revise(reviseContext(makeTask(), makeCurrentResult(), [prevIssue]));
    expect(result.success).toBe(true);
    expect(result.data?.updatedResult.status).toBe('failed');
    expect(result.data?.updatedResult.testResult.allPassed).toBe(false);
  });
});
