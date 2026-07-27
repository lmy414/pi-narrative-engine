/**
 * debug.ts — 调度器调试事件总线接口与追踪器
 *
 * 设计：
 * - 子包内独立声明 DebugBus / DebugSpan 接口（不依赖外层 src/debug/）
 * - 外层 src/debug/bus.ts 的 createDebugBus 实现结构兼容此接口
 * - startSpan 在子包内实现，避免反向依赖
 *
 * 用法：
 * ```ts
 * const span = startSpan(ctx.debugBus, "plan.llm", traceId, { input: {...} });
 * try {
 *   const result = await fn();
 *   span?.end({ output: result });
 *   return result;
 * } catch (err) {
 *   span?.error(err);
 *   throw err;
 * }
 * ```
 */

/**
 * 调试事件（与外层 src/debug/types.ts 结构一致）
 * 子包内重新声明，避免循环依赖。
 */
export interface DebugEvent {
  id: string;
  ts: number;
  traceId: string;
  stage: string;
  status: "start" | "end" | "error";
  input?: unknown;
  output?: unknown;
  durationMs?: number;
  error?: string;
  parentId?: string;
}

/**
 * 调试事件总线接口
 * 实现由外层注入（src/debug/bus.ts#createDebugBus）。
 */
export interface DebugBus {
  emit(event: DebugEvent): void;
  subscribe(listener: (event: DebugEvent) => void): () => void;
  snapshot(): DebugEvent[];
  clear(): void;
}

/**
 * 阶段追踪器：配对 start/end/error 事件
 */
export interface DebugSpan {
  /** 本 span 的 start 事件 ID（用于子阶段的 parentId） */
  eventId: string;
  end(output?: unknown): void;
  error(err: unknown): void;
}

/** 自增 ID 生成器（进程内唯一，重启重置） */
let nextSpanId = 1;
function genEventId(): string {
  return `dbg_${Date.now().toString(36)}_${nextSpanId++}`;
}

/**
 * 启动一个阶段追踪器
 *
 * @param bus 调试总线（null/undefined 时返回 noop span，零开销）
 * @param stage 阶段名（点分路径，如 "plan.llm"）
 * @param traceId 调度链追踪 ID
 * @param input 阶段输入
 * @param parentId 父阶段事件 ID
 */
export function startSpan(
  bus: DebugBus | null | undefined,
  stage: string,
  traceId: string,
  input?: unknown,
  parentId?: string,
): DebugSpan {
  if (!bus) {
    return { eventId: "", end() {}, error() {} };
  }

  const eventId = genEventId();
  const startTs = Date.now();

  bus.emit({
    id: eventId,
    ts: startTs,
    traceId,
    stage,
    status: "start",
    input,
    parentId,
  });

  return {
    eventId,
    end(output?: unknown): void {
      bus.emit({
        id: genEventId(),
        ts: Date.now(),
        traceId,
        stage,
        status: "end",
        output,
        durationMs: Date.now() - startTs,
        parentId,
      });
    },
    error(err: unknown): void {
      const errMsg = err instanceof Error ? err.message : String(err);
      bus.emit({
        id: genEventId(),
        ts: Date.now(),
        traceId,
        stage,
        status: "error",
        error: errMsg,
        durationMs: Date.now() - startTs,
        parentId,
      });
    },
  };
}

/**
 * 生成新的 traceId（用于一次 dispatch/commit 的全链路追踪）
 */
export function newTraceId(): string {
  return `trace_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
