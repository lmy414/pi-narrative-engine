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

test("ApiMock: provider management endpoints map to backend contract", async () => {
  const api = createMockApi();

  // 初始列表含内置厂商
  const list1 = await api.getLlmProviders();
  assert.ok(Array.isArray(list1.data.providers));
  const builtins = list1.data.providers.filter((p: any) => p.builtin === true);
  assert.ok(builtins.length >= 1);
  assert.equal(builtins[0].kind, "builtin");

  // 保存自定义厂商后再次列出，应含该自定义项
  await api.saveLlmProvider(
    { id: "my-groq", name: "My Groq", baseURL: "https://x/v1", apiKind: "openai-completions", modelIds: ["m1"], fetchModels: false },
    "sk-xxx"
  );
  const list2 = await api.getLlmProviders();
  const custom = list2.data.providers.find((p: any) => p.id === "my-groq");
  assert.ok(custom, "saveLlmProvider 后应能在 providers 列表中找到自定义厂商");
  assert.equal(custom.kind, "custom");
  assert.equal(custom.builtin, false);
  assert.equal(custom.baseURL, "https://x/v1");
  assert.deepEqual(plain(custom.modelIds), ["m1"]);
  assert.equal(custom.hasKey, true);

  // 删除后从列表移除
  await api.deleteLlmProvider("my-groq");
  const list3 = await api.getLlmProviders();
  assert.equal(list3.data.providers.find((p: any) => p.id === "my-groq"), undefined);

  // 内置厂商模型枚举
  const models = await api.getLlmProviderModels("deepseek");
  assert.ok(Array.isArray(models.data.modelIds));
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

// ============ BUG-035: detailEffectiveStoryTime 兜底逻辑 ============

const entityDetailCode = readFileSync(new URL("../frontend-demo/views/entity-detail.js", import.meta.url), "utf-8");

/** 用 vm 沙箱加载 entity-detail.js（仅函数声明 + 常量，加载时不执行函数体），提供 mock App */
function loadEntityDetail(App: any): any {
  const context: any = {
    console, setTimeout, clearTimeout,
    App,
    // entity-detail.js 函数体引用的全局符号，加载时不会执行，仅调用时需要
    $: () => null, $$: () => [],
    apiCall: async () => ({}), icon: () => "", escapeHtml: (s: string) => s,
    q: (s: string) => "'" + String(s) + "'",
    withLoading: async (fn: Function) => fn(), toast: () => {},
    openDrawer: () => {}, closeDrawer: () => {}, openModal: () => {}, closeModal: () => {},
    refreshIcons: () => {}, navigate: () => {}, renderView: () => {}, render: () => {},
    confirm: () => true,
    ENTITY_TYPES: {}, MOCK_ENTITIES: [], ApiRuntime: { isMock: false },
    DemoUtils: { compareStoryTime: () => 0 },
  };
  createContext(context);
  runInContext(entityDetailCode, context);
  return context;
}

test("BUG-035: detailEffectiveStoryTime 在 App.storyTime 为 null 时回退到 storyTimes 末项", () => {
  const ctx = loadEntityDetail({ storyTime: null, storyTimes: ["ch001.ev001", "ch002.ev003"], viewState: {} });
  assert.equal(ctx.detailEffectiveStoryTime(), "ch002.ev003");
});

test("BUG-035: detailEffectiveStoryTime 在 App.storyTime 有值时直接返回", () => {
  const ctx = loadEntityDetail({ storyTime: "ch001.ev001", storyTimes: ["ch001.ev001", "ch002.ev003"], viewState: {} });
  assert.equal(ctx.detailEffectiveStoryTime(), "ch001.ev001");
});

test("BUG-035: detailEffectiveStoryTime 在 storyTime 和 storyTimes 均空时返回 null", () => {
  const ctx = loadEntityDetail({ storyTime: null, storyTimes: [], viewState: {} });
  assert.equal(ctx.detailEffectiveStoryTime(), null);
});

test("BUG-035: detailEffectiveStoryTime 在 storyTimes 为 undefined 时不抛错", () => {
  const ctx = loadEntityDetail({ storyTime: null, viewState: {} });
  assert.equal(ctx.detailEffectiveStoryTime(), null);
});

// ============ BUG-036: graphInit3D 增量更新 ============

/**
 * 与 app.js escapeHtml 同语义的 5 转义（🟠-23 2026-08-08）。
 * 测试注入用真实现（原恒等 stub 使渲染转义不可测）；
 * app.js 本体一致性由代码审查与浏览器测试轮覆盖。
 */
const REAL_ESCAPE_HTML = (s: string) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c],
  );

const graphCode = readFileSync(new URL("../frontend-demo/views/graph.js", import.meta.url), "utf-8");

