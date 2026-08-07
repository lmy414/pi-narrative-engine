# 编排过程实时可见性（Live Stage Visibility）需求记录

> 日期：2026-08-08
> 状态：📋 **已记录 · D1 已决策（方案 B：编排专用 SSE 通道，2026-08-08 用户选定）· 未实施**——实施设计见 §十，D2-D5 默认值待用户确认
> 提出人：用户（主干功能增强）
> 优先级：待定（用户口述"先记录"，未排期）
> 相关：BUG-014（commit 异步化）、BUG-028（commit 阶段进度）、`docs/frontend-requirements.md` §2.4/§7、`docs/plans/2026-08-04-phase2-plan.md` G5

---

## 一、需求原话与转述

> 用户原话："现在的编排结果只有在编排结束后才可见。我需要的是，能直接在右侧看到每个阶段输入输出的结果（因为长时间的等待会让用户觉得不耐烦，必须要让用户等待的时间都发生了什么）"

**转述**：编排（dispatch / commit）执行期间，studio 右侧面板应实时展示**每个阶段**的输入与输出——用户等待时必须能看到"当前在跑什么、输入了什么、产出了什么"，而不是只看到"处理中"或等结束后才能看结果。

## 二、问题背景（为什么是主干增强）

实盘数据（phase2 计划基线）：全链路编排 `planner→role×6→reasoner→renderer` 实测约 **164s**；commit 后半链路（reasoning + renderer）实测约 **71s**。这段等待期内用户侧可见性现状：

| 阶段 | 用户能看到什么 | 缺口 |
|---|---|---|
| dispatch（planner + role×N，plan 模式） | queue 摘要条目（queueId/status/时间戳）；plan 详情**要等全部角色跑完才出现** | 期间零阶段级反馈：不知道 planner 在查什么、检索计划长什么样、哪个角色正在演绎、是否卡住 |
| dispatch（yolo 模式） | 队列条目，完成后才出结果卡（G1-5） | 全程无中间反馈 |
| commit（reasoning + renderer） | BUG-028 后：`commitStage`（"推理中/渲染中"）+ 已进行 Ns | 只有阶段名，无输入输出；仍无法判断是否正常推进 |

**结论**：长时间等待期"黑盒"是当前编排体验的核心缺陷，属于主干功能增强而非边缘优化。

## 三、现状事实（已查证代码，2026-08-08）

1. **plan 详情可见性**：`src/orchestrator/service.ts` 的 `plans` Map 在 dispatch worker **跑完 planner + 全部角色后**才写入缓存；`getPlan()` 的 `stages[]` 仅含 `planner/role` 且状态只有 `done|error`（完成后才 push）。执行期间轮询 `/api/scheduler/status` 只能拿到 queue 摘要，无阶段数据。
2. **commit 进度**：BUG-028 已加 `plan.commitStage`（`reasoning|rendering`）+ `commitStartedAt`，前端展示"推理中/渲染中 · 已进行 Ns"——**这是本需求的前置基础，但粒度只有阶段名**。
3. **数据源其实已存在**：调试总线（`src/debug/bus.ts` + `startSpan/endSpan` 埋点）对 orchestration 全程五阶段（orchestrator/planner/role/reasoner/renderer）都记录了 `input/output/durationMs/status`，SSE 实时可达。**但契约明确禁止 studio 消费它**（见 §四）。
4. **契约限制**：`frontend-requirements.md` §2.4 硬性规定"Studio 阶段规则：不得从 debug span 聚合计划进度。studio 只消费 `GET /api/scheduler/plans/:id` 的 `stages[]`"；且"阶段项仅允许 planner/role"、"reasoner/renderer/commit 不属于 plan detail，提交后结果读 commit 响应"。

## 四、约束与冲突

| # | 现有约束 | 与本需求的冲突点 |
|---|---|---|
| C1 | studio 不得消费 debug span（§2.4） | 最现成的全量阶段 input/output 数据源在 debug 总线，直接用即违反契约 |
| C2 | plan detail `stages[]` 仅 planner/role、仅 done/error、完成后才可见 | 需求要求执行中可见、含输入输出、含 reasoner/renderer |
| C3 | 阶段输入输出体积可能很大（LLM prompt 含正文上下文、角色演绎输出全量） | 实时全量推送会撑爆 UI 与轮询带宽，需截断/折叠策略 |
| C4 | yolo 模式无 plan detail 概念 | 需求若覆盖 yolo，需要独立方案 |

## 五、期望行为（产品侧，草案）

