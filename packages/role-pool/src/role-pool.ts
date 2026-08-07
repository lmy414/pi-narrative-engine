/**
 * role-pool.ts — 核心串行编排
 *
 * 职责：
 * - 按 cast 顺序逐个调用 LLM（串行可见行动模型）
 * - 后动者收到先动者的公开 action（不含 thought/emotion/state_changes）
 * - 单角色失败时跳过，记录 errors，不中断后续角色
 *
 * 无状态：不碰世界图、不写文件。所有状态由调用方（RoleCtx）传入。
 */

import type {
  CastMember,
  InteractCommand,
  InteractHooks,
  InteractResult,
  PriorAction,
  RoleAgentOutput,
  RoleCtx,
} from "./types.ts";
import { buildSystemPrompt, buildUserMessage } from "./prompts.ts";

// ============================================================================
// LLM 调用超时与重试（🟠-19 2026-08-08）
// ============================================================================

/** 单次角色 LLM 调用超时——LLM 挂起时整条串行角色链会被无限阻塞，本上限兜底 */
const TURN_TIMEOUT_MS = 60_000;
/** 最大尝试次数（1 次原始 + 2 次重试） */
const MAX_ATTEMPTS = 3;
/** 重试退避（指数）：第 1 次重试等 300ms，第 2 次等 900ms */
const RETRY_DELAYS_MS = [300, 900];

/** 错误分类：限流 / 网络抖动 / 超时视为可重试的瞬时失败；其余（余额、key 无效等）不重试 */
function isRetryable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /429|rate\s*limit|too\s*many|限流|配额|ECONNRESET|ETIMEDOUT|fetch\s*failed|timeout|超时|暂时|temporar|network|网络/i.test(msg);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} 超时（${ms}ms）`));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * 带超时与错误分类重试的 LLM 调用
 *
 * - 超时后底层调用无法取消（RoleLlmCaller 无 abort 承载点），结果被丢弃，
 *   但串行链不再被无限阻塞
 * - 瞬时失败（限流/网络）指数退避重试，最多 3 次；最终失败原样抛给
 *   interact 的 per-role catch（记入 errors，不阻断后续角色）
 */
async function callLlmWithRetry(
  llm: RoleCtx["llm"],
  systemPrompt: string,
  userMessage: string,
  characterId: string,
): Promise<RoleAgentOutput> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await delay(RETRY_DELAYS_MS[attempt - 1]!);
    try {
      return await withTimeout(
        llm(systemPrompt, userMessage),
        TURN_TIMEOUT_MS,
        `角色 ${characterId} LLM 调用`,
      );
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS - 1 && isRetryable(err)) continue;
      throw err;
    }
  }
  throw lastErr;
}

/**
 * 串行编排：按 cast 顺序逐个调用 LLM
 *
 * @param cmd 调用命令（事件指令 + 演员表）
 * @param ctx 调用上下文（LLM 调用器 + 规则集）
 * @param hooks 调试钩子（可选，逐角色回调，见 types.ts#InteractHooks）
 * @returns 成功输出 + 失败记录
 */
export async function interact(
  cmd: InteractCommand,
  ctx: RoleCtx,
  hooks?: InteractHooks,
): Promise<InteractResult> {
  const outputs: RoleAgentOutput[] = [];
  const errors: { characterId: string; error: string }[] = [];
  const priorActions: PriorAction[] = [];

  let turnIndex = 0;
  for (const member of cmd.cast) {
    const token = hooks?.onTurnStart?.(member, turnIndex++);
    try {
      // 透传 executionHints 到 system prompt（让角色也遵守用户特殊要求）
      const systemPrompt = buildSystemPrompt(member, ctx.ruleSet, cmd.executionHints);
      const userMessage = buildUserMessage(cmd, member, priorActions);
      // 🟠-19：单次调用超时 + 瞬时失败重试（此前裸 await ctx.llm，LLM 挂起
      // 时整条串行链无限阻塞、瞬时失败角色整场缺席且事件已消耗无法重跑）
      const output = await callLlmWithRetry(ctx.llm, systemPrompt, userMessage, member.characterId);
      outputs.push(output);

      // 累积公开行动（信息隔离：不含 thought/emotion/state_changes）
      priorActions.push({
        actor: output.actor,
        action: output.action,
        ...(output.target !== undefined ? { target: output.target } : {}),
      });
      hooks?.onTurnEnd?.(token, member, { output });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      errors.push({ characterId: member.characterId, error });
      hooks?.onTurnEnd?.(token, member, { error });
      // 跳过失败角色，继续后续角色
    }
  }

  return { outputs, errors };
}
