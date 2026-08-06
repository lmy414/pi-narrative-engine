# BUG-019 编排结果展示设计

## 1. 背景与目标

BUG-019 的根因不是调度器后端能力缺失，而是 2026-08-05 清理 Studio 独立派发入口时，同时删除了 scheduler API 客户端、状态轮询、Plan 卡片和结果展示层。当前用户仍可在聊天中触发 `scheduler_dispatch`，但只能看到工具调用状态，无法审阅检索计划、角色演绎、后半链路结果，也没有确认或丢弃 Plan 的界面。

本设计恢复 Studio 的项目级编排结果展示，覆盖完整五阶段：

1. 调度器检索计划；
2. 角色演绎；
3. 可见推理与世界图扩散；
4. 章节正文渲染；
5. 落地摘要。

核心目标：聊天触发编排后，用户无需刷新即可在 Studio 右侧审阅 Plan、查看角色 `thought`、提交或丢弃，并在提交完成后查看后三阶段真实结果。

## 2. 已确认决策

- 采用桌面端固定右侧“项目编排结果”面板。
- 面板展示当前项目的编排结果，不与聊天 session 或 message 强绑定。
- 保留“只在聊天框输入意图”的交互，不恢复“新建议程”按钮、独立派发表单或模式切换控件。
- 覆盖完整五阶段，而非只恢复前半链路。
- 后半链路采用“结果 + 真实生命周期”：提交期间统一显示处理中，完成后展示产物，不伪造 reasoner/renderer 的细粒度运行状态。
- 编排结果仅在当前服务运行期保留；页面刷新可恢复，服务重启后清空。
- 角色 `thought` 对创作者展示，但不改变角色池的信息隔离规则。
- 采用“结果写回 Plan”方案：`PlanDetail` 是五阶段结果的唯一正式读取契约。

## 3. 非目标

本次不包含：

- 编排历史的磁盘持久化或服务重启恢复；
- Plan 与聊天 session/message 的关联字段；
- 五阶段逐阶段 `waiting/running/done/error` 实时进度契约；
- 从 debug span 或日志聚合 Studio 阶段；
- 恢复独立派发表单、默认模式控制或 `@` 提及；
- 向前端暴露原始 EventQueue task、完整内部事件或模型执行信息；
- yolo 模式完整结果的独立历史浏览入口。

## 4. 总体架构

### 4.1 数据流

```text
Studio 聊天输入
  → 主会话 Agent 调 scheduler_dispatch
  → OrchestratorService.dispatch()
  → planner + role 前半链路
  → Plan 写入当前项目的内存缓存（confirmed）

Studio 右侧面板
  → 轮询 GET /api/scheduler/status 发现 Plan 摘要
  → 按需 GET /api/scheduler/plans/:planId 获取详情
  → 用户 POST /api/scheduler/commit
  → Plan 进入 committing
  → runPostRolePipeline() 生成 diffusion/render/commit
  → 三项安全结果写回同一 Plan
  → Plan 进入 committed
  → 面板重拉 PlanDetail，展示完整五阶段
```

HTTP scheduler 路由与聊天中的 scheduler 工具继续共享按项目缓存的同一个 `OrchestratorService`，不修改 Agent 的工具执行路径。

### 4.2 设计边界

- `/api/scheduler/status` 继续提供轻量队列和 Plan 摘要，不携带 stages、角色输出或正文。
- `/api/scheduler/plans/:id` 是五阶段结果的唯一详情接口。
- 不新增 `/api/scheduler/queue/:id`。前端不组合 Plan 与 Queue 两套生命周期，避免 Queue TTL 导致结果不一致。
- 后三阶段仅在真实产生后出现在 PlanDetail；提交前字段省略，而不是返回空对象。

## 5. 后端数据模型

### 5.1 Plan 缓存

现有 Plan 缓存条目扩展为：

```typescript
{
  event: StructuredEvent;
  result: OrchestratorResult;
  status: PlanStatus;
  commitQueueId?: string;
  commitError?: string;
  pipelineResult?: {
    diffusion: DiffusionOutput;
    render: RenderOutput;
    commit: CommitSummary;
  };
}
```

使用独立的 `pipelineResult`，而不是修改前半链路 `OrchestratorResult` 的语义。这样前半结果和提交产物边界清晰，且 yolo 的既有 `OrchestratorResult` 行为不受影响。

### 5.2 Commit worker 结果

当前 `CommitResult` 只保留 `appliedEventIds/writtenText/chapterPath`，不足以写回完整五阶段。将其扩展为能够携带成功时的完整 `pipelineResult`：

