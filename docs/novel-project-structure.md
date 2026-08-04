# 小说工程结构定义

> **版本**: v2（2026-08-05）
> **落地**: `scripts/init-novel.mjs`（脚手架，可选）+ `templates/novel/`（模板）+ Web UI「项目管理」创建
> **来源**: 核对项 7（`docs/audits/2026-07-25-requirements-audit.md`）Q1/Q2 的解决方案；
> v2 同步 pure-SDK 迁移后的实际配置结构（删除 `.pi/extensions/` / sync / extension 字段）。

## 1. 什么是一个小说工程

一个**自包含目录**——创作内容、引擎运行时数据、项目约定同仓库共存。引擎以独立 HTTP 服务
（`node scripts/app-server.mjs`）运行，通过 `ProjectRegistry` 打开/激活项目目录即获得完整叙事能力。
不再依赖 pi 本体或项目级扩展自动发现机制（扩展模式已废弃，详见根 [README.md](../README.md#扩展模式已废弃)）。

## 2. 目录结构

```
<novel-root>/
├── novel.json              # 项目清单（唯一权威的项目约定声明）
├── README.md               # 项目说明
├── 正文/                   # 章节文件：第<N>章-<标题>.md（锚点格式见 renderer 约定）
│   └── .gitkeep
├── 规则集.md               # 渲染器规则（每次渲染注入用户消息末尾）
├── planner 规则集.md       # 调度器 planner LLM 检索规则
├── 角色规则集.md           # 角色池扮演规则（注入 system prompt）
├── .gitignore
└── .pi/
    ├── world-graph-v3/     # 世界图（git 跟踪）
    │   ├── world.db        #   SQLite（bi-temporal 节点 + FTS5 + 向量索引）
    │   ├── events.jsonl    #   事件日志（因果链可回溯）
    │   └── memory.md       #   项目记忆（引擎自动维护，勿手改：当前 storyTime/在场角色/最近事件含口述原文）
    └── scheduler-plans/    # plan 缓存（TTL 1h，gitignore）
```

> v2 变更：删除了 `.pi/extensions/`（扩展同步产物目录）。扩展模式已废弃，
> 引擎不再向项目目录同步扩展代码，项目初始化无需 `npm install` 编译原生模块。

## 3. novel.json（项目清单）

| 字段 | 说明 |
|------|------|
| `name` | 项目名 |
| `engine` / `engineVersion` | 引擎标识与版本（模板缺省 `narrative-engine` / `0.1.0`） |
| `worldGraphDir` | 世界图目录（相对项目根，缺省 `.pi/world-graph-v3`） |
| `chaptersDir` | 章节目录（缺省 `正文`） |
| `storyTimeFormat` | storyTime 格式约定（`ch{NNN}.ev{NNN}`：ch+3 位零填充=章节号，.ev+3 位零填充=章内事件序号；同章内 ev+1，进新章 ch+1 且 ev 从 001 开始；零填充保证字典序==时序） |
| `createdAt` | 初始化日期（YYYY-MM-DD） |

> novel.json 由 `@pi/admin` 的 `readNovelJson` / `writeNovelJson` 读写（缺失字段填默认值，
> 允许未知扩展字段）。`@pi/novel-launcher` 的 `getProjectMeta` 同源解析为 `NovelProjectMeta`。

## 4. git 跟踪策略

| 入库 | 不入库 |
|------|--------|
| 世界图（world.db + events.jsonl） | `*.db-shm` / `*.db-wal`（SQLite 瞬态文件） |
| 章节文件、规则集、novel.json | `.pi/scheduler-plans/`（临时缓存） |
| `memory.md`（项目记忆） | `.env`（含 HF_ENDPOINT / PI_DEBUG 等，由 @pi/admin 管理） |

## 5. 初始化流程

### 方式一：Web UI 创建（推荐）

```bash
cd narrative-engine
node scripts/app-server.mjs --port 7421
```

浏览器访问 `http://127.0.0.1:7421`，在「项目管理」页创建新项目：

1. 选择目标父目录 + 填写项目名
2. 引擎调用脚手架创建目录骨架（`正文/` / `.pi/world-graph-v3/`）+ 复制模板（novel.json / 规则集三件套 / .gitignore / README）
3. `ProjectRegistry.openProject({ allowInit: true })` 自动初始化空世界图（`world.db`）
4. 项目激活，可直接开始口述创作

**无 sync 步骤，无 `.pi/extensions/` 安装步骤**——扩展模式已废弃，项目目录是纯数据目录。

### 方式二：CLI 脚手架（批量/脚本场景）

```bash
cd narrative-engine
npm run init -- <目标目录> [--name <项目名>] [--force]
```

创建目录骨架 + 复制模板（`{{name}}` / `{{date}}` 变量替换）。幂等：已存在文件不覆盖（`--force` 强制）。
脚手架产物需在 Web UI 中激活（或 `node scripts/app-server.mjs --project <目录>` 启动时激活），
首次激活会自动初始化空世界图。

## 6. 多项目管理

`ProjectRegistry`（`src/app/project-registry.ts`）是**全局活跃项目注册表**：

- 按**目录绝对路径**缓存已打开的项目句柄（`ProjectHandle`：`wg` + `search` + `meta`），非活跃项目保持打开以支持快速切回
- 同时只有一个**活跃项目**（`getActive()` / `setActive(dir)`）；世界图 / files / admin 路由全部从 `getActive()` 取上下文
- 新建项目（无 `world.db`）在 `allowInit: true` 时自动初始化空库，使「新建项目 → 激活 → 创作」闭环
- `migrateProject(dir)`：项目数据库 schema 过旧时迁移（先备份 `world.db.bak-<ts>`，再 `WorldGraph.migrate`）
- 服务关闭时 `closeAll()` 释放全部 `WorldGraph` 句柄

Web UI「项目管理」页对应 `/api/projects/*` 端点（scan / open / activate / close / migrate），
全局可见已打开项目列表与活跃项目标记。

## 7. 应用级配置

引擎在平台应用数据目录维护一份**应用级配置**，与项目级 `novel.json` / `.env` 并行：

| 平台 | 路径 |
|------|------|
| Windows | `%APPDATA%\narrative-engine\app-config.json` |
| macOS | `~/Library/Application Support/narrative-engine/app-config.json` |
| Linux | `~/.config/narrative-engine/app-config.json` |

`app-config.json` 字段（由 `@pi/admin` 的 `readAppConfig` / `writeAppConfig` 读写，深层合并已知键）：

```jsonc
{
  "launcher": {
    "defaultScanRoots": [],          // 项目扫描默认根目录列表
    "lastProjectDir": null           // 最近激活的项目目录（启动恢复用；null = 无）
  },
  "embedder": {
    "model": "Xenova/bge-small-zh-v1.5"   // 向量模型（对应 PI_EMBEDDER_MODEL）
  },
  "llm": {
    "slots": {                       // slot → { provider, model } 映射（apiKey 不落盘于此）
      "planner":  { "provider": "deepseek", "model": "deepseek-v4-flash" },
      "role":     { "provider": "deepseek", "model": "deepseek-v4-flash" },
      "reasoning": { "provider": "deepseek", "model": "deepseek-v4-flash" },
      "renderer": { "provider": "deepseek", "model": "deepseek-v4-flash" }
      // "default": 未显式配置的 slot 回退到这里
    }
  },
  "scheduler": {
    "defaultMode": "plan"            // 编排默认执行模式（dispatch 未显式传 mode 时使用；plan / yolo）
  }
}
```

> v2 变更：删除了 v1 的 `extension` 字段（`mode` / `globalPath` / `useExplicitFlag` / `version` / `lastUpdated`）
> 与 `launcher.piExecutable`——扩展加载链路随 pure-SDK 转型删除。
> `writeAppConfig` 写入时剥离扩展时代废弃键，`readAppConfig` 保持宽松读取不受影响。

### 7.1 LLM 配置（5 slot 管理）

主会话与四阶段子代理（planner / role / reasoning / renderer）的 LLM 配置由
`LlmConfigStore`（`src/orchestrator/llm-config.ts`）统一管理，**5 个 slot**：

| slot | 用途 |
|------|------|
| `planner` | 调度器检索计划推导 |
| `role` | 角色扮演 |
| `reasoning` | 可见性推理（写扩散） |
| `renderer` | 渲染 |
| `default` | 兜底（未显式配置的 slot 回退到这里） |

**解析链**：slot 显式配置 → `default` slot → env 兜底（`NE_LLM_PROVIDER` / `NE_LLM_MODEL` / `NE_LLM_API_KEY` → provider 标准 env）。

**持久化**：

- `app-config.json` 的 `llm.slots` 仅存 `{ provider, model }`（slot → 模型映射）
- **API Key 不落盘 app-config**——权威存储为 `AuthStorage` 的 `auth.json`（与 pi SDK 同源），运行时经 `setRuntimeApiKey` 注入主会话，端点 `/api/admin/llm*` 不返回明文

**配置入口**：Web UI「设置 → 模型配置」页，可分别为每个 slot 选择 provider / model 并填入 API Key。

> v2 变更：v1 描述的 `DEEPSEEK_API_KEY` / `PI_MODEL` 供 `import_novel` 使用已废弃——
> 导入器与所有子代理统一走 `LlmConfigStore`，不再读这两个环境变量。

### 7.2 项目级 .env（扩展专属变量）

项目根 `.env` 由 `@pi/admin` 的 `env-store` 模块读写，仅管理**扩展专属变量**：

| 变量 | 说明 |
|------|------|
| `HF_ENDPOINT` | HuggingFace 镜像端点（向量模型下载用） |
| `PI_DEBUG` | 调试总线开关（`off` 禁用 span 埋点） |
| `PI_EMBEDDER_MODEL` | 向量模型覆盖（缺省 `Xenova/bge-small-zh-v1.5`） |

**不存 API Key**（API Key 由 `auth.json` / `LlmConfigStore` 管）。`writeEnvFile` 保留注释与未知字段，
原子写入。Web UI「设置 → 环境变量」页对应 `/api/admin/env` 端点。

### 7.3 与项目级配置的关系

- `novel.json` 描述**项目本身**（名称 / 世界图目录 / 章节目录 / storyTime 格式），每个项目独立
- `app-config.json` 描述**应用级偏好**（扫描根 / 上次项目 / 向量模型 / LLM slot 映射 / 默认执行模式），全局共享
- 项目级 `.env` 描述**项目级运行时变量**（HF 镜像 / 调试开关 / 向量模型覆盖），每项目独立
