# 语义导入世界图功能 重新设计

> **状态**: 设计中（v1.1，已修正 P0/P1 问题）
> **日期**: 2026-07-21
> **设计依据**:
>   - `docs/legacy/v2-design-notes.md`（V2 设计笔记，9.1-9.10 节）
>   - `docs/legacy/world-graph-storage-design.md`（存储设计）
>   - `docs/legacy/feishu-doc-summary.md` 第 25/28/29 节（角色节点三层结构 / 四层背景 / 压缩策略）
>   - `src/types.ts`（当前类型定义）
>   - `src/storage.ts`（当前 storage 实现，已核对 createNode/createEdge/applyEvent/createChapter 签名）
> **目标**: 重新设计 `import-novel-v2.mjs`，对齐设计文档，产出语义完整的 world-graph

---

## 1. 设计目标

从已有小说文本（EPUB）语义化导入到 world-graph，产出：

1. **节点**：分层 schema（base_profile + current_state），信息密度足够子代理注入
2. **边**：有 type_category / fact / evidence / created_by_event 的完整关系
3. **事件链**：每个事件含 diffusions，diffusion.field 带层级前缀
4. **向量**：节点/边内联 summary_embedding / fact_embedding
5. **章节元数据**：chapters/chapter-*.json
6. **章节完整**：不丢失章节（修复 ch3/ch8 缺失）

---

## 2. 设计依据核对

### 2.1 角色节点三层结构（25 号文档原文）

> "角色节点不是普通的 key/content 条目，而是有结构的：
> - **基础设定（酒馆角色卡）** — 性格、背景、说话风格、外貌… 始终注入角色子代理
> - **动态记忆** — 该角色经历过的事件（压缩摘要），按久远度分层
> - **当前状态** — 情绪、关系值、位置… 随扩散实时更新
>
> 调度器分配知识时：基础设定始终注入，动态记忆按久远度压缩，当前状态从世界图实时读取。"

**关键决策（用户裁决，覆盖 v2-design-notes 4.5 节）**：

- 基础设定 → 世界图节点字段（始终注入子代理）
- 当前状态 → 世界图节点字段（实时读取）
- **动态记忆 → 世界图节点字段**（不再由子代理实例维护）

**裁决理由**：除角色扮演时的临时上下文外，所有状态全部由世界图统一处理。这样：
1. 子代理无状态化，崩溃/重启不丢记忆
2. 记忆检索走世界图的统一索引（向量+图遍历），不靠子代理实例的内存
3. 回退/重放时记忆也跟着事件链走，保持一致性
4. 子代理只负责"角色扮演的临时上下文"（当前这一轮对话的 working memory），其他全在图里

**v2-design-notes 4.5 节关于"子代理持久化状态"的描述作废**，以本设计为准。

### 2.2 四层节点（28 号文档 + storage-design 2.2 节）

| 层 | 检索策略 | 压缩策略（29 号） |
|---|---|---|
| 角色层 character | 始终检索全部 | 三段距离压缩 |
| 角色互动物层 character-item | 事件涉及才检索 | 只保留当前态 |
| 非角色互动物层 scene-prop | 场景切换时检索 | 不压缩 |
| 背景层 background | 始终注入 | 不压缩 |

**导入器责任**：按 type 正确分类 + base_profile / current_state 分层填写。

### 2.3 字段分类（storage-design 10.1-10.3 节 + types.ts）

- **引擎字段**（固定）：uuid / type / lifecycle / created_by_event / created_at / updated_at / aliases / tags / invalid
- **语义字段**（灵活）：name / summary / **base_profile** / **current_state** / attributes（元数据）
- **向量字段**：summary_embedding / fact_embedding

**注**：storage-design.md 10.3 节示例把 personality / appearance / current_mood 都堆在 attributes 里，**不符合** 25 号文档三层结构。本设计按 25 号文档为准，base_profile 和 current_state 独立字段。

### 2.4 边字段（storage-design 11 节 + types.ts）

- **引擎字段**：uuid / source_uuid / target_uuid / type / type_category / lifecycle / created_by_event / created_at / updated_at / invalid
- **语义字段**：fact / attributes（evidence 等扩展）
- **向量字段**：fact_embedding

**基础枚举优先**（11.4 节）：owns / knows / located_in / part_of / related_to，自定义走 type_category=other

### 2.5 事件节点（storage-design 3.2 节 + types.ts WorldEvent）

- uuid / parent / chapter_id / created_at（引擎）
- content / narrative_text / timestamp（语义）
- diffusions: [{target_uuid, field, old_value, new_value}]

**field 路径约束**（本设计新增）：必须以 `base_profile.` / `current_state.` / `attributes.` / `summary` / `name` 等开头，禁止污染顶层引擎字段。

### 2.6 章节元数据（storage-design 15.6 节）

chapters/chapter-*.json 含 chapter_id / title / status / start_event / end_event / summary / created_at / frozen_at

---

## 3. 整体流程（重新设计）

