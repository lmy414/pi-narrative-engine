# 前端测试轮：新建工程 UI 逻辑补全（2026-08-09）

> 日期：2026-08-09
> 触发：用户报告「无法新建工程（前端UI的逻辑不完全）」+「前端没有创建并激活的UI按钮」
> 修改：`frontend-demo/app.js`（createProject 成功后入列）+ `frontend-demo/views/projects.js`（空态默认展开新建表单）
> 服务：`node scripts/app-server.mjs --project D:/claude/pi-ex/novel --port 7421 --embed`
> 状态：✅ 已跑完

## 定位（两处交互缺陷，功能后端本身完整）

1. **「创建并激活」按钮默认不可见**：新建表单用 `.form-body { max-height: 0 }` 折叠（CSS），「创建并激活」按钮在折叠面板里**默认被裁剪隐藏**——可访问性树快照仍会列出按钮（所以 AI 能"看到"并点击成功），但视觉上用户看不到入口。
2. **新建项目不进「我的项目」列表**：列表数据源是纯扫描结果（`scannedProjects`，按 scanRoots 目录扫描）。新建的项目若在扫描根外（如 `Desktop\AI工程\`）**永远扫不到**——用户创建后回项目页列表仍显示「还没有项目」，误以为创建失败。

## 修复

- `projects.js newProjectFormHtml`：`projectsList()` 为空时表单默认加 `expanded` + chevron `rotated`（空态直接看到表单与按钮）
- `app.js createProject`：成功后把新项目 push 进 `App.viewState.scannedProjects`（去重），立即出现在「我的项目」列表（含"已激活"标记）

## 产出清单

| # | 测试项 | 操作 | 预期 | 结果 |
|---|---|---|---|---|
| 1 | 空态表单展开 | 项目页（0 项目） | 表单默认展开，「创建并激活」按钮可见 | ✅ PASS |
| 2 | 折叠交互 | 点「创建新项目」头部 | 展开/收起正常切换 | ✅ PASS |
| 3 | 创建成功入列 | 填表创建澪与佑莉 → 回项目页 | 「我的项目」显示新卡（已激活） | ✅ PASS（修复前列表为空） |
| 4 | 创建幂等 | 重复创建同目录 | 不报错，后端模板跳过已存在文件 | ✅ PASS |
| 5 | 新项目空态 | 创建后进 #/graph | 0 实体空态正常渲染（🟠-27） | ✅ PASS |
| 6 | 全套件回归 | npm test | 全绿 | ✅ PASS |

## 截图

`docs/audits/frontend-test-runs/shots/2026-08-09-wg-render-debug/05-projects-create-ui.png`（展开表单 + 澪与佑莉 项目卡）

## 缺陷登记

无新增。本轮修复的 2 处即用户报告对象。遗留观察（非本轮范围）：「我的项目」列表是运行时内存态（scannedProjects），刷新后扫描根外的项目消失——如需持久化"最近项目"可评估 app-config launcher 记忆（登记待议）。

## 汇总

6/6 通过。两处缺陷修复并验证：空态表单默认展开（按钮可见）+ 创建后立即入列（用户不再"以为创建失败"）。
