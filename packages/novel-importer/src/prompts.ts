/**
 * prompts.ts — LLM prompt 模板
 *
 * 每个阶段的 prompt 全文在此集中维护。
 * Prompt 风格：角色 + 输入 + 任务 + 输出示意 + 注意事项。
 */

import type { SuspiciousPair, EntityHint } from "./types.ts";
import type { Chapter } from "./epub.ts";

// ============================================================================
// 阶段 2：全书实体预扫描
// ============================================================================

/** 每章样本截取长度（前 1500 字） */
const CHAPTER_SAMPLE_LENGTH = 1500;
/** 🟡（2026-08-08）：阶段 2 预扫描最多采样的章节数——数百章书籍全量样本
 * 超 LLM 上下文窗口；超限时均匀抽样并标注 */
const INVENTORY_MAX_CHAPTERS = 30;

/**
 * 构造阶段 2 全书实体预扫描的 prompt
 * 对应 spec L359-446
 */
export function buildEntityInventoryPrompt(chapters: Chapter[]): string {
  // 🟡：超限均匀抽样（保留首章——开篇章是主角团登场、实体预扫描信息量最大；
  // 其余按间隔均匀采样，抽样数固定为上限）
  const sampled =
    chapters.length <= INVENTORY_MAX_CHAPTERS
      ? chapters
      : chapters.filter((_, i) => {
          if (i === 0) return true; // 首章恒保留
          return Math.floor((i * INVENTORY_MAX_CHAPTERS) / chapters.length)
            !== Math.floor(((i - 1) * INVENTORY_MAX_CHAPTERS) / chapters.length);
        });
  const samples = sampled
    .map((ch) => {
      const sample = ch.content.slice(0, CHAPTER_SAMPLE_LENGTH);
      return `=== 第${ch.chapterId}章 ${ch.title}（前${sample.length}字）===\n${sample}`;
    })
    .join("\n\n");
  const samplingNote =
    chapters.length > INVENTORY_MAX_CHAPTERS
      ? `（全书共 ${chapters.length} 章，以下为均匀抽样的 ${sampled.length} 章样本）`
      : "";

  return `你是一个小说实体预扫描代理。你的任务是从章节样本中识别全书主要实体。

# 你会收到什么
你将收到多个章节的文本样本${samplingNote}（每章前 ${CHAPTER_SAMPLE_LENGTH} 字），格式如下：
=== 第{N}章 {标题}（前${CHAPTER_SAMPLE_LENGTH}字）===
{章节文本}

# 你需要理解什么
1. 识别所有出现的实体（角色/地点/物品/概念）
2. 判断每个实体的类型：
   - character：有意志的人物（能思考、做决定、说话的角色）
   - location：被动空间实体（场景、地点、建筑、区域）
   - item：物品实体（角色互动物，如武器、道具、信物、工具）
   - concept：弥漫性概念实体（世界观规则、组织、魔法系统、社会规则、文化现象）
3. 识别每个实体的别名/称呼（同一实体的不同叫法，如"酒寄彩叶"也叫"彩叶"、"小彩叶"）
4. 判断每个实体首次出现的章节序号（1-based）

# 输出要求
你必须调用 \`submit_entity_inventory\` 工具提交结果，不要返回纯文本。

工具参数格式：
{
  "entities": [
    {
      "name": "实体规范名（主称呼）",
      "type": "character | location | item | concept",
      "aliases": ["别名1", "别名2"],
      "first_seen_chapter": 1,
      "brief": "一句话描述（≤50字）"
    }
  ]
}

# 输入输出示意

## 输入示意
=== 第1章 相遇（前${CHAPTER_SAMPLE_LENGTH}字）===
酒寄彩叶站在校门口，耳机里播放着老歌。她抬头看了一眼天空...
=== 第2章 竹林（前${CHAPTER_SAMPLE_LENGTH}字）===
竹林深处传来声响。彩叶握紧手中的木剑...

## 输出示意（工具调用）
submit_entity_inventory({
  "entities": [
    {
      "name": "酒寄彩叶",
      "type": "character",
      "aliases": ["彩叶", "小彩叶"],
      "first_seen_chapter": 1,
      "brief": "主角，女高中生，佩戴耳机"
    },
    {
      "name": "校门口",
      "type": "location",
      "aliases": [],
      "first_seen_chapter": 1,
      "brief": "学校入口场景"
    },
    {
      "name": "耳机",
      "type": "item",
      "aliases": [],
      "first_seen_chapter": 1,
      "brief": "彩叶佩戴的物品"
    },
    {
      "name": "竹林",
      "type": "location",
      "aliases": [],
      "first_seen_chapter": 2,
      "brief": "第2章主要场景"
    },
    {
      "name": "木剑",
      "type": "item",
      "aliases": [],
      "first_seen_chapter": 2,
      "brief": "彩叶持有的武器"
    }
  ]
})

# 注意事项
- 配角/次要物品也要识别（不漏主要实体）
- 每章只读前 ${CHAPTER_SAMPLE_LENGTH} 字，章节中后段才登场的配角可能漏掉（靠阶段3 兜底）
- 别名要包含所有称呼方式（昵称、敬称、简称）
- brief 要简洁，一句话概括实体特征

# 实际输入

${samples}

# 输出
调用 submit_entity_inventory 工具提交结果。`;
}

