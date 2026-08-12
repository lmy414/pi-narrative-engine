# 统一服务（Unified Server）与应用化子包

> 属于 [API 文档索引](README.md)。应用化模式的核心：单一 HTTP 服务整合 world-graph 路由、文件操作、项目管理、应用配置、主会话聊天、编排控制与调试总线。源码位于 `src/app/`，由 `unified-server.ts` 的 `startUnifiedServer` 启动。world-graph 基础路由见 [visualizer.md](visualizer.md)；聊天 SSE 契约见 [chat.md](chat.md)。
>
> 本文已与 pure-SDK 架构（2026-08 迁移）对齐：pi 扩展入口、`/api/admin/extension/*`、`/api/admin/update/stream`、`/api/projects/launch-pi` 均已移除。

## 设计要点

- **单端口**：默认 7421（`--port` 可改，传 0 由系统分配），仅监听 `127.0.0.1`（端点不做鉴权）
- **路由优先级**：`/api/files|projects|admin`（`handleExtApi`）→ `/api/chat|scheduler`（需装配 ChatContext，否则 503 `CHAT_UNAVAILABLE`）→ world-graph 路由（`handleApi`，需活跃项目）→ 静态服务
- **活跃项目依赖**：world-graph 路由 + 大部分 `/api/files` / `/api/admin` / `/api/chat` / `/api/scheduler` 端点从 `registry.getActive()` 取上下文，未激活时返回 409 `NO_ACTIVE_PROJECT`；`/api/projects/*` 与 `/api/admin/{app-config,doctor,version,pi-status,llm,embedder/status}` 不受此限
- **响应 envelope**：`{ ok, data, error: { code, message } }`；JSON 解析失败 400 `INVALID_JSON`；未捕获异常兜底 500 `INTERNAL_ERROR`
- **静态服务**：`serveStatic` + `resolveDefaultUiDir`，`uiDir` 缺省自动探测 frontend-demo
- **world-graph 写端点**（[visualizer.md](visualizer.md) 详表）：除 `POST /api/events` 原语外，另有三个事件溯源便捷端点——`POST /api/entities/:id/props`（属性编辑：change 事件闭合旧声明+写新值，事件 ID 后端生成）、`POST /api/declarations/close`（闭合声明，404/409 预检）、`POST /api/entities/:id/kill`（实体退场：death 事件双时态闭合，语义"删除"，无物理删除）

## 启动入口（`src/app/main.ts`）

```
node scripts/app-server.mjs [--project <dir>] [--port 7421] [--embed] [--config-dir <dir>]
```

- `--project`：启动即激活的项目（优先级高于 app-config 的 `launcher.lastProjectDir`）
- `--embed`：加载向量模型（hybrid 检索 + 主会话/编排可用；缺省 fulltext 降级）
- `--config-dir`：应用配置目录（缺省平台目录，win32 为 `%APPDATA%/narrative-engine`）；`agentDir = <configDir>/pi-agent`
- 启动时：读 app-config 水合 LLM slot 映射与 `scheduler.defaultMode`；恢复 `launcher.lastProjectDir`（目录被删/损坏只警告不阻断）；创建 DebugBus 并注入

## `/api/files/*`（文件编辑器后端，需活跃项目）

| Method | Path | 简述 |
|---|---|---|
| GET | `/api/files/tree` | 项目文件树（.md/.txt/.json + 特判 .env；跳过隐藏目录与 node_modules） |
| GET | `/api/files/read?path=` | 读文件（path 必填） |
| PUT | `/api/files/write` | 写文件（body: `path`/`content`/`baseMtime?`，`MTIME_CONFLICT` 409） |
| POST | `/api/files/create` | 新建文件（body: `path`，201） |
| POST | `/api/files/delete` | 删除文件（body: `path`） |
| POST | `/api/files/rename` | 重命名/移动（body: `path`/`newPath`，只许 .md，目标已存在 409 `FILE_EXISTS`） |

## `/api/projects/*`（项目管理，不需活跃项目）

