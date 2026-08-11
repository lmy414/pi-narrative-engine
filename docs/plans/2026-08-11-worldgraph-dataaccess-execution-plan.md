# 2026-08-11 世界图统一数据管道执行计划

> 依据设计文档：[2026-08-10-worldgraph-dataaccess-and-visibility.md](./2026-08-10-worldgraph-dataaccess-and-visibility.md)（v2 已审定）。
> 本文档是唯一执行依据；执行中发现与设计文档冲突时，先停下对齐，不擅自发挥。
> 状态：待执行。

## 前置：分支（按 AGENTS.md 分支策略）

```bash
git fetch origin
git checkout master && git pull origin master
git checkout -b 20260811-worldgraph-dataaccess
```

- 全程禁止直接在 master 上提交；每个 Task 一个 commit，`git add <显式路径>`，禁止 `git add -A`/`git add .`。
- 全部完成后：`git checkout master && git merge --ff-only 20260811-worldgraph-dataaccess && git push origin master && git branch -d 20260811-worldgraph-dataaccess`。

## 改动文件总览

| 文件 | 动作 | 所属 Task |
|---|---|---|
| `src/ports/types.ts` | 改：Port +10 方法、RelationSnapshot +description、删 inferVisibility | T1 / T7 |
| `src/ports/adapters.ts` | 改：10 个透传实现、删 inferVisibility 适配 | T1 / T7 |
| `src/data/world-graph-data-access.ts` | **新建**：统一数据管道类 | T2 |
| `tests/world-graph-data-access.test.ts` | **新建**：DataAccess 单测 | T2 |
| `src/agents/world-tools.ts` | 改：依赖换 WorldToolDeps，并集工具集，导出 schema/snippet 常量 | T3 |
| `src/chat/agent-tool-adapter.ts` | **新建**：AgentTool→ToolDefinition wrapper | T3 |
| `src/chat/world-tools.ts` | **删除**（实现并入 agents/world-tools.ts） | T3 |
| `tests/agent-tools.test.ts`、`tests/tools.test.ts` | 改：迁移到统一工具 | T3 |
| `src/orchestrator.ts` | 改：三处工具调用点传 WorldToolDeps；opts 增加 dataAccess | T4 |
| `src/app/project-registry.ts` | 改：ProjectHandle 增加 dataAccess 字段 | T5 |
| `src/app/chat-context.ts` | 改：assembleChatTools 换统一工具 + wrapper，注入会话态 | T5 |
| `src/chat/import-card.ts`、`src/chat/import-tools.ts` | 改：wg → dataAccess | T5 |
| `src/visualizer/routes.ts` | 改：VisualizerContext 换 dataAccess，写端点共享 schema 校验 | T6 |
| `src/app/unified-server.ts` | 改：vizCtx 构造（296-302 行） | T6 |

## Task 1：Port 补全

**文件**：`src/ports/types.ts`、`src/ports/adapters.ts`

**动作**：
1. `RelationSnapshot` 增加 `description?: string`（对齐仓库 `getAllRelationsAt` 实际返回超集）。
2. 导入 `VisibilityDeclaration` 类型（from `underworld-graph`）。
3. `WorldGraphPort` 新增 10 个方法签名（签名照抄设计文档 §三，逐字不发挥）：
   - 读取：`getAllRelationsAt`、`getVisibilityForDeclaration`、`getAllEntities`、`getAllEvents`、`recordedNow`、`getEntityHistory`、`getRelationHistory`
   - 写入：`birthEntity`、`killEntity`、`updateEntitySummary`
4. adapters.ts 补 10 个一行透传实现。
5. **本 Task 不删** `inferVisibility`（先加后删，避免中间态断编译；删除在 T7）。

**注意**：`getEntityHistory` 返回结构以仓库实际返回类型为准（world-graph.ts:1253），types.ts 里显式声明，不用 `unknown` 兜底——执行时先读仓库该方法返回类型再照抄。

**验证**：
- `npx tsc --noEmit`
- `tests/ports-adapters.test.ts` 补 10 个新方法的透传测例（沿用现有测例风格），`npx tsx --test tests/ports-adapters.test.ts` 通过。
- commit：`src/ports/types.ts src/ports/adapters.ts tests/ports-adapters.test.ts`

## Task 2：新建 WorldGraphDataAccess + 单测

**文件**：`src/data/world-graph-data-access.ts`（新建）、`tests/world-graph-data-access.test.ts`（新建）

**动作**：
1. 按设计文档 §四实现：私有构造 + 静态 `create`；透传读 12 + 写 9；`inferVisibilityAt(storyTime, opts?)`。
2. `inferVisibilityAt` 逐行对齐仓库 `character-view.ts:54-90`（含 C2 `recordedAsOf` 传入全部读取；`INFINITY` 从 `underworld-graph` 导入；setVisibility live 写入）。不擅自优化串行 N+1。

