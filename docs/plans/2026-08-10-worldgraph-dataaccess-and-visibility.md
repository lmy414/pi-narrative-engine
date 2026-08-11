# 2026-08-10 世界图统一数据管道（含可见性推理）

> 状态：**已执行**（2026-08-11/12 按 `2026-08-11-worldgraph-dataaccess-execution-plan.md` 完成；全量 814 测试绿 + tsc 0；前端测试轮 7/7 通过见 `docs/audits/frontend-test-runs/2026-08-11-dataaccess-schema-frontend.md`）。
> 执行计划：[2026-08-11-worldgraph-dataaccess-execution-plan.md](./2026-08-11-worldgraph-dataaccess-execution-plan.md)
>
> v2 相对 v1 的修订：
> - 范围从「最小范围（只新建类不迁移）」改为**全收口**：主会话、子代理、可见推理、外部编辑、导入卡片全部走 DataAccess（v1 的"唯一入口+不迁移裸调"自相矛盾，会造出第三条并行路径）。
> - 代理工具统一为**一套实现**（决策 D3），按角色分发子集保留。
> - 用户编辑 HTTP 层用**单独的方法**，但数据操作复用同一 DataAccess、校验复用共享 schema（决策 D4）。
> - `inferVisibilityAt` 补回 `recordedAsOf`（决策 D5），修正 v1 丢失 C2 retcon 隔离的功能回退。
> - Port 补全从 2 个方法扩到 10 个，并**删除** `Port.inferVisibility`（决策 D6，非弃用保留）。

## 一、目标与原则

- **数据存储在下层**：`underworld-graph` 仓库不动，维持只存数据 + 内核方法的现状。
- **数据加工在上层**：可见性推理等逻辑由上层承担，不调用仓库 `inferVisibility` 算法实现。
- **统一数据交互**：`WorldGraphDataAccess` 是世界图读写**唯一入口**。全收口完成后，`wg` 裸调只允许存在于 `ports/adapters.ts`（适配器）、`app/project-registry.ts`（创建/关闭实例）、`search.ts`（检索内部实现，走 SearchPort 另议）。
- **保解耦**：`WorldGraphDataAccess` 持有 `WorldGraphPort`（而非仓库实例），不绕过现有 Ports 层。
- **推理即方法**：可见性推理不单独成类，作为 `WorldGraphDataAccess` 的方法（`inferVisibilityAt`）。
- **代理工具统一**（D3）：主会话与子代理共用同一套 AgentTool 实现，不单独给不同代理设计工具；按角色分发工具子集（最小权限）保留。
- **用户编辑复用**（D4）：HTTP 编辑路由是独立的方法层（形态不同于 LLM 工具），但数据操作走同一 DataAccess，参数校验复用统一工具的共享 schema。

## 二、分层架构

```
主会话（customTools: ToolDefinition[]）     子代理（extraTools: AgentTool[]）
        │ wrapper 转换（agentToolToToolDefinition）   │ 直接消费
        └───────────────────┬─────────────────────────┘
                            ▼
        统一 world-tools（src/agents/world-tools.ts，唯一一套实现）
        · 全部工具工厂接收 WorldToolDeps { dataAccess, search, resolveStoryTime?, onStoryTime? }
        · 子集分发：createPlannerTools / createRoleLimitedTools / createReasoningTools / createMainSessionTools
                            │ 调用
                            ▼
        WorldGraphDataAccess（src/data/world-graph-data-access.ts，唯一数据入口）
        · 透传（读 13 + 写 9）+ 加工（inferVisibilityAt）
                            │ 持有                           ▲
                            ▼                              │ 调用
        WorldGraphPort ──唯一适配点──> wg            用户编辑 HTTP 路由
        （ports/adapters.ts）        （underworld-graph）  （visualizer/routes.ts，
                                                            共享 schema 校验请求体）
```

**五类调用方**（全收口范围）：

| 调用方 | 现状 | 收口后 |
|---|---|---|
| 子代理工具（agents/world-tools.ts） | 走 `ports.worldGraph` | 改走 `dataAccess` |
| 主会话工具（chat/world-tools.ts） | 裸 `wg`（WorldToolsProvider） | 删除该文件，共用统一实现 + wrapper |
| 可见性推理 | `port.inferVisibility` / `wg.inferVisibility` 两处 | `dataAccess.inferVisibilityAt` 唯一入口 |
| 用户编辑 HTTP 路由（visualizer/routes.ts） | 裸 `wg`（VisualizerContext） | `ctx.dataAccess` |
| 导入卡片（chat/import-card.ts） | 裸 `wg` 参数 | `dataAccess` 参数 |

