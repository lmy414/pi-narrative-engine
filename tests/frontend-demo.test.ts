/**
 * frontend-demo.test.ts — frontend-demo/demo-utils.js 纯函数测试
 *
 * demo-utils.js 是普通浏览器脚本（UMD：window.DemoUtils / module.exports），
 * 根 package 为 ESM（"type": "module"），直接 import 拿不到导出，
 * 测试用 vm 沙箱执行同一份源码并从 sandbox.window.DemoUtils 取 API，
 * 保证浏览器与测试共用同一份实现（DRY）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

const code = readFileSync(new URL("../frontend-demo/demo-utils.js", import.meta.url), "utf-8");
const sandbox: any = { window: {}, console, setTimeout };
sandbox.self = sandbox.window;
createContext(sandbox);
runInContext(code, sandbox);
const DemoUtils = sandbox.window.DemoUtils;

const {
  compareStoryTime,
  groupEventsByChapter,
  filterEvents,
  groupSessionsByTime,
  countWords,
  resolveTheme,
  namespaceState,
} = DemoUtils;

/**
 * vm 沙箱返回的数组/对象属于沙箱 realm，其原型与本测试 realm 不同，
 * deepStrictEqual 会因此判为不相等（报 "same structure but not reference-equal"）。
 * plain() 将跨 realm 值规范化为本 realm 的纯 JSON 值后再比较。
 */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ============ compareStoryTime ============

test("compareStoryTime: 按章节号与事件号升序比较", () => {
  assert.equal(compareStoryTime("ch001.ev001", "ch001.ev001"), 0);
  assert.equal(compareStoryTime("ch001.ev001", "ch001.ev002"), -1);
  assert.equal(compareStoryTime("ch001.ev002", "ch002.ev001"), -1);
  assert.equal(compareStoryTime("ch002.ev001", "ch001.ev002"), 1);
  assert.equal(compareStoryTime("ch002.ev001", "ch002.ev001"), 0);
});

test("compareStoryTime: Infinity 作为最大值", () => {
  assert.equal(compareStoryTime("ch006.ev008", "Infinity"), -1);
  assert.equal(compareStoryTime("Infinity", "ch006.ev008"), 1);
  assert.equal(compareStoryTime("Infinity", "Infinity"), 0);
});

test("compareStoryTime: 无效输入按 0 处理且不抛错", () => {
  assert.equal(compareStoryTime("garbage", "garbage"), 0);
  assert.equal(compareStoryTime("garbage", "ch001.ev001"), -1);
  assert.equal(compareStoryTime("ch001.ev001", "garbage"), 1);
  assert.equal(compareStoryTime("", "ch001.ev001"), -1);
  assert.equal(compareStoryTime(null, "ch001.ev001"), -1);
  assert.equal(compareStoryTime(undefined, "ch001.ev001"), -1);
});

// ============ groupEventsByChapter ============

test("groupEventsByChapter: 按章节分组并生成中文标题", () => {
  const events = [
    { eventId: "evt-01", storyTime: "ch001.ev001", summary: "a" },
    { eventId: "evt-02", storyTime: "ch001.ev002", summary: "b" },
    { eventId: "evt-03", storyTime: "ch002.ev003", summary: "c" },
    { eventId: "evt-04", storyTime: "ch003.ev005", summary: "d" },
  ];
  const groups = groupEventsByChapter(events);
  assert.deepEqual(plain(groups.map((g: any) => g.chapter)), ["ch001", "ch002", "ch003"]);
  assert.deepEqual(plain(groups.map((g: any) => g.title)), ["第一章", "第二章", "第三章"]);
  assert.deepEqual(plain(groups[0].events.map((e: any) => e.eventId)), ["evt-01", "evt-02"]);
  assert.deepEqual(plain(groups[2].events.map((e: any) => e.eventId)), ["evt-04"]);
});

test("groupEventsByChapter: 输入乱序仍按章节号升序且组内稳定", () => {
  const events = [
    { eventId: "e2", storyTime: "ch002.ev001" },
    { eventId: "e1", storyTime: "ch001.ev001" },
    { eventId: "e3", storyTime: "ch002.ev002" },
  ];
  const groups = groupEventsByChapter(events);
  assert.deepEqual(plain(groups.map((g: any) => g.chapter)), ["ch001", "ch002"]);
  assert.deepEqual(plain(groups[1].events.map((e: any) => e.eventId)), ["e2", "e3"]);
});

test("groupEventsByChapter: 空数组与无 storyTime 的事件不抛错", () => {
  assert.deepEqual(plain(groupEventsByChapter([])), []);
  const groups = groupEventsByChapter([{ eventId: "x" }]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].chapter, "");
  assert.equal(groups[0].title, "");
  assert.equal(groups[0].events.length, 1);
});

// ============ filterEvents ============

test("filterEvents: 空条件返回全部", () => {
  const events = [
    { eventId: "e1", type: "birth", entityId: "char-01", summary: "a" },
    { eventId: "e2", type: "death", entityId: "char-02", summary: "b" },
  ];
  assert.equal(filterEvents(events, {}), events);
  assert.equal(filterEvents(events), events);
  assert.equal(filterEvents(events, { entityIds: [], types: [], keyword: "" }), events);
});

