// src/planner-rule-loader.ts
/**
 * planner-rule-loader.ts — planner 规则集加载（已收回，D7 定案 2026-08-09）
 *
 * 历史：planner 规则集.md（检索策略/信息差原则/数量控制）曾作为外部可编辑文件
 * 注入 planner LLM system prompt 开头。
 *
 * v3 定案（prompt-research.md §九 D7）：三块内容描述的是引擎行为而非作品内容，
 * 收回引擎自维护（已固化进 @pi/scheduler buildPlannerSystemPrompt 内置段），
 * 不再开放外部编辑。文件退位（模板与实盘删除）。
 *
 * 本加载器保留函数签名（chat-context 装配面不动），恒返回空串——
 * 附加规则集参数在 buildPlannerSystemPrompt 中兼容保留（空即跳过）。
 */

export async function loadPlannerRuleSet(_novelCwd: string): Promise<string> {
  return "";
}
