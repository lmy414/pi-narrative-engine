/**
 * @pi/novel-importer 子包内部类型
 *
 * 本文件定义导入器编排用的中间数据结构（不传给 world-graph 内核 API）。
 * 严格对齐 spec.md "核心数据模型"小节（spec L110-191）。
 *
 * 三层分离：LLM 输出语义层（带 _hint 后缀）→ 导入器内部数据 → 内核 API 字段。
 */

import type {
  EntityType,
  Modality,
  EventType,
} from "@pi/world-graph";
import type { Tool } from "@mariozechner/pi-ai";

/**
 * EntityHint — 阶段 2 LLM 输出的实体提示（待阶段 4 消解为 canonical entityId）
 * 对应 spec L384-389
 */
export interface EntityHint {
  name: string;
  type: EntityType;
  aliases: string[];
  first_seen_chapter: number;
  brief: string;
}

/**
 * NewFactHint — LLM 输出的新声明（带 target_hint，待阶段 7 解析）
 * 对应 spec L162-167
 *
 * 注意：
 * - birth 事件的 newFacts 会被内核丢弃 target_hint 和 modality（硬编码 fact，
 *   所有声明归属 event.entityId）
 * - change 事件保留 target_hint 和 modality，支持跨实体声明
 */
export interface NewFactHint {
  property: string;
  value: unknown;
  modality: Modality;
  /** 跨实体声明时目标实体规范名（缺省 = entity_hint；birth 事件会被内核丢弃） */
  target_hint?: string;
}

/**
 * InvalidatedHint — LLM 输出的被替换的旧声明（只写 property，待阶段 7 查询 declarationId）
 * 对应 spec L158-161
 */
export interface InvalidatedHint {
  property: string;
}

/**
 * EventHint — 阶段 3 LLM 输出的事件（含 entity_hint 待消解）
 * 对应 spec L150-169
 *
 * narrative_summary 是调试字段，写入 _v3_dump.json，不映射到内核 EventRecord。
 */
export interface EventHint {
  storyTime: string;
  type: EventType;
  entity_hint: string;
  entity_type?: EntityType; // birth 事件必填
  summary?: string; // birth 事件用：实体摘要
  new_facts?: NewFactHint[];
  invalidated?: InvalidatedHint[];
  /** 调试用：事件叙事摘要（≤300字，人类可读），写入 _v3_dump.json */
  narrative_summary?: string;
  /** 阶段 7 写入时填入因果链前驱 eventId */
  causedBy?: string;
}

/**
 * ChapterResult — 阶段 3 单章节输出
 */
export interface ChapterResult {
  chapterId: number;
  title: string;
  events: EventHint[];
}

/**
 * AliasEntry — alias-index.json 单条记录
 * 对应 spec L100
 */
export interface AliasEntry {
  name: string;
  aliases: string[];
  canonical_entityId: string;
}

/**
 * ResolveResult — 阶段 4 实体消解输出
 */
export interface ResolveResult {
  /** entity_hint → canonical entityId */
  canonicalMap: Map<string, string>;
  aliasIndex: AliasEntry[];
}

/**
 * RelationHint — 阶段 5 LLM 输出的关系（带 source_hint/target_hint）
 * 对应 spec L752-755
 *
 * evidence 是调试字段，写入 _v3_dump.json，不映射到内核 RelationNode。
 */
export interface RelationHint {
  source_hint: string;
  target_hint: string;
  label: string;
  storyTime: string;
  action: "open" | "close";
  /** 调试用：原文依据（≤200字），写入 _v3_dump.json */
  evidence?: string;
}

/**
 * VisibilityHint — 阶段 6 LLM 输出的可见性（带 characterId_hint/target_hint）
 * 对应 spec L175-190
 *
 * 导入器解析后传入 setVisibility(characterId, declarationId, opts)，
 * opts.state 必填，固定传 "known"。
 */
export interface VisibilityHint {
  characterId_hint: string;
  target_hint: string;
  property: string;
  confidence: number;
  source: string;
  storyTime: string; // = setVisibility options.validFrom
  isExplicit: boolean;
}

