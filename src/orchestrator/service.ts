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
import type {
  Orchestrator,
  OrchestratorResult,
  PlanStage,
} from "../orchestrator.ts";
import type { RetrievalPlan } from "@pi/scheduler";
import type { RoleAgentOutput } from "@pi/role-pool";
import type { DiffusionOutput, RenderOutput, CommitSummary } from "../orchestrator.ts";

/** dispatch 返回（plan 模式） */
export interface DispatchResult {
  queueId: string;
  mode: "plan" | "yolo";
  planId?: string;
  result?: OrchestratorResult;
}

/** plan 生命周期状态（BUG-014：commit 异步化需要中间状态） */
export type PlanStatus = "confirmed" | "committing" | "committed" | "error";

/**
 * 队列任务（BUG-014：EventQueue 泛化为支持 event/commit 两类任务）
 *
 * - event：前半链路（planner + 角色），dispatch 入队
 * - commit：后半链路（reasoning + renderer），commit 入队
 */
export type QueueTask =
  | { kind: "event"; event: StructuredEvent }
  | { kind: "commit"; planId: string };

/** 队列任务结果 */
export type QueueResult = OrchestratorResult | CommitResult;

/** 队列状态查询返回（G1-1：items 不再挂完整 result，按需走 getQueuedEvent） */
export interface QueueStatusResult {
  /** 队列总条目数（含已完成未清理项） */
  length: number;
  /** 活跃任务数（pending + running）— 前端状态栏应使用此字段而非 length（G1-2） */
  active: number;
  items: Array<{
    queueId: string;
    status: QueuedEvent["status"];
    storyTime?: string;
    enqueuedAt: number;
    startedAt?: number;
    finishedAt?: number;
    error?: string;
    /** 结果摘要（不含完整 OrchestratorResult；前端按需调 getQueuedEvent 拉取完整 result） */
    resultSummary?: {
      mode: "plan" | "yolo";
      planId?: string;
      outputCount: number;
      errorCount: number;
      chapterPath?: string;
      /** yolo 模式下 commit 摘要（plan 模式 commit 在 commit() 后才有） */
      appliedEventIds?: string[];
      writtenTextLength?: number;
    };
  }>;
}

/** commit 入队返回（BUG-014：commit 异步化后入队即返回） */
export interface CommitEnqueueResult {
  ok: boolean;
  planId: string;
  /** commit 任务在队列中的 ID（与 queue.items[].queueId 对应） */
  queueId?: string;
  /** plan 当前状态（confirmed/committing/committed/error） */
  status: PlanStatus;
  error?: string;
}

/** commit 任务执行结果（worker 函数返回，onDone 回调消费） */
export interface CommitResult {
  ok: boolean;
  planId: string;
  queueId: string;
  /** 后半链路完整结果（diffusion + render + commit），成功时必有 */
  pipelineResult?: {
    diffusion: DiffusionOutput;
    render: RenderOutput;
    commit: CommitSummary;
  };
  appliedEventIds: string[];
  writtenText: string;
  chapterPath: string;
  error?: string;
}

/** 单个待确认 plan 的公开只读投影 */
export interface PlanDetail {
  planId: string;
  storyTime: string;
  mode: "plan" | "yolo";
  characterIds: string[];
  cast: { characterId: string; name: string; summary: string }[];
  outputs: RoleAgentOutput[];
  retrievalPlan: RetrievalPlan;
  errors: { characterId: string; error: string }[];
  stages: PlanStage[];
  /** plan 生命周期状态（BUG-014：commit 异步化） */
  status: PlanStatus;
  /** commit 任务关联的队列 ID（status=committing 时有值，便于前端查进度） */
  commitQueueId?: string;
  /** commit 错误信息（status=error 时有值） */
  commitError?: string;
  /** BUG-028：commit 开始时间戳（status=committing 时有值，前端显示已耗时） */
  commitStartedAt?: number;
  /** BUG-028：commit 当前阶段（status=committing 时有值：reasoning/rendering） */
  commitStage?: "reasoning" | "rendering";
  /** 后半链路结果：可见推理（diffusion） */
  diffusion?: DiffusionOutput;
  /** 后半链路结果：渲染正文（render） */
  render?: RenderOutput;
  /** 后半链路结果：落地摘要（commit） */
  commit?: CommitSummary;
}

