// 角色卡导入脚本
// 把酒馆 V2 角色卡 + 世界书导入到 .pi/world-graph/
//
// 用法（在项目根目录）：
//   npx tsx .pi/extensions/narrative-engine/import-cards.ts <tavern-characters-dir> [--force]
//
// 参数：
//   tavern-characters-dir  酒馆角色卡目录（含 .json/.png 文件）
//   --force                覆盖已存在的角色/规则
//
// 环境变量（备选）：
//   TAVERN_CHARACTERS_DIR  如果未提供命令行参数，则使用此环境变量
//
// 示例：
//   npx tsx .pi/extensions/narrative-engine/import-cards.ts "/path/to/your/characters"
//   TAVERN_CHARACTERS_DIR=/path/to/chars npx tsx .pi/extensions/narrative-engine/import-cards.ts

import { promises as fs } from "node:fs";
import path from "node:path";

const WORLD_DIR = path.join(process.cwd(), ".pi", "world-graph");
const CHARACTERS_DIR = path.join(WORLD_DIR, "characters");
const RULES_DIR = path.join(WORLD_DIR, "rules"); // 注意：实际 world-graph 没有这个目录，规则存在 rules.json
const RULES_FILE = path.join(WORLD_DIR, "rules.json");

// 从命令行参数或环境变量获取酒馆角色卡目录
function resolveTavernDir(): string {
	const arg = process.argv.find((a) => !a.startsWith("-") && !a.endsWith(".ts") && a !== process.argv[0] && a !== process.argv[1]);
	if (arg) return arg;
	const env = process.env.TAVERN_CHARACTERS_DIR;
	if (env) return env;
	throw new Error(
		"Usage: npx tsx import-cards.ts <tavern-characters-dir> [--force]\n" +
			"   or: set TAVERN_CHARACTERS_DIR env var",
	);
}

// 要导入的角色卡文件名（不带路径，相对于 tavern dir）
// 如果留空，则扫描目录下所有 .json 文件
const CARD_FILES: string[] | null = null; // ["角色1.json", "角色2.json"] 或 null = 全部 .json

// 规则关键词映射：通用版本
// 从 entry.name 或 entry.comment 推断规则 id，无硬编码小说内容
const RULE_KEYS: Record<string, string> = {};

interface CharacterBookEntry {
	keys: string[];
	content: string;
	enabled: boolean;
	insertion_order: number;
	priority?: number;
}

interface TavernCardData {
	name: string;
	description: string;
	personality: string;
	scenario: string;
	first_mes: string;
	mes_example: string;
	creator_notes: string;
	system_prompt: string;
	post_history_instructions: string;
	alternate_greetings: string[];
	tags: string[];
	creator: string;
	character_version: string;
	extensions: Record<string, unknown>;
	character_book?: {
		name?: string;
		entries: CharacterBookEntry[];
	};
}

interface TavernCardV2 {
	spec: "chara_card_v2";
	spec_version: "2.0";
	data: TavernCardData;
}

interface CharacterState {
	emotion: string;
	location: string;
	relationships: Record<string, number>;
	knowledge: string[];
}

interface MemoryEntry {
	eventId: string;
	timestamp: string;
	summary: string;
	distance: "recent" | "mid" | "far";
}

interface CharacterNode {
	card: TavernCardV2;
	ne: {
		state: CharacterState;
		memories: MemoryEntry[];
	};
}

interface WorldNode {
	id: string;
	type: "location" | "rule";
	content: string;
	versions: { content: string; timestamp: string; eventId: string }[];
}

