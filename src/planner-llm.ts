// src/planner-llm.ts
/**
 * planner-llm.ts — PlannerLlmCaller 的 pi-ai 实现
 *
 * 包装 @earendil-works/pi-ai 的 complete + validateToolCall，适配调度器 planner LLM。
 *
 * 与 role-pool-llm.ts 模式一致：
 * - 定义 retrieval_plan 工具 schema（TypeBox）
 * - complete 发起 LLM 请求，要求调用工具
 * - validateToolCall 校验工具参数
 * - 内置重试：LLM 偶发返回纯文本，在 caller 层重试
 *
 * 2026-07-29 LLM 调用链改造：
 * - 工厂签名从 (model, apiKey, provider) 改为 (ctx: ExtensionContext)
 * - 模型与 API Key 全部复用 PI 本体配置
 * - 工厂改为 async：在构造时一次性解析 auth
 * - 设计依据：docs/plans/2026-07-29-config-ui-design.md §三
 *
 * 设计依据：docs/plans/2026-07-25-scheduler-design.md §3.6
 */

import { complete, validateToolCall, Type, StringEnum } from "@earendil-works/pi-ai";
import type { Tool } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PlannerLlmCaller, RetrievalPlan, RetrievalItem } from "@pi/scheduler";

const MAX_NO_TOOL_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

/**
 * retrieval_plan 工具 schema — 强制 LLM 通过 tool call 返回 RetrievalPlan
 *
 * RetrievalItem 4 字段：type / params / assignTo / label
 * params 内 nodeId / query / limit / fieldPath / modalityFilter 均可选（按 type 不同填不同字段）
 */
export const retrievalPlanSchema = Type.Object({
  items: Type.Array(Type.Object({
    type: StringEnum([
      "character_view",
      "entity_snapshot",
      "relations",
      "search_text",
      "search_vector",
      "search_hybrid",
    ], { description: "检索类型" }),
    params: Type.Object({
      entityId: Type.Optional(Type.String({ description: "character_view / entity_snapshot / relations 用" })),
      query: Type.Optional(Type.String({ description: "search_* 用（自然语言查询）" })),
      nodeType: Type.Optional(StringEnum(["Entity", "Fact", "Relation", "Visibility"], {
        description: "search_* 必填：检索节点类型。注意：search_vector/search_hybrid 仅支持 Entity/Fact（只有这两种节点声明了 embedding 字段），Relation/Visibility 请用 search_text",
      })),
      limit: Type.Optional(Type.Integer({ description: "检索上限（search_* 用）" })),
      fieldPath: Type.Optional(Type.String({ description: "向量字段路径（search_vector/hybrid 用，缺省 embedding）" })),
      modalityFilter: Type.Optional(Type.Array(StringEnum(["fact", "belief", "hypothesis"]), {
        description: "模态过滤（character_view 用）",
      })),
      recordedAsOf: Type.Optional(Type.String({
        description: "事务时间坐标（可选，P0-2 修复）。modify/insert 锚定历史事件时，若要\"查改写前的世界状态\"，调用 wg.recordedNow() 取当前事务时间传入。日常推进（add）不需要使用。仅 character_view/entity_snapshot/relations 生效；search_* 暂不支持（会降级为 console.warn）。",
      })),
    }),
    assignTo: Type.Array(Type.String(), {
      description: "这条检索结果分配给哪些角色 ID（信息差分配）",
    }),
    label: Type.String({ description: "检索项语义标签（注入角色提示词时用作小标题）" }),
  })),
});

export const retrievalPlanTool: Tool = {
  name: "retrieval_plan",
  description: "提交本次事件的检索计划。必须调用此工具一次提交结果。",
  parameters: retrievalPlanSchema,
};

/**
 * 创建基于 pi-ai 的 planner LLM 调用器
 *
 * @param ctx PI 扩展上下文（提供 ctx.model + ctx.modelRegistry）
 * @throws ctx.model 为空时抛错；API Key 未配置时抛错
 */
export async function makePlannerLlmCaller(ctx: ExtensionContext): Promise<PlannerLlmCaller> {
  const model = ctx.model;
  if (!model) {
    throw new Error("planner LLM: ctx.model 为空（请在 PI 内配置模型）");
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    throw new Error(
      auth.ok
        ? `planner LLM: ${model.provider} 未配置 API Key`
        : `planner LLM: 获取 API Key 失败: ${auth.error}`,
    );
  }
  const apiKey = auth.apiKey;
  const headers = auth.headers;
  const tools: Tool[] = [retrievalPlanTool];

  return async (systemPrompt: string, userMessage: string): Promise<RetrievalPlan> => {
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
          maxTokens: 2000, // 检索计划通常很短，无需 4000
          temperature: 0.3, // 检索推导需要稳定，降低随机性
        },
      );

      if (msg.stopReason === "error" || msg.errorMessage) {
        throw new Error(`planner LLM 调用失败: ${msg.errorMessage ?? "unknown"}`);
      }

      const toolCall = msg.content.find((b) => b.type === "toolCall");
      if (!toolCall || toolCall.type !== "toolCall") {
        // LLM 未调用工具：caller 层重试
        if (attempt < MAX_NO_TOOL_RETRIES - 1) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        throw new Error(`LLM 未调用 retrieval_plan 工具（重试 ${MAX_NO_TOOL_RETRIES} 次后仍失败）`);
      }

      const params = validateToolCall(tools, toolCall) as { items: unknown[] };
      return parseRetrievalPlan(params);
    }
    throw new Error("makePlannerLlmCaller: unreachable");
  };
}

/**
 * 将 validateToolCall 返回的参数解析为 RetrievalPlan
 *
 * 处理可选字段的 undefined（项目记忆教训：用 ?? [] 兜底）
 * 不校验 assignTo 中的角色 ID 是否在 characterIds 内（由 plan.ts 兜底过滤）
 */
function parseRetrievalPlan(params: { items: unknown[] }): RetrievalPlan {
  const items = Array.isArray(params.items) ? params.items : [];
  return {
    items: items.map((raw) => parseRetrievalItem(raw as Record<string, unknown>)),
  };
}

export function parseRetrievalItem(raw: Record<string, unknown>): RetrievalItem {
  const params = (raw.params ?? {}) as Record<string, unknown>;
  return {
    type: raw.type as RetrievalItem["type"],
    params: {
      entityId: typeof params.entityId === "string" ? params.entityId : undefined,
      query: typeof params.query === "string" ? params.query : undefined,
      nodeType: params.nodeType as RetrievalItem["params"]["nodeType"],
      limit: typeof params.limit === "number" ? params.limit : undefined,
      fieldPath: typeof params.fieldPath === "string" ? params.fieldPath : undefined,
      modalityFilter: Array.isArray(params.modalityFilter)
        ? (params.modalityFilter as RetrievalItem["params"]["modalityFilter"])
        : undefined,
      recordedAsOf: typeof params.recordedAsOf === "string" ? params.recordedAsOf : undefined,
    },
    assignTo: Array.isArray(raw.assignTo) ? (raw.assignTo as string[]) : [],
    label: typeof raw.label === "string" ? raw.label : "",
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
