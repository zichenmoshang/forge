# Forge 待解决问题

> 最后更新：2026-09-07
> 已完成问题的经验教训已沉淀到 [开发规范](coding-standards.md)。
> 第四轮复查（10 个问题）已全部修复，见规范文档第九章修复历史。
> 第五轮端到端验证（14 个测试）发现 1 个 bug（#37 humanAnswers 丢失），已修复。
> 第六轮架构审查（ADR-014）：流程顺序/检索职责/评审判定/状态语义已在设计与代码层修正，遗留 #38/#39/#41（#40 已随编码阶段完成）。
> 第七轮 #42 评审多轮对话机制（design 侧）已实现。
> 第八轮编码阶段落地：CodingAgent 单故事 TDD（red/green/fix）、可替换工具层、Harness 逐故事循环与 #40 部分成功三分支出口，295 测试全绿；代码 CR 多轮与真实子进程 runner 为下一步。
> 第九轮代码 CR 多轮落地：ReviewAgent review-code 分支（八维度 CR）、CodingAgent.revise（针对性修改+重跑测试+逐项回应）、Harness.runCodeReviewDialog 多轮循环（阻塞触发修订/verification闭环/暂停续跑/最大轮次接受），307 测试全绿；交付 Agent（PR）与真实子进程 runner 为下一步。
> 第十一轮全方位设计对照审查与修复：发现 7 个问题（2 重要+5 建议）并全部修复——CodingAgent.revise 的 AC 覆盖计算错误（expectedAcIds/coveredAcIds）、ReviewAgent.selfCheck 错查方案覆盖度、CODE_REVIEWING→CODING 回退无依据、parseReviseOutput 文件类型推断、死代码/签名/状态冗余一致性问题，307 测试全绿。
> 第十二轮全方位深度审查（设计+代码）：发现 15 个问题（#43~#56），其中 #43（经规范 8.3 适用边界判定合规）、#44（CodingPhaseResult 版本语义明确并实现）、#48（工具层注入方式已解决）、#49（闭环校验 fail-close）、#50（冗余分支删除）、#51（循环依赖可观测）已修复并从待解决列表移除；剩余 #46/#47/#52/#53/#54/#55 待后续迭代处理（#45 已在第十四轮修复）。
> 第十三轮 issue 全面审查与清理：确认 #16（INVEST 部分修复）、#27（工具层部分解决）为部分解决保留；#20/#25/#31 已完成从待解决列表移除；经验沉淀至 coding-standards 8.9。
> 第十四轮全面审查（设计+代码+测试+业界对比）：发现 12 个新问题（#57~#68）。已修复 6 项——#57 交付标题 Bug、#58 Git 命令注入、#59 perStory 逐故事质量检查、#67 代码 CR targetVersion、#10 delivery prompts 目录、#45 冻结 checklist 重复判据。剩余 6 项待后续迭代：#60 DialogRunner 抽取、#61 状态转换表统一、#62 LLM 超时、#63 死代码清理、#64 file-system-client 异步化、#65 knowledge-service 异步化、#66 命名统一、#68 测试工程化。#47 确认 harness.ts 1258 行超阈值。对照 LangGraph / Temporal / Inngest 等 2026 年业界实践，核心差距在持久化执行和预算控制。

---

## 待解决问题

### 基础设施

#### #1 运行时依赖按需安装

| 字段 | 内容 |
|------|------|
| **状态** | 🟡 部分解决 |
| **当前** | 已装 dotenv / zod / openai / typescript，其余依赖未安装 |
| **计划** | 按实现进度按需安装：实现存储层时装 pg，实现 Figma 工具时装 figma 客户端，实现 Git 操作时装 simple-git 等 |
| **处理时机** | 各模块实现时 |

#### #2 核心类空壳（剩余占位）

| 字段 | 内容 |
|------|------|
| **状态** | 🟡 部分解决 |
| **当前** | 已实现 StateMachine / Logger / Config / OpenAIProvider / BaseAgent（泛型执行器）/ RequirementAgent / DesignAgent（generate+revise）/ ReviewAgent（方案多轮+代码CR多轮）/ CodingAgent（单故事 TDD + revise）/ DeliveryAgent（场景判定+初始化+落盘+构建+Git+PR描述）/ Harness（多轮评审+逐故事编码+代码CR多轮+交付编排）/ ArtifactStore / ContextManager / KnowledgeService / VectorStore / ASTParser / EmbeddingProvider / review-policy / freeze-checklist / design-coverage / coding-planner/aggregator/validation / 编码工具层（Workspace/TestRunner）/ 交付工具层（FileSystem/Git/Build）/ 知识库 CLI，仅剩真实子进程 runner / 设计还原度图片比对为占位或待实现 |
| **计划** | 按 Agent 实现计划逐步填充：方案设计 Agent → 评审 Agent → 编码 Agent → 交付 Agent |
| **处理时机** | 持续进行中 |

#### #7 无 CI/CD 流水线

| 字段 | 内容 |
|------|------|
| **状态** | ⚪ 未解决 |
| **当前** | 无 .github/workflows/ 或其他 CI 配置 |
| **计划** | 配置基础 CI：`typecheck + lint + prettier-check + test`，在每次 push/PR 时自动运行 |
| **处理时机** | 有实际代码提交后（建议在 DesignAgent 实现完成后） |

