// packages/admin/src/rulesets.ts
/**
 * rulesets.ts — 规则集三件套读写与重置
 *
 * 设计依据：docs/plans/2026-07-29-config-ui-design.md §5.3.3 / §6.3
 *
 * 三件套：
 * - 渲染规则集：规则集.md（@pi/renderer 的 loadRuleSet 读取）
 * - planner 规则集：planner 规则集.md（src/planner-rule-loader.ts 读取）
 * - 角色规则集：角色规则集.md（@pi/role-pool 的 loadRoleRuleSet 读取）
 *
 * 文件位于 <小说工程>/ 根目录，运行时每次调用重读，保存即生效。
 */

import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import { AdminError } from "./types.ts";

// ============================================================================
// 类型与常量
// ============================================================================

/** 规则集名称（前端 tab key） */
export type RulesetName = "render" | "planner" | "role";

/** 规则集内容 */
export interface RulesetContent {
  /** 规则集名称 */
  name: RulesetName;
  /** 文件名（规则集.md / planner 规则集.md / 角色规则集.md） */
  filename: string;
  /** 文件绝对路径 */
  path: string;
  /** 文件是否存在 */
  exists: boolean;
  /** 文件全文（不存在时为空字符串） */
  content: string;
  /** 最后修改时间 ISO 字符串（不存在时为 null） */
  mtime: string | null;
  /** 字符数 */
  charCount: number;
}

/** resetRuleset 选项 */
export interface ResetRulesetOptions {
  /** 小说工程目录绝对路径 */
  novelDir: string;
  /** 模板目录绝对路径（templates/novel/） */
  templatesDir: string;
}

/** 规则集名 → 文件名映射 */
const RULESET_FILES: Record<RulesetName, string> = {
  render: "规则集.md",
  planner: "planner 规则集.md",
  role: "角色规则集.md",
};

/** 规则集列表（顺序固定，前端展示用） */
export const RULESET_NAMES: readonly RulesetName[] = ["render", "planner", "role"];

// ============================================================================
// 内部实现
// ============================================================================

/** 解析规则集文件路径 */
function resolveRulesetPath(novelDir: string, name: RulesetName): string {
  const filename = RULESET_FILES[name];
  if (!filename) {
    throw new AdminError(`未知规则集名: ${name}`, "UNKNOWN_RULESET_NAME");
  }
  return path.join(novelDir, filename);
}

/** 读取单个规则集文件（不存在返回空内容） */
async function _readOne(novelDir: string, name: RulesetName): Promise<RulesetContent> {
  const filePath = resolveRulesetPath(novelDir, name);
  if (!existsSync(filePath)) {
    return {
      name,
      filename: RULESET_FILES[name],
      path: filePath,
      exists: false,
      content: "",
      mtime: null,
      charCount: 0,
    };
  }
  const stat = await fs.stat(filePath);
  const content = await fs.readFile(filePath, "utf8");
  return {
    name,
    filename: RULESET_FILES[name],
    path: filePath,
    exists: true,
    content,
    mtime: stat.mtime.toISOString(),
    charCount: content.length,
  };
}

// ============================================================================
// 公共 API
// ============================================================================

/**
 * 读取三件套全部内容
 *
 * @param novelDir 小说工程目录绝对路径
 */
export async function readAllRulesets(novelDir: string): Promise<RulesetContent[]> {
  return Promise.all(RULESET_NAMES.map((n) => _readOne(novelDir, n)));
}

/**
 * 读取单个规则集
 *
 * @param novelDir 小说工程目录绝对路径
 * @param name 规则集名称
 */
export async function readRuleset(
  novelDir: string,
  name: RulesetName,
): Promise<RulesetContent> {
  return _readOne(novelDir, name);
}

/**
 * 写入单个规则集（原子写）
 *
 * - 文件不存在时创建
 * - 已存在时整体覆盖
 * - 返回写入后的最新内容（含 mtime）
 *
 * @param novelDir 小说工程目录绝对路径
 * @param name 规则集名称
 * @param content 新内容
 */
export async function writeRuleset(
  novelDir: string,
  name: RulesetName,
  content: string,
): Promise<RulesetContent> {
  const filePath = resolveRulesetPath(novelDir, name);
  const tmp = filePath + ".tmp";
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, filePath);
  return _readOne(novelDir, name);
}

/**
 * 从模板重置规则集
 *
 * - 模板文件不存在时抛 AdminError("TEMPLATE_NOT_FOUND")
 * - 覆盖目标文件（不二次确认，二次确认由前端做）
 * - 返回重置后的最新内容
 *
 * @param options.novelDir 小说工程目录绝对路径
 * @param options.templatesDir 模板目录绝对路径（templates/novel/）
 * @param name 规则集名称
 */
export async function resetRuleset(
  options: ResetRulesetOptions,
  name: RulesetName,
): Promise<RulesetContent> {
  const { novelDir, templatesDir } = options;
  const filename = RULESET_FILES[name];
  const templatePath = path.join(templatesDir, filename);
  if (!existsSync(templatePath)) {
    throw new AdminError(
      `模板文件不存在: ${templatePath}`,
      "TEMPLATE_NOT_FOUND",
    );
  }
  const content = await fs.readFile(templatePath, "utf8");
  return writeRuleset(novelDir, name, content);
}
