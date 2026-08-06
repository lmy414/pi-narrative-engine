# 2026-08-06 后半链路（commit）"一直显示处理中"排查

> 现象（用户实测上报）：编排结果面板点击「提交落地」后，后半链路一直显示"处理中"，
> 没有报错、没有反馈。本文档为真实后端 + 向量（embedder）模式下的复现与根因定位，
> 供会话压缩后一次性处理。

## 一、复现方式

```powershell
# 1. 用真实小说项目 + 向量模式启动后端
node scripts/app-server.mjs --project "d:\claude\pi-ex\novel" --embed --port 7421

# 2. 浏览器打开 http://127.0.0.1:7421/ → 进入项目 → 创作编排（#/studio）

# 3. 直接走 API 触发前后半链路（等价于前端操作，便于观察）
#    dispatch（入队即返回，前半链路后台跑）
POST /api/scheduler/dispatch
{ "storyTime": "ch012.ev009", "instruction": "...", "characterIds": ["ent_char_rin"] }

#    commit（入队即返回，后半链路后台跑）
POST /api/scheduler/commit
{ "planId": "plan_xxx" }

#    status 轮询
GET /api/scheduler/status
```

## 二、验证结论（后端链路本身能完成，非必然死锁）

真实实测：dispatch（前半链路 planner+角色）约 60s 完成 plan `confirmed`；
commit（后半链路 reasoning+renderer）**71s 完成**，plan `confirmed→committing→committed`。
- reasoning 代理写 4 个世界图事件（`evt_ch012_ev010_*`）
- renderer 代理写章节 `ch012.ev010.md`（881 字）

即后端 commit 链路**能跑通**。用户看到的"一直处理中"由两个问题叠加。

## 三、根因分析

### 问题 1：前端 committing 阶段无任何中间进度反馈（体验主因）
`frontend-demo/views/studio.js` `stOrCommittingHtml()`（约 1185-1193 行）只渲染静态占位：
```
后半链路 … 提交处理中，请稍候…
```
只有转圈图标，**无阶段、无百分比、无已耗时、无异常提示**。而后半链路是
reasoning + renderer 两个子代理、多轮 LLM 调用，真实耗时 60~70s+。
用户在此窗口看不到任何推进信号，误判为"卡死"。

前端轮询（`stOrPollStatus`，约 1261-1302 行）在存在 committing plan 时每 2s 拉一次，
逻辑正常，会在 committed 后更新面板；问题是**拉取期间无中间态可展示**。

### 问题 2：无超时兜底，LLM 挂起会永久卡 committing（真死锁风险）
`src/orchestrator.ts` `runReasoning` / `runRenderer`（约 491-554 行）都是
`await agent.prompt("")` 等子代理整个执行循环结束。若 deepseek 偶发无响应
（与 BUG-025 / BUG-026 同类不稳定），`prompt` 永不 resolve。

`src/agents/collect.ts` `collectSubmission()`（28-51 行）的 **180s 超时只 reject 产出
promise，不取消 `agent.prompt`**。代码顺序是 `await prompt()` 在前，超时后仍
走不到 `await collected.promise`，超时兜底形同虚设：
- commit worker 永久 `running`
- plan 永久 `committing`
- 无 error、无反馈

这正是"**一直**处理中"的根因。

## 四、相关代码位置

| 位置 | 说明 |
|------|------|
| `frontend-demo/views/studio.js#L1185-L1193` | `stOrCommittingHtml`：committing 占位（无进度） |
| `frontend-demo/views/studio.js#L1261-L1302` | `stOrPollStatus`：轮询，有 committing → 2s |
| `src/orchestrator.ts#L375-L488` | `runPostRolePipeline`：第二后半链路入口 |
| `src/orchestrator.ts#L491-L520` | `runReasoning`：`await reasoning.prompt("")` 无超时 |
| `src/orchestrator.ts#L522-L554` | `runRenderer`：`await renderer.prompt("")` 无超时 |
| `src/agents/collect.ts#L28-L51` | `collectSubmission`：超时只兜产出 promise，不兜 prompt |
| `src/orchestrator/service.ts#L263-L311` | `runCommitPipeline`：commit worker |
| `src/orchestrator/service.ts#L314-L327` | `onCommitDone`：status committed/error |

