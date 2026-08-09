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
 * 包含四部分：
 * 1. 检索策略 + 信息差原则 + 数量控制（v3 起引擎自维护，D7 定案——
 *    原「planner 规则集.md」的检索策略/信息差/数量控制三块收回引擎，
 *    不再开放外部编辑）
 * 2. 检索能力清单（让 LLM 知道有哪些 retrieval type 可用）
 * 3. property 中文词表（检索参考，与 world-graph Fact 表的中文属性名契约）
 * 4. 任务说明（输出格式约束）
 *
 * @param plannerRuleSet 附加规则集全文（兼容保留：空串即跳过；
 *   D7 后引擎恒传空，老项目残留文件不再注入）
 * @param _event 事件参数（保留，便于后续按事件类型差异化 prompt）
 * @returns system prompt 字符串
 */
export function buildPlannerSystemPrompt(
  plannerRuleSet: string,
  _event: StructuredEvent,
): string {
  const external = plannerRuleSet.trim()
    ? `\n# 项目检索规则（附加）\n\n${plannerRuleSet}\n`
    : "";
  return `# 调度器 planner 检索策略（引擎自维护）

- 参与角色自身的可见状态：character_view（兜底已由代码保证，可补充 modalityFilter）
- 事件涉及的具体事物（物品/地点/概念）：search_hybrid 查 Fact
- 角色之间的关系：relations 查对应实体
- 历史背景、很久以前的事件：search_text 按关键词查
- 需要完整了解某实体（含不可见属性）时：entity_snapshot（慎用，它不过可见性）
${external}
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

# recordedAsOf（事务时间，可选）

modify/insert 锚定历史事件时，若要"查改写前的世界状态"，调用 wg.recordedNow()
取当前事务时间坐标传入 recordedAsOf。日常推进（add）不需要使用。

仅 character_view / entity_snapshot / relations 生效（透传给 wg 查询 API）；
search_* 暂不支持（store.search 是 SDK 透传，无事务时间视图），传入会被
console.warn 警告并降级为不过滤。

# 检索数量控制（用户钦定：3-8 条宁精勿滥）

- 单事件检索项 3-8 条，宁精勿滥
- 每个参与角色至少 1 条 character_view（调度器会兜底补全，但你应主动覆盖）
- 每条检索项写清 label（用途说明），便于排查
- 硬上限 30 条（防上下文爆炸）

# 信息差原则（assignTo）

- A 角色不应看到 B 角色的内心独白（除非 B 公开表达过）
- 秘密、阴谋、他人内心，只 assignTo 知情者
- 涉及地点时检索地点快照，按"谁在场"分配
- 涉及物品时检索物品快照
- 历史事件回溯时用 search_text 检索过往剧情
- 拿不准时宁少勿多：信息少了角色会谨慎试探，信息多了会元游戏（全知）

# property 中文词表（检索时参考，引擎自维护）

世界图的 Fact 表用中文属性名。search_text / search_hybrid 的 query 应使用中文关键词匹配以下词表：

- character（角色）: 名字/性格/背景/说话风格/目标/能力/外貌/位置/心情/健康/当前行动/职业
- location（地点）: 名字/描述/类型/天气/时段/氛围
- item（物品）: 名字/材质/主人/历史/能力/状态/位置/磨损
- concept（概念）: 名字/规则/范围/元素
- 跨实体：信念.关于_{对象}.{方面} / 假设.关于_{对象}.{方面}

# 你的任务

基于事件指令 + 参与角色 + 执行建议，推导本次叙事需要检索什么信息，
以及每条检索结果应该分配给哪些角色（信息差分配）。

必须调用 retrieval_plan 工具输出结构化检索计划。
每个 RetrievalItem 必须含 type / params / assignTo / label 四字段。
assignTo 只能是参与角色 ID 之一。
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

/**
 * 构建 knowledge mapper LLM 的 system prompt（P0-3+6 修复，2026-07-27）
 *
 * knowledge_gained → declarationId 映射器的系统提示词。
 * 角色在一场戏中学到的 knowledge_gained 是自然语言字符串，需要映射到
 * world-graph 中已存在的 declarationId 才能写入 Visibility。
 *
 * @returns system prompt 字符串
 */
export function buildKnowledgeMapperSystemPrompt(): string {
  return `你是 knowledge_gained → declarationId 映射器。

# 任务
角色在一场戏中学到了一些新认知（knowledge_gained，自然语言字符串）。
你需要把这些认知映射到 world-graph 中已存在的 declarationId。

# 候选列表
我会提供当前 storyTime 时刻所有有效声明（candidates），每项含：
- declarationId: 唯一标识
- entityId: 所属实体
- property: 属性名（如 mood/location/weapon）
- value: 属性值

# 映射规则
1. 语义匹配：knowledge_gained 描述的内容应与 declaration 的 property+value 语义对齐
2. 一对多：一条 knowledge_gained 可能对应多条 declarationId（如"林冲杀了王伦"对应多个状态变更）
3. 无匹配：找不到合理匹配时返回 declarationId=null
4. 置信度：0-1 浮点数，>=0.5 才会被写入 Visibility

# 输出格式
JSON 数组，每项 { knowledge, declarationId, confidence }
declarationId 为 null 时表示无匹配`;
}

/**
 * 构建 knowledge mapper LLM 的 user message（P0-3+6 修复，2026-07-27）
 *
 * @param characterId 角色 ID
 * @param knowledgeItems knowledge_gained 字符串数组
 * @param candidates 候选 declarationId 列表（来自 wg.getAllDeclarationsAt）
 * @returns user message 字符串
 */
export function buildKnowledgeMapperUserMessage(
  characterId: string,
  knowledgeItems: string[],
  candidates: Array<{ declarationId: string; entityId: string; property: string; value: unknown }>,
): string {
  return `# 角色
${characterId}

# knowledge_gained 列表
${knowledgeItems.map((k, i) => `${i + 1}. ${k}`).join("\n")}

# 候选 declarationId 列表
${JSON.stringify(candidates, null, 2)}

# 请输出映射结果（JSON 数组）`;
}
