# 前端需求文档（交付对接版）

| | |
|---|---|
| 版本 | v2.1 · 2026-08-02 |
| 读者 | 前后端实施与验收团队 |
| 目标 | 按本文的**目标契约**完成真实 API 接入与生产环境测试验证 |
| 实施基线 | narrative-engine @ master `76a8802` |
| 实施状态 | 目标契约已在 `20260802-frontend-backend-contract` 分支落地并通过自动化验证 |
| 设计原型 | `D:\claude\pi-ex\narrative-engine-design`（视觉/布局/组件规范的唯一依据） |
| 决策依据 | `docs/plans/2026-08-02-studio-data-alignment.md` |
| 配套文档 | `docs/frontend-backend-api-audit.md`、`docs/plans/2026-08-02-frontend-backend-handoff-plan.md`、`docs/api/unified-server.md`、`docs/api/visualizer.md`、`docs/api/chat.md` |

> 本文是前后端完成对接后的**唯一目标规格**。目标契约已按交接计划落地并通过自动化契约测试；生产环境仍按 §12 完成真实 LLM 与浏览器验收。不得把旧 mock 字段或临时适配写回目标规格。
>
> 契约优先级：若与 `docs/plans/2026-08-02-studio-data-alignment.md` 的早期口径冲突，以本文和 `docs/frontend-backend-api-audit.md` 为准。

---

## 0. 30 分钟快速接入

```bash
# 1. 启动后端（在 narrative-engine 目录）
node scripts/app-server.mjs --port 7421
#    可选：--project <小说工程目录> 预激活；--embed 启用向量检索（首次下载模型较慢）

# 2. 健康检查
curl http://127.0.0.1:7421/api/projects/active
# → {"ok":true,"data":{"active":null,"open":[]},"error":null}

# 3. 激活一个项目（唯一前置状态；多数端点依赖它）
curl -X POST http://127.0.0.1:7421/api/projects/activate \
  -H "content-type: application/json" -d '{"dir":"D:/claude/pi-ex/novel"}'

# 4. 拉世界图状态
curl "http://127.0.0.1:7421/api/status"
```

**接入四条军规：**

1. 所有响应都是信封 `{ ok, data, error: { code, message } }`——先判 `ok`，错误分支读 `error.code` 做针对性处理（错误码总表见 §2.3）。
2. **"活跃项目"是唯一全局门控**：带项目数据的端点在未激活时返回 `409 NO_ACTIVE_PROJECT`，前端统一兜底为"跳项目管理页"。
3. 写操作全部都是 POST（GET 只读）；body 为 JSON；路径穿越有防护（403）。
4. 服务同源部署（前端静态资源与 API 同端口 7421 伺服）；CORS 已收紧（2026-08-03 安全加固）：仅放行同源，恶意 Origin 请求返回 `403 ORIGIN_REJECTED`。

---

## 1. 系统的一页纸理解

- 这是一个**本地单服务应用**：`http://127.0.0.1:7421` 一个端口承载全部 API + 静态前端。无鉴权、无多用户、无云端。
- 核心领域对象：**世界图**（实体/声明/关系/可见性，全部带双时态：故事时间 storyTime + 闭合区间）。**所有修改都是事件**（事件溯源：没有原地改、没有物理删除，"改属性"= 闭合旧声明 + 写新声明，"删实体"= 退场事件）。
- **storyTime 是查询参数，不是服务器状态**。前端的"当前故事时间"是自己的 UI 状态，查询时随参数传（如 `/api/graph?storyTime=ch009.ev003`）。故事时间列表从 `/api/status` 的 `storyTimes` 拿。
- AI 能力两条线：**主会话**（聊天，SSE 流式）与**编排器**（规划→角色→推演→渲染四阶段流水线，dispatch/commit/discard 控制）。

## 2. 全局契约

### 2.1 信封与 HTTP 约定

- 成功：`200 { ok: true, data, error: null }`；失败：`{ ok: false, data: null, error: { code, message } }`（HTTP 状态码与 code 配套，见 §2.3）。
- `OPTIONS` 预检统一 204；JSON 解析失败 `400 INVALID_JSON`；未知路由 `404 NOT_FOUND`；兜底 `500 INTERNAL_ERROR`。
- POST body 缺必填字段统一 `400 MISSING_FIELD`（message 里带字段名）。

### 2.2 活跃项目门控

| 不需要活跃项目 | 需要活跃项目（否则 409 `NO_ACTIVE_PROJECT`） |
|---|---|
| `/api/projects/*`、`/api/admin/{app-config, doctor, version, pi-status, llm, embedder/*}` | 世界图全部端点、`/api/files/*`、`/api/chat/*`、`/api/scheduler/*`、`/api/admin/{config, rulesets, novel-json}` |

### 2.3 错误码总表（前端按 code 分支，不要解析 message）

