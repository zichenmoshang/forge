/**
 * 评审判定策略（ADR-014 统一规则）
 *
 * 解决三个判定口径冲突的问题：conclusion（LLM 总结）、severity（严重程度）、
 * blocking（阻塞标记）。规则：
 *
 * 1. severity 为 blocker / critical 时，blocking 必须为 true（程序化强制，不信任 LLM 标记）
 * 2. 是否通过只看"是否存在 blocking 且未解决的 issue"，conclusion 仅作自然语言总结
 * 3. LLM 输出 dialogAction=approve 但存在 blocking issue 时，以程序化判定为准（request_changes）
 * 4. 问题跟踪闭环：第 N 轮（N>=2）必须对上一轮每个问题给出 verification，不得遗漏
 */

import type { ReviewIssue, ReviewResult } from '../types/review-and-delivery';
import type { IssueResponse } from '../types/review-dialog';

/** severity 达到该集合中级别时强制 blocking */
const FORCE_BLOCKING_SEVERITIES = new Set(['blocker', 'critical']);

/** LLM 输出的对话动作 */
export type LlmDialogAction = 'approve' | 'request_changes' | 'request_human';

/** 程序化判定后的最终动作 */
export type ResolvedDialogAction = LlmDialogAction;

/**
 * 规范化问题列表：强制 blocker/critical 的 blocking=true。
 *
 * 在 ReviewAgent.validateOutput 中调用，保证落库和判定使用一致口径。
 * 返回新数组，不修改入参。
 */
export function normalizeIssues(issues: ReviewIssue[]): ReviewIssue[] {
  return issues.map((issue) => {
    if (FORCE_BLOCKING_SEVERITIES.has(issue.severity) && !issue.blocking) {
      return { ...issue, blocking: true };
    }
    return { ...issue };
  });
}

/** 是否存在阻塞性且未解决的问题 */
export function hasBlockingIssue(issues: ReviewIssue[]): boolean {
  return issues.some((issue) => issue.blocking && issue.status === 'open');
}

/** 统计各严重程度的问题数量 */
export function countBySeverity(issues: ReviewIssue[]): Record<string, number> {
  const counter: Record<string, number> = {};
  for (const issue of issues) {
    counter[issue.severity] = (counter[issue.severity] ?? 0) + 1;
  }
  return counter;
}

/**
 * 综合 LLM 动作与结构化问题列表，得出最终动作。
 *
 * - LLM 请求人工：request_human 直接生效（争议问题升级人工）
 * - LLM 想通过但仍有 blocking issue：降级为 request_changes
 * - LLM 要求修改但已无 blocking issue（只剩建议项）：升级为 approve
 * - 其余以 LLM 动作为准
 */
export function resolveDialogAction(
  llmAction: LlmDialogAction,
  issues: ReviewIssue[],
): ResolvedDialogAction {
  if (llmAction === 'request_human') return 'request_human';

  const blocking = hasBlockingIssue(issues);
  if (llmAction === 'approve' && blocking) return 'request_changes';
  if (llmAction === 'request_changes' && !blocking) return 'approve';
  return llmAction;
}

/**
 * 问题跟踪闭环校验（ADR-014）
 *
 * 第 round 轮（round>=2）评审时，必须对上一轮遗留的每个问题给出 verification。
 * 返回遗漏验证的问题 ID 列表；空数组表示闭环完整。
 *
 * @param previousIssues 上一轮的问题列表
 * @param currentIssues 本轮的问题列表（通过 issueId 关联）
 * @param round 当前轮次
 */
export function findUnverifiedIssues(
  previousIssues: ReviewIssue[],
  currentIssues: ReviewIssue[],
  round: number,
): string[] {
  if (round < 2) return [];

  const currentById = new Map(currentIssues.map((issue) => [issue.issueId, issue]));
  const missing: string[] = [];

  for (const prev of previousIssues) {
    if (prev.status === 'resolved' || prev.status === 'wont-fix') continue;
    const current = currentById.get(prev.issueId);
    if (!current || !current.verification || current.verification.round !== round) {
      missing.push(prev.issueId);
    }
  }
  return missing;
}

/**
 * 修改方侧问题闭环校验（ADR-014，与 findUnverifiedIssues 对称）
 *
 * 修改方 revise 时，必须对上一轮每个仍 open 的问题逐项给出 IssueResponse，
 * 且 action=wont-fix 时必须提供 explanation（不修复理由，交由下一轮 Reviewer 裁决）。
 * 返回有问题的项（遗漏 ID 或 wont-fix 缺理由）；空数组表示逐项回应完整。
 *
 * @param previousOpenIssues 上一轮遗留的 open 问题
 * @param responses 修改方本轮给出的逐项回应
 */
export function findUnansweredIssues(
  previousOpenIssues: ReviewIssue[],
  responses: IssueResponse[],
): Array<{ issueId: string; reason: string }> {
  const responseById = new Map(responses.map((r) => [r.issueId, r]));
  const problems: Array<{ issueId: string; reason: string }> = [];

  for (const prev of previousOpenIssues) {
    if (prev.status === 'resolved' || prev.status === 'wont-fix') continue;
    const response = responseById.get(prev.issueId);
    if (!response) {
      problems.push({ issueId: prev.issueId, reason: '缺少逐项回应 issueResponse' });
      continue;
    }
    if (
      response.action === 'wont-fix' &&
      (!response.explanation || response.explanation.trim() === '')
    ) {
      problems.push({ issueId: prev.issueId, reason: 'wont-fix 必须提供不修复理由 explanation' });
    }
  }
  return problems;
}

/**
 * 校验一次评审结果的内部一致性，返回错误信息列表（空数组表示通过）。
 * 供 ReviewAgent.validateOutput 复用。
 */
export function validateReviewConsistency(result: ReviewResult, round = 1): string[] {
  const errors: string[] = [];
  const issueIds = new Set<string>();

  for (const issue of result.issues) {
    if (issueIds.has(issue.issueId)) {
      errors.push(`问题 ID 重复: ${issue.issueId}`);
    }
    issueIds.add(issue.issueId);

    // 注：blocker/critical 未标 blocking 由 normalizeIssues 强制修正，属正常化而非一致性错误

    if (issue.status === 'resolved' && !issue.verification && round >= 2) {
      errors.push(`问题 ${issue.issueId} 标记 resolved 但缺少 verification`);
    }
  }

  return errors;
}
