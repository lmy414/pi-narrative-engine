/**
 * rule-loader.ts — 角色规则集加载（已收回，D8 定案 2026-08-09）
 *
 * 历史：角色规则集.md（扮演原则/输出纪律/state_changes 词表/relation 词表/
 * 静态动态层说明）曾作为外部可编辑文件注入角色池 system prompt 开头。
 *
 * v3 定案（prompt-research.md §九 D8）：内容全部为引擎行为约束与
 * world-graph 数据契约，整体收回引擎自维护——已固化进
 * `prompts.ts` 的 `BUILTIN_ROLE_RULES` 内置段（orchestrator 角色子代理
 * 与 role_interact 共享），不再开放外部编辑。文件退位（模板与实盘删除）。
 *
 * 本加载器保留函数签名（chat-context / role-tools 装配面不动），恒返回空串——
 * 附加规则集参数在 buildSystemPrompt 中兼容保留（空即跳过）。
 */

export async function loadRoleRuleSet(_novelCwd: string): Promise<string> {
  return "";
}
