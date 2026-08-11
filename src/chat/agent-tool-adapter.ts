// src/chat/agent-tool-adapter.ts
/**
 * agent-tool-adapter.ts — AgentTool → ToolDefinition 薄 wrapper
 *
 * 依据：docs/plans/2026-08-10-worldgraph-dataaccess-and-visibility.md §五。
 *
 * 主会话消费统一 world-tools（AgentTool 形态）时，经此 wrapper 转为
 * pi-coding-agent 主会话的 ToolDefinition（customTools）。
 *
 * 依据：pi-coding-agent 内部存在 createToolDefinitionFromAgentTool
 * （dist/core/tools/tool-definition-wrapper.js），但未从包入口导出，故自写最小 wrapper：
 * - 拷贝 name/label/description/parameters/executionMode
 * - execute 直接转发（ToolDefinition.execute 多出的 ctx 参数忽略）
 * - promptSnippet 按工具名从 WORLD_TOOL_PROMPT_SNIPPETS 挂接（ToolDefinition 独有字段）
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { WORLD_TOOL_PROMPT_SNIPPETS } from "../agents/world-tools.ts";

/** 把统一 AgentTool 包装为主会话 ToolDefinition */
export function agentToolToToolDefinition(tool: AgentTool<any>): ToolDefinition {
  const snippet = WORLD_TOOL_PROMPT_SNIPPETS[tool.name];
  return defineTool({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    executionMode: tool.executionMode,
    promptSnippet: snippet,
    async execute(toolCallId: string, params: any, signal: any, onUpdate: any) {
      return tool.execute(toolCallId, params, signal, onUpdate);
    },
  } as any);
}