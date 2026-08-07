/**
 * resolve.test.ts — Task 3 单元测试
 *
 * 覆盖：
 * - entityId 生成（sha256 hash 8 位）
 * - Jaro-Winkler 相似度
 * - 一级：精确匹配
 * - 二级：相似度合并
 * - 三级：mock LLM 决策
 * - 编排 resolveEntities 端到端
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { EntityHint, LlmToolCaller, MergeDecision } from "../src/types.ts";

// ============================================================================
// 测试辅助
// ============================================================================

function makeHint(
  name: string,
  type: EntityHint["type"],
  opts: Partial<EntityHint> = {},
): EntityHint {
  return {
    name,
    type,
    aliases: opts.aliases ?? [],
    first_seen_chapter: opts.first_seen_chapter ?? 1,
    brief: opts.brief ?? "",
  };
}

/**
 * Mock LLM 调用器：根据预设决策返回
 */
function makeMockCaller(
  decisions: MergeDecision[],
): LlmToolCaller {
  return async () => ({ decisions });
}

// ============================================================================
// entityId 生成
// ============================================================================

test("generateEntityId: 基本格式 ent_{type}_{8hex}", async () => {
  const { generateEntityId } = await import("../src/resolve.ts");
  const id = generateEntityId("character", "酒寄彩叶", ["彩叶", "小彩叶"]);
  assert.match(id, /^ent_char_[a-f0-9]{8}$/);
});

test("generateEntityId: 不同 type 对应不同前缀", async () => {
  const { generateEntityId } = await import("../src/resolve.ts");
  const char = generateEntityId("character", "张三");
  const loc = generateEntityId("location", "张三");
  const item = generateEntityId("item", "张三");
  const conc = generateEntityId("concept", "张三");
  assert.match(char, /^ent_char_/);
  assert.match(loc, /^ent_loc_/);
  assert.match(item, /^ent_item_/);
  assert.match(conc, /^ent_conc_/);
});

test("generateEntityId: 同输入同输出（确定性）", async () => {
  const { generateEntityId } = await import("../src/resolve.ts");
  const id1 = generateEntityId("character", "彩叶", ["小彩叶"]);
  const id2 = generateEntityId("character", "彩叶", ["小彩叶"]);
  assert.equal(id1, id2);
})

test("generateEntityId: aliases 顺序不影响 hash（内部 sort）", async () => {
  const { generateEntityId } = await import("../src/resolve.ts");
  const id1 = generateEntityId("character", "彩叶", ["小彩叶", "大彩叶"]);
  const id2 = generateEntityId("character", "彩叶", ["大彩叶", "小彩叶"]);
  assert.equal(id1, id2);
});

test("generateEntityId: 不同 name 不同 hash", async () => {
  const { generateEntityId } = await import("../src/resolve.ts");
  const id1 = generateEntityId("character", "彩叶");
  const id2 = generateEntityId("character", "酒寄彩叶");
  assert.notEqual(id1, id2);
});

test("generateEntityId: name 出现在 aliases 中会被去重", async () => {
  const { generateEntityId } = await import("../src/resolve.ts");
  // name="彩叶"，aliases 包含 "彩叶" → 应去重，不重复 hash 输入
  const id1 = generateEntityId("character", "彩叶", ["彩叶", "小彩叶"]);
  const id2 = generateEntityId("character", "彩叶", ["小彩叶"]);
  assert.equal(id1, id2);
});

test("generateEntityId: 空 aliases 与无 aliases 等价", async () => {
  const { generateEntityId } = await import("../src/resolve.ts");
  const id1 = generateEntityId("character", "彩叶", []);
  const id2 = generateEntityId("character", "彩叶");
  assert.equal(id1, id2);
});

// ============================================================================
// Jaro-Winkler 相似度
// ============================================================================

test("jaroWinklerSimilarity: 完全相同 = 1", async () => {
  const { jaroWinklerSimilarity } = await import("../src/resolve.ts");
  assert.equal(jaroWinklerSimilarity("彩叶", "彩叶"), 1);
});

test("jaroWinklerSimilarity: 完全不同 = 0", async () => {
  const { jaroWinklerSimilarity } = await import("../src/resolve.ts");
  assert.equal(jaroWinklerSimilarity("abc", "xyz"), 0);
});

