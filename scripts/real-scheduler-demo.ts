/**
 * real-scheduler-demo.ts — 真实 LLM 调用的调度器模拟
 *
 * 与 mock-scheduler.ts 相同的数据流，但使用真实 pi-ai LLM 调用。
 * 需要 DEEPSEEK_API_KEY 环境变量。
 *
 * 运行：npx tsx scripts/real-scheduler-demo.ts
 */

import {
  interact,
  toRoleOutputs,
  extractStateChanges,
  extractRelations,
  type CastMember,
  type InteractCommand,
  type RoleCtx,
} from "../packages/role-pool/src/index.ts";
import { makeRoleLlmCaller } from "../src/role-pool-llm.ts";

// ============================================================================
// 1. 模拟调度器预取的数据（角色卡 + 动态事实）
// ============================================================================

const linchongCard = {
  name: "林冲",
  description: "豹头环眼，燕颔虎须，八十万禁军教头。原为东京八十万禁军枪棒教头，武艺高强。",
  personality: "隐忍、重义、刚烈。平日沉稳，被逼至绝境则奋起杀人。",
  scenario: "被高俅陷害，发配沧州。刚在草料场得知陆谦放火暗算，赶到山神庙。",
  first_mes: "（握紧长枪，风雪中独立山神庙前）",
};

const luxianCard = {
  name: "陆谦",
  description: "林冲旧友，现为高俅爪牙。面白无须，眼神阴鸷。",
  personality: "阴险、圆滑、背信弃义。为荣华富贵不惜出卖朋友。",
  scenario: "奉高俅之命火烧草料场，欲置林冲于死地。此时正在山神庙内避雪。",
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
  {
    declarationId: "decl-003",
    entityId: "linchong",
    property: "knowledge",
    value: "得知陆谦放火暗算",
    modality: "fact" as const,
    validFrom: "ch-1",
  },
];

const luxianFacts = [
  {
    declarationId: "decl-004",
    entityId: "luxian",
    property: "mood",
    value: "得意",
    modality: "belief" as const,
    validFrom: "ch-1",
  },
  {
    declarationId: "decl-005",
    entityId: "luxian",
    property: "location",
    value: "山神庙",
    modality: "fact" as const,
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
// 2. 调度器命令
// ============================================================================

const cmd: InteractCommand = {
  eventInstruction: "林冲推开山神庙门，正好撞见在此避雪的陆谦。两人对峙，真相已明。",
  storyTime: "ch-2",
  cast,
};

// ============================================================================
// 3. 角色规则集（模拟 角色规则集.md）
// ============================================================================

const ruleSet = `# 角色规则集

## 扮演原则
- 严格以角色第一人称视角行动与思考
- 行动必须符合角色当前情绪、处境与性格
- 行动要有具体性（动作、神态、语言），不要泛泛而谈
- 思考（thought）字段是内心独白，其他角色不可见

## 感知与信息隔离
- 你只能看到「先动者行动」区块中的公开行动
- 你不知道其他角色的 thought / emotion / knowledge_gained / state_changes
- 如果先动者行动对你不可见（如你不在场），忽略它

## 输出格式
- 必须调用 character_action 工具输出，不要返回纯文本
- action 字段：只描述可观察的外部行为（动作、神态、语言），让旁人能看见
- thought 字段：内心独白，第一人称
- state_changes：只填写本次行动导致的状态变化，不重复已有状态

## 禁止
- 禁止替其他角色行动或说话
- 禁止输出"无行动"或空 action
- 禁止 action 字段中混入心理描写（心理放 thought）`;

// ============================================================================
// 4. 执行
// ============================================================================

async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  真实 LLM 调用：调度器 → 角色池 → 转换函数");
  console.log("═══════════════════════════════════════════════════\n");

  const apiKey = process.env.DEEPSEEK_API_KEY ?? process.env.PI_API_KEY ?? process.env.PI_ROLE_API_KEY;
  if (!apiKey) {
    console.error("❌ 未配置 DEEPSEEK_API_KEY / PI_API_KEY / PI_ROLE_API_KEY");
    process.exit(1);
  }
  const model = process.env.PI_ROLE_MODEL ?? process.env.PI_MODEL ?? "deepseek-v4-flash";
  console.log(`模型：${model}\n`);

  // --- 调度器传参 ---
  console.log("【1】调度器组装的 InteractCommand：");
  console.log(JSON.stringify(cmd, null, 2));
  console.log();

  // --- 调用角色池 ---
  const llm = makeRoleLlmCaller(model, apiKey);
  const ctx: RoleCtx = { llm, ruleSet };

  console.log("【2】调用 interact(cmd, ctx)...\n");
  const t0 = Date.now();
  const result = await interact(cmd, ctx);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`（耗时 ${elapsed}s）\n`);

  // --- 角色池原始输出 ---
  console.log("【3】InteractResult.outputs（角色池原始输出）：");
  console.log(JSON.stringify(result.outputs, null, 2));
  console.log();
  console.log("InteractResult.errors：");
  console.log(JSON.stringify(result.errors, null, 2));
  console.log();

  if (result.outputs.length === 0) {
    console.log("⚠️ 所有角色调用失败，停止后续转换");
    return;
  }

  // --- 转换为渲染器格式 ---
  console.log("【4】toRoleOutputs() → 传给 render_append：");
  console.log(JSON.stringify(toRoleOutputs(result.outputs), null, 2));
  console.log();

  // --- 提取状态变更 ---
  console.log("【5】extractStateChanges() → 传给 world_event_apply (newFacts)：");
  console.log(JSON.stringify(extractStateChanges(result.outputs), null, 2));
  console.log();

  // --- 提取关系变更 ---
  console.log("【6】extractRelations() → 传给 world_relation_add：");
  console.log(JSON.stringify(extractRelations(result.outputs), null, 2));
  console.log();

  console.log("═══════════════════════════════════════════════════");
  console.log("  完成");
  console.log("═══════════════════════════════════════════════════");
}

main().catch((err) => {
  console.error("执行失败：", err);
  process.exit(1);
});
