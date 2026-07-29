# narrative-engine 应用化架构设计

> 日期：2026-07-29
> 目标：把 narrative-engine 从"开发仓库 + 项目级扩展同步"模式，重构为"可一键安装一键启动的 Tauri 应用 + 内置 PI 扩展"模式。
> 范围：架构设计文档，含 PI 行为查证、现有代码归属、改动清单、前端评估要点。
> 评估对象：本文档 + 现有 [visualizer-ui/](../../visualizer-ui/) 前端 + 现有扩展代码。

---

## 一、背景与目标

### 1.1 现状痛点

narrative-engine 当前是 PI 的扩展项目，存在以下对小白不友好的问题：

| 痛点 | 现状 | 影响 |
|---|---|---|
| 安装 | `git clone` + `npm install` + `npm run build` + `npm run sync` + 目标目录再 `npm install`（含 better-sqlite3 原生编译） | 至少 5 步，原生模块编译常出问题 |
| 启动 | `cd <项目> && pi`（需先全局装好 PI） | 没装 PI 完全用不了 |
| WebUI 入口 | 只能从 PI 内 `open_visualizer` 工具唤起，或独立 `npm run visualizer` | 没装 PI 也能用，但发现不到 |
| 项目管理 | 命令行 `npm run init`，无 GUI | 小白不会用 |
| 配置 | 改 `.env` 文件、跑 `npm run doctor` 自检 | 小白不会用 |
| 数据冗余 | 每个 novel 项目一份 `.pi/extensions/` + `node_modules` | 多项目重复占空间 |
| 扩展过重 | 扩展注册 31 个工具 + 强制注入 SKILL.md + memory.md，影响 PI 本身工具使用 | 用户无法屏蔽 |

**根本症结**：当前是"开发仓库 + 项目级扩展同步"模式，不是"可分发应用"模式。

### 1.2 目标形态

1. **单二进制分发**：Tauri 应用，双击即用，零命令行
2. **不装 PI 也能用基础功能**：项目管理、世界图编辑、小说导入、规则集配置、依赖自检
3. **装了 PI 解锁全部能力**：应用内一键启动 PI，自动加载内置扩展，AI 口述创作
4. **扩展可屏蔽**：用户可在应用内关闭 narrative-engine 扩展，PI 以纯净模式运行
5. **扩展可更新**：应用内检查更新、一键重装扩展

### 1.3 关键决策（已与用户确认）

| 决策点 | 选择 | 理由 |
|---|---|---|
| 应用形态 | **Tauri** | 单二进制、包体小（~10MB+node sidecar）、Rust 后端轻量、三平台构建 |
| PI 接入方式 | **保留现有模式，不桥接** | 用户在项目内一键启动 PI，应用本体不直接调 PI 工具；后续再慢慢演进 |
| 数据布局 | **混合：数据项目级，扩展全局** | world.db 等仍在 novel 项目目录；扩展不再每项目一份，改全局路径 |
| 扩展分发 | **应用内置** | 扩展随应用打包，启动 PI 时用 `-e` 显式加载，用户无感知 |

---

## 二、PI 扩展加载机制查证（关键）

> 本节是后续所有设计的依据，结论来自 PI 本体源码与文档查证。

### 2.1 扩展发现位置

PI 自动发现扩展的 4 个位置（[extensions.md §Extension Locations](../../pi-ex/packages/coding-agent/docs/extensions.md)）：

| 位置 | 范围 |
|---|---|
| `~/.pi/agent/extensions/*.ts` | 全局（所有项目） |
| `~/.pi/agent/extensions/*/index.ts` | 全局（子目录） |
| `.pi/extensions/*.ts` | 项目级 |
| `.pi/extensions/*/index.ts` | 项目级（子目录） |

**结论**：PI **原生支持全局扩展目录** `~/.pi/agent/extensions/`。

### 2.2 显式指定扩展的三种方式

| 方式 | 来源 | 用法 |
|---|---|---|
| **CLI 参数** | [args.ts 第 148-151 行](../../pi-ex/packages/coding-agent/src/cli/args.ts) | `pi -e <path>` 或 `pi --extension <path>`（可多次），路径可是文件或目录 |
| **settings.json** | [settings.md §Resources](../../pi-ex/packages/coding-agent/docs/settings.md) | `{"extensions": ["/path/to/dir"]}`（全局或项目级 settings.json 均可） |
| **自动发现** | extensions.md | 放到 `~/.pi/agent/extensions/` 即自动加载 |

### 2.3 屏蔽扩展的方式

| 方式 | 来源 | 行为 |
|---|---|---|
| **`--no-extensions` / `-ne`** | [args.ts 第 151-152 行](../../pi-ex/packages/coding-agent/src/cli/args.ts) | **禁用所有扩展自动发现**，但显式 `-e` 路径仍生效 |
| **不放置扩展** | extensions.md | 全局和项目级 extensions 目录都没放就不会加载 |
| **settings.json 不写** | settings.md | settings.json 的 `extensions` 数组为空时不加载 |

**关键发现**：`--no-extensions` 只屏蔽"自动发现"，**不屏蔽 `-e` 显式指定**。

### 2.4 工具级屏蔽（更细粒度）

PI 还支持工具级屏蔽（[args.ts 第 115-128 行](../../pi-ex/packages/coding-agent/src/cli/args.ts)）：

| 参数 | 行为 |
|---|---|
| `--no-tools` / `-nt` | 禁用所有工具（含内置和扩展） |
| `--no-builtin-tools` / `-nbt` | 只禁用内置工具，保留扩展工具 |
| `--tools <names>` / `-t` | 白名单：只启用指定工具 |
| `--exclude-tools <names>` / `-xt` | 黑名单：禁用指定工具 |

### 2.5 对应需求的实现路径

| 需求 | 实现路径 |
|---|---|
| 应用内置扩展加载 | 应用首次启动时把扩展复制到 `<AppData>/narrative-engine/extensions/narrative-engine/`，启动 PI 时用 `pi -e <该路径>` |
| 屏蔽扩展按钮 | `extension.mode = "disabled"` → `launchPi` 拼 `pi --no-extensions` |
| 检查更新/重装扩展 | 应用本体替换 `<AppData>/.../extensions/narrative-engine/` 内容 + 跑 `npm install` |

