/**
 * MetricsCollector 单测（#13）
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MetricsCollector } from '../../src/observability/metrics';

describe('MetricsCollector', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('初始状态：无记录时汇总为零', () => {
    const collector = new MetricsCollector('inst-1', 'trace-1');
    const summary = collector.toSummary('COMPLETED');

    expect(summary.instanceId).toBe('inst-1');
    expect(summary.traceId).toBe('trace-1');
    expect(summary.totalCalls).toBe(0);
    expect(summary.totalTokens).toBe(0);
    expect(summary.failedCalls).toBe(0);
    expect(summary.byStage).toEqual([]);
    expect(summary.byAgent).toEqual([]);
  });

  it('recordCall：按 stage 与 agent 双维度聚合次数/token/耗时', () => {
    const collector = new MetricsCollector('inst-1', 'trace-1');

    collector.recordCall({
      stage: 'requirement',
      agent: 'requirement-agent',
      model: 'doubao',
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      durationMs: 1000,
      success: true,
    });
    collector.recordCall({
      stage: 'requirement',
      agent: 'requirement-agent',
      model: 'doubao',
      promptTokens: 200,
      completionTokens: 100,
      totalTokens: 300,
      durationMs: 2000,
      success: true,
    });
    collector.recordCall({
      stage: 'coding',
      agent: 'coding-agent',
      model: 'doubao',
      promptTokens: 500,
      completionTokens: 300,
      totalTokens: 800,
      durationMs: 4000,
      success: false,
    });

    const summary = collector.toSummary('COMPLETED');

    expect(summary.totalCalls).toBe(3);
    expect(summary.failedCalls).toBe(1);
    expect(summary.totalPromptTokens).toBe(800);
    expect(summary.totalCompletionTokens).toBe(450);
    expect(summary.totalTokens).toBe(1250);
    expect(summary.totalDurationMs).toBe(7000);

    const requirementDim = summary.byStage.find((d) => d.name === 'requirement');
    expect(requirementDim?.calls).toBe(2);
    expect(requirementDim?.totalTokens).toBe(450);
    expect(requirementDim?.totalDurationMs).toBe(3000);
    expect(requirementDim?.failures).toBe(0);

    const codingDim = summary.byStage.find((d) => d.name === 'coding');
    expect(codingDim?.failures).toBe(1);

    // byAgent 维度
    expect(summary.byAgent.find((d) => d.name === 'coding-agent')?.totalTokens).toBe(800);

    // 按 token 降序排列
    expect(summary.byStage[0].name).toBe('coding');
  });

  it('writeSummary：落盘 run-summary.json 且内容与汇总一致', () => {
    const collector = new MetricsCollector('inst-1', 'trace-1');
    collector.recordCall({
      stage: 'coding',
      agent: 'coding-agent',
      model: 'doubao',
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
      durationMs: 500,
      success: true,
    });

    const summary = collector.writeSummary(tmpDir, 'COMPLETED');
    const file = path.join(tmpDir, 'run-summary.json');

    expect(fs.existsSync(file)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(onDisk).toEqual(summary);
    expect(onDisk.finalState).toBe('COMPLETED');
    expect(onDisk.totalTokens).toBe(30);
  });

  it('writeSummary：目录不存在时自动创建', () => {
    const collector = new MetricsCollector('inst-1', 'trace-1');
    const nested = path.join(tmpDir, 'a', 'b', 'c');

    const summary = collector.writeSummary(nested, 'FAILED');

    expect(fs.existsSync(path.join(nested, 'run-summary.json'))).toBe(true);
    expect(summary.finalState).toBe('FAILED');
  });

  it('getRecords：返回原始记录只读副本', () => {
    const collector = new MetricsCollector('inst-1', 'trace-1');
    collector.recordCall({
      stage: 'design',
      agent: 'design-agent',
      model: 'doubao',
      promptTokens: 1,
      completionTokens: 2,
      totalTokens: 3,
      durationMs: 10,
      success: true,
      finishReason: 'stop',
    });

    const records = collector.getRecords();
    expect(records).toHaveLength(1);
    expect(records[0].stage).toBe('design');
    expect(records[0].finishReason).toBe('stop');
    expect(records[0].timestamp).toBeTruthy();
  });
});
