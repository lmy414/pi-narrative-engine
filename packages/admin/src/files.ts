// packages/admin/src/files.ts
/**
 * files.ts — 小说工程内 markdown 文件的通用读写（文件编辑器后端核心库）
 *
 * 覆盖正文章节、角色设定、世界观文档等任意 .md 文件。
 * 规则集三件套不走本模块（有专门的 rulesets.ts，含模板重置语义）。
 *
 * 设计依据：docs/plans/2026-07-29-app-architecture-design.md §11.3
 *
 * 安全约束（必须保持）：
 * 1. path 一律为工程根相对路径，resolve 后必须在工程根内，
 *    拒绝 ".." 与绝对路径（PATH_ESCAPE）
 * 2. 写/建/删只允许 .md；读允许 .md / .txt / .json（INVALID_EXT）
 * 3. 写入支持 baseMtime 乐观锁：文件当前 mtime 与 baseMtime 不一致时
 *    抛 MTIME_CONFLICT（对应 HTTP 409）
 * 4. 写入原子化（tmp + rename），与 env-store / rulesets 一致
 */

import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import { AdminError } from "./types.ts";

/** 读允许的后缀 */
export const READABLE_EXTS: readonly string[] = [".md", ".txt", ".json"];
/** 写/建/删允许的后缀 */
export const WRITABLE_EXTS: readonly string[] = [".md"];
/** 目录树遍历时跳过的目录名（隐藏目录与依赖目录） */
export const TREE_SKIP_DIRS: readonly string[] = ["node_modules"];

/** 文件树节点（目录或文件） */
export interface FileTreeNode {
  /** 工程根相对路径（posix 风格，/ 分隔） */
  path: string;
  /** 节点类型 */
  kind: "dir" | "file";
  /** 文件大小（字节，目录为 null） */
  size: number | null;
  /** 最后修改时间 ISO 字符串（目录为 null） */
  mtime: string | null;
  /** 子节点（文件为 undefined） */
  children?: FileTreeNode[];
}

/** 文件内容读取/写入结果 */
export interface ProjectFileContent {
  /** 工程根相对路径（posix 风格） */
  path: string;
  /** 文件内容 */
  content: string;
  /** 最后修改时间 ISO 字符串（乐观锁基准） */
  mtime: string;
  /** 文件大小（字节） */
  size: number;
}

// ============================================================================
// 路径安全
// ============================================================================

/**
 * 解析并校验工程内相对路径
 *
 * - 拒绝绝对路径、".." 逃逸、工程根外路径（PATH_ESCAPE）
 * - 返回 { abs, rel }，rel 统一为 posix 风格（前端展示/树节点一致）
 */
export function _resolveSafePath(
  novelDir: string,
  relPath: string,
): { abs: string; rel: string } {
  if (typeof relPath !== "string" || relPath.trim() === "") {
    throw new AdminError("path 不能为空", "MISSING_FIELD");
  }
  if (path.isAbsolute(relPath) || /^[a-zA-Z]:[\\/]/.test(relPath)) {
    throw new AdminError(`不允许绝对路径: ${relPath}`, "PATH_ESCAPE");
  }
  const root = path.resolve(novelDir);
  const abs = path.resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new AdminError(`路径越出工程根: ${relPath}`, "PATH_ESCAPE");
  }
  const rel = path.relative(root, abs).split(path.sep).join("/");
  return { abs, rel };
}

/** 校验后缀是否在允许列表内 */
function _assertExt(rel: string, allowed: readonly string[], op: string): void {
  const ext = path.extname(rel).toLowerCase();
  if (!allowed.includes(ext)) {
    throw new AdminError(
      `${op}只允许 ${allowed.join(" / ")} 文件: ${rel}`,
      "INVALID_EXT",
    );
  }
}

// ============================================================================
// 公共 API
// ============================================================================

/**
 * 列出工程目录树（递归）
 *
 * - 只列目录与 .md 文件
 * - 跳过 node_modules 与以 "." 开头的隐藏目录（.git / .pi 等）
 * - 目录在前、文件在后，各自按名称排序
 */
