// packages/admin/tests/files.test.ts
/**
 * files.ts 测试
 *
 * 覆盖：
 * - _resolveSafePath: 绝对路径/".." 逃逸拒绝、posix 归一化
 * - listFileTree: 递归结构、只列 .md、跳过隐藏目录与 node_modules、排序
 * - readProjectFile: 正常读取、.txt/.json 可读、不存在/目录/非法后缀
 * - writeProjectFile: 覆盖写、原子写、baseMtime 乐观锁（匹配/冲突）、
 *   不存在时创建、父目录缺失报错、非法后缀
 * - createProjectFile: 新建（父目录自动创建）、已存在报错
 * - deleteProjectFile: 正常删除、不存在报错、非法后缀
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  listFileTree,
  readProjectFile,
  writeProjectFile,
  createProjectFile,
  deleteProjectFile,
  _resolveSafePath,
  AdminError,
} from "../src/index.ts";

let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "admin-files-"));
  await mkdir(join(dir, "正文"), { recursive: true });
  await mkdir(join(dir, "设定", "角色"), { recursive: true });
  await writeFile(join(dir, "正文", "ch001.md"), "# 第一章\n", "utf8");
  await writeFile(join(dir, "正文", "ch002.md"), "# 第二章\n", "utf8");
  await writeFile(join(dir, "设定", "角色", "主角.md"), "# 主角设定\n", "utf8");
  await writeFile(join(dir, "README.txt"), "readme\n", "utf8");
  await mkdir(join(dir, ".pi"), { recursive: true });
  await writeFile(join(dir, ".pi", "hidden.md"), "hidden\n", "utf8");
  await mkdir(join(dir, "node_modules", "dep"), { recursive: true });
  await writeFile(join(dir, "node_modules", "dep", "x.md"), "dep\n", "utf8");
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

function assertAdminError(err: unknown, code: string): void {
  assert.ok(err instanceof AdminError, `期望 AdminError，实际 ${err}`);
  assert.equal((err as AdminError).code, code);
}

// ============ _resolveSafePath ============

test("_resolveSafePath: 正常相对路径归一化为 posix", () => {
  const { rel } = _resolveSafePath(dir, "正文/ch001.md");
  assert.equal(rel, "正文/ch001.md");
});

test("_resolveSafePath: 拒绝绝对路径", () => {
  assert.throws(() => _resolveSafePath(dir, "/etc/passwd"), (e) => {
    assertAdminError(e, "PATH_ESCAPE");
    return true;
  });
  assert.throws(() => _resolveSafePath(dir, "C:\\Windows\\x.md"), (e) => {
    assertAdminError(e, "PATH_ESCAPE");
    return true;
  });
});

test("_resolveSafePath: 拒绝 .. 逃逸", () => {
  assert.throws(() => _resolveSafePath(dir, "../outside.md"), (e) => {
    assertAdminError(e, "PATH_ESCAPE");
    return true;
  });
  assert.throws(() => _resolveSafePath(dir, "正文/../../outside.md"), (e) => {
    assertAdminError(e, "PATH_ESCAPE");
    return true;
  });
});

test("_resolveSafePath: 空路径报 MISSING_FIELD", () => {
  assert.throws(() => _resolveSafePath(dir, "  "), (e) => {
    assertAdminError(e, "MISSING_FIELD");
    return true;
  });
});

// ============ listFileTree ============

test("listFileTree: 递归列出 .md，跳过隐藏目录与 node_modules", async () => {
  const tree = await listFileTree(dir);
  const paths = (nodes: typeof tree): string[] =>
    nodes.flatMap((n) => [n.path, ...(n.children ? paths(n.children) : [])]);
  const all = paths(tree);
  assert.ok(all.includes("正文/ch001.md"));
  assert.ok(all.includes("正文/ch002.md"));
  assert.ok(all.includes("设定/角色/主角.md"));
  assert.ok(!all.some((p) => p.includes(".pi")), "隐藏目录应跳过");
  assert.ok(!all.some((p) => p.includes("node_modules")), "node_modules 应跳过");
  assert.ok(!all.includes("README.txt"), "非 .md 文件不列入树");
});

test("listFileTree: 目录在前、文件在后", async () => {
  const tree = await listFileTree(dir);
  const kinds = tree.map((n) => n.kind);
  const firstFile = kinds.indexOf("file");
  const lastDir = kinds.lastIndexOf("dir");
  assert.ok(lastDir < firstFile || firstFile === -1, "目录应排在文件前");
});

test("listFileTree: 工程目录不存在报 DIR_NOT_FOUND", async () => {
  await assert.rejects(listFileTree(join(dir, "不存在")), (e) => {
    assertAdminError(e, "DIR_NOT_FOUND");
    return true;
  });
});

// ============ readProjectFile ============

test("readProjectFile: 正常读取返回内容+mtime+size", async () => {
  const f = await readProjectFile(dir, "正文/ch001.md");
  assert.equal(f.path, "正文/ch001.md");
  assert.equal(f.content, "# 第一章\n");
  assert.ok(f.mtime.includes("T"), "mtime 应为 ISO 字符串");
  assert.ok(f.size > 0);
});

test("readProjectFile: .txt 可读（写不行，读放宽）", async () => {
  const f = await readProjectFile(dir, "README.txt");
  assert.equal(f.content, "readme\n");
});

test("readProjectFile: 不存在 / 目录 / 非法后缀", async () => {
  await assert.rejects(readProjectFile(dir, "正文/none.md"), (e) => {
    assertAdminError(e, "FILE_NOT_FOUND");
    return true;
  });
  await mkdir(join(dir, "目录.md"), { recursive: true });
  await assert.rejects(readProjectFile(dir, "目录.md"), (e) => {
    assertAdminError(e, "NOT_A_FILE");
    return true;
  });
  await assert.rejects(readProjectFile(dir, "x.exe"), (e) => {
    assertAdminError(e, "INVALID_EXT");
    return true;
  });
});

// ============ writeProjectFile ============

test("writeProjectFile: 覆盖写并返回新 mtime", async () => {
  const before1 = await readProjectFile(dir, "正文/ch002.md");
  const written = await writeProjectFile(dir, "正文/ch002.md", "# 第二章（改）\n");
  assert.equal(written.content, "# 第二章（改）\n");
  assert.equal(await readFile(join(dir, "正文", "ch002.md"), "utf8"), "# 第二章（改）\n");
  assert.ok(!existsSync(join(dir, "正文", "ch002.md.tmp")), "临时文件应已 rename");
  void before1;
});

test("writeProjectFile: baseMtime 匹配成功 / 不匹配抛 MTIME_CONFLICT", async () => {
  const cur = await readProjectFile(dir, "正文/ch002.md");
  const next = await writeProjectFile(dir, "正文/ch002.md", "v3\n", cur.mtime);
  assert.equal(next.content, "v3\n");
  // 用旧 mtime 再写 → 冲突
  await assert.rejects(
    writeProjectFile(dir, "正文/ch002.md", "v4\n", cur.mtime),
    (e) => {
      assertAdminError(e, "MTIME_CONFLICT");
      return true;
    },
  );
});

test("writeProjectFile: 文件不存在时创建（父目录须已存在）", async () => {
  const f = await writeProjectFile(dir, "正文/ch003.md", "# 第三章\n");
  assert.equal(f.content, "# 第三章\n");
  await assert.rejects(
    writeProjectFile(dir, "不存在的目录/x.md", "x\n"),
    (e) => {
      assertAdminError(e, "DIR_NOT_FOUND");
      return true;
    },
  );
});

test("writeProjectFile: 非 .md 拒绝写入", async () => {
  await assert.rejects(writeProjectFile(dir, "README.txt", "x"), (e) => {
    assertAdminError(e, "INVALID_EXT");
    return true;
  });
});

// ============ createProjectFile ============

test("createProjectFile: 新建空文件并自动创建父目录", async () => {
  const f = await createProjectFile(dir, "设定/地点/客栈.md");
  assert.equal(f.content, "");
  assert.ok(existsSync(join(dir, "设定", "地点", "客栈.md")));
});

test("createProjectFile: 已存在报 FILE_EXISTS", async () => {
  await assert.rejects(createProjectFile(dir, "正文/ch001.md"), (e) => {
    assertAdminError(e, "FILE_EXISTS");
    return true;
  });
});

// ============ deleteProjectFile ============

test("deleteProjectFile: 正常删除 / 不存在报错", async () => {
  const r = await deleteProjectFile(dir, "正文/ch003.md");
  assert.equal(r.path, "正文/ch003.md");
  assert.ok(!existsSync(join(dir, "正文", "ch003.md")));
  await assert.rejects(deleteProjectFile(dir, "正文/ch003.md"), (e) => {
    assertAdminError(e, "FILE_NOT_FOUND");
    return true;
  });
});

test("deleteProjectFile: 非 .md 拒绝删除", async () => {
  await assert.rejects(deleteProjectFile(dir, "README.txt"), (e) => {
    assertAdminError(e, "INVALID_EXT");
    return true;
  });
});
