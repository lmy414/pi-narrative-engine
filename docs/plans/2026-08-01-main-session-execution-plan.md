# 主会话 SDK 落地执行方案（最简提示词版）

> 日期：2026-08-01
> 状态：✅ 已实施完成（C1-C3 全部验收通过，663 测试全绿）
> 依据：`docs/plans/2026-08-01-main-session-sdk-implementation.md`（可行性调研，结论 ✅ 可行）
> 关联：
> - `docs/plans/2026-07-31-sdk-integration-architecture.md`（架构决策：主会话用 createAgentSessionRuntime）
> - `docs/plans/2026-08-01-data-layer-ports-implementation-report.md`（数据层 Ports 落地）
> - `docs/plans/2026-07-31-orchestrator-standalone-implementation.md`（编排器独立化）

## 一、调研评估结论

调研文档的结论与路径（C1 最小链路 → C2 编排器工具 → C3 HTTP 端点）**成立**，全部关键 API 已二次查证（本次基于 node_modules 实际 .d.ts）：

| API | 查证结果 |
|---|---|
| `createAgentSessionServices({ cwd, agentDir, resourceLoaderOptions? })` | ✅ [agent-session-services.d.ts:78] |
| `createAgentSessionFromServices({ services, sessionManager, model?, customTools? })` | ✅ [agent-session-services.d.ts:86]，返回 `{ session, extensionsResult, modelFallbackMessage? }` |
| `createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager })` | ✅ [agent-session-runtime.d.ts:110]，工厂返回 `CreateAgentSessionRuntimeResult`（= session + services + diagnostics） |
| `SessionManager.create(cwd, sessionDir?)` | ✅ [session-manager.d.ts:294] |
| `AgentSession.prompt(text, { preflightResult })` | ✅ [agent-session.d.ts:124-135] |
| `AgentSession.subscribe(listener)` / `systemPrompt` / `isStreaming` | ✅ [agent-session.d.ts:240/266/264] |
| `defineTool` / `ToolDefinition`（name/label/description/promptSnippet/parameters/execute） | ✅ [extensions/types.d.ts:328-368] |
| `.pi/SYSTEM.md` 自动发现 | ✅ `discoverSystemPromptFile()`：先 `<cwd>/.pi/SYSTEM.md`，后 `<agentDir>/SYSTEM.md` [resource-loader.js:668] |
| 主会话模型 key 解析 | ✅ `AuthStorage.getApiKey` 优先级含 env fallback + `setRuntimeApiKey()` 运行时注入（不持久化）[auth-storage.d.ts:63/132] |

**关键修正（相对调研文档）**：

1. **主会话模型来源不依赖 agentDir/auth.json**。独立应用 auth.json 初始为空；但 `AuthStorage` 支持 `setRuntimeApiKey(provider, key)` 运行时注入，且 key 解析有 env fallback。**决策**：主会话模型与子代理共用 `LlmConfigStore`（env/配置中心）——创建 host 时从 LlmConfigStore 解析 default slot 的 Model + apiKey，`setRuntimeApiKey` 注入 + 显式传 `model`。auth.json 无需预置。
2. **弃用调研文档 §5.1 的 `switchProject`（switchSession）**：`SessionManager.create` 新会话未落盘时 `getSessionFile()` 可能为 undefined，边界不可靠。**改为 dispose + 重建**（复用同一工厂闭包），项目切换语义一致且无边界问题。
3. **customTools 必须提供 `promptSnippet`**：`ToolDefinition` 注释明确「custom tools are omitted from that section when promptSnippet is not provided」——不写则 LLM 看不到工具，工具注册形同虚设。
4. **并发 prompt 契约**：`isStreaming` 时 POST message 返回 409 CHAT_BUSY（AgentSession 单流约束），前端稍后重试；不做 followUp 排队（最简版）。
5. **agentDir 路径**：复用 `@pi/admin` 的 `_defaultConfigDir()`（平台目录，已导出 [admin/src/index.ts:198]）+ `pi-agent` 子目录，与 unified-server 的 `appConfigDir` 同源。
6. **会话持久化**：sessionDir = `<cwd>/.pi/sessions`（硬约束：运行时数据放项目目录）。

## 二、目标架构与文件结构

