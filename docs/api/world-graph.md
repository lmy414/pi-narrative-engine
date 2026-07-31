# `underworld-graph` 包 API

> 属于 [API 文档索引](README.md)。独立 npm 包（v0.1.x，2026-07-31 从 monorepo 解耦，独立 git 仓库 + 独立发布）。源码见 `d:\claude\pi-ex\underworld-graph\`。

## 公共导出面

```typescript
import { WorldGraph } from "underworld-graph";
// 类型
import type { EntitySnapshot, MigrateResult } from "underworld-graph";
// Zod schema（值 + 类型双导出）：EntityType / Modality / EventType / StateDeclaration / EventRecord
import { EntityType, Modality, EventType, StateDeclaration, EventRecord } from "underworld-graph";
import type { EventRecordInput } from "underworld-graph";
```

> 软隔离约定：`_` 前缀导出（`_EventSource` / `_VisibilityDeclaration` / `_INFRA_RELATIONS` / `_WorldGraphOptions` / `_TemporalQueryOpts`）为包内部实现，不保证稳定。

## `WorldGraph` 类

```typescript
// 异步工厂（必须用 create，不能用 new）
const wg = await WorldGraph.create({
  dbPath: "/path/to/world.db",
  eventLogPath: "/path/to/events.jsonl",
});
```

### 静态方法

| 方法 | 说明 |
|------|------|
| `static async create(opts: WorldGraphOptions): Promise<WorldGraph>` | 异步工厂，内部用 `createStoreWithSchema` 初始化 fulltext/vector storage |
| `static async migrate(opts): Promise<MigrateResult>` | 执行 schema 迁移（typegraph `migrateSchema`）；调用方负责先备份 db 文件 |

### 实例方法

**生命周期**：
| 方法 | 说明 |
|------|------|
| `close(): void` | 关闭数据库连接 |

**检索**：
| 方法 | 说明 |
|------|------|
| `get search(): StoreSearch` | SDK 检索 facade（fulltext/vector/hybrid） |
| `query(): QueryBuilder` | SDK 链式图查询入口 |
| `async recordedNow(): Promise<string \| undefined>` | 当前事务时间坐标（2026-07-25 新增；存档后作 `recordedAsOf` 用） |

> **双时态查询（2026-07-25 新增）**：下列查询方法接受可选 `opts?: TemporalQueryOpts`（`{ recordedAsOf?: string }`）。
> 传入后节点状态由 SDK RecordedStoreView 重建到该事务时点，再做故事时间过滤——
> 「storyTime 时刻的世界，但只含 recordedAsOf 之前写入的内容」。不带 opts 行为不变。

**实体**：
| 方法 | 说明 |
|------|------|
| `async birthEntity(entityId, type, initialProps, storyTime, summary?): Promise<void>` | 创建实体（`summary` 可选，实体无状态客观事实描述） |
| `async killEntity(entityId, storyTime): Promise<void>` | 消亡实体 |
| `async getEntityAt(entityId, storyTime, opts?): Promise<EntitySnapshot \| null>` | bi-temporal 查询 |
| `async getAllEntities(storyTime, opts?): Promise<EntitySnapshot[]>` | 列出所有有效实体 |
| `async updateEntitySummary(entityId, summary): Promise<void>` | 更新实体无状态描述（独立字段；参与向量检索限导入管道 embedder 路径，运行时 `Embedder.embedEntity` 不拼接 summary） |
| `async getEntityHistory(entityId): Promise<{entities, facts}>` | 实体全部版本（含已闭合） |
| `async updateEntityEmbedding(entityId, embedding): Promise<void>` | 更新实体向量（2026-07-27 P0-5 配套） |

**关系**：
| 方法 | 说明 |
|------|------|
| `async addRelation(sourceId, targetId, label, storyTime): Promise<void>` | 创建关系 |
| `async closeRelation(sourceId, targetId, label, storyTime): Promise<void>` | 闭合关系 |
| `async getRelations(entityId, storyTime, opts?): Promise<Relation[]>` | 列出实体关系 |
| `async getAllRelationsAt(storyTime, opts?): Promise<Relation[]>` | 列出所有有效关系 |
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
| `async getVisibilityForCharacter(characterId, storyTime, opts?): Promise<VisibilityDeclaration[]>` | 查询角色可见性 |
| `async getVisibilityForDeclaration(declarationId, storyTime?): Promise<VisibilityDeclaration[]>` | 反向查询（某声明被谁知道） |
| `async getAllDeclarationsAt(storyTime, opts?): Promise<StateDeclaration[]>` | 列出所有有效声明 |
| `async getAllDeclarations(opts?): Promise<StateDeclaration[]>` | 全部声明（含已闭合，供知识持续语义使用） |
| `async inferVisibility(storyTime): Promise<void>` | 推断可见性 |
| `async getCharacterView(characterId, storyTime, opts?): Promise<StateDeclaration[]>` | 角色视角（五步过滤；opts 支持 `modalityFilter` 与 `recordedAsOf`） |

**元信息**：
| 方法 | 说明 |
|------|------|
| `async listStoryTimes(): Promise<string[]>` | 列出所有 storyTime（去重升序） |

**嵌入**：
| 方法 | 说明 |
|------|------|
| `async reembedAll(embedder): Promise<void>` | 批量重新嵌入所有 Entity/Fact（embedder 需满足 `{ embedEntity, embedFact }` 接口） |
| `async updateFactEmbedding(declarationId, embedding): Promise<void>` | 增量更新单个 Fact 向量（2026-07-27 P0-5，commit 写扩散后调用） |
