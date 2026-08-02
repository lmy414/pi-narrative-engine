# 可视化服务（Visualizer）

> 属于 [API 文档索引](README.md)。世界图可视化前端：按 storyTime 快照浏览/过滤实体与关系、搜索定位、手动编辑字段（全部走 API，编辑产生 `source: "user"` 事件）、事件链视图、角色视角模式、历史审计。
> 统一服务（应用化多项目扩展端点）见 [unified-server.md](unified-server.md)，调试 tab 见 [debug-bus.md](debug-bus.md)。

时间轴 UI（2026-07-25 优化）：两级分组防重叠——层级 storyTime（如 `ch009.ev003`）自动拆为
章级刻度 + 当前章事件刻度；非层级 storyTime 用稀疏标签 + `‹ ›` 步进 + 下拉直跳。

## 11.1 启动方式（三入口）

- pi 会话内 + standalone 共用 `src/visualizer/server.ts` 的 `startVisualizer`（单项目，绑定一个 WorldGraph 实例）
- 应用入口用 `src/app/unified-server.ts` 的 `startUnifiedServer`（多项目 + `/api/files` / `/api/projects` / `/api/admin` 扩展端点，详见 [unified-server.md](unified-server.md)）

### 11.1.1 pi 会话内

调用 `open_visualizer` 工具（见 [pi-tools-world.md](pi-tools-world.md) §4.8）。

**行为**：
- 幂等：已启动时直接返回现有 URL（`alreadyRunning: true`）
- 注入 session 的 `WorldGraph` 与 `Search` 实例（含 Embedder，支持 vector/hybrid 检索）
- `session_shutdown` 时自动关闭服务
- `forceFulltext = false`（前端传 `mode=vector`/`hybrid` 正常生效）

### 11.1.2 standalone（脱离 pi）

```bash
node scripts/visualizer.mjs [--db <dir>] [--port 7421] [--embed]
```