#### #9 CLI 入口未实现

| 字段 | 内容 |
|------|------|
| **状态** | 🟡 部分解决 |
| **当前** | 知识库维护 CLI 已实现（kb sync/rebuild/search/status），主流程 CLI（forge run）未实现 |
| **计划** | 核心流程跑通后用 commander 实现，至少支持 `forge run <prd-path>` 和 `forge doctor`（验证配置/环境） |
| **处理时机** | Harness 最小可用版完成后 |

---

### Agent 与 Prompt

#### #16 RequirementAgent 的 INVEST 质量自检（部分修复，缺失时仍降级为通过）

| 字段 | 内容 |
|------|------|
| **状态** | 🟡 部分修复（第七轮 #5） |
| **位置** | `src/agents/requirement-agent.ts:406-424` |
| **原问题** | INVEST 6 个维度中 4 个硬编码为 true（independent、negotiable、valuable、estimable） |
| **修复现状** | 第七轮 #5 已修复：I/N/V/E 从 LLM 自评分获取（`parsed.qualityCheck?.invest`），缺失时降级为 true 并记 warning（"LLM 未输出 qualityCheck.invest 自评分，I/N/V/E 按通过处理"）。Small/Testable 程序计算 |
| **剩余问题** | 缺失时降级为 true 仍是 fail-open（虽然有 warning），但比硬编码好。LLM 自评分的可信度依赖模型输出质量，无法程序化验证 |
| **处理时机** | RequirementAgent 迭代时可考虑：缺失时改为 warning 但不影响 passed（当前行为），或引入更细粒度的程序化检查 |

---

### 上下文与类型

#### #17 ContextManager.buildAgentInput 返回 unknown，类型安全性差

| 字段 | 内容 |
|------|------|
| **状态** | 🟡 部分缓解（ADR-014） |
| **位置** | `src/core/context-manager.ts` |
| **现象** | `buildAgentInput` 返回 `unknown`，Harness 直接塞进 `AgentContext.input`，Agent 再自己断言类型。整个链条没有类型保障 |
| **影响** | 重构时容易引入类型错误但编译不报错；ContextManager 和 Agent 之间的契约隐式化 |
| **进展** | ADR-014 后各分支用 `satisfies XxxAgentInput` 保证分支内类型正确，新增 DesignAgentInput；方法签名仍为 unknown（多状态异构输入的折中） |
| **建议** | 定义 `AgentInputByState` 类型映射，或用泛型 + 类型守卫 |
| **处理时机** | 第二个 Agent（DesignAgent）实现时 |

---

### 知识库

#### #21 ASTParser 只能识别极简单的 API 和组件模式

| 字段 | 内容 |
|------|------|
| **状态** | 🟡 待增强 |
| **位置** | `src/services/ast-parser.ts` |
| **现象** | API 提取只能匹配 `request.get(url)` 直接调用；组件提取只能识别函数参数 inline type literal 和 `XxxProps` interface。对于 axios 实例、fetch 封装、`React.FC<Props>`、type 别名等常见写法完全无法识别 |
| **影响** | 真实项目中 AST 解析命中率很低，知识库中 API 和组件覆盖度不足 |
| **建议** | 支持更多模式：axios/fetch 封装识别、React.FC 类型、type 别名、类组件等 |
| **处理时机** | 知识库接入真实项目前 |

#### #22 indexCode 串行处理，每个 item 单独 embedding

| 字段 | 内容 |
|------|------|
| **状态** | 🟡 待优化 |
| **位置** | `src/services/knowledge-service.ts:148-179` |
| **现象** | 每个知识条目单独调用一次 embedding API，N 个条目 = N 次 API 请求。大多数 embedding API 支持 batch（一次传多个文本） |
| **影响** | 索引大仓库时极慢，API 费用也更高 |
| **建议** | 先收集所有 item 的 summary，批量调用 embedding，再逐个赋值 |
| **处理时机** | 索引超过 100 个文件时 |

#### #24 syncIncremental 删除逻辑效率低

| 字段 | 内容 |
|------|------|
| **状态** | 🟡 待优化 |
| **位置** | `src/services/knowledge-service.ts:243-256` |
| **现象** | 每次删除都遍历所有 items 找 sourceRef 匹配的，O(n) 复杂度 |
| **建议** | 建立 sourceRef → itemIds 的索引，或由 VectorStore 接口提供按 sourceRef 查询的方法 |
| **处理时机** | 知识库条目超过 1000 条时 |

#### #29 InMemoryVectorStore 搜索是 O(n) 全量计算

| 字段 | 内容 |
|------|------|
| **状态** | 🟢 已知限制 |
| **位置** | `src/services/vector-store.ts:75-102` |
| **说明** | 每次 search 遍历所有 items 计算余弦相似度。注释已说明适用于 < 10000 条，后续有 PostgreSQL 时替换为 pgvector |
| **处理时机** | 接入 PostgreSQL 时 |

#### #30 MockEmbeddingProvider 的伪向量语义相关性差

| 字段 | 内容 |
|------|------|
| **状态** | 🟢 已知限制 |
| **位置** | `src/llm/embedding-provider.ts:66-79` |
| **说明** | 基于字符码的简单哈希，"用户登录"和"登录用户"可能向量完全不同。测试中的检索效果不能代表真实场景 |
| **建议** | 测试中注意 mock 的局限性，集成测试用真实 embedding |
| **处理时机** | 集成测试阶段 |