---

## 三、现有代码归属分类

### 3.1 PI 运行时功能（强耦合 PI，扩展本体）

#### 3.1.1 扩展装配层

| 文件 | 职责 | PI 耦合点 |
|---|---|---|
| [src/index.ts](../../narrative-engine/src/index.ts) | 31 个工具注册 + session_start/shutdown 钩子 | `pi.on("session_start"...)`, `pi.on("before_agent_start"...)` |
| [src/session-state.ts](../../narrative-engine/src/session-state.ts) | session 级状态容器 | 跟随 session 生命周期 |
| [src/memory.ts](../../narrative-engine/src/memory.ts) | memory.md 注入 systemPrompt | `before_agent_start` 钩子拼 systemPrompt |
| [src/skills/narrative-engine/SKILL.md](../../narrative-engine/src/skills/narrative-engine/SKILL.md) | 主会话使用指南 | `resources_discover` 贡献给 pi skill 加载机制 |

#### 3.1.2 工具注册层（31 个工具）

| 文件 | 工具数 | 说明 |
|---|---|---|
| [src/tools/world-tools.ts](../../narrative-engine/src/tools/world-tools.ts) | 18 | 世界图 CRUD/检索 |
| [src/tools/render-tools.ts](../../narrative-engine/src/tools/render-tools.ts) | 5 | 章节文本操作 |
| [src/tools/scheduler-tools.ts](../../narrative-engine/src/tools/scheduler-tools.ts) | 3 | dispatch/commit/discard |
| [src/tools/role-tools.ts](../../narrative-engine/src/tools/role-tools.ts) | 2 | 角色池直调 |
| [src/tools/import-tools.ts](../../narrative-engine/src/tools/import-tools.ts) | 2 | 小说/酒馆卡导入 |
| [src/tools/visualizer-tools.ts](../../narrative-engine/src/tools/visualizer-tools.ts) | 1 | open_visualizer（PI 内启动可视化） |
| [src/tools/shared.ts](../../narrative-engine/src/tools/shared.ts) | - | 跨域 schema |

#### 3.1.3 LLM 调用层（依赖 `@earendil-works/pi-ai`）

| 文件 | 用途 | PI 依赖 |
|---|---|---|
| [src/planner-llm.ts](../../narrative-engine/src/planner-llm.ts) | planner 检索计划 LLM | `pi-ai.complete` + `validateToolCall` |
| [src/renderer-llm.ts](../../narrative-engine/src/renderer-llm.ts) | 渲染正文 LLM | 同上 |
| [src/role-pool-llm.ts](../../narrative-engine/src/role-pool-llm.ts) | 角色扮演 LLM | 同上 |
| [src/scheduler-llm.ts](../../narrative-engine/src/scheduler-llm.ts) | 调度器 LLM | 同上 |
| [src/knowledge-mapper-llm.ts](../../narrative-engine/src/knowledge-mapper-llm.ts) | knowledge_gained → declarationId 映射 | 同上 |

> 这一层是 PI 替换为别的智能体框架时**必须重写**的薄层（5 个文件，每个就一个 LLM 调用封装）。

#### 3.1.4 PI 调试总线集成

| 文件 | 状态 |
|---|---|
| [src/debug/bus.ts](../../narrative-engine/src/debug/bus.ts) | 纯逻辑环形缓冲（**可解耦**） |
| [src/debug/sse.ts](../../narrative-engine/src/debug/sse.ts) | SSE 端点（依赖 PI visualizer 服务器） |
| [src/debug/types.ts](../../narrative-engine/src/debug/types.ts) | 类型定义 |

### 3.2 引擎核心业务子包（已与 PI 解耦，纯逻辑）

这些是 narrative-engine 的真正业务资产，**完全不依赖 PI**，是 monorepo workspace 子包：

| 子包 | 职责 | 备注 |
|---|---|---|
| [@pi/world-graph](../../narrative-engine/packages/world-graph) | bi-temporal 世界图（SQLite + FTS5 + 向量） | 实体/事实/关系/可见性 |
| [@pi/scheduler](../../narrative-engine/packages/scheduler) | 调度器：检索计划 → 角色编排 → 写扩散 + 渲染 | plan/yolo 双模式 |
| [@pi/role-pool](../../narrative-engine/packages/role-pool) | 角色池：串行扮演 | 酒馆卡静态层 + 动态事实 |
| [@pi/renderer](../../narrative-engine/packages/renderer) | 渲染器：结构化输出 → 规则集约束的正文 | 章节文件锚点 |
| [@pi/novel-importer](../../narrative-engine/packages/novel-importer) | EPUB → 世界图 8 阶段管道 | 测试实现 |

### 3.3 WebUI 本体就能编辑的功能（不依赖 PI）

#### 3.3.1 项目管理后端（@pi/novel-launcher，已就绪）

[packages/novel-launcher/src/index.ts](../../narrative-engine/packages/novel-launcher/src/index.ts) — 注释明确写了"**仅核心库 API，不含 HTTP 服务层（前端阶段再加薄服务层）**"、"**不随扩展同步到 .pi/extensions/**"。

| API | 用途 |
|---|---|
| `discoverProjects` / `getProjectMeta` | 扫描本地小说项目 |
| `launchPi` | 跨平台新终端启动 PI（自动加载扩展） |
| `createProject` | 新建小说工程 |
| `launchVisualizer` | 启动可视化 |
| `openInFileManager` | 打开文件夹 |

#### 3.3.2 配置管理后端（@pi/admin，已就绪）

[packages/admin/src/index.ts](../../narrative-engine/packages/admin/src/index.ts) — 注释同样写明"**不含 HTTP 服务层**"、"**不随扩展运行时加载**"。

| 模块 | 用途 | PI 依赖 |
|---|---|---|
| `env-store` | .env 读写（HF_ENDPOINT / PI_DEBUG / PI_EMBEDDER_MODEL） | 无 |
| `rulesets` | 规则集三件套读写/重置 | 无 |
| `doctor` | 8 项依赖自检 | 无 |
| `updater` | git pull + build + sync 流式输出 | 无 |
| `embedder-status` | 向量模型状态/缓存/warmup | 无 |
| `novel-json` | novel.json 读写 | 无 |
| `pi-status` | PI 版本/模型/API Key 探测 | 仅 `spawn("pi",["--version"])` + 注入的 ctx，**不算硬耦合** |

