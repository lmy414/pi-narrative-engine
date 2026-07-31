// src/agents/planner-agent.ts
/**
 * planner-agent.ts — planner 子代理工厂
 *
 * 依据：docs/plans/2026-07-31-subagent-orchestrator-design.md §3.2
 *
 * 职责：查 world-graph 了解现状 → 决定检索策略 + 可见性分配 + 执行模式建议。
 * 本阶段（用户澄清：不接触世界图业务）：上下文经 systemPrompt/messages 注入，
 * 不注入 world_* 工具；子代理通过 `retrieval_plan` 产出提交工具返回结构化检索计划。
 *
 * 构造只依赖 AgentRuntime（解耦边界），不依赖 ExtensionContext。
 */

import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentRuntime } from "../orchestrator/llm-config.ts";
import { createRetrievalPlanTool } from "./tools.ts";

/**
 * 创建 planner 子代理
 *
 * @param rt AgentRuntime（model / streamFn / getApiKey）
 * @param systemPrompt planner 系统提示词（含规则集 + 事件指令）
 * @param messages 初始消息（事件上下文）
 */
export function createPlannerAgent(
  rt: AgentRuntime,
  systemPrompt: string,
  messages: AgentMessage[],
): Agent {
  return new Agent({
    initialState: {
      systemPrompt,
      model: rt.model,
      tools: [createRetrievalPlanTool()],
      messages,
    },
    streamFn: rt.streamFn,
    getApiKey: rt.getApiKey,
  });
}
