/**
 * stages.ts — LLM 管道各阶段实现
 *
 * 每个阶段函数封装 LLM 调用 + schema 校验 + 重试逻辑。
 * pipeline.ts 通过调用这些函数编排 8 阶段管道。
 *
 * 设计原则：
 * - 阶段函数接受 callLlm 注入（便于测试 mock）
 * - schema 校验失败时重试 1 次（带上次错误提示）
 * - 阶段函数返回类型化数据，不返回原始 LLM 响应
 */

import type { Tool } from "@earendil-works/pi-ai";
import type {
  EntityHint,
  EventHint,
  ChapterResult,
  LlmToolCaller,
  RelationHint,
  VisibilityHint,
} from "./types.ts";
import type { Chapter } from "./epub.ts";
import { parallelWithLimit } from "./epub.ts";
import { isValidStoryTime } from "./storytime.ts";
import {
  entityInventoryTool,
  chapterEventsTool,
  relationsTool,
  visibilitiesTool,
} from "./schemas.ts";
import {
  buildEntityInventoryPrompt,
  ENTITY_INVENTORY_SYSTEM_PROMPT,
  buildChapterEventsPrompt,
  CHAPTER_EVENTS_SYSTEM_PROMPT,
  buildRelationsPrompt,
  RELATIONS_SYSTEM_PROMPT,
  buildVisibilitiesPrompt,
  VISIBILITIES_SYSTEM_PROMPT,
} from "./prompts.ts";

// ============================================================================
// 阶段 2：全书实体预扫描
// ============================================================================

/**
 * 阶段 2 — 全书实体预扫描
 *
 * 单次 LLM 子代理调用，识别全书主要实体。
 * schema 校验失败时重试 1 次（带错误提示）。
 */
export async function scanEntitiesGlobal(
  chapters: Chapter[],
  callLlm: LlmToolCaller,
): Promise<EntityHint[]> {
  const prompt = buildEntityInventoryPrompt(chapters);
  const tools: Tool[] = [entityInventoryTool];

  let lastError: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const finalPrompt = lastError
      ? `${prompt}\n\n# 上次输出校验失败\n${lastError}\n\n请修正上述问题后重新提交。`
      : prompt;

    try {
      const validated = await callLlm(
        finalPrompt,
        tools,
        ENTITY_INVENTORY_SYSTEM_PROMPT,
      );
      const entities = validated.entities as EntityHint[] | undefined;
      if (!entities || !Array.isArray(entities)) {
        throw new Error("LLM 未返回 entities 数组");
      }
      // 基础校验：每条必须有 name/type/aliases/first_seen_chapter/brief
      const errors: string[] = [];
      for (let i = 0; i < entities.length; i++) {
        const e = entities[i];
        if (!e.name || typeof e.name !== "string") {
          errors.push(`entities[${i}].name 缺失或非字符串`);
        }
        if (!e.type || !["character", "location", "item", "concept"].includes(e.type)) {
          errors.push(`entities[${i}].type 非法: ${e.type}`);
        }
        if (!Array.isArray(e.aliases)) {
          errors.push(`entities[${i}].aliases 非数组`);
        }
        if (typeof e.first_seen_chapter !== "number" || e.first_seen_chapter < 1) {
          errors.push(`entities[${i}].first_seen_chapter 非法: ${e.first_seen_chapter}`);
        }
        if (!e.brief || typeof e.brief !== "string") {
          errors.push(`entities[${i}].brief 缺失或非字符串`);
        }
      }
      if (errors.length > 0) {
        throw new Error(`schema 校验失败:\n${errors.join("\n")}`);
      }
      return entities;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt === 1) {
        throw new Error(`阶段 2 LLM 调用失败（重试 1 次后仍失败）: ${lastError}`);
      }
    }
  }
  throw new Error("scanEntitiesGlobal: unreachable");
}

// ============================================================================
// 阶段 3：章节事件流生成（每章 1 个 LLM 子代理，并行限流）
// ============================================================================

/**
 * 阶段 3 — 单章节事件流生成
 *
 * schema 校验失败时重试 1 次（带错误提示）。
 *
 * @param chapter EPUB 章节
 * @param entityInventory 阶段 2 全书预扫描的实体清单
 * @param callLlm 注入式 LLM 调用器
 * @returns EventHint[] 本章事件流
 */
