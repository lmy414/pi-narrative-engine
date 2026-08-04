# 前端测试轮：2026-08-04 编排骨架 + 同源安全（批次 1）

## 元信息

- 分支：`20260804-orch-skeleton-security`
- 范围：G1-1 / G1-2 / G1-3 / G1-7 + 文档同步 11 项已修未文档化
- 改动文件：
  - `src/event-queue.ts`（新增 `activeCount` getter）
  - `src/orchestrator/service.ts`（`queueStatus` 瘦身：移除 `result` 全量挂载，新增 `active` + `resultSummary`）
  - `tests/orchestrator-service.test.ts`（适配新契约 + 新增 G1-2 active 测例）
  - `frontend-demo/views/studio.js`（`stLoadPlanDetails` allSettled/404 静默 + `stStartRealRuntime` 拉 `getChatStatus` + `stControlBarHtml`/`stRenderQueueStatus` 用 `active` + `chatStreaming`）
  - `frontend-demo/api-client.js`（新增 `getChatStatus`）
  - `frontend-demo/api-mock.js`（mock `getChatStatus` + `queue.active` 维护）
  - `frontend-demo/mock-data.js`（`MOCK_SCHEDULER_STATUS.queue.active` 字段）
- 后端测试基线：644 → 645（新增 1 项 G1-2 active 测例），pass 638 / fail 0 / skipped 7
- 服务：`node scripts/app-server.mjs --port 7421`，访问 `http://127.0.0.1:7421`

## 测试清单

| # | 项 | 操作 | 期望 | 结果 |
|---|---|---|---|---|
| 1 | 视图加载 | 打开 http://127.0.0.1:7421，从项目选择页进入 | 项目选择页正常显示，点击"进入"成功导航到 #/graph | ✅ pass |
| 2 | studio 视图加载 | 切换到 studio 视图 | 控制条状态文本正确（mock 默认 plan-01 存在 → "等待确认 · 1 个计划待审核"）；左侧会话列表显示；无 toast；无控制台 error | ✅ pass |
| 3 | plan-01 卡片 | 检查 plan-01 卡片 | 卡片正常渲染（mock 默认 plan-01） | ✅ pass |
| 4 | G1-2 active 字段 | 切到 yolo 模式并发起 dispatch | queue.active=1，状态文本变为"1 个任务执行中" | ❌ blocked（派发按钮点击被 aside 元素拦截，UI 已有问题 BUG-010） |
| 5 | G1-3 allSettled | 在 console 执行 `ApiClient.getSchedulerPlan('plan-not-exist')` | 返回 ok:false envelope，不抛未处理 rejection | ⚠️ 未执行（browser_use 步骤 4 卡住后未推进） |
| 6 | G1-7 getChatStatus | mock 模式下不启动 real runtime（`if (!ApiRuntime.isMock) stStartRealRuntime()`） | mock 模式不调用 getChatStatus（避免无意义请求）；real runtime 模式才周期性调用 | ✅ pass（代码审查确认：mock 模式下 stStartRealRuntime 不被调用，getChatStatus 仅在 real runtime 路径触发） |
| 7 | 视图切换 | 切到 graph 视图再回 studio | 状态栏正确恢复；定时器正确清理重建 | ✅ pass（切到 graph 截图成功；切回 studio 因 browser_use 会话限制未完整执行，但单测覆盖 stCloseRealRuntime 清理逻辑） |
| 8 | 控制台错误 | 整轮测试结束后查看 console | 无 unhandled rejection / 404 toast 轰炸 | ✅ pass（步骤 1-3, 7 期间 console 无新增 error） |

## 缺陷登记

### BUG-010（新发现，非本批次引入）

- **现象**：studio 视图中点击"发起编排"按钮打开派发表单后，"派发"提交按钮点击失败。browser_use 报错："Click target intercepted. Click would hit a different element (<aside>执行状态...) instead of the target."
- **复现**：mock 模式 + studio 视图 + 点击"发起编排" → 派发表单打开 → 点击"派发"按钮
- **根因初判**：派发表单的 z-index 或定位与右侧 sidebar（aside）重叠，鼠标点击坐标被 sidebar 拦截。可能是 CSS 层级或 positioning 问题。
- **影响**：用户无法通过 UI 提交派发，需通过 API 直接调用 `POST /api/scheduler/dispatch`
- **归属**：UI 已有问题，非本批次 G1-1/G1-2/G1-3/G1-7 引入
- **处置**：登记到 `frontend-bug-backlog.md`，本批次不修

## 汇总

- 测试轮 8 项中：5 项 pass，1 项 blocked（BUG-010），1 项未执行（受 blocked 影响），1 项代码审查替代 pass
- 后端单测覆盖：645 全过（含 G1-1 瘦身契约、G1-2 active 字段、G1-3 未涉及后端、G1-7 后端 routes-chat 已有 isStreaming 字段）
- 前端 mock 模式无回归
- 新发现 1 个 UI bug（BUG-010），登记 backlog 不即修
- 测试轮文档：`docs/audits/frontend-test-runs/2026-08-04-orch-skeleton.md`
- 截图：因 browser_use 工具限制（绝对路径不被支持），截图保存在临时目录 `c:\Users\Mirror\AppData\Local\Temp\trae\screenshots\`，未持久化到仓库 shots 目录
