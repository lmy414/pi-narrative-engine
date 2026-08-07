// packages/admin/src/embedder-status.ts
/**
 * embedder-status.ts — 向量模型状态与缓存管理
 *
 * 设计依据：docs/plans/2026-07-29-config-ui-design.md §5.3.4 / §6.5
 *
 * 职责：
 * - 查询当前向量模型名（PI_EMBEDDER_MODEL 环境变量或默认值）
 * - 查询缓存是否存在与大小
 * - 清理缓存
 * - warmup：加载模型并测量首次延迟（需调用方传入 Embedder 实例）
 *
 * 不直接 import src/embedder.ts（避免子包反向依赖主包），
 * warmup 通过 EmbedderLike 接口接受外部传入的实例。
 */

import { existsSync, readdirSync } from "node:fs";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import type { EmbedderLike } from "./types.ts";
import { AdminError } from "./types.ts";

// ============================================================================
// 类型与常量
// ============================================================================

/** 向量模型状态 */
export interface EmbedderStatus {
  /** 当前配置的模型名（PI_EMBEDDER_MODEL 或默认） */
  model: string;
  /** 是否为默认模型 */
  isDefault: boolean;
  /** 向量维度（由 Embedder 实例决定，无法从配置读时为 null） */
  dim: number | null;
  /** 本地缓存是否存在（任一缓存位置命中即 true） */
  cachePresent: boolean;
  /** 缓存目录绝对路径（命中的那个；未命中为 null） */
  cachePath: string | null;
  /** 缓存大小（字节，无法计算时为 null） */
  cacheSizeBytes: number | null;
}

/** warmup 结果 */
export interface WarmupResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

/** 默认向量模型（与 src/embedder.ts 的 DEFAULT_MODEL 对齐） */
export const DEFAULT_EMBEDDER_MODEL = "Xenova/bge-small-zh-v1.5";

/** 默认维度（与 src/embedder.ts / tests 钉死） */
export const DEFAULT_EMBEDDER_DIM = 512;

// ============================================================================
// 内部实现
// ============================================================================

/**
 * 计算目录大小（递归，字节）
 * - 目录不存在返回 0
 */
export async function _dirSize(dir: string): Promise<number> {
  if (!existsSync(dir)) return 0;
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  // 🟡（2026-08-08）：子目录并行统计（此前串行 await，大缓存目录耗时数秒）
  const subs: Promise<number>[] = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      subs.push(_dirSize(full));
    } else if (e.isFile()) {
      const stat = await fs.stat(full);
      total += stat.size;
    }
  }
  const subTotals = await Promise.all(subs);
  for (const n of subTotals) total += n;
  return total;
}

/**
 * 查找向量模型缓存目录
 *
 * 缓存位置（按优先级）：
 * 1. <baseDir>/node_modules/@xenova/transformers/.cache/Xenova/（transformers.js v2 默认）
 * 2. ~/.cache/huggingface/hub/（HF 全局缓存，需含 models--* 子目录）
 *
 * @param baseDir 扩展目录或仓库根目录
 */
export function _findCacheDir(baseDir: string): string | null {
  // 1. 本地 node_modules 缓存
  const localCache = join(
    baseDir,
    "node_modules",
    "@xenova",
    "transformers",
    ".cache",
    "Xenova",
  );
  if (existsSync(localCache) && readdirSync(localCache).length > 0) {
    return localCache;
  }
  // 2. HF 全局缓存（仅当包含 models--* 子目录时视为命中）
  const hfCache = join(os.homedir(), ".cache", "huggingface", "hub");
  if (existsSync(hfCache)) {
    const hasModel = readdirSync(hfCache).some((d) => d.startsWith("models--"));
    if (hasModel) return hfCache;
  }
  return null;
}

// ============================================================================
// 公共 API
// ============================================================================

/**
 * 查询向量模型状态
 *
 * @param baseDir 扩展目录或仓库根目录（用于查找缓存）
 * @param embedder 可选的 Embedder 实例（提供时返回实际 dim）
 */
