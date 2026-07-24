/**
 * resolve.ts — 实体消解三级策略 + entityId 生成
 *
 * 三级策略（spec L665-684）：
 *   1. 精确匹配：name + aliases 完全相同 + type 相同 → 合并
 *   2. 字符串相似度：Jaro-Winkler > 0.85 + type 相同 → 合并
 *   3. LLM 子代理：相似度 0.6-0.85 的可疑对批量判断（每批 ≤25 对）
 *
 * entityId 命名（spec L239）：
 *   ent_{type}_{short_hash}
 *   short_hash = sha256(canonical_name + aliases.sort().join(",")).slice(0, 8)
 */

import crypto from "node:crypto";
import { complete, getModel, validateToolCall } from "@earendil-works/pi-ai";
import type { EntityType } from "@pi/world-graph";
import type {
  AliasEntry,
  EntityHint,
  LlmToolCaller,
  MergeDecision,
  ResolveOptions,
  ResolveResult,
  SuspiciousPair,
} from "./types.ts";
import { mergeDecisionsTool } from "./schemas.ts";
import { buildMergePrompt, MERGE_SYSTEM_PROMPT } from "./prompts.ts";

// ============================================================================
// entityId 生成
// ============================================================================

const TYPE_PREFIX: Record<EntityType, string> = {
  character: "char",
  location: "loc",
  item: "item",
  concept: "conc",
};

/**
 * 生成 canonical entityId
 * 规则：ent_{type_prefix}_{8位hash}
 * hash = sha256(canonical_name + "," + sorted_aliases.join(",")).slice(0, 8)
 */
export function generateEntityId(
  type: EntityType,
  name: string,
  aliases: string[] = [],
): string {
  const prefix = TYPE_PREFIX[type];
  if (!prefix) {
    throw new Error(`Unknown EntityType: ${type}`);
  }
  const sortedAliases = [...aliases].filter((a) => a && a !== name).sort();
  const hashInput = sortedAliases.length > 0
    ? `${name},${sortedAliases.join(",")}`
    : name;
  const hash = crypto.createHash("sha256").update(hashInput, "utf8").digest("hex").slice(0, 8);
  return `ent_${prefix}_${hash}`;
}

// ============================================================================
// Jaro-Winkler 相似度（inline 实现，无外部依赖）
// ============================================================================

/**
 * Jaro 相似度
 * 参考：https://en.wikipedia.org/wiki/Jaro-Winkler_distance
 */