```
EPUB (N章)
   │
   ▼
[阶段0] 全书实体预扫描（新增）
   │   每章读前 1500 字 → LLM 一次性输出全书主要实体清单
   │   输出：[{name, type, aliases, first_seen_chapter}]
   │   目的：给阶段1 提供已知实体上下文，减少跨章重复创建
   ▼
[阶段1] 每章摘要（并行限流，带阶段0 实体清单）
   │   LLM 输出：
   │   - narrative_summary（本段叙事摘要，200-500 字）
   │   - new_settings（分层：base_profile + current_state）
   │   - state_changes（field 带前缀：base_profile.* / current_state.*）
   │   - first_appearance_text（原文校验）
   ▼
[阶段2] LLM 分批语义归并（替代纯算法归并）
   │   Step A：算法预聚类（name+aliases 精确匹配）→ 候选组
   │   Step B：LLM 二次归并（每批 ≤25 组），判断哪些组应合并
   │   输出：canonical_uuid + 合并决策
   ▼
[阶段3] 事件链构建（纯计算）
   │   按 (chapter_id, seq) 顺序串联，parent 指向上一条
   │   为节点创建事件预留位置（按 first_appearance 插入，见 8.1 节）
   │   diffusions 用 alias_mappings 把 setting_name 替换为 canonical_uuid
   │   输出：eventChain（含已分配的 event_uuid，供阶段4 边的 source_event_uuid 引用）
   ▼
[阶段4] 按章节分批边生成（schema 升级）
   │   输入：globalSettings + eventChain（提供已存在的 event_uuid）
   │   LLM 输出：
   │   - source_uuid + target_uuid + type（优先基础枚举）
   │   - type_category（大类）
   │   - fact（关系事实描述）
   │   - evidence（原文依据，必填，≤200 字）
   │   - source_event_uuid（创建事件，必填，必须引用 eventChain 中已存在的 UUID）
   ▼
[阶段5] 写入 world-graph（schema 升级 + 向量补齐）
   │   节点：base_profile + current_state + attributes(元数据) + summary_embedding
   │   边：created_by_event + fact + evidence + fact_embedding
   │   事件：uuid + parent + chapter_id + content + diffusions
   │   章节元数据：chapters/chapter-*.json
   │   向量：调 embedder.embed() 补齐所有 summary / fact
   ▼
[阶段6] 数据校验（新增）
   │   - 章节完整性（N 章全部处理）
   │   - 节点 base_profile 必填字段非空
   │   - 边 created_by_event / evidence 必填
   │   - 事件 diffusions.field 前缀合规
   │   - 向量字段非空
   ▼
完成
```

---

## 4. Schema 详细定义

### 4.1 节点 Schema（角色为例）

```jsonc
{
  // === 引擎字段（固定） ===
  "uuid": "node_character_e6c5ff30",
  "type": "character",
  "lifecycle": "permanent",
  "created_by_event": "event_ch1_seq1_xxx",  // 必填，从事件链反查
  "created_at": "2026-07-21T...",
  "updated_at": "2026-07-21T...",
  "aliases": ["酒寄彩叶", "酒寄同学", "彩P", "いろP"],
  "tags": ["v2", "role:protagonist"],
  "invalid": false,

  // === 语义字段（灵活，独立字段不合并到 attributes） ===
  "name": "彩叶",
  "summary": "主角，独自在东京生活的高中生，辉夜的制作者与同居人",
  
  // 基础设定层（始终注入子代理，stable）
  "base_profile": {
    "personality": "沉默寡言、自尊心强、不善表达感情",
    "appearance": "橘色瞳孔（戴智能隐形眼镜时），高中生打扮",
    "background": "初三冬天离家出走，以学费生活费全部自理为条件来到东京，父亲去世，哥哥离家出走",
    "speaking_style": "简短、克制、用敬语",
    "goals": ["独立生活", "升学法学部", "守护辉夜"],
    "abilities": ["游戏操作职业水准", "BAMBOOcafe 打工"]
  },
  
  // 当前状态层（随扩散实时更新）
  "current_state": {
    "location": "学校",
    "mood": "紧张但期待",
    "health": "正常",
    "认知": "意识到自己任性傲慢"
  },

  // 动态记忆层（按久远度分层压缩，由世界图节点统一维护）
  // V2 导入器从事件链反向提取 recent，compressed/skeleton 留空
  "dynamic_memory": {
    "recent": [/* 该角色相关的近期事件摘要列表 */],
    "compressed": [],  // 引擎运行时按压缩策略逐步沉淀
    "skeleton": []     // 早期因果骨架，引擎运行时沉淀
  },

  // 元数据 attributes（引擎用，不放语义字段）
  "attributes": {
    "first_appearance_chapter": 1,
    "first_appearance_seq": 1,
    "source": "v2-import"
  },
  
  // === 向量字段（辅助检索，inline 存储） ===
  "summary_embedding": [0.1, 0.2, ...],  // 512 维 bge-small-zh-v1.5
  "embedding_stale": false
}
```

### 4.2 节点 Schema 差异化（按类型）

按 28/29 号文档的分层检索和压缩策略，各类型节点的 `base_profile` / `current_state` 字段差异化：

| 节点类型 | base_profile 必填字段 | current_state | dynamic_memory | 检索策略 |
|---|---|---|---|---|
| `character` 角色 | personality / appearance / background / speaking_style / goals / abilities | location / mood / health / 等动态状态 | recent / compressed / skeleton 三层（V2 导入器填 recent） | 始终检索全部 |
| `character-item` 角色互动物 | material / abilities / history / owner | state（当前态：剩余数、磨损度、开启状态等） | ❌ 不需要（29 号："只保留当前态，历史无用"） | 事件涉及才检索 |
| `scene-prop` 场景氛围物 | description / type | state（天气、时段、氛围等） | ❌ 不需要（29 号："不压缩，换景时不参与"） | 场景切换时检索 |
| `background` 背景 | rules / elements / scope | ❌ 不需要（极少变） | ❌ 不需要（29 号："不压缩，累积不衰减"） | 始终注入 |

**说明**（动态记忆裁决后更新）：
- `dynamic_memory` 现在由**世界图节点**统一维护（覆盖 v2-design-notes 4.5 节），不再由子代理实例持久化
- V2 导入器只填 `dynamic_memory.recent`（从事件链反向提取该角色相关的事件摘要），`compressed` 和 `skeleton` 留空，由引擎运行时按 29 号压缩策略逐步沉淀
- `base_profile` 是"始终注入"层，字段相对稳定，重大转折才变化
- `current_state` 是"实时读取"层，随扩散频繁更新
- `dynamic_memory` 是"历史压缩"层，按久远度分层检索（recent 完整 / compressed 压缩 / skeleton 骨架）

