/**
 * cache.ts — plan 结果的 session 级缓存 + 持久化
 *
 * 设计决策（2026-07-25 解决 Pending Gap #6 + #9）：
 * - 内存 Map 是热路径，避免每次 getPlan 读盘
 * - 文件持久化作为冷路径，进程重启后可恢复未 commit 的 plan
 * - 存储路径：<cwd>/.pi/scheduler-plans/<planId>.json
 * - 写入时机：setPlan 同步写文件（plan 数据量小，性能可接受）
 * - 删除时机：deletePlan / discard / commit 时同步删文件
 * - TTL 清理：1 小时未 commit 的 plan 自动清理（loadAllPlans 时执行）
 *
 * session 边界：
 * - 单个 pi 进程内一个全局 Map（模块级单例）
 * - 进程重启后通过 loadAllPlans(cwd) 从磁盘恢复（session_start 时调用）
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { PlanResult } from "./types.ts";

/** plan TTL（1 小时，单位毫秒） */
const PLAN_TTL_MS = 60 * 60 * 1000;

/** plan 持久化目录名（相对 cwd） */
const PLANS_DIRNAME = path.join(".pi", "scheduler-plans");

/**
 * 全局 plan 缓存（模块级单例，内存热路径）
 */
const planCache = new Map<string, PlanResult>();

/**
 * 持久化目录绝对路径（loadAllPlans 后才可用，其他函数需先调用 loadAllPlans）
 */
let plansDir: string | null = null;

/**
 * 解析 plan 持久化目录路径
 *
 * @param cwd 工作目录
 * @returns 持久化目录绝对路径
 */
function resolvePlansDir(cwd: string): string {
  return path.join(cwd, PLANS_DIRNAME);
}

/**
 * plan 文件路径
 *
 * @param planId plan ID
 * @returns plan 文件绝对路径（plansDir 必须已初始化）
 */
function planFilePath(planId: string): string {
  if (!plansDir) {
    throw new Error("plan cache not initialized (call loadAllPlans first)");
  }
  // planId 已含时间戳和随机后缀，作为文件名安全
  // 但仍做基础校验，防止路径穿越
  if (!/^[a-zA-Z0-9_-]+$/.test(planId)) {
    throw new Error(`invalid planId: ${planId}`);
  }
  return path.join(plansDir, `${planId}.json`);
}

/**
 * 写入 plan 到磁盘（持久化）
 *
 * 失败时不抛错（避免影响主流程），仅打印警告
 * 理由：内存缓存已生效，磁盘失败只是进程重启后无法恢复
 *
 * @param plan plan 结果
 */
async function persistPlan(plan: PlanResult): Promise<void> {
  if (!plansDir) return; // 未初始化（如单测直接调 setPlan），跳过持久化
  try {
    const filePath = planFilePath(plan.planId);
    const content = JSON.stringify(plan, null, 2);
    await fs.writeFile(filePath, content, "utf8");
  } catch (err) {
    console.warn(`[scheduler] persistPlan 失败（不影响内存缓存）:`, err);
  }
}

/**
 * 从磁盘删除 plan 文件
 *
 * 失败时不抛错（避免影响 commit/discard 主流程）
 *
 * @param planId plan ID
 */
async function removePlanFile(planId: string): Promise<void> {
  if (!plansDir) return;
  try {
    const filePath = planFilePath(planId);
    await fs.unlink(filePath);
  } catch (err) {
    // 文件不存在视为已删除（幂等性）
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return;
    console.warn(`[scheduler] removePlanFile 失败（不影响内存缓存）:`, err);
  }
}

/**
 * 从磁盘加载所有 plan 到内存（session_start 时调用）
 *
 * 同时执行 TTL 清理：
 * - 1 小时未 commit/discard 的 plan 自动删除（Pending Gap #9）
 * - 加载时按 createdAt 排序，便于调试
 *
 * @param cwd 工作目录
 * @returns 已加载的 plan 数量
 */
export async function loadAllPlans(cwd: string): Promise<number> {
  plansDir = resolvePlansDir(cwd);

  // 创建目录（如不存在）
  await fs.mkdir(plansDir, { recursive: true });

  // 扫描所有 .json 文件
  const entries = await fs.readdir(plansDir);
  const planFiles = entries.filter((name) => name.endsWith(".json"));

  const now = Date.now();
  let loaded = 0;

  for (const fileName of planFiles) {
    const filePath = path.join(plansDir, fileName);
    try {
      const content = await fs.readFile(filePath, "utf8");
      const plan = JSON.parse(content) as PlanResult;

      // TTL 检查：超过 1 小时的 plan 自动删除
      if (now - plan.createdAt > PLAN_TTL_MS) {
        await fs.unlink(filePath).catch(() => {});
        continue;
      }

      // 加载到内存
      planCache.set(plan.planId, plan);
      loaded++;
    } catch (err) {
      // 解析失败的文件跳过（不抛错，避免阻塞 session_start）
      console.warn(`[scheduler] 加载 plan 失败 ${fileName}:`, err);
      // 损坏文件移到 .corrupt 后缀，避免反复尝试
      try {
        await fs.rename(filePath, `${filePath}.corrupt`);
      } catch {
        // 忽略
      }
    }
  }

  return loaded;
}

/**
 * 写入 plan 结果到缓存（同步内存 + 异步磁盘）
 *
 * @param planId plan ID
 * @param result plan 结果
 */
export function setPlan(planId: string, result: PlanResult): void {
  planCache.set(planId, result);
  // 异步持久化（不阻塞主流程；失败仅警告）
  void persistPlan(result);
}

/**
 * 取出 plan 结果
 *
 * @param planId plan ID
 * @returns plan 结果，不存在返回 undefined
 */
export function getPlan(planId: string): PlanResult | undefined {
  return planCache.get(planId);
}

/**
 * 删除 plan 结果（commit 后或 discard 时调用）
 *
 * 同步删除内存，异步删除磁盘文件
 *
 * @param planId plan ID
 * @returns 是否删除成功（不存在返回 false）
 */
export function deletePlan(planId: string): boolean {
  const existed = planCache.delete(planId);
  if (existed) {
    void removePlanFile(planId);
  }
  return existed;
}

/**
 * 丢弃 plan：不写世界图、不渲染
 *
 * 主会话检查 RoleAgentOutput[] 后觉得不对劲时调用。
 * 设计文档 §3.3 discard 函数的对外接口。
 *
 * @param planId plan ID
 * @returns 是否丢弃成功（不存在返回 false）
 */
export function discard(planId: string): boolean {
  return deletePlan(planId);
}

/**
 * 清空所有 plan 缓存（仅供单测用）
 *
 * 生产环境不应调用——会丢失所有未 commit 的 plan。
 * 不删除磁盘文件（单测可单独调用 removePlansDir 清理）
 */
export function resetPlanCache(): void {
  planCache.clear();
  // 单测时不重置 plansDir，允许下次 setPlan 仍能持久化（验证用）
}

/**
 * 删除所有持久化文件 + 清空内存（单测辅助）
 *
 * 生产环境不应调用
 *
 * @param cwd 工作目录
 */
export async function removePlansDir(cwd: string): Promise<void> {
  const dir = resolvePlansDir(cwd);
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // 忽略
  }
  planCache.clear();
}

/**
 * 当前缓存的 plan 数量（仅供调试/单测断言）
 */
export function planCacheSize(): number {
  return planCache.size;
}
