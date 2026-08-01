// packages/admin/tests/app-config.test.ts
/**
 * app-config.ts 测试
 *
 * 覆盖：
 * - _defaultConfigDir: 三平台路径解析 + env 覆盖
 * - readAppConfig: 缺失文件填默认、宽松合并、JSON 损坏回退默认
 * - writeAppConfig: 深层合并、原子写
 * - 保留非扩展配置（launcher.defaultScanRoots、launcher.piExecutable、embedder.model）
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
  assert.equal(cfg.launcher.piExecutable, "pi");
  assert.equal(cfg.launcher.defaultScanRoots.length, 0);
  assert.equal(cfg.embedder.model, "Xenova/bge-small-zh-v1.5");
});

test("readAppConfig: JSON 损坏回退默认", async () => {
  await writeFile(getAppConfigPath(dir), "{broken", "utf8");
  const cfg = await readAppConfig(dir);
  assert.equal(cfg.launcher.piExecutable, "pi");
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