### 4.3 边 Schema

```jsonc
{
  // === 引擎字段 ===
  "uuid": "edge_e6c5ff30_deba7f96_owns_001",
  "source_uuid": "node_character_e6c5ff30",
  "target_uuid": "node_character_deba7f96",
  "type": "knows",                         // 基础枚举优先
  "type_category": "social",               // 大类：possession/social/spatial/composition/other
  "lifecycle": "permanent",
  "created_by_event": "event_ch4_seq1_xxx", // 必填，从事件链反查
  "created_at": "2026-07-21T...",
  "updated_at": "2026-07-21T...",
  "invalid": false,

  // === 语义字段 ===
  "fact": "彩叶与辉夜同居，辉夜住在彩叶家中",
  "attributes": {
    "evidence": "原文依据（必填，≤200字）",
    "established_at_event": "event_ch4_seq1_xxx",  // 关系建立时间
    "invalid_at_event": null                       // 失效时间（可选，回退时填）
  },

  // === 向量字段 ===
  "fact_embedding": [0.1, 0.2, ...]
}
```

**基础枚举优先策略**（storage-design 11.4 节）：

| 基础枚举 | type_category | 语义 |
|---|---|---|
| `owns` | possession | 持有关系（角色↔物品） |
| `knows` | social | 人际关系（角色↔角色） |
| `located_in` | spatial | 空间关系（角色/物品↔地点） |
| `part_of` | composition | 组合关系（物品↔物品，地点↔地点） |
| `related_to` | other | 其他（兜底） |

**基础枚举为主体，自定义作为补充关系**（用户裁决）：

- 基础枚举（owns/knows/located_in/part_of/related_to）覆盖大多数常见关系，是 LLM 输出的首选
- 当基础枚举无法精确表达时（如 `mentor_of` 师徒 / `created_by` 创造 / `rival_of` 对手 / `family_of` 亲属），允许自定义 type 作为补充
- 自定义 type 必须满足：
  1. 明确 `type_category`（possession/social/spatial/composition/other）
  2. `fact` 字段给出可验证的事实描述
  3. `evidence` 必填，有原文依据
- LLM prompt 里强化："优先用基础枚举，无法表达时再用自定义，但不要为追求花样而滥用自定义"

### 4.4 事件 Schema

```jsonc
{
  // === 引擎字段 ===
  "uuid": "event_ch1_seq1_a1b2c3d4",
  "parent": null,                          // 首事件为 null，其他指向上一个事件 uuid
  "chapter_id": 1,
  "created_at": "2026-07-21T...",

  // === 语义字段 ===
  "content": "叙事摘要（200-500字）",
  "narrative_text": "",                    // 渲染器生成的故事文本，V2 导入器留空
  "timestamp": "",                         // 故事内时间戳，V2 导入器留空

  // === diffusions ===
  "diffusions": [
    {
      "target_uuid": "node_character_e6c5ff30",
      "field": "current_state.location",   // 必须带前缀，禁止污染顶层引擎字段
      "old_value": "家",
      "new_value": "学校"
    },
    {
      "target_uuid": "node_character_e6c5ff30",
      "field": "current_state.mood",
      "old_value": "平静",
      "new_value": "紧张但期待"
    }
  ]
}
```

**diffusion.field 路径白名单**：
- `base_profile.<field>` — 基础设定变化（罕见，重大转折）
- `current_state.<field>` — 当前状态变化（常见）
- `attributes.<field>` — 元数据变化
- `summary` — 概要变化
- `name` — 改名（罕见）

**禁止路径**：`uuid` / `type` / `lifecycle` / `created_by_event` / `created_at` / `updated_at` / `invalid` / `aliases` / `tags` 等引擎字段。

### 4.5 章节元数据 Schema

```jsonc
// chapters/chapter-1.json
{
  "chapter_id": 1,
  "title": "第一章 彩叶",
  "status": "frozen",                      // 对齐 types.ts: "active" | "frozen"。V2 导入器产出 frozen，引擎运行时新建章节用 active
  "start_event": "event_ch1_seq1_a1b2c3d4",
  "end_event": "event_ch1_seq5_e5f6g7h8",
  "summary": "本章讲述彩叶在 BAMBOOcafe 打工时遇到辉夜...",
  "event_count": 5,
  "created_at": "2026-07-21T...",
  "frozen_at": "2026-07-21T..."
}
```

---

## 5. LLM 工具 Schema 详细定义

### 5.1 summaryTool（阶段1 每章摘要）

