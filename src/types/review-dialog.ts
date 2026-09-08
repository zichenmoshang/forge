// 评审多轮对话类型（阶段4 方案评审 / 阶段6 代码 CR）
// 对应设计：docs/08-review-dialog.md
// 外层状态机控流程，内层对话循环控质量。

import type { FrontendDesignDoc } from './frontend-design';
import type { ReviewResult, ReviewIssue } from './review-and-delivery';
import type { CodingResult } from './coding-task';

/** 对话消息发送方角色 */
export type DialogRole = 'reviewer' | 'designer' | 'coder' | 'system';

/** 对话中的一条消息（只增不改，构成完整对话历史） */
export interface DialogMessage {
  /** 发送方角色 */
  role: DialogRole;
  /** 自然语言内容（评审总结 / 修改说明） */
  content: string;
  /** 这一轮产生的结构化结果（评审结果或修改结果） */
  structuredOutput?: ReviewResult | DesignRevision | CodeRevision;
  /** 轮次（从 1 开始） */
  round: number;
  /** 时间戳（ISO 8601） */
  timestamp: string;
}

/** 修改方对单个评审问题的逐项回应 */
export interface IssueResponse {
  /** 关联的评审问题 ID */
  issueId: string;
  /**
   * 处理动作：
   * - fixed：已修复，交由下一轮 Reviewer 验证（verification.result=resolved 闭环）
   * - wont-fix：不修复，必须给 explanation，交由 Reviewer 裁决 accepted/rejected-wont-fix
   * - needs-discussion：需要讨论，下一轮重点关注
   */
  action: 'fixed' | 'wont-fix' | 'needs-discussion';
  /** 说明（wont-fix 时为必填理由） */
  explanation: string;
}

/** Designer 根据评审意见修改后的方案修订（v1 全量替换） */
export interface DesignRevision {
  /** 修改说明 */
  changeSummary: string;
  /** 修改的章节/组件/页面 ID */
  changedSections: string[];
  /** 针对每个上轮 open 问题的逐项回应（不得遗漏，由 review-policy 校验） */
  issueResponses: IssueResponse[];
  /** 修改后的完整方案（v1 全量；版本号、覆盖度、API 确认由系统重算） */
  updatedDesign: FrontendDesignDoc;
}

/** Coder 根据代码 CR 意见修改后的代码修订（v1 全量替换单故事 CodingResult） */
export interface CodeRevision {
  /** 修改说明 */
  changeSummary: string;
  /** 修改的文件路径 */
  changedFiles: string[];
  /** 针对每个上轮 open 问题的逐项回应（不得遗漏，由 review-policy 校验） */
  issueResponses: IssueResponse[];
  /** 修改后的完整单故事编码结果（文件、测试结果、TDD 循环由系统重算/合并） */
  updatedResult: CodingResult;
}

/** 一轮评审的完整记录 */
export interface ReviewRound {
  /** 轮次（从 1 开始） */
  round: number;
  /** 本轮 Reviewer 的评审结果 */
  review: ReviewResult;
  /** 本轮修改方的修订（approve 的轮次没有；方案评审为 DesignRevision，代码 CR 为 CodeRevision） */
  revision?: DesignRevision | CodeRevision;
  /** 本轮对话消息 */
  messages: DialogMessage[];
  /** 本轮结束时是否所有 blocking 问题都已解决 */
  allBlockingResolved: boolean;
  /** 本轮累计耗时（毫秒） */
  durationMs: number;
}

/** 多轮评审最终结论 */
export type ReviewDialogVerdict = 'approved' | 'needs_human' | 'max_rounds_reached';

/** 多轮评审的完整历史（作为独立产物保存，不覆盖被评审产物） */
export interface ReviewDialogHistory {
  /** 评审类型 */
  reviewType: 'design-review' | 'code-review';
  /** 最大轮次 */
  maxRounds: number;
  /** 已执行的轮次 */
  rounds: ReviewRound[];
  /** 最终结论（未结束时为 needs_human 占位） */
  finalVerdict: ReviewDialogVerdict;
  /** 最终通过的产物版本 */
  finalVersion: number;
  /** 总耗时（毫秒） */
  totalDurationMs: number;
  /** 暂停等待人工的原因（needs_human / max_rounds_reached 时存在） */
  suspendReason?: string;
}

/** 上一轮遗留的 open 问题集合的类型别名，便于 Harness 内部传递 */
export type OpenIssues = ReviewIssue[];
