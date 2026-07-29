// packages/novel-launcher/src/project.ts
/**
 * 项目级操作：新建项目、启动可视化、在文件管理器中打开。
 *
 * 复用 narrative-engine 仓库现有脚本（以查档求证、复用存量为原则）：
 * - createProject  → scripts/init-novel.mjs（spawnSync 同步等待完成）
 * - launchVisualizer → scripts/visualizer.mjs（spawn 新终端窗口运行）
 *
 * 仓库根定位：本文件位于 packages/novel-launcher/src/，向上 3 层即仓库根。
 */
import { spawn, spawnSync } from "node:child_process";
import { resolve, join, dirname } from "node:path";
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

/** 新建小说项目（复用 init-novel.mjs，同步等待完成） */
export async function createProject(
  targetDir: string,
  options?: CreateOptions,
): Promise<CreateResult> {
  const dir = resolve(targetDir);
  const scriptPath = _resolveScript("init-novel.mjs");
  const args = [dir];
  if (options?.name) args.push("--name", options.name);
  if (options?.force) args.push("--force");
  if (options?.skipExtension) args.push("--skip-extension");
  const r = _internals.spawnSync(process.execPath, [scriptPath, ...args], { stdio: "inherit" });
  if (r.status !== 0) {
    throw new NovelLauncherError(
      `创建项目失败（init-novel 退出码 ${r.status ?? "null"}）`,
      "CREATE_FAILED",
    );
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
