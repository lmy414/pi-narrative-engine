# PI 扩展工具：world_* 工具域（18 个）+ open_visualizer

> 属于 [API 文档索引](README.md)。覆盖 `src/tools/world-tools.ts`（18 个 `world_*`）与 `src/tools/visualizer-tools.ts`（`open_visualizer`）。
> 其余工具域见 [pi-tools-render.md](pi-tools-render.md) / [pi-tools-role-scheduler.md](pi-tools-role-scheduler.md) / [pi-tools-import.md](pi-tools-import.md)。

所有工具通过 `pi.registerTool` 注册，遵循 PI ExtensionAPI 约定：
- `name` — 工具唯一标识（`world_*` 前缀 / `open_visualizer`）
- `label` — 显示标签
- `description` — LLM 可见的工具描述
- `parameters` — TypeBox schema 定义参数
- `async execute(_id, params, _signal, _onUpdate, piCtx)` — 执行体，返回 `{ content: [{type, text}], details }`

## 4.1 状态查询

### `world_status`

获取世界图状态摘要。

**参数**：无

**返回**：
```json
{
  "content": [{ "type": "text", "text": "currentStoryTime: act2-scene1\n统计时刻: act2-scene1\n实体数: 5\n事件数: 3\nrecordedNow: r1:0000000000000007:2026-07-25T16:02:32.048Z" }],
  "details": {
    "status": {
      "currentStoryTime": "act2-scene1",
      "entityCount": 5,
      "eventCount": 3,
      "recordedNow": "r1:0000000000000007:2026-07-25T16:02:32.048Z"
    }
  }
}
```

> `recordedNow`（2026-07-25 新增）：当前事务时间坐标（SDK recorded instant，字典序可比较）。
> 存档后可作为 `recordedAsOf` 传入 `world_entity_get` / `world_character_view` 做双时态检索。空图为 `null`。

> 注（2026-07-25 修复）：`currentStoryTime` 未设置时，统计时刻回退为最新 storyTime
> （此前用 `"Infinity"`，字符串比较 `'I' < 'c'` 会导致全部实体被排除，显示 0）。

## 4.2 实体工具

### `world_entity_create`

创建实体（诞生）。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `entityId` | string | 是 | 实体唯一标识（如 `"macbeth"`） |
| `type` | `"character"` \| `"location"` \| `"item"` \| `"concept"` | 是 | 实体类型 |
| `initialProps` | `Record<string, unknown>` | 否 | 初始属性（每个键值对成为一个 Fact） |
| `storyTime` | string | 是 | 诞生时刻 |

> **注**：本工具不支持设置 `summary`。如需设置实体描述，使用 `world_entity_update_summary`。birth 事件（`world_event_apply` 带 `type: "birth"`）才支持 `summary` 参数。

> **summary 字段语义**：实体的**无状态客观事实描述**（独立数据字段，不进 Fact/属性）。与 Fact 节点的区别——summary 存不变的客观事实（如"林冲，八十万禁军教头，豹头环眼"），Fact 存随事件变化的状态（如 mood/location/health）。参与向量检索（限导入管道的 embedder；运行时 `Embedder.embedEntity` 不拼接 summary）。下游消费约定：角色池注入时建议 summary + 当前 properties 拼接为完整角色描述。

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

### `world_entity_kill`

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

### `world_entity_get`

获取实体快照（bi-temporal 查询：storyTime=故事时间轴，recordedAsOf=事务时间轴）。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `entityId` | string | 是 | 实体 ID |
| `storyTime` | string | 否 | 故事时间（不传用 `currentStoryTime`） |
| `recordedAsOf` | string | 否 | 事务时间坐标（2026-07-25 新增）。传入后只含该时点之前写入的内容——后续改写/补写不可见（retcon 隔离）。坐标取自 `world_status` 的 `recordedNow` |

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

**bi-temporal 查询规则**：返回 `validFrom <= storyTime < validTo` 的 Entity 及其所有匹配的 Fact。`validTo = "Infinity"` 表示未闭合。带 `recordedAsOf` 时，节点状态由 SDK RecordedStoreView 重建到该事务时点（后续被闭合的 `validTo` 恢复为当时的未闭合值），再做故事时间过滤。

### `world_entity_update_summary`

更新实体的无状态客观事实描述（summary）。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `entityId` | string | 是 | 实体 ID |
| `summary` | string | 是 | 新无状态描述 |

**特性**：`summary` 为实体无状态客观事实描述（独立数据字段，不进 Fact）。不参与时态/可见性，直接覆盖，旧描述不保留历史。参与向量检索（限导入管道的 embedder；运行时 `Embedder.embedEntity` 不拼接 summary）。

### `world_entity_history`

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

## 4.3 关系工具

### `world_relation_add`