export const ENTITY_INVENTORY_SYSTEM_PROMPT =
  "你是小说实体预扫描代理。必须调用 submit_entity_inventory 工具提交结果，不要返回纯文本。";

// ============================================================================
// 阶段 4：实体消解三级 LLM 子代理
// ============================================================================

/**
 * 构造实体对合并判断的 prompt
 * 对应 spec L695-734
 */
export function buildMergePrompt(pairs: SuspiciousPair[]): string {
  const pairsJson = JSON.stringify(
    pairs.map((p) => ({
      pair_id: p.pair_id,
      a: { name: p.a.name, type: p.a.type, aliases: p.a.aliases, brief: p.a.brief },
      b: { name: p.b.name, type: p.b.type, aliases: p.b.aliases, brief: p.b.brief },
      similarity: p.similarity.toFixed(3),
    })),
    null,
    2,
  );

  return `你是一个实体消解代理。你的任务是判断给定的实体对是否指向同一实体。

# 你会收到什么
你将收到一批实体对，每对包含两个实体的 name/type/aliases/brief，以及它们的字符串相似度。

# 你需要理解什么
1. 两个实体的 name 是否是同一实体的不同称呼（如"酒寄彩叶"vs"彩叶"→同一）
2. 两个实体的 type 必须相同才能合并（character 不能与 location 合并）
3. 结合 brief 上下文判断语义同一性
4. similarity 是 Jaro-Winkler 相似度参考值（0-1），>0.85 通常相似；0.6-0.85 区间需结合语义判断

# 输出要求
你必须调用 \`submit_merge_decisions\` 工具提交结果。

工具参数格式：
{
  "decisions": [
    {
      "pair_id": "对的ID",
      "should_merge": true | false,
      "canonical_name": "合并后的规范名（should_merge=true 时填规范名，false 时填空字符串）",
      "reason": "判断理由（≤50字）"
    }
  ]
}

# 输入输出示意

## 输入示意
[
  {"pair_id": "p1", "a": {"name": "小彩叶", "type": "character", "brief": "主角"}, "b": {"name": "彩叶", "type": "character", "brief": "主角"}, "similarity": "0.812"}
]

## 输出示意
submit_merge_decisions({
  "decisions": [
    {"pair_id": "p1", "should_merge": true, "canonical_name": "酒寄彩叶", "reason": "小彩叶是彩叶的昵称，指向同一主角"}
  ]
})

# 实际输入

${pairsJson}

# 输出
调用 submit_merge_decisions 工具提交结果。`;
}

export const MERGE_SYSTEM_PROMPT =
  "你是实体消解代理。必须调用 submit_merge_decisions 工具提交结果，不要返回纯文本。";

// ============================================================================
// 阶段 3：章节事件流生成
// ============================================================================

/**
 * 构造阶段 3 章节事件流生成的 prompt
 * 对应 spec L493-664
 */
