// tests/types.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

test("types: sanity check - 类型可被导入", async () => {
  // 仅验证模块可加载，类型在编译期检查
  const mod = await import("../src/types.ts");
  // 无运行时导出，仅类型导出，这里只确认模块文件存在且无语法错误
  assert.ok(mod, "types module loaded");
});