| HTTP | code | 前端建议处理 |
|---|---|---|
| 400 | `MISSING_FIELD` / `INVALID_BODY` / `INVALID_JSON` / `VALIDATION_ERROR` / `INVALID_SLOT` / `INVALID_MODEL` / `INVALID_STORY_TIME` / `INVALID_EXT` / `BUSINESS_ERROR` / `MODEL_NOT_READY` | 表单/参数错误，toast 展示 message |
| 403 | `PATH_ESCAPE` | 文件路径非法（编辑器防护触发） |
| 404 | `ENTITY_NOT_FOUND` / `DECLARATION_NOT_FOUND` / `PLAN_NOT_FOUND` / `SESSION_NOT_FOUND` / `FILE_NOT_FOUND` / `NOVEL_JSON_NOT_FOUND` / `WORLD_DB_NOT_FOUND` / `TEMPLATE_NOT_FOUND` / `NOT_FOUND` | 资源不存在，刷新对应列表 |
| 409 | `NO_ACTIVE_PROJECT` | **全局兜底：跳项目管理页** |
| 409 | `MIGRATION_REQUIRED` | 弹确认 → 调 migrate → 重新 activate |
| 409 | `CHAT_BUSY` | 聊天输入框禁用并提示"上一条回复中" |
| 409 | `MTIME_CONFLICT` | 编辑器提示"文件已被他人修改"，提供重载/强制保存 |
| 409 | `COMMIT_FAILED` / `COMMIT_IN_PROGRESS` / `DECLARATION_CLOSED` / `FILE_EXISTS` / `PROJECT_OPEN` | 状态冲突，toast + 刷新 |
| 410 | `PLAN_ALREADY_COMMITTED` | plan 已提交完成，提示并刷新 |
| 501 | `EMBEDDER_UNAVAILABLE` / `SEARCH_UNAVAILABLE` | 提示"服务未以 --embed 启动"，降级为全文检索 |
| 503 | `CHAT_UNAVAILABLE` / `LLM_UNAVAILABLE` / `DEBUG_UNAVAILABLE` | 功能未装配，对应视图显示空态 |

### 2.4 实时通道（共三条，按用途各就各位）

| 通道 | 类型 | 用途 |
|---|---|---|
| `GET /api/chat/events` | SSE | 主会话回复与工具调用全程（先开连接再发消息；30s 心跳 `:heartbeat`） |
| `GET /api/debug/stream` | SSE | 调试页实时事件流（先内存快照后实时）；**不作为 studio 阶段状态的数据源** |
| `GET /api/scheduler/status` | 轮询 | 队列长度、待确认计划摘要、defaultMode（建议编排页 2s 轮询） |
| `GET /api/scheduler/plans/:id` | 轮询/按需 GET | 单个 plan 的角色产出与后端落下的阶段记录；studio 的 plan 详情唯一数据源 |
| `GET /api/chat/status` | 轮询 | `isStreaming` 兜底 busy 判断（SSE 不可用时降级） |

**Chat SSE 事件渲染规则（关键，易踩坑）：**`message_update` 携带的是**完整 message 快照**（不是 delta），UI 全量替换重绘；工具卡片按 `toolCallId` 随 `tool_execution_start/update/end` 增量更新；以 `agent_end` 作为一轮的收尾信号。

**Debug 事件结构**：`{id, ts, traceId, stage, status, input?, output?, durationMs?, error?, parentId?}`。start/end/error 以 `traceId + stage + parentId` 归组，`parentId` 指向父级 start 事件的 `id`；start 与 end/error 本身使用不同 `id`。调试页可据此构建 DAG。每个项目绑定事件同时异步追加到对应项目 `.pi/logs/debug.jsonl`；SSE 与 `/api/debug/events` 仍只返回当前进程的 1000 条内存缓冲，`POST /api/debug/clear` 只清内存，不清日志文件。

**Studio 阶段规则**：不得从 debug span 聚合计划进度。studio 只消费 `GET /api/scheduler/plans/:id` 的 `stages[]`；debug SSE 仅用于调试页和可选诊断旁路。

## 3. 信息架构与跳转逻辑

### 3.1 视图清单与路由

| # | 视图 | hash 路由 | 设计稿 | 进入条件 |
|---|---|---|---|---|
| V1 | 项目管理 | `#/projects` | project-management.html | 无（无活跃项目时的强制落点） |
| V2 | 世界图 | `#/graph` | world-graph.html（详情抽屉为同视图状态 world-graph-detail.html） | 需活跃项目 |
| V3 | 事件链 | `#/events` | event-chain.html | 需活跃项目 |
| V4 | 创作编排 | `#/studio` | orchestration.html | 需活跃项目 |
| V5 | 调试 | `#/debug` | debug.html | 需活跃项目 |
| V6 | 文件编辑 | `#/files` | files.html | 需活跃项目 |
| V7 | 设置 | `#/settings` | settings.html | 部分分区需活跃项目（见 §10） |