#### 3.3.3 世界图可视化（双入口，standalone 已可独立运行）

关键发现：[src/visualizer/standalone.ts](../../narrative-engine/src/visualizer/standalone.ts) 已经证明可视化服务可以**完全脱离 PI** 运行，直接打开 `world.db` 提供编辑能力。

| 文件 | 用途 | PI 依赖 |
|---|---|---|
| [src/visualizer/standalone.ts](../../narrative-engine/src/visualizer/standalone.ts) | 独立启动入口（`npm run visualizer`） | 无 |
| [src/visualizer/server.ts](../../narrative-engine/src/visualizer/server.ts) | HTTP 服务器（双入口共用） | 无 |
| [src/visualizer/routes.ts](../../narrative-engine/src/visualizer/routes.ts) | 13 个 /api 端点 | 无 |
| [visualizer-ui/](../../narrative-engine/visualizer-ui) | Vue + Element Plus 前端静态资源 | 无 |

**当前 /api 端点覆盖**（[routes.ts](../../narrative-engine/src/visualizer/routes.ts)）：

- 读：status / graph / entities / entities/:id/history / declarations/:id/visibility / search / events / events/:id/chain / character-view
- 写：events（强制 source:user）/ entities/:id/summary / relations / relations/close / visibility / visibility/close
- 调试：debug/stream (SSE) / debug/events / debug/clear

#### 3.3.4 模板与脚本

- [templates/novel/](../../narrative-engine/templates/novel) — 小说工程模板（novel.json + 三套规则集）
- [scripts/doctor.mjs](../../narrative-engine/scripts/doctor.mjs) / [init-novel.mjs](../../narrative-engine/scripts/init-novel.mjs) / [migrate-schema.mjs](../../narrative-engine/scripts/migrate-schema.mjs) — 命令行工具
- [scripts/visualizer.mjs](../../narrative-engine/scripts/visualizer.mjs) — 独立可视化启动器

### 3.4 模糊地带（需评估是否下沉）

| 模块 | 现状 | 决策点 |
|---|---|---|
| **embedder/search** ([src/embedder.ts](../../narrative-engine/src/embedder.ts), [src/search.ts](../../narrative-engine/src/search.ts)) | Xenova transformers 纯逻辑，但放在 `src/` 内被 PI 装配 | standalone 已用，可考虑下沉到子包 |
| **memory.md** ([src/memory.ts](../../narrative-engine/src/memory.ts)) | 文件读写 + `before_agent_start` 注入 systemPrompt | 文件本身 WebUI 可读写；注入是 PI 专属 |
| **SKILL.md** | 通过 `resources_discover` 贡献 PI | 文件本身 WebUI 可编辑；贡献机制是 PI 专属 |
| **debug bus** ([src/debug/bus.ts](../../narrative-engine/src/debug/bus.ts)) | 纯逻辑环形缓冲，但当前由 PI session 装配注入 | 可下沉为子包，WebUI 也能消费调度链事件 |

---

## 四、目标架构