```typescript
const SummarySchema = Type.Object({
  summaries: Type.Array(
    Type.Object({
      seq: Type.Integer({ description: "本章内序号，从 1 开始" }),
      narrative_summary: Type.String({
        description: "本段叙事摘要（200-500 字），描述发生了什么",
        minLength: 50,
      }),
      new_settings: Type.Array(
        Type.Object({
          name: Type.String({ description: "设定名（标准化，去掉敬称前缀）" }),
          type: StringEnum(
            ["character", "character-item", "scene-prop", "background"],
            { description: "character=角色; character-item=角色互动物; scene-prop=场景氛围物; background=背景设定" }
          ),
          aliases: Type.Array(Type.String(), {
            description: "别名/称呼列表（可为空数组）",
          }),
          // 按类型差异化的分层字段
          base_profile: Type.Object(
            {
              // 角色必填：personality / background / speaking_style
              // 互动物必填：material / owner
              // 场景道具必填：description / type
              // 背景必填：rules / scope
              // 注：TypeBox 不支持"按兄弟字段 type 动态切换 schema"，
              //     这里用宽松 Object + minProperties 兜底，子字段必填性由导入器后处理校验
            },
            {
              description: "基础设定层，字段按 type 差异化（见 4.2 节）。最少 3 个字段，子字段必填性由后处理校验",
              minProperties: 3,
            }
          ),
          current_state: Type.Optional(
            Type.Object(
              {},
              {
                description: "当前状态层。角色和互动物必填，背景可省略。最少 1 个字段",
                minProperties: 1,
              }
            ),
            { description: "当前状态层，可选（背景类型可省略）" }
          ),
          first_appearance_text: Type.String({
            description: "原文中首次出现的句子（≤100字），用于校验",
            maxLength: 200,
          }),
        }),
        { description: "本段首次出现的设定（角色/物品/地点/背景）" }
      ),
      state_changes: Type.Array(
        Type.Object({
          setting_name: Type.String({
            description: "发生变化的设定名（必须在本章已出现的设定中）",
          }),
          field: Type.String({
            description: "变化字段路径，必须以 base_profile. / current_state. / attributes. / summary / name 开头",
            pattern: "^(base_profile|current_state|attributes|summary|name)(\\.|$)",
          }),
          old_value: Type.String({
            description: "本章上一条摘要时的值。首条或新设定填空字符串",
          }),
          new_value: Type.String({ description: "新值" }),
          evidence: Type.String({
            description: "原文依据（≤200字）",
            maxLength: 200,
          }),
        }),
        {
          description:
            "相对本章上一条摘要的状态变化。首条摘要的 state_changes 应为空数组。",
        }
      ),
    }),
    {
      description:
        "本章摘要列表，按原文顺序排列。每当发生关键状态变更时切分新摘要。1-20 条。",
      minItems: 1,
      maxItems: 20,
    }
  ),
});
```

**关键变化 vs 旧版**：
- `initial_state`（单字段）→ 拆为 `base_profile` + `current_state`（分层）
- `state_changes.field` 新增路径前缀约束（`base_profile.` / `current_state.` 等），用 `pattern` 强校验
- `base_profile` 字段按节点类型差异化（prompt 里详述），schema 层面用 `minProperties: 3` 兜底
- `state_changes.evidence` 描述与 maxLength 统一为 200 字
- 导入器后处理校验：character 类必须有 personality+background+speaking_style；character-item 必须有 material+owner；scene-prop 必须有 description+type；background 必须有 rules+scope。缺失则 LLM 重试 1 次，仍失败则警告并在校验报告标记 P1

### 5.2 mergeTool（阶段2 LLM 二次归并）

```typescript
const MergeSchema = Type.Object({
  merge_decisions: Type.Array(
    Type.Object({
      group_ids_to_merge: Type.Array(Type.String(), {
        description: "应合并的候选组 ID 列表（至少 2 个）",
      }),
      canonical_name: Type.String({ description: "归并后的规范名" }),
      reason: Type.String({ description: "合并理由（≤50字）", maxLength: 100 }),
    }),
    { description: "归并决策列表。未列出的候选组保持独立。" }
  ),
});
```

**关键变化 vs 旧版**：
- 不再要求 LLM 输出完整 global_settings（避免 8192 token 截断）
- 只输出"哪些组应合并"的决策，其他字段从原始数据合成
- 输入预聚类后的候选组（每批 ≤25 组），避免单次调用过大

### 5.3 edgeTool（阶段4 边生成）

```typescript
const EdgeSchema = Type.Object({
  edges: Type.Array(
    Type.Object({
      source_name: Type.String({ description: "源设定名（必须是全局设定之一）" }),
      target_name: Type.String({ description: "目标设定名（必须是全局设定之一）" }),
      type: Type.String({
        description: "关系类型。优先用基础枚举：owns / knows / located_in / part_of / related_to；自定义需在 reason 说明",
      }),
      type_category: StringEnum(
        ["possession", "social", "spatial", "composition", "other"],
        { description: "关系大类" }
      ),
      fact: Type.String({
        description: "关系事实描述（≤200字）",
        maxLength: 200,
      }),
      evidence: Type.String({
        description: "原文依据（必填，≤200字）",
        maxLength: 200,
      }),
      source_event_uuid: Type.String({
        description: "关系建立的事件 UUID（必须是阶段3 已构建的事件链中存在的事件 UUID）",
      }),
    }),
    { minItems: 0 }
  ),
});
```

**关键变化 vs 旧版**：
- `type` 优先用基础枚举（prompt 里强化）
- `evidence` 必填（旧版可选）
- `source_event_uuid` 必填（旧版可选，导致 created_by_event 全是 "user"）
- `type_category` 显式输出（旧版靠 type 反推）

---

## 6. 阶段 0：全书实体预扫描（新增）

### 6.1 目的

给阶段1 提供已知实体上下文，减少跨章重复创建同一实体（如"彩叶"在第1章和第4章被独立创建）。

### 6.2 流程

```
For each chapter:
  Read 前 1500 字
Concat all → 一次性 LLM 调用
Output: 全书主要实体清单
```

**已知限制**：前 1500 字采样可能漏掉章节中后段才登场的配角/物品。阶段0 的目的是"减少"跨章重复创建，不是"消除"——遗漏的实体在阶段1 仍会被当作新设定创建，依靠阶段2 LLM 语义归并兜底。整章扫描成本上升 5-10 倍但收益边际递减，不值得。

### 6.3 实体清单 Schema

