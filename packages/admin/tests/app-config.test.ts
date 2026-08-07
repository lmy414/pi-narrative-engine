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
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
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

// ============ llm.providers ============

test("readAppConfig: llm.providers 缺省为空数组", async () => {
  const d2 = await mkdtemp(join(tmpdir(), "app-config-"));
  try {
    const cfg = await readAppConfig(d2);
    assert.deepEqual(cfg.llm.providers, []);
  } finally {
    await rm(d2, { recursive: true, force: true });
  }
});

test("writeAppConfig: llm.providers 全量替换/保留/置空", async () => {
  const d2 = await mkdtemp(join(tmpdir(), "app-config-"));
  try {
    const p1 = [
      {
        id: "my-groq",
        name: "My Groq",
        baseURL: "https://api.groq.com/openai/v1",
        apiKind: "openai-completions",
        modelIds: ["llama-3.3-70b"],
        fetchModels: true,
      },
    ] as const;
    const c1 = await writeAppConfig({ llm: { providers: p1 } }, d2);
    assert.equal(c1.llm.providers.length, 1);
    assert.equal(c1.llm.providers[0].name, "My Groq");

    // 未提供 providers 时保留
    const c2 = await writeAppConfig({ llm: { slots: { default: { provider: "deepseek", model: "deepseek-v4-flash" } } } }, d2);
    assert.equal(c2.llm.providers.length, 1, "未提供 providers 时保留");

    // 全量替换
    const p2 = [
      { id: "groq2", name: "Groq2", baseURL: "https://x/v1", apiKind: "openai-completions", modelIds: [], fetchModels: false },
    ];
    const c3 = await writeAppConfig({ llm: { providers: p2 } }, d2);
    assert.equal(c3.llm.providers.length, 1);
    assert.equal(c3.llm.providers[0].id, "groq2");

    // 置空数组清空
    const c4 = await writeAppConfig({ llm: { providers: [] } }, d2);
    assert.deepEqual(c4.llm.providers, []);

    // 回读验证落盘
    const back = await readAppConfig(d2);
    assert.deepEqual(back.llm.providers, []);
  } finally {
    await rm(d2, { recursive: true, force: true });
  }
});

// ============ llm.providerModels（内置厂商启用模型子集） ============

test("readAppConfig: llm.providerModels 缺省为空对象；非数组项被剔除", async () => {
  const d2 = await mkdtemp(join(tmpdir(), "app-config-"));
  try {
    const cfg = await readAppConfig(d2);
    assert.deepEqual(cfg.llm.providerModels, {});

    await writeFile(
      join(d2, "app-config.json"),
      JSON.stringify({ llm: { providerModels: { deepseek: ["a", "b"], bad: "x" } } }),
    );
    const cfg2 = await readAppConfig(d2);
    assert.deepEqual(cfg2.llm.providerModels, { deepseek: ["a", "b"] }, "非数组项应被剔除");
  } finally {
    await rm(d2, { recursive: true, force: true });
  }
});

