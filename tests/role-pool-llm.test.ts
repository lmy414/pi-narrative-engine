import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { characterActionSchema } from "../src/agents/tools.ts";
import { characterActionTool, createRoleTools } from "../src/chat/role-tools.ts";
import { LlmConfigStore } from "../src/orchestrator/llm-config.ts";

test("createRoleTools：注册 2 个唯一工具且全部提供 promptSnippet", () => {
  const store = new LlmConfigStore();
  store.setConfig("role", { model: { provider: "deepseek", name: "deepseek-v4-flash" }, apiKey: "test-key" });
  const tools = createRoleTools({ cwd: process.cwd(), llmStore: store });
  assert.deepEqual(tools.map(t => t.name), ["role_interact", "role_rule_set"]);
  assert.ok(tools.every(t => t.promptSnippet));
});

test("createRoleTools：执行时读取 role slot 的 model 和 apiKey", async () => {
  const calls: string[] = [];
  const llmStore = {
    getModel(slot: string) { calls.push(`model:${slot}`); return { provider: "test", id: "role-model" }; },
    getApiKey(slot: string) { calls.push(`key:${slot}`); return "role-key"; },
    getHeaders() { return undefined; },
  } as unknown as LlmConfigStore;
  const tools = createRoleTools({
    cwd: process.cwd(),
    llmStore,
    createLlmCaller(model, apiKey) {
      assert.equal(model.id, "role-model");
      assert.equal(apiKey, "role-key");
      return async () => ({ characterId: "e1", actor: "甲", action: "行动" });
    },
  });
  const interact = tools.find(tool => tool.name === "role_interact")!;
  const result = await interact.execute("role", {
    eventInstruction: "行动",
    storyTime: "ch001.ev001",
    cast: [{ characterId: "e1", staticCard: { name: "甲" }, dynamicFacts: [] }],
  }, undefined, undefined, {} as never);
  assert.deepEqual(calls, ["model:role", "key:role"]);
  assert.equal(result.details.outputs.length, 1);
});

test("createRoleTools：2 个工具均可执行并返回 content/details envelope", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "role-tools-"));
  try {
    await writeFile(path.join(dir, "角色规则集.md"), "角色规则", "utf8");
    const store = new LlmConfigStore();
    store.setConfig("role", { model: { provider: "deepseek", name: "deepseek-v4-flash" }, apiKey: "test-key" });
    const tools = createRoleTools({
      cwd: dir,
      llmStore: store,
      createLlmCaller: () => async () => ({ characterId: "e1", actor: "甲", action: "行动" }),
    });
    const params: Record<string, Record<string, unknown>> = {
      role_interact: { eventInstruction: "行动", storyTime: "ch001.ev001", cast: [{ characterId: "e1", staticCard: { name: "甲" }, dynamicFacts: [] }] },
      role_rule_set: {},
    };
    for (const tool of tools) {
      const result = await tool.execute(tool.name, params[tool.name]!, undefined, undefined, {} as never);
      assert.ok(Array.isArray(result.content), `${tool.name} 应返回 content`);
      assert.ok("details" in result, `${tool.name} 应返回 details`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("characterActionTool: 工具名是 character_action", () => {
  assert.equal(characterActionTool.name, "character_action");
});

test("characterActionTool: 参数 schema 含 actor + action 必填", () => {
  const params = characterActionTool.parameters as { properties: Record<string, unknown> };
  assert.ok(params.properties.actor, "应有 actor 字段");
  assert.ok(params.properties.action, "应有 action 字段");
});

test("characterActionTool: 参数 schema 含 8 个字段", () => {
  const params = characterActionTool.parameters as { properties: Record<string, unknown> };
  const expectedFields = [
    "actor", "action", "target", "emotion",
    "relation_update", "thought", "knowledge_gained", "state_changes",
  ];
  for (const field of expectedFields) {
    assert.ok(params.properties[field], `应有 ${field} 字段`);
  }
});
