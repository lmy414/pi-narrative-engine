# 变更记录

本文件记录 narrative-engine 的版本变更。版本号遵循 [Semantic Versioning](https://semver.org/)，
格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.1.0-alpha.1] — 2026-07-30

首个应用化测试版本。在原有"项目级扩展"开发模式之上，新增 Tauri 桌面应用入口与"应用内置扩展"模式，
让终端用户无需克隆仓库、无需手动 `npm install` 即可使用。本次更新同时完成源码工具域拆分、
子包软隔离、可视化前端改造等内部工程治理。

> 本版本仅提供 Windows NSIS 安装器（`narrative-engine_0.1.0-alpha.1_x64-setup.exe`）。
> macOS/Linux 暂未打包。已通过 326+ 单元测试 + 2 个端到端测试，但真实用户场景未充分验证，
> 仅供早期试用与反馈。

### 新增

#### 应用化（Tauri 桌面应用）

- **Tauri 应用骨架**：新增 [`tauri-app/`](tauri-app/) 目录，含 Rust 入口（`src-tauri/src/{lib,main,sidecar}.rs`）、
  Tauri 配置（`tauri.conf.json`）、Windows 图标。应用启动时由 Rust 侧 spawn Node sidecar 子进程承载
  unified-server，应用退出时自动 kill sidecar。
  - sidecar 双模式：开发模式用 `tsx` 跑 `src/app/main.ts`；生产模式用内置 `runtime/node.exe` 跑
    `server/main.js`（esbuild 打包产物）。
  - sidecar 启动失败不再 panic，降级为存 `None` 并由启动页超时提示引导排查。
  - 修复 Windows 下 `tauri::path::resource_dir()` 返回 `\\?\` UNC 前缀导致 Node 模块解析 EISDIR 的问题
    （`sidecar.rs::strip_unc`）。

- **统一服务 unified-server**：新增 [`src/app/`](src/app/) 目录，把原本分散的 world-graph HTTP 服务、
  文件操作、项目管理、应用配置整合到单一 HTTP 服务（默认端口 7421，仅监听 127.0.0.1）。
  - 三入口：pi 内 `open_visualizer` 工具 / standalone `node scripts/visualizer.mjs` /
    应用入口 `node scripts/app-server.mjs [--project <dir>] [--port] [--embed]`。
  - 完整 HTTP API 端点：`/api/files/*`、`/api/projects/*`、`/api/admin/*`（含 `app-config`、
    `extension/{mode,update-check,reinstall}`、`rulesets/*`、`doctor`、`version`、`embedder/*`、
    `novel-json`、`update/stream`）。
  - 项目注册表 `ProjectRegistry`：多项目并发管理，按目录隔离 WorldGraph 句柄。

- **应用内置扩展模式**：新增 `packages/admin/src/app-config.ts::reinstallExtension`，
  从应用打包的 `extension-snapshot/` 复制扩展到平台应用数据目录
  （Windows `%APPDATA%\narrative-engine\extensions\narrative-engine\`）并跑 `npm install --omit=dev`。
  - 应用级配置 `app-config.json`：`extension.{mode,globalPath,useExplicitFlag,version,lastUpdated}`、
    `launcher.{piExecutable,defaultScanRoots}`、`embedder.{model}`。
  - 启动 PI 时按配置自动拼参数：`disabled` → `--no-extensions`；
    `useExplicitFlag=true` → `--no-extensions -e <globalPath>`（屏蔽自动发现 + 显式加载全局扩展，
    避免项目级与全局扩展重复加载）；否则走 PI 自动发现。
  - `POST /api/admin/extension/reinstall` 端点：应用内一键重装扩展。
  - `GET /api/admin/extension/update-check` 端点：比对已安装版本与快照版本。

- **sidecar 打包脚本**：新增 [`scripts/package-sidecar.mjs`](scripts/package-sidecar.mjs)，
  把 unified-server 打包为 Tauri sidecar 资源。
  - 布局：`<out>/runtime/node[.exe]`（内置 Node 运行时）+ `<out>/server/main.js`（esbuild bundle，
    含 src + @pi/* 子包 TS 全内联）+ `<out>/server/node_modules/`（原生模块按本平台解析）+
    `<out>/server/visualizer-ui/` + `<out>/server/templates/` + `<out>/server/extension-snapshot/`。
  - 原生模块（better-sqlite3 / sqlite-vec / onnxruntime-node / @xenova/transformers）保持外部，
    跨平台需在目标平台执行打包脚本。

#### 新子包

- **`@pi/admin`**（[`packages/admin/`](packages/admin/)）：应用级配置管理后端核心库。
  10 个模块：`app-config`（应用配置 + 扩展安装/重装）、`env-store`（项目级 .env）、
  `pi-status`（PI 进程状态）、`rulesets`（规则集 CRUD）、`doctor`（环境自检）、
  `updater`（git 更新 + 重建 + 重装扩展）、`embedder-status`（向量模型状态）、
  `novel-json`（novel.json 读写）、`files`（项目文件浏览/读写）、`types`。
- **`@pi/novel-launcher`**（[`packages/novel-launcher/`](packages/novel-launcher/)）：
  项目发现与跨平台启动 PI 后端核心库。导出 `discoverProjects`（扫描含 novel.json 的目录）、
  `launchPi`（Windows/macOS/Linux 新终端窗口启动 PI）、`createProject`（库化新建项目，
  不再 spawn 子进程）、`launchVisualizer`、`openInFileManager`。

#### 可视化前端

- **6 页导航 + 4 个新页面**：visualizer-ui 新增 `projects-view.js`（项目列表/扫描/新建/激活）、
  `editor-view.js`（项目文件浏览/编辑/保存）、`settings-view.js`（应用配置编辑：扩展模式/PI 路径/
  扫描根/向量模型 + 扩展重装 + 更新检查）、`stream-view.js`（git 更新 SSE 日志流）。
  配套新增 `tokens.css`（设计令牌）、`proto.css`（原型样式）、`proto-utils.js`（原型工具函数）、
  `vendor/icons/`（29 个 SVG 图标）。
  > 阶段 2b（既有三页 工作台/事件链/调试 从 Element Plus 迁移到原型设计体系）未实施，
  > 过渡期允许新旧体系共存。

### 变更

- **源码工具域拆分**：`src/index.ts` 从 1351 行拆分为 6 个工具域文件
  （`src/tools/{shared,world-tools,render-tools,role-tools,scheduler-tools,import-tools,visualizer-tools}.ts`）
  + `src/session-state.ts`，提升可维护性。
- **5 个子包 index.ts 软隔离**：`packages/{world-graph,role-pool,scheduler,renderer,novel-importer}/src/index.ts`
  统一采用 `_` 前缀标记内部实现，公共 API 显式导出，禁止跨包引用内部符号。
- **扩展加载策略**：`packages/novel-launcher/src/launch.ts::_buildExtensionArgs` 在显式加载模式下
  改为 `["--no-extensions", "-e", path]`（原来只有 `["-e", path]`），屏蔽 PI 自动发现，
  避免项目级 `.pi/extensions/` 与全局扩展目录同时加载导致重复。
- **dev 模式回退探测 extensionSnapshotDir**：`src/app/main.ts` 在入口同级 `extension-snapshot`
  不存在时回退到 `<repoRoot>/tauri-app/src-tauri/resources/server/extension-snapshot`，
  让 `reinstall` 端点在开发模式下可用。
- **tauri.conf.json resources 改映射形式**：`resources/runtime/**/*` → `runtime/`、
  `resources/server/**/*` → `server/`，配合 `sidecar.rs::spawn_prod` 的路径解析。
- **`createProject` 库化**：不再 spawn `scripts/init-novel.mjs` 子进程（sidecar 无脚本文件），
  改为直接调用库函数；`ProjectRegistry` 的 `allowInit` 自动初始化空库；
  `WorldGraph.create` 失败路径关闭 db 句柄（修复 Windows world.db 文件锁定）。
- **schema 迁移通道**：`WorldGraph.migrate()` 静态方法、`ProjectRegistry::migrateProject`
  （先备份 world.db 再迁移）、`MIGRATION_REQUIRED` 结构化错误 + `POST /api/projects/migrate` 端点。

### 修复

- **Windows spawn EINVAL**：`packages/admin/src/app-config.ts::_runNpmInstall` 与
  `scripts/package-sidecar.mjs` 的 spawn 选项补 `shell: process.platform === "win32"`，
  修复 Windows 下 spawn `npm.cmd` 报 EINVAL 的问题。
- **生产模式启动闪退**：Tauri `resource_dir()` 返回 UNC 前缀路径导致 Node EISDIR /
  sidecar 启动失败时 panic 让应用闪退 / 资源映射路径错乱，三处问题一并修复。

### 文档

- 全量维护文档与实际项目状态对齐：补全 README 子包表、新增应用内置模式安装指南
  （[`docs/app-mode.md`](docs/app-mode.md)）、补全 unified-server API 端点表、
  补全可视化新页面说明、补全第三方依赖盘点。详见各文档头部"最后更新"标记。

### 已知限制

- **平台覆盖**：仅提供 Windows NSIS 安装器；macOS/Linux 暂未打包。
- **阶段 2b 未实施**：可视化既有三页（工作台/事件链/调试）仍用 Element Plus 旧体系，
  与新页面（projects/editor/settings/stream）的原型设计体系共存，视觉不统一。
- **config-ui §三未实施**：LLM 配置改造（删除 `llm-config.ts` 与 `PI_*_API_KEY`/`PI_MODEL`
  环境变量，统一走应用配置）未实施，当前仍按 `docs/SETUP.md` 环境变量方式配置。
- **`import_novel` / `import_character_card` 为测试实现**：功能链路可用，但实体消解准确性、
  事件粒度、属性命名一致性、关系抽取完整性均未达生产标准，建议仅用于试验。
- **跨平台原生模块未验证**：sidecar 打包内的 better-sqlite3 / sqlite-vec / onnxruntime-node
  原生模块在 Windows 上验证可用，macOS/Linux 未实测。

---

## [0.1.0] — 2026-07-25

首个公开版本。基于 pi 的叙事引擎扩展：世界图（bi-temporal）+ 角色池 + 调度器 + 渲染器，
让你用口述驱动小说创作——引擎维护世界状态，角色按信息差扮演，正文自动渲染。

### 核心功能

- **bi-temporal 世界图**（`underworld-graph`）：SQLite + FTS5 + 向量，实体/事实/关系/可见性，
  故事时间 × 事务时间双轴查询（`recordedAsOf`）。
- **调度器**（`@pi/scheduler`）：plan/yolo 双模式，planner LLM 推导检索计划 → 世界图检索
  （信息差分配）→ 角色编排 → 写扩散 + 渲染。
- **角色池**（`@pi/role-pool`）：串行扮演，酒馆卡静态层 + 动态事实注入。
- **渲染器**（`@pi/renderer`）：结构化输出 → 规则集约束的正文，锚点写盘，支持 append/modify/insert。
- **小说导入器**（`@pi/novel-importer`）：EPUB → 世界图 8 阶段管道（测试实现）。
- **跨会话项目记忆**：`memory.md` 自动维护当前进度/在场角色/最近事件，新会话自动注入。
- **AI 使用指南注入**：原 `engine-guide.md` / `main-session.md` 强制注入；后合并抽离为单一 pi Skill
  （`src/skills/narrative-engine/SKILL.md`），通过 `resources_discover` 注册由 pi skill 机制按需 read 加载。
- **调试管线**：DebugBus 环形缓冲 + SSE 端点 + 可视化"调试" tab，实时显示调度链 DAG（`PI_DEBUG=off` 可禁用）。
- **P0 修复**：双时态检索接入调度器 + commit 写 embedding + knowledge_gained 他盲可见性 + 部分成功语义。

### 测试

- 326+ 单元测试（world-graph 59 / role-pool / scheduler / renderer / novel-importer / 根套件）。
- 三平台 CI（ubuntu / windows / macos × node 20/22）。