## 五、修复方案（供决策）

### 方案 A（推荐，消除死锁）：给子代理 prompt 加整体超时兜底
- 用 `Promise.race` + AbortController（或 pi Agent 的 abort 能力）对
  `await agent.prompt("")` 加整体超时（如 3~5 分钟）。
- 超时抛错 → `runCommitPipeline` catch → `onCommitDone` 置 plan `error` →
  前端显示「失败」（可重试/丢弃），不再永久卡 committing。
- 需确认 pi Agent 是否暴露 abort/中断能力，避免超时后子代理仍占用资源。

### 方案 B（消体验）：前端 committing 展示阶段/耗时反馈
- 复用 DebugBus 已埋的 `reasoner` / `renderer` span（`orchestrator.ts`
  `startSpan(bus, "reasoner"/"renderer", ...)`），在 committing 占位中显示
  "推理中 → 渲染中" 阶段，或至少显示已进行秒数。
- 或后端 commit 队列状态暴露子代理阶段。

## 六、附带的检查结论（本会话完成）

### BUG-023 / BUG-024 已通过真实后端 + 向量验证 → 可标记 fixed
- **BUG-023（空态"加载中"空转）**：真实后端 `plans: []` 时，前端面板正确显示空态
  「在聊天框描述创作意图，编排结果会显示在这里」，无加载死循环。
- **BUG-024（提交/丢弃按钮不可交互）**：真实 dispatch 生成 `confirmed` plan 后，
  详情面板正确渲染「提交落地」「丢弃」按钮（`disabled=false` 带 onclick）。
  修复轮次：2026-08-06（BUG-019 编排结果面板这批）。

### 新发现：前端 default 选择问题（未修，待排查）
面板刷新后 `selectedPlanId` 偶为 `null`、详情不自动加载（即使有 confirmed plan，
`stOrResolveDefaultPlan` 应选中但未生效）。疑似 `stOrFetchDetail` 因 `gen` 失效或
detail 渲染时序问题被跳过。需单独排查，非本次重点。

## 七、待办清单（已全部完成 · 2026-08-06-bug028-commit-timeout-progress）

- [x] 方案 A：子代理 prompt 加整体超时兜底
  - 确认 pi Agent 暴露 `abort()` + `signal`（`@earendil-works/pi-agent-core` Agent 类型）
  - `orchestrator.ts` 新增 `promptAndCollectWithTimeout` helper：`Promise.race` 300s 整体超时 → `agent.abort()` 中断 → 抛错 → `runCommitPipeline` catch → plan 转 error
  - `runReasoning` / `runRenderer` 改用 helper（替换原 `await agent.prompt("") + await collected.promise`）
- [x] 方案 B：前端 committing 阶段/耗时反馈
  - `orchestrator.ts` `runPostRolePipeline` 新增 `onStage?: (stage: "reasoning" | "rendering") => void` 回调
  - `service.ts` plan 缓存新增 `commitStartedAt` / `commitStage`；`runCommitPipeline` 设值 + 传 onStage；`onCommitDone` 清理 commitStage
  - `PlanDetail` / `listPlans` 暴露 `commitStartedAt` / `commitStage` 字段
  - 前端 `stOrCommittingHtml(detail)` 显示"推理中/渲染中… · 已进行 Ns"
  - `stOrPollStatus` committing 期间实时同步 plans 列表的 commitStage 到 detail 缓存
- [x] 附带：前端 default 选择（detail 不自动加载）已定位并修复
  - 根因：`stOrPollStatus` 调 `stOrFetchDetail(defaultId)` 时未设 `selectedPlanId`，而 `stOrFetchDetail` 只拉 detail 不设 selectedPlanId → `stOrDetailHtml` 因 `selectedPlanId=null` 显示空态
  - 修复：default 选择分支调 `stOrFetchDetail` 前先 `setStOrState('selectedPlanId', defaultId)`
- [x] 更新 `docs/audits/frontend-bug-backlog.md`：BUG-028 标记 fixed，BUG-023/024 已在上轮标记