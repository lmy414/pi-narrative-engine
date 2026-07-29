// main.rs — narrative-engine Tauri 应用入口（阶段 4）
//
// 职责（应用化设计 §4.1）：
// 1. 启动时 spawn Node sidecar（unified-server，仅 127.0.0.1）
// 2. WebView 先加载本地启动页（public/index.html），由页面 JS 轮询
//    sidecar 就绪后跳转——避免 Rust 侧导航时序问题
// 3. 应用退出时 kill sidecar 子进程
//
// sidecar 模式：
// - 开发（debug 或 NE_SIDECAR=dev）：仓库 tsx 跑 src/app/main.ts
// - 生产（NE_SIDECAR=prod 或 release）：<resource>/node + <resource>/server/main.js
//   （阶段 5 打包产物布局）
mod sidecar;

use sidecar::SidecarHandle;
use std::sync::Mutex;
use tauri::Manager;

struct AppState {
    sidecar: Mutex<Option<SidecarHandle>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let resource_dir = app.path().resource_dir().ok();
            // sidecar 启动失败不应让应用闪退：存 None，由启动页超时提示引导排查
            let handle = match sidecar::spawn_sidecar(resource_dir.as_deref()) {
                Ok(h) => {
                    let port = h.port;
                    eprintln!("[tauri] 等待 sidecar 就绪: http://127.0.0.1:{port}/");
                    Some(h)
                }
                Err(e) => {
                    eprintln!("[tauri] sidecar 启动失败（应用继续运行，启动页将显示错误）: {e}");
                    None
                }
            };
            app.manage(AppState {
                sidecar: Mutex::new(handle),
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<AppState>() {
                    if let Ok(mut guard) = state.sidecar.lock() {
                        if let Some(mut h) = guard.take() {
                            h.kill();
                        }
                    }
                }
            }
        });
}
