/**
 * startup-project.test.ts — 启动项目解析（--project 优先，lastProjectDir 恢复）
 *
 * 覆盖：
 * - cliProjectDir 优先于 lastProjectDir
 * - lastProjectDir 恢复（目录存在时激活）
 * - lastProjectDir 目录不存在 → null，不阻断
 * - 目录损坏（非项目）→ 警告 + null，不阻断
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectRegistry } from "../src/app/project-registry.ts";
import { activateStartupProject } from "../src/app/startup-project.ts";

let root: string;
let projA: string;
let projB: string;
let registry: ProjectRegistry;

function makeBareProject(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "novel.json"),
    JSON.stringify({ name, engine: "narrative-engine", engineVersion: "0.1.0" }),
    "utf8",
  );
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "startup-project-"));
  projA = join(root, "proj-a");
  projB = join(root, "proj-b");
  makeBareProject(projA, "甲");
  makeBareProject(projB, "乙");
});

after(async () => {
  await registry?.closeAll();
  rmSync(root, { recursive: true, force: true });
});

test("--project 优先于 lastProjectDir", async () => {
  registry = new ProjectRegistry();
  const handle = await activateStartupProject(registry, {
    cliProjectDir: projA,
    lastProjectDir: projB,
  });
  assert.equal(handle?.dir, projA);
  assert.equal(registry.getActive()?.dir, projA);
  await registry.closeAll();
});

test("无 --project 时恢复 lastProjectDir", async () => {
  registry = new ProjectRegistry();
  const handle = await activateStartupProject(registry, { lastProjectDir: projB });
  assert.equal(handle?.dir, projB);
  await registry.closeAll();
});

test("lastProjectDir 目录不存在 → null 不阻断", async () => {
  registry = new ProjectRegistry();
  const handle = await activateStartupProject(registry, {
    lastProjectDir: join(root, "已被删除的项目"),
  });
  assert.equal(handle, null);
  assert.equal(registry.getActive(), null);
});

test("目录存在但损坏（非项目）→ 警告 + null 不阻断", async () => {
  registry = new ProjectRegistry();
  const broken = join(root, "broken");
  mkdirSync(broken, { recursive: true }); // 无 novel.json
  const warnings: string[] = [];
  const handle = await activateStartupProject(registry, {
    lastProjectDir: broken,
    warn: (msg) => warnings.push(msg),
  });
  assert.equal(handle, null);
  assert.equal(warnings.length, 1, "应产生一条警告");
  assert.ok(warnings[0].includes("激活启动项目失败"));
});

test("两者都为空 → null", async () => {
  registry = new ProjectRegistry();
  const handle = await activateStartupProject(registry, {});
  assert.equal(handle, null);
});