/**
 * TextEmbedder — 文本向量化注入接口
 *
 * narrative-engine 扩展已实例化 Embedder（Xenova/bge-small-zh-v1.5），
 * 注入到导入器供 reembedAll 使用。
 * 复用 narrative-engine/src/embedder.ts，避免重复加载模型。
 */
export interface TextEmbedder {
  /** 把文本向量化（512 维归一化向量） */
  embed(text: string): Promise<number[]>;
}

/**
 * EmbedderLike — reembedAll 需要的接口（spec L1010-1015）
 *
 * WorldGraph.reembedAll({ embedEntity, embedFact }) 接受此接口。
 * 由 makeEmbedder(textEmbedder) 适配 TextEmbedder 生成。
 */
export interface EmbedderLike {
  embedEntity(snap: import("@pi/world-graph").EntitySnapshot): Promise<number[]>;
  embedFact(decl: import("@pi/world-graph").StateDeclaration): Promise<number[]>;
}

/**
 * ImportPipelineOptions — runImportPipeline 入参
 * 对应 spec L65-72
 */
export interface ImportPipelineOptions {
  epubPath: string;
  /** world-graph 存储目录（缺省 <cwd>/.pi/world-graph-v3/） */
  worldGraphDir?: string;
  /** 限定导入章节（1-based），缺省全部 */
  chapters?: number[];
  /** LLM 模型名（缺省用 pi 配置） */
  model?: string;
  apiKey?: string;
  /** 章节并行限流（缺省 3） */
  concurrency?: number;
  /** 从指定阶段恢复（1-8，缺省从1开始） */
  resumeFromStage?: number;
  /** 注入 cwd 用于默认 worldGraphDir */
  cwd?: string;
  /**
   * 文本向量化注入（spec L1016 "复用 narrative-engine/src/embedder.ts"）
   *
   * 缺省时：跳过 reembedAll，仅做 P0/P1 校验，P1 警告"embedder 未注入"
   * 生产环境：narrative-engine 注册 import_novel 工具时注入已实例化的 Embedder
   */
  embedder?: TextEmbedder;
}

/**
 * ImportPipelineResult — runImportPipeline 出参
 */
export interface ImportPipelineResult {
  entityCount: number;
  eventCount: number;
  relationCount: number;
  visibilityCount: number;
  worldGraphDir: string;
  dumpPath: string;
}

// ============================================================================
// LLM 调用注入（便于测试 mock）
// ============================================================================

/**
 * LlmToolCaller — 注入式 LLM 调用器
 *
 * 输入：prompt 文本 + 可用工具 + system prompt
 * 输出：LLM 调用的工具参数（已通过 schema 校验）
 * 异常：LLM 调用失败或未调用工具时抛错
 *
 * 这样设计便于单测时注入 mock，生产环境用 pi-ai 的 complete + validateToolCall 实现。
 */
export type LlmToolCaller = (
  prompt: string,
  tools: Tool[],
  systemPrompt?: string,
) => Promise<Record<string, unknown>>;

/**
 * ResolveOptions — 阶段 4 实体消解选项
 */
export interface ResolveOptions {
  /** LLM 模型名（如 "deepseek-v4-flash"） */
  model: string;
  /** API key */
  apiKey: string;
  /** 注入式 LLM 调用器（测试用 mock；生产用默认实现） */
  callLlm?: LlmToolCaller;
}

/**
 * SuspiciousPair — 二级相似度判定未通过但可疑的实体对，送三级 LLM 判断
 */
export interface SuspiciousPair {
  pair_id: string;
  a: { name: string; type: EntityType; aliases: string[]; brief: string };
  b: { name: string; type: EntityType; aliases: string[]; brief: string };
  similarity: number;
}

/**
 * MergeDecision — LLM 三级判断输出
 */
export interface MergeDecision {
  pair_id: string;
  should_merge: boolean;
  canonical_name: string;
  reason: string;
}
