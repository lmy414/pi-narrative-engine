/**
 * write.ts — 阶段 7：写入 world-graph（纯计算，无 LLM）
 *
 * 按 causedBy 链拓扑序调用 WorldGraph.processEvent/addRelation/setVisibility。
 *
 * 核心规则（spec L980-1004）：
 * 1. 不能按 storyTime 排序——同 storyTime 多事件的先后由 causedBy 表达
 * 2. change 事件的 invalidated.declarationId 需查询当前未闭合声明填入
 * 3. birth 事件 newFacts[].entityId 填 event.entityId（内核 birth 分支会丢弃，但 schema 要求）
 * 4. change 事件 newFacts[].entityId 从 target_hint 解析（缺省 = event.entityId）
 * 5. 关系用 addRelation/closeRelation（不校验 sourceId/targetId 存在性，导入器责任）
 * 6. 可见性用 setVisibility，state 固定 "known"
 * 7. visibility 的 declarationId 从 target_hint + property 查询未闭合声明
 * 8. 同 (entityId, property, storyTime) 三元组会撞 declarationId → 去重
 */

import crypto from "node:crypto";
import type { WorldGraph } from "@pi/world-graph";
import type { EntitySnapshot } from "@pi/world-graph";
import type {
  AliasEntry,
  ChapterResult,
  EventHint,
  RelationHint,
  ResolveResult,
  VisibilityHint,
} from "./types.ts";

// ============================================================================
// eventId 生成
// ============================================================================

/**
 * 生成 eventId
 * 规则（spec L151）：event_{timestamp}_{random}
 */
export function generateEventId(): string {
  const ts = Date.now();
  const rand = crypto.randomBytes(6).toString("hex");
  return `event_${ts}_${rand}`;
}

// ============================================================================
// causedBy 链构造
// ============================================================================

/**
 * 按章顺序串接所有事件，构造 causedBy 链
 *
 * 规则（spec L222-226）：
 * - 章内事件.causedBy = 上一事件 eventId
 * - 每章第一个事件.causedBy = 上一章最后一个事件 eventId
 * - 首事件.causedBy = undefined
 *
 * @returns 数组：[{ event: EventHint, eventId, causedBy }]
 */
export interface EventWithChain {
  event: EventHint;
  eventId: string;
  causedBy: string | undefined;
  chapterId: number;
}

export function buildCausedByChain(chapterResults: ChapterResult[]): EventWithChain[] {
  const chain: EventWithChain[] = [];
  let prevEventId: string | undefined = undefined;

  for (const ch of chapterResults) {
    for (const ev of ch.events) {
      const eventId = generateEventId();
      chain.push({
        event: ev,
        eventId,
        causedBy: prevEventId, // undefined 表示首事件
        chapterId: ch.chapterId,
      });
      prevEventId = eventId;
    }
  }
  return chain;
}

// ============================================================================
// 写入 world-graph
// ============================================================================

export interface WriteOptions {
  /** 注入式 world-graph 实例 */
  wg: WorldGraph;
  /** 实体消解结果（canonicalMap: entity_hint name → canonical entityId） */
  resolveResult: ResolveResult;
  /** 自动路径：是否在每章最后一事件后调用 wg.inferVisibility(storyTime) */
  autoInferVisibility?: boolean;
  /** 写入警告收集器（P1 级问题） */
  onWarning?: (msg: string) => void;
}

export interface WriteResult {
  eventCount: number;
  relationCount: number;
  visibilityCount: number;
  /** 跳过的 invalidated 项数（找不到未闭合 declarationId） */
  skippedInvalidated: number;
  /** 跳过的 visibility 项数（找不到 target declarationId） */
  skippedVisibilities: number;
  /** 撞 ID 跳过的 newFacts 数（同 entityId+property+storyTime） */
  deduplicatedFacts: number;
  /** 跳过的关系数（sourceId/targetId 未 birth 或解析失败） */
  skippedRelations: number;
  /** 跳过的 death 事件数（entity 未 birth 或已 dead） */
  skippedEvents: number;
}

/**
 * 阶段 7 主函数：按 causedBy 链拓扑序写入 world-graph
 *
 * 1. 先写入所有事件（birth/change/death）— 按 chain 顺序
 * 2. 写入所有关系
 * 3. 写入所有 LLM 显式可见性（自动路径在事件写入中按章节末调用）
 */
