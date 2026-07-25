> ✅ **状态：已实施**（`packages/scheduler/`，本文保留作设计依据；头部"待审阅"为历史状态）。

# 调度器（@pi/scheduler）设计文档

> **状态**: 设计 spec，待用户审阅后进入实施计划
> **日期**: 2026-07-25
> **前置**: 渲染器（@pi/renderer）已完成；角色池（@pi/role-pool）已完成；世界图（@pi/world-graph）已实现
> **范围**: 仅调度器子包 + 扩展层 2-3 个 pi 工具。主会话 prompt、伏笔存储、回退机制不在本次范围

---

## 1. 定位与架构

### 1.1 调度器在引擎中的位置

调度器是引擎的"导演"——不演戏（角色池）、不写剧本（渲染器）、不讲故事（主会话），只负责把各模块串起来。

```
主会话（解析五要素）→ StructuredEvent
  ↓
@pi/scheduler（本次设计，纯编排无 LLM 直接调用）
  ├─ scheduler_plan
  │   ├─ 解析事件 → characterIds + storyTime + chapterPath
  │   ├─ 检索世界图 → 角色实体 + 关系
  │   ├─ 预取角色视角 → wg.getCharacterView(characterId, storyTime)
  │   ├─ 加载静态层 → staticCard（默认从 Entity+Facts 重组，见 3.5）
  │   ├─ 构建 CastMember[] + InteractCommand
  │   ├─ 调用 @pi/role-pool.interact → RoleAgentOutput[]
  │   └─ 缓存 plan 结果（planId → PlanResult）
  ↓
（主会话可检查 RoleAgentOutput[]，决定是否 commit 或 discard）
  ↓
  ├─ scheduler_commit
  │   ├─ 取出 plan 结果（按 planId）
  │   ├─ 提取 state_changes（@pi/role-pool.transforms.extractStateChanges）
  │   ├─ 查询 invalidated（按 entityId+property 找未闭合 Fact 的 declarationId）
  │   ├─ 调用 wg.processEvent 写扩散到世界图（按 entityId 分组，每组一个 change 事件）
  │   ├─ 投影为 RoleOutput[]（@pi/role-pool.transforms.toRoleOutputs）
  │   └─ 调用 @pi/renderer.renderToFile 写章节文件
  └─ scheduler_discard（丢弃 plan，不写世界图、不渲染）
```

### 1.2 设计决策汇总

| # | 决策点 | 定案 | 理由 |
|---|--------|------|------|
| 1 | 形态 | 子包 @pi/scheduler + 扩展层 pi 工具（scheduler_dispatch / scheduler_commit / scheduler_discard） | 与 renderer/role-pool 一致；便于单测 |
| 2 | 五要素解析 | 调度器接收主会话已结构化的 StructuredEvent（含 characterIds + instruction + executionHints） | 遵循 V2 设计笔记 9.2 节；主会话 prompt 待补；主会话作为"任务外包方"已完成意图理解和角色识别 |
| 3 | 编排粒度 | 双模式：plan 模式（跑到角色输出中断，等主会话确认后 commit）/ yolo 模式（一气呵成跑完整条链） | 默认 plan 模式符合人在回路；yolo 模式应对无人值守批量化叙事 |
| 4 | LLM 调用 | 调度器内嵌 planner LLM 做检索计划推导；角色 LLM 通过 role_interact 间接调；渲染 LLM 通过 renderToFile 间接调 | 调度器不再"纯编排"，需 LLM 做检索推导；但角色扮演/文本渲染仍由专门子代理负责 |
| 5 | 章节路径 | 主会话显式传入 chapterPath，缺省从 storyTime 推断 | 与 renderer 章节命名约定一致 |
| 6 | eventId 生成 | 调度器在 plan 阶段自动生成 `evt_<timestamp>_<random>` | 单一来源，避免主会话/调度器分别生成冲突 |
| 7 | state_changes→EventRecord | 按 entityId 分组，每组生成一个 change 事件 | 复用 world_event_apply 现有接口 |
| 8 | invalidated 处理 | 调度器查询当前未闭合 Fact 按 property 匹配 | 无需 LLM 二次提取，纯图查询 |
| 9 | plan 缓存 | session 级内存 Map<planId, PlanResult> | 简单，无需持久化（plan 是临时态） |
| 10 | staticCard 来源 | 默认从 Entity+Facts 重组 minimal SillyTavernCard | role-pool 待定事项 #1，本设计不阻塞 |
| 11 | 角色识别 | 主会话已识别，characterIds[] 在 StructuredEvent 中传入 | 主会话是任务外包方，调度器接收结构化输入；不脑补业务规则 |
| 12 | relation_update | 暂不写入世界图（Pending Gap） | target 是名字而非 entityId，需实体消解，留待后续 |
| 13 | **检索策略** | **planner LLM 推导检索计划**（输出一组 RetrievalItem，调度器按计划执行检索） | 固定检索模板无法应对多样事件；LLM 推导灵活，能根据事件指令+角色弧动态决定检索什么 |
| 14 | **调用方式** | **pi 工具机制**（调度器作为扩展层 pi 工具，被主会话调用；内部通过 import 子包函数实现"调用工具"语义） | 与现有 render_append / role_interact 等工具一致；不绕道 pi.tools.execute 是为了性能和类型安全 |
| 15 | **plan / yolo 切换** | StructuredEvent.mode 字段控制：`plan` 跑到角色输出即返回（等主会话 commit）/ `yolo` 自动调 commit | 主会话按场景选择；plan 用于关键剧情审阅，yolo 用于连续推进 |

---

## 2. 数据契约

### 2.1 输入类型

```typescript
/**
 * 主会话解析后的结构化事件
 * 调度器接收的唯一输入形式
 *
 * 五要素映射（V2 设计笔记 9.1 节）：
 * - 时间 → storyTime
 * - 地点 → locationId（可选）
 * - 发生了什么 → instruction
 * - 事件意图 → intent
 * - 角色弧状态 → characterIds（角色由主会话识别）
 *
 * 主会话作为"任务外包方"，已做意图理解和角色识别，把结构化参数
 * 传入调度器 pi 工具。executionHints 承载用户的特殊要求（如"林冲
 * 在这场戏里要显得特别绝望"、"避免出现打斗描写"），调度器在组装
 * 角色提示词时透传给 role-pool。
 */
interface StructuredEvent {
  /** 故事时间（如 ch-2） */
  storyTime: string;
  /** 事件指令（自然语言，主会话已加工） */
  instruction: string;
  /** 参与角色 ID 列表（主会话已识别） */
  characterIds: string[];
  /**
   * 执行建议（用户特殊要求）
   * 由主会话从用户对话中抽取，调度器透传到角色池 prompt 和渲染器 prompt
   * 例如："林冲要显得绝望"、"避免直接描写暴力"、"这场戏节奏要快"
   */
  executionHints?: string;
  /**
   * 调度模式：plan / yolo
   * - plan：跑到角色池输出即返回（等主会话调 scheduler_commit 提交扩散和渲染）
   * - yolo：自动跑完整条链（检索→角色→扩散→渲染）
   * 缺省 plan（符合人在回路）
   */
  mode?: "plan" | "yolo";
  /** 章节文件路径（缺省时调度器从 storyTime 推断） */
  chapterPath?: string;
  /** 地点 ID（可选，用于可见性推断；缺省时不触发额外推断） */
  locationId?: string;
  /** 事件意图（缺省 add；modify/insert 留作 Pending Gap） */
  intent?: "add" | "modify" | "insert";
  /** modify/insert 模式下的目标事件 ID */
  targetEventId?: string;
}
```

