/**
 * LLM 调用熔断器。
 *
 * 目的：模型/网关已知不可用时，避免请求继续长时间等待（issue #62 的 15 分钟挂死）
 * 与重试雪崩，改为快速失败，让上层走兜底/人工。
 *
 * 状态机：
 * - CLOSED：正常放行；连续失败达到 failureThreshold → OPEN。
 * - OPEN：canExecute() 返回 false，调用快速失败；经过 resetTimeoutMs → HALF_OPEN。
 * - HALF_OPEN：放行一次试探；成功 → CLOSED（计数清零），失败 → 重新 OPEN 并重置冷却计时。
 */

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** 连续失败多少次后熔断（默认 5） */
  failureThreshold?: number;
  /** OPEN 后多久进入 HALF_OPEN（毫秒，默认 30000） */
  resetTimeoutMs?: number;
  /** 当前时间注入（测试用），默认 Date.now */
  now?: () => number;
}

/** 熔断打开时抛出：上层可据此不做重试、直接走兜底 */
export class CircuitBreakerOpenError extends Error {
  constructor(message = 'LLM 熔断器处于打开状态，已快速失败（请稍后重试）') {
    super(message);
    this.name = 'CircuitBreakerOpenError';
  }
}

export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private failureCount = 0;
  private openedAt = 0;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly now: () => number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 30000;
    this.now = options.now ?? Date.now;
  }

  /** 当前状态（读取时若 OPEN 已过冷却期，惰性迁移到 HALF_OPEN） */
  getState(): BreakerState {
    if (this.state === 'open' && this.now() - this.openedAt >= this.resetTimeoutMs) {
      this.state = 'half-open';
    }
    return this.state;
  }

  /** 是否放行调用（OPEN 返回 false） */
  canExecute(): boolean {
    return this.getState() !== 'open';
  }

  /** 记录成功：复位到 CLOSED */
  recordSuccess(): void {
    this.failureCount = 0;
    this.state = 'closed';
  }

  /** 记录失败：HALF_OPEN 失败立即重新 OPEN；CLOSED 累计达阈值后 OPEN */
  recordFailure(): void {
    this.failureCount += 1;
    if (this.state === 'half-open' || this.failureCount >= this.failureThreshold) {
      this.tripOpen();
    }
  }

  private tripOpen(): void {
    this.state = 'open';
    this.openedAt = this.now();
  }
}
