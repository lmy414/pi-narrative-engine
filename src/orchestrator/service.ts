// src/orchestrator/service.ts
/**
 * service.ts — OrchestratorService 薄服务层
 *
 * 依据：docs/plans/2026-07-31-orchestrator-standalone-research.md §5.2 +
 *       docs/plans/2026-08-01-data-layer-ports-execution-plan.md §四 A2/A3
 *
 * 职责：
 * - dispatch(event)：入队即返回 queueId（plan 模式返回 planId；yolo 模式全链路跑完）
 * - commit(planId)：plan 模式后半链路触发器（可见推理写世界图 + 渲染器写章节 + 更新记忆）
 * - discard(planId)：丢弃 plan
 * - queueStatus()：队列状态查询（对应 scheduler_queue_status 工具）
 *
 * plans 缓存（阶段 A）：本服务自持 Map<planId, { event, result }>，不迁入
 * @pi/scheduler 的 cache（保持编排器解耦，调研 P5）。
 *
 * 解耦：只依赖 Orchestrator + EventQueue + 事件类型，不依赖 ExtensionContext。
 */

import { EventQueue, type QueuedEvent } from "../event-queue.ts";
import type { StructuredEvent } from "@pi/scheduler";
import type { Orchestrator, OrchestratorResult, CommitSummary } from "../orchestrator.ts";

/** dispatch 返回（plan 模式） */
export interface DispatchResult {
  queueId: string;
  mode: "plan" | "yolo";
  planId?: string;
  result?: OrchestratorResult;
}

/** 队列状态查询返回 */
export interface QueueStatusResult {
  length: number;
  items: Array<{
    queueId: string;
    status: QueuedEvent["status"];
    storyTime?: string;
    enqueuedAt: number;
    finishedAt?: number;
    error?: string;
    result?: OrchestratorResult;
  }>;
}

/** commit 返回（后半链路触发结果） */
export interface CommitResult {
  ok: boolean;
  planId: string;
  appliedEventIds: string[];
  writtenText: string;
  chapterPath: string;
  error?: string;
}

/**
 * 编排器服务
 *
 * plan 模式：入队即返回 queueId；worker 异步跑前半链路（planner + 角色）后
 * 缓存 plan（event + result），主会话经 queueStatus 查询、commit 触发后半链路。
 * yolo 模式：worker 全链路跑完（含自动落地），结果在 queue 中可查询。
 */
export class OrchestratorService {
  private readonly orchestrator: Orchestrator;
  private readonly queue: EventQueue<StructuredEvent, OrchestratorResult>;
  /** plan 缓存：planId → { event, result }（commit/discard 用，进程内） */
  private readonly plans = new Map<string, { event: StructuredEvent; result: OrchestratorResult }>();

  constructor(orchestrator: Orchestrator) {
    this.orchestrator = orchestrator;
    this.queue = new EventQueue(
      (event) => this.orchestrator.run(event),
      // 前半链路完成后缓存 plan（plan 模式；yolo 模式 result.commit 已含落地摘要）
      (_queueId, result) => {
        if (result.mode === "plan") {
          this.plans.set(result.planId, { event: result.event, result });
        }
      },
    );
  }

  /** 派发事件：入队即返回 queueId */
  dispatch(event: StructuredEvent): DispatchResult {
    const queueId = this.queue.enqueue(event);
    return { queueId, mode: event.mode === "yolo" ? "yolo" : "plan" };
  }

  /**
   * 提交 plan：触发后半链路（可见推理写世界图 → 渲染器写章节 → 更新记忆）
   *
   * 幂等性：commit 成功后 planId 从缓存删除，重复 commit 返回错误。
   */
  async commit(planId: string): Promise<CommitResult> {
    const plan = this.plans.get(planId);
    if (!plan) {
      return {
        ok: false,
        planId,
        appliedEventIds: [],
        writtenText: "",
        chapterPath: "",
        error: `plan ${planId} not found (expired or never created)`,
      };
    }

    const { event, result } = plan;
    const eventId = result.eventId;
    try {
      const { commit } = await this.orchestrator.runPostRolePipeline(event, eventId, result.outputs);
      this.plans.delete(planId);
      return this.toCommitResult(commit, planId);
    } catch (err) {
      this.plans.delete(planId);
      return {
        ok: false,
        planId,
        appliedEventIds: [],
        writtenText: "",
        chapterPath: "",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** 丢弃 plan：不写世界图、不渲染 */
  discard(planId: string): { ok: boolean } {
    return { ok: this.plans.delete(planId) };
  }

  /** 队列状态查询 */
  queueStatus(): QueueStatusResult {
    const items = this.queue.getAll();
    return {
      length: items.length,
      items: items.map((q) => ({
        queueId: q.queueId,
        status: q.status,
        storyTime: (q.event as StructuredEvent | undefined)?.storyTime,
        enqueuedAt: q.enqueuedAt,
        ...(q.finishedAt !== undefined ? { finishedAt: q.finishedAt } : {}),
        ...(q.error !== undefined ? { error: q.error } : {}),
        ...(q.result !== undefined ? { result: q.result } : {}),
      })),
    };
  }

  /** 获取单条队列状态（含结果） */
  getQueuedEvent(queueId: string): QueuedEvent<StructuredEvent, OrchestratorResult> | undefined {
    return this.queue.getStatus(queueId);
  }

  /** 已缓存的 plan 数量（调试/单测用） */
  planCount(): number {
    return this.plans.size;
  }

  private toCommitResult(commit: CommitSummary, planId: string): CommitResult {
    return {
      ok: commit.ok,
      planId,
      appliedEventIds: commit.appliedEventIds,
      writtenText: commit.writtenText,
      chapterPath: commit.chapterPath,
      ...(commit.errors.length > 0 ? { error: commit.errors.join(" | ") } : {}),
    };
  }
}
