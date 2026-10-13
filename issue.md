# Forge 待解决问题

> 最后更新：2026-10-13（第二十一轮修复后清理）
>
> **第二十一轮已修复（本次从清单移除，经验见 [coding-standards 8.13](docs/coding-standards.md)）**：
> - P0 知识库“建而不用”：run-cli 启动先同步飞书（失败降级空库并标注）；RequirementAgent 澄清/故事拆解补检索钩子并注入 prompt。
> - P1 TDD 工作区跨故事累积：不再每故事 clear，前序故事文件累积写回，避免跨故事 import 失败而静默降级。
> - P2 失败 LLM 调用计入 Metrics；JSON 截断恢复按风险告警（不再静默修复）；并发预算改 reserve/settle 原子预留。
> - P3 状态转换表单一来源（FORWARD_NEXT_MAP 派生 ADVANCE 表）；新项目技术栈反问 + 知识库推荐（不再硬编码 React）；
>   超时 `llm.timeoutMs` 可配置（默认 10 分钟）+ 熔断器（#62）；logger logDir/traceId import/死代码清理。
>
> 全量 **375 测试 / 30 文件全绿**，tsc 零错误。已完成历史（#39/#47/#61/#62/#81/#82/#83/#85 等）经验均已沉淀到规范文档，本文件只保留待解决项。

---

## 一、重要（建议近期处理）

#### #7 无 CI/CD 流水线

| 字段 | 内容 |
|------|------|
| 状态 | ⚪ 未解决 |
| 说明 | 无 `.github/workflows/`；建议 CI 跑 `typecheck + lint + prettier-check + test`，push/PR 触发。`forge doctor`（配置/环境自检）可一并迭代 |
| 时机 | 与 #68 测试工程化一并落地 |

#### #84 知识库多项目隔离与质量保证（部分缓解）

| 字段 | 内容 |
|------|------|
| 状态 | 🟡 部分缓解（本轮已修“建而不用”，以下仍待办） |
| 待办1 | 团队级知识库（飞书）单例 + **项目级代码索引按 projectId 隔离**；当前无法同时索引多个代码仓库（单例内仅一个 VectorStore，索引第二仓库会覆盖/混合） |
| 待办2 | 内容质量机制缺失：`forge kb audit`（过期文档、重复去重、低质量向量/条目）、条目生命周期（active/deprecated/removed） |
| 待办3 | 检索单一：仅向量检索，缺 BM25 关键词（对 API 名/组件名精确匹配差）与 Rerank |
| 时机 | 接入真实项目前；实例池/质量审计 v1 后期，BM25 可低成本先行 |

#### #38 回退成本预警与增量更新

| 字段 | 内容 |
|------|------|
| 状态 | ⚪ 设计已定、代码未实现 |
| 说明 | `Harness.fallback` 直接执行回退。编码阶段发现方案问题回退，已生成的几十个文件全部作废。建议：①回退前自动计算并展示将废弃产物规模（“N 故事/M 文件”，低成本高价值）；②v2 增量更新，只重生受影响故事 |
| 时机 | v1 后期做预警，v2 做增量 |

#### #86 弱介入窗口与实际场景不匹配

| 字段 | 内容 |
|------|------|
| 状态 | ⚪ 未解决 |
| 说明 | ①30s 对复杂产物太短；②需明确 `--auto-confirm` 直接跳过弱介入；③CODING 部分失败“不自动推进”与其他节点“超时自动继续”不一致。建议超时可配置（60–120s）、明确硬卡点 vs 弱介入节点清单、部分失败支持超时带标记继续 |
| 时机 | 完整端到端跑通后按体验调整 |

#### #87 性能基准与容量规划

| 字段 | 内容 |
|------|------|
| 状态 | 🟡 数据源已具备（run-summary.json），基准表待建立 |
| 说明 | 积累 3–5 次真实 run-summary 后建立各阶段基准（澄清 followup <1k tokens/10s；拆解每批 ≤6 功能点/10min；方案 <15k tokens），后续运行自动对比发现回归 |
| 时机 | 下一轮真实端到端验证后 |

---

## 二、代码质量与架构（多为 v2）

| 编号 | 问题 | 状态 | 建议 / 时机 |
|---|---|---|---|
| #17 | `buildAgentInput` 返回 unknown，类型契约隐式 | 🟡 部分缓解（分支内 `satisfies`） | 定义 `AgentInputByState` 映射或泛型+类型守卫；v2 |
| #60 | 设计/代码两套评审对话循环重复 | 🟡 v2 | 抽取泛化 DialogRunner（参数化 reviewer/reviser/maxRounds）；#47 已部分缓解 |
| #63 | 剩余死代码 | 🟡 部分清理 | 本轮删 getReviewConfig/getTokenBudget；仍待处理 state-machine 的 handleSuspend/Resume/Complete、prd-parser/storage 空壳类等 |
| #64 | file-system-client 声明 async 却用同步 fs API | 🟡 v2 | 改 `fs.promises.*` 或去掉 async；高并发交付阻塞事件循环 |
| #65 | knowledge-service 索引⽤ readFileSync/readdirSync | 🟡 v2 | 改异步 fs API；与 #22 同属索引性能 |
| #66 | `CodingResult.status` 与 `CodingPhaseResult.overallStatus` 枚举风格不一 | 🟡 v2 | 统一命名（success/partial/failed） |
| #68 | 测试工程化缺失（tsconfig 排除 tests、无 coverage 阈值、any 为 warn、无 pre-commit） | 🟡 v2 | tsconfig.test.json、coverage 阈值、no-explicit-any=error、husky/lint-staged；配合 #7 |
| #54 | aggregateCodingResults 测试总数可能重复计数 | 🟡 | 跨故事共享测试文件时按路径去重后再统计 |
| #55 | buildSystemPrompt 同步 / buildUserPrompt 异步不一致 | 🟢 低优 | 统一为 `string \| Promise<string>`；出现异步 system prompt 时 |
| #92 | Agent“无状态”与多轮对话历史管理矛盾 | 💡 | 明确无状态边界，对话历史归 DialogManager（配合 #47/#60） |

