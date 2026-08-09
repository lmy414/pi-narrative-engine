// packages/novel-launcher/tests/project.test.ts
/**
 * project.ts 测试：
 * - _resolveScript 纯函数直接测
 * - createProject / openInFileManager 通过替换 project._internals.{spawn,spawnSync} 拦截
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import type { ChildProcess, SpawnOptions } from "node:child_process";

interface SpawnCall {
  command: string;
  args: string[];
  options: SpawnOptions;
}

function makeFakeChild(pid: number): ChildProcess {
  return {
    pid,
    on: () => {},
    unref: () => {},
  } as unknown as ChildProcess;
}

type ProjectInternals = typeof import("../src/project.ts")._internals;

let savedProject: ProjectInternals;

beforeEach(async () => {
  const proj = await import("../src/project.ts");
  savedProject = { ...proj._internals };
});

afterEach(async () => {
  const proj = await import("../src/project.ts");
  proj._internals.spawn = savedProject.spawn;
  proj._internals.spawnSync = savedProject.spawnSync;
});

test("_resolveScript 返回仓库内 scripts/<name> 绝对路径", async () => {
  const { _resolveScript } = await import("../src/project.ts");
  const p = _resolveScript("init-novel.mjs");
  assert.ok(p.includes(`${sep}scripts${sep}`));
  assert.ok(p.endsWith("init-novel.mjs"));
  assert.equal(resolve(p), p);
});

test("_resolveScript 不同脚本名都能解析", async () => {
  const { _resolveScript } = await import("../src/project.ts");
  const a = _resolveScript("init-novel.mjs");
  const b = _resolveScript("visualizer.mjs");
  assert.ok(a.endsWith("init-novel.mjs"));
  assert.ok(b.endsWith("visualizer.mjs"));
  const dirA = a.slice(0, a.lastIndexOf(sep));
  const dirB = b.slice(0, b.lastIndexOf(sep));
  assert.equal(dirA, dirB);
});

/** 造最小模板目录（六件套，含变量占位） */
async function makeTemplates(root: string): Promise<string> {
  const dir = join(root, "templates");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "小说.json"), JSON.stringify({ name: "{{name}}", createdAt: "{{date}}" }), "utf8");
  await writeFile(join(dir, "规则集.md"), "# 规则 {{name}}\n", "utf8");
  await writeFile(join(dir, "planner 规则集.md"), "# planner\n", "utf8");
  await writeFile(join(dir, "角色规则集.md"), "# 角色\n", "utf8");
  await writeFile(join(dir, "_gitignore"), ".env\n", "utf8");
  await writeFile(join(dir, "README.md"), "# {{name}}\n", "utf8");
  return dir;
}

test("createProject: 内联创建目录骨架与模板六件套（变量替换）", async () => {
  const proj = await import("../src/project.ts");
  const root = await mkdtemp(join(tmpdir(), "novel-launcher-"));
  try {
    const templatesDir = await makeTemplates(root);
    const dir = join(root, "new-project");
    const result = await proj.createProject(dir, { name: "新项目", templatesDir });
    assert.equal(result.dir, resolve(dir));
    const { existsSync } = await import("node:fs");
    const { readFile } = await import("node:fs/promises");
    // 目录骨架
    assert.ok(existsSync(join(dir, "正文", ".gitkeep")));
    assert.ok(existsSync(join(dir, ".pi", "world-graph-v3", ".gitkeep")));
    // 模板六件套
    for (const f of ["小说.json", "规则集.md", "planner 规则集.md", "角色规则集.md", ".gitignore", "README.md"]) {
      assert.ok(existsSync(join(dir, f)), `缺少 ${f}`);
    }
    // 变量替换
    const novelJson = JSON.parse(await readFile(join(dir, "小说.json"), "utf8"));
    assert.equal(novelJson.name, "新项目");
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(novelJson.createdAt));
    assert.ok((await readFile(join(dir, "README.md"), "utf8")).includes("新项目"));
    // 不再同步项目级扩展
    assert.ok(!existsSync(join(dir, ".pi", "extensions", "narrative-engine")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createProject: 幂等不覆盖，force 才覆盖", async () => {
  const proj = await import("../src/project.ts");
  const root = await mkdtemp(join(tmpdir(), "novel-launcher-"));
  try {
    const templatesDir = await makeTemplates(root);
    const dir = join(root, "p");
    await proj.createProject(dir, { name: "甲", templatesDir });
    const { writeFile: wf, readFile: rf } = await import("node:fs/promises");
    await wf(join(dir, "README.md"), "手写内容\n", "utf8");
    // 未 force：保留手写内容
    await proj.createProject(dir, { name: "乙", templatesDir });
    assert.equal(await rf(join(dir, "README.md"), "utf8"), "手写内容\n");
    // force：模板覆盖
    await proj.createProject(dir, { name: "丙", force: true, templatesDir });
    assert.ok((await rf(join(dir, "README.md"), "utf8")).includes("丙"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createProject: 模板目录不存在抛 TEMPLATE_NOT_FOUND", async () => {
  const proj = await import("../src/project.ts");
  const { NovelLauncherError } = await import("../src/types.ts");
  const root = await mkdtemp(join(tmpdir(), "novel-launcher-"));
  try {
    await assert.rejects(
      () => proj.createProject(join(root, "p"), { templatesDir: join(root, "不存在") }),
      (err: Error) =>
        err instanceof NovelLauncherError && err.code === "TEMPLATE_NOT_FOUND",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("openInFileManager 调用系统文件管理器并 detached", async () => {
  const proj = await import("../src/project.ts");
  const spawnCalls: SpawnCall[] = [];
  proj._internals.spawn = ((
    command: string,
    args: string[],
    options: SpawnOptions,
  ) => {
    spawnCalls.push({ command, args, options });
    return makeFakeChild(88888);
  }) as typeof proj._internals.spawn;

  const root = await mkdtemp(join(tmpdir(), "novel-launcher-"));
  try {
    await proj.openInFileManager(root);
    assert.equal(spawnCalls.length, 1);
    const platform = process.platform;
    if (platform === "win32") {
      assert.equal(spawnCalls[0].command, "explorer.exe");
    } else if (platform === "darwin") {
      assert.equal(spawnCalls[0].command, "open");
    } else {
      assert.equal(spawnCalls[0].command, "xdg-open");
    }
    assert.ok(spawnCalls[0].args.includes(resolve(root)));
    assert.equal(spawnCalls[0].options.detached, true);
    assert.equal(spawnCalls[0].options.stdio, "ignore");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
