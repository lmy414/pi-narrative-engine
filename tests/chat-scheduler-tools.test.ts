// tests/chat-scheduler-tools.test.ts
/**
 * 主会话编排器工具单测（C2 验收，stub service，不调 LLM）
 *
 * 断言：
 * - createSchedulerTools 注册 4 个工具（dispatch/commit/discard/queue_status）
 * - dispatch：schema 校验 + storyTime 格式拦截 + 转发 OrchestratorService.dispatch
 * - commit / discard / queue_status：参数转发与结果映射
 * - promptSnippet 全部提供（缺省不注入 systemPrompt，工具对 LLM 不可见）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createSchedulerTools,
  validateStoryTime,
  type OrchestratorProvider,
} from "../src/chat/scheduler-tools.ts";
import type { OrchestratorService } from "../src/orchestrator/service.ts";
import { assembleChatTools, createProjectStoryTimeStore } from "../src/app/chat-context.ts";
import { LlmConfigStore } from "../src/orchestrator/llm-config.ts";
import type { Search } from "../src/search.ts";
import type { Embedder } from "../src/embedder.ts";


const CTX = {} as ExtensionContext;

/** 记录调用的 stub OrchestratorService */
function makeStubService(): {
  service: OrchestratorService;
  calls: { method: string; args: unknown[] }[];
} {
  const calls: { method: string; args: unknown[] }[] = [];
  const service = {
    dispatch: (event: unknown) => {
      calls.push({ method: "dispatch", args: [event] });
      return { queueId: "q1", mode: "plan" as const, planId: "plan_1" };
    },
    commit: async (planId: string) => {
      calls.push({ method: "commit", args: [planId] });
      // BUG-014 异步化：返回 queueId + status
      return {
        ok: true,
        planId,
        queueId: "q-commit-1",
        status: "committing" as const,
      };
    },
    discard: (planId: string) => {
      calls.push({ method: "discard", args: [planId] });
      return { ok: true };
    },
    queueStatus: () => {
      calls.push({ method: "queueStatus", args: [] });
      return { length: 1, items: [{ queueId: "q1", status: "done" as const, enqueuedAt: 0 }] };
    },
  } as unknown as OrchestratorService;
  return { service, calls };
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text" && c.text !== undefined)
    .map((c) => c.text)
    .join("");
}

test("assembleChatTools：装配 31 个唯一工具且全部提供 promptSnippet", () => {
  const tools = assembleChatTools({
    service: makeStubService().service,
    dataAccess: {} as any,
    search: {} as Search,
    cwd: process.cwd(),
    embedder: {} as Embedder,
    llmStore: new LlmConfigStore(),
    currentStoryTime: null,
    setCurrentStoryTime() {},
  });
  assert.equal(tools.length, 31);
  assert.equal(new Set(tools.map(t => t.name)).size, 31);
  assert.ok(tools.every(t => t.promptSnippet));
});

test("assembleChatTools：world 工具共享最新 storyTime", async () => {
  let relationStoryTime: string | null = null;
  const tools = assembleChatTools({
    service: makeStubService().service,
    dataAccess: {
      processEvent: async () => {},
      addRelation: async (_source: string, _target: string, _label: string, storyTime: string) => { relationStoryTime = storyTime; },
    } as any,
    search: {} as Search,
    cwd: process.cwd(),
    embedder: {} as Embedder,
    llmStore: new LlmConfigStore(),
    currentStoryTime: null,
    setCurrentStoryTime() {},
  });
  await tools.find(t => t.name === "world_event_apply")!.execute("event", { eventId: "evt-1", type: "change", storyTime: "ch001.ev001", entityId: "e1" }, undefined, undefined, CTX);
  await tools.find(t => t.name === "world_relation_add")!.execute("relation", { sourceId: "e1", targetId: "e2", label: "knows" }, undefined, undefined, CTX);
  assert.equal(relationStoryTime, "ch001.ev001");
});

test("项目 storyTime：A→B→A 切换后状态互不泄漏", () => {
  const store = createProjectStoryTimeStore();
  store.set("/project-a", "ch001.ev001");
  store.set("/project-b", "ch009.ev003");
  assert.equal(store.get("/project-a"), "ch001.ev001");
  assert.equal(store.get("/project-b"), "ch009.ev003");
  assert.equal(store.get("/project-c"), null);
});