### 2.2 中间状态类型

```typescript
/**
 * scheduler_plan 产出的中间状态
 * 缓存在 session 级 Map 中，等 scheduler_commit 或 scheduler_discard 取用
 */
interface PlanResult {
  /** plan 唯一 ID（自动生成） */
  planId: string;
  /** 调度器自动生成的事件 ID（用于渲染锚点和事件链） */
  eventId: string;
  /** 原始输入事件 */
  event: StructuredEvent;
  /** 章节路径（解析后的最终值） */
  chapterPath: string;
  /** planner LLM 推导出的检索计划（缓存便于 commit 时无需重新推导，也便于调试） */
  retrievalPlan: RetrievalPlan;
  /** 角色池调用结果（含 outputs 和 errors） */
  roleResult: InteractResult;
  /** 调度器预取的演员表快照（便于 commit 时无需重新检索） */
  cast: CastMember[];
  /** 创建时间戳（用于过期清理） */
  createdAt: number;
}
```

### 2.3 输出类型

```typescript
/**
 * scheduler_plan 返回
 */
interface PlanOutput {
  planId: string;
  eventId: string;
  chapterPath: string;
  /** 角色池输出（主会话可检查后再决定 commit/discard） */
  outputs: RoleAgentOutput[];
  /** 失败记录（来自 role_interact） */
  errors: { characterId: string; error: string }[];
  /** 预取的演员表摘要（便于主会话参考） */
  cast: { characterId: string; name: string; summary: string }[];
}

/**
 * scheduler_commit 返回
 */
interface CommitResult {
  ok: boolean;
  planId: string;
  /** 渲染锚点 eventId（plan 阶段生成） */
  eventId: string;
  /** 已应用的世界图事件 ID 列表（每个 entityId 一个 change 事件） */
  appliedEventIds: string[];
  /** 已渲染的章节路径 */
  chapterPath: string;
  /** 已写入的渲染文本 */
  writtenText: string;
  /** 渲染错误（ok=false 时） */
  error?: string;
}
```

### 2.4 调度器调用上下文

```typescript
/**
 * 调度器调用上下文
 *
 * 调度器持有三种 LLM 调用器：
 * - plannerLlm：用于推导检索计划（调度器内嵌）
 * - roleLlm：透传给 role_interact（角色扮演）
 * - renderLlm：透传给 renderToFile（文本渲染）
 *
 * 三种 LLM 调用器互不干扰，便于单测 mock 和生产环境分别配置
 * （如 plannerLlm 可用更快的小模型，roleLlm/renderLlm 用更大模型）
 */
interface SchedulerCtx {
  /** 世界图实例 */
  wg: WorldGraph;
  /** planner LLM 调用器（推导检索计划） */
  plannerLlm: PlannerLlmCaller;
  /** 角色池 LLM 调用器（注入 role_interact） */
  roleLlm: RoleLlmCaller;
  /** 渲染器 LLM 调用器（注入 renderToFile） */
  renderLlm: RenderLlmCaller;
  /**
   * 向量化器（用于 search_vector / search_hybrid）
   * 调度器把 planner LLM 输出的自然语言 query 通过 embedder 转 512 维 queryEmbedding，
   * 再调 wg.search.vector(nodeKind, { fieldPath, queryEmbedding, limit })
   *
   * 默认实现：Embedder（@xenova/transformers + Xenova/bge-small-zh-v1.5）
   * 单测可注入 mock embedder 返回预设向量
   */
  embedder: { embed(text: string): Promise<number[]> };
  /** 角色规则集.md 全文（注入 role_interact） */
  roleRuleSet: string;
  /** 渲染规则集.md 全文（注入 renderToFile） */
  renderRuleSet: string;
  /** planner 规则集.md 全文（约束 planner LLM 的检索行为） */
  plannerRuleSet: string;
  /** 工作目录（用于章节路径推断和规则集加载） */
  cwd: string;
  /** staticCard 加载器（可注入，便于测试和后续替换存储策略） */
  staticCardLoader: (characterId: string, storyTime: string) => Promise<SillyTavernCard>;
}
```

**LLM 配置优先级**（参考现有 role-pool-llm.ts / renderer-llm.ts 实现）：

| LLM | 环境变量优先级（从高到低） |
|---|---|
| plannerLlm | `PI_PLANNER_MODEL` → `PI_MODEL` → `deepseek-chat` / `PI_PLANNER_API_KEY` → `PI_API_KEY` → `DEEPSEEK_API_KEY` |
| roleLlm | `PI_ROLE_MODEL` → `PI_MODEL` → `deepseek-chat` / `PI_ROLE_API_KEY` → `PI_API_KEY` → `DEEPSEEK_API_KEY` |
| renderLlm | `PI_RENDERER_MODEL` → `PI_MODEL` → `deepseek-chat` / `PI_RENDERER_API_KEY` → `PI_API_KEY` → `DEEPSEEK_API_KEY` |

### 2.5 检索计划类型（planner LLM 输出）

```typescript
/**
 * planner LLM 的输出：检索计划
 *
 * 由调度器在 plan 阶段调用 plannerLlm 推导得出
 * 调度器按 plan.items 逐项执行检索，结果按 item.assignTo 注入对应角色
 *
 * 信息差由 planner LLM 决定（Genette 内聚焦的工程化）：
 * - planner LLM 既决定"检索什么"，也决定"哪个角色应该看到这条检索结果"
 * - 调度器不主动做信息差推断（不再调用 characterView 的固定 5 步过滤）
 * - 兜底逻辑：每个 characterId 至少有 1 条 type="character_view" 的 item（调度器自动补全，见 3.1 节）
 */
interface RetrievalPlan {
  /** 一组检索项 */
  items: RetrievalItem[];
}

/**
 * 单条检索项
 * 调度器按 type 执行对应的世界图 API，把结果按 assignTo 分配给角色
 */
interface RetrievalItem {
  /**
   * 检索类型（对应 world-graph 已实现的 API）：
   * - character_view：某角色可见的所有状态声明（独立函数 characterView）
   * - entity_snapshot：某实体的完整快照（wg.getEntityAt）
   * - relations：某实体的关系列表（wg.getRelations）
   * - search_text：全文检索（wg.search.fulltext）
   * - search_vector：向量检索（wg.search.vector）
   * - search_hybrid：混合检索（wg.search.hybrid）
   */
  type:
    | "character_view"
    | "entity_snapshot"
    | "relations"
    | "search_text"
    | "search_vector"
    | "search_hybrid";

  /** 检索参数（按 type 不同填不同字段） */
  params: {
    /** character_view / entity_snapshot / relations 用 */
    entityId?: string;
    /** search_text / search_vector / search_hybrid 用（自然语言查询） */
    query?: string;
    /**
     * 检索节点类型（search_text / search_vector / search_hybrid 必填）
     * 对应 wg.search.fulltext(nodeKind, ...) 第一个参数
     * 取值："Entity" / "Fact" / "Relation" / "Visibility"
     * - Entity：检索实体（角色/地点/物品/概念）的 summary + properties
     * - Fact：检索状态声明（property / valueText 字段已声明 searchable）
     * - Relation：检索关系（label 字段）
     */
    nodeType?: "Entity" | "Fact" | "Relation" | "Visibility";
    /** 检索上限（search_* 用） */
    limit?: number;
    /**
     * 向量字段路径（search_vector / search_hybrid 用）
     * 缺省 "embedding"（world-graph 的 Entity/Fact 节点默认嵌入字段）
     */
    fieldPath?: string;
    /** 模态过滤（character_view 用，如只看 fact） */
    modalityFilter?: ("fact" | "belief" | "hypothesis")[];
  };

  /**
   * 这条检索结果分配给哪些角色
   * 调度器按此把检索结果拼装到对应角色的 dynamicFacts / 上下文
   * 信息差的核心：planner LLM 决定谁看到什么
   */
  assignTo: string[];

  /**
   * 检索项的语义标签（注入角色提示词时用作小标题）
   * 例如："林冲的当前状态"、"林冲与陆谦的关系"、"酒馆里发生了什么"
   */
  label: string;
}

/**
 * planner LLM 调用器签名
 * 输入：planner 系统提示词 + 用户消息（事件指令 + 角色清单）
 * 输出：已解析的 RetrievalPlan（tool call 模式）
 *
 * 与 RoleLlmCaller / RenderLlmCaller 一致，便于注入 mock 单测
 */
type PlannerLlmCaller = (
  systemPrompt: string,
  userMessage: string,
) => Promise<RetrievalPlan>;
```

