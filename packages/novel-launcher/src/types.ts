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

/** launchPi 选项 */
export interface LaunchOptions {
  /** 传给 pi 的额外参数 */
  args?: string[];
  /** pi 可执行文件路径，默认 "pi"（依赖 PATH） */
  executable?: string;
  /** 新终端窗口标题，默认用项目名 */
  title?: string;
  /**
   * 扩展加载策略（应用化 §5.2.1）：
   * - "enabled"（缺省）：正常加载扩展
   * - "disabled"：拼 --no-extensions，PI 以纯净模式运行
   */
  extensionMode?: "enabled" | "disabled";
  /**
   * 显式扩展路径（应用内置扩展场景）：拼 `-e <path>`，
   * 不依赖自动发现目录。extensionMode 为 "disabled" 时忽略。
   */
  extensionPath?: string;
}

/** 启动结果 */
export interface LaunchResult {
  /** 已启动进程的 PID（进程已 detach，调用方一般无需管理生命周期） */
  pid: number;
}

/** createProject 选项 */
export interface CreateOptions {
  /** 项目名，默认 targetDir 的 basename */
  name?: string;
  /** 覆盖已存在文件 */
  force?: boolean;
  /** 跳过扩展同步 */
  skipExtension?: boolean;
}

/** 新建项目结果 */
export interface CreateResult {
  /** 项目目录绝对路径 */
  dir: string;
}

/** launchVisualizer 选项 */
export interface VisualizerOptions {
  /** 监听端口，默认 7421 */
  port?: number;
  /** 启用向量检索（加载嵌入模型） */
  embed?: boolean;
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
