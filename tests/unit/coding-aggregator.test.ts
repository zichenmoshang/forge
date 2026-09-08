import { describe, it, expect } from 'vitest';
import {
  topoSortStories,
  aggregateCodingResults,
  hasAnySuccessStory,
} from '../../src/core/coding-aggregator';
import type { CodingResult } from '../../src/types/coding-task';
import type { UserStory } from '../../src/types/user-story';

function makeResult(overrides: Partial<CodingResult> & { storyId: string }): CodingResult {
  return {
    id: `result-${overrides.storyId}`,
    instanceId: 'inst-1',
    taskId: `task-${overrides.storyId}`,
    status: 'success',
    files: [],
    testResult: {
      totalTests: 0,
      passedTests: 0,
      failedTests: 0,
      skippedTests: 0,
      environment: 'sandbox',
      outputSummary: '',
      allPassed: true,
    },
    tddCycles: [],
    completedAt: '2026-09-05T00:00:00.000Z',
    ...overrides,
  };
}

function makeStory(id: string, dependencies: string[] = []): UserStory {
  return {
    id,
    title: id,
    description: { role: 'r', action: 'a', benefit: 'b' },
    acceptanceCriteria: [],
    priority: 'P1',
    dependencies,
    relatedFeatureIds: [],
    relatedRuleIds: [],
    type: 'feature',
    hasExceptionFlow: false,
  };
}

describe('coding-aggregator', () => {
  it('全部故事成功 → all-success，测试统计累加，passRate 正确', () => {
    const results = [
      makeResult({
        storyId: 's1',
        testResult: {
          totalTests: 4,
          passedTests: 4,
          failedTests: 0,
          skippedTests: 0,
          environment: 'sandbox',
          outputSummary: '',
          allPassed: true,
        },
      }),
      makeResult({
        storyId: 's2',
        testResult: {
          totalTests: 6,
          passedTests: 6,
          failedTests: 0,
          skippedTests: 0,
          environment: 'sandbox',
          outputSummary: '',
          allPassed: true,
        },
      }),
    ];
    const phase = aggregateCodingResults(results, {
      id: 'phase-1',
      instanceId: 'inst-1',
      designDocId: 'design-1',
    });
    expect(phase.overallStatus).toBe('all-success');
    expect(phase.successStoryIds).toEqual(['s1', 's2']);
    expect(phase.overallTestStats).toMatchObject({
      totalTests: 10,
      passedTests: 10,
      failedTests: 0,
    });
    expect(phase.overallTestStats.passRate).toBe(1);
    expect(phase.totalStories).toBe(2);
  });

  it('部分成功 → partial-success，失败故事带原因', () => {
    const results = [
      makeResult({ storyId: 's1' }),
      makeResult({ storyId: 's2', status: 'failed', issues: ['无法实现状态 X'] }),
    ];
    const phase = aggregateCodingResults(results, {
      id: 'p',
      instanceId: 'i',
      designDocId: 'd',
    });
    expect(phase.overallStatus).toBe('partial-success');
    expect(phase.failedStories).toEqual([{ storyId: 's2', reason: '无法实现状态 X' }]);
    expect(hasAnySuccessStory(phase)).toBe(true);
  });

  it('全部失败 → all-failed，且不可进入 CR', () => {
    const results = [
      makeResult({ storyId: 's1', status: 'failed', issues: ['e1'] }),
      makeResult({ storyId: 's2', status: 'failed' }),
    ];
    const phase = aggregateCodingResults(results, { id: 'p', instanceId: 'i', designDocId: 'd' });
    expect(phase.overallStatus).toBe('all-failed');
    expect(phase.failedStories[1].reason).toBe('编码失败'); // 缺 issues 时的兜底原因
    expect(hasAnySuccessStory(phase)).toBe(false);
  });

  it('跨故事同路径文件去重，保留最后一次生成版本', () => {
    const results = [
      makeResult({
        storyId: 's1',
        files: [
          { path: 'src/a.ts', type: 'util', operation: 'create', summary: 'v1', content: 'v1' },
          { path: 'src/b.ts', type: 'util', operation: 'create', summary: 'b', content: 'b' },
        ],
      }),
      makeResult({
        storyId: 's2',
        files: [
          { path: 'src/a.ts', type: 'util', operation: 'modify', summary: 'v2', content: 'v2' },
        ],
      }),
    ];
    const phase = aggregateCodingResults(results, { id: 'p', instanceId: 'i', designDocId: 'd' });
    expect(phase.allFiles.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(phase.allFiles.find((f) => f.path === 'src/a.ts')?.content).toBe('v2');
  });

  it('topoSortStories：被依赖的故事排在前面', () => {
    const a = makeStory('a');
    const b = makeStory('b', ['a']);
    const c = makeStory('c', ['b']);
    expect(topoSortStories([c, b, a]).sorted.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('topoSortStories：循环依赖时保底不卡死、不丢故事，并返回 cyclicStoryIds', () => {
    const a = makeStory('a', ['b']);
    const b = makeStory('b', ['a']);
    const result = topoSortStories([a, b]);
    expect(result.sorted.map((s) => s.id).sort()).toEqual(['a', 'b']);
    expect(result.cyclicStoryIds.sort()).toEqual(['a', 'b']);
  });
});