/** 用 vm 沙箱加载 graph.js，mock ForceGraph3D/THREE/DOM，返回沙箱与调用计数 */
function loadGraphView(): { context: any; stats: { created: number; graphData: number; zoomToFit: number } } {
  const stats = { created: 0, graphData: 0, zoomToFit: 0 };
  const mockInstance: any = {
    graphData: (d?: any) => { if (d) stats.graphData++; return mockInstance; },
    width: () => mockInstance, height: () => mockInstance, backgroundColor: () => mockInstance,
    nodeThreeObject: () => mockInstance, nodeLabel: () => mockInstance, linkLabel: () => mockInstance,
    linkColor: () => mockInstance, linkWidth: () => mockInstance, linkOpacity: () => mockInstance,
    linkDirectionalArrowLength: () => mockInstance, linkDirectionalArrowRelPos: () => mockInstance,
    linkDirectionalArrowColor: () => mockInstance, onNodeClick: () => mockInstance, onBackgroundClick: () => mockInstance,
    d3Force: () => ({ strength: () => ({}), distance: () => ({}) }),
    onEngineTick: () => mockInstance, controls: () => ({ addEventListener: () => {} }),
    camera: () => ({ fov: 60, position: { distanceTo: () => 100 } }),
    pauseAnimation: () => {}, _destructor: () => {},
    zoomToFit: () => { stats.zoomToFit++; },
  };
  const container: any = {
    clientWidth: 800, clientHeight: 600, innerHTML: "",
    querySelector: () => null, appendChild: () => {},
  };
  const fakeDocEl: any = {};
  const context: any = {
    console,
    setTimeout: (fn: Function) => { fn(); return 0; }, // 立即执行（含 zoomToFit 延时）
    clearTimeout: () => {},
    App: { viewState: {}, storyTime: "ch001.ev001", storyTimes: ["ch001.ev001"] },
    viewState: (routeId: string) => {
      if (!context.App.viewState[routeId]) context.App.viewState[routeId] = {};
      return context.App.viewState[routeId];
    },
    $: () => container, $$: () => [],
    ForceGraph3D: () => (container: any) => { stats.created++; return mockInstance; },
    THREE: {
      Group: function () { this.add = () => {}; },
      SphereGeometry: function () {}, BoxGeometry: function () {},
      OctahedronGeometry: function () {}, TetrahedronGeometry: function () {},
      MeshLambertMaterial: function () {},
    },
    escapeHtml: REAL_ESCAPE_HTML, q: (s: string) => "'" + String(s) + "'",
    icon: () => "", ENTITY_TYPES: { character: { label: "角色", color: "#f00" } },
    getComputedStyle: () => ({ getPropertyValue: () => "#fff" }),
    document: { documentElement: fakeDocEl, createElement: () => ({ className: "", textContent: "", style: {}, appendChild: () => {} }) },
    ViewRender: {}, ViewAfterRender: {}, viewLoaders: {},
  };
  createContext(context);
  runInContext(graphCode, context);
  return { context, stats };
}

test("BUG-036: graphInit3D 首次调用创建实例并 zoomToFit，第二次走增量更新不重建不取景", () => {
  const { context, stats } = loadGraphView();
  // 注入测试数据
  context.setGraphState("graphData", {
    entities: [{ entityId: "e1", entityType: "character", properties: { name: "A" } }],
    relations: [],
  });
  // 第一次：_graph3d 为 null → 走创建路径
  context.graphInit3D();
  assert.equal(stats.created, 1, "首次调用应创建 ForceGraph3D 实例");
  assert.ok(stats.zoomToFit >= 1, "首次调用应触发 zoomToFit（setTimeout 立即执行）");

  const createdAfterFirst = stats.created;
  const zoomAfterFirst = stats.zoomToFit;

  // 第二次：_graph3d 已存在 → 走增量更新路径
  context.graphInit3D();
  assert.equal(stats.created, createdAfterFirst, "第二次调用不应创建新 ForceGraph3D 实例");
  assert.ok(stats.graphData >= 1, "第二次调用应通过 graphData 增量更新");
  assert.equal(stats.zoomToFit, zoomAfterFirst, "第二次调用不应触发 zoomToFit");
});

// ============ 🟠-23: 转义族回归（2026-08-08） ============
// flJs（files.js）/ settingsJs（settings.js）与 q() 同一实现模式，
// 转义一致性由子代理代码审计 + 浏览器测试轮覆盖（此处 q() 为唯一可
// 直接注入的公共实现，测试其 `"` 转义即代表该模式）。

test("q(): 输出经 HTML 属性解析安全——双引号/与号走实体层（🟠-23）", () => {
  const q = sandbox.q as (s: string) => string;
  // 双引号 → &quot;（实体层：HTML 属性值内解码为字面字符、不闭合属性；
  // 反斜杠在 HTML 属性解析中无转义语义，\" 里的 " 仍会闭合 onclick="..." 注入处理器）
  const payload = 'a" onmouseover="alert(1)';
  const out = q(payload);
  assert.ok(!out.includes('"'), `q() 输出不得含裸双引号: ${out}`);
  assert.ok(out.includes("&quot;"), `应包含 &quot; 实体: ${out}`);
  // 与号先转：输入含 &quot; 字面时不得二次解码为裸引号
  assert.equal(q('a&b'), "'a&amp;b'");
  assert.equal(q('&quot;x'), "'&amp;quot;x'", "输入含 &quot; 字面时不得二次解码绕过");
  // 既有 JS 层转义不回归（单引号/反斜杠/换行）
  assert.equal(q("it's"), "'it\\'s'");
  assert.equal(q("a\\b"), "'a\\\\b'");
  assert.equal(q("a\nb"), "'a\\nb'");
});

test("graph.js: data-entity-id 属性经 escapeHtml 转义，无属性注入（🟠-23）", () => {
  const { context } = loadGraphView();
  const html = context.graphEntityItemHtml(
    {
      entityId: 'evil" onmouseover="alert(1)',
      entityType: "character",
      properties: { name: "测试实体" },
      summary: "",
    },
    null,
  );
  // 属性值中的双引号必须被转义为 &quot;（否则可注入 onmouseover 处理器）
  assert.ok(html.includes("&quot;"), `data-entity-id 应转义双引号: ${html}`);
  assert.ok(
    !/data-entity-id="[^"]*"[^>]*onmouseover=/.test(html),
    "不应存在属性注入（onmouseover 被注入）",
  );
  assert.ok(html.includes('data-entity-id="evil&quot; onmouseover=&quot;alert(1)"'), "转义后的属性值应完整保留");
});