1. dispatch 入队后，右栏立即出现**阶段序列卡片**（如：`planner → role×6 → reasoner → renderer`），当前阶段高亮，状态实时流转 `running → done | error`。
2. 每个阶段可展开查看**输入摘要 + 输出摘要**（planner：检索计划；role：角色卡 actor/action/thought/emotion；reasoner：写回的世界图变更；renderer：章节摘要/字数）。
3. commit 期间同样可见 reasoner/renderer 的实时输入输出（从"推理中/渲染中"升级为"看见推理/渲染了什么"）。
4. 编排结束后的展示与现状一致（不回归已有结果卡/章节卡）。
5. 长文本截断 + 折叠展开，不阻塞轮询与渲染。
6. **呈现形态（2026-08-08 用户决策，借鉴 ZCode 工具卡模式）**：阶段内容**内联输出在聊天消息流**中——用户派发编排后，各阶段卡片随 SSE 事件流式插入对话（可展开看输入输出，也可不管它），**不做独立侧栏实时面板**；卡片样式复用 `.st-tool-card` 词汇表（views.css:2717-2757，含 done/running/failed 状态色与 result 块，现仅被 chat 工具卡占用，可扩展）。

## 六、开放决策点（实施前需对齐，本记录不选型）

| # | 决策点 | 结论 / 候选方向 |
|---|---|---|
| D1 | **数据源** | ✅ **已决策（2026-08-08 用户选定）= B：新增编排专用 SSE 通道**（如 `/api/scheduler/events`）实时推送阶段事件，体验最优 |
| D2 | **范围** | ⏳ 拟定默认：plan + yolo 都覆盖（事件源与模式无关，无额外成本；yolo 无 plan 卡，运行卡自动承载）——待确认 |
| D3 | **输入输出粒度** | ⏳ 拟定默认：服务端截断摘要（见 §十·一），前端 `<details>` 折叠展开——待确认 |
| D4 | **落盘/审计** | ⏳ 拟定默认：不落盘（内存环形缓冲 ~200 条，与 debug 一致；持久记录由 plan detail + 章节文件承担）——待确认 |
| D5 | **与 commitStage 的关系** | ⏳ 拟定默认：commitStage/commitStartedAt 保留作轮询兜底，SSE 为实时主数据源——待确认 |

## 七、建议实施方向（记录备选，不做决定）

- **最小侵入路径**：D1-A —— 后端把 `stages[]` 语义扩展为"执行中即可见"（`status` 增 `running`、追加 `inputSummary/outputSummary`、纳入 reasoner/renderer），前端右栏轮询时增量渲染。不碰 debug 契约、不改 SSE 链路。
- **体验最优路径**：D1-B —— 新增编排 SSE 通道，阶段事件即时推送，前端右栏实时更新；轮询作为降级兜底。
- 无论哪条路径，都需要 D3 的截断/摘要策略兜底。

## 八、验收标准（草案）

1. dispatch 入队后 ≤3s 内右栏出现阶段序列，当前阶段标记 running。
2. 每阶段完成/失败后状态与输入输出摘要正确流转，无需刷新页面。
3. commit 期间 reasoner/renderer 输入输出可见（不再只有"推理中"）。
4. 编排全程 UI 不卡顿、轮询无 toast 轰炸（沿用 G1-3 容错）。
5. 长输出截断可展开，不撑爆布局。
6. 结束后展示与现状无回归（结果卡/章节卡/跳转）。

## 九、备注

- 本需求与 phase2 G5（叙事增强）无依赖，但与 G1 轮询健壮性（G1-3/G1-5/G1-6）有重叠基础，实施时建议排在 G1/G2 稳定之后。
- 记录人：ZCode（2026-08-08，按用户"先记录"指示，未实施、未改任何契约文档）。

---

## 十、实施设计参考（方案 B，2026-08-08 已完成设计查证，未实施）

> 本节为后续实施的完整设计备查。代码基线查证：`src/orchestrator.ts`、`src/orchestrator/service.ts`、`src/event-queue.ts`、`src/debug/sse.ts`、`src/app/routes-scheduler.ts`、`src/app/unified-server.ts`（SSE 配额 L234-235）、`frontend-demo/views/studio.js`、`frontend-demo/api-client.js`（subscribe L249-290）。

### 一、事件 wire schema（服务端截断摘要，每事件 <1.5KB）

```ts
type OrchestrationStageEvent = {
  id: string; ts: number; traceId: string;
  planId: string; queueId?: string;      // queueId 经 run(ctx) 透传
  type: "run_start" | "run_end" | "stage_start" | "stage_end" | "stage_error"
      | "commit_start" | "commit_end";
  stage?: "planner" | "role" | "reasoner" | "renderer";
  agent?: string;                        // role 时为 characterId
  storyTime?: string; mode?: "plan" | "yolo";
  input?: unknown; output?: unknown; error?: string; durationMs?: number;
};
```

**截断策略**：run_start 的 instruction ≤200 字符；planner 输出 retrievalPlan items≤20；role 逐角色（agent=characterId）输出 `{actor, action≤500, emotion?, target?, relation_update?, state_changes≤10, knowledge_gained 计数}`；reasoner 输出 `{appliedEventIds 计数, changes≤20, visibilityChanges≤10}`；renderer 输出 `{chapterPath, chars, ok, title}`；commit_end 输出 `{ok, appliedEventIds 计数, chapterPath, writtenChars}`。

