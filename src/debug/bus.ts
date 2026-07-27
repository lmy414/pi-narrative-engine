/**
 * bus.ts — 调试事件总线实现
 *
 * 设计：
 * - 自管理订阅者列表（不用 EventEmitter，因为后者同步调用 listener 时抛错会中断后续）
 * - 环形缓冲（FIFO）：保留最近 N 条事件，避免内存无限增长
 * - start() 工厂方法返回 DebugSpan，自动配对 start/end 事件并计算 durationMs
 *
 * 性能：
 * - emit 同步执行（订阅者同步消费），避免微任务调度开销
 * - 未注入 bus 时调用方应使用 noopBus（零开销）
 *
 * 线程安全：
 * - Node 单线程，无需锁；订阅者中若抛错会被 catch 吞掉（不影响其他订阅者）
 */
import type { DebugBus, DebugEvent, DebugSpan } from "./types.ts";

/** 默认环形缓冲容量 */
const DEFAULT_CAPACITY = 1000;

/** 自增 ID 生成器（进程内唯一，重启重置） */
let nextEventId = 1;
function genEventId(): string {
  return `dbg_${Date.now().toString(36)}_${nextEventId++}`;
}

type Listener = (event: DebugEvent) => void;

/**
 * 创建调试事件总线
 *
 * @param capacity 环形缓冲容量，缺省 1000
 */
export function createDebugBus(capacity: number = DEFAULT_CAPACITY): DebugBus {
  // 自管理订阅者列表：每个 listener 在 try/catch 中独立调用，单个抛错不影响其他
  const listeners = new Set<Listener>();
  // 环形缓冲：用数组 + 头指针实现 FIFO
  const buffer: DebugEvent[] = [];
  let head = 0; // 下一个写入位置
  let count = 0; // 当前元素数（<= capacity）

  function emit(event: DebugEvent): void {
    // 写入环形缓冲
    if (buffer.length < capacity) {
      buffer.push(event);
      count++;
    } else {
      buffer[head] = event;
      head = (head + 1) % capacity;
      count = Math.min(count + 1, capacity);
    }
    // 通知订阅者（每个独立 try/catch，单个抛错不阻断其他）
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // 单个订阅者异常不影响总线和其他订阅者
      }
    }
  }

  function snapshot(): DebugEvent[] {
    // 环形未满时直接返回副本
    if (buffer.length < capacity) {
      return [...buffer];
    }
    // 环形已满：从 head 开始读取 capacity 条
    const result: DebugEvent[] = [];
    for (let i = 0; i < count; i++) {
      result.push(buffer[(head + i) % capacity]);
    }
    return result;
  }

  function clear(): void {
    buffer.length = 0;
    head = 0;
    count = 0;
  }

  function subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return { emit, subscribe, snapshot, clear };
}

/**
 * 启动一个阶段追踪器（自动配对 start/end/error 事件）
 *
 * @param bus 调试总线（null 时返回 noop span）
 * @param stage 阶段名（点分路径）
 * @param traceId 调度链追踪 ID
 * @param input 阶段输入
 * @param parentId 父阶段事件 ID（用于 DAG 边构建）
 */
export function startSpan(
  bus: DebugBus | null | undefined,
  stage: string,
  traceId: string,
  input?: unknown,
  parentId?: string,
): DebugSpan & { eventId: string } {
  if (!bus) {
    // noop span：未注入 bus 时零开销
    return {
      eventId: "",
      end() {},
      error() {},
    };
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
