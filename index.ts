/**
 * Narrative Engine Extension for Pi
 *
 * 对话驱动的 AI 辅助叙事创作系统。用户说一句，引擎走一轮，输出文本，等用户再说。
 *
 * 架构：
 * - 主 LLM（元 AI）：和用户对话，理解意图，调用 narrative_step 工具
 * - narrative_step.execute：流水线编排函数（非 LLM），自动跑完整七步
 * - 调度器：独立 Agent 实例，只调一次 LLM 分配知识（信息差）
 * - 角色池：每个角色独立 Agent 实例，上下文隔离
 * - 世界图：唯一状态中心，git 版本管理
 *
 * 上下文隔离原理：
 * - 调度器、角色、渲染器都是独立 Agent 实例，messages = []
 * - 主会话的代码对话不会进入这些子代理的 messages
 * - 主 LLM 只通过 narrative_step 的结构化参数与流水线通信
 */

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import path from "node:path";
import { WorldGraph } from "./world-graph";
import { RolePool } from "./role-pool";
import { Scheduler } from "./scheduler";
import { Renderer } from "./renderer";
import { RuleLoader, findProjectRoot } from "./rule-loader";
import { initNovelTool } from "./init-tool";
import { addRuleTool } from "./add-rule-tool";
import type { EventNode } from "./types";

interface NarrativeStepDetails {
	intent: string;
	eventId: string;
	characters: string[];
	what: string;
	place: string;
	renderStyle: string;
	focus: string;
	roleActions: string[];
	commitSha: string;
	diffusionCount: number;
	renderOutputPath: string;
	chapterPath: string | null;
	status: "done";
}

interface QueryDetails {
	query: string;
	result: string;
}

