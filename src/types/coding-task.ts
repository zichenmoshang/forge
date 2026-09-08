// 编码任务 Schema（阶段5输入/输出）
// 对应状态：CODING
// 输入：由 Harness 从 FrontendDesignDoc 提取单个故事相关部分生成

import type { AcceptanceCriterion } from './user-story';
import type {
  ApiContract,
  DataModel,
  GlobalStore,
  ComponentProp,
  ComponentEvent,
} from './frontend-design';

/** 单个用户故事的编码任务 */
export interface CodingTask {
  /** 任务ID */
  taskId: string;
  /** 关联的流程实例ID */
  instanceId: string;
  /** 关联的故事ID */
  storyId: string;
  /** 故事标题 */
  storyTitle: string;
  /** 故事描述 */
  storyDescription: {
    role: string;
    action: string;
    benefit: string;
  };
  /** 验收标准（引用上游类型） */
  acceptanceCriteria: AcceptanceCriterion[];
  /** 需要创建/修改的组件 */
  components: CodingComponent[];
  /** 需要的API契约（引用上游类型） */
  apiContracts: ApiContract[];
  /** 需要的数据模型（引用上游类型） */
  dataModels: DataModel[];
  /** 状态管理相关 */
  stateManagement: CodingStateManagement;
  /** 异常场景处理要求 */
  exceptionRequirements: ExceptionRequirement[];
  /** 技术栈约束 */
  techStack: CodingTechStack;
  /** 项目上下文 */
  projectContext: ProjectContext;
  /** 测试要求 */
  testRequirements: TestRequirements;
  /** 任务索引（第几个故事） */
  storyIndex: number;
  /** 总故事数 */
  totalStories: number;
  /** 前置依赖（需要先完成的故事ID） */
  dependencies: string[];
}

/** 编码任务中的组件（基于 ComponentNode 精简，保留编码必需字段） */
export interface CodingComponent {
  /** 组件ID（对应技术方案中的 ComponentNode.id） */
  componentId: string;
  name: string;
  type: 'page' | 'layout' | 'container' | 'feature' | 'ui' | 'hook' | 'util';
  filePath: string;
  description: string;
  /** 引用上游 ComponentProp 类型 */
  props: ComponentProp[];
  /** 引用上游 ComponentEvent 类型 */
  emits?: ComponentEvent[];
  /** 子组件 */
  children: string[];
  /** 复用状态 */
  reuseStatus: 'new' | 'reuse' | 'modify';
  /** 现有组件引用（复用/改造时） */
  existingRef?: string;
  /** 关联的AC ID */
  relatedAcIds: string[];
  /** 异常处理要求 */
  exceptionHandling?: string[];
  /** Figma引用 */
  figmaFrameId?: string;
}

/** 编码任务中的状态管理（基于 StateManagementDesign 精简） */
export interface CodingStateManagement {
  library: string;
  /** 需要的全局store（引用上游 GlobalStore 类型） */
  stores?: GlobalStore[];
  /** 服务端状态管理 */
  serverState?: {
    library: string;
    managedData: string[];
  };
}

/** 异常处理要求 */
export interface ExceptionRequirement {
  type: string;
  trigger: string;
  behavior: string;
  implementation: string;
  relatedComponentIds: string[];
}

/** 技术栈约束 */
export interface CodingTechStack {
  framework: string;
  frameworkVersion: string;
  language: 'TypeScript' | 'JavaScript';
  stateLibrary: string;
  uiLibrary?: string;
  testFramework: string;
  buildTool: string;
  /** 代码规范 */
  codeStyle?: {
    lintConfig?: string;
    namingConventions?: string;
  };
}

/** 项目上下文 */
export interface ProjectContext {
  /** 项目根目录 */
  projectRoot: string;
  /** 源码目录 */
  srcDir: string;
  /** 已有组件索引（可复用的） */
  existingComponents?: Array<{
    name: string;
    path: string;
    props: string;
    usage: string;
  }>;
  /** 路径别名 */
  pathAliases?: Record<string, string>;
  /** 项目类型 */
  projectType: 'new' | 'existing';
}

