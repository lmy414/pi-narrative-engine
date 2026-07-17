// 世界图管理
// 唯一状态中心：所有组件通过它读写状态
// git 独立 repo 管理版本，支持回退

import { promises as fs } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	CharacterNode,
	Diffusion,
	Edge,
	EventNode,
	EventsFile,
	NarrativeExtensions,
	RelationsFile,
	RulesFile,
	WorldEntry,
	WorldNode,
} from "./types";

const MAX_BFS_DEPTH = 3;

// 默认角色状态
function defaultState(): NarrativeExtensions["state"] {
	return {
		emotion: "平静",
		location: "",
		relationships: {},
		knowledge: [],
	};
}

// 默认扩展数据
function defaultNarrativeExtensions(): NarrativeExtensions {
	return {
		state: defaultState(),
		memories: [],
	};
}

export class WorldGraph {
	private readonly rootDir: string;
	private readonly charactersDir: string;
	private readonly locationsDir: string;
	private readonly eventsFile: string;
	private readonly relationsFile: string;
	private readonly rulesFile: string;

	// 内存缓存（session 内有效）
	private characterCache = new Map<string, CharacterNode>();
	private eventsCache: EventNode[] | null = null;
	private relationsCache: Edge[] | null = null;
	private rulesCache: WorldNode[] | null = null;

	constructor(
		private readonly pi: ExtensionAPI,
		worldGraphDir: string,
	) {
		this.rootDir = worldGraphDir;
		this.charactersDir = path.join(this.rootDir, "characters");
		this.locationsDir = path.join(this.rootDir, "locations");
		this.eventsFile = path.join(this.rootDir, "events.json");
		this.relationsFile = path.join(this.rootDir, "relations.json");
		this.rulesFile = path.join(this.rootDir, "rules.json");
	}

	// ============================================================
	// 初始化
	// ============================================================

	async init(): Promise<void> {
		// 创建目录结构
		await fs.mkdir(this.charactersDir, { recursive: true });
		await fs.mkdir(this.locationsDir, { recursive: true });

		// 初始化空数据文件
		await this.ensureFile(this.eventsFile, { events: [] });
		await this.ensureFile(this.relationsFile, { edges: [] });
		await this.ensureFile(this.rulesFile, { rules: [] });

		// 初始化 git repo
		await this.git("init");
		await this.git("config", "user.email", "narrative@engine.local");
		await this.git("config", "user.name", "Narrative Engine");

		// 初始 commit（如果没有任何 commit）
		const logResult = await this.git("log", "--oneline", "-1");
		if (logResult.code !== 0) {
			await this.git("add", "-A");
			await this.git("commit", "-m", "init: world graph");
		}
	}

	private async ensureFile(filePath: string, defaultContent: unknown): Promise<void> {
		try {
			await fs.access(filePath);
		} catch {
			await fs.writeFile(filePath, JSON.stringify(defaultContent, null, 2), "utf-8");
		}
	}

	// ============================================================
	// 角色节点：加载 / 保存
	// ============================================================

	async loadCharacter(name: string): Promise<CharacterNode> {
		// 命中缓存
		const cached = this.characterCache.get(name);
		if (cached) return cached;

		const filePath = path.join(this.charactersDir, `${name}.json`);
		const raw = await fs.readFile(filePath, "utf-8");
		const card = JSON.parse(raw) as CharacterNode["card"];

		// 解析扩展数据（兼容没有 narrative_engine 字段的卡）
		const ne = (card.data.extensions?.narrative_engine ?? defaultNarrativeExtensions()) as NarrativeExtensions;
		const node: CharacterNode = { card, ne };

		this.characterCache.set(name, node);
		return node;
	}

	async saveCharacter(node: CharacterNode): Promise<void> {
		const name = node.card.data.name;
		const filePath = path.join(this.charactersDir, `${name}.json`);

		// 把 ne 写回 extensions.narrative_engine
		node.card.data.extensions = {
			...node.card.data.extensions,
			narrative_engine: node.ne,
		};

		await fs.writeFile(filePath, JSON.stringify(node.card, null, 2), "utf-8");
		this.characterCache.set(name, node);
	}

	// 缓存读取（不读盘，必须已 load 过）
	getCharacterCached(name: string): CharacterNode | undefined {
		return this.characterCache.get(name);
	}

	// 列出所有角色名
	async listCharacters(): Promise<string[]> {
		const files = await fs.readdir(this.charactersDir);
		return files
			.filter((f) => f.endsWith(".json"))
			.map((f) => f.slice(0, -5));
	}

