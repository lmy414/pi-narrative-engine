# 主会话 SDK 落地可行性调研（最简提示词版，不含记忆注入）

> 日期：2026-08-01
> 状态：可行性调研（结论：✅ 可行）
> 决策来源（用户，2026-08-01）：
> - 现在完成主会话（createAgentSessionRuntime 接入）
> - **不完成记忆注入**——记忆注入与提示词本质是同一个工作（每轮动态重读 memory.md 拼 systemPrompt）
> - 先完成**最基础的最简单提示词版**；提示词优化是另一个很重的独立工作，后续排期
> - **不做前端内容，只保留 API 给未来前端**（2026-08-01 补充）
> 关联：
> - `docs/plans/2026-07-31-sdk-integration-architecture.md`（SDK 集成架构决策，§3.2 主会话用 createAgentSessionRuntime）
> - `docs/plans/2026-08-01-data-layer-ports-implementation-report.md`（数据层 Ports 接线落地）
> - `docs/plans/2026-07-31-orchestrator-standalone-research.md`（编排器独立化调研）

## 一、调研目标

主会话是目标数据流（**主会话** → 编排器 → 子代理 → 世界图）的**起点**，当前完全缺失（代码零引用 `createAgentSessionRuntime`，仅设计文档）。

本调研回答：**主会话如何用 PI SDK 接入？最简提示词版怎么做？如何接入 unified-server HTTP 与编排器？**

**边界（用户明确）**：
- ✅ 主会话 SDK 接入（createAgentSessionRuntime）
- ✅ 最简静态提示词（不含记忆注入）
- ✅ **后端 API 契约**（HTTP 聊天端点，供未来前端接入）
- ❌ 记忆注入（每轮动态重读 memory.md 拼 systemPrompt）——与提示词优化同属后续工作
- ❌ 提示词优化（很重的独立内容，后续排期）
- ❌ **前端内容**（聊天 UI 不做，只保留 API 给未来前端）

## 二、主会话 SDK 查证结果（基于源码）

### 2.1 PI 本体的实际用法（关键查证）

**PI 本体（`pi-ex/packages/coding-agent/src/main.ts`）从不直接调用 `createAgentSession`**，而是走三层结构：

```
main.ts
  → createAgentSessionServices({ cwd, agentDir, resourceLoaderOptions })   // ① cwd 绑定服务
      → 返回 AgentSessionServices { cwd, agentDir, authStorage, settingsManager, modelRegistry, resourceLoader, diagnostics }
  → 构造工厂闭包 createRuntime: CreateAgentSessionRuntimeFactory            // ② 工厂（可复用）
      → createAgentSessionFromServices({ services, sessionManager, model, ... })  // ③ 会话
        → 内部复用 createAgentSession
  → createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager })   // ④ runtime 宿主
  → 模式入口（interactive/rpc/print）拿到 runtime.session 使用
```

