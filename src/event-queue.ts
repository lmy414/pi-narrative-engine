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

/**
 * 内存事件队列
 *
 * 单消费者：processing 标志防重入；worker 串行消费。
 */
export class EventQueue<TEvent = unknown, TResult = unknown> {
  private queue: QueuedEvent<TEvent, TResult>[] = [];
  private processing = false;
  private worker: QueueWorker<TEvent, TResult>;

  constructor(worker: QueueWorker<TEvent, TResult>) {
    this.worker = worker;
  }

  /** 入队，立即返回 queueId（不执行） */
  enqueue(event: TEvent): string {
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
    return this.queue.find((q) => q.queueId === queueId);
  }

  /** 查询全部 */
  getAll(): QueuedEvent<TEvent, TResult>[] {
    return this.queue.slice();
  }

  /** 队列长度（含所有状态） */
  get length(): number {
    return this.queue.length;
  }
}
