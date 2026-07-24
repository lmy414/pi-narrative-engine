// src/renderer-llm.ts
/**
 * renderer-llm.ts — RenderLlmCaller 的 pi-ai 实现
 *
 * 包装 @mariozechner/pi-ai 的 complete 函数，适配渲染器的纯文本生成接口。
 * 与 novel-importer 的 makeLlmCaller 区别：
 *   - novel-importer 用 LlmToolCaller（tool call 场景，返回结构化 JSON）
 *   - renderer 用 RenderLlmCaller（文本生成场景，返回纯文本）
 */

import { complete, getModel } from "@mariozechner/pi-ai";
import type { RenderLlmCaller } from "@pi/renderer";
import type { TextContent } from "@mariozechner/pi-ai";

/**
 * 创建基于 pi-ai 的渲染器 LLM 调用器
 *
 * @param model 模型名（如 "deepseek-chat"）
 * @param apiKey API key
 * @param provider 提供商（默认 deepseek）
 */
export function makeRendererLlmCaller(
  model: string,
  apiKey: string,
  provider: string = "deepseek",
): RenderLlmCaller {
  return async (systemPrompt: string, userMessage: string): Promise<string> => {
    const modelObj = getModel(provider as never, model as never);
    const msg = await complete(
      modelObj,
      {
        systemPrompt,
        messages: [{ role: "user", content: userMessage, timestamp: Date.now() }],
      },
      {
        apiKey,
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
