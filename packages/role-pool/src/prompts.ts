/**
 * prompts.ts — 角色池提示词模板
 *
 * 两部分：
 * - 系统提示词：内置角色扮演规则（v3 D8 起引擎自维护）+ 用户特殊要求（行为约束）
 * - 用户消息：角色卡（静态层）+ 当前状态（动态层）+ 先动者行动 + 事件指令（末尾，注意力最强）
 *
 * 结构原则（用户反馈）：
 * - 角色信息在前 → 让 LLM 先进入角色扮演状态
 * - 事件指令在末尾 → 注意力最强，驱动行动
 */

import type { CastMember, InteractCommand, PriorAction, FactSnapshot } from "./types.ts";

/**
 * 角色扮演规则（引擎自维护，D8 定案 2026-08-09）
 *
 * 原「角色规则集.md」整体收回引擎：扮演原则/输出纪律/词表（state_changes 中文
 * 属性名、relation_update 关系标签）为引擎行为约束与 world-graph 数据契约，
 * 不再开放外部编辑。orchestrator 角色子代理与 role_interact 共享本段
 * （见 src/orchestrator.ts buildRoleSystemPrompt 与 src/chat/role-tools.ts）。
 */
export const BUILTIN_ROLE_RULES = `# 角色扮演规则（引擎自维护）

## 扮演原则
- 用角色的知识、性格、目标驱动行动，不要用作者视角替角色规划
- 你只能知道动态层里有的信息；动态层没有的，就是不知道
- 不知道的事，角色会表现出不知道：疑惑、猜测、试探、误解
- 不要提及"规则""扮演""LLM""系统"等元概念

## 输出纪律
- action 写可观察的行为：别人能看到、听到的动作和话语
- thought 写内心活动：其他角色不可见，渲染器会间接呈现
- state_changes 只写确实发生变化的状态，没变的不写
- relation_update 只在关系确实变化时填写
- 不知道怎么办时，符合性格地犹豫、观察、回避也是有效行动

## state_changes 属性名词表（必须用中文）
state_changes 的 property 字段必须使用以下中文词表，禁止用英文（如 mood/location/name）：
- character（角色）: 名字/性格/背景/说话风格/目标/能力/外貌/位置/心情/健康/当前行动/职业
- location（地点）: 名字/描述/类型/天气/时段/氛围
- item（物品）: 名字/材质/主人/历史/能力/状态/位置/磨损
- concept（概念）: 名字/规则/范围/元素
- 跨实体信念: 信念.关于_{对象}.{方面}（如 信念.关于_彩叶.信任）
- 跨实体假设: 假设.关于_{对象}.{方面}
示例：{entityId: "ent_char_xxx", property: "心情", value: "愤怒", modality: "fact"}

## relation_update 关系标签词表
relation_update 的 label 字段使用中文关系标签：
- 仇敌/朋友/师徒/结义/恋人/上下级/亲属/同盟/敌对/认识/邻居/同事
- 角色在某地点用 label "located_in"（系统保留关键词，不要翻译）

## 静态层与动态层
- 静态层（角色卡）是长期不变的基础设定
- 动态层（当前状态）是最新事实，冲突时以动态层为准
- 例如静态层写"蓝发"但动态层显示"金发"，则以金发为准`;

/**
 * 构建系统提示词
 *
 * 三部分：
 * 1. 内置角色扮演规则（v3 D8 起引擎自维护，不再依赖外部文件）
 * 2. 外部附加规则集（兼容保留：D8 后引擎恒传空串，老项目残留文件不再注入）
 * 3. 用户特殊要求（executionHints，可选）
 *
 * 注入位置决策（2026-07-25）：executionHints 放在 system prompt 末尾独立段落，
 * 而非用户消息末尾。理由：
 * - 用户消息末尾是事件指令（注意力驱动行动），executionHints 是约束（不是行动）
 * - system prompt 是行为约束层（与规则集同层），executionHints 是"本次的特殊约束"
 * - 把约束放 system、把行动放 user，符合 LLM 注意力机制（指令强、约束隐式）
 *
 * @param member 当前角色
 * @param ruleSet 外部附加规则集全文（兼容保留，空即跳过）
 * @param executionHints 用户特殊要求（可选）
 */
export function buildSystemPrompt(
  member: CastMember,
  ruleSet: string,
  executionHints?: string,
): string {
  const parts: string[] = [];

  // 1. 内置角色扮演规则（v3 D8：扮演原则/输出纪律/词表/静态动态层说明）
  parts.push(BUILTIN_ROLE_RULES);
  parts.push("");

  // 2. 外部附加规则集（兼容保留）
  // 🟡（2026-08-08）：定界标记——规则集/角色卡是自由文本，可能含提示词
  // 定界符（如"以下为系统指令"）破坏结构；明确标注内容边界弱化注入面
  if (ruleSet.trim()) {
    parts.push("─── 角色规则集开始 ───");
    parts.push(ruleSet);
    parts.push("─── 角色规则集结束 ───");
    parts.push("");
  }

  // 3. 用户特殊要求（可选）
  if (executionHints && executionHints.trim()) {
    parts.push("─── 用户特殊要求（本次事件需遵守）───");
    parts.push(executionHints.trim());
    parts.push("─── 以上为用户特殊要求 ───");
  }

  // 引用 member 避免未使用警告（保留参数为接口一致性，未来可能用于按角色定制 prompt）
  void member;

  return parts.join("\n");
}

