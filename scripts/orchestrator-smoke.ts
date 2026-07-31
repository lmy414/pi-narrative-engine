/**
 * orchestrator-smoke.ts — 阶段 0 最小验证脚本（无 PI 环境跑通真实 LLM 调用）
 *
 * 目标（实现文档 §三）：
 * 1. 验证 @earendil-works/pi-ai 的 getModel / complete / streamSimple
 *    在无 PI 环境下可用（无隐式全局状态）
 * 2. 验证 LlmConfig 抽象：env 配置源 → getModel → complete
 *
 * 运行：
 *   $env:NE_LLM_PROVIDER="deepseek"; $env:NE_LLM_MODEL="deepseek-v4-flash";
 *   $env:NE_LLM_API_KEY="<key>"; npx tsx scripts/orchestrator-smoke.ts
 *
 * 不传 NE_LLM_API_KEY 时使用 DEEPSEEK_API_KEY（兼容现有 demo 脚本约定）。
 */

import { complete, getModel, streamSimple } from "@earendil-works/pi-ai";
import type { KnownProvider } from "@earendil-works/pi-ai";

const provider = (process.env.NE_LLM_PROVIDER ?? "deepseek") as KnownProvider;
const modelName = process.env.NE_LLM_MODEL ?? "deepseek-v4-flash";
const apiKey = process.env.NE_LLM_API_KEY ?? process.env.DEEPSEEK_API_KEY;

if (!apiKey) {
  console.error("[smoke] 缺少 API Key：请设置 NE_LLM_API_KEY（或 DEEPSEEK_API_KEY）环境变量");
  process.exit(1);
}

// getModel 第二参数是字面量 keyof 联合（models.generated.ts），运行时 string 无法静态匹配，
// 且 MODELS 类型不被 pi-ai 的 exports 导出（/models.generated 子路径未声明），
// 因此用 `as never` 断言（never 可赋给任何类型参数）——这是唯一可行入口。
const model = getModel(provider, modelName as never);
console.log(`[smoke] model: ${model.provider}/${model.name} (api=${model.api}, baseUrl=${model.baseUrl})`);

// 1. complete 纯文本调用
const msg = await complete(
  model,
  {
    systemPrompt: "你是阶段 0 验证脚本。",
    messages: [{ role: "user", content: "只回复两个字符：ok", timestamp: Date.now() }],
  },
  { apiKey, maxTokens: 100, temperature: 0 },
);

if (msg.stopReason === "error" || msg.errorMessage) {
  console.error(`[smoke] complete 失败: ${msg.errorMessage ?? msg.stopReason}`);
  process.exit(1);
}
const text = msg.content
  .filter((b): b is { type: "text"; text: string } => b.type === "text")
  .map((b) => b.text)
  .join("");
console.log(`[smoke] complete 回复: ${JSON.stringify(text)}`);

// 2. streamSimple 流式调用（子代理 streamFn 用同一函数，提前验证）
let streamed = "";
const stream = streamSimple(
  model,
  {
    systemPrompt: "你是阶段 0 验证脚本。",
    messages: [{ role: "user", content: "只回复两个字符：ok", timestamp: Date.now() }],
  },
  { apiKey, maxTokens: 100, temperature: 0 },
);
for await (const chunk of stream) {
  if (chunk.type === "text_delta") streamed += chunk.delta;
  else if (chunk.type === "text_end") streamed += chunk.content;
}
console.log(`[smoke] streamSimple 回复: ${JSON.stringify(streamed)}`);

console.log("[smoke] ✅ 阶段 0 验证通过：pi-ai 在无 PI 环境可用（complete + streamSimple + getModel）");
