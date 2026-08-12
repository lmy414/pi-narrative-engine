# 2026-08-12 统一代理抽象 — 执行文档

> 状态：评估已完成，缺陷已修正，可直接交付下游执行。
> 分支：`20260812-unified-agent-abstraction`
> 前置依赖：现有 `docs/plans/2026-08-12-unified-agent-abstraction.md`（设计原案）

---

## 0. 评估摘要

### 0.1 文档对初始设计的修改

| 维度 | 初始设计 | 设计文档修改 |
|---|---|---|
| **基类抽象** | `BaseAgent`，子类实现不同行为 | 一致，但新增 `AgentRuntime` 中间层解耦 PI 来源 |
| **底层运行时** | 未明确 | 明确统一为 `AgentSession`（pi-coding-agent），取代子代理当前用的 `Agent`（pi-agent-core） |
| **主会话** | 作为子类之一纳入统一继承树 | 承认语义冲突，提出覆写 `run` 或仅共享 `AgentRuntime` |
| **产出机制** | 未明确（隐含保留 terminate 工具） | 改为 Hanako 式"指令性 prompt 收尾"，废弃 terminate 工具 |
| **prompt 装配** | 未明确 | 区分 `forSubagent` 轻量 prompt 与主会话完整 prompt |
| **编排器** | 协调层 | 明确不继承 `BaseAgent`，是 Hanako 频道协调层的对等物 |

### 0.2 整体评价

设计方向**正确且可行**。SDK 能力已验证（`createAgentSession` 支持 `SessionManager.inMemory()`、`customTools`、`tools`/`excludeTools`、`model`、`resourceLoader`）；Hanako 的单一运行时路径已有生产验证。

但文档存在 **6 项需修正的缺陷**，若不处理会导致实现时返工或运行时 bug。

---

## 1. 缺陷修正（相对于设计原案）

### 缺陷 1：主会话强行纳入 `BaseAgent` 导致类型不兼容 [高]

**问题**：文档继承图画了 `MainSessionAgent extends BaseAgent`，但 `BaseAgent.run` 的契约是「一次性驱动 → 返回 `Promise<TOutput>`」。主会话是持久多轮会话（前端经 HTTP 端点多次 `prompt`），语义完全不兼容。

**修正**：**主会话不继承 `BaseAgent`**。
- `BaseAgent` 仅被子代理（Planner/Role/Reasoning/Renderer）继承。
- 主会话保留现有 `MainSessionHost` 结构，仅追加**实现 `ModelResolver` 接口**（模型/Key 解析）。
- 这样主会话与子代理共享同一配置来源语义，但不必扭曲 `BaseAgent` 的一次性运行语义。

**继承图修正后**：
```
ModelResolver 接口（模型/Key 解析来源）
└── AgentRuntime 接口（+ 一次性会话创建与驱动，仅子代理用）

ModelResolver 实现：
├── LlmConfigStoreRuntime implements AgentRuntime（子代理默认运行时）
└── MainSessionHost implements ModelResolver（主会话，持久多轮，前端 HTTP 驱动）

BaseAgent<TInput,TOutput>（唯一底层 AgentSession，一次性运行）
├── PlannerAgent
├── RoleAgent
├── ReasoningAgent
└── RendererAgent
```

### 缺陷 2：`driveToReply` 实现过于理想化 [中]

**问题**：文档描述为"订阅 `message_update → text_delta` 累积 `replyText`"，但子代理不需要流式消费；`AgentSession.prompt()` resolve 时 generation 已结束，可以直接取最终消息。

**修正**：`driveToReply` 用更简洁的实现——`await session.prompt()` 完成后从 `message_end` 事件提取最终 assistant 文本。

### 缺陷 3：未提及 `AgentSession.prompt` 的扩展命令干扰 [高]

**问题**：`AgentSession.prompt()` 默认会解析 `/` 开头的扩展命令（如 `/skill`）。如果子代理的 prompt 恰好以 `/` 开头，会被误解析为命令而非用户消息。

**修正**：所有子代理调用 `session.prompt()` 时**必须传 `{ expandPromptTemplates: false }`**，关闭扩展命令和模板展开。

### 缺陷 4：子代理 systemPrompt 注入方式模糊 [中]

**问题**：`createAgentSession` 没有直接的 `systemPrompt` 参数，默认使用 `DefaultResourceLoader` 加载 `cwd` 下的 `.pi/SYSTEM.md`、`AGENTS.md` 等。子代理不应加载项目级资源。

