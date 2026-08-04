# 前端 Demo × 后端 API 契约核对报告

> 日期：2026-08-02
> 实施基线：narrative-engine @ master `76a8802`
> 实施状态：目标契约已在 `20260802-frontend-backend-contract` 分支落地并通过自动化验证
> 核对范围：`frontend-demo/`、`src/app/`、`src/orchestrator.ts`、`src/orchestrator/service.ts`、`src/debug/`、现有契约测试
> 决策依据：`docs/plans/2026-08-02-studio-data-alignment.md`
> 执行入口：`docs/plans/2026-08-02-frontend-backend-handoff-plan.md`
> 契约优先级：本文与 `docs/frontend-requirements.md` 是修订后的目标口径；若与早期 studio alignment 文档冲突，以本文、需求文档和交接计划为准。

## 1. 结论

目标契约已经完成实现：plan detail、历史聊天工具调用与 usage、项目绑定 debug JSONL，以及 frontend-demo 的真实 DTO 消费路径均已落地。自动化验证覆盖契约形状、错误边界、日志轮转/失败隔离/项目归属和废止字段清理；真实 LLM 调用与浏览器生产流程仍按需求文档 A1-A12 单独验收。

## 2. 已确认的唯一目标口径

| 事项 | 唯一目标 | 明确废止 |
|---|---|---|
| 聊天角色呈现 | 主会话保持单 assistant；角色信息只在 plan `outputs[]/cast[]` 展示 | 历史/实时聊天的 `name/roleTag/characterId` |
| plan 预览 | `GET /api/scheduler/plans/:id` 返回角色产出、cast、retrievalPlan、errors、前半链路 stages | `sections[]` 与 plan 阶段章节正文预览 |
| 历史工具调用 | assistant 历史消息返回 `toolCalls[]`、`provider`、`model` 与标准化 `usage` 摘要；toolResult 按 `toolCallId` 回填 done/error | mock 的 `icon/duration/result`；直接透传 SDK Usage |
| studio 阶段状态 | commit 入队即返回 `{ ok, planId, queueId, status: 'committing' }`；plan 状态机 `confirmed`→`committing`→`committed`\|`error`；plan 不立即删除，由 TTL 清理 | 前端自造 stages；按 debug span 聚合 studio stages；在 plan 上保留 reasoner/renderer/commit |
| debug | 内存 1000 条 + SSE 语义不变；事件异步追加到项目 JSONL，10 MB 轮转，保留 5 个轮转文件 | 纯内存即最终方案；日志读取 API；clear 删除磁盘日志 |

## 3. 当前实现与源码证据

| 契约面 | 当前实现 | 源码位置 |
|---|---|---|
| plan 缓存 | `getPlan(planId)` 只读投影 detail，status 仍只返回摘要 | `src/orchestrator/service.ts` |
| plan 路由 | `GET /api/scheduler/plans/:id`，缺失返回 404 `PLAN_NOT_FOUND` | `src/app/routes-scheduler.ts` |
| 编排阶段 | plan 只记录已完成的 planner/role stages | `src/orchestrator.ts` |
| 历史消息 | assistant toolCall/toolResult 配对并映射 provider/model/usage | `src/app/chat-context.ts` |
| DebugEvent | 前后端统一消费真实 schema | `src/debug/types.ts`、`frontend-demo/views/debug.js` |
| DebugBus | 同步内存/SSE + 项目固定目录异步 JSONL sink | `src/debug/bus.ts`、`src/app/chat-context.ts` |
| git 忽略 | 项目日志目录已忽略 | `.gitignore` |
| history events | history 端点补 events 关联查询（BUG-016） | `src/visualizer/routes.ts` |

### 3.1 plan stages 的生命周期约束

- plan detail 的 `stages[]` 只允许 `planner`、`role`。
- 固定状态为 `done`、`error`；plan 写入缓存时前半链路已经结束，不返回虚假的 `waiting/running`。
- `durationMs/provider/model` 仅在可取得时返回，不伪造默认值；错误阶段携带 `error`。
- `reasoner/renderer/commit` 仅在 commit 后半链路执行，不写回 plan；commit 异步入队，`plan.status` 流转 `committed`/`error` 后保留供查询历史。
- studio 的提交结果读取 commit 响应；需要排障时进入 debug 页观察后半链路 span。
- status 继续只返回摘要，不把 stages 塞进列表。
- PlanDetail 新增 `status` / `commitQueueId` / `commitError` 字段（BUG-014）。

