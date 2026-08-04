# 前端 Demo UI 高保真对齐实施计划

> **状态**：✅ 已实施完成（2026-08-02~08-04，frontend-demo 7 页高保真重构 + 测试轮 8 轮验证；设计规格见 `docs/superpowers/specs/2026-08-02-frontend-ui-alignment-design.md`）
> 本文件为执行档案，勾选框不再跟踪。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保留现有 Mock 数据、API 和业务逻辑的前提下，将 `frontend-demo` 重构为与 8 个设计师原型高保真一致且交互完整的桌面创作工作台。

**Architecture:** 原生 HTML/CSS/JavaScript SPA 继续作为运行架构；全局壳层、页面视图和样式按职责拆分，页面状态按路由命名空间隔离。设计稿只作为视觉和信息架构来源，所有动态数据仍经过 `ApiMock` 与统一 API 信封流转。

**Tech Stack:** HTML5、CSS Custom Properties、原生 JavaScript、Canvas/SVG、Node.js `--test` / `--check`、Python 静态服务器。

---

## 文件结构

- 修改 `frontend-demo/index.html`：按依赖顺序装载拆分后的样式与视图脚本。
- 修改 `frontend-demo/app.js`：工作台壳层、路由状态命名空间、键盘行为。
- 修改 `frontend-demo/mock-data.js`：补充设计稿需要的静态状态。
- 修改 `frontend-demo/api-mock.js`：补充可见性、详情、设置和文件操作的 Mock 闭环。
- 创建 `frontend-demo/styles/tokens.css`：设计稿令牌。
- 创建 `frontend-demo/styles/shell.css`：启动器与工作台壳层。
- 创建 `frontend-demo/styles/components.css`：共享控件和状态。
- 创建 `frontend-demo/styles/views.css`：页面专属布局。
- 创建 `frontend-demo/views/projects.js`：项目管理。
- 创建 `frontend-demo/views/graph.js`：世界图。
- 创建 `frontend-demo/views/entity-detail.js`：实体详情。
- 创建 `frontend-demo/views/events.js`：事件链。
- 创建 `frontend-demo/views/studio.js`：创作编排。
- 创建 `frontend-demo/views/debug.js`：调试。
- 创建 `frontend-demo/views/files.js`：文件。
- 创建 `frontend-demo/views/settings.js`：设置。
- 创建 `frontend-demo/demo-utils.js`：可独立测试的 StoryTime、筛选、分组和状态辅助函数。
- 创建 `tests/frontend-demo.test.ts`：纯逻辑回归测试。
- 删除旧 `frontend-demo/tokens.css`、`frontend-demo/app.css`、`frontend-demo/views.js`：所有引用迁移完成后删除。

### Task 1：建立可测试的页面状态与辅助函数

**Files:**
- Create: `frontend-demo/demo-utils.js`
- Create: `tests/frontend-demo.test.ts`
- Modify: `frontend-demo/app.js`

- [ ] 写 StoryTime 比较、章节分组、事件筛选、会话分组、文件字数与设置主题解析的失败测试。
- [ ] 运行 `npx tsx --test tests/frontend-demo.test.ts`，确认因模块不存在而失败。
- [ ] 实现纯函数并通过 `globalThis.DemoUtils` 暴露浏览器版本，同时通过 ESM 导出供测试使用。
- [ ] 将 `App.viewState` 改为 `App.viewState[routeId]` 命名空间，并提供 `viewState(routeId)` 访问器。
- [ ] 运行前端逻辑测试，预期全部通过。

### Task 2：重构设计令牌和全局工作台壳层

**Files:**
- Create: `frontend-demo/styles/tokens.css`
- Create: `frontend-demo/styles/shell.css`
- Create: `frontend-demo/styles/components.css`
- Modify: `frontend-demo/index.html`
- Modify: `frontend-demo/app.js`

