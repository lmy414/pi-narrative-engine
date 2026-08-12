// src/agents/planner-agent.ts
/**
 * planner-agent.ts — PlannerAgent 子代理类
 *
 * 依据：docs/plans/2026-08-12-unified-agent-abstraction-execution.md 任务 2.1
 *
 * 职责：查 world-graph 了解现状 → 决定检索策略 + 可见性分配 + 执行模式建议。
 * 迁移自原 createPlannerAgent 工厂（pi-agent-core Agent + terminate 工具），
 * 改为继承 BaseAgent（唯一底层 AgentSession）+ 指令收尾产出。
 *
 * 产出契约：reply.text 应为 fenced JSON，顶层含 `plan` 字段（RetrievalPlan）。
 */

import { _buildPlannerSystemPrompt, _buildPlannerUserMessage } from "@pi/scheduler";
import type { RetrievalPlan, StructuredEvent } from "@pi/scheduler";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { BaseAgent, OUTPUT_DISCIPLINE_SUFFIX } from "./base-agent.ts";
import type { AgentReply, AgentRuntime } from "./agent-runtime.ts";
import { extractFencedJson, AgentOutputParseError, toToolDefinition } from "./agent-runtime.ts";
import { createPlannerTools, type WorldToolDeps } from "./world-tools.ts";
import type { LlmSlot } from "../orchestrator/llm-config.ts";

/** planner 输入 */
export interface PlannerInput {
  event: StructuredEvent;
  /** planner 规则集全文（兼容保留；D7 后引擎恒传空串） */
  ruleSet: string;
}

/** planner 产出（顶层含 plan 字段，与 orchestrator 消费一致） */
export interface PlannerOutput {
  plan: RetrievalPlan;
}

/** planner 子代理（一次性，forSubagent 轻量 prompt） */
export class PlannerAgent extends BaseAgent<PlannerInput, PlannerOutput> {
  private readonly deps: WorldToolDeps;

  constructor(runtime: AgentRuntime, opts: { cwd: string; agentDir: string }, deps: WorldToolDeps) {
    super(runtime, opts);
    this.deps = deps;
  }

  protected getSlot(): LlmSlot {
    return "planner";
  }

  protected buildSystemPrompt(input: PlannerInput): string {
    return _buildPlannerSystemPrompt(input.ruleSet, input.event) + OUTPUT_DISCIPLINE_SUFFIX + `
注入格式说明：你的最终结论应为如下 fenced JSON（plan 字段为检索计划，items 为检索项数组）：
\`\`\`json
{ "plan": { "items": [ { "type": "character_view", "params": { "entityId": "e_lin" }, "assignTo": ["e_lin"], "label": "林冲当前状态" } ] } }
\`\`\`
`;
  }

  protected buildUserPrompt(input: PlannerInput): string {
    return _buildPlannerUserMessage(input.event);
  }

  protected buildTools(): ToolDefinition[] {
    return createPlannerTools(this.deps).map(toToolDefinition);
  }

  protected extractOutput(reply: AgentReply): PlannerOutput {
    const raw = extractFencedJson(reply.text);
    const plan = (raw as { plan?: unknown })?.plan;
    if (!plan || typeof plan !== "object" || !Array.isArray((plan as { items?: unknown })?.items)) {
      throw new AgentOutputParseError(
        "planner 产出缺少 plan 字段或 items 非数组",
        JSON.stringify(raw).slice(0, 500),
      );
    }
    return { plan: plan as RetrievalPlan };
  }
}