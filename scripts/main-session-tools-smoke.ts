/**
 * main-session-tools-smoke.ts — C2 主会话编排器工具验收（纯 Node，真实 LLM）
 *
 * 验收点（docs/plans/2026-08-01-main-session-execution-plan.md §四 C2）：
 * 1. ChatContext 装配（registry + llmStore + embedder → MainSessionHost）
 * 2. 主会话 systemPrompt 注入 scheduler_dispatch（promptSnippet 生效）
 * 3. LLM 调用 scheduler_dispatch → OrchestratorService 队列出现任务
 *
 * 运行：
 *   $env:NE_LLM_PROVIDER="deepseek"; $env:NE_LLM_MODEL="deepseek-v4-flash";
 *   $env:NE_LLM_API_KEY="<key>"; npx tsx scripts/main-session-tools-smoke.ts
 */

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorldGraph } from "underworld-graph";
import { ProjectRegistry } from "../src/app/project-registry.ts";
import { ChatContext } from "../src/app/chat-context.ts";
import { LlmConfigStore, loadLlmConfigFromEnv } from "../src/orchestrator/llm-config.ts";
import { Embedder } from "../src/embedder.ts";

const SYSTEM_PROMPT =
  "你是编排器工具验收助手。你必须调用 scheduler_dispatch 工具派发一个测试事件（这是本任务的唯一目标），不要做其他事。";

/** 等待 agent_end（run 完成信号） */
function waitForAgentEnd(
  subscribe: (cb: (e: { type: string }) => void) => () => void,
  timeoutMs = 180_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("等待 agent_end 超时"));
    }, timeoutMs);
    const unsubscribe = subscribe((event) => {
      if (event.type === "agent_end") {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
  });
}

async function main(): Promise<void> {
  // 1. LLM 配置（与子代理同源）
  const llmStore = new LlmConfigStore();
  try {
    loadLlmConfigFromEnv();
    llmStore.getModel("default");
    llmStore.getApiKey("default");
  } catch (err) {
    console.error(`[smoke] 缺少 LLM 配置：${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  // 2. 临时 novel 项目（novel.json + 空世界图 allowInit）
  const root = await mkdtemp(join(tmpdir(), "main-session-tools-"));
  const projectDir = join(root, "novel");
  await mkdir(join(projectDir, ".pi"), { recursive: true });
  await mkdir(join(projectDir, "正文"), { recursive: true });
  await writeFile(
    join(projectDir, "novel.json"),
    JSON.stringify({
      name: "smoke",
      engine: "narrative-engine",
      engineVersion: "0.1.0",
      worldGraphDir: ".pi/world-graph-v3",
      chaptersDir: "正文",
      storyTimeFormat: "ch{NNN}.ev{NNN}",
      createdAt: "2026-08-01",
    }),
    "utf8",
  );
  await writeFile(join(projectDir, ".pi", "SYSTEM.md"), SYSTEM_PROMPT, "utf8");
  await writeFile(join(projectDir, "正文", "ch001.md"), "# 第一章\n", "utf8");

  // 3. ChatContext 装配（registry + embedder）
  console.log("[smoke] 加载向量模型（首次需下载，请稍候）…");
  const embedder = new Embedder();
  const registry = new ProjectRegistry({ embedder });
  await registry.setActive(projectDir, { allowInit: true });
  const chatCtx = new ChatContext({
    registry,
    llmStore,
    configDir: join(root, "config"),
    embedder,
  });

  try {
    const host = await chatCtx.ensureHost();
    if (!host) {
      console.error("[smoke] ❌ ensureHost 返回 null（活跃项目缺失？）");
      process.exit(1);
    }
    console.log(`[smoke] ✅ MainSessionHost 已启动（cwd=${host.cwd}）`);

    // 4. 验收 2：工具 promptSnippet 注入 systemPrompt
    const sys = host.session.systemPrompt;
    if (!sys.includes("scheduler_dispatch")) {
      console.error("[smoke] ❌ systemPrompt 未注入 scheduler_dispatch（promptSnippet 缺失？）");
      console.error(`[smoke] systemPrompt 前 300 字：\n${sys.slice(0, 300)}`);
      process.exit(1);
    }
    console.log("[smoke] ✅ scheduler_dispatch 已注入 systemPrompt（promptSnippet 生效）");

    // 5. 验收 3：LLM 调 scheduler_dispatch → 队列出现任务
    const toolEvents: string[] = [];
    const unsubscribe = host.session.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        toolEvents.push((event as { toolName: string }).toolName);
      }
    });
    const done = waitForAgentEnd(host.session.subscribe.bind(host.session));

    console.log("[smoke] 发送消息：调用 scheduler_dispatch 派发测试事件（mode=plan）");
    await host.session.prompt(
      "请调用 scheduler_dispatch 工具派发测试事件：storyTime=ch001.ev001，instruction=验收测试事件，characterIds=[]，mode=plan。",
    );
    await done;
    unsubscribe();

    console.log(`[smoke] LLM 调用的工具: ${JSON.stringify(toolEvents)}`);
    if (!toolEvents.includes("scheduler_dispatch")) {
      console.error("[smoke] ❌ LLM 未调用 scheduler_dispatch（可能模型未按提示执行）");
      process.exit(1);
    }

    const service = await chatCtx.ensureOrchestratorService(projectDir);
    const status = service.queueStatus();
    console.log(`[smoke] 编排器队列状态: length=${status.length}`);
    if (status.length === 0) {
      console.error("[smoke] ❌ scheduler_dispatch 后队列为空");
      process.exit(1);
    }
    console.log(`[smoke] ✅ 队列任务: ${JSON.stringify(status.items.map((i) => ({ queueId: i.queueId, status: i.status, storyTime: i.storyTime })))}`);
    console.log("[smoke] ✅ C2 验收通过：主会话 LLM → scheduler_dispatch → 编排器队列");
  } finally {
    await chatCtx.dispose();
    await registry.closeAll();
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("[smoke] 失败:", err);
  process.exit(1);
});
