# 小说工程结构定义

> **版本**: v1（2026-07-25）
> **落地**: `scripts/init-novel.mjs`（脚手架）+ `templates/novel/`（模板）
> **来源**: 核对项 7（`docs/audits/2026-07-25-requirements-audit.md`）Q1/Q2 的解决方案

## 1. 什么是一个小说工程

一个**自包含目录**——创作内容、引擎运行时数据、项目约定同仓库共存。pi 在该目录启动即获得完整叙事能力（项目级扩展自动发现 `.pi/extensions/`）。

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
    ├── extensions/         # 引擎扩展（sync 产物，gitignore）
    │   └── narrative-engine/
    ├── world-graph-v3/     # 世界图（git 跟踪）
    │   ├── world.db        #   SQLite（bi-temporal 节点 + FTS5 + 向量索引）
    │   ├── events.jsonl    #   事件日志（因果链可回溯）
    │   └── memory.md       #   项目记忆（引擎自动维护，勿手改：当前 storyTime/在场角色/最近事件含口述原文）
    └── scheduler-plans/    # plan 缓存（TTL 1h，gitignore）
```

## 3. novel.json（项目清单）

| 字段 | 说明 |
|------|------|
| `name` | 项目名 |
| `engine` / `engineVersion` | 引擎标识与版本 |
| `worldGraphDir` | 世界图目录（相对项目根，缺省 `.pi/world-graph-v3`） |
| `chaptersDir` | 章节目录（缺省 `正文`） |
| `storyTimeFormat` | storyTime 格式约定（`ch{NNN}.ev{NNN}`：ch+3 位零填充=章节号，.ev+3 位零填充=章内事件序号；同章内 ev+1，进新章 ch+1 且 ev 从 001 开始；零填充保证字典序==时序） |
| `createdAt` | 初始化日期 |

> **注意**：v1 的引擎代码尚未读取 novel.json（路径仍硬编码）。清单是"约定先行"，
> 后续迭代让 resolveWorldGraphDir / chapter-resolver 等改为读清单。

## 4. git 跟踪策略

| 入库 | 不入库 |
|------|--------|
| 世界图（world.db + events.jsonl） | `.pi/extensions/`（sync 产物） |
| 章节文件、规则集、novel.json | `*.db-shm` / `*.db-wal`（瞬态） |
| | `.pi/scheduler-plans/`（临时缓存） |

## 5. 初始化流程

```bash
cd narrative-engine
npm run init -- <目标目录> [--name <项目名>] [--force] [--skip-extension]
```

1. 创建目录骨架（正文/、.pi/extensions/、.pi/world-graph-v3/）
2. 复制模板（novel.json / 规则集三件套 / .gitignore / README.md），替换 `{{name}}` `{{date}}`
3. 缺省同步引擎扩展（调用 sync.mjs；`--skip-extension` 跳过）
4. 幂等：已存在文件不覆盖（`--force` 强制）

**初始化后手动一步**：`cd <目录>/.pi/extensions/narrative-engine && npm install`
（better-sqlite3 原生模块编译，sync 不复制 node_modules）

## 6. 多项目管理

无全局注册表：每个小说工程是独立目录，`cd <dir> && pi` 即用。引擎会话内所有路径以 `ctx.cwd`（= 项目根）为锚解析。

## 7. 应用级配置（v0.1.0-alpha.1 应用化后）

应用内置模式下，Tauri 应用在平台应用数据目录维护一份**应用级配置**，与项目级 `novel.json` / `.env` 并行：

| 平台 | 路径 |
|------|------|
| Windows | `%APPDATA%\narrative-engine\app-config.json` |
| macOS | `~/Library/Application Support/narrative-engine/app-config.json` |
| Linux | `~/.config/narrative-engine/app-config.json` |

`app-config.json` 字段（详见 [api.md](api.md) §11.5 与 [app-mode.md](app-mode.md) §4）：

```json
{
  "extension": {
    "mode": "enabled",
    "globalPath": "%APPDATA%\\narrative-engine\\extensions\\narrative-engine",
    "useExplicitFlag": true,
    "version": "0.1.0-alpha.1",
    "lastUpdated": "2026-07-30T12:00:00.000Z"
  },
  "launcher": {
    "piExecutable": "pi",
    "defaultScanRoots": []
  },
  "embedder": {
    "model": "Xenova/bge-small-zh-v1.5"
  }
}
```

**与项目级配置的关系**：
- `novel.json` 描述项目本身（名称/路径/世界图目录），每个项目独立
- `app-config.json` 描述应用级偏好（扩展加载策略/PI 路径/扫描根），全局共享
- 项目级 `.env`（`DEEPSEEK_API_KEY` / `PI_MODEL` 等）仍由 PI 本体读取，应用级配置不覆盖
- 应用内置模式下，PI 启动参数由 `app-config.json` 的 `extension.mode` + `useExplicitFlag` 决定（详见 [app-mode.md](app-mode.md) §4.3）
