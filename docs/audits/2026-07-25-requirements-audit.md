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
| 3 | 角色代理数据注入（酒馆卡 + 动态内容） | ✅ 已核对 | 双层结构与设计一致；发现 3 处实现偏差 |
| 4 | 角色输出回写世界图机制 | ✅ 已核对 | 写回链路一致；发现 1 个严重断链 + 2 个小问题 |
| 5 | （待核对） | — | — |

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

## 核对项 3：角色代理数据注入（2026-07-25）

**需求描述**（用户提问）：角色代理得到的数据是什么样的？酒馆角色卡格式的提示词 + 动态的内容注入？注入的内容包括世界图内的什么字段？

### 结论：确认是「酒馆角色卡（静态层）+ 动态事实（动态层）」双层注入

设计文档 `2026-07-24-role-pool-design.md` 决策 #6（静态层格式：酒馆角色卡 JSON 直接复用 SillyTavern V2 卡）与源码完全一致。

### 完整注入结构（每次角色 LLM 调用）

**System Prompt**（`role-pool/src/prompts.ts` buildSystemPrompt）：
1. `角色规则集.md` 全文（⚠️ 文件当前缺失，静默为空）
2. 静态/动态冲突提醒（"以动态层为准"）
3. `executionHints` 用户特殊要求（可选，独立段落）

**User Message**（buildUserMessage，角色信息在前、事件指令在末尾）：

| 段 | 内容 | 世界图字段来源 |
|---|------|--------------|
| 0 | `[你的 entityId]` + `[本场角色名单]`（characterId→name 映射） | cast 全员的 characterId + staticCard.name |
| 1 | `─── 你的角色卡（静态层）───` SillyTavernCard JSON | 见下方映射表 |
| 2 | `─── 你的当前状态（动态层）───` 逐行 `- property: valueText（modality）` | 见下方映射表 |
| 3 | `[故事时间]` | StructuredEvent.storyTime |
| 4 | `[先动者行动]`（如有） | PriorAction：仅 actor/action/target **公开字段**（thought/emotion 不可见） |
| 5 | `[事件指令]` + tool call 要求 + characterId 填写规则 | StructuredEvent.instruction |

### 静态层 ← 世界图字段映射（`scheduler/src/static-card-loader.ts`）

| 酒馆卡字段 | 来源 |
|-----------|------|
| `name` | Fact `property="name"` 的 value；缺省用 entityId |
| `description` | **Entity.summary**（实体无状态客观事实描述，独立字段，不进 Fact） |
| `personality` / `scenario` / `first_mes` / `mes_example` / `creator_notes` / `tags` | 同名 Fact property 的 value |

实体不存在/已消亡 → 返回最小卡 `{ name: characterId, description: "" }`，不崩。

### 动态层 ← 世界图字段映射（`plan.ts` 步骤 4-6）

**组装机制**：planner LLM 输出 RetrievalPlan（每项含 `assignTo` 信息差分配）→ 逐项检索 → 结果按 assignTo 并入各角色 dynamicFacts 池；兜底每人至少 1 条 `character_view`（wg.getCharacterView 五步过滤后的可见声明）。

**FactSnapshot 携带字段**（`role-pool/src/types.ts:29`）：`declarationId` / `entityId` / `property` / `value` / `valueText` / `modality` / `validFrom`（**无 validTo**——动态层均为 storyTime 时刻有效的声明，知识持续语义）。

**实际渲染**（formatFact）：仅 `property` + `valueText ?? value` + `modality` 三样。

### 发现的实现偏差

#### 偏差 1：动态层不显示 Fact 归属（entityId 丢失）⚠️

`formatFact` 只渲染 `- property: value（modality）`，**不渲染 entityId**。而 dynamicFacts 池可包含**其他实体**的 Fact（character_view 返回"该角色可见的所有声明"，search_* 结果同理）。LLM 看到 `- plan: 火烧草料场（fact）` 时无法区分这是谁的 plan——自己的状态与"我知道的别人的事"混在一起。

#### 偏差 2：检索项 label 未注入（schema 承诺未兑现）⚠️

