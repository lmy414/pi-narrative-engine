/**
 * @pi/scheduler 子包类型定义
 *
 * 调度器无状态：所有状态由调用方持有（LLM 实例、规则集、世界图实例）。
 * 类型不跨包导入——SillyTavernCard / FactSnapshot 在本包内重新声明为 interface
 * （与 role-pool / renderer 子包约定一致，避免循环依赖）。
 *
 * 设计依据：docs/plans/2026-07-25-scheduler-design.md §2 数据契约
 */

import type { WorldGraph, EntitySnapshot, StateDeclaration } from "@pi/world-graph";
import type {
  CastMember,
  InteractResult,
  RoleAgentOutput,
  RoleLlmCaller,
  StateChange,
} from "@pi/role-pool";
import type { RenderLlmCaller, RoleOutput } from "@pi/renderer";
import type { DebugBus } from "./debug.ts";

/**
 * SillyTavern V2 角色卡（结构子集）
 * 子包内重新声明为 interface，不依赖外部包（与 role-pool 子包约定一致）
 */
export interface SillyTavernCard {
  name: string;
  description: string;
  personality?: string;
  scenario?: string;
  first_mes?: string;
  mes_example?: string;
  creator_notes?: string;
  tags?: string[];
  [key: string]: unknown;
}

/**
 * 状态声明快照（Fact 节点的结构子集）
 * 与 role-pool 的 FactSnapshot 结构一致，用于调度器检索结果统一格式
 */
export interface FactSnapshot {
  declarationId: string;
  entityId: string;
  property: string;
  value: unknown;
  valueText?: string;
  modality: "fact" | "belief" | "hypothesis";
  validFrom: string;
  /**
   * 失效时刻（"Infinity" = 未闭合）
   * 2026-07-25 新增（审计 P2）：role-pool 渲染时区分"当前状态"与"历史知识"
   */
  validTo?: string;
  /**
   * 属主名称（如 "彩叶"）
   * 2026-07-25 新增（审计 P1）：由调度器在组装 dynamicFacts 时解析 entityId 填入，
   * role-pool 渲染为 `- [属主] property: value（modality）`，解决动态层无归属问题
   */
  ownerName?: string;
  /**
   * 检索项语义标签（planner RetrievalItem.label）
   * 2026-07-25 新增（审计偏差 2）：role-pool 渲染为分组小标题，说明信息来源
   */
  label?: string;
}

// ---------------------------------------------------------------------------
// §2.1 输入类型
// ---------------------------------------------------------------------------

/**
 * 主会话解析后的结构化事件
 * 调度器接收的唯一输入形式
 *
 * 五要素映射（V2 设计笔记 9.1 节）：
 * - 时间 → storyTime
 * - 地点 → locationId（可选）
 * - 发生了什么 → instruction
 * - 事件意图 → intent
 * - 角色弧状态 → characterIds（角色由主会话识别）
 *
 * 主会话作为"任务外包方"，已做意图理解和角色识别，把结构化参数
 * 传入调度器 pi 工具。executionHints 承载用户的特殊要求（如"林冲
 * 在这场戏里要显得特别绝望"、"避免出现打斗描写"），调度器在组装
 * 角色提示词时透传给 role-pool。
 */
export interface StructuredEvent {
  /** 故事时间（如 ch009.ev006，3 位零填充保证字典序 == 故事时序） */
  storyTime: string;
  /** 事件指令（自然语言，主会话已加工） */
  instruction: string;
  /** 参与角色 ID 列表（主会话已识别） */
  characterIds: string[];
  /**
   * 执行建议（用户特殊要求）
   * 由主会话从用户对话中抽取，调度器透传到角色池 prompt 和渲染器 prompt
   * 例如："林冲要显得绝望"、"避免直接描写暴力"、"这场戏节奏要快"
   */
  executionHints?: string;
  /**
   * 调度模式：plan / yolo
   * - plan：跑到角色池输出即返回（等主会话调 scheduler_commit 提交扩散和渲染）
   * - yolo：自动跑完整条链（检索→角色→扩散→渲染）
   * 缺省 plan（符合人在回路）
   */
  mode?: "plan" | "yolo";
  /** 章节文件路径（缺省时调度器从 storyTime 推断） */
  chapterPath?: string;
  // M4a 修复（2026-07-30）：删除 locationId 死字段
  // 原字段声明"用于可见性推断"但 plan/commit 全文未消费，属过度工程/死字段。
  // 如未来需要可见性推断接线，再重新添加该字段。
  /** 事件意图（缺省 add；modify/insert 留作 Pending Gap #4） */
  intent?: "add" | "modify" | "insert";
  /** modify/insert 模式下的目标事件 ID */
  targetEventId?: string;
  /**
   * 用户口述原文（2026-07-25 新增，跨会话项目记忆）
   * 主会话把用户原话透传过来；commit 写扩散时落到每个 change 事件的
   * EventRecord.userInput，供项目记忆文件（memory.md）展示最近事件。
   */
  userInput?: string;
}

