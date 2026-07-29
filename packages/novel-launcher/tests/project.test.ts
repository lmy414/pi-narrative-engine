// packages/novel-launcher/tests/project.test.ts
/**
 * project.ts 测试：
 * - _resolveScript 纯函数直接测
 * - createProject / openInFileManager 通过替换 project._internals.{spawn,spawnSync} 拦截
 * - launchVisualizer 通过替换 launch._internals.spawn 拦截（它复用 _spawnNewTerminal）
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import type { ChildProcess, SpawnOptions, SpawnSyncReturns } from "node:child_process";

interface SpawnCall {
  command: string;
  args: string[];
  options: SpawnOptions;
}

interface SpawnSyncCall {
  command: string;
  args: string[];
  options: Record<string, unknown>;
}

function makeFakeChild(pid: number): ChildProcess {
  return {
    pid,
    on: () => {},
    unref: () => {},
  } as unknown as ChildProcess;
}

type ProjectInternals = typeof import("../src/project.ts")._internals;
type LaunchInternals = typeof import("../src/launch.ts")._internals;

let savedProject: ProjectInternals;
let savedLaunch: LaunchInternals;

beforeEach(async () => {
  const proj = await import("../src/project.ts");
  const lau = await import("../src/launch.ts");
  savedProject = { ...proj._internals };
  savedLaunch = { ...lau._internals };
});

afterEach(async () => {
  const proj = await import("../src/project.ts");
  const lau = await import("../src/launch.ts");
  proj._internals.spawn = savedProject.spawn;
  proj._internals.spawnSync = savedProject.spawnSync;
  lau._internals.spawn = savedLaunch.spawn;
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

test("createProject 调用 init-novel.mjs 并透传参数", async () => {
  const proj = await import("../src/project.ts");
  const syncCalls: SpawnSyncCall[] = [];
  proj._internals.spawnSync = ((
    command: string,
    args: string[],
    options: Record<string, unknown>,
  ) => {
    syncCalls.push({ command, args, options });
    return { status: 0 } as SpawnSyncReturns<Buffer>;
  }) as typeof proj._internals.spawnSync;

  const root = await mkdtemp(join(tmpdir(), "novel-launcher-"));
  try {
    const dir = join(root, "new-project");
    const result = await proj.createProject(dir, {
      name: "新项目",
      skipExtension: true,
    });
    assert.equal(result.dir, resolve(dir));
    assert.equal(syncCalls.length, 1);
    assert.ok(syncCalls[0].args[0].endsWith("init-novel.mjs"));
    assert.ok(syncCalls[0].args.includes(resolve(dir)));
    assert.ok(syncCalls[0].args.includes("--name"));
    assert.ok(syncCalls[0].args.includes("新项目"));
    assert.ok(syncCalls[0].args.includes("--skip-extension"));
    assert.equal(syncCalls[0].options.stdio, "inherit");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createProject --force 透传", async () => {
  const proj = await import("../src/project.ts");
  const syncCalls: SpawnSyncCall[] = [];
  proj._internals.spawnSync = ((
    command: string,
    args: string[],
    options: Record<string, unknown>,
  ) => {
    syncCalls.push({ command, args, options });
    return { status: 0 } as SpawnSyncReturns<Buffer>;
  }) as typeof proj._internals.spawnSync;

  const root = await mkdtemp(join(tmpdir(), "novel-launcher-"));
  try {
    const dir = join(root, "p");
    await proj.createProject(dir, { force: true });
    assert.ok(syncCalls[0].args.includes("--force"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createProject 退出码非 0 抛 CREATE_FAILED", async () => {
  const proj = await import("../src/project.ts");
  proj._internals.spawnSync = (() =>
    ({ status: 2 }) as unknown as SpawnSyncReturns<Buffer>) as unknown as typeof proj._internals.spawnSync;

  const { NovelLauncherError } = await import("../src/types.ts");
  const root = await mkdtemp(join(tmpdir(), "novel-launcher-"));
  try {
    await assert.rejects(
      () => proj.createProject(join(root, "p")),
      (err: Error) =>
        err instanceof NovelLauncherError && err.code === "CREATE_FAILED",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createProject spawnSync null status 视为失败", async () => {
  const proj = await import("../src/project.ts");
  proj._internals.spawnSync = (() =>
    ({ status: null }) as unknown as SpawnSyncReturns<Buffer>) as unknown as typeof proj._internals.spawnSync;

  const { NovelLauncherError } = await import("../src/types.ts");
  const root = await mkdtemp(join(tmpdir(), "novel-launcher-"));
  try {
    await assert.rejects(
      () => proj.createProject(join(root, "p")),
      (err: Error) =>
        err instanceof NovelLauncherError && err.code === "CREATE_FAILED",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("launchVisualizer 透传 --db 与 --port --embed", async () => {
  // launchVisualizer 调 _spawnNewTerminal（来自 launch.ts），
  // 需 mock launch._internals.spawn
  const lau = await import("../src/launch.ts");
  const proj = await import("../src/project.ts");
  const spawnCalls: SpawnCall[] = [];
  lau._internals.spawn = ((
    command: string,
    args: string[],
    options: SpawnOptions,
  ) => {
    spawnCalls.push({ command, args, options });
    return makeFakeChild(77777);
  }) as typeof lau._internals.spawn;

  const root = await mkdtemp(join(tmpdir(), "novel-launcher-"));
  try {
    const dir = join(root, "projectA");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "novel.json"),
      JSON.stringify({
        name: "可视化测试",
        worldGraphDir: ".pi/world-graph-v3",
      }),
      "utf8",
    );
    const result = await proj.launchVisualizer(dir, { port: 9999, embed: true });
    assert.equal(result.pid, 77777);
    assert.equal(spawnCalls.length, 1);
    const flat = spawnCalls[0].args.join(" ");
    assert.ok(flat.includes("visualizer.mjs"));
    assert.ok(flat.includes("--db"));
    assert.ok(flat.includes("world-graph-v3"));
    assert.ok(flat.includes("--port"));
    assert.ok(flat.includes("9999"));
    assert.ok(flat.includes("--embed"));
    assert.equal(spawnCalls[0].options.cwd, resolve(dir));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("launchVisualizer 缺少 novel.json 抛 NOVEL_JSON_NOT_FOUND", async () => {
  const proj = await import("../src/project.ts");
  const { NovelLauncherError } = await import("../src/types.ts");
  const root = await mkdtemp(join(tmpdir(), "novel-launcher-"));
  try {
    const dir = join(root, "empty");
    await mkdir(dir, { recursive: true });
    await assert.rejects(
      () => proj.launchVisualizer(dir),
      (err: Error) =>
        err instanceof NovelLauncherError && err.code === "NOVEL_JSON_NOT_FOUND",
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
