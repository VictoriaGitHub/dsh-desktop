// =============================================================================
// DSH Desktop — DeepSeek Harness 桌面客户端（Tauri v2 封装）
//
// 职责：
//   1. 探测 127.0.0.1:3080 上是否已有 dsh web 后端 → 有则直接复用
//   2. 否则用内置自包含运行时（App 内 Node + dsh 依赖）启动，回退外部 dsh
//   3. 端口就绪后把主窗口 WebView 导航到 GUI
//   4. 托盘菜单：显示/隐藏、检查更新、退出；关闭窗口 = 隐藏到托盘
//   5. 自动更新（tauri-plugin-updater，GitHub Releases / 自建渠道 + 签名）
// =============================================================================

use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WebviewWindow, WindowEvent};

/// 全局 AppHandle：供信号处理器触发优雅退出（走 RunEvent::Exit → 清理子进程）
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

/// SIGTERM / SIGINT 处理器：把信号转成 Tauri 正常退出流程
#[cfg(unix)]
extern "C" fn handle_signal(_sig: libc::c_int) {
    if let Some(app) = APP_HANDLE.get() {
        app.exit(0);
    }
}

/// 注册信号处理器（macOS/Linux：kill/SIGINT 时优雅退出并清理后端）
#[cfg(unix)]
fn install_signal_handlers() {
    unsafe {
        let handler = handle_signal as *const () as libc::sighandler_t;
        libc::signal(libc::SIGTERM, handler);
        libc::signal(libc::SIGINT, handler);
    }
}

const DEFAULT_PORT: u16 = 3080;
const POLL_INTERVAL: Duration = Duration::from_millis(300);
const START_TIMEOUT: Duration = Duration::from_secs(60);

/// 后端端口：优先读 DSH_PORT 环境变量（可配置），默认 3080
fn backend_port() -> u16 {
    std::env::var("DSH_PORT")
        .ok()
        .and_then(|s| s.trim().parse::<u16>().ok())
        .filter(|p| *p > 0)
        .unwrap_or(DEFAULT_PORT)
}

fn backend_url(port: u16) -> String {
    format!("http://127.0.0.1:{}", port)
}

// ---------------------------------------------------------------------------
// 应用状态：由本客户端启动的后端子进程（仅在自己拉起时才 Some）
// ---------------------------------------------------------------------------
struct BackendState {
    child: Mutex<Option<Child>>,
}

// ---------------------------------------------------------------------------
// 后端进程探测 / 启动 / 清理
// ---------------------------------------------------------------------------

fn port_is_open(port: u16) -> bool {
    TcpStream::connect(("127.0.0.1", port)).is_ok()
}

/// 解析 dsh 可执行文件位置（优先级：DSH_BIN 环境变量 > npx 缓存 > PATH）
fn resolve_dsh_bin() -> Option<PathBuf> {
    // 1) 环境变量显式指定
    if let Ok(p) = std::env::var("DSH_BIN") {
        let b = PathBuf::from(p);
        if b.is_file() {
            return Some(b);
        }
    }
    // 2) 扫描 ~/.npm/_npx/*/node_modules/.bin/dsh，取修改时间最新者
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        let npx_dir = PathBuf::from(home).join(".npm").join("_npx");
        if let Ok(entries) = std::fs::read_dir(&npx_dir) {
            let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
            for entry in entries.flatten() {
                let cand = entry
                    .path()
                    .join("node_modules")
                    .join(".bin")
                    .join("dsh");
                if cand.is_file() {
                    let mtime = std::fs::metadata(&cand).and_then(|m| m.modified()).ok();
                    match mtime {
                        Some(t) => {
                            if best.as_ref().map(|(bt, _)| t > *bt).unwrap_or(true) {
                                best = Some((t, cand));
                            }
                        }
                        None => {
                            if best.is_none() {
                                best = Some((std::time::UNIX_EPOCH, cand));
                            }
                        }
                    }
                }
            }
            if let Some((_, path)) = best {
                return Some(path);
            }
        }
    }
    // 3) PATH 中的 dsh
    if let Ok(out) = Command::new("sh").args(["-lc", "command -v dsh"]).output() {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !s.is_empty() {
                return Some(PathBuf::from(s));
            }
        }
    }
    None
}

