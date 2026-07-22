// 公共 API 出口（飞书文档"四、模块导出清单"）
// 内部实现文件（world-graph.ts/event-log.ts/character-view.ts）不直接导出

export { WorldGraph } from "./world-graph.ts";
export type { WorldGraphOptions, EntitySnapshot } from "./world-graph.ts";

// Zod schema 值（运行时可调 .parse()）+ TS 类型（编译期类型约束）
// types.ts 中每个 export 既是值也是类型，需分别导出
export {
  EntityType,
  Modality,
  EventType,
  StateDeclaration,
  EventRecord,
  VisibilityDeclaration,
  INFRA_RELATIONS,
} from "./types.ts";

export type {
  EntityType,
  Modality,
  EventType,
  StateDeclaration,
  EventRecord,
  VisibilityDeclaration,
} from "./types.ts";
