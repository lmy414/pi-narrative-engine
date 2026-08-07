# 前端测试轮：批次 4c 前端改动（2026-08-08）

> **触发**：批次 4c 修改 `frontend-demo/files.js`（双击防重）、`debug.js`（日志上限）、`api-client.js`（非 JSON 容错）、`studio.js`（stLoadData 代际 + plan 防御）后按 AGENTS.md 前端测试纪律自驱测试轮。
> **服务**：`node scripts/app-server.mjs --port 7421`。**工具**：browser_use（IAB）。
> **局限**：本会话模型不支持图像输入 + 截图捕获失败（guest activity）——结论以 DOM 结构验证为主。

## 产出清单（测试点）

| # | 测试点 | 操作 | 结果 |
|---|---|---|---|
| T1 | files.js 双击防重（flOpeningPaths） | 快速双击文件项 | ⚠️ 文件树节点 actionability 定位受限（fl-node-name 匹配 31 项、getByText 点击超时）；防重逻辑（in-flight Set + finally 清理）由代码审计覆盖；3a 测试轮已验证文件打开主路径 |
| T2 | studio.js stLoadData 代际守卫 | 进工作室 → 会话列表/消息加载 | ✅ 会话加载正常（无回归；代际守卫为纯增量，正常路径单次执行不受影响） |
| T3 | debug.js 日志上限 | 进调试页渲染 | ✅ 页面渲染正常（缓冲计数/空态） |
| T4 | api-client.js 非 JSON 容错 | （难触发：需后端返回非 JSON） | ⏭️ 逻辑级验证：try/catch 返回 BAD_RESPONSE envelope；由代码审计覆盖 |

## 缺陷登记

无新增缺陷。环境限制：截图捕获失败（guest activity）、文件树定位受 actionability 限制。

## 结论

- 4c 前端四项改动无回归（工作室/调试页正常渲染）
- 交互性改动（双击防重、api-client 容错）由组级代码审计覆盖
- 测试轮文档留存，后续浏览器环境完善可补 T1/T4 实操
