/**
 * rule-loader.ts — 角色规则集.md 加载
 *
 * 角色规则集.md 是角色池的 AGENTS.md：
 * - 纯自由文本 Markdown，原样注入角色池 system prompt 开头
 * - 不预设固定模块名，不按 H2 切分
 * - 每次调用都重读，不缓存（修改即生效）
 */

import { promises as fs } from "node:fs";
import path from "node:path";

const ROLE_RULE_SET_FILENAME = "角色规则集.md";

/**
 * 读取角色规则集.md 全文
 *
 * @param novelCwd novel 工作目录绝对路径
 * @returns 规则集全文；文件不存在时返回空字符串（不报错）
 */
export async function loadRoleRuleSet(novelCwd: string): Promise<string> {
  const filePath = path.join(novelCwd, ROLE_RULE_SET_FILENAME);
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return "";
    }
    throw err;
  }
}
