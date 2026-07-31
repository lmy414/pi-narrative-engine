// src/agents/reasoning-agent.ts
/**
 * reasoning-agent.ts — 可见推理代理工厂
 *
 * 依据：docs/plans/2026-07-31-subagent-orchestrator-design.md §3.4
 *
 * 职责：消费所有角色产出 → 推理状态扩散 → 输出 change 事件 + visibilityChanges。
 * 吸收原 knowledge-mapper-llm 职责：knowledge_gained → declarationId 映射
 * 由本代理在推理过程中完成（不再单独一步）。
 *
 * 本阶段（用户澄清）：只产出 diffusion_result，不写世界图。
 * 阶段 2 接数据层后注入写入工具（wg.processEvent / setVisibility / addRelation）。
 */

import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import { createDiffusionResultTool } from "./tools.ts";

/**
 * 创建可见推理子代理
 *
 * @param model pi-ai Model（LlmConfigStore.getModel 产出）
 * @param apiKey 模型 API Key（LlmConfigStore.getApiKey 产出）
 * @param systemPrompt 推理系统提示词（扩散规则）
 * @param messages 初始消息（所有角色产出 + 当前世界状态摘要）
 */
export function createReasoningAgent(
  model: Model<any>,
  apiKey: string,
  systemPrompt: string,
  messages: AgentMessage[],
): Agent {
  return new Agent({
    initialState: {
      systemPrompt,
      model,
      tools: [createDiffusionResultTool()],
      messages,
    },
    streamFn: streamSimple,
    getApiKey: async () => apiKey,
  });
}
