// src/orchestrator.ts
/**
 * orchestrator.ts — 编排器核心（纯代码，非 LLM）
 *
 * 依据：docs/plans/2026-07-31-subagent-orchestrator-design.md §二 + 
 *       docs/plans/2026-08-01-data-layer-ports-execution-plan.md §二/§四 A2
 *
 * 职责：
 * 1. 从队列取事件
 * 2. 启动 planner 子代理（阶段 A：只读工具注入见 A4）
 * 3. 启动角色代理（串行/并行，按可见性）
 * 4. 启动可见推理代理：经世界图写工具自主写入扩散（D1 决策，吸收 knowledge-mapper）
 * 5. 启动渲染器代理：经章节工具读上下文并写章节文件（D2 决策）
 * 6. 汇总结果；yolo 模式自动落地（D3 决策：写世界图 + 写章节 + 更新记忆）
 *
 * 解耦边界：依赖 AgentRuntime（llm-config.ts）+ 子代理工厂 + Ports 接口，
 * 不依赖 ExtensionContext。数据层读写统一经 OrchestratorPorts。
 */

import type { StructuredEvent } from "@pi/scheduler";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { LlmConfigStore } from "./orchestrator/llm-config.ts";
import type { OrchestratorPorts } from "./orchestrator/assembly.ts";
import { createPlannerAgent } from "./agents/planner-agent.ts";
import { createRoleAgent } from "./agents/role-agent.ts";
import { createReasoningAgent } from "./agents/reasoning-agent.ts";
import { createRendererAgent } from "./agents/renderer-agent.ts";
import { createReasoningTools, createPlannerTools, createRoleLimitedTools } from "./agents/world-tools.ts";
import { createRendererTools } from "./agents/chapter-tools.ts";
import { collectSubmission } from "./agents/collect.ts";
import { assertPathInside } from "./path-guard.ts";
import type { RetrievalPlan, SillyTavernCard } from "@pi/scheduler";
import type { RoleAgentOutput } from "@pi/role-pool";
import type { DebugBus, DebugSpan } from "./debug/types.ts";
import { startSpan, newTraceId } from "./debug/bus.ts";
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

/** 可见推理子代理产出（阶段 A：已应用世界图的摘要） */
export interface DiffusionOutput {
  /** 已应用的世界图事件 ID 列表（world_event_apply 返回） */
  appliedEventIds?: string[];
  /** 已应用的状态变化摘要 */
  changes: Array<{
    entityId: string;
    property: string;
    value: unknown;
    modality: "fact" | "belief" | "hypothesis";
  }>;
  /** 已应用的可见性变更摘要 */
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
  /** 章节写入是否成功（渲染器代理在 render_result 中如实填写） */
  ok?: boolean;
}

/** 后半链路落地摘要（写世界图 + 写章节 + 记忆更新） */
export interface CommitSummary {
  ok: boolean;
  appliedEventIds: string[];
  visibilityChanges: DiffusionOutput["visibilityChanges"];
  writtenText: string;
  chapterPath: string;
  errors: string[];
}

/** plan 详情中的前半链路阶段摘要 */
export interface PlanStage {
  stage: "planner" | "role";
  agent: string;
  status: "done" | "error";
  durationMs?: number;
  provider?: string;
  model?: string;
  error?: string;
}

/** 单次事件编排结果 */
export interface OrchestratorResult {
  /** plan 模式：planner + 角色产出（等 commit）；yolo 模式：全链路含 commit */
  mode: "plan" | "yolo";
  planId: string;
  eventId: string;
  chapterPath: string;
  /** 原始输入事件（阶段 A 补充：commit 需要完整 event 上下文） */
  event: StructuredEvent;
  outputs: RoleAgentOutput[];
  errors: { characterId: string; error: string }[];
  cast: { characterId: string; name: string; summary: string }[];
  retrievalPlan: RetrievalPlan;
  /** 仅记录已结束的 planner/role 前半链路阶段 */
  stages: PlanStage[];
  /** 可见推理 + 渲染产出（yolo 模式必有；plan 模式 commit 后回填） */
  diffusion?: DiffusionOutput;
  render?: RenderOutput;
  /** yolo 模式自动落地摘要 */
  commit?: CommitSummary;
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
  /** 数据层 Ports（阶段 A 注入：子代理工具经此读写世界图/章节） */
  ports: OrchestratorPorts;
  /** 调试总线（四阶段 span 埋点；null/缺省为零开销 no-op） */
  debugBus?: DebugBus | null;
}

