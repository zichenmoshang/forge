import { describe, it, expect, vi } from 'vitest';
import { ReviewAgent } from '../../src/agents/review-agent';
import type { LLMProvider, LLMResponse } from '../../src/llm/provider';
import type { FrontendDesignDoc } from '../../src/types/frontend-design';
import type { ReviewResult } from '../../src/types/review-and-delivery';
import type { CodingPhaseResult, CodingResult, GeneratedFile } from '../../src/types/coding-task';

function createMockLLM(content: string): LLMProvider {
  return {
    name: 'mock-llm',
    complete: vi.fn().mockResolvedValue({
      content,
      model: 'mock-model',
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
      durationMs: 100,
      finishReason: 'stop',
    } as LLMResponse),
  };
}

function makeDesign(coveragePassed = true): FrontendDesignDoc {
  return {
    id: 'design-1',
    instanceId: 'inst-1',
    requirementId: 'req-1',
    storySetId: 'stories-1',
    version: 1,
    techStack: {
      source: 'suggested',
      framework: { name: 'React', version: '18' },
      language: 'TypeScript',
      stateManagement: { library: 'zustand' },
      testing: { framework: 'vitest' },
      buildTool: 'vite',
    },
    figmaReference: { available: false, frames: [], componentMappings: [] },
    pages: [
      {
        id: 'p1',
        name: '登录页',
        route: '/login',
        description: '',
        relatedStoryIds: ['s1'],
        componentIds: ['c1'],
      },
    ],
    componentTree: [
      {
        id: 'c1',
        name: 'LoginForm',
        type: 'feature',
        filePath: 'src/LoginForm.tsx',
        description: '',
        props: [],
        children: [],
        relatedStoryIds: ['s1'],
        relatedAcIds: ['ac1'],
        reuseStatus: 'new',
      },
    ],
    stateManagement: { principle: '局部优先', globalStores: [] },
    dataModels: [],
    apiContracts: [],
    exceptionScenarios: [],
    nfrSolutions: [],
    reusableComponents: [],
    directoryStructure: { name: 'src', type: 'directory', path: 'src' },
    coverageCheck: {
      storyCoverage: {
        totalStories: 1,
        coveredStories: coveragePassed ? 1 : 0,
        uncoveredStoryIds: coveragePassed ? [] : ['s1'],
      },
      acCoverage: {
        totalACs: 1,
        coveredACs: coveragePassed ? 1 : 0,
        uncoveredAcIds: coveragePassed ? [] : ['ac1'],
      },
      exceptionCoverage: { checklist: [], passed: true },
      passed: coveragePassed,
      issues: coveragePassed ? [] : ['ac1 未覆盖'],
    },
    apiConfirmation: { required: false, pendingApiIds: [], status: 'not-required' },
    createdAt: '',
    updatedAt: '',
  };
}

function makeContext(design: FrontendDesignDoc) {
  return {
    instanceId: 'inst-1',
    stage: 'design-reviewing',
    input: { type: 'review-design', design },
  };
}

