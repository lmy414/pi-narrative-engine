import { Type } from "typebox";
import { complete, validateToolCall } from "@earendil-works/pi-ai";
import type { Model, Tool } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { interact, loadRoleRuleSet } from "@pi/role-pool";
import type { RoleAgentOutput, RoleLlmCaller } from "@pi/role-pool";
import { characterActionSchema } from "../agents/tools.ts";
import type { LlmConfigStore } from "../orchestrator/llm-config.ts";

const MAX_NO_TOOL_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

export const characterActionTool: Tool = {
  name: "character_action",
  description: "提交角色本次行动的结构化输出。必须调用此工具一次提交结果。",
  parameters: characterActionSchema,
};

export interface RoleToolsProvider {
  cwd: string;
  llmStore: LlmConfigStore;
  createLlmCaller?: (model: Model<any>, apiKey: string, headers?: Record<string, string>) => RoleLlmCaller;
}

function parseRoleAgentOutput(params: Record<string, unknown>): RoleAgentOutput {
  const output: RoleAgentOutput = {
    characterId: String(params.characterId ?? ""),
    actor: String(params.actor ?? ""),
    action: String(params.action ?? ""),
  };
  if (params.target !== undefined && params.target !== null) output.target = String(params.target);
  if (params.emotion !== undefined && params.emotion !== null) output.emotion = String(params.emotion);
  if (params.thought !== undefined && params.thought !== null) output.thought = String(params.thought);
  const relationUpdate = params.relation_update as RoleAgentOutput["relation_update"];
  if (relationUpdate?.length) output.relation_update = relationUpdate;
  const knowledgeGained = params.knowledge_gained as string[] | undefined;
  if (knowledgeGained?.length) output.knowledge_gained = knowledgeGained;
  const stateChanges = params.state_changes as RoleAgentOutput["state_changes"];
  if (stateChanges?.length) output.state_changes = stateChanges;
  return output;
}

function createDefaultLlmCaller(
  model: Model<any>,
  apiKey: string,
  headers?: Record<string, string>,
): RoleLlmCaller {
  const tools = [characterActionTool];
  return async (systemPrompt, userMessage) => {
    for (let attempt = 0; attempt < MAX_NO_TOOL_RETRIES; attempt++) {
      const msg = await complete(
        model,
        {
          systemPrompt,
          messages: [{ role: "user", content: userMessage, timestamp: Date.now() }],
          tools,
        },
        { apiKey, headers, maxTokens: 4000, temperature: 0.7 },
      );
      if (msg.stopReason === "error" || msg.stopReason === "aborted" || msg.errorMessage) {
        throw new Error(`角色池 LLM 调用失败: ${msg.errorMessage ?? msg.stopReason}`);
      }
      const toolCall = msg.content.find(block => block.type === "toolCall");
      if (!toolCall || toolCall.type !== "toolCall") {
        if (attempt < MAX_NO_TOOL_RETRIES - 1) {
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
          continue;
        }
        throw new Error(`LLM 未调用 character_action 工具（重试 ${MAX_NO_TOOL_RETRIES} 次后仍失败）`);
      }
      return parseRoleAgentOutput(validateToolCall(tools, toolCall) as Record<string, unknown>);
    }
    throw new Error("createRoleTools: unreachable");
  };
}

export function createRoleTools(provider: RoleToolsProvider): ToolDefinition[] {
  const role = () => (provider.createLlmCaller ?? createDefaultLlmCaller)(
    provider.llmStore.getModel("role"),
    provider.llmStore.getApiKey("role"),
    provider.llmStore.getHeaders("role"),
  );
  return [
    defineTool({ name: "role_interact", label: "Role Interact", description: "角色池串行演绎：按 cast 顺序逐个调用角色代理 LLM，后动者可见先动者的公开 action（不含 thought/emotion/state_changes）。返回 RoleAgentOutput[]（8 字段）+ 失败记录。调度器据此提取 state_changes 写扩散、投影为 RoleOutput[] 传渲染器。", promptSnippet: "角色池演出（串行可见行动，返回结构化输出）", parameters: Type.Object({ eventInstruction: Type.String({ description: "事件指令（自然语言）" }), storyTime: Type.String({ description: "故事时间（如 ch-2）" }), cast: Type.Array(Type.Object({ characterId: Type.String({ description: "角色实体 ID" }), staticCard: Type.Record(Type.String(), Type.Unknown(), { description: "静态层：酒馆角色卡 JSON（name/description/personality 等）" }), dynamicFacts: Type.Array(Type.Object({ declarationId: Type.String(), entityId: Type.String(), property: Type.String(), description: Type.String({ description: "状态描述文本（可读长句）" }), modality: Type.Union([Type.Literal("fact"), Type.Literal("belief"), Type.Literal("hypothesis")]), validFrom: Type.String() }), { description: "动态层：角色当前可见的状态声明（调度器通过 world_character_view 预取）" }) }), { description: "演员表，按出场顺序排列" }) }), async execute(_id: string, params: any) { const result = await interact(params as any, { llm: role(), ruleSet: await loadRoleRuleSet(provider.cwd) }); return { content: [{ type: "text", text: result.errors.length ? `角色池演出完成：${result.outputs.length} 成功，${result.errors.length} 失败` : `角色池演出完成：${result.outputs.length} 个角色输出` }], details: result }; } } as any),
    defineTool({ name: "role_rule_set", label: "Role Rule Set", description: "查看当前角色规则集.md 内容。无需参数。", promptSnippet: "查看角色规则集内容", parameters: Type.Object({}), async execute() { const ruleSet = await loadRoleRuleSet(provider.cwd); return { content: [{ type: "text", text: ruleSet || "（角色规则集.md 不存在或为空）" }], details: { ok: true, length: ruleSet.length, exists: ruleSet.length > 0 } }; } } as any),
  ];
}
