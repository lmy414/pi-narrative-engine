# 版本与依赖

> 属于 [API 文档索引](README.md)。

| 依赖 | 版本 | 用途 |
|------|------|------|
| `underworld-graph` | `^0.1.0`（npm 独立包） | WorldGraph 类 + 类型（2026-07-31 从 monorepo 解耦独立发布） |
| `@nicia-ai/typegraph` | `0.40.0` | TypeGraph SDK（StoreSearch/QueryBuilder/searchable/embedding） |
| `@xenova/transformers` | latest | Xenova/bge-small-zh-v1.5 嵌入模型 |
| `better-sqlite3` | latest | SQLite 后端 |
| `sqlite-vec` | `^0.1.9` | SQLite 向量扩展 |
| `drizzle-orm` | latest | ORM |
| `zod` | `^4.0.0` | Schema 校验 |
| `typebox` | latest | PI 工具参数 schema |
| `@earendil-works/pi-ai` | `^0.77.0` | LLM 调用（novel-importer 阶段 2/3/5/6） |
| `epub2` / `xml2js` | latest | EPUB 解析（novel-importer 阶段 1） |
| `@pi/admin` | workspace 子包 | 应用级配置管理后端（env/rulesets/doctor/updater/files/app-config） |
| `@pi/novel-launcher` | workspace 子包 | 项目发现与跨平台启动 PI |
| `@pi/novel-importer` | workspace 子包 | V3 导入管道 |
| `@pi/renderer` | workspace 子包 | 渲染器 |
| `@pi/role-pool` | workspace 子包 | 角色池 |
| `@pi/scheduler` | workspace 子包 | 调度器 |
| `@tauri-apps/cli` | dev | Tauri 桌面应用脚手架与构建（仅 Tauri 桌面分发（G6 待办）时使用；当前 `package.json` 未列入 devDependencies） |
| `esbuild` | dev | unified-server 打包为 sidecar bundle |

**Graph Schema 初始化**：通过 `createStoreWithSchema`（异步 factory），自动建表/初始化 schema/迁移。默认 `systemIndexes: "materialize"`，无需手动调用 `materializeIndexes()` 或 `rebuildFulltext()`。

**workspace 子包结构**：
- `packages/world-graph/` — ~~`underworld-graph`~~（已解耦为独立 npm 包，目录已移除）
- `packages/novel-importer/` — `@pi/novel-importer`（V3 导入管道）
- `packages/renderer/` — `@pi/renderer`（渲染器子包）
- `packages/role-pool/` — `@pi/role-pool`（角色池子包）
- `packages/scheduler/` — `@pi/scheduler`（调度器子包）
- `packages/admin/` — `@pi/admin`（应用级配置管理后端）
- `packages/novel-launcher/` — `@pi/novel-launcher`（项目发现与启动 PI）
- `src/app/` — unified-server 应用化统一服务入口
- `src/` — narrative-engine 独立应用源码（app/orchestrator/visualizer/debug 等模块）
