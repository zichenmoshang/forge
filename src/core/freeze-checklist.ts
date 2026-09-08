/**
 * 需求冻结质量门（纯函数）
 *
 * 冻结 checklist 必须按需求产物的实际内容逐项计算，禁止硬编码 true。
 * 语义上无法纯程序判定的项（规则是否有歧义、全局需求是否覆盖完整），
 * 以"是否仍存在对应类别的阻塞级澄清问题"作为代理判据：
 * - rulesNoAmbiguity：无 ambiguous/contradictory 类阻塞问题
 * - globalRequirementsCovered：无 global-requirement 类阻塞问题
 */

import type { StructuredRequirement, FreezeChecklist } from '../types/requirement';

/**
 * 根据当前需求产物计算冻结 checklist。
 * 不修改入参，返回新对象。
 */
export function buildFreezeChecklist(req: StructuredRequirement): FreezeChecklist {
  const hasPending = req.clarificationLog.some((q) => q.status === 'pending');
  // 歧义类阻塞问题：ambiguous / contradictory
  const pendingAmbiguityBlocking = req.clarificationLog.some(
    (q) =>
      q.status === 'pending' &&
      q.priority === 'blocking' &&
      (q.category === 'ambiguous' || q.category === 'contradictory'),
  );
  // 全局需求类阻塞问题
  const pendingGlobalRequirementBlocking = req.clarificationLog.some(
    (q) =>
      q.status === 'pending' && q.priority === 'blocking' && q.category === 'global-requirement',
  );

  return {
    businessGoalsClear: req.businessGoals.length > 0,
    rolesComplete: req.roles.length > 0,
    featuresNoMissing: req.features.length > 0,
    // 歧义无法直接判定，以无 ambiguous/contradictory 类阻塞级待澄清问题为代理
    rulesNoAmbiguity: !pendingAmbiguityBlocking,
    nfrDefined: req.nonFunctionalRequirements.length > 0,
    // 全局需求缺失会在澄清环节提出，以无 global-requirement 类阻塞问题为代理
    globalRequirementsCovered: !pendingGlobalRequirementBlocking,
    trackingProvided: req.trackingRequirements.length > 0,
    allClarificationsResolved: !hasPending,
  };
}

/** checklist 是否全部通过（任一 false 即不满足冻结质量门） */
export function isFreezeChecklistPassed(checklist: FreezeChecklist): boolean {
  return Object.values(checklist).every(Boolean);
}
