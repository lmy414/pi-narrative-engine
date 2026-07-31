/**
 * orchestrator-mcp.ts — 独立启动入口（不启动 PI）
 *
 * 依据：docs/plans/2026-07-31-orchestrator-standalone-implementation.md §6.3
 *
 * 运行：
 *   $env:NE_LLM_PROVIDER="deepseek"; $env:NE_LLM_MODEL="deepseek-v4-flash";
 *   $env:NE_LLM_API_KEY="<key>"; npx tsx scripts/orchestrator-mcp.ts
 *
 * 或直接以 MCP stdio server 被外部进程拉起（Codex / Claude Desktop / PI 子进程等）。
 *
 * 2026-08-01：模型/key 改为探测链（loadLlmConfig）——
 * - key：NE_LLM_API_KEY → provider 标准 env（OPENAI_API_KEY 等）→ Codex auth.json
 * - 模型：NE_LLM_PROVIDER/NE_LLM_MODEL → MCP 客户端名映射（codex→openai 等）
 * 因此 MCP 配置里无需写模型与 key；接入 Codex/Claude 等客户端时自动复用其现有凭据。
 */

import { createRuntimeFromConfig, loadLlmConfig } from "../src/orchestrator/llm-config.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { OrchestratorService } from "../src/orchestrator/service.ts";
import { startMcpServer } from "../src/orchestrator/mcp-server.ts";
import { loadPlannerRuleSet } from "../src/planner-rule-loader.ts";
import { loadRoleRuleSet } from "@pi/role-pool";
import { loadRuleSet } from "@pi/renderer";
import type { SillyTavernCard } from "@pi/scheduler";

async function main(): Promise<void> {
  // 1. LLM 配置（探测链源）→ AgentRuntime，懒加载：
  //    MCP 握手后才能拿到客户端名，runtime 延迟到首次 run 时构造
  const runtimeProvider = async (clientName?: string) => {
    const config = await loadLlmConfig({ clientName });
    const keyPreview = `${config.apiKey.slice(0, 4)}…${config.apiKey.slice(-4)}`;
    console.error(
      `[narrative-orchestrator] LLM 配置: clientName=${clientName ?? "(未识别)"} ` +
        `provider=${config.model.provider} model=${config.model.name} key=${keyPreview}`,
    );
    return createRuntimeFromConfig(config);
  };

  // 2. 规则集（从 novel 工作目录加载；缺省用当前目录，文件不存在时返回空串）
  const cwd = process.env.NE_NOVEL_CWD ?? process.cwd();
  const [plannerRuleSet, roleRuleSet, renderRuleSet] = await Promise.all([
    loadPlannerRuleSet(cwd),
    loadRoleRuleSet(cwd),
    loadRuleSet(cwd),
  ]);

  // 3. 阶段 1 staticCardLoader：简单占位（阶段 2 接 defaultStaticCardLoader）
  const staticCardLoader = async (characterId: string): Promise<SillyTavernCard> => ({
    name: characterId,
    description: characterId,
  });

  // 4. 装配：Orchestrator → OrchestratorService → MCP stdio server
  const orchestrator = new Orchestrator({
    runtimeProvider,
    cwd,
    plannerRuleSet,
    roleRuleSet,
    renderRuleSet,
    staticCardLoader,
  });
  const service = new OrchestratorService(orchestrator);

  console.error(`[narrative-orchestrator] MCP stdio server 启动（cwd=${cwd}，模型按客户端名/探测链确定）`);
  await startMcpServer(service);
}

main().catch((err) => {
  console.error("[narrative-orchestrator] 启动失败:", err);
  process.exit(1);
});
