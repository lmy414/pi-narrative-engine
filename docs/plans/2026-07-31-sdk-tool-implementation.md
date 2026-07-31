# SDK 模式下的工具实现方案（参考级）

> 日期：2026-07-31
> 状态：参考文档（执行依据）—— 后续实现按本文档执行
> 性质：参考级设计文档。具体执行时以此为基础，遇存疑点（§八）先原型验证再落地。
> 关联：
> - `docs/plans/2026-07-31-sdk-integration-architecture.md`（SDK 集成架构决策）
> - `docs/plans/2026-07-31-tool-allocation-design.md`（工具分配方案）
>
> 定位：本文档探索 31 个工具从 PI 扩展模式（`pi.registerTool`）迁移到 PI SDK 模式（`createAgentSession` + `customTools`）的具体实现方式。所有结论基于 PI 源码查证，非脑补。

## 一、问题陈述

[工具分配方案](2026-07-31-tool-allocation-design.md) 已经明确了 31 个工具按 4 类子代理 + 主会话的归属。本文档回答下一个问题：**这些工具在 SDK 模式下具体怎么注册、怎么调用、签名要不要改？**

## 二、关键查证结果（认知校准）

查证 PI 源码纠正了若干可能的误解：

### 2.1 `defineTool` 和 `pi.registerTool` 的 execute 签名**完全一致**

**误解**：以为 SDK 模式下 `defineTool` 的 execute 只有 4 参数（无 ctx），需要重写所有工具。

