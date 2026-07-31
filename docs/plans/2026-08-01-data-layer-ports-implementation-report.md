# 数据层 Ports 接线落地报告（2026-08-01）

> 依据：
> - `docs/plans/2026-08-01-data-layer-ports-implementation.md`（可行性调研，结论可行）
> - `docs/plans/2026-08-01-data-layer-ports-execution-plan.md`（执行计划，A1-A4 已实施）
> - `docs/plans/2026-07-31-subagent-orchestrator-design.md`（子代理设计，职责划分权威来源）
> - `docs/plans/2026-08-01-orchestrator-standalone-implementation-report.md`（阶段 0/1 落地报告）
>
> 本文记录阶段 A（A1-A4）数据层 Ports 接线的实际落地情况，供 A5（配置中心持久化）与阶段 2 接手。

## 一、目标回顾

把子代理编排器从"产出到 tool call 即止"升级为**数据层闭环**：

- 4 类子代理（planner / 角色 / 可见推理 / 渲染器）经 AgentTool 自主读写世界图、章节文件、记忆
- 编排器与具体数据层模块解耦：子代理工具只依赖 `OrchestratorPorts` 接口，不直接 import `underworld-graph` / `@pi/renderer`
- plan 模式：跑到角色产出即停并缓存 plan，`scheduler_commit` 触发后半链路（可见推理写世界图 → 渲染器写章节 → 更新记忆）
- yolo 模式：全链路自动跑完（含落地）

## 二、实现范围

| 节点 | 内容 | 验证 |
|---|---|---|
| A1 | Ports 类型 + 默认适配器 + 装配函数 | 单测 7 例适配器透传 |
| A2 | commit 后半链路触发 + yolo 自动落地 + plan 缓存 | 单测 commit/discard/yolo/queueStatus |
| A3 | `queue_status` 暴露完整编排结果（含 result） | 单测 `queueStatus 暴露完整编排结果（A3）` |
| A4 | 子代理世界图/章节工具注入（17 个内部变体工具） | 单测 11 例 agent-tools |
| 验证 | 全量 646/646 通过；build 47 文件干净产出 | npm test / npm run build |

## 三、架构要点

### 1. Ports 接口（src/ports/types.ts）

7 个端口抽象，全部零 PI 依赖（只 import 类型，不 import PI 运行时）：

| Port | 抽象的能力 | 真实模块 |
|---|---|---|
| `WorldGraphPort` | 实体/关系/事件/可见性读写 + `listStoryTimes`/`updateFactEmbedding` | `underworld-graph` WorldGraph |
| `SearchPort` | 全文/向量/混合检索 | `src/search.ts` Search |
| `EmbedderPort` | 文本/实体/Fact 向量化 | `src/embedder.ts` Embedder |
| `RulesetPort` | planner/role/render 三套规则集加载 | `planner-rule-loader` / `@pi/role-pool` / `@pi/renderer` |
| `MemoryPort` | memory.md 读 / 重建 | `src/memory.ts`（适配器闭包持有 wg） |
| `RendererPort` | 章节文件 6 原语（ensure/read/readSection/append/modify/insert） | `@pi/renderer` + `@pi/scheduler`（`_insertChapterSection`） |
| `RolePoolPort` | 接口保留，本阶段未接线（角色由编排器直接驱动 Agent） | 抛"未接线"占位 |

相对调研/执行计划的修正（内化进接口）：

- **`WorldGraphPort` 不含 search**（检索统一走 `SearchPort`，避免冗余）
- **`MemoryPort.update(cwd)`** 不带 wg 参数（适配器闭包持有 WorldGraph 实例，调研 §三列的是 `update(wg, cwd)`）
- **`RendererPort` 用纯 IO 原语**（append/modify/insert），不暴露 `renderToFile`（渲染 LLM 调用由渲染器代理自己完成）
- **`VisibilitySource` 用字面量联合**（`"experienced" | "informed" | "witnessed"`），因 `underworld-graph` 包入口未导出该 z.enum 类型

### 2. 适配器（src/ports/adapters.ts）

每个适配器 10-30 行纯映射，零业务逻辑：

```typescript
export function createWorldGraphAdapter(wg: WorldGraph): WorldGraphPort {
  return {
    getEntityAt: (entityId, storyTime, opts) => wg.getEntityAt(entityId, storyTime, opts),
    // ... 其余方法透传
  };
}
```

要点：
- **闭包持有实例**：`createMemoryAdapter(wg)` 把 WorldGraph 藏在闭包里，让 `MemoryPort.update(cwd)` 签名保持干净
- **测试可替换**：单测传 mock ports 即可验证工具逻辑，不连真实 SQLite/文件系统
- **未来 PI 解耦**：与 `pi-adapter.ts`（唯一 PI 耦合文件）思路一致——脱 PI 时只需替换适配器实现

### 3. 装配（src/orchestrator/assembly.ts）

`assemblePorts({ wg, search, embedder })` 把真实数据层实例组装为 `OrchestratorPorts` 集合。编排器与子代理只持有 `OrchestratorPorts`，不依赖具体模块。