// ---------------------------------------------------------------------------
// §2.5 检索计划类型（planner LLM 输出）
// ---------------------------------------------------------------------------

/**
 * planner LLM 的输出：检索计划
 *
 * 由调度器在 plan 阶段调用 plannerLlm 推导得出
 * 调度器按 plan.items 逐项执行检索，结果按 item.assignTo 注入对应角色
 *
 * 信息差由 planner LLM 决定（Genette 内聚焦的工程化）：
 * - planner LLM 既决定"检索什么"，也决定"哪个角色应该看到这条检索结果"
 * - 调度器不主动做信息差推断（不再调用 characterView 的固定 5 步过滤）
 * - 兜底逻辑：每个 characterId 至少有 1 条 type="character_view" 的 item（调度器自动补全，见 plan.ts）
 */
export interface RetrievalPlan {
  /** 一组检索项 */
  items: RetrievalItem[];
}

/**
 * 单条检索项
 * 调度器按 type 执行对应的世界图 API，把结果按 assignTo 分配给角色
 */
export interface RetrievalItem {
  /**
   * 检索类型（对应 world-graph 已实现的 API）：
   * - character_view：某角色可见的所有状态声明（wg.getCharacterView）
   * - entity_snapshot：某实体的完整快照（wg.getEntityAt）
   * - relations：某实体的关系列表（wg.getRelations）
   * - search_text：全文检索（wg.search.fulltext）
   * - search_vector：向量检索（wg.search.vector）
   * - search_hybrid：混合检索（wg.search.hybrid）
   */
  type:
    | "character_view"
    | "entity_snapshot"
    | "relations"
    | "search_text"
    | "search_vector"
    | "search_hybrid";

  /** 检索参数（按 type 不同填不同字段） */
  params: {
    /** character_view / entity_snapshot / relations 用 */
    entityId?: string;
    /** search_text / search_vector / search_hybrid 用（自然语言查询） */
    query?: string;
    /**
     * 检索节点类型（search_text / search_vector / search_hybrid 必填）
     * 对应 wg.search.fulltext(nodeKind, ...) 第一个参数
     * 取值："Entity" / "Fact" / "Relation" / "Visibility"
     * - Entity：检索实体（角色/地点/物品/概念）的 summary + properties
     * - Fact：检索状态声明（property / valueText 字段已声明 searchable）
     * - Relation：检索关系（label 字段）
     */
    nodeType?: "Entity" | "Fact" | "Relation" | "Visibility";
    /** 检索上限（search_* 用） */
    limit?: number;
    /**
     * 向量字段路径（search_vector / search_hybrid 用）
     * 缺省 "embedding"（world-graph 的 Entity/Fact 节点默认嵌入字段）
     */
    fieldPath?: string;
    /** 模态过滤（character_view 用，如只看 fact） */
    modalityFilter?: ("fact" | "belief" | "hypothesis")[];
    /**
     * 事务时间坐标（P0-2 修复，2026-07-27）
     *
     * 由 wg.recordedNow() 获取，modify/insert 锚定历史事件时使用。
     * 语义：「storyTime 时刻的世界状态，但只含 recordedAsOf 之前写入的内容」
     * 实现双时态检索的 retcon 隔离。
     *
     * - character_view / entity_snapshot / relations：透传给 wg 查询 API
     * - search_text / search_vector / search_hybrid：当前 wg.search 不支持，
     *   retrieve.ts 会 console.warn 并降级为不过滤（与 P0-1 的未来事实过滤合并实现）
     */
    recordedAsOf?: string;
  };

  /**
   * 这条检索结果分配给哪些角色
   * 调度器按此把检索结果拼装到对应角色的 dynamicFacts / 上下文
   * 信息差的核心：planner LLM 决定谁看到什么
   */
  assignTo: string[];

  /**
   * 检索项的语义标签（注入角色提示词时用作小标题）
   * 例如："林冲的当前状态"、"林冲与陆谦的关系"、"酒馆里发生了什么"
   */
  label: string;
}

/**
 * planner LLM 调用器签名
 * 输入：planner 系统提示词 + 用户消息（事件指令 + 角色清单）
 * 输出：已解析的 RetrievalPlan（tool call 模式）
 *
 * 与 RoleLlmCaller / RenderLlmCaller 一致，便于注入 mock 单测
 */
export type PlannerLlmCaller = (
  systemPrompt: string,
  userMessage: string,
) => Promise<RetrievalPlan>;

