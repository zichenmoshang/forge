# Forge 项目开发规范

> 本文档沉淀自项目四轮深度审查与问题修复的经验教训，作为后续开发的参考标准。
> 最后更新：2026-09-03

---

## 一、代码质量规范

### 1.1 封装性与不可变性

**经验来源**：#N2（getState() 浅拷贝导致内部状态泄露）

- 类的 getter 返回内部状态时，**必须使用深拷贝**（`structuredClone`）或返回 `Readonly<T>` 类型
- 禁止用扩展运算符 `{ ...obj }` 返回含嵌套对象的状态（只拷贝一层）
- 状态机、配置、上下文等核心状态对象必须保证外部修改不影响内部

```typescript
// ✅ 正确
getState(): PipelineState {
  return structuredClone(this.state);
}

// ❌ 错误（嵌套对象仍指向内部引用）
getState(): PipelineState {
  return { ...this.state };
}
```

### 1.2 终态与状态机不变性

**经验来源**：#N1（终态仍可执行 FAIL 动作）

- 状态机的终态（COMPLETED / FAILED）**必须拒绝所有动作**，不允许任何例外
- 终态检查条件应为 `isTerminalState(from)`，不应加 `action.type !== 'FAIL'` 等例外
- 每个状态转换函数都要考虑：当前状态是否允许执行该动作？

### 1.3 错误处理与降级

**经验来源**：#N8（日志写入静默失败，且修复时遗漏了第二个 catch 块）

- **禁止空 catch 块**。捕获异常后至少要有 `console.warn` 或日志记录
- 同一个文件中有多个类似的 try-catch 时，**修复一个必须检查是否有遗漏**
- 写入类操作（文件、网络、数据库）失败时必须有降级策略（如降级到 console）
- 修复问题时要全局搜索同类模式，确保全部修复

```typescript
// ✅ 正确
try {
  fs.appendFileSync(path, content);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(`[Logger] 写入失败: ${msg}，降级到 console`);
}

// ❌ 错误
try {
  fs.appendFileSync(path, content);
} catch {
  // 静默失败
}
```

### 1.4 类型精确性

**经验来源**：#N10（retryCount 用 Record<string, number>）

- 能用联合类型限定 key 的，不要用 `string`
- 推荐 `Partial<Record<UnionType, ValueType>>` 替代 `Record<string, ValueType>`
- 类型定义要利用 TypeScript 的类型检查能力，防止拼写错误

### 1.5 字段语义正确性

**经验来源**：#N6（traceId 字段填了 agent 名称）

- 字段名必须与内容语义一致，不能因为"暂时没有"就用其他字段填充
- traceId / instanceId / caller 是不同概念，不能混用
- 缺少数据时字段留空（`undefined`），不要用不相关数据填充

### 1.6 数据结构变更的全链路影响

**经验来源**：#13 → #36（修改澄清回答数据结构后，下游 prompt 构建仍用旧字段，导致多轮澄清失效）

- 修改数据结构（新增字段、删除字段、改字段名、改语义）时，**必须全局搜索所有引用该字段的地方**
- 不仅要改生产方（Harness 写入），还要改所有消费方（Agent 读取、prompt 构建、测试断言）
- 数据结构变更后必须做**全链路验证**：从数据产生到最终消费的每个环节都要确认
- 推荐流程：改类型定义 → 全局搜索引用 → 逐个修改 → 全量测试 → 确认无遗漏

```typescript
// ❌ 错误：只改了 Harness 层的写入，没改 RequirementAgent 的读取
// Harness: requirement.humanAnswers.push(...)  // 新字段
// Agent: req.clarificationLog.filter(q => q.answer)  // 仍读旧字段，永远为空

// ✅ 正确：改类型后全局搜索，生产方和消费方同步修改
// 改完后跑全量测试，确认 followup prompt 中包含人工回答
```

### 1.7 重试职责分层

**经验来源**：#12（Harness 与 BaseAgent 双层重试叠加，最坏 9 次 LLM 调用）

- 重试逻辑**只能有一层负责业务失败**，不能多层叠加
- 推荐分层：
  - **Agent 内部**：负责输出解析/校验失败重试（快速 1-2 次，同一输入重试）
  - **Harness 外层**：只负责 Agent 执行异常重试（网络错误、未捕获异常）
- Agent 返回 `success: false`（业务失败）时，Harness **不应再重试**，直接失败
- 两层重试叠加会导致成本爆炸（3×3=9 次）和时间浪费
- 新增重试逻辑前先确认：是否已有一层重试？是否会叠加？

### 1.8 跨层格式转换集中处理

**经验来源**：#18（状态名 `REQUIREMENT_PARSING` 转 stage 时各处 `toLowerCase()`，格式不统一）

- 跨层数据格式转换（状态名→stage、枚举→字符串、内部格式→外部格式）**必须集中在一个转换函数中**
- 禁止各处自行 `toLowerCase()` / `replace()` / 拼接，容易产生不一致
- 转换函数应该有明确的输入输出类型，覆盖所有可能的输入值

```typescript
// ✅ 正确：集中转换函数
private stateToStage(state: PipelineStateName): string {
  return state.toLowerCase().replace(/_/g, '-');
}

// ❌ 错误：各处自行转换
stage: state.currentState.toLowerCase()  // 得到 requirement_parsing，不是 kebab-case
```

### 1.9 接口字段诚实性

**经验来源**：#35（ClarificationFollowupInput.answers 字段定义了但从不使用，始终传空对象）

