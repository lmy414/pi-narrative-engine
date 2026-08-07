// packages/admin/tests/files.test.ts
/**
 * files.ts 测试
 *
 * 覆盖：
 * - _resolveSafePath: 绝对路径/".." 逃逸拒绝、posix 归一化
 * - listFileTree: 递归结构、.md/.txt/.json + 特判 .env、跳过隐藏目录与 node_modules、排序
 * - readProjectFile: 正常读取、.txt/.json 可读、不存在/目录/非法后缀
 * - writeProjectFile: 覆盖写、原子写、baseMtime 乐观锁（匹配/冲突）、
 *   不存在时创建、父目录缺失报错、非法后缀
 * - createProjectFile: 新建（父目录自动创建）、已存在报错
 * - deleteProjectFile: 正常删除、不存在报错、非法后缀
 * - renameProjectFile: 同目录改名、跨目录移动、目标已存在/非法后缀/越界
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  listFileTree,
  readProjectFile,
  writeProjectFile,
  createProjectFile,
  deleteProjectFile,
  renameProjectFile,
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
  await writeFile(join(dir, "notes.json"), "{}\n", "utf8");
  await writeFile(join(dir, ".env"), "HF_ENDPOINT=x\n", "utf8");
  await writeFile(join(dir, ".gitignore"), "*.log\n", "utf8");
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

test("listFileTree: 递归列出 .md/.txt/.json + 特判 .env，跳过隐藏目录与 node_modules", async () => {
  const tree = await listFileTree(dir);
  const paths = (nodes: typeof tree): string[] =>
    nodes.flatMap((n) => [n.path, ...(n.children ? paths(n.children) : [])]);
  const all = paths(tree);
  assert.ok(all.includes("正文/ch001.md"));
  assert.ok(all.includes("正文/ch002.md"));
  assert.ok(all.includes("设定/角色/主角.md"));
  assert.ok(all.includes("README.txt"), "B8：.txt 应列入树");
  assert.ok(all.includes("notes.json"), "B8：.json 应列入树");
  assert.ok(all.includes(".env"), "B8：.env 特判放行");
  assert.ok(!all.includes(".gitignore"), "其他点开头文件仍跳过");
  assert.ok(!all.some((p) => p.includes(".pi")), "隐藏目录应跳过");
  assert.ok(!all.some((p) => p.includes("node_modules")), "node_modules 应跳过");
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

// ============ renameProjectFile ============

test("renameProjectFile: 同目录改名", async () => {
  await writeFile(join(dir, "正文", "rn-a.md"), "# 改名测试\n", "utf8");
  const r = await renameProjectFile(dir, "正文/rn-a.md", "正文/rn-b.md");
  assert.equal(r.path, "正文/rn-b.md");
  assert.ok(!existsSync(join(dir, "正文", "rn-a.md")), "源文件已移走");
  assert.equal(await readFile(join(dir, "正文", "rn-b.md"), "utf8"), "# 改名测试\n");
  await rm(join(dir, "正文", "rn-b.md"));
});

test("renameProjectFile: 跨目录移动（目标父目录自动创建）", async () => {
  await writeFile(join(dir, "正文", "rn-move.md"), "# 移动\n", "utf8");
  const r = await renameProjectFile(dir, "正文/rn-move.md", "设定/新目录/rn-move.md");
  assert.equal(r.path, "设定/新目录/rn-move.md");
  assert.ok(existsSync(join(dir, "设定", "新目录", "rn-move.md")));
  await rm(join(dir, "设定", "新目录"), { recursive: true, force: true });
});

test("renameProjectFile: 目标已存在报 FILE_EXISTS", async () => {
  await writeFile(join(dir, "正文", "rn-src.md"), "a\n", "utf8");
  await writeFile(join(dir, "正文", "rn-dst.md"), "b\n", "utf8");
  await assert.rejects(renameProjectFile(dir, "正文/rn-src.md", "正文/rn-dst.md"), (e) => {
    assertAdminError(e, "FILE_EXISTS");
    return true;
  });
  await rm(join(dir, "正文", "rn-src.md"));
  await rm(join(dir, "正文", "rn-dst.md"));
});

test("renameProjectFile: 源不存在报 FILE_NOT_FOUND；非 .md 拒绝；越界拒绝", async () => {
  await assert.rejects(renameProjectFile(dir, "正文/不存在.md", "正文/x.md"), (e) => {
    assertAdminError(e, "FILE_NOT_FOUND");
    return true;
  });
  await assert.rejects(renameProjectFile(dir, "README.txt", "README2.md"), (e) => {
    assertAdminError(e, "INVALID_EXT");
    return true;
  });
  await assert.rejects(renameProjectFile(dir, "正文/ch001.md", "../逃逸.md"), (e) => {
    assertAdminError(e, "PATH_ESCAPE");
    return true;
  });
});

// ============================================================================
// 符号链接越界（🟠-7 2026-08-08）
// ============================================================================

test("readProjectFile: 符号链接指向工程根外拒绝（🟠-7）", async (t) => {
  const dir2 = await mkdtemp(join(tmpdir(), "admin-files-"));
  try {
    await mkdir(join(dir2, "正文"), { recursive: true });
    // 外部敏感文件 + 指向它的符号链接
    const outside = join(tmpdir(), "admin-files-outside-secret.md");
    await writeFile(outside, "secret", "utf8");
    const linkAbs = join(dir2, "正文", "link.md");
    try {
      await symlink(outside, linkAbs);
    } catch {
      // Windows 非开发者模式/无权限时无法创建符号链接——跳过本用例
      t.skip("当前环境无法创建符号链接（可能需要管理员/开发者模式）");
      return;
    }
    await assert.rejects(readProjectFile(dir2, "正文/link.md"), (e) => {
      assertAdminError(e, "PATH_ESCAPE");
      return true;
    });
    await rm(outside, { force: true });
  } finally {
    await rm(dir2, { recursive: true, force: true });
  }
});

test("writeProjectFile: 符号链接指向工程根外拒绝（🟠-7）", async (t) => {
  const dir2 = await mkdtemp(join(tmpdir(), "admin-files-"));
  try {
    await mkdir(join(dir2, "正文"), { recursive: true });
    const outside = join(tmpdir(), "admin-files-outside-secret2.md");
    await writeFile(outside, "secret", "utf8");
    const linkAbs = join(dir2, "正文", "link2.md");
    try {
      await symlink(outside, linkAbs);
    } catch {
      t.skip("当前环境无法创建符号链接（可能需要管理员/开发者模式）");
      return;
    }
    await assert.rejects(writeProjectFile(dir2, "正文/link2.md", "覆盖内容"), (e) => {
      assertAdminError(e, "PATH_ESCAPE");
      return true;
    });
    await rm(outside, { force: true });
  } finally {
    await rm(dir2, { recursive: true, force: true });
  }
});

// ============================================================================
// 并发写（🟠-8 2026-08-08）
// ============================================================================

test("writeProjectFile: 并发写不同文件互不干扰 + 无 .tmp 残留", async () => {
  const dir2 = await mkdtemp(join(tmpdir(), "admin-files-"));
  try {
    await mkdir(join(dir2, "正文"), { recursive: true });
    await Promise.all([
      writeProjectFile(dir2, "正文/a.md", "AAA"),
      writeProjectFile(dir2, "正文/b.md", "BBB"),
      writeProjectFile(dir2, "正文/c.md", "CCC"),
    ]);
    assert.equal((await readFile(join(dir2, "正文/a.md"), "utf8")).trim(), "AAA");
    assert.equal((await readFile(join(dir2, "正文/b.md"), "utf8")).trim(), "BBB");
    assert.equal((await readFile(join(dir2, "正文/c.md"), "utf8")).trim(), "CCC");
    const leftover = (await readdir(join(dir2, "正文"))).filter((f) => f.includes(".tmp"));
    assert.deepEqual(leftover, [], `不应有 .tmp 残留: ${leftover.join(",")}`);
  } finally {
    await rm(dir2, { recursive: true, force: true });
  }
});