	// ============================================================
	// 普通节点（地点、规则）
	// ============================================================

	async loadLocation(name: string): Promise<WorldNode> {
		const filePath = path.join(this.locationsDir, `${name}.json`);
		const raw = await fs.readFile(filePath, "utf-8");
		return JSON.parse(raw) as WorldNode;
	}

	async saveLocation(node: WorldNode): Promise<void> {
		const filePath = path.join(this.locationsDir, `${node.id}.json`);
		await fs.writeFile(filePath, JSON.stringify(node, null, 2), "utf-8");
	}

	// ============================================================
	// 事件序列
	// ============================================================

	async loadEvents(): Promise<EventNode[]> {
		if (this.eventsCache) return this.eventsCache;
		const raw = await fs.readFile(this.eventsFile, "utf-8");
		const data = JSON.parse(raw) as EventsFile;
		this.eventsCache = data.events;
		return data.events;
	}

	async saveEvents(events: EventNode[]): Promise<void> {
		const data: EventsFile = { events };
		await fs.writeFile(this.eventsFile, JSON.stringify(data, null, 2), "utf-8");
		this.eventsCache = events;
	}

	async appendEvent(event: EventNode): Promise<void> {
		const events = await this.loadEvents();
		events.push(event);
		await this.saveEvents(events);
	}

	async getEvent(eventId: string): Promise<EventNode | undefined> {
		const events = await this.loadEvents();
		return events.find((e) => e.id === eventId);
	}

	// 截断事件序列：移除指定事件及之后的所有事件
	async truncateEventsFrom(eventId: string): Promise<EventNode[]> {
		const events = await this.loadEvents();
		const idx = events.findIndex((e) => e.id === eventId);
		if (idx === -1) return [];
		const removed = events.splice(idx);
		await this.saveEvents(events);
		return removed;
	}

	// 截断事件序列：移除指定事件之后的所有事件（保留目标事件本身）
	// 用于 insert 意图：在目标事件之后插入新事件，丢弃后续
	async truncateEventsAfter(eventId: string): Promise<EventNode[]> {
		const events = await this.loadEvents();
		const idx = events.findIndex((e) => e.id === eventId);
		if (idx === -1) return [];
		const removed = events.splice(idx + 1);
		await this.saveEvents(events);
		return removed;
	}

	// ============================================================
	// 关系边
	// ============================================================

	async loadRelations(): Promise<Edge[]> {
		if (this.relationsCache) return this.relationsCache;
		const raw = await fs.readFile(this.relationsFile, "utf-8");
		const data = JSON.parse(raw) as RelationsFile;
		this.relationsCache = data.edges;
		return data.edges;
	}

	async saveRelations(edges: Edge[]): Promise<void> {
		const data: RelationsFile = { edges };
		await fs.writeFile(this.relationsFile, JSON.stringify(data, null, 2), "utf-8");
		this.relationsCache = edges;
	}

	async findEdges(nodeId: string): Promise<Edge[]> {
		const edges = await this.loadRelations();
		return edges.filter((e) => e.source === nodeId || e.target === nodeId);
	}

	async upsertEdge(edge: Edge): Promise<void> {
		const edges = await this.loadRelations();
		const idx = edges.findIndex(
			(e) => e.source === edge.source && e.target === edge.target,
		);
		if (idx >= 0) {
			edges[idx] = edge;
		} else {
			edges.push(edge);
		}
		await this.saveRelations(edges);
	}

	// ============================================================
	// 规则节点
	// ============================================================

	async loadRules(): Promise<WorldNode[]> {
		if (this.rulesCache) return this.rulesCache;
		const raw = await fs.readFile(this.rulesFile, "utf-8");
		const data = JSON.parse(raw) as RulesFile;
		this.rulesCache = data.rules;
		return data.rules;
	}

	// ============================================================
	// 扩散写回
	// field 路径语义：
	//   state.emotion             → 覆盖
	//   state.location            → 覆盖
	//   state.relationships.<X>   → 增量（newValue 形如 "+0.3" / "-0.5"）
	//   state.knowledge           → 追加（newValue 作为新条目）
	//   content（地点）            → 追加版本，覆盖当前 content
	// ============================================================

