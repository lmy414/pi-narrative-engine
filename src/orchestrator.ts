// src/orchestrator.ts
/**
 * orchestrator.ts — 编排器核心（纯代码，非 LLM）
 *
 * 依据：docs/plans/2026-07-31-orchestrator-standalone-research.md §四
 *
 * 职责：
 * 1. 从队列取事件
 * 2. 启动 planner 子代理（本阶段：上下文注入，产出检索计划）
 * 3. 启动角色代理（串行：上一角色输出注入下一角色；并行：互相不可见）
 * 4. 启动可见推理代理（产出 diffusion_result，不写世界图）
 * 5. 启动渲染器代理（产出 render_result，不写章节文件）
 * 6. 汇总结果
 *
 * 解耦边界：只依赖 AgentRuntime（llm-config.ts）+ 子代理工厂 + StructuredEvent 类型，
 * 不依赖 ExtensionContext。本阶段不注入任何 world_* 工具（阶段 2 接数据层）。
 */

import type { StructuredEvent } from "@pi/scheduler";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentRuntime, LlmConfigStore } from "./orchestrator/llm-config.ts";
import { createPlannerAgent } from "./agents/planner-agent.ts";
import { createRoleAgent } from "./agents/role-agent.ts";
import { createReasoningAgent } from "./agents/reasoning-agent.ts";
import { createRendererAgent } from "./agents/renderer-agent.ts";
import { collectSubmission } from "./agents/collect.ts";
import type { RetrievalPlan, SillyTavernCard } from "@pi/scheduler";
import type { RoleAgentOutput } from "@pi/role-pool";
// 软隔离导出：_buildPlannerSystemPrompt / _buildPlannerUserMessage（prompts.ts 非跨包稳定 API）
import { _buildPlannerSystemPrompt, _buildPlannerUserMessage } from "@pi/scheduler";

/** 角色可见性分配（planner 产出 → 编排器注入角色上下文） */
export interface VisibilityAssignment {
  characterId: string;
  /** 该角色可见的检索项 label 列表（本阶段透传，阶段 2 注入检索结果） */
  labels: string[];
}

/** planner 子代理产出（含执行模式建议） */
export interface PlannerOutput {
  retrievalPlan: RetrievalPlan;
  /** 串行/并行建议（阶段 1 暂由编排器裁定，阶段 2 由 planner 决策） */
  executionMode: "serial" | "parallel";
}

/** 可见推理子代理产出 */
export interface DiffusionOutput {
  /** change 事件提议（本阶段不写入，阶段 2 由编排器应用） */
  changes: Array<{
    entityId: string;
    property: string;
    value: unknown;
    modality: "fact" | "belief" | "hypothesis";
  }>;
  visibilityChanges?: Array<{
    characterId: string;
    declarationId: string;
    source: "experienced" | "informed" | "witnessed";
    confidence: number;
  }>;
}

/** 渲染器子代理产出 */
export interface RenderOutput {
  chapterPath: string;
  text: string;
}

/** 单次事件编排结果 */
export interface OrchestratorResult {
  /** plan 模式：planner + 角色产出（等 commit） */
  mode: "plan" | "yolo";
  planId: string;
  eventId: string;
  chapterPath: string;
  outputs: RoleAgentOutput[];
  errors: { characterId: string; error: string }[];
  cast: { characterId: string; name: string; summary: string }[];
  retrievalPlan: RetrievalPlan;
  /** yolo 模式：可见推理 + 渲染产出 */
  diffusion?: DiffusionOutput;
  render?: RenderOutput;
}

/** 编排器构造选项 */
export interface OrchestratorOptions {
  /**
   * 独立 LLM 配置中心：planner/role/reasoning/renderer 各 slot 经 API 注入
   * 各自的 provider/model/apiKey（用户可独立设置"角色扮演用什么模型、
   * 调度器用什么模型"）；未配置的 slot 回退 default → env 兜底。
   */
  llmStore: LlmConfigStore;
  cwd: string;
  plannerRuleSet: string;
  roleRuleSet: string;
  renderRuleSet: string;
  /** 角色卡加载器（阶段 1 简单实现，阶段 2 接 staticCardLoader） */
  staticCardLoader: (characterId: string) => Promise<SillyTavernCard>;
}

/** 子代理结束约定：结论必须且只能通过产出工具一次提交，不得同一轮并行调用其他工具 */
const SUBMIT_ONLY_SYSTEM_PROMPT_SUFFIX =
  "\n\n⚠️ 重要约束：你的最终结论必须且只能通过产出提交工具一次提交。不要在同一轮调用其他工具。";

/**
 * 编排器（本阶段核心）
 *
 * 注：本阶段为"本体独立设计"——planner 不执行真实检索、角色不查世界图、
 * 推理不写世界图、渲染不写文件。全部产出经子代理 tool call 收集，供阶段 2 接线。
 */
export class Orchestrator {
  private readonly opts: OrchestratorOptions;

  constructor(opts: OrchestratorOptions) {
    this.opts = opts;
  }