test("writeAppConfig: llm.providerModels 按键合并、null 删除、未提供保留", async () => {
  const d2 = await mkdtemp(join(tmpdir(), "app-config-"));
  try {
    const c1 = await writeAppConfig(
      { llm: { providerModels: { deepseek: ["deepseek-v4-flash"] } } },
      d2,
    );
    assert.deepEqual(c1.llm.providerModels, { deepseek: ["deepseek-v4-flash"] });

    // 合并另一厂商，不影响已有键
    const c2 = await writeAppConfig({ llm: { providerModels: { openai: ["gpt-4o"] } } }, d2);
    assert.deepEqual(c2.llm.providerModels, {
      deepseek: ["deepseek-v4-flash"],
      openai: ["gpt-4o"],
    });

    // 未提供 providerModels 时保留
    const c3 = await writeAppConfig(
      { llm: { slots: { default: { provider: "deepseek", model: "deepseek-v4-flash" } } } },
      d2,
    );
    assert.deepEqual(c3.llm.providerModels.openai, ["gpt-4o"], "未提供时保留");

    // null 删除该厂商子集
    const c4 = await writeAppConfig({ llm: { providerModels: { openai: null } } }, d2);
    assert.ok(!("openai" in c4.llm.providerModels), "null 应删除键");
    assert.deepEqual(c4.llm.providerModels.deepseek, ["deepseek-v4-flash"]);

    // 回读验证落盘
    const back = await readAppConfig(d2);
    assert.deepEqual(back.llm.providerModels, { deepseek: ["deepseek-v4-flash"] });
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
// ============ scheduler.defaultMode ============

test("writeAppConfig: scheduler.defaultMode 设置/保留/非法值忽略", async () => {
  const d2 = await mkdtemp(join(tmpdir(), "app-config-"));
  try {
    const def = await readAppConfig(d2);
    assert.equal(def.scheduler.defaultMode, "plan", "缺省 plan（安全优先）");

    const c1 = await writeAppConfig({ scheduler: { defaultMode: "yolo" } }, d2);
    assert.equal(c1.scheduler.defaultMode, "yolo");

    const c2 = await writeAppConfig(
      { scheduler: { defaultMode: "turbo" as never } },
      d2,
    );
    assert.equal(c2.scheduler.defaultMode, "yolo", "非法值忽略，保留原值");

    const c3 = await writeAppConfig({ embedder: { model: "m" } }, d2);
    assert.equal(c3.scheduler.defaultMode, "yolo", "未提供时保留");

    const back = await readAppConfig(d2);
    assert.equal(back.scheduler.defaultMode, "yolo");
  } finally {
    await rm(d2, { recursive: true, force: true });
  }
});

// ============ 并发写串行化（🟠-8 2026-08-08） ============

test("writeAppConfig: 并发写不同字段不丢更新（🟠-8）", async () => {
  const d2 = await mkdtemp(join(tmpdir(), "app-config-"));
  try {
    await Promise.all([
      writeAppConfig({ embedder: { model: "concurrent-model" } }, d2),
      writeAppConfig({ launcher: { defaultScanRoots: ["D:\\并发"] } }, d2),
    ]);
    const back = await readAppConfig(d2);
    assert.equal(back.embedder.model, "concurrent-model", "并发写 embedder 不应丢失");
    assert.deepEqual(back.launcher.defaultScanRoots, ["D:\\并发"], "并发写 launcher 不应丢失");
  } finally {
    await rm(d2, { recursive: true, force: true });
  }
});

test("writeAppConfig: 并发写后无 .tmp 残留（随机后缀）", async () => {
  const d2 = await mkdtemp(join(tmpdir(), "app-config-"));
  try {
    await Promise.all([
      writeAppConfig({ embedder: { model: "m1" } }, d2),
      writeAppConfig({ embedder: { model: "m2" } }, d2),
      writeAppConfig({ embedder: { model: "m3" } }, d2),
    ]);
    const leftover = (await readdir(d2)).filter((f) => f.includes(".tmp"));
    assert.deepEqual(leftover, [], `不应有 .tmp 残留: ${leftover.join(",")}`);
  } finally {
    await rm(d2, { recursive: true, force: true });
  }
});

test("writeAppConfig: defaultScanRoots 非数组坏值归一（🟡 4b 审计补测）", async () => {
  const d2 = await mkdtemp(join(tmpdir(), "app-config-"));
  try {
    // 写侧：字符串坏值不落盘（保留当前）
    await writeAppConfig({ launcher: { defaultScanRoots: ["D:/novels"] } }, d2);
    const bad = await writeAppConfig({ launcher: { defaultScanRoots: "D:/bad" as never } }, d2);
    assert.deepEqual(bad.launcher.defaultScanRoots, ["D:/novels"], "非数组更新应被忽略（保留当前）");
    // 读侧：磁盘历史坏值（字符串）兜底为空数组
    await writeFile(getAppConfigPath(d2), JSON.stringify({ launcher: { defaultScanRoots: "D:/bad" } }), "utf8");
    const back = await readAppConfig(d2);
    assert.deepEqual(back.launcher.defaultScanRoots, [], "读侧坏值应归一为空数组（不再污染 scan）");
  } finally {
    await rm(d2, { recursive: true, force: true });
  }
});
