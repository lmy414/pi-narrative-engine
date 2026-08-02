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

## 待定项

- **流水线阶段（stages）展示**：等价数据在 debug span（root `orchestrator` + 子 span，含 status/durationMs/provider/model）。两个候选：
  a) 后端在 plan 上直接落阶段记录（推荐，语义干净）；
  b) 前端按 traceId 聚合 debug 事件（无需后端改动，但 traceId↔planId 关联脆弱）。
  下一阶段动工前定。
- **debug 事件持久化**：当前为内存环形缓冲（容量 1000，重启即失）。是否需要落盘另行评估。

## 验收标准

- `GET /api/scheduler/plans/:id` 返回上述形状，studio plan 预览按 `outputs[]` 渲染并通过验收。
- `GET /api/chat/sessions/:id/messages` 含 toolCalls 的消息正确展示工具卡片；无角色标签相关渲染残留。
- demo 的 `sections` 正文预览与 `roleTag/characterId/name` 消息字段从前端代码中移除。
