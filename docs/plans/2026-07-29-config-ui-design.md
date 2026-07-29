# narrative-engine 配置前端页面设计

> 日期：2026-07-29
> 目标：为扩展增加一个配置前端页面，大幅降低上手难度、提升可用性。
> 范围：仅设计文档，不含代码实现。
> 核心原则：**LLM 配置全部复用 PI 本体，扩展只管扩展专属配置**。

---

## 一、背景与目标

narrative-engine 当前所有配置散落在环境变量、硬编码常量、模板文件、CLI 脚本四处。更严重的是，扩展自己发明了一套 LLM 配置环境变量（`PI_API_KEY` / `PI_MODEL` / `PI_*_MODEL` / `PI_*_API_KEY`），与 PI 本体的配置体系（`settings.json` / `auth.json` / `DEEPSEEK_API_KEY`）**并行重复**，导致用户要配两遍。

本设计目标：

1. **LLM 配置全部复用 PI**：扩展不再自己读 API Key / 模型名，改用 `ctx.model` + `ctx.modelRegistry`。删除 `llm-config.ts` 与 `PI_*_API_KEY` / `PI_MODEL` 等扩展自定义环境变量。
2. **扩展专属配置集中到前端页面**：HF 镜像、debug 开关、向量模型、规则集三件套、可视化端口等只有扩展关心的配置。
3. **把 CLI 脚本包装成一键操作**：检查依赖、更新扩展、初始化项目。
4. **不破坏现有架构**：纯静态前端 + 同源 HTTP 端点，沿用 visualizer-ui 既有模式（Vue 3 + Element Plus + 零构建 + 本地 vendor）。

---

## 二、PI 本体已管理的配置（扩展不得重复实现）

### 2.1 PI 的配置体系

PI 本体有完整的配置管理链，扩展不应重复造轮子：

