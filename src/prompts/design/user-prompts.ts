/**
 * 方案设计 Agent - 用户提示词模板（含变量替换）
 */

import type { StructuredRequirement } from '../../types/requirement';
import type { UserStorySet, UserStory } from '../../types/user-story';
import type { KnowledgeItem } from '../../types/knowledge';
import type { GlobalContext } from '../../agents/types';
import type { FrontendDesignDoc } from '../../types/frontend-design';
import type { ReviewIssue } from '../../types/review-and-delivery';

/** 技术方案生成阶段的用户提示词变量 */
export interface DesignGeneratePromptVars {
  requirement: StructuredRequirement;
  stories: UserStorySet;
  /** 全局技术约束（技术栈、团队规范） */
  globalContext?: GlobalContext;
  /** Agent 内部多路检索到的知识 */
  knowledge: KnowledgeItem[];
  /** Figma 引用摘要（外部依赖；不可用时说明原因） */
  figmaSummary?: string;
}

/** 渲染单个用户故事的精简文本 */
function renderStory(story: UserStory): string {
  const ac = story.acceptanceCriteria
    .map(
      (c) =>
        `    - [${c.scenarioType}] ${c.id}: Given ${c.given.join('/')} When ${c.when} Then ${c.then.join('/')}`,
    )
    .join('\n');
  return `  - ${story.id} [${story.priority}] ${story.title}（类型 ${story.type}，依赖 ${story.dependencies.join(',') || '无'}）
${ac}`;
}

/** 渲染知识库检索结果 */
function renderKnowledge(knowledge: KnowledgeItem[]): string {
  if (knowledge.length === 0) return '（本次未检索到可复用的团队知识）';
  return knowledge
    .map(
      (k, i) =>
        `[${i + 1}] (${k.type}/${k.projectScope}) ${k.title} —— ${k.summary || k.content.slice(0, 200)}（来源 ${k.sourceRef}）`,
    )
    .join('\n');
}

/** 渲染技术方案生成用户提示词 */
export function renderDesignGenerateUserPrompt(vars: DesignGeneratePromptVars): string {
  const { requirement, stories, globalContext, knowledge } = vars;

  const constraints: string[] = [];
  if (globalContext?.techStack) constraints.push(`技术栈约束：${globalContext.techStack}`);
  if (globalContext?.codingStandards)
    constraints.push(`编码规范：${globalContext.codingStandards}`);
  if (globalContext?.constraints?.length)
    constraints.push(`其他约束：${globalContext.constraints.join('；')}`);

  const nfrs = requirement.nonFunctionalRequirements
    .map((n) => `- [${n.category}] ${n.id}: ${n.description}`)
    .join('\n');
  const globalReqs = requirement.globalRequirements
    .map((g) => `- [${g.category}] ${g.description}（${g.inScope ? '在范围内' : '不在范围'}）`)
    .join('\n');
  const storyText = stories.stories.map(renderStory).join('\n');

  return `请基于以下已冻结需求和用户故事，设计前端技术方案。

需求标题：${requirement.meta.title}

## 全局技术约束（必须遵循）
${constraints.length > 0 ? constraints.join('\n') : '（未提供额外约束，按业界最佳实践）'}

## 非功能需求（必须逐条给出落地方案）
${nfrs || '（无）'}

## 全局需求（登录/权限/导航/错误处理等）
${globalReqs || '（无）'}

## 用户故事与验收标准（组件必须覆盖每一条 AC）
${storyText}

## Figma 设计稿
${vars.figmaSummary ?? '（本次未提供可用 Figma 设计稿，figmaReference.available=false，并在异常场景中标注 needs-design）'}

## 知识库检索结果（优先复用其中的组件/API/模式）
${renderKnowledge(knowledge)}

请输出严格 JSON，结构如下（只输出业务字段，元数据由系统填充）：
{
  "techStack": {
    "source": "detected|suggested",
    "framework": { "name": "", "version": "" },
    "language": "TypeScript|JavaScript",
    "stateManagement": { "library": "", "version": "" },
    "uiLibrary": { "name": "", "version": "" },
    "testing": { "framework": "", "version": "" },
    "buildTool": "",
    "additionalDependencies": []
  },
  "figmaReference": {
    "available": false,
    "unavailableReason": "",
    "frames": [],
    "componentMappings": []
  },
  "pages": [{
    "id": "", "name": "", "route": "", "routeParams": [], "description": "",
    "relatedStoryIds": [], "componentIds": [], "pageState": [],
    "permission": { "required": false, "roles": [] },
    "responsive": { "required": false, "breakpoints": [] }
  }],
  "componentTree": [{
    "id": "", "name": "", "type": "page|layout|container|feature|ui|hook|util",
    "filePath": "", "description": "",
    "props": [{ "name": "", "type": "", "required": false, "defaultValue": "", "description": "" }],
    "emits": [], "children": [],
    "relatedStoryIds": [], "relatedAcIds": [], "internalState": [], "hooks": [],
    "reuseStatus": "new|reuse|modify", "existingComponentRef": "", "exceptionHandling": []
  }],
  "stateManagement": {
    "principle": "",
    "globalStores": [{ "name": "", "description": "", "state": [], "actions": [], "relatedComponentIds": [] }],
    "serverState": { "library": "", "managedData": [] },
    "crossPageState": []
  },
  "dataModels": [{
    "name": "", "description": "", "typeDefinition": "",
    "fields": [{ "name": "", "type": "", "required": false, "description": "" }],
    "source": "api-response|api-request|local-state|form|shared", "relatedApiIds": []
  }],
  "apiContracts": [{
    "id": "", "name": "", "method": "GET|POST|PUT|DELETE|PATCH", "path": "", "description": "",
    "request": { "pathParams": [], "queryParams": [], "body": [], "bodyType": "" },
    "response": {
      "success": { "httpStatus": 200, "fields": [], "pagination": {} },
      "error": [{ "code": "", "message": "", "httpStatus": 0, "handling": "toast|page-error|inline|retry|ignore" }],
      "responseType": ""
    },
    "relatedStoryIds": [], "relatedComponentIds": [],
    "source": "reused|new|modified", "knowledgeRef": ""
  }],
  "exceptionScenarios": [{
    "id": "", "type": "empty-state|loading|error|network|validation|permission|boundary|concurrency|timeout|other",
    "relatedComponentIds": [], "relatedStoryIds": [], "relatedAcIds": [],
    "trigger": "", "behavior": "", "implementation": "",
    "needsDesign": false, "status": "covered|needs-design"
  }],
  "nfrSolutions": [{
    "nfrId": "", "category": "", "solution": "", "measures": [],
    "relatedComponentIds": [], "verification": ""
  }],
  "reusableComponents": [{
    "existingName": "", "location": "", "usage": "direct|with-props|modify", "usedBy": [], "note": ""
  }],
  "directoryStructure": { "name": "", "type": "directory|file", "path": "", "children": [] }
}

注意：
- componentTree 中每个组件的 relatedAcIds 必须真实覆盖到上文每条验收标准 ID，系统会据此程序计算覆盖度，漏覆盖会被拦截
- 状态管理必须明确划分全局 store 与组件局部状态，不得留空 principle
- 复用知识库已有能力时，apiContracts.source 标 reused 并填 knowledgeRef，组件 reuseStatus 标 reuse/modify 并填 existingComponentRef`;
}

