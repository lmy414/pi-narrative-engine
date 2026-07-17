// add_rule 工具
// 在叙事过程中增量添加规则。规则带上下文（何时为何所加），
// 自动路由到对应分类文件。下次 narrative_step 即生效。

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { RuleLoader, RuleCategory } from "./rule-loader";
import type { Scheduler } from "./scheduler";
import type { RolePool } from "./role-pool";
import type { Renderer } from "./renderer";

interface AddRuleDetails {
	category: RuleCategory;
	content: string;
	context: string;
	status: "done";
}

export const addRuleTool = defineTool({
	name: "add_rule",
	label: "Add Rule",
	description:
		'在叙事过程中增量添加规则。规则带上下文（何时为何所加），自动路由到对应分类文件，下次 narrative_step 即生效。用户在对话中说"诺艾尔不该说脏话"等约束时调用此工具。',
	promptSnippet: "增量添加叙事规则",
	parameters: Type.Object({
		content: Type.String({ description: "规则内容（自然语言描述）" }),
		category: Type.Union(
			[
				Type.Literal("总规则"),
				Type.Literal("内容规则"),
				Type.Literal("文风规则"),
				Type.Literal("检查清单"),
			],
			{ description: "规则分类：总规则(所有代理) / 内容规则(调度器+角色) / 文风规则(渲染器) / 检查清单(渲染器自检)" },
		),
		context: Type.String({
			description: "这条规则是在什么场景下、因为什么加的（用于变更日志追溯）",
		}),
		related_event_id: Type.Optional(
			Type.String({ description: "相关事件ID（可选，便于追溯）" }),
		),
	}),
	async execute(_toolCallId, params) {
		const ruleLoader = (globalThis as { __narrativeRuleLoader?: RuleLoader }).__narrativeRuleLoader;
		const scheduler = (globalThis as { __narrativeScheduler?: Scheduler }).__narrativeScheduler;
		const rolePool = (globalThis as { __narrativeRolePool?: RolePool }).__narrativeRolePool;
		const renderer = (globalThis as { __narrativeRenderer?: Renderer }).__narrativeRenderer;

		if (!ruleLoader) {
			return {
				content: [{ type: "text" as const, text: "RuleLoader not initialized." }],
				details: {
					category: params.category,
					content: params.content,
					context: params.context,
					status: "done" as const,
				} satisfies AddRuleDetails,
				terminate: true,
			};
		}

		// 写入规则文件 + 变更日志
		ruleLoader.addRule({
			content: params.content,
			category: params.category,
			context: params.context,
			relatedEventId: params.related_event_id,
		});

		// 重新加载规则并注入三个子代理（下次 narrative_step 生效）
		const rules = ruleLoader.load();
		if (scheduler) scheduler.setRules(rules);
		if (rolePool) rolePool.setRules(rules);
		if (renderer) renderer.setRules(rules);

		const categoryDesc: Record<RuleCategory, string> = {
			总规则: "注入所有代理",
			内容规则: "注入调度器+角色",
			文风规则: "注入渲染器",
			检查清单: "注入渲染器自检",
		};

		return {
			content: [
				{
					type: "text" as const,
					text: `规则已添加到【${params.category}】（${categoryDesc[params.category]}）\n内容：${params.content}\n上下文：${params.context}\n\n下次 narrative_step 即生效。`,
				},
			],
			details: {
				category: params.category,
				content: params.content,
				context: params.context,
				status: "done" as const,
			} satisfies AddRuleDetails,
			terminate: true,
		};
	},
	renderResult(result, _options, theme) {
		const details = result.details as AddRuleDetails | undefined;
		if (!details) {
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "", 0, 0);
		}
		const header = theme.fg("toolTitle", `[add_rule] ${details.category}`);
		const body = result.content[0]?.type === "text" ? result.content[0].text : "";
		return new Text(`${header}\n${body}`, 0, 0);
	},
});
