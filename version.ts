// 引擎版本号
// 每次引擎更新（改了渲染逻辑/规则系统/prompt 等影响输出结果的改动）后 bump
// 渲染器会在每次输出文本开头加版本标记（HTML 注释，不影响阅读）
//
// 版本历史：
// v0.01 — 初始版本：七步流水线 + 规则系统 + 章节分文件 + 增量规则

export const ENGINE_VERSION = "0.01";

/** 生成版本标记（HTML 注释，渲染输出时 prepend 到文本开头） */
export function versionTag(): string {
	return `<!-- engine v${ENGINE_VERSION} -->`;
}

/** 给渲染文本加版本标记前缀（只在有标记时加，避免重复） */
export function tagRenderOutput(text: string): string {
	const tag = versionTag();
	if (text.startsWith(tag)) return text;
	return `${tag}\n${text}`;
}
