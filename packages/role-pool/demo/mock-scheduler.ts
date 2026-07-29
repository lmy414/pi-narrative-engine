/**
 * mock-scheduler.ts — 模拟调度器调用角色池的完整数据流
 *
 * 不调用真实 LLM，用 mock caller 返回预设输出，展示：
 * 1. 调度器如何组装 InteractCommand（预取角色卡 + 动态事实）
 * 2. 角色池串行执行后的 InteractResult
 * 3. 转换函数输出：toRoleOutputs / extractStateChanges / extractRelations
 *
 * 运行：npx tsx demo/mock-scheduler.ts
 */

import {
  interact,
  toRoleOutputs,
  extractStateChanges,
  extractRelations,
  type CastMember,
  type InteractCommand,
  type RoleAgentOutput,
  type RoleLlmCaller,
  type _RoleCtx,
} from "../src/index.ts";

// ============================================================================
// 1. Mock LLM Caller — 模拟角色代理的 LLM 输出
//    按角色顺序返回预设的 RoleAgentOutput
// ============================================================================

function makeMockLlm(scriptedOutputs: RoleAgentOutput[]): RoleLlmCaller {
  let callIndex = 0;
  return async (_systemPrompt: string, _userMessage: string): Promise<RoleAgentOutput> => {
    const output = scriptedOutputs[callIndex] ?? {
      actor: "未知",
      action: "无",
    };
    callIndex++;
    // 模拟 LLM 延迟
    await new Promise((resolve) => setTimeout(resolve, 50));
    return output;
  };
}

// ============================================================================
// 2. 模拟调度器预取的数据（角色卡 + 动态事实）
//    现实中调度器会调用 world_character_view + 读取角色卡 JSON
// ============================================================================

const linchongCard = {
  name: "林冲",
  description: "豹头环眼，燕颔虎须，八十万禁军教头",
  personality: "隐忍、重义、刚烈",
  scenario: "被高俅陷害，发配沧州",
};

const luxianCard = {
  name: "陆谦",
  description: "林冲旧友，现为高俅爪牙",
  personality: "阴险、圆滑、背信弃义",
};

const linchongFacts = [
  {
    declarationId: "decl-001",
    entityId: "linchong",
    property: "mood",
    value: "愤怒",
    modality: "fact" as const,
    validFrom: "ch-1",
  },
  {
    declarationId: "decl-002",
    entityId: "linchong",
    property: "location",
    value: "山神庙",
    modality: "fact" as const,
    validFrom: "ch-1",
  },
];

const luxianFacts = [
  {
    declarationId: "decl-003",
    entityId: "luxian",
    property: "mood",
    value: "心虚",
    modality: "belief" as const,
    validFrom: "ch-1",
  },
];

const cast: CastMember[] = [
  {
    characterId: "linchong",
    staticCard: linchongCard,
    dynamicFacts: linchongFacts,
  },
  {
    characterId: "luxian",
    staticCard: luxianCard,
    dynamicFacts: luxianFacts,
  },
];

// ============================================================================
// 3. 模拟调度器解析出的事件指令（五要素中的核心）
// ============================================================================

const cmd: InteractCommand = {
  eventInstruction: "林冲在山神庙偶遇陆谦，得知真相后怒不可遏",
  storyTime: "ch-2",
  cast,
};

// ============================================================================
// 4. 模拟 LLM 会返回的结构化输出（两个角色依次行动）
// ============================================================================

const scriptedOutputs: RoleAgentOutput[] = [
  // 第一个角色：林冲
  {
    actor: "林冲",
    action: "揪住陆谦衣领，怒目圆睁",
    target: "陆谦",
    emotion: "愤怒至极",
    relation_update: [{ target: "陆谦", label: "仇敌" }],
    thought: "多年情谊，竟换来家破人亡，今日必报此仇",
    knowledge_gained: ["陆谦是火烧草料场的元凶", "高俅是幕后主使"],
    state_changes: [
      { entityId: "linchong", property: "mood", value: "暴怒", modality: "fact" },
      { entityId: "linchong", property: "intent", value: "杀陆谦", modality: "fact" },
    ],
  },
  // 第二个角色：陆谦（能看到林冲的公开行动）
  {
    actor: "陆谦",
    action: "跪地求饶，狡辩推脱",
    target: "林冲",
    emotion: "恐惧",
    relation_update: [{ target: "林冲", label: "畏惧" }],
    thought: "林冲已知真相，今日怕是难以脱身",
    knowledge_gained: ["林冲已知真相"],
    state_changes: [
      { entityId: "luxian", property: "mood", value: "恐惧", modality: "fact" },
      { entityId: "luxian", property: "location", value: "山神庙", modality: "fact" },
    ],
  },
];

// ============================================================================
// 5. 执行：模拟调度器完整调用流程
// ============================================================================

async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  模拟调度器调用角色池（mock LLM）");
  console.log("═══════════════════════════════════════════════════\n");

  // --- 步骤 1: 打印调度器传参 ---
  console.log("【1】调度器组装的 InteractCommand：");
  console.log(JSON.stringify(cmd, null, 2));
  console.log();

  // --- 步骤 2: 调用角色池 ---
  const llm: RoleLlmCaller = makeMockLlm(scriptedOutputs);
  const ruleSet = `# 角色规则集\n\n## 扮演原则\n- 严格以角色第一人称视角行动\n- 行动需符合角色当前情绪与处境\n\n## 输出格式\n- 必须调用 character_action 工具\n- action 字段只描述可观察的外部行为`;
  const ctx: _RoleCtx = { llm, ruleSet };

  console.log("【2】调用 interact(cmd, ctx)...\n");
  const result = await interact(cmd, ctx);

  // --- 步骤 3: 打印角色池原始输出 ---
  console.log("【3】InteractResult.outputs（角色池原始输出）：");
  console.log(JSON.stringify(result.outputs, null, 2));
  console.log();
  console.log("InteractResult.errors：");
  console.log(JSON.stringify(result.errors, null, 2));
  console.log();

  // --- 步骤 4: 转换为渲染器格式 ---
  console.log("【4】toRoleOutputs() → 传给 render_append：");
  const roleOutputs = toRoleOutputs(result.outputs);
  console.log(JSON.stringify(roleOutputs, null, 2));
  console.log();

  // --- 步骤 5: 提取状态变更 ---
  console.log("【5】extractStateChanges() → 传给 world_event_apply (newFacts)：");
  const stateChanges = extractStateChanges(result.outputs);
  console.log(JSON.stringify(stateChanges, null, 2));
  console.log();

  // --- 步骤 6: 提取关系变更 ---
  console.log("【6】extractRelations() → 传给 world_relation_add：");
  const relations = extractRelations(result.outputs);
  console.log(JSON.stringify(relations, null, 2));
  console.log();

  console.log("═══════════════════════════════════════════════════");
  console.log("  数据流完毕");
  console.log("═══════════════════════════════════════════════════");
}

main().catch((err) => {
  console.error("模拟调度器执行失败：", err);
  process.exit(1);
});