function jaroSimilarity(s1: string, s2: string): number {
  if (s1 === s2) return 1;
  const len1 = s1.length;
  const len2 = s2.length;
  if (len1 === 0 || len2 === 0) return 0;

  // 匹配窗口 = max(len1, len2) / 2 - 1
  const matchWindow = Math.max(0, Math.floor(Math.max(len1, len2) / 2) - 1);
  const s1Matches = new Array<boolean>(len1).fill(false);
  const s2Matches = new Array<boolean>(len2).fill(false);

  // 计算匹配数
  let matches = 0;
  for (let i = 0; i < len1; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, len2);
    for (let j = start; j < end; j++) {
      if (s2Matches[j]) continue;
      if (s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0;

  // 计算换位数
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < len1; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }
  transpositions /= 2;

  return (
    (matches / len1 + matches / len2 + (matches - transpositions) / matches) / 3
  );
}

/**
 * Jaro-Winkler 相似度（带前缀加权，更适合短字符串如人名）
 */
export function jaroWinklerSimilarity(s1: string, s2: string): number {
  const jaro = jaroSimilarity(s1, s2);
  // 共同前缀长度，最多 4
  let prefixLen = 0;
  for (let i = 0; i < Math.min(s1.length, s2.length, 4); i++) {
    if (s1[i] === s2[i]) prefixLen++;
    else break;
  }
  // Winkler 加权：jaro + prefixLen * 0.1 * (1 - jaro)
  return jaro + prefixLen * 0.1 * (1 - jaro);
}

// ============================================================================
// 一级：精确匹配（name + aliases 完全相同 + type 相同）
// ============================================================================

/**
 * 判断两个 EntityHint 是否应该精确合并
 * 规则：type 相同，且 name 在对方的 (name + aliases) 集合中
 */
export function isExactMatch(a: EntityHint, b: EntityHint): boolean {
  if (a.type !== b.type) return false;
  const aNames = new Set([a.name, ...a.aliases]);
  const bNames = new Set([b.name, ...b.aliases]);
  // 交集非空即视为同一实体
  for (const n of aNames) {
    if (bNames.has(n)) return true;
  }
  return false;
}

/**
 * 一级分组：精确匹配合并
 * 使用并查集（Union-Find）合并
 */
export function groupByExactMatch(hints: EntityHint[]): EntityHint[][] {
  const parent = hints.map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (x: number, y: number): void => {
    const px = find(x);
    const py = find(y);
    if (px !== py) parent[px] = py;
  };

  for (let i = 0; i < hints.length; i++) {
    for (let j = i + 1; j < hints.length; j++) {
      if (isExactMatch(hints[i], hints[j])) {
        union(i, j);
      }
    }
  }

  // 收集分组
  const groupsMap = new Map<number, number[]>();
  for (let i = 0; i < hints.length; i++) {
    const root = find(i);
    if (!groupsMap.has(root)) groupsMap.set(root, []);
    groupsMap.get(root)!.push(i);
  }

  return Array.from(groupsMap.values()).map((indices) =>
    indices.map((i) => hints[i]),
  );
}

// ============================================================================
// 二级：字符串相似度合并（Jaro-Winkler > threshold + type 相同）
// ============================================================================

export const DEFAULT_SIMILARITY_THRESHOLD = 0.85;
/** 可疑区间下界（落入此区间送三级 LLM 判断） */
export const SUSPICIOUS_LOWER_BOUND = 0.6;

/**
 * 合并两个组的所有 hint，收集 name 列表
 */
function collectNames(group: EntityHint[]): {
  names: string[];
  nameToHint: Map<string, EntityHint>;
} {
  const names: string[] = [];
  const nameToHint = new Map<string, EntityHint>();
  for (const h of group) {
    for (const n of [h.name, ...h.aliases]) {
      if (!nameToHint.has(n)) {
        names.push(n);
        nameToHint.set(n, h);
      }
    }
  }
  return { names, nameToHint };
}

/**
 * 二级合并：跨组检查相似度
 * - similarity > threshold → 合并组
 * - SUSPICIOUS_LOWER_BOUND <= similarity <= threshold → 加入 suspiciousPairs
 * - similarity < SUSPICIOUS_LOWER_BOUND → 忽略
 *
 * @returns { mergedGroups, suspiciousPairs }
 */
export function mergeBySimilarity(
  groups: EntityHint[][],
  threshold: number = DEFAULT_SIMILARITY_THRESHOLD,
  suspiciousLower: number = SUSPICIOUS_LOWER_BOUND,
): {
  mergedGroups: EntityHint[][];
  suspiciousPairs: SuspiciousPair[];
} {
  // 并查集在组级别
  const parent = groups.map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (x: number, y: number): void => {
    const px = find(x);
    const py = find(y);
    if (px !== py) parent[px] = py;
  };

  const suspiciousPairs: SuspiciousPair[] = [];
  let pairCounter = 0;

  // 跨组两两比较（用所有 name 对）
  for (let gi = 0; gi < groups.length; gi++) {
    for (let gj = gi + 1; gj < groups.length; gj++) {
      const groupI = groups[gi];
      const groupJ = groups[gj];
      // 必须有相同 type 才比较
      const typesI = new Set(groupI.map((h) => h.type));
      const typesJ = new Set(groupJ.map((h) => h.type));
      let hasCommonType = false;
      for (const t of typesI) {
        if (typesJ.has(t)) {
          hasCommonType = true;
          break;
        }
      }
      if (!hasCommonType) continue;

      const { names: namesI, nameToHint: hintI } = collectNames(groupI);
      const { names: namesJ, nameToHint: hintJ } = collectNames(groupJ);

      let bestSim = 0;
      let bestPair:
        | { a: EntityHint; b: EntityHint; sim: number }
        | null = null;

      for (const ni of namesI) {
        for (const nj of namesJ) {
          const sim = jaroWinklerSimilarity(ni, nj);
          if (sim > bestSim) {
            bestSim = sim;
            bestPair = {
              a: hintI.get(ni)!,
              b: hintJ.get(nj)!,
              sim,
            };
          }
        }
      }

      if (!bestPair) continue;

      if (bestSim > threshold) {
        union(gi, gj);
      } else if (bestSim >= suspiciousLower) {
        suspiciousPairs.push({
          pair_id: `p${++pairCounter}`,
          a: {
            name: bestPair.a.name,
            type: bestPair.a.type,
            aliases: bestPair.a.aliases,
            brief: bestPair.a.brief,
          },
          b: {
            name: bestPair.b.name,
            type: bestPair.b.type,
            aliases: bestPair.b.aliases,
            brief: bestPair.b.brief,
          },
          similarity: bestSim,
        });
      }
    }
  }

  // 收集合并后的组
  const mergedMap = new Map<number, number[]>();
  for (let i = 0; i < groups.length; i++) {
    const root = find(i);
    if (!mergedMap.has(root)) mergedMap.set(root, []);
    mergedMap.get(root)!.push(i);
  }

  const mergedGroups = Array.from(mergedMap.values()).map((indices) =>
    indices.flatMap((i) => groups[i]),
  );

  return { mergedGroups, suspiciousPairs };
}

// ============================================================================
// 三级：LLM 子代理判断（批量，每批 ≤25 对）
// ============================================================================

const LLM_BATCH_SIZE = 25;

/**
 * 默认 LLM provider（与 V2 一致）
 */
const DEFAULT_PROVIDER = "deepseek";

/**
 * 构造真实 LLM 调用器（绑定 model + apiKey）
 *
 * 用 pi-ai 的 complete + validateToolCall 实现：
 * - complete 发起 LLM 请求，要求 LLM 必须调用工具
 * - validateToolCall 校验工具调用参数是否符合 schema
 *
 * 内置重试：LLM 偶发返回纯文本而非工具调用（deepseek 已知行为），
 * 在 caller 层重试 MAX_NO_TOOL_RETRIES 次（间隔 RETRY_DELAY_MS），
 * 避免 stage 层重试浪费已成功的 LLM 调用。
 */
const MAX_NO_TOOL_RETRIES = 5;
const RETRY_DELAY_MS = 1500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function makeLlmCaller(
  model: string,
  apiKey: string,
  provider: string = DEFAULT_PROVIDER,
): LlmToolCaller {
  return async (prompt, tools, systemPrompt) => {
    const modelObj = getModel(provider as never, model as never);
    for (let attempt = 0; attempt < MAX_NO_TOOL_RETRIES; attempt++) {
      const msg = await complete(
        modelObj,
        {
          systemPrompt,
          messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
          tools,
        },
        {
          apiKey,
          maxTokens: 8000,
          temperature: 0.1,
        },
      );
      if (msg.stopReason === "error" || msg.errorMessage) {
        throw new Error(`LLM 调用失败: ${msg.errorMessage ?? "unknown"}`);
      }
      const toolCall = msg.content.find((b) => b.type === "toolCall");
      if (!toolCall || toolCall.type !== "toolCall") {
        // LLM 未调用工具：caller 层重试（不抛错给 stage）
        if (attempt < MAX_NO_TOOL_RETRIES - 1) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        throw new Error(`LLM 未调用工具（caller 重试 ${MAX_NO_TOOL_RETRIES} 次后仍失败）`);
      }
      return validateToolCall(tools, toolCall);
    }
    throw new Error("makeLlmCaller: unreachable");
  };
}

/**
 * 三级 LLM 判断：批量处理可疑对
 */
export async function mergeByLLMJudgment(
  suspiciousPairs: SuspiciousPair[],
  callLlm: LlmToolCaller,
): Promise<MergeDecision[]> {
  if (suspiciousPairs.length === 0) return [];

  const allDecisions: MergeDecision[] = [];
  for (let i = 0; i < suspiciousPairs.length; i += LLM_BATCH_SIZE) {
    const batch = suspiciousPairs.slice(i, i + LLM_BATCH_SIZE);
    const prompt = buildMergePrompt(batch);
    const validated = await callLlm(prompt, [mergeDecisionsTool], MERGE_SYSTEM_PROMPT);
    const decisions = validated.decisions as MergeDecision[] | undefined;
    if (!decisions || !Array.isArray(decisions)) {
      throw new Error("LLM 未返回 decisions 数组");
    }
    allDecisions.push(...decisions);
  }
  return allDecisions;
}

// ============================================================================
// 组合并工具
// ============================================================================

/**
 * 合并同一组内的多个 EntityHint 为一个 canonical EntityHint
 * 规则：
 *   - name 取首个（按输入顺序）作为 canonical name
 *   - type 取相同 type（已由分组保证）
 *   - aliases 合并去重：
 *     - 其他组成员的 name 都作为别名
 *     - 所有组成员的 aliases 都合并
 *     - canonical name 本身不作为别名
 *   - first_seen_chapter 取最小值
 *   - brief 取首个非空
 */
export function mergeGroupToCanonical(group: EntityHint[]): EntityHint {
  if (group.length === 0) {
    throw new Error("mergeGroupToCanonical: 空组");
  }
  const first = group[0];
  const nameSet = new Set<string>([first.name]);
  const aliases: string[] = [];
  let first_seen_chapter = first.first_seen_chapter;
  let brief = first.brief;

  for (let i = 0; i < group.length; i++) {
    const h = group[i];
    if (h.first_seen_chapter < first_seen_chapter) {
      first_seen_chapter = h.first_seen_chapter;
    }
    if (!brief && h.brief) brief = h.brief;
    // 非首组成员的 name 作为别名（首组的 name 就是 canonical name，跳过）
    if (i > 0 && !nameSet.has(h.name)) {
      nameSet.add(h.name);
      aliases.push(h.name);
    }
    for (const a of h.aliases) {
      if (!nameSet.has(a)) {
        nameSet.add(a);
        aliases.push(a);
      }
    }
  }

  return {
    name: first.name,
    type: first.type,
    aliases,
    first_seen_chapter,
    brief,
  };
}

// ============================================================================
// 编排：三级串联
// ============================================================================

/**
 * 实体消解主函数（spec L672-684）
 *
 * 三级策略：
 *   1. groupByExactMatch → 精确合并
 *   2. mergeBySimilarity → 相似度合并 + 收集可疑对
 *   3. mergeByLLMJudgment → LLM 判断可疑对并合并
 *
 * 最终生成 canonicalMap（entity_hint name → canonical entityId）+ aliasIndex
 *
 * @param entityHints 阶段 2 全书预扫描的实体提示
 * @param options.model LLM 模型名
 * @param options.apiKey API key
 * @param options.callLlm 注入式 LLM 调用器（测试用 mock）
 */
export async function resolveEntities(
  entityHints: EntityHint[],
  options: ResolveOptions,
): Promise<ResolveResult> {
  if (entityHints.length === 0) {
    return { canonicalMap: new Map(), aliasIndex: [] };
  }

  // 一级
  const groupsL1 = groupByExactMatch(entityHints);

  // 二级
  const { mergedGroups: groupsL2, suspiciousPairs } = mergeBySimilarity(groupsL1);

  // 三级（若有可疑对且提供了 callLlm）
  let groupsL3 = groupsL2;
  if (suspiciousPairs.length > 0) {
    const callLlm = options.callLlm ?? makeLlmCaller(options.model, options.apiKey);
    const decisions = await mergeByLLMJudgment(suspiciousPairs, callLlm);

    // 根据决策合并组
    // 建立 pair_id → (aGroupIdx, bGroupIdx) 映射
    // suspiciousPairs 与 groupsL2 的关系：pair 来自 groupsL1 后的两组
    // 由于 mergeBySimilarity 内部已经做了并查集，未合并的可疑对的两组索引需要重新跟踪
    // 简化方案：直接根据 decisions 中 should_merge=true 的 canonical_name 反查组
    if (decisions.length > 0) {
      groupsL3 = applyDecisionsToGroups(groupsL2, suspiciousPairs, decisions);
    }
  }

  // 生成 canonical entityId + aliasIndex + canonicalMap
  const canonicalMap = new Map<string, string>();
  const aliasIndex: AliasEntry[] = [];

  for (const group of groupsL3) {
    const canonical = mergeGroupToCanonical(group);
    const entityId = generateEntityId(canonical.type, canonical.name, canonical.aliases);
    aliasIndex.push({
      name: canonical.name,
      aliases: canonical.aliases,
      canonical_entityId: entityId,
    });
    // canonicalMap: 每个 name/alias 都映射到 entityId
    canonicalMap.set(canonical.name, entityId);
    for (const a of canonical.aliases) {
      canonicalMap.set(a, entityId);
    }
  }

  return { canonicalMap, aliasIndex };
}

/**
 * 根据可疑对的 LLM 决策合并组
 *
 * 需要重新计算可疑对到组索引的映射：
 * - 每个 SuspiciousPair 的 a/b 来自两组（groupsL2 中）
 * - 我们用 (name, type) 作为组的"代表键"来反查组索引
 */
function applyDecisionsToGroups(
  groups: EntityHint[][],
  pairs: SuspiciousPair[],
  decisions: MergeDecision[],
): EntityHint[][] {
  // 构建 (name, type) → groupIndex 映射（用每组的首个 hint 作为代表）
  // 注意：pair.a.name 可能是该组中任意一个 hint 的 name 或 alias
  // 为此我们建立 name → groupIndex 映射
  const nameToGroupIdx = new Map<string, number>();
  for (let gi = 0; gi < groups.length; gi++) {
    for (const h of groups[gi]) {
      nameToGroupIdx.set(h.name, gi);
      for (const a of h.aliases) {
        if (!nameToGroupIdx.has(a)) nameToGroupIdx.set(a, gi);
      }
    }
  }

  // 并查集在组级别
  const parent = groups.map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (x: number, y: number): void => {
    const px = find(x);
    const py = find(y);
    if (px !== py) parent[px] = py;
  };

  // 根据 decisions 合并
  const decisionMap = new Map<string, MergeDecision>();
  for (const d of decisions) {
    decisionMap.set(d.pair_id, d);
  }

  for (const pair of pairs) {
    const d = decisionMap.get(pair.pair_id);
    if (!d || !d.should_merge) continue;
    const gi = nameToGroupIdx.get(pair.a.name);
    const gj = nameToGroupIdx.get(pair.b.name);
    if (gi === undefined || gj === undefined) continue;
    union(gi, gj);
  }

  // 收集合并后的组
  const mergedMap = new Map<number, number[]>();
  for (let i = 0; i < groups.length; i++) {
    const root = find(i);
    if (!mergedMap.has(root)) mergedMap.set(root, []);
    mergedMap.get(root)!.push(i);
  }

  return Array.from(mergedMap.values()).map((indices) =>
    indices.flatMap((i) => groups[i]),
  );
}
