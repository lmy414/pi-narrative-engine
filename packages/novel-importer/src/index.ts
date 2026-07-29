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
 *
 * 软隔离约定（2026-07-29）：
 * - 无前缀 = 公共 API（仅 runImportPipeline + ProgressNotifier）
 * - _ 前缀 = 包内部实现（schemas/stages/epub/storytime/write/validate 等），
 *   仅供本包测试经相对路径访问，不保证稳定
 */

// ============ 公共 API ============

// 主入口：runImportPipeline
export {
  runImportPipeline,
} from "./pipeline.ts";
export type { ProgressNotifier } from "./pipeline.ts";

// ============ 内部导出（_ 前缀，软隔离） ============

// --- types.ts ---
export type {
  EntityHint as _EntityHint,
  NewFactHint as _NewFactHint,
  InvalidatedHint as _InvalidatedHint,
  EventHint as _EventHint,
  ChapterResult as _ChapterResult,
  AliasEntry as _AliasEntry,
  ResolveResult as _ResolveResult,
  RelationHint as _RelationHint,
  VisibilityHint as _VisibilityHint,
  ImportPipelineOptions as _ImportPipelineOptions,
  ImportPipelineResult as _ImportPipelineResult,
  LlmToolCaller as _LlmToolCaller,
  ResolveOptions as _ResolveOptions,
  SuspiciousPair as _SuspiciousPair,
  MergeDecision as _MergeDecision,
  TextEmbedder as _TextEmbedder,
  EmbedderLike as _EmbedderLike,
} from "./types.ts";

// --- schemas.ts ---
export {
  EntityInventorySchema as _EntityInventorySchema,
  entityInventoryTool as _entityInventoryTool,
  MergeDecisionsSchema as _MergeDecisionsSchema,
  mergeDecisionsTool as _mergeDecisionsTool,
  ChapterEventsSchema as _ChapterEventsSchema,
  chapterEventsTool as _chapterEventsTool,
  RelationsSchema as _RelationsSchema,
  relationsTool as _relationsTool,
  VisibilitiesSchema as _VisibilitiesSchema,
  visibilitiesTool as _visibilitiesTool,
} from "./schemas.ts";

// --- resolve.ts ---
export {
  generateEntityId as _generateEntityId,
  jaroWinklerSimilarity as _jaroWinklerSimilarity,
  isExactMatch as _isExactMatch,
  groupByExactMatch as _groupByExactMatch,
  mergeBySimilarity as _mergeBySimilarity,
  mergeByLLMJudgment as _mergeByLLMJudgment,
  mergeGroupToCanonical as _mergeGroupToCanonical,
  resolveEntities as _resolveEntities,
  makeLlmCaller as _makeLlmCaller,
  DEFAULT_SIMILARITY_THRESHOLD as _DEFAULT_SIMILARITY_THRESHOLD,
  SUSPICIOUS_LOWER_BOUND as _SUSPICIOUS_LOWER_BOUND,
} from "./resolve.ts";

// --- prompts.ts ---
export {
  buildEntityInventoryPrompt as _buildEntityInventoryPrompt,
  ENTITY_INVENTORY_SYSTEM_PROMPT as _ENTITY_INVENTORY_SYSTEM_PROMPT,
  buildMergePrompt as _buildMergePrompt,
  MERGE_SYSTEM_PROMPT as _MERGE_SYSTEM_PROMPT,
  buildChapterEventsPrompt as _buildChapterEventsPrompt,
  CHAPTER_EVENTS_SYSTEM_PROMPT as _CHAPTER_EVENTS_SYSTEM_PROMPT,
  buildRelationsPrompt as _buildRelationsPrompt,
  RELATIONS_SYSTEM_PROMPT as _RELATIONS_SYSTEM_PROMPT,
  buildVisibilitiesPrompt as _buildVisibilitiesPrompt,
  VISIBILITIES_SYSTEM_PROMPT as _VISIBILITIES_SYSTEM_PROMPT,
} from "./prompts.ts";

// --- stages.ts ---
export {
  scanEntitiesGlobal as _scanEntitiesGlobal,
  generateChapterEvents as _generateChapterEvents,
  generateAllChapterEvents as _generateAllChapterEvents,
  extractRelations as _extractRelations,
  extractAllRelations as _extractAllRelations,
  inferVisibilities as _inferVisibilities,
  inferAllVisibilities as _inferAllVisibilities,
} from "./stages.ts";

// --- epub.ts ---
export {
  htmlToPlainText as _htmlToPlainText,
  readChaptersFromEpub as _readChaptersFromEpub,
  parallelWithLimit as _parallelWithLimit,
} from "./epub.ts";
export type { Chapter as _Chapter } from "./epub.ts";

// --- storytime.ts ---
export {
  formatStoryTime as _formatStoryTime,
  parseStoryTime as _parseStoryTime,
  nextStoryTime as _nextStoryTime,
  compareStoryTime as _compareStoryTime,
  isValidStoryTime as _isValidStoryTime,
  STORY_TIME_REGEX as _STORY_TIME_REGEX,
  MAX_CHAPTER as _MAX_CHAPTER,
  MAX_EVENT_PER_CHAPTER as _MAX_EVENT_PER_CHAPTER,
} from "./storytime.ts";
export type { StoryTimeParts as _StoryTimeParts } from "./storytime.ts";

// --- write.ts ---
export {
  generateEventId as _generateEventId,
  buildCausedByChain as _buildCausedByChain,
  writeToGraph as _writeToGraph,
  buildChapterIndex as _buildChapterIndex,
  buildAliasIndex as _buildAliasIndex,
} from "./write.ts";
export type {
  EventWithChain as _EventWithChain,
  WriteOptions as _WriteOptions,
  WriteResult as _WriteResult,
  ChapterIndexEntry as _ChapterIndexEntry,
} from "./write.ts";

// --- validate.ts ---
export {
  makeEmbedder as _makeEmbedder,
  reembedAll as _reembedAll,
  validateGraph as _validateGraph,
} from "./validate.ts";
export type {
  ValidationContext as _ValidationContext,
  ValidationResult as _ValidationResult,
} from "./validate.ts";
