# Forge 待解决问题

> 最后更新：2026-10-12
> 第十九轮修复（2026-10-12，用户指定 #47/#83/#85）：#83 真实测试执行落地（LocalSubprocessTestRunner：工作区落盘项目 .sandbox 真实跑 vitest 子进程、解析 JSON 输出还原真实通过/失败/失败原因，red 无实现→真实 import 解析失败、假测试真实全绿被 RED_SHOULD_FAIL 拦截、实现 bug→真实断言错误回流修复循环；vitest 不可用/超时降级 StaticTestRunner 并明确标注，fallbackToStatic=false 返回环境失败；`--test-mode static|subprocess` 可切换；单测 6 用例全绿）；#47 Harness 拆分瘦身（拆出 ReviewDialogRunner / CodingPhaseRunner / state-transitions 纯函数 / human-interaction 纯逻辑，Harness 保留门面+主循环+持久化，1561 行→约 950 行，行为零变化，全量 370 测试全绿）；#85 设计文档与实现同步（02-pipeline / 03-architecture / 06-storage / 07-observability / coding-standards / decisions-ADR / schema-state-machine / next-steps 全面标注"实现状态"，修正向量模型 2048 维、v1 文件系统+内存向量、TDD 真实执行、状态持久化 #82、飞书同步已落地等不一致）；顺带修复 vitest 全量扫描误收 .sandbox 调试残留（新增 vitest.config.ts exclude .sandbox/data/.tmp/output，.gitignore 追加忽略）。
> 已完成问题的经验教训已沉淀到 [开发规范](coding-standards.md)。
> 第十八轮全面设计审查（架构/流程/状态机/存储/可观测性 5 维度）：发现 25 个问题（4 严重 S1-S4 + 5 重要 I1-I5 + 6 建议 O1-O6 + 10 与已有合并）。其中 S1（技术方案输出超 LLM 能力，#81）、S3（预算控制未落地，#39/#46）、S4（Harness 1258 行职责过重，#47）、I2（回退成本高，#38）与已有问题合并并升级严重度；新增 S2（状态持久化未实现）、I1（TDD 是模拟的）、I3（知识库单例+质量缺失）、I4（设计文档与实现不同步）、I5（弱介入窗口设计不匹配）、O1-O6。删除已解决的 #9（CLI 入口）和第十六轮遗留中的 #79/#80。
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
> 第十五轮飞书文档同步调试：发现并修复 4 个关键问题——#69 飞书认证接口响应格式（顶层格式 vs data 包裹）、#70 obj_type 类型错误（数字 vs 字符串）、#71 多模态 Embedding API 适配（/embeddings/multimodal 端点）、#72 向量维度不一致（1024→2048）。同进程验证同步+检索成功，349 测试全绿。
> 第十六轮真实端到端验证（forge run CLI）：实现 run-cli 主流程入口（#73），用真实火山引擎 LLM（doubao-seed-evolving）跑通需求澄清阶段（14298 tokens，22 功能点正确提取）。发现并修复 5 个问题——#74 LLM 模型名大小写（404）、#75 maxTokens 不足（4096→16384）、#76 finishReason 未记录、#77 OpenAI 超时（默认 10 分钟→30 分钟）、#78 run-cli 未传 logger。新增 parseJsonWithRecovery JSON 解析恢复机制。Token 优化：#79 followup 改为增量输出（节省 90%+）、#80 故事拆解输出格式精简（减少 15-25%）、design revise 改为增量输出（预计节省 60-80%）。遗留：故事拆解分批处理待后续、完整端到端验证待重跑。
> 第十七轮性能优化与深度验证：#80 故事拆解完成分批并行处理（每批≤6 功能点，3 并发），输出结构大幅简化（去掉 qualityCheck/nfrMapping/storyMap，AC 限 2 条，INVEST 全部程序计算）。真实端到端验证：需求澄清 followup 增量模式实测 603 tokens/6.5 秒（降 93%），故事拆解 4 批并行 31 故事 9.6 分钟（降 76%）。发现新问题 #81：技术方案阶段输出结构过于复杂（页面+组件树+API+状态管理+NFR 方案），LLM 连续 2 次重试失败（组件引用不自洽、缺 stateManagement.principle、NFR 缺落地方案），需优化技术方案输出结构或校验逻辑。确认 #62：实际超时限制 15 分钟（设置 30 分钟未生效，可能是 SDK/网络/服务端限制）。

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
| **当前** | 已实现 StateMachine / Logger / Config / OpenAIProvider / BaseAgent（泛型执行器）/ RequirementAgent / DesignAgent（generate+revise）/ ReviewAgent（方案多轮+代码CR多轮）/ CodingAgent（单故事 TDD + revise）/ DeliveryAgent（场景判定+初始化+落盘+构建+Git+PR描述）/ Harness（多轮评审+逐故事编码+代码CR多轮+交付编排）/ ArtifactStore / ContextManager / KnowledgeService / VectorStore / ASTParser / EmbeddingProvider / review-policy / freeze-checklist / design-coverage / coding-planner/aggregator/validation / 编码工具层（Workspace/TestRunner）/ 交付工具层（FileSystem/Git/Build）/ 知识库 CLI，仅剩设计还原度图片比对为占位或待实现（真实子进程 runner 已于 #83 落地） |
| **计划** | 按 Agent 实现计划逐步填充：方案设计 Agent → 评审 Agent → 编码 Agent → 交付 Agent |
| **处理时机** | 持续进行中 |

#### #7 无 CI/CD 流水线

| 字段 | 内容 |
|------|------|
| **状态** | ⚪ 未解决 |
| **当前** | 无 .github/workflows/ 或其他 CI 配置 |
| **计划** | 配置基础 CI：`typecheck + lint + prettier-check + test`，在每次 push/PR 时自动运行 |
| **关联遗留** | forge doctor（验证配置/环境）尚未实现，可与 CI/CD 一并迭代 |
| **处理时机** | 有实际代码提交后（建议在 DesignAgent 实现完成后） |

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

#### #38 回退成本预警未实现（I2 重要，含增量更新需求）

