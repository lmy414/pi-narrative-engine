/**
 * project-registry.ts — 多项目世界图注册表（unified-server 用）
 *
 * 解决：visualizer server 启动时绑定单个 WorldGraph 实例，应用化后
 * 项目管理页需要多项目切换。注册表按目录缓存已打开的项目句柄
 * （wg + search + meta），同时只有一个活跃项目，世界图 / files / admin
 * 路由全部从 getActive() 取上下文。
 *
 * 设计依据：docs/plans/2026-07-29-app-architecture-design.md §11.4
 *
 * 内存纪律：句柄缓存无上限（项目数很小）；closeProject / closeAll 负责
 * 释放 wg。非活跃项目保持打开以支持快速切回——若未来项目数膨胀再加 LRU。
 */
import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { WorldGraph } from "underworld-graph";
import type { MigrateResult } from "underworld-graph";
import { getProjectMeta } from "@pi/novel-launcher";
import type { NovelProjectMeta } from "@pi/novel-launcher";
import { Search } from "../search.ts";
import type { Embedder } from "../embedder.ts";

/** 已打开项目的句柄 */
export interface ProjectHandle {
  /** 项目目录绝对路径 */
  dir: string;
  /** novel.json 元信息 */
  meta: NovelProjectMeta;
  /** 世界图实例 */
  wg: WorldGraph;
  /** 检索实例（无 embedder 时 fulltext 仍可用） */
  search: Search;
  /** 无 embedder 时为 true（/api/search 强制 fulltext） */
  forceFulltext: boolean;
}

/** 注册表统一错误 */
export class RegistryError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "RegistryError";
    this.code = code;
  }
}

export interface ProjectRegistryOptions {
  /**
   * 可选的共享 embedder（所有项目共用一个实例，避免重复加载模型）。
   * 缺省时所有项目 forceFulltext。
   */
  embedder?: Embedder | null;
}

export class ProjectRegistry {
  private readonly handles = new Map<string, ProjectHandle>();
  private activeDir: string | null = null;
  private readonly embedder: Embedder | null;

  constructor(options?: ProjectRegistryOptions) {
    this.embedder = options?.embedder ?? null;
  }

  /**
   * 打开项目（幂等：已打开则直接返回缓存句柄）
   *
   * 新建项目（无 world.db）在 options.allowInit=true 时自动初始化空库，
   * 使「新建项目 → 激活 → 创作」闭环不依赖先在 PI 里跑过引擎。
   *
   * @throws RegistryError NOVEL_JSON_NOT_FOUND / WORLD_DB_NOT_FOUND / MIGRATION_REQUIRED
   */
  async openProject(dir: string, options?: { allowInit?: boolean }): Promise<ProjectHandle> {
    const abs = resolve(dir);
    const cached = this.handles.get(abs);
    if (cached) return cached;

    let meta: NovelProjectMeta;
    try {
      meta = await getProjectMeta(abs);
    } catch (err) {
      throw new RegistryError(
        `项目未找到 novel.json: ${abs}（${(err as Error).message}）`,
        "NOVEL_JSON_NOT_FOUND",
      );
    }

    const dbDir = join(abs, meta.worldGraphDir);
    const dbPath = join(dbDir, "world.db");
    if (!existsSync(dbPath)) {
      if (!options?.allowInit) {
        throw new RegistryError(
          `世界图数据库不存在: ${dbPath}（请先在 PI 会话中运行过叙事引擎）`,
          "WORLD_DB_NOT_FOUND",
        );
      }
      // 新建项目：WorldGraph.create 会初始化空库 schema（目录需先建好）
      console.log(`[registry] 新项目初始化空世界图: ${dbPath}`);
      await mkdir(dbDir, { recursive: true });
    }

    let wg: WorldGraph;
    try {
      wg = await WorldGraph.create({
        dbPath,
        eventLogPath: join(dbDir, "events.jsonl"),
      });
    } catch (err) {
      const e = err as Error & { code?: string };
      if (e.code === "MIGRATION_ERROR") {
        throw new RegistryError(
          `项目数据库 schema 过旧，需要迁移: ${e.message}`,
          "MIGRATION_REQUIRED",
        );
      }
      throw err;
    }
    const handle: ProjectHandle = {
      dir: abs,
      meta,
      wg,
      search: new Search(wg, this.embedder as Embedder),
      forceFulltext: this.embedder === null,
    };
    this.handles.set(abs, handle);
    return handle;
  }

  /**
   * 迁移项目数据库 schema（先备份 world.db，再执行 typegraph migrateSchema）
   *
   * 适用：openProject 报 MIGRATION_REQUIRED 的项目。迁移成功后项目即可激活。
   *
   * @returns 迁移前后版本号 + 备份文件路径
   */
  async migrateProject(dir: string): Promise<MigrateResult & { backupPath: string }> {
    const abs = resolve(dir);
    if (this.handles.has(abs)) {
      throw new RegistryError("项目当前处于打开状态，请先关闭再迁移", "PROJECT_OPEN");
    }
    const meta = await getProjectMeta(abs);
    const dbDir = join(abs, meta.worldGraphDir);
    const dbPath = join(dbDir, "world.db");
    if (!existsSync(dbPath)) {
      throw new RegistryError(`世界图数据库不存在: ${dbPath}`, "WORLD_DB_NOT_FOUND");
    }
    const backupPath = `${dbPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await copyFile(dbPath, backupPath);
    const result = await WorldGraph.migrate({
      dbPath,
      eventLogPath: join(dbDir, "events.jsonl"),
    });
    return { ...result, backupPath };
  }

  /** 当前活跃项目（未设置时为 null） */
  getActive(): ProjectHandle | null {
    return this.activeDir ? (this.handles.get(this.activeDir) ?? null) : null;
  }

  /** 当前活跃项目目录（未设置时为 null） */
  getActiveDir(): string | null {
    return this.activeDir;
  }

  /**
   * 切换活跃项目（未打开则先打开）
   *
   * options.allowInit：新建项目无 world.db 时自动初始化空库（激活场景默认开启，
   * 见 routes-ext 的 /api/projects/activate）
   *
   * @throws RegistryError 同 openProject
   */
  async setActive(dir: string, options?: { allowInit?: boolean }): Promise<ProjectHandle> {
    const handle = await this.openProject(dir, options);
    this.activeDir = handle.dir;
    return handle;
  }

  /**
   * 关闭项目并释放 wg。关闭活跃项目时活跃指针置空。
   * 未打开的项目调用为 no-op。
   */
  async closeProject(dir: string): Promise<void> {
    const abs = resolve(dir);
    const handle = this.handles.get(abs);
    if (!handle) return;
    this.handles.delete(abs);
    if (this.activeDir === abs) this.activeDir = null;
    try {
      handle.wg.close();
    } catch {
      // 忽略关闭错误
    }
  }

  /** 已打开项目列表（供状态展示） */
  listOpen(): Array<{ dir: string; name: string; active: boolean }> {
    return [...this.handles.values()].map((h) => ({
      dir: h.dir,
      name: h.meta.name,
      active: h.dir === this.activeDir,
    }));
  }

  /** 关闭全部项目（服务关闭时调用） */
  async closeAll(): Promise<void> {
    for (const dir of [...this.handles.keys()]) {
      await this.closeProject(dir);
    }
  }
}
