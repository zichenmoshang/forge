# 决策记录

## ADR-001：采用 Harness + 专业 Agent 架构

**状态**：已采纳
**日期**：2026-09-01

### 背景

需要构建一个从 PRD 到前端代码的多阶段自动化智能体，流程包含 7 个阶段，有回退、人工介入、异常处理等复杂控制逻辑。

### 决策

采用 Harness（中央编排器）+ 专业 Agent 架构。Harness 只做控制面（状态管理、流程控制、调度、上下文传递、异常处理），不生成内容。所有业务逻辑在专业 Agent 中。

### 备选方案

- 单 Agent 全流程：上下文爆炸，无法并行，职责混乱
- 纯 Pipeline：无法处理回退、人工介入、循环
- 多 Agent 自由协作：没有中央控制，流程不可控

### 理由

- 7 阶段长流程有回退和人工介入，需要中央状态管理
- 各阶段专业能力不同，分 Agent 有利于单独优化和替换
- Harness 状态机使流程显式化、可审计、可恢复
- 产物依赖前向，适合中央调度

---

## ADR-002：不做模型训练，采用 RAG + 代码反解析

**状态**：已采纳
**日期**：2026-09-01

### 背景

历史知识库需要为方案设计提供接口模式、组件用法、技术方案参考。需要决定知识的获取和管理方式。

### 决策

不做 fine-tuning，采用代码反解析 + RAG（检索增强生成）。从已上线代码 AST 解析提取结构化知识，向量化索引，生成时检索相关知识作为上下文。

### 理由

- 代码更新频繁，训练成本高周期长，跟不上变化
- 训练只能学风格，不能保证精准引用具体接口
- 代码是真相来源，反解析精度高且零人工维护
- RAG 可解释，能追溯知识来源

---

## ADR-003：不进行人工打标

**状态**：已采纳
**日期**：2026-09-01

### 背景

知识库检索需要分类和过滤，传统方案需要人工给知识打标签。

### 决策

不进行人工打标。结构化知识程序化提取元数据（标题路径、接口定义），非结构化知识用语义检索 + rerank，查询时动态增强。

### 理由

- API 接口、组件等结构化知识可从代码和文档自动提取元数据
- 技术方案的标题层级天然提供分类路径
- 语义检索 + LLM rerank 可达到足够精度
- 人工打标成本高、维护难、容易过时

---

## ADR-004：存储采用 PostgreSQL + pgvector + 本地文件系统

**状态**：已采纳
**日期**：2026-09-01

### 背景

系统需要存储流程状态、产物、向量索引、符号索引、日志等多种数据。

### 决策

v1 用 PostgreSQL（状态/元数据/索引）+ pgvector（向量）+ 本地文件系统（大文本/代码/日志）三件套。

> ⚠️ **实践变更（#85 同步）**：落地时 v1 存储收敛为「本地文件系统 + 内存向量库」——
> 产物/状态/日志落盘 `data/instances/{id}/`（FileSystemArtifactStore + state.json 快照，#82），
> 向量为 InMemoryVectorStore（#84），PostgreSQL + pgvector 推迟为 v2 目标，本 ADR 的选型理由在 v2 落地时继续适用。

### 理由

- 运维成本最低，不引入额外组件
- PostgreSQL JSON 字段支持结构化数据
- pgvector 满足 v1 向量检索需求
- 文件系统适合存大文本和代码
- 后续可按需升级到对象存储、专用向量库

---

## ADR-005：实现语言用 TypeScript

**状态**：已采纳
**日期**：2026-09-01

### 决策

智能体本身用 TypeScript 实现。

### 理由

- 与前端生态接近，代码解析（AST、类型）方便
- LLM API 封装和异步流程处理成熟
- 团队技术栈统一

---

## ADR-006：LLM 通过 API 配置接入，可替换

**状态**：已采纳
**日期**：2026-09-01

### 决策

封装统一 LLM Provider 接口，多模型实现，配置化切换，不硬编码特定模型。

### 理由

- 不同任务适合不同模型（成本/能力权衡）
- 模型供应商可能变更
- 便于 A/B 测试和降级

---

## ADR-007：弱模式人工介入，3 个硬卡点

**状态**：已采纳
**日期**：2026-09-01

### 决策

