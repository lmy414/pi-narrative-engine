// src/path-guard.ts
/**
 * path-guard.ts — 路径遍历防护（2026-08-03 代码审计 🔴-5）
 *
 * 统一校验"目标路径必须在基准目录内"，供 parseCardFile / import_novel /
 * chapter_write / resolveChapterPath 等接收 LLM 或外部输入路径的入口调用。
 *
 * 判据：resolve 后 path.relative(base, target) 以 ".." 开头或为绝对路径 → 越界。
 */
import { resolve, relative, isAbsolute, sep } from "node:path";

/**
 * 校验 target 是否位于 base 目录内；越界抛错，合法返回规范化绝对路径。
 *
 * @param base 基准目录（项目根 / cwd）
 * @param target 待校验路径（可相对可绝对）
 * @param label 错误信息中的路径语义名（如 "章节文件路径"）
 */
export function assertPathInside(base: string, target: string, label: string): string {
  const abs = isAbsolute(target) ? target : resolve(base, target);
  const rel = relative(resolve(base), abs);
  if (rel !== "" && (rel.startsWith(".." + sep) || rel === ".." || isAbsolute(rel))) {
    const err = new Error(`${label} 越界（不在 ${base} 内）: ${target}`) as Error & { code?: string };
    err.code = "PATH_ESCAPE";
    throw err;
  }
  return abs;
}
