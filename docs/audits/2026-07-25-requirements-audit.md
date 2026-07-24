# 需求-源码核对记录

> **用途**：逐项核对"设计需求 ↔ 实际源码"的一致性，记录核对结论、发现的空白与待决策项。
> **更新方式**：每完成一项核对，在本文档追加/更新对应章节。
> **基线**：`feat/role-pool` 分支，HEAD = `264a3cd`（2026-07-25 基线清理，4 commits，200 测试全绿）

---

## 核对项总览

| # | 核对项 | 状态 | 结论 |
|---|--------|------|------|
| 1 | 使用方式：口述 → 意图判断 → 引擎启动 | ✅ 已核对 | 链路成立，发现 3 个设计空白 |
| 2 | 调度器工作模式 | ✅ 已核对 | 功能闭环等价，运行形态 3 处偏离 + 1 项 V2 愿景未实现 |
| 3 | （待核对） | — | — |

---

## 核对项 1：使用方式（2026-07-25）

**需求描述**：用户直接口述大纲或内容，主会话判断是否叙事意图，然后启动整个引擎流程。

### 链路验证（逐环核实）

| 环节 | 设计 | 源码实证 | 状态 |
|---|---|---|---|
| ① 用户口述 | 自然语言，禁止工程语言（main-session.md §2 "你来翻译"） | — | ✓ |
| ② prompt 注入 | `main-session.md` 追加到 systemPrompt 末尾（注意力最强位） | `src/index.ts:236` `before_agent_start` 返回 `systemPrompt + "\n\n" + mainSessionPrompt`；`build.mjs` 已修复 prompts/ 资产复制 | ✓ |
| ③ 意图分类 | §2 八类意图表（add/modify/insert/查询/节点改/撤销/伏笔/闲聊） | 注入内容与设计逐字一致 | ✓ |
| ④ 五要素补全 | §4：storyTime/locationId/instruction/intent/characterIds；角色名→entityId 用 `world_query` 消解 | `StructuredEvent` 类型（`packages/scheduler/src/types.ts:71`）字段一一对应 | ✓ |
| ⑤ mode 判断 | §3：plan 缺省（人在回路）/ yolo 连推 | `DispatchPlanOutput` / `DispatchYoloOutput` 双返回类型（`types.ts:314/333`） | ✓ |
| ⑥ 引擎启动 | `scheduler_dispatch` → planner 检索 → 角色池演绎 → commit 写扩散+渲染 | 30 个工具已注册；scheduler 82 测试全绿 | ✓ |

**结论**：用户口述"林冲推开酒馆门走进去"→ 主会话判断叙事意图 → 补齐五要素 → 派发调度器，全程无需工程词汇。**设计与源码一致。**

### 发现的设计空白（待需求决策）

#### 空白 1：「口述大纲」的粒度未定义 ⚠️

当前事件模型是**单事件派发**（一次 `scheduler_dispatch` = 一个 StructuredEvent = 一场戏）。用户口述**多场景大纲**时（例："第一卷：误入白虎堂 → 刺配沧州 → 风雪山神庙"），main-session.md 没有指导：

- 逐场景逐个 `plan` 派发（每场都等用户审）？
- 先输出拆解方案给用户确认，再 `yolo` 连推？
- 大纲本身要不要先存进世界图（作为 concept 实体）？

**涉及文件**：`src/prompts/main-session.md`（§2 意图表、§4 五要素）

#### 空白 2：「大纲讨论」中间态未分类 ⚠️

§2 意图表把输入二分为"叙事 → 启动引擎" / "闲聊 → 正常回答"。但"我口述大纲、你帮我看看"这种**讨论态**（用户还不想让引擎动）落在两类之间，没有明确归属——可能被误判为剧情推进而误启动引擎。

**涉及文件**：`src/prompts/main-session.md`（§2 意图表需增加"大纲讨论/构思"类目）

#### 空白 3：冷启动建档无引导 ⚠️

全新故事第一次口述时世界图是空的，`world_query("林冲")` 角色消解落空。main-session.md §4 未说明查不到角色时怎么办：

- 先 `world_entity_create` 建档再派发？
- 还是直接派发、让角色池自由生成后由 commit 建档？（当前 commit 只对已有 entityId 写扩散）

**涉及文件**：`src/prompts/main-session.md`（§4）；`packages/scheduler/src/commit.ts`（是否支持 birth 事件写入）

### 待实测项

- [ ] 端到端实测（需重启 pi 会话使世界图初始化生效，当前修复已就位：better-sqlite3 绑定、v3 路径、prompts 同步）

---

## 核对项 2：调度器工作模式（2026-07-25）

**需求描述**（用户口述）：调度器是一个独立的**持续后台运行的子代理**；主会话将叙事指令派发给调度器；调度器**理解叙事意图**，**使用工具查询世界图**，为每个角色构建知识，让角色开始扮演；最后接收输出，写入世界图并发给渲染器渲染。

### 逐条核对