/**
 * knowledge_gained → declarationId 映射 LLM 调用器（P0-3+6 修复，2026-07-27）
 *
 * 角色在一场戏中产出的 knowledge_gained（自然语言字符串数组）需要映射到
 * world-graph 中已存在的 declarationId，才能写入 Visibility（他盲修复）。
 * 由 LLM 完成语义匹配。
 *
 * 输入：
 * - characterId：产出 knowledge_gained 的角色 ID
 * - knowledgeItems：knowledge_gained 字符串数组
 * - candidates：候选 declarationId 列表（由 wg.getAllDeclarationsAt(storyTime) 取，
 *   限制在 storyTime 时刻所有有效声明范围内，避免映射到未来事实）
 *
 * 输出：每个 knowledge_gained 项映射到的 declarationId（或 null 表示无匹配）+ 置信度。
 *
 * 单测可注入 mock mapper 返回预设映射。
 */
export type KnowledgeMapperLlmCaller = (
  characterId: string,
  knowledgeItems: string[],
  candidates: Array<{
    declarationId: string;
    entityId: string;
    property: string;
    value: unknown;
  }>,
) => Promise<Array<{
  knowledge: string;
  declarationId: string | null;  // null 表示未找到匹配
  confidence: number;  // 0-1，< 0.5 不写 Visibility
}>>;

// ---------------------------------------------------------------------------
// §2.2 中间状态类型
// ---------------------------------------------------------------------------

/**
 * scheduler_plan 产出的中间状态
 * 缓存在 session 级 Map 中，等 scheduler_commit 或 scheduler_discard 取用
 */
export interface PlanResult {
  /** plan 唯一 ID（自动生成） */
  planId: string;
  /** 调度器自动生成的事件 ID（用于渲染锚点和事件链） */
  eventId: string;
  /** 原始输入事件 */
  event: StructuredEvent;
  /** 章节路径（解析后的最终值） */
  chapterPath: string;
  /** planner LLM 推导出的检索计划（缓存便于 commit 时无需重新推导，也便于调试） */
  retrievalPlan: RetrievalPlan;
  /** 角色池调用结果（含 outputs 和 errors） */
  roleResult: InteractResult;
  /** 调度器预取的演员表快照（便于 commit 时无需重新检索） */
  cast: CastMember[];
  /** 创建时间戳（用于过期清理） */
  createdAt: number;
}

// ---------------------------------------------------------------------------
// §2.3 输出类型
// ---------------------------------------------------------------------------

/**
 * scheduler_plan（plan 模式）返回
 */
export interface PlanOutput {
  planId: string;
  eventId: string;
  chapterPath: string;
  /** 角色池输出（主会话可检查后再决定 commit/discard） */
  outputs: RoleAgentOutput[];
  /** 失败记录（来自 role_interact） */
  errors: { characterId: string; error: string }[];
  /** 预取的演员表摘要（便于主会话参考） */
  cast: { characterId: string; name: string; summary: string }[];
}

/**
 * scheduler_commit 返回
 */
export interface CommitResult {
  ok: boolean;
  planId: string;
  /** 渲染锚点 eventId（plan 阶段生成） */
  eventId: string;
  /** 已应用的世界图事件 ID 列表（每个 entityId 一个 change 事件） */
  appliedEventIds: string[];
  /** 已渲染的章节路径 */
  chapterPath: string;
  /** 已写入的渲染文本 */
  writtenText: string;
  /** 渲染错误（ok=false 时） */
  error?: string;
  /**
   * P0-4 修复（2026-07-27）：写扩散失败的 entityId 列表（部分成功时填）
   *
   * 单个 entityId 失败不阻断其他 entityId；调用方据 failedEntityIds 决定
   * 是否人工介入或重新派发新事件。ok=false 时可能含部分成功（appliedEventIds 非空）。
   */
  failedEntityIds?: string[];
  /**
   * P0-4 修复（2026-07-27）：写入失败的关系列表（部分成功时填）
   *
   * relation_update 步骤失败不阻断主链路；调用方据 failedRelations 决定是否补偿。
   */
  failedRelations?: Array<{ source: string; target: string; label: string }>;
}

// ---------------------------------------------------------------------------
// §2.4 调度器调用上下文
// ---------------------------------------------------------------------------

/**
 * 调度器调用上下文
 *
 * 调度器持有三种 LLM 调用器：
 * - plannerLlm：用于推导检索计划（调度器内嵌）
 * - roleLlm：透传给 role_interact（角色扮演）
 * - renderLlm：透传给 renderToFile（文本渲染）
 *
 * 三种 LLM 调用器互不干扰，便于单测 mock 和生产环境分别配置
 * （如 plannerLlm 可用更快的小模型，roleLlm/renderLlm 用更大模型）
 */
