/**
 * schemas.ts — LLM tool calling 的 TypeBox schema 定义
 *
 * 每个 LLM 阶段（阶段 2-6）都需要一个 schema + tool 定义。
 * 此文件集中管理，便于维护与复用。
 *
 * 用 TypeBox（pi-ai 要求的 schema 格式），与 world-graph 内核用 Zod 不冲突
 * （Zod 用于内核校验，TypeBox 用于 LLM tool schema 传输）。
 */

import { Type, StringEnum } from "@mariozechner/pi-ai";
import type { Tool } from "@mariozechner/pi-ai";

// ============================================================================
// 阶段 2：全书实体预扫描
// ============================================================================

/**
 * 实体清单 schema — 阶段 2 LLM 输出
 * 对应 spec L269-279, L380-390
 */
export const EntityInventorySchema = Type.Object({
  entities: Type.Array(
    Type.Object({
      name: Type.String({ description: "实体规范名（主称呼）" }),
      type: StringEnum(["character", "location", "item", "concept"], {
        description: "character=角色; location=地点; item=物品; concept=概念",
      }),
      aliases: Type.Array(Type.String(), {
        description: "别名/称呼列表（可为空数组）",
      }),
      first_seen_chapter: Type.Integer({
        description: "首次出现章节（1-based）",
        minimum: 1,
      }),
      brief: Type.String({
        description: "一句话描述（≤50字）",
        maxLength: 100,
      }),
    }),
    { description: "全书主要实体清单" },
  ),
});

export const entityInventoryTool: Tool = {
  name: "submit_entity_inventory",
  description:
    "提交全书主要实体清单。必须调用此工具一次提交结果。",
  parameters: EntityInventorySchema,
};

// ============================================================================
// 阶段 4：实体消解三级 LLM 子代理
// ============================================================================

/**
 * 实体对合并决策 schema — 用于三级 LLM 判断
 * 对应 spec L709-720
 */
export const MergeDecisionsSchema = Type.Object({
  decisions: Type.Array(
    Type.Object({
      pair_id: Type.String({
        description: "实体对 ID（与输入对应）",
      }),
      should_merge: Type.Boolean({
        description: "是否合并到同一实体",
      }),
      canonical_name: Type.String({
        description: "合并后的规范名（should_merge=true 时必填；false 时可填空字符串）",
      }),
      reason: Type.String({
        description: "判断理由（≤50字）",
        maxLength: 100,
      }),
    }),
    { description: "实体对合并决策列表，与输入对一一对应" },
  ),
});

export const mergeDecisionsTool: Tool = {
  name: "submit_merge_decisions",
  description:
    "提交实体合并决策。每对实体必须给出 should_merge 判断。必须调用此工具一次提交结果。",
  parameters: MergeDecisionsSchema,
};

// ============================================================================
// 阶段 3：章节事件流生成
// ============================================================================

/**
 * 章节事件流 schema — 阶段 3 LLM 输出
 * 对应 spec L543-566
 *
 * 字段约束：
 * - birth 事件必含 entity_type 和 summary（summary = 实体无状态客观事实描述，独立数据字段）
 * - change 事件必含 new_facts 或 invalidated（至少一项）
 * - death 事件不含 new_facts/invalidated
 * - storyTime 必须符合 `ch\d{3}\.ev\d{3}` 格式（在 stages.ts 校验）
 * - new_facts[].target_hint 缺省时 = entity_hint（跨实体声明时填）
 */
export const ChapterEventsSchema = Type.Object({
  events: Type.Array(
    Type.Object({
      storyTime: Type.String({
        description: "故事时刻 ch{章:03d}.ev{事件:03d}，如 ch001.ev001",
      }),
      type: StringEnum(["birth", "change", "death"], {
        description: "birth=实体首次登场; change=状态变更; death=实体退场",
      }),
      entity_hint: Type.String({
        description: "实体规范名（待阶段4 消解为 canonical entityId）",
      }),
      entity_type: Type.Optional(
        StringEnum(["character", "location", "item", "concept"], {
          description: "仅 birth 事件必填",
        }),
      ),
      summary: Type.Optional(
        Type.String({
          description: "实体摘要（≤200字，仅 birth 事件）",
          maxLength: 400,
        }),
      ),
      new_facts: Type.Optional(
        Type.Array(
          Type.Object({
            property: Type.String({ description: "属性路径" }),
            value: Type.Unknown({ description: "属性值（字符串/数字/布尔/对象均可）" }),
            modality: StringEnum(["fact", "belief", "hypothesis"], {
              description: "fact=客观事实; belief=角色主观信念; hypothesis=未证实假设",
            }),
            target_hint: Type.Optional(
              Type.String({
                description: "跨实体声明时目标实体规范名（省略时默认=entity_hint；birth 事件会被内核丢弃）",
              }),
            ),
          }),
          { description: "写入的新声明列表（birth/change 事件；death 事件不填）" },
        ),
      ),
      invalidated: Type.Optional(
        Type.Array(
          Type.Object({
            property: Type.String({
              description: "被替换的旧声明属性路径（不写 declarationId，导入器解析）",
            }),
          }),
          { description: "被替换的旧声明列表（仅 change 事件；birth/death 不填）" },
        ),
      ),
      narrative_summary: Type.Optional(
        Type.String({
          description: "事件叙事摘要（≤300字，人类可读）",
          maxLength: 600,
        }),
      ),
    }),
    { description: "本章事件流，按 storyTime 升序，1-50 个事件" },
  ),
});

