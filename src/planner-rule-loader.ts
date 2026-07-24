// src/planner-rule-loader.ts
/**
 * planner-rule-loader.ts — planner 规则集.md 加载
 *
 * planner 规则集.md 是调度器内嵌 planner LLM 的 AGENTS.md：
 * - 纯自由文本 Markdown，原样注入 planner LLM system prompt 开头
 * - 不预设固定模块名
 * - 每次调用都重读，不缓存（修改即生效）
 *
 * 与 role-pool/renderer 的 rule-loader 模式一致：
 * - 文件名：planner 规则集.md
 * - 不存在时返回空字符串（不报错）
 */

import { promises as fs } from "node:fs";
import path from "node:path";

const PLANNER_RULE_SET_FILENAME = "planner 规则集.md";

/**
 * 读取 planner 规则集.md 全文
 *
 * @param novelCwd novel 工作目录绝对路径
 * @returns 规则集全文；文件不存在时返回空字符串（不报错）
 */
export async function loadPlannerRuleSet(novelCwd: string): Promise<string> {
  const filePath = path.join(novelCwd, PLANNER_RULE_SET_FILENAME);
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return "";
    }
    throw err;
  }
}
