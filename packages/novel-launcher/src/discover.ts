// packages/novel-launcher/src/discover.ts
/**
 * 项目发现：扫描根目录下所有含 novel.json 的目录，读取元信息。
 *
 * 命中项目后不再深入其子目录（避免误入 .pi/正文 等项目内部结构）。
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { Dirent } from "node:fs";
import { resolve, relative, join, basename } from "node:path";
import type { NovelProject, NovelProjectMeta, DiscoverOptions } from "./types.ts";
import { NovelLauncherError } from "./types.ts";
import { probeWorldDb } from "./world-db-probe.ts";

const SKIP_DIRS = new Set(["node_modules", ".git", ".pi"]);
const NOVEL_JSON = "novel.json";

const DEFAULT_META = {
  engine: "narrative-engine",
  engineVersion: "0.1.0",
  worldGraphDir: ".pi/world-graph-v3",
  chaptersDir: "正文",
  storyTimeFormat: "ch{NNN}.ev{NNN}",
} as const;

/** 读取并解析 novel.json，缺失字段填默认值 */
export async function _readNovelJson(projectDir: string): Promise<NovelProjectMeta> {
  const filePath = join(projectDir, NOVEL_JSON);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    throw new NovelLauncherError(
      `novel.json 不存在或不可读: ${filePath}`,
      "NOVEL_JSON_NOT_FOUND",
    );
  }
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new NovelLauncherError(
      `novel.json 解析失败: ${filePath}`,
      "INVALID_NOVEL_JSON",
    );
  }
  const name =
    typeof data.name === "string" && data.name ? data.name : basename(projectDir);
  return {
    name,
    engine: typeof data.engine === "string" ? data.engine : DEFAULT_META.engine,
    engineVersion:
      typeof data.engineVersion === "string" ? data.engineVersion : DEFAULT_META.engineVersion,
    worldGraphDir:
      typeof data.worldGraphDir === "string" ? data.worldGraphDir : DEFAULT_META.worldGraphDir,
    chaptersDir:
      typeof data.chaptersDir === "string" ? data.chaptersDir : DEFAULT_META.chaptersDir,
    storyTimeFormat:
      typeof data.storyTimeFormat === "string" ? data.storyTimeFormat : DEFAULT_META.storyTimeFormat,
    createdAt: typeof data.createdAt === "string" ? data.createdAt : "",
  };
}

/** 统计章节目录下的 .md 文件数（排除 .gitkeep） */
export async function _countChapters(projectDir: string, chaptersDir: string): Promise<number> {
  const dir = join(projectDir, chaptersDir);
  if (!existsSync(dir)) return 0;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  return entries.filter((f) => f.endsWith(".md") && f !== ".gitkeep").length;
}

interface DiscoverOpts {
  maxDepth: number;
  includeChapterCount: boolean;
  includeStats: boolean;
}

/** 递归扫描目录，收集所有含 novel.json 的项目（命中后不再深入） */
export async function _discoverProjects(
  rootDir: string,
  originalRoot: string,
  options: DiscoverOpts,
  currentDepth: number,
): Promise<NovelProject[]> {
  const results: NovelProject[] = [];
  // currentDepth 从 0 起算（扫描 rootDir 的直接子目录），
  // 故 maxDepth=1 仅扫直接子目录，maxDepth=N 最多扫到 N 层深。
  if (currentDepth >= options.maxDepth) return results;

  let entries: Dirent[];
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith(".")) continue;

    const childDir = join(rootDir, entry.name);
    const novelJsonPath = join(childDir, NOVEL_JSON);

    if (existsSync(novelJsonPath)) {
      const meta = await _readNovelJson(childDir);
      const chapterCount = options.includeChapterCount
        ? await _countChapters(childDir, meta.chaptersDir)
        : 0;
      let mtime: Date;
      try {
        mtime = (await stat(childDir)).mtime;
      } catch {
        mtime = new Date();
      }
      const probe = options.includeStats
        ? await probeWorldDb(childDir, meta)
        : { needsMigration: false, stats: null };
      results.push({
        dir: childDir,
        relativePath: relative(originalRoot, childDir),
        meta,
        chapterCount,
        lastModified: mtime.toISOString(),
        needsMigration: probe.needsMigration,
        stats: probe.stats,
      });
    } else {
      const sub = await _discoverProjects(childDir, originalRoot, options, currentDepth + 1);
      results.push(...sub);
    }
  }
  return results;
}

/** 扫描根目录下所有小说项目（含 novel.json 的目录） */
export async function discoverProjects(
  rootDir: string,
  options?: DiscoverOptions,
): Promise<NovelProject[]> {
  const resolvedRoot = resolve(rootDir);
  const opts: DiscoverOpts = {
    maxDepth: options?.maxDepth ?? 3,
    includeChapterCount: options?.includeChapterCount ?? true,
    includeStats: options?.includeStats ?? true,
  };
  return _discoverProjects(resolvedRoot, resolvedRoot, opts, 0);
}

/** 读取单个项目的元信息 */
export async function getProjectMeta(projectDir: string): Promise<NovelProjectMeta> {
  return _readNovelJson(resolve(projectDir));
}
