import { describe, it, expect, vi } from 'vitest';
import { DesignAgent } from '../../src/agents/design-agent';
import type { LLMProvider, LLMResponse, LLMRequest } from '../../src/llm/provider';
import type { StructuredRequirement } from '../../src/types/requirement';
import type { UserStorySet } from '../../src/types/user-story';
import type { KnowledgeService } from '../../src/services/knowledge-service';
import type { KnowledgeItem } from '../../src/types/knowledge';
import type { FrontendDesignDoc } from '../../src/types/frontend-design';
import type { DesignRevision } from '../../src/types/review-dialog';
import type { ReviewIssue } from '../../src/types/review-and-delivery';

function createMockLLM(content: string, capture?: (req: LLMRequest) => void): LLMProvider {
  return {
    name: 'mock-llm',
    complete: vi.fn().mockImplementation(async (req: LLMRequest) => {
      capture?.(req);
      return {
        content,
        model: 'mock-model',
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
        durationMs: 100,
        finishReason: 'stop',
      } as LLMResponse;
    }),
  };
}

function createRequirement(): StructuredRequirement {
  const now = new Date().toISOString();
  return {
    id: 'req-1',
    instanceId: '',
    version: 1,
    meta: { title: '登录模块', source: 'test', version: '1.0', parsedAt: now, frozenAt: now },
    businessGoals: [{ id: 'g1', description: '提升转化', priority: 'P0' }],
    roles: [{ id: 'r1', name: '用户', description: '终端用户', coreNeeds: [] }],
    features: [
      {
        id: 'f1',
        name: '登录',
        description: '登录功能',
        module: 'auth',
        relatedRoleIds: ['r1'],
        relatedGoalIds: ['g1'],
        priority: 'P0',
        hasExceptionFlow: true,
      },
    ],
    businessRules: [],
    nonFunctionalRequirements: [{ id: 'nfr1', category: 'performance', description: '响应<2s' }],
    globalRequirements: [],
    trackingRequirements: [],
    clarificationLog: [],
    frozen: {
      frozen: true,
      frozenAt: now,
      checklist: {
        businessGoalsClear: true,
        rolesComplete: true,
        featuresNoMissing: true,
        rulesNoAmbiguity: true,
        nfrDefined: true,
        globalRequirementsCovered: true,
        trackingProvided: true,
        allClarificationsResolved: true,
      },
    },
    createdAt: now,
    updatedAt: now,
  };
}

function createStories(): UserStorySet {
  const now = new Date().toISOString();
  return {
    id: 'stories-1',
    instanceId: '',
    requirementId: 'req-1',
    version: 1,
    stories: [
      {
        id: 's1',
        title: '手机号登录',
        description: { role: '用户', action: '登录', benefit: '访问' },
        acceptanceCriteria: [
          {
            id: 'ac1',
            given: ['已注册'],
            when: '提交正确凭证',
            then: ['成功'],
            scenarioType: 'normal',
            testable: true,
          },
          {
            id: 'ac2',
            given: ['凭证错误'],
            when: '提交错误凭证',
            then: ['报错'],
            scenarioType: 'exception',
            testable: true,
          },
        ],
        priority: 'P0',
        dependencies: [],
        relatedFeatureIds: ['f1'],
        relatedRuleIds: [],
        type: 'feature',
        hasExceptionFlow: true,
      },
    ],
    storyMap: [],
    nfrMapping: [],
    qualityCheck: {
      invest: {
        independent: true,
        negotiable: true,
        valuable: true,
        estimable: true,
        small: true,
        testable: true,
      },
      perStory: [],
      acceptanceCriteriaStats: { total: 2, testable: 2, notTestable: 0 },
      featureCoverage: { totalFeatures: 1, coveredFeatures: 1, uncoveredFeatureIds: [] },
      passed: true,
      issues: [],
    },
    confirmation: { confirmedBy: 'ai-self-check', confirmedAt: now, version: 1 },
    createdAt: now,
    updatedAt: now,
  };
}

