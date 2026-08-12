# 2026-08-12 统一代理抽象（单一运行时）设计

> 状态：设计已对齐（2026-08-12）。
> 本文档是唯一设计依据；执行中发现冲突时先停下对齐，不擅自发挥。
> 依据用户决策：一次性全量迁移；先写文档，待审阅后再动代码。

## 1. 背景与目标

当前存在两套不相干的代理运行时：

| | 子代理（planner/role/推理/渲染） | 主会话 |
|---|---|---|
| 运行时 | `Agent`（pi-agent-core）无状态 | `AgentSession`（pi-coding-agent）有状态 |
| prompt | 直接注入 systemPrompt | resourceLoader 装配 |
| 工具 | `AgentTool` + terminate 提交 | `ToolDefinition` |
| 产出 | `tool_execution_end` 事件提取 | 文本流 |
| 生命周期 | 一次性 | 持久化（continueRecent/open） |

**目标**：统一到单一运行时 `AgentSession`。所有代理调用点（主会话、角色、可见推理、渲染器）继承同一个 `BaseAgent` 抽象类；底层运行时相同，仅**行为**（prompt 与工具集）不同。编排器作为协调层保留，不继承 `BaseAgent`。

## 2. 借鉴 Hanako 的单一运行时

Hanako（openhanako，Apache-2.0）的主会话与子代理共用同一 `AgentSession` 运行时：

- **`executeIsolated`**（`core/session-coordinator.ts`）：为子代理创建一次性 `AgentSession`，用 `SessionManager.inMemory()` 临时会话，配受限工具集，跑完即 teardown。
- **`forSubagent` 轻量 prompt**（`core/agent.ts` `buildSystemPrompt({ forSubagent: true })`）：跳过长期记忆、置顶记忆、记忆规则、团队花名册、subagent 协作段、样貌注入。子代理是隔离子会话，不带完整人格记忆。
- **指令性 prompt 收尾**（`core/session-coordinator.ts#L8088-L8097`）：子代理不靠 terminate 工具，而是被 prompt 指示「以一段指令文本收尾交付产出」；协调器订阅 `message_update → text_delta` 累积 `replyText`，`message_end` 取最终 assistant 文本作为结构化/纯文本产出。

**移植纪律**：借鉴方法、不复制规模；大段改写须在 `docs/THIRD-PARTY.md` 登记归因。SDK 版本注意差异（hanako 0.80.3 vs 本工程 0.77.x）。

## 3. 本工程 SDK 能力确认

`@earendil-works/pi-coding-agent` 的 `createAgentSession`（`core/sdk.ts#L204`，本工程已装）支持轻量子代理所需全部能力：

- `sessionManager: SessionManager.inMemory()`：一次性会话，不落盘
- `tools` / `excludeTools`：内建工具白名单/黑名单
- `customTools: ToolDefinition[]`：注册自定义工具（世界图工具等）
- `model`：显式模型；`authStorage.setRuntimeApiKey`：运行时 Key 覆盖
- `resourceLoader` / `noTools: "all"`：控制系统提示词与默认工具

已由主会话 `MainSessionHost`（`src/chat/main-session.ts`）验证同一条 Assembly 路径可用。

## 4. 设计

### 4.1 `AgentRuntime` 接口（解耦 PI 运行时来源，新建）

抽象 model/apiKey/会话创建的来源，实现 PI 独立时只替换本接口。

```typescript
// src/agents/agent-runtime.ts
export interface SessionRequest {
  /** 会话持久化目录（子代理一般不传 → inMemory） */
  sessionDir?: string;
  /** 内建工具白名单 / 黑名单 */
  tools?: string[];
  excludeTools?: string[];
  /** 自定义工具（ToolDefinition[]） */
  customTools?: ToolDefinition[];
  /** 系统提示词装配方式（子代理用 forSubagent 轻量） */
  systemPrompt?: string;
  /** 显式模型（缺省按 slot 解析） */
  model?: Model<any>;
  runtimeApiKey?: { provider: string; apiKey: string };
}

export interface AgentReply {
  /** 收尾文本（message_update → text_delta 累积） */
  text: string;
  /** 最终 assistant 消息完整文本（message_end 兜底） */
  finalAssistantText: string;
  stopReason?: string;
  errorMessage?: string;
}

export interface AgentRuntime {
  /** 按 slot 解析模型（planner/role/reasoning/renderer/default） */
  resolveModel(slot: LlmSlot): Model<any>;
  /** 按 slot 解析 API Key */
  resolveApiKey(slot: LlmSlot): string;
  /** 创建一次 AgentSession（统一运行时；主会话持久 + 唯一，子代理一次性） */
  createSession(req: SessionRequest): Promise<AgentSession>;
  /** 驱动一次 prompt，返回收尾文本（含超时/中断兜底） */
  driveToReply(session: AgentSession, prompt: string, opts?: {
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<AgentReply>;
}
```