| Method | Path | 简述 |
|---|---|---|
| GET | `/api/projects/scan?root=&maxDepth=` | 扫描含 `novel.json` 的项目；每项含 `needsMigration` 与 `stats: {entityCount, eventCount} \| null`（world.db 探测，db 不可用/需迁移时 stats=null） |
| GET | `/api/projects/meta?dir=` | 项目元数据 |
| GET | `/api/projects/active` | 当前活跃项目 + 已打开列表 |
| POST | `/api/projects/activate` | 激活项目（body: `dir`，`allowInit=true`；成功后写 `launcher.lastProjectDir`） |
| POST | `/api/projects/migrate` | 迁移 schema（body: `dir`，先备份再 `WorldGraph.migrate`） |
| POST | `/api/projects/create` | 新建项目（body: `dir`/`name?`/`force?`，201） |
| POST | `/api/projects/open-folder` | 文件管理器打开（body: `dir`） |
| POST | `/api/projects/close` | 关闭项目（body: `dir`；关闭的是活跃项目时清 `lastProjectDir`） |

## `/api/admin/*`（配置管理）

| Method | Path | 简述 |
|---|---|---|
| GET/PUT | `/api/admin/config` | 项目级 `.env`（HF_ENDPOINT / PI_DEBUG / PI_EMBEDDER_MODEL；需活跃项目） |
| GET | `/api/admin/pi-status` | LLM 状态只读 `{model, hasKey, piVersion: null, warnings}`（AuthStorage + LlmConfigStore） |
| GET | `/api/admin/llm` | 5 个 slot 的 `{configured, resolved, source: slot/default/env/none, hasKey}`（不含 key 明文） |
| PUT | `/api/admin/llm/slot` | 设置 slot 模型（body: `slot`/`provider`/`model`，模型不存在 400 `INVALID_MODEL`；持久化 app-config + 即时生效） |
| DELETE | `/api/admin/llm/slot/:slot` | 清除 slot 配置（持久化 + store 同步） |
| PUT | `/api/admin/llm/key` | 写 API Key 到 auth.json（body: `provider`/`apiKey`；响应只回 hasKey） |
| DELETE | `/api/admin/llm/key/:provider` | 移除 provider 凭据 |
| GET | `/api/admin/llm/providers` | 厂商合并视图：内置（只读）+ 自定义（附 `baseURL`/`fetchModels`/`hasKey`） |
| PUT | `/api/admin/llm/providers` | 自定义厂商 upsert（body: `provider`/`apiKey?`，按 id 合并） |
| PUT | `/api/admin/llm/providers/:id/models` | 设置厂商模型列表（body: `modelIds`） |
| DELETE | `/api/admin/llm/providers/:id` | 删除自定义厂商并清理其密钥 |
| POST | `/api/admin/llm/providers/:id/test` | 测试连通（强制打 `{baseURL}/models`；业务字段表达成败，HTTP 200） |
| GET | `/api/admin/llm/providers/models?id=` | 枚举某厂商模型（内置只读；自定义走解析） |
| GET/PUT | `/api/admin/rulesets[/:name]` | 规则集读写（v3：`style`=规则集/文风规则.md、`check`=检查规则.md、`custom`=自定义规则.md）；`POST /api/admin/rulesets/:name/reset` 重置（需活跃项目） |
| GET | `/api/admin/doctor` | 环境自检（Node/原生绑定/templates/向量缓存/项目结构） |
| GET | `/api/admin/version` | 本地/远程版本对比 |
| GET | `/api/admin/embedder/status`、`POST /api/admin/embedder/cache/clear`、`POST /api/admin/embedder/warmup` | 向量模型状态/清缓存/预热 |
| GET/PUT | `/api/admin/novel-json` | 项目清单读写（v3 主名 小说.json，旧版 novel.json 兼容回退；需活跃项目） |
| GET/PUT | `/api/admin/app-config` | 应用配置读写（`launcher`/`embedder`/`llm`/`scheduler` 已知键；写入剥离废弃键） |

app-config.json 结构（`<configDir>/app-config.json`）：

```json
{
  "launcher": { "defaultScanRoots": [], "lastProjectDir": null },
  "embedder": { "model": "Xenova/bge-small-zh-v1.5" },
  "llm": { "slots": { "default": { "provider": "deepseek", "model": "deepseek-v4-flash" } } },
  "scheduler": { "defaultMode": "plan" }
}
```

> API Key 的唯一权威存储是 pi SDK AuthStorage（`<configDir>/pi-agent/auth.json`），任何端点都不返回 key 明文。

