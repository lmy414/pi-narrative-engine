// src/agents/renderer-agent.ts
/**
 * renderer-agent.ts — 渲染器代理工厂
 *
 * 依据：docs/plans/2026-07-31-subagent-orchestrator-design.md §3.5
 *
 * 职责：渲染正文。本阶段（用户澄清）：只产出 render_result（正文文本 + 章节路径），
 * 不写章节文件；阶段 2 接 RendererPort 后注入 readChapter / writeChapter 工具。
 */

import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentRuntime } from "../orchestrator/llm-config.ts";
import { createRenderResultTool } from "./tools.ts";

/**
 * 创建渲染器子代理
 *
 * @param rt AgentRuntime
 * @param systemPrompt 渲染系统提示词（渲染规则集）
 * @param messages 初始消息（角色产出 + 扩散结果 + 章节上下文）
 */
export function createRendererAgent(
  rt: AgentRuntime,
  systemPrompt: string,
  messages: AgentMessage[],
): Agent {
  return new Agent({
    initialState: {
      systemPrompt,
      model: rt.model,
      tools: [createRenderResultTool()],
      messages,
    },
    streamFn: rt.streamFn,
    getApiKey: rt.getApiKey,
  });
}
