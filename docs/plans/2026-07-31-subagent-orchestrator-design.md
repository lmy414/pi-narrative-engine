# 子代理编排器设计

> 日期：2026-07-31
> 状态：设计确认，待实现
> 关联：`docs/plans/2026-07-25-scheduler-design.md`（原调度器设计）

## 一、背景与问题

### 1.1 现状："视线模式"

当前调度器 `plan.ts` 是硬编码的 10 步线性流水线，每个 LLM 环节都是**无状态单次 `complete()` 调用**：

```
plan() → plannerLlm(单次) → 逐项检索(代码for循环) → roleLlm(单次) → commit(硬编码步骤)
```

问题：
- **planner LLM** 只能一次性返回 RetrievalPlan，不能自己查 world-graph 后修正计划
- **role LLM** 只能接收组装好的上下文返回结构化输出，不能自主查世界状态、不能多轮推理
- **renderer LLM** 只能接收文本渲染，不能读章节上下文衔接
- 整个编排是"外部 for 循环 + 单次 LLM 调用"，LLM 是被动函数，不是自主代理

### 1.2 目标

把每个 LLM 环节改造为**真正的子代理**——有 agent loop、能自主调用工具、能多轮推理，同时保留编排器的编排职责。

### 1.3 与 PI 解耦

子代理机制基于 `@earendil-works/pi-agent-core`（通用 agent 运行时）和 `@earendil-works/pi-ai`（LLM 调用抽象层），**不直接依赖 PI 本体**（`@earendil-works/pi-coding-agent`）。

- `pi-agent-core` 的 `Agent` 类只依赖 `pi-ai`，不需要 `ExtensionContext`
- narrative-engine 定义 `AgentRuntime` 接口抽象 model/apiKey/streamFn 来源
- PI 适配器实现 `AgentRuntime`，从 `ExtensionContext` 获取 model 和 apiKey
- 未来离开 PI 时，只需替换适配器，子代理机制可被其他工具复用

## 二、架构概览

### 2.1 分层

```
主会话 (PI)
  │  scheduler_dispatch(event)  ← 唯一入口，入队即返回
  ▼
┌─────────────────────────────────────────┐
│  事件队列 (EventQueue) — 内存队列        │
│  · 主会话入队即返回（不阻塞）              │
│  · 后台 worker 逐条取出执行               │
└──────────────┬──────────────────────────┘
               ▼
┌─────────────────────────────────────────┐
│  编排器 (Orchestrator) — 纯代码，非 LLM   │
│  1. 从队列取事件                          │
│  2. 启动 planner 子代理                   │
│  3. 启动角色代理（串行/并行，按可见性）     │
│  4. 启动可见推理代理                      │
│  5. 启动渲染器代理                        │
│  6. 汇总结果，通知主会话                   │
└──┬────────┬──────────┬───────────┬──────┘
   ▼        ▼          ▼           ▼
 planner  角色代理A/B  可见推理    渲染器
 Agent    Agent       Agent      Agent
```

### 2.2 数据流

```
事件出队
  → planner 子代理：查 world-graph → 输出检索计划 + 可见性分配 + 执行模式建议
  → 角色代理（按可见性约束）：查 world-graph → 多轮推理 → 输出角色行为
  → 可见推理代理：消费角色产出 → 推理扩散 → 写 world-graph
  → 渲染器代理：消费角色产出 + 扩散结果 → 读章节上下文 → 写正文
  → 结果推送主会话
```

## 三、子代理设计

### 3.1 通用构造

所有子代理复用 `@earendil-works/pi-agent-core` 的 `Agent` 类，通过 `AgentRuntime` 接口获取运行时依赖：

```typescript
// AgentRuntime — 解耦接口，不依赖 PI
interface AgentRuntime {
  model: Model<any>;
  streamFn: StreamFn;
  getApiKey: (provider: string) => Promise<string | undefined>;
}

// PI 适配器实现
function createPiAgentRuntime(ctx: ExtensionContext): AgentRuntime {
  return {
    model: ctx.model,
    streamFn: streamSimple,
    getApiKey: async (provider) => {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
      return auth.ok ? auth.apiKey : undefined;
    },
  };
}

// 子代理工厂只依赖 AgentRuntime，不依赖 ExtensionContext
function createPlannerAgent(rt: AgentRuntime, tools: AgentTool[], messages: AgentMessage[]) {
  return new Agent({
    initialState: { tools, messages },
    streamFn: rt.streamFn,
    getApiKey: rt.getApiKey,
    // ...
  });
}
```

`AgentRuntime` 是解耦的核心边界：PI 适配器从 `ExtensionContext` 构造它，未来其他平台只需提供自己的 `AgentRuntime` 实现。

### 3.2 planner 子代理

| 维度 | 说明 |
|------|------|
| 职责 | 查 world-graph 了解现状 → 决定检索策略 + 可见性分配 + 执行模式建议 |
| 工具 | `wg.getCharacterView` / `wg.getEntityAt` / `wg.getRelations` / `wg.search.*` |
| 输入 | 事件指令 + 参与角色 + storyTime |
| 输出 | 检索计划（哪些角色看哪些信息）+ 串行/并行建议 |
| 与现状区别 | planner 可先查 world-graph 看看有什么，再决定检索策略，而非盲猜 |