---

### 核心模块占位

#### #27 工具层（编码工具层已实现，其余工具按需）

| 字段 | 内容 |
|------|------|
| **状态** | 🟡 部分解决（编码工具层+交付工具层已实现） |
| **位置** | `src/tools/` |
| **已实现** | 编码工具层：Workspace 接口 + InMemoryWorkspace、TestRunner 接口 + StaticTestRunner（静态推断）+ ScriptableTestRunner（测试用）、types.ts、index.ts；交付工具层：FileSystemClient（项目状态检查/场景推断/代码落盘/新项目初始化）、GitClient（git init/分支/add/commit/status）、BuildRunner（包管理器检测/构建执行/输出捕获）、index.ts |
| **已删除** | 第七轮 #10 删除了 code-executor、code-index、figma、file、git、knowledge-base 等零引用空壳 |
| **后续** | 真实子进程 TestRunner（v2）、Figma 图片比对工具（v2）按需实现 |

---

### 设计讨论

#### #33 知识库检索 query 构造过于粗糙

| 字段 | 内容 |
|------|------|
| **状态** | 💡 设计讨论 |
| **位置** | ADR-014 后检索在 Agent 内部（原 ContextManager 4 路检索已移除） |
| **现象** | 只是简单的"标题 + 功能名 + 类型关键词"拼接，没有 query 优化、关键词提取、同义词扩展 |
| **影响** | 检索质量高度依赖标题和功能名的措辞 |
| **建议** | 增加 query 预处理层：提取核心关键词、补充同义词、拆分多轮检索 |
| **处理时机** | 知识库接入真实项目后，根据检索效果优化 |

#### #34 没有 prompt 版本管理机制

| 字段 | 内容 |
|------|------|
| **状态** | 💡 设计讨论 |
| **说明** | Prompt 是 Agent 的核心业务逻辑，但目前 prompt 修改后没有版本追踪。LLM 响应和产物中记录了模型版本，但没有 prompt 版本 |
| **建议** | 每个 prompt 模板加 version 字段，产物中记录使用的 prompt 版本 |
| **处理时机** | 有 2 个以上 Agent 上线后 |

### 第六轮架构审查遗留（ADR-014，P2）

#### #38 回退成本预警未实现

| 字段 | 内容 |
|------|------|
| **状态** | ⚪ 设计已定，代码未实现 |
| **说明** | ADR-014 要求人工触发回退前自动计算并展示将废弃的产物规模（如"N 个故事、M 个文件"）。Harness.fallback 当前直接执行回退 |
| **处理时机** | CodingAgent 实现后（有代码产物时预警才有实际价值） |

#### #39 预算前置检查未在 LLM 调用链落地

| 字段 | 内容 |
|------|------|
| **状态** | 🟡 配置已加并被 Harness 消费（getTokenBudget），检查逻辑未实现 |
| **说明** | config 已加 budget.maxTokensPerRun/maxTokensPerCall、HarnessConfig 已加 maxTokensPerRun 并保存，但 LLM 调用前的累计 token 检查和超限暂停尚未实现 |
| **处理时机** | 评审对话循环实现时一并落地（对话循环是成本高发区） |

#### #41 ContextManager 进一步瘦身为纯产物读取

| 字段 | 内容 |
|------|------|
| **状态** | 💡 设计讨论 |
| **说明** | ADR-014 已移除其检索职责，但 buildAgentInput 的 switch 仍知道每个 Agent 的输入结构（中心耦合点，#17 同源问题）。终极形态：ContextManager 只提供 getArtifacts，Agent 自己决定消费哪些产物。v1 保持现状，避免过度重构 |
| **处理时机** | 3 个以上 Agent 实现后评估 |

#### #46 maxTokensPerRun 配置占位但无实际消费逻辑

| 字段 | 内容 |
|------|------|
| **状态** | 🟡 配置已加，逻辑未实现（同 #39） |
| **位置** | `src/core/harness.ts:120,157` |
| **现象** | HarnessConfig 定义了 `maxTokensPerRun`，构造函数里保存了，但没有任何 token 累加、超限检查、暂停触发的消费逻辑 |
| **风险** | 配置存在但完全不生效，容易误导使用者以为已经有预算控制 |
| **建议** | 要么移除配置避免误导，要么在 LLM 调用链中落地预算检查（与 #39 是同一问题） |
| **处理时机** | #39 落地时一并解决 |

#### #47 Harness 类持续膨胀（实测 1258 行，超 500 行阈值）

| 字段 | 内容 |
|------|------|
| **状态** | 🟡 待评估 |
| **位置** | `src/core/harness.ts` |
| **设计约定** | "当 Harness 类超过 500 行或需要独立测试调度逻辑时"拆分为 Scheduler / HumanInteraction / StateManager |
| **现状** | 实测 1258 行（2026-09-07），远超 500 行阈值。Harness 已承担：状态机执行、Agent 调度、产物管理、弱介入窗口、回退、取消、方案评审多轮对话、编码逐故事循环、代码 CR 多轮对话、交付阶段编排、人工介入管理…… |
| **风险** | 类过大导致可维护性下降，测试困难 |
| **建议** | 统计当前行数，如已超阈值则启动拆分计划。优先拆出：评审对话循环调度（design-review + code-review 共用模式可抽象）、编码阶段循环调度 |
| **处理时机** | DeliveryAgent 实现前评估 |

