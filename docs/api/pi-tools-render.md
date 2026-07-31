# PI 扩展工具：render_* 渲染工具域（5 个）

> 属于 [API 文档索引](README.md)。覆盖 `src/tools/render-tools.ts`，底层能力由 `@pi/renderer` 子包提供（见 [renderer.md](renderer.md)），检验逻辑见 `src/checker.ts`。

渲染工具将叙事指令 + 角色池结构化数据（`RoleOutput[]`）渲染为符合规则集.md 约定的正文文本，并按锚点写入章节文件。

## `render_append`

渲染叙事事件并追加到章节文件（append 模式）。读取已有章节全文做上下文，LLM 生成正文后追加到文件末尾。

**参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `chapterPath` | string | 是 | 目标章节文件绝对路径 |
| `eventId` | string | 是 | 本次渲染对应的事件 ID |
| `storyTime` | string | 是 | 故事时间（如 `ch009.ev006`） |
| `instruction` | string | 是 | 叙事指令（自然语言） |
| `payload` | `RoleOutput[]` | 是 | 角色池结构化输出 |

**返回**：
```json
{
  "content": [{ "type": "text", "text": "已渲染事件 evt_001 到 /path/第1章.md（append）" }],
  "details": {
    "ok": true,
    "chapterPath": "/path/第1章.md",
    "mode": "append",
    "eventId": "evt_001",
    "writtenText": "林墨推开酒馆的门..."
  }
}
```

**行为**：
- 读取 `chapterPath` 全文作为上下文（首行版本标记 `<!-- engine v0.01 -->` 之后的全部内容）
- 注入规则集.md（每次重读，不缓存）到用户消息末尾
- LLM 生成正文后，写入 `<!-- event: <eventId> -->` 锚点 + 空行 + 正文，追加到文件末尾
- 文件不存在时自动创建（首行写入版本标记）

## `render_modify`

重写章节文件中指定事件锚点区间的文本（modify 模式）。

**参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `chapterPath` | string | 是 | 目标章节文件绝对路径 |
| `eventId` | string | 是 | 本次渲染对应的事件 ID（用于记录） |
| `modifyAnchorEventId` | string | 是 | 要重写的目标事件 ID |
| `storyTime` | string | 是 | 故事时间 |
| `instruction` | string | 是 | 叙事指令（描述重写方向） |
| `payload` | `RoleOutput[]` | 是 | 角色池结构化输出 |

**返回**：
```json
{
  "content": [{ "type": "text", "text": "已重写事件 evt_002 区间到 /path/第1章.md（modify）" }],
  "details": {
    "ok": true,
    "chapterPath": "/path/第1章.md",
    "mode": "modify",
    "eventId": "evt_001",
    "modifyAnchorEventId": "evt_002",
    "writtenText": "「师弟，许久不见。」"
  }
}
```

**行为**：
- 读取 `chapterPath` 全文作为上下文
- 按 `modifyAnchorEventId` 锚点定位重写区间（从该锚点到下一个锚点或文件末尾）
- LLM 生成新正文，替换该区间内容
- 锚点本身保留，仅替换锚点之后的正文

## `render_preview`

预览渲染结果（不写入文件）。

**参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `chapterPath` | string | 否 | 章节文件路径（用于读取上下文，不写文件） |
| `eventId` | string | 是 | 事件 ID |
| `storyTime` | string | 是 | 故事时间 |
| `instruction` | string | 是 | 叙事指令 |
| `payload` | `RoleOutput[]` | 是 | 角色池结构化输出 |

**返回**：
```json
{
  "content": [{ "type": "text", "text": "林墨推开酒馆的门..." }],
  "details": {
    "ok": true,
    "eventId": "evt_001",
    "preview": true,
    "contextWarning": undefined
  }
}
```

**行为**：
- 若提供 `chapterPath`，读取全文作为上下文；读取失败时 `contextWarning` 字段提示错误信息
- 调用 LLM 生成文本，直接返回到 `content[0].text`
- 不触碰文件系统

## `render_check`

检验章节文本是否符合规则集.md。

**参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `target` | `"latest"` / `"chapter"` / `"range"` / `"full"` | 是 | 检验范围 |
| `chapterPath` | string | 否 | 章节文件路径（`target != "full"` 时必填） |
| `startEventId` | string | 否 | `target="range"` 时起点 |
| `endEventId` | string | 否 | `target="range"` 时终点（不包含） |

**target 说明**：
- `latest`：只检查最新事件（最后锚点到末尾）
- `chapter`：检查整章
- `range`：检查 `[startEventId, endEventId)` 区间
- `full`：需要 `chapterPath`，或由主会话拆分后多次调用

**返回**：
```json
{
  "content": [{ "type": "text", "text": "发现 2 处违规" }],
  "details": {
    "violations": [
      { "location": "evt_002", "rule": "禁止词：手机", "text": "他拿出手机", "severity": "error" }
    ],
    "suggestions": [
      { "location": "evt_002", "issue": "包含禁止词", "suggestion": "改为「他抽出信筒」" }
    ],
    "error": undefined
  }
}
```

**注**：若 LLM 返回非 JSON，`error` 字段会记录错误信息，`violations`/`suggestions` 为空数组（区别于"无违规"）。

## `render_rule_set`

查看当前规则集.md 内容。无需参数。

**返回**：
```json
{
  "content": [{ "type": "text", "text": "文风：白描为主\n禁止词：手机、电脑" }],
  "details": {
    "ok": true,
    "length": 25,
    "exists": true
  }
}
```

**行为**：
- 读取 `<novelCwd>/规则集.md` 全文
- 文件不存在时 `exists: false`、`length: 0`、`content[0].text` 为占位提示
- 不缓存，每次重读

**详见**：[renderer.md](renderer.md)
