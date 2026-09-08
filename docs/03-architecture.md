# 架构设计

## 架构总览

采用 **Harness（中央编排器）+ 专业 Agent** 架构。

Harness 只做控制面（状态管理、流程控制、调度、上下文传递、异常处理），不生成任何内容。所有业务逻辑在专业 Agent 中。

```
┌──────────────────────────────────────────────────┐
│                   Harness（编排器）                 │
│  · 全局状态管理（当前阶段/产物/版本）                │
│  · 流程控制（前进/回退/循环/终止）                   │
│  · Agent 调度（什么时候调用哪个 Agent）              │
│  · 上下文传递（上游产物 → 下游输入）                 │
│  · 人工介入管理（挂起/等待/恢复/超时）               │
│  · 异常处理与兜底（重试/降级/升级）                  │
│  · 产物持久化与版本管理                             │
│  · 可观测性（日志/指标/trace）                      │
└─────────────────────┬────────────────────────────┘
                      │ 调度
        ┌─────────────┼─────────────┬─────────────┐
        ▼             ▼             ▼             ▼
  需求分析Agent   方案设计Agent    编码Agent     评审Agent
  (阶段1-2)       (阶段3)         (阶段5)       (阶段4/6)
                                                      │
                                                      ▼
                                                 交付Agent
                                                 (阶段7)
```

## Harness 设计

### 核心：状态机

Harness 本质是一个状态机执行器。整个流程建模为状态机，每个状态有：
- 进入条件
- 执行动作（调用哪个 Agent）
- 退出条件
- 异常处理
- 回退目标

### Harness 职责

| 职责 | 说明 |
|---|---|
| 状态管理 | 当前阶段、重试次数、挂起状态、产物版本指针 |
| 流程控制 | 状态流转、回退、循环、终止 |
| Agent 调度 | 根据当前状态调用对应 Agent，传递输入，接收输出 |
| 上下文管理 | 上游产物传递给下游，长上下文压缩/摘要，按需检索 |
| 人工介入 | 挂起流程、等待输入、校验输入、恢复执行、超时处理 |
| 异常处理 | 重试、降级、失败升级、兜底策略执行 |
| 产物管理 | 产物持久化、版本管理、不可变存储 |
| 可观测性 | 日志、span、指标自动采集 |

### Harness 不做什么

- 不生成内容（所有生成交给专业 Agent）
- 不做业务判断（判断由 Agent 做，Harness 执行判断结果）
- 不持有长上下文（只存状态和产物引用）
- 不直接调用 LLM（通过 Agent 间接调用）

## 专业 Agent 设计

### 通用原则

- **无状态**：Agent 不保存流程状态，每次调用接收完整输入，返回输出
- **单一职责**：每个 Agent 负责一个或几个相邻阶段
- **输入输出结构化**：严格按照 Schema，不输出自由文本
- **质量自检**：每个 Agent 输出前做自检，不满足门禁的不输出
- **可替换**：Agent 之间通过 Schema 解耦，可单独优化或替换

### Agent 列表

#### 需求分析 Agent（阶段1-2）

**职责**：
- PRD 多格式解析
- 澄清问题生成
- 非功能需求提示与整理
- 全局需求缺失检查
- 用户故事拆解 + AC 生成
- 质量自检（INVEST、AC 可测试性）

**输入**：PRD 文档、历史澄清问答
**输出**：结构化需求、用户故事列表

#### 方案设计 Agent（阶段3；阶段4对话循环中承担修改方）

**职责（生成，阶段3）**：
- 技术栈检测/建议
- Figma 设计数据消费
- 页面/路由/组件树设计
- 现有组件复用检查（检索代码索引）
- 状态管理与数据模型设计
- API 契约生成（Agent 内部检索知识库，ContextManager 不预检索）
- 异常场景补齐（checklist 驱动）
- 非功能需求落地方案

