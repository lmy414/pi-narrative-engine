# 前端 Demo × 后端 API 核对报告

> 日期：2026-08-02
> 范围：`frontend-demo/`（ApiMock + 各视图消费）对照 unified-server 真实路由（`src/app/unified-server.ts`、`routes-ext.ts`、`routes-chat.ts`、`routes-scheduler.ts`、`src/visualizer/routes.ts`，以源码为准）
> 结论先行：**envelope 与错误码体系整体一致，主干只读链路（项目/状态/世界图/事件）基本可直接对接；主要缺口集中在 ① 包装层差异（真实端点多包一层 `{tree|projects|slots|rulesets|values|data}`）② chat/scheduler/debug 的 mock 模型比真实 API 丰富或schema 不同 ③ app-config/embedder 字段集不一致 ④ SSE 流式端点 demo 无对应物。**

## 1. 总体一致性

| 维度 | 状态 | 说明 |
|---|---|---|
| 响应 envelope | ✅ 一致 | 均为 `{ ok, data, error: { code, message } }`；mock 额外带 `_status` 映射 HTTP 状态码，与真实状态码语义一致 |
| 错误码命名 | ✅ 基本一致 | `NO_ACTIVE_PROJECT` / `MIGRATION_REQUIRED` / `MTIME_CONFLICT` / `FILE_EXISTS` / `DECLARATION_NOT_FOUND` / `DECLARATION_CLOSED` / `PLAN_NOT_FOUND` / `SESSION_NOT_FOUND` / `TEMPLATE_NOT_FOUND` 两侧相同 |
| 活跃项目门控 | ⚠️ 基本对齐，3 处例外 | 见 §4.3 |
| ApiMock 覆盖度 | 61 个方法，4 个无消费方 | `search`（全局搜索已删）、`getChain`（因果图已删）、`renameFile` / `deleteFile`（已被 renameNode/deleteNode 取代）——建议从 mock 中删除或保留作 API 占位 |

## 2. 对齐良好、可直接对接的链路

以下链路 mock 与真实端点在参数、返回形状、错误码上均一致或仅有无害超集差异（真实返回字段多于 mock，消费方不读）：

- `GET /api/status` ↔ getStatus
- `GET /api/graph` ↔ getGraph（storyTime / includeClosed 语义一致）
- `GET /api/entities/:id` ↔ getEntity；`GET /api/entities/:id/history` ↔ getEntityHistory
- `POST /api/entities/:id/summary` ↔ updateSummary
- `POST /api/entities/:id/props` ↔ addProperty（消费方读的 `closedDeclarationId` 两侧都有）
- `POST /api/declarations/close` ↔ closeDeclaration（错误码完全一致）
- `POST /api/relations[/close]` ↔ addRelation / closeRelation
- `POST /api/entities/:id/kill` ↔ killEntity
- `GET /api/declarations/:declId/visibility` ↔ getVisibility；`POST /api/visibility[/close]` ↔ setVisibility / closeVisibility（真实端强制 `state:"known"`、`isExplicit:true`，mock 缺省同为 known，语义兼容）
- `GET /api/events` ↔ getEvents；`POST /api/events` ↔ addEvent
- `GET /api/files/read` ↔ readFile；`PUT /api/files/write` ↔ writeFile（错误码一致）
- `POST /api/chat/message` ↔ sendChatMessage（`{received:true}` 一致）
- `POST /api/scheduler/commit` / `discard` ↔ commitPlan / discardPlan
- `GET /api/admin/version` / `doctor` ↔ getVersion / getDoctor（doctor 真实多 `id/message/hint`，mock 只有 `name/status`，消费方也只读这两个，兼容）

## 3. 形状不一致（对接时必须处理的差异）

按影响排序。`mock → 真实` 表示需要做的适配。

### 3.1 包装层差异（真实端点在 data 里多包一层）

