/**
 * Token 预算跟踪器（issue #39 落地；并发预留见 reserve/settle）
 *
 * 单流程实例共享：Harness 创建实例后注入每个 AgentContext，
 * BaseAgent 在每次 LLM 调用前后：
 * 1. 调用前检查是否已超预算 → 超限则不再发起调用，直接失败（BUDGET_EXCEEDED）
 * 2. 并发场景（故事分批，最多 3 路同时在途）先 reserve 本次"最大可能输出"，
 *    调用返回后 settle（释放预留、按实际消耗入账），避免多个并发调用各自通过
 *    isExceeded() 检查后同时突破总预算；
 * 3. 调用成功后累计本次调用 token（response.totalTokens）。
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
  /** 已被在途调用预留、尚未结算的 token（并发预算原子化） */
  private reserved = 0;

  constructor(limit: number, perCallLimit = 0) {
    this.limit = limit;
    this.perCallLimit = perCallLimit;
  }

  /** 本次调用前检查：是否已超总量预算（超限则不应再发起调用） */
  isExceeded(): boolean {
    return this.limit > 0 && this.used >= this.limit;
  }

  /** 剩余可用 token（不扣除在途预留；0 配置时返回 0） */
  remaining(): number {
    if (this.limit <= 0) return 0;
    return Math.max(0, this.limit - this.used);
  }

  /** 扣除在途预留后，仍可被新调用预留的 token（0 配置时返回 0） */
  available(): number {
    if (this.limit <= 0) return 0;
    return Math.max(0, this.limit - this.used - this.reserved);
  }

  /**
   * 调用前预留本次最大可能输出（同步执行、无 await，保证并发下原子）。
   *
   * @param estimate 本次调用的最大可能输出 token（一般取请求 maxTokens）
   * @returns ok=true 时 reserved 为实际预留额度，需在调用后 settle/release；
   *          ok=false 表示剩余额度不足以容纳最坏情况输出，调用方应按 BUDGET_EXCEEDED 处理；
   *          未配置总预算（limit<=0）时不管理，恒返回 { ok:true, reserved:0 }。
   */
  reserve(estimate: number): { ok: boolean; reserved: number; reason?: string } {
    if (this.limit <= 0) return { ok: true, reserved: 0 };
    const want = Math.max(0, estimate);
    if (this.used + this.reserved + want > this.limit) {
      return {
        ok: false,
        reserved: 0,
        reason: `剩余可预留额度 ${this.limit - this.used - this.reserved} 不足以容纳本次最大输出 ${want}`,
      };
    }
    this.reserved += want;
    return { ok: true, reserved: want };
  }

  /**
   * 调用返回后结算：先释放该次预留，再按实际消耗入账。
   * 返回 add 的超限判定结果。
   */
  settle(
    reservedAmount: number,
    actualTokens: number,
  ): { exceeded: boolean; used: number; limit: number } {
    this.release(reservedAmount);
    return this.add(actualTokens);
  }

  /** 释放一次预留（调用失败/取消时，仅回滚预留、不入账） */
  release(reservedAmount: number): void {
    this.reserved = Math.max(0, this.reserved - Math.max(0, reservedAmount));
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

  /** 当前在途预留值 */
  get reservedTokens(): number {
    return this.reserved;
  }

  /** 配置的总额上限（0=不限） */
  get limitTokens(): number {
    return this.limit;
  }
}
