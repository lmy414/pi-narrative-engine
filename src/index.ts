/**
 * index.ts — narrative-engine 的 pi 扩展入口（V2）
 *
 * 职责（重构后只保留装配）：
 * - session_start 时初始化 WorldGraph / Embedder / Search / DebugBus
 * - 注册 31 个工具到 6 个工具域文件（src/tools/*.ts）
 * - session_shutdown 时关闭 WorldGraph 与可视化服务
 * - 管理 session 级 currentStoryTime
 * - before_agent_start 注入 memory.md
 * - resources_discover 贡献 skills/ 目录给 pi skill 加载机制
 *
 * 工具清单（共 31 个，分 6 域）：
 *   world_*        18 个 — src/tools/world-tools.ts
 *   render_*        5 个 — src/tools/render-tools.ts
 *   role_*          2 个 — src/tools/role-tools.ts
 *   scheduler_*     3 个 — src/tools/scheduler-tools.ts
 *   import_*        2 个 — src/tools/import-tools.ts
 *   open_visualizer 1 个 — src/tools/visualizer-tools.ts
 *
 * 存储路径：<cwd>/.pi/world-graph-v3/
 *
 * 主会话不参与叙事原则：
 * - 工具只暴露世界图 CRUD 与检索，不内置剧情生成逻辑
 * - 剧情推进由 scheduler 通过 scheduler_dispatch 调用
 */

import path from "node:path";
import { promises as fs, existsSync } from "node:fs";
import url from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WorldGraph } from "@pi/world-graph";
import { Embedder } from "./embedder.ts";
import { Search } from "./search.ts";
import {
  type SessionState,
  createSessionState,
  resolveWorldGraphDir,
} from "./session-state.ts";
import { loadAllPlans } from "@pi/scheduler";
import { loadMemory, updateMemory, latestStoryTime } from "./memory.ts";
import { createDebugBus } from "./debug/bus.ts";
import { registerWorldTools } from "./tools/world-tools.ts";
import { registerRenderTools } from "./tools/render-tools.ts";
import { registerRoleTools } from "./tools/role-tools.ts";
import { registerSchedulerTools } from "./tools/scheduler-tools.ts";
import { registerImportTools } from "./tools/import-tools.ts";
import { registerVisualizerTool } from "./tools/visualizer-tools.ts";

// ============================================================================
// 模块级状态（每次 session_start 重建字段）
// ============================================================================

const state: SessionState = createSessionState();

/**
 * Skills 资源目录（2026-07-28 抽离自主会话 prompt 注入）
 *
 * 设计变更：
 * - 旧方案（before_agent_start 拼接 systemPrompt）：main-session.md / engine-guide.md
 *   强制注入 systemPrompt 末尾，每轮必可见
 * - 新方案（pi skill 机制）：把两段内容改为 SKILL.md 格式，通过 resources_discover
 *   贡献 skillPaths 给 pi；pi 按其 skill 加载机制（progressive disclosure）只把
 *   name + description 注入 systemPrompt 的 <available_skills> 段，LLM 按需 read
 *   加载完整 SKILL.md 内容
 * - 项目记忆 memory.md 仍保留 before_agent_start 强制注入（每轮重读，放 systemPrompt
 *   末尾注意力最强位），不走 skill 机制
 *
 * 注意：skills/ 由 build.mjs 复制到 dist/skills/，sync.mjs 同步到扩展目录后
 * 由 pi 在 resources_discover 阶段扫描。
 */
const SKILLS_DIR = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "skills");

/** 测试辅助：获取内部状态 */
export function getState() {
  return state;
}

// ============================================================================
// 入口
// ============================================================================