test("filterEvents: 按实体筛选（含 newFacts 关联实体）", () => {
  const events = [
    { eventId: "e1", entityId: "char-01", newFacts: [], summary: "s1" },
    { eventId: "e2", entityId: "char-02", newFacts: [{ entityId: "char-03" }], summary: "s2" },
  ];
  assert.deepEqual(filterEvents(events, { entityIds: ["char-01"] }).map((e: any) => e.eventId), ["e1"]);
  assert.deepEqual(filterEvents(events, { entityIds: ["char-03"] }).map((e: any) => e.eventId), ["e2"]);
});

test("filterEvents: 按类型筛选", () => {
  const events = [
    { eventId: "e1", type: "birth", summary: "s1" },
    { eventId: "e2", type: "change", summary: "s2" },
    { eventId: "e3", type: "death", summary: "s3" },
  ];
  assert.deepEqual(filterEvents(events, { types: ["birth"] }).map((e: any) => e.eventId), ["e1"]);
  assert.deepEqual(filterEvents(events, { types: ["birth", "death"] }).map((e: any) => e.eventId), ["e1", "e3"]);
});

test("filterEvents: 关键词搜索 summary（忽略大小写）", () => {
  const events = [
    { eventId: "e1", summary: "林远航登上曙光号" },
    { eventId: "e2", summary: "艾莉亚加入曙光号" },
    { eventId: "e3", summary: "获得共鸣水晶" },
    { eventId: "e9", summary: "Find the Star Map" },
  ];
  assert.deepEqual(filterEvents(events, { keyword: "曙光号" }).map((e: any) => e.eventId), ["e1", "e2"]);
  assert.deepEqual(filterEvents(events, { keyword: "水晶" }).map((e: any) => e.eventId), ["e3"]);
  assert.deepEqual(filterEvents(events, { keyword: "star" }).map((e: any) => e.eventId), ["e9"]);
  assert.deepEqual(filterEvents(events, { keyword: "不存在" }), []);
});

test("filterEvents: 组合条件取交集", () => {
  const events = [
    { eventId: "e1", type: "birth", entityId: "char-01", summary: "林远航登上曙光号" },
    { eventId: "e2", type: "change", entityId: "char-01", summary: "获得共鸣水晶" },
    { eventId: "e3", type: "birth", entityId: "char-02", summary: "艾莉亚加入" },
  ];
  const r = filterEvents(events, { entityIds: ["char-01"], types: ["birth"] });
  assert.deepEqual(r.map((e: any) => e.eventId), ["e1"]);
});

// ============ groupSessionsByTime ============

test("groupSessionsByTime: 今天/昨天/更早分组（本地日历日）", () => {
  // 用本地时间构造固定 now，避免测试机时区影响
  const now = new Date(2026, 6, 15, 12, 0, 0); // 本地 2026-07-15 12:00
  const sessions = [
    { id: "today-1", modified: new Date(2026, 6, 15, 9, 30, 0).toISOString() },
    { id: "today-2", created: new Date(2026, 6, 15, 1, 0, 0).toISOString() },
    { id: "yesterday", modified: new Date(2026, 6, 14, 23, 0, 0).toISOString() },
    { id: "earlier", created: new Date(2026, 6, 10, 8, 0, 0).toISOString() },
  ];
  const groups = groupSessionsByTime(sessions, now.toISOString());
  assert.deepEqual(plain(groups.today.map((s: any) => s.id).sort()), ["today-1", "today-2"]);
  assert.deepEqual(plain(groups.yesterday.map((s: any) => s.id)), ["yesterday"]);
  assert.deepEqual(plain(groups.earlier.map((s: any) => s.id)), ["earlier"]);
});

test("groupSessionsByTime: modified 优先于 created", () => {
  const now = new Date(2026, 6, 15, 12, 0, 0);
  const sessions = [
    { id: "m", created: new Date(2026, 6, 1, 8, 0, 0).toISOString(), modified: new Date(2026, 6, 15, 8, 0, 0).toISOString() },
  ];
  assert.deepEqual(plain(groupSessionsByTime(sessions, now.toISOString()).today.map((s: any) => s.id)), ["m"]);
});

test("groupSessionsByTime: 空数组与非法时间不抛错", () => {
  const now = "2026-07-15T04:00:00Z";
  assert.deepEqual(plain(groupSessionsByTime([], now)), { today: [], yesterday: [], earlier: [] });
  const groups = groupSessionsByTime([{ id: "bad", modified: "not-a-date" }], now);
  assert.deepEqual(plain(groups.earlier.map((s: any) => s.id)), ["bad"]);
});

// ============ countWords ============

test("countWords: 中文按字符计、英文按单词计、混合相加", () => {
  assert.equal(countWords("你好世界"), 4);
  assert.equal(countWords("hello world"), 2);
  assert.equal(countWords("你好 world"), 3);
  assert.equal(countWords(""), 0);
  assert.equal(countWords(null), 0);
  assert.equal(countWords(undefined), 0);
});