## `/api/chat/*`（主会话，需活跃项目；详见 [chat.md](chat.md)）

| Method | Path | 简述 |
|---|---|---|
| POST | `/api/chat/message` `{text}` | 发消息（单流约束，忙碌 409 `CHAT_BUSY`） |
| GET | `/api/chat/events` | SSE 事件流（AI 回复、工具调用全程） |
| GET | `/api/chat/status` | 会话状态（只读，不触发启动）`{active, cwd, isStreaming, systemPrompt, sessionId, modelFallbackMessage}` |
| GET | `/api/chat/sessions` | 历史会话列表 `{id, name, created, modified, messageCount, firstMessage, live}`（SDK SessionManager，`<项目>/.pi/sessions/`；`live` 标记主会话当前写入的会话） |
| POST | `/api/chat/sessions` | 新建空会话（`live` 转移到新会话；旧会话后台生成继续） |
| GET | `/api/chat/sessions/:id/messages` | 会话历史消息 `{id: string, messages: HistoricalChatMessage[]}`（非裸数组）；`HistoricalChatMessage` 字段：`role` / `text` / `ts` / `toolCalls?` / `provider?` / `model?` / `usage?`；纯工具调用消息 `text` 为空字符串；未知 id 404 `SESSION_NOT_FOUND` |
| POST | `/api/chat/sessions/:id/activate` | 切换到指定会话（`live` 标记转移；id 支持唯一前缀；需活跃项目） |
| POST | `/api/chat/abort` | 中断会话生成（body 可带 `sessionId` 指定后台会话，缺省活跃会话） |

## `/api/scheduler/*`（编排控制，需活跃项目）

与主会话 `scheduler_*` 工具同一 `OrchestratorService` 实例、同一 EventQueue，语义完全一致。

| Method | Path | 简述 |
|---|---|---|
| POST | `/api/scheduler/dispatch` | 派发事件（body 同 `scheduler_dispatch` 工具参数 `{storyTime, instruction, characterIds, executionHints?, mode?, chapterPath?}`；mode 缺省用 `scheduler.defaultMode`；返回 `{queueId, mode}`，planId 经 status 轮询获取） |
| POST | `/api/scheduler/commit` `{planId}` | **异步**入队 commit（写世界图+渲染章节）；返回 `CommitEnqueueResult { ok: true, planId, queueId, status: "committing" }`；plan 不存在 404 `PLAN_NOT_FOUND`，plan 正在提交中 409 `COMMIT_IN_PROGRESS`，plan 已提交完成 410 `PLAN_ALREADY_COMMITTED`。commit 入队即返回，章节生成结果通过轮询 `GET /api/scheduler/plans/:id` 的 `status` 字段获取（状态流转 `confirmed → committing → committed | error`） |
| POST | `/api/scheduler/discard` `{planId}` | 丢弃 plan；plan 不存在 404 `PLAN_NOT_FOUND`；committing 中的 plan 禁止 discard 409 `COMMIT_IN_PROGRESS` |
| GET | `/api/scheduler/plans/:id` | 单个 plan 详情（含 `planId` / `storyTime` / `mode` / `characterIds` / `outputCount` / `errorCount` / `status` / `commitQueueId?` / `commitError?`）；plan 不存在 404 `PLAN_NOT_FOUND` |
| GET | `/api/scheduler/status` | `{queue: {length, active, items[]}, plans: [{planId, storyTime, mode, characterIds, outputCount, errorCount, status, commitQueueId?, commitError?}], defaultMode}`；`plans[].status` 取值 `confirmed` / `committing` / `committed` / `error` |
| PUT | `/api/scheduler/mode` `{mode}` | 设置会话级默认执行模式（plan\|yolo；持久化 app-config + 即时生效） |

## `/api/debug/*`（调试总线）

| Method | Path | 简述 |
|---|---|---|
| GET | `/api/debug/stream` | SSE 实时事件流（先历史快照后实时推送） |
| GET | `/api/debug/events` | 环形缓冲事件查询（默认容量 1000） |
| POST | `/api/debug/clear` | 清空缓冲 |

