import { describe, it, expect } from 'vitest';
import { buildCodingTask } from '../../src/core/coding-planner';
import type { FrontendDesignDoc } from '../../src/types/frontend-design';
import type { UserStory } from '../../src/types/user-story';
import type { ProjectContext } from '../../src/types/coding-task';

const projectContext: ProjectContext = {
  projectRoot: '/work',
  srcDir: 'src',
  projectType: 'new',
};

function makeDesign(): FrontendDesignDoc {
  return {
    id: 'design-1',
    techStack: {
      source: 'suggested',
      framework: { name: 'React', version: '18' },
      language: 'TypeScript',
      stateManagement: { library: 'zustand' },
      uiLibrary: { name: 'antd' },
      testing: { framework: 'vitest' },
      buildTool: 'vite',
    },
    componentTree: [
      {
        id: 'c1',
        name: 'LoginForm',
        type: 'feature',
        filePath: 'src/features/LoginForm.tsx',
        description: '登录表单',
        props: [],
        children: [],
        relatedStoryIds: ['s1'],
        relatedAcIds: ['ac1'],
        reuseStatus: 'new',
      },
      {
        id: 'c-other',
        name: 'Other',
        type: 'feature',
        filePath: 'src/Other.tsx',
        description: '别的故事',
        props: [],
        children: [],
        relatedStoryIds: ['s2'],
        relatedAcIds: ['ac9'],
        reuseStatus: 'new',
      },
    ],
    stateManagement: {
      principle: '全局最小化',
      globalStores: [
        {
          name: 'authStore',
          description: '鉴权',
          state: [],
          actions: [],
          relatedComponentIds: ['c1'],
        },
        {
          name: 'orderStore',
          description: '无关',
          state: [],
          actions: [],
          relatedComponentIds: ['c-other'],
        },
      ],
      serverState: { library: '@tanstack/react-query', managedData: ['profile'] },
    },
    dataModels: [
      {
        name: 'LoginReq',
        description: '',
        typeDefinition: 'x',
        fields: [],
        source: 'api-request',
        relatedApiIds: ['api-login'],
      },
      {
        name: 'SharedEnum',
        description: '',
        typeDefinition: 'y',
        fields: [],
        source: 'shared',
      },
      {
        name: 'OrderDto',
        description: '',
        typeDefinition: 'z',
        fields: [],
        source: 'api-response',
        relatedApiIds: ['api-order'],
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
      {
        id: 'api-order',
        name: '订单',
        method: 'GET',
        path: '/orders',
        description: '',
        request: {},
        response: { success: { httpStatus: 200, fields: [] } },
        relatedStoryIds: ['s2'],
        relatedComponentIds: ['c-other'],
        source: 'new',
      },
    ],
    exceptionScenarios: [
      {
        id: 'e1',
        type: 'error',
        relatedComponentIds: ['c1'],
        relatedStoryIds: ['s1'],
        trigger: '密码错误',
        behavior: '提示',
        implementation: 'inline 错误文案',
        needsDesign: false,
        status: 'covered',
      },
      {
        id: 'e2',
        type: 'empty-state',
        relatedComponentIds: ['c-other'],
        relatedAcIds: ['ac9'],
        trigger: '无订单',
        behavior: '空态',
        implementation: 'Empty 组件',
        needsDesign: false,
        status: 'covered',
      },
    ],
  } as unknown as FrontendDesignDoc;
}

function makeStory(): UserStory {
  return {
    id: 's1',
    title: '用户登录',
    description: { role: '用户', action: '登录', benefit: '进入系统' },
    acceptanceCriteria: [
      {
        id: 'ac1',
        given: [],
        when: '提交正确账号密码',
        then: ['登录成功'],
        scenarioType: 'normal',
        testable: true,
      },
    ],
    priority: 'P0',
    dependencies: ['s0'],
    relatedFeatureIds: [],
    relatedRuleIds: [],
    type: 'feature',
    hasExceptionFlow: true,
  };
}

describe('coding-planner', () => {
  it('只抽取本故事相关的组件/API/异常，过滤其他故事', () => {
    const task = buildCodingTask(makeDesign(), makeStory(), {
      instanceId: 'inst-1',
      storyIndex: 1,
      totalStories: 3,
      projectContext,
    });
    expect(task.components.map((c) => c.componentId)).toEqual(['c1']);
    expect(task.apiContracts.map((a) => a.id)).toEqual(['api-login']);
    expect(task.exceptionRequirements.map((e) => e.type)).toEqual(['error']);
    // store 只保留与本故事组件相关的
    expect(task.stateManagement.stores?.map((s) => s.name)).toEqual(['authStore']);
  });

  it('数据模型：关联本故事 API + 无 API 绑定的 shared 模型入选，其他故事的排除', () => {
    const task = buildCodingTask(makeDesign(), makeStory(), {
      instanceId: 'i',
      storyIndex: 0,
      totalStories: 1,
      projectContext,
    });
    expect(task.dataModels.map((m) => m.name).sort()).toEqual(['LoginReq', 'SharedEnum']);
  });

  it('技术栈/测试要求/任务元信息正确映射，默认测试要求可被覆盖', () => {
    const task = buildCodingTask(makeDesign(), makeStory(), {
      instanceId: 'inst-1',
      storyIndex: 1,
      totalStories: 3,
      projectContext,
    });
    expect(task.techStack).toMatchObject({
      framework: 'React',
      frameworkVersion: '18',
      stateLibrary: 'zustand',
      uiLibrary: 'antd',
      testFramework: 'vitest',
    });
    expect(task.testRequirements.testPerAc).toBe(true);
    expect(task.taskId).toBe('coding-task-s1');
    expect(task.storyIndex).toBe(1);
    expect(task.dependencies).toEqual(['s0']);
    expect(task.stateManagement.serverState?.library).toBe('@tanstack/react-query');

    const custom = buildCodingTask(makeDesign(), makeStory(), {
      instanceId: 'i',
      storyIndex: 0,
      totalStories: 1,
      projectContext,
      testRequirements: {
        framework: 'vitest',
        testPerAc: true,
        testTypes: ['unit'],
        mockStrategy: 'manual-mock',
      },
    });
    expect(custom.testRequirements.mockStrategy).toBe('manual-mock');
  });
});