**事实**（[types.ts:426-461](file:///d:/claude/pi-ex/pi-ex/packages/coding-agent/src/core/extensions/types.ts#L426-L461)）：

```typescript
// ToolDefinition 是 defineTool 和 pi.registerTool 共用的类型
export interface ToolDefinition<TParams, TDetails, TState> {
  // ...
  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    ctx: ExtensionContext,  // ← 第 5 个参数，两种模式都有
  ): Promise<AgentToolResult<TDetails>>;
}
```

`defineTool()` 只是 `ToolDefinition` 的类型守卫函数（[types.ts:484-488](file:///d:/claude/pi-ex/pi-ex/packages/coding-agent/src/core/extensions/types.ts#L484-L488)），不改变签名。

### 2.2 SDK 模式 `customTools` 与扩展注册工具走**同一条包装路径**

**误解**：以为 `customTools` 走独立路径，ctx 由 SDK 自己构造。

**事实**（[agent-session.ts:2283-2326](file:///d:/claude/pi-ex/pi-ex/packages/coding-agent/src/core/agent-session.ts#L2283-L2326)）：

```typescript
const registeredTools = this._extensionRunner.getAllRegisteredTools();
const allCustomTools = [
  ...registeredTools,
  ...this._customTools.map((definition) => ({
    definition,
    sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
  })),
];
// ...
const wrappedExtensionTools = wrapRegisteredTools(allCustomTools, runner);
```

`customTools` 和扩展注册工具合并到 `allCustomTools`，**统一走 `wrapRegisteredTools(allCustomTools, runner)`**，ctxFactory 都是 `() => runner.createContext()`。

### 2.3 SDK 模式下 ExtensionContext 由 ExtensionRunner.createContext() 构造

**事实**（[runner.ts:573-608](file:///d:/claude/pi-ex/pi-ex/packages/coding-agent/src/core/extensions/runner.ts#L573-L608)）：

```typescript
createContext(): ExtensionContext {
  return {
    get ui() { ... },
    get hasUI() { ... },
    get cwd() { ... },
    get sessionManager() { ... },
    get modelRegistry() { ... },  // ← narrative-engine 的 LLM caller 依赖此字段
    get model() { ... },           // ← narrative-engine 的 LLM caller 依赖此字段
    isIdle: () => { ... },
    get signal() { ... },
    // ...
  };
}
```

**SDK 模式下 ExtensionRunner 仍然存在**（DefaultResourceLoader 默认加载 `~/.pi/agent/extensions/` 和 `.pi/extensions/`，即使为空也构造 runner）。`ctx.model` 和 `ctx.modelRegistry.getApiKeyAndHeaders(...)` 在 SDK 模式下完全可用。

### 2.4 真正的差异在 `AgentTool`（子代理用），不在 `ToolDefinition`（主会话用）

**关键区分**：

| 接口 | 来源 | execute 签名 | 用途 |
|---|---|---|---|
| `ToolDefinition` | pi-coding-agent | 5 参数（含 ctx） | 主会话工具（`customTools` / `pi.registerTool`） |
| `AgentTool` | pi-agent-core | 4 参数（无 ctx） | 子代理工具（`Agent` 类的 `initialState.tools`） |

[types.ts:360-384](file:///d:/claude/pi-ex/pi-ex/packages/agent/src/types.ts#L360-L384) 的 `AgentTool.execute`：

```typescript
execute: (
  toolCallId: string,
  params: Static<TParameters>,
  signal?: AbortSignal,
  onUpdate?: AgentToolUpdateCallback<TDetails>,
) => Promise<AgentToolResult<TDetails>>;
// ← 无 ctx 参数
```

**结论**：
- **主会话工具迁移到 SDK 模式：execute 签名零改动**
- **子代理工具：需要从 `ToolDefinition` 重构为 `AgentTool`**（去掉 ctx，把 wg/embedder 等依赖通过闭包注入）

### 2.5 既存 bug 确认：4 路 LLM caller 签名错配

[renderer-llm.ts:22-26](file:///d:/claude/pi-ex/narrative-engine/src/renderer-llm.ts#L22-L26) 实际签名：

```typescript
export function makeRendererLlmCaller(
  model: string,
  apiKey: string,
  provider: string = "deepseek",
): RenderLlmCaller
```

[render-tools.ts:53](file:///d:/claude/pi-ex/narrative-engine/src/tools/render-tools.ts#L53) 调用：

```typescript
const llm = await makeRendererLlmCaller(piCtx);  // ← 单参数，签名错配
```

`piCtx`（对象）被当成 `model: string` 传入，`apiKey`/`provider` 为 undefined。esbuild transform-only 不做类型检查，运行时崩溃。

**这是迁移前必须先修的 bug**（SDK 集成架构文档 §2.4 已锁定）。修复方向：把签名改为 `(piCtx: ExtensionContext)`，从 `piCtx.model` 和 `piCtx.modelRegistry.getApiKeyAndHeaders(piCtx.model)` 取 model/apiKey。修复后的写法在 SDK 模式下直接可用。

## 三、主会话工具：两种迁移路径

### 3.1 路径 A：`extensionFactories` 内联扩展（最小改动）

**思路**：把现有 `src/index.ts` 的 default export 函数直接作为 `extensionFactory` 传入 `DefaultResourceLoader`，31 个工具的 `pi.registerTool` 调用完全不动。

```typescript
// src/app/main.ts（SDK 入口）
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import narrativeEngineExtension from "../index.ts";  // 现有扩展入口

const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  extensionFactories: [narrativeEngineExtension],  // ← 内联扩展
});
await loader.reload();

const { session } = await createAgentSession({
  resourceLoader: loader,
  sessionManager: SessionManager.create(process.cwd()),
});

session.subscribe((event) => { /* Web UI 事件映射 */ });
await session.prompt("...");
```

**优点**：
- 改动最小，31 个工具的 `registerXxxTools(pi, state)` 函数零修改
- `pi.on("session_start", ...)` / `pi.on("before_agent_start", ...)` / `pi.on("resources_discover", ...)` 等生命周期钩子全部保留
- `state` 模块级状态的初始化逻辑不动

**缺点**：
- 仍然依赖 ExtensionRunner 运行时（虽然 ExtensionRunner 在 SDK 模式下也存在，但概念上没脱离扩展模式）
- 工具的注册时序受扩展加载流程约束

### 3.2 路径 B：`defineTool` + `customTools`（彻底 SDK 化）

**思路**：把 6 个 `registerXxxTools(pi, state)` 函数改为返回 `ToolDefinition[]`，由 SDK 入口收集后传 `customTools`。生命周期钩子改为 `session.subscribe` 事件流。

```typescript
// src/tools/world-tools.ts（改造后）
import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export function createWorldTools(state: SessionState): ToolDefinition[] {
  return [
    defineTool({
      name: "world_status",
      label: "World Status",
      description: "...",
      parameters: Type.Object({}),
      async execute(_id, params, _signal, _onUpdate, ctx: ExtensionContext) {
        // ← 5 参数签名完全保留，ctx 仍然可用
        const g = requireWg(state);
        // ...
      },
    }),
    // ... 其余 17 个 world_* 工具
  ];
}
```

```typescript
// src/app/main.ts（SDK 入口）
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { createSessionState } from "../session-state.ts";
import { createWorldTools } from "../tools/world-tools.ts";
import { createRenderTools } from "../tools/render-tools.ts";
// ... 其他 4 个域

const state = createSessionState();
// 初始化 wg/embedder/search（原 session_start 逻辑改为同步初始化）
await initializeState(state, process.cwd());

const customTools = [
  ...createWorldTools(state),
  ...createRenderTools(state),
  ...createRoleTools(state),
  ...createSchedulerTools(state),
  ...createImportTools(state),
  ...createVisualizerTool(state),
];

const { session } = await createAgentSession({
  customTools,
  tools: customTools.map(t => t.name),  // 显式启用所有自定义工具
  sessionManager: SessionManager.create(process.cwd()),
});

// 原 before_agent_start 注入 memory.md → 改为 subscribe + prompt 前注入
// 原 resources_discover 贡献 skills → 改为 DefaultResourceLoader.skillsOverride
```

**优点**：
- 概念上彻底脱离扩展模式，工具就是工具，不混入扩展生命周期
- 工具注册时序明确（构造 customTools 数组时全部就绪）
- 便于后续按 Profile 预设切换工具子集

**缺点**：
- 改动量大：6 个 `registerXxxTools` 函数都要改返回类型，31 个工具的 `pi.registerTool({...})` 改为 `defineTool({...})` 并入数组
- 生命周期钩子（`session_start` / `before_agent_start` / `resources_discover` / `session_shutdown`）需要重新映射到 SDK 事件流或显式初始化函数
- `state` 的初始化时序需要重新设计（不能依赖 `session_start` 事件）

### 3.3 推荐：路径 A 先行，路径 B 后续

**推荐路径 A 作为第一步迁移**：
- 改动最小，风险最低
- 不破坏现有 31 个工具的代码
- 主会话层立即获得 SDK 模式的完整能力（SessionManager 持久化/恢复/分支等）

**路径 B 作为后续优化**：
- 当子代理编排器落地、主会话工具需要按 Profile 切换时再迁
- 那时 `role_interact` 等工具已退役，工具数减少，迁移成本降低

## 四、子代理工具：从 ToolDefinition 到 AgentTool

子代理用 `Agent` 类（pi-agent-core），其 `initialState.tools` 接收的是 `AgentTool[]`（4 参数 execute，无 ctx）。这是与主会话工具的本质差异。

### 4.1 包装策略

子代理工具不能直接复用主会话的 `ToolDefinition`，需要包装为 `AgentTool`：

```typescript
// src/agents/tools.ts（新增）
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { WorldGraph } from "@pi/world-graph";

/** 包装 world_entity_get 为子代理可用的 AgentTool（无 ctx，依赖闭包注入） */
export function createEntityGetTool(wg: WorldGraph): AgentTool {
  return {
    name: "world_entity_get",
    label: "World Entity Get",
    description: "获取实体快照",
    parameters: Type.Object({
      entityId: Type.String(),
      storyTime: Type.Optional(Type.String()),
    }),
    async execute(toolCallId, params, signal, onUpdate) {
      // ← 4 参数，无 ctx
      const snap = await wg.getEntityAt(params.entityId, params.storyTime);
      return {
        content: [{ type: "text", text: snap ? JSON.stringify(snap) : "未找到" }],
        details: { entityId: params.entityId, snapshot: snap },
      };
    },
  };
}
```

### 4.2 主会话工具与子代理工具的关系

| 维度 | 主会话工具 | 子代理工具 |
|---|---|---|
| 类型 | `ToolDefinition`（5 参数 execute） | `AgentTool`（4 参数 execute） |
| 注册方式 | `customTools` 或 `pi.registerTool` | `new Agent({ initialState: { tools } })` |
| 依赖注入 | `ctx: ExtensionContext`（运行时注入） | 闭包变量（构造时注入） |
| 来源 | 复用现有 31 个工具 | 新建 `src/agents/tools.ts`，按子代理定位裁剪 |

### 4.3 子代理工具实现要点

按 [工具分配方案](2026-07-31-tool-allocation-design.md) §五：

| 子代理 | 工具来源 | 实现策略 |
|---|---|---|
| planner | 复用 7 个 world_* 只读工具 | 包装为 AgentTool，wg 闭包注入 |
| 角色代理 | 4 个受限变体 | 包装为 AgentTool，wg 闭包注入 + characterId 锁定 + 可见性过滤 |
| 可见推理 | 复用 9 个 world_* 工具（含写入） | 包装为 AgentTool，wg 闭包注入 |
| 渲染器 | 直接调 `@pi/renderer` 底层 API | 不包装为 AgentTool，渲染器代理直接调 `readChapter/renderToFile` |

**关键约束**：
- 子代理工具的 `wg` / `embedder` / `search` 依赖在构造 Agent 实例时通过闭包注入，**不依赖 ExtensionContext**
- 这正是 [子代理编排器设计](2026-07-31-subagent-orchestrator-design.md) §3.1 的 `AgentRuntime` 接口的目的——`AgentRuntime` 提供 model/apiKey/streamFn，wg 等通过编排器闭包注入

## 五、既存 bug 修复（迁移前置条件）

按 SDK 集成架构文档 §2.4，4 路 LLM caller 签名错配必须先修。修复方向：

```typescript
// src/renderer-llm.ts（修复后）
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { complete, getModel } from "@earendil-works/pi-ai";

export async function makeRendererLlmCaller(
  piCtx: ExtensionContext,  // ← 改为单参数，接收 ExtensionContext
): Promise<RenderLlmCaller> {
  const model = piCtx.model;
  if (!model) throw new Error("未配置模型");
  const auth = await piCtx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(`API key 解析失败: ${auth.error}`);
  const apiKey = auth.apiKey;

  return async (systemPrompt: string, userMessage: string): Promise<string> => {
    const msg = await complete(model, { systemPrompt, messages: [...] }, { apiKey, maxTokens: 4000, temperature: 0.7 });
    // ...
  };
}
```

**修复后的写法在扩展模式和 SDK 模式下都直接可用**——因为两种模式下 `ExtensionContext.model` 和 `modelRegistry.getApiKeyAndHeaders` 都正常工作。

同理修复 `planner-llm.ts` / `role-pool-llm.ts` / `knowledge-mapper-llm.ts`（如果有相同 bug）。

## 六、PI 依赖面（最终收敛）

迁移到 SDK 模式后，narrative-engine 对 PI 的工具层依赖：

| 依赖项 | 来源 | 用途 | 主会话 | 子代理 |
|---|---|---|---|---|
| `defineTool` | pi-coding-agent | 工具类型守卫 | 路径 B 用 | 不用 |
| `ToolDefinition` | pi-coding-agent | 主会话工具类型 | 用 | 不用 |
| `AgentTool` | pi-agent-core | 子代理工具类型 | 不用 | 用 |
| `ExtensionContext` | pi-coding-agent | 主会话工具 ctx | 用（5 参数 execute 第 5 参数） | 不用 |
| `Type` / `StringEnum` | typebox / pi-ai | 工具 schema | 用 | 用 |
| `createAgentSession` / `SessionManager` | pi-coding-agent | 主会话生命周期 | 用 | 不用 |
| `Agent` 类 | pi-agent-core | 子代理运行时 | 不用 | 用 |
| `complete` / `getModel` | pi-ai | LLM 调用 | 间接（通过 LLM caller） | 间接（通过 AgentRuntime） |

**工具层的 PI 依赖面收敛**：主会话用 `ToolDefinition` + `ExtensionContext`，子代理用 `AgentTool` + 闭包注入。两者通过 `AgentRuntime` 接口解耦。

## 七、迁移工作量评估

### 7.1 路径 A（extensionFactories 内联扩展）

| 任务 | 工作量 | 风险 |
|---|---|---|
| 修复 4 路 LLM caller 签名错配 | 小（4 个文件改签名） | 低（修完跑现有测试验证） |
| 新建 `src/app/main.ts` SDK 入口 | 小（约 30 行） | 低（参考 SDK 文档 Quick Start） |
| 验证 `extensionFactories` 加载现有扩展 | 中（需测 session_start/before_agent_start/resources_discover 是否正常触发） | 中（这些钩子在 SDK 模式下的事件映射需验证） |
| 验证 Web UI 事件流 | 中（subscribe 事件映射到 Web UI） | 中（事件类型较多） |

### 7.2 路径 B（defineTool + customTools）

| 任务 | 工作量 | 风险 |
|---|---|---|
| 路径 A 的全部任务 | 同上 | 同上 |
| 6 个 `registerXxxTools` 改为 `createXxxTools` 返回数组 | 中（31 个工具改包装，但 execute 逻辑不动） | 低（机械改造） |
| 生命周期钩子重新映射 | 中（session_start 初始化逻辑改为显式调用，before_agent_start 改为 subscribe，resources_discover 改为 skillsOverride） | 中（时序需要重新设计） |
| `state` 初始化时序重设计 | 中（不能依赖 session_start 事件） | 中（wg/embedder/search 的构造时机） |

### 7.3 子代理工具实现（独立于路径 A/B）

| 任务 | 工作量 | 风险 |
|---|---|---|
| `src/agents/tools.ts` 新建 | 中（约 18 个 AgentTool 包装函数） | 低（机械包装） |
| 角色代理受限变体 | 中（4 个受限工具，需查 Search 类是否支持 visibility 过滤） | 中（[工具分配方案](2026-07-31-tool-allocation-design.md) §九.1 存疑） |
| 渲染器代理直接调 `@pi/renderer` | 小（参考现有 render-tools.ts 的 renderToFile 调用） | 低 |

## 八、存疑点（需原型验证）

### 8.1 路径 A 下生命周期钩子是否完整保留

**问题**：`extensionFactories` 内联扩展在 SDK 模式下，`pi.on("session_start", ...)` / `pi.on("before_agent_start", ...)` / `pi.on("resources_discover", ...)` 是否仍然按扩展模式的时序触发？

**影响**：narrative-engine 的 `state` 初始化、memory.md 注入、skills 目录贡献都依赖这些钩子。如果时序变化，需要重新设计。

**验证方式**：写最小 demo，`extensionFactories` 里注册 `session_start` / `before_agent_start` / `resources_discover` handler，`createAgentSession` 后 `session.prompt("...")`，观察 handler 是否触发。

### 8.2 路径 A 下 `pi.registerTool` 的 ctx 是否完整

**问题**：SDK 模式下 `extensionFactories` 注册的工具，调用时 `ctx.model` / `ctx.modelRegistry` 是否正常？

**影响**：render/role/scheduler 工具依赖 ctx.model 和 ctx.modelRegistry.getApiKeyAndHeaders。

**验证方式**：路径 A demo 里注册一个测试工具，execute 中打印 `ctx.model` 和 `ctx.modelRegistry`，确认非 undefined。

### 8.3 `before_agent_start` 在 SDK 模式下的 memory.md 注入

**问题**：SDK 集成架构文档 §7.1 提到"`createAgentSessionRuntime` 的 `systemPromptOverride` 是构造时一次性，memory.md 每轮动态更新需要原型验证"。路径 A 下 `before_agent_start` 是否保留每轮触发语义？

**影响**：memory.md 的每轮重读注入机制。

**验证方式**：路径 A demo 里 `before_agent_start` handler 打印时间戳，多次 `session.prompt()` 确认每轮触发。

### 8.4 子代理工具的 Search 类可见性过滤

**问题**：[工具分配方案](2026-07-31-tool-allocation-design.md) §九.1 的存疑——角色代理的 `query_limited` 受限变体，Search 类是否支持 visibility 过滤参数？

**验证方式**：查 `Search` 类源码签名，看 `search()` 方法是否接受 `characterId` 或 `visibilityFilter` 参数。如不支持，需要"先检索后过滤"的包装（有信息泄漏风险）。

## 九、与既有设计文档的关系

| 维度 | 本文档 | SDK 集成架构文档 | 工具分配方案 |
|---|---|---|---|
| 关注点 | 工具在 SDK 模式下怎么实现 | narrative-engine 如何与 PI SDK 集成 | 31 个工具按子代理怎么分 |
| 工具签名 | §二查证 defineTool vs registerTool vs AgentTool | 不涉及 | 不涉及 |
| 迁移路径 | §三提出路径 A/B + 推荐 | §九.1 提及"31 工具迁移要点"作为后续工作 | 不涉及 |
| 子代理工具实现 | §四提出包装策略 | 不涉及 | §五提出归属，未提实现 |
| 既存 bug | §2.5 确认源码 + §五修复方向 | §2.4 提及 bug 存在 | 不涉及 |

本文档填补了 SDK 集成架构文档 §九.1（"31 个工具从 `pi.registerTool` 到 `defineTool` + `customTools` 的迁移要点"）的实现细节，并把工具分配方案的归属落实到具体代码层面的迁移路径。

## 十、决策溯源

本文档的结论基于以下查证过程：

1. 读 PI SDK 文档（`coding-agent/docs/sdk.md`）确认 `createAgentSession` + `customTools` 是 SDK 模式工具注册路径
2. 读 PI 扩展文档（`coding-agent/docs/extensions.md`）对比 `pi.registerTool` 签名
3. 读 `ToolDefinition` 源码（`extensions/types.ts:426-461`）确认 `defineTool` 和 `pi.registerTool` 共用类型，execute 都是 5 参数
4. 读 `wrapToolDefinition` 源码（`tools/tool-definition-wrapper.ts`）确认 SDK customTools 和扩展注册工具走同一包装路径
5. 读 `agent-session.ts:2283-2326` 确认 `allCustomTools` 合并 customTools 和 registeredTools，统一 `wrapRegisteredTools(allCustomTools, runner)`
6. 读 `ExtensionRunner.createContext()`（`runner.ts:573-608`）确认 SDK 模式下 ExtensionContext 提供的能力与扩展模式一致
7. 读 `AgentTool` 源码（`agent/types.ts:360-384`）确认子代理工具是 4 参数 execute，与主会话工具差异在此
8. 读 narrative-engine 现有 `renderer-llm.ts` / `render-tools.ts` 确认既存 bug 真实存在
