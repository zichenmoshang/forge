# 下一步计划

## 当前状态

设计阶段完成，工程基础设施已搭建，核心模块、Agent 基类、需求分析 Agent、方案设计 Agent、方案评审 Agent（含方案多轮+代码 CR 多轮）、编码 Agent（单故事 TDD + 逐故事循环 + 部分成功出口 + CR 内 revise）、交付 Agent（场景判定+新项目初始化+代码落盘+构建验证+Git+PR描述）、Harness、ContextManager、知识库基础设施（含飞书文档同步）、可替换编码工具层（Workspace/TestRunner + 真实子进程执行 #83）、可替换交付工具层（FileSystem/Git/Build）、评审统一判定规则、需求冻结质量门、方案覆盖度、编码规划/聚合/校验纯函数、可观测性（traceId 全链路 + MetricsCollector + 失败现场保留）已实现。共 375 个测试全部通过（30 文件）。

**最近完成批次（2026-10）**：#81 技术方案校验放宽（error→warning）、#39 预算控制落地（TokenBudgetTracker）、#82 状态持久化（FileSystemArtifactStore + state.json + `--resume`）、#83 真实测试执行（LocalSubprocessTestRunner，CLI 默认，失败降级静态）、#47 Harness 拆分瘦身、#85 文档同步；第二十轮可观测性缺口修复（traceId 透传 / 测试日志 environment-runner / test-failures 现场保留 / PARSE_ERROR 原始输出 / run-summary.json）。
**待办高优先级**：下一轮真实端到端验证（验证可观测性产物 + 技术方案阶段可推进）、#84 知识库质量与单例问题、#86 弱介入窗口设计、#38 回退成本预警、#87 基于 run-summary 建立性能基准。

## 已完成

### 设计阶段

- [x] 项目命名：Forge
- [x] 7 阶段流程设计（含回退机制、人工介入点、评审多轮对话）
- [x] Harness + 专业 Agent 架构设计
- [x] 知识库方案（代码反解析 + RAG + 无人工打标）
- [x] 知识库检索与维护机制（混合检索、增量更新、五层质量保证、飞书文档集成）
- [x] 向量模型选型（火山引擎 Doubao-embedding-vision-251215，2048 维，OpenAI 兼容接口，支持 qwen/openai/mock 可插拔）
- [x] 现有代码索引方案
- [x] 存储方案（目标态 PostgreSQL + pgvector + 文件系统；v1 实际：文件系统 + 内存向量库，见 06-storage.md）
- [x] 可观测性方案（四层体系，含事前预算控制设计）
- [x] 评审多轮对话机制设计（08-review-dialog.md）
- [x] 关键决策记录（14 条 ADR，最新 ADR-014 第六轮架构审查）

### 契约定义

- [x] 全局状态机定义（15 个状态含 CANCELLED、3 个硬卡点、回退矩阵、SUSPENDED 恢复；ADR-014 后顺序为 设计→评审→API确认→编码）
- [x] 结构化需求 Schema（StructuredRequirement）
- [x] 用户故事 Schema（UserStorySet）
- [x] 前端技术方案 Schema（FrontendDesignDoc）
- [x] 编码任务与结果 Schema（CodingTask / CodingResult / CodingPhaseResult）
- [x] 评审与交付 Schema（ReviewResult / DeliveryResult，ReviewIssue 含 verification 问题跟踪）
- [x] 深度检查与修复（ID体系、export、类型复用、状态机优化）

### 工程基础设施

- [x] TypeScript 项目结构（分层目录）
- [x] 配置层重构（zod 运行时校验、dotenv、类型统一、LLMConfig 单一来源）
- [x] ESLint + Prettier（Flat config、TypeScript 规则集）
- [x] Vitest 测试框架
- [x] 环境变量模板（.env.example）

### 核心模块实现

- [x] 状态机（StateMachine：前进/回退/挂起/恢复/失败/完成、重试计数）
- [x] 结构化 Logger（分级输出、LLM 调用完整记录、JSON Lines 格式）
- [x] LLM Provider 接口定义
- [x] OpenAI Provider 实现（SDK集成、指数退避重试、Logger集成）
- [x] LLM Provider 工厂方法

### 测试覆盖