埋点（`src/orchestrator.ts` / `src/app/routes-chat.ts`，无 bus 时零开销 no-op）：
`orchestrator`（root）→ 子 span `planner` / `role` / `reasoner` / `renderer`（yolo 或 commit 时含后两者），plan 模式 commit 自成 `orchestrator.commit` trace；`chat.message`（接收→preflight）。
载荷：各 span end 携带 `provider/model/durationMs`；reasoner 带世界图变更摘要（`changes`/`visibilityChanges`/`changeList`），renderer 带章节信息（`chapterPath`/`chars`/`title`），commit 带 `appliedEventIds`。

## 错误码（扩展/chat/scheduler 端点，叠加在 [visualizer.md](visualizer.md) 之上）

| HTTP | code | 触发场景 |
|------|------|----------|
| 400 | `MISSING_FIELD` / `INVALID_BODY` / `INVALID_EXT` / `INVALID_SLOT` / `INVALID_MODEL` / `INVALID_STORY_TIME` / `INVALID_JSON` | 参数校验 |
| 403 | `PATH_ESCAPE` | 文件路径穿越项目根 |
| 404 | `FILE_NOT_FOUND` / `NOT_A_FILE` / `DIR_NOT_FOUND` / `NOVEL_JSON_NOT_FOUND` / `WORLD_DB_NOT_FOUND` / `TEMPLATE_NOT_FOUND` / `PLAN_NOT_FOUND` / `SESSION_NOT_FOUND` / `ENTITY_NOT_FOUND` / `DECLARATION_NOT_FOUND` / `NOT_FOUND` | 资源不存在 |
| 409 | `FILE_EXISTS` / `MTIME_CONFLICT` / `NO_ACTIVE_PROJECT` / `MIGRATION_REQUIRED` / `PROJECT_OPEN` / `CHAT_BUSY` / `COMMIT_FAILED` / `COMMIT_IN_PROGRESS` / `DECLARATION_CLOSED` | 冲突与状态守卫 |
| 410 | `PLAN_ALREADY_COMMITTED` | plan 已提交完成，禁止重复 commit |
| 501 | `EMBEDDER_UNAVAILABLE` | embedder 未加载 |
| 503 | `CHAT_UNAVAILABLE` / `LLM_UNAVAILABLE` / `DEBUG_UNAVAILABLE` | 依赖未装配 |

## `ProjectRegistry` 多项目句柄隔离

`src/app/project-registry.ts` 按目录缓存项目句柄（`ProjectHandle`：`dir` / `meta` / `wg` / `search` / `forceFulltext`），同时只有一个活跃项目。主要方法：`openProject(dir, {allowInit?})` / `setActive` / `migrateProject`（先备份）/ `getActive` / `listOpen` / `closeProject` / `closeAll`。共享 embedder 注入；未注入时所有项目 `forceFulltext = true`。

## 子包公开 API

**`@pi/admin`**（`packages/admin/`，应用级配置管理核心库，软隔离：`_` 前缀=内部）：

| 模块 | 公开 API |
|------|----------|
| env-store | `readEnvFile` / `writeEnvFile` / `EXTENSION_ENV_KEYS` |
| pi-status | `getPiStatus`（deps: `{authStorage, resolveModel}`） |
| rulesets | `readAllRulesets` / `readRuleset` / `writeRuleset` / `resetRuleset` / `RULESET_NAMES` |
| doctor | `runDoctor` / `formatDoctorReport` |
| updater | `compareVersions`（版本对比；一键更新链已移除） |
| embedder-status | `getEmbedderStatus` / `clearEmbedderCache` / `warmupEmbedder` / `assertModelValid` |
| novel-json | `readNovelJson` / `writeNovelJson` |
| files | `listFileTree` / `readProjectFile` / `writeProjectFile` / `createProjectFile` / `deleteProjectFile` / `renameProjectFile` |
| app-config | `readAppConfig` / `writeAppConfig` / `getAppConfigPath` / `LLM_SLOT_NAMES` |

**`@pi/novel-launcher`**（`packages/novel-launcher/`）：

| 分类 | 公开 API |
|------|----------|
| 项目发现 | `discoverProjects(root, opts?)`（`includeStats` 默认 true，附 needsMigration/stats）/ `getProjectMeta(dir)` |
| world.db 探测 | `probeWorldDb(projectDir, meta)` |
| 项目级操作 | `createProject(dir, opts?)` / `openInFileManager(dir)` |
| 错误类型 | `NovelLauncherError` |