V2~V6 共享全局外壳：Logo + 项目菜单 + 六视图导航 + storyTime 选择器（前端态）+ 全局搜索框。

### 3.2 跳转逻辑（全量规则）

| # | 触发 | 动作 | 跳转与状态 |
|---|---|---|---|
| J1 | 应用启动 | 调 `/api/projects/active` | **一律落 V1 项目管理页**（已定方案"记住但停在入口页"：后端已自动恢复上次项目为活跃，V1 显示"当前项目：xxx，进入 ▶"按钮） |
| J2 | V1 点击"进入"/激活项目卡片 | `POST /api/projects/activate` 成功 | 跳 V2 世界图，storyTime 初始化为 `/api/status` 的最新值 |
| J3 | V1 激活返回 `MIGRATION_REQUIRED` | 弹确认 → `POST migrate` → 再 activate | 同 J2 |
| J4 | 任意视图收到 `NO_ACTIVE_PROJECT` | — | 跳 V1（全局兜底） |
| J5 | 外壳项目菜单"切换项目" | — | 跳 V1，当前活跃项目保留高亮 |
| J6 | 外壳 storyTime 选择器 | 改前端 storyTime 状态 | 不跳页；V2/V3 重取数据（graph/events 均带 storyTime 参数） |
| J7 | 外壳全局搜索选中结果 | — | 实体 → 跳 V2 并选中打开详情抽屉；事件 → 跳 V3 并定位该事件卡片 |
| J8 | V2 双击实体 / 点"详情" | — | 同视图滑出详情抽屉（不跳页），背景压暗 |
| J9 | 详情抽屉"事件"Tab 点某事件 | — | 跳 V3 并高亮定位该事件 |
| J10 | V3 事件详情"跳转到世界图（此时刻）" | 设外壳 storyTime = 该事件 storyTime | 跳 V2 |
| J11 | V4 右栏"查看世界图变更" | — | 跳 V2（storyTime = 本次编排的 storyTime） |
| J12 | V4 右栏"查看章节" | — | 跳 V6 并打开对应章节文件（chapterPath 来自 commit 响应） |
| J13 | V7 设置内各保存动作 | — | 不跳页，toast 确认 |
| J14 | V1 关闭当前活跃项目 | `POST /api/projects/close` | 停 V1，进入无活跃状态（其他视图再访问即触发 J4） |

### 3.3 空态规则

- V2/V3 无数据（新项目）：显示"从创作编排开始你的第一段剧情"，按钮跳 V4。
- V4 无历史会话：空态引导语 + 输入框聚焦。
- V5 调试无事件：显示"暂无调试事件（发起一次编排即可看到流水线）"。
- 所有列表加载中用骨架屏（设计规范 §11 加载态）。

---

## 4. V1 项目管理

**目的**：小说工程的入口。创建、发现、激活、迁移项目。

**页面内容**：品牌区（标题"Narrative Engine · AI 驱动的小说创作工作台"）；当前项目条（有活跃时显示名称 + "进入 ▶"）；扫描根目录输入 + 扫描按钮；可折叠新建表单；项目卡片网格；卡片菜单。

**提供的功能**：

| 功能 | 交互 | API 契约 |
|---|---|---|
| 扫描项目 | 输入根目录点扫描；进入页面自动用 `defaultScanRoots` 扫一次 | `GET /api/projects/scan?root=&maxDepth=` → 每项 `{dir, relativePath, meta, chapterCount, lastModified, needsMigration, stats: {entityCount, eventCount}\|null}` |
| 记忆扫描根 | 扫描成功后持久化 | `PUT /api/admin/app-config`，键 `launcher.defaultScanRoots: string[]`；读取用 `GET` 同路径 |
| 项目卡片 | 显示名称/路径/章节数/最后更新/统计徽章（实体·事件）/迁移徽章（`needsMigration=true` 时） | 数据全部来自 scan；`stats=null` 时统计徽章显示"—" |
| 激活 | 点卡片 | `POST /api/projects/activate {dir}` → J2/J3 |
| 新建项目 | 表单：目录（必填）+ 名称（选填）；成功后自动激活 | `POST /api/projects/create {dir, name?}`（201）→ 再 activate |
| 迁移 | 卡片菜单项 | `POST /api/projects/migrate {dir}`（自动备份 world.db） |
| 打开所在文件夹 | 卡片菜单项 | `POST /api/projects/open-folder {dir}` |
| 关闭项目 | 卡片菜单项（仅已打开的项目显示） | `POST /api/projects/close {dir}` |
| 当前项目状态 | 页头显示 | `GET /api/projects/active` → `{active: {dir,name,forceFulltext}\|null, open: [...]}` |

**不提供的功能**：删除项目（危险操作）；浏览文件夹原生对话框（Web 形态做不到，手输路径）；批量操作。

---