| 域 | mock 返回 | 真实返回 | 消费方现状 |
|---|---|---|---|
| scanProjects | 裸数组 `[...]` | `{ projects: [...] }` | 当数组迭代，对接后需改读 `.projects` |
| getFileTree | 裸数组，节点 `{type:'dir'\|'file', name, path, mtime, children, content}` | `{ tree: [...] }`，节点 `{path, kind:'dir'\|'file', size, mtime, children}` | 除包装外还有 **`type`↔`kind` 字段名差异**；真实不含 `content`（mock 文件节点内联内容） |
| getChatSessions | 裸数组 | `{ sessions: [...] }` | 需改读 `.sessions` |
| getChatMessages | 裸数组（富字段） | `{ id, messages: [...] }` | 见 §3.2 |
| getLlmStatus | 直接返回 5 槽位 map | `{ slots: {...} }` | 消费方直读 `llm[slot]`，对接后需 `.slots` |
| getRulesets | `{ render, role, planner }` → md 字符串 | `{ rulesets: [{ name, filename, path, exists, content, mtime, charCount }] }` | 结构完全不同，需重写取值逻辑 |
| getNovelJson | 直接返回 data 对象 | `{ path, exists, data }` | 需改读 `.data` |
| getEnvConfig | 直接返回 env 键值 | `{ path, exists, values, lineCount }` | 需改读 `.values`；且**删除键语义不同**：mock 用空串 `''`，真实用 `null` |
| getActiveProject | `open: [dir字符串]` | `open: [{dir, name, active}]` | 消费方只读 `active.dir`，影响低 |

### 3.2 模型/schema 差异（mock 与真实数据结构不同）

| 域 | 差异 | 影响 |
|---|---|---|
| **chat 消息** | mock 消息含 `name/roleTag/characterId/toolCalls[]`；真实 `GET /api/chat/sessions/:id/messages` 只有 `{role, text, ts}` | **创作编排页的工具调用卡片、角色发言样式在真实 API 下无数据源**——需要后端补充消息详情字段，或前端降级渲染 |
| **scheduler plans** | mock plan 含 `stages[]`（流水线阶段）与 `sections[]`（产出预览）；真实 status 的 plan 只有 `{planId, storyTime, mode, characterIds, outputCount, errorCount}` | **编排进度与产出预览无真实数据源**——需要后端加 plan 详情端点 |
| **debug 事件** | mock：`{id, level, module, stage, traceId, spanId, type, message, payload, stack, ts}`；真实 DebugEvent：`{id, ts, traceId, stage, status, input?, output?, durationMs?, error?, parentId?}` | **schema 基本不同**（level/module/message/payload vs status/input/output/durationMs）——调试页需按真实 schema 重写渲染 |
| **embedder** | mock：`{model, dimensions, warmedUp, cacheSize}`；真实：`{model, isDefault, dim, cachePresent, cachePath, cacheSizeBytes}`；warmup 返回 `{ok, latencyMs}` 而非 `{warmedUp:true}`；clear 返回 `{ok, clearedBytes}` | 字段名与语义均不同，设置页向量模型面板需重写取值 |
| **app-config** | mock 含 `theme/editorFontSize/autosave/autosaveInterval`（demo 偏好）；真实 app-config 只有 `{launcher, embedder, llm, scheduler}`，且 **PUT 只转发 launcher/embedder 两个子对象** | **当前 demo「主题持久化到 setAppConfig」在真实后端会被丢弃**——主题等 UI 偏好需另找落点（前端 localStorage 或推动后端扩展 app-config schema） |
| **createFile 行为** | mock 要求父目录存在（否则 FILE_NOT_FOUND）；真实自动创建父目录（HTTP 201） | 行为差异，真实更宽松，前端无需处理但测试预期不同 |
| **activateProject 错误码** | mock：`ENTITY_NOT_FOUND`；真实：`NOVEL_JSON_NOT_FOUND` / `WORLD_DB_NOT_FOUND` | 错误提示文案映射需更新 |
| **setRuleset 未知名** | mock：`TEMPLATE_NOT_FOUND` 404；真实：`MISSING_FIELD` 400 | 错误码不一致 |
| **setSchedulerMode 返回** | mock `{mode}`；真实 `{defaultMode}` | 消费方不读，影响低 |

