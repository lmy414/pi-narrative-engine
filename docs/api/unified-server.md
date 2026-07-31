# 统一服务（Unified Server）与应用化子包

> 属于 [API 文档索引](README.md)。应用化模式的核心：把原本分散的 world-graph HTTP 服务、文件操作、项目管理、应用配置整合到单一 HTTP 服务。源码位于 `src/app/`，由 `unified-server.ts` 的 `startUnifiedServer` 启动。world-graph 基础路由见 [visualizer.md](visualizer.md)。

## 11.5.1 设计要点

- **单端口**：默认 7421（`--port` 可改，传 0 由系统分配），仅监听 `127.0.0.1`（不暴露网络，端点不做鉴权）
- **路由优先级**：`/api/files` / `/api/projects` / `/api/admin` 扩展路由优先匹配（`handleExtApi`），未命中再进 world-graph 路由（`handleApi`，复用 `src/visualizer/routes.ts`）
- **活跃项目依赖**：world-graph 路由 + 大部分 `/api/files` / `/api/admin` 端点从 `registry.getActive()` 取上下文，未激活时返回 409 `NO_ACTIVE_PROJECT`；`/api/projects/*` 与 `/api/admin/{app-config,extension/*,doctor,version,pi-status,embedder/*,update/stream}` 不受此限
- **静态服务**：复用 `src/visualizer/server.ts` 的 `serveStatic` + `resolveDefaultUiDir`，`uiDir` 缺省自动探测 visualizer-ui
- **响应 envelope**：与 world-graph 路由一致 `{ ok, data, error: { code, message } }`；POST/PUT 请求体 JSON 解析失败返回 400 `INVALID_JSON`；任何未捕获异常兜底 500 `INTERNAL_ERROR`（连接不悬挂）
- **非 GET/POST/PUT 且非 `/api` 路径**：返回 405 `Method Not Allowed`（纯文本）

## 11.5.2 `ProjectRegistry` 多项目句柄隔离

`src/app/project-registry.ts` 的 `ProjectRegistry` 类按目录缓存已打开项目句柄（`ProjectHandle`：`dir` / `meta` / `wg` / `search` / `forceFulltext`），同时只有一个活跃项目。world-graph / files / admin 路由全部从 `getActive()` 取上下文。

| 方法 | 说明 |
|------|------|
| `openProject(dir, options?: { allowInit? })` | 打开项目（幂等，已打开返回缓存句柄）；`allowInit=true` 时无 `world.db` 自动初始化空库；抛 `NOVEL_JSON_NOT_FOUND` / `WORLD_DB_NOT_FOUND` / `MIGRATION_REQUIRED`（`RegistryError`） |
| `setActive(dir, options?)` | 切换活跃项目（未打开则先打开，透传 `allowInit`） |
| `migrateProject(dir)` | 迁移 schema（先备份 `world.db` 为 `world.db.bak-<ts>`，再 `WorldGraph.migrate`，返回 `MigrateResult & { backupPath }`）；项目处于打开状态抛 `PROJECT_OPEN` |
| `getActive()` / `getActiveDir()` | 当前活跃项目句柄 / 目录（未设置为 null） |
| `listOpen()` | 已打开项目列表（`{ dir, name, active }`） |
| `closeProject(dir)` | 关闭项目释放 wg（关闭活跃项目时活跃指针置空，未打开为 no-op） |
| `closeAll()` | 关闭全部（服务关闭时调用） |

> 句柄缓存无上限（项目数很小），非活跃项目保持打开以支持快速切回。共享 embedder 注入：所有项目共用一个 `Embedder` 实例；未注入时所有项目 `forceFulltext = true`。

## 11.5.3 三入口对照

| 入口 | 启动命令 | 实现 | 适用场景 |
|------|----------|------|----------|
| pi 会话内 | `open_visualizer` 工具 | `src/visualizer/server.ts::startVisualizer` | 创作时调试世界图 |
| standalone | `node scripts/visualizer.mjs` | `src/visualizer/standalone.ts` | 脱离 pi 单项目浏览 |
| 应用入口 | `node scripts/app-server.mjs` | `src/app/main.ts` → `startUnifiedServer` | 桌面应用 / 多项目管理 |

unified-server 与 visualizer-server 是两套独立实现：前者整合 world-graph + files + projects + admin + 静态 + ProjectRegistry 多项目；后者绑定单个 WorldGraph 实例。两者共用 `src/visualizer/routes.ts`（world-graph 路由）与 `src/visualizer/server.ts` 的静态服务工具（`serveStatic` / `readBody` / `resolveDefaultUiDir`）。