- [x] 状态机单元测试（42个，含 CANCELLED、评审先于 API 确认、pauseForHuman/markRunning）
- [x] LLM Provider 单元测试（12个，mock SDK）
- [x] 配置校验单元测试（14个）
- [x] BaseAgent 单元测试（20个，模板流程 + searchKnowledge 多路检索 helper）
- [x] RequirementAgent 单元测试（16个，澄清+故事拆解+followup 校验+INVEST 自评）
- [x] DesignAgent 单元测试（15个，多路检索/覆盖度程序计算/引用完整性/降级/revise 修订闭环）
- [x] design-coverage 单元测试（6个，故事/AC/异常覆盖与 API 确认纯函数）
- [x] ReviewAgent 单元测试（15个，方案评审10 + 代码CR5：通过/阻塞/无可审代码/verification闭环/request_human）
- [x] CodingAgent 单元测试（10个，TDD 6 + revise 4：正常修订/缺回应/缺问题/修订后测试失败）
- [x] 编码纯函数与工具层单测（coding-planner 3 + coding-aggregator 6 + coding-validation 4 + tools 8）
- [x] Harness 单元测试（15个，端到端流程 + 全局上下文注入/instanceId 回填/弱介入超时）
- [x] ContextManager 单元测试（18个，产物装配含逐故事编码任务/评审/交付输入+全局上下文深拷贝+v2预留接口）
- [x] VectorStore 单元测试（17个，增删改查+过滤+相似度计算）
- [x] ASTParser 单元测试（11个，API提取+组件提取+知识条目转换）
- [x] KnowledgeService 单元测试（17个，单例+检索+入库+状态+权重+重建+多项目 scope 隔离）
- [x] EmbeddingProvider 单元测试（9个，Mock确定性+工厂方法）
- [x] review-policy 单元测试（20个，强制blocking/动作仲裁/双方问题闭环校验/一致性）
- [x] freeze-checklist 单元测试（5个，冻结质量门按产物计算）
- [x] 端到端集成测试（24个，含多轮评审、编码逐故事 TDD、代码 CR 多轮 request_changes 修订后通过/request_human 暂停续跑/最大轮次接受、交付阶段 DELIVERY_CONFIRMATION 硬卡点）
- [x] DeliveryAgent 单元测试（8个：正常交付/新项目初始化/构建失败/Git失败/输入校验/LLM失败兜底/缺content/失败故事）
- [x] 总计：315 个测试全部通过

### Agent 层

- [x] Agent 基类（BaseAgent：模板方法模式、重试机制、统一日志/错误处理）
- [x] Agent 通用类型（AgentContext / AgentResult / AgentError / AgentConfig）
- [x] 需求分析 Agent（RequirementAgent：需求澄清 + 用户故事拆解双模式）
- [x] 5 个专业 Agent 占位类（含抽象方法占位实现）

### Harness 编排层

- [x] Harness 最小可用版（状态机执行器 + Agent 调度 + 产物管理 + 人工介入）
- [x] 内存产物存储（InMemoryArtifactStore，后续可替换为持久化）
- [x] ContextManager（产物装配 + 全局上下文深拷贝 + v2 预留接口；ADR-014 后不做知识库检索；第七轮补齐评审/编码/交付输入装配）
- [x] 弱介入窗口（onWeakIntervention 回调，故事拆解/方案评审/代码CR后触发；第七轮补超时竞速，超时自动继续）
- [x] 回退机制（fallback() 公开方法 + 弱介入回退 + 状态机 FALLBACK 动作）
- [x] 取消机制（cancel() 进入 CANCELLED 终态，ADR-014）
- [x] 全局上下文注入（globalContext 经 AgentContext 到达每个 Agent，第七轮修复链路断裂）
- [x] 产物 instanceId 回填（保存前写入产物对象内部，保证自描述，第七轮）
- [x] 需求冻结质量门（freeze-checklist 按产物实际计算，不硬编码，第七轮）
- [x] 多轮澄清问答（clarify-followup 模式，人工回答后判断是否还有 pending 问题）
- [x] 日志按实例分文件（data/instances/{id}/logs/pipeline.log + llm-calls.log）
- [x] Prompt 模板管理（src/prompts/ 目录，Agent 加载模板而非硬编码）
- [x] 端到端流程验证：INIT → 需求澄清（硬卡点）→ 人工确认 → 故事拆解 → FAILED（DesignAgent 未实现，ADR-014 后未实现直接失败而非挂起）

## 待确认（v1 范围）

以下问题在遇到具体场景时定义，暂不固化：

- [ ] 各阶段兜底策略的具体参数（已在 config/schema.ts 设默认值，可调整）
- [ ] 增量更新机制（需求变更时的部分重跑）
- [ ] AI 评审能力边界的详细 checklist
- [ ] 测试覆盖率具体标准
- [ ] Tracer 和 Metrics 的实现时机（当前 Logger 已够用，后续按需补充）

## 实施路线（需求→故事→方案→多轮评审→逐故事编码→代码 CR 多轮已打通，下一步交付阶段）