两套实现：
- `LlmConfigStoreRuntime`：包装现有 `LlmConfigStore`（getModel/getApiKey）+ `createAgentSession`，供子代理与默认主会话。
- 主会话宿主自身即实现 `AgentRuntime`（复用其 services/工厂闭包，见 §4.3）。

### 4.2 `BaseAgent<TInput,TOutput>` 抽象类（新建 `src/agents/base-agent.ts`）

唯一底层 = `AgentSession`；行为差异由子类实现。

```typescript
export abstract class BaseAgent<TInput, TOutput> {
  protected runtime: AgentRuntime;
  constructor(runtime: AgentRuntime) {}

  /** 子代理用 forSubagent 轻量 prompt；主会话用完整 prompt */
  protected abstract buildPrompt(input: TInput): string;
  /** 工具集按角色（子代理：世界图工具 + 受限内建；主会话：编排器工具） */
  protected abstract buildTools(input: TInput): ToolDefinition[];
  /** 从收尾文本解析结构化产出 */
  protected abstract extractOutput(reply: AgentReply): TOutput;

  /** 统一执行入口 */
  async run(input: TInput, opts?: RunOptions): Promise<TOutput>;
}
```

`run` 内部契约（对所有子类一致）：
1. `const req = this.sessionRequest(input)`（子类可覆写生命周期：inMemory vs 持久）
2. `const session = await this.runtime.createSession(req)`
3. `const reply = await this.runtime.driveToReply(session, this.buildPrompt(input), opts)`
4. `return this.extractOutput(reply)`

### 4.3 继承体系

```
BaseAgent<TInput,TOutput>       （唯一底层 AgentSession）
├── MainSessionAgent   主会话：持久 SessionManager，流式，前端 UI（改造现有 MainSessionHost）
├── PlannerAgent       子代理：inMemory + forSubagent + 指令收尾
├── RoleAgent          子代理：inMemory + forSubagent + 指令收尾
├── ReasoningAgent     子代理：inMemory + forSubagent + 指令收尾
└── RendererAgent      子代理：inMemory + forSubagent + 指令收尾

编排器 = 协调层（不继承，Hanako 频道分发层对等物）
      串起上述 BaseAgent 实例，走事件/管线
```

- **MainSessionAgent**：改造 `MainSessionHost`。保留持久化（continueRecent/open）、流式、`applyModelConfig`、`switchSession`/`newSession`。`BaseAgent.run` 的「一次性驱动」不适用——主会话是多轮持久会话，故它覆写 `run` 为「建立会话 + 返回句柄」，前端经 HTTP 端点驱动 `prompt`。`buildPrompt` 用完整 prompt（非 forSubagent）。
- **Planner/Role/Reasoning/RendererAgent**：由现有工厂 `createXxxAgent` 改造为类。`buildPrompt` 复用现有 `_buildXxxSystemPrompt` + 指令收尾段；`buildTools` 用 `createXxxTools`（世界图工具，`ToolDefinition`）；`extractOutput` 从 `reply.text` 解析结构化结果（见 §5）。

### 4.4 编排器（协调层，不继承）

Hanako 的频道是**对等消息协调**：所有 agent 同一运行时，彼此通过共享频道文件广播/讨论，协调发生在 agent 类之外。narrative-engine 的编排器即该协调层的对等物——它是**纯代码管线**（planner→role→推理→渲染），不是 LLM 代理，**不继承 `BaseAgent`**。

编排器职责调整：
- 构造 `XxxAgent` 实例（传入 `AgentRuntime`）
- 调用 `.run(input)` 获取结构化产出
- 串行/并行编排、超时兜底

### 4.5 运行时来源：LlmConfigStore 收口

`AgentRuntime` 的默认实现包装现有 `LlmConfigStore`：`resolveModel(slot)` / `resolveApiKey(slot)` 直接透传，`createSession` 用解析出的 model + apiKey 调 `createAgentSession`。主会话与子代理共用同一配置源（现状已如此）。

