/**
 * role-pool-llm.ts — RoleLlmCaller 的 pi-ai 实现
 *
 * 包装 @earendil-works/pi-ai 的 complete + validateToolCall，适配角色池的 tool call 接口。
 * 与 novel-importer 的 makeLlmCaller 模式一致：
 *   - 定义 character_action 工具 schema（TypeBox）
 *   - complete 发起 LLM 请求，要求调用工具
 *   - validateToolCall 校验工具参数
 *   - 内置重试：LLM 偶发返回纯文本，在 caller 层重试
 *
 * 2026-07-29 LLM 调用链改造：
 * - 工厂签名从 (model, apiKey, provider) 改为 (ctx: ExtensionContext)
 * - 模型与 API Key 全部复用 PI 本体配置
 * - 工厂改为 async：在构造时一次性解析 auth
 * - 设计依据：docs/plans/2026-07-29-config-ui-design.md §三
 */

import { complete, validateToolCall, Type, StringEnum } from "@earendil-works/pi-ai";
import type { Tool } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai";
import type { RoleLlmCaller, RoleAgentOutput } from "@pi/role-pool";
import type { LlmConfig } from "./orchestrator/llm-config.ts";

const MAX_NO_TOOL_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

/**
 * character_action 工具 schema — 强制 LLM 通过 tool call 返回 RoleAgentOutput
 *
 * 9 字段（去掉 foreshadowings，待伏笔存储设计时加回）：
 * characterId / actor / action / target / emotion / relation_update / thought / knowledge_gained / state_changes
 *
 * 2026-07-25 解决 Pending Gap #2：
 * - 加 characterId 必填字段（LLM 填自己的 entityId）
 * - relation_update.target description 改为"对方 characterId（不是名字）"
 * 这样调度器 commit 时直接拿 source/target 调 wg.addRelation，无需"消解"
 */
export const characterActionSchema = Type.Object({
  characterId: Type.String({ description: "你自己的 entityId（即 prompt 中的[你的 entityId]，如 e_lin_chong）" }),
  actor: Type.String({ description: "行动者名字（角色卡中的 name）" }),
  action: Type.String({ description: "可观察的行动描述" }),
  target: Type.Optional(Type.String({ description: "行动对象" })),
  emotion: Type.Optional(Type.String({ description: "角色情绪" })),
  relation_update: Type.Optional(Type.Array(Type.Object({
    target: Type.String({ description: "对方角色的 characterId（不是名字，如 e_lu_qian）" }),
    label: Type.String({ description: "关系标签" }),
  }))),
  thought: Type.Optional(Type.String({ description: "内心独白（其他角色不可见）" })),
  knowledge_gained: Type.Optional(Type.Array(Type.String(), {
    description: "获得的知识列表",
  })),
  state_changes: Type.Optional(Type.Array(Type.Object({
    entityId: Type.String({ description: "目标实体 ID" }),
    property: Type.String({ description: "属性路径（如 mood / location）" }),
    value: Type.Unknown({ description: "新值" }),
    modality: StringEnum(["fact", "belief", "hypothesis"], {
      description: "fact=客观 / belief=信念 / hypothesis=猜测",
    }),
  }))),
});

export const characterActionTool: Tool = {
  name: "character_action",
  description: "提交角色本次行动的结构化输出。必须调用此工具一次提交结果。",
  parameters: characterActionSchema,
};

/**
 * 创建基于 pi-ai 的角色池 LLM 调用器
 *
 * @param config LLM 配置（model provider/name + apiKey + headers）
 * @throws apiKey 为空时抛错
 */
export function makeRoleLlmCaller(config: LlmConfig): RoleLlmCaller {
  const model = getModel(config.model.provider, config.model.name as never);
  const apiKey = config.apiKey;
  const headers = config.headers;
  const tools: Tool[] = [characterActionTool];

  return async (systemPrompt: string, userMessage: string): Promise<RoleAgentOutput> => {
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
          maxTokens: 4000,
          temperature: 0.7,
        },
      );

      if (msg.stopReason === "error" || msg.errorMessage) {
        throw new Error(`角色池 LLM 调用失败: ${msg.errorMessage ?? "unknown"}`);
      }

      const toolCall = msg.content.find((b) => b.type === "toolCall");
      if (!toolCall || toolCall.type !== "toolCall") {
        // LLM 未调用工具：caller 层重试
        if (attempt < MAX_NO_TOOL_RETRIES - 1) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        throw new Error(`LLM 未调用 character_action 工具（重试 ${MAX_NO_TOOL_RETRIES} 次后仍失败）`);
      }

      const params = validateToolCall(tools, toolCall) as Record<string, unknown>;
      return parseRoleAgentOutput(params);
    }
    throw new Error("makeRoleLlmCaller: unreachable");
  };
}

/**
 * 将 validateToolCall 返回的参数解析为 RoleAgentOutput
 * 处理可选数组字段的 undefined（项目记忆教训：用 ?? [] 兜底）
 *
 * 2026-07-25：characterId 是必填字段，LLM 应填入 prompt 提供的"你的 entityId"。
 * 若 LLM 偶发漏填，用空字符串兜底（下游调度器可检测并跳过该角色的关系写入）。
 */
function parseRoleAgentOutput(params: Record<string, unknown>): RoleAgentOutput {
  const output: RoleAgentOutput = {
    characterId: String(params.characterId ?? ""),
    actor: String(params.actor ?? ""),
    action: String(params.action ?? ""),
  };

  if (params.target !== undefined && params.target !== null) {
    output.target = String(params.target);
  }
  if (params.emotion !== undefined && params.emotion !== null) {
    output.emotion = String(params.emotion);
  }
  if (params.thought !== undefined && params.thought !== null) {
    output.thought = String(params.thought);
  }

  // 数组字段用 ?? [] 兜底（LLM 可能省略 required 字段）
  const relationUpdate = params.relation_update as Array<{ target: string; label: string }> | undefined;
  if (relationUpdate && relationUpdate.length > 0) {
    output.relation_update = relationUpdate;
  }

  const knowledgeGained = params.knowledge_gained as string[] | undefined;
  if (knowledgeGained && knowledgeGained.length > 0) {
    output.knowledge_gained = knowledgeGained;
  }

  const stateChanges = params.state_changes as Array<{
    entityId: string;
    property: string;
    value: unknown;
    modality: "fact" | "belief" | "hypothesis";
  }> | undefined;
  if (stateChanges && stateChanges.length > 0) {
    output.state_changes = stateChanges;
  }

  return output;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
