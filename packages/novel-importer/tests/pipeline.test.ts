// packages/novel-importer/tests/pipeline.test.ts
/**
 * pipeline 幂等守卫测试（🟠-12 2026-08-08）
 *
 * 覆盖：目标目录 events.jsonl 已有数据时 fresh 导入拒绝（防二次导入数据翻倍）。
 * 守卫在阶段 1 前（resolveWorldGraphDir 后）——无需真实 EPUB，直接可测。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runImportPipeline } from "../src/pipeline.ts";

test("runImportPipeline: 目标目录 events.jsonl 非空时 fresh 导入拒绝（🟠-12）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "importer-pipeline-"));
  try {
    await writeFile(join(dir, "events.jsonl"), '{"eventId":"evt_x","type":"birth"}\n', "utf8");
    await assert.rejects(
      () => runImportPipeline({ epubPath: "不存在的.epub", worldGraphDir: dir }),
      /已导入过事件/,
      "fresh 导入已有事件日志的目录应拒绝",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runImportPipeline: 空 events.jsonl（0 字节）放行到阶段 1（🟠-12）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "importer-pipeline-"));
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "events.jsonl"), "", "utf8");
    // 0 字节 = 从未写入 → 守卫放行；随后阶段 1 因 EPUB 不存在而抛错（非幂等守卫错误）
    await assert.rejects(
      () => runImportPipeline({ epubPath: join(dir, "不存在.epub"), worldGraphDir: dir }),
      (err: Error) => !/已导入过事件/.test(err.message),
      "0 字节日志不应触发幂等拒绝（后续错误是 EPUB 不存在）",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runImportPipeline: resume（>1）跳过幂等守卫（🟠-12）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "importer-pipeline-"));
  try {
    await writeFile(join(dir, "events.jsonl"), '{"eventId":"evt_x"}\n', "utf8");
    // resume=8（跳过阶段 7）不应触发幂等拒绝——后续错误应是 EPUB/dump 相关
    await assert.rejects(
      () => runImportPipeline({ epubPath: join(dir, "不存在.epub"), worldGraphDir: dir, resumeFromStage: 8 }),
      (err: Error) => !/已导入过事件/.test(err.message),
      "resume 场景不应触发 fresh 幂等守卫",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
