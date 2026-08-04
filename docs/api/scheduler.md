# `@pi/scheduler` 包 API

> 属于 [API 文档索引](README.md)。调度器子包（workspace 子包，`private: true`）：编排层（不演戏、不渲染、纯串联）。源码 `packages/scheduler/src/`。

## 公共导出面（软隔离后）

```typescript
// 编排
export { plan, commit } from "./plan.ts";  // plan.ts / commit.ts
export { discard, loadAllPlans } from "./cache.ts";

// 默认 staticCard 加载器
export { defaultStaticCardLoader } from "./static-card-loader.ts";

// knowledge mapper 提示词模板（扩展层 knowledge-mapper-llm 引用）
export { buildKnowledgeMapperSystemPrompt, buildKnowledgeMapperUserMessage } from "./prompts.ts";

// 类型
export type {
  StructuredEvent,
  RetrievalPlan,
  RetrievalItem,
  PlannerLlmCaller,
  KnowledgeMapperLlmCaller,
  SchedulerCtx,
  SillyTavernCard,
} from "./types.ts";
export type { DebugBus } from "./debug.ts";
```

> 软隔离：`_resolveChapterPath` / `_executeRetrievalItem` / `_getPlan` / `_PlanResult` / `_CommitResult` / `_FactSnapshot` / `_startSpan` / `_newTraceId` 等为内部导出（`_` 前缀）。

## `plan(event: StructuredEvent, ctx: SchedulerCtx)` 10 步

1. 生成 eventId/planId → 2. 解析章节路径 → 3. planner LLM 推导 RetrievalPlan →
4. 兜底：每角色至少 1 条 character_view → 5. 逐项执行检索（按 assignTo 信息差分配，label 随 Fact 传递）→
5.5 解析动态层属主名（ownerName）→ 6. 组装 CastMember → 7. role-pool.interact →
8. 缓存 plan（内存 + `.pi/scheduler-plans/` 磁盘，TTL 1h）→ 9/10. yolo 自动 commit / plan 等确认

返回 `DispatchPlanOutput`（plan 模式，含 `planId`/`eventId`/`chapterPath`/`outputs`/`errors`/`cast`/`retrievalPlan`）或 `DispatchYoloOutput`（yolo 模式，追加 `commitResult`）。

## `commit(planId, ctx)` 8 步（P0 修复后）

1. 取 plan → 2. extractStateChanges → 2.5 建立 changeAuthors 映射（供 4.3 步） → 3. 按 entityId 分组 →
4. 写扩散（**P0-4 修复**：单个 entityId 失败不阻断其他 entityId，记入 `failedEntityIds`）：
   - **4.1** 查询同 property 未闭合 Fact → invalidated[]
   - **4.2** `processEvent(type="change")` 写 change 事件
   - **4.2.5 P0-5 修复（2026-07-27）**：为新增 Fact 增量生成 embedding 并调 `wg.updateFactEmbedding`。失败不阻断 commit（`search_text` 仍能命中 property/valueText）。修复前 `search_vector` / `search_hybrid` 完全不命中新数据
   - **4.3 自产自知**：为作者角色写新 Fact 的 Visibility（`source: "experienced"`、`confidence: 1`）——修复角色自盲断链（2026-07-25）
   - **4.4 P0-3+6 修复（2026-07-27）knowledge_gained → Visibility**（他盲修复）：
     - 用 LLM mapper（`ctx.knowledgeMapper`）把 `knowledge_gained` 自然语言映射到 `declarationId`
     - 候选列表由 `wg.getAllDeclarationsAt(storyTime)` 取（限制在 storyTime 时刻所有有效声明范围内，避免映射到未来事实）
     - 写 Visibility（`source: "informed"`、`confidence` 由 mapper 决定，**< 0.5 不写**）
     - 未注入 `knowledgeMapper` 时跳过 4.4 步（向后兼容，单测可不注入）
5. extractRelations → `addRelation`（**P0-4 修复**：失败不阻断主链路，记入 `failedRelations`）→
6. toRoleOutputs 投影 → 7. 按 intent 渲染（add=append / modify=重写锚点区间 / insert=renderText + `insertChapterSection`）→ 8. 清理 plan 缓存

**P0-4 部分成功语义**：`CommitResult.ok` 采用保守策略——写扩散与关系均无错且渲染成功才 `ok: true`；任一失败 `ok: false` 但 `appliedEventIds` 仍非空（调用方应同时检查 `ok` / `appliedEventIds` / `failedEntityIds` / `failedRelations`）。部分成功时也清理 plan 缓存（避免重试同 planId 重复写入）。

> **注**：OrchestratorService 层 BUG-014 后 committed/error 的 plan 保留供查询历史（TTL 清理），@pi/scheduler 包级 commit 仍清缓存。

## `discard(planId)` / `loadAllPlans(cwd)`