// ============ resolveTheme ============

test("resolveTheme: 明确指定 light/dark", () => {
  assert.equal(resolveTheme("light"), "light");
  assert.equal(resolveTheme("dark"), "dark");
});

test("resolveTheme: system 在无 matchMedia 时回退 light", () => {
  delete sandbox.window.matchMedia;
  assert.equal(resolveTheme("system"), "light");
});

test("resolveTheme: system 跟随 matchMedia", () => {
  sandbox.window.matchMedia = (q: string) => ({ matches: q.indexOf("dark") >= 0 } as any);
  assert.equal(resolveTheme("system"), "dark");
  sandbox.window.matchMedia = () => ({ matches: false } as any);
  assert.equal(resolveTheme("system"), "light");
});

test("resolveTheme: 未知值回退 light", () => {
  assert.equal(resolveTheme("whatever"), "light");
});

// ============ namespaceState ============

test("namespaceState: 惰性创建命名空间并返回同一对象", () => {
  const state: any = {};
  const ns = namespaceState(state, "graph");
  assert.equal(state.graph, ns);
  assert.equal(typeof state.graph, "object");
  ns.selectedEntityId = "char-01";
  assert.equal(state.graph.selectedEntityId, "char-01");
  assert.equal(namespaceState(state, "graph"), ns);
});

test("namespaceState: 非对象值被替换为空对象", () => {
  const state: any = { bad: [1, 2, 3], nullish: null, str: "x" };
  assert.deepEqual(plain(namespaceState(state, "bad")), {});
  assert.deepEqual(plain(state.bad), {});
  assert.deepEqual(plain(namespaceState(state, "nullish")), {});
  assert.deepEqual(plain(namespaceState(state, "str")), {});
  assert.deepEqual(plain(namespaceState(state, "fresh")), {});
});

// ============ frontend-demo mock contract ============

const mockDataCode = readFileSync(new URL("../frontend-demo/mock-data.js", import.meta.url), "utf-8");
const apiMockCode = readFileSync(new URL("../frontend-demo/api-mock.js", import.meta.url), "utf-8");

function createMockApi() {
  const storage = new Map<string, string>();
  const context: any = {
    console,
    setTimeout,
    clearTimeout,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  };
  createContext(context);
  runInContext(mockDataCode, context);
  runInContext(apiMockCode, context);
  return runInContext("ApiMock", context);
}

test("ApiMock: list and config endpoints preserve real data wrappers", async () => {
  const api = createMockApi();
  const projects = await api.scanProjects("D:\\novels");
  const tree = await api.getFileTree();
  const sessions = await api.getChatSessions();
  const messages = await api.getChatMessages("session-03");
  const llm = await api.getLlmStatus();
  const rulesets = await api.getRulesets();
  const novel = await api.getNovelJson();
  const env = await api.getEnvConfig();

  assert.ok(Array.isArray(projects.data.projects));
  assert.ok(Array.isArray(tree.data.tree));
  assert.equal(tree.data.tree[0].kind, "dir");
  assert.equal("content" in tree.data.tree[0].children[0], false);
  assert.ok(Array.isArray(sessions.data.sessions));
  assert.equal(messages.data.id, "session-03");
  assert.ok(Array.isArray(messages.data.messages));
  assert.equal(typeof llm.data.slots, "object");
  assert.ok(Array.isArray(rulesets.data.rulesets));
  assert.equal(typeof novel.data.data, "object");
  assert.equal(typeof env.data.values, "object");
});

test("ApiMock: plan detail exposes outputs and completed planner/role stages", async () => {
  const api = createMockApi();
  const status = await api.getSchedulerStatus();
  const summary = status.data.plans[0];
  const detail = await api.getSchedulerPlan(summary.planId);

  assert.equal("stages" in summary, false);
  assert.ok(Array.isArray(detail.data.outputs));
  assert.deepEqual(
    plain(detail.data.stages.map((stage: any) => [stage.stage, stage.status])),
    [["planner", "done"], ["role", "done"]],
  );
});

test("ApiMock: chat and debug fixtures use target field sets", async () => {
  const api = createMockApi();
  const messages = (await api.getChatMessages("session-03")).data.messages;
  const assistant = messages.find((item: any) => item.toolCalls);
  assert.deepEqual(plain(Object.keys(assistant.toolCalls[0]).sort()), ["id", "isError", "name", "status"]);
  for (const item of messages) {
    assert.equal("roleTag" in item, false);
    assert.equal("characterId" in item, false);
  }

  const events = (await api.getDebugEvents()).data.events;
  const allowed = new Set(["id", "ts", "traceId", "stage", "status", "input", "output", "durationMs", "error", "parentId"]);
  assert.ok(events.length > 0);
  for (const event of events) {
    assert.ok(Object.keys(event).every((key) => allowed.has(key)));
    assert.ok(["start", "end", "error"].includes(event.status));
  }
});