### 二、后端改动清单

| 文件 | 改动 |
|---|---|
| `src/orchestrator/stage-bus.ts`（新建） | `OrchestrationStageEvent` 类型 + `createStageBus(capacity=200)`：emit/subscribe/snapshot，环形缓冲，仿 `src/debug/bus.ts` 的 Set + 逐监听器 try/catch 模式 |
| `src/orchestrator.ts` | `OrchestratorOptions.stageEventSink?: (ev) => void \| null` + `setStageEventSink()` 方法（解决 chat-context 构造顺序：先建 Orchestrator 后建 Service）；`run(event, ctx?: { queueId?: string })` 埋点：run_start → planner start/end\|error → **逐角色** role start/end\|error（角色循环已有 per-character try/catch，顺带让 BUG-025/026 角色失败实时可见）→ run_end；`runPostRolePipeline(..., planId?)`（追加可选参数）埋点：commit_start → reasoner start/end\|error → renderer start/end\|error → commit_end（yolo 由 run() 内部传自身 planId，plan 模式 commit 由 Service 传入） |
| `src/event-queue.ts` | worker 签名 `(event, queueId)`，pump 传 `item.queueId`（仅被 OrchestratorService 使用，TS 少参函数赋值兼容，既有测试零改动） |
| `src/orchestrator/service.ts` | 持有 stageBus；worker 经 ctx 传 queueId；构造时 `orchestrator.setStageEventSink(ev => this.stageBus.emit(ev))`；暴露 `subscribeStageEvents(listener)` + `stageEventSnapshot()`；`dispose()` 清 sink |
| `src/orchestrator/stage-sse.ts`（新建） | `handleStageStream(service, req, res)`，镜像 `src/debug/sse.ts`：SSE 头、`:connected`、快照-后-实时、30s 心跳、half-open 检测、req/res close 清理 |
| `src/app/routes-scheduler.ts` | `GET /api/scheduler/events` → requireActiveDir → getService → handleStageStream，返回 true（SSE 自管理响应；错误在开流前走既有信封） |
| `src/app/unified-server.ts` | `isSseEndpoint`（约 L234）加入 `/api/scheduler/events`（SSE 10 连接配额） |

### 三、前端改动清单

| 文件 | 改动 |
|---|---|
| `frontend-demo/api-client.js` | `subscribeOrchestration(onEvent, onError)` → `/scheduler/events`（复用现有 `subscribe()`：断线指数退避重连，L249-290） |
| `frontend-demo/app.js` | ApiRuntime mock 分支加 no-op（mock 模式无 SSE，与 subscribeChat/subscribeDebug 一致） |
| `frontend-demo/views/studio.js` | 运行时启动处订阅（close 句柄入 `stOrCloseRuntime()`/`cleanupStudioView()`，generation 守卫同现有轮询）；handler 按 `ev.id` 去重、按 planId 分桶存 `stOrLiveRuns`（Map，容量裁剪）；**呈现：内联消息流卡片**（2026-08-08 用户决策，见 §五.6）——阶段事件渲染为对话流中的卡片序列（用户派发消息之后插入，随 SSE 增量更新：`planner ✓ → 角色 辉夜 ✓ → reasoner …`），卡内 `<details>` 展开输入/输出 JSON；复用/扩展 `.st-tool-card` 样式词汇表；不设独立 `.st-or-live` 侧栏区块；plan 出现后计划卡与阶段卡并存（阶段卡=过程视图，计划卡=结果视图），yolo 无计划卡时阶段卡+run_end 摘要承载结果 |
| `frontend-demo/styles/views.css` | `.st-or-live*` 样式（沿用 `.st-or-stage` 卡片词汇表 + 状态点颜色） |

### 四、文档与测试清单

- **文档**：`docs/frontend-requirements.md` §2.4 通道表加行 + §7 V4 实时面板说明 + §11 类型定义（debug span 禁止消费的约束**不变**）；`docs/api/unified-server.md` 新端点；本文件状态更新；`CHANGELOG.md` Unreleased 条目。
- **测试**（node:test 全 mock）：`tests/orchestrator/stage-bus.test.ts`（bus 行为）、`tests/orchestrator/stage-sse.test.ts`（mockReqRes 模式，镜像 tests/debug/sse.test.ts）、`tests/orchestrator-stage-events.test.ts`（真实 Orchestrator + LlmConfigStore 指向不存在模型 → 确定性失败路径：run_start → planner stage_start/error → run_end，含 planId/traceId/queueId 断言）、`tests/orchestrator-service.test.ts` 扩展（sink→bus→订阅者链路、snapshot、dispose 清 sink）、`tests/unified-server.test.ts` HTTP 级（stub service：SSE 头/实时推送/无活跃项目 409/配额清单同步）。
- **流程**：分支 `20260808-live-stage-sse` → 显式路径提交 → ff-only 合并；改 frontend-demo 后按前端测试纪律跑真实模式测试轮并出文档（缺陷登记、禁止即修）。
