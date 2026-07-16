// 调度器
// 独立 Agent 实例，与主会话隔离
// 职责：
//   1. plan()：语义理解事件 + BFS 世界条目，制定分配方案
//      - 每个角色可见的世界条目 id
//      - 每个角色的行动指令（调度器告诉角色该怎么演）
//      - 渲染指令（文风 + 焦点）
//   2. diffuse()：看角色代理返回的结构化输出，智能分配世界扩散
//      - 决定更新哪些角色的 state 字段
//      - 决定更新哪些地点的 content
//      - 输出 Diffusion[] 供世界图写回
//
// 上下文隔离：调度器是独立 Agent，messages = []，看不到主会话
// 持久性：调度器 messages 累积历史决策（跨事件），不与主会话共享

import { readFileSync } from "node:fs";
import path from "node:path";
import { Agent, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import { streamSimple, type Model } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import type { Diffusion, EventNode, StructuredOutput, WorldEntry } from "./types";

// ============================================================
// plan 工具：第一阶段，制定分配方案
// ============================================================

const planSchema = Type.Object({
	role_assignments: Type.Array(
		Type.Object({
			role: Type.String({ description: "角色名" }),
			visible_entry_ids: Type.Array(
				Type.String(),
				{ description: "该角色可见的世界条目 id 列表" },
			),
			instructions: Type.String({
				description: "给该角色的行动指令（告诉角色在本事件中该怎么演、注意什么）",
			}),
		}),
		{ description: "每个角色的知识分配和行动指令" },
	),
	render_style: Type.String({ description: "渲染风格指令（短句，如 '紧张、压抑'）" }),
	focus: Type.String({ description: "本事件叙事重点（一句话，告诉渲染器突出什么）" }),
});

type PlanDetails = Static<typeof planSchema>;

function createPlanTool(): AgentTool<typeof planSchema, PlanDetails> {
	return {
		name: "plan",
		label: "Plan",
		description: "制定当前事件的分配方案：角色可见知识 + 角色行动指令 + 渲染指令。只能调用一次。",
		parameters: planSchema,
		execute: async (_id, params) => ({
			content: [{ type: "text" as const, text: `Plan ready: ${params.role_assignments.length} roles` }],
			details: params,
			terminate: true,
		}),
	};
}

// ============================================================
// diffuse 工具：第二阶段，根据角色输出分配世界扩散
// ============================================================

const diffuseSchema = Type.Object({
	diffusions: Type.Array(
		Type.Object({
			node_id: Type.String({ description: "被更新节点 id（角色名/地点名）" }),
			field: Type.String({
				description: "更新字段路径，如 'state.emotion' / 'state.relationships.张三' / 'state.location' / 'content'（地点）",
			}),
			new_value: Type.String({ description: "新值（关系值用数字字符串如 '+0.3' / '-0.5'）" }),
			reason: Type.String({ description: "为什么这样更新（简短）" }),
		}),
		{ description: "本次事件的扩散更新列表" },
	),
});

type DiffuseDetails = Static<typeof diffuseSchema>;

function createDiffuseTool(): AgentTool<typeof diffuseSchema, DiffuseDetails> {
	return {
		name: "diffuse",
		label: "Diffuse",
		description: "根据角色代理的输出，分配世界状态的扩散更新。只能调用一次。",
		parameters: diffuseSchema,
		execute: async (_id, params) => ({
			content: [{ type: "text" as const, text: `Diffused: ${params.diffusions.length} updates` }],
			details: params,
			terminate: true,
		}),
	};
}

// ============================================================
// 调度器输出类型
// ============================================================

export type RoleAssignment = {
	role: string;
	visibleEntryIds: string[];
	instructions: string;
};

export type Schedule = {
	roleAssignments: Map<string, RoleAssignment>;
	renderStyle: string;
	focus: string;
};

// ============================================================
// 调度器类
// ============================================================

export class Scheduler {
	private agent: Agent | null = null;
	private systemPrompt: string;
	private planTool: AgentTool<typeof planSchema, PlanDetails>;
	private diffuseTool: AgentTool<typeof diffuseSchema, DiffuseDetails>;

	constructor(promptsDir: string) {
		try {
			this.systemPrompt = readFileSync(path.join(promptsDir, "scheduler.md"), "utf-8");
		} catch {
			this.systemPrompt = "你是叙事调度器。";
		}
		this.planTool = createPlanTool();
		this.diffuseTool = createDiffuseTool();
	}

	private getOrCreateAgent(model: Model<any>, apiKey: string | undefined): Agent {
		if (this.agent) return this.agent;

		this.agent = new Agent({
			initialState: {
				systemPrompt: this.systemPrompt,
				model,
				thinkingLevel: "low",
				tools: [this.planTool, this.diffuseTool],
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

	// ============================================================
	// 阶段1：制定分配方案
	// ============================================================

	async plan(
		event: EventNode,
		worldEntries: WorldEntry[],
		model: Model<any>,
		apiKey: string | undefined,
		signal?: AbortSignal,
	): Promise<Schedule> {
		const agent = this.getOrCreateAgent(model, apiKey);
		const prompt = buildPlanPrompt(event, worldEntries);

		let plan: PlanDetails | null = null;
		const unsub = agent.subscribe((ev: AgentEvent) => {
			if (ev.type === "tool_execution_start" && ev.toolName === "plan") {
				plan = ev.args as PlanDetails;
			}
		});

		try {
			await this.runWithAbort(agent, prompt, signal);
		} finally {
			unsub();
		}

		if (!plan) {
			// 退化：全量分配，空指令
			const allIds = worldEntries.map((e) => entryIdOf(e));
			return {
				roleAssignments: new Map(
					event.characters.map((r) => [
						r,
						{ role: r, visibleEntryIds: allIds, instructions: "" },
					]),
				),
				renderStyle: "中性",
				focus: event.what,
			};
		}

		// 校验 id 有效性，构建 Map
		const validIds = new Set(worldEntries.map((e) => entryIdOf(e)));
		const roleAssignments = new Map<string, RoleAssignment>();
		for (const ra of plan.role_assignments) {
			roleAssignments.set(ra.role, {
				role: ra.role,
				visibleEntryIds: ra.visible_entry_ids.filter((id) => validIds.has(id)),
				instructions: ra.instructions,
			});
		}
		// 兜底：未分配的角色给空
		for (const role of event.characters) {
			if (!roleAssignments.has(role)) {
				roleAssignments.set(role, { role, visibleEntryIds: [], instructions: "" });
			}
		}

		return {
			roleAssignments,
			renderStyle: plan.render_style,
			focus: plan.focus,
		};
	}

	// ============================================================
	// 阶段2：根据角色输出分配扩散
	// ============================================================

	async diffuse(
		event: EventNode,
		worldEntries: WorldEntry[],
		structuredOutputs: StructuredOutput[],
		model: Model<any>,
		apiKey: string | undefined,
		signal?: AbortSignal,
	): Promise<Diffusion[]> {
		const agent = this.getOrCreateAgent(model, apiKey);
		const prompt = buildDiffusePrompt(event, worldEntries, structuredOutputs);

		let result: DiffuseDetails | null = null;
		const unsub = agent.subscribe((ev: AgentEvent) => {
			if (ev.type === "tool_execution_start" && ev.toolName === "diffuse") {
				result = ev.args as DiffuseDetails;
			}
		});

		try {
			await this.runWithAbort(agent, prompt, signal);
		} finally {
			unsub();
		}

		if (!result) {
			// 退化：无扩散
			return [];
		}

		// 转换为 Diffusion[]
		// 关系值 new_value 形如 "+0.3" / "-0.5"，世界图写回时解析
		return result.diffusions.map((d) => ({
			nodeId: d.node_id,
			field: d.field,
			oldValue: "",
			newValue: d.new_value,
			eventId: event.id,
			eventTime: event.time,
		}));
	}

	// ============================================================
	// 辅助
	// ============================================================

	private async runWithAbort(
		agent: Agent,
		prompt: string,
		signal?: AbortSignal,
	): Promise<void> {
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

function buildPlanPrompt(event: EventNode, entries: WorldEntry[]): string {
	const parts: string[] = [];

	parts.push("--- 当前事件 ---");
	parts.push(`事件ID：${event.id}`);
	parts.push(`时间：${event.time}`);
	parts.push(`地点：${event.place}`);
	parts.push(`发生了什么：${event.what}`);
	parts.push(`涉及角色：${event.characters.join(", ")}`);
	parts.push(`事件意图：${event.purpose}`);

	parts.push("--- 可分配的世界条目 ---");
	for (const entry of entries) {
		parts.push(formatEntryForPrompt(entry));
	}

	parts.push("--- 你的任务（阶段1：制定方案）---");
	parts.push(
		`为每个涉及角色（${event.characters.join(", ")}）分配可见条目 id，给出行动指令，并指定渲染风格和叙事重点。`,
	);
	parts.push("指令应告诉角色：本事件中该突出什么情绪/动作/反应，但不要替角色写具体台词。");
	parts.push("调用 plan 工具输出方案。");

	return parts.join("\n");
}

function buildDiffusePrompt(
	event: EventNode,
	entries: WorldEntry[],
	outputs: StructuredOutput[],
): string {
	const parts: string[] = [];

	parts.push("--- 当前事件 ---");
	parts.push(`事件ID：${event.id}`);
	parts.push(`时间：${event.time}`);
	parts.push(`地点：${event.place}`);
	parts.push(`发生了什么：${event.what}`);
	parts.push(`涉及角色：${event.characters.join(", ")}`);

	parts.push("--- 当前世界状态（节点概要）---");
	for (const entry of entries) {
		// 只给调度器看节点概要，不重复完整内容
		parts.push(formatEntrySummary(entry));
	}

	parts.push("--- 角色代理返回的结构化输出 ---");
	for (const out of outputs) {
		parts.push(
			`【${out.actor}】动作：${out.action} | 对象：${out.target} | 情绪：${out.emotion} | 关系变化：${out.relation_update.target} ${out.relation_update.delta >= 0 ? "+" : ""}${out.relation_update.delta} | 内心：${out.thought}`,
		);
	}

	parts.push("--- 你的任务（阶段2：分配扩散）---");
	parts.push("根据角色输出，决定世界状态如何更新。可更新：");
	parts.push("- 角色情绪：state.emotion");
	parts.push("- 角色关系：state.relationships.<对象>（值为数字字符串如 '+0.3' / '-0.5'）");
	parts.push("- 角色位置：state.location");
	parts.push("- 角色知识：state.knowledge（值为新增的知识条目）");
	parts.push("- 地点状态：content（地点节点）");
	parts.push("调用 diffuse 工具输出扩散列表。");

	return parts.join("\n");
}

function formatEntryForPrompt(entry: WorldEntry): string {
	switch (entry.kind) {
		case "character": {
			const c = entry.node.card.data;
			const s = entry.node.ne.state;
			return `[character] id=${c.name} | name=${c.name} | emotion=${s.emotion} | location=${s.location} | relationships=${JSON.stringify(s.relationships)} | knowledge=${JSON.stringify(s.knowledge)}`;
		}
		case "location":
			return `[location] id=${entry.node.id} | content=${entry.node.content}`;
		case "rule":
			return `[rule] id=${entry.node.id} | content=${entry.node.content}`;
		case "event":
			return `[event] id=${entry.node.id} | time=${entry.node.time} | place=${entry.node.place} | what=${entry.node.what} | characters=${entry.node.characters.join(",")}`;
	}
}

function formatEntrySummary(entry: WorldEntry): string {
	switch (entry.kind) {
		case "character":
			return `${entry.node.card.data.name}（情绪:${entry.node.ne.state.emotion}, 位置:${entry.node.ne.state.location}）`;
		case "location":
			return `${entry.node.id}（地点）`;
		case "rule":
			return `${entry.node.id}（规则）`;
		case "event":
			return `${entry.node.id}（事件:${entry.node.what}）`;
	}
}

// 提取 WorldEntry 的 id（与 role-pool.ts 保持一致）
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
