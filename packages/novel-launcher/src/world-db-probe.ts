// packages/novel-launcher/src/world-db-probe.ts
/**
 * world-db-probe.ts — world.db 轻量探测（discoverProjects 的 stats/needsMigration 数据源）
 *
 * 迁移判定口径（重要，不自造）：underworld-graph 的 schema 版本判定是
 * typegraph 的 schema diff（getSchemaChanges/assertSchemaCurrent），不是裸版本号；
 * 引擎侧的既有口径是 ProjectRegistry 捕获 WorldGraph.create 抛出的
 * MIGRATION_ERROR。本模块复用同一口径：探测 = 尝试 create，抛 MIGRATION_ERROR
 * 即 needsMigration=true。直接读 typegraph 内部表属于自造口径，不做。
 *
 * 副作用说明：WorldGraph.create 会执行幂等 DDL（IF NOT EXISTS）与 WAL pragma，
 * 与项目激活路径完全一致；EventLog 构造无 IO（仅 append 时写文件）。
 *
 * db 不存在/打不开/其他错误：stats=null、needsMigration=false（扫描不阻断）。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { WorldGraph } from "underworld-graph";
import type { NovelProjectMeta } from "./types.ts";

/** 单个项目的 world.db 探测结果 */
export interface WorldDbProbe {
  /** 激活时会抛 MIGRATION_REQUIRED（WorldGraph.create 抛 MIGRATION_ERROR） */
  needsMigration: boolean;
  /** 实体/事件计数（db 不可用或需迁移时为 null） */
  stats: { entityCount: number; eventCount: number } | null;
}

/** 探测项目 world.db（只读语义；失败不抛错） */
export async function probeWorldDb(
  projectDir: string,
  meta: NovelProjectMeta,
): Promise<WorldDbProbe> {
  const graphDir = join(projectDir, meta.worldGraphDir);
  const dbPath = join(graphDir, "world.db");
  if (!existsSync(dbPath)) {
    return { needsMigration: false, stats: null };
  }

  let wg: WorldGraph | null = null;
  try {
    wg = await WorldGraph.create({ dbPath, eventLogPath: join(graphDir, "events.jsonl") });
  } catch (err) {
    const code = (err as Error & { code?: string }).code;
    if (code === "MIGRATION_ERROR") {
      return { needsMigration: true, stats: null };
    }
    return { needsMigration: false, stats: null };
  }

  try {
    // 与 /api/status 同一口径：最新 storyTime 的实体数 + 全部事件数
    const storyTimes = await wg.listStoryTimes();
    const latest = storyTimes[storyTimes.length - 1];
    const entities = latest ? await wg.getAllEntities(latest) : [];
    const events = await wg.getAllEvents();
    return {
      needsMigration: false,
      stats: { entityCount: entities.length, eventCount: events.length },
    };
  } catch {
    return { needsMigration: false, stats: null };
  } finally {
    wg.close();
  }
}
