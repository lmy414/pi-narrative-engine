// packages/admin/src/pi-status.ts
/**
 * pi-status.ts — PI 宿主状态只读查询
 *
 * 设计依据：docs/plans/2026-07-29-config-ui-design.md §6.2 / §5.3.1
 *
 * 职责：
 * - 从 ctx.model 读取当前模型（id + provider）
 * - 从 ctx.modelRegistry.hasConfiguredAuth 判断 API Key 是否已配置
 * - 通过 spawn("pi", ["--version"]) 获取 PI 版本
 *
 * 不写 PI 的 settings.json / auth.json（PI 配置归 PI 管）。
 */

import { spawn } from "node:child_process";
import type { PiStatusContext, PiModelInfo } from "./types.ts";
import { AdminError } from "./types.ts";

// ============================================================================
// 类型
// ============================================================================

/** PI 状态返回结果 */
export interface PiStatus {
  /** 当前模型（未配置时为 null） */
  model: PiModelInfo | null;
  /** API Key 是否已配置（可解析即视为 true） */
  hasKey: boolean;
  /** PI 版本号（探测失败为 null） */
  piVersion: string | null;
  /** 探测过程中的非致命错误（如 pi 不在 PATH） */
  warnings: string[];
}

// ============================================================================
// 可 mock 的内部依赖（_ 前缀，软隔离）
// ============================================================================

export const _internals: {
  spawn: typeof spawn;
} = { spawn };

// ============================================================================
// 内部实现
// ============================================================================

/**
 * 通过 spawn("pi", ["--version"]) 探测 PI 版本
 * - pi 不在 PATH 或非交互环境时返回 null + warning
 * - 超时 10s
 */
export async function _detectPiVersion(): Promise<{ version: string | null; warning?: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = _internals.spawn("pi", ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10000,
      shell: process.platform === "win32",
    });
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", () => {
      if (settled) return;
      settled = true;
      resolve({
        version: null,
        warning: "pi 不在 PATH 或不可执行（运行时宿主为 pi CLI，要求 >= 0.77）",
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      const ver = (stdout || "").trim().split(/\s+/).pop() ?? "";
      if (code === 0 && ver) {
        resolve({ version: ver });
      } else {
        resolve({
          version: null,
          warning: `pi --version 退出码 ${code}（stderr: ${stderr.trim().slice(0, 120) || "空"})`,
        });
      }
    });
  });
}

// ============================================================================
// 公共 API
// ============================================================================

/**
 * 查询 PI 宿主当前状态（只读）
 *
 * @param ctx PI 上下文（从扩展事件 handler 的 ctx 透传）
 */
export async function getPiStatus(ctx: PiStatusContext): Promise<PiStatus> {
  const warnings: string[] = [];

  // 1. 模型信息
  let model: PiModelInfo | null = null;
  let hasKey = false;
  if (ctx.model) {
    model = { id: ctx.model.id, provider: ctx.model.provider };
    try {
      hasKey = ctx.modelRegistry.hasConfiguredAuth(ctx.model);
    } catch (err) {
      warnings.push(`hasConfiguredAuth 抛错: ${(err as Error).message}`);
    }
  } else {
    warnings.push("ctx.model 为空（请在 PI 内配置模型：/model 或 pi login 或 DEEPSEEK_API_KEY）");
  }

  // 2. PI 版本
  const versionResult = await _detectPiVersion();
  if (versionResult.warning) warnings.push(versionResult.warning);

  return {
    model,
    hasKey,
    piVersion: versionResult.version,
    warnings,
  };
}

/**
 * 校验 PI 版本是否兼容（>= 0.77）
 * - 版本格式异常时返回 null（调用方决定如何处理）
 */
export function _isPiVersionCompatible(version: string | null): boolean | null {
  if (!version) return null;
  const m = version.match(/(\d+)\.(\d+)/);
  if (!m) return null;
  const major = parseInt(m[1], 10);
  const minor = parseInt(m[2], 10);
  if (major > 0) return true;
  return minor >= 77;
}

/** 抛 AdminError 的便捷封装（前端展示用） */
export function assertPiReady(status: PiStatus): void {
  if (!status.model) {
    throw new AdminError(
      "PI 未配置模型：请在 PI 会话内执行 /model，或 pi login，或设置 DEEPSEEK_API_KEY 环境变量",
      "PI_NO_MODEL",
    );
  }
  if (!status.hasKey) {
    throw new AdminError(
      `PI 未配置 ${status.model.provider} 的 API Key：请 pi login 或设置对应环境变量`,
      "PI_NO_API_KEY",
    );
  }
}
