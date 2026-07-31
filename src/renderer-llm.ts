// src/renderer-llm.ts
/**
 * renderer-llm.ts — RenderLlmCaller 的 pi-ai 实现
 *
 * 包装 @earendil-works/pi-ai 的 complete 函数，适配渲染器的纯文本生成接口。
 * 与 novel-importer 的 makeLlmCaller 区别：
 *   - novel-importer 用 LlmToolCaller（tool call 场景，返回结构化 JSON）
 *   - renderer 用 RenderLlmCaller（文本生成场景，返回纯文本）
 *
 * 2026-07-29 LLM 调用链改造：
 * - 工厂签名从 (model, apiKey, provider) 改为 (ctx: ExtensionContext)
 * - 模型与 API Key 全部复用 PI 本体配置
 * - 工厂改为 async：在构造时一次性解析 auth
 * - 设计依据：docs/plans/2026-07-29-config-ui-design.md §三
 */

import { complete } from "@earendil-works/pi-ai";
import type { RenderLlmCaller } from "@pi/renderer";
import type { TextContent } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai";
import type { LlmConfig } from "./orchestrator/llm-config.ts";

/**
 * 创建基于 pi-ai 的渲染器 LLM 调用器
 *
 * @param config LLM 配置（model provider/name + apiKey + headers）
 * @throws apiKey 为空时抛错
 */
export function makeRendererLlmCaller(config: LlmConfig): RenderLlmCaller {
  const model = getModel(config.model.provider, config.model.name as never);
  const apiKey = config.apiKey;
  const headers = config.headers;

  return async (systemPrompt: string, userMessage: string): Promise<string> => {
    const msg = await complete(
      model,
      {
        systemPrompt,
        messages: [{ role: "user", content: userMessage, timestamp: Date.now() }],
      },
      {
        apiKey,
        headers,
        maxTokens: 4000,
        temperature: 0.7, // 渲染需要一定创造性
      },
    );

    if (msg.stopReason === "error" || msg.stopReason === "aborted" || msg.errorMessage) {
      throw new Error(`渲染器 LLM 调用失败: ${msg.errorMessage ?? msg.stopReason}`);
    }

    // 提取文本块
    const textBlocks = msg.content.filter((b): b is TextContent => b.type === "text");
    if (textBlocks.length === 0) {
      throw new Error("渲染器 LLM 未返回文本内容");
    }

    return textBlocks.map((b) => b.text).join("");
  };
}
