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
 * 2026-08-01（用户决策）：LLM 配置改为**独立配置中心**（LlmConfigStore），
 * 不复用 MCP 客户端凭据——外部模块 / pi 适配器经代码 API 注入各 slot
 * （planner=调度器 / role=角色扮演 / reasoning / renderer）的 provider/model/apiKey；
 * 未注入的 slot 回退 default → env（NE_LLM_* / DEEPSEEK_API_KEY 等）兜底。
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { WorldGraph } from "underworld-graph";
import { LlmConfigStore, loadLlmConfigFromEnv } from "../src/orchestrator/llm-config.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { OrchestratorService } from "../src/orchestrator/service.ts";
import { startMcpServer } from "../src/orchestrator/mcp-server.ts";
import { assemblePorts } from "../src/orchestrator/assembly.ts";
import { Embedder } from "../src/embedder.ts";
import { Search } from "../src/search.ts";
import { resolveWorldGraphDir } from "../src/session-state.ts";
import { loadPlannerRuleSet } from "../src/planner-rule-loader.ts";
import { loadRoleRuleSet } from "@pi/role-pool";
import { loadRuleSet } from "@pi/renderer";
import type { SillyTavernCard } from "@pi/scheduler";

/** 打开（或创建）世界图：<cwd>/.pi/world-graph-v3/world.db + events.jsonl */
async function openWorldGraph(cwd: string): Promise<WorldGraph> {
  const dir = resolveWorldGraphDir(cwd);
  await fs.mkdir(dir, { recursive: true });
  return WorldGraph.create({
    dbPath: path.join(dir, "world.db"),
    eventLogPath: path.join(dir, "events.jsonl"),
  });
}

async function main(): Promise<void> {
  // 1. 独立 LLM 配置中心：各 slot 可经 setConfig/setRuntime 注入，未注入走 env 兜底
  const llmStore = new LlmConfigStore();
  try {
    const envCfg = loadLlmConfigFromEnv();
    console.error(
      `[narrative-orchestrator] env 兜底可用: ${envCfg.model.provider}/${envCfg.model.name}（各 slot 可经 LlmConfigStore 覆盖）`,
    );
  } catch (err) {
    console.error(
      `[narrative-orchestrator] 提示: env 无可用 key（${err instanceof Error ? err.message : err}）。` +
        "请经 LlmConfigStore.setConfig 注入各 slot，或设置 NE_LLM_API_KEY / DEEPSEEK_API_KEY 等。",
    );
  }

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

  // 4. 数据层实例 → Ports（阶段 A：子代理工具经此读写世界图/章节）
  const wg = await openWorldGraph(cwd);
  const embedder = new Embedder();
  const search = new Search(wg, embedder);
  const ports = assemblePorts({ wg, search, embedder });

  // 5. 装配：Orchestrator → OrchestratorService → MCP stdio server
  const orchestrator = new Orchestrator({
    llmStore,
    cwd,
    plannerRuleSet,
    roleRuleSet,
    renderRuleSet,
    staticCardLoader,
    ports,
  });
  const service = new OrchestratorService(orchestrator);

  console.error(`[narrative-orchestrator] MCP stdio server 启动（cwd=${cwd}）`);
  await startMcpServer(service);
}

main().catch((err) => {
  console.error("[narrative-orchestrator] 启动失败:", err);
  process.exit(1);
});