#### #52 StaticTestRunner 用例计数正则过于简单

| 字段 | 内容 |
|------|------|
| **状态** | 🟡 v1 限制 |
| **位置** | `src/tools/static-test-runner.ts:10` |
| **现象** | `/\b(?:it|test)\s*\(/g` 匹配所有 `it(` / `test(`，包括：注释中的、字符串中的、变量名中的。且不支持 `it.each()` / `test.each()` / `describe()` 嵌套 |
| **影响** | 测试用例计数准确性有限（可能多算或少算） |
| **建议** | 至少排除注释（`//` 和 `/* */`）和字符串中的匹配 |
| **处理时机** | 静态 runner 增强时 |

#### #53 StaticTestRunner 的 AC 覆盖检查是纯字符串包含

| 字段 | 内容 |
|------|------|
| **状态** | 🟡 v1 限制 |
| **位置** | `src/tools/static-test-runner.ts:44-46` |
| **现象** | `testContents.includes(acId)` — 只要测试文件文本中出现了 AC ID 字符串就算"覆盖了"。LLM 可以把 AC ID 放在注释、描述字符串里就通过检查 |
| **更严重的问题** | 短 AC ID（如 `ac-1`）可能误匹配其他字符串（如 `track-ac-123`） |
| **建议** | 至少用单词边界（`\b${acId}\b`）做匹配，或解析测试文件结构找真正的测试用例关联 |
| **处理时机** | 静态 runner 增强时 |

#### #54 aggregateCodingResults 测试总数可能重复计数

| 字段 | 内容 |
|------|------|
| **状态** | 🟡 准确性问题 |
| **位置** | `src/core/coding-aggregator.ts:83-85` |
| **现象** | `totalTests = results.reduce((sum, r) => sum + r.testResult.totalTests, 0)` — 简单相加各故事的测试数。但 `dedupeFiles()` 对文件去重了，测试统计却没有对应去重 |
| **场景** | 如果两个故事共享同一个测试文件（如集成测试文件测了多个故事），测试用例会被重复计数，导致 totalTests 和 passRate 虚高 |
| **建议** | 聚合时按测试文件路径去重后重新统计用例数 |
| **处理时机** | 编码阶段有跨故事共享测试时 |

#### #55 buildSystemPrompt 同步 / buildUserPrompt 异步，不一致

| 字段 | 内容 |
|------|------|
| **状态** | 🟢 设计一致性（低优先级） |
| **位置** | `src/agents/base.ts` + 各 Agent 实现 |
| **现象** | BaseAgent.runAgentCycle 中 `buildSystemPrompt` 返回 `string`（同步），`buildUserPrompt` 返回 `Promise<string>`（异步） |
| **影响** | 如果未来 system prompt 需要异步生成（如从文件加载模板、动态拼接知识库摘要），就需要改基类接口和所有子类实现 |
| **建议** | 统一为 async（或都支持 `string | Promise<string>`），保持接口一致性 |
| **处理时机** | 第一个需要异步 system prompt 的 Agent 出现时 |

### 第十四轮全面审查发现（设计+代码+测试+业界对比）

#### #60 Harness 评审对话循环重复代码（抽取 DialogRunner）

| 字段 | 内容 |
|------|------|
| **状态** | 🟡 设计问题 |
| **严重度** | P1 — v2 优先 |
| **位置** | `src/core/harness.ts` — `runDesignReviewDialog()` 与 `runCodeReviewDialog()` 各约 200 行 |
| **现象** | 两个方法结构高度重复：轮次循环 → 调用 ReviewAgent → 判断 blocking → 调用修改方 → 闭环校验 → 最大轮次处理 → 暂停/续跑。仅在调用的 Agent 方法和输入类型上不同 |
| **影响** | 任何评审循环的修改都需要在两处同步修改，维护成本高且易遗漏 |
| **建议** | 抽取 `DialogRunner` 类，参数化 `reviewAgent` / `reviserAgent` / `maxRounds` / `reviewType`，消除重复 |
| **业界对比** | LangGraph 将对话循环抽象为独立的 graph node 组合，而非在编排器中内联。CrewAI 也把 review 作为独立 Agent 角色 |
| **关联** | 与 #47（Harness 膨胀）同源，拆分 DialogRunner 是 Harness 瘦身的第一步 |

#### #61 getNextState 转换表与 state-machine.ts 重复维护

| 字段 | 内容 |
|------|------|
| **状态** | 🟡 设计问题 |
| **严重度** | P1 — v2 优先 |
| **位置** | `src/core/harness.ts:1329-1349` |
| **现象** | Harness 内嵌了一份完整的状态转换表 `getNextState()`，与 `state-machine.ts` 的 `ADVANCE_TRANSITIONS` 重复维护。两份表可能不同步，是 bug 温床 |
| **影响** | 修改状态转换时需要同步修改两处，遗漏会导致 Harness 与 StateMachine 行为不一致 |
| **建议** | 删除 Harness 的 `getNextState`，统一使用 `StateMachine.canAdvance()` + `ADVANCE_TRANSITIONS`。同时删除 `getNextStateAfterBlocking` 纯委托方法 |
| **业界对比** | 状态转换表应只有一个 source of truth，这是状态机模式的基本原则 |

