# 文档盘点与分类（2026-08-04）

> 日期：2026-08-04
> 性质：docs/ 全量 84 个文档的盘点与分类（G4 文档对齐的前置输入）
> 分类方法：按「与当前代码状态的贴合度」分五类——现行有效 / 设计归档 / 过程档案 / 历史归档 / 滞后待更新
> 统计：docs/ 共 84 个文件（md 80 + html 4），按目录：根 12 / api 19 / audits 8 / frontend-test-runs 11 / legacy 5+1 / plans 25 / superpowers 2 / ux 1

---

## 一、现行有效（以当前代码为准，维护中）— 24 个

### 1.1 根文档（8）

| 文档 | 说明 |
|---|---|
| `README.md`（仓库根） | 项目门面：简介、架构、快速开始 |
| `CHANGELOG.md`（仓库根） | 变更记录 |
| `docs/frontend-requirements.md` | **前端目标规格 v2.1**（交付对接唯一规格；⚠️ CORS 军规 4 滞后见第五节） |
| `docs/frontend-test-discipline.md` | 前端测试纪律（硬约束，AI 必守） |
| `docs/frontend-backend-api-audit.md` | 前后端 API 契约核对报告（08-02） |
| `docs/ux/frontend-ux-requirements.md` | 前端 UX 需求 v1.0（功能/交互，不含视觉） |
| `docs/visualization-v3-design.md` | 现行可视化设计（已实施，frontend-demo 依据） |
| `docs/novel-project-structure.md` | 小说工程结构定义 v1 |

### 1.2 活跃流程工具（2）

| 文档 | 说明 |
|---|---|
| `docs/audits/frontend-bug-backlog.md` | 前端缺陷 backlog（活跃维护，BUG-001~010 全 fixed） |
| `docs/plans/2026-08-04-phase2-plan.md` | 第二阶段开发目标计划（当前执行计划，批次 1-3 已实施） |

### 1.3 API 参考（14）

| 文档 | 说明 |
|---|---|
| `docs/api/README.md` | API 总入口（已更新 pi-tools 历史标注 ✅） |
| `docs/api/overview.md` | 架构概览 / 存储 / storyTime 约定 |
| `docs/api/unified-server.md` | 统一服务 HTTP 端点 |
| `docs/api/chat.md` | 主会话聊天 API |
| `docs/api/visualizer.md` | 可视化服务 |
| `docs/api/world-graph.md` | underworld-graph 包 API |
| `docs/api/types.md` / `core-classes.md` / `dependencies.md` | 类型 / Search·Embedder 类 / 依赖 |
| `docs/api/scheduler.md` / `renderer.md` / `role-pool.md` / `novel-importer.md` | 四个子包 API |
| `docs/api/debug-bus.md` | 调试总线 SSE |
| `docs/api/sdk-search.md` | SDK 检索能力（⚠️ 依赖名待核对：@nicia-ai/typegraph vs sqlite-vec） |

## 二、设计归档（已实施/已决策，冻结保存）— 12 个

| 文档 | 对应实现 |
|---|---|
| `plans/2026-07-24-role-pool-design.md` / `2026-07-24-role-pool.md` | packages/role-pool |
| `plans/2026-07-24-renderer.md` | packages/renderer |
| `plans/2026-07-25-scheduler-design.md` | packages/scheduler |
| `plans/2026-07-29-app-architecture-design.md` | src/app + @pi/admin + novel-launcher |
| `plans/2026-07-29-config-ui-design.md` | settings.js + @pi/admin |
| `plans/2026-07-31-underworld-graph-extraction.md` | underworld-graph 独立包 |
| `plans/2026-07-31-sdk-integration-architecture.md` | pi SDK 迁移 |
| `plans/2026-07-31-sdk-tool-implementation.md` / `tool-allocation-design.md` / `subagent-orchestrator-design.md` | SDK 工具 / 分配 / 子代理编排 |
| `plans/2026-07-31-orchestrator-standalone-research.md` | 编排器独立化调研 |

## 三、过程档案（审计/测试轮/执行记录，只读存档）— 23 个

### 3.1 审计与执行记录（8）

| 文档 | 说明 |
|---|---|
| `audits/2026-07-25-requirements-audit.md` | 需求-源码核对（7 项核对 + 修复史） |
| `audits/2026-07-27-fix-plan.md` | P0 修复执行文档（已实施完毕） |
| `audits/2026-07-29-data-flow-audit.md` + `.html` | 数据流审计（dispatch/commit/schema） |
| `audits/2026-07-30-code-audit.md` | 07-30 审计（M 级清单，⚠️ 行号过期） |
| `audits/2026-08-03-code-audit.md` | 08-03 全量审计（🔴 1-11 已修复并文档同步） |
| `audits/2026-08-03-production-gap-bug-inventory.md` | 生产差距 bug 清单（用户实测；批次 1-3 修复并文档同步） |

### 3.2 前端测试轮（11）

| 文档 | 说明 |
|---|---|
| `audits/frontend-test-runs/2026-08-03-*.md`（7 个） | 08-03 七轮：baseline-recheck / fix-frontend-4-bugs / fix-favicon-embed / fix-audit-tier1 / fix-tier2 / fix-bug8-9 / audit-tier3 |
| `audits/frontend-test-runs/2026-08-04-*.md`（4 个） | 08-04 四轮：remove-old-ui / orch-skeleton / batch2-orch-visibility / batch3-frontend-robust |
| `audits/frontend-test-runs/shots/` | 截图存档 |

### 3.3 落地报告（4）