**planner LLM 的 tool call 模式**：

调度器调用 plannerLlm 时，会通过 pi-ai 的 tool call schema 约束 LLM 必须输出 `RetrievalPlan` 结构。具体实现细节见 [第 3.6 节](#36-planner-llm-调用细节)。

---

## 3. 核心编排

### 3.1 plan 函数

```typescript
async function plan(
  event: StructuredEvent,
  ctx: SchedulerCtx,
): Promise<PlanOutput> {
  // 1. 生成 eventId 和 planId
  const eventId = `evt_${Date.now()}_${randomId(6)}`;
  const planId = `plan_${Date.now()}_${randomId(6)}`;

  // 2. 解析章节路径
  const chapterPath = event.chapterPath ?? resolveChapterPath(ctx.cwd, event.storyTime);

  // 3. 调用 planner LLM 推导检索计划
  //    输入：事件指令 + 参与角色 + 执行建议
  //    输出：RetrievalPlan（一组 RetrievalItem，含 type/params/assignTo/label）
  //    见 3.6 节 planner LLM 的 tool call 模式细节
  const retrievalPlan = await ctx.plannerLlm(
    buildPlannerSystemPrompt(ctx.plannerRuleSet, event),
    buildPlannerUserMessage(event),
  );

  // 4. 兜底：确保每个参与角色至少有 1 条 character_view 检索项
  //    避免 planner LLM 漏掉某角色导致该角色完全没有动态状态注入
  for (const characterId of event.characterIds) {
    const hasOwnView = retrievalPlan.items.some(
      it => it.type === "character_view"
        && it.params.entityId === characterId
        && it.assignTo.includes(characterId),
    );
    if (!hasOwnView) {
      retrievalPlan.items.push({
        type: "character_view",
        params: { entityId: characterId },
        assignTo: [characterId],
        label: `${characterId} 的可见状态`,
      });
    }
  }

  // 5. 按 retrievalPlan.items 逐项执行检索
  //    检索结果按 item.assignTo 分配到对应角色的 dynamicFacts 池
  //    检索通过 import 子包函数实现（pi 工具机制，见决策 #14）
  const dynamicFactsByCharacter = new Map<string, FactSnapshot[]>();
  for (const characterId of event.characterIds) {
    dynamicFactsByCharacter.set(characterId, []);
  }

  for (const item of retrievalPlan.items) {
    const result = await executeRetrievalItem(ctx, item, event.storyTime);
    if (!result) continue;
    for (const characterId of item.assignTo) {
      const facts = dynamicFactsByCharacter.get(characterId);
      if (facts) {
        // 检索结果按 label 分组追加到该角色的 dynamicFacts
        // FactSnapshot 是 world-graph 的 StateDeclaration 子集
        facts.push(...result);
      }
    }
  }

  // 6. 为每个角色构建 CastMember
  const cast: CastMember[] = [];
  for (const characterId of event.characterIds) {
    const staticCard = await ctx.staticCardLoader(characterId, event.storyTime);
    const dynamicFacts = dynamicFactsByCharacter.get(characterId) ?? [];
    cast.push({ characterId, staticCard, dynamicFacts });
  }

  // 7. 调用 @pi/role-pool.interact（透传 executionHints 给 role-pool）
  const roleResult = await interact(
    {
      eventInstruction: event.instruction,
      storyTime: event.storyTime,
      cast,
      // executionHints 透传到 role-pool 的 system prompt（让角色也遵守用户特殊要求）
      executionHints: event.executionHints,
    } as InteractCommand,
    { llm: ctx.roleLlm, ruleSet: ctx.roleRuleSet },
  );

  // 8. 缓存 plan 结果（session 级 Map）
  const planResult: PlanResult = {
    planId, eventId, event, chapterPath,
    retrievalPlan,   // 缓存检索计划，便于 commit 时不需要重新推导
    roleResult, cast, createdAt: Date.now(),
  };
  planCache.set(planId, planResult);

  // 9. yolo 模式：自动 commit（一气呵成）
  if (event.mode === "yolo") {
    const commitResult = await commit(planId, ctx);
    return {
      planId, eventId, chapterPath,
      outputs: roleResult.outputs,
      errors: roleResult.errors,
      cast: cast.map(c => ({
        characterId: c.characterId,
        name: String(c.staticCard.name ?? c.characterId),
        summary: String(c.staticCard.description ?? ""),
      })),
      // yolo 模式直接返回 commit 结果
      commitResult,
    };
  }

  // 10. plan 模式：返回 PlanOutput（精简版，不暴露完整 cast）
  //     等主会话审阅后调 scheduler_commit 提交
  return {
    planId, eventId, chapterPath,
    outputs: roleResult.outputs,
    errors: roleResult.errors,
    cast: cast.map(c => ({
      characterId: c.characterId,
      name: String(c.staticCard.name ?? c.characterId),
      summary: String(c.staticCard.description ?? ""),
    })),
  };
}

/**
 * 按 RetrievalItem 执行单条检索（pi 工具机制的实现层）
 *
 * 调度器 import 各子包函数实现"调用工具"语义：
 * - character_view  → wg.getCharacterView(characterId, storyTime)（WorldGraph 实例方法，内部委托给独立函数 characterView）
 * - entity_snapshot → wg.getEntityAt(entityId, storyTime)
 * - relations       → wg.getRelations(entityId, storyTime)
 * - search_*        → wg.search.fulltext / vector / hybrid
 *
 * [2026-07-25 修正] 原设计文档误以为 characterView 独立函数未导出，需要修改
 * world-graph 的 index.ts。实际查档：[world-graph.ts#L529-L536](file:///d:/claude/pi-ex/narrative-engine/packages/world-graph/src/world-graph.ts#L529-L536)
 * 已通过 `wg.getCharacterView(...)` 方法暴露（内部 `import("./character-view.ts")`）。
 * 调度器直接调实例方法即可，Pending Gap #10 因此移除。
 */
async function executeRetrievalItem(
  ctx: SchedulerCtx,
  item: RetrievalItem,
  storyTime: string,
): Promise<FactSnapshot[] | null> {
  switch (item.type) {
    case "character_view": {
      if (!item.params.entityId) return null;
      const decls = await ctx.wg.getCharacterView(
        item.params.entityId,
        storyTime,
        item.params.modalityFilter
          ? { modalityFilter: item.params.modalityFilter }
          : {},
      );
      return decls.map(d => ({
        declarationId: d.declarationId,
        entityId: d.entityId,
        property: d.property,
        value: d.value,
        valueText: d.valueText,
        modality: d.modality,
        validFrom: d.validFrom,
      }));
    }
    case "entity_snapshot": {
      if (!item.params.entityId) return null;
      const snap = await ctx.wg.getEntityAt(item.params.entityId, storyTime);
      if (!snap) return null;
      return snap.properties.map(p => ({
        declarationId: p.declarationId,
        entityId: p.entityId,
        property: p.property,
        value: p.value,
        valueText: p.valueText,
        modality: p.modality,
        validFrom: p.validFrom,
      }));
    }
    case "relations": {
      if (!item.params.entityId) return null;
      const rels = await ctx.wg.getRelations(item.params.entityId, storyTime);
      // 关系列表转 FactSnapshot（property 用 label，value 用 targetId）
      return rels.map(r => ({
        declarationId: r.relationId,
        entityId: r.sourceId,
        property: `relation.${r.label}`,
        value: r.targetId,
        valueText: r.label,
        modality: "fact" as const,
        validFrom: r.validFrom,
      }));
    }
    case "search_text":
    case "search_vector":
    case "search_hybrid": {
      if (!item.params.query) return null;
      // wg.search 是 world-graph 暴露的检索接口
      // 见 packages/world-graph/src/world-graph.ts 的 get search()
      const search = ctx.wg.search;
      const results = item.type === "search_text"
        ? await search.fulltext(item.params.query, item.params.limit ?? 10)
        : item.type === "search_vector"
        ? await search.vector(item.params.query, item.params.limit ?? 10)
        : await search.hybrid(item.params.query, item.params.limit ?? 10);
      // 检索结果转 FactSnapshot（统一格式注入角色提示词）
      return results.map(r => ({
        declarationId: r.id ?? `search-${randomId(6)}`,
        entityId: r.entityId ?? "search-result",
        property: "search_result",
        value: r.text ?? r.content ?? "",
        valueText: r.text ?? r.content ?? "",
        modality: "fact" as const,
        validFrom: storyTime,
      }));
    }
  }
  return null;
}
```

**plan 函数的 10 步流程概览**：

```
1. 生成 eventId + planId
2. 解析章节路径
3. 调用 planner LLM 推导 RetrievalPlan（tool call 模式）
4. 兜底：每个 characterId 至少 1 条 character_view
5. 按 RetrievalPlan.items 逐项执行检索（pi 工具机制：import 子包函数）
6. 按检索结果 + assignTo 构建每个角色的 dynamicFacts
7. 加载每个角色的 staticCard，组装 CastMember[]
8. 调用 @pi/role-pool.interact（透传 executionHints）
9. 缓存 plan 结果（planId → PlanResult）
10. yolo 模式自动 commit；plan 模式等主会话确认
```

### 3.2 commit 函数

```typescript
async function commit(
  planId: string,
  ctx: SchedulerCtx,
): Promise<CommitResult> {
  // 1. 取出 plan 结果
  const planResult = planCache.get(planId);
  if (!planResult) {
    return {
      ok: false, planId, eventId: "", chapterPath: "",
      appliedEventIds: [], writtenText: "",
      error: `plan ${planId} not found (expired or never created)`,
    };
  }

  const { event, eventId, chapterPath, roleResult } = planResult;

  // 2. 提取 state_changes（扁平化为 StateChange[]）
  const stateChanges = extractStateChanges(roleResult.outputs);

  // 3. 按 entityId 分组（每个 entityId 生成一个 change 事件）
  const changesByEntity = groupBy(stateChanges, c => c.entityId);

  // 4. 为每个 entityId 写扩散
  const appliedEventIds: string[] = [];
  for (const [entityId, changes] of changesByEntity) {
    // 4.1 查询 invalidated：该 entityId 当前未闭合的 Fact，按 property 匹配
    const snapshot = await ctx.wg.getEntityAt(entityId, event.storyTime);
    const invalidated = [];
    for (const change of changes) {
      const existingFact = snapshot?.properties.find(p => p.property === change.property);
      if (existingFact) {
        invalidated.push({
          declarationId: existingFact.declarationId,
          property: change.property,
        });
      }
    }

    // 4.2 调用 wg.processEvent 写 change 事件
    const subEventId = `evt_${Date.now()}_${randomId(6)}`;
    await ctx.wg.processEvent({
      eventId: subEventId,
      type: "change",
      storyTime: event.storyTime,
      entityId,
      source: "engine",
      invalidated: invalidated.length > 0 ? invalidated : undefined,
      newFacts: changes.map(c => ({
        entityId: c.entityId,
        property: c.property,
        value: c.value,
        modality: c.modality,
      })),
    });
    appliedEventIds.push(subEventId);
  }

  // 5. relation_update 写入世界图（Pending Gap #2 已解决，2026-07-25）
  //    role-pool prompt 让 LLM 直接输出 characterId 作为 relation_update.target
  //    调度器直接调 wg.addRelation(sourceId=characterId, targetId=characterId, label, storyTime)
  //    无需"实体消解"
  const relationUpdates = extractRelations(roleResult.outputs);
  for (const rel of relationUpdates) {
    await ctx.wg.addRelation(rel.source, rel.target, rel.label, event.storyTime);
  }

  // 6. 投影为 RoleOutput[]（去掉 state_changes，保留 7 字段）
  const roleOutputs = toRoleOutputs(roleResult.outputs);

  // 7. 调用 @pi/renderer.renderToFile 写章节文件（append 模式）
  const renderResult = await renderToFile(
    {
      mode: "append",
      chapterPath,
      eventId,            // 用 plan 阶段生成的 eventId 作为渲染锚点
      storyTime: event.storyTime,
      instruction: event.instruction,
      payload: roleOutputs as RoleOutput[],
    },
    { llm: ctx.renderLlm, ruleSet: ctx.renderRuleSet },
  );

  // 8. 清理 plan 缓存（commit 后不可再次提交）
  planCache.delete(planId);

  return {
    ok: renderResult.ok,
    planId, eventId, appliedEventIds,
    chapterPath,
    writtenText: renderResult.writtenText,
    error: renderResult.error,
  };
}
```

### 3.3 discard 函数

```typescript
/**
 * 丢弃 plan：不写世界图、不渲染
 * 主会话检查 RoleAgentOutput[] 后觉得不对劲时调用
 */
function discard(planId: string): boolean {
  return planCache.delete(planId);
}
```

### 3.4 章节路径推断

```typescript
/**
 * 从 storyTime 推断章节路径
 *
 * storyTime 格式约定：ch-<N>（如 ch-2）
 * 章节文件命名（与 renderer 设计一致）：
 *   正文/第<N>章-<title>.md
 *
 * 缺省 title 为"未命名"，主会话可后续重命名
 * 文件不存在时由 renderer.ensureChapterFile 自动创建（已实现）
 */
function resolveChapterPath(cwd: string, storyTime: string): string {
  const match = storyTime.match(/^ch-(\d+)$/);
  const chapterNum = match ? parseInt(match[1], 10) : 1;
  const 正文Dir = path.join(cwd, "正文");
  return path.join(正文Dir, `第${chapterNum}章-未命名.md`);
}
```

### 3.5 默认 staticCard 加载器

```typescript
/**
 * 默认 staticCard 加载器
 * 从 WorldGraph 的 Entity + Facts 重组一个 minimal SillyTavernCard
 *
 * 映射规则（基于 novel-importer 写入世界的字段约定）：
 * - name:        Fact property="name" 的 value，缺省用 entityId
 * - description: Entity.summary（实体无状态客观事实描述，独立字段）
 * - personality: Fact property="personality" 的 value
 * - scenario:    Fact property="scenario" 的 value
 * - first_mes:   Fact property="first_mes" 的 value
 * - mes_example: Fact property="mes_example" 的 value
 * - 其他字段：按 property 名透传到 card
 *
 * 设计依据：
 * - novel-importer 的 birth 事件把 character 的 name/personality 等作为 newFacts 写入 Fact 表
 * - Entity.summary 是独立字段（不进 Fact），存客观事实描述
 * - role-pool 的 SillyTavernCard 是接口参数，对来源无约束
 *
 * 若需导入真实酒馆 V2 卡，可注入自定义 staticCardLoader（Pending Gap #1）
 */
async function defaultStaticCardLoader(
  wg: WorldGraph,
  characterId: string,
  storyTime: string,
): Promise<SillyTavernCard> {
  const snap = await wg.getEntityAt(characterId, storyTime);
  if (!snap) {
    // 实体不存在或已消亡，返回最小卡（role-pool 会照常调用 LLM，由角色规则集约束）
    return { name: characterId, description: "" };
  }

  const card: SillyTavernCard = {
    name: characterId,
    description: snap.summary,
  };

  // 透传已知 SillyTavernCard 字段
  const knownFields = ["name", "description", "personality", "scenario",
                       "first_mes", "mes_example", "creator_notes", "tags"];
  for (const prop of snap.properties) {
    if (knownFields.includes(prop.property)) {
      (card as Record<string, unknown>)[prop.property] = prop.value;
    }
  }

  // 若 name 字段在 Fact 中存在，覆盖默认的 entityId
  const nameFact = snap.properties.find(p => p.property === "name");
  if (nameFact) {
    card.name = String(nameFact.value);
  }

  return card;
}
```

### 3.6 planner LLM 调用细节

**定位**：planner LLM 是调度器内嵌的轻量 LLM 调用，专做"检索计划推导"——不做角色扮演、不做文本生成。与 role-pool/renderer 的 LLM 调用模式对齐（独立 LLM 实例 + tool call 约束）。

**输入**：

```typescript
// system prompt = plannerRuleSet + 检索能力清单
`# 调度器 planner 规则集
${plannerRuleSet}

# 你可调用的检索能力
- character_view：查某角色可见的状态声明（信息差已过滤）
- entity_snapshot：查某实体的完整快照（含所有属性，不管可见性）
- relations：查某实体的关系列表
- search_text：全文检索（关键词命中）
- search_vector：向量检索（语义相似）
- search_hybrid：混合检索（全文+向量）

# 你的任务
基于事件指令 + 参与角色，推导本次叙事需要检索什么信息，
以及每条检索结果应该分配给哪些角色（信息差分配）。
必须调用 retrieval_plan 工具输出结构化检索计划。`

// user message = 事件指令 + 角色清单 + 执行建议
`## 事件指令
${event.instruction}

## 故事时间
${event.storyTime}

## 参与角色
${event.characterIds.map(id => `- ${id}`).join("\n")}

## 执行建议
${event.executionHints ?? "(无特殊要求)"}

## 请输出检索计划`
```

**输出（tool call 模式）**：

通过 pi-ai 的 tool call schema 约束 LLM 必须调用 `retrieval_plan` 工具，工具参数即 `RetrievalPlan` 结构。

```typescript
// 调度器调用 plannerLlm 时实际传给 pi-ai 的 tools 定义
const retrievalPlanTool = {
  name: "retrieval_plan",
  description: "输出本次事件的检索计划：要检索什么信息，每条检索结果分配给哪些角色",
  parameters: Type.Object({
    items: Type.Array(Type.Object({
      type: Type.Union([
        Type.Literal("character_view"),
        Type.Literal("entity_snapshot"),
        Type.Literal("relations"),
        Type.Literal("search_text"),
        Type.Literal("search_vector"),
        Type.Literal("search_hybrid"),
      ]),
      params: Type.Object({
        entityId: Type.Optional(Type.String()),
        query: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Number()),
        modalityFilter: Type.Optional(Type.Array(
          Type.Union([
            Type.Literal("fact"),
            Type.Literal("belief"),
            Type.Literal("hypothesis"),
          ]),
        )),
      }),
      assignTo: Type.Array(Type.String()),
      label: Type.String(),
    })),
  }),
};
```

**已知问题与对策**（参考项目记忆 Lessons Learned）：

| 风险 | 对策 |
|---|---|
| LLM 返回文本而非 tool call | `thinkingLevel: "minimal"` + `timeout: 600s` + system prompt 强化"必须调用 retrieval_plan 工具" |
| LLM 漏掉某角色 | 调度器兜底（plan 函数第 4 步自动补 character_view 检索项） |
| LLM 输出 assignTo 含未参与角色 | 调度器过滤：`item.assignTo = item.assignTo.filter(id => event.characterIds.includes(id))` |
| LLM 输出空 items | 调度器兜底全部角色补 character_view，仍能跑（只是检索范围小） |
| LLM 输出参数缺字段（如 entityId 为空） | `executeRetrievalItem` 中遇必填字段缺失返回 null 跳过该项 |

**planner 规则集.md（`规则/planner.md`）**：

```markdown
# planner 规则集

