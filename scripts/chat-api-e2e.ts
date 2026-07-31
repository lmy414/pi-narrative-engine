/**
 * chat-api-e2e.ts — C3 HTTP 聊天端点端到端验收（真实 HTTP + 真实 LLM + SSE）
 *
 * 验收点（docs/plans/2026-08-01-main-session-execution-plan.md §四 C3）：
 * 1. POST /api/chat/message 立即返回 { ok: true }（preflightResult 模式）
 * 2. GET /api/chat/events SSE 事件流（message_update 完整快照 + agent_end 收尾）
 * 3. GET /api/chat/status 反映会话状态（懒启动）
 *
 * 运行：
 *   $env:NE_LLM_PROVIDER="deepseek"; $env:NE_LLM_MODEL="deepseek-v4-flash";
 *   $env:NE_LLM_API_KEY="<key>"; npx tsx scripts/chat-api-e2e.ts
 */

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectRegistry } from "../src/app/project-registry.ts";
import { ChatContext } from "../src/app/chat-context.ts";
import { startUnifiedServer } from "../src/app/unified-server.ts";
import { LlmConfigStore, loadLlmConfigFromEnv } from "../src/orchestrator/llm-config.ts";
import { Embedder } from "../src/embedder.ts";

const SYSTEM_PROMPT = "你是 HTTP 聊天端点验收助手。任何回复只输出两个字符：收到。";

/** 等待条件成立（轮询） */
async function waitFor(cond: () => boolean, timeoutMs: number, desc: string): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时: ${desc}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function main(): Promise<void> {
  // LLM 配置
  const llmStore = new LlmConfigStore();
  try {
    loadLlmConfigFromEnv();
    llmStore.getModel("default");
    llmStore.getApiKey("default");
  } catch (err) {
    console.error(`[e2e] 缺少 LLM 配置：${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  // 临时项目 + 服务
  const root = await mkdtemp(join(tmpdir(), "chat-api-e2e-"));
  const projectDir = join(root, "novel");
  await mkdir(join(projectDir, ".pi"), { recursive: true });
  await mkdir(join(projectDir, "正文"), { recursive: true });
  await writeFile(
    join(projectDir, "novel.json"),
    JSON.stringify({ name: "e2e", engine: "narrative-engine", engineVersion: "0.1.0", worldGraphDir: ".pi/world-graph-v3", chaptersDir: "正文", storyTimeFormat: "ch{NNN}.ev{NNN}", createdAt: "2026-08-01" }),
    "utf8",
  );
  await writeFile(join(projectDir, ".pi", "SYSTEM.md"), SYSTEM_PROMPT, "utf8");
  await writeFile(join(projectDir, "正文", "ch001.md"), "# 第一章\n", "utf8");

  console.log("[e2e] 加载向量模型（首次需下载，请稍候）…");
  const embedder = new Embedder();
  const registry = new ProjectRegistry({ embedder });
  await registry.setActive(projectDir, { allowInit: true });
  const chatContext = new ChatContext({ registry, llmStore, configDir: join(root, "config"), embedder });
  const server = await startUnifiedServer({ registry, port: 0, embedder, chatContext });
  const base = server.url;
  console.log(`[e2e] 服务已启动: ${base}`);

  try {
    // 1. status：懒启动，初始 active=false
    let r = await fetch(`${base}api/chat/status`);
    let body = (await r.json()) as { ok: boolean; data: { active: boolean; cwd: string | null } };
    if (body.data.active) {
      console.error("[e2e] ❌ 初始 status 应为 active=false（懒启动）");
      process.exit(1);
    }
    console.log("[e2e] ✅ status 懒启动正确（active=false）");

    // 2. SSE：先开连接，再发消息，收集事件流
    const sseRes = await fetch(`${base}api/chat/events`);
    if (!sseRes.ok || !sseRes.body) {
      console.error(`[e2e] ❌ SSE 连接失败: ${sseRes.status}`);
      process.exit(1);
    }
    const reader = sseRes.body.getReader();
    const decoder = new TextDecoder();
    let sseText = "";
    const readLoop = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        sseText += decoder.decode(value, { stream: true });
      }
    })();
    await waitFor(() => sseText.length > 0, 10_000, "SSE 首个字节");

    // 3. message：接收即回
    r = await fetch(`${base}api/chat/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "请回复两个字：收到" }),
    });
    body = (await r.json()) as { ok: boolean; data: unknown };
    if (!body.ok || (body.data as { received?: boolean }).received !== true) {
      console.error(`[e2e] ❌ message 未立即接收: ${JSON.stringify(body)}`);
      process.exit(1);
    }
    console.log("[e2e] ✅ POST message 立即返回 received=true");

    // 4. 等待 SSE 流中 agent_end（run 完成）
    await waitFor(() => sseText.includes('"type":"agent_end"'), 180_000, "SSE agent_end");
    if (!sseText.includes("message_update")) {
      console.error("[e2e] ❌ SSE 流中无 message_update");
      process.exit(1);
    }
    console.log("[e2e] ✅ SSE 事件流含 message_update 与 agent_end");
    const sample = sseText.split("\n").find((l) => l.includes("message_update"));
    console.log(`[e2e]   message_update 样本: ${sample?.slice(0, 200) ?? ""}`);
    await reader.cancel();
    await readLoop;

    // 5. status：会话已启动
    r = await fetch(`${base}api/chat/status`);
    body = (await r.json()) as { ok: boolean; data: { active: boolean; cwd: string | null; isStreaming: boolean } };
    if (!body.data.active || body.data.cwd !== projectDir) {
      console.error(`[e2e] ❌ status 未反映启动状态: ${JSON.stringify(body)}`);
      process.exit(1);
    }
    console.log("[e2e] ✅ status 已反映会话启动（active=true）");
    console.log("[e2e] ✅ C3 验收通过：HTTP 聊天端点 + SSE 事件流");
  } finally {
    server.close();
    await chatContext.dispose();
    await registry.closeAll();
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("[e2e] 失败:", err);
  process.exit(1);
});