export async function writeToGraph(
  chain: EventWithChain[],
  relations: RelationHint[],
  visibilities: VisibilityHint[],
  options: WriteOptions,
): Promise<WriteResult> {
  const { wg, resolveResult, autoInferVisibility = true, onWarning } = options;
  const warn = (msg: string) => {
    if (onWarning) onWarning(msg);
  };

  let skippedInvalidated = 0;
  let deduplicatedFacts = 0;
  let visibilityCount = 0;
  let skippedVisibilities = 0;
  let skippedRelations = 0;
  let skippedEvents = 0;

  // 用于去重 (entityId, property, storyTime) 三元组
  const seenFactKeys = new Set<string>();
  // 跟踪已 birth 的 entityId（关系/可见性引用时校验存在性）
  const birthedEntityIds = new Set<string>();
  // 用于跟踪每章最后一个事件，便于调用 inferVisibility
  let lastChapterId: number | null = null;
  let lastStoryTimeOfChapter: string | null = null;

  // ========================================================
  // 1. 写入事件（按 causedBy 链拓扑序）
  // ========================================================
  for (const item of chain) {
    const { event, eventId, causedBy, chapterId } = item;
    const entityId = resolveEntityId(event.entity_hint, resolveResult);
    if (!entityId) {
      warn(`跳过事件 ${eventId}: entity_hint "${event.entity_hint}" 未在 canonicalMap 中找到`);
      continue;
    }

    // 同章节切换时，对上一章调用 inferVisibility
    if (lastChapterId !== null && lastChapterId !== chapterId && autoInferVisibility && lastStoryTimeOfChapter) {
      try {
        await wg.inferVisibility(lastStoryTimeOfChapter);
      } catch (err) {
        warn(`inferVisibility(${lastStoryTimeOfChapter}) 失败: ${(err as Error).message}`);
      }
    }
    lastChapterId = chapterId;
    lastStoryTimeOfChapter = event.storyTime;

    switch (event.type) {
      case "birth": {
        // 去重：同 entityId 只 birth 第一次（LLM 偶发在同一/多章节重复 birth）
        // 后续重复 birth 转为 warn 跳过，避免 world-graph 重复创建实体
        if (birthedEntityIds.has(entityId)) {
          warn(`跳过重复 birth 事件 ${eventId}: entity "${event.entity_hint}"(${entityId}) 已 birth`);
          skippedEvents++;
          break;
        }
        // birth 事件 newFacts[].entityId 填 event.entityId（内核会丢弃，但 schema 要求）
        // 同时去重 (entityId, property, storyTime) 三元组
        const newFactsFiltered = filterBirthFacts(
          event.new_facts ?? [],
          entityId,
          event.storyTime,
          seenFactKeys,
          (k) => warn(`跳过重复 fact: ${k}`),
        );
        birthedEntityIds.add(entityId);
        deduplicatedFacts += (event.new_facts?.length ?? 0) - newFactsFiltered.length;

        const newFacts = newFactsFiltered.map((f) => ({
          entityId, // birth 事件：内核会丢弃，但 schema 要求填
          property: f.property,
          value: f.value,
          modality: f.modality, // birth 事件：内核会丢弃，硬编码 fact
        }));

        await wg.processEvent({
          eventId,
          type: "birth",
          storyTime: event.storyTime,
          entityId,
          entityType: event.entity_type,
          summary: event.summary,
          newFacts: newFacts.length > 0 ? newFacts : undefined,
          causedBy,
        });
        break;
      }

      case "change": {
        // 解析 invalidated.declarationId（查询当前未闭合声明）
        const invalidated = [];
        for (const inv of event.invalidated ?? []) {
          const declarationId = await findDeclarationId(wg, entityId, inv.property, event.storyTime);
          if (declarationId) {
            invalidated.push({ declarationId, property: inv.property });
          } else {
            skippedInvalidated++;
            warn(`事件 ${eventId}: 实体 ${entityId} 的 property "${inv.property}" 未找到未闭合 declarationId，跳过 invalidated`);
          }
        }

        // 解析 newFacts[].entityId（从 target_hint 解析，缺省 = event.entityId）
        // 同时去重 (entityId, property, storyTime) 三元组
        const newFactsRaw = [];
        for (const f of event.new_facts ?? []) {
          const factEntityId = f.target_hint
            ? (resolveEntityId(f.target_hint, resolveResult) ?? entityId)
            : entityId;
          const key = `${factEntityId}|${f.property}|${event.storyTime}`;
          if (seenFactKeys.has(key)) {
            deduplicatedFacts++;
            warn(`跳过重复 fact: ${key}`);
            continue;
          }
          seenFactKeys.add(key);
          newFactsRaw.push({
            entityId: factEntityId,
            property: f.property,
            value: f.value,
            modality: f.modality, // change 事件保留 modality
          });
        }

        // 自动闭合同 property 未闭合声明（审计 P3：不依赖 LLM 声明 invalidated，
        // 否则 LLM 漏报时旧值永远有效——current_action 多条未闭合并存事故）
        // 与运行时 commit.ts 的语义一致：同 property 旧 Fact 全部闭合
        for (const f of newFactsRaw) {
          const declarationId = await findDeclarationId(wg, f.entityId, f.property, event.storyTime);
          if (declarationId && !invalidated.some((i) => i.declarationId === declarationId)) {
            invalidated.push({ declarationId, property: f.property });
          }
        }

        await wg.processEvent({
          eventId,
          type: "change",
          storyTime: event.storyTime,
          entityId,
          invalidated: invalidated.length > 0 ? invalidated : undefined,
          newFacts: newFactsRaw.length > 0 ? newFactsRaw : undefined,
          causedBy,
        });
        break;
      }

      case "death": {
        // 校验 entityId 已 birth（避免悬空 death：LLM 可能给未 birth 的实体发 death 事件）
        if (!birthedEntityIds.has(entityId)) {
          warn(`跳过 death 事件 ${eventId}: entity "${event.entity_hint}"(${entityId}) 未 birth`);
          skippedEvents++;
          break;
        }
        // 重复 death（同一实体已 dead）时 killEntity 会抛 "already dead"，
        // 转为 warn 而非让整流程失败
        try {
          await wg.processEvent({
            eventId,
            type: "death",
            storyTime: event.storyTime,
            entityId,
            causedBy,
          });
        } catch (err) {
          warn(`death 事件 ${eventId} 失败（可能已 dead）: ${(err as Error).message}`);
          skippedEvents++;
        }
        break;
      }
    }
  }

  // 最后一章的 inferVisibility
  if (lastChapterId !== null && autoInferVisibility && lastStoryTimeOfChapter) {
    try {
      await wg.inferVisibility(lastStoryTimeOfChapter);
    } catch (err) {
      warn(`inferVisibility(${lastStoryTimeOfChapter}) 失败: ${(err as Error).message}`);
    }
  }

  // ========================================================
  // 2. 写入关系
  // ========================================================
  let relationCount = 0;
  for (const r of relations) {
    const sourceId = resolveEntityId(r.source_hint, resolveResult);
    const targetId = resolveEntityId(r.target_hint, resolveResult);
    if (!sourceId || !targetId) {
      warn(`跳过关系 ${r.source_hint}-${r.label}-${r.target_hint}: 无法解析 entity_hint`);
      skippedRelations++;
      continue;
    }
    // 校验 sourceId/targetId 已 birth（避免悬空关系）
    if (!birthedEntityIds.has(sourceId)) {
      warn(`跳过关系 ${sourceId}-${r.label}-${targetId}: source "${r.source_hint}" 未 birth`);
      skippedRelations++;
      continue;
    }
    if (!birthedEntityIds.has(targetId)) {
      warn(`跳过关系 ${sourceId}-${r.label}-${targetId}: target "${r.target_hint}" 未 birth`);
      skippedRelations++;
      continue;
    }
    try {
      if (r.action === "open") {
        await wg.addRelation(sourceId, targetId, r.label, r.storyTime);
      } else {
        await wg.closeRelation(sourceId, targetId, r.label, r.storyTime);
      }
      relationCount++;
    } catch (err) {
      warn(`关系 ${r.action} ${sourceId}-${r.label}-${targetId} 失败: ${(err as Error).message}`);
      skippedRelations++;
    }
  }

  // ========================================================
  // 3. 写入 LLM 显式可见性
  // ========================================================
  for (const v of visibilities) {
    const characterId = resolveEntityId(v.characterId_hint, resolveResult);
    const targetEntityId = resolveEntityId(v.target_hint, resolveResult);
    if (!characterId || !targetEntityId) {
      warn(`跳过可见性 ${v.characterId_hint}->${v.target_hint}.${v.property}: 无法解析 entity_hint`);
      skippedVisibilities++;
      continue;
    }
    const declarationId = await findDeclarationId(wg, targetEntityId, v.property, v.storyTime);
    if (!declarationId) {
      warn(`跳过可见性: 实体 ${targetEntityId} 的 property "${v.property}" 未找到未闭合 declarationId`);
      skippedVisibilities++;
      continue;
    }
    try {
      await wg.setVisibility(characterId, declarationId, {
        state: "known", // 必填，types.ts z.enum(["known"]) 只支持此值
        confidence: v.confidence,
        source: v.source,
        validFrom: v.storyTime,
        isExplicit: v.isExplicit,
      });
      visibilityCount++;
    } catch (err) {
      warn(`setVisibility ${characterId}->${declarationId} 失败: ${(err as Error).message}`);
    }
  }

  return {
    eventCount: chain.length,
    relationCount,
    visibilityCount,
    skippedInvalidated,
    skippedVisibilities,
    deduplicatedFacts,
    skippedRelations,
    skippedEvents,
  };
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 通过 entity_hint name 解析 canonical entityId
 * 支持 name 本身或别名映射
 */
function resolveEntityId(
  hint: string,
  resolveResult: ResolveResult,
): string | null {
  // 直接命中 canonicalMap
  const direct = resolveResult.canonicalMap.get(hint);
  if (direct) return direct;
  // 别名兜底：遍历 aliasIndex
  for (const entry of resolveResult.aliasIndex) {
    if (entry.name === hint || entry.aliases.includes(hint)) {
      return entry.canonical_entityId;
    }
  }
  return null;
}

/**
 * 查询实体在指定 property 上的未闭合 declarationId
 *
 * 调用 wg.getEntityAt(entityId, storyTime) 取快照，在 properties 中查找匹配 property。
 *
 * 注意：getEntityAt 返回 validFrom <= storyTime < validTo 的所有声明，
 * 我们要找的是"在此 storyTime 之前刚写入且未闭合"的 declarationId。
 *
 * 由于 storyTime 的事件还在写入过程中（change 事件即将创建新声明），
 * 我们查询的 storyTime 应该是上一刻的状态。但 bi-temporal 模型下
 * "未闭合"= validTo === "Infinity" 或 validTo > storyTime，
 * 所以直接调用 getEntityAt(entityId, storyTime) 取的就是该 storyTime 时刻的状态。
 *
 * 找到匹配的最后一个（最新写入的） declarationId。
 */
async function findDeclarationId(
  wg: WorldGraph,
  entityId: string,
  property: string,
  storyTime: string,
): Promise<string | null> {
  const snap: EntitySnapshot | null = await wg.getEntityAt(entityId, storyTime);
  if (!snap) return null;
  // 找匹配 property 的声明（取最后一个 = 最新）
  const matched = snap.properties.filter((p) => p.property === property);
  if (matched.length === 0) return null;
  return matched[matched.length - 1]!.declarationId;
}

/**
 * birth 事件 newFacts 去重（同 entityId+property+storyTime）
 *
 * 注意 birth 事件的 entityId 都填 event.entityId（内核会丢弃 target_hint）。
 */
function filterBirthFacts(
  facts: EventHint["new_facts"],
  entityId: string,
  storyTime: string,
  seenKeys: Set<string>,
  onSkip: (key: string) => void,
): NonNullable<EventHint["new_facts"]> {
  if (!facts) return [];
  const result: NonNullable<EventHint["new_facts"]> = [];
  for (const f of facts) {
    const key = `${entityId}|${f.property}|${storyTime}`;
    if (seenKeys.has(key)) {
      onSkip(key);
      continue;
    }
    seenKeys.add(key);
    result.push(f);
  }
  return result;
}

// ============================================================================
// 章节索引 + 别名索引输出
// ============================================================================

export interface ChapterIndexEntry {
  chapter_id: number;
  title: string;
  storyTimeRange: { start: string; end: string };
  eventCount: number;
}

/**
 * 构造 chapter-index.json 内容
 */
export function buildChapterIndex(
  chapterResults: ChapterResult[],
  chain: EventWithChain[],
): ChapterIndexEntry[] {
  return chapterResults.map((ch) => {
    const chapterEvents = chain.filter((c) => c.chapterId === ch.chapterId);
    const storyTimes = chapterEvents.map((c) => c.event.storyTime).sort();
    return {
      chapter_id: ch.chapterId,
      title: ch.title,
      storyTimeRange: {
        start: storyTimes[0] ?? "",
        end: storyTimes[storyTimes.length - 1] ?? "",
      },
      eventCount: chapterEvents.length,
    };
  });
}

/**
 * 构造 alias-index.json 内容（基于 ResolveResult）
 */
export function buildAliasIndex(resolveResult: ResolveResult): AliasEntry[] {
  return resolveResult.aliasIndex;
}