## 推导原则
- 优先检索直接相关角色的状态、关系
- 涉及地点时检索地点快照
- 涉及物品时检索物品快照
- 历史事件回溯时用 search_text 检索过往剧情
- 信息差：A 角色不应看到 B 角色的内心独白（除非 B 公开表达过）

## 检索数量建议
- 单事件检索项 5-15 条
- 每个参与角色至少 1 条 character_view
- 不要超过 30 条（避免上下文爆炸）

## 输出格式
- 必须调用 retrieval_plan 工具
- 每条 item 必须含 type/params/assignTo/label 四字段
- assignTo 只能是参与角色 ID
```

**单测策略**：
- mock PlannerLlmCaller 返回预设 RetrievalPlan，验证调度器按计划执行检索 + 分配结果
- 测试兜底逻辑：mock planner 返回空 items，验证调度器自动补全每个角色的 character_view
- 测试 assignTo 过滤：mock planner 返回含未参与角色的 assignTo，验证被过滤

---

## 4. 子包文件结构

### 4.1 packages/scheduler/

```
packages/scheduler/
├── package.json              # @pi/scheduler, private, deps: @pi/world-graph, @pi/role-pool, @pi/renderer
├── tsconfig.json             # 继承根 tsconfig
├── src/
│   ├── types.ts              # 类型定义（StructuredEvent / PlanResult / PlanOutput / CommitResult / SchedulerCtx / RetrievalPlan / RetrievalItem / PlannerLlmCaller）
│   ├── plan.ts               # plan 函数（planner LLM 推导检索计划 + 执行检索 + 构建 cast + 调用 role_interact + 缓存）
│   ├── commit.ts             # commit 函数（提取扩散 + invalidated + processEvent + 投影 + renderToFile）
│   ├── retrieve.ts           # executeRetrievalItem 实现（按 RetrievalItem.type 派发到 world-graph API）
│   ├── cache.ts              # planId → PlanResult 的 session 级缓存 + discard 函数
│   ├── chapter-resolver.ts   # 章节路径推断（storyTime → chapterPath）
│   ├── static-card-loader.ts # 默认 staticCard 加载器（Entity+Facts → SillyTavernCard）
│   ├── prompts.ts            # buildPlannerSystemPrompt / buildPlannerUserMessage
│   ├── utils.ts              # randomId / groupBy 等工具
│   └── index.ts              # 子包导出
└── tests/
    ├── plan.test.ts          # plan 流程（mock wg + mock PlannerLlmCaller + mock RoleLlmCaller）
    ├── commit.test.ts        # commit 流程（mock wg + mock RenderLlmCaller）
    ├── retrieve.test.ts      # 各检索类型的派发与结果转换
    ├── cache.test.ts         # plan 缓存读写、discard、过期清理
    ├── chapter-resolver.test.ts
    ├── static-card-loader.test.ts
    ├── prompts.test.ts        # planner 提示词构建
    └── types.test.ts         # 类型守卫/可选字段
