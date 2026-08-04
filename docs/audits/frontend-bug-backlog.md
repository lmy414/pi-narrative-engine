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
| BUG-011 | 2026-08-04-user-reported | P1 | 图页 #/graph → 实体详情 Drawer | 切换「历史时间点」滑块后，声明/关系/可见性/事件 4 个 tab 内容不按时间点过滤，始终显示全量历史数据（仅「属性」tab 走 snapshot 联动） | fixed | 2026-08-04-batch4-frontend-bugs |
| BUG-012 | 2026-08-04-user-reported | P1 | studio → 派发/聊天 @ 提及 | @ 提及实体功能无法匹配实体：getEntityAtStoryTime 重建 snapshot.properties 时丢弃了 name 字段（MOCK_DECLARATIONS 无 name 声明），导致搜索过滤 name.includes(term) 永远命中空串；同时派发指令 textarea 缺 oninput handler，placeholder 暗示 @ 提及可用但实际无反应 | fixed | 2026-08-04-batch4-frontend-bugs |
| BUG-013 | 2026-08-04-user-reported | P1 | studio → 聊天区 | 聊天区无条件自动滚到底部（stScrollChatToBottom 在 8 处被调用：初始渲染/实时消息/工具事件/编排完成/流式打字/消息追加/计划卡片渲染），用户滚动查看历史时被强制拉回底部。建议改为：移除无条件自动滚动，增加「跳转到最新」按钮 | fixed | 2026-08-04-batch4-frontend-bugs |
| BUG-014 | 2026-08-04-user-reported | P1 | studio → 提交(commit) | 「提交」按钮点击后「处理中」阻塞时间过长。**后端准确流程**：plan 模式分两阶段——(1)dispatch 阶段(异步)：入队即返回，后台 worker 串行跑 planner LLM + 角色代理 LLM×N，完成后缓存 plan；(2)commit 阶段(同步)：runPostRolePipeline 串行跑 reasoning LLM + renderer LLM，共 2 次 LLM 调用。用户截图场景为 plan 已展示角色演绎结果(前半链路已完成)，点击提交触发后半链路 2 次 LLM 串行调用，每次数秒~数十秒。前端 withLoading 全程同步阻塞无阶段反馈。**用户建议修复方向：commit 改为异步**——将 runPostRolePipeline 也入 EventQueue，commit 入队即返回(与 dispatch 行为一致)，前端轮询 queue status 获取结果，plan 卡片显示推理中/渲染中进度 | open | |
| BUG-015 | 2026-08-04-user-reported | P2 | studio → 聊天/编排面板 | 聊天/编排面板出现空白气泡（截图显示多条 AI 助手消息气泡内容为空）。根因：mock 模式下 stRunOrchestration 的编排脚本中 `stream` 步骤文本为固定字符串，但 stEnsureLiveMessage 创建了气泡 DOM 后 stStartStreaming 填充文本，若流式未完成就被 finish 覆盖或 stStreamStep 未执行完整，则出现空文本气泡；另外 stEnsureLiveMessage 创建 live DOM 时 text 为空串，若后续 stream 步骤未触发或被中断，该气泡保持空内容 | fixed | 2026-08-04-batch4-frontend-bugs |

> BUG-001 / BUG-002 历史溯源：首次见于 `2026-08-03-production-gap-bug-inventory.md` §2（用户实测上报），2026-08-03-fix-frontend-4-bugs 修复并实测确认。
> BUG-003 / BUG-004 历史溯源：同上文档 §2 Bug 3/4，修复轮以 2 临时项目补测通过（switch 清理 / 驻留自动刷新）。
> BUG-005 为 BUG-004 修复的同轮补丁（app.js `refreshShellStoryTime()`），首轮实测发现（顶栏不联动）后立即修复，复测 11/11 通过。
> BUG-008 / BUG-009 修复方向（2026-08-03 代码层定位，用户要求整理待修）：
> - BUG-008：app.js `withLoading` 增加可见 loading 覆盖层（补 CSS）或按钮内联 loading 态；commit 前禁用按钮防重复点击。
> - BUG-009：`settingsLoad` 改 Promise.all 并行（appConfig/llm/rulesets/novel/env 一组，embedder/version/doctor 懒加载组）；`compareVersions` 加超时（如 3s 超时返回 remote=null，网络慢不阻塞 UI）。
>
> **2026-08-03-fix-bug8-9 修复实现**：withLoading 增加全局覆盖层 `#app-loading-overlay`（150ms 延迟防闪烁，可见期间 pointer-events 拦截点击防重复提交）；settingsLoad 拆快组（appConfig+llm 并行）+ 项目组（rulesets/novel/env Promise.allSettled 并行）+ 懒加载组（embedder 等 / version/doctor 后台拉取，仅 about 面板时自动刷新）；compareVersions 加 `timeoutMs` 默认 5s（kill 子进程按不可达处理）。测试轮 13/13 通过（设置页首屏 4.5~14s → 140ms）。
