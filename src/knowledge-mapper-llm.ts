// src/knowledge-mapper-llm.ts
/**
 * knowledge-mapper-llm.ts — KnowledgeMapperLlmCaller 的 pi-ai 实现（P0-3+6 修复，2026-07-27）
 *
 * 包装 @earendil-works/pi-ai 的 complete + validateToolCall，实现
 * knowledge_gained → declarationId 的 LLM 语义映射。
 *
 * 与 planner-llm.ts 模式一致：
 * - 定义 knowledge_mapper 工具 schema（TypeBox）
 * - complete 发起 LLM 请求，要求调用工具
 * - validateToolCall 校验工具参数
 * - 内置重试：LLM 偶发返回纯文本，在 caller 层重试
 *
 * 2026-07-29 LLM 调用链改造：
 * - 工厂签名从 (model, apiKey, provider) 改为 (ctx: ExtensionContext)
 * - 不再"复用 planner 配置"——统一从 ctx.model 取
 * - 设计依据：docs/plans/2026-07-29-config-ui-design.md §三
 *
 * 设计依据：docs/audits/2026-07-27-fix-plan.md §五 阶段 3
 */

import { complete, validateToolCall, Type } from "@earendil-works/pi-ai";
import type { Tool } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KnowledgeMapperLlmCaller } from "@pi/scheduler";
import { buildKnowledgeMapperSystemPrompt, buildKnowledgeMapperUserMessage } from "@pi/scheduler";

const MAX_NO_TOOL_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

/**
 * knowledge_mapper 工具 schema — 强制 LLM 通过 tool call 返回映射结果
 *
 * 输出结构：{ mappings: Array<{ knowledge, declarationId | null, confidence }> }
 * - knowledge：原 knowledge_gained 字符串（回显，便于对齐）
 * - declarationId：映射到的候选 ID；null 表示无匹配
 * - confidence：0-1 浮点数，< 0.5 不写 Visibility
 */
const knowledgeMapperSchema = Type.Object({
  mappings: Type.Array(Type.Object({
    knowledge: Type.String({ description: "原 knowledge_gained 字符串（回显）" }),
    declarationId: Type.Union([Type.String(), Type.Null()], {
      description: "映射到的 declarationId；null 表示无匹配",
    }),
    confidence: Type.Number({
      minimum: 0,
      maximum: 1,
      description: "置信度 0-1；< 0.5 不写 Visibility",
    }),
  })),
});

const knowledgeMapperTool: Tool = {
  name: "knowledge_mapper",
  description: "把 knowledge_gained 自然语言映射到 declarationId。必须调用此工具一次提交结果。",
  parameters: knowledgeMapperSchema,
};

/**
 * 创建基于 pi-ai 的 knowledge mapper LLM 调用器
 *
 * @param ctx PI 扩展上下文（提供 ctx.model + ctx.modelRegistry）
 * @throws ctx.model 为空时抛错；API Key 未配置时抛错
 */
export async function makeKnowledgeMapperLlmCaller(ctx: ExtensionContext): Promise<KnowledgeMapperLlmCaller> {
  const model = ctx.model;
  if (!model) {
    throw new Error("knowledgeMapper LLM: ctx.model 为空（请在 PI 内配置模型）");
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    throw new Error(
      auth.ok
        ? `knowledgeMapper LLM: ${model.provider} 未配置 API Key`
        : `knowledgeMapper LLM: 获取 API Key 失败: ${auth.error}`,
    );
  }
  const apiKey = auth.apiKey;
  const headers = auth.headers;
  const tools: Tool[] = [knowledgeMapperTool];

  return async (characterId, knowledgeItems, candidates) => {
    const systemPrompt = buildKnowledgeMapperSystemPrompt();
    const userMessage = buildKnowledgeMapperUserMessage(characterId, knowledgeItems, candidates);

    for (let attempt = 0; attempt < MAX_NO_TOOL_RETRIES; attempt++) {
      const msg = await complete(
        model,
        {
          systemPrompt,
          messages: [{ role: "user", content: userMessage, timestamp: Date.now() }],
          tools,
        },
        {
          apiKey,
          headers,
          maxTokens: 2000,
          temperature: 0.2, // 映射任务需要确定性，降低随机性
        },
      );

      if (msg.stopReason === "error" || msg.errorMessage) {
        throw new Error(`knowledgeMapper LLM 调用失败: ${msg.errorMessage ?? "unknown"}`);
      }

      const toolCall = msg.content.find((b) => b.type === "toolCall");
      if (!toolCall || toolCall.type !== "toolCall") {
        // LLM 未调用工具：caller 层重试
        if (attempt < MAX_NO_TOOL_RETRIES - 1) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        throw new Error(`LLM 未调用 knowledge_mapper 工具（重试 ${MAX_NO_TOOL_RETRIES} 次后仍失败）`);
      }

      const params = validateToolCall(tools, toolCall) as { mappings: unknown[] };
      const rawMappings = Array.isArray(params.mappings) ? params.mappings : [];
      return rawMappings.map((m) => {
        const raw = m as Record<string, unknown>;
        return {
          knowledge: typeof raw.knowledge === "string" ? raw.knowledge : "",
          declarationId: typeof raw.declarationId === "string" ? raw.declarationId : null,
          confidence: typeof raw.confidence === "number" ? raw.confidence : 0,
        };
      });
    }
    throw new Error("makeKnowledgeMapperLlmCaller: unreachable");
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