```

### 4.2 扩展层 src/

```
src/
├── index.ts                  # 修改：注册 3 个 scheduler_* pi 工具
└── planner-llm.ts            # 新增：makePlannerLlmCaller 适配器（与 renderer-llm.ts / role-pool-llm.ts 同构）
```

注：调度器需要新增 `planner-llm.ts`（planner LLM 适配器），与已有的 `renderer-llm.ts` / `role-pool-llm.ts` 同构。三者分别负责：planner LLM（检索计划推导）、role LLM（角色扮演）、render LLM（文本渲染）。

### 4.3 子包 API 导出

```typescript
// packages/scheduler/src/index.ts
export { plan } from "./plan.ts";
export { commit } from "./commit.ts";
export { discard } from "./cache.ts";
export { resolveChapterPath } from "./chapter-resolver.ts";
export { defaultStaticCardLoader } from "./static-card-loader.ts";
export { executeRetrievalItem } from "./retrieve.ts";
export { buildPlannerSystemPrompt, buildPlannerUserMessage } from "./prompts.ts";
export type {
  StructuredEvent,
  PlanResult,
  PlanOutput,
  CommitResult,
  SchedulerCtx,
  RetrievalPlan,
  RetrievalItem,
  PlannerLlmCaller,
  DispatchPlanOutput,
  DispatchYoloOutput,
} from "./types.ts";
```

---

## 5. 扩展层 pi 工具

### 5.1 scheduler_dispatch（主入口，支持 plan/yolo 双模式）

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `storyTime` | string | 是 | 故事时间（如 ch-2） |
| `instruction` | string | 是 | 事件指令（自然语言，主会话已加工） |
| `characterIds` | string[] | 是 | 参与角色 ID 列表（主会话已识别） |
| `executionHints` | string | 否 | 执行建议（用户特殊要求，如"林冲要显得绝望"） |
| `mode` | "plan" / "yolo" | 否 | 调度模式：plan（跑到角色输出即返回，缺省）/ yolo（自动跑完整条链） |
| `chapterPath` | string | 否 | 章节文件路径（缺省从 storyTime 推断） |
| `locationId` | string | 否 | 地点 ID（用于可见性推断） |
| `intent` | "add" / "modify" / "insert" | 否 | 事件意图（缺省 add；modify/insert 留作 Pending Gap） |
| `targetEventId` | string | 否 | modify/insert 目标事件 ID |

**返回**：

```typescript
// plan 模式返回
interface DispatchPlanOutput {
  mode: "plan";
  planId: string;
  eventId: string;
  chapterPath: string;
  outputs: RoleAgentOutput[];       // 主会话可审阅
  errors: { characterId: string; error: string }[];
  cast: { characterId: string; name: string; summary: string }[];
  retrievalPlan: RetrievalPlan;     // 透明展示 planner LLM 推导的检索计划，便于调试
}