test("jaroWinklerSimilarity: 前缀加权（短字符串）", async () => {
  const { jaroWinklerSimilarity } = await import("../src/resolve.ts");
  // 共同前缀 "彩叶" → 应有较高相似度
  const sim = jaroWinklerSimilarity("彩叶酱", "彩叶");
  assert.ok(sim > 0.85, `expected > 0.85, got ${sim}`);
});

test(`jaroWinklerSimilarity: 子串关系（"酒寄彩叶"vs"彩叶"）`, async () => {
  const { jaroWinklerSimilarity } = await import("../src/resolve.ts");
  const sim = jaroWinklerSimilarity("酒寄彩叶", "彩叶");
  // Jaro-Winkler 受 match window 限制：长度差异大且无窗口内匹配时返回 0
  // 这是算法的预期行为，不是 bug（这类情况靠三级 LLM 判断）
  assert.ok(sim >= 0 && sim < 0.5, `expected [0, 0.5), got ${sim}`);
});

test("jaroWinklerSimilarity: 空字符串返回 0", async () => {
  const { jaroWinklerSimilarity } = await import("../src/resolve.ts");
  assert.equal(jaroWinklerSimilarity("", "abc"), 0);
  assert.equal(jaroWinklerSimilarity("abc", ""), 0);
});

// ============================================================================
// 一级：精确匹配
// ============================================================================

test("isExactMatch: name 相同 + type 相同 → true", async () => {
  const { isExactMatch } = await import("../src/resolve.ts");
  const a = makeHint("彩叶", "character");
  const b = makeHint("彩叶", "character");
  assert.equal(isExactMatch(a, b), true);
});

test("isExactMatch: name 相同但 type 不同 → false", async () => {
  const { isExactMatch } = await import("../src/resolve.ts");
  const a = makeHint("竹林", "location");
  const b = makeHint("竹林", "item");
  assert.equal(isExactMatch(a, b), false);
});

test("isExactMatch: a.aliases 包含 b.name → true", async () => {
  const { isExactMatch } = await import("../src/resolve.ts");
  const a = makeHint("酒寄彩叶", "character", { aliases: ["彩叶"] });
  const b = makeHint("彩叶", "character");
  assert.equal(isExactMatch(a, b), true);
});

test("isExactMatch: 双向 aliases 包含 → true", async () => {
  const { isExactMatch } = await import("../src/resolve.ts");
  const a = makeHint("酒寄彩叶", "character", { aliases: ["彩叶", "小彩叶"] });
  const b = makeHint("小彩叶", "character", { aliases: ["彩叶"] });
  assert.equal(isExactMatch(a, b), true);
});

test("isExactMatch: 完全不相关 → false", async () => {
  const { isExactMatch } = await import("../src/resolve.ts");
  const a = makeHint("彩叶", "character");
  const b = makeHint("竹林", "location");
  assert.equal(isExactMatch(a, b), false);
});

test("groupByExactMatch: 两个同 name 同 type → 1 组", async () => {
  const { groupByExactMatch } = await import("../src/resolve.ts");
  const hints = [
    makeHint("彩叶", "character"),
    makeHint("彩叶", "character"),
  ];
  const groups = groupByExactMatch(hints);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].length, 2);
});

test("groupByExactMatch: 不同 name 不合并 → 2 组", async () => {
  const { groupByExactMatch } = await import("../src/resolve.ts");
  const hints = [
    makeHint("彩叶", "character"),
    makeHint("转学生", "character"),
  ];
  const groups = groupByExactMatch(hints);
  assert.equal(groups.length, 2);
});

test("groupByExactMatch: 同 name 不同 type → 2 组", async () => {
  const { groupByExactMatch } = await import("../src/resolve.ts");
  const hints = [
    makeHint("竹林", "location"),
    makeHint("竹林", "item"),
  ];
  const groups = groupByExactMatch(hints);
  assert.equal(groups.length, 2);
});

test("groupByExactMatch: aliases 交叉合并", async () => {
  const { groupByExactMatch } = await import("../src/resolve.ts");
  // a.name="A", a.aliases=["X"]
  // b.name="B", b.aliases=["X"]  → A 和 B 都包含 X → 应合并
  const hints = [
    makeHint("A", "character", { aliases: ["X"] }),
    makeHint("B", "character", { aliases: ["X"] }),
  ];
  const groups = groupByExactMatch(hints);
  assert.equal(groups.length, 1);
});

