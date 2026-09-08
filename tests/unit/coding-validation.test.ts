import { describe, it, expect } from 'vitest';
import {
  findMissingTestedAcs,
  coveredAcsFromMapping,
  mergeGeneratedFiles,
  deriveStoryStatus,
} from '../../src/core/coding-validation';
import type { CodingTask } from '../../src/types/coding-task';

function taskWithAcs(ids: Array<{ id: string; testable: boolean }>): CodingTask {
  return {
    acceptanceCriteria: ids.map((x) => ({
      id: x.id,
      given: [],
      when: '',
      then: [],
      scenarioType: 'normal',
      testable: x.testable,
    })),
  } as unknown as CodingTask;
}

describe('coding-validation', () => {
  it('findMissingTestedAcs：只统计可测试 AC，已覆盖的不报', () => {
    const task = taskWithAcs([
      { id: 'ac1', testable: true },
      { id: 'ac2', testable: true },
      { id: 'ac3', testable: false }, // 不可测试，不要求覆盖
    ]);
    expect(findMissingTestedAcs(task, ['ac1'])).toEqual(['ac2']);
    expect(findMissingTestedAcs(task, ['ac1', 'ac2'])).toEqual([]);
  });

  it('coveredAcsFromMapping：值为空数组不算覆盖', () => {
    expect(coveredAcsFromMapping({ ac1: ['t1'], ac2: [] })).toEqual(['ac1']);
  });

  it('mergeGeneratedFiles：同路径以后者覆盖并排序', () => {
    const merged = mergeGeneratedFiles(
      [{ path: 'b.ts', type: 'util', operation: 'create', summary: '1', content: '1' }],
      [
        { path: 'a.ts', type: 'util', operation: 'create', summary: 'a', content: 'a' },
        { path: 'b.ts', type: 'util', operation: 'modify', summary: '2', content: '2' },
      ],
    );
    expect(merged.map((f) => f.path)).toEqual(['a.ts', 'b.ts']);
    expect(merged.find((f) => f.path === 'b.ts')?.content).toBe('2');
  });

  it('deriveStoryStatus：未过 failed、过但缺 AC partial、全过 success', () => {
    expect(
      deriveStoryStatus({ greenPassed: false, missingAcIds: [], attemptsExhausted: true }),
    ).toBe('failed');
    expect(
      deriveStoryStatus({ greenPassed: true, missingAcIds: ['ac2'], attemptsExhausted: false }),
    ).toBe('partial');
    expect(
      deriveStoryStatus({ greenPassed: true, missingAcIds: [], attemptsExhausted: false }),
    ).toBe('success');
  });
});
