# 数据层 Ports 接线可行性调研（阶段 A）

> 日期：2026-08-01
> 状态：可行性调研（结论：✅ 可行）
> 定位：为"编排器闭环（数据层 Ports 接线）"提供决策依据与实施蓝图
> 决策来源：用户已确认落地方向 A（2026-08-01）
> 关联：
> - `docs/plans/2026-07-31-orchestrator-standalone-research.md`（编排器独立化调研，§5.6 已设计 6 个 Ports）
> - `docs/plans/2026-08-01-orchestrator-standalone-implementation-report.md`（阶段 0/1 实现报告）
> - `docs/plans/2026-07-31-subagent-orchestrator-design.md`（子代理编排器设计）
> - `docs/plans/2026-07-31-tool-allocation-design.md`（工具分配方案）

## 一、调研目标

**阶段 A（用户已决策落地）**：数据层 Ports 接线——把编排器从"只产出不落地"变为"闭环可用"：

1. **6 个 Ports 接口落地**（WorldGraphPort / EmbedderPort / RulesetPort / MemoryPort / RendererPort / RolePoolPort）
2. **默认适配器实现**（薄包装，对接现有 underworld-graph / Embedder / 规则集 / memory / @pi/renderer / @pi/role-pool）
3. **commit 真正落地**（写世界图 + 渲染章节文件）
4. **子代理接入世界图检索/写入工具**（planner 只读 / 角色受限 / 可见推理写入）
5. **queue_status 暴露结果内容**（编排结果可查询）

本调研回答：**这些接线在技术上是否可行？各数据层模块的真实接口是什么？Ports 定义需要怎么修正？实施路径怎么拆？**

## 二、现状查证（基于源码，非脑补）

### 2.1 编排器阶段 0/1 现状（已实现）

