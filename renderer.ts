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
};

export class Renderer {
	private agent: Agent | null = null;
	private systemPrompt: string;
	private renderTool: AgentTool<typeof renderSchema, RenderDetails>;
	private readonly outputPath: string;

	constructor(promptsDir: string, worldGraphDir: string) {
		try {
			this.systemPrompt = readFileSync(path.join(promptsDir, "renderer.md"), "utf-8");
		} catch {
			this.systemPrompt = "你是叙事渲染器。";
		}
		this.renderTool = createRenderTool();
		this.outputPath = path.join(worldGraphDir, "narrative.txt");
	}

	private getOrCreateAgent(model: Model<any>, apiKey: string | undefined): Agent {
		if (this.agent) return this.agent;

		this.agent = new Agent({
			initialState: {
				systemPrompt: this.systemPrompt,
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

		// 写入文件
		await this.writeToFile(text, resultMode);

		return { text, mode: resultMode };
	}

	// 写入 narrative.txt
	private async writeToFile(text: string, mode: RenderMode): Promise<void> {
		try {
			if (mode === "rewrite") {
				// 重写模式：覆盖文件
				await fs.writeFile(this.outputPath, text + "\n\n", "utf-8");
			} else {
				// append 模式：追加
				const existing = await fs.readFile(this.outputPath, "utf-8").catch(() => "");
				await fs.writeFile(this.outputPath, existing + text + "\n\n", "utf-8");
			}
		} catch (err) {
			console.error("[renderer] writeToFile failed:", err);
		}
	}

	// 获取输出文件路径（供主流程记录到 details）
	getOutputPath(): string {
		return this.outputPath;
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