/**
 * 编排器服务
 *
 * plan 模式：入队即返回 queueId；worker 异步跑前半链路（planner + 角色）后
 * 缓存 plan（event + result），主会话经 queueStatus 查询、commit 触发后半链路。
 * yolo 模式：worker 全链路跑完（含自动落地），结果在 queue 中可查询。
 *
 * BUG-014 commit 异步化：commit 也入 EventQueue，worker 函数按 task.kind 分发。
 * plan 状态机：confirmed（待确认）→ committing（提交中）→ committed（完成）| error（失败）。
 * 状态保护：重复 commit 返回 COMMIT_IN_PROGRESS / PLAN_ALREADY_COMMITTED 明确错误。
 */
export class OrchestratorService {
  private readonly orchestrator: Orchestrator;
  private readonly queue: EventQueue<QueueTask, QueueResult>;
  /**
   * plan 缓存：planId → { event, result, status, commitQueueId?, commitError? }
   *
   * status 流转：
   * - confirmed：前半链路完成，等待用户提交
   * - committing：commit 已入队，后半链路执行中
   * - committed：commit 成功，世界图+章节已写（plan 保留供查询历史，由 TTL 清理）
   * - error：commit 失败，保留 plan 供排查或重试（重试时 status 回 confirmed 再转 committing）
   */
  private readonly plans = new Map<
    string,
    {
      event: StructuredEvent;
      result: OrchestratorResult;
      status: PlanStatus;
      commitQueueId?: string;
      commitError?: string;
      /** BUG-028：commit 开始时间戳（前端显示已耗时） */
      commitStartedAt?: number;
      /** BUG-028：commit 当前阶段（reasoning/rendering） */
      commitStage?: "reasoning" | "rendering";
      /** 后半链路完整结果（commit 成功后写回） */
      pipelineResult?: {
        diffusion: DiffusionOutput;
        render: RenderOutput;
        commit: CommitSummary;
      };
    }
  >();

  constructor(orchestrator: Orchestrator) {
    this.orchestrator = orchestrator;
    this.queue = new EventQueue(
      // worker：按 task.kind 分发到前半链路或后半链路
      async (task) => {
        if (task.kind === "event") {
          return await this.orchestrator.run(task.event);
        }
        return await this.runCommitPipeline(task.planId);
      },
      // onDone：前半链路完成缓存 plan；后半链路完成更新 plan.status
      (_queueId, result, task) => {
        if (task.kind === "event") {
          const r = result as OrchestratorResult;
          if (r.mode === "plan") {
            this.plans.set(r.planId, {
              event: r.event,
              result: r,
              status: "confirmed",
            });
          }
        } else if (task.kind === "commit") {
          this.onCommitDone(task.planId, result as CommitResult);
        }
      },
    );
  }

  /** 派发事件：入队即返回 queueId */
  dispatch(event: StructuredEvent): DispatchResult {
    const queueId = this.queue.enqueue({ kind: "event", event });
    return { queueId, mode: event.mode === "yolo" ? "yolo" : "plan" };
  }

  /**
   * 提交 plan：入队即返回（BUG-014 异步化）
   *
   * 状态保护：
   * - confirmed → 入队，status 转 committing，返回 { ok, queueId, status: 'committing' }
   * - committing → 返回 { ok: false, status: 'committing', error: 'COMMIT_IN_PROGRESS' }
   * - committed → 返回 { ok: false, status: 'committed', error: 'PLAN_ALREADY_COMMITTED' }
   * - error → 允许重试，重新入队，status 回 confirmed 再转 committing
   * - 不存在 → 返回 { ok: false, status: 'confirmed', error: 'PLAN_NOT_FOUND' }
   */
  commit(planId: string): CommitEnqueueResult {
    const plan = this.plans.get(planId);
    if (!plan) {
      return {
        ok: false,
        planId,
        status: "confirmed",
        error: `plan ${planId} not found (expired or never created)`,
      };
    }

    if (plan.status === "committing") {
      return {
        ok: false,
        planId,
        status: "committing",
        error: "COMMIT_IN_PROGRESS",
      };
    }
    if (plan.status === "committed") {
      return {
        ok: false,
        planId,
        status: "committed",
        error: "PLAN_ALREADY_COMMITTED",
      };
    }

    // confirmed 或 error（重试）：入队后半链路任务
    const queueId = this.queue.enqueue({ kind: "commit", planId });
    plan.status = "committing";
    plan.commitQueueId = queueId;
    plan.commitError = undefined;
    return { ok: true, planId, queueId, status: "committing" };
  }

