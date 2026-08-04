# {{name}}

narrative-engine 小说工程。

## 目录结构

```
├── novel.json            # 项目清单（引擎读取的项目约定）
├── .gitignore            # 忽略 scheduler-plans/、db 瞬态文件、.env
├── 正文/                 # 章节文件（第<N>章-<标题>.md）
├── 规则集.md             # 渲染器规则（文风/格式/禁止项）
├── planner 规则集.md     # 调度器检索计划规则
├── 角色规则集.md         # 角色扮演规则
└── .pi/
    ├── scheduler-plans/  # plan 缓存（TTL 1h，不入库）
    └── world-graph-v3/   # 世界图数据（world.db + events.jsonl + memory.md，入库）
```

## 使用

```bash
# 在 narrative-engine 仓库目录启动服务
node scripts/app-server.mjs --project <本工程目录>

# 浏览器访问 http://127.0.0.1:7421，在「项目管理」激活本项目后即可口述剧情
# 例如："彩叶推开咖啡厅的门，看到辉夜坐在角落"
```

## 维护

- 规则集三个 .md 随时改，即时生效
- 世界图数据入库，随 git 一起演进
- 引擎升级：在 narrative-engine 仓库跑 `npm run build` 后重启服务即可（项目目录是纯数据，无需同步扩展代码）
