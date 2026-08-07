// packages/admin/src/novel-json.ts
/**
 * novel-json.ts — novel.json 读写
 *
 * novel.json 是小说项目清单文件，位于 <小说工程>/novel.json。
 * 设计依据：docs/plans/2026-07-29-config-ui-design.md §6.6 / §5.3.6
 *
 * 字段与 @pi/novel-launcher 的 NovelProjectMeta 对齐（同源），但本包不依赖
 * novel-launcher（避免子包互相耦合），独立定义同结构类型。
 */

import { promises as fs, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { AdminError } from "./types.ts";
import { createWriteQueue } from "./serialize.ts";

// ============================================================================
// 类型与默认值
// ============================================================================

/** novel.json 结构 */
export interface NovelJson {
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
  /** 允许未知扩展字段（前端可能新增） */
  [key: string]: unknown;
}

/** 读取结果 */
export interface NovelJsonReadResult {
  /** 文件绝对路径 */
  path: string;
  /** 文件是否存在 */
  exists: boolean;
  /** 文件内容（exists=false 时为 null） */
  data: NovelJson | null;
}

/** 默认值（与 templates/novel/novel.json / @pi/novel-launcher 对齐） */
const DEFAULTS: Omit<NovelJson, "name" | "createdAt"> = {
  engine: "narrative-engine",
  engineVersion: "0.1.0",
  worldGraphDir: ".pi/world-graph-v3",
  chaptersDir: "正文",
  storyTimeFormat: "ch{NNN}.ev{NNN}",
};

const NOVEL_JSON_FILENAME = "novel.json";

// ============================================================================
// 内部实现
// ============================================================================

/**
 * 把解析后的 Record 填充默认值并校验基本类型
 * - name 缺失时回退到目录 basename
 * - 各字段类型不匹配时回退到默认值
 */
export function _normalizeNovelJson(
  raw: Record<string, unknown>,
  projectDir: string,
): NovelJson {
  const name =
    typeof raw.name === "string" && raw.name ? raw.name : path.basename(projectDir);
  const pick = (key: keyof typeof DEFAULTS, type: "string"): string => {
    const v = raw[key];
    // 🟡：DEFAULTS 经 Omit 后索引访问返回 unknown，显式断言 string
    return typeof v === type ? (v as string) : (DEFAULTS[key] as string);
  };
  return {
    // 保留未知字段（前端可能扩展）
    ...raw,
    // 显式 normalize 后的字段放在展开之后，覆盖 raw 中的同名键
    name,
    engine: pick("engine", "string"),
    engineVersion: pick("engineVersion", "string"),
    worldGraphDir: pick("worldGraphDir", "string"),
    chaptersDir: pick("chaptersDir", "string"),
    storyTimeFormat: pick("storyTimeFormat", "string"),
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
  };
}

// ============================================================================
// 公共 API
// ============================================================================

/**
 * 读取 novel.json
 *
 * - 文件不存在时返回 { exists: false, data: null }（不抛错）
 * - JSON 解析失败抛 AdminError("INVALID_NOVEL_JSON")
 * - 缺失字段填默认值
 *
 * @param novelDir 小说工程目录绝对路径
 */
export async function readNovelJson(novelDir: string): Promise<NovelJsonReadResult> {
  const filePath = path.join(novelDir, NOVEL_JSON_FILENAME);
  if (!existsSync(filePath)) {
    return { path: filePath, exists: false, data: null };
  }
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    throw new AdminError(
      `novel.json 读取失败: ${(err as Error).message}`,
      "NOVEL_JSON_READ_FAILED",
    );
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AdminError(`novel.json 解析失败: ${filePath}`, "INVALID_NOVEL_JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AdminError(
      `novel.json 顶层应为对象: ${filePath}`,
      "INVALID_NOVEL_JSON",
    );
  }
  return {
    path: filePath,
    exists: true,
    data: _normalizeNovelJson(parsed, novelDir),
  };
}

/** 🟠-8（2026-08-08）：读-改-写串行化队列——并发写同一 novel.json 时防止基于旧值合并丢更新 */
const enqueueWrite = createWriteQueue();

/**
 * 更新 novel.json（合并写）
 *
 * - 文件不存在时创建新文件（name 缺失用目录 basename）
 * - 已存在时：浅合并（updates 覆盖顶层字段）
 * - 原子写入（写临时文件 + rename）
 *
 * @param novelDir 小说工程目录绝对路径
 * @param updates 要更新的字段
 * @returns 合并后的完整内容
 */
export function writeNovelJson(
  novelDir: string,
  updates: Partial<NovelJson>,
): Promise<NovelJson> {
  return enqueueWrite(() => writeNovelJsonInner(novelDir, updates));
}

async function writeNovelJsonInner(
  novelDir: string,
  updates: Partial<NovelJson>,
): Promise<NovelJson> {
  const filePath = path.join(novelDir, NOVEL_JSON_FILENAME);
  let current: NovelJson;
  if (existsSync(filePath)) {
    const result = await readNovelJson(novelDir);
    current = result.data!;
  } else {
    current = _normalizeNovelJson({}, novelDir);
  }
  const merged: NovelJson = { ...current, ...updates };
  // 原子写入（🟠-8：tmp 名带随机后缀，避免并发/跨进程踩踏）
  const tmp = `${filePath}.${randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(merged, null, 2) + "\n", "utf8");
  await fs.rename(tmp, filePath);
  return merged;
}
