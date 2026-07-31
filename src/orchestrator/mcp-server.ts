// src/orchestrator/mcp-server.ts
/**
 * mcp-server.ts — MCP stdio 包装
 *
 * 依据：docs/plans/2026-07-31-orchestrator-standalone-research.md §5.4
 *
 * 暴露 4 个调度工具（对外标准 API 契约）：
 * - scheduler_dispatch：派发事件（入队即返回 queueId）
 * - scheduler_commit：提交 plan（阶段 2 接线）
 * - scheduler_discard：丢弃 plan（阶段 2 接线）
 * - scheduler_queue_status：队列状态查询
 *
 * 编排器内部工具（retrieval_plan / character_action / ...）**不暴露**给 MCP 主会话
 * （用户澄清：内部工具私有）。
 *
 * 传输：stdio（本地进程调用最简）。阶段 2 视需要补 SSE/HTTP。
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { OrchestratorService } from "./service.ts";

/** 启动 MCP stdio server（阻塞直到 stdin 关闭） */
export async function startMcpServer(service: OrchestratorService): Promise<void> {
  const server = new McpServer({
    name: "narrative-orchestrator",
    version: "0.1.0",
  });

  // 客户端名注入：initialize 握手完成后 getClientVersion() 即填充
  // （SDK server/index.js _oninitialize 存 _clientVersion；getClientVersion 官方读取器）
  // 工具调用发生在握手之后（协议保证），故每次工具调用读取必然有值
  service.attachClientInfoProvider(() => server.server.getClientVersion()?.name);

  server.tool(
    "scheduler_dispatch",
    "调度器派发事件：planner 推导检索计划 → 角色演绎（plan 模式返回；yolo 模式全链路）",
    {
      storyTime: z.string().describe("故事时间（格式 ch{NNN}.ev{NNN}，如 ch009.ev006）"),
      instruction: z.string().describe("事件指令（自然语言）"),
      characterIds: z.array(z.string()).describe("参与角色 ID 列表"),
      executionHints: z.string().optional().describe("执行建议（用户特殊要求）"),
      mode: z.enum(["plan", "yolo"]).optional().describe("调度模式（缺省 plan）"),
      chapterPath: z.string().optional().describe("章节文件路径（缺省时从 storyTime 推断）"),
    },
    async (params) => {
      const result = service.dispatch({
        storyTime: params.storyTime,
        instruction: params.instruction,
        characterIds: params.characterIds,
        executionHints: params.executionHints,
        mode: params.mode,
        chapterPath: params.chapterPath,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  );

  server.tool(
    "scheduler_commit",
    "提交 plan 结果：写扩散 + 渲染（阶段 2 接线后启用）",
    { planId: z.string().describe("scheduler_dispatch 返回的 queueId/planId") },
    async (params) => {
      const result = await service.commit(params.planId);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    "scheduler_discard",
    "丢弃 plan：不写世界图、不渲染（阶段 2 接线后启用）",
    { planId: z.string().describe("scheduler_dispatch 返回的 queueId/planId") },
    async (params) => {
      const result = await service.discard(params.planId);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    "scheduler_queue_status",
    "队列状态查询：队列长度 + 各事件状态（pending/running/done/error）",
    {},
    async () => {
      const result = service.queueStatus();
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
