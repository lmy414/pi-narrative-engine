// packages/admin/src/index.ts
/**
 * @pi/admin 子包入口
 *
 * narrative-engine 配置管理后端核心库：env 读写、LLM 状态查询、规则集管理、
 * 依赖检查、版本对比、向量模型状态、novel.json 管理。
 *
 * 架构定位（与 @pi/novel-launcher 等子包一致）：
 * - workspace 子包（private: true，独立开发）
 * - 仅核心库 API，HTTP 服务层在 src/app/routes-ext.ts
 *
 * 软隔离约定：
 * - 无前缀 = 公共 API（外部消费者引用）
 * - _ 前缀 = 包内部实现，不保证稳定
 *
 * 设计依据：docs/plans/2026-07-29-config-ui-design.md §6
 */

// ============ 公共 API ============

// 扩展专属 .env 读写（HF_ENDPOINT / PI_DEBUG / PI_EMBEDDER_MODEL）
export {
  readEnvFile,
  writeEnvFile,
  EXTENSION_ENV_KEYS,
} from "./env-store.ts";
export type {
  EnvFileContent,
  ExtensionEnvKey,
} from "./env-store.ts";

// LLM 状态只读查询（pure-SDK：AuthStorage + LlmConfigStore 解析链）
export {
  getPiStatus,
} from "./pi-status.ts";
export type {
  PiStatus,
  PiStatusDeps,
  ResolvedModel,
} from "./pi-status.ts";

// 规则集三件套读写与重置
export {
  readAllRulesets,
  readRuleset,
  writeRuleset,
  resetRuleset,
  RULESET_NAMES,
} from "./rulesets.ts";
export type {
  RulesetName,
  RulesetContent,
  ResetRulesetOptions,
} from "./rulesets.ts";

// 依赖检查（从 scripts/doctor.mjs 抽取的可 import 函数）
export {
  runDoctor,
  formatDoctorReport,
} from "./doctor.ts";
export type {
  DoctorCheck,
  DoctorReport,
  DoctorOptions,
} from "./doctor.ts";

// 版本对比（本地 package.json vs 远程 git tags）
export {
  compareVersions,
} from "./updater.ts";

// 向量模型状态与缓存管理
export {
  getEmbedderStatus,
  clearEmbedderCache,
  warmupEmbedder,
  assertModelValid,
  DEFAULT_EMBEDDER_MODEL,
  DEFAULT_EMBEDDER_DIM,
} from "./embedder-status.ts";
export type {
  EmbedderStatus,
  WarmupResult,
} from "./embedder-status.ts";

// novel.json 读写
export {
  readNovelJson,
  writeNovelJson,
} from "./novel-json.ts";
export type {
  NovelJson,
  NovelJsonReadResult,
} from "./novel-json.ts";

// 工程内 markdown 文件通用读写（文件编辑器后端，§11.3）
export {
  listFileTree,
  readProjectFile,
  writeProjectFile,
  createProjectFile,
  deleteProjectFile,
  renameProjectFile,
  READABLE_EXTS,
  WRITABLE_EXTS,
} from "./files.ts";
export type {
  FileTreeNode,
  ProjectFileContent,
} from "./files.ts";

// 应用级配置
export {
  readAppConfig,
  writeAppConfig,
  getAppConfigPath,
  LLM_SLOT_NAMES,
} from "./app-config.ts";
export type {
  AppConfig,
  AppConfigUpdates,
  LlmSlotName,
  LlmSlotConfig,
} from "./app-config.ts";

// ============ 公共类型与错误 ============

export {
  AdminError,
} from "./types.ts";
export type {
  CheckStatus,
  PiModelInfo,
  EmbedderLike,
} from "./types.ts";

// ============ 内部导出（_ 前缀，软隔离） ============

// env-store 内部实现（测试经相对路径访问）
export {
  _parseEnvContent,
  _atomicWrite,
} from "./env-store.ts";

// doctor 内部实现
export {
  _checkNodeVersion,
  _checkNativeBindings,
  _checkTemplates,
  _checkEmbedderEnv,
  _checkNovelStructure,
} from "./doctor.ts";

// rulesets 内部实现
// （无 _ 前缀内部函数，全部为公共 API）

// updater 内部实现
export {
  _compareSemver,
  _internals as _updaterInternals,
} from "./updater.ts";

// embedder-status 内部实现
export {
  _dirSize,
  _findCacheDir,
  _validateModelName,
} from "./embedder-status.ts";

// novel-json 内部实现
export { _normalizeNovelJson } from "./novel-json.ts";

// files 内部实现
export { _resolveSafePath } from "./files.ts";

// app-config 内部实现
export {
  _defaultConfigDir,
} from "./app-config.ts";