AI 自动推进为主，人工可在任意节点介入。3 个不可去掉的硬卡点：需求澄清问答、API 契约确认、最终交付确认。

### 理由

- 业务背景只有人知道，澄清必须人工
- API 契约影响前后端协作，必须人确认
- 最终交付需要人签收
- 其余环节 AI 自检 + 评审 Agent 可保证基本质量，人工介入成本太高

---

## ADR-008：测试仅到 mock 级，TDD 混合模式

**状态**：已采纳
**日期**：2026-09-01

### 决策

测试仅进行到 mock 接口数据级别，保证代码基本逻辑。单元测试在沙箱跑，集成级 mock 测试在真实项目跑（混合模式）。不做集成测试、回归测试、探索性测试。

### 理由

- 后端不在范围内，无法真实联调
- mock 测试足以验证前端逻辑
- 沙箱快速反馈 + 真实项目环境保证，平衡速度和准确性
- 更高层次测试由后续人工/QA 负责

---

## ADR-009：交付形式为 PR，覆盖三种场景

**状态**：已采纳
**日期**：2026-09-01

### 决策

最终交付为 PR，覆盖新项目、新模块、现有代码修改三种场景。

### 理由

- PR 是代码评审和合并的标准载体
- 三种场景覆盖真实开发中的主要需求类型
- PR 描述自动关联需求、故事、测试、CR 记录，可追溯

---

## ADR-010：状态机优化——去掉过渡状态，弱介入改调度层

**状态**：已采纳
**日期**：2026-09-02

### 背景

初始状态机有15个状态，存在两个问题：
1. `REQUIREMENT_FROZEN` 没有执行动作（不调Agent、不等人工），只是个标记
2. `STORIES_CONFIRMATION`、`DESIGN_REVIEWING`、`CODE_REVIEWING` 既是Agent执行状态又是人工等待状态，职责混淆

### 决策

1. **去掉 `REQUIREMENT_FROZEN`**：合并进 `REQUIREMENT_CLARIFICATION` 的出口动作，澄清充分后直接执行冻结（最终校验→生成最终版需求→标记frozen），然后进入故事生成。
2. **去掉 `STORIES_CONFIRMATION` 独立状态**：弱介入改为 Harness 调度层的30秒确认窗口，不占独立状态。
3. **弱介入窗口统一到调度层**：故事生成后、方案评审通过后、CR通过后，Harness设30秒窗口，人工可介入，超时自动继续。
4. **新增 `DELIVERY_CONFIRMATION`**：补齐第3个硬卡点（最终交付确认）。
5. **SUSPENDED 可恢复**：记录 `suspendedFromState`，恢复后回到该状态重新执行。
6. **回退重新确认**：回退后目标状态之后的所有确认和评审必须重新执行。

### 结果

状态数从15减到14，每个状态要么是"执行Agent"，要么是"硬卡点等人工"，没有混合状态。状态机更清晰，弱介入逻辑集中在调度层管理。

### 状态列表（14个）

INIT, REQUIREMENT_PARSING, REQUIREMENT_CLARIFICATION, STORIES_GENERATING, DESIGN_GENERATING, API_CONFIRMATION, DESIGN_REVIEWING, CODING, CODE_REVIEWING, DELIVERING, DELIVERY_CONFIRMATION, COMPLETED, FAILED, SUSPENDED

---

## ADR-011：上下文管理分阶段实现

**状态**：已采纳
**日期**：2026-09-02

### 背景

设计文档定义了四层上下文管理策略（产物引用传递、按需检索、摘要压缩、分级上下文），但 Harness 最小可用版实现时直接传递完整产物对象，未按设计文档实现。

### 问题

1. 设计与实现不一致，ContextManager 是空壳
2. Harness 内联了 `buildAgentInput()`，绕开了 ContextManager
3. 用 `this._prdText` hack 保存原始 PRD，不优雅

### 决策

1. **补上 ContextManager**：封装上下文装配逻辑，Harness 通过 ContextManager 构建 Agent 输入
2. **v1 用完整对象传递**：当前只有需求和故事两个小产物（几 KB），直接传完整对象无性能问题
3. **v2 预留接口**：`buildAgentInputWithRefs()`、`retrieveRelevantParts()`、`summarizeArtifact()` 已定义，抛出"未实现"错误
4. **全局上下文接口已定义**：`GlobalContext`（技术栈、规范），v1 暂未注入 Agent 输入
5. **移除 hack**：PRD 文本通过 `extra` 参数传给 `runExecutionLoop()`，不再挂在 this 上