**职责（修改，阶段4评审对话循环内，ADR-014）**：
- 根据 Reviewer 上一轮 issue 逐项修改方案并输出 issueResponses
- 生成与修改是两类不同任务，使用**独立的输入/输出类型和独立方法**（generate / revise），
  不共用一个 execute 做 if 类型分发（避免重蹈 RequirementAgent 多模式分发的覆辙，见 issue #32）

**输入**：需求 + 用户故事（ContextManager 装配）、Figma 数据、Agent 内部检索的知识库/代码索引结果
**输出**：前端技术方案文档（生成）/ 方案修订版 + issueResponses（修改）

#### 编码 Agent（阶段5）

**职责**：
- 测试用例生成（基于 AC）
- Mock 数据生成（基于 API 契约）
- 实现代码生成
- 测试运行与修复循环
- 重构
- 沙箱与真实项目双环境测试

**输入**：CodingTask（Harness 从技术方案提取单故事相关部分组装）
**输出**：CodingResult（单故事）→ CodingPhaseResult（阶段汇总）

#### 评审 Agent（阶段4、阶段6 复用）

**职责**：
- 阶段4：技术方案评审
- 阶段6：代码 CR + 测试有效性审查 + 设计还原度检查

**输入**：待评审产物（方案/代码）+ 评审标准 + 对话历史（多轮模式）
**输出**：结构化评审意见（问题列表、严重程度、修改建议）+ dialogAction

**评审标准**：
- 方案评审：覆盖度、异常完整性、接口一致性、架构合理性、非功能覆盖
- 代码 CR：方案一致性、代码规范、逻辑正确性、异常处理、安全、可维护性、测试有效性

**多轮对话模式**：

评审阶段采用**状态机内嵌套角色驱动对话循环**，Reviewer 和 Designer/Coder 在同一状态内多轮交互。详见 [08-review-dialog.md](08-review-dialog.md)。

关键机制：
- Reviewer 输出 `dialogAction: 'approve' | 'request_changes' | 'request_human'`
- 通过标准（ADR-014 统一，见 `src/core/review-policy.ts`）：无 open 的 blocking issue 即通过；
  severity 为 blocker/critical 时程序化强制 blocking=true；LLM 的 dialogAction 与结构化问题冲突时以程序化判定为准
- 问题跟踪闭环：第 2 轮起 Reviewer 必须对上一轮每个 open 问题逐项给出 verification，不得遗漏
- 最大轮次：默认 3 轮，达到后暂停等人工
- 每轮修改后产物版本 +1，评审历史独立保存
- 对话历史 v1 全量传递，v2 摘要压缩；为减少自我锚定，第 2 轮起 Reviewer 输入只附上轮 issue 列表（不含其自然语言评论）

#### 交付 Agent（阶段7）

**职责**：
- Git 操作（创建分支、提交）
- 代码落地（新项目初始化/新模块新增/现有代码修改）
- 构建验证
- PR 描述自动生成
- PR 创建

**输入**：通过 CR 的代码、技术方案、用户故事
**输出**：PR 链接

## 基础设施层

Agent 之下是统一的基础设施层，所有 Agent 通过这层访问外部能力：

```
┌─────────────────────────────────────────┐
│              专业 Agent                  │
├─────────────────────────────────────────┤
│           LLM Provider 层               │
│  · 统一接口，支持多模型切换               │
│  · 自动记录 prompt/response/token       │
├─────────────────────────────────────────┤
│           Tool Layer（工具层）           │
│  · 知识库检索                            │
│  · 代码索引检索                          │
│  · 代码执行（沙箱/真实项目）              │
│  · Figma 解析                            │
│  · Git 操作                              │
│  · 文件读写                              │
├─────────────────────────────────────────┤
│           存储层                         │
│  · PostgreSQL（状态/元数据/索引）         │
│  · pgvector（向量索引）                  │
│  · 文件系统（产物内容/日志/临时文件）      │
└─────────────────────────────────────────┘
```

