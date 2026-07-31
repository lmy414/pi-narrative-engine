# 类型定义

> 属于 [API 文档索引](README.md)。以下类型由 `underworld-graph` 包导出（Zod schema，值 + 类型双导出；`EventRecordInput` 为纯类型）。`VisibilityDeclaration` 为 `_` 前缀内部导出（软隔离）。

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
  userInput?: string;       // 用户口述原文（2026-07-25 新增；主会话透传，供项目记忆 memory.md 展示）
  recordedAt?: string;      // 写入墙钟时间（2026-07-25 新增；processEvent 自动填充，事务时间轴审计用）
}
```

### `EventRecordInput`

```typescript
// z.input<typeof EventRecord> 推导：source 可选（parse 时默认 "engine"），其余字段同 EventRecord
type EventRecordInput = Omit<EventRecord, "source"> & { source?: EventSource };
```

`EventLog.append` 与 `WorldGraph.processEvent` 入口均接受 `EventRecordInput`，内部 `EventRecord.parse(input)` 应用默认值（`source` 缺省 `"engine"`），事件日志中始终落完整 `EventRecord`。

### `VisibilityDeclaration`（`_` 前缀内部导出）

```typescript
interface VisibilityDeclaration {
  characterId: string;
  declarationId: string;
  state: "known";           // 当前只支持 "known"
  confidence: number;       // 0-1
  source: VisibilitySource; // "experienced" | "informed" | "witnessed"（2026-07-29 从 z.string() 改为枚举，旧数据保留原样不迁移）
  validFrom: string;
  validTo: string;          // 默认 "Infinity"
  isExplicit: boolean;
}
```