export async function generateChapterEvents(
  chapter: Chapter,
  entityInventory: EntityHint[],
  callLlm: LlmToolCaller,
): Promise<EventHint[]> {
  const prompt = buildChapterEventsPrompt(chapter, entityInventory);
  const tools: Tool[] = [chapterEventsTool];

  let lastError: string | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const finalPrompt = lastError
      ? `${prompt}\n\n# 上次输出校验失败\n${lastError}\n\n请修正上述问题后重新提交。`
      : prompt;

    try {
      const validated = await callLlm(
        finalPrompt,
        tools,
        CHAPTER_EVENTS_SYSTEM_PROMPT,
      );
      const events = validated.events as EventHint[] | undefined;
      if (!events || !Array.isArray(events)) {
        throw new Error("LLM 未返回 events 数组");
      }
      // 基础校验
      const errors: string[] = [];
      if (events.length === 0) {
        errors.push("events 为空数组（每章至少 1 个事件）");
      }
      if (events.length > 50) {
        errors.push(`events 长度 ${events.length} 超过 50 上限`);
      }
      // 🟠-14（2026-08-08）：同章内 storyTime 唯一性——重复 storyTime 的 new_facts
      // 在阶段 7 被 (entityId, property, storyTime) 三元组去重静默丢弃，此处提前报错
      const seenStoryTimes = new Set<string>();
      for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        if (!ev.storyTime || !isValidStoryTime(ev.storyTime)) {
          errors.push(`events[${i}].storyTime 非法: ${ev.storyTime}`);
        } else {
          if (seenStoryTimes.has(ev.storyTime)) {
            errors.push(`events[${i}].storyTime 重复: ${ev.storyTime}（同章内必须唯一）`);
          }
          seenStoryTimes.add(ev.storyTime);
          // 🟠-14：章号一致性——storyTime 的 ch 号必须与当前章节号一致
          // （ch003.ev001 只能出现在第 3 章，跨章错序破坏 bi-temporal 单调性）
          const dotIdx = ev.storyTime.indexOf(".");
          const chPart = dotIdx > 0 ? ev.storyTime.slice(2, dotIdx) : "";
          const chNum = Number(chPart);
          if (Number.isFinite(chNum) && chNum !== chapter.chapterId) {
            errors.push(
              `events[${i}].storyTime "${ev.storyTime}" 章号 ${chNum} 与当前章 ${chapter.chapterId} 不一致`,
            );
          }
        }
        if (!ev.type || !["birth", "change", "death"].includes(ev.type)) {
          errors.push(`events[${i}].type 非法: ${ev.type}`);
        }
        if (!ev.entity_hint || typeof ev.entity_hint !== "string") {
          errors.push(`events[${i}].entity_hint 缺失或非字符串`);
        }
        // birth 事件必含 entity_type 和 summary
        if (ev.type === "birth") {
          if (!ev.entity_type || !["character", "location", "item", "concept"].includes(ev.entity_type)) {
            errors.push(`events[${i}].entity_type 非法（birth 必填）: ${ev.entity_type}`);
          }
          if (!ev.summary || typeof ev.summary !== "string") {
            errors.push(`events[${i}].summary 缺失（birth 必填）`);
          }
        }
        // change 事件必含 new_facts 或 invalidated（至少一项）
        if (ev.type === "change") {
          const hasNewFacts = Array.isArray(ev.new_facts) && ev.new_facts.length > 0;
          const hasInvalidated = Array.isArray(ev.invalidated) && ev.invalidated.length > 0;
          if (!hasNewFacts && !hasInvalidated) {
            errors.push(`events[${i}].change 事件必须含 new_facts 或 invalidated`);
          }
        }
        // new_facts 校验
        if (Array.isArray(ev.new_facts)) {
          for (let j = 0; j < ev.new_facts.length; j++) {
            const f = ev.new_facts[j];
            if (!f.property || typeof f.property !== "string") {
              errors.push(`events[${i}].new_facts[${j}].property 缺失或非字符串`);
            }
            if (!f.modality || !["fact", "belief", "hypothesis"].includes(f.modality)) {
              errors.push(`events[${i}].new_facts[${j}].modality 非法: ${f.modality}`);
            }
          }
        }
        // invalidated 校验
        if (Array.isArray(ev.invalidated)) {
          for (let j = 0; j < ev.invalidated.length; j++) {
            const inv = ev.invalidated[j];
            if (!inv.property || typeof inv.property !== "string") {
              errors.push(`events[${i}].invalidated[${j}].property 缺失或非字符串`);
            }
          }
        }
      }
      if (errors.length > 0) {
        throw new Error(`schema 校验失败:\n${errors.join("\n")}`);
      }
      return events;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt === 2) {
        throw new Error(`阶段 3 第 ${chapter.chapterId} 章 LLM 调用失败（重试 2 次后仍失败）: ${lastError}`);
      }
    }
  }
  throw new Error("generateChapterEvents: unreachable");
}