async function main() {
	const force = process.argv.includes("--force");
	const tavernDir = resolveTavernDir();

	console.log(`[config] tavern dir: ${tavernDir}`);
	console.log(`[config] world graph dir: ${WORLD_DIR}`);

	// 确保目录存在
	await fs.mkdir(CHARACTERS_DIR, { recursive: true });
	await fs.mkdir(RULES_DIR, { recursive: true });

	// 解析要导入的卡片文件列表
	const cardFiles = CARD_FILES ?? (await fs.readdir(tavernDir)).filter((f) => f.endsWith(".json"));
	console.log(`[config] found ${cardFiles.length} json cards`);

	// 收集所有角色卡
	const cards: TavernCardV2[] = [];
	for (const fname of cardFiles) {
		const fp = path.join(tavernDir, fname);
		try {
			const raw = await fs.readFile(fp, "utf-8");
			cards.push(JSON.parse(raw) as TavernCardV2);
			console.log(`[card] 读取 ${fname}`);
		} catch (err) {
			console.error(`[card] 读取失败 ${fname}: ${err}`);
		}
	}

	// 合并所有世界书词条，按规则 id 去重
	const ruleMap = new Map<string, { content: string; keys: string[] }>();
	for (const card of cards) {
		const book = card.data.character_book;
		if (!book) continue;
		for (const entry of book.entries) {
			if (!entry.enabled) continue;
			// 按第一个 key 映射到规则 id
			const firstKey = entry.keys[0];
			if (!firstKey) continue;
			const ruleId = RULE_KEYS[firstKey] ?? firstKey;
			// 同一规则 id 的词条合并 content（用最新的，或拼接）
			const existing = ruleMap.get(ruleId);
			if (existing) {
				// 拼接（去重简单处理：如果 content 完全相同则跳过）
				if (!existing.content.includes(entry.content)) {
					existing.content += `\n\n---\n\n${entry.content}`;
					existing.keys.push(...entry.keys);
				}
			} else {
				ruleMap.set(ruleId, { content: entry.content, keys: [...entry.keys] });
			}
		}
	}

	// 写入角色卡
	let imported = 0;
	let skipped = 0;
	for (const card of cards) {
		const name = card.data.name;
		const outPath = path.join(CHARACTERS_DIR, `${name}.json`);

		// 检查是否已存在
		if (!force) {
			try {
				await fs.access(outPath);
				console.log(`[char] 跳过（已存在）: ${name}`);
				skipped++;
				continue;
			} catch {
				// 不存在，继续
			}
		}

		// 构造 CharacterNode：原 card + 初始 ne 状态
		// 根据角色卡推断初始状态
		const initialState: CharacterState = {
			emotion: "平静",
			location: inferInitialLocation(name),
			relationships: inferInitialRelationships(name),
			knowledge: [],
		};

		const node: CharacterNode = {
			card,
			ne: {
				state: initialState,
				memories: [],
			},
		};

		// 把 ne 写入 extensions.narrative_engine（这样 world-graph.loadCharacter 能正确读取）
		node.card.data.extensions = {
			...node.card.data.extensions,
			narrative_engine: node.ne,
		};

		await fs.writeFile(outPath, JSON.stringify(node.card, null, 2), "utf-8");
		console.log(`[char] 导入 ${name}（emotion: ${initialState.emotion}, location: ${initialState.location}）`);
		imported++;
	}

	// 写入规则文件（rules.json，合并已有的）
	const existingRules: WorldNode[] = [];
	try {
		const raw = await fs.readFile(RULES_FILE, "utf-8");
		const data = JSON.parse(raw) as { rules: WorldNode[] };
		existingRules.push(...data.rules);
	} catch {
		// 不存在
	}

	const existingRuleIds = new Set(existingRules.map((r) => r.id));
	let rulesAdded = 0;
	for (const [ruleId, info] of ruleMap) {
		if (existingRuleIds.has(ruleId) && !force) {
			console.log(`[rule] 跳过（已存在）: ${ruleId}`);
			continue;
		}
		const rule: WorldNode = {
			id: ruleId,
			type: "rule",
			content: info.content,
			versions: [],
		};
		// 替换或追加
		const idx = existingRules.findIndex((r) => r.id === ruleId);
		if (idx >= 0) {
			existingRules[idx] = rule;
		} else {
			existingRules.push(rule);
		}
		console.log(`[rule] 导入 ${ruleId}（${info.keys.length} keys）`);
		rulesAdded++;
	}

	await fs.writeFile(RULES_FILE, JSON.stringify({ rules: existingRules }, null, 2), "utf-8");

	console.log("\n=== 导入完成 ===");
	console.log(`角色: ${imported} 导入, ${skipped} 跳过`);
	console.log(`规则: ${rulesAdded} 导入, 总计 ${existingRules.length}`);
	console.log(`\n世界图目录: ${WORLD_DIR}`);
}

// 根据角色名推断初始位置（通用：返回空字符串，让用户在角色卡中设置）
function inferInitialLocation(_name: string): string {
	return "";
}

// 根据角色名推断初始关系（通用：返回空对象，让角色在叙事中自然建立关系）
function inferInitialRelationships(_name: string): Record<string, number> {
	return {};
}

main().catch((err) => {
	console.error("Import failed:", err);
	process.exit(1);
});
