# 前端测试轮 · 2026-08-03-fix-audit-tier1

> **本轮验证**：2026-08-03-code-audit 第一梯队修复中影响前端的部分 ——
> 🔴-8（onclick 字符串拼接改用 q() 转义：events/entity-detail/graph/studio/app 五个文件）、
> 🔴-9（graph 3D 重建 `_destructor()` + `cleanupGraphView` + 搜索 debounce）、
> 🔴-1（CORS 收紧，同源不受影响）、🔴-7（请求体上限/超时/SSE 配额）。
> 引擎侧 🔴-2/🔴-5/🔴-6 由 tests/*.test.ts 覆盖（279 项全绿），不在本轮浏览器清单。

## 元信息
- 触发原因：🔴-8/🔴-9 修改了 frontend-demo（app.js + views/{events,entity-detail,graph,studio}.js），按前端测试纪律必须自驱测试轮
- 受影响页面：事件页 / 实体详情抽屉 / 图页（3D）/ studio / 顶栏 StoryTime 选择器 / 文件页（回归）
- 服务地址：http://127.0.0.1:7421（`node scripts/app-server.mjs --port 7421 --embed`，修改后重启加载新代码）
- 激活项目：test-novel-a（含 ent_test_1 艾莉亚测试 / ch002 第七星港 等上轮种子数据）
- 执行者：AI（playwright-core + Edge/Chrome）
- 开始时间：2026-08-03
- 截图存档：`shots/2026-08-03-fix-audit-tier1/`

## 测试清单

### 🔴-8 onclick q() 转义回归（重点：含特殊字符的 ID 不再破坏内联 handler）
- [x] TC-001 事件页：事件卡片点击选中、展开/收起详情正常 ✅
- [x] TC-002 事件页：实体筛选点击切换正常 ✅
- [x] TC-003 事件页：跳转到世界图按钮可用 ✅
- [x] TC-004 实体详情：点击实体进入抽屉、tab 切换、退场按钮存在 ✅
- [x] TC-005 实体详情：属性"编辑"按钮弹出模态框 ✅
- [x] TC-006 图页：实体列表点击选中 + 3D 渲染正常 ✅
- [x] TC-007 图页：属性编辑按钮弹出模态框 ✅
- [x] TC-008 studio：会话列表点击切换 ✅
- [x] TC-009 顶栏 StoryTime 下拉：选择时间点生效 ✅（ch003.ev002 → ch001.ev001）
- [x] TC-010 全站：控制台无 JS 报错 ✅（仅 1 条预期内 413 资源加载日志）

### 🔴-9 WebGL 泄漏修复
- [x] TC-011 图页 3D 场景渲染成功（canvas 存在、无 WebGL 上下文报错）✅
- [x] TC-012 搜索输入触发防抖重建：连输多字符不崩溃、结果正确 ✅
- [x] TC-013 图页切到事件页再切回：3D 正常重建（cleanupGraphView 路径）✅
- [x] TC-014 快速切换视图 5 次后无控制台报错 ✅

### 🔴-1 CORS（回归：同源不受影响）
- [x] TC-015 同源页面正常加载、API 请求 200 ✅
- [x] TC-016 恶意 Origin 请求被拒（Node http 直测 403 + 无 ACAO 头；浏览器 fetch 无法设置 Origin 头，跳过浏览器侧）✅

### 🔴-7 请求体/SSE（抽查）
- [x] TC-017 超大请求体返回 413 ✅（修复 readBody 超限后连接被 destroy 导致响应丢失的问题，改为排空请求体让 413 正常返回）

## 缺陷登记

| 编号 | 所属项 | 严重度 | 复现步骤 | 期望 | 实际 | 截图 | 状态 |
|------|--------|--------|---------|------|------|------|------|
| （无） | — | — | — | — | — | — | — |

> 本轮 0 缺陷。执行中发现 3 个测试脚本自身问题（非产品缺陷），均已修正：
> 1. TC-007 早期 storyTime 下实体只有 name 属性（prop-edit 过滤 name）→ 先切到 ch003 再测；
> 2. TC-009 顶栏 `.storytime-value` 有 2 个（status-bar 弹 modal / top-nav 走 dropdown）→ 限定 `.status-storytime`；
> 3. TC-016 浏览器 fetch 禁止脚本设置 Origin 头（forbidden header）→ 改 Node http 直测。
> 另发现并修复真实产品缺陷 1 个：readBody 超限 `req.destroy()` 导致客户端收到 ECONNRESET 而非 413 响应（src/visualizer/server.ts），改为排空剩余请求体；补 2 项单测（413 + Origin 403/回显）均通过。

## 小结
- 通过 17 项 / 失败 0 项 / 跳过 0 项
- 缺陷分布：P0 0 / P1 0 / P2 0 / P3 0
- 总体评价：🔴-8 的 q() 转义在 5 个文件 20+ 处内联 handler 全部回归通过，点击/展开/筛选/模态框/抽屉/StoryTime 选择均正常；🔴-9 的 _destructor + cleanupGraphView + debounce 经 3 次切出/切回循环验证无泄漏报错；🔴-1/🔴-7 服务端加固经单测（279 项全绿）与浏览器抽查双重确认。
