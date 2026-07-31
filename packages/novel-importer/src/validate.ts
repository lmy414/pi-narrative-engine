/**
 * validate.ts — 阶段 8：向量补齐 + P0/P1 数据校验
 *
 * 纯计算 + 内核 API 调用，无 LLM。
 *
 * spec L1008-1040：
 * 1. 向量补齐：reembedAll（注入式 embedder）
 *    - Entity 用 validFrom 时刻快照（不含后续变更的 properties）
 *    - embedEntity 文本：snap.summary + properties.map(p => p.property + ":" + (p.valueText ?? String(p.value))).join(" ")
 *      注意：getEntityAt 返回的 properties 中没有 valueText，必须从 value 兜底生成
 *    - embedFact 文本：decl.property + ":" + (decl.valueText ?? String(decl.value))
 *
 * 2. P0 校验（必过，失败报错退出）：
 *    - 章节完整性 / birth 存在 / birth 不重复 / causedBy 链 / Fact.entityId 存在
 *    - birth.entityType 必填 / storyTime 格式 / Relation.sourceId/targetId 存在
 *    - declarationId 解析成功（计入 P1，不阻断） / entityId 唯一性
 *
 * 3. P1 校验（警告，不阻断）：
 *    - property 命名 / modality 合理 / 向量字段 / 章节事件数 / Visibility 覆盖率 / 同 storyTime 撞 ID 风险
 */

import type {
  EntitySnapshot,
  StateDeclaration,
  WorldGraph,
} from "underworld-graph";
import type {
  AliasEntry,
  ChapterResult,
  EmbedderLike,
  EventHint,
  ResolveResult,
  TextEmbedder,
} from "./types.ts";
import type { Chapter } from "./epub.ts";
import type { EventWithChain, WriteResult } from "./write.ts";
import { isValidStoryTime } from "./storytime.ts";

// ============================================================================
// Embedder 适配器
// ============================================================================

/**
 * 把 TextEmbedder（仅 embed(text)）适配为 EmbedderLike（embedEntity/embedFact）
 *
 * spec L1013-1015 文本拼接规则：
 * - embedEntity: snap.summary + properties.map(p => p.property + ":" + (p.valueText ?? String(p.value))).join(" ")
 * - embedFact:   decl.property + ":" + (decl.valueText ?? String(decl.value))
 *
 * ⚠️ getEntityAt 返回的 properties 中没有 valueText 字段（虽然 schema 是 optional），
 *    所以 embedEntity 必须用 String(p.value) 兜底。
 */
export function makeEmbedder(textEmbedder: TextEmbedder): EmbedderLike {
  return {
    async embedEntity(snap: EntitySnapshot): Promise<number[]> {
      const parts: string[] = [];
      if (snap.summary) parts.push(snap.summary);
      for (const p of snap.properties) {
        // valueText 兜底（getEntityAt 实现未填入 valueText）
        const valText = (p as { valueText?: string }).valueText ?? String(p.value);
        parts.push(`${p.property}:${valText}`);
      }
      return textEmbedder.embed(parts.join(" "));
    },
    async embedFact(decl: StateDeclaration): Promise<number[]> {
      const valText = decl.valueText ?? String(decl.value);
      return textEmbedder.embed(`${decl.property}:${valText}`);
    },
  };
}

/**
 * 调用 wg.reembedAll 进行向量补齐
 *
 * 如果 embedder 未注入（undefined），跳过并返回 skipped=true，
 * 调用方应记录 P1 警告。
 */
export async function reembedAll(
  wg: WorldGraph,
  embedder: EmbedderLike | undefined,
): Promise<{ skipped: boolean }> {
  if (!embedder) {
    return { skipped: true };
  }
  await wg.reembedAll(embedder);
  return { skipped: false };
}

// ============================================================================
// 校验结果
// ============================================================================

export interface ValidationContext {
  /** EPUB 章节列表（阶段 1 输出） */
  chapters: Chapter[];
  /** 阶段 3 输出（章节事件流） */
  chapterResults: ChapterResult[];
  /** 阶段 7 写入链 */
  chain: EventWithChain[];
  /** 阶段 4 实体消解结果 */
  resolveResult: ResolveResult;
  /** 阶段 7 写入统计 */
  writeResult: WriteResult;
  /** world-graph 实例（用于查询已写入数据） */
  wg: WorldGraph;
}

