# Narrative Engine API 文档索引

> **适用分支**: `master`
> **最后更新**: 2026-07-31（应用化 + 调试管线 + 软隔离导出整理后拆分重排）
>
> 本文档为 API 参考的总入口。原先单文件 `docs/api.md`（2000+ 行）已按主题拆分为多个小文档，
> 便于按需阅读（AI 友好：一次只加载相关部分）。

## 文档结构

### 基础概念（先读）

| 文档 | 内容 |
|------|------|
| [overview.md](overview.md) | 架构概览（扩展装配 / 应用化运行模式 / 核心依赖）、存储路径、storyTime 管理约定 |

### PI 扩展工具（31 个，按工具域拆分）

| 文档 | 工具 | 数量 |
|------|------|------|
| [pi-tools-world.md](pi-tools-world.md) | `world_*` 18 个 + `open_visualizer` | 19 |
| [pi-tools-render.md](pi-tools-render.md) | `render_append` / `render_modify` / `render_preview` / `render_check` / `render_rule_set` | 5 |
| [pi-tools-role-scheduler.md](pi-tools-role-scheduler.md) | `role_interact` / `role_rule_set` + `scheduler_dispatch` / `scheduler_commit` / `scheduler_discard` | 5 |
| [pi-tools-import.md](pi-tools-import.md) | `import_novel` / `import_character_card` | 2 |

### 子包 API

| 文档 | 包 | 说明 |
|------|------|------|
| [world-graph.md](world-graph.md) | `underworld-graph`（npm 独立包 v0.1.x） | WorldGraph 类 + Zod schema 类型 |
| [novel-importer.md](novel-importer.md) | `@pi/novel-importer` | V3 导入管道（仅 `runImportPipeline` 为公共 API） |
| [renderer.md](renderer.md) | `@pi/renderer` | 渲染器（规则集注入 + 锚点章节格式） |
| [role-pool.md](role-pool.md) | `@pi/role-pool` | 角色池串行演绎 |
| [scheduler.md](scheduler.md) | `@pi/scheduler` | 调度器（plan/commit/discard 编排） |

### 核心类与检索

| 文档 | 内容 |
|------|------|
| [core-classes.md](core-classes.md) | `Search` 类（SDK StoreSearch 薄包装）+ `Embedder` 类（Xenova 向量化） |
| [sdk-search.md](sdk-search.md) | `@nicia-ai/typegraph` 检索能力（searchable/embedding 字段、StoreSearch、QueryBuilder） |
| [types.md](types.md) | 类型定义（EntityType / Modality / EventType / StateDeclaration / EntitySnapshot / EventRecord / VisibilityDeclaration） |

### HTTP 服务

| 文档 | 内容 |
|------|------|
| [visualizer.md](visualizer.md) | 可视化服务：三入口（pi 会话 / standalone / 应用）+ HTTP JSON API（含错误码）+ 前端 `visualizer-ui` |
| [unified-server.md](unified-server.md) | 统一服务（应用化）：`startUnifiedServer` + `ProjectRegistry` 多项目 + `/api/files|projects|admin` 扩展端点 + `@pi/admin` / `@pi/novel-launcher` 子包 |
| [chat.md](chat.md) | 主会话聊天 API：`MainSessionHost`（PI SDK）+ `ChatContext` + `/api/chat/message|events|status`（SSE 事件流契约） |
| [debug-bus.md](debug-bus.md) | 调试模块（DebugBus / SSE / startSpan 埋点） |

### 附录

| 文档 | 内容 |
|------|------|
| [dependencies.md](dependencies.md) | 版本与依赖、Graph Schema 初始化、workspace 子包结构 |

## 阅读建议

- **写工具（主会话/scheduler 开发者）**：先读 overview.md，再按工具域读 pi-tools-*.md
- **子包二次开发**：直接读对应子包文档，导出面已按软隔离约定标注（`_` 前缀 = 内部实现）
- **前端/桌面应用**：读 visualizer.md + unified-server.md + debug-bus.md
- **了解存储与检索模型**：读 overview.md §2/§3 + world-graph.md + sdk-search.md
