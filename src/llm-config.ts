/**
 * llm-config.ts — LLM 配置读取（planner / role / renderer 三路共用）
 *
 * 消除 src/index.ts 与 src/scheduler-llm.ts 的重复（原各有一份同构函数）。
 *
 * 环境变量优先级（以 role 为例）：
 * - 模型：PI_ROLE_MODEL → PI_MODEL → deepseek-v4-flash
 * - key： PI_ROLE_API_KEY → PI_API_KEY → DEEPSEEK_API_KEY
 */

export type LlmKind = "planner" | "role" | "renderer";

const KIND_LABEL: Record<LlmKind, string> = {
  planner: "planner LLM",
  role: "角色池 LLM",
  renderer: "渲染器 LLM",
};

const DEFAULT_MODEL = "deepseek-v4-flash";

/**
 * 读取指定路 LLM 的 { model, apiKey }
 *
 * @param kind 哪一路（planner / role / renderer）
 * @throws apiKey 未配置时抛错（模型名有缺省，key 无缺省）
 */
export function getLlmConfig(kind: LlmKind): { model: string; apiKey: string } {
  const prefix = kind.toUpperCase(); // PLANNER / ROLE / RENDERER
  const model =
    process.env[`PI_${prefix}_MODEL`] ?? process.env.PI_MODEL ?? DEFAULT_MODEL;
  const apiKey =
    process.env[`PI_${prefix}_API_KEY`] ??
    process.env.PI_API_KEY ??
    process.env.DEEPSEEK_API_KEY ??
    "";
  if (!apiKey) {
    throw new Error(
      `${KIND_LABEL[kind]} apiKey 未配置（设置 PI_${prefix}_API_KEY / PI_API_KEY / DEEPSEEK_API_KEY 环境变量）`,
    );
  }
  return { model, apiKey };
}
