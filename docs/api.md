# Narrative Engine API 文档

> **版本**: V2（tool-adaptation 重写后）
> **适用分支**: `feat/world-graph-rewrite`
> **最后更新**: 2026-07-23

## 目录

- [1. 架构概览](#1-架构概览)
- [2. 存储路径](#2-存储路径)
- [3. storyTime 管理约定](#3-storytime-管理约定)
- [4. PI 扩展工具 API（18 个 world_*）](#4-pi-扩展工具-api18-个-world_)
  - [4.1 状态查询](#41-状态查询)
  - [4.2 实体工具](#42-实体工具)
  - [4.3 关系工具](#43-关系工具)
  - [4.4 事件工具](#44-事件工具)
  - [4.5 可见性工具](#45-可见性工具)
  - [4.6 检索工具](#46-检索工具)
  - [4.7 历史与元信息工具](#47-历史与元信息工具)
- [5. `@pi/world-graph` 包 API](#5-piworld-graph-包-api)
- [6. `Search` 类 API](#6-search-类-api)
- [7. `Embedder` 类 API](#7-embedder-类-api)
- [8. 类型定义](#8-类型定义)
- [9. SDK 检索能力](#9-sdk-检索能力)
- [10. 可视化服务（Visualizer）](#10-可视化服务visualizer)

---

## 1. 架构概览

```
┌─────────────────────────────────────────────────────┐
│  PI 主会话 / Scheduler / 前端                       │
│  （通过 pi.registerTool 注册的 19 个工具调用）       │
└──────────────────┬──────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────┐
│  narrative-engine/src/index.ts                       │
│  - session_start: 初始化 WorldGraph/Embedder/Search │
│  - 注册 18 个 world_* 工具 + open_visualizer       │
│  - 管理 session 级 currentStoryTime                 │
└────┬────────────┬──────────────┬────────────────────┘
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
     └───────────┴──────────────────┘
                  │
                  ▼
     ┌──────────────────────────────┐
     │ @nicia-ai/typegraph@0.40.0   │
     │ - StoreSearch (fulltext/vec) │
     │ - QueryBuilder               │
     │ - searchable()/embedding()   │
     │ - sqliteVecStrategy          │
     └──────────────────────────────┘
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

默认路径：`<cwd>/.pi/world-graph-v2/`

| 文件 | 用途 |
|------|------|
| `world.db` | SQLite 数据库（Entity/Fact/Relation/Visibility 节点 + fulltext/vector 索引） |
| `events.jsonl` | 事件日志（JSONL 格式，每行一条 EventRecord） |

**旧路径** `<cwd>/.pi/world-graph/` 已废弃（V1 数据不迁移）。

---

## 3. storyTime 管理约定

所有写入/查询操作都需要 `storyTime`（故事时间，字符串标识）。PI 工具层提供两种传参方式：

1. **显式传递**：调用工具时传 `storyTime` 参数
2. **隐式复用**：不传时使用 `currentStoryTime`（session 级状态）

`currentStoryTime` 更新规则：
- `session_start` 时初始化为 `null`
- `world_event_apply` / `world_entity_create` / `world_entity_kill` 时更新为事件/操作的 `storyTime`
- 其他工具（如 `world_entity_get`、`world_query`）不更新

如果 `currentStoryTime` 为 `null` 且工具需要 storyTime，会抛错：
```
Error: storyTime required (call world_event_apply first or pass storyTime explicitly)
```

---

## 4. PI 扩展工具 API（18 个 world_*）

所有工具通过 `pi.registerTool` 注册，遵循 PI ExtensionAPI 约定：
- `name` — 工具唯一标识（`world_*` 前缀）
- `label` — 显示标签
- `description` — LLM 可见的工具描述
- `parameters` — TypeBox schema 定义参数
- `async execute(_id, params)` — 执行体，返回 `{ content: [{type, text}], details }`

### 4.1 状态查询

#### `world_status`

获取世界图状态摘要。

**参数**：无

**返回**：
```json
{
  "content": [{ "type": "text", "text": "currentStoryTime: act2-scene1\n实体数: 5\n事件数: 3" }],
  "details": {
    "status": {
      "currentStoryTime": "act2-scene1",
      "entityCount": 5,
      "eventCount": 3
    }
  }
}
```

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
| `summary` | string | 否 | 实体摘要（作者可见元信息，纯展示字段，不参与检索/可见性/时态） |

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
      "valueText": "Macbeth",
      "modality": "fact",
      "validFrom": "act1-scene1",
      "validTo": "Infinity"
    }
  ]
}
```

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
    summary?: string,                                   // birth 事件用：实体摘要（作者可见元信息）
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
- `birth`：实体诞生（调用 `birthEntity`，`entityType` 默认 `"character"`，`newFacts` 作为初始属性，`summary` 写入实体元信息）
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

**五步过滤**（由 `@pi/world-graph` 的 `character-view.ts` 实现）：
1. 显式可见性（`setVisibility` 设置的）
2. 推断可见性（`inferVisibility` 从 `located_in` 关系推断）
3. 时间过滤（`validFrom <= storyTime < validTo`）
4. 模态过滤（可选，通过 `modalityFilter` 参数）
5. 去重

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

**推断规则**：遍历所有 `located_in` 关系，位于同一 location 的角色互相可见该 location 内的声明。

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

更新实体摘要（作者可见元信息，纯展示字段）。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `entityId` | string | 是 | 实体 ID |
| `summary` | string | 是 | 新摘要 |

**特性**：`summary` 不参与时态/检索/可见性，直接覆盖。旧摘要不保留历史。

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
| `async birthEntity(entityId, type, initialProps, storyTime, summary?): Promise<void>` | 创建实体（`summary` 可选，作者可见元信息） |
| `async killEntity(entityId, storyTime): Promise<void>` | 消亡实体 |
| `async getEntityAt(entityId, storyTime): Promise<EntitySnapshot \| null>` | bi-temporal 查询 |
| `async getAllEntities(storyTime): Promise<EntitySnapshot[]>` | 列出所有有效实体 |
| `async updateEntitySummary(entityId, summary): Promise<void>` | 更新实体摘要（纯展示字段） |
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
| `async processEvent(event: EventRecord): Promise<void>` | 应用事件 |
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

## 6. `Search` 类 API

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

## 7. `Embedder` 类 API

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

---

## 8. 类型定义

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
  summary: string;          // 作者可见元信息（纯展示，不参与检索/时态/可见性）
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
  summary?: string;         // birth 事件用：实体摘要（作者可见元信息）
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

## 9. SDK 检索能力

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

## 10. 可视化服务（Visualizer）

图画布为主的世界图可视化前端：按 storyTime 快照浏览/过滤实体与关系、搜索定位、手动编辑字段（全部走 API，编辑产生 `source: "user"` 事件）、事件链视图、角色视角模式、历史审计。

### 10.1 启动方式（双入口，共用 `src/visualizer/server.ts` 的 `startVisualizer`）

**pi 会话内**：调用 `open_visualizer` 工具（第 19 个注册工具，非 `world_*` 前缀）。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `port` | number | 否 | 端口，默认 7421 |

幂等：已启动时直接返回现有 URL。注入 session 的 `WorldGraph` 与 `Search` 实例；`session_shutdown` 时自动关闭。

**standalone（脱离 pi）**：
```bash
node scripts/visualizer.mjs [--db <dir>] [--port 7421] [--embed]
```
- `--db` 默认 `../novel/.pi/world-graph-v2/`（需含 `world.db` / `events.jsonl`）
- 默认检索为 fulltext；`--embed` 时加载 Embedder 支持 vector/hybrid

### 10.2 HTTP JSON API（`/api` 前缀，统一 envelope）

成功 `{ ok: true, data, error: null }`；失败 `{ ok: false, data: null, error: { code, message } }`。

**查询**：
| Method | Path | 说明 |
|---|---|---|
| GET | `/api/status` | entityCount / eventCount / storyTimes |
| GET | `/api/graph?storyTime=&includeClosed=` | 指定时刻实体+关系快照；`includeClosed=1` 含已闭合关系 |
| GET | `/api/entities/:id?storyTime=` | 单实体快照 |
| GET | `/api/entities/:id/history` | 实体全版本历史（含已闭合 Fact 与关系） |
| GET | `/api/declarations/:declId/visibility?storyTime=` | 该声明的可见性记录（反向查询） |
| GET | `/api/search?q=&storyTime=&type=&mode=` | 检索（standalone 默认 fulltext） |
| GET | `/api/events` / `/api/events/:id/chain` | 事件列表 / 因果链 |
| GET | `/api/character-view?characterId=&storyTime=` | 角色视角可见声明 |

**写入**（全部来自前端，`source` 被服务端强制为 `"user"`）：
| Method | Path | 说明 |
|---|---|---|
| POST | `/api/events` | 应用事件（birth 含 entityType/summary；change = invalidated+newFacts，即"编辑字段"） |
| POST | `/api/entities/:id/summary` | 更新实体摘要 |
| POST | `/api/relations` / `/api/relations/close` | 新建 / 闭合关系 |
| POST | `/api/visibility` / `/api/visibility/close` | 设置 / 撤销可见性 |

错误码：`STORY_TIME_REQUIRED` / `MISSING_FIELD` / `INVALID_BODY` / `VALIDATION_ERROR` / `BUSINESS_ERROR`（400）、`ENTITY_NOT_FOUND` / `NOT_FOUND`（404）、`SEARCH_UNAVAILABLE`（501）、`INTERNAL_ERROR`（500）。

### 10.3 前端（`visualizer-ui/`，无构建、无框架）

LiteGraph.js 画布（vendored 于 `visualizer-ui/vendor/`）：实体卡片节点（四类类型色）、关系自绘边（两点模式新建、右键闭合）、storyTime 快照选择器、类型过滤、搜索高亮、角色视角置灰、五页签详情抽屉（基本/属性/关系/可见性/历史）、事件链 Tab。节点位置存浏览器 localStorage，不污染存储层。

同步：`scripts/sync.mjs` 会将 `visualizer-ui/` 一并复制到扩展目录。

测试：`tests/visualizer-server.test.ts`（14 个集成测试，`npx tsx --test tests/visualizer-server.test.ts`）。

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

**Graph Schema 初始化**：通过 `createStoreWithSchema`（异步 factory），自动建表/初始化 schema/迁移。默认 `systemIndexes: "materialize"`，无需手动调用 `materializeIndexes()` 或 `rebuildFulltext()`。