// 流水线编排工具
const narrativeStepTool = defineTool({
	name: "narrative_step",
	label: "Narrative Step",
	description:
		"执行一个叙事事件。输入意图和事件五要素，自动走完七步流水线（BFS检索→调度器分配知识与指令→角色互动→调度器分配扩散→写回→提交→渲染→写文件），返回叙事文本。",
	promptSnippet: "推进叙事事件",
	parameters: Type.Object({
		intent: Type.String({ description: "意图类型: add/modify/insert/delete/query" }),
		time: Type.String({ description: "故事时间" }),
		place: Type.String({ description: "地点" }),
		what: Type.String({ description: "发生了什么" }),
		characters: Type.Array(Type.String(), { description: "涉及角色名" }),
		purpose: Type.String({ description: "事件意图" }),
		eventId: Type.Optional(
			Type.String({ description: "modify/insert/delete 时目标事件ID" }),
		),
		start_new_chapter: Type.Optional(
			Type.Boolean({ description: '是否开始新章节。用户说"开始新章节"/"第二章"等时设为 true' }),
		),
		chapter_title: Type.Optional(
			Type.String({ description: "新章节标题（start_new_chapter=true 时使用，如 '初入王都'）" }),
		),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const graph = (globalThis as { __narrativeGraph?: WorldGraph }).__narrativeGraph;
		const scheduler = (globalThis as { __narrativeScheduler?: Scheduler }).__narrativeScheduler;
		const rolePool = (globalThis as { __narrativeRolePool?: RolePool }).__narrativeRolePool;
		const renderer = (globalThis as { __narrativeRenderer?: Renderer }).__narrativeRenderer;

		// 错误详情构造器，保证字段完整
		const errDetails = (eventId = ""): NarrativeStepDetails => ({
			intent: params.intent,
			eventId,
			characters: params.characters,
			what: params.what,
			place: params.place,
			renderStyle: "",
			focus: "",
			roleActions: [],
			commitSha: "",
			diffusionCount: 0,
			renderOutputPath: "",
			chapterPath: null,
			status: "done",
		});

		if (!graph || !scheduler || !rolePool || !renderer) {
			return {
				content: [{ type: "text" as const, text: "Narrative engine not initialized." }],
				details: errDetails(),
				terminate: true,
			};
		}

		// 从 ctx 获取 model + apiKey（子代理用同一 provider）
		const model = ctx.model;
		if (!model) {
			return {
				content: [{ type: "text" as const, text: "No model available." }],
				details: errDetails(),
				terminate: true,
			};
		}
		const apiKey = await ctx.modelRegistry.getApiKeyForProvider(model.provider);

		// 步骤 0：构造事件节点
		const event: EventNode = {
			id: `evt_${Date.now()}`,
			time: params.time,
			place: params.place,
			what: params.what,
			characters: params.characters,
			purpose: params.purpose,
			commitSha: "",
			diffusions: [],
		};

		// 步骤 0.5：modify/insert/delete 回退 + 子代理重置
		// rollback 的 git reset 已把 narrative.txt 回退到目标点，后续渲染用 append 在回退文本上追加
		const needsRollback =
			params.intent === "modify" ||
			params.intent === "insert" ||
			params.intent === "delete";
		if (needsRollback) {
			if (!params.eventId) {
				return {
					content: [
						{
							type: "text" as const,
							text: `${params.intent} 意图需要 eventId 参数。`,
						},
					],
					details: errDetails(),
					terminate: true,
				};
			}
			try {
				// insert 在目标事件之后插入（保留目标事件）；modify/delete 回退到目标事件之前
				if (params.intent === "insert") {
					await graph.rollbackToAfter(params.eventId);
				} else {
					await graph.rollback(params.eventId);
				}
				// rollback 后子代理累积上下文已失效（世界状态已回退），清空重建
				scheduler.reset();
				rolePool.clear();
				renderer.reset();
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Rollback failed: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: errDetails(params.eventId),
					terminate: true,
				};
			}
		}

		// query 意图：直接返回世界图信息，不走流水线
		if (params.intent === "query") {
			const events = await graph.loadEvents();
			const chars = await graph.listCharacters();
			const resultText = [
				`=== 当前世界状态 ===`,
				`角色：${chars.join(", ") || "(无)"}`,
				`事件（${events.length}）：`,
				...events.slice(-10).map(
					(e) => `  - [${e.time}] ${e.what} @${e.place} (${e.characters.join(",")})`,
				),
			].join("\n");
			return {
				content: [{ type: "text" as const, text: resultText }],
				details: errDetails(event.id),
				terminate: true,
			};
		}

		// delete 意图：回退后不走流水线，返回状态摘要
		// rollback 已删除目标事件及之后的所有事件 + 回退世界状态
		if (params.intent === "delete") {
			const events = await graph.loadEvents();
			const chars = await graph.listCharacters();
			const summary = [
				`已删除事件 ${params.eventId} 及其后续。`,
				`当前事件数：${events.length}`,
				`角色：${chars.join(", ") || "(无)"}`,
				"",
				"剩余事件：",
				...events.slice(-10).map(
					(e) => `  - [${e.time}] ${e.what} @${e.place} (${e.characters.join(",")})`,
				),
			].join("\n");
			return {
				content: [{ type: "text" as const, text: summary }],
				details: errDetails(params.eventId ?? ""),
				terminate: true,
			};
		}

		// 步骤 1：BFS 检索相关世界条目
		const worldEntries = await graph.collectRelevant(event);

		// 步骤 2：调度器阶段1——制定分配方案（知识 + 指令 + 渲染指令）
		const schedule = await scheduler.plan(event, worldEntries, model, apiKey);

		// 步骤 3：角色子代理池交互（按调度器分配的指令和知识演出）
		const { outputs: structuredOutputs, errors: roleErrors } = await rolePool.interact(
			event,
			worldEntries,
			schedule,
			model,
			apiKey,
		);

		// 角色全部失败时跳过后续流水线，直接返回错误
		if (structuredOutputs.length === 0) {
			const errList = roleErrors.length > 0 ? roleErrors.join("; ") : "no role outputs";
			return {
				content: [
					{
						type: "text" as const,
						text: `No role outputs produced. Pipeline stopped at step 3.\nErrors: ${errList}\n\nAvailable characters: ${(await graph.listCharacters()).join(", ") || "(none)"}`,
					},
				],
				details: errDetails(event.id),
				terminate: true,
			};
		}

		// 步骤 4：调度器阶段2——看角色返回结果，智能分配扩散
		const diffusions = await scheduler.diffuse(
			event,
			worldEntries,
			structuredOutputs,
			model,
			apiKey,
		);

		// 步骤 5：写回世界图（关系值增量、knowledge 追加、emotion/location 覆盖）
		await graph.writeBack(diffusions);

		// 步骤 6：追加事件到事件序列（必须在 commit 之前，让 git commit 包含完整 events.json）
		await graph.appendEvent(event);

		// 步骤 7：提交 git（包含 events.json + 角色状态 + 当前 narrative.txt）
		const commitSha = await graph.commit(event);
		event.commitSha = commitSha;
		event.diffusions = diffusions.map((d) => ({
			nodeId: d.nodeId,
			field: d.field,
			oldValue: d.oldValue,
			newValue: d.newValue,
		}));

		// 步骤 8：渲染（写入运行时 narrative.txt + 工程正文/章节文件）
		const renderResult = await renderer.render(
			event,
			structuredOutputs,
			schedule.renderStyle,
			schedule.focus,
			"append",
			model,
			apiKey,
			undefined,
			{
				startNewChapter: params.start_new_chapter ?? false,
				chapterTitle: params.chapter_title,
			},
		);

		const roleActions = structuredOutputs.map((o) => `${o.actor}: ${o.action}`);

		return {
			content: [{ type: "text" as const, text: renderResult.text }],
			details: {
				intent: params.intent,
				eventId: event.id,
				characters: params.characters,
				what: params.what,
				place: params.place,
				renderStyle: schedule.renderStyle,
				focus: schedule.focus,
				roleActions,
				commitSha,
				diffusionCount: diffusions.length,
				renderOutputPath: renderer.getOutputPath(),
				chapterPath: renderResult.chapterPath,
				status: "done" as const,
			} satisfies NarrativeStepDetails,
			terminate: true,
		};
	},

	renderResult(result, _options, theme) {
		const details = result.details as NarrativeStepDetails | undefined;
		if (!details) {
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "", 0, 0);
		}
		const header = theme.fg(
			"toolTitle",
			`[narrative] ${details.intent} → ${details.eventId} (${details.status})`,
		);
		const meta = theme.fg(
			"muted",
			`characters: ${details.characters.join(", ")} | style: ${details.renderStyle} | diffusions: ${details.diffusionCount} | commit: ${details.commitSha.slice(0, 7)}${details.chapterPath ? ` | chapter: ${path.basename(details.chapterPath)}` : ""}`,
		);
		const body = result.content[0]?.type === "text" ? result.content[0].text : "";
		return new Text(`${header}\n${meta}\n\n${body}`, 0, 0);
	},
});

