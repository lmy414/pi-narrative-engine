/**
 * rule-loader.ts — 规则集加载（v3 D9 拆分，2026-08-09）
 *
 * 渲染规则集拆分（prompt-research.md §九 D9 + structure-v3 D11）：
 * - `规则集/文风规则.md`（外部可编辑——作者文风内容）→ loadStyleRuleSet
 * - `规则集/检查规则.md`（checker 校验规则）→ loadCheckRuleSet
 * - 格式/禁止/输出契约已随 D9 固化进 `prompts.ts` 的 RENDERER_SYSTEM_PROMPT
 *   （引擎自维护，不再开放外部编辑）
 *
 * 兼容：旧「规则集.md」在文风规则缺失时回退读取（老项目不破坏，迁移后删除）。
 * 每次调用都重读，不缓存（修改即生效）；文件不存在返回空字符串（不报错）。
 */

import { promises as fs } from "node:fs";
import path from "node:path";

/** 规则集文件夹（v3 定案：规则集/ 目录，与 正文/ 笔记/ 等中文目录一致） */
const RULESET_DIR = "规则集";
/** 文风规则文件名（唯一保留的外部编辑面，D9） */
const STYLE_RULE_REL = path.join(RULESET_DIR, "文风规则.md");
/** 检查规则文件名（checker 校验规则） */
const CHECK_RULE_REL = path.join(RULESET_DIR, "检查规则.md");
/** 旧版渲染规则集（v2 兼容回退） */
const LEGACY_RULE_FILENAME = "规则集.md";

async function readRuleFile(novelCwd: string, relPath: string): Promise<string> {
  if (path.isAbsolute(relPath)) {
    throw new Error(`非法规则文件路径（须为相对路径）: ${JSON.stringify(relPath)}`);
  }
  const root = path.resolve(novelCwd);
  const filePath = path.resolve(novelCwd, relPath);
  // 根目录边界校验：解析后必须落在 novelCwd 内（防 `../` 越出项目根；
  // 调用方均为模块内常量，此校验为纵深防御）
  if (filePath !== root && !filePath.startsWith(root + path.sep)) {
    throw new Error(`规则文件越界（须在项目根内）: ${JSON.stringify(filePath)}`);
  }
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (err: unknown) {
    // 文件不存在时返回空字符串（不报错，让调用方决定如何处理）
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return "";
    }
    throw err;
  }
}

/**
 * 读取文风规则全文（规则集/文风规则.md）
 *
 * 兼容回退：新位置不存在且旧「规则集.md」存在时读取旧文件（老项目不破坏）。
 *
 * @param novelCwd novel 工作目录绝对路径
 * @returns 文风规则全文；文件不存在时返回空字符串
 */
export async function loadStyleRuleSet(novelCwd: string): Promise<string> {
  const content = await readRuleFile(novelCwd, STYLE_RULE_REL);
  if (content) return content;
  return readRuleFile(novelCwd, LEGACY_RULE_FILENAME);
}

/**
 * 读取检查规则全文（规则集/检查规则.md，checker 校验用）
 *
 * @param novelCwd novel 工作目录绝对路径
 * @returns 检查规则全文；文件不存在时返回空字符串
 */
export async function loadCheckRuleSet(novelCwd: string): Promise<string> {
  return readRuleFile(novelCwd, CHECK_RULE_REL);
}

/**
 * 读取渲染规则集全文（兼容别名）
 *
 * v3（2026-08-09）：等价 loadStyleRuleSet——渲染器可编辑规则仅剩文风规则。
 * 保留导出名避免旧调用方（工具链/适配器）一次性迁移时遗漏。
 *
 * @param novelCwd novel 工作目录绝对路径
 * @returns 规则集全文；文件不存在时返回空字符串
 */
export async function loadRuleSet(novelCwd: string): Promise<string> {
  return loadStyleRuleSet(novelCwd);
}
