import { describe, it, expect, beforeEach } from 'vitest';
import { ContextManager } from '../../src/core/context-manager';
import type { GlobalContext } from '../../src/core/context-manager';
import { InMemoryArtifactStore } from '../../src/core/artifact-store';
import type { StructuredRequirement } from '../../src/types/requirement';
import type { UserStorySet } from '../../src/types/user-story';

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
    businessRules: [],
    nonFunctionalRequirements: [],
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

function createStorySet(): UserStorySet {
  const now = new Date().toISOString();
  return {
    id: 'stories-001',
    instanceId: 'inst-001',
    requirementId: 'req-001',
    version: 1,
    stories: [],
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
      acceptanceCriteriaStats: { total: 0, testable: 0, notTestable: 0 },
      featureCoverage: { totalFeatures: 0, coveredFeatures: 0, uncoveredFeatureIds: [] },
      passed: true,
      issues: [],
    },
    confirmation: { confirmedBy: 'ai-self-check', confirmedAt: now, version: 1 },
    createdAt: now,
    updatedAt: now,
  };
}

describe('ContextManager', () => {
  let artifactStore: InMemoryArtifactStore;
  let contextManager: ContextManager;

  beforeEach(() => {
    artifactStore = new InMemoryArtifactStore();
    contextManager = new ContextManager({ artifactStore });
  });

  describe('buildAgentInput', () => {
    it('REQUIREMENT_PARSING 应该从 extra 中提取 PRD 文本', () => {
      const input = contextManager.buildAgentInput('REQUIREMENT_PARSING', 'inst-001', {
        prdText: '这是PRD内容',
        prdSource: 'test.md',
      });

      expect(input).toEqual({
        type: 'clarify',
        prdText: '这是PRD内容',
        source: 'test.md',
      });
    });

    it('REQUIREMENT_PARSING 缺少 prdText 时返回 undefined', () => {
      const input = contextManager.buildAgentInput('REQUIREMENT_PARSING', 'inst-001', {});
      expect(input).toBeUndefined();
    });

    it('STORIES_GENERATING 应该从产物存储读取需求', () => {
      artifactStore.save('requirement', 'inst-001', createFrozenRequirement());

      const input = contextManager.buildAgentInput('STORIES_GENERATING', 'inst-001');

      expect(input).toBeDefined();
      expect((input as { type: string }).type).toBe('generate-stories');
      expect((input as { requirement: StructuredRequirement }).requirement.meta.title).toBe(
        '测试需求',
      );
    });

    it('STORIES_GENERATING 缺少需求产物时返回 undefined', () => {
      const input = contextManager.buildAgentInput('STORIES_GENERATING', 'inst-001');
      expect(input).toBeUndefined();
    });

    it('DESIGN_GENERATING 应该装配需求和用户故事', () => {
      artifactStore.save('requirement', 'inst-001', createFrozenRequirement());
      artifactStore.save('stories', 'inst-001', createStorySet());

      const input = contextManager.buildAgentInput('DESIGN_GENERATING', 'inst-001') as {
        type: string;
        requirement: StructuredRequirement;
        stories: UserStorySet;
      };

      expect(input.type).toBe('generate-design');
      expect(input.requirement.meta.title).toBe('测试需求');
      expect(input.stories.id).toBe('stories-001');
    });

    it('DESIGN_GENERATING 缺少需求或故事时返回 undefined', () => {
      artifactStore.save('requirement', 'inst-001', createFrozenRequirement());
      // 未保存 stories
      expect(contextManager.buildAgentInput('DESIGN_GENERATING', 'inst-001')).toBeUndefined();
    });

    it('硬卡点/终态等不执行 Agent 的状态返回空对象', () => {
      expect(contextManager.buildAgentInput('REQUIREMENT_CLARIFICATION', 'inst-001')).toEqual({});
      expect(contextManager.buildAgentInput('INIT', 'inst-001')).toEqual({});
      expect(contextManager.buildAgentInput('API_CONFIRMATION', 'inst-001')).toEqual({});
    });
  });

  describe('下游阶段输入装配（一致性审计 #2）', () => {
    // 下游产物 Schema 较大，这里只验证装配关系，用最小对象断言
    function minimalDesign() {
      return {
        id: 'design-001',
      } as unknown as import('../../src/types/frontend-design').FrontendDesignDoc;
    }
    function minimalCoding() {
      return { id: 'coding-001' } as unknown as import('../../src/types/coding-task').CodingResult;
    }
    function minimalCodeReview() {
      return {
        id: 'review-001',
      } as unknown as import('../../src/types/review-and-delivery').ReviewResult;
    }

    it('DESIGN_REVIEWING 装配 design，缺产物返回 undefined', () => {
      expect(contextManager.buildAgentInput('DESIGN_REVIEWING', 'inst-001')).toBeUndefined();
      artifactStore.save('design', 'inst-001', minimalDesign());
      const input = contextManager.buildAgentInput('DESIGN_REVIEWING', 'inst-001') as {
        type: string;
        design: { id: string };
      };
      expect(input.type).toBe('review-design');
      expect(input.design.id).toBe('design-001');
    });

    it('CODING 逐故事装配：缺 design 返回 undefined，有 design 返回该故事 CodingTask', () => {
      const story = {
        id: 's1',
        title: '登录',
        description: { role: '用户', action: '登录', benefit: '进入' },
        acceptanceCriteria: [
          {
            id: 'ac1',
            given: [],
            when: '提交',
            then: ['成功'],
            scenarioType: 'normal',
            testable: true,
          },
        ],
        priority: 'P0' as const,
        dependencies: [],
        relatedFeatureIds: [],
        relatedRuleIds: [],
        type: 'feature' as const,
        hasExceptionFlow: false,
      };
      const projectContext = { projectRoot: '/w', srcDir: 'src', projectType: 'new' as const };
      const build = () =>
        contextManager.buildCodingTaskForStory('inst-001', story, 0, 2, { projectContext });
      expect(build()).toBeUndefined();
      artifactStore.save('design', 'inst-001', {
        id: 'design-001',
        techStack: {
          source: 'suggested',
          framework: { name: 'React', version: '18' },
          language: 'TypeScript',
          stateManagement: { library: 'zustand' },
          testing: { framework: 'vitest' },
          buildTool: 'vite',
        },
        stateManagement: { principle: 'x', globalStores: [] },
        componentTree: [],
        apiContracts: [],
        dataModels: [],
        exceptionScenarios: [],
      } as unknown as import('../../src/types/frontend-design').FrontendDesignDoc);
      const task = build();
      expect(task?.storyId).toBe('s1');
      expect(task?.taskId).toBe('coding-task-s1');
      expect(task?.totalStories).toBe(2);
    });

    it('CODE_REVIEWING 装配 design + coding，缺一返回 undefined', () => {
      artifactStore.save('design', 'inst-001', minimalDesign());
      expect(contextManager.buildAgentInput('CODE_REVIEWING', 'inst-001')).toBeUndefined();
      artifactStore.save('coding', 'inst-001', minimalCoding());
      const input = contextManager.buildAgentInput('CODE_REVIEWING', 'inst-001') as {
        type: string;
        coding: { id: string };
      };
      expect(input.type).toBe('review-code');
      expect(input.coding.id).toBe('coding-001');
    });

    it('DELIVERING 装配 coding + codeReview，缺一返回 undefined', () => {
      artifactStore.save('coding', 'inst-001', minimalCoding());
      expect(contextManager.buildAgentInput('DELIVERING', 'inst-001')).toBeUndefined();
      artifactStore.save('code-review', 'inst-001', minimalCodeReview());
      const input = contextManager.buildAgentInput('DELIVERING', 'inst-001') as {
        type: string;
        codeReview: { id: string };
      };
      expect(input.type).toBe('deliver');
      expect(input.codeReview.id).toBe('review-001');
    });
  });

  describe('全局上下文', () => {
    it('应该返回默认空上下文', () => {
      const ctx = contextManager.getGlobalContext();
      expect(ctx).toEqual({});
    });

    it('应该返回配置的全局上下文', () => {
      const globalContext: GlobalContext = {
        techStack: 'React + TypeScript + Vite',
        codingStandards: 'ESLint + Prettier',
      };
      const cm = new ContextManager({ artifactStore, globalContext });

      const ctx = cm.getGlobalContext();
      expect(ctx.techStack).toBe('React + TypeScript + Vite');
      expect(ctx.codingStandards).toBe('ESLint + Prettier');
    });

    it('getGlobalContext 应该返回深拷贝，外部修改不影响内部', () => {
      const globalContext: GlobalContext = { techStack: 'React' };
      const cm = new ContextManager({ artifactStore, globalContext });

      const ctx = cm.getGlobalContext();
      ctx.techStack = 'Vue';

      expect(cm.getGlobalContext().techStack).toBe('React');
    });

    it('updateGlobalContext 应该合并更新', () => {
      const cm = new ContextManager({
        artifactStore,
        globalContext: { techStack: 'React', codingStandards: 'ESLint' },
      });

      cm.updateGlobalContext({ techStack: 'Vue' });

      const ctx = cm.getGlobalContext();
      expect(ctx.techStack).toBe('Vue');
      expect(ctx.codingStandards).toBe('ESLint'); // 保留原有
    });
  });

  describe('v2 预留接口', () => {
    it('buildAgentInputWithRefs 应该抛出未实现错误', () => {
      expect(() => contextManager.buildAgentInputWithRefs('CODING', 'inst-001')).toThrow(
        'v2 功能未实现：产物引用传递',
      );
    });

    it('retrieveRelevantParts 应该抛出未实现错误', () => {
      expect(() => contextManager.retrieveRelevantParts('artifact-1', 'query')).toThrow(
        'v2 功能未实现：按需检索',
      );
    });

    it('summarizeArtifact 应该抛出未实现错误', () => {
      expect(() => contextManager.summarizeArtifact('artifact-1')).toThrow(
        'v2 功能未实现：摘要压缩',
      );
    });
  });
});
