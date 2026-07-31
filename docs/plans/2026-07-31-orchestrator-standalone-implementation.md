# 编排器独立化实现方案（修正版执行计划）

> 日期：2026-07-31
> 状态：可执行（依据调研报告修正稿）
> 关联：
> - `docs/plans/2026-07-31-orchestrator-standalone-research.md`（可行性调研，已修正 3 处硬伤）
> - `docs/plans/2026-07-31-subagent-orchestrator-design.md`（子代理编排器设计）
> - `docs/plans/2026-07-31-sdk-integration-architecture.md`（SDK 集成架构决策）
>
> 本计划落实调研报告的阶段 0 / 阶段 1，阶段 2（数据层适配器）留待后续。

## 一、执行顺序总览

```
前置：依赖落地（pi-agent-core）
  → 阶段 0：最小验证（纯 Node 跑通 LLM 调用，不改业务代码）
  → 阶段 1a：解耦层（agent-runtime / tools / caller 签名改造）
  → 阶段 1b：子代理框架（4 个 agent 工厂 + event-queue + orchestrator）
  → 阶段 1c：服务层 + MCP 包装
  → 验证：独立进程端到端跑通
```

每步可独立编译验证，禁止批量乱改。

## 二、前置：依赖落地

**目标**：`@earendil-works/pi-agent-core` 可从 narrative-engine 直接 import。

**现状（已查证）**：无法直接 import（`require.resolve` 失败）；仅作为 pi-coding-agent 嵌套传递依赖存在且无 dist。

**执行**：

```bash
cd d:\claude\pi-ex\narrative-engine
npm install @earendil-works/pi-agent-core@^0.77.0 --save-dev --ignore-scripts
```

**验证**：

```bash
node -e "console.log(require.resolve('@earendil-works/pi-agent-core'))"
```

## 三、阶段 0：最小验证（不实现子代理）

**目标**：验证两个最关键前提，不启动 PI、纯 Node 进程跑通一次真实 LLM 调用：
1. `@earendil-works/pi-ai` 的 `complete` / `streamSimple` / `getModel` 在无 PI 环境下可用（无隐式全局状态）
2. `LlmConfig` 抽象正确性（env 配置源 → getModel → complete）

**文件**：

- `scripts/orchestrator-smoke.ts`（临时验证脚本，跑通后保留为 `src/orchestrator/llm-config.ts` 的实测依据）

**关键代码**（依据 pi-ai 源码签名）：

```typescript
// scripts/orchestrator-smoke.ts（阶段 0 草稿，验证用）
import { complete, getModel } from "@earendil-works/pi-ai";

const provider = process.env.NE_LLM_PROVIDER as "deepseek"; // KnownProvider 字面量
const modelName = process.env.NE_LLM_MODEL!;
const apiKey = process.env.NE_LLM_API_KEY!;

const model = getModel(provider, modelName as keyof (typeof MODELS)[typeof provider]);
const msg = await complete(model, {
  systemPrompt: "你是验证脚本",
  messages: [{ role: "user", content: "回复：ok", timestamp: Date.now() }],
}, { apiKey, maxTokens: 100 });
console.log(msg.content);
```

**验收**：`NE_LLM_PROVIDER=deepseek NE_LLM_MODEL=<模型> NE_LLM_API_KEY=<key> node scripts/orchestrator-smoke.ts` 输出 LLM 回复。

## 四、阶段 1a：解耦层

### 4.1 `src/orchestrator/llm-config.ts` — LlmConfig + AgentRuntime + 配置源

```typescript
// src/orchestrator/llm-config.ts
import { getModel, streamSimple } from "@earendil-works/pi-ai";
import type { Model, KnownProvider, StreamFn } from "@earendil-works/pi-ai";

/** 解耦接口（子代理设计 §3.1）：零 PI 依赖 */
export interface AgentRuntime {
  model: Model<any>;
  streamFn: StreamFn;
  getApiKey: (provider: string) => Promise<string | undefined>;
}

/** SDK 模式配置源（调研报告 §5.1，已修正 provider 类型） */
export interface LlmConfig {
  model: { provider: KnownProvider; name: string };
  apiKey: string;
  headers?: Record<string, string>;
}

export function createRuntimeFromConfig(config: LlmConfig): AgentRuntime {
  return {
    model: getModel(config.model.provider, config.model.name as keyof (typeof MODELS)[typeof config.model.provider]),
    streamFn: streamSimple,
    getApiKey: async () => config.apiKey,
  };
}

/** env 配置源：NE_LLM_PROVIDER / NE_LLM_MODEL / NE_LLM_API_KEY */
export function loadLlmConfigFromEnv(): LlmConfig { ... }
```