## 5. V2 世界图

**目的**：主工作台——某一 storyTime 时刻的世界状态：实体、关系、属性、视角。

**页面内容**：左栏（类型页签 全部/角色/地点/物品/概念 + 实体搜索框 + 实体列表）；中栏（状态栏：storyTime 步进 + 实体/事件统计 + 2D/3D 切换；图画布）；右栏属性检查器；实体详情抽屉（同视图状态）。

**提供的功能**：

| 功能 | 交互 | API 契约 |
|---|---|---|
| 图快照 | 画布渲染节点（实体，按类型配色）+ 边（关系，含标签/方向） | `GET /api/graph?storyTime=&includeClosed=` → `{entities: EntitySnapshot[], relations[]}`；`includeClosed=1` 显示已闭合关系（置灰） |
| 状态栏统计 | 实体数/事件数/storyTime 列表 | `GET /api/status` → `{entityCount, eventCount, storyTimes[]}` |
| storyTime 步进/直跳 | ‹ › 按钮 + 下拉 | 纯前端态，改后重取 graph（J6） |
| 类型过滤 | 页签 | 前端过滤（实体有 `entityType` 字段） |
| 实体搜索 | 搜索框 | `GET /api/search?q=&storyTime=&type=&mode=`（mode 缺省 hybrid；服务未带 --embed 时自动降级 fulltext，前端无需处理） |
| 属性检查器 | 点选实体：属性键值、关系列表、最近事件 | `GET /api/entities/:id?storyTime=`；关系取 graph 的 relations 过滤；事件取 `/api/events` 按 entityId 过滤 |
| 快速记事件 | 浮动按钮弹表单 | `POST /api/events`，body 至少 `{eventId, type, storyTime, entityId}`（type: birth/change/death；source 服务端强制 user） |
| 快速加关系 | 浮动按钮弹表单 | `POST /api/relations {sourceId, targetId, label, storyTime}` |
| 2D/3D 切换 | 切换按钮 | 纯前端态 |
| 角色视角模式 | 选择角色后按"该角色知道的信息"渲染（信息差） | `GET /api/character-view?characterId=&storyTime=` → `{view}`（可见声明集合） |

### 5.1 实体详情抽屉（J8 打开）

| 区块/功能 | 交互 | API 契约 |
|---|---|---|
| 头部：类型/名称/ID/摘要/编辑摘要 | 编辑按钮就地改 | `POST /api/entities/:id/summary {summary}` |
| 历史时间滑块 | 拖动看各时刻状态 | `GET /api/entities/:id/history` → 实体全历史 + 关系史（含已闭合） |
| 声明 Tab | 列表：内容/生效中或已闭合/时间范围/来源 | 数据来自 history；闭合按钮 → `POST /api/declarations/close {declarationId, entityId, storyTime}`（已闭合 409） |
| 编辑属性 | 就地编辑键值 | `POST /api/entities/:id/props {property, value, storyTime, modality?}` → `{closedDeclarationId, newDeclarationId}`（自动闭合旧声明+写新值） |
| 关系 Tab | 出边/入边；新建；闭合 | 新建同上；闭合 → `POST /api/relations/close {sourceId, targetId, label, storyTime}` |
| 可见性 Tab | 角色×声明矩阵；手动设置/撤销 | 查：`GET /api/declarations/:declId/visibility?storyTime=`；设：`POST /api/visibility {characterId, declarationId, confidence, source, storyTime}`（source 枚举 `experienced/informed/witnessed`）；撤销：`POST /api/visibility/close {characterId, declarationId, storyTime}` |
| 事件 Tab | 该实体事件时间线 | 数据来自 `/api/entities/:id/history` 返回的 `events[]` 字段（不再单独调 `/api/events` 按 entityId 过滤）；点事件 → J9 |
| 实体退场 | 底部危险按钮，二次确认 | `POST /api/entities/:id/kill {storyTime}`（语义"删除"= 双时态闭合退场，**无物理删除**；该时刻起快照消失，历史仍可查） |

**不提供的功能**：物理删除实体/声明（事件溯源设计，明确不做）；声明的"AI 推理溯源"（无数据）；事件的多参与方编辑（事件当前单 entityId 字段）；多值属性批量闭合（同 property 多声明时 props 端点只闭合其一）。

---

## 6. V3 事件链

**目的**：按故事时间线浏览全部事件与因果关系。

**页面内容**：左栏筛选（实体复选/类型标签/关键词 + 重置）；中栏事件卡片时间线（按章分组，标记当前 storyTime）；右栏仅展示事件详情面板（图形化因果链已删除）。

**提供的功能**：