---

## 三、知识库与检索增强

| 编号 | 问题 | 状态 | 建议 / 时机 |
|---|---|---|---|
| #21 | ASTParser 仅识别极简 API/组件模式 | 🟡 待增强 | 支持 axios/fetch 封装、React.FC、type 别名、类组件；接入真实项目前 |
| #22 | indexCode 串行、逐条 embedding | 🟡 待优化 | 收集文本批量调用 embedding；索引 >100 文件时 |
| #24 | syncIncremental 删除 O(n) 全量遍历 | 🟡 待优化 | 建 sourceRef→itemIds 索引或 VectorStore 提供按 sourceRef 查询；条目 >1000 时 |
| #33 | 检索 query 构造粗糙 | 💡 讨论 | query 预处理（关键词提取、同义词扩展、多路拆分）；接真实项目后按效果优化 |
| #34 | 无 prompt 版本管理 | 💡 讨论 | 模板加 version，产物记录所用 prompt 版本；2+ Agent 上线后 |
| #41 | ContextManager 仍按状态知道各 Agent 输入结构（中心耦合） | 💡 讨论 | 终极形态只提供 getArtifacts、Agent 自决消费；v1 保持现状避免过度重构 |

---

## 四、静态测试通道限制（默认已切真实子进程，仅 static/降级路径）

| 编号 | 问题 | 状态 | 建议 |
|---|---|---|---|
| #52 | StaticTestRunner 用例计数正则简单（误匹配注释/字符串，不支持 .each/嵌套） | 🟡 v1 限制 | 至少排除注释与字符串；静态 runner 增强时 |
| #53 | AC 覆盖为纯字符串包含（可放注释/短 ID 误匹配） | 🟡 v1 限制 | 用单词边界 `\b${acId}\b` 或解析测试结构 |

---

## 五、可靠性 / 安全 / 可观测性（设计项）

| 编号 | 问题 | 状态 | 建议 / 时机 |
|---|---|---|---|
| #88 | 兜底策略不具体（“遇到时再定”） | 💡 | 明确各阶段重试次数/超时/重试耗尽降级（暂停/部分交付/失败） |
| #89 | 系统性安全设计缺失 | 💡 v2 | 前置安全约束（禁硬编码密钥/危险 import）+ 后置扫描 + 密钥管理（.env 不入库、日志脱敏） |
| #90 | 可测试性设计不足（集成/e2e 覆盖少） | 💡 | 注入 Mock Agent、Mock LLM 跑全流程、建多轮对话场景用例库 |
| #91 | 可观测性第四层（质量与成本分析）未实现 | 🟡 部分解决 | 第一/二/三层 v1 形态已落地；v2 做 PostgreSQL spans/metrics、forge stats、P50/P95/P99、质量自动评分 |

---

## 六、已知限制（v2 随存储升级解决）

| 编号 | 限制 | 说明 |
|---|---|---|
| #29 | InMemoryVectorStore 搜索 O(n) 全量计算 | 适用 <1 万条；pgvector 替换时解决 |
| #30 | MockEmbeddingProvider 伪向量语义相关性差 | 测试检索效果不代表真实场景；集成测试用真实 embedding |

---

## 七、测试质量改进项（非 bug，对应模块迭代时处理）

| 项 | 说明 | 时机 |
|----|------|------|
| logger 选项断言深度 / 指数退避延迟 / temperature·maxTokens 传递 | Provider 测试只验创建或部分参数，可用 fake timers 补全 | LLM Provider 迭代时 |
| Harness fallback 人工回退流程 | 各回退路径缺测试 | Harness 迭代时 |
| KnowledgeService syncIncremental modified/deleted | added + projectScope 已测，其余场景待补 | KnowledgeService 迭代时 |
| ASTParser 复杂场景 | React.FC、type 别名、封装请求库未测 | ASTParser 增强时 |
| 澄清 followup 多问题场景 | 现仅单问题 | RequirementAgent 迭代时 |
| 编码 partial-success 端到端 | all-success/all-failed 已覆盖，部分成功+弱介入路径不足 | 编码稳定性验证时 |
| 大输入场景性能 | 缺长 PRD/多故事的性能与 token 验证 | 集成测试阶段 |
| embedding API 失败降级 / LLM 字段类型污染 | 真实失败与类型污染路径未测 | 联调 / Agent 基类迭代时 |
| rejected-wont-fix 续跑 | Reviewer 拒绝 wont-fix 后的 e2e 路径未覆盖 | 评审对话迭代时 |
