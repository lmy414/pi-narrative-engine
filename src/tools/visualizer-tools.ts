/**
 * visualizer-tools.ts — 可视化工具域注册
 *
 * 工具清单：
 *   open_visualizer  启动 world-graph 可视化服务
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { startVisualizer } from "../visualizer/server.ts";
import { type SessionState, requireWg } from "../session-state.ts";

export function registerVisualizerTool(pi: ExtensionAPI, state: SessionState): void {
  pi.registerTool({
    name: "open_visualizer",
    label: "Open Visualizer",
    description:
      "启动 world-graph 可视化服务（幂等：已启动则直接返回现有 URL）。可选 port 参数，缺省 7421。",
    promptSnippet: "启动世界图可视化页面",
    parameters: Type.Object({
      port: Type.Optional(Type.Number()),
    }),
    async execute(_id, params) {
      const g = requireWg(state);
      type Details = {
        ok: boolean;
        url?: string;
        port?: number;
        alreadyRunning?: boolean;
        error?: string;
      };
      if (state.visualizerServer) {
        const details: Details = {
          ok: true,
          url: state.visualizerServer.url,
          port: state.visualizerServer.port,
          alreadyRunning: true,
        };
        return {
          content: [{ type: "text", text: `可视化服务已在运行: ${state.visualizerServer.url}` }],
          details,
        };
      }
      try {
        state.visualizerServer = await startVisualizer({
          wg: g,
          search: state.search,
          ...(params.port !== undefined ? { port: params.port } : {}),
          // 注入调试总线：未创建时传 null，前端 /api/debug/* 返回 503
          ...(state.debugBus ? { debugBus: state.debugBus } : {}),
        });
      } catch (err) {
        const message = `可视化服务启动失败：${(err as Error).message}（可尝试更换 port 参数）`;
        const details: Details = { ok: false, error: message };
        return {
          content: [{ type: "text", text: message }],
          details,
        };
      }
      const details: Details = {
        ok: true,
        url: state.visualizerServer.url,
        port: state.visualizerServer.port,
        alreadyRunning: false,
      };
      return {
        content: [{ type: "text", text: `可视化服务已启动: ${state.visualizerServer.url}` }],
        details,
      };
    },
  });
}