| 功能 | 交互 | API 契约 |
|---|---|---|
| 事件时间线 | 卡片：时间点/类型徽章/摘要/参与实体/可展开详情 | `GET /api/events` → `{events: EventRecord[]}`（全量，字段含 `eventId/type/storyTime/entityId/summary/source(newFacts/invalidated)`；前端按 storyTime 章级分组） |
| 筛选 | 实体复选/类型/关键词 | **全部前端过滤**（事件量百级，无服务端筛选） |
| 事件来源徽章 | "AI"/"手动" | EventRecord.source 字段（`engine`/`user`） |
| 跳转世界图 | 事件详情按钮 | J10 |

**不提供的功能**：未来事件/未知节点占位（数据模型无未来）；事件编辑与删除（事件即历史，不可变）；服务端分页（数据量不需要）。

---

## 7. V4 创作编排

**目的**：与多代理 AI 协作推进剧情——聊天、发起编排、审核计划、看执行进度。

**页面内容**：左栏会话列表；中栏（控制栏：plan/yolo 模式切换 + 队列状态徽章；消息流含计划卡片；输入区）；右栏结果面板（执行状态/世界图变更摘要/生成章节）。

**提供的功能**：

| 功能 | 交互 | API 契约 |
|---|---|---|
| 发消息/流式回复 | 输入框 → 发送；AI 逐字输出，工具调用以卡片展示 | 先开 `GET /api/chat/events`（SSE），再 `POST /api/chat/message {text}`（接收即回 `{received:true}`；渲染规则见 §2.4） |
| 忙碌约束 | 回复中禁用输入 | `409 CHAT_BUSY` 兜底 |
| 会话列表/切换/历史 | 左栏按时间分组；点击加载历史 | `GET /api/chat/sessions` → `{sessions:[{id,name,created,modified,messageCount,firstMessage}]}`；`GET /api/chat/sessions/:id/messages` → `{id,messages:[{role,text,ts,toolCalls?,provider?,model?,usage?}]}`（404 `SESSION_NOT_FOUND`） |
| 历史工具卡片 | assistant 消息下按名称与状态展示；不展示无契约的图标/耗时/result | `toolCalls[]` 为 `{id,name,status:"done"|"error",isError}`；由历史 assistant toolCall 与后续 toolResult 按 `toolCallId` 配对。`usage` 使用 §11 的稳定摘要 DTO |
| 新建议程 | 按钮 | 前端新开空白对话（继续发消息即产生新会话记录；无专用端点） |
| plan/yolo 模式切换 | 控制栏开关 | `GET /api/scheduler/status` 读 `defaultMode`；`PUT /api/scheduler/mode {mode}`（持久化，工具与 HTTP 的 dispatch 都以此为缺省） |
| 发起编排 | 表单（instruction + characterIds + storyTime，可选 executionHints/chapterPath） | `POST /api/scheduler/dispatch` → `{queueId, mode}`；planId 经 status 轮询出现 |
| 队列与计划状态 | 状态徽章"N 个计划待审核" | `GET /api/scheduler/status` → `{queue: {length, items[]}, plans: [{planId, storyTime, mode, characterIds, outputCount, errorCount}], defaultMode}`（2s 轮询，只作摘要） |
| 计划详情与角色产出 | plan 出现在 status 后按 `planId` 拉取；按角色卡展示 actor/action/thought/emotion/state_changes/knowledge_gained | `GET /api/scheduler/plans/:id` → `{planId,storyTime,mode,characterIds,cast,outputs,retrievalPlan,errors,stages}`；404 `PLAN_NOT_FOUND` |
| 计划卡片：提交/丢弃 | 卡片按钮 | `POST /api/scheduler/commit {planId}` → `{ ok, planId, queueId, status: "committing" }`（404 `PLAN_NOT_FOUND`；409 `COMMIT_IN_PROGRESS` / `PLAN_ALREADY_COMMITTED`）；提交结果通过轮询 plan 详情的 `status` 字段获取（`confirmed`→`committing`→`committed`\|`error`）；`POST /api/scheduler/discard {planId}` |
| 右栏：plan 阶段状态 | 计划生成后展示规划、角色两个前半链路阶段的完成或错误状态、耗时与模型 | 只读 plan 详情的 `stages[]`；阶段项仅允许 `planner/role`，形状 `{stage,agent,status:"done"|"error",durationMs?,provider?,model?,error?}`。`reasoner/renderer/commit` 不属于 plan detail，提交后结果读 commit 响应，诊断过程看 debug 页 |
| 右栏：世界图变更摘要 | commit 成功后展示已应用事件数量 | commit 入队后返回 `{ ok, planId, queueId, status: 'committing' }`；`appliedEventIds` 在 `plan.status` 流转为 `committed` 后从 plan 详情或日志获取（plan 详情当前未持久化 commit 完整结果，仅暴露 `status/commitQueueId/commitError`），本期不从 debug payload 推导业务结果 |
| 右栏：生成章节卡 | commit 成功后展示路径/字数/查看 | `chapterPath/writtenText` 在 `plan.status` 流转为 `committed` 后从 plan 详情或日志获取（plan 详情当前未持久化 commit 完整结果）；标题可由路径推导，点查看 → J12 |
| @提及辅助 | 输入 @ 弹实体面板 | 数据用 `/api/search`，不得直读 `MOCK_ENTITIES` |