// yolo 模式返回（含 commit 结果）
interface DispatchYoloOutput extends DispatchPlanOutput {
  mode: "yolo";
  commitResult: CommitResult;      // 含 appliedEventIds / writtenText
}
```

**LLM 配置**：
- planner：`PI_PLANNER_MODEL` / `PI_PLANNER_API_KEY`（推导检索计划）
- role：`PI_ROLE_MODEL` / `PI_ROLE_API_KEY`（角色扮演）
- yolo 模式额外用 render：`PI_RENDERER_MODEL` / `PI_RENDERER_API_KEY`

**典型用法**：

```
# plan 模式：主会话审阅后再 commit
主会话: scheduler_dispatch({
  storyTime: "ch-2",
  instruction: "林冲在山神庙偶遇陆谦，得知真相后怒不可遏",
  characterIds: ["linchong", "luxian"],
  executionHints: "这场戏节奏要紧凑，林冲要显得绝望",
  mode: "plan",
})
→ 返回 planId="plan_xxx", outputs=[RoleAgentOutput, ...], retrievalPlan={...}
主会话审阅 outputs 觉得 ok
主会话: scheduler_commit({ planId: "plan_xxx" })
→ 世界图更新 + 章节文件追加渲染文本

# yolo 模式：一气呵成
主会话: scheduler_dispatch({
  storyTime: "ch-3",
  instruction: "次日，林冲自首",
  characterIds: ["linchong"],
  mode: "yolo",
})
→ 直接返回 commitResult（含 appliedEventIds + writtenText）
```

### 5.2 scheduler_commit（plan 模式后的提交）

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `planId` | string | 是 | scheduler_dispatch（mode="plan"）返回的 planId |

**返回**：`CommitResult`（含 ok + appliedEventIds + chapterPath + writtenText）

**LLM 配置**：`PI_RENDERER_MODEL` / `PI_RENDERER_API_KEY`（commit 阶段调 renderToFile）

**幂等性**：commit 后 planId 从缓存删除，重复 commit 同一 planId 会返回错误。

### 5.3 scheduler_discard（丢弃 plan）

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `planId` | string | 是 | 要丢弃的 planId |

**返回**：`{ ok: boolean }`

**用途**：主会话审阅 plan 输出后觉得不对劲，丢弃不提交（不写世界图、不渲染）。

**也可自动触发**：plan 缓存可加 TTL（Pending Gap #9），过期自动 discard。

---

## 6. 测试策略

| 测试层 | 文件 | 内容 | LLM |
|--------|------|------|-----|
| 子包单测 | `plan.test.ts` | planner LLM 调用 + 检索执行 + 兜底补全 + 构建 cast + role_interact 调用顺序；空 characterIds 处理；yolo 模式自动 commit | mock wg + mock PlannerLlmCaller + mock RoleLlmCaller + mock RenderLlmCaller |
| 子包单测 | `commit.test.ts` | state_changes→invalidated→processEvent→renderToFile 完整链路；按 entityId 分组正确 | mock wg + mock RenderLlmCaller |
| 子包单测 | `retrieve.test.ts` | 6 种检索类型（character_view / entity_snapshot / relations / search_text / search_vector / search_hybrid）派发与结果转换；缺字段时返回 null | mock wg |
| 子包单测 | `cache.test.ts` | planId 缓存读写、discard、commit 后删除、不存在的 planId 报错 | 无 |
| 子包单测 | `chapter-resolver.test.ts` | storyTime→chapterPath 推断；非法 storyTime 兜底 | 无 |
| 子包单测 | `static-card-loader.test.ts` | Entity+Facts→SillyTavernCard 重组；实体不存在时返回最小卡 | 无 |
| 子包单测 | `prompts.test.ts` | buildPlannerSystemPrompt / buildPlannerUserMessage 字段拼接 | 无 |
| 子包单测 | `types.test.ts` | 可选字段、类型守卫 | 无 |
| 扩展层 | `tests/scheduler-tools.test.ts` | 3 个 pi 工具（scheduler_dispatch / scheduler_commit / scheduler_discard）的注册和参数解析 | 无 |
| E2E | `tests/e2e-scheduler.test.ts` | 端到端：dispatch(plan)→commit 完整流程 + dispatch(yolo) 一气呵成流程 | 真实 LLM（需 API key） |

**mock 策略**：
- mock WorldGraph：返回预设的 EntitySnapshot（含 summary + properties[]）、characterView 结果、search 结果
- mock PlannerLlmCaller：返回预设的 RetrievalPlan（含 type/params/assignTo/label）；专门测试空 items 兜底
- mock RoleLlmCaller：返回预设的 RoleAgentOutput[]（含 state_changes 字段）
- mock RenderLlmCaller：返回预设的渲染文本

**关键测试用例**：
- `commit.test.ts` 必须验证：
  - state_changes 按 entityId 分组正确
  - 每个 entityId 生成一个 change 事件
  - invalidated 列表正确（从 snapshot.properties 匹配 declarationId）
  - 调用 renderToFile 时 mode="append"，eventId 与 plan 阶段一致
- `plan.test.ts` 必须验证：
  - planner LLM 被调用一次，参数含 instruction + characterIds + executionHints
  - 兜底逻辑：planner 返回空 items 时，每个 characterId 至少有 1 条 character_view 自动补全
  - assignTo 过滤：mock planner 返回未参与角色的 assignTo，被过滤掉
  - cast 顺序与 characterIds 顺序一致
  - 每个 cast member 的 dynamicFacts 来自 RetrievalItem.assignTo 分配
  - role_interact 被调用一次，参数含 executionHints
  - yolo 模式下 plan 后自动调 commit，返回 DispatchYoloOutput
  - plan 缓存写入
- `retrieve.test.ts` 必须验证：
  - 6 种检索类型正确派发到对应 wg API
  - 检索结果按 FactSnapshot 格式统一转换
  - 必填字段缺失时返回 null（不抛错）

---

## 7. 与现有模块的衔接

### 7.1 上游：主会话

调度器接收主会话已结构化的 `StructuredEvent`。

主会话 prompt（main-session.md）待补（Pending Gap #5），但接口先按结构化输入设计。
主会话补 prompt 后即可无缝对接调度器。

主会话的职责边界（参考 V2 设计笔记 9.1 节）：
- 意图分类（剧情推进/规则修改/撤销/伏笔控制/状态查询）
- mode 判断（raw/rewrite/auto）
- 章节判断
- 五要素推理（从对话历史+世界图+章节文本补全缺失要素）
- 伏笔 payload 不暴露原则

### 7.2 下游：角色池（已实现）

调度器通过 `@pi/role-pool.interact` 调用角色池：
- 输入：`InteractCommand`（含 cast + eventInstruction + storyTime）
- 输出：`InteractResult`（含 outputs + errors）

调度器使用 role-pool 已有的转换函数（[transforms.ts](file:///d:/claude/pi-ex/narrative-engine/packages/role-pool/src/transforms.ts)）：
- `toRoleOutputs`：投影为渲染器格式（去掉 state_changes 和 characterId，保留渲染器需要的 6 字段）
- `extractStateChanges`：提取 state_changes（扁平化为 StateChange[]，结构兼容 world_event_apply 的 newFacts）
- `extractRelations`：提取 relation_update（2026-07-25 已接入 commit.ts，Pending Gap #2 闭环）
  - source 取自 RoleAgentOutput.characterId（LLM 直接输出）
  - target 取自 relation_update.target（LLM 直接输出对方 characterId）
  - 调度器直接调 wg.addRelation(sourceId, targetId, label, storyTime)，无需"实体消解"

### 7.3 下游：渲染器（已实现）

调度器通过 `@pi/renderer.renderToFile` 调用渲染器：
- 输入：`RenderFileCommand`（mode="append"，含 chapterPath + eventId + payload + instruction）
- 输出：`RenderResult`（含 ok + writtenText + error）

调度器复用 renderer 已实现的章节文件管理：
- `ensureChapterFile`：文件不存在时自动创建（含版本标记 `<!-- engine v0.01 -->`）
- `appendToChapter`：在文件末尾追加事件锚点 `<!-- event: <eventId> -->` + 渲染文本

### 7.4 下游：世界图（已实现）

调度器通过 `WorldGraph` API 操作世界图：
- `getEntityAt(entityId, storyTime)`：查询 invalidated 时用（找未闭合 Fact 的 declarationId）
- `getCharacterView(characterId, storyTime)`：预取角色视角（信息差分配）
  - WorldGraph 实例方法，[world-graph.ts#L529-L536](file:///d:/claude/pi-ex/narrative-engine/packages/world-graph/src/world-graph.ts#L529-L536) 已实现
  - 内部动态 import [character-view.ts](file:///d:/claude/pi-ex/narrative-engine/packages/world-graph/src/character-view.ts) 的独立函数 `characterView`
  - 调度器直接调 `ctx.wg.getCharacterView(...)`，无需导入独立函数
- `inferVisibility(storyTime)`：基础设施关系推断可见性（同上模式，WorldGraph 实例方法）
- `processEvent(EventRecordInput)`：写扩散（type="change"，含 invalidated + newFacts）

调度器**不调用**的 WorldGraph API（留作 Pending Gap 或后续设计）：
- ~~`addRelation` / `closeRelation`（relation_update 处理，Pending Gap #2）~~ ✅ 已接入：commit.ts 第 5 步调用 `wg.addRelation(sourceId, targetId, label, storyTime)`
- `setVisibility` / `inferVisibility`（knowledge_gained 处理，Pending Gap #3）
- `birthEntity` / `killEntity`（角色生死由主会话或专门工具处理）

### 7.5 类型依赖关系

```
@pi/world-graph  ←  @pi/scheduler  →  @pi/role-pool
                                  →  @pi/renderer
