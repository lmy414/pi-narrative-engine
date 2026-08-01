# 前端需求文档（后端能力对齐版）

- 版本：v1.0 · 2026-08-01
- 依据代码：narrative-engine @ master（`ea59d99` 之后，含 LLM 配置后端与项目持久化，工作区未提交部分）
- 设计原型：`D:\claude\pi-ex\narrative-engine-design`（8 页高保真设计稿 + design-spec.html）
- 本文档目的：**以后端实际提供的 API 为准**，定义前端重做的功能范围。每条功能标注支撑状态，避免"前端做了交互、后端没有接口"的脱节。

## 状态标记约定

| 标记 | 含义 |
|---|---|
| ✅ | 后端已有对应 API，可直接实现 |
| 🟡 | 后端部分支持（数据口径有差异 / 需小改），见备注 |
| ❌ | 后端缺失，已列入"后端缺口清单"（第 10 节），前端先行设计但标注依赖 |
| ✂ | 设计稿中的虚构/超前内容，本期不做（第 11 节） |

## 1. 后端 API 能力总表（现状事实）

统一约定：所有接口返回信封 `{ok, data, error}`；项目级接口在无活跃项目时返回 409 `NO_ACTIVE_PROJECT`；服务只听 `127.0.0.1:7421`。

### 1.1 项目管理 `/api/projects/*`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/projects/scan?root=&maxDepth=` | 扫描目录找工程（认 novel.json），返回 `{dir, relativePath, meta, chapterCount, lastModified}[]` |
| GET | `/api/projects/meta?dir=` | 单工程元信息 |
| GET | `/api/projects/active` | `{active: {dir,name,forceFulltext}\|null, open: [...]}` |
| POST | `/api/projects/activate` `{dir}` | 激活（无 world.db 自动初始化；schema 过旧返回 `MIGRATION_REQUIRED`）。**成功后自动持久化 lastProjectDir，下次启动自动恢复** |
| POST | `/api/projects/migrate` `{dir}` | 迁移（自动备份 world.db） |
| POST | `/api/projects/create` `{dir,name?,force?}` | 从模板六件套创建（不自动激活，前端串联 activate） |
| POST | `/api/projects/open-folder` `{dir}` | 系统文件管理器打开 |
| POST | `/api/projects/close` `{dir}` | 关闭；关活跃项目时清除 lastProjectDir |

### 1.2 文件 `/api/files/*`（均需活跃项目）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/files/tree` | 文件树（**只列目录 + .md**，跳过点开头目录与 node_modules） |
| GET | `/api/files/read?path=` | 读文件（允许 .md/.txt/.json） |
| PUT | `/api/files/write` `{path,content,baseMtime?}` | 写 .md，mtime 乐观锁（冲突 409 `MTIME_CONFLICT`） |
| POST | `/api/files/create` `{path}` | 新建 .md |
| POST | `/api/files/delete` `{path}` | 删除 |

### 1.3 配置 `/api/admin/*`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/llm` | **5 个 slot（planner/role/reasoning/renderer/default）状态**：已配值、解析结果、来源（slot/default/env/none）、hasKey。**永不返回密钥明文** |
| PUT | `/api/admin/llm/slot` `{slot,provider,model}` | 设置 slot（pi-ai 校验模型存在，400 `INVALID_MODEL`），落盘 app-config + 即时生效 |
| DELETE | `/api/admin/llm/slot/:slot` | 清除 slot，回退 default→env |
| PUT | `/api/admin/llm/key` `{provider,apiKey}` | 写密钥（SDK AuthStorage 落盘 auth.json） |
| DELETE | `/api/admin/llm/key/:provider` | 删密钥 |
| GET | `/api/admin/pi-status` | 模型/密钥状态摘要（default slot 口径，与 llm 端点同源） |
| GET/PUT | `/api/admin/config` | 项目 .env 三键：`HF_ENDPOINT / PI_DEBUG / PI_EMBEDDER_MODEL` |
| GET/PUT/POST reset | `/api/admin/rulesets[/:name]` | 规则集三件套读写/从模板重置 |
| GET/PUT | `/api/admin/novel-json` | novel.json 读写 |
| GET/PUT | `/api/admin/app-config` | 应用级配置（`launcher.lastProjectDir/defaultScanRoots`、`embedder.model`、`llm.slots`） |
| GET | `/api/admin/doctor` | 依赖自检 12 项（Node/原生绑定/模板/向量缓存/工程结构） |
| GET | `/api/admin/version` | 版本号 + git 远程比对 |
| GET/POST | `/api/admin/embedder/status|warmup|cache/clear` | 向量模型状态/预热/清缓存 |