/** 合法的 LLM 方案输出（覆盖 ac1/ac2 与四类基础异常） */
function validDesignObject() {
  return {
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
        description: '登录',
        relatedStoryIds: ['s1'],
        componentIds: ['c1'],
      },
    ],
    componentTree: [
      {
        id: 'c1',
        name: 'LoginForm',
        type: 'feature',
        filePath: 'src/features/login/LoginForm.tsx',
        description: '登录表单',
        props: [],
        children: [],
        relatedStoryIds: ['s1'],
        relatedAcIds: ['ac1', 'ac2'],
        reuseStatus: 'new',
      },
    ],
    stateManagement: { principle: '表单局部状态，登录态全局 store', globalStores: [] },
    dataModels: [],
    apiContracts: [
      {
        id: 'api1',
        name: '登录',
        method: 'POST',
        path: '/api/login',
        description: '登录接口',
        request: { body: [] },
        response: { success: { httpStatus: 200, fields: [] } },
        relatedStoryIds: ['s1'],
        relatedComponentIds: ['c1'],
        source: 'new',
      },
    ],
    exceptionScenarios: (['loading', 'empty-state', 'error', 'network'] as const).map((t) => ({
      id: `ex-${t}`,
      type: t,
      relatedComponentIds: ['c1'],
      trigger: '',
      behavior: '',
      implementation: '',
      needsDesign: false,
      status: 'covered',
    })),
    nfrSolutions: [
      {
        nfrId: 'nfr1',
        category: 'performance',
        solution: '接口缓存',
        measures: [],
        verification: '压测',
      },
    ],
    reusableComponents: [],
    directoryStructure: { name: 'src', type: 'directory', path: 'src' },
  };
}

function makeContext(overrides?: Record<string, unknown>) {
  return {
    instanceId: 'inst-1',
    stage: 'design-generating',
    input: { type: 'generate-design', requirement: createRequirement(), stories: createStories() },
    ...overrides,
  };
}

function createKnowledgeItem(id: string, title: string): KnowledgeItem {
  return {
    id,
    type: 'component',
    title,
    content: '',
    summary: `复用知识 ${title}`,
    source: 'code',
    sourceRef: `src/${id}.tsx`,
    projectScope: 'global',
    weight: 1,
    status: 'active',
    usageCount: 0,
    createdAt: '',
    updatedAt: '',
  };
}

function mockKnowledgeService(): KnowledgeService {
  return {
    search: vi.fn().mockResolvedValue([createKnowledgeItem('k1', '已有 Button')]),
  } as unknown as KnowledgeService;
}