test("注册 4 个工具且全部提供 promptSnippet", () => {
  const tools = createSchedulerTools(() => makeStubService().service);
  assert.deepEqual(
    tools.map((t) => t.name),
    ["scheduler_dispatch", "scheduler_commit", "scheduler_discard", "scheduler_queue_status"],
  );
  for (const t of tools) {
    assert.ok(t.promptSnippet, `工具 ${t.name} 缺 promptSnippet（否则不注入 systemPrompt）`);
  }
});

test("scheduler_dispatch：转发事件并返回 queueId/planId", async () => {
  const { service, calls } = makeStubService();
  const [tool] = createSchedulerTools(() => service);
  const result = await tool.execute("tc1", {
    storyTime: "ch009.ev006",
    instruction: "林冲雪夜上梁山",
    characterIds: ["lin-chong"],
    mode: "plan",
  }, undefined, undefined, CTX);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "dispatch");
  const event = calls[0].args[0] as Record<string, unknown>;
  assert.deepEqual(
    { storyTime: event.storyTime, instruction: event.instruction, characterIds: event.characterIds, mode: event.mode },
    { storyTime: "ch009.ev006", instruction: "林冲雪夜上梁山", characterIds: ["lin-chong"], mode: "plan" },
  );
  assert.match(textOf(result), /queueId=q1/);
  assert.match(textOf(result), /planId=plan_1/);
  assert.equal((result as { details?: { planId: string } }).details?.planId, "plan_1");
});

test("validateStoryTime：按格式表校验", () => {
  for (const value of ["ch-9.ev6", "", "ch009.ev006"]) {
    if (value === "ch009.ev006") {
      assert.doesNotThrow(() => validateStoryTime(value));
    } else {
      assert.throws(() => validateStoryTime(value), /storyTime 格式非法/);
    }
  }
});

test("scheduler_dispatch：storyTime 格式非法被拦截", async () => {
  const { service, calls } = makeStubService();
  const [tool] = createSchedulerTools(() => service);
  await assert.rejects(
    tool.execute("tc2", { storyTime: "ch-9.ev6", instruction: "x", characterIds: [] }, undefined, undefined, CTX),
    /storyTime 格式非法/,
  );
  assert.equal(calls.length, 0, "非法输入不应触达编排器");
});

test("scheduler_commit：转发 planId 并映射结果", async () => {
  const { service, calls } = makeStubService();
  const tools = createSchedulerTools(() => service);
  const commitTool = tools.find((t) => t.name === "scheduler_commit")!;
  const result = await commitTool.execute("tc3", { planId: "plan_1" }, undefined, undefined, CTX);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { method: "commit", args: ["plan_1"] });
  assert.match(textOf(result), /已入队 plan plan_1/);
  assert.match(textOf(result), /q-commit-1/);
});

test("scheduler_discard：转发 planId 并映射结果", async () => {
  const { service, calls } = makeStubService();
  const tools = createSchedulerTools(() => service);
  const discardTool = tools.find((t) => t.name === "scheduler_discard")!;
  const result = await discardTool.execute("tc4", { planId: "plan_1" }, undefined, undefined, CTX);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { method: "discard", args: ["plan_1"] });
  assert.match(textOf(result), /已丢弃 plan plan_1/);
});

test("scheduler_queue_status：转发并返回队列 JSON", async () => {
  const { service, calls } = makeStubService();
  const tools = createSchedulerTools(() => service);
  const statusTool = tools.find((t) => t.name === "scheduler_queue_status")!;
  const result = await statusTool.execute("tc5", {}, undefined, undefined, CTX);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "queueStatus");
  const parsed = JSON.parse(textOf(result)) as { length: number; items: { status: string }[] };
  assert.equal(parsed.length, 1);
  assert.equal(parsed.items[0].status, "done");
});

// ============ B7：buildDispatchEvent 的会话级默认模式 ============

test("buildDispatchEvent：mode 缺省用会话级默认值，显式传参优先", async () => {
  const { buildDispatchEvent, setSchedulerDefaultMode } = await import(
    "../src/chat/scheduler-tools.ts"
  );
  const base = {
    storyTime: "ch001.ev001",
    instruction: "x",
    characterIds: ["a"],
  };
  const prev = buildDispatchEvent(base).mode;
  assert.equal(prev, "plan", "缺省默认 plan");

  setSchedulerDefaultMode("yolo");
  try {
    assert.equal(buildDispatchEvent(base).mode, "yolo", "默认值切换后生效");
    assert.equal(
      buildDispatchEvent({ ...base, mode: "plan" }).mode,
      "plan",
      "显式传参优先于默认值",
    );
  } finally {
    setSchedulerDefaultMode("plan");
  }
});
