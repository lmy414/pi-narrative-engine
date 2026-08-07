// packages/admin/src/env-store.ts
/**
 * env-store.ts — 扩展专属 .env 文件读写
 *
 * 范围：只管理扩展专属变量（HF_ENDPOINT / PI_DEBUG / PI_EMBEDDER_MODEL），
 * 不存 API Key（API Key 由 auth.json / 环境变量管）。
 *
 * 两个公共函数：
 * - readEnvFile：读取 .env 结构化内容（前端展示用）
 * - writeEnvFile：更新 .env（保留注释与未知字段）
 *
 * 设计依据：docs/plans/2026-07-29-config-ui-design.md §4 / §6.1 / §8.1
 */

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { createWriteQueue } from "./serialize.ts";

// ============================================================================
// 类型与常量
// ============================================================================

/** 扩展专属环境变量名 */
export const EXTENSION_ENV_KEYS = [
  "HF_ENDPOINT",
  "PI_DEBUG",
  "PI_EMBEDDER_MODEL",
] as const;

export type ExtensionEnvKey = (typeof EXTENSION_ENV_KEYS)[number];

/** .env 文件中行的类型 */
type LineType = "comment" | "blank" | "kv" | "unknown";

/** .env 文件中的单行（保留原始文本以便写回） */
interface EnvLine {
  type: LineType;
  /** 原始行内容（不含换行符） */
  raw: string;
  /** kv 行的 key（小写无空格） */
  key?: string;
  /** kv 行的 value（已去引号） */
  value?: string;
}

/** .env 文件结构化内容 */
export interface EnvFileContent {
  /** .env 文件绝对路径 */
  path: string;
  /** 文件是否存在 */
  exists: boolean;
  /** 扩展专属变量的当前值（未设置时缺失该 key） */
  values: Partial<Record<ExtensionEnvKey, string>>;
  /** 文件总行数（含注释与空行） */
  lineCount: number;
}

// ============================================================================
// 解析与序列化
// ============================================================================

/**
 * 把 KEY=VALUE 行的 value 去掉外层引号
 * - `KEY="value"` → `value`
 * - `KEY='value'` → `value`
 * - `KEY=value`   → `value`
 * - `KEY=`        → ``
 */
function unquoteValue(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2) {
    const first = v[0];
    const last = v[v.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return v.slice(1, -1);
    }
  }
  return v;
}

/**
 * 把 value 包装为 .env 安全的字符串
 * - 空字符串写作 `KEY=`
 * - 含空格或 # 的值加双引号
 * - 不转义内部字符（.env 不支持复杂转义）
 */
