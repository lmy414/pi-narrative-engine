# 小说工程结构定义

> **版本**: v3（2026-08-09 定案，2026-08-10 实施）
> **落地**: `packages/novel-launcher/src/project.ts`（脚手架）+ `templates/novel/`（模板）+ Web UI「项目管理」创建 + CLI `scripts/init-novel.mjs`
> **决策依据**: `docs/plans/2026-08-08-novel-project-structure-v3.md`（D10/D11/D12 用户定案）+ `docs/plans/2026-08-08-prompt-research.md`（D7/D8/D9 规则集决策）
> v3 变更：项目清单改名**小说.json**（兼容旧版 novel.json）；粒度统一**一章一 .md**（事件锚点分段，消灭事件级双轨）；新增内容区域（笔记/草稿/设定/大纲）；规则集迁入**规则集/ 文件夹**（文风/检查/自定义，planner/角色规则集收回引擎自维护）；git 管理规则（数据库方案 B 文本快照）。

## 1. 什么是一个小说工程

一个**自包含目录**——创作内容、引擎运行时数据、项目约定同仓库共存。引擎以独立 HTTP 服务
（`node scripts/app-server.mjs`）运行，**通过识别项目根目录的 `小说.json` 定位项目**
（旧版 `novel.json` 兼容读取）。通过 `ProjectRegistry` 打开/激活项目目录即获得完整叙事能力。

## 2. 目录结构

```
<novel-root>/
├── 小说.json              # 项目清单（唯一权威的项目约定声明；旧版 novel.json 兼容）
├── README.md              # 项目简介（用户口述的 Reme.md 即本文件）
├── .gitignore             # git 管理规则（创作资产入库、运行时数据排除）
├── 正文/                  # 章节文件：第<N>章-<标题>.md（一章一文件，事件锚点分段）
├── 规则集/                # 规则集文件夹（v3 D11）
│   ├── 文风规则.md        #   文风约定（唯一外部可编辑的渲染规则，渐进披露读取）
│   ├── 检查规则.md        #   render_check 校验规则
│   └── 自定义规则.md      #   自定义扩展规则（用户/代理可写）
├── 笔记/                  # 内容区域：随笔、灵感（用户和代理都可编辑）
├── 草稿/                  # 内容区域：草稿、废弃片段
├── 设定/                  # 内容区域：世界观、人物、地点、物品等设定文本
├── 大纲/                  # 内容区域：卷纲、章纲
└── .pi/
    ├── world-graph-v3/    # 世界图（events.jsonl + world-state.json 入库；world.db 不入库）
    ├── scheduler-plans/   # plan 缓存（gitignore）
    ├── sessions/          # 会话数据（gitignore）
    └── logs/              # 调试日志（gitignore）
```

> v3 变更：删除根目录 规则集.md / planner 规则集.md / 角色规则集.md（规则集三件套）——
> planner 检索策略与角色扮演规则已收回引擎自维护（D7/D8），渲染规则拆分（D9）：
> 文风→`规则集/文风规则.md`（外部编辑）、格式/禁止/输出契约→引擎内置、检查→`规则集/检查规则.md`。

## 3. 粒度模型（v3 D10 定案：一章一 .md）

- **一个章节 = 一个 .md 文件**：`正文/第<N>章-<标题>.md`（N 为 storyTime 章号，标题缺省"未命名"，主会话可重命名）
- **章内事件 = 锚点段落**：`<!-- event: <eventId> -->` + 空行 + 正文（追加/修改/插入由渲染器锚点机制管理，见 `@pi/renderer` chapter-io）
- storyTime 模型 `ch{NNN}.ev{NNN}`：ch=章节号，ev=章内事件序号；同章 ev+1，进新章 ch+1 且 ev 从 001 起；零填充保证字典序==时序
- **文件系统布局可由 storyTime 无损推导**：`ch{N}NN.evXXX` → 章节文件 `第<N>章-*.md` + 第 N 章内锚点
- 引擎路径解析：`resolveChapterPath` 消费 `novel.json.chaptersDir`（缺省 `正文`），缺省路径恒为章节级文件（旧事件级 `chapters/<storyTime>.md` 缺省已废弃）

## 4. 小说.json（项目清单）