  /**
   * 后半链路 worker：执行 runPostRolePipeline，捕获错误转 CommitResult（不抛错）
   *
   * 幂等性由 commit() 状态保护保证；此函数只负责执行 + 返回结果。
   * 一致性：runPostRolePipeline 失败时若已写入部分世界图，如实返回 appliedEventIds；
   * 失败时 plan.status 转 error（在 onCommitDone 中处理），保留 plan 供排查或重试。
   */
  private async runCommitPipeline(planId: string): Promise<CommitResult> {
    const plan = this.plans.get(planId);
    if (!plan) {
      // 理论不可达：commit() 已校验 plan 存在；并发 discard 可能导致此情况
      return {
        ok: false,
        planId,
        queueId: "",
        appliedEventIds: [],
        writtenText: "",
        chapterPath: "",
        error: `plan ${planId} not found during commit (concurrent discard?)`,
      };
    }

    const { event, result } = plan;
    const eventId = result.eventId;
    const queueId = plan.commitQueueId ?? "";
    // BUG-028：记录 commit 开始时间 + 阶段（前端轮询时展示进度，消除"一直处理中"误判）
    plan.commitStartedAt = Date.now();
    plan.commitStage = "reasoning";
    try {
      const pipeline = await this.orchestrator.runPostRolePipeline(
        event,
        eventId,
        result.outputs,
        undefined,
        (stage) => {
          plan.commitStage = stage;
        },
      );
      return {
        ok: pipeline.commit.ok,
        planId,
        queueId,
        pipelineResult: {
          diffusion: pipeline.diffusion,
          render: pipeline.render,
          commit: pipeline.commit,
        },
        appliedEventIds: pipeline.commit.appliedEventIds,
        writtenText: pipeline.commit.writtenText,
        chapterPath: pipeline.commit.chapterPath,
        ...(pipeline.commit.errors.length > 0 ? { error: pipeline.commit.errors.join(" | ") } : {}),
      };
    } catch (err) {
      // 一致性缺口（沿用 2026-08-03 修复）：推理代理可能已通过写工具实际写入世界图，
      // 如实返回 appliedEventIds；plan 保留供用户 discard 或排查（status 转 error）。
      const written = (err as Error & { appliedEventIds?: string[] }).appliedEventIds ?? [];
      return {
        ok: false,
        planId,
        queueId,
        appliedEventIds: written,
        writtenText: "",
        chapterPath: "",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** commit 任务完成回调：根据 result.ok 更新 plan.status 并写回 pipelineResult */
  private onCommitDone(planId: string, result: CommitResult): void {
    const plan = this.plans.get(planId);
    if (!plan) return;
    if (result.ok) {
      if (result.pipelineResult) {
        plan.pipelineResult = result.pipelineResult;
      }
      plan.status = "committed";
      plan.commitError = undefined;
      plan.commitStage = undefined;
    } else {
      plan.status = "error";
      plan.commitError = result.error;
      plan.commitStage = undefined;
    }
  }

  /** 丢弃 plan：不写世界图、不渲染；committing 中禁止 discard（防世界图半写状态） */
  discard(planId: string): { ok: boolean; error?: string } {
    const plan = this.plans.get(planId);
    if (!plan) return { ok: false };
    if (plan.status === "committing") {
      return { ok: false, error: "COMMIT_IN_PROGRESS" };
    }
    this.plans.delete(planId);
    return { ok: true };
  }

  /** 获取待确认 plan 详情；只返回公开 DTO，不暴露缓存条目或完整编排结果 */
  getPlan(planId: string): PlanDetail | undefined {
    const plan = this.plans.get(planId);
    if (!plan) return undefined;
    const { event, result, status, commitQueueId, commitError, commitStartedAt, commitStage, pipelineResult } = plan;
    return {
      planId: result.planId,
      storyTime: event.storyTime,
      mode: result.mode,
      characterIds: [...event.characterIds],
      cast: structuredClone(result.cast),
      outputs: structuredClone(result.outputs),
      retrievalPlan: structuredClone(result.retrievalPlan),
      errors: structuredClone(result.errors),
      stages: structuredClone(result.stages),
      status,
      ...(commitQueueId !== undefined ? { commitQueueId } : {}),
      ...(commitError !== undefined ? { commitError } : {}),
      ...(commitStartedAt !== undefined ? { commitStartedAt } : {}),
      ...(commitStage !== undefined ? { commitStage } : {}),
      ...(pipelineResult
        ? {
            diffusion: structuredClone(pipelineResult.diffusion),
            render: structuredClone(pipelineResult.render),
            commit: structuredClone(pipelineResult.commit),
          }
        : {}),
    };
  }

  /** 队列状态查询（G1-1 瘦身：items 不挂完整 result，仅暴露 resultSummary 摘要） */
  queueStatus(): QueueStatusResult {
    const items = this.queue.getAll();
    return {
      length: items.length,
      active: this.queue.activeCount,
      items: items.map((q) => {
        // BUG-014：q.event 现在是 QueueTask（event/commit 两类），storyTime 仅 event 任务有
        const task = q.event;
        const storyTime = task.kind === "event" ? task.event.storyTime : undefined;
        const item: QueueStatusResult["items"][number] = {
          queueId: q.queueId,
          status: q.status,
          ...(storyTime !== undefined ? { storyTime } : {}),
          enqueuedAt: q.enqueuedAt,
          ...(q.startedAt !== undefined ? { startedAt: q.startedAt } : {}),
          ...(q.finishedAt !== undefined ? { finishedAt: q.finishedAt } : {}),
          ...(q.error !== undefined ? { error: q.error } : {}),
        };
        if (q.result) {
          // BUG-014：result 可能是 OrchestratorResult（event 任务）或 CommitResult（commit 任务）
          const r = q.result;
          if ("mode" in r) {
            // OrchestratorResult
            item.resultSummary = {
              mode: r.mode,
              planId: r.planId,
              outputCount: r.outputs.length,
              errorCount: r.errors.length,
              chapterPath: r.chapterPath,
              ...(r.commit
                ? {
                    appliedEventIds: r.commit.appliedEventIds,
                    writtenTextLength: r.commit.writtenText.length,
                  }
                : {}),
            };
          } else {
            // CommitResult
            item.resultSummary = {
              mode: "plan",
              planId: r.planId,
              outputCount: 0,
              errorCount: r.ok ? 0 : 1,
              chapterPath: r.chapterPath,
              appliedEventIds: r.appliedEventIds,
              writtenTextLength: r.writtenText.length,
            };
          }
        }
        return item;
      }),
    };
  }

  /** 获取单条队列状态（含结果） */
  getQueuedEvent(queueId: string): QueuedEvent<QueueTask, QueueResult> | undefined {
    return this.queue.getStatus(queueId);
  }

  /** 已缓存的 plan 数量（调试/单测用） */
  planCount(): number {
    return this.plans.size;
  }

  /**
   * 待确认 plan 列表（只读摘要，GET /api/scheduler/status 用）
   *
   * plan 模式前半链路完成后缓存；commit 后 status 转 committing/committed/error，
   * committed/error 的 plan 仍保留供前端展示结果（由 TTL 清理或显式 discard 移除）。
   */
  listPlans(): Array<{
    planId: string;
    storyTime: string;
    mode: "plan" | "yolo";
    characterIds: string[];
    /** 角色产出数 / 角色错误数（计划卡片摘要用） */
    outputCount: number;
    errorCount: number;
    /** plan 生命周期状态（BUG-014） */
    status: PlanStatus;
    /** commit 任务关联的队列 ID（status=committing 时有值） */
    commitQueueId?: string;
    /** commit 错误信息（status=error 时有值） */
    commitError?: string;
    /** BUG-028：commit 开始时间戳（status=committing 时有值） */
    commitStartedAt?: number;
    /** BUG-028：commit 当前阶段（status=committing 时有值） */
    commitStage?: "reasoning" | "rendering";
  }> {
    return Array.from(this.plans.entries()).map(([planId, { event, result, status, commitQueueId, commitError, commitStartedAt, commitStage }]) => ({
      planId,
      storyTime: event.storyTime,
      mode: result.mode,
      characterIds: event.characterIds,
      outputCount: result.outputs.length,
      errorCount: result.errors.length,
      status,
      ...(commitQueueId !== undefined ? { commitQueueId } : {}),
      ...(commitError !== undefined ? { commitError } : {}),
      ...(commitStartedAt !== undefined ? { commitStartedAt } : {}),
      ...(commitStage !== undefined ? { commitStage } : {}),
    }));
  }
}
