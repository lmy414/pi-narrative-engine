import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 解析 SKILL.md frontmatter（YAML，仅取 name 与 description 字段）
 * 不引入 yaml 依赖：pi 自身用 yaml 包，但本测试只需两个字段，简单正则即可。
 */
function parseSkillFrontmatter(filePath: string): { name: string; description: string; body: string } {
  const raw = readFileSync(filePath, "utf8");
  assert.ok(raw.startsWith("---"), `frontmatter 必须以 --- 开头: ${filePath}`);
  const end = raw.indexOf("\n---", 3);
  assert.ok(end !== -1, `frontmatter 必须有结束 ---: ${filePath}`);
  const fm = raw.slice(4, end);
  const body = raw.slice(end + 4).trim();
  const nameMatch = fm.match(/^name:\s*(.+)$/m);
  const descMatch = fm.match(/^description:\s*(.+)$/m);
  assert.ok(nameMatch, `frontmatter 缺 name: ${filePath}`);
  assert.ok(descMatch, `frontmatter 缺 description: ${filePath}`);
  return { name: nameMatch[1].trim(), description: descMatch[1].trim(), body };
}

test("skills 资产：narrative-engine SKILL.md 存在且 frontmatter 合法", () => {
  const p = join(repoRoot, "src", "skills", "narrative-engine", "SKILL.md");
  assert.ok(existsSync(p), `缺 src/skills/narrative-engine/SKILL.md`);
  const { name, description, body } = parseSkillFrontmatter(p);
  // pi skill name 验证规则：小写 a-z 0-9 连字符，且与父目录名一致
  assert.equal(name, "narrative-engine", `name 应等于父目录名`);
  assert.match(name, /^[a-z0-9-]+$/, `name 含非法字符: ${name}`);
  assert.ok(description.length > 50, `description 过短（应明确说明何时使用）`);
  assert.ok(description.length <= 1024, `description 超过 1024 字符上限`);
  assert.ok(body.length > 500, `body 内容异常（过短）`);
});

test("narrative-engine SKILL.md 覆盖身份 + 流水线 + 工具纪律三大主题", () => {
  const p = join(repoRoot, "src", "skills", "narrative-engine", "SKILL.md");
  const { body } = parseSkillFrontmatter(p);
  // 身份与意图分类（原 main-session）
  assert.match(body, /不参与叙事/);
  assert.match(body, /意图分类/);
  // 流水线与工具纪律（原 engine-guide）
  assert.match(body, /scheduler_dispatch/);
  assert.match(body, /流水线/);
  assert.match(body, /工具选择决策树/);
  // storyTime 格式纪律
  assert.match(body, /ch\{NNN\}\.ev\{NNN\}/);
  // plan 模式人在回路
  assert.match(body, /planId/);
  // 常见错误清单
  assert.match(body, /常见错误/);
  assert.match(body, /userInput/);
  // 撤销机制 Git revert
  assert.match(body, /Git revert/);
  // §16 遇到问题怎么办：触发条件 + 文档清单 + 纪律
  assert.match(body, /遇到问题怎么办/);
  assert.match(body, /references\/api\/README\.md/);
  assert.match(body, /references\/plans/);
  assert.match(body, /先读文档再回复用户/);
  assert.match(body, /文档与代码冲突时以代码为准/);
});

test("skills 目录下只有一个 skill（合并后不再拆分）", () => {
  const skillsDir = join(repoRoot, "src", "skills");
  const entries = readdirSync(skillsDir);
  for (const entry of entries) {
    const skillFile = join(skillsDir, entry, "SKILL.md");
    assert.ok(existsSync(skillFile), `skills/${entry}/ 缺 SKILL.md`);
  }
  // 合并后应只有 narrative-engine 一个
  assert.deepEqual(entries, ["narrative-engine"], `skills/ 应只含 narrative-engine`);
});

test("build 产物：references/ 目录存在且包含精选文档（构建后运行此测试）", () => {
  const refsDir = join(repoRoot, "dist", "skills", "narrative-engine", "references");
  if (!existsSync(refsDir)) {
    // 未构建时跳过（CI 会先 build 再 test）
    return;
  }
  const expectedDocs = [
    "api/README.md",
    "novel-project-structure.md",
    "plans/2026-07-25-scheduler-design.md",
    "plans/2026-07-24-role-pool-design.md",
    "plans/2026-07-24-renderer.md",
    "audits/2026-07-27-fix-plan.md",
  ];
  for (const rel of expectedDocs) {
    assert.ok(existsSync(join(refsDir, rel)), `缺 references/${rel}`);
  }
});