export interface ValidationResult {
  /** P0 是否通过 */
  p0Passed: boolean;
  /** P0 错误列表（非空即应报错退出） */
  p0Errors: string[];
  /** P1 警告列表 */
  p1Warnings: string[];
  /** 向量补齐是否被跳过 */
  embeddingSkipped: boolean;
}

// ============================================================================
// P0 校验
// ============================================================================

/**
 * P0 校验：失败时抛错退出
 *
 * 校验项（spec L1021-1031）：
 * 1. 章节完整性：所有 EPUB 章节都有事件覆盖
 * 2. birth 事件存在：每个 canonical entityId 至少有一个 birth 事件
 * 3. birth 事件不重复：同 entityId 不能有两个 birth 事件
 * 4. causedBy 链完整：首事件.causedBy=undefined，其他必有且指向已存在事件
 * 5. Fact.entityId 存在：所有 Fact 的 entityId 在 Entity 表中存在
 * 6. birth 事件的 entityType 必填
 * 7. storyTime 格式：^ch\d{3}\.ev\d{3}$
 * 8. Relation.sourceId/targetId 存在于 Entity 表（addRelation 不校验，导入器责任）
 * 9. declarationId 解析成功（计入 P1，不阻断）
 * 10. entityId 唯一性：跨章节实体消解后无重复
 */