describe('ReviewAgent 方案单轮评审', () => {
  it('无问题时通过，元数据由系统补齐', async () => {
    const llm = createMockLLM(
      JSON.stringify({
        conclusion: 'pass',
        summary: '方案合理',
        issues: [],
        checklist: {
          coverage: {
            passed: true,
            storyCoverage: { total: 1, covered: 1, uncovered: [] },
            acCoverage: { total: 1, covered: 1, uncovered: [] },
          },
          exceptionCompleteness: { passed: true, checklist: [], missingScenarios: [] },
          apiConsistency: { passed: true, issues: [] },
          architecture: { passed: true, issues: [] },
          stateManagement: { passed: true, issues: [] },
          nfrCoverage: { passed: true, missingNfrIds: [] },
          componentReuse: { passed: true },
        },
      }),
    );
    const agent = new ReviewAgent(llm, { config: { maxRetries: 0, retryBaseDelayMs: 10 } });
    const result = await agent.execute(makeContext(makeDesign()));
    expect(result.success).toBe(true);
    const r = result.data as ReviewResult;
    expect(r.reviewType).toBe('design-review');
    expect(r.targetVersion).toBe(1);
    expect(r.reviewer).toBe('review-agent');
    expect(r.issues).toEqual([]);
    expect(r.resolvedAction).toBe('approve');
    expect(r.checklist?.overallPassed).toBe(true);
  });

  it('LLM 漏标 blocking 时，blocker 被程序化强制阻塞', async () => {
    const llm = createMockLLM(
      JSON.stringify({
        conclusion: 'pass-with-comments',
        summary: '有严重问题',
        issues: [
          {
            issueId: 'I1',
            severity: 'blocker',
            category: 'coverage',
            description: 'AC 未覆盖',
            suggestion: '补组件',
            status: 'open',
            blocking: false, // LLM 故意漏标
          },
        ],
        checklist: {
          // LLM 谎报通过，应被程序化结果覆盖
          overallPassed: true,
          coverage: {
            passed: false,
            storyCoverage: { total: 1, covered: 0, uncovered: ['s1'] },
            acCoverage: { total: 1, covered: 0, uncovered: ['ac1'] },
          },
          exceptionCompleteness: { passed: true, checklist: [], missingScenarios: [] },
          apiConsistency: { passed: true, issues: [] },
          architecture: { passed: true, issues: [] },
          stateManagement: { passed: true, issues: [] },
          nfrCoverage: { passed: true, missingNfrIds: [] },
          componentReuse: { passed: true },
        },
      }),
    );
    const agent = new ReviewAgent(llm, { config: { maxRetries: 0, retryBaseDelayMs: 10 } });
    const result = await agent.execute(makeContext(makeDesign()));
    expect(result.success).toBe(true);
    const r = result.data as ReviewResult;
    expect(r.issues[0].blocking).toBe(true);
    expect(r.resolvedAction).toBe('request_changes');
    expect(r.checklist?.overallPassed).toBe(false);
  });

  it('conclusion=pass 但存在 blocking 时 selfCheck 报矛盾 warning', async () => {
    const llm = createMockLLM(
      JSON.stringify({
        conclusion: 'pass',
        summary: '矛盾结论',
        issues: [
          {
            issueId: 'I1',
            severity: 'critical',
            category: 'architecture',
            description: '架构错误',
            suggestion: '重构',
          },
        ],
      }),
    );
    const agent = new ReviewAgent(llm, { config: { maxRetries: 0, retryBaseDelayMs: 10 } });
    const result = await agent.execute(makeContext(makeDesign()));
    const r = result.data as ReviewResult;
    expect(r.issues[0].blocking).toBe(true);
    expect(r.resolvedAction).toBe('request_changes');
    expect(result.errors.some((e) => e.code === 'CONCLUSION_CONTRADICTS_ISSUES')).toBe(true);
  });

  it('方案覆盖度未达标但评审漏提 coverage 时给 REVIEW_MISSED_COVERAGE', async () => {
    const llm = createMockLLM(
      JSON.stringify({
        conclusion: 'pass',
        summary: '漏审',
        issues: [
          {
            issueId: 'I1',
            severity: 'minor',
            category: 'other',
            description: '小问题',
            suggestion: '调整',
          },
        ],
      }),
    );
    const agent = new ReviewAgent(llm, { config: { maxRetries: 0, retryBaseDelayMs: 10 } });
    const result = await agent.execute(makeContext(makeDesign(false)));
    expect(result.errors.some((e) => e.code === 'REVIEW_MISSED_COVERAGE')).toBe(true);
  });

  it('问题缺少 category 时报错', async () => {
    const llm = createMockLLM(
      JSON.stringify({
        conclusion: 'reject',
        issues: [{ issueId: 'I1', severity: 'major', description: '无分类', suggestion: '改' }],
      }),
    );
    const agent = new ReviewAgent(llm, { config: { maxRetries: 0, retryBaseDelayMs: 10 } });
    const result = await agent.execute(makeContext(makeDesign()));
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.code === 'ISSUE_WITHOUT_CATEGORY')).toBe(true);
  });

  it('问题缺少 suggestion 时 warning', async () => {
    const llm = createMockLLM(
      JSON.stringify({
        conclusion: 'pass-with-comments',
        issues: [
          {
            issueId: 'I1',
            severity: 'minor',
            category: 'other',
            description: '建议空',
            suggestion: '',
          },
        ],
      }),
    );
    const agent = new ReviewAgent(llm, { config: { maxRetries: 0, retryBaseDelayMs: 10 } });
    const result = await agent.execute(makeContext(makeDesign()));
    expect(result.success).toBe(true);
    expect(result.errors.some((e) => e.code === 'ISSUE_WITHOUT_SUGGESTION')).toBe(true);
  });

  it('输入缺少方案时报 NO_DESIGN', async () => {
    const llm = createMockLLM('{}');
    const agent = new ReviewAgent(llm, { config: { maxRetries: 0, retryBaseDelayMs: 10 } });
    const result = await agent.execute({
      instanceId: 'i',
      stage: 'design-reviewing',
      input: { type: 'review-design' },
    });
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.code === 'NO_DESIGN')).toBe(true);
  });
});

