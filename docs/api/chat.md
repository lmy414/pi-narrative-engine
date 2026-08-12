# 主会话聊天 API（/api/chat/*）

> 属于 [API 文档索引](README.md)。主会话层（PI SDK 模式：`createAgentSessionRuntime`）的 HTTP 后端契约，供未来前端聊天 UI 接入。本阶段不实现前端，只交付 API。源码位于 `src/chat/`（主会话宿主 + 编排器工具）与 `src/app/routes-chat.ts`（HTTP 端点）。

## 设计要点

- **主会话宿主**（`src/chat/main-session.ts`）：PI SDK 三层结构（`createAgentSessionServices` → 工厂闭包 → runtime），最简提示词经 `.pi/SYSTEM.md` 自动发现（`DefaultResourceLoader`）。2026-08-12 统一代理抽象后 `MainSessionHost implements ModelResolver`（`resolveModel`/`resolveApiKey`），模型配置与子代理同源（`LlmConfigStore`，env 兜底：`NE_LLM_PROVIDER` / `NE_LLM_MODEL` / `NE_LLM_API_KEY`，或 provider 标准 env）。
- **运行时上下文**（`src/app/chat-context.ts`）：`ChatContext` 懒启动主会话（绑定当前活跃项目），项目切换时 dispose + 重建；按项目缓存 `OrchestratorService`。
- **工具**（`src/chat/scheduler-tools.ts`）：主会话经 `customTools` 注册 4 个编排器工具（`scheduler_dispatch` / `scheduler_commit` / `scheduler_discard` / `scheduler_queue_status`），与 MCP 版语义对齐。
- **路由优先级**：`handleExtApi`（files/projects/admin）→ `handleChatApi`（/api/chat/*）→ 世界图路由。未装配 `ChatContext` 时 /api/chat/* 返回 503 `CHAT_UNAVAILABLE`。
- **响应 envelope**：与其它路由一致 `{ ok, data, error: { code, message } }`。
- **安全前提**：只监听 localhost，端点不做鉴权。

## 端点

### POST /api/chat/message

发送一条用户消息给主会话。**接收即回**（PI RPC 模式的 preflightResult 语义），回复内容经 SSE 事件流推送。

- 请求体：`{ "text": "用户消息" }`（非空字符串）
- 成功：`200 { ok: true, data: { received: true } }`
- 失败：`400 MISSING_FIELD`（缺 text）/ `400 INVALID_BODY`（非 JSON 对象）/ `409 NO_ACTIVE_PROJECT`（未激活项目）/ `409 CHAT_BUSY`（主会话正在处理上一条消息）/ `501 EMBEDDER_UNAVAILABLE`（未加 `--embed` 启动）/ `400 MODEL_NOT_READY`（模型不可用，未配置模型或 API Key）

### GET /api/chat/events

SSE 事件流。客户端先开此连接，再 POST message 即可收到增量事件。事件为 `session.subscribe` 原样 JSON 序列化（`data: <json>\n\n`），每 30 秒心跳 `:heartbeat`，客户端断开自动取消订阅。

关键事件语义（UI 端按此渲染）：

| 事件 | 语义 |
|---|---|
| `message_update` | 携带**完整 message 快照**（非 delta），UI 全量替换重绘（流式文本） |
| `message_start` / `message_end` | 消息开始 / 结束（end 含错误标红） |
| `tool_execution_start/update/end` | 工具调用，按 `toolCallId` 增量更新工具卡片 |
| `turn_start` / `turn_end` / `agent_end` | 轮次 / run 完成信号（前端以 `agent_end` 收尾） |

- 失败：`409 NO_ACTIVE_PROJECT` / `501 EMBEDDER_UNAVAILABLE`（JSON envelope，SSE 未开始）

### GET /api/chat/status

会话状态（只读，不触发会话启动）。

- 成功：`200 { ok: true, data: { active, cwd, isStreaming, systemPrompt, sessionId, modelFallbackMessage } }`
  - `active`：主会话已启动且项目已激活
  - `cwd`：会话绑定项目目录（未启动为 null）
  - `systemPrompt`：当前生效系统提示词（含 `.pi/SYSTEM.md` 注入内容，未启动为 null）
  - `sessionId`：主会话当前写入的会话 id（未启动为 null；前端以此对齐 `/api/chat/sessions` 的 `live` 标记）

### GET /api/chat/sessions

返回历史会话列表（只读，不触发主会话启动）。源码：`ChatContext.listSessions()` → `SessionManager.list`，路由层在每项上附加 `live` 标记（与 `/api/chat/status` 的 `sessionId` 对齐）。

- 成功：`200 { ok: true, data: { sessions: SessionInfo[] } }`
  - 每项 `SessionInfo` 字段：
    - `id: string` — 会话 ID
    - `name: string | null` — 会话名（未设置时为 null）
    - `created: string` — 创建时间（ISO 字符串）
    - `modified: string` — 最后修改时间（ISO 字符串）
    - `messageCount: number` — 消息条数
    - `firstMessage: string | null` — 首条用户消息预览（空会话为 null）
    - `live: boolean` — 是否为当前主会话正在写入的会话（未启动主会话时全为 false）
- 失败：`409 NO_ACTIVE_PROJECT`（未激活项目）

### GET /api/chat/sessions/:id/messages

返回指定会话的历史消息列表（只读）。源码：`ChatContext.getSessionMessages(id)`，聚合 assistant 消息的 toolCall/toolResult（toolResult 不单独返回，而是合并到对应 assistant 消息的 `toolCalls` 字段）。

- 路径参数：`id` — 会话 ID（URL 编码）
- 成功：`200 { ok: true, data: { id: string, messages: HistoricalChatMessage[] } }`
  - `HistoricalChatMessage` 字段：
    - `role: string` — 消息角色（`user` / `assistant`，`toolResult` 已被聚合不单独返回）
    - `text: string` — 消息文本（纯文本部分；对纯工具调用消息为空字符串）
    - `ts: string` — 消息时间戳（session entry 的写入时间，ISO 字符串）
    - `toolCalls?: HistoricalToolCall[]` — 仅 assistant 消息且含工具调用时存在；每项含 `id` / `name` / `status`（"done" | "error"）/ `isError`
    - `provider?: string` — 仅 assistant 消息；LLM provider
    - `model?: string` — 仅 assistant 消息；LLM 模型名
    - `usage?: UsageSummary` — 仅 assistant 消息且原始消息含 usage 时存在；含 `inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens`
- 失败：`409 NO_ACTIVE_PROJECT`（未激活项目）

### POST /api/chat/sessions

新建空会话（`live` 标记转移到新会话，旧活跃会话保持存活、后台生成继续）。源码：`ChatContext.createSession()`。

- 成功：`200 { ok: true, data: { session: SessionInfo & { live: true } } }`
  - `session` 字段同 `GET /api/chat/sessions` 列表项（`id` / `name` / `created` / `modified` / `messageCount` / `firstMessage` / `live`），另附 `path`（会话文件路径）
- 失败：`409 NO_ACTIVE_PROJECT`（未激活项目）/ `501 EMBEDDER_UNAVAILABLE`（未加 `--embed` 启动）

### POST /api/chat/sessions/:id/activate

切换到指定会话（`live` 标记转移，主会话后续写入落到该会话；不中断其他会话的后台生成）。源码：`ChatContext.activateSession(id)`。`id` 可为完整会话 ID 或唯一前缀（前缀命中多个时报错）。

- 路径参数：`id` — 会话 ID 或唯一前缀（URL 编码）
- 成功：`200 { ok: true, data: { session: SessionInfo & { live: true } } }`（字段同新建会话响应）
- 失败：`409 NO_ACTIVE_PROJECT` / `404 SESSION_NOT_FOUND`（会话不存在）/ `400 SESSION_INVALID_PATH`（前缀不唯一）/ `501 EMBEDDER_UNAVAILABLE`

### POST /api/chat/abort

中断会话生成（body 可带 `sessionId` 指定后台会话，缺省中断当前活跃会话）。源码：`ChatContext.abortChat(sid?)`。

- 请求体：`{ "sessionId": "可选" }`
- 成功：`200 { ok: true, data: { aborted: boolean, sessionId: string } }`（目标会话未在流式生成时 `aborted: false`）
- 失败：`409 NO_ACTIVE_PROJECT` / `404 SESSION_NOT_FOUND`（指定会话不存在或无活跃会话）

## 数据流

```
未来前端 → POST /api/chat/message + GET /api/chat/events(SSE)
         → ChatContext（懒启动 MainSessionHost + 按活跃项目装配 OrchestratorService）
         → MainSessionHost（services → 工厂 → runtime，.pi/SYSTEM.md 最简提示词）
         → customTools（scheduler_dispatch 等 4 工具）
         → OrchestratorService → 子代理 → 世界图
```

## 相关文档

- [unified-server.md](unified-server.md)（服务挂载与路由优先级）
- [pi-tools-role-scheduler.md](pi-tools-role-scheduler.md)（调度器工具语义）
- `docs/plans/2026-08-01-main-session-execution-plan.md`（实施与决策）