| 文档 | 说明 |
|---|---|
| `plans/2026-08-01-data-layer-ports-implementation-report.md` | Ports 落地报告（⚠️ A5 状态滞后，见第五节） |
| `plans/2026-08-01-orchestrator-standalone-implementation-report.md` | 编排器独立化落地报告 |
| `plans/2026-08-01-main-session-execution-plan.md` | 主会话 SDK 落地（✅ 已实施完成标注） |
| `plans/2026-08-02-frontend-backend-handoff-plan.md` | 前后端契约收敛计划（⚠️ 签字项未勾，见第五节） |

## 四、历史归档（概念溯源/已废弃，勿当现行依据）— 17 个

| 文档 | 说明 |
|---|---|
| `legacy/v2-design-notes.md` | V2 概念源头（三分架构/信息差） |
| `legacy/world-graph-storage-design.md` | bi-temporal 存储概念源头 |
| `legacy/import-novel-v2-redesign.md` | V2 导入器重设计笔记 |
| `legacy/feishu-doc-summary.md` | 飞书文档整理（最早构想） |
| `legacy/prototype-v3/README.md` + `v3/index.html` | V3 静态原型 |
| `visualization-design.md` | 可视化 V1（未实施即被否） |
| `api/pi-tools-world.md` / `pi-tools-render.md` / `pi-tools-role-scheduler.md` / `pi-tools-import.md` | **PI 扩展工具文档（扩展已删，api/README 已标历史）** |
| `project-overview.html` | 08-01 项目全景图（数据已过时，纯历史快照） |
| `plans/2026-08-01-frontend-rust-redesign.md` | Rust 前端方案（**已弃用**，实际走 JS 路线） |
| `plans/2026-07-31-orchestrator-standalone-implementation.md` | 编排器独立化执行方案（已被 implementation-report 取代） |
| `plans/2026-07-31-underworld-graph-extraction.md` | （实为设计归档——已实施，归二类；此处不重复） |
| `plans/2026-08-01-main-session-sdk-implementation.md` | 主会话调研（已被 execution-plan 取代） |
| `plans/2026-08-01-data-layer-ports-implementation.md` + `execution-plan.md` | Ports 调研与执行计划（已被 report 取代） |
| `plans/2026-08-02-studio-data-alignment.md` | studio 数据对齐决策（已被 frontend-requirements 覆盖） |

## 五、滞后待更新（内容与当前代码不符，G4 任务）— 11 个

> 执行状态：✅ 本节已按 2026-08-04 文档对齐轮全部处理，逐项见"修复方向"列（✅ = 已落实）。

| 文档 | 滞后内容 | 修复方向 |
|---|---|---|
| `docs/README.md` | 索引缺 25+ 新文档（frontend-requirements / 测试纪律 / UX / phase2-plan / 08-03~08-04 audits / test-runs / backlog / frontend-backend-api-audit）；三分法不反映现实 | ✅ 已重写：五类结构 + 全量索引 |
| `docs/SETUP.md` | 整篇描述已废弃的 sync/扩展模式（`.pi/extensions`、`npm run sync`、扩展重装） | ✅ 已重写：纯 SDK 独立应用部署 |
| `docs/app-mode.md` | 描述已删除的 launch-pi / extension-snapshot / reinstall 链路 | ✅ 已重写：当前形态说明 + 废弃链路记录 + G6 待办 |
| `docs/USAGE.md` | 含扩展时代描述（§2 启动 pi、§7 入口、§9 多项目、§10 FAQ 绑定问题） | ✅ 已修订：§2/§7/§9/§10 改为 SDK 形态 |
| `docs/frontend-requirements.md` | 军规 4 写"允许跨域 *"（实际已收紧为恶意 Origin 403） | ✅ 已更新：同源部署 + 403 ORIGIN_REJECTED |
| `plans/2026-08-01-old-code-cleanup-report.md` + `execution-plan.md` | 状态"待实施"（实际已实施完成） | ✅ 已改"✅ 已实施完成" |
| `plans/2026-08-01-data-layer-ports-implementation-report.md` | "A5 未做"（实际 /api/admin/llm* 五端点已实现） | ✅ 已改"A5 ✅ 已完成（2026-08-04 复核）" |
| `superpowers/plans/2026-08-02-frontend-ui-alignment.md` | 勾选框全部未勾（实际已实施） | ✅ 已加"✅ 已实施完成"横幅 |
| `plans/2026-08-02-frontend-backend-handoff-plan.md` | 验收签字 A1-A12 未勾选 | 🟡 标注待 G4-4（生产验收为执行任务，非文档更新） |
| `docs/audits/2026-07-30-code-audit.md` | 行号基于旧代码 | ✅ 已加基线标注 + 指向 08-03 复核 |
| `docs/api/sdk-search.md` | 依赖名待核对（inventory 初判 @nicia-ai/typegraph 可能过时） | ✅ 已核对：@nicia-ai/typegraph ~0.40.0 为 underworld-graph 实际依赖，文档正确，无需修改 |

## 六、分类统计

| 类 | 数量 | 处理 |
|---|---|---|
| 一、现行有效 | 24 | 保持，随代码维护 |
| 二、设计归档 | 12 | 冻结，不改 |
| 三、过程档案 | 23 | 只读存档，补状态标注即可 |
| 四、历史归档 | 17 | 冻结，移 legacy/ 或保留原位加横幅 |
| 五、滞后待更新 | 11 | **G4 文档对齐任务清单** |
| **合计** | **87*** | |

*注：84 个文件 + 仓库根 README/CHANGELOG 两个目录外文档 + 统计口径重叠（四类中含二类重复计数项 1 个）≈ 87 行次。以「84 个 docs/ 文件」为准。

## 七、后续动作建议（G4）

1. 按第五节 11 项清单逐一更新（每项改完即登记）
2. `docs/README.md` 索引重写（本盘点为底稿），采用五类结构
3. 滞后项修正后，把「文档滞后批」从 phase2-plan 的风险清单移除
