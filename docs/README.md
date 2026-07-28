# 文档索引（docs/README.md）

> 本仓库全部文档的地图。三分法：**现行文档**（以代码为准持续维护）/
> **设计文档**（已实施，保留作设计依据）/ **历史文档**（V2 及以前，概念溯源）。

## 📗 现行文档（先读这些）

| 文档 | 内容 | 读者 |
|------|------|------|
| [../README.md](../README.md) | 项目门面：简介、架构、快速开始 | 所有人 |
| [SETUP.md](SETUP.md) | 部署指南 + 已知坑 + 环境变量 + **pi 版本兼容性** | 部署者 |
| [USAGE.md](USAGE.md) | 完整使用手册：口述创作 / plan-yolo / modify-insert / 导入 / 规则集 / FAQ | 创作者 |
| [api.md](api.md) | 31 个 pi 工具 + 子包 API 完整参考（2026-07-28 更新至 P0 修复 + 调试管线 + §12 DebugBus） | 开发者 |
| [novel-project-structure.md](novel-project-structure.md) | 小说工程结构定义 v1（novel.json / 目录 / git 策略 / init 流程） | 开发者 |
| [THIRD-PARTY.md](THIRD-PARTY.md) | 第三方代码/依赖/许可证盘点 | 合规/分发者 |
| [audits/2026-07-25-requirements-audit.md](audits/2026-07-25-requirements-audit.md) | 需求-源码核对记录（7 项核对 + 全部修复史） | 开发者 |
| [audits/2026-07-27-fix-plan.md](audits/2026-07-27-fix-plan.md) | P0 修复执行文档（6 个 P0 问题分 3 阶段修复方案，已实施完毕） | 开发者 |
| [audits/2026-07-29-data-flow-audit.md](audits/2026-07-29-data-flow-audit.md) | 数据流审计（dispatch/commit/数据库 schema/工具返回值，附 [HTML 渲染版](audits/2026-07-29-data-flow-audit.html)） | 开发者 |

## 📐 设计文档（已实施，保留作设计依据）

| 文档 | 对应实现 | 关键内容 |
|------|---------|---------|
| [plans/2026-07-25-scheduler-design.md](plans/2026-07-25-scheduler-design.md) | `packages/scheduler/` | 调度器 15 项决策、plan/commit 双阶段、planner LLM 检索计划 |
| [plans/2026-07-24-role-pool-design.md](plans/2026-07-24-role-pool-design.md) | `packages/role-pool/` | 角色池 12 项决策、酒馆卡静态层 + 动态层双层注入 |
| [plans/2026-07-24-role-pool.md](plans/2026-07-24-role-pool.md) | `packages/role-pool/` | 角色池实施计划（9 Tasks 历史） |
| [plans/2026-07-24-renderer.md](plans/2026-07-24-renderer.md) | `packages/renderer/` | 渲染器规则集注入、锚点章节格式 |
| [visualization-v3-design.md](visualization-v3-design.md) | `src/visualizer/` + `visualizer-ui/` | 现行可视化（快照浏览/查询过滤/字段编辑） |

## 📜 历史文档（概念溯源，勿当现行依据）

| 文档 | 价值 |
|------|------|
| [legacy/v2-design-notes.md](legacy/v2-design-notes.md) | 调度器/执行器/渲染器三分、信息差架构原则的概念源头 |
| [legacy/world-graph-storage-design.md](legacy/world-graph-storage-design.md) | bi-temporal 存储、向量方案的概念源头 |
| [legacy/import-novel-v2-redesign.md](legacy/import-novel-v2-redesign.md) | V2 导入器重设计笔记（V3 见 packages/novel-importer，测试实现待重写） |
| [legacy/feishu-doc-summary.md](legacy/feishu-doc-summary.md) | 飞书文档整理（项目最早期构想） |
| [visualization-design.md](visualization-design.md) | 可视化 V1 方案（未实施即被否，LiteGraph.js 蓝图风，决策历史） |
| [legacy/prototype-v3/](legacy/prototype-v3/) | 可视化 V3 静态原型（现行实现为仓库根 visualizer-ui/） |

## 维护约定

1. **现行文档随代码改**：工具增删改 → 同步 api.md；流程变化 → 同步 USAGE.md
2. **设计文档不改**：实施后冻结，状态以头部横幅为准；后续演进写新的 plans/yyyy-mm-dd-*.md
3. **新文档归位**：计划类 → `plans/`；核对类 → `audits/`；过时即移 `legacy/` 并加横幅
