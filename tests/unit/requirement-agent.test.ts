import { describe, it, expect, vi } from 'vitest';
import { RequirementAgent } from '../../src/agents/requirement-agent';
import type { LLMProvider, LLMResponse } from '../../src/llm/provider';
import type { StructuredRequirement } from '../../src/types/requirement';

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

const SAMPLE_PRD = `# 用户登录模块需求

## 业务目标
- 提升用户登录转化率
- 支持手机号和邮箱两种登录方式

## 功能点
### 手机号登录
用户输入手机号，获取验证码，输入验证码后登录。
### 邮箱登录
用户输入邮箱和密码，验证后登录。
### 忘记密码
用户通过邮箱重置密码。

## 角色
- 普通用户：使用系统的终端用户
- 管理员：管理用户权限

## 业务规则
- 验证码有效期5分钟
- 密码错误5次锁定账户30分钟`;

const CLARIFICATION_JSON = JSON.stringify({
  meta: { title: '用户登录模块', source: 'test.md', version: '1.0' },
  businessGoals: [{ id: 'g1', description: '提升登录转化率', priority: 'P0', successMetrics: [] }],
  roles: [{ id: 'r1', name: '普通用户', description: '终端用户', coreNeeds: ['便捷登录'] }],
  features: [
    {
      id: 'f1',
      name: '手机号登录',
      description: '手机号+验证码登录',
      module: '登录',
      relatedRoleIds: ['r1'],
      relatedGoalIds: ['g1'],
      priority: 'P0',
      hasExceptionFlow: true,
    },
  ],
  businessRules: [
    { id: 'rule1', description: '验证码5分钟有效', type: 'validation', relatedFeatureIds: ['f1'] },
  ],
  nonFunctionalRequirements: [{ id: 'nfr1', category: 'performance', description: '登录响应<2s' }],
  globalRequirements: [
    {
      id: 'greq1',
      category: 'authentication',
      description: '登录态保持7天',
      inScope: true,
      source: 'new',
      discoveredInClarification: true,
    },
  ],
  trackingRequirements: [],
  clarificationLog: [
    {
      id: 'q1',
      question: '是否支持第三方登录？',
      category: 'missing',
      priority: 'important',
      status: 'pending',
    },
  ],
});

const STORY_JSON = JSON.stringify({
  stories: [
    {
      id: 's1',
      title: '手机号登录',
      description: { role: '普通用户', action: '使用手机号登录', benefit: '快速访问系统' },
      acceptanceCriteria: [
        {
          id: 'ac1',
          given: ['用户已注册'],
          when: '输入正确手机号和验证码',
          then: ['登录成功'],
          scenarioType: 'normal',
          testable: true,
        },
        {
          id: 'ac2',
          given: ['验证码过期'],
          when: '输入过期验证码',
          then: ['提示验证码过期'],
          scenarioType: 'exception',
          testable: true,
        },
      ],
      priority: 'P0',
      dependencies: [],
      relatedFeatureIds: ['f1'],
      relatedRuleIds: ['rule1'],
      type: 'feature',
      hasExceptionFlow: true,
    },
  ],
  storyMap: [{ groupName: '登录流程', storyIds: ['s1'], order: 0 }],
  nfrMapping: [
    {
      nfrId: 'nfr1',
      storyIds: ['s1'],
      implementationNote: '接口响应时间控制',
      requiresDesignAttention: true,
    },
  ],
});

