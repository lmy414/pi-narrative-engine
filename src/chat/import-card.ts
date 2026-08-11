/**
 * import-card.ts — 酒馆角色卡（SillyTavern V1/V2）导入
 *
 * 解决 Pending Gap #5：从酒馆卡文件导入角色到世界图。
 *
 * 支持格式：
 * - .json：V1 平铺（{ name, description, ... }）或 V2（{ spec: "chara_card_v2", data: {...} }）
 * - .png：tEXt / iTXt chunk 内嵌 base64 JSON（keyword "chara" 或 "ccv3"）
 *
 * 导入策略（单一数据源）：
 * - card.description → Entity.summary（birth 事件 summary，重组时映射回 card.description）
 * - card 其余 KNOWN_FIELDS → 同名 Fact（static-card-loader 重组时透传）
 * - 自产自知：为角色自身写入全部卡字段 Fact 的 Visibility
 *
 * 不写世界图的字段：character_book（lorebook 结构复杂，v1 暂不支持）、
 * extensions 等酒馆运行时私有字段。
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { WorldGraphDataAccess } from "../data/world-graph-data-access.ts";
import { assertPathInside } from "../path-guard.ts";

/** 导入时写入世界图的卡字段（与 static-card-loader KNOWN_FIELDS 对齐 + 扩展） */
export const CARD_FACT_FIELDS = [
  "name",
  "personality",
  "scenario",
  "first_mes",
  "mes_example",
  "creator_notes",
  "tags",
  "system_prompt",
  "post_history_instructions",
  "alternate_greetings",
] as const;

/**
 * 卡字段 → world-graph property 键
 * 0.3.0 决策②：name 改写为「名字」以吃包侧 Entity.name 快照自动同步；
 * 其余卡字段保留英文键（static-card-loader KNOWN_FIELDS 直配，无需映射表）
 */
export function cardFieldToProperty(field: string): string {
  return field === "name" ? "名字" : field;
}

export interface ParsedCard {
  name: string;
  description: string;
  personality?: string;
  scenario?: string;
  first_mes?: string;
  mes_example?: string;
  creator_notes?: string;
  tags?: string[];
  system_prompt?: string;
  post_history_instructions?: string;
  alternate_greetings?: string[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

/**
 * 从 JSON 对象提取卡数据（兼容 V1 平铺 / V2 spec+data / V3）
 */
export function extractCardData(json: unknown): ParsedCard {
  // 🟡（2026-08-08）：入口守卫——null/数组/原始值此前抛 TypeError 不可诊断
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    throw new Error("角色卡 JSON 顶层必须是对象（收到 null/数组/原始值）");
  }
  const obj = json as Record<string, unknown>;
  // V2/V3：{ spec: "chara_card_v2"|"chara_card_v3", data: {...} }
  const spec = obj.spec;
  if (
    typeof spec === "string" &&
    spec.startsWith("chara_card") &&
    obj.data !== null &&
    typeof obj.data === "object" &&
    !Array.isArray(obj.data)
  ) {
    return obj.data as unknown as ParsedCard;
  }
  // V1：平铺
  if (typeof obj.name === "string") {
    return obj as unknown as ParsedCard;
  }
  throw new Error("无法识别的角色卡格式（既不是 V1 平铺也不是 V2/V3 spec+data）");
}

/**
 * 解析 PNG 内嵌卡数据（tEXt / 未压缩 iTXt chunk，keyword "chara" / "ccv3"）
 *
 * PNG 结构：8 字节签名 + 若干 chunk（length(4) type(4) data crc(4)）
 * tEXt: keyword\0text；iTXt: keyword\0flag\0method\0lang\0translated\0text
 * 不校验 CRC（导入场景信任文件来源）
 */
export function extractPngChunks(buf: Buffer): string {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) {
    throw new Error("不是有效的 PNG 文件");
  }
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === "tEXt" || type === "iTXt") {
      const nul = data.indexOf(0);
      if (nul > 0) {
        const keyword = data.toString("ascii", 0, nul);
        if (keyword === "chara" || keyword === "ccv3") {
          if (type === "tEXt") {
            return Buffer.from(data.toString("latin1", nul + 1), "base64").toString("utf8");
          }
          // iTXt：keyword\0 compressionFlag\0 compressionMethod\0 lang\0 translated\0 text
          const rest = data.subarray(nul + 1);
          const compressed = rest[0] === 1;
          if (compressed) throw new Error("iTXt 压缩 chunk 暂不支持（请用 tEXt 或 JSON 卡）");
          // 跳过 method(1) + lang\0 + translated\0
          let p = 1 + 1;
          p = rest.indexOf(0, p) + 1; // lang
          p = rest.indexOf(0, p) + 1; // translated
          const textBytes = rest.subarray(p);
          // ccv3 keyword 是明文 JSON，chara 是 base64
          const asString = textBytes.toString("utf8").trim();
          if (asString.startsWith("{")) return asString;
          return Buffer.from(asString, "base64").toString("utf8");
        }
      }
    }
    offset += 8 + length + 4; // data + crc
  }
  throw new Error("PNG 中未找到角色卡数据（chara/ccv3 chunk）");
}