### LLM Provider 层

- 统一接口定义（`complete(prompt, options) -> response`）
- 多模型实现（OpenAI、Anthropic、本地模型等）
- 配置化切换，不硬编码模型
- 自动记录每次调用的完整 prompt、response、token、耗时
- 支持重试、超时、降级（大模型失败时切小模型）

### Tool Layer

所有工具调用统一封装，自动记录日志和指标。**注意：知识库检索不走 Tool 机制**，而是通过 KnowledgeService 服务层 + Agent 的 retrieveKnowledge 钩子自动注入（详见下文"知识库服务层"）。

Tool 层只包含 Agent 执行过程中的动态操作：
- 代码执行：沙箱环境（单元测试）+ 真实项目（集成测试）
- Figma 解析：API 调用 + 设计数据提取 + 图片比对
- Git 操作：分支、提交、PR 创建
- 文件读写：产物读写、代码生成

## 知识库服务层

知识库是**团队级中心化服务**，作为独立的服务层存在，不隶属于任何 Agent。所有 Agent 通过 KnowledgeService 检索知识，不直接操作向量库或 AST 解析。

### 架构定位

```
┌─────────────────────────────────────────────────────┐
│                    Harness（控制面）                   │
│  状态机 | 调度 | 上下文管理 | 异常处理 | 产物版本      │
└──────────────┬──────────────────────────────────────┘
               │
    ┌──────────▼──────────┐
    │   ContextManager     │
    │  产物装配（不做检索）  │  ADR-014：知识检索职责收归 Agent
    └──────────┬──────────┘
               │
┌──────────────▼──────────────────────────────────────┐
│                  Agent 层（数据面）                    │
│  RequirementAgent | DesignAgent | CodingAgent | ...  │
│  retrieveKnowledge 钩子 + searchKnowledge helper：   │
│  通过 AgentContext.knowledgeService 自主多路检索      │
└──────────────┬──────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────┐
│                  服务层（Services）                    │
│  ┌─────────────────┐    ┌──────────────────────┐    │
│  │ KnowledgeService│    │   CodeIndexService   │    │
│  │ 检索|入库|同步   │    │  代码符号索引         │    │
│  │ （单例）         │    │                      │    │
│  └────────┬────────┘    └──────────┬───────────┘    │
│           │                        │                │
│  ┌────────▼────────────────────────▼───────────┐    │
│  │         VectorStore（pgvector 统一操作）       │    │
│  │    knowledge_items | code_symbols            │    │
│  └─────────────────────────────────────────────┘    │
│  ┌──────────────┐  ┌──────────┐  ┌─────────────┐   │
│  │  ASTParser   │  │ FeishuSync│  │  Storage    │   │
│  │ （代码反解析）│  │ （v2）   │  │ （产物存储） │   │
│  └──────────────┘  └──────────┘  └─────────────┘   │
└─────────────────────────────────────────────────────┘
```

### KnowledgeService（单例）

**设计决策**：KnowledgeService 是**单例**，所有 Harness 实例共享。原因：知识库是团队级的，跨项目复用，不需要每个流程实例独立维护。

**核心接口**（v1 已实现）：

```typescript
interface KnowledgeService {
  // 检索：向量检索 + 元数据过滤，返回统一格式 KnowledgeItem[]
  // v1 只有向量检索，BM25 关键词检索待补充
  search(query: string, filter?: KnowledgeFilter, topK?: number): Promise<KnowledgeItem[]>;

  // 入库：代码反解析结果入库（遍历目录，AST 解析，向量化）
  indexCode(repoPath: string, projectScope?: string, techStack?: string): Promise<IndexResult>;

  // 入库：文档入库（飞书同步、手动录入），返回 { success, id }
  indexDocument(doc: KnowledgeDocument): Promise<{ success: boolean; id: string }>;

  // 增量更新（根据文件变更列表，只重新解析变更的文件）
  syncIncremental(changes: FileChange[]): Promise<IndexResult>;

  // 全量重建（清空现有数据，重新索引所有仓库）
  rebuild(repoPaths: string[]): Promise<IndexResult>;

  // 知识库统计（总数、各类型/来源分布、状态分布）
  getStatus(): Promise<KnowledgeStatus>;

  // 权重调整（使用反馈闭环，返回是否成功）
  updateWeight(id: string, delta: number): Promise<boolean>;

  // 单例获取/重置
  static getInstance(config?: KnowledgeServiceConfig): KnowledgeService;
  static resetInstance(): void;
}
```

