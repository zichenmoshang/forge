/**
 * 状态 → 阶段/Agent/下一状态 的纯函数映射（issue #47 Harness 拆分）
 *
 * 从 Harness 抽出的无状态转换逻辑，供 Harness 门面与各阶段 Runner 复用，
 * 保证"状态流转规则"只有一份实现（单一事实来源）。
 */

import type { BaseAgent } from '../agents/base';
import type { PipelineStateName, ArtifactStage } from '../types/state';
import type { AgentRegistry } from './harness';

/** 状态 → 对应 Agent（无 Agent 时返回 undefined，由调用方决定 FAILED） */
export function getAgentForState(
  state: PipelineStateName,
  agents: AgentRegistry,
): BaseAgent | undefined {
  switch (state) {
    case 'REQUIREMENT_PARSING':
    case 'STORIES_GENERATING':
      return agents.requirement;
    case 'DESIGN_GENERATING':
      return agents.design;
    case 'DESIGN_REVIEWING':
    case 'CODE_REVIEWING':
      return agents.review;
    case 'CODING':
      return agents.coding;
    case 'DELIVERING':
      return agents.delivery;
    default:
      return undefined;
  }
}

/** 状态 → 产物阶段（Agent 执行成功后保存到该 stage） */
export function getArtifactStage(state: PipelineStateName): ArtifactStage | undefined {
  switch (state) {
    case 'REQUIREMENT_PARSING':
      return 'requirement';
    case 'STORIES_GENERATING':
      return 'stories';
    case 'DESIGN_GENERATING':
      return 'design';
    case 'DESIGN_REVIEWING':
      return 'design-review';
    case 'CODING':
      return 'coding';
    case 'CODE_REVIEWING':
      return 'code-review';
    case 'DELIVERING':
      return 'delivery';
    default:
      return undefined;
  }
}

/** 状态 → 下一状态（ADR-014 顺序：设计 → 评审 → API 确认 → 编码） */
export function getNextState(state: PipelineStateName): PipelineStateName | undefined {
  const transitions: Record<PipelineStateName, PipelineStateName> = {
    INIT: 'REQUIREMENT_PARSING',
    REQUIREMENT_PARSING: 'REQUIREMENT_CLARIFICATION',
    REQUIREMENT_CLARIFICATION: 'STORIES_GENERATING',
    STORIES_GENERATING: 'DESIGN_GENERATING',
    // ADR-014：方案生成 → 方案评审 → API 确认 → 编码
    DESIGN_GENERATING: 'DESIGN_REVIEWING',
    DESIGN_REVIEWING: 'API_CONFIRMATION',
    API_CONFIRMATION: 'CODING',
    CODING: 'CODE_REVIEWING',
    CODE_REVIEWING: 'DELIVERING',
    DELIVERING: 'DELIVERY_CONFIRMATION',
    DELIVERY_CONFIRMATION: 'COMPLETED',
    COMPLETED: 'COMPLETED',
    FAILED: 'FAILED',
    CANCELLED: 'CANCELLED',
    SUSPENDED: 'SUSPENDED',
  };
  return transitions[state];
}

/** 硬卡点确认后的下一状态（当前语义与 getNextState 一致，保留独立函数便于后续特化） */
export function getNextStateAfterBlocking(state: PipelineStateName): PipelineStateName | undefined {
  return getNextState(state);
}

/** 状态名转换为 stage 格式（kebab-case）：REQUIREMENT_PARSING → requirement-parsing */
export function stateToStage(state: PipelineStateName): string {
  return state.toLowerCase().replace(/_/g, '-');
}
