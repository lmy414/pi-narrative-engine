/**
 * prompts.ts — 渲染器提示词模板
 *
 * 两部分：
 * - 系统提示词（固定基础模板）：渲染器角色 + 输出协议 + 章节格式约定
 * - 用户消息（动态）：叙事指令 + 角色池数据 + 已有上下文 + 规则集（末尾，注意力最强）
 *
 * 规则集注入位置考究：拼在用户消息尾巴上，离 LLM 输出位置最近，注意力最强。
 */

import type { RenderTextCommand, RoleOutput } from "./types.ts";

/**
 * 渲染器系统提示词（固定，不含规则集）
 */
export const RENDERER_SYSTEM_PROMPT = `你是叙事引擎的渲染器。

# 你的职责
接收叙事指令 + 角色池结构化数据，将结构化数据渲染为自然语言叙事文本。
你不决定发生了什么（那是调度器和角色池的事），你只决定怎么写。

# 角色池字段说明
用户消息中的 [角色池结构化数据] 每个角色包含以下字段。**字段缺失 = 该维度不渲染**，不要脑补缺失的字段。

| 字段 | 作用 | 缺失时的处理 |
|------|------|-------------|
| actor | 角色名（必填） | — |
| action | 角色本次的动作（必填） | — |
| target | 动作对象（可选） | 动作无明确对象，不要编造目标 |
| emotion | 角色情绪状态（可选） | 不渲染情绪，不要给角色加内心感受 |
| relation_update | 关系变化（可选） | 关系不变，不要描述关系建立或改变 |
| thought | 角色内心活动（可选） | 不渲染心理，不要写"心中暗想"等心理描写 |
| knowledge_gained | 角色获得的新认知（可选） | 不渲染认知变化，不要描述角色"知道了/明白了"什么 |

**渲染原则**：
- 字段值是事实约束，不是要逐字翻译。把它们融入动作、对白、景物，而非罗列
- thought 给了就用动作/对白暗示，不要直接引用原文
- emotion 给了就用细节体现，不要直接写"他感到XX"
- 缺失的字段坚决不补——这是角色池的信号："本次不渲染这个维度"

# 输出协议
- 直接输出正文文本，无前后缀
- 不输出事件 ID
- 不输出 markdown 标题（#）
- 不输出任何元注释或说明
- 严格遵守用户消息末尾的规则集

# 章节文件格式约定
- 你产出的文本会被写入章节文件，前面自动加 <!-- event: <eventId> --> 锚点
- 你只需输出正文本身，不需要输出锚点
`;

/**
 * 构建用户消息
 *
 * 顺序（关键，注意力从弱到强）：
 *   1. 已有上下文（最弱）
 *   2. 叙事指令
 *   3. 角色池结构化数据
 *   4. 规则集（最强，末尾）
 *
 * @param cmd 渲染指令
 * @param ruleSet 规则集.md 全文
 */
export function buildUserMessage(cmd: RenderTextCommand, ruleSet: string): string {
  const parts: string[] = [];

  // 1. 已有上下文
  if (cmd.context) {
    parts.push(`[已有上下文]`);
    parts.push(cmd.context);
    parts.push("");
  }

  // 2. 叙事指令
  parts.push(`[叙事指令]`);
  // storyTime 注入（审计修复：此前字段必填但未进 prompt，渲染 LLM 看不到故事时间）
  parts.push(`（故事时间：${cmd.storyTime}）`);
  if (cmd.mode === "modify") {
    parts.push(`（重写模式：请重写事件 ${cmd.modifyAnchorEventId} 的内容，保持前后衔接）`);
  } else {
    parts.push(`（续写模式：在已有上下文之后续写新段落）`);
  }
  parts.push(cmd.instruction);
  parts.push("");

  // 3. 角色池结构化数据
  parts.push(`[角色池结构化数据]`);
  parts.push(formatPayload(cmd.payload));
  parts.push("");

  // 4. 规则集（末尾，注意力最强）
  if (ruleSet.trim()) {
    parts.push(`─── 规则集（严格遵守以下规则）───`);
    parts.push(ruleSet);
    parts.push(`─── 以上为本次渲染规则 ───`);
  }

  return parts.join("\n");
}

/**
 * 格式化角色池数据为可读文本
 */
function formatPayload(payload: RoleOutput[]): string {
  if (payload.length === 0) {
    return "（无角色池数据）";
  }
  return payload.map((r, i) => {
    const lines: string[] = [`角色 ${i + 1}:`];
    lines.push(`  actor: ${r.actor}`);
    lines.push(`  action: ${r.action}`);
    if (r.target) lines.push(`  target: ${r.target}`);
    if (r.emotion) lines.push(`  emotion: ${r.emotion}`);
    if (r.relation_update && r.relation_update.length > 0) {
      lines.push(`  relation_update:`);
      for (const ru of r.relation_update) {
        lines.push(`    - ${ru.target}: ${ru.label}`);
      }
    }
    if (r.thought) lines.push(`  thought: ${r.thought}`);
    if (r.knowledge_gained && r.knowledge_gained.length > 0) {
      lines.push(`  knowledge_gained: ${r.knowledge_gained.join(", ")}`);
    }
    return lines.join("\n");
  }).join("\n\n");
}
