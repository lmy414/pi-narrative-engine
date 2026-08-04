# World Graph 可视化 V3 设计方案（从零重设计）

> **状态**: ✅ 已实施（2026-08-05 全量核对 `frontend-demo/` 实际代码后重写，本文档为现行可视化的设计依据）
> **历史背景**: V2 版（LiteGraph.js 蓝图风画布）实战后被否——自由画布作为主编辑面对新手不友好、与"查询过滤+字段编辑"的核心需求错配。本文从零重设计。
> **约束**: 服务端 `/api` 契约不变（零改动）；无构建、离线可用、静态文件由 unified-server 直接伺服。

---

## 1. 状态

✅ **已实施**。本文档于 2026-08-05 全量核对 `frontend-demo/` 实际代码后重写，描述的是**现行可视化**而非待评审方案。早期 V3 设计稿（Vue 3 + Element Plus 技术栈、`visualizer-ui/` 目录、多视图切换、右栏分区表单、因果链图）均**未实施**或**已废弃**，差异详见 §8。

## 2. 技术栈

**原生 JavaScript（无框架）+ Tailwind CSS 4（browser CDN）+ Lucide Icons 1.28 + 3d-force-graph 1.80 + three.js 0.160**

| 层 | 选择 | 来源 | 用途 |
|---|---|---|---|
| 应用框架 | **无框架，原生 JS** | — | hash 路由 SPA，全局函数直接挂载于 `window`，模板以字符串拼接 + `innerHTML` 渲染 |
| 样式 | **Tailwind CSS 4.3.1**（browser CDN UMD） | `vendor/tailwind-browser-4.3.1.js` | 浏览器即时编译原子化 CSS，无构建步骤；自定义设计 token 与组件样式补充于 `styles/*.css` |
| UI 组件 | **自研**（无组件库） | — | Drawer / Tab / 时间线 / 表单 / 列表全部自研，以 Tailwind + 自定义 CSS 实现 |
| 图标 | **Lucide Icons 1.28.0** | `vendor/lucide-1.28.0.js` | `lucide.createIcons()` 注入 `<i data-lucide="...">` 占位符 |
| 关系图 | **3d-force-graph 1.80.0**（vasturiano） | `vendor/3d-force-graph-1.80.0.js` | 三维力导图布局，`ForceGraph3D()(container)` 实例化，单视图（无邻域/全景切换） |
| 3D 渲染 | **three.js 0.160.0** | `vendor/three-0.160.0.js` | 自定义节点几何体（`graph3dNodeObject`）；3d-force-graph 内部亦依赖 three |
| 节点文字标签 | **DOM 投影层**（`graph3dLabelLayer`） | — | 不使用 three-spritetext（与 3d-force-graph 内置 three 版本不兼容） |

> **加载顺序**（见 `index.html`）：tailwind → lucide → 3d-force-graph → three。three UMD 必须在 3d-force-graph 之后加载，否则 3d-force-graph UMD 初始化失败（全局不挂载）。

## 3. 页面结构（hash 路由）

`app.js` 定义 7 条路由（`ROUTES` 数组），均通过 hash 路由切换：

| 路由 hash | 视图 id | 标签 | 实现文件 |
|---|---|---|---|
| `#/projects` | projects | 项目 | `views/projects.js` |
| `#/graph` | graph | 世界图 | `views/graph.js` |
| `#/events` | events | 事件链 | `views/events.js` |
| `#/studio` | studio | 创作编排 | `views/studio.js` |
| `#/debug` | debug | 调试 | `views/debug.js` |
| `#/files` | files | 文件 | `views/files.js` |
| `#/settings` | settings | 设置 | `views/settings.js` |

> 项目页（`#/projects`）为独立启动器页面；其余 6 项为工作台导航（`WORKSPACE_NAV`），需要先打开项目才能进入（`VIEWS_NEED_PROJECT` 集合）。每个视图通过 `ViewRender[route]` / `ViewAfterRender[route]` / `viewLoaders[route]` 三件套挂载到统一渲染管线。

## 4. 世界图布局（`#/graph`，三栏工作台）

`ViewRender.graph` 渲染三栏布局，复用 `views.js`（不在 `graph.js` 重复定义）的全局函数：`loadGraph` / `selectEntity` / `stepStoryTime` / `filterGraphEntities` / `openQuickEvent` / `submitQuickEvent` / `openQuickRelation` / `submitQuickRelation` / `openEntityDetail` / `killEntity`。