| 模块 | 状态 | 文件 |
|---|---|---|
| 4 类子代理工厂 | ✅ 完成 | [src/agents/](file:///d:/claude/pi-ex/narrative-engine/src/agents/planner-agent.ts) |
| 4 个产出提交工具 | ✅ 完成（terminate: true + sequential） | [src/agents/tools.ts](file:///d:/claude/pi-ex/narrative-engine/src/agents/tools.ts) |
| 产出收集 | ✅ 完成（tool_execution_end 事件） | [src/agents/collect.ts](file:///d:/claude/pi-ex/narrative-engine/src/agents/collect.ts) |
| EventQueue + Orchestrator | ✅ 完成（plan/yolo 双模式） | [src/orchestrator.ts](file:///d:/claude/pi-ex/narrative-engine/src/orchestrator.ts) |
| OrchestratorService | ✅ 完成（commit/discard 占位） | [src/orchestrator/service.ts](file:///d:/claude/pi-ex/narrative-engine/src/orchestrator/service.ts) |
| MCP stdio 包装 | ✅ 完成（4 个调度工具） | [src/orchestrator/mcp-server.ts](file:///d:/claude/pi-ex/narrative-engine/src/orchestrator/mcp-server.ts) |
| LLM 配置中心 | ✅ 完成（LlmConfigStore，每 slot 独立） | [src/orchestrator/llm-config.ts](file:///d:/claude/pi-ex/narrative-engine/src/orchestrator/llm-config.ts) |

**阶段 A 前的问题**（报告 §七 已知限制）：
- `scheduler_commit` / `scheduler_discard` 为占位（未接数据层）
- 子代理无 world_* 工具，不写世界图、不写章节
- queue_status 只返回状态，不含编排结果内容
- 编排器产出（diffusion/render）在内存中产生后即丢弃，未持久化

### 2.2 数据层各模块的真实 API（查证结果）

#### 2.2.1 underworld-graph（WorldGraph 类）

[world-graph.ts](file:///d:/claude/pi-ex/narrative-engine/node_modules/underworld-graph/src/world-graph.ts) 真实方法（与 Ports 定义对照）：

| WorldGraph 方法 | 签名（查证） | 用途 |
|---|---|---|
| `getEntityAt` | `(entityId, storyTime, opts?) => Promise<EntitySnapshot \| null>` | 实体快照 |
| `getCharacterView` | `(characterId, storyTime, opts?) => Promise<StateDeclaration[]>` | 角色可见状态 |
| `getRelations` | `(entityId, storyTime, opts?) => Promise<RelationSnapshot[]>` | 关系列表 |
| `getAllDeclarationsAt` | `(storyTime, opts?) => Promise<StateDeclaration[]>` | 全部声明（可见性映射候选） |
| `processEvent` | `(input: EventRecordInput) => Promise<void>` | 写事件（change/行动） |
| `addRelation` | `(sourceId, targetId, label, storyTime) => Promise<void>` | 加关系 |
| `setVisibility` | `(characterId, declarationId, opts) => Promise<void>` | 写可见性 |
| `updateFactEmbedding` | `(declarationId, embedding) => Promise<void>` | 更新 Fact 向量 |
| `recordedNow` | `() => Promise<string \| undefined>` | 事务时间 |
| `search` | `StoreSearch`（fulltext/vector/hybrid） | 三级检索 |
| `getAllEvents` | `() => Promise<EventRecord[]>` | 全部事件 |
| `listStoryTimes` | `() => Promise<string[]>` | 时间点列表 |

**关键发现**：
- `processEvent` 返回 `Promise<void>`（不是 EventRecord）——Ports 定义需修正
- `getCharacterView` 返回 `StateDeclaration[]`（不是 FactSnapshot[]）——Ports 定义需修正为结构化类型
- `search` 是 `StoreSearch`（@nicia-ai/typegraph），不是直接方法——Ports 的 `query()` 需包装 Search 类（[src/search.ts](file:///d:/claude/pi-ex/narrative-engine/src/search.ts)）

#### 2.2.2 Search 类（src/search.ts，现有包装）

```typescript
export class Search {
  constructor(wg: WorldGraph, embedder: Embedder) {}
  async search(query, opts?: { topK?, typeFilter?, storyTime?, mode? }): Promise<EntitySearchResult[]>
  async fulltext(query, opts?): Promise<EntitySearchResult[]>   // 需 storyTime
  async vector(query, opts?): Promise<EntitySearchResult[]>     // 需 storyTime
  async hybrid(query, opts?): Promise<EntitySearchResult[]>     // 需 storyTime
}
```

**关键发现**：`Search` 已是 wg + embedder 的薄包装，返回 `EntitySearchResult[]`（含 snapshot）。Ports 的检索可**直接复用 Search 类**（或包装为 SearchPort）。

#### 2.2.3 @pi/renderer（渲染器子包）

[renderer.ts](file:///d:/claude/pi-ex/narrative-engine/packages/renderer/src/renderer.ts) + [chapter-io.ts](file:///d:/claude/pi-ex/narrative-engine/packages/renderer/src/chapter-io.ts)：

| 函数 | 签名 | 用途 |
|---|---|---|
| `renderText` | `(cmd: RenderTextCommand, ctx: RenderCtx) => Promise<string>` | 生成文本（不写文件） |
| `renderToFile` | `(cmd: RenderFileCommand, ctx: RenderCtx) => Promise<RenderResult>` | 生成并写文件（append/modify） |
| `ensureChapterFile` | `(chapterPath) => Promise<void>` | 确保章节文件存在 |
| `readChapter` | `(chapterPath) => Promise<string>` | 读章节全文 |
| `appendToChapter` | `(chapterPath, eventId, text) => Promise<void>` | 追加锚点+文本 |
| `modifyChapterSection` | `(chapterPath, anchorEventId, newText) => Promise<void>` | 重写锚点区间 |
| `readChapterSection` | `(chapterPath, start?, end?) => Promise<string>` | 读锚点区间 |

**关键发现**：`renderToFile` 已内置锚点写入（append/modify 模式），Ports 的 RendererPort 应直接暴露 `renderToFile` + `readChapter`（渲染器代理需要读章节衔接上下文）。

#### 2.2.4 @pi/role-pool（角色池子包）

`interact(cmd: InteractCommand, deps: { llm, ruleSet }, hooks?) => Promise<InteractResult>`

**关键发现**：role-pool 的 `interact` 是批处理入口（单次 LLM 调用组角色），与角色子代理（每个角色一个 Agent）**不冲突**——角色子代理落地后，RolePoolPort 的默认适配器可以"暂未使用"（角色由编排器直接驱动 Agent），Ports 保留接口供未来或降级。

#### 2.2.5 规则集 / memory / Embedder

| 模块 | 函数 | 签名 |
|---|---|---|
| 规则集 | `loadPlannerRuleSet` / `loadRoleRuleSet` / `loadRuleSet` | `(cwd) => Promise<string>` |
| memory | `loadMemory` / `updateMemory` | `(cwd) => Promise<string>` / `(wg, cwd) => Promise<void>` |
| Embedder | `embed` / `embedEntity` / `embedFact` | `(text) => Promise<number[]>` 等 |

## 三、可行性结论

**✅ 可行。数据层 Ports 接线技术上完全成立，且工作量集中在"薄适配器 + commit 逻辑重组"，无架构性障碍。**

依据：

1. **Ports 接口定义已存在**（[调研 §5.6.1](file:///d:/claude/pi-ex/narrative-engine/docs/plans/2026-07-31-orchestrator-standalone-research.md)），只需对照真实 API 修正类型
2. **全部数据层模块零 PI 依赖**（已查证）：underworld-graph / Search / @pi/renderer / @pi/role-pool / 规则集 / memory / Embedder
3. **commit 逻辑已有现成实现**（[packages/scheduler/src/commit.ts](file:///d:/claude/pi-ex/narrative-engine/packages/scheduler/src/commit.ts) 8 步流程）——阶段 A 是"把 commit 的逻辑接到 Ports 上"，不是重写
4. **检索执行已有现成实现**（[packages/scheduler/src/retrieve.ts](file:///d:/claude/pi-ex/narrative-engine/packages/scheduler/src/retrieve.ts) `executeRetrievalItem`）——可复用为 SearchPort 适配器
5. **角色代理受限工具**：工具分配方案 §5.2 已定义 4 个受限变体，实现依赖 Search 类（可见性过滤需查证）
6. **渲染写入已有现成实现**（@pi/renderer 的 renderToFile / appendToChapter）

## 四、Ports 接口定义（修正版）

对照真实 API 修正 [调研 §5.6.1](file:///d:/claude/pi-ex/narrative-engine/docs/plans/2026-07-31-orchestrator-standalone-research.md) 的 Ports 定义：

```typescript
// src/ports/types.ts（阶段 A 修正版，基于真实 API）

/** 世界图端口：实体/关系/事件/可见性读写抽象（修正：processEvent 返回 void） */
export interface WorldGraphPort {
  // 读取
  getEntityAt(entityId: string, storyTime: string, opts?: { recordedAsOf?: string }): Promise<EntitySnapshot | null>;
  getCharacterView(characterId: string, storyTime: string, opts?: {
    modalityFilter?: ("fact" | "belief" | "hypothesis")[];
    recordedAsOf?: string;
  }): Promise<StateDeclaration[]>;
  getRelations(entityId: string, storyTime: string, opts?: { recordedAsOf?: string }): Promise<RelationSnapshot[]>;
  getAllDeclarationsAt(storyTime: string): Promise<StateDeclaration[]>;
  // 写入
  processEvent(event: EventRecordInput): Promise<void>;   // ← 修正：真实返回 void
  addRelation(sourceId: string, targetId: string, label: string, storyTime: string): Promise<void>;
  setVisibility(characterId: string, declarationId: string, opts: {
    state: "known";
    confidence: number;
    source: "experienced" | "informed" | "witnessed";
    validFrom: string;
    isExplicit: boolean;
  }): Promise<void>;
  // 检索（复用 Search 类能力）
  search(query: string, opts?: {
    topK?: number;
    typeFilter?: EntityType;
    storyTime?: string;
    mode?: "fulltext" | "vector" | "hybrid";
  }): Promise<EntitySearchResult[]>;
  // 嵌入（可选，无向量引擎时降级）
  updateFactEmbedding?(declarationId: string, vec: number[]): Promise<void>;
  updateEntityEmbedding?(entityId: string, vec: number[]): Promise<void>;
}

/** 检索端口：独立检索抽象（可替换为远程检索服务） */
export interface SearchPort {
  search(query: string, opts?: { topK?: number; storyTime?: string; mode?: "fulltext" | "vector" | "hybrid" }): Promise<EntitySearchResult[]>;
}

/** 嵌入端口（修正：embed 是文本接口，embedEntity/embedFact 是结构化接口） */
export interface EmbedderPort {
  embed(text: string): Promise<number[]>;
  embedEntity(snapshot: EntitySnapshot): Promise<number[]>;
  embedFact(decl: StateDeclaration): Promise<number[]>;
}

/** 规则集端口 */
export interface RulesetPort {
  loadPlanner(cwd: string): Promise<string>;
  loadRole(cwd: string): Promise<string>;
  loadRender(cwd: string): Promise<string>;
}

/** 项目记忆端口 */
export interface MemoryPort {
  load(cwd: string): Promise<string>;
  update(wg: WorldGraphPort, cwd: string): Promise<void>;
}

/** 渲染器端口（修正：renderToFile 返回 RenderResult，含锚点写入） */
export interface RendererPort {
  readChapter(chapterPath: string): Promise<string>;
  readChapterSection(chapterPath: string, start?: string, end?: string): Promise<string>;
  renderToFile(cmd: RenderFileCommand, deps: { llm: RenderLlmCaller; ruleSet: string }): Promise<RenderResult>;
  renderText(cmd: RenderTextCommand, deps: { llm: RenderLlmCaller; ruleSet: string }): Promise<string>;
}

/** 角色池端口（角色子代理落地后默认适配器可空实现，接口保留） */
export interface RolePoolPort {
  interact(cmd: InteractCommand, deps: { llm: RoleLlmCaller; ruleSet: string }): Promise<InteractResult>;
}
```

**与 [调研 §5.6.1](file:///d:/claude/pi-ex/narrative-engine/docs/plans/2026-07-31-orchestrator-standalone-research.md) 的差异（修正点）**：

| # | 调研原定义 | 修正后 | 依据 |
|---|---|---|---|
| 1 | `WorldGraphPort.processEvent → Promise<EventRecord>` | `→ Promise<void>` | underworld-graph 真实签名 |
| 2 | `getCharacterView → Promise<FactSnapshot[]>` | `→ Promise<StateDeclaration[]>` | underworld-graph 真实签名 |
| 3 | `query(opts) → SearchResult[]` | `search(query, opts) → EntitySearchResult[]` | 对齐现有 [Search 类](file:///d:/claude/pi-ex/narrative-engine/src/search.ts) |
| 4 | 无 SearchPort | 新增 SearchPort（独立检索抽象） | 检索可独立替换 |
| 5 | `EmbedderPort.embedEntity/embedFact` | 新增 `embed(text)` | Search 类依赖 embed（query → 向量） |
| 6 | `RendererPort.readChapter/renderToFile` | 新增 `readChapterSection` | 渲染器代理读锚点区间 |
| 7 | `MemoryPort.update(wg, cwd)` | 保持 | memory.ts 真实签名一致 |

## 五、默认适配器设计

### 5.1 适配器清单

| Port | 默认适配器 | 实现（薄包装，10-30 行） |
|---|---|---|
| `WorldGraphPort` | `createWorldGraphAdapter(wg: WorldGraph)` | 直接映射 wg 方法，search 走 Search 类 |
| `SearchPort` | `createSearchAdapter(search: Search)` | 直接映射 Search 类 |
| `EmbedderPort` | `createEmbedderAdapter(emb: Embedder)` | 映射 embed/embedEntity/embedFact |
| `RulesetPort` | `createFileRulesetAdapter()` | 包装 3 个 loadXxxRuleSet |
| `MemoryPort` | `createMemoryAdapter()` | 包装 loadMemory/updateMemory |
| `RendererPort` | `createRendererAdapter()` | 包装 renderToFile/renderText/readChapter/readChapterSection |
| `RolePoolPort` | `createRolePoolAdapter()` | 包装 interact（本阶段可选） |

### 5.2 装配

```typescript
// src/orchestrator/assembly.ts（阶段 A）
import { createWorldGraphAdapter, createSearchAdapter, createEmbedderAdapter,
  createFileRulesetAdapter, createMemoryAdapter, createRendererAdapter } from "../ports/adapters.ts";

export interface OrchestratorPorts {
  worldGraph: WorldGraphPort;
  search: SearchPort;
  embedder: EmbedderPort;
  ruleset: RulesetPort;
  memory: MemoryPort;
  renderer: RendererPort;
}

export function assemblePorts(deps: {
  wg: WorldGraph;
  search: Search;
  embedder: Embedder;
  cwd: string;
}): OrchestratorPorts {
  return {
    worldGraph: createWorldGraphAdapter(deps.wg),
    search: createSearchAdapter(deps.search),
    embedder: createEmbedderAdapter(deps.embedder),
    ruleset: createFileRulesetAdapter(),
    memory: createMemoryAdapter(),
    renderer: createRendererAdapter(),
  };
}
```

## 六、commit 落地方案

### 6.1 现状 vs 目标

| 步骤 | 现状（阶段 0/1） | 目标（阶段 A） |
|---|---|---|
| 1. 取 plan | service.ts 占位 | plans 缓存（复用 @pi/scheduler 的 cache 或迁入 service） |
| 2. 提取 state_changes | — | 复用 `extractStateChanges`（@pi/role-pool） |
| 3. 按 entityId 分组 | — | 复用 `groupBy` |
| 4. 写扩散 | 不写 | `worldGraph.processEvent` + `updateFactEmbedding` |
| 4.3 自产自知 | 不写 | `worldGraph.setVisibility`（复用 commit.ts 逻辑） |
| 4.4 knowledge_gained | — | knowledge-mapper 并入可见推理代理（[子代理设计 §3.4](file:///d:/claude/pi-ex/narrative-engine/docs/plans/2026-07-31-subagent-orchestrator-design.md)） |
| 5. relation_update | 不写 | `worldGraph.addRelation` |
| 6. 投影 RoleOutput | — | 复用 `toRoleOutputs` |
| 7. 写章节 | 不写 | `renderer.renderToFile`（add/modify）/ `renderText` + `appendToChapter`（insert） |

### 6.2 关键实现要点

```typescript
// src/orchestrator/commit.ts（阶段 A 新增）
export async function commitPlan(
  planId: string,
  ports: OrchestratorPorts,
  deps: { renderLlm: RenderLlmCaller; renderRuleSet: string },
): Promise<CommitResult> {
  const plan = plansCache.get(planId);
  if (!plan) return { ok: false, error: `plan ${planId} not found` };

  const { event, outputs, diffusion } = plan;
  const appliedEventIds: string[] = [];
  const failedEntityIds: string[] = [];

  // 1. 写扩散：diffusion.changes → processEvent（复用 commit.ts 步骤 4 的逻辑，改走 Ports）
  for (const change of diffusion.changes) {
    const subEventId = `evt_${Date.now()}_${randomId(6)}`;
    await ports.worldGraph.processEvent({
      eventId: subEventId,
      type: "change",
      storyTime: event.storyTime,
      entityId: change.entityId,
      source: "engine",
      invalidated: await findInvalidated(ports.worldGraph, change, event.storyTime),
      newFacts: [{ entityId: change.entityId, property: change.property, value: change.value, modality: change.modality }],
    });
    appliedEventIds.push(subEventId);
  }

  // 2. 可见性：diffusion.visibilityChanges → setVisibility（自产自知 + 他盲）
  for (const vc of diffusion.visibilityChanges ?? []) {
    await ports.worldGraph.setVisibility(vc.characterId, vc.declarationId, {
      state: "known",
      confidence: vc.confidence,
      source: vc.source,
      validFrom: event.storyTime,
      isExplicit: true,
    });
  }

  // 3. 关系：outputs.relation_update → addRelation
  for (const out of outputs) {
    for (const rel of out.relation_update ?? []) {
      await ports.worldGraph.addRelation(out.characterId, rel.target, rel.label, event.storyTime);
    }
  }

  // 4. 渲染：render.text → renderer（add/modify/insert 分支，复用 commit.ts 步骤 7）
  const renderResult = await renderChapter(ports.renderer, event, chapterPath, eventId, outputs, deps);

  // 5. 更新记忆
  await ports.memory.update(ports.worldGraph, cwd);

  plansCache.delete(planId);
  return { ok: failedEntityIds.length === 0 && renderResult.ok, appliedEventIds, ... };
}
```

**要点**：
- commit 逻辑从 [commit.ts](file:///d:/claude/pi-ex/narrative-engine/packages/scheduler/src/commit.ts) **平移**到 Ports 上，业务逻辑零重写
- `diffusion`（可见推理代理产出）替代原 commit.ts 的 state_changes 提取——可见推理代理已在阶段 0/1 产出
- knowledge-mapper 职责并入可见推理代理后，4.4 步不再单独调 LLM

## 七、子代理世界图工具注入

### 7.1 工具清单（后续注入）

按[工具分配方案 §五](file:///d:/claude/pi-ex/narrative-engine/docs/plans/2026-07-31-tool-allocation-design.md)：

| 子代理 | 注入工具（AgentTool，闭包注入 ports） | 数量 |
|---|---|---|
| planner | `world_entity_get` / `world_relations` / `world_character_view` / `world_query` / `world_status` / `world_story_times` / `world_event_chain` | 7 |
| 角色代理（受限变体） | `character_view_limited` / `entity_get_limited` / `relations_limited` / `query_limited` | 4 |
| 可见推理 | `world_entity_get` / `world_relations` / `world_event_chain` / `world_event_apply` / `world_visibility_set` / `world_visibility_close` / `world_visibility_infer` / `world_relation_add` / `world_relation_close` | 9 |

### 7.2 工具实现要点

```typescript
// src/agents/world-tools.ts（阶段 A 新增）
export function createEntityGetTool(ports: OrchestratorPorts): AgentTool {
  return {
    name: "world_entity_get",
    label: "World Entity Get",
    description: "获取实体快照（含属性）",
    parameters: Type.Object({
      entityId: Type.String(),
      storyTime: Type.Optional(Type.String()),
    }),
    executionMode: "sequential",
    async execute(_id, params) {
      const snap = await ports.worldGraph.getEntityAt(params.entityId, params.storyTime);
      return { content: [{ type: "text", text: snap ? JSON.stringify(snap) : "未找到" }], details: { snapshot: snap } };
    },
  };
}

// 角色受限变体：characterId 绑定 + 可见性过滤（需查证 Search 类是否支持）
export function createLimitedCharacterViewTool(ports: OrchestratorPorts, characterId: string): AgentTool {
  return {
    name: "character_view_limited",
    description: `查询你（${characterId}）当前可见的世界状态`,
    parameters: Type.Object({ storyTime: Type.Optional(Type.String()) }),
    executionMode: "sequential",
    async execute(_id, params) {
      const decls = await ports.worldGraph.getCharacterView(characterId, params.storyTime ?? "");
      return { content: [{ type: "text", text: JSON.stringify(decls) }], details: { decls } };
    },
  };
}
```

**存疑**：`query_limited`（检索受限变体）需要 Search 类支持 characterId/visibility 过滤——[调研 §七 #9](file:///d:/claude/pi-ex/narrative-engine/docs/plans/2026-07-31-orchestrator-standalone-research.md) 已列。查证 Search 类源码（已读）：`Search.search` 无 characterId/visibility 参数 → 受限检索需"先检索后过滤"（getCharacterView 结合），有信息泄漏风险。**建议本阶段 query_limited 用"检索后按 getCharacterView 交集过滤"**，泄露风险接受（后续优化）。

### 7.3 与产出提交工具的关系

- 产出提交工具（retrieval_plan / character_action / diffusion_result / render_result）：**保留**，仍是子代理的出口
- 世界图工具：**新增注入**，是子代理的入口（自主查世界图）
- 两者共存：子代理先查（世界图工具）→ 推理 → 提交（产出工具 terminate）

## 八、实施路径建议（分步迭代）

### 步骤 A1：Ports 类型落地 + 适配器

- 新建 `src/ports/types.ts`（修正版定义）+ `src/ports/adapters.ts`（6-7 个薄适配器）
- 验证：单测断言适配器映射正确（mock wg/search/embedder）
- **验收**：Ports 类型可编译，适配器单测通过

### 步骤 A2：commit 落地（写世界图 + 渲染）

- 新建 `src/orchestrator/commit.ts`（从 [packages/scheduler/src/commit.ts](file:///d:/claude/pi-ex/narrative-engine/packages/scheduler/src/commit.ts) 平移逻辑到 Ports）
- service.ts 的 `commit()` 从占位改为真实现
- plans 缓存迁入 service（复用 @pi/scheduler cache 或重写）
- **验收**：MCP 调 dispatch（yolo）→ 世界图出现 change 事件 + 章节文件出现正文

### 步骤 A3：queue_status 暴露结果内容

- `QueueStatusResult` 增加 `result?: OrchestratorResult`（含 outputs/diffusion/render）
- **验收**：MCP 轮询 queue_status 能拿到完整编排结果

### 步骤 A4：子代理世界图工具注入

- 新建 `src/agents/world-tools.ts`（7+4+9 个 AgentTool）
- planner / 角色 / 可见推理工厂增加工具注入参数
- 角色受限变体实现（characterId 绑定；query_limited 先检索后过滤）
- **验收**：子代理能自主查世界图后再产出（e2e 验证 planner 查实况）

### 步骤 A5（配套）：LlmConfigStore 持久化 + 配置入口

- slot 模型配置写配置文件（`<cwd>/.pi/llm-config.json`）+ MCP 参数注入
- 每 slot 独立模型的读取入口（当前只能代码 setConfig）
- **验收**：配置文件驱动 4 个 slot 各自模型

## 九、风险与存疑

| # | 存疑点 | 影响 | 验证方式 |
|---|---|---|---|
| 1 | **commit 平移的复杂度**：原 commit.ts 8 步流程含大量容错（failedEntityIds / failedRelations），平移时逻辑是否等价 | 高——业务正确性 | 对照 commit.ts 逐步骤核对，保留全部容错分支 |
| 2 | **可见推理产出与 commit 输入对齐**：diffusion.changes 结构与 commit 需要的 StateChange[] 是否一致 | 高——数据契约 | 对照 diffusionResultSchema 与 StateChange 结构（已兼容：entityId/property/value/modality） |
| 3 | **query_limited 可见性过滤**：Search 类无 characterId 参数，受限检索需"先检索后过滤"，信息泄漏风险 | 中 | 本阶段接受"检索后过滤"，后续优化 |
| 4 | **嵌入更新路径**：commit 写扩散后 updateFactEmbedding 依赖 embedder，无向量引擎时降级 | 低 | 复用 commit.ts 现有 try/catch 容错 |
| 5 | **plans 缓存归属**：迁入 service 层后，与 @pi/scheduler 内部 cache 是否冲突 | 中 | 明确单一持有者（service 层） |
| 6 | **渲染 insert 模式**：@pi/renderer 无 insert 模式，需 scheduler 内嵌 insertChapterSection | 低 | 复用 commit.ts 步骤 7 现有实现 |
| 7 | **LlmConfigStore 持久化**：配置文件格式、注入时序（MCP 参数 vs 文件） | 低 | 参考 config-ui-design 文档 |

## 十、与既有设计的关系

| 维度 | 本调研 | 编排器独立化调研 | 子代理编排器设计 | 工具分配方案 |
|---|---|---|---|---|
| 关注点 | 数据层 Ports 接线 + commit 落地 | 编排器能否独立运行 | 编排器内部如何编排子代理 | 工具按子代理归属 |
| 状态 | 本阶段实施蓝图 | 已完成（阶段 0/1） | 设计确认 | 参考级 |
| 关系 | 落实 §5.6 的 Ports 设计 | 阶段 A 是阶段 0/1 的续 | 可见推理代理产出供 commit 消费 | 世界图工具注入清单 |

## 十一、决策溯源

1. 用户决策：落地方向 A（数据层 Ports 接线），撰写可行性调研
2. 查证 underworld-graph WorldGraph 真实 API：确认 processEvent 返回 void、getCharacterView 返回 StateDeclaration[]
3. 查证 Search 类：确认是 wg+embedder 薄包装，可复用为 SearchPort
4. 查证 @pi/renderer：确认 renderToFile 内置锚点写入，readChapterSection 供渲染器代理读上下文
5. 查证 @pi/role-pool：确认 interact 批处理与角色子代理不冲突，Ports 接口保留
6. 对照 [commit.ts](file:///d:/claude/pi-ex/narrative-engine/packages/scheduler/src/commit.ts) 8 步流程：确认 commit 落地是"逻辑平移 + Ports 化"，非重写
7. 对照 [retrieve.ts](file:///d:/claude/pi-ex/narrative-engine/packages/scheduler/src/retrieve.ts)：确认检索执行可复用为 SearchPort 适配器
8. 结论：✅ 可行。实施 = Ports 类型 + 适配器 + commit 平移 + 工具注入 + 结果暴露 + 配置持久化
