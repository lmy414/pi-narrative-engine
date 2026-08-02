# 主会话聊天 API（/api/chat/*）

> 属于 [API 文档索引](README.md)。主会话层（PI SDK 模式：`createAgentSessionRuntime`）的 HTTP 后端契约，供未来前端聊天 UI 接入。本阶段不实现前端，只交付 API。源码位于 `src/chat/`（主会话宿主 + 编排器工具）与 `src/app/routes-chat.ts`（HTTP 端点）。

## 设计要点

- **主会话宿主**（`src/chat/main-session.ts`）：PI 本体同构三层结构（`createAgentSessionServices` → 工厂闭包 → `createAgentSessionRuntime`），最简提示词经 `.pi/SYSTEM.md` 自动发现（`DefaultResourceLoader`），代码不硬编码。模型配置与子代理同源（`LlmConfigStore`，env 兜底：`NE_LLM_PROVIDER` / `NE_LLM_MODEL` / `NE_LLM_API_KEY`，或 provider 标准 env）。
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