- 接口字段要**诚实**：v1 不用的字段要么移除，要么标记为可选（`?`）并注释 v2 计划
- 禁止定义必填字段但始终传空值/默认值，这会误导接口使用者
- 预留未来扩展的字段应该：标记可选 + 注释说明何时启用 + 不强制传值

### 1.10 状态语义单一，终态完备

**经验来源**：第六轮架构审查（SUSPENDED 同时承载"未实现/等人工/达最大轮次"三义；缺取消终态）

- 一个状态只表达一种语义。不同性质的情况（开发期错误 / 正常等待 / 质量兜底）不能共用一个状态
- **开发期错误（如 Agent 未实现）直接 FAILED**，不允许进入运行时挂起状态——生产环境出现未实现 Agent 是 bug，不是"等待恢复"
- 硬卡点等待用 `status=waiting_human` 表达，状态本身不变；SUSPENDED 只留给运行时外部依赖问题
- 终态要完备：正常完成（COMPLETED）、失败（FAILED）、人工取消（CANCELLED）缺一不可；终态不可恢复、不可再转换
- 状态机顺序调整时，ADVANCE/FALLBACK 两张表、getNextState 映射、全部文档流程图必须**同步改**，并加专项测试锁定顺序

### 1.11 判定口径唯一，不信任模型自述

**经验来源**：第六轮架构审查（conclusion/severity/blocking 三套判定并存且冲突规则缺失；评审闭环靠 LLM 自觉）

- 一个"是否通过"的决策只能有**一个权威判定口径**，并由代码程序化执行，不能同时存在多个可互相矛盾的字段
- LLM 的自述结论（如 dialogAction=approve、conclusion=pass）只能作为输入，**最终动作以结构化数据的程序化判定为准**（见 core/review-policy.ts）
- 规则能推导的标记（blocker/critical 必然 blocking）就程序化强制，不依赖 LLM 标记正确
- 多轮迭代的闭环（上轮问题是否逐项处理）必须有结构化校验（findUnverifiedIssues），不能依赖"模型记得"

### 1.12 职责边界：装配层不做业务检索，业务 Agent 不做流程控制

**经验来源**：第六轮架构审查（ContextManager 预检索与 Agent 自检索重复；ContextManager 知道所有 Agent 输入结构成为中心耦合点）

- 装配层（ContextManager）只做"从存储读产物、组装输入"，**不做知识库检索这类业务决策**；检索什么、分几路、什么时机检索是 Agent 的业务逻辑
- 服务通过上下文（AgentContext）注入给 Agent，由 Agent 自主调用，而不是装配层代劳后塞入
- 反向边界同样成立：Agent 不做流程控制（不决定前进/回退/挂起），只输出结构化结果和动作建议，由 Harness 执行
- 判断标准：如果一个模块的改动频率随 Agent 数量线性增长（每加一个 Agent 就要改它），说明职责越界

### 1.13 链路完整性：未实现的下游路径也要对齐契约

**经验来源**：第七轮一致性审计（全局上下文配了却到不了 Agent；评审/编码/交付阶段输入装配返回空对象，206 测试全绿但路径走不到）

- "测试全绿"不等于"链路完整"：当某阶段 Agent 尚未实现时，它的输入装配、上下文注入、字段透传路径**没有任何测试经过**，最容易成为盲区
- 新增状态/阶段时，即使 Agent 是占位，ContextManager 的输入装配、AgentContext 字段注入也必须**一次性对齐设计契约**，不允许用 `{}` / default 分支吞掉
- 跨层传递的公共信息（如 globalContext、projectId、knowledgeService）必须有"配置入口 → 装配 → AgentContext → Agent 可读"的完整可达路径，并写一个捕获 context 的测试证明它真的到了
- 审查时沿一条真实请求走读：每个字段从哪产生、经过谁、最终谁消费，任何一段只存不取都是断点

### 1.14 质量门与自检禁止硬编码通过

**经验来源**：第七轮一致性审计（冻结 checklist 八项写死 true、INVEST 四项写死 true，自检形同虚设）

- 冻结 checklist、质量自检、通过判定等"质量门"字段，**能程序化计算的必须用产物实际数据计算**，禁止硬编码 `true`
- 语义上无法纯程序判定的（如规则是否有歧义、INVEST 的独立/可协商/有价值），取 **LLM 自评值**并在注释/字段说明中标注"模型自评、未程序验证"；LLM 漏输出时降级处理必须同时在 issues/日志留痕，不得静默按通过处理
- 可程序计算的项（如 Small=AC 数量、Testable=可测试 AC 占比、trackingProvided=埋点非空）必须由代码计算并**覆盖** LLM 输出，防止模型自评虚高
- 判定口诀：写 `xxx: true` 前先问"这个 true 是我算出来的还是我希望它成立"——后者必须改

### 1.15 隔离维度在每个入口透传，测试覆盖多实例场景

**经验来源**：第七轮一致性审计（rebuild 多仓库、syncIncremental 增量更新漏传 projectScope，数据错误落到 global，单仓库测试发现不了）

- 多租户/多项目隔离字段（projectScope 等）必须在**每一个写入入口**（单次索引、批量重建、增量同步、手工录入）一致透传，删除分支与新增分支的过滤口径必须一致
- 只测单项目/单仓库无法暴露隔离问题，隔离逻辑必须有"两个项目各写一份、分别检索互不串扰"的测试

---

## 二、配置管理规范

### 2.1 环境变量校验

**经验来源**：#5（无环境变量校验）、#N3（数字无效时静默降级）、#N9（default('') 与 min(1) 矛盾）、#N13（布尔解析不严谨）

