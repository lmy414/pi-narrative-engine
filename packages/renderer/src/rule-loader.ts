/**
 * rule-loader.ts — 规则集.md 加载
 *
 * 规则集.md 是渲染器的 AGENTS.md：
 * - 纯自由文本 Markdown，原样注入渲染器用户消息末尾
 * - 不预设固定模块名，不按 H2 切分
 * - 每次调用都重读，不缓存（修改即生效）
 */

import { promises as fs } from "node:fs";
import path from "node:path";

/** 规则集文件名（固定，放在 novel 工作目录根） */
const RULE_SET_FILENAME = "规则集.md";

/**
 * 读取规则集.md 全文
 *
 * @param novelCwd novel 工作目录绝对路径
 * @returns 规则集全文；文件不存在时返回空字符串（不报错，让调用方决定如何处理）
 */
export async function loadRuleSet(novelCwd: string): Promise<string> {
  const filePath = path.join(novelCwd, RULE_SET_FILENAME);
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (err: unknown) {
    // 文件不存在时返回空字符串
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return "";
    }
    throw err;
  }
}
