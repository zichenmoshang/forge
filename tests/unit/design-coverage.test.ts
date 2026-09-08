import { describe, it, expect } from 'vitest';
import { buildDesignCoverage, buildApiConfirmation } from '../../src/core/design-coverage';
import type { UserStorySet } from '../../src/types/user-story';
import type {
  ComponentNode,
  ApiContract,
  ExceptionScenario,
} from '../../src/types/frontend-design';

function createStorySet(): UserStorySet {
  return {
    id: 'stories-1',
    instanceId: '',
    requirementId: 'req-1',
    version: 1,
    stories: [
      {
        id: 's1',
        title: '故事1',
        description: { role: '用户', action: '操作1', benefit: '收益1' },
        acceptanceCriteria: [
          {
            id: 'ac1',
            given: [],
            when: 'w1',
            then: ['t1'],
            scenarioType: 'normal',
            testable: true,
          },
          {
            id: 'ac2',
            given: [],
            when: 'w2',
            then: ['t2'],
            scenarioType: 'exception',
            testable: true,
          },
        ],
        priority: 'P0',
        dependencies: [],
        relatedFeatureIds: ['f1'],
        relatedRuleIds: [],
        type: 'feature',
        hasExceptionFlow: true,
      },
      {
        id: 's2',
        title: '故事2',
        description: { role: '用户', action: '操作2', benefit: '收益2' },
        acceptanceCriteria: [
          {
            id: 'ac3',
            given: [],
            when: 'w3',
            then: ['t3'],
            scenarioType: 'normal',
            testable: true,
          },
        ],
        priority: 'P1',
        dependencies: [],
        relatedFeatureIds: ['f1'],
        relatedRuleIds: [],
        type: 'feature',
        hasExceptionFlow: false,
      },
    ],
    storyMap: [],
    nfrMapping: [],
    qualityCheck: {
      invest: {
        independent: true,
        negotiable: true,
        valuable: true,
        estimable: true,
        small: true,
        testable: true,
      },
      perStory: [],
      acceptanceCriteriaStats: { total: 3, testable: 3, notTestable: 0 },
      featureCoverage: { totalFeatures: 1, coveredFeatures: 1, uncoveredFeatureIds: [] },
      passed: true,
      issues: [],
    },
    confirmation: { confirmedBy: 'ai-self-check', confirmedAt: '', version: 1 },
    createdAt: '',
    updatedAt: '',
  };
}

const ALL_EXCEPTION_TYPES: ExceptionScenario['type'][] = [
  'loading',
  'empty-state',
  'error',
  'network',
];

function makeExceptionScenarios(): ExceptionScenario[] {
  return ALL_EXCEPTION_TYPES.map((t) => ({
    id: `ex-${t}`,
    type: t,
    relatedComponentIds: ['c1'],
    trigger: '',
    behavior: '',
    implementation: '',
    needsDesign: false,
    status: 'covered',
  }));
}

function makeComponent(acIds: string[], storyIds: string[]): ComponentNode {
  return {
    id: 'c1',
    name: '组件',
    type: 'feature',
    filePath: 'src/C1.tsx',
    description: '',
    props: [],
    children: [],
    relatedStoryIds: storyIds,
    relatedAcIds: acIds,
    reuseStatus: 'new',
  };
}

describe('design-coverage 覆盖度程序计算', () => {
  it('全部 AC 被组件覆盖且基础异常齐全时 passed=true', () => {
    const coverage = buildDesignCoverage(
      {
        pages: [],
        componentTree: [makeComponent(['ac1', 'ac2', 'ac3'], ['s1', 's2'])],
        apiContracts: [],
        exceptionScenarios: makeExceptionScenarios(),
      },
      createStorySet(),
    );
    expect(coverage.acCoverage.totalACs).toBe(3);
    expect(coverage.acCoverage.coveredACs).toBe(3);
    expect(coverage.acCoverage.uncoveredAcIds).toEqual([]);
    expect(coverage.storyCoverage.coveredStories).toBe(2);
    expect(coverage.exceptionCoverage.passed).toBe(true);
    expect(coverage.passed).toBe(true);
  });

  it('漏覆盖 ac2 时程序识别且 passed=false（不采信 LLM）', () => {
    const coverage = buildDesignCoverage(
      {
        pages: [],
        componentTree: [makeComponent(['ac1', 'ac3'], ['s1', 's2'])],
        apiContracts: [],
        exceptionScenarios: makeExceptionScenarios(),
      },
      createStorySet(),
    );
    expect(coverage.acCoverage.uncoveredAcIds).toEqual(['ac2']);
    expect(coverage.storyCoverage.uncoveredStoryIds).toContain('s1');
    expect(coverage.passed).toBe(false);
    expect(coverage.issues.join('')).toContain('ac2');
  });

  it('缺少 network 异常场景时 exceptionCoverage.passed=false', () => {
    const coverage = buildDesignCoverage(
      {
        pages: [],
        componentTree: [makeComponent(['ac1', 'ac2', 'ac3'], ['s1', 's2'])],
        apiContracts: [],
        exceptionScenarios: makeExceptionScenarios().filter((e) => e.type !== 'network'),
      },
      createStorySet(),
    );
    expect(coverage.exceptionCoverage.passed).toBe(false);
    expect(coverage.passed).toBe(false);
  });

  it('多个组件的 relatedAcIds 取并集', () => {
    const coverage = buildDesignCoverage(
      {
        pages: [],
        componentTree: [
          makeComponent(['ac1'], ['s1']),
          { ...makeComponent(['ac2', 'ac3'], ['s1', 's2']), id: 'c2' },
        ],
        apiContracts: [],
        exceptionScenarios: makeExceptionScenarios(),
      },
      createStorySet(),
    );
    expect(coverage.acCoverage.uncoveredAcIds).toEqual([]);
    expect(coverage.passed).toBe(true);
  });
});

describe('buildApiConfirmation', () => {
  function api(id: string, source: ApiContract['source']): ApiContract {
    return {
      id,
      name: id,
      method: 'GET',
      path: `/${id}`,
      description: '',
      request: {},
      response: { success: { httpStatus: 200, fields: [] } },
      relatedStoryIds: [],
      relatedComponentIds: [],
      source,
    };
  }

  it('存在新增/修改 API 时 required=true 且列出待确认', () => {
    const confirmation = buildApiConfirmation([
      api('a1', 'new'),
      api('a2', 'modified'),
      api('a3', 'reused'),
    ]);
    expect(confirmation.required).toBe(true);
    expect(confirmation.pendingApiIds.sort()).toEqual(['a1', 'a2']);
    expect(confirmation.status).toBe('pending');
  });

  it('全部复用时 not-required', () => {
    const confirmation = buildApiConfirmation([api('a3', 'reused')]);
    expect(confirmation.required).toBe(false);
    expect(confirmation.status).toBe('not-required');
  });
});
