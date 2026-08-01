// src/app/llm-resolver.ts
/**
 * llm-resolver.ts — LLM slot 状态解析（pi-status 与 /api/admin/llm 共用，单一口径）
 *
 * 解析链与 LlmConfigStore 一致：slot 显式 → default → env
 * （env 解析依赖 loadLlmConfigFromEnv，无 key 时抛错 → source=none）。
 *
 * hasKey 判定（任一满足）：LlmConfigStore 配置链可解析出 key（slot/default 配置、
 * NE_LLM_API_KEY、provider 标准 env）或 authStorage.hasAuth(provider)。
 * 任何路径都不返回 key 明文。
 */
import type { AuthStorage } from "@earendil-works/pi-coding-agent";
import type { LlmConfigStore, LlmSlot } from "../orchestrator/llm-config.ts";

/** 解析来源 */
export type LlmSlotSource = "slot" | "default" | "env" | "none";

/** 单个 slot 的状态（GET /api/admin/llm 的返回单元） */
export interface LlmSlotStatus {
  /** 该 slot 的显式配置（未配置为 null；default slot 的显式配置也算 slot 级） */
  configured: { provider: string; model: string } | null;
  /** 解析结果（解析不出为 null） */
  resolved: { provider: string; model: string } | null;
  /** 解析来源 */
  source: LlmSlotSource;
  /** API Key 是否可用（配置链 / auth.json / env 任一） */
  hasKey: boolean;
}

/**
 * 解析某 slot 的模型（slot → default → env）
 *
 * source 判定：slot 显式配置 → "slot"；否则 default 显式 → "default"；
 * 否则走 env（env 无 key 时 LlmConfigStore 抛错 → 返回 null）。
 */
export function resolveSlot(
  store: LlmConfigStore,
  slot: LlmSlot,
): { provider: string; modelId: string; source: Exclude<LlmSlotSource, "none"> } | null {
  const configured = store.configuredSlots();
  try {
    const model = store.getModel(slot);
    const source = configured.includes(slot)
      ? "slot"
      : configured.includes("default")
        ? "default"
        : "env";
    return { provider: model.provider, modelId: model.id, source };
  } catch {
    return null;
  }
}

/** 某 slot 的 key 可用性：配置链（getApiKey）→ authStorage.hasAuth */
export function slotHasKey(
  store: LlmConfigStore,
  authStorage: AuthStorage,
  slot: LlmSlot,
  provider: string,
): boolean {
  try {
    store.getApiKey(slot);
    return true;
  } catch {
    // 配置链与 env 均无 key —— 回退 auth.json
  }
  try {
    return authStorage.hasAuth(provider);
  } catch {
    return false;
  }
}

/** 汇总某 slot 的完整状态 */
export function getSlotStatus(
  store: LlmConfigStore,
  authStorage: AuthStorage,
  slot: LlmSlot,
): LlmSlotStatus {
  const explicit = store.peekConfig(slot);
  const configured = explicit
    ? { provider: explicit.model.provider as string, model: explicit.model.name }
    : null;

  const resolved = resolveSlot(store, slot);
  if (!resolved) {
    return { configured, resolved: null, source: "none", hasKey: false };
  }
  return {
    configured,
    resolved: { provider: resolved.provider, model: resolved.modelId },
    source: resolved.source,
    hasKey: slotHasKey(store, authStorage, slot, resolved.provider),
  };
}
