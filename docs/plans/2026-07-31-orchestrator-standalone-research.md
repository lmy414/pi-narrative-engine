# 编排器独立化 + MCP 包装可行性调研

> 日期：2026-07-31
> 状态：可行性调研（结论：✅ 可行）
> 定位：为第二阶段"编排器独立化（含子代理实现）"提供决策依据，不替代实施计划
> 关联：
> - `docs/plans/2026-07-31-sdk-integration-architecture.md`（SDK 集成架构决策）
> - `docs/plans/2026-07-31-underworld-graph-extraction.md`（第一阶段：world-graph 独立化，已完成）
> - `docs/plans/2026-07-31-subagent-orchestrator-design.md`（子代理编排器设计）
> - `docs/plans/2026-07-31-sdk-tool-implementation.md`（SDK 模式工具实现方案）

## 一、调研目标

用户提出的第二阶段方向：

1. 完成第二个核心模块：**编排器**（当前为 `@pi/scheduler` 子包 + 4 路 LLM caller）
2. 做一个**简单的 MCP 包装**，验证编排器能否被外部标准协议调用
3. 确认**不启动 PI**、依靠 SDK 模式，能否单独完成**编排 + 渲染**
4. 编排器**完全独立**，但**不作为单独包发布**，通过**标准 API 契约**与其他模块后续接入

**关键边界（用户澄清，2026-07-31）**：
- **编排器内部工具是私有的**——子代理用的 AgentTool（检索/写入/上下文）全部不暴露给主会话 LLM。主会话只能看到编排器对外的调度入口（dispatch / commit / discard / queue_status）
- **本阶段不考虑世界图检索/写入**——world_* 类 AgentTool 不是本阶段范围，以接口/占位形式定义，后续接数据层时注入
- **先做独立设计（不接触其他业务逻辑）**——本阶段聚焦编排器本体：EventQueue + Orchestrator + 子代理框架 + 内部工具契约，不与世界图/渲染器等业务逻辑耦合

## 二、现状查证（基于源码，非脑补）

### 2.1 编排器架构现状

编排器分三层：

```
┌─────────────────────────────────────────────────────┐
│ PI 扩展层（唯一 PI 耦合点）                            │
│  src/tools/scheduler-tools.ts                        │
│  · pi.registerTool 注册 3 工具                        │
│  · scheduler_dispatch / commit / discard             │
│  · 调 makeSchedulerCtx(piCtx) 取 LLM caller          │
├─────────────────────────────────────────────────────┤
│ 装配层                                               │
│  src/scheduler-llm.ts                                │
│  · makeSchedulerCtx(wg, embedder, cwd, ctx, debugBus)│
│  · 4 路 caller 工厂（唯一依赖 ExtensionContext）      │
│  · 规则集加载 / staticCardLoader                     │
├─────────────────────────────────────────────────────┤
│ 核心编排逻辑（零 PI 依赖）                             │
│  packages/scheduler/src/                             │
│  · plan.ts / commit.ts / retrieve.ts / cache.ts      │
│  · 纯函数，依赖全部经 SchedulerCtx 注入               │
│  · 类型：StructuredEvent / SchedulerCtx 等           │
├─────────────────────────────────────────────────────┤
│ 数据/能力层                                          │
│  underworld-graph（已独立） / Embedder / 规则集       │
│  @pi/role-pool（角色池） / @pi/renderer（渲染器）      │
└─────────────────────────────────────────────────────┘
```

**重要修正（用户补充）**：编排器独立化不是简单把现有 `plan()/commit()` 包装成服务——而是同时要把 4 路 LLM caller 从"无状态单次 `complete()`"升级为**真正的子代理**（`Agent` 类实例，有 agent loop、能自主调用工具、能多轮推理）。这是 [子代理编排器设计](2026-07-31-subagent-orchestrator-design.md) 的核心目标（§1.1 视线模式问题）。

**内部工具边界（用户澄清的架构原则）**：

```
┌─────────────────────────────────────────────────────────┐
│ 主会话 LLM（PI SDK / MCP 主会话）                          │
│   只能看到：dispatch / commit / discard / queue_status    │
│   看不到：任何子代理内部工具                               │
└──────────────────────────┬──────────────────────────────┘
                           │ 调度入口
                           ▼
┌─────────────────────────────────────────────────────────┐
│ 编排器（内部世界，对外不可见）                              │
│                                                          │
│  Orchestrator + EventQueue + 子代理调度                   │
│       │                                                  │
│       ├─ planner 子代理   → 工具：retrieval_plan 提交     │
│       ├─ 角色代理 × N     → 工具：character_action 提交   │
│       ├─ 可见推理子代理   → 工具：diffusion_result 提交    │
│       └─ 渲染器子代理     → 工具：render_result 提交       │
│                                                          │
│  内部工具全部是 AgentTool（4 参数 execute，闭包注入）       │
│  本阶段不含世界图检索/写入（后续数据层注入）                │
└─────────────────────────────────────────────────────────┘
```

**本阶段内部工具清单（编排器自有，不涉及世界图业务）**：见 §5.3。

### 2.2 关键查证结果

