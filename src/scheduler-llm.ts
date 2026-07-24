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
 * 三种 LLM 配置从环境变量读取，优先级参考设计文档 §2.4：
 * - plannerLlm：PI_PLANNER_MODEL → PI_MODEL → deepseek-v4-flash
 * - roleLlm：   PI_ROLE_MODEL    → PI_MODEL → deepseek-v4-flash
 * - renderLlm： PI_RENDERER_MODEL → PI_MODEL → deepseek-v4-flash
 *
 * 设计依据：docs/plans/2026-07-25-scheduler-design.md §2.4
 */

import type { SchedulerCtx, SillyTavernCard } from "@pi/scheduler";
import { defaultStaticCardLoader } from "@pi/scheduler";
import type { WorldGraph } from "@pi/world-graph";
import { makePlannerLlmCaller } from "./planner-llm.ts";
import { makeRoleLlmCaller } from "./role-pool-llm.ts";
import { makeRendererLlmCaller } from "./renderer-llm.ts";
import { loadPlannerRuleSet } from "./planner-rule-loader.ts";
import { loadRoleRuleSet } from "@pi/role-pool";
import { loadRuleSet } from "@pi/renderer";
import type { Embedder } from "./embedder.ts";

/**
 * planner LLM 配置（从环境变量读取）
 *
 * 优先级：PI_PLANNER_MODEL → PI_MODEL → deepseek-v4-flash
 *         PI_PLANNER_API_KEY → PI_API_KEY → DEEPSEEK_API_KEY
 */
function getPlannerLlmConfig(): { model: string; apiKey: string } {
  const model = process.env.PI_PLANNER_MODEL ?? process.env.PI_MODEL ?? "deepseek-v4-flash";
  const apiKey = process.env.PI_PLANNER_API_KEY ?? process.env.PI_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? "";
  if (!apiKey) {
    throw new Error(
      "planner LLM apiKey 未配置（设置 PI_PLANNER_API_KEY / PI_API_KEY / DEEPSEEK_API_KEY 环境变量）",
    );
  }
  return { model, apiKey };
}

/**
 * role LLM 配置（从环境变量读取）
 *
 * [TODO] 与 src/index.ts 中的 getRoleLlmConfig 重复。
 * 后续应提取到 src/llm-config.ts 共享，避免三处定义。
 * 当前为最小改动，不破坏 index.ts 现有逻辑。
 */
function getRoleLlmConfig(): { model: string; apiKey: string } {
  const model = process.env.PI_ROLE_MODEL ?? process.env.PI_MODEL ?? "deepseek-v4-flash";
  const apiKey = process.env.PI_ROLE_API_KEY ?? process.env.PI_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? "";
  if (!apiKey) {
    throw new Error("角色池 LLM apiKey 未配置（设置 PI_ROLE_API_KEY / PI_API_KEY / DEEPSEEK_API_KEY 环境变量）");
  }
  return { model, apiKey };
}

/**
 * renderer LLM 配置（从环境变量读取）
 *
 * [TODO] 与 src/index.ts 中的 getRendererLlmConfig 重复。
 * 后续应提取到 src/llm-config.ts 共享，避免三处定义。
 */
function getRendererLlmConfig(): { model: string; apiKey: string } {
  const model = process.env.PI_RENDERER_MODEL ?? process.env.PI_MODEL ?? "deepseek-v4-flash";
  const apiKey = process.env.PI_RENDERER_API_KEY ?? process.env.PI_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? "";
  if (!apiKey) {
    throw new Error("渲染器 LLM apiKey 未配置（设置 PI_RENDERER_API_KEY / PI_API_KEY / DEEPSEEK_API_KEY 环境变量）");
  }
  return { model, apiKey };
}

/**
 * 构建 SchedulerCtx
 *
 * @param wg WorldGraph 实例
 * @param embedder Embedder 实例（用于 search_vector / search_hybrid）
 * @param cwd novel 工作目录（用于规则集加载和章节路径推断）
 * @returns SchedulerCtx 实例
 */
export async function makeSchedulerCtx(
  wg: WorldGraph,
  embedder: Embedder,
  cwd: string,
): Promise<SchedulerCtx> {
  const { model: plannerModel, apiKey: plannerApiKey } = getPlannerLlmConfig();
  const { model: roleModel, apiKey: roleApiKey } = getRoleLlmConfig();
  const { model: renderModel, apiKey: renderApiKey } = getRendererLlmConfig();

  const [plannerRuleSet, roleRuleSet, renderRuleSet] = await Promise.all([
    loadPlannerRuleSet(cwd),
    loadRoleRuleSet(cwd),
    loadRuleSet(cwd),
  ]);

  // 包装 embedder 为 SchedulerCtx.embedder 接口（只需 embed 方法）
  const embedderAdapter: { embed(text: string): Promise<number[]> } = {
    embed: (text: string) => embedder.embed(text),
  };

  // 默认 staticCardLoader：从 Entity+Facts 重组
  const staticCardLoader = async (
    characterId: string,
    storyTime: string,
  ): Promise<SillyTavernCard> => {
    return defaultStaticCardLoader(wg, characterId, storyTime);
  };

  return {
    wg,
    plannerLlm: makePlannerLlmCaller(plannerModel, plannerApiKey),
    roleLlm: makeRoleLlmCaller(roleModel, roleApiKey),
    renderLlm: makeRendererLlmCaller(renderModel, renderApiKey),
    embedder: embedderAdapter,
    roleRuleSet,
    renderRuleSet,
    plannerRuleSet,
    cwd,
    staticCardLoader,
  };
}
