# 数据层 Ports 接线执行计划（阶段 A 修正版）

> 日期：2026-08-01
> 状态：A1-A4 已实施（2026-08-01）；A5 拆出待排期
> 前置：`docs/plans/2026-08-01-data-layer-ports-implementation.md`（可行性调研，结论可行）
> 关联：
> - `docs/plans/2026-07-31-subagent-orchestrator-design.md`（子代理设计，职责划分权威来源）
> - `docs/plans/2026-07-31-tool-allocation-design.md`（工具分配方案）
> - `docs/plans/2026-08-01-orchestrator-standalone-implementation-report.md`（阶段 0/1 实现报告）

## 一、决策记录（用户确认，2026-08-01）

本计划相对调研文档修正了 4 个设计分歧点，均经用户确认：

| # | 决策 | 依据 | 修正影响 |
|---|---|---|---|
| D1 | **写世界图归可见推理代理**（`world_event_apply` 等 9 工具自主写），commit 不再硬编码 `processEvent` | 子代理设计 §3.4/§七：`commit.ts 硬编码写扩散 → reasoning-agent 自主推理写入` | 解决调研 §六 与子代理设计冲突，避免双重写入 |
| D2 | **渲染落地归渲染器代理**（注入 `chapter_read`/`chapter_write` 工具），commit 不调 `renderToFile` | 子代理设计 §3.5：渲染器代理工具 `readChapter`/`writeChapter` | 消除调研 §6.2 的重复渲染 |
| D3 | **yolo 模式全链路自动落地**（可见推理写世界图 + 渲染器写章节 + 更新记忆） | 子代理设计 §五：yolo 全链路自动跑完 | yolo 无需额外 commit |
| D4 | **A5（LlmConfigStore 持久化）拆出为独立任务** | 与数据层 Ports 无依赖 | 本次范围收敛为 A1-A4 |

**commit 定位（修正后）**：plan 模式的"后半链路触发器"。plan 模式跑到角色产出即停并缓存，`scheduler_commit` 触发可见推理 + 渲染 + 记忆更新；`scheduler_discard` 丢弃缓存。

## 二、对齐后的目标架构

```
plan 模式：
  scheduler_dispatch → planner（查世界图）→ 角色（受限视图）→ 产出即停，缓存 plan
  scheduler_commit  → 可见推理代理（只读 + 写世界图）→ 渲染器代理（读章节 + 写章节）
                   → 更新记忆 → 清理缓存
yolo 模式：planner → 角色 → 可见推理 → 渲染器 → 记忆更新，全链路自动落地
```

**Ports 的定位**：不是 commit 的执行接口，而是子代理工具的底层能力抽象。各子代理经 AgentTool（闭包注入 ports）读写数据层。

## 三、Ports 接口（修正版）

调研 §四 基础上修正 3 处：

```typescript
// src/ports/types.ts
import type { VisibilitySource } from "underworld-graph";   // 修正：引用枚举而非手写字面量

export interface WorldGraphPort {
  // 只读
  getEntityAt(entityId: string, storyTime: string, opts?: { recordedAsOf?: string }): Promise<EntitySnapshot | null>;
  getCharacterView(characterId: string, storyTime: string, opts?: {
    modalityFilter?: ("fact" | "belief" | "hypothesis")[];
    recordedAsOf?: string;
  }): Promise<StateDeclaration[]>;
  getRelations(entityId: string, storyTime: string, opts?: { recordedAsOf?: string }): Promise<RelationSnapshot[]>;
  getAllDeclarationsAt(storyTime: string): Promise<StateDeclaration[]>;
  listStoryTimes(): Promise<string[]>;
  // 写入
  processEvent(event: EventRecordInput): Promise<void>;
  addRelation(sourceId: string, targetId: string, label: string, storyTime: string): Promise<void>;
  setVisibility(characterId: string, declarationId: string, opts: {
    state: "known";
    confidence: number;
    source: VisibilitySource;
    validFrom: string;
    isExplicit: boolean;
  }): Promise<void>;
  updateFactEmbedding(declarationId: string, vec: number[]): Promise<void>;
}

/** 修正（P6）：WorldGraphPort 不含 search，检索统一走 SearchPort，避免冗余 */
export interface SearchPort {
  search(query: string, opts?: { topK?: number; typeFilter?: EntityType; storyTime?: string; mode?: "fulltext" | "vector" | "hybrid" }): Promise<EntitySearchResult[]>;
}

export interface EmbedderPort {
  embed(text: string): Promise<number[]>;
  embedEntity(snapshot: EntitySnapshot): Promise<number[]>;
  embedFact(decl: StateDeclaration): Promise<number[]>;
}

/** 适配器映射真实函数：loadPlannerRuleSet(src) / loadRoleRuleSet(@pi/role-pool) / loadRuleSet(@pi/renderer) */
export interface RulesetPort {
  loadPlanner(cwd: string): Promise<string>;
  loadRole(cwd: string): Promise<string>;
  loadRender(cwd: string): Promise<string>;
}

export interface MemoryPort {
  load(cwd: string): Promise<string>;
  update(wg: WorldGraphPort, cwd: string): Promise<void>;
}

export interface RendererPort {
  ensureChapterFile(chapterPath: string): Promise<void>;
  readChapter(chapterPath: string): Promise<string>;
  readChapterSection(chapterPath: string, start?: string, end?: string): Promise<string>;
  appendToChapter(chapterPath: string, eventId: string, text: string): Promise<void>;
  modifyChapterSection(chapterPath: string, anchorEventId: string, newText: string): Promise<void>;
  insertChapterSection(chapterPath: string, afterEventId: string, newEventId: string, text: string): Promise<void>;
}

/** 角色池端口：保留接口，本阶段默认适配器空实现（角色由编排器直接驱动 Agent） */
export interface RolePoolPort {
  interact(cmd: InteractCommand, deps: { llm: RoleLlmCaller; ruleSet: string }): Promise<InteractResult>;
}
```

