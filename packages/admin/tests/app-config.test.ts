// packages/admin/tests/app-config.test.ts
/**
 * app-config.ts 测试
 *
 * 覆盖：
 * - _defaultConfigDir: 三平台路径解析 + env 覆盖
 * - readAppConfig: 缺失文件填默认、宽松合并、JSON 损坏回退默认
 * - writeAppConfig: 深层合并、原子写、剥离磁盘文件中的废弃键
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  readAppConfig,
  writeAppConfig,
  getAppConfigPath,
  _defaultConfigDir,
} from "../src/index.ts";

let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "app-config-"));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ============ _defaultConfigDir ============

test("_defaultConfigDir: Windows 用 APPDATA，缺省回退 Roaming", () => {
  assert.equal(
    _defaultConfigDir("win32", { APPDATA: "C:\\Users\\x\\AppData\\Roaming" }),
    join("C:\\Users\\x\\AppData\\Roaming", "narrative-engine"),
  );
  const fallback = _defaultConfigDir("win32", {});
  assert.ok(fallback.endsWith(join("Roaming", "narrative-engine")));
});

test("_defaultConfigDir: Linux 用 XDG_CONFIG_HOME 或 ~/.config", () => {
  assert.equal(
    _defaultConfigDir("linux", { XDG_CONFIG_HOME: "/custom" }),
    join("/custom", "narrative-engine"),
  );
  assert.ok(_defaultConfigDir("linux", {}).includes(".config"));
});

test("_defaultConfigDir: macOS 用 Application Support", () => {
  assert.ok(_defaultConfigDir("darwin", {}).includes("Application Support"));
});

// ============ readAppConfig ============

test("readAppConfig: 文件缺失时返回默认值", async () => {
  const cfg = await readAppConfig(dir);
  assert.equal(cfg.launcher.defaultScanRoots.length, 0);
  assert.equal(cfg.embedder.model, "Xenova/bge-small-zh-v1.5");
});

test("readAppConfig: JSON 损坏回退默认", async () => {
  await writeFile(getAppConfigPath(dir), "{broken", "utf8");
  const cfg = await readAppConfig(dir);
  assert.equal(cfg.embedder.model, "Xenova/bge-small-zh-v1.5");
});

// ============ writeAppConfig ============

test("writeAppConfig: 深层合并 + 原子写 + 回读", async () => {
  const c1 = await writeAppConfig({ launcher: { defaultScanRoots: ["D:\\novels"] } }, dir);
  assert.deepEqual(c1.launcher.defaultScanRoots, ["D:\\novels"]);
  assert.equal(c1.embedder.model, "Xenova/bge-small-zh-v1.5", "未更新字段保留默认");

  const c2 = await writeAppConfig({ embedder: { model: "custom-model" } }, dir);
  assert.deepEqual(c2.launcher.defaultScanRoots, ["D:\\novels"], "前次写入保留");
  assert.equal(c2.embedder.model, "custom-model");

  const raw = JSON.parse(await readFile(getAppConfigPath(dir), "utf8"));
  assert.deepEqual(raw.launcher.defaultScanRoots, ["D:\\novels"]);
  assert.ok(!existsSync(getAppConfigPath(dir) + ".tmp"), "临时文件应已 rename");
});

test("writeAppConfig: 剥离磁盘文件中的废弃键", async () => {
  // 磁盘上残留扩展时代的 launcher.piExecutable 与未知键
  await writeFile(
    getAppConfigPath(dir),
    JSON.stringify({
      launcher: { piExecutable: "C:\\pi.exe", defaultScanRoots: ["D:\\novels"] },
      embedder: { model: "custom-model" },
      extension: { legacy: true },
    }),
    "utf8",
  );
  const cfg = await writeAppConfig({ embedder: { model: "new-model" } }, dir);
  assert.equal(cfg.embedder.model, "new-model");
  assert.deepEqual(cfg.launcher.defaultScanRoots, ["D:\\novels"], "已知键保留");

  const raw = JSON.parse(await readFile(getAppConfigPath(dir), "utf8"));
  assert.ok(!("piExecutable" in raw.launcher), "废弃键 piExecutable 应被剥离");
  assert.ok(!("extension" in raw), "未知顶层键应被剥离");
});

// ============ llm.slots ============

test("readAppConfig: llm.slots 缺省为空对象", async () => {
  const d2 = await mkdtemp(join(tmpdir(), "app-config-"));
  try {
    const cfg = await readAppConfig(d2);
    assert.deepEqual(cfg.llm.slots, {});
  } finally {
    await rm(d2, { recursive: true, force: true });
  }
});

test("writeAppConfig: llm.slots 设置/更新/删除（null）", async () => {
  const d2 = await mkdtemp(join(tmpdir(), "app-config-"));
  try {
    const c1 = await writeAppConfig(
      { llm: { slots: { default: { provider: "deepseek", model: "deepseek-v4-flash" } } } },
      d2,
    );
    assert.deepEqual(c1.llm.slots.default, { provider: "deepseek", model: "deepseek-v4-flash" });

    // 第二个 slot 不影响第一个
    const c2 = await writeAppConfig(
      { llm: { slots: { planner: { provider: "openai", model: "gpt-5.1" } } } },
      d2,
    );
    assert.deepEqual(c2.llm.slots.default, { provider: "deepseek", model: "deepseek-v4-flash" });
    assert.deepEqual(c2.llm.slots.planner, { provider: "openai", model: "gpt-5.1" });

    // null 删除该 slot
    const c3 = await writeAppConfig({ llm: { slots: { planner: null } } }, d2);
    assert.ok(!("planner" in c3.llm.slots), "planner 应被删除");
    assert.ok("default" in c3.llm.slots, "default 保留");

    // 回读验证落盘
    const back = await readAppConfig(d2);
    assert.deepEqual(back.llm.slots, c3.llm.slots);
  } finally {
    await rm(d2, { recursive: true, force: true });
  }
});

test("writeAppConfig: llm.slots 忽略未知 slot 名", async () => {
  const d2 = await mkdtemp(join(tmpdir(), "app-config-"));
  try {
    const cfg = await writeAppConfig(
      {
        llm: {
          slots: {
            default: { provider: "deepseek", model: "deepseek-v4-flash" },
            hacker: { provider: "x", model: "y" },
          } as never,
        },
      },
      d2,
    );
    assert.ok("default" in cfg.llm.slots);
    assert.ok(!("hacker" in cfg.llm.slots), "未知 slot 名应被忽略");
  } finally {
    await rm(d2, { recursive: true, force: true });
  }
});

// ============ launcher.lastProjectDir ============

test("writeAppConfig: lastProjectDir 设置与显式置 null", async () => {
  const d2 = await mkdtemp(join(tmpdir(), "app-config-"));
  try {
    const c1 = await writeAppConfig({ launcher: { lastProjectDir: "D:\\novels\\a" } }, d2);
    assert.equal(c1.launcher.lastProjectDir, "D:\\novels\\a");

    // 更新其他 launcher 字段不影响 lastProjectDir
    const c2 = await writeAppConfig({ launcher: { defaultScanRoots: ["D:\\novels"] } }, d2);
    assert.equal(c2.launcher.lastProjectDir, "D:\\novels\\a", "未提供时保留");

    // 显式 null 清除
    const c3 = await writeAppConfig({ launcher: { lastProjectDir: null } }, d2);
    assert.equal(c3.launcher.lastProjectDir, null);

    const back = await readAppConfig(d2);
    assert.equal(back.launcher.lastProjectDir, null);
  } finally {
    await rm(d2, { recursive: true, force: true });
  }
});