### 分阶段路线

| 阶段 | 触发时机 | 内容 |
|------|----------|------|
| v1（当前） | 需求+故事阶段 | 小产物直接传完整对象，ContextManager 封装装配逻辑 |
| v2 | DesignAgent 实现时 | 技术方案产物较大，引入产物引用传递 |
| v3 | CodingAgent 实现时 | 按需检索（只加载当前故事相关方案）+ 摘要压缩 |

---

## ADR-012：知识库检索与维护机制、向量模型选型

**状态**：已采纳
**日期**：2026-09-02

### 背景

知识库是 Forge 的核心基础设施，用于需求澄清、故事拆解、技术方案设计三个阶段。需要明确：知识库的部署方式、向量模型选型、检索机制、维护机制、与飞书文档的集成方式、v1/v2 范围划分。

### 决策

1. **团队级中心化部署**：知识库作为独立服务部署，多项目共享，避免重复建设。与项目级代码索引分开存储。

2. **向量模型选型：通义 Qwen3-Embedding（API 版，1024 维）**
   - 中文效果最新 SOTA，32K 超长上下文
   - 1024 维是 pgvector 甜点区，HNSW 索引性能好
   - 阿里云 API 国内访问稳定，成本低（~¥0.7/百万 token）
   - 有开源版，后续可本地部署，迁移成本低
   - 备选：BGE-M3 本地部署（有 GPU 时可切换，支持稀疏向量混合检索）

   > ⚠️ **实践变更（#85 同步）**：实际接入改为 **火山引擎 Doubao-embedding-vision-251215**
   > （多模态 API，`/embeddings/multimodal` 端点，2048 维，OpenAI 兼容，API Key 复用主模型）。
   > 选型理由与对比见 docs/04-knowledge-base.md「选型决策」节；Qwen3/BGE-M3 仍为可切换备选。

3. **混合检索架构**：关键词精确检索（BM25）+ 向量语义检索（pgvector）+ 元数据过滤，v2 增加 Rerank（LLM 二次筛选）。

4. **查询时动态增强**：LLM 根据当前任务动态构造多检索 query，多路并行检索，合并去重后注入 prompt。

5. **知识库在三阶段的使用方式**：
   - 需求澄清（v2）：历史澄清问题 + 全局需求清单 + 技术规范，补全澄清盲区
   - 故事拆解（v2）：历史故事结构 + AC 写法模式，提升故事质量
   - 技术方案设计（v1）：API 复用 + 组件复用 + 方案参考 + 规范约束，核心输入

6. **维护机制**：
   - 代码反解析为主（AST 提取），飞书文档同步为辅（✅ 已提前落地：FeishuSyncService，全量+增量同步，见 docs/04-knowledge-base.md）
   - 增量更新（webhook 触发）+ 手动全量重建兜底
   - 五层质量保证：来源过滤、交叉验证、规则校验、使用反馈、过期检测
   - 动态权重系统（0-1），影响检索排序
   - 不物理删除，只标记状态（active/deprecated/removed）

7. **飞书文档集成（v2）**：技术文档 wiki 使用飞书文档，通过飞书 API 定时同步，按标题层级切分 chunk，与代码交叉验证标记过时。

8. **v1/v2 范围划分**：
   - v1：代码反解析 + 向量检索 + 关键词检索 + 技术方案设计阶段使用 + 维护 CLI + 飞书文档同步（提前落地）
   - v2：Rerank + 澄清/故事阶段使用 + 需求完成后自动入库 + 权重反馈闭环 + 管理界面

### 备选方案

- **OpenAI text-embedding-3**：中文效果不如国产，需代理，团队级服务不稳定
- **BGE-M3 本地部署**：免费且支持混合检索，但需 GPU 服务器和运维成本
- **纯向量检索**：查具体接口名时精度不够，需要关键词检索补充

### 理由