  /** 运行一次事件编排（plan 或 yolo） */
  async run(event: StructuredEvent): Promise<OrchestratorResult> {
    const plannerRt = await this.opts.llmStore.getRuntime("planner");
    const planId = `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const eventId = `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // 1. planner 子代理：产出检索计划
    const planner = createPlannerAgent(
      plannerRt,
      _buildPlannerSystemPrompt(this.opts.plannerRuleSet, event) + SUBMIT_ONLY_SYSTEM_PROMPT_SUFFIX,
      [{ role: "user", content: _buildPlannerUserMessage(event), timestamp: Date.now() }],
    );
    const plannerCollected = collectSubmission<{ plan: RetrievalPlan }>(planner, "retrieval_plan");
    await planner.prompt("");
    const plannerResult = await plannerCollected.promise;
    plannerCollected.dispose();

    // 2. 角色代理（串行：默认；上一角色输出注入下一角色）
    const outputs: RoleAgentOutput[] = [];
    const errors: { characterId: string; error: string }[] = [];
    const cast: { characterId: string; name: string; summary: string }[] = [];
    const priorOutputs: RoleAgentOutput[] = [];
    const roleRt = await this.opts.llmStore.getRuntime("role");

    for (const characterId of event.characterIds) {
      const card = await this.opts.staticCardLoader(characterId);
      const roleSystemPrompt = this.buildRoleSystemPrompt(card, event);
      const userMessages: AgentMessage[] = [
        {
          role: "user",
          content: this.buildRoleUserMessage(characterId, card, event),
          timestamp: Date.now(),
        },
      ];
      // 串行：注入前序角色公开产出
      for (const prior of priorOutputs) {
        userMessages.push({
          role: "user",
          content: `【前序角色 ${prior.actor} 的行动】${prior.action}`,
          timestamp: Date.now(),
        });
      }

      const roleAgent = createRoleAgent(roleRt, roleSystemPrompt, userMessages);
      const roleCollected = collectSubmission<{ action: RoleAgentOutput }>(roleAgent, "character_action");
      try {
        await roleAgent.prompt("");
        const roleOut = await roleCollected.promise;
        outputs.push(roleOut.action);
        priorOutputs.push(roleOut.action);
        cast.push({
          characterId,
          name: String(card.name ?? characterId),
          summary: String(card.description ?? ""),
        });
      } catch (err) {
        errors.push({
          characterId,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        roleCollected.dispose();
      }
    }

    // 3. yolo 模式：可见推理 + 渲染
    let diffusion: DiffusionOutput | undefined;
    let render: RenderOutput | undefined;
    if (event.mode === "yolo") {
      diffusion = await this.runReasoning(
        await this.opts.llmStore.getRuntime("reasoning"),
        event,
        outputs,
      );
      render = await this.runRenderer(
        await this.opts.llmStore.getRuntime("renderer"),
        event,
        outputs,
        diffusion,
      );
    }

    return {
      mode: event.mode === "yolo" ? "yolo" : "plan",
      planId,
      eventId,
      chapterPath: event.chapterPath ?? `chapters/${event.storyTime}.md`,
      outputs,
      errors,
      cast,
      retrievalPlan: plannerResult.plan,
      ...(diffusion ? { diffusion } : {}),
      ...(render ? { render } : {}),
    };
  }

  /** 可见推理子代理 */
  private async runReasoning(
    rt: AgentRuntime,
    event: StructuredEvent,
    outputs: RoleAgentOutput[],
  ): Promise<DiffusionOutput> {
    const reasoning = createReasoningAgent(
      rt,
      "你是叙事引擎的状态扩散推理代理。消费所有角色产出，推理哪些状态变化应写入世界图。" +
        SUBMIT_ONLY_SYSTEM_PROMPT_SUFFIX,
      [
        {
          role: "user",
          content: `事件：${event.instruction}\n角色产出：\n${JSON.stringify(outputs, null, 2)}`,
          timestamp: Date.now(),
        },
      ],
    );
    const collected = collectSubmission<{ diffusion: DiffusionOutput }>(reasoning, "diffusion_result");
    await reasoning.prompt("");
    const result = await collected.promise;
    collected.dispose();
    return result.diffusion;
  }

  /** 渲染器子代理 */
  private async runRenderer(
    rt: AgentRuntime,
    event: StructuredEvent,
    outputs: RoleAgentOutput[],
    diffusion: DiffusionOutput,
  ): Promise<RenderOutput> {
    const renderer = createRendererAgent(
      rt,
      "你是叙事引擎的渲染代理。把角色产出渲染为章节正文。" + SUBMIT_ONLY_SYSTEM_PROMPT_SUFFIX,
      [
        {
          role: "user",
          content: `事件：${event.instruction}\n章节路径：${event.chapterPath ?? ""}\n角色产出：\n${JSON.stringify(outputs, null, 2)}\n扩散结果：\n${JSON.stringify(diffusion, null, 2)}`,
          timestamp: Date.now(),
        },
      ],
    );
    const collected = collectSubmission<{ render: RenderOutput }>(renderer, "render_result");
    await renderer.prompt("");
    const result = await collected.promise;
    collected.dispose();
    return result.render;
  }

  /** 角色系统提示词：规则集 + 角色卡 */
  private buildRoleSystemPrompt(card: SillyTavernCard, event: StructuredEvent): string {
    return [
      this.opts.roleRuleSet,
      `你是角色：${card.name ?? ""}`,
      `角色描述：${card.description ?? ""}`,
      event.executionHints ? `用户特殊要求：${event.executionHints}` : "",
      SUBMIT_ONLY_SYSTEM_PROMPT_SUFFIX,
    ].filter(Boolean).join("\n\n");
  }

  /** 角色用户消息：事件指令 + 角色卡 */
  private buildRoleUserMessage(
    characterId: string,
    card: SillyTavernCard,
    event: StructuredEvent,
  ): string {
    return [
      `事件指令：${event.instruction}`,
      `故事时间：${event.storyTime}`,
      `你的 entityId：${characterId}`,
      card.scenario ? `当前场景：${card.scenario}` : "",
    ].filter(Boolean).join("\n");
  }
}
