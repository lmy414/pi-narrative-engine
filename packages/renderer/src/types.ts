/**
 * @pi/renderer 子包类型定义
 *
 * 渲染器无状态：所有状态由调用方持有（LLM 实例、规则集、章节路径）。
 */

/**
 * RoleOutput — 角色池结构化输出（与 role-pool 约定一致）
 *
 * 字段对齐 V2 设计笔记的子代理结构化输出规范：
 * actor / action / target / emotion / relation_update / thought / knowledge_gained
 */
export interface RoleOutput {
  actor: string;
  action: string;
  target?: string;
  emotion?: string;
  relation_update?: { target: string; label: string }[];
  thought?: string;
  knowledge_gained?: string[];
}

/**
 * RenderTextCommand — 仅生成文本，不写文件
 * 用于预览或由调用方自行决定写入策略
 */
export interface RenderTextCommand {
  /** 渲染模式：append 续写 / modify 重写指定锚点区间 */
  mode: 'append' | 'modify';
  /** 本次渲染对应的事件 ID（用于锚点） */
  eventId: string;
  /** 故事时间（如 ch-2） */
  storyTime: string;
  /** 叙事指令（自然语言，scheduler 产出） */
  instruction: string;
  /** 角色池结构化输出 */
  payload: RoleOutput[];
  /**
   * 已有上下文文本（append 时为章节全文；modify 时为锚点区间+前后段落）
   * 调用方负责读取并传入，渲染器不直接读文件
   */
  context: string;
  /** modify 模式：要重写的目标事件 ID */
  modifyAnchorEventId?: string;
}

/**
 * RenderFileCommand — 生成文本并写入章节文件
 */
export interface RenderFileCommand {
  mode: 'append' | 'modify';
  /** 目标章节文件绝对路径 */
  chapterPath: string;
  eventId: string;
  storyTime: string;
  instruction: string;
  payload: RoleOutput[];
  /** modify 模式：要重写的目标事件 ID */
  modifyAnchorEventId?: string;
}

/**
 * RenderResult — 渲染并写入文件后的返回
 */
export interface RenderResult {
  ok: boolean;
  chapterPath: string;
  mode: 'append' | 'modify';
  eventId: string;
  /** 本次写入的文本（含锚点） */
  writtenText: string;
  /** 错误信息（ok=false 时） */
  error?: string;
}

/**
 * RenderLlmCaller — 注入式 LLM 调用器
 *
 * 输入：系统提示词 + 用户消息
 * 输出：LLM 生成的纯文本
 *
 * 这样设计便于单测时注入 mock，生产环境用 pi-ai 的 complete 实现。
 * 与 novel-importer 的 LlmToolCaller 区别：
 *   - LlmToolCaller 用于 tool call 场景（返回结构化 JSON）
 *   - RenderLlmCaller 用于文本生成场景（返回纯文本）
 */
export type RenderLlmCaller = (
  systemPrompt: string,
  userMessage: string,
) => Promise<string>;

/**
 * RenderCtx — 渲染调用上下文
 */
export interface RenderCtx {
  llm: RenderLlmCaller;
  /** 规则集.md 全文（由调用方通过 loadRuleSet 读取后传入） */
  ruleSet: string;
}
