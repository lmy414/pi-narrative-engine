# narrative-engine

> AI 驱动的小说创作工作台：世界图（bi-temporal）+ 角色池 + 调度器 + 渲染器。
> 用口述驱动创作——引擎维护世界状态，角色按信息差扮演，正文自动渲染。

[![test](https://github.com/lmy414/pi-narrative-engine/actions/workflows/test.yml/badge.svg)](https://github.com/lmy414/pi-narrative-engine/actions/workflows/test.yml)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
[![version](https://img.shields.io/badge/version-0.1.0--alpha.1-orange.svg)](CHANGELOG.md)

---

## 它解决什么问题

传统 AI 写小说的痛点：AI 不记得上周写了什么、角色知道什么不知道什么全靠脑补、世界状态散落在对话里越聊越乱。

narrative-engine 把这些全部结构化：

- **世界图**（bi-temporal SQLite）：实体、事实、关系、可见性——每个角色"知道什么"是结构而非扮演
- **信息差**：每个角色只拿到自己可见的世界条目子集，不知道的事就是不知道
- **调度器**：口述 → 检索计划 → 角色串行扮演 → 可见推理写回世界图 → 渲染器生成正文
- **章节文件**：正文自动锚点写入章节文件，不覆盖已有内容

```
你口述："彩叶推开咖啡厅的门，看到辉夜坐在角落"
        │
        ▼
主会话（pi SDK 同构）——意图理解 / 五要素补全
        │
        ▼
Orchestrator 编排器
  ├─ planner  ：推导检索计划，从世界图取角色该知道的
  ├─ role     ：每个角色带着自己的信息差独立扮演
  ├─ reasoner ：可见性推理，写回世界图
  └─ renderer ：读章节上下文，写正文到章节文件
```

## 快速开始

```bash
git clone git@github.com:lmy414/pi-narrative-engine.git
cd narrative-engine
npm install          # 含 better-sqlite3 原生模块编译
npm run build        # src/*.ts → dist/（esbuild transform-only）

node scripts/app-server.mjs [--project <dir>] [--port 7421] [--embed]
```

浏览器打开 `http://127.0.0.1:7421`，在「项目管理」创建或打开小说项目。

| 参数 | 说明 |
|------|------|
| `--project <dir>` | 启动时激活指定项目（缺省恢复上次项目） |
| `--port <N>` | 监听端口（缺省 7421） |
| `--embed` | 加载向量模型启用 hybrid 检索（缺省 fulltext） |
| `--config-dir <dir>` | 应用配置目录（测试/冒烟隔离用） |

首次使用：前往「设置 → 模型配置」为各 slot（planner / role / reasoning / renderer / default）
配置 provider + model + API Key。API Key 存储在 `auth.json`，不落盘 app-config。

> ⚠️ **导入器为测试实现**：`import_novel`（EPUB 导入）与 `import_character_card`（酒馆卡导入）
> 验证了功能链路但不保证数据质量，后续将重写。

## 架构

独立 HTTP 服务 + pi SDK 主会话，不依赖 pi 本体运行。

**单一运行时**（2026-08-12 统一代理抽象，`bd52c18`）：主会话与四个子代理共用同一
`AgentSession`（pi-coding-agent）运行时，仅行为（prompt 与工具集）不同。子代理继承
`BaseAgent`；**编排器是纯代码协调层，不继承 `BaseAgent`**。

```
src/app/main.ts（入口：CLI 参数解析 + 配置水合）
  │
  ├─ startUnifiedServer（src/app/unified-server.ts）
  │    HTTP 服务（默认 127.0.0.1:7421），承载 7 类路由：
  │    · 编排控制  /api/scheduler/dispatch|commit|discard|status|mode|plans
  │    · 历史会话  /api/chat/sessions(+/:id/messages|activate) + message/events/status/abort
  │    · 世界图    /api/graph|status|entities/*（复用 src/visualizer/routes.ts）
  │    · 项目管理  /api/projects/*（@pi/novel-launcher + ProjectRegistry）
  │    · 配置管理  /api/admin/llm*|rulesets|config|app-config|novel-json|doctor|version|embedder（@pi/admin）
  │    · 调试总线  /api/debug/stream|events|clear
  │    · 静态伺服  frontend-demo/（无构建步骤）
  │
  ├─ MainSessionHost（src/chat/main-session.ts）
  │    pi SDK 主会话（持久多轮，流式，前端 HTTP 驱动）
  │    实现 ModelResolver（模型/Key 解析），不继承 BaseAgent
  │
  ├─ AgentRuntime（src/agents/agent-runtime.ts）
  │    ModelResolver + {createSession, driveToReply} 一次性会话运行时
  │    LlmConfigStoreRuntime 实现（包装 LlmConfigStore，供子代理）
  │
  ├─ BaseAgent<TInput,TOutput>（src/agents/base-agent.ts，仅子代理继承）
  │    PlannerAgent / RoleAgent / ReasoningAgent / RendererAgent
  │    统一 run()：buildSessionRequest → createSession → driveToReply → extractOutput
  │    产出 = 指令性 prompt 收尾 + fenced JSON 解析（非 terminate 工具）
  │
  ├─ WorldGraphDataAccess（src/data/world-graph-data-access.ts）
  │    统一世界图数据管道：主会话 / 子代理工具共用一套读写收口
  │
  └─ Orchestrator（src/orchestrator.ts，纯代码编排器，非 LLM）
       plan/yolo 双模式，编排四阶段子代理（new XxxAgent(runtime, deps).run(...)）：
         planner  → 检索计划推导（注入世界图只读工具）
         role     → 角色串行扮演（注入角色可见性受限工具）
         reasoner → 可见性推理，自主写世界图
         renderer → 读章节上下文，写正文到章节文件
```

### commit 异步化（BUG-014）

commit 不再同步执行，而是入队即返回 `{ ok, planId, queueId, status: "committing" }`。
plan 状态机：`confirmed → committing → committed | error`。
重复 commit 返回 409 `COMMIT_IN_PROGRESS`；已提交返回 410 `PLAN_ALREADY_COMMITTED`。
前端通过轮询 `GET /api/scheduler/plans/:id` 的 `status` 字段跟踪进度。

## 目录结构

```
narrative-engine/
├── src/
│   ├── app/              # 应用入口与 HTTP 服务
│   │   ├── main.ts           # CLI 入口（参数解析 + 配置水合 + 启动）
│   │   ├── unified-server.ts # 统一 HTTP 服务（7 类路由 + 静态伺服）
│   │   ├── chat-context.ts   # 主会话上下文装配（HistoricalChatMessage 等）
│   │   ├── routes-chat.ts    # /api/chat/* 路由
│   │   ├── routes-scheduler.ts # /api/scheduler/* 路由
│   │   ├── routes-ext.ts     # /api/admin/* /api/files/* 等扩展路由
│   │   ├── project-registry.ts # 全局活跃项目注册表
│   │   ├── startup-project.ts  # 启动恢复上次项目
│   │   └── llm-resolver.ts    # LLM 配置解析
│   ├── orchestrator/     # 编排器服务层
│   │   ├── service.ts         # OrchestratorService（plan 缓存 + commit 状态机）
│   │   ├── assembly.ts        # OrchestratorPorts 装配
│   │   ├── llm-config.ts      # LlmConfigStore（5 slot 模型配置，LlmSlot 类型）
│   │   └── mcp-server.ts      # MCP 工具服务器
│   ├── agents/           # 统一代理抽象 + 四子代理（2026-08-12 重构）
│   │   ├── agent-runtime.ts   # AgentRuntime/ModelResolver/AgentReply/SessionRequest
│   │   │                      #   + SubagentResourceLoader + LlmConfigStoreRuntime + extractFencedJson
│   │   ├── base-agent.ts      # BaseAgent 抽象类（统一 run() 流程 + 指令收尾纪律）
│   │   ├── planner-agent.ts   # PlannerAgent extends BaseAgent
│   │   ├── role-agent.ts      # RoleAgent extends BaseAgent
│   │   ├── reasoning-agent.ts # ReasoningAgent extends BaseAgent
│   │   ├── renderer-agent.ts  # RendererAgent extends BaseAgent
│   │   ├── world-tools.ts     # 世界图工具（共用 DataAccess 收口）
│   │   ├── chapter-tools.ts   # 章节读写工具
│   │   ├── rules-tools.ts     # rules_read 工具（规则渐进披露 D11）
│   │   └── tools.ts           # 产出 schema（terminate 工具已废弃，schema 供 extractOutput 校验）
│   ├── chat/             # 主会话宿主与工具
│   │   ├── main-session.ts    # MainSessionHost（pi SDK 主会话，implements ModelResolver）
│   │   ├── agent-tool-adapter.ts # AgentTool → ToolDefinition 适配
│   │   ├── scheduler-tools.ts # scheduler_dispatch/commit/discard/queue_status 工具
│   │   ├── render-tools.ts    # render_* 工具
│   │   ├── role-tools.ts      # role_* 工具
│   │   ├── import-tools.ts    # import_novel / import_character_card 工具
│   │   ├── import-card.ts     # 酒馆卡解析
│   │   └── session-pool.ts    # 会话池
│   ├── data/             # 统一数据管道
│   │   └── world-graph-data-access.ts # WorldGraphDataAccess（主会话/子代理共用读写收口）
│   ├── visualizer/       # 世界图可视化
│   │   ├── routes.ts          # HTTP 路由（含 history events 关联查询）
│   │   └── server.ts          # standalone 模式入口
│   ├── debug/            # 调试总线
│   │   ├── bus.ts             # 环形缓冲 + span API
│   │   ├── sse.ts             # SSE 推送
│   │   └── types.ts           # DebugEvent 类型
│   ├── ports/            # 数据层 Ports（解耦编排器与世界图实现）
│   │   ├── types.ts           # Ports 接口
│   │   └── adapters.ts        # 适配器
│   ├── orchestrator.ts   # Orchestrator 类（纯代码编排四阶段，不继承 BaseAgent）
│   ├── event-queue.ts    # 通用任务队列（event 调度 + commit 异步执行）
│   ├── embedder.ts       # 向量模型封装（@xenova/transformers）
│   ├── search.ts         # 检索（fulltext / vector / hybrid）
│   ├── checker.ts        # 规则集校验
│   ├── planner-rule-loader.ts
│   └── path-guard.ts
├── packages/             # Workspace 子包
│   ├── admin/            # @pi/admin 应用配置后端
│   ├── scheduler/        # @pi/scheduler 调度器
│   ├── role-pool/        # @pi/role-pool 角色池
│   ├── renderer/         # @pi/renderer 渲染器
│   ├── novel-importer/   # @pi/novel-importer EPUB 导入器（⚠️ 测试实现）
│   └── novel-launcher/   # @pi/novel-launcher 项目发现
├── frontend-demo/        # 可视化前端（原生 JS，无构建步骤）
│   ├── views/            # 8 个视图（projects/graph/events/studio/debug/files/settings/entity-detail）
│   ├── styles/           # 4 个 CSS（tokens/shell/components/views）
│   ├── vendor/           # 6 个第三方库（tailwind/lucide/3d-force-graph/three/marked/dompurify）
│   ├── api-client.js     # API 客户端（含 mock 模式）
│   ├── api-mock.js       # Mock 数据
│   ├── mock-data.js      # Mock 种子
│   ├── demo-utils.js     # 工具函数
│   ├── app.js            # 路由与全局状态
│   └── index.html        # 入口
├── docs/                 # 文档（总索引见 docs/README.md）
├── scripts/              # 脚本（app-server / build / doctor / init-novel / smoke）
├── templates/novel/      # 小说工程脚手架模板
├── tests/                # 根级测试（含 tests/debug/）
├── tauri-app/            # Tauri 桌面入口（G6 待办，未发布）
└── package.json
```

## 开发

```bash
npm run build              # src/*.ts → dist/（esbuild transform-only）
npm test                   # 全量单测（645 用例，含 packages/* + tests/* + tests/debug/*）
npm run test:packages      # 仅子包单测
npm run test:root          # 仅根 tests/ 单测
npm run doctor             # 环境自检
npm run init -- <目录>     # 初始化小说工程骨架
```

### 子包单测（全 mock，无需 API key）

```bash
cd packages/<子包> && npx tsx --test tests/*.test.ts
```

### CI

`.github/workflows/test.yml`：ubuntu / windows / macos × node 22 / 24。
Node 20 已 EOL，且 pi-coding-agent 的 undici 依赖 Node≥22 内部 API。

**分支策略**：改动走 `<YYYYMMDD>-<描述>` 分支，禁止直接在 master 上 commit。
详见 [AGENTS.md](../AGENTS.md)。

## 子包

| 包 | 职责 |
|---|------|
| `underworld-graph` | bi-temporal 世界图（SQLite + FTS5 + 向量）— **外部 npm 包**（独立仓库，v0.3.x） |
| `@pi/scheduler` | 调度器：检索计划 → 角色编排 → 写扩散 + 渲染 |
| `@pi/role-pool` | 角色池：串行扮演，酒馆卡静态层 + 动态事实注入 |
| `@pi/renderer` | 渲染器：结构化输出 → 规则集约束正文，锚点写盘 |
| `@pi/novel-importer` | EPUB → 世界图（8 阶段管道）⚠️ 测试实现 |
| `@pi/admin` | 应用级配置管理（app-config / env-store / rulesets / doctor / files） |
| `@pi/novel-launcher` | 项目发现与元信息解析 |

## 技术栈

- **后端**：Node.js ≥22 + TypeScript（esbuild transform-only，无 bundler）
- **前端**：原生 JS（无框架）+ Tailwind CSS 4 + Lucide Icons + 3d-force-graph + three.js
- **世界图**：SQLite + FTS5 + 向量检索（@xenova/transformers）
- **AI**：pi SDK（@earendil-works/pi-agent-core / pi-ai / pi-coding-agent）
- **测试**：Node.js test runner（tsx --test），645 用例全 mock

## 扩展模式已废弃

narrative-engine **不再是 pi 的扩展**，而是直接依赖 pi SDK 的独立应用。以下机制均已删除：

- pi 扩展入口（`src/index.ts` + 31 个 `pi.registerTool` 工具）
- `npm run sync` / `npm run dev`（项目级扩展同步与监听）
- `.pi/extensions/` 同步产物机制
- Tauri 应用内置扩展快照 + 重装链路

Tauri 桌面分发为第二阶段 G6 待办，`tauri-app/` 目录为预留入口，尚未发布。

## 文档

| 文档 | 内容 |
|------|------|
| [docs/README.md](docs/README.md) | 文档总索引（现行 / 设计 / 历史归档） |
| [CHANGELOG.md](CHANGELOG.md) | 变更记录 |
| [docs/USAGE.md](docs/USAGE.md) | 使用手册（口述创作 / plan-yolo / 导入 / 规则集） |
| [docs/SETUP.md](docs/SETUP.md) | 部署指南 |
| [docs/novel-project-structure.md](docs/novel-project-structure.md) | 小说工程结构定义 v2 |
| [docs/api/README.md](docs/api/README.md) | API 参考总入口 |
| [docs/frontend-requirements.md](docs/frontend-requirements.md) | 前端目标规格 v2.1 |
| [docs/THIRD-PARTY.md](docs/THIRD-PARTY.md) | 第三方依赖盘点 |

## License

[GPL-3.0](LICENSE) © 2026 lmy414
