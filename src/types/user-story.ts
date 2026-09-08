// 用户故事 Schema（阶段2输出）
// 对应状态：STORIES_GENERATING 完成后
// 输入：StructuredRequirement

/** 用户故事集合 */
export interface UserStorySet {
  /** 故事集合唯一ID */
  id: string;
  /** 关联的流程实例ID */
  instanceId: string;
  /** 关联的需求ID */
  requirementId: string;
  /** 产物版本号 */
  version: number;
  /** 故事列表 */
  stories: UserStory[];
  /** 故事地图（按业务流程分组） */
  storyMap: StoryMapGroup[];
  /** 非功能需求映射 */
  nfrMapping: NFRMapping[];
  /** 质量自检结果 */
  qualityCheck: StoryQualityCheck;
  /** 确认信息 */
  confirmation: StoryConfirmation;
  /** 创建时间（ISO 8601） */
  createdAt: string;
  /** 更新时间（ISO 8601） */
  updatedAt: string;
}

/** 单个用户故事 */
export interface UserStory {
  /** 故事唯一ID */
  id: string;
  /** 故事标题 */
  title: string;
  /** 故事描述：As a [role], I want [action], so that [benefit] */
  description: {
    role: string;
    action: string;
    benefit: string;
  };
  /** 验收标准（Given/When/Then） */
  acceptanceCriteria: AcceptanceCriterion[];
  /** 优先级 */
  priority: 'P0' | 'P1' | 'P2';
  /** 估算（故事点或小时，可选） */
  estimate?: {
    value: number;
    unit: 'story-point' | 'hour';
  };
  /** 依赖的其他故事ID */
  dependencies: string[];
  /** 关联的功能点ID */
  relatedFeatureIds: string[];
  /** 关联的业务规则ID */
  relatedRuleIds: string[];
  /** 关联的埋点需求ID */
  relatedTrackingIds?: string[];
  /** 故事类型 */
  type: 'feature' | 'bugfix' | 'enhancement' | 'technical' | 'non-functional';
  /** 是否包含异常流程 */
  hasExceptionFlow: boolean;
  /** 备注 */
  notes?: string;
}

/** 验收标准 */
export interface AcceptanceCriterion {
  id: string;
  /** Given - 前置条件 */
  given: string[];
  /** When - 操作 */
  when: string;
  /** Then - 预期结果 */
  then: string[];
  /** 场景类型 */
  scenarioType: 'normal' | 'exception' | 'boundary' | 'permission';
  /** 是否可测试 */
  testable: boolean;
  /** 不可测试的原因（如testable为false） */
  notTestableReason?: string;
  /** 对应的测试用例ID（编码阶段填充） */
  testCaseIds?: string[];
}

/** 故事地图分组 */
export interface StoryMapGroup {
  /** 业务流程/模块名 */
  groupName: string;
  /** 分组描述 */
  description?: string;
  /** 该组下的故事ID（按用户旅程排序） */
  storyIds: string[];
  /** 分组顺序 */
  order: number;
}

/** 非功能需求映射 */
export interface NFRMapping {
  /** 非功能需求ID */
  nfrId: string;
  /** 关联的故事ID（如为空则全局适用） */
  storyIds?: string[];
  /** 实现方式说明 */
  implementationNote: string;
  /** 是否在方案设计阶段需要专门处理 */
  requiresDesignAttention: boolean;
}

/** 故事质量自检结果 */
export interface StoryQualityCheck {
  /** INVEST 检查 */
  invest: {
    independent: boolean;
    negotiable: boolean;
    valuable: boolean;
    estimable: boolean;
    small: boolean;
    testable: boolean;
  };
  /** 每条故事的检查详情 */
  perStory: Array<{
    storyId: string;
    issues: string[];
    passed: boolean;
  }>;
  /** AC 可测试性统计 */
  acceptanceCriteriaStats: {
    total: number;
    testable: number;
    notTestable: number;
  };
  /** 覆盖率：功能点是否都被故事覆盖 */
  featureCoverage: {
    totalFeatures: number;
    coveredFeatures: number;
    uncoveredFeatureIds: string[];
  };
  /** 总体是否通过 */
  passed: boolean;
  /** 未通过的问题列表 */
  issues: string[];
}

/** 故事确认信息 */
export interface StoryConfirmation {
  /** 确认方式 */
  confirmedBy: 'ai-self-check' | 'human';
  confirmedAt: string;
  /** 人工确认时的备注 */
  humanNotes?: string;
  /** 确认时的版本 */
  version: number;
}