export default function (pi: ExtensionAPI) {
  // --------------------------------------------------------------------------
  // 生命周期：session_start
  // --------------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    state.sessionCwd = ctx.cwd;
    const dir = resolveWorldGraphDir(ctx.cwd);
    await fs.mkdir(dir, { recursive: true });
    state.wg = await WorldGraph.create({
      dbPath: path.join(dir, "world.db"),
      eventLogPath: path.join(dir, "events.jsonl"),
    });
    state.embedder = new Embedder();
    state.search = new Search(state.wg, state.embedder);
    state.currentStoryTime = null;
    // 创建调试事件总线（容量 2000，环形缓冲）
    // 若环境变量 PI_DEBUG=off 则禁用（零开销）
    state.debugBus = process.env.PI_DEBUG === "off" ? null : createDebugBus(2000);

    // 跨会话恢复 storyTime 锚点（2026-07-25 项目记忆）
    // pi 无跨会话记忆，session 内存状态全部重建；世界图是持久真相，
    // 从事件日志恢复最大 storyTime，避免新会话失去时间锚点。
    try {
      state.currentStoryTime = await latestStoryTime(state.wg);
      // 记忆文件自愈：事件存在但 memory.md 缺失（老项目/被删）时重建
      const existing = await loadMemory(ctx.cwd);
      if (state.currentStoryTime && !existing) {
        await updateMemory(state.wg, ctx.cwd);
      }
    } catch (err) {
      ctx.ui.notify(`[narrative-engine] 恢复 storyTime/记忆文件失败: ${err}`, "warning");
    }

    ctx.ui.notify(`[narrative-engine] 已初始化世界图: ${dir}`, "info");

    // 恢复未 commit 的 plan（Pending Gap #6 持久化）
    // 同时执行 TTL 清理：1 小时前的 plan 自动删除
    try {
      const loaded = await loadAllPlans(ctx.cwd);
      if (loaded > 0) {
        ctx.ui.notify(`[narrative-engine] 已恢复 ${loaded} 个未提交的 plan`, "info");
      }
    } catch (err) {
      ctx.ui.notify(`[narrative-engine] 加载 plan 缓存失败: ${err}`, "warning");
    }

    // main-session / engine-guide 已改为 SKILL.md 由 pi skill 机制加载
    // （见 resources_discover 事件），session_start 不再读盘
    if (existsSync(SKILLS_DIR)) {
      ctx.ui.notify(`[narrative-engine] skills 目录已就绪: ${SKILLS_DIR}`, "info");
    } else {
      ctx.ui.notify(`[narrative-engine] skills 目录缺失（构建或同步异常）`, "warning");
    }
  });

  // --------------------------------------------------------------------------
  // 项目记忆注入（memory.md，每轮强制可见）
  // --------------------------------------------------------------------------
  //
  // 设计变更（2026-07-28）：
  // - 旧方案在 before_agent_start 拼接 main-session.md + engine-guide.md + memory.md
  // - 新方案：main-session / engine-guide 改为 SKILL.md 由 pi skill 机制加载
  //   （见 resources_discover 事件），保留 memory.md 强制注入 systemPrompt 末尾
  //
  // memory.md 仍走 before_agent_start 的理由：
  // - 每轮会被 commit / world_event_apply 等写入路径更新，必须拿最新内容
  // - 文件很小，读盘开销可忽略
  // - 放 systemPrompt 末尾（注意力最强位），与项目记忆"权威源"定位一致
  pi.on("before_agent_start", async (event) => {
    if (!state.sessionCwd) return;
    const memory = await loadMemory(state.sessionCwd);
    if (!memory) return;
    return { systemPrompt: event.systemPrompt + "\n\n" + memory };
  });

  // --------------------------------------------------------------------------
  // 资源发现：贡献 skills/ 目录给 pi skill 加载机制
  // --------------------------------------------------------------------------
  //
  // 通过 resources_discover 事件把 SKILLS_DIR 注册到 pi。
  // pi 启动时扫描该目录下的 SKILL.md 文件，把每个 skill 的 name + description
  // 注入 systemPrompt 的 <available_skills> 段（progressive disclosure）。
  // LLM 按需 read 加载完整 SKILL.md 内容。
  //
  // 详见 pi 文档：pi-ex/packages/coding-agent/docs/skills.md
  // 与 pi-ex/packages/coding-agent/docs/extensions.md#resources_discover
  pi.on("resources_discover", async () => {
    return { skillPaths: [SKILLS_DIR] };
  });

  // --------------------------------------------------------------------------
  // 生命周期：session_shutdown
  // --------------------------------------------------------------------------

  pi.on("session_shutdown", async () => {
    if (state.visualizerServer) {
      try {
        state.visualizerServer.close();
      } catch {
        // 忽略关闭错误
      }
      state.visualizerServer = null;
    }
    if (state.wg) {
      try {
        state.wg.close();
      } catch {
        // 忽略关闭错误
      }
    }
    state.wg = null;
    state.embedder = null;
    state.search = null;
    state.currentStoryTime = null;
    state.sessionCwd = null;
    state.debugBus = null;
  });

  // --------------------------------------------------------------------------
  // 工具注册：6 个域
  // --------------------------------------------------------------------------

  registerWorldTools(pi, state);
  registerRenderTools(pi, state);
  registerRoleTools(pi, state);
  registerSchedulerTools(pi, state);
  registerImportTools(pi, state);
  registerVisualizerTool(pi, state);
}
