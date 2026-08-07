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
import { randomBytes } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { AdminError } from "./types.ts";
import { createWriteQueue } from "./serialize.ts";

// ============================================================================
// 配置结构（§5.1.2）
// ============================================================================

export interface AppConfig {
  launcher: {
    /** 项目扫描默认根目录 */
    defaultScanRoots: string[];
    /** 最近激活的项目目录（启动时恢复用；null = 无） */
    lastProjectDir: string | null;
  };
  embedder: {
    /** 向量模型（对应 PI_EMBEDDER_MODEL） */
    model: string;
  };
  llm: {
    /** slot → {provider, model} 映射（apiKey 不落盘于此，权威存储为 AuthStorage auth.json） */
    slots: Partial<Record<LlmSlotName, LlmSlotConfig>>;
    /** 自定义厂商列表（内置厂商由 pi-ai 枚举派生，不落盘于此） */
    providers: CustomProvider[];
    /** 内置厂商启用模型子集（providerId → 启用模型 ID 列表；缺省/空 = 未启用任何模型，
     *  可用列表默认空，用户在「增加配置」弹窗中勾选启用） */
    providerModels: Record<string, string[]>;
  };
  scheduler: {
    /** 编排默认执行模式（dispatch 未显式传 mode 时使用；缺省 plan，安全优先） */
    defaultMode: "plan" | "yolo";
  };
}

/** LLM slot 名（与 src/orchestrator/llm-config.ts 的 LlmSlot 字面量一致，admin 包不依赖 src） */
export type LlmSlotName = "planner" | "role" | "reasoning" | "renderer" | "default";

export const LLM_SLOT_NAMES: readonly LlmSlotName[] = [
  "planner",
  "role",
  "reasoning",
  "renderer",
  "default",
];

export interface LlmSlotConfig {
  provider: string;
  model: string;
}

/** 自定义厂商支持 API 种类（pi-ai KnownApi 子集；当前前置 openai-completions 兼容） */
export type CustomProviderApiKind = "openai-completions";

/** 自定义厂商（baseURL + apiKind + 模型来源；apiKey 不落盘，权威存储为 AuthStorage） */
export interface CustomProvider {
  /** 稳定标识（调用方生成，如 name 的 kebab-case） */
  id: string;
  /** 展示名 */
  name: string;
  /** API 端点（如 https://xxx/v1） */
  baseURL: string;
  /** API 种类 */
  apiKind: CustomProviderApiKind;
  /** 手动勾选的模型列表（fetchModels=false 时使用） */
  modelIds: string[];
  /** true 时尝试 GET {baseURL}/models 拉取模型列表 */
  fetchModels: boolean;
}

/** 应用配置更新（深层部分合并；llm.slots 值传 null 表示删除该 slot） */
export interface AppConfigUpdates {
  launcher?: Partial<AppConfig["launcher"]>;
  embedder?: Partial<AppConfig["embedder"]>;
  llm?: {
    slots?: Partial<Record<LlmSlotName, LlmSlotConfig | null>>;
    /** providers 全量替换（null/undefined 表示不变） */
    providers?: CustomProvider[] | null;
    /** providerModels 按键合并（值传 null/undefined 删除该厂商启用子集） */
    providerModels?: Record<string, string[] | null> | null;
  };
  scheduler?: Partial<AppConfig["scheduler"]>;
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
      lastProjectDir: null,
    },
    embedder: {
      model: "Xenova/bge-small-zh-v1.5",
    },
    llm: {
      slots: {},
      providers: [],
      providerModels: {},
    },
    scheduler: {
      defaultMode: "plan",
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
  const rawLlm = (obj.llm ?? {}) as Record<string, unknown>;
  const rawSlots = (rawLlm.slots ?? {}) as AppConfig["llm"]["slots"];
  const rawProviders = (rawLlm.providers ?? []) as AppConfig["llm"]["providers"];
  const rawProviderModels = (rawLlm.providerModels ?? {}) as Record<string, unknown>;
  const providerModels: AppConfig["llm"]["providerModels"] = {};
  for (const [pid, ids] of Object.entries(rawProviderModels)) {
    if (Array.isArray(ids)) providerModels[pid] = ids.map((m) => String(m));
  }
  return {
    // 🟡：读侧兜底——磁盘历史坏值（字符串等）归一为空数组，不再污染 scan
    launcher: {
      ...defaults.launcher,
      ...(obj.launcher ?? {}),
      defaultScanRoots: Array.isArray((obj.launcher as Record<string, unknown> | undefined)?.defaultScanRoots)
        ? ((obj.launcher as Record<string, unknown>).defaultScanRoots as unknown[]).map((r) => String(r))
        : defaults.launcher.defaultScanRoots,
    },
    embedder: { ...defaults.embedder, ...(obj.embedder ?? {}) },
    llm: {
      slots: { ...rawSlots },
      providers: Array.isArray(rawProviders) ? rawProviders : [],
      providerModels,
    },
    scheduler: { ...defaults.scheduler, ...((obj.scheduler ?? {}) as object) },
  };
}

