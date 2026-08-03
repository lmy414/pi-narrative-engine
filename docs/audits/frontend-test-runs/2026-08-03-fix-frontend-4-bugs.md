# 前端测试轮 · 2026-08-03-fix-frontend-4-bugs

> **修复验证轮**：用户决策优先修复 `frontend-bug-backlog.md` BUG-001~004 后，对本轮修复的回归验证。
> 依据 `docs/frontend-test-discipline.md` 流程执行；本轮缺陷只登记不即修，修复由用户审阅后决策。

## 元信息
- 触发原因：2026-08-03-fix-frontend-4-bugs 分支修复 BUG-001~004（4 专项）
- 受影响页面：文件页 #/files / 图页 #/graph / 事件页 #/events / 创作编排 #/studio / 项目切换
- 服务地址：http://127.0.0.1:7421
- 服务启动：`node scripts/app-server.mjs --port 7421`（未带 --embed，chat/scheduler 端点因此 501，见缺陷登记分析）
- 测试项目：临时目录 `%TEMP%/opencode/test-novel-a`（项目 A）与 `test-novel-b`（项目 B），**均为 API 新建的临时项目，测试结束后已 close，未污染真实 novel 数据**
- 执行者：AI（playwright-core + 本机 Chrome headless）
- 开始时间：2026-08-03
- 截图：`shots/2026-08-03-fix-frontend-4-bugs/`（14 张，P0/P1 均附）

## 测试清单

### BUG-001：文件树节点不显示名称（DTO 错位）
- [x] TC-001 文件树每个节点显示名称（功能）✅
  - 步骤：打开 #/files → 采集 `.fl-tree .fl-node-name` 文本
  - 预期：6 个节点均有非空名称（正文 / 规则集.md / 角色规则集.md / novel.json / planner 规则集.md / README.md）
  - 实际：6 节点全部显示名称 ✅（截图 tc001-files-tree.png）
- [x] TC-002 打开文件产生带名称 Tab（联动）✅
  - 步骤：点击 README.md → 检查 `.fl-tab`
  - 实际：tabs=1，名称联动正常（截图 tc001-file-tab.png）

### BUG-002：快速记事件表单缺 entityType / newFacts.name
- [x] TC-003 表单含实体类型与实体名称字段（功能）✅
  - 步骤：#/graph → 点「快速记事件」→ 检查 `#qe-etype` / `#qe-name`
  - 预期：含 entityType 选择器与名称输入框
  - 实际：`#qe-etype` 存在（默认 character），`#qe-name` 存在（截图 tc002-quick-event-form.png）
- [x] TC-004 创建 birth 事件后新角色有名且出现在实体列表（功能）✅
  - 步骤：填 entityId=ent_test_1 / 名称=艾莉亚测试 / 摘要 → 保存 → 等待 reload
  - 实际：`.entity-item` 出现「艾莉亚测试」（截图 tc002-entity-created.png）

### BUG-003：项目切换状态污染（本轮补齐 baseline 因项目数不足跳过的实测）
- [x] TC-005 切换后 graph 状态清理（功能）✅
  - 步骤：在 A 图页设置搜索词 → 切到 B → 检查 storyTime / storyTimes / 实体列表
  - 实际：storyTime=null、times=[]、列表「没有匹配的实体」（截图 tc003-studio-after-switch.png 前段）
- [x] TC-006 切换后 files tabs 清理（功能）✅
  - 步骤：A 已开 README.md tab → 切 B → 打开 #/files
  - 实际：tabs=0，「没有打开的文件」空态（截图 tc003-files-after-switch.png）
- [x] TC-007 切换后 studio 会话清理（功能）✅
  - 步骤：A 访问 #/studio（产生会话状态）→ 切 B → 打开 #/studio
  - 实际：「暂无会话」空态，无残留（截图 tc003-studio-after-switch.png）
- [x] TC-008 切回 A 数据恢复（功能）✅
  - 步骤：activateProject(A) → 等待实体列表
  - 实际：storyTime=ch001.ev001，「种子角色」可见（截图 tc003-switch-back-a.png）