#### #62 LLM 调用无超时控制

| 字段 | 内容 |
|------|------|
| **状态** | 🟡 设计问题 |
| **严重度** | P1 — v2 优先 |
| **位置** | `src/agents/base.ts` — `runAgentCycle` 中的 LLM 调用 |
| **现象** | `BaseAgent.runAgentCycle` 中 LLM 调用无超时设置。如果 LLM provider 挂起（网络问题、服务端不响应），整个流程无限等待 |
| **影响** | 单次 LLM 调用挂起可导致整个流水线永久阻塞 |
| **建议** | 在 `LLMProvider` 接口增加 `timeout` 参数（如 60s），`OpenAIProvider` 透传给底层 SDK |
| **业界对比** | Temporal 将每个 activity（含 LLM 调用）包裹在 `start_to_close_timeout` 中。OpenAI SDK 内置 timeout 机制。Inngest 的 `step.ai.infer()` 也有超时保护 |

#### #63 死代码清理（9 处）

| 字段 | 内容 |
|------|------|
| **状态** | 🟡 代码质量 |
| **严重度** | P1 — v2 优先 |
| **位置** | 多处 |
| **清单** | (1) `src/agents/base.ts:210` — `defaultKnowledge` 与 `retrieveKnowledge` 默认实现完全重复；(2) `src/agents/delivery-agent.ts:600` — `parseOutput` 抛异常，永不调用；(3) `src/agents/delivery-agent.ts:443-444` — `linesAdded`/`linesDeleted` 恒为 0；(4) `src/core/harness.ts:172` — `maxGreenAttempts` 存储但 CodingAgent 用自己的配置，Harness 配置不生效；(5) `src/core/harness.ts:1441,1449` — `getReviewConfig()` / `getTokenBudget()` 无调用方；(6) `src/core/harness.ts:1351` — `getNextStateAfterBlocking` 纯委托无额外逻辑；(7) `src/core/state-machine.ts` — `handleSuspend`/`handleResume`/`handleComplete` 从未被调用（Harness 使用 `pauseForHuman`/`markRunning`/`ADVANCE`）；(8) `src/services/prd-parser.ts` — 空壳类（7 行只有 TODO）；(9) `src/services/storage/index.ts` — 空壳类（5 行只有 TODO） |
| **建议** | 逐一删除或标注为 `// @deprecated v2 预留`。其中 (4) 建议改为透传给 CodingAgent 或删除 |

#### #64 file-system-client.ts async 方法用同步 API

| 字段 | 内容 |
|------|------|
| **状态** | 🟡 代码质量 |
| **严重度** | P1 — v2 优先 |
| **位置** | `src/tools/delivery/file-system-client.ts` |
| **现象** | 所有方法声明 `async`，内部全用 `fs.existsSync` / `fs.writeFileSync` / `fs.mkdirSync` 等同步 API |
| **影响** | 误导调用方认为这是非阻塞 I/O；在高并发交付时会阻塞事件循环 |
| **建议** | 改用 `fs.promises.*` 系列异步 API，或去掉 `async` 声明（如果确实不需要异步） |

#### #65 knowledge-service.ts 同步文件读取阻塞事件循环

| 字段 | 内容 |
|------|------|
| **状态** | 🟡 代码质量 |
| **严重度** | P1 — v2 优先 |
| **位置** | `src/services/knowledge-service.ts:172,425-449` |
| **现象** | `indexCode` 使用 `fs.readFileSync`，`collectCodeFiles` 使用 `fs.readdirSync` |
| **影响** | 在大型代码库索引时阻塞事件循环，导致整个进程卡顿 |
| **建议** | 改用异步 `fs.promises` API |
| **关联** | 与 #22（串行 embedding）同属知识库索引性能问题 |

#### #66 CodingResult.status 与 CodingPhaseResult.overallStatus 命名不一致

| 字段 | 内容 |
|------|------|
| **状态** | 🟡 代码质量 |
| **严重度** | P2 — 架构演进 |
| **位置** | `src/types/coding-task.ts:167,216` |
| **现象** | 故事级 `CodingResult.status` 使用 `'success' \| 'partial' \| 'failed'`，阶段级 `CodingPhaseResult.overallStatus` 使用 `'all-success' \| 'partial-success' \| 'all-failed'`。两套风格迥异的枚举增加认知负担 |
| **建议** | 统一命名风格，如阶段级改为 `'success' \| 'partial' \| 'failed'`（加 `all-` 前缀或去掉，保持一致） |

#### #68 测试工程化配置缺失（tsconfig 排除测试 + 无 coverage 阈值）

| 字段 | 内容 |
|------|------|
| **状态** | 🟡 工程化问题 |
| **严重度** | P1 — v2 优先 |
| **位置** | `tsconfig.json` / `package.json` |
| **现象** | (1) `tsconfig.json` 的 `exclude` 包含 `"tests"`，导致 `tsc --noEmit` 不类型检查测试文件，测试类型错误只在 `vitest run` 时暴露；(2) 无 `vitest.config.ts`，无 coverage 配置和阈值，"315 测试全绿"是数量代理而非覆盖率；(3) `@typescript-eslint/no-explicit-any` 是 `warn` 非 `error`，生产代码可 slip 进 `any`；(4) 无 husky / lint-staged，无 pre-commit 钩子 |
| **建议** | (1) 新建 `tsconfig.test.json` 继承主配置并 include tests，`typecheck` 脚本改为 `tsc --noEmit -p tsconfig.test.json`；(2) 添加 `vitest.config.ts` 配置 coverage 阈值（建议 lines 80%/functions 75%/branches 70%）；(3) `no-explicit-any` 改为 `error`；(4) 添加 husky + lint-staged pre-commit |
| **关联** | #7（无 CI/CD）的互补项——CI 落地时一并解决 |

