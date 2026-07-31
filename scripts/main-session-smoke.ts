/**
 * main-session-smoke.ts — C1 主会话最小链路验收（纯 Node，不启动 PI）
 *
 * 验收点（docs/plans/2026-08-01-main-session-execution-plan.md §四 C1）：
 * 1. createAgentSessionServices + createAgentSessionRuntime 在纯 Node 可用
 * 2. .pi/SYSTEM.md 被 DefaultResourceLoader 自动发现并注入 systemPrompt
 * 3. 真实 LLM 对话跑通（session.prompt + subscribe 事件流）
 *
 * 运行：
 *   $env:NE_LLM_PROVIDER="deepseek"; $env:NE_LLM_MODEL="deepseek-v4-flash";
 *   $env:NE_LLM_API_KEY="<key>"; npx tsx scripts/main-session-smoke.ts
 *
 * 不传 NE_LLM_API_KEY 时使用 DEEPSEEK_API_KEY（兼容既有 demo 脚本约定）。
 */

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LlmConfigStore, loadLlmConfigFromEnv } from "../src/orchestrator/llm-config.ts";
import { MainSessionHost } from "../src/chat/main-session.ts";

const SMOKE_SYSTEM_PROMPT = "你是主会话 smoke 验证助手。任何回复只输出两个字符：收到。";

/** 等待会话事件（agent_end 为 run 完成信号；message_end 会在用户消息入队时同步触发，不可作收尾） */
function waitForEvent<T extends { type: string }>(
  subscribe: (cb: (e: T) => void) => () => void,
  types: string[],
  timeoutMs = 120_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`等待事件 ${types.join("/")} 超时`));
    }, timeoutMs);
    const unsubscribe = subscribe((event) => {
      if (types.includes(event.type)) {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
  });
}

/** 从会话消息内容中提取文本（message_update 快照 content 数组） */
function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: string; text?: string } => typeof b === "object" && b !== null)
    .map((b) => (b.type === "text" ? (b.text ?? "") : ""))
    .join("");
}

async function main(): Promise<void> {
  // 1. LLM 配置：与子代理同源（LlmConfigStore，env 兜底）
  const llmStore = new LlmConfigStore();
  let model;
  let apiKey;
  try {
    loadLlmConfigFromEnv();
    model = llmStore.getModel("default");
    apiKey = llmStore.getApiKey("default");
  } catch (err) {
    console.error(`[smoke] 缺少 LLM 配置：${err instanceof Error ? err.message : err}`);
    console.error("[smoke] 请设置 NE_LLM_API_KEY（或 DEEPSEEK_API_KEY）后重试");
    process.exit(1);
  }

  // 2. 临时项目目录 + .pi/SYSTEM.md（验收自动发现注入）
  const root = await mkdtemp(join(tmpdir(), "main-session-smoke-"));
  const projectDir = join(root, "project");
  const agentDir = join(root, "agent");
  const sessionDir = join(projectDir, ".pi", "sessions");
  await mkdir(join(projectDir, ".pi"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(projectDir, ".pi", "SYSTEM.md"), SMOKE_SYSTEM_PROMPT, "utf8");

  const host = new MainSessionHost({
    agentDir,
    cwd: projectDir,
    sessionDir,
    customTools: [],
    model,
    runtimeApiKey: { provider: model.provider, apiKey },
  });

  try {
    console.log(`[smoke] 启动 MainSessionHost（cwd=${projectDir}）`);
    await host.start();

    // 3. 验收 2：.pi/SYSTEM.md 自动发现
    const systemPrompt = host.session.systemPrompt;
    if (!systemPrompt.includes(SMOKE_SYSTEM_PROMPT)) {
      console.error("[smoke] ❌ .pi/SYSTEM.md 未被注入 systemPrompt");
      console.error(`[smoke] 实际 systemPrompt 前 500 字：\n${systemPrompt.slice(0, 500)}`);
      process.exit(1);
    }
    console.log("[smoke] ✅ .pi/SYSTEM.md 已自动发现并注入 systemPrompt");
    if (host.modelFallbackMessage) {
      console.log(`[smoke] 模型回退提示: ${host.modelFallbackMessage}`);
    }

    // 4. 验收 3：真实对话（订阅事件流，等 agent_end 收尾）
    const messages: string[] = [];
    const eventLog: string[] = [];
    const unsubscribe = host.session.subscribe((event) => {
      switch (event.type) {
        case "message_update": {
          const text = extractText(
            "message" in event ? (event.message as { content?: unknown }).content : undefined,
          );
          if (text) messages[messages.length - 1] = text;
          // 只在文本变化时记录（流式 thinking 阶段多次空快照不刷屏）
          if (eventLog.at(-1) !== `message_update(text=${JSON.stringify(text)})`) {
            eventLog.push(`message_update(text=${JSON.stringify(text)})`);
          }
          break;
        }
        case "message_start": {
          messages.push("");
          eventLog.push(`message_start(role=${(event.message as { role?: string }).role})`);
          break;
        }
        case "message_end": {
          eventLog.push("message_end");
          break;
        }
        default:
          eventLog.push(event.type);
      }
    });
    const done = waitForEvent(host.session.subscribe.bind(host.session), ["agent_end"]);

    console.log("[smoke] 发送消息：请回复两个字：收到");
    const preflight = await new Promise<boolean>((resolve) => {
      void host.session
        .prompt("请回复两个字：收到", { preflightResult: resolve })
        .catch((err) => {
          console.error(`[smoke] prompt 失败: ${err instanceof Error ? err.message : err}`);
          process.exit(1);
        });
    });
    if (!preflight) {
      console.error("[smoke] ❌ prompt 未被接收（模型校验失败？）");
      process.exit(1);
    }
    console.log("[smoke] prompt 已接收（preflight 通过）");

    await done;
    unsubscribe();

    console.log("[smoke] 事件流摘要:");
    for (const line of eventLog) console.log(`  ${line}`);

    const reply = messages.filter(Boolean).at(-1) ?? "";
    console.log(`[smoke] 回复: ${JSON.stringify(reply)}`);
    if (!reply) {
      console.error("[smoke] ❌ 未收到助手回复");
      process.exit(1);
    }
    console.log("[smoke] ✅ 主会话真实对话跑通");
  } finally {
    await host.dispose();
    await rm(root, { recursive: true, force: true });
  }
  console.log("[smoke] ✅ C1 验收通过：MainSessionHost + .pi/SYSTEM.md + 真实对话");
}

main().catch((err) => {
  console.error("[smoke] 失败:", err);
  process.exit(1);
});