| 字段 | 内容 |
|------|------|
| **状态** | ⚪ 设计已定，代码未实现 |
| **严重度** | 🟡 重要（第十八轮审查）— 一次回退可能导致大量已完成工作作废 |
| **说明** | ADR-014 要求人工触发回退前自动计算并展示将废弃的产物规模（如"N 个故事、M 个文件"）。Harness.fallback 当前直接执行回退 |
| **第十八轮审查补充** | 当前设计明确"回退后从目标状态重新执行，后续产物全部重新生成（v1 不做增量补丁）"。一次编码阶段发现方案问题回退到方案设计，所有已生成的代码（可能几十个文件）全部作废，需要重新走方案→评审→API确认→编码全流程，成本极高。建议：1. 优先实现回退成本预警（低成本高价值）；2. 中期实现增量更新：分析影响面，只重新生成受影响的故事/组件，而非全部重来 |
| **处理时机** | CodingAgent 实现后（有代码产物时预警才有实际价值），建议 v1 后期实现预警，v2 实现增量更新 |

#### #39 预算前置检查未在 LLM 调用链落地（S3 严重，合并 #46）

| 字段 | 内容 |
|------|------|
| **状态** | ✅ 已解决（2026-10-12 落地） |
| **严重度** | 🔴 严重（第十八轮审查升级）— 当前验证已估算消耗 190,000-220,000 tokens，无预算控制可能导致意外高额费用 |
| **说明** | config 已加 budget.maxTokensPerRun/maxTokensPerCall、HarnessConfig 已加 maxTokensPerRun 并保存，但 LLM 调用前的累计 token 检查和超限暂停尚未实现。#46（maxTokensPerRun 配置占位但无实际消费逻辑）是同一问题，合并到此 |
| **修复内容** | 1. 新增 `src/core/token-budget.ts` `TokenBudgetTracker`（isExceeded/remaining/add/checkPerCall）；2. `AgentContext` 增加 `tokenBudget`，Harness 构造 `TokenBudgetTracker(maxTokensPerRun, maxTokensPerCall)` 并注入全部 7 处 AgentContext（澄清 followup/主循环/方案评审 review+revise/编码/代码 CR review+revise）；3. `BaseAgent.runAgentCycle` LLM 调用链落地：调用前 `isExceeded` → `BUDGET_EXCEEDED`；调用后 `checkPerCall`（单次超限 → `CALL_LIMIT_EXCEEDED`）+ `add` 累计并 warn 触及上限；4. `run-cli` 传入 `config.budget.maxTokensPerRun/maxTokensPerCall`（默认 0=不限）。单测 `tests/unit/token-budget.test.ts` 6 用例通过 |
| **遗留** | 预算超限走 Agent 失败路径而非原方案 SUSPENDED 暂停（语义差异，v2 可选改）；CLI 未提供 `--budget` 参数覆盖配置 |

#### #41 ContextManager 进一步瘦身为纯产物读取

| 字段 | 内容 |
|------|------|
| **状态** | 💡 设计讨论 |
| **说明** | ADR-014 已移除其检索职责，但 buildAgentInput 的 switch 仍知道每个 Agent 的输入结构（中心耦合点，#17 同源问题）。终极形态：ContextManager 只提供 getArtifacts，Agent 自己决定消费哪些产物。v1 保持现状，避免过度重构 |
| **处理时机** | 3 个以上 Agent 实现后评估 |

#### #47 Harness 类持续膨胀（S4 严重，实测 1258 行，超 500 行阈值）

| 字段 | 内容 |
|------|------|
| **状态** | ✅ 已解决（2026-10-12 落地） |
| **严重度** | 🔴 严重（第十八轮审查升级）— 1258 行远超 500 行阈值，且持续膨胀 |
| **位置** | `src/core/harness.ts` |
| **设计约定** | "当 Harness 类超过 500 行或需要独立测试调度逻辑时"拆分为 Scheduler / HumanInteraction / StateManager |
| **现状** | 实测 1258 行（2026-09-07），远超 500 行阈值。Harness 已承担 9 项职责：状态机执行、Agent 调度、产物管理、弱介入窗口、回退、取消、方案评审多轮对话、编码逐故事循环、代码 CR 多轮对话、交付阶段编排、人工介入管理 |
| **风险** | 类过大导致可维护性下降，修改一个功能可能影响其他；测试困难，难以独立测试调度逻辑或人工介入逻辑；新功能（并行执行、预算控制）不断加入，膨胀加速 |
| **第十八轮审查建议** | 立即拆分至少两个类：1. **ExecutionScheduler**（Agent 调度+状态流转+产物管理）；2. **HumanInteractionManager**（硬卡点+弱介入+挂起恢复+取消）。Harness 保留为门面，组合上述类。拆分后每个类 < 500 行，可独立测试。评审对话循环（design-review + code-review）可进一步抽取为 DialogRunner（见 #60），这是 Harness 瘦身的第一步 |
| **修复内容** | 2026-10-12 完成拆分：1. `src/core/review-dialog.ts` `ReviewDialogRunner`（方案评审+代码 CR 两套多轮对话 8 个方法，deps 共享依赖 + callbacks 回调注入，无循环依赖）；2. `src/core/coding-phase.ts` `CodingPhaseRunner`（逐故事 TDD 编排 + 部分成功弱介入 + 三分支出口）；3. `src/core/state-transitions.ts`（getNextState/getArtifactStage/getAgentForState/stateToStage 纯函数，单一事实来源）；4. `src/core/human-interaction.ts`（buildBlockingQuestion/handleHumanAnswer/invokeWeakIntervention 纯逻辑）。Harness 保留门面：构造/start/resume/fallback/cancel/continueFromSnapshot/主执行循环/状态持久化，1561 行→约 950 行。行为零变化（#47 纯重构），全量 370 测试 29 文件全绿。评审对话循环重复代码问题（#60）随之部分缓解（两套循环仍在 ReviewDialogRunner 内，未进一步泛化） |
| **处理时机** | 已完成；后续如需进一步瘦身可继续抽取 ExecutionScheduler / 泛化 DialogRunner（#60） |

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
| **状态** | 🟡 部分修复（第十六轮设置 30 分钟，第十七轮确认实际生效 15 分钟） |
| **修复** | OpenAIProvider 构造函数中设置 `timeout: 30 * 60 * 1000`（30 分钟），覆盖大输出量场景（故事拆解、技术方案） |
| **实际限制** | 第十七轮验证确认：即使设置 30 分钟，实际超时仍为 **15 分钟**（可能是 OpenAI SDK 内部限制、网络层超时、或火山引擎服务端限制）。8+ 功能点的故事拆解和完整技术方案输出都会触发 15 分钟超时 |
| **应对策略** | 1. 每批输出量控制在 15 分钟内能完成的范围（故事拆解每批≤6 功能点）；2. 大输出量场景分批并行处理；3. 简化输出结构减少 token 量 |
| **遗留** | 超时时间硬编码为 30 分钟，后续可配置化；BaseAgent 层面的超时熔断尚未实现；15 分钟实际超时的根因待排查（SDK 版本/网络/服务端） |

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