/**
 * 构建用户消息
 *
 * 顺序（角色信息在前，事件指令在末尾）：
 *   1. 你的 entityId + 本场角色名单（让 LLM 知道 characterId 该填什么）
 *   2. 角色卡（静态层）— 让 LLM 入戏
 *   3. 当前状态（动态层）
 *   4. 故事时间
 *   5. 先动者行动（如有）
 *   6. 事件指令 + tool call 要求（末尾，注意力最强）
 *
 * 2026-07-25 解决 Pending Gap #2：
 * - 把当前角色的 characterId 显式告诉 LLM（"你的 entityId 是 e_lin"）
 * - 把本场其他角色的 {characterId, name} 名单喂给 LLM
 * - tool call 要求 LLM 在 characterId 字段填自己的 entityId
 * - tool call 要求 LLM 在 relation_update.target 填对方 characterId（不是名字）
 * 这样调度器 commit 时可直接调 wg.addRelation(sourceId, targetId, ...) 无需"消解"
 */
export function buildUserMessage(
  cmd: InteractCommand,
  member: CastMember,
  priorActions: PriorAction[],
): string {
  const parts: string[] = [];

  // 0. 你的 entityId + 本场角色名单（让 LLM 知道 characterId 该填什么）
  parts.push(`[你的 entityId] ${member.characterId}`);
  parts.push("");
  parts.push("[本场角色名单]");
  for (const c of cmd.cast) {
    const isMe = c.characterId === member.characterId;
    parts.push(`- ${c.characterId}: ${c.staticCard.name}${isMe ? "（你）" : ""}`);
  }
  parts.push("");

  // 1. 角色卡（静态层）
  parts.push("─── 你的角色卡（静态层）───");
  parts.push(JSON.stringify(member.staticCard, null, 2));
  parts.push("─── 以上为静态层 ───");
  parts.push("");

  // 2. 当前状态（动态层）
  //    注意：动态层是该角色"可见的全部声明"（五步过滤结果），
  //    不止自身状态，还包括他所知的他人/他物信息——标题如实说明
  parts.push("─── 你所知道的世界状态（动态层，含你所知的他人/他物信息）───");
  if (member.dynamicFacts.length === 0) {
    parts.push("（无动态状态）");
  } else {
    // 按检索 label 分组渲染小标题（审计偏差 2：说明信息来源/用途）
    // 同一检索项的 Fact 连续排列（plan.ts 按 item 追加），label 变化时输出标题
    let currentLabel: string | undefined = undefined;
    for (const fact of member.dynamicFacts) {
      if (fact.label !== currentLabel) {
        currentLabel = fact.label;
        if (currentLabel) parts.push(`【${currentLabel}】`);
      }
      parts.push(formatFact(fact));
    }
  }
  parts.push("─── 以上为动态层 ───");
  parts.push("");

  // 3. 故事时间
  parts.push(`[故事时间] ${cmd.storyTime}`);
  parts.push("");

  // 4. 先动者行动（如有）
  if (priorActions.length > 0) {
    parts.push("[先动者行动]");
    for (const action of priorActions) {
      const target = action.target ? ` → ${action.target}` : "";
      parts.push(`- ${action.actor}：${action.action}${target}`);
    }
    parts.push("");
  }

  // 5. 事件指令 + tool call 要求（末尾）
  parts.push("[事件指令]");
  parts.push(cmd.eventInstruction);
  parts.push("");
  parts.push("请根据你的角色卡、当前状态、事件指令，以及先动者的行动，");
  parts.push("决定你在这个场景中的行动。");
  parts.push("");
  parts.push("你必须调用 character_action 工具输出，不要返回纯文本。");
  parts.push("");
  parts.push("⚠️ 字段填写规则：");
  parts.push(`- characterId 字段填你自己的 entityId（即 ${member.characterId}）`);
  parts.push("- relation_update.target 填对方角色的 characterId（不是名字，如 e_lin_chong）");
  parts.push("  从上方[本场角色名单]中选取对应 ID");

  return parts.join("\n");
}

/**
 * 格式化单条 Fact 为可读文本
 *
 * 2026-07-25（审计 P1/P2）：
 * - 带属主名：`- [属主] property: description（modality）`，解决动态层无归属问题
 *   （动态层可包含其他实体的可见声明，仅渲染 property 会让 LLM 分不清是谁的）
 * - 已闭合声明标注（旧）：知识持续语义下旧状态仍注入，需与当前状态区分
 */
function formatFact(fact: FactSnapshot): string {
  // 0.3.0：value/valueText 双轨删除，统一 description
  const description = fact.description;
  const owner = fact.ownerName ?? fact.entityId;
  const closed = fact.validTo && fact.validTo !== "Infinity";
  const modality = closed ? `${fact.modality}·旧` : fact.modality;
  return `- [${owner}] ${fact.property}: ${description}（${modality}）`;
}
