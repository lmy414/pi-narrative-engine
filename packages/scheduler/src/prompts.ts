/**
 * prompts.ts — planner LLM 提示词构建
 *
 * 设计文档 §3.6 planner LLM 调用细节的实现
 *
 * 输入：
 * - system prompt = plannerRuleSet + 检索能力清单 + 任务说明
 * - user message = 事件指令 + 故事时间 + 角色清单 + 执行建议
 *
 * 输出（由 plannerLlmCaller 解析 tool call）：
 * - RetrievalPlan 结构（一组 RetrievalItem）
 */

import type { StructuredEvent } from "./types.ts";

/**
 * 构建 planner LLM 的 system prompt
 *
 * 包含三部分：
 * 1. planner 规则集.md 全文（约束 planner LLM 的检索行为）
 * 2. 检索能力清单（让 LLM 知道有哪些 retrieval type 可用）
 * 3. 任务说明（输出格式约束）
 *
 * @param plannerRuleSet planner 规则集.md 全文
 * @param _event 事件参数（保留，便于后续按事件类型差异化 prompt）
 * @returns system prompt 字符串
 */
export function buildPlannerSystemPrompt(
  plannerRuleSet: string,
  _event: StructuredEvent,
): string {
  return `# 调度器 planner 规则集

${plannerRuleSet}

# 你可调用的检索能力

- character_view：查某角色可见的状态声明（信息差已过滤，Genette 内聚焦）
  - 参数：entityId（角色 ID），可选 modalityFilter（如 ["fact"] 只看事实）
  - 用途：让角色看到自己的当前状态、关系、持有物品等
- entity_snapshot：查某实体的完整快照（含所有属性，不管可见性）
  - 参数：entityId（实体 ID）
  - 用途：检索非角色实体（地点/物品/概念）的完整信息
- relations：查某实体的关系列表
  - 参数：entityId（实体 ID）
  - 用途：检索角色之间的关系、角色与地点的 located_in 等
- search_text：全文检索（关键词命中）
  - 参数：query（查询词），可选 limit
  - 用途：检索过往剧情中提到的关键词
- search_vector：向量检索（语义相似）
  - 参数：query（自然语言查询），可选 limit
  - 用途：检索语义相似的事件或状态
- search_hybrid：混合检索（全文+向量）
  - 参数：query，可选 limit
  - 用途：综合检索，覆盖关键词和语义

# 你的任务

基于事件指令 + 参与角色 + 执行建议，推导本次叙事需要检索什么信息，
以及每条检索结果应该分配给哪些角色（信息差分配）。

必须调用 retrieval_plan 工具输出结构化检索计划。
每个 RetrievalItem 必须含 type / params / assignTo / label 四字段。
assignTo 只能是参与角色 ID 之一。

# 检索数量建议

- 单事件检索项 5-15 条
- 每个参与角色至少 1 条 character_view（调度器会兜底补全，但你应主动覆盖）
- 不要超过 30 条（避免上下文爆炸）

# 信息差原则

- A 角色不应看到 B 角色的内心独白（除非 B 公开表达过）
- 涉及地点时检索地点快照，按"谁在场"分配
- 历史事件回溯时用 search_text 检索过往剧情
- 涉及物品时检索物品快照
`;
}

/**
 * 构建 planner LLM 的 user message
 *
 * 包含四部分：
 * 1. 事件指令（自然语言，主会话已加工）
 * 2. 故事时间
 * 3. 参与角色清单
 * 4. 执行建议（用户特殊要求）
 *
 * @param event 结构化事件
 * @returns user message 字符串
 */
export function buildPlannerUserMessage(event: StructuredEvent): string {
  const characterList = event.characterIds.map((id) => `- ${id}`).join("\n");
  const executionHints = event.executionHints ?? "(无特殊要求)";

  return `## 事件指令
${event.instruction}

## 故事时间
${event.storyTime}

## 参与角色
${characterList}

## 执行建议
${executionHints}

## 请输出检索计划

调用 retrieval_plan 工具，输出 RetrievalItem 数组。
每条 item 含 type / params / assignTo / label 四字段。`;
}