### 4.2 4 路 caller 工厂签名改造

**现状**：`makeXxxLlmCaller(ctx: ExtensionContext)` 只用 `ctx.model` + `ctx.modelRegistry`。

**目标**：`makeXxxLlmCaller(config: LlmConfig)`，体内 `ctx.model` → `config.model`（需 `getModel`），`ctx.modelRegistry.getApiKeyAndHeaders` → `config.apiKey/headers`。

**涉及文件**（4 个，纯机械替换）：

- `src/planner-llm.ts`
- `src/role-pool-llm.ts`
- `src/renderer-llm.ts`
- `src/knowledge-mapper-llm.ts`

**关键点**：caller 工厂从 `async` 改为同步（不再 await auth）；auth 改为直接取 `config.apiKey`。但为**兼容现有 PI 扩展路径**（`scheduler-llm.ts` 仍以 `ctx` 调用），需要同时提供 PI 适配器构造 LlmConfig：

```typescript
// src/orchestrator/pi-adapter.ts（唯一 PI 耦合文件）
export async function createLlmConfigFromCtx(ctx: ExtensionContext): Promise<LlmConfig> {
  const model = ctx.model;
  if (!model) throw new Error("ctx.model 为空");
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) throw new Error(`获取 API Key 失败: ${auth.error}`);
  return {
    model: { provider: model.provider as KnownProvider, name: model.name },
    apiKey: auth.apiKey,
    headers: auth.headers,
  };
}
```

`scheduler-llm.ts` 的 `makeSchedulerCtx` 改为：`createLlmConfigFromCtx(ctx)` → 4 个 caller 用 config 构造。**此阶段不改业务逻辑，只改 caller 构造方式**。

## 五、阶段 1b：子代理框架

### 5.1 `src/agents/tools.ts` — 4 个产出提交 AgentTool

依据调研报告 §5.3.2 + 已查证的 terminate all 语义（agent-loop.ts:544-546）：

```typescript
// src/agents/tools.ts
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { retrievalPlanSchema } from "../planner-llm.ts";
import { characterActionSchema } from "../role-pool-llm.ts";

export function createRetrievalPlanTool(): AgentTool {
  return {
    name: "retrieval_plan",
    label: "Retrieval Plan",
    description: "提交本次事件的检索计划。必须调用此工具一次提交结果。",
    parameters: retrievalPlanSchema,
    executionMode: "sequential",  // 强制串行，避免同轮多工具（terminate all 语义）
    async execute(toolCallId, params) {
      return {
        content: [{ type: "text", text: "检索计划已提交" }],
        details: { plan: params },
        terminate: true,           // 关键：终止 agent loop
      };
    },
  };
}
// character_action / diffusion_result / render_result 同构
```

**systemPrompt 约束**（各 agent 工厂统一注入）：
> "你的最终结论必须且只能通过 [工具名] 工具一次提交。不要在同一轮调用其他工具。"

### 5.2 4 个 agent 工厂

统一构造（依据 agent.ts:96-116 AgentOptions 已查证）：

```typescript
// src/agents/planner-agent.ts
import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentRuntime } from "../orchestrator/llm-config.ts";
import { createRetrievalPlanTool } from "./tools.ts";

export function createPlannerAgent(rt: AgentRuntime, systemPrompt: string, messages: AgentMessage[]) {
  return new Agent({
    initialState: { systemPrompt, model: rt.model, tools: [createRetrievalPlanTool()], messages },
    streamFn: rt.streamFn,
    getApiKey: rt.getApiKey,
  });
}
```

**收集产出**：`agent.subscribe(event => ...)` 监听 `tool_execution_end`（types.ts:417），从 `event.result.details` 提取结构化产出。

**产出提取助手**：

```typescript
// src/agents/collect.ts
export function collectSubmission<T>(agent: Agent, toolName: string): { promise: Promise<T>; dispose: () => void } {
  let resolve: (v: T) => void;
  let reject: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  let done = false;
  const off = agent.subscribe((event) => {
    if (event.type === "tool_execution_end" && event.toolName === toolName && !event.isError) {
      done = true;
      resolve(event.result.details as T);
    }
    if (event.type === "agent_end" && !done) {
      reject(new Error(`${toolName} 未提交产出`));
    }
  });
  return { promise, dispose: off };
}
```