## 三、`WorldGraphPort` 改动（`src/ports/types.ts` + `src/ports/adapters.ts`）

### 新增 10 个方法

**推理需要（2 个，v1 已有）**：

```typescript
/** 读取某时间点全部关系（含 located_in 等）。返回对齐仓库实际结构（含 description，见下） */
getAllRelationsAt(
  storyTime: string,
  opts?: { recordedAsOf?: string },
): Promise<RelationSnapshot[]>;

/** 读取某声明的可见性记录。storyTime 缺省 = 全历史（含已闭合，幂等/撤销回填判定用） */
getVisibilityForDeclaration(
  declarationId: string,
  storyTime?: string,
  opts?: { recordedAsOf?: string },
): Promise<VisibilityDeclaration[]>;
```

**主会话 + 外部编辑需要（8 个，v1 缺口）**：

```typescript
// 读取
getAllEntities(storyTime: string, opts?: { recordedAsOf?: string }): Promise<EntitySnapshot[]>;
getAllEvents(): Promise<EventRecord[]>;
recordedNow(): Promise<string | undefined>;
getEntityHistory(entityId: string, opts?: { recordedAsOf?: string }): Promise<unknown>;   // 返回结构对齐仓库
getRelationHistory(entityId?: string, opts?: { recordedAsOf?: string }): Promise<RelationSnapshot[]>;
// 写入
birthEntity(entityId: string, type: EntityType, initialProps: Record<string, string>, storyTime: string): Promise<void>;
killEntity(entityId: string, storyTime: string): Promise<void>;
updateEntitySummary(entityId: string, summary: string, storyTime: string): Promise<void>;
```

### 删除 1 个方法

- `inferVisibility(storyTime)`（types.ts:96 + adapters.ts:59）：全收口后无消费者，**直接删除**（不留弃用双轨）。仓库 `wg.inferVisibility` 本身不动（硬约束），只是不再被调用。

### 类型修正

- `RelationSnapshot`（types.ts:35-42）增加 `description?: string`——仓库 `getAllRelationsAt` 实际返回含 `description` 的超集（world-graph.ts:1165-1168），v1「结构对齐 RelationSnapshot」的措辞不准，修正为显式可选字段。
- `VisibilityDeclaration` 从 `underworld-graph` 导入真实类型（仓库 types.ts:118/128），保证推理语义对齐。

### adapter 实现

全部为一行透传（同现有风格），不加工。

## 四、`WorldGraphDataAccess` 统一数据管道类

新建 `src/data/world-graph-data-access.ts`：

```typescript
import { INFINITY } from "underworld-graph";
import type { WorldGraphPort } from "../ports/types.ts";

/**
 * 世界图统一数据管道——世界图读写唯一入口
 *
 * 职责边界：
 * - 透传：Port 方法原样转发（读 13 + 写 9），无加工。
 * - 加工：只放世界图单资源域内的读取加工（当前仅 inferVisibilityAt）。
 *   跨资源编排（retcon 改写编排、导入流程编排等）不放进本类，防上帝类。
 * - 无会话状态：不持有 currentStoryTime；storyTime 解析在工具层（resolveStoryTime 注入）。
 */
export class WorldGraphDataAccess {
  private constructor(private readonly port: WorldGraphPort) {}
  static create(port: WorldGraphPort): WorldGraphDataAccess {
    return new WorldGraphDataAccess(port);
  }

  // —— 透传读取 ——
  getEntityAt / getCharacterView / getRelations / getAllDeclarationsAt
  listStoryTimes / traceCauses
  getAllRelationsAt / getVisibilityForDeclaration          // 新增
  getAllEntities / getAllEvents / recordedNow              // 新增
  getEntityHistory / getRelationHistory                    // 新增

  // —— 透传写入 ——
  processEvent / addRelation / closeRelation
  setVisibility / closeVisibility / updateFactEmbedding
  birthEntity / killEntity / updateEntitySummary           // 新增

  // —— 加工：可见性推理 ——
  async inferVisibilityAt(
    storyTime: string,
    opts?: { recordedAsOf?: string },   // D5：保留 C2 retcon 事务隔离
  ): Promise<void> { /* 见下 */ }
}
```

### `inferVisibilityAt` 算法（忠实移植仓库 character-view.ts:54-90）