| # | 查证项 | 结论 | 证据 |
|---|---|---|---|
| 1 | `@pi/scheduler` 核心逻辑 PI 依赖 | **零** | grep `@earendil-works\|ExtensionContext\|pi-ai` 于 `packages/scheduler/src/` 无匹配 |
| 2 | `@pi/role-pool` PI 依赖 | **零** | 同上，无匹配 |
| 3 | `@pi/renderer` PI 依赖 | **零**（仅注释提及） | `packages/renderer/src/types.ts:89` 仅注释 |
| 4 | 4 路 LLM caller 的 PI 依赖 | **仅 `ExtensionContext`** | planner-llm/role-pool-llm/renderer-llm/knowledge-mapper-llm 均 `makeXxxLlmCaller(ctx: ExtensionContext)` |
| 5 | `ctx` 实际被用到的字段 | **仅 `model` + `modelRegistry.getApiKeyAndHeaders(model)`** | 4 个 caller 工厂体一致 |
| 6 | `@earendil-works/pi-ai` 独立性 | **完全独立 npm 库** | [package.json](file:///d:/claude/pi-ex/pi-ex/packages/ai/package.json) v0.77.0 MIT，`main: ./dist/index.js`，无 pi 运行时依赖 |
| 7 | `Embedder` PI 依赖 | **零** | [embedder.ts:19-20](file:///d:/claude/pi-ex/narrative-engine/src/embedder.ts) 仅 `@xenova/transformers` + `underworld-graph` |
| 8 | `memory.ts` PI 依赖 | **零** | [memory.ts:22-24](file:///d:/claude/pi-ex/narrative-engine/src/memory.ts) 仅 fs/path + `underworld-graph` |
| 9 | standalone 模式是否已存在 | **是** | [main.ts](file:///d:/claude/pi-ex/narrative-engine/src/app/main.ts) → `startUnifiedServer`，HTTP API 已跑通（世界图/文件/项目/管理路由） |
| 10 | unified-server 是否有调度端点 | **无** | [unified-server.ts](file:///d:/claude/pi-ex/narrative-engine/src/app/unified-server.ts) 路由只有 world-graph + files/projects/admin，无 dispatch/commit/discard |
| 11 | renderer-llm 签名 bug 是否仍存在 | **已修复** | [renderer-llm.ts:28](file:///d:/claude/pi-ex/narrative-engine/src/renderer-llm.ts) 已是 `(ctx: ExtensionContext)` 签名（2026-07-29 改造完成） |
| 12 | PI 本体是否有 MCP 支持 | **无** | pi-ex/packages 下无 mcp 相关源码 |
| 13 | MCP 协议现状 | **事实标准** | Anthropic 2024-11 开源，2025 底移交 Linux Foundation，2026-07-28 新版规范（无状态架构） |
| 14 | MCP TS SDK | **`@modelcontextprotocol/sdk`** | 官方 SDK，`server.tool(name, desc, schema, handler)` 注册工具 |
| 15 | `pi-agent-core` 独立 npm 包 | **是** | [package.json](file:///d:/claude/pi-ex/pi-ex/packages/agent/package.json) v0.77.0，依赖仅 `pi-ai` + typebox + yaml，**不依赖 pi-coding-agent** |
| 16 | `Agent` 类构造签名 | **不依赖 ExtensionContext** | [agent.ts:96-116](file:///d:/claude/pi-ex/pi-ex/packages/agent/src/agent.ts) `AgentOptions`：`initialState` + `streamFn` + `getApiKey` |
| 17 | `AgentTool` 类型 | **4 参数 execute，无 ctx** | [types.ts:360-384](file:///d:/claude/pi-ex/pi-ex/packages/agent/src/types.ts) 子代理工具基础 |
| 18 | `streamFn` 来源 | **`streamSimple`（pi-ai 导出）** | [agent.ts:1-10](file:///d:/claude/pi-ex/pi-ex/packages/agent/src/agent.ts) 从 `@earendil-works/pi-ai` 导入 |

### 2.3 核心结论

**编排器的核心逻辑（plan/commit/discard）已经零 PI 依赖。** 唯一的 PI 耦合点是装配层的 4 路 LLM caller 工厂签名 `(ctx: ExtensionContext)`——但它们实际只用 ctx 的两个字段（`model`、`modelRegistry`）。这意味着：

> **只要把"从 ctx 取 model/apiKey"抽象成一个独立的 `LlmConfig`，编排器就能完全脱离 PI 运行时独立运行。**

**子代理升级也是可行的**：`@earendil-works/pi-agent-core` 是独立 npm 包（v0.77.0），`Agent` 类构造只需 `initialState` + `streamFn` + `getApiKey`，**不依赖 ExtensionContext**。4 路 caller 从"单次 complete"升级为"Agent 类实例 + AgentTool 工具注入"，不需要 PI 运行时。

## 三、可行性结论

**✅ 可行。不启动 PI、依靠 SDK 模式单独完成编排 + 渲染（含子代理实现），技术上完全成立。**

依据：

1. **编排器核心**（plan/commit/discard）零 PI 依赖，纯函数 + 依赖注入，可独立实例化
2. **4 路 LLM caller** 只依赖 `@earendil-works/pi-ai`（独立 npm 库）的 `complete`/`validateToolCall`，不依赖 PI 运行时
3. **子代理升级可行**：`pi-agent-core` 的 `Agent` 类独立可用（[agent.ts:96-116](file:///d:/claude/pi-ex/pi-ex/packages/agent/src/agent.ts)），依赖仅 `pi-ai`，构造只需 `initialState` + `streamFn` + `getApiKey`
4. **子代理工具可行**：`AgentTool` 4 参数 execute 无 ctx（[types.ts:360-384](file:///d:/claude/pi-ex/pi-ex/packages/agent/src/types.ts)），world-graph 依赖经闭包注入
5. **渲染链路**（`@pi/renderer`）零 PI 依赖，`RenderLlmCaller` 接口由 caller 注入
6. **世界图**（underworld-graph）已独立完成，路径由调用方注入
7. **Embedder / memory / 规则集** 全部无 PI 依赖
8. **standalone HTTP 骨架已存在**（unified-server），只需补调度端点

**需要做的改造**：

| 改造项 | 现状 | 目标 |
|---|---|---|
| 1. 抽象 `LlmConfig` / `AgentRuntime` | 4 路 caller 从 ctx 取 model/apiKey | 独立配置源（env/文件/HTTP 参数） |
| 2. caller 工厂签名 | `makeXxxLlmCaller(ctx: ExtensionContext)` | `makeXxxLlmCaller(config: LlmConfig)` |
| 3. **4 路 caller 升级为子代理** | 单次 `complete()` | `Agent` 类实例 + AgentTool 注入（[子代理设计 §三](2026-07-31-subagent-orchestrator-design.md)） |
| 4. **编排器核心改造** | 硬编码 10 步流水线（plan.ts） | Orchestrator + EventQueue + 子代理调度（[子代理设计 §二/§四](2026-07-31-subagent-orchestrator-design.md)） |
| 5. 编排器服务层 | 无（只有工具层） | 薄服务 `OrchestratorService` 封装 dispatch/commit/discard + 队列 |
| 6. MCP server 包装 | 无 | `@modelcontextprotocol/sdk` 暴露调度工具 |
| 7. HTTP 调度端点（可选） | 无 | `/api/schedule/dispatch` 等（复用 unified-server） |

## 四、目标架构

```
┌──────────────────────────────────────────────────────────┐
│ 外部调用方（不依赖 PI 运行时）                              │
│  · Web UI / 命令行 / 未来主会话（PI SDK 或 MCP client）    │
└──────────────────────────┬───────────────────────────────┘
                           │ 标准 API 契约
              ┌────────────┼────────────┐
              ▼            ▼            ▼
      ┌─────────────┐ ┌─────────┐ ┌───────────────┐
      │ HTTP REST   │ │ MCP     │ │ 直接内嵌调用   │
      │ (unified-   │ │ (stdio/ │ │ (SDK 模式      │
      │  server 补  │ │ SSE)    │ │  主会话)       │
      │  调度端点)   │ └────┬────┘ │               │
      └──────┬──────┘      │      └───────┬───────┘
             └─────────────┼──────────────┘
                           ▼
              ┌────────────────────────────┐
              │ OrchestratorService        │  ← 新增薄服务层
              │  · dispatch(event) 入队     │
              │  · commit(planId)          │
              │  · discard(planId)         │
              │  · queue_status()          │
              └────────────┬───────────────┘
                           ▼
              ┌────────────────────────────────────┐
              │ Orchestrator（纯代码，非 LLM）       │
              │  · EventQueue 后台 worker 逐条执行   │
              │  · 子代理调度（串行/并行）           │
              │  · 可见性注入 + 结果汇总             │
              └──┬────────┬──────────┬──────────┬──┘
                 ▼        ▼          ▼          ▼
        ┌────────────┐ ┌────────┐ ┌─────────┐ ┌──────────┐
        │ planner    │ │ 角色代理│ │ 可见推理 │ │ 渲染器    │
        │ 子代理     │ │ A/B/C  │ │ 子代理  │ │ 子代理    │
        │ Agent 实例 │ │ Agent  │ │ Agent   │ │ Agent    │
        │ +内部工具:  │ │ +内部: │ │ +内部:  │ │ +内部:   │
        │ retrieval_ │ │ charac-│ │ diffu-  │ │ render_  │
        │ plan 提交   │ │ ter_act│ │ sion_   │ │ result   │
        │            │ │ ion 提交│ │ result  │ │ 提交     │
        └─────┬──────┘ └───┬────┘ └────┬────┘ └────┬─────┘
              └────────────┴───────────┴───────────┘
                           ▼
        ┌──────────────────────────────────────────┐
        │ 子代理公共底座（零 PI 依赖）                │
        │  · Agent 类（@earendil-works/pi-agent-core）│
        │  · AgentTool（产出提交，闭包注入）          │
        │  · AgentRuntime（model/streamFn/apiKey）  │
        └────────────────────┬─────────────────────┘
                             ▼
        ┌──────────────────────────────────────────┐
        │ 数据/能力层（标准 API 接口 + 适配器）       │
        │  · WorldGraphPort  ← underworld-graph    │
        │  · EmbedderPort    ← Embedder            │
        │  · RulesetPort     ← 规则集加载           │
        │  · MemoryPort      ← memory.ts           │
        │  · RendererPort    ← @pi/renderer        │
        │  · RolePoolPort    ← @pi/role-pool       │
        └──────────────────────────────────────────┘
```

**关键**：子代理层全部只依赖 `pi-agent-core` + `pi-ai`，**不依赖 pi-coding-agent**。唯一的 PI 解耦边界是 `AgentRuntime`（[子代理设计 §3.1](2026-07-31-subagent-orchestrator-design.md)）——SDK 模式下由 `LlmConfig`（独立配置源）构造，替代 PI 适配器。

**本阶段范围**：子代理内部工具只含"产出提交"类（retrieval_plan / character_action / diffusion_result / render_result），**不注入世界图检索/写入工具**（数据层以标准接口定义，适配器后续阶段接入）。

**数据/能力层标准接口设计**：编排器只依赖接口（Ports），不依赖具体实现（Adapters）。可对接不同数据库模式、存储引擎、远程服务——只要实现对应接口即可。见 §5.6。

## 五、关键技术设计

### 5.1 `LlmConfig` / `AgentRuntime` 抽象（核心解耦点）

**两个抽象的关系**：
- `AgentRuntime` 是[子代理设计 §3.1](2026-07-31-subagent-orchestrator-design.md)定义的解耦接口（model / streamFn / getApiKey）
- `LlmConfig` 是 `AgentRuntime` 的**配置源**——SDK 模式下从独立配置构造 `AgentRuntime`，替代 PI 适配器

```typescript
// 子代理设计 §3.1 的 AgentRuntime（零 PI 依赖）
interface AgentRuntime {
  model: Model<any>;
  streamFn: StreamFn;
  getApiKey: (provider: string) => Promise<string | undefined>;
}

// SDK 模式配置源（替代 pi-adapter.ts）
export interface LlmConfig {
  model: {
    /** 已查证：pi-ai `getModel` 第一参数要求 KnownProvider 字面量联合（types.ts:23-55） */
    provider: KnownProvider; // 如 "deepseek"，用字面量类型而非裸 string，避免 `as never` 强转
    name: string;            // 如 "deepseek-v4-flash"
  };
  apiKey: string;
  headers?: Record<string, string>;
}

export interface LlmConfigSource {
  getConfig(): Promise<LlmConfig>;
}

// 从 LlmConfig 构造 AgentRuntime（纯 SDK，无 PI）
// 已查证：getModel 存在且可独立使用（models.ts:20-26），从静态 MODELS 查表，无 PI 全局状态。
// 类型说明（2026-07-31 复核修正）：getModel 第二参数是字面量 keyof 联合（models.generated.ts），
// 运行时 string 无法静态匹配；且 MODELS 类型不被 pi-ai 的 exports 导出（/models.generated 子路径
// 未声明，Node 原生 ESM 导入会报 ERR_PACKAGE_PATH_NOT_EXPORTED）。因此第二参数断言 `as never`
// （never 可赋给任何类型参数）是唯一可行入口——原 `as keyof (typeof MODELS)[...]` 写法依赖
// 不可导出的 MODELS 类型，不可用，已回退。
export function createRuntimeFromConfig(config: LlmConfig): AgentRuntime {
  return {
    model: getModel(config.model.provider, config.model.name as never),
    streamFn: streamSimple,
    getApiKey: async () => config.apiKey,
  };
}
```

**三种配置来源（按优先级）**：
1. 环境变量：`NE_LLM_PROVIDER` / `NE_LLM_MODEL` / `NE_LLM_API_KEY`（独立运行最简单）
2. 配置文件：`<cwd>/.pi/config.json`（多项目场景）
3. HTTP 参数/API：未来应用 UI 传入（应用化场景）

**改造范围**：
- 4 个 caller 工厂签名 `(ctx: ExtensionContext)` → `(config: LlmConfig)`，体内 `ctx.model` → `config.model`、`ctx.modelRegistry.getApiKeyAndHeaders` → `config.apiKey`。改动量 ~40 行/文件 × 4，纯机械替换
- `pi-adapter.ts`（子代理设计的 PI 适配器）在 SDK 模式下**不再需要**——`createRuntimeFromConfig` 直接替代它

### 5.2 `OrchestratorService` 薄服务层

```typescript
export interface OrchestratorService {
  /** 派发事件：入队即返回 queueId（plan 模式返回 planId；yolo 模式直接 commit） */
  dispatch(event: DispatchRequest): Promise<DispatchResult>;
  /** 提交 plan：启动可见推理 + 渲染子代理 */
  commit(planId: string): Promise<CommitResult>;
  /** 丢弃 plan */
  discard(planId: string): Promise<{ ok: boolean }>;
  /** 队列状态查询（对应 scheduler_queue_status 工具） */
  queueStatus(): QueueStatus;
}
```

实现要点：
- 内部持有 `Orchestrator`（队列 + worker + 子代理调度）
- 内部维护 plans 缓存（当前 `@pi/scheduler` 内部 cache 已做）
- 维护 storyTime 锚点（当前在 `scheduler-tools.ts` 的 `state.currentStoryTime`，需迁入服务层）
- 无 PI 类型泄漏：全部用自有类型

### 5.3 子代理实现（第二阶段核心工作）

按[子代理设计 §三](2026-07-31-subagent-orchestrator-design.md)，4 类子代理全部用 `Agent` 类实现。**编排器内部工具是私有的**——子代理能看到的工具集合由编排器在构造 Agent 时注入，不暴露给主会话 LLM。

```typescript
// 子代理通用构造（零 PI 依赖，已由 agent.ts:96-116 证实）
import { Agent } from "@earendil-works/pi-agent-core";

function createSubAgent(
  rt: AgentRuntime,                 // 从 LlmConfig 构造
  systemPrompt: string,
  tools: AgentTool[],               // 内部工具（闭包注入），私有
  messages: AgentMessage[],
): Agent {
  return new Agent({
    initialState: { systemPrompt, model: rt.model, tools, messages },
    streamFn: rt.streamFn,
    getApiKey: rt.getApiKey,
  });
}
```

#### 5.3.1 本阶段内部工具清单（编排器自有，不涉及世界图业务）

用户澄清：**本阶段不考虑世界图检索/写入**。因此本阶段子代理内部工具只包含"产出提交类"工具（每个子代理的出口），世界图检索/写入类工具后续接数据层时注入。

| 子代理 | 内部工具（本阶段） | 工具作用 | 类型 |
|---|---|---|---|
| planner | `retrieval_plan` | 提交检索计划（结构化输出，现有 retrievalPlanSchema 复用） | AgentTool（产出提交） |
| 角色代理 × N | `character_action` | 提交角色行为（结构化输出，现有 characterActionSchema 复用） | AgentTool（产出提交） |
| 可见推理 | `diffusion_result` | 提交扩散结果（change 事件 + visibilityChanges） | AgentTool（产出提交） |
| 渲染器 | `render_result` | 提交渲染结果（正文文本） | AgentTool（产出提交） |

**关键点**：
- 本阶段 4 个内部工具全部是**产出提交**性质——子代理在 agent loop 中推理完成后，通过 tool call 提交结构化结果
- 不包含任何 world_* 检索/写入工具（世界图操作后续阶段注入）
- 不包含角色卡读取、规则集读取等业务工具（这些通过 systemPrompt/messages 直接注入上下文，不需要工具）
- 工具 schema 复用现有 TypeBox schema（`retrievalPlanSchema` / `characterActionSchema`），零重复定义

#### 5.3.2 产出提交工具实现要点

```typescript
// src/agents/tools.ts（本阶段范围）
import type { AgentTool } from "@earendil-works/pi-agent-core";

/** planner 子代理：提交检索计划（AgentTool 包装，无 ctx，闭包注入） */
export function createRetrievalPlanTool(): AgentTool {
  return {
    name: "retrieval_plan",
    label: "Retrieval Plan",
    description: "提交本次事件的检索计划。必须调用此工具一次提交结果。",
    parameters: retrievalPlanSchema,   // 复用现有 schema
    async execute(toolCallId, params) {
      return {
        content: [{ type: "text", text: "检索计划已提交" }],
        details: { plan: params },     // 编排器从 tool result 提取
      };
    },
  };
}

/** 角色代理：提交角色行为（AgentTool 包装） */
export function createCharacterActionTool(): AgentTool {
  return {
    name: "character_action",
    label: "Character Action",
    description: "提交角色本次行动的结构化输出。必须调用此工具一次提交结果。",
    parameters: characterActionSchema, // 复用现有 schema
    async execute(toolCallId, params) {
      return {
        content: [{ type: "text", text: "角色行为已提交" }],
        details: { action: params },
      };
    },
  };
}
```

**编排器如何收集产出**：子代理的 tool call 结果经 `tool_execution_end` 事件（AgentEvent，types.ts:418）暴露，编排器订阅该事件提取 `details` 中的结构化产出。

#### 5.3.3 世界图检索/写入工具（后续阶段，本阶段不实现）

按[工具分配方案 §五](2026-07-31-tool-allocation-design.md)和[sdk-tool-implementation §四](2026-07-31-sdk-tool-implementation.md)，后续接数据层时注入：

| 子代理 | 后续注入工具（世界图） | 说明 |
|---|---|---|
| planner | 7 个只读工具（world_entity_get / world_relations / world_query 等） | 让 planner 自主查世界图后再定检索策略 |
| 角色代理 | 4 个受限变体（characterId 绑定 + 可见性过滤） | 让角色代理自主查询可见知识 |
| 可见推理 | 9 个写入工具（world_event_apply / world_visibility_* 等） | 让可见推理自主写扩散 |
| 渲染器 | `@pi/renderer` 底层 API（readChapter / writeChapter） | 渲染器代理读章节衔接上下文 |

**本阶段先不注入这些**——它们依赖世界图数据层，属后续接入范围。

### 5.4 MCP server 包装

**SDK**：`@modelcontextprotocol/sdk`（官方）

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "narrative-orchestrator", version: "0.1.0" });

server.tool(
  "scheduler_dispatch",
  "调度器派发事件：planner 推导检索计划→检索→role-pool 演绎",
  {
    storyTime: z.string().describe("故事时间 ch{NNN}.ev{NNN}"),
    instruction: z.string(),
    characterIds: z.array(z.string()),
    executionHints: z.string().optional(),
    mode: z.enum(["plan", "yolo"]).optional(),
    // ...与现有 scheduler_dispatch 参数一致
  },
  async (params) => {
    const result = await orchestrator.dispatch(params);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

server.tool("scheduler_commit", "...", { planId: z.string() }, handler);
server.tool("scheduler_discard", "...", { planId: z.string() }, handler);

// stdio 传输（最简）
const transport = new StdioServerTransport();
await server.connect(transport);
```

**MCP 工具的 schema 可直接复用现有 TypeBox schema 转换**（TypeBox → zod 或直接用 `@modelcontextprotocol/sdk` 的 TypeBox 支持——需验证 SDK 是否内置）。

**传输方式选择**：
| 传输 | 适用场景 | 复杂度 |
|---|---|---|
| **stdio** | 本地进程调用（CLI / PI 主会话子进程 / Claude Desktop） | 最低，推荐先行 |
| **SSE/HTTP** | 远程进程 / 未来应用 UI | 中，后补 |

### 5.5 HTTP 调度端点（与 MCP 互补，可选）

若复用 unified-server，加 3 个端点：
- `POST /api/schedule/dispatch`
- `POST /api/schedule/commit`
- `POST /api/schedule/discard`

复用现有 `{ ok, data, error }` envelope 和 `ERROR_STATUS` 映射。**但与 MCP 二选一即可**——MCP 是更标准的协议，REST 是更通用的 HTTP。建议第一阶段只做 MCP，HTTP 端点等应用 UI 需要时再加。

### 5.6 数据/能力层：标准 API 接口设计（Ports & Adapters）

**核心原则（用户澄清）**：数据/能力层做成**标准 API 接口**——编排器只依赖接口（Ports），不依赖具体实现（Adapters）。后续可对接不同的数据库模式、存储引擎、远程服务，只要实现对应接口即可。

```
┌──────────────────────────────────────────────────────┐
│ 编排器 / 子代理（只依赖接口）                           │
│  · SchedulerCtx（注入 Port 实例，而非具体类）           │
└──────────┬──────────────────────────────────────────┘
           ▼ 依赖抽象，不依赖实现
┌──────────────────────────────────────────────────────┐
│ 标准接口层（Ports）—— 编排器定义，任何实现可插拔        │
│                                                       │
│  WorldGraphPort   ← underworld-graph 适配器（默认）    │
│  EmbedderPort     ← Embedder 适配器（默认）            │
│  RulesetPort      ← 文件系统适配器（默认）             │
│  MemoryPort       ← memory.ts 适配器（默认）           │
│  RendererPort     ← @pi/renderer 适配器（默认）        │
│  RolePoolPort     ← @pi/role-pool 适配器（默认）       │
│                                                       │
│  未来可替换：PostgreSQL 适配器 / 远程服务适配器 /       │
│  内存 mock 适配器（测试用）—— 实现同一接口即可          │
└──────────────────────────────────────────────────────┘
```

#### 5.6.1 接口定义（Ports）

```typescript
// src/ports/types.ts（标准接口层，零业务依赖）

/** 世界图端口：实体/关系/事件/可见性的读写抽象 */
export interface WorldGraphPort {
  // 读取
  getEntityAt(entityId: string, storyTime: string): Promise<EntitySnapshot | null>;
  getCharacterView(characterId: string, storyTime: string, opts?: CharacterViewOpts): Promise<FactSnapshot[]>;
  getRelations(entityId: string, storyTime: string): Promise<RelationSnapshot[]>;
  getAllDeclarationsAt(storyTime: string): Promise<StateDeclaration[]>;
  // 写入
  processEvent(event: EventRecordInput): Promise<EventRecord>;
  addRelation(sourceId: string, targetId: string, label: string, storyTime: string): Promise<void>;
  setVisibility(characterId: string, declarationId: string, opts: VisibilityInput): Promise<void>;
  // 检索
  query(opts: QueryOpts): Promise<SearchResult[]>;
  // 嵌入（可选，无向量引擎时降级）
  updateFactEmbedding?(declarationId: string, vec: number[]): Promise<void>;
}

/** 嵌入端口：向量化抽象（可替换为远程嵌入服务） */
export interface EmbedderPort {
  embedEntity(snapshot: EntitySnapshot): Promise<number[]>;
  embedFact(decl: StateDeclaration): Promise<number[]>;
}

/** 规则集端口：各类规则集加载抽象（可替换为数据库存储规则集） */
export interface RulesetPort {
  loadPlanner(cwd: string): Promise<string>;
  loadRole(cwd: string): Promise<string>;
  loadRender(cwd: string): Promise<string>;
}

/** 项目记忆端口：memory.md 读写抽象 */
export interface MemoryPort {
  load(cwd: string): Promise<string>;
  update(wg: WorldGraphPort, cwd: string): Promise<void>;
}

/** 渲染器端口：章节文件 IO + 渲染抽象 */
export interface RendererPort {
  readChapter(chapterPath: string): Promise<string>;
  renderToFile(opts: RenderFileOpts, deps: { llm: RenderLlmCaller; ruleSet: string }): Promise<RenderResult>;
  renderText(opts: RenderTextOpts, deps: { llm: RenderLlmCaller; ruleSet: string }): Promise<string>;
}

/** 角色池端口：角色演绎抽象（可替换为角色子代理编排） */
export interface RolePoolPort {
  interact(cmd: InteractCommand, deps: { llm: RoleLlmCaller; ruleSet: string }): Promise<InteractResult>;
}
```

#### 5.6.2 默认适配器（Adapters）

| Port | 默认适配器 | 实现来源 |
|---|---|---|
| `WorldGraphPort` | `createWorldGraphAdapter(wg: WorldGraph)` | 包装 underworld-graph 的 `WorldGraph` 实例 |
| `EmbedderPort` | `createEmbedderAdapter(emb: Embedder)` | 包装 `src/embedder.ts` 的 `Embedder` 类 |
| `RulesetPort` | `createFileRulesetAdapter()` | 包装 `loadPlannerRuleSet` / `loadRoleRuleSet` / `loadRuleSet` |
| `MemoryPort` | `createMemoryAdapter()` | 包装 `src/memory.ts` 的 `loadMemory` / `updateMemory` |
| `RendererPort` | `createRendererAdapter()` | 包装 `@pi/renderer` 的 `renderToFile` / `renderText` / `readChapter` |
| `RolePoolPort` | `createRolePoolAdapter()` | 包装 `@pi/role-pool` 的 `interact` |

**适配器模式**：默认适配器都是薄包装（10-30 行），把具体类的调用映射到 Port 接口。编排器装配时注入 Port 实例：

```typescript
// src/orchestrator/assembly.ts（装配层）
const ports = {
  worldGraph: createWorldGraphAdapter(wg),      // underworld-graph
  embedder: createEmbedderAdapter(embedder),     // Embedder
  ruleset: createFileRulesetAdapter(),
  memory: createMemoryAdapter(),
  renderer: createRendererAdapter(),
  rolePool: createRolePoolAdapter(),
};
const orchestrator = new Orchestrator(ports, runtime);
```

#### 5.6.3 可替换性（用户核心诉求）

只要实现对应 Port 接口，即可替换数据源，编排器与子代理零改动：

| 替换场景 | 实现方式 |
|---|---|
| **换数据库**（PostgreSQL / MySQL） | 实现 `WorldGraphPort`，内部改用 SQL 查询 |
| **换存储引擎**（内存 / Redis / 远程图数据库） | 实现 `WorldGraphPort`，内部改存储调用 |
| **换嵌入服务**（远程 API 替代本地 ONNX） | 实现 `EmbedderPort`，内部调远程接口 |
| **规则集入库**（数据库替代文件） | 实现 `RulesetPort`，内部查库 |
| **测试 mock** | 实现各 Port 的内存 mock 版，编排器测试零外部依赖 |
| **未来主会话 SDK 化** | 主会话经 `OrchestratorService` 调编排器，不直接碰 Port |

**设计约束**：
- Port 接口只含编排器需要的最小方法集（从 plan.ts / commit.ts 的实际调用提取，不脑补）
- Port 方法签名尽量用结构化类型（`FactSnapshot` / `StateDeclaration`），不绑定 underworld-graph 的具体类（除必要的数据载体）
- 适配器是唯一的"具体实现 → 接口"转换点，编排器内部不出现具体类引用

#### 5.6.4 与 AgentRuntime 的关系

- `AgentRuntime`（§5.1）：LLM 能力的抽象（model/streamFn/apiKey），是**编排器的运行时底座**
- Ports（§5.6）：数据/能力层的抽象（世界图/嵌入/规则集/记忆/渲染/角色池），是**编排器的数据底座**
- 两者正交：`AgentRuntime` 管"LLM 怎么调"，Ports 管"数据怎么存"

## 六、实施路径建议

### 前置条件：pi-agent-core 依赖落地（阶段 0 前必须完成）

**依赖可用性查证（2026-07-31 复核，修正原稿遗漏）**：`@earendil-works/pi-agent-core` v0.77.0 目前**无法从 narrative-engine 直接 import**：
- 根目录 `require.resolve('@earendil-works/pi-agent-core')` 失败（MODULE_NOT_FOUND）
- 该包仅作为 `@earendil-works/pi-coding-agent` 的嵌套传递依赖存在（`node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/`），且该嵌套副本**只有 package.json + README，无 dist**（`main: ./dist/index.js` 会加载失败）
- 源码在 pi-ex 仓库 `packages/agent/`（v0.77.0，dist 已构建，`index.js` / `node.js` / `types.js` 齐全）

落地方式（阶段 0 前执行其一）：
1. `npm install @earendil-works/pi-agent-core@^0.77.0 --save-dev --ignore-scripts`（走 npm registry，最简）
2. 或 `npm link d:\claude\pi-ex\pi-ex\packages\agent` 本地 link（无 registry 依赖，但需保证 pi-ai 版本解析一致）

`@earendil-works/pi-coding-agent` 保留在 devDependencies（扩展加载、工具注册仍需要），但子代理代码层不直接 import 它——只通过 `pi-adapter.ts` 间接使用 `ExtensionContext` 类型。

**本阶段范围（用户澄清）**：先做编排器**本体独立设计**——EventQueue + Orchestrator + 子代理框架 + 内部产出提交工具 + **数据/能力层标准接口（Ports）定义**。**不含世界图检索/写入的具体适配器实现**（后续接数据层）。

### 阶段 0：解耦验证（最小 demo，验证可行性核心前提）

**目标**：验证"不启动 PI、SDK 模式独立编排"的最关键存疑点，不实现完整子代理。

1. 新建 `src/orchestrator/` 目录：
   - `llm-config.ts`：`LlmConfig` 类型 + `createRuntimeFromConfig` + env 配置源
   - `service.ts`：`OrchestratorService`
   - `mcp-server.ts`：MCP 包装入口
2. 4 路 caller 工厂签名改为 `(config: LlmConfig)`，更新 `scheduler-llm.ts`
3. 写独立启动脚本：`node scripts/orchestrator-mcp.mjs`（不经过 PI，纯 Node 进程）
4. 验证：`npx @modelcontextprotocol/inspector` 或 CLI 直调，确认 dispatch → commit 全链路跑通（此阶段 4 路 caller 仍是单次 complete，验证 `pi-ai` 在无 PI 环境的可用性 + LlmConfig 抽象正确性）

**验收**：不启动 PI，靠 stdio MCP 调用，完成一次"派发事件 → 角色演绎 → 写扩散 → 渲染章节"完整流程。

### 阶段 1：编排器本体独立设计（本阶段核心，不接触世界图业务）

**范围**：EventQueue + Orchestrator + 子代理框架 + 内部产出提交工具 + **Ports 接口定义**。**不含世界图检索/写入工具与适配器**。

1. `src/agents/agent-runtime.ts`：`AgentRuntime` 接口 + `createRuntimeFromConfig`
2. `src/ports/types.ts`：**数据/能力层标准接口定义**（WorldGraphPort / EmbedderPort / RulesetPort / MemoryPort / RendererPort / RolePoolPort）——见 §5.6.1
3. `src/agents/tools.ts`：本阶段 4 个产出提交 AgentTool（retrieval_plan / character_action / diffusion_result / render_result），schema 复用现有 TypeBox 定义
4. `src/agents/planner-agent.ts`：planner 子代理工厂（注入 retrieval_plan 工具 + 事件指令/角色/storyTime 上下文）
5. `src/agents/role-agent.ts`：角色代理工厂（注入 character_action 工具 + 角色卡上下文）
6. `src/agents/reasoning-agent.ts`：可见推理代理工厂（注入 diffusion_result 工具）
7. `src/agents/renderer-agent.ts`：渲染器代理工厂（注入 render_result 工具）
8. `src/orchestrator.ts`：Orchestrator（EventQueue + worker + 子代理调度 + 串行/并行 + 结果汇总）
9. `src/event-queue.ts`：内存队列 + worker 循环

**关键设计决策**：
- 子代理的上下文（事件指令 / 角色卡 / storyTime）通过 systemPrompt + messages 注入，不需要 world_* 工具
- 产出提交工具是编排器收集子代理结果的唯一出口（`tool_execution_end` 事件提取）
- **Ports 接口定义随编排器本体一起落地**（类型先行），默认适配器后续接数据层时实现
- 世界图检索/写入工具留接口占位，后续接数据层

**验收**：不启动 PI，独立进程跑通完整子代理链路（planner → 角色（串行/并行）→ 可见推理 → 渲染），各子代理通过产出提交工具返回结构化结果，编排器正确汇总（暂不写世界图）。

### 阶段 2：接入数据/能力层（后续阶段）

- 实现默认适配器：`createWorldGraphAdapter` / `createEmbedderAdapter` / `createFileRulesetAdapter` / `createMemoryAdapter` / `createRendererAdapter` / `createRolePoolAdapter`（薄包装，见 §5.6.2）
- storyTime 锚点迁入服务层（从 scheduler-tools 的 state 迁移）
- memory.md 更新逻辑接入（`updateMemory` 已无 PI 依赖）
- 注入世界图检索/写入工具（planner 只读 7 个 / 角色受限 4 个 / 可见推理写入 9 个）
- 可见推理代理吸收 knowledge-mapper 职责（[子代理设计 §3.4](2026-07-31-subagent-orchestrator-design.md)）
- 渲染器代理接入 `RendererPort`（readChapter / writeChapter）
- MCP stdio 接入 `OrchestratorService`（dispatch / commit / discard / queue_status 4 个工具）
- 评估是否补 SSE 传输
- 未来主会话（PI SDK 模式）直接内嵌调用 `OrchestratorService`（不经过 MCP）

## 七、风险与存疑

| # | 存疑点 | 影响 | 验证方式 |
|---|---|---|---|
| 1 | `@earendil-works/pi-ai` 的 `complete` / `streamSimple` 在无 PI 环境下是否完全可用（是否有隐式全局状态） | **高**——4 路 caller + 子代理 streamFn 都依赖它 | 阶段 0 最小 demo 直接验证 |
| 2 | `LlmConfig.model` 需要 pi-ai `Model` 类型的哪些字段（仅 provider/name？还是更多） | 中 | 读 pi-ai `Model` 类型定义确认 |
| 3 | `getModel(provider, name)` 在独立进程是否能正确解析模型配置（当前 `getModel` 调用在 4 个 caller 中不存在——它们直接拿 `ctx.model`） | **高**——`createRuntimeFromConfig` 依赖它 | 阶段 0 验证；若 getModel 不可用，`LlmConfig` 需携带完整 Model 对象 |
| 4 | **Agent 终止条件**：子代理产出结构化输出（tool call 返回）后如何结束 agent loop | **高**——子代理能否正确终止决定整个架构 | **已查证（2026-07-31 复核）**：`AgentLoopConfig.shouldStopAfterTurn` 存在于 agent-loop.ts:241-245，但 **`AgentOptions`（构造参数，agent.ts:96-116）不暴露该字段**——用户无法从 `new Agent(options)` 注入自定义终止回调。终止只能靠 `AgentToolResult.terminate: true`（types.ts:354）→ `shouldTerminateToolBatch`（agent-loop.ts:544-546）判定。因此子代理终止策略定为：**产出提交工具返回 `terminate: true`，systemPrompt 约束"最终结论必须通过该工具一次提交、不得同一轮并行调用其他工具"** |
| 5 | **Agent 类在纯 Node 进程的 transport**：`AgentOptions.transport` 是否需要 Node transport（`./node` 子路径） | 中 | 查 `@earendil-works/pi-agent-core/node` 导出 |
| 6 | MCP SDK 的 schema 是否支持 TypeBox（还是必须 zod） | 低 | 查 SDK 文档 |
| 7 | MCP stdio 调用的并发模型（编排器是长任务，stdio 单请求是否够） | 中 | 阶段 1 实测 |
| 8 | embedder 在独立进程的加载（`@xenova/transformers` 模型下载/缓存路径） | 低 | 现有 Embedder 已独立，直接复用 |
| 9 | 角色代理受限变体的可见性过滤：Search 类是否支持 visibility 过滤参数 | 中 | 查 `Search` 类源码签名（sdk-tool-implementation §8.4 同存疑） |
| 10 | 规则集加载路径（`loadPlannerRuleSet(cwd)`）在独立模式下 cwd 从哪来 | 低 | MCP 参数/配置文件传入 cwd |
| 11 | **内部工具私有边界验证**：子代理 AgentTool 是否真的不暴露给主会话 LLM（`Agent` 类的 tools 与主会话 customTools 是否隔离） | **高**——架构原则的核心 | 查 `Agent` 类 `initialState.tools` 的可见性边界；主会话 `customTools` 与子代理 `tools` 是两套独立体系，天然隔离（查证） |
| 12 | **产出提交工具的 terminate 语义**：子代理调用产出提交工具后，如何确保 agent loop 立即结束（而不是继续多轮） | **高**——编排器效率 | **已查证（2026-07-31 复核）**：`terminate: true` 是 **all 语义**——`shouldTerminateToolBatch`（agent-loop.ts:544-546）要求同轮 batch 内**所有** finalized tool result 都 `terminate === true` 才会停（`every` 判定）。若子代理同轮并行调用多个工具，仅产出工具设 terminate 不足以终止。因此：①systemPrompt 约束"结论必须且只能通过产出工具一次提交"；②产出工具 execute 返回 `terminate: true`；③必要时可将工具 `executionMode: "sequential"` 强制串行，避免同轮多工具。阶段 1 实测 |
| 13 | **Ports 接口方法集完整性**：§5.6.1 的接口方法是否覆盖编排器全部数据需求（从 plan.ts / commit.ts 的实际调用提取，是否漏方法） | 中——漏方法会导致阶段 2 返工 | **已反推（2026-07-31 复核）**：grep `plan.ts` / `commit.ts` / `retrieve.ts` 实际调用点如下，§5.6.1 接口定义**与此对照修正**：<br>`wg.getEntityAt`（plan.ts:169, commit.ts:149, retrieve.ts:100）<br>`wg.processEvent`（commit.ts:169）<br>`wg.setVisibility`（commit.ts:224, 307）<br>`wg.getAllDeclarationsAt`（commit.ts:266）<br>`wg.addRelation`（commit.ts:341）<br>`wg.updateFactEmbedding`（commit.ts:206）<br>`wg.getCharacterView`（retrieve.ts:86）<br>`wg.getRelations`（retrieve.ts 需核对）<br>`wg.search.fulltext/vector/hybrid`（retrieve.ts）<br>`embedder.embed`（retrieve.ts search_vector/hybrid）<br>`embedder.embedFact`（commit.ts:205）<br>`embedder.embedEntity`（types.ts 声明）<br>阶段 1 类型定义时以本表为准，§5.6.1 仅作草案 |
| 14 | **Port 类型边界**：接口签名用结构化类型（`FactSnapshot` / `StateDeclaration`）是否与 underworld-graph 的类型完全兼容 | 中——类型不匹配会编译失败 | 阶段 1 类型定义时对照 underworld-graph 的导出类型 |

## 八、与既有设计的关系

| 维度 | 本调研 | 子代理编排器设计 | SDK 集成架构文档 | SDK 工具实现方案 |
|---|---|---|---|---|
| 关注点 | 编排器能否独立运行 + 子代理实现 + MCP 包装 | 编排器内部如何编排子代理 | narrative-engine 与 PI SDK 集成 | 工具在 SDK 模式下怎么实现 |
| 关系 | 编排器独立化是 SDK 化的前置验证 | 本文档 §5.3 落实其子代理设计 | 主会话用 createAgentSessionRuntime | 子代理 AgentTool 包装依据 |
| 互补点 | 验证"不启动 PI 也能编排渲染" | 4 类子代理的职责/工具/生命周期 | 主会话是另一条独立路径 | 子代理工具闭包注入策略 |

**重要关系**：本调研的编排器独立化，与 SDK 集成架构中的"主会话"是**两条独立路径**——编排器不依赖主会话，主会话未来通过 MCP 或内嵌调用编排器。这与 SDK 架构文档 §3.5（编排器纯代码非 LLM）一致。

**子代理实现的关键衔接**：
- [子代理编排器设计](2026-07-31-subagent-orchestrator-design.md) §三 定义了 4 类子代理的职责、工具、生命周期
- [SDK 工具实现方案](2026-07-31-sdk-tool-implementation.md) §四 定义了子代理工具从 ToolDefinition 到 AgentTool 的包装策略
- 本文档 §5.1 定义了 SDK 模式下 `AgentRuntime` 的构造（`createRuntimeFromConfig` 替代 PI 适配器）
- 三者合起来就是"不启动 PI 的独立子代理编排器"的完整蓝图

## 九、决策溯源

1. 用户提出第二阶段方向：编排器 + MCP 包装 + 独立运行验证
2. 用户补充：编排器部分要把**子代理**也实现，参考既有文档
3. 用户再澄清（关键边界）：**编排器内部工具是私有的，不暴露给主会话 LLM**；**本阶段不考虑世界图检索/写入**；先做独立设计不接触其他业务逻辑
4. 用户再澄清（数据层）：**数据/能力层做成标准 API 接口（Ports & Adapters）**，后续可对接不同数据库模式、存储引擎，只要实现对应接口即可
5. 查证 `@pi/scheduler` / `@pi/role-pool` / `@pi/renderer` 源码：确认核心逻辑零 PI 依赖
6. 查证 4 路 caller：确认唯一 PI 耦合是 `ExtensionContext` 的 model/apiKey 两字段
7. 查证 `@earendil-works/pi-ai`：确认是独立 npm 库（v0.77.0），`complete` / `streamSimple` 可直接用
8. 查证 `@earendil-works/pi-agent-core`：确认是独立 npm 包（v0.77.0），`Agent` 类构造只需 `initialState` + `streamFn` + `getApiKey`，不依赖 ExtensionContext
9. 查证 `AgentTool` 类型：4 参数 execute 无 ctx，依赖经闭包注入
10. 查证 `AgentEvent.tool_execution_end`（types.ts:418）：子代理产出经事件暴露，编排器订阅收集
11. 查证 unified-server：确认 standalone HTTP 骨架已存在，缺调度端点
12. 查证 MCP 生态：`@modelcontextprotocol/sdk` 官方 SDK，stdio 最简
13. 结论：✅ 可行。本阶段改造 = LlmConfig/AgentRuntime 抽象 + 编排器本体（EventQueue + Orchestrator + 4 类子代理框架 + 4 个产出提交工具）+ **数据层标准接口（6 个 Ports）定义** + MCP 包装；默认适配器与世界图检索/写入后续接数据层