## 11.2.3 扩展端点（`/api/files` / `/api/projects` / `/api/admin`）

unified-server 在 world-graph 路由之前优先匹配这三组扩展路由（`src/app/routes-ext.ts::handleExtApi`）。响应 envelope 与 world-graph 路由一致（`{ ok, data, error }`）。需活跃项目的端点从 `registry.getActive()` 取项目根，未设置时返回 409 `NO_ACTIVE_PROJECT`；`/api/projects/*` 与 `/api/admin/{app-config,extension/*,doctor,version,pi-status,embedder/*,update/stream}` 不受此限。

**`/api/files/*`（文件编辑器后端，需活跃项目）**

| Method | Path | 简述 |
|---|---|---|
| GET | `/api/files/tree` | 列出项目文件树（`listFileTree`） |
| GET | `/api/files/read?path=` | 读取文件内容（`readProjectFile`，path 必填） |
| PUT | `/api/files/write` | 写文件（body: `path`/`content`/`baseMtime?`，`MTIME_CONFLICT` 409） |
| POST | `/api/files/create` | 新建文件（body: `path`，201，`FILE_EXISTS` 409） |
| POST | `/api/files/delete` | 删除文件（body: `path`） |

**`/api/projects/*`（项目管理，不需活跃项目）**

| Method | Path | 简述 |
|---|---|---|
| GET | `/api/projects/scan?root=&maxDepth=` | 扫描含 `novel.json` 的项目目录（`discoverProjects`，root 必填） |
| GET | `/api/projects/meta?dir=` | 项目元数据（`getProjectMeta`，dir 必填） |
| GET | `/api/projects/active` | 当前活跃项目 + 已打开列表（`registry.getActive()` + `listOpen()`） |
| POST | `/api/projects/activate` | 激活项目（body: `dir`，`allowInit=true` 自动初始化空库） |
| POST | `/api/projects/migrate` | 迁移数据库 schema（body: `dir`，先备份 `world.db` 再 `WorldGraph.migrate`，`PROJECT_OPEN` 409） |
| POST | `/api/projects/create` | 新建项目（body: `dir`/`name?`/`force?`，201，`createProject` 库化） |
| POST | `/api/projects/launch-pi` | 启动 PI（body: `dir`/`args?`，扩展加载策略来自 `appConfig`：`disabled` 拼 `--no-extensions`；`useExplicitFlag=true` 用 `-e <globalPath>` 显式加载） |
| POST | `/api/projects/open-folder` | 在文件管理器打开（body: `dir`） |
| POST | `/api/projects/close` | 关闭项目释放 wg 句柄（body: `dir`） |

**`/api/admin/*`（配置管理）**

| Method | Path | 简述 |
|---|---|---|
| GET | `/api/admin/config` | 读扩展 .env（活跃项目根 `.env`，`readEnvFile`） |
| PUT | `/api/admin/config` | 写 .env（body: `HF_ENDPOINT`/`PI_DEBUG`/`PI_EMBEDDER_MODEL` 可选，null 表示删除） |
| GET | `/api/admin/pi-status` | PI 宿主状态只读（`getPiStatus`，无 piContext 时降级） |
| GET | `/api/admin/rulesets` | 规则集三件套全量（`readAllRulesets`，需活跃项目） |
| PUT | `/api/admin/rulesets/:name` | 写规则集（body: `content`，`name` ∈ `RULESET_NAMES`，需活跃项目） |
| POST | `/api/admin/rulesets/:name/reset` | 重置规则集到模板（`resetRuleset`，需活跃项目） |
| GET | `/api/admin/doctor` | 环境自检（`runDoctor`，活跃项目可选） |
| GET | `/api/admin/version` | 本地/远程版本对比（`compareVersions`） |
| GET | `/api/admin/embedder/status` | 向量模型状态（`getEmbedderStatus`） |
| POST | `/api/admin/embedder/cache/clear` | 清向量缓存（`clearEmbedderCache`） |
| POST | `/api/admin/embedder/warmup` | 预热向量模型（`warmupEmbedder`，未注入 embedder 时 501 `EMBEDDER_UNAVAILABLE`） |
| GET | `/api/admin/novel-json` | 读 novel.json（`readNovelJson`，需活跃项目） |
| PUT | `/api/admin/novel-json` | 写 novel.json（body: novel.json 对象，需活跃项目） |
| GET | `/api/admin/app-config` | 读应用配置（`readAppConfig`，无需活跃项目） |
| PUT | `/api/admin/app-config` | 写应用配置（body: `extension?`/`launcher?`/`embedder?`，`writeAppConfig`） |
| PUT | `/api/admin/extension/mode` | 切换扩展模式（body: `mode` ∈ `enabled`/`disabled`） |
| GET | `/api/admin/extension/update-check` | 已安装版本 vs 快照版本（需 `extensionSnapshotDir`，缺省 400 `MISSING_FIELD`） |
| POST | `/api/admin/extension/reinstall` | 从快照重装全局扩展（body: `skipNpmInstall?`，需 `extensionSnapshotDir`；成功后更新配置版本与重装时间） |
| GET | `/api/admin/update/stream?targetDir=` | 一键更新 SSE 流（`runUpdate`，单任务守卫；targetDir 缺省取活跃项目扩展目录） |