/** 子代理结束约定：结论必须且只能通过产出工具一次提交，不得同一轮并行调用其他工具 */
const SUBMIT_ONLY_SYSTEM_PROMPT_SUFFIX =
  "\n\n⚠️ 重要约束：你的最终结论必须且只能通过产出提交工具一次提交。不要在同一轮调用其他工具。";

/** 可见推理代理系统提示词（阶段 A：自主查写世界图，再提交摘要） */
const REASONING_SYSTEM_PROMPT =
  "你是叙事引擎的状态扩散推理代理。消费所有角色产出，用世界图工具查询现状，" +
  "裁决哪些状态变化应写入世界图，并用写工具（world_event_apply / world_visibility_set / " +
  "world_relation_add 等）实际写入。最后必须且只能通过 diffusion_result 一次提交写入摘要（含 appliedEventIds）。";

/** 渲染器代理系统提示词（阶段 A：自主读写章节） */
const RENDERER_SYSTEM_PROMPT =
  "你是叙事引擎的渲染代理。消费角色产出与扩散结果，先用 chapter_read 读取章节衔接上下文，" +
  "生成正文后用 chapter_write 按事件意图（add/modify/insert）写入章节文件，" +
  "最后必须且只能通过 render_result 一次提交正文。";

/**
 * 编排器（阶段 A：数据层闭环）
 *
 * 链路：planner → 角色 → [可见推理（写世界图）→ 渲染器（写章节）→ 更新记忆]
 * - plan 模式：跑到角色产出即停，缓存在 service；commit 触发后半链路
 * - yolo 模式：全链路自动跑完（D3）
 */
export class Orchestrator {
  private readonly opts: OrchestratorOptions;

  constructor(opts: OrchestratorOptions) {
    this.opts = opts;
  }