/**
 * 从文件解析角色卡（按扩展名分发）
 *
 * @param cardPath 卡文件路径（绝对或相对）
 * @param baseDir 可选：路径越界防护基准目录（传入项目 cwd 后拒绝 ../ 越界；不传不校验）
 */
export async function parseCardFile(cardPath: string, baseDir?: string): Promise<ParsedCard> {
  const target = baseDir ? assertPathInside(baseDir, cardPath, "角色卡文件路径") : cardPath;
  const ext = path.extname(target).toLowerCase();
  if (ext === ".json") {
    const json = JSON.parse(await fs.readFile(target, "utf8"));
    return extractCardData(json);
  }
  if (ext === ".png") {
    const buf = await fs.readFile(target);
    const jsonText = extractPngChunks(buf);
    return extractCardData(JSON.parse(jsonText));
  }
  throw new Error(`不支持的卡文件格式: ${ext}（支持 .json / .png）`);
}

// ---------------------------------------------------------------------------
// 导入世界图
// ---------------------------------------------------------------------------

export interface ImportCardResult {
  entityId: string;
  name: string;
  factCount: number;
  eventId: string;
}

/**
 * 把角色卡导入世界图（birth 事件 + 卡字段 Facts + 自产自知可见性）
 *
 * @param dataAccess 统一世界图数据管道
 * @param card 解析后的卡数据
 * @param storyTime 诞生时刻
 * @param entityId 可选指定 entityId（缺省 ent_char_<hash8>）
 */
export async function importCardToWorldGraph(
  dataAccess: WorldGraphDataAccess,
  card: ParsedCard,
  storyTime: string,
  entityId?: string,
): Promise<ImportCardResult> {
  const eid = entityId ?? `ent_char_${crypto.randomBytes(4).toString("hex")}`;
  const eventId = `evt_card_import_${crypto.randomBytes(4).toString("hex")}`;

  // 卡字段 → newFacts（description 走 Entity.summary 独立字段，不进 Fact；
  // 0.3.0：Fact 值统一为 description，string 契约；name 键 →「名字」吃包侧快照同步）
  const newFacts: Array<{ entityId: string; property: string; description: string; modality: "fact" }> = [];
  for (const field of CARD_FACT_FIELDS) {
    const value = card[field];
    if (value === undefined || value === null || value === "") continue;
    newFacts.push({ entityId: eid, property: cardFieldToProperty(field), description: String(value), modality: "fact" });
  }
  // name 必填（卡没名字没法玩）；空字符串也要兜底（?? 只判 null/undefined）
  if (!newFacts.some((f) => f.property === "名字")) {
    newFacts.unshift({ entityId: eid, property: "名字", description: card.name || eid, modality: "fact" });
  }

  // birth 事件（summary = description，静态卡重组时映射回 card.description）
  await dataAccess.processEvent({
    eventId,
    type: "birth",
    storyTime,
    entityId: eid,
    entityType: "character",
    source: "user",
    summary: card.description ?? "",
    newFacts,
  });

  // 自产自知：角色知道自己卡上的所有字段（与 commit.ts 修复语义一致）
  for (const fact of newFacts) {
    const declarationId = `decl-${eid}-${fact.property}-${storyTime}`;
    try {
      await dataAccess.setVisibility(eid, declarationId, {
        state: "known",
        confidence: 1,
        source: "experienced",
        validFrom: storyTime,
        isExplicit: true,
      });
    } catch {
      // 可见性写入失败不阻断导入
    }
  }

  return { entityId: eid, name: String(card.name ?? eid), factCount: newFacts.length, eventId };
}