export interface SchedulerCtx {
  /** 世界图实例 */
  wg: WorldGraph;
  /** planner LLM 调用器（推导检索计划） */
  plannerLlm: PlannerLlmCaller;
  /** 角色池 LLM 调用器（注入 role_interact） */
  roleLlm: RoleLlmCaller;
  /** 渲染器 LLM 调用器（注入 renderToFile） */
  renderLlm: RenderLlmCaller;
  /**
   * 向量化器（P0-5 修复后支持实体/声明级嵌入，2026-07-27）
   *
   * - embed(text)：通用文本向量化（retrieve.ts search_vector / search_hybrid 用）
   * - embedEntity(snap)：实体向量化（commit.ts 4.2.5 步用，写扩散后增量更新 Entity.embedding）
   * - embedFact(decl)：状态声明向量化（commit.ts 4.2.5 步用，写扩散后增量更新 Fact.embedding）
   *
   * 默认实现：Embedder（src/embedder.ts）已实现全部三个方法
   * 单测可注入 mock embedder 返回预设向量
   */
  embedder: {
    embed(text: string): Promise<number[]>;
    embedEntity(snap: EntitySnapshot): Promise<number[]>;
    embedFact(decl: StateDeclaration): Promise<number[]>;
  };
  /**
   * knowledge_gained → declarationId 映射 LLM 调用器（P0-3+6 修复，2026-07-27）
   *
   * 可选注入。未注入时 commit 跳过 4.4 步（保持向后兼容）。
   * 生产环境应注入，单测可不注入或注入 mock。
   *
   * commit.ts 4.4 步用它把 role-pool 输出的 knowledge_gained 自然语言映射到
   * 已存在的 declarationId，再调 wg.setVisibility 写"他盲"可见性
   * （source="informed"，confidence 由 mapper 决定）。
   */
  knowledgeMapper?: KnowledgeMapperLlmCaller;
  /** 角色规则集.md 全文（注入 role_interact） */
  roleRuleSet: string;
  /** 渲染规则集.md 全文（注入 renderToFile） */
  renderRuleSet: string;
  /** planner 规则集.md 全文（约束 planner LLM 的检索行为） */
  plannerRuleSet: string;
  /** 工作目录（用于章节路径推断和规则集加载） */
  cwd: string;
  /** staticCard 加载器（可注入，便于测试和后续替换存储策略） */
  staticCardLoader: (
    characterId: string,
    storyTime: string,
  ) => Promise<SillyTavernCard>;
  /**
   * 调试事件总线（可选注入，2026-07-27 新增）
   *
   * 注入后调度链关键点会发射 DebugEvent：
   * - dispatch.start/end
   * - plan.llm.start/end
   * - retrieve.item.start/end（每项检索）
   * - role.interact.start/end
   * - commit.start/end
   * - commit.step.{4,4.4,5,5.5,6,7}.start/end
   * - render.llm.start/end
   *
   * 未注入时为 noop（零开销）。
   * traceId 由 plan() / commit() 入口生成，贯穿同一次 dispatch 的所有事件。
   */
  debugBus?: DebugBus;
}

// ---------------------------------------------------------------------------
// §5.1 扩展层 pi 工具返回类型
// ---------------------------------------------------------------------------

/**
 * scheduler_dispatch（plan 模式）返回
 */
export interface DispatchPlanOutput {
  mode: "plan";
  planId: string;
  eventId: string;
  chapterPath: string;
  /** 角色池输出（主会话可审阅） */
  outputs: RoleAgentOutput[];
  errors: { characterId: string; error: string }[];
  cast: { characterId: string; name: string; summary: string }[];
  /** 透明展示 planner LLM 推导的检索计划，便于调试 */
  retrievalPlan: RetrievalPlan;
}

/**
 * scheduler_dispatch（yolo 模式）返回（含 commit 结果）
 *
 * 注意：不能用 extends DispatchPlanOutput，因为 mode 字面量类型 "yolo" 与
 * DispatchPlanOutput.mode 的 "plan" 不兼容。改用 Omit 排除 mode 后再 extends。
 */
export interface DispatchYoloOutput
  extends Omit<DispatchPlanOutput, "mode"> {
  mode: "yolo";
  /** 含 appliedEventIds / writtenText */
  commitResult: CommitResult;
}

// ---------------------------------------------------------------------------
// 依赖类型说明（不在此重新导出，调度器内部其他文件按需从原包导入）
// ---------------------------------------------------------------------------
//
// @pi/world-graph 提供：WorldGraph
// @pi/role-pool 提供：CastMember / InteractResult / RoleAgentOutput / RoleLlmCaller / StateChange
// @pi/renderer 提供：RenderLlmCaller / RoleOutput
