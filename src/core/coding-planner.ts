/**
 * 编码任务规划（纯函数）
 *
 * 从技术方案 + 单个用户故事中抽取该故事编码所需的最小上下文，生成 CodingTask。
 * 不做 LLM 调用、不读外部状态，便于单测；instanceId / 项目上下文 / 测试要求由 Harness 传入。
 */

import type {
  FrontendDesignDoc,
  ComponentNode,
  ApiContract,
  DataModel,
} from '../types/frontend-design';
import type { UserStory } from '../types/user-story';
import type {
  CodingTask,
  CodingComponent,
  CodingStateManagement,
  ExceptionRequirement,
  CodingTechStack,
  ProjectContext,
  TestRequirements,
} from '../types/coding-task';

export interface BuildCodingTaskOptions {
  instanceId: string;
  storyIndex: number;
  totalStories: number;
  projectContext: ProjectContext;
  /** 不传时使用默认：每 AC 一测、单元 + mock 集成、msw */
  testRequirements?: TestRequirements;
}

const DEFAULT_TEST_REQUIREMENTS: TestRequirements = {
  framework: 'vitest',
  testPerAc: true,
  testTypes: ['unit', 'integration-mock'],
  mockStrategy: 'msw',
};

function toCodingComponent(node: ComponentNode): CodingComponent {
  return {
    componentId: node.id,
    name: node.name,
    type: node.type,
    filePath: node.filePath,
    description: node.description,
    props: node.props,
    emits: node.emits,
    children: node.children,
    reuseStatus: node.reuseStatus,
    existingRef: node.existingComponentRef,
    relatedAcIds: node.relatedAcIds,
    exceptionHandling: node.exceptionHandling,
  };
}

function toTechStack(design: FrontendDesignDoc): CodingTechStack {
  return {
    framework: design.techStack.framework.name,
    frameworkVersion: design.techStack.framework.version,
    language: design.techStack.language,
    stateLibrary: design.techStack.stateManagement.library,
    uiLibrary: design.techStack.uiLibrary?.name,
    testFramework: design.techStack.testing.framework,
    buildTool: design.techStack.buildTool,
  };
}

/** 为单个用户故事构建编码任务 */
export function buildCodingTask(
  design: FrontendDesignDoc,
  story: UserStory,
  options: BuildCodingTaskOptions,
): CodingTask {
  const storyId = story.id;
  const acIds = new Set(story.acceptanceCriteria.map((ac) => ac.id));

  // 组件：方案中归属本故事的组件
  const components: CodingComponent[] = (design.componentTree ?? [])
    .filter((c) => c.relatedStoryIds.includes(storyId))
    .map(toCodingComponent);
  const componentIdSet = new Set(components.map((c) => c.componentId));

  // API：归属本故事的契约
  const apiContracts: ApiContract[] = (design.apiContracts ?? []).filter((a) =>
    a.relatedStoryIds.includes(storyId),
  );
  const apiIdSet = new Set(apiContracts.map((a) => a.id));

  // 数据模型：与本故事 API 关联，或 source=shared 的共享模型
  const dataModels: DataModel[] = (design.dataModels ?? []).filter(
    (m) =>
      (m.relatedApiIds ?? []).some((id) => apiIdSet.has(id)) ||
      (m.source === 'shared' && (m.relatedApiIds === undefined || m.relatedApiIds.length === 0)),
  );

  // 状态管理：库来自技术栈，只带与本故事组件相关的全局 store
  const stateManagement: CodingStateManagement = {
    library: design.techStack.stateManagement.library,
    stores: (design.stateManagement?.globalStores ?? []).filter((s) =>
      s.relatedComponentIds.some((id) => componentIdSet.has(id)),
    ),
    serverState: design.stateManagement?.serverState
      ? {
          library: design.stateManagement.serverState.library,
          managedData: design.stateManagement.serverState.managedData,
        }
      : undefined,
  };

  // 异常要求：归属本故事或本故事某条 AC 的异常场景
  const exceptionRequirements: ExceptionRequirement[] = (design.exceptionScenarios ?? [])
    .filter(
      (e) =>
        e.relatedStoryIds?.includes(storyId) || (e.relatedAcIds ?? []).some((id) => acIds.has(id)),
    )
    .map((e) => ({
      type: e.type,
      trigger: e.trigger,
      behavior: e.behavior,
      implementation: e.implementation,
      relatedComponentIds: e.relatedComponentIds,
    }));

  return {
    taskId: `coding-task-${storyId}`,
    instanceId: options.instanceId,
    storyId,
    storyTitle: story.title,
    storyDescription: { ...story.description },
    acceptanceCriteria: story.acceptanceCriteria.map((ac) => ({ ...ac })),
    components,
    apiContracts,
    dataModels,
    stateManagement,
    exceptionRequirements,
    techStack: toTechStack(design),
    projectContext: options.projectContext,
    testRequirements: options.testRequirements ?? { ...DEFAULT_TEST_REQUIREMENTS },
    storyIndex: options.storyIndex,
    totalStories: options.totalStories,
    dependencies: [...story.dependencies],
  };
}
