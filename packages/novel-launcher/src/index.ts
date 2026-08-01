// packages/novel-launcher/src/index.ts
/**
 * @pi/novel-launcher 子包入口
 *
 * 小说项目管理后端核心库：项目发现、启动 pi、新建项目、启动可视化、打开文件夹。
 *
 * 架构定位（与 underworld-graph、@pi/scheduler 等子包一致）：
 * - workspace 子包（private: true，独立开发）
 * - 仅核心库 API，不含 HTTP 服务层（前端阶段再加薄服务层）
 * - 不随 narrative-engine 扩展同步到 .pi/extensions/，是独立工具
 *
 * 软隔离约定：
 * - 无前缀 = 公共 API（外部消费者引用）
 * - _ 前缀 = 包内部实现，不保证稳定
 */

// ============ 公共 API ============

// 项目发现
export { discoverProjects, getProjectMeta } from "./discover.ts";

// 项目级操作
export { createProject, openInFileManager } from "./project.ts";

// 类型
export type {
  NovelProject,
  NovelProjectMeta,
  DiscoverOptions,
  CreateOptions,
  CreateResult,
} from "./types.ts";

// 统一错误
export { NovelLauncherError } from "./types.ts";

// ============ 内部导出（_ 前缀，软隔离） ============

// 项目发现内部实现（测试经相对路径访问）
export { _readNovelJson, _countChapters, _discoverProjects } from "./discover.ts";

// 项目内部实现
export { _resolveScript, _internals as _projectInternals } from "./project.ts";