/**
 * 阶段 3 — 全部章节并行事件流生成
 *
 * @param chapters 章节列表
 * @param entityInventory 全书实体清单（阶段 2 输出）
 * @param callLlm 注入式 LLM 调用器
 * @param concurrency 并行限流（缺省 3）
 * @param onProgress 进度回调（done, total, chapterId, error?）
 * @returns ChapterResult[] 与章节同序
 */
export async function generateAllChapterEvents(
  chapters: Chapter[],
  entityInventory: EntityHint[],
  callLlm: LlmToolCaller,
  concurrency: number = 3,
  onProgress?: (done: number, total: number, chapterId: number, error?: string) => void,
): Promise<ChapterResult[]> {
  // 🟡（2026-08-08）：进度计数（此前 done 恒 0，进度条不动）
  let doneCount = 0;
  const results = await parallelWithLimit(
    chapters,
    concurrency,
    async (ch) => {
      // 空章节跳过（审计 P4）：空内容喂给 LLM 会生成"本章无内容"占位垃圾 Fact。
      // 返回空事件数组仍计入 ChapterResult，不影响 P0 章节完整性（该校验只看章节有无结果条目）
      if (!ch.content || !ch.content.trim()) {
        doneCount += 1;
        if (onProgress) onProgress(doneCount, chapters.length, ch.chapterId);
        return {
          chapterId: ch.chapterId,
          title: ch.title,
          events: [],
        } satisfies ChapterResult;
      }
      try {
        const events = await generateChapterEvents(ch, entityInventory, callLlm);
        doneCount += 1;
        if (onProgress) onProgress(doneCount, chapters.length, ch.chapterId);
        return {
          chapterId: ch.chapterId,
          title: ch.title,
          events,
        } satisfies ChapterResult;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        doneCount += 1;
        if (onProgress) onProgress(doneCount, chapters.length, ch.chapterId, msg);
        throw err;
      }
    },
  );
  // parallelWithLimit 把错误转为 { _error: string }，过滤并抛出
  const failed = results.filter(
    (r) => r && typeof r === "object" && "_error" in (r as object),
  ) as unknown as { _error: string }[];
  if (failed.length > 0) {
    const msgs = failed.map((f) => f._error);
    throw new Error(`阶段 3 章节事件流生成失败（${failed.length} 章）:\n${msgs.join("\n")}`);
  }
  return results as ChapterResult[];
}

// ============================================================================
// 阶段 5：关系抽取（每章 1 个 LLM 子代理，并行限流）
// ============================================================================

/**
 * 阶段 5 — 单章节关系抽取
 *
 * @param chapterId 章节序号
 * @param events 本章事件流（用于 LLM 理解）
 * @param entityInventory 本章涉及的实体清单
 * @param callLlm 注入式 LLM 调用器
 */
