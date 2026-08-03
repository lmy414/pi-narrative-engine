/**
 * types.ts — 调试事件类型定义
 *
 * 设计：
 * - 每个调试事件对应调度链中某个阶段的一次执行（开始/结束/错误）
 * - traceId 关联同一次 dispatch 的所有事件，前端按 traceId 聚合为 DAG
 * - stage 用点分路径，便于前端按层级展示（如 commit.step.4）
 *
 * 不变性：
 * - 所有字段可序列化为 JSON（无函数/循环引用）
 * - input/output 由调用方裁剪（避免传巨大对象，如完整 LLM 上下文）
 */
export type DebugEventStatus = "start" | "end" | "error";

export interface DebugEvent {
  /** 事件唯一 ID（前端去重用） */
  id: string;
  /** 毫秒时间戳（Date.now()） */
  ts: number;
  /** 调度链追踪 ID（同一次 dispatch/commit 共享同一 traceId） */
  traceId: string;
  /** 阶段名（点分路径，如 "dispatch" / "plan.llm" / "retrieve.item" / "commit.step.4"） */
  stage: string;
  /** 状态：start=开始 / end=成功结束 / error=异常 */
  status: DebugEventStatus;
  /** 阶段输入（开始时携带，结束时可补充） */
  input?: unknown;
  /** 阶段输出（结束时携带） */
  output?: unknown;
  /** 执行时长（毫秒，仅 end/error 携带） */
  durationMs?: number;
  /** 错误信息（仅 error 携带） */
  error?: string;
  /**
   * 父阶段 ID（用于 DAG 边构建，如 retrieve.item 的父是 dispatch）
   * 缺省时无父（顶级阶段）
   */
  parentId?: string;
}

/**
 * 调试事件总线接口
 * 实现见 bus.ts；调度器通过此接口发射事件，未注入时为无操作
 */
export interface DebugBus {
  /** 发射一个事件并写入环形缓冲 */
  emit(event: DebugEvent): void;
  /** 订阅事件流（返回取消订阅函数） */
  subscribe(listener: (event: DebugEvent) => void): () => void;
  /** 拉取环形缓冲内所有事件（按时间顺序） */
  snapshot(): DebugEvent[];
  /** 清空环形缓冲 */
  clear(): void;
  /** 生成事件 ID（实例内自增；L-BE-2：替代模块级全局序号，避免多实例共享） */
  genEventId(): string;
}

/** 项目绑定的异步持久化目标；队列与失败隔离由 bus.ts 统一处理。 */
export interface DebugEventSink {
  write(event: DebugEvent): Promise<void>;
}

/** 带异步持久化队列的项目 DebugBus。 */
export interface DrainableDebugBus extends DebugBus {
  /** 等待调用前已排队的事件全部完成（包括失败隔离后的队列）。 */
  drain(): Promise<void>;
}

/**
 * 阶段追踪器：用于在 try/finally 中配对 start/end 事件
 *
 * 用法：
 * ```ts
 * const span = bus?.start("plan.llm", traceId, { input: {...} });
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
export interface DebugSpan {
  end(output?: unknown): void;
  error(err: unknown): void;
}