### 3.3 真实有、demo 无对应物的端点

| 端点 | 说明 | 建议 |
|---|---|---|
| `GET /api/chat/events`（SSE） | 聊天流式输出 | demo 用预置脚本模拟，对接时是**最大改造点**（studio 页需接 SSE） |
| `GET /api/debug/stream`（SSE） | 调试事件实时流 | 调试页接 SSE 替换轮询/预置 |
| `GET /api/chat/status` | 会话状态（无需活跃项目） | studio 初始化时可用于展示连接态 |
| `GET /api/character-view` | 角色视角视图（必填 characterId+storyTime） | 世界图「全知视角」下拉的真实数据源，**demo 目前该下拉是纯摆设，未调任何接口** |
| `GET /api/projects/meta` | 单项目 meta | 项目页可用 |
| `GET /api/admin/pi-status` | pi 装配状态 | 设置页可用 |
| `GET /api/search` | 实体搜索（必填 q+storyTime，mode/type 可选） | mock 已对齐此形状；全局搜索框已删，后续重做搜索时直接可用 |

### 3.4 门控差异（活跃项目 409）

| 端点 | mock | 真实 |
|---|---|---|
| `PUT /api/scheduler/mode` | 需活跃项目 | **不需要** |
| `GET /api/chat/status` | （无此 mock） | **不需要** |
| `/api/debug/*` | 不需活跃项目 | **需要**（debug 路由在活跃检查之后分发） |

## 4. 消费侧备注

- **绕过 API 层**：`studio.js:564` 的 @提及列表直接读全局 `MOCK_ENTITIES`，对接时需改为 API 取数（getGraph 或 search）。
- **mock 提供但无消费方的返回字段**：`getChatSessions.messageCount`、scheduler plan 的 `outputCount/errorCount/characterIds/storyTime/mode`、`commitPlan.appliedEventIds/writtenText`、`addProperty.newDeclarationId`。
- **demo 自造、后端无对应的概念**：`MOCK_VISIBILITY` 的 `state:'suspected'`（真实只写 known）、studio 的 stages/sections（见 §3.2）。

## 5. 顺带发现：文档与源码的差异（docs/api 需修）

1. `visualizer.md` §11.1 整体过时：仍描述三入口/standalone/sync.mjs，实际已移除（源码 `server.ts` 头部有明确说明）。
2. `unified-server.md` 暗示存在 `GET /api/admin/rulesets/:name`——实际 404（只支持 GET 全量、PUT 单个、POST reset）。
3. `unified-server.md` 错误码表缺 `MODEL_NOT_READY`（`/api/chat/message` preflight 失败，HTTP 400）。
4. 文档称 `/api/chat/*` 整组需活跃项目——`GET /api/chat/status` 不需要；`PUT /api/scheduler/mode` 也是例外。
5. `/api/debug/*` 需活跃项目这一点两份文档均未写。
6. `unified-server.md` 称 app-config 可写 `llm`/`scheduler` 键——PUT 实际只转发 `launcher`/`embedder`。

## 6. 建议行动清单（对接前排）

1. **统一适配层**：在 apiCall 实现（真实 fetch 版）里集中处理 §3.1 的解包（`.projects/.tree/.sessions/.slots/.rulesets/.data/.values`），视图代码零改动或最小改动。
2. **后端补数据**（二选一或都做）：chat 消息富字段（toolCalls/roleTag）、scheduler plan 详情（stages/sections）——否则 studio 页两大块 UI 无数据源。
3. **调试页按真实 DebugEvent schema 重写**（level/module/message → status/input/output/durationMs/parentId）。
4. **主题等 UI 偏好改走前端 localStorage**（demo 现已如此），不依赖后端 app-config；如需云端同步再推后端扩展 schema。
5. **studio 接 SSE**（`/api/chat/events`）、debug 接 SSE（`/api/debug/stream`）。
6. **世界图「视角」下拉接 `/api/character-view`**（当前为纯摆设）。
7. 清理 mock 死接口（search/getChain/renameFile/deleteFile 的去留按后续规划）。
8. 修订 `docs/api/visualizer.md` §11.1 与 `unified-server.md` 的 6 处出入（§5）。

