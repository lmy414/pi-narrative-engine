# 前端测试轮：批次 2 编排可见性（G1-4/5/6 + M-Collab-2）

> 日期：2026-08-04
> 特性：batch2-orch-visibility
> 测试环境：mock 模式（`?mock=1`），http://127.0.0.1:7421
> 测试方法：browser_evaluate 注入数据验证（绕过 BUG-010 派发按钮拦截）
> 关联：[批次 2 计划](../../plans/2026-08-04-phase2-plan.md#附录-a执行进度登记)

## 测试范围

| # | 项目 | 验证方式 |
|---|------|---------|
| T1 | G1-4 空指令校验 | browser_evaluate 调用 `stSubmitDispatch()` |
| T2 | G1-4 空 StoryTime 校验 | browser_evaluate 调用 `stSubmitDispatch()` |
| T3 | G1-4 空角色校验 | browser_evaluate 调用 `stSubmitDispatch()` |
| T4 | G1-4 默认文案无残留 | browser_evaluate 检查 placeholder/value |
| T5 | G1-6 队列错误可见化 | browser_evaluate 调用 `stRenderQueueStatus()` |
| T6 | G1-5 yolo 结果卡片 | browser_evaluate 注入 done 条目 + `stRenderPlanCards()` |
| T7 | M-Collab-2 message_end 错误标红 | 代码审查（mock SSE 不推送 message_end） |

## 测试结果

| # | 项目 | 结果 | 证据 |
|---|------|------|------|
| T1 | G1-4 空指令校验 | ✅ pass | `stSubmitDispatch()` 同步触发 toast"请填写编排指令" |
| T2 | G1-4 空 StoryTime 校验 | ✅ pass | toast"请填写 StoryTime（如 ch007.ev001）" |
| T3 | G1-4 空角色校验 | ✅ pass | toast"请 @ 提及至少一个角色参与编排" |
| T4 | G1-4 默认文案无残留 | ✅ pass | placeholder=`"指令：描述接下来要发生的剧情，@ 提及角色可指定参演…"`（无艾莉亚/第七星港）；StoryTime 值来自 `App.storyTime`（非硬编码 `ch006.ev008`） |
| T5 | G1-6 队列错误可见化 | ✅ pass | `#st-queue-errors` 展示"派发失败：retrieval_plan 参数非法：characterIds 为空" |
| T6 | G1-5 yolo 结果卡片 | ✅ pass | `#st-plan-cards` 渲染"yolo 编排结果""正文/ch007.md""2 产出 · 0 错误 · 1842 字" |
| T7 | M-Collab-2 message_end 错误标红 | ✅ pass（代码审查） | `studio.js stHandleChatEvent` 已处理 `message_end`，`stopReason=error` 时调 `stRenderRealLiveMessage` 标红 |

## 发现的问题

### BUG-010（既有，仍 open）

- 派发按钮被右侧"执行状态"侧边栏拦截（z-index/positioning 重叠）
- 本轮用 browser_evaluate 调用函数绕过，未点击按钮
- 状态：open（待后续 CSS 专项修）

### mock 初始化缺陷（本轮发现，已当场修复）

- **现象**：`ViewAfterRender.studio` 在 mock 模式下不调用 `stRenderQueueStatus`（原代码第 158 行 `if (!ApiRuntime.isMock) stStartRealRuntime()`），导致 `#st-queue-errors` 在 mock 模式下页面加载后初始为空
- **根因**：mock 模式跳过 `stStartRealRuntime`，而 `stRenderQueueStatus` 只在轮询回调中被调用
- **影响**：仅 mock 模式，真实模式不受影响（`stStartRealRuntime` 轮询会调 `stRenderQueueStatus`）
- **修复**：`ViewAfterRender.studio` 加 `else stRenderQueueStatus()`（mock 模式下也渲染一次队列状态）
- **验证**：修复后页面加载即可见 `#st-queue-errors` 内容，无需手动调用

## 总结

7/7 pass。BUG-010 仍 open（既有问题，非本批引入）。mock 初始化缺陷已当场修复（1 行改动，`ViewAfterRender.studio` mock 分支补 `stRenderQueueStatus()`）。
