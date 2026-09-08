import { describe, it, expect, vi } from 'vitest';
import { Harness } from '../../src/core/harness';
import type { AgentRegistry } from '../../src/core/harness';
import { RequirementAgent } from '../../src/agents/requirement-agent';
import type { AgentContext, AgentResult } from '../../src/agents/types';
import type { LLMProvider, LLMResponse } from '../../src/llm/provider';
import type { StructuredRequirement } from '../../src/types/requirement';
import type { UserStorySet } from '../../src/types/user-story';

function createMockLLM(contents: string | string[]): LLMProvider {
  const contentList = Array.isArray(contents) ? contents : [contents];
  let callCount = 0;
  return {
    name: 'mock-llm',
    complete: vi.fn().mockImplementation(async () => {
      const content = contentList[Math.min(callCount, contentList.length - 1)];
      callCount++;
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

const CLARIFICATION_JSON = JSON.stringify({
  meta: { title: '测试需求', source: 'test.md', version: '1.0' },
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
  businessRules: [],
  nonFunctionalRequirements: [{ id: 'nfr1', category: 'performance', description: '性能' }],
  globalRequirements: [
    {
      id: 'greq1',
      category: 'authentication',
      description: '登录',
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

// followup 返回：保留已回答问题，无新 pending 问题
const FOLLOWUP_JSON = JSON.stringify({
  meta: { title: '测试需求', source: 'test.md', version: '1.0' },
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
  businessRules: [],
  nonFunctionalRequirements: [{ id: 'nfr1', category: 'performance', description: '性能' }],
  globalRequirements: [
    {
      id: 'greq1',
      category: 'authentication',
      description: '登录',
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
      status: 'answered',
      answer: '确认，支持第三方登录',
      answeredAt: '2026-01-01T00:00:00.000Z',
    },
  ],
});

const STORY_JSON = JSON.stringify({
  stories: [
    {
      id: 's1',
      title: '故事1',
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
        {
          id: 'ac2',
          given: [],
          when: '异常操作',
          then: ['失败'],
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
  storyMap: [{ groupName: '分组1', storyIds: ['s1'], order: 0 }],
  nfrMapping: [],
});

const SAMPLE_PRD = '# 测试需求\n\n这是一个测试PRD文档，包含足够的内容。';

function createAgents(llm: LLMProvider): AgentRegistry {
  return {
    requirement: new RequirementAgent(llm, { config: { maxRetries: 0, retryBaseDelayMs: 10 } }),
  };
}

describe('Harness', () => {
  describe('基本执行流程', () => {
    it('应该从 INIT 推进到 REQUIREMENT_CLARIFICATION 并等待人工', async () => {
      const llm = createMockLLM(CLARIFICATION_JSON);
      const harness = new Harness({ agents: createAgents(llm) });

      const result = await harness.start(SAMPLE_PRD, 'test.md');

      expect(result.success).toBe(true);
      expect(result.finalState).toBe('REQUIREMENT_CLARIFICATION');
      expect(result.waitingForHuman).toBe(true);
      expect(result.waitingQuestion).toContain('需求澄清');
      expect(result.waitingQuestion).toContain('第三方登录');
    });

    it('应该保存需求产物', async () => {
      const llm = createMockLLM(CLARIFICATION_JSON);
      const harness = new Harness({ agents: createAgents(llm) });

      await harness.start(SAMPLE_PRD, 'test.md');

      const requirement = harness.getArtifact<StructuredRequirement>('requirement');
      expect(requirement).toBeDefined();
      expect(requirement?.meta.title).toBe('测试需求');
      expect(requirement?.features).toHaveLength(1);
      expect(requirement?.frozen.frozen).toBe(false);
    });

    it('人工确认后应该推进到 STORIES_GENERATING 并生成故事', async () => {
      // 第一次：澄清结果，第二次：followup结果（无pending），第三次：故事结果
      const llm = createMockLLM([CLARIFICATION_JSON, FOLLOWUP_JSON, STORY_JSON]);
      const harness = new Harness({ agents: createAgents(llm) });

      // 第一步：到澄清硬卡点
      const result1 = await harness.start(SAMPLE_PRD);
      expect(result1.waitingForHuman).toBe(true);
      expect(result1.finalState).toBe('REQUIREMENT_CLARIFICATION');

      // 第二步：人工确认，继续到故事生成
      const result2 = await harness.resume('确认，支持第三方登录');
      // ADR-014：DesignAgent 未实现属于开发期错误，直接 FAILED（不再 SUSPENDED）
      expect(result2.success).toBe(false);
      expect(result2.finalState).toBe('FAILED');
      expect(result2.message).toContain('尚未实现');
    });

    it('人工确认后应该保存用户故事产物', async () => {
      const llm = createMockLLM([CLARIFICATION_JSON, FOLLOWUP_JSON, STORY_JSON]);
      const harness = new Harness({ agents: createAgents(llm) });
      await harness.start(SAMPLE_PRD);
      await harness.resume('确认');

      const stories = harness.getArtifact<UserStorySet>('stories');
      expect(stories).toBeDefined();
      expect(stories?.stories).toHaveLength(1);
      expect(stories?.stories[0].title).toBe('故事1');
    });

    it('人工确认后应该标记需求为已冻结', async () => {
      const llm = createMockLLM([CLARIFICATION_JSON, FOLLOWUP_JSON, STORY_JSON]);
      const harness = new Harness({ agents: createAgents(llm) });
      await harness.start(SAMPLE_PRD);
      await harness.resume('确认');

      const requirement = harness.getArtifact<StructuredRequirement>('requirement');
      expect(requirement?.frozen.frozen).toBe(true);
      expect(requirement?.clarificationLog[0].status).toBe('answered');
    });
  });

  describe('人工介入回调', () => {
    it('有回调时应该自动调用并继续执行', async () => {
      const llm = createMockLLM([CLARIFICATION_JSON, FOLLOWUP_JSON, STORY_JSON]);
      const callback = vi.fn().mockResolvedValue('自动确认');
      const harness = new Harness({
        agents: createAgents(llm),
        onHumanIntervention: callback,
      });

      const result = await harness.start(SAMPLE_PRD);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(
        'REQUIREMENT_CLARIFICATION',
        expect.stringContaining('需求澄清'),
        expect.any(Object),
      );
      expect(result.finalState).toBe('FAILED'); // ADR-014：DesignAgent 未实现直接失败
    });
  });

  describe('异常处理', () => {
    it('空 PRD 应该返回失败', async () => {
      const llm = createMockLLM(CLARIFICATION_JSON);
      const harness = new Harness({ agents: createAgents(llm) });

      const result = await harness.start('');
      expect(result.success).toBe(false);
      expect(result.finalState).toBe('FAILED');
    });

    it('Agent 持续失败应该返回 FAILED', async () => {
      const llm = createMockLLM('invalid json {{{');
      const harness = new Harness({
        agents: createAgents(llm),
      });

      const result = await harness.start(SAMPLE_PRD);
      expect(result.success).toBe(false);
      expect(result.finalState).toBe('FAILED');
    });

    it('没有对应 Agent 时应该失败（ADR-014 不再挂起）', async () => {
      const llm = createMockLLM([CLARIFICATION_JSON, FOLLOWUP_JSON, STORY_JSON]);
      const harness = new Harness({ agents: createAgents(llm) });
      await harness.start(SAMPLE_PRD);
      const result = await harness.resume('确认');

      expect(result.success).toBe(false);
      expect(result.finalState).toBe('FAILED');
      expect(result.message).toContain('DESIGN_GENERATING');
    });

    it('非等待状态调用 resume 应该失败', async () => {
      const llm = createMockLLM(CLARIFICATION_JSON);
      const harness = new Harness({ agents: createAgents(llm) });

      const result = await harness.resume('test');
      expect(result.success).toBe(false);
      expect(result.message).toContain('不是等待人工介入');
    });
  });

  describe('状态查询', () => {
    it('getState 应该返回当前状态的深拷贝', async () => {
      const llm = createMockLLM(CLARIFICATION_JSON);
      const harness = new Harness({ agents: createAgents(llm) });

      await harness.start(SAMPLE_PRD);
      const state1 = harness.getState();
      state1.currentState = 'COMPLETED'; // 尝试修改

      const state2 = harness.getState();
      expect(state2.currentState).toBe('REQUIREMENT_CLARIFICATION'); // 未被修改
    });

    it('listArtifacts 应该返回所有产物', async () => {
      const llm = createMockLLM([CLARIFICATION_JSON, FOLLOWUP_JSON, STORY_JSON]);
      const harness = new Harness({ agents: createAgents(llm) });
      await harness.start(SAMPLE_PRD);
      await harness.resume('确认');

      const artifacts = harness.listArtifacts();
      expect(artifacts.length).toBeGreaterThanOrEqual(2);
      expect(artifacts.some((a) => a.stage === 'requirement')).toBe(true);
      expect(artifacts.some((a) => a.stage === 'stories')).toBe(true);
    });
  });

  describe('全局上下文注入 / 产物回填 / 弱介入超时（一致性审计 #1/#6/#8）', () => {
    /** 按 stage 返回不同产物并捕获每次 AgentContext 的 stub */
    function createStubAgent(captured: AgentContext[]) {
      const minimalRequirement = {
        id: 'req-stub',
        instanceId: '',
        version: 1,
        meta: { title: 'stub', source: 'test', version: '1.0', parsedAt: '', frozenAt: '' },
        businessGoals: [],
        roles: [],
        features: [
          {
            id: 'f1',
            name: 'f',
            description: 'd',
            module: 'm',
            relatedRoleIds: [],
            relatedGoalIds: [],
            priority: 'P0' as const,
            hasExceptionFlow: false,
          },
        ],
        businessRules: [],
        nonFunctionalRequirements: [],
        globalRequirements: [],
        trackingRequirements: [],
        clarificationLog: [],
        frozen: { frozen: false, frozenAt: '', checklist: {} as never },
        createdAt: '',
        updatedAt: '',
      } as unknown as StructuredRequirement;

      const minimalStories = {
        id: 'stories-stub',
        instanceId: '',
        requirementId: 'req-stub',
        version: 1,
        stories: [],
        storyMap: [],
        nfrMapping: [],
      } as unknown as UserStorySet;

      const ok = (data: unknown): AgentResult => ({
        success: true,
        data,
        errors: [],
        durationMs: 1,
        llmCalls: 1,
        retries: 0,
      });

      return {
        execute: vi.fn().mockImplementation(async (ctx: AgentContext) => {
          captured.push(ctx);
          if (ctx.stage === 'stories-generating') return ok(minimalStories);
          return ok(minimalRequirement);
        }),
      } as unknown as RequirementAgent;
    }

    it('#1 globalContext 注入每次 AgentContext', async () => {
      const captured: AgentContext[] = [];
      const harness = new Harness({
        agents: { requirement: createStubAgent(captured) },
        globalContext: { techStack: 'React 18 + Vite', constraints: ['CSS Modules'] },
      });
      await harness.start(SAMPLE_PRD);
      expect(captured.length).toBeGreaterThan(0);
      expect(captured[0].globalContext?.techStack).toBe('React 18 + Vite');
      expect(captured[0].globalContext?.constraints).toEqual(['CSS Modules']);
    });

    it('#6 保存产物时回填 instanceId 到产物对象内部', async () => {
      const harness = new Harness({ agents: { requirement: createStubAgent([]) } });
      await harness.start(SAMPLE_PRD);
      const requirement = harness.getArtifact<StructuredRequirement>('requirement');
      expect(requirement?.instanceId).toBe(harness.instanceId);
      expect(requirement?.instanceId).not.toBe('');
    });

    it('#8 弱介入回调超时后自动继续（不被无限挂起）', async () => {
      const neverResolves = new Promise(() => {}); // 人工不决策
      const harness = new Harness({
        agents: { requirement: createStubAgent([]) },
        weakConfirmationTimeoutMs: 30,
        onWeakIntervention: vi.fn().mockReturnValue(neverResolves),
      });
      await harness.start(SAMPLE_PRD);
      const result = await harness.resume('确认');
      // 弱介入在故事生成后触发，30ms 无决策自动继续 → 进入 DESIGN_GENERATING，因无 Agent 而 FAILED
      expect(result.finalState).toBe('FAILED');
      expect(result.message).toContain('DESIGN_GENERATING');
    });
  });
});