### 1.4 聊天 `/api/chat/*`（需活跃项目）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/chat/message` `{text}` | 发消息（单流约束，忙碌 409 `CHAT_BUSY`） |
| GET | `/api/chat/events` | SSE 事件流（AI 回复、工具调用全程事件） |
| GET | `/api/chat/status` | 会话状态 |

主会话 AI 持有 28 个工具（world_*/render_*/role_*/scheduler_*/import_*），编排调度由 AI 经工具触发，事件流经 SSE 可见。

### 1.5 世界图 `/api/*`（visualizer 组，需活跃项目）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/status` | `{entityCount, eventCount, storyTimes[]}` |
| GET | `/api/graph?storyTime=&includeClosed=` | 某时刻快照：全部实体 + 关系 |
| GET | `/api/entities/:id?storyTime=` | 实体快照 |
| GET | `/api/entities/:id/history` | 实体全历史（声明/属性演变 + 关系史） |
| GET | `/api/declarations/:declId/visibility?storyTime=` | 单声明的角色可见性列表 |
| GET | `/api/search?q=&storyTime=&type=&mode=` | 实体/事实搜索（fulltext/vector/hybrid，type=character/location/item/concept） |
| GET | `/api/events` | 全部事件（含 type/storyTime/entityId/source 字段） |
| GET | `/api/events/:id/chain` | 因果链（前因后果追溯） |
| GET | `/api/character-view?characterId=&storyTime=` | 角色视角（该角色此刻知道什么——信息差） |
| POST | `/api/events` | 记事件（强制 source=user） |
| POST | `/api/entities/:id/summary` | 改摘要 |
| POST | `/api/relations` / `/api/relations/close` | 新建/闭合关系 |
| POST | `/api/visibility` / `/api/visibility/close` | 设置/闭合可见性 |

**注意：storyTime 是查询参数不是服务器状态**——"切换故事时间"是纯前端状态，各查询接口带参即可，无需写接口。

### 1.6 调试 `/api/debug/*`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/debug/stream` | SSE 实时事件流 |
| GET | `/api/debug/events` | 缓冲事件查询 |
| POST | `/api/debug/clear` | 清空缓冲 |

✅ DebugBus 已接入 main.ts（B2 已完成）：编排四阶段（orchestrator/planner/role/reasoner/renderer）与 chat.message 的 span 埋点已上线，调试页有真实数据源。

### 1.7 编排控制 `/api/scheduler/*`（需活跃项目）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/scheduler/dispatch` | 派发事件，body 同 `scheduler_dispatch` 工具参数 `{storyTime, instruction, characterIds, executionHints?, mode?, chapterPath?}`；返回 `{queueId, mode}`（planId 经 status 轮询获取） |
| POST | `/api/scheduler/commit` `{planId}` | 提交 plan（写世界图+渲染章节）；plan 不存在 404 `PLAN_NOT_FOUND`，失败 409 `COMMIT_FAILED` |
| POST | `/api/scheduler/discard` `{planId}` | 丢弃 plan；plan 不存在 404 `PLAN_NOT_FOUND` |
| GET | `/api/scheduler/status` | 队列状态 + 待确认 plan 列表 `{queue, plans[]}` |

与主会话 `scheduler_*` 工具同一 OrchestratorService 实例、同一 EventQueue，语义完全一致。

## 2. 信息架构（设计稿 8 页 → 前端 6 个主视图）

设计稿的「世界图」与「实体详情抽屉」是同一视图的两种状态（generation-tree 已标注 derived），实现时合并。

| # | 视图 | 对应设计稿 | 路由建议 |
|---|---|---|---|
| 1 | 项目管理 | project-management.html | `#/projects`（无活跃项目时强制落此页） |
| 2 | 世界图（含详情抽屉） | world-graph.html + world-graph-detail.html | `#/graph` |
| 3 | 事件链 | event-chain.html | `#/events` |
| 4 | 创作编排 | orchestration.html | `#/studio` |
| 5 | 调试 | debug.html | `#/debug` |
| 6 | 文件编辑 | files.html | `#/files` |
| 7 | 设置 | settings.html | `#/settings`（**全局/项目两分区**，见第 8 节） |

全局外壳（视图 2~6 共享）：Logo + 项目菜单 + 导航 + storyTime 选择器（前端态）+ 全局搜索。

## 3. 视图一：项目管理

