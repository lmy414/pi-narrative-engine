/**
 * memory.ts — 跨会话项目记忆（2026-07-25 新增）
 *
 * 背景：pi 本体无跨会话记忆，session_start 会重建扩展全部内存状态
 * （currentStoryTime 丢失、对话上下文丢失）。本模块把叙事工作记忆
 * 沉淀到小说工程内的 memory.md，由 before_agent_start 注入 systemPrompt，
 * 实现跨会话记忆当前的叙事内容。
 *
 * 文件位置：<cwd>/.pi/world-graph-v3/memory.md（与 events.jsonl 同目录，
 * 属于引擎运行时数据，自动维护，请勿手改；每次写入事件后全量重建）
 *
 * 内容：
 * - 当前 storyTime（所有事件中的最大故事时间）
 * - storyTime 格式约定（ch{NNN}.ev{NNN}，见文件头注释常量）
 * - 在场角色（最近事件涉及的实体，解析 name Fact 得角色名）
 * - 最近事件（按 storyTime 分组，含用户口述原文 userInput）
 *
 * 写入时机：scheduler_commit 后 / world_event_apply 后 /
 * session_start 自愈（事件存在但 memory.md 缺失时重建）。
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { WorldGraph, EventRecord } from "@pi/world-graph";

/**
 * storyTime 格式约定（全项目唯一权威定义）：
 * - `ch{NNN}`：章节号，3 位零填充（ch009 = 第 9 章）
 * - `.ev{NNN}`：当前章节内的事件序号，3 位零填充（ch009.ev006 = 第 9 章第 6 个事件）
 * - 同章内推进：ev +1（ch009.ev006 → ch009.ev007）
 * - 进入新章：ch +1、ev 从 001 重新开始（ch009.ev007 → ch010.ev001）
 * - 零填充保证字典序 == 故事时序（世界图全部时态比较都是字符串比较）
 */
export const STORY_TIME_CONVENTION =
  "storyTime 约定：ch{NNN}=章节号（3 位零填充），.ev{NNN}=章内事件序号（3 位零填充）；" +
  "同章内推进 ev+1，进新章 ch+1 且 ev 从 001 重新开始；字典序即故事时序。";

/** 最近事件展示条数（按 storyTime 分组后的组数） */
const RECENT_EVENT_GROUPS = 10;

/** memory.md 路径：<cwd>/.pi/world-graph-v3/memory.md（与 events.jsonl 同目录） */
export function resolveMemoryPath(cwd: string): string {
  return path.join(cwd, ".pi", "world-graph-v3", "memory.md");
}

/** 读取项目记忆（文件缺失/读取失败时返回空字符串，不抛错） */
export async function loadMemory(cwd: string): Promise<string> {
  try {
    return await fs.readFile(resolveMemoryPath(cwd), "utf-8");
  } catch {
    return "";
  }
}

/** 所有事件中的最大 storyTime（零填充格式下字典序 == 时序）；无事件返回 null */
export async function latestStoryTime(wg: WorldGraph): Promise<string | null> {
  const events = await wg.getAllEvents();
  if (events.length === 0) return null;
  let max = events[0].storyTime;
  for (const e of events) {
    if (e.storyTime > max) max = e.storyTime;
  }
  return max;
}

/**
 * 角色名消解：取实体在 storyTime 时刻的 name Fact，失败回退 entityId
 */
async function resolveName(
  wg: WorldGraph,
  entityId: string,
  storyTime: string,
): Promise<string> {
  try {
    const snap = await wg.getEntityAt(entityId, storyTime);
    const nameFact = snap?.properties.find((p) => p.property === "name");
    if (nameFact) return `${String(nameFact.value)}（${entityId}）`;
  } catch {
    // 消解失败不阻断记忆生成
  }
  return entityId;
}

/**
 * 全量重建 memory.md
 *
 * @param wg 世界图实例
 * @param cwd 小说工程目录
 */
export async function updateMemory(wg: WorldGraph, cwd: string): Promise<void> {
  const events = await wg.getAllEvents();
  const latest = await latestStoryTime(wg);
  if (!latest) return; // 空项目不生成记忆文件

  // 按 storyTime 分组（保持事件日志顺序，组内聚合实体与口述原文）
  const groups = new Map<string, { entityIds: Set<string>; userInput?: string }>();
  for (const e of events) {
    let g = groups.get(e.storyTime);
    if (!g) {
      g = { entityIds: new Set() };
      groups.set(e.storyTime, g);
    }
    collectEntityIds(e, g.entityIds);
    if (e.userInput && !g.userInput) g.userInput = e.userInput;
  }

  // 最近 N 组（storyTime 降序，新→旧）
  const recentTimes = Array.from(groups.keys()).sort().reverse().slice(0, RECENT_EVENT_GROUPS);

  // 在场角色 = 最近事件涉及的全部实体
  const involved = new Set<string>();
  for (const t of recentTimes) {
    for (const id of groups.get(t)!.entityIds) involved.add(id);
  }

  // 名字消解（并行，失败回退 entityId）
  const names = new Map<string, string>();
  await Promise.all(
    Array.from(involved).map(async (id) => {
      names.set(id, await resolveName(wg, id, latest));
    }),
  );

  const lines: string[] = [
    "# 项目记忆（narrative-engine 自动维护，请勿手改）",
    "",
    `> ${STORY_TIME_CONVENTION}`,
    "",
    `- 当前 storyTime: \`${latest}\``,
    `- 最近更新: ${new Date().toISOString()}`,
    "",
    "## 在场角色（最近事件涉及）",
    "",
    ...Array.from(involved).map((id) => `- ${names.get(id) ?? id}`),
    "",
    "## 最近事件（新→旧）",
    "",
    ...recentTimes.map((t) => {
      const g = groups.get(t)!;
      const actors = Array.from(g.entityIds)
        .map((id) => names.get(id) ?? id)
        .join("、");
      const oral = g.userInput ? `｜口述："${g.userInput}"` : "｜（无口述记录）";
      return `- \`${t}\`｜${actors}${oral}`;
    }),
    "",
  ];

  const memoryPath = resolveMemoryPath(cwd);
  await fs.mkdir(path.dirname(memoryPath), { recursive: true });
  await fs.writeFile(memoryPath, lines.join("\n"), "utf-8");
}

/** 从事件记录收集涉及的 entityId（本体 + newFacts 里的） */
function collectEntityIds(e: EventRecord, out: Set<string>): void {
  if (e.entityId) out.add(e.entityId);
  for (const f of e.newFacts ?? []) {
    if (f.entityId) out.add(f.entityId);
  }
}
