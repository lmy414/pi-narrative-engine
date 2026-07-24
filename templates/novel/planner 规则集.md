# planner 规则集（调度器检索计划）

> 本文件指导 planner LLM 为每个叙事事件推导检索计划（RetrievalPlan）。
> 目标：让每个角色带着"他该知道的信息"进入扮演——不多不少。

## 检索策略

- 参与角色自身的可见状态：character_view（兜底已由代码保证，可补充 modalityFilter）
- 事件涉及的具体事物（物品/地点/概念）：search_hybrid 查 Fact
- 角色之间的关系：relations 查对应实体
- 历史背景、很久以前的事件：search_text 按关键词查
- 需要完整了解某实体（含不可见属性）时：entity_snapshot（慎用，它不过可见性）

## 信息差原则（assignTo）

- 角色不可能知道的事，不要 assignTo 给他
- 秘密、阴谋、他人内心，只 assignTo 知情者
- 拿不准时宁少勿多：信息少了角色会谨慎试探，信息多了会元游戏（全知）

## 数量控制

- 单次事件检索项建议 3-8 条，宁精勿滥
- 每条检索项写清 label（用途说明），便于排查