describe('ReviewAgent 多轮评审（#42 问题跟踪闭环）', () => {
  const prevIssue = {
    issueId: 'I1',
    severity: 'blocker' as const,
    category: 'coverage' as const,
    description: 'ac1 未覆盖',
    suggestion: '补组件',
    status: 'open' as const,
    blocking: true,
  };

  function round2Context(design: FrontendDesignDoc, input: Record<string, unknown>) {
    return {
      instanceId: 'i',
      stage: 'design-reviewing',
      input: { type: 'review-design', ...input },
    } as never;
  }

  it('第 2 轮逐项给出 verification 时通过，且 prompt 注入上轮问题与修改方回应', async () => {
    const complete = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        conclusion: 'pass',
        summary: '已修复',
        issues: [
          {
            ...prevIssue,
            status: 'resolved',
            blocking: true,
            verification: { round: 2, result: 'resolved', note: '组件已补' },
          },
        ],
      }),
      model: 'm',
      promptTokens: 1,
      completionTokens: 2,
      totalTokens: 3,
      durationMs: 1,
      finishReason: 'stop' as const,
    });
    const llm = { name: 'mock', complete } as unknown as LLMProvider;
    const agent = new ReviewAgent(llm, { config: { maxRetries: 0, retryBaseDelayMs: 10 } });

    const result = await agent.execute(
      round2Context(makeDesign(), {
        design: makeDesign(),
        round: 2,
        previousIssues: [prevIssue],
        issueResponses: [{ issueId: 'I1', action: 'fixed', explanation: '已补组件' }],
      }),
    );
    expect(result.success).toBe(true);
    // prompt 中确实带上了上一轮问题与修改方回应
    const sentPrompt = complete.mock.calls[0][0].prompt as string;
    expect(sentPrompt).toContain('I1');
    expect(sentPrompt).toContain('已补组件');
  });

  it('第 2 轮遗漏上轮 open 问题的 verification 时，输出被判无效（MISSING_ISSUE_VERIFICATION）', async () => {
    const llm = createMockLLM(
      JSON.stringify({
        conclusion: 'pass',
        summary: '漏核对',
        // 只提了一个新问题，完全没回应上一轮 I1
        issues: [
          {
            issueId: 'I9',
            severity: 'minor',
            category: 'other',
            description: '新问题',
            suggestion: '微调',
          },
        ],
      }),
    );
    const agent = new ReviewAgent(llm, { config: { maxRetries: 0, retryBaseDelayMs: 10 } });
    const result = await agent.execute(
      round2Context(makeDesign(), { design: makeDesign(), round: 2, previousIssues: [prevIssue] }),
    );
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.code === 'MISSING_ISSUE_VERIFICATION')).toBe(true);
  });

  it('第 1 轮不做闭环校验（round<2）', async () => {
    const llm = createMockLLM(JSON.stringify({ conclusion: 'pass', summary: '首轮', issues: [] }));
    const agent = new ReviewAgent(llm, { config: { maxRetries: 0, retryBaseDelayMs: 10 } });
    // 即使传了 previousIssues，首轮也不要求 verification
    const result = await agent.execute(
      round2Context(makeDesign(), { design: makeDesign(), round: 1, previousIssues: [prevIssue] }),
    );
    expect(result.success).toBe(true);
  });
});

