# API 概览：架构 / 存储 / storyTime 约定

> 属于 [API 文档索引](README.md)。本文覆盖：架构概览（扩展装配 + 应用化运行模式 + 核心依赖）、存储路径、storyTime 管理约定。

## 1. 架构概览

```
┌──────────────────────────────────────────────────────────┐
│  narrative-engine 独立应用（pure-SDK 形态）              │
│  src/app/main.ts → startUnifiedServer + pi SDK 主会话    │
│  - MainSessionHost 驱动主会话（无 pi.registerTool 注册） │
│  - 编排四阶段：planner / role / reasoner / renderer      │
│  - session 级 currentStoryTime 管理                      │
└────┬────────────┬──────────────┬─────────────────────────┘
     │            │              │
     ▼            ▼              ▼
┌─────────┐ ┌──────────┐ ┌──────────────────────────┐
│ Embedder│ │  Search  │ │  underworld-graph         │
│ (Xenova)│ │ (SDK 薄) │ │  - WorldGraph 类         │
│ 512 维  │ │  包装)   │ │  - EntitySnapshot        │
│ bge-zh  │ │          │ │  - StateDeclaration      │
└────┬────┘ └────┬─────┘ │  - EventLog              │
     │           │       └──────────┬───────────────┘
     │           │                  │
     ├───────────┴──────────────────┘
     │
     ▼
┌──────────────────────────────┐    ┌──────────────────────────────┐
│ @nicia-ai/typegraph@0.40.0   │    │ @pi/novel-importer           │
│ - StoreSearch (fulltext/vec) │    │ - runImportPipeline (8 阶段) │
│ - QueryBuilder               │    │ - resolveEntities (消解)     │
│ - searchable()/embedding()   │    │ - writeToGraph (写入)        │
│ - sqliteVecStrategy          │    │ - validateGraph (校验)       │
└──────────────────────────────┘    └──────────────────────────────┘
```

应用化运行模式（独立 HTTP 服务，端口 7421，仅监听 127.0.0.1）：

```
┌──────────────────────────────────────────────────────────┐
│  src/app/unified-server.ts (startUnifiedServer)          │
│  - 单端口整合 world-graph + files + projects + admin     │
│  - 静态服务 frontend-demo                                │
│  - ProjectRegistry 多项目句柄隔离（按目录缓存 wg 句柄）  │
└────┬────────────┬──────────────┬─────────────────────────┘
     │            │              │
     ▼            ▼              ▼
┌─────────────┐ ┌────────────────────────────────────┐ ┌──────────────────────────┐
│ @pi/admin   │ │ @pi/novel-launcher                  │ │ world-graph 路由          │
│ - files     │ │ 公开 API：                          │ │ (复用 src/visualizer/     │
│ - rulesets  │ │ - discoverProjects                  │ │  routes.ts)               │
│ - doctor    │ │ - getProjectMeta                    │ │ - /api/graph /api/search  │
│ - updater   │ │ - probeWorldDb                      │ │   /api/events ...         │
│ - app-config│ │ - createProject                     │ │ + /api/debug/* (可选)     │
│             │ │ - openInFileManager                 │ │                          │
└─────────────┘ └────────────────────────────────────┘ └──────────────────────────┘
```

**核心依赖**：
- `@nicia-ai/typegraph@0.40.0` — TypeGraph SDK（StoreSearch + QueryBuilder + searchable/embedding 字段装饰器）
- `@xenova/transformers` — Xenova/bge-small-zh-v1.5 本地嵌入模型（512 维）
- `better-sqlite3` + `drizzle-orm` — SQLite 后端（WAL 模式）
- `sqlite-vec` — SQLite 向量扩展（cosine 相似度）
- `zod@^4.0.0` — Schema 校验
- `typebox` — PI 工具参数 schema

## 2. 存储路径

### 2.1 运行时目录（world_* / scheduler_* 工具）

默认路径：`<cwd>/.pi/world-graph-v3/`（2026-07-25 起与导入目录统一，原为 v2）