- **所有配置必须通过 zod 等库做运行时校验**，启动时 fail-fast
- 环境变量**原始字符串直接传给 zod**，不要在 loader 里做 `Number()` / `Boolean()` 转换
  - 数字用 `z.coerce.number()`，无效值（如 `"abc"`）会报错而非静默降级
  - 布尔用自定义 `preprocess`，支持 `true/false/1/0/yes/no/on/off`
- 环境变量为空字符串或全空格时视为未设置（`env()` 辅助函数），由 zod 的 default 提供默认值
- **必填字段不要设 `default('')`**，与 `min(1)` 矛盾且有误导性。直接要求必填
- 配置类型**单一来源**：在 config/schema.ts 定义，其他模块引用，不重复定义

```typescript
// ✅ 正确：原始字符串传给 zod，由 zod 转换校验
function env(key: string): string | undefined {
  const val = process.env[key];
  return val?.trim() ? val : undefined;
}

// schema.ts
port: z.coerce.number().int().positive().default(5432),
apiKey: z.string().min(1, 'LLM_API_KEY 不能为空'), // 必填，不设 default('')

// ❌ 错误：loader 里做转换，无效值静默降级
defaultTemperature: Number(process.env.LLM_TEMPERATURE) || 0.7,
```

### 2.2 配置类型统一

**经验来源**：#4（ForgeConfig.llm 与 LLMConfig 独立定义）

- 配置类型只在 `config/schema.ts` 定义一次
- 其他模块（如 LLM factory）从 config 层 import 类型，不重复定义
- 新增配置项时只改 schema.ts，全局自动生效

---

## 三、测试规范

### 3.1 边界场景必须覆盖

**经验来源**：#N1、#N2（两个 bug 都是因为边界场景未测试）

- 状态机测试必须覆盖：
  - 终态执行任何动作（COMPLETED / FAILED）
  - getState() 返回值不可变性（外部修改不影响内部）
  - SUSPENDED 状态执行前进/回退
  - 非法转换的所有路径
- 每个 bug 修复后**必须补充对应的回归测试**

### 3.2 测试断言深度

**经验来源**：单测质量分析发现"浅测试"

- 禁止只验证"不抛异常"或"返回 truthy"，必须断言具体行为
- 验证依赖注入时，要验证依赖是否真的被调用/生效，不只验证创建成功
- 涉及时间/延迟的逻辑，用 fake timers 验证具体时长
- 每个测试要有明确的"预期结果"断言

### 3.3 测试先行

- 新功能开发先写测试（红），再写实现（绿），再重构
- bug 修复先写能复现 bug 的测试，确认失败后再修复
- 测试数量与代码质量正相关，但"无用单测"（断言恒真）比没有更糟

---

## 四、工程规范

### 4.1 代码风格

**经验来源**：#6（无 lint）、#N4（Prettier 配了但没跑）、#N15（注释超行宽）、#23（lint/format 只覆盖 src 不覆盖 tests）

- ESLint + Prettier 必须配置，且**提交前必须通过**
- `prettier --check` 和 `eslint --max-warnings 0` 作为验证标准
- **质量门禁必须覆盖全部代码，包括 tests 目录**（不能只检查 src）
- tests 目录的 eslint 配置可以放宽（如不使用 project 类型检查），但不能完全不检查
- 注释不要用超长分隔线（`// ===` 超过 printWidth 会导致 format:check 失败）
- 未使用的 import 必须删除（ESLint 会警告）
- 修改 lint/format 配置后，**必须实际执行一次** `prettier --write`，不能只改脚本不执行

### 4.2 项目结构

**经验来源**：#N11（废弃文件未删除）、#N12（目录与 Agent 不对齐）

- 标记 `@deprecated` 的文件确认无引用后立即删除，不要长期保留
- 目录结构与模块数量保持一致（Agent 有 5 个，prompts 目录也应有 5 个）
- 空目录用 `.gitkeep` 占位，确保 git 能跟踪

### 4.3 依赖管理

**经验来源**：#1（依赖完全缺失）、#8（是否需要 DI 框架）

- 运行时依赖**按需安装**，不要提前装一堆用不到的包
- 但基础设施依赖（dotenv、zod、测试框架、lint）应在项目初期装好
- 不盲目引入框架（如 DI 容器），手写工厂模式往往更简单
- 引入新依赖前评估：是否真的需要？有没有更轻量的替代？

### 4.4 CI/CD

- 有实际代码提交后应配置基础 CI：`typecheck + lint + prettier-check + test`
- CI 是防止代码质量退化的安全网，不应长期缺失

---

## 五、文档维护规范

### 5.1 数据一致性

**经验来源**：第三轮反馈发现 issue.md 有 4 处数据不一致

- 修改代码后，**必须同步更新相关文档**中的数据（测试数量、文件数量、状态描述）
- 修复问题后，issue.md 中对应问题的状态、进展、修复记录要同步更新
- 文档中的数字（测试数、文件数、状态数）要与实际一致，定期核对

### 5.2 修复记录完整性

**经验来源**：#N8 修复时遗漏了第二个 catch 块，且 issue.md 未同步

- 修复一个问题时，全局搜索是否有同类问题未修复
- issue.md 中标记"已修复"前，确认所有相关位置都已修复
- 修复记录要写清具体改了什么，不要只写"已修复"

### 5.3 问题生命周期