**测例**（完备性硬要求）：
1. 透传抽样：mock Port，验证方法原样转发（参数/返回值）。
2. 正常推断：真实 wg 内存实例（参照 `tests/import-card.test.ts` 的建图方式），造 `located_in` 关系 + target 声明 → 推断后该角色对 target 全部声明 `known/witnessed/isExplicit:false`，`validFrom = max(rel.validFrom, decl.validFrom)`。
3. 幂等：同一 storyTime 调两次，第二次不产生新可见性记录（对照 `getVisibilityForDeclaration` 全历史数量）。
4. 撤销回填：`closeVisibility` 后再推断，新记录 `validFrom = storyTime`（不回填到撤销区间之前）。
5. `recordedAsOf` 透传：mock Port 断言三个读取方法都收到 `opts`；写调用不带。
6. 对照测例：同一图态下 `dataAccess.inferVisibilityAt` 与仓库 `wg.inferVisibility` 结果一致（可见性记录集合相等）。

**验证**：`npx tsx --test tests/world-graph-data-access.test.ts` + `npx tsc --noEmit`
- commit：`src/data/world-graph-data-access.ts tests/world-graph-data-access.test.ts`

## Task 3：统一代理工具（核心任务）

**文件**：`src/agents/world-tools.ts`（改）、`src/chat/agent-tool-adapter.ts`（新建）、`src/chat/world-tools.ts`（删）、`tests/agent-tools.test.ts`（改）、`tests/tools.test.ts`（改/合并）

**动作**：
1. 定义 `WorldToolDeps { dataAccess; search: SearchPort; resolveStoryTime?; onStoryTime? }`（设计文档 §五）。
2. 全部既有工具工厂签名从 `(ports: OrchestratorPorts)` 改为 `(deps: WorldToolDeps)`；内部 `ports.worldGraph.xxx` → `deps.dataAccess.xxx`，`ports.search` → `deps.search`；storyTime 兜底从 `latestStoryTime(ports)` 改为 `deps.resolveStoryTime?.() ?? latestStoryTime(deps.dataAccess)`。
3. 并入主会话版独有 5 工具（`world_entity_create`/`world_entity_kill`/`world_entity_update_summary`/`world_entity_history`/`world_relation_history`），schema 沿用 chat/world-tools.ts 现状（含中文词表 description、ID pattern 等全部历史审计修正）。
4. 调和共有工具差异：严格按设计文档 §五表格（event_apply 并集 + source 缺省 engine + onStoryTime；visibility_set 统一 storyTime 作 validFrom + isExplicit 可选缺省 true；world_status 取丰富版）。两版校验取较严者。
5. 写工具成功路径调 `deps.onStoryTime?.(storyTime)`（对齐现主会话版 `setCurrentStoryTime` 副作用：entity_create/entity_kill/event_apply）。
6. 参数 schema 全部导出为具名常量（供 T6 HTTP 层复用）；导出 `WORLD_TOOL_PROMPT_SNIPPETS`（内容取自现 chat/world-tools.ts 各 promptSnippet）。
7. 新增 `createMainSessionTools(deps)` 全集工厂（18 个）。
8. 新建 `agent-tool-adapter.ts`：拷贝 name/label/description/parameters/executionMode，execute 转发（ToolDefinition 的 `ctx` 参忽略），按工具名挂 promptSnippet。
9. 删除 `src/chat/world-tools.ts`。

**测例**：
- `tests/agent-tools.test.ts`：deps 构造换 WorldToolDeps（mock dataAccess 或真实 wg + adapter）。
- `tests/tools.test.ts`：主会话场景测例迁移到 `createMainSessionTools` + wrapper，保留原有覆盖（含 `resolveStoryTime` 会话态注入、`onStoryTime` 副作用两个新测例）。执行时评估并入 agent-tools.test.ts 还是保留独立文件，二选一，不留重复。

**验证**：`npx tsx --test tests/agent-tools.test.ts tests/tools.test.ts` + `npx tsc --noEmit`
- commit：上述全部文件（含删除）

## Task 4：orchestrator 接线

**文件**：`src/orchestrator.ts`（267/337/575 行三个调用点），视核查结果可能带 `src/orchestrator/service.ts`、`src/orchestrator/mcp-server.ts`

**动作**：
1. `Orchestrator` opts 增加 `dataAccess: WorldGraphDataAccess`（由上游从 ProjectHandle 传入，不自建）。
2. 三个调用点构造 `WorldToolDeps`：`{ dataAccess: this.opts.dataAccess, search: this.opts.ports.search }`；reasoning 子代理的 `resolveStoryTime` 注入"取最新"（保持现状语义），planner/role-limited 同。
3. 执行时先 grep `assemblePorts(` 与 `new Orchestrator(` 全部调用点（含 mcp-server.ts、tests），逐个同步改，不漏。
4. `OrchestratorPorts` 接口不动。

**验证**：`npx tsc --noEmit` + `npx tsx --test tests/orchestrator-service.test.ts tests/orchestrator-timeout.test.ts tests/event-queue.test.ts`
- commit：涉及文件

## Task 5：主会话接线 + 项目注册表 + 导入卡片