| 功能 | 说明 | 依赖 | 状态 |
|---|---|---|---|
| 扫描根目录输入 + 扫描 | 默认取 app-config `launcher.defaultScanRoots`（GET /api/admin/app-config），扫描后记忆 | scan + app-config | ✅ |
| 项目卡片列表 | 名称、路径、章节数、最后更新 | scan | ✅ |
| 卡片统计（实体数/事件数） | 设计稿有"128 实体 · 342 事件" | scan 不返回，需后端补 | ❌ B4 |
| 需迁移徽章 | 设计稿有"正常/需迁移" | scan 不返回迁移状态，需后端补 | ❌ B4 |
| 激活（点卡） | `MIGRATION_REQUIRED` 时弹确认→migrate→再 activate | activate/migrate | ✅ |
| 新建项目 | 路径 + 可选名称 → create→activate 串联 | create+activate | ✅ |
| 浏览文件夹按钮 | Web 形态下手输路径；原生对话框待 Tauri | — | ✂ |
| 打开所在文件夹 | | open-folder | ✅ |
| 迁移菜单项 | | migrate | ✅ |
| 删除项目菜单项 | 危险操作，本期不做 | — | ✂ |
| 启动行为 | 后端已恢复上次项目（预激活）；前端**始终先停在本页**让用户确认进入（已定方案"记住但停在入口页"） | /api/projects/active | ✅ |

## 4. 视图二：世界图

| 功能 | 说明 | 依赖 | 状态 |
|---|---|---|---|
| 左栏实体列表 | 类型页签（全部/角色/地点/物品/概念）前端过滤；搜索框走 /api/search（type 参数） | graph + search | ✅ |
| 中栏图画布 | 2D/3D 切换（前端态）；节点=实体（按类型配色/形状），边=关系（含标签、方向）；按外壳 storyTime 取快照 | graph | ✅ |
| 状态栏 | 实体数/事件数/当前 storyTime + 前后步进（步进=改前端 storyTime 状态，重取 graph） | /api/status | ✅ |
| 右栏属性检查器 | 点选实体：属性键值、状态、关系列表、最近事件（events 按 entityId 前端过滤） | entities/:id + graph + events | ✅ |
| 快速记事件 | 弹表单（type/storyTime/entityId/内容） | POST /api/events | ✅ |
| 快速加关系 | 弹表单（source/target/label/storyTime） | POST /api/relations | ✅ |
| 多参与实体 chips | 事件当前只有单 entityId 字段，设计稿"参与实体列表"为多方 | 数据模型限制 | 🟡 先单实体展示 |

### 4.1 实体详情抽屉（点实体滑出）

| 功能 | 说明 | 依赖 | 状态 |
|---|---|---|---|
| 头部：类型/名称/ID/摘要/编辑摘要 | | entities/:id + POST summary | ✅ |
| 历史时间滑块 | 拖动查看该实体各时刻快照 | entities/:id/history | ✅ |
| 声明 Tab | 声明列表：内容、生效/闭合、时间范围、来源 | history（声明含 source） | ✅ |
| 声明"闭合"按钮 | 手动结束声明 | 无 API | ❌ B5 |
| 声明"查看详情"（推理过程） | AI 溯源，本期不做 | — | ✂ |
| 关系 Tab | 出边/入边分组；新建关系；闭合关系 | history + relations/close | ✅ |
| 可见性 Tab | 角色×声明矩阵（已知/推测/未知）；手动设置/闭合可见性 | declarations/:id/visibility + POST visibility(/close) | ✅ |
| 角色视角开关 | "以该角色视角看世界"（信息差过滤） | character-view | ✅ |
| 事件 Tab | 该实体参与的事件时间线 | events 过滤 | ✅ |
| 编辑实体属性（摘要以外） | 无通用属性写接口 | — | ❌ B5 |
| 删除实体 | 二次确认 | 无 API | ❌ B5 |

## 5. 视图三：事件链

| 功能 | 说明 | 依赖 | 状态 |
|---|---|---|---|
| 中栏时间线 | 按章节分组的事件卡片：时间点/类型徽章/摘要/参与实体/可展开详情；标记"当前 storyTime" | /api/events（全量，前端分组） | ✅ |
| 左栏筛选 | 实体复选（来自 graph）、事件类型标签、关键词——**全部前端过滤**（事件量百级，无需服务端） | events | ✅ |
| 右栏因果链 | 点事件 → 前因后果图（节点可点跳） | events/:id/chain | ✅ |
| 事件详情 | 类型/时间点/来源徽章（AI/user）/描述/实体 | events 字段自带 | ✅ |
| "跳转到世界图（此时刻）" | 设外壳 storyTime=该事件时间点并跳 #/graph | 前端态 | ✅ |
| "未来未知"占位节点 | 设计稿虚构 | — | ✂ |