### 第一步：Agent 基类 ✅ 已完成
### 第二步：需求分析 Agent ✅ 已完成
### 第三步：Harness 编排器 ✅ 已完成

- [x] 状态机执行器（驱动状态流转）
- [x] Agent 调度（根据状态调用对应 Agent）
- [x] 产物管理（内存存储，保存/读取/版本化）
- [x] 人工介入管理（硬卡点等待、回调机制）
- [x] 弱介入窗口（onWeakIntervention 回调）
- [x] 回退机制（fallback() 公开方法）
- [x] 多轮澄清问答（clarify-followup 模式）
- [x] 异常处理（Agent 失败重试、无 Agent 时直接 FAILED，ADR-014）
- [x] 单元测试 + 14 个端到端集成测试，验证"需求澄清→故事拆解"全链路

### 第四步：知识库基础设施 ✅ 已完成

v1 需要使用知识库验证 Harness 和 DesignAgent 的正确性，因此知识库基础设施优先于 DesignAgent 实现。

- [x] KnowledgeService（单例，核心接口：search/indexCode/indexDocument/getStatus/updateWeight/rebuild）
- [x] VectorStore（内存版 InMemoryVectorStore，预留 pgvector 实现接口）
- [x] EmbeddingProvider（Qwen API 实现 + OpenAI 兼容实现（火山 Doubao-embedding）+ Mock 确定性伪向量，工厂方法）
- [x] ASTParser（TypeScript Compiler API，提取 API 接口和组件 props）
- [x] BaseAgent retrieveKnowledge 钩子 + searchKnowledge 多路检索 helper（ADR-014：检索由 Agent 内部通过 AgentContext.knowledgeService 自主完成，ContextManager 不预检索）
- [x] 知识库维护 CLI（kb sync/rebuild/search/status/sync-feishu）
- [x] 配置扩展（embedding/knowledgeBase/feishu/budget 配置块，飞书同步参数 syncEnabled/chunkMaxChars/chunkOverlapChars/projectScope）
- [x] 飞书文档同步（FeishuClient 认证+Wiki+文档获取、DocChunker 标题→段落→字符三级分块、FeishuSyncService 拉取→筛选→分块→入库，支持 Docx/Doc、多空间、项目范围隔离）
- [x] 单元测试（知识库相关测试覆盖检索、入库、状态、权重、重建 + searchKnowledge helper + 飞书同步 30 个测试）
- [ ] pgvector 持久化实现（当前内存版，v1 验证后切换）
- [ ] 飞书文档增量同步 + 定时同步（v2）
- [ ] Rerank 重排序（v2）
- [ ] RequirementAgent 知识库检索（v2）

### 第五步：方案设计 Agent（✅ 已完成，generate + revise）

- [x] 技术栈检测/建议（globalContext.techStack 约束 + LLM 建议，normalizeTechStack 兜底）
- [x] 页面/路由/组件树设计（引用完整性校验：页面→组件、组件 children、故事引用）
- [x] 现有组件复用检查（retrieveKnowledge 三路并行检索：组件/模式、API/模型、规范/异常，走 searchKnowledge + projectScope）
- [x] API 契约生成（apiConfirmation 程序初始化，新增/修改自动进 pending）
- [x] 异常场景补齐（基础四类 loading/empty-state/error/network 由 design-coverage 程序检查）
- [x] 非功能需求落地方案（缺方案 warning）
- [x] 覆盖度程序计算（core/design-coverage，不采信 LLM 自报，规范 1.14）
- [x] 方案评审 ReviewAgent.review-design（review-policy 强制 blocking + resolvedAction 程序化仲裁，支持多轮）
- [x] 端到端跑通 需求→故事→方案→多轮评审→API_CONFIRMATION 硬卡点
- [x] revise（评审循环内修改）独立方法（DesignAgent.revise，版本递增、覆盖度重算、逐项回应闭环）
- [ ] Figma 真实解析与消费（v1 为外部依赖，当前走 available=false 降级路径）
- [ ] 代码 CR（review-code）——随 CodingAgent 落地（类型 CodeReviewInput 已预留）

### 第六步：评审多轮对话机制（#42，design 侧已完成）

- [x] 类型定义（DialogMessage/IssueResponse/DesignRevision/ReviewRound/ReviewDialogHistory）
- [x] BaseAgent 泛型执行器 runAgentCycle（execute/revise 共用，不新增并行抽象层）
- [x] Harness.runDesignReviewDialog（多轮循环、resolvedAction 仲裁、history 落盘、版本递增）
- [x] DesignAgent.revise 方法（独立输入输出，不在 execute 内分发）
- [x] 问题跟踪闭环（Reviewer 逐项 verification + 修改方逐项 issueResponse，遗漏判无效重试）
- [x] 暂停/续跑/兜底（request_human、max_rounds 停等人工，resume 续跑或放行；interruptAfterEachRound 弱介入）
- [x] 评审历史独立产物保存（design-review-history）
- [x] 代码 CR 多轮对话（runCodeReviewDialog 的 code-review 分支，第八步）