  /** 运行一次事件编排（plan 或 yolo） */
  async run(event: StructuredEvent): Promise<OrchestratorResult> {    // 调试埋点：root span "orchestrator" + 四阶段子 span（无 bus 时零开销 no-op）
    const bus = this.opts.debugBus ?? null;
    const traceId = newTraceId();
    const rootSpan = startSpan(bus, "orchestrator", traceId, {
      storyTime: event.storyTime,
      instruction: event.instruction.slice(0, 200),
      mode: event.mode === "yolo" ? "yolo" : "plan",
      characterIds: event.characterIds,
    });
    try {
      const planId = `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const eventId = `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const stages: PlanStage[] = [];

      // 1. planner 子代理：注入世界图只读工具，查现状后产出检索计划
      const plannerSpan = startSpan(bus, "planner", traceId, { slot: "planner" }, rootSpan.eventId);
      const plannerStartedAt = Date.now();
      let plannerResult: { plan: RetrievalPlan };
      try {
        const plannerModel = this.opts.llmStore.getModel("planner");
        const plannerKey = this.opts.llmStore.getApiKey("planner");
        const planner = createPlannerAgent(
          plannerModel,
          plannerKey,
          _buildPlannerSystemPrompt(this.opts.plannerRuleSet, event) + SUBMIT_ONLY_SYSTEM_PROMPT_SUFFIX,
          [{ role: "user", content: _buildPlannerUserMessage(event), timestamp: Date.now() }],
          createPlannerTools(this.opts.ports),
        );
        const plannerCollected = collectSubmission<{ plan: RetrievalPlan }>(planner, "retrieval_plan");
        await planner.prompt("");
        plannerResult = await plannerCollected.promise;
        plannerCollected.dispose();
        plannerSpan.end({
          provider: plannerModel.provider,
          model: plannerModel.id,
          retrievalItems: plannerResult.plan.items?.length ?? 0,
        });
        stages.push({
          stage: "planner",
          agent: "planner",
          status: "done",
          durationMs: Date.now() - plannerStartedAt,
          provider: plannerModel.provider,
          model: plannerModel.id,
        });
      } catch (err) {
        plannerSpan.error(err);
        throw err;
      }

      // 2. 角色代理（串行：默认；上一角色输出注入下一角色）
      const outputs: RoleAgentOutput[] = [];
      const errors: { characterId: string; error: string }[] = [];
      const cast: { characterId: string; name: string; summary: string }[] = [];
      const priorOutputs: RoleAgentOutput[] = [];

      const roleSpan = startSpan(bus, "role", traceId, {
        slot: "role",
        characterIds: event.characterIds,
      }, rootSpan.eventId);
      const roleStartedAt = Date.now();
      try {
        const roleModel = this.opts.llmStore.getModel("role");
        const roleKey = this.opts.llmStore.getApiKey("role");
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
          // M-Qual-5：前序角色产出合并为单条 user message（此前每条 prior 各一条
          // user 消息，连续多条 user 消息可能被 LLM 误解为多轮对话）
          if (priorOutputs.length > 0) {
            userMessages.push({
              role: "user",
              content: priorOutputs
                .map((prior) => `【前序角色 ${prior.actor} 的行动】${prior.action}`)
                .join("\n\n"),
              timestamp: Date.now(),
            });
          }

          // 角色代理：注入受限世界图工具（characterId 绑定，自主查可见状态）
          const roleAgent = createRoleAgent(
            roleModel,
            roleKey,
            roleSystemPrompt,
            userMessages,
            createRoleLimitedTools(this.opts.ports, characterId),
          );
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
        // 单角色失败不阻断流程（记入 errors），role span 仍算结束
        roleSpan.end({
          provider: roleModel.provider,
          model: roleModel.id,
          outputs: outputs.length,
          errors: errors.length,
        });
        stages.push({
          stage: "role",
          agent: "role",
          status: errors.length > 0 ? "error" : "done",
          durationMs: Date.now() - roleStartedAt,
          provider: roleModel.provider,
          model: roleModel.id,
          ...(errors.length > 0
            ? { error: errors.map(({ characterId, error }) => `${characterId}: ${error}`).join(" | ") }
            : {}),
        });
      } catch (err) {
        roleSpan.error(err);
        throw err;
      }

      // 3. 汇总（plan 模式到此为止；yolo 模式跑后半链路并自动落地）
      const result: OrchestratorResult = {
        mode: event.mode === "yolo" ? "yolo" : "plan",
        planId,
        eventId,
        chapterPath: this.resolveChapterPath(event),
        event,
        outputs,
        errors,
        cast,
        retrievalPlan: plannerResult.plan,
        stages,
      };

      if (event.mode === "yolo") {
        if (outputs.length === 0) {
          // M-Logic-4 修复：所有角色失败（outputs 为空）时不跑后半链路——
          // 避免渲染器用空产出写出空章节文件；提交摘要如实标记失败并附角色错误
          const commit: CommitSummary = {
            ok: false,
            appliedEventIds: [],
            visibilityChanges: undefined,
            writtenText: "",
            chapterPath: this.resolveChapterPath(event),
            errors: errors.length > 0
              ? errors.map(({ characterId, error }) => `${characterId}: ${error}`)
              : ["无角色产出（characterIds 可能为空或全部失败）"],
          };
          result.diffusion = { changes: [] } as DiffusionOutput;
          result.render = { chapterPath: this.resolveChapterPath(event), text: "" } as RenderOutput;
          result.commit = commit;
        } else {
          const pipeline = await this.runPostRolePipeline(event, eventId, outputs, {
            traceId,
            parentId: rootSpan.eventId,
            roleErrors: errors,
          });
          result.diffusion = pipeline.diffusion;
          result.render = pipeline.render;
          result.commit = pipeline.commit;
        }
      }

      rootSpan.end({ mode: result.mode, planId, outputs: outputs.length, errors: errors.length });
      return result;
    } catch (err) {
      rootSpan.error(err);
      throw err;
    }
  }

