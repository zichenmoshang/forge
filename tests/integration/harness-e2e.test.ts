/**
 * Forge Harness + Agent 端到端验证脚本
 *
 * 验证内容：
 * 1. 完整状态转换路径（INIT → REQUIREMENT_PARSING → REQUIREMENT_CLARIFICATION → STORIES_GENERATING → SUSPENDED）
 * 2. 产物保存与内容验证（requirement / stories）
 * 3. 人工回答传递（#36 修复验证：followup prompt 包含 humanAnswers）
 * 4. 澄清问题状态转换（pending → resolved）
 * 5. 需求冻结机制
 * 6. 异常路径（空 PRD / Agent 失败 / 无 Agent 挂起）
 * 7. 知识库集成（Design 阶段检索）
 *
 * 运行：npx tsx tests/integration/harness-e2e.test.ts
 * 或作为 vitest 测试：npx vitest run tests/integration/
 */

import { describe, it, expect, vi } from 'vitest';
import { Harness } from '../../src/core/harness';
import type { AgentRegistry } from '../../src/core/harness';
import { RequirementAgent } from '../../src/agents/requirement-agent';
import { DesignAgent } from '../../src/agents/design-agent';
import { ReviewAgent } from '../../src/agents/review-agent';
import { CodingAgent } from '../../src/agents/coding-agent';
import type { CodingPhaseResult } from '../../src/types/coding-task';
import type { LLMProvider, LLMResponse, LLMRequest } from '../../src/llm/provider';
import type { StructuredRequirement } from '../../src/types/requirement';
import type { UserStorySet } from '../../src/types/user-story';
import type { FrontendDesignDoc } from '../../src/types/frontend-design';
import type { ReviewResult, DeliveryResult } from '../../src/types/review-and-delivery';
import { KnowledgeService } from '../../src/services/knowledge-service';
import { InMemoryVectorStore } from '../../src/services/vector-store';
import { MockEmbeddingProvider } from '../../src/llm/embedding-provider';
import { ASTParser } from '../../src/services/ast-parser';
import type { KnowledgeItem } from '../../src/types/knowledge';

// ============================================================
// Mock LLM：记录所有请求，用于验证 prompt 内容
// ============================================================
interface MockLLMCall {
  request: LLMRequest;
  response: string;
}

function createMockLLM(responses: string[]): { provider: LLMProvider; calls: MockLLMCall[] } {
  const calls: MockLLMCall[] = [];
  let callIndex = 0;
  const provider: LLMProvider = {
    name: 'mock-llm',
    complete: vi.fn().mockImplementation(async (request: LLMRequest) => {
      const response = responses[Math.min(callIndex, responses.length - 1)];
      callIndex++;
      calls.push({ request, response });
      return {
        content: response,
        model: 'mock-model',
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
        durationMs: 100,
        finishReason: 'stop',
      } as LLMResponse;
    }),
  };
  return { provider, calls };
}

// ============================================================
// 测试数据
// ============================================================
const SAMPLE_PRD = `# 用户登录系统

## 背景
公司需要一个统一的用户登录系统，支持账号密码登录。

## 功能需求
1. 用户可以使用用户名和密码登录
2. 登录成功后跳转到首页
3. 登录失败显示错误提示
4. 支持"记住我"功能

## 非功能需求
- 响应时间 < 2s
- 支持 1000 并发用户
`;

// 第一轮澄清：提出 2 个 pending 问题
const CLARIFICATION_JSON = JSON.stringify({
  meta: { title: '用户登录系统', source: 'login.md', version: '1.0' },
  businessGoals: [{ id: 'g1', description: '统一用户认证', priority: 'P0' }],
  roles: [{ id: 'r1', name: '普通用户', description: '使用系统的用户', coreNeeds: [] }],
  features: [
    {
      id: 'f1',
      name: '账号密码登录',
      description: '用户使用用户名和密码登录系统',
      module: '认证',
      relatedRoleIds: ['r1'],
      relatedGoalIds: ['g1'],
      priority: 'P0',
      hasExceptionFlow: true,
    },
  ],
  businessRules: [],
  nonFunctionalRequirements: [
    { id: 'nfr1', category: 'performance', description: '响应时间 < 2s' },
  ],
  globalRequirements: [],
  trackingRequirements: [],
  clarificationLog: [
    {
      id: 'q1',
      question: '是否需要支持验证码？',
      category: 'missing',
      priority: 'important',
      status: 'pending',
    },
    {
      id: 'q2',
      question: '密码找回方式是什么？',
      category: 'missing',
      priority: 'normal',
      status: 'pending',
    },
  ],
});

// followup：基于人工回答更新需求，无新 pending 问题
const FOLLOWUP_JSON = JSON.stringify({
  meta: { title: '用户登录系统', source: 'login.md', version: '1.1' },
  businessGoals: [{ id: 'g1', description: '统一用户认证', priority: 'P0' }],
  roles: [{ id: 'r1', name: '普通用户', description: '使用系统的用户', coreNeeds: [] }],
  features: [
    {
      id: 'f1',
      name: '账号密码登录',
      description: '用户使用用户名和密码登录系统，支持图形验证码',
      module: '认证',
      relatedRoleIds: ['r1'],
      relatedGoalIds: ['g1'],
      priority: 'P0',
      hasExceptionFlow: true,
    },
    {
      id: 'f2',
      name: '密码找回',
      description: '通过邮箱验证码找回密码',
      module: '认证',
      relatedRoleIds: ['r1'],
      relatedGoalIds: ['g1'],
      priority: 'P1',
      hasExceptionFlow: false,
    },
  ],
  businessRules: [],
  nonFunctionalRequirements: [
    { id: 'nfr1', category: 'performance', description: '响应时间 < 2s' },
  ],
  globalRequirements: [],
  trackingRequirements: [],
  clarificationLog: [],
});

