// src/agents/rules-tools.ts
/**
 * rules-tools.ts — 规则渐进披露 AgentTool（v3 D11 定案，2026-08-09）
 *
 * Skill 式渐进披露（对齐 pi SDK `<available_skills>` 模式）：
 * - 渲染器子代理提示词只列规则清单（名称+位置+简介），不全文注入
 * - 渲染器按需调用 rules_read 读取 规则集/ 下文件全文
 *
 * 安全：规则名 → 相对路径由模块内清单常量映射（LLM 只传 StringEnum 枚举规则名），
 * 无任意路径输入；读取前再做根目录边界校验（resolve + startsWith，纵深防御）。
 */

import { Type, StringEnum, type Static } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { promises as fs } from "node:fs";
import path from "node:path";

const SEQUENTIAL = { executionMode: "sequential" as const };

/** 规则集文件夹（v3 定案：规则集/） */
const RULESET_DIR = "规则集";

/** 规则清单（名称 → 相对路径 + 默认简介；LLM 只可见枚举名） */
const RULE_MANIFESTS = [
  {
    name: "文风规则",
    rel: path.join(RULESET_DIR, "文风规则.md"),
    summary: "作者文风约定（渲染前建议读取）",
  },
  {
    name: "检查规则",
    rel: path.join(RULESET_DIR, "检查规则.md"),
    summary: "文本校验规则（render_check 用）",
  },
  {
    name: "自定义规则",
    rel: path.join(RULESET_DIR, "自定义规则.md"),
    summary: "自定义规则（用户/代理可写，可扩展）",
  },
] as const;

export interface RuleManifest {
  name: string;
  rel: string;
  summary: string;
  exists: boolean;
}

/**
 * 解析规则文件绝对路径并校验落在项目根内
 *
 * relPath 只能是模块内常量（规则集/ 下文件名）；resolve + 根目录边界校验
 * 为纵深防御（防 `..` 越出项目根）。
 */
function resolveRulePath(cwd: string, relPath: string): string {
  if (path.isAbsolute(relPath)) {
    throw new Error(`非法规则文件路径（须为相对路径）: ${JSON.stringify(relPath)}`);
  }
  const root = path.resolve(cwd);
  const filePath = path.resolve(cwd, relPath);
  if (filePath !== root && !filePath.startsWith(root + path.sep)) {
    throw new Error(`规则文件越界（须在项目根内）: ${JSON.stringify(filePath)}`);
  }
  return filePath;
}

/** 列规则清单：扫描规则集/ 目录，文件存在性 + 首行标题作简介（渐进披露元数据） */
export async function listRules(cwd: string): Promise<RuleManifest[]> {
  const results: RuleManifest[] = [];
  for (const m of RULE_MANIFESTS) {
    const filePath = resolveRulePath(cwd, m.rel);
    try {
      const content = await fs.readFile(filePath, "utf8");
      const firstLine = (content.split("\n").find((l) => l.trim()) ?? "").trim();
      const summary =
        firstLine.replace(/^#+\s*/, "").slice(0, 60) || m.summary;
      results.push({ ...m, exists: true, summary });
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") {
        results.push({ ...m, exists: false, summary: m.summary });
      } else {
        throw err;
      }
    }
  }
  return results;
}

/**
 * 渲染 <available_rules> 渐进披露清单（元数据入 system prompt，全文按需读取）
 *
 * 对齐 pi SDK skills 披露格式：名称 + 位置 + 简介 + 引导语，
 * 不注入全文（D11 定案：渲染器按需读取）。
 */
export async function formatRulesManifest(cwd: string): Promise<string> {
  const rules = await listRules(cwd);
  const lines = rules.map((r) =>
    `- <rule><name>${r.name}</name><rel>${r.rel}</rel><summary>${
      r.exists ? r.summary : "(文件未创建)"
    }</summary></rule>`,
  );
  return [
    "<available_rules>",
    "项目规则文件以渐进披露方式提供：以下是可用规则清单（名称+位置+简介）。",
    "开始写作前按需调用 rules_read 读取相关规则全文（如文风规则），严格遵守；不要臆测规则内容。",
    ...lines,
    "</available_rules>",
  ].join("\n");
}

const rulesReadParams = Type.Object({
  rule: StringEnum(["文风规则", "检查规则", "自定义规则"], {
    description: "要读取的规则名（来自 <available_rules> 清单）",
  }),
});

/** rules_read 工具：读取规则集/ 下规则文件全文（cwd 为项目根） */
export function createRulesReadTool(cwd: string): AgentTool<typeof rulesReadParams> {
  return {
    name: "rules_read",
    label: "Rules Read",
    description:
      "读取项目规则文件全文（渐进披露：先看 <available_rules> 清单，按需读取对应规则）。参数 rule 为清单中的规则名。",
    parameters: rulesReadParams,
    ...SEQUENTIAL,
    async execute(_id, params: Static<typeof rulesReadParams>) {
      // StringEnum 枚举校验保证 manifest 恒命中（无任意路径输入）
      const manifest = RULE_MANIFESTS.find((m) => m.name === params.rule);
      const rel = manifest!.rel;
      const filePath = resolveRulePath(cwd, rel);
      try {
        const content = await fs.readFile(filePath, "utf8");
        return {
          content: [{ type: "text", text: content }],
          details: { rule: params.rule, rel, exists: true, length: content.length },
        };
      } catch (err: unknown) {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") {
          return {
            content: [{ type: "text", text: `（规则文件不存在：${rel}）` }],
            details: { rule: params.rule, rel, exists: false, length: 0 },
          };
        }
        throw err;
      }
    },
  };
}