## 7. 后端可补性验证（2026-08-02 源码核实）

针对 §3.2/§3.3 的缺口逐项核实后端领域层，结论：**大部分缺口是「数据已存在，只缺暴露」，真正需要新增采集的只有两处。**

| 缺口 | 结论 | 证据与改动量 |
|---|---|---|
| chat 消息 toolCalls / usage / model | **数据已存在，只缺加工暴露** | 会话 JSONL（`<项目>/.pi/sessions/`）的 assistant 消息含完整 `toolCall` 块与 `provider/model/usage`，`chat-context.ts:279-288` 压扁成纯文本时丢弃——改 `extractMessageText` 加工逻辑即可；SSE 流（`routes-chat.ts:177-218`）原样透传 session 事件，实时工具调用天然可见 |
| chat 角色发言标签（characterId/roleTag） | **数据不存在，需新增采集** | 主会话只有一个 assistant；角色名只存在于编排器 `cast` / `RoleAgentOutput.actor`（orchestrator.ts:249-253），不落 chat session——需在编排器或消息写入处落标签 |
| scheduler plan 角色产出/cast/retrievalPlan | **数据已存在，只缺暴露** | `OrchestratorService.plans` Map 缓存完整 result（`outputs: RoleAgentOutput[]`、`cast`、`errors`），`listPlans()` 主动裁剪——加 `/api/scheduler/plans/:id` 是纯薄路由 |
| scheduler 流水线阶段（stages 耗时） | **数据存在但需加工** | 等价数据在 debug 总线：root span `orchestrator` + 子 span（status/durationMs/provider/model，orchestrator.ts:163-201）；traceId↔planId 关联在 root span end output 里，需按 traceId 聚合 |
| 章节正文预览（plan 阶段） | **数据不存在** | 渲染在 commit 后半链路才跑（`writtenText` 来自 `runPostRolePipeline` 的 render.text）——plan 阶段没有正文可预览，demo 的 sections 预览属自造概念，对接时应砍掉或改为预览角色产出 |
| debug 事件 | **已完整暴露** | schema 见 `src/debug/types.ts:15-39`；SSE 先重放 snapshot 再实时推（sse.ts:50-56）现成可用；注意纯内存环形缓冲（容量 1000），重启即失 |
| app-config UI 偏好（theme 等） | **存储通道已备好，改动面小** | `packages/admin/src/app-config.ts` 有写入白名单（剥离未知键）；加 `ui` section 需机械改 6 处（接口/默认值/读写合并/HTTP 白名单），测试在 `packages/admin/tests/app-config.test.ts` |
| character-view | **端点已完整，前端直接用** | `GET /api/character-view?characterId=&storyTime=` → `{view: StateDeclaration[]}`（含 modality/validFrom/validTo）；角色列表可用 `GET /api/graph` 的 entities 过滤 character |

**修订后的优先级**：

1. 薄路由就能拿到的：plan 详情端点（`/api/scheduler/plans/:id`）、chat 消息加工（toolCalls/usage 进 messages 响应）、app-config `ui` section——**都是小改动，建议先做**。
2. 需要加工的：stages 从 debug span 按 traceId 聚合（或后端直接落 plan 阶段记录，更干净）。
3. 需要新增采集的：chat 角色发言标签（编排器落标签到消息）。
4. 应砍掉的 demo 自造概念：plan 阶段的「章节正文预览」（真实流程 commit 后才渲染）；`MOCK_VISIBILITY` 的 suspected 态（真实只写 known）。