**修正**：为子代理实现极简 `ResourceLoader`（仅实现 `getSystemPrompt()`，其余方法返回空结果），传给 `createAgentSession` 的 `resourceLoader` 参数。避免子代理加载无关项目配置。

### 缺陷 5：产出解析缺乏容错设计 [中]

**问题**：从 LLM 的"指令收尾文本"中解析结构化 JSON，LLM 可能不严格按格式输出（缺少 fence、JSON 语法错误、额外 markdown 等）。文档仅提到"回退到正则/明确报错"，无具体策略。

**修正**：
- 每个子代理定义严格的**结构化契约**（fenced JSON 格式）。
- `extractOutput` 解析器执行三级容错：
  1. 提取 ` ```json ... ``` ` 内的文本 → `JSON.parse`
  2. 若无 fence，尝试从整个文本中提取第一个 `{...}` 或 `[...]` → `JSON.parse`
  3. 仍失败则抛出明确的 `AgentOutputParseError`（含原始文本前 500 字），**绝不静默返回 undefined**
- 编排器捕获解析错误后标记该子代理失败（与现有"单角色失败不阻断"语义一致）。

### 缺陷 6：`AgentSession` 默认内建工具未显式控制 [中]

**问题**：`createAgentSession` 默认启用 `read/bash/edit/write` 内建工具。子代理若意外拿到这些工具，可能读写文件/执行命令。

**修正**：子代理创建 session 时**必须显式传 `noTools: "all"`**，然后通过 `customTools` 只注入需要的世界图工具。这样内建工具全部被禁用，仅保留自定义工具。

---

## 2. 精确接口定义（修正后）

### 2.1 `ModelResolver` / `AgentRuntime`（接口拆分，已定方案）

```typescript
// src/agents/agent-runtime.ts
import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession, ToolDefinition, SessionManager } from "@earendil-works/pi-coding-agent";

export type LlmSlot = "planner" | "role" | "reasoning" | "renderer" | "default";

/** 模型/Key 解析来源：主会话（MainSessionHost）与子代理（LlmConfigStoreRuntime）共享 */
export interface ModelResolver {
  /** 按 slot 解析模型 */
  resolveModel(slot: LlmSlot): Model<any>;
  /** 按 slot 解析 API Key */
  resolveApiKey(slot: LlmSlot): string;
}

export interface SessionRequest {
  /** 项目目录（子代理工具的世界图/章节读写锚定此目录） */
  cwd: string;
  /** 应用级配置目录（与 MainSessionHost 同一 agentDir，禁止缺省落到 ~/.pi/agent） */
  agentDir: string;
  /** 会话持久化目录（子代理传 inMemory，不持久化） */
  sessionManager: SessionManager;
  /** 内建工具白名单 */
  tools?: string[];
  /** 内建工具黑名单 */
  excludeTools?: string[];
  /** 禁用全部内建工具（子代理恒传 "all"） */
  noTools?: "all" | "builtin";
  /** 自定义工具（世界图工具等，ToolDefinition[]） */
  customTools?: ToolDefinition[];
  /** 系统提示词装配（子代理用 SubagentResourceLoader） */
  resourceLoader?: ResourceLoader;
  /** 显式模型（由 BaseAgent 经 runtime.resolveModel(slot) 解析后填入） */
  model?: Model<any>;
  /** 运行时 API Key */
  runtimeApiKey?: { provider: string; apiKey: string };
}

export interface AgentReply {
  /** 最终 assistant 消息文本 */
  text: string;
  stopReason?: string;
  errorMessage?: string;
}

/** 一次性会话运行时：仅子代理用（主会话是持久多轮，不适用，见 §2.6） */
export interface AgentRuntime extends ModelResolver {
  /** 创建一次 AgentSession（统一运行时） */
  createSession(req: SessionRequest): Promise<AgentSession>;
  /** 驱动一次 prompt，返回最终文本（含超时/中断兜底） */
  driveToReply(
    session: AgentSession,
    prompt: string,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<AgentReply>;
}
```

### 2.2 极简子代理 ResourceLoader

