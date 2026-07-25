import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("prompt 资产：main-session.md 与 engine-guide.md 均存在且非空", () => {
  for (const name of ["main-session.md", "engine-guide.md"]) {
    const p = join(repoRoot, "src", "prompts", name);
    assert.ok(existsSync(p), `缺 src/prompts/${name}`);
    const content = readFileSync(p, "utf-8");
    assert.ok(content.length > 500, `${name} 内容异常（过短）`);
  }
});

test("engine-guide.md 覆盖关键纪律：流水线 / storyTime / plan 模式 / 常见错误", () => {
  const content = readFileSync(join(repoRoot, "src", "prompts", "engine-guide.md"), "utf-8");
  assert.match(content, /scheduler_dispatch/);
  assert.match(content, /ch\{NNN\}\.ev\{NNN\}/);
  assert.match(content, /planId/);
  assert.match(content, /常见错误/);
  assert.match(content, /userInput/);
});
