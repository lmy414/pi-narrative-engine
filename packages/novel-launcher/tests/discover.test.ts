// packages/novel-launcher/tests/discover.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  discoverProjects,
  getProjectMeta,
  _readNovelJson,
  _countChapters,
} from "../src/index.ts";
import { NovelLauncherError } from "../src/index.ts";

function novelJson(name: string): string {
  return JSON.stringify({
    name,
    engine: "narrative-engine",
    engineVersion: "0.1.0",
    worldGraphDir: ".pi/world-graph-v3",
    chaptersDir: "正文",
    storyTimeFormat: "ch{NNN}.ev{NNN}",
    createdAt: "2026-07-29",
  });
}

async function makeProject(
  root: string,
  relPath: string,
  name: string,
  chapters: string[] = [],
): Promise<void> {
  const dir = join(root, relPath);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "novel.json"), novelJson(name), "utf8");
  if (chapters.length > 0) {
    const chDir = join(dir, "正文");
    await mkdir(chDir, { recursive: true });
    for (const ch of chapters) {
      await writeFile(join(chDir, ch), `# ${ch}`, "utf8");
    }
  }
}

test("discoverProjects 扫描所有含 novel.json 的目录", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-launcher-"));
  try {
    await makeProject(root, "projectA", "项目A", ["第1章.md"]);
    await makeProject(root, "projectB", "项目B");
    await mkdir(join(root, "notanovel"), { recursive: true });
    await makeProject(root, "nested/projectC", "项目C");

    const projects = await discoverProjects(root);
    assert.equal(projects.length, 3);
    const names = projects.map((p) => p.meta.name).sort();
    assert.deepEqual(names, ["项目A", "项目B", "项目C"]);

    const a = projects.find((p) => p.meta.name === "项目A")!;
    assert.equal(a.chapterCount, 1);
    assert.ok(a.dir.includes("projectA"));
    assert.ok(a.relativePath.endsWith("projectA"));
    assert.ok(a.lastModified); // ISO 字符串
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discoverProjects 命中项目后不再深入子目录", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-launcher-"));
  try {
    await makeProject(root, "projectA", "项目A");
    // 项目 A 子目录里放伪 novel.json，不应被发现
    await mkdir(join(root, "projectA", "正文"), { recursive: true });
    await writeFile(
      join(root, "projectA", "正文", "novel.json"),
      novelJson("伪项目"),
      "utf8",
    );
    const projects = await discoverProjects(root);
    assert.equal(projects.length, 1);
    assert.equal(projects[0].meta.name, "项目A");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discoverProjects includeChapterCount=false 跳过章节统计", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-launcher-"));
  try {
    await makeProject(root, "projectA", "项目A", ["第1章.md", "第2章.md"]);
    const projects = await discoverProjects(root, { includeChapterCount: false });
    assert.equal(projects.length, 1);
    assert.equal(projects[0].chapterCount, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discoverProjects maxDepth 限制递归深度", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-launcher-"));
  try {
    await makeProject(root, "a/b/c/projectDeep", "深项目");
    // 层级：a=1, a/b=2, a/b/c=3, a/b/c/projectDeep=4
    // currentDepth=0 扫直接子目录 a；maxDepth=N 最多扫到 N 层深
    const shallow = await discoverProjects(root, { maxDepth: 3 });
    assert.equal(shallow.length, 0); // 3 层扫不到 4 层的 projectDeep
    const deep = await discoverProjects(root, { maxDepth: 4 });
    assert.equal(deep.length, 1);
    assert.equal(deep[0].meta.name, "深项目");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discoverProjects 跳过 node_modules/.git/.隐藏目录", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-launcher-"));
  try {
    await makeProject(root, "projectA", "项目A");
    await makeProject(root, "node_modules/fakepkg", "伪包");
    await makeProject(root, ".hidden/proj", "隐藏项目");
    const projects = await discoverProjects(root);
    assert.equal(projects.length, 1);
    assert.equal(projects[0].meta.name, "项目A");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("getProjectMeta 读取单个项目元信息", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-launcher-"));
  try {
    await makeProject(root, "projectA", "项目A");
    const meta = await getProjectMeta(join(root, "projectA"));
    assert.equal(meta.name, "项目A");
    assert.equal(meta.engine, "narrative-engine");
    assert.equal(meta.chaptersDir, "正文");
    assert.equal(meta.createdAt, "2026-07-29");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("getProjectMeta 缺失 novel.json 抛 NOVEL_JSON_NOT_FOUND", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-launcher-"));
  try {
    await assert.rejects(
      () => getProjectMeta(join(root, "notexist")),
      (err: Error) =>
        err instanceof NovelLauncherError && err.code === "NOVEL_JSON_NOT_FOUND",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("_readNovelJson 缺失字段填默认值", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-launcher-"));
  try {
    const dir = join(root, "projectA");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "novel.json"), JSON.stringify({ name: "项目A" }), "utf8");
    const meta = await _readNovelJson(dir);
    assert.equal(meta.name, "项目A");
    assert.equal(meta.engine, "narrative-engine");
    assert.equal(meta.engineVersion, "0.1.0");
    assert.equal(meta.worldGraphDir, ".pi/world-graph-v3");
    assert.equal(meta.chaptersDir, "正文");
    assert.equal(meta.storyTimeFormat, "ch{NNN}.ev{NNN}");
    assert.equal(meta.createdAt, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("_readNovelJson name 缺失时回退到目录名", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-launcher-"));
  try {
    const dir = join(root, "my-project");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "novel.json"), JSON.stringify({}), "utf8");
    const meta = await _readNovelJson(dir);
    assert.equal(meta.name, "my-project");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("_readNovelJson 非法 JSON 抛 INVALID_NOVEL_JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-launcher-"));
  try {
    const dir = join(root, "projectA");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "novel.json"), "{ not json", "utf8");
    await assert.rejects(
      () => _readNovelJson(dir),
      (err: Error) =>
        err instanceof NovelLauncherError && err.code === "INVALID_NOVEL_JSON",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("_countChapters 统计 .md 文件，排除 .gitkeep 与非 md", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-launcher-"));
  try {
    const dir = join(root, "projectA");
    const chDir = join(dir, "正文");
    await mkdir(chDir, { recursive: true });
    await writeFile(join(chDir, "第1章.md"), "", "utf8");
    await writeFile(join(chDir, "第2章.md"), "", "utf8");
    await writeFile(join(chDir, ".gitkeep"), "", "utf8");
    await writeFile(join(chDir, "notes.txt"), "", "utf8");
    const count = await _countChapters(dir, "正文");
    assert.equal(count, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("_countChapters 章节目录不存在返回 0", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-launcher-"));
  try {
    const count = await _countChapters(root, "不存在");
    assert.equal(count, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