export async function getEmbedderStatus(
  baseDir: string,
  embedder?: EmbedderLike,
): Promise<EmbedderStatus> {
  const configured = process.env.PI_EMBEDDER_MODEL?.trim() || "";
  const model = configured || DEFAULT_EMBEDDER_MODEL;
  const isDefault = !configured;
  const dim = embedder ? embedder.getDimension() : null;

  const cachePath = _findCacheDir(baseDir);
  let cacheSizeBytes: number | null = null;
  if (cachePath) {
    cacheSizeBytes = await _dirSize(cachePath);
  }

  return {
    model,
    isDefault,
    dim,
    cachePresent: cachePath !== null,
    cachePath,
    cacheSizeBytes,
  };
}

/**
 * 清理向量模型缓存
 *
 * - 同时清理本地 node_modules 缓存与 HF 全局缓存中匹配当前模型的条目
 * - 清理后 cachePresent 应为 false
 *
 * @param baseDir 扩展目录或仓库根目录
 * @returns 清理的字节数（best-effort，可能不精确）
 */
export async function clearEmbedderCache(baseDir: string): Promise<{
  ok: boolean;
  clearedBytes: number;
  clearedPaths: string[];
}> {
  const clearedPaths: string[] = [];
  let clearedBytes = 0;

  // 1. 本地 node_modules 缓存（直接删整个 .cache 目录）
  const localCache = join(
    baseDir,
    "node_modules",
    "@xenova",
    "transformers",
    ".cache",
  );
  if (existsSync(localCache)) {
    clearedBytes += await _dirSize(localCache);
    await fs.rm(localCache, { recursive: true, force: true });
    clearedPaths.push(localCache);
  }

  // 2. HF 全局缓存中匹配当前模型的目录
  const model = process.env.PI_EMBEDDER_MODEL?.trim() || DEFAULT_EMBEDDER_MODEL;
  const hfCache = join(os.homedir(), ".cache", "huggingface", "hub");
  if (existsSync(hfCache)) {
    // HF 缓存目录命名规则：models--<org>--<name>
    const modelSlug = "models--" + model.replace(/\//g, "--");
    const modelDir = join(hfCache, modelSlug);
    if (existsSync(modelDir)) {
      clearedBytes += await _dirSize(modelDir);
      await fs.rm(modelDir, { recursive: true, force: true });
      clearedPaths.push(modelDir);
    }
  }

  return { ok: true, clearedBytes, clearedPaths };
}

/**
 * warmup 向量模型（加载模型并测量首次延迟）
 *
 * 调用方传入 Embedder 实例（通常来自 session state），
 * 本函数调 init() 并计时，不重复构造实例。
 *
 * @param embedder Embedder 实例（state.embedder）
 */
export async function warmupEmbedder(embedder: EmbedderLike): Promise<WarmupResult> {
  const start = Date.now();
  try {
    await embedder.init();
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    // 🟡（2026-08-08）：脱敏——transformers.js 下载错误含本地路径，原文仅日志
    console.error(`[embedder] warmup 失败: ${(err as Error).message}`);
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: "向量模型初始化失败（详情见服务端日志）",
    };
  }
}

/**
 * 校验模型名格式（前端自定义输入用）
 * - 格式：org/name，如 Xenova/bge-small-zh-v1.5
 * - 不校验模型是否存在（需 warmup 才知道）
 */
export function _validateModelName(model: string): { ok: boolean; error?: string } {
  const trimmed = model.trim();
  if (!trimmed) return { ok: false, error: "模型名不能为空" };
  if (!/^[A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-]+$/.test(trimmed)) {
    return { ok: false, error: "模型名格式应为 org/name（如 Xenova/bge-small-zh-v1.5）" };
  }
  return { ok: true };
}

/** 抛 AdminError 的便捷封装 */
export function assertModelValid(model: string): void {
  const r = _validateModelName(model);
  if (!r.ok) {
    throw new AdminError(r.error!, "INVALID_EMBEDDER_MODEL");
  }
}