**参数**：
| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--db <dir>` | `../novel/.pi/world-graph-v3/`（相对仓库根） | 世界图数据目录，需含 `world.db` / `events.jsonl` |
| `--port <n>` | 7421 | 监听端口（0-65535） |
| `--embed` | 关闭 | 加载 Xenova/bge-small-zh-v1.5 向量模型（首次下载较慢），启用 vector/hybrid 检索 |

**检索模式行为**：
- 不带 `--embed`：`forceFulltext = true`，即使前端传 `mode=vector`/`hybrid` 也会被服务端强制降级为 `fulltext`（因 `Search.fulltext` 不依赖 embedder，传 null 占位即可）
- 带 `--embed`：`forceFulltext = false`，三种模式正常生效

**进程信号**：`SIGINT` / `SIGTERM` 触发优雅关闭（`server.close()` + `wg.close()` + `process.exit(0)`）。

**脚本链路**：`scripts/visualizer.mjs`（薄壳）→ spawn `tsx` 运行 `src/visualizer/standalone.ts`（实际启动逻辑）。薄壳存在的原因是源码用 TypeScript + `.ts` import specifier，node 无法直接加载。

### 11.1.3 应用入口（unified-server，脱离 pi）

```bash
node scripts/app-server.mjs [--project <dir>] [--port 7421] [--embed]
```

应用化模式的 standalone 入口，启动 `src/app/unified-server.ts` 的 `startUnifiedServer`（与 `startVisualizer` 是两套独立实现）。单端口整合 world-graph 路由 + `/api/files/*` + `/api/projects/*` + `/api/admin/*` + 静态服务，由 `ProjectRegistry` 按目录隔离多个项目的 `WorldGraph` 句柄。详见 [unified-server.md](unified-server.md)。

**参数**：
| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--project <dir>` | 不激活 | 启动时预激活项目目录（失败不阻断启动，可稍后经 `/api/projects/activate` 激活） |
| `--port <n>` | 7421 | 监听端口（0-65535，0 由系统分配） |
| `--embed` | 关闭 | 加载 Xenova/bge-small-zh-v1.5 向量模型，启用 vector/hybrid 检索；不带则所有项目 `forceFulltext` |

**双模式**（`src/app/main.ts`）：
- 开发：`scripts/app-server.mjs` 以 `tsx` 拉起 `src/app/main.ts`，路径自动探测 `uiDir` / `templatesDir` / `repoRoot` / `extensionSnapshotDir`
- 生产：esbuild 打包为 `server/main.js`，由 Tauri sidecar 以内置 Node 运行；入口同级资源（`visualizer-ui/` / `templates/` / `extension-snapshot/`）存在即显式传入，不存在回退开发模式自动探测

**`extensionSnapshotDir` 探测顺序**：
1. `<__dirname>/extension-snapshot`（生产打包布局）
2. `<__dirname>/../../tauri-app/src-tauri/resources/server/extension-snapshot`（开发模式回退，让 `reinstall` 端点在开发模式下可用）

**进程信号**：`SIGINT` / `SIGTERM` 触发优雅关闭（`server.close()` + `registry.closeAll()` + `process.exit(0)`）。

### 11.1.4 静态文件服务

- `uiDir` 默认探测顺序（`resolveDefaultUiDir`）：
  1. `<__dirname>/../../visualizer-ui`（开发态：`src/visualizer/` 上两级 = 仓库根；构建态：`dist/visualizer/` 上两级 = 仓库根）
  2. `<__dirname>/../visualizer-ui`（同步态：扩展目录下 `visualizer/server.js` 上一级 = 扩展目录根，`sync.mjs` 将 `visualizer-ui` 复制到此）
- 路径穿越防护：`filePath` 必须以 `normalize(uiDir)` 开头，否则 403
- 未知文件 404；`/` 映射到 `index.html`
- 支持的 Content-Type：`.html`/`.js`/`.mjs`/`.css`/`.json`/`.map`/`.svg`/`.png`/`.jpg`/`.jpeg`/`.gif`/`.ico`/`.woff`/`.woff2`/`.ttf`/`.txt`，其余按 `application/octet-stream`

## 11.2 HTTP JSON API（`/api` 前缀，统一 envelope）

成功 `{ ok: true, data, error: null }`；失败 `{ ok: false, data: null, error: { code, message } }`。

所有响应带 `access-control-allow-origin: *`。`OPTIONS` 方法统一返回 204 + CORS 预检头（`GET, POST, OPTIONS` / `content-type`）。非 GET/POST/OPTIONS 方法返回 404 `NOT_FOUND`（`/api` 路径外非 GET 返回 405 纯文本）。

### 11.2.1 查询端点（GET）

| Path | 必填参数 | 返回 data 结构 | 说明 |
|---|---|---|---|
| `/api/status` | — | `{ entityCount, eventCount, storyTimes }` | entityCount 基于 latest storyTime；storyTimes 升序 |
| `/api/graph` | `storyTime` | `{ entities, relations }` | `includeClosed=1` 时 relations 来自 `getRelationHistory()`（全量），否则 `getAllRelationsAt(storyTime)`（仅有效） |
| `/api/entities/:id` | `storyTime` | `EntitySnapshot` | 404 `ENTITY_NOT_FOUND` 若该时刻不存在 |
| `/api/entities/:id/history` | — | `{ ...entityHistory, relations }` | 实体全版本历史 + 该实体的全量关系历史（含已闭合） |
| `/api/declarations/:declId/visibility` | —（`storyTime` 可选） | `{ declarationId, visibility }` | 该声明的可见性记录（反向查询），`storyTime` 缺省返回全部 |
| `/api/search` | `q`, `storyTime` | `{ results: EntitySearchResult[] }` | `mode`：`fulltext`/`vector`/`hybrid`（缺省 `hybrid`，`forceFulltext` 时强制 `fulltext`）；`type`：`character`/`location`/`item`/`concept` 可选过滤 |
| `/api/events` | — | `{ events: EventRecord[] }` | 全量事件日志 |
| `/api/events/:id/chain` | — | `{ events: EventRecord[] }` | 因果链（`traceCauses` 回溯到根） |
| `/api/character-view` | `characterId`, `storyTime` | `{ view }` | 角色视角可见声明 |
| `/api/debug/stream` | — | SSE 流（`text/event-stream`） | **调试模块**：先发送历史快照，再实时推送新 DebugEvent；每 30 秒 `:heartbeat` 防代理超时；客户端断开自动取消订阅 |
| `/api/debug/events` | — | `{ events: DebugEvent[] }` | **调试模块**：一次性拉取环形缓冲内所有 DebugEvent（JSON） |

> `/api/debug/*` 路由独立处理（SSE 流不能进入常规 try/catch，res 不 end）。`debugBus` 未注入时所有 `/api/debug/*` 返回 503 `DEBUG_UNAVAILABLE`。

### 11.2.2 写入端点（POST）

所有写入端点的 `source` 字段被服务端强制为 `"user"`（前端无法伪造 `engine` 来源）。

| Path | 必填 body 字段 | 行为 |
|---|---|---|
| `/api/events` | `eventId`, `type`, `storyTime`, `entityId` | 应用事件（`EventRecordInput`）；birth 可含 `entityType`/`summary`，change = invalidated+newFacts（即"编辑字段"） |
| `/api/entities/:id/props` | `property`, `value`, `storyTime`（可选 `modality`） | 编辑实体属性（事件溯源：构造 change 事件，闭合该 property 当前声明 + 写新值；事件 ID 后端生成；返回 `{entityId, property, closedDeclarationId, newDeclarationId}`） |
| `/api/declarations/close` | `declarationId`, `entityId`, `storyTime` | 闭合声明（change 事件单条 invalidated；不存在 404 `DECLARATION_NOT_FOUND`，已闭合 409 `DECLARATION_CLOSED`） |
| `/api/entities/:id/kill` | `storyTime` | 实体退场（`death` 事件，双时态闭合——语义"删除"，无物理删除；实体不存在 404 `ENTITY_NOT_FOUND`） |
| `/api/entities/:id/summary` | `summary` | 更新实体摘要（`updateEntitySummary`） |
| `/api/relations` | `sourceId`, `targetId`, `label`, `storyTime` | 新建关系（`addRelation`） |
| `/api/relations/close` | `sourceId`, `targetId`, `label`, `storyTime` | 闭合关系（`closeRelation`） |
| `/api/visibility` | `characterId`, `declarationId`, `confidence`, `source`, `storyTime` | 设置可见性（`setVisibility`，服务端强制 `state: "known"` + `isExplicit: true`） |
| `/api/visibility/close` | `characterId`, `declarationId`, `storyTime` | 撤销可见性（`closeVisibility`） |
| `/api/debug/clear` | — | **调试模块**：清空环形缓冲（`bus.clear()`） |

### 11.2.3 扩展端点（unified-server 提供，原 visualizer-server 不提供）

`/api/files`、`/api/projects`、`/api/admin` 三组扩展路由（`src/app/routes-ext.ts::handleExtApi`）与错误码见 [unified-server.md](unified-server.md)。

### 11.2.4 错误码

| HTTP | code | 触发场景 |
|------|------|----------|
| 400 | `INVALID_JSON` | POST 请求体 JSON 解析失败 |
| 400 | `INVALID_BODY` | 请求体不是 JSON 对象 |
| 400 | `MISSING_FIELD` | 缺少必填字段（query 或 body） |
| 400 | `STORY_TIME_REQUIRED` | 缺少必填参数 `storyTime` |
| 400 | `VALIDATION_ERROR` | 写入路径 zod 校验失败（`ZodError`） |
| 400 | `BUSINESS_ERROR` | 写入路径业务错误（实体不存在/已闭合等 WorldGraph 方法抛出） |
| 404 | `ENTITY_NOT_FOUND` | `GET /api/entities/:id` 该时刻无快照；`POST entities/:id/props|kill` 实体不存在 |
| 404 | `DECLARATION_NOT_FOUND` | `POST /api/declarations/close` 声明不存在 |
| 409 | `DECLARATION_CLOSED` | `POST /api/declarations/close` 声明已闭合 |
| 404 | `NOT_FOUND` | 未知路由 / 不支持的 method |
| 405 | —（纯文本 `Method Not Allowed`） | 非 GET/POST/OPTIONS 且非 `/api` 路径 |
| 500 | `INTERNAL_ERROR` | GET 路径未捕获异常 |
| 500 | `INTERNAL_ERROR` | 兜底：任何未捕获异常（保证连接不悬挂） |
| 501 | `SEARCH_UNAVAILABLE` | `GET /api/search` 未注入 Search 实例 |
| 503 | `DEBUG_UNAVAILABLE` | `/api/debug/*` 未注入 debugBus（`PI_DEBUG=off` 或会话未创建调试总线） |

## 11.3 前端（`visualizer-ui/`，Vue 3 + Element Plus）

V3 workbench UI（commit 28405bc）：Vue 3 全局构建 + Element Plus 组件库 + 双图视图（2D LiteGraph 画布 + 3D 力导向图）。

### 11.3.1 入口与脚本加载

- **主入口**：`index.html`（V3 workbench UI，`<html class="dark">` 暗色主题）
- **V2 遗留入口**：`v2-legacy.html`（旧版 LiteGraph 画布，兼容旧书签）
- **脚本加载顺序**（`index.html`）：
  1. vendor：`vue.global.prod.js` → `element-plus.full.min.js` → `element-plus.locale.zh-cn.min.js` → `three.min.js` → `three-spritetext.min.js` → `3d-force-graph.min.js`
  2. `api.js`（HTTP 客户端封装）+ `proto-utils.js`（原型设计体系工具函数）
  3. components：`timeline-bar` → `entity-list` → `graph-3d` → `snapshot-table` → `relation-form` → `detail-editor` → `entity-form` → `event-timeline` → `help-tour` → `debug-view` → `stream-view` → `projects-view` → `editor-view` → `settings-view`
  4. `app.js`（Vue 应用根，最后加载）

### 11.3.2 主要文件

| 文件 | 职责 |
|------|------|
| `app.js` | Vue 应用根（状态管理 + 路由切换 + 主布局） |
| `api.js` | HTTP 客户端封装（统一调用 `/api/*`） |
| `detail-panel.js` | 五页签详情抽屉（基本/属性/关系/可见性/历史） |
| `graph-view.js` | **2D LiteGraph 画布**：实体卡片节点（四类类型色）+ 自绘关系边（两点模式新建、右键闭合）+ 节点位置 localStorage 持久化 |
| `events-view.js` | 事件链视图 |
| `components/graph-3d.js` | **3D 力导向图**（3d-force-graph 隔离层，邻域图/全景图共用） |
| `components/entity-list.js` | 左栏实体列表（类型过滤、搜索） |
| `components/detail-editor.js` | 字段编辑器（全部走 API，编辑产生 `source: "user"` 事件） |
| `components/relation-form.js` | 关系新建/闭合表单 |
| `components/event-timeline.js` | 事件时间线 |
| `components/snapshot-table.js` | storyTime 快照选择器表格 |
| `components/timeline-bar.js` | 顶部 storyTime 时间轴 |
| `components/entity-form.js` | 实体新建/编辑表单 |
| `components/help-tour.js` | 新手引导 |
| `components/debug-view.js` | **调试 tab**：SSE 客户端订阅 `/api/debug/stream`、按 `traceId` 聚合的 DAG 流程图（SVG 节点 + 右键折线连接）、节点详情抽屉、工具栏（清空缓冲 / 暂停推送 / 拉取历史） |
| `components/projects-view.js` | **项目页**：项目列表 / 扫描根 / 新建 / 激活 / 启动 PI / 打开文件夹（消费 `/api/projects/*`） |
| `components/editor-view.js` | **编辑器页**：项目文件树 + 文件读写编辑（消费 `/api/files/*`） |
| `components/settings-view.js` | **设置页**：应用配置编辑（扩展模式 / PI 路径 / 扫描根 / 向量模型）+ 扩展重装 + 更新检查（消费 `/api/admin/app-config` / `/api/admin/extension/*`） |
| `components/stream-view.js` | **更新流页**：订阅 `/api/admin/update/stream` SSE，展示 git 更新实时日志 |
| `v2-legacy-app.js` / `v2-legacy.css` / `v2-legacy.html` | V2 遗留页面（兼容旧入口） |

### 11.3.3 vendor 依赖

| 文件 | 用途 |
|------|------|
| `vue.global.prod.js` | Vue 3 全局构建 |
| `element-plus.full.min.js` + `element-plus.index.css` + `element-plus.dark.css-vars.css` + `element-plus.locale.zh-cn.min.js` | Element Plus 组件库（暗色主题 + 中文） |
| `three.min.js` + `three-spritetext.min.js` + `3d-force-graph.min.js` | 3D 力导向图 |
| `litegraph.js` + `litegraph.css` | 2D 节点画布（V2 遗留，V3 主入口已改用 3D，但 `graph-view.js` 仍保留 LiteGraph 实现） |

### 11.3.4 功能

按 storyTime 快照浏览/过滤实体与关系、搜索定位、手动编辑字段（全部走 API，编辑产生 `source: "user"` 事件）、事件链视图、角色视角置灰、历史审计。节点位置存浏览器 localStorage，不污染存储层。

**调试 tab**（2026-07-27 新增）：切换到"调试"页签后订阅 SSE 流，按 `traceId` 聚合 DebugEvent 重建调度链 DAG（plan → retrieve → role.turn × N → commit.step.4 × N → commit.step.4.4 → commit.step.5 → commit.step.7 → commit）。节点状态色编码（start 蓝 / end 绿 / error 红），节点详情抽屉展示 payload 与耗时。`debugBus` 未注入时 tab 显示空状态提示。

## 11.4 同步与测试

**同步**：`scripts/sync.mjs` 会将 `visualizer-ui/` 一并复制到扩展目录（`novel/.pi/extensions/narrative-engine/visualizer-ui/`）。

**测试**：`tests/visualizer-server.test.ts`（15 个集成测试）
```bash
npx tsx --test tests/visualizer-server.test.ts
```

覆盖：静态文件服务、API envelope、所有 GET/POST 端点、错误码、CORS、路径穿越防护、端口分配（传 0 由系统分配）。

> `/api/debug/*` 端点由 `tests/debug/sse.test.ts` 单独覆盖（SSE 流特殊，无法走标准 HTTP 集成测试）。