```typescript
// src/agents/agent-runtime.ts（与 AgentRuntime 同文件或独立文件）
import type { ResourceLoader, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";

/** 子代理专用：只返回 systemPrompt，不加载任何项目资源 */
export class SubagentResourceLoader implements ResourceLoader {
  constructor(private systemPrompt: string) {}

  getSystemPrompt(): string | undefined { return this.systemPrompt; }
  getAppendSystemPrompt(): string[] { return []; }
  getExtensions(): LoadExtensionsResult { return { extensions: [], diagnostics: [] }; }
  getSkills() { return { skills: [], diagnostics: [] }; }
  getPrompts() { return { prompts: [], diagnostics: [] }; }
  getThemes() { return { themes: [], diagnostics: [] }; }
  getAgentsFiles() { return { agentsFiles: [] }; }
  extendResources(): void {}
  async reload(): Promise<void> {}
}
```

### 2.3 `BaseAgent<TInput, TOutput>`（仅子代理继承）

```typescript
// src/agents/base-agent.ts
import type { AgentRuntime, AgentReply, SessionRequest } from "./agent-runtime.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export interface RunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export abstract class BaseAgent<TInput, TOutput> {
  protected runtime: AgentRuntime;
  /** 项目目录（世界图/章节读写锚点） */
  protected cwd: string;
  /** 应用级配置目录（%APPDATA%/narrative-engine） */
  protected agentDir: string;

  constructor(runtime: AgentRuntime, opts: { cwd: string; agentDir: string }) {
    this.runtime = runtime;
    this.cwd = opts.cwd;
    this.agentDir = opts.agentDir;
  }

  /** 子代理的 LLM slot（planner/role/reasoning/renderer），用于解析 model/apiKey */
  protected abstract getSlot(): LlmSlot;
  /** 构造 systemPrompt（子代理用轻量 prompt） */
  protected abstract buildSystemPrompt(input: TInput): string;
  /** 构造用户 prompt */
  protected abstract buildUserPrompt(input: TInput): string;
  /** 工具集 */
  protected abstract buildTools(input: TInput): ToolDefinition[];
  /** 从最终 assistant 文本解析结构化产出 */
  protected abstract extractOutput(reply: AgentReply): TOutput;

  /** 子类可覆写 session 请求（默认 inMemory 一次性） */
  protected buildSessionRequest(input: TInput): SessionRequest {
    const model = this.runtime.resolveModel(this.getSlot());
    return {
      cwd: this.cwd,        // 由构造注入（项目目录）
      agentDir: this.agentDir, // 由构造注入（应用级配置目录）
      sessionManager: SessionManager.inMemory(this.cwd),
      noTools: "all",
      customTools: this.buildTools(input),
      model,
      runtimeApiKey: { provider: model.provider, apiKey: this.runtime.resolveApiKey(this.getSlot()) },
      resourceLoader: new SubagentResourceLoader(this.buildSystemPrompt(input)),
    };
  }

  /** 统一执行入口 */
  async run(input: TInput, opts?: RunOptions): Promise<TOutput> {
    const req = this.buildSessionRequest(input);
    const session = await this.runtime.createSession(req);
    try {
      const reply = await this.runtime.driveToReply(
        session,
        this.buildUserPrompt(input),
        opts,
      );
      return this.extractOutput(reply);
    } finally {
      session.dispose();
    }
  }
}
```

### 2.4 `LlmConfigStoreRuntime`（默认实现）

```typescript
// src/agents/agent-runtime.ts
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { LlmConfigStore } from "../orchestrator/llm-config.ts";

export class LlmConfigStoreRuntime implements AgentRuntime {
  private store: LlmConfigStore;

  constructor(store: LlmConfigStore) {
    this.store = store;
  }

  resolveModel(slot: LlmSlot): Model<any> {
    return this.store.getModel(slot);
  }

  resolveApiKey(slot: LlmSlot): string {
    return this.store.getApiKey(slot);
  }

  async createSession(req: SessionRequest): Promise<AgentSession> {
    // model/apiKey 已在 BaseAgent.buildSessionRequest 中经 resolveModel/resolveApiKey 填入（§4.1 方案 A）
    const result = await createAgentSession({
      cwd: req.cwd,
      agentDir: req.agentDir,
      sessionManager: req.sessionManager,
      model: req.model,
      customTools: req.customTools,
      noTools: req.noTools,
      tools: req.tools,
      excludeTools: req.excludeTools,
      resourceLoader: req.resourceLoader,
    });
    // runtimeApiKey 需在 session 创建后注入 authStorage（与 MainSessionHost.start 同一模式）；
    // createAgentSession 支持传入 authStorage——构造时经 AuthStorage.create(agentDir/auth.json)
    // 后 setRuntimeApiKey，再传入 options.authStorage。具体接线在实现时对齐 MainSessionHost。
    return result.session;
  }

  async driveToReply(
    session: AgentSession,
    prompt: string,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<AgentReply> {
    // 已查证（pi-ai types.ts:285-298）：
    //   AssistantMessage.content = (TextContent | ThinkingContent | ToolCall)[]
    //   AssistantMessage.stopReason / errorMessage 为类型化字段，无需 as any
    let finalText = "";
    let stopReason: string | undefined;
    let errorMessage: string | undefined;

    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        const msg = event.message;
        finalText = msg.content
          .filter((c): c is TextContent => c.type === "text")
          .map((c) => c.text)
          .join("");
        stopReason = msg.stopReason;
        errorMessage = msg.errorMessage;
      }
    });

    try {
      // 关键：关闭扩展命令解析，防止 prompt 以 / 开头被误解析
      await session.prompt(prompt, { expandPromptTemplates: false });
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    } finally {
      unsubscribe();
    }

    // timeout 处理：用 Promise.race 包装 prompt
    // 若超时，调用 session.abort() 后抛错

    return { text: finalText, stopReason, errorMessage };
  }
}
```

