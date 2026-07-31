// src/scheduler-llm.ts
/**
 * scheduler-llm.ts — SchedulerCtx 工厂
 *
 * 整合调度器所需的四种依赖：
 * - plannerLlm：调 makePlannerLlmCaller（来自 planner-llm.ts）
 * - roleLlm：调 makeRoleLlmCaller（来自 role-pool-llm.ts）
 * - renderLlm：调 makeRendererLlmCaller（来自 renderer-llm.ts）
 * - embedder：从 session 级 Embedder 实例注入
 *
 * 2026-07-29 LLM 调用链改造：
 * - makeSchedulerCtx 签名增加 ctx: ExtensionContext 参数
 * - 4 路 caller 工厂改为接收 ctx，统一从 PI 本体获取模型与 API Key
 * - 删除对 llm-config.ts 的依赖
 * - 设计依据：docs/plans/2026-07-29-config-ui-design.md §三
 *
 * 设计依据：docs/plans/2026-07-25-scheduler-design.md §2.4
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SchedulerCtx, SillyTavernCard, DebugBus } from "@pi/scheduler";
import { defaultStaticCardLoader } from "@pi/scheduler";
import type { WorldGraph, EntitySnapshot, StateDeclaration } from "underworld-graph";
import { makePlannerLlmCaller } from "./planner-llm.ts";
import { makeRoleLlmCaller } from "./role-pool-llm.ts";
import { makeRendererLlmCaller } from "./renderer-llm.ts";
import { makeKnowledgeMapperLlmCaller } from "./knowledge-mapper-llm.ts";
import { loadPlannerRuleSet } from "./planner-rule-loader.ts";
import { loadRoleRuleSet } from "@pi/role-pool";
import { loadRuleSet } from "@pi/renderer";
import type { Embedder } from "./embedder.ts";

/**
 * 构建 SchedulerCtx
 *
 * @param wg WorldGraph 实例
 * @param embedder Embedder 实例（用于 search_vector / search_hybrid）
 * @param cwd novel 工作目录（用于规则集加载和章节路径推断）
 * @param ctx PI 扩展上下文（提供 ctx.model + ctx.modelRegistry，用于构造 LLM caller）
 * @param debugBus 调试事件总线（可选，注入后调度链关键点发射 DebugEvent）
 * @returns SchedulerCtx 实例
 */
export async function makeSchedulerCtx(
  wg: WorldGraph,
  embedder: Embedder,
  cwd: string,
  ctx: ExtensionContext,
  debugBus?: DebugBus,
): Promise<SchedulerCtx> {
  // 4 路 LLM caller 全部复用 PI 的 ctx.model + ctx.modelRegistry
  // caller 工厂内部一次性解析 auth，构造期间失败立即抛错
  const [plannerLlm, roleLlm, renderLlm, knowledgeMapper] = await Promise.all([
    makePlannerLlmCaller(ctx),
    makeRoleLlmCaller(ctx),
    makeRendererLlmCaller(ctx),
    makeKnowledgeMapperLlmCaller(ctx),
  ]);

  const [plannerRuleSet, roleRuleSet, renderRuleSet] = await Promise.all([
    loadPlannerRuleSet(cwd),
    loadRoleRuleSet(cwd),
    loadRuleSet(cwd),
  ]);

  // M3 修复（2026-07-30）：删除冗余的 embedderAdapter 包装
  // Embedder 类已实现 embed/embedEntity/embedFact 三方法，
  // TypeScript structural typing 自动满足 SchedulerCtx.embedder 接口。
  // mock 应在测试侧注入，不应在装配层加运行时包装。

  // 默认 staticCardLoader：从 Entity+Facts 重组
  const staticCardLoader = async (
    characterId: string,
    storyTime: string,
  ): Promise<SillyTavernCard> => {
    return defaultStaticCardLoader(wg, characterId, storyTime);
  };

  return {
    wg,
    plannerLlm,
    roleLlm,
    renderLlm,
    embedder,
    // P0-3+6 修复（2026-07-27）：注入 knowledge mapper
    // 2026-07-29 改造：不再"复用 planner 配置"，统一从 ctx.model 取
    knowledgeMapper,
    roleRuleSet,
    renderRuleSet,
    plannerRuleSet,
    cwd,
    staticCardLoader,
    // 2026-07-27 调试模块：注入 debugBus 启用调度链埋点
    // undefined 时 startSpan 为 no-op，零开销
    ...(debugBus ? { debugBus } : {}),
  };
}