> 注：`searchWithCodeIndex`（联合检索）设计中预留，v1 未实现，代码索引服务独立后再接入。

### KnowledgeItem（统一格式）

**设计决策**：所有检索结果使用统一的 `KnowledgeItem` 格式，Agent 自己根据 `type` 字段分类处理。

```typescript
interface KnowledgeItem {
  id: string;
  type: 'api' | 'component' | 'model' | 'design' | 'spec' | 'exception' | 'pattern' | 'doc' | 'clarification' | 'story';
  title: string;
  content: string;           // 完整内容（结构化 JSON 或文本）
  summary: string;           // 摘要（用于 prompt 注入）
  source: 'code' | 'pr' | 'feishu' | 'manual';
  sourceRef: string;         // 来源引用（文件路径/PR号/飞书文档ID）
  projectScope: 'global' | string;  // global=团队通用，其他=项目特定
  techStack?: string;        // 技术栈标签
  businessDomain?: string;   // 业务域标签
  weight: number;            // 动态权重（0-1）
  status: 'active' | 'deprecated' | 'removed';
  relevanceScore?: number;   // 检索时的相关性得分
}
```

### Agent 检索增强机制

BaseAgent 增加 `retrieveKnowledge` 钩子，在 `buildUserPrompt` 之前调用：

```
validateInput
  ↓
retrieveKnowledge(input)  ← 新增钩子：根据输入检索相关知识
  ↓
buildSystemPrompt
  ↓
buildUserPrompt(input, knowledge)  ← 注入检索结果
  ↓
callLLM
  ↓
parseOutput → validateOutput → selfCheck
```

**各 Agent 的检索策略**：

| Agent | retrieveKnowledge | 检索内容 | 检索时机 |
|---|---|---|---|
| RequirementAgent（clarify） | ✅ v2 | 历史澄清问题、全局需求清单、技术规范 | 阶段开始时一次 |
| RequirementAgent（stories） | ✅ v2 | 历史故事结构、AC 写法模式 | 阶段开始时一次 |
| DesignAgent | ✅ 已实现 | 组件/模式、API/模型、规范/异常三路并行 | **Agent 内部按需多路检索（retrieveKnowledge）** |
| CodingAgent | ✅ v1 | 代码模式、异常处理模式、组件用法 | Agent 内部按需检索 |
| ReviewAgent | ✅ 已实现（不检索） | 评审对照被评审产物即可，v1 不查知识库 | - |
| DeliveryAgent | ❌ | 交付不需要检索知识库 | - |

**设计决策（ADR-014 最终版）**：知识库检索**完全由 Agent 内部控制**——检索时机、query 构造、分几路检索都是 Agent 的业务逻辑。ContextManager **不做任何知识库检索**，只负责从产物存储装配上游产物；KnowledgeService 通过 `AgentContext.knowledgeService` 注入，BaseAgent 提供 `searchKnowledge()` helper 封装多路并行检索、projectScope 过滤和按 id 去重。这样避免"ContextManager 预检索 + Agent 再检索"的重复与职责重叠。

### ContextManager 职责（ADR-014 收敛）

ContextManager 只做**产物装配**：

```
ContextManager.buildAgentInput(state, instanceId, extra)
  └─ 从 ArtifactStore 读取上游产物，组装成 Agent 输入（同步、无知识库调用）
```