```

- `WorldGraph` / `EntitySnapshot` 从 `@pi/world-graph` 导入
- `CastMember` / `InteractCommand` / `InteractResult` / `RoleAgentOutput` / `StateChange` / `RoleLlmCaller` 从 `@pi/role-pool` 导入
- `RenderFileCommand` / `RoleOutput` / `RenderLlmCaller` 从 `@pi/renderer` 导入
- `SillyTavernCard` 在 `@pi/scheduler` 内重新声明为 interface（与 role-pool 一致，不跨包导入）
- `StructuredEvent` / `PlanResult` / `PlanOutput` / `CommitResult` / `SchedulerCtx` 在 `@pi/scheduler` 内定义

---

## 8. 与引擎核心难题的映射

| 难题 | 调度器涉及程度 | 说明 |
|---|---|---|
| **难题 2**（调度器检索） | ✅ 直接解决 | planner LLM 推导检索计划 + 按 assignTo 分配结果，实现灵活信息差分配（Genette 内聚焦）。不再用固定 characterView 模板，可按事件语义动态决定检索什么 |
| **难题 3**（子代理扮演前置） | ✅ 直接解决 | 构建 CastMember + 调用 role_interact；每个角色的 dynamicFacts 由 planner LLM 决定（信息差从结构变为 LLM 决策） |
| **难题 4**（数据写回） | ✅ 直接解决 | 提取 state_changes + 查询 invalidated + processEvent 写扩散 |
| **难题 5**（事件重写） | ❌ 不在范围 | modify/insert 模式留作 Pending Gap #4（需配合回退机制） |
| **难题 10**（用户编辑融合） | ❌ 不在范围 | 由 world-graph 存储层解决（用户编辑优先原则） |

---

## 9. 待定事项（Pending Gaps）

| # | 事项 | 说明 | 影响 |
|---|------|------|------|
| 1 | staticCard 来源 | 默认从 Entity+Facts 重组 minimal SillyTavernCard；若需导入真实酒馆 V2 卡，需独立设计存储和导入工具 | 当前默认实现可用，但角色信息有限（取决于 birth 事件写入的字段） |
| 2 | relation_update 写入 | role-pool 输出的 relation_update 暂不写入世界图（target 是名字而非 entityId，需实体消解） | 关系演化需主会话手动调用 `world_relation_add` |
| 3 | knowledge_gained → 可见性 | role-pool 输出的 knowledge_gained 是自然语言，需 LLM 转为 declarationId 才能调 `setVisibility` | 暂不处理，后续设计可见性更新模块 |
| 4 | ~~modify/insert 模式~~ ✅ 已完成 | commit.ts 按 `event.intent` 分支 add/modify/insert；modify 复用 renderer.modifyChapterSection，insert 由 scheduler 内嵌 `chapter-edit.ts` 实现（renderer 无 insert 模式）。回退机制采用 Git revert 思路：world-graph 不撤销原事件状态声明，用户需通过新事件显式回滚。详见 `packages/scheduler/src/commit.ts` 与 `packages/scheduler/src/chapter-edit.ts`。 | 已闭环 |
| 5 | 主会话 prompt | main-session.md 未实现（项目记忆 Pending Gaps） | 调度器接口先按结构化输入设计，主会话 prompt 补后即可对接 |
| 6 | ~~plan 缓存持久化~~ ✅ 已完成 | `cache.ts` 已实现文件持久化（`<cwd>/.pi/scheduler-plans/<planId>.json`）+ 1 小时 TTL 自动清理 + 进程重启恢复（`loadAllPlans`） | 已闭环 |
| 7 | 多角色并行场景 | 当前依赖 role-pool 的串行模型（后动者见先动者 action） | 多角色场景由 role-pool 决定，调度器不干预 |
| 8 | 事件粒度 | 单事件 = 单次 dispatch | 用户输入宽泛度决定事件粒度（V2 设计笔记 2.7.1） |
| 9 | plan 过期清理 | 当前无自动清理（依赖 commit/discard 显式删除） | 后续可加 TTL（如 1 小时未 commit 自动 discard） |
| 10 | planner LLM 是否多轮 agentic | 当前设计是单次 LLM 调用即输出完整 RetrievalPlan（不做"检索→回填→再检索"的多轮 loop） | 单次足够覆盖大多数事件；若复杂事件检索不足，后续可升级为 agentic loop |
| 11 | planner LLM 检索结果去重 | 同一 declarationId 可能被多个 RetrievalItem 命中（如 character_view + search_hybrid 都返回同一 fact），目前按 item 顺序追加，不去重 | 短期可接受（角色提示词略冗余）；后续可在 dynamicFactsByCharacter 加 declarationId 去重 |
| 12 | planner 规则集.md 加载器 | 与 role-pool / renderer 的 loadRuleSet 一致，需实现 `loadPlannerRuleSet(cwd)` | 工程待办，实施时一并实现 |
| 13 | planner-llm.ts 适配器 | 与 renderer-llm.ts / role-pool-llm.ts 一致，需实现 `makePlannerLlmCaller(pi, model, apiKey)` | 工程待办，实施时一并实现 |
| 14 | ~~role-pool 接收 executionHints 字段~~ ✅ 已完成 | `role-pool/src/types.ts` 的 `InteractCommand` 已加 `executionHints?: string`；`role-pool/src/prompts.ts` 已将其注入 system prompt 末尾"用户特殊要求"段落。 | 已闭环 |

---

## 10. 不做的事（YAGNI）

- **不做意图理解**：主会话职责（V2 设计笔记 9.1 节）
- **不做角色识别**：主会话职责（characterIds[] 由主会话传入）
- **不做主会话 prompt**：main-session.md 待补（Pending Gap #5）
- **不做伏笔存储**：foreshadowings 字段已从 role-pool 输出去掉
- ~~不做 modify/insert~~ ✅ 已实现（Pending Gap #4 闭环）：commit.ts 按 intent 分支
- ~~不做回退机制~~ ✅ 已实现：采用 Git revert 思路（详见 commit.ts 文件头注释）
- **不做章节自动创建**：章节文件不存在时由 renderer.ensureChapterFile 创建（已实现）
- **不做角色扮演 LLM / 不做文本生成 LLM**：调度器只调 planner LLM（推导检索计划），角色扮演交给 role-pool，文本生成交给 renderer
- ~~不做 plan 持久化~~ ✅ 已实现（Pending Gap #6 闭环）：cache.ts 文件持久化 + TTL
- **不做多角色并行**：依赖 role-pool 的串行模型（Pending Gap #7）
- **不做事件粒度判断**：用户输入宽泛度决定（V2 设计笔记 2.7.1）
- **不做可见性自动推断**：`inferVisibility` 由主会话显式调用 `world_visibility_infer` 触发
- ~~不做 relation_update 实体消解~~ ✅ 已解决（Pending Gap #2 闭环）：
  role-pool prompt 已把 characterId 喂给 LLM 并要求 relation_update.target 填对方 characterId（不是名字）。
  调度器 commit 时直接调 wg.addRelation(sourceId=characterId, targetId=characterId, label, storyTime)，
  全程无需 LLM 消解。"消解"是伪命题，真正问题是 role-pool 漏喂 characterId。
- **不做 plan 过期 TTL**：依赖显式 discard（Pending Gap #9）
