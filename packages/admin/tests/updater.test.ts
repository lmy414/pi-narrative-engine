// packages/admin/tests/updater.test.ts
/**
 * updater.ts 测试
 *
 * 覆盖：
 * - _checkWorkingTreeClean: 干净/脏/mock spawn 抛错
 * - runUpdate: working tree 非干净终止/非 git 仓库/git pull 失败/全流程成功
 * - compareVersions: 本地版本读取/远程版本探测失败
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn as realSpawn } from "node:child_process";

import {
  runUpdate,
  compareVersions,
  _checkWorkingTreeClean,
  _compareSemver,
  _updaterInternals,
  AdminError,
} from "../src/index.ts";

// ---------------------------------------------------------------------------
// mock spawn helper
// ---------------------------------------------------------------------------

interface MockCall {
  cmd: string;
  args: string[];
}

function makeMockChild(stdout: string, stderr: string, code: number) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  setImmediate(() => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    child.emit("close", code);
  });
  return child as any;
}

/** 按命令分发不同 mock 响应 */
function mockSpawnDispatch(
  handler: (cmd: string, args: string[]) => { stdout?: string; stderr?: string; code: number },
) {
  const calls: MockCall[] = [];
  _updaterInternals.spawn = ((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const r = handler(cmd, args);
    return makeMockChild(r.stdout ?? "", r.stderr ?? "", r.code);
  }) as any;
  return calls;
}

function restoreSpawn() {
  _updaterInternals.spawn = realSpawn;
}

// ---------------------------------------------------------------------------

