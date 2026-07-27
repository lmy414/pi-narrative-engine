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

> 💡 **推荐安装方式**：把本仓库链接丢给你已配置好的 pi，让它帮你完成安装与排错。
> 以下手动步骤 pi 全部能代劳（自检、修绑定、配镜像），遇到问题让它跑 `npm run doctor` 即可。

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

### 3.2 sharp 原生绑定缺失（扩展 import 即崩）🔴

**症状**：扩展加载失败 / 测试文件集体崩溃，报 `Something went wrong installing the "sharp" module` / `Cannot find module '../build/Release/sharp-win32-x64.node'`。
**根因**：`@xenova/transformers` 的 `src/utils/image.js` **静态** `import sharp from 'sharp'`（本项目只用文本 embedding，根本用不到 sharp，但 import 链躲不开）。`embedder.ts` 里的 `env.sharp = false` 只能阻止运行时调用，**防不住静态 import**——绑定一缺，整个扩展 import 即崩。
**修复**：

```bash
cd <小说目录>/.pi/extensions/narrative-engine   # 或引擎仓库根目录
npm rebuild sharp
# 若 rebuild 无效（prebuild 下载失败）：
npm install --platform=win32 --arch=x64 sharp   # 按实际平台调整
```

### 3.3 向量模型下载失败（huggingface.co 不可达）

**症状**：`scheduler_dispatch` 报 `fetch failed`。
**修复**：

```bash
export HF_ENDPOINT=https://hf-mirror.com
# 首次成功下载后模型缓存到扩展 node_modules/.cache/，之后离线可用
# （embedder 有 localFilesOnly 离线回退，但前提是缓存已存在）

# hf-mirror.com 也不可达时，用作者自维护的备用镜像：
export HF_ENDPOINT=https://emaostudio.online/hf-mirror
```

**注意**：缓存路径是 `<扩展目录>/node_modules/@xenova/transformers/.cache/`（不是 `~/.cache/huggingface`）。sync 保留 node_modules，缓存不会因重新同步丢失。

### 3.4 模型名变更

默认模型 `deepseek-v4-flash`。若 API 报 `invalid_request_error`，用环境变量覆盖：

```bash
export PI_MODEL=<你的模型名>
# 或按角色分开：PI_PLANNER_MODEL / PI_ROLE_MODEL / PI_RENDERER_MODEL
```

### 3.5 sync 后工具消失/行为没变

`npm run sync` 只复制文件，**pi 需要 `/reload`（或重启会话）才加载新代码**。规则集 .md 例外（每次调用重读）。

### 3.6 Windows 换行符

git 会提示 LF→CRLF 警告，无害。可视化前端和渲染器都兼容。

## 4. 多平台差异

| 平台 | 状态 | 说明 |
|------|------|------|
| Windows 10/11 x64 | ✅ 主开发环境，全功能验证 | — |
| macOS / Linux | ⚠️ 未实测 | 代码无平台特定逻辑；风险集中在 better-sqlite3 绑定（npm rebuild 兜底）和路径分隔符（全部用 `path.join`，理论上安全）。CI 会逐步覆盖 |

## 5. pi 版本兼容性

**核心机制**：扩展 API 由**宿主 pi CLI**（用户机器上运行的 pi 版本）提供，不是由本仓库 node_modules 提供。
本仓库 devDependencies 的 `^0.77.0` 只管开发期类型检查（0.x caret 只允许 patch 漂移）。

**兼容矩阵**（2026-07-25 实测，对 npm 0.82.0 类型定义逐项核对）：

| 我们用到的 API | 0.77（开发） | 0.82（最新） |
|---------------|:---:|:---:|
| `pi.registerTool` / `ExtensionAPI` | ✅ | ✅ |
| `pi.on("session_start" / "session_shutdown" / "before_agent_start")` | ✅ | ✅ |
| `ctx.ui.notify` | ✅ | ✅ |
| pi-ai `complete` / `getModel` / `validateToolCall` / `StringEnum` / `Type` | ✅ | ✅ |

**结论**：pi CLI `>= 0.77` 均可运行本扩展。`npm run doctor` 会探测宿主 pi 版本并提示。

## 6. 环境变量速查

| 变量 | 用途 | 缺省 |
|------|------|------|
| `DEEPSEEK_API_KEY` / `PI_API_KEY` | LLM key（三路共用） | 必填 |
| `PI_MODEL` | 三路 LLM 统一模型名 | `deepseek-v4-flash` |
| `PI_PLANNER_MODEL` / `PI_ROLE_MODEL` / `PI_RENDERER_MODEL` | 按角色覆盖 | 跟 PI_MODEL |
| `PI_PLANNER_API_KEY` / `PI_ROLE_API_KEY` / `PI_RENDERER_API_KEY` | 按角色覆盖 key | 跟 DEEPSEEK_API_KEY |
| `HF_ENDPOINT` | HF 镜像 | huggingface.co |

## 7. CI（持续集成）

`.github/workflows/test.yml`：每次 push 在 ubuntu / windows / macos 三平台跑全部子包单测（326+，全 mock 无需 API key）。
