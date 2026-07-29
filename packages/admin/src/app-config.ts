// packages/admin/src/app-config.ts
/**
 * app-config.ts — 应用级配置读写 + 全局扩展安装/重装（应用化 §5.1 / §5.3.2）
 *
 * 与 env-store（项目级 .env）区分：本模块管应用本体配置，存平台应用数据目录：
 *   Windows  %APPDATA%/narrative-engine/app-config.json
 *   macOS    ~/Library/Application Support/narrative-engine/app-config.json
 *   Linux    ~/.config/narrative-engine/app-config.json
 *
 * 全局扩展安装：应用首次启动时把内置扩展快照复制到 globalPath 并跑
 * npm install；重装 = 清空后重新安装。npm install 经 _internals.spawn
 * 可 mock；测试用 skipNpmInstall 跳过。
 */
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { AdminError } from "./types.ts";

// ============================================================================
// 配置结构（§5.1.2）
// ============================================================================

export interface AppConfig {
  extension: {
    /** "enabled" | "disabled"（对应 WebUI 屏蔽扩展开关） */
    mode: "enabled" | "disabled";
    /** 全局扩展安装位置 */
    globalPath: string;
    /** true = 启动 PI 时用 -e 显式加载；false = 走 PI 自动发现 */
    useExplicitFlag: boolean;
    /** 已安装扩展版本 */
    version: string;
    /** 最近安装/重装时间 ISO */
    lastUpdated: string;
  };
  launcher: {
    /** pi 可执行文件，默认 "pi" */
    piExecutable: string;
    /** 项目扫描默认根目录 */
    defaultScanRoots: string[];
  };
  embedder: {
    /** 向量模型（对应 PI_EMBEDDER_MODEL） */
    model: string;
  };
}

/** 应用配置更新（深层部分合并） */
export interface AppConfigUpdates {
  extension?: Partial<AppConfig["extension"]>;
  launcher?: Partial<AppConfig["launcher"]>;
  embedder?: Partial<AppConfig["embedder"]>;
}

// ============================================================================
// 路径解析
// ============================================================================

/**
 * 平台应用数据目录（不含 app-config.json 文件名）
 * 测试可传 envOverride 注入 APPDATA/HOME/XDG_CONFIG_HOME
 */
export function _defaultConfigDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "win32") {
    const base = env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(base, "narrative-engine");
  }
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "narrative-engine");
  }
  const base = env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(base, "narrative-engine");
}

/** app-config.json 完整路径；configDir 缺省为平台默认目录 */
export function getAppConfigPath(configDir?: string): string {
  return path.join(configDir ?? _defaultConfigDir(), "app-config.json");
}

/** 全局扩展目录默认位置：<configDir>/extensions/narrative-engine */
export function defaultGlobalExtPath(configDir?: string): string {
  return path.join(configDir ?? _defaultConfigDir(), "extensions", "narrative-engine");
}

// ============================================================================
// 读写
// ============================================================================

function _defaultConfig(configDir?: string): AppConfig {
  return {
    extension: {
      mode: "enabled",
      globalPath: defaultGlobalExtPath(configDir),
      useExplicitFlag: true,
      version: "",
      lastUpdated: "",
    },
    launcher: {
      piExecutable: "pi",
      defaultScanRoots: [],
    },
    embedder: {
      model: "Xenova/bge-small-zh-v1.5",
    },
  };
}

/**
 * 读取应用配置（文件缺失或字段缺失时填默认值，宽松合并）
 */
export async function readAppConfig(configDir?: string): Promise<AppConfig> {
  const filePath = getAppConfigPath(configDir);
  const defaults = _defaultConfig(configDir);
  if (!existsSync(filePath)) return defaults;
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return defaults;
  }
  const obj = (raw ?? {}) as Record<string, Record<string, unknown>>;
  return {
    extension: { ...defaults.extension, ...(obj.extension ?? {}) },
    launcher: { ...defaults.launcher, ...(obj.launcher ?? {}) },
    embedder: { ...defaults.embedder, ...(obj.embedder ?? {}) },
  };
}

/**
 * 更新应用配置（按顶层 key 深层合并，原子写；目录自动创建）
 */