```
未来前端 → HTTP API（POST /api/chat/message + GET /api/chat/events SSE）
         → ChatContext（懒启动 MainSessionHost + 按活跃项目装配 OrchestratorService）
         → MainSessionHost（services → 工厂 → runtime，.pi/SYSTEM.md 最简提示词）
         → customTools（scheduler_dispatch/commit/discard/queue_status）
         → OrchestratorService → 子代理 → 世界图
```

新增文件：

```
src/chat/main-session.ts        # MainSessionHost（PI 本体同构三层结构 + dispose）
src/chat/scheduler-tools.ts     # createSchedulerTools(provider)：4 个编排器工具（defineTool）
src/app/chat-context.ts         # ChatContext：懒启动 host / 项目切换重建 / OrchestratorService 按项目缓存
src/app/routes-chat.ts          # /api/chat/message、/api/chat/events（SSE）、/api/chat/status
scripts/main-session-smoke.ts   # C1 验收：纯 Node 真实对话 + .pi/SYSTEM.md 自动发现
tests/chat-routes.test.ts       # HTTP 契约单测（stub host，不调 LLM）
tests/chat-scheduler-tools.test.ts  # 工具转发单测（stub service）
docs/api/chat.md                # 聊天 API 契约文档
```

修改文件：

```
src/app/unified-server.ts       # 挂载 routes-chat（handleExtApi 之后、世界图路由之前）
src/app/main.ts                 # 装配 ChatContext（registry + llmStore + configDir）传入 server
src/tools/scheduler-tools.ts    # 导出 validateStoryTime（复用，不新增冗余）
```

## 三、关键设计

### 3.1 MainSessionHost（src/chat/main-session.ts）

```typescript
export interface MainSessionHostOptions {
  agentDir: string;          // 应用配置目录（平台目录/pi-agent），含 SYSTEM.md 兜底
  cwd: string;               // 项目目录
  sessionDir: string;        // 会话持久化目录（<cwd>/.pi/sessions）
  customTools: ToolDefinition[];
  model?: Model<any>;        // 显式模型（从 LlmConfigStore 解析，可选）
  runtimeApiKey?: { provider: string; apiKey: string };  // setRuntimeApiKey 注入（可选）
}

export class MainSessionHost {
  start(): Promise<void>     // services → 工厂 → runtime
  get session(): AgentSession
  get cwd(): string
  dispose(): Promise<void>   // runtime.dispose()
}
```

工厂闭包（start 内）与 PI 本体 main.ts 同构：

```typescript
const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd, agentDir });
  if (this.opts.runtimeApiKey) {
    services.authStorage.setRuntimeApiKey(this.opts.runtimeApiKey.provider, this.opts.runtimeApiKey.apiKey);
  }
  const created = await createAgentSessionFromServices({
    services, sessionManager, sessionStartEvent,
    model: this.opts.model, customTools: this.opts.customTools,
  });
  return { ...created, services, diagnostics: services.diagnostics };
};
```

### 3.2 主会话编排器工具（src/chat/scheduler-tools.ts）

- 与 MCP 版（`src/orchestrator/mcp-server.ts`）**语义对齐**的 4 工具：`scheduler_dispatch` / `scheduler_commit` / `scheduler_discard` / `scheduler_queue_status`。
- 签名 `createSchedulerTools(provider: () => OrchestratorService): ToolDefinition[]`——provider 为 mutable ref，项目切换后工具无需重新注册。
- `execute` 内 `const service = provider()` 直接调用（不依赖 ExtensionContext，保持编排器解耦）。
- `scheduler_dispatch` 复用 `validateStoryTime`（从 src/tools/scheduler-tools.ts 导出）。
- 每个工具提供 `promptSnippet`（关键修正 #3）。

### 3.3 ChatContext（src/app/chat-context.ts）

```typescript
export interface ChatContextOptions {
  registry: ProjectRegistry;          // 活跃项目来源
  llmStore: LlmConfigStore;           // 主会话模型配置（与子代理同源）
  configDir: string;                  // 平台配置目录（agentDir = configDir/pi-agent）
}

export class ChatContext {
  ensureHost(): Promise<MainSessionHost | null>;   // 无活跃项目 → null；cwd 变化 → dispose 重建
  ensureOrchestratorService(cwd): Promise<OrchestratorService>;  // 按项目缓存
  dispose(): Promise<void>;
}
```

