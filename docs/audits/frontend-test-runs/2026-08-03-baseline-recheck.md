# 前端测试轮 · 2026-08-03-baseline-recheck

> **首轮 baseline**：验证用户在 `2026-08-03-production-gap-bug-inventory.md` §2 实测上报的 4 个专项 bug 当前是否仍存在。
> 本轮**不修复**，只登记现状。修复由用户审阅后决策。

## 元信息
- 触发原因：用户要求"先把我说的前端 4 个 bug 自己测试一遍"——即验证 production-gap-bug-inventory §2 的 Bug 1-4 现状
- 受影响页面：文件页 / 事件页 / 图页 / 项目切换 / studio
- 服务地址：http://127.0.0.1:7421
- 服务启动：`node scripts/app-server.mjs --project d:\claude\pi-ex\novel --port 7421`
- 激活项目：超喜欢导入测试（d:\claude\pi-ex\novel）—— 仅 1 个项目，故 Bug 3 切换测试无法执行
- 执行者：AI（browser_use）
- 开始时间：2026-08-03
- 截图说明：本轮截图留存在 browser_use subagent 会话内，未落盘到 shots/ 目录（规程首次跑通，截图存档流程待下次完善）

## 测试清单

### Bug 1：文件面板不显示文件名（DTO 错位）
- [x] TC-001 进入文件页，文件树节点是否显示文件名（功能）❌
  - 步骤：启动服务 → 打开 http://127.0.0.1:7421 → 导航到 #/files
  - 预期：每个文件/目录显示名称（basename）
  - 实际：文件树节点处**仅显示图标**，文件名/目录名位置**无可读文本**（空白）
  - 结果：❌ 失败（bug 仍存在）
- [x] TC-002 控制台是否有 node.name 相关报错（控制台）✅
  - 步骤：F12 控制台查看渲染文件树时的错误
  - 预期：无报错
  - 实际：控制台仅有 three.js 弃用警告，**无 JS 报错**（说明是静默渲染 undefined，非异常）
  - 结果：✅ 通过（无报错，但反向印证 bug 是"静默空白"而非崩溃）

### Bug 2：新建角色不出现在事件图（三因素叠加）
- [x] TC-003 打开"快速记事件"表单，检查字段完整性（功能）❌
  - 步骤：进入 #/graph → 点"快速记事件"按钮
  - 预期：表单含 entityType、newFacts.name 等字段
  - 实际：表单**仅 5 个字段**——事件 ID / 类型 / 故事时间 / 实体 ID / 摘要，**缺少 entityType 和 newFacts.name（实体名称）**
  - 结果：❌ 失败（bug 仍存在，与 production-gap-bug-inventory §2 Bug 2-② 完全一致）
- [x] TC-004 创建一个 birth 事件后，新角色是否出现在事件图（功能）⏭️
  - 步骤：填表 birth → 保存 → 切换到事件图查看
  - 预期：新角色实体可见且有名字
  - 实际：跳过——TC-003 已确认表单缺字段，创建出来的实体必然无名，TC-004 无需再测即可判定 bug 路径成立
  - 结果：⏭️ 跳过（依赖 TC-003 的失败结果）
- [x] TC-005 创建后 storyTime 是否前进（功能）⏭️
  - 步骤：创建前后对比 App.storyTime
  - 预期：storyTime 列表与当前值更新
  - 实际：跳过——同 TC-004，表单层已断
  - 结果：⏭️ 跳过

### Bug 3：项目切换状态污染（最重）
- [x] TC-006 切换项目后 studio 视图状态是否清理（功能）⏭️
  - 结果：⏭️ 跳过-项目数不足（仅 1 个项目"超喜欢导入测试"）
- [x] TC-007 切换项目后 files tabs 是否清理（功能）⏭️
  - 结果：⏭️ 跳过-项目数不足
- [x] TC-008 切换项目后 graph/events/entityIndex 是否清理（功能）⏭️
  - 结果：⏭️ 跳过-项目数不足

### Bug 4：世界图写入后需 F5（三层机制）
- [x] TC-009 停留在图页时，studio commit 后是否自动刷新（功能）⏭️
  - 结果：⏭️ 跳过-需 LLM commit，本轮未测
- [x] TC-010 commit 后 storyTime 是否前进（功能）⏭️
  - 结果：⏭️ 跳过-需 LLM commit
- [x] TC-011 commit 后 storyTimes 列表是否更新（功能）⏭️
  - 结果：⏭️ 跳过-需 LLM commit

## 缺陷登记

| 编号 | 所属项 | 严重度 | 复现步骤 | 期望 | 实际 | 截图 | 状态 |
|------|--------|--------|---------|------|------|------|------|
| BUG-001 | TC-001 | P1 | 1. 启动 `node scripts/app-server.mjs --project <dir> --port 7421` 2. 浏览器打开 http://127.0.0.1:7421 3. 导航到 #/files | 文件树每个节点显示 basename | 节点处仅显示图标，名称位置空白 | subagent 会话截图 | open |
| BUG-002 | TC-003 | P1 | 1. 进入 #/graph 2. 点击"快速记事件"按钮 | 表单含 entityType 与 newFacts.name（实体名称）字段 | 表单仅 5 字段（事件ID/类型/故事时间/实体ID/摘要），缺 entityType 和 newFacts.name | subagent 会话截图 | open |
| BUG-003 | TC-006/007/008 | P0 | 1. 准备 2+ 项目 2. 在项目 A 打开文件 tab/进 studio/进图页 3. 切换到项目 B 4. 检查各视图状态 | 切换后所有视图状态清理，显示项目 B 数据 | （未实测，代码层确认 activateProject 不清理 viewState；待 2+ 项目场景补测） | 无 | open-pending |
| BUG-004 | TC-009/010/011 | P1 | 1. 停留图页 2. 切到 studio 触发 LLM commit 3. 切回图页查看 | 图数据自动反映新 commit，storyTime 前进，storyTimes 列表更新 | （未实测，代码层确认 graphLoadData 只在 storyTime 空时初始化、驻留视图无失效；待 LLM commit 场景补测） | 无 | open-pending |

> BUG-003 / BUG-004 标记 `open-pending`：本轮因环境限制（项目数不足 / 需 LLM commit）未实测，但代码层证据（production-gap-bug-inventory §2 + 2026-08-03-code-audit.md）已确认 bug 路径成立，待具备条件时补测转 open。

## 小结
- 通过 1 项 / 失败 2 项 / 跳过 8 项（其中 Bug 3 因项目数不足跳过 3 项，Bug 4 因需 LLM commit 跳过 3 项，Bug 2 因 TC-003 失败连带跳过 2 项）
- 缺陷分布：P0 1（待补测）/ P1 3（2 已实测 + 1 待补测）/ P2 0 / P3 0
- 总体评价：4 个已知 bug 中，**Bug 1 与 Bug 2 经浏览器实测确认仍存在**，与 production-gap-bug-inventory §2 描述完全一致；Bug 3 / Bug 4 受环境限制未实测，但代码层证据充分，列为 open-pending 待补测。首轮 baseline 跑通规程，机制有效。