fn log_path() -> PathBuf {
    let base = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join(".dsh-desktop").join("backend.log")
}

/// 启动 `dsh web`（优先内置自包含运行时，回退外部 dsh），日志写入 ~/.dsh-desktop/backend.log
fn spawn_backend(port: u16, app: &AppHandle) -> Result<Child, String> {
    let log = log_path();
    if let Some(parent) = log.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log)
        .map_err(|e| format!("无法打开日志文件 {}: {}", log.display(), e))?;
    let stdout = log_file
        .try_clone()
        .map_err(|e| format!("日志文件克隆失败: {}", e))?;

    // 1) 内置自包含运行时（App 资源目录中的 Node + dsh）—— 用户无需预装任何东西
    let mut cmd: Option<Command> = None;
    if let Ok(res) = app.path().resource_dir() {
        let node = res
            .join("runtime")
            .join("bin")
            .join("node");
        let dsh_js = res
            .join("runtime")
            .join("dsh")
            .join("node_modules")
            .join("@deepseek-ai")
            .join("dsh")
            .join("lib")
            .join("bin.js");
        if node.is_file() && dsh_js.is_file() {
            let mut c = Command::new(&node);
            c.arg(&dsh_js);
            c.args(["web", "--host", "127.0.0.1", "--port", &port.to_string()]);
            cmd = Some(c);
        }
    }
    // 2) 回退：外部 dsh 可执行文件（DSH_BIN / npx 缓存 / PATH）
    if cmd.is_none() {
        if let Some(bin) = resolve_dsh_bin() {
            let mut c = Command::new(&bin);
            c.args(["web", "--host", "127.0.0.1", "--port", &port.to_string()]);
            cmd = Some(c);
        }
    }
    let mut cmd = cmd.ok_or_else(|| {
        "未找到 dsh（内置运行时缺失且系统无 dsh，可设置 DSH_BIN 环境变量）".to_string()
    })?;

    cmd.stdin(Stdio::null());
    cmd.stdout(stdout);
    cmd.stderr(log_file);

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0); // 独立进程组，退出时可整组终止
    }

    cmd.spawn()
        .map_err(|e| format!("启动 dsh 失败: {}", e))
}

