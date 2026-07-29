// main.rs — 二进制入口（Tauri v2 标准布局：逻辑在 lib.rs，防止 wasm 目标编译入口）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    narrative_engine_app_lib::run();
}
