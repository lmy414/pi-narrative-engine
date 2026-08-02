# 前后端契约收敛 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除旧 mock 契约，完成 `frontend-demo` 与真实后端在 plan 详情、历史聊天、debug 持久化上的可验收对接。

**Architecture:** plan detail 只投影已完成的 planner/role 前半链路，commit 结果继续由现有响应承载；历史消息由后端显式聚合 toolCall/toolResult 并映射稳定 usage DTO；DebugBus 保持同步内存语义，通过项目绑定的串行 sink 异步落盘。

**Tech Stack:** TypeScript、Node.js HTTP/SSE、PI SDK SessionManager、原生 HTML/CSS/JavaScript、Node test runner/tsx。

---

> 日期：2026-08-02
> 范围：只改 `narrative-engine` 源码、测试与 `frontend-demo`；本文件是实施计划，不代表当前代码已具备目标能力
> 关联规格：`docs/frontend-requirements.md`、`docs/frontend-backend-api-audit.md`；`docs/plans/2026-08-02-studio-data-alignment.md` 仅保留早期决策背景，冲突时不作为实施依据。

## 1. 完成定义

全部满足以下条件，才可称为完成：

- 前端只消费真实契约：envelope、包装层、DebugEvent、历史消息、plan detail 均与文档一致。
- 后端提供 plan detail，`stages[]` 只承载 planner/role 前半链路；studio 不从 debug SSE 聚合阶段。
- 历史 assistant 消息保留 toolCalls/provider/model/标准化 usage；toolResult 已按 `toolCallId` 配对；不出现角色聊天标签。
- DebugEvent 继续进入内存环形缓冲与 SSE，并由项目绑定 sink 异步写入对应项目 `.pi/logs/debug.jsonl`；轮转与失败隔离可测试。
- `sections[]`、角色 `name/roleTag/characterId`、旧 debug 字段、旧工具卡片字段全部从生产消费路径删除。
- 定向测试、全量测试、构建、静态检索、手工 API 验收均完成；未新增 lint 命令，仓库当前没有 `lint` script。

## 2. 实施前基线与边界

先在 `narrative-engine` 仓库执行：

```powershell
git status --short
git log -1 --oneline
```

若工作区存在非本任务改动，记录文件清单并保留，不覆盖、不回退。当前已核实的基线为 `76a8802`。

本任务只允许修改：

- `src/orchestrator.ts`
- `src/orchestrator/service.ts`
- `src/app/routes-scheduler.ts`
- `src/app/chat-context.ts`
- `src/app/routes-chat.ts`（仅需时）
- `src/debug/types.ts`
- `src/debug/bus.ts`
- `src/app/main.ts` 或 debug sink 装配位置
- `src/visualizer/routes.ts`（仅需时）
- `frontend-demo/**/*`
- 相关 `tests/**/*`
- `.gitignore`
- 本计划引用的文档

不得修改 `pi-ex` 本体、`underworld-graph`、小说正文或运行时项目数据。

## 3. 分支与提交流程

本仓库分支规则必须执行：

1. 同步主干：`git fetch origin`、`git checkout master`、`git pull origin master`。
2. 创建日期分支：`git checkout -b 20260802-frontend-backend-contract`。
3. 分步提交，显式列出路径；禁止 `git add .` 与 `git add -A`。
4. 所有验证通过后切回 master，`git merge --ff-only 20260802-frontend-backend-contract`，再推送 master。
5. 合并后删除本地分支；已推送分支再删除远端分支。

建议提交分组：

- `feat: expose scheduler plan detail and persist stages`
- `feat: expose historical chat tool calls`
- `feat: persist debug events by project`
- `refactor: align frontend demo with backend contract`
- `docs: update frontend backend handoff contract`

每次提交前只加入该提交涉及的显式路径，并检查 `git diff --check`。

## 4. 分步执行任务

### Task 1：建立目标契约测试红灯

目标：先用测试钉死接口形状，再写实现。

新增或修改测试：

- `tests/unified-server.test.ts`
  - `GET /scheduler/plans/:id` 成功返回 `planId/storyTime/mode/characterIds/cast/outputs/retrievalPlan/errors/stages`。
  - stages 只含 `planner/role` 且状态只含 `done/error`。
  - 未知 plan 返回 404 `PLAN_NOT_FOUND`；commit/discard 后详情返回 404。
  - status 的 plans 摘要不包含 stages。
- `tests/chat-routes.test.ts` 或 `tests/unified-server.test.ts`
  - assistant 含两个 toolCall、toolResult 成功/失败时，历史消息按 ID 配对。
  - 返回 `toolCalls/provider/model/usage`，usage 固定为 `{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,totalTokens,estimatedCostUsd}`。
  - user 消息、无工具 assistant、纯 toolCall assistant、孤立 toolCall/toolResult 的行为明确且稳定。