> **注意**：`driveToReply` 的超时逻辑需要 `Promise.race`。由于 `AgentSession.prompt` 本身不支持 AbortSignal，超时后需调用 `session.abort()` 中断。

### 2.5 产出解析器契约与容错

```typescript
// src/agents/base-agent.ts
export class AgentOutputParseError extends Error {
  constructor(message: string, public readonly rawText: string) {
    super(message);
    this.name = "AgentOutputParseError";
  }
}

/** 通用 JSON 提取器：三级容错 */
export function extractFencedJson(text: string): unknown {
  // L1: 提取 ```json ... ```
  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch { /* fallthrough */ }
  }
  // L2: 提取第一个顶层 { ... } 或 [ ... ]
  const bare = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (bare) {
    try { return JSON.parse(bare[1]); } catch { /* fallthrough */ }
  }
  // L3: 失败
  throw new AgentOutputParseError(
    `无法从代理输出中提取有效 JSON（尝试 fenced 和 bare 提取均失败）`,
    text.slice(0, 500),
  );
}
```

每个子类的 `extractOutput` 调用 `extractFencedJson(reply.text)` 后再做类型校验。

### 2.6 主会话：`MainSessionHost implements ModelResolver`（已定方案）

**决定采用接口拆分**（接口定义见 §2.1）：主会话只实现 `ModelResolver`，不强行实现无意义的 `createSession`/`driveToReply`。

- `LlmConfigStoreRuntime implements AgentRuntime`（包装 `LlmConfigStore`，子代理用）
- `MainSessionHost implements ModelResolver`（主会话用；`resolveModel`/`resolveApiKey` 从自身 services/opts 解析）
- `BaseAgent` 依赖 `AgentRuntime`；编排器持有 `AgentRuntime` 并注入各子代理

```typescript
// src/chat/main-session.ts（在现有类上追加接口实现，现有方法全部保留）
export class MainSessionHost implements ModelResolver {
  // ... 现有 start/switchSession/newSession/applyModelConfig/dispose 全部保留 ...

  resolveModel(_slot: LlmSlot): Model<any> {
    // 主会话恒用 default 语义：返回当前会话模型（session.model）或构造时注入的 opts.model
    return this.runtime?.session.model ?? this.opts.model;
  }

  resolveApiKey(_slot: LlmSlot): string {
    // 主会话的 Key 已在 start() 时经 setRuntimeApiKey 注入 authStorage；
    // 此方法主要满足接口，供编排器/前端查询当前 provider 的 Key 来源
    return this.opts.runtimeApiKey?.apiKey ?? "";
  }
}
```

### 2.7 指令性 prompt 收尾模板

每个子代理的 `buildSystemPrompt` 末尾追加统一指令段：

````
---
⚠️ 产出纪律：
1. 完成所有推理后，你必须以一段 fenced JSON 提交最终结论。
2. 格式严格如下（仅输出一次，不得调用任何工具）：

```json
{ ... }
```

3. 不要在 JSON 前后添加解释性文字。
4. 如果无法完成，JSON 内 `ok: false` 并附 `error` 字段说明原因。
````

各子代理的 JSON 结构复用现有 schema（`retrievalPlanSchema` / `characterActionSchema` / `diffusionResultSchema` / `renderResultSchema`），但不再包装为 `AgentTool`，而是作为 prompt 中的格式说明。

---

## 3. 实现步骤

### Phase 1：基础设施（独立可测试）

