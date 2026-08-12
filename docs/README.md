# 文档索引（docs/README.md）

> 本仓库全部文档的地图（2026-08-04 全量盘点后重建，84 个文件五类归档）。
> 盘点依据：`docs/2026-08-04-documentation-inventory.md`。
> 变更记录见 [../CHANGELOG.md](../CHANGELOG.md)。

## 现行文档（先读这些，以代码为准持续维护）

| 文档 | 内容 | 读者 |
|------|------|------|
| [../README.md](../README.md) | 项目门面：简介、架构、快速开始（SDK 独立应用形态） | 所有人 |
| [../CHANGELOG.md](../CHANGELOG.md) | 变更记录 | 所有人 |
| [frontend-requirements.md](frontend-requirements.md) | **前端目标规格 v2.1**（交付对接唯一规格：全局契约/页面/编排/验收清单） | 前后端实施与验收 |
| [hanako-reference.md](hanako-reference.md) | **Hanako 设计参考手册**（设计需求时优先借鉴/移植 openhanako 的方法与写法；模式库+出处索引+移植纪律） | AI/开发者 |
| [frontend-test-discipline.md](frontend-test-discipline.md) | 前端测试纪律（硬约束：改 frontend-demo 必跑测试轮） | AI/开发者 |
| [frontend-backend-api-audit.md](frontend-backend-api-audit.md) | 前后端 API 契约核对报告 | 开发者 |
| [ux/frontend-ux-requirements.md](ux/frontend-ux-requirements.md) | 前端 UX 需求 v1.0（功能/内容/交互，不含视觉） | 开发者/设计师 |
| [visualization-v3-design.md](visualization-v3-design.md) | 现行可视化设计（已实施，frontend-demo 依据） | 开发者 |
| [novel-project-structure.md](novel-project-structure.md) | 小说工程结构定义 v2（novel.json / 目录 / git 策略 / 应用级配置 / LLM slot 管理） | 开发者 |
| [api/README.md](api/README.md) | **API 参考总入口**：子包 API + HTTP 端点 + 主会话工具（pi-tools-* 已标历史） | 开发者 |
| [USAGE.md](USAGE.md) | 使用手册：口述创作 / plan-yolo / 导入 / 规则集 | 创作者 |
| [SETUP.md](SETUP.md) | 部署指南（纯 SDK 独立应用：`node scripts/app-server.mjs`） | 部署者 |
| [THIRD-PARTY.md](THIRD-PARTY.md) | 第三方代码/依赖/许可证盘点 | 合规/分发者 |

## 活跃流程（正在维护，勿删）

| 文档 | 内容 |
|------|------|
| [audits/frontend-bug-backlog.md](audits/frontend-bug-backlog.md) | 前端缺陷 backlog（BUG-001~010 全 fixed） |
| [plans/2026-08-04-phase2-plan.md](plans/2026-08-04-phase2-plan.md) | 第二阶段开发目标计划（批次 1-3 已实施，G2-G6 待执行） |
| [plans/2026-08-08-live-stage-visibility.md](plans/2026-08-08-live-stage-visibility.md) | 编排过程实时可见性需求记录（部分落地：debug 总线 SSE 已实施，完整方案待续） |
| [plans/2026-08-08-underworld-graph-api-change-preparedness.md](plans/2026-08-08-underworld-graph-api-change-preparedness.md) | underworld-graph API 变更应对预案（依赖面盘点 + 契约金丝雀等准备措施，已记录未实施） |
| [plans/2026-08-08-prompt-engineering-audit.md](plans/2026-08-08-prompt-engineering-audit.md) | 提示词工程审计与同类产品调研规划（现状=0 盘点 + 调研范围，已记录未实施） |
| [plans/2026-08-08-prompt-research.md](plans/2026-08-08-prompt-research.md) | **提示词工程调研报告**（2026-08-09 完成；D7/D8/D9 规则集收回引擎自维护已实施，其余落地待决策） |
| [plans/2026-08-08-floating-chat-module-coupling.md](plans/2026-08-08-floating-chat-module-coupling.md) | 模块割裂治理：跨视图悬浮对话与结果直达（排期：尚早，持续优化） |
| [plans/2026-08-08-rust-shell-packaging.md](plans/2026-08-08-rust-shell-packaging.md) | Rust 前端壳层打包（后续建议，排期：尚早；区别于已弃用的 Rust 重写前端方案） |
| [2026-08-04-documentation-inventory.md](2026-08-04-documentation-inventory.md) | 文档盘点与分类（本索引的底稿） |

