// 前端技术方案 Schema（阶段3输出）
// 对应状态：API_CONFIRMATION 通过后
// 输入：UserStorySet + Figma数据 + 知识库检索结果 + 代码索引检索结果

/** 前端技术方案文档 */
export interface FrontendDesignDoc {
  /** 方案唯一ID */
  id: string;
  /** 关联的流程实例ID */
  instanceId: string;
  /** 关联的需求ID */
  requirementId: string;
  /** 关联的故事集合ID */
  storySetId: string;
  /** 方案版本 */
  version: number;
  /** 技术栈 */
  techStack: TechStack;
  /** Figma 设计引用 */
  figmaReference: FigmaReference;
  /** 页面与路由设计 */
  pages: PageDesign[];
  /** 组件树 */
  componentTree: ComponentNode[];
  /** 状态管理设计 */
  stateManagement: StateManagementDesign;
  /** 数据模型 */
  dataModels: DataModel[];
  /** API 契约列表 */
  apiContracts: ApiContract[];
  /** 异常与边界场景清单 */
  exceptionScenarios: ExceptionScenario[];
  /** 非功能需求落地方案 */
  nfrSolutions: NFRSolution[];
  /** 可复用组件检查结果 */
  reusableComponents: ReusableComponent[];
  /** 目录结构 */
  directoryStructure: DirectoryNode;
  /** 覆盖度检查 */
  coverageCheck: DesignCoverageCheck;
  /** API 确认信息 */
  apiConfirmation: ApiConfirmation;
  /** 创建时间（ISO 8601） */
  createdAt: string;
  /** 更新时间（ISO 8601） */
  updatedAt: string;
}

// ---------- 技术栈 ----------

export interface TechStack {
  /** 来源：自动检测（已有项目）/ AI建议（新项目） */
  source: 'detected' | 'suggested';
  framework: {
    name: string;
    version: string;
  };
  language: 'TypeScript' | 'JavaScript';
  stateManagement: {
    library: string;
    version?: string;
  };
  uiLibrary?: {
    name: string;
    version?: string;
  };
  testing: {
    framework: string;
    version?: string;
  };
  buildTool: string;
  /** 其他关键依赖 */
  additionalDependencies?: Array<{ name: string; version: string; purpose: string }>;
  /** 项目配置文件路径（已有项目） */
  configFiles?: string[];
}

// ---------- Figma 引用 ----------

export interface FigmaReference {
  /** Figma 是否可用（解析成功） */
  available: boolean;
  /** Figma 文件URL */
  fileUrl?: string;
  /** 不可用原因 */
  unavailableReason?: string;
  /** 提取的设计token（available=true时有值） */
  designTokens?: {
    colors: DesignToken[];
    typography: DesignToken[];
    spacing: DesignToken[];
    radius: DesignToken[];
    shadows: DesignToken[];
  };
  /** 页面/帧的引用 */
  frames: Array<{
    name: string;
    figmaId: string;
    /** 对应的页面ID */
    mappedPageId?: string;
    /** 截图路径（用于还原度比对） */
    screenshotPath?: string;
  }>;
  /** 设计组件映射（Figma组件 → 代码组件） */
  componentMappings: Array<{
    figmaComponentName: string;
    codeComponentName?: string;
    status: 'mapped' | 'needs-new' | 'reuse-existing';
  }>;
}

export interface DesignToken {
  name: string;
  value: string;
  /** 对应的代码变量名 */
  codeVariable?: string;
}

// ---------- 页面与路由 ----------

export interface PageDesign {
  id: string;
  name: string;
  /** 路由路径 */
  route: string;
  /** 路由参数 */
  routeParams?: RouteParam[];
  /** 页面描述 */
  description: string;
  /** 关联的故事ID */
  relatedStoryIds: string[];
  /** 页面包含的顶级组件ID */
  componentIds: string[];
  /** 页面级状态 */
  pageState?: string[];
  /** 权限要求 */
  permission?: {
    required: boolean;
    roles?: string[];
  };
  /** 响应式要求 */
  responsive?: {
    required: boolean;
    breakpoints?: string[];
  };
  /** 关联的Figma帧 */
  figmaFrameId?: string;
}