**差异说明**：
1. WorldGraphPort 增加 `listStoryTimes`（工具 `world_story_times` 需要）
2. RendererPort 用纯 IO 原语（`appendToChapter`/`modifyChapterSection`/`insertChapterSection`），不再暴露 `renderToFile`（渲染 LLM 调用由渲染器代理自己完成，工具只落地文本）。`insertChapterSection` 从 `@pi/scheduler` 导出或迁移到 `@pi/renderer`
3. `updateFactEmbedding` 保留（可见推理代理写 change 后如需补向量；无向量引擎时容错）

## 四、分步执行计划

### A1：Ports 类型 + 默认适配器

**改动文件**：
- 新增 `src/ports/types.ts`（上节定义）
- 新增 `src/ports/adapters.ts`（6 个薄适配器，10-30 行/个）
- 新增 `src/orchestrator/assembly.ts`（`assemblePorts({ wg, search, embedder, cwd })`）

**要点**：
- 适配器直接映射真实 API（[world-graph.ts](file:///d:/claude/pi-ex/narrative-engine/node_modules/underworld-graph/src/world-graph.ts) / [search.ts](file:///d:/claude/pi-ex/narrative-engine/src/search.ts) / [memory.ts](file:///d:/claude/pi-ex/narrative-engine/src/memory.ts) / @pi/renderer / @pi/role-pool），零 PI 依赖
- RolePoolPort 适配器返回 `interact` 抛"未接线"或空实现（本阶段角色不经 role-pool）

**验收**：
- `npm run build` 通过
- 单测：mock wg/search/embedder，断言每个适配器方法映射正确、透传参数

### A2：commit 后半链路触发 + yolo 自动落地

**改动文件**：
- 新增 `src/orchestrator/commit.ts`（很薄的触发器，非写扩散实现）
- 修改 `src/orchestrator.ts`：`OrchestratorResult` 增加 `event: StructuredEvent`（调研 P1）；抽出 `runPostRolePipeline`（可见推理 + 渲染，供 plan commit 与 yolo 共用）；yolo 模式跑完后自动执行落地
- 修改 `src/orchestrator/service.ts`：plans 缓存 `Map<planId, { event, result }>`（不迁入 @pi/scheduler，调研 P5）；`commit()`/`discard()` 真实现
- 修改 `src/orchestrator/mcp-server.ts`：`scheduler_commit`/`scheduler_discard` 描述更新

**commit 流程（修正版）**：
```
1. 取 plan 缓存，不存在返回 { ok: false, error }
2. 启动可见推理代理：注入角色产出 + 世界图只读/写工具 → 收集写结果（appliedEventIds / visibilityChanges / 失败项）
3. 启动渲染器代理：注入角色产出 + 扩散 + 章节工具 → 收集 writtenText / 失败项
4. 更新记忆（memory.update）
5. 清理 plan 缓存
6. 返回 CommitResult（含 appliedEventIds / writtenText / 失败项）
```

**要点**：
- 可见推理/渲染失败不阻断另一段，失败项汇总（沿用调研 §九 #1 的容错语义，由子代理工具错误事件收集）
- knowledge_gained 映射由可见推理代理在推理中完成（调研 P2），不单独调 LLM
- yolo 模式：`run()` 末尾自动执行步骤 2-4，无需外部 commit

**验收**：
- 单测：mock 子代理，断言 commit 触发顺序、失败项汇总、缓存清理
- e2e：MCP `scheduler_dispatch`（plan）→ `scheduler_commit` → 世界图出现 change 事件 + 章节文件出现正文；yolo 模式派发后自动落地

### A3：queue_status 暴露结果内容

**改动文件**：
- 修改 `src/orchestrator/service.ts`：`QueueStatusResult` 增加 `result?: OrchestratorResult`（含 outputs/diffusion/render/event）

**验收**：
- MCP 轮询 `scheduler_queue_status` 能拿到完整编排结果

### A4：子代理世界图 / 章节工具注入

**改动文件**：
- 新增 `src/agents/world-tools.ts`：只读 + 写 AgentTool（闭包注入 ports）
- 新增 `src/agents/chapter-tools.ts`：`chapter_read` / `chapter_write`
- 修改 `src/agents/planner-agent.ts` / `role-agent.ts` / `reasoning-agent.ts` / `renderer-agent.ts`：工厂增加工具注入参数
- 修改 `src/orchestrator.ts`：装配子代理时注入对应工具集

**工具清单（对齐[工具分配方案 §五](file:///d:/claude/pi-ex/narrative-engine/docs/plans/2026-07-31-tool-allocation-design.md)）**：

| 子代理 | 工具 | 数量 |
|---|---|---|
| planner | `world_entity_get` / `world_relations` / `world_character_view` / `world_query` / `world_status` / `world_story_times` / `world_event_chain` | 7 只读 |
| 角色（受限变体） | `character_view_limited` / `entity_get_limited` / `relations_limited` / `query_limited`（characterId 绑定） | 4 只读 |
| 可见推理 | 上述只读 3（entity_get/relations/event_chain）+ `world_event_apply` / `world_visibility_set` / `world_visibility_close` / `world_visibility_infer` / `world_relation_add` / `world_relation_close` | 3 读 + 6 写 |
| 渲染器 | `chapter_read` / `chapter_write` | 2 |

**要点**：
- 写工具为**内部变体**：不复用主会话工具（[world-tools.ts](file:///d:/claude/pi-ex/narrative-engine/src/tools/world-tools.ts) 依赖 ExtensionAPI），闭包注入 ports，`world_event_apply` 内部变体不带 `userInput` 字段（工具分配 §六 #4）
- `chapter_write` 按 intent 分支：add→`appendToChapter`、modify→`modifyChapterSection`、insert→`insertChapterSection`
- `query_limited`：检索后按 `getCharacterView` 交集过滤，泄露风险本阶段接受（沿用调研 §7.2 结论）
- 与产出提交工具共存：子代理先查（世界图/章节工具）→ 推理 → 提交（`retrieval_plan`/`character_action` 等 terminate 工具）

**验收**：
- 单测：每个工具的参数 schema 与 ports 调用正确
- e2e：planner 查实况、角色受限视图不越界、可见推理写入世界图、渲染器写入章节文件

## 五、风险与存疑

| # | 风险 | 影响 | 应对 |
|---|---|---|---|
| 1 | 可见推理代理写世界图的失败容错：原 commit.ts 有 `failedEntityIds`/`failedRelations` 语义 | 高 | 子代理工具错误事件 → 编排器汇总失败项，单实体失败不阻断其余 |
| 2 | `world_event_apply` 双重身份（主会话 vs 子代理） | 中 | 子代理内部变体约束字段，主会话工具不动 |
| 3 | insert 模式的 `insertChapterSection` 归属（现居 @pi/scheduler） | 中 | 从 @pi/scheduler 导出，或迁移到 @pi/renderer 由 RendererPort 暴露 |
| 4 | diffusion.changes 与角色 state_changes 语义差异：可见推理代理裁决为准，不做 extractStateChanges 降级 | 中 | 可见推理代理失败即 commit 失败，语义清晰 |
| 5 | plans 缓存无持久化：进程重启丢失未 commit 的 plan | 低 | yolo 全链路不受影响；plan 模式丢失可接受，后续补持久化 |
| 6 | query_limited 信息泄漏 | 低 | 检索后过滤，后续优化 |

## 六、实施顺序与依赖

```
A1（Ports 类型 + 适配器）          ← 无前置
  ↓
A2（commit 触发器 + yolo 落地）     ← 依赖 A1；A2 先接最小工具集（写世界图 + 写章节）
  ↓
A3（queue_status 暴露结果）         ← 依赖 A2
  ↓
A4（子代理完整工具注入）            ← 依赖 A1；可并行开发，最后 e2e 验证
```

A5（LlmConfigStore 持久化 + 配置入口）拆出为独立任务，另行排期。