// ============================================================
// 代码 CR（review-code）
// ============================================================

function makeCodingResult(
  storyId: string,
  status: 'success' | 'partial' | 'failed' = 'success',
): CodingResult {
  const files: GeneratedFile[] =
    status === 'failed'
      ? []
      : [
          {
            path: `src/${storyId}.tsx`,
            type: 'component',
            operation: 'create',
            summary: '实现',
            content: `export const ${storyId} = () => null`,
            relatedAcIds: ['ac1'],
          },
          {
            path: `src/${storyId}.test.ts`,
            type: 'test',
            operation: 'create',
            summary: '测试',
            content: "it('ac1', () => {})",
            relatedAcIds: ['ac1'],
          },
        ];
  return {
    id: `cr-${storyId}`,
    instanceId: 'inst-1',
    taskId: `task-${storyId}`,
    storyId,
    status,
    files,
    testResult: {
      totalTests: status === 'failed' ? 0 : 1,
      passedTests: status === 'failed' ? 0 : 1,
      failedTests: 0,
      skippedTests: 0,
      environment: 'sandbox',
      outputSummary: '静态推断（未真实执行）',
      allPassed: status !== 'failed',
    },
    tddCycles: [],
    completedAt: '2026-09-06T00:00:00Z',
  };
}

function makeCodingPhase(results: CodingResult[]): CodingPhaseResult {
  const successStoryIds = results.filter((r) => r.status === 'success').map((r) => r.storyId);
  const partialStoryIds = results.filter((r) => r.status === 'partial').map((r) => r.storyId);
  const failedStories = results
    .filter((r) => r.status === 'failed')
    .map((r) => ({ storyId: r.storyId, reason: '测试失败' }));
  const allFiles = results.flatMap((r) => r.files);
  return {
    id: 'coding-phase-1',
    instanceId: 'inst-1',
    designDocId: 'design-1',
    totalStories: results.length,
    successStoryIds,
    partialStoryIds,
    failedStories,
    results,
    overallTestStats: {
      totalTests: allFiles.length,
      passedTests: allFiles.length,
      failedTests: 0,
      passRate: 1,
    },
    allFiles,
    overallStatus:
      failedStories.length === results.length
        ? 'all-failed'
        : successStoryIds.length === results.length
          ? 'all-success'
          : 'partial-success',
    version: 1,
    completedAt: '2026-09-06T00:00:00Z',
  };
}

function makeCodeReviewContext(
  coding: CodingPhaseResult,
  round = 1,
  previousIssues: ReviewResult['issues'] = [],
  issueResponses = [],
) {
  return {
    instanceId: 'inst-1',
    stage: 'code-reviewing',
    input: {
      type: 'review-code' as const,
      design: makeDesign(),
      coding,
      round,
      previousIssues,
      issueResponses,
    },
  };
}

