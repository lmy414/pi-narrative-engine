// src/agents/role-agent.ts
/**
 * role-agent.ts — RoleAgent 子代理类
 *
 * 依据：docs/plans/2026-08-12-unified-agent-abstraction-execution.md 任务 2.2
 *
 * 职责：基于身份定位 + 可见知识，进行角色交互扮演。
 * 迁移自原 createRoleAgent 工厂（pi-agent-core Agent + terminate 工具），
 * 改为继承 BaseAgent（唯一底层 AgentSession）+ 指令收尾产出。
 *
 * 产出契约：reply.text 应为 fenced JSON，顶层含 `action` 字段（RoleAgentOutput）。
 */

import type { StructuredEvent, SillyTavernCard } from "@pi/scheduler";
import type { RoleAgentOutput } from "@pi/role-pool";
import { _BUILTIN_ROLE_RULES } from "@pi/role-pool";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { BaseAgent, OUTPUT_DISCIPLINE_SUFFIX } from "./base-agent.ts";
import type { AgentReply, AgentRuntime } from "./agent-runtime.ts";
import { extractFencedJson, AgentOutputParseError, toToolDefinition } from "./agent-runtime.ts";
import { createRoleLimitedTools, type WorldToolDeps } from "./world-tools.ts";
import type { LlmSlot } from "../orchestrator/llm-config.ts";

/** role 输入 */
export interface RoleInput {
  characterId: string;
  card: SillyTavernCard;
  event: StructuredEvent;
  /** 前序角色产出（串行：注入上一角色公开行动） */
  priorOutputs: RoleAgentOutput[];
  /** 角色规则集全文（兼容保留；D8 后引擎恒传空串） */
  ruleSet: string;
}

/** role 产出（顶层含 action 字段，与 orchestrator 消费一致） */
export interface RoleOutput {
  action: RoleAgentOutput;
}

/** role 子代理（一次性，forSubagent 轻量 prompt） */
export class RoleAgent extends BaseAgent<RoleInput, RoleOutput> {
  private readonly deps: WorldToolDeps;

  constructor(runtime: AgentRuntime, opts: { cwd: string; agentDir: string }, deps: WorldToolDeps) {
    super(runtime, opts);
    this.deps = deps;
  }

  protected getSlot(): LlmSlot {
    return "role";
  }

  protected buildSystemPrompt(input: RoleInput): string {
    const parts: string[] = [_BUILTIN_ROLE_RULES];
    if (input.ruleSet.trim()) {
      parts.push("─── 角色规则集开始 ───");
      parts.push(input.ruleSet);
      parts.push("─── 角色规则集结束 ───");
    }
    parts.push(
      `你是角色：${input.card.name ?? ""}`,
      `角色描述：${input.card.description ?? ""}`,
      input.event.executionHints ? `用户特殊要求：${input.event.executionHints}` : "",
    );
    parts.push(OUTPUT_DISCIPLINE_SUFFIX);
    parts.push(`
注入格式说明：你的最终结论应为如下 fenced JSON（action 字段为你的行动）：
\`\`\`json
{ "action": { "characterId": "${input.characterId}", "actor": "${input.card.name ?? ""}", "action": "你的可观察行动", "thought": "你的内心独白" } }
\`\`\`
characterId 字段必须填你自己的 entityId（${input.characterId}）；relation_update.target 填对方角色的 characterId（不是名字）。
`);
    return parts.filter(Boolean).join("\n\n");
  }

  protected buildUserPrompt(input: RoleInput): string {
    const lines = [
      `事件指令：${input.event.instruction}`,
      `故事时间：${input.event.storyTime}`,
      `你的 entityId：${input.characterId}`,
      input.card.scenario ? `当前场景：${input.card.scenario}` : "",
    ];
    // M-Qual-5：前序角色产出合并为单条 user message（连续多条 user 消息可能被 LLM 误解为多轮对话）
    if (input.priorOutputs.length > 0) {
      lines.push(
        "前序角色行动：",
        ...input.priorOutputs.map((prior) => `- ${prior.actor}：${prior.action}`),
      );
    }
    return lines.filter(Boolean).join("\n");
  }

  protected buildTools(input: RoleInput): ToolDefinition[] {
    return createRoleLimitedTools(this.deps, input.characterId).map(toToolDefinition);
  }

  protected extractOutput(reply: AgentReply): RoleOutput {
    const raw = extractFencedJson(reply.text);
    const action = (raw as { action?: unknown })?.action;
    if (!action || typeof action !== "object" || typeof (action as { action?: unknown })?.action !== "string") {
      throw new AgentOutputParseError(
        "role 产出缺少 action 字段或 action.action 非字符串",
        JSON.stringify(raw).slice(0, 500),
      );
    }
    return { action: action as RoleAgentOutput };
  }
}