**为什么这么设计**（[agent-session-services.ts:126-130](file:///d:/claude/pi-ex/pi-ex/packages/coding-agent/src/core/agent-session-services.ts) 注释）：服务（Settings/ModelRegistry/ResourceLoader）与 cwd 绑定，会话（AgentSession）单独创建，这样 `/new` `/resume` `/fork` 切换时**复用同一工厂重建会话**，服务不重建。

**narrative-engine 应照搬此结构**——多项目切换（ProjectRegistry）与 PI 的 `/resume` 场景同构。

### 2.2 两个入口的区别（查证）

| 维度 | `createAgentSession` | `createAgentSessionRuntime` |
|---|---|---|
| 来源 | [sdk.ts:204](file:///d:/claude/pi-ex/pi-ex/packages/coding-agent/src/core/sdk.ts) | [agent-session-runtime.ts:393](file:///d:/claude/pi-ex/pi-ex/packages/coding-agent/src/core/agent-session-runtime.ts) |
| 返回 | `{ session, extensionsResult, modelFallbackMessage }` | `AgentSessionRuntime`（包装 session + 完整生命周期） |
| 能力 | 创建会话 + prompt + subscribe | 上述 + **new/resume/fork/import/branch** 等完整会话管理 |
| 依赖 | 无（自建 AuthStorage/ModelRegistry/ResourceLoader） | 需 `createRuntime` 工厂 + `agentDir` + `sessionManager` |
| 适用 | 单会话应用 | **主会话完整生命周期**（设计文档 §3.2 锁定） |

**结论**：主会话按设计文档用 `createAgentSessionRuntime` + `createAgentSessionServices`（PI 本体同构）。两个函数均从 `@earendil-works/pi-coding-agent` 导出（[agent-session-runtime.ts:413-420](file:///d:/claude/pi-ex/pi-ex/packages/coding-agent/src/core/agent-session-runtime.ts) re-export）。

### 2.3 `AgentSessionServices` 与工厂（查证 [agent-session-services.ts](file:///d:/claude/pi-ex/pi-ex/packages/coding-agent/src/core/agent-session-services.ts)）

```typescript
// ① 服务层（cwd 绑定）
export async function createAgentSessionServices(options: {
  cwd: string;
  agentDir?: string;
  authStorage?: AuthStorage;
  settingsManager?: SettingsManager;
  modelRegistry?: ModelRegistry;
  resourceLoaderOptions?: Omit<DefaultResourceLoaderOptions, "cwd" | "agentDir" | "settingsManager">;
}): Promise<AgentSessionServices>;

// ② 工厂闭包类型
export type CreateAgentSessionRuntimeFactory = (opts: {
  cwd: string; agentDir: string; sessionManager: SessionManager; sessionStartEvent?: SessionStartEvent;
}) => Promise<CreateAgentSessionRuntimeResult>;

// ③ 会话创建
export async function createAgentSessionFromServices(options: {
  services: AgentSessionServices;
  sessionManager: SessionManager;
  sessionStartEvent?: SessionStartEvent;
  model?: Model<any>;
  thinkingLevel?: ThinkingLevel;
  tools?: string[];
  customTools?: ToolDefinition[];
}): Promise<CreateAgentSessionResult>;
```

### 2.4 `AgentSession` 核心方法（查证 [agent-session.ts](file:///d:/claude/pi-ex/pi-ex/packages/coding-agent/src/core/agent-session.ts)）

```typescript
// 发送消息（async，流式内部处理）
async prompt(text: string, options?: PromptOptions): Promise<void>;
// 事件订阅（Web UI 映射来源）
subscribe(listener: AgentSessionEventListener): () => void;
// 绑定扩展 UI 上下文（发 session_start 事件）
bindExtensions(bindings: ExtensionBindings): Promise<void>;
// 系统提示词（可读）
get systemPrompt(): string;
// 是否流式中
get isStreaming(): boolean;
```

### 2.5 最简提示词注入方式（关键查证）

**PI 本体用 `DefaultResourceLoader` 自动发现，非硬编码**（[resource-loader.ts:468-488](file:///d:/claude/pi-ex/pi-ex/packages/coding-agent/src/core/resource-loader.ts)）：

| 注入点 | 优先级 | 用途 |
|---|---|---|
| `resourceLoaderOptions.systemPrompt` | 最高（显式） | CLI `--system-prompt` 或代码传入 |
| `.pi/SYSTEM.md` 文件 | 次（自动发现） | **项目级系统提示词**（推荐 narrative-engine 用） |
| `agentDir/SYSTEM.md` 文件 | 次（自动发现） | 全局系统提示词 |
| `systemPromptOverride(base)` | 改造默认 | 需要保留默认内容时 |
| `AGENTS.md` / `CLAUDE.md` | context 文件 | 自动发现拼 `<project_context>`（[resource-loader.ts:57-113](file:///d:/claude/pi-ex/pi-ex/packages/coding-agent/src/core/resource-loader.ts)） |

**最简提示词版**（推荐用 `.pi/SYSTEM.md` 项目文件，而非代码硬编码）：
- 在 novel 项目 `.pi/SYSTEM.md` 写最简提示词
- `DefaultResourceLoader` 自动发现并注入
- 好处：**提示词与代码分离**，后续优化（含记忆注入）只改文件不改代码

```typescript
// 服务创建时传入 resourceLoaderOptions（或干脆不传，自动发现 .pi/SYSTEM.md）
const services = await createAgentSessionServices({
  cwd: novelProjectDir,
  agentDir: APP_AGENT_DIR,          // 应用自有配置目录（避免污染 ~/.pi/agent）
});
// .pi/SYSTEM.md 自动被 DefaultResourceLoader 发现 → buildSystemPrompt 注入
```

### 2.6 事件流与 UI 双轨渲染（PI 本体核心模式）

**事件订阅**（[interactive-mode.ts:2668-2672](file:///d:/claude/pi-ex/pi-ex/packages/coding-agent/src/modes/interactive/interactive-mode.ts)）：

```typescript
this.unsubscribe = this.session.subscribe(async (event) => {
  await this.handleEvent(event);   // switch(event.type) 驱动 UI
});
```

**关键事件语义**（narrative-engine 前端直接复用）：
- `message_update`：**携带完整 `message` 快照**（非 delta 文本），UI 端全量替换内容重绘（[interactive-mode.ts:2747-2780](file:///d:/claude/pi-ex/pi-ex/packages/coding-agent/src/modes/interactive/interactive-mode.ts)）
- `tool_execution_start/update/end`：按 `toolCallId` 增量更新工具卡片（[interactive-mode.ts:2821-2862](file:///d:/claude/pi-ex/pi-ex/packages/coding-agent/src/modes/interactive/interactive-mode.ts)）
- `message_end`：收尾（aborted/error 标红，清空 streaming 状态）

**流式产出来源**：`agent-loop.ts` 消费 `streamSimple` 的 AsyncIterable，产出 `message_start/message_update/message_end` 事件，`Agent` 收敛内部 state 后广播。**UI 只做"按事件增量重绘"，不自己调 LLM**。

### 2.7 RPC 模式的 preflightResult 模式（HTTP 端点参考）

RPC 模式（[rpc-mode.ts:389-411](file:///d:/claude/pi-ex/pi-ex/packages/coding-agent/src/modes/rpc/rpc-mode.ts)）的 prompt 处理：

```typescript
case "prompt": {
  let preflightSucceeded = false;
  void session.prompt(command.message, {
    preflightResult: (didSucceed) => {
      if (didSucceed) { preflightSucceeded = true; output(success(id, "prompt")); }
    },
  }).catch((e) => { if (!preflightSucceeded) output(error(id, "prompt", e.message)); });
}
```

**要点**：prompt 被接收（进入队列/开始处理）即回响应，后续内容走事件流；失败才回 error。**HTTP 聊天端点的 POST /api/chat/message 应照搬此模式**——立即返回 `{ ok: true }`，内容经 SSE 事件流推送。

## 三、可行性结论

**✅ 可行。主会话 SDK 接入技术上完全成立，且"最简提示词版"的实现路径最直接。**

依据：
1. PI 本体三层结构（services → 工厂 → runtime）已查证，可直接照搬（查证 §2.1）
2. 最简提示词用 `.pi/SYSTEM.md` 自动发现即可（查证 §2.5），**不需要记忆注入**
3. 编排器已可独立运行（MCP stdio + OrchestratorService），主会话通过 `customTools` 调用编排器
4. unified-server HTTP 骨架已存在，加聊天端点即可
5. 模型来源 `services.modelRegistry`（PI 本体机制），无需额外配置

## 四、目标架构（后端 API 契约，不含前端）

```
┌────────────────────────────────────────────────────────────┐
│ 未来前端（聊天 UI，本阶段不做）                               │
│  · 经 HTTP API 接入：POST /api/chat/message + SSE 事件流     │
└──────────────────────────┬─────────────────────────────────┘
                           │ 标准 API 契约（envelope + SSE）
                           ▼
┌────────────────────────────────────────────────────────────┐
│ unified-server HTTP（聊天端点，本阶段交付）                   │
│  · POST /api/chat/message（发消息，preflightResult 模式）    │
│  · GET /api/chat/events（SSE 事件流，完整 message 快照）     │
│  · GET /api/chat/status（会话状态）                          │
└──────────────────────────┬─────────────────────────────────┘
                           ▼
┌────────────────────────────────────────────────────────────┐
│ 主会话层（PI SDK 模式，PI 本体同构）                          │
│  · MainSessionHost：services → 工厂 → runtime                │
│  · session.prompt(text) + session.subscribe(events)         │
│  · 最简提示词：.pi/SYSTEM.md 自动发现（无记忆注入）           │
│  · 内容归类：skill 提示（后续优化；最简版靠提示词说明）        │
└───────────────┬────────────────────────────┬────────────────┘
                │ customTools                 │ HTTP / MCP
                ▼                             ▼
┌────────────────────────────┐  ┌─────────────────────────────┐
│ 编排器工具（SDK 注册）       │  │ OrchestratorService          │
│  scheduler_dispatch/commit/ │  │ （已实现，HTTP 化后续）       │
│  discard/queue_status       │  └─────────────────────────────┘
└────────────────────────────┘
```

**本阶段交付物**：主会话层（MainSessionHost）+ 编排器工具注册 + 3 个 HTTP 聊天端点。**前端 UI 不做**——API 契约就绪，未来前端直接接入。

## 五、关键技术设计

### 5.1 主会话服务（src/chat/ 目录，PI 本体同构）

**参考 PI 本体三层结构**（[main.ts:588-679](file:///d:/claude/pi-ex/pi-ex/packages/coding-agent/src/main.ts)）：services → 工厂闭包 → runtime。多项目切换复用工厂重建会话。

```typescript
// src/chat/main-session.ts（最简提示词版，PI 本体同构）
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type AgentSessionServices,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export interface MainSessionHostOptions {
  /** 应用自有配置目录（避免污染 ~/.pi/agent；含 auth.json / models.json / SYSTEM.md） */
  agentDir: string;
  /** 初始项目目录 */
  cwd: string;
  /** 会话持久化目录 */
  sessionDir: string;
  /** 主会话工具（编排器 4 工具 + 世界图子集） */
  customTools: ToolDefinition[];
}

/**
 * 主会话宿主（PI 本体同构：services + 工厂闭包 + runtime）
 *
 * - services（cwd 绑定）：创建一次，跨项目切换复用
 * - 工厂闭包：/new /resume /fork（项目切换）时重建会话，服务不重建
 * - 最简提示词：.pi/SYSTEM.md 自动发现（DefaultResourceLoader），代码不硬编码
 */
export class MainSessionHost {
  private runtime!: Awaited<ReturnType<typeof createAgentSessionRuntime>>;
  private readonly opts: MainSessionHostOptions;

  constructor(opts: MainSessionHostOptions) {
    this.opts = opts;
  }

  /** 创建服务 + 工厂 + runtime（PI 本体 main.ts:588-679 结构） */
  async start(): Promise<void> {
    const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        // resourceLoaderOptions 不传 → 自动发现 .pi/SYSTEM.md / AGENTS.md
      });
      const created = await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        customTools: this.opts.customTools,
        // model 不传 → 从 services.modelRegistry 探测（settings 默认）
      });
      return { ...created, services, diagnostics: services.diagnostics };
    };

    const sessionManager = SessionManager.create(this.opts.cwd, this.opts.sessionDir);
    this.runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: this.opts.cwd,
      agentDir: this.opts.agentDir,
      sessionManager,
    });
  }

  /** 当前会话 */
  get session() {
    return this.runtime.session;
  }

  /** 切换项目（复用工厂重建会话，服务不重建——PI 的 /resume 同构） */
  async switchProject(cwd: string): Promise<void> {
    const sessionManager = SessionManager.create(cwd, this.opts.sessionDir);
    await this.runtime.switchSession(sessionManager.getSessionFile());
  }
}
```

### 5.2 最简提示词版的关键决策

| 决策点 | 本阶段 | 理由 |
|---|---|---|
| 记忆注入 | **不做** | 用户决策：记忆注入与提示词本质同一工作，属后续优化 |
| 系统提示词 | **`.pi/SYSTEM.md` 文件自动发现** | PI 本体模式（DefaultResourceLoader），提示词与代码分离；后续优化只改文件 |
| 内容归类 | 靠提示词说明 + skill（后续） | 最简版不实现显式分类 |
| 模型 | `services.modelRegistry` 探测（settings 默认） | 复用 PI 本体机制；如需指定可传 `model` |
| 工具 | 编排器 4 工具 + 世界图子集（customTools） | 主会话 LLM 可触发调度 |
| agentDir | **应用自有目录**（非 ~/.pi/agent） | 独立应用的凭据/配置归属应用 |

### 5.3 主会话 → 编排器的接线

**两条路径（本阶段选 customTools，同进程）**：

```typescript
// src/chat/scheduler-tools.ts（编排器工具注册）
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

export function createSchedulerTools(orchestratorService: OrchestratorService): ToolDefinition[] {
  return [
    defineTool({
      name: "scheduler_dispatch",
      label: "Scheduler Dispatch",
      description: "派发事件到编排器（plan 模式返回 planId，yolo 模式自动落地）",
      parameters: Type.Object({
        storyTime: Type.String({ description: "故事时间 ch{NNN}.ev{NNN}" }),
        instruction: Type.String(),
        characterIds: Type.Array(Type.String()),
        mode: Type.Optional(Type.Union([Type.Literal("plan"), Type.Literal("yolo")])),
      }),
      async execute(_id, params, _signal, _onUpdate, _ctx: ExtensionContext) {
        const result = await orchestratorService.dispatch(params);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    }),
    // scheduler_commit / scheduler_discard / scheduler_queue_status 同构
  ];
}
```

**决策**：首期用 `customTools` 同进程注册（避免 HTTP 往返、配置简单）；HTTP 化编排器（`/api/schedule/*`）作为前端接入支撑并行做。

### 5.4 HTTP 聊天端点（unified-server 扩展，参考 PI RPC 模式）

```typescript
// src/app/routes-chat.ts（新增，复用 envelope + preflightResult 模式）
POST /api/chat/message   // body: { text } → session.prompt(text, { preflightResult }) → 立即 { ok: true }
GET  /api/chat/events    // SSE：session.subscribe 事件流推给前端（message_update 带完整快照）
GET  /api/chat/status    // { ok, data: { isStreaming, systemPrompt } }
```

**SSE 事件映射**（参考 PI [interactive-mode.ts:2747-2780](file:///d:/claude/pi-ex/pi-ex/packages/coding-agent/src/modes/interactive/interactive-mode.ts) 双轨渲染）：

```typescript
session.subscribe((event) => {
  switch (event.type) {
    case "message_update":     // 携带完整 message 快照 → 前端全量替换重绘（流式文本）
    case "tool_execution_start" / "tool_execution_update" / "tool_execution_end":
                               // 按 toolCallId 增量更新工具卡片
    case "message_end":        // 收尾（error 标红）
  }
  sse.send(event);   // 原样 JSON 序列化（PI RPC 模式同款）
});
```

**POST /api/chat/message 的 preflightResult 语义**（照搬 [rpc-mode.ts:389-411](file:///d:/claude/pi-ex/pi-ex/packages/coding-agent/src/modes/rpc/rpc-mode.ts)）：接收即回 `{ ok: true }`，内容经 SSE 推送；模型校验失败才回 error。

### 5.5 与既有模块的关系

| 模块 | 关系 |
|---|---|
| LlmConfigStore | 主会话模型可复用 `services.modelRegistry`（PI 本体机制）；LlmConfigStore 用于子代理 slot |
| OrchestratorService | 主会话经 customTools 调用（dispatch/commit/discard/queue_status） |
| unified-server | 扩展 3 个聊天端点 |
| 世界图路由 | 已存在，主会话 world_* 工具可选接入 |
| ProjectRegistry | **多项目切换与 MainSessionHost.switchProject 联动**（工厂重建会话） |
| PI 扩展入口（src/index.ts） | **不冲突**：扩展模式仍可用，SDK 主会话是独立入口 |

## 六、实施路径建议

**本阶段交付物（用户明确）**：主会话层 + 编排器工具 + HTTP API 契约。**不做前端**。

### 步骤 C1：主会话最小链路（PI 本体同构，验证 createAgentSessionServices + Runtime 可用）

- 新建 `src/chat/main-session.ts`（§5.1 的 `MainSessionHost`，PI 本体三层结构）
- 新建 `src/chat/prompt.ts`：最简系统提示词（`.pi/SYSTEM.md` 文件，或 `resourceLoaderOptions.systemPrompt` 兜底）
- 新建 `scripts/main-session-smoke.ts`：启动 host → `session.prompt("你好")` → subscribe 打印回复
- **验收**：纯 Node 进程跑通一次对话（.pi/SYSTEM.md 被自动发现注入）

### 步骤 C2：编排器工具注册

- 新建 `src/chat/scheduler-tools.ts`：4 个调度工具包装 `OrchestratorService`（§5.3）
- **验收**：主会话 prompt 中让 LLM 调 `scheduler_dispatch` → 队列出现任务

### 步骤 C3：HTTP 聊天端点（API 契约，本阶段交付）

- 新建 `src/app/routes-chat.ts`（message/events SSE/status 三端点，preflightResult 模式）
- unified-server 挂载
- **验收**：curl POST /api/chat/message 立即收到 `{ ok: true }`；SSE 事件流（message_update 完整快照）正常
- **契约文档**：更新 `docs/api/`（chat.md 或并入 unified-server.md）

### 前端（明确不做）

- ❌ 聊天 UI / 调度触发按钮——本阶段不做，未来前端经已交付的 API 接入

## 七、风险与存疑

| # | 存疑点 | 影响 | 验证方式 |
|---|---|---|---|
| 1 | `createAgentSessionServices` 在纯 Node 进程的可用性（依赖 agentDir 目录 / auth.json / models.json） | 高 | 步骤 C1 smoke 直接验证；`agentDir` 指向应用自有目录 |
| 2 | `.pi/SYSTEM.md` 自动发现是否生效（`discoverSystemPromptFile` 的路径逻辑） | 中 | 步骤 C1 打印 `session.systemPrompt` 确认 |
| 3 | `createAgentSessionFromServices` 的 `model` 缺省探测（settings 默认模型是否有配置） | 中 | C1 验证；无配置时 `modelFallbackMessage` 提示 |
| 4 | `customTools` 的 `ExtensionContext` 在 SDK 模式下是否完整（ctx.model 等） | 中 | 已查证 [runner.ts createContext](file:///d:/claude/pi-ex/pi-ex/packages/coding-agent/src/core/extensions/runner.ts) 提供，C2 实测 |
| 5 | SSE 与 session.subscribe 的背压（长回复流式推送；PI RPC 用 waitForRawStdoutBackpressure） | 中 | C3 实测长文本 |
| 6 | 多项目切换（switchProject → switchSession）的会话文件路径 | 低 | C1 后检查 session 文件生成 |
| 7 | 提示词优化（含记忆注入）本阶段明确不做 | — | 用户决策，后续排期；`.pi/SYSTEM.md` 文件机制已预留改入口 |

## 八、与既有设计的关系

| 维度 | 本调研 | SDK 集成架构 | 编排器独立化 | 数据层 Ports |
|---|---|---|---|---|
| 关注点 | 主会话 SDK 落地（最简提示词版） | 主会话用 createAgentSessionRuntime | 编排器独立运行 | 数据层标准接口 |
| 关系 | 落实 §3.2 的主会话决策，**并参考 PI 本体 main.ts 实现** | 本调研是其实施 | 主会话调编排器 | 主会话工具底层 |
| 阶段 | 数据流起点落地 | 第三核心 | 已完成 | 已完成 |

**本阶段完成后的数据流（后端）**：
```
未来前端 → HTTP API（/api/chat/*）→ 主会话（MainSessionHost + .pi/SYSTEM.md 最简提示词）
         → customTools → 编排器 → 子代理 → 世界图
```

## 九、决策溯源

1. 用户决策：现在完成主会话，**不做记忆注入**（与提示词本质同一工作），先做最简提示词版
2. 用户补充：**不做前端内容，只保留 API 给未来前端**
3. **参考 PI 本体主会话实现**（`pi-ex/packages/coding-agent/src/main.ts`）：确认 PI 从不直接调 createAgentSession，而是 services → 工厂闭包 → runtime 三层结构
4. 查证 `createAgentSessionServices` / `createAgentSessionFromServices`：确认 cwd 绑定服务 + 会话分离，多项目切换复用工厂
5. 查证 `DefaultResourceLoader` 自动发现 `.pi/SYSTEM.md` / `AGENTS.md`：确认最简提示词用**文件**而非代码硬编码
6. 查证 `AgentSession.prompt()/subscribe()/bindExtensions()/systemPrompt`：确认对话与事件流 API
7. 查证 PI interactive 模式事件双轨渲染（message_update 完整快照 + tool_execution 卡片）：确认未来前端渲染模式（本阶段不做 UI，但事件契约按此设计）
8. 查证 PI RPC 模式 preflightResult：确认 HTTP 聊天端点"接收即回、内容走事件流"语义
9. 结论：✅ 可行。实施 = MainSessionHost（PI 本体同构）+ .pi/SYSTEM.md 最简提示词 + 编排器工具注册 + HTTP 聊天端点（preflightResult + SSE）；前端不做
