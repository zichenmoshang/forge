/**
 * 技术方案覆盖度与 API 确认的程序化计算（规范 1.14：质量门禁止硬编码通过）
 *
 * DesignAgent 不采信 LLM 自报的 coverageCheck / apiConfirmation，
 * 由本模块依据"故事 AC ↔ 组件 relatedAcIds"的真实引用关系现算。
 *
 * 覆盖口径（第七轮后方案 A 确认）：
 * - 以全部组件节点 relatedAcIds 的并集作为"已覆盖 AC 集合"
 * - 一个故事的全部 AC 都被覆盖，该故事才算 covered
 * - 异常覆盖按基础异常类别（加载/空态/错误/网络）是否在 exceptionScenarios 出现判定
 */

import type {
  ComponentNode,
  ApiContract,
  ExceptionScenario,
  DesignCoverageCheck,
  ApiConfirmation,
} from '../types/frontend-design';
import type { UserStorySet } from '../types/user-story';

/** 方案覆盖度检查至少应覆盖的基础异常类别 */
const BASE_EXCEPTION_TYPES: Array<{ key: ExceptionScenario['type']; label: string }> = [
  { key: 'loading', label: '加载中' },
  { key: 'empty-state', label: '空状态' },
  { key: 'error', label: '错误态' },
  { key: 'network', label: '网络异常' },
];

/** LLM 产出的方案业务字段（元数据由系统补全前的最小结构） */
export interface DesignBusinessFields {
  pages: Array<{ relatedStoryIds?: string[] }>;
  componentTree: ComponentNode[];
  apiContracts: ApiContract[];
  exceptionScenarios: ExceptionScenario[];
}

/**
 * 计算方案覆盖度。纯函数，不修改入参。
 */
export function buildDesignCoverage(
  design: DesignBusinessFields,
  stories: UserStorySet,
): DesignCoverageCheck {
  // 1. 组件覆盖的 AC 集合
  const coveredAcIds = new Set<string>();
  for (const comp of design.componentTree) {
    for (const acId of comp.relatedAcIds ?? []) coveredAcIds.add(acId);
  }

  // 2. AC 覆盖
  const allAcIds: string[] = [];
  const storyAllAcs = new Map<string, string[]>();
  for (const story of stories.stories) {
    const acIds = story.acceptanceCriteria.map((ac) => ac.id);
    allAcIds.push(...acIds);
    storyAllAcs.set(story.id, acIds);
  }
  const uncoveredAcIds = allAcIds.filter((id) => !coveredAcIds.has(id));

  // 3. 故事覆盖：故事的全部 AC 被覆盖才算 covered（设计口径，无 componentTouched 兼容）
  // #50 修复：原代码第二个条件 componentTouched && acIds.every(...) 与 allCovered 核心判断相同，
  // 被同一个表达式短路，componentTouched 从未生效。删除冗余分支，保持设计口径清晰。
  const uncoveredStoryIds: string[] = [];
  for (const story of stories.stories) {
    const acIds = storyAllAcs.get(story.id) ?? [];
    const allCovered = acIds.length > 0 && acIds.every((id) => coveredAcIds.has(id));
    if (!allCovered) {
      uncoveredStoryIds.push(story.id);
    }
  }

  // 4. 异常场景覆盖
  const presentTypes = new Set(design.exceptionScenarios.map((e) => e.type));
  const checklist = BASE_EXCEPTION_TYPES.map(({ key, label }) => ({
    item: label,
    covered: presentTypes.has(key),
  }));
  const exceptionPassed = checklist.every((c) => c.covered);

  // 5. 汇总
  const issues: string[] = [];
  if (uncoveredStoryIds.length > 0) {
    issues.push(
      `有 ${uncoveredStoryIds.length} 个故事未被组件完整覆盖: ${uncoveredStoryIds.join(', ')}`,
    );
  }
  if (uncoveredAcIds.length > 0) {
    issues.push(
      `有 ${uncoveredAcIds.length} 条验收标准未被任何组件覆盖: ${uncoveredAcIds.join(', ')}`,
    );
  }
  const missingExceptionLabels = checklist.filter((c) => !c.covered).map((c) => c.item);
  if (missingExceptionLabels.length > 0) {
    issues.push(`缺少基础异常场景: ${missingExceptionLabels.join('、')}`);
  }

  const storyPassed = uncoveredStoryIds.length === 0;
  const acPassed = uncoveredAcIds.length === 0;

  return {
    storyCoverage: {
      totalStories: stories.stories.length,
      coveredStories: stories.stories.length - uncoveredStoryIds.length,
      uncoveredStoryIds,
    },
    acCoverage: {
      totalACs: allAcIds.length,
      coveredACs: allAcIds.length - uncoveredAcIds.length,
      uncoveredAcIds,
    },
    exceptionCoverage: {
      checklist,
      passed: exceptionPassed,
    },
    passed: storyPassed && acPassed && exceptionPassed,
    issues,
  };
}

/**
 * 根据 API 契约来源初始化 API 确认状态（纯函数）。
 * 新增/修改的契约必须经人工在 API_CONFIRMATION 硬卡点确认；全部复用时无需确认。
 */
export function buildApiConfirmation(apiContracts: ApiContract[]): ApiConfirmation {
  const pendingApiIds = apiContracts
    .filter((api) => api.source === 'new' || api.source === 'modified')
    .map((api) => api.id);
  const required = pendingApiIds.length > 0;
  return {
    required,
    pendingApiIds,
    status: required ? 'pending' : 'not-required',
  };
}
