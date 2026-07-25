# 部署指南（SETUP）

> 从零到可用的完整 checklist。遇到问题先跑 `npm run doctor` 自检。
> 小说工程结构定义见 `docs/novel-project-structure.md`。

## 1. 前置要求

| 依赖 | 版本 | 说明 |
|------|------|------|
| Node.js | >= 20（开发用 24） | 原生模块编译需要 |
| C++ 编译环境 | Windows: VS Build Tools / macOS: Xcode CLT / Linux: build-essential | better-sqlite3 源码编译兜底用 |
| pi | 最新 | 本引擎是 pi 的项目级扩展 |
| DeepSeek API key | — | `export DEEPSEEK_API_KEY=sk-...` |

## 2. 快速开始

```bash
# 1. 克隆引擎
git clone git@github.com:lmy414/pi-narrative-engine.git narrative-engine
cd narrative-engine
npm install                 # workspace 全量安装（含子包）
npm run build               # src/*.ts → dist/*.js

# 2. 自检（可选但推荐）
npm run doctor

# 3. 初始化小说工程
npm run init -- <小说目录> --name 我的小说

# 4. 安装扩展依赖（原生模块编译，可能数分钟）
cd <小说目录>/.pi/extensions/narrative-engine && npm install

# 5. 启动
cd <小说目录> && pi
# 然后直接口述剧情即可
```

## 3. 已知坑（按踩坑频率排序）

### 3.1 better-sqlite3 原生绑定缺失 🔴 最高频

**症状**：所有 `world_*` / `scheduler_*` 工具报 `WorldGraph not initialized (session_start not fired?)`。
**根因**：`npm install` 时 prebuild 下载失败或被跳过，绑定没编译。pi 的扩展 runner 会静默吞掉初始化错误。
**修复**：

```bash
cd <小说目录>/.pi/extensions/narrative-engine
npm rebuild better-sqlite3
```

（网络受限时 prebuild 下不动，会回退源码编译——所以需要 C++ 编译环境。）

### 3.2 向量模型下载失败（huggingface.co 不可达）

**症状**：`scheduler_dispatch` 报 `fetch failed`。
**修复**：

```bash
export HF_ENDPOINT=https://hf-mirror.com
# 首次成功下载后模型缓存到扩展 node_modules/.cache/，之后离线可用
# （embedder 有 localFilesOnly 离线回退，但前提是缓存已存在）
```

**注意**：缓存路径是 `<扩展目录>/node_modules/@xenova/transformers/.cache/`（不是 `~/.cache/huggingface`）。sync 保留 node_modules，缓存不会因重新同步丢失。

### 3.3 模型名变更

默认模型 `deepseek-v4-flash`。若 API 报 `invalid_request_error`，用环境变量覆盖：

```bash
export PI_MODEL=<你的模型名>
# 或按角色分开：PI_PLANNER_MODEL / PI_ROLE_MODEL / PI_RENDERER_MODEL
```

### 3.4 sync 后工具消失/行为没变

`npm run sync` 只复制文件，**pi 需要 `/reload`（或重启会话）才加载新代码**。规则集 .md 例外（每次调用重读）。

### 3.5 Windows 换行符

git 会提示 LF→CRLF 警告，无害。可视化前端和渲染器都兼容。

## 4. 多平台差异

| 平台 | 状态 | 说明 |
|------|------|------|
| Windows 10/11 x64 | ✅ 主开发环境，全功能验证 | — |
| macOS / Linux | ⚠️ 未实测 | 代码无平台特定逻辑；风险集中在 better-sqlite3 绑定（npm rebuild 兜底）和路径分隔符（全部用 `path.join`，理论上安全）。CI 会逐步覆盖 |

## 5. 环境变量速查

| 变量 | 用途 | 缺省 |
|------|------|------|
| `DEEPSEEK_API_KEY` / `PI_API_KEY` | LLM key（三路共用） | 必填 |
| `PI_MODEL` | 三路 LLM 统一模型名 | `deepseek-v4-flash` |
| `PI_PLANNER_MODEL` / `PI_ROLE_MODEL` / `PI_RENDERER_MODEL` | 按角色覆盖 | 跟 PI_MODEL |
| `PI_PLANNER_API_KEY` / `PI_ROLE_API_KEY` / `PI_RENDERER_API_KEY` | 按角色覆盖 key | 跟 DEEPSEEK_API_KEY |
| `HF_ENDPOINT` | HF 镜像 | huggingface.co |

## 6. CI（持续集成）

`.github/workflows/test.yml`：每次 push 在 ubuntu / windows / macos 三平台跑全部子包单测（326+，全 mock 无需 API key）。
