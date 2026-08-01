// packages/admin/src/app-config.ts
/**
 * app-config.ts — 应用级配置读写
 *
 * 与 env-store（项目级 .env）区分：本模块管应用本体配置，存平台应用数据目录：
 *   Windows  %APPDATA%/narrative-engine/app-config.json
 *   macOS    ~/Library/Application Support/narrative-engine/app-config.json
 *   Linux    ~/.config/narrative-engine/app-config.json
 */
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { AdminError } from "./types.ts";

// ============================================================================
// 配置结构（§5.1.2）
// ============================================================================

export interface AppConfig {
  launcher: {
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

// ============================================================================
// 读写
// ============================================================================

function _defaultConfig(): AppConfig {
  return {
    launcher: {
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
  const defaults = _defaultConfig();
  if (!existsSync(filePath)) return defaults;
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return defaults;
  }
  const obj = (raw ?? {}) as Record<string, Record<string, unknown>>;
  return {
    launcher: { ...defaults.launcher, ...(obj.launcher ?? {}) },
    embedder: { ...defaults.embedder, ...(obj.embedder ?? {}) },
  };
}

/**
 * 更新应用配置（深层合并已知键，原子写；目录自动创建）
 *
 * 只写 schema 已知键：磁盘文件里的废弃键（如扩展时代的 launcher.piExecutable）
 * 在写入时被剥离；readAppConfig 保持宽松读取不受影响。
 */
export async function writeAppConfig(
  updates: AppConfigUpdates,
  configDir?: string,
): Promise<AppConfig> {
  const filePath = getAppConfigPath(configDir);
  const current = await readAppConfig(configDir);
  const merged: AppConfig = {
    launcher: {
      defaultScanRoots:
        updates.launcher?.defaultScanRoots ?? current.launcher.defaultScanRoots,
    },
    embedder: {
      model: updates.embedder?.model ?? current.embedder.model,
    },
  };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = filePath + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(merged, null, 2) + "\n", "utf8");
  await fs.rename(tmp, filePath);
  return merged;
}
