# 调试模块（DebugBus）

> 属于 [API 文档索引](README.md)。2026-07-27 新增。提供调度链实时可视化能力：每次 `scheduler_dispatch` / `scheduler_commit` 的内部阶段（plan → retrieve → role.turn × N → commit.step.4 × N → ...）以 DAG 形式推送到前端调试 tab。

## 设计目标

- **默认开启**：当前 `createDebugBus` 在 `src/app/main.ts` 中无条件调用，`debugBus` 始终为实例；`PI_DEBUG` 环境变量保留但代码层面未读取（仅作为 .env 白名单字段供前端展示），不影响 span 埋点与事件输出
- **零侵入**：调度器/角色池/可视化器通过 `startSpan(bus, ...)` 钩子发射事件，bus 未注入时短路
- **环形缓冲**：扩展侧容量 2000（`createDebugBus(2000)`），超出按 FIFO 淘汰（防止内存膨胀）；工厂默认容量 1000
- **SSE 实时推送**：前端订阅 `/api/debug/stream` 后先收历史快照再收实时事件，按 `traceId` 聚合重建 DAG

## 模块结构

| 文件 | 职责 |
|------|------|
| `src/debug/types.ts` | `DebugEvent` / `DebugBus` / `DebugSpan` 接口定义 |
| `src/debug/bus.ts` | `createDebugBus(capacity?)` 工厂：环形缓冲 + 订阅列表 + `startSpan` / `newTraceId` |
| `src/debug/sse.ts` | SSE 端点处理：`handleDebugStream` / `handleDebugEvents` / `handleDebugClear` |
| `src/agents/reasoning-agent.ts` | 可见推理代理（吸收原 `src/knowledge-mapper-llm.ts` 职责：`knowledge_gained` → `declarationId` 映射），独立于调试模块但同期引入 |
| `packages/scheduler/src/debug.ts` | 调度器侧 `startSpan` 配对 start/end 事件 |
| `frontend-demo/views/debug.js` | 前端调试 tab：SSE 客户端 + DAG SVG + 节点详情抽屉 |

## `DebugEvent` 结构

```typescript
interface DebugEvent {
  id: string;            // 事件唯一 ID（前端去重）
  ts: number;            // 毫秒时间戳
  traceId: string;       // 调度链追踪 ID（同一次 dispatch/commit 共享）
  stage: string;         // 点分路径，如 "commit.step.4" / "role.turn" / "plan.llm"
  status: "start" | "end" | "error";
  input?: unknown;       // 阶段输入（开始时携带）
  output?: unknown;      // 阶段输出（结束时携带）
  durationMs?: number;   // 执行时长（仅 end/error）
  error?: string;        // 错误信息（仅 error）
  parentId?: string;     // 父阶段事件 ID（DAG 边构建）
}
```

## `startSpan` API（调度器侧）

```typescript
// packages/scheduler/src/debug.ts
function startSpan(
  bus: DebugBus | null | undefined,
  stage: string,
  traceId: string,
  input?: unknown,
  parentId?: string,
): { eventId: string; end(output?: unknown): void; error(err: unknown): void };
```

用法：try/finally 配对 start/end。`bus` 为 null/undefined 时返回 dummy span，`end`/`error` 为 no-op——保证未注入调试总线时零开销。

调度器在以下位置发射事件（非穷举）：
- `dispatch` / `plan.llm` / `retrieve.item`
- `role.turn`（由 `InteractHooks` 钩子触发，详见 [role-pool.md](role-pool.md)）
- `commit` / `commit.step.4`（per entityId）/ `commit.step.4.4` / `commit.step.5` / `commit.step.7`

## 注入点（`src/app/main.ts`）

`debugBus` 在 `startUnifiedServer` 启动前于 `src/app/main.ts` 中创建（无容量参数 → 走工厂默认 1000），并下发到两个消费方：

```typescript
// src/app/main.ts（startUnifiedServer 启动前创建）
const debugBus = createDebugBus();

// 1) 注入 ChatContext（驱动 /api/chat/* 的 chat.message span 埋点）
const chatContext = new ChatContext({ ..., debugBus });

// 2) 注入 startUnifiedServer（暴露 /api/debug/* 端点 + 透传给 OrchestratorService）
const server = await startUnifiedServer({ ..., debugBus });
```

`chat.message` span 在 `src/app/routes-chat.ts` 中由 `startSpan(ctx.debugBus, "chat.message", newTraceId(), ...)` 发射；编排四阶段（planner / role / reasoner / renderer）的 span 由 `OrchestratorService`（`src/orchestrator.ts`，构造时接受 `debugBus` 选项）经 `startSpan(bus, stage, traceId, ...)` 钩子发射。`bus` 为 null/undefined 时 `startSpan` 返回 dummy span，`end`/`error` 为 no-op，保证未注入时零开销。

## 环境变量

| 变量 | 默认 | 行为 |
|------|------|------|
| `PI_DEBUG` | 未设 | 环境变量保留但代码层面未读取；`debugBus` 在 `src/app/main.ts` 无条件创建（`createDebugBus()`），`/api/debug/*` 始终启用。`DEBUG_UNAVAILABLE` 仅在 standalone visualizer 未注入 debugBus 时出现 |

## 测试

```bash
# DebugBus 环形缓冲与订阅
npx tsx --test tests/debug/bus.test.ts

# SSE 端点（handleDebugStream / handleDebugEvents / handleDebugClear）
npx tsx --test tests/debug/sse.test.ts

# 调度器侧 startSpan 钩子注入
npx tsx --test packages/scheduler/tests/debug.test.ts
```