```typescript
const EntityInventorySchema = Type.Object({
  entities: Type.Array(
    Type.Object({
      name: Type.String({ description: "规范名" }),
      type: StringEnum(["character", "character-item", "scene-prop", "background"]),
      aliases: Type.Array(Type.String()),
      first_seen_chapter: Type.Integer({ description: "首次出现章节（1-based）" }),
      brief: Type.String({ description: "一句话描述（≤50字）", maxLength: 100 }),
    })
  ),
});
```

### 6.4 注入阶段1

阶段1 的 summaryTool prompt 里附带阶段0 的实体清单，提示 LLM："以下实体已知存在，若本章出现同名或别名实体，请复用而非新建。"

---

## 7. 阶段 2：LLM 分批语义归并详细设计

### 7.1 两步归并流程

```
Step A: 算法预聚类
  输入: 所有章节的 new_settings（保留全字段）
  操作: 按 name + aliases 精确匹配分组合并
  输出: M 个候选组（M ≤ N）

Step B: LLM 二次归并（分批）
  输入: M 个候选组（每批 ≤25 组）
  操作: LLM 判断哪些组应合并（语义相同但字面不同）
  输出: merge_decisions 列表

Step C: 应用合并决策
  操作: 按 merge_decisions 合并候选组，生成最终 globalSettings
  UUID 生成: sha256(canonical_name + sorted(aliases)).slice(0, 8)
```

### 7.2 LLM 输入样例

```jsonc
{
  "candidate_groups": [
    {
      "group_id": "g_001",
      "canonical_name": "彩叶",
      "type": "character",
      "all_aliases": ["彩叶", "酒寄同学"],
      "first_seen_chapter": 1,
      "base_profile_summary": "高中生，在 BAMBOOcafe 打工"
    },
    {
      "group_id": "g_002",
      "canonical_name": "酒寄彩叶",
      "type": "character",
      "all_aliases": ["酒寄彩叶", "彩P"],
      "first_seen_chapter": 4,
      "base_profile_summary": "主角，独自在东京生活"
    }
  ]
}
```

### 7.3 LLM 输出样例

```jsonc
{
  "merge_decisions": [
    {
      "group_ids_to_merge": ["g_001", "g_002"],
      "canonical_name": "彩叶",
      "reason": "同一角色，'酒寄'为姓氏，'彩叶'为本名"
    }
  ]
}
```

### 7.4 成本估算

- 全书 ~110 个原始设定 → 算法预聚类后 ~70 个候选组
- 分 3 批 × 25 组 = 75 组覆盖
- 每批 ~2000 token 输入 + ~1000 token 输出
- 总成本 ~$0.003，耗时 ~20s

---

## 8. 阶段 5：写入 world-graph 详细设计

### 8.1 节点创建事件插入策略（已裁决）

**裁决：按 first_appearance 插入**。节点创建事件（写入 `base_profile` / `current_state` 初始值的扩散事件）插在该节点**首次出现的那条叙事事件之前**。

**语义**：回退到节点创建事件 = 回退到该角色/物品登场前。符合"节点随叙事诞生"的设计原意，避免"第 8 章登场的角色在第 1 章前就被创建"的语义割裂。

**事件链长度变化**：原 53 条叙事事件 + 节点创建事件数（≈全局设定数，约 50-70 个）= 约 100-125 条。可接受。

**实施要点**：
1. 阶段3 构建事件链时，先按 (chapter_id, seq) 顺序串联叙事事件
2. 对每个 globalSetting，找到其 `first_appearance_chapter + first_appearance_seq` 对应的叙事事件
3. 在该叙事事件**之前**插入一个节点创建事件：
   - `parent` = 该叙事事件原本的 parent
   - 该叙事事件的 `parent` 改为指向节点创建事件
4. 节点创建事件的 `diffusions` = 该节点所有 `base_profile.*` 和 `current_state.*` 初始字段
5. 多个节点首次出现在同一叙事事件前时，按 globalSetting 顺序串联插入（A → B → 叙事事件）

### 8.2 节点写入流程

```
For each globalSetting:
  1. 组装 base_profile + current_state（从原始数据分层）
  2. 调 store.createNode({
       type, name, summary, aliases,
       attributes: { first_appearance_chapter, first_appearance_seq, source: "v2-import" },
       tags: ["v2"],
       lifecycle: "permanent",
       createdByEvent: <节点创建事件的 UUID>,  // 前向引用，createNode 不校验存在性
     })
     // 注意：store.createNode 会用 generateNodeUuid 生成 store_uuid，
     //       与 LLM 阶段2 生成的 canonical_uuid 不同。
     //       建立映射 canonical_uuid → store_uuid，后续 diffusion.target_uuid / edge.source_uuid 都用 store_uuid。
  3. 节点创建事件的 diffusions 在阶段3 已组装好（带 base_profile.* / current_state.* 前缀），
     target_uuid 替换为 store_uuid
  4. 调 embedder.embed(summary) → 写入 summary_embedding（见 8.6）
```

### 8.3 storage.ts 接口扩展需求

**8.3.1 createNode（无需扩展）**

