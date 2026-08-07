import { Type } from "typebox";
import { complete } from "@earendil-works/pi-ai";
import type { Model, TextContent } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { loadRuleSet, renderToFile, renderText, readChapter, type RenderLlmCaller, type RenderTextCommand } from "@pi/renderer";
import { checkNarrative } from "../checker.ts";
import { assertPathInside } from "../path-guard.ts";
import type { LlmConfigStore } from "../orchestrator/llm-config.ts";

const RoleOutputSchema = Type.Array(Type.Object({
  actor: Type.String(),
  action: Type.String(),
  target: Type.Optional(Type.String()),
  emotion: Type.Optional(Type.String()),
  relation_update: Type.Optional(Type.Array(Type.Object({
    target: Type.String(),
    label: Type.String(),
  }))),
  thought: Type.Optional(Type.String()),
  knowledge_gained: Type.Optional(Type.Array(Type.String())),
}));

export interface RenderToolsProvider {
  cwd: string;
  llmStore: LlmConfigStore;
  createLlmCaller?: (model: Model<any>, apiKey: string, headers?: Record<string, string>) => RenderLlmCaller;
}

function createDefaultLlmCaller(
  model: Model<any>,
  apiKey: string,
  headers?: Record<string, string>,
): RenderLlmCaller {
  return async (systemPrompt, userMessage) => {
    const msg = await complete(
      model,
      {
        systemPrompt,
        messages: [{ role: "user", content: userMessage, timestamp: Date.now() }],
      },
      { apiKey, headers, maxTokens: 4000, temperature: 0.7 },
    );
    if (msg.stopReason === "error" || msg.stopReason === "aborted" || msg.errorMessage) {
      throw new Error(`渲染器 LLM 调用失败: ${msg.errorMessage ?? msg.stopReason}`);
    }
    const textBlocks = msg.content.filter((block): block is TextContent => block.type === "text");
    if (textBlocks.length === 0) {
      throw new Error("渲染器 LLM 未返回文本内容");
    }
    return textBlocks.map(block => block.text).join("");
  };
}

