# 旧代码清理盘点报告（阶段 B：纯 SDK 全量收敛）

> 日期：2026-08-01
> 状态：盘点完成，待实施
> 定位：为旧代码清理与纯 SDK 架构收敛提供现状盘点、清理边界和依赖关系
> 决策来源（用户确认，2026-08-01）：
> - **运行时全面收敛到 PI SDK**，删除 PI 扩展入口及 PI CLI 应用链路
> - **只迁移尚未 SDK 化的 27 个业务工具**；已有 4 个调度工具直接保留
> - **废弃 skills 与 memory 机制**，不迁移到 SDK 主会话
> - **visualizer 统一由 unified-server 承载**，不保留独立服务和 `open_visualizer`
> - **@pi/scheduler 子包保留，只删除旧流水线**（plan/commit/retrieve/cache）
> 关联：
> - `docs/plans/2026-08-01-data-layer-ports-implementation-report.md`（阶段 A 落地报告）
> - `docs/plans/2026-08-01-orchestrator-standalone-implementation-report.md`（阶段 0/1 落地报告）
> - `docs/plans/2026-08-01-main-session-sdk-implementation.md`（主会话 SDK 调研）

## 一、阶段目标

把 narrative-engine 从“PI 扩展模式 + SDK 模式 + 两套 visualizer 入口并存”收敛为**纯 SDK 应用模式**：

1. 删除 PI 扩展入口 `src/index.ts`、旧工具目录 `src/tools/` 和 `src/session-state.ts`。
2. 将 world 18、render 5、role 2、import 2，共 **27 个**尚未 SDK 化的业务工具迁移为主会话 customTools。
3. 保留已经存在的 4 个 SDK 调度工具：`scheduler_dispatch` / `scheduler_commit` / `scheduler_discard` / `scheduler_queue_status`。
4. 最终主会话工具总数为 **31 个 SDK customTools = 27 个迁移工具 + 4 个现有调度工具**；不迁移旧 `open_visualizer`，也不重复迁移旧 3 个 scheduler 工具。
5. 删除 5 个旧 LLM caller：`planner-llm` / `role-pool-llm` / `renderer-llm` / `knowledge-mapper-llm` / `scheduler-llm`。
6. 删除 `@pi/scheduler` 的旧流水线：`plan.ts` / `commit.ts` / `retrieve.ts` / `cache.ts`。
7. 删除 PI 专属 skills 和 memory 链路，包括资产复制、注入、持久化端口及测试。
8. visualizer 统一到 `unified-server`：保留共用路由、静态资源和 UI，删除独立服务入口、独立启动脚本及工具状态。
9. 删除 PI CLI 应用链路：项目页启动 PI、扩展快照/重装/开关、项目级扩展 sync 与 sidecar 快照打包。
10. 迁移新架构仍依赖的 3 组旧产物：schema、`validateStoryTime`、`resolveWorldGraphDir`。

## 二、现状盘点（基于源码查证）

### 2.1 新架构（保留）

