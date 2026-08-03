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
import { mkdir, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  DebugBus,
  DebugEvent,
  DebugEventSink,
  DebugSpan,
  DrainableDebugBus,
} from "./types.ts";

/** 默认环形缓冲容量 */
const DEFAULT_CAPACITY = 1000;
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_ROTATED_FILES = 5;

type Listener = (event: DebugEvent) => void;

/**
 * 创建调试事件总线
 *
 * @param capacity 环形缓冲容量，缺省 1000
 */
export function createDebugBus(capacity: number = DEFAULT_CAPACITY): DebugBus {
  // L-BE-2：事件 ID 序号移入实例闭包（此前模块级全局，多实例共享）
  let seq = 0;
  function genEventId(): string {
    return `dbg_${Date.now().toString(36)}_${++seq}`;
  }

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

  return { emit, subscribe, snapshot, clear, genEventId };
}

/**
 * 将全局内存 bus 与固定项目 sink 组合。emit 的内存/订阅者部分仍同步完成，
 * 持久化在独立串行队列中执行，任何失败只告警。
 */
export function createProjectDebugBus(
  globalBus: DebugBus,
  sink: DebugEventSink,
  warn: (message: string, error: unknown) => void = (message, error) => console.warn(message, error),
): DrainableDebugBus {
  let queue = Promise.resolve();

  return {
    emit(event): void {
      globalBus.emit(event);
      queue = queue
        .then(() => sink.write(event))
        .catch((error) => warn("[debug] 写入项目日志失败", error));
    },
    subscribe: (listener) => globalBus.subscribe(listener),
    snapshot: () => globalBus.snapshot(),
    clear: () => globalBus.clear(),
    genEventId: () => globalBus.genEventId(),
    drain: () => queue,
  };
}

export interface DebugJsonlSinkOptions {
  maxFileBytes?: number;
  maxRotatedFiles?: number;
  now?: () => Date;
  warn?: (message: string, error: unknown) => void;
}

/** 创建写入固定项目 `<cwd>/.pi/logs/debug.jsonl` 的异步 sink。 */
export function createDebugJsonlSink(
  cwd: string,
  options: DebugJsonlSinkOptions = {},
): DebugEventSink {
  const logsDir = join(cwd, ".pi", "logs");
  const activePath = join(logsDir, "debug.jsonl");
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxRotatedFiles = options.maxRotatedFiles ?? DEFAULT_MAX_ROTATED_FILES;
  const now = options.now ?? (() => new Date());
  const warn = options.warn ?? ((message: string, error: unknown) => console.warn(message, error));

  return {
    async write(event): Promise<void> {
      await mkdir(logsDir, { recursive: true });
      if (await fileSizeAtLeast(activePath, maxFileBytes)) {
        await rotateDebugLog(logsDir, activePath, now());
        await pruneRotatedLogs(logsDir, maxRotatedFiles, warn);
      }
      await writeFile(activePath, `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "a" });
    },
  };
}

async function fileSizeAtLeast(path: string, threshold: number): Promise<boolean> {
  try {
    return (await stat(path)).size >= threshold;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function rotateDebugLog(logsDir: string, activePath: string, date: Date): Promise<void> {
  let candidateDate = date;
  while (true) {
    const rotatedPath = join(logsDir, `debug-${formatRotationTimestamp(candidateDate)}.jsonl`);
    if (await pathExists(rotatedPath)) {
      candidateDate = new Date(candidateDate.getTime() + 1000);
      continue;
    }
    try {
      await rename(activePath, rotatedPath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      candidateDate = new Date(candidateDate.getTime() + 1000);
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function pruneRotatedLogs(
  logsDir: string,
  maxFiles: number,
  warn: (message: string, error: unknown) => void,
): Promise<void> {
  let rotated: string[];
  try {
    rotated = (await readdir(logsDir))
      .filter((name) => /^debug-\d{8}-\d{6}\.jsonl$/.test(name))
      .sort();
  } catch (error) {
    warn("[debug] 扫描轮转日志失败", error);
    return;
  }
  for (const name of rotated.slice(0, Math.max(0, rotated.length - maxFiles))) {
    try {
      await unlink(join(logsDir, name));
    } catch (error) {
      warn(`[debug] 清理轮转日志失败: ${name}`, error);
    }
  }
}

function formatRotationTimestamp(date: Date): string {
  const part = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${part(date.getMonth() + 1)}${part(date.getDate())}`
    + `-${part(date.getHours())}${part(date.getMinutes())}${part(date.getSeconds())}`;
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

  const eventId = bus.genEventId();
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
        id: bus.genEventId(),
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
        id: bus.genEventId(),
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
