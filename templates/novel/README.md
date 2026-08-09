# {{name}}

narrative-engine 小说工程。

## 目录结构

```
├── 小说.json            # 项目清单（引擎识别本文件定位项目）
├── README.md            # 项目简介
├── .gitignore           # git 管理规则（创作资产入库、运行时数据排除）
├── 正文/                # 章节文件（一章一个 .md，第<N>章-<标题>.md；章内事件用锚点分段）
├── 规则集/
│   ├── 文风规则.md      # 文风约定（外部可编辑，渲染器渐进披露读取）
│   ├── 检查规则.md      # render_check 校验规则
│   └── 自定义规则.md    # 自定义扩展规则（用户/代理可写）
├── 笔记/                # 随笔、灵感（用户和代理都可编辑）
├── 草稿/                # 草稿、废弃片段
├── 设定/                # 世界观、人物、地点、物品等设定文本
├── 大纲/                # 卷纲、章纲
└── .pi/
    ├── scheduler-plans/  # plan 缓存（不入库）
    ├── sessions/         # 会话数据（不入库）
    ├── logs/             # 调试日志（不入库）
    └── world-graph-v3/   # 世界图（events.jsonl + 快照入库；world.db 不入库）
```

## 使用

```bash
# 在 narrative-engine 仓库目录启动服务
node scripts/app-server.mjs --project <本工程目录>

# 浏览器访问 http://127.0.0.1:7421，在「项目管理」激活本项目后即可口述剧情
# 例如："彩叶推开咖啡厅的门，看到辉夜坐在角落"
```

## git 管理规则（v3）

| 入库 | 不入库 |
|------|--------|
| 小说.json / README.md / 正文/ / 规则集/ / 笔记/ 草稿/ 设定/ 大纲/ | `*.db`（world.db 二进制，无法 diff） |
| `.pi/world-graph-v3/events.jsonl`（剧情权威日志）+ `world-state.json`（状态快照） | `.pi/sessions/`、`.pi/logs/`、`.pi/scheduler-plans/`、`.mimosa/` |

提交节奏建议：每完成一章提交一次 = 正文 + events.jsonl + world-state.json（剧情存档点）。

## 维护

- 文风规则.md 随时改，渲染器按需读取即时生效
- 引擎升级：在 narrative-engine 仓库跑 `npm run build` 后重启服务即可（项目目录是纯数据，无需同步扩展代码）