/** 🟠-8（2026-08-08）：读-改-写串行化队列——并发写同一配置文件时防止基于旧值合并丢更新 */
const enqueueWrite = createWriteQueue();

/**
 * 更新应用配置（深层合并已知键，原子写；目录自动创建）
 *
 * 只写 schema 已知键：磁盘文件里的废弃键（如扩展时代的 launcher.piExecutable）
 * 在写入时被剥离；readAppConfig 保持宽松读取不受影响。
 */
export function writeAppConfig(
  updates: AppConfigUpdates,
  configDir?: string,
): Promise<AppConfig> {
  return enqueueWrite(() => writeAppConfigInner(updates, configDir));
}

async function writeAppConfigInner(
  updates: AppConfigUpdates,
  configDir?: string,
): Promise<AppConfig> {
  const filePath = getAppConfigPath(configDir);
  const current = await readAppConfig(configDir);

  // llm.slots：应用更新（null = 删除），只保留已知 slot 名
  const slots: AppConfig["llm"]["slots"] = { ...current.llm.slots };
  if (updates.llm?.slots) {
    for (const [name, value] of Object.entries(updates.llm.slots)) {
      if (!(LLM_SLOT_NAMES as readonly string[]).includes(name)) continue;
      const slotName = name as LlmSlotName;
      if (value === null || value === undefined) delete slots[slotName];
      else slots[slotName] = value;
    }
  }

  // llm.providers：全量替换（null/undefined 表示保留当前）
  const providers: AppConfig["llm"]["providers"] =
    updates.llm && updates.llm.providers !== undefined && updates.llm.providers !== null
      ? updates.llm.providers
      : current.llm.providers;

  // llm.providerModels：按键合并（null/undefined 值 = 删除该厂商启用子集）
  const providerModels: AppConfig["llm"]["providerModels"] = {
    ...current.llm.providerModels,
  };
  if (updates.llm?.providerModels) {
    for (const [pid, ids] of Object.entries(updates.llm.providerModels)) {
      if (ids === null || ids === undefined) delete providerModels[pid];
      else providerModels[pid] = ids.map((m) => String(m));
    }
  }

  const merged: AppConfig = {
    launcher: {
      // 🟡（2026-08-08）：defaultScanRoots 归一化——非数组（如字符串）落盘后
      // scan/meta 的 `.some` 调用恒 500（坏值永续）；写侧归一 + 读侧兜底
      defaultScanRoots: Array.isArray(updates.launcher?.defaultScanRoots)
        ? updates.launcher.defaultScanRoots.map((r) => String(r))
        : current.launcher.defaultScanRoots,
      // lastProjectDir 可置 null，需区分"未提供"与"显式 null"
      lastProjectDir:
        updates.launcher && "lastProjectDir" in updates.launcher
          ? (updates.launcher.lastProjectDir ?? null)
          : current.launcher.lastProjectDir,
    },
    embedder: {
      model: updates.embedder?.model ?? current.embedder.model,
    },
    llm: { slots, providers, providerModels },
    scheduler: {
      defaultMode:
        updates.scheduler?.defaultMode === "yolo"
          ? "yolo"
          : updates.scheduler?.defaultMode === "plan"
            ? "plan"
            : current.scheduler.defaultMode,
    },
  };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(merged, null, 2) + "\n", "utf8");
  await fs.rename(tmp, filePath);
  return merged;
}
