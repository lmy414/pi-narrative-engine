/**
 * renderer.ts — 渲染器核心逻辑
 *
 * 两个导出函数：
 * - renderText: 仅生成文本，不写文件（供预览/决策）
 * - renderToFile: 生成文本并写入章节文件
 *
 * 渲染器无状态：LLM 调用器和规则集由调用方传入。
 */

import type {
  RenderTextCommand,
  RenderFileCommand,
  RenderResult,
  RenderCtx,
} from "./types.ts";
import { RENDERER_SYSTEM_PROMPT, buildUserMessage } from "./prompts.ts";
import {
  readChapter,
  appendToChapter,
  modifyChapterSection,
  ensureChapterFile,
} from "./chapter-io.ts";

/**
 * 仅生成文本，不写文件
 *
 * 调用方需自行传入 context（已有章节文本或上下文摘要）。
 * 适合预览或由调用方决定写入策略。
 */
export async function renderText(
  cmd: RenderTextCommand,
  ctx: RenderCtx,
): Promise<string> {
  const userMessage = buildUserMessage(cmd, ctx.ruleSet);
  return await ctx.llm(RENDERER_SYSTEM_PROMPT, userMessage);
}

/**
 * 生成文本并写入章节文件
 *
 * - append 模式：读全文做上下文 → LLM 生成 → 追加到文件末尾
 * - modify 模式：读全文做上下文 → LLM 生成 → 重写锚点区间
 */
export async function renderToFile(
  cmd: RenderFileCommand,
  ctx: RenderCtx,
): Promise<RenderResult> {
  try {
    // 确保章节文件存在
    await ensureChapterFile(cmd.chapterPath);

    // 读取已有内容作为上下文
    const existingContent = await readChapter(cmd.chapterPath);

    // 构建 RenderTextCommand（复用 renderText）
    const textCmd: RenderTextCommand = {
      mode: cmd.mode,
      eventId: cmd.eventId,
      storyTime: cmd.storyTime,
      instruction: cmd.instruction,
      payload: cmd.payload,
      context: existingContent,
      modifyAnchorEventId: cmd.modifyAnchorEventId,
    };

    // 生成文本
    const renderedText = await renderText(textCmd, ctx);

    // 写入文件
    if (cmd.mode === "append") {
      await appendToChapter(cmd.chapterPath, cmd.eventId, renderedText);
    } else if (cmd.mode === "modify") {
      const anchorEventId = cmd.modifyAnchorEventId ?? cmd.eventId;
      await modifyChapterSection(cmd.chapterPath, anchorEventId, renderedText);
    }

    return {
      ok: true,
      chapterPath: cmd.chapterPath,
      mode: cmd.mode,
      eventId: cmd.eventId,
      writtenText: renderedText,
    };
  } catch (err: unknown) {
    return {
      ok: false,
      chapterPath: cmd.chapterPath,
      mode: cmd.mode,
      eventId: cmd.eventId,
      writtenText: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
