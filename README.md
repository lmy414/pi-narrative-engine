# narrative-engine

> 基于 pi 的叙事引擎扩展：世界图（bi-temporal）+ 角色池 + 调度器 + 渲染器，
> 让你用**口述**驱动小说创作——引擎维护世界状态，角色按信息差扮演，正文自动渲染。

[![test](https://github.com/lmy414/pi-narrative-engine/actions/workflows/test.yml/badge.svg)](https://github.com/lmy414/pi-narrative-engine/actions/workflows/test.yml)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

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

> [!WARNING]
> **测试实现声明**：`import_novel`（小说导入器）与 `import_character_card`（酒馆卡导入器）
> 当前为**测试实现**——它们验证了功能链路的可行性，但**不保证数据质量**
> （实体消解准确性、事件粒度、属性命名一致性、关系抽取完整性均未达生产标准）。
> 两个导入器后续将**重写**。在此基础上构建的世界图数据建议仅用于试验。

## 快速开始

```bash
git clone git@github.com:lmy414/pi-narrative-engine.git
cd narrative-engine
npm install && npm run build
npm run doctor                       # 环境自检（7 项，缺什么告诉你）

npm run init -- ../my-novel --name 我的小说    # 初始化小说工程
cd ../my-novel/.pi/extensions/narrative-engine && npm install
cd ../../.. && pi                    # 启动，直接口述剧情
```

详细部署（含已知坑）：[docs/SETUP.md](docs/SETUP.md)
日常使用手册：[docs/USAGE.md](docs/USAGE.md)

## 文档导航

**总索引：[docs/README.md](docs/README.md)**（现行 / 设计 / 历史三分）

| 文档 | 内容 |
|------|------|
| [docs/USAGE.md](docs/USAGE.md) | **完整使用说明**（口述创作 / plan-yolo / 修改插入 / 导入 / 可视化 / 规则集） |
| [docs/SETUP.md](docs/SETUP.md) | 部署指南 + 已知坑排行榜 + pi 版本兼容性 + 环境变量速查 |
| [docs/api.md](docs/api.md) | 31 个 pi 工具 + 子包 API 完整参考 |
| [docs/novel-project-structure.md](docs/novel-project-structure.md) | 小说工程结构定义（novel.json / 目录 / git 策略） |
| [docs/audits/2026-07-25-requirements-audit.md](docs/audits/2026-07-25-requirements-audit.md) | 需求-源码核对记录（7 项 + 修复史） |
| [docs/THIRD-PARTY.md](docs/THIRD-PARTY.md) | 第三方代码/依赖/许可证盘点（GPL 兼容性说明） |

## 子包

| 包 | 职责 |
|---|------|
| `@pi/world-graph` | bi-temporal 世界图（SQLite + FTS5 + 向量，实体/事实/关系/可见性） |
| `@pi/scheduler` | 调度器：检索计划 → 角色编排 → 写扩散 + 渲染（plan/yolo 双模式） |
| `@pi/role-pool` | 角色池：串行扮演，酒馆卡静态层 + 动态事实注入 |
| `@pi/renderer` | 渲染器：结构化输出 → 规则集约束的正文，锚点写盘 |
| `@pi/novel-importer` | EPUB → 世界图（8 阶段管道）⚠️ 测试实现 |

## 开发

```bash
npm run build      # src/*.ts → dist/（esbuild transform-only）
npm run sync       # dist + packages + visualizer-ui → ../novel/.pi/extensions/
npm run doctor     # 环境自检
npm run init -- <目录>  # 初始化小说工程
```

子包测试（全 mock，无需 API key）：

```bash
cd packages/<子包> && npx tsx --test tests/*.test.ts
```

CI：ubuntu / windows / macos × node 20/22，每次 push 全量跑。

**分支策略**：日常开发在 `feat/*` 分支，master 无独有提交时定期 fast-forward 合并回 `master`
（`git checkout master && git merge --ff-only <feat分支> && git push`）。
当前工作分支：`feat/role-pool`。

## License

[GPL-3.0](LICENSE) © 2026 lmy414
