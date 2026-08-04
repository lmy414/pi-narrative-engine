# 生产差距 bug 清单与业务线扫描（2026-08-03）

> 来源：frontend-demo 切换真实后端（unified-server，`--project novel --embed`）后的浏览器实测。
> 两轮排查：①四条业务线全面逻辑扫描；②用户实测四个专项 bug 定位。
> 本文档只做定位与修复方向，不含代码改动；修复按优先级单独排期。

## 0. 背景

- 前端 `frontend-demo/` 默认走真实同源 `/api/*`（`api-client.js`），`?mock=1` 才用 `ApiMock`。
- 真实 LLM 主链路（聊天 SSE、编排 plan/yolo、章节落盘）已验证可跑通。
- 大量问题是"mock 好真实坏"模式：mock 忽略参数/保留冗余字段，真实后端严格校验/精简 DTO。

---

## 1. 业务线扫描

### 1.1 会话管理（前后端能力严重错位）

**后端现实**

- 一个项目同时只有一个主会话；`MainSessionHost.start()` 固定 `SessionManager.create()`，每次 host 启动必然新建 session id，从不恢复上次会话（`src/chat/main-session.ts:91`；SDK 侧 `options?.id ?? createSessionId()`）。
- 没有新建/切换/恢复/删除会话的 HTTP API；`/api/chat/sessions` 只读。
- host 懒启动：前端进入 studio 即订阅 SSE → 立即创建新 session（即使不发消息）。每次服务重启 + 打开 studio = 一个会话碎片。
- live 会话在首条消息写入前不在列表里（文件尚未落盘），此时前端只能回退旧会话。

**前端行为（提供了后端不支持的能力）**

- 「新建议程」创建 `session-<ts>` 假会话（`frontend-demo/views/studio.js:707`），点击后 `getChatMessages` 404 → 消息清空 + 错误 toast（"切换错误"的主要来源）。
- 切换旧会话只是"看历史"，发送永远写入 live 会话；`agent_end` 后视图弹回 live，用户视角为"乱切"。

### 1.2 聊天消息流（主链路已通，边角脆）

- busy 标志只由 `agent_end` 复位；LLM 运行异常时 SDK 是否必发 `agent_end` 未验证，若不发则发送按钮永久禁用（风险项）。
- 前端从不读 `/api/chat/status.isStreaming`：切走再回来不知后台仍在生成，可能撞 409 `CHAT_BUSY`。
- 输入错误只 toast，气泡内无错误消息；附件/加粗等按钮全是 demo 占位（`studio.js:1123`）。
- 历史 assistant 消息的 provider/model/usage DTO 已有但 UI 不展示。

### 1.3 编排/执行计划（断点最多，含真实服务器实证）

真实 status 实证：一次编排实际成功（planner 21s + role 70s，章节已写盘），但——

1. **队列长度语义错误**：`queue.length` 是历史累计（条目永不移除，`src/event-queue.ts`），前端当活跃数 → 跑过一次后永远显示"N 个任务执行中"（`studio.js:1177`）。
2. **status 轮询载荷爆炸**：每 2s 返回全部队列条目含完整 OrchestratorResult（角色产出全文 + 章节正文×2），单次超 50KB 且无限增长（`src/orchestrator/service.ts:173` 把 `result` 全量挂条目上）。
3. **队列错误完全不可见**：`retrieval_plan` 工具被模型提交非法参数时队列条目记 error（`src/agents/collect.ts:47`），studio 无任何展示 → "派发后什么都没发生"（实测踩到过）。
4. **plan 出现前有 ~90s 真空期**：前半链路跑完才入 plans，期间 stages 侧栏无数据（`studio.js:469` 只读 planDetails）。
5. **轮询竞态**：`stLoadPlanDetails` 用 Promise.all 抓 detail，间隙中 plan 被 commit → 404 → 整个轮询周期抛错、每 2s toast 轰炸（`studio.js:89`）。
6. **yolo 模式结果无处展示**：结果只在队列条目里，无卡片无章节提示。
7. demo 残留：派发面板硬编码"让艾莉亚在第七星港…"、默认 storyTime `ch006.ev008`（`studio.js:403,415`）；dispatch 要求 characterIds 非空，不选提及直接派发必 400。

### 1.4 图/事件加载（真实模式必坏）

