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
import { randomBytes } from "node:crypto";
import path from "node:path";
import { AdminError } from "./types.ts";

/** 读允许的后缀 */
export const READABLE_EXTS: readonly string[] = [".md", ".txt", ".json"];
/** 写/建/删/重命名允许的后缀 */
export const WRITABLE_EXTS: readonly string[] = [".md"];
/** 目录树列出的文件后缀（B8 放宽；.env 以点开头，经文件名特判放行） */
export const TREE_FILE_EXTS: readonly string[] = [".md", ".txt", ".json"];
/** 目录树额外放行的特殊文件名（以点开头但需列出） */
export const TREE_ALLOWED_DOTFILES: readonly string[] = [".env"];
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

/**
 * 🟠-7（2026-08-08）：realpath 二次包含性校验——词法校验防不住符号链接
 * （如 `正文/notes.md → C:\Users\X\.ssh\id_rsa` 即任意文件读取）。
 *
 * 目标存在 → realpath 整个路径；不存在（新建/重命名目标）→ 上溯到最近
 * 存在的祖先目录再 realpath。任一环节解析出工程根外即抛 PATH_ESCAPE。
 */
async function assertNoSymlinkEscape(novelDir: string, abs: string): Promise<void> {
  const root = await fs.realpath(novelDir);
  let probe = abs;
  while (!existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) return; // 上溯到文件系统根仍不存在（理论不可达）
    probe = parent;
  }
  const real = await fs.realpath(probe);
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new AdminError(`路径经符号链接越出工程根: ${abs}`, "PATH_ESCAPE");
  }
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
 * - 列出目录与 .md / .txt / .json 文件，外加特判放行的 .env（B8）
 * - 跳过 node_modules 与以 "." 开头的隐藏目录（.git / .pi 等）；
 *   其他点开头文件（除 .env）同样跳过
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
      if (e.isDirectory()) {
        if (e.name.startsWith(".")) continue;
        if ((TREE_SKIP_DIRS as readonly string[]).includes(e.name)) continue;
        const rel = relBase ? `${relBase}/${e.name}` : e.name;
        dirs.push({
          path: rel,
          kind: "dir",
          size: null,
          mtime: null,
          children: await walk(path.join(dirAbs, e.name), rel),
        });
      } else if (e.isFile() && _isTreeFile(e.name)) {
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

/** 目录树是否列出该文件（后缀匹配或点文件特判） */
function _isTreeFile(name: string): boolean {
  if ((TREE_ALLOWED_DOTFILES as readonly string[]).includes(name.toLowerCase())) return true;
  if (name.startsWith(".")) return false;
  const ext = path.extname(name).toLowerCase();
  return (TREE_FILE_EXTS as readonly string[]).includes(ext);
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
  await assertNoSymlinkEscape(novelDir, abs);
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
  await assertNoSymlinkEscape(novelDir, abs);
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
  } else {
    // 🟡（2026-08-08）：文件不存在时 baseMtime 不再静默忽略——客户端先读到
    // （拿到 baseMtime）后被删除的文件再 write 会静默重建，删除操作被覆盖
    // （乐观锁语义不完整）
    if (baseMtime !== undefined) {
      throw new AdminError(
        `文件已被删除（mtime 冲突）: ${rel}`,
        "MTIME_CONFLICT",
      );
    }
    if (!existsSync(path.dirname(abs))) {
      throw new AdminError(`父目录不存在: ${path.dirname(rel)}`, "DIR_NOT_FOUND");
    }
  }
  const tmp = `${abs}.${randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, abs);
  // H5 附带修复：强制推进 mtime，避免文件系统精度不足（同毫秒写入）
  // 导致乐观锁失效（writeProjectFile 的 baseMtime 比对误判为一致）。
  // 🟠-11（2026-08-08）：按注释语义实现——取 baseMtime+1ms 与 Date.now() 更大者，
  // 保证 mtime 严格单调前进（此前只 new Date()，粗粒度 mtime FS（FAT/SMB）上可能不前进）
  const baseMs = baseMtime !== undefined ? new Date(baseMtime).getTime() : 0;
  const advance = new Date(Math.max(Number.isFinite(baseMs) ? baseMs + 1 : 0, Date.now()));
  await fs.utimes(abs, advance, advance);
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
  await assertNoSymlinkEscape(novelDir, abs);
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
  await assertNoSymlinkEscape(novelDir, abs);
  const st = await fs.stat(abs);
  if (!st.isFile()) {
    throw new AdminError(`不是文件: ${rel}`, "NOT_A_FILE");
  }
  await fs.unlink(abs);
  return { path: rel };
}

/**
 * 重命名/移动工程内文件（B8；同目录改名或跨目录移动均可）
 *
 * - 源与目标都只允许 .md（WRITABLE_EXTS）
 * - 源必须存在（FILE_NOT_FOUND）；目标已存在报错（FILE_EXISTS）
 * - 目标父目录自动创建；路径安全同 _resolveSafePath
 *
 * @returns 目标路径的最新内容（含 mtime）
 */
export async function renameProjectFile(
  novelDir: string,
  oldRel: string,
  newRel: string,
): Promise<ProjectFileContent> {
  const from = _resolveSafePath(novelDir, oldRel);
  const to = _resolveSafePath(novelDir, newRel);
  _assertExt(from.rel, WRITABLE_EXTS, "重命名");
  _assertExt(to.rel, WRITABLE_EXTS, "重命名");
  if (!existsSync(from.abs)) {
    throw new AdminError(`文件不存在: ${from.rel}`, "FILE_NOT_FOUND");
  }
  await assertNoSymlinkEscape(novelDir, from.abs);
  await assertNoSymlinkEscape(novelDir, to.abs);
  const st = await fs.stat(from.abs);
  if (!st.isFile()) {
    throw new AdminError(`不是文件: ${from.rel}`, "NOT_A_FILE");
  }
  if (from.abs === to.abs) {
    throw new AdminError(`源与目标相同: ${from.rel}`, "INVALID_BODY");
  }
  if (existsSync(to.abs)) {
    throw new AdminError(`目标已存在: ${to.rel}`, "FILE_EXISTS");
  }
  await fs.mkdir(path.dirname(to.abs), { recursive: true });
  await fs.rename(from.abs, to.abs);
  return readProjectFile(novelDir, to.rel);
}
