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
 * @param member 当前角色
 * @param ruleSet 角色规则集.md 全文
 */
export function buildSystemPrompt(member: CastMember, ruleSet: string): string {
  const parts: string[] = [];

  // 1. 角色规则集.md（行为约束）
  if (ruleSet.trim()) {
    parts.push(ruleSet);
    parts.push("");
    parts.push("═══════════════════════════");
    parts.push("");
  }

  // 2. 静态/动态冲突提醒
  parts.push("⚠️ 重要规则：当静态层与动态层冲突时，以动态层为准。");
  parts.push("动态层记录角色当前最新状态，静态层是长期不变的基础信息。");
  parts.push('例如静态层写"蓝发"但动态层显示"金发"，则以金发为准。');

  return parts.join("\n");
}

/**
 * 构建用户消息
 *
 * 顺序（角色信息在前，事件指令在末尾）：
 *   1. 角色卡（静态层）— 让 LLM 入戏
 *   2. 当前状态（动态层）
 *   3. 故事时间
 *   4. 先动者行动（如有）
 *   5. 事件指令 + tool call 要求（末尾，注意力最强）
 */
export function buildUserMessage(
  cmd: InteractCommand,
  member: CastMember,
  priorActions: PriorAction[],
): string {
  const parts: string[] = [];

  // 1. 角色卡（静态层）
  parts.push("─── 你的角色卡（静态层）───");
  parts.push(JSON.stringify(member.staticCard, null, 2));
  parts.push("─── 以上为静态层 ───");
  parts.push("");

  // 2. 当前状态（动态层）
  parts.push("─── 你的当前状态（动态层）───");
  if (member.dynamicFacts.length === 0) {
    parts.push("（无动态状态）");
  } else {
    for (const fact of member.dynamicFacts) {
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
  parts.push("你必须调用 character_action 工具输出，不要返回纯文本。");

  return parts.join("\n");
}

/**
 * 格式化单条 Fact 为可读文本
 */
function formatFact(fact: FactSnapshot): string {
  const valueText = fact.valueText ?? String(fact.value);
  return `- ${fact.property}: ${valueText}（${fact.modality}）`;
}
