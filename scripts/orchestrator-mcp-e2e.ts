/**
 * orchestrator-mcp-e2e.ts — 阶段 1 端到端验证（MCP Client → stdio server）
 *
 * 依据：docs/plans/2026-07-31-orchestrator-standalone-implementation.md §7.3
 *
 * 验证目标：
 * 1. 不启动 PI，独立进程启动 MCP stdio server 成功
 * 2. scheduler_dispatch（plan 模式）→ 返回 queueId
 * 3. scheduler_queue_status → 事件最终 status=done
 * 4. 子代理链路跑通（planner → 角色，产出经 tool_execution_end 收集）
 *
 * 运行：
 *   $env:NE_LLM_API_KEY="<key>"; npx tsx scripts/orchestrator-mcp-e2e.ts
 *
 * 注意：会发起真实 LLM 调用（planner + 角色代理），消耗少量 token。
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const apiKey = process.env.NE_LLM_API_KEY ?? process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    console.error("[e2e] 缺少 API Key：请设置 NE_LLM_API_KEY（或 DEEPSEEK_API_KEY）");
    process.exit(1);
  }

  // 1. 启动 server 子进程（tsx 运行，避免先 build）
  const serverScript = join(__dirname, "orchestrator-mcp.ts");
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", serverScript],
    cwd: join(__dirname, ".."),
    env: {
      ...process.env,
      NE_LLM_API_KEY: apiKey,
      NE_LLM_PROVIDER: process.env.NE_LLM_PROVIDER ?? "deepseek",
      NE_LLM_MODEL: process.env.NE_LLM_MODEL ?? "deepseek-v4-flash",
    } as Record<string, string>,
  });

  const client = new Client({ name: "orchestrator-e2e", version: "0.1.0" });
  await client.connect(transport);
  console.log("[e2e] MCP client 已连接");

  // 2. 列出工具（验证 4 个调度工具暴露）
  const tools = await client.listTools();
  const toolNames = tools.tools.map((t) => t.name);
  console.log("[e2e] 工具列表:", toolNames.join(", "));

  // 3. dispatch（plan 模式）
  const dispatchResult = await client.callTool({
    name: "scheduler_dispatch",
    arguments: {
      storyTime: "ch001.ev001",
      instruction: "林冲在山神庙前发现陆谦放火，两人对峙。",
      characterIds: ["e_lin_chong", "e_lu_qian"],
      mode: "plan",
    },
  });
  const dispatchText = dispatchResult.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
  console.log("[e2e] dispatch 返回:", dispatchText);

  // 4. 轮询队列状态直到 done/error（子代理链路异步执行）
  let finalStatus = "pending";
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 3000)); // 每 3s 轮询，最多 3 分钟
    const statusResult = await client.callTool({
      name: "scheduler_queue_status",
      arguments: {},
    });
    const statusText = statusResult.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    const parsed = JSON.parse(statusText) as {
      length: number;
      items: Array<{ queueId: string; status: string; error?: string; storyTime?: string }>;
    };
    const item = parsed.items[0];
    if (!item) {
      console.log(`[e2e] (${i}) 队列为空`);
      break;
    }
    console.log(`[e2e] (${i}) status=${item.status}${item.error ? ` error=${item.error}` : ""}`);
    finalStatus = item.status;
    if (item.status === "done" || item.status === "error") break;
  }

  await client.close();
  if (finalStatus === "done") {
    console.log("[e2e] ✅ 阶段 1 验收通过：子代理链路跑通，事件处理完成");
  } else {
    console.error(`[e2e] ❌ 事件未完成，最终状态=${finalStatus}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[e2e] 失败:", err);
  process.exit(1);
});