**废止口径（不得实现或保留兼容分支）**：聊天角色气泡字段 `name/roleTag/characterId`；plan 的 `sections[]` 章节正文预览；前端自造 stages；按 debug span 聚合 studio stages；工具卡片 `icon/duration/result`。

**不提供的功能**：附件上传；提示词模板库；plan 阶段章节正文预览；聊天角色发言标签；中断/暂停执行中的编排（无 abort 端点，本期靠等待完成或关闭页面）；多并发编排（队列串行，这是后端保证）。

**成本提示（生产验证注意）**：dispatch 与聊天会产生**真实 LLM 调用**（按 slot 配置计费），plan 模式一次编排约 2 轮调用，yolo 约 4 轮。

---

## 8. V5 调试

**目的**：实时观察引擎内部：编排流水线、聊天处理、错误。

**页面内容**：顶过滤栏（级别/模块/关键词 + 缓冲条数）；日志/事件流（或按 traceId 聚合的 DAG 视图，设计稿为日志流形态）；底部自动滚动开关；清空二次确认。

**提供的功能**：

| 功能 | 交互 | API 契约 |
|---|---|---|
| 实时事件流 | 进入页面自动订阅 | `GET /api/debug/stream`（SSE，先内存快照后实时，30s 心跳） |
| 缓冲查询 | 过滤/翻查 | `GET /api/debug/events` → `{events: DebugEvent[]}`（环形缓冲默认 1000 条） |
| 状态/stage/关键词过滤 | 过滤栏 | 前端按真实字段 `status/stage/error/input/output` 过滤；不存在 `level/module/message/payload/spanId` |
| span 详情展开 | 点节点看 input/output/error/耗时 | DebugEvent 真实 schema 见 §2.4；`parentId` 用于 DAG 父子关系 |
| 清空缓冲 | 按钮 + 二次确认 | `POST /api/debug/clear`，只清当前进程内存缓冲 |
| 日志落盘 | 无新增 UI/API | 事件按创建时绑定的项目写入 `<project>/.pi/logs/debug.jsonl`；10 MB 轮转为 `debug-<yyyyMMdd-HHmmss>.jsonl`，保留最近 5 个轮转文件；异步写失败只告警；不得在 emit 时按当前活跃项目猜目录 |
| 自动滚动 | 开关 | 前端态 |

**不提供的功能**：日志文件读取/下载 API；清空磁盘日志；远程日志上报；`level/module/message/payload/spanId` 旧 mock 维度。

---

## 9. V6 文件编辑

**目的**：直接编辑项目里的 Markdown 文件（正文、规则集）与查看配置文件。

**页面内容**：左栏文件树（含新建按钮）；右栏编辑器（多 Tab + 工具栏 + 状态栏）。

**提供的功能**：

| 功能 | 交互 | API 契约 |
|---|---|---|
| 文件树 | 目录 + .md/.txt/.json + .env | `GET /api/files/tree` |
| 打开文件 | 点击入 Tab | `GET /api/files/read?path=`（允许 .md/.txt/.json） |
| 编辑保存 | Ctrl+S / 自动保存；未保存圆点 | `PUT /api/files/write {path, content, baseMtime?}`（只许 .md；**mtime 乐观锁**：保存前带读取时的 mtime，冲突 409 `MTIME_CONFLICT` → 弹"已变更"给重载/强制保存选择） |
| 新建文件 | 按钮 | `POST /api/files/create {path}`（201） |
| 重命名/移动 | 树节点右键 | `POST /api/files/rename {path, newPath}`（只许 .md，目标已存在 409） |
| 删除文件 | 树节点右键，确认 | `POST /api/files/delete {path}` |
| 编辑器体验 | 渲染/源码切换、字号、字数、行列 | 全部前端态 |
| 章节目录提示 | novel.json 的 `chaptersDir` 决定正文目录（缺省"正文"） | `GET /api/admin/novel-json` |

**不提供的功能**：二进制文件（图片等 assets 不列入树、不可读）；目录的新建/删除（经新建文件自动建父目录）；文件内搜索替换（可用浏览器查找或后续加）。

---

## 10. V7 设置（全局/项目两分区）

**结构铁律**：**应用配置区无需活跃项目**（首次使用先配模型再开工）；**项目配置区需活跃项目**（无活跃时该区显示引导，应用区正常可用）。

### 10.1 应用配置区