| 层 | 模块 | 文件 |
|---|---|---|
| 主会话 | MainSessionHost + 4 个 SDK 调度工具 | [src/chat/main-session.ts](file:///d:/claude/pi-ex/narrative-engine/src/chat/main-session.ts)、[src/chat/scheduler-tools.ts](file:///d:/claude/pi-ex/narrative-engine/src/chat/scheduler-tools.ts) |
| 编排器 | Orchestrator + EventQueue + Service | [src/orchestrator.ts](file:///d:/claude/pi-ex/narrative-engine/src/orchestrator.ts)、[src/event-queue.ts](file:///d:/claude/pi-ex/narrative-engine/src/event-queue.ts)、[src/orchestrator/service.ts](file:///d:/claude/pi-ex/narrative-engine/src/orchestrator/service.ts) |
| 编排器支撑 | MCP / LLM 配置 / 装配 / SDK 适配 | [src/orchestrator/](file:///d:/claude/pi-ex/narrative-engine/src/orchestrator/) |
| 子代理 | planner / role / reasoning / renderer + 工具 | [src/agents/](file:///d:/claude/pi-ex/narrative-engine/src/agents/) |
| 数据层 | Ports 接口 + 适配器（删除 MemoryPort 后保留其余端口） | [src/ports/](file:///d:/claude/pi-ex/narrative-engine/src/ports/) |
| 应用 | unified-server + ChatContext + 项目注册表 | [src/app/](file:///d:/claude/pi-ex/narrative-engine/src/app/) |
| 可视化 | unified-server 复用世界图路由并承载唯一 visualizer-ui | [src/app/unified-server.ts](file:///d:/claude/pi-ex/narrative-engine/src/app/unified-server.ts)、[src/visualizer/routes.ts](file:///d:/claude/pi-ex/narrative-engine/src/visualizer/routes.ts)、[visualizer-ui/](file:///d:/claude/pi-ex/narrative-engine/visualizer-ui/) |
| 基础能力 | 调试 / 检索 / 校验 | [src/debug/](file:///d:/claude/pi-ex/narrative-engine/src/debug/)、[src/search.ts](file:///d:/claude/pi-ex/narrative-engine/src/search.ts)、[src/checker.ts](file:///d:/claude/pi-ex/narrative-engine/src/checker.ts) |

### 2.2 旧架构（删除）

| 模块 | 内容 | 处理 |
|---|---|---|
| `src/index.ts` | PI 扩展入口、31 个旧工具注册、session 生命周期、memory 注入、skills 贡献 | 整体删除 |
| `src/tools/` | world 18 / render 5 / role 2 / scheduler 3 / import 2 / visualizer 1 | 只迁移 27 个业务工具；旧 scheduler 与 visualizer 工具删除 |
| `src/session-state.ts` | PI session 状态与独立 visualizerServer 状态 | 整体删除 |
| 5 个旧 LLM caller | 旧线性调度与 PI ExtensionContext 配置链 | 删除；render/role 仍需的调用逻辑迁入 SDK 工具并改用 LlmConfigStore |
| `packages/scheduler/src/{plan,commit,retrieve,cache}.ts` | 旧调度流水线与磁盘 plan 缓存 | 删除 |
| `src/skills/` | PI `resources_discover` 加载的 SKILL.md | 删除，不接入 SDK prompt |
| `src/memory.ts` | `memory.md` 生成、读取和路径解析 | 删除，不保留跨会话 memory 文件 |
| MemoryPort / memory adapter | Orchestrator commit 后重建 memory | 从 Ports、装配和 Orchestrator 中删除 |
| 独立 visualizer | `startVisualizer`、standalone 入口、`open_visualizer` | 删除；路由和静态服务 helper 留给 unified-server |
| PI CLI 应用链路 | launch-pi、扩展快照/重装/开关、sync 到 `.pi/extensions` | 删除；Tauri 壳、unified-server 和非 PI 项目管理保留 |

## 三、关键依赖关系

### 3.1 删除旧模块前必须迁移的 3 组产物

| # | 新架构引用方 | 旧产物 | 迁移去向 |
|---|---|---|---|
| 1 | [src/agents/tools.ts](file:///d:/claude/pi-ex/narrative-engine/src/agents/tools.ts) | `retrievalPlanSchema` / `characterActionSchema` | 内联到 agents/tools.ts |
| 2 | [src/chat/scheduler-tools.ts](file:///d:/claude/pi-ex/narrative-engine/src/chat/scheduler-tools.ts) | `validateStoryTime` | 内联到 chat/scheduler-tools.ts |
| 3 | [scripts/orchestrator-mcp.ts](file:///d:/claude/pi-ex/narrative-engine/scripts/orchestrator-mcp.ts) | `resolveWorldGraphDir` | 迁入 src/orchestrator/assembly.ts |

`@pi/scheduler` 的 prompts、chapter-edit、types、chapter-resolver、static-card-loader、utils、debug 仍被新架构使用，继续从子包导出，不计入迁移组数。

### 3.2 工具数量口径

| 类别 | 数量 | 处理 |
|---|---:|---|
| world_* | 18 | 迁移为 SDK customTools |
| render_* | 5 | 迁移为 SDK customTools |
| role_* | 2 | 迁移为 SDK customTools |
| import_* | 2 | 迁移为 SDK customTools |
| 旧 scheduler_* | 3 | 删除；由现有 4 个 SDK 调度工具取代 |
| `open_visualizer` | 1 | 删除；visualizer 由 unified-server 固定承载 |
| **旧 PI 工具合计** | **31** | **27 个迁移，4 个删除** |
| **最终 SDK 工具合计** | **31** | **27 个迁移工具 + 4 个现有调度工具** |

SDK 工具公共底座只需要 `wg`、`search`、`embedder`、`cwd`、`currentStoryTime`、`llmStore` 等业务上下文；不再携带 `visualizerServer`、skills 或 memory 状态。

### 3.3 skills / memory 删除面

- 删除 `src/skills/` 与 `tests/prompts.test.ts` 中 skills 资产测试。
- 删除 [src/memory.ts](file:///d:/claude/pi-ex/narrative-engine/src/memory.ts) 与 [tests/memory.test.ts](file:///d:/claude/pi-ex/narrative-engine/tests/memory.test.ts)。
- 删除 `MemoryPort`、`createMemoryAdapter`、assembly 注入和 Orchestrator commit 后的 memory update/error 汇总。
- 删除旧 world/scheduler 工具中的 `updateMemory` 调用；业务状态以世界图和章节产物为准。
- 删除 [scripts/build.mjs](file:///d:/claude/pi-ex/narrative-engine/scripts/build.mjs) 中 skills 与 references 复制逻辑。

### 3.4 visualizer 统一边界

保留：

- `visualizer-ui/` 唯一前端资产。
- `src/visualizer/routes.ts` 世界图 API。
- `serveStatic`、`readBody`、默认 UI 路径解析等 unified-server 仍需的静态服务 helper。
- unified-server 与 ProjectRegistry 绑定活跃项目的路由模式。

删除：

- `open_visualizer` 及其 SDK 迁移计划。
- `SessionState.visualizerServer` 和 ChatContext 的 visualizer server Map。
- `startVisualizer`、`src/visualizer/standalone.ts`、`scripts/visualizer.mjs`。
- 只验证独立 server 的 [tests/visualizer-server.test.ts](file:///d:/claude/pi-ex/narrative-engine/tests/visualizer-server.test.ts)；等价 API/静态服务覆盖并入 unified-server 测试。

### 3.5 PI 应用链路删除面

- 删除 `/api/projects/launch-pi`、`launchPi`、启动参数/终端拉起实现及对应测试；`@pi/novel-launcher` 保留项目发现、创建和打开目录能力。
- 删除 `/api/admin/extension/mode`、`update-check`、`reinstall`，以及 admin 中扩展安装配置、快照复制与对应测试。
- 删除前端项目页“启动 PI”入口、设置页扩展开关/检查/重装入口及 API 封装。
- 删除 `package.json` 的 `pi.extensions` 字段和 [scripts/sync.mjs](file:///d:/claude/pi-ex/narrative-engine/scripts/sync.mjs) 项目级扩展部署脚本；相应移除 `dev` / `sync` 脚本。
- 调整 sidecar 打包脚本，删除 extension-snapshot 构建、复制、参数和文案；Tauri 继续只启动 unified-server sidecar。
- 删除 `src/app/main.ts`、UnifiedServerOptions 和测试夹具中的 `extensionSnapshotDir`。

## 四、测试与验证口径

2026-08-01 在当前代码上实际运行 `npm test`：**663 tests / 663 pass / 0 fail**。原执行计划中的“646 例”是过期数量。

清理会主动删除旧流水线、skills/memory、独立 visualizer、PI launch/extension 管理测试，因此实施后的测试总数必然低于 663。验收不得写死“仍为 663”，应采用以下口径：

1. 每个迁移域补齐或改写等价 SDK 工具测试。
2. 删除测试必须能对应到已删除的产品能力，不得借清理掩盖仍保留能力的覆盖缺口。
3. `npm test` 最终 `fail=0`、`cancelled=0`。
4. `npm run build` 成功。
5. 全量 grep 确认 PI 扩展、skills/memory、独立 visualizer、PI 应用链路和旧流水线无残留引用。
6. 最终测试数在实施报告中记录，不在执行前臆测固定值。

## 五、结论

清理后的唯一运行形态是：Tauri 或命令行启动 unified-server，主会话通过 PI SDK 的 `createAgentSession + customTools` 工作，visualizer-ui 由同一服务承载。实施顺序应先迁移 3 组依赖和 27 个业务工具，再删除 PI 扩展、skills/memory、独立 visualizer、PI 应用链路与 scheduler 旧流水线，最后按动态测试口径全量验证。实施路径见 `docs/plans/2026-08-01-old-code-cleanup-execution-plan.md`。
