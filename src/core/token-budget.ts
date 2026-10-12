/**
 * Token 预算跟踪器（issue #39 落地）
 *
 * 单流程实例共享：Harness 创建实例后注入每个 AgentContext，
 * BaseAgent 在每次 LLM 调用前后：
 * 1. 调用前检查是否已超预算 → 超限则不再发起调用，直接失败（BUDGET_EXCEEDED）
 * 2. 调用成功后累计本次调用 token（response.totalTokens）
 *
 * maxTokensPerCall 由 base.ts 在响应返回后校验（单次调用不可预知输出长度，
 * 但可以校验结果是否超出单次上限，超限按失败处理并记录原因）。
 */
export class TokenBudgetTracker {
  /** 单流程 token 总量上限（0 表示不限制） */
  private readonly limit: number;
  /** 单次调用 token 上限（0 表示不限制） */
  private readonly perCallLimit: number;
  /** 已累计消耗的 token */
  private used = 0;

  constructor(limit: number, perCallLimit = 0) {
    this.limit = limit;
    this.perCallLimit = perCallLimit;
  }

  /** 本次调用前检查：是否已超总量预算（超限则不应再发起调用） */
  isExceeded(): boolean {
    return this.limit > 0 && this.used >= this.limit;
  }

  /** 剩余可用 token（0 表示不限制） */
  remaining(): number {
    if (this.limit <= 0) return 0;
    return Math.max(0, this.limit - this.used);
  }

  /** 累计一次调用的 token 消耗，返回是否因本次调用超出总量上限 */
  add(tokens: number): { exceeded: boolean; used: number; limit: number } {
    this.used += Math.max(0, tokens);
    return { exceeded: this.isExceeded(), used: this.used, limit: this.limit };
  }

  /** 校验单次调用结果是否超出单次上限 */
  checkPerCall(tokens: number): { ok: boolean; reason?: string } {
    if (this.perCallLimit <= 0) return { ok: true };
    if (tokens > this.perCallLimit) {
      return {
        ok: false,
        reason: `单次调用 ${tokens} tokens 超过上限 ${this.perCallLimit}`,
      };
    }
    return { ok: true };
  }

  /** 当前累计值 */
  get usedTokens(): number {
    return this.used;
  }

  /** 配置的总额上限（0=不限） */
  get limitTokens(): number {
    return this.limit;
  }
}