```typescript
interface CommitResult {
  ok: boolean;
  planId: string;
  queueId: string;
  pipelineResult?: {
    diffusion: DiffusionOutput;
    render: RenderOutput;
    commit: CommitSummary;
  };
  appliedEventIds: string[];
  writtenText: string;
  chapterPath: string;
  error?: string;
}
```

`runCommitPipeline()` 必须保留 `runPostRolePipeline()` 返回的三个对象，而不是只解构 `commit`。

### 5.3 PlanDetail DTO

现有字段保持不变，并向后兼容增加三个可选字段：

```typescript
interface PlanDetail {
  planId: string;
  storyTime: string;
  mode: "plan" | "yolo";
  characterIds: string[];
  cast: { characterId: string; name: string; summary: string }[];
  outputs: RoleAgentOutput[];
  retrievalPlan: RetrievalPlan;
  errors: { characterId: string; error: string }[];
  stages: PlanStage[];
  status: PlanStatus;
  commitQueueId?: string;
  commitError?: string;
  diffusion?: DiffusionOutput;
  render?: RenderOutput;
  commit?: CommitSummary;
}
```

约束：

- `outputs` 保留现有 `thought` 字段。
- `confirmed` 和 `committing` 时不含后三字段。
- `committed` 时必须同时含 `diffusion/render/commit`。
- `error` 时保留前半链路和 `commitError`，不返回 `diffusion/render/commit`；当前 `runPostRolePipeline()` 在异常时只保证提供 `appliedEventIds`，不足以构造可信的完整阶段对象，因此不能用空对象或部分对象伪造产物。
- `getPlan()` 对数组、对象、正文和 thought 所在结构执行深拷贝。
- DTO 不暴露 `event`、API Key、模型认证信息、debug span 或 Queue task。

### 5.4 状态写回顺序

成功路径：

1. worker 得到完整 `pipelineResult`；
2. `onCommitDone()` 将其写入 Plan 缓存；
3. 清除 `commitError`；
4. 最后将状态改为 `committed`。

该顺序避免前端观察到 `committed` 但结果字段尚未写入的瞬间状态。

失败路径：

1. worker 返回明确错误及已知 `appliedEventIds`；
2. Plan 保留前半链路；
3. `commitError` 写入失败原因；
4. 状态改为 `error`；
5. 不写入 diffusion/render/commit；`CommitResult.appliedEventIds` 继续用于队列摘要和排障，不投影成完整阶段对象。

从 `error` 重试时，沿用现有状态机：重新入队后清除旧 `commitError` 和可能存在的旧 `pipelineResult`；重试成功后写入新的完整结果。

## 6. HTTP 与前端客户端契约

后端路由保持现有 URL：

- `GET /api/scheduler/status`
- `GET /api/scheduler/plans/:id`
- `POST /api/scheduler/commit`
- `POST /api/scheduler/discard`

前端 `ApiClient` 恢复以下方法：

```javascript
getSchedulerStatus()
getSchedulerPlan(planId)
commitPlan(planId)
discardPlan(planId)
```

本设计不恢复前端直接调用 `dispatch` 或修改 scheduler mode 的入口。派发仍由聊天中的 Agent 工具完成。

## 7. Studio 右侧面板

### 7.1 桌面布局

`st-workspace` 从“会话栏 + 聊天区”扩展为“会话栏 + 聊天区 + 编排结果栏”。结果栏是当前项目的共享视图，不因切换聊天会话而过滤 Plan。

面板层级：

1. 标题和 Plan 数量；
2. 状态筛选；
3. Plan 摘要列表；
4. 当前 Plan 五阶段详情；
5. 状态允许时的提交/丢弃操作。

默认选中规则：

1. 保留仍存在的当前选中 Plan；
2. 否则选择最新 `confirmed` Plan；
3. 否则选择最新 `committing` Plan；
4. 否则选择最新可用 Plan。

### 7.2 Plan 摘要

每项展示：

- `storyTime`；
- mode；
- 角色数量；
- 角色输出数量；
- 错误数量；
- 生命周期状态。

筛选固定为：待确认、处理中、已完成、失败；默认显示全部，并显示各状态数量。状态摘要继续来自 `/scheduler/status`，不在摘要中传输正文或 thought。

### 7.3 五阶段详情

#### 阶段 1：检索计划

展示 `retrievalPlan.items` 的类型、主要参数和 `assignTo`。结构化字段纯文本转义。

#### 阶段 2：角色演绎

按角色展示：

