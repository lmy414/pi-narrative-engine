# 前端测试轮：🟠-24/25/26/27 交互修复（2026-08-08）

> **触发**：批次 3a 修改 `frontend-demo/views/entity-detail.js`（🟠-24 竞态）、`files.js`（🟠-25 按钮恢复）、`studio.js`（🟠-26 busy 语义）、`graph.js`/`events.js`（🟠-27 空态）后按 AGENTS.md 前端测试纪律自驱测试轮。
> **服务**：`node scripts/app-server.mjs --port 7421`（未加 `--embed`——编排器不可用，环境限制）。
> **工具**：browser_use（IAB）。截图 1 张存 `shots/2026-08-08-session-interactions/`。
> **局限**：本会话模型不支持图像输入——截图 artifact 供人工核验，结论以 DOM 结构验证为主。

## 产出清单（测试点）

| # | 修复点 | 操作路径 | 结果 |
|---|---|---|---|
| T1a | 🟠-27 世界图空态 | 新建并激活空项目 → 进世界图 | ✅ 显示「0 实体 · 0 事件」+「暂无事件」，无 400 toast |
| T1b | 🟠-27 事件链 | 空项目进事件链 | ✅ 正常渲染（注：新建项目被注入 1 个种子事件，storyTimes 非空——真·空分支（storyTimes=[]）由单测 `🟠-27 graphLoadData 空项目` 覆盖） |
| T2 | 🟠-24 快速切换 | 世界图快速连点 ent_char_ailiya → ent_char_luqingzhi | ✅ 详情抽屉最终显示 ent_char_luqingzhi（后点击者胜出） |
| T3 | 🟠-25 保存失败恢复 | 打开番外文件 → 源码编辑触发 dirty → 正文目录改名 → 保存（父目录不存在失败） | ✅ 失败后保存按钮恢复可用（disabled=null）+「未保存」保持（可重试）；错误提示「父目录不存在: 正文」正常显示。环境已恢复（目录改名回） |
| T4 | 🟠-26 busy 语义 | 流式生成中切换会话 | ⏭️ 环境限制：服务未加 `--embed` 无法进入 streaming；busy 语义（切换不被拦截 + mock abort 清 studioBusy）由子代理审计复核通过（含 mock 卡死修复） |

## 缺陷登记

**无新增缺陷**。环境限制 2 项（无 --embed 编排器不可用；模型不支持图像输入）已如实记录，非代码缺陷。

## 结论

- 🟠-24：快速切换竞态修复生效（后点击者胜出；过期响应不落地——含尾部守卫 + visibility 内部守卫，单测 `🟠-24 openEntityDetail 快速切换` 覆盖）
- 🟠-25：真实失败路径（父目录不存在）按钮恢复 + dirty 保持 ✓
- 🟠-27：空项目世界图空态无 400 ✓（真·空分支由单测覆盖）
- 🟠-26：运行时不可达（环境限制），逻辑由审计复核 + 单测（stSwitchSession 移除 busy 拦截、mock abort 清 busy——vm 单测因安全扫描限制未落地，由审计实证）

**代码层验证补充**：`tests/frontend-demo.test.ts` 新增 🟠-24（乱序响应后点击者胜出）与 🟠-27（空 storyTimes 不调 getGraph）单测；后端 🟠-1/6/9/10/11 均有新增测试（serveStatic 穿越、discover 容错、maxDepth 校验等）。