export function buildChapterEventsPrompt(
  chapter: Chapter,
  entityInventory: EntityHint[],
): string {
  const inventoryJson = JSON.stringify(
    entityInventory.map((e) => ({
      name: e.name,
      type: e.type,
      aliases: e.aliases,
    })),
    null,
    2,
  );

  // 按 first_seen_chapter 区分：本章应 birth 的实体 vs 已在前面章节 birth 的实体
  // （stage 3 按章节并行处理，LLM 无法知道实体是否在别的章节已 birth；
  //  用 first_seen_chapter 明确告诉 LLM 本章的 birth 责任，避免漏 birth 或重复 birth）
  const entitiesToBirth = entityInventory.filter(
    (e) => e.first_seen_chapter === chapter.chapterId,
  );
  const entitiesAlreadyBorn = entityInventory.filter(
    (e) => e.first_seen_chapter < chapter.chapterId,
  );
  const birthListJson = JSON.stringify(
    entitiesToBirth.map((e) => ({ name: e.name, type: e.type, brief: e.brief })),
    null,
    2,
  );
  const alreadyBornListJson = JSON.stringify(
    entitiesAlreadyBorn.map((e) => ({ name: e.name, type: e.type })),
    null,
    2,
  );

  return `你是一个小说事件分析代理。你的任务是把一章小说切分为 1-50 个事件，输出符合世界图理论的事件流。

# 你会收到什么
1. 章节信息（序号、标题）
2. 已知实体清单（来自全书预扫描，JSON 格式）
3. 章节完整文本

# 你需要理解什么

## 1. 事件切分
把章节按"关键状态变更时机"切分为事件。切分标准：
- 时间跳跃、场景转换、视角切换
- 关键设定首次出场、关系变化、状态改变
- 平淡叙事不要切分，一章 1-50 个事件

## 2. 事件类型（三类原子操作）
- \`birth\`：实体首次登场。**关键规则：每个实体在本书中第一次出现时，必须先生成 birth 事件，再生成 change/death 事件**。第 1 章中所有出现的实体（包括主角、配角、地点、物品、概念）都必须先 birth。birth 事件含 new_facts = 实体初始属性（如 name/personality 等，不含 summary），顶层 summary 字段 = 实体无状态客观事实描述。不含 invalidated。
- \`change\`：状态变更。new_facts = 新声明。invalidated = 被替换的旧声明（只写 property）。⚠️ 不能对未 birth 的实体生成 change 事件。
- \`death\`：实体退场（死亡/离开/消失）。不含 new_facts/invalidated。⚠️ 不能对未 birth 的实体生成 death 事件。

## 2.1 ⚠️ 强制 birth 责任（最重要）
由于各章节并行处理，你无法知道实体是否在其他章节已 birth。系统已根据全书预扫描结果，明确分配了每章的 birth 责任：

**本章必须 birth 的实体清单**（这些实体的 first_seen_chapter = 本章，你必须在事件流中为每个生成恰好 1 个 birth 事件）：
${birthListJson}

**已在前面章节 birth 的实体清单**（本章可对其生成 change/death 事件，但**禁止**再生成 birth 事件）：
${alreadyBornListJson}

规则：
- 上面"本章必须 birth"清单中的每个实体，**必须**在本章事件流中出现 1 个 birth 事件（不多不少）
- 对"已在前面章节 birth"清单中的实体，**禁止**生成 birth 事件（会导致重复 birth）
- 如果本章出现了清单外的实体，用最接近的清单实体（按别名匹配），不要编造新名字

## 2.2 ⚠️ entity_hint 必须严格使用清单中的 name
\`entity_hint\` 字段必须严格使用"已知实体清单"中的 \`name\` 字段值，或该实体的别名对应的 name。
**严禁**编造清单中不存在的名字（如把两个名字拼接成"辉夜・彩P"、或随意起名"婴儿"、"犬DOGE"等）。
如果文中出现清单外的指代（如"邻居"、"姐姐"），请映射到清单中最接近的实体；若实在无对应实体，则不为该指代生成事件。

## 3. 故事时刻 storyTime
格式：\`ch{章节号:03d}.ev{事件序号:03d}\`
- 章节号 3 位零填充（如第1章 = ch001）
- 事件序号 3 位零填充（从 ev001 开始）
- 例：第1章第3个事件 = ch${String(chapter.chapterId).padStart(3, "0")}.ev003

## 4. 状态声明（new_facts）
每个声明包含：
- \`property\`：属性名，**必须使用中文词表**，按实体类型差异化：
  - character（角色）: 名字/性格/背景/说话风格/目标/能力/外貌/位置/心情/健康/当前行动/职业
  - location（地点）: 名字/描述/类型/天气/时段/氛围
  - item（物品）: 名字/材质/主人/历史/能力/状态/位置/磨损
  - concept（概念）: 名字/规则/范围/元素
  - 跨实体信念：信念.关于_{对象}.{方面}（如 信念.关于_彩叶.信任）
  - 跨实体假设：假设.关于_{对象}.{方面}
  - ⚠️ 禁止使用英文字段名（如 mood/location/name）。禁止把 summary 写入 property（走顶层 summary 字段）。
- \`value\`：属性值（字符串/数字/布尔/对象均可，中文人类可读）
- \`modality\`：模态
  - fact：客观事实
  - belief：角色主观信念（entityId = 持有信念的角色）
  - hypothesis：未证实假设（entityId = 持有假设的角色）
- \`target_hint\`：跨实体声明时目标实体名（省略时默认 = entity_hint）

⚠️ 重要：birth 事件的 modality 和 target_hint 都会被系统丢弃（硬编码 fact，所有声明归属 entity_hint）。若需 belief/hypothesis 模态或跨实体声明的初始声明，请在 birth 后紧跟一个 change 事件写入（change 事件保留 modality 和 target_hint）。

⚠️ summary 不作为属性写入 new_facts。实体的详细描述走 birth 事件顶层的 summary 字段（独立数据字段，不进 Fact）。

## 5. 被替换的旧声明（invalidated）
change 事件中，被替换的旧声明只写 \`property\`（系统会自动查找对应的 declarationId）。
例：彩叶的心情从"开心"变"难过"，invalidated = [{"property": "心情"}]，new_facts 含 {property: "心情", value: "难过"}

# 输出要求
你必须调用 \`submit_chapter_events\` 工具提交结果，不要返回纯文本。

工具参数格式：
{
  "events": [
    {
      "storyTime": "ch${String(chapter.chapterId).padStart(3, "0")}.ev001",
      "type": "birth | change | death",
      "entity_hint": "实体规范名",
      "entity_type": "character | location | item | concept（仅 birth 事件必填）",
      "summary": "实体无状态客观事实描述（仅 birth 事件，作为实体独立数据字段，不进 new_facts）",
      "new_facts": [
        {
          "property": "属性路径",
          "value": "属性值",
          "modality": "fact | belief | hypothesis",
          "target_hint": "目标实体名（跨实体声明时，省略则默认=entity_hint）"
        }
      ],
      "invalidated": [
        {"property": "被替换的旧声明属性路径"}
      ],
      "narrative_summary": "事件叙事摘要（≤300字，人类可读）"
    }
  ]
}

# 注意事项
- entity_hint 用规范名（待阶段4 消解为 canonical entityId）
- storyTime 必须符合 \`ch\\d{3}\\.ev\\d{3}\` 格式
- birth 事件必须含 entity_type 和 summary
- change 事件的 invalidated 只写 property（不写 declarationId）
- 跨实体声明用 target_hint 指定归属实体
- belief/hypothesis 的 entityId = 持有信念的角色（不是被相信的对象）

# 实际输入

章节信息：
- 章节序号: ${chapter.chapterId}
- 章节标题: ${chapter.title}

已知实体清单（来自全书预扫描，若本章出现同名或别名实体请复用）：
${inventoryJson}

章节全文：
${chapter.content}

# 输出
调用 submit_chapter_events 工具提交结果。`;
}

