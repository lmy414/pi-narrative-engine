/**
 * pipeline.ts — V3 导入管道 8 阶段编排
 *
 * spec L324-348 管道流程：
 *   阶段 1: EPUB 分章              (epub.ts readChaptersFromEpub)
 *   阶段 2: 全书实体预扫描          (stages.ts scanEntitiesGlobal)
 *   阶段 3: 章节事件流生成          (stages.ts generateAllChapterEvents)
 *   阶段 4: 实体消解编排            (resolve.ts resolveEntities → canonicalMap + aliasIndex)
 *   阶段 5: 关系抽取                (stages.ts extractAllRelations)
 *   阶段 6: 可见性推断              (stages.ts inferAllVisibilities)
 *   阶段 7: 写入 world-graph        (write.ts buildCausedByChain + writeToGraph)
 *   阶段 8: 向量补齐 + P0/P1 校验   (validate.ts validateGraph)
 *
 * 输出（spec L94-101）：
 *   <worldGraphDir>/
 *     world.db              # TypeGraph SQLite
 *     events.jsonl          # EventRecord 事件日志
 *     chapter-index.json     # 章节元数据
 *     alias-index.json      # 别名索引
 *     _v3_dump.json         # 阶段 1-6 中间产物（含 narrative_summary/evidence 调试字段）
 */

import path from "node:path";
import { promises as fs } from "node:fs";
import { WorldGraph } from "underworld-graph";
import type {
  AliasEntry,
  ChapterResult,
  EntityHint,
  EventHint,
  ImportPipelineOptions,
  ImportPipelineResult,
  LlmToolCaller,
  RelationHint,
  ResolveResult,
  VisibilityHint,
} from "./types.ts";
import type { Chapter } from "./epub.ts";
import { readChaptersFromEpub } from "./epub.ts";
import {
  generateAllChapterEvents,
  extractAllRelations,
  inferAllVisibilities,
  scanEntitiesGlobal,
} from "./stages.ts";
import { resolveEntities, makeLlmCaller } from "./resolve.ts";
import {
  buildAliasIndex,
  buildCausedByChain,
  buildChapterIndex,
  writeToGraph,
} from "./write.ts";
import type { EventWithChain, WriteResult } from "./write.ts";
import { validateGraph } from "./validate.ts";
import type { ValidationResult } from "./validate.ts";

// ============================================================================
// 进度通知接口（解耦 ctx.ui.notify）
// ============================================================================

export interface ProgressNotifier {
  (stage: number, stageName: string, message: string, progress?: { done: number; total: number }): void;
}

// ============================================================================
// Dump 文件结构
// ============================================================================

interface V3Dump {
  /** 生成时间 ISO 8601 */
  generatedAt: string;
  /** EPUB 路径 */
  epubPath: string;
  /** 阶段 1: 章节列表（仅元数据，不含全文以减小体积） */
  chapters: Array<{ chapterId: number; title: string; contentLength: number }>;
  /** 阶段 2: 全书实体清单 */
  entityInventory: EntityHint[];
  /** 阶段 3: 章节事件流 */
  chapterResults: ChapterResult[];
  /** 阶段 4: 实体消解结果 */
  resolveResult: {
    canonicalMap: Array<[string, string]>;
    aliasIndex: AliasEntry[];
  };
  /** 阶段 5: 关系列表 */
  relations: RelationHint[];
  /** 阶段 6: 可见性列表 */
  visibilities: VisibilityHint[];
  /** 阶段 7: 写入统计 */
  writeResult?: WriteResult;
  /** 阶段 8: 校验结果 */
  validation?: ValidationResult;
}

// ============================================================================
// 默认值
// ============================================================================

const DEFAULT_PROVIDER = "deepseek";
// 与扩展层三路 LLM 缺省对齐（deepseek-chat 已被当前 API 拒绝：仅支持 v4-pro/v4-flash）
const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_WORLD_GRAPH_DIRNAME = ".pi/world-graph-v3";

/**
 * 从环境变量读取默认 LLM 配置
 */
