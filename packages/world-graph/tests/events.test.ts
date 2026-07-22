import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventLog } from "../src/event-log.ts";

function withTempLog(fn: (log: EventLog, dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "wg-log-"));
    const log = new EventLog(join(dir, "events.jsonl"));
    try {
      await fn(log, dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("append + readAll", withTempLog(async (log) => {
  await log.append({ eventId: "evt-1", type: "birth", storyTime: "t1", entityId: "e1" });
  await log.append({ eventId: "evt-2", type: "change", storyTime: "t2", entityId: "e1", causedBy: "evt-1" });
  const all = await log.readAll();
  assert.equal(all.length, 2);
  assert.equal(all[0].eventId, "evt-1");
  assert.equal(all[1].causedBy, "evt-1");
}));

test("traceBack 沿 causedBy 回溯", withTempLog(async (log) => {
  await log.append({ eventId: "evt-a", type: "birth", storyTime: "t1", entityId: "e1" });
  await log.append({ eventId: "evt-b", type: "change", storyTime: "t2", entityId: "e1", causedBy: "evt-a" });
  await log.append({ eventId: "evt-c", type: "change", storyTime: "t3", entityId: "e1", causedBy: "evt-b" });
  const chain = await log.traceBack("evt-c");
  assert.deepEqual(chain.map((e: any) => e.eventId), ["evt-a", "evt-b", "evt-c"]);
}));

test("traceBack 无 causedBy 时返回单元素", withTempLog(async (log) => {
  await log.append({ eventId: "evt-x", type: "birth", storyTime: "t1", entityId: "e1" });
  const chain = await log.traceBack("evt-x");
  assert.equal(chain.length, 1);
  assert.equal(chain[0].eventId, "evt-x");
}));

test("traceBack causedBy 指向不存在的事件时停止", withTempLog(async (log) => {
  await log.append({ eventId: "evt-y", type: "change", storyTime: "t1", entityId: "e1", causedBy: "evt-missing" });
  const chain = await log.traceBack("evt-y");
  assert.equal(chain.length, 1);
  assert.equal(chain[0].eventId, "evt-y");
}));