export interface RouteParam {
  name: string;
  type: 'path' | 'query';
  dataType: string;
  required: boolean;
  description: string;
}

// ---------- 组件树 ----------

export interface ComponentNode {
  id: string;
  name: string;
  /** 组件类型 */
  type: 'page' | 'layout' | 'container' | 'feature' | 'ui' | 'hook' | 'util';
  /** 文件路径（相对于src） */
  filePath: string;
  /** 组件描述 */
  description: string;
  /** Props 定义 */
  props: ComponentProp[];
  /** 事件/回调 */
  emits?: ComponentEvent[];
  /** 子组件ID */
  children: string[];
  /** 关联的故事ID */
  relatedStoryIds: string[];
  /** 关联的AC ID */
  relatedAcIds: string[];
  /** 内部状态 */
  internalState?: string[];
  /** 使用的hooks */
  hooks?: string[];
  /** 复用状态：新建 / 复用现有 / 改造现有 */
  reuseStatus: 'new' | 'reuse' | 'modify';
  /** 如果是复用/改造，现有组件的位置 */
  existingComponentRef?: string;
  /** 异常状态处理 */
  exceptionHandling?: string[];
}

export interface ComponentProp {
  name: string;
  type: string;
  required: boolean;
  defaultValue?: string;
  description: string;
}

export interface ComponentEvent {
  name: string;
  payloadType: string;
  description: string;
}

// ---------- 状态管理 ----------

export interface StateManagementDesign {
  /** 全局状态 vs 局部状态的划分原则 */
  principle: string;
  /** 全局状态（store） */
  globalStores: GlobalStore[];
  /** 服务端状态管理（如React Query） */
  serverState?: {
    library: string;
    /** 哪些数据走服务端状态 */
    managedData: string[];
  };
  /** 跨页面共享状态 */
  crossPageState?: string[];
}

export interface GlobalStore {
  name: string;
  description: string;
  /** state 字段 */
  state: Array<{
    name: string;
    type: string;
    description: string;
  }>;
  /** actions */
  actions: Array<{
    name: string;
    description: string;
    parameters?: string;
  }>;
  /** 关联的组件ID */
  relatedComponentIds: string[];
}

// ---------- 数据模型 ----------

export interface DataModel {
  name: string;
  description: string;
  /** TypeScript 类型定义 */
  typeDefinition: string;
  /** 字段列表 */
  fields: Array<{
    name: string;
    type: string;
    required: boolean;
    description: string;
  }>;
  /** 来源：API响应 / API请求 / 本地状态 / 表单 / 共享 */
  source: 'api-response' | 'api-request' | 'local-state' | 'form' | 'shared';
  /** 关联的API ID */
  relatedApiIds?: string[];
}

// ---------- API 契约 ----------

export interface ApiContract {
  id: string;
  name: string;
  /** HTTP 方法 */
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  /** 接口路径 */
  path: string;
  /** 接口描述 */
  description: string;
  /** 请求参数 */
  request: {
    pathParams?: ApiField[];
    queryParams?: ApiField[];
    body?: ApiField[];
    /** 请求体类型定义 */
    bodyType?: string;
  };
  /** 响应 */
  response: {
    /** 成功响应结构 */
    success: ApiResponseStructure;
    /** 错误响应结构 */
    error?: ApiErrorStructure[];
    /** 响应类型定义 */
    responseType?: string;
  };
  /** 关联的故事ID */
  relatedStoryIds: string[];
  /** 关联的组件ID */
  relatedComponentIds: string[];
  /** 来源：历史知识库复用 / 新增 / 修改 */
  source: 'reused' | 'new' | 'modified';
  /** 如果是复用，知识库中的引用 */
  knowledgeRef?: string;
  /** Mock 数据（编码阶段生成，方案阶段可为空） */
  mockData?: ApiMockData;
}