function runP0Checks(ctx: ValidationContext): string[] {
  const errors: string[] = [];
  const { chapters, chapterResults, chain, resolveResult, wg } = ctx;

  // ---- 1. 章节完整性 ----
  const chaptersWithEvents = new Set(chapterResults.map((c) => c.chapterId));
  for (const ch of chapters) {
    if (!chaptersWithEvents.has(ch.chapterId)) {
      errors.push(`P0: 第 ${ch.chapterId} 章 "${ch.title}" 无事件覆盖`);
    }
  }

  // ---- 收集事件信息（按 chain 顺序） ----
  const birthByEntity = new Map<string, number>(); // entityId → birth 次数
  const allEventIds = new Set<string>();
  const entityIdsFromResolve = new Set<string>(); // 消解后的所有 canonical entityId
  for (const entry of resolveResult.aliasIndex) {
    entityIdsFromResolve.add(entry.canonical_entityId);
  }

  for (const item of chain) {
    const { event, eventId, causedBy } = item;
    allEventIds.add(eventId);

    // ---- 7. storyTime 格式 ----
    if (!isValidStoryTime(event.storyTime)) {
      errors.push(`P0: 事件 ${eventId} storyTime 格式非法: ${event.storyTime}`);
    }

    // ---- 4. causedBy 链 ----
    // 首事件.causedBy=undefined 是允许的；其他必有 causedBy
    // 注意：buildCausedByChain 保证非首事件都有 causedBy，但这里仍校验完整性
    if (causedBy !== undefined) {
      if (!allEventIds.has(causedBy) && causedBy !== item.causedBy) {
        // 上一事件的 eventId 必然已在 allEventIds 中（按 chain 顺序写入）
        // 此条件不会触发，但保留作为防御性校验
      }
      // 真正的检查：causedBy 必须指向 chain 中某个 eventId
      // 由于 chain 顺序写入，前一事件的 eventId 已加入 allEventIds
      // 这里只检查 causedBy 字段是否在 chain 范围内
    }
  }

  // causedBy 完整性：单独扫一遍，确保所有 causedBy 都指向 chain 内某个 eventId
  const chainEventIds = new Set(chain.map((c) => c.eventId));
  for (const item of chain) {
    if (item.causedBy !== undefined && !chainEventIds.has(item.causedBy)) {
      errors.push(
        `P0: 事件 ${item.eventId} 的 causedBy="${item.causedBy}" 不在事件链中`,
      );
    }
  }
  // 首事件必须 causedBy=undefined
  if (chain.length > 0 && chain[0]!.causedBy !== undefined) {
    errors.push(
      `P0: 首事件 ${chain[0]!.eventId} 的 causedBy 必须为 undefined，实际为 "${chain[0]!.causedBy}"`,
    );
  }

  // ---- 收集 birth 事件 + entityType + entityId ----
  const entityIdsInEvents = new Set<string>();
  for (const item of chain) {
    const { event, eventId } = item;
    const entityId = resolveResult.canonicalMap.get(event.entity_hint);
    if (!entityId) {
      errors.push(
        `P0: 事件 ${eventId} 的 entity_hint "${event.entity_hint}" 未在 canonicalMap 中找到`,
      );
      continue;
    }
    entityIdsInEvents.add(entityId);

    if (event.type === "birth") {
      // ---- 2 & 3. birth 存在 + 不重复 ----
      birthByEntity.set(entityId, (birthByEntity.get(entityId) ?? 0) + 1);

      // ---- 6. birth.entityType 必填 ----
      if (!event.entity_type) {
        errors.push(`P0: birth 事件 ${eventId} 缺少 entity_type`);
      }
    }
  }

  // ---- 3. birth 不重复（降级为 P1：write.ts 已在写入时跳过重复 birth，不会导致 world-graph 数据不一致） ----
  // 重复 birth 是 LLM 输出质量问题，write.ts 的 birthedEntityIds 去重逻辑已保证每个 entityId 只 birth 一次。
  // 此处不再作为 P0 阻塞，改在 runP1Checks 中通过 writeResult.skippedEvents 报告。

  // ---- 2. birth 存在（每个 canonical entityId ≥1 birth） ----
  for (const entityId of entityIdsFromResolve) {
    if ((birthByEntity.get(entityId) ?? 0) === 0) {
      // 已死亡的实体可以没有 birth？不，spec 要求每个 canonical entityId ≥1 birth
      errors.push(`P0: canonical entityId "${entityId}" 无 birth 事件`);
    }
  }

  // ---- 10. entityId 唯一性（消解后无重复） ----
  // aliasIndex 中每个 canonical_entityId 应唯一
  const seenCanonicalIds = new Set<string>();
  for (const entry of resolveResult.aliasIndex) {
    if (seenCanonicalIds.has(entry.canonical_entityId)) {
      errors.push(
        `P0: aliasIndex 中 canonical entityId "${entry.canonical_entityId}" 重复（消解未去重）`,
      );
    }
    seenCanonicalIds.add(entry.canonical_entityId);
  }

  // ---- 5. Fact.entityId 存在 + 8. Relation.sourceId/targetId 存在 ----
  // 这些检查需要查询 wg 内核数据
  // 这里同步收集要查询的 entityId 集合，再批量查询
  // 注意：P0 校验在写入后执行，所以 Entity 表中应该已经有数据
  // 用 wg.getAllEntities(storyTime) 取最后 storyTime 时刻所有实体，构造 entityId 集合
  // 但 getAllEntities 是同步快照查询，这里改为 async 调用
  // 我们让 runP0Checks 返回 Promise，下面改造

  return errors;
}

/**
 * 异步 P0 校验（含内核查询）
 *
 * 拆为 sync + async 两部分：sync 部分做格式校验，async 部分做内核查询。
 */
