// packages/admin/tests/app-config.test.ts
/**
 * app-config.ts 测试
 *
 * 覆盖：
 * - _defaultConfigDir: 三平台路径解析 + env 覆盖
 * - readAppConfig: 缺失文件填默认、宽松合并、JSON 损坏回退默认
 * - writeAppConfig: 深层合并、原子写、非法 mode 拒绝
 * - _copyDir: 递归复制、跳过 node_modules/.git
 * - installExtension: 快照校验、复制、reinstall 清空、skipNpmInstall
 * - reinstallExtension / checkExtensionUpdate: 版本比对
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
  defaultGlobalExtPath,
  installExtension,
  reinstallExtension,
  checkExtensionUpdate,
  _defaultConfigDir,
  _copyDir,
  AdminError,
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
  assert.equal(cfg.extension.mode, "enabled");
  assert.equal(cfg.extension.useExplicitFlag, true);
  assert.equal(cfg.launcher.piExecutable, "pi");
  assert.equal(cfg.extension.globalPath, defaultGlobalExtPath(dir));
});

test("readAppConfig: JSON 损坏回退默认", async () => {
  await writeFile(getAppConfigPath(dir), "{broken", "utf8");
  const cfg = await readAppConfig(dir);
  assert.equal(cfg.extension.mode, "enabled");
});

// ============ writeAppConfig ============

test("writeAppConfig: 深层合并 + 原子写 + 回读", async () => {
  const c1 = await writeAppConfig({ extension: { mode: "disabled" } }, dir);
  assert.equal(c1.extension.mode, "disabled");
  assert.equal(c1.launcher.piExecutable, "pi", "未更新字段保留默认");

  const c2 = await writeAppConfig({ launcher: { defaultScanRoots: ["D:\\novels"] } }, dir);
  assert.equal(c2.extension.mode, "disabled", "前次写入保留");
  assert.deepEqual(c2.launcher.defaultScanRoots, ["D:\\novels"]);

  const raw = JSON.parse(await readFile(getAppConfigPath(dir), "utf8"));
  assert.equal(raw.extension.mode, "disabled");
  assert.ok(!existsSync(getAppConfigPath(dir) + ".tmp"), "临时文件应已 rename");
});

test("writeAppConfig: 非法 mode 抛 INVALID_MODE", async () => {
  await assert.rejects(
    writeAppConfig({ extension: { mode: "bogus" as never } }, dir),
    (e) => {
      assert.ok(e instanceof AdminError);
      assert.equal((e as AdminError).code, "INVALID_MODE");
      return true;
    },
  );
});

// ============ _copyDir / installExtension ============

async function makeSnapshot(root: string, version: string): Promise<string> {
  const snap = join(root, "snapshot");
  await mkdir(join(snap, "dist", "app"), { recursive: true });
  await mkdir(join(snap, "packages", "admin"), { recursive: true });
  await mkdir(join(snap, "node_modules", "dep"), { recursive: true });
  await writeFile(join(snap, "package.json"), JSON.stringify({ name: "narrative-engine", version }), "utf8");
  await writeFile(join(snap, "dist", "app", "main.js"), "// main\n", "utf8");
  await writeFile(join(snap, "packages", "admin", "x.js"), "// pkg\n", "utf8");
  await writeFile(join(snap, "node_modules", "dep", "index.js"), "// dep\n", "utf8");
  return snap;
}

test("_copyDir: 递归复制并跳过 node_modules", async () => {
  const snap = await makeSnapshot(dir, "0.1.0");
  const dst = join(dir, "copy-dst");
  const count = await _copyDir(snap, dst);
  assert.equal(count, 3, "package.json + 2 个 js");
  assert.ok(existsSync(join(dst, "dist", "app", "main.js")));
  assert.ok(!existsSync(join(dst, "node_modules")), "node_modules 应跳过");
});

test("installExtension: 快照缺 package.json 抛 SNAPSHOT_INVALID", async () => {
  const bad = join(dir, "bad-snap");
  await mkdir(bad, { recursive: true });
  await assert.rejects(
    installExtension({ snapshotDir: bad, globalExtDir: join(dir, "g1"), skipNpmInstall: true }),
    (e) => {
      assert.equal((e as AdminError).code, "SNAPSHOT_INVALID");
      return true;
    },
  );
});

test("installExtension: 正常安装（skipNpmInstall）", async () => {
  const snap = await makeSnapshot(dir, "0.1.0");
  const g = join(dir, "g2");
  const r = await installExtension({ snapshotDir: snap, globalExtDir: g, skipNpmInstall: true });
  assert.equal(r.ok, true);
  assert.equal(r.npmInstallRan, false);
  assert.ok(existsSync(join(g, "package.json")));
});

test("reinstallExtension: 先清空再复制", async () => {
  const snap = await makeSnapshot(dir, "0.2.0");
  const g = join(dir, "g3");
  await mkdir(g, { recursive: true });
  await writeFile(join(g, "stale-file.js"), "old\n", "utf8");
  const r = await reinstallExtension(snap, g, { skipNpmInstall: true });
  assert.equal(r.ok, true);
  assert.ok(!existsSync(join(g, "stale-file.js")), "旧文件应被清空");
  assert.ok(existsSync(join(g, "dist", "app", "main.js")));
});

test("checkExtensionUpdate: 版本比对", async () => {
  const snap = await makeSnapshot(dir, "0.3.0");
  const g = join(dir, "g4");
  await mkdir(g, { recursive: true });
  await writeFile(join(g, "package.json"), JSON.stringify({ version: "0.1.0" }), "utf8");
  const r1 = await checkExtensionUpdate(snap, g);
  assert.equal(r1.current, "0.1.0");
  assert.equal(r1.available, "0.3.0");
  assert.equal(r1.updateAvailable, true);

  await writeFile(join(g, "package.json"), JSON.stringify({ version: "0.3.0" }), "utf8");
  const r2 = await checkExtensionUpdate(snap, g);
  assert.equal(r2.updateAvailable, false);

  const r3 = await checkExtensionUpdate(join(dir, "不存在"), g);
  assert.equal(r3.available, null);
  assert.equal(r3.updateAvailable, false);
});
