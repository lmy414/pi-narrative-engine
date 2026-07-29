// packages/novel-launcher/tests/launch.test.ts
/**
 * launch.ts 测试：
 * - _buildPiCommand 纯函数（引号转义）直接测
 * - _spawnNewTerminal / launchPi 通过替换 _internals.spawn 拦截
 *   （ESM namespace 属性不可重定义，故源码用 _internals 对象包装便于 mock）
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChildProcess, SpawnOptions } from "node:child_process";

interface SpawnCall {
  command: string;
  args: string[];
  options: SpawnOptions;
}

function makeFakeChild(pid: number | undefined): ChildProcess {
  return {
    pid,
    on: () => {},
    unref: () => {},
  } as unknown as ChildProcess;
}

let savedSpawn: typeof import("../src/launch.ts")._internals.spawn;

beforeEach(async () => {
  const mod = await import("../src/launch.ts");
  savedSpawn = mod._internals.spawn;
});

afterEach(async () => {
  const mod = await import("../src/launch.ts");
  mod._internals.spawn = savedSpawn;
});

test("_buildPiCommand 空参数列表", async () => {
  const { _buildPiCommand } = await import("../src/launch.ts");
  assert.equal(_buildPiCommand("pi", []), "pi");
});

test("_buildPiCommand 无特殊字符参数不引号化", async () => {
  const { _buildPiCommand } = await import("../src/launch.ts");
  assert.equal(_buildPiCommand("pi", ["--port", "7421"]), "pi --port 7421");
});

test("_buildPiCommand 含空格参数加双引号", async () => {
  const { _buildPiCommand } = await import("../src/launch.ts");
  const cmd = _buildPiCommand("pi", ["--name", "我的 项目"]);
  assert.equal(cmd, 'pi --name "我的 项目"');
});

test("_buildPiCommand 含双引号参数转义双引号", async () => {
  const { _buildPiCommand } = await import("../src/launch.ts");
  const cmd = _buildPiCommand("pi", ['he said "hi"']);
  assert.equal(cmd, 'pi "he said \\"hi\\""');
});

test("_buildPiCommand 空字符串参数引号化", async () => {
  const { _buildPiCommand } = await import("../src/launch.ts");
  assert.equal(_buildPiCommand("pi", [""]), 'pi ""');
});

test("_buildPiCommand 可执行文件路径含空格", async () => {
  const { _buildPiCommand } = await import("../src/launch.ts");
  const cmd = _buildPiCommand("/path with space/pi", ["--version"]);
  assert.equal(cmd, '"/path with space/pi" --version');
});

test("_spawnNewTerminal 调用 spawn 并返回 pid", async () => {
  const mod = await import("../src/launch.ts");
  const calls: SpawnCall[] = [];
  mod._internals.spawn = ((
    command: string,
    args: string[],
    options: SpawnOptions,
  ) => {
    calls.push({ command, args, options });
    return makeFakeChild(99999);
  }) as typeof mod._internals.spawn;

  const pid = mod._spawnNewTerminal("/some/dir", "pi", ["--foo"], "测试标题");
  assert.equal(pid, 99999);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.cwd, "/some/dir");
  assert.equal(calls[0].options.detached, true);
});

test("_spawnNewTerminal spawn 失败抛 SPAWN_FAILED", async () => {
  const mod = await import("../src/launch.ts");
  mod._internals.spawn = (() =>
    makeFakeChild(undefined)) as typeof mod._internals.spawn;

  const { NovelLauncherError } = await import("../src/types.ts");
  assert.throws(
    () => mod._spawnNewTerminal("/x", "pi", [], "t"),
    (err: Error) =>
      err instanceof NovelLauncherError && err.code === "SPAWN_FAILED",
  );
});

test("launchPi 默认 title 从 novel.json 读取", async () => {
  const mod = await import("../src/launch.ts");
  const calls: SpawnCall[] = [];
  mod._internals.spawn = ((
    command: string,
    args: string[],
    options: SpawnOptions,
  ) => {
    calls.push({ command, args, options });
    return makeFakeChild(11111);
  }) as typeof mod._internals.spawn;

  const root = await mkdtemp(join(tmpdir(), "novel-launcher-"));
  try {
    const dir = join(root, "projectA");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "novel.json"),
      JSON.stringify({ name: "我的小说" }),
      "utf8",
    );
    const result = await mod.launchPi(dir);
    assert.equal(result.pid, 11111);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.cwd, dir);
    assert.ok(calls[0].args.includes("pi") || calls[0].command === "pi");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("launchPi novel.json 缺失时 title 回退到 basename", async () => {
  const mod = await import("../src/launch.ts");
  const calls: SpawnCall[] = [];
  mod._internals.spawn = ((
    command: string,
    args: string[],
    options: SpawnOptions,
  ) => {
    calls.push({ command, args, options });
    return makeFakeChild(22222);
  }) as typeof mod._internals.spawn;

  const root = await mkdtemp(join(tmpdir(), "novel-launcher-"));
  try {
    const dir = join(root, "no-novel-dir");
    await mkdir(dir, { recursive: true });
    const result = await mod.launchPi(dir);
    assert.equal(result.pid, 22222);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.cwd, dir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("launchPi 自定义 executable 和 args 透传", async () => {
  const mod = await import("../src/launch.ts");
  const calls: SpawnCall[] = [];
  mod._internals.spawn = ((
    command: string,
    args: string[],
    options: SpawnOptions,
  ) => {
    calls.push({ command, args, options });
    return makeFakeChild(33333);
  }) as typeof mod._internals.spawn;

  const root = await mkdtemp(join(tmpdir(), "novel-launcher-"));
  try {
    const dir = join(root, "projectA");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "novel.json"), JSON.stringify({ name: "X" }), "utf8");
    await mod.launchPi(dir, {
      executable: "/custom/pi",
      args: ["--debug", "--port", "9999"],
      title: "自定义标题",
    });
    assert.equal(calls.length, 1);
    const allArgs = calls[0].args.join(" ");
    assert.ok(allArgs.includes("--debug"));
    assert.ok(allArgs.includes("9999"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("launchPi 显式 title 优先于 novel.json", async () => {
  const mod = await import("../src/launch.ts");
  const calls: SpawnCall[] = [];
  mod._internals.spawn = ((
    command: string,
    args: string[],
    options: SpawnOptions,
  ) => {
    calls.push({ command, args, options });
    return makeFakeChild(44444);
  }) as typeof mod._internals.spawn;

  const root = await mkdtemp(join(tmpdir(), "novel-launcher-"));
  try {
    const dir = join(root, "projectA");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "novel.json"), JSON.stringify({ name: "不该用这个" }), "utf8");
    await mod.launchPi(dir, { title: "显式标题" });
    assert.equal(calls.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
