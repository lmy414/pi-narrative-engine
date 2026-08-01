// packages/admin/src/types.ts
/**
 * @pi/admin 公共类型定义
 *
 * 软隔离约定（与 @pi/novel-launcher 等子包一致）：
 * - 无前缀 = 公共 API（外部消费者引用）
 * - _ 前缀 = 包内部实现，不保证稳定
 *
 * 设计依据：docs/plans/2026-07-29-config-ui-design.md §6
 */

/** @pi/admin 统一错误 */
export class AdminError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "AdminError";
    this.code = code;
  }
}

/** 通用检查状态（doctor / embedder 等检查项复用） */
export type CheckStatus = "pass" | "warn" | "fail";

/** PI 模型信息（只读展示用） */
export interface PiModelInfo {
  /** 模型 ID，如 "deepseek-v4-flash" */
  id: string;
  /** provider，如 "deepseek" */
  provider: string;
}

/** Embedder 最小接口（warmup 用，与 src/embedder.ts 的 Embedder 结构兼容） */
export interface EmbedderLike {
  init(): Promise<void>;
  getDimension(): number;
}
