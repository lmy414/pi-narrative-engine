// sidecar.rs — Node sidecar（unified-server）进程管理
//
// 端口：默认 7421（与 visualizer 一致，NE_PORT 可覆盖）。仅监听 127.0.0.1
// 由 unified-server 自身保证。
//
// 开发模式（debug_assertions 或 NE_SIDECAR=dev）：
//   cwd = 仓库根（tauri-app/../），命令：
//   node node_modules/tsx/dist/cli.mjs src/app/main.ts --port <port>
// 生产模式（NE_SIDECAR=prod 或 release）：
//   cwd = <resource_dir>，命令：
//   <resource_dir>/runtime/node server/main.js --port <port>
//   （阶段 5 打包：runtime/node 为 Node 单文件运行时，server/ 为应用 bundle）
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

pub struct SidecarHandle {
    child: Child,
    pub port: u16,
}

impl SidecarHandle {
    pub fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn sidecar_port() -> u16 {
    std::env::var("NE_PORT")
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(7421)
}

fn is_dev_mode() -> bool {
    match std::env::var("NE_SIDECAR").as_deref() {
        Ok("dev") => true,
        Ok("prod") => false,
        _ => cfg!(debug_assertions),
    }
}

/// 仓库根：tauri-app/src-tauri 上三级（开发模式定位 tsx 与 src/app/main.ts）
fn repo_root() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    // debug 构建产物在 tauri-app/target/debug/，上四级 = narrative-engine/
    for ancestor in exe.ancestors() {
        let candidate = ancestor.join("src").join("app").join("main.ts");
        if candidate.exists() {
            return Ok(ancestor.to_path_buf());
        }
    }
    // 兜底：当前工作目录
    std::env::current_dir().map_err(|e| e.to_string())
}

fn spawn_dev(port: u16) -> Result<Child, String> {
    let root = repo_root()?;
    let tsx_cli = root
        .join("node_modules")
        .join("tsx")
        .join("dist")
        .join("cli.mjs");
    let entry = root.join("src").join("app").join("main.ts");
    if !tsx_cli.exists() {
        return Err(format!("未找到 tsx: {}（请先 npm install）", tsx_cli.display()));
    }
    Command::new("node")
        .arg(tsx_cli)
        .arg(entry)
        .arg("--port")
        .arg(port.to_string())
        .current_dir(&root)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("spawn node 失败: {e}"))
}

fn spawn_prod(port: u16, resource_dir: &Path) -> Result<Child, String> {
    let node_exe = if cfg!(windows) {
        resource_dir.join("runtime").join("node.exe")
    } else {
        resource_dir.join("runtime").join("node")
    };
    let entry = resource_dir.join("server").join("main.js");
    if !node_exe.exists() {
        return Err(format!("未找到内置 Node 运行时: {}", node_exe.display()));
    }
    if !entry.exists() {
        return Err(format!("未找到服务入口: {}", entry.display()));
    }
    Command::new(node_exe)
        .arg(entry)
        .arg("--port")
        .arg(port.to_string())
        .current_dir(resource_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("spawn sidecar 失败: {e}"))
}

/// 启动 sidecar，返回句柄（调用方负责 kill）
pub fn spawn_sidecar(resource_dir: Option<&Path>) -> Result<SidecarHandle, String> {
    let port = sidecar_port();
    let child = if is_dev_mode() {
        spawn_dev(port)?
    } else {
        let dir = resource_dir.ok_or("无法解析 resource_dir")?;
        spawn_prod(port, dir)?
    };
    eprintln!("[tauri] sidecar 已启动（port {port}, mode {}）",
        if is_dev_mode() { "dev" } else { "prod" });
    Ok(SidecarHandle { child, port })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// env 读写有跨测试竞态，集中在单个测试函数内串行验证
    #[test]
    fn port_and_mode_env_parsing() {
        // 缺省端口 7421
        std::env::remove_var("NE_PORT");
        assert_eq!(sidecar_port(), 7421);
        // NE_PORT 合法/非法值
        std::env::set_var("NE_PORT", "8321");
        assert_eq!(sidecar_port(), 8321);
        std::env::set_var("NE_PORT", "not-a-port");
        assert_eq!(sidecar_port(), 7421, "非法端口应回退 7421");
        std::env::remove_var("NE_PORT");

        // NE_SIDECAR 显式指定优先于 cfg!(debug_assertions)
        std::env::set_var("NE_SIDECAR", "dev");
        assert!(is_dev_mode());
        std::env::set_var("NE_SIDECAR", "prod");
        assert!(!is_dev_mode());
        std::env::remove_var("NE_SIDECAR");
        // 无 env 时跟随构建 profile（cargo test 为 debug）
        assert!(is_dev_mode());
    }

    #[test]
    fn repo_root_discovers_main_ts() {
        // 开发环境：测试二进制在 tauri-app/target/debug/deps/，
        // 祖先链上应能找到含 src/app/main.ts 的仓库根
        let root = repo_root().expect("应能定位仓库根");
        assert!(root.join("src").join("app").join("main.ts").exists());
        assert!(root.join("package.json").exists());
    }

    #[test]
    fn spawn_prod_rejects_missing_runtime() {
        // 生产模式资源目录缺 runtime/node 时应报清晰错误而非 panic
        let tmp = std::env::temp_dir().join("ne-sidecar-test-empty");
        std::fs::create_dir_all(&tmp).unwrap();
        let err = spawn_prod(7421, &tmp).unwrap_err();
        assert!(err.contains("Node") || err.contains("node"), "错误信息应指出缺失运行时: {err}");
    }
}