| 字段 | 说明 |
|------|------|
| `name` | 项目名 |
| `engine` / `engineVersion` | 引擎标识与版本（模板缺省 `narrative-engine` / `0.1.0`） |
| `worldGraphDir` | 世界图目录（相对项目根，缺省 `.pi/world-graph-v3`） |
| `chaptersDir` | 章节目录（相对项目根，缺省 `正文`；**被引擎真实消费**） |
| `storyTimeFormat` | 故事时间格式约定（`ch{NNN}.ev{NNN}`） |
| `createdAt` | 初始化日期（YYYY-MM-DD） |

> 读写由 `@pi/admin` 的 `readNovelJson` / `writeNovelJson` 处理：**主名 小说.json 优先，
> 旧版 novel.json 兼容回退**（读）；写统一写主名（旧项目经一次写自动迁移）。
> `@pi/novel-launcher` 的 `getProjectMeta` 同源解析。HTTP 端点 `/api/admin/novel-json` 保持不变（内部契约）。
> 允许未知扩展字段（前端可能新增，无损保留）。

## 5. 规则集（v3 D11：规则集/ 文件夹 + 渐进披露）

| 文件 | 归属 | 消费方 |
|------|------|--------|
| `规则集/文风规则.md` | **外部可编辑**（作品文风内容） | 渲染器子代理（<available_rules> 渐进披露 + `rules_read` 按需读取）；主会话 render_* 工具（全文注入）；旧版 `规则集.md` 兼容回退 |
| `规则集/检查规则.md` | 外部可编辑（校验规则） | render_check（checker） |
| `规则集/自定义规则.md` | 预留（用户/代理可写） | 渐进披露清单可见，渲染器按需读取 |

**渐进披露**（对齐 pi SDK `<available_skills>` 模式）：渲染器子代理提示词只列规则清单
（名称+位置+简介），不全文注入；按需调用 `rules_read` 读取全文。

**已收回引擎自维护**（不再以文件存在）：planner 检索策略/信息差/数量控制（D7，固化进
`@pi/scheduler` buildPlannerSystemPrompt，数量统一 3-8 条）；角色扮演原则/输出纪律/词表（D8，
固化进 `@pi/role-pool` BUILTIN_ROLE_RULES）；渲染格式/禁止/输出契约（D9，固化进 `@pi/renderer`
RENDERER_SYSTEM_PROMPT）。

## 6. git 管理规则（v3 D12：数据库方案 B 文本快照）

| 入库 | 不入库 |
|------|--------|
| 创作资产：小说.json / README.md / 正文/ / 规则集/ / 笔记/ 草稿/ 设定/ 大纲/ | `*.db` / `*.db-shm` / `*.db-wal`（SQLite 二进制，无法 diff/merge） |
| 世界图文本：`.pi/world-graph-v3/events.jsonl`（剧情权威日志）、`world-state.json`（状态快照）、`alias-index.json`、`chapter-index.json`、导入基线 dump | `.pi/sessions/`、`.pi/logs/`、`.pi/scheduler-plans/` |
| `.gitignore` 自身 | `.mimosa/`（工具痕迹） |

**world.db 恢复路径**：db 丢失时由 `events.jsonl`（权威事件日志）+ `world-state.json`（当前状态快照）重建。
引擎提供 `node scripts/export-world-state.mjs [--project <dir>]` 导出当前世界状态快照
（实体/关系/声明，可 diff）。

**提交节奏建议**：每完成一章提交一次 = 正文 + events.jsonl + world-state.json（剧情存档点）。

## 7. 初始化流程

### 方式一：Web UI 创建（推荐）

```bash
cd narrative-engine
node scripts/app-server.mjs --port 7421
```

浏览器访问 `http://127.0.0.1:7421`，在「项目管理」页创建新项目：

1. 选择目标父目录 + 填写项目名
2. 引擎调用脚手架创建目录骨架（正文/ 规则集/ 笔记/ 草稿/ 设定/ 大纲/ + `.pi/world-graph-v3/`）+ 复制模板（小说.json / 规则集三件 / .gitignore / README.md）
3. `ProjectRegistry.openProject({ allowInit: true })` 自动初始化空世界图（`world.db`）
4. 项目激活，可直接开始口述创作

### 方式二：CLI 脚手架（批量/脚本场景）

```bash
cd narrative-engine
npm run init -- <目标目录> [--name <项目名>] [--force]
```