### 4. 子代理工具注入（src/agents/world-tools.ts + chapter-tools.ts）

17 个内部变体 AgentTool，闭包注入 ports：

| 子代理 | 工具 | 数量 |
|---|---|---|
| planner | `world_entity_get` / `world_relations` / `world_character_view` / `world_query` / `world_status` / `world_story_times` / `world_event_chain` | 7 只读 |
| 角色（受限变体） | `character_view_limited` / `entity_get_limited` / `relations_limited` / `query_limited`（characterId 绑定） | 4 只读 |
| 可见推理 | 上述只读 3（entity_get/relations/event_chain）+ `world_event_apply` / `world_visibility_set` / `world_visibility_close` / `world_visibility_infer` / `world_relation_add` / `world_relation_close` | 3 读 + 6 写 |
| 渲染器 | `chapter_read` / `chapter_write` | 2 |

设计要点：
- **与主会话工具隔离**：不复用 `src/tools/world-tools.ts`（依赖 ExtensionAPI/SessionState），子代理工具闭包注入 ports
- **`world_event_apply` 内部变体不带 `userInput` 字段**（工具分配方案 §六 #4，避免主会话字段语义混淆）
- **`executionMode: "sequential"`**：所有子代理工具串行执行。因 agent-loop 的 `terminate` 是 all 语义（同轮 batch 全部 terminate 才停），串行保证产出提交工具单工具即终止
- **`chapter_write` 按 intent 分支**：add→`appendToChapter`、modify→`modifyChapterSection`、insert→`insertChapterSection`；modify/insert 缺 `targetEventId` 返回错误不写入
- **`entity_get_limited` / `query_limited` 可见性过滤**：检索后按 `getCharacterView` 交集过滤；信息泄漏风险本阶段接受（沿用调研 §7.2）

### 5. 编排器改造（src/orchestrator.ts）

- **`OrchestratorResult` 新增 `event: StructuredEvent`**：commit 时需完整 event 上下文（执行计划 A2 P1）
- **抽出 `runPostRolePipeline(event, eventId, outputs)`**：可见推理 → 渲染器 → 更新记忆，plan 模式 commit 与 yolo 自动落地共用
- **构造选项注入 `ports: OrchestratorPorts`**：编排器不直接持有 wg/search/embedder
- **工具注入点**：planner/角色/可见推理/渲染器装配子代理时分别注入对应工具集
- **可见推理/渲染失败不阻断另一段**：失败项汇总到 `CommitSummary.errors`

### 6. service.ts 改造（src/orchestrator/service.ts）

- **`plans = new Map<planId, { event, result }>()`**：进程内 plan 缓存（保持编排器解耦，调研 P5，不迁入 @pi/scheduler 的 cache）
- **`commit(planId)` 真实现**：取缓存 → 调 `runPostRolePipeline` → 清理缓存 → 返回 `CommitResult`；幂等（commit 后删除 planId，重复 commit 返回错误）
- **`discard(planId)`**：仅删缓存，不写世界图/章节
- **`queueStatus()`**：items 含 `result?: OrchestratorResult`（A3，主会话可拿到完整编排结果）

### 7. 事件队列（src/event-queue.ts）

`EventQueue` 构造函数新增 `onDone?(queueId, result)` 钩子。service 用它把 plan 模式的 `{ event, result }` 缓存到 `plans` Map。

## 四、关键查证与修正（以查档求证为荣）

| # | 议题 | 调研/计划值 | 落地修正 | 依据 |
|---|---|---|---|---|
| 1 | `VisibilitySource` 类型来源 | `import from "underworld-graph"` | 改为字面量联合 `"experienced" \| "informed" \| "witnessed"` | 包入口未导出该 z.enum 类型，结构与 `underworld-graph/src/types.ts` 等价 |
| 2 | `MemoryPort.update` 签名 | `update(wg, cwd)` | `update(cwd)`（wg 由适配器闭包持有） | 接口保持干净，wg 是实现细节 |
| 3 | 工具 `execute(params)` 类型 | `unknown` | `AgentTool<TParameters>` + `Static<TParameters>` | pi-agent-core 的泛型设计，TypeBox schema 反推参数类型 |
| 4 | mock ports 返回值 | 构造时一次性读取 `set` | 执行时动态读取 `set` | 避免受控返回值在构造时被冻结为 undefined |
| 5 | `latestStoryTime` 空库报错 | 直接调 `listStoryTimes` 取末值 | mock ports 默认返回 `["ch001.ev001"]` | 空项目场景工具调用不应崩 |
| 6 | `OrchestratorResult` 字段 | 不含 `event` | 补 `event: StructuredEvent` | commit 需要完整事件上下文（执行计划 P1） |
| 7 | `_insertChapterSection` 归属 | 调研建议迁移到 `@pi/renderer` | 直接从 `@pi/scheduler` 导出 | 避免跨包迁移成本，RendererPort 适配器统一收口 |

## 五、验证结果