## 设计归档（已实施/已决策，冻结保存）

| 文档 | 对应实现 |
|------|---------|
| [plans/2026-07-24-role-pool-design.md](plans/2026-07-24-role-pool-design.md) / [2026-07-24-role-pool.md](plans/2026-07-24-role-pool.md) | `packages/role-pool` |
| [plans/2026-07-24-renderer.md](plans/2026-07-24-renderer.md) | `packages/renderer` |
| [plans/2026-07-25-scheduler-design.md](plans/2026-07-25-scheduler-design.md) | `packages/scheduler` |
| [plans/2026-07-29-app-architecture-design.md](plans/2026-07-29-app-architecture-design.md) | `src/app` + `@pi/admin` + `@pi/novel-launcher` |
| [plans/2026-07-29-config-ui-design.md](plans/2026-07-29-config-ui-design.md) | `frontend-demo/views/settings.js` + `@pi/admin` |
| [plans/2026-07-31-underworld-graph-extraction.md](plans/2026-07-31-underworld-graph-extraction.md) | `underworld-graph`（独立 npm 包） |
| [plans/2026-07-31-sdk-integration-architecture.md](plans/2026-07-31-sdk-integration-architecture.md) / [sdk-tool-implementation.md](plans/2026-07-31-sdk-tool-implementation.md) / [tool-allocation-design.md](plans/2026-07-31-tool-allocation-design.md) / [subagent-orchestrator-design.md](plans/2026-07-31-subagent-orchestrator-design.md) | pi SDK 迁移 / 工具实现 / 分配 / 子代理编排 |
| [plans/2026-07-31-orchestrator-standalone-research.md](plans/2026-07-31-orchestrator-standalone-research.md) | 编排器独立化可行性调研（✅ 可行） |
| [plans/2026-08-10-worldgraph-dataaccess-and-visibility.md](plans/2026-08-10-worldgraph-dataaccess-and-visibility.md) / [2026-08-11-worldgraph-dataaccess-execution-plan.md](plans/2026-08-11-worldgraph-dataaccess-execution-plan.md) | 世界图数据管道统一收口（`WorldGraphDataAccess`，✅ 实施） |
| [plans/2026-08-12-unified-agent-abstraction.md](plans/2026-08-12-unified-agent-abstraction.md) / [2026-08-12-unified-agent-abstraction-execution.md](plans/2026-08-12-unified-agent-abstraction-execution.md) | 统一代理抽象（`BaseAgent` + `AgentRuntime` 单一运行时，✅ 实施，bd52c18） |
| [plans/2026-08-08-novel-project-structure-v3.md](plans/2026-08-08-novel-project-structure-v3.md) | 小说工程结构 v3 定案（✅ 实施 2026-08-10；落地见 `novel-project-structure.md` v3） |

## 过程档案（审计/测试轮/落地报告，只读存档）

| 文档 | 内容 |
|------|------|
| [audits/2026-07-25-requirements-audit.md](audits/2026-07-25-requirements-audit.md) | 需求-源码核对（7 项核对 + 修复史） |
| [audits/2026-07-27-fix-plan.md](audits/2026-07-27-fix-plan.md) | P0 修复执行文档（已实施完毕） |
| [audits/2026-07-29-data-flow-audit.md](audits/2026-07-29-data-flow-audit.md) | 数据流审计（附 [HTML 渲染版](audits/2026-07-29-data-flow-audit.html)） |
| [audits/2026-07-30-code-audit.md](audits/2026-07-30-code-audit.md) | 07-30 代码审计（基线 commit 见文首） |
| [audits/2026-08-03-code-audit.md](audits/2026-08-03-code-audit.md) | 08-03 全量审计（🔴1-11 已修复，批次 1-3 文档同步） |
| [audits/2026-08-03-production-gap-bug-inventory.md](audits/2026-08-03-production-gap-bug-inventory.md) | 生产差距 bug 清单（用户实测；批次 1-3 已修） |
| [audits/frontend-test-runs/](audits/frontend-test-runs/) | 前端测试轮 11 轮（08-03 七轮 + 08-04 四轮）+ 截图存档 |
| [plans/2026-08-01-main-session-execution-plan.md](plans/2026-08-01-main-session-execution-plan.md) | 主会话 SDK 落地（✅ 已实施） |
| [plans/2026-08-01-data-layer-ports-implementation-report.md](plans/2026-08-01-data-layer-ports-implementation-report.md) | 数据层 Ports 落地报告（A5 已完成） |
| [plans/2026-08-01-orchestrator-standalone-implementation-report.md](plans/2026-08-01-orchestrator-standalone-implementation-report.md) | 编排器独立化落地报告 |
| [plans/2026-08-01-old-code-cleanup-report.md](plans/2026-08-01-old-code-cleanup-report.md) | 旧代码清理盘点（✅ 已实施） |
| [plans/2026-08-02-frontend-backend-handoff-plan.md](plans/2026-08-02-frontend-backend-handoff-plan.md) | 前后端契约收敛计划（A1-A12 验收待执行，G4-4） |
| [plans/2026-08-02-studio-data-alignment.md](plans/2026-08-02-studio-data-alignment.md) | studio 数据对齐决策 |