export const CHAPTER_EVENTS_SYSTEM_PROMPT =
  "你是小说事件分析代理。必须调用 submit_chapter_events 工具提交结果，不要返回纯文本。";

// ============================================================================
// 阶段 5：关系抽取
// ============================================================================

/**
 * 构造阶段 5 关系抽取的 prompt
 * 对应 spec L769-854
 */
export function buildRelationsPrompt(
  chapterId: number,
  eventsJson: string,
  inventoryJson: string,
): string {
  return `你是一个关系抽取代理。你的任务是从章节事件流中识别实体间的关系。

# 你会收到什么
1. 章节序号
2. 本章事件流（含 canonical entityId + storyTime + entity_hint + new_facts）
3. 本章实体清单（含 canonical entityId）

# 你需要理解什么

## 1. 关系类型
（0.3.0 词表：label 收窄为简单类型词——检索/闭合键，必须用中文枚举；叙事描述放 description 字段）
- \`朋友\`：朋友关系（双向）
- \`师徒\`：师徒关系（A 是 B 的师父/学生）
- \`恋人\`：恋爱关系（双向）
- \`亲属\`：亲属关系（家人/亲戚）
- \`同事\`：同事关系（共同工作）
- \`同学\`：同学关系（共同学习）
- \`邻居\`：邻居关系（住处相邻）
- \`上下级\`：上下级关系（A 是 B 的上司/下属）
- \`同盟\`：同盟关系（结盟/合作阵营）
- \`敌对\`：敌对关系（对立/仇视，单向或双向）
- \`认识\`：认识关系（A 认识 B，双向，无法归入上述时用）
- \`located_in\`：位于关系（A 位于 B，如角色在地点、物品在角色身上；**系统保留词，勿翻译**）
- 自定义：仅在上述枚举无法表达时使用中文短语（如 "仇敌"）

## 2. 关系动作
- \`open\`：关系建立（如两人初次认识）
- \`close\`：关系解除（如两人绝交、物品丢失）

## 3. 故事时刻
关系的 storyTime = 关系建立/解除的事件 storyTime（如 ch${String(chapterId).padStart(3, "0")}.ev004）

# 输出要求
你必须调用 \`submit_relations\` 工具提交结果。

工具参数格式：
{
  "relations": [
    {
      "source_hint": "源实体规范名",
      "target_hint": "目标实体规范名",
      "label": "朋友 | 师徒 | 恋人 | 亲属 | 同事 | 同学 | 邻居 | 上下级 | 同盟 | 敌对 | 认识 | located_in | 自定义中文",
      "description": "关系叙事描述（可选，一句话说明关系性质/背景）",
      "storyTime": "ch${String(chapterId).padStart(3, "0")}.ev004",
      "action": "open | close",
      "evidence": "原文依据（≤200字）"
    }
  ]
}

# 注意事项
- source_hint/target_hint 用规范名（待阶段7 解析为 canonical entityId）
- evidence 必填（原文依据 ≤200 字）
- storyTime 必须来自事件流中的某个 storyTime
- located_in 是单向的（A 在 B，不是 B 在 A）

# 实际输入

章节序号: ${chapterId}

本章事件流：
${eventsJson}

本章实体清单：
${inventoryJson}

# 输出
调用 submit_relations 工具提交结果。`;
}

