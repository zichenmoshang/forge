import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Harness } from '../../src/core/harness';
import type { AgentRegistry } from '../../src/core/harness';
import { RequirementAgent } from '../../src/agents/requirement-agent';
import type { LLMProvider, LLMResponse } from '../../src/llm/provider';
import type { StructuredRequirement } from '../../src/types/requirement';
import {
  FileSystemArtifactStore,
  saveStateSnapshot,
  loadStateSnapshot,
  isTerminalSnapshot,
} from '../../src/core/state-snapshot';
import { createInitialState } from '../../src/core/state-machine';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-snapshot-'));
}

function createMockLLM(contents: string | string[]): LLMProvider {
  const contentList = Array.isArray(contents) ? contents : [contents];
  let callCount = 0;
  return {
    name: 'mock-llm',
    complete: vi.fn().mockImplementation(async () => {
      const content = contentList[Math.min(callCount, contentList.length - 1)];
      callCount++;
      return {
        content,
        model: 'mock-model',
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
        durationMs: 100,
        finishReason: 'stop',
      } as LLMResponse;
    }),
  };
}

const CLARIFICATION_JSON = JSON.stringify({
  meta: { title: '测试需求', source: 'test.md', version: '1.0' },
  businessGoals: [{ id: 'g1', description: '目标1', priority: 'P0' }],
  roles: [{ id: 'r1', name: '用户', description: '普通用户', coreNeeds: [] }],
  features: [
    {
      id: 'f1',
      name: '功能1',
      description: '功能描述',
      module: '模块1',
      relatedRoleIds: ['r1'],
      relatedGoalIds: ['g1'],
      priority: 'P0',
      hasExceptionFlow: false,
    },
  ],
  businessRules: [],
  nonFunctionalRequirements: [{ id: 'nfr1', category: 'performance', description: '性能' }],
  globalRequirements: [
    {
      id: 'greq1',
      category: 'authentication',
      description: '登录',
      inScope: true,
      source: 'new',
      discoveredInClarification: true,
    },
  ],
  trackingRequirements: [],
  clarificationLog: [
    {
      id: 'q1',
      question: '是否支持第三方登录？',
      category: 'missing',
      priority: 'important',
      status: 'pending',
    },
  ],
});

const FOLLOWUP_JSON = JSON.stringify({
  meta: { title: '测试需求', source: 'test.md', version: '1.0' },
  businessGoals: [{ id: 'g1', description: '目标1', priority: 'P0' }],
  roles: [{ id: 'r1', name: '用户', description: '普通用户', coreNeeds: [] }],
  features: [
    {
      id: 'f1',
      name: '功能1',
      description: '功能描述',
      module: '模块1',
      relatedRoleIds: ['r1'],
      relatedGoalIds: ['g1'],
      priority: 'P0',
      hasExceptionFlow: false,
    },
  ],
  businessRules: [],
  nonFunctionalRequirements: [{ id: 'nfr1', category: 'performance', description: '性能' }],
  globalRequirements: [
    {
      id: 'greq1',
      category: 'authentication',
      description: '登录',
      inScope: true,
      source: 'new',
      discoveredInClarification: true,
    },
  ],
  trackingRequirements: [],
  clarificationLog: [
    {
      id: 'q1',
      question: '是否支持第三方登录？',
      category: 'missing',
      priority: 'important',
      status: 'answered',
      answeredAt: new Date().toISOString(),
    },
  ],
});

describe('FileSystemArtifactStore（issue #82 文件系统产物存储）', () => {
  it('save 后产物落盘，重启后可从磁盘恢复', () => {
    const dir = tmpDir();
    const store1 = new FileSystemArtifactStore(dir);
    store1.save('requirement', 'inst-1', { title: '需求A' });

    // 模拟重启：新建同目录 store，应从磁盘加载
    const store2 = new FileSystemArtifactStore(dir);
    expect(store2.get('requirement', 'inst-1')).toEqual({ title: '需求A' });
  });

  it('同 stage 再次 save 版本号递增并覆盖磁盘', () => {
    const dir = tmpDir();
    const store = new FileSystemArtifactStore(dir);
    store.save('design', 'inst-1', { v: 1 });
    store.save('design', 'inst-1', { v: 2 });

    const reloaded = new FileSystemArtifactStore(dir);
    const record = reloaded.getRecord('design', 'inst-1');
    expect(record?.version).toBe(2);
    expect(record?.data).toEqual({ v: 2 });
  });

  it('remove 同步删除内存与磁盘', () => {
    const dir = tmpDir();
    const store = new FileSystemArtifactStore(dir);
    store.save('stories', 'inst-1', { stories: [] });
    expect(store.remove('stories', 'inst-1')).toBe(true);
    const reloaded = new FileSystemArtifactStore(dir);
    expect(reloaded.get('stories', 'inst-1')).toBeUndefined();
  });

  it('损坏的 JSON 文件不阻塞加载', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'broken.json'), '{bad json', 'utf-8');
    const store = new FileSystemArtifactStore(dir);
    expect(store.list('inst-x')).toHaveLength(0);
  });
});