export async function listFileTree(novelDir: string): Promise<FileTreeNode[]> {
  const root = path.resolve(novelDir);
  if (!existsSync(root)) {
    throw new AdminError(`工程目录不存在: ${root}`, "DIR_NOT_FOUND");
  }

  async function walk(dirAbs: string, relBase: string): Promise<FileTreeNode[]> {
    const entries = await fs.readdir(dirAbs, { withFileTypes: true });
    const dirs: FileTreeNode[] = [];
    const files: FileTreeNode[] = [];
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory()) {
        if ((TREE_SKIP_DIRS as readonly string[]).includes(e.name)) continue;
        const rel = relBase ? `${relBase}/${e.name}` : e.name;
        dirs.push({
          path: rel,
          kind: "dir",
          size: null,
          mtime: null,
          children: await walk(path.join(dirAbs, e.name), rel),
        });
      } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
        const rel = relBase ? `${relBase}/${e.name}` : e.name;
        const st = await fs.stat(path.join(dirAbs, e.name));
        files.push({
          path: rel,
          kind: "file",
          size: st.size,
          mtime: st.mtime.toISOString(),
        });
      }
    }
    const byName = (a: FileTreeNode, b: FileTreeNode): number =>
      a.path.localeCompare(b.path, "zh-CN");
    return [...dirs.sort(byName), ...files.sort(byName)];
  }

  return walk(root, "");
}

/**
 * 读取工程内文件
 *
 * @throws AdminError FILE_NOT_FOUND / NOT_A_FILE / INVALID_EXT / PATH_ESCAPE
 */
export async function readProjectFile(
  novelDir: string,
  relPath: string,
): Promise<ProjectFileContent> {
  const { abs, rel } = _resolveSafePath(novelDir, relPath);
  _assertExt(rel, READABLE_EXTS, "读取");
  if (!existsSync(abs)) {
    throw new AdminError(`文件不存在: ${rel}`, "FILE_NOT_FOUND");
  }
  const st = await fs.stat(abs);
  if (!st.isFile()) {
    throw new AdminError(`不是文件: ${rel}`, "NOT_A_FILE");
  }
  const content = await fs.readFile(abs, "utf8");
  return { path: rel, content, mtime: st.mtime.toISOString(), size: st.size };
}

/**
 * 写入工程内文件（原子写 + 可选乐观锁）
 *
 * - 文件不存在时等同创建（父目录必须已存在，否则抛 DIR_NOT_FOUND；
 *   需要自动建目录请用 createProjectFile）
 * - baseMtime 提供时与当前 mtime 比对，不一致抛 MTIME_CONFLICT
 *
 * @returns 写入后的最新内容（含新 mtime）
 */
export async function writeProjectFile(
  novelDir: string,
  relPath: string,
  content: string,
  baseMtime?: string,
): Promise<ProjectFileContent> {
  const { abs, rel } = _resolveSafePath(novelDir, relPath);
  _assertExt(rel, WRITABLE_EXTS, "写入");
  if (existsSync(abs)) {
    const st = await fs.stat(abs);
    if (!st.isFile()) {
      throw new AdminError(`不是文件: ${rel}`, "NOT_A_FILE");
    }
    if (baseMtime !== undefined && st.mtime.toISOString() !== baseMtime) {
      throw new AdminError(
        `文件已被修改（mtime 不匹配）: ${rel}`,
        "MTIME_CONFLICT",
      );
    }
  } else if (!existsSync(path.dirname(abs))) {
    throw new AdminError(`父目录不存在: ${path.dirname(rel)}`, "DIR_NOT_FOUND");
  }
  const tmp = abs + ".tmp";
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, abs);
  return readProjectFile(novelDir, rel);
}

/**
 * 新建空文件（父目录自动创建）
 *
 * @throws AdminError FILE_EXISTS（已存在时）
 */
export async function createProjectFile(
  novelDir: string,
  relPath: string,
): Promise<ProjectFileContent> {
  const { abs, rel } = _resolveSafePath(novelDir, relPath);
  _assertExt(rel, WRITABLE_EXTS, "新建");
  if (existsSync(abs)) {
    throw new AdminError(`文件已存在: ${rel}`, "FILE_EXISTS");
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, "", "utf8");
  return readProjectFile(novelDir, rel);
}

/**
 * 删除工程内文件
 *
 * @throws AdminError FILE_NOT_FOUND
 */
export async function deleteProjectFile(
  novelDir: string,
  relPath: string,
): Promise<{ path: string }> {
  const { abs, rel } = _resolveSafePath(novelDir, relPath);
  _assertExt(rel, WRITABLE_EXTS, "删除");
  if (!existsSync(abs)) {
    throw new AdminError(`文件不存在: ${rel}`, "FILE_NOT_FOUND");
  }
  const st = await fs.stat(abs);
  if (!st.isFile()) {
    throw new AdminError(`不是文件: ${rel}`, "NOT_A_FILE");
  }
  await fs.unlink(abs);
  return { path: rel };
}