// 查询世界图工具
const queryWorldGraphTool = defineTool({
	name: "query_world_graph",
	label: "Query World Graph",
	description:
		"查询世界图中的角色状态、关系、历史事件、地点信息。用于查询意图。",
	promptSnippet: "查询世界图状态",
	parameters: Type.Object({
		query: Type.String({ description: "查询内容（自然语言）" }),
		target: Type.Optional(
			Type.String({ description: "查询目标：角色名/地点名/事件ID（可选）" }),
		),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const graph = (globalThis as { __narrativeGraph?: WorldGraph }).__narrativeGraph;
		if (!graph) {
			return {
				content: [{ type: "text" as const, text: "World graph not initialized." }],
				details: { query: params.query, result: "not initialized" } satisfies QueryDetails,
			};
		}

		let resultText = "";

		// 按 target 查询特定节点
		if (params.target) {
			const target = params.target;
			// 尝试角色
			try {
				const node = await graph.loadCharacter(target);
				const d = node.card.data;
				resultText = [
					`角色：${d.name}`,
					`描述：${d.description}`,
					`性格：${d.personality}`,
					`场景：${d.scenario}`,
					`--- 当前状态 ---`,
					`情绪：${node.ne.state.emotion}`,
					`位置：${node.ne.state.location}`,
					`关系：${JSON.stringify(node.ne.state.relationships)}`,
					`已知：${node.ne.state.knowledge.join(", ") || "(无)"}`,
					`--- 记忆（${node.ne.memories.length}条）---`,
					...node.ne.memories.slice(-5).map(
						(m) => `[${m.distance}] ${m.timestamp}: ${m.summary}`,
					),
				].join("\n");
			} catch {
				// 尝试地点
				try {
					const node = await graph.loadLocation(target);
					resultText = [
						`地点：${node.id}`,
						`当前状态：${node.content}`,
						`--- 版本历史（${node.versions.length}条）---`,
						...node.versions.slice(-5).map(
							(v) => `[${v.timestamp}] ${v.content}`,
						),
					].join("\n");
				} catch {
					// 尝试事件
					const event = await graph.getEvent(target);
					if (event) {
						resultText = [
							`事件：${event.id}`,
							`时间：${event.time}`,
							`地点：${event.place}`,
							`事件：${event.what}`,
							`角色：${event.characters.join(", ")}`,
							`意图：${event.purpose}`,
							`commit: ${event.commitSha}`,
						].join("\n");
					} else {
						resultText = `未找到：${target}`;
					}
				}
			}
		} else {
			// 无 target：列出所有角色和事件概要
			const characters = await graph.listCharacters();
			const events = await graph.loadEvents();
			resultText = [
				`=== 世界图概览 ===`,
				`角色（${characters.length}）：${characters.join(", ") || "(无)"}`,
				`事件（${events.length}）：`,
				...events.slice(-10).map(
					(e) => `  - [${e.time}] ${e.what} @${e.place} (${e.characters.join(",")})`,
				),
			].join("\n");
		}

		return {
			content: [{ type: "text" as const, text: resultText }],
			details: { query: params.query, result: resultText } satisfies QueryDetails,
		};
	},

	renderResult(result, _options, theme) {
		const details = result.details as QueryDetails | undefined;
		if (!details) {
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "", 0, 0);
		}
		return new Text(theme.fg("toolTitle", `[query] ${details.query}`) + "\n" + details.result, 0, 0);
	},
});

