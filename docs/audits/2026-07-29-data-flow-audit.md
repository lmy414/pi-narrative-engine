# 数据流审计（2026-07-29）

> 基于源码查证（行号引用），梳理引擎实际任务中各阶段输入输出、工具返回值、数据库字段写入路径，并标记发现的优化点。
> 查证方法：5 个 search subagent 并行查证 scheduler 流水线 / LLM 子模块 / world-graph schema / 工具返回值 / memory+retrieve，无脑补。

---

## 0. 全景：一次 scheduler_dispatch(mode="yolo") 的端到端数据流

```
用户口述
  ↓
主会话消解角色名 → entityId（调 world_query）
  ↓
scheduler_dispatch(StructuredEvent)
  ↓
┌─────────── dispatch 流水线（plan.ts）───────────┐
│ 阶段0 生成 traceId/eventId/planId/chapterPath    │
│ 阶段1 plannerLlm(event) → RetrievalPlan         │ ← LLM #1（temperature=0.3）
│ 阶段2 retrieve 执行 → FactSnapshot[]            │
│   └─ 按 assignTo 分配到 dynamicFactsByCharacter │ ← 信息差第一层
│ 阶段2.5 解析 ownerName（wg.getEntityAt）        │
│ 阶段3 role-pool.interact(cast) → RoleAgentOutput[]│ ← LLM #2（temperature=0.7，串行 + PriorAction 信息差第二层）
│ 阶段4 缓存 PlanResult（session Map + 文件）     │
│ 阶段5 plan 模式返回 / yolo 自动 commit          │
└─────────────────────────────────────────────────┘
  ↓ (yolo 模式)
┌─────────── commit 写扩散（commit.ts）───────────┐
│ 步骤1 取 PlanResult                             │
│ 步骤2 extractStateChanges → StateChange[]       │
│ 步骤3 groupBy entityId                          │
│ 步骤4 per entityId 写扩散：                     │
│   4.1 查 invalidated（wg.getEntityAt）          │
│   4.2 wg.processEvent(change) → 新 Fact         │ ← DB写入 #1
│   4.2.5 wg.updateFactEmbedding（增量写向量）    │ ← DB写入 #2（P0-5 修复）
│   4.3 wg.setVisibility(source="experienced")    │ ← DB写入 #3（自产自知）
│ 步骤4.4 knowledgeMapper LLM → wg.setVisibility(source="informed") │ ← LLM #3 + DB写入 #4（P0-3 修复）
│ 步骤5 wg.addRelation                            │ ← DB写入 #5
│ 步骤6 toRoleOutputs → RoleOutput[]              │
│ 步骤7 renderer.renderToFile → 章节文件          │ ← LLM #4（temperature=0.7）
│ 步骤8 deletePlan                                │
└─────────────────────────────────────────────────┘
  ↓
updateMemory → memory.md 全量覆盖
```

**LLM 调用次数**（yolo 模式，N=角色数）：
- plannerLlm × 1
- roleLlm × N（串行）
- knowledgeMapper × N（仅当 knowledge_gained 非空）
- renderLlm × 1
- 总计：2 + 2N 次 LLM 调用

---

## 1. scheduler_dispatch 流水线详解

### 1.1 工具入参（StructuredEvent）

