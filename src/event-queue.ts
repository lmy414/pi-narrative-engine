// src/event-queue.ts
/**
 * event-queue.ts — 事件队列 + 后台 worker
 *
 * 依据：docs/plans/2026-07-31-subagent-orchestrator-design.md §四
 *
 * 设计：
 * - 主会话入队即返回（不阻塞），拿到 queueId
 * - 后台 worker（单消费者）逐条取出执行，串行处理
 * - getStatus / getAll 供 scheduler_queue_status 查询
 *
 * 与 PI 解耦：队列不依赖 ExtensionContext；事件类型用自有 QueuedEvent。
 */

/** 队列事件状态 */
export type QueueStatus = "pending" | "running" | "done" | "error";

/** 队列项 */
export interface QueuedEvent<TEvent = unknown, TResult = unknown> {
  queueId: string;
  event: TEvent;
  status: QueueStatus;
  result?: TResult;
  error?: string;
  enqueuedAt: number;
  startedAt?: number;
  finishedAt?: number;
}

/** worker 执行函数：处理单条事件，返回结果 */
export type QueueWorker<TEvent = unknown, TResult = unknown> = (
  event: TEvent,
) => Promise<TResult>;

/** EventQueue 构造选项（🔴-4：容量与 TTL 防护） */
export interface EventQueueOptions {
  /** 队列容量上限（含所有状态），默认 200；超出时淘汰最旧已完成项，全未完成则入队抛错 */
  maxLength?: number;
  /** 已完成项保留时长 ms，默认 1h；enqueue/getStatus/getAll 时惰性清理过期项，0 表示不清理 */
  finishedTtlMs?: number;
}

/**
 * 内存事件队列
 *
 * 单消费者：processing 标志防重入；worker 串行消费。
 * 容量防护：maxLength 上限 + 已完成项 TTL 惰性清理，防止长时间运行队列无限增长。
 */
export class EventQueue<TEvent = unknown, TResult = unknown> {
  private queue: QueuedEvent<TEvent, TResult>[] = [];
  private processing = false;
  private worker: QueueWorker<TEvent, TResult>;
  private onDone?: (queueId: string, result: TResult) => void;
  private readonly maxLength: number;
  private readonly finishedTtlMs: number;

  constructor(
    worker: QueueWorker<TEvent, TResult>,
    onDone?: (queueId: string, result: TResult) => void,
    opts: EventQueueOptions = {},
  ) {
    this.worker = worker;
    this.onDone = onDone;
    this.maxLength = opts.maxLength ?? 200;
    this.finishedTtlMs = opts.finishedTtlMs ?? 3600_000;
  }

  /** 清理超过 TTL 的已完成项（惰性，每次查询/入队前调用） */
  private sweepFinished(): void {
    if (this.finishedTtlMs <= 0) return;
    const cutoff = Date.now() - this.finishedTtlMs;
    this.queue = this.queue.filter((q) => {
      if (q.status !== "done" && q.status !== "error") return true;
      return (q.finishedAt ?? 0) >= cutoff;
    });
  }

  /** 入队，立即返回 queueId（不执行） */
  enqueue(event: TEvent): string {
    this.sweepFinished();
    // 容量保护：先淘汰最旧已完成项腾出空间；全部未完成时拒绝入队
    while (this.queue.length >= this.maxLength) {
      const doneIdx = this.queue.findIndex(
        (q) => q.status === "done" || q.status === "error",
      );
      if (doneIdx === -1) {
        throw new Error(
          `EventQueue 已满（${this.maxLength} 条未完成，请等待处理）`,
        );
      }
      this.queue.splice(doneIdx, 1);
    }
    const queueId = `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.queue.push({
      queueId,
      event,
      status: "pending",
      enqueuedAt: Date.now(),
    });
    // 尝试启动 worker（若空闲）
    void this.pump();
    return queueId;
  }

  /** 取出队首 pending 事件（仅 worker 消费） */
  private dequeue(): QueuedEvent<TEvent, TResult> | undefined {
    const idx = this.queue.findIndex((q) => q.status === "pending");
    if (idx === -1) return undefined;
    const item = this.queue[idx];
    item.status = "running";
    item.startedAt = Date.now();
    return item;
  }

  /** 单消费者泵：处理完一条再取下一条 */
  private async pump(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (true) {
        const item = this.dequeue();
        if (!item) break;
        try {
          const result = await this.worker(item.event);
          item.status = "done";
          item.result = result;
          this.onDone?.(item.queueId, result);
        } catch (err) {
          item.status = "error";
          item.error = err instanceof Error ? err.message : String(err);
        } finally {
          item.finishedAt = Date.now();
        }
      }
    } finally {
      this.processing = false;
    }
  }

  /** 查询单条状态 */
  getStatus(queueId: string): QueuedEvent<TEvent, TResult> | undefined {
    this.sweepFinished();
    return this.queue.find((q) => q.queueId === queueId);
  }

  /** 查询全部 */
  getAll(): QueuedEvent<TEvent, TResult>[] {
    this.sweepFinished();
    return this.queue.slice();
  }

  /** 队列长度（含所有状态，含已完成未清理项） */
  get length(): number {
    return this.queue.length;
  }

  /** 活跃任务数（pending + running）— 前端状态栏应使用此字段而非 length */
  get activeCount(): number {
    return this.queue.filter(
      (q) => q.status === "pending" || q.status === "running",
    ).length;
  }
}