export default function (pi: ExtensionAPI) {
	// 初始化世界图 + 子代理
	const worldGraphDir = path.join(process.cwd(), ".pi", "world-graph");
	const promptsDir = path.join(process.cwd(), ".pi", "extensions", "narrative-engine", "prompts");
	const templatesDir = path.join(process.cwd(), ".pi", "extensions", "narrative-engine", "templates");

	// RuleLoader：从 novel.yaml 所在目录加载工程规则
	const projectRoot = findProjectRoot(process.cwd());
	const ruleLoader = new RuleLoader(projectRoot ?? process.cwd());

	const graph = new WorldGraph(pi, worldGraphDir);
	const scheduler = new Scheduler(promptsDir);
	const rolePool = new RolePool(graph, promptsDir);
	const renderer = new Renderer(promptsDir, worldGraphDir, projectRoot);

	(globalThis as { __narrativeGraph?: WorldGraph }).__narrativeGraph = graph;
	(globalThis as { __narrativeScheduler?: Scheduler }).__narrativeScheduler = scheduler;
	(globalThis as { __narrativeRolePool?: RolePool }).__narrativeRolePool = rolePool;
	(globalThis as { __narrativeRenderer?: Renderer }).__narrativeRenderer = renderer;
	(globalThis as { __narrativeRuleLoader?: RuleLoader }).__narrativeRuleLoader = ruleLoader;
	(globalThis as { __narrativeTemplatesDir?: string }).__narrativeTemplatesDir = templatesDir;

	// 注册工具
	pi.registerTool(narrativeStepTool);
	pi.registerTool(queryWorldGraphTool);
	pi.registerTool(initNovelTool);
	pi.registerTool(addRuleTool);

	// session 启动时初始化世界图 + 加载工程规则
	pi.on("session_start", async (event, ctx) => {
		try {
			await graph.init();
			// 清空 WorldGraph 内存缓存，下次读取从磁盘加载
			// 确保 /new 或重启 session 后能读到角色卡文件的最新修改
			graph.clearCache();
			// 加载工程规则并注入三个子代理（同时重读 prompt 文件）
			const rules = ruleLoader.load();
			scheduler.setRules(rules);
			rolePool.setRules(rules);
			renderer.setRules(rules);
			// 重置子代理状态（新 session 清空上下文）
			scheduler.reset();
			rolePool.clear();
			renderer.reset();
			if (event.reason === "new") {
				const charCount = (await graph.listCharacters()).length;
				const eventCount = (await graph.loadEvents()).length;
				const novel = ruleLoader.loadNovelMeta();
				const novelInfo = novel ? ` | ${novel.title} (${novel.genre})` : "";
				ctx.ui.notify(
					`Narrative engine loaded. ${charCount} characters, ${eventCount} events${novelInfo}.`,
					"info",
				);
			}
		} catch (err) {
			ctx.ui.notify(`World graph init failed: ${err}`, "error");
		}
	});
}
