import { describe, it, expect } from 'vitest';
import {
  normalizeIssues,
  hasBlockingIssue,
  resolveDialogAction,
  findUnverifiedIssues,
  findUnansweredIssues,
  validateReviewConsistency,
} from '../../src/core/review-policy';
import type { ReviewIssue, ReviewResult } from '../../src/types/review-and-delivery';

function createIssue(overrides: Partial<ReviewIssue> = {}): ReviewIssue {
  return {
    issueId: 'I1',
    severity: 'major',
    category: 'architecture',
    description: '问题描述',
    suggestion: '修改建议',
    status: 'open',
    blocking: false,
    ...overrides,
  };
}

function createReviewResult(issues: ReviewIssue[]): ReviewResult {
  return {
    reviewId: 'r1',
    instanceId: 'inst-1',
    reviewType: 'design-review',
    targetArtifactId: 'design-1',
    targetVersion: 1,
    conclusion: 'pass',
    resolvedAction: 'approve',
    issues,
    summary: '',
    durationMs: 100,
    reviewer: 'review-agent',
    reviewedAt: '2026-09-04T00:00:00.000Z',
  };
}

describe('review-policy（ADR-014 统一评审判定规则）', () => {
  describe('normalizeIssues', () => {
    it('blocker/critical 强制 blocking=true', () => {
      const issues = [
        createIssue({ issueId: 'A', severity: 'blocker', blocking: false }),
        createIssue({ issueId: 'B', severity: 'critical', blocking: false }),
        createIssue({ issueId: 'C', severity: 'major', blocking: false }),
      ];
      const normalized = normalizeIssues(issues);
      expect(normalized.find((i) => i.issueId === 'A')?.blocking).toBe(true);
      expect(normalized.find((i) => i.issueId === 'B')?.blocking).toBe(true);
      expect(normalized.find((i) => i.issueId === 'C')?.blocking).toBe(false);
    });

    it('不修改原数组', () => {
      const original = [createIssue({ severity: 'blocker', blocking: false })];
      normalizeIssues(original);
      expect(original[0].blocking).toBe(false);
    });
  });

  describe('hasBlockingIssue', () => {
    it('存在 open 的 blocking 问题时为 true', () => {
      expect(hasBlockingIssue([createIssue({ blocking: true, status: 'open' })])).toBe(true);
    });

    it('blocking 问题已 resolved 时为 false', () => {
      expect(hasBlockingIssue([createIssue({ blocking: true, status: 'resolved' })])).toBe(false);
    });

    it('只有非阻塞问题时为 false', () => {
      expect(hasBlockingIssue([createIssue({ blocking: false })])).toBe(false);
    });
  });

  describe('resolveDialogAction', () => {
    it('request_human 直接生效', () => {
      expect(resolveDialogAction('request_human', [createIssue({ blocking: true })])).toBe(
        'request_human',
      );
    });

    it('LLM 想 approve 但仍有 blocking 问题时降级为 request_changes', () => {
      expect(resolveDialogAction('approve', [createIssue({ blocking: true })])).toBe(
        'request_changes',
      );
    });

    it('LLM 要求修改但已无 blocking 问题时升级为 approve', () => {
      expect(resolveDialogAction('request_changes', [createIssue({ blocking: false })])).toBe(
        'approve',
      );
    });

    it('无冲突时以 LLM 动作为准', () => {
      expect(resolveDialogAction('approve', [])).toBe('approve');
      expect(resolveDialogAction('request_changes', [createIssue({ blocking: true })])).toBe(
        'request_changes',
      );
    });
  });

  describe('findUnverifiedIssues（问题跟踪闭环）', () => {
    it('第 1 轮不校验', () => {
      const prev = [createIssue({ issueId: 'A', status: 'open' })];
      expect(findUnverifiedIssues(prev, [], 1)).toEqual([]);
    });

    it('第 2 轮遗漏上轮 open 问题的验证时返回其 ID', () => {
      const prev = [
        createIssue({ issueId: 'A', status: 'open' }),
        createIssue({ issueId: 'B', status: 'open' }),
      ];
      const current = [
        createIssue({
          issueId: 'A',
          verification: { round: 2, result: 'resolved' },
        }),
      ];
      expect(findUnverifiedIssues(prev, current, 2)).toEqual(['B']);
    });

    it('全部验证则无遗漏', () => {
      const prev = [createIssue({ issueId: 'A', status: 'open' })];
      const current = [
        createIssue({ issueId: 'A', verification: { round: 2, result: 'resolved' } }),
      ];
      expect(findUnverifiedIssues(prev, current, 2)).toEqual([]);
    });

    it('验证轮次不匹配视为遗漏', () => {
      const prev = [createIssue({ issueId: 'A', status: 'open' })];
      const current = [
        createIssue({ issueId: 'A', verification: { round: 1, result: 'resolved' } }),
      ];
      expect(findUnverifiedIssues(prev, current, 2)).toEqual(['A']);
    });
  });

  describe('findUnansweredIssues（修改方逐项回应闭环）', () => {
    it('逐项回应完整时返回空', () => {
      const prev = [createIssue({ issueId: 'A' }), createIssue({ issueId: 'B' })];
      const res = findUnansweredIssues(prev, [
        { issueId: 'A', action: 'fixed', explanation: '已改' },
        { issueId: 'B', action: 'fixed', explanation: '已改' },
      ]);
      expect(res).toEqual([]);
    });

    it('遗漏某个 open 问题的回应时返回该 ID', () => {
      const prev = [createIssue({ issueId: 'A' }), createIssue({ issueId: 'B' })];
      const res = findUnansweredIssues(prev, [
        { issueId: 'A', action: 'fixed', explanation: '已改' },
      ]);
      expect(res).toHaveLength(1);
      expect(res[0].issueId).toBe('B');
      expect(res[0].reason).toContain('issueResponse');
    });

    it('wont-fix 但缺少理由时返回该 ID', () => {
      const prev = [createIssue({ issueId: 'A' })];
      const res = findUnansweredIssues(prev, [
        { issueId: 'A', action: 'wont-fix', explanation: '   ' },
      ]);
      expect(res).toHaveLength(1);
      expect(res[0].reason).toContain('wont-fix');
    });

    it('已 resolved/wont-fix 的问题不再要求回应', () => {
      const prev = [
        createIssue({ issueId: 'A', status: 'resolved' }),
        createIssue({ issueId: 'B', status: 'wont-fix' }),
      ];
      expect(findUnansweredIssues(prev, [])).toEqual([]);
    });
  });

  describe('validateReviewConsistency', () => {
    it('问题 ID 重复时报错', () => {
      const result = createReviewResult([
        createIssue({ issueId: 'DUP' }),
        createIssue({ issueId: 'DUP' }),
      ]);
      const errors = validateReviewConsistency(result, 2);
      expect(errors.some((e) => e.includes('重复'))).toBe(true);
    });

    it('第 2 轮 resolved 但缺 verification 时报错', () => {
      const result = createReviewResult([createIssue({ issueId: 'A', status: 'resolved' })]);
      const errors = validateReviewConsistency(result, 2);
      expect(errors.some((e) => e.includes('verification'))).toBe(true);
    });

    it('正常结果无错误', () => {
      const result = createReviewResult([createIssue({ issueId: 'A' })]);
      expect(validateReviewConsistency(result, 1)).toEqual([]);
    });
  });
});