export interface ApiField {
  name: string;
  type: string;
  required: boolean;
  description: string;
  example?: string;
}

export interface ApiResponseStructure {
  httpStatus: number;
  fields: ApiField[];
  /** 分页信息（如适用） */
  pagination?: {
    pageParam: string;
    pageSizeParam: string;
    totalField: string;
    listField: string;
  };
}

export interface ApiErrorStructure {
  code: string;
  message: string;
  httpStatus: number;
  /** 前端处理方式 */
  handling: 'toast' | 'page-error' | 'inline' | 'retry' | 'ignore';
}

export interface ApiMockData {
  /** 正常响应的mock数据 */
  success: Record<string, unknown>;
  /** 异常响应的mock数据 */
  errors?: Array<{
    code: string;
    data: Record<string, unknown>;
  }>;
  /** 分页mock（如适用） */
  pagination?: {
    total: number;
    page: number;
    pageSize: number;
  };
}

// ---------- 异常与边界场景 ----------

export interface ExceptionScenario {
  id: string;
  /** 场景类型 */
  type:
    | 'empty-state'
    | 'loading'
    | 'error'
    | 'network'
    | 'validation'
    | 'permission'
    | 'boundary'
    | 'concurrency'
    | 'timeout'
    | 'other';
  /** 关联的页面/组件ID */
  relatedComponentIds: string[];
  /** 关联的故事/AC ID */
  relatedStoryIds?: string[];
  relatedAcIds?: string[];
  /** 触发条件 */
  trigger: string;
  /** 前端表现 */
  behavior: string;
  /** 实现方式 */
  implementation: string;
  /** 是否需要设计稿支持 */
  needsDesign: boolean;
  /** 状态：已覆盖 / 待设计稿 */
  status: 'covered' | 'needs-design';
}

// ---------- 非功能需求方案 ----------

export interface NFRSolution {
  /** 关联的非功能需求ID */
  nfrId: string;
  category: string;
  /** 落地方案 */
  solution: string;
  /** 具体措施 */
  measures: string[];
  /** 关联的组件/页面 */
  relatedComponentIds?: string[];
  /** 验证方式 */
  verification: string;
}

// ---------- 可复用组件 ----------

export interface ReusableComponent {
  /** 现有组件名称 */
  existingName: string;
  /** 现有组件位置 */
  location: string;
  /** 复用方式 */
  usage: 'direct' | 'with-props' | 'modify';
  /** 用于哪些新组件 */
  usedBy: string[];
  /** 复用说明 */
  note?: string;
}

// ---------- 目录结构 ----------

export interface DirectoryNode {
  name: string;
  type: 'directory' | 'file';
  /** 路径（相对于项目根） */
  path: string;
  description?: string;
  children?: DirectoryNode[];
}

// ---------- 覆盖度检查 ----------

export interface DesignCoverageCheck {
  /** 故事覆盖度 */
  storyCoverage: {
    totalStories: number;
    coveredStories: number;
    uncoveredStoryIds: string[];
  };
  /** AC覆盖度 */
  acCoverage: {
    totalACs: number;
    coveredACs: number;
    uncoveredAcIds: string[];
  };
  /** 异常场景覆盖度 */
  exceptionCoverage: {
    /** 检查清单 */
    checklist: Array<{ item: string; covered: boolean; note?: string }>;
    passed: boolean;
  };
  /** 总体是否通过 */
  passed: boolean;
  issues: string[];
}

// ---------- API 确认 ----------

export interface ApiConfirmation {
  /** 是否需要确认（有新增/修改的API时为true） */
  required: boolean;
  /** 待确认的API ID列表 */
  pendingApiIds: string[];
  /** 确认状态 */
  status: 'not-required' | 'pending' | 'confirmed' | 'modified';
  confirmedAt?: string;
  /** 人工确认时的修改记录 */
  modifications?: Array<{
    apiId: string;
    original: string;
    modified: string;
    reason: string;
  }>;
}