- 问题发现 → 记录到 issue.md（含位置、现象、影响、建议）
- 问题修复 → 更新状态、补充修复方式、新增回归测试
- 问题关闭 → 从活跃问题列表移除，经验沉淀到规范文档
- issue.md 只保留**待解决**的问题，已完成的移入规范文档或 ADR

---

## 六、代码审查 Checklist

提交代码前自查：

### 代码质量
- [ ] 终态/边界状态是否拒绝了非法操作？
- [ ] getter 返回内部状态时是否用了深拷贝？
- [ ] 所有 catch 块是否都有降级处理（无空 catch）？
- [ ] 同类模式是否全部修复（不只修第一个）？
- [ ] 字段语义是否正确（traceId 没填 caller）？
- [ ] 类型是否尽可能精确（不用 string 代替联合类型，Partial 而非 as 强转）？

### 架构
- [ ] 状态语义是否单一（开发期错误不进 SUSPENDED，等待用 waiting_human）？
- [ ] "是否通过"类判定是否只有一个程序化口径，没信任 LLM 自述？
- [ ] 装配层是否只做装配（ContextManager 不做知识库检索）？
- [ ] 生成/修改两类任务是否用了独立类型和方法（无 if type 分发；跨阶段任务例外见 8.3 边界）？
- [ ] 状态机顺序改动是否同步了两张转换表、getNextState、文档和专项测试？
- [ ] 未实现的下游阶段，输入装配和上下文注入是否也对齐了契约（不用 `{}`/default 吞）？
- [ ] 公共信息（globalContext/projectId/knowledgeService）是否有从配置到 Agent 的完整可达路径并有测试？
- [ ] 质量门/checklist/自检是否全部由数据计算或 LLM 自评+标注，无硬编码 true？
- [ ] 隔离字段（projectScope）是否在每个写入入口都透传，且有多项目互斥测试？
- [ ] 是否存在零引用空壳文件/声明却不消费的配置字段？

### 配置
- [ ] 新增环境变量是否在 zod schema 中定义？
- [ ] 数字/布尔是否由 zod 转换（不在 loader 里手动转换）？
- [ ] 必填字段是否没有矛盾的 default('')？
- [ ] 配置类型是否只定义了一次？

### 测试
- [ ] 新功能是否有对应测试？
- [ ] bug 修复是否有回归测试？
- [ ] 边界场景（终态、空值、异常路径）是否覆盖？
- [ ] 断言是否验证了具体行为（不是只验不抛异常）？

### 工程
- [ ] `tsc --noEmit` 通过？
- [ ] `eslint` 0 error 0 warning？
- [ ] `prettier --check` 通过？
- [ ] `vitest run` 全部通过？
- [ ] 未使用的 import 是否已删除？

### 文档
- [ ] issue.md 中相关问题状态已更新？
- [ ] 文档中的数字（测试数等）与实际一致？
- [ ] 新增经验是否沉淀到规范文档？
- [ ] 数据结构变更是否全局搜索了所有消费方？

---

## 八、架构设计规范

### 8.1 多项目/多租户隔离

**经验来源**：#15（KnowledgeService 单例在多项目场景下数据污染）

- 单例本身不是问题，团队级中心化服务适合单例
- 真正的问题是：**检索时没传 projectScope，且上层没有项目 ID 概念**
- 多项目隔离的正确做法：
  1. 数据写入时带 `projectScope` 字段（`global` = 团队共享，项目 ID = 项目特定）
  2. 上层配置（HarnessConfig）必须有 `projectId`，不能假设单项目
  3. 每次检索都必须传入 `projectScope` 过滤，返回当前项目 + global 共享数据
  4. 不能依赖调用方"自觉"传 scope，应该在服务层强制要求
- 单例 + scope 字段 = 逻辑隔离，比多实例更简单且足够

### 8.2 配置化优于硬编码

**经验来源**：#19（Harness maxRetries 硬编码为 2）

- 所有可调参数（重试次数、超时时间、阈值、批量大小）都应该配置化
- 配置项要有合理的默认值，通过构造函数或配置对象传入
- 禁止在业务逻辑中硬编码魔法数字，即使"暂时不会改"
- 新增配置项时同步更新 `.env.example` 和 config schema

### 8.3 生成与修改分离，避免多模式 if 分发

**经验来源**：#32（RequirementAgent 一个类 3 种输入，每个方法内部 if type 分发）、第六轮（DesignAgent 若混用 generate/revise 会重蹈覆辙）

- 同一个 Agent 承担"从 0 生成"和"按反馈修改"两类任务时，**使用独立的输入/输出类型和独立方法**（generate / revise），不要在一个 execute 内按 `input.type` 做 if 分发
- 判断信号：如果一个方法内部需要先判断输入子类型才能工作，说明类型设计把多个职责捆在了一起

**适用边界（第七轮一致性审计 #12 明确）**：

- 本规范约束的是**同一产物的"生成 vs 评审内修改"**（如方案从 0 生成 vs 按 Reviewer 意见 revise、代码生成 vs 按 CR 意见修改）——这类必须拆独立类型/方法，因为修改路径要携带上轮 issue、走问题闭环，与生成路径语义不同
- **跨阶段的不同任务**允许在同一个 Agent 内按 `input.type` 分发：例如 RequirementAgent 同时承担阶段1需求澄清（clarify/clarify-followup）与阶段2故事拆解（generate-stories），它们产物类型不同、属于流水线不同阶段，不是"同产物的两轮"，分发是合理的
- 判定口诀：**问"这两个分支处理的是不是同一个产物的不同版本"——是则必须拆，不是（不同阶段/不同产物）则可分发**
- 已稳定的历史代码（如 RequirementAgent 三模式）按上述边界判定为合规，不强制重构；新增的 Designer/Coder 生成-修改路径必须拆分

