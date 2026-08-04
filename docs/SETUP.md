# 部署指南（SETUP）

> 从零到可用的完整 checklist。遇到问题先跑 `npm run doctor` 自检。
> 小说工程结构定义见 `docs/novel-project-structure.md`。
>
> **本文档描述纯 SDK 独立应用形态**（2026-08 起）：引擎是直接依赖 pi SDK
> （@earendil-works/pi-agent-core / pi-ai / pi-coding-agent）的独立应用，
> 经 `node scripts/app-server.mjs` 启动本地服务。**扩展机制（`.pi/extensions/`、`npm run sync`）已删除**。

## 1. 前置要求

| 依赖 | 版本 | 说明 |
|------|------|------|
| Node.js | >= 22.19（开发用 24） | 引擎运行要求（undici 依赖 Node>=22） |
| 浏览器 | 现代浏览器（Chrome/Edge） | 访问前端面板 http://127.0.0.1:7421 |
| LLM API key | 任一生效 key | 经设置页 `/api/admin/llm/key` 写入，或环境变量兜底 |

## 2. 快速开始

```bash
# 1. 克隆引擎
git clone git@github.com:lmy414/pi-narrative-engine.git narrative-engine
cd narrative-engine
npm install                 # workspace 全量安装（含子包）

# 2. 自检（可选但推荐）
npm run doctor

# 3. 初始化小说工程（可选；也可手建 novel.json + 目录）
npm run init -- <小说目录> --name 我的小说

# 4. 启动本地服务
node scripts/app-server.mjs --project <小说目录> --port 7421
#     --project：启动时预激活项目（缺省不激活，浏览器落项目管理页）
#     --embed：启用向量检索（首次下载模型较慢）；--port：端口（缺省 7421）

# 5. 浏览器打开 http://127.0.0.1:7421
#    激活项目 → 设置页配 LLM key 与模型 → 开始创作
```

常用命令：

| 命令 | 用途 |
|------|------|
| `node scripts/app-server.mjs --port 7421` | 启动服务（纯 SDK，无需 pi） |
| `node scripts/app-server.mjs --project <dir> --embed` | 预激活项目 + 向量检索 |
| `node scripts/app-server.mjs --config-dir <dir>` | 覆盖应用配置目录（默认 `%APPDATA%/narrative-engine/`，用于测试/冒烟隔离） |
| `--embed`（与 `--project` 等组合） | 启用向量模型加载，开启 hybrid 检索；未加则 fulltext 模式 |
| `npm run doctor` | 环境自检 |
| `npm test` | 全量测试（645 用例，以实际运行结果为准） |
| `npm run build` | 逐文件转译 src/ → dist/ |

## 3. 已知坑

### 3.1 向量模型下载失败（huggingface.co 不可达）

**症状**：`--embed` 启动时模型下载失败 / `scheduler_dispatch` 报 `fetch failed`。
**修复**：

```bash
export HF_ENDPOINT=https://hf-mirror.com
# 首次成功下载后模型缓存（~/.cache 或项目 .pi 目录），之后离线可用
# hf-mirror.com 也不可达时，用作者自维护的备用镜像：
export HF_ENDPOINT=https://emaostudio.online/hf-mirror
```

### 3.2 模型名变更

LLM 配置统一走 **LlmConfigStore 5 slot**（default/planner/role/reasoning/renderer）：
- 设置页「模型配置」面板可视化配置各 slot 的 Provider/Model/Key，即时生效并持久化
- 配置落在应用级配置（`%APPDATA%/narrative-engine/`），经 `GET/PUT /api/admin/llm*` 管理
- 未配置的 slot 跟随 default slot → 环境变量兜底（provider 标准 env key）
- `import_novel` 缺省模型 `deepseek-v4-flash`

### 3.3 端口占用

**症状**：启动报 EADDRINUSE。
**修复**：`netstat -ano | findstr :7421` 查占用；换端口 `--port <其他端口>`（前端 URL 同步更换）。

### 3.4 Windows 换行符

git 会提示 LF→CRLF 警告，无害。vendor 目录（frontend-demo/vendor/）已加 `.gitattributes` 锁 LF，勿改。

### 3.5 活跃项目重启丢失

活跃项目为服务端内存态，重启即失；`startup-project.ts` 会从应用配置恢复最近项目（`launcher.lastProjectDir`），
恢复失败只警告不阻断。项目切换走 `POST /api/projects/activate`。

## 4. 多平台差异

| 平台 | 状态 | 说明 |
|------|------|------|
| Windows 10/11 x64 | ✅ 主开发环境，全功能验证 | — |
| macOS / Linux | ⚠️ 未实测 | 代码无平台特定逻辑；风险集中在 better-sqlite3 绑定（npm rebuild 兜底）与路径分隔符（全部用 path.join）。CI 覆盖中 |

## 5. 环境变量速查

| 变量 | 用途 | 缺省 |
|------|------|------|
| `DEEPSEEK_API_KEY` / 各 provider 标准 env key | LLM key 兜底（优先 auth.json / 设置页配置） | — |
| `PI_EMBEDDER_MODEL` | 覆盖向量模型名（维度仍 512，切换自负其责） | `Xenova/bge-small-zh-v1.5` |
| `PI_DEBUG` | 调试总线开关：`off` 禁用（`/api/debug/*` 返回 503） | 未设（启用） |
| `HF_ENDPOINT` | HF 镜像（transformers.js 经 `env.remoteHost` 生效） | huggingface.co |

> 端口覆盖经 `--port` 命令行参数提供（非环境变量）；`src/app/main.ts` 未解析 `NE_PORT`。

> 项目级 `.env`（活跃项目根下）只收白名单三键：`HF_ENDPOINT` / `PI_DEBUG` / `PI_EMBEDDER_MODEL`（见 `src/app/routes-ext.ts`）。

## 6. CI（持续集成）

`.github/workflows/test.yml`：每次 push 在 ubuntu / windows 矩阵跑全量子包单测（645，全 mock 无需 API key）
+ `npm audit --omit=dev`；真模型测试（pi-status）按条件跳过（HuggingFace 429 偶发）。
