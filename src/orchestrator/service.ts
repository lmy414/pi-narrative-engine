// src/orchestrator/service.ts
/**
 * service.ts — OrchestratorService 薄服务层
 *
 * 依据：docs/plans/2026-07-31-orchestrator-standalone-research.md §5.2
 *
 * 职责：
 * - dispatch(event)：入队即返回 queueId（plan 模式返回 planId；yolo 模式全链路跑完）
 * - commit(planId)：提交 plan（本阶段为占位——阶段 2 接数据层后跑可见推理 + 渲染）
 * - discard(planId)：丢弃 plan
 * - queueStatus()：队列状态查询（对应 scheduler_queue_status 工具）
 *
 * 解耦：只依赖 Orchestrator + EventQueue，不依赖 ExtensionContext。
 */

import { EventQueue, type QueuedEvent } from "../event-queue.ts";
import type { StructuredEvent } from "@pi/scheduler";
import type { Orchestrator, OrchestratorResult } from "../orchestrator.ts";

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
  }>;
}

/**
 * 编排器服务
 *
 * plan 模式：入队即返回 queueId；worker 异步跑完整条链后缓存结果，
 * 主会话可经 queueStatus 查询。commit/discard 为占位（阶段 2 接 plans 缓存）。
 */
export class OrchestratorService {
  private readonly orchestrator: Orchestrator;
  private readonly queue: EventQueue<StructuredEvent, OrchestratorResult>;
  /** MCP 客户端名来源（mcp-server.ts 注入，握手后取 clientInfo.name） */
  private clientInfoProvider?: () => string | undefined;

  constructor(orchestrator: Orchestrator) {
    this.orchestrator = orchestrator;
    this.queue = new EventQueue((event) => this.orchestrator.run(event));
  }

  /** 注入客户端名获取函数（由 MCP 包装层在 connect 后绑定） */
  attachClientInfoProvider(provider: () => string | undefined): void {
    this.clientInfoProvider = provider;
  }

  /** 派发事件：入队即返回 queueId */
  dispatch(event: StructuredEvent): DispatchResult {
    // 每次派发前刷新客户端名（决定 LLM 模型映射），再交队列异步执行
    this.orchestrator.setClientName(this.clientInfoProvider?.());
    const queueId = this.queue.enqueue(event);
    return { queueId, mode: event.mode === "yolo" ? "yolo" : "plan" };
  }

  /** 提交 plan（阶段 2 实现；当前返回占位失败，提示未接线） */
  async commit(_planId: string): Promise<{ ok: boolean; error?: string }> {
    return { ok: false, error: "commit 未接线：阶段 2 接入数据/能力层后启用" };
  }

  /** 丢弃 plan（阶段 2 实现） */
  async discard(_planId: string): Promise<{ ok: boolean }> {
    return { ok: false };
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
      })),
    };
  }

  /** 获取单条队列状态（含结果） */
  getQueuedEvent(queueId: string): QueuedEvent<StructuredEvent, OrchestratorResult> | undefined {
    return this.queue.getStatus(queueId);
  }
}