export async function extractRelations(
  chapterId: number,
  events: EventHint[],
  entityInventory: EntityHint[],
  callLlm: LlmToolCaller,
): Promise<RelationHint[]> {
  const eventsJson = JSON.stringify(
    events.map((e) => ({
      storyTime: e.storyTime,
      type: e.type,
      entity_hint: e.entity_hint,
      new_facts: e.new_facts,
    })),
    null,
    2,
  );
  const inventoryJson = JSON.stringify(
    entityInventory.map((e) => ({ name: e.name, type: e.type, aliases: e.aliases })),
    null,
    2,
  );
  const prompt = buildRelationsPrompt(chapterId, eventsJson, inventoryJson);
  const tools: Tool[] = [relationsTool];

  let lastError: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const finalPrompt = lastError
      ? `${prompt}\n\n# 上次输出校验失败\n${lastError}\n\n请修正上述问题后重新提交。`
      : prompt;
    try {
      const validated = await callLlm(finalPrompt, tools, RELATIONS_SYSTEM_PROMPT);
      const relations = validated.relations as RelationHint[] | undefined;
      if (!relations || !Array.isArray(relations)) {
        throw new Error("LLM 未返回 relations 数组");
      }
      const errors: string[] = [];
      for (let i = 0; i < relations.length; i++) {
        const r = relations[i];
        if (!r.source_hint || typeof r.source_hint !== "string") {
          errors.push(`relations[${i}].source_hint 缺失`);
        }
        if (!r.target_hint || typeof r.target_hint !== "string") {
          errors.push(`relations[${i}].target_hint 缺失`);
        }
        if (!r.label || typeof r.label !== "string") {
          errors.push(`relations[${i}].label 缺失`);
        }
        // 0.3.0：description 可选，非字符串直接丢弃（内核 opts 只收 string）
        if (r.description !== undefined && typeof r.description !== "string") {
          delete r.description;
        }
        if (!r.storyTime || !isValidStoryTime(r.storyTime)) {
          errors.push(`relations[${i}].storyTime 非法: ${r.storyTime}`);
        }
        if (!r.action || !["open", "close"].includes(r.action)) {
          errors.push(`relations[${i}].action 非法: ${r.action}`);
        }
      }
      if (errors.length > 0) {
        throw new Error(`schema 校验失败:\n${errors.join("\n")}`);
      }
      return relations;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt === 1) {
        throw new Error(`阶段 5 第 ${chapterId} 章 LLM 调用失败（重试 1 次后仍失败）: ${lastError}`);
      }
    }
  }
  throw new Error("extractRelations: unreachable");
}

/**
 * 阶段 5 — 全部章节并行关系抽取
 */