---

## 测试改进项

以下不是 bug，是测试质量提升项，在对应模块迭代时处理：

| 项 | 说明 | 处理时机 |
|----|------|----------|
| logger 传入测试断言深度 | "应该能传入 logger 选项"只验证了创建成功，没验证 logger 是否真的被传入并生效 | LLM Provider 迭代时 |
| 指数退避延迟验证 | 没有验证重试延迟时间是否正确，可用 fake timers 测 | LLM Provider 迭代时 |
| temperature / maxTokens 默认值传递 | 只测了 model 覆盖，没测温度和 token 数 | LLM Provider 迭代时 |
| Harness 弱介入窗口 | 🟡 第七轮已补"超时自动继续"路径测试；continue/fallback 显式决策路径仍可补 | 评审循环实现时 |
| Harness fallback 方法 | 人工回退流程（从澄清回退到需求解析等）没有测试 | Harness 迭代时 |
| KnowledgeService syncIncremental | 🟡 第七轮已补 added + projectScope 透传测试；modified/deleted 场景仍可补 | KnowledgeService 迭代时 |
| ASTParser 复杂场景 | 只测了简单模式，React.FC、type 别名、封装请求库等都没测 | ASTParser 增强时 |
| 澄清 followup 多问题场景 | 测试只有一个问题，多问题场景未覆盖 | RequirementAgent 迭代时 |
| 双层重试交互 | Harness 与 BaseAgent 重试叠加的行为没有测试（也确实不应该有双层重试） | 重试架构统一后 |
| 全局上下文浅拷贝 | ✅ ADR-014 已改 structuredClone 深拷贝并测试嵌套场景 | 已完成 |
| cancel / 状态新顺序 | ✅ ADR-014 已补 CANCELLED 终态、评审先于 API 确认的状态机测试 | 已完成 |
| review-policy 判定规则 | ✅ ADR-014 已补 15 个测试（强制 blocking/动作仲裁/闭环校验/一致性） | 已完成 |
| 检索质量集成测试 | MockEmbedding 是伪向量，多路检索的去重/projectScope 已单测，但真实语义检索质量需接 Qwen 做集成验证 | DesignAgent 联调时 |
| 预算前置检查 | 超限暂停、单次调用兜底，随 #39 实现补测试 | #39 实现时 |
| 澄清 followup 人工回答传递 | #36 修复后，需验证 followup prompt 中确实包含 humanAnswers 内容 | RequirementAgent 迭代时 |
| followup 后 humanAnswers 丢失 | #37 已修复：Harness 保存 Agent 返回结果时覆盖了 humanAnswers 字段，需合并保留 | 已修复，见规范文档 1.6 |
| 编码阶段 partial-success 出口 | all-success 和 all-failed 有 e2e 覆盖，但 partial-success（部分故事成功 + 部分失败 + 弱介入决策）路径端到端覆盖可能不足 | 编码阶段稳定性验证时 |
| CR revise 后测试重跑验证 | 代码修订后测试是否重新运行并通过，StaticTestRunner 下逻辑是否正确 | CodingAgent.revise 迭代时 |
| 循环依赖的故事排序 | topoSortStories 的保底行为（有环时按原顺序追加）未测试 | coding-aggregator 迭代时 |
| 大输入场景性能 | 测试用例都是最小化输入，没有验证长 PRD、多故事场景下的性能和 token 消耗 | 集成测试阶段 |
| 问题跟踪闭环 fail-close | round>=2 时 previousIssues 缺失应报错（#49），当前是静默通过，需测试防护 | #49 修复时 |
| 设计覆盖度 componentTouched 分支 | #50 逻辑冗余，修复后需验证 componentTouched 的真实语义 | #50 修复时 |
| delivery-agent mockCoding fixture 不一致 | `results: []` 但 `successStoryIds: ['story-1','story-2']` 互不一致——代码只读 successStoryIds 所以通过，但 fixture 不真实，一旦代码改读 results 会崩 | DeliveryAgent 迭代时 |
| LLM 返回合法 JSON 但字段类型错误 | 测试都用预构造 JSON，未模拟类型污染（如 `priority: 3` 而非字符串、`severity: 42` 等） | Agent 基类迭代时 |
| embedding API 失败降级 | MockEmbeddingProvider 永不失败，真实 embedding API 失败时的降级路径未测 | 知识库联调时 |
| StaticTestRunner 假阳性 | 短 AC ID `ac-1` 误匹配 `track-ac-123` 未测；`it.each()` / `test.each()` / `describe()` 嵌套未测 | #53 修复时 |
| findUnansweredIssues rejected-wont-fix | Reviewer 拒绝 wont-fix 后的续跑路径无 e2e 覆盖 | 评审对话迭代时 |