## 历史归档（概念溯源/已废弃，勿当现行依据）

| 文档 | 价值 |
|------|------|
| [legacy/v2-design-notes.md](legacy/v2-design-notes.md) | 调度器/执行器/渲染器三分、信息差架构的概念源头 |
| [legacy/world-graph-storage-design.md](legacy/world-graph-storage-design.md) | bi-temporal 存储、向量方案的概念源头 |
| [legacy/import-novel-v2-redesign.md](legacy/import-novel-v2-redesign.md) | V2 导入器重设计笔记 |
| [legacy/feishu-doc-summary.md](legacy/feishu-doc-summary.md) | 飞书文档整理（最早构想） |
| [legacy/prototype-v3/](legacy/prototype-v3/) | 可视化 V3 静态原型 |
| [visualization-design.md](visualization-design.md) | 可视化 V1 方案（未实施即被否，决策历史） |
| [api/pi-tools-world.md](api/pi-tools-world.md) / [pi-tools-render.md](api/pi-tools-render.md) / [pi-tools-role-scheduler.md](api/pi-tools-role-scheduler.md) / [pi-tools-import.md](api/pi-tools-import.md) | PI 扩展工具文档（扩展机制已删，仅历史参考） |
| [project-overview.html](project-overview.html) | 08-01 项目全景图（历史快照，数据已过时） |
| [plans/2026-08-01-frontend-rust-redesign.md](plans/2026-08-01-frontend-rust-redesign.md) | Rust 前端方案（已弃用，实际走 JS 路线） |
| [plans/2026-08-01-main-session-sdk-implementation.md](plans/2026-08-01-main-session-sdk-implementation.md) / [data-layer-ports-implementation.md](plans/2026-08-01-data-layer-ports-implementation.md) / [data-layer-ports-execution-plan.md](plans/2026-08-01-data-layer-ports-execution-plan.md) / [orchestrator-standalone-implementation.md](plans/2026-07-31-orchestrator-standalone-implementation.md) | 被实施报告/执行方案取代的调研与执行计划 |

## 维护约定

1. **现行文档随代码改**：工具增删改 → 同步 api/ 对应小文档；流程变化 → 同步 USAGE.md；版本发布 → 写 CHANGELOG.md
2. **设计文档不改**：实施后冻结，状态以头部横幅为准；后续演进写新的 plans/yyyy-mm-dd-*.md
3. **新文档归位**：计划类 → `plans/`；核对类 → `audits/`；测试轮 → `audits/frontend-test-runs/`；过时即移 `legacy/` 并加横幅
4. **强一致性**：文档与实际项目状态必须一致，发现差异立即修正，不允许"文档说有但实际没有"或"实际有但文档没提"
5. **app-mode.md 已废弃**（2026-08-04）：原「应用内置模式」描述的扩展快照/重装链路随 pure-SDK 转型删除，保留作历史；Tauri 桌面分发为第二阶段 G6 待办
6. **2026-08-05 全量整理**：重写 4 份过时文档 + 更新 15 份偏差文档 + 标注 11 处 UX 未实现项，详见 [2026-08-04-documentation-inventory.md](2026-08-04-documentation-inventory.md) §八
