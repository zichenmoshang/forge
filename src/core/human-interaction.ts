/**
 * 人工介入处理（issue #47 Harness 拆分）
 *
 * 硬卡点提问、人工回答记录、弱介入窗口（回调与超时竞速）的纯逻辑，
 * 从 Harness 抽出后保持行为不变，全部通过入参注入依赖（无内部状态）。
 */

import type { PipelineStateName } from '../types/state';
import type { StructuredRequirement } from '../types/requirement';
import type { ArtifactStore } from './artifact-store';
import type { Logger } from '../observability/logger';
import type {
  HumanInterventionCallback,
  WeakInterventionCallback,
  WeakInterventionDecision,
} from './harness';

/** 构建硬卡点等待人工的问题文案 */
export function buildBlockingQuestion(
  artifactStore: ArtifactStore,
  instanceId: string,
  state: PipelineStateName,
): string {
  switch (state) {
    case 'REQUIREMENT_CLARIFICATION': {
      const requirement = artifactStore.get<StructuredRequirement>('requirement', instanceId);
      const pendingQuestions = requirement?.clarificationLog.filter(
        (q) => q.status === 'pending',
      );
      if (pendingQuestions && pendingQuestions.length > 0) {
        return (
          `需求澄清：有 ${pendingQuestions.length} 个问题需要确认\n` +
          pendingQuestions.map((q, i) => `${i + 1}. [${q.priority}] ${q.question}`).join('\n')
        );
      }
      return '需求澄清：请确认需求分析结果是否准确完整';
    }
    case 'API_CONFIRMATION':
      return 'API 契约确认：方案已通过 AI 评审，请确认 API 接口定义是否正确（确认后进入编码）';
    case 'DELIVERY_CONFIRMATION':
      return '交付确认：请确认代码变更是否符合预期，是否创建 PR';
    default:
      return '请确认是否继续';
  }
}

/**
 * 处理硬卡点的人工回答（当前版本仅作为放行信号，回答内容不消费）。
 * REQUIREMENT_CLARIFICATION 走多轮澄清（handleClarificationFollowup），不进入本方法。
 */
export function handleHumanAnswer(
  logger: Logger | undefined,
  state: PipelineStateName,
  answer?: string,
): void {
  logger?.info(
    `[Harness] 硬卡点 ${state} 收到人工确认${answer ? '（含回答内容，当前版本仅放行不消费）' : ''}`,
  );
}

/**
 * 弱介入窗口调用：回调决策与超时竞速，超时自动 continue，避免流程无限等待。
 * weakConfirmationTimeoutMs <= 0 时不超时，一直等待人工回调。
 */
export async function invokeWeakIntervention(
  onWeakIntervention: WeakInterventionCallback | undefined,
  logger: Logger | undefined,
  instanceId: string,
  weakConfirmationTimeoutMs: number,
  state: PipelineStateName,
  artifact: unknown,
): Promise<WeakInterventionDecision> {
  if (!onWeakIntervention) return { action: 'continue' };

  const decisionPromise = onWeakIntervention(state, {
    instanceId,
    artifact,
  });
  if (weakConfirmationTimeoutMs <= 0) return decisionPromise;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<WeakInterventionDecision>((resolve) => {
    timer = setTimeout(() => {
      logger?.warn(`[Harness] 弱介入窗口 ${weakConfirmationTimeoutMs}ms 内无决策，自动继续`);
      resolve({ action: 'continue' });
    }, weakConfirmationTimeoutMs);
  });

  try {
    return await Promise.race([decisionPromise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type { HumanInterventionCallback, WeakInterventionCallback };
