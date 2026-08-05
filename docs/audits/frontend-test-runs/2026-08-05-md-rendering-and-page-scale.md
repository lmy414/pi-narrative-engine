# 前端测试轮 · 2026-08-05-md-rendering-and-page-scale

## 元信息
- 触发原因：批次三（P2）修复 BUG-021（LLM 输出 MD 渲染）+ BUG-018（全局页面缩放）
- 受影响页面：studio（AI 助手消息）、settings（应用偏好）
- 服务地址：http://127.0.0.1:7421
- 执行者：AI（browser_use）
- 开始时间：2026-08-05

## 测试清单

### 页面：studio（BUG-021 LLM 输出 MD 渲染）
- [x] TC-001 AI 消息含 Markdown（标题/列表/粗体/行内代码）时按 MD 渲染为结构化 HTML（分类：功能）
  - 步骤：进入 studio，观察带 MD 语法的 AI 消息气泡
  - 预期：标题、列表、粗体、行内代码样式生效，非纯文本
  - 实际：快照显示 `heading`（"会话正常 ✅"/"功能验证结果"）、`listitem`、`code`（ch003.ev016、belief.关于_裴霜）、`strong`（"项目"无 `**`），MD 解析生效
  - 结果：✅
- [x] TC-002 用户消息保持纯文本，不解析 Markdown（分类：功能）
  - 步骤：发送含 `**加粗**` / `# 标题` 的用户消息
  - 预期：原文原样显示，无 MD 样式
  - 实际：`stBubbleContentHtml('**bold** # h', false, false)` 返回字面 `**bold** # h`；AI 侧返回 `<p><strong>bold</strong> # h</p>`
  - 结果：✅
- [x] TC-003 空文本 / 仅工具调用消息显示占位文本，不出现空气泡（分类：边界）
  - 步骤：观察工具调用型 AI 消息、空消息气泡
  - 预期：显示"（调用了工具，无文本回复）"或"…"
  - 实际：快照中多条工具调用消息显示"（调用了工具，无文本回复）"，无空气泡
  - 结果：✅
- [x] TC-004 XSS 防护：AI 消息含 `<script>` / `onerror` 等恶意标签被净化（分类：边界）
  - 步骤：构造含 `<script>` / `onerror` 的 AI 消息并渲染
  - 预期：DOMPurify 净化，脚本不执行
  - 实际：`stMarkdownHtml('<script>alert(1)</script>\n<img src=x onerror=alert(2)>**bolt**')` 输出 `<p><img src="x"><strong>bolt</strong></p>`，`<script>` 移除、`onerror` 被剥离
  - 结果：✅

### 页面：settings → 应用偏好（BUG-018 全局页面缩放）
- [x] TC-005 「应用偏好」面板出现「页面缩放」slider（80%~150%，步长 10%）（分类：功能）
  - 步骤：进入 设置 → 应用偏好
  - 预期：存在页面缩放 slider，默认值 100%，显示 "100%"
  - 实际：`#set-scale-slider` 存在，value=100，label "100%"
  - 结果：✅
- [x] TC-006 拖动 slider 实时改变全局字号（分类：交互）
  - 步骤：拖动页面缩放 slider 到 120%
  - 预期：`document.documentElement.style.fontSize` 变为 120%，全局 UI 随之放大
  - 实际：dispatch input 后 fontSize="120%"，label 更新为 "120%"
  - 结果：✅
- [x] TC-007 保存后刷新仍保持缩放（持久化到 appConfig.uiScale）（分类：功能）
  - 步骤：设缩放 120% → 保存偏好 → 刷新页面
  - 预期：刷新后仍为 120% 缩放
  - 实际：首测失败（BUG-022）；修复 `api-client.js UI_PREF_KEYS` 补 `uiScale` 后复测：uiPrefs 写入 `{"uiScale":120}`，刷新后 fontSize="120%"，持久化生效
  - 结果：✅（修复后通过）
- [x] TC-008 缩放调回 100% 时清除根字号（分类：功能）
  - 步骤：缩放调回 100%
  - 预期：`fontSize` 置空，恢复浏览器默认
  - 实际：slider 100% 后 fontSize=""，label "100%"
  - 结果：✅

### 页面：全局（控制台洁净）
- [x] TC-009 无 JS 报错 / 无 404 / 无未捕获 Promise（分类：控制台）
  - 步骤：加载 studio 与 settings 页，采集 console
  - 预期：无报错；marked/dompurify vendor 正常加载（SRI 校验通过）
  - 实际：仅 three.js 弃用警告（预存）与 `/api/chat/events` SSE 导航断开 ERR_ABORTED（预期）；marked/dompurify 无 SRI 失败无 404
  - 结果：✅

## 缺陷登记

| 编号 | 所属项 | 严重度 | 复现步骤 | 期望 | 实际 | 截图 | 状态 |
|------|--------|--------|---------|------|------|------|------|
| BUG-022 | TC-007 | P2 | 1. 设置→应用偏好 2. 页面缩放拖到 120% 3. 保存偏好 4. 刷新 | 刷新后仍 120% 缩放 | 首测刷新后 fontSize 为空（100%），uiScale 未持久化；修复：`api-client.js UI_PREF_KEYS` 补 `uiScale`（复用 localStorage uiPrefs），复测通过 | — | fixed |

## 小结
- 通过 9 项 / 失败 0 项 / 跳过 0 项（首测 8 通过 1 失败，BUG-022 本轮修复后复测通过）
- 缺陷分布：P0 0 / P1 0 / P2 1（已修复）/ P3 0
- 总体评价：BUG-021 全部通过；BUG-018 实时缩放与控件正常，但持久化缺失（BUG-022），需在 `api-client.js` 的 UI 偏好白名单补 `uiScale` 复用现有 localStorage 机制。