创建关系。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sourceId` | string | 是 | 源实体 ID |
| `targetId` | string | 是 | 目标实体 ID |
| `label` | string | 是 | 关系标签（如 `"located_in"`、`"friend_of"`） |
| `storyTime` | string | 否 | 不传用 `currentStoryTime` |

**关系 ID 生成规则**：`rel-{sourceId}-{label}-{targetId}-{storyTime}`

### `world_relation_close`

闭合关系（非"删除"）。

**参数**：同 `world_relation_add`

**闭合规则**：找到匹配的未闭合关系（`sourceId` + `targetId` + `label` + `validTo = "Infinity"`），将其 `validTo` 设为 `storyTime`。

### `world_relations`

列出实体在指定时刻的所有关系。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `entityId` | string | 是 | 实体 ID |
| `storyTime` | string | 否 | 不传用 `currentStoryTime` |

**返回**：关系对象数组，包含 `sourceId` 或 `targetId` 等于 `entityId` 的所有未闭合关系。

### `world_relation_history`

查询关系历史（含已闭合）。不传 `entityId` 返回全部关系。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `entityId` | string | 否 | 过滤条件（作为 source 或 target），不传返回全部 |

**返回**：关系对象数组，含 `relationId`/`sourceId`/`targetId`/`label`/`validFrom`/`validTo`，按 `validFrom` 升序。

## 4.4 事件工具

### `world_event_apply`

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
    userInput?: string,                                 // 用户口述原文（2026-07-25 新增，供项目记忆展示）
    recordedAt?: string,                                // 写入墙钟时间（缺省自动填充当前时间）
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
- 更新项目记忆 `.pi/world-graph-v3/memory.md`（2026-07-25 新增）

### `world_event_chain`

获取事件链。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `eventId` | string | 否 | 起始事件 ID（不传返回全部） |

**行为**：
- 传 `eventId`：从该事件开始沿 `causedBy` 链式回溯，返回因果链
- 不传：返回所有事件，按 `storyTime` 升序排序

## 4.5 可见性工具

### `world_character_view`

获取角色视角（五步过滤后的可见声明）。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `characterId` | string | 是 | 角色 ID |
| `storyTime` | string | 否 | 不传用 `currentStoryTime` |
| `recordedAsOf` | string | 否 | 事务时间坐标（2026-07-25 新增）：视角只含该时点之前写入的声明与可见性记录 |

**返回**：`StateDeclaration[]` — 该角色在 `storyTime` 时刻可见的所有声明。

**五步过滤**（由 `underworld-graph` 的 `character-view.ts` 实现，2026-07-22 语义修订：知识持续）：
1. 候选声明：全部 StateDeclaration（含已闭合——知识持续语义：知识不因声明闭合/实体死亡而消失）
2. 可见性记录：`setVisibility` 显式设置 + `inferVisibility` 从 `located_in` 推断写入的记录；需覆盖 storyTime（`validFrom <= storyTime < validTo`）且 `state === "known"`
3. 有效起点 = `max(visibility.validFrom, declaration.validFrom)`，需 `<= storyTime`（不能先于声明存在而知晓）
4. 有效终点只看可见性的 `validTo`（不再与 `declaration.validTo` 取交）——知识一旦获得就持续持有，直到可见性被显式撤销（`world_visibility_close`）
5. 模态过滤（可选，`modalityFilter`）：**仅包级 API `getCharacterView(characterId, storyTime, opts)` 支持，PI 工具 `world_character_view` 不暴露此参数**；代码无去重步骤

### `world_visibility_set`

显式设置角色对某声明的可见性。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `characterId` | string | 是 | 角色 ID |
| `declarationId` | string | 是 | 声明 ID（StateDeclaration 的 `declarationId`） |
| `confidence` | number | 是 | 置信度 0-1 |
| `source` | `"experienced" \| "informed" \| "witnessed"` | 是 | 可见性来源（自产自知=experienced / 他盲修复=informed / 基础设施推断=witnessed） |
| `isExplicit` | boolean | 是 | 是否显式设置 |
| `storyTime` | string | 否 | 不传用 `currentStoryTime` |

**可见性 ID 生成规则**：`vis-{characterId}-{declarationId}-{validFrom}`

### `world_visibility_infer`

从 `located_in` 关系推断所有角色的可见性。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `storyTime` | string | 否 | 不传用 `currentStoryTime` |

**推断规则**：遍历 storyTime 时刻所有 `located_in` 关系，对每条关系，把 target（location）实体在该时刻的所有有效声明标记为 source 角色可见（单向推断，非互相可见；`validFrom` 取角色进入时间与声明时间中较晚者）。

### `world_visibility_close`

闭合可见性声明：撤销某角色对某声明的可见性。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `characterId` | string | 是 | 角色 ID |
| `declarationId` | string | 是 | 声明 ID |
| `storyTime` | string | 否 | 不传用 `currentStoryTime`（作为 `validTo` 闭合） |

**闭合规则**：找到匹配的未闭合 Visibility 记录（`characterId` + `declarationId` + `validTo = "Infinity"`），将其 `validTo` 设为 `storyTime`。找不到则抛错。

## 4.6 检索工具

### `world_query`

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

## 4.7 历史与元信息工具

### `world_story_times`

列出所有出现过的 storyTime（去重升序）。

**参数**：无

**返回**：字符串数组，如 `["ch-1", "ch-2", "ch-3"]`。

**聚合来源**：events.jsonl + Entity/Fact/Relation/Visibility 的 `validFrom`/`validTo`，排除 `"Infinity"`。

**用途**：前端顶部 storyTime 快照选择器的下拉数据源。

## 4.8 可视化工具

### `open_visualizer`

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
- 注入 session 的 `WorldGraph` 与 `Search` 实例（含 Embedder，支持 vector/hybrid 检索）
- `session_shutdown` 时自动关闭
- 已启动时直接返回现有 URL（`alreadyRunning: true`）
- 未注入 debugBus 时前端 `/api/debug/*` 返回 503

**详见**：[visualizer.md](visualizer.md)
