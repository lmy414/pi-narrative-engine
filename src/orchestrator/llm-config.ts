// src/orchestrator/llm-config.ts
/**
 * llm-config.ts — LlmConfig / AgentRuntime 抽象（SDK 模式解耦点）
 *
 * 依据：docs/plans/2026-07-31-orchestrator-standalone-research.md §5.1
 *
 * 分层：
 * - AgentRuntime：子代理设计 §3.1 的解耦接口（model / streamFn / getApiKey），零 PI 依赖
 * - LlmConfig：SDK 模式配置源——从独立配置（env/文件/HTTP 参数）构造 AgentRuntime，
 *   替代 PI 适配器（pi-adapter.ts）
 * - loadLlmConfigFromEnv：env 配置源（独立运行最简单）
 *
 * 2026-07-31 复核修正：
 * - provider 用 KnownProvider 字面量类型（非裸 string），保留 getModel 第一参数类型安全
 * - getModel 第二参数断言 `as never`：该参数是字面量 keyof 联合（models.generated.ts），
 *   运行时 string 无法静态匹配；且 MODELS 类型不被 pi-ai exports 导出，无法引用窄化
 */

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
    /** 已查证：getModel 第一参数要求 KnownProvider 字面量联合（pi-ai types.ts:23-55） */
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

/**
 * env 配置源：NE_LLM_PROVIDER / NE_LLM_MODEL / NE_LLM_API_KEY
 * 缺省 provider/model 取 deepseek / deepseek-v4-flash（与 smoke 脚本一致）
 */
export function loadLlmConfigFromEnv(): LlmConfig {
  const provider = (process.env.NE_LLM_PROVIDER ?? "deepseek") as KnownProvider;
  const name = process.env.NE_LLM_MODEL ?? "deepseek-v4-flash";
  const apiKey = process.env.NE_LLM_API_KEY ?? process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("缺少 API Key：请设置 NE_LLM_API_KEY（或 DEEPSEEK_API_KEY）环境变量");
  }
  return { model: { provider, name }, apiKey };
}
