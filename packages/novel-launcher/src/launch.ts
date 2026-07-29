// packages/novel-launcher/src/launch.ts
/**
 * 启动 pi：在指定项目目录打开新终端窗口运行 pi。
 *
 * 跨平台策略：
 * - Windows: `cmd /c start "title" cmd /k pi`（spawn 的 cwd=项目目录，
 *   新 cmd 窗口继承该 cwd，无需 cd 命令、避免路径引号转义问题）
 * - macOS: osascript 驱动 Terminal.app 新窗口执行 `cd dir && pi`
 * - Linux: gnome-terminal / konsole / xterm，可用 PI_TERMINAL 环境变量覆盖
 *
 * 扩展加载是 pi 的自动行为：项目目录下 `.pi/extensions/` 会被 pi 自动发现，
 * 故本函数只需保证 pi 在正确目录启动。
 *
 * 返回的 pid 是中间终端进程的 pid（start/osascript 拉起的实际 pi 是孙进程），
 * 仅用于确认启动成功，不保证可管理 pi 生命周期。
 */
import { spawn } from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import { resolve, basename } from "node:path";
import type { LaunchOptions, LaunchResult } from "./types.ts";
import { NovelLauncherError } from "./types.ts";
import { _readNovelJson } from "./discover.ts";

/**
 * 可替换的内部依赖集合（ESM namespace 属性不可重定义，
 * 用对象包装便于测试 mock；_ 前缀表示内部实现，软隔离）。
 */
export const _internals: { spawn: typeof spawn } = { spawn };

/** 含空格/引号的参数加双引号转义（跨平台命令行拼接） */
function _quoteArg(arg: string): string {
  if (arg === "") return '""';
  if (/[\s"]/.test(arg)) {
    // 仅转义双引号；反斜杠在 Windows cmd 双引号内字面保留，bash 路径用 / 不含 \
    return `"${arg.replace(/"/g, '\\"')}"`;
  }
  return arg;
}

/** 构造 pi 执行命令字符串（用于 shell 命令拼接，自动引号化） */
export function _buildPiCommand(executable: string, args: string[]): string {
  return [executable, ...args].map(_quoteArg).join(" ");
}

/** spawn 一个终端进程，返回 pid；同步失败抛 NovelLauncherError */
function _spawnTerminal(
  command: string,
  args: string[],
  options: SpawnOptions,
): number {
  const child = _internals.spawn(command, args, options);
  // 异步 error（如 ENOENT）吞掉，由同步 pid 检查兜底
  child.on("error", () => {});
  child.unref();
  const pid = child.pid;
  if (!pid) {
    throw new NovelLauncherError(
      `无法启动终端（命令可能不存在）: ${command}`,
      "SPAWN_FAILED",
    );
  }
  return pid;
}

/** Windows: `start "title" cmd /k piCmd`，新 cmd 继承 cwd */
function _spawnWindows(
  cwd: string,
  executable: string,
  args: string[],
  title: string,
): number {
  const piCmd = _buildPiCommand(executable, args);
  const titleArg = `"${title}"`;
  return _spawnTerminal(
    "cmd.exe",
    ["/c", "start", titleArg, "cmd.exe", "/k", piCmd],
    { cwd, detached: true, stdio: "ignore", windowsVerbatimArguments: true },
  );
}

/** macOS: osascript 让 Terminal 新窗口执行 cd && piCmd */
function _spawnDarwin(
  cwd: string,
  executable: string,
  args: string[],
  title: string,
): number {
  const piCmd = _buildPiCommand(executable, args);
  const shellCmd = `cd '${cwd}' && ${piCmd}`;
  // osascript 字符串用双引号，内部双引号与反斜杠需转义
  const osaString = shellCmd.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = `tell application "Terminal" to do script "${osaString}"`;
  return _spawnTerminal("osascript", ["-e", script], {
    cwd,
    detached: true,
    stdio: "ignore",
  });
}

/** Linux: PI_TERMINAL 环境变量选择终端，默认 gnome-terminal */
function _spawnLinux(
  cwd: string,
  executable: string,
  args: string[],
  title: string,
): number {
  const terminal = process.env.PI_TERMINAL ?? "gnome-terminal";
  if (terminal === "gnome-terminal") {
    return _spawnTerminal(
      terminal,
      [`--working-directory=${cwd}`, "--", executable, ...args],
      { cwd, detached: true, stdio: "ignore" },
    );
  }
  if (terminal === "konsole") {
    return _spawnTerminal(
      terminal,
      ["--workdir", cwd, "-e", executable, ...args],
      { cwd, detached: true, stdio: "ignore" },
    );
  }
  if (terminal === "xterm") {
    const piCmd = _buildPiCommand(executable, args);
    return _spawnTerminal(
      terminal,
      ["-e", `cd '${cwd}' && ${piCmd}`],
      { cwd, detached: true, stdio: "ignore" },
    );
  }
  throw new NovelLauncherError(
    `不支持的终端: ${terminal}（设置 PI_TERMINAL 为 gnome-terminal/konsole/xterm）`,
    "UNSUPPORTED_TERMINAL",
  );
}

/** 平台分派：在 cwd 打开新终端窗口运行 executable + args */
export function _spawnNewTerminal(
  cwd: string,
  executable: string,
  args: string[],
  title: string,
): number {
  const platform = process.platform;
  if (platform === "win32") return _spawnWindows(cwd, executable, args, title);
  if (platform === "darwin") return _spawnDarwin(cwd, executable, args, title);
  return _spawnLinux(cwd, executable, args, title);
}

/** 在项目目录打开新终端窗口启动 pi（扩展自动加载） */
export async function launchPi(
  projectDir: string,
  options?: LaunchOptions,
): Promise<LaunchResult> {
  const dir = resolve(projectDir);
  const executable = options?.executable ?? "pi";
  const args = options?.args ?? [];
  let title = options?.title;
  if (!title) {
    try {
      title = (await _readNovelJson(dir)).name;
    } catch {
      title = basename(dir);
    }
  }
  const pid = _spawnNewTerminal(dir, executable, args, title);
  return { pid };
}