**多轮循环如何复用执行骨架（#42 落地补充）**：

- 拆独立方法不等于复制一套"校验→检索→Prompt→带重试 LLM→解析→校验→自检"骨架：BaseAgent 提供泛型执行器 `runAgentCycle<TI,TO>(hooks)`，generate 的 execute 与 revise 都用 hooks 描述各自步骤、共用同一套重试/日志，避免两处逻辑漂移
- 同一评审任务的"第 N 轮"不是新任务类型，而是**同一输出类型的输入参数化**（输入带 round/previousIssues/issueResponses），不要为每一轮新建方法或类型
- 多轮的双方闭环缺一不可：评审方对每个上轮问题逐项给 `verification`（漏项判输出无效、触发重试），修改方对每个上轮问题逐项给 `issueResponse`（遗漏回应 / wont-fix 缺理由判无效），两侧都是纯函数校验（findUnverifiedIssues / findUnansweredIssues），不采信模型自述

### 8.4 两套版本号不可混用

**经验来源**：第六轮架构审查（流程版本 currentVersion 与产物版本 version 语义混淆）

- 流程版本（currentVersion）：回退 +1，标识"第几轮流程"，用于判断下游确认/评审是否要重新执行
- 产物版本（version）：每次生成或评审内修改 +1，单调递增，**不随回退重置**
- 评审对话循环内的修改只增产物版本，不增流程版本（不是回退）

### 8.5 上游产物重生成，必须使下游确认/评审产物失效

**经验来源**：#42 多轮对话联调（弱介入回退到方案重生成后，旧的 design-review-history 会被错误地当作"已进行过的轮次"续跑）

- 当某阶段产物被**重新生成**（回退后重做、人工要求重来），其下游所有"针对旧版本的确认结论、评审结果、对话历史"都必须一并清除，不能让旧确认覆盖新产物
- 实现位置在产物保存处统一处理：Harness 保存 `design` 后 remove `design-review` 与 `design-review-history`；代码侧同理（重编码后旧 code-review 失效）
- 判定口诀：**问"下游这份结论是针对哪一版产物下的"——上游版本变了，针对旧版的结论一律作废重来**
- 测试必须覆盖"回退重生成 → 下游从头开始"（e2e：弱介入回退方案重生成后，评审历史只剩重新评审的 1 轮）

### 8.6 不确定的执行环境抽象为可替换工具，编排与执行分离

**经验来源**：编码阶段（TDD 要"跑测试看红绿"，但 v1 让 LLM 一次生成可编译运行的真实前端项目成本高、脆弱）

- 把外部不确定能力抽象成接口（Workspace 读写文件、TestRunner 跑测试），**编排逻辑（red→green→fix 循环、逐故事、出口判定）只依赖接口、保持真实且可单测**；易变的执行方式做成可替换实现
- 测试执行实现（#83 已落地）：CLI 默认 **LocalSubprocessTestRunner** 真实调用 vitest 子进程（工作区落盘项目 `.sandbox/`，解析 JSON 输出还原真实通过/失败/失败原因，失败降级 StaticTestRunner 并明确标注"降级静态推断"）；静态推断实现（StaticTestRunner）仍保留，用于 `--test-mode static` 快速通道与降级兜底，其结果必须**诚实标注"静态推断/降级"**（规范 1.9），不得伪装成真实跑过；ScriptableTestRunner 确定性编排红绿单测
- **TDD 的 red 必须真失败**：red 阶段只写测试不写实现，若缺实现时测试竟通过，说明是不依赖实现的"假测试"，作为质量门错误拦截（RED_SHOULD_FAIL）；mock 数据文件不算业务实现
- 测试是否通过以 TestRunner 结果为准、每个可测试 AC 是否有测试以程序化映射校验，不采信 LLM 自报（规范 1.14）
- **逐故事/跨条目循环与部分成功出口归 Harness**（流程控制层），单故事 Agent 只负责单故事 TDD、单故事失败不阻塞整体——这是规范 1.12 在批处理场景的延伸

### 8.7 代码 CR 多轮：复用对话骨架，阻塞才触发修订，修订后必重测

**经验来源**：代码 CR 多轮（Reviewer ↔ Coder，第九轮）

- **多轮对话骨架可直接复用**：#42 沉淀的 `runAgentCycle` 泛型执行器 + 问题跟踪闭环（`findUnverifiedIssues`/`findUnansweredIssues`）+ history 产物模式，代码 CR 零新骨架接入，只需 ReviewAgent 按 `input.type` 分发 review-code、CodingAgent 加 `revise` 方法、Harness 加 `runCodeReviewDialog`
- **只有 blocking 问题才触发修订**：`resolveDialogAction` 把非 blocking 的 `request_changes` 程序化降级为 `approve`（ADR-014）。e2e/单测要触发修订路径，issue 的 severity 必须是 blocker/critical（或显式 blocking=true），major 及以下默认不阻塞
- **修订后必须重跑 TestRunner 并更新状态**：CodingAgent.revise 不采信 LLM 自报"已修复"，而是把合并后的文件写入工作区、重跑 TestRunner、用 `deriveStoryStatus` 重算 status、追加 refactor 周期到 tddCycles（规范 1.14 延伸）
- **CR 只针对 success/partial 故事**：failed 故事无有效代码可审，跳过并在 history/交付说明记录；NO_REVIEWABLE_CODE（全部失败）作为输入校验错误
- **多故事修订按 issue.relatedStoryIds 定位**：CR issue 必须带 relatedStoryIds，Harness 据此筛选受影响故事逐个 revise；issue 未带 storyId 时默认影响所有可审查故事（兜底）
- **类型联动**：新增 CodeRevision 后，`DialogMessage.structuredOutput` 联合类型需同步扩展（`ReviewResult | DesignRevision | CodeRevision`），`ReviewRound.revision` 同理；聚合产物替换单产物的下游类型一致性是反复出现的坑（规范 1.6）