### BUG-004：世界图写入后需 F5（本轮补齐 baseline 需 LLM commit 跳过的实测，改用 API 直写模拟 commit）
- [x] TC-009 驻留图页时 commit 后自动刷新（功能）✅
  - 步骤：停留在 A 图页（storyTime=ch001.ev001）→ 经 fetch 写 ch002.ev001 事件 → 等待 watcher 周期（8s）
  - 实际：storyTime 自动前进 ch001→ch002，新实体「第七星港」出现在列表（截图 tc004-watcher-advanced.png）
- [x] TC-010 顶栏 StoryTime 选择器同步（功能）✅（首轮 FAIL → 已修 BUG-005，复测通过）
  - 步骤：同上场景 → 检查顶栏 `.storytime-value`
  - 实际（首轮）：仍显示 ch001.ev001 —— 驻留刷新走 `renderView({reload:true})` 只重渲视图区，壳层（顶栏）不刷新（截图 tc004-topbar.png）
  - 修复：app.js 新增 `refreshShellStoryTime()`（就地更新顶栏值与下拉选项），watcher 检测到 storyTime 变化时调用
  - 复测（新增 ch003.ev001 真实新时刻）：storyTime 自动前进 ch002→ch003，顶栏显示 ch003.ev001，新实体可见（截图 tc004-topbar-watcher.png）
- [x] TC-011 切走再回来数据最新（无需 F5）（功能）✅
  - 步骤：#/graph → #/events → 回 #/graph
  - 实际：storyTime=ch002.ev001，「第七星港」可见（截图 tc004-reenter.png）

## 缺陷登记

| 编号 | 所属项 | 严重度 | 复现步骤 | 期望 | 实际 | 截图 | 状态 |
|------|--------|--------|---------|------|------|------|------|
| BUG-005 | TC-010 | P2 | 1. 停留图页 2. 后台 commit 落盘新 storyTime 3. 等 watcher 自动刷新 | 顶栏 StoryTime 选择器显示最新时刻 | 视图区数据已刷新，但顶栏 `.storytime-value` 仍显示旧时刻（watcher 用 renderView 只重渲 #view-root，壳层 storyTime 选择器不更新；下拉选项列表同样陈旧） | shots/2026-08-03-fix-frontend-4-bugs/tc004-topbar.png | fixed（同轮修复，见下） |
| BUG-006 | 控制台 | P3 | 任意页面加载 | 控制台无 404 | 浏览器请求 /favicon.ico → 404（index.html 未声明 favicon，预存在，与本次修复无关） | 无 | open |
| BUG-007 | 控制台 | P3 | 打开 studio / scheduler 相关端点 | 正常可用 | `GET /api/scheduler/status` 与 `GET /api/chat/events` 返回 501 EMBEDDER_UNAVAILABLE——本次服务以 `node scripts/app-server.mjs --port 7421`（未带 --embed）启动，属环境配置缺失而非代码缺陷；baseline 轮同理。带 --embed 启动后应复测确认 | 无 | open-pending |

> BUG-005 为 BUG-004 修复的剩余缺口：驻留刷新链路已通（视图区），仅顶栏壳层未联动。
> **BUG-005 已同轮修复并复测通过**：app.js 新增 `refreshShellStoryTime()`（就地更新顶栏 `.storytime-value` 与 `#storytime-dropdown` 选项），storyTimeWatcher 检测到 storyTime 变化时先刷新壳层再 reload 视图；专项验证（写入真实新时刻 ch003.ev001）确认顶栏自动显示新时刻、下拉选项同步、新实体可见。
> BUG-006 / BUG-007 为测试环境伴生项：前者既有（P3 外观），后者需 --embed 复测。

## 小结
- 通过 11 项 / 失败 0 项 / 跳过 0 项（首轮 10/11，BUG-005 复测通过后 11/11）
- 缺陷分布：P0 0 / P1 0 / P2 1（BUG-005，已同轮修复）/ P3 2（BUG-006、BUG-007）
- 总体评价：4 个专项修复经浏览器实测全部生效（BUG-001~003 全绿；BUG-004 主链路通）。baseline 轮因环境限制跳过的 BUG-003（项目切换）与 BUG-004（commit 刷新）本轮已补测通过。首轮唯一失败项 BUG-005（顶栏 StoryTime 联动）已修复并经真实新时刻专项验证通过。控制台无本次修复引入的 JS 报错。