AgentContext 中与知识相关的字段：
```typescript
interface AgentContext {
  instanceId: string;
  stage: string;
  input: unknown;
  knowledge?: KnowledgeItem[];        // 一般为空（兼容字段，保留给外部预注入场景）
  knowledgeService?: KnowledgeService; // ADR-014：服务注入，Agent 在 retrieveKnowledge 中自主检索
  projectId?: string;                  // 检索时 projectScope 过滤（当前项目 + global）
}
```

> 历史说明：早期设计曾让 ContextManager 在 DESIGN_GENERATING 做 4 路并行预检索，
> 第六轮架构审查发现这与"Agent 内部按需检索"重复且职责边界模糊，已移除（ADR-014）。

### VectorStore（统一向量操作）

知识库向量和代码索引向量**共用同一个 pgvector 实例，分表存储**：
- `knowledge_items` 表：团队级知识库
- `code_symbols` 表：项目级代码索引

VectorStore 提供通用的向量操作（upsert、search、delete），KnowledgeService 和 CodeIndexService 都调用 VectorStore，但操作不同的表。

### 知识库维护独立流程

知识库的同步、重建、质量检查是**独立于流水线的后台任务**，不经过 Harness：

```bash
forge kb sync      # 增量同步代码变更（CI/cron 触发）
forge kb rebuild   # 全量重建（手动触发）
forge kb search    # 手动检索验证
forge kb status    # 查看知识库统计
```

实现方式：独立 CLI 入口，直接调用 KnowledgeService，不经过状态机。

### v1 范围

v1 需要实现知识库基础设施，用于验证 Harness 和 DesignAgent 的正确性：
- ✅ KnowledgeService 核心接口（search、indexCode、getStatus）
- ✅ VectorStore（pgvector 操作）
- ✅ ASTParser（代码反解析，至少支持 API 和组件提取）
- ✅ BaseAgent retrieveKnowledge 钩子 + searchKnowledge 多路检索 helper（ADR-014）
- ✅ DesignAgent 内部三路并行检索（组件/模式、API/模型、规范/异常，随方案生成落地）
- ✅ 知识库维护 CLI（sync/rebuild/search/status）
- ❌ 飞书文档同步（v2）
- ❌ Rerank（v2，v1 用 top K 直接注入）
- ❌ RequirementAgent 知识库检索（v2）
- ❌ 权重反馈闭环（v2，v1 权重只有初始值）

## 上下文管理策略

长流程上下文膨胀问题，采用分层策略：

1. **产物引用传递**：Harness 不传递完整产物内容，只传递产物 ID/路径，Agent 需要时按需读取
2. **按需检索**：编码阶段不加载完整技术方案，只检索当前故事相关的部分
3. **摘要压缩**：跨阶段传递时，对大产物生成摘要 + 关键细节，完整内容存文件
4. **分级上下文**：全局约束（技术栈、规范）始终携带；具体内容按需加载

### 实现状态（分阶段）

| 策略 | v1（当前） | v2（计划） |
|------|-----------|-----------|
| 产物引用传递 | ❌ 小产物直接传完整对象 | ✅ 大产物（技术方案/代码）改引用传递 |
| 按需检索 | ❌ 全量加载 | ✅ 编码阶段只加载当前故事相关部分 |
| 摘要压缩 | ❌ 无 | ✅ 大产物跨阶段传递时生成摘要 |
| 分级上下文 | ✅ 已注入（第七轮）：GlobalContext 经 AgentContext 到达每个 Agent | ✅ 全局约束始终携带，具体内容按需加载 |

**v1 说明**：当前只有需求和故事两个小产物（几 KB），直接传完整对象无性能问题。ContextManager 已封装上下文装配逻辑，v2 升级时只改 ContextManager，不动 Harness。

**ContextManager 职责**：
- 上下文装配：根据状态从产物存储读取上游产物，组装成 Agent 输入
- 全局上下文维护：技术栈、规范等约束信息
- v2 预留接口：`buildAgentInputWithRefs()`、`retrieveRelevantParts()`、`summarizeArtifact()`