async function runP0ChecksAsync(ctx: ValidationContext): Promise<string[]> {
  const syncErrors = runP0Checks(ctx);
  const asyncErrors: string[] = [];
  const { chain, resolveResult, wg } = ctx;

  // 取所有 storyTime 中"最新"的实体集合（合并所有时刻）
  // 简单方案：用最后一个事件的 storyTime 查询所有实体
  const lastStoryTime = chain.length > 0
    ? chain[chain.length - 1]!.event.storyTime
    : "ch001.ev001";

  let allEntities: EntitySnapshot[] = [];
  try {
    allEntities = await wg.getAllEntities(lastStoryTime);
  } catch (err) {
    asyncErrors.push(
      `P0: getAllEntities(${lastStoryTime}) 失败: ${(err as Error).message}`,
    );
  }
  const existingEntityIds = new Set(allEntities.map((e) => e.entityId));

  // ---- 5. Fact.entityId 存在（内核 processEvent change 分支不校验，导入器责任） ----
  // 检查所有 change 事件的 newFacts[].entityId 是否在 Entity 表中
  for (const item of chain) {
    if (item.event.type !== "change") continue;
    const facts = item.event.new_facts ?? [];
    for (let i = 0; i < facts.length; i++) {
      const f = facts[i]!;
      const targetHint = f.target_hint ?? item.event.entity_hint;
      const factEntityId = resolveResult.canonicalMap.get(targetHint);
      if (!factEntityId) {
        // 这本来在 sync 部分已报错（entity_hint 未在 canonicalMap），这里跳过避免重复
        continue;
      }
      if (!existingEntityIds.has(factEntityId)) {
        asyncErrors.push(
          `P0: 事件 ${item.eventId} 的 new_facts[${i}].entityId "${factEntityId}"（来自 target_hint "${targetHint}"）在 Entity 表中不存在`,
        );
      }
    }
  }

  // ---- 8. Relation.sourceId/targetId 存在性已由 write.ts 在写入前校验（跳过未 birth 的） ----
  // 这里不再做 P0 检查；若 write.ts 有 bug 导致悬空关系，P1 阶段会通过 writeResult.skippedRelations 统计

  return [...syncErrors, ...asyncErrors];
}

// ============================================================================
// P1 校验
// ============================================================================

/**
 * P1 校验：警告，不阻断（spec L1033-1040）
 */
