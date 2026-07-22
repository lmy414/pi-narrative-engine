// 公共 API 出口（飞书文档"四、模块导出清单"）
// 内部实现文件（world-graph.ts/event-log.ts/character-view.ts）不直接导出

export { WorldGraph } from "./world-graph.ts";
export type { WorldGraphOptions, EntitySnapshot } from "./world-graph.ts";

// Zod schema 既是值（运行时可调 .parse()）也是类型（编译期类型约束）
// `export { X }` 已同时导出值与其关联类型，无需再 `export type { X }`（否则 TS2300 重复标识符）
export {
  EntityType,
  Modality,
  EventType,
  StateDeclaration,
  EventRecord,
  VisibilityDeclaration,
  INFRA_RELATIONS,
} from "./types.ts";
