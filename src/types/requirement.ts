// 结构化需求 Schema（阶段1输出）
// 对应状态：REQUIREMENT_CLARIFICATION 出口（冻结后）

/** 结构化需求文档 */
export interface StructuredRequirement {
  /** 需求唯一ID */
  id: string;
  /** 关联的流程实例ID */
  instanceId: string;
  /** 产物版本号 */
  version: number;
  /** 需求基本信息 */
  meta: RequirementMeta;
  /** 业务目标 */
  businessGoals: BusinessGoal[];
  /** 涉及角色 */
  roles: Role[];
  /** 功能点列表 */
  features: Feature[];
  /** 业务规则 */
  businessRules: BusinessRule[];
  /** 非功能需求 */
  nonFunctionalRequirements: NonFunctionalRequirement[];
  /** 全局需求（登录、权限等） */
  globalRequirements: GlobalRequirement[];
  /** 埋点需求（随PRD提供） */
  trackingRequirements: TrackingRequirement[];
  /** 澄清记录 */
  clarificationLog: ClarificationEntry[];
  /** 人工统一回答（多问题澄清时，人工一次性回答所有问题，不逐个匹配） */
  humanAnswers?: Array<{
    answer: string;
    answeredAt: string;
  }>;
  /** 冻结确认 */
  frozen: FrozenConfirmation;
  /** 创建时间（ISO 8601） */
  createdAt: string;
  /** 更新时间（ISO 8601） */
  updatedAt: string;
}

/** 需求基本信息 */
export interface RequirementMeta {
  title: string;
  /** PRD来源（文件名/链接） */
  source: string;
  version: string;
  /** 解析时间（ISO 8601） */
  parsedAt: string;
  /** 冻结时间（ISO 8601） */
  frozenAt: string;
  /** 关联的全局需求文档（如有） */
  relatedGlobalDocs?: string[];
}

/** 业务目标 */
export interface BusinessGoal {
  id: string;
  description: string;
  /** 成功衡量标准（可选） */
  successMetrics?: string[];
  priority: 'P0' | 'P1' | 'P2';
}

/** 角色 */
export interface Role {
  id: string;
  name: string;
  description: string;
  /** 该角色在本需求中的核心诉求 */
  coreNeeds: string[];
}

/** 功能点 */
export interface Feature {
  id: string;
  name: string;
  description: string;
  /** 所属业务模块 */
  module: string;
  /** 关联角色ID */
  relatedRoleIds: string[];
  /** 关联业务目标ID */
  relatedGoalIds: string[];
  priority: 'P0' | 'P1' | 'P2';
  /** 是否有异常流程说明 */
  hasExceptionFlow: boolean;
  /** 备注/疑问 */
  notes?: string;
}

/** 业务规则 */
export interface BusinessRule {
  id: string;
  description: string;
  /** 规则类型 */
  type: 'validation' | 'calculation' | 'permission' | 'workflow' | 'display' | 'other';
  /** 关联功能点ID */
  relatedFeatureIds: string[];
  /** 规则的具体条件 */
  conditions?: string[];
  /** 规则的具体动作 */
  actions?: string[];
  /** PRD中的原文位置（便于追溯） */
  sourceRef?: string;
}

/** 非功能需求 */
export interface NonFunctionalRequirement {
  id: string;
  category:
    | 'performance'
    | 'compatibility'
    | 'security'
    | 'accessibility'
    | 'i18n'
    | 'reliability'
    | 'other';
  description: string;
  /** 可量化的指标 */
  metrics?: NFMetric[];
  /** 关联功能点ID（如为空则全局适用） */
  relatedFeatureIds?: string[];
}

export interface NFMetric {
  name: string;
  value: string;
  unit?: string;
  /** 测量方式 */
  measure?: string;
}

/** 全局需求 */
export interface GlobalRequirement {
  id: string;
  category:
    'authentication' | 'authorization' | 'navigation' | 'layout' | 'error-handling' | 'other';
  description: string;
  /** 是否在本需求中需要实现 */
  inScope: boolean;
  /** 来源（已有全局需求文档 / 本需求补充） */
  source: 'existing' | 'new';
  /** 如果是新增的，记录是澄清时提出的 */
  discoveredInClarification?: boolean;
}

/** 埋点需求 */
export interface TrackingRequirement {
  id: string;
  eventName: string;
  description: string;
  /** 触发时机 */
  trigger: string;
  /** 上报参数 */
  parameters: TrackingParam[];
  /** 关联功能点ID */
  relatedFeatureIds: string[];
}

export interface TrackingParam {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object';
  description: string;
  required: boolean;
}

/** 澄清记录 */
export interface ClarificationEntry {
  id: string;
  question: string;
  /** 问题分类 */
  category: 'missing' | 'ambiguous' | 'contradictory' | 'detail' | 'global-requirement';
  /** 优先级 */
  priority: 'blocking' | 'important' | 'minor';
  /** 人工回答 */
  answer?: string;
  answeredAt?: string;
  /** 回答后对需求的影响（修改了哪些部分） */
  impact?: string[];
  /** 状态 */
  status: 'pending' | 'answered' | 'resolved';
}

/** 冻结前质量门 checklist（各项按需求产物实际内容计算，不允许硬编码） */
export interface FreezeChecklist {
  businessGoalsClear: boolean;
  rolesComplete: boolean;
  featuresNoMissing: boolean;
  rulesNoAmbiguity: boolean;
  nfrDefined: boolean;
  globalRequirementsCovered: boolean;
  trackingProvided: boolean;
  allClarificationsResolved: boolean;
}

/** 冻结确认 */
export interface FrozenConfirmation {
  frozen: boolean;
  frozenAt: string;
  /** 冻结时确认的事项清单 */
  checklist: FreezeChecklist;
  /** 仍存在但不阻塞的已知问题 */
  knownIssues?: string[];
}