当前 [createNode](file:///d:/claude/pi-ex/narrative-engine/src/storage.ts#L543-585) 签名已够用。关键约定（隐式契约，需在导入器注释里注明）：
- `createNode` 不校验 `createdByEvent` 是否在事件链中存在（[storage.ts:558-584](file:///d:/claude/pi-ex/narrative-engine/src/storage.ts#L558-584) 未做此校验）
- 因此"先 createNode（前向引用未来事件 UUID）→ 后 applyEvent（节点创建事件）"可行
- 调用方必须保证最终 `applyEvent` 该事件 UUID，否则节点的 `created_by_event` 会成为悬空引用
- `base_profile` / `current_state` 不通过 createNode 写入，而是通过节点创建事件的 diffusions 写入（复用 setFieldValue 的 dot notation）

**8.3.2 createChapter（需扩展）**

当前 [createChapter](file:///d:/claude/pi-ex/narrative-engine/src/storage.ts#L1370-1392) 只接受 `title`，自动分配 `chapter_id = current_chapter + 1`，`status` 硬编码为 `"active"`。导入器需要：
- 按 EPUB 章节顺序指定 chapter_id（1, 2, 3, ...）
- 创建时直接 `status: "frozen"`（导入器产出已完结章节）
- 写入 `summary` 字段

**扩展方案**：新增 `createChapterForImport(input: { chapter_id, title, summary, status: "frozen" })` API，或扩展现 `createChapter` 签名支持可选参数。**优先扩展 createChapter**（向后兼容）：

```typescript
async createChapter(input: {
  title: string;
  chapterId?: number;      // 可选，缺省则 current_chapter + 1
  summary?: string;        // 可选
  status?: ChapterStatus;  // 可选，缺省 "active"
}): Promise<Chapter>
```

导入器调用：`store.createChapter({ title, chapterId: ep.chapId, summary, status: "frozen" })`。
注意：`start_event` / `end_event` 由 `applyEvent` 自动更新（[storage.ts:872-877](file:///d:/claude/pi-ex/narrative-engine/src/storage.ts#L872-877)），`frozen_at` 由 `freezeChapter` 设置——但既然导入器直接 status="frozen"，应同时写入 `frozen_at`。

### 8.4 边写入流程

```
For each generated edge:
  1. 解析 source_name / target_name → source_uuid / target_uuid（通过 canonical_uuid → store_uuid 映射）
  2. 调 store.createEdge({
       sourceUuid, targetUuid,
       type, typeCategory,
       fact,
       createdByEvent: edge.source_event_uuid,  // 必填，必须是 eventChain 中已 applyEvent 的事件 UUID
       attributes: { evidence, established_at_event: edge.source_event_uuid, invalid_at_event: null },
     })
     // 注意：createEdge 也不校验 createdByEvent 存在性，但导入器应保证先 applyEvent 再 createEdge
  3. 调 embedder.embed(fact) → 写入 fact_embedding（见 8.6）
```

### 8.5 事件写入流程（含节点创建事件）

```
// 阶段3 已构建完整 eventChain，包含：
//   - 节点创建事件（每个 globalSetting 一个，插在 first_appearance 之前）
//   - 叙事事件（原 53 条）
// 事件已按 parent 链串联好

For each event in eventChain (按链路顺序):
  调 store.applyEvent({
    uuid, parent: parent || null,
    chapter_id, created_at,
    content: narrative_summary,    // 节点创建事件可为空字符串或"<节点创建: 彩叶>"
    diffusions: diffusions.map(d => ({
      target_uuid: canonicalToStoreUuid(d.target_uuid),  // 替换为 store_uuid
      field: d.field,    // 已带 base_profile. / current_state. / attributes. / summary / name 前缀
      old_value: d.old_value,
      new_value: d.new_value,
    })),
  })
```

**applyEvent 校验约束**（[storage.ts:832-848](file:///d:/claude/pi-ex/narrative-engine/src/storage.ts#L832-848)）：
- 首事件 `parent=null` 仅在分支 HEAD 为空时允许
- 非 null parent 必须在当前分支链路上
- 因此必须**严格按链路顺序** applyEvent，不能并行

### 8.6 章节元数据生成

```
For each chapter_id (1..N):
  // 章节在阶段5 开始时通过 store.createChapter 创建（status="frozen"）
  // applyEvent 会自动更新 start_event / end_event
  // 全部事件 apply 完成后，补充 summary（如 createChapter 时未传）
  // 若需要修改 summary，扩展 store.updateChapterMetadata API
```

**注意**：当前 [storage.ts](file:///d:/claude/pi-ex/narrative-engine/src/storage.ts) 没有暴露 `updateChapterMetadata` API。如果 createChapter 时不传 summary，后续无法补写。两个选择：
- **方案 1（推荐）**：阶段3 构建事件链时，同时计算每章 summary（拼接该章所有叙事事件的 content），阶段5 创建 chapter 时一次性传入
- **方案 2**：扩展 storage.ts 新增 `updateChapterMetadata(chapterId, patch)` API

优先方案 1，避免改 storage.ts。

### 8.7 向量补齐

```
For each node:
  if (!node.summary_embedding || node.embedding_stale):
    node.summary_embedding = await embedder.embed(node.summary)
    node.embedding_stale = false
    flushNode(node)

For each edge:
  if (!edge.fact_embedding):
    edge.fact_embedding = await embedder.embed(edge.fact)
    flushEdge(edge)
```

**注意**：当前 [WorldNode](file:///d:/claude/pi-ex/narrative-engine/src/types.ts#L33-71) 类型没有 `base_profile` / `current_state` / `dynamic_memory` 字段。step 1 扩展 types.ts 时，这些字段应作为**可选字段**（向后兼容旧数据），但 V2 导入器产出的节点必须填写（由 4.2 节表格规定子字段必填性，导入器后处理校验）。

---

## 9. 阶段 6：数据校验（新增）

### 9.1 校验项

| 项 | 检查内容 | 严重度 |
|---|---|---|
| 章节完整性 | 期望 N 章 vs 实际处理的章节数 | P0 |
| 节点 base_profile | 必填字段非空（按类型差异化） | P0 |
| 节点 current_state | 角色和互动物必填，背景可空 | P1 |
| 边 created_by_event | 必填，且 UUID 在事件链中存在 | P0 |
| 边 evidence | 必填非空 | P0 |
| 边 type | 若非基础枚举，需 type_category 明确 | P1 |
| 事件 diffusions.field | 必须以白名单前缀开头 | P0 |
| 事件 parent 链 | 首事件 parent=null，其他必须有 parent | P0 |
| 向量字段 | 节点 summary_embedding / 边 fact_embedding 非空 | P0 |
| 章节元数据 | chapters/chapter-*.json 存在且字段完整 | P1 |

### 9.2 校验失败处理

- P0 失败：报错退出，不产出 viz.html
- P1 失败：警告继续，但在报告里标记

---

## 10. 实施计划（分步迭代）

按"八荣八耻"的分步迭代原则：

| 步骤 | 任务 | 影响范围 | 依赖 |
|---|---|---|---|
| 1 | types.ts: WorldNode 增加 base_profile / current_state / dynamic_memory 可选字段类型（向后兼容） | types.ts | - |
| 2 | storage.ts: 扩展 createChapter 支持 `chapterId?` / `summary?` / `status?` 可选参数；导入器直接传 `status: "frozen"` 避免后续 freezeChapter。createNode 无需改（隐式契约：不校验 createdByEvent 存在性） | storage.ts | - |
| 3 | import-novel-v2.mjs: 改 SummarySchema，new_settings 拆 base_profile + current_state；base_profile 加 minProperties:3；state_changes.field 加 pattern 强校验 | import-novel-v2.mjs | 1 |
| 4 | import-novel-v2.mjs: 改 summaryTool prompt，明确三层结构、字段归类规则、按 type 差异化的必填子字段 | import-novel-v2.mjs | 3 |
| 5 | import-novel-v2.mjs: 新增阶段0 全书实体预扫描（前 1500 字/章，已知限制靠阶段2 兜底） | import-novel-v2.mjs | - |
| 6 | import-novel-v2.mjs: 改阶段2 为 LLM 分批语义归并（保留算法预聚类） | import-novel-v2.mjs | 3 |
| 7 | import-novel-v2.mjs: 改 buildEventChain，按 first_appearance 插入节点创建事件；为每个 globalSetting 生成节点创建事件，parent 链重连（见 8.1 节）；同时计算每章 summary 供 createChapter 使用 | import-novel-v2.mjs | 6 |
| 8 | import-novel-v2.mjs: 改 EdgeSchema，补 evidence 必填 + type 基础枚举优先 + source_event_uuid 必填（引用阶段3 已构建的事件 UUID） | import-novel-v2.mjs | 7 |
| 9 | import-novel-v2.mjs: 改 edgeTool prompt，强化基础枚举和 evidence 要求；输入提供已存在的事件 UUID 清单供 LLM 选择 | import-novel-v2.mjs | 8 |
| 10 | import-novel-v2.mjs: 改 writeToWorldGraph，按链路顺序 applyEvent（含节点创建事件）；建立 canonical_uuid → store_uuid 映射；createNode 前向引用节点创建事件 UUID | import-novel-v2.mjs | 7, 9 |
| 11 | import-novel-v2.mjs: writeToWorldGraph 末尾补 dynamic_memory.recent（每角色最多 20 条，按章节倒序取；entry 结构 `{event_uuid, chapter_id, summary}`；超出留给引擎运行时按 29 号压缩策略沉淀） | import-novel-v2.mjs | 10 |
| 12 | import-novel-v2.mjs: writeToWorldGraph 末尾补向量（summary_embedding / fact_embedding） | import-novel-v2.mjs | 10 |
| 13 | import-novel-v2.mjs: writeToWorldGraph 开头按 EPUB 章节顺序 createChapter（传 chapterId + title + summary + status:"frozen"），applyEvent 自动更新 start_event/end_event | import-novel-v2.mjs | 2, 10 |
| 14 | import-novel-v2.mjs: 修 readChaptersFromEpub，改用 toc.ncx 解析章节结构（不依赖 flow），排查 ch3/ch8 缺失 | import-novel-v2.mjs | - |
| 15 | import-novel-v2.mjs: 新增阶段6 数据校验（P0/P1 分级，P0 失败退出，P1 警告） | import-novel-v2.mjs | 10, 11, 12, 13 |
| 16 | import-novel-v2.mjs: 导入器后处理校验 base_profile 必填子字段（按 4.2 节表格），缺失则 LLM 重试 1 次，仍失败则 P1 警告 | import-novel-v2.mjs | 3 |
| 17 | generate-viz.mjs: 增加事件图视图 | generate-viz.mjs | 15 |
| 18 | 全书重跑 + 生成新 viz.html | 验证 | 17 |

---

## 11. 成本预算

| 阶段 | 调用次数 | 输入 token | 输出 token | 成本 |
|---|---|---|---|---|
| 阶段0 实体预扫描 | 1 | ~15000 | ~2000 | $0.001 |
| 阶段1 每章摘要 | 11 | 11 × 8000 | 11 × 4000 | $0.006 |
| 阶段2 LLM 分批归并 | 3 | 3 × 3000 | 3 × 1000 | $0.001 |
| 阶段3 边生成（按章分批） | 11 | 11 × 4000 | 11 × 2000 | $0.004 |
| 向量生成（本地） | 53 + 60 | 0 | 0 | $0 |
| **总计** | ~26 | ~150K | ~80K | **~$0.012** |

---

## 12. 风险与降级方案

| 风险 | 降级方案 |
|---|---|
| 阶段0 LLM 输出截断 | 改为按章节分批预扫描，每批 3 章 |
| 阶段1 LLM 仍输出 base_profile 字段不全 | prompt 强化 + 重试 1 次 + 仍失败则用 LLM 后处理补字段 |
| 阶段2 LLM 归并决策漏判 | 保留算法预聚类结果作为基线，LLM 只增不减 |
| 阶段3 边 type 仍滥用自定义 | prompt 给出反例，要求基础枚举优先 |
| 向量生成失败（模型加载） | 跳过向量，标记 embedding_stale=true，不影响其他流程 |
| 章节缺失仍存在 | EPUB 分章改为按 toc.ncx 解析，不依赖 flow |

---

## 13. 验收标准

V2 导入器重跑后必须满足：

1. ✅ 11 章全部处理（无缺失）
2. ✅ 每个节点有 base_profile 字段，角色节点必填 personality + background + speaking_style
3. ✅ 每个节点有 current_state 字段（背景节点除外）
4. ✅ 每条边有 created_by_event（非 "user"）+ evidence 非空
5. ✅ 事件 diffusions.field 全部以白名单前缀开头（pattern 校验）
6. ✅ 节点 summary_embedding / 边 fact_embedding 非空
7. ✅ chapters/chapter-{1..11}.json 全部生成
8. ✅ 事件图可视化可用（含节点创建事件 + 叙事事件，约 100-125 条，parent 链完整 + diffusions 高亮）
9. ✅ 总成本 ≤ $0.02
10. ✅ 数据校验 P0 项全部通过
11. ✅ 节点创建事件按 first_appearance 插入，回退到任意节点创建事件 = 回退到该角色/物品登场前

---

## 14. 设计存疑点（待确认）

以下点本设计按当前理解决策，若有偏差请指正：

1. ~~**节点初始状态写入方式**~~ **[已裁决]** 方案 A（applyEvent 写扩散）。事件链从 53 → ~106 是可接受代价，换取回退时能精准撤销到节点创建那一刻。详见 8.1 节和 8.2 节。
2. ~~**dynamic_memory 完全不写入**~~ **[已裁决]** 动态记忆由世界图节点统一维护（覆盖 v2-design-notes 4.5 节）。V2 导入器只填 recent（每角色最多 20 条），compressed/skeleton 留空给运行时。子代理只保留角色扮演的临时上下文。详见 2.1 节和 4.1 节。
3. ~~**边的基础枚举 vs 自定义**~~ **[已裁决]** 基础枚举为主体，自定义作为补充关系。详见 4.3 节。
4. ~~**阶段0 全书实体预扫描**~~ **[已裁决]** 值得做。~$0.001 成本换取消除跨章重复创建。已知限制：前 1500 字采样可能漏配角，靠阶段2 归并兜底。
5. ~~**章节元数据 status 字段**~~ **[已裁决]** frozen。V2 导入器产出的是已完结章节，status="frozen"（对齐 types.ts 现有枚举 `active | frozen`，不引入 writing/pending）。引擎运行时新增章节时才用 "active"。
6. ~~**节点创建事件插入位置**~~ **[已裁决 v1.1]** 按 first_appearance 插入。节点创建事件插在该节点首次出现的叙事事件之前，回退语义 = 回退到角色/物品登场前。详见 8.1 节。
7. ~~**base_profile 字段约束**~~ **[已裁决 v1.1]** schema 加 minProperties:3 + 导入器后处理校验子字段必填性（按 4.2 节表格），缺失则 LLM 重试 1 次。详见 5.1 节。
8. ~~**dynamic_memory.recent 上限**~~ **[已裁决 v1.1]** 每角色最多 20 条，按章节倒序取。entry 结构 `{event_uuid, chapter_id, summary}`。超出交给引擎运行时按 29 号压缩策略沉淀。

---

## 15. 修订记录

### v1.1（2026-07-21）：P0/P1 问题修正

基于代码核对（types.ts / storage.ts / import-novel-v2.mjs）修正以下问题：

**P0 修正**：
- **事件链顺序断裂**：8.1/8.4 节未交代节点创建事件插入位置。裁决为"按 first_appearance 插入"，新增 8.1 节详述策略
- **流程图与代码顺序矛盾**：3 节流程图阶段3（边生成）和阶段4（事件链构建）互换，对齐代码实际顺序（先 buildEventChain 再 generateEdges）
- **章节状态枚举不一致**：4.5 节注释 `frozen / writing / pending` 改为 `active | frozen`，对齐 types.ts
- **章节元数据落盘路径**：8.6 节注明需扩展 storage.ts createChapter 支持 chapterId/summary/status 可选参数

**P1 修正**：
- **base_profile 字段约束**：5.1 schema 加 minProperties:3 + 后处理校验子字段必填性
- **evidence maxLength 统一**：state_changes.evidence 和 edges.evidence 都改为 maxLength:200，描述统一
- **dynamic_memory.recent 上限**：每角色最多 20 条，entry 结构明确
- **阶段0 采样限制**：6.2 节注明"前 1500 字采样可能漏配角，靠阶段2 归并兜底"作为已知限制
- **step 13 具体化**：readChaptersFromEpub 改用 toc.ncx 解析（从风险表提升为实施步骤）

**P2 修正**：
- **createNode 隐式契约**：8.3.1 节注明 createNode 不校验 createdByEvent 存在性，调用方需保证
- **uuid 映射**：8.2 节注明建立 canonical_uuid → store_uuid 映射，后续 diffusion/edge 都用 store_uuid
- **类型扩展 BREAKING 性质**：8.7 节注明 base_profile/current_state/dynamic_memory 作为可选字段（向后兼容），但 V2 导入器产出节点必须填写

**实施计划调整**：step 数从 16 → 18，新增 step 7（buildEventChain 改造）、step 16（后处理校验），原 step 13（章节缺失修复）具体化为 toc.ncx 解析。

---

**设计完成日期**: 2026-07-21（v1.1）
**下一步**: 等用户确认设计，然后按第 10 节实施计划分步动手。