| 子页 | 提供的功能 | API 契约 |
|---|---|---|
| 模型配置 | 5 个 slot（planner/role/reasoning/renderer/default）各一行：Provider 下拉 + Model 输入 + 设置/清除；每行显示来源徽章（slot 已配/跟随默认/环境变量）与 hasKey | `GET /api/admin/llm` → 每 slot `{configured, resolved: {provider, model}\|null, source: slot/default/env/none, hasKey}`；`PUT /api/admin/llm/slot {slot, provider, model}`（模型不存在 400 `INVALID_MODEL`）；`DELETE /api/admin/llm/slot/:slot` |
| 密钥管理 | 按 provider 填/删 API Key（密码框 + 眼睛切换只看刚输入的）；**列表只显示"已配置"，任何端点都不回显明文** | `PUT /api/admin/llm/key {provider, apiKey}`；`DELETE /api/admin/llm/key/:provider`；hasKey 状态从 `GET /api/admin/llm` 或 `GET /api/admin/pi-status` 读 |
| 向量模型 | 当前模型/维度/缓存状态；改模型名；预热；清缓存 | `GET /api/admin/embedder/status`；`POST /api/admin/embedder/warmup`；`POST /api/admin/embedder/cache/clear`；模型名写入走项目 .env（`PI_EMBEDDER_MODEL`，见下）或 app-config `embedder.model` |
| 应用偏好 | 主题/字号/自动保存（前端 localStorage）；默认扫描根目录 | `GET/PUT /api/admin/app-config`（已知键 `launcher/embedder/llm/scheduler`；写入会剥离未知键） |
| 关于 | 版本号 + 检查更新；依赖自检面板（Node/原生绑定/模板/向量缓存/项目结构） | `GET /api/admin/version` → `{local, remote, updateAvailable}`；`GET /api/admin/doctor` → `{checks[], failures, warnings, passed, ok}` |

### 10.2 项目配置区（需活跃项目）

| 子页 | 提供的功能 | API 契约 |
|---|---|---|
| 规则集 | 三页签（渲染/角色/规划）编辑器 + 字数；保存即时生效；恢复模板（确认） | `GET /api/admin/rulesets`；`PUT /api/admin/rulesets/:name {content}`（name ∈ render/planner/role）；`POST /api/admin/rulesets/:name/reset` |
| 项目信息 | novel.json 表单：名称/章节目录/故事时间格式 | `GET/PUT /api/admin/novel-json` |
| 环境变量 | 三键表单：HF_ENDPOINT / PI_DEBUG / PI_EMBEDDER_MODEL（空串=删除该键） | `GET/PUT /api/admin/config` |

**不提供的功能**：自定义 .env 键（服务端白名单只收三键）；密钥明文回显（安全设计）；slot 之外的自由模型槽位（5 个固定）；主题之外的 UI 定制。

---

## 11. 数据模型速查（前端 TypeScript 接口可直接按此声明）

```ts
// 信封
type Envelope<T> = { ok: true; data: T; error: null } | { ok: false; data: null; error: { code: string; message: string } };

// 世界图（完整字段以 underworld-graph/src/types.ts 的 zod schema 为准）
type EntitySnapshot = { entityId: string; entityType: "character"|"location"|"item"|"concept";
  summary?: string; properties: Record<string, unknown>; alive: boolean };
type EventRecord = { eventId: string; type: "birth"|"change"|"death"; storyTime: string;
  entityId: string; entityType?: string; summary?: string; source: "engine"|"user";
  invalidated?: { declarationId: string; property: string }[];
  newFacts?: { entityId: string; property: string; value: unknown; modality: string }[];
  causes?: string[]; recordedAt: string };
type Declaration = { declarationId: string; entityId: string; property: string; value: unknown;
  modality: string; validFrom: string; validTo: string /* "Infinity"=未闭合 */ };
type VisibilityDecl = { characterId: string; declarationId: string; state: "known";
  confidence: number; source: "experienced"|"informed"|"witnessed"; validFrom: string; validTo: string };

// 编排
type SchedulerStatus = { queue: { length: number; items: unknown[] };
  plans: { planId: string; storyTime: string; mode: "plan"|"yolo";
    characterIds: string[]; outputCount: number; errorCount: number }[];
  defaultMode: "plan"|"yolo" };
type PlanStage = { stage: "planner"|"role"; agent: string;
  status: "done"|"error"; durationMs?: number;
  provider?: string; model?: string; error?: string | null };
type SchedulerPlanDetail = { planId: string; storyTime: string; mode: "plan"|"yolo";
  characterIds: string[]; cast: {characterId:string;name:string;summary:string}[];
  outputs: { actor:string; action:string; thought:string; emotion:string;
    state_changes: unknown[]; knowledge_gained: unknown[] }[];
  retrievalPlan: unknown; errors: {characterId:string;error:string}[]; stages: PlanStage[];
  status: "confirmed"|"committing"|"committed"|"error"; commitQueueId?: string; commitError?: string };

// 历史聊天（实时事件继续使用 PI SDK 原始 SSE 事件）
type HistoricalToolCall = { id: string; name: string; status: "done"|"error"; isError: boolean };
type UsageSummary = { inputTokens:number; outputTokens:number; cacheReadTokens:number;
  cacheWriteTokens:number; totalTokens:number; estimatedCostUsd:number };
type ChatMessage = { role: string; text: string; ts: string; toolCalls?: HistoricalToolCall[];
  provider?: string; model?: string; usage?: UsageSummary };

type DebugEvent = { id:string; ts:number; traceId:string; stage:string;
  status:"start"|"end"|"error"; input?:unknown; output?:unknown;
  durationMs?:number; error?:string; parentId?:string };

// LLM 配置
type SlotStatus = { configured: { provider: string; model: string } | null;
  resolved: { provider: string; model: string } | null;
  source: "slot"|"default"|"env"|"none"; hasKey: boolean };
type LlmStatus = Record<"planner"|"role"|"reasoning"|"renderer"|"default", SlotStatus>;

// 项目
type NovelProject = { dir: string; relativePath: string; chapterCount: number;
  lastModified: string; needsMigration: boolean; stats: { entityCount: number; eventCount: number } | null;
  meta: { name: string; worldGraphDir: string; chaptersDir: string; storyTimeFormat: string; [k: string]: unknown } };

// 会话列表
type ChatSessionMeta = { id: string; name: string | null; created: string; modified: string;
  messageCount: number; firstMessage: string | null };
```