### 第十八轮全面设计审查发现（架构/流程/状态机/存储/可观测性，2026-09-12）

#### #82 状态持久化未实现，长流程崩溃即全部作废（S2 严重）

| 字段 | 内容 |
|------|------|
| **状态** | ✅ 已解决（2026-10-12 落地） |
| **严重度** | 🔴 严重 — 当前端到端验证已跑 30+ 分钟，进程崩溃则所有进度丢失 |
| **位置** | `src/core/harness.ts` + `src/core/state-machine.ts` |
| **设计要求** | 06-storage.md 和 schema/00-state-machine.md 均要求"每次状态变更原子写入数据库 + state.json 快照"，Harness 重启时扫描未完成实例并恢复 |
| **现状** | v1 只有内存版 StateMachine，PostgreSQL 持久化完全未实现，state.json 快照也未实现 |
| **影响** | 完整流程可能耗时 1-2 小时（需求澄清+故事拆解+技术方案+编码+CR+交付），如果进程崩溃或机器重启，所有进度丢失，必须从头重跑。当前验证已卡在技术方案阶段，如果修复后重跑又崩溃，成本极高 |
| **修复内容** | 1. 新增 `src/core/state-snapshot.ts`：`FileSystemArtifactStore`（产物内存+磁盘双写、原子写、构造时从磁盘加载恢复）与状态快照 save/load/isTerminalSnapshot；2. `StateMachine` 增加可选 `onStateChange` 回调（8 个转换分支 + pauseForHuman/markRunning/incrementRetry 全部触发）；3. Harness 构造时默认 `FileSystemArtifactStore(data/instances/{instanceId}/artifacts)`，每次状态变更原子写 `state.json`，启动时检测快照恢复状态机；4. 新增 `Harness.continueFromSnapshot()`（终态直返 / waiting_human 返等待 / running 按当前状态续跑）与 `restoredFromSnapshot` 标记；5. run-cli 新增 `--resume <instanceId>` 从快照续跑。单测 `tests/unit/state-snapshot.test.ts` 9 用例通过（含重启恢复硬卡点续跑、终态直返） |
| **遗留** | running 态崩溃恢复=从当前状态重新执行该阶段（不保证阶段内幂等，阶段执行中 crash 可能重复部分 LLM 调用）；PostgreSQL 持久化推迟到 v2 |

#### #83 编码阶段 TDD 是"模拟"的，无法真正验证代码逻辑（I1 重要）

| 字段 | 内容 |
|------|------|
| **状态** | ✅ 已解决（2026-10-12 落地） |
| **严重度** | 🟡 重要 — TDD 的核心价值（红/绿循环验证代码逻辑）在 v1 中是模拟的 |
| **位置** | `src/tools/static-test-runner.ts` + `src/agents/coding-agent.ts` |
| **现状** | v1 用 StaticTestRunner 静态推断测试结果（依据文件齐备性/AC 引用/用例计数），明确标注"未真实执行测试命令"。#52（用例计数正则简单）和 #53（AC 覆盖纯字符串包含）是其衍生问题 |
| **影响** | 静态推断只能验证"文件存在"和"AC 被引用"，无法验证测试是否真的通过、代码逻辑是否正确。可能产生"假通过"——生成的代码实际有 bug 但标记为成功。TDD 的 red/green 循环（先写测试确认失败，再写实现确认通过）完全是模拟的 |
| **建议** | 1. 优先实现 LocalSubprocessTestRunner（设计中已规划为 v2 可替换实现），真正调用 vitest 运行测试，解析测试输出（通过/失败/错误信息）；2. 如果真实运行环境复杂，至少实现 ScriptableTestRunner：根据测试文件内容推断测试结果，比纯静态推断更准确；3. 在交付说明中明确标注"测试未真实执行"，避免误导；4. red 阶段必须确认测试失败（当前静态推断可能直接标记通过，失去反假测试的意义） |
| **修复内容** | 新增 `src/tools/local-subprocess-test-runner.ts` `LocalSubprocessTestRunner`：1. 工作区文件落盘到项目根 `.sandbox/tdd-*` 临时目录（系统临时目录会导致 import 'vitest' 无法向上解析）；2. 写 vitest.config 并 spawn 真实 vitest 子进程（`--reporter=json --outputFile`，60s 超时）；3. 解析 JSON：断言结果统计 + 收集级失败（import 解析失败等，testResults[].status=failed+message）折算为失败项；4. 环境不可用/超时/无有效输出 → 降级 StaticTestRunner 并明确标注"降级静态推断"；`fallbackToStatic=false` 返回环境失败；5. CLI 默认 subprocess，`--test-mode static` 切回静态快速通道。真实语义：red 无实现→真实 'Cannot find module' 失败；假测试→真实全绿被 RED_SHOULD_FAIL 拦截；实现 bug→真实断言错误（expected -1 to be 3）回流修复。单测 6 用例全绿；#52/#53（静态 runner 衍生问题）随默认切换为真实执行而降级为仅静态通道的已知限制 |
| **处理时机** | 已完成；后续可扩展：jsdom 环境、测试覆盖率收集、与交付构建联动 |

#### #84 知识库单例无法支持多项目，且质量保证机制缺失（I3 重要）