输出约定：通过 tool call 返回结构化检索计划（与现有 `retrievalPlanSchema` 兼容，新增 `executionMode` 字段标注串行/并行建议）。

### 3.3 角色代理

| 维度 | 说明 |
|------|------|
| 粒度 | 每个角色一个 Agent 实例 |
| 职责 | 基于身份定位 + 可见知识，进行角色交互扮演 |
| 工具 | world-graph 查询（**受可见性约束**——编排器注入角色可见范围） |
| 输入 | 角色卡（staticCard）+ planner 分配的可见知识 |
| 输出 | action / thought / emotion / state_changes / knowledge_gained |
| 自主性 | 可主动查 world-graph 补充信息，多轮推理角色行为 |
| 生命周期 | **无状态、用完即弃**——每次事件创建新 Agent 实例，事件处理完销毁。不持有跨事件状态，每次完成队列任务后清空上下文。无需 `transformContext` 裁剪。 |

可见性约束：编排器根据 planner 的可见性分配，为每个角色构造**受限的 world-graph 查询工具**——只返回该角色可见的 Fact。

执行模式：
- **串行**：角色间有直接交互（对话、对抗、协作）——编排器将上一个角色的输出直接注入为下一个角色 Agent 的输入消息，保证一次事件内各角色交互全程可见
- **并行**：角色独立行动——互相不可见
- **决策来源**：planner 子代理建议 + 编排器裁定

### 3.4 可见推理代理

| 维度 | 说明 |
|------|------|
| 职责 | 消费所有角色产出 → 推理状态扩散 → 写入 world-graph |
| 工具 | `wg.addEvent` / `wg.setVisibility` / `wg.updateRelation` / `wg.getEntityAt` |
| 输入 | 所有角色产出 + 当前 world-graph 状态 |
| 输出 | appliedEventIds + visibilityChanges |
| 与现状区别 | 原 commit.ts 硬编码写扩散步骤 → Agent 自主推理决定写什么 |

吸收原 `knowledge-mapper-llm.ts` 的职责：knowledge_gained → declarationId 映射不再单独一步，由可见推理 Agent 在推理过程中完成。

### 3.5 渲染器代理

| 维度 | 说明 |
|------|------|
| 职责 | 渲染正文 |
| 工具 | `readChapter` / `writeChapter`（章节文件 IO） |
| 输入 | 角色产出 + 扩散结果 |
| 输出 | 正文文本 → 写入章节文件 |
| 自主性 | 可读已有章节衔接上下文，决定渲染策略 |

## 四、队列机制

### 4.1 内存队列

```typescript
interface QueuedEvent {
  queueId: string;
  event: StructuredEvent;
  status: "pending" | "running" | "done" | "error";
  result?: DispatchOutput;
  error?: string;
  enqueuedAt: number;
}

class EventQueue {
  private queue: QueuedEvent[] = [];
  private processing = false;

  enqueue(event: StructuredEvent): string { ... }
  dequeue(): QueuedEvent | undefined { ... }
  getStatus(queueId: string): QueuedEvent | undefined { ... }
  getAll(): QueuedEvent[] { ... }
}
```

- 主会话调用 `scheduler_dispatch` → 入队 → 立即返回 `queueId`
- 后台 worker（单消费者）逐条取出执行
- 处理完毕后通过 `ExtensionAPI.appendEntry()` 推送结果给主会话

### 4.2 worker 生命周期

- 在扩展 `session_start` 事件中启动 worker
- 在 `session_end` 事件中停止 worker
- worker 每次取一条事件，调用 `orchestrator.run(event)` 执行完整链路

### 4.3 队列查询

新增 `scheduler_queue_status` 工具，主会话可查询：
- 队列长度
- 各事件状态（pending / running / done / error）
- 当前处理中的事件摘要

## 五、plan / yolo 模式

保留现有双模式：

- **plan 模式**：跑到角色代理产出即停，缓存结果，等主会话调 `scheduler_commit` 后再启动可见推理 + 渲染
- **yolo 模式**：全链路自动跑完（planner → 角色 → 可见推理 → 渲染）

## 六、可见性控制机制

```
planner 输出可见性分配
  → 编排器为每个角色构造受限工具：
     character_view(entityId, storyTime) → 只返回该角色可见的 Fact
     search_*(query) → 只返回该角色可见的结果
  → 注入到角色 Agent 的 initialState.tools
  → 角色代理在 agent loop 中只能看到编排器允许的信息
```

这比原来的"planner 决定 assignTo → 编排器组装 dynamicFacts"更自然：
- 角色代理能主动查（不是被动接收组装好的列表）
- 也能被限制看不到不该看的信息（工具层面约束）

## 七、改造映射