- `tests/debug/bus.test.ts`、`tests/debug/sse.test.ts` 或新增 `tests/debug/file-sink.test.ts`
  - 每次 emit 写入一行可解析 JSON；sink 失败不影响内存事件与订阅者。
  - clear 不删除 JSONL；10 MB 轮转；最多 5 个轮转文件。
  - 项目切换时，旧项目已启动任务的尾部事件仍写旧项目，新项目事件只写新项目。
  - dispose/服务关闭会 drain 已排队写入。
- `tests/frontend-demo.test.ts` / `tests/frontend-utils.test.ts`
  - plan outputs 与仅含 planner/role 的 stages 映射。
  - 真实 DebugEvent 的过滤和详情映射。
  - 历史 toolCalls/usage 渲染数据。
  - 废止字段静态检索在消费路径中无结果。

定向红灯命令：

```powershell
npx tsx --test tests/unified-server.test.ts tests/chat-routes.test.ts tests/debug/bus.test.ts tests/debug/sse.test.ts tests/debug/file-sink.test.ts tests/frontend-demo.test.ts tests/frontend-utils.test.ts
```

如果没有新建 `tests/debug/file-sink.test.ts`，从命令中删除该路径。仅允许因目标契约未实现产生红灯；语法错误、模块解析错误、无关失败必须先处理。

### Task 2：实现 plan detail 与前半链路 stages

后端改动顺序：

1. 在 `src/orchestrator.ts` 定义 plan detail 需要的 `PlanStage`，阶段只允许 `planner|role`，状态只允许 `done|error`。
2. planner/role span 结束时同步形成阶段摘要；`durationMs/provider/model/error` 仅按实际值写入，不制造 waiting/running。
3. 在 `src/orchestrator/service.ts` 增加公开只读 `getPlan(planId)`，显式构造 `{planId,storyTime,mode,characterIds,cast,outputs,retrievalPlan,errors,stages}` DTO，不返回内部 Map 或完整 `OrchestratorResult`。
4. 在 `src/app/routes-scheduler.ts` 增加 `GET /api/scheduler/plans/:id`，沿用 envelope、活跃项目门控与 `PLAN_NOT_FOUND`。
5. 保持 `GET /api/scheduler/status` 摘要形状、commit/discard 后删除 plan 的语义不变；不得把 reasoner/renderer/commit stages 写回 plan。

验证：

```powershell
npx tsx --test tests/orchestrator-service.test.ts tests/unified-server.test.ts tests/debug/orchestrator-spans.test.ts
```

### Task 3：实现历史聊天 toolCalls 与 usage 摘要

后端改动顺序：

1. 查证已安装 PI SDK 的 message/content/Usage 类型，不猜字段；以 `pi-ex/packages/ai/src/types.ts` 和实际 JSONL fixture 为依据。
2. 在 `src/app/chat-context.ts` 中保留文本提取，另行识别 assistant content 的 toolCall 块与 provider/model。
3. 扫描同一会话中的 toolResult，按 `toolCallId` 回填 `status` 与 `isError`；toolResult 不单独转成 UI 消息。未匹配 toolResult 的 toolCall 返回 `error/isError:true`，避免把历史残缺记录误报为运行中。
4. 将 SDK Usage 显式映射为 `{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,totalTokens,estimatedCostUsd}`；token 字段取非负有限数，totalTokens 缺失时求和，estimatedCostUsd 映射 `cost.total`。
5. 返回 `{role,text,ts,toolCalls?,provider?,model?,usage?}`，不加入角色标签，不改 `/api/chat/sessions/:id/messages` 外层 `{id,messages}`。
6. 补测试覆盖无工具、多个工具、失败工具、孤立调用/结果、纯 toolCall assistant、usage 正常值与无效值归零。

验证：

```powershell
npx tsx --test tests/chat-routes.test.ts tests/unified-server.test.ts
```

### Task 4：实现 debug JSONL sink

后端改动顺序：

1. 在 `src/debug/bus.ts` 定义可注入 sink 与项目绑定转发 bus；全局 bus 核心仍同步维护内存和订阅者，持久化走串行异步队列。
2. 在 `src/app/chat-context.ts` 创建项目 orchestrator 时，用固定 `cwd` 包装全局 bus：每个事件同时转发到全局内存/SSE bus 和该项目 `.pi/logs/debug.jsonl` sink。禁止在 emit 时读取 mutable active project 猜目录。
3. 旧项目异步任务在切换后继续写旧项目 sink；新项目使用新 sink；无项目绑定的全局事件只进入内存/SSE。
4. 写入前检查活跃文件大小，达到轮转阈值时生成 `debug-<yyyyMMdd-HHmmss>.jsonl`，创建新的 `debug.jsonl`。
5. 只保留最近 5 个轮转文件；清理失败和写入失败只告警，不改变业务结果。
6. 在 `ChatContext.disposeRuntime/dispose` 与服务关闭链路等待 sink drain，避免正常退出丢失已排队事件。
7. `.gitignore` 增加 `.pi/logs/`，避免项目日志进入版本库。