### 8.8 审查修复经验：AC 覆盖计算与 selfCheck 分发（第十轮修复）

**经验来源**：全方位设计对照审查发现的 7 个问题（2 重要 + 5 建议）

- **AC 覆盖计算必须只从测试文件提取**：`coveredAcIds` 应 `filter(f => f.type === 'test')` 后再取 `relatedAcIds`。实现文件的 `relatedAcIds` 表示"实现覆盖了哪些 AC"，不代表"测试覆盖了这些 AC"。从所有文件提取会导致 `findMissingTestedAcs` 误判，把实现声明的 AC 算为已被测试覆盖，可能导致 status 误判为 success
- **`expectedAcIds` 应为所有可测试 AC，不是 `coveredAcIds`**：`testRunner.run({ expectedAcIds })` 的语义是"检查这些 AC 是否被测试引用"，应传入 `task.acceptanceCriteria.filter(ac => ac.testable)`。传入 `coveredAcIds`（已被文件声明的 AC）会导致未被声明的 AC 不被检查，可能漏检。`generateCode` 与 `revise` 必须保持一致
- **`selfCheck` 必须按 `input.type` 分发**：ReviewAgent 同时支持 review-design 和 review-code，selfCheck 中的漏审检查（如方案覆盖度）只适用于方案评审分支。代码 CR 阶段方案已经稳定，不应再因为方案覆盖度提示"漏审"。不同评审类型应检查不同的漏审维度
- **回退路径必须有设计依据**：状态机的 `FALLBACK_TRANSITIONS` 中每个回退路径都应能在设计文档中找到依据。CR 发现代码问题应在对话内 revise，不应回退到 CODING 重新编码；只有发现方案性问题才回退 DESIGN_GENERATING。无设计依据的回退路径应移除
- **文件类型推断：LLM 未指定 type 时按路径推断**：`normalizeFiles(files, expectedType)` 在 LLM 未输出 `type` 字段时使用默认类型。CR 修订可能涉及测试文件，默认 component 会导致测试文件被错误分类。应在 normalizeFiles 后对默认类型文件按路径推断（`.test.`/`.spec.`/`__tests__/` → test），LLM 已显式指定类型时不覆盖
- **一致性问题应一并修复**：死代码（buildAgentInput 的 CODE_REVIEWING 分支）、签名不一致（buildSystemPrompt 缺 context 参数）、状态冗余（WEAK_INTERVENTION_STATES 含 CODE_REVIEWING 但实际不走主循环弱介入）等问题虽不影响功能，但会增加维护成本和理解难度，审查时应一并修复

### 8.9 闭环校验 fail-close 与 resume 状态恢复（第十二轮修复）

**经验来源**：#49 findUnverifiedIssues fail-open 修复 + resume 续跑 previousIssues 未恢复的连带问题

- **闭环校验类检查必须 fail-close**：round>=2 时 previousIssues 缺失（undefined）应直接报错，不允许 `?? []` 转空数组后静默通过。但**空数组 `[]` 是合法的**（上一轮确实没有问题），只有 undefined（调用方漏传）才是错误。区分"显式空值"和"缺失值"是 fail-close 设计的关键
- **resume 续跑必须从 history 恢复所有多轮状态**：previousIssues、issueResponses、currentDesign/coding 等多轮对话依赖的状态，在 resume 后必须从已保存的 history 中恢复，不能初始化为空。runDesignReviewDialog/runCodeReviewDialog 应在 startRound 计算后，从 `history.rounds[last].review.issues` 恢复 previousIssues
- **修复 fail-open 时必须检查 resume 路径**：fail-open 修复后，原本静默通过的 resume 路径可能突然报错。必须同步检查 resume 时状态是否正确恢复，否则修复会引入回归
- **保底降级行为必须可观测**：topoSortStories 循环依赖时不能静默按原顺序追加，应返回 cyclicStoryIds 让调用方记录日志/警告。纯函数返回值应包含异常状态信息
- **删除冗余代码前确认从未生效**：buildDesignCoverage 的 componentTouched 分支被同一个表达式短路，删除前确认 allCovered 为 false 时第二个条件也必为 false（逻辑等价证明），删除后行为不变

---

### 8.10 Prompt 模板统一管理（第十四轮 #10 修复）

**经验来源**：#10 delivery prompt 硬编码在 Agent 类内，与其他 Agent 不一致

- **所有 Agent 的 prompt 必须统一放在 `src/prompts/<agent>/` 目录**：system-prompts.ts（常量模板）+ user-prompts.ts（变量渲染函数）+ index.ts（导出）。禁止硬编码在 Agent 类的 buildSystemPrompt/buildUserPrompt 方法内
- **system prompt 用常量，user prompt 用渲染函数**：system prompt 无变量或变量极少，用 `export const XXX_SYSTEM_PROMPT` 常量；user prompt 需要根据输入动态拼接，用 `export function renderXxxUserPrompt(vars: XxxPromptVars): string` 渲染函数
- **PromptVars 接口必须显式定义**：每个 user prompt 的变量类型用 `interface XxxPromptVars` 显式定义，禁止用 `Record<string, string>` 或 any，保证类型安全
- **Agent 类只负责收集变量并调用渲染函数**：buildSystemPrompt 直接返回常量，buildUserPrompt 从 input/context/state 收集变量后调用渲染函数，不包含模板字符串拼接逻辑
- **新增 Agent 时必须同步创建 prompts 目录**：这是 Agent 实现的检查清单项，不允许"先硬编码后迁移"

