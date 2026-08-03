# 文档索引（docs/README.md）

> 本仓库全部文档的地图。三分法：**现行文档**（以代码为准持续维护）/
> **设计文档**（已实施，保留作设计依据）/ **历史文档**（V2 及以前，概念溯源）。
>
> 变更记录见 [../CHANGELOG.md](../CHANGELOG.md)。

## 现行文档（先读这些）

| 文档 | 内容 | 读者 |
|------|------|------|
| [../README.md](../README.md) | 项目门面：简介、架构、快速开始（两种安装模式） | 所有人 |
| [../CHANGELOG.md](../CHANGELOG.md) | 变更记录（v0.1.0-alpha.1 应用化更新） | 所有人 |
| [app-mode.md](app-mode.md) | **应用内置模式安装指南**（Tauri 应用 / 首次重装扩展 / 应用配置 / 升级 / 故障排查） | 终端用户 |
| [SETUP.md](SETUP.md) | 项目级 sync 模式部署指南 + 已知坑 + 环境变量 + pi 版本兼容性 | 部署者 |
| [USAGE.md](USAGE.md) | 完整使用手册：口述创作 / plan-yolo / modify-insert / 导入 / 规则集 / FAQ | 创作者 |
| [api/README.md](api/README.md) | **API 参考总入口**：31 个 pi 工具 + 子包 API + HTTP 端点按主题拆分为 18 个小文档（2026-07-31 拆分，AI 友好按需阅读） | 开发者 |
| [novel-project-structure.md](novel-project-structure.md) | 小说工程结构定义 v1（novel.json / 目录 / git 策略 / 应用级配置） | 开发者 |
| [THIRD-PARTY.md](THIRD-PARTY.md) | 第三方代码/依赖/许可证盘点（含 Tauri/Rust 依赖） | 合规/分发者 |
| [audits/2026-07-25-requirements-audit.md](audits/2026-07-25-requirements-audit.md) | 需求-源码核对记录（7 项核对 + 全部修复史） | 开发者 |
| [audits/2026-07-27-fix-plan.md](audits/2026-07-27-fix-plan.md) | P0 修复执行文档（6 个 P0 问题分 3 阶段修复方案，已实施完毕） | 开发者 |
| [audits/2026-07-29-data-flow-audit.md](audits/2026-07-29-data-flow-audit.md) | 数据流审计（dispatch/commit/数据库 schema/工具返回值，附 [HTML 渲染版](audits/2026-07-29-data-flow-audit.html)） | 开发者 |
| [audits/2026-07-30-code-audit.md](audits/2026-07-30-code-audit.md) | 2026-07-30 代码审计（M1-M22 问题清单，含 M11 api 文档软隔离偏差，已在新 api/ 文档中修正） | 开发者 |

## 设计文档（已实施，保留作设计依据）

| 文档 | 对应实现 | 关键内容 |
|------|---------|---------|
| [plans/2026-07-29-app-architecture-design.md](plans/2026-07-29-app-architecture-design.md) | `tauri-app/` + `src/app/` + `@pi/admin` + `@pi/novel-launcher` | **应用化架构设计**（Tauri 壳 + unified-server + 应用内置扩展 + sidecar 打包，已部分实施） |
| [plans/2026-07-29-config-ui-design.md](plans/2026-07-29-config-ui-design.md) | `frontend-demo/views/settings.js` + `@pi/admin` | 配置前端页面设计（LLM 复用 PI + 扩展专属配置，已部分实施） |
| [plans/2026-07-25-scheduler-design.md](plans/2026-07-25-scheduler-design.md) | `packages/scheduler/` | 调度器 15 项决策、plan/commit 双阶段、planner LLM 检索计划 |
| [plans/2026-07-24-role-pool-design.md](plans/2026-07-24-role-pool-design.md) | `packages/role-pool/` | 角色池 12 项决策、酒馆卡静态层 + 动态层双层注入 |
| [plans/2026-07-24-role-pool.md](plans/2026-07-24-role-pool.md) | `packages/role-pool/` | 角色池实施计划（9 Tasks 历史） |
| [plans/2026-07-24-renderer.md](plans/2026-07-24-renderer.md) | `packages/renderer/` | 渲染器规则集注入、锚点章节格式 |
| [visualization-v3-design.md](visualization-v3-design.md) | `src/visualizer/` + `frontend-demo/` | 现行可视化（快照浏览/查询过滤/字段编辑 + 应用化扩展页面） |
| [plans/2026-07-31-underworld-graph-extraction.md](plans/2026-07-31-underworld-graph-extraction.md) | `underworld-graph`（外部 npm 包） | world-graph 解耦独立发布（阶段 1-3 已实施，v0.1.0 已发布） |
| [plans/2026-07-31-sdk-integration-architecture.md](plans/2026-07-31-sdk-integration-architecture.md) | pi SDK 迁移 | SDK 模式集成架构（阶段 1 已实施；含 LLM caller 签名错配问题记录，2026-07-31 已修复） |
| [plans/2026-07-31-sdk-tool-implementation.md](plans/2026-07-31-sdk-tool-implementation.md) | pi SDK 迁移 | SDK 工具实现路径（Path A 内联扩展 / Path B 全 SDK 化，原型验证中） |
| [plans/2026-07-31-subagent-orchestrator-design.md](plans/2026-07-31-subagent-orchestrator-design.md) | 子代理编排 | 多子代理编排设计（设计阶段） |
| [plans/2026-07-31-tool-allocation-design.md](plans/2026-07-31-tool-allocation-design.md) | 工具分配 | 工具与子代理分配设计（设计阶段） |

## 历史文档（概念溯源，勿当现行依据）

| 文档 | 价值 |
|------|------|
| [legacy/v2-design-notes.md](legacy/v2-design-notes.md) | 调度器/执行器/渲染器三分、信息差架构原则的概念源头 |
| [legacy/world-graph-storage-design.md](legacy/world-graph-storage-design.md) | bi-temporal 存储、向量方案的概念源头 |
| [legacy/import-novel-v2-redesign.md](legacy/import-novel-v2-redesign.md) | V2 导入器重设计笔记（V3 见 packages/novel-importer，测试实现待重写） |
| [legacy/feishu-doc-summary.md](legacy/feishu-doc-summary.md) | 飞书文档整理（项目最早期构想） |
| [visualization-design.md](visualization-design.md) | 可视化 V1 方案（未实施即被否，LiteGraph.js 蓝图风，决策历史） |
| [legacy/prototype-v3/](legacy/prototype-v3/) | 可视化 V3 静态原型（现行实现为仓库根 frontend-demo/） |

## 维护约定

1. **现行文档随代码改**：工具增删改 → 同步 api/ 对应小文档；流程变化 → 同步 USAGE.md；版本发布 → 写 CHANGELOG.md
2. **设计文档不改**：实施后冻结，状态以头部横幅为准；后续演进写新的 plans/yyyy-mm-dd-*.md
3. **新文档归位**：计划类 → `plans/`；核对类 → `audits/`；过时即移 `legacy/` 并加横幅
4. **强一致性**：文档与实际项目状态必须一致，发现差异立即修正，不允许"文档说有但实际没有"或"实际有但文档没提"
