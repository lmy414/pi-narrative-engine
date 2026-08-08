# 前端测试轮：世界图 3D 容器脱节修复 BUG-039（2026-08-09）

> 日期：2026-08-09
> 触发：用户报告「世界图会在部分情况下渲染异常」+ 截图（3D 场景只剩文字标签，无节点几何体、无连线）
> 修改：`frontend-demo/views/graph.js` graphInit3D——增量更新分支加 canvas 存活检查，容器已换则销毁重建
> 服务：`node scripts/app-server.mjs --project D:/claude/pi-ex/novel --port 7421 --embed`
> 状态：✅ 已跑完

## 根因（既有 bug，BUG-036 引入的回归）

1. `ViewRender.graph` 每次渲染**整体替换** `#graph-3d` 容器（innerHTML 全量重建视图）
2. BUG-036 的增量更新：`_graph3d` 实例存在时不销毁、只 `_graph3d.graphData(...)` 更新数据（保留相机）
3. 但旧 canvas 挂在**已废弃的旧容器**里被丢弃 → **新容器只剩标签层**（标签是 DOM 层，与 WebGL 无关）
4. 任何触发视图重渲染的操作（切 storyTime / 切「显示已闭合」/ 快速记事件 / 搜索防抖重建 / 筛选）后出现「只剩标签悬浮，无节点/连线」

修复：增量分支先查 `container.querySelector('canvas')` 是否存活——存活（同容器，数据变化）才走增量更新；已随旧容器废弃则 `graphDispose3D()` 销毁重建（配合本轮 01 的 onEngineStop 取景，重建后自动覆盖全节点）。

## 产出清单

| # | 测试项 | 操作 | 预期 | 结果 |
|---|---|---|---|---|
| 1 | 容器内 canvas 检查 | reload 后查 DOM | #graph-3d 内有 canvas（1376x793） | ✅ PASS |
| 2 | 初始渲染完整 | reload + 截图 | 节点几何体（类型区分）+ 连线 + 标签全渲染 | ✅ PASS（截图 03） |
| 3 | 容器替换后重建 | 切「显示已闭合」（renderView+reload） | canvas 重建、场景仍完整 | ✅ PASS（此前此操作后只剩标签） |
| 4 | 容器替换后视觉 | 切回 + 截图 | 节点/连线/标签仍全渲染 | ✅ PASS（截图 04） |
| 5 | 手动 ForceGraph3D 隔离验证 | console 手动实例化 | 库本身正常（排除 CDN/three 嫌疑） | ✅ PASS（canvas 创建成功） |
| 6 | 全套件回归 | npm test | 783 全绿 | ✅ PASS |

## 截图

`docs/audits/frontend-test-runs/shots/2026-08-09-wg-render-debug/`（02-current-scene.png 修复前异常态 / 03-after-fix-initial.png / 04-after-fix-rerender.png 修复后）

## 缺陷登记

无新增。根因 BUG-039 为本轮修复对象；视角邻居集数据问题（「与岛村看板」related_to 安达而非岛村）已在 2026-08-09-graph-3d-viewfit.md 登记。

## 汇总

6/6 通过。复现用户截图异常态 → 定位容器脱节根因 → 修复（canvas 存活检查 + 销毁重建）→ 初始渲染与容器替换路径均验证完整渲染。
