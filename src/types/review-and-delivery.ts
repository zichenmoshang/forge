// 评审意见 Schema（阶段4方案评审 + 阶段6代码CR）
// 对应状态：DESIGN_REVIEWING / CODE_REVIEWING

/** 通用评审结果 */
export interface ReviewResult {
  /** 评审ID */
  reviewId: string;
  /** 关联的流程实例ID */
  instanceId: string;
  /** 评审类型 */
  reviewType: 'design-review' | 'code-review';
  /** 被评审的产物ID */
  targetArtifactId: string;
  /** 被评审的产物版本 */
  targetVersion: number;
  /**
   * 评审结论（自然语言总结，不参与程序化通过判定）
   *
   * ADR-014：是否通过只看"是否存在 blocking issue"（见 core/review-policy.ts），
   * 不以此字段为准。LLM 输出 conclusion=pass 但存在 blocking issue 时，程序化判定为不通过。
   */
  conclusion: 'pass' | 'reject' | 'pass-with-comments';
  /**
   * 程序化仲裁后的最终动作（ADR-014，由 review-policy.resolveDialogAction 计算，始终存在）。
   *
   * 消费方（Harness / #42 runReviewDialog）只应依赖此字段判断是否通过，
   * 不要依赖 conclusion（LLM 自然语言总结）或可选 checklist.overallPassed。
   * - approve：无 blocking open issue，可进入下一阶段
   * - request_changes：存在 blocking open issue，需修改后重审
   * - request_human：LLM 主动升级人工裁决
   */
  resolvedAction: 'approve' | 'request_changes' | 'request_human';
  /** 问题列表 */
  issues: ReviewIssue[];
  /** 评审checklist结果（根据reviewType对应不同类型） */
  checklist?: DesignReviewChecklist | CodeReviewChecklist;
  /** 评审摘要 */
  summary: string;
  /** 评审耗时（毫秒） */
  durationMs: number;
  /** 评审Agent信息 */
  reviewer: string;
  /** 评审时间（ISO 8601） */
  reviewedAt: string;
}

/** 单个评审问题 */
export interface ReviewIssue {
  /** 问题ID */
  issueId: string;
  /** 严重程度 */
  severity: 'blocker' | 'critical' | 'major' | 'minor' | 'suggestion';
  /** 问题分类 */
  category: ReviewCategory;
  /** 问题描述 */
  description: string;
  /** 具体位置 */
  location?: {
    /** 组件ID / 文件名 / 方案章节 */
    target: string;
    /** 行号或更精确的位置 */
    detail?: string;
  };
  /** 修改建议 */
  suggestion: string;
  /** 关联的故事/AC ID */
  relatedStoryIds?: string[];
  relatedAcIds?: string[];
  /**
   * 问题生命周期状态
   * - open：本轮新提出/上轮未解决
   * - resolved：修改方已修复，且经下一轮 Reviewer 验证
   * - wont-fix：修改方说明不修复理由，且经 Reviewer 认可
   */
  status: 'open' | 'resolved' | 'wont-fix';
  /**
   * 是否阻塞（必须修复才能通过）
   *
   * 判定规则（ADR-014，由 review-policy 程序化保证）：
   * severity 为 blocker / critical 时 blocking 必须为 true，LLM 输出与此冲突时以规则为准；
   * major 及以下级别默认不阻塞，Reviewer 可显式标记 blocking=true。
   */
  blocking: boolean;
  /**
   * 第 2 轮起：Reviewer 对上一轮问题的逐项验证结果（问题跟踪闭环，ADR-014）
   * 第 1 轮提出问题时为空；后续每轮必须对上一轮每个 open 问题给出验证，不得遗漏
   */
  verification?: IssueVerification;
}

/** 评审问题的逐项验证结果（问题跟踪闭环） */
export interface IssueVerification {
  /** 在哪一轮验证 */
  round: number;
  /** 验证结论 */
  result: 'resolved' | 'not-resolved' | 'accepted-wont-fix' | 'rejected-wont-fix';
  /** 验证说明 */
  note?: string;
}

/** 评审问题分类 */
export type ReviewCategory =
  // 方案评审分类
  | 'coverage'
  | 'exception'
  | 'api-consistency'
  | 'architecture'
  | 'state-management'
  | 'nfr'
  | 'design-fidelity'
  // 代码CR分类
  | 'code-style'
  | 'logic'
  | 'exception-handling'
  | 'security'
  | 'maintainability'
  | 'duplication'
  | 'test-quality'
  | 'consistency'
  | 'performance'
  | 'other';

// 方案评审专用 Schema（阶段4）