- 中文场景国产模型效果明显优于 OpenAI，Qwen3-Embedding 是最新 SOTA
- 1024 维在 pgvector 中性能和精度平衡最佳
- 混合检索比纯向量更适合代码+文档的混合知识场景
- 团队级中心化避免每个项目重复建知识库，跨项目复用价值大
- v1 聚焦技术方案设计阶段（知识库价值最大的场景），v2 逐步扩展到前两个阶段
- 代码反解析零人工维护，飞书文档补充"为什么"和"应该怎么做"

### 相关文档

- [知识库方案](../04-knowledge-base.md)
- [存储方案](../06-storage.md)（pgvector 配置和知识库表结构）

### 结果

- 设计与实现对齐，ContextManager 成为上下文装配的唯一入口
- Harness 不再关心产物如何读取，只调用 `contextManager.buildAgentInput()`
- v2 升级时只改 ContextManager，不动 Harness 和 Agent
- 12 个 ContextManager 单元测试验证装配逻辑和 v2 预留接口

---

## ADR-013：评审阶段采用状态机内嵌套角色驱动对话循环

**状态**：已采纳
**日期**：2026-09-04

### 背景

方案评审（阶段4）和代码 CR（阶段6）当前设计为单次执行：Reviewer 评审一次，不通过就回退到上一阶段。这种方式存在问题：
- 小问题（如命名不规范、缺少异常处理）也需要完整回退，成本高
- Reviewer 和 Designer/Coder 之间没有多轮交互，无法深入讨论
- 回退会导致后续产物全部重新生成，浪费已完成的工作

需要在保持 Harness 状态机整体控制的前提下，让评审阶段支持多 Agent 多轮对话。

### 决策

1. **外层状态机 + 内层对话循环**：REVIEW 状态本身不变，但状态内部嵌套一个对话循环。Reviewer 和 Designer/Coder 在循环内多轮交互，循环结束（通过/人工/最大轮次）后才转换状态。

2. **Reviewer 输出 dialogAction**：`approve`（通过）/ `request_changes`（要求修改）/ `request_human`（请求人工）。通过标准为 verdict=approve 且无 blocking 级别问题。

3. **最大轮次默认 3 轮**：第1轮发现问题→修改，第2轮验证修改，第3轮最终确认。3轮未通过则暂停等人工。可通过 `maxReviewRounds` 配置。

4. **对话历史 v1 全量传递**：3轮对话上下文量可控，全量传递不丢失信息。v2 预留摘要压缩接口。

5. **人工介入只在终止条件触发**：默认每轮不暂停，只有 approve/request_human/达到最大轮次时暂停。可配置 `interruptAfterEachRound` 开启每轮弱介入。

6. **评审内修改不是回退**：Designer/Coder 在对话循环内修改方案/代码，产物版本 +1，不触发状态机回退。只有人工明确要求或发现方案性问题时才回退到上一阶段。

7. **评审历史独立保存**：多轮对话记录（ReviewRound[]）作为独立产物保存，不覆盖被评审的方案/代码。

### 备选方案

- **纯角色驱动（CrewAI 模式）**：Agent 间自由对话，没有中央控制。流程不可控，无法保证终止，不适合 Forge 的确定性交付场景。
- **单次评审+回退**：当前设计。小问题也要完整回退，成本高，缺乏深入交互。
- **独立的评审子状态机**：在 REVIEW 状态下再定义一组子状态。过度设计，对话循环用 for 循环即可表达。

### 理由

- Forge 的核心流程是固定的 7 阶段，状态机是正确的外层抽象
- 评审阶段的特殊性在于需要多轮迭代，嵌套循环比新增状态更简洁
- 3 轮上限平衡了质量和成本，避免无限循环
- 对话历史全量传递实现简单，3 轮内 token 可控
- 评审内修改不回退，避免浪费已完成的工作
- 与 LangGraph 的"图+节点内循环"模式一致，是业界验证过的方案

### 相关文档

- [评审多轮对话机制设计](../08-review-dialog.md)
- [流程设计](../02-pipeline.md)（阶段4、阶段6）
- [架构设计](../03-architecture.md)（评审 Agent）

### 结果

- 新增 docs/08-review-dialog.md 详细设计文档
- 更新 02-pipeline.md 阶段4、阶段6、回退机制、实现状态
- 更新 03-architecture.md 评审 Agent 设计、实施顺序
- 类型定义和实现待后续编码阶段完成

---

