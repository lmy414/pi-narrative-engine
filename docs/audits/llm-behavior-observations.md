# LLM 执行层行为观察记录

> 记录 LLM 在真实调用中表现出的偏好、偏差、盲区，供提示词优化、工具设计、结果校验参考。
> 每条记录应包含：现象、可能原因、影响、潜在修复方向。

---

## LLM-001：LLM 不喜欢创建地点/物品实体，偏好角色-角色关系变化

| 项 | 内容 |
|---|---|
| **日期** | 2026-08-05 |
| **现象** | 在角色演绎（role_interact / 角色子代理）和可见推理（runReasoning）中，LLM 倾向于：<br>1. 不创建新的 `location` / `item` 类型实体<br>2. 不把物品和角色建立关系（如 `located_in` / `owns` / `wearing`）<br>3. 反而大量产出角色-角色之间的关系变化（`friend` / `enemy` / `knows` 等）和情绪变化 |
| **可能原因** | 1. 训练数据中人际互动远多于物品/场景描写，LLM 对"人与人关系"的建模更强<br>2. 角色提示词中未明确要求"必须考虑场景/物品互动"，LLM 走最省力路径<br>3. 创建地点/物品需要额外生成实体 ID、属性、关系，比单纯更新角色关系成本高 |
| **影响** | 1. 世界图中地点/物品实体稀少，场景信息丢失<br>2. 角色演绎的"物质基础"薄弱，后续渲染缺少具体道具/场景细节<br>3. 检索时按地点/物品查询命中率低 |
| **潜在修复方向** | 1. **提示词层**：在角色系统提示词和可见推理提示词中显式要求"每次事件至少创建/更新 1 个地点或物品实体"、"描述角色与物品的互动（拿起/放下/穿戴/使用）"<br>2. **工具层**：在 `characterActionSchema` 中增加 `item_interactions` 必填字段（如 `[{ itemId, action, targetId }]`），约束 LLM 必须输出<br>3. **校验层**：commit 后检查本次事件是否产生了 location/item 相关变更，若无则给出警告或让 LLM 补写<br>4. **Few-shot**：在规则集中加入"事件示例"，展示包含物品/地点互动的完整演绎 |
| **相关代码** | 角色提示词构建：[orchestrator.ts#L571-L579](file:///d:/claude/pi-ex/narrative-engine/src/orchestrator.ts#L571-L579)；可见推理提示词：[orchestrator.ts#L149-L153](file:///d:/claude/pi-ex/narrative-engine/src/orchestrator.ts#L149-L153)；`characterActionSchema`：[agents/tools.ts#L53-L75](file:///d:/claude/pi-ex/narrative-engine/src/agents/tools.ts#L53-L75) |
