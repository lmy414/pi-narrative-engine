# 前端测试轮：结构 v3 前端适配（2026-08-10）

> 测试轮文档 · 单轮单文档
> 范围：frontend-demo 结构 v3 适配改动——settings.js（规则集 tab 三件套）、files.js（新建默认路径消费 chaptersDir）、api-mock.js / mock-data.js（v3 数据固件）
> 服务：`node scripts/app-server.mjs --port 7423`（7421/7422 端口被既有进程占用；app-config 白名单补 D:\claude\pi-ex 后新端口生效）
> 测试方式：真实项目（novel/ 已迁移 v3 + 旧结构项目 澪与佑莉 兼容验证）+ browser 实操

## 产出清单（8 项）

| # | 测试项 | 预期 | 结果 |
|---|--------|------|------|
| T1 | 旧项目（澪与佑莉，novel.json + 旧三件套）文件视图兼容 | 文件树列出旧文件、可打开编辑；hint 显示「来自小说.json」（兼容读取） | ✅ 通过（打开 规则集.md 渲染正常，426 字） |
| T2 | novel/（小说.json 主名）扫描发现 | 项目管理页扫描 D:\claude\pi-ex 发现 novel/，显示 3 章/15 实体/46 事件 | ✅ 通过 |
| T3 | novel/ 文件树 v3 结构 | 区域目录（笔记/草稿/设定/大纲）+ 规则集/ 三件 + 正文/第9-12章 + 小说.json | ✅ 通过（另有 4 个乱码空目录显示，见 O2） |
| T4 | 规则集/文风规则.md 打开渲染 | 渲染模式显示内容（1184 字）、已保存状态 | ✅ 通过 |
| T5 | 新建文件默认路径 | 默认 = 正文/新章节.md（消费 novel.json chaptersDir，非硬编码） | ✅ 通过 |
| T6 | 设置 → 规则集页 | 三 tab（文风/检查/自定义）；文风规则内容完整（含参考示例 few-shot）；保存落盘；恢复模板从 templates/novel 重置 | ✅ 通过（保存/恢复均验证磁盘） |
| T7 | 设置 → 项目信息 | 卡片标题与描述显示「小说.json」 | ✅ 通过 |
| T8 | 创建新项目（v3 脚手架） | 目录骨架 正文/规则集/笔记/草稿/设定/大纲/.pi；模板 小说.json/README/.gitignore/规则集三件；激活成功 | ✅ 通过（engineVersion 字面量见 O1） |

## 缺陷登记（禁止即修，待用户决策）

| # | 严重度 | 描述 | 影响面 |
|---|--------|------|--------|
| F1 | 中 | 旧项目（无 规则集/ 目录）的**渲染器子代理渐进披露读不到旧 规则集.md**——rules_read 枚举只读 规则集/文风规则.md 等新位置；loadStyleRuleSet（主会话工具链）有旧文件回退，但编排器渲染子代理的 <available_rules> 清单/rules_read 没有回退 | 旧项目迁移前，编排链路渲染规则对子代理不可见（主会话 render_append 等工具仍生效） |
| O1 | 低 | createProject 的 小说.json `engineVersion` 保留 `{{engineVersion}}` 字面量（既有行为：createProject vars 仅 name/date，init-novel.mjs 才替换） | 新项目清单字段显示占位符 |
| O2 | 低 | novel/ 根目录有 4 个 U+FFFD 乱码空目录（git 不可见的遗留空目录），文件视图显示乱码目录名 | 显示整洁度 |
| O3 | 低 | templates/novel 因含 小说.json 模板被扫描识别为项目（既有现象） | 项目列表多一项 |
| O4 | 低 | app-config 的 defaultScanRoots 白名单启动时缓存，修改后需重启服务生效 | 运维体验 |

## 观察

- console 501（/api/scheduler/status、/api/chat/events）：编排器未装配（无 embedder）时的既有设计行为，非本次改动引入
- 测试过程临时修改 app-config（白名单 +D:\claude\pi-ex）与 novel/规则集/检查规则.md（保存/恢复测试，已恢复与模板一致）；临时项目 tmp-v3-test 已删除；7422/7423 测试服务待停止

## 结论

8/8 通过。F1 为真实兼容性缺口（旧项目渲染链路规则不可见），建议修复（rules_read 加旧文件回退，与 loadStyleRuleSet 一致）；O1-O4 为观察项。