**任务 1.1**：新建 `src/agents/agent-runtime.ts`
- `ModelResolver` 接口
- `AgentRuntime` 接口（继承 `ModelResolver`）
- `AgentReply` / `SessionRequest`
- `SubagentResourceLoader`
- `LlmConfigStoreRuntime`（实现 `AgentRuntime`）
- `AgentOutputParseError` + `extractFencedJson`
- `driveToReply` 辅助函数（或作为 `LlmConfigStoreRuntime` 的方法）

**任务 1.2**：新建 `src/agents/base-agent.ts`
- `BaseAgent<TInput, TOutput>` 抽象类
- `RunOptions`
- `buildSessionRequest` 默认实现（inMemory + noTools: "all"）

**任务 1.3**：写单元测试
- `tests/agent-runtime.test.ts`：测试 `SubagentResourceLoader`、`extractFencedJson`、三级容错
- `tests/base-agent.test.ts`：用 mock `AgentRuntime` 测试 `BaseAgent.run` 的调用顺序

### Phase 2：子代理改造（4 个类）

**任务 2.1**：`PlannerAgent extends BaseAgent<PlannerInput, PlannerOutput>`
- `buildSystemPrompt`：复用 `_buildPlannerSystemPrompt` + 指令收尾段
- `buildUserPrompt`：复用 `_buildPlannerUserMessage`
- `buildTools`：复用 `createPlannerTools`（返回 `ToolDefinition[]`）
- `extractOutput`：从 `reply.text` 解析 `RetrievalPlan`

**任务 2.2**：`RoleAgent extends BaseAgent<RoleInput, RoleAgentOutput>`
- `buildSystemPrompt`：复用 `buildRoleSystemPrompt` + 指令收尾段
- `buildUserPrompt`：复用 `buildRoleUserMessage`
- `buildTools`：复用 `createRoleLimitedTools`
- `extractOutput`：解析 `CharacterAction`

**任务 2.3**：`ReasoningAgent extends BaseAgent<ReasoningInput, DiffusionOutput>`
- 类似改造

**任务 2.4**：`RendererAgent extends BaseAgent<RendererInput, RenderOutput>`
- 类似改造

**注意**：4 个子代理的 `buildTools` 需要从 `AgentTool`（pi-agent-core）转换为 `ToolDefinition`（pi-coding-agent）。已查证（pi-coding-agent extensions/types.ts:426 vs pi-agent-core types.ts:361）：
- 两者 `parameters` **同为 TypeBox schema**，schema 可直接复用，无需转换
- 差异仅在 `execute` 签名：`AgentTool.execute(toolCallId, params, signal?, onUpdate?)` → `ToolDefinition.execute(toolCallId, params, signal, onUpdate, ctx)`（多第 5 参 `ctx: ExtensionContext`）
- 适配为机械包装：现有 execute 闭包不消费 ctx，包一层忽略即可；`ToolDefinition` 必填 `label`（现有 AgentTool 已有）

**任务 2.5**：废弃 `src/agents/collect.ts`
- `collectSubmission` 函数不再使用
- 保留文件但标记 `@deprecated`，或删除（如果确认无其他引用）

**任务 2.6**：废弃 `src/agents/tools.ts` 中的 terminate 工具
- `createRetrievalPlanTool` / `createCharacterActionTool` / `createDiffusionResultTool` / `createRenderResultTool` 标记 `@deprecated`
- schema 定义（`retrievalPlanSchema` 等）保留，供子代理 `extractOutput` 做类型校验用

### Phase 3：编排器改造

**任务 3.1**：改造 `src/orchestrator.ts`
- 删除 `import { createPlannerAgent }` 等工厂函数
- 删除 `promptAndCollectWithTimeout`（功能并入 `AgentRuntime.driveToReply`）
- `run()` 中：
  ```typescript
  const plannerAgent = new PlannerAgent(this.opts.agentRuntime, {
    cwd: this.opts.cwd,
    agentDir: this.opts.agentDir,
  });
  const plannerResult = await plannerAgent.run({ event, ruleSet: this.opts.plannerRuleSet });
  ```
- 角色串行循环同理：`new RoleAgent(...).run(...)`
- `runPostRolePipeline` 中同理改造 reasoning 和 renderer
- span 埋点的 `provider`/`model` 元数据改经 `this.opts.agentRuntime.resolveModel(slot)` 获取

