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

/**
 * 订阅指定工具的产出提交
 *
 * @param agent 目标子代理
 * @param toolName 产出提交工具名（retrieval_plan / character_action / ...）
 * @returns promise 产出（tool_execution_end.details）+ dispose 取消订阅
 */
export function collectSubmission<T>(
  agent: Agent,
  toolName: string,
): { promise: Promise<T>; dispose: () => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  let done = false;
  const off = agent.subscribe((event) => {
    if (done) return;
    if (event.type === "tool_execution_end" && event.toolName === toolName) {
      if (event.isError) {
        done = true;
        reject(new Error(`${toolName} 工具执行失败`));
        return;
      }
      done = true;
      resolve(event.result?.details as T);
    } else if (event.type === "agent_end" && !done) {
      done = true;
      reject(new Error(`${toolName} 未提交产出（agent 已终止）`));
    }
  });

  return { promise, dispose: off };
}
