/**
 * 状态机 - 状态流转逻辑
 *
 * 职责：
 * - 定义合法的状态转换表
 * - 验证状态转换是否合法
 * - 执行状态转换，更新 PipelineState
 * - 管理重试计数、版本号、挂起/恢复
 */

import type {
  PipelineState,
  PipelineStateName,
  StateAction,
  StateTransitionResult,
} from '../types/state';

/** 合法的前进转换（from -> 允许的 to 列表） */
const ADVANCE_TRANSITIONS: Record<PipelineStateName, PipelineStateName[]> = {
  INIT: ['REQUIREMENT_PARSING'],
  REQUIREMENT_PARSING: ['REQUIREMENT_CLARIFICATION'],
  REQUIREMENT_CLARIFICATION: ['STORIES_GENERATING'],
  STORIES_GENERATING: ['DESIGN_GENERATING'],
  // ADR-014：先评审、后确认 API，人工确认的是评审后的稳定契约
  DESIGN_GENERATING: ['DESIGN_REVIEWING'],
  DESIGN_REVIEWING: ['API_CONFIRMATION'],
  API_CONFIRMATION: ['CODING'],
  CODING: ['CODE_REVIEWING'],
  CODE_REVIEWING: ['DELIVERING'],
  DELIVERING: ['DELIVERY_CONFIRMATION'],
  DELIVERY_CONFIRMATION: ['COMPLETED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  SUSPENDED: [],
};

/** 合法的回退转换（from -> 允许的 to 列表） */
const FALLBACK_TRANSITIONS: Record<PipelineStateName, PipelineStateName[]> = {
  INIT: [],
  REQUIREMENT_PARSING: ['INIT'],
  REQUIREMENT_CLARIFICATION: ['REQUIREMENT_PARSING'],
  STORIES_GENERATING: ['REQUIREMENT_CLARIFICATION'],
  DESIGN_GENERATING: ['STORIES_GENERATING'],
  DESIGN_REVIEWING: ['DESIGN_GENERATING'],
  // API 确认时发现问题属于方案缺陷，回退到设计；评审与确认随后重新执行
  API_CONFIRMATION: ['DESIGN_GENERATING'],
  CODING: ['DESIGN_GENERATING'],
  // 代码 CR 发现代码问题在对话内 revise，不回退 CODING；仅方案性问题回退 DESIGN_GENERATING
  CODE_REVIEWING: ['DESIGN_GENERATING'],
  DELIVERING: ['CODE_REVIEWING'],
  DELIVERY_CONFIRMATION: ['DELIVERING'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  SUSPENDED: [],
};

/** 硬卡点状态（必须人工确认才能前进） */
export const HARD_BLOCKING_STATES: PipelineStateName[] = [
  'REQUIREMENT_CLARIFICATION',
  'API_CONFIRMATION',
  'DELIVERY_CONFIRMATION',
];

/** 终态 */
export const TERMINAL_STATES: PipelineStateName[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

/**
 * 检查是否为硬卡点状态
 */
export function isHardBlockingState(state: PipelineStateName): boolean {
  return HARD_BLOCKING_STATES.includes(state);
}

/**
 * 检查是否为终态
 */
export function isTerminalState(state: PipelineStateName): boolean {
  return TERMINAL_STATES.includes(state);
}

/**
 * 检查前进转换是否合法
 */
export function canAdvance(from: PipelineStateName, to: PipelineStateName): boolean {
  return ADVANCE_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * 检查回退转换是否合法
 */
export function canFallback(from: PipelineStateName, to: PipelineStateName): boolean {
  return FALLBACK_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * 创建初始状态
 */
export function createInitialState(instanceId: string): PipelineState {
  const now = new Date().toISOString();
  return {
    instanceId,
    currentState: 'INIT',
    status: 'running',
    currentVersion: 1,
    retryCount: {},
    createdAt: now,
    updatedAt: now,
    artifactIds: {},
  };
}

/**
 * 状态机类 - 管理单个流程实例的状态流转
 */
export class StateMachine {
  private state: PipelineState;
  /** 状态变更回调（issue #82：每次变更后持久化快照） */
  private readonly onStateChange?: (state: PipelineState) => void;

  constructor(initialState: PipelineState, options?: { onStateChange?: (state: PipelineState) => void }) {
    this.state = { ...initialState };
    this.onStateChange = options?.onStateChange;
  }

  /** 状态变更后通知外部（快照持久化等），传入深拷贝避免外部修改内部状态 */
  private notifyChange(): void {
    this.onStateChange?.(structuredClone(this.state));
  }

  /** 获取当前状态（深拷贝，防止外部修改内部状态） */
  getState(): PipelineState {
    return structuredClone(this.state);
  }

  /**
   * 执行状态转换动作
   */
  transition(action: StateAction): StateTransitionResult {
    const from = this.state.currentState;

    // 终态不允许任何转换
    if (isTerminalState(from)) {
      return {
        success: false,
        from,
        to: from,
        action,
        message: `终态 ${from} 不允许转换`,
      };
    }

    switch (action.type) {
      case 'ADVANCE':
        return this.handleAdvance(action.to);
      case 'FALLBACK':
        return this.handleFallback(action.to, action.reason);
      case 'SUSPEND':
        return this.handleSuspend(action.reason, action.waitingFor);
      case 'RESUME':
        return this.handleResume(action.fromState);
      case 'FAIL':
        return this.handleFail(action.reason);
      case 'CANCEL':
        return this.handleCancel(action.reason);
      case 'COMPLETE':
        return this.handleComplete();
      default:
        return {
          success: false,
          from,
          to: from,
          action,
          message: `未知的动作类型: ${(action as StateAction).type}`,
        };
    }
  }

  /** 前进 */
  private handleAdvance(to: PipelineStateName): StateTransitionResult {
    const from = this.state.currentState;

    if (!canAdvance(from, to)) {
      return {
        success: false,
        from,
        to,
        action: { type: 'ADVANCE', to },
        message: `不允许从 ${from} 前进到 ${to}`,
      };
    }

    this.state.currentState = to;
    this.state.updatedAt = new Date().toISOString();

    // 进入硬卡点状态时，状态变为 waiting_human
    if (isHardBlockingState(to)) {
      this.state.status = 'waiting_human';
    } else if (to === 'COMPLETED') {
      this.state.status = 'completed';
    } else {
      this.state.status = 'running';
    }

    this.notifyChange();

    return {
      success: true,
      from,
      to,
      action: { type: 'ADVANCE', to },
    };
  }

  /** 回退 */
  private handleFallback(to: PipelineStateName, reason: string): StateTransitionResult {
    const from = this.state.currentState;

    if (!canFallback(from, to)) {
      return {
        success: false,
        from,
        to,
        action: { type: 'FALLBACK', to, reason },
        message: `不允许从 ${from} 回退到 ${to}`,
      };
    }

    this.state.currentState = to;
    this.state.currentVersion += 1;
    this.state.status = 'running';
    this.state.updatedAt = new Date().toISOString();

    // 回退后清除目标状态之后的重试计数
    // （简化实现：清除所有重试计数，实际可按状态范围清除）
    this.state.retryCount = {};

    this.notifyChange();

    return {
      success: true,
      from,
      to,
      action: { type: 'FALLBACK', to, reason },
      message: reason,
    };
  }

  /** 挂起 */
  private handleSuspend(reason: string, waitingFor?: string): StateTransitionResult {
    const from = this.state.currentState;

    this.state.suspendedFromState = from;
    this.state.suspendedReason = reason;
    this.state.waitingFor = waitingFor;
    this.state.currentState = 'SUSPENDED';
    this.state.status = 'suspended';
    this.state.updatedAt = new Date().toISOString();

    this.notifyChange();

    return {
      success: true,
      from,
      to: 'SUSPENDED',
      action: { type: 'SUSPEND', reason, waitingFor },
      message: reason,
    };
  }

  /** 恢复 */
  private handleResume(fromState: PipelineStateName): StateTransitionResult {
    const from = this.state.currentState;

    if (from !== 'SUSPENDED') {
      return {
        success: false,
        from,
        to: fromState,
        action: { type: 'RESUME', fromState },
        message: `只能从 SUSPENDED 状态恢复，当前状态: ${from}`,
      };
    }

    this.state.currentState = fromState;
    this.state.suspendedFromState = undefined;
    this.state.suspendedReason = undefined;
    this.state.waitingFor = undefined;
    this.state.status = isHardBlockingState(fromState) ? 'waiting_human' : 'running';
    this.state.updatedAt = new Date().toISOString();

    this.notifyChange();

    return {
      success: true,
      from,
      to: fromState,
      action: { type: 'RESUME', fromState },
    };
  }

  /** 失败 */
  private handleFail(reason: string): StateTransitionResult {
    const from = this.state.currentState;

    this.state.currentState = 'FAILED';
    this.state.status = 'failed';
    this.state.updatedAt = new Date().toISOString();

    this.notifyChange();

    return {
      success: true,
      from,
      to: 'FAILED',
      action: { type: 'FAIL', reason },
      message: reason,
    };
  }

  /** 取消（人工主动终止流程，终态不可恢复） */
  private handleCancel(reason: string): StateTransitionResult {
    const from = this.state.currentState;

    this.state.currentState = 'CANCELLED';
    this.state.status = 'cancelled';
    this.state.updatedAt = new Date().toISOString();

    this.notifyChange();

    return {
      success: true,
      from,
      to: 'CANCELLED',
      action: { type: 'CANCEL', reason },
      message: reason,
    };
  }

  /** 完成 */
  private handleComplete(): StateTransitionResult {
    const from = this.state.currentState;

    if (from !== 'DELIVERY_CONFIRMATION') {
      return {
        success: false,
        from,
        to: 'COMPLETED',
        action: { type: 'COMPLETE' },
        message: `只能从 DELIVERY_CONFIRMATION 完成，当前状态: ${from}`,
      };
    }

    this.state.currentState = 'COMPLETED';
    this.state.status = 'completed';
    this.state.updatedAt = new Date().toISOString();

    this.notifyChange();

    return {
      success: true,
      from,
      to: 'COMPLETED',
      action: { type: 'COMPLETE' },
    };
  }

  /**
   * 原地置为等待人工（不发生状态迁移）。
   *
   * 用于评审多轮对话循环在非硬卡点状态（DESIGN_REVIEWING / CODE_REVIEWING）
   * 内部因 request_human / 达到最大轮次而暂停：currentState 保持不变，
   * 仅把 status 置为 waiting_human 并记录等待说明，resume 后从当前状态续跑。
   */
  pauseForHuman(waitingFor?: string): void {
    this.state.status = 'waiting_human';
    this.state.waitingFor = waitingFor;
    this.state.updatedAt = new Date().toISOString();
    this.notifyChange();
  }

  /** 从原地等待恢复为运行中（pauseForHuman 的逆操作） */
  markRunning(): void {
    this.state.status = 'running';
    this.state.waitingFor = undefined;
    this.state.updatedAt = new Date().toISOString();
    this.notifyChange();
  }

  /** 增加重试计数 */
  incrementRetry(state?: PipelineStateName): number {
    const target = state ?? this.state.currentState;
    const current = this.state.retryCount[target] ?? 0;
    this.state.retryCount[target] = current + 1;
    this.state.updatedAt = new Date().toISOString();
    this.notifyChange();
    return this.state.retryCount[target];
  }

  /** 获取重试次数 */
  getRetryCount(state?: PipelineStateName): number {
    const target = state ?? this.state.currentState;
    return this.state.retryCount[target] ?? 0;
  }
}
