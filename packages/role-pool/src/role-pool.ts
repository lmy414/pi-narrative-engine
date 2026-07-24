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
 * @returns 成功输出 + 失败记录
 */
export async function interact(
  cmd: InteractCommand,
  ctx: RoleCtx,
): Promise<InteractResult> {
  const outputs: RoleAgentOutput[] = [];
  const errors: { characterId: string; error: string }[] = [];
  const priorActions: PriorAction[] = [];

  for (const member of cmd.cast) {
    try {
      const systemPrompt = buildSystemPrompt(member, ctx.ruleSet);
      const userMessage = buildUserMessage(cmd, member, priorActions);
      const output = await ctx.llm(systemPrompt, userMessage);
      outputs.push(output);

      // 累积公开行动（信息隔离：不含 thought/emotion/state_changes）
      priorActions.push({
        actor: output.actor,
        action: output.action,
        ...(output.target !== undefined ? { target: output.target } : {}),
      });
    } catch (err) {
      errors.push({
        characterId: member.characterId,
        error: err instanceof Error ? err.message : String(err),
      });
      // 跳过失败角色，继续后续角色
    }
  }

  return { outputs, errors };
}