创建目录骨架 + 复制模板（`{{name}}` / `{{date}}` 变量替换）。幂等：已存在文件不覆盖（`--force` 强制）。
脚手架产物需在 Web UI 中激活（或 `node scripts/app-server.mjs --project <目录>` 启动时激活），
首次激活会自动初始化空世界图。

## 8. 多项目管理

`ProjectRegistry`（`src/app/project-registry.ts`）是**全局活跃项目注册表**：

- 按**目录绝对路径**缓存已打开的项目句柄（`ProjectHandle`：`wg` + `search` + `meta`），非活跃项目保持打开以支持快速切回
- 同时只有一个**活跃项目**（`getActive()` / `setActive(dir)`）；世界图 / files / admin 路由全部从 `getActive()` 取上下文
- 新建项目（无 `world.db`）在 `allowInit: true` 时自动初始化空库，使「新建项目 → 激活 → 创作」闭环
- `migrateProject(dir)`：项目数据库 schema 过旧时迁移（先备份 `world.db.bak-<ts>`，再 `WorldGraph.migrate`）
- 服务关闭时 `closeAll()` 释放全部 `WorldGraph` 句柄

Web UI「项目管理」页对应 `/api/projects/*` 端点（scan / open / activate / close / migrate），
全局可见已打开项目列表与活跃项目标记。扫描根目录受 app-config `launcher.defaultScanRoots` 白名单限制（启动时读取）。

## 9. 旧工程兼容（v2 → v3）

| 维度 | 兼容行为 |
|------|----------|
| 项目清单 | `novel.json` 兼容读取（主名 小说.json 优先）；引擎写操作自动迁移出主名 |
| 章节粒度 | 旧事件级文件（`chapters/*.md`）保留可编辑；新写作恒落章节级文件 |
| 渲染规则 | 旧 `规则集.md` 在 规则集/文风规则.md 缺失时兼容回退（主会话工具链）；编排器子代理渐进披露仅认新位置（旧项目建议迁移） |
| 规则集三件套 | planner/角色规则集文件残留不影响（引擎已内置） |

## 10. 应用级配置

引擎在平台应用数据目录维护一份**应用级配置**，与项目级 `小说.json` / `.env` 并行：

| 平台 | 路径 |
|------|------|
| Windows | `%APPDATA%\narrative-engine\app-config.json` |
| macOS | `~/Library/Application Support/narrative-engine/app-config.json` |
| Linux | `~/.config/narrative-engine/app-config.json` |

`app-config.json` 字段（由 `@pi/admin` 的 `readAppConfig` / `writeAppConfig` 读写，深层合并已知键）：

```jsonc
{
  "launcher": {
    "defaultScanRoots": [],          // 项目扫描默认根目录列表（白名单，启动时读取）
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

### 10.1 LLM 配置（5 slot 管理）

主会话与四阶段子代理（planner / role / reasoning / renderer）的 LLM 配置由
`LlmConfigStore`（`src/orchestrator/llm-config.ts`）统一管理，**5 个 slot**：
`planner` / `role` / `reasoning` / `renderer` / `default`（兜底）。

**解析链**：slot 显式配置 → `default` slot → env 兜底（`NE_LLM_PROVIDER` / `NE_LLM_MODEL` / `NE_LLM_API_KEY` → provider 标准 env）。

**持久化**：`app-config.json` 的 `llm.slots` 仅存 `{ provider, model }`；API Key 权威存储为
`AuthStorage` 的 `auth.json`（与 pi SDK 同源）。配置入口：Web UI「设置 → 模型配置」页。

### 10.2 项目级 .env（扩展专属变量）

项目根 `.env` 由 `@pi/admin` 的 `env-store` 模块读写，仅管理**扩展专属变量**：
`HF_ENDPOINT`（HuggingFace 镜像端点）/ `PI_DEBUG`（调试总线开关）/ `PI_EMBEDDER_MODEL`（向量模型覆盖）。
**不存 API Key**。Web UI「设置 → 环境变量」页对应 `/api/admin/env` 端点。

### 10.3 与项目级配置的关系

- `小说.json` 描述**项目本身**（名称 / 世界图目录 / 章节目录 / storyTime 格式），每个项目独立
- `app-config.json` 描述**应用级偏好**（扫描根 / 上次项目 / 向量模型 / LLM slot 映射 / 默认执行模式），全局共享
- 项目级 `.env` 描述**项目级运行时变量**（HF 镜像 / 调试开关 / 向量模型覆盖），每项目独立
