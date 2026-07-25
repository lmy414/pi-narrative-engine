# Narrative Engine API 文档

> **版本**: V2（tool-adaptation 重写后 + V3 导入器 + 调度器/角色池/主会话 prompt + 酒馆卡导入）
> **适用分支**: `master`（feat/role-pool 已 FF merge）
> **最后更新**: 2026-07-25（31 工具时代，与需求审计 docs/audits/2026-07-25-requirements-audit.md 对齐）

## 目录

- [1. 架构概览](#1-架构概览)
- [2. 存储路径](#2-存储路径)
- [3. storyTime 管理约定](#3-storytime-管理约定)
- [4. PI 扩展工具 API（31 个）](#4-pi-扩展工具-api31-个)
  - [4.1 状态查询](#41-状态查询)
  - [4.2 实体工具](#42-实体工具)
  - [4.3 关系工具](#43-关系工具)
  - [4.4 事件工具](#44-事件工具)
  - [4.5 可见性工具](#45-可见性工具)
  - [4.6 检索工具](#46-检索工具)
  - [4.7 历史与元信息工具](#47-历史与元信息工具)
  - [4.8 可视化工具](#48-可视化工具)
  - [4.9 导入工具](#49-导入工具)
  - [4.10 渲染工具](#410-渲染工具)
- [5. `@pi/world-graph` 包 API](#5-piworld-graph-包-api)
- [6. `@pi/novel-importer` 包 API](#6-pinovel-importer-包-api)
- [6.5 `@pi/renderer` 包 API](#65-pirenderer-包-api)
- [6.6 `@pi/role-pool` 包 API](#66-pirole-pool-包-api)
- [6.7 `@pi/scheduler` 包 API](#67-pischeduler-包-api)
- [7. `Search` 类 API](#7-search-类-api)
- [8. `Embedder` 类 API](#8-embedder-类-api)
- [9. 类型定义](#9-类型定义)
- [10. SDK 检索能力](#10-sdk-检索能力)
- [11. 可视化服务（Visualizer）](#11-可视化服务visualizer)

---

## 1. 架构概览

```
┌──────────────────────────────────────────────────────────┐
│  PI 主会话 / Scheduler / 前端                             │
│  （通过 pi.registerTool 注册的 31 个工具调用）             │
└──────────────────┬───────────────────────────────────────┘
                   │
┌──────────────────▼───────────────────────────────────────┐
│  narrative-engine/src/index.ts                            │
│  - session_start: 初始化 WorldGraph/Embedder/Search      │
│    + 恢复 scheduler plan 缓存 + 加载 main-session.md      │
│  - before_agent_start: 主会话 prompt 注入 systemPrompt    │
│  - 注册 18 个 world_* + open_visualizer                  │
│  - 注册 import_novel + import_character_card（导入）      │
│  - 注册 5 个 render_*（append/modify/preview/check/rule_set）│
│  - 注册 2 个 role_* + 3 个 scheduler_*（编排）            │
│  - 管理 session 级 currentStoryTime                      │
└────┬────────────┬──────────────┬─────────────────────────┘
     │            │              │
     ▼            ▼              ▼
┌─────────┐ ┌──────────┐ ┌──────────────────────────┐
│ Embedder│ │  Search  │ │  @pi/world-graph         │
│ (Xenova)│ │ (SDK 薄) │ │  - WorldGraph 类         │
│ 512 维  │ │  包装)   │ │  - EntitySnapshot        │
│ bge-zh  │ │          │ │  - StateDeclaration      │
└────┬────┘ └────┬─────┘ │  - EventLog              │
     │           │       └──────────┬───────────────┘
     │           │                  │
     ├───────────┴──────────────────┘
     │
     ▼
┌──────────────────────────────┐    ┌──────────────────────────────┐
│ @nicia-ai/typegraph@0.40.0   │    │ @pi/novel-importer           │
│ - StoreSearch (fulltext/vec) │    │ - runImportPipeline (8 阶段) │
│ - QueryBuilder               │    │ - resolveEntities (消解)     │
│ - searchable()/embedding()   │    │ - writeToGraph (写入)        │
│ - sqliteVecStrategy          │    │ - validateGraph (校验)       │
└──────────────────────────────┘    └──────────────────────────────┘
```

**核心依赖**：
- `@nicia-ai/typegraph@0.40.0` — TypeGraph SDK（StoreSearch + QueryBuilder + searchable/embedding 字段装饰器）
- `@xenova/transformers` — Xenova/bge-small-zh-v1.5 本地嵌入模型（512 维）
- `better-sqlite3` + `drizzle-orm` — SQLite 后端（WAL 模式）
- `sqlite-vec` — SQLite 向量扩展（cosine 相似度）
- `zod@^4.0.0` — Schema 校验
- `typebox` — PI 工具参数 schema

---

## 2. 存储路径

### 2.1 运行时目录（world_* / scheduler_* 工具）

默认路径：`<cwd>/.pi/world-graph-v3/`（2026-07-25 起与导入目录统一，原为 v2）

| 文件 | 用途 |
|------|------|
| `world.db` | SQLite 数据库（Entity/Fact/Relation/Visibility 节点 + fulltext/vector 索引） |
| `events.jsonl` | 事件日志（JSONL 格式，每行一条 EventRecord） |

### 2.2 导入目录（import_novel 工具）

默认路径：`<cwd>/.pi/world-graph-v3/`

| 文件 | 用途 |
|------|------|
| `world.db` | SQLite 数据库（同上，但由导入管道写入） |
| `events.jsonl` | 事件日志（由导入管道从章节事件流生成） |
| `chapter-index.json` | 章节元数据索引（章节 ID → 标题/事件数等） |
| `alias-index.json` | 别名索引（实体别名 → canonical entityId） |
| `_v3_dump.json` | 阶段 1-6 中间产物（含 narrative_summary/evidence 调试字段） |

### 2.3 目录关系

- ~~`world-graph-v2/` 与 `world-graph-v3/` 是两个独立的世界图实例~~（2026-07-25 前）
- **2026-07-25 起**：运行时与导入统一使用 `world-graph-v3/`（审计修复：此前运行时读 v2 空壳，导入数据运行时不可见）
- `world-graph-v2/` 与 `world-graph/`（V1）均为历史遗留，不再使用，数据不迁移
- 项目结构定义详见 `docs/novel-project-structure.md`

---

## 3. storyTime 管理约定

所有写入/查询操作都需要 `storyTime`（故事时间，字符串标识）。PI 工具层提供两种传参方式：

1. **显式传递**：调用工具时传 `storyTime` 参数
2. **隐式复用**：不传时使用 `currentStoryTime`（session 级状态）

`currentStoryTime` 更新规则：
- `session_start` 时初始化为 `null`
- `world_event_apply` / `world_entity_create` / `world_entity_kill` 时更新为事件/操作的 `storyTime`
- 其他工具（如 `world_entity_get`、`world_query`）不更新

**storyTime 格式**（2026-07-25 统一，双格式兼容）：
- 口述/运行时格式：`ch-<N>`（如 `ch-2`）
- 导入器事件格式：`ch<NNN>.ev<MMM>`（如 `ch009.ev003`）
- 章节路径解析（`resolveChapterPath`）对两种格式均取章节号定位 `正文/第<N>章-*.md`

如果 `currentStoryTime` 为 `null` 且工具需要 storyTime，会抛错：
```
Error: storyTime required (call world_event_apply first or pass storyTime explicitly)
```

---

## 4. PI 扩展工具 API（31 个）

所有工具通过 `pi.registerTool` 注册，遵循 PI ExtensionAPI 约定：
- `name` — 工具唯一标识（`world_*` 前缀 / `open_visualizer` / `import_novel`）
- `label` — 显示标签
- `description` — LLM 可见的工具描述
- `parameters` — TypeBox schema 定义参数
- `async execute(_id, params)` — 执行体，返回 `{ content: [{type, text}], details }`

**工具分类**（31 个）：
- **状态查询**（1 个）：`world_status`
- **实体工具**（3 个）：`world_entity_create` / `world_entity_kill` / `world_entity_get`
- **关系工具**（3 个）：`world_relation_add` / `world_relation_close` / `world_relations`
- **事件工具**（2 个）：`world_event_apply` / `world_event_chain`
- **可见性工具**（4 个）：`world_character_view` / `world_visibility_set` / `world_visibility_infer` / `world_visibility_close`
- **检索工具**（1 个）：`world_query`
- **历史与元信息**（4 个）：`world_entity_update_summary` / `world_entity_history` / `world_relation_history` / `world_story_times`
- **可视化**（1 个）：`open_visualizer`
- **导入**（2 个）：`import_novel` / `import_character_card`
- **渲染**（5 个）：`render_append` / `render_modify` / `render_preview` / `render_check` / `render_rule_set`
- **角色池**（2 个）：`role_interact` / `role_rule_set`（详见 `docs/plans/2026-07-24-role-pool-design.md`）
- **调度器**（3 个）：`scheduler_dispatch` / `scheduler_commit` / `scheduler_discard`（详见 `docs/plans/2026-07-25-scheduler-design.md`）

> **主会话 prompt**：`src/prompts/main-session.md` 在 `session_start` 加载、`before_agent_start`
> 追加到 systemPrompt 末尾，定义意图分类 / mode 判断 / 五要素补全规则（不参与叙事，只做任务外包）。
> 运行时数据详见 `docs/novel-project-structure.md`。

### 4.1 状态查询

#### `world_status`

获取世界图状态摘要。

**参数**：无

**返回**：
```json
{
  "content": [{ "type": "text", "text": "currentStoryTime: act2-scene1\n统计时刻: act2-scene1\n实体数: 5\n事件数: 3" }],
  "details": {
    "status": {
      "currentStoryTime": "act2-scene1",
      "entityCount": 5,
      "eventCount": 3
    }
  }
}
```

> 注（2026-07-25 修复）：`currentStoryTime` 未设置时，统计时刻回退为最新 storyTime
> （此前用 `"Infinity"`，字符串比较 `'I' < 'c'` 会导致全部实体被排除，显示 0）。

---

### 4.2 实体工具

#### `world_entity_create`

创建实体（诞生）。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `entityId` | string | 是 | 实体唯一标识（如 `"macbeth"`） |
| `type` | `"character"` \| `"location"` \| `"item"` \| `"concept"` | 是 | 实体类型 |
| `initialProps` | `Record<string, unknown>` | 否 | 初始属性（每个键值对成为一个 Fact） |
| `storyTime` | string | 是 | 诞生时刻 |

> **注**：本工具不支持设置 `summary`。如需设置实体描述，使用 `world_entity_update_summary`。birth 事件（`world_event_apply` 带 `type: "birth"`）才支持 `summary` 参数。

> **summary 字段语义**：实体的**无状态客观事实描述**（独立数据字段，不进 Fact/属性）。与 Fact 节点的区别——summary 存不变的客观事实（如"林冲，八十万禁军教头，豹头环眼"），Fact 存随事件变化的状态（如 mood/location/health）。参与向量检索（限导入管道的 embedder；运行时 `Embedder.embedEntity` 不拼接 summary）。下游消费约定：角色池注入时建议 summary + 当前 properties 拼接为完整角色描述（角色池本身尚未在本仓库实现）。

**示例**：
```json
{
  "entityId": "macbeth",
  "type": "character",
  "initialProps": { "name": "Macbeth", "title": "Thane of Cawdor" },
  "storyTime": "act1-scene1"
}
```

**返回**：
```json
{
  "content": [{ "type": "text", "text": "实体 macbeth 已创建（character）@ act1-scene1" }],
  "details": { "ok": true, "entityId": "macbeth" }
}
```

**副作用**：更新 `currentStoryTime = storyTime`

---

#### `world_entity_kill`

消亡实体（非"删除"，bi-temporal 模型下只闭合 validTo）。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `entityId` | string | 是 | 实体 ID |
| `storyTime` | string | 是 | 消亡时刻 |

**副作用**：
- 闭合 Entity 节点的 `validTo`
- 级联闭合该实体所有未闭合 Fact 的 `validTo`
- 更新 `currentStoryTime = storyTime`

---

#### `world_entity_get`

获取实体快照（bi-temporal 查询）。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `entityId` | string | 是 | 实体 ID |
| `storyTime` | string | 否 | 故事时间（不传用 `currentStoryTime`） |

**返回** `EntitySnapshot`：
```json
{
  "entityId": "macbeth",
  "type": "character",
  "summary": "苏格兰贵族，主角",
  "validFrom": "act1-scene1",
  "validTo": "Infinity",
  "properties": [
    {
      "declarationId": "decl-macbeth-name-act1-scene1",
      "entityId": "macbeth",
      "property": "name",
      "value": "Macbeth",
      "modality": "fact",
      "validFrom": "act1-scene1",
      "validTo": "Infinity"
    }
  ]
}
```

> 注：`properties[]` 不含 `valueText`——`valueText` 仅 `getEntityHistory` / `world_entity_history` 返回。

**bi-temporal 查询规则**：返回 `validFrom <= storyTime < validTo` 的 Entity 及其所有匹配的 Fact。`validTo = "Infinity"` 表示未闭合。

---

### 4.3 关系工具

#### `world_relation_add`

创建关系。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sourceId` | string | 是 | 源实体 ID |
| `targetId` | string | 是 | 目标实体 ID |
| `label` | string | 是 | 关系标签（如 `"located_in"`、`"friend_of"`） |
| `storyTime` | string | 否 | 不传用 `currentStoryTime` |

**关系 ID 生成规则**：`rel-{sourceId}-{label}-{targetId}-{storyTime}`

---

#### `world_relation_close`

闭合关系（非"删除"）。

**参数**：同 `world_relation_add`

**闭合规则**：找到匹配的未闭合关系（`sourceId` + `targetId` + `label` + `validTo = "Infinity"`），将其 `validTo` 设为 `storyTime`。

---

#### `world_relations`

列出实体在指定时刻的所有关系。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `entityId` | string | 是 | 实体 ID |
| `storyTime` | string | 否 | 不传用 `currentStoryTime` |

**返回**：关系对象数组，包含 `sourceId` 或 `targetId` 等于 `entityId` 的所有未闭合关系。

---

### 4.4 事件工具

#### `world_event_apply`

应用事件到世界图（核心写入入口）。

**参数**：
```typescript
{
  event: {
    eventId: string,                                    // 事件唯一 ID
    type: "birth" | "death" | "change",                // 事件类型
    storyTime: string,                                  // 故事时间
    entityId: string,                                   // 主角实体 ID
    source?: "engine" | "user",                         // 事件来源（默认 "engine"）
    entityType?: "character" | "location" | "item" | "concept",  // birth 事件用：实体类型（默认 "character"）
    summary?: string,                                   // birth 事件用：实体无状态客观事实描述（独立数据字段）
    newFacts?: Array<{                                  // type=birth/change 时的新增声明
      entityId: string,
      property: string,
      value: unknown,
      modality: "fact" | "belief" | "hypothesis",
    }>,
    invalidated?: Array<{                              // type=change 时的闭合声明
      declarationId: string,
      property: string,
    }>,
    causedBy?: string,                                  // 因果链前驱事件 ID
  }
}
```

**事件类型语义**：
- `birth`：实体诞生（调用 `birthEntity`，`entityType` 默认 `"character"`，`newFacts` 作为初始属性，`summary` 写入实体无状态描述字段）
- `death`：实体消亡（调用 `killEntity`）
- `change`：状态变更（先闭合 `invalidated` 中的声明，再写入 `newFacts`）

**事件来源**：
- `source: "engine"`（默认）— 引擎/scheduler/子代理扩散产生的事件
- `source: "user"` — 用户/前端编辑产生的事件（如可视化前端编辑实体属性后构造的 change 事件）

**副作用**：
- 写入 JSONL 事件日志（先写日志，确保因果链可回溯）
- 根据 `type` 执行对应操作
- 更新 `currentStoryTime = event.storyTime`

---

#### `world_event_chain`

获取事件链。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `eventId` | string | 否 | 起始事件 ID（不传返回全部） |

**行为**：
- 传 `eventId`：从该事件开始沿 `causedBy` 链式回溯，返回因果链
- 不传：返回所有事件，按 `storyTime` 升序排序

---

### 4.5 可见性工具

#### `world_character_view`

获取角色视角（五步过滤后的可见声明）。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `characterId` | string | 是 | 角色 ID |
| `storyTime` | string | 否 | 不传用 `currentStoryTime` |

**返回**：`StateDeclaration[]` — 该角色在 `storyTime` 时刻可见的所有声明。

**五步过滤**（由 `@pi/world-graph` 的 `character-view.ts` 实现，2026-07-22 语义修订：知识持续）：
1. 候选声明：全部 StateDeclaration（含已闭合——知识持续语义：知识不因声明闭合/实体死亡而消失）
2. 可见性记录：`setVisibility` 显式设置 + `inferVisibility` 从 `located_in` 推断写入的记录；需覆盖 storyTime（`validFrom <= storyTime < validTo`）且 `state === "known"`
3. 有效起点 = `max(visibility.validFrom, declaration.validFrom)`，需 `<= storyTime`（不能先于声明存在而知晓）
4. 有效终点只看可见性的 `validTo`（不再与 `declaration.validTo` 取交）——知识一旦获得就持续持有，直到可见性被显式撤销（`world_visibility_close`）
5. 模态过滤（可选，`modalityFilter`）：**仅包级 API `getCharacterView(characterId, storyTime, opts)` 支持，PI 工具 `world_character_view` 不暴露此参数**；代码无去重步骤

---

#### `world_visibility_set`

显式设置角色对某声明的可见性。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `characterId` | string | 是 | 角色 ID |
| `declarationId` | string | 是 | 声明 ID（StateDeclaration 的 `declarationId`） |
| `confidence` | number | 是 | 置信度 0-1 |
| `source` | string | 是 | 来源（如 `"witnessed"`、`"rumor"`） |
| `isExplicit` | boolean | 是 | 是否显式设置 |
| `storyTime` | string | 否 | 不传用 `currentStoryTime` |

**可见性 ID 生成规则**：`vis-{characterId}-{declarationId}-{validFrom}`

---

#### `world_visibility_infer`

从 `located_in` 关系推断所有角色的可见性。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `storyTime` | string | 否 | 不传用 `currentStoryTime` |

**推断规则**：遍历 storyTime 时刻所有 `located_in` 关系，对每条关系，把 target（location）实体在该时刻的所有有效声明标记为 source 角色可见（单向推断，非互相可见；`validFrom` 取角色进入时间与声明时间中较晚者）。

---

#### `world_visibility_close`

闭合可见性声明：撤销某角色对某声明的可见性。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `characterId` | string | 是 | 角色 ID |
| `declarationId` | string | 是 | 声明 ID |
| `storyTime` | string | 否 | 不传用 `currentStoryTime`（作为 `validTo` 闭合） |

**闭合规则**：找到匹配的未闭合 Visibility 记录（`characterId` + `declarationId` + `validTo = "Infinity"`），将其 `validTo` 设为 `storyTime`。找不到则抛错。

---

### 4.6 检索工具

#### `world_query`

检索实体（默认 hybrid 混合检索）。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `query` | string | 是 | 查询文本 |
| `topK` | number | 否 | 返回数量上限（默认 10） |
| `typeFilter` | `"character"` \| `"location"` \| `"item"` \| `"concept"` | 否 | 实体类型过滤 |
| `storyTime` | string | 否 | 不传用 `currentStoryTime` |
| `mode` | `"fulltext"` \| `"vector"` \| `"hybrid"` | 否 | 检索模式（默认 `hybrid`） |

**返回** `EntitySearchResult[]`：
```json
[
  {
    "entityId": "macbeth",
    "type": "character",
    "score": 0.85,
    "matchType": "hybrid",
    "snapshot": { /* EntitySnapshot */ }
  }
]
```

**检索模式**：
- `fulltext`：FTS5 全文检索（搜 Fact 节点的 `property` + `valueText` 字段）
- `vector`：向量检索（cosine 相似度，搜 Entity 节点的 `embedding` 字段）
- `hybrid`：混合检索（RRF 融合 fulltext + vector，默认）

**关联去重规则**：
- fulltext/hybrid 搜 Fact 节点，通过 `entityId` 关联到 Entity
- 同一 Entity 多个 Fact 命中时，合并取最高 score
- 结果按 score 降序

---

### 4.7 历史与元信息工具

#### `world_entity_update_summary`

更新实体的无状态客观事实描述（summary）。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `entityId` | string | 是 | 实体 ID |
| `summary` | string | 是 | 新无状态描述 |

**特性**：`summary` 为实体无状态客观事实描述（独立数据字段，不进 Fact）。不参与时态/可见性，直接覆盖，旧描述不保留历史。参与向量检索（限导入管道的 embedder；运行时 `Embedder.embedEntity` 不拼接 summary）。

---

#### `world_entity_history`

查询单个实体的全部版本（含已闭合记录），按 `validFrom` 升序。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `entityId` | string | 是 | 实体 ID |

**返回**：
```json
{
  "entities": [
    { "entityId": "macbeth", "type": "character", "summary": "...", "validFrom": "act1", "validTo": "Infinity" }
  ],
  "facts": [
    { "declarationId": "...", "property": "mood", "value": "开心", "validFrom": "ch-1", "validTo": "ch-2" },
    { "declarationId": "...", "property": "mood", "value": "不开心", "validFrom": "ch-2", "validTo": "ch-3" }
  ]
}
```

**用途**：详情抽屉"历史"页签、查看属性变化轨迹。

---

#### `world_relation_history`

查询关系历史（含已闭合）。不传 `entityId` 返回全部关系。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `entityId` | string | 否 | 过滤条件（作为 source 或 target），不传返回全部 |

**返回**：关系对象数组，含 `relationId`/`sourceId`/`targetId`/`label`/`validFrom`/`validTo`，按 `validFrom` 升序。

---

#### `world_story_times`

列出所有出现过的 storyTime（去重升序）。

**参数**：无

**返回**：字符串数组，如 `["ch-1", "ch-2", "ch-3"]`。

**聚合来源**：events.jsonl + Entity/Fact/Relation/Visibility 的 `validFrom`/`validTo`，排除 `"Infinity"`。

**用途**：前端顶部 storyTime 快照选择器的下拉数据源。

---

### 4.8 可视化工具

#### `open_visualizer`

启动 world-graph 可视化服务（幂等：已启动则直接返回现有 URL）。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `port` | number | 否 | 端口，默认 7421 |

**返回**：
```json
{
  "content": [{ "type": "text", "text": "可视化服务已启动: http://localhost:7421/" }],
  "details": {
    "ok": true,
    "url": "http://localhost:7421/",
    "port": 7421,
    "alreadyRunning": false
  }
}
```

**行为**：
- 注入 session 的 `WorldGraph` 与 `Search` 实例
- `session_shutdown` 时自动关闭
- 已启动时直接返回现有 URL（`alreadyRunning: true`）

**详见**：[第 11 节 可视化服务](#11-可视化服务visualizer)

---

### 4.9 导入工具

> [!WARNING]
> **测试实现声明**：`import_novel` 与 `import_character_card` 均为测试实现——
> 功能链路已验证可用，但**不保证数据质量**，后续将重写。导入数据建议仅用于试验。

#### `import_novel`

从 EPUB 文件导入小说到世界图（V3）。执行 8 阶段管道，内部并行 spawn 多个 LLM 子代理处理各章节。长时间运行任务（11 章约 10 分钟）。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `epubPath` | string | 是 | EPUB 文件绝对路径 |
| `worldGraphDir` | string | 否 | world-graph 存储目录（缺省 `<cwd>/.pi/world-graph-v3/`） |
| `chapters` | number[] | 否 | 限定导入章节（1-based），缺省全部 |
| `model` | string | 否 | LLM 模型名（缺省读 `PI_MODEL` 环境变量，否则 `deepseek-chat`） |
| `apiKey` | string | 否 | LLM API key（缺省读 `DEEPSEEK_API_KEY` 或 `PI_API_KEY`） |
| `concurrency` | number | 否 | 章节并行限流（缺省 3，范围 1-10） |
| `resumeFromStage` | number | 否 | 从指定阶段恢复（1-8，缺省从 1 开始） |

**8 阶段管道**：
1. EPUB 分章（`readChaptersFromEpub`）
2. 全书实体预扫描（`scanEntitiesGlobal`）
3. 章节事件流生成（`generateAllChapterEvents`，并行限流）
4. 实体消解编排（`resolveEntities` → canonicalMap + aliasIndex，三级策略：精确匹配 / 字符串相似度 / LLM 判断）
5. 关系抽取（`extractAllRelations`）
6. 可见性推断（`inferAllVisibilities`）
7. 写入 world-graph（`buildCausedByChain` + `writeToGraph`，eventId 生成 + causedBy 拓扑序 + 字段剥离 + state:"known"）
8. 向量补齐 + P0/P1 校验（`validateGraph`，P0 失败抛错退出，P1 警告继续）

**返回**：
```json
{
  "content": [{ "type": "text", "text": "导入完成：\n  实体数: 25\n  事件数: 47\n  关系数: 21\n  可见性数: 162\n  存储目录: /path/to/world-graph-v3\n  dump 文件: /path/to/world-graph-v3/_v3_dump.json" }],
  "details": {
    "entityCount": 25,
    "eventCount": 47,
    "relationCount": 21,
    "visibilityCount": 162,
    "worldGraphDir": "/path/to/world-graph-v3",
    "dumpPath": "/path/to/world-graph-v3/_v3_dump.json"
  }
}
```

**Resume 机制**：
- `resumeFromStage` 允许从指定阶段恢复，跳过已完成的阶段
- 阶段 7（写入）支持磁盘 resume：已写入的 `world.db` / `events.jsonl` 会被复用，不重复写入
- 阶段 1-6 的中间产物保存在 `_v3_dump.json`，resume 时从 dump 恢复

**Embedder 注入**：
- 复用 session 级 `Embedder` 实例（Xenova/bge-small-zh-v1.5, 512 维）
- 阶段 8 调用 `reembedAll` 为所有 Entity/Fact 补齐向量

**详见**：[第 6 节 `@pi/novel-importer` 包 API](#6-pinovel-importer-包-api)

**2026-07-25 行为修订**：
- 空章节（content 为空/全空白）跳过事件生成（不再产生"本章无内容"占位 Fact）
- change 事件写入时**自动闭合**同 property 未闭合声明（不再依赖 LLM 声明 invalidated）

#### `import_character_card`

导入酒馆角色卡（SillyTavern V1/V2，`.json` 或 `.png` 内嵌）到世界图（Pending Gap #5，2026-07-25 实现）。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cardPath` | string | 是 | 角色卡文件绝对路径（.json / .png） |
| `entityId` | string | 否 | 指定 entityId（缺省自动生成 `ent_char_xxxxxxxx`） |
| `storyTime` | string | 否 | 诞生时刻（不传用 `currentStoryTime`） |

**导入策略**：
- `card.description` → `Entity.summary`（birth 事件，重组静态卡时映射回 `card.description`）
- 其余 11 个卡字段 → 同名 Fact：`name / personality / scenario / first_mes / mes_example / creator_notes / tags / system_prompt / post_history_instructions / alternate_greetings`
- 自产自知：为角色自身写入全部卡字段 Fact 的 Visibility（`source: "self"`）
- **不支持**：`character_book`（lorebook）；**不抽取卡内角色关系**（需手动 `world_relation_add` 补录）

**支持格式**：
- `.json`：V1 平铺（`{ name, description, ... }`）/ V2（`{ spec: "chara_card_v2", data: {...} }`）
- `.png`：tEXt / 未压缩 iTXt chunk（keyword `chara` / `ccv3`，base64 JSON）

**返回**：
```json
{
  "content": [{ "type": "text", "text": "角色卡已导入：诺艾尔（ent_char_f8aba5a5），10 个字段 Facts @ ch009.ev005" }],
  "details": { "entityId": "ent_char_f8aba5a5", "name": "诺艾尔", "factCount": 10, "eventId": "evt_card_import_xxxx" }
}
```

**副作用**：更新 `currentStoryTime = storyTime`

---

### 4.10 渲染工具

渲染工具将叙事指令 + 角色池结构化数据（`RoleOutput[]`）渲染为符合规则集.md 约定的正文文本，并按锚点写入章节文件。底层由 `@pi/renderer` 子包提供能力，详见 [第 6.5 节](#65-pirenderer-包-api)。

#### `render_append`

渲染叙事事件并追加到章节文件（append 模式）。读取已有章节全文做上下文，LLM 生成正文后追加到文件末尾。

**参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `chapterPath` | string | 是 | 目标章节文件绝对路径 |
| `eventId` | string | 是 | 本次渲染对应的事件 ID |
| `storyTime` | string | 是 | 故事时间（如 `ch-2`） |
| `instruction` | string | 是 | 叙事指令（自然语言） |
| `payload` | `RoleOutput[]` | 是 | 角色池结构化输出 |

**返回**：
```json
{
  "content": [{ "type": "text", "text": "已渲染事件 evt_001 到 /path/第1章.md（append）" }],
  "details": {
    "ok": true,
    "chapterPath": "/path/第1章.md",
    "mode": "append",
    "eventId": "evt_001",
    "writtenText": "林墨推开酒馆的门..."
  }
}
```

**行为**：
- 读取 `chapterPath` 全文作为上下文（首行版本标记 `<!-- engine v0.01 -->` 之后的全部内容）
- 注入规则集.md（每次重读，不缓存）到用户消息末尾
- LLM 生成正文后，写入 `<!-- event: <eventId> -->` 锚点 + 空行 + 正文，追加到文件末尾
- 文件不存在时自动创建（首行写入版本标记）

#### `render_modify`

重写章节文件中指定事件锚点区间的文本（modify 模式）。

**参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `chapterPath` | string | 是 | 目标章节文件绝对路径 |
| `eventId` | string | 是 | 本次渲染对应的事件 ID（用于记录） |
| `modifyAnchorEventId` | string | 是 | 要重写的目标事件 ID |
| `storyTime` | string | 是 | 故事时间 |
| `instruction` | string | 是 | 叙事指令（描述重写方向） |
| `payload` | `RoleOutput[]` | 是 | 角色池结构化输出 |

**返回**：
```json
{
  "content": [{ "type": "text", "text": "已重写事件 evt_002 区间到 /path/第1章.md（modify）" }],
  "details": {
    "ok": true,
    "chapterPath": "/path/第1章.md",
    "mode": "modify",
    "eventId": "evt_001",
    "modifyAnchorEventId": "evt_002",
    "writtenText": "「师弟，许久不见。」"
  }
}
```

**行为**：
- 读取 `chapterPath` 全文作为上下文
- 按 `modifyAnchorEventId` 锚点定位重写区间（从该锚点到下一个锚点或文件末尾）
- LLM 生成新正文，替换该区间内容
- 锚点本身保留，仅替换锚点之后的正文

#### `render_preview`

预览渲染结果（不写入文件）。

**参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `chapterPath` | string | 否 | 章节文件路径（用于读取上下文，不写文件） |
| `eventId` | string | 是 | 事件 ID |
| `storyTime` | string | 是 | 故事时间 |
| `instruction` | string | 是 | 叙事指令 |
| `payload` | `RoleOutput[]` | 是 | 角色池结构化输出 |

**返回**：
```json
{
  "content": [{ "type": "text", "text": "林墨推开酒馆的门..." }],
  "details": {
    "ok": true,
    "eventId": "evt_001",
    "preview": true,
    "contextWarning": undefined
  }
}
```

**行为**：
- 若提供 `chapterPath`，读取全文作为上下文；否则 `contextWarning` 字段提示无上下文
- 调用 LLM 生成文本，直接返回到 `content[0].text`
- 不触碰文件系统

#### `render_check`

检验章节文本是否符合规则集.md。

**参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `target` | `"latest"` / `"chapter"` / `"range"` / `"full"` | 是 | 检验范围 |
| `chapterPath` | string | 否 | 章节文件路径（`target != "full"` 时必填） |
| `startEventId` | string | 否 | `target="range"` 时起点 |
| `endEventId` | string | 否 | `target="range"` 时终点（不包含） |

**target 说明**：
- `latest`：只检查最新事件（最后锚点到末尾）
- `chapter`：检查整章
- `range`：检查 `[startEventId, endEventId)` 区间
- `full`：需要 `chapterPath`，或由主会话拆分后多次调用

**返回**：
```json
{
  "content": [{ "type": "text", "text": "发现 2 处违规" }],
  "details": {
    "violations": [
      { "location": "evt_002", "rule": "禁止词：手机", "text": "他拿出手机", "severity": "error" }
    ],
    "suggestions": [
      { "location": "evt_002", "issue": "包含禁止词", "suggestion": "改为「他抽出信筒」" }
    ],
    "error": undefined
  }
}
```

**注**：若 LLM 返回非 JSON，`error` 字段会记录错误信息，`violations`/`suggestions` 为空数组。

#### `render_rule_set`

查看当前规则集.md 内容。无需参数。

**返回**：
```json
{
  "content": [{ "type": "text", "text": "文风：白描为主\n禁止词：手机、电脑" }],
  "details": {
    "ok": true,
    "length": 25,
    "exists": true
  }
}
```

**行为**：
- 读取 `<novelCwd>/规则集.md` 全文
- 文件不存在时 `exists: false`、`length: 0`、`content[0].text` 为空字符串
- 不缓存，每次重读

**详见**：[第 6.5 节 `@pi/renderer` 包 API](#65-pirenderer-包-api)

---

## 5. `@pi/world-graph` 包 API

### `WorldGraph` 类

```typescript
import { WorldGraph } from "@pi/world-graph";

// 异步工厂（必须用 create，不能用 new）
const wg = await WorldGraph.create({
  dbPath: "/path/to/world.db",
  eventLogPath: "/path/to/events.jsonl",
});
```

#### 静态方法

| 方法 | 说明 |
|------|------|
| `static async create(opts: WorldGraphOptions): Promise<WorldGraph>` | 异步工厂，内部用 `createStoreWithSchema` 初始化 fulltext/vector storage |

#### 实例方法

**生命周期**：
| 方法 | 说明 |
|------|------|
| `close(): void` | 关闭数据库连接 |

**检索**：
| 方法 | 说明 |
|------|------|
| `get search(): StoreSearch` | SDK 检索 facade（fulltext/vector/hybrid） |
| `query(): QueryBuilder` | SDK 链式图查询入口 |

**实体**：
| 方法 | 说明 |
|------|------|
| `async birthEntity(entityId, type, initialProps, storyTime, summary?): Promise<void>` | 创建实体（`summary` 可选，实体无状态客观事实描述） |
| `async killEntity(entityId, storyTime): Promise<void>` | 消亡实体 |
| `async getEntityAt(entityId, storyTime): Promise<EntitySnapshot \| null>` | bi-temporal 查询 |
| `async getAllEntities(storyTime): Promise<EntitySnapshot[]>` | 列出所有有效实体 |
| `async updateEntitySummary(entityId, summary): Promise<void>` | 更新实体无状态描述（独立字段；参与向量检索限导入管道 embedder 路径，运行时 `Embedder.embedEntity` 不拼接 summary） |
| `async getEntityHistory(entityId): Promise<{entities, facts}>` | 实体全部版本（含已闭合） |

**关系**：
| 方法 | 说明 |
|------|------|
| `async addRelation(sourceId, targetId, label, storyTime): Promise<void>` | 创建关系 |
| `async closeRelation(sourceId, targetId, label, storyTime): Promise<void>` | 闭合关系 |
| `async getRelations(entityId, storyTime): Promise<Relation[]>` | 列出实体关系 |
| `async getAllRelationsAt(storyTime): Promise<Relation[]>` | 列出所有有效关系 |
| `async getRelationHistory(entityId?): Promise<Relation[]>` | 关系历史（含已闭合） |

**事件**：
| 方法 | 说明 |
|------|------|
| `async processEvent(input: EventRecordInput): Promise<void>` | 应用事件（`EventRecordInput` 与 `EventRecord` 的差别是 `source` 可省略，parse 时默认 `"engine"`） |
| `async traceCauses(eventId): Promise<EventRecord[]>` | 因果回溯 |
| `async getAllEvents(): Promise<EventRecord[]>` | 全部事件（按 storyTime 升序） |

**可见性**：
| 方法 | 说明 |
|------|------|
| `async setVisibility(characterId, declarationId, opts): Promise<void>` | 设置可见性 |
| `async closeVisibility(characterId, declarationId, storyTime): Promise<void>` | 闭合可见性（撤销） |
| `async getVisibilityForCharacter(characterId, storyTime): Promise<VisibilityDeclaration[]>` | 查询角色可见性 |
| `async getVisibilityForDeclaration(declarationId, storyTime?): Promise<VisibilityDeclaration[]>` | 反向查询（某声明被谁知道） |
| `async getAllDeclarationsAt(storyTime): Promise<StateDeclaration[]>` | 列出所有有效声明 |
| `async getAllDeclarations(): Promise<StateDeclaration[]>` | 全部声明（含已闭合，供知识持续语义使用） |
| `async inferVisibility(storyTime): Promise<void>` | 推断可见性 |
| `async getCharacterView(characterId, storyTime, opts?): Promise<StateDeclaration[]>` | 角色视角（五步过滤） |

**元信息**：
| 方法 | 说明 |
|------|------|
| `async listStoryTimes(): Promise<string[]>` | 列出所有 storyTime（去重升序） |

**嵌入**：
| 方法 | 说明 |
|------|------|
| `async reembedAll(embedder): Promise<void>` | 批量重新嵌入所有 Entity/Fact |

---

## 6. `@pi/novel-importer` 包 API

V3 小说导入器子包，通过 `import_novel` 工具暴露。详见 spec: `d:\claude\pi-ex\.trae\specs\import-novel-v3\spec.md`（仓库外）。

### 主入口

```typescript
import { runImportPipeline } from "@pi/novel-importer";

const result = await runImportPipeline({
  epubPath: "/path/to/novel.epub",
  worldGraphDir: "/path/to/world-graph-v3",  // 缺省 <cwd>/.pi/world-graph-v3/
  chapters: [1, 2, 3],        // 可选：限定章节
  model: "deepseek-chat",     // 可选：LLM 模型
  apiKey: process.env.DEEPSEEK_API_KEY,  // 可选：API key
  concurrency: 3,             // 可选：章节并行限流
  resumeFromStage: 1,         // 可选：从阶段 N 恢复
  cwd: process.cwd(),         // 注入 cwd 用于默认 worldGraphDir
  embedder: embedderInstance, // 注入 TextEmbedder（满足 { embed(text): number[] } 接口）
});
```

### `ImportPipelineOptions`

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `epubPath` | string | 是 | EPUB 文件绝对路径 |
| `worldGraphDir` | string | 否 | 存储目录（缺省 `<cwd>/.pi/world-graph-v3/`） |
| `chapters` | number[] | 否 | 限定导入章节（1-based），缺省全部 |
| `model` | string | 否 | LLM 模型名（缺省 `PI_MODEL` 环境变量） |
| `apiKey` | string | 否 | LLM API key（缺省 `DEEPSEEK_API_KEY` 或 `PI_API_KEY`） |
| `concurrency` | number | 否 | 章节并行限流（缺省 3） |
| `resumeFromStage` | number | 否 | 从阶段 N 恢复（1-8） |
| `cwd` | string | 否 | 用于解析默认 worldGraphDir |
| `embedder` | `TextEmbedder` | 否 | 注入嵌入器（缺省阶段 8 跳过 reembedAll） |

### `ImportPipelineResult`

```typescript
interface ImportPipelineResult {
  entityCount: number;
  eventCount: number;
  relationCount: number;
  visibilityCount: number;
  worldGraphDir: string;
  dumpPath: string;  // _v3_dump.json 路径
}
```

### 主要导出函数

| 函数 | 来源文件 | 用途 |
|------|----------|------|
| `runImportPipeline` | pipeline.ts | 主入口，编排 8 阶段 |
| `readChaptersFromEpub` | epub.ts | EPUB 分章 |
| `scanEntitiesGlobal` | stages.ts | 全书实体预扫描 |
| `generateAllChapterEvents` | stages.ts | 章节事件流生成 |
| `resolveEntities` | resolve.ts | 实体消解（三级策略） |
| `extractAllRelations` | stages.ts | 关系抽取 |
| `inferAllVisibilities` | stages.ts | 可见性推断 |
| `buildCausedByChain` | write.ts | causedBy 拓扑序构建 |
| `writeToGraph` | write.ts | 写入 world-graph |
| `validateGraph` | validate.ts | P0/P1 校验 |
| `makeEmbedder` | validate.ts | 从 TextEmbedder 构造 WorldGraph embedder |
| `reembedAll` | validate.ts | 批量重新嵌入 |

### 实体消解三级策略

1. **精确匹配**：别名完全相等（含全角/半角归一化）
2. **字符串相似度**：Jaro-Winkler 相似度 ≥ `DEFAULT_SIMILARITY_THRESHOLD`（0.85）自动合并
3. **LLM 判断**：相似度在 `[SUSPICIOUS_LOWER_BOUND, DEFAULT_SIMILARITY_THRESHOLD)`（即 `[0.6, 0.85)`）区间，由 LLM 判断是否同一实体

### P0 校验项（失败抛错退出）

- 实体引用完整性（change 事件 `new_facts` 的 entityId 在 Entity 表中存在；`entity_hint` 必须命中 canonicalMap）
- 事件因果链无环且完整（`causedBy` 必须指向链内 eventId；首事件 `causedBy = undefined`）
- 章节完整性（每章至少有事件覆盖）
- 每个 canonical 实体 ≥1 个 birth 事件
- birth 事件 `entityType` 必填
- storyTime 格式校验（`^ch\d{3}\.ev\d{3}$`）
- entityId 唯一性（aliasIndex 中 canonical entityId 无重复）

### P1 校验项（警告继续）

- 重复 birth（write.ts 写入时已去重，此处显式降级为 P1，仅通过 `skippedEvents` 统计报告）
- 属性名建议白名单（`knownProps` 平名表；`belief.` / `hypothesis.` 前缀豁免）

---

## 6.5 `@pi/renderer` 包 API

### 概述

`@pi/renderer` 是渲染器子包，将叙事指令 + 角色池结构化数据渲染为符合规则集.md 文风格的文本。

**架构定位**：
- workspace 子包（`private: true`，独立开发）
- 通过 narrative-engine 扩展暴露 5 个 pi 工具（`render_*`）
- 不独立成为 pi 扩展，随 narrative-engine 一起 build + sync

**核心理念**：
- 渲染器无状态：LLM 调用器和规则集由调用方传入
- 规则集.md 是渲染器的 `AGENTS.md`：纯自由文本，原样注入用户消息末尾（注意力最强），每次渲染重读不缓存

### 子包导出

```typescript
// 类型
export type { RoleOutput, RenderTextCommand, RenderFileCommand, RenderResult, RenderLlmCaller, RenderCtx } from "./types.ts";

// 规则集加载
export { loadRuleSet } from "./rule-loader.ts";

// 章节文件读写
export { readChapter, readChapterSection, appendToChapter, modifyChapterSection, ensureChapterFile, CHAPTER_VERSION_MARKER, EVENT_ANCHOR_PREFIX } from "./chapter-io.ts";

// 提示词模板
export { RENDERER_SYSTEM_PROMPT, buildUserMessage } from "./prompts.ts";

// 核心渲染函数
export { renderText, renderToFile } from "./renderer.ts";
```

### `loadRuleSet(novelCwd: string): Promise<string>`

读取 `<novelCwd>/规则集.md` 全文。文件不存在时返回空字符串（不报错）。不缓存，每次重读。

### `renderText(cmd: RenderTextCommand, ctx: RenderCtx): Promise<string>`

仅生成文本，不写文件。调用方需自行传入 context（已有章节文本或上下文摘要）。适合预览。

### `renderToFile(cmd: RenderFileCommand, ctx: RenderCtx): Promise<RenderResult>`

生成文本并写入章节文件。

- **append 模式**：读全文做上下文 → LLM 生成 → 追加到文件末尾
- **modify 模式**：读全文做上下文 → LLM 生成 → 重写锚点区间

### `readChapterSection(chapterPath, startEventId?, endEventId?): Promise<string>`

读取章节文件中指定锚点区间的文本。`[start, end)` 语义（包含 start，不包含 end）。

### `RenderLlmCaller`

注入式 LLM 调用器接口：`(systemPrompt: string, userMessage: string) => Promise<string>`。便于单测时注入 mock，生产环境用 pi-ai 的 complete 实现（见 `src/renderer-llm.ts` 的 `makeRendererLlmCaller`）。

### 规则集.md 格式说明

规则集.md 是渲染器的 `AGENTS.md`，纯自由文本 Markdown，无固定模块名要求。

**示例**：
```markdown
# 规则集

## 文风
白描为主，少用形容词。
对话简洁，不铺垫情绪。

## 禁止词
- 手机、电脑、电话等现代词汇
- "突然"、"忽然"等副词

## 格式
- 段落间空一行
- 对话用「」包裹
```

**注入位置**：用户消息末尾（注意力最强），由 `buildUserMessage` 拼接：

```
[已有上下文]
...

[叙事指令]
（故事时间：ch-2）
（续写模式：在已有上下文之后续写新段落）
...

[角色池结构化数据]
...

─── 规则集（严格遵守以下规则）───
<规则集全文>
─── 以上为本次渲染规则 ───
```

### 章节文件格式约定

```
<!-- engine v0.01 -->

<!-- event: evt_001 -->

林墨推开酒馆的门，雨丝落在肩上。

<!-- event: evt_002 -->

「师弟，许久不见。」
```

- 首行固定 `<!-- engine v0.01 -->`（版本标记）
- 每个事件渲染产物前插入 `<!-- event: <eventId> -->` 锚点
- 锚点后空一行，接正文
- modify 模式按锚点定位重写区间

---

## 6.6 `@pi/role-pool` 包 API

角色池子包：串行角色扮演编排。无状态（LLM 实例、规则集、演员表均由调用方持有）。

### 子包导出

```typescript
export type { SillyTavernCard, FactSnapshot, CastMember, InteractCommand, PriorAction,
  RoleAgentOutput, StateChange, RoleRelationUpdate, InteractResult, RoleLlmCaller, RoleCtx } from "./types.ts";
export { buildSystemPrompt, buildUserMessage } from "./prompts.ts";
export { interact } from "./role-pool.ts";
export { extractStateChanges, extractRelations, toRoleOutputs } from "./transforms.ts";
export { loadRoleRuleSet } from "./rule-loader.ts";
```

### `interact(cmd: InteractCommand, ctx: RoleCtx): Promise<InteractResult>`

按 `cast` 顺序逐个调用角色 LLM，**后动者可见先动者的公开 action**（不含 thought/emotion/state_changes）。
单角色失败跳过记 `errors`，不中断。

### Prompt 组装（2026-07-25 修订后）

- **System**：角色规则集.md + "动态层优先于静态层"冲突提醒 + executionHints（可选）
- **User**：`[你的 entityId]` + `[本场角色名单]` → 静态卡 JSON → 动态层 → storyTime → 先动者行动 → 事件指令（末尾）
- **动态层渲染**：`- [属主名] property: value（modality）`；已闭合声明标注 `（fact·旧）`；按检索 label 分组渲染【小标题】

### `RoleAgentOutput`（9 字段）

```typescript
{
  characterId: string;          // 必填，LLM 填自己的 entityId
  actor: string;                // 行动者名字（角色卡 name）
  action: string;               // 可观察行动
  target?: string;
  emotion?: string;
  relation_update?: { target: string; label: string }[];  // target 填对方 characterId
  thought?: string;             // 内心（其他角色不可见）
  knowledge_gained?: string[];  // ⚠️ 当前不写世界图（自然语言→declarationId 映射未设计）
  state_changes?: { entityId: string; property: string; value: unknown; modality: Modality }[];
}
```

### transforms

| 函数 | 用途 |
|------|------|
| `extractStateChanges(outputs)` | 扁平化全部 state_changes（供 commit 写扩散） |
| `extractRelations(outputs)` | 提取 relation_update，source 取 `characterId` |
| `toRoleOutputs(outputs)` | 投影为渲染器 RoleOutput（剥掉 `characterId`/`state_changes`） |

---

## 6.7 `@pi/scheduler` 包 API

调度器子包：编排层（不演戏、不渲染、纯串联）。

### 子包导出

```typescript
export { plan, commit, discard, loadAllPlans } from "./index.ts";  // 编排
export { resolveChapterPath } from "./chapter-resolver.ts";        // storyTime → 章节路径（双格式）
export { defaultStaticCardLoader } from "./static-card-loader.ts"; // Entity+Facts → 酒馆卡重组
export type { StructuredEvent, RetrievalPlan, RetrievalItem, PlanResult,
  DispatchPlanOutput, DispatchYoloOutput, CommitResult, SchedulerCtx, FactSnapshot } from "./types.ts";
```

### `plan(event: StructuredEvent, ctx)` 10 步

1. 生成 eventId/planId → 2. 解析章节路径 → 3. planner LLM 推导 RetrievalPlan →
4. 兜底：每角色至少 1 条 character_view → 5. 逐项执行检索（按 assignTo 信息差分配，label 随 Fact 传递）→
5.5 解析动态层属主名（ownerName）→ 6. 组装 CastMember → 7. role-pool.interact →
8. 缓存 plan（内存 + `.pi/scheduler-plans/` 磁盘，TTL 1h）→ 9/10. yolo 自动 commit / plan 等确认

### `commit(planId, ctx)` 8 步

1. 取 plan → 2. extractStateChanges → 3. 按 entityId 分组 →
4. 写扩散：同 property 未闭合 Fact **全量** invalidated + `processEvent(type="change")` →
4.3 **自产自知**：为作者角色写新 Fact 的 Visibility（`source: "experienced"`）→
5. extractRelations → `addRelation` → 6. toRoleOutputs 投影 → 7. 按 intent 渲染（add/modify/insert）→ 8. 清理 plan 缓存

### `StructuredEvent`（调度器唯一输入）

```typescript
{
  storyTime: string;
  instruction: string;
  characterIds: string[];         // 主会话已消解为 entityId
  executionHints?: string;        // 用户特殊要求，透传角色池+渲染器
  mode?: "plan" | "yolo";        // 缺省 plan
  chapterPath?: string;           // 缺省从 storyTime 推断
  locationId?: string;
  intent?: "add" | "modify" | "insert";
  targetEventId?: string;         // modify/insert 必填
}
```

### 检索类型（RetrievalItem.type）

`character_view` / `entity_snapshot`（不过可见性，慎用）/ `relations` / `search_text` / `search_vector` / `search_hybrid`

> ⚠️ `search_vector` / `search_hybrid` 仅支持 `Entity`/`Fact` 节点（只有这两种声明了 embedding 字段）；
> planner 误输出 Relation/Visibility 时执行层防御性跳过（不崩）。

---

## 7. `Search` 类 API

```typescript
import { Search } from "narrative-engine/src/search.ts";

const search = new Search(wg, embedder);
```

### 构造函数

```typescript
constructor(wg: WorldGraph, embedder: Embedder)
```

### 方法

#### `search(query, opts?): Promise<EntitySearchResult[]>`

统一检索入口，默认 `hybrid` 模式。

**参数**：
| 字段 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `query` | string | 是 | - | 查询文本 |
| `opts.topK` | number | 否 | `10` | 返回数量上限 |
| `opts.typeFilter` | EntityType | 否 | - | 实体类型过滤 |
| `opts.storyTime` | string | 是 | - | 故事时间（必填，用于 bi-temporal 过滤） |
| `opts.mode` | `"fulltext"` \| `"vector"` \| `"hybrid"` | 否 | `"hybrid"` | 检索模式 |

#### `fulltext(query, opts?): Promise<EntitySearchResult[]>`

仅全文检索。搜 Fact 节点的 `property` + `valueText` 字段（FTS5）。

#### `vector(query, opts?): Promise<EntitySearchResult[]>`

仅向量检索。先将 `query` 通过 `embedder.embed()` 转向量，再搜 Entity 节点的 `embedding` 字段（cosine 相似度）。

#### `hybrid(query, opts?): Promise<EntitySearchResult[]>`

混合检索。RRF 融合 fulltext + vector 结果。搜 Fact 节点（同时有 searchable + embedding 字段）。

### `EntitySearchResult` 接口

```typescript
interface EntitySearchResult {
  entityId: string;
  type: EntityType;
  score: number;              // 相关性分数（越高越相关）
  matchType: "fulltext" | "vector" | "hybrid";
  snapshot: EntitySnapshot;   // 实体快照（含 properties）
}
```

---

## 8. `Embedder` 类 API

```typescript
import { Embedder } from "narrative-engine/src/embedder.ts";

const embedder = new Embedder();  // 默认 Xenova/bge-small-zh-v1.5, 512 维
```

### 构造函数

```typescript
constructor(model?: string, dim?: number)
// 默认: model = "Xenova/bge-small-zh-v1.5", dim = 512
```

### 实例方法

| 方法 | 说明 |
|------|------|
| `async init(): Promise<void>` | 懒加载模型（首次调用时下载/加载，多次调用安全） |
| `async embed(text: string): Promise<number[]>` | 通用文本向量化，返回 512 维归一化向量 |
| `async embedBatch(texts: string[]): Promise<number[][]>` | 批量向量化（提高吞吐） |
| `async embedEntity(snapshot: EntitySnapshot): Promise<number[]>` | 实体向量化（拼接 `entityId + type + properties`） |
| `async embedFact(decl: StateDeclaration): Promise<number[]>` | 事实向量化（拼接 `property + value + modality`） |
| `getDimension(): number` | 获取向量维度（512） |

### 静态方法

| 方法 | 说明 |
|------|------|
| `static cosineSimilarity(a, b): number` | 计算余弦相似度（向量已归一化，等价于点积） |
| `static euclideanDistance(a, b): number` | 计算欧氏距离 |

### 配置

**镜像**（国内用户）：通过 `HF_ENDPOINT` 环境变量切换 HuggingFace 镜像
```bash
export HF_ENDPOINT=https://hf-mirror.com
```

**模型文件**：~50MB（量化 ONNX），首次运行时下载到本地缓存。

**缓存路径**（2026-07-25 修正认知）：`<模块所在 node_modules>/@xenova/transformers/.cache/`
（transformers.js v2 默认缓存位置，**不是** `~/.cache/huggingface`）。
sync 保留扩展目录 node_modules，缓存不会因重新同步丢失。

**离线回退**（2026-07-25 新增）：远程加载失败（HF 受限网络 fetch failed）时自动
`localFilesOnly = true` 重试——模型已缓存则完全离线可用。

---

## 9. 类型定义

### `EntityType`

```typescript
type EntityType = "character" | "location" | "item" | "concept";
```

- `character`：有意志的实体（角色）
- `location`：被动空间实体（场景）
- `item`：物品实体
- `concept`：弥漫性概念实体（世界观、规则、组织）

### `Modality`

```typescript
type Modality = "fact" | "belief" | "hypothesis";
```

- `fact`：客观事实
- `belief`：角色信念（主观）
- `hypothesis`：假设/推测

### `EventType`

```typescript
type EventType = "birth" | "death" | "change";
```

### `EventSource`

```typescript
type EventSource = "engine" | "user";
```

- `engine`：引擎/scheduler/子代理扩散产生的事件（默认）
- `user`：用户/前端编辑产生的事件

### `StateDeclaration`

```typescript
interface StateDeclaration {
  declarationId: string;    // 声明唯一 ID
  entityId: string;         // 所属实体
  property: string;         // 属性名（searchable）
  value: unknown;           // 属性值
  valueText?: string;       // 序列化值（searchable，用于全文检索）
  modality: Modality;       // 模态
  validFrom: string;        // 生效时刻
  validTo: string;          // 失效时刻（"Infinity" = 未闭合）
}
```

### `EntitySnapshot`

```typescript
interface EntitySnapshot {
  entityId: string;
  type: EntityType;
  summary: string;          // 实体无状态客观事实描述（独立数据字段；参与向量检索限导入管道 embedder 路径）
  validFrom: string;
  validTo: string;
  properties: StateDeclaration[];
}
```

### `EventRecord`

```typescript
interface EventRecord {
  eventId: string;
  type: EventType;
  storyTime: string;
  entityId: string;
  source: EventSource;      // 事件来源，默认 "engine"
  entityType?: EntityType;  // birth 事件用：实体类型（默认 "character"）
  summary?: string;         // birth 事件用：实体无状态客观事实描述（独立数据字段）
  invalidated?: Array<{     // type=change 时的闭合声明
    declarationId: string;
    property: string;
  }>;
  newFacts?: Array<{        // type=birth/change 时的新增声明
    entityId: string;
    property: string;
    value: unknown;
    modality: Modality;
  }>;
  causedBy?: string;        // 因果链前驱事件 ID
}
```

### `EventRecordInput`

```typescript
// z.input<typeof EventRecord> 推导：source 可选（parse 时默认 "engine"），其余字段同 EventRecord
type EventRecordInput = Omit<EventRecord, "source"> & { source?: EventSource };
```

`EventLog.append` 与 `WorldGraph.processEvent` 入口均接受 `EventRecordInput`，内部 `EventRecord.parse(input)` 应用默认值（`source` 缺省 `"engine"`），事件日志中始终落完整 `EventRecord`。

### `VisibilityDeclaration`

```typescript
interface VisibilityDeclaration {
  characterId: string;
  declarationId: string;
  state: "known";           // 当前只支持 "known"
  confidence: number;       // 0-1
  source: string;           // "witnessed" | "rumor" | 自定义
  validFrom: string;
  validTo: string;          // 默认 "Infinity"
  isExplicit: boolean;
}
```

---

## 10. SDK 检索能力

`@pi/world-graph` 包启用 `@nicia-ai/typegraph@0.40.0` 的内置检索能力。

### Graph Schema 中的可检索字段

| 节点类型 | 字段 | 装饰器 | 用途 |
|----------|------|--------|------|
| Entity | `embedding` | `embedding(512).optional()` | 向量检索（cosine） |
| Fact | `property` | `searchable({ language: "zh" })` | 全文检索属性名 |
| Fact | `valueText` | `searchable({ language: "zh" }).optional()` | 全文检索属性值 |
| Fact | `embedding` | `embedding(512).optional()` | 向量检索事实 |

### StoreSearch API（通过 `wg.search`）

```typescript
// 全文检索
const fulltextHits = await wg.search.fulltext("Fact", {
  query: "Macbeth",
  limit: 10,
  // 可选: mode, language, minScore, includeSnippets, where, offset
});

// 向量检索
const vectorHits = await wg.search.vector("Entity", {
  fieldPath: "embedding",
  queryEmbedding: number[],  // 512 维
  limit: 10,
  // 可选: metric, minScore, efSearch, where, offset
});

// 混合检索（RRF 融合）
const hybridHits = await wg.search.hybrid("Fact", {
  vector: { fieldPath: "embedding", queryEmbedding: number[] },
  fulltext: { query: "Macbeth" },
  limit: 10,
  // 可选: fusion, where, offset
});

// 重建全文索引（数据迁移后用）
await wg.search.rebuildFulltext();
```

### QueryBuilder API（通过 `wg.query()`）

```typescript
const results = await wg.query()
  .from("Entity")
  .whereNode({ entityId: "macbeth" })
  .traverse("declares")
  .to("Fact")
  .select()
  .execute();
```

### Hit 结构

```typescript
// 全文检索命中
type FulltextSearchHit<N> = {
  node: N;          // 完整节点对象
  score: number;    // 相关性分数
  rank: number;     // 1-based 排名
  snippet?: string; // 高亮片段（includeSnippets: true 时有值）
};

// 向量检索命中
type VectorSearchHit<N> = {
  node: N;
  score: number;
  rank: number;
};

// 混合检索命中
type HybridSearchHit<N> = {
  node: N;
  score: number;          // RRF 融合分数
  rank: number;
  vector?: VectorSearchHit<N>;
  fulltext?: FulltextSearchHit<N>;
};
```

---

## 11. 可视化服务（Visualizer）

世界图可视化前端：按 storyTime 快照浏览/过滤实体与关系、搜索定位、手动编辑字段（全部走 API，编辑产生 `source: "user"` 事件）、事件链视图、角色视角模式、历史审计。

时间轴 UI（2026-07-25 优化）：两级分组防重叠——层级 storyTime（如 `ch009.ev003`）自动拆为
章级刻度 + 当前章事件刻度；非层级 storyTime 用稀疏标签 + `‹ ›` 步进 + 下拉直跳。

### 11.1 启动方式（双入口，共用 `src/visualizer/server.ts` 的 `startVisualizer`）

#### 11.1.1 pi 会话内

调用 `open_visualizer` 工具（非 `world_*` 前缀，见 [4.8](#48-可视化工具)）。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `port` | number | 否 | 端口，默认 7421 |

**行为**：
- 幂等：已启动时直接返回现有 URL（`alreadyRunning: true`）
- 注入 session 的 `WorldGraph` 与 `Search` 实例（含 Embedder，支持 vector/hybrid 检索）
- `session_shutdown` 时自动关闭服务
- `forceFulltext = false`（前端传 `mode=vector`/`hybrid` 正常生效）

#### 11.1.2 standalone（脱离 pi）

```bash
node scripts/visualizer.mjs [--db <dir>] [--port 7421] [--embed]
```

**参数**：
| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--db <dir>` | `../novel/.pi/world-graph-v3/`（相对仓库根） | 世界图数据目录，需含 `world.db` / `events.jsonl` |
| `--port <n>` | 7421 | 监听端口（0-65535） |
| `--embed` | 关闭 | 加载 Xenova/bge-small-zh-v1.5 向量模型（首次下载较慢），启用 vector/hybrid 检索 |

**检索模式行为**：
- 不带 `--embed`：`forceFulltext = true`，即使前端传 `mode=vector`/`hybrid` 也会被服务端强制降级为 `fulltext`（因 `Search.fulltext` 不依赖 embedder，传 null 占位即可）
- 带 `--embed`：`forceFulltext = false`，三种模式正常生效

**进程信号**：`SIGINT` / `SIGTERM` 触发优雅关闭（`server.close()` + `wg.close()` + `process.exit(0)`）。

**脚本链路**：`scripts/visualizer.mjs`（薄壳）→ spawn `tsx` 运行 `src/visualizer/standalone.ts`（实际启动逻辑）。薄壳存在的原因是源码用 TypeScript + `.ts` import specifier，node 无法直接加载。

#### 11.1.3 静态文件服务

- `uiDir` 默认探测顺序（`resolveDefaultUiDir`）：
  1. `<__dirname>/../../visualizer-ui`（开发态：`src/visualizer/` 上两级 = 仓库根；构建态：`dist/visualizer/` 上两级 = 仓库根）
  2. `<__dirname>/../visualizer-ui`（同步态：扩展目录下 `visualizer/server.js` 上一级 = 扩展目录根，`sync.mjs` 将 `visualizer-ui` 复制到此）
- 路径穿越防护：`filePath` 必须以 `normalize(uiDir)` 开头，否则 403
- 未知文件 404；`/` 映射到 `index.html`
- 支持的 Content-Type：`.html`/`.js`/`.mjs`/`.css`/`.json`/`.map`/`.svg`/`.png`/`.jpg`/`.jpeg`/`.gif`/`.ico`/`.woff`/`.woff2`/`.ttf`/`.txt`，其余按 `application/octet-stream`

### 11.2 HTTP JSON API（`/api` 前缀，统一 envelope）

成功 `{ ok: true, data, error: null }`；失败 `{ ok: false, data: null, error: { code, message } }`。

所有响应带 `access-control-allow-origin: *`。`OPTIONS` 方法统一返回 204 + CORS 预检头（`GET, POST, OPTIONS` / `content-type`）。非 GET/POST/OPTIONS 方法返回 404 `NOT_FOUND`。

#### 11.2.1 查询端点（GET）

| Path | 必填参数 | 返回 data 结构 | 说明 |
|---|---|---|---|
| `/api/status` | — | `{ entityCount, eventCount, storyTimes }` | entityCount 基于 latest storyTime；storyTimes 升序 |
| `/api/graph` | `storyTime` | `{ entities, relations }` | `includeClosed=1` 时 relations 来自 `getRelationHistory()`（全量），否则 `getAllRelationsAt(storyTime)`（仅有效） |
| `/api/entities/:id` | `storyTime` | `EntitySnapshot` | 404 `ENTITY_NOT_FOUND` 若该时刻不存在 |
| `/api/entities/:id/history` | — | `{ ...entityHistory, relations }` | 实体全版本历史 + 该实体的全量关系历史（含已闭合） |
| `/api/declarations/:declId/visibility` | —（`storyTime` 可选） | `{ declarationId, visibility }` | 该声明的可见性记录（反向查询），`storyTime` 缺省返回全部 |
| `/api/search` | `q`, `storyTime` | `{ results: EntitySearchResult[] }` | `mode`：`fulltext`/`vector`/`hybrid`（缺省 `hybrid`，`forceFulltext` 时强制 `fulltext`）；`type`：`character`/`location`/`item`/`concept` 可选过滤 |
| `/api/events` | — | `{ events: EventRecord[] }` | 全量事件日志 |
| `/api/events/:id/chain` | — | `{ events: EventRecord[] }` | 因果链（`traceCauses` 回溯到根） |
| `/api/character-view` | `characterId`, `storyTime` | `{ view }` | 角色视角可见声明 |

#### 11.2.2 写入端点（POST）

所有写入端点的 `source` 字段被服务端强制为 `"user"`（前端无法伪造 `engine` 来源）。

| Path | 必填 body 字段 | 行为 |
|---|---|---|
| `/api/events` | `eventId`, `type`, `storyTime`, `entityId` | 应用事件（`EventRecordInput`）；birth 可含 `entityType`/`summary`，change = invalidated+newFacts（即"编辑字段"） |
| `/api/entities/:id/summary` | `summary` | 更新实体摘要（`updateEntitySummary`） |
| `/api/relations` | `sourceId`, `targetId`, `label`, `storyTime` | 新建关系（`addRelation`） |
| `/api/relations/close` | `sourceId`, `targetId`, `label`, `storyTime` | 闭合关系（`closeRelation`） |
| `/api/visibility` | `characterId`, `declarationId`, `confidence`, `source`, `storyTime` | 设置可见性（`setVisibility`，服务端强制 `state: "known"` + `isExplicit: true`） |
| `/api/visibility/close` | `characterId`, `declarationId`, `storyTime` | 撤销可见性（`closeVisibility`） |

#### 11.2.3 错误码

| HTTP | code | 触发场景 |
|------|------|----------|
| 400 | `INVALID_JSON` | POST 请求体 JSON 解析失败 |
| 400 | `INVALID_BODY` | 请求体不是 JSON 对象 |
| 400 | `MISSING_FIELD` | 缺少必填字段（query 或 body） |
| 400 | `STORY_TIME_REQUIRED` | 缺少必填参数 `storyTime` |
| 400 | `VALIDATION_ERROR` | 写入路径 zod 校验失败（`ZodError`） |
| 400 | `BUSINESS_ERROR` | 写入路径业务错误（实体不存在/已闭合等 WorldGraph 方法抛出） |
| 404 | `ENTITY_NOT_FOUND` | `GET /api/entities/:id` 该时刻无快照 |
| 404 | `NOT_FOUND` | 未知路由 / 不支持的 method |
| 405 | —（纯文本 `Method Not Allowed`） | 非 GET/POST/OPTIONS 且非 `/api` 路径 |
| 500 | `INTERNAL_ERROR` | GET 路径未捕获异常 |
| 500 | `INTERNAL_ERROR` | 兜底：任何未捕获异常（保证连接不悬挂） |
| 501 | `SEARCH_UNAVAILABLE` | `GET /api/search` 未注入 Search 实例 |

### 11.3 前端（`visualizer-ui/`，Vue 3 + Element Plus）

V3 workbench UI（commit 28405bc）：Vue 3 全局构建 + Element Plus 组件库 + 双图视图（2D LiteGraph 画布 + 3D 力导向图）。

#### 11.3.1 入口与脚本加载

- **主入口**：`index.html`（V3 workbench UI，`<html class="dark">` 暗色主题）
- **V2 遗留入口**：`v2-legacy.html`（旧版 LiteGraph 画布，兼容旧书签）
- **脚本加载顺序**（`index.html`）：
  1. vendor：`vue.global.prod.js` → `element-plus.full.min.js` → `element-plus.locale.zh-cn.min.js` → `three.min.js` → `three-spritetext.min.js` → `3d-force-graph.min.js`
  2. `api.js`（HTTP 客户端封装）
  3. components：`timeline-bar` → `entity-list` → `graph-3d` → `snapshot-table` → `relation-form` → `detail-editor` → `entity-form` → `event-timeline` → `help-tour`
  4. `app.js`（Vue 应用根，最后加载）

#### 11.3.2 主要文件

| 文件 | 职责 |
|------|------|
| `app.js` | Vue 应用根（状态管理 + 路由切换 + 主布局） |
| `api.js` | HTTP 客户端封装（统一调用 `/api/*`） |
| `detail-panel.js` | 五页签详情抽屉（基本/属性/关系/可见性/历史） |
| `graph-view.js` | **2D LiteGraph 画布**：实体卡片节点（四类类型色）+ 自绘关系边（两点模式新建、右键闭合）+ 节点位置 localStorage 持久化 |
| `events-view.js` | 事件链视图 |
| `components/graph-3d.js` | **3D 力导向图**（3d-force-graph 隔离层，邻域图/全景图共用） |
| `components/entity-list.js` | 左栏实体列表（类型过滤、搜索） |
| `components/detail-editor.js` | 字段编辑器（全部走 API，编辑产生 `source: "user"` 事件） |
| `components/relation-form.js` | 关系新建/闭合表单 |
| `components/event-timeline.js` | 事件时间线 |
| `components/snapshot-table.js` | storyTime 快照选择器表格 |
| `components/timeline-bar.js` | 顶部 storyTime 时间轴 |
| `components/entity-form.js` | 实体新建/编辑表单 |
| `components/help-tour.js` | 新手引导 |
| `v2-legacy-app.js` / `v2-legacy.css` / `v2-legacy.html` | V2 遗留页面（兼容旧入口） |

#### 11.3.3 vendor 依赖

| 文件 | 用途 |
|------|------|
| `vue.global.prod.js` | Vue 3 全局构建 |
| `element-plus.full.min.js` + `element-plus.index.css` + `element-plus.dark.css-vars.css` + `element-plus.locale.zh-cn.min.js` | Element Plus 组件库（暗色主题 + 中文） |
| `three.min.js` + `three-spritetext.min.js` + `3d-force-graph.min.js` | 3D 力导向图 |
| `litegraph.js` + `litegraph.css` | 2D 节点画布（V2 遗留，V3 主入口已改用 3D，但 `graph-view.js` 仍保留 LiteGraph 实现） |

#### 11.3.4 功能

按 storyTime 快照浏览/过滤实体与关系、搜索定位、手动编辑字段（全部走 API，编辑产生 `source: "user"` 事件）、事件链视图、角色视角置灰、历史审计。节点位置存浏览器 localStorage，不污染存储层。

### 11.4 同步与测试

**同步**：`scripts/sync.mjs` 会将 `visualizer-ui/` 一并复制到扩展目录（`novel/.pi/extensions/narrative-engine/visualizer-ui/`）。

**测试**：`tests/visualizer-server.test.ts`（15 个集成测试）
```bash
npx tsx --test tests/visualizer-server.test.ts
```

覆盖：静态文件服务、API envelope、所有 GET/POST 端点、错误码、CORS、路径穿越防护、端口分配（传 0 由系统分配）。

---

## 附录：版本与依赖

| 依赖 | 版本 | 用途 |
|------|------|------|
| `@nicia-ai/typegraph` | `0.40.0` | TypeGraph SDK（StoreSearch/QueryBuilder/searchable/embedding） |
| `@xenova/transformers` | latest | Xenova/bge-small-zh-v1.5 嵌入模型 |
| `better-sqlite3` | latest | SQLite 后端 |
| `sqlite-vec` | `^0.1.9` | SQLite 向量扩展 |
| `drizzle-orm` | latest | ORM |
| `zod` | `^4.0.0` | Schema 校验 |
| `typebox` | latest | PI 工具参数 schema |
| `@mariozechner/pi-ai` | latest | LLM 调用（novel-importer 阶段 2/3/5/6） |
| `epub2` / `xml2js` | latest | EPUB 解析（novel-importer 阶段 1） |

**Graph Schema 初始化**：通过 `createStoreWithSchema`（异步 factory），自动建表/初始化 schema/迁移。默认 `systemIndexes: "materialize"`，无需手动调用 `materializeIndexes()` 或 `rebuildFulltext()`。

**workspace 子包结构**：
- `packages/world-graph/` — `@pi/world-graph`（WorldGraph 类 + 类型）
- `packages/novel-importer/` — `@pi/novel-importer`（V3 导入管道）
- `packages/renderer/` — `@pi/renderer`（渲染器子包）
- `src/` — narrative-engine 扩展入口（工具注册 + Embedder + Search + Visualizer）
