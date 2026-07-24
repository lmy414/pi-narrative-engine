import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  RoleAgentOutput,
  StateChange,
  CastMember,
  InteractCommand,
  InteractResult,
  PriorAction,
  SillyTavernCard,
  FactSnapshot,
} from "../src/types.ts";

test("RoleAgentOutput: 必填字段 actor + action", () => {
  const output: RoleAgentOutput = { actor: "林冲", action: "举杯" };
  assert.equal(output.actor, "林冲");
  assert.equal(output.action, "举杯");
  assert.equal(output.target, undefined);
  assert.equal(output.state_changes, undefined);
});

test("RoleAgentOutput: 全字段填充", () => {
  const output: RoleAgentOutput = {
    actor: "林冲",
    action: "向师父行礼",
    target: "师父",
    emotion: "敬意",
    relation_update: [{ target: "师父", label: "师徒" }],
    thought: "多年未见",
    knowledge_gained: ["师父老了"],
    state_changes: [{
      entityId: "linchong",
      property: "mood",
      value: "怀念",
      modality: "fact",
    }],
  };
  assert.equal(output.state_changes!.length, 1);
  assert.equal(output.relation_update!.length, 1);
});

test("StateChange: modality 三值", () => {
  const fact: StateChange = { entityId: "a", property: "p", value: 1, modality: "fact" };
  const belief: StateChange = { entityId: "a", property: "p", value: 1, modality: "belief" };
  const hypo: StateChange = { entityId: "a", property: "p", value: 1, modality: "hypothesis" };
  assert.equal(fact.modality, "fact");
  assert.equal(belief.modality, "belief");
  assert.equal(hypo.modality, "hypothesis");
});

test("CastMember: 静态层 + 动态层", () => {
  const card: SillyTavernCard = { name: "林冲", description: "豹头环眼" };
  const facts: FactSnapshot[] = [{
    declarationId: "d1",
    entityId: "linchong",
    property: "mood",
    value: "愤怒",
    modality: "fact",
    validFrom: "ch-1",
  }];
  const member: CastMember = {
    characterId: "linchong",
    staticCard: card,
    dynamicFacts: facts,
  };
  assert.equal(member.staticCard.name, "林冲");
  assert.equal(member.dynamicFacts.length, 1);
});

test("PriorAction: 只含公开字段", () => {
  const action: PriorAction = { actor: "林冲", action: "举杯", target: "师父" };
  assert.equal(Object.keys(action).length, 3);
});

test("InteractResult: outputs + errors", () => {
  const result: InteractResult = { outputs: [], errors: [] };
  assert.equal(result.outputs.length, 0);
  assert.equal(result.errors.length, 0);
});
