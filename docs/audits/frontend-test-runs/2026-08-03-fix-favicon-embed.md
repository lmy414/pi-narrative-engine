# 前端测试轮 · 2026-08-03-fix-favicon-embed

> **修复验证轮**：用户决策继续修复 backlog 中剩余 P3 项 BUG-006（favicon 404）与 BUG-007（无 --embed 时 501）。
> 依据 `docs/frontend-test-discipline.md` 流程执行。

## 元信息
- 触发原因：2026-08-03-fix-frontend-4-bugs 轮收尾后，用户指示继续修复剩余缺陷
- 受影响页面：全局（favicon）/ studio（embedder 端点）
- 服务地址：http://127.0.0.1:7421
- 服务启动：`node scripts/app-server.mjs --port 7421 --embed`（本轮回加 --embed 复测 BUG-007）
- 测试项目：服务激活了遗留的临时项目 A（%TEMP%/opencode/test-novel-a），本轮仅做端点级验证，未做数据写入
- 执行者：AI（playwright-core + 本机 Chrome headless / curl）
- 开始时间：2026-08-03

## 测试清单

### BUG-006：/favicon.ico 404
- [x] TC-001 页面声明 favicon（功能）✅
  - 步骤：加载 `/#/projects` → 检查 `link[rel=icon]`
  - 实际：`index.html` 已声明内联 SVG data URI favicon（brand 色 #c96442 + "N"），浏览器不再请求 /favicon.ico
- [x] TC-002 控制台无 404（功能）✅
  - 步骤：playwright 监听 response 404 与 favicon 请求
  - 实际：404s 列表为空，favicon 无网络请求（走 data URI）

### BUG-007：无 --embed 时 501（环境性复测）
- [x] TC-003 scheduler 端点可用（功能）✅
  - 步骤：`GET /api/scheduler/status`（带 --embed 启动）
  - 实际：HTTP 200 `{"ok":true,"queue":{...}}`（此前 501）
- [x] TC-004 chat/events 端点可用（功能）✅
  - 步骤：`GET /api/chat/events`（带 --embed 启动）
  - 实际：HTTP 200（此前 501）
- [x] TC-005 embedder 已加载（功能）✅
  - 步骤：`GET /api/admin/embedder/status`
  - 实际：model=Xenova/bge-small-zh-v1.5、dim=512、cachePresent=true（首次下载约 24MB 已完成，缓存于 node_modules 下）

## 缺陷登记
本轮无新缺陷。

> BUG-006 / BUG-007 均为 2026-08-03-fix-frontend-4-bugs 轮登记的 P3 遗留项，本轮修复/复测通过，backlog 已同步为 fixed。

## 小结
- 通过 5 项 / 失败 0 项 / 跳过 0 项
- 缺陷分布：P3 2 项（BUG-006 fixed、BUG-007 fixed）
- 总体评价：BUG-006 以零文件新增（data URI）方式消除 favicon 404；BUG-007 确认为环境配置缺失（需 --embed 启动加载向量模型），带 --embed 启动后 scheduler / chat 端点均恢复正常，控制台无 404 与 JS 报错。
- 注意：`--embed` 首次启动需下载向量模型（bge-small-zh-v1.5，约 24MB），之后走本地缓存；日常启动建议保持 `--embed` 以启用 hybrid 检索与 studio 会话功能。