**文件**：`src/app/project-registry.ts`、`src/app/chat-context.ts`、`src/chat/import-card.ts`、`src/chat/import-tools.ts`

**动作**：
1. `ProjectHandle` 增加 `dataAccess: WorldGraphDataAccess`；openProject 时 `WorldGraphDataAccess.create(createWorldGraphAdapter(wg))` 随 wg/search 一并创建（project-registry.ts 119-139 行区域）。
2. `chat-context.ts assembleChatTools`：`createWorldTools(projectDeps)` → `createMainSessionTools(deps).map(agentToolToToolDefinition)`；`resolveStoryTime` 注入「读 currentStoryTime，空则取最新」，`onStoryTime` 注入「写 storyTimes store」（对齐现 52-63 行语义）。`projectDeps.wg` 下线。
3. `ensureOrchestratorService`（365 行区域）：`new Orchestrator({..., dataAccess: active.dataAccess})`。
4. `import-card.ts`：`importCardToWorldGraph(dataAccess, card, storyTime, entityId?)`，两处 `wg.` 换调。
5. `import-tools.ts`：`ImportToolsProvider.wg` 换 `dataAccess`。

**验证**：`npx tsc --noEmit` + `npx tsx --test tests/chat-scheduler-tools.test.ts tests/import-card.test.ts tests/chat-routes.test.ts tests/unified-server.test.ts tests/debug/file-sink.test.ts`
- commit：涉及文件

## Task 6：visualizer routes 迁移（用户编辑入口）

**文件**：`src/visualizer/routes.ts`、`src/app/unified-server.ts`

**动作**：
1. `VisualizerContext.wg` → `dataAccess`；`handleApi` 内全部 `wg.xxx` 换 `dataAccess.xxx`（读写清单见设计文档 §六）。`latestStoryTime(wg)` 辅助函数改接 dataAccess。
2. 写端点（POST /api/events、entity summary、relation add/close、visibility set/close 等）改用 T3 导出的共享 schema + `Check`（`import { Check } from "typebox/schema"`）校验请求体，替代 `requireFields` + `String(obj.xxx)` 手写真值化；校验失败保持 400 + 现有错误 envelope 形状（`{ ok:false, error:{ code, message } }`）。
3. `POST /api/events` 强制 `source:"user"` 保留在 HTTP 层。
4. `unified-server.ts:296-302` vizCtx 构造改传 `active.dataAccess`。
5. **响应形状零变化**：data 字段结构、状态码、错误码全部保持现状（frontend-demo 依赖）。

**验证**：
- `npx tsc --noEmit` + `npx tsx --test tests/unified-server.test.ts`
- 手工冒烟：`node scripts/app-server.mjs --port 7421`，可视化页面实操——实体查看/编辑摘要、关系增删、可见性设置/撤销、事件列表、快照切换，确认页面行为与改动前一致。
- commit：`src/visualizer/routes.ts src/app/unified-server.ts`

## Task 7：删除 Port.inferVisibility + 收口验收

**文件**：`src/ports/types.ts`（96 行）、`src/ports/adapters.ts`（59 行）

**动作**：
1. 删除 `inferVisibility`（接口 + 适配实现）。
2. 全局验收 grep（结果贴进 commit message 或 PR 描述）：
   - `src/` 下 `\bwg\.` 方法调用只剩：`ports/adapters.ts`、`app/project-registry.ts`（close）、`search.ts`（检索内部）。
   - `src/` 下 `inferVisibility` 只剩：`data/world-graph-data-access.ts` 的 `inferVisibilityAt`。
   - `src/` 下不再有 `WorldToolsProvider`、`createWorldTools`（旧主会话版）引用。
3. `tests/ports-adapters.test.ts` 删除 inferVisibility 对应测例。

**验证**：`npx tsc --noEmit` + 全量 `npm test`
- commit：涉及文件

## Task 8：全量验证 + 合并

1. `npm test` 全量通过。
2. `npx tsc --noEmit` 通过。
3. 手工冒烟（`node scripts/app-server.mjs --port 7421`）：
   - 主会话：world_status → 创建实体 → 应用事件 → 可见性推断 → 角色视角查询。
   - 可视化页面：实体/关系/可见性编辑各一遍（同 T6 冒烟清单）。
   - 编排器：跑一轮完整四阶段（planner → role → reasoning → renderer），确认 reasoning 写图与可见性推断正常。
4. 设计文档状态从「v2 方案已审定，未动代码」改为「已执行（2026-08-11）」。
5. 按前置节的分支策略合并 master + push + 删分支。

## 纪律与边界

- **frontend-test-discipline 不触发**：本次不改 `frontend-demo/` 及其依赖；T6 须保证 API 响应形状不变。
- **underworld-graph 仓库不动**（含其 `inferVisibility` 实现，仅停止调用）。
- 每 Task 完成后立即跑该 Task 验证命令再进下一 Task；任何一步测试红 → 停下修，不带病推进。
- 执行中若发现设计文档遗漏（如遗漏的 `wg` 调用点、签名不符），**先回报对齐**，不擅自扩范围。