test("groupByExactMatch: 传递合并（A-B 同，B-C 同 → A-B-C 合并）", async () => {
  const { groupByExactMatch } = await import("../src/resolve.ts");
  const hints = [
    makeHint("A", "character", { aliases: ["X"] }),
    makeHint("B", "character", { aliases: ["X", "Y"] }),
    makeHint("C", "character", { aliases: ["Y"] }),
  ];
  const groups = groupByExactMatch(hints);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].length, 3);
});

// ============================================================================
// 二级：相似度合并
// ============================================================================

test("mergeBySimilarity: 相似度 > 0.85 → 合并", async () => {
  const { mergeBySimilarity } = await import("../src/resolve.ts");
  // "彩叶" 和 "彩叶酱" 相似度 > 0.85
  const groups = [
    [makeHint("彩叶", "character")],
    [makeHint("彩叶酱", "character")],
  ];
  const result = mergeBySimilarity(groups);
  assert.equal(result.mergedGroups.length, 1);
  assert.equal(result.suspiciousPairs.length, 0);
});

test("mergeBySimilarity: 相似度 < 0.6 → 不合并，不进 suspicious", async () => {
  const { mergeBySimilarity } = await import("../src/resolve.ts");
  const groups = [
    [makeHint("abc", "character")],
    [makeHint("xyz", "character")],
  ];
  const result = mergeBySimilarity(groups);
  assert.equal(result.mergedGroups.length, 2);
  assert.equal(result.suspiciousPairs.length, 0);
});

test("mergeBySimilarity: 不同 type 不比较 → 不合并", async () => {
  const { mergeBySimilarity } = await import("../src/resolve.ts");
  const groups = [
    [makeHint("竹林", "location")],
    [makeHint("竹林", "item")],
  ];
  const result = mergeBySimilarity(groups);
  assert.equal(result.mergedGroups.length, 2);
});

test("mergeBySimilarity: 阈值参数生效", async () => {
  const { mergeBySimilarity } = await import("../src/resolve.ts");
  // 用高阈值让原本应该合并的不合并
  const groups = [
    [makeHint("彩叶", "character")],
    [makeHint("彩叶酱", "character")],
  ];
  const result = mergeBySimilarity(groups, 0.99);
  // 相似度不到 0.99，不合并，但可能进 suspicious
  assert.equal(result.mergedGroups.length, 2);
});

// ============================================================================
// 三级：LLM 决策
// ============================================================================

test("mergeByLLMJudgment: 无可疑对 → 空决策", async () => {
  const { mergeByLLMJudgment } = await import("../src/resolve.ts");
  let called = 0;
  const mockCaller: LlmToolCaller = async () => {
    called++;
    return { decisions: [] };
  };
  const result = await mergeByLLMJudgment([], mockCaller);
  assert.equal(result.length, 0);
  assert.equal(called, 0);
});

test("mergeByLLMJudgment: 单批 ≤25 对 → 调用 1 次", async () => {
  const { mergeByLLMJudgment } = await import("../src/resolve.ts");
  let called = 0;
  const pairs = Array.from({ length: 10 }, (_, i) => ({
    pair_id: `p${i}`,
    a: { name: `a${i}`, type: "character" as const, aliases: [], brief: "" },
    b: { name: `b${i}`, type: "character" as const, aliases: [], brief: "" },
    similarity: 0.7,
  }));
  const mockCaller: LlmToolCaller = async () => {
    called++;
    return {
      decisions: pairs.map((p) => ({
        pair_id: p.pair_id,
        should_merge: false,
        canonical_name: "",
        reason: "test",
      })),
    };
  };
  const result = await mergeByLLMJudgment(pairs, mockCaller);
  assert.equal(called, 1);
  assert.equal(result.length, 10);
});

test("mergeByLLMJudgment: >25 对分批调用", async () => {
  const { mergeByLLMJudgment } = await import("../src/resolve.ts");
  let called = 0;
  const pairs = Array.from({ length: 30 }, (_, i) => ({
    pair_id: `p${i}`,
    a: { name: `a${i}`, type: "character" as const, aliases: [], brief: "" },
    b: { name: `b${i}`, type: "character" as const, aliases: [], brief: "" },
    similarity: 0.7,
  }));
  const mockCaller: LlmToolCaller = async () => {
    called++;
    return {
      decisions: pairs.slice(0, 25).map((p) => ({
        pair_id: p.pair_id,
        should_merge: false,
        canonical_name: "",
        reason: "test",
      })),
    };
  };
  await mergeByLLMJudgment(pairs, mockCaller);
  // 30 对 / 25 = 2 批
  assert.equal(called, 2);
});

