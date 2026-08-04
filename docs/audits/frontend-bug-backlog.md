# 前端缺陷 Backlog

> 跨测试轮未修复的缺陷汇总。每轮测试结束后，AI 按 `docs/frontend-test-discipline.md` 附录 C 的规则同步到本表。
> 修复后标记状态并附修复轮次。

## 字段说明

| 字段 | 含义 |
|------|------|
| 编号 | 与测试轮文档中的 BUG-xxx 一致 |
| 首次发现轮次 | 形如 `2026-08-03-xxx` |
| 严重度 | P0 / P1 / P2 / P3，定义见规程附录 B |
| 页面 | 受影响的 frontend-demo 页面 |
| 摘要 | 一句话描述 |
| 状态 | open（未修复）/ fixed（已修复）/ wontfix（经用户确认不修） |
| 修复轮次 | fixed 时填，形如 `2026-08-04-xxx` |

## 缺陷列表

| 编号 | 首次发现轮次 | 严重度 | 页面 | 摘要 | 状态 | 修复轮次 |
|------|------------|--------|------|------|------|---------|
| BUG-001 | 2026-08-03-baseline-recheck | P1 | 文件页 #/files | 文件树节点不显示名称（后端 DTO 无 name 字段，前端用 node.name 渲染空白） | fixed | 2026-08-03-fix-frontend-4-bugs |
| BUG-002 | 2026-08-03-baseline-recheck | P1 | 图页 #/graph | 快速记事件表单缺 entityType 和 newFacts.name 字段，导致新建 birth 实体无名 | fixed | 2026-08-03-fix-frontend-4-bugs |
| BUG-003 | 2026-08-03-baseline-recheck | P0 | 项目切换 | activateProject 不清理 viewState，切换项目后 studio/files/graph 状态污染 | fixed | 2026-08-03-fix-frontend-4-bugs |
| BUG-004 | 2026-08-03-baseline-recheck | P1 | 图页/studio | 世界图写入后需 F5（驻留视图无失效 + storyTime 不前进 + storyTimes 陈旧） | fixed | 2026-08-03-fix-frontend-4-bugs |
| BUG-005 | 2026-08-03-fix-frontend-4-bugs | P2 | 图页 #/graph | 驻留刷新后顶栏 StoryTime 选择器不联动（renderView 只重渲视图区，壳层陈旧） | fixed | 2026-08-03-fix-frontend-4-bugs |
| BUG-006 | 2026-08-03-fix-frontend-4-bugs | P3 | 全局 | /favicon.ico 404（index.html 未声明 favicon） | fixed | 2026-08-03-fix-favicon-embed |
| BUG-007 | 2026-08-03-fix-frontend-4-bugs | P3 | studio | 无 --embed 启动时 chat/scheduler 端点 501 EMBEDDER_UNAVAILABLE（环境性，待带 --embed 复测） | fixed | 2026-08-03-fix-favicon-embed |
| BUG-008 | 2026-08-03-fix-audit-tier1 | P1 | studio | 计划「提交」按钮点击后无任何视觉反馈（withLoading 的 loading 覆盖层无对应 CSS，为死代码），commit 为 LLM 重操作可能数秒~数十秒无反应，用户误以为按钮失效 | fixed | 2026-08-03-fix-bug8-9 |
| BUG-009 | 2026-08-03-fix-audit-tier1 | P2 | 设置页 #/settings | 设置面板打开响应慢（settingsLoad 串行拉 8 个端点，其中 /api/admin/version 走 git ls-remote 网络请求实测 4.5s~14.4s，doctor spawn git；全部串行阻塞首屏渲染） | fixed | 2026-08-03-fix-bug8-9 |
| BUG-010 | 2026-08-04-orch-skeleton | P1 | studio | 派发表单"派发"提交按钮点击被右侧 sidebar 拦截（z-index/positioning 重叠，browser_use 报 Click target intercepted），用户无法通过 UI 提交派发 | fixed | 2026-08-04-batch3-frontend-robust |

> BUG-001 / BUG-002 历史溯源：首次见于 `2026-08-03-production-gap-bug-inventory.md` §2（用户实测上报），2026-08-03-fix-frontend-4-bugs 修复并实测确认。
> BUG-003 / BUG-004 历史溯源：同上文档 §2 Bug 3/4，修复轮以 2 临时项目补测通过（switch 清理 / 驻留自动刷新）。
> BUG-005 为 BUG-004 修复的同轮补丁（app.js `refreshShellStoryTime()`），首轮实测发现（顶栏不联动）后立即修复，复测 11/11 通过。
> BUG-008 / BUG-009 修复方向（2026-08-03 代码层定位，用户要求整理待修）：
> - BUG-008：app.js `withLoading` 增加可见 loading 覆盖层（补 CSS）或按钮内联 loading 态；commit 前禁用按钮防重复点击。
> - BUG-009：`settingsLoad` 改 Promise.all 并行（appConfig/llm/rulesets/novel/env 一组，embedder/version/doctor 懒加载组）；`compareVersions` 加超时（如 3s 超时返回 remote=null，网络慢不阻塞 UI）。
>
> **2026-08-03-fix-bug8-9 修复实现**：withLoading 增加全局覆盖层 `#app-loading-overlay`（150ms 延迟防闪烁，可见期间 pointer-events 拦截点击防重复提交）；settingsLoad 拆快组（appConfig+llm 并行）+ 项目组（rulesets/novel/env Promise.allSettled 并行）+ 懒加载组（embedder 等 / version/doctor 后台拉取，仅 about 面板时自动刷新）；compareVersions 加 `timeoutMs` 默认 5s（kill 子进程按不可达处理）。测试轮 13/13 通过（设置页首屏 4.5~14s → 140ms）。
