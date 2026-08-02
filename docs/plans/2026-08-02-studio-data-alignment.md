# 创作编排页（studio）数据对齐决策

> 日期：2026-08-02
> 背景：`docs/frontend-backend-api-audit.md` §3.2 指出 studio 页两块 UI 在真实后端 API 下无数据源；§7 后端可补性核实后，形成以下决策。本文档是 studio 页对接真实后端时的数据契约依据。

## 决策 1：chat 角色发言标签（characterId/roleTag）——不做

- 主会话保持单 assistant（编排调度者）语义，不在编排器/消息写入处为角色发言落标签。
- 编排产出的角色信息（`cast`、`RoleAgentOutput.actor`）只属于 OrchestratorResult，通过决策 2 的 plan 详情端点暴露，不混入 chat 消息流。
- **前端影响**：demo 中 chat 消息的 `name/roleTag/characterId` 渲染逻辑删除；消息列表只展示 `{role, text, ts}` + toolCalls（见决策 3）。角色视角的呈现统一走 plan 产出预览，不走聊天气泡。

## 决策 2：plan 预览改为「角色产出预览」，砍掉「章节正文预览」

- 真实流程中正文渲染（renderer）在 commit 后半链路才执行，plan 阶段不存在正文——demo 的 sections 正文预览概念废弃。
- plan 阶段可预览的是编排器的角色产出：`OrchestratorService.plans` 中缓存的 `result.outputs: RoleAgentOutput[]`（`actor/action/thought/emotion/state_changes/knowledge_gained`）、`cast`、`retrievalPlan`、`errors`。数据已存在，只缺暴露。

### 新增端点（薄路由）

```
GET /api/scheduler/plans/:id
```

- 需活跃项目；plan 不存在 → 404 `PLAN_NOT_FOUND`。
- 返回 data：

```json
{
  "planId": "plan-xxx",
  "storyTime": "ch006.ev008",
  "mode": "plan",
  "characterIds": ["char-01"],
  "cast": [ /* 编排器 cast 原样 */ ],
  "outputs": [
    {
      "actor": "林远航",
      "action": "...",
      "thought": "...",
      "emotion": "...",
      "state_changes": [ /* ... */ ],
      "knowledge_gained": [ /* ... */ ]
    }
  ],
  "retrievalPlan": [ /* 检索计划原样 */ ],
  "errors": []
}
```

- 实现位置：`src/app/routes-scheduler.ts` 新增分支，直接读 `OrchestratorService.plans`（`service.ts` 已有 `getPlan`/`listPlans` 可复用或微调）。
- **前端影响**：studio 的 plan 预览面板按 `outputs[]` 渲染（角色卡：actor + action/thought/emotion + 状态变更/知识获得），替代 demo 的 `sections[]`。

## 决策 3：chat 消息暴露 toolCalls/usage/model（加工现有 JSONL）

- 会话 JSONL 已含完整 toolCall 块与 `provider/model/usage`（`chat-context.ts` 的 `extractMessageText` 压扁时丢弃）。
- `GET /api/chat/sessions/:id/messages` 的 messages 扩展为：

```json
{ "role": "assistant", "text": "...", "ts": "...",
  "toolCalls": [{ "id": "...", "name": "...", "status": "done|error", "isError": false }],
  "provider": "...", "model": "..." }
```

- toolResult 消息按 `toolCallId` 配对回填 `status/isError`；耗时（durationMs）不做（SSE 阶段可由前端自行配对，历史消息暂不计算）。
- **前端影响**：studio 工具调用卡片按此渲染（名称+状态），替代 demo 的 `icon/duration/result` 富字段。

## 决策 4：流水线阶段（stages）由后端落 plan 阶段记录

- 编排器在执行过程中把各阶段直接记录到 plan 上，不做「前端按 traceId 聚合 debug span」的脆弱方案。
- plan 新增 `stages` 字段，由 orchestrator 在各 span 生命周期（planner / role / reasoner / renderer / commit）写入：

```json
"stages": [
  { "stage": "planner", "agent": "planner", "status": "done|running|error|waiting",
    "durationMs": 1230, "provider": "...", "model": "...", "error": null }
]
```

- 暴露位置：`GET /api/scheduler/plans/:id` 返回中含 `stages`；`GET /api/scheduler/status` 的 plan 摘要维持现状（不带 stages，避免列表膨胀）。
- **前端影响**：studio 的流水线进度条按 `stages[]` 渲染（阶段名 + agent + 状态 + 耗时），替代 demo 的自造 stages。
- 实现位置：`src/orchestrator/orchestrator.ts` 的 span 写入处同步落 plan.stages；`src/orchestrator/service.ts` 的 plan 存取随之扩展。

## 决策 5：debug 事件落盘持久化（写日志文件）

- 在现有内存环形总线之上增加文件落盘：每个 debug 事件追加写入项目目录 `.pi/logs/debug.jsonl`（JSONL，一行一个 DebugEvent）。
- 轮转策略：单文件超过 10 MB 时轮转为 `debug-<yyyyMMdd-HHmmss>.jsonl` 并新开文件；保留最近 5 个文件，更旧的删除。
- 写盘为异步追加（fire-and-forget），失败仅 console 告警，不影响主链路；内存总线语义不变（容量 1000，SSE snapshot/实时推不变）。
- 读取侧暂不新增 API（需要查历史时直接看日志文件）；如后续要「历史回放」再评估加端点。
- 实现位置：`src/debug/bus.ts` 增加可注入的 sink（默认关闭，unified-server 启动时按项目目录装配开启），避免 bus 与文件系统硬耦合。
- 注意：debug 日志可能包含 prompt/产出文本，随项目目录走，不进 git（`.pi/logs/` 应入 .gitignore）。

## 验收标准

- `GET /api/scheduler/plans/:id` 返回契约形状（含 `outputs[]` 与 `stages[]`），studio plan 预览按 `outputs[]` 渲染角色卡、流水线进度按 `stages[]` 渲染，并通过验收。
- `GET /api/chat/sessions/:id/messages` 含 toolCalls 的消息正确展示工具卡片；无角色标签相关渲染残留。
- demo 的 `sections` 正文预览与 `roleTag/characterId/name` 消息字段从前端代码中移除。
- 编排执行后项目目录 `.pi/logs/debug.jsonl` 有对应 JSONL 记录，轮转与保留策略生效，且 `.pi/logs/` 已在 .gitignore。