test("_checkWorkingTreeClean: 干净 working tree", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-upd-"));
  try {
    mockSpawnDispatch(() => ({ stdout: "", code: 0 }));
    try {
      const result = await _checkWorkingTreeClean(dir);
      assert.equal(result.clean, true);
      assert.equal(result.dirtyFiles.length, 0);
    } finally {
      restoreSpawn();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("_checkWorkingTreeClean: 脏文件列表", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-upd-"));
  try {
    mockSpawnDispatch(() => ({
      stdout: " M file1.ts\n?? file2.ts\n",
      code: 0,
    }));
    try {
      const result = await _checkWorkingTreeClean(dir);
      assert.equal(result.clean, false);
      assert.equal(result.dirtyFiles.length, 2);
    } finally {
      restoreSpawn();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("_checkWorkingTreeClean: git status 非零退出码抛错", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-upd-"));
  try {
    mockSpawnDispatch(() => ({ stdout: "", stderr: "not a git repo", code: 128 }));
    try {
      await assert.rejects(
        () => _checkWorkingTreeClean(dir),
        (err: Error) => err instanceof AdminError && err.code === "GIT_STATUS_FAILED",
      );
    } finally {
      restoreSpawn();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runUpdate: 非 git 仓库立即报错", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-upd-"));
  try {
    const events = [];
    for await (const ev of runUpdate({ repoRoot: dir, targetDir: dir })) {
      events.push(ev);
    }
    const errorEvent = events.find((e) => e.stage === "error");
    assert.ok(errorEvent, "应有 error 事件");
    assert.ok(errorEvent!.error!.includes("非 git 仓库"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runUpdate: working tree 非干净终止", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-upd-"));
  try {
    // 创建 .git 目录让其通过 git 仓库检查
    await mkdir(join(dir, ".git"), { recursive: true });
    mockSpawnDispatch(() => ({ stdout: " M dirty.ts\n", code: 0 }));
    try {
      const events = [];
      for await (const ev of runUpdate({ repoRoot: dir, targetDir: dir })) {
        events.push(ev);
      }
      const errorEvent = events.find((e) => e.stage === "error");
      assert.ok(errorEvent);
      assert.ok(errorEvent!.error!.includes("working tree 非干净"));
      // 不应有 pull/build/sync 事件
      assert.equal(events.find((e) => e.stage === "pull"), undefined);
    } finally {
      restoreSpawn();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runUpdate: skipCleanCheck 跳过检查直接 pull", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-upd-"));
  try {
    await mkdir(join(dir, ".git"), { recursive: true });
    const calls: MockCall[] = [];
    _updaterInternals.spawn = ((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      // pull/build/sync 全部成功
      return makeMockChild("ok\n", "", 0);
    }) as any;
    try {
      const events = [];
      for await (const ev of runUpdate({
        repoRoot: dir,
        targetDir: dir,
        skipCleanCheck: true,
      })) {
        events.push(ev);
      }
      // 应有 done 事件
      const doneEvent = events.find((e) => e.stage === "done");
      assert.ok(doneEvent);
      // 应调用 git pull / npm run build / npm run sync
      const cmds = calls.map((c) => `${c.cmd} ${c.args.join(" ")}`);
      assert.ok(cmds.some((c) => c.includes("git pull")));
      assert.ok(cmds.some((c) => c.includes("npm run build")));
      assert.ok(cmds.some((c) => c.includes("npm run sync")));
    } finally {
      restoreSpawn();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runUpdate: git pull 失败终止", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-upd-"));
  try {
    await mkdir(join(dir, ".git"), { recursive: true });
    let callIdx = 0;
    _updaterInternals.spawn = (() => {
      callIdx++;
      if (callIdx === 1) {
        // git status 干净
        return makeMockChild("", "", 0);
      }
      // git pull 失败
      return makeMockChild("", "conflict", 1);
    }) as any;
    try {
      const events = [];
      for await (const ev of runUpdate({ repoRoot: dir, targetDir: dir })) {
        events.push(ev);
      }
      const errorEvent = events.find((e) => e.stage === "error");
      assert.ok(errorEvent);
      assert.ok(errorEvent!.error!.includes("git pull"));
      // 不应有 build 事件
      assert.equal(events.find((e) => e.stage === "build"), undefined);
    } finally {
      restoreSpawn();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runUpdate: build 失败终止", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-upd-"));
  try {
    await mkdir(join(dir, ".git"), { recursive: true });
    let callIdx = 0;
    _updaterInternals.spawn = (() => {
      callIdx++;
      if (callIdx === 1) return makeMockChild("", "", 0); // git status
      if (callIdx === 2) return makeMockChild("ok", "", 0); // git pull
      return makeMockChild("", "build error", 1); // build 失败
    }) as any;
    try {
      const events = [];
      for await (const ev of runUpdate({ repoRoot: dir, targetDir: dir })) {
        events.push(ev);
      }
      const errorEvent = events.find((e) => e.stage === "error");
      assert.ok(errorEvent);
      assert.ok(errorEvent!.error!.includes("npm run build"));
      // 不应有 sync 事件
      assert.equal(events.find((e) => e.stage === "sync"), undefined);
    } finally {
      restoreSpawn();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runUpdate: 全流程成功", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-upd-"));
  try {
    await mkdir(join(dir, ".git"), { recursive: true });
    // 按命令分发：git status 返回空（干净），其他返回 "ok\n"
    const calls: MockCall[] = [];
    _updaterInternals.spawn = ((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      const isStatus = cmd === "git" && args[0] === "status";
      return makeMockChild(isStatus ? "" : "ok\n", "", 0);
    }) as any;
    try {
      const events = [];
      for await (const ev of runUpdate({ repoRoot: dir, targetDir: dir })) {
        events.push(ev);
      }
      // 应有 done 事件
      const doneEvent = events.find((e) => e.stage === "done");
      assert.ok(doneEvent);
      assert.ok(doneEvent!.done);
      // 应有各阶段结束事件
      assert.ok(events.find((e) => e.stage === "check" && e.done));
      assert.ok(events.find((e) => e.stage === "pull" && e.done));
      assert.ok(events.find((e) => e.stage === "build" && e.done));
      assert.ok(events.find((e) => e.stage === "sync" && e.done));
    } finally {
      restoreSpawn();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("compareVersions: 本地版本读取", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-upd-"));
  try {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "test", version: "0.1.2" }),
      "utf8",
    );
    // mock git ls-remote 失败（无远程）
    _updaterInternals.spawn = (() => makeMockChild("", "", 1)) as any;
    try {
      const result = await compareVersions(dir);
      assert.equal(result.local, "0.1.2");
      assert.equal(result.remote, null);
      assert.equal(result.updateAvailable, false);
    } finally {
      restoreSpawn();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("compareVersions: 远程版本更新", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-upd-"));
  try {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ version: "0.1.0" }),
      "utf8",
    );
    _updaterInternals.spawn = (() =>
      makeMockChild(
        "abc123\trefs/tags/0.1.0\ndef456\trefs/tags/0.1.2\n",
        "",
        0,
      )) as any;
    try {
      const result = compareVersions(dir);
      const r = await result;
      assert.equal(r.local, "0.1.0");
      assert.equal(r.remote, "0.1.2");
      assert.equal(r.updateAvailable, true);
    } finally {
      restoreSpawn();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("compareVersions: package.json 缺失用 0.0.0 兜底", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-upd-"));
  try {
    _updaterInternals.spawn = (() => makeMockChild("", "", 1)) as any;
    try {
      const result = await compareVersions(dir);
      assert.equal(result.local, "0.0.0");
    } finally {
      restoreSpawn();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ============ M15+M16 回归测试 ============

test("_compareSemver: 数值比较而非字典序", () => {
  // M16 核心：0.1.10 应大于 0.1.2（字典序会判反）
  assert.ok(_compareSemver("0.1.10", "0.1.2") > 0);
  assert.ok(_compareSemver("0.1.2", "0.1.10") < 0);
  assert.equal(_compareSemver("0.1.2", "0.1.2"), 0);
  // 主版本/次版本差异
  assert.ok(_compareSemver("1.0.0", "0.9.9") > 0);
  assert.ok(_compareSemver("0.2.0", "0.1.9") > 0);
  // 长度不一致时短的前补 0
  assert.ok(_compareSemver("1.2", "1.2.0") === 0);
  assert.ok(_compareSemver("1.2.1", "1.2") > 0);
});

test("_compareSemver: 兼容 v 前缀", () => {
  assert.equal(_compareSemver("v0.1.2", "0.1.2"), 0);
  assert.ok(_compareSemver("v0.1.10", "v0.1.2") > 0);
});

test("_compareSemver: 忽略段内非数字后缀", () => {
  // parseInt("2-alpha") = 2，预发布标签不参与比较
  assert.equal(_compareSemver("0.1.2-alpha", "0.1.2"), 0);
  assert.ok(_compareSemver("0.1.3", "0.1.2-beta") > 0);
});

test("compareVersions: 支持 v 前缀 tag（M15 回归）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-upd-"));
  try {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ version: "0.1.0" }),
      "utf8",
    );
    // 远程 tag 用 v 前缀（git tag 常见约定）
    _updaterInternals.spawn = (() =>
      makeMockChild(
        "abc123\trefs/tags/v0.1.0\ndef456\trefs/tags/v0.1.2\n",
        "",
        0,
      )) as any;
    try {
      const r = await compareVersions(dir);
      assert.equal(r.local, "0.1.0");
      assert.equal(r.remote, "0.1.2");
      assert.equal(r.updateAvailable, true);
    } finally {
      restoreSpawn();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("compareVersions: 多版本号语义化选 latest（M16 回归）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-upd-"));
  try {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ version: "0.1.0" }),
      "utf8",
    );
    // 0.1.10 > 0.1.2（数值序），字典序会错误选 0.1.2
    _updaterInternals.spawn = (() =>
      makeMockChild(
        "a\trefs/tags/0.1.2\nb\trefs/tags/0.1.10\nc\trefs/tags/0.1.3\n",
        "",
        0,
      )) as any;
    try {
      const r = await compareVersions(dir);
      assert.equal(r.remote, "0.1.10");
    } finally {
      restoreSpawn();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("compareVersions: v 前缀与无前缀混合排序", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-upd-"));
  try {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ version: "0.1.0" }),
      "utf8",
    );
    _updaterInternals.spawn = (() =>
      makeMockChild(
        "a\trefs/tags/v0.1.2\nb\trefs/tags/0.1.10\n",
        "",
        0,
      )) as any;
    try {
      const r = await compareVersions(dir);
      assert.equal(r.remote, "0.1.10");
    } finally {
      restoreSpawn();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