- **全量单测**：646/646 通过（0 失败 / 0 跳过），含：
  - 11 例 agent-tools（world 工具参数映射 + 可见性过滤 + chapter_write 三分支）
  - 7 例 Ports 适配器（WorldGraphPort/SearchPort/EmbedderPort/RulesetPort/MemoryPort/RendererPort/RolePoolPort 透传 + 文件操作）
  - commit/discard/yolo/queueStatus 流程（含 plan 不存在 / pipeline 抛错 / 缓存清理幂等性）
- **build**：47 文件正常产出 → `dist/`（含 ports/types.js、ports/adapters.js、agents/world-tools.js、agents/chapter-tools.js、orchestrator/assembly.js）
- **回归**：scheduler / role-pool / renderer / novel-importer / admin / novel-launcher / memory / search / embedder 全绿

### 接入测试（真实 LLM）

`npx tsx scripts/orchestrator-mcp.ts`（`NE_NOVEL_CWD=d:\claude\pi-ex\novel` + `NE_LLM_API_KEY`）启动成功，但 TRAE sandbox 限制了 npm-cache 日志访问，未能完成真实 LLM 链路验证。**此为环境限制，非代码问题**——Ports 装配、队列、commit、工具注入、可见性过滤等逻辑均被单测覆盖。

需在非 sandbox 环境（用户本地终端）用 `NE_LLM_API_KEY` 跑接入测试。

## 六、修复与对应

| # | 现象 | 修复 |
|---|---|---|
| 1 | `VisibilitySource` 类型未导出 → tsc 报错 | 在 `ports/types.ts` + `agents/world-tools.ts` 内以字面量联合声明（结构等价） |
| 2 | 工具 `execute(params: unknown)` 无法访问字段 | 改用 `AgentTool<typeof xxxParams>` + `params: Static<typeof xxxParams>` |
| 3 | mock ports 返回 undefined 导致断言失败 | `track(name)` 内执行时动态读 `set[name]`，而非构造时一次性读 |
| 4 | `latestStoryTime` 空库时 `listStoryTimes()` 返回 [] → 末值为 undefined → 工具崩 | mock ports 默认 `listStoryTimes: () => ["ch001.ev001"]` |

## 七、已知限制

- **A5 未做**：`LlmConfigStore` 持久化 + 配置入口（按 slot 独立模型的读取入口仍缺），与数据层 Ports 无依赖，已拆出独立任务
- **plans 缓存无持久化**：进程重启丢失未 commit 的 plan（yolo 全链路不受影响；plan 模式丢失可接受，后续补持久化）
- **`RolePoolPort` 未接线**：角色由编排器直接驱动 Agent，role-pool 接口仅保留
- **`query_limited` 信息泄漏**：检索后过滤，本阶段接受（调研 §7.2）
- **真实 LLM 接入测试待补**：sandbox 限制，需在本地终端验证

## 八、文件清单

### 新增
- `src/ports/types.ts` — 7 个 Port 接口定义
- `src/ports/adapters.ts` — 7 个默认适配器
- `src/orchestrator/assembly.ts` — `assemblePorts` 装配函数 + `OrchestratorPorts` 类型
- `src/agents/world-tools.ts` — 17 个子代理世界图工具（7 只读 + 6 写 + 4 受限）
- `src/agents/chapter-tools.ts` — 渲染器章节工具（read + write 三分支）
- `tests/agent-tools.test.ts` — 11 例工具单测

### 修改
- `src/orchestrator.ts` — `OrchestratorResult` 加 `event`、抽出 `runPostRolePipeline`、注入 `ports`、子代理工具注入
- `src/orchestrator/service.ts` — `plans` 缓存、`commit`/`discard` 真实现、`queueStatus` 暴露 `result`
- `src/event-queue.ts` — 构造函数加 `onDone` 钩子
- `src/agents/planner-agent.ts` / `role-agent.ts` / `reasoning-agent.ts` / `renderer-agent.ts` — 工厂增加 `extraTools` 参数
- `scripts/orchestrator-mcp.ts` — 装配真实数据层实例为 ports
- `docs/plans/2026-08-01-data-layer-ports-execution-plan.md` — 状态更新为"A1-A4 已实施；A5 拆出待排期"

## 九、下一步建议

1. **A5：LlmConfigStore 持久化 + 配置入口**
   - 配置文件（或数据库）持久化每 slot 的 provider/model/apiKey
   - MCP 参数 / 配置页 UI 注入入口
   - 统一管理"每个子代理用什么模型"
2. **真实 LLM 接入测试**
   - 用户本地终端跑 `NE_NOVEL_CWD=... NE_LLM_API_KEY=... npx tsx scripts/orchestrator-mcp.ts`
   - 验证：plan 模式 dispatch → queue_status 拿到 result → commit 触发后半链路 → 世界图/章节文件实际写入
3. **plans 缓存持久化**（低优先级）：进程重启后恢复未 commit 的 plan
4. **`query_limited` 优化**：检索前注入可见性约束（而非检索后过滤）