- `discard(planId)`：丢弃 plan 缓存（不写不渲染），返回是否删除成功
- `loadAllPlans(cwd)`：session_start 时从磁盘恢复未 commit 的 plan（含 TTL 清理：1 小时前的 plan 自动删除）

## `StructuredEvent`（调度器唯一输入）

```typescript
{
  storyTime: string;
  instruction: string;
  characterIds: string[];         // 主会话已消解为 entityId
  executionHints?: string;        // 用户特殊要求，透传角色池+渲染器
  mode?: "plan" | "yolo";        // 缺省 plan
  chapterPath?: string;           // 缺省从 storyTime 推断
  intent?: "add" | "modify" | "insert";
  targetEventId?: string;         // modify/insert 必填
  userInput?: string;             // 用户口述原文（2026-07-25 新增；commit 时落入 EventRecord.userInput）
}
```

> **注**（2026-07-30 M4a）：`locationId` 已从 `StructuredEvent` 删除（死字段，plan/commit 全文未消费）。

## `RetrievalItem` 与检索类型

```typescript
interface RetrievalItem {
  type: "character_view" | "entity_snapshot" | "relations"
      | "search_text" | "search_vector" | "search_hybrid";
  params: {
    entityId?: string;       // character_view / entity_snapshot / relations 用
    query?: string;          // search_* 用
    nodeType?: "Entity" | "Fact" | "Relation" | "Visibility";
    limit?: number;
    fieldPath?: string;      // 缺省 "embedding"
    modalityFilter?: ("fact" | "belief" | "hypothesis")[];
    recordedAsOf?: string;   // P0-2 修复：双时态检索（retcon 隔离）
  };
  assignTo: string[];        // 信息差核心：planner 决定谁看到什么
  label: string;             // 检索项语义标签（注入角色提示词时用作小标题）
}
```

> ⚠️ `search_vector` / `search_hybrid` 仅支持 `Entity`/`Fact` 节点（只有这两种声明了 embedding 字段）；
> planner 误输出 Relation/Visibility 时执行层防御性跳过（不崩）。

**P0-1 修复（2026-07-27）未来事实过滤**：`retrieve.ts` 的 `hitsToFactSnapshots` 转换层在 Fact/Entity 节点转 FactSnapshot 时按 `validFrom <= storyTime` 过滤，拦截所有 search 路径（`search_text`/`search_vector`/`search_hybrid`）返回的"未来才诞生"的节点。SDK `wg.search.*` 透传层不变（不影响 `world_query` 工具）。

**P0-2 修复（2026-07-27）双时态检索接入**：`RetrievalItem.params` 支持 `recordedAsOf` 字段，传入后 `retrieve.ts` 在 `wg.search.*` 调用时透传，仅返回该事务时点之前写入的内容（retcon 隔离）。坐标取自 `world_status` 的 `recordedNow`。

## `SchedulerCtx`

```typescript
interface SchedulerCtx {
  wg: WorldGraph;
  plannerLlm: PlannerLlmCaller;        // 推导检索计划
  roleLlm: RoleLlmCaller;              // 透传给 role_interact
  renderLlm: RenderLlmCaller;          // 透传给 renderToFile
  embedder: {                          // P0-5 修复后：向量化器
    embed(text: string): Promise<number[]>;
    embedEntity(snap: EntitySnapshot): Promise<number[]>;
    embedFact(decl: StateDeclaration): Promise<number[]>;
  };
  knowledgeMapper?: KnowledgeMapperLlmCaller;  // 可选；未注入时 commit 跳过 4.4 步
  roleRuleSet: string;                 // 角色规则集.md 全文
  renderRuleSet: string;               // 渲染规则集.md 全文
  plannerRuleSet: string;              // planner 规则集.md 全文（约束 planner 检索行为）
  cwd: string;                         // 章节路径推断和规则集加载
  staticCardLoader: (characterId, storyTime) => Promise<SillyTavernCard>;
  debugBus?: DebugBus;                 // 可选；注入后调度链关键点发射 DebugEvent
}
```

扩展层通过 `src/orchestrator/assembly.ts` + `src/orchestrator/chat-context.ts` 中构建 SchedulerCtx：4 路 LLM caller（planner/role/render/knowledgeMapper）统一从 PI 本体的 `ctx.model + ctx.modelRegistry` 获取（2026-07-29 改造），三份规则集并行加载，默认 staticCardLoader 用 `defaultStaticCardLoader`（Entity+Facts → 酒馆卡重组）。

## 调度器侧调试埋点（`packages/scheduler/src/debug.ts`）

`startSpan(ctx, stage, traceId, input?, parentId?)` 配对 start/end 事件。调度器发射（非穷举）：`dispatch` / `plan.llm` / `retrieve.item` / `role.interact` / `role.turn`（经 InteractHooks）/ `commit` / `commit.step.4`（per entityId）/ `commit.step.4.4` / `commit.step.5` / `commit.step.7`。未注入 `debugBus` 时为 no-op（零开销）。详见 [debug-bus.md](debug-bus.md)。