### 第七步：编码 Agent（✅ 单故事 TDD + 逐故事循环已完成）

- [x] 可替换工具层（src/tools：Workspace/TestRunner 接口、InMemoryWorkspace、StaticTestRunner 静态推断、ScriptableTestRunner 测试用）
- [x] 纯函数：coding-planner（方案+故事→CodingTask）、coding-aggregator（拓扑排序/聚合/出口状态）、coding-validation（AC 覆盖/状态推导）
- [x] ContextManager.buildCodingTaskForStory 逐故事装配
- [x] CodingAgent 单故事 TDD：red（测试+mock，必须失败反假测试）→ green/fix（maxGreenAttempts=5），AC 测试覆盖程序校验，needsDesignFallback 透传
- [x] Harness.runCodingPhase：拓扑逐故事、单故事失败隔离、CodingPhaseResult 聚合、#40 三分支出口、完成后进入代码 CR 多轮
- [x] CodingAgent.revise（CR 对话内针对性修改+重跑测试+逐项 issueResponses）
- [x] 真实子进程测试执行器（LocalSubprocessTestRunner，#83：工作区落盘 .sandbox 真实跑 vitest、解析 JSON、失败降级静态并标注；`--test-mode static` 可显式切回静态快速通道）
- [ ] 代码真实落盘（GeneratedFile.content → 目标项目，随交付阶段）

### 第八步：代码 CR 多轮对话（✅ 已完成，复用 #42 模式）

- [x] ReviewAgent review-code 分支（CR 八维度、CodeReviewChecklist、按 type 分发）
- [x] CodingAgent.revise（针对性修改+重跑 TestRunner+issueResponses 闭环）
- [x] Harness.runCodeReviewDialog：多轮循环、阻塞问题触发修订、第2轮 verification 闭环、request_human/最大轮次暂停、resume 续跑/接受
- [x] 产物 code-review + code-review-history，CR 通过后进入交付阶段
- [x] CR 只针对 success/partial 故事，failed 故事跳过并记录
- [ ] 设计还原度图片比对（Figma 截图，v2）

### 第九步：交付 Agent（✅ 已完成）

- [x] 可替换交付工具层（src/tools/delivery：FileSystemClient/GitClient/BuildRunner 接口 + 默认实现）
- [x] 场景判定（自动推断目标项目状态：新项目/新模块/代码修改，可显式指定）
- [x] 新项目初始化（React+TypeScript+Vite 基础结构：package.json+tsconfig+vite.config+入口文件+目录结构+.gitignore）
- [x] 代码落盘（GeneratedFile.content → 目标项目文件，新建/覆盖，缺 content 跳过并记录）
- [x] 构建验证（自动检测包管理器+构建命令，执行构建，失败记录 knownIssues）
- [x] Git 操作（init/创建分支 feature/forge-{instanceId}/add/commit，v1 不远程 push）
- [x] PR 描述自动生成（LLM，关联需求/故事/测试/CR/变更，LLM 失败时兜底模板）
- [x] Harness 交付阶段编排（DELIVERING → DELIVERY_CONFIRMATION 硬卡点 → COMPLETED）
- [x] 产物 delivery（DeliveryResult：交付状态/Git信息/PR描述/变更统计/构建结果/完成故事/未完成故事/已知风险/后续建议）
- [x] 配置扩展（delivery.targetProjectPath/git/build）
- [ ] 远程 PR 创建（GitHub/GitLab API，v2）

### 后续

- 下一轮真实端到端验证（forge run --auto-confirm）：确认 trace-id/state/run-summary/test-failures 可观测性产物齐备、技术方案阶段可推进
- #84 知识库质量保证（多项目单例隔离、内容校验、过期检测）
- #87 基于多轮 run-summary 建立各阶段性能基准
- #86 弱介入窗口与人工交互设计优化
- #38 回退成本预警
- 飞书文档增量同步 + 定时同步（v2）
- Rerank（v2）
- RequirementAgent 知识库检索（v2）
- 远程 PR 创建（v2）
- PostgreSQL + pgvector 持久化（v2，当前内存向量）

## 关键设计决策记录

详见 [决策记录](decisions/README.md)，最新架构决策见 ADR-014（第六轮架构审查）。
