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
      const output = await ctx.llm(systemPrompt, userMessage);
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