| 字段 | 内容 |
|------|------|
| **状态** | ⚪ 未解决 |
| **严重度** | 🟡 重要 |
| **位置** | `src/services/knowledge-service.ts` |
| **问题1：单例多项目污染** | KnowledgeService 是单例，设计理由是"团队级跨项目复用"。但实际无法同时索引多个代码仓库——单例内部只有一个 VectorStore 实例，索引第二个仓库时会覆盖或混合第一个仓库的数据。虽然有 projectScope 过滤，但索引操作本身是全局的 |
| **问题2：质量保证缺失** | 知识库从飞书文档同步、代码反解析，但没有内容质量检查机制：文档过期检测、重复内容去重、向量质量评估、低质量条目标记。设计讨论过"不通过人工方式保证知识库内容正确"，但最终方案不明确 |
| **问题3：检索策略单一** | v1 只有向量检索，BM25 关键词检索和 Rerank 都未实现（#33 是 query 构造粗糙的衍生问题）。纯向量检索对精确匹配（API 名、组件名）效果差 |
| **建议** | 1. 将单例改为"知识库实例池"：团队级知识库（飞书文档）单例 + 项目级代码索引按 projectId 隔离，每个项目有独立的 VectorStore 实例；2. 增加知识库质量检查 CLI：`forge kb audit` 检测过期文档、重复内容、低质量向量；3. 优先实现 BM25 关键词检索（PostgreSQL 全文检索或本地实现，成本低），与向量检索混合；4. 建立知识库内容的生命周期管理：新增/更新/过期/废弃状态 |
| **处理时机** | 知识库接入真实项目前，建议 v1 后期处理单例问题，v2 处理质量保证 |

#### #85 设计文档与实现严重不同步（I4 重要）

| 字段 | 内容 |
|------|------|
| **状态** | ✅ 已解决（2026-10-12 落地） |
| **严重度** | 🟡 重要 — 设计文档作为团队共识基础，不同步会导致后续开发基于错误假设 |
| **位置** | `docs/` 目录下所有设计文档 |
| **不一致清单** | 1. **向量模型/维度**：06-storage.md 说用通义 Qwen3-Embedding 1024 维，实际用火山引擎 doubao-embedding-vision-251215 2048 维多模态（#72 已修复配置但文档未更新）；2. **存储三件套**：06-storage.md 说 v1 用 PostgreSQL + pgvector + 文件系统，实际只有内存版 VectorStore + 文件系统；3. **可观测性四层**：07-observability.md 说四层体系，实际只实现了日志层（Logger），Tracer/Metrics/质量分析都待实现；4. **状态持久化**：06-storage.md 和 schema/00-state-machine.md 要求原子写入数据库+快照，实际未实现（#82）；5. **多个文档标注"v1 已实现"但实际有差距** |
| **影响** | 新成员阅读设计文档后会对系统能力产生错误预期；后续开发基于设计文档的假设可能与实际实现冲突；审查时难以判断"设计如此"还是"实现偏差" |
| **建议** | 1. 建立设计文档更新机制：每次代码变更后同步更新对应设计文档，或在 PR 模板中增加"设计文档是否需要更新"检查项；2. 优先更新 06-storage.md 中的向量模型和维度（这是会导致表结构错误的关键参数）；3. 在每个设计文档末尾增加"实现状态"表格，明确哪些已实现、哪些待实现、实际值是什么（07-observability.md 已有此模式，推广到其他文档）；4. 定期（每轮审查后）做一次设计-实现一致性审计 |
| **修复内容** | 2026-10-12 完成 8 份文档同步（docs/02-pipeline、03-architecture、06-storage、07-observability、coding-standards、decisions/README、schema/00-state-machine、next-steps）：1. 06-storage.md 重构为"目标态 vs v1 实际"（PostgreSQL+pgvector 标注 v2 目标，v1=文件系统+内存向量库，向量模型修正为 Doubao-embedding-vision 2048 维，数据分类表加"v1 实际"列，崩溃恢复标注 #82 已落地）；2. 03-architecture 存储层/VectorStore/知识库 CLI/编码 Agent 标注实现状态（飞书同步、真实子进程 runner 提前落地）；3. 02-pipeline 与 coding-standards 更新 TDD 真实执行（LocalSubprocessTestRunner 默认+降级语义）；4. 07-observability 标注 Tracer/Metrics 目标态、预算控制 #39 已落地；5. decisions ADR-004/ADR-012 补"实践变更"记录（存储收敛、向量模型切换、飞书同步提前）；6. schema 状态持久化标注 #82 已实现；7. next-steps 更新进度（#81/#39/#82/#83 ✅，待办 #47 已完成/#84/#86/#38）。后续机制：每轮代码变更后同步更新设计文档（PR 检查项） |
| **处理时机** | 已完成；后续迭代保持"实现状态"标注机制 |

#### #86 弱介入窗口设计与实际使用场景不匹配（I5 重要）

| 字段 | 内容 |
|------|------|
| **状态** | ⚪ 未解决 |
| **严重度** | 🟡 重要 |
| **位置** | `src/core/harness.ts`（弱介入窗口逻辑） |
| **设计** | 弱介入窗口 30 秒，超时自动继续。故事拆解/方案评审/代码 CR 后触发 |
| **问题** | 1. **30 秒太短**：对于人工审阅复杂产物（如技术方案、代码 CR 结果），30 秒可能来不及看就自动推进了；2. **自动化场景下意义不大**：实际端到端验证用 `--auto-confirm` 自动确认所有卡点，弱介入窗口在自动化模式下被跳过；3. **没有区分"人工模式"和"自动模式"**：设计中没有明确哪些节点在自动模式下应该跳过弱介入；4. **CODING 部分失败的弱介入不自动推进**：设计说"不自动推进（必须人工决策）"，但这与其他节点的"超时自动继续"不一致 |
| **建议** | 1. 弱介入窗口超时时间可配置，默认延长到 60-120 秒；2. `--auto-confirm` 模式下直接跳过弱介入窗口，不等待（当前可能已经是这样，但需要明确文档化）；3. 区分"硬卡点"（必须人工，如 API 确认、交付确认）和"弱介入"（可自动跳过，如故事拆解后、评审通过后），在配置中明确哪些节点启用弱介入；4. CODING 部分失败的弱介入建议也支持超时自动决策（默认带着失败继续 CR，交付时标记 incomplete），与其他节点保持一致 |
| **处理时机** | v1 后期，建议在完整端到端验证跑通后根据实际使用体验调整 |

#### #87 缺乏性能基准和容量规划（O1 建议）