describe('状态快照（issue #82）', () => {
  it('save/load 往返一致', () => {
    const dir = tmpDir();
    const state = createInitialState('inst-1');
    state.currentState = 'DESIGN_REVIEWING';
    state.status = 'waiting_human';
    saveStateSnapshot(dir, state);

    const loaded = loadStateSnapshot(dir);
    expect(loaded).toBeDefined();
    expect(loaded?.instanceId).toBe('inst-1');
    expect(loaded?.currentState).toBe('DESIGN_REVIEWING');
    expect(loaded?.status).toBe('waiting_human');
  });

  it('无快照时返回 undefined；损坏快照返回 undefined', () => {
    const dir = tmpDir();
    expect(loadStateSnapshot(dir)).toBeUndefined();
    fs.writeFileSync(path.join(dir, 'state.json'), 'not-json', 'utf-8');
    expect(loadStateSnapshot(dir)).toBeUndefined();
  });

  it('isTerminalSnapshot 正确判定终态', () => {
    const dir = tmpDir();
    const running = createInitialState('i1');
    saveStateSnapshot(dir, running);
    expect(isTerminalSnapshot(loadStateSnapshot(dir))).toBe(false);

    const done = createInitialState('i1');
    done.currentState = 'COMPLETED';
    done.status = 'completed';
    saveStateSnapshot(dir, done);
    expect(isTerminalSnapshot(loadStateSnapshot(dir))).toBe(true);
  });
});

describe('Harness 快照续跑（issue #82）', () => {
  it('进程重启后可从快照恢复硬卡点状态并续跑', async () => {
    const dir = tmpDir();
    const instanceId = `forge-snapshot-test-${Date.now()}`;
    const llm = createMockLLM(CLARIFICATION_JSON);

    // 第一次运行：走到 REQUIREMENT_CLARIFICATION 等待人工
    const harness1 = new Harness({
      agents: { requirement: new RequirementAgent(llm, { config: { maxRetries: 0 } }) },
      instanceId,
      instanceDir: dir,
    });
    const result1 = await harness1.start('# 测试需求\n\nPRD 内容', 'test.md');
    expect(result1.waitingForHuman).toBe(true);
    expect(result1.finalState).toBe('REQUIREMENT_CLARIFICATION');

    // 快照与产物已落盘
    expect(fs.existsSync(path.join(dir, 'state.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'artifacts', 'requirement.json'))).toBe(true);

    // 模拟崩溃：丢弃 harness1，用同 instanceId 重建
    // 恢复后 resume 走 clarify-followup，只需"无 pending"的响应
    const llm2 = createMockLLM(FOLLOWUP_JSON);
    const harness2 = new Harness({
      agents: { requirement: new RequirementAgent(llm2, { config: { maxRetries: 0 } }) },
      instanceId,
      instanceDir: dir,
    });

    // 恢复成功：状态与产物从磁盘恢复
    expect(harness2.restoredFromSnapshot).toBe(true);
    const restoredState = harness2.getState();
    expect(restoredState.currentState).toBe('REQUIREMENT_CLARIFICATION');
    expect(restoredState.status).toBe('waiting_human');
    const requirement = harness2.getArtifact<StructuredRequirement>('requirement');
    expect(requirement?.meta.title).toBe('测试需求');

    // 续跑：continueFromSnapshot 返回等待人工，resume 后继续推进
    const cont = await harness2.continueFromSnapshot();
    expect(cont.waitingForHuman).toBe(true);
    expect(cont.finalState).toBe('REQUIREMENT_CLARIFICATION');

    const resumeResult = await harness2.resume('确认，支持第三方登录');
    // ADR-014：DesignAgent 未实现属于开发期错误 → FAILED（走到故事阶段缺 Agent）
    expect(resumeResult.success).toBe(false);
    expect(resumeResult.finalState).toBe('FAILED');
  });

  it('终态实例续跑直接返回终态结果', async () => {
    const dir = tmpDir();
    const instanceId = `forge-snapshot-done-${Date.now()}`;
    const llm = createMockLLM(CLARIFICATION_JSON);

    const harness = new Harness({
      agents: { requirement: new RequirementAgent(llm, { config: { maxRetries: 0 } }) },
      instanceId,
      instanceDir: dir,
    });
    await harness.start('# 测试需求\n\nPRD 内容', 'test.md');

    // 直接把手动把快照置为 COMPLETED 终态（模拟已完成实例）
    const state = harness.getState();
    state.currentState = 'COMPLETED';
    state.status = 'completed';
    saveStateSnapshot(dir, state);

    const resumed = new Harness({
      agents: { requirement: new RequirementAgent(llm, { config: { maxRetries: 0 } }) },
      instanceId,
      instanceDir: dir,
    });
    const result = await resumed.continueFromSnapshot();
    expect(result.success).toBe(true);
    expect(result.finalState).toBe('COMPLETED');
    expect(result.waitingForHuman).toBe(false);
  });
});
