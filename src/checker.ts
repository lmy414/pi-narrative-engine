// src/checker.ts
/**
 * checker.ts — render_check 工具的检验逻辑
 *
 * 检验流程：
 * 1. 按 target 读取目标文本（latest/chapter/range/full）
 * 2. 使用调用方传入的规则集全文（与 renderer 对齐，不在内部读取）
 * 3. 构建 LLM 调用：检验员系统提示词 + 文本片段 + 规则集（末尾）
 * 4. 单次 LLM 调用，返回结构化违规清单+修改建议
 *
 * 注意：文本量过大时的拆分调度由主会话决策，本工具不内置。
 * 工具只做"取文本 + 用规则集 + 调一次 LLM + 返回结构化结果"。
 */

import {
  readChapter,
  readChapterSection,
  EVENT_ANCHOR_PREFIX,
  type RenderLlmCaller,
} from "@pi/renderer";

/** 检验目标 */
export type CheckTarget = "latest" | "chapter" | "range" | "full";

/** 检验命令 */
export interface CheckCommand {
  target: CheckTarget;
  chapterPath?: string;
  startEventId?: string;
  endEventId?: string;
}

/** 违规项 */
export interface Violation {
  location: string;
  rule: string;
  text?: string;
  severity: "error" | "warning";
}

/** 修改建议 */
export interface Suggestion {
  location: string;
  issue: string;
  suggestion: string;
}

/** 检验结果 */
export interface CheckResult {
  violations: Violation[];
  suggestions: Suggestion[];
  /** 错误信息（如 LLM 返回非 JSON 时记录，便于调用方区分"无违规"与"解析失败"） */
  error?: string;
}

/** 检验上下文（与 RenderCtx 对齐：规则集由调用方读取后传入） */
export interface CheckCtx {
  llm: RenderLlmCaller;
  /** 规则集.md 全文（由调用方通过 loadRuleSet 读取后传入） */
  ruleSet: string;
}

/** 检验员系统提示词 */
export const CHECKER_SYSTEM_PROMPT = `你是叙事引擎的文本检验员。

# 你的职责
检查给定的叙事文本是否符合规则集的要求，给出违规清单和修改建议。

# 输出协议
返回严格的 JSON 格式，无其他文本：
{
  "violations": [
    {
      "location": "事件 ID 或段落位置",
      "rule": "违反的规则",
      "text": "违规的原文片段",
      "severity": "error" | "warning"
    }
  ],
  "suggestions": [
    {
      "location": "事件 ID 或段落位置",
      "issue": "问题描述",
      "suggestion": "修改建议"
    }
  ]
}

如果没有违规，返回 {"violations": [], "suggestions": []}
`;

/**
 * 执行检验
 */
export async function checkNarrative(
  cmd: CheckCommand,
  ctx: CheckCtx,
): Promise<CheckResult> {
  // 1. 读取目标文本
  const text = await readCheckTarget(cmd);

  // 2. 使用调用方传入的规则集
  const ruleSet = ctx.ruleSet;

  // 3. 构建用户消息
  const userMessage = buildCheckUserMessage(text, ruleSet);

  // 4. 调用 LLM
  const response = await ctx.llm(CHECKER_SYSTEM_PROMPT, userMessage);

  // 5. 解析 JSON
  try {
    const parsed = JSON.parse(response);
    return {
      violations: Array.isArray(parsed.violations) ? parsed.violations : [],
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
    };
  } catch {
    // LLM 返回非 JSON 时返回空结果 + error 字段（不抛错，避免阻塞流程）
    // 调用方可通过 error 字段区分"无违规"与"解析失败"
    return {
      violations: [],
      suggestions: [],
      error: `LLM 返回非 JSON: ${response.slice(0, 100)}`,
    };
  }
}

/**
 * 按 target 读取目标文本
 */
async function readCheckTarget(cmd: CheckCommand): Promise<string> {
  if (cmd.target === "full") {
    // full 模式由主会话拆分后逐章调用，本工具单次只处理一个 chapterPath；
    // 无 chapterPath 时抛错让主会话决策。
    if (cmd.chapterPath) {
      return await readChapter(cmd.chapterPath);
    }
    throw new Error("target=full 时需要 chapterPath，或由主会话拆分后多次调用");
  }

  if (!cmd.chapterPath) {
    throw new Error("target != full 时需要 chapterPath");
  }

  if (cmd.target === "chapter") {
    return await readChapter(cmd.chapterPath);
  }

  if (cmd.target === "latest") {
    // 找到最后一个事件锚点，读取该锚点到末尾的文本
    const content = await readChapter(cmd.chapterPath);
    const lastAnchorIdx = content.lastIndexOf(EVENT_ANCHOR_PREFIX);
    if (lastAnchorIdx === -1) {
      return content; // 没有锚点，返回全文
    }
    return content.slice(lastAnchorIdx);
  }

  if (cmd.target === "range") {
    if (!cmd.startEventId) {
      throw new Error("target=range 时需要 startEventId");
    }
    return await readChapterSection(cmd.chapterPath, cmd.startEventId, cmd.endEventId);
  }

  throw new Error(`未知的 target: ${cmd.target}`);
}

/**
 * 构建检验用户消息（规则集在末尾）
 */
function buildCheckUserMessage(text: string, ruleSet: string): string {
  const parts: string[] = [];

  parts.push(`[待检查文本]`);
  parts.push(text);
  parts.push("");

  if (ruleSet.trim()) {
    parts.push(`─── 规则集（以此为准检查文本）───`);
    parts.push(ruleSet);
    parts.push(`─── 以上为检查规则 ───`);
  }

  return parts.join("\n");
}