	async writeBack(diffusions: Diffusion[]): Promise<void> {
		// 按 nodeId 分组，一次加载一次保存
		const byNode = new Map<string, Diffusion[]>();
		for (const d of diffusions) {
			const arr = byNode.get(d.nodeId) ?? [];
			arr.push(d);
			byNode.set(d.nodeId, arr);
		}

		for (const [nodeId, diffs] of byNode) {
			const isChar = await this.existsCharacter(nodeId);
			const isLoc = !isChar && (await this.existsLocation(nodeId));
			if (!isChar && !isLoc) {
				throw new Error(`Node not found: ${nodeId}`);
			}

			if (isChar) {
				const node = await this.loadCharacter(nodeId);
				const changes: string[] = [];
				for (const d of diffs) {
					const before = applyCharField(node, d.field, d.newValue);
					changes.push(`${d.field}: ${before} → ${d.newValue}`);
				}
				// 非破坏性记录到 memories
				node.ne.memories.push({
					eventId: diffs[0].eventId,
					timestamp: diffs[0].eventTime,
					summary: changes.join("; "),
					distance: "recent",
				});
				await this.saveCharacter(node);
			} else {
				// 地点：最后一个 content 生效
				const node = await this.loadLocation(nodeId);
				for (const d of diffs) {
					if (d.field === "content") {
						node.versions.push({
							content: d.newValue,
							timestamp: d.eventTime,
							eventId: d.eventId,
						});
						node.content = d.newValue;
					}
				}
				await this.saveLocation(node);
			}
		}
	}

	private async existsCharacter(name: string): Promise<boolean> {
		try {
			await fs.access(path.join(this.charactersDir, `${name}.json`));
			return true;
		} catch {
			return false;
		}
	}

	private async existsLocation(name: string): Promise<boolean> {
		try {
			await fs.access(path.join(this.locationsDir, `${name}.json`));
			return true;
		} catch {
			return false;
		}
	}

	// ============================================================
	// BFS 检索：沿边遍历收集相关条目
	// ============================================================

	async collectRelevant(event: EventNode): Promise<WorldEntry[]> {
		const visited = new Set<string>();
		const result: WorldEntry[] = [];
		const queue: string[] = [];

		// 种子节点：事件涉及的角色 + 地点
		queue.push(...event.characters, event.place);

		let depth = 0;
		while (queue.length > 0 && depth < MAX_BFS_DEPTH) {
			const levelSize = queue.length;
			for (let i = 0; i < levelSize; i++) {
				const id = queue.shift()!;
				if (visited.has(id)) continue;
				visited.add(id);

				// 尝试加载节点（角色 / 地点）
				const entry = await this.tryLoadEntry(id);
				if (entry) {
					result.push(entry);

					// 沿边扩展
					const edges = await this.findEdges(id);
					for (const e of edges) {
						const next = e.source === id ? e.target : e.source;
						if (!visited.has(next)) queue.push(next);
					}
				}
			}
			depth++;
		}

		// 追加相关规则
		const rules = await this.loadRules();
		for (const rule of rules) {
			result.push({ kind: "rule", node: rule });
		}

		return result;
	}

	// 尝试加载一个节点（先试角色，再试地点）
	private async tryLoadEntry(id: string): Promise<WorldEntry | null> {
		// 尝试角色
		try {
			const node = await this.loadCharacter(id);
			return { kind: "character", node };
		} catch {
			// 不是角色
		}

		// 尝试地点
		try {
			const node = await this.loadLocation(id);
			return { kind: "location", node };
		} catch {
			// 不是地点
		}

		return null;
	}

	// ============================================================
	// 信息差过滤：按角色视角过滤可见条目
	// ============================================================

	filterByKnowledge(roleName: string, entries: WorldEntry[]): WorldEntry[] {
		const char = this.getCharacterCached(roleName);
		return entries.filter((e) => {
			switch (e.kind) {
				case "location":
				case "rule":
					// 公共信息：所有人可见
					return true;
				case "character":
					// 角色节点：只返回自己
					return e.node.card.data.name === roleName;
				case "event":
					// 事件：只返回该角色参与过的
					return e.node.characters.includes(roleName);
				default:
					return false;
			}
		});
	}

	// ============================================================
	// git 版本管理
	// ============================================================

	async commit(event: EventNode): Promise<string> {
		await this.gitOrThrow("add", "-A");
		const msg = `event: ${event.what} @${event.place} ${event.time}`;
		await this.gitOrThrow("commit", "-m", msg);
		const result = await this.gitOrThrow("rev-parse", "HEAD");
		return result.stdout.trim();
	}

