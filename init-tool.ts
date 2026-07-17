// init_novel 工具
// 初始化小说工程：在指定目录创建工程骨架（novel.yaml + 规则/ + 设定/ + 正文/）
// 从 templates 目录拷贝默认模板，用户可随后修改

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import path from "node:path";
import { promises as fs, existsSync, readdirSync } from "node:fs";
import type { RuleLoader } from "./rule-loader";

interface InitNovelDetails {
	targetDir: string;
	createdFiles: string[];
	status: "done" | "exists";
}

async function copyDir(src: string, dest: string): Promise<string[]> {
	const created: string[] = [];
	if (!existsSync(dest)) {
		await fs.mkdir(dest, { recursive: true });
	}
	for (const entry of readdirSync(src, { withFileTypes: true })) {
		const srcPath = path.join(src, entry.name);
		const destPath = path.join(dest, entry.name);
		if (entry.isDirectory()) {
			created.push(...(await copyDir(srcPath, destPath)));
		} else {
			if (!existsSync(destPath)) {
				await fs.copyFile(srcPath, destPath);
				created.push(destPath);
			}
		}
	}
	return created;
}

export const initNovelTool = defineTool({
	name: "init_novel",
	label: "Init Novel Project",
	description:
		"初始化小说工程。在指定目录创建工程骨架：novel.yaml + 规则/ + 设定/ + 正文/。从模板拷贝默认规则文件，可随后修改。如果目录已存在 novel.yaml 则不覆盖。",
	promptSnippet: "初始化小说工程",
	parameters: Type.Object({
		target_dir: Type.String({
			description: "工程目标目录（绝对路径）。不传则用当前工作目录",
		}),
		title: Type.Optional(Type.String({ description: "作品标题（写入 novel.yaml）" })),
		genre: Type.Optional(Type.String({ description: "类型，如 奇幻冒险+百合" })),
	}),
	async execute(_toolCallId, params) {
		const templatesDir = (globalThis as { __narrativeTemplatesDir?: string }).__narrativeTemplatesDir;
		const targetDir = params.target_dir || process.cwd();
		const novelYamlPath = path.join(targetDir, "novel.yaml");

		// 已存在工程，不覆盖
		if (existsSync(novelYamlPath)) {
			return {
				content: [
					{
						type: "text" as const,
						text: `工程已存在于 ${targetDir}，未做修改。要重新初始化请先删除 novel.yaml。`,
					},
				],
				details: { targetDir, createdFiles: [], status: "exists" as const } satisfies InitNovelDetails,
				terminate: true,
			};
		}

		// 拷贝模板
		const createdFiles: string[] = [];
		if (templatesDir && existsSync(templatesDir)) {
			// 拷贝 novel.yaml 模板
			const templateYaml = path.join(templatesDir, "novel.yaml");
			if (existsSync(templateYaml)) {
				await fs.mkdir(targetDir, { recursive: true });
				let yamlContent = await fs.readFile(templateYaml, "utf-8");
				// 用参数替换标题和类型
				if (params.title) {
					yamlContent = yamlContent.replace(/title:\s*".*?"/, `title: "${params.title}"`);
				}
				if (params.genre) {
					yamlContent = yamlContent.replace(/genre:\s*".*?"/, `genre: "${params.genre}"`);
				}
				await fs.writeFile(novelYamlPath, yamlContent, "utf-8");
				createdFiles.push(novelYamlPath);
			}

			// 拷贝 规则/ 目录
			const templatesRulesDir = path.join(templatesDir, "规则");
			if (existsSync(templatesRulesDir)) {
				const destRulesDir = path.join(targetDir, "规则");
				createdFiles.push(...(await copyDir(templatesRulesDir, destRulesDir)));
			}
		}

		// 创建 设定/ 和 正文/ 目录
		await fs.mkdir(path.join(targetDir, "设定", "角色"), { recursive: true });
		await fs.mkdir(path.join(targetDir, "正文"), { recursive: true });
		await fs.writeFile(path.join(targetDir, "设定", "世界观.md"), "# 世界观\n\n[在此定义世界观]\n", "utf-8");
		await fs.writeFile(path.join(targetDir, "设定", "大纲.md"), "# 大纲\n\n[在此规划章节]\n", "utf-8");

		// 让 RuleLoader 重新加载
		const ruleLoader = (globalThis as { __narrativeRuleLoader?: RuleLoader }).__narrativeRuleLoader;
		if (ruleLoader) {
			ruleLoader.invalidate();
		}

		const fileList = createdFiles.map((f) => `  - ${path.relative(targetDir, f) || f}`).join("\n");
		return {
			content: [
				{
					type: "text" as const,
					text: `小说工程已初始化于 ${targetDir}\n\n创建的文件：\n${fileList}\n\n目录结构：\n  novel.yaml          作品元信息\n  规则/               规则文件（可替换）\n  设定/               世界观 + 角色 + 大纲\n  正文/               章节文件\n\n下一步：修改 novel.yaml 填入作品定位，编辑 规则/ 下的文件定义叙事约束。`,
				},
			],
			details: { targetDir, createdFiles, status: "done" as const } satisfies InitNovelDetails,
			terminate: true,
		};
	},
	renderResult(result, _options, theme) {
		const details = result.details as InitNovelDetails | undefined;
		if (!details) {
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "", 0, 0);
		}
		const header = theme.fg("toolTitle", `[init_novel] ${details.status} → ${details.targetDir}`);
		const body = result.content[0]?.type === "text" ? result.content[0].text : "";
		return new Text(`${header}\n\n${body}`, 0, 0);
	},
});