## 6. 视图四：创作编排（核心页，缺口最多）

本页 = 主会话聊天 + 叙事编排控制的合体。后端现状：聊天与 SSE 已通，但**编排控制（计划确认/进度）只在 AI 工具层，没有 HTTP 直连**。

| 功能 | 说明 | 依赖 | 状态 |
|---|---|---|---|
| 中栏对话流 | 发消息、AI 逐字流式回复、工具调用过程展示 | chat/message + chat/events SSE | ✅ |
| 单流约束提示 | 忙碌时输入框禁用 + 提示 | 409 CHAT_BUSY | ✅ |
| 会话列表（左栏） | 历史会话分组、切换、新建 | SessionManager 无 HTTP 暴露 | ❌ B3 |
| plan/yolo 模式切换 | 当前由 AI 经工具参数决定，用户无显式开关 | 需新增会话级设置 | ❌ B7 |
| 队列状态徽章（"1 个计划待审核"） | GET /api/scheduler/status | ✅（B1 已完成） |
| 计划卡片 | dispatch(plan 模式) 产物：变更项清单、影响预估；**提交执行 / 丢弃**按钮 | /api/scheduler/dispatch|commit|discard | ✅（B1 已完成，本页核心） |
| 右栏：执行状态（进度/耗时） | 四代理（规划/角色/推理/渲染）运行状态推送 | 无进度事件流 | ❌ B6 |
| 右栏：世界图变更摘要 | commit 结果含变更，无推送 | ❌ B6 |
| 右栏：生成章节卡（标题/字数） | render_result 里有，无推送 | ❌ B6 |
| 输入区 @提及 | 前端辅助面板，数据走 /api/search | search | ✅ |
| 输入区附件 | 本期不做 | — | ✂ |
| 输入区提示词模板 | 本期不做（或纯前端本地模板） | — | ✂ |

**降级方案（B1 已完成，此过渡已不需要；B6 未做前仍适用）**：~~编排页先只交付"聊天 + 流式回复"，计划确认通过与 AI 对话完成~~（B1 已交付 HTTP 直连，计划卡片可直接实现）。右栏三卡片待 B6。

## 7. 视图五：调试

| 功能 | 说明 | 依赖 | 状态 |
|---|---|---|---|
| 实时日志流 | SSE 推送：时间戳/级别/模块/消息 | /api/debug/stream | ✅（B2 已完成） |
| 级别过滤 / 模块下拉 / 关键词 | 模块枚举：orchestrator/planner/reasoner/renderer/world-graph/embedder/system | /api/debug/events | ✅（B2 已完成） |
| 错误条目展开（堆栈/原因/降级策略） | 取决于 DebugBus span 记录粒度，接入后确认字段 | — | ✅（span 含 input/output/durationMs/error） |
| 缓冲区条数 | | /api/debug/events | ✅（B2 已完成，环形缓冲默认 1000 条） |
| 清空（二次确认） | | POST /api/debug/clear | ✅（B2 已完成） |
| 自动滚动开关 | 前端态 | — | ✅ |

## 8. 视图六：设置（全局/项目两分区，已定方案）

左栏一级分两组：**应用配置**（无需活跃项目，首次使用先配模型）与**项目配置**（需活跃项目）。

### 8.1 应用配置组

