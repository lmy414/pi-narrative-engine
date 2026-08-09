# 变更记录

本文件记录 narrative-engine 的版本变更。版本号遵循 [Semantic Versioning](https://semver.org/)，
格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

### 架构（2026-08，pure-SDK 迁移）

- **pi 扩展入口移除**：31 个 `pi.registerTool` 工具、`src/index.ts` 扩展装配、ExtensionContext 适配链全部删除；
  运行时为独立 HTTP 服务（`src/app/main.ts` → `startUnifiedServer`）+ pi SDK 主会话（`MainSessionHost`）。
- **后端能力 HTTP 化**：`/api/scheduler/dispatch|commit|discard|status|mode`（编排控制）、
  `/api/chat/sessions(+/:id/messages)`（历史会话）、`/api/admin/llm*`（LLM 配置，apiKey 权威存储为
  AuthStorage auth.json，端点不返回明文）、`/api/files/rename`；scan 返回 `needsMigration` + `stats`。
- **调试总线接入**：main.ts 注入 DebugBus；编排四阶段（orchestrator/planner/role/reasoner/renderer）
  与 chat.message 的 span 埋点上线（`/api/debug/stream|events|clear`）。
- **应用配置扩展**：app-config 新增 `llm.slots`（slot→模型映射持久化）、`launcher.lastProjectDir`
  （启动恢复上次项目）、`scheduler.defaultMode`（plan/yolo 默认模式）；写入剥离扩展时代废弃键。
- **已知受阻**：世界图写接口补齐（声明闭合/实体删除/实体属性编辑）依赖 underworld-graph 包新增
  `closeDeclaration` / `deleteEntity` / `updateEntityProps`，该包未改，暂缓。

### 文档

- **结构 v3 记录 D12（git 管理规则与数据库方案）**：`docs/plans/2026-08-08-novel-project-structure-v3.md` §七（2026-08-09）——
  定案 git 管理规则（创作资产+世界图文本入库；world.db/sessions/logs/.mimosa 排除）；
  数据库困惑三方案（A 现状维持 / B 文本快照替代【推荐】/ C 事件重放远期）；
  查证事实：world.db 已被 git 跟踪、.mimosa/ 工具痕迹误入库、underworld-graph 无事件重放 API、
  _v3_dump.json 为导入基线快照。仅记录决策，未改代码与 gitignore。

- **记录提示词工程用户决策 D9 + 结构 v3 定案 D10/D11**（2026-08-09）：
  - `prompt-research.md` §九 D9——渲染规则集收回引擎自维护，**只保留文风规则给外部编辑**（回答 D8 待确认项①；文风→`规则集/文风规则.md`，格式/禁止→引擎内置）
  - `2026-08-08-novel-project-structure-v3.md` §七 D10/D11——结构 v3 核心定案：项目=文件夹、引擎识别**小说.json**定位；一章一个 .md（D1=A，事件锚点区分）；顶层小说.json+Reme.md；内容文件夹（笔记/草稿/设定/大纲，用户与代理可编辑）；规则集文件夹（文风规则.md/检查规则.md/自定义规则.md）；**规则集采用 Skill 渐进式披露机制加载到渲染器**
  - 决策点表 D1/D2/D4/D6 标记已定案；待确认项（小说.json 改名、Reme.md 拼写、检查/自定义规则归属、章节命名）记录在案。仅记录决策，未改代码与文件。

- **记录提示词工程用户决策 D8**：`docs/plans/2026-08-08-prompt-research.md` §九（2026-08-09）——
  角色规则集.md（角色扮演规则，46 行）整体收回引擎自维护，不再开放外部编辑；记录了注入链路
  （loadRoleRuleSet → role-pool buildSystemPrompt / orchestrator buildRoleSystemPrompt / role_rule_set 工具）、
  实施要点与待确认项（渲染规则集是否同样收回、文件去留）。仅记录决策，未改代码与规则集文件。

- **记录提示词工程首条用户决策（D7）**：`docs/plans/2026-08-08-prompt-research.md` §九（2026-08-09）——
  planner 规则集.md 的检索策略（5 条）/信息差原则/数量控制（3-8 条）不再提供编辑，作为引擎自维护内容
  （归引擎内置 `packages/scheduler/src/prompts.ts`）；记录了现状矛盾（规则集 3-8 vs 引擎内置 5-15）、
  实施要点与待确认项（property 词表归属、数量硬上限）。仅记录决策，未改代码与规则集文件。

- **新增提示词工程调研报告**：`docs/plans/2026-08-08-prompt-research.md`（2026-08-09）——问题 4 调研落地：
  三线素材（Claude Code 实测 system prompt / Anthropic 官方方法论 / AGENTS.md·Cursor 规范 / pi SDK·HanaAgent
  组装实现 / SillyTavern 酒馆角色卡·PHI 尾置·世界书·Regex，均按官方文档与源码核对）+
  现状盘点（主 agent 零定制；orchestrator 简化版 vs 子包成熟模板两代并存；**renderRuleSet 加载后未注入 renderer 缺口**）+
  五 agent 落地映射清单（R1-R5/P1-P3/RE1-RE3/RN1-RN5/M1-M3/X1-X5）与实施决策点；
  `docs/README.md` 活跃流程区同步登记。实施前待用户决策。

- **新增 Hanako 设计参考手册**：`docs/hanako-reference.md`（2026-08-09）——研读 `D:\claude\openhanako`
  （HanaAgent v0.442，Apache-2.0）后整理的借鉴地图：22 个模式条目均标注上游出处文件路径、
  何时使用与移植要点，含美学惯例、不借鉴清单与移植纪律；`docs/README.md` 现行文档区同步登记。
  后续设计需求优先按图索骥借鉴/移植 openhanako 实现。

- `docs/api/unified-server.md` 按 pure-SDK 实际端点重写；`docs/api/README.md` 的 pi-tools 区块标注为历史文档；
  `docs/frontend-requirements.md` 缺口清单 B1~B8 状态同步（B5 受阻）。

- **API 文档拆分**：`docs/api.md`（2000+ 行）拆分为 `docs/api/` 18 个小文档（按工具域 / 子包 / HTTP 服务 / 调试模块），
  `docs/README.md` 文档地图与根 README 引用同步更新；构建脚本 `references/` 改复制整个 `api/` 目录（`SKILL.md` 路径同步）。
- **全量核对现行文档与源码**：修正角色卡可见性 `source`（实为 `experienced` 非 `self`）、子包软隔离导出面
  （novel-importer/renderer/role-pool/scheduler 公共 API 收敛）、`locationId` 删除（M4a）、
  环境变量速查（主会话 LLM 已走 PI 本体配置，`PI_*_MODEL`/`PI_*_API_KEY` 不再消费）等过时内容。

### 结构 v3 实施（2026-08-10，D10/D11/D12 + D7/D8/D9 联动）

- **项目清单改名小说.json + 兼容旧名**：admin/novel-launcher 双名读取（主名优先、旧名回退、写统一写主名）；
  模板/脚手架/doctor/registry/路由文案同步；单测覆盖主名/回退/迁移语义（bcd7d22）。
- **chaptersDir 真实消费**：resolveChapterPath 缺省路径改章节级（`<chaptersDir>/第N章-未命名.md`），
  消灭旧事件级 `chapters/<storyTime>.md` 双轨；chapter-resolver 加 chaptersDir 参数与 `..` 段逃逸拒绝（c4511a6）。
- **规则集收回引擎自维护**：D7 planner 检索策略/信息差/数量控制（统一 3-8 条）固化进 buildPlannerSystemPrompt（be7c779）；
  D8 角色扮演原则/输出纪律/词表固化进 role-pool BUILTIN_ROLE_RULES（orchestrator 子代理与 role_interact 共享，
  role_rule_set 改返回内置规则）（117ca70）；D9 渲染拆分——`规则集/文风规则.md`（外部）+ `检查规则.md`（checker），
  格式/禁止/输出契约固化进 RENDERER_SYSTEM_PROMPT，loader 拆 loadStyleRuleSet/loadCheckRuleSet（旧 规则集.md 兼容回退），
  admin rulesets 映射改 style/check/custom（be8af39）。
- **规则渐进披露（D11）+ RN1 修复**：渲染器子代理 prompt 注入 `<available_rules>` 清单（名称+位置+简介，不注入全文），
  新增 rules_read 工具按需读取（枚举参数 + 根目录边界校验）；renderRuleSet 字段废弃兼容（5246e01）。
- **脚手架 v3 完整化**：createProject 建 正文/规则集/笔记/草稿/设定/大纲/.pi 目录骨架 + 小说.json/规则集三件模板；
  _gitignore 补 db/sessions/logs/.mimosa；init-novel CLI 对齐并移除 extensions 同步；doctor 结构检查更新（b8cd7a5）。
- **世界状态导出命令（D12 方案 B）**：`scripts/export-world-state.mjs` 导出实体/关系/声明 JSON 快照
  （.pi/world-graph-v3/world-state.json 入库存档点；novel 实测 15/28/73）（bc7a96b）。
- **novel/ 收敛迁移（novel 仓库 47e2ca0）**：ch012 事件文件合并回 第12章-未命名.md（4 锚点按序）；
  小说.json 改名；规则集迁入文件夹（文风规则.md 承接定制文风 + 参考示例）；新建区域目录；
  world.db 与 .mimosa 出库、world-state.json 入库、.gitignore 更新；旧 planner/角色规则集删除。
- **前端适配 + 测试轮**：设置规则集 tab 改文风/检查/自定义、新建文件默认路径消费 chaptersDir、
  novel.json 文案改小说.json、mock 固件同步 v3；测试轮 8/8 通过（f227d7d，文档
  `docs/audits/frontend-test-runs/2026-08-10-structure-v3-frontend.md`）。
- **结构文档 v3 重写**：`docs/novel-project-structure.md` v3（粒度模型/规则集渐进披露/git 管理/兼容矩阵）；
  api 子文档（renderer/role-pool/scheduler/unified-server）同步；计划文档状态标记实施完成。

### 修复

- **LLM 调用链补全**（2026-07-31）：`makeRendererLlmCaller` / `makePlannerLlmCaller` 补完 2026-07-29 未完成的迁移
  ——签名从 `(model, apiKey, provider)` 改为 `(ctx: ExtensionContext)`，与 role-pool / knowledge-mapper 一致。
  此前 `scheduler-llm.ts` 以 `ctx` 调用两工厂（`scheduler_dispatch` / `render_*` 工具运行时必崩），
  现从 PI 本体 `ctx.model` + `ctx.modelRegistry` 取模型与 API Key。

### 修复（08-04 ~ 08-05）

#### 08-04 批次 1（编排骨架 + 同源安全）

- **G1-1：queueStatus 瘦身**：queueStatus 响应精简为 active 队列 + 简洁结构。
- **G1-2：activeCount 字段**：queueStatus 新增 activeCount 字段。
- **G1-3：planDetail 竞态容错**：planDetail 改用 Promise.allSettled 实现竞态容错。
- **G1-7：isStreaming 兜底 busy**：GET /api/chat/status 轮询时以 isStreaming 兜底 busy 状态。
- **同源安全加固**：恶意 Origin 请求返回 403 ORIGIN_REJECTED。

#### 08-04 批次 2（编排可见性）

- **G1-4：demo 残留清理**：清理 demo 残留代码。
- **G1-5：yolo 结果卡片**：yolo 模式结果以卡片形式展示。
- **G1-6：队列错误可见化**：队列错误信息可见化。
- **M-Collab-2：message_end 错误标红**：message_end 含错误语义时 live 消息标红。

#### 08-04 批次 3（前端可用性）

- **BUG-010 修复**。
- **M-Logic-5/7、M-Collab-5、M-Sec-2 audit 同步**。

#### 08-04 批次 4

- **BUG-011/012/013/015 前端 BUG 修复**。
- **BUG-014 commit 异步化**：入队即返回 CommitEnqueueResult + plan 状态机
  （confirmed→committing→committed/error）+ 状态保护
  （COMMIT_IN_PROGRESS 409 / PLAN_ALREADY_COMMITTED 410）。

#### 08-05

- **BUG-016：实体详情事件 tab 永远"暂无"**：后端 GET /api/entities/:id/history 补关联查询拼 events 字段
  （world-graph getEntityHistory 不返回 events）；前端 entity-detail.js 新增 summarizeEvent()
  从 newFacts/invalidated 兜底生成摘要；api-client.js normalizeHistory 兜底 events 数组。
- **BUG-017：聊天空气泡**：studio.js 新增 stBubbleContentHtml() 当 m.text 为空但有 toolCalls 时
  渲染占位"（调用了工具，无文本回复）"；views.css 加 .st-bubble-empty 斜体灰字样式。

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
