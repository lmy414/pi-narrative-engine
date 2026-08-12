// src/agents/reasoning-agent.ts
/**
 * reasoning-agent.ts — ReasoningAgent 子代理类
 *
 * 依据：docs/plans/2026-08-12-unified-agent-abstraction-execution.md 任务 2.3
 *
 * 职责：消费所有角色产出 → 推理状态扩散 → 输出 change 事件 + visibilityChanges。
 * 迁移自原 createReasoningAgent 工厂（pi-agent-core Agent + terminate 工具），
 * 改为继承 BaseAgent（唯一底层 AgentSession）+ 指令收尾产出。
 *
 * 产出契约：reply.text 应为 fenced JSON，顶层含 `diffusion` 字段（DiffusionOutput）。
 */

import type { StructuredEvent } from "@pi/scheduler";
import type { RoleAgentOutput } from "@pi/role-pool";
import type { DiffusionOutput } from "../orchestrator.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { BaseAgent, OUTPUT_DISCIPLINE_SUFFIX } from "./base-agent.ts";
import type { AgentReply, AgentRuntime } from "./agent-runtime.ts";
import { extractFencedJson, AgentOutputParseError, toToolDefinition } from "./agent-runtime.ts";
import { createReasoningTools, type WorldToolDeps } from "./world-tools.ts";
import type { LlmSlot } from "../orchestrator/llm-config.ts";

/** reasoning 输入 */
export interface ReasoningInput {
  event: StructuredEvent;
  outputs: RoleAgentOutput[];
  /** 已实际写入世界图的事件 ID sink（写工具记录，失败溯源用） */
  sink: string[];
}

/** reasoning 产出（顶层含 diffusion 字段，与 orchestrator 消费一致） */
export interface ReasoningOutput {
  diffusion: DiffusionOutput;
}

/** 可见推理子代理（一次性，forSubagent 轻量 prompt） */
export class ReasoningAgent extends BaseAgent<ReasoningInput, ReasoningOutput> {
  private readonly deps: WorldToolDeps;

  constructor(runtime: AgentRuntime, opts: { cwd: string; agentDir: string }, deps: WorldToolDeps) {
    super(runtime, opts);
    this.deps = deps;
  }

  protected getSlot(): LlmSlot {
    return "reasoning";
  }

  protected buildSystemPrompt(): string {
    return (
      "你是叙事引擎的状态扩散推理代理。消费所有角色产出，用世界图工具查询现状，" +
      "裁决哪些状态变化应写入世界图，并用写工具（world_event_apply / world_visibility_set / " +
      "world_relation_add 等）实际写入。最后以 fenced JSON 提交写入摘要（含 appliedEventIds）。"
    ) + OUTPUT_DISCIPLINE_SUFFIX + `
注入格式说明：你的最终结论应为如下 fenced JSON（diffusion 字段为扩散结果摘要）：
\`\`\`json
{ "diffusion": { "appliedEventIds": ["evt_xxx"], "changes": [ { "entityId": "e_lin", "property": "心情", "value": "愤怒", "modality": "fact" } ], "visibilityChanges": [] } }
\`\`\`
`;
  }

  protected buildUserPrompt(input: ReasoningInput): string {
    return `事件：${input.event.instruction}\n故事时间：${input.event.storyTime}\n角色产出：\n${JSON.stringify(input.outputs, null, 2)}`;
  }

  protected buildTools(input: ReasoningInput): ToolDefinition[] {
    return createReasoningTools(this.deps, input.sink).map(toToolDefinition);
  }

  protected extractOutput(reply: AgentReply): ReasoningOutput {
    const raw = extractFencedJson(reply.text);
    const diffusion = (raw as { diffusion?: unknown })?.diffusion;
    if (!diffusion || typeof diffusion !== "object" || !Array.isArray((diffusion as { changes?: unknown })?.changes)) {
      throw new AgentOutputParseError(
        "reasoning 产出缺少 diffusion 字段或 changes 非数组",
        JSON.stringify(raw).slice(0, 500),
      );
    }
    return { diffusion: diffusion as DiffusionOutput };
  }
}