test("mergeByLLMJudgment: LLM 未返回 decisions 数组 → 抛错", async () => {
  const { mergeByLLMJudgment } = await import("../src/resolve.ts");
  const pairs = [{
    pair_id: "p1",
    a: { name: "a", type: "character" as const, aliases: [], brief: "" },
    b: { name: "b", type: "character" as const, aliases: [], brief: "" },
    similarity: 0.7,
  }];
  const mockCaller: LlmToolCaller = async () => ({});
  await assert.rejects(
    () => mergeByLLMJudgment(pairs, mockCaller),
    /未返回 decisions/,
  );
});

// ============================================================================
// 组合并
// ============================================================================

test("mergeGroupToCanonical: 合并多个 hint", async () => {
  const { mergeGroupToCanonical } = await import("../src/resolve.ts");
  const group = [
    makeHint("酒寄彩叶", "character", { aliases: ["彩叶"], first_seen_chapter: 3, brief: "主角" }),
    makeHint("小彩叶", "character", { aliases: ["彩叶酱"], first_seen_chapter: 1, brief: "" }),
  ];
  const c = mergeGroupToCanonical(group);
  assert.equal(c.name, "酒寄彩叶");
  assert.equal(c.type, "character");
  assert.deepEqual(c.aliases.sort(), ["彩叶", "彩叶酱", "小彩叶"].sort());
  assert.equal(c.first_seen_chapter, 1);
  assert.equal(c.brief, "主角");
});

test("mergeGroupToCanonical: 空组抛错", async () => {
  const { mergeGroupToCanonical } = await import("../src/resolve.ts");
  assert.throws(() => mergeGroupToCanonical([]), /空组/);
});

test("mergeGroupToCanonical: preferredName 优先作为规范名，原首 name 降为别名（🟡 4b 审计补测）", async () => {
  const { mergeGroupToCanonical } = await import("../src/resolve.ts");
  const group = [
    makeHint("酒寄彩叶", "character", { aliases: ["彩叶"], first_seen_chapter: 3 }),
    makeHint("小彩叶", "character", { aliases: ["彩叶酱"], first_seen_chapter: 1 }),
  ];
  // LLM 裁决的 canonical_name 与首 name 不同——必须生效
  const c = mergeGroupToCanonical(group, "叶彩");
  assert.equal(c.name, "叶彩", "preferredName 应优先作为规范名");
  assert.deepEqual(c.aliases.sort(), ["彩叶", "彩叶酱", "小彩叶", "酒寄彩叶"].sort(), "原首 name 应降为别名");
  assert.equal(c.first_seen_chapter, 1);
});

// ============================================================================
// 编排 resolveEntities（端到端）
// ============================================================================

test("resolveEntities: 空输入 → 空 canonicalMap", async () => {
  const { resolveEntities } = await import("../src/resolve.ts");
  const result = await resolveEntities([], {
    model: "test",
    apiKey: "test",
    callLlm: async () => ({ decisions: [] }),
  });
  assert.equal(result.canonicalMap.size, 0);
  assert.equal(result.aliasIndex.length, 0);
});

test("resolveEntities: 一级精确匹配（同 name 同 type）→ 1 组 1 entityId", async () => {
  const { resolveEntities } = await import("../src/resolve.ts");
  const hints = [
    makeHint("彩叶", "character"),
    makeHint("彩叶", "character"),
  ];
  const result = await resolveEntities(hints, {
    model: "test",
    apiKey: "test",
    callLlm: async () => ({ decisions: [] }),
  });
  assert.equal(result.aliasIndex.length, 1);
  assert.equal(result.aliasIndex[0].name, "彩叶");
  assert.match(result.aliasIndex[0].canonical_entityId, /^ent_char_/);
  assert.equal(result.canonicalMap.get("彩叶"), result.aliasIndex[0].canonical_entityId);
});

test("resolveEntities: 不同 name 不合并 → 多组", async () => {
  const { resolveEntities } = await import("../src/resolve.ts");
  const hints = [
    makeHint("彩叶", "character"),
    makeHint("转学生", "character"),
    makeHint("竹林", "location"),
  ];
  const result = await resolveEntities(hints, {
    model: "test",
    apiKey: "test",
    callLlm: async () => ({ decisions: [] }),
  });
  assert.equal(result.aliasIndex.length, 3);
});

