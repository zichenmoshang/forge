import { describe, it, expect, beforeEach } from 'vitest';
import {
  StateMachine,
  createInitialState,
  canAdvance,
  canFallback,
  isHardBlockingState,
  isTerminalState,
  HARD_BLOCKING_STATES,
} from '../../src/core/state-machine';
import type { PipelineStateName } from '../../src/types/state';

describe('StateMachine', () => {
  let sm: StateMachine;

  beforeEach(() => {
    const initial = createInitialState('test-instance-001');
    sm = new StateMachine(initial);
  });

  describe('初始状态', () => {
    it('应该从 INIT 状态开始', () => {
      expect(sm.getState().currentState).toBe('INIT');
    });

    it('初始版本号应为 1', () => {
      expect(sm.getState().currentVersion).toBe(1);
    });

    it('初始状态应为 running', () => {
      expect(sm.getState().status).toBe('running');
    });
  });

  describe('正常前进流程', () => {
    const fullPath: PipelineStateName[] = [
      'REQUIREMENT_PARSING',
      'REQUIREMENT_CLARIFICATION',
      'STORIES_GENERATING',
      'DESIGN_GENERATING',
      'DESIGN_REVIEWING',
      'API_CONFIRMATION',
      'CODING',
      'CODE_REVIEWING',
      'DELIVERING',
      'DELIVERY_CONFIRMATION',
      'COMPLETED',
    ];

    it('应该能完整走完所有状态', () => {
      for (const next of fullPath) {
        const result = sm.transition({ type: 'ADVANCE', to: next });
        expect(result.success).toBe(true);
        expect(sm.getState().currentState).toBe(next);
      }
      expect(sm.getState().status).toBe('completed');
    });

    it('进入硬卡点状态时 status 应为 waiting_human', () => {
      sm.transition({ type: 'ADVANCE', to: 'REQUIREMENT_PARSING' });
      sm.transition({ type: 'ADVANCE', to: 'REQUIREMENT_CLARIFICATION' });
      expect(sm.getState().status).toBe('waiting_human');
    });

    it('进入非硬卡点状态时 status 应为 running', () => {
      sm.transition({ type: 'ADVANCE', to: 'REQUIREMENT_PARSING' });
      expect(sm.getState().status).toBe('running');
    });
  });

  describe('非法前进转换', () => {
    it('不允许从 INIT 直接跳到 STORIES_GENERATING', () => {
      const result = sm.transition({ type: 'ADVANCE', to: 'STORIES_GENERATING' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('不允许');
    });

    it('不允许从 CODING 直接跳到 DELIVERING', () => {
      advanceTo(sm, 'CODING');
      const result = sm.transition({ type: 'ADVANCE', to: 'DELIVERING' });
      expect(result.success).toBe(false);
    });

    it('终态不允许前进', () => {
      advanceTo(sm, 'COMPLETED');
      const result = sm.transition({ type: 'ADVANCE', to: 'INIT' });
      expect(result.success).toBe(false);
    });
  });

  describe('回退转换', () => {
    it('应该能从 DESIGN_GENERATING 回退到 STORIES_GENERATING', () => {
      advanceTo(sm, 'DESIGN_GENERATING');
      const result = sm.transition({
        type: 'FALLBACK',
        to: 'STORIES_GENERATING',
        reason: 'AC 模糊',
      });
      expect(result.success).toBe(true);
      expect(sm.getState().currentState).toBe('STORIES_GENERATING');
    });

    it('回退后版本号应 +1', () => {
      advanceTo(sm, 'DESIGN_GENERATING');
      const before = sm.getState().currentVersion;
      sm.transition({ type: 'FALLBACK', to: 'STORIES_GENERATING', reason: 'test' });
      expect(sm.getState().currentVersion).toBe(before + 1);
    });

    it('不应该能从 CODE_REVIEWING 回退到 CODING（代码问题在对话内 revise，仅方案性问题回退 DESIGN_GENERATING）', () => {
      advanceTo(sm, 'CODE_REVIEWING');
      const result = sm.transition({
        type: 'FALLBACK',
        to: 'CODING',
        reason: '代码问题',
      });
      expect(result.success).toBe(false);
    });

    it('应该能从 CODE_REVIEWING 回退到 DESIGN_GENERATING', () => {
      advanceTo(sm, 'CODE_REVIEWING');
      const result = sm.transition({
        type: 'FALLBACK',
        to: 'DESIGN_GENERATING',
        reason: '方案问题',
      });
      expect(result.success).toBe(true);
    });

    it('回退后重试计数应被清除', () => {
      advanceTo(sm, 'CODING');
      sm.incrementRetry();
      expect(sm.getRetryCount()).toBe(1);
      sm.transition({ type: 'FALLBACK', to: 'DESIGN_GENERATING', reason: 'test' });
      expect(sm.getRetryCount('CODING')).toBe(0);
    });
  });

  describe('非法回退转换', () => {
    it('不允许从 CODING 回退到 STORIES_GENERATING', () => {
      advanceTo(sm, 'CODING');
      const result = sm.transition({
        type: 'FALLBACK',
        to: 'STORIES_GENERATING',
        reason: 'test',
      });
      expect(result.success).toBe(false);
    });

    it('不允许从 INIT 回退', () => {
      const result = sm.transition({ type: 'FALLBACK', to: 'INIT', reason: 'test' });
      expect(result.success).toBe(false);
    });
  });

  describe('挂起与恢复', () => {
    it('应该能从任意运行状态挂起', () => {
      advanceTo(sm, 'CODING');
      const result = sm.transition({
        type: 'SUSPEND',
        reason: '等待人工确认',
        waitingFor: 'API 契约确认',
      });
      expect(result.success).toBe(true);
      expect(sm.getState().currentState).toBe('SUSPENDED');
      expect(sm.getState().status).toBe('suspended');
      expect(sm.getState().suspendedFromState).toBe('CODING');
      expect(sm.getState().suspendedReason).toBe('等待人工确认');
    });

    it('应该能从 SUSPENDED 恢复到原状态', () => {
      advanceTo(sm, 'CODING');
      sm.transition({ type: 'SUSPEND', reason: 'test' });
      const result = sm.transition({ type: 'RESUME', fromState: 'CODING' });
      expect(result.success).toBe(true);
      expect(sm.getState().currentState).toBe('CODING');
      expect(sm.getState().suspendedFromState).toBeUndefined();
    });

    it('恢复到硬卡点状态时 status 应为 waiting_human', () => {
      advanceTo(sm, 'API_CONFIRMATION');
      sm.transition({ type: 'SUSPEND', reason: 'test' });
      sm.transition({ type: 'RESUME', fromState: 'API_CONFIRMATION' });
      expect(sm.getState().status).toBe('waiting_human');
    });

    it('不能从非 SUSPENDED 状态恢复', () => {
      const result = sm.transition({ type: 'RESUME', fromState: 'CODING' });
      expect(result.success).toBe(false);
    });
  });

  describe('失败', () => {
    it('应该能从任意状态失败', () => {
      advanceTo(sm, 'CODING');
      const result = sm.transition({ type: 'FAIL', reason: 'LLM 调用失败达上限' });
      expect(result.success).toBe(true);
      expect(sm.getState().currentState).toBe('FAILED');
      expect(sm.getState().status).toBe('failed');
    });
  });

  describe('完成', () => {
    it('只能从 DELIVERY_CONFIRMATION 完成', () => {
      advanceTo(sm, 'DELIVERY_CONFIRMATION');
      const result = sm.transition({ type: 'COMPLETE' });
      expect(result.success).toBe(true);
      expect(sm.getState().currentState).toBe('COMPLETED');
    });

    it('不能从其他状态完成', () => {
      advanceTo(sm, 'DELIVERING');
      const result = sm.transition({ type: 'COMPLETE' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('只能从 DELIVERY_CONFIRMATION');
    });
  });

  describe('取消（ADR-014）', () => {
    it('运行中状态可以取消，进入 CANCELLED 终态', () => {
      advanceTo(sm, 'CODING');
      const result = sm.transition({ type: 'CANCEL', reason: '人工终止' });
      expect(result.success).toBe(true);
      expect(sm.getState().currentState).toBe('CANCELLED');
      expect(sm.getState().status).toBe('cancelled');
      expect(isTerminalState('CANCELLED')).toBe(true);
    });

    it('CANCELLED 终态不允许任何转换', () => {
      advanceTo(sm, 'CODING');
      sm.transition({ type: 'CANCEL', reason: 'test' });

      expect(sm.transition({ type: 'ADVANCE', to: 'CODE_REVIEWING' }).success).toBe(false);
      expect(sm.transition({ type: 'FAIL', reason: 'test' }).success).toBe(false);
      expect(sm.transition({ type: 'CANCEL', reason: 'again' }).success).toBe(false);
    });
  });

  describe('阶段顺序（ADR-014：评审先于 API 确认）', () => {
    it('DESIGN_GENERATING 只能前进到 DESIGN_REVIEWING', () => {
      advanceTo(sm, 'DESIGN_GENERATING');
      expect(canAdvance('DESIGN_GENERATING', 'DESIGN_REVIEWING')).toBe(true);
      expect(canAdvance('DESIGN_GENERATING', 'API_CONFIRMATION')).toBe(false);
    });

    it('DESIGN_REVIEWING 前进到 API_CONFIRMATION，API_CONFIRMATION 前进到 CODING', () => {
      expect(canAdvance('DESIGN_REVIEWING', 'API_CONFIRMATION')).toBe(true);
      expect(canAdvance('API_CONFIRMATION', 'CODING')).toBe(true);
      expect(canAdvance('DESIGN_REVIEWING', 'CODING')).toBe(false);
    });

    it('API_CONFIRMATION 发现方案问题可回退到 DESIGN_GENERATING', () => {
      advanceTo(sm, 'API_CONFIRMATION');
      const result = sm.transition({
        type: 'FALLBACK',
        to: 'DESIGN_GENERATING',
        reason: 'API 设计缺陷',
      });
      expect(result.success).toBe(true);
      expect(sm.getState().currentState).toBe('DESIGN_GENERATING');
    });
  });

  describe('终态不可变性', () => {
    it('COMPLETED 状态执行 FAIL 应该失败', () => {
      advanceTo(sm, 'COMPLETED');
      const result = sm.transition({ type: 'FAIL', reason: 'test' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('终态');
      expect(sm.getState().currentState).toBe('COMPLETED');
    });

    it('COMPLETED 状态执行 ADVANCE 应该失败', () => {
      advanceTo(sm, 'COMPLETED');
      const result = sm.transition({ type: 'ADVANCE', to: 'INIT' });
      expect(result.success).toBe(false);
    });

    it('FAILED 状态执行任何动作都应该失败', () => {
      advanceTo(sm, 'CODING');
      sm.transition({ type: 'FAIL', reason: 'test' });
      expect(sm.getState().currentState).toBe('FAILED');

      const advanceResult = sm.transition({ type: 'ADVANCE', to: 'CODE_REVIEWING' });
      expect(advanceResult.success).toBe(false);

      const fallbackResult = sm.transition({
        type: 'FALLBACK',
        to: 'DESIGN_GENERATING',
        reason: 'test',
      });
      expect(fallbackResult.success).toBe(false);

      const failResult = sm.transition({ type: 'FAIL', reason: 'again' });
      expect(failResult.success).toBe(false);
    });
  });

  describe('getState() 封装性', () => {
    it('修改返回的 retryCount 不应影响内部状态', () => {
      advanceTo(sm, 'CODING');
      sm.incrementRetry();

      const state = sm.getState();
      expect(state.retryCount['CODING']).toBe(1);

      // 外部修改返回值
      state.retryCount['CODING'] = 999;
      state.retryCount['FAKE_STATE'] = 100;

      // 内部状态不应被改变
      const internalState = sm.getState();
      expect(internalState.retryCount['CODING']).toBe(1);
      expect(internalState.retryCount['FAKE_STATE']).toBeUndefined();
    });

    it('修改返回的 artifactIds 不应影响内部状态', () => {
      const state = sm.getState();
      state.artifactIds['requirement'] = 'fake-id';

      const internalState = sm.getState();
      expect(internalState.artifactIds['requirement']).toBeUndefined();
    });
  });

  describe('SUSPENDED 状态行为', () => {
    it('SUSPENDED 状态执行 ADVANCE 应该失败', () => {
      advanceTo(sm, 'CODING');
      sm.transition({ type: 'SUSPEND', reason: 'test' });

      const result = sm.transition({ type: 'ADVANCE', to: 'CODE_REVIEWING' });
      expect(result.success).toBe(false);
    });

    it('SUSPENDED 状态执行 FALLBACK 应该失败', () => {
      advanceTo(sm, 'CODING');
      sm.transition({ type: 'SUSPEND', reason: 'test' });

      const result = sm.transition({
        type: 'FALLBACK',
        to: 'DESIGN_GENERATING',
        reason: 'test',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('原地等待人工 pauseForHuman / markRunning（#42 对话循环）', () => {
    it('pauseForHuman 不迁移状态，仅置 waiting_human 并记录说明', () => {
      const sm = new StateMachine(createInitialState('i1'));
      sm.transition({ type: 'ADVANCE', to: 'REQUIREMENT_PARSING' });
      sm.transition({ type: 'ADVANCE', to: 'REQUIREMENT_CLARIFICATION' });
      sm.transition({ type: 'ADVANCE', to: 'STORIES_GENERATING' });
      sm.transition({ type: 'ADVANCE', to: 'DESIGN_GENERATING' });
      sm.transition({ type: 'ADVANCE', to: 'DESIGN_REVIEWING' });

      sm.pauseForHuman('达到最大评审轮次');
      const paused = sm.getState();
      expect(paused.currentState).toBe('DESIGN_REVIEWING');
      expect(paused.status).toBe('waiting_human');
      expect(paused.waitingFor).toBe('达到最大评审轮次');

      sm.markRunning();
      const resumed = sm.getState();
      expect(resumed.currentState).toBe('DESIGN_REVIEWING');
      expect(resumed.status).toBe('running');
      expect(resumed.waitingFor).toBeUndefined();
    });
  });

  describe('重试计数', () => {
    it('应该能增加和获取重试计数', () => {
      expect(sm.getRetryCount()).toBe(0);
      expect(sm.incrementRetry()).toBe(1);
      expect(sm.incrementRetry()).toBe(2);
      expect(sm.getRetryCount()).toBe(2);
    });

    it('应该能按状态名获取重试计数', () => {
      advanceTo(sm, 'CODING');
      sm.incrementRetry();
      sm.incrementRetry();
      expect(sm.getRetryCount('CODING')).toBe(2);
      expect(sm.getRetryCount('DESIGN_GENERATING')).toBe(0);
    });
  });

  describe('辅助函数', () => {
    it('canAdvance 应该正确判断合法前进', () => {
      expect(canAdvance('INIT', 'REQUIREMENT_PARSING')).toBe(true);
      expect(canAdvance('CODING', 'CODE_REVIEWING')).toBe(true);
      expect(canAdvance('INIT', 'CODING')).toBe(false);
    });

    it('canFallback 应该正确判断合法回退', () => {
      expect(canFallback('CODING', 'DESIGN_GENERATING')).toBe(true);
      expect(canFallback('CODE_REVIEWING', 'CODING')).toBe(false); // 代码问题在对话内 revise
      expect(canFallback('CODE_REVIEWING', 'DESIGN_GENERATING')).toBe(true);
      expect(canFallback('CODING', 'STORIES_GENERATING')).toBe(false);
    });

    it('isHardBlockingState 应该正确识别硬卡点', () => {
      expect(isHardBlockingState('REQUIREMENT_CLARIFICATION')).toBe(true);
      expect(isHardBlockingState('API_CONFIRMATION')).toBe(true);
      expect(isHardBlockingState('DELIVERY_CONFIRMATION')).toBe(true);
      expect(isHardBlockingState('CODING')).toBe(false);
      expect(HARD_BLOCKING_STATES).toHaveLength(3);
    });

    it('isTerminalState 应该正确识别终态', () => {
      expect(isTerminalState('COMPLETED')).toBe(true);
      expect(isTerminalState('FAILED')).toBe(true);
      expect(isTerminalState('CODING')).toBe(false);
    });
  });
});

/** 辅助函数：快速前进到指定状态 */
function advanceTo(sm: StateMachine, target: PipelineStateName): void {
  const path: PipelineStateName[] = [
    'REQUIREMENT_PARSING',
    'REQUIREMENT_CLARIFICATION',
    'STORIES_GENERATING',
    'DESIGN_GENERATING',
    'DESIGN_REVIEWING',
    'API_CONFIRMATION',
    'CODING',
    'CODE_REVIEWING',
    'DELIVERING',
    'DELIVERY_CONFIRMATION',
    'COMPLETED',
  ];
  for (const next of path) {
    sm.transition({ type: 'ADVANCE', to: next });
    if (next === target) break;
  }
}
