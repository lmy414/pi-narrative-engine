# 前端测试轮：批次 3 前端可用性（BUG-010 修复验证）

> 日期：2026-08-04
> 特性：batch3-frontend-robust
> 测试环境：mock 模式（`?mock=1`），http://127.0.0.1:7421
> 测试方法：browser_evaluate 几何测量 + browser_click 真实点击
> 关联：[批次 3 计划](../../plans/2026-08-04-phase2-plan.md#批次-3前端可用性--编排健壮性2026-08-04)

## 测试范围

| # | 项目 | 验证方式 |
|---|------|---------|
| T1 | BUG-010 派发按钮不再被 sidebar 覆盖 | browser_evaluate `elementFromPoint` + `getBoundingClientRect` |
| T2 | BUG-010 派发按钮可真实点击 | browser_click + 观察是否 intercepted |

## 修复内容

BUG-010 根因：`.st-dispatch-row` 内 StoryTime input(130px) + 派发按钮在窄视口下溢出 `main.st-chat` 边界，被右侧 `aside.st-sidebar` 不透明背景覆盖。

CSS 修复（`frontend-demo/styles/views.css`）：
- `.st-dispatch-controls` 加 `flex-wrap: wrap`（空间不足时 dispatch-row 换行）
- `.st-dispatch-mention` 加 `min-width: 0; flex: 1 1 180px`（可收缩，给 dispatch-row 留空间）
- `.st-dispatch-row` 加 `flex-shrink: 0`（不被挤压，保持按钮完整可点击）

## 测试结果

| # | 项目 | 结果 | 证据 |
|---|------|------|------|
| T1 | 派发按钮不再被 sidebar 覆盖 | ✅ pass | `elementFromPoint(btnCenter)` 返回 BUTTON（非 ASIDE.st-sidebar）；`btnRightInsideMain=true`（按钮右边界 ≤ main 右边界） |
| T2 | 派发按钮可真实点击 | ✅ pass | `browser_click` 成功触发，console 无 intercepted 报错，空值校验 toast 正常弹出 |

## 发现的问题

无。本批仅 BUG-010 修复，验证通过。

## 总结

2/2 pass。BUG-010（P1 前端阻塞）已修复，派发按钮在窄视口下不再被 sidebar 拦截，studio 派发流程恢复可用。