| 字段 | 内容 |
|------|------|
| **状态** | 💡 建议优化 |
| **说明** | 设计没有定义各阶段的预期耗时、token 消耗、输出量。当前验证中故事拆解 40 分钟、技术方案超时都是"意外"。如果有性能基准可以提前发现问题 |
| **建议** | 建立性能基准文档，标注每个阶段的预期输出量、耗时、token，作为优化目标和回归测试依据。例如：需求澄清 followup < 1000 tokens/10 秒；故事拆解每批 < 6 功能点/10 分钟；技术方案 < 15000 tokens/15 分钟 |
| **处理时机** | 完整端到端验证跑通后，基于实测数据建立基准 |

#### #88 错误处理和兜底策略不具体（O2 建议）

| 字段 | 内容 |
|------|------|
| **状态** | 💡 建议优化 |
| **说明** | 设计说"具体策略在遇到时定义"（02-pipeline.md 兜底策略部分），各阶段的最大重试次数、超时时间、降级策略都未明确 |
| **建议** | 在设计文档中明确每个阶段的：最大重试次数、超时时间、重试耗尽后的降级策略（暂停/部分交付/失败）。兜底策略是 AI 系统可靠性的关键，"遇到时再定"可能导致关键时刻无策略可用 |
| **处理时机** | 下一轮设计迭代 |

#### #89 安全性设计缺失（O3 建议）

| 字段 | 内容 |
|------|------|
| **状态** | 💡 建议优化 |
| **说明** | 设计没有系统性的安全设计：API Key 管理、敏感数据脱敏、代码生成的安全约束（禁止硬编码密钥、禁止危险 API）。虽然 CR 维度有安全检查（XSS、硬编码密钥），但属于后置检查 |
| **建议** | 增加安全设计章节：1. 前置约束（prompt 中注入安全规则，禁止生成硬编码密钥、危险 import）；2. 后置扫描（生成代码后自动检测硬编码密钥、危险 API、SQL 注入模式）；3. 密钥管理（.env 不入库、配置校验、日志中脱敏 API Key） |
| **处理时机** | v2，建议在系统有真实用户前完成 |

#### #90 可测试性设计不足（O4 建议）

| 字段 | 内容 |
|------|------|
| **状态** | 💡 建议优化 |
| **说明** | 复杂的多轮对话、状态机转换、Agent 调度逻辑缺乏可测试性设计。当前 349 个测试主要是单元测试，集成测试和端到端测试覆盖不足 |
| **建议** | 1. 为 Harness 调度逻辑提供可测试的钩子（如注入 Mock Agent、模拟状态转换）；2. 增加集成测试覆盖完整流程（用 Mock LLM 跑通 7 个阶段）；3. 为多轮对话建立测试用例库（评审通过、评审打回、达最大轮次等场景） |
| **处理时机** | 持续进行，建议每轮迭代增加集成测试覆盖 |

#### #91 可观测性四层体系 v1 只实现了一层（O5 建议）

| 字段 | 内容 |
|------|------|
| **状态** | 💡 建议优化 |
| **说明** | 07-observability.md 设计有四层（日志、链路追踪、指标、质量成本分析），v1 只实现了日志（Logger）。长流程调试缺乏链路追踪和指标，当前只能靠日志文件手动分析，效率低 |
| **建议** | 1. 优先实现链路追踪（span 记录，成本低价值高）：每个阶段记录开始/结束时间、状态、输入摘要、输出产物路径；2. 实现基本指标聚合：流程结束时写入 JSON 指标文件（总耗时、各阶段耗时、token 消耗、成功率）；3. 提供 CLI 命令查看指标：`forge stats --instance xxx` |
| **处理时机** | v1 后期，建议在完整端到端验证跑通后实现链路追踪 |

#### #92 Agent 无状态设计与多轮对话需求矛盾（O6 建议）

| 字段 | 内容 |
|------|------|
| **状态** | 💡 建议优化 |
| **说明** | 设计说 Agent 无状态，每次调用接收完整输入。但评审多轮对话需要维护对话历史（Reviewer 和 Designer/Coder 的多轮交互），编码阶段需要维护当前故事索引和测试运行状态。这些状态被推到了 Harness，增加了 Harness 复杂度（#47） |
| **建议** | 明确"无状态"的边界——Agent 本身不持有流程状态，但可以接收包含历史的上下文输入；多轮对话的历史管理由专门的 DialogManager 负责（设计中已提到抽取 DialogRunner #60）。Agent 保持无状态有利于测试和替换，但上下文装配逻辑需要清晰归属 |
| **处理时机** | 与 #47 Harness 拆分和 #60 DialogRunner 抽取一并处理 |

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

---

## 第十五轮飞书文档同步端到端调试（2026-09-10）

目标：打通飞书 Wiki → 文档拉取 → 分块 → 向量化 → 入库 → 检索完整链路。调试过程中发现并修复 4 项 API 适配问题，确认 1 项 v1 已知限制。

| 编号 | 问题 | 根因 | 处理 | 验证 |
|---|---|---|---|---|
| #69 | 飞书认证失败，tenant_access_token 为 undefined | 飞书 `/auth/v3/tenant_access_token/internal` 接口响应是顶层格式 `{ code, msg, tenant_access_token, expire }`，与其他 API 的 `{ code, msg, data: {...} }` 不同；通用 request 方法按 data 包裹解析取到 undefined | `getAccessToken` 单独处理，直接 fetch 并解析顶层响应 | 认证成功，后续 API 调用正常 |
| #70 | 所有 Wiki 节点被跳过，文档同步数为 0 | 原代码假设 `obj_type` 是数字（2=Doc, 22=Docx），实际飞书 API 返回字符串（'doc'/'docx'/'sheet'/'bitable'/'folder'），数字判断恒为 false | WikiNode 接口、getDocumentContent、FeishuSyncService 筛选逻辑全部改为字符串判断 | 1 个 docx 文档成功同步 |
| #71 | 多模态 Embedding API 调用 400 错误 | 火山引擎 `doubao-embedding-vision-251215` 仅支持 `/embeddings/multimodal` 端点，不支持标准 `/embeddings`；请求体格式为 `{ model, input: [{ type: 'text', text }] }`，响应体 `data` 是单个对象 `{ embedding, object }` 而非数组 | OpenAIEmbeddingProvider 新增 `isMultimodalModel` 检测，模型名含 'vision' 时自动切换端点、请求体和响应解析 | 2048 维向量成功返回 |
| #72 | EMBEDDING_DIMENSIONS 配置 1024 与模型实际输出 2048 不一致 | 多模态模型默认输出 2048 维，配置沿用旧文本模型的 1024 | .env 和 .env.example 更新为 2048 | 配置与实际输出一致 |
| #73 | CLI `kb sync-feishu` 后 `kb search` 搜不到任何内容 | v1 使用 InMemoryVectorStore，无持久化；CLI 每次调用是独立进程，sync 进程退出后向量数据丢失 | **v1 已知限制**：验证需用同进程脚本；v2 切换 pgvector 持久化解决 | 同进程验证脚本检索成功（4 个查询均返回正确结果） |