function createFrozenRequirement(): StructuredRequirement {
  const now = new Date().toISOString();
  return {
    id: 'req-001',
    instanceId: 'inst-001',
    version: 1,
    meta: { title: '测试需求', source: 'test', version: '1.0', parsedAt: now, frozenAt: now },
    businessGoals: [{ id: 'g1', description: '目标1', priority: 'P0' }],
    roles: [{ id: 'r1', name: '用户', description: '普通用户', coreNeeds: [] }],
    features: [
      {
        id: 'f1',
        name: '功能1',
        description: '功能描述',
        module: '模块1',
        relatedRoleIds: ['r1'],
        relatedGoalIds: ['g1'],
        priority: 'P0',
        hasExceptionFlow: false,
      },
    ],
    businessRules: [
      { id: 'rule1', description: '规则1', type: 'validation', relatedFeatureIds: ['f1'] },
    ],
    nonFunctionalRequirements: [{ id: 'nfr1', category: 'performance', description: '性能要求' }],
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

describe('RequirementAgent', () => {
  describe('需求澄清模式', () => {
    it('应该成功解析PRD并输出结构化需求', async () => {
      const llm = createMockLLM(CLARIFICATION_JSON);
      const agent = new RequirementAgent(llm, { config: { maxRetries: 0, retryBaseDelayMs: 10 } });

      const result = await agent.execute({
        instanceId: 'test',
        stage: 'requirement-clarification',
        input: { type: 'clarify', prdText: SAMPLE_PRD, source: 'test.md' },
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      const req = result.data as StructuredRequirement;
      expect(req.meta.title).toBe('用户登录模块');
      expect(req.features).toHaveLength(1);
      expect(req.features[0].name).toBe('手机号登录');
      expect(req.clarificationLog).toHaveLength(1);
      expect(req.frozen.frozen).toBe(false);
    });

    it('应该处理markdown代码块包裹的JSON输出', async () => {
      const llm = createMockLLM('```json\n' + CLARIFICATION_JSON + '\n```');
      const agent = new RequirementAgent(llm, { config: { maxRetries: 0, retryBaseDelayMs: 10 } });

      const result = await agent.execute({
        instanceId: 'test',
        stage: 'requirement-clarification',
        input: { type: 'clarify', prdText: SAMPLE_PRD },
      });

      expect(result.success).toBe(true);
      expect((result.data as StructuredRequirement).meta.title).toBe('用户登录模块');
    });

    it('空PRD应该返回输入校验错误', async () => {
      const llm = createMockLLM(CLARIFICATION_JSON);
      const agent = new RequirementAgent(llm);

      const result = await agent.execute({
        instanceId: 'test',
        stage: 'requirement-clarification',
        input: { type: 'clarify', prdText: '' },
      });

      expect(result.success).toBe(false);
      expect(result.errors[0].code).toBe('EMPTY_PRD');
      expect(llm.complete).not.toHaveBeenCalled();
    });

    it('PRD过短应该返回warning但继续执行', async () => {
      const llm = createMockLLM(CLARIFICATION_JSON);
      const agent = new RequirementAgent(llm, { config: { maxRetries: 0, retryBaseDelayMs: 10 } });

      const result = await agent.execute({
        instanceId: 'test',
        stage: 'requirement-clarification',
        input: { type: 'clarify', prdText: '短文本' },
      });

      expect(result.success).toBe(true);
      expect(llm.complete).toHaveBeenCalledTimes(1);
    });

    it('输出无功能点应该校验失败并重试', async () => {
      const invalidJson = JSON.stringify({
        meta: { title: '测试', source: 'test', version: '1.0' },
        businessGoals: [],
        roles: [],
        features: [],
        businessRules: [],
        nonFunctionalRequirements: [],
        globalRequirements: [],
        trackingRequirements: [],
        clarificationLog: [],
      });
      const llm = createMockLLM(invalidJson);
      const agent = new RequirementAgent(llm, { config: { maxRetries: 1, retryBaseDelayMs: 10 } });

      const result = await agent.execute({
        instanceId: 'test',
        stage: 'requirement-clarification',
        input: { type: 'clarify', prdText: SAMPLE_PRD },
      });

      expect(result.success).toBe(false);
      expect(result.errors.some((e) => e.code === 'NO_FEATURES')).toBe(true);
      expect(result.llmCalls).toBe(2); // 1次初始 + 1次重试
    });

    it('应该检测到缺少非功能需求并返回warning', async () => {
      const jsonWithoutNFR = JSON.stringify({
        ...JSON.parse(CLARIFICATION_JSON),
        nonFunctionalRequirements: [],
      });
      const llm = createMockLLM(jsonWithoutNFR);
      const agent = new RequirementAgent(llm, { config: { maxRetries: 0, retryBaseDelayMs: 10 } });

      const result = await agent.execute({
        instanceId: 'test',
        stage: 'requirement-clarification',
        input: { type: 'clarify', prdText: SAMPLE_PRD },
      });

      expect(result.success).toBe(true);
      expect(result.errors.some((e) => e.code === 'MISSING_NFR')).toBe(true);
    });
  });

  describe('用户故事拆解模式', () => {
    it('应该成功生成用户故事和验收标准', async () => {
      const llm = createMockLLM(STORY_JSON);
      const agent = new RequirementAgent(llm, { config: { maxRetries: 0, retryBaseDelayMs: 10 } });

      const result = await agent.execute({
        instanceId: 'test',
        stage: 'stories-generating',
        input: { type: 'generate-stories', requirement: createFrozenRequirement() },
      });

      expect(result.success).toBe(true);
      const stories = result.data as import('../../src/types/user-story').UserStorySet;
      expect(stories.stories).toHaveLength(1);
      expect(stories.stories[0].title).toBe('手机号登录');
      expect(stories.stories[0].acceptanceCriteria).toHaveLength(2);
      expect(stories.qualityCheck.featureCoverage.coveredFeatures).toBe(1);
    });

    it('空需求应该返回输入校验错误', async () => {
      const llm = createMockLLM(STORY_JSON);
      const agent = new RequirementAgent(llm);

      const result = await agent.execute({
        instanceId: 'test',
        stage: 'stories-generating',
        input: {
          type: 'generate-stories',
          requirement: undefined as unknown as StructuredRequirement,
        },
      });

      expect(result.success).toBe(false);
      expect(result.errors[0].code).toBe('NO_REQUIREMENT');
    });

    it('需求未冻结应该返回warning但继续执行', async () => {
      const req = createFrozenRequirement();
      req.frozen.frozen = false;
      const llm = createMockLLM(STORY_JSON);
      const agent = new RequirementAgent(llm, { config: { maxRetries: 0, retryBaseDelayMs: 10 } });

      const result = await agent.execute({
        instanceId: 'test',
        stage: 'stories-generating',
        input: { type: 'generate-stories', requirement: req },
      });

      expect(result.success).toBe(true);
      expect(result.errors.some((e) => e.code === 'REQUIREMENT_NOT_FROZEN')).toBe(true);
    });

    it('故事缺少验收标准应该校验失败', async () => {
      const invalidStoryJson = JSON.stringify({
        stories: [
          {
            id: 's1',
            title: '测试故事',
            description: { role: '用户', action: '操作', benefit: '收益' },
            acceptanceCriteria: [],
            priority: 'P0',
            dependencies: [],
            relatedFeatureIds: ['f1'],
            relatedRuleIds: [],
            type: 'feature',
            hasExceptionFlow: false,
          },
        ],
        storyMap: [],
        nfrMapping: [],
      });
      const llm = createMockLLM(invalidStoryJson);
      const agent = new RequirementAgent(llm, { config: { maxRetries: 0, retryBaseDelayMs: 10 } });

      const result = await agent.execute({
        instanceId: 'test',
        stage: 'stories-generating',
        input: { type: 'generate-stories', requirement: createFrozenRequirement() },
      });

      expect(result.success).toBe(false);
      expect(result.errors.some((e) => e.code === 'NO_AC')).toBe(true);
    });

    it('应该检测到故事缺少异常流程AC并返回warning', async () => {
      const jsonWithoutException = JSON.stringify({
        stories: [
          {
            id: 's1',
            title: '测试故事',
            description: { role: '用户', action: '操作', benefit: '收益' },
            acceptanceCriteria: [
              {
                id: 'ac1',
                given: [],
                when: '操作',
                then: ['成功'],
                scenarioType: 'normal',
                testable: true,
              },
            ],
            priority: 'P0',
            dependencies: [],
            relatedFeatureIds: ['f1'],
            relatedRuleIds: [],
            type: 'feature',
            hasExceptionFlow: false,
          },
        ],
        storyMap: [],
        nfrMapping: [],
      });
      const llm = createMockLLM(jsonWithoutException);
      const agent = new RequirementAgent(llm, { config: { maxRetries: 0, retryBaseDelayMs: 10 } });

      const result = await agent.execute({
        instanceId: 'test',
        stage: 'stories-generating',
        input: { type: 'generate-stories', requirement: createFrozenRequirement() },
      });

      expect(result.success).toBe(true);
      expect(result.errors.some((e) => e.code === 'MISSING_EXCEPTION_AC')).toBe(true);
    });

    it('#5 INVEST 全部由程序计算（不再采纳 LLM 自评）', async () => {
      // 即使 LLM 输出了 qualityCheck.invest，也会被程序计算结果覆盖
      const json = JSON.stringify({
        ...JSON.parse(STORY_JSON),
        qualityCheck: {
          invest: { independent: false, negotiable: false, valuable: false, estimable: false, small: false, testable: false },
        },
      });
      const llm = createMockLLM(json);
      const agent = new RequirementAgent(llm, { config: { maxRetries: 0, retryBaseDelayMs: 10 } });

      const result = await agent.execute({
        instanceId: 'test',
        stage: 'stories-generating',
        input: { type: 'generate-stories', requirement: createFrozenRequirement() },
      });

      const stories = result.data as import('../../src/types/user-story').UserStorySet;
      // 全部由程序计算，不采纳 LLM 自评
      expect(stories.qualityCheck.invest.independent).toBe(true); // 程序计算：无 dependencies
      expect(stories.qualityCheck.invest.negotiable).toBe(true); // 程序无法判断，默认通过
      expect(stories.qualityCheck.invest.valuable).toBe(true); // 程序计算：benefit 非空
      expect(stories.qualityCheck.invest.estimable).toBe(true); // 程序计算：有 AC
      expect(stories.qualityCheck.invest.small).toBe(true); // 程序计算：AC 数 <= 5
      expect(stories.qualityCheck.invest.testable).toBe(true); // 程序计算：所有 AC 可测试
      expect(stories.qualityCheck.passed).toBe(true); // 全部通过
    });

    it('#5 LLM 谎称 small=true 时被程序计算结果覆盖', async () => {
      // 构造 11 条 AC（>10），small 必须为 false
      const ac = Array.from({ length: 11 }, (_, i) => ({
        id: `ac${i}`,
        given: [],
        when: '操作',
        then: ['结果'],
        scenarioType: 'normal',
        testable: true,
      }));
      const json = JSON.stringify({
        stories: [
          {
            id: 's1',
            title: '大故事',
            description: { role: '用户', action: '操作', benefit: '收益' },
            acceptanceCriteria: ac,
            priority: 'P0',
            dependencies: [],
            relatedFeatureIds: ['f1'],
            relatedRuleIds: [],
            type: 'feature',
            hasExceptionFlow: false,
          },
        ],
        storyMap: [],
        nfrMapping: [],
        qualityCheck: {
          invest: { independent: true, negotiable: true, valuable: true, estimable: true },
        },
      });
      const llm = createMockLLM(json);
      const agent = new RequirementAgent(llm, { config: { maxRetries: 0, retryBaseDelayMs: 10 } });
      const result = await agent.execute({
        instanceId: 'test',
        stage: 'stories-generating',
        input: { type: 'generate-stories', requirement: createFrozenRequirement() },
      });
      const stories = result.data as import('../../src/types/user-story').UserStorySet;
      expect(stories.qualityCheck.invest.small).toBe(false);
    });
  });

  describe('JSON提取', () => {
    it('应该从纯文本中提取JSON', async () => {
      const llm = createMockLLM('这是解释文字\n' + CLARIFICATION_JSON + '\n更多文字');
      const agent = new RequirementAgent(llm, { config: { maxRetries: 0, retryBaseDelayMs: 10 } });

      const result = await agent.execute({
        instanceId: 'test',
        stage: 'requirement-clarification',
        input: { type: 'clarify', prdText: SAMPLE_PRD },
      });

      expect(result.success).toBe(true);
    });
  });

  describe('澄清 followup 输入校验（#7）', () => {
    it('v1 用 humanAnswers 统一回答时，不误报 NO_ANSWERS', async () => {
      const base = createFrozenRequirement();
      base.frozen.frozen = false;
      const previous: StructuredRequirement = {
        ...base,
        humanAnswers: [{ answer: '确认支持', answeredAt: '2026-01-01T00:00:00.000Z' }],
      };
      const llm = createMockLLM(CLARIFICATION_JSON);
      const agent = new RequirementAgent(llm, { config: { maxRetries: 0, retryBaseDelayMs: 10 } });

      const result = await agent.execute({
        instanceId: 'test',
        stage: 'requirement-clarification',
        input: { type: 'clarify-followup', previousRequirement: previous },
      });

      expect(result.success).toBe(true);
      expect(result.errors.some((e) => e.code === 'NO_ANSWERS')).toBe(false);
    });

    it('answers 与 humanAnswers 都为空时给出 NO_ANSWERS warning', async () => {
      const previous = createFrozenRequirement();
      const llm = createMockLLM(CLARIFICATION_JSON);
      const agent = new RequirementAgent(llm, { config: { maxRetries: 0, retryBaseDelayMs: 10 } });

      const result = await agent.execute({
        instanceId: 'test',
        stage: 'requirement-clarification',
        input: { type: 'clarify-followup', previousRequirement: previous },
      });

      expect(result.errors.some((e) => e.code === 'NO_ANSWERS')).toBe(true);
    });
  });
});
