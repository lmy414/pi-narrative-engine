// 叙事引擎类型定义
// 包含：V2 角色卡、世界图节点、事件、扩散、子代理 I/O

// ============================================================
// V2 角色卡规范（参考 https://github.com/malfoyslastname/character-card-spec-v2）
// ============================================================

export type CharacterBook = {
	name?: string;
	description?: string;
	scan_depth?: number;
	token_budget?: number;
	recursive_scanning?: boolean;
	extensions: Record<string, unknown>;
	entries: CharacterBookEntry[];
};

export type CharacterBookEntry = {
	keys: string[];
	content: string;
	extensions: Record<string, unknown>;
	enabled: boolean;
	insertion_order: number;
	case_sensitive?: boolean;
	name?: string;
	priority?: number;
	id?: number;
	comment?: string;
	selective?: boolean;
	secondary_keys?: string[];
	constant?: boolean;
	position?: "before_char" | "after_char";
};

export type TavernCardV2 = {
	spec: "chara_card_v2";
	spec_version: "2.0";
	data: {
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
		character_book?: CharacterBook;
		tags: string[];
		creator: string;
		character_version: string;
		extensions: Record<string, unknown>;
	};
};

// ============================================================
// 叙事引擎扩展数据（存在角色卡 extensions.narrative_engine）
// ============================================================

export type CharacterState = {
	emotion: string;
	location: string;
	relationships: Record<string, number>;
	knowledge: string[];
};

export type MemoryDistance = "recent" | "mid" | "far";

export type MemoryEntry = {
	eventId: string;
	timestamp: string;
	summary: string;
	distance: MemoryDistance;
};

export type NarrativeExtensions = {
	state: CharacterState;
	memories: MemoryEntry[];
};

// ============================================================
// 角色节点（character + 扩展数据）
// ============================================================

export type CharacterNode = {
	card: TavernCardV2;
	ne: NarrativeExtensions;
};

// ============================================================
// 普通世界节点（地点、规则）
// ============================================================

export type WorldNodeType = "location" | "rule";

export type VersionEntry = {
	content: string;
	timestamp: string;
	eventId: string;
};

export type WorldNode = {
	id: string;
	type: WorldNodeType;
	content: string;
	versions: VersionEntry[];
};

// ============================================================
// 事件节点
// ============================================================

export type DiffusionRecord = {
	nodeId: string;
	field: string;
	oldValue: string;
	newValue: string;
};

export type EventNode = {
	id: string;
	time: string;
	place: string;
	what: string;
	characters: string[];
	purpose: string;
	commitSha: string;
	diffusions: DiffusionRecord[];
};

export type EventsFile = {
	events: EventNode[];
};

// ============================================================
// 边（关系）
// ============================================================

export type EdgeVersion = {
	relation: string;
	strength: number;
	timestamp: string;
	eventId: string;
};

export type Edge = {
	source: string;
	target: string;
	relation: string;
	strength: number;
	versions: EdgeVersion[];
};

export type RelationsFile = {
	edges: Edge[];
};

export type RulesFile = {
	rules: WorldNode[];
};

// ============================================================
// 语义理解层输出
// ============================================================

export type IntentType = "add" | "modify" | "insert" | "delete" | "query";

export type EventInput = {
	id?: string;
	time: string;
	place: string;
	what: string;
	characters: string[];
	purpose: string;
};

export type Intent = {
	intent: IntentType;
	event: EventInput;
};

// ============================================================
// 角色子代理结构化输出
// ============================================================

export type StructuredOutput = {
	actor: string;
	action: string;
	target: string;
	emotion: string;
	relation_update: {
		target: string;
		delta: number;
	};
	thought: string;
};

// ============================================================
// 扩散（写回操作）
// ============================================================

export type Diffusion = {
	nodeId: string;
	field: string;
	oldValue: string;
	newValue: string;
	eventId: string;
	eventTime: string;
};

// ============================================================
// 渲染器输入
// ============================================================

export type RenderMode = "append" | "rewrite";

export type RenderInput = {
	event: EventNode;
	structuredOutputs: StructuredOutput[];
	mode: RenderMode;
};

// ============================================================
// 统一的世界条目（BFS 检索结果）
// ============================================================

export type WorldEntry =
	| { kind: "character"; node: CharacterNode }
	| { kind: "location"; node: WorldNode }
	| { kind: "rule"; node: WorldNode }
	| { kind: "event"; node: EventNode };