**端到端验证结果**：同进程脚本验证完整链路成功——1 个文档、1 个分块、0 失败；4 个查询（首页/知识库/文档/forge）均返回正确结果，相似度分数合理（0.07~0.27）。全量 349 测试通过。

**经验教训**：
1. **第三方 API 响应格式不能假设统一**——飞书认证接口与业务接口响应格式不同（顶层 vs data 包裹），多模态 Embedding 与标准 Embedding 响应格式不同（单对象 vs 数组），必须逐个接口验证实际响应
2. **枚举类型必须查官方文档**——飞书 obj_type 从数字改为字符串是 API 版本演进，不能凭印象假设，应在集成时打印原始响应确认
3. **模型 ID 不是显示名称**——火山引擎控制台显示 "Doubao-embedding"，实际 API 调用需要具体 Model ID（如 `doubao-embedding-vision-251215`），显示名称会 404
4. **无状态 CLI 与内存存储不兼容**——v1 内存向量库仅适用于单进程长驻服务（如 Harness 运行时），CLI 工具需要持久化或同进程验证；v2 pgvector 是必须项
5. **调试脚本必须及时清理**——本轮产生 7 个临时调试脚本，验证完成后全部删除，避免污染代码库

---

## 第十六轮真实端到端验证（forge run CLI，2026-09-10）

目标：用真实火山引擎 LLM（doubao-seed-evolving）跑通从 PRD 到代码的完整端到端流水线。实现 `forge run` CLI 主流程入口，验证需求澄清→故事拆解→技术方案→编码→CR→交付全链路。

### 已修复问题

| 编号 | 问题 | 根因 | 修复 |
|---|---|---|---|
| #74 | LLM 调用 404：`The model or endpoint Doubao-Seed-Evolving does not exist` | 用了显示名称（驼峰式）而非具体 Model ID | .env 更新为 `doubao-seed-evolving`（全小写） |
| #75 | 需求澄清输出被截断，非功能需求/澄清问题丢失 | `LLM_MAX_TOKENS=4096` 不足，实际输出需 7000-14000 tokens | .env 更新为 `16384` |
| #76 | LLM 调用日志中 finishReason 为 unknown | LLMCallLog 接口缺少 finishReason 字段，OpenAIProvider 未传入 | LLMCallLog 新增 finishReason 字段，OpenAIProvider 传入 result.finishReason |
| #77 | 故事拆解阶段 LLM 调用超时（Request timed out） | OpenAI SDK 默认超时 10 分钟，大输出量场景生成时间更长 | OpenAIProvider 设置 `timeout: 30 * 60 * 1000`（30 分钟） |
| #78 | run-cli 未传递 logger 给 LLM provider，LLM 调用日志未写入 | createLLMProvider 调用时未传 options.logger | run-cli 中 `createLLMProvider(config.llm, { logger })` |

### 新增机制

- **parseJsonWithRecovery**：BaseAgent 新增 JSON 解析恢复方法，处理 LLM 输出被截断/尾部不完整/多余逗号等常见格式错误。策略：直接解析 → 截断不完整尾部并补全闭合括号 → 删除尾部多余逗号。RequirementAgent/DesignAgent/ReviewAgent/CodingAgent 全部改用此方法。
- **--auto-confirm 选项**：run-cli 新增非交互模式，自动确认所有硬卡点，适合端到端验证和 CI 环境。

### 遗留问题

#### #81 技术方案阶段输出结构过于复杂导致重试失败（S1 严重）

| 字段 | 内容 |
|------|------|
| **状态** | ✅ 已解决（2026-10-12 落地，采用放宽校验方案 A） |
| **严重度** | 🔴 严重 — 当前端到端验证卡点，无法推进到编码 |
| **位置** | `src/agents/design-agent.ts`（generate 分支）+ `src/prompts/design/` |
| **现象** | 真实端到端验证中，技术方案第一次输出 17,048 tokens/9.9 分钟，但校验失败（大量页面引用未定义组件、缺 stateManagement.principle、NFR 缺落地方案）；第 1 次重试 15 分钟超时；第 2 次重试 16,573 tokens/22.5 分钟，仍校验失败（组件命名风格改变但引用仍不自洽）。连续 2 次重试失败，无法推进到方案评审阶段 |
| **根因** | 技术方案要求 LLM 一次性输出完整且自洽的结构：页面树（pages）+ 组件定义（components，含 children 引用）+ API 契约 + 状态管理 + NFR 落地方案。输出量巨大（~17,000 tokens）且需要跨字段自洽（页面引用的组件必须在 components 中定义，组件 children 引用也必须存在），LLM 难以一次完成 |
| **校验错误分类** | 1. 组件引用不自洽（占 80%+）：页面 p-login/p-register/p-chat/p-settings 等引用了 c010-c050/C-email-password-form 等未定义组件；组件 children 也引用未定义组件；2. 缺少 stateManagement.principle（全局状态与局部状态划分原则）；3. NFR 缺落地方案（3 个 performance 需求无实现方案） |
| **第十八轮审查补充** | 这是设计层面的问题——设计没有考虑 LLM 的输出能力限制。复杂自洽结构应该分阶段生成或放宽校验，而非要求 LLM 一次性完成。参考故事拆解的优化经验（分批并行+输出简化），技术方案也应采用类似策略 |
| **可选优化方向** | A. **放宽校验规则（推荐，快速，1-2天）**：组件引用不存在时降级为 warning 而非 error，允许编码阶段补全；stateManagement.principle 缺失时给默认值；NFR 缺方案时标记为待补充而非阻断；B. **分阶段生成（中期）**：先生成页面/组件列表（轻量），再逐模块生成组件详情（类似故事拆解分批）；C. **简化输出结构（长期）**：去掉组件 children 引用校验，改为扁平组件列表，页面只引用组件 ID 不要求预定义；D. **prompt 优化**：明确要求组件必须先定义再引用，或提供组件定义模板减少遗漏 |
| **修复内容** | 采用方案 A（放宽校验）：`design-agent.ts` validateDesignStructure 中 `BROKEN_COMPONENT_REF` / `BROKEN_CHILD_REF` / `NO_STATE_MANAGEMENT_PRINCIPLE` 由 error 降级为 warning（保留 NO_PAGES / NO_COMPONENTS 为 error，NFR_WITHOUT_SOLUTION 本就是 warning），允许编码阶段补全引用与默认状态管理原则；同步更新 `tests/unit/design-agent.test.ts` 两个断言期望。design-agent 单测 15 个通过。方案 B（分阶段生成）留作 v2 长期优化 |
| **遗留** | 组件引用不自洽仍会在技术方案中留下 warning（不阻断流程，编码阶段需补全）；真实端到端验证需重跑确认技术方案阶段可推进 |