- `graphLoadData`/`eventLoadData` 都是先 `getGraph(App.storyTime)` 后初始化 App.storyTime（`graph.js:51-60`、`events.js:47-63`）。storyTime 未初始化时真实后端直接 400 `STORY_TIME_REQUIRED`；mock 忽略该参数所以 mock 不坏 —— 首次进图/事件页必报错。

---

## 2. 专项 bug 定位

### Bug 1：文件面板不显示文件名 —— DTO 错位

- 后端 `/api/files/tree` 节点为 `{path, kind, size, mtime, children}`，**没有 `name` 字段**（`src/app/routes-ext.ts:219` → `listFileTree`）。
- 前端树渲染直接用 `node.name`（`frontend-demo/views/files.js:195,209-210`）→ undefined → 空白。
- mock 的 `getFileTree` 保留了 fixture 的 `name`（`api-mock.js:447-454`），mock 不坏。
- 修法（二选一）：后端补 `name: basename(path)`；或前端 `flLoadData` 派生 `name = flBasename(path)`。

### Bug 2：新建角色不出现在事件图 —— 三个叠加因素

1. **storyTime 卡住不前进**：`graphLoadData`/`eventLoadData` 只在 `App.storyTime` 为空时初始化（`graph.js:58`、`events.js:61`）。编排 commit 写入新时刻后 App.storyTime 停旧值 → 晚于该时刻诞生的实体按双时态规则正确不可见，但用户无感知。
2. **快速记事件 birth 表单太简陋**：只有 eventId/type/storyTime/entityId/summary（`app.js:462-471`），无 entityType 和 newFacts.name → 无名实体，所有视图显示原始 `ent_char_xxx`。
3. **entityIndex 快照陈旧**：事件视图实体筛选列表来自事件流（新 birth 会出现），但名字查 entityIndex（旧 storyTime 图快照）→ 显示 entityId。

### Bug 3：切换逻辑 —— 项目切换状态污染（最重）

`activateProject`（`app.js:366-390`）只更新 `App.activeProject/storyTimes/storyTime`，不清理任何视图状态：

- `viewState('studio')`：旧项目会话列表、消息、currentSessionId；
- `viewState('files')`：旧项目打开的 tabs（readFile/writeFile 打到新项目根下 → 404 或串写）；
- `viewState('graph'/'events')`、全局 `entityIndex`、plan details：全是旧项目数据，直到 F5。

次要：文件 Tab 切换整视图重建（`flSwitchTab` → `renderView`），编辑器光标与撤销栈丢失。

### Bug 4：世界图写入后需 F5 —— 三层机制

1. **驻留视图无失效**：loader 只在 `navigate`/`render()` 时跑（`app.js:564`），停留在图页时 studio 的 commit 不触发任何刷新。
2. **storyTime 不前进**：同 Bug 2-①，即使重新进图看到的仍是旧时刻。
3. **storyTimes 列表陈旧**：`stepStoryTime` 步进基于旧列表，到不了新时刻。

---

## 3. 会话管理落地方案（按 PI 本体路径）

`AgentSessionRuntime` 已内置全部原语（`pi-ex/packages/coding-agent/src/core/agent-session-runtime.ts`）：

| 方法 | 语义 | 位置 |
|---|---|---|
| `newSession({parentSession?, setup?, withSession?})` | teardown 当前 → `SessionManager.create` 新建 → 工厂闭包重建 runtime（同模型同工具） | :212 |
| `switchSession(sessionPath, {cwdOverride?})` | `SessionManager.open` 打开既有文件 → teardown("resume") → 重建 | :187 |
| `fork(entryId, {position})` | 从某条 entry 分支（可做"从此处分叉"） | :246 |

生命周期钩子：`session_before_switch`（可取消）→ `session_shutdown` → 重建 → `rebindSession`。CLI 层另有 `--session/--resume/--fork/--no-session` 与 `resolveSessionPath`（id 前缀匹配，可借鉴做 HTTP 端 id 解析）。

**我方落地路径**：`MainSessionHost` 已持有该 runtime（`src/chat/main-session.ts:55`），`start()` 的 `createRuntime` 闭包捕获 `this.opts`（model/customTools）——直接调 `runtime.newSession()` / `runtime.switchSession(path)` 即可，无需 dispose 重建 host。

HTTP 侧新增：

- `POST /api/chat/sessions`（新建会话，对应 runtime.newSession）
- `POST /api/chat/sessions/:id/activate`（切换，SessionManager.list 找 path → runtime.switchSession）