describe('ReviewAgent 代码 CR', () => {
  it('无问题时通过，reviewType=code-review，targetArtifactId=coding.id', async () => {
    const llm = createMockLLM(
      JSON.stringify({
        conclusion: 'pass',
        summary: '代码质量良好',
        issues: [],
        checklist: {
          designConsistency: { passed: true, mismatches: [] },
          codeStyle: { passed: true, issues: [] },
          logic: { passed: true, issues: [] },
          exceptionHandling: { passed: true, missingHandling: [] },
          security: { passed: true, vulnerabilities: [] },
          maintainability: { passed: true, issues: [] },
          duplication: { passed: true, duplicatedBlocks: [] },
          testQuality: { passed: true, uncoveredAcs: [] },
          designFidelity: { passed: true, mismatches: [] },
          overallPassed: true,
        },
      }),
    );
    const agent = new ReviewAgent(llm, { config: { maxRetries: 0, retryBaseDelayMs: 10 } });
    const result = await agent.execute(
      makeCodeReviewContext(makeCodingPhase([makeCodingResult('s1')])),
    );
    expect(result.success).toBe(true);
    const r = result.data as ReviewResult;
    expect(r.reviewType).toBe('code-review');
    expect(r.targetArtifactId).toBe('coding-phase-1');
    expect(r.resolvedAction).toBe('approve');
    expect(r.checklist?.overallPassed).toBe(true);
  });

  it('blocker 问题被程序化强制阻塞，resolvedAction=request_changes', async () => {
    const llm = createMockLLM(
      JSON.stringify({
        conclusion: 'pass-with-comments',
        summary: '有严重问题',
        issues: [
          {
            issueId: 'C1',
            severity: 'blocker',
            category: 'security',
            description: '硬编码密钥',
            location: { target: 'src/s1.tsx', detail: 'L10' },
            suggestion: '移除硬编码',
            status: 'open',
          },
        ],
      }),
    );
    const agent = new ReviewAgent(llm, { config: { maxRetries: 0, retryBaseDelayMs: 10 } });
    const result = await agent.execute(
      makeCodeReviewContext(makeCodingPhase([makeCodingResult('s1')])),
    );
    expect(result.success).toBe(true);
    const r = result.data as ReviewResult;
    expect(r.issues[0].blocking).toBe(true);
    expect(r.resolvedAction).toBe('request_changes');
  });

  it('全部故事失败时 NO_REVIEWABLE_CODE 错误', async () => {
    const llm = createMockLLM(JSON.stringify({ conclusion: 'pass', summary: '', issues: [] }));
    const agent = new ReviewAgent(llm, { config: { maxRetries: 0, retryBaseDelayMs: 10 } });
    const result = await agent.execute(
      makeCodeReviewContext(makeCodingPhase([makeCodingResult('s1', 'failed')])),
    );
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.code === 'NO_REVIEWABLE_CODE')).toBe(true);
  });

  it('第 2 轮遗漏上轮问题 verification 时 MISSING_ISSUE_VERIFICATION', async () => {
    const prevIssue = {
      issueId: 'C1',
      severity: 'major',
      category: 'code-style',
      description: '命名不规范',
      suggestion: '重命名',
      status: 'open' as const,
      blocking: false,
    };
    const llm = createMockLLM(
      JSON.stringify({ conclusion: 'pass', summary: '已修复', issues: [] }),
    );
    const agent = new ReviewAgent(llm, { config: { maxRetries: 0, retryBaseDelayMs: 10 } });
    const result = await agent.execute(
      makeCodeReviewContext(makeCodingPhase([makeCodingResult('s1')]), 2, [prevIssue]),
    );
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.code === 'MISSING_ISSUE_VERIFICATION')).toBe(true);
  });

  it('dialogAction=request_human 时 resolvedAction=request_human', async () => {
    const llm = createMockLLM(
      JSON.stringify({
        conclusion: 'pass-with-comments',
        summary: '需要人工裁决',
        dialogAction: 'request_human',
        issues: [],
      }),
    );
    const agent = new ReviewAgent(llm, { config: { maxRetries: 0, retryBaseDelayMs: 10 } });
    const result = await agent.execute(
      makeCodeReviewContext(makeCodingPhase([makeCodingResult('s1')])),
    );
    expect(result.success).toBe(true);
    expect(result.data?.resolvedAction).toBe('request_human');
  });
});