function quoteValue(value: string): string {
  if (value === "") return "";
  if (/[\s#]/.test(value)) {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return value;
}

/**
 * 解析 .env 文本为行数组
 *
 * 解析规则（保守，不引入 dotenv 依赖）：
 * - 空行 → blank
 * - 以 # 开头 → comment（保留原文本，含前导空格）
 * - 形如 KEY=VALUE → kv（KEY 必须是 [A-Za-z_][A-Za-z0-9_]*）
 * - 其他 → unknown（保留原文本，写回时不修改）
 *
 * 不支持：
 * - 多行字符串（值的换行）
 * - 变量插值（$VAR）
 * - export 前缀
 */
export function _parseEnvContent(content: string): EnvLine[] {
  const lines = content.split(/\r?\n/);
  return lines.map((raw) => {
    const trimmed = raw.trim();
    if (trimmed === "") return { type: "blank" as const, raw };
    if (trimmed.startsWith("#")) return { type: "comment" as const, raw };

    // 匹配 KEY=VALUE
    const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) {
      const key = m[1];
      const value = unquoteValue(m[2]);
      return { type: "kv" as const, raw, key, value };
    }

    return { type: "unknown" as const, raw };
  });
}

/** 序列化行数组回 .env 文本 */
function serializeLines(lines: EnvLine[]): string {
  return lines.map((l) => l.raw).join("\n");
}

// ============================================================================
// 公共 API
// ============================================================================

/**
 * 读取 .env 文件，返回结构化内容
 *
 * - 文件不存在时返回 { exists: false, values: {}, lineCount: 0 }
 * - 仅提取扩展专属变量的值，其他 KEY 行保留原样（不暴露给前端）
 * - 注释与空行计入 lineCount
 *
 * @param envPath .env 文件绝对路径
 */
export async function readEnvFile(envPath: string): Promise<EnvFileContent> {
  if (!existsSync(envPath)) {
    return { path: envPath, exists: false, values: {}, lineCount: 0 };
  }

  const content = await fs.readFile(envPath, "utf8");
  const lines = _parseEnvContent(content);
  const values: Partial<Record<ExtensionEnvKey, string>> = {};

  for (const line of lines) {
    if (line.type === "kv" && line.key) {
      const upperKey = line.key.toUpperCase();
      if ((EXTENSION_ENV_KEYS as readonly string[]).includes(upperKey)) {
        values[upperKey as ExtensionEnvKey] = line.value ?? "";
      }
    }
  }

  return {
    path: envPath,
    exists: true,
    values,
    lineCount: lines.length,
  };
}

/**
 * 更新 .env 文件中的扩展专属变量
 *
 * 行为：
 * - 保留所有注释、空行、未知 KEY 不变
 * - 已存在的扩展 KEY：原地更新 value（保留行内位置）
 * - 不存在的扩展 KEY：追加到文件末尾，带 `# narrative-engine 扩展配置` 分组注释
 * - 传入 undefined 表示删除该 KEY（整行删除）
 * - 文件不存在时创建新文件
 * - 写入是原子操作（写临时文件 + rename），避免并发损坏
 *
 * @param envPath .env 文件绝对路径
 * @param updates 要更新的键值对（value 为 undefined 表示删除）
 */
export function writeEnvFile(
  envPath: string,
  updates: Partial<Record<ExtensionEnvKey, string | undefined>>,
): Promise<EnvFileContent> {
  return enqueueWrite(() => writeEnvFileInner(envPath, updates));
}

async function writeEnvFileInner(
  envPath: string,
  updates: Partial<Record<ExtensionEnvKey, string | undefined>>,
): Promise<EnvFileContent> {
  // 读取现有内容（不存在则空）
  let lines: EnvLine[];
  if (existsSync(envPath)) {
    const content = await fs.readFile(envPath, "utf8");
    lines = _parseEnvContent(content);
  } else {
    lines = [];
  }

  // 标记每个待更新 key 是否已在文件中找到
  const pendingKeys = new Set<string>(Object.keys(updates));
  const extKeySet = new Set<string>(EXTENSION_ENV_KEYS);

  // 第一轮：原地更新已存在的 KEY
  for (const line of lines) {
    if (line.type !== "kv" || !line.key) continue;
    const upperKey = line.key.toUpperCase();
    if (!extKeySet.has(upperKey)) continue;
    if (!pendingKeys.has(upperKey)) continue;

    const newValue = updates[upperKey as ExtensionEnvKey];
    pendingKeys.delete(upperKey);

    if (newValue === undefined) {
      // 标记为删除：把 raw 置空，后续过滤
      line.type = "blank" as LineType;
      line.raw = "";
      delete line.key;
      delete line.value;
    } else {
      line.value = newValue;
      line.raw = `${upperKey}=${quoteValue(newValue)}`;
    }
  }

  // 被删除的 kv 行（上面已把 type 置 blank、raw 置空）在此保留为空行，
  // 以维持行号稳定（避免下游依赖行号/文件 diff 过大）。故这里无需再过滤。

  // 第二轮：追加文件中不存在的 KEY（带分组注释）
  if (pendingKeys.size > 0) {
    // 确保文件末尾有空行分隔
    if (lines.length > 0) {
      const last = lines[lines.length - 1];
      if (last.type !== "blank") {
        lines.push({ type: "blank", raw: "" });
      }
    }
    // 加分组注释（仅当文件原本没有此注释时）
    const hasGroupComment = lines.some(
      (l) => l.type === "comment" && l.raw.includes("narrative-engine"),
    );
    if (!hasGroupComment) {
      lines.push({ type: "comment", raw: "# narrative-engine 扩展配置" });
    }

    for (const key of EXTENSION_ENV_KEYS) {
      if (!pendingKeys.has(key)) continue;
      const value = updates[key];
      if (value === undefined) continue; // 删除且原本不存在 = 什么都不做
      lines.push({ type: "kv", raw: `${key}=${quoteValue(value)}`, key, value });
    }
  }

  // 序列化并原子写入
  const newContent = serializeLines(lines);
  await fs.mkdir(path.dirname(envPath), { recursive: true });
  await _atomicWrite(envPath, newContent);

  // 返回读取后的最新内容
  return readEnvFile(envPath);
}

// ============================================================================
// 内部实现（_ 前缀，软隔离）
// ============================================================================

/** 🟠-8（2026-08-08）：读-改-写串行化队列——并发写同一 .env 时防止基于旧值合并丢更新 */
const enqueueWrite = createWriteQueue();

/**
 * 原子写入文件（写临时文件 + rename）
 *
 * Windows 上 rename 不能覆盖已存在文件，故先写 .tmp 再 rename。
 * 临时文件名与目标同目录（保证同卷，rename 是原子操作）；
 * 后缀带随机串（🟠-8：固定 .tmp 名在并发/跨进程写时会互相踩踏）。
 */
export async function _atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.${randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, filePath);
}
