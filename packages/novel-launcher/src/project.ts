// packages/novel-launcher/src/project.ts
/**
 * 项目级操作：新建项目、启动可视化、在文件管理器中打开。
 *
 * - createProject → 内联实现（2026-07-30 库化：原 spawn scripts/init-novel.mjs
 *   在打包 sidecar 中无脚本文件可用。模板目录默认仓库 templates/novel，
 *   生产模式由调用方经 CreateOptions.templatesDir 显式传入）
 * - launchVisualizer → scripts/visualizer.mjs（spawn 新终端窗口运行）
 *
 * 仓库根定位：本文件位于 packages/novel-launcher/src/，向上 3 层即仓库根。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CreateOptions,
  CreateResult,
  VisualizerOptions,
  LaunchResult,
} from "./types.ts";
import { NovelLauncherError } from "./types.ts";
import { _readNovelJson } from "./discover.ts";
import { _spawnNewTerminal } from "./launch.ts";

/**
 * 可替换的内部依赖集合（ESM namespace 属性不可重定义，
 * 用对象包装便于测试 mock；_ 前缀表示内部实现，软隔离）。
 */
export const _internals: {
  spawn: typeof spawn;
  spawnSync: typeof spawnSync;
} = { spawn, spawnSync };

const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/novel-launcher/src → 仓库根
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

/** 解析 narrative-engine 仓库内 scripts/ 下的脚本绝对路径 */
export function _resolveScript(name: string): string {
  return join(REPO_ROOT, "scripts", name);
}

/** 模板文件清单（源名 → 目标名；{{name}}/{{date}} 变量替换） */
const TEMPLATE_FILES: Array<[string, string]> = [
  ["novel.json", "novel.json"],
  ["规则集.md", "规则集.md"],
  ["planner 规则集.md", "planner 规则集.md"],
  ["角色规则集.md", "角色规则集.md"],
  ["_gitignore", ".gitignore"],
  ["README.md", "README.md"],
];

/** 复制模板并变量替换；已存在且未 force 时跳过 */
async function _copyTemplate(
  templatesDir: string,
  srcName: string,
  destPath: string,
  vars: Record<string, string>,
  force: boolean,
): Promise<void> {
  if (existsSync(destPath) && !force) return;
  let content = await readFile(join(templatesDir, srcName), "utf8");
  for (const [k, v] of Object.entries(vars)) {
    content = content.replaceAll(`{{${k}}}`, v);
  }
  await mkdir(dirname(destPath), { recursive: true });
  await writeFile(destPath, content, "utf8");
}

async function _ensureGitkeep(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const keep = join(dir, ".gitkeep");
  if (!existsSync(keep)) await writeFile(keep, "", "utf8");
}

/**
 * 新建小说项目（内联实现，幂等）
 *
 * 创建：正文/、.pi/world-graph-v3/ 目录骨架 + 模板六件套
 * （novel.json / 规则集三件套 / .gitignore / README.md）。
 *
 * 不再同步项目级扩展：应用化后扩展为全局目录（§4.2），
 * CreateOptions.skipExtension 仅为兼容保留、行为上恒为跳过。
 */
export async function createProject(
  targetDir: string,
  options?: CreateOptions,
): Promise<CreateResult> {
  const dir = resolve(targetDir);
  const templatesDir = options?.templatesDir ?? join(REPO_ROOT, "templates", "novel");
  if (!existsSync(templatesDir)) {
    throw new NovelLauncherError(
      `模板目录不存在: ${templatesDir}`,
      "TEMPLATE_NOT_FOUND",
    );
  }
  const name = options?.name ?? basename(dir);
  const vars = { name, date: new Date().toISOString().slice(0, 10) };

  await _ensureGitkeep(join(dir, "正文"));
  await _ensureGitkeep(join(dir, ".pi", "world-graph-v3"));
  for (const [src, dest] of TEMPLATE_FILES) {
    await _copyTemplate(templatesDir, src, join(dir, dest), vars, options?.force ?? false);
  }
  return { dir };
}

/** 在新终端窗口启动项目可视化（复用 visualizer.mjs） */
export async function launchVisualizer(
  projectDir: string,
  options?: VisualizerOptions,
): Promise<LaunchResult> {
  const dir = resolve(projectDir);
  let meta;
  try {
    meta = await _readNovelJson(dir);
  } catch {
    throw new NovelLauncherError(
      `项目未找到 novel.json: ${dir}`,
      "NOVEL_JSON_NOT_FOUND",
    );
  }
  const dbDir = join(dir, meta.worldGraphDir);
  const scriptPath = _resolveScript("visualizer.mjs");
  const visualizerArgs = [scriptPath, "--db", dbDir];
  if (options?.port !== undefined) visualizerArgs.push("--port", String(options.port));
  if (options?.embed) visualizerArgs.push("--embed");
  const pid = _spawnNewTerminal(
    dir,
    process.execPath,
    visualizerArgs,
    `可视化 - ${meta.name}`,
  );
  return { pid };
}

/** 在系统文件管理器中打开项目目录 */
export async function openInFileManager(projectDir: string): Promise<void> {
  const dir = resolve(projectDir);
  const platform = process.platform;
  let command: string;
  let args: string[];
  if (platform === "win32") {
    command = "explorer.exe";
    args = [dir];
  } else if (platform === "darwin") {
    command = "open";
    args = [dir];
  } else {
    command = "xdg-open";
    args = [dir];
  }
  const child = _internals.spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}