---

### 8.11 代理判据需要区分度（第十四轮 #45 修复）

**经验来源**：#45 冻结 checklist 的 rulesNoAmbiguity 和 globalRequirementsCovered 共用 `!pendingBlocking` 判据，永远同真同假

- **语义不同的检查项不能共用同一个代理判据**：当某项检查无法纯程序判定、需要用代理判据（如"阻塞问题是否清零"）时，两个不同语义的检查项必须用不同的代理判据，否则 checklist 区分度丧失，等于一个检查项算了两遍
- **按问题 category 细分代理判据**：澄清问题有 category 字段（missing/ambiguous/contradictory/detail/global-requirement），应按 category 分别检查：
  - `rulesNoAmbiguity` → 无 ambiguous/contradictory 类阻塞问题
  - `globalRequirementsCovered` → 无 global-requirement 类阻塞问题
- **代理判据的选择必须在注释中说明理由**：为什么用这个代理、它与真实语义的差距是什么、什么情况下代理会失效，都应在代码注释中明确
- **checklist 设计时必须验证区分度**：设计 checklist 后，构造"只有 A 项不通过、B 项通过"和"只有 B 项不通过、A 项通过"的测试用例，验证两项可以独立变化，不会永远同真同假

### 8.12 真实运行可观测性：先能定位"哪一步"，再能回答"为什么"（第二十轮修复）

**经验来源**：故事拆解真实运行异常超时后，日志无法回答"是模型没返回、解析失败、还是测试环境坏了"，暴露出五个可观测性缺口。

- **traceId 是长流程排障的第一前提**：一次 run 生成一个根 traceId（持久化 `trace-id.txt`，快照恢复保持一致），所有日志、LLM 调用记录、子上下文（分批/多轮对话）必须透传。没有 traceId 时跨文件拼日志只能靠时间戳猜测
- **降级执行必须显式可观测**：真实测试执行器降级为静态推断时，必须有 warn 日志并记录 runner/environment/degraded；静默降级会让"测试通过"的结论失去可信度且无人知晓
- **失败现场按失败类型区别保留**：
  - 环境异常（runner 不存在、spawn 失败、超时、无输出）→ 保留完整现场（工作区拷贝 + error.txt），因为这类问题无法从业务输入复现
  - 正常断言失败（TDD 的 red、实现 bug）→ 不保留现场，失败原因本身就是正常输出，保留只会堆积垃圾
- **解析失败必须保留原始输出**：PARSE_ERROR 只记"解析失败"等于没记——日志带 rawLength/rawContentHead，完整原文按 traceId 落 llm-calls.log，否则无法判断是截断、格式污染还是 prompt 理解偏差
- **指标在终态统一汇总落盘**：MetricsCollector 按 stage/agent 双维度聚合调用次数/失败/token/耗时，终态（含失败、取消）原子写 run-summary.json；指标只收集、不改变流程，落盘失败只 warn 不阻断主流程
- **实例相关文件统一布局**：state.json / trace-id.txt / run-summary.json / logs/ / artifacts/ / test-failures/ 同属一个 instanceDir，禁止散落在多个根目录，否则 resume 与排障都找不到文件

---

## 九、问题修复历史

