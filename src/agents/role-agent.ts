// src/agents/role-agent.ts
/**
 * role-agent.ts — 角色代理工厂
 *
 * 依据：docs/plans/2026-07-31-subagent-orchestrator-design.md §3.3
 *
 * 职责：基于身份定位 + 可见知识，进行角色交互扮演。
 * 生命周期：**无状态、用完即弃**——每次事件创建新 Agent 实例，事件处理完销毁。
 *
 * 可见性约束：本阶段经上下文注入（systemPrompt/messages），不注入 world_* 工具；
 * 阶段 2 接数据层后改为注入受限的 world-graph 查询工具（编排器构造）。
 *
 * 串行模式：编排器将上一角色输出直接注入为下一角色 Agent 的输入消息。
 */

import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import { createCharacterActionTool } from "./tools.ts";

/**
 * 创建角色子代理（无状态，单事件实例）
 *
 * @param model pi-ai Model（LlmConfigStore.getModel 产出）
 * @param apiKey 模型 API Key（LlmConfigStore.getApiKey 产出）
 * @param systemPrompt 角色系统提示词（规则集 + 角色卡 + 用户特殊要求）
 * @param messages 初始消息（含事件指令 + 可见知识 / 前序角色输出）
 * @param extraTools 额外注入的受限世界图工具（阶段 A：characterId 绑定，自主查可见状态）
 */
export function createRoleAgent(
  model: Model<any>,
  apiKey: string,
  systemPrompt: string,
  messages: AgentMessage[],
  extraTools: AgentTool[] = [],
): Agent {
  return new Agent({
    initialState: {
      systemPrompt,
      model,
      tools: [createCharacterActionTool(), ...extraTools],
      messages,
    },
    streamFn: streamSimple,
    getApiKey: async () => apiKey,
  });
}
