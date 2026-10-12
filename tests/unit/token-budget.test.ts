import { describe, it, expect } from 'vitest';
import { TokenBudgetTracker } from '../../src/core/token-budget';

describe('TokenBudgetTracker（issue #39 预算控制）', () => {
  it('limit=0 表示不限制，永不超限', () => {
    const tracker = new TokenBudgetTracker(0);
    expect(tracker.isExceeded()).toBe(false);
    tracker.add(100000);
    expect(tracker.isExceeded()).toBe(false);
    expect(tracker.remaining()).toBe(0); // 0 = 不限制，不返回剩余
  });

  it('累计 token 并正确判定是否超限', () => {
    const tracker = new TokenBudgetTracker(1000);
    expect(tracker.isExceeded()).toBe(false);
    tracker.add(600);
    expect(tracker.isExceeded()).toBe(false);
    expect(tracker.remaining()).toBe(400);
    const r = tracker.add(500); // 600+500=1100 > 1000
    expect(r.exceeded).toBe(true);
    expect(r.used).toBe(1100);
    expect(tracker.isExceeded()).toBe(true);
    expect(tracker.remaining()).toBe(0);
  });

  it('恰好达到上限时也视为超限（>= 语义，不再发起下次调用）', () => {
    const tracker = new TokenBudgetTracker(1000);
    tracker.add(1000);
    expect(tracker.isExceeded()).toBe(true);
  });

  it('checkPerCall：未设置单次上限时始终通过', () => {
    const tracker = new TokenBudgetTracker(0, 0);
    expect(tracker.checkPerCall(50000)).toEqual({ ok: true });
  });

  it('checkPerCall：单次调用超过上限时给出原因', () => {
    const tracker = new TokenBudgetTracker(0, 10000);
    expect(tracker.checkPerCall(5000)).toEqual({ ok: true });
    const r = tracker.checkPerCall(15000);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('15000');
    expect(r.reason).toContain('10000');
  });

  it('add 忽略负数（防御异常输入）', () => {
    const tracker = new TokenBudgetTracker(100);
    tracker.add(-50);
    expect(tracker.usedTokens).toBe(0);
  });
});