| 子页 | 功能 | 依赖 | 状态 |
|---|---|---|---|
| 模型配置 | 5 个 slot（规划/角色/推理/渲染/默认）各一行：Provider 下拉 + Model 输入 + 保存/清除；每行显示来源徽章（已配置/跟随默认/环境变量）与 hasKey 状态 | GET/PUT/DELETE /api/admin/llm(/slot) | ✅ |
| 密钥管理 | 按 provider 填/删 API Key（密码框+眼睛）；**只显示"已配置"，永不回显明文** | PUT/DELETE /api/admin/llm/key | ✅ |
| 向量模型 | 模型名（写 .env PI_EMBEDDER_MODEL）、缓存状态、预热、清缓存 | embedder/* + config | ✅ |
| 应用偏好 | 主题/字号/自动保存（前端 localStorage）；默认扫描根目录 | /api/admin/app-config | ✅ |
| 关于 | 版本号、检查更新（git 比对）、依赖自检面板（真实 12 项） | version + doctor | ✅ |

### 8.2 项目配置组（需活跃项目）

| 子页 | 功能 | 依赖 | 状态 |
|---|---|---|---|
| 规则集 | 三页签（渲染/角色/规划）编辑器 + 保存（即时生效）+ 恢复模板 | rulesets | ✅ |
| 项目信息 | novel.json 表单（名称/章节目录/故事时间格式） | novel-json | ✅ |
| 环境变量 | 真实三键表单（HF_ENDPOINT / PI_DEBUG / PI_EMBEDDER_MODEL） | config | ✅ |

## 9. 视图七：文件编辑

| 功能 | 说明 | 依赖 | 状态 |
|---|---|---|---|
| 文件树 | 目录 + .md；设计稿还要求显示 .json/.env | tree 只列 .md，需放宽 | 🟡 B8 |
| 打开/编辑/保存 | 多 Tab、未保存圆点、字数/行列（前端态）；保存带 baseMtime 乐观锁，冲突弹提示 | read/write | ✅ |
| 新建/删除文件 | 删除需确认 | create/delete | ✅ |
| 重命名 | 无 API | ❌ B8 |
| 渲染/源码切换、字号 | 前端态 | — | ✅ |
| assets 二进制文件（封面图等） | 不支持，本期不做 | — | ✂ |

## 10. 后端缺口清单（按优先级）

| # | 缺口 | 影响视图 | 级别 | 工作量评估 |
|---|---|---|---|---|
| B1 | ~~**编排控制 HTTP 化**~~：✅ 已完成——`/api/scheduler/dispatch|commit|discard|status` 已上线（src/app/routes-scheduler.ts，与 scheduler_* 工具同一 service） | 创作编排（核心交互） | ~~P0~~ 完成 | — |
| B2 | ~~**DebugBus 接入 main.ts**~~：✅ 已完成——main.ts 注入 + orchestrator/planner/role/reasoner/renderer/chat.message span 埋点 | 调试整页 | ~~P0~~ 完成 | — |
| B3 | 会话列表/历史 HTTP 端点（SDK SessionManager → 只读列表 + 消息历史） | 创作编排左栏 | P1 | 中 |
| B4 | scan 返回 needsMigration + 实体/事件统计 | 项目管理卡片 | P1 | 小 |
| B5 | 世界图写接口补齐：声明闭合、实体删除、实体属性编辑 | 实体详情抽屉 | P1 | 中（涉及 underworld-graph 包） |
| B6 | 编排进度事件流（四代理状态/变更摘要/章节结果推送，可复用 chat SSE 或 debug 通道） | 创作编排右栏 | P1 | 中 |
| B7 | plan/yolo 会话级显式设置（存 app-config 或会话状态） | 创作编排控制栏 | P1 | 小 |
| B8 | files/tree 放宽类型（.json/.env）+ 文件重命名 API | 文件编辑 | P1 | 小 |

**建议排期**：~~B1+B2 先做~~（B1/B2 已完成），前端可并行先搭不依赖缺口的视图；B3~B8 随前端进度逐个补。

## 11. 设计稿中本期不做（✂ 汇总）

| 设计稿内容 | 原因 |
|---|---|
| Doctor 里的 Python 版本、Qdrant 向量库检查 | 虚构：项目无 Python 依赖；向量用本地 sqlite-vec，无外置库 |
| .env 的"向量库地址/集合名/最大上下文 token/温度"四键 | 虚构：真实键只有 HF_ENDPOINT/PI_DEBUG/PI_EMBEDDER_MODEL |
| 因果链"未来未知"节点 | 数据模型无未来事件 |
| 声明的"查看推理过程与证据" | 无 AI 溯源数据 |
| 项目删除、实体多参与方 chips | 危险操作/数据模型限制，本期规避 |
| 聊天附件、提示词模板库 | 超范围 |
| 跨文件全局搜索（实体+事件+文件混合） | 现有 search 只覆盖实体/事实；文件搜索前端可自行实现 |
| 浏览文件夹原生对话框 | Web 形态做不到，Tauri 阶段补 |
| 版本号 v0.8.2-beta | 以 package.json 实际版本（0.1.0-alpha.1）为准 |

## 12. 设计系统沿用约定

- 配色/字体/组件规范直接沿用 `narrative-engine-design/colors_and_type.css` 与 design-spec.html 第 1、11 节（暖调文档工具风，brand-500 #c96442，圆角 8px，按钮 5 类、Toast/Modal/空态/加载态规范）。
- validation-report.json 的 18 条软警告（多主色、圆角超刻度、硬编码色）在重写时顺带修正，不单独排期。
- 设计稿 8 页内联重复的同一份导航与主题 CSS，重写时必须抽取为共享外壳组件（app-shell）。