### 4.1 架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│  narrative-engine.app  (Tauri 单二进制分发)                      │
│                                                                  │
│  ┌────────────────────────────────────────┐                      │
│  │  Tauri Window (WebView)                │                      │
│  │  ┌──────────────────────────────────┐  │                      │
│  │  │  visualizer-ui (Vue+ElementPlus) │  │                      │
│  │  │  + 项目管理页 + 配置页 + Doctor  │  │                      │
│  │  └──────────────┬───────────────────┘  │                      │
│  └─────────────────┼──────────────────────┘                      │
│                    │ HTTP fetch localhost:7421                    │
│  ┌─────────────────▼──────────────────────┐                      │
│  │  Node Sidecar (Tauri 启动时 spawn)     │                      │
│  │  ┌──────────────────────────────────┐  │                      │
│  │  │ unified-server.ts (新)           │  │                      │
│  │  │  ├─ /api/world/*  (复用现有)      │  │                      │
│  │  │  ├─ /api/projects/* (新薄层)      │  │                      │
│  │  │  ├─ /api/admin/*   (新薄层)       │  │                      │
│  │  │  └─ /api/launcher/*(新薄层)       │  │                      │
│  │  └──────────────────────────────────┘  │                      │
│  └─────────────────┬──────────────────────┘                      │
│                    │                                             │
│  ┌─────────────────▼──────────────────────────────────────┐     │
│  │  全局扩展目录 (AppData/narrative-engine/extensions/)    │     │
│  │  ├─ dist/         ← build 产物                          │     │
│  │  ├─ packages/     ← @pi/* 子包                          │     │
│  │  ├─ visualizer-ui/ ← 前端                               │     │
│  │  ├─ templates/                                            │     │
│  │  └─ node_modules/ ← 一次性安装                           │     │
│  └────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ 用户点"启动 PI 创作"
                              │ ↓ launchPi(projectDir, -e <全局扩展>)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  PI 进程 (新终端窗口，用户已装 PI)                                │
│  ├─ 加载全局扩展 narrative-engine                                │
│  ├─ 31 工具注册 + memory.md 注入 + SKILL.md 加载                 │
│  └─ 用户口述 → scheduler_dispatch → 写 world.db (项目级)         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ 共享文件 (不共享进程)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  novel 项目目录 (用户选择)                                       │
│  ├─ novel.json                                                   │
│  ├─ 规则集.md / planner 规则集.md / 角色规则集.md                │
│  ├─ 正文/                                                        │
│  ├─ .pi/world-graph-v3/  ← world.db + events.jsonl + memory.md   │
│  └─ .pi/extensions/  ← 不再每项目一份(改全局)                    │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 三种运行形态

| 形态 | extensionMode | extensionPath | PI 启动命令 | 结果 |
|---|---|---|---|---|
| 应用内置扩展（推荐） | `"enabled"` 或缺省 | `<AppData>/narrative-engine/extensions/narrative-engine` | `pi -e <extensionPath>` | 应用首次启动时把扩展复制到 AppData，PI 显式加载 |
| 用户已全局安装 | `"enabled"` 或缺省 | 不传 | `pi` | PI 自动发现 `~/.pi/agent/extensions/narrative-engine/` |
| 屏蔽扩展（纯净 PI） | `"disabled"` | 忽略 | `pi --no-extensions` | 完全不加载任何扩展，PI 纯净模式 |

---

## 五、核心需求实现

### 5.1 应用配置持久化

#### 5.1.1 配置文件位置

```
%APPDATA%/narrative-engine/app-config.json      (Windows)
~/Library/Application Support/narrative-engine/  (macOS)
~/.config/narrative-engine/                      (Linux)
```

#### 5.1.2 配置结构

```json
{
  "extension": {
    "mode": "enabled",
    "globalPath": "<AppData>/narrative-engine/extensions/narrative-engine",
    "useExplicitFlag": true,
    "version": "0.1.0",
    "lastUpdated": "2026-07-29T..."
  },
  "launcher": {
    "piExecutable": "pi",
    "defaultScanRoots": ["~/Documents/novels"]
  },
  "embedder": {
    "model": "Xenova/bge-small-zh-v1.5"
  }
}
```

- `mode`：`"enabled"` / `"disabled"`（对应 WebUI 的开关按钮）
- `globalPath`：扩展安装位置
- `useExplicitFlag`：是否用 `-e` 显式加载（true=应用管控，false=走 PI 自动发现）

### 5.2 屏蔽扩展按钮

#### 5.2.1 LaunchOptions 改造

[packages/novel-launcher/src/types.ts](../../narrative-engine/packages/novel-launcher/src/types.ts) 与 [launch.ts](../../narrative-engine/packages/novel-launcher/src/launch.ts) 改造：

```typescript
export interface LaunchOptions {
  args?: string[];
  executable?: string;
  title?: string;
  // 新增：扩展加载策略
  extensionMode?: "enabled" | "disabled";  // 缺省 "enabled"
  // 新增：显式扩展路径（可选，缺省走 ~/.pi/agent/extensions/ 自动发现）
  extensionPath?: string;
}
```

#### 5.2.2 launchPi 内部逻辑

```typescript
const piArgs: string[] = [];
if (options?.extensionMode === "disabled") {
  piArgs.push("--no-extensions");
} else if (options?.extensionPath) {
  piArgs.push("-e", options.extensionPath);
}
piArgs.push(...(options?.args ?? []));
const pid = _spawnNewTerminal(dir, executable, piArgs, title);
```

### 5.3 检查更新/重装扩展

#### 5.3.1 现有 updater 分析

[@pi/admin 的 updater.ts](../../narrative-engine/packages/admin/src/updater.ts) 已实现 `runUpdate(repoRoot, targetDir)` 异步生成器，4 阶段流程 `check → pull → build → sync`，行级流式输出。

**当前问题**：
- `runUpdate` 假定 `repoRoot` 是 git 仓库（git pull）。应用内置扩展场景下，全局扩展目录不是 git 仓库，是应用打包时复制的快照。
- `sync` 阶段依赖 `scripts/sync.mjs`，但全局扩展模式不再走 sync。

#### 5.3.2 需要补的两条路径

| 场景 | 路径 | 函数 |
|---|---|---|
| 开发模式（git 仓库） | 现有 `runUpdate`（git pull + build + sync 到全局扩展目录） | 保留 |
| 应用内置模式（非 git） | 新增：从应用内置快照重新复制 + npm install | `reinstallExtension(appBundlePath, globalExtDir)` |

### 5.4 三个 WebUI 按钮的行为定义

| 按钮 | 位置 | 后端 API | 行为 |
|---|---|---|---|
| **启用/禁用扩展** | 项目卡片或全局设置 | `PUT /api/admin/extension/mode` | 切换 `app-config.json` 的 `extension.mode`。下次 `launchPi` 生效 |
| **检查更新** | 设置页 | `GET /api/admin/extension/update-check` | 比对当前版本与远端版本（git 仓库 / npm registry / GitHub Release 三选一） |
| **重装扩展** | 设置页 | `POST /api/admin/extension/reinstall` | 从应用内置快照重新复制到 globalPath + 跑 `npm install`（流式输出） |

---

## 六、改动清单

### 6.1 现有代码改动

| 文件 | 改动 |
|---|---|
| [packages/novel-launcher/src/launch.ts](../../narrative-engine/packages/novel-launcher/src/launch.ts) | `LaunchOptions` 新增 `extensionMode` / `extensionPath`；根据配置拼 PI 启动参数 |
| [packages/novel-launcher/src/types.ts](../../narrative-engine/packages/novel-launcher/src/types.ts) | `LaunchOptions` 加两个字段 |
| [packages/admin/src/updater.ts](../../narrative-engine/packages/admin/src/updater.ts) | 新增 `reinstallExtension(appBundlePath, globalExtDir)` 函数（不走 git） |

### 6.2 新增模块

| 模块 | 用途 |
|---|---|
| `packages/admin/src/app-config.ts` | 应用级配置读写（与 env-store 模式一致） |
| `src/unified-server.ts`（或 `app-server.ts`） | 合并现有 visualizer server + 三个新薄 HTTP 路由（projects/admin/launcher） |
| `tauri-app/`（新目录） | Tauri 工程（src-tauri/ + tauri.conf.json + Rust main.rs） |
| `tauri-app/src-tauri/src/sidecar.rs`（或类似） | spawn Node sidecar、管理生命周期 |
| 应用打包脚本 | Tauri build + Node sidecar（用 `pkg` 或 `node-sea` 打包成单文件） |

### 6.3 弃用 / 改造

| 现有代码 | 处理 |
|---|---|
| [scripts/sync.mjs](../../narrative-engine/scripts/sync.mjs) | 不再需要"同步到项目级扩展目录"——扩展改全局 |
| [scripts/init-novel.mjs](../../narrative-engine/scripts/init-novel.mjs) | 保留逻辑，但入口改为应用内"新建项目"向导 |
| [scripts/visualizer.mjs](../../narrative-engine/scripts/visualizer.mjs) | 保留作开发用，应用本体不走它 |
| `.pi/extensions/narrative-engine/`（项目级） | 不再创建，改全局路径 |

---

## 七、前端现状与新增需求（供前端专家评估）

### 7.1 现有 visualizer-ui 结构

```
visualizer-ui/
├── components/
│   ├── debug-view.js       ← 调试事件查看器
│   ├── detail-editor.js    ← 实体/关系详情编辑
│   ├── entity-form.js      ← 实体表单
│   ├── entity-list.js      ← 实体列表
│   ├── event-timeline.js   ← 事件时间线
│   ├── graph-3d.js         ← 3D 力导向图
│   ├── help-tour.js        ← 帮助引导
│   ├── relation-form.js    ← 关系表单
│   ├── snapshot-table.js   ← 快照表
│   └── timeline-bar.js     ← 时间轴条
├── vendor/                  ← 本地依赖（Vue 3 + Element Plus + three.js + 3d-force-graph）
├── api.js                   ← API 调用封装
├── app.js                   ← 主应用
├── detail-panel.js          ← 详情侧栏
├── events-view.js           ← 事件视图
├── graph-view.js            ← 图谱视图
├── index.html
└── styles.css
```

**技术栈**：
- Vue 3（global.prod.js，非 SFC，模板用 template 标签或 render）
- Element Plus（dark 主题）
- three.js + 3d-force-graph（3D 图谱）
- **零构建**：纯静态资源，无 webpack/vite
- 本地 vendor 目录托管所有依赖

### 7.2 现有 /api 端点（已对接）

来自 [src/visualizer/routes.ts](../../narrative-engine/src/visualizer/routes.ts)：

| 端点 | 方法 | 用途 |
|---|---|---|
| `/api/status` | GET | 当前项目状态 |
| `/api/graph` | GET | 全量图谱数据 |
| `/api/entities` | GET | 实体列表 |
| `/api/entities/:id/history` | GET | 实体历史 |
| `/api/declarations/:id/visibility` | GET | 可见性声明 |
| `/api/search` | GET | 搜索 |
| `/api/events` | GET | 事件列表 |
| `/api/events/:id/chain` | GET | 事件链 |
| `/api/character-view` | GET | 角色视角 |
| `/api/events` | POST | 创建事件（强制 source:user） |
| `/api/entities/:id/summary` | PUT | 更新实体摘要 |
| `/api/relations` | POST | 创建关系 |
| `/api/relations/close` | POST | 关闭关系 |
| `/api/visibility` | POST | 创建可见性 |
| `/api/visibility/close` | POST | 关闭可见性 |
| `/api/debug/stream` | GET (SSE) | 调试事件流 |
| `/api/debug/events` | GET | 调试事件列表 |
| `/api/debug/clear` | POST | 清空调试事件 |

### 7.3 前端新增需求

> **2026-07-29 修订**：前端页面范围以设计稿 6 页为准（含文件编辑器），取舍结论见第十一章。本节清单为原始版本，页面/组件/端点的最终集合以 §11.2–§11.4 为准。

#### 7.3.1 新增页面

| 页面 | 用途 | 数据来源 |
|---|---|---|
| **项目管理页** | 扫描本地项目、新建项目、打开项目、启动 PI | `/api/projects/*`（新） |
| **设置页** | 应用配置、扩展管理、依赖自检 | `/api/admin/*`（新） |
| **Doctor 页** | 8 项依赖自检、一键修复引导 | `/api/admin/doctor`（新） |

#### 7.3.2 新增组件（建议）

| 组件 | 用途 |
|---|---|
| `project-card.js` | 项目卡片（显示标题、最后修改时间、操作按钮） |
| `extension-switch.js` | 扩展启用/禁用开关 |
| `update-progress.js` | 更新/重装进度流式显示（复用 debug-view 的流式模式） |
| `doctor-checklist.js` | 依赖自检清单 |
| `novel-form.js` | 新建项目表单（标题、作者、扫描根目录） |

#### 7.3.3 新增 /api 端点（待实现，供前端对接）

**项目管理**（薄 HTTP 层包装 @pi/novel-launcher）：

| 端点 | 方法 | 用途 |
|---|---|---|
| `/api/projects/scan?root=<path>` | GET | 扫描指定目录下的小说项目 |
| `/api/projects/:dir/meta` | GET | 获取项目元信息 |
| `/api/projects` | POST | 新建项目（body: {title, author, dir}） |
| `/api/projects/:dir/launch-pi` | POST | 启动 PI（body: {extensionMode, extensionPath}） |
| `/api/projects/:dir/open-folder` | POST | 在文件管理器中打开 |

**配置管理**（薄 HTTP 层包装 @pi/admin）：

| 端点 | 方法 | 用途 |
|---|---|---|
| `/api/admin/app-config` | GET | 读取应用配置 |
| `/api/admin/app-config` | PUT | 更新应用配置 |
| `/api/admin/extension/mode` | PUT | 切换扩展启用/禁用 |
| `/api/admin/extension/update-check` | GET | 检查扩展更新 |
| `/api/admin/extension/reinstall` | POST | 重装扩展（流式输出） |
| `/api/admin/doctor` | GET | 运行依赖自检 |
| `/api/admin/rulesets` | GET | 读取规则集 |
| `/api/admin/rulesets/:name` | PUT | 更新规则集 |
| `/api/admin/rulesets/:name/reset` | POST | 重置规则集 |
| `/api/admin/embedder-status` | GET | 向量模型状态 |
| `/api/admin/embedder-warmup` | POST | 预热向量模型 |

### 7.4 前端架构评估要点（请专家重点评估）

#### 7.4.1 现有架构的可扩展性

1. **零构建模式是否可持续**：当前 visualizer-ui 是纯静态资源（Vue global + Element Plus CDN-style），无构建工具。新增 3 个页面 + 5 个组件后，是否需要引入构建工具（如 Vite）？还是继续零构建？
2. **路由方案**：当前是单页应用，无前端路由。新增项目管理/设置/Doctor 页后，需要引入路由（hash 路由 or history 路由）。在零构建模式下如何实现？
3. **状态管理**：当前无 Pinia/Vuex，状态散落在各组件。多页面后是否需要集中状态管理？

#### 7.4.2 与 Tauri WebView 的兼容性

1. **WebView 与浏览器差异**：Tauri 在 Windows 用 WebView2（Chromium），macOS 用 WKWebView（Safari），Linux 用 WebKitGTK。现有 visualizer-ui 在 WebView 环境下是否有兼容问题？
2. **本地 HTTP 服务**：前端通过 `localhost:7421` 访问 sidecar HTTP 服务。WebView 内 fetch localhost 是否有跨域/混合内容问题？
3. **文件路径**：前端显示项目路径时，Windows 反斜杠 / macOS/Linux 正斜杠的差异如何处理？

#### 7.4.3 流式输出的 UI 模式

1. **SSE 复用**：现有 `/api/debug/stream` 用 SSE 推送调试事件。扩展重装进度也走 SSE（`/api/admin/extension/reinstall`），是否可复用 debug-view.js 的流式渲染模式？
2. **长任务取消**：重装扩展可能耗时较长（npm install），前端是否需要"取消"按钮？后端如何中断子进程？

#### 7.4.4 现有组件的复用度

1. **debug-view.js 的复用**：流式输出场景（扩展重装、依赖自检、更新检查）能否复用 debug-view.js？还是需要抽象成通用的 `stream-view.js`？
2. **entity-form.js / relation-form.js 的模式**：新建项目表单（novel-form.js）能否参考这两个表单组件的模式？
3. **help-tour.js 的扩展**：新增页面是否需要扩展帮助引导？

#### 7.4.5 用户体验

1. **首次启动引导**：用户首次打开应用，是否需要引导扫描项目目录、配置 PI 路径、初始化扩展？
2. **项目切换**：从项目管理页切换到某个项目后，世界图编辑页如何感知项目切换（重新加载 /api/graph）？
3. **PI 启动反馈**：点击"启动 PI 创作"后，PI 在新终端窗口启动。前端如何告知用户"PI 已在新窗口启动"？
4. **扩展状态可见性**：用户如何知道当前扩展是启用还是禁用？项目卡片上是否需要徽标？

---

## 八、工作阶段建议

> **2026-07-29 修订**：阶段 1 范围扩大（含 /api/files 与多项目切换）、阶段 2 拆为 2a/2b、阶段 5 打包方案修正，见 §11.5。

按"分步迭代"原则，建议分 6 个阶段：

| 阶段 | 工作内容 | 规模 | 依赖 |
|---|---|---|---|
| **阶段 1：sidecar 统一服务** | unified-server.ts 合并现有 + 加 3 个薄 HTTP 路由 | 中 | 无 |
| **阶段 2：前端页面扩展** | visualizer-ui 加项目管理/配置/Doctor 页签 | 中 | 阶段 1 |
| **阶段 3：全局扩展路径改造** | launchPi 加参数 + 应用首次启动时把扩展装到 AppData | 小 | 无 |
| **阶段 4：Tauri 壳** | tauri.conf.json + Rust spawn sidecar + WebView 加载 UI | 中 | 阶段 1、2 |
| **阶段 5：Node sidecar 打包** | 把 unified-server + 子包 + node_modules 打成单可执行 | 中 | 阶段 4 |
| **阶段 6：打包分发** | Tauri build 三平台 + 安装器 | 小 | 阶段 5 |

**建议先做阶段 1+2**（sidecar + 前端页签），纯 Node + Vue，验证业务逻辑跑通；再做 Tauri 壳。这样在 Tauri 阶段出问题不会卡住业务验证。

---

## 九、关键技术风险

1. **better-sqlite3 原生模块**：Tauri sidecar 跑 Node 时仍需编译 better-sqlite3。Tauri 跨平台打包时需要 prebuilt 二进制或 electron-rebuild 类似方案。**这是最大的工程难点**。

2. **Tauri + Node sidecar 通信**：Tauri 推荐用 Rust 后端，但现有代码全是 TS。最务实方案是 Tauri 仅做"窗口+spawn Node 服务+WebView 加载 UI"，HTTP 走 localhost。通信开销可忽略（本地）。

3. **全局扩展路径的版本升级**：扩展更新时需要替换 AppData 里的文件，应用本体需有"检查更新/重装扩展"按钮（admin.updater 已有逻辑可复用）。

4. **PI 启动参数的平台差异**：`pi -e <path>` 在 Windows / macOS / Linux 下的路径转义、终端启动方式差异，需在 `launchPi` 中处理。

---

## 十、待决策问题

以下问题需要在前端评估后确认：

1. **前端构建工具**：是否引入 Vite？还是继续零构建？零构建模式下多页面路由如何实现？
2. **流式输出统一**：扩展重装、依赖自检、更新检查的流式输出，是否抽象成通用的 `stream-view` 组件？
3. **项目切换机制**：从项目管理页进入某项目后，世界图页如何感知并重新加载？
4. **PI 启动反馈**：PI 在新终端启动后，前端如何反馈？是否需要轮询 PI 进程状态？
5. **首次启动引导**：是否需要 onboarding 向导？引导扫描项目目录 + 配置 PI 路径 + 初始化扩展？
6. **扩展状态可见性**：项目卡片上的扩展状态徽标设计？
7. **主题一致性**：新增页面是否沿用现有 Element Plus dark 主题？是否需要浅色主题切换？

---

## 十一、前端设计稿对齐与取舍（2026-07-29 补充）

> 背景：前端设计稿（`工作台 等 6 个设计/pages/`：项目管理 / 工作台 / 事件链 / 调试 / 文件编辑器 / 设置 共 6 页）与本计划核对后，存在两类分歧。本章给出取舍结论，作为实施依据。

### 11.1 取舍总原则

| 维度 | 以谁为准 | 理由 |
|---|---|---|
| **功能范围**（做什么页面、页面上有什么功能） | **前端设计稿** | 设计稿是用户确认过的目标形态，6 页都要做，**含文件编辑器**——不能期望用户单独开编辑器写文件 |
| **技术实现**（API 形状、数据模型、安全边界、落盘格式） | **后端计划 + 现有代码** | 后端计划已逐条与代码核对无虚报；设计稿是 v0 高保真原型，含 mock 数据与残留文案，不具实现约束力 |
| **视觉样式与 design token** | **前端原型页**（2026-07-29 修订） | 原型页是已落地的设计基线，token 体系完整（shadcn 风格 neutral 色系 + dark 默认 + Geist 字体族），直接抽取为全局 tokens.css，见 11.7 |

### 11.2 逐页权威来源矩阵

| 页面 | 功能定义来源 | 实现依据 | 裁剪 / 降级项 |
|---|---|---|---|
| 项目管理 | 设计稿 | §7.3.3 `/api/projects/*` + @pi/novel-launcher | 项目状态徽章（活跃/草稿/归档）**v1 不做**（无存储位置，P2 再议）；卡片统计先只做章节数 + 最后修改时间（discoverProjects 已有），实体/事件数需要 wg 查询，降级为"进入项目后显示" |
| 工作台 | 设计稿的布局与视觉 | **现有功能不变**（graph-3d / detail-editor / entity-form 全套保留） | 仅按设计稿重排布局与换肤，不重做功能；prop-table 等样式直接采用原型 token |
| 事件链 | 设计稿 | 现有 events / chain API 已覆盖 | "只看用户事件"筛选 = `/api/events` 加 `source` 查询参数（小改 routes.ts） |
| 调试 | 设计稿 | 现有 debug SSE + debug-view.js 已覆盖 | 调度器执行追踪的阶段展示复用现有 scheduler 调试事件，不新增事件类型 |
| **文件编辑器** | **设计稿（新增）** | **新增 `/api/files/*` 模块（11.3）** | 历史功能 v1 不做（P2：写前自动快照） |
| 设置 | **config-ui 设计文档为准**（比设计稿更细且与代码对齐） | config-ui 文档 §5-§6 + @pi/admin | 设计稿中的"通知""帮助"栏目裁剪；扩展管理三按钮（启停/检查更新/重装）并入"依赖与升级"子页 |

### 11.3 文件编辑器后端：新增 `/api/files/*`（@pi/files 或并入 admin）

**定位**：项目目录内 markdown 文件的通用读写，覆盖正文章节、角色设定、世界观文档等。规则集三件套**不走此模块**（已有 `/api/admin/rulesets`，含模板重置语义）。

| 端点 | 方法 | 用途 |
|---|---|---|
| `/api/files/tree` | GET | 项目目录树（递归，只列 `.md`，返回相对路径 + mtime + size） |
| `/api/files/read?path=<rel>` | GET | 读取文件内容 + mtime |
| `/api/files/write` | PUT | `{ path, content, baseMtime }`，mtime 不匹配返回 409（复用 rulesets 的乐观锁模式） |
| `/api/files/create` | POST | `{ path }` 新建空文件（父目录自动创建） |
| `/api/files/delete` | POST | `{ path }` 删除（二次确认由前端做） |

**安全约束（必须实现）**：

1. `path` 一律为项目根相对路径，resolve 后必须 `startsWith(projectRoot)`，拒绝 `..` 与绝对路径；
2. 只允许 `.md` 后缀（读可放宽到 `.txt`/`.json`，写只允许 `.md`）；
3. 写入串行化（与 .env 并发约束一致）。

**前端实现约束**（遵守零构建边界）：不引入 Monaco / CodeMirror。编辑区用 `el-input type="textarea"` 或 contenteditable，预览用 vendor 本地化的 marked.js（单文件，无构建）。设计稿的工具栏（标题/有序列表等）降级为简单快捷按钮（向 textarea 插入 markdown 前缀）。

**历史功能（P2）**：写入前把旧版本复制到 `.pi/file-backups/<rel>/<timestamp>.md`，设计稿的"历史"入口届时对接。v1 不做。

### 11.4 多项目世界图切换（提升为阶段 1 前置设计项）

**问题**：现有 visualizer server 启动时绑定单个 WorldGraph 实例，应用化后项目管理页要支持多项目切换。

**方案**：unified-server 内置 `ProjectRegistry`：

```typescript
interface ProjectRegistry {
  openProject(dir: string): Promise<ProjectHandle>;  // { wg, search, dir }，Map 缓存
  closeProject(dir: string): Promise<void>;
  getActive(): ProjectHandle | null;
  setActive(dir: string): void;
}
```

- 世界图 / files / admin 路由全部从 `getActive()` 取 wg 与项目根；
- 新增 `POST /api/projects/:dir/activate`（或 query 切换），前端项目切换后重新拉 `/api/graph`；
- 同时只激活一个项目（wg 实例占内存，多开无收益）；非活跃项目的 handle 保留缓存但可 LRU 关闭。

### 11.5 阶段计划修订

| 阶段 | 修订内容 |
|---|---|
| 阶段 1（sidecar 统一服务） | **范围扩大**：除 3 组薄路由外，加 11.3 的 `/api/files/*` + 11.4 的 ProjectRegistry。复杂度从"中"上调为"中大" |
| 阶段 2（前端页面扩展） | **拆成两步**：2a = 6 页导航 + 项目管理/设置/文件编辑器三个新页（**新页面直接基于原型 token 体系开发**，不走 Element Plus）；2b = 既有三页（工作台/事件链/调试）从 Element Plus 迁移到原型设计体系，完成后卸载 Element Plus 依赖。2b 可延后到 Tauri 之后，但新页面不得再新增 Element Plus 用法 |
| 阶段 5（Node sidecar 打包） | 方案修正：放弃单文件 sidecar，改"随包附带 Node 运行时 + 按平台预编译 node_modules"（better-sqlite3 + onnxruntime-node 两个原生模块 pkg/node-sea 都搞不定）。包体 ~150MB 可接受。**阶段 4 之前先做一次纯技术验证**（拿 standalone.ts 打 Windows 包试跑两个原生模块） |
| 新增贯穿项 | Xenova 向量模型随安装器内置或首启引导下载——否则"双击即用"在首次向量检索时破功 |

### 11.6 §10 待决策问题的结论

| # | 问题 | 结论 |
|---|---|---|
| 1 | 前端构建工具 | **不引入 Vite**，零构建 + hash 路由（`#/projects` / `#/workbench` / `#/editor` 等），与 config-ui 文档 §8.5 边界一致 |
| 2 | 流式输出统一 | **抽象 `stream-view.js`**：debug-view 的流式渲染逻辑抽出，扩展重装 / doctor / 更新检查复用 |
| 3 | 项目切换机制 | 按 11.4：后端单活跃项目 + 前端切换后全量重拉 |
| 4 | PI 启动反馈 | launchPi 返回 pid 即视为"已唤起终端"，前端 toast 提示"PI 已在新终端窗口启动"；**不做进程状态轮询**（终端窗口由用户自管，轮询 pid 跨平台不可靠） |
| 5 | 首次启动引导 | **做最简版**：首次启动无项目时项目管理页显示引导卡片（扫描目录 → 新建项目两步），不做多页向导 |
| 6 | 扩展状态徽标 | 项目卡片右上角小圆点（绿=enabled / 灰=disabled），数据来自 app-config，单状态全局生效非按项目 |
| 7 | 主题一致性 | **以原型页设计体系为准**（2026-07-29 修订）：token 抽取见 11.7。dark 为默认主题；原型自带完整 light 变体（同名 token 双值），做切换成本低，列为 P2。过渡期允许新旧体系共存，以页面为界，禁止同页混用 |

### 11.7 设计 token 基线（从原型页抽取，实现依据）

> 来源：`工作台 等 6 个设计/pages/*.html` 各页 head 中的 CSS 变量定义（6 页一致）。实施时抽取为 `visualizer-ui/tokens.css`，全站引入。

**主题机制**：`:root` 定义 light 值，`.dark` 覆盖为 dark 值；页面根元素 `class="dark" data-theme="dark"`——**dark 为默认主题**，light 切换列 P2。

**色板（dark 值 / light 值）**：

| token | dark | light | 用途 |
|---|---|---|---|
| `--background` | `#0a0a0a` | `#ffffff` | 页面底色 |
| `--foreground` | `#fafafa` | `#0a0a0a` | 主文字 |
| `--card` / `--card-foreground` | `#171717` / `#fafafa` | `#ffffff` / `#0a0a0a` | 卡片 |
| `--popover` | `#262626` | `#ffffff` | 浮层 |
| `--primary` / `--primary-foreground` | `#e5e5e5` / `#171717` | `#121212` / `#fafafa` | 主按钮（反色风格） |
| `--muted` / `--muted-foreground` | `#262626` / `#a1a1a1` | `#f5f5f5` / `#858585` | 次要面 / 次要文字 |
| `--accent` | `#404040` | `#f5f5f5` | hover/选中底色 |
| `--border` | `#282828` | `#e8e8e8` | 边框 |
| `--input` | `#343434` | `#e5e5e5` | 输入框边框 |
| `--destructive` | `#ff6467` | `#e7000b` | 危险操作 |
| `--success` / `--success-strong` / `--success-subtle` | `#62d178` / `#8be59c` / `#14241a` | — | 状态色（含深浅变体，doctor/依赖检查用） |
| `--error` / `--error-strong` / `--error-subtle` | `#ff6166` / `#ff9a9d` / `#2a1517` | — | 同上 |
| `--chart-1` … `--chart-5` | `#91c5ff` `#3a81f6` `#2563ef` `#1a4eda` `#1f3fad` | — | 图谱/图表蓝色系 |

**字体**：`--font-sans: Geist, ui-sans-serif, sans-serif, system-ui`；`--font-mono: Geist Mono, ui-monospace, monospace`；`--font-serif: DM Serif Display, ui-serif, serif`（标题点缀）。
实施注意：Geist / DM Serif Display 需 vendor 本地化（woff2 放 `visualizer-ui/vendor/fonts/`），遵守零构建 + 离线可用约束；拿不到授权文件时回退栈已内建。

**圆角**：`--radius-sm: 0.375rem` / `--radius-md: 0.5rem` / `--radius-lg: 0.625rem`。

**阴影**：原型阴影 opacity 全为 0（**扁平设计**），层级靠 border + 背景色差区分，不引入投影。

**共存与迁移纪律**：

1. 新页面（项目管理/设置/文件编辑器）只消费 tokens.css + 原型组件类（tab-nav / prop-table / doctor-table / card / btn 等），禁止引入 Element Plus；
2. 既有三页过渡期保留 Element Plus dark，以页面为界，禁止同页混用两套体系；
3. 阶段 2b 迁移完成后从 vendor 卸载 Element Plus；
4. 3D 图谱（three.js / graph-3d）配色改用 `--chart-1~5` 与 `--border` 等 token，在 2b 一并调整。

---

## 附录 A：PI 本体相关源码引用

| 文件 | 用途 |
|---|---|
| [pi-ex/packages/coding-agent/docs/extensions.md](../../pi-ex/packages/coding-agent/docs/extensions.md) | PI 扩展机制文档 |
| [pi-ex/packages/coding-agent/docs/skills.md](../../pi-ex/packages/coding-agent/docs/skills.md) | PI skills 机制文档 |
| [pi-ex/packages/coding-agent/docs/settings.md](../../pi-ex/packages/coding-agent/docs/settings.md) | PI settings.json 配置文档 |
| [pi-ex/packages/coding-agent/src/cli/args.ts](../../pi-ex/packages/coding-agent/src/cli/args.ts) | PI CLI 参数定义（含 `-e` / `--no-extensions` / `--exclude-tools`） |

## 附录 B：现有 narrative-engine 关键文件索引

| 类别 | 文件 |
|---|---|
| 扩展装配 | [src/index.ts](../../narrative-engine/src/index.ts) |
| 工具注册 | [src/tools/](../../narrative-engine/src/tools) 6 个域文件 |
| LLM 调用 | [src/planner-llm.ts](../../narrative-engine/src/planner-llm.ts) 等 5 个 |
| 业务子包 | [packages/world-graph](../../narrative-engine/packages/world-graph) 等 5 个 |
| 项目管理后端 | [packages/novel-launcher](../../narrative-engine/packages/novel-launcher) |
| 配置管理后端 | [packages/admin](../../narrative-engine/packages/admin) |
| 世界图可视化 | [src/visualizer/](../../narrative-engine/src/visualizer) |
| 前端 UI | [visualizer-ui/](../../narrative-engine/visualizer-ui) |
| 脚本 | [scripts/](../../narrative-engine/scripts) |
| 模板 | [templates/novel/](../../narrative-engine/templates/novel) |