describe('DesignAgent.generate', () => {
  it('正常生成方案，元数据与覆盖度/API确认由系统补齐', async () => {
    const llm = createMockLLM(JSON.stringify(validDesignObject()));
    const agent = new DesignAgent(llm, { config: { maxRetries: 0, retryBaseDelayMs: 10 } });

    const result = await agent.execute(makeContext());
    expect(result.success).toBe(true);
    const design = result.data as FrontendDesignDoc;
    expect(design.requirementId).toBe('req-1');
    expect(design.storySetId).toBe('stories-1');
    expect(design.version).toBe(1);
    expect(design.coverageCheck.passed).toBe(true);
    expect(design.coverageCheck.acCoverage.coveredACs).toBe(2);
    expect(design.apiConfirmation.required).toBe(true);
    expect(design.apiConfirmation.pendingApiIds).toEqual(['api1']);
  });

  it('内部多路检索知识库，带 projectScope，且检索结果进入 prompt', async () => {
    const service = mockKnowledgeService();
    let capturedPrompt = '';
    const llm = createMockLLM(JSON.stringify(validDesignObject()), (req) => {
      capturedPrompt = req.prompt;
    });
    const agent = new DesignAgent(llm, { config: { maxRetries: 0, retryBaseDelayMs: 10 } });

    const result = await agent.execute(
      makeContext({ knowledgeService: service, projectId: 'proj-A' }),
    );
    expect(result.success).toBe(true);
    // 三路并行检索
    expect(service.search).toHaveBeenCalledTimes(3);
    // projectScope 透传
    const firstCall = (service.search as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(firstCall[1]).toMatchObject({ projectScope: 'proj-A' });
    // 检索结果注入 prompt
    expect(capturedPrompt).toContain('已有 Button');
  });

  it('未注入知识库服务时降级，不报错', async () => {
    const llm = createMockLLM(JSON.stringify(validDesignObject()));
    const agent = new DesignAgent(llm, { config: { maxRetries: 0, retryBaseDelayMs: 10 } });
    const result = await agent.execute(makeContext());
    expect(result.success).toBe(true);
  });

  it('页面引用不存在的组件时报 BROKEN_COMPONENT_REF', async () => {
    const obj = validDesignObject();
    obj.pages[0].componentIds = ['c-not-exist'];
    const llm = createMockLLM(JSON.stringify(obj));
    const agent = new DesignAgent(llm, { config: { maxRetries: 0, retryBaseDelayMs: 10 } });
    const result = await agent.execute(makeContext());
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.code === 'BROKEN_COMPONENT_REF')).toBe(true);
  });

  it('缺少组件树时报 NO_COMPONENTS', async () => {
    const obj = validDesignObject();
    obj.componentTree = [];
    const llm = createMockLLM(JSON.stringify(obj));
    const agent = new DesignAgent(llm, { config: { maxRetries: 0, retryBaseDelayMs: 10 } });
    const result = await agent.execute(makeContext());
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.code === 'NO_COMPONENTS')).toBe(true);
  });

  it('缺少状态管理划分原则时报错', async () => {
    const obj = validDesignObject();
    obj.stateManagement.principle = '';
    const llm = createMockLLM(JSON.stringify(obj));
    const agent = new DesignAgent(llm, { config: { maxRetries: 0, retryBaseDelayMs: 10 } });
    const result = await agent.execute(makeContext());
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.code === 'NO_STATE_MANAGEMENT_PRINCIPLE')).toBe(true);
  });

  it('组件漏覆盖 AC 时 selfCheck 报 DESIGN_COVERAGE_GAP warning', async () => {
    const obj = validDesignObject();
    obj.componentTree[0].relatedAcIds = ['ac1']; // 漏 ac2
    const llm = createMockLLM(JSON.stringify(obj));
    const agent = new DesignAgent(llm, { config: { maxRetries: 0, retryBaseDelayMs: 10 } });
    const result = await agent.execute(makeContext());
    expect(result.success).toBe(true); // warning 不阻塞
    const design = result.data as FrontendDesignDoc;
    expect(design.coverageCheck.passed).toBe(false);
    expect(result.errors.some((e) => e.code === 'DESIGN_COVERAGE_GAP')).toBe(true);
  });

  it('Figma 不可用时给出 FIGMA_UNAVAILABLE warning', async () => {
    const llm = createMockLLM(JSON.stringify(validDesignObject()));
    const agent = new DesignAgent(llm, { config: { maxRetries: 0, retryBaseDelayMs: 10 } });
    const result = await agent.execute(makeContext());
    expect(result.errors.some((e) => e.code === 'FIGMA_UNAVAILABLE')).toBe(true);
  });

  it('NFR 缺少落地方案时 warning', async () => {
    const obj = validDesignObject();
    obj.nfrSolutions = [];
    const llm = createMockLLM(JSON.stringify(obj));
    const agent = new DesignAgent(llm, { config: { maxRetries: 0, retryBaseDelayMs: 10 } });
    const result = await agent.execute(makeContext());
    expect(result.errors.some((e) => e.code === 'NFR_WITHOUT_SOLUTION')).toBe(true);
  });

  it('全局技术栈约束进入 prompt', async () => {
    let captured = '';
    const llm = createMockLLM(JSON.stringify(validDesignObject()), (req) => {
      captured = req.prompt;
    });
    const agent = new DesignAgent(llm, { config: { maxRetries: 0, retryBaseDelayMs: 10 } });
    await agent.execute(makeContext({ globalContext: { techStack: 'React18 + zustand + vite' } }));
    expect(captured).toContain('React18 + zustand + vite');
  });

  it('输入缺少故事时报 NO_STORIES', async () => {
    const llm = createMockLLM(JSON.stringify(validDesignObject()));
    const agent = new DesignAgent(llm, { config: { maxRetries: 0, retryBaseDelayMs: 10 } });
    const ctx = makeContext();
    (ctx.input as { stories?: UserStorySet }).stories = { ...createStories(), stories: [] };
    const result = await agent.execute(ctx);
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.code === 'NO_STORIES')).toBe(true);
  });
});

