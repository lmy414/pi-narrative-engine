import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorldGraph } from "@pi/world-graph";
import {
  loadMemory,
  updateMemory,
  latestStoryTime,
  resolveMemoryPath,
  STORY_TIME_CONVENTION,
} from "../src/memory.ts";

async function withTempProject(
  fn: (wg: WorldGraph, cwd: string) => Promise<void>,
): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "ne-mem-"));
  const dir = join(cwd, ".pi", "world-graph-v3");
  mkdirSync(dir, { recursive: true });
  const wg = await WorldGraph.create({
    dbPath: join(dir, "world.db"),
    eventLogPath: join(dir, "events.jsonl"),
  });
  try {
    await fn(wg, cwd);
  } finally {
    wg.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}

/** 造一个带名字的角色 + 一条 change 事件 */
async function seed(wg: WorldGraph): Promise<void> {
  await wg.processEvent({
    eventId: "evt-1",
    type: "birth",
    storyTime: "ch001.ev001",
    entityId: "ent_char_aa",
    newFacts: [
      { entityId: "ent_char_aa", property: "name", value: "彩叶", modality: "fact" },
    ],
  });
  await wg.processEvent({
    eventId: "evt-2",
    type: "change",
    storyTime: "ch001.ev002",
    entityId: "ent_char_aa",
    newFacts: [
      { entityId: "ent_char_aa", property: "mood", value: "好奇", modality: "fact" },
    ],
    userInput: "彩叶推开咖啡厅的门",
  });
}

test("resolveMemoryPath 指向 .pi/world-graph-v3/memory.md", () => {
  const p = resolveMemoryPath("/proj");
  assert.ok(p.endsWith(join(".pi", "world-graph-v3", "memory.md")));
});

test("loadMemory：文件缺失时返回空字符串", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ne-mem-empty-"));
  try {
    assert.equal(await loadMemory(cwd), "");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("latestStoryTime：返回最大 storyTime；空项目返回 null", async () => {
  await withTempProject(async (wg) => {
    assert.equal(await latestStoryTime(wg), null);
    await seed(wg);
    assert.equal(await latestStoryTime(wg), "ch001.ev002");
  });
});

test("updateMemory：生成含当前 storyTime / 口述原文 / 角色名 / 约定的记忆文件", async () => {
  await withTempProject(async (wg, cwd) => {
    await seed(wg);
    await updateMemory(wg, cwd);

    const content = await readFile(resolveMemoryPath(cwd), "utf-8");
    // 当前 storyTime
    assert.match(content, /当前 storyTime: `ch001\.ev002`/);
    // 用户口述原文
    assert.match(content, /彩叶推开咖啡厅的门/);
    // 角色名消解（name Fact → 彩叶）
    assert.match(content, /彩叶（ent_char_aa）/);
    // storyTime 约定
    assert.ok(content.includes(STORY_TIME_CONVENTION));
    // 事件分组（新→旧，两组都应在）
    assert.ok(content.indexOf("ch001.ev002") < content.indexOf("ch001.ev001"));
  });
});

test("updateMemory：无口述原文的事件标注（无口述记录）", async () => {
  await withTempProject(async (wg, cwd) => {
    await seed(wg);
    await updateMemory(wg, cwd);
    const content = await readFile(resolveMemoryPath(cwd), "utf-8");
    assert.match(content, /`ch001\.ev001`｜彩叶（ent_char_aa）｜（无口述记录）/);
  });
});

test("updateMemory：空项目不生成文件", async () => {
  await withTempProject(async (wg, cwd) => {
    await updateMemory(wg, cwd);
    assert.equal(await loadMemory(cwd), "");
  });
});

test("loadMemory：updateMemory 后可读回完整内容", async () => {
  await withTempProject(async (wg, cwd) => {
    await seed(wg);
    await updateMemory(wg, cwd);
    const loaded = await loadMemory(cwd);
    assert.ok(loaded.length > 0);
    assert.match(loaded, /项目记忆/);
  });
});