## 12. 生产环境测试验证清单（交付验收标准）

前端 DEMO 完成后，按以下路径逐项验证（后端以 `--project <工程> --embed` 启动）：

| # | 验证路径 | 通过标准 |
|---|---|---|
| A1 | 启动 → 落项目页 → 激活 | 卡片统计/徽章正确；跳世界图且图渲染 |
| A2 | 世界图：步进 storyTime / 搜索 / 点实体 | 快照随时间变化；右栏数据与 API 一致 |
| A3 | 抽屉：改摘要/改属性/闭合声明/加关系 | 操作后重取数据生效；history 里可见对应 user 事件 |
| A4 | 事件链：筛选 / 因果链 / 跳世界图 | 过滤正确；因果图渲染；J10 状态正确 |
| A5 | 编排：切 yolo → dispatch 一条简单指令 | status 队列项最终完成并含结果；debug SSE 仅用于诊断四阶段；世界图与章节文件真实更新（yolo 不生成待审核 plan detail） |
| A6 | 编排：切 plan → dispatch → 打开计划详情 → 提交/丢弃 | 详情展示 `outputs[]` 角色产出且无 sections；stages 仅含 planner/role 且来自 plan 详情；commit 入队后 `plan.status` 流转 `committed`，章节信息从 plan 详情获取；discard 后详情 404 且无变更 |
| A7 | 聊天：发消息并重新加载历史会话 | SSE 逐字输出；CHAT_BUSY 期间输入禁用；历史 assistant 消息保留 toolCalls/provider/model/标准化 usage 摘要；无角色标签字段 |
| A8 | 调试：执行一次编排后查 SSE、内存与磁盘 | 三处 DebugEvent 核心字段一致；`.pi/logs/debug.jsonl` 可逐行 JSON.parse；clear 后内存为空但日志仍在 |
| A9 | 调试日志轮转 | 超过 10 MB 后生成时间戳轮转文件；活跃文件继续可写；最多保留 5 个轮转文件 |
| A10 | 设置：配 default slot + 写密钥 | `GET /api/admin/llm` 显示 source=slot、hasKey=true；重启服务后仍在（持久化） |
| A11 | 文件：编辑 .md 保存 / 重命名 | 磁盘文件变化；并发改触发 MTIME_CONFLICT |
| A12 | 重启服务 | 上次项目自动恢复活跃；落项目页可一键进入；新 debug 事件继续写入该项目日志 |

## 13. 本期不做（全量汇总，前端不要为此预留 UI）

删除项目；物理删除实体/声明；事件编辑；附件上传；提示词模板库；浏览文件夹原生对话框；多用户/权限/鉴权；debug 日志读取 API 与远程上报；跨文件全局搜索（实体搜索已有，文件内容搜索不做）；编排 abort；AI 推理溯源；未来事件占位；聊天角色发言标签；plan 阶段章节正文预览；图形化因果追溯。

## 14. 视觉与组件规范

一切以 `narrative-engine-design` 为准：`colors_and_type.css`（暖调文档工具风，brand-500 `#c96442`，圆角 8px）+ `design-spec.html` §1/§11（按钮 5 类、表单、Toast 4 类、Modal 3 类、空态四要素、加载态 4 种、状态徽章胶囊）。设计稿 8 页内联的重复导航/主题 CSS 在实现时必须抽取为共享外壳组件。布局结构（三栏/抽屉/卡片网格）按各页设计稿；**功能与数据以本文为准**——设计稿中出现而本文标注"不提供"的元素，直接删掉不要做。