## ADR-014：第六轮架构审查——流程顺序、检索职责、评审判定与状态语义收敛

**状态**：已采纳
**日期**：2026-09-04

### 背景

第六轮以技术专家视角通读全部设计与已实现代码，发现 14 个架构层面的不合理点，集中在流程顺序、职责边界、判定口径、状态语义四类。本 ADR 记录其中需要改变设计或代码的决策。

### 决策

**1. API 确认硬卡点移到方案评审之后**
- 原顺序：方案生成 → API 确认 → 方案评审。人工确认的是未经评审的契约，评审一旦改 API 就要二次确认。
- 新顺序：方案生成 → 方案评审（多轮对话）→ API 确认 → 编码。确认的是评审后的稳定版。
- 状态机 ADVANCE/FALLBACK 表、getNextState、全部文档同步调整。

**2. 知识库检索职责完全收归 Agent**
- 原实现 ContextManager 在 DESIGN_GENERATING 做 4 路并行预检索，同时设计又要求 DesignAgent 内部按需检索，职责重叠、重复检索。
- 决策：ContextManager 只做产物装配（同步、无知识库调用）；KnowledgeService 经 AgentContext 注入；BaseAgent 提供 searchKnowledge helper（多路并行 + projectScope 过滤 + 按 id 去重）。

**3. 评审判定口径统一（review-policy）**
- 原设计 conclusion / severity / blocking 三套判定并存且冲突规则未定义。
- 决策：severity 为 blocker/critical 时程序化强制 blocking=true（normalizeIssues）；是否通过只看"有无 open 的 blocking issue"；LLM 的 dialogAction 与结构化问题冲突时以程序化判定为准（resolveDialogAction）；conclusion 仅作自然语言总结。新增 src/core/review-policy.ts。

**4. 评审问题跟踪闭环**
- 新增 IssueVerification：第 2 轮起 Reviewer 必须对上一轮每个 open 问题逐项给出 resolved/not-resolved/accepted-wont-fix/rejected-wont-fix；findUnverifiedIssues 程序化拦截遗漏，不靠 LLM 自觉。
- 第 2 轮起 Reviewer 输入只附上轮结构化 issue 列表（不含自然语言评论），减少自我锚定。

**5. Designer/Coder 的生成与修改职责拆分**
- 阶段3/5 的 generate 与评审循环内的 revise 是两类任务，使用独立输入输出类型和独立方法，不在一个 execute 内按 type 做 if 分发（避免 issue #32 问题重演）。

**6. SUSPENDED 语义收敛 + 新增 CANCELLED 终态**
- "Agent 未实现"是开发期错误，直接 FAILED，不再 SUSPENDED；SUSPENDED 只保留给运行时外部依赖问题、评审达最大轮次等人工决策场景；硬卡点等待用 status=waiting_human。
- 新增 CANCELLED 终态与 Harness.cancel()，支持人工主动终止，产物保留备查。终态变为 COMPLETED/FAILED/CANCELLED 三个，状态总数 15。

**7. CODING 部分成功出口明确**
- 全部成功→CR；部分成功→弱介入窗口由人工决定继续/回退/暂停；全部失败→FAILED（不再进入 CR）。

**8. 两套版本号区分**
- currentVersion 是流程版本（回退 +1）；产物 version 单调递增（重新生成/评审内修改 +1，不随回退重置）。评审内修改只增产物版本、不增流程版本。

**9. 回退成本预警 + 事前成本预算**
- 人工触发回退前自动计算并展示将废弃的产物规模。
- 新增 budget.maxTokensPerRun / maxTokensPerCall，LLM 调用前检查预算，超限暂停等人工（事后告警改为事前拦截）。

**10. 类型修正**
- PipelineState.artifactIds 改为 Partial<Record<ArtifactStage, string>>，移除初始化时的 as 强转。

### 结果

- 代码：state-machine / harness / context-manager / agents 类型与 base / review 类型同步；新增 core/review-policy.ts；config 增加 budget；全量 206 测试通过，tsc/eslint/prettier 全绿
- 文档：01/02/03/04/06/07/08、schema/00 全部同步
- 遗留（P2，已记录到 issue.md）：ContextManager 进一步瘦身为纯产物读取、回退成本预警实现、预算检查在 LLM 调用链落地、CODING 部分成功出口实现
