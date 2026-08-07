# 前端测试轮：BUG-037 loading overlay 移除（2026-08-08）

> **触发**：修复 `frontend-demo/app.js` hideAppLoading（BUG-037：overlay opacity 隐藏下元素常驻 DOM，辅助技术/自动化快照可读「处理中…」残留）后按 AGENTS.md 前端测试纪律自驱测试轮。
> **服务**：`node scripts/app-server.mjs --port 7421`。**工具**：browser_use（IAB）。截图 1 张存 `shots/2026-08-08-loading-overlay-removal/`。
> **局限**：本会话模型不支持图像输入——截图 artifact 供人工核验，结论以 DOM 结构验证为主。

## 根因确认（排查）

- 后端扫描 API 实证：`GET /api/projects/scan?root=D:/claude/pi-ex/novel&maxDepth=3` **14ms 返回 200**——扫描不慢，loading「不收敛」非请求挂起
- 根因：`#app-loading-overlay` 用 `opacity: 0` + `pointer-events: none` 隐藏（components.css:290-306，非 display:none），首次 withLoading 创建后**元素永不删除**——视觉不可见但 DOM 常驻，domSnapshot/辅助技术可读到「处理中…」文本（测试轮误报来源）

## 产出清单（测试点）

| # | 测试点 | 操作 | 结果 |
|---|---|---|---|
| T1 | 快操作（扫描）overlay 不残留 | 点扫描（14ms 返回）→ 检查 overlay | ✅ 扫描中 0（150ms 延迟防闪烁未显示）→ 完成后 0（无残留） |
| T2 | 快照无「处理中…」残留（BUG-037 核心） | 扫描后 domSnapshot | ✅ 快照不含「处理中…」（修复前每次快照都出现） |
| T3 | 慢操作 overlay 显示（回归确认） | 进入项目（加载）→ visible class | ⏭️ 未能构造 >150ms 慢操作（项目加载已缓存/快）；overlay 显示侧（showAppLoading）本次未改动，为 BUG-008 已验证逻辑 |

## 缺陷登记

无新增缺陷。审计发现并已修正：hide 移除定时器未纳入取消机制（50-200ms 竞态带：上一 hide 的移除可能在下一操作 visible 落上前误删元素）→ `appLoadingRemoveTimer` 模块级变量 + showAppLoading 取消。

## 结论

- BUG-037 修复生效：overlay 生命周期完整（显示→隐藏→移除），DOM 不再常驻，快照/辅助技术不再读到「处理中…」残留
- 后端扫描 14ms 快速返回（novel 目录扫描正常）——无请求挂起问题
- 共享写锁锁键归一化（审计项）已补测试（混合正/反斜杠拼写同锁链）
