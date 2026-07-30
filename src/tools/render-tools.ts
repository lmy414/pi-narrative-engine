/**
 * render-tools.ts — 渲染器工具域注册
 *
 * 工具清单：
 *   render_append   渲染事件并追加到章节文件（append 模式）
 *   render_modify   重写章节文件中指定事件锚点区间（modify 模式）
 *   render_preview  预览渲染结果（不写文件）
 *   render_check    检验章节文本是否符合规则集
 *   render_rule_set 查看当前规则集.md 内容
 *
 * 2026-07-29 LLM 调用链改造：
 * - execute 接收第 5 个参数 piCtx: ExtensionContext
 * - makeRendererLlmCaller 改为接收 piCtx，从 PI 本体获取模型与 API Key
 * - 移除 getLlmConfig / getRendererLlmConfig 包装
 * - 设计依据：docs/plans/2026-07-29-config-ui-design.md §三
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  loadRuleSet,
  renderToFile,
  renderText,
  readChapter,
  type RenderFileCommand,
  type RenderTextCommand,
  type RoleOutput,
} from "@pi/renderer";
import { makeRendererLlmCaller } from "../renderer-llm.ts";
import { checkNarrative } from "../checker.ts";
import { type SessionState } from "../session-state.ts";
import { RoleOutputSchema } from "./shared.ts";

export function registerRenderTools(pi: ExtensionAPI, state: SessionState): void {
  // --------------------------------------------------------------------------
  // render_append
  // --------------------------------------------------------------------------

  pi.registerTool({
    name: "render_append",
    label: "Render Append",
    description:
      "渲染叙事事件并追加到章节文件（append 模式）。读取已有章节全文做上下文，LLM 生成正文后追加到文件末尾。",
    promptSnippet: "渲染事件并追加到章节",
    parameters: Type.Object({
      chapterPath: Type.String({ description: "目标章节文件绝对路径" }),
      eventId: Type.String({ description: "本次渲染对应的事件 ID" }),
      storyTime: Type.String({ description: "故事时间（如 ch009.ev006）" }),
      instruction: Type.String({ description: "叙事指令（自然语言）" }),
      payload: RoleOutputSchema,
    }),
    async execute(_id, params, _signal, _onUpdate, piCtx: ExtensionContext) {
      const llm = await makeRendererLlmCaller(piCtx);
      const ruleSet = await loadRuleSet(state.sessionCwd ?? process.cwd());

      const cmd: RenderFileCommand = {
        mode: "append",
        chapterPath: params.chapterPath,
        eventId: params.eventId,
        storyTime: params.storyTime,
        instruction: params.instruction,
        payload: params.payload as RoleOutput[],
      };

      const result = await renderToFile(cmd, { llm, ruleSet });

      const text = result.ok
        ? `已渲染事件 ${params.eventId} 到 ${params.chapterPath}（append）`
        : `渲染失败：${result.error}`;
      return {
        content: [{ type: "text", text }],
        details: result,
      };
    },
  });

  // --------------------------------------------------------------------------
  // render_modify
  // --------------------------------------------------------------------------

  pi.registerTool({
    name: "render_modify",
    label: "Render Modify",
    description:
      "重写章节文件中指定事件锚点区间的文本（modify 模式）。读取锚点区间+上下文，LLM 重新生成后替换原内容。",
    promptSnippet: "重写章节中指定事件的文本",
    parameters: Type.Object({
      chapterPath: Type.String({ description: "目标章节文件绝对路径" }),
      eventId: Type.String({ description: "本次渲染对应的事件 ID（用于记录）" }),
      modifyAnchorEventId: Type.String({ description: "要重写的目标事件 ID" }),
      storyTime: Type.String({ description: "故事时间" }),
      instruction: Type.String({ description: "叙事指令（描述重写方向）" }),
      payload: RoleOutputSchema,
    }),
    async execute(_id, params, _signal, _onUpdate, piCtx: ExtensionContext) {
      const llm = await makeRendererLlmCaller(piCtx);
      const ruleSet = await loadRuleSet(state.sessionCwd ?? process.cwd());

      const cmd: RenderFileCommand = {
        mode: "modify",
        chapterPath: params.chapterPath,
        eventId: params.eventId,
        storyTime: params.storyTime,
        instruction: params.instruction,
        payload: params.payload as RoleOutput[],
        modifyAnchorEventId: params.modifyAnchorEventId,
      };

      const result = await renderToFile(cmd, { llm, ruleSet });

      const text = result.ok
        ? `已重写事件 ${params.modifyAnchorEventId} 的文本（modify）`
        : `重写失败：${result.error}`;
      return {
        content: [{ type: "text", text }],
        details: result,
      };
    },
  });

  // --------------------------------------------------------------------------
  // render_preview
  // --------------------------------------------------------------------------

  pi.registerTool({
    name: "render_preview",
    label: "Render Preview",
    description:
      "预览渲染结果（不写入文件）。传入叙事指令和角色池数据，返回 LLM 生成的文本。可传 chapterPath 读取已有章节做上下文。",
    promptSnippet: "预览渲染结果（不写文件）",
    parameters: Type.Object({
      chapterPath: Type.Optional(Type.String({ description: "章节文件路径（用于读取上下文，不写文件）" })),
      eventId: Type.String({ description: "本次渲染对应的事件 ID" }),
      storyTime: Type.String({ description: "故事时间（如 ch009.ev006）" }),
      instruction: Type.String({ description: "叙事指令（自然语言）" }),
      payload: RoleOutputSchema,
    }),
    async execute(_id, params, _signal, _onUpdate, piCtx: ExtensionContext) {
      const llm = await makeRendererLlmCaller(piCtx);
      const ruleSet = await loadRuleSet(state.sessionCwd ?? process.cwd());

      let context = "";
      let contextWarning: string | undefined;
      if (params.chapterPath) {
        try {
          context = await readChapter(params.chapterPath);
        } catch (err) {
          contextWarning = `上下文读取失败：${err instanceof Error ? err.message : String(err)}`;
        }
      }

      const cmd: RenderTextCommand = {
        mode: "append",
        eventId: params.eventId,
        storyTime: params.storyTime,
        instruction: params.instruction,
        payload: params.payload as RoleOutput[],
        context,
      };

      const text = await renderText(cmd, { llm, ruleSet });

      return {
        content: [{ type: "text", text }],
        details: { ok: true, eventId: params.eventId, preview: true, contextWarning },
      };
    },
  });

  // --------------------------------------------------------------------------
  // render_check
  // --------------------------------------------------------------------------

  pi.registerTool({
    name: "render_check",
    label: "Render Check",
    description:
      "检验章节文本是否符合规则集。支持 latest（最新事件）/chapter（整章）/range（区间）/full（全文，需 chapterPath）。返回违规清单和修改建议。文本量过大时由主会话拆分多次调用。",
    promptSnippet: "检查章节文本是否符合规则集",
    parameters: Type.Object({
      target: Type.Union([
        Type.Literal("latest"),
        Type.Literal("chapter"),
        Type.Literal("range"),
        Type.Literal("full"),
      ]),
      chapterPath: Type.Optional(Type.String({ description: "章节文件路径" })),
      startEventId: Type.Optional(Type.String({ description: "target=range 时起点" })),
      endEventId: Type.Optional(Type.String({ description: "target=range 时终点（不包含）" })),
    }),
    async execute(_id, params, _signal, _onUpdate, piCtx: ExtensionContext) {
      const llm = await makeRendererLlmCaller(piCtx);
      const ruleSet = await loadRuleSet(state.sessionCwd ?? process.cwd());

      const result = await checkNarrative(
        {
          target: params.target,
          chapterPath: params.chapterPath,
          startEventId: params.startEventId,
          endEventId: params.endEventId,
        },
        { llm, ruleSet },
      );

      const text = result.error
        ? `检验出错：${result.error}`
        : result.violations.length > 0
        ? `发现 ${result.violations.length} 处违规`
        : "检查通过，无违规";
      return {
        content: [{ type: "text", text }],
        details: result,
      };
    },
  });

  // --------------------------------------------------------------------------
  // render_rule_set
  // --------------------------------------------------------------------------

  pi.registerTool({
    name: "render_rule_set",
    label: "Render Rule Set",
    description: "查看当前规则集.md 内容。无需参数。",
    promptSnippet: "查看规则集内容",
    parameters: Type.Object({}),
    async execute() {
      const ruleSet = await loadRuleSet(state.sessionCwd ?? process.cwd());
      return {
        content: [{ type: "text", text: ruleSet || "（规则集.md 不存在或为空）" }],
        details: { ok: true, length: ruleSet.length, exists: ruleSet.length > 0 },
      };
    },
  });
}
