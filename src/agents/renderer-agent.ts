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
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import { createRenderResultTool } from "./tools.ts";

/**
 * 创建渲染器子代理
 *
 * @param model pi-ai Model（LlmConfigStore.getModel 产出）
 * @param apiKey 模型 API Key（LlmConfigStore.getApiKey 产出）
 * @param systemPrompt 渲染系统提示词（渲染规则集）
 * @param messages 初始消息（角色产出 + 扩散结果 + 章节上下文）
 * @param extraTools 额外注入的章节工具（阶段 A：chapter_read / chapter_write，自主写章节）
 */
export function createRendererAgent(
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
      tools: [createRenderResultTool(), ...extraTools],
      messages,
    },
    streamFn: streamSimple,
    getApiKey: async () => apiKey,
  });
}
