// 渲染器
// 独立 Agent 实例，与主会话隔离
// 职责：把角色互动的结构化输出渲染成最终叙事文本
//
// 设计要点：
// - 渲染器只调用一次 LLM（render 方法）
// - 输入：事件 + 调度器渲染指令 + 角色结构化输出
// - 输出：渲染文本（写入 narrative.txt + 返回主 LLM）
// - 渲染器 messages 累积历史叙事，保持文风一致性
// - 上下文隔离：独立 Agent，messages = []，看不到主会话

import { readFileSync } from "node:fs";
import path from "node:path";
import { promises as fs } from "node:fs";
import { Agent, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import { streamSimple, type Model } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import type { EventNode, RenderMode, StructuredOutput } from "./types";
import type { RuleSet } from "./rule-loader";
import { tagRenderOutput } from "./version";

// ============================================================
// render 工具
// ============================================================

const renderSchema = Type.Object({
	text: Type.String({
		description: "最终叙事文本（中文，2-4 段，约 200-500 字）",
	}),
	mode: Type.Union([Type.Literal("append"), Type.Literal("rewrite")], {
		description: "渲染模式：append 追加 / rewrite 重写当前场景",
	}),
});

type RenderDetails = Static<typeof renderSchema>;

function createRenderTool(): AgentTool<typeof renderSchema, RenderDetails> {
	return {
		name: "render",
		label: "Render",
		description: "输出最终叙事文本。只能调用一次。",
		parameters: renderSchema,
		execute: async (_id, params) => ({
			content: [{ type: "text" as const, text: params.text.slice(0, 80) + (params.text.length > 80 ? "..." : "") }],
			details: params,
			terminate: true,
		}),
	};
}

// ============================================================
// 渲染器类
// ============================================================

export type RenderResult = {
	text: string;
	mode: RenderMode;
	chapterPath: string | null;
};

/** 章节指令（主会话判断后通过 narrative_step 传入） */
export type ChapterInstruction = {
	/** 是否开始新章节 */
	startNewChapter: boolean;
	/** 新章节标题（startNewChapter=true 时使用） */
	chapterTitle?: string;
};

export class Renderer {
	private agent: Agent | null = null;
	private baseSystemPrompt: string;
	private readonly promptsDir: string;
	private renderTool: AgentTool<typeof renderSchema, RenderDetails>;
	/** 运行时输出路径（world-graph/narrative.txt，用于 git 版本管理） */
	private readonly runtimeOutputPath: string;
	/** 工程正文目录路径（正文/，给用户的最终产物）。无工程时为 null */
	private readonly chapterOutputDir: string | null;
	/** 当前章节文件路径（append 时写入此文件）。null 表示尚无章节 */
	private currentChapterPath: string | null = null;
	/** 当前章节号（用于自动编号） */
	private currentChapterNum = 0;
	private rules: RuleSet | null = null;

	constructor(promptsDir: string, worldGraphDir: string, projectRoot: string | null) {
		this.promptsDir = promptsDir;
		this.baseSystemPrompt = this.loadPrompt();
		this.renderTool = createRenderTool();
		this.runtimeOutputPath = path.join(worldGraphDir, "narrative.txt");
		// 工程正文目录：projectRoot/正文/
		this.chapterOutputDir = projectRoot
			? path.join(projectRoot, "正文")
			: null;
	}

	/** 从文件加载提示词（构造时和 setRules 时调用） */
	private loadPrompt(): string {
		try {
			return readFileSync(path.join(this.promptsDir, "renderer.md"), "utf-8");
		} catch {
			return "你是叙事渲染器。";
		}
	}

	/** 注入工程规则（RuleLoader 加载后调用）。同时重读 prompt 文件，实现热重载 */
	setRules(rules: RuleSet): void {
		this.rules = rules;
		this.baseSystemPrompt = this.loadPrompt();
		this.agent = null;
	}

	private buildSystemPrompt(): string {
		if (!this.rules) return this.baseSystemPrompt;
		const parts: string[] = [];
		if (this.rules.common) {
			parts.push("--- 总规则（始终遵守）---");
			parts.push(this.rules.common);
		}
		if (this.rules.renderer) {
			parts.push("--- 文风规则 + 检查清单（渲染时遵守）---");
			parts.push(this.rules.renderer);
		}
		parts.push("--- 渲染器职责 ---");
		parts.push(this.baseSystemPrompt);
		return parts.join("\n\n");
	}

	private getOrCreateAgent(model: Model<any>, apiKey: string | undefined): Agent {
		if (this.agent) return this.agent;

		this.agent = new Agent({
			initialState: {
				systemPrompt: this.buildSystemPrompt(),
				model,
				thinkingLevel: "low",
				tools: [this.renderTool],
				messages: [],
			},
			convertToLlm: (msgs) =>
				msgs.filter(
					(m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
				),
			streamFn: async (m, ctx, opts) =>
				streamSimple(m, ctx, { ...opts, apiKey }),
		});
		return this.agent;
	}

	// 渲染当前事件
	async render(
		event: EventNode,
		outputs: StructuredOutput[],
		renderStyle: string,
		focus: string,
		mode: RenderMode,
		model: Model<any>,
		apiKey: string | undefined,
		signal?: AbortSignal,
		chapter?: ChapterInstruction,
	): Promise<RenderResult> {
		const agent = this.getOrCreateAgent(model, apiKey);
		const prompt = buildRenderPrompt(event, outputs, renderStyle, focus, mode);

		let result: RenderDetails | null = null;
		const unsub = agent.subscribe((ev: AgentEvent) => {
			if (ev.type === "tool_execution_start" && ev.toolName === "render") {
				result = ev.args as RenderDetails;
			}
		});

		try {
			if (signal) {
				const onAbort = () => agent.abort();
				signal.addEventListener("abort", onAbort, { once: true });
				try {
					await agent.prompt(prompt);
				} finally {
					signal.removeEventListener("abort", onAbort);
				}
			} else {
				await agent.prompt(prompt);
			}
		} finally {
			unsub();
		}

		const text = result?.text ?? fallbackRender(event, outputs, renderStyle, focus);
		const resultMode: RenderMode = (result?.mode as RenderMode) ?? mode;

		// 加版本标记（HTML 注释，不影响阅读）
		const taggedText = tagRenderOutput(text);

		// 写入运行时文件（world-graph/narrative.txt，用于 git 版本管理）
		await this.writeToRuntime(taggedText, resultMode);

		// 写入工程正文文件（按章节分文件）
		const chapterPath = await this.writeToChapter(taggedText, resultMode, event, chapter);

		return { text: taggedText, mode: resultMode, chapterPath };
	}

	// 写入运行时 narrative.txt（world-graph 内部，git 追踪）
	private async writeToRuntime(text: string, mode: RenderMode): Promise<void> {
		try {
			if (mode === "rewrite") {
				await fs.writeFile(this.runtimeOutputPath, text + "\n\n", "utf-8");
			} else {
				const existing = await fs.readFile(this.runtimeOutputPath, "utf-8").catch(() => "");
				await fs.writeFile(this.runtimeOutputPath, existing + text + "\n\n", "utf-8");
			}
		} catch (err) {
			console.error("[renderer] writeToRuntime failed:", err);
		}
	}

	// 写入工程正文文件（按章节分文件）
	// - chapter.startNewChapter=true → 创建新章节文件，更新 currentChapterPath
	// - 否则追加到当前章节文件（无当前章节时自动创建第 1 章）
	// 返回写入的章节文件路径
	private async writeToChapter(
		text: string,
		mode: RenderMode,
		event: EventNode,
		chapter?: ChapterInstruction,
	): Promise<string | null> {
		if (!this.chapterOutputDir) return null;
		try {
			await fs.mkdir(this.chapterOutputDir, { recursive: true });

			// 判断是否需要开新章节
			const needNewChapter =
				chapter?.startNewChapter === true || this.currentChapterPath === null;

			if (needNewChapter) {
				this.currentChapterNum += 1;
				const num = String(this.currentChapterNum).padStart(2, "0");
				const title = chapter?.chapterTitle ?? `第${this.currentChapterNum}章`;
				// 文件名：第01章-初入王都.md（标题为空时只有编号）
				const safeTitle = title.replace(/[<>:"/\\|?*]/g, "").slice(0, 30);
				const fileName = `第${num}章-${safeTitle}.md`;
				const chapterPath = path.join(this.chapterOutputDir, fileName);

				const header = `# 第${num}章 ${title}\n\n<!-- event: ${event.id} | ${event.time} @ ${event.place} | ${event.what} -->\n\n`;
				// 新章节总是覆盖写（rewrite 模式天然如此；append 模式下新章节也从头开始）
				await fs.writeFile(chapterPath, `${header}${text}\n`, "utf-8");
				this.currentChapterPath = chapterPath;
				return chapterPath;
			}

			// 追加到当前章节
			const chapterPath = this.currentChapterPath!;
			const header = `\n\n<!-- event: ${event.id} | ${event.time} @ ${event.place} | ${event.what} -->\n\n`;
			if (mode === "rewrite") {
				// rewrite 模式：覆盖当前章节文件
				const existing = await fs.readFile(chapterPath, "utf-8").catch(() => "");
				// 保留章节标题行
				const titleLine = existing.split("\n").find((l) => l.startsWith("# "));
				const titleHeader = titleLine ? `${titleLine}\n\n` : "";
				await fs.writeFile(chapterPath, `${titleHeader}${header}${text}\n`, "utf-8");
			} else {
				// append 模式：追加到当前章节
				const existing = await fs.readFile(chapterPath, "utf-8").catch(() => "");
				await fs.writeFile(chapterPath, existing + `${header}${text}\n`, "utf-8");
			}
			return chapterPath;
		} catch (err) {
			console.error("[renderer] writeToChapter failed:", err);
			return null;
		}
	}

	/** 获取当前章节文件路径（供外部查询） */
	getCurrentChapterPath(): string | null {
		return this.currentChapterPath;
	}

	// 获取运行时输出路径（供主流程记录到 details）
	getOutputPath(): string {
		return this.runtimeOutputPath;
	}

	reset(): void {
		if (this.agent) {
			this.agent.reset();
		}
	}
}

// ============================================================
// prompt 构造
// ============================================================

function buildRenderPrompt(
	event: EventNode,
	outputs: StructuredOutput[],
	renderStyle: string,
	focus: string,
	mode: RenderMode,
): string {
	const parts: string[] = [];

	parts.push("--- 渲染指令 ---");
	parts.push(`风格：${renderStyle}`);
	parts.push(`叙事重点：${focus}`);
	parts.push(`渲染模式：${mode}`);

	parts.push("--- 当前事件 ---");
	parts.push(`时间：${event.time}`);
	parts.push(`地点：${event.place}`);
	parts.push(`发生了什么：${event.what}`);
	parts.push(`涉及角色：${event.characters.join(", ")}`);

	parts.push("--- 角色互动输出 ---");
	for (const out of outputs) {
		parts.push("");
		parts.push(`【${out.actor}】`);
		parts.push(`动作：${out.action}`);
		parts.push(`对象：${out.target}`);
		parts.push(`情绪：${out.emotion}`);
		parts.push(
			`关系变化：${out.relation_update.target} ${out.relation_update.delta >= 0 ? "+" : ""}${out.relation_update.delta}`,
		);
		parts.push(`内心：${out.thought}`);
	}

	parts.push("");
	parts.push("--- 你的任务 ---");
	parts.push("把上述角色互动渲染成最终叙事文本。调用 render 工具输出。");
	parts.push(`渲染模式用 ${mode}。`);

	return parts.join("\n");
}

// 退化渲染（LLM 没调 render 工具时的兜底）
function fallbackRender(
	event: EventNode,
	outputs: StructuredOutput[],
	_renderStyle: string,
	_focus: string,
): string {
	// 纯叙事文本，不输出风格/焦点标签
	const lines: string[] = [];
	lines.push(`${event.time}，${event.place}。`);
	lines.push("");
	for (const out of outputs) {
		lines.push(`${out.actor}${out.action}。`);
	}
	return lines.join("\n");
}