- 懒启动：首个 chat 请求时才创建 host（避免无 AI 需求时拉起会话）。
- 项目切换：`registry.getActive().dir !== host.cwd` → `host.dispose()` → 重建（含 OrchestratorService 重装配）。
- OrchestratorService 装配逻辑复用 `scripts/orchestrator-mcp.ts` 的模式（llmStore + ruleset + ports + staticCardLoader 占位）。
- `MainSessionHostOptions.model/runtimeApiKey` 从 llmStore 解析：`loadLlmConfigFromEnv()` 成功则 `getModel("default")` + `getApiKey("default")`；失败则不传（prompt 报缺 key 错误，信息可读）。

### 3.4 HTTP 聊天端点（src/app/routes-chat.ts）

envelope 与既有路由一致（`{ ok, data, error }`）。

| 端点 | 语义 |
|---|---|
| `POST /api/chat/message` body `{ text }` | 无活跃项目 → 409；`isStreaming` → 409 CHAT_BUSY；`session.prompt(text, { preflightResult })` 接收即回 `{ ok: true }`（PI RPC 模式）；模型校验失败回 error |
| `GET /api/chat/events` | SSE：`session.subscribe` 事件原样 JSON 推送（`data: <json>\n\n`），30s 心跳，客户端断开取消订阅（复用 debug/sse.ts 模式） |
| `GET /api/chat/status` | `{ ok, data: { active: boolean, cwd, isStreaming, systemPrompt, modelFallbackMessage? } }` |

unified-server 挂载顺序：`handleExtApi` → `handleChatApi` → 世界图路由。chat 上下文经 `startUnifiedServer` 选项注入（`chatContext?: ChatContext | null`）。

## 四、实施步骤与验收

### C1：主会话最小链路

- 新建 `src/chat/main-session.ts` + `scripts/main-session-smoke.ts`
- smoke：临时项目目录写 `.pi/SYSTEM.md` → start host → 断言 `session.systemPrompt` 含 SYSTEM.md 内容 → `prompt("你好")` subscribe 打印回复
- **验收**：纯 Node 进程跑通一次真实对话，.pi/SYSTEM.md 被自动发现注入

### C2：编排器工具注册

- 新建 `src/chat/scheduler-tools.ts`（导出 validateStoryTime 复用）
- 新建 `src/app/chat-context.ts`
- **验收**：smoke 扩展——prompt 中让 LLM 调 `scheduler_dispatch`，`service.queueStatus()` 出现任务

### C3：HTTP 聊天端点

- 新建 `src/app/routes-chat.ts` + unified-server/main 挂载 + `docs/api/chat.md`
- **验收**：curl POST message 立即 `{ ok: true }`；SSE 事件流正常；status 返回会话状态

### 测试

- 单测不调 LLM：chat 路由契约（409/参数校验/SSE 转发，stub host）、scheduler-tools 转发（stub service）
- 回归：`npm test`（646 个既有用例不得回退）

## 五、风险与存疑

| # | 风险 | 影响 | 处置 |
|---|---|---|---|
| 1 | `createAgentSessionServices` 在 agentDir 不存在时的行为 | 高 | C1 smoke 直接验证；若建目录失败则 start 前 mkdir |
| 2 | env key 注入后 `getApiKeyAndHeaders` 是否命中 runtime override | 高 | C1 smoke 用真实 key 验证 |
| 3 | `createAgentSessionRuntime` 在纯 Node 下会否要求交互式终端 | 中 | 已查证：AgentSession 是纯类，模式（interactive/rpc）才负责 I/O；smoke 验证 |
| 4 | SSE 背压 | 低 | 本阶段不做背压（API 契约先行），长文本实测 |

## 六、决策溯源

1. 用户决策（2026-08-01）：完成主会话（createAgentSessionRuntime 接入），不做记忆注入，最简提示词版，不做前端只留 API
2. 二次查证 PI SDK 全部相关 .d.ts，确认调研文档 API 引用无误
3. 修正：模型 key 用 LlmConfigStore + setRuntimeApiKey（不依赖 auth.json）；项目切换用 dispose+重建（不用 switchSession）；customTools 补 promptSnippet；并发 prompt 返回 409
4. agentDir 复用 `@pi/admin` 平台目录（不新增路径逻辑）；sessionDir 放项目内（硬约束）