export const RELATIONS_SYSTEM_PROMPT =
  "你是关系抽取代理。必须调用 submit_relations 工具提交结果，不要返回纯文本。";

// ============================================================================
// 阶段 6：可见性推断
// ============================================================================

/**
 * 构造阶段 6 可见性推断的 prompt
 * 对应 spec L894-976
 */
export function buildVisibilitiesPrompt(
  chapterId: number,
  eventsJson: string,
  charactersJson: string,
): string {
  return `你是一个可见性分析代理。你的任务是判断每个角色在每个事件时刻能看见/知道哪些信息。

# 你会收到什么
1. 章节序号
2. 本章事件流（含 storyTime + entity_hint + new_facts）
3. 本章角色清单

# 你需要理解什么

## 1. 可见性来源
- \`witnessed\`：亲眼目睹（角色在场，直接看到/听到）
- \`rumor\`：道听途说（从他人处听说，非亲历）
- \`inferred\`：推断得出（角色根据已知信息推理得出）
- 自定义来源（如 "telepathy" 心灵感应、"dream" 梦境）

## 2. 置信度 confidence（0-1）
- witnessed: 0.9-1.0（亲历，高置信）
- rumor: 0.3-0.6（传闻，中低置信）
- inferred: 0.5-0.8（推断，中高置信）

## 3. 可见性对象
每个可见性声明指向一个 StateDeclaration（由 entity_hint + property 标识）：
- characterId_hint：持有可见性的角色（谁能看见）
- target_hint：被看见的实体（谁的声明）
- property：被看见的声明属性（必须用中文词表，如 心情/位置/性格）

# 输出要求
你必须调用 \`submit_visibilities\` 工具提交结果。

工具参数格式：
{
  "visibilities": [
    {
      "characterId_hint": "角色规范名（谁能看见）",
      "target_hint": "被看见的实体规范名",
      "property": "被看见的声明属性（中文词表，如 心情/位置）",
      "confidence": 0.9,
      "source": "witnessed",
      "storyTime": "ch${String(chapterId).padStart(3, "0")}.ev004",
      "isExplicit": true
    }
  ]
}

# 注意事项
- characterId_hint/target_hint 用规范名（待阶段7 解析为 canonical entityId）
- property 必须是事件流 new_facts 中出现过的 property
- 同一角色对同一声明的可见性只输出一次（首次看见的 storyTime）

# 实际输入

章节序号: ${chapterId}

本章事件流：
${eventsJson}

本章角色清单：
${charactersJson}

# 输出
调用 submit_visibilities 工具提交结果。`;
}

export const VISIBILITIES_SYSTEM_PROMPT =
  "你是可见性分析代理。必须调用 submit_visibilities 工具提交结果，不要返回纯文本。";