验证：

```powershell
npx tsx --test tests/debug/bus.test.ts tests/debug/sse.test.ts tests/unified-server.test.ts
```

### Task 5：前端 Demo 消除旧契约

按现有 `frontend-demo` 结构修改，不新引入框架或构建步骤：

- `api-mock.js` 返回真实端点包装层：`projects/tree/sessions/slots/rulesets/data/values`。
- `mock-data.js` 删除角色聊天 `name/roleTag/characterId`，plan 删除 `sections[]`，stages 改为目标 `PlanStage`。
- `views/studio.js`：历史 toolCalls 只展示 name/status；plan 按 `outputs[]` 角色产出渲染；阶段从 plan detail 状态读取；删除 debug 驱动阶段与章节正文预览。
- `views/debug.js` 与 mock debug 数据改用真实 DebugEvent；过滤字段只基于 `status/stage/error/input/output`。
- @提及改经 `apiCall('search', ...)`，不得读取 `MOCK_ENTITIES`。
- 删除 `suspected/inferred` 写入路径；展示 unknown 只能表示没有有效 known 声明。
- 保持静态 HTML/CSS/JavaScript，不增加构建步骤。

静态检查：

```powershell
Get-ChildItem frontend-demo -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }
Select-String -Path frontend-demo\**\*.js -Pattern 'sections|roleTag|spanId|level|module|payload|MOCK_ENTITIES' -CaseSensitive
```

第二条命令允许只命中测试夹具、迁移说明或非消费数据；生产渲染与交互代码不得命中废止字段。

### Task 6：全量验证与运行验收

代码验证：

```powershell
npm test
npm run build
git diff --check
```

仓库无 `lint` 与根 `typecheck` script；不得臆造命令。可执行的类型校验以构建为准，子包若涉及改动再执行对应 `npm run typecheck --workspace <package>`。

手工服务验收：

```powershell
node scripts/app-server.mjs --project D:/claude/pi-ex/novel --port 7421 --embed
```

按顺序检查：

1. `GET /api/projects/active`、`GET /api/status`、`GET /api/debug/events` envelope 正确。
2. plan 模式 dispatch，轮询 status 找到 planId，GET plan detail 看到 outputs 与 stages。
3. commit 后 plan detail 404，commit 返回 appliedEventIds/writtenText/chapterPath。
4. 新建含工具调用的聊天历史，GET messages 看到 toolCalls/provider/model/标准化 usage；无角色标签字段。
5. 开 SSE `/api/debug/stream`，执行一次编排，确认事件有 start/end/error、parentId 与 durationMs。
6. 检查 `.pi/logs/debug.jsonl` 每行可独立 JSON.parse；调用 clear 后内存为空、磁盘日志仍存在。
7. 制造超过 10 MB 的 debug 日志，确认轮转命名与最多 5 个轮转文件。
8. 在项目 A 启动一个尚未结束的编排后切换到项目 B，再执行一次；确认 A 的尾部事件仍写 A，B 的事件只写 B。
9. 运行前端 Demo，验证 `/api` 包装层、studio plan outputs/stages、debug 字段与 chat toolCalls。

## 5. 交接清单

交给下一位执行者时必须包含：

- 当前分支、基线 commit、工作区是否干净。
- 已完成 Task 与对应测试命令/结果。
- 未完成 Task 的失败测试、阻塞原因和下一步文件。
- 任何临时 fixture 的位置；禁止把 API key、真实 prompt 或项目日志加入提交。
- 最终变更文件清单与 `git diff --check` 结果。

## 6. 验收签字条件

只有以下项目全部通过才可合并：

- [x] `GET /api/scheduler/plans/:id` 契约测试通过。
- [x] plan `stages[]` 只含后端记录的 planner/role，studio 不依赖 debug span 聚合，commit 后仍按现有语义删除 plan。
- [x] 历史 chat toolCalls/provider/model/标准化 usage 测试通过，角色标签未进入响应。
- [x] debug JSONL 写入、失败隔离、轮转、保留、clear 边界测试通过。
- [x] frontend-demo 静态检查无废止消费路径。
- [x] `npm test`、`npm run build`、`git diff --check` 通过。
- [ ] 手工验收 A1-A12 通过，且未提交密钥、日志、小说运行时数据。
- [ ] 按仓库分支流程完成合并；未直接在 master 提交。