export async function extractAllRelations(
  chapters: Chapter[],
  chapterResults: ChapterResult[],
  entityInventory: EntityHint[],
  callLlm: LlmToolCaller,
  concurrency: number = 3,
): Promise<RelationHint[]> {
  // 按章节过滤实体清单（仅传本章涉及的）
  const entityByChapter = (chapterId: number): EntityHint[] => {
    const involvedNames = new Set<string>();
    const ch = chapterResults.find((c) => c.chapterId === chapterId);
    if (ch) {
      for (const ev of ch.events) {
        involvedNames.add(ev.entity_hint);
        if (Array.isArray(ev.new_facts)) {
          for (const f of ev.new_facts) {
            if (f.target_hint) involvedNames.add(f.target_hint);
          }
        }
      }
    }
    return entityInventory.filter((e) =>
      involvedNames.has(e.name) || e.aliases.some((a) => involvedNames.has(a)),
    );
  };

  const results = await parallelWithLimit(
    chapters,
    concurrency,
    async (ch, idx) => {
      const chResult = chapterResults[idx];
      if (!chResult) return [] as RelationHint[];
      try {
        return await extractRelations(
          ch.chapterId,
          chResult.events,
          entityByChapter(ch.chapterId),
          callLlm,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return [{ _error: msg } as unknown as RelationHint];
      }
    },
  );

  // 拼平 + 过滤错误
  const flat: RelationHint[] = [];
  const errors: string[] = [];
  for (const r of results) {
    if (Array.isArray(r)) {
      for (const item of r) {
        if (item && typeof item === "object" && "_error" in (item as object)) {
          errors.push((item as unknown as { _error: string })._error);
        } else {
          flat.push(item);
        }
      }
    }
  }
  if (errors.length > 0) {
    throw new Error(`阶段 5 关系抽取失败（${errors.length} 章）:\n${errors.join("\n")}`);
  }
  return flat;
}

// ============================================================================
// 阶段 6：可见性推断（自动路径 + LLM 显式路径）
// ============================================================================

/**
 * 阶段 6 — 单章节可见性推断（LLM 显式路径）
 *
 * 注意：自动路径（inferVisibility）在 write.ts 阶段 7 中调用 wg.inferVisibility(storyTime)
 * 实现，因为它直接操作 world-graph 内核 API，不涉及 LLM。
 */
export async function inferVisibilities(
  chapterId: number,
  events: EventHint[],
  characters: EntityHint[],
  callLlm: LlmToolCaller,
): Promise<VisibilityHint[]> {
  const eventsJson = JSON.stringify(
    events.map((e) => ({
      storyTime: e.storyTime,
      type: e.type,
      entity_hint: e.entity_hint,
      new_facts: e.new_facts,
    })),
    null,
    2,
  );
  const charactersJson = JSON.stringify(
    characters.map((c) => ({ name: c.name, type: c.type, aliases: c.aliases })),
    null,
    2,
  );
  const prompt = buildVisibilitiesPrompt(chapterId, eventsJson, charactersJson);
  const tools: Tool[] = [visibilitiesTool];

  let lastError: string | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const finalPrompt = lastError
      ? `${prompt}\n\n# 上次输出校验失败\n${lastError}\n\n请修正上述问题后重新提交。`
      : prompt;
    try {
      const validated = await callLlm(finalPrompt, tools, VISIBILITIES_SYSTEM_PROMPT);
      const visibilities = validated.visibilities as VisibilityHint[] | undefined;
      if (!visibilities || !Array.isArray(visibilities)) {
        throw new Error("LLM 未返回 visibilities 数组");
      }
      // LLM 在长数组末尾偶发漏字段：过滤掉缺必填字段的元素（记录警告）
      // 而非让整章失败重试（重试仍会漏，且浪费时间）
      const valid: VisibilityHint[] = [];
      const skipReasons: string[] = [];
      for (let i = 0; i < visibilities.length; i++) {
        const v = visibilities[i];
        const missing: string[] = [];
        if (!v.characterId_hint || typeof v.characterId_hint !== "string") missing.push("characterId_hint");
        if (!v.target_hint || typeof v.target_hint !== "string") missing.push("target_hint");
        if (!v.property || typeof v.property !== "string") missing.push("property");
        if (typeof v.confidence !== "number" || v.confidence < 0 || v.confidence > 1) missing.push("confidence");
        if (!v.source || typeof v.source !== "string") missing.push("source");
        if (!v.storyTime || !isValidStoryTime(v.storyTime)) missing.push("storyTime");
        if (typeof v.isExplicit !== "boolean") missing.push("isExplicit");
        if (missing.length > 0) {
          skipReasons.push(`visibilities[${i}] 缺: ${missing.join(",")}`);
          continue;
        }
        valid.push(v);
      }
      // 全部元素都缺字段才视为失败（重试）
      if (visibilities.length > 0 && valid.length === 0) {
        throw new Error(`schema 校验失败（所有 visibility 都缺字段）:\n${skipReasons.slice(0, 5).join("\n")}`);
      }
      // 部分元素被过滤：记录到 stderr（不中断流程）
      if (skipReasons.length > 0) {
        console.error(`[stage 6 第 ${chapterId} 章] 过滤 ${skipReasons.length}/${visibilities.length} 个缺字段的 visibility`);
      }
      return valid;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt === 2) {
        throw new Error(`阶段 6 第 ${chapterId} 章 LLM 调用失败（重试 2 次后仍失败）: ${lastError}`);
      }
    }
  }
  throw new Error("inferVisibilities: unreachable");
}

/**
 * 阶段 6 — 全部章节并行可见性推断
 */
export async function inferAllVisibilities(
  chapters: Chapter[],
  chapterResults: ChapterResult[],
  entityInventory: EntityHint[],
  callLlm: LlmToolCaller,
  concurrency: number = 3,
): Promise<VisibilityHint[]> {
  const characters = entityInventory.filter((e) => e.type === "character");

  const results = await parallelWithLimit(
    chapters,
    concurrency,
    async (ch, idx) => {
      const chResult = chapterResults[idx];
      if (!chResult) return [] as VisibilityHint[];
      try {
        return await inferVisibilities(
          ch.chapterId,
          chResult.events,
          characters,
          callLlm,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return [{ _error: msg } as unknown as VisibilityHint];
      }
    },
  );

  const flat: VisibilityHint[] = [];
  const errors: string[] = [];
  for (const r of results) {
    if (Array.isArray(r)) {
      for (const item of r) {
        if (item && typeof item === "object" && "_error" in (item as object)) {
          errors.push((item as unknown as { _error: string })._error);
        } else {
          flat.push(item);
        }
      }
    }
  }
  if (errors.length > 0) {
    throw new Error(`阶段 6 可见性推断失败（${errors.length} 章）:\n${errors.join("\n")}`);
  }
  return flat;
}