### 端到端验证进展（第十七轮，2026-09-11）

| 阶段 | 状态 | 说明 |
|---|---|---|
| 需求澄清（第一次） | ✅ 成功 | 12,196 tokens，8.7 分钟，22 功能点正确提取 |
| 需求澄清（followup） | ✅ 成功 | **603 tokens，6.5 秒**（增量模式，降 93%），所有澄清问题回答 |
| 故事拆解 | ✅ 成功 | **4 批并行，31 故事，9.6 分钟**（降 76%），总 token 42,640 |
| 技术方案 | ❌ 重试失败 | 第一次 17,048 tokens/9.9 分钟校验失败；第 1 次重试 15 分钟超时；第 2 次重试 16,573 tokens/22.5 分钟仍校验失败（#81） |
| 方案评审 | ⏳ 未开始 | 依赖技术方案完成 |
| API 确认 | ⏳ 未开始 | |
| 逐故事 TDD 编码 | ⏳ 未开始 | |
| 代码 CR | ⏳ 未开始 | |
| 交付落盘 | ⏳ 未开始 | |

**本轮优化效果汇总**：
- 需求澄清 followup：9,255→603 tokens（降 93%），3.7 分钟→6.5 秒
- 故事拆解：串行 40+ 分钟→并行 9.6 分钟（降 76%）
- 故事拆解每批 token：~16,862→~10,000-14,000（降 15-40%）
- 前三个阶段总耗时：~50 分钟→~19 分钟（降 62%）

### 经验教训

1. **模型 ID 必须用具体 ID 而非显示名称**——火山引擎控制台显示 "Doubao-Seed-Evolving"，API 调用需要全小写 `doubao-seed-evolving`，显示名称 404。这是本轮第二次遇到（第一次是 Embedding 模型），应在配置文档中明确标注
2. **maxTokens 必须按实际输出量设置**——需求澄清输出 14000 tokens，远超默认 4096。应在设计文档中为每个 Agent 阶段标注预期输出量，据此设置 maxTokens
3. **LLM 输出 JSON 格式不稳定是常态**——即使 prompt 要求"严格 JSON"，LLM 仍可能在数组中间出现格式错误或被截断。parseJsonWithRecovery 能部分解决，但根本解决方案是减小单次输出量（分批处理）
4. **followup 阶段的 prompt 设计需要明确全量 vs 增量**——"根据人工回答完善需求"的表述模糊，LLM 可能输出增量而非全量，导致解析失败。应明确要求"输出完整的需求结构，包含所有字段"
5. **大输出量场景必须设置合理超时**——OpenAI SDK 默认 10 分钟超时对故事拆解/技术方案等大输出量场景不够，应设置 30 分钟或更长，并考虑分批处理减小单次输出量
6. **端到端验证必须有兜底机制**——Harness 的"澄清 followup 失败直接推进"兜底逻辑在本轮发挥了关键作用，避免了单个阶段失败导致整个流程中断。各阶段都应有类似的降级/兜底策略
7. **followup/revise 阶段应采用增量输出而非全量输出**——需求澄清 followup 和方案修订 revise 都只需要更新部分字段，要求 LLM 输出完整结构会导致 80-90% 的 token 浪费。正确做法：prompt 要求只输出变更字段，代码深拷贝上一版并合并增量，同时兼容全量输出（LLM 不听话时仍能处理）
8. **LLM 自评估字段可以去掉**——qualityCheck.invest 等 LLM 自评估字段质量不高且增加输出量，应由代码层做程序化检查（如 AC 数量、功能点覆盖度），LLM 只输出业务内容
9. **prompt 模板简化需谨慎**——JSON 结构示例对 LLM 输出格式准确性很重要，简化为只列字段名可能导致格式错误和重试浪费。当前示例已较简洁，不建议进一步简化
10. **大输出量场景必须分批并行处理**——故事拆解 22 功能点单批次 15 分钟超时，拆分为 4 批（每批≤6 功能点）并行后总耗时 9.6 分钟。分批阈值需根据实测调整：6 功能点约 3-10 分钟（安全），8 功能点约 15 分钟（超时边界）。并行度建议 3（避免 API 限流）
11. **LLM 自评估字段应全部去掉，由程序计算**——qualityCheck.invest 等 LLM 自评估字段质量不高且增加输出量。第十七轮将 INVEST 全部改为程序计算（independent: 无 dependencies；negotiable: 默认通过；valuable: benefit 非空；estimable: 有 AC；small: AC≤5；testable: 所有 AC 可测试），输出量减少且结果更可信
12. **复杂自洽结构的输出需要分阶段或放宽校验**——技术方案要求页面+组件树+API+状态管理+NFR 方案一次性输出且跨字段自洽（页面引用的组件必须已定义），LLM 连续 2 次重试失败。对于这类复杂结构，应考虑：①分阶段生成（先生成列表再生成详情）；②放宽校验（引用不存在时给 warning 而非 error）；③简化输出结构（去掉 children 引用校验）
13. **实际超时限制可能与设置值不一致**——设置 OpenAI timeout 为 30 分钟，但实际 15 分钟就超时（可能是 SDK/网络/服务端限制）。必须通过实测确认实际超时限制，并据此设计分批阈值，不能仅凭配置值假设
14. **增量输出模式效果显著但需兼容全量输出**——需求澄清 followup 改为增量输出后，token 从 9,255 降到 603（降 93%），时间从 3.7 分钟降到 6.5 秒。但 LLM 可能不听话仍输出全量，parse 逻辑必须兼容两种模式（深拷贝 previous 合并增量，同时支持全量覆盖）
15. **验收标准简化为字符串可大幅减少输出量**——将 acceptanceCriteria 从复杂对象（id/given[]/when/then[]/scenarioType/testable）简化为字符串数组（2 条），程序解析为完整结构。每批输出量减少 15-40%，且 LLM 更易遵循格式要求

