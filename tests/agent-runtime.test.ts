import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AgentOutputParseError,
  SubagentResourceLoader,
  extractFencedJson,
  toToolDefinition,
} from "../src/agents/agent-runtime.ts";

// ============================================================================
// SubagentResourceLoader
// ============================================================================

test("SubagentResourceLoader: getSystemPrompt 返回构造时的 systemPrompt", () => {
  const loader = new SubagentResourceLoader("你好，子代理");
  assert.equal(loader.getSystemPrompt(), "你好，子代理");
});

test("SubagentResourceLoader: 其余资源方法返回空结果", () => {
  const loader = new SubagentResourceLoader("sp");
  assert.deepEqual(loader.getAppendSystemPrompt(), []);
  assert.deepEqual(loader.getSkills().skills, []);
  assert.deepEqual(loader.getPrompts().prompts, []);
  assert.deepEqual(loader.getThemes().themes, []);
  assert.deepEqual(loader.getAgentsFiles().agentsFiles, []);
  assert.doesNotThrow(() => loader.extendResources());
  return loader.reload();
});

// ============================================================================
// extractFencedJson（三级容错）
// ============================================================================

test("extractFencedJson: L1 提取 ```json 围栏内 JSON", () => {
  const out = extractFencedJson('前文\n```json\n{"plan":"P1","items":[]}\n```\n后文');
  assert.deepEqual(out, { plan: "P1", items: [] });
});

test("extractFencedJson: L1 支持无 json 标记的裸围栏", () => {
  const out = extractFencedJson('```\n{"a":1}\n```');
  assert.deepEqual(out, { a: 1 });
});

test("extractFencedJson: L2 无围栏时提取第一个对象", () => {
  const out = extractFencedJson('结果如下：\n{"characterId":"e_lin","action":"拔剑"}');
  assert.deepEqual(out, { characterId: "e_lin", action: "拔剑" });
});

test("extractFencedJson: L2 提取数组", () => {
  const out = extractFencedJson('[{"a":1},{"b":2}]');
  assert.deepEqual(out, [{ a: 1 }, { b: 2 }]);
});

test("extractFencedJson: L3 全部失败抛 AgentOutputParseError 且附原始文本", () => {
  assert.throws(
    () => extractFencedJson("这是纯文本，没有 JSON"),
    (err: unknown) => {
      assert.ok(err instanceof AgentOutputParseError);
      assert.match(err.message, /无法从代理输出中提取有效 JSON/);
      assert.match(err.rawText, /这是纯文本/);
      return true;
    },
  );
});

test("extractFencedJson: 围栏内非 JSON 内容时回落到 L2 提取", () => {
  const out = extractFencedJson('```json\nnot valid json here at all\n```\n实际结果：{"ok":true}');
  assert.deepEqual(out, { ok: true });
});

// ============================================================================
// toToolDefinition（AgentTool → ToolDefinition 机械适配）
// ============================================================================

test("toToolDefinition: schema 直接复用，execute 忽略 ctx 参数", async () => {
  const called: unknown[] = [];
  const agentTool = {
    name: "world_status",
    label: "World Status",
    description: "状态",
    parameters: { type: "object" },
    executionMode: "sequential",
    async execute(toolCallId: string, params: unknown, signal?: unknown, onUpdate?: unknown) {
      called.push([toolCallId, params, signal, onUpdate]);
      return { content: [{ type: "text", text: "ok" }], details: { ok: true } };
    },
  };
  const def = toToolDefinition(agentTool as never);
  assert.equal(def.name, agentTool.name);
  assert.equal(def.label, agentTool.label);
  assert.equal(def.description, agentTool.description);
  assert.equal(def.parameters, agentTool.parameters);
  assert.equal(def.executionMode, "sequential");

  const ctx = { some: "ctx" };
  const result = await def.execute("t1", { p: 1 }, undefined, undefined, ctx as never);
  assert.deepEqual(result.details, { ok: true });
  // 第 5 个 ctx 不传给底层 AgentTool.execute
  assert.deepEqual(called, [["t1", { p: 1 }, undefined, undefined]]);
});