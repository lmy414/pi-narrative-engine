// src/orchestrator/pi-adapter.ts
/**
 * pi-adapter.ts — PI 适配器（唯一与 PI 耦合的文件）
 *
 * 依据：docs/plans/2026-07-31-orchestrator-standalone-research.md §8.1
 *
 * 职责：从 ExtensionContext 构造 LlmConfig（pi-ai 原生配置：provider + model + apiKey）。
 * 编排器 / 子代理 / caller 工厂只依赖 LlmConfig（pi-ai 形态），不依赖 ExtensionContext。
 * 未来离开 PI 时，只需替换本文件（如 loadLlmConfigFromEnv 从 env 构造），
 * agent 代码零修改。
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KnownProvider } from "@earendil-works/pi-ai";
import type { LlmConfig } from "./llm-config.ts";

/**
 * 从 PI 扩展上下文构造 LlmConfig
 *
 * @param ctx PI 扩展上下文（提供 ctx.model + ctx.modelRegistry）
 * @throws ctx.model 为空时抛错；API Key 未配置时抛错
 */
export async function createLlmConfigFromCtx(ctx: ExtensionContext): Promise<LlmConfig> {
  const model = ctx.model;
  if (!model) {
    throw new Error("PI 适配器: ctx.model 为空（请在 PI 内配置模型）");
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    throw new Error(
      auth.ok
        ? `PI 适配器: ${model.provider} 未配置 API Key`
        : `PI 适配器: 获取 API Key 失败: ${auth.error}`,
    );
  }
  return {
    model: { provider: model.provider as KnownProvider, name: model.name },
    apiKey: auth.apiKey,
    headers: auth.headers,
  };
}
