import { describe, it, expect } from 'vitest';
import { buildFreezeChecklist, isFreezeChecklistPassed } from '../../src/core/freeze-checklist';
import type { StructuredRequirement } from '../../src/types/requirement';

/** buildFreezeChecklist 只读取部分字段，用最小对象构造 */
function makeReq(overrides: Partial<StructuredRequirement> = {}): StructuredRequirement {
  return {
    businessGoals: [{ id: 'g', description: '目标', priority: 'P0' }],
    roles: [{ id: 'r', name: '用户', description: '用户', coreNeeds: [] }],
    features: [
      {
        id: 'f',
        name: '功能',
        description: 'd',
        module: 'm',
        relatedRoleIds: [],
        relatedGoalIds: [],
        priority: 'P0',
        hasExceptionFlow: false,
      },
    ],
    businessRules: [],
    nonFunctionalRequirements: [{ id: 'n', category: 'performance', description: '100ms' }],
    globalRequirements: [],
    trackingRequirements: [{ id: 't' } as never],
    clarificationLog: [],
    ...overrides,
  } as unknown as StructuredRequirement;
}

describe('freeze-checklist', () => {
  it('完整需求 + 无待澄清问题时全部通过', () => {
    const checklist = buildFreezeChecklist(makeReq());
    expect(checklist).toEqual({
      businessGoalsClear: true,
      rolesComplete: true,
      featuresNoMissing: true,
      rulesNoAmbiguity: true,
      nfrDefined: true,
      globalRequirementsCovered: true,
      trackingProvided: true,
      allClarificationsResolved: true,
    });
    expect(isFreezeChecklistPassed(checklist)).toBe(true);
  });

  it('缺少业务目标/角色/功能/NFR/埋点时对应项为 false（不硬编码）', () => {
    const checklist = buildFreezeChecklist(
      makeReq({
        businessGoals: [],
        roles: [],
        features: [],
        nonFunctionalRequirements: [],
        trackingRequirements: [],
      }),
    );
    expect(checklist.businessGoalsClear).toBe(false);
    expect(checklist.rolesComplete).toBe(false);
    expect(checklist.featuresNoMissing).toBe(false);
    expect(checklist.nfrDefined).toBe(false);
    expect(checklist.trackingProvided).toBe(false);
    expect(isFreezeChecklistPassed(checklist)).toBe(false);
  });

  it('存在 pending 的 blocking 澄清问题时，歧义/全局覆盖项为 false', () => {
    const checklist = buildFreezeChecklist(
      makeReq({
        clarificationLog: [
          {
            id: 'q1',
            question: '?',
            category: 'ambiguous',
            priority: 'blocking',
            status: 'pending',
          },
          {
            id: 'q2',
            question: '?',
            category: 'global-requirement',
            priority: 'blocking',
            status: 'pending',
          },
        ],
      } as Partial<StructuredRequirement>),
    );
    expect(checklist.rulesNoAmbiguity).toBe(false);
    expect(checklist.globalRequirementsCovered).toBe(false);
    expect(checklist.allClarificationsResolved).toBe(false);
  });

  it('只有 minor 待澄清问题时，阻塞代理项通过但 allClarificationsResolved 为 false', () => {
    const checklist = buildFreezeChecklist(
      makeReq({
        clarificationLog: [
          { id: 'q1', question: '?', category: 'detail', priority: 'minor', status: 'pending' },
        ],
      } as Partial<StructuredRequirement>),
    );
    expect(checklist.rulesNoAmbiguity).toBe(true);
    expect(checklist.allClarificationsResolved).toBe(false);
  });

  it('不修改入参', () => {
    const req = makeReq();
    const snapshot = JSON.stringify(req);
    buildFreezeChecklist(req);
    expect(JSON.stringify(req)).toBe(snapshot);
  });
});