export async function writeAppConfig(
  updates: AppConfigUpdates,
  configDir?: string,
): Promise<AppConfig> {
  const filePath = getAppConfigPath(configDir);
  const current = await readAppConfig(configDir);
  if (updates.extension?.mode !== undefined &&
      updates.extension.mode !== "enabled" && updates.extension.mode !== "disabled") {
    throw new AdminError(
      `非法扩展模式: ${updates.extension.mode}（可选 enabled/disabled）`,
      "INVALID_MODE",
    );
  }
  const merged: AppConfig = {
    extension: { ...current.extension, ...(updates.extension ?? {}) },
    launcher: { ...current.launcher, ...(updates.launcher ?? {}) },
    embedder: { ...current.embedder, ...(updates.embedder ?? {}) },
  };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = filePath + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(merged, null, 2) + "\n", "utf8");
  await fs.rename(tmp, filePath);
  return merged;
}

// ============================================================================
// 全局扩展安装 / 重装
// ============================================================================

export const _internals: { spawn: typeof spawn } = { spawn };

export interface InstallExtensionOptions {
  /** 应用内置扩展快照目录（含 dist/ packages/ visualizer-ui/ templates/ package.json） */
  snapshotDir: string;
  /** 全局扩展目标目录 */
  globalExtDir: string;
  /** 跳过 npm install（测试用；真实流程必须在复制后安装依赖） */
  skipNpmInstall?: boolean;
  /** 重装模式：先清空目标目录 */
  reinstall?: boolean;
}

export interface InstallExtensionResult {
  ok: boolean;
  /** 复制的文件数（不含目录） */
  copiedFiles: number;
  /** npm install 是否执行 */
  npmInstallRan: boolean;
  globalExtDir: string;
}

/** 递归复制目录内容（跳过 node_modules 与 .git），返回复制文件数 */
export async function _copyDir(src: string, dst: string): Promise<number> {
  let count = 0;
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) {
      count += await _copyDir(s, d);
    } else if (e.isFile()) {
      await fs.copyFile(s, d);
      count++;
    }
  }
  return count;
}

function _runNpmInstall(cwd: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const cmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const child = _internals.spawn(cmd, ["install", "--omit=dev"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    let stderr = "";
    child.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });
    child.on("error", (err) => rejectPromise(new AdminError(`npm install 启动失败: ${err.message}`, "NPM_FAILED")));
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new AdminError(`npm install 失败（退出码 ${code}）: ${stderr.slice(-500)}`, "NPM_FAILED"));
    });
  });
}

/**
 * 安装（或重装）全局扩展
 *
 * - snapshotDir 必须含 package.json（快照完整性校验）
 * - reinstall=true 时先清空目标目录
 * - 复制快照（跳过 node_modules）后在目标目录跑 npm install --omit=dev
 *
 * @throws AdminError SNAPSHOT_INVALID / NPM_FAILED
 */
export async function installExtension(
  options: InstallExtensionOptions,
): Promise<InstallExtensionResult> {
  const { snapshotDir, globalExtDir, skipNpmInstall = false, reinstall = false } = options;

  if (!existsSync(path.join(snapshotDir, "package.json"))) {
    throw new AdminError(
      `扩展快照无效（缺少 package.json）: ${snapshotDir}`,
      "SNAPSHOT_INVALID",
    );
  }

  if (reinstall && existsSync(globalExtDir)) {
    await fs.rm(globalExtDir, { recursive: true, force: true });
  }
  const copiedFiles = await _copyDir(snapshotDir, globalExtDir);

  let npmInstallRan = false;
  if (!skipNpmInstall) {
    await _runNpmInstall(globalExtDir);
    npmInstallRan = true;
  }
  return { ok: true, copiedFiles, npmInstallRan, globalExtDir };
}

/**
 * 重装全局扩展（installExtension 的 reinstall=true 别名，§5.3.2 应用内置模式）
 */
export async function reinstallExtension(
  snapshotDir: string,
  globalExtDir: string,
  options?: { skipNpmInstall?: boolean },
): Promise<InstallExtensionResult> {
  return installExtension({
    snapshotDir,
    globalExtDir,
    reinstall: true,
    skipNpmInstall: options?.skipNpmInstall,
  });
}

/**
 * 扩展更新检查（应用内置模式）：比对已安装版本与快照版本
 * 读 globalExtDir/package.json 与 snapshotDir/package.json 的 version
 */
export async function checkExtensionUpdate(
  snapshotDir: string,
  globalExtDir: string,
): Promise<{ current: string | null; available: string | null; updateAvailable: boolean }> {
  async function readVersion(dir: string): Promise<string | null> {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
      return typeof pkg.version === "string" ? pkg.version : null;
    } catch {
      return null;
    }
  }
  const [current, available] = await Promise.all([
    readVersion(globalExtDir),
    readVersion(snapshotDir),
  ]);
  return {
    current,
    available,
    updateAvailable: current !== null && available !== null && current !== available,
  };
}