| 现有模块 | 改造方向 |
|---------|---------|
| `packages/scheduler/src/plan.ts` 10 步流水线 | 拆分为 Orchestrator + 子代理工厂 |
| `src/planner-llm.ts` 单次 complete | → `src/agents/planner-agent.ts`（Agent + 工具注入） |
| `src/role-pool-llm.ts` 单次 complete | → `src/agents/role-agent.ts`（每角色一个 Agent） |
| `src/renderer-llm.ts` 单次 complete | → `src/agents/renderer-agent.ts` |
| `src/knowledge-mapper-llm.ts` | → 并入可见推理 Agent |
| `packages/scheduler/src/commit.ts` 硬编码写扩散 | → `src/agents/reasoning-agent.ts`（自主推理写入） |
| `src/scheduler-llm.ts` makeSchedulerCtx | → `src/orchestrator.ts`（子代理工厂 + 队列 + worker） |
| `src/tools/scheduler-tools.ts` | → dispatch 改为入队；新增 queue_status 工具 |
| `packages/scheduler/src/retrieve.ts` | 保留，包装为 AgentTool |
| world-graph / cache / debug bus | 完整保留 |

## 八、新增文件结构

```
src/
├── orchestrator.ts              # 编排器核心：队列消费 + 子代理调度 + 结果汇总
├── event-queue.ts               # 内存队列 + worker 循环
├── agents/
│   ├── agent-runtime.ts          # AgentRuntime 接口定义（解耦边界）
│   ├── pi-adapter.ts            # PI 适配器：从 ExtensionContext 构造 AgentRuntime
│   ├── planner-agent.ts          # planner 子代理工厂
│   ├── role-agent.ts            # 角色代理工厂（可见性约束 + 角色卡注入）
│   ├── reasoning-agent.ts       # 可见推理代理工厂（写扩散工具注入）
│   ├── renderer-agent.ts        # 渲染器代理工厂（章节 IO 工具注入）
│   └── tools.ts                 # world-graph 查询/写入包装为 AgentTool
```

### 8.1 解耦层说明

```
PI ExtensionContext ──→ pi-adapter.ts ──→ AgentRuntime 接口
                                            │
                    ┌───────────────────────┘
                    ▼
    orchestrator.ts + agents/*.ts
    （只依赖 AgentRuntime，不依赖 ExtensionContext）
```

- `agent-runtime.ts`：定义 `AgentRuntime` 接口（model / streamFn / getApiKey）
- `pi-adapter.ts`：唯一与 PI 耦合的文件，从 `ExtensionContext` 构造 `AgentRuntime`
- 其他所有 agent 文件只依赖 `AgentRuntime` 接口
- 未来替换平台时，只需新建 `xxx-adapter.ts`，agent 代码零修改

## 九、依赖变更

`package.json` devDependencies 新增：
```json
"@earendil-works/pi-agent-core": "^0.77.0"
```

当前全局已 link 0.77.0，需在项目锁文件中显式声明。

`@earendil-works/pi-coding-agent` 保留在 devDependencies（扩展加载、工具注册仍需要），但子代理代码层不直接 import 它——只通过 `pi-adapter.ts` 间接使用 `ExtensionContext` 类型。

## 十、测试策略

### 10.1 单元测试

- **EventQueue**：入队/出队/状态查询/并发安全
- **agents/tools.ts**：world-graph 包装为 AgentTool 的参数校验和返回格式
- **各 agent 工厂**：mock streamFn 验证 agent loop 行为（工具调用 → 结果注入 → 终止）
- **Orchestrator**：mock 子代理工厂，验证串行/并行调度顺序、可见性注入、结果汇总

### 10.2 集成测试

- **plan 模式端到端**：事件入队 → planner → 角色 → 停止 → 主会话确认 → commit → 渲染
- **yolo 模式端到端**：事件入队 → 全链路 → 结果推送
- **队列并发**：多个事件入队，验证逐条处理 + 状态隔离

### 10.3 回归

- 现有 `tests/e2e.test.ts` 和 `packages/scheduler/tests/planner-llm.test.ts` 需适配新接口

## 十一、存疑与待验证项

1. **Agent 终止条件**：`shouldStopAfterTurn` 的具体判断逻辑——如何检测子代理已产出结构化输出（tool call 返回？特定消息类型？）需在实现时查证 `AgentEvent` 类型
2. **结果推送机制**：`ExtensionAPI.appendEntry()` 的确切签名和消息格式需查证，确认能向主会话注入可读消息
3. **串行模式下角色间信息传递**（已决策）：直接注入上下文——编排器将上一个角色的输出作为下一个角色 Agent 的输入消息，保证一次事件内各角色交互全程可见。不通过工具查询，避免角色代理需要主动拉取前序角色产出。
4. **agent loop 性能**：多轮 tool call 可能比单次 complete 慢，需评估 DeepSeek 模型的响应延迟是否可接受
5. **上下文窗口管理**（已决策）：角色代理无状态、用完即弃——每次事件创建新 Agent 实例，事件处理完销毁，不持有跨事件状态。无需 `transformContext` 裁剪。
