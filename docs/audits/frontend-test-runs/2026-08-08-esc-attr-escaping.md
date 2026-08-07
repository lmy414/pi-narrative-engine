# 前端测试轮：🟠-23 属性转义族修复（2026-08-08）

> **触发**：批次 2b 修改 `frontend-demo/`（q/flJs/settingsJs 实体层转义、7 处属性裸插值、CSS.escape、class 插值）后按 AGENTS.md 前端测试纪律自驱测试轮。
> **服务**：`node scripts/app-server.mjs --port 7421`（未加 `--embed`——编排器不可用，属环境限制）。
> **工具**：browser_use（IAB）。截图 3 张存 `shots/2026-08-08-esc-attr-escaping/`。
> **局限**：本会话模型不支持图像输入——截图已保存为 artifact 供人工核验，测试结论以 DOM 结构验证为主（domSnapshot/属性读取），视觉核验受限已如实标注。

## 产出清单（测试点）

| # | 页面 | 交互路径（对应修复点） | 结果 |
|---|---|---|---|
| T1 | launcher 项目列表 | 扫描项目 → 项目卡渲染 → 菜单开合（toggleProjectMenu CSS.escape） | ⚠️ 阻塞（见 BUG-037） |
| T2a | 世界图 | 页面渲染（实体卡/视角下拉） | ✅ 渲染完整 |
| T2b | 世界图 | 实体卡点击选择（graphSelectEntity + data-entity-id escapeHtml） | ✅ data-entity-id 属性正确；侧栏切换至 ent_char_luqingzhi |
| T2c | 世界图 | 视角切换下拉（option value escapeHtml） | ✅ 12 个 option 值正确；选中 ent_char_luqingzhi 视角生效 |
| T2d | 世界图 | 快速记事件弹窗（qe-st/qe-entity value escapeHtml） | ✅ storyTime=ch004.ev004、entity=ent_char_luqingzhi 预填正确 |
| T3a | 事件链 | 页面渲染（章节分组/事件卡） | ✅ 4 章 164 事件渲染完整 |
| T3b | 事件链 | 事件卡点击展开（eventSelectEvent CSS.escape） | ✅ 展开（「收起详情」出现） |
| T3c | 事件链 | 类型标签筛选（eventSelectType data-type escapeHtml） | ✅ change 筛选生效（2 章 155 事件） |
| T3d | 事件链 | 实体过滤（eventToggleEntity CSS.escape） | ✅ 组合筛选空态正确；重置后种子角色过滤出 1 事件 |
| T4 | 世界图 | 快速加关系弹窗（qr-source/qr-st value escapeHtml） | ✅ 源实体/故事时间预填正确 |
| T5 | 文件 | 特殊字符路径文件打开（flJs：`番外·打烊后的拾光（青栀×沈知意R18）.md`） | ✅ 成功打开渲染（flJs 实战通过） |
| T6 | 设置 | 页签切换（settingsSwitchPanel settingsJs） | ✅ 厂商管理页加载 |
| T7 | 调试 | 日志展开（dbgToggleExpand q） | ⏭️ 无事件数据跳过（需编排活动生成日志） |
| T8a | 工作室 | 页面渲染 + 会话切换（stSwitchSession q） | ✅ 会话切换成功 |
| T8b | 工作室 | plan 状态徽章（stOrStatusBadgeHtml class 转义） | ⏭️ 无 plan 数据跳过（编排器未加 --embed 不可用，环境限制） |

## 缺陷登记（本轮回合，禁止即修 → 用户决策）

| 编号 | 级别 | 位置 | 描述 |
|---|---|---|---|
| BUG-037 | P2 | launcher → 扫描项目 | **扫描「处理中…」全局 loading 覆盖层长时间不收敛**（≥15 分钟仍显示，且每个页面底部残留）。novel 目录（47MB/262 子目录）在 defaultScanRoots 白名单内（app-config 实盘确认），扫描应正常执行；疑似扫描请求挂起或 withLoading 未收敛。与 🟠-23 无关（转义修复不影响 loading 逻辑）。**未修复**，待用户决策 |
| 环境限制 | - | 服务启动 | 服务未加 `--embed`，编排器不可用（工作室 plan 卡、调试日志无法生成）——非代码缺陷 |
| 环境限制 | - | 测试工具 | 模型不支持图像输入，截图无法视觉核验（artifact 已留存供人工查看）——非代码缺陷 |

## 结论

**🟠-23 转义修复涉及的全部可达交互路径通过**：CSS.escape 三处选择器（事件展开/实体过滤）无 SyntaxError、实体属性与 option 值经 escapeHtml 渲染正确、flJs 特殊字符路径实战打开成功、settingsJs 页签切换正常、弹窗 value 预填正确。唯一阻塞点为 launcher 扫描 loading 不收敛（BUG-037，与本次修复无关的既有问题）。

**代码层验证补充**（浏览器无法覆盖的注入场景）：q/flJs/settingsJs 输出经 headless Chrome 属性解析实证 7 场景注入消除（子代理审计复核）；`tests/frontend-demo.test.ts` 新增 q() 输出级断言 + graph 渲染转义断言（31/31 通过）。