### 3.2 历史 usage 摘要

- assistant 消息可选返回 `usage`；其他角色省略。
- DTO 固定为 `{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,totalTokens,estimatedCostUsd}`。
- 显式映射 SDK Usage：`input/output/cacheRead/cacheWrite/totalTokens/cost.total`；不得直接透传 SDK 对象。
- 所有字段为非负有限 number；缺失或无效字段归零，`totalTokens` 优先使用 SDK 值，否则对四类 token 求和。

### 3.3 debug 持久化边界

- 活跃文件：`<project>/.pi/logs/debug.jsonl`，每行一个完整 `DebugEvent` JSON。
- 写入：fire-and-forget 串行追加；单次失败只 `console.warn`，不得抛回业务链路。
- 轮转：写入前检查活跃文件大小；超过 10 MB 后重命名为 `debug-<yyyyMMdd-HHmmss>.jsonl` 再创建新活跃文件。
- 保留：最多 5 个轮转文件，不含当前 `debug.jsonl`；按文件名时间排序删除更旧文件。
- 项目归属：创建项目 orchestrator 时，用固定 `cwd` 包装全局 bus；同一事件转发到全局内存/SSE bus 和该项目 sink。
- 项目切换：旧项目尚未结束的事件继续写旧项目，新项目事件写新项目；禁止在 emit 时读取 mutable active project 决定路径。
- `POST /api/debug/clear` 只清全局内存；不删除或截断 JSONL。
- 服务关闭时等待各项目 sink 的串行队列 drain；普通写盘失败只告警，不反向影响业务执行。

### 3.4 错误码补充（BUG-014）

- `COMMIT_IN_PROGRESS` (409)：plan 正在提交中
- `PLAN_ALREADY_COMMITTED` (410)：plan 已提交完成

## 4. 仍成立的一般对接差异

真实响应的 `data` 内包装必须由真实 API 客户端按契约读取，不得延续 mock 裸值假设：

| 域 | 真实 `data` 形状 |
|---|---|
| 项目扫描 | `{projects:[...]}` |
| 文件树 | `{tree:[...]}`，节点用 `kind`，无内联 `content` |
| 会话列表 | `{sessions:[...]}` |
| 会话消息 | `{id,messages:[...]}` |
| LLM 状态 | `{slots:{...}}` |
| 规则集 | `{rulesets:[{name,filename,path,exists,content,mtime,charCount}]}` |
| novel.json | `{path,exists,data}` |
| 项目 `.env` | `{path,exists,values,lineCount}`，删除键传 `null` |

其他需保持的真实 schema：

- DebugEvent 不含 `level/module/message/payload/spanId`。
- Embedder 使用 `model/isDefault/dim/cachePresent/cachePath/cacheSizeBytes`。
- UI 主题、字号、自动保存存 localStorage；不写 app-config。
- 可见性只写 `state:"known"`，source 只允许 `experienced/informed/witnessed`。
- `PUT /api/scheduler/mode` 要求活跃项目（M-Collab-3 修复，避免在项目外无感知修改全局默认模式）；`GET /api/chat/status` 不需活跃项目；`/api/debug/*` 需活跃项目。

## 5. Demo 已删除的旧契约

| 位置/概念 | 处理 |
|---|---|
| `mock-data.js` 角色消息 `role/name/roleTag/characterId` | 改成普通 assistant 或移除，角色内容迁到 plan outputs |
| plan `sections[]` | 删除，不提供兼容 fallback |
| mock 自造 stages | 改为符合目标 `PlanStage` 的后端模拟数据 |
| studio 按 debug 事件驱动 stages | 删除，改轮询 plan detail |
| studio `MOCK_ENTITIES` 提及列表 | 改走 ApiMock.search；真实客户端映射 `/api/search` |
| debug mock 的 `level/module/message/payload/spanId` | 全量改成真实 DebugEvent schema |
| 可见性 `suspected/inferred` | 删除；unknown 是“无有效 known 记录”的展示态，不是写入值 |

## 6. 验证状态

- 自动化测试已覆盖 plan 详情、历史工具调用、debug sink、frontend-demo DTO 与废止字段。
- `npm test`、`npm run build`、前端 `node --check`、`git diff --check` 已通过。
- 真实 LLM dispatch/chat、浏览器端 A1-A12 和超过 10 MiB 的生产文件实测仍需按交接计划执行；单测通过可注入阈值覆盖了同一轮转代码路径。