**任务 3.2**：`OrchestratorOptions` 调整（已定）
- **删除** `llmStore: LlmConfigStore`，**改为** `agentRuntime: AgentRuntime`
- **新增** `agentDir: string`（子代理 session 创建需要，见 §2.1 `SessionRequest.agentDir`）
- 装配点（chat-context.ts）负责构造 `LlmConfigStoreRuntime`，orchestrator 不反向感知配置存储

**任务 3.3**：更新编排器测试
- `tests/orchestrator-timeout.test.ts`：超时逻辑从 `promptAndCollectWithTimeout` 迁移到 `driveToReply`
- `tests/e2e.test.ts` / `tests/e2e-renderer.test.ts`：端到端链路验证

### Phase 4：主会话改造

**任务 4.1**：`MainSessionHost implements ModelResolver`
- 新增 `resolveModel` / `resolveApiKey` 方法（实现见 §2.6）
- 现有 `start()` / `switchSession()` / `newSession()` / `applyModelConfig()` 保留不变
- 不实现 `createSession` / `driveToReply`（属于 `AgentRuntime`，主会话不涉及）

**任务 4.2**：装配层（`src/app/chat-context.ts:379`，已查证为 `new Orchestrator(...)` 唯一构造点）
- 构造 `LlmConfigStoreRuntime`（包装 `this.opts.llmStore`）传入 `OrchestratorOptions.agentRuntime`
- 主会话 `MainSessionHost` 作为 `ModelResolver` 供前端查询模型信息（现有 HTTP 端点不变）

### Phase 5：测试与验证

**任务 5.1**：运行所有相关测试（测试运行器为 `tsx --test`，单文件直跑；`npm test` 跑全量）

```bash
cd d:/claude/pi-ex/narrative-engine
npx tsx --test tests/agent-runtime.test.ts
npx tsx --test tests/base-agent.test.ts
npx tsx --test tests/orchestrator-timeout.test.ts
npx tsx --test tests/e2e.test.ts
npx tsx --test tests/chat-routes.test.ts
# 全量回归
npm test
```

**任务 5.2**：前端测试纪律（若改动涉及 `frontend-demo/` 或其依赖 `api-mock.js` / `api-client.js`）
- 启动服务：`node scripts/app-server.mjs --port 7421`
- 按 `frontend-test-discipline.md` 跑测试轮
- 产出测试文档：`docs/audits/frontend-test-runs/2026-08-12-unified-agent.md`

---

## 4. 关键实现细节

### 4.1 `BaseAgent.buildSessionRequest` 中的 model/apiKey 传递（已定）

**已定方案 A**：`BaseAgent` 增加抽象 `getSlot(): LlmSlot`，`buildSessionRequest` 内部调 `runtime.resolveModel(slot)` / `runtime.resolveApiKey(slot)` 填入 `model` / `runtimeApiKey`。实现已并入 §2.3 的 `BaseAgent` 定义，此处不再重复。

理由：`BaseAgent` 子类知道自己是哪个 slot（planner/role/reasoning/renderer），信息最完整；`AgentRuntime.createSession` 保持纯透传，不反向感知 slot。

### 4.2 `ToolDefinition` 与 `AgentTool` 的差异（已查证，风险低）

现有子代理工具（`world-tools.ts`、`chapter-tools.ts`、`rules-tools.ts`）返回的是 `AgentTool`（pi-agent-core）。迁移到 `AgentSession` 后需要 `ToolDefinition`（pi-coding-agent）。

已查证两侧类型定义（pi-coding-agent `extensions/types.ts:426-473` / pi-agent-core `types.ts:361-379`）：

| 字段 | `AgentTool` | `ToolDefinition` | 适配 |
|---|---|---|---|
| `name` / `label` / `description` | 有 | 有 | 直接透传 |
| `parameters` | TypeBox `TSchema` | TypeBox `TSchema` | **直接复用，无需转换** |
| `executionMode` | 有 | 有 | 直接透传 |
| `execute` 签名 | 4 参（`signal?`/`onUpdate?` 可选） | 5 参（多 `ctx: ExtensionContext`，前 4 参必选） | 包装一层忽略 `ctx` |
| `terminate` 语义 | `AgentToolResult.terminate` | 同样支持（`AgentToolResult` 同一类型） | 迁移后 terminate 工具整体废弃，无影响 |

统一适配器（放 `src/agents/agent-runtime.ts` 或独立 `tool-adapter.ts`）：

