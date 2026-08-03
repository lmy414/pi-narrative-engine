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

> BUG-001 / BUG-002 历史溯源：首次见于 `2026-08-03-production-gap-bug-inventory.md` §2（用户实测上报），2026-08-03-fix-frontend-4-bugs 修复并实测确认。
> BUG-003 / BUG-004 历史溯源：同上文档 §2 Bug 3/4，修复轮以 2 临时项目补测通过（switch 清理 / 驻留自动刷新）。
> BUG-005 为 BUG-004 修复的同轮补丁（app.js `refreshShellStoryTime()`），首轮实测发现（顶栏不联动）后立即修复，复测 11/11 通过。