planner schema 中 `label` 的描述是"检索项语义标签（**注入角色提示词时用作小标题**）"，`plan.ts` 注释也写"检索结果按 label 分组追加"——但实现是 `facts.push(...result)` 扁平追加，**label 在传递链中丢失**（FactSnapshot 无 label 字段，formatFact 不渲染）。"我是怎么知道这件事的"这一来源信息没有进入 prompt。

#### 偏差 3：静态卡注释与代码不符（小）

`static-card-loader.ts` 头注释称"其他字段：按 property 名透传到 card"，但代码只透传 `KNOWN_FIELDS` 8 个字段，非白名单 Fact（如 `mood`/`health`）不会进入静态卡（它们只能走动态层）。行为本身合理，注释误导。

### 关联已知问题

- `角色规则集.md` 缺失 → system prompt 第 1 段为空，角色扮演无行为约束（见附录"已知未决"）

---

## 核对项 4：角色输出回写世界图（2026-07-25）

**需求描述**（用户提问）：角色子代理扮演完成后的内容是怎么写回到世界图内的？调用工具？

### 回答：两层机制——LLM 侧是 tool call；写图侧是直接 import 函数（不是 pi 工具）

**第一层：角色 LLM 输出 = tool call** ✓
- `character_action` 工具（`src/role-pool-llm.ts` characterActionSchema，9 字段）
- pi-ai `validateToolCall` 校验；LLM 偶发返回纯文本时重试 ≤3 次；单角色失败跳过记 errors

**第二层：写世界图 = 直接 import 子包函数**（决策 #14："不绕道 pi.tools.execute 是为了性能和类型安全"；效果等价于 `world_event_apply`/`world_relation_add` 工具）

### commit.ts 写回链路（8 步中与写图相关的 2-5 步）

```
RoleAgentOutput[]
  ├─ extractStateChanges → StateChange[]（entityId/property/value/modality）
  │    └─ 按 entityId 分组（决策 #7：每组一个 change 事件）
  │         ├─ getEntityAt 查同 property 未闭合旧 Fact → invalidated[]
  │         └─ wg.processEvent({ type:"change", source:"engine",
  │              invalidated, newFacts })  ← 先写 events.jsonl 再改图
  └─ extractRelations → 逐条 wg.addRelation(source=characterId,
       target=characterId, label, storyTime)  ← Pending Gap #2 已解决，无需消解
```

**不进世界图的字段**：`action`/`emotion`/`thought`/`target`（行动描述）只经 `toRoleOutputs` 投影给渲染器。

### 🔴 严重断链：state_changes 的新 Fact 无可见性记录（角色"自盲"）

**问题链**：
1. commit 用 `processEvent` 写入新 Fact（如林冲 mood=绝望）——**但不写任何 Visibility 记录**
2. 下一场戏 plan 阶段，兕底检索项 `character_view` 走五步过滤（`character-view.ts:31`：`visDecls.find(v => v.declarationId === decl.declarationId)`，无记录即不可见）
3. 结果：**角色在下一场戏看不见自己上一场的状态变化**——"我自残了但我不记得"

**为什么导入数据没这问题**：导入管道阶段 6 用 LLM 显式推断可见性并经 `write.ts` 调 `setVisibility` 落图（v3 db 有 162 条 Visibility 记录）；运行时 commit 路径缺了对应环节。

**临时绕行**：planner LLM 若恰好派发 `entity_snapshot`（不查可见性，`retrieve.ts:108`）则可见——但不可控，靠 LLM 心情。

**修法选项**：
- a) commit 写 state_changes 时同步 `setVisibility(characterId=entityId 属主, declarationId=新 Fact)`（自产自知）
- b) character_view 五步过滤加"自己的声明自动可见"规则（改 world-graph 内核语义）
- c) knowledge_gained 驱动可见性（见下，但需自然语言→declarationId 映射，成本高）

### 其他发现

| # | 问题 | 位置 | 严重度 |
|---|------|------|-------|
| 1 | `knowledge_gained` 不落图：transforms.ts 注释"由调度器处理"，但 commit.ts 未处理——只随 RoleOutput 进渲染器 | commit.ts | ⚠️ 中（与断链同源） |
| 2 | invalidated 只取"第一个同 property 未闭合 Fact，假设唯一"（代码注释自承），重复 property 时漏闭合 | commit.ts:88 | ⚠️ 低 |

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
