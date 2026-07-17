// RuleLoader
// 按代理类型加载工程规则文件，支持文件替换（换文件内容即换规则）。
//
// 设计要点：
// - 规则文件按目录扫描加载，不硬编码文件名（约定但可替换）
// - 按消费者分注入：总规则给所有代理、内容规则给调度器+角色、文风/检查清单给渲染器
// - 缓存：add_rule 后失效重载，下次 narrative_step 生效
// - 兼容缺失：无工程目录时返回空字符串，不影响引擎运行

import { readFileSync, existsSync, readdirSync, appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

// ============================================================
// 类型定义
// ============================================================

export type NovelMeta = {
	title: string;
	genre: string;
	scale: string;
	ending: string;
	cp: string[];
	premise: string;
	base_directive: string;
};

export type RuleCategory =
	| "总规则" // 所有代理
	| "内容规则" // 调度器 + 角色
	| "文风规则" // 渲染器
	| "检查清单"; // 渲染器

export type RuleSet = {
	/** 给所有代理的基底（总规则 + novel.yaml.base_directive） */
	common: string;
	/** 给调度器（内容规则） */
	scheduler: string;
	/** 给角色（内容规则） */
	roles: string;
	/** 给渲染器（文风规则 + 检查清单） */
	renderer: string;
};

export type RuleChangeLogEntry = {
	id: string;
	op: "add" | "modify" | "delete";
	file: string;
	section?: string;
	content: string;
	context: string;
	addedAt: string;
	relatedEventId?: string;
};

// ============================================================
// RuleLoader
// ============================================================

export class RuleLoader {
	private rulesDir: string;
	private novelYamlPath: string;
	private logPath: string;
	private cache: RuleSet | null = null;
	private novelCache: NovelMeta | null = null;

	constructor(projectRoot: string) {
		this.rulesDir = path.join(projectRoot, "规则");
		this.novelYamlPath = path.join(projectRoot, "novel.yaml");
		this.logPath = path.join(this.rulesDir, "规则变更日志.jsonl");
	}

	/** 加载 novel.yaml 作品元信息 */
	loadNovelMeta(): NovelMeta | null {
		if (this.novelCache) return this.novelCache;
		if (!existsSync(this.novelYamlPath)) return null;
		try {
			const raw = readFileSync(this.novelYamlPath, "utf-8");
			const parsed = parseSimpleYaml(raw);
			this.novelCache = {
				title: parsed.title ?? "未命名作品",
				genre: parsed.genre ?? "",
				scale: parsed.scale ?? "普通",
				ending: parsed.ending ?? "",
				cp: parsed.cp ?? [],
				premise: parsed.premise ?? "",
				base_directive: parsed.base_directive ?? "",
			};
			return this.novelCache;
		} catch {
			return null;
		}
	}

	/** 按代理类型加载规则集合 */
	load(): RuleSet {
		if (this.cache) return this.cache;

		if (!existsSync(this.rulesDir)) {
			this.cache = { common: "", scheduler: "", roles: "", renderer: "" };
			return this.cache;
		}

		// 扫描规则目录下所有 .md 文件（不硬编码文件名）
		const mdFiles = readdirSync(this.rulesDir)
			.filter((f) => f.endsWith(".md"))
			.map((f) => ({
				name: f,
				path: path.join(this.rulesDir, f),
			}));

		let common = "";
		let contentRules = "";
		let styleRules = "";
		let checklist = "";

		for (const file of mdFiles) {
			// 按文件名匹配消费者（约定但可替换：换内容即可）
			const baseName = file.name.replace(/\.md$/i, "");
			const content = readFileSync(file.path, "utf-8");

			if (baseName.includes("总") || baseName.toLowerCase().includes("general")) {
				common += `\n\n${content}`;
			} else if (baseName.includes("内容") || baseName.toLowerCase().includes("content")) {
				contentRules += `\n\n${content}`;
			} else if (baseName.includes("文风") || baseName.toLowerCase().includes("style")) {
				styleRules += `\n\n${content}`;
			} else if (baseName.includes("检查") || baseName.toLowerCase().includes("check")) {
				checklist += `\n\n${content}`;
			}
		}

		// novel.yaml 的 base_directive 追加到总规则基底
		const novel = this.loadNovelMeta();
		if (novel && novel.base_directive.trim()) {
			common += `\n\n--- 作品基底约束 ---\n${novel.base_directive}`;
		}

		this.cache = {
			common: common.trim(),
			scheduler: contentRules.trim(),
			roles: contentRules.trim(),
			renderer: (styleRules + checklist).trim(),
		};
		return this.cache;
	}

	/** 失效缓存，下次 load 重新读文件 */
	invalidate(): void {
		this.cache = null;
	}

	/** 增量添加规则到指定文件，写变更日志 */
	addRule(params: {
		content: string;
		category: RuleCategory;
		context: string;
		relatedEventId?: string;
	}): void {
		if (!existsSync(this.rulesDir)) {
			mkdirSync(this.rulesDir, { recursive: true });
		}

		// 映射 category → 文件名
		const fileName = categoryToFile(params.category);
		const filePath = path.join(this.rulesDir, fileName);

		// 追加到文件末尾
		const section = `\n\n## 增量规则（${new Date().toISOString().slice(0, 19)}）\n\n${params.content}\n`;
		if (!existsSync(filePath)) {
			appendFileSync(filePath, `# ${params.category}\n${section}`, "utf-8");
		} else {
			appendFileSync(filePath, section, "utf-8");
		}

		// 写变更日志
		const entry: RuleChangeLogEntry = {
			id: `rule_${Date.now()}`,
			op: "add",
			file: fileName,
			content: params.content,
			context: params.context,
			addedAt: new Date().toISOString(),
			relatedEventId: params.relatedEventId,
		};
		appendFileSync(this.logPath, JSON.stringify(entry) + "\n", "utf-8");

		// 失效缓存
		this.invalidate();
	}

	/** 读取规则变更日志 */
	loadChangeLog(): RuleChangeLogEntry[] {
		if (!existsSync(this.logPath)) return [];
		try {
			const raw = readFileSync(this.logPath, "utf-8");
			return raw
				.split("\n")
				.filter((line) => line.trim() && !line.startsWith("#"))
				.map((line) => JSON.parse(line) as RuleChangeLogEntry);
		} catch {
			return [];
		}
	}
}

// ============================================================
// 辅助
// ============================================================

function categoryToFile(category: RuleCategory): string {
	switch (category) {
		case "总规则":
			return "总规则.md";
		case "内容规则":
			return "内容规则.md";
		case "文风规则":
			return "文风规则.md";
		case "检查清单":
			return "检查清单.md";
	}
}

/** 查找 novel.yaml 所在的工程根目录 */
export function findProjectRoot(startDir: string): string | null {
	let dir = startDir;
	for (let i = 0; i < 5; i++) {
		if (existsSync(path.join(dir, "novel.yaml"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

// ============================================================
// 简易 YAML 解析（仅支持 novel.yaml 用到的字段：标量 + cp 列表 + base_directive 多行块）
// ============================================================

function parseSimpleYaml(raw: string): Record<string, string | string[]> {
	const result: Record<string, string | string[]> = {};
	const lines = raw.split("\n");
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		// 跳过注释和空行
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) {
			i++;
			continue;
		}
		// 多行块字段（base_directive: |）
		const blockMatch = line.match(/^(\w+):\s*\|/);
		if (blockMatch) {
			const key = blockMatch[1];
			const blockLines: string[] = [];
			i++;
			while (i < lines.length) {
				const l = lines[i];
				if (l.startsWith("  ") || l.startsWith("\t") || l.trim() === "") {
					blockLines.push(l.replace(/^[ \t]+/, ""));
				} else {
					break;
				}
				i++;
			}
			result[key] = blockLines.join("\n").trim();
			continue;
		}
		// 列表字段（cp:）
		if (/^cp:\s*$/.test(line)) {
			const items: string[] = [];
			i++;
			while (i < lines.length) {
				const l = lines[i];
				const itemMatch = l.match(/^\s+-\s+"?(.*?)"?\s*$/);
				if (itemMatch) {
					items.push(itemMatch[1]);
					i++;
				} else {
					break;
				}
			}
			result.cp = items;
			continue;
		}
		// 标量字段（key: "value" 或 key: value）
		const scalarMatch = line.match(/^(\w+):\s*(.*)$/);
		if (scalarMatch) {
			const key = scalarMatch[1];
			let value = scalarMatch[2].trim();
			// 去引号
			if (value.startsWith('"') && value.endsWith('"')) {
				value = value.slice(1, -1);
			}
			result[key] = value;
		}
		i++;
	}
	return result;
}