| # | 设计预期 | 实际实现 | 判定 |
|---|---------|---------|------|
| ① | 调度器是独立**持续后台运行**的子代理 | **同步 pi 工具调用**（`scheduler_dispatch`，请求-响应）。无常驻进程、无自主循环，每次调用处理一个事件 | ⚠️ **偏离 1** |
| ② | 主会话派发叙事指令 | `scheduler_dispatch` 接收 `StructuredEvent` | ✓ 一致 |
| ③ | 调度器**理解叙事意图** | 意图理解在**主会话**完成（main-session.md §2/§4，设计决策 #2/#11）；调度器内嵌 planner LLM 只做**检索计划推导** | ⚠️ **偏离 2**（有意决策） |
| ④ | 调度器**使用工具查询**世界图 | planner LLM 以 tool call 输出 `RetrievalPlan`，**调度器代码程序化执行检索**（`plan.ts` 步骤 5，`retrieve.ts`）。LLM 决定查什么，代码执行——非 agent 自主调工具 | ⚠️ 半偏离（语义等价，形态不同） |
| ⑤ | 为每个角色构建知识 | `plan.ts` 步骤 6-7：按 `assignTo` 分配检索结果（**信息差分配**）构建 dynamicFacts + staticCardLoader 重组静态卡 → `CastMember[]` | ✓ 一致 |
| ⑥ | 角色开始扮演 | `@pi/role-pool.interact` 串行演绎（后动者可见先动者公开 action） | ✓ 一致 |
| ⑦ | 接收输出 | plan 结果缓存（`planId → PlanResult`，含磁盘持久化 + TTL 1h） | ✓ 一致 |
| ⑧ | 写世界图 + 发渲染器 | `commit.ts`：`extractStateChanges` → 按 entityId 分组 `processEvent` 写扩散；`extractRelations` → `addRelation`；`toRoleOutputs` → `renderToFile`（add/modify）/ `renderText`+`insertChapterSection`（insert） | ✓ 一致 |

### 偏离详述

#### 偏离 1：持续后台子代理 → 同步工具调用

- **V2 愿景**（`docs/legacy/v2-design-notes.md` §3.2）：核心循环"事件输入 → 分配知识 → 角色交互 → 扩散 → 渲染 → 下个事件 → **循环直到暂停标记**"
- **实际**：无循环。循环由**用户口述 + 主会话**驱动（一次 dispatch 一个事件）；"暂停标记"式人在回路变为 **plan/commit 双阶段**（plan 跑到角色输出即中断等审）
- **依据**：调度器设计文档决策 #14 明确选择 pi 工具机制（"与现有 render_append / role_interact 一致；不绕道 pi.tools.execute 是为了性能和类型安全"）

#### 偏离 2：意图理解归属

- **预期**：调度器理解叙事意图
- **实际**：主会话做意图理解 + 五要素结构化（含角色名→entityId 消解）；调度器接收已结构化的 `StructuredEvent`，planner LLM 只推导"查什么"
- **依据**：设计决策 #2（"主会话作为任务外包方已完成意图理解和角色识别"）、#11（"不脑补业务规则"）

#### 偏离 3（V2 愿景未实现）：角色子代理跨事件持久化

- **V2 愿景**（§3.1/§3.4）："每个角色一个独立子代理实例，**跨事件持久化**（保持对话历史和记忆）；只接收增量信息，不全量刷新"
- **实际**：`role-pool.interact` **无状态**——每次调用重新组装 CastMember（静态卡 + 动态事实），无跨事件对话历史。角色"记忆"仅通过世界图 Fact 间接持续（知识持续语义）
- **影响**：角色无法记住"上一场戏我说过这句话的语气/措辞"，只能记住结构化状态

### 待决策

- [ ] **D1**：是否接受"同步工具 + plan/commit"形态？（还是要向 V2 愿景的常驻循环演进）
- [ ] **D2**：是否接受意图理解归主会话？（当前实现下调度器更"笨"但更可控）
- [ ] **D3**：角色跨事件对话历史是否需要补？（涉及 role-pool 状态化改造，成本高）

---

## 附：基线环境状态（2026-07-25）

### 已修复

| 问题 | 修复 | 验证 |
|------|------|------|
| better-sqlite3 原生绑定丢失（session_start 静默失败根因） | 两仓库 `npm rebuild` | ✓ WorldGraph 可打开 v3 db |
| 运行时世界图路径 v2/v3 错配 | `resolveWorldGraphDir` → v3 | ✓ 25 实体 / 37 事件可读 |
| `prompts/main-session.md` 未纳入构建产物 | `build.mjs` 增加资产复制 | ✓ 已同步到扩展目录 |
| 未提交代码裸奔 | 4 个逻辑 commit 建基线 | ✓ 工作区干净 |

### 已知未决

| 问题 | 状态 |
|------|------|
| 三个规则集 .md（规则集/planner 规则集/角色规则集）缺失 | 待内容来源 |
| `world_status` 缺省 storyTime="Infinity" 字符串比较导致显示 0 实体 | 待决策是否修 |
| HF 向量模型未缓存（首次 embed 需联网，可配 HF_ENDPOINT 镜像） | 环境待备 |
| api.md 文档滞后（25→30 工具、scheduler/role-pool/main-session 章节缺失） | 待核对完成后统一更新 |
| 分支名 `feat/role-pool` 名不副实（已承载 scheduler + build 修复） | 待决策 |
| 伏笔机制（pending-impacts.json / accumulators.json） | 设计明确未实现，一致 |
