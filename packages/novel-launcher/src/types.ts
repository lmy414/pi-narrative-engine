// packages/novel-launcher/src/types.ts
/**
 * @pi/novel-launcher 公共类型定义
 *
 * 软隔离约定（与 @pi/scheduler 等子包一致）：
 * - 无前缀 = 公共 API（扩展层 / 外部消费者引用）
 * - _ 前缀 = 包内部实现，不保证稳定
 */

/** novel.json 结构（小说项目标识文件） */
export interface NovelProjectMeta {
  /** 项目名 */
  name: string;
  /** 引擎标识，固定 "narrative-engine" */
  engine: string;
  /** 引擎版本 */
  engineVersion: string;
  /** 世界图目录（相对项目根），默认 ".pi/world-graph-v3" */
  worldGraphDir: string;
  /** 章节目录（相对项目根），默认 "正文" */
  chaptersDir: string;
  /** 故事时间格式，如 "ch{NNN}.ev{NNN}" */
  storyTimeFormat: string;
  /** 创建日期 ISO 字符串（YYYY-MM-DD） */
  createdAt: string;
}

/** 扫描发现的项目 */
export interface NovelProject {
  /** 项目目录绝对路径 */
  dir: string;
  /** 相对扫描根目录的路径（用于显示） */
  relativePath: string;
  /** novel.json 元信息 */
  meta: NovelProjectMeta;
  /** 章节数（chaptersDir 下的 .md 文件数，排除 .gitkeep） */
  chapterCount: number;
  /** 项目目录最近修改时间 ISO 字符串 */
  lastModified: string;
}

/** discoverProjects 选项 */
export interface DiscoverOptions {
  /** 扫描最大深度（1=仅直接子目录），默认 3 */
  maxDepth?: number;
  /** 是否统计章节数，默认 true */
  includeChapterCount?: boolean;
}

/** createProject 选项 */
export interface CreateOptions {
  /** 项目名，默认 targetDir 的 basename */
  name?: string;
  /** 覆盖已存在文件 */
  force?: boolean;
  /**
   * 模板目录（缺省为仓库 templates/novel；打包 sidecar 中由调用方
   * 显式传入 server/templates/novel）
   */
  templatesDir?: string;
  /**
   * @deprecated 应用化后扩展为全局目录，不再同步项目级扩展，
   * 本字段仅为兼容保留（行为上恒为跳过）
   */
  skipExtension?: boolean;
}

/** 新建项目结果 */
export interface CreateResult {
  /** 项目目录绝对路径 */
  dir: string;
}

/** novel-launcher 统一错误 */
export class NovelLauncherError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "NovelLauncherError";
    this.code = code;
  }
}