配合已有的 sessions `live` 标记与 status `sessionId`，前端"新建议程"与会话切换即从假实现变为真实现。host 启动时亦可借此恢复最近会话，治理会话碎片。

---

## 4. 修复优先级建议（待排期）

| 优先级 | 事项 |
|---|---|
| P0 | storyTime 初始化顺序（先 status 后 graph）；queue.length 语义（活跃 vs 累计）；status 轮询瘦身（items 只给摘要）；队列错误可见化 |
| P1 | planDetail 轮询竞态容错；yolo 结果呈现；编排阶段进度接入 studio（复用 debug span）；文件树 name 字段 |
| P2 | 会话管理按 §3 落地（新建/切换/启动恢复）；项目切换全量状态重置；驻留视图失效机制（如 commit 后广播或轮询失效标记）；busy 对齐 isStreaming；demo 残留清理 |

## 5. 已修复并验证（本轮之前）

- SSE 头部延迟 30s 才冲刷（空缓冲时）→ 两处 handler 加 `flushHeaders()` + `:connected` 首条注释（`src/debug/sse.ts`、`src/app/routes-chat.ts`），带回归测试。
- 事件链点击跳顶 → `eventSelectEvent` 改定向 DOM 更新（`events.js:395`）。
- 聊天 agent_end 后内容被旧会话覆盖 → sessions 加 `live` 标记、status 加 `sessionId`，前端 `stResolveSessionId` 一律对齐 live 会话。
- `collectSubmission` 工具失败导致 Node 24 未处理 rejection 崩溃 → 立即 rejection observer（`src/agents/collect.ts:39`）。

## 6. 批次 1 修复状态（2026-08-04）

> 第二阶段批次 1（分支 `20260804-orch-skeleton-security`）针对本清单 §1/§2/§4 的修复状态。详细执行记录见 `docs/plans/2026-08-04-phase2-plan.md` 附录 A。

### §4 优先级建议对应修复

| 优先级建议 | 状态 | 证据 |
|---|---|---|
| P0：queue.length 语义（活跃 vs 累计） | ✅ fixed | `event-queue.ts` 新增 `activeCount` getter；`service.ts` `queueStatus` 新增 `active` 字段；`studio.js` 状态栏改用 `active` |
| P0：status 轮询瘦身（items 只给摘要） | ✅ fixed | `service.ts` `queueStatus` 移除 `result` 全量挂载，改 `resultSummary` 摘要（mode/planId/outputCount/errorCount/chapterPath/appliedEventIds/writtenTextLength） |
| P0：队列错误可见化 | ✅ fixed（批次 2） | `studio.js` stRenderQueueStatus 新增 `#st-queue-errors` 展示 error 条目文案 |
| P1：planDetail 轮询竞态容错 | ✅ fixed | `studio.js` `stLoadPlanDetails` 改 `Promise.allSettled` + 404 静默 |
| P1：yolo 结果呈现 | ✅ fixed（批次 2） | `studio.js` stYoloResultCardHtml + stPlanCardsHtml 统一渲染 yolo 结果卡 |
| P1：编排阶段进度接入 studio | ⏳ 推批次 3 | 留待批次 3 |
| P1：文件树 name 字段 | ✅ 历史已修 | BUG-001 fixed（2026-08-03-fix-frontend-4-bugs） |
| P2：会话管理按 §3 落地 | ❌ 暂不做 | 用户决策：G2 全部暂不做，含假会话 404 toast |
| P2：项目切换全量状态重置 | ✅ 历史已修 | BUG-003 fixed |
| P2：驻留视图失效机制 | ✅ 历史已修 | BUG-004 fixed |
| P2：busy 对齐 isStreaming | ✅ fixed | `studio.js` `stStartRealRuntime` 拉 `/api/chat/status.isStreaming`；`api-client.js` 新增 `getChatStatus` |
| P2：demo 残留清理 | ✅ fixed（批次 2） | `studio.js` 移除硬编码艾莉亚/ch006.ev008，空值校验引导 |

### §1.1 假会话 404 toast

- **状态**：❌ 暂不修（用户决策）
- **理由**：G2 整体暂不做，假会话 404 toast 与真会话功能一并解决

### §1.2 host 懒启动 + 每次 host 启动新建会话碎片

- **状态**：❌ 暂不做（用户决策）
- **理由**：同上，依赖 G2-3 启动恢复最近会话
