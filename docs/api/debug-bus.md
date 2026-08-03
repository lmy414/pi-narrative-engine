# 调试模块（DebugBus）

> 属于 [API 文档索引](README.md)。2026-07-27 新增。提供调度链实时可视化能力：每次 `scheduler_dispatch` / `scheduler_commit` 的内部阶段（plan → retrieve → role.turn × N → commit.step.4 × N → ...）以 DAG 形式推送到前端调试 tab。

## 设计目标

- **零开销可关闭**：`PI_DEBUG=off` 环境变量禁用，`debugBus` 为 `null`，所有 `startSpan` 调用为 no-op
- **零侵入**：调度器/角色池/可视化器通过 `startSpan(bus, ...)` 钩子发射事件，bus 未注入时短路
- **环形缓冲**：扩展侧容量 2000（`createDebugBus(2000)`），超出按 FIFO 淘汰（防止内存膨胀）；工厂默认容量 1000
- **SSE 实时推送**：前端订阅 `/api/debug/stream` 后先收历史快照再收实时事件，按 `traceId` 聚合重建 DAG

## 模块结构

| 文件 | 职责 |
|------|------|
| `src/debug/types.ts` | `DebugEvent` / `DebugBus` / `DebugSpan` 接口定义 |
| `src/debug/bus.ts` | `createDebugBus(capacity?)` 工厂：环形缓冲 + 订阅列表 + `startSpan` / `newTraceId` |
| `src/debug/sse.ts` | SSE 端点处理：`handleDebugStream` / `handleDebugEvents` / `handleDebugClear` |
| `src/knowledge-mapper-llm.ts` | P0-3+6 修复的 LLM 映射器（`knowledge_gained` → `declarationId`），独立于调试模块但同期引入 |
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

## 注入点（`src/index.ts`）

```typescript
// session_start 时创建单例（容量 2000）
debugBus = process.env.PI_DEBUG === "off" ? null : createDebugBus(2000);

// 注入 SchedulerCtx（供 plan/commit 发射事件）
const ctx = await makeSchedulerCtx(g, emb, cwd, piCtx, state.debugBus ?? undefined);

// 注入 startVisualizer（暴露 /api/debug/* 端点）
startVisualizer({ ..., ...(debugBus ? { debugBus } : {}) });

// session_shutdown 时置 null
debugBus = null;
```

## 环境变量

| 变量 | 默认 | 行为 |
|------|------|------|
| `PI_DEBUG` | 未设（启用） | `off` 时禁用调试总线（`debugBus = null`，所有 `/api/debug/*` 返回 503 `DEBUG_UNAVAILABLE`） |

## 测试

```bash
# DebugBus 环形缓冲与订阅
npx tsx --test tests/debug/bus.test.ts

# SSE 端点（handleDebugStream / handleDebugEvents / handleDebugClear）
npx tsx --test tests/debug/sse.test.ts

# 调度器侧 startSpan 钩子注入
npx tsx --test packages/scheduler/tests/debug.test.ts
```
