// packages/novel-launcher/tests/launch-extension.test.ts
/**
 * 扩展加载参数测试（应用化 §5.2.2）
 *
 * 覆盖 _buildExtensionArgs：
 * - 缺省（无参数）→ []
 * - extensionMode "disabled" → ["--no-extensions"]（忽略 extensionPath）
 * - extensionPath → ["-e", path]
 * - 与 args 拼接顺序（launchPi 内：扩展参数在前）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { _buildExtensionArgs } from "../src/index.ts";

test("_buildExtensionArgs: 缺省为空数组", () => {
  assert.deepEqual(_buildExtensionArgs(), []);
  assert.deepEqual(_buildExtensionArgs({}), []);
  assert.deepEqual(_buildExtensionArgs({ extensionMode: "enabled" }), []);
});

test("_buildExtensionArgs: disabled 拼 --no-extensions", () => {
  assert.deepEqual(_buildExtensionArgs({ extensionMode: "disabled" }), ["--no-extensions"]);
});

test("_buildExtensionArgs: disabled 时忽略 extensionPath", () => {
  assert.deepEqual(
    _buildExtensionArgs({ extensionMode: "disabled", extensionPath: "/ext/narrative-engine" }),
    ["--no-extensions"],
  );
});

test("_buildExtensionArgs: extensionPath 拼 --no-extensions + -e", () => {
  assert.deepEqual(
    _buildExtensionArgs({ extensionPath: "/ext/narrative-engine" }),
    ["--no-extensions", "-e", "/ext/narrative-engine"],
  );
  assert.deepEqual(
    _buildExtensionArgs({ extensionMode: "enabled", extensionPath: "D:\\ext\\ne" }),
    ["--no-extensions", "-e", "D:\\ext\\ne"],
  );
});
