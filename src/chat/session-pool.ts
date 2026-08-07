// src/chat/session-pool.ts
/**
 * session-pool.ts — 多 session 并存池（后台生成核心）
 *
 * 依据：docs/plans/2026-08-05-background-generation-execution.md §4.2.1
 *
 * 职责：
 * - 管理多个 MainSessionHost 实例（每个绑定一个 PI session，独立存活）
 * - 维护 activeId 指针（切换会话 = 改指针，不 dispose 旧 host）
 * - 跟踪每个 session 的 status（idle/streaming/error）
 *
 * 关键约束：
 * - switchActive 不调 PI switchSession（那会 dispose 旧 session 硬中断生成）
 * - 旧 host 保持存活，生成继续在后台跑
 * - 池上限由 LRU 策略管理（当前实现：无上限，调用方负责释放）
 */
import type { MainSessionHost } from "./main-session.ts";

export type SessionStatus = "idle" | "streaming" | "error";

/** 🟡（2026-08-08）：池上限（超过时 LRU 淘汰最旧非活跃 handle） */
export const MAX_SESSIONS = 10;

export interface SessionHandle {
  /** sessionId（PI session.id） */
  id: string;
  /** 主会话宿主（独立 runtime，独立 services） */
  host: MainSessionHost;
  /** 当前状态（streaming 时前端显示 spinner，禁止同会话重复发送） */
  status: SessionStatus;
  /** 最近错误（status=error 时填充） */
  lastError?: string;
  /** 创建时间戳 */
  createdAt: number;
  /** 最后更新时间戳 */
  updatedAt: number;
}

/**
 * 多 session 并存池
 *
 * 不负责创建 host（由 ChatContext 创建后注入），只管理生命周期与状态。
 */
export class SessionPool {
  private readonly handles = new Map<string, SessionHandle>();
  private activeId: string | null = null;

  /** 当前活跃 session handle（无活跃返回 null） */
  getActive(): SessionHandle | null {
    if (!this.activeId) return null;
    return this.handles.get(this.activeId) ?? null;
  }

  /** 当前活跃 sessionId */
  get activeSessionId(): string | null {
    return this.activeId;
  }

  /** 按 id 获取 handle */
  get(id: string): SessionHandle | null {
    return this.handles.get(id) ?? null;
  }

  /** 是否存在指定 session */
  has(id: string): boolean {
    return this.handles.has(id);
  }

  /**
   * 按 id 或唯一前缀匹配池中 handle（🟠-4 2026-08-08）
   *
   * 精确匹配优先；前缀匹配不唯一返回 null（与 ChatContext.resolveSessionPath
   * 磁盘侧语义一致）。activateSession 用它避免前缀命中时重开同一会话文件
   * 并裸覆盖旧 handle（旧 host 泄漏 + 双写）。
   */
  match(id: string): SessionHandle | null {
    const exact = this.handles.get(id);
    if (exact) return exact;
    let hit: SessionHandle | null = null;
    for (const [sid, handle] of this.handles) {
      if (sid.startsWith(id)) {
        if (hit) return null; // 前缀不唯一
        hit = handle;
      }
    }
    return hit;
  }

  /** 所有 handle（按 createdAt 升序） */
  getAll(): SessionHandle[] {
    return Array.from(this.handles.values()).sort((a, b) => a.createdAt - b.createdAt);
  }

  /** 后台生成中的 session（非活跃且 status=streaming） */
  getBackgroundStreaming(): SessionHandle[] {
    return this.getAll().filter((h) => h.id !== this.activeId && h.status === "streaming");
  }

  /** 注入 handle（创建后由 ChatContext 调用） */
  set(handle: SessionHandle): void {
    this.handles.set(handle.id, handle);
    // 🟡（2026-08-08）：池上限 LRU 淘汰——超过 MAX_SESSIONS 时淘汰最旧的
    // 非活跃 handle（streaming 后台生成中的不淘汰），防止长期运行只增不减
    // （此前无上限，每个 session 一个完整 runtime）；被淘汰 handle 的 host
    // 在此 dispose（仅淘汰 idle/error 的，不中断生成）
    if (this.handles.size > MAX_SESSIONS) {
      // 🟡 审计修正：淘汰候选必须排除刚插入的 handle——池满且受保护
      // （活跃+streaming）≥9 时，新 handle 是唯一可淘汰项，会被自身 set 立即
      // 淘汰并 dispose，随后 setActive 抛「session 不存在」（POST /api/chat/sessions 500）
      const evictable = this.getAll()
        .filter((h) => h.id !== this.activeId && h.id !== handle.id && h.status !== "streaming")
        .sort((a, b) => a.createdAt - b.createdAt);
      for (const victim of evictable) {
        if (this.handles.size <= MAX_SESSIONS) break;
        this.handles.delete(victim.id);
        void victim.host.dispose().catch(() => {
          // dispose 失败不阻塞池操作
        });
      }
    }
  }

  /** 切换活跃指针（不 dispose 旧 host，生成继续后台） */
  setActive(id: string): void {
    if (!this.handles.has(id)) {
      throw new Error(`SessionPool.setActive: session ${id} 不存在`);
    }
    this.activeId = id;
  }

  /** 更新 session 状态 */
  updateStatus(id: string, status: SessionStatus, lastError?: string): void {
    const handle = this.handles.get(id);
    if (!handle) return;
    handle.status = status;
    if (lastError !== undefined) handle.lastError = lastError;
    handle.updatedAt = Date.now();
  }

  /** 移除并返回 handle（调用方负责 dispose host） */
  remove(id: string): SessionHandle | null {
    const handle = this.handles.get(id);
    if (!handle) return null;
    this.handles.delete(id);
    if (this.activeId === id) {
      this.activeId = null;
    }
    return handle;
  }

  /** 清空池（调用方负责 dispose 所有 host） */
  clear(): void {
    this.handles.clear();
    this.activeId = null;
  }

  /** 池大小 */
  get size(): number {
    return this.handles.size;
  }
}
