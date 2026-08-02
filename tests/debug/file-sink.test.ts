import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createDebugBus,
  createDebugJsonlSink,
  createProjectDebugBus,
} from "../../src/debug/bus.ts";
import type { DebugEvent, DebugEventSink, DrainableDebugBus } from "../../src/debug/types.ts";
import { ChatContext } from "../../src/app/chat-context.ts";
import { LlmConfigStore } from "../../src/orchestrator/llm-config.ts";

function event(id: string): DebugEvent {
  return { id, ts: 1, traceId: "trace", stage: "test", status: "start" };
}

async function withTempProject(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "debug-sink-test-"));
  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("project debug bus writes one parseable JSON event per line and clear only clears memory", async () => {
  await withTempProject(async (cwd) => {
    const globalBus = createDebugBus();
    const bus = createProjectDebugBus(globalBus, createDebugJsonlSink(cwd));
    bus.emit(event("one"));
    bus.emit(event("two"));
    globalBus.clear();
    await bus.drain();

    assert.deepEqual(globalBus.snapshot(), []);
    const content = await readFile(join(cwd, ".pi", "logs", "debug.jsonl"), "utf8");
    assert.deepEqual(content.trimEnd().split("\n").map((line) => JSON.parse(line).id), ["one", "two"]);
  });
});

test("sink failure is warned and does not affect synchronous memory or subscribers", async () => {
  const globalBus = createDebugBus();
  const received: string[] = [];
  const warnings: unknown[] = [];
  globalBus.subscribe((value) => received.push(value.id));
  const bus = createProjectDebugBus(
    globalBus,
    { write: async () => { throw new Error("disk failed"); } },
    (_message, error) => warnings.push(error),
  );

  bus.emit(event("failed-write"));
  assert.deepEqual(received, ["failed-write"]);
  assert.equal(globalBus.snapshot()[0].id, "failed-write");
  await bus.drain();
  assert.equal(warnings.length, 1);
});

test("file sink rotates before writing, avoids same-second overwrite, and retains five rotations", async () => {
  await withTempProject(async (cwd) => {
    const logsDir = join(cwd, ".pi", "logs");
    await mkdir(logsDir, { recursive: true });
    await writeFile(join(logsDir, "debug.jsonl"), "old-active\n", "utf8");
    for (let second = 0; second < 6; second++) {
      const suffix = String(second).padStart(2, "0");
      await writeFile(join(logsDir, `debug-20260802-1200${suffix}.jsonl`), `old-${second}\n`, "utf8");
    }
    const colliding = join(logsDir, "debug-20260802-120005.jsonl");
    const collidingBefore = await readFile(colliding, "utf8");
    const bus = createProjectDebugBus(globalThisBus(), createDebugJsonlSink(cwd, {
      maxFileBytes: 1,
      maxRotatedFiles: 5,
      now: () => new Date(2026, 7, 2, 12, 0, 5),
    }));

    bus.emit(event("new-active"));
    await bus.drain();

    assert.equal(await readFile(colliding, "utf8"), collidingBefore);
    const files = await readdir(logsDir);
    const rotated = files.filter((name) => /^debug-.*\.jsonl$/.test(name)).sort();
    assert.equal(rotated.length, 5);
    assert.ok(rotated.includes("debug-20260802-120006.jsonl"));
    assert.equal(JSON.parse((await readFile(join(logsDir, "debug.jsonl"), "utf8")).trim()).id, "new-active");
  });
});

test("project buses keep creation-time cwd across switches and dispose drains queued writes", async () => {
  await withTempProject(async (root) => {
    const projects = [join(root, "a"), join(root, "b")];
    await Promise.all(projects.map((dir) => mkdir(dir)));
    let activeDir = projects[0];
    const buses = new Map<string, DrainableDebugBus>();
    const persisted = new Map<string, string[]>();
    let releaseLastWrite!: () => void;
    const lastWriteBlocked = new Promise<void>((resolve) => { releaseLastWrite = resolve; });
    const context = new ChatContext({
      registry: {
        getActive: () => ({ dir: activeDir, meta: { name: activeDir }, wg: {}, search: {}, forceFulltext: false }),
      } as never,
      llmStore: new LlmConfigStore(),
      configDir: join(root, "config"),
      embedder: {} as never,
      debugBus: createDebugBus(),
      createDebugSink: (cwd): DebugEventSink => ({
        async write(value) {
          if (value.id === "late-b") await lastWriteBlocked;
          const ids = persisted.get(cwd) ?? [];
          ids.push(value.id);
          persisted.set(cwd, ids);
        },
      }),
      createOrchestratorService: async (project, _embedder, debugBus) => {
        buses.set(project.dir, debugBus as DrainableDebugBus);
        return {} as never;
      },
    });

    await context.ensureOrchestratorService(projects[0]);
    activeDir = projects[1];
    await context.ensureOrchestratorService(projects[1]);
    buses.get(projects[0])!.emit(event("late-a"));
    buses.get(projects[1])!.emit(event("late-b"));
    const disposing = context.dispose();
    let disposed = false;
    void disposing.then(() => { disposed = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(disposed, false);
    releaseLastWrite();
    await disposing;

    assert.deepEqual(persisted.get(projects[0]), ["late-a"]);
    assert.deepEqual(persisted.get(projects[1]), ["late-b"]);
  });
});

function globalThisBus() {
  return createDebugBus();
}
