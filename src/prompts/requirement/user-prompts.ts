/**
 * 需求分析 Agent - 用户提示词模板（含变量替换）
 */

import type { StructuredRequirement } from '../../types/requirement';

/** 需求澄清阶段的用户提示词变量 */
export interface ClarificationPromptVars {
  source: string;
  prdText: string;
}

/** 渲染需求澄清用户提示词 */
export function renderClarificationUserPrompt(vars: ClarificationPromptVars): string {
  return `请分析以下 PRD 文档，输出结构化需求。

PRD 来源：${vars.source}

PRD 内容：
"""
${vars.prdText}
"""

请按以下结构输出 JSON：
{
  "meta": { "title": "", "source": "", "version": "" },
  "businessGoals": [{ "id": "", "description": "", "priority": "P0|P1|P2", "successMetrics": [] }],
  "roles": [{ "id": "", "name": "", "description": "", "coreNeeds": [] }],
  "features": [{ "id": "", "name": "", "description": "", "module": "", "relatedRoleIds": [], "relatedGoalIds": [], "priority": "P0|P1|P2", "hasExceptionFlow": false, "notes": "" }],
  "businessRules": [{ "id": "", "description": "", "type": "validation|calculation|permission|workflow|display|other", "relatedFeatureIds": [] }],
  "nonFunctionalRequirements": [{ "id": "", "category": "performance|compatibility|security|accessibility|i18n|reliability|other", "description": "" }],
  "globalRequirements": [{ "id": "", "category": "authentication|authorization|navigation|layout|error-handling|other", "description": "", "inScope": true, "source": "existing|new", "discoveredInClarification": false }],
  "trackingRequirements": [],
  "clarificationLog": [{ "id": "", "question": "", "category": "missing|ambiguous|contradictory|detail|global-requirement", "priority": "blocking|important|minor", "status": "pending" }]
}

注意：
- clarificationLog 中列出所有需要澄清的问题，status 统一为 "pending"
- 如果发现全局需求缺失，在 globalRequirements 中标记 source: "new", discoveredInClarification: true
- 非功能需求如果 PRD 中没有明确说明，也要列出常见的并标记需要确认
- frozen 字段由系统后续填充，不需要输出`;
}

/** 用户故事拆解阶段的用户提示词变量 */
export interface StoryPromptVars {
  requirement: StructuredRequirement;
}

/** 渲染用户故事拆解用户提示词 */
export function renderStoryUserPrompt(vars: StoryPromptVars): string {
  const req = vars.requirement;

  const businessGoals = req.businessGoals
    .map((g) => `- [${g.priority}] ${g.description}`)
    .join('\n');
  const roles = req.roles.map((r) => `- ${r.name}: ${r.description}`).join('\n');
  const features = req.features
    .map((f) => `- [${f.priority}] ${f.name}（模块: ${f.module}）: ${f.description}`)
    .join('\n');
  const rules = req.businessRules.map((r) => `- [${r.type}] ${r.description}`).join('\n');
  const nfrs = req.nonFunctionalRequirements
    .map((n) => `- [${n.category}] ${n.description}`)
    .join('\n');

  return `请将以下结构化需求拆解为用户故事。

需求标题：${req.meta.title}

业务目标：
${businessGoals}

角色：
${roles}

功能点：
${features}

业务规则：
${rules}

非功能需求：
${nfrs}

请按以下结构输出 JSON：
{
  "stories": [{
    "id": "",
    "title": "",
    "description": { "role": "", "action": "", "benefit": "" },
    "acceptanceCriteria": [{
      "id": "",
      "given": [],
      "when": "",
      "then": [],
      "scenarioType": "normal|exception|boundary|permission",
      "testable": true
    }],
    "priority": "P0|P1|P2",
    "dependencies": [],
    "relatedFeatureIds": [],
    "relatedRuleIds": [],
    "type": "feature|bugfix|enhancement|technical|non-functional",
    "hasExceptionFlow": false
  }],
  "storyMap": [{ "groupName": "", "description": "", "storyIds": [], "order": 0 }],
  "nfrMapping": [{ "nfrId": "", "storyIds": [], "implementationNote": "", "requiresDesignAttention": false }],
  "qualityCheck": {
    "invest": {
      "independent": true,
      "negotiable": true,
      "valuable": true,
      "estimable": true
    }
  }
}

其中 qualityCheck.invest 请按 INVEST 原则对整组故事做自评估（small/testable 由系统自动计算，无需输出）：
- independent：故事之间是否可独立交付（无不合理的强耦合）
- negotiable：故事是否是可协商的需求描述而非写死的实现
- valuable：每个故事是否对用户/业务有明确价值
- estimable：故事是否可估算工作量（范围清晰）
不满足时对应字段填 false，不得一律填 true。

注意：
- 每个故事至少有 2 条验收标准（1 条正常 + 1 条异常/边界）
- 故事之间的依赖关系要明确
- 故事地图按用户旅程排序`;
}