| 文件 | 用途 |
|------|------|
| `world.db` | SQLite 数据库（Entity/Fact/Relation/Visibility 节点 + fulltext/vector 索引） |
| `events.jsonl` | 事件日志（JSONL 格式，每行一条 EventRecord） |
| `memory.md` | 跨会话项目记忆（2026-07-25 新增；引擎自动维护，勿手改：当前 storyTime / 在场角色 / 最近事件含口述原文） |

### 2.2 导入目录（import_novel 工具）

默认路径：`<cwd>/.pi/world-graph-v3/`

| 文件 | 用途 |
|------|------|
| `world.db` | SQLite 数据库（同上，但由导入管道写入） |
| `events.jsonl` | 事件日志（由导入管道从章节事件流生成） |
| `chapter-index.json` | 章节元数据索引（章节 ID → 标题/事件数等） |
| `alias-index.json` | 别名索引（实体别名 → canonical entityId） |
| `_v3_dump.json` | 阶段 1-6 中间产物（含 narrative_summary/evidence 调试字段） |

### 2.3 目录关系

- ~~`world-graph-v2/` 与 `world-graph-v3/` 是两个独立的世界图实例~~（2026-07-25 前）
- **2026-07-25 起**：运行时与导入统一使用 `world-graph-v3/`（审计修复：此前运行时读 v2 空壳，导入数据运行时不可见）
- `world-graph-v2/` 与 `world-graph/`（V1）均为历史遗留，不再使用，数据不迁移
- 项目结构定义详见 `docs/novel-project-structure.md`

## 3. storyTime 管理约定

所有写入/查询操作都需要 `storyTime`（故事时间，字符串标识）。PI 工具层提供两种传参方式：

1. **显式传递**：调用工具时传 `storyTime` 参数
2. **隐式复用**：不传时使用 `currentStoryTime`（session 级状态）

`currentStoryTime` 更新规则：
- `session_start` 时**从事件日志恢复**（全部事件中的最大 storyTime；空项目为 `null`）——跨会话不丢时间锚点（2026-07-25 项目记忆修复）
- `world_event_apply` / `world_entity_create` / `world_entity_kill` 时更新为事件/操作的 `storyTime`
- `scheduler_dispatch` 时推进（2026-07-25 修复：**只前进不后退**——`storyTime > currentStoryTime` 才更新，modify/insert 锚定历史不会回拉）
- 其他工具（如 `world_entity_get`、`world_query`）不更新

**storyTime 格式**（2026-07-25 统一约定，全项目唯一权威定义见 `src/orchestrator/mcp-server.ts` 的 `scheduler_dispatch` 工具参数描述；正则 `STORY_TIME_PATTERN` 位于 `src/chat/scheduler-tools.ts`）：
- 标准格式：`ch{NNN}.ev{NNN}`（如 `ch009.ev003`）——`ch`+3 位零填充=章节号，`.ev`+3 位零填充=章内事件序号
- 推进规则：同章内 ev+1；进新章 ch+1 且 ev 从 001 开始；零填充保证字典序==故事时序
- 旧格式（如 `ch-2`）字符串比较仍兼容，但新写作请用标准格式
- 章节路径解析（`resolveChapterPath`）取章节号定位 `正文/第<N>章-*.md`
- **调度器入口强制校验**（2026-07-30 H3）：`scheduler_dispatch` 拒绝 `ch-<N>` 等非法格式（会导致 `ch-10 < ch-2` 时序错乱）

如果 `currentStoryTime` 为 `null` 且工具需要 storyTime，会抛错：
```
Error: storyTime required (call world_event_apply first or pass storyTime explicitly)
```

### 主会话 prompt 与项目记忆

- **主会话 prompt**：在 `src/chat/main-session.ts` 中构建（通过 `.pi/SYSTEM.md` 自动发现，由 `DefaultResourceLoader` 加载；代码不硬编码提示词）。原 `src/prompts/main-session.md` + `engine-guide.md` 与 `src/skills/narrative-engine/SKILL.md` 的 skill 注入机制已随扩展模式废弃。
- 项目记忆 `memory.md` 仍强制注入 systemPrompt 末尾（每轮重读）。
- 运行时数据详见 `docs/novel-project-structure.md`。