function resolveLlmConfig(options: ImportPipelineOptions): {
  model: string;
  apiKey: string;
} {
  const apiKey =
    options.apiKey ||
    process.env.DEEPSEEK_API_KEY ||
    process.env.PI_API_KEY ||
    "";
  if (!apiKey) {
    throw new Error(
      "apiKey 缺失：请在 options.apiKey 或环境变量 DEEPSEEK_API_KEY 中提供",
    );
  }
  const model = options.model || process.env.PI_MODEL || DEFAULT_MODEL;
  return { model, apiKey };
}

/**
 * 解析 worldGraphDir（缺省 <cwd>/.pi/world-graph-v3/）
 */
function resolveWorldGraphDir(options: ImportPipelineOptions): string {
  if (options.worldGraphDir) return options.worldGraphDir;
  const cwd = options.cwd ?? process.cwd();
  return path.join(cwd, DEFAULT_WORLD_GRAPH_DIRNAME);
}

// ============================================================================
// Dump 落盘 / 读取
// ============================================================================

async function writeDump(
  dumpPath: string,
  dump: V3Dump,
): Promise<void> {
  await fs.writeFile(dumpPath, JSON.stringify(dump, null, 2), "utf-8");
}

async function readDumpIfExists(
  dumpPath: string,
): Promise<V3Dump | null> {
  try {
    const content = await fs.readFile(dumpPath, "utf-8");
    return JSON.parse(content) as V3Dump;
  } catch {
    return null;
  }
}

// ============================================================================
// 主函数：runImportPipeline
// ============================================================================

/**
 * V3 导入管道主函数
 *
 * 8 阶段顺序执行，进度通过 onProgress 推送。
 *
 * @param options 导入参数
 * @param onProgress 可选进度通知（不传时仅 console.log）
 * @returns 导入结果摘要
 */