	async rollback(eventId: string): Promise<void> {
		const event = await this.getEvent(eventId);
		if (!event) throw new Error(`Event not found: ${eventId}`);
		if (!event.commitSha) throw new Error(`Event has no commit SHA: ${eventId}`);

		// 记录原 HEAD，失败时恢复
		const origHead = (await this.git("rev-parse", "HEAD")).stdout.trim();

		// 前置验证：目标 commit 和其父 commit 都必须存在
		await this.gitOrThrow("cat-file", "-e", `${event.commitSha}^{commit}`);
		await this.gitOrThrow("cat-file", "-e", `${event.commitSha}^^{commit}`);

		// reset 到该事件之前（父 commit）
		await this.gitOrThrow("reset", "--hard", `${event.commitSha}^`);

		// git reset 已把 events.json 回退到目标事件之前的状态（不含目标事件）。
		// truncate 作为安全网：若 commit/append 顺序曾导致不一致，显式截断目标及之后。
		try {
			await this.truncateEventsFrom(eventId);
		} catch (err) {
			// 截断失败，尝试恢复原 HEAD
			await this.git("reset", "--hard", origHead).catch(() => {});
			throw new Error(
				`rollback truncate failed, restored to original HEAD ${origHead.slice(0, 7)}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		this.clearCache();
	}

	// 回退到目标事件之后（保留目标事件，丢弃后续）
	// 用于 insert 意图：在目标事件之后插入新事件
	async rollbackToAfter(eventId: string): Promise<void> {
		const event = await this.getEvent(eventId);
		if (!event) throw new Error(`Event not found: ${eventId}`);
		if (!event.commitSha) throw new Error(`Event has no commit SHA: ${eventId}`);

		// 记录原 HEAD，失败时恢复
		const origHead = (await this.git("rev-parse", "HEAD")).stdout.trim();

		// 前置验证：目标 commit 必须存在
		await this.gitOrThrow("cat-file", "-e", `${event.commitSha}^{commit}`);

		// reset 到该事件本身的 commit（保留目标事件），丢弃后续 commit
		await this.gitOrThrow("reset", "--hard", event.commitSha);

		// 从 events.json 移除目标事件之后的事件（保留目标事件）
		try {
			await this.truncateEventsAfter(eventId);
		} catch (err) {
			await this.git("reset", "--hard", origHead).catch(() => {});
			throw new Error(
				`rollbackToAfter truncate failed, restored to original HEAD ${origHead.slice(0, 7)}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		this.clearCache();
	}

	// 清除所有内存缓存，下次读取从磁盘加载
	// public：让 index.ts 在 session_start / 规则变更 / 角色卡修改后调用
	clearCache(): void {
		this.characterCache.clear();
		this.eventsCache = null;
		this.relationsCache = null;
		this.rulesCache = null;
	}

	async diff(fromSha: string, toSha: string): Promise<string> {
		const result = await this.git("diff", fromSha, toSha);
		return result.stdout;
	}

	async log(): Promise<string> {
		const result = await this.git("log", "--oneline", "-20");
		return result.stdout;
	}

	// ============================================================
	// git 命令封装
	// ============================================================

	private async git(...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
		const result = await this.pi.exec("git", args, { cwd: this.rootDir });
		return { stdout: result.stdout, stderr: result.stderr, code: result.code };
	}

	// 严格模式：非 0 退出码抛错，避免静默失败导致状态不一致
	private async gitOrThrow(...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
		const result = await this.git(...args);
		if (result.code !== 0) {
			throw new Error(
				`git ${args.join(" ")} failed (code ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
			);
		}
		return result;
	}
}

// 对角色节点按 field 路径应用更新，返回更新前的值（用于审计）
// 支持：
//   state.emotion              → 覆盖字符串
//   state.location             → 覆盖字符串
//   state.relationships.<X>    → 增量（newValue 形如 "+0.3" / "-0.5"）
//   state.knowledge            → 追加条目
function applyCharField(node: CharacterNode, field: string, newValue: string): string {
	const state = node.ne.state;

	if (field === "state.emotion") {
		const before = state.emotion;
		state.emotion = newValue;
		return before;
	}
	if (field === "state.location") {
		const before = state.location;
		state.location = newValue;
		return before;
	}
	if (field === "state.knowledge") {
		state.knowledge.push(newValue);
		return "(追加)";
	}
	if (field.startsWith("state.relationships.")) {
		const target = field.slice("state.relationships.".length);
		const before = state.relationships[target] ?? 0;
		const delta = parseDelta(newValue);
		state.relationships[target] = before + delta;
		return String(before);
	}

	// 未知字段：忽略但记录
	return "(未知字段)";
}

function parseDelta(s: string): number {
	const trimmed = s.trim();
	if (!trimmed) return 0;
	const n = Number(trimmed);
	return Number.isFinite(n) ? n : 0;
}