---

## 第五轮端到端验证发现并修复的问题

#### #37 followup 后 humanAnswers 字段丢失

| 字段 | 内容 |
|------|------|
| **状态** | ✅ 已修复 |
| **位置** | `src/core/harness.ts:269-270` |
| **发现方式** | 端到端验证测试 `tests/integration/harness-e2e.test.ts` |
| **现象** | Harness 在 handleClarificationFollowup 中创建了包含 humanAnswers 的 updatedRequirement，但调用 Agent 后直接保存 Agent 返回的结果（result.data），覆盖了 humanAnswers 字段。导致 followup 后 requirement.humanAnswers 为 undefined |
| **根因** | Agent 返回的 JSON 中不包含 humanAnswers 字段（这是 Harness 层的元数据，不是 Agent 输出），直接赋值导致丢失 |
| **方案** | 保存时合并 humanAnswers：`{ ...result.data, humanAnswers: updatedRequirement.humanAnswers }` |
| **修复时间** | 2026-09-03 |
| **经验** | 见规范文档 1.6（数据结构变更全链路影响）—— Harness 层注入的元数据在保存 Agent 结果时必须显式保留 |

---

## 第六轮架构审查修复记录（ADR-014，2026-09-04）

以技术专家视角通读全部设计与代码，发现 14 项架构问题，其中 10 项已在本轮设计+代码层修复，4 项转为遗留（#38-#42 中除设计已定外的实现项）：

| 问题 | 处理 |
|---|---|
| API 确认在评审前，确认的是不稳定契约 | ✅ 状态机调整为 设计→评审→API确认→编码（代码+全部文档） |
| ContextManager 预检索与 Agent 自检索职责重叠 | ✅ 移除 ContextManager 检索，KnowledgeService 经 AgentContext 注入，BaseAgent 加 searchKnowledge helper |
| conclusion/severity/blocking 三套判定冲突 | ✅ 新增 core/review-policy.ts 统一规则（强制 blocking、动作仲裁） |
| 评审闭环靠 LLM 自觉 | ✅ IssueVerification + findUnverifiedIssues 程序化拦截遗漏 |
| Reviewer 自我锚定 | ✅ 第2轮起只附上轮 issue 列表，不附自然语言评论 |
| Designer 生成/修改混在一个 execute | ✅ 定方向：generate/revise 独立类型独立方法（#32） |
| SUSPENDED 三义、Agent 未实现也挂起 | ✅ 未实现直接 FAILED，SUSPENDED 只留运行时原因 |
| 无取消机制 | ✅ 新增 CANCELLED 终态 + Harness.cancel() |
| CODING 部分成功无法表达 | ✅ 设计明确三出口（#40 跟踪实现） |
| artifactIds 类型谎言 | ✅ 改 Partial，移除 as 强转 |
| 三套版本号混乱 | ✅ 明确流程版本 vs 产物版本（02/06 文档） |
| 回退无成本预警 | 🟡 设计已定，#38 跟踪实现 |
| 无前置成本控制 | 🟡 配置已加，#39 跟踪实现 |
| getGlobalContext 浅拷贝（#31） | ✅ 改 structuredClone |

测试变化：删除失效的 context-manager-knowledge 测试 6 个，新增 state-machine 5 / context-manager 3 / base-agent 4 / review-policy 15 个，总计 206 个测试全部通过。

---

## 第七轮设计-实现一致性审计修复记录（2026-09-04）

对照 ADR-014 后最新设计逐文件审计已实现代码，发现并修复 11 项（#12 为规范边界澄清）。核心教训：206 测试全绿但未实现 Agent 的输入装配/上下文注入路径无测试覆盖，成为盲区。

| 编号 | 问题 | 处理 |
|---|---|---|
| #1 | globalContext 存入 ContextManager 后无任何代码取出，技术栈/团队规范到不了 Agent | ✅ GlobalContext 提至 agents/types 中立位置，AgentContext 加字段，Harness 每次注入并补测试 |
| #2 | DESIGN_REVIEWING/CODE_REVIEWING/CODING/DELIVERING 输入装配为空 `{}`，下游 Agent 拿不到上游产物 | ✅ ContextManager 补四类输入装配（含缺产物返回 undefined），补 4 个测试 |
| #3 | rebuild 多仓库、syncIncremental 增量更新漏传 projectScope，数据错误落 global，破坏多项目隔离 | ✅ rebuild 支持 RepoIndexTarget 带 scope（兼容字符串），增量透传 change.projectScope，补 3 个测试 |
| #4 | 需求冻结 checklist 八项硬编码 true | ✅ 新增 core/freeze-checklist.ts 按产物实际计算，补 5 个测试 |
| #5 | INVEST 自检四项硬编码 true | ✅ I/N/V/E 取 LLM 自评（prompt 要求输出，漏输出记 issue），Small/Testable 程序计算并覆盖，补 2 个测试 |
| #6 | 产物对象内部 instanceId 永远为空字符串 | ✅ Harness 保存前统一回填，补测试 |
| #7 | followup 在 v1 统一回答模式下每次误报 NO_ANSWERS | ✅ 改为 answers/humanAnswers 都空才 warning，补 2 个测试 |
| #8 | 三个评审/预算配置声明未消费；弱介入无超时可能无限挂起 | ✅ 构造函数消费全部配置并加 getter；弱介入回调与超时竞速（默认 30s，0 不超时），补测试 |
| #9 | handleHumanAnswer 澄清分支为不可达死代码且与 followup 重复 | ✅ 删除，方法仅保留硬卡点放行语义 |
| #10 | core/scheduler、state-manager、human-interaction、tools 6 个、observability metrics/tracer 共 11 个零引用空壳 | ✅ 删除空壳（设计职责保留在文档/next-steps），barrel 同步清理 |
| #11 | review-policy 空 if 块 | ✅ 删除 |
| #12 | RequirementAgent 是 8.3「禁止 if type 分发」的现存反例 | ✅ 规范补适用边界：约束只针对「同产物的生成 vs 修改」，跨阶段不同任务允许分发，RequirementAgent 判定合规 |