export async function runImportPipeline(
  options: ImportPipelineOptions,
  onProgress?: ProgressNotifier,
): Promise<ImportPipelineResult> {
  const notify: ProgressNotifier = onProgress ?? ((stage, name, msg, p) => {
    const prefix = `[stage ${stage}/${8}] ${name}`;
    const suffix = p ? ` (${p.done}/${p.total})` : "";
    console.log(`${prefix}${suffix}: ${msg}`);
  });

  // ============================================================
  // 准备
  // ============================================================
  const worldGraphDir = resolveWorldGraphDir(options);
  await fs.mkdir(worldGraphDir, { recursive: true });
  const dumpPath = path.join(worldGraphDir, "_v3_dump.json");
  const chapterIndexPath = path.join(worldGraphDir, "chapter-index.json");
  const aliasIndexPath = path.join(worldGraphDir, "alias-index.json");

  const { model, apiKey } = resolveLlmConfig(options);
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const callLlm: LlmToolCaller = makeLlmCaller(model, apiKey, DEFAULT_PROVIDER);

  const resumeFromStage = options.resumeFromStage ?? 1;
  if (resumeFromStage < 1 || resumeFromStage > 8) {
    throw new Error(`resumeFromStage 必须在 [1, 8] 范围内，实际：${resumeFromStage}`);
  }

  // 尝试读取已有 dump（resume 时使用）
  const existingDump = resumeFromStage > 1
    ? await readDumpIfExists(dumpPath)
    : null;

  // ============================================================
  // 阶段 1: EPUB 分章
  // ============================================================
  let chapters: Chapter[] = existingDump?.chapters
    ? existingDump.chapters.map((c) => ({
        chapterId: c.chapterId,
        title: c.title,
        content: "", // dump 中不保留全文，resume 时需重新读取
      }))
    : [];

  // M4c 修复（2026-07-30）：resume 时 dump 不保留全文（content=""），
  // 若不重读 EPUB，阶段 3 的空章节检查会对所有章节命中 → 0 事件。
  // 修复：当 chapters 无 content 时（从 dump 加载的情况），无条件重读 EPUB。
  if (resumeFromStage <= 1 || chapters.length === 0 || !chapters.some((c) => c.content)) {
    notify(1, "EPUB 分章", `读取 ${options.epubPath}`);
    const epubChapters = await readChaptersFromEpub(options.epubPath, {
      chapterFilter: options.chapters,
    });
    // resume 时保留 dump 的 chapterId/title（可能被阶段 1.5 修正过），只填充 content
    if (chapters.length > 0 && chapters.length === epubChapters.length) {
      chapters = chapters.map((c, i) => ({ ...c, content: epubChapters[i].content }));
    } else {
      chapters = epubChapters;
    }
    notify(1, "EPUB 分章", `识别 ${chapters.length} 章`, {
      done: chapters.length,
      total: chapters.length,
    });
  }

  // ============================================================
  // 阶段 2: 全书实体预扫描
  // ============================================================
  let entityInventory: EntityHint[] = existingDump?.entityInventory ?? [];

  if (resumeFromStage <= 2) {
    notify(2, "实体预扫描", "LLM 子代理识别全书实体");
    entityInventory = await scanEntitiesGlobal(chapters, callLlm);
    notify(2, "实体预扫描", `识别 ${entityInventory.length} 个实体`, {
      done: 1,
      total: 1,
    });
    // 落盘 dump（中间产物）
    await writeDump(dumpPath, {
      generatedAt: new Date().toISOString(),
      epubPath: options.epubPath,
      chapters: chapters.map((c) => ({
        chapterId: c.chapterId,
        title: c.title,
        contentLength: c.content.length,
      })),
      entityInventory,
      chapterResults: [],
      resolveResult: { canonicalMap: [], aliasIndex: [] },
      relations: [],
      visibilities: [],
    });
  }

  // ============================================================
  // 阶段 3: 章节事件流生成（每章 1 个 LLM 子代理，并行限流）
  // ============================================================
  let chapterResults: ChapterResult[] = existingDump?.chapterResults ?? [];

  if (resumeFromStage <= 3) {
    notify(3, "章节事件流", `并行处理 ${chapters.length} 章（并发=${concurrency}）`);
    chapterResults = await generateAllChapterEvents(
      chapters,
      entityInventory,
      callLlm,
      concurrency,
      (done, total, chapterId, error) => {
        notify(3, "章节事件流", `第 ${chapterId} 章 ${error ? "失败: " + error : "完成"}`, { done, total });
      },
    );
    notify(3, "章节事件流", `生成 ${chapterResults.reduce((n, c) => n + c.events.length, 0)} 个事件`, {
      done: chapters.length,
      total: chapters.length,
    });
    // 落盘 dump
    await writeDump(dumpPath, {
      generatedAt: new Date().toISOString(),
      epubPath: options.epubPath,
      chapters: chapters.map((c) => ({
        chapterId: c.chapterId,
        title: c.title,
        contentLength: c.content.length,
      })),
      entityInventory,
      chapterResults,
      resolveResult: { canonicalMap: [], aliasIndex: [] },
      relations: [],
      visibilities: [],
    });
  }

  // ============================================================
  // 阶段 4: 实体消解编排（三级策略）
  // ============================================================
  let resolveResult: ResolveResult = existingDump?.resolveResult
    ? {
        canonicalMap: new Map(existingDump.resolveResult.canonicalMap),
        aliasIndex: existingDump.resolveResult.aliasIndex,
      }
    : { canonicalMap: new Map(), aliasIndex: [] };

  if (resumeFromStage <= 4) {
    notify(4, "实体消解", "三级策略：精确匹配 → 相似度 → LLM 判断");
    // 阶段 3 输出中所有 entity_hint 都送入消解
    // 注意：阶段 2 的 entityInventory 是规范的实体清单，阶段 3 只是引用 name/alias
    // resolveEntities 接受 EntityHint[]（含 name/type/aliases/first_seen_chapter/brief）
    resolveResult = await resolveEntities(entityInventory, {
      model,
      apiKey,
      callLlm, // 注入，避免 resolve.ts 内部重复创建 caller
    });
    notify(4, "实体消解", `消解为 ${resolveResult.aliasIndex.length} 个 canonical 实体`, {
      done: 1,
      total: 1,
    });
    // 落盘 dump + alias-index.json
    await writeDump(dumpPath, {
      generatedAt: new Date().toISOString(),
      epubPath: options.epubPath,
      chapters: chapters.map((c) => ({
        chapterId: c.chapterId,
        title: c.title,
        contentLength: c.content.length,
      })),
      entityInventory,
      chapterResults,
      resolveResult: {
        canonicalMap: Array.from(resolveResult.canonicalMap.entries()),
        aliasIndex: resolveResult.aliasIndex,
      },
      relations: [],
      visibilities: [],
    });
    await fs.writeFile(
      aliasIndexPath,
      JSON.stringify(buildAliasIndex(resolveResult), null, 2),
      "utf-8",
    );
  }

  // ============================================================
  // 阶段 5: 关系抽取（每章 1 个 LLM 子代理，并行限流）
  // ============================================================
  let relations: RelationHint[] = existingDump?.relations ?? [];

  if (resumeFromStage <= 5) {
    notify(5, "关系抽取", `并行处理 ${chapters.length} 章`);
    relations = await extractAllRelations(
      chapters,
      chapterResults,
      entityInventory,
      callLlm,
      concurrency,
    );
    notify(5, "关系抽取", `抽取 ${relations.length} 条关系`, {
      done: chapters.length,
      total: chapters.length,
    });
    // 落盘 dump
    await writeDump(dumpPath, {
      generatedAt: new Date().toISOString(),
      epubPath: options.epubPath,
      chapters: chapters.map((c) => ({
        chapterId: c.chapterId,
        title: c.title,
        contentLength: c.content.length,
      })),
      entityInventory,
      chapterResults,
      resolveResult: {
        canonicalMap: Array.from(resolveResult.canonicalMap.entries()),
        aliasIndex: resolveResult.aliasIndex,
      },
      relations,
      visibilities: [],
    });
  }

  // ============================================================
  // 阶段 6: 可见性推断（每章 1 个 LLM 子代理，并行限流）
  // ============================================================
  let visibilities: VisibilityHint[] = existingDump?.visibilities ?? [];

  if (resumeFromStage <= 6) {
    notify(6, "可见性推断", `并行处理 ${chapters.length} 章`);
    visibilities = await inferAllVisibilities(
      chapters,
      chapterResults,
      entityInventory,
      callLlm,
      concurrency,
    );
    notify(6, "可见性推断", `推断 ${visibilities.length} 条可见性`, {
      done: chapters.length,
      total: chapters.length,
    });
    // 落盘 dump
    await writeDump(dumpPath, {
      generatedAt: new Date().toISOString(),
      epubPath: options.epubPath,
      chapters: chapters.map((c) => ({
        chapterId: c.chapterId,
        title: c.title,
        contentLength: c.content.length,
      })),
      entityInventory,
      chapterResults,
      resolveResult: {
        canonicalMap: Array.from(resolveResult.canonicalMap.entries()),
        aliasIndex: resolveResult.aliasIndex,
      },
      relations,
      visibilities,
    });
  }

  // ============================================================
  // 阶段 7: 写入 world-graph（按 causedBy 链拓扑序）
  // ============================================================
  let chain: EventWithChain[] = [];
  let writeResult: WriteResult | undefined;
  let wg: WorldGraph | null = null;

  if (resumeFromStage <= 7) {
    notify(7, "写入 world-graph", "构造 causedBy 链");
    chain = buildCausedByChain(chapterResults);

    notify(7, "写入 world-graph", `初始化 WorldGraph @ ${worldGraphDir}`);
    wg = await WorldGraph.create({
      dbPath: path.join(worldGraphDir, "world.db"),
      eventLogPath: path.join(worldGraphDir, "events.jsonl"),
    });

    const warnings: string[] = [];
    notify(7, "写入 world-graph", `写入 ${chain.length} 事件 + ${relations.length} 关系 + ${visibilities.length} 可见性`);
    try {
      writeResult = await writeToGraph(chain, relations, visibilities, {
        wg,
        resolveResult,
        autoInferVisibility: true,
        onWarning: (msg) => {
          warnings.push(msg);
        },
      });
      notify(7, "写入 world-graph", `完成：${writeResult.eventCount} 事件 / ${writeResult.relationCount} 关系 / ${writeResult.visibilityCount} 可见性`, {
        done: 1,
        total: 1,
      });
      if (warnings.length > 0) {
        notify(7, "写入 world-graph", `${warnings.length} 条警告（详见 dump）`);
      }
    } finally {
      // 阶段 8 仍需 wg，不在此关闭
    }

    // 落盘 chapter-index.json
    const chapterIndex = buildChapterIndex(chapterResults, chain);
    await fs.writeFile(
      chapterIndexPath,
      JSON.stringify(chapterIndex, null, 2),
      "utf-8",
    );

    // 更新 dump
    await writeDump(dumpPath, {
      generatedAt: new Date().toISOString(),
      epubPath: options.epubPath,
      chapters: chapters.map((c) => ({
        chapterId: c.chapterId,
        title: c.title,
        contentLength: c.content.length,
      })),
      entityInventory,
      chapterResults,
      resolveResult: {
        canonicalMap: Array.from(resolveResult.canonicalMap.entries()),
        aliasIndex: resolveResult.aliasIndex,
      },
      relations,
      visibilities,
      writeResult,
    });
  } else {
    // resume 跳过阶段 7：重新打开 wg（只读模式不写）
    notify(7, "写入 world-graph", "resume 模式跳过（已写入）");
    wg = await WorldGraph.create({
      dbPath: path.join(worldGraphDir, "world.db"),
      eventLogPath: path.join(worldGraphDir, "events.jsonl"),
    });
    // 从 dump 恢复 chain（用于阶段 8 校验上下文）
    chain = buildCausedByChain(chapterResults);
    writeResult = existingDump?.writeResult;
  }

  // ============================================================
  // 阶段 8: 向量补齐 + P0/P1 校验
  // ============================================================
  let validation: ValidationResult | undefined;

  if (resumeFromStage <= 8) {
    notify(8, "向量补齐 + 校验", "reembedAll + P0/P1 检查");
    validation = await validateGraph(
      {
        chapters,
        chapterResults,
        chain,
        resolveResult,
        writeResult: writeResult ?? {
          eventCount: 0,
          relationCount: 0,
          visibilityCount: 0,
          skippedInvalidated: 0,
          skippedVisibilities: 0,
          deduplicatedFacts: 0,
          skippedRelations: 0,
          skippedEvents: 0,
        },
        wg,
      },
      options.embedder,
    );

    if (!validation.p0Passed) {
      // P0 失败：抛错退出
      const err = new Error(
        `P0 校验失败（${validation.p0Errors.length} 条错误）:\n${validation.p0Errors.join("\n")}`,
      );
      // 先关闭 wg，再抛错
      try {
        wg.close();
      } catch {
        // 忽略关闭错误
      }
      throw err;
    }

    notify(8, "向量补齐 + 校验", `P0 通过 / P1 警告 ${validation.p1Warnings.length} 条`, {
      done: 1,
      total: 1,
    });
    if (validation.p1Warnings.length > 0) {
      for (const w of validation.p1Warnings.slice(0, 10)) {
        notify(8, "向量补齐 + 校验", `⚠️ ${w}`);
      }
      if (validation.p1Warnings.length > 10) {
        notify(8, "向量补齐 + 校验", `... 共 ${validation.p1Warnings.length} 条（详见 dump）`);
      }
    }

    // 最终 dump
    await writeDump(dumpPath, {
      generatedAt: new Date().toISOString(),
      epubPath: options.epubPath,
      chapters: chapters.map((c) => ({
        chapterId: c.chapterId,
        title: c.title,
        contentLength: c.content.length,
      })),
      entityInventory,
      chapterResults,
      resolveResult: {
        canonicalMap: Array.from(resolveResult.canonicalMap.entries()),
        aliasIndex: resolveResult.aliasIndex,
      },
      relations,
      visibilities,
      writeResult,
      validation,
    });
  } else {
    notify(8, "向量补齐 + 校验", "resume 模式跳过");
    validation = existingDump?.validation;
  }

  // 关闭 wg
  try {
    wg.close();
  } catch {
    // 忽略关闭错误
  }

  return {
    entityCount: resolveResult.aliasIndex.length,
    eventCount: writeResult?.eventCount ?? chain.length,
    relationCount: writeResult?.relationCount ?? relations.length,
    visibilityCount: writeResult?.visibilityCount ?? visibilities.length,
    worldGraphDir,
    dumpPath,
  };
}
