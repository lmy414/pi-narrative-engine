# `@pi/role-pool` 包 API

> 属于 [API 文档索引](README.md)。角色池子包（workspace 子包，`private: true`）：串行角色扮演编排。无状态（LLM 实例、规则集、演员表均由调用方持有）。源码 `packages/role-pool/src/`。

## 公共导出面（软隔离后）

```typescript
// 核心编排函数
export { interact } from "./role-pool.ts";

// 调度器转换函数（对上统一 API）
export { toRoleOutputs, extractStateChanges, extractRelations } from "./transforms.ts";

// 规则集加载
export { loadRoleRuleSet } from "./rule-loader.ts";

// 类型
export type {
  CastMember,
  InteractCommand,
  InteractHooks,
  InteractResult,
  RoleAgentOutput,
  RoleLlmCaller,
  StateChange,
} from "./types.ts";
```

> 软隔离：`_SillyTavernCard` / `_FactSnapshot` / `_PriorAction` / `_RoleCtx` / `_RelationUpdate` / `_buildSystemPrompt` / `_buildUserMessage` 为内部导出（`_` 前缀）。

## `interact(cmd: InteractCommand, ctx: RoleCtx, hooks?: InteractHooks): Promise<InteractResult>`

按 `cast` 顺序逐个调用角色 LLM，**后动者可见先动者的公开 action**（不含 thought/emotion/state_changes）。单角色失败跳过记 `errors`，不中断。

`InteractCommand` 字段：`eventInstruction`（事件指令）/ `storyTime` / `cast`（`CastMember[]`：`characterId` + `staticCard` 静态层 + `dynamicFacts` 动态层）/ `executionHints?`（用户特殊要求，注入 system prompt 末尾）。

`RoleCtx` 字段：`llm: RoleLlmCaller` + `ruleSet`（角色规则集.md 全文，由调用方 `loadRoleRuleSet` 读取后传入）。

## Prompt 组装（2026-07-25 修订后）

- **System**：角色规则集.md + "动态层优先于静态层"冲突提醒 + executionHints（可选）
- **User**：`[你的 entityId]` + `[本场角色名单]` → 静态卡 JSON → 动态层 → storyTime → 先动者行动 → 事件指令（末尾）
- **动态层渲染**：`- [属主名] property: value（modality）`；已闭合声明标注 `（fact·旧）`；按检索 label 分组渲染【小标题】

## `RoleAgentOutput`（9 字段）

```typescript
{
  characterId: string;          // 必填，LLM 填自己的 entityId
  actor: string;                // 行动者名字（角色卡 name）
  action: string;               // 可观察行动
  target?: string;
  emotion?: string;
  relation_update?: { target: string; label: string }[];  // target 填对方 characterId
  thought?: string;             // 内心（其他角色不可见）
  knowledge_gained?: string[];  // P0-3+6 修复后由 commit.ts 4.4 步经 knowledgeMapper LLM 映射到 declarationId 并写 Visibility（source=informed）；未注入 mapper 时跳过（详见 scheduler.md）
  state_changes?: { entityId: string; property: string; value: unknown; modality: Modality }[];
}
```

## InteractHooks（调试钩子，可选）

```typescript
export interface InteractHooks {
  /** 角色开始生成前调用；返回值原样透传给 onTurnEnd，可携带 span 句柄 */
  onTurnStart?(member: CastMember, index: number): unknown;
  /** 角色生成结束（成功或失败）后调用 */
  onTurnEnd?(
    token: unknown,
    member: CastMember,
    result: { output?: RoleAgentOutput; error?: string },
  ): void;
}
```

调度器在 `interact` 调用时注入实现，把每个角色的生成过程挂到 `DebugBus`（stage: `role.turn`）。role-pool 本身不感知 DebugBus——保持本子包零外部依赖。不注入时零开销。

## transforms

| 函数 | 用途 |
|------|------|
| `extractStateChanges(outputs)` | 扁平化全部 state_changes（供 commit 写扩散） |
| `extractRelations(outputs)` | 提取 relation_update，source 取 `characterId` |
| `toRoleOutputs(outputs)` | 投影为渲染器 RoleOutput（剥掉 `characterId`/`state_changes`） |

## `loadRoleRuleSet(novelCwd: string): Promise<string>`

读取 `<novelCwd>/角色规则集.md` 全文。文件不存在时返回空字符串（不报错）。不缓存，每次重读。