describe('DesignAgent.revise（评审多轮对话内修改，#42）', () => {
  function makePreviousDesign(version = 1): FrontendDesignDoc {
    const obj = validDesignObject();
    return {
      ...(obj as unknown as FrontendDesignDoc),
      id: 'design-1',
      instanceId: 'inst-1',
      requirementId: 'req-1',
      storySetId: 'stories-1',
      version,
      createdAt: '2026-09-04T00:00:00.000Z',
      updatedAt: '2026-09-04T00:00:00.000Z',
      coverageCheck: {
        storyCoverage: { totalStories: 1, coveredStories: 1, uncoveredStoryIds: [] },
        acCoverage: { totalACs: 2, coveredACs: 2, uncoveredAcIds: [] },
        exceptionCoverage: { passed: true, checklist: [] },
        passed: true,
        issues: [],
      },
      apiConfirmation: { required: true, status: 'pending', pendingApiIds: ['api1'] },
    } as FrontendDesignDoc;
  }

  const prevIssue: ReviewIssue = {
    issueId: 'I1',
    severity: 'blocker',
    category: 'coverage',
    description: 'ac2 未覆盖',
    suggestion: '补错误提示组件',
    status: 'open',
    blocking: true,
  };

  function reviseLLM(updatedDesign: unknown, issueResponses: unknown) {
    return createMockLLM(
      JSON.stringify({
        changeSummary: '补了错误提示',
        changedSections: ['c1'],
        issueResponses,
        updatedDesign,
      }),
    );
  }

  function reviseContext(
    previousDesign: FrontendDesignDoc,
    previousIssues: ReviewIssue[],
    round = 2,
  ) {
    return {
      instanceId: 'inst-1',
      stage: 'design-reviewing',
      input: {
        type: 'revise-design',
        previousDesign,
        previousIssues,
        round,
        stories: createStories(),
      },
    };
  }

  it('正常修订：版本 +1、沿用 id/创建时间、覆盖度重算、保留逐项回应', async () => {
    const llm = reviseLLM(validDesignObject(), [
      { issueId: 'I1', action: 'fixed', explanation: '已补错误提示组件' },
    ]);
    const agent = new DesignAgent(llm, { config: { maxRetries: 0, retryBaseDelayMs: 10 } });
    const result = await agent.revise(reviseContext(makePreviousDesign(1), [prevIssue]));
    expect(result.success).toBe(true);
    const rev = result.data as DesignRevision;
    expect(rev.updatedDesign.version).toBe(2);
    expect(rev.updatedDesign.id).toBe('design-1');
    expect(rev.updatedDesign.createdAt).toBe('2026-09-04T00:00:00.000Z');
    // 覆盖度由系统依据 stories 重算（validDesignObject 覆盖 ac1/ac2）
    expect(rev.updatedDesign.coverageCheck.passed).toBe(true);
    expect(rev.issueResponses[0].issueId).toBe('I1');
  });

  it('遗漏上轮 open 问题的逐项回应时报 ISSUE_RESPONSE_INCOMPLETE', async () => {
    const llm = reviseLLM(validDesignObject(), []); // 没有回应 I1
    const agent = new DesignAgent(llm, { config: { maxRetries: 0, retryBaseDelayMs: 10 } });
    const result = await agent.revise(reviseContext(makePreviousDesign(), [prevIssue]));
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.code === 'ISSUE_RESPONSE_INCOMPLETE')).toBe(true);
  });

  it('wont-fix 但缺少理由时报错', async () => {
    const llm = reviseLLM(validDesignObject(), [
      { issueId: 'I1', action: 'wont-fix', explanation: '' },
    ]);
    const agent = new DesignAgent(llm, { config: { maxRetries: 0, retryBaseDelayMs: 10 } });
    const result = await agent.revise(reviseContext(makePreviousDesign(), [prevIssue]));
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.code === 'ISSUE_RESPONSE_INCOMPLETE')).toBe(true);
  });

  it('修订后方案结构破损（缺组件树）时报 NO_COMPONENTS', async () => {
    const broken = { ...validDesignObject(), componentTree: [] };
    const llm = reviseLLM(broken, [{ issueId: 'I1', action: 'fixed', explanation: '改' }]);
    const agent = new DesignAgent(llm, { config: { maxRetries: 0, retryBaseDelayMs: 10 } });
    const result = await agent.revise(reviseContext(makePreviousDesign(), [prevIssue]));
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.code === 'NO_COMPONENTS')).toBe(true);
  });
});