  /**
   * 后半链路：可见推理（写世界图）→ 渲染器（写章节）→ 更新记忆
   *
   * plan 模式的 commit 与 yolo 模式的自动落地共用（D1/D2/D3）。
   *
   * @param event 原始输入事件
   * @param eventId 本次编排的渲染锚点 ID（run() 生成，plan 模式 commit 时复用）
   * @param outputs 角色产出
   * @param trace 调用方 trace（yolo 模式续 run 的 traceId；缺省时自建
   *   "orchestrator.commit" root span——plan 模式 commit 是一条新 trace）
   */
  async runPostRolePipeline(
    event: StructuredEvent,
    eventId: string,
    outputs: RoleAgentOutput[],
    trace?: { traceId: string; parentId?: string; roleErrors?: { characterId: string; error: string }[] },
  ): Promise<{ diffusion: DiffusionOutput; render: RenderOutput; commit: CommitSummary }> {
    const bus = this.opts.debugBus ?? null;
    const traceId = trace?.traceId ?? newTraceId();
    // plan 模式 commit：自成一条 trace，root span "orchestrator.commit"
    let rootSpan: (DebugSpan & { eventId: string }) | null = null;
    let parentId = trace?.parentId;
    if (!trace) {
      rootSpan = startSpan(bus, "orchestrator.commit", traceId, {
        storyTime: event.storyTime,
        eventId,
      });
      parentId = rootSpan.eventId;
    }
    try {
      // 已实际写入世界图的事件 ID（写工具 sink 记录 + diffusion 摘要回填），
      // 失败时附加到错误对象，让调用方（OrchestratorService.commit）如实返回
      const appliedSink: string[] = [];

      // 1. 可见推理代理：注入世界图只读+写工具，自主裁决并写入
      const reasoningSpan = startSpan(bus, "reasoner", traceId, { slot: "reasoning" }, parentId);
      let diffusion: DiffusionOutput;
      try {
        const reasoningModel = this.opts.llmStore.getModel("reasoning");
        diffusion = await this.runReasoning(
          reasoningModel,
          this.opts.llmStore.getApiKey("reasoning"),
          event,
          outputs,
          appliedSink,
        );
        reasoningSpan.end({
          provider: reasoningModel.provider,
          model: reasoningModel.id,
          appliedEventIds: diffusion.appliedEventIds?.length ?? 0,
          // B6：世界图变更摘要（编排页右栏"世界图变更摘要"卡数据源）
          changes: diffusion.changes.length,
          visibilityChanges: diffusion.visibilityChanges?.length ?? 0,
          changeList: diffusion.changes.slice(0, 20).map((c) => ({
            entityId: c.entityId,
            property: c.property,
            modality: c.modality,
          })),
        });
      } catch (err) {
        reasoningSpan.error(err);
        if (appliedSink.length > 0) {
          (err as Error & { appliedEventIds?: string[] }).appliedEventIds = [...appliedSink];
        }
        throw err;
      }

      // 2. 渲染器代理：注入章节工具，读上下文并写章节
      const rendererSpan = startSpan(bus, "renderer", traceId, { slot: "renderer" }, parentId);
      let render: RenderOutput;
      try {
        const rendererModel = this.opts.llmStore.getModel("renderer");
        render = await this.runRenderer(
          rendererModel,
          this.opts.llmStore.getApiKey("renderer"),
          event,
          eventId,
          outputs,
          diffusion,
        );
        rendererSpan.end({
          provider: rendererModel.provider,
          model: rendererModel.id,
          chapterPath: render.chapterPath,
          ok: render.ok !== false,
          // B6：章节信息（编排页右栏"生成章节卡"数据源；标题取正文首个一级标题）
          chars: (render.text ?? "").length,
          title: (render.text ?? "").match(/^#\s+(.+)$/m)?.[1] ?? null,
        });
      } catch (err) {
        rendererSpan.error(err);
        // 渲染阶段失败时世界图可能已写入：sink（写工具真实记录）优先，
        // diffusion 摘要（LLM 自报）去重补充
        const written = [...new Set([...appliedSink, ...(diffusion.appliedEventIds ?? [])])];
        if (written.length > 0) {
          (err as Error & { appliedEventIds?: string[] }).appliedEventIds = written;
        }
        throw err;
      }

      // M-Logic-3 修复：聚合 role 阶段错误到 CommitSummary.errors，
      // 客户端可看到角色失败信息（此前硬编码空数组丢失错误）。
      // 语义保持：单角色失败不阻断提交（errors 仅透出信息），ok 由渲染结果决定。
      const errors: string[] = (trace?.roleErrors ?? []).map(
        ({ characterId, error }) => `${characterId}: ${error}`,
      );
      const writtenText = render.text ?? "";
      const appliedEventIds = diffusion.appliedEventIds ?? [];
      const ok = render.ok !== false;

      const commit: CommitSummary = {
        ok,
        appliedEventIds,
        visibilityChanges: diffusion.visibilityChanges,
        writtenText,
        chapterPath: render.chapterPath,
        errors,
      };
      rootSpan?.end({ ok, appliedEventIds: appliedEventIds.length, chapterPath: render.chapterPath });
      return { diffusion, render, commit };
    } catch (err) {
      rootSpan?.error(err);
      throw err;
    }
  }

  /** 可见推理子代理（阶段 A：注入世界图工具，自主写世界图）；sink 记录实际写入的事件 ID */
  private async runReasoning(
    model: Model<any>,
    apiKey: string,
    event: StructuredEvent,
    outputs: RoleAgentOutput[],
    sink: string[],
  ): Promise<DiffusionOutput> {
    const tools = createReasoningTools(this.opts.ports, sink);
    const reasoning = createReasoningAgent(
      model,
      apiKey,
      REASONING_SYSTEM_PROMPT,
      [
        {
          role: "user",
          content: `事件：${event.instruction}\n故事时间：${event.storyTime}\n角色产出：\n${JSON.stringify(outputs, null, 2)}`,
          timestamp: Date.now(),
        },
      ],
      tools,
    );
    const collected = collectSubmission<{ diffusion: DiffusionOutput }>(reasoning, "diffusion_result");
    try {
      await reasoning.prompt("");
      const result = await collected.promise;
      return result.diffusion;
    } finally {
      collected.dispose();
    }
  }

  /** 渲染器子代理（阶段 A：注入章节工具，自主写章节） */
  private async runRenderer(
    model: Model<any>,
    apiKey: string,
    event: StructuredEvent,
    eventId: string,
    outputs: RoleAgentOutput[],
    diffusion: DiffusionOutput,
  ): Promise<RenderOutput> {
    const tools = createRendererTools(this.opts.ports, this.opts.cwd);
    const chapterPath = this.resolveChapterPath(event);
    const renderer = createRendererAgent(
      model,
      apiKey,
      RENDERER_SYSTEM_PROMPT,
      [
        {
          role: "user",
          content: `事件：${event.instruction}\n故事时间：${event.storyTime}\n章节路径：${chapterPath}\n事件意图：${event.intent ?? "add"}${event.targetEventId ? `\n目标锚点：${event.targetEventId}` : ""}\n你的渲染锚点 ID：${eventId}\n角色产出：\n${JSON.stringify(outputs, null, 2)}\n扩散结果：\n${JSON.stringify(diffusion, null, 2)}`,
          timestamp: Date.now(),
        },
      ],
      tools,
    );
    const collected = collectSubmission<{ render: RenderOutput }>(renderer, "render_result");
    try {
      await renderer.prompt("");
      const result = await collected.promise;
      return result.render;
    } finally {
      collected.dispose();
    }
  }

  /**
   * 解析章节路径为绝对路径（相对路径基于项目根 opts.cwd）
   *
   * 关键修正（pure-SDK 后）：服务进程 cwd ≠ 项目目录，裸相对路径会被
   * 渲染器章节工具写到进程 cwd（扩展时代 pi 进程 cwd 即项目根，无此问题）。
   *
   * 安全（2026-08-03 代码审计 🔴-5）：任何输入路径必须落在项目根内，
   * 拒绝 `../` 越界（绝对路径也校验，防 LLM 被诱导读/写项目外文件）。
   */
  private resolveChapterPath(event: StructuredEvent): string {
    const p = event.chapterPath ?? `chapters/${event.storyTime}.md`;
    return assertPathInside(this.opts.cwd, p, "章节文件路径");
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