> `/api/admin/update/stream` 是 SSE 端点（`text/event-stream`），与 `/api/debug/stream` 一样不进入常规 try/catch，响应头先写出（HTTP 200）。已有更新在跑时立即以 `error` 事件结束。

**扩展端点新增错误码**（叠加在 [visualizer.md §11.2.4](visualizer.md#1124-错误码) 之上）：

| HTTP | code | 触发场景 |
|------|------|----------|
| 400 | `INVALID_EXT` | 文件扩展名不在 `READABLE_EXTS`/`WRITABLE_EXTS` |
| 403 | `PATH_ESCAPE` | 文件路径穿越项目根 |
| 404 | `FILE_NOT_FOUND` / `NOT_A_FILE` / `DIR_NOT_FOUND` / `NOVEL_JSON_NOT_FOUND` / `WORLD_DB_NOT_FOUND` / `TEMPLATE_NOT_FOUND` | 各类资源不存在 |
| 409 | `FILE_EXISTS` / `MTIME_CONFLICT` / `UPDATE_RUNNING` / `NO_ACTIVE_PROJECT` / `MIGRATION_REQUIRED` / `PROJECT_OPEN` | 冲突与状态守卫 |
| 501 | `EMBEDDER_UNAVAILABLE` | `embedder/warmup` 未注入 embedder |

## 11.5.4 子包公开 API

应用化模式新增两个 workspace 子包，作为 unified-server 扩展端点的后端核心库（不含 HTTP 层，HTTP 薄路由在 `routes-ext.ts`）。两子包均为 `private: true`，不随 narrative-engine 扩展同步到 `.pi/extensions/`，是独立工具，仅供 unified-server 与 Tauri 应用消费。软隔离约定：无前缀=公共 API，`_` 前缀=内部实现。

**`@pi/admin`**（`packages/admin/`，应用级配置管理后端核心库）：

| 模块 | 公开 API |
|------|----------|
| env-store | `loadEnvFile` / `readEnvFile` / `writeEnvFile` / `EXTENSION_ENV_KEYS` |
| pi-status | `getPiStatus` / `assertPiReady` |
| rulesets | `readAllRulesets` / `readRuleset` / `writeRuleset` / `resetRuleset` / `RULESET_NAMES` |
| doctor | `runDoctor` / `formatDoctorReport` |
| updater | `runUpdate`（async generator 流式输出）/ `compareVersions` |
| embedder-status | `getEmbedderStatus` / `clearEmbedderCache` / `warmupEmbedder` / `assertModelValid` / `DEFAULT_EMBEDDER_MODEL` / `DEFAULT_EMBEDDER_DIM` |
| novel-json | `readNovelJson` / `writeNovelJson` |
| files | `listFileTree` / `readProjectFile` / `writeProjectFile` / `createProjectFile` / `deleteProjectFile` / `READABLE_EXTS` / `WRITABLE_EXTS` |
| app-config | `readAppConfig` / `writeAppConfig` / `getAppConfigPath` / `defaultGlobalExtPath` / `installExtension` / `reinstallExtension` / `checkExtensionUpdate` |
| types | `AdminError` / `PiStatusContext` / `EmbedderLike` / `AppConfigUpdates` 等 |

**`@pi/novel-launcher`**（`packages/novel-launcher/`，项目发现与跨平台启动 PI 后端核心库）：

| 分类 | 公开 API |
|------|----------|
| 项目发现 | `discoverProjects(root, opts?)` / `getProjectMeta(dir)` |
| 启动 PI | `launchPi(dir, options)`（新终端窗口，扩展加载策略由 `LaunchOptions.extensionMode` / `extensionPath` 控制） |
| 项目级操作 | `createProject(dir, opts?)`（库化，不再 spawn 子进程）/ `launchVisualizer` / `openInFileManager` |
| 错误类型 | `NovelLauncherError` |