---

## 第十八轮全面设计审查（架构/流程/状态机/存储/可观测性，2026-09-12）

以 AI 技术专家视角通读 5 个核心设计文档（03-architecture / 02-pipeline / schema/00-state-machine / 06-storage / 07-observability），发现 25 个问题（4 严重 + 5 重要 + 6 建议 + 10 与已有合并）。

### 问题汇总与处理

| 编号 | 问题 | 严重度 | 处理 |
|------|------|--------|------|
| S1 | 技术方案输出结构超 LLM 能力（页面+组件树+API+状态管理+NFR 一次性输出且跨字段自洽） | 🔴 严重 | 合并 #81，升级严重度，补充 4 个优化方向（推荐 A 放宽校验） |
| S2 | 状态持久化未实现，长流程崩溃即全部作废 | 🔴 严重 | 新增 #82，建议优先实现文件系统状态快照（不依赖 PostgreSQL） |
| S3 | 预算控制未落地，可能产生意外高额费用 | 🔴 严重 | 合并 #39+#46，升级严重度，补充实现方案（累计 token+调用前检查+超预算暂停） |
| S4 | Harness 1258 行职责过重，持续膨胀 | 🔴 严重 | 合并 #47，升级严重度，补充拆分建议（ExecutionScheduler + HumanInteractionManager） |
| I1 | 编码阶段 TDD 是"模拟"的，StaticTestRunner 静态推断无法真正验证代码逻辑 | 🟡 重要 | 新增 #83，建议优先实现 LocalSubprocessTestRunner |
| I2 | 回退成本高，缺乏增量更新和影响面分析 | 🟡 重要 | 合并 #38，补充增量更新需求（v1 预警，v2 增量） |
| I3 | 知识库单例无法支持多项目，且质量保证机制缺失 | 🟡 重要 | 新增 #84，建议实例池（团队级单例+项目级隔离）+ 质量检查 CLI + BM25 混合检索 |
| I4 | 设计文档与实现严重不同步（向量模型/存储/可观测性/持久化） | 🟡 重要 | 新增 #85，建议建立更新机制+每个文档末尾加实现状态表+定期一致性审计 |
| I5 | 弱介入窗口设计与实际使用场景不匹配（30 秒太短、自动化模式意义不大） | 🟡 重要 | 新增 #86，建议超时可配置（60-120 秒）+ auto-confirm 跳过+区分硬卡点/弱介入 |
| O1 | 缺乏性能基准和容量规划 | 💡 建议 | 新增 #87，建议基于实测数据建立各阶段性能基准 |
| O2 | 错误处理和兜底策略不具体（"遇到时再定"） | 💡 建议 | 新增 #88，建议明确各阶段重试次数/超时/降级策略 |
| O3 | 安全性设计缺失（API Key 管理/代码生成安全约束/后置扫描） | 💡 建议 | 新增 #89，建议增加安全设计章节（前置约束+后置扫描+密钥管理） |
| O4 | 可测试性设计不足（集成测试/端到端测试覆盖不足） | 💡 建议 | 新增 #90，建议 Harness 调度钩子+Mock LLM 全流程集成测试+多轮对话测试用例库 |
| O5 | 可观测性四层体系 v1 只实现了一层（日志） | 💡 建议 | 新增 #91，建议优先实现链路追踪（span）+ 基本指标聚合 + CLI stats 命令 |
| O6 | Agent 无状态设计与多轮对话需求矛盾（状态被推到 Harness） | 💡 建议 | 新增 #92，建议明确无状态边界+DialogManager 管理对话历史（与 #47/#60 一并处理） |

### 已删除的已解决问题

- #9 CLI 入口未实现 → ✅ 已解决（第十六轮），遗留 forge doctor 合并到 #7
- #46 maxTokensPerRun 配置占位 → 合并到 #39（同一问题）
- 第十六轮遗留 #79 followup 问题 → ✅ 已修复（第十六轮增量模式重构）
- 第十六轮遗留 #80 故事拆解性能优化 → ✅ 已完成（第十七轮分批并行+输出简化）

### 最紧急的下一步建议

1. **#81 技术方案放宽校验**（S1，1-2 天）— 当前验证卡点，最紧急
2. **#39 预算控制落地**（S3，0.5 天）— 防止继续验证产生意外费用
3. **#82 状态快照实现**（S2，1 天）— 防止长流程崩溃丢失进度
4. **#85 设计文档更新**（I4，0.5 天）— 优先更新存储设计中的向量模型/维度，避免后续开发基于错误假设

### 经验教训

1. **设计必须考虑 LLM 的输出能力边界**——技术方案要求一次性输出 ~17,000 tokens 且跨字段自洽的复杂结构，LLM 连续 2 次重试失败。对于大输出量场景，应采用分批处理（参考故事拆解的成功经验）或放宽校验规则
2. **设计文档与实现同步是持续工作**——向量模型从通义 1024 维改为火山 2048 维多模态，配置已更新但设计文档未同步，可能导致后续表结构错误。应在 PR 模板中增加"设计文档是否需要更新"检查项
3. **严重问题的识别需要跨维度审查**——#81 技术方案问题在第十七轮已发现但只标记为"未解决"，第十八轮从架构/流程/状态机/存储/可观测性 5 维度交叉审查后才识别为"严重 S1"（影响系统可用性）。单一维度的审查可能低估问题严重度
4. **v1 范围控制需要更严格**——设计文档中大量"v1 已实现"但实际有差距（存储三件套、可观测性四层、状态持久化），导致设计与实现的认知偏差。建议在设计文档中明确标注"设计目标"vs"v1 实际实现"，避免过度承诺
5. **可观测性是 AI 系统的基础能力**——长流程调试缺乏链路追踪和指标，只能靠日志文件手动分析，效率极低。即使 v1 也应该至少实现链路追踪（span），这是调试和优化的基础
