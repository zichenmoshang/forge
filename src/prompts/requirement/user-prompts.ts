/**
 * 需求分析 Agent - 用户提示词模板（含变量替换）
 */

import type { StructuredRequirement } from '../../types/requirement';
import type { KnowledgeItem } from '../../types/knowledge';

/**
 * 将检索到的知识条目格式化为可注入 prompt 的"团队知识库参考"段落（无条目返回空串）。
 * 优先用 summary（更短），回退 content；最多注入 8 条，避免 prompt 膨胀。
 */
export function formatKnowledgeSection(knowledge?: KnowledgeItem[]): string {
  if (!knowledge || knowledge.length === 0) return '';
  const body = knowledge
    .slice(0, 8)
    .map((k, i) => {
      const text = (k.summary || k.content || '').trim();
      return `[${i + 1}]（${k.type}${k.title ? ` · ${k.title}` : ''}）\n${text}`;
    })
    .join('\n\n');
  return `团队知识库参考（遵循其中的团队规范与既有约定；若与上面需求冲突，以需求为准并在澄清问题中提出）：
"""
${body}
"""

`;
}

/** 需求澄清阶段的用户提示词变量 */
export interface ClarificationPromptVars {
  source: string;
  prdText: string;
  /** 检索到的团队知识（飞书 wiki / 历史规范），可选 */
  knowledge?: KnowledgeItem[];
}

/** 渲染需求澄清用户提示词 */
export function renderClarificationUserPrompt(vars: ClarificationPromptVars): string {
  return `请分析以下 PRD 文档，输出结构化需求。

PRD 来源：${vars.source}

PRD 内容：
"""
${vars.prdText}
"""

${formatKnowledgeSection(vars.knowledge)}请按以下结构输出 JSON：
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
- 结合团队知识库：按其中规范识别缺失项（如登录权限、错误监控、状态管理约定）
- frozen 字段由系统后续填充，不需要输出`;
}

/** 用户故事拆解阶段的用户提示词变量 */
export interface StoryPromptVars {
  requirement: StructuredRequirement;
  /** 检索到的团队知识（组件/模式/历史故事），可选 */
  knowledge?: KnowledgeItem[];
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

${formatKnowledgeSection(vars.knowledge)}请按以下结构输出 JSON（只输出 stories，不要其他字段）：
{
  "stories": [{
    "id": "s1",
    "title": "简短标题",
    "description": { "role": "用户角色", "action": "想要做什么", "benefit": "获得什么价值" },
    "acceptanceCriteria": [
      "正常场景：给定...当...则...",
      "异常/边界场景：给定...当...则..."
    ],
    "priority": "P0|P1|P2",
    "relatedFeatureIds": ["f1"],
    "type": "feature|bugfix|enhancement|technical|non-functional"
  }]
}

注意：
- 每个故事**恰好 2 条**验收标准（1 条正常 + 1 条异常/边界），不要多也不要少
- 验收标准用简洁的自然语言描述（Given/When/Then 格式），不要嵌套结构
- description 的 action/benefit 各 1 句话，不要冗长
- 参考团队知识库中的既有组件与模式，保持拆分粒度与命名一致
- 只输出 stories 数组，不要输出 storyMap、nfrMapping、qualityCheck 等其他字段
- 输出简洁，避免冗余描述`;
}