fn wait_for_backend(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if port_is_open(port) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

fn kill_child(child: &mut Child) {
    #[cfg(unix)]
    {
        unsafe {
            libc::kill(-(child.id() as i32), libc::SIGTERM);
        }
        let _ = child.wait();
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .status();
    }
}

// ---------------------------------------------------------------------------
// 窗口导航 / loading 状态
// ---------------------------------------------------------------------------

fn open_backend_url(window: &WebviewWindow, port: u16) {
    if let Ok(u) = backend_url(port).parse() {
        let _ = window.navigate(u);
    }
}

fn set_loading_status(window: &WebviewWindow, text: &str) {
    let js = format!(
        "document.getElementById('status').textContent = {}",
        serde_json::to_string(text).unwrap_or_else(|_| "\"…\"".into())
    );
    let _ = window.eval(&js);
}

/// 启动流程：复用已运行实例 > 自己拉起 > 就绪后导航
fn start_backend(app: &AppHandle) {
    let state = app.state::<BackendState>();
    let port = backend_port();

    // 已有实例在跑 → 直接复用（最顺滑，比如用户已手动启动 dsh web）
    if port_is_open(port) {
        if let Some(window) = app.get_webview_window("main") {
            open_backend_url(&window, port);
        }
        return;
    }

    // 自己启动
    match spawn_backend(port, app) {
        Ok(child) => {
            *state.child.lock().unwrap() = Some(child);
            if let Some(window) = app.get_webview_window("main") {
                set_loading_status(&window, "DSH 后端已启动，等待就绪…");
            }
            // 后台等待就绪，不阻塞 UI 线程
            let handle = app.clone();
            std::thread::spawn(move || {
                let ready = wait_for_backend(port, START_TIMEOUT);
                if let Some(window) = handle.get_webview_window("main") {
                    if ready {
                        open_backend_url(&window, port);
                    } else {
                        set_loading_status(&window, "DSH 后端启动超时，请查看 ~/.dsh-desktop/backend.log");
                    }
                }
            });
        }
        Err(err) => {
            if let Some(window) = app.get_webview_window("main") {
                set_loading_status(&window, &format!("启动失败：{}", err));
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 托盘
// ---------------------------------------------------------------------------

fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItemBuilder::with_id("show", "显示 / 隐藏窗口").build(app)?;
    let update = MenuItemBuilder::with_id("update", "检查更新…").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "退出 DSH Desktop").build(app)?;
    let menu = MenuBuilder::new(app)
        .items(&[&show, &update, &quit])
        .build()?;

    let icon = tauri::image::Image::new_owned(
        include_bytes!("../icons/tray.rgba").to_vec(),
        32,
        32,
    );

    TrayIconBuilder::new()
        .icon(icon)
        .tooltip("DeepSeek Harness")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => toggle_main_window(app),
            "update" => check_for_updates(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 原生菜单栏（快捷键）
// ---------------------------------------------------------------------------

fn build_menu(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::SubmenuBuilder;

    // macOS 应用菜单：Cmd+Q 退出 / Cmd+H 隐藏 / 隐藏其他 / 全部显示
    let app_menu = SubmenuBuilder::new(app, "DSH Desktop")
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    // 编辑菜单：Cmd+C / Cmd+V 等（WebView 内复制粘贴）
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    // 窗口菜单：Cmd+M 最小化 / 最大化
    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &edit_menu, &window_menu])
        .build()?;
    app.set_menu(menu)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 软件更新（tauri-plugin-updater）
// ---------------------------------------------------------------------------

fn check_for_updates(app: &AppHandle) {
    use tauri_plugin_updater::UpdaterExt;
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let notify = |msg: String| {
            if let Some(window) = handle.get_webview_window("main") {
                let js = format!("alert({});", serde_json::to_string(&msg).unwrap_or_default());
                let _ = window.eval(&js);
            }
        };
        let updater = match handle.updater() {
            Ok(u) => u,
            Err(e) => {
                notify(format!("更新器初始化失败：{}", e));
                return;
            }
        };
        match updater.check().await {
            Ok(Some(update)) => {
                notify(format!("发现新版本 v{}，开始下载…", update.version));
                match update.download_and_install(|_chunk, _total| {}, || {}).await {
                    Ok(_) => notify("更新完成，请重启 DSH Desktop 生效".into()),
                    Err(e) => notify(format!("更新下载失败：{}", e)),
                }
            }
            Ok(None) => notify("当前已是最新版本".into()),
            Err(e) => notify(format!("检查更新失败：{}", e)),
        }
    });
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

pub fn run() {
    tauri::Builder::default()
        .manage(BackendState {
            child: Mutex::new(None),
        })
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            #[cfg(unix)]
            {
                let _ = APP_HANDLE.set(app.handle().clone());
                install_signal_handlers();
            }
            build_tray(app.handle())?;
            build_menu(app.handle())?;
            start_backend(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            // 关闭窗口 = 隐藏到托盘（不退出后端）
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // 应用退出时清理自己拉起的后端子进程
            if let tauri::RunEvent::Exit = event {
                if let Some(mut child) = app_handle
                    .state::<BackendState>()
                    .child
                    .lock()
                    .unwrap()
                    .take()
                {
                    kill_child(&mut child);
                }
            }
        });
}