源码：[src/index.ts:1216-1246](file:///d:/claude/pi-ex/narrative-engine/src/index.ts#L1216-L1246) / [packages/scheduler/src/types.ts:88-122](file:///d:/claude/pi-ex/narrative-engine/packages/scheduler/src/types.ts#L88-L122)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `storyTime` | string | 是 | `ch{NNN}.ev{NNN}`，如 `ch009.ev006` |
| `instruction` | string | 是 | 事件指令（主会话已加工） |
| `characterIds` | string[] | 是 | 参与角色 entityId 列表 |
| `executionHints` | string | 否 | 用户特殊要求 |
| `mode` | `"plan"\|"yolo"` | 否 | 缺省 `plan` |
| `chapterPath` | string | 否 | 缺省时由 storyTime 推断 |
| `locationId` | string | 否 | ⚠️ **schema 收集但 plan/commit 全文未消费**（见优化点 #1） |
| `intent` | `"add"\|"modify"\|"insert"` | 否 | 缺省 `add` |
| `targetEventId` | string | 否 | modify/insert 必填 |
| `userInput` | string | 否 | 用户口述原文（写入 EventLog） |

### 1.2 阶段 0：初始化

源码：[packages/scheduler/src/plan.ts:49-69](file:///d:/claude/pi-ex/narrative-engine/packages/scheduler/src/plan.ts#L49-L69)

| 输入 | 输出 |
|---|---|
| `event.storyTime` / `event.chapterPath` / `ctx.cwd` | `traceId` / `eventId=evt_{ts}_{rand6}` / `planId=plan_{ts}_{rand6}` / `chapterPath` |

### 1.3 阶段 1：planner LLM 推导检索计划

源码：[packages/scheduler/src/plan.ts:75-96](file:///d:/claude/pi-ex/narrative-engine/packages/scheduler/src/plan.ts#L75-L96) / [src/planner-llm.ts:74-99](file:///d:/claude/pi-ex/narrative-engine/src/planner-llm.ts#L74-L99)

**输入**：
- systemPrompt = `plannerRuleSet` 全文 + 6 种检索能力清单 + 任务说明（[packages/scheduler/src/prompts.ts:28-88](file:///d:/claude/pi-ex/narrative-engine/packages/scheduler/src/prompts.ts#L28-L88)）
- userMessage = `event.instruction` + `event.storyTime` + `event.characterIds` + `event.executionHints`

**LLM 配置**：
- model：`PI_PLANNER_MODEL → PI_MODEL → deepseek-v4-flash`（[src/llm-config.ts:27-41](file:///d:/claude/pi-ex/narrative-engine/src/llm-config.ts#L27-L41)）
- maxTokens: 2000，temperature: 0.3（"检索推导需要稳定"）
- 重试：`MAX_NO_TOOL_RETRIES=3`（LLM 未调工具时重试）

**输出**：`RetrievalPlan`（[packages/scheduler/src/types.ts:139-216](file:///d:/claude/pi-ex/narrative-engine/packages/scheduler/src/types.ts#L139-L216)）

```ts
interface RetrievalPlan {
  items: RetrievalItem[];
}

interface RetrievalItem {
  type: "character_view" | "entity_snapshot" | "relations"
      | "search_text" | "search_vector" | "search_hybrid";
  params: {
    entityId?: string;           // character_view/entity_snapshot/relations 用
    query?: string;              // search_* 用
    nodeType?: "Entity"|"Fact"|"Relation"|"Visibility";
    limit?: integer;
    fieldPath?: string;          // 缺省 "embedding"
    modalityFilter?: ("fact"|"belief"|"hypothesis")[];
    recordedAsOf?: string;       // 双时态检索（retcon 隔离）
  };
  assignTo: string[];            // 检索结果分配给哪些角色（信息差第一层）
  label: string;                 // 语义标签（注入角色 prompt 作小标题）
}
```

### 1.4 阶段 2：检索执行 + 信息差分配

源码：[packages/scheduler/src/plan.ts:98-158](file:///d:/claude/pi-ex/narrative-engine/packages/scheduler/src/plan.ts#L98-L158) / [packages/scheduler/src/retrieve.ts:71-233](file:///d:/claude/pi-ex/narrative-engine/packages/scheduler/src/retrieve.ts#L71-L233)

**子阶段 2a：兜底**（plan.ts:101-121）
- 过滤 `item.assignTo` 中未参与的角色
- 每个 `characterId` 至少补 1 条 `character_view` 自查项

**子阶段 2b：逐项执行**（retrieve.ts 派发）

| RetrievalItem.type | 调用 | nodeType 缺省 | 用 embedding？ |
|---|---|---|---|
| `character_view` | `wg.getCharacterView(entityId, storyTime, opts)` | — | 否 |
| `entity_snapshot` | `wg.getEntityAt(entityId, storyTime, opts)` | — | 否 |
| `relations` | `wg.getRelations(entityId, storyTime, opts)` | — | 否 |
| `search_text` | `wg.search.fulltext(nodeType, {query, limit})` | `"Fact"` | 否 |
| `search_vector` | `embedder.embed(query)` → `wg.search.vector(nodeType, {fieldPath, queryEmbedding, limit})` | `"Entity"` | 是 |
| `search_hybrid` | `embedder.embed(query)` → `wg.search.hybrid(nodeType, {vector, fulltext, limit})` | `"Fact"` | 是 |

**输出**：`FactSnapshot[]`（[packages/scheduler/src/types.ts:42-66](file:///d:/claude/pi-ex/narrative-engine/packages/scheduler/src/types.ts#L42-L66)）

```ts
interface FactSnapshot {
  declarationId: string;
  entityId: string;
  property: string;
  value: unknown;
  valueText?: string;
  modality: "fact" | "belief" | "hypothesis";
  validFrom: string;
  validTo?: string;            // "Infinity" = 未闭合
  ownerName?: string;          // 阶段 2.5 填入
  label?: string;              // 来自 RetrievalItem.label
}
```

**信息差分配**（plan.ts:131-158）：按 `item.assignTo` 把 FactSnapshot 累加到 `dynamicFactsByCharacter: Map<characterId, FactSnapshot[]>`。

**⚠️ 无 dedup**（[plan.ts:154 注释](file:///d:/claude/pi-ex/narrative-engine/packages/scheduler/src/plan.ts#L154)）：同一 declarationId 可能跨多条 RetrievalItem 被命中并多次注入角色提示词，浪费 token（Pending Gap #11）。

### 1.5 阶段 2.5：属主名解析

源码：[packages/scheduler/src/plan.ts:160-180](file:///d:/claude/pi-ex/narrative-engine/packages/scheduler/src/plan.ts#L160-L180)

对每个 entityId 调 `wg.getEntityAt(eid, storyTime)`，取 `name` Fact 或 summary 截断 20 字符，回填到 `FactSnapshot.ownerName`。

### 1.6 阶段 3：角色池演绎

源码：[packages/scheduler/src/plan.ts:182-263](file:///d:/claude/pi-ex/narrative-engine/packages/scheduler/src/plan.ts#L182-L263) / [packages/role-pool/src/role-pool.ts:31-65](file:///d:/claude/pi-ex/narrative-engine/packages/role-pool/src/role-pool.ts#L31-L65)

**构建 CastMember[]**（plan.ts:183-188）：
```ts
interface CastMember {
  characterId: string;
  staticCard: SillyTavernCard;   // 调 ctx.staticCardLoader(characterId, storyTime)
  dynamicFacts: FactSnapshot[];  // 来自 dynamicFactsByCharacter
}
```

**调用 role-pool.interact**：
- 输入：`InteractCommand = { eventInstruction, storyTime, cast, executionHints }`
- LLM 配置：`PI_ROLE_MODEL → PI_MODEL → deepseek-v4-flash`，maxTokens 4000，temperature 0.7
- 串行执行（[role-pool.ts:41-63](file:///d:/claude/pi-ex/narrative-engine/packages/role-pool/src/role-pool.ts#L41-L63)）

**信息差第二层（串行演绎）**：
- 后动者收到先动者的 `PriorAction`（仅 `actor/action/target?` 三字段，**不含** thought/emotion/state_changes/knowledge_gained）
- 单角色失败跳过、记录 `errors`、不中断后续

**输出**：`RoleAgentOutput[]`（[packages/role-pool/src/types.ts:88-101](file:///d:/claude/pi-ex/narrative-engine/packages/role-pool/src/types.ts#L88-L101)）

```ts
interface RoleAgentOutput {
  actor: string;               // 人类可读名字（渲染器用）
  characterId: string;         // entityId（world-graph 用）
  action: string;              // 可观察行动
  target?: string;
  emotion?: string;
  relation_update?: { target: string; label: string }[];  // target = 对方 characterId
  thought?: string;            // 内心独白（其他角色不可见）
  knowledge_gained?: string[]; // 获得的知识
  state_changes?: StateChange[];
}

interface StateChange {
  entityId: string;
  property: string;
  value: unknown;
  modality: "fact" | "belief" | "hypothesis";
}
```

### 1.7 阶段 4-5：缓存与返回

源码：[packages/scheduler/src/plan.ts:265-322](file:///d:/claude/pi-ex/narrative-engine/packages/scheduler/src/plan.ts#L265-L322)

**缓存 PlanResult**（session Map + 文件持久化，[packages/scheduler/src/cache.ts:73-80](file:///d:/claude/pi-ex/narrative-engine/packages/scheduler/src/cache.ts#L73-L80)）

**plan 模式返回**（`DispatchPlanOutput`，types.ts:427-438）：
```ts
{
  mode: "plan",
  planId: string,
  eventId: string,             // 渲染锚点
  chapterPath: string,
  outputs: RoleAgentOutput[],  // 主会话可审阅
  errors: { characterId: string; error: string }[],
  cast: { characterId: string; name: string; summary: string }[],
  retrievalPlan: RetrievalPlan // 透明展示 planner 推导结果（调试用）
}
```

**yolo 模式返回**（`DispatchYoloOutput`，types.ts:446-451）：在 plan 基础上追加 `commitResult: CommitResult`。

---

## 2. scheduler_commit 写扩散详解

### 2.1 入参与返回

源码：[src/index.ts:1294-1328](file:///d:/claude/pi-ex/narrative-engine/src/index.ts#L1294-L1328) / [packages/scheduler/src/commit.ts:71-433](file:///d:/claude/pi-ex/narrative-engine/packages/scheduler/src/commit.ts#L71-L433)

**入参**：`{ planId: string }`（仅此一个字段）

**返回 `CommitResult`**（[packages/scheduler/src/types.ts:311-337](file:///d:/claude/pi-ex/narrative-engine/packages/scheduler/src/types.ts#L311-L337)）：
```ts
interface CommitResult {
  ok: boolean;                              // 写扩散+关系+渲染均成功才为 true
  planId: string;
  eventId: string;                          // 渲染锚点
  appliedEventIds: string[];                // 每个 entityId 一个 change 事件 ID
  chapterPath: string;
  writtenText: string;                      // 渲染的正文
  error?: string;                           // ok=false 时聚合错误
  failedEntityIds?: string[];               // P0-4：写扩散失败的 entityId
  failedRelations?: Array<{ source: string; target: string; label: string }>;
}
```

### 2.2 内部 8 步流程

| 步 | 源码行 | 操作 | DB 写入 |
|---|---|---|---|
| 1 | commit.ts:80-92 | `getPlan(planId)` 取 PlanResult | — |
| 2 | commit.ts:111-127 | `extractStateChanges(outputs)` 扁平化 + 建立 `changeAuthors: Map<entityId, Set<characterId>>` | — |
| 3 | commit.ts:130 | `groupBy(stateChanges, c => c.entityId)` | — |
| 4.1 | commit.ts:146-164 | `wg.getEntityAt(entityId, storyTime)` 找同 property 未闭合 Fact → `invalidated[]` | — |
| 4.2 | commit.ts:166-184 | `wg.processEvent({type:"change", invalidated, newFacts})` | **EventLog JSONL + Fact 表**（闭合旧 Fact validTo=storyTime，写入新 Fact validFrom=storyTime） |
| 4.2.5 | commit.ts:186-211 | `embedder.embedFact(decl)` → `wg.updateFactEmbedding(declId, vec)` | **Fact.embedding**（512 维，P0-5 修复，失败不阻断） |
| 4.3 | commit.ts:213-234 | `wg.setVisibility(knowerId, declId, {source:"experienced", confidence:1})` | **Visibility 表**（自产自知，失败不阻断） |
| 4.4 | commit.ts:246-320 | `knowledgeMapper(characterId, knowledgeItems, candidates)` → `wg.setVisibility(..., {source:"informed"})` | **Visibility 表**（他盲修复，P0-3 修复，需 LLM 映射 + confidence≥0.5） |
| 5 | commit.ts:322-355 | `extractRelations(outputs)` → `wg.addRelation(source, target, label, storyTime)` | **Relation 表**（失败记入 failedRelations） |
| 6 | commit.ts:357-360 | `toRoleOutputs(outputs)` 去掉 state_changes/characterId | — |
| 7 | commit.ts:362-387 | 按 `event.intent` 分支渲染 | **章节文件**（add=append / modify=modifyChapterSection / insert=insertChapterSection） |
| 8 | commit.ts:389-392 | `deletePlan(planId)`（部分成功也清理） | — |

**关键设计**（commit.ts:42-48 注释）：
- modify/insert **不撤销原事件的状态声明**（Git revert 思路）
- 章节文件层面才做替换/插入
- 保留 Fact 时序索引完整性

---

## 3. 数据库 Schema 与写入路径

### 3.1 节点表结构（4 张表）

源码：[packages/world-graph/src/world-graph.ts:30-93](file:///d:/claude/pi-ex/narrative-engine/packages/world-graph/src/world-graph.ts#L30-L93)

#### Entity 表（world-graph.ts:30-39）

| 字段 | 类型 | 可空 | 默认 | 索引 |
|---|---|---|---|---|
| `entityId` | string | 否 | — | ❌ 无 |
| `type` | `character\|location\|item\|concept` | 否 | — | ❌ 无 |
| `summary` | string | 否 | `""` | ❌ 无（但参与 vector 检索） |
| `validFrom` | string | 否 | — | ❌ 无 |
| `validTo` | string | 否 | — | ❌ 无（`"Infinity"` = 未闭合） |
| `embedding` | embedding(512) | 是 | undefined | ✅ sqlite-vec |

#### Fact 表（world-graph.ts:41-53）

| 字段 | 类型 | 可空 | 默认 | 索引 |
|---|---|---|---|---|
| `declarationId` | string | 否 | — | ❌ 无 |
| `entityId` | string | 否 | — | ❌ 无 |
| `property` | searchable({language:"zh"}) | 否 | — | ✅ FTS 全文 |
| `value` | unknown | 否 | — | ❌ 无 |
| `valueText` | searchable({language:"zh"}) | 是 | undefined | ✅ FTS 全文 |
| `embedding` | embedding(512) | 是 | undefined | ✅ sqlite-vec |
| `modality` | `fact\|belief\|hypothesis` | 否 | — | ❌ 无 |
| `validFrom` | string | 否 | — | ❌ 无 |
| `validTo` | string | 否 | — | ❌ 无 |

#### Relation 表（world-graph.ts:55-64）

| 字段 | 类型 | 可空 | 索引 |
|---|---|---|---|
| `relationId` | string | 否 | ❌ 无 |
| `sourceId` | string | 否 | ❌ 无 |
| `targetId` | string | 否 | ❌ 无 |
| `label` | string | 否 | ❌ 无 |
| `validFrom` | string | 否 | ❌ 无 |
| `validTo` | string | 否 | ❌ 无 |

#### Visibility 表（world-graph.ts:66-78）

| 字段 | 类型 | 可空 | 索引 | 说明 |
|---|---|---|---|---|
| `visibilityId` | string | 否 | ❌ 无 | — |
| `characterId` | string | 否 | ❌ 无 | 持有可见性的角色 |
| `declarationId` | string | 否 | ❌ 无 | 外键 → Fact |
| `state` | `z.enum(["known"])` | 否 | ❌ 无 | **schema 只允许 "known"** |
| `confidence` | number | 否 | ❌ 无 | 0-1 |
| `source` | string | 否 | ❌ 无 | **自由字符串，非枚举** |
| `validFrom` | string | 否 | ❌ 无 | — |
| `validTo` | string | 否 | ❌ 无 | — |
| `isExplicit` | boolean | 否 | ❌ 无 | — |

**`source` 字段实际取值**（代码中出现的）：
- `"experienced"` — commit.ts:225（自产自知 state_change）
- `"informed"` — commit.ts:308（knowledge_gained 通过 LLM mapper 学到）
- `"witnessed"` — character-view.ts:64（inferVisibility 自动为 located_in 推导）
- 测试中还出现 `"self" / "rumor" / "told" / "explicit"`

### 3.2 边

仅一条边类型 `declares`，从 `EntityNode` → `FactNode`（world-graph.ts:80, 91）。

### 3.3 EventLog（JSONL 文件，非数据库表）

源码：[packages/world-graph/src/event-log.ts:13-17](file:///d:/claude/pi-ex/narrative-engine/packages/world-graph/src/event-log.ts#L13-L17) / [packages/world-graph/src/types.ts:58-90](file:///d:/claude/pi-ex/narrative-engine/packages/world-graph/src/types.ts#L58-L90)

事件以 JSONL append-only 文件存储（`<cwd>/.pi/world-graph-v3/events.jsonl`），不入数据库。`EventRecord` 字段：

```ts
{
  eventId: string;
  type: "birth" | "death" | "change";
  storyTime: string;
  entityId: string;
  source?: "engine" | "user";           // 缺省 "engine"
  entityType?: "character"|"location"|"item"|"concept";
  summary?: string;
  newFacts?: Array<{entityId, property, value, modality}>;
  invalidated?: Array<{declarationId, property}>;
  causedBy?: string;
  userInput?: string;
  recordedAt?: string;                  // ISO 8601 墙钟，缺省 new Date().toISOString()
}
```

### 3.4 写入路径速查表

| 写入方法 | 落库表 | 字段 | 触发点 |
|---|---|---|---|
| `birthEntity` | Entity + Fact | entityId/type/summary/validFrom/validTo + declarationId/property/value/valueText/modality | processEvent(type=birth) / 导入器 |
| `processEvent(change)` | EventLog + Fact | 旧 Fact validTo=storyTime + 新 Fact 全字段（**不写 embedding/visibility**） | commit 4.2 / world_event_apply / 导入器 |
| `processEvent(death)` | Entity + Fact | Entity.validTo + 级联 Fact.validTo | world_entity_kill / 导入器 |
| `addRelation` | Relation | 全字段 | commit 5 / world_relation_add / 导入器 |
| `setVisibility` | Visibility | 全字段（source 由调用方传入） | commit 4.3/4.4 / world_visibility_set / 导入器 / import-card |
| `updateFactEmbedding` | Fact.embedding | embedding 字段 | commit 4.2.5 / reembedAll |
| `updateEntitySummary` | Entity.summary | summary 字段（**不更新 embedding**） | world_entity_update_summary |
| `closeRelation` | Relation.validTo | — | world_relation_close / 导入器 |
| `closeVisibility` | Visibility.validTo | — | world_visibility_close |

### 3.5 索引现状

**有索引**：
- FTS 全文：`Fact.property` / `Fact.valueText`
- 向量：`Entity.embedding` / `Fact.embedding`（sqlite-vec）

**无索引**（全表扫描后内存过滤）：
- 所有业务字段：`entityId / declarationId / characterId / sourceId / targetId / label`
- 时态字段：`validFrom / validTo`

**影响**：`getEntityAt` / `getVisibilityForCharacter` / `getAllDeclarations` 等查询都是全表扫描后内存过滤（[world-graph.ts:243-247/340-345/489-494](file:///d:/claude/pi-ex/narrative-engine/packages/world-graph/src/world-graph.ts#L243-L247)）。数据量大时性能瓶颈（P3 优化项，[world-graph.ts:757-760 TODO](file:///d:/claude/pi-ex/narrative-engine/packages/world-graph/src/world-graph.ts#L757-L760)）。

---

## 4. 工具返回值速查表

### 4.1 触发 LLM 的工具（7 个）

| 工具 | LLM 调用 | 返回关键字段 |
|---|---|---|
| `scheduler_dispatch` | plannerLlm × 1 + roleLlm × N +（yolo 时 renderLlm × 1 + knowledgeMapper × N） | `planId/eventId/outputs[]/errors[]/cast[]/retrievalPlan`（plan 模式）或 `+ commitResult`（yolo 模式） |
| `scheduler_commit` | renderLlm × 1 + knowledgeMapper × N | `CommitResult{ok/appliedEventIds/writtenText/failedEntityIds?/failedRelations?}` |
| `role_interact` | roleLlm × N | `InteractResult{outputs: RoleAgentOutput[], errors: []}` |
| `render_append` / `render_modify` | renderLlm × 1 | `RenderResult{ok/chapterPath/mode/eventId/writtenText/error?}` |
| `render_preview` | renderLlm × 1 | `content[0].text` = 渲染文本 + `{ok, eventId, preview:true}` |
| `render_check` | renderLlm × 1 | `violations` 清单 + `error` |
| `import_novel` | 内部多 LLM 子代理并行 | `{entityCount, eventCount, relationCount, visibilityCount, worldGraphDir, dumpPath}` |

### 4.2 纯数据库/文件操作的工具（24 个）

| 工具 | 返回关键字段 |
|---|---|
| `world_status` | `{currentStoryTime, entityCount, eventCount, recordedNow}` |
| `world_entity_get` | `{entityId, storyTime, snapshot: EntitySnapshot|null, error}` |
| `world_query` | `{results: EntitySearchResult[], count}` |
| `world_relations` | `{relations: Array<...>}` |
| `world_character_view` | `{view: StateDeclaration[], count}` |
| `world_event_chain` | `{events: EventRecord[], count}` |
| `world_story_times` | `{storyTimes: string[], count}` |
| `world_entity_history` | `{entities: [...], facts: [...]}`（含 createdAt/updatedAt） |
| `world_event_apply` | `{ok, eventId}` + 触发 updateMemory |
| `world_entity_create/kill/update_summary` | `{ok, ...入参字段}` |
| `world_relation_add/close` | `{ok, ...入参字段}` |
| `world_visibility_set/close/infer` | `{ok, ...入参字段}` |
| `import_character_card` | `{entityId, name, factCount, eventId}` |
| `open_visualizer` | `{ok, url?, port?, alreadyRunning?, error?}` |
| `scheduler_discard` | `{ok, planId}` |
| `render_rule_set` / `role_rule_set` | `{ok, length, exists}` |

### 4.3 关键返回结构

#### `EntitySnapshot`（world-graph.ts:100-107）
```ts
{
  entityId: string;
  type: "character"|"location"|"item"|"concept";
  summary: string;
  validFrom: string;
  validTo: string;                  // "Infinity" = 未闭合
  properties: StateDeclaration[];
}
```

#### `StateDeclaration`（types.ts:36-46）
```ts
{
  declarationId: string;
  entityId: string;
  property: string;
  value: unknown;
  valueText?: string;
  modality: "fact"|"belief"|"hypothesis";
  validFrom: string;
  validTo: string;
}
```

#### `EntitySearchResult`（src/search.ts:10-16）
```ts
{
  entityId: string;
  type: EntityType;
  score: number;                    // 0-1
  matchType: "fulltext"|"vector"|"hybrid";
  snapshot: EntitySnapshot;
}
```

#### `world_status` 返回的 `recordedNow`
- 格式：`"r1:0000000000000007:2026-07-25T16:02:32.048Z"`（SDK RecordedInstant）
- 字典序可比较，递增
- 可作为 `world_entity_get / world_character_view` 的 `recordedAsOf` 实现双时态检索

---

## 5. memory.md 机制

源码：[src/memory.ts:34-152](file:///d:/claude/pi-ex/narrative-engine/src/memory.ts#L34-L152)

### 5.1 路径与格式

- 路径：`<cwd>/.pi/world-graph-v3/memory.md`
- 写入方式：**全量覆盖**（fs.writeFile，非追加）
- 内容结构（5 段）：
  1. 标题行：`# 项目记忆（narrative-engine 自动维护，请勿手改）`
  2. STORY_TIME_CONVENTION 引用块（全项目唯一权威定义）
  3. 当前 storyTime + 最近更新时间
  4. `## 在场角色（最近事件涉及）`
  5. `## 最近事件（新→旧）`：最多 10 组，每条含 `storyTime | actors | 口述原文`

### 5.2 触发点（4 处）

| 触发点 | 源码位置 | 条件 |
|---|---|---|
| session_start 自愈 | [src/index.ts:200-204](file:///d:/claude/pi-ex/narrative-engine/src/index.ts#L200-L204) | 事件存在但 memory.md 缺失时重建 |
| world_event_apply 后 | [src/index.ts:540-544](file:///d:/claude/pi-ex/narrative-engine/src/index.ts#L540-L544) | 无条件触发，失败仅 warn |
| scheduler_dispatch yolo | [src/index.ts:1275-1281](file:///d:/claude/pi-ex/narrative-engine/src/index.ts#L1275-L1281) | 仅 yolo 模式 |
| scheduler_commit 后 | [src/index.ts:1311-1317](file:///d:/claude/pi-ex/narrative-engine/src/index.ts#L1311-L1317) | ⚠️ **仅 `result.ok === true` 时触发**（见优化点 #2） |

### 5.3 注入方式

`before_agent_start` 事件把 memory.md 内容追加到 systemPrompt 末尾（[src/index.ts:244-249](file:///d:/claude/pi-ex/narrative-engine/src/index.ts#L244-L249)）。每轮重读，不缓存。

---

## 6. 双时态检索机制

### 6.1 两个时间轴

| 时间轴 | 字段 | 格式 | 用途 |
|---|---|---|---|
| 故事时间 | `storyTime` / `validFrom` / `validTo` | `ch009.ev006` / `"Infinity"` | 故事内时序，字典序可比较 |
| 事务时间 | `recordedAsOf` / `recordedNow` | `r1:0000000000000007:2026-07-25T...` | SDK 内部墙钟坐标，`asOfRecorded` 重建该时点节点视图 |

### 6.2 支持 recordedAsOf 的查询

| API | 支持 | 说明 |
|---|---|---|
| `getEntityAt` / `getRelations` / `getVisibilityForCharacter` / `getAllDeclarationsAt` / `getCharacterView` | ✅ | 走 SDK `asOfRecorded` 视图 |
| `wg.search.fulltext/vector/hybrid` | ❌ | SDK 透传，不感知时态 |

retrieve.ts 对 `search_*` 类型的 `recordedAsOf` 仅 `console.warn` 降级为不过滤（[retrieve.ts:155-160/175-180/207-212](file:///d:/claude/pi-ex/narrative-engine/packages/scheduler/src/retrieve.ts#L155-L160)）。

### 6.3 改写历史剧情的隔离机制

1. planner LLM 调 `wg.recordedNow()` 取事务时间坐标
2. 填入 `RetrievalItem.params.recordedAsOf`
3. retrieve.ts 透传给 wg 查询 API
4. wg.findNodes 走 SDK `asOfRecorded` 视图重建该时点节点状态
5. character-view.ts 同时传给声明与可见性查询

**限制**：search_* 路径不支持 recordedAsOf，planner LLM 应优先用 character_view/entity_snapshot/relations 检索历史状态。

---

## 7. 发现的优化点（按优先级）

### 🔴 P1：影响功能正确性

#### #1 `StructuredEvent.locationId` 未消费
- **位置**：[types.ts:111](file:///d:/claude/pi-ex/narrative-engine/packages/scheduler/src/types.ts#L111) 声明"用于可见性推断"，但 [plan.ts](file:///d:/claude/pi-ex/narrative-engine/packages/scheduler/src/plan.ts) 与 [commit.ts](file:///d:/claude/pi-ex/narrative-engine/packages/scheduler/src/commit.ts) 全文未读取
- **影响**：主会话传入的地点信息丢失，`inferVisibility` 无法利用
- **建议**：要么在 plan 阶段调 `wg.inferVisibility(locationId, storyTime)`，要么从 schema 删除该字段

#### #2 `scheduler_commit` 部分成功时 memory.md 不更新
- **位置**：[src/index.ts:1311](file:///d:/claude/pi-ex/narrative-engine/src/index.ts#L1311) `if (result.ok)` 条件
- **影响**：`ok=false` 但 `appliedEventIds` 非空时（部分 entityId 写入成功），memory.md 不更新，下轮检索的"最近事件"展示滞后
- **建议**：改为 `if (result.appliedEventIds.length > 0)`（fix-plan.md 第九节决策点 3 已指出但未改）

### 🟡 P2：影响性能或数据一致性

#### #3 retrieve.ts 无 dedup
- **位置**：[plan.ts:154 注释](file:///d:/claude/pi-ex/narrative-engine/packages/scheduler/src/plan.ts#L154) "当前不去重（Pending Gap #11）"
- **影响**：同一 declarationId 可能跨多条 RetrievalItem 被命中并多次注入角色提示词，浪费 token
- **建议**：在 `dynamicFactsByCharacter` 累加时按 declarationId 去重

#### #4 `updateEntitySummary` 不更新 embedding
- **位置**：[world-graph.ts:325-332](file:///d:/claude/pi-ex/narrative-engine/packages/world-graph/src/world-graph.ts#L325-L332)
- **影响**：Entity.summary 变更后，`Entity.embedding` 仍是旧值，`search_vector` 检索结果不准
- **建议**：`updateEntitySummary` 内联调 `embedder.embedEntity` + `updateEntityEmbedding`，或要求调用方显式调 `reembedAll`

#### #5 `processEvent` 直接调用路径不写 embedding
- **位置**：[world-graph.ts:413-425](file:///d:/claude/pi-ex/narrative-engine/packages/world-graph/src/world-graph.ts#L413-L425) `Fact.create` 未传 embedding
- **影响**：`world_event_apply` / visualizer POST /api/events / 导入器等直接调 processEvent 的路径，新 Fact 无 embedding，`search_vector` 不命中
- **现状**：commit 路径由 4.2.5 步增量补写；导入器由阶段 8 `reembedAll` 全量补齐；`world_event_apply` 无补偿机制
- **建议**：`world_event_apply` 工具 wrapper 内调 `reembedAll`，或 processEvent 内联 embed（性能差，需评估）

#### #6 业务字段无索引
- **位置**：[world-graph.ts:757-760 TODO](file:///d:/claude/pi-ex/narrative-engine/packages/world-graph/src/world-graph.ts#L757-L760)
- **影响**：`getEntityAt` / `getVisibilityForCharacter` / `getAllDeclarations` 等全表扫描后内存过滤，数据量大时性能瓶颈
- **建议**：P3 性能优化项，可考虑在 SDK 层支持 `index()` 声明或手动建索引

### 🟢 P3：代码质量与可维护性

#### #7 `Visibility.source` 非枚举
- **位置**：[world-graph.ts:73](file:///d:/claude/pi-ex/narrative-engine/packages/world-graph/src/world-graph.ts#L73) `z.string()`
- **影响**：代码中实际只出现 `experienced/informed/witnessed` 三种，但 schema 允许任意字符串，测试中还出现 `self/rumor/told/explicit` 等历史遗留值
- **建议**：改为 `z.enum(["experienced","informed","witnessed"])`，清理测试中的历史值

#### #8 `CloseFact` 方法不存在
- **位置**：Fact 闭合只能通过 `killEntity` 级联或 `processEvent(change)` 间接闭合
- **影响**：无法单独闭合某条 Fact 而不闭合整个 Entity
- **建议**：如需细粒度闭合，可新增 `closeFact(declarationId, storyTime)` 方法

#### #9 project_memory.md 状态滞后
- **位置**：`c:\Users\Mirror\.trae-cn\memory\projects\-d-claude-pi-ex\project_memory.md`
- **影响**：#3（knowledge_gained 他盲）与 #15（commit 不写 embedding）仍标为 🔴 严重，但源码查证显示 P0-3+5+6 修复已落地（commit.ts 4.2.5 / 4.4 步已实现）
- **建议**：刷新 project_memory.md，把这两项移入"已闭环"

#### #10 `StructuredEvent.executionHints` 注入位置分散
- **位置**：planner prompt（[prompts.ts:115-116](file:///d:/claude/pi-ex/narrative-engine/packages/scheduler/src/prompts.ts#L115-L116)）+ role-pool prompt（[role-pool/src/prompts.ts:55-59](file:///d:/claude/pi-ex/narrative-engine/packages/role-pool/src/prompts.ts#L55-L59)）
- **影响**：同一字段在两个 LLM prompt 中都注入，但格式不同（planner 是 "执行建议: ..."，role-pool 是独立段落），可能不一致
- **建议**：评估是否只需在 role-pool 注入（planner 不需要执行建议）

---

## 8. 查证文件清单

| 模块 | 文件 |
|---|---|
| 工具注册 | `src/index.ts` |
| SchedulerCtx 工厂 | `src/scheduler-llm.ts` |
| planner LLM | `src/planner-llm.ts` |
| role-pool LLM | `src/role-pool-llm.ts` |
| renderer LLM | `src/renderer-llm.ts` |
| knowledge-mapper LLM | `src/knowledge-mapper-llm.ts` |
| LLM 配置 | `src/llm-config.ts` |
| 项目记忆 | `src/memory.ts` |
| 检索包装 | `src/search.ts` |
| 卡片导入 | `src/tools/import-card.ts` |
| 调度器流水线 | `packages/scheduler/src/plan.ts` |
| 调度器写扩散 | `packages/scheduler/src/commit.ts` |
| 检索执行 | `packages/scheduler/src/retrieve.ts` |
| Plan 缓存 | `packages/scheduler/src/cache.ts` |
| Scheduler 类型 | `packages/scheduler/src/types.ts` |
| Scheduler prompts | `packages/scheduler/src/prompts.ts` |
| 章节路径解析 | `packages/scheduler/src/chapter-resolver.ts` |
| 章节插入 | `packages/scheduler/src/chapter-edit.ts` |
| WorldGraph 主类 | `packages/world-graph/src/world-graph.ts` |
| WorldGraph 类型 | `packages/world-graph/src/types.ts` |
| 五步过滤 | `packages/world-graph/src/character-view.ts` |
| EventLog | `packages/world-graph/src/event-log.ts` |
| 角色池编排 | `packages/role-pool/src/role-pool.ts` |
| 角色池类型 | `packages/role-pool/src/types.ts` |
| 角色池 prompts | `packages/role-pool/src/prompts.ts` |
| 角色池转换 | `packages/role-pool/src/transforms.ts` |
| 渲染器核心 | `packages/renderer/src/renderer.ts` |
| 渲染器类型 | `packages/renderer/src/types.ts` |
| 渲染器 prompts | `packages/renderer/src/prompts.ts` |
| 章节文件 IO | `packages/renderer/src/chapter-io.ts` |

---

## 9. 下一步建议

按优先级处理优化点：

1. **P1 #1 #2**：影响功能正确性，建议立即修复
   - #1 locationId 接线或删除（需决策：是否启用 inferVisibility）
   - #2 memory.md 更新条件改为 `appliedEventIds.length > 0`
2. **P2 #3 #4 #5**：影响性能与数据一致性
   - #3 retrieve dedup（简单，可立即做）
   - #4 updateEntitySummary 联动 embedding（需评估 embedder 调用开销）
   - #5 world_event_apply 补 embedding（需评估是 wrapper 调 reembedAll 还是 processEvent 内联）
3. **P3 #7 #9**：代码质量
   - #7 Visibility.source 改枚举（需清理历史值）
   - #9 project_memory.md 刷新（可立即做）
4. **P2 #6**：业务字段索引（P3 性能优化，数据量大时再做）

请用户确认要优先处理哪些优化点。