/** 方案评审checklist */
export interface DesignReviewChecklist {
  /** 覆盖度：所有故事AC是否被方案覆盖 */
  coverage: {
    passed: boolean;
    storyCoverage: { total: number; covered: number; uncovered: string[] };
    acCoverage: { total: number; covered: number; uncovered: string[] };
  };
  /** 异常完整性 */
  exceptionCompleteness: {
    passed: boolean;
    checklist: Array<{ item: string; covered: boolean; note?: string }>;
    missingScenarios: string[];
  };
  /** 接口一致性 */
  apiConsistency: {
    passed: boolean;
    issues: string[];
  };
  /** 架构合理性 */
  architecture: {
    passed: boolean;
    issues: string[];
  };
  /** 状态管理 */
  stateManagement: {
    passed: boolean;
    issues: string[];
  };
  /** 非功能需求覆盖 */
  nfrCoverage: {
    passed: boolean;
    missingNfrIds: string[];
  };
  /** 组件复用 */
  componentReuse: {
    passed: boolean;
    missedReuseOpportunities?: string[];
  };
  /** 总体 */
  overallPassed: boolean;
}

// 代码CR专用 Schema（阶段6）

/** 代码CR checklist */
export interface CodeReviewChecklist {
  /** 与技术方案一致性 */
  designConsistency: {
    passed: boolean;
    mismatches: string[];
  };
  /** 代码规范 */
  codeStyle: {
    passed: boolean;
    lintErrors?: number;
    issues: string[];
  };
  /** 逻辑正确性 */
  logic: {
    passed: boolean;
    issues: string[];
  };
  /** 异常处理 */
  exceptionHandling: {
    passed: boolean;
    missingHandling: string[];
  };
  /** 安全检查 */
  security: {
    passed: boolean;
    vulnerabilities: string[];
  };
  /** 可维护性 */
  maintainability: {
    passed: boolean;
    issues: string[];
    complexityScore?: number;
  };
  /** 重复代码 */
  duplication: {
    passed: boolean;
    duplicatedBlocks?: string[];
  };
  /** 测试有效性 */
  testQuality: {
    passed: boolean;
    /** 假测试：有断言但断言无意义 */
    fakeTests?: string[];
    /** 未覆盖的AC */
    uncoveredAcs?: string[];
    /** 测试覆盖率 */
    coverage?: Record<string, number>;
  };
  /** 设计还原度（图片比对） */
  designFidelity: {
    passed: boolean;
    /** 比对相似度分数（0-100） */
    similarityScore?: number;
    mismatches?: string[];
  };
  /** 总体 */
  overallPassed: boolean;
}

// 交付物 Schema（阶段7输出）

/** PR交付结果 */
export interface DeliveryResult {
  /** 交付ID */
  deliveryId: string;
  /** 关联的流程实例ID */
  instanceId: string;
  /** 交付状态 */
  status: 'success' | 'partial' | 'failed';
  /** 交付场景 */
  scenario: 'new-project' | 'new-module' | 'code-modification';
  /** Git信息 */
  git: {
    branchName: string;
    baseBranch: string;
    commitCount: number;
    commits: Array<{
      hash: string;
      message: string;
      author: string;
      createdAt: string;
    }>;
  };
  /** PR信息 */
  pullRequest: {
    title: string;
    description: string;
    url?: string;
    number?: string | number;
    /** PR状态 */
    status: 'created' | 'draft' | 'failed';
  };
  /** 变更文件统计 */
  changes: {
    filesAdded: number;
    filesModified: number;
    filesDeleted: number;
    linesAdded: number;
    linesDeleted: number;
    /** 变更文件列表 */
    files: Array<{
      path: string;
      operation: 'add' | 'modify' | 'delete';
      summary: string;
    }>;
  };
  /** 构建验证结果 */
  buildVerification: {
    passed: boolean;
    buildOutput?: string;
    testOutput?: string;
    /** 测试通过率 */
    testPassRate?: number;
  };
  /** 完成的故事 */
  completedStories: string[];
  /** 未完成的故事（部分交付时） */
  incompleteStories?: Array<{
    storyId: string;
    reason: string;
  }>;
  /** 已知问题/风险 */
  knownIssues?: string[];
  /** 后续建议 */
  followUpSuggestions?: string[];
  /** 交付时间（ISO 8601） */
  deliveredAt: string;
}

/** PR描述模板数据 */
export interface PRDescriptionData {
  /** 关联需求 */
  requirementTitle: string;
  requirementSource: string;
  /** 完成的用户故事 */
  stories: Array<{
    id: string;
    title: string;
    priority: string;
  }>;
  /** 变更摘要 */
  changeSummary: string;
  /** 技术方案要点 */
  designHighlights: string[];
  /** 测试情况 */
  testSummary: {
    totalTests: number;
    passedTests: number;
    coverage?: Record<string, number>;
  };
  /** CR记录 */
  crSummary: {
    totalIssues: number;
    resolvedIssues: number;
    blockerIssues: number;
  };
  /** 异常场景处理 */
  exceptionHandling: string[];
  /** 自测清单 */
  selfChecklist: Array<{ item: string; passed: boolean }>;
  /** 风险与注意事项 */
  risks?: string[];
  /** 回滚方案 */
  rollbackPlan?: string;
}
