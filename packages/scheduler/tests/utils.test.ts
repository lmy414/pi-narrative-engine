// tests/utils.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomId, groupBy } from "../src/utils.ts";

// ============================================================================
// randomId
// ============================================================================

test("randomId: 默认长度 6", () => {
  const id = randomId();
  assert.equal(id.length, 6);
});

test("randomId: 自定义长度", () => {
  assert.equal(randomId(10).length, 10);
  assert.equal(randomId(0).length, 0);
  assert.equal(randomId(20).length, 20);
});

test("randomId: 只含小写字母和数字", () => {
  for (let i = 0; i < 50; i++) {
    const id = randomId(8);
    assert.ok(/^[a-z0-9]+$/.test(id), `id 含非法字符: ${id}`);
  }
});

test("randomId: 多次调用结果不同（极大概率）", () => {
  const ids = new Set<string>();
  for (let i = 0; i < 100; i++) {
    ids.add(randomId(10));
  }
  // 100 个 36^10 的随机串碰撞概率几乎为 0
  assert.equal(ids.size, 100);
});

// ============================================================================
// groupBy
// ============================================================================

test("groupBy: 按 key 函数分组", () => {
  const arr = [
    { name: "a", val: 1 },
    { name: "b", val: 2 },
    { name: "a", val: 3 },
    { name: "b", val: 4 },
    { name: "a", val: 5 },
  ];
  const grouped = groupBy(arr, (x) => x.name);
  assert.equal(grouped.size, 2);
  assert.equal(grouped.get("a")!.length, 3);
  assert.equal(grouped.get("b")!.length, 2);
  assert.deepEqual(
    grouped.get("a")!.map((x) => x.val),
    [1, 3, 5],
  );
});

test("groupBy: 空数组返回空 Map", () => {
  const grouped = groupBy([], (x: number) => x);
  assert.equal(grouped.size, 0);
});

test("groupBy: 单元素数组", () => {
  const grouped = groupBy([42], (x) => "key");
  assert.equal(grouped.size, 1);
  assert.equal(grouped.get("key")!.length, 1);
  assert.equal(grouped.get("key")![0], 42);
});

test("groupBy: 所有元素同 key", () => {
  const grouped = groupBy([1, 2, 3], (_) => "same");
  assert.equal(grouped.size, 1);
  assert.equal(grouped.get("same")!.length, 3);
});

test("groupBy: 所有元素不同 key", () => {
  const grouped = groupBy([1, 2, 3], (x) => x);
  assert.equal(grouped.size, 3);
  assert.equal(grouped.get(1)![0], 1);
  assert.equal(grouped.get(2)![0], 2);
  assert.equal(grouped.get(3)![0], 3);
});

test("groupBy: 按 entityId 分组（调度器 commit 场景）", () => {
  const changes = [
    { entityId: "linchong", property: "mood", value: "怒" },
    { entityId: "linchong", property: "location", value: "山神庙" },
    { entityId: "wusong", property: "drunk", value: true },
  ];
  const byEntity = groupBy(changes, (c) => c.entityId);
  assert.equal(byEntity.size, 2);
  assert.equal(byEntity.get("linchong")!.length, 2);
  assert.equal(byEntity.get("wusong")!.length, 1);
});
