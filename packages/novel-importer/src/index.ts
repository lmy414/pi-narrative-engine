/**
 * @pi/novel-importer 子包入口
 *
 * V3 小说导入器：从 EPUB 导入小说到新 world-graph（@pi/world-graph）
 * 8 阶段管道：EPUB 分章 → 实体预扫描 → 章节事件流 → 实体消解 → 关系抽取 →
 *           可见性推断 → 写入 world-graph → 向量补齐+校验
 *
 * 详见 spec: .trae/specs/import-novel-v3/spec.md
 * 详见 tasks: .trae/specs/import-novel-v3/tasks.md
 *
 * 架构定位（与 @pi/world-graph 一致）：
 * - workspace 子包（private: true，独立开发）
 * - 通过 narrative-engine 扩展暴露单一 import_novel 工具
 * - 不独立成为 pi 扩展，随 narrative-engine 一起 build + sync
 */

// Re-export 所有子包类型
export type {
  EntityHint,
  NewFactHint,
  InvalidatedHint,
  EventHint,
  ChapterResult,
  AliasEntry,
  ResolveResult,
  RelationHint,
  VisibilityHint,
  ImportPipelineOptions,
  ImportPipelineResult,
  LlmToolCaller,
  ResolveOptions,
  SuspiciousPair,
  MergeDecision,
  TextEmbedder,
  EmbedderLike,
} from "./types.ts";

// Re-export schemas（值，运行时可用）
export {
  EntityInventorySchema,
  entityInventoryTool,
  MergeDecisionsSchema,
  mergeDecisionsTool,
  ChapterEventsSchema,
  chapterEventsTool,
  RelationsSchema,
  relationsTool,
  VisibilitiesSchema,
  visibilitiesTool,
} from "./schemas.ts";

// Re-export 实体消解相关函数
export {
  generateEntityId,
  jaroWinklerSimilarity,
  isExactMatch,
  groupByExactMatch,
  mergeBySimilarity,
  mergeByLLMJudgment,
  mergeGroupToCanonical,
  resolveEntities,
  makeLlmCaller,
  DEFAULT_SIMILARITY_THRESHOLD,
  SUSPICIOUS_LOWER_BOUND,
} from "./resolve.ts";

// Re-export prompts
export {
  buildEntityInventoryPrompt,
  ENTITY_INVENTORY_SYSTEM_PROMPT,
  buildMergePrompt,
  MERGE_SYSTEM_PROMPT,
  buildChapterEventsPrompt,
  CHAPTER_EVENTS_SYSTEM_PROMPT,
  buildRelationsPrompt,
  RELATIONS_SYSTEM_PROMPT,
  buildVisibilitiesPrompt,
  VISIBILITIES_SYSTEM_PROMPT,
} from "./prompts.ts";

// Re-export 阶段函数
export {
  scanEntitiesGlobal,
  generateChapterEvents,
  generateAllChapterEvents,
  extractRelations,
  extractAllRelations,
  inferVisibilities,
  inferAllVisibilities,
} from "./stages.ts";

// Re-export EPUB 解析
export {
  htmlToPlainText,
  readChaptersFromEpub,
  parallelWithLimit,
} from "./epub.ts";
export type { Chapter } from "./epub.ts";

// Re-export storyTime 工具
export {
  formatStoryTime,
  parseStoryTime,
  nextStoryTime,
  compareStoryTime,
  isValidStoryTime,
  STORY_TIME_REGEX,
  MAX_CHAPTER,
  MAX_EVENT_PER_CHAPTER,
} from "./storytime.ts";
export type { StoryTimeParts } from "./storytime.ts";

// Re-export 阶段 7 写入
export {
  generateEventId,
  buildCausedByChain,
  writeToGraph,
  buildChapterIndex,
  buildAliasIndex,
} from "./write.ts";
export type {
  EventWithChain,
  WriteOptions,
  WriteResult,
  ChapterIndexEntry,
} from "./write.ts";

// Re-export 阶段 8 校验
export {
  makeEmbedder,
  reembedAll,
  validateGraph,
} from "./validate.ts";
export type {
  ValidationContext,
  ValidationResult,
} from "./validate.ts";

// 主入口：runImportPipeline（来自 pipeline.ts）
export {
  runImportPipeline,
} from "./pipeline.ts";
export type { ProgressNotifier } from "./pipeline.ts";