### 5.3 `src/event-queue.ts` — 内存队列 + worker

依据子代理设计 §四（代码略，实现要点）：
- `enqueue(event)` 返回 queueId，立即返回
- 单消费者 worker：`processing` 标志防重入
- `getStatus` / `getAll` 供 queue_status 查询

### 5.4 `src/orchestrator.ts` — Orchestrator

核心链路（本阶段不含世界图工具，上下文经 systemPrompt/messages 注入）：

```
run(event):
  traceId = newTraceId()
  plannerAgent → 收集 retrievalPlan（或 mock 计划）
  串行/并行调度角色代理（默认串行：上一角色输出注入下一角色 messages）
  可见推理代理 → 收集 diffusionResult
  渲染器代理 → 收集 renderResult
  汇总 → DispatchOutput
```

**本阶段简化**（用户澄清：不接触世界图业务）：
- planner 的检索计划产出用现有 `retrievalPlanSchema` 校验格式，但**不执行检索**（阶段 2 接数据层后执行）
- 角色代理的输入上下文（角色卡 / 可见知识）由编排器在构造时注入 messages，角色不查 world-graph
- 可见推理只产出 diffusionResult（change 事件 + visibilityChanges），**不写世界图**
- 渲染器产出 renderResult（正文文本），**不写章节文件**

## 六、阶段 1c：服务层 + MCP

### 6.1 `src/orchestrator/service.ts` — OrchestratorService

```typescript
export interface OrchestratorService {
  dispatch(event: StructuredEvent): Promise<DispatchResult>;
  commit(planId: string): Promise<CommitResult>;
  discard(planId: string): Promise<{ ok: boolean }>;
  queueStatus(): QueueStatus;
}
```

- plan 模式：跑 planner + 角色后缓存 PlanResult，等 commit
- yolo 模式：全链路自动跑完
- plans 缓存 + storyTime 锚点迁入服务层

### 6.2 `src/orchestrator/mcp-server.ts` — MCP stdio 包装

- `@modelcontextprotocol/sdk`：`McpServer` + `StdioServerTransport`
- 4 个工具：scheduler_dispatch / scheduler_commit / scheduler_discard / scheduler_queue_status
- 参数 schema 用 zod（MCP SDK 原生），从 TypeBox schema 转换（可选：手工写 zod 等价定义）

### 6.3 独立启动入口

`scripts/orchestrator-mcp.mjs`（esbuild 产物转译后运行）：
- 加载 env LlmConfig
- 构造 OrchestratorService
- 启动 MCP stdio server

## 七、验证与验收

### 7.1 编译验证

```bash
cd d:\claude\pi-ex\narrative-engine
npm run build   # esbuild 逐文件转译，检查无语法/依赖错误
```

### 7.2 阶段 0 验收

- [ ] `node scripts/orchestrator-smoke.ts` 输出真实 LLM 回复（无 PI 环境）

### 7.3 阶段 1 验收

- [ ] 不启动 PI，`node scripts/orchestrator-mcp.mjs` 启动 MCP stdio server
- [ ] MCP 调用 `scheduler_dispatch`（plan 模式）→ 返回 planId + 角色产出
- [ ] MCP 调用 `scheduler_commit` → 返回 appliedEventIds + renderResult
- [ ] 子代理正确终止（不无限循环，产出经 tool_execution_end 收集）

### 7.4 回归

- [ ] 现有 `npm run test:packages` 通过（caller 签名改造不破坏既有测试——测试注入的是 mock caller，签名变化需同步更新 `packages/scheduler/tests/*` 中直接调 caller 工厂的用例）

## 八、风险清单（修正后）

| # | 风险 | 应对 |
|---|---|---|
| 1 | terminate all 语义导致子代理不终止 | 产出工具 `executionMode: "sequential"` + systemPrompt 约束 + 阶段 1 实测 |
| 2 | `getModel` 第二参数类型窄化失败 | `as keyof (typeof MODELS)[typeof provider]` 窄化，阶段 0 验证 |
| 3 | MCP SDK schema 不支持 TypeBox | 手工 zod 等价定义（MCP SDK 原生 zod） |
| 4 | 现有测试因 caller 签名变化失败 | 逐用例更新（mock caller 不受影响，仅工厂签名） |
| 5 | esbuild 转译 `.ts` specifier | 遵循现有 build.mjs 约定（相对路径 .ts → .js） |