| 轮次 | 时间 | 问题数 | 已修复 | 关键经验 |
|------|------|--------|--------|----------|
| 第一轮 | 2026-09-02 | 11 | 4 已解决，2 部分解决 | 基础设施（测试/lint/配置校验）必须先搭好 |
| 第二轮 | 2026-09-02 | 15 | 15 全部修复 | 边界场景测试、封装性、配置校验是高发问题区 |
| 第三轮 | 2026-09-02 | 1（修复遗漏） | 1 已修复 | 修复同类问题要全局搜索，文档数据要同步更新 |
| 第四轮 | 2026-09-03 | 10（#12-#15, #18, #19, #23, #35, #36 + 1 状态修正） | 10 全部修复 | 数据结构变更必须全链路同步；重试职责分层；多项目靠 scope 隔离；质量门禁覆盖 tests |
| 第五轮 | 2026-09-03 | 1（#37，端到端验证发现） | 1 已修复 | 集成测试是发现"单测全绿但链路断裂"的关键；Harness 层元数据保存 Agent 结果时必须显式保留 |
| 第六轮 | 2026-09-04 | 14（架构审查，ADR-014） | 10 已修复，4 转遗留（#38-#42） | 状态语义单一/终态完备（1.10）；判定口径唯一、不信任模型自述（1.11）；装配层不做业务检索（1.12）；生成与修改分离（8.3）；两套版本号分离（8.4） |
| 第七轮 | 2026-09-04 | 12（设计-实现一致性审计 #1-#12） | 11 已修复，#12 为规范边界澄清 | 未实现下游路径也要对齐契约（1.13）；质量门禁止硬编码通过（1.14）；隔离字段每个入口透传+多实例测试（1.15）；零引用空壳不保留；配置字段定义即消费 |
| 第八轮 | 2026-09-05 | #42 评审多轮对话机制（design 侧） | 已实现，266 测试全绿 | 多轮复用泛型执行器而非复制骨架、同一任务按轮次参数化（8.3 补充）；评审/修改双侧问题闭环纯函数校验；上游重生成使下游结论失效（8.5）；对话中途暂停用"状态不变+waiting_human"而非 SUSPEND 迁移 |
| 第九轮 | 2026-09-06 | 编码阶段（CodingAgent + 逐故事循环 + #40） | 已实现，295 测试全绿 | 不确定执行环境抽象为可替换工具、编排与执行分离（8.6）；red 必失败反假测试、测试结果/AC 覆盖程序化；逐故事循环与部分成功出口归 Harness、单故事失败隔离；静态推断必须诚实标注未真实执行 |
| 第十轮 | 2026-09-06 | 代码 CR 多轮（Reviewer↔Coder） | 已实现，307 测试全绿 | 多轮对话骨架可直接复用（8.7）；只有 blocking 问题才触发修订，e2e 必须用 blocker/critical；修订后必重跑 TestRunner 不采信自报；CR 只审 success/partial 故事；多故事修订按 issue.relatedStoryIds 定位；类型联动需同步扩展联合类型 |
| 第十一轮 | 2026-09-06 | 全方位设计对照审查与修复 | 已修复，307 测试全绿 | AC 覆盖计算只从测试文件提取、expectedAcIds 为所有可测试 AC（8.8）；selfCheck 按 input.type 分发；回退路径必须有设计依据；文件类型按路径推断；一致性问题一并修复 |
| 第十二轮 | 2026-09-06 | issue 全面审查与修复（#44/#49/#50/#51 + 5 个过时问题状态更新） | 已修复，307 测试全绿 | 闭环校验 fail-close 只检查 undefined 不检查空数组（8.9）；resume 续跑必须从 history 恢复 previousIssues；聚合产物版本语义需明确；保底降级行为必须可观测；冗余代码删除前确认从未生效 |
| 第十三轮 | 2026-09-06 | 交付 Agent（DeliveryAgent + 可替换交付工具层 + Harness 交付阶段编排） | 已实现，315 测试全绿 | 外部依赖操作（文件/Git/构建）抽象为可替换工具层，v1 默认实现调用本地 CLI；重写 execute 自定义流程时 parseOutput 仅满足签名不被调用；场景自动推断+可显式指定；LLM 失败时兜底模板保证产物完整；部分交付（partial）不视为失败；配置新增块必须给 default 值否则测试断裂 |
| 第十四轮 | 2026-09-06~07 | 全方位深度审查（#57~#68 + #10/#45 历史遗留） | 修复 6 项（#57/#58/#59/#67/#10/#45），剩余 8 项 v2 | 类型断言是 Bug 温床，优先用领域类型而非自定义窄类型（#57）；工具层执行外部命令必须用 execFile 而非 exec，杜绝 shell 注入（#58）；质量门禁止硬编码通过，逐故事检查必须程序化（#59）；Prompt 模板统一管理，禁止硬编码在 Agent 类内（8.10/#10）；语义不同的检查项不能共用同一代理判据，按 category 细分（8.11/#45）；修复必须配测试，否则下次重构可能回归 |
| 第十五轮 | 2026-09-10 | 飞书同步端到端调试（#69~#73） | 修复 4 项，1 项 v1 已知限制 | 第三方 API 响应格式不能假设统一（认证顶层 vs data 包裹、多模态 embedding 单对象 vs 数组）；枚举类型必须查官方文档（obj_type 字符串 vs 数字）；模型 ID 用具体 ID 非显示名；无状态 CLI 与内存存储不兼容；调试脚本及时清理 |
| 第十六轮 | 2026-09-10 | 真实 forge run 端到端（#74~#80） | 修复 5 项，#81 遗留 | 模型名全小写否则 404；maxTokens 按实际输出量设置；finishReason 必须记录；超时按大输出场景设置；logger 必须透传；新增 parseJsonWithRecovery；followup/revise 用增量输出并兼容全量 |
| 第十七轮 | 2026-09-11 | 性能优化与深度验证（#80 分批、#81/#62 确认） | 故事拆解分批并行落地，#81 遗留 | 大输出场景分批并行（每批≤6、并发 3），LLM 自评估字段全部去掉改程序计算；复杂自洽结构需分阶段或放宽校验；实际超时限制必须实测确认（设置 30 分钟实际 15 分钟） |
| 第十八轮 | 2026-09-12 | 五维度全面设计审查（25 问题） | 4 严重/5 重要/6 建议，10 合并 | 设计必须考虑 LLM 输出能力边界；严重问题识别需要跨维度交叉审查；明确"设计目标 vs v1 实际"避免过度承诺；可观测性是 AI 系统基础能力 |
| 第十九轮 | 2026-10-12 | #47/#83/#85 指定修复 | 全部修复，370 测试全绿 | TDD 必须真实执行（.sandbox 真实 vitest，降级显式标注）；大类按职责拆分（ReviewDialog/CodingPhase/state-transitions/human-interaction），行为零变化；设计文档加"实现状态"表保持同步 |
| 第二十轮 | 2026-10-13 | 可观测性五项缺口（traceId/测试日志/失败现场/PARSE_ERROR/Metrics） | 全部修复，375 测试全绿 | 先定位"哪一步失败"再回答"为什么失败"（8.12）；traceId 全链路透传；降级必须可观测；失败现场按类型区别保留；解析失败保留原始输出；指标终态统一汇总；实例文件统一布局 |