/** 测试要求 */
export interface TestRequirements {
  /** 测试框架 */
  framework: string;
  /** 每个AC必须对应至少一个测试 */
  testPerAc: boolean;
  /** 测试类型 */
  testTypes: Array<'unit' | 'component' | 'integration-mock'>;
  /** Mock方式 */
  mockStrategy: 'msw' | 'manual-mock' | 'sinon' | 'other';
  /** 覆盖率要求（可选） */
  coverage?: {
    statements?: number;
    branches?: number;
    functions?: number;
    lines?: number;
  };
}

// 编码结果 Schema（阶段5输出）

/** 单个故事的编码结果 */
export interface CodingResult {
  /** 结果ID */
  id: string;
  /** 关联的流程实例ID */
  instanceId: string;
  taskId: string;
  storyId: string;
  status: 'success' | 'partial' | 'failed';
  /** 生成的文件 */
  files: GeneratedFile[];
  /** 测试结果 */
  testResult: TestResult;
  /** TDD循环记录 */
  tddCycles: TddCycle[];
  /** 失败的AC（如有） */
  failedAcIds?: string[];
  /** 问题记录 */
  issues?: string[];
  /** 是否需要回退到方案设计 */
  needsDesignFallback?: boolean;
  fallbackReason?: string;
  /** 完成时间（ISO 8601） */
  completedAt: string;
}

/** 编码阶段汇总（所有故事的 CodingResult 聚合） */
export interface CodingPhaseResult {
  /** 汇总ID */
  id: string;
  /** 关联的流程实例ID */
  instanceId: string;
  /** 关联的技术方案ID */
  designDocId: string;
  /** 总故事数 */
  totalStories: number;
  /** 成功的故事ID */
  successStoryIds: string[];
  /** 部分成功的故事ID */
  partialStoryIds: string[];
  /** 失败的故事ID及原因 */
  failedStories: Array<{
    storyId: string;
    reason: string;
  }>;
  /** 各故事的编码结果 */
  results: CodingResult[];
  /** 总体测试统计 */
  overallTestStats: {
    totalTests: number;
    passedTests: number;
    failedTests: number;
    passRate: number;
  };
  /** 所有生成的文件（去重） */
  allFiles: GeneratedFile[];
  /** 总体状态 */
  overallStatus: 'all-success' | 'partial-success' | 'all-failed';
  /** 产物版本号（每次 CR revise 后 +1，单调递增；初始编码完成时为 1） */
  version: number;
  /** 完成时间（ISO 8601） */
  completedAt: string;
}

/** 生成的文件 */
export interface GeneratedFile {
  path: string;
  type: 'component' | 'test' | 'store' | 'type' | 'api' | 'util' | 'config' | 'mock';
  /** 操作类型 */
  operation: 'create' | 'modify' | 'reuse';
  /** 内容摘要 */
  summary: string;
  /**
   * 文件完整文本。v1 内存工作区模式下由 CodingAgent 填充（尚未真实落盘，交付/落盘由后续工作区负责）；
   * 真实落盘到目标项目后，产物中可只保留 summary 而省略 content。
   */
  content?: string;
  /** 关联的组件ID */
  componentId?: string;
  /** 关联的AC ID */
  relatedAcIds?: string[];
}

/** 测试结果 */
export interface TestResult {
  totalTests: number;
  passedTests: number;
  failedTests: number;
  skippedTests: number;
  /** 测试运行环境 */
  environment: 'sandbox' | 'real-project';
  /** 测试输出摘要 */
  outputSummary: string;
  /** 失败的测试详情 */
  failures?: Array<{
    testName: string;
    errorMessage: string;
    relatedAcId?: string;
  }>;
  /** 覆盖率（如有） */
  coverage?: Record<string, number>;
  /** 是否全部通过 */
  allPassed: boolean;
}

/** TDD循环记录 */
export interface TddCycle {
  cycle: number;
  phase: 'red' | 'green' | 'refactor';
  action: string;
  testResult?: 'pass' | 'fail';
  durationMs: number;
}