测试变化：新增 freeze-checklist 5、context-manager 4、knowledge-service 3、harness 3、requirement-agent 4，共 +19；总计 14 个测试文件、225 个测试全部通过。新增经验沉淀至 coding-standards 1.13/1.14/1.15，Checklist 架构组同步扩充。

---

## 第十四轮全面审查修复验证记录（2026-09-06 ~ 09-07）

第十四轮全方位深度审查（设计+代码+测试+业界对比 LangGraph / Temporal / Inngest）发现 12 项问题。本轮修复 6 项（3 P0 + 1 P2 + 2 文档/质量），剩余 6 项待后续迭代。另修复 #10（delivery prompts 目录）和 #45（冻结 checklist 重复判据）两个历史遗留问题。

| 编号 | 问题 | 处理 | 验证 |
|---|---|---|---|
| #57 | 交付标题恒为"未命名需求"（context-manager 取错 title 路径） | ✅ 改为 `get<StructuredRequirement>` + `requirement?.meta?.title` | 代码审查确认；315 测试全绿；**测试缺口**：DELIVERING 装配测试未保存 requirement 验证真实标题 |
| #58 | Git 命令注入风险（execSync 字符串拼接） | ✅ 改用 `execFileSync(gitPath, args, ...)` 数组参数，杜绝 shell 解析（含 isGitAvailable 方法） | 代码审查确认；315 测试全绿 |
| #59 | RequirementAgent perStory 质量检查硬编码通过 | ✅ 实现三项程序化检查：Small（AC 数 > 10）、Testable（testable=false 的 AC）、Independent（依赖未定义故事）；`passed = issues.length === 0` | 代码审查确认；315 测试全绿；**测试缺口**：无新增测试覆盖 perStory 三项检查 |
| #67 | 代码 CR 的 targetVersion 恒为 0 | ✅ 代码 CR 时取 `input.coding.version` | 代码审查确认；315 测试全绿 |
| #10 | delivery prompts 未移到 prompts 目录 | ✅ 新建 `src/prompts/delivery/`（system-prompts.ts + user-prompts.ts + index.ts），DeliveryAgent 加载模板，与其他 Agent 一致 | 代码审查确认；315 测试全绿 |
| #45 | 冻结 checklist 两项共用同一判据 | ✅ `rulesNoAmbiguity` 检查 ambiguous/contradictory 类阻塞问题，`globalRequirementsCovered` 检查 global-requirement 类阻塞问题，按 category 区分 | 代码审查确认；更新测试用例使用对应 category；315 测试全绿 |
| #60 | Harness 评审对话循环重复代码 | 🟡 未修复，v2 抽取 DialogRunner | — |
| #61 | getNextState 转换表与 state-machine 重复维护 | 🟡 未修复，v2 统一 source of truth | — |
| #62 | LLM 调用无超时控制 | 🟡 未修复，v2 LLMProvider 加 timeout | — |
| #63 | 死代码清理（9 处） | 🟡 部分修复：delivery-agent parseOutput 加了注释说明；其余 8 处未动 | — |
| #64 | file-system-client.ts async 方法用同步 API | 🟡 未修复，v2 改用 fs.promises | — |
| #65 | knowledge-service.ts 同步文件读取阻塞 | 🟡 未修复，v2 异步化 | — |
| #66 | CodingResult.status 与 overallStatus 命名不一致 | 🟡 未修复，v2 统一命名 | — |
| #68 | 测试工程化配置缺失（tsconfig 排除 tests / 无 coverage） | 🟡 未修复，v2 配合 #7 CI/CD 一并解决 | — |

测试变化：更新 freeze-checklist 测试用例使用对应 category，315 测试全部通过。

**经验教训**：
1. 修复必须配测试——#57 和 #59 的修复逻辑正确但无测试覆盖，下次重构可能回归
2. 类型断言是 Bug 温床——#57 的根因是 `get<{ title: string }>` 用自定义窄类型绕过了真实类型系统，应优先用领域类型 `StructuredRequirement`
3. 安全无小事——工具层执行外部命令必须用 `execFile` 而非 `exec`，这是业界通用安全规范（LangGraph 等均如此）
4. 代理判据需要区分度——#45 的教训：两个不同语义的检查项不能共用同一个代理判据，应按问题 category 等维度细分，否则 checklist 区分度丧失
5. Prompt 模板统一管理——#10 的教训：所有 Agent 的 prompt 应统一放在 `src/prompts/<agent>/` 目录，避免硬编码在 Agent 类内，便于版本管理和 A/B 测试