- [ ] 从 `colors_and_type.css` 和各原型提取字体、颜色、尺寸、阴影和状态令牌。
- [ ] 重写应用壳层：项目页使用启动器壳层，其他页面使用顶部水平导航。
- [ ] 实现顶部项目入口、一级导航、StoryTime、全局搜索、帮助、账户和主题入口。
- [ ] 为按钮、输入、Tab、Badge、Toggle、Dropdown、Modal、Drawer、Toast 建立高保真共享样式。
- [ ] 添加 `focus-visible`、Escape 关闭和 `prefers-reduced-motion`。
- [ ] 在 1280×720、1440×900 下检查顶栏与工作区无页面级横向溢出。

### Task 3：高保真重构项目管理

**Files:**
- Create: `frontend-demo/views/projects.js`
- Create/Modify: `frontend-demo/styles/views.css`
- Modify: `frontend-demo/index.html`

- [ ] 按 `project-management.html` 重建启动器顶栏、欢迎区、当前项目条、扫描区和项目网格。
- [ ] 恢复项目卡统计、激活/迁移状态、更多菜单、新建内嵌表单和空状态。
- [ ] 连接现有 `scanProjects/createProject/activateProject/migrateProject/closeProject` Mock API。
- [ ] 验证扫描、新建、迁移并激活、关闭和进入项目完整路径。
- [ ] 与设计稿并排检查字号、卡片尺寸、间距、状态标签和菜单。

### Task 4：高保真重构世界图

**Files:**
- Create: `frontend-demo/views/graph.js`
- Modify: `frontend-demo/mock-data.js`
- Modify: `frontend-demo/api-mock.js`
- Modify: `frontend-demo/styles/views.css`

- [ ] 按原型建立实体侧栏、类型 Tab、摘要列表、状态条和中央场景。
- [ ] 加入显示已闭合关系、全知/角色视角和 2D/3D 模式状态。
- [ ] 将现有 Canvas 绘图升级为具有关系标签、类型色、选中光环、平移重置和高保真背景的 SVG/Canvas 图。
- [ ] 恢复快速记事件、快速加关系和右侧 Inspector。
- [ ] 验证 StoryTime 前后切换、筛选、视角、闭合关系和节点选择。

### Task 5：高保真重构实体详情

**Files:**
- Create: `frontend-demo/views/entity-detail.js`
- Modify: `frontend-demo/api-mock.js`
- Modify: `frontend-demo/styles/views.css`

- [ ] 按 `world-graph-detail.html` 建立大型详情 Drawer 和 StoryTime 控件。
- [ ] 实现属性、声明、关系、可见性、事件五个 Tab。
- [ ] 实现摘要编辑、属性新增/修改、声明闭合、关系新增/闭合和实体退场。
- [ ] 实现角色 × 声明可见性矩阵及 known/suspected/unknown 状态。
- [ ] 验证所有写操作刷新当前实体快照且不会丢失 Drawer 状态。

### Task 6：高保真重构事件链

**Files:**
- Create: `frontend-demo/views/events.js`
- Modify: `frontend-demo/styles/views.css`

- [ ] 按 `event-chain.html` 建立左筛选、中时间线、右因果详情三栏。
- [ ] 实现实体多选、类型标签、关键词、重置和章节分组。
- [ ] 实现事件 selected/current/expanded/source 状态。
- [ ] 使用 SVG 绘制选中事件的因果深度、连线和事实变化。
- [ ] 修复跳转世界图写入 `App.storyTime`，验证跨页 StoryTime 同步。

### Task 7：高保真重构创作编排

**Files:**
- Create: `frontend-demo/views/studio.js`
- Modify: `frontend-demo/mock-data.js`
- Modify: `frontend-demo/api-mock.js`
- Modify: `frontend-demo/styles/views.css`

