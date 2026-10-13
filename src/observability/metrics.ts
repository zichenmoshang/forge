/**
 * Metrics 指标聚合器（可观测性第三层，issue：真实运行指标汇总）
 *
 * 单流程实例共享：Harness 创建后注入每个 AgentContext，
 * BaseAgent 在每次 LLM 调用成功后 recordCall，按 stage/agent 聚合：
 * - 调用次数、成功/失败次数
 * - prompt/completion/total tokens
 * - 调用耗时
 *
 * 流程终态时 Harness 调用 toSummary 生成 RunSummary，落盘 run-summary.json，
 * 作为性能基准（#87）与成本核算的数据源。
 *
 * 设计定位：进程内聚合，不依赖解析 llm-calls.log；
 * 与 TokenBudgetTracker（预算控制，#39）互补——前者是"度量与复盘"，后者是"阻断与控制"。
 */

import * as fs from 'fs';
import * as path from 'path';

/** 单次 LLM 调用指标记录 */
export interface LLMCallMetric {
  timestamp: string;
  stage: string;
  agent: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs: number;
  success: boolean;
  finishReason?: string;
}

/** 单个维度（stage 或 agent）的聚合指标 */
export interface DimensionMetrics {
  /** 维度名（阶段名或 Agent 名） */
  name: string;
  calls: number;
  failures: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  totalDurationMs: number;
}

/** 流程级汇总结果 */
export interface RunSummary {
  instanceId: string;
  traceId: string;
  startedAt: string;
  endedAt: string;
  finalState: string;
  totalCalls: number;
  failedCalls: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalDurationMs: number;
  /** 按阶段聚合（如 requirement / design / coding） */
  byStage: DimensionMetrics[];
  /** 按 Agent 聚合 */
  byAgent: DimensionMetrics[];
}

export class MetricsCollector {
  private readonly instanceId: string;
  private readonly traceId: string;
  private readonly startedAt: string;
  private readonly records: LLMCallMetric[] = [];

  constructor(instanceId: string, traceId: string, startedAt?: string) {
    this.instanceId = instanceId;
    this.traceId = traceId;
    this.startedAt = startedAt ?? new Date().toISOString();
  }

  /** 记录一次 LLM 调用 */
  recordCall(metric: Omit<LLMCallMetric, 'timestamp'> & { timestamp?: string }): void {
    this.records.push({
      timestamp: metric.timestamp ?? new Date().toISOString(),
      stage: metric.stage,
      agent: metric.agent,
      model: metric.model,
      promptTokens: metric.promptTokens,
      completionTokens: metric.completionTokens,
      totalTokens: metric.totalTokens,
      durationMs: metric.durationMs,
      success: metric.success,
      finishReason: metric.finishReason,
    });
  }

  /** 原始记录（只读副本） */
  getRecords(): readonly LLMCallMetric[] {
    return this.records;
  }

  /** 生成流程级汇总 */
  toSummary(finalState: string, endedAt?: string): RunSummary {
    const byStageMap = new Map<string, DimensionMetrics>();
    const byAgentMap = new Map<string, DimensionMetrics>();

    const accumulate = (
      map: Map<string, DimensionMetrics>,
      name: string,
      r: LLMCallMetric,
    ): void => {
      const existing =
        map.get(name) ??
        {
          name,
          calls: 0,
          failures: 0,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          totalDurationMs: 0,
        };
      existing.calls++;
      if (!r.success) existing.failures++;
      existing.promptTokens += r.promptTokens;
      existing.completionTokens += r.completionTokens;
      existing.totalTokens += r.totalTokens;
      existing.totalDurationMs += r.durationMs;
      map.set(name, existing);
    };

    for (const r of this.records) {
      accumulate(byStageMap, r.stage, r);
      accumulate(byAgentMap, r.agent, r);
    }

    return {
      instanceId: this.instanceId,
      traceId: this.traceId,
      startedAt: this.startedAt,
      endedAt: endedAt ?? new Date().toISOString(),
      finalState,
      totalCalls: this.records.length,
      failedCalls: this.records.filter((r) => !r.success).length,
      totalPromptTokens: this.records.reduce((s, r) => s + r.promptTokens, 0),
      totalCompletionTokens: this.records.reduce((s, r) => s + r.completionTokens, 0),
      totalTokens: this.records.reduce((s, r) => s + r.totalTokens, 0),
      totalDurationMs: this.records.reduce((s, r) => s + r.durationMs, 0),
      byStage: [...byStageMap.values()].sort((a, b) => b.totalTokens - a.totalTokens),
      byAgent: [...byAgentMap.values()].sort((a, b) => b.totalTokens - a.totalTokens),
    };
  }

  /**
   * 生成汇总并原子落盘 run-summary.json，返回汇总对象。
   * @param dir 实例目录
   */
  writeSummary(dir: string, finalState: string): RunSummary {
    const summary = this.toSummary(finalState);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'run-summary.json');
    const tmp = path.join(dir, `.run-summary.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(summary, null, 2), 'utf-8');
    fs.renameSync(tmp, target);
    return summary;
  }
}
