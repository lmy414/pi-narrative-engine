// src/agents/collect.ts
/**
 * collect.ts — 子代理产出收集助手
 *
 * 编排器订阅 Agent 生命周期事件，从 `tool_execution_end`（types.ts:417）提取
 * 产出提交工具返回的 `details` 结构化数据。
 *
 * 已查证（2026-07-31）：AgentEvent.tool_execution_end 携带 `result`（含 details），
 * `agent_end` 是最后一个事件；若 agent 结束仍未提交产出，视为失败。
 *
 * 用法：
 *   const { promise, dispose } = collectSubmission<RetrievalPlan>(agent, "retrieval_plan");
 *   await agent.prompt(...);
 *   const plan = await promise;   // 等 agent 终止后拿到产出
 *   dispose();
 */

import type { Agent } from "@earendil-works/pi-agent-core";

/** 取 agent 最后一条 LLM 错误（assistant stopReason=error 的 errorMessage，如 "402 Insufficient Balance"） */
function lastAgentLlmError(agent: Agent): string | undefined {
  const messages = (((agent as { state?: { messages?: unknown[] } }).state?.messages) ?? []) as Array<{
    role?: string;
    stopReason?: string;
    errorMessage?: string;
  }>;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "assistant" && (m.errorMessage || m.stopReason === "error")) {
      return m.errorMessage || "LLM 调用失败";
    }
  }
  return undefined;
}

/**
 * 订阅指定工具的产出提交
 *
 * @param agent 目标子代理
 * @param toolName 产出提交工具名（retrieval_plan / character_action / ...）
 * @param timeoutMs 产出收集超时（默认 180s；超时 reject，防止子代理挂死时编排永久悬挂）
 * @returns promise 产出（tool_execution_end.details）+ dispose 取消订阅
 */
export function collectSubmission<T>(
  agent: Agent,
  toolName: string,
  timeoutMs = 180_000,
): { promise: Promise<T>; dispose: () => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // 工具事件可能在 agent.prompt() 返回前同步 reject。调用方要等 prompt 结束后
  // 才 await 产出，因此先附加 observer，避免 Node 将这段窗口判为未处理 rejection。
  void promise.catch(() => {});

  let done = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(`${toolName} 产出收集超时（${timeoutMs}ms）`));
    }, timeoutMs);
    // 不做 unref：node 22 的 node:test 在事件循环被 unref 清空后判定
    // "Promise resolution is still pending" 提前终止（CI 实测）；调用方
    // 总是 await 产出，真实运行中事件循环不会因该定时器被拖住。
  }
  const off = agent.subscribe((event) => {
    if (done) return;
    if (event.type === "tool_execution_end" && event.toolName === toolName) {
      if (event.isError) {
        done = true;
        reject(new Error(`${toolName} 工具执行失败`));
        return;
      }
      done = true;
      // M-Qual-1：details 缺失时显式 reject（此前静默 resolve undefined，
      // 下游 Cannot read properties of undefined 难定位）
      const details = event.result?.details;
      if (details === undefined) {
        reject(new Error(`${toolName} 产出缺少 details（tool_execution_end 无 result.details）`));
        return;
      }
      resolve(details as T);
    } else if (event.type === "agent_end" && !done) {
      done = true;
      // 附带底层 LLM 错误（如 402 余额不足）：旧文案只有「agent 已终止」，
      // 排障时看不到真实原因（agent 首问即被 LLM 错误终结，无任何产出）
      const llmError = lastAgentLlmError(agent);
      reject(new Error(llmError
        ? `${toolName} 未提交产出（agent 已终止）：${llmError}`
        : `${toolName} 未提交产出（agent 已终止）`));
    }
  });

  return {
    promise,
    dispose: () => {
      if (timer) clearTimeout(timer);
      off();
    },
  };
}
