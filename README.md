# narrative-engine

> 基于 pi 的叙事引擎扩展：世界图（bi-temporal）+ 角色池 + 调度器 + 渲染器，
> 让你用**口述**驱动小说创作——引擎维护世界状态，角色按信息差扮演，正文自动渲染。

[![test](https://github.com/lmy414/pi-narrative-engine/actions/workflows/test.yml/badge.svg)](https://github.com/lmy414/pi-narrative-engine/actions/workflows/test.yml)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
[![version](https://img.shields.io/badge/version-0.1.0--alpha.1-orange.svg)](CHANGELOG.md)

## 它是什么

```
你口述："彩叶推开咖啡厅的门，看到辉夜坐在角落"
        │
        ▼
主会话（意图理解，五要素补全）
        │
        ▼
调度器 ─ planner LLM 推导检索计划 → 世界图检索（信息差分配）
        │
        ▼
角色池 ─ 每个角色带着"自己该知道的"独立扮演，输出结构化行动
        │
        ▼
commit ─ 状态变化写回世界图（含可见性）→ 渲染器生成正文 → 章节文件
```

核心机制：**信息差是结构而非扮演**。每个角色只拿到自己可见的世界条目子集
（可见性五步过滤），不知道的事就是不知道。

## 当前状态

✅ **功能链路可用**：小说导入 → 口述续写 → 四人混演已端到端验证（326+ 单测，三平台 CI）。
✅ **应用化完成**（2026-07-30，v0.1.0-alpha.1）：Tauri 桌面应用 + 应用内置扩展模式 + unified-server
统一服务 + 可视化前端 6 页导航。详见 [CHANGELOG.md](CHANGELOG.md)。
✅ **跨会话项目记忆**（2026-07-25）：`memory.md` 自动维护当前进度/在场角色/最近事件（含口述原文），新会话自动注入。
✅ **双时态检索**（2026-07-25）：故事时间 × 事务时间双轴查询（`recordedAsOf`），改写历史剧情不被新写入污染。
✅ **AI 使用指南注入**（2026-07-25 → 2026-07-28 重构）：原 `engine-guide.md` / `main-session.md` 强制注入 systemPrompt；
2026-07-28 起合并抽离为单一 pi Skill（`src/skills/narrative-engine/SKILL.md`），通过 `resources_discover` 注册
由 pi skill 机制按需 read 加载；`memory.md` 仍保留强制注入。
✅ **P0 修复**（2026-07-27）：双时态检索接入调度器 + commit 写 embedding + knowledge_gained 他盲可见性 + 部分成功语义
（详见 [docs/audits/2026-07-27-fix-plan.md](docs/audits/2026-07-27-fix-plan.md)）。
✅ **调试管线**（2026-07-27）：DebugBus 环形缓冲 + SSE 端点 + 可视化"调试" tab，实时显示调度链 DAG（`PI_DEBUG=off` 可禁用）。

> [!WARNING]
> **测试实现声明**：`import_novel`（小说导入器）与 `import_character_card`（酒馆卡导入器）
> 当前为**测试实现**——它们验证了功能链路的可行性，但**不保证数据质量**
> （实体消解准确性、事件粒度、属性命名一致性、关系抽取完整性均未达生产标准）。
> 两个导入器后续将**重写**。在此基础上构建的世界图数据建议仅用于试验。

> [!WARNING]
> **v0.1.0-alpha.1 平台限制**：仅提供 Windows NSIS 安装器（`narrative-engine_0.1.0-alpha.1_x64-setup.exe`），
> macOS/Linux 暂未打包。sidecar 内的原生模块（better-sqlite3 / sqlite-vec / onnxruntime-node）
> 仅在 Windows 上验证可用。

## 快速开始

两种安装模式，按你的身份选一种。

### 模式一：应用内置模式（终端用户推荐）

下载 [v0.1.0-alpha.1 Release](https://github.com/lmy414/pi-narrative-engine/releases/tag/v0.1.0-alpha.1)
的 `narrative-engine_0.1.0-alpha.1_x64-setup.exe`，双击安装。启动应用后按提示完成首次扩展重装即可。

详细步骤见 [docs/app-mode.md](docs/app-mode.md)。

### 模式二：项目级 sync 模式（开发者推荐）

> 💡 **提示**：把本仓库链接丢给你已配置好的 pi，让它帮你完成安装与排错
> （它能跑 `npm run doctor` 自检、修 better-sqlite3 绑定、配 HF 镜像——以下手动步骤它全会）。

```bash
git clone git@github.com:lmy414/pi-narrative-engine.git
cd narrative-engine
npm install && npm run build
npm run doctor                       # 环境自检

npm run init -- ../my-novel --name 我的小说    # 初始化小说工程
cd ../my-novel/.pi/extensions/narrative-engine && npm install
cd ../../.. && pi                    # 启动，直接口述剧情
```

详细部署（含已知坑）：[docs/SETUP.md](docs/SETUP.md)
日常使用手册：[docs/USAGE.md](docs/USAGE.md)

## 文档导航

**总索引：[docs/README.md](docs/README.md)**（现行 / 设计 / 历史三分）
**变更记录：[CHANGELOG.md](CHANGELOG.md)**

| 文档 | 内容 |
|------|------|
| [docs/app-mode.md](docs/app-mode.md) | **应用内置模式安装指南**（Tauri 应用 / 首次重装扩展 / 应用配置 / 升级） |
| [docs/USAGE.md](docs/USAGE.md) | **完整使用说明**（口述创作 / plan-yolo / 修改插入 / 导入 / 可视化 / 规则集） |
| [docs/SETUP.md](docs/SETUP.md) | 项目级 sync 模式部署指南 + 已知坑排行榜 + pi 版本兼容性 + 环境变量速查 |
| [docs/api.md](docs/api.md) | 31 个 pi 工具 + 子包 API + unified-server HTTP 端点完整参考 |
| [docs/novel-project-structure.md](docs/novel-project-structure.md) | 小说工程结构定义（novel.json / 目录 / git 策略 / 应用级配置） |
| [docs/audits/2026-07-25-requirements-audit.md](docs/audits/2026-07-25-requirements-audit.md) | 需求-源码核对记录（7 项 + 修复史） |
| [docs/audits/2026-07-27-fix-plan.md](docs/audits/2026-07-27-fix-plan.md) | P0 修复执行文档（6 个 P0 问题分 3 阶段方案，已实施完毕） |
| [docs/audits/2026-07-29-data-flow-audit.md](docs/audits/2026-07-29-data-flow-audit.md) | 数据流审计（dispatch/commit/数据库 schema/工具返回值，[HTML 渲染版](docs/audits/2026-07-29-data-flow-audit.html)） |
| [docs/THIRD-PARTY.md](docs/THIRD-PARTY.md) | 第三方代码/依赖/许可证盘点（GPL 兼容性说明） |

## 子包

| 包 | 职责 |
|---|------|
| `@pi/world-graph` | bi-temporal 世界图（SQLite + FTS5 + 向量，实体/事实/关系/可见性） |
| `@pi/scheduler` | 调度器：检索计划 → 角色编排 → 写扩散 + 渲染（plan/yolo 双模式） |
| `@pi/role-pool` | 角色池：串行扮演，酒馆卡静态层 + 动态事实注入 |
| `@pi/renderer` | 渲染器：结构化输出 → 规则集约束的正文，锚点写盘 |
| `@pi/novel-importer` | EPUB → 世界图（8 阶段管道）⚠️ 测试实现 |
| `@pi/admin` | 应用级配置管理后端核心库（app-config / env-store / rulesets / doctor / updater / files 等 10 模块） |
| `@pi/novel-launcher` | 项目发现与跨平台启动 PI 后端核心库（discoverProjects / launchPi / createProject） |
| `tauri-app/` | Tauri 桌面应用入口（Rust 壳 + sidecar 进程管理，非 npm 包） |

## 开发

### 扩展开发命令（narrative-engine 仓库根目录）

```bash
npm run build      # src/*.ts → dist/（esbuild transform-only）
npm run sync       # dist + packages + visualizer-ui + templates → ../novel/.pi/extensions/
npm run dev        # sync --watch 模式（监听 dist/ 变化自动同步）
npm run doctor     # 环境自检（调用 @pi/admin 的 runDoctor）
npm run init -- <目录>  # 初始化小说工程
```

### Tauri 应用开发命令（`tauri-app/` 目录）

```bash
cd tauri-app
npm install                           # 安装 @tauri-apps/cli
npm run sidecar                       # 打包 sidecar 资源到 src-tauri/resources/（需先在根目录 npm run build）
npm run dev                           # tauri dev：拉起 Tauri 窗口 + sidecar dev 模式（tsx 跑 src/app/main.ts）
npm run build                         # tauri build：release 编译 + 生成 NSIS 安装器（需先 npm run sidecar）
```

### 子包测试（全 mock，无需 API key）

```bash
cd packages/<子包> && npx tsx --test tests/*.test.ts
```

### 端到端测试（根目录）

```bash
npx tsx --test tests/e2e.test.ts tests/e2e-renderer.test.ts
```

CI：ubuntu / windows / macos × node 20/22，每次 push 全量跑。

**分支策略**：所有改动走 `<YYYYMMDD>-<描述>` 分支，禁止直接在 `master` 上 commit。
工作流：同步主干 → 创建分支 → 显式路径 add + commit → `git checkout master && git merge --ff-only <分支>`
→ `git push` → 删除分支。详见 [AGENTS.md](../AGENTS.md)。

## License

[GPL-3.0](LICENSE) © 2026 lmy414
