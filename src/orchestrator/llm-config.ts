// src/orchestrator/llm-config.ts
/**
 * llm-config.ts — LlmConfig / AgentRuntime 抽象（SDK 模式解耦点）
 *
 * 依据：docs/plans/2026-07-31-orchestrator-standalone-research.md §5.1
 *
 * 分层：
 * - AgentRuntime：子代理设计 §3.1 的解耦接口（model / streamFn / getApiKey），零 PI 依赖
 * - LlmConfig：SDK 模式配置源——从独立配置（env/凭据文件/客户端名）构造 AgentRuntime，
 *   替代 PI 适配器（pi-adapter.ts）
 * - loadLlmConfig：配置探测链（2026-08-01 新增，替代 loadLlmConfigFromEnv）
 *
 * 探测链（支持"外部服务注入凭据"，无需在 MCP 配置里写模型/key）：
 *   模型：显式 NE_LLM_PROVIDER / NE_LLM_MODEL → MCP 客户端名映射 → 缺省 deepseek
 *   key：  NE_LLM_API_KEY → provider 标准 env（OPENAI_API_KEY 等）→ Codex auth.json
 *
 * 2026-07-31 复核修正：
 * - provider 用 KnownProvider 字面量类型（非裸 string），保留 getModel 第一参数类型安全
 * - getModel 第二参数断言 `as never`：该参数是字面量 keyof 联合（models.generated.ts），
 *   运行时 string 无法静态匹配；且 MODELS 类型不被 pi-ai exports 导出，无法引用窄化
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getModel, streamSimple } from "@earendil-works/pi-ai";
import type { KnownProvider, Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

/** 解耦接口（子代理设计 §3.1）：编排器与子代理只依赖它，不依赖 PI */
export interface AgentRuntime {
  model: Model<any>;
  streamFn: StreamFn;
  getApiKey: (provider: string) => Promise<string | undefined>;
}

/** SDK 模式配置源（替代 PI 适配器） */
export interface LlmConfig {
  model: {
    /** 已查证：getModel 第一参数要求 KnownProvider 字面量联合（pi-ai types.d.ts:8） */
    provider: KnownProvider;
    /** 模型 ID（如 "deepseek-v4-flash"） */
    name: string;
  };
  apiKey: string;
  headers?: Record<string, string>;
}

/** 从 LlmConfig 构造 AgentRuntime（纯 SDK，无 PI） */
export function createRuntimeFromConfig(config: LlmConfig): AgentRuntime {
  return {
    model: getModel(config.model.provider, config.model.name as never),
    streamFn: streamSimple,
    getApiKey: async () => config.apiKey,
  };
}

/** provider → 标准环境变量（key 探测链第 2 级） */
const PROVIDER_ENV_KEYS: Partial<Record<KnownProvider, string>> = {
  openai: "OPENAI_API_KEY",
  "openai-codex": "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

/**
 * MCP 客户端名（initialize 的 clientInfo.name）→ 默认模型。
 * 模型 ID 已查证存在（pi-ai models.generated.js：openai/gpt-5.1-codex-mini、
 * claude-sonnet-4-5）。未命中时回退 DEFAULT_MODEL。
 */
const CLIENT_MODEL_DEFAULTS: Record<string, { provider: KnownProvider; name: string }> = {
  codex: { provider: "openai", name: "openai/gpt-5.1-codex-mini" },
  "claude-desktop": { provider: "anthropic", name: "claude-sonnet-4-5" },
  "claude-code": { provider: "anthropic", name: "claude-sonnet-4-5" },
};

/** 缺省模型（无显式配置且客户端名未命中映射） */
const DEFAULT_MODEL: { provider: KnownProvider; name: string } = {
  provider: "deepseek",
  name: "deepseek-v4-flash",
};

/**
 * 从 Codex 凭据文件读 key（key 探测链第 3 级）。
 * Codex 官方凭据位置：$CODEX_HOME/auth.json（缺省 ~/.codex/auth.json），
 * 字段为 OPENAI_API_KEY（与 Codex CLI 自身读取一致，复用存量）。
 */
export async function readCodexAuthKey(): Promise<string | undefined> {
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  try {
    const raw = await readFile(join(codexHome, "auth.json"), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const key = parsed["OPENAI_API_KEY"];
    return typeof key === "string" && key.length > 0 ? key : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 配置探测链（2026-08-01，支持"外部服务注入凭据"）：
 *
 * - 模型：显式 NE_LLM_PROVIDER / NE_LLM_MODEL 优先；
 *   否则按 MCP 客户端名映射（codex → openai / claude-desktop → anthropic）；
 *   再否则 deepseek / deepseek-v4-flash。
 * - key：NE_LLM_API_KEY → provider 标准 env（OPENAI_API_KEY 等）→ Codex auth.json
 *   （auth.json 仅当 provider 为 openai/openai-codex 时兜底，避免错配）。
 */
export async function loadLlmConfig(opts?: { clientName?: string }): Promise<LlmConfig> {
  const explicitProvider = process.env.NE_LLM_PROVIDER;
  const explicitModel = process.env.NE_LLM_MODEL;

  const mapped = opts?.clientName
    ? CLIENT_MODEL_DEFAULTS[opts.clientName.trim().toLowerCase()]
    : undefined;
  const provider = (explicitProvider ?? mapped?.provider ?? DEFAULT_MODEL.provider) as KnownProvider;
  const name = explicitModel ?? mapped?.name ?? DEFAULT_MODEL.name;

  const explicitKey = process.env.NE_LLM_API_KEY;
  const providerEnvKey = PROVIDER_ENV_KEYS[provider];
  const envKey = providerEnvKey ? process.env[providerEnvKey] : undefined;
  const useAuthKey = provider === "openai" || provider === "openai-codex";
  const authKey = useAuthKey ? await readCodexAuthKey() : undefined;

  const apiKey = explicitKey ?? envKey ?? authKey;
  if (!apiKey) {
    throw new Error(
      `缺少 API Key：已尝试 NE_LLM_API_KEY${providerEnvKey ? ` / ${providerEnvKey}` : ""}` +
        `${useAuthKey ? " / Codex auth.json" : ""}，均未找到。` +
        "请设置任一来源（接入 Codex/Claude 等客户端时，服务器会自动读取其现有凭据）。",
    );
  }
  return { model: { provider, name }, apiKey };
}
