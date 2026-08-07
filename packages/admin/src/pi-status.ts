// packages/admin/src/pi-status.ts
/**
 * pi-status.ts — 应用 LLM 状态只读查询（pure-SDK 版）
 *
 * pure-SDK 架构迁移后，不再有 PI 扩展宿主（无 ExtensionContext、无 pi CLI 探测）。
 * 状态来源改为两个显式依赖：
 * - authStorage：读 <configDir>/pi-agent/auth.json，判断 provider 是否已有凭据
 * - resolveModel：从 LlmConfigStore default slot → env 解析当前模型（参考
 *   src/app/chat-context.ts resolveModelConfig 的解析链）
 *
 * 返回形状与扩展时代一致（{ model, hasKey, piVersion, warnings }），
 * piVersion 字段保留但恒为 null（前端仅展示）。
 *
 * 不写 auth.json / 任何配置文件（本模块只读）。
 */

import type { AuthStorage } from "@earendil-works/pi-coding-agent";
import type { PiModelInfo } from "./types.ts";

// ============================================================================
// 类型
// ============================================================================

/** 模型解析结果（由调用方从 LlmConfigStore 解析） */
export interface ResolvedModel {
  provider: string;
  modelId: string;
  /** 配置链（slot/default/env）已能解析出 API Key */
  hasKey: boolean;
}

/** getPiStatus 的显式依赖 */
export interface PiStatusDeps {
  /** auth.json 只读视图（AuthStorage.create(<agentDir>/auth.json)） */
  authStorage: AuthStorage;
  /** 解析当前模型；解析不出（无配置且无 env key）返回 null */
  resolveModel: () => ResolvedModel | null;
}

/** PI 状态返回结果 */
export interface PiStatus {
  /** 当前模型（未配置时为 null） */
  model: PiModelInfo | null;
  /** API Key 是否已配置（配置链或 auth.json 可解析即视为 true） */
  hasKey: boolean;
  /** 恒为 null（pure-SDK 架构下无 pi CLI 宿主；字段保留以兼容前端展示） */
  piVersion: string | null;
  /** 探测过程中的非致命错误 */
  warnings: string[];
}

// ============================================================================
// 公共 API
// ============================================================================

/**
 * 查询应用 LLM 当前状态（只读）
 */
export function getPiStatus(deps: PiStatusDeps): PiStatus {
  const warnings: string[] = [];

  // 1. 模型信息（LlmConfigStore default slot → env）
  let resolved: ResolvedModel | null = null;
  try {
    resolved = deps.resolveModel();
  } catch (err) {
    // 🟡（2026-08-08）：不直出底层错误原文（可能含路径/敏感字段），原文仅日志
    console.error(`[pi-status] resolveModel 抛错: ${(err as Error).message}`);
    warnings.push("resolveModel 抛错（详情见服务端日志）");
  }

  let model: PiModelInfo | null = null;
  let hasKey = false;
  if (resolved) {
    model = { id: resolved.modelId, provider: resolved.provider };
    hasKey = resolved.hasKey;
    // 配置链无 key 时回退查 auth.json（与主会话同一文件，只读）
    if (!hasKey) {
      try {
        hasKey = deps.authStorage.hasAuth(resolved.provider);
      } catch (err) {
        console.error(`[pi-status] authStorage.hasAuth 抛错: ${(err as Error).message}`);
        warnings.push("authStorage.hasAuth 抛错（详情见服务端日志）");
      }
    }
    if (!hasKey) {
      warnings.push(`未配置 ${resolved.provider} 的 API Key（env / auth.json 均无）`);
    }
  } else {
    warnings.push("未配置模型（LlmConfigStore default slot 与 env 均无可用配置）");
  }

  return {
    model,
    hasKey,
    piVersion: null,
    warnings,
  };
}
