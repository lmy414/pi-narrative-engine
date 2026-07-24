// tests/e2e-renderer.test.ts
/**
 * 端到端集成测试：渲染器 + 检验工具联合工作流
 *
 * 验证：
 * 1. append 渲染两次事件，章节文件包含两个锚点+正文
 * 2. modify 重写第一个事件，旧文本消失，新文本出现
 * 3. check 检查最新事件，能发现违规
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadRuleSet,
  renderToFile,
  readChapter,
  readChapterSection,
} from "@pi/renderer";
import { checkNarrative } from "../src/checker.ts";
import type { RenderLlmCaller } from "@pi/renderer";

test("e2e: append → append → modify → check 完整流程", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "renderer-e2e-"));
  try {
    // 准备规则集
    await writeFile(
      path.join(dir, "规则集.md"),
      "文风：白描为主\n禁止词：手机、电脑",
      "utf8",
    );

    // Mock LLM：渲染返回固定文本，检验返回固定结果
    const renderLlm: RenderLlmCaller = async (_sys, user) => {
      if (user.includes("林墨进入酒馆")) return "林墨推开酒馆的门，雨丝落在肩上。";
      if (user.includes("赵无极出现")) return "赵无极从内堂走出，端着酒碗。";
      if (user.includes("重写")) return "林墨踏入酒馆，雨水顺着剑鞘滑落。";
      return "默认文本";
    };

    const checkLlm: RenderLlmCaller = async () => {
      return JSON.stringify({
        violations: [],
        suggestions: [],
      });
    };

    const chapterPath = path.join(dir, "正文", "第1章-测试.md");
    const ruleSet = await loadRuleSet(dir);

    // 1. append 第一个事件
    const r1 = await renderToFile(
      {
        mode: "append",
        chapterPath,
        eventId: "evt_001",
        storyTime: "ch-1",
        instruction: "林墨进入酒馆",
        payload: [{ actor: "林墨", action: "进入", target: "酒馆" }],
      },
      { llm: renderLlm, ruleSet },
    );
    assert.ok(r1.ok, "第一次 append 应成功");

    // 2. append 第二个事件
    const r2 = await renderToFile(
      {
        mode: "append",
        chapterPath,
        eventId: "evt_002",
        storyTime: "ch-1",
        instruction: "赵无极出现",
        payload: [{ actor: "赵无极", action: "走出", target: "内堂" }],
      },
      { llm: renderLlm, ruleSet },
    );
    assert.ok(r2.ok, "第二次 append 应成功");

    // 验证文件内容
    const content = await readFile(chapterPath, "utf8");
    assert.ok(content.includes("evt_001"), "应包含第一个事件锚点");
    assert.ok(content.includes("evt_002"), "应包含第二个事件锚点");
    assert.ok(content.includes("林墨推开酒馆的门"), "应包含第一段正文");
    assert.ok(content.includes("赵无极从内堂走出"), "应包含第二段正文");

    // 3. modify 重写第一个事件
    const r3 = await renderToFile(
      {
        mode: "modify",
        chapterPath,
        eventId: "evt_001",
        storyTime: "ch-1",
        instruction: "重写：更细腻",
        payload: [{ actor: "林墨", action: "踏入", target: "酒馆" }],
        modifyAnchorEventId: "evt_001",
      },
      { llm: renderLlm, ruleSet },
    );
    assert.ok(r3.ok, "modify 应成功");

    const contentAfterModify = await readFile(chapterPath, "utf8");
    assert.ok(contentAfterModify.includes("林墨踏入酒馆"), "应包含重写后的文本");
    assert.ok(!contentAfterModify.includes("林墨推开酒馆的门"), "不应包含旧文本");
    assert.ok(contentAfterModify.includes("赵无极从内堂走出"), "第二段应保留");

    // 4. check 最新事件
    const checkResult = await checkNarrative(
      { target: "latest", chapterPath },
      { llm: checkLlm, ruleSet },
    );
    assert.ok(Array.isArray(checkResult.violations), "应返回 violations 数组");
    assert.ok(Array.isArray(checkResult.suggestions), "应返回 suggestions 数组");

    // 5. 验证 readChapterSection 读取区间
    const section = await readChapterSection(chapterPath, "evt_001", "evt_002");
    assert.ok(section.includes("林墨踏入酒馆"), "区间应包含重写后的文本");
    assert.ok(!section.includes("赵无极"), "区间不应包含第二段");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
