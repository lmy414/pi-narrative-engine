# 前端测试轮：数据管道统一 + 共享 schema 校验前端适配（2026-08-11）

> 测试轮文档 · 单轮单文档
> 范围：frontend-demo/api-client.js（updateSummary body 补 entityId）、frontend-demo/app.js（快速事件默认 ID evt- → evt_ 前缀）；连带验证后端写路径改动的前端表现——共享 typebox schema 校验、字段级错误详情、summary 端点路径/body entityId 一致性
> 服务：`node scripts/app-server.mjs --port 7421`（临时项目 `.tmp-frontend-test/proj`，种子 2 实体/1 关系/1 可见性记录）
> 测试方式：browser 实操 + DOM/fetch 取证；截图因环境限制（browser tab not visible）全部失败，本轮证据以 DOM innerText 原文 / fetch 响应 / 服务端落库数据三重佐证

## 产出清单（7 项）

| # | 测试项 | 预期 | 结果 |
|---|--------|------|------|
| T1 | inspector 属性显示（艾莉亚） | 显示 性格=冷静（名字属性按设计剔除） | ✅ 通过（DOM innerText 含「属性/性格/冷静」） |
| T2 | inspector 属性显示（老酒馆） | 「暂无属性」（仅有名字属性，剔除后为空，设计行为） | ✅ 通过（DOM innerText 确认，见 O3） |
| T3 | 可见性设置→撤销（详情抽屉全链路） | 点单元格 setVisibility → toast 成功 + 单元格 ✓；再点 closeVisibility → toast + 单元格 ? | ✅ 通过（服务端记录 validFrom=ch001.ev003 → validTo=ch001.ev003，设置→撤销全链路落库；declId 含中文「名字」URL 编解码无碍） |
| T4 | 关系新建→闭合（全链路） | 新建「朋友」→ 生效中；闭合 → 已闭合 | ✅ 通过（rel-ent_char_aliya-朋友-ent_loc_tavern-ch001.ev003：validFrom=ch001.ev003 → validTo=ch001.ev003 落库；本轮 API 复验 relations/close 端点正常） |
| T5 | 快速事件负向：非法 ID `evt-123` | 400 VALIDATION_ERROR，错误提示含 `/eventId` 字段路径详情；事件不落库 | ✅ 通过（错误文本含 /eventId；/api/events 确认无 evt-123） |
| T6 | 快速事件正向：默认 ID `evt_` 前缀 | 提交成功落库 | ✅ 通过（evt_1786467461330 @ ch001.ev003 落库；修复前默认 evt- 前缀会被新 schema 拒绝） |
| T7 | 摘要编辑（api-client body 带 entityId） | 保存成功、摘要更新、事件落库 | ✅ 通过（evt_summary_ent_char_aliya_... 落库，摘要「测试角色-已编辑」） |

## 缺陷登记

无新增缺陷。上轮实操发现的两处问题（快速事件默认 ID 前缀不合法、summary 端点 entityId 不一致静默覆盖）已于本轮前修复并含在本轮回归证据中（T6/T7）。

## 观察

- O1（环境）：browser_take_screenshot 全部失败（The browser tab is not visible on screen），本轮无截图；证据改用 browser_evaluate DOM 原文 + fetch 响应 + 服务端落库数据三重佐证
- O2（环境）：部分元素坐标点击报 pointer-events:none / outside viewport，改用页面内置入口函数驱动（graphSelectEntity / openEntityDetail / detailTabSwitch / 单元格 click()），与点击路径等价（同一 onclick 入口）
- O3（设计）：inspector 对「名字/name」属性剔除显示（graph.js:252-255 注释：避免与标题 Entity.name 重复），仅有名字属性的实体显示「暂无属性」——设计行为，但首次使用可能困惑；暂不修
- console：three.js 弃用警告、/api/scheduler/status 与 /api/chat/events 501 轮询为既有已知行为，非本轮引入

## 结论

7/7 通过，无新增缺陷。本轮改动（api-client updateSummary 补 entityId、app.js 快速事件 evt_ 前缀、后端共享 schema 校验 + 字段级错误详情 + summary entityId 一致性）在真实浏览器全链路验证通过；中文 declarationId 的 URL 编解码路径（可见性矩阵）验证无碍。临时项目 `.tmp-frontend-test/` 测后删除。
