/**
 * static-card-loader.ts — 默认 staticCard 加载器
 *
 * 从 WorldGraph 的 Entity + Facts 重组一个 minimal SillyTavernCard
 *
 * 映射规则（基于 novel-importer 写入世界的字段约定）：
 * - name:        Fact property="name" 的 value，缺省用 entityId
 * - description: Entity.summary（实体无状态客观事实描述，独立字段）
 * - personality: Fact property="personality" 的 value
 * - scenario:    Fact property="scenario" 的 value
 * - first_mes:   Fact property="first_mes" 的 value
 * - mes_example: Fact property="mes_example" 的 value
 * - creator_notes / tags: 同名 Fact 透传
 * - 其余 property（mood/location 等）不进静态卡——它们是时变状态，走动态层注入
 *
 * 设计依据：
 * - novel-importer 的 birth 事件把 character 的 name/personality 等作为 newFacts 写入 Fact 表
 * - Entity.summary 是独立字段（不进 Fact），存客观事实描述
 * - role-pool 的 SillyTavernCard 是接口参数，对来源无约束
 *
 * 若需导入真实酒馆 V2 卡，可注入自定义 staticCardLoader（Pending Gap #1）
 */

import type { WorldGraph } from "underworld-graph";
import type { SillyTavernCard } from "./types.ts";

/**
 * 已知的 SillyTavernCard 字段（与 role-pool 子包的 SillyTavernCard interface 对齐）
 * 其他 Fact 字段按 property 名透传到 card（通过 [key: string]: unknown 索引签名）
 */
const KNOWN_FIELDS = [
  "name",
  "description",
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
 * 中文 property → SillyTavernCard 字段映射（0.3.0 词表：写侧中文）
 * 目前仅「名字」→ name（import-card 侧 name 键改写后回读）；
 * 其余中文词表条目（性格/背景…）暂无对应卡字段，留在卡 description 内即可
 */
const PROPERTY_TO_CARD_FIELD: Record<string, string> = {
  "名字": "name",
};

/**
 * 默认 staticCard 加载器
 *
 * @param wg 世界图实例
 * @param characterId 角色 ID
 * @param storyTime 故事时间
 * @returns SillyTavernCard（最小卡或从 Entity+Facts 重组的完整卡）
 *
 * 实体不存在或已消亡时返回最小卡（仅 name=characterId），role-pool 会照常调用 LLM，
 * 由角色规则集约束行为（不会因为缺卡而崩）。
 */
export async function defaultStaticCardLoader(
  wg: WorldGraph,
  characterId: string,
  storyTime: string,
): Promise<SillyTavernCard> {
  const snap = await wg.getEntityAt(characterId, storyTime);
  if (!snap) {
    // 实体不存在或已消亡，返回最小卡
    return { name: characterId, description: "" };
  }

  // 0.3.0：名字取 Entity.name 展示快照（包侧 birth/改名自动同步），缺失时回退 entityId
  const card: SillyTavernCard = {
    name: snap.name || characterId,
    description: snap.summary,
  };

  // 透传已知 SillyTavernCard 字段（0.3.0：声明值取 description；
  // 中文 property 经 PROPERTY_TO_CARD_FIELD 映射，未映射的不进卡）
  for (const prop of snap.properties) {
    const cardField = PROPERTY_TO_CARD_FIELD[prop.property] ?? prop.property;
    if ((KNOWN_FIELDS as readonly string[]).includes(cardField)) {
      (card as Record<string, unknown>)[cardField] = prop.description;
    }
  }

  // 「名字」Fact 兜底（快照未同步时仍可取到名字）
  if (!card.name) {
    const nameFact = snap.properties.find((p) => PROPERTY_TO_CARD_FIELD[p.property] === "name");
    if (nameFact) card.name = nameFact.description;
  }

  return card;
}