- action；
- target；
- emotion；
- relation updates；
- knowledge gained；
- state changes；
- thought。

`thought` 面向创作者展示，使用现有 `stMarkdownHtml()` 安全渲染。该 UI 行为不改变角色池内部上下文构造，后动角色仍不能读取前动角色的 thought。

#### 阶段 3：可见推理

展示 `diffusion`：

- 已应用事件 ID 数量及可展开列表；
- 状态变化 `entityId/property/value/modality`；
- 可见性变化。

#### 阶段 4：渲染正文

展示：

- chapterPath；
- ok 状态；
- 字数；
- 完整正文。

正文使用现有 `marked + DOMPurify` 渲染，不引入新 Markdown 实现。

#### 阶段 5：落地摘要

展示 `commit`：

- ok；
- appliedEventIds；
- visibilityChanges；
- chapterPath；
- writtenText 字数；
- errors。

`render.text` 是正文唯一主体；`commit.writtenText` 只用于校验和摘要，不在 UI 重复渲染第二份正文。

### 7.4 生命周期与操作

- `confirmed`：显示“提交落地”和“丢弃”。
- `committing`：禁用提交和丢弃，保留前两阶段可读，后三阶段显示统一的“提交处理中”。
- `committed`：只读展示完整五阶段。
- `error`：显示 `commitError`，保留已有数据，并提供沿用现有 `commit(planId)` 状态机的“重试提交”。丢弃仍遵循服务端保护。

提交按钮必须有客户端本地 busy 锁，同时以后端 `COMMIT_IN_PROGRESS` 作为最终并发保护。

### 7.5 空态、加载态和刷新

- 首次加载使用面板骨架。
- 无 Plan 时提示“在聊天框描述创作意图，编排结果会显示在这里”。
- 后续轮询只局部更新数据，不清空整个面板。
- 页面刷新后通过 status 和 Plan detail 恢复当前服务运行期结果。

### 7.6 窄屏行为

窄屏时不保持三栏并排：

- 顶栏出现“编排结果 N”入口；
- 点击打开右侧全高抽屉；
- 抽屉内保持与桌面相同的信息层级和操作；
- 关闭抽屉返回聊天；
- 开关抽屉不改变当前 Plan 选择。

## 8. 轮询与状态管理

Studio 增加独立 scheduler runtime，不与 chat status timer 混用，但沿用 generation guard 和 `setTimeout` 链模式。

### 8.1 Status 轮询

- 有 pending/running queue 或 `committing` Plan：2 秒；
- 空闲：10 秒；
- 连续失败：指数退避，最大 30 秒。

失败时保留最后一次成功数据并显示局部错误，不将面板重置为空。

### 8.2 Detail 请求

仅在以下情况请求 PlanDetail：

- Plan 首次出现在摘要中；
- 用户切换选中 Plan；
- 选中 Plan 的 status、commitQueueId 或错误摘要发生变化；
- commit/discard 操作完成后；
- 用户点击手动重试。

不得每次 status 轮询都重新下载完整正文。

### 8.3 Cleanup

离开 Studio 时必须：

- 清除 scheduler timer；
- 增加 runtime generation，使未完成请求结果失效；
- 保留可复用的 viewState 数据，但不继续后台轮询。

## 9. 错误处理

### 9.1 API 状态错误

- `PLAN_NOT_FOUND`：提示“Plan 已过期、被丢弃或服务已重启”，刷新 status，并从本地详情缓存移除该 Plan。
- `COMMIT_IN_PROGRESS`：刷新详情，进入 `committing`，禁用操作。
- `PLAN_ALREADY_COMMITTED`：刷新详情，按 `committed` 只读展示。
- `COMMIT_FAILED`：显示服务端错误，不清空前半结果。
- `NO_ACTIVE_PROJECT`、embedder 未就绪或服务不可用：显示面板级可恢复错误，不影响聊天历史显示。

### 9.2 网络错误

- 保留旧列表和当前详情；
- 面板显示“状态暂不可用”和手动重试；
- 使用退避轮询，不持续弹全局 toast；
- 网络恢复后自动清除局部错误。

### 9.3 渲染安全

- thought 和正文使用 `stMarkdownHtml()`；
- 结构化值、错误消息、路径和标识符使用 `escapeHtml()` 或 `stTextHtml()`；
- 不允许未净化的 `innerHTML`；
- 不新增 Markdown 依赖，复用现有 marked 和 DOMPurify。

## 10. Mock 与测试设计

### 10.1 Mock 数据

恢复最小 scheduler mock：