| 区域 | 职责 | 实现 |
|---|---|---|
| **顶部 StoryTime 选择器** | 全局 `App.storyTime` 的第一公民呈现 | 章节下拉 + 上/下章切换（`stepStoryTime`） |
| **左栏：实体列表** | 查找 | 类型筛选（角色/地点/物品/概念/全部，`graphType`）+ 关键词搜索（`graphFilter`）+ "显示已闭合"开关（`includeClosed`）+ 角色视角选择（`characterView`，默认 `omniscient` 全知）；列表项显示类型色点 + 名称 + 摘要截断 |
| **中栏：3D 力导图** | 理解 | **单视图**，仅 3D（2D canvas 模块已移除）。`ForceGraph3D()(container)` 实例化，`graphData({nodes, links})` 喂数据；左键拖拽旋转、右键平移、滚轮缩放、悬停 tooltip、点击节点→选中并同步 Inspector；类型着色（按 `ENTITY_TYPES[*].color`）；节点几何体走 `graph3dNodeObject`，文字标签走 DOM 投影层 `graph3dLabelLayer` |
| **右栏：Inspector** | 属性 + 关系 + 最近事件 + 编辑入口 | 显示选中实体的属性快照、关系列表、最近事件（从 `graphState('events')` 缓存读取），并提供「编辑详情」入口（`openEntityDetail` 打开 Drawer） |

> **代际守卫**（`graphLoadSeq`）：快速切换 storyTime / 重复进入时，过期请求的写入被丢弃，防止后发先至用旧 storyTime 数据覆盖新数据。
>
> **状态读写**：`graphState(key, fallback)` / `setGraphState(key, value)` 双写命名空间 `viewState('graph')` 与平面 `App.viewState`，兼容旧函数。`selectedEntityId` / `inspectorEntityId` 平面优先。

## 5. 实体详情抽屉（`entity-detail.js`）

**侧滑 Drawer**（非右栏分区表单），通过 `openEntityDetail(entityId)` 打开。Drawer 内含 **5 个 Tab**：

| Tab 键 | 中文标签 | 内容 |
|---|---|---|
| `properties` | 属性 | 当前展示的属性集（预览态用快照属性，否则用实体原始属性）；属性键→中文名映射见 `PROPERTY_LABELS` |
| `declarations` | 声明 | 声明列表，含来源标记（engine=AI 推理 / user=手动，见 `DETAIL_SOURCES`） |
| `relations` | 关系 | 关系列表，对端实体名 + 类型色点 |
| `visibility` | 可见性 | 可见性矩阵（按角色 × 声明，known/unknown 两态，见 `VIS_STATE_LABELS`） |
| `events` | 事件 | 该实体的历史事件时间线（`getEntityHistory` 返回的 events，含 `summarizeEvent` 兜底摘要） |

> **状态**：`detailState`（id / data / snapshot / tab / previewAt / visibility）。`previewAt` 为时间线预览时间点（null=跟随当前全局 storyTime）。
>
> **覆盖约定**：本文件在全局作用域重新声明 `async function openEntityDetail`，与 `views.js` 的同名函数形成确定覆盖（函数声明提升 + 后加载覆盖先加载）。其余新增函数全部使用 `detail*` 前缀，避免与存量全局函数冲突。

## 6. 事件链（`#/events`，独立路由）

`events.js` 实现，**三栏布局**（左栏筛选 / 中栏章节化时间线 / 右栏事件详情面板）：

| 区域 | 内容 |
|---|---|
| **左栏：筛选面板**（`ev-filter-panel`） | 类型/来源/关键词筛选（复用 `DemoUtils.filterEvents`），可折叠 |
| **中栏：章节化时间线** | 纵向时间线列表，按章节分组（`DemoUtils.groupEventsByChapter`）；每条事件一张卡片（时刻、类型、主角、增删声明数、source 着色），点击展开/选中 |
| **右栏：事件详情面板**（`ev-causal-panel`） | 选中事件的详情：类型 / 时间点 / 来源 / 摘要 / **涉及实体**（`eventEntityIds` 收集，点击跳转实体）/ **新事实**（`newFacts[]`）/ **失效声明**（`invalidated[]`）；底部「跳转到世界图（此时刻）」按钮 |

> **因果链图已删除**：原 V3 设计稿中的"因果追溯图"模块未实施。`events.js` 注释明确："因果关系图模块已删除，不再调 `getChain`；图形化因果追溯待世界图 3D 化一并重做"。
>
> **跨页 StoryTime 修复**：跳转世界图「此时刻」不再写 `App.viewState.storyTime` 这类世界图不读的平面垃圾字段（旧代码缺陷）；改为先更新全局 `App.storyTime`（与顶部 StoryTime 选择器同一语义）再 `navigate('#/graph')`，保证跨页 StoryTime 一致。

## 7. 文件结构