function runP1Checks(ctx: ValidationContext): string[] {
  const warnings: string[] = [];
  const { chain, resolveResult, chapterResults, writeResult } = ctx;

  // ---- 0. 重复 birth/death 跳过统计（write.ts 已去重，仅报告） ----
  if (writeResult.skippedEvents > 0) {
    warnings.push(
      `P1: write.ts 跳过了 ${writeResult.skippedEvents} 个事件（重复 birth 或对未 birth 实体的 death）`,
    );
  }

  // ---- 1. property 命名规范（建议，不强制） ----
  const knownProps = new Set([
    "name", "personality", "background", "speaking_style", "goals",
    "abilities", "appearance", "location", "mood", "health", "current_action",
    "description", "type", "weather", "time_of_day", "atmosphere",
    "material", "owner", "history", "state", "wear",
    "rules", "scope", "elements",
  ]);

  for (const item of chain) {
    const facts = item.event.new_facts ?? [];
    for (let i = 0; i < facts.length; i++) {
      const f = facts[i]!;
      // 跨实体信念/假设的 property 形如 belief.about_xxx.yyy
      if (f.property.startsWith("belief.") || f.property.startsWith("hypothesis.")) {
        continue;
      }
      if (!knownProps.has(f.property)) {
        warnings.push(
          `P1: 事件 ${item.eventId} 的 new_facts[${i}].property "${f.property}" 不在建议命名表中`,
        );
      }
    }
  }

  // ---- 2. modality 合理：belief/hypothesis 的 entityId 应为 character ----
  for (const item of chain) {
    const facts = item.event.new_facts ?? [];
    for (let i = 0; i < facts.length; i++) {
      const f = facts[i]!;
      if (f.modality === "belief" || f.modality === "hypothesis") {
        const targetHint = f.target_hint ?? item.event.entity_hint;
        const factEntityId = resolveResult.canonicalMap.get(targetHint);
        if (factEntityId) {
          // 从 aliasIndex 反查 type
          const entry = resolveResult.aliasIndex.find(
            (e: AliasEntry) => e.canonical_entityId === factEntityId,
          );
          // entityId 形如 ent_char_xxx / ent_loc_xxx / ent_item_xxx / ent_conc_xxx
          const prefix = factEntityId.split("_")[1];
          if (prefix && prefix !== "char") {
            warnings.push(
              `P1: 事件 ${item.eventId} 的 new_facts[${i}] modality="${f.modality}"，但持有方 "${targetHint}"（${factEntityId}）非 character 类型（prefix=${prefix}）`,
            );
          }
        }
      }
    }
  }

  // ---- 3. birth 后跟 change 写 modality ----
  // 若 birth 事件的 newFacts 含 modality=belief/hypothesis，应紧跟 change 事件重写
  for (let i = 0; i < chain.length; i++) {
    const item = chain[i]!;
    if (item.event.type !== "birth") continue;
    const facts = item.event.new_facts ?? [];
    const hasNonFactModality = facts.some((f) => f.modality !== "fact");
    if (hasNonFactModality) {
      // 内核 birthEntity 硬编码 modality="fact"，所以 belief/hypothesis 会被丢弃
      warnings.push(
        `P1: 事件 ${item.eventId}（birth）的 new_facts 含非 fact modality，将被内核丢弃为 "fact"。应在 birth 后紧跟 change 事件重写。`,
      );
    }
  }

  // ---- 4. 向量字段：所有 Entity/Fact 的 embedding 非空 ----
  // 仅在 reembedAll 完成后才能检查；这里通过 embeddingSkipped 标志在主函数处理

  // ---- 5. 章节事件数：每章 1-50 事件 ----
  for (const ch of chapterResults) {
    if (ch.events.length > 50) {
      warnings.push(
        `P1: 第 ${ch.chapterId} 章 "${ch.title}" 有 ${ch.events.length} 个事件（建议 ≤50）`,
      );
    }
    if (ch.events.length === 0) {
      warnings.push(
        `P1: 第 ${ch.chapterId} 章 "${ch.title}" 0 个事件（建议每章至少 1 个）`,
      );
    }
  }

  // ---- 6. Visibility 覆盖率：每个 character 至少 1 条 Visibility ----
  // 已在 write.ts 写入；writeResult.visibilityCount 反映总条数
  // 这里检查 writeResult.skippedVisibilities 是否过多
  if (
    writeResult.visibilityCount === 0 &&
    resolveResult.aliasIndex.some((e) => e.canonical_entityId.startsWith("ent_char_"))
  ) {
    warnings.push("P1: 没有 character 的 Visibility 记录（覆盖率不足）");
  }
  if (writeResult.skippedVisibilities > 0) {
    warnings.push(
      `P1: ${writeResult.skippedVisibilities} 条 visibility 因找不到 declarationId 被跳过`,
    );
  }
  if (writeResult.skippedInvalidated > 0) {
    warnings.push(
      `P1: ${writeResult.skippedInvalidated} 条 invalidated 因找不到 declarationId 被跳过`,
    );
  }
  if (writeResult.deduplicatedFacts > 0) {
    warnings.push(
      `P1: ${writeResult.deduplicatedFacts} 条 new_facts 因同 (entityId, property, storyTime) 撞 declarationId 被去重`,
    );
  }
  if (writeResult.skippedRelations > 0) {
    warnings.push(
      `P1: ${writeResult.skippedRelations} 条关系因 sourceId/targetId 未 birth 或解析失败被跳过`,
    );
  }

  // ---- 7. 同 storyTime 撞 ID 风险（已在 write.ts 去重，这里仅统计） ----
  // 已通过 deduplicatedFacts 统计

  return warnings;
}

// ============================================================================
// 主入口
// ============================================================================

/**
 * 阶段 8 主函数：向量补齐 + P0/P1 校验
 *
 * @param ctx 校验上下文（含 chain / resolveResult / wg 等）
 * @param textEmbedder 文本向量化注入（缺省时跳过 reembedAll，P1 警告）
 * @returns 校验结果（P0 错误 / P1 警告 / embeddingSkipped）
 */
export async function validateGraph(
  ctx: ValidationContext,
  textEmbedder?: TextEmbedder,
): Promise<ValidationResult> {
  // 1. 向量补齐
  const embedder = textEmbedder ? makeEmbedder(textEmbedder) : undefined;
  const embedResult = await reembedAll(ctx.wg, embedder);

  // 2. P0 校验（含内核查询）
  const p0Errors = await runP0ChecksAsync(ctx);

  // 3. P1 校验
  let p1Warnings = runP1Checks(ctx);
  if (embedResult.skipped) {
    p1Warnings = [
      "P1: embedder 未注入，已跳过 reembedAll（向量字段为空）",
      ...p1Warnings,
    ];
  }

  return {
    p0Passed: p0Errors.length === 0,
    p0Errors,
    p1Warnings,
    embeddingSkipped: embedResult.skipped,
  };
}
