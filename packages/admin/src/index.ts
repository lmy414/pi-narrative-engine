// packages/admin/src/index.ts
/**
 * @pi/admin 子包入口
 *
 * narrative-engine 配置管理后端核心库：env 读写、PI 状态查询、规则集管理、
 * 依赖检查、一键更新、向量模型状态、novel.json 管理。
 *
 * 架构定位（与 @pi/novel-launcher 等子包一致）：
 * - workspace 子包（private: true，独立开发）
 * - 仅核心库 API，不含 HTTP 服务层（前端阶段再加薄服务层调用本包）
 * - 不随 narrative-engine 扩展运行时加载（不在 src/index.ts 装配链上），
 *   但被 src/index.ts 的 session_start 用于加载 .env，被 scripts/doctor.mjs 用于自检
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
  loadEnvFile,
  readEnvFile,
  writeEnvFile,
  EXTENSION_ENV_KEYS,
} from "./env-store.ts";
export type {
  EnvFileContent,
  ExtensionEnvKey,
} from "./env-store.ts";

// PI 宿主状态只读查询（ctx.model + ctx.modelRegistry）
export {
  getPiStatus,
  assertPiReady,
} from "./pi-status.ts";
export type { PiStatus } from "./pi-status.ts";

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

// 一键更新（git pull + build + sync，async generator 流式输出）
export {
  runUpdate,
  compareVersions,
} from "./updater.ts";
export type {
  UpdateEvent,
  UpdateStage,
  UpdateOptions,
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
  READABLE_EXTS,
  WRITABLE_EXTS,
} from "./files.ts";
export type {
  FileTreeNode,
  ProjectFileContent,
} from "./files.ts";

// 应用级配置 + 全局扩展安装/重装（应用化 §5.1/§5.3.2）
export {
  readAppConfig,
  writeAppConfig,
  getAppConfigPath,
  defaultGlobalExtPath,
  installExtension,
  reinstallExtension,
  checkExtensionUpdate,
} from "./app-config.ts";
export type {
  AppConfig,
  AppConfigUpdates,
  InstallExtensionOptions,
  InstallExtensionResult,
} from "./app-config.ts";

// ============ 公共类型与错误 ============

export {
  AdminError,
} from "./types.ts";
export type {
  CheckStatus,
  PiModelInfo,
  PiStatusContext,
  EmbedderLike,
} from "./types.ts";

// ============ 内部导出（_ 前缀，软隔离） ============

// env-store 内部实现（测试经相对路径访问）
export {
  _parseEnvContent,
  _atomicWrite,
} from "./env-store.ts";

// pi-status 内部实现
export {
  _detectPiVersion,
  _isPiVersionCompatible,
  _internals as _piStatusInternals,
} from "./pi-status.ts";

// doctor 内部实现
export {
  _checkNodeVersion,
  _checkNativeBindings,
  _checkDist,
  _checkTemplates,
  _checkEmbedderEnv,
  _checkPiVersion,
  _checkNovelStructure,
  _internals as _doctorInternals,
} from "./doctor.ts";

// rulesets 内部实现
// （无 _ 前缀内部函数，全部为公共 API）

// updater 内部实现
export {
  _checkWorkingTreeClean,
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
  _copyDir,
  _internals as _appConfigInternals,
} from "./app-config.ts";