## 实施顺序

1. ~~定义状态机 + 核心 Schema~~ ✅ 已完成
2. 基础设施层
   - ~~LLM Provider（OpenAI 实现 + 重试 + 日志）~~ ✅ 已完成
   - ~~结构化 Logger（按实例分文件）~~ ✅ 已完成
   - ~~知识库基础设施（KnowledgeService + VectorStore + EmbeddingProvider + ASTParser + CLI）~~ ✅ 已完成
   - [ ] Tracer / Metrics（按需补充）
   - [ ] Tool Layer（代码执行、Figma、Git；知识库检索不走 Tool，通过服务层注入）
   - [ ] 存储层（PostgreSQL + pgvector 持久化，当前内存版）
3. ~~实现 Agent 基类（模板方法模式 + retrieveKnowledge 钩子）~~ ✅ 已完成
4. 逐个实现专业 Agent
   - ~~需求分析 Agent（澄清+故事拆解+多轮 followup）~~ ✅ 已完成
   - ~~方案设计 Agent（结合知识库多次检索 + 评审内 revise）~~ ✅ 已完成
   - [~] 评审 Agent：✅ 方案评审多轮已完成；⏳ 代码 CR 随 CodingAgent 落地
   - [~] 编码 Agent：✅ 单故事 TDD（red/green/fix）+ 逐故事循环与部分成功出口 + CR 内 revise（针对性修改+重跑测试）；⏳ 真实子进程 runner v2
   - [~] 评审 Agent：✅ 方案评审多轮（review-design + Designer revise）+ 代码 CR 多轮（review-code + Coder revise）；⏳ 设计还原度图片比对 v2
   - [ ] 交付 Agent（PR）
5. ~~实现 Harness（状态机执行器 + 调度 + 上下文装配 + 异常 + 弱介入 + 回退 + 取消 + 知识库服务注入）~~ ✅ 已完成（ADR-014：ContextManager 只做产物装配，检索收归 Agent）
6. [~] 评审阶段多轮对话机制（详见 [08-review-dialog.md](08-review-dialog.md)）——design 侧 ✅，code-review 侧随 CodingAgent
   - [x] 统一判定规则 review-policy（normalizeIssues/resolveDialogAction/findUnverifiedIssues/findUnansweredIssues）
   - [x] 类型定义（review-dialog.ts：DialogMessage/IssueResponse/ReviewRound/ReviewDialogHistory）
   - [x] BaseAgent 泛型执行器 runAgentCycle（未采用并行 executeDialog 抽象，理由见 08 第十章偏差说明）
   - [x] Harness.runDesignReviewDialog() 调度逻辑（含双侧问题跟踪闭环校验、暂停/续跑）
   - [x] 评审历史产物保存（design-review-history，方案重生成时失效）
7. [ ] 集成验证
8. [ ] 迭代优化

## Harness 组件拆分状态

设计中 Harness 拆分为 Scheduler / HumanInteraction / StateManager 独立类，当前 v1 内联在 Harness 类中。拆分时机：当 Harness 类超过 500 行或需要独立测试调度逻辑时。

> 第七轮一致性审计已删除三个零引用空壳文件（scheduler.ts / human-interaction.ts / state-manager.ts），避免空壳误导；职责按下表内联/推迟，需要时再按本设计重建。

| 组件 | 状态 | 说明 |
|---|---|---|
| Scheduler | 🟡 内联在 Harness | Agent 调度逻辑在 runExecutionLoop 中 |
| HumanInteraction | 🟡 内联在 Harness | 硬卡点/弱介入（含超时竞速）/回退逻辑在 Harness 中 |
| StateManager | ⚪ 推迟 | 状态持久化与崩溃恢复未实现（06-storage 设计），当前状态仅在内存 StateMachine |