// 故事生成
const STORY_JSON = JSON.stringify({
  stories: [
    {
      id: 's1',
      title: '用户使用账号密码登录',
      description: {
        role: '普通用户',
        action: '输入用户名密码并点击登录',
        benefit: '进入系统首页',
      },
      acceptanceCriteria: [
        {
          id: 'ac1',
          given: ['用户已注册', '用户在登录页面'],
          when: '输入正确的用户名和密码并点击登录',
          then: ['跳转到首页', '显示登录成功提示'],
          scenarioType: 'normal',
          testable: true,
        },
        {
          id: 'ac2',
          given: ['用户在登录页面'],
          when: '输入错误的密码并点击登录',
          then: ['显示"用户名或密码错误"提示', '停留在登录页面'],
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
  storyMap: [{ groupName: '认证模块', storyIds: ['s1'], order: 0 }],
  nfrMapping: [],
});

function createAgents(llm: LLMProvider): AgentRegistry {
  return {
    requirement: new RequirementAgent(llm, { config: { maxRetries: 0, retryBaseDelayMs: 10 } }),
  };
}

// 技术方案生成（覆盖 s1 的 ac1/ac2，四类基础异常齐全）
const DESIGN_JSON = JSON.stringify({
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
      description: '账号密码登录',
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
      id: 'api-login',
      name: '登录',
      method: 'POST',
      path: '/api/login',
      description: '账号密码登录',
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
      solution: '接口超时控制',
      measures: [],
      verification: '压测',
    },
  ],
  reusableComponents: [],
  directoryStructure: { name: 'src', type: 'directory', path: 'src' },
});

// 方案评审：无阻塞问题，通过
const REVIEW_JSON = JSON.stringify({
  conclusion: 'pass',
  summary: '方案完整，通过',
  issues: [],
  checklist: {
    coverage: {
      passed: true,
      storyCoverage: { total: 1, covered: 1, uncovered: [] },
      acCoverage: { total: 2, covered: 2, uncovered: [] },
    },
    exceptionCompleteness: { passed: true, checklist: [], missingScenarios: [] },
    apiConsistency: { passed: true, issues: [] },
    architecture: { passed: true, issues: [] },
    stateManagement: { passed: true, issues: [] },
    nfrCoverage: { passed: true, missingNfrIds: [] },
    componentReuse: { passed: true },
  },
});

function createFullAgents(llm: LLMProvider): AgentRegistry {
  const cfg = { config: { maxRetries: 0, retryBaseDelayMs: 10 } };
  // Mock DeliveryAgent：直接返回成功的 DeliveryResult，不执行真实文件/Git 操作
  const mockDeliveryResult: DeliveryResult = {
    deliveryId: 'mock-delivery',
    instanceId: 'test-instance',
    status: 'success',
    scenario: 'code-modification',
    git: {
      branchName: 'feature/forge/test',
      baseBranch: 'main',
      commitCount: 1,
      commits: [
        {
          hash: 'abc123',
          message: 'feat: test',
          author: 'forge-bot',
          createdAt: '2026-09-06T00:00:00Z',
        },
      ],
    },
    pullRequest: { title: '测试 PR', description: 'Mock PR description', status: 'draft' },
    changes: {
      filesAdded: 2,
      filesModified: 0,
      filesDeleted: 0,
      linesAdded: 100,
      linesDeleted: 0,
      files: [{ path: 'src/App.tsx', operation: 'add', summary: '新增 App' }],
    },
    buildVerification: { passed: true },
    completedStories: ['story-1'],
    deliveredAt: '2026-09-06T00:00:00Z',
  };
  const delivery = {
    execute: vi.fn().mockResolvedValue({
      success: true,
      data: mockDeliveryResult,
      errors: [],
      durationMs: 10,
      llmCalls: 0,
      retries: 0,
    }),
  };
  return {
    requirement: new RequirementAgent(llm, cfg),
    design: new DesignAgent(llm, cfg),
    review: new ReviewAgent(llm, cfg),
    coding: new CodingAgent(llm, cfg),
    delivery: delivery as unknown as AgentRegistry['delivery'],
  };
}

function createKnowledgeService(): KnowledgeService {
  KnowledgeService.resetInstance();
  return KnowledgeService.getInstance({
    vectorStore: new InMemoryVectorStore(),
    embeddingProvider: new MockEmbeddingProvider(1024),
    astParser: new ASTParser(),
  });
}

// ============================================================
// 端到端测试
// ============================================================
describe('Harness + Agent 端到端验证', () => {
  describe('1. 完整状态转换路径', () => {
    it('应该按正确顺序转换状态', async () => {
      const { provider, calls } = createMockLLM([CLARIFICATION_JSON, FOLLOWUP_JSON, STORY_JSON]);
      const harness = new Harness({
        agents: createAgents(provider),
        projectId: 'test-project',
      });

      // 第一步：INIT → REQUIREMENT_PARSING → REQUIREMENT_CLARIFICATION
      const result1 = await harness.start(SAMPLE_PRD, 'login.md');
      expect(result1.success).toBe(true);
      expect(result1.finalState).toBe('REQUIREMENT_CLARIFICATION');
      expect(result1.waitingForHuman).toBe(true);
      expect(result1.waitingQuestion).toContain('验证码');
      expect(result1.waitingQuestion).toContain('密码找回');

      // 验证 LLM 调用次数（第一次澄清）
      expect(calls).toHaveLength(1);

      // 第二步：人工回答 → followup → STORIES_GENERATING → FAILED（DesignAgent 未实现，ADR-014）
      const result2 = await harness.resume('不需要验证码，密码找回通过邮箱');
      expect(result2.success).toBe(false);
      expect(result2.finalState).toBe('FAILED');
      expect(result2.message).toContain('DESIGN_GENERATING');

      // 验证 LLM 调用次数（澄清 + followup + 故事生成 = 3次）
      expect(calls).toHaveLength(3);
    });
  });

  describe('2. 产物保存与内容验证', () => {
    it('应该正确保存 requirement 和 stories 产物', async () => {
      const { provider } = createMockLLM([CLARIFICATION_JSON, FOLLOWUP_JSON, STORY_JSON]);
      const harness = new Harness({ agents: createAgents(provider) });

      await harness.start(SAMPLE_PRD, 'login.md');
      await harness.resume('不需要验证码，密码找回通过邮箱');

      // 验证 requirement 产物
      const requirement = harness.getArtifact<StructuredRequirement>('requirement');
      expect(requirement).toBeDefined();
      expect(requirement?.meta.title).toBe('用户登录系统');
      expect(requirement?.meta.version).toBe('1.1'); // followup 后版本更新
      expect(requirement?.features).toHaveLength(2); // followup 新增了密码找回功能
      expect(requirement?.features[1].name).toBe('密码找回');

      // 验证 stories 产物
      const stories = harness.getArtifact<UserStorySet>('stories');
      expect(stories).toBeDefined();
      expect(stories?.stories).toHaveLength(1);
      expect(stories?.stories[0].title).toBe('用户使用账号密码登录');
      expect(stories?.stories[0].acceptanceCriteria).toHaveLength(2); // 正常 + 异常
      expect(stories?.stories[0].hasExceptionFlow).toBe(true);

      // 验证产物列表
      const artifacts = harness.listArtifacts();
      expect(artifacts.length).toBeGreaterThanOrEqual(2);
      const stages = artifacts.map((a) => a.stage);
      expect(stages).toContain('requirement');
      expect(stages).toContain('stories');
    });
  });

  describe('3. 人工回答传递（#36 修复验证）', () => {
    it('followup prompt 应该包含人工回答内容', async () => {
      const { provider, calls } = createMockLLM([CLARIFICATION_JSON, FOLLOWUP_JSON, STORY_JSON]);
      const harness = new Harness({ agents: createAgents(provider) });

      await harness.start(SAMPLE_PRD, 'login.md');
      await harness.resume('不需要验证码，密码找回通过邮箱');

      // 第二次 LLM 调用是 followup，验证 prompt 中包含人工回答
      expect(calls.length).toBeGreaterThanOrEqual(2);
      const followupCall = calls[1];
      expect(followupCall.request.prompt).toContain('不需要验证码');
      expect(followupCall.request.prompt).toContain('密码找回通过邮箱');
      expect(followupCall.request.prompt).toContain('人工回答记录');
    });

    it('humanAnswers 应该记录人工回答历史', async () => {
      const { provider } = createMockLLM([CLARIFICATION_JSON, FOLLOWUP_JSON, STORY_JSON]);
      const harness = new Harness({ agents: createAgents(provider) });

      await harness.start(SAMPLE_PRD, 'login.md');
      await harness.resume('不需要验证码，密码找回通过邮箱');

      const requirement = harness.getArtifact<StructuredRequirement>('requirement');
      expect(requirement?.humanAnswers).toBeDefined();
      expect(requirement?.humanAnswers).toHaveLength(1);
      expect(requirement?.humanAnswers?.[0].answer).toBe('不需要验证码，密码找回通过邮箱');
      expect(requirement?.humanAnswers?.[0].answeredAt).toBeDefined();
    });
  });

  describe('4. 澄清问题状态转换', () => {
    it('pending 问题应该在人工回答后标记为 resolved', async () => {
      const { provider } = createMockLLM([CLARIFICATION_JSON, FOLLOWUP_JSON, STORY_JSON]);
      const harness = new Harness({ agents: createAgents(provider) });

      await harness.start(SAMPLE_PRD, 'login.md');

      // 澄清阶段：问题应该是 pending
      const reqBefore = harness.getArtifact<StructuredRequirement>('requirement');
      expect(reqBefore?.clarificationLog).toHaveLength(2);
      expect(reqBefore?.clarificationLog.every((q) => q.status === 'pending')).toBe(true);

      await harness.resume('不需要验证码，密码找回通过邮箱');

      // followup 后：Agent 返回空 clarificationLog，humanAnswers 有记录
      const reqAfter = harness.getArtifact<StructuredRequirement>('requirement');
      expect(reqAfter?.clarificationLog).toHaveLength(0); // Agent 认为已充分
      expect(reqAfter?.humanAnswers).toHaveLength(1);
    });
  });

  describe('5. 需求冻结机制', () => {
    it('澄清完成后应该标记需求为已冻结', async () => {
      const { provider } = createMockLLM([CLARIFICATION_JSON, FOLLOWUP_JSON, STORY_JSON]);
      const harness = new Harness({ agents: createAgents(provider) });

      await harness.start(SAMPLE_PRD, 'login.md');

      // 澄清阶段：未冻结
      const reqBefore = harness.getArtifact<StructuredRequirement>('requirement');
      expect(reqBefore?.frozen.frozen).toBe(false);

      await harness.resume('不需要验证码，密码找回通过邮箱');

      // 澄清完成：已冻结
      const reqAfter = harness.getArtifact<StructuredRequirement>('requirement');
      expect(reqAfter?.frozen.frozen).toBe(true);
      expect(reqAfter?.frozen.frozenAt).toBeDefined();
    });
  });

  describe('6. 异常路径', () => {
    it('空 PRD 应该返回失败', async () => {
      const { provider } = createMockLLM([CLARIFICATION_JSON]);
      const harness = new Harness({ agents: createAgents(provider) });

      const result = await harness.start('');
      expect(result.success).toBe(false);
      expect(result.finalState).toBe('FAILED');
      expect(result.message).toBeDefined();
    });

    it('Agent 输出无效 JSON 应该失败（不重试业务失败）', async () => {
      const { provider, calls } = createMockLLM(['invalid json {{{']);
      const harness = new Harness({
        agents: createAgents(provider),
        maxRetries: 0, // 不重试
      });

      const result = await harness.start(SAMPLE_PRD);
      expect(result.success).toBe(false);
      expect(result.finalState).toBe('FAILED');
      // BaseAgent 内部 maxRetries=0，所以只调用 1 次
      expect(calls).toHaveLength(1);
    });

    it('没有对应 Agent 时应该 FAILED（ADR-014 不再 SUSPENDED）', async () => {
      const { provider } = createMockLLM([CLARIFICATION_JSON, FOLLOWUP_JSON, STORY_JSON]);
      const harness = new Harness({ agents: createAgents(provider) });

      await harness.start(SAMPLE_PRD);
      const result = await harness.resume('确认');

      expect(result.success).toBe(false);
      expect(result.finalState).toBe('FAILED');
      expect(result.message).toContain('DESIGN_GENERATING');
      expect(result.message).toContain('尚未实现');
    });

    it('非等待状态调用 resume 应该失败', async () => {
      const { provider } = createMockLLM([CLARIFICATION_JSON]);
      const harness = new Harness({ agents: createAgents(provider) });

      const result = await harness.resume('test');
      expect(result.success).toBe(false);
      expect(result.message).toContain('不是等待人工介入');
    });
  });

  describe('7. 知识库集成', () => {
    it('Harness 接收知识库服务并通过 AgentContext 注入（ADR-014：检索由 Agent 负责）', async () => {
      const knowledgeService = createKnowledgeService();
      // 索引一些测试知识
      const item: KnowledgeItem = {
        id: 'kb-1',
        title: '登录组件设计规范',
        content: '登录表单应该包含用户名、密码、记住我、登录按钮',
        summary: '登录组件设计规范',
        type: 'design-doc',
        source: 'wiki',
        projectScope: 'global',
        status: 'active',
        weight: 1.0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await knowledgeService.indexDocument(item);

      const { provider } = createMockLLM([CLARIFICATION_JSON, FOLLOWUP_JSON, STORY_JSON]);
      const harness = new Harness({
        agents: createAgents(provider),
        knowledgeService,
        projectId: 'test-project',
      });

      await harness.start(SAMPLE_PRD);
      await harness.resume('确认');

      // ADR-014：ContextManager 不再预检索，知识库数据由 Agent 内部检索；
      // 此处验证服务可正常装配、索引数据存在，Agent 检索行为待 DesignAgent 测试覆盖
      const status = await knowledgeService.getStatus();
      expect(status.totalItems).toBe(1);
    });

    it('projectScope 应该正确隔离不同项目', async () => {
      const knowledgeService = createKnowledgeService();

      // 索引项目 A 的知识
      await knowledgeService.indexDocument({
        id: 'proj-a-1',
        title: '项目A专属组件',
        content: '项目A的专属组件',
        summary: '项目A专属组件',
        type: 'component',
        source: 'code',
        projectScope: 'project-a',
        status: 'active',
        weight: 1.0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // 索引 global 知识
      await knowledgeService.indexDocument({
        id: 'global-1',
        title: '全局设计规范',
        content: '全局设计规范',
        summary: '全局设计规范',
        type: 'design-doc',
        source: 'wiki',
        projectScope: 'global',
        status: 'active',
        weight: 1.0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // 项目 B 检索：应该只能看到 global，看不到 project-a
      const results = await knowledgeService.search('组件', {
        projectScope: 'project-b',
        topK: 10,
      });
      const scopes = results.map((r) => r.projectScope);
      expect(scopes).toContain('global');
      expect(scopes).not.toContain('project-a');
    });
  });

  describe('8. 状态查询与封装性', () => {
    it('getState 应该返回深拷贝，外部修改不影响内部', async () => {
      const { provider } = createMockLLM([CLARIFICATION_JSON]);
      const harness = new Harness({ agents: createAgents(provider) });

      await harness.start(SAMPLE_PRD);
      const state1 = harness.getState();
      state1.currentState = 'COMPLETED'; // 尝试修改

      const state2 = harness.getState();
      expect(state2.currentState).toBe('REQUIREMENT_CLARIFICATION'); // 未被修改
    });

    it('instanceId 应该唯一', async () => {
      const { provider } = createMockLLM([CLARIFICATION_JSON]);
      const harness1 = new Harness({ agents: createAgents(provider) });
      const harness2 = new Harness({ agents: createAgents(provider) });

      expect(harness1.getState().instanceId).not.toBe(harness2.getState().instanceId);
    });
  });

  describe('9. 方案设计 + 单轮评审链路（方案 A）', () => {
    it('需求→故事→方案→单轮评审后停在 API_CONFIRMATION 硬卡点', async () => {
      const { provider, calls } = createMockLLM([
        CLARIFICATION_JSON,
        FOLLOWUP_JSON,
        STORY_JSON,
        DESIGN_JSON,
        REVIEW_JSON,
      ]);
      const harness = new Harness({
        agents: createFullAgents(provider),
        projectId: 'test-project',
      });

      await harness.start(SAMPLE_PRD, 'login.md');
      const result = await harness.resume('确认，按此设计');

      // CODING 未实现，但应先停在 API_CONFIRMATION 硬卡点（评审已过）
      expect(result.success).toBe(true);
      expect(result.finalState).toBe('API_CONFIRMATION');
      expect(result.waitingForHuman).toBe(true);

      // 澄清/followup/故事/方案/评审 = 5 次 LLM 调用
      expect(calls).toHaveLength(5);

      // 方案产物：覆盖度程序计算、instanceId 回填、新增 API 待确认
      const design = harness.getArtifact<FrontendDesignDoc>('design');
      expect(design).toBeDefined();
      expect(design?.instanceId).toBe(harness.instanceId);
      expect(design?.coverageCheck.passed).toBe(true);
      expect(design?.coverageCheck.acCoverage.coveredACs).toBe(2);
      expect(design?.apiConfirmation.required).toBe(true);
      expect(design?.apiConfirmation.pendingApiIds).toEqual(['api-login']);

      // 评审产物：单轮通过、无阻塞
      const review = harness.getArtifact<ReviewResult>('design-review');
      expect(review).toBeDefined();
      expect(review?.reviewType).toBe('design-review');
      expect(review?.targetVersion).toBe(design?.version);
      expect(review?.issues).toEqual([]);
      expect(review?.resolvedAction).toBe('approve');
    });

    const R1_BLOCKING = JSON.stringify({
      conclusion: 'reject',
      summary: '覆盖不足',
      issues: [
        {
          issueId: 'I1',
          severity: 'blocker',
          category: 'coverage',
          description: 'ac2 错误凭证场景未覆盖',
          suggestion: '补错误提示组件',
          status: 'open',
          blocking: true,
        },
      ],
    });

    const REVISE_OUTPUT = JSON.stringify({
      changeSummary: '补充错误提示',
      changedSections: ['c1'],
      issueResponses: [{ issueId: 'I1', action: 'fixed', explanation: '已补错误提示分支' }],
      updatedDesign: JSON.parse(DESIGN_JSON),
    });

    const R2_PASS = JSON.stringify({
      conclusion: 'pass',
      dialogAction: 'approve',
      summary: '已修复，通过',
      issues: [
        {
          issueId: 'I1',
          severity: 'blocker',
          category: 'coverage',
          description: 'ac2 错误凭证场景未覆盖',
          suggestion: '补错误提示组件',
          status: 'resolved',
          blocking: true,
          verification: { round: 2, result: 'resolved', note: '已核实' },
        },
      ],
    });

    it('首轮 blocking → 自动 revise → 二轮通过到 API 卡点，方案版本递增且记录两轮历史', async () => {
      const { provider, calls } = createMockLLM([
        CLARIFICATION_JSON,
        FOLLOWUP_JSON,
        STORY_JSON,
        DESIGN_JSON,
        R1_BLOCKING,
        REVISE_OUTPUT,
        R2_PASS,
      ]);
      const harness = new Harness({ agents: createFullAgents(provider) });

      await harness.start(SAMPLE_PRD);
      const result = await harness.resume('确认');

      expect(result.success).toBe(true);
      expect(result.finalState).toBe('API_CONFIRMATION');
      // 澄清/followup/故事/方案/评审1/修订/评审2 = 7 次
      expect(calls).toHaveLength(7);

      // 方案经过一次 revise，版本由 1 递增到 2
      const design = harness.getArtifact<FrontendDesignDoc>('design');
      expect(design?.version).toBe(2);

      // 最新评审为二轮、通过
      const review = harness.getArtifact<ReviewResult>('design-review');
      expect(review?.resolvedAction).toBe('approve');
      expect(review?.issues[0].status).toBe('resolved');

      // 对话历史记录两轮，最终 approved，finalVersion=2
      const history =
        harness.getArtifact<import('../../src/types/review-dialog').ReviewDialogHistory>(
          'design-review-history',
        );
      expect(history?.rounds).toHaveLength(2);
      expect(history?.finalVerdict).toBe('approved');
      expect(history?.finalVersion).toBe(2);
    });

    it('达到最大轮次仍未通过时停在 DESIGN_REVIEWING，人工 resume 放行到 API 卡点', async () => {
      const { provider } = createMockLLM([
        CLARIFICATION_JSON,
        FOLLOWUP_JSON,
        STORY_JSON,
        DESIGN_JSON,
        R1_BLOCKING,
        REVISE_OUTPUT, // maxRounds=1：第 1 轮内仍会 revise 一次，之后无下一轮评审
      ]);
      const harness = new Harness({ agents: createFullAgents(provider), maxReviewRounds: 1 });

      await harness.start(SAMPLE_PRD);
      const paused = await harness.resume('确认');
      expect(paused.finalState).toBe('DESIGN_REVIEWING');
      expect(paused.waitingForHuman).toBe(true);
      expect(paused.message).toContain('最大评审轮次');

      const history =
        harness.getArtifact<import('../../src/types/review-dialog').ReviewDialogHistory>(
          'design-review-history',
        );
      expect(history?.finalVerdict).toBe('max_rounds_reached');

      // 人工放行 → 推进到 API 确认硬卡点
      const resumed = await harness.resume('人工接受当前版本');
      expect(resumed.finalState).toBe('API_CONFIRMATION');
      expect(resumed.waitingForHuman).toBe(true);
    });

    it('Reviewer request_human 时暂停，resume 续跑下一轮后通过', async () => {
      const R1_HUMAN = JSON.stringify({
        conclusion: 'pass-with-comments',
        dialogAction: 'request_human',
        summary: '存在争议，需要人工判断方向',
        issues: [],
      });
      const { provider, calls } = createMockLLM([
        CLARIFICATION_JSON,
        FOLLOWUP_JSON,
        STORY_JSON,
        DESIGN_JSON,
        R1_HUMAN, // 第 1 轮请求人工（不触发 revise）
        JSON.stringify({ conclusion: 'pass', summary: '人工确认方向后通过', issues: [] }), // 第 2 轮
      ]);
      const harness = new Harness({ agents: createFullAgents(provider) });

      await harness.start(SAMPLE_PRD);
      const paused = await harness.resume('确认');
      expect(paused.finalState).toBe('DESIGN_REVIEWING');
      expect(paused.waitingForHuman).toBe(true);
      expect(calls).toHaveLength(5); // 停在第 1 轮评审，未 revise

      const resumed = await harness.resume('按方向二继续');
      expect(resumed.finalState).toBe('API_CONFIRMATION');
      expect(calls).toHaveLength(6); // 仅多一次第 2 轮评审
    });

    it('interruptAfterEachRound 弱介入回退到方案重生成后，旧评审历史失效、重新从首轮评审', async () => {
      const { provider, calls } = createMockLLM([
        CLARIFICATION_JSON,
        FOLLOWUP_JSON,
        STORY_JSON,
        DESIGN_JSON, // 首次生成 v1
        R1_BLOCKING, // 首轮评审 blocking
        REVISE_OUTPUT, // 修订 v2，随后弱介入要求回退
        DESIGN_JSON, // 回退后重新生成（版本重置为 1，清空旧评审历史）
        REVIEW_JSON, // 重新从首轮评审，approve
      ]);
      const harness = new Harness({
        agents: createFullAgents(provider),
        interruptAfterEachRound: true,
        onWeakIntervention: async (state) =>
          state === 'DESIGN_REVIEWING'
            ? { action: 'fallback', to: 'DESIGN_GENERATING', reason: '方案方向不对，重新设计' }
            : { action: 'continue' },
      });

      await harness.start(SAMPLE_PRD);
      const result = await harness.resume('确认');
      expect(result.finalState).toBe('API_CONFIRMATION');
      expect(calls).toHaveLength(8);

      // 回退重生成后方案版本重置，评审历史只记录重新评审的 1 轮
      const design = harness.getArtifact<FrontendDesignDoc>('design');
      expect(design?.version).toBe(1);
      const history =
        harness.getArtifact<import('../../src/types/review-dialog').ReviewDialogHistory>(
          'design-review-history',
        );
      expect(history?.rounds).toHaveLength(1);
      expect(history?.finalVerdict).toBe('approved');
    });
  });

  // ============================================================
  // 10. 编码阶段：逐故事 TDD + 部分成功出口（#40）
  // ============================================================
  describe('10. 编码阶段（逐故事 TDD）', () => {
    const CODING_RED = JSON.stringify({
      testFiles: [
        {
          path: 'src/Login.test.ts',
          type: 'test',
          operation: 'create',
          summary: '登录测试',
          content:
            "describe('Login', () => { it('ac1 正常登录', () => {}); it('ac2 错误密码', () => {}) })",
          relatedAcIds: ['ac1', 'ac2'],
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
      acTestMapping: { ac1: ['ac1 正常登录'], ac2: ['ac2 错误密码'] },
    });
    const CODING_GREEN = JSON.stringify({
      implFiles: [
        {
          path: 'src/Login.tsx',
          type: 'component',
          operation: 'create',
          summary: '登录实现',
          content: 'export const Login = () => null',
          relatedAcIds: ['ac1', 'ac2'],
        },
      ],
      updatedTestFiles: [],
      needsDesignFallback: false,
      fallbackReason: '',
    });

    it('全故事成功：API 确认后逐故事 red→green，CR 通过后进入 DELIVERY_CONFIRMATION 硬卡点', async () => {
      const CR_APPROVE = JSON.stringify({
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
      });
      const { provider, calls } = createMockLLM([
        CLARIFICATION_JSON,
        FOLLOWUP_JSON,
        STORY_JSON,
        DESIGN_JSON,
        REVIEW_JSON,
        CODING_RED,
        CODING_GREEN,
        CR_APPROVE,
      ]);
      const harness = new Harness({ agents: createFullAgents(provider) });

      await harness.start(SAMPLE_PRD);
      const atApi = await harness.resume('确认澄清');
      expect(atApi.finalState).toBe('API_CONFIRMATION');

      const coded = await harness.resume('API 契约已确认');
      expect(coded.finalState).toBe('DELIVERY_CONFIRMATION');
      expect(coded.waitingForHuman).toBe(true);
      // 澄清/followup/故事/方案/评审 + red + green + CR = 8
      expect(calls).toHaveLength(8);

      const phase = harness.getArtifact<CodingPhaseResult>('coding');
      expect(phase?.overallStatus).toBe('all-success');
      expect(phase?.totalStories).toBe(1);
      expect(phase?.successStoryIds).toEqual(['s1']);
      expect(phase?.overallTestStats.totalTests).toBe(2);
      expect(phase?.allFiles.map((f) => f.path).sort()).toEqual([
        'src/Login.test.ts',
        'src/Login.tsx',
        'src/api/login.mock.ts',
      ]);
      // CR 历史产物已生成
      const crHistory =
        harness.getArtifact<import('../../src/types/review-dialog').ReviewDialogHistory>(
          'code-review-history',
        );
      expect(crHistory?.finalVerdict).toBe('approved');
      expect(crHistory?.rounds).toHaveLength(1);
    });

    it('故事 red 始终无法产出有效测试 → 全失败 → FAILED，不进入 CR', async () => {
      const BAD_RED = JSON.stringify({
        testFiles: [{ path: 'src/bad.test.ts', type: 'test', content: "it('x', () => {})" }],
        mockFiles: [],
        acTestMapping: {}, // 缺 ac1/ac2 映射，red 校验失败
      });
      const { provider } = createMockLLM([
        CLARIFICATION_JSON,
        FOLLOWUP_JSON,
        STORY_JSON,
        DESIGN_JSON,
        REVIEW_JSON,
        BAD_RED,
      ]);
      const harness = new Harness({ agents: createFullAgents(provider) });

      await harness.start(SAMPLE_PRD);
      await harness.resume('确认澄清');
      const coded = await harness.resume('API 已确认');
      expect(coded.success).toBe(false);
      expect(coded.finalState).toBe('FAILED');
      expect(coded.message).toContain('全部故事失败');
    });
  });

  // ============================================================
  // 11. 代码 CR 多轮对话（Reviewer ↔ Coder）
  // ============================================================
  describe('11. 代码 CR 多轮对话', () => {
    const CODING_RED = JSON.stringify({
      testFiles: [
        {
          path: 'src/Login.test.ts',
          type: 'test',
          operation: 'create',
          summary: '登录测试',
          content:
            "describe('Login', () => { it('ac1 正常登录', () => {}); it('ac2 错误密码', () => {}) })",
          relatedAcIds: ['ac1', 'ac2'],
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
      acTestMapping: { ac1: ['ac1 正常登录'], ac2: ['ac2 错误密码'] },
    });
    const CODING_GREEN = JSON.stringify({
      implFiles: [
        {
          path: 'src/Login.tsx',
          type: 'component',
          operation: 'create',
          summary: '登录实现',
          content: 'export const Login = () => null',
          relatedAcIds: ['ac1', 'ac2'],
        },
      ],
      updatedTestFiles: [],
      needsDesignFallback: false,
      fallbackReason: '',
    });
    const CR_CHANGES = JSON.stringify({
      conclusion: 'reject',
      summary: '有阻塞问题',
      issues: [
        {
          issueId: 'C1',
          severity: 'blocker',
          category: 'security',
          description: '硬编码密钥',
          location: { target: 'src/Login.tsx', detail: 'L1' },
          suggestion: '移除硬编码密钥',
          status: 'open',
          relatedStoryIds: ['s1'],
        },
      ],
    });
    const REVISE_OUTPUT = JSON.stringify({
      changeSummary: '已移除硬编码密钥',
      changedFiles: ['src/Login.tsx'],
      issueResponses: [
        { issueId: 'C1', action: 'fixed', explanation: '已移除硬编码密钥，改用环境变量' },
      ],
      updatedFiles: [
        {
          path: 'src/Login.tsx',
          type: 'component',
          operation: 'modify',
          summary: '移除硬编码密钥',
          content: 'export const LoginForm = () => null',
          relatedAcIds: ['ac1', 'ac2'],
        },
      ],
      needsDesignFallback: false,
      fallbackReason: '',
    });
    const CR_APPROVE_VERIFIED = JSON.stringify({
      conclusion: 'pass',
      summary: '已修复',
      issues: [
        {
          issueId: 'C1',
          severity: 'blocker',
          category: 'security',
          description: '硬编码密钥',
          suggestion: '移除硬编码密钥',
          status: 'resolved',
          verification: { round: 2, result: 'resolved', note: '已移除硬编码密钥' },
        },
      ],
    });
    const CR_HUMAN = JSON.stringify({
      conclusion: 'pass-with-comments',
      summary: '需要人工裁决技术选型',
      dialogAction: 'request_human',
      issues: [],
    });
    const CR_APPROVE = JSON.stringify({
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
    });

    it('CR request_changes → Coder revise → 第2轮 verification 通过 → DELIVERY_CONFIRMATION', async () => {
      const { provider, calls } = createMockLLM([
        CLARIFICATION_JSON,
        FOLLOWUP_JSON,
        STORY_JSON,
        DESIGN_JSON,
        REVIEW_JSON,
        CODING_RED,
        CODING_GREEN,
        CR_CHANGES, // 第1轮 CR：要求修改
        REVISE_OUTPUT, // Coder 修订
        CR_APPROVE_VERIFIED, // 第2轮 CR：验证通过
      ]);
      const harness = new Harness({ agents: createFullAgents(provider) });

      await harness.start(SAMPLE_PRD);
      await harness.resume('确认澄清');
      const result = await harness.resume('API 已确认');
      expect(result.finalState).toBe('DELIVERY_CONFIRMATION');
      expect(result.waitingForHuman).toBe(true);
      expect(calls).toHaveLength(10);

      const history =
        harness.getArtifact<import('../../src/types/review-dialog').ReviewDialogHistory>(
          'code-review-history',
        );
      expect(history?.finalVerdict).toBe('approved');
      expect(history?.rounds).toHaveLength(2);
      // 修订后 coding 产物的文件被更新
      const phase = harness.getArtifact<CodingPhaseResult>('coding');
      expect(phase?.results[0].files.find((f) => f.path === 'src/Login.tsx')?.content).toContain(
        'LoginForm',
      );
    });

    it('CR request_human → 暂停 → resume 续跑 → 通过 → DELIVERY_CONFIRMATION', async () => {
      const { provider, calls } = createMockLLM([
        CLARIFICATION_JSON,
        FOLLOWUP_JSON,
        STORY_JSON,
        DESIGN_JSON,
        REVIEW_JSON,
        CODING_RED,
        CODING_GREEN,
        CR_HUMAN, // 第1轮：请求人工
        CR_APPROVE, // 续跑第2轮：通过
      ]);
      const harness = new Harness({ agents: createFullAgents(provider) });

      await harness.start(SAMPLE_PRD);
      await harness.resume('确认澄清');
      const paused = await harness.resume('API 已确认');
      expect(paused.finalState).toBe('CODE_REVIEWING');
      expect(paused.waitingForHuman).toBe(true);
      expect(calls).toHaveLength(8);

      const resumed = await harness.resume('人工裁决后继续');
      expect(resumed.finalState).toBe('DELIVERY_CONFIRMATION');
      expect(resumed.waitingForHuman).toBe(true);
      expect(calls).toHaveLength(9);
    });

    it('CR 达最大轮次（maxReviewRounds=1）→ 暂停 → resume 接受 → DELIVERY_CONFIRMATION', async () => {
      const { provider } = createMockLLM([
        CLARIFICATION_JSON,
        FOLLOWUP_JSON,
        STORY_JSON,
        DESIGN_JSON,
        REVIEW_JSON,
        CODING_RED,
        CODING_GREEN,
        CR_CHANGES, // 第1轮要求修改（blocker）
        REVISE_OUTPUT, // Coder 修订
      ]);
      const harness = new Harness({
        agents: createFullAgents(provider),
        maxReviewRounds: 1,
      });

      await harness.start(SAMPLE_PRD);
      await harness.resume('确认澄清');
      const paused = await harness.resume('API 已确认');
      expect(paused.finalState).toBe('CODE_REVIEWING');
      expect(paused.waitingForHuman).toBe(true);
      expect(paused.message).toContain('最大');

      const accepted = await harness.resume('接受当前版本');
      expect(accepted.finalState).toBe('DELIVERY_CONFIRMATION');
      expect(accepted.waitingForHuman).toBe(true);
    });
  });

  // ============================================================
  // 12. 交付确认 → COMPLETED 终态（段 4 闭环）
  // ============================================================
  describe('12. 交付确认 → COMPLETED（段 4 闭环）', () => {
    const RED = JSON.stringify({
      testFiles: [
        {
          path: 'src/Login.test.ts',
          type: 'test',
          operation: 'create',
          summary: '登录测试',
          content:
            "describe('Login', () => { it('ac1 正常登录', () => {}); it('ac2 错误密码', () => {}) })",
          relatedAcIds: ['ac1', 'ac2'],
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
      acTestMapping: { ac1: ['ac1 正常登录'], ac2: ['ac2 错误密码'] },
    });

    const GREEN = JSON.stringify({
      implFiles: [
        {
          path: 'src/Login.tsx',
          type: 'component',
          operation: 'create',
          summary: '登录实现',
          content: 'export const Login = () => null',
          relatedAcIds: ['ac1', 'ac2'],
        },
      ],
      updatedTestFiles: [],
      needsDesignFallback: false,
      fallbackReason: '',
    });

    const CR_PASS = JSON.stringify({
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
    });

    it('交付确认硬卡点 resume 后推进到 COMPLETED，delivery 产物已保存', async () => {
      const { provider, calls } = createMockLLM([
        CLARIFICATION_JSON,
        FOLLOWUP_JSON,
        STORY_JSON,
        DESIGN_JSON,
        REVIEW_JSON,
        RED,
        GREEN,
        CR_PASS,
      ]);
      const harness = new Harness({ agents: createFullAgents(provider) });

      await harness.start(SAMPLE_PRD);
      const atApi = await harness.resume('确认澄清');
      expect(atApi.finalState).toBe('API_CONFIRMATION');

      const atDelivery = await harness.resume('API 已确认');
      expect(atDelivery.finalState).toBe('DELIVERY_CONFIRMATION');
      expect(atDelivery.waitingForHuman).toBe(true);

      // 段 4：交付确认 → COMPLETED
      const completed = await harness.resume('确认交付');
      expect(completed.success).toBe(true);
      expect(completed.finalState).toBe('COMPLETED');
      expect(completed.waitingForHuman).toBe(false);

      // delivery 产物已保存且成功
      const delivery = harness.getArtifact<DeliveryResult>('delivery');
      expect(delivery).toBeDefined();
      expect(delivery?.status).toBe('success');

      // LLM 调用：澄清/followup/故事/方案/评审 + red + green + CR = 8（delivery 为 mock 不调用 LLM）
      expect(calls).toHaveLength(8);
    });

    it('终态 COMPLETED 后再次 resume 不重复执行，返回终态', async () => {
      const { provider } = createMockLLM([
        CLARIFICATION_JSON,
        FOLLOWUP_JSON,
        STORY_JSON,
        DESIGN_JSON,
        REVIEW_JSON,
        RED,
        GREEN,
        CR_PASS,
      ]);
      const harness = new Harness({ agents: createFullAgents(provider) });

      await harness.start(SAMPLE_PRD);
      await harness.resume('确认澄清');
      await harness.resume('API 已确认');
      const completed = await harness.resume('确认交付');
      expect(completed.finalState).toBe('COMPLETED');

      // 终态非 waiting_human，resume 应被拒绝且不改变状态
      const again = await harness.resume('再次确认');
      expect(again.success).toBe(false);
      expect(again.finalState).toBe('COMPLETED');
      expect(again.message).toContain('不是等待人工介入');
    });
  });
});
