# 前端测试轮 · 2026-08-04-remove-old-ui

> **本轮验证**：旧版前端 `visualizer-ui/` 整目录删除后的伺服链路冒烟——
> `src/visualizer/server.ts`（resolveDefaultUiDir 移除回退候选）、`src/app/main.ts`
> （uiDir 探测移除 visualizer-ui 兜底）、`scripts/package-sidecar.mjs`（打包复制
> frontend-demo）改动后，unified-server 仍正确伺服 frontend-demo。

## 元信息
- 触发原因：visualizer-ui 删除 + 伺服引用改动（main.ts / server.ts），按前端测试纪律冒烟验证
- 服务地址：http://127.0.0.1:7421（`node scripts/app-server.mjs --port 7421`，删除后重启加载新代码）
- 执行者：AI（playwright-core + Edge，脚本 `%TEMP%\opencode\pwt\smoke-remove-old-ui.js`）
- 截图存档：`shots/2026-08-04-remove-old-ui/`

## 测试清单（7/7 通过）

- [x] TC-001 首页加载（200，内容渲染）✅
- [x] TC-002 事件页渲染（.ev-event-card）✅
- [x] TC-003 图页渲染（.entity-item）✅
- [x] TC-004 文件页渲染（.fl-doc）✅
- [x] TC-005 设置页渲染（.set-main）✅
- [x] TC-006 全站 0 JS 错误 ✅
- [x] TC-007 无失败请求 ✅

## 缺陷登记

| 编号 | 严重度 | 摘要 | 状态 |
|------|--------|------|------|
| （无） | — | — | — |

## 小结
- 通过 7 项 / 失败 0 项
- visualizer-ui 删除后伺服链路无回归；frontend-utils.test.ts（测试对象 proto-utils.js 已删）
  一并清理，其 renderMarkdown XSS 风险面由 frontend-demo `flRenderMarkdown` 的
  「整体转义 + 无 URL 渲染」设计消解（见 2026-08-03-code-audit.md L-Test-2 标注）。