export function createRenderTools(provider: RenderToolsProvider): ToolDefinition[] {
  const base = (name: string, label: string, description: string, parameters: unknown, promptSnippet: string, execute: (params: any) => Promise<any>): ToolDefinition => defineTool({ name, label, description, parameters, promptSnippet, async execute(_id: string, params: any) { return execute(params); } } as any);
  const render = () => (provider.createLlmCaller ?? createDefaultLlmCaller)(
    provider.llmStore.getModel("renderer"),
    provider.llmStore.getApiKey("renderer"),
    provider.llmStore.getHeaders("renderer"),
  );
  return [
    base("render_append", "Render Append", "渲染叙事事件并追加到章节文件（append 模式）。读取已有章节全文做上下文，LLM 生成正文后追加到文件末尾。", Type.Object({ chapterPath: Type.String({ description: "目标章节文件绝对路径" }), eventId: Type.String({ description: "本次渲染对应的事件 ID（evt_ 前缀）", pattern: "^evt_[A-Za-z0-9_.-]+$" }), storyTime: Type.String({ description: "故事时间（如 ch009.ev006）" }), instruction: Type.String({ description: "叙事指令（自然语言）" }), payload: RoleOutputSchema }), "渲染事件并追加到章节", async p => { const chapterPath = assertPathInside(provider.cwd, p.chapterPath, "章节文件路径"); const result = await renderToFile({ mode: "append", ...p, chapterPath }, { llm: render(), ruleSet: await loadRuleSet(provider.cwd) }); return { content: [{ type: "text", text: result.ok ? `已渲染事件 ${p.eventId} 到 ${chapterPath}（append）` : `渲染失败：${result.error}` }], details: result }; }),
    base("render_modify", "Render Modify", "重写章节文件中指定事件锚点区间的文本（modify 模式）。读取锚点区间+上下文，LLM 重新生成后替换原内容。", Type.Object({ chapterPath: Type.String({ description: "目标章节文件绝对路径" }), eventId: Type.String({ description: "本次渲染对应的事件 ID（用于记录）", pattern: "^evt_[A-Za-z0-9_.-]+$" }), modifyAnchorEventId: Type.String({ description: "要重写的目标事件 ID", pattern: "^evt_[A-Za-z0-9_.-]+$" }), storyTime: Type.String({ description: "故事时间" }), instruction: Type.String({ description: "叙事指令（描述重写方向）" }), payload: RoleOutputSchema }), "重写章节中指定事件的文本", async p => { const chapterPath = assertPathInside(provider.cwd, p.chapterPath, "章节文件路径"); const result = await renderToFile({ mode: "modify", ...p, chapterPath }, { llm: render(), ruleSet: await loadRuleSet(provider.cwd) }); return { content: [{ type: "text", text: result.ok ? `已重写事件 ${p.modifyAnchorEventId} 的文本（modify）` : `重写失败：${result.error}` }], details: result }; }),
    base("render_preview", "Render Preview", "预览渲染结果（不写入文件）。传入叙事指令和角色池数据，返回 LLM 生成的文本。可传 chapterPath 读取已有章节做上下文。", Type.Object({ chapterPath: Type.Optional(Type.String({ description: "章节文件路径（用于读取上下文，不写文件）" })), eventId: Type.String({ description: "本次渲染对应的事件 ID" }), storyTime: Type.String({ description: "故事时间（如 ch009.ev006）" }), instruction: Type.String({ description: "叙事指令（自然语言）" }), payload: RoleOutputSchema }), "预览渲染结果（不写文件）", async p => { let context = ""; let contextWarning: string | undefined; if (p.chapterPath) { const safePath = assertPathInside(provider.cwd, p.chapterPath, "章节文件路径"); try { context = await readChapter(safePath); } catch (e) { contextWarning = `上下文读取失败：${e instanceof Error ? e.message : String(e)}`; } } const text = await renderText({ mode: "append", eventId: p.eventId, storyTime: p.storyTime, instruction: p.instruction, payload: p.payload, context } as RenderTextCommand, { llm: render(), ruleSet: await loadRuleSet(provider.cwd) }); return { content: [{ type: "text", text }], details: { ok: true, eventId: p.eventId, preview: true, contextWarning } }; }),
    base("render_check", "Render Check", "检验章节文本是否符合规则集。支持 latest（最新事件）/chapter（整章）/range（区间）/full（全文，需 chapterPath）。返回违规清单和修改建议。文本量过大时由主会话拆分多次调用。", Type.Object({ target: Type.Union([Type.Literal("latest"), Type.Literal("chapter"), Type.Literal("range"), Type.Literal("full")]), chapterPath: Type.Optional(Type.String({ description: "章节文件路径" })), startEventId: Type.Optional(Type.String({ description: "target=range 时起点" })), endEventId: Type.Optional(Type.String({ description: "target=range 时终点（不包含）" })) }), "检查章节文本是否符合规则集", async p => { const result = await checkNarrative(p, { llm: render(), ruleSet: await loadRuleSet(provider.cwd), cwd: provider.cwd }); return { content: [{ type: "text", text: result.error ? `检验出错：${result.error}` : result.violations.length ? `发现 ${result.violations.length} 处违规` : "检查通过，无违规" }], details: result }; }),
    base("render_rule_set", "Render Rule Set", "查看当前规则集.md 内容。无需参数。", Type.Object({}), "查看规则集内容", async () => { const ruleSet = await loadRuleSet(provider.cwd); return { content: [{ type: "text", text: ruleSet || "（规则集.md 不存在或为空）" }], details: { ok: true, length: ruleSet.length, exists: ruleSet.length > 0 } }; }),
  ];
}
