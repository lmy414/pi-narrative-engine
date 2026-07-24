import { test } from "node:test";
import assert from "node:assert/strict";
import { characterActionTool } from "../src/role-pool-llm.ts";

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
