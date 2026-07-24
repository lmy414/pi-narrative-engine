import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toRoleOutputs,
  extractStateChanges,
  extractRelations,
} from "../src/transforms.ts";
import type { RoleAgentOutput, StateChange } from "../src/types.ts";

// ============================================================================
// toRoleOutputs：投影为渲染器格式（去掉 state_changes）
// ============================================================================

test("toRoleOutputs: 去掉 state_changes 字段", () => {
  const outputs: RoleAgentOutput[] = [
    {
      actor: "林冲",
      action: "举杯",
      state_changes: [
        { entityId: "linchong", property: "mood", value: "怒", modality: "fact" },
      ],
    },
  ];
  const rendered = toRoleOutputs(outputs);
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].actor, "林冲");
  assert.equal(rendered[0].action, "举杯");
  // state_changes 不应出现在结果中
  assert.ok(!("state_changes" in rendered[0]), "不应包含 state_changes");
});

test("toRoleOutputs: 保留其他 7 字段", () => {
  const outputs: RoleAgentOutput[] = [
    {
      actor: "林冲",
      action: "行礼",
      target: "师父",
      emotion: "敬意",
      relation_update: [{ target: "师父", label: "师徒" }],
      thought: "多年未见",
      knowledge_gained: ["师父老了"],
      state_changes: [
        { entityId: "linchong", property: "mood", value: "怀念", modality: "fact" },
      ],
    },
  ];
  const rendered = toRoleOutputs(outputs);
  assert.equal(rendered[0].target, "师父");
  assert.equal(rendered[0].emotion, "敬意");
  assert.equal(rendered[0].relation_update!.length, 1);
  assert.equal(rendered[0].thought, "多年未见");
  assert.equal(rendered[0].knowledge_gained!.length, 1);
});

test("toRoleOutputs: 无 state_changes 时正常投影", () => {
  const outputs: RoleAgentOutput[] = [
    { actor: "武松", action: "大笑" },
  ];
  const rendered = toRoleOutputs(outputs);
  assert.equal(rendered[0].actor, "武松");
  assert.ok(!("state_changes" in rendered[0]));
});

test("toRoleOutputs: 空数组返回空数组", () => {
  assert.deepEqual(toRoleOutputs([]), []);
});

// ============================================================================
// extractStateChanges：提取所有状态变更（扁平化）
// ============================================================================

test("extractStateChanges: 单角色单变更", () => {
  const outputs: RoleAgentOutput[] = [
    {
      actor: "林冲",
      action: "举杯",
      state_changes: [
        { entityId: "linchong", property: "mood", value: "怒", modality: "fact" },
      ],
    },
  ];
  const facts = extractStateChanges(outputs);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].entityId, "linchong");
  assert.equal(facts[0].property, "mood");
  assert.equal(facts[0].value, "怒");
  assert.equal(facts[0].modality, "fact");
});

test("extractStateChanges: 多角色多变更扁平化", () => {
  const outputs: RoleAgentOutput[] = [
    {
      actor: "林冲",
      action: "a1",
      state_changes: [
        { entityId: "linchong", property: "mood", value: "怒", modality: "fact" },
        { entityId: "linchong", property: "location", value: "山神庙", modality: "fact" },
      ],
    },
    {
      actor: "武松",
      action: "a2",
      state_changes: [
        { entityId: "wusong", property: "drunk", value: true, modality: "belief" },
      ],
    },
  ];
  const facts = extractStateChanges(outputs);
  assert.equal(facts.length, 3);
  assert.equal(facts[0].entityId, "linchong");
  assert.equal(facts[1].property, "location");
  assert.equal(facts[2].entityId, "wusong");
  assert.equal(facts[2].modality, "belief");
});

test("extractStateChanges: 无 state_changes 的角色被跳过", () => {
  const outputs: RoleAgentOutput[] = [
    { actor: "林冲", action: "a1" },
    {
      actor: "武松",
      action: "a2",
      state_changes: [
        { entityId: "wusong", property: "mood", value: "喜", modality: "fact" },
      ],
    },
  ];
  const facts = extractStateChanges(outputs);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].entityId, "wusong");
});

test("extractStateChanges: 全部无 state_changes 返回空数组", () => {
  const outputs: RoleAgentOutput[] = [
    { actor: "a", action: "b" },
    { actor: "c", action: "d" },
  ];
  assert.deepEqual(extractStateChanges(outputs), []);
});

test("extractStateChanges: 结构兼容 newFacts（entityId/property/value/modality）", () => {
  const outputs: RoleAgentOutput[] = [
    {
      actor: "x",
      action: "y",
      state_changes: [
        { entityId: "e1", property: "p1", value: 42, modality: "hypothesis" },
      ],
    },
  ];
  const facts: StateChange[] = extractStateChanges(outputs);
  // 模拟 world_event_apply 的 newFacts 结构校验
  for (const f of facts) {
    assert.equal(typeof f.entityId, "string");
    assert.equal(typeof f.property, "string");
    assert.ok(["fact", "belief", "hypothesis"].includes(f.modality));
  }
});

// ============================================================================
// extractRelations：提取关系变更（关联 actor 作为 source）
// ============================================================================

test("extractRelations: 单角色单关系，source 取自 actor", () => {
  const outputs: RoleAgentOutput[] = [
    {
      actor: "林冲",
      action: "行礼",
      relation_update: [{ target: "师父", label: "师徒" }],
    },
  ];
  const rels = extractRelations(outputs);
  assert.equal(rels.length, 1);
  assert.equal(rels[0].source, "林冲");
  assert.equal(rels[0].target, "师父");
  assert.equal(rels[0].label, "师徒");
});

test("extractRelations: 多角色多关系扁平化", () => {
  const outputs: RoleAgentOutput[] = [
    {
      actor: "林冲",
      action: "a1",
      relation_update: [
        { target: "师父", label: "师徒" },
        { target: "陆谦", label: "仇敌" },
      ],
    },
    {
      actor: "武松",
      action: "a2",
      relation_update: [{ target: "施恩", label: "结义" }],
    },
  ];
  const rels = extractRelations(outputs);
  assert.equal(rels.length, 3);
  assert.equal(rels[0].source, "林冲");
  assert.equal(rels[0].target, "师父");
  assert.equal(rels[1].source, "林冲");
  assert.equal(rels[1].target, "陆谦");
  assert.equal(rels[2].source, "武松");
  assert.equal(rels[2].target, "施恩");
});

test("extractRelations: 无 relation_update 的角色被跳过", () => {
  const outputs: RoleAgentOutput[] = [
    { actor: "林冲", action: "a1" },
    {
      actor: "武松",
      action: "a2",
      relation_update: [{ target: "施恩", label: "结义" }],
    },
  ];
  const rels = extractRelations(outputs);
  assert.equal(rels.length, 1);
  assert.equal(rels[0].source, "武松");
});

test("extractRelations: 全部无 relation_update 返回空数组", () => {
  const outputs: RoleAgentOutput[] = [
    { actor: "a", action: "b" },
    { actor: "c", action: "d" },
  ];
  assert.deepEqual(extractRelations(outputs), []);
});
