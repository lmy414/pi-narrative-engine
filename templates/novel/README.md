# {{name}}

narrative-engine 小说工程。

## 目录结构

```
├── novel.json            # 项目清单（引擎读取的项目约定）
├── .gitignore            # 忽略 extensions/、scheduler-plans/、db 瞬态文件
├── 正文/                 # 章节文件（第<N>章-<标题>.md）
├── 规则集.md             # 渲染器规则（文风/格式/禁止项）
├── planner 规则集.md     # 调度器检索计划规则
├── 角色规则集.md         # 角色扮演规则
└── .pi/
    ├── extensions/       # 引擎扩展（sync 产物，不入库）
    ├── scheduler-plans/  # plan 缓存（TTL 1h，不入库）
    └── world-graph-v3/   # 世界图数据（world.db + events.jsonl + memory.md，入库）
```

## 使用

```bash
# 启动（在本目录下）
pi

# 然后直接口述剧情，例如：
# "彩叶推开咖啡厅的门，看到辉夜坐在角落"
```

## 维护

- 规则集三个 .md 随时改，即时生效
- 世界图数据入库，随 git 一起演进
- 引擎升级：在 narrative-engine 仓库跑 `npm run build && npm run sync`