- status 摘要；
- confirmed PlanDetail；
- committing 状态；
- committed 五阶段结果；
- error 状态；
- commit/discard 状态转换。

Mock 不恢复独立派发表单。现有聊天 mock 可在“调用编排器”步骤后注入一个项目级 Plan，用于演示右栏状态变化。

### 10.2 Service 单元测试

覆盖：

1. confirmed Plan 不含 `diffusion/render/commit`；
2. commit 成功后完整结果写回，再转 `committed`；
3. committed PlanDetail 同时含三项结果；
4. commit 失败保留前半链路并设置 `commitError`；
5. 重试清除旧错误并覆盖旧结果；
6. DTO 深拷贝覆盖 outputs.thought、diffusion、render.text 和 commit；
7. 原始 event 与内部 pipelineResult 引用不泄漏；
8. 既有重复 commit/discard 状态保护不回归。

### 10.3 HTTP 集成测试

覆盖：

1. `/scheduler/status` 仍为轻量摘要；
2. `/scheduler/plans/:id` 在 confirmed 时没有后三字段；
3. committed 时返回完整后三字段；
4. error 时返回 `commitError` 和已有前半结果；
5. 未知 Plan 返回 404 `PLAN_NOT_FOUND`；
6. commit/discard 的 409/404 映射保持不变。

### 10.4 前端 API Client 测试

验证四个方法的 URL、method、body 和 envelope 行为：

- `getSchedulerStatus()`；
- `getSchedulerPlan(planId)`；
- `commitPlan(planId)`；
- `discardPlan(planId)`。

### 10.5 前端逻辑测试

覆盖：

- 默认 Plan 选择；
- 状态筛选；
- 五阶段字段映射；
- thought 和正文 Markdown 净化；
- confirmed/committing/committed/error 操作状态；
- 本地 busy 锁；
- status 退避；
- detail 按需刷新；
- cleanup 终止轮询；
- `PLAN_NOT_FOUND`、`COMMIT_IN_PROGRESS`、`PLAN_ALREADY_COMMITTED` 和网络失败后的本地状态恢复。

### 10.6 browser_use 测试轮

按 `docs/frontend-test-discipline.md` 执行独立测试轮，至少包含：

- 空态；
- 聊天触发后 Plan 自动出现；
- 检索计划和角色 thought 展示；
- 提交中禁用重复操作；
- 完成后可见推理、正文和落地摘要；
- commit 失败与重试；
- Plan 丢弃；
- 页面刷新恢复；
- 窄屏抽屉；
- XSS 输入净化；
- 控制台无新增错误、404 或未捕获 Promise。

测试轮中发现缺陷时遵守“登记、不即修、跑完整轮、再由用户决策”的项目纪律。

## 11. 验收标准

BUG-019 完成需同时满足：

1. 用户只通过聊天输入创作意图即可触发原有编排链路；
2. 新 Plan 无需刷新自动出现在项目级右侧面板；
3. 前两阶段展示正式 `retrievalPlan/outputs/errors/stages`；
4. 角色 thought 对创作者可见，并经 DOMPurify 安全处理；
5. confirmed Plan 可提交或丢弃；
6. committing 时不能重复提交或丢弃；
7. committed Plan 展示真实 diffusion、完整正文和 commit 摘要；
8. error Plan 保留前半结果并显示具体原因，可按现有状态机重试；
9. status 轮询不重复下载正文，离开 Studio 后停止；
10. 页面刷新恢复当前服务运行期内的 Plan；
11. 桌面固定右栏与窄屏抽屉均可用；
12. 所有相关单测、集成测试、lint、typecheck 通过；
13. 前端测试轮文档全部完成，并在声称完成时附链接。

## 12. 预期修改范围

后端：

- `src/orchestrator/service.ts`
- `src/orchestrator.ts` 不修改执行流程；复用其已导出的 `DiffusionOutput`、`RenderOutput`、`CommitSummary` 类型
- `tests/orchestrator-service.test.ts`
- `tests/unified-server.test.ts`

前端：

- `frontend-demo/api-client.js`
- `frontend-demo/api-mock.js`
- `frontend-demo/mock-data.js`
- `frontend-demo/views/studio.js`
- `frontend-demo/styles/views.css`
- `tests/frontend-api-client.test.ts`
- 前端逻辑相关测试文件（优先扩展现有测试，不新增冗余测试框架）

测试文档与 backlog：

- `docs/audits/frontend-test-runs/<date>-bug019-orchestration-results.md`
- `docs/audits/frontend-bug-backlog.md`

不修改 pi SDK 本体、loader/config 或已废弃扩展同步机制。