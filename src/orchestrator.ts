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
import type { OrchestratorPorts } from "./orchestrator/assembly.ts";
import { PlannerAgent } from "./agents/planner-agent.ts";
import { RoleAgent } from "./agents/role-agent.ts";
import { ReasoningAgent } from "./agents/reasoning-agent.ts";
import { RendererAgent } from "./agents/renderer-agent.ts";
import type { WorldToolDeps } from "./agents/world-tools.ts";
import type { WorldGraphDataAccess } from "./data/world-graph-data-access.ts";
import { assertPathInside } from "./path-guard.ts";
import type { RetrievalPlan, SillyTavernCard } from "@pi/scheduler";
import type { RoleAgentOutput } from "@pi/role-pool";
import type { DebugBus, DebugSpan } from "./debug/types.ts";
import { startSpan, newTraceId } from "./debug/bus.ts";
// 软隔离导出：_resolveChapterPath（prompts.ts / chapter-resolver.ts 非跨包稳定 API）
import { _resolveChapterPath } from "@pi/scheduler";
import type { AgentRuntime } from "./agents/agent-runtime.ts";

/**
 * 子代理运行统一经 AgentRuntime.driveToReply（含整体超时兜底，见 agent-runtime.ts）：
 * 超时后中断子代理并抛错，让 runCommitPipeline catch → plan 转 error（可重试/丢弃），
 * 不再永久卡死。原 promptAndCollectWithTimeout（BUG-028 修复）已并入 driveToReply。
 */

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
   * 统一代理运行时：planner/role/reasoning/renderer 各 slot 经 resolveModel/resolveApiKey
   * 解析模型与 Key；createSession/driveToReply 创建并驱动一次性子代理会话。
   */
  agentRuntime: AgentRuntime;
  /** 应用级配置目录（%APPDATA%/narrative-engine；子代理 session 创建需要） */
  agentDir: string;
  cwd: string;
  /**
   * 章节目录（相对项目根，来自 novel.json chaptersDir；缺省 "正文"）。
   * v3（2026-08-09）：resolveChapterPath 缺省路径消费此字段，
   * 消灭旧事件级缺省 `chapters/<storyTime>.md`（双轨路径）。
   */
  chaptersDir?: string;
  plannerRuleSet: string;
  roleRuleSet: string;
  /**
   * 渲染规则集全文（已废弃，D11 渐进披露替代，2026-08-09）：
   * runRenderer 不再全文注入——<available_rules> 清单入 prompt，
   * 全文经 rules_read 按需读取。字段保留兼容（引擎恒传空串）。
   */
  renderRuleSet: string;
  /** 角色卡加载器（阶段 1 简单实现，阶段 2 接 staticCardLoader） */
  staticCardLoader: (characterId: string) => Promise<SillyTavernCard>;
  /** 数据层 Ports（阶段 A 注入：子代理工具经此读写世界图/章节） */
  ports: OrchestratorPorts;
  /** 统一世界图数据管道（由上游从 ProjectHandle 传入，不自建）；子代理工具经此读写 */
  dataAccess: WorldGraphDataAccess;
  /** 调试总线（四阶段 span 埋点；null/缺省为零开销 no-op） */
  debugBus?: DebugBus | null;
}

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

  /** 子代理工具依赖：统一数据管道 + 检索；storyTime 缺省走世界图最新时间点（保持现状语义） */
  private buildDeps(): WorldToolDeps {
    return {
      dataAccess: this.opts.dataAccess,
      search: this.opts.ports.search,
    };
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
        const plannerModel = this.opts.agentRuntime.resolveModel("planner");
        const planner = new PlannerAgent(
          this.opts.agentRuntime,
          { cwd: this.opts.cwd, agentDir: this.opts.agentDir },
          this.buildDeps(),
        );
        // 超时兜底已由 AgentRuntime.driveToReply 内置（默认 300s，超时中断子代理）
        plannerResult = await planner.run({
          event,
          ruleSet: this.opts.plannerRuleSet,
        }, { timeoutMs: 300_000 });
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
        const roleModel = this.opts.agentRuntime.resolveModel("role");
        for (const characterId of event.characterIds) {
          const card = await this.opts.staticCardLoader(characterId);
          const priorOutputsForAgent = [...priorOutputs];

          // 角色代理：注入受限世界图工具（characterId 绑定，自主查可见状态）
          const roleAgent = new RoleAgent(
            this.opts.agentRuntime,
            { cwd: this.opts.cwd, agentDir: this.opts.agentDir },
            this.buildDeps(),
          );
          // 超时兜底已由 AgentRuntime.driveToReply 内置；超时抛错落入 per-role catch
          // 记入 errors 不阻断流程（与「单角色失败不阻断」语义一致）
          try {
            const roleOut = await roleAgent.run({
              characterId,
              card,
              event,
              priorOutputs: priorOutputsForAgent,
              ruleSet: this.opts.roleRuleSet,
            }, { timeoutMs: 300_000 });
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
    /** BUG-028：commit 阶段进度回调（reasoning/rendering），供 service 层更新 plan.commitStage */
    onStage?: (stage: "reasoning" | "rendering") => void,
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
      onStage?.("reasoning");
      const reasoningSpan = startSpan(bus, "reasoner", traceId, { slot: "reasoning" }, parentId);
      let diffusion: DiffusionOutput;
      try {
        const reasoningModel = this.opts.agentRuntime.resolveModel("reasoning");
        diffusion = await this.runReasoning(
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
      onStage?.("rendering");
      const rendererSpan = startSpan(bus, "renderer", traceId, { slot: "renderer" }, parentId);
      let render: RenderOutput;
      try {
        const rendererModel = this.opts.agentRuntime.resolveModel("renderer");
        render = await this.runRenderer(
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
    event: StructuredEvent,
    outputs: RoleAgentOutput[],
    sink: string[],
  ): Promise<DiffusionOutput> {
    const reasoning = new ReasoningAgent(
      this.opts.agentRuntime,
      { cwd: this.opts.cwd, agentDir: this.opts.agentDir },
      this.buildDeps(),
    );
    // 超时兜底已由 AgentRuntime.driveToReply 内置（300s，超时中断子代理）
    const result = await reasoning.run({ event, outputs, sink }, { timeoutMs: 300_000 });
    return result.diffusion;
  }

  /** 渲染器子代理（阶段 A：注入章节工具，自主写章节） */
  private async runRenderer(
    event: StructuredEvent,
    eventId: string,
    outputs: RoleAgentOutput[],
    diffusion: DiffusionOutput,
  ): Promise<RenderOutput> {
    const chapterPath = this.resolveChapterPath(event);
    const renderer = new RendererAgent(
      this.opts.agentRuntime,
      { cwd: this.opts.cwd, agentDir: this.opts.agentDir },
      this.opts.ports,
    );
    // 超时兜底已由 AgentRuntime.driveToReply 内置（300s，超时中断子代理）
    const result = await renderer.run(
      { event, eventId, outputs, diffusion, chapterPath },
      { timeoutMs: 300_000 },
    );
    return result.render;
  }

  /**
   * 解析章节路径为绝对路径（相对路径基于项目根 opts.cwd）
   *
   * 关键修正（pure-SDK 后）：服务进程 cwd ≠ 项目目录，裸相对路径会被
   * 渲染器章节工具写到进程 cwd（扩展时代 pi 进程 cwd 即项目根，无此问题）。
   *
   * 安全（2026-08-03 代码审计 🔴-5）：任何输入路径必须落在项目根内，
   * 拒绝 `../` 越界（绝对路径也校验，防 LLM 被诱导读/写项目外文件）。
   *
   * v3（2026-08-09）：粒度 A 一章一文件——event.chapterPath 缺失时缺省路径
   * 从旧事件级 `chapters/<storyTime>.md` 改为章节级 `<chaptersDir>/第<N>章-未命名.md`
   * （消费 novel.json chaptersDir，经 @pi/scheduler resolveChapterPath 解析）。
   */
  private resolveChapterPath(event: StructuredEvent): string {
    if (event.chapterPath) {
      return assertPathInside(this.opts.cwd, event.chapterPath, "章节文件路径");
    }
    const p = _resolveChapterPath(this.opts.cwd, event.storyTime, this.opts.chaptersDir ?? "正文");
    return assertPathInside(this.opts.cwd, p, "章节文件路径");
  }
}