| 配置类型 | PI 管理方式 | 扩展应做的 |
|---|---|---|
| **LLM API Key** | `auth.json`（OAuth 登录存储）+ 环境变量（`DEEPSEEK_API_KEY` 等 25+ provider 映射，[env-api-keys.ts](file:///d:/claude/pi-ex/pi-ex/packages/ai/src/env-api-keys.ts) 行 91-134）+ `pi login` 命令 | **不自己读**，通过 `ctx.modelRegistry.getApiKeyAndHeaders(ctx.model)` 获取 |
| **LLM 模型 / provider** | `settings.json` 的 `defaultProvider` + `defaultModel`（[settings-manager.ts](file:///d:/claude/pi-ex/pi-ex/packages/coding-agent/src/core/settings-manager.ts) 行 77-81）+ `pi config` / `--model` / `/model` 命令 | **不自己配**，通过 `ctx.model` 读取 PI 当前模型 |
| **扩展/skills/prompts/themes 路径** | `settings.json` 的 `extensions`/`skills`/`prompts`/`themes` 字段 + `pi config` TUI + 自动发现目录 | **不改 PI 路径**，通过 `resources_discover` 事件动态贡献 |
| **包管理** | `pi install/remove/update/list` 命令 | **不自己实现包管理**，narrative-engine 是源码同步模式，更新走自实现的 sync 流程 |
| **主题 / locale** | `settings.json` 的 `theme` 字段 | **不管主题**，visualizer-ui 自己的暗色主题独立 |
| **auth.json** | `getAuthPath()` → `~/.pi/agent/auth.json`（[config.ts](file:///d:/claude/pi-ex/pi-ex/packages/coding-agent/src/config.ts) 行 503-506） | **不读不写** |

### 2.2 PI 的 API Key 解析链（扩展无需关心）

PI 的 `ModelRegistry.getApiKeyAndHeaders(model)` 按以下顺序解析 key（[auth-storage.ts](file:///d:/claude/pi-ex/pi-ex/packages/coding-agent/src/core/auth-storage.ts) 行 452-522）：

1. Runtime override（CLI `--api-key`）
2. `auth.json` 中的 API key
3. `auth.json` 中的 OAuth token（自动刷新）
4. **环境变量**（`DEEPSEEK_API_KEY` 等，[env-api-keys.ts](file:///d:/claude/pi-ex/pi-ex/packages/ai/src/env-api-keys.ts) 的固定映射）
5. Fallback resolver（`models.json` 自定义 provider）

**关键**：只要用户设了 `DEEPSEEK_API_KEY` 环境变量或 `pi login`，扩展调 `ctx.modelRegistry.getApiKeyAndHeaders(ctx.model)` 就能自动拿到 key，**扩展完全不需要关心 key 从哪来**。

### 2.3 PI 不提供的能力（扩展需自己实现）

- **扩展专属配置存储**：PI 不提供"扩展配置文件"机制，扩展自己持久化（`.env` 或自定义文件）
- **扩展设置 UI**：PI 只有 `pi config` TUI（仅启用/禁用资源），扩展设置页完全自己实现
- **扩展自更新**：narrative-engine 不走 `pi install` 通道（源码同步模式），`pi update` 对它无效，需自实现
- **扩展依赖检查**：PI 不检查扩展的 native 绑定，需自实现 doctor

---

## 三、扩展 LLM 调用链改造（前置必做）

> 这是"全部复用 PI 配置"的核心改造，必须在配置页之前完成。

### 3.1 当前问题

narrative-engine 的 5 个 LLM caller 都直接 `import { getModel, complete } from "@earendil-works/pi-ai"`，自己从 `process.env` 读 key：

```
src/llm-config.ts          ← 自己读 PI_*_API_KEY / DEEPSEEK_API_KEY / PI_MODEL（要删除）
src/planner-llm.ts         ← makePlannerLlmCaller(model, apiKey, provider)
src/renderer-llm.ts        ← makeRendererLlmCaller(model, apiKey, provider)
src/role-pool-llm.ts       ← makeRoleLlmCaller(model, apiKey, provider)
src/knowledge-mapper-llm.ts ← makeKnowledgeMapperLlmCaller(model, apiKey, provider)
src/scheduler-llm.ts       ← makeSchedulerCtx() 装配 4 路 caller
```

**关键问题**：`scheduler-tools.ts` 的 `execute(_id, params)` 只接收 2 个参数，**没有接收第 5 个 `ctx: ExtensionContext` 参数**（PI 的 ToolDefinition execute 签名是 `(id, params, signal, onUpdate, ctx) => ...`，[types.ts](file:///d:/claude/pi-ex/pi-ex/packages/coding-agent/src/core/extensions/types.ts) 行 455-461）。

### 3.2 改造方案：全部用 ctx.model

4 个官方扩展示例（[summarize.ts](file:///d:/claude/pi-ex/pi-ex/packages/coding-agent/examples/extensions/summarize.ts) / [custom-compaction.ts](file:///d:/claude/pi-ex/pi-ex/packages/coding-agent/examples/extensions/custom-compaction.ts) / [handoff.ts](file:///d:/claude/pi-ex/pi-ex/packages/coding-agent/examples/extensions/handoff.ts) / [qna.ts](file:///d:/claude/pi-ex/pi-ex/packages/coding-agent/examples/extensions/qna.ts)）都用同一模式：

```typescript
// 标准模式（PI 推荐用法）
const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
if (!auth.ok || !auth.apiKey) {
  throw new Error(auth.ok ? `No API key for ${ctx.model.provider}` : auth.error);
}
const response = await complete(
  ctx.model,
  { systemPrompt, messages: [...] },
  { apiKey: auth.apiKey, headers: auth.headers, temperature: 0.3, maxTokens: 2000 },
);
```

### 3.3 具体改造步骤

1. **删除 `src/llm-config.ts`** —— 不再需要从 `process.env` 读 key/model

2. **5 个 caller 工厂签名改为接收 `ctx: ExtensionContext`**：

   ```typescript
   // 改造前
   export function makePlannerLlmCaller(model: string, apiKey: string, provider?: string): PlannerLlmCaller

   // 改造后
   export function makePlannerLlmCaller(ctx: ExtensionContext): PlannerLlmCaller
   ```

   caller 内部改为：
   ```typescript
   const model = ctx.model;
   if (!model) throw new Error("No model available");
   const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
   if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? `No API key` : auth.error);
   const msg = await complete(model, {...}, { apiKey: auth.apiKey, headers: auth.headers, temperature: 0.3, maxTokens: 2000 });
   ```

3. **`src/scheduler-llm.ts` 的 `makeSchedulerCtx` 签名改为接收 `ctx`**：

   ```typescript
   // 改造前
   export async function makeSchedulerCtx(wg, emb, cwd, debugBus?): Promise<SchedulerCtx>

   // 改造后
   export async function makeSchedulerCtx(wg, emb, cwd, ctx, debugBus?): Promise<SchedulerCtx>
   ```

4. **`src/tools/scheduler-tools.ts` 的 execute 接收第 5 个参数 ctx**：

   ```typescript
   // 改造前
   async execute(_id, params) {

   // 改造后
   async execute(_id, params, _signal, _onUpdate, ctx) {
     const schedCtx = await makeSchedulerCtx(g, emb, cwd, ctx, state.debugBus ?? undefined);
   ```

   **注意**：所有调用 `makeSchedulerCtx` 的工具（scheduler_dispatch / render_chapter / role_action 等）的 execute 都要改签名。

5. **其他工具的 execute 也需检查**：`render-tools.ts` / `role-tools.ts` / `import-tools.ts` 等如果调 LLM，也要同样改造。

6. **删除环境变量**：`PI_API_KEY` / `PI_*_API_KEY` / `PI_MODEL` / `PI_*_MODEL` / `DEEPSEEK_API_KEY` 的读取全部删除。用户只需配 PI 本体的 `DEEPSEEK_API_KEY` 环境变量或 `pi login`。

7. **保留 temperature / maxTokens 硬编码**：这些是扩展的业务参数（planner 0.3 / role 0.7 / renderer 0.7 / mapper 0.2），PI 不管，扩展自己管。

### 3.4 改造后的收益

- 用户只需配 PI 一处（`DEEPSEEK_API_KEY` 或 `pi login`），三路 LLM 全部可用
- 扩展自动跟随 PI 的 `/model` 切换，用户在 PI 里切模型，扩展立即用新模型
- 扩展自动支持 PI 的所有 provider（deepseek / openai / anthropic / google 等），不再硬编码 `deepseek`
- 扩展自动支持 PI 的 OAuth 登录（`pi login`）

---

## 四、扩展专属配置项（前端可配）

### 4.1 配置项全表

| 配置项 | 类型 | 默认值 | 当前配置方式 | 前端化 |
|---|---|---|---|---|
| ~~LLM API Key~~ | ~~string~~ | ~~无~~ | ~~PI 本体管~~ | ❌ 删除，复用 PI |
| ~~LLM 模型~~ | ~~string~~ | ~~deepseek-v4-flash~~ | ~~PI 本体管~~ | ❌ 删除，用 ctx.model |
| HF_ENDPOINT 镜像 | string | huggingface.co | `HF_ENDPOINT` 环境变量 | ✅ 写 .env |
| PI_DEBUG 开关 | `"off"`/启用 | 启用 | `PI_DEBUG=off` | ✅ 写 .env |
| 向量模型 | string | `Xenova/bge-small-zh-v1.5` | **硬编码** (`src/embedder.ts:32`) | ✅ 改造后写 .env |
| 向量维度 | number | 512 | 硬编码（测试钉死） | ❌ 不做 |
| 调试缓冲容量 | number | 2000 | 硬编码 (`src/index.ts:100`) | ❌ 不做（P2） |
| 可视化端口 | number | 7421 | 工具参数 / CLI `--port` | ✅ 启动时传 |
| worldGraphDir | path | `<cwd>/.pi/world-graph-v3` | 硬编码 | ❌ 不做 |
| memory 最近事件组数 | number | 10 | 硬编码 | ❌ 不做（P2） |
| 渲染规则集 | text | `规则集.md` | 文件编辑 | ✅ 前端编辑器 |
| planner 规则集 | text | `planner 规则集.md` | 文件编辑 | ✅ 前端编辑器 |
| 角色规则集 | text | `角色规则集.md` | 文件编辑 | ✅ 前端编辑器 |
| novel.json | json | 模板 | 文件编辑 | ✅ 前端 form |

### 4.2 分级

#### P0 — 必做

| 配置项 | UI 形式 | 落盘 | 生效 |
|---|---|---|---|
| 一键检查依赖（doctor） | 按钮 + 结果卡片 | — | 即时 |
| 一键更新扩展（git pull + build + sync） | 按钮 + SSE 日志 | — | 完成后提示 `/reload` |
| 当前配置总览（含 PI 配置只读展示） | 卡片 | — | 即时 |
| HF_ENDPOINT 镜像 | select | `<小说工程>/.env` | 重启 pi 会话 |
| PI_DEBUG 开关 | switch | `<小说工程>/.env` | 重启 pi 会话 |

#### P1 — 应做

| 配置项 | UI 形式 | 落盘 | 生效 |
|---|---|---|---|
| 规则集三件套编辑器 | tab + textarea + 保存 | `<小说工程>/*.md` | 即时（运行时每次调用重读） |
| 向量模型选择 | select + 自定义 | `<小说工程>/.env` | 重启 pi 会话 |
| 向量模型缓存清理 | 按钮 | 删缓存目录 | 即时 |
| 可视化端口 | input + 启动按钮 | 内存 | 重启可视化服务 |
| 扩展版本与远程对比 | 卡片 | — | 即时（fetch GitHub refs） |
| novel.json 字段编辑 | form | `<小说工程>/novel.json` | 即时（v1 仅约定） |

#### P2 — 可做

- 调试缓冲容量 / memory 组数（需改源码读 env）
- 主题切换（需补亮色 CSS 变量）
- 多小说工程管理

#### 不做（明确边界）

- ❌ LLM API Key / 模型 / provider / Base URL —— PI 管
- ❌ 向量维度 512 —— 测试钉死
- ❌ temperature / maxTokens —— 扩展业务参数，硬编码
- ❌ worldGraphDir / memory 路径 —— 硬编码
- ❌ native 模块编译 —— 浏览器不能跑 node-gyp
- ❌ pi 本体更新 —— PI 自己管

---

## 五、前端页面设计

### 5.1 入口

在 visualizer-ui 顶部 Tab 栏新增「设置」，与「工作台 / 事件链 / 调试」并列。

### 5.2 页面结构（左侧导航 + 右侧内容）

```
┌─────────────────────────────────────────────────────────────┐
│ [工作台] [事件链] [调试] [设置]                              │
├──────────────┬──────────────────────────────────────────────┤
│ 概览         │  当前内容区                                  │
│ 扩展配置     │                                              │
│ 规则集       │                                              │
│ 向量模型     │                                              │
│ 依赖与升级   │                                              │
│ 高级         │                                              │
└──────────────┴──────────────────────────────────────────────┘
```

**注意**：没有「LLM 配置」子页——LLM 由 PI 管，只在「概览」只读展示 PI 当前模型与 Key 状态。

### 5.3 各子页内容

#### 5.3.1 概览

只读卡片，一屏看完当前状态，顶部常驻「一键检查」「一键更新」：

- **PI 配置区（只读）**
  - 当前模型：`deepseek-v4-flash`（来自 `ctx.model`，不显示 Key 明文）
  - API Key：已配置 ✅ / 未配置 ❌（调 `ctx.modelRegistry.hasConfiguredAuth(ctx.model)`）
  - pi 版本：`0.82.0` ✅
  - 提示："模型与 Key 请在 PI 内配置：`/model` 切换模型，`pi login` 登录，或设置 `DEEPSEEK_API_KEY` 环境变量"
- **扩展配置区**
  - 扩展版本：本地 `0.1.0` / 远程 `0.1.x` + 「需要更新」红点
  - HF 镜像：`hf-mirror.com` ✅ / 官方 ⚠️
  - 调试总线：开 / 关
  - 向量模型缓存：已下载 ✅ / 未下载 ⚠️
- **当前小说工程**
  - 路径 + 章节数 + 实体数 + 事件数
- **可视化服务**
  - 运行中 `http://localhost:7421` / 未启动

#### 5.3.2 扩展配置（原"LLM 配置"替换为扩展专属配置）

```
┌─ 扩展环境变量（写入 <小说工程>/.env）─────────────────────┐
│ HF 镜像:  [官方 / hf-mirror.com / 自定义]  → HF_ENDPOINT │
│ 调试总线: [开 / 关]                         → PI_DEBUG    │
└─────────────────────────────────────────────────────────┘
[保存到 .env]  [说明：需重启 pi 会话生效]

┌─ PI 配置指引（只读）──────────────────────────────────────┐
│ LLM 模型与 API Key 由 PI 本体管理，本扩展不重复配置：     │
│  • 切换模型：PI 会话内输入 /model                         │
│  • 登录 provider：终端执行 pi login                       │
│  • 环境变量：export DEEPSEEK_API_KEY=sk-...               │
│  • 配置文件：~/.pi/agent/settings.json 的 defaultModel    │
│ 当前状态：模型 deepseek-v4-flash ✅  Key 已配置 ✅        │
└─────────────────────────────────────────────────────────┘
```

#### 5.3.3 规则集

```
┌─ 规则集三件套（即时生效）─────────────────────────────────┐
│ [渲染规则集] [planner 规则集] [角色规则集]                │
│ ┌──────────────────────────────────────────────────────┐ │
│ │ <textarea 大文本编辑器>                               │ │
│ └──────────────────────────────────────────────────────┘ │
│ 字数: 1234   上次修改: 2026-07-28                        │
│ [保存]  [恢复默认]                                       │
└─────────────────────────────────────────────────────────┘
```

- 三个 .md 从 `<小说工程>/` 读写，运行时每次调用重读，保存即生效。
- 「恢复默认」从 `templates/novel/` 拷贝，二次确认。
- 编辑器用 `el-input type="textarea" :rows="20"`，不引入 Monaco/CodeMirror。

#### 5.3.4 向量模型

```
┌─ 向量模型 ────────────────────────────────────────────────┐
│ 模型: [Xenova/bge-small-zh-v1.5 ▼]  → PI_EMBEDDER_MODEL  │
│ 维度: 512（只读，由模型决定）                              │
│ HF 镜像: 复用扩展配置的 HF_ENDPOINT                       │
└─────────────────────────────────────────────────────────┘
┌─ 缓存 ────────────────────────────────────────────────────┐
│ 状态: 已下载（XX MB） / 未下载                             │
│ [清理缓存]  [重新下载]                                     │
└─────────────────────────────────────────────────────────┘
[保存到 .env]
```

- **前置**：`src/embedder.ts` 需改造为支持 `PI_EMBEDDER_MODEL` env 覆盖。
- 维度只读（测试钉死 512，切模型需用户自负其责）。

#### 5.3.5 依赖与升级

```
┌─ 依赖检查 ────────────────────────────────────────────────┐
│ Node.js           v24.0.0  ✅                              │
│ better-sqlite3    11.3.0   ✅                              │
│ sharp             0.33.0   ✅                              │
│ onnxruntime-node  1.18.0   ✅                              │
│ pi                0.82.0   ✅                              │
│ [重新检查]  [一键修复指引]                                  │
└─────────────────────────────────────────────────────────┘
┌─ 扩展升级 ────────────────────────────────────────────────┐
│ 当前版本: 0.1.0    最新版本: 0.1.2                        │
│ [检查更新]  [一键更新]                                     │
│                                                            │
│ 更新日志（SSE 实时滚动）：                                  │
│ ┌──────────────────────────────────────────────────────┐ │
│ │ > git pull origin master                               │ │
│ │ > npm run build                                        │ │
│ │ > npm run sync -- --target ...                         │ │
│ └──────────────────────────────────────────────────────┘ │
│ 完成后请在 pi 会话内执行 /reload                           │
└─────────────────────────────────────────────────────────┘
```

- 「一键更新」执行 `git pull` → `npm run build` → `npm run sync`。
- **native 模块变更检测**：对比 `package-lock.json` 差异，提示但不自动 `npm install`。
- 「一键修复指引」：每项失败依赖给具体命令，不自动执行。

#### 5.3.6 高级

```
┌─ 可视化服务 ──────────────────────────────────────────────┐
│ 端口: [7421]  [启动]  [停止]                               │
│ 状态: 运行中 http://localhost:7421                         │
└─────────────────────────────────────────────────────────┘
┌─ novel.json ──────────────────────────────────────────────┐
│ name: [我的小说]                                           │
│ engineVersion: 0.1.0（只读）                               │
│ worldGraphDir: .pi/world-graph-v3（只读）                  │
│ chaptersDir: 正文                                          │
│ storyTimeFormat: ch{NNN}.ev{NNN}                           │
│ [保存]  [说明：v1 引擎尚未读取这些字段]                    │
└─────────────────────────────────────────────────────────┘
```

---

## 六、后端 API 设计

新增 `/api/admin/*` 端点，走现有 `routes.ts` 的 envelope 与 CORS。**安全前提**：visualizer 只监听 localhost，admin 端点不做鉴权。

### 6.1 扩展配置（仅扩展专属，不含 LLM）

| 方法 | 路径 | 入参 | 响应 |
|---|---|---|---|
| GET | `/api/admin/config` | — | `{ hfEndpoint, debug, embedderModel, piModel?, piHasKey? }`（PI 字段只读） |
| POST | `/api/admin/config` | `{ hfEndpoint?, debug?, embedderModel? }` | 写入 `.env`，返回合并后状态 |

**注意**：`piModel` / `piHasKey` 只读返回，不接受 POST 修改——这些归 PI 管。

### 6.2 PI 配置只读查询

| 方法 | 路径 | 入参 | 响应 |
|---|---|---|---|
| GET | `/api/admin/pi-status` | — | `{ model: {id, provider}, hasKey, piVersion }` |

**实现**：从 `ctx.model` + `ctx.modelRegistry.hasConfiguredAuth(ctx.model)` + `spawn("pi", ["--version"])` 获取。

### 6.3 规则集

| 方法 | 路径 | 入参 | 响应 |
|---|---|---|---|
| GET | `/api/admin/rulesets` | — | 三份内容 + mtime |
| PUT | `/api/admin/rulesets/:name` | `{ content }` | `{ ok, mtime }`，name ∈ `render\|planner\|role` |
| POST | `/api/admin/rulesets/:name/reset` | — | 从模板恢复 |

### 6.4 依赖与升级

| 方法 | 路径 | 入参 | 响应 |
|---|---|---|---|
| GET | `/api/admin/doctor` | — | 8 项检查结果 |
| GET | `/api/admin/version` | — | `{ local, remote?, updateAvailable }` |
| POST | `/api/admin/update` | — | `{ jobId }` |
| GET | `/api/admin/update/stream`（SSE） | — | 实时日志 `{ stage, line, done, error? }` |

### 6.5 向量模型

| 方法 | 路径 | 入参 | 响应 |
|---|---|---|---|
| GET | `/api/admin/embedder/status` | — | `{ model, dim, cachePresent, cacheSize? }` |
| POST | `/api/admin/embedder/cache/clear` | — | `{ ok }` |
| POST | `/api/admin/embedder/warmup` | — | `{ ok, latencyMs }` |

### 6.6 novel.json

| 方法 | 路径 | 入参 | 响应 |
|---|---|---|---|
| GET | `/api/admin/novel-json` | — | 文件内容 |
| PUT | `/api/admin/novel-json` | `{ ...fields }` | 写回 |

### 6.7 服务端实现要点

- **`.env` 读写**：读 `<小说工程>/.env`（不存在则创建），按行解析 `KEY=VALUE`，写入时保留注释与未知字段。**只存扩展专属变量**（`HF_ENDPOINT` / `PI_DEBUG` / `PI_EMBEDDER_MODEL`），不存 API Key。
- **`.env` 加载时机**：`src/index.ts` 的 `session_start` 最前面加载（手动解析，不引入 dotenv 也可），把扩展专属变量注入 `process.env`。
- **PI 配置只读**：admin 端点通过 `ctx.model` / `ctx.modelRegistry` 读 PI 状态，不写 PI 的 `settings.json` / `auth.json`。
- **规则集路径**：复用 `@pi/renderer` 的 `loadRuleSet` / `src/planner-rule-loader.ts` 的 `loadPlannerRuleSet` / `@pi/role-pool` 的 `loadRoleRuleSet` 已有路径解析。
- **doctor 包装**：把 `scripts/doctor.mjs` 的检查逻辑抽成 `src/admin/doctor.ts` 可 import 函数。
- **update 流程**：`spawn("git", ["pull"])` → `spawn("npm", ["run", "build"])` → `spawn("npm", ["run", "sync", "--", "--target", ...])`，stdout/stderr 行级转发到 SSE。

---

## 七、实现阶段（分步迭代）

### 阶段 1：LLM 调用链改造（前置必做）

1. 删除 `src/llm-config.ts`。
2. 改造 5 个 caller（`planner-llm.ts` / `renderer-llm.ts` / `role-pool-llm.ts` / `knowledge-mapper-llm.ts` / `scheduler-llm.ts`）：工厂签名从 `(model, apiKey, provider)` 改为 `(ctx: ExtensionContext)`，内部用 `ctx.model` + `ctx.modelRegistry.getApiKeyAndHeaders()`。
3. 改造 `src/tools/scheduler-tools.ts` 等工具的 `execute` 接收第 5 个参数 `ctx`，传给 `makeSchedulerCtx`。
4. 改造 `src/embedder.ts`：支持 `PI_EMBEDDER_MODEL` env 覆盖。
5. 在 `src/index.ts` 的 `session_start` 最前面加载 `<小说工程>/.env`（仅扩展专属变量）。
6. 新增 `src/admin/env-store.ts`：`.env` 读写，保留注释与未知字段。
7. 更新所有受影响测试（mock `ctx.model` + `ctx.modelRegistry`）。
8. **验证**：`DEEPSEEK_API_KEY` 环境变量配好后，三路 LLM 全部可用；`/model` 切换模型后扩展立即跟随。

### 阶段 2：后端 admin API

9. 在 `src/visualizer/routes.ts` 新增 `/api/admin/*` 路由组。
10. 实现 config / pi-status / rulesets / doctor / version / embedder / novel-json 端点。
11. 把 `scripts/doctor.mjs` 检查逻辑抽成 `src/admin/doctor.ts`，CLI 脚本改为调用该函数。
12. 实现 update 流程的 spawn + SSE 日志流。
13. 测试：每个端点 happy path + 错误路径。

### 阶段 3：前端设置页

14. 在 `visualizer-ui/components/` 新增 `settings-view.js`（主容器）+ 子组件 `settings-overview.js` / `settings-config.js` / `settings-rulesets.js` / `settings-embedder.js` / `settings-deps.js` / `settings-advanced.js`。
15. 在 `app.js` 注册「设置」Tab 与子组件。
16. 在 `api.js` 新增 `admin.*` 方法组。
17. 在 `index.html` 添加 `<script src="components/settings-*.js">`。
18. 联调：每个子页对应 admin 端点。

### 阶段 4：打磨

19. 一键更新 SSE 日志流前端展示（自动滚动 + 颜色高亮）。
20. 规则集编辑器 unsaved 提示。
21. 概览页"需要更新"红点徽标。
22. 文档：更新 `docs/SETUP.md` 与 `docs/USAGE.md`，说明设置页用法与"LLM 配置归 PI"。

---

## 八、风险与注意事项

### 8.1 安全

- **`.env` 不存 API Key**：只存 `HF_ENDPOINT` / `PI_DEBUG` / `PI_EMBEDDER_MODEL`。API Key 由 PI 管（`auth.json` / 环境变量）。
- **`.env` 加 .gitignore**：`templates/novel/_gitignore` 追加 `.env`。
- **PI 配置只读**：admin 端点不写 PI 的 `settings.json` / `auth.json`，只通过 `ctx` 读取展示。
- **admin 端点无鉴权**：依赖 visualizer 只监听 localhost。

### 8.2 LLM 改造风险

- **`ctx.model` 可能为 undefined**：PI 启动时若未配 key，`ctx.model` 可能为空。caller 需显式检查并给出友好错误。
- **三路用同一模型**：planner/renderer/role 用 `ctx.model`，丢失分路配不同模型的能力。temperature/maxTokens 仍分路硬编码（planner 0.3 / renderer 0.7），业务差异靠这个保证。
- **测试改造量大**：5 个 caller 的测试都要 mock `ctx.model` + `ctx.modelRegistry`，不再 mock `process.env`。
- **`knowledge-mapper` 复用 planner**：改造后 `knowledge-mapper-llm.ts` 也直接用 `ctx.model`，不再"复用 planner 配置"——因为都统一用 `ctx.model` 了。

### 8.3 并发与破坏性

- **.env 并发写**：写入时串行化（同一时刻一个写请求）。
- **规则集并发写**：读时返回 mtime，保存带 `If-Match`（mtime 不匹配 409）。
- **update 流程独占**：同一时刻一个 update job，重复请求 409。
- **一键更新冲突**：`git pull` 可能因本地修改失败，需检测 working tree clean。
- **native 重装不自动**：检测 `package-lock.json` 差异，提示但不执行 `npm install`。

### 8.4 兼容性

- **`.env` 加载顺序**：必须在 `new Embedder()` 前加载（embedder 读 `HF_ENDPOINT` / `PI_EMBEDDER_MODEL`），在 caller 第一次调 `complete` 前加载。`src/index.ts` 的 `session_start` 最前面是正确位置。
- **PI 扩展加载**：admin 端点在 visualizer 服务内，visualizer 需调 `open_visualizer` 工具才启动。**首次使用设置页前必须先启动可视化服务**——概览页应明确提示。
- **embedder 改造**：`PI_EMBEDDER_MODEL` 必须在 `new Embedder()` 前读。模型切换后维度可能变（破测试）——P1 向量模型选择应**限制在维度同为 512 的预设列表内**，自定义模型用户自负其责。

### 8.5 不破坏的边界

- 不引入构建工具，保持 visualizer-ui 纯静态。
- 不修改 PI 本体的 loader / config / settings.json / auth.json。
- 不修改 `package.json` 的 `pi.extensions` 字段格式。
- 不引入大体积依赖（dotenv 可不引入，手动解析 `.env` 即可）。

---

## 九、关键文件改动清单

| 文件 | 改动 |
|---|---|
| `src/llm-config.ts` | **删除** |
| `src/planner-llm.ts` | 工厂签名改为 `(ctx)`，用 `ctx.model` + `ctx.modelRegistry` |
| `src/renderer-llm.ts` | 同上 |
| `src/role-pool-llm.ts` | 同上 |
| `src/knowledge-mapper-llm.ts` | 同上，不再"复用 planner 配置" |
| `src/scheduler-llm.ts` | `makeSchedulerCtx` 签名加 `ctx`，5 路 caller 装配改为传 `ctx` |
| `src/tools/scheduler-tools.ts` | `execute` 接收第 5 个参数 `ctx`，传给 `makeSchedulerCtx` |
| `src/tools/render-tools.ts` | 同上（如调 LLM） |
| `src/tools/role-tools.ts` | 同上（如调 LLM） |
| `src/tools/import-tools.ts` | 同上（如调 LLM） |
| `src/embedder.ts` | 支持 `PI_EMBEDDER_MODEL` env 覆盖 |
| `src/index.ts` | `session_start` 最前加载 `.env`；移除 `PI_*_API_KEY` / `PI_MODEL` 相关读取 |
| `src/visualizer/routes.ts` | 新增 `/api/admin/*` 路由组 |
| `src/admin/env-store.ts` | **新增**：`.env` 读写 |
| `src/admin/doctor.ts` | **新增**：从 doctor.mjs 抽取检查逻辑 |
| `src/admin/updater.ts` | **新增**：git pull + build + sync + SSE 日志 |
| `src/admin/pi-status.ts` | **新增**：通过 `ctx.model` / `ctx.modelRegistry` 读 PI 状态 |
| `scripts/doctor.mjs` | 改为调用 `src/admin/doctor.ts` |
| `templates/novel/_gitignore` | 追加 `.env` |
| `visualizer-ui/components/settings-*.js`（7 个） | **新增**：设置页组件 |
| `visualizer-ui/app.js` | 注册「设置」Tab |
| `visualizer-ui/api.js` | 新增 `admin.*` 方法组 |
| `visualizer-ui/index.html` | 引入 settings 组件脚本 |
| `visualizer-ui/styles.css` | 设置页样式 |
| `docs/SETUP.md` / `docs/USAGE.md` | 文档更新：LLM 配置归 PI，扩展只配扩展专属项 |
| `tests/*.test.ts` | mock `ctx.model` + `ctx.modelRegistry`，删除 `process.env` mock |

---

## 十、待用户决策点

1. **设置页入口**：visualizer-ui 顶部 Tab（方案 A）还是独立页面（方案 B）？
   建议 A，零额外路由成本。

2. **首次使用前是否自动启动 visualizer**：当前需调 `open_visualizer` 工具才启动，意味着"打开设置页"本身要先有 visualizer 在跑。是否在 pi 会话启动时自动启动 visualizer（仅 admin 路由，不加载 3D 图）？
   建议否，保持按需启动；在 pi 提示词里引导用户先 `open_visualizer`。

3. **向量模型预设列表**：除默认值外预设哪几个？需保证维度同为 512。
   建议先只支持默认值 + 自定义输入，不做预设列表。

4. **`.env` 文件位置**：`<小说工程>/.env`（与小说工程绑定）还是 `~/.pi/.env`（全局）？
   建议 `<小说工程>/.env`，符合"runtime data 存小说工程内"的硬约束。

5. **一键更新的 target 默认值**：当前小说工程的扩展目录，还是所有已注册的小说工程？
   建议先只支持当前小说工程，多工程管理放 P2。

6. **规则集编辑器是否与 P0 同期做**：实现简单且即时生效。
   建议是，与 P0 同期。

---

## 附：研究依据

### PI 本体配置机制
- settings.json 类型与两级合并：[settings-manager.ts](file:///d:/claude/pi-ex/pi-ex/packages/coding-agent/src/core/settings-manager.ts) 行 77-116, 171-285
- API Key 解析链：[auth-storage.ts](file:///d:/claude/pi-ex/pi-ex/packages/coding-agent/src/core/auth-storage.ts) 行 452-522
- 环境变量 key 映射：[env-api-keys.ts](file:///d:/claude/pi-ex/pi-ex/packages/ai/src/env-api-keys.ts) 行 91-134
- ModelRegistry：[model-registry.ts](file:///d:/claude/pi-ex/pi-ex/packages/coding-agent/src/core/model-registry.ts) 行 405-1004
- ExtensionContext 类型：[types.ts](file:///d:/claude/pi-ex/pi-ex/packages/coding-agent/src/core/extensions/types.ts) 行 298-327
- ToolDefinition execute 签名：[types.ts](file:///d:/claude/pi-ex/pi-ex/packages/coding-agent/src/core/extensions/types.ts) 行 455-461
- pi-ai complete/getModel：[stream.ts](file:///d:/claude/pi-ex/pi-ex/packages/ai/src/stream.ts) 行 34-41, [models.ts](file:///d:/claude/pi-ex/pi-ex/packages/ai/src/models.ts) 行 20-26
- 模型解析优先级：[model-resolver.ts](file:///d:/claude/pi-ex/pi-ex/packages/coding-agent/src/core/model-resolver.ts) 行 476-562

### 官方扩展示例（调 LLM 的标准模式）
- [summarize.ts](file:///d:/claude/pi-ex/pi-ex/packages/coding-agent/examples/extensions/summarize.ts)
- [custom-compaction.ts](file:///d:/claude/pi-ex/pi-ex/packages/coding-agent/examples/extensions/custom-compaction.ts)
- [handoff.ts](file:///d:/claude/pi-ex/pi-ex/packages/coding-agent/examples/extensions/handoff.ts)
- [qna.ts](file:///d:/claude/pi-ex/pi-ex/packages/coding-agent/examples/extensions/qna.ts)

### narrative-engine 待改造文件
- [llm-config.ts](file:///d:/claude/pi-ex/narrative-engine/src/llm-config.ts)（删除）
- [planner-llm.ts](file:///d:/claude/pi-ex/narrative-engine/src/planner-llm.ts)
- [renderer-llm.ts](file:///d:/claude/pi-ex/narrative-engine/src/renderer-llm.ts)
- [role-pool-llm.ts](file:///d:/claude/pi-ex/narrative-engine/src/role-pool-llm.ts)
- [knowledge-mapper-llm.ts](file:///d:/claude/pi-ex/narrative-engine/src/knowledge-mapper-llm.ts)
- [scheduler-llm.ts](file:///d:/claude/pi-ex/narrative-engine/src/scheduler-llm.ts)
- [scheduler-tools.ts](file:///d:/claude/pi-ex/narrative-engine/src/tools/scheduler-tools.ts)
- [embedder.ts](file:///d:/claude/pi-ex/narrative-engine/src/embedder.ts)
- [index.ts](file:///d:/claude/pi-ex/narrative-engine/src/index.ts)

### 前端架构
- [visualizer-ui/index.html](file:///d:/claude/pi-ex/narrative-engine/visualizer-ui/index.html)
- [app.js](file:///d:/claude/pi-ex/narrative-engine/visualizer-ui/app.js)
- [api.js](file:///d:/claude/pi-ex/narrative-engine/visualizer-ui/api.js)
- [routes.ts](file:///d:/claude/pi-ex/narrative-engine/src/visualizer/routes.ts)

### 测试约束
- [embedder.test.ts:16](file:///d:/claude/pi-ex/narrative-engine/tests/embedder.test.ts) —— 维度 512 钉死