```
allRels ← getAllRelationsAt(storyTime, opts)
for rel of allRels.filter(label === "located_in"):
    target ← getEntityAt(rel.targetId, storyTime, opts);  不存在则跳过
    for decl of target.properties:
        mine ← getVisibilityForDeclaration(decl.declarationId, undefined, opts)
                 .filter(characterId === rel.sourceId)      // 全历史（含已闭合）
        已可见（validFrom <= storyTime < validTo）→ 跳过    // 幂等
        validFrom ← max(rel.validFrom, decl.validFrom)
        曾撤销（存在 validTo ≠ INFINITY 且 <= storyTime）→ validFrom ← storyTime  // 撤销回填保护
        validFrom > storyTime → 跳过
        setVisibility(rel.sourceId, decl.declarationId,
          { state:"known", confidence:1, source:"witnessed", validFrom, isExplicit:false })  // live 写入
```

- 与仓库原算法**逐行等价**，差异仅：读取经 Port、写入经 Port、`INFINITY` 从仓库导入。
- `recordedAsOf` 传入全部读取调用（C2 语义：读取侧重建到事务时点，写入侧仍 live）。
- 已知性能特征（与原算法相同）：逐声明串行 await，N+1 读取。本阶段接受，不优化。

### 实例创建点

- **每项目一个实例**：`ProjectHandle` 增加 `dataAccess` 字段，`project-registry.ts` openProject 时随 `wg`/`search` 一并创建（`WorldGraphDataAccess.create(createWorldGraphAdapter(wg))`）。
- 编排器装配（`assemblePorts`）改为复用 handle 上的 Port 适配器/DataAccess，不自建第二份。
- 消费方统一从 handle 取：`chat-context.ts`、`unified-server.ts`（vizCtx）、`orchestrator.ts`（经 opts 注入）。

## 五、统一代理工具（D3）

### 文件布局

- **唯一实现**：`src/agents/world-tools.ts`（保留并改造；它已是 AgentTool + Ports 形态，距目标最近）。
- **删除**：`src/chat/world-tools.ts`（18 个工具的实现并入唯一文件）。
- **新增**：`src/chat/agent-tool-adapter.ts`——`agentToolToToolDefinition(tool, promptSnippet?)` 薄 wrapper。
  - 依据：pi-coding-agent 内部存在 `createToolDefinitionFromAgentTool`（dist/core/tools/tool-definition-wrapper.js），但**未从包入口导出**，故自写最小 wrapper：拷贝 `name/label/description/parameters/executionMode`，`execute(id, params, signal, onUpdate)` 直接转发（两侧签名兼容，ToolDefinition.execute 多出的 `ctx` 参数忽略）。
  - `promptSnippet` 是 ToolDefinition 独有字段：统一 world-tools 导出 `WORLD_TOOL_PROMPT_SNIPPETS: Record<string, string>` 映射表（内容取自现 chat/world-tools.ts），wrapper 按工具名挂接。

### 依赖注入（会话状态外置）

```typescript
export interface WorldToolDeps {
  dataAccess: WorldGraphDataAccess;
  search: SearchPort;
  /** storyTime 缺省解析：主会话注入"读会话态，空则取最新"；子代理注入"取最新" */
  resolveStoryTime?: () => Promise<string>;
  /** 写操作成功后的 storyTime 副作用：主会话注入"写会话态"；子代理不传 */
  onStoryTime?: (storyTime: string) => void;
}
```

- 优先级：工具参数显式 `storyTime` > `resolveStoryTime()`。
- DataAccess 本身**不持有**会话状态（见四）。

### 工具集：取并集（18 + 4 受限变体）

主会话版独有 5 个并入：`world_entity_create`（birthEntity）、`world_entity_kill`（killEntity）、`world_entity_update_summary`、`world_entity_history`、`world_relation_history`。
两版共有 13 个按以下调和：

| 工具 | 差异 | 统一方案 |
|---|---|---|
| `world_event_apply` | 主会话版有 `userInput`/`source`/`entityType`/`summary`/`causedBy`；子代理版固定 `source:"engine"` | schema 取并集（均可选），`source` 缺省 `"engine"`；写事件后调 `onStoryTime` |
| `world_visibility_set` | 主会话版 `storyTime`→validFrom + `isExplicit` 必填；子代理版显式 `validFrom` + 固定 `isExplicit:true` | 统一参数 `storyTime`（缺省 resolve）作 validFrom；`isExplicit` 可选缺省 `true` |
| `world_status` | 主会话版含实体/事件数 + recordedNow；子代理版只有时间点统计 | 取丰富版（entities/events/recordedNow/latestStoryTime） |
| 其余 10 个 | 语义一致，仅 storyTime 兜底来源不同 | 以子代理版实现为准，storyTime 改走 `resolveStoryTime` |

