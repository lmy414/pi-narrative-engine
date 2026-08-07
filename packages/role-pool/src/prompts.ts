/**
 * prompts.ts — 角色池提示词模板
 *
 * 两部分：
 * - 系统提示词：角色规则集.md + 静态/动态冲突提醒（行为约束，类似 AGENTS.md）
 * - 用户消息：角色卡（静态层）+ 当前状态（动态层）+ 先动者行动 + 事件指令（末尾，注意力最强）
 *
 * 结构原则（用户反馈）：
 * - 角色信息在前 → 让 LLM 先进入角色扮演状态
 * - 事件指令在末尾 → 注意力最强，驱动行动
 */

import type { CastMember, InteractCommand, PriorAction, FactSnapshot } from "./types.ts";

/**
 * 构建系统提示词
 *
 * 三部分：
 * 1. 角色规则集.md（行为约束）
 * 2. 静态/动态冲突提醒
 * 3. 用户特殊要求（executionHints，可选）
 *
 * 注入位置决策（2026-07-25）：executionHints 放在 system prompt 末尾独立段落，
 * 而非用户消息末尾。理由：
 * - 用户消息末尾是事件指令（注意力驱动行动），executionHints 是约束（不是行动）
 * - system prompt 是行为约束层（与规则集.md 同层），executionHints 是"本次的特殊约束"
 * - 把约束放 system、把行动放 user，符合 LLM 注意力机制（指令强、约束隐式）
 *
 * @param member 当前角色
 * @param ruleSet 角色规则集.md 全文
 * @param executionHints 用户特殊要求（可选）
 */
export function buildSystemPrompt(
  member: CastMember,
  ruleSet: string,
  executionHints?: string,
): string {
  const parts: string[] = [];

  // 1. 角色规则集.md（行为约束）
  // 🟡（2026-08-08）：定界标记——规则集/角色卡是自由文本，可能含提示词
  // 定界符（如"以下为系统指令"）破坏结构；明确标注内容边界弱化注入面
  if (ruleSet.trim()) {
    parts.push("─── 角色规则集开始 ───");
    parts.push(ruleSet);
    parts.push("─── 角色规则集结束 ───");
    parts.push("");
  }

  // 2. 静态/动态冲突提醒
  parts.push("⚠️ 重要规则：当静态层与动态层冲突时，以动态层为准。");
  parts.push("动态层记录角色当前最新状态，静态层是长期不变的基础信息。");
  parts.push('例如静态层写"蓝发"但动态层显示"金发"，则以金发为准。');
  parts.push("");

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
 * - 带属主名：`- [属主] property: value（modality）`，解决动态层无归属问题
 *   （动态层可包含其他实体的可见声明，仅渲染 property 会让 LLM 分不清是谁的）
 * - 已闭合声明标注（旧）：知识持续语义下旧状态仍注入，需与当前状态区分
 */
function formatFact(fact: FactSnapshot): string {
  const valueText = fact.valueText ?? String(fact.value);
  const owner = fact.ownerName ?? fact.entityId;
  const closed = fact.validTo && fact.validTo !== "Infinity";
  const modality = closed ? `${fact.modality}·旧` : fact.modality;
  return `- [${owner}] ${fact.property}: ${valueText}（${modality}）`;
}