export const chapterEventsTool: Tool = {
  name: "submit_chapter_events",
  description:
    "提交本章事件流。必须调用此工具一次提交结果。事件按 storyTime 升序排列。",
  parameters: ChapterEventsSchema,
};

// ============================================================================
// 阶段 5：关系抽取
// ============================================================================

/**
 * 关系抽取 schema — 阶段 5 LLM 输出
 * 对应 spec L795-810
 */
export const RelationsSchema = Type.Object({
  relations: Type.Array(
    Type.Object({
      source_hint: Type.String({ description: "源实体规范名" }),
      target_hint: Type.String({ description: "目标实体规范名" }),
      label: Type.String({
        description: "关系标签：knows/located_in/owns/part_of/related_to 或自定义",
      }),
      storyTime: Type.String({ description: "关系建立/解除的故事时刻 ch{章:03d}.ev{事件:03d}" }),
      action: StringEnum(["open", "close"], {
        description: "open=关系建立; close=关系解除",
      }),
      evidence: Type.String({
        description: "原文依据（≤200字）",
        maxLength: 400,
      }),
    }),
    { description: "本章关系列表" },
  ),
});

export const relationsTool: Tool = {
  name: "submit_relations",
  description:
    "提交本章抽取的关系列表。必须调用此工具一次提交结果。",
  parameters: RelationsSchema,
};

// ============================================================================
// 阶段 6：可见性推断
// ============================================================================

/**
 * 可见性推断 schema — 阶段 6 LLM 输出
 * 对应 spec L925-938
 *
 * ⚠️ 所有字段均设为 Optional：LLM 在长数组（80-150+ 条）末尾会系统性漏字段，
 *   而 pi-ai 的 validateToolCall 在 makeLlmCaller 返回前会前置校验 schema，
 *   必填字段缺失时直接抛错，stage 层的过滤逻辑无法执行。
 *   故此处全部改为 Optional 让 validateToolCall 通过，由 stages.ts 的 inferVisibilities
 *   做手动校验 + 过滤（过滤掉缺字段的元素，全部缺字段才视为失败重试）。
 */
export const VisibilitiesSchema = Type.Object({
  visibilities: Type.Array(
    Type.Object({
      characterId_hint: Type.Optional(
        Type.String({
          description: "角色规范名（谁能看见）",
        }),
      ),
      target_hint: Type.Optional(
        Type.String({
          description: "被看见的实体规范名",
        }),
      ),
      property: Type.Optional(
        Type.String({
          description: "被看见的声明属性（如 mood/location）",
        }),
      ),
      confidence: Type.Optional(
        Type.Number({
          description: "置信度 0-1（witnessed:0.9-1.0; rumor:0.3-0.6; inferred:0.5-0.8）",
          minimum: 0,
          maximum: 1,
        }),
      ),
      source: Type.Optional(
        Type.String({
          description: "来源：witnessed/rumor/inferred 或自定义",
        }),
      ),
      storyTime: Type.Optional(
        Type.String({
          description: "故事时刻 ch{章:03d}.ev{事件:03d}（=setVisibility.validFrom）",
        }),
      ),
      isExplicit: Type.Optional(
        Type.Boolean({
          description: "是否为显式可见（直接目睹 vs 推断）",
        }),
      ),
    }),
    { description: "本章可见性声明列表" },
  ),
});

export const visibilitiesTool: Tool = {
  name: "submit_visibilities",
  description:
    "提交本章可见性声明列表。必须调用此工具一次提交结果。",
  parameters: VisibilitiesSchema,
};