- 校验规则以较严者为准（ID pattern、枚举、minLength 等，两版历史审计修正全部保留）。
- `executionMode: "sequential"` 全部保留。
- 受限变体 4 个（`character_view_limited` / `entity_get_limited` / `relations_limited` / `query_limited`）保留 characterId 绑定形态，数据源换 dataAccess。

### 子集分发（保留，同一套工厂）

```typescript
createPlannerTools(deps)      // 7 只读
createRoleLimitedTools(deps, characterId)  // 4 只读受限
createReasoningTools(deps, sink?)          // 3 只读 + 6 写（含 world_visibility_infer → dataAccess.inferVisibilityAt）
createMainSessionTools(deps)  // 全集 18（新增）
```

orchestrator.ts 三个调用点（267/337/575 行）改为传 `WorldToolDeps`；`OrchestratorPorts` 接口本身不动（search 仍经 `ports.search` 传入 deps）。

## 六、用户编辑 HTTP 层（D4）

`src/visualizer/routes.ts`：

- `VisualizerContext`：`wg: WorldGraph` → `dataAccess: WorldGraphDataAccess`（search/forceFulltext/debugBus 不变）。`unified-server.ts:296-302` 构造处同步改。
- 全部 `wg.xxx` 调用换 `dataAccess.xxx`（读：listStoryTimes/getAllEntities/getAllEvents/getRelationHistory/getAllRelationsAt/getEntityHistory/getEntityAt/getVisibilityForDeclaration/traceCauses/getCharacterView；写：processEvent/updateEntitySummary/addRelation/closeRelation/setVisibility/closeVisibility）。
- **共享 schema 校验**：统一 world-tools 把写工具的 `parameters` schema 导出为具名常量；HTTP 写端点用 `Check`（`typebox/schema` 子路径导出，已核实 typebox 1.1.24 可用）校验请求体，替代现有手写 `requireFields` + `String(obj.xxx)`。校验规则从此只有一份，HTTP 层与 LLM 工具层不再漂移。
- `POST /api/events` 强制 `source: "user"` 的规则**留在 HTTP 层**（这是外部编辑的业务规则，不下沉 DataAccess）。
- API 响应形状不变 → `frontend-demo` 零改动，不触发前端测试轮。

## 七、导入卡片

- `import-card.ts`：`importCardToWorldGraph(wg, ...)` → `importCardToWorldGraph(dataAccess, ...)`（processEvent / setVisibility 换调）。
- `chat/import-tools.ts`：`ImportToolsProvider.wg` 换 `dataAccess`。

## 八、未改动项（刻意保持）

| 项 | 原因 |
|---|---|
| `underworld-graph` 仓库（含其 `inferVisibility` 实现） | 硬约束不改 |
| `frontend-demo/` | API 形状不变 |
| SearchPort / EmbedderPort / RulesetPort / RendererPort / RolePoolPort | 本次范围只收口世界图 |
| `search.ts` 内部持有 `wg`（检索实现） | 检索走 SearchPort 抽象，不在本次范围 |

## 九、决策记录

| # | 决策 | 来源 |
|---|---|---|
| D1 | 可见性推理收进 `WorldGraphDataAccess` 作为方法，不单独建类 | 用户 2026-08-10 |
| D2 | **全收口**：五类调用方全部迁移，推翻 v1「最小范围」 | 用户 2026-08-11 |
| D3 | 代理工具**统一一套实现**（AgentTool），主会话经 wrapper 消费；按角色分发子集保留 | 用户 2026-08-11 |
| D4 | 用户编辑用**单独的 HTTP 方法层**，数据操作复用 DataAccess，校验复用共享 schema | 用户 2026-08-11 |
| D5 | `inferVisibilityAt(storyTime, opts?.recordedAsOf)` 保留 C2 retcon 隔离（修正 v1 功能回退） | 评审 2026-08-11 |
| D6 | `Port.inferVisibility` 直接删除，不留弃用双轨 | 评审 2026-08-11 |
| D7 | 会话状态（currentStoryTime）留在工具层注入，DataAccess 无会话状态 | 评审 2026-08-11 |
| D8 | DataAccess 只放单资源域加工，跨资源编排不进（防上帝类） | 评审 2026-08-11 |