```typescript
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/** AgentTool → ToolDefinition 机械适配（schema 复用，execute 忽略 ctx） */
export function toToolDefinition(tool: AgentTool): ToolDefinition {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    executionMode: tool.executionMode,
    execute: (toolCallId, params, signal, onUpdate, _ctx) =>
      tool.execute(toolCallId, params, signal, onUpdate),
  };
}
```

### 4.3 `driveToReply` 的超时与 abort

```typescript
async driveToReply(session, prompt, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const abortController = new AbortController();

  let finalText = "";
  let stopReason: string | undefined;

  const unsub = session.subscribe((event) => {
    if (event.type === "message_end") {
      finalText = String((event as any).message?.content ?? "");
      stopReason = (event as any).message?.stopReason;
    }
  });

  const promptPromise = session.prompt(prompt, { expandPromptTemplates: false });

  const timeoutPromise = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      abortController.abort();
      session.abort().catch(() => {});
      reject(new Error(`Agent prompt 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    // 不做 unref（与现有 collect.ts 一致，避免 test 提前终止）
  });

  try {
    await Promise.race([promptPromise, timeoutPromise]);
  } finally {
    unsub();
  }

  return { text: finalText, stopReason };
}
```

### 4.4 主会话接口边界（已定）

接口拆分已在 §2.6 定为正式方案：`MainSessionHost implements ModelResolver`，不实现 `AgentRuntime` 的 `createSession`/`driveToReply`。本节不再作为开放问题，仅记录理由：主会话是持久多轮会话，由前端经 HTTP 端点逐轮驱动，「创建一次性 session + 驱动到收尾」对其无语义；强行实现只能抛错，属于接口污染。

### 4.5 `AgentSessionEvent` 类型（已查证）

已查证（pi-agent-core `types.ts:403-418` + pi-coding-agent `agent-session.ts:123-147`）：

- `message_end` 事件形状：`{ type: "message_end"; message: AgentMessage }`
- `AgentMessage = Message = UserMessage | AssistantMessage | ToolResultMessage`（pi-ai `types.ts:310`）
- 用 `event.message.role === "assistant"` 类型守卫即可收窄到 `AssistantMessage`，其 `content` 为 `(TextContent | ThinkingContent | ToolCall)[]`，文本提取 = 过滤 `type === "text"` 后 join
- `AssistantMessage.stopReason: StopReason`、`errorMessage?: string` 均为类型化字段
- 注意 `AgentSessionEvent` 的 `agent_end` 分支带 `willRetry: boolean`（自动重试语义），`driveToReply` 等待 `prompt()` resolve 即可，无需手动处理 `agent_end`

§2.4 示例代码中的提取逻辑已按上述查证修正，无 `as any` 强转。

---

## 5. 改动文件总览（修正后）

| 文件 | 动作 | 说明 |
|---|---|---|
| `src/agents/agent-runtime.ts` | **新建** | `ModelResolver` + `AgentRuntime` + `AgentReply` + `SessionRequest` + `SubagentResourceLoader` + `LlmConfigStoreRuntime` + `AgentOutputParseError` + `extractFencedJson` |
| `src/agents/base-agent.ts` | **新建** | `BaseAgent<TInput,TOutput>` 抽象类 |
| `src/agents/planner-agent.ts` | 改 | 工厂 → `PlannerAgent extends BaseAgent` |
| `src/agents/role-agent.ts` | 改 | 工厂 → `RoleAgent extends BaseAgent` |
| `src/agents/reasoning-agent.ts` | 改 | 工厂 → `ReasoningAgent extends BaseAgent` |
| `src/agents/renderer-agent.ts` | 改 | 工厂 → `RendererAgent extends BaseAgent` |
| `src/agents/tools.ts` | 改 | terminate 工具标记 `@deprecated`；schema 保留供 extractOutput 用 |
| `src/agents/collect.ts` | 改/删 | `collectSubmission` 废弃（确认无引用后删除） |
| `src/agents/world-tools.ts` | 改 | 经 `toToolDefinition` 适配器包装（§4.2，schema 复用） |
| `src/agents/chapter-tools.ts` | 改 | 同上 |
| `src/agents/rules-tools.ts` | 改 | 同上 |
| `src/chat/main-session.ts` | 改 | `MainSessionHost implements ModelResolver`（现有方法全部保留，仅追加接口） |
| `src/orchestrator.ts` | 改 | 4 处子代理调用改为 `XxxAgent.run()`；删除 `promptAndCollectWithTimeout`；`OrchestratorOptions.llmStore` → `agentRuntime` + `agentDir` |
| `src/app/chat-context.ts` | 改 | 构造 `LlmConfigStoreRuntime` 注入 Orchestrator（唯一装配点 :379） |
| `src/orchestrator/llm-config.ts` | 不改 | `LlmConfigStore` 由 `LlmConfigStoreRuntime` 包装，本身无改动 |
| `tests/agent-runtime.test.ts` | **新建** | `SubagentResourceLoader`、`extractFencedJson`、`driveToReply` 超时 |
| `tests/base-agent.test.ts` | **新建** | `BaseAgent.run` 调用顺序、dispose 兜底 |
| `tests/collect.test.ts` | 改/删 | 废弃 `collectSubmission` 的测试 |
| `tests/tools.test.ts` | 改 | 废弃 terminate 工具的测试 |
| `tests/orchestrator-timeout.test.ts` | 改 | 超时逻辑迁移到 `driveToReply` |
| `tests/e2e.test.ts` | 改 | 端到端链路验证新产出机制 |
| `tests/e2e-renderer.test.ts` | 改 | 渲染器端到端验证 |

---

## 6. 风险与兜底

| 风险 | 概率 | 影响 | 兜底 |
|---|---|---|---|
| ~~`ToolDefinition` 与 `AgentTool` schema 不兼容~~ | 已排除 | — | 已查证：两者 `parameters` 同为 TypeBox，execute 仅差 `ctx` 参数，机械适配即可（§4.2） |
| LLM 不遵守指令收尾格式，JSON 解析频繁失败 | 中 | 高 | 三级容错 + 明确抛错；单代理失败不阻断流程（与现有语义一致） |
| `AgentSession.prompt({ expandPromptTemplates: false })` 仍有未预期行为 | 低 | 高 | Phase 1 写独立测试验证子代理 prompt 行为（扩展命令不触发、模板不展开） |
| 主会话实现 `AgentRuntime` 接口过于牵强 | 低 | 中 | 采用 §2.6 的 `ModelResolver` + `AgentRuntime` 拆分方案（**已定为默认方案**） |
| `AgentSession.dispose()` 后资源未完全释放 | 低 | 中 | `BaseAgent.run` 的 `finally` 中调用 dispose；加测试验证 |
| `AgentSession` 自动重试/自动压缩在一次性子代理中意外触发 | 低 | 中 | 子代理 inMemory + 单次 prompt，上下文极短，压缩阈值不会触发；若触发则在 Phase 1 测试中暴露 |
| 子代理 `createAgentSession` 时 `agentDir` 缺省落到 `~/.pi/agent`，加载到全局 auth/extensions | 中 | 中 | `SubagentResourceLoader` 已隔离资源加载；`createSession` 显式传应用级 `agentDir`（与 MainSessionHost 同一目录） |

---

## 7. 回滚计划

若执行到 Phase 3（编排器改造）发现重大阻塞：
1. 保留 Phase 1（`AgentRuntime` + `BaseAgent`）的基础设施代码
2. 回滚 Phase 2/3 的代理类改造，恢复工厂函数
3. 编排器继续使用旧工厂 + `collectSubmission`
4. 基础设施代码留在仓库中，待阻塞解决后继续

---

## 8. 执行 checklist（供下游逐项打勾）

- [ ] Phase 1.1：`src/agents/agent-runtime.ts` 新建并编译通过
- [ ] Phase 1.2：`src/agents/base-agent.ts` 新建并编译通过
- [ ] Phase 1.3：`tests/agent-runtime.test.ts` + `tests/base-agent.test.ts` 通过
- [ ] Phase 2.1：`PlannerAgent` 改造完成 + 单测通过
- [ ] Phase 2.2：`RoleAgent` 改造完成 + 单测通过
- [ ] Phase 2.3：`ReasoningAgent` 改造完成 + 单测通过
- [ ] Phase 2.4：`RendererAgent` 改造完成 + 单测通过
- [ ] Phase 2.5：`collect.ts` 废弃/删除，确认无引用
- [ ] Phase 2.6：`tools.ts` terminate 工具标记废弃
- [ ] Phase 3.1：`orchestrator.ts` 改造完成
- [ ] Phase 3.2：`OrchestratorOptions` 调整
- [ ] Phase 3.3：编排器相关测试通过
- [ ] Phase 4.1：`MainSessionHost implements ModelResolver`
- [ ] Phase 4.2：服务层构造 `LlmConfigStoreRuntime`
- [ ] Phase 5.1：全部测试通过（`npm test`）
- [ ] Phase 5.2：前端测试轮完成（如适用）