test("resolveEntities: 不同 type 不合并（同 name）", async () => {
  const { resolveEntities } = await import("../src/resolve.ts");
  const hints = [
    makeHint("竹林", "location"),
    makeHint("竹林", "item"),
  ];
  const result = await resolveEntities(hints, {
    model: "test",
    apiKey: "test",
    callLlm: async () => ({ decisions: [] }),
  });
  assert.equal(result.aliasIndex.length, 2);
  assert.notEqual(
    result.aliasIndex[0].canonical_entityId,
    result.aliasIndex[1].canonical_entityId,
  );
});

test("resolveEntities: aliases 在 aliasIndex 中合并", async () => {
  const { resolveEntities } = await import("../src/resolve.ts");
  const hints = [
    makeHint("酒寄彩叶", "character", { aliases: ["彩叶"] }),
  ];
  const result = await resolveEntities(hints, {
    model: "test",
    apiKey: "test",
    callLlm: async () => ({ decisions: [] }),
  });
  assert.equal(result.aliasIndex.length, 1);
  assert.equal(result.aliasIndex[0].name, "酒寄彩叶");
  assert.deepEqual(result.aliasIndex[0].aliases, ["彩叶"]);
  // canonicalMap 同时包含 name 和 alias
  const id = result.aliasIndex[0].canonical_entityId;
  assert.equal(result.canonicalMap.get("酒寄彩叶"), id);
  assert.equal(result.canonicalMap.get("彩叶"), id);
});

test("resolveEntities: 三级 LLM 决策合并（mock）", async () => {
  const { resolveEntities } = await import("../src/resolve.ts");
  // 用相似度在可疑区间 [0.6, 0.85] 的字符串对
  // "彩叶" vs "彩香"：1 个共同前缀 + 1 个不同字符
  // jaro ≈ 0.667, jaro_winkler ≈ 0.7
  const hints = [
    makeHint("彩叶", "character", { brief: "主角" }),
    makeHint("彩香", "character", { brief: "主角" }),
  ];
  const mockDecisions: MergeDecision[] = [{
    pair_id: "p1",
    should_merge: true,
    canonical_name: "彩叶",
    reason: "一字之差，指向同一主角",
  }];
  const result = await resolveEntities(hints, {
    model: "test",
    apiKey: "test",
    callLlm: makeMockCaller(mockDecisions),
  });
  // 相似度在可疑区间，LLM 决定合并 → 应该只有 1 组
  assert.equal(result.aliasIndex.length, 1);
  assert.equal(result.aliasIndex[0].name, "彩叶");
});

test("resolveEntities: 三级 LLM 决策不合并（mock）", async () => {
  const { resolveEntities } = await import("../src/resolve.ts");
  // 用相似度在可疑区间 [0.6, 0.85] 的字符串对
  // "彩叶" vs "彩香"：1 个共同前缀 + 1 个不同字符
  // jaro ≈ 0.667, jaro_winkler ≈ 0.7
  const hints = [
    makeHint("彩叶", "character", { brief: "主角" }),
    makeHint("彩香", "character", { brief: "另一角色" }),
  ];
  const mockDecisions: MergeDecision[] = [{
    pair_id: "p1",
    should_merge: false,
    canonical_name: "",
    reason: "虽然名字相似，但是不同角色",
  }];
  const result = await resolveEntities(hints, {
    model: "test",
    apiKey: "test",
    callLlm: makeMockCaller(mockDecisions),
  });
  assert.equal(result.aliasIndex.length, 2);
});

test("resolveEntities: canonicalMap 对所有 name 和 aliases 都建立映射", async () => {
  const { resolveEntities } = await import("../src/resolve.ts");
  const hints = [
    makeHint("酒寄彩叶", "character", { aliases: ["彩叶", "小彩叶"] }),
    makeHint("竹林", "location"),
  ];
  const result = await resolveEntities(hints, {
    model: "test",
    apiKey: "test",
    callLlm: async () => ({ decisions: [] }),
  });
  const id1 = result.aliasIndex[0].canonical_entityId;
  assert.equal(result.canonicalMap.get("酒寄彩叶"), id1);
  assert.equal(result.canonicalMap.get("彩叶"), id1);
  assert.equal(result.canonicalMap.get("小彩叶"), id1);
  assert.ok(result.canonicalMap.has("竹林"));
});