- [ ] 按 `orchestration.html` 建立分组会话、聊天区和 Agent 状态栏。
- [ ] 实现用户、AI、角色、系统消息和 Tool Call 卡片。
- [ ] 实现 deterministic 的 waiting/running/done/failed 前端状态机和流式文本表现。
- [ ] 实现详细 Plan 卡片、阶段折叠、提交和丢弃。
- [ ] 实现派发面板、角色选择与 `@` 提及弹层。
- [ ] 验证 Plan/YOLO、消息发送、编排、Plan 审核、输出文件入口。

### Task 8：高保真重构调试页

**Files:**
- Create: `frontend-demo/views/debug.js`
- Modify: `frontend-demo/mock-data.js`
- Modify: `frontend-demo/styles/views.css`

- [ ] 按 `debug.html` 建立 Level 按钮组、模块、搜索、密度、Buffer 和自动滚动工具栏。
- [ ] 实现日志行展开、Trace/Span/Stage/Type、Payload 和 Stack。
- [ ] 实现 Error 行强调、空状态和清空确认。
- [ ] 验证组合筛选、详细/紧凑视图、自动滚动和清空。

### Task 9：高保真重构文件页

**Files:**
- Create: `frontend-demo/views/files.js`
- Modify: `frontend-demo/api-mock.js`
- Modify: `frontend-demo/styles/views.css`

- [ ] 按 `files.html` 建立双栏文件工作区、文件树、类型图标和文件菜单。
- [ ] 实现多 Tab、dirty、路径、保存状态、最后保存时间和底部状态栏。
- [ ] 实现渲染/源码切换、字号、字数和 Markdown 阅读排版。
- [ ] 将 mtime 冲突改为页面内 Banner，支持重载和强制保存。
- [ ] 验证打开、编辑、保存、关闭未保存文件和冲突恢复。

### Task 10：高保真重构设置页

**Files:**
- Create: `frontend-demo/views/settings.js`
- Modify: `frontend-demo/mock-data.js`
- Modify: `frontend-demo/api-mock.js`
- Modify: `frontend-demo/styles/views.css`

- [ ] 按 `settings.html` 建立应用级/项目级左侧设置导航。
- [ ] 实现模型 Slot 的 inherited/custom 状态、Provider、Model 和保存。
- [ ] 实现密钥脱敏、添加、显示/隐藏和删除的纯前端 Demo。
- [ ] 实现向量模型状态、Warmup、清理缓存、主题卡、字体和自动保存。
- [ ] 实现规则集 Tab、重置、字数、项目信息、环境变量、版本和 Doctor。
- [ ] 修复主题保存为显式赋值，而非取反。

### Task 11：迁移完成与清理

**Files:**
- Modify: `frontend-demo/index.html`
- Delete: `frontend-demo/views.js`
- Delete: `frontend-demo/app.css`
- Delete: `frontend-demo/tokens.css`

- [ ] 确认所有旧函数和样式已迁移且没有重复全局符号。
- [ ] 更新脚本和样式加载顺序。
- [ ] 删除旧的单体视图与旧样式文件。
- [ ] 运行 `node --check` 检查所有 `frontend-demo/**/*.js`。
- [ ] 运行 `npx tsx --test tests/frontend-demo.test.ts`，预期全部通过。

### Task 12：视觉与功能回归

**Files:**
- Verify: `frontend-demo/**/*`
- Reference: `..\narrative-engine-design\pages\*.html`

- [ ] 启动 `python -m http.server 8080`。
- [ ] 逐页检查项目、世界图、实体详情、事件链、创作编排、调试、文件和设置。
- [ ] 分别在 1280×720 与 1440×900 检查布局、滚动区域和无遮挡操作。
- [ ] 与每个设计稿并排核对顶栏、侧栏、信息密度、字体、间距、颜色和关键状态。
- [ ] 验证项目门禁、全局 StoryTime、搜索、主题、Modal、Drawer、Toast 和错误恢复。
- [ ] 运行 `npm test` 与 `npm run build`，确认重构未影响现有工程。
