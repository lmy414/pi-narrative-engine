// 角色子代理池
// 维护持久化的角色 Agent 实例，跨事件复用，上下文隔离

import path from "node:path";
import { readFileSync } from "node:fs";
import { Agent, type AgentTool, type AgentEvent } from "@earendil-works/pi-agent-core";
import { streamSimple, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { WorldGraph } from "./world-graph";
import type { Schedule, RoleAssignment } from "./scheduler";
import type {
	CharacterNode,
	EventNode,
	StructuredOutput,
	WorldEntry,
} from "./types";
import type { RuleSet } from "./rule-loader";

// character_action 工具 schema（注入到角色子代理）
const characterActionSchema = Type.Object({
	actor: Type.String({ description: "你的角色名" }),
	action: Type.String({ description: "你在这个事件中做的动作（简短具体）" }),
	target: Type.String({ description: "动作对象（角色名/物品/空）" }),
	emotion: Type.String({ description: "你此刻的情绪" }),
	relation_update: Type.Object({
		target: Type.String({ description: "关系变化的对象" }),
		delta: Type.Number({ description: "关系值变化 -1.0 到 1.0" }),
	}),
	thought: Type.String({ description: "内心独白（其他角色看不到）" }),
});

// 为角色子代理构造 character_action 工具
// 工具 execute 返回 terminate: true，让角色子代理只调用一次就结束
function createCharacterActionTool(roleName: string): AgentTool {
	return {
		name: "character_action",
		label: "Character Action",
		description: "输出你在这个事件中的角色扮演反应",
		parameters: characterActionSchema,
		execute: async (_id, params) => ({
			content: [
				{ type: "text" as const, text: `${params.action}` },
			],
			details: params as StructuredOutput,
			terminate: true,
		}),
	};
}

// 从 V2 角色卡拼接 system prompt
function buildRoleSystemPrompt(
	card: CharacterNode["card"],
	roleBasePrompt: string,
	currentState: CharacterNode["ne"]["state"],
	rules: RuleSet | null,
): string {
	const d = card.data;
	const parts: string[] = [];

	// 0. 工程规则（总规则 + 内容规则，角色演出约束）
	if (rules) {
		if (rules.common) {
			parts.push("--- 总规则（始终遵守）---");
			parts.push(rules.common);
		}
		if (rules.roles) {
			parts.push("--- 内容规则（角色演出约束）---");
			parts.push(rules.roles);
		}
	}

	// 1. 通用角色扮演指令
	parts.push(roleBasePrompt);

	// 2. V2 自定义 system_prompt（如果有）
	if (d.system_prompt) {
		parts.push(d.system_prompt.replace(/\{\{original\}\}/g, ""));
	}

	// 3. 角色身份
	parts.push(`你是 ${d.name}。`);

	// 4. description（外貌、背景）
	if (d.description) parts.push(d.description);

	// 5. personality（性格）
	if (d.personality) parts.push(`性格：${d.personality}`);

	// 6. scenario（场景背景）
	if (d.scenario) parts.push(`背景场景：${d.scenario}`);

	// 7. mes_example（对话风格参考）
	if (d.mes_example) {
		parts.push(`对话风格参考：\n${d.mes_example}`);
	}

	// 8. post_history_instructions（后置指令）
	if (d.post_history_instructions) {
		parts.push(d.post_history_instructions.replace(/\{\{original\}\}/g, ""));
	}

	// 9. 当前内部状态（每次调用前更新）
	parts.push("--- 当前内部状态 ---");
	parts.push(`情绪：${currentState.emotion}`);
	parts.push(`位置：${currentState.location}`);
	const rels = Object.entries(currentState.relationships)
		.map(([k, v]) => `${k}: ${v}`)
		.join(", ");
	parts.push(`关系：${rels || "(无)"}`);

	return parts.join("\n\n");
}

// 构造给角色子代理的 user message
function buildRolePrompt(
	event: EventNode,
	visibleEntries: WorldEntry[],
	roleName: string,
	instructions: string,
): string {
	const parts: string[] = [];

	// 调度器指令（放在最前，让角色明确本事件演出重点）
	if (instructions) {
		parts.push("--- 调度器指令 ---");
		parts.push(instructions);
	}

	// 事件信息
	parts.push("--- 当前事件 ---");
	parts.push(`时间：${event.time}`);
	parts.push(`地点：${event.place}`);
	parts.push(`发生了什么：${event.what}`);
	parts.push(`在场角色：${event.characters.join(", ")}`);
	parts.push(`事件意图：${event.purpose}`);

	// 可见世界信息
	if (visibleEntries.length > 0) {
		parts.push("--- 你所知道的信息 ---");
		for (const entry of visibleEntries) {
			switch (entry.kind) {
				case "location":
					parts.push(`[地点] ${entry.node.id}: ${entry.node.content}`);
					break;
				case "rule":
					parts.push(`[规则] ${entry.node.id}: ${entry.node.content}`);
					break;
				case "event":
					parts.push(
						`[历史事件] ${entry.node.time} @${entry.node.place}: ${entry.node.what}`,
					);
					break;
				case "character":
					// 只有自己的角色节点会到这里（filterByKnowledge 过滤过）
					if (entry.node.card.data.name === roleName) {
						const memories = entry.node.ne.memories.slice(-5);
						if (memories.length > 0) {
							parts.push("--- 你的近期记忆 ---");
							for (const m of memories) {
								parts.push(`[${m.timestamp}] ${m.summary}`);
							}
						}
					}
					break;
			}
		}
	}

	parts.push("--- 行动 ---");
	parts.push("调用 character_action 工具输出你的反应。");

	return parts.join("\n");
}

interface RoleAgentContext {
	agent: Agent;
	roleName: string;
}

export class RolePool {
	private pool = new Map<string, RoleAgentContext>();
	private roleBasePrompt: string;
	private rules: RuleSet | null = null;

	constructor(
		private readonly graph: WorldGraph,
		private readonly promptsDir: string,
	) {
		this.roleBasePrompt = this.loadPrompt();
	}

	/** 从文件加载提示词（构造时和 setRules 时调用） */
	private loadPrompt(): string {
		try {
			return readFileSync(path.join(this.promptsDir, "role-base.md"), "utf-8");
		} catch {
			return "你是角色扮演子代理。";
		}
	}

	/** 注入工程规则（RuleLoader 加载后调用）。同时重读 prompt 文件，实现热重载 */
	setRules(rules: RuleSet): void {
		this.rules = rules;
		this.roleBasePrompt = this.loadPrompt();
		// 规则或 prompt 变更后清空池，让所有角色重建 agent（新 systemPrompt 生效）
		this.clear();
	}

	// 获取或创建角色子代理
	private async getOrCreate(
		roleName: string,
		model: Model<any>,
		apiKey: string | undefined,
	): Promise<RoleAgentContext> {
		const cached = this.pool.get(roleName);
		if (cached) return cached;

		const node = await this.graph.loadCharacter(roleName);
		const systemPrompt = buildRoleSystemPrompt(
			node.card,
			this.roleBasePrompt,
			node.ne.state,
			this.rules,
		);

		const actionTool = createCharacterActionTool(roleName);

		const agent = new Agent({
			initialState: {
				systemPrompt,
				model,
				thinkingLevel: "low",
				tools: [actionTool],
				messages: [],
			},
			convertToLlm: (msgs) =>
				msgs.filter(
					(m) =>
						m.role === "user" || m.role === "assistant" || m.role === "toolResult",
				),
			streamFn: async (m, ctx, opts) =>
				streamSimple(m, ctx, { ...opts, apiKey }),
		});

		const ctx: RoleAgentContext = { agent, roleName };
		this.pool.set(roleName, ctx);
		return ctx;
	}

	// 驱动所有涉及角色进行角色扮演交互
	// schedule 由调度器输出：每个角色可见的条目 id + 行动指令
	// 返回结构化输出列表和错误信息（角色卡缺失等）
	async interact(
		event: EventNode,
		worldEntries: WorldEntry[],
		schedule: Schedule,
		model: Model<any>,
		apiKey: string | undefined,
		signal?: AbortSignal,
	): Promise<{ outputs: StructuredOutput[]; errors: string[] }> {
		const outputs: StructuredOutput[] = [];
		const errors: string[] = [];

		// 构建 id → WorldEntry 索引
		const entryById = new Map<string, WorldEntry>();
		for (const entry of worldEntries) {
			entryById.set(entryIdOf(entry), entry);
		}

		for (const roleName of event.characters) {
			try {
				const assignment = schedule.roleAssignments.get(roleName);
				const visibleIds = assignment?.visibleEntryIds ?? [];
				const instructions = assignment?.instructions ?? "";
				const visibleEntries = visibleIds
					.map((id) => entryById.get(id))
					.filter((e): e is WorldEntry => e !== undefined);

				const output = await this.runRole(
					roleName,
					event,
					visibleEntries,
					instructions,
					model,
					apiKey,
					signal,
				);
				if (output) outputs.push(output);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				errors.push(`${roleName}: ${msg}`);
				console.error(`[narrative] role ${roleName} failed:`, err);
			}
		}

		return { outputs, errors };
	}

	// 跑单个角色的角色扮演
	private async runRole(
		roleName: string,
		event: EventNode,
		visibleEntries: WorldEntry[],
		instructions: string,
		model: Model<any>,
		apiKey: string | undefined,
		signal?: AbortSignal,
	): Promise<StructuredOutput | null> {
		const ctx = await this.getOrCreate(roleName, model, apiKey);

		// 构造 prompt
		const prompt = buildRolePrompt(event, visibleEntries, roleName, instructions);

		// 收集结构化输出
		let output: StructuredOutput | null = null;
		const unsub = ctx.agent.subscribe((event: AgentEvent) => {
			// 捕获 character_action 工具调用（tool_execution_start 携带 args）
			if (
				event.type === "tool_execution_start" &&
				event.toolName === "character_action"
			) {
				output = event.args as StructuredOutput;
			}
		});

		// abort 传播
		if (signal) {
			const onAbort = () => ctx.agent.abort();
			signal.addEventListener("abort", onAbort, { once: true });
			try {
				await ctx.agent.prompt(prompt);
			} finally {
				signal.removeEventListener("abort", onAbort);
			}
		} else {
			await ctx.agent.prompt(prompt);
		}

		unsub();
		return output;
	}

	// 清空角色池（session 切换时）
	clear(): void {
		this.pool.clear();
	}
}

// 提取 WorldEntry 的 id（与 scheduler.ts 保持一致）
function entryIdOf(entry: WorldEntry): string {
	switch (entry.kind) {
		case "character":
			return entry.node.card.data.name;
		case "location":
		case "rule":
			return entry.node.id;
		case "event":
			return entry.node.id;
	}
}