## 5. 产出机制迁移：指令性 prompt 收尾

**现状**：子代理用 terminate 提交工具（`retrieval_plan`/`character_action`/`diffusion_result`/`render_result`），编排器经 `collectSubmission` 订阅 `tool_execution_end` 提取 `details`。

**迁移后**：改为汉化 Hanako 的指令收尾——子代理 system prompt 末尾增加指令段，要求「完成推理后，以一段 JSON/结构化文本收尾交付产出，不得以任何工具调用结束」。`extractOutput` 从 `reply.text` 解析。

- 好处：统一运行时（不再依赖 `AgentTool` terminate 语义与 `collect.ts` 事件收集）；更贴近「底层相同、仅行为不同」理念。
- 代价：需为每个子代理定义收尾文本的**结构化契约**（JSON 或分隔标记），并实现解析器。`collect.ts` / `tools.ts` 的 terminate 提交流程废弃或保留作兼容。

**结构化契约建议**（每个子代理一个）：收尾段用 fenced JSON（如 ```json ... ```），`extractOutput` 用 `JSON.parse` 提取；解析失败时回退到正则/明确报错，防止静默产出 undefined。

## 6. 改动文件总览

| 文件 | 动作 | 说明 |
|---|---|---|
| `src/agents/agent-runtime.ts` | **新建** | `AgentRuntime`/`AgentReply`/`SessionRequest` 接口 + `LlmConfigStoreRuntime` 实现 + `driveToReply` |
| `src/agents/base-agent.ts` | **新建** | `BaseAgent<TInput,TOutput>` 抽象类 |
| `src/agents/planner-agent.ts` | 改 | 工厂 → `PlannerAgent extends BaseAgent` |
| `src/agents/role-agent.ts` | 改 | 工厂 → `RoleAgent extends BaseAgent` |
| `src/agents/reasoning-agent.ts` | 改 | 工厂 → `ReasoningAgent extends BaseAgent` |
| `src/agents/renderer-agent.ts` | 改 | 工厂 → `RendererAgent extends BaseAgent` |
| `src/agents/tools.ts` | 改 | 产出契约调整（terminate 工具 → 指令收尾解析） |
| `src/agents/collect.ts` | 改/删 | 事件收集 → `driveToReply` 收尾提取 |
| `src/chat/main-session.ts` | 改 | `MainSessionHost` → `MainSessionAgent extends BaseAgent` |
| `src/orchestrator.ts` | 改 | 4 处子代理调用改为 `XxxAgent.run()`；复用 `AgentRuntime` |
| `tests/*` | 改/新建 | 各代理单测 + `driveToReply`/`extractOutput` 测例 |

## 7. 风险与待确认

1. **`AgentSession` 一次性会话的 teardown**：子代理用完需 `dispose()`，避免资源泄漏（参考 Hanako `teardownIsolatedSession`）。`driveToReply` 需在 finally 里 dispose。
2. **`createAgentSession` 的默认内建工具**：默认开启 read/bash/edit/write。子代理需显式 `tools`/`excludeTools` 或 `noTools` 控制，避免意外拿到文件/命令工具。
3. **系统提示词装配**：`createAgentSession` 用 `resourceLoader` 装配 system prompt；子代理需以 `resourceLoader.getSystemPrompt` 返回 forSubagent 轻量 prompt（参考 Hanako `execResourceLoader` 覆写）。需查证本工程 `createAgentSession` 是否支持注入自定义 resourceLoader。
4. **主会话 `BaseAgent` 语义**：主会话不适用「一次性 run」，需覆写 `run` 为持久句柄模式。是否把主会话也完全纳入 `BaseAgent`，还是仅共享 `AgentRuntime`，需在实现时确认（倾向：主会话保留 `MainSessionHost` 结构，仅改为实现 `AgentRuntime` 并作为 `BaseAgent` 子类）。

## 8. 执行规范（AGENTS.md 分支策略）

- 分支：`git checkout -b 20260812-unified-agent-abstraction`
- 禁止直接在 master 提交；每个 Task 一个 commit，`git add <显式路径>`。
- 完成后：`git checkout master && git merge --ff-only` 分支 `git push origin master`。
- 前端/测试纪律：改动涉及 `frontend-demo/` 依赖时须跑测试轮（见 `frontend-test-discipline.md`）。