/** 方案修订（revise）阶段的用户提示词变量 */
export interface DesignRevisePromptVars {
  /** 上一版完整方案 */
  previousDesign: FrontendDesignDoc;
  /** 上一轮遗留 open 问题 */
  previousIssues: ReviewIssue[];
  /** 当前评审轮次 */
  round: number;
}

/** 渲染方案修订用户提示词 */
export function renderDesignReviseUserPrompt(vars: DesignRevisePromptVars): string {
  const { previousDesign: d, previousIssues, round } = vars;
  const issueText = previousIssues
    .map(
      (i) =>
        `- ${i.issueId}[${i.severity}${i.blocking ? '/blocking' : ''}/${i.category}] ${i.description}` +
        `（位置：${i.location?.target ?? '未指明'}；修改建议：${i.suggestion}）`,
    )
    .join('\n');

  return `这是第 ${round} 轮评审后的方案修订。上一版方案（版本 ${d.version}）摘要如下：
- 页面：${d.pages.map((p) => `${p.id}(${p.name})`).join(', ') || '无'}
- 组件：${d.componentTree.map((c) => c.id).join(', ') || '无'}
- 状态管理原则：${d.stateManagement.principle}

## 上一轮评审问题（必须逐项回应）
${issueText || '（无）'}

【输出要求 — 增量模式，不要输出完整方案】
只输出以下部分：
1. changeSummary（必填）：本次修改的总体说明
2. changedSections（必填）：被修改的页面/组件/章节 ID 列表
3. issueResponses（必填）：对上一轮每个 open 问题的逐项回应
4. updates（可选）：只有当评审问题导致方案内容实际变更时才输出。包含需要更新的字段（如 pages、componentTree、apiContracts、stateManagement 等），每个字段输出完整的更新后数组/对象。如果没有内容变更，不要输出 updates。

示例（仅修改了 componentTree 和 apiContracts）：
{"changeSummary": "修复了用户组件的 props 定义，新增了登录 API", "changedSections": ["c-user-login", "api-login"], "issueResponses": [{"issueId": "I-001", "action": "fixed", "explanation": "已修复"}], "updates": {"componentTree": [{"id": "c-user-login", ...}, ...], "apiContracts": [{"id": "api-login", ...}, ...]}}

输出严格 JSON，不要包含解释性文字。

注意：
- updates 中只包含有变更的字段，未变更的字段不要输出（系统会自动沿用上一版）
- 如果某个字段有变更，输出该字段的完整更新后内容（不是 diff）
- coverageCheck、apiConfirmation、id/version/时间戳由系统重算，不要输出`;
}
