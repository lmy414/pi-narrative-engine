/**
 * @pi/role-pool 子包类型定义
 *
 * 角色池无状态：所有状态由调用方持有（LLM 实例、规则集、演员表）。
 * 类型不跨包导入——SillyTavernCard 和 FactSnapshot 在本包内重新声明为 interface。
 */

/**
 * SillyTavern V2 角色卡（结构子集）
 * 子包内重新声明为 interface，不依赖外部包
 * 原样注入 prompt（JSON 字符串）
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
 * 调度器通过 wg.getCharacterView(characterId, storyTime) 预取
 */
export interface FactSnapshot {
  declarationId: string;
  entityId: string;
  property: string;
  value: unknown;
  valueText?: string;
  modality: "fact" | "belief" | "hypothesis";
  validFrom: string;
  /** 失效时刻（"Infinity" = 未闭合）；已闭合的为历史知识，渲染时标注（旧） */
  validTo?: string;
  /** 属主名称（调度器解析 entityId 后填入）；渲染为 `- [属主] property: value（modality）` */
  ownerName?: string;
  /** 检索项语义标签（planner 提供）；渲染为分组小标题，说明信息来源/用途 */
  label?: string;
}

/**
 * 单个演员的输入
 */
export interface CastMember {
  characterId: string;
  /** 静态层：酒馆角色卡 JSON */
  staticCard: SillyTavernCard;
  /** 动态层：角色当前可见的状态声明 */
  dynamicFacts: FactSnapshot[];
}

/**
 * 角色池调用命令
 */
export interface InteractCommand {
  /** 事件指令（自然语言，调度器从用户输入解析） */
  eventInstruction: string;
  /** 故事时间（如 ch-2） */
  storyTime: string;
  /** 演员表，按出场顺序排列 */
  cast: CastMember[];
  /**
   * 执行建议（用户特殊要求，可选）
   *
   * 由调度器从主会话传入，透传到角色池 system prompt（让角色也遵守用户特殊要求）
   * 例如："林冲要显得绝望"、"避免直接描写暴力"、"这场戏节奏要快"
   *
   * 注入位置：buildSystemPrompt 末尾"用户特殊要求"段落（详见 prompts.ts）
   * 设计依据：docs/plans/2026-07-25-scheduler-design.md §2.1
   */
  executionHints?: string;
}

/**
 * 角色代理完整输出（8 字段 + characterId）
 * 去掉 foreshadowings，待伏笔存储设计时加回
 *
 * characterId 字段说明（2026-07-25 解决 Pending Gap #2）：
 * - LLM 必须在输出中填入自己的 entityId（由 prompt 提供的"你的 entityId"）
 * - relation_update.target 也必须填对方 characterId（不是名字）
 * - 这样调度器 commit 时可直接调 wg.addRelation(sourceId, targetId, label, storyTime)
 *   无需做名字 → entityId 的"消解"
 */
export interface RoleAgentOutput {
  /** 行动者名字（人类可读，渲染器用） */
  actor: string;
  /** 行动者 entityId（world-graph 的稳定唯一标识，调度器用） */
  characterId: string;
  action: string;
  target?: string;
  emotion?: string;
  /** target 字段填对方 characterId（不是名字） */
  relation_update?: { target: string; label: string }[];
  thought?: string;
  knowledge_gained?: string[];
  state_changes?: StateChange[];
}

/**
 * 状态变更提议
 * 调度器将其转换为 newFacts，通过 world_event_apply 写入世界图
 */
export interface StateChange {
  entityId: string;
  property: string;
  value: unknown;
  modality: "fact" | "belief" | "hypothesis";
}

/**
 * 先动者行动摘要（传给后动者，信息隔离）
 * 只含公开信息，不含 thought/emotion/state_changes/knowledge_gained
 */
export interface PriorAction {
  actor: string;
  action: string;
  target?: string;
}

/**
 * 角色池返回结果
 */
export interface InteractResult {
  outputs: RoleAgentOutput[];
  errors: { characterId: string; error: string }[];
}

/**
 * LLM 调用器（注入式，便于单测 mock）
 * tool call 模式：返回已解析的 RoleAgentOutput
 */
export type RoleLlmCaller = (
  systemPrompt: string,
  userMessage: string,
) => Promise<RoleAgentOutput>;

/**
 * 角色池调用上下文
 */
export interface RoleCtx {
  llm: RoleLlmCaller;
  /** 角色规则集.md 全文 */
  ruleSet: string;
}
