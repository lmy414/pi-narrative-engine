/**
 * role-tools.ts — 角色池工具域注册
 *
 * 工具清单：
 *   role_interact  角色池串行演绎
 *   role_rule_set  查看角色规则集.md 内容
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { interact as roleInteract, loadRoleRuleSet } from "@pi/role-pool";
import { makeRoleLlmCaller } from "../role-pool-llm.ts";
import { getLlmConfig } from "../llm-config.ts";
import { type SessionState } from "../session-state.ts";

export function registerRoleTools(pi: ExtensionAPI, state: SessionState): void {
  // --------------------------------------------------------------------------
  // 角色池 LLM 配置
  // --------------------------------------------------------------------------

  function getRoleLlmConfig(): { model: string; apiKey: string } {
    return getLlmConfig("role");
  }

  // --------------------------------------------------------------------------
  // role_interact
  // --------------------------------------------------------------------------

  pi.registerTool({
    name: "role_interact",
    label: "Role Interact",
    description:
      "角色池串行演绎：按 cast 顺序逐个调用角色代理 LLM，后动者可见先动者的公开 action（不含 thought/emotion/state_changes）。返回 RoleAgentOutput[]（8 字段）+ 失败记录。调度器据此提取 state_changes 写扩散、投影为 RoleOutput[] 传渲染器。",
    promptSnippet: "角色池演出（串行可见行动，返回结构化输出）",
    parameters: Type.Object({
      eventInstruction: Type.String({ description: "事件指令（自然语言）" }),
      storyTime: Type.String({ description: "故事时间（如 ch-2）" }),
      cast: Type.Array(Type.Object({
        characterId: Type.String({ description: "角色实体 ID" }),
        staticCard: Type.Record(Type.String(), Type.Unknown(), {
          description: "静态层：酒馆角色卡 JSON（name/description/personality 等）",
        }),
        dynamicFacts: Type.Array(Type.Object({
          declarationId: Type.String(),
          entityId: Type.String(),
          property: Type.String(),
          value: Type.Unknown(),
          valueText: Type.Optional(Type.String()),
          modality: Type.Union([
            Type.Literal("fact"),
            Type.Literal("belief"),
            Type.Literal("hypothesis"),
          ]),
          validFrom: Type.String(),
        }), { description: "动态层：角色当前可见的状态声明（调度器通过 world_character_view 预取）" }),
      }), { description: "演员表，按出场顺序排列" }),
    }),
    async execute(_id, params) {
      const { model, apiKey } = getRoleLlmConfig();
      const llm = makeRoleLlmCaller(model, apiKey);
      const ruleSet = await loadRoleRuleSet(state.sessionCwd ?? process.cwd());

      const result = await roleInteract(
        {
          eventInstruction: params.eventInstruction,
          storyTime: params.storyTime,
          cast: params.cast as Parameters<typeof roleInteract>[0]["cast"],
        },
        { llm, ruleSet },
      );

      const text = result.errors.length > 0
        ? `角色池演出完成：${result.outputs.length} 成功，${result.errors.length} 失败`
        : `角色池演出完成：${result.outputs.length} 个角色输出`;
      return {
        content: [{ type: "text", text }],
        details: result,
      };
    },
  });

  // --------------------------------------------------------------------------
  // role_rule_set
  // --------------------------------------------------------------------------

  pi.registerTool({
    name: "role_rule_set",
    label: "Role Rule Set",
    description: "查看当前角色规则集.md 内容。无需参数。",
    promptSnippet: "查看角色规则集内容",
    parameters: Type.Object({}),
    async execute() {
      const ruleSet = await loadRoleRuleSet(state.sessionCwd ?? process.cwd());
      return {
        content: [{ type: "text", text: ruleSet || "（角色规则集.md 不存在或为空）" }],
        details: { ok: true, length: ruleSet.length, exists: ruleSet.length > 0 },
      };
    },
  });
}