```
frontend-demo/                    # 整目录无构建步骤，由 unified-server 直接伺服
├── index.html                    # 入口：vendor 引入（4 文件，含 SRI）+ styles（4 css）+ 视图脚本
├── app.js                        # 全局状态 App / 路由表 / 工具函数 / API 包装
├── api-client.js                 # 真实后端 fetch 封装
├── api-mock.js                   # Mock 后端（?mock=1 启用）
├── mock-data.js                  # Mock 数据
├── demo-utils.js                 # 共享工具（compareStoryTime / groupEventsByChapter / filterEvents / eventEntityIds 等）
├── styles/
│   ├── tokens.css                # 设计 token 基线
│   ├── shell.css                 # 应用框架（导航/顶栏/侧栏）
│   ├── components.css            # 通用组件（Drawer/Tab/表单/列表）
│   └── views.css                 # 各视图专属样式
├── vendor/
│   ├── tailwind-browser-4.3.1.js
│   ├── lucide-1.28.0.js
│   ├── 3d-force-graph-1.80.0.js
│   └── three-0.160.0.js
└── views/
    ├── projects.js               # #/projects
    ├── graph.js                  # #/graph（世界图三栏 + 3D 力导图）
    ├── entity-detail.js          # 实体详情 Drawer（5 Tab，覆盖 views.js 同名函数）
    ├── events.js                 # #/events（事件链三栏）
    ├── studio.js                 # #/studio（创作编排）
    ├── debug.js                  # #/debug
    ├── files.js                  # #/files
    └── settings.js               # #/settings
```

> **无构建步骤**：所有 JS 直接以 `<script src="...?v=20260805-a">` 顺序引入，全局函数挂载于 `window`。`views/entity-detail.js` 通过函数声明覆盖 `views.js` 的 `openEntityDetail`（后加载覆盖先加载）。

## 8. 与原 V3 设计稿的差异说明

原 V3 设计稿（2026-07-23 评审版）与现行实现的差异：

| 维度 | 原 V3 设计稿 | 现行实现 |
|---|---|---|
| 应用框架 | Vue 3（global build，vendored `vue.global.prod.js`） | **原生 JS（无框架）** |
| UI 组件库 | Element Plus（UMD full，vendored ~1MB，含中文 locale） | **无组件库，自研 + Tailwind CSS 4** |
| 关系图视图 | 三视图切换（邻域图 / 全景图 / 快照表） | **单 3D 视图**（ForceGraph3D，2D canvas 已移除） |
| 实体详情 | 右栏分区表单（基本信息/属性/关系/可见性/历史） | **侧滑 Drawer + 5 Tab**（属性/声明/关系/可见性/事件） |
| 事件链 | el-timeline 纵向时间线（页签内） | **独立路由 `#/events`**，三栏布局（筛选 / 章节化时间线 / 事件详情面板） |
| 因果链图 | 未明确（V2 遗留） | **已删除**（`getChain` 不再调用） |
| 顶部时间轴 | storyTime 滑块（第一公民，刻度+事件标记） | **StoryTime 下拉选择器 + 上/下章切换**（无滑块刻度） |
| 文件目录 | `visualizer-ui/` | **`frontend-demo/`**（`visualizer-ui/` 已于 2026-08-04 删除） |
| vendor 文件 | vue / element-plus（4 文件）/ 3d-force-graph / three / three-spritetext / icons/*.svg（29 个） | **4 文件**：tailwind / lucide / 3d-force-graph / three |
| 节点文字标签 | three-spritetext | **DOM 投影层 `graph3dLabelLayer`**（与内置 three 版本不兼容，不用 spritetext） |

## 9. 数据流与 API 映射（服务端零改动）

| 界面元素 | API |
|---|---|
| StoryTime 选择器刻度 | `GET /api/status`（storyTimes + 事件数） |
| 左栏实体列表 | `GET /api/graph?storyTime=&includeClosed=` |
| 搜索 | `GET /api/search?q=&storyTime=&type=` |
| 中栏 3D 力导图 | `GET /api/graph?storyTime=&includeClosed=`（一次拉全量，前端渲染） |
| Inspector「最近事件」 | `GET /api/events`（缓存于 `graphState('events')`） |
| 实体详情 Drawer | `GET /api/entities/:id` + `GET /api/entities/:id/history` + `GET /api/declarations/:id/visibility` |
| 属性/关系编辑 | `POST /api/events`（change，source=user）/ `POST /api/relations(/close)` |
| 可见性矩阵 | `POST /api/visibility(/close)` |
| 事件链列表 | `GET /api/events` |
| 角色视角 | `GET /api/character-view?characterId=&storyTime=` |

## 10. 明确不做

- 不做自由画布上的拖拽连线编辑（图只用于导航）
- 不做多分支对比、实时推送、撤销栈（远期项）
- 不改服务端 `/api` 契约
- 不引入 Vue / Element Plus / 其他前端框架（保持无构建纯静态）
- 不恢复因果链图模块（已删除，待世界图 3D 化一并重做）
