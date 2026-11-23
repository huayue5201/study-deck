//! 桌面壳：把 HTTP 服务与内嵌前端装进一个 .app。
//! 端口交给系统分配，握手文件（port/pid/api/caps/token）写在应用数据目录里。

use std::{net::SocketAddr, path::PathBuf, sync::OnceLock, time::Duration};

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

/// 后端实际监听的端口，深链跳转要用。
static PORT: OnceLock<u16> = OnceLock::new();

fn error_page(message: &str) -> String {
    let html = format!(
        "<!doctype html><meta charset=utf-8><body style=\"background:#0f1115;color:#e6e8ec;\
         font-family:-apple-system,'PingFang SC',sans-serif;padding:48px;line-height:1.7\">\
         <h2>服务没能启动</h2><p style=\"color:#8b939f\">{}</p>\
         <p style=\"color:#8b939f\">日志：~/Library/Logs/dev.studydeck.app/</p>\
         <p style=\"color:#8b939f\">可以先退出应用再重开；如果反复出现，把日志发给我。</p></body>",
        message.replace('<', "&lt;")
    );
    format!("data:text/html;charset=utf-8,{}", html)
}

/// studydeck://session/<id>[?turn=<id>] → 本地 URL（带 ?session= 让 SPA 直接切过去）
fn deep_link_target(url: &str) -> Option<String> {
    let rest = url.strip_prefix("studydeck://")?;
    let rest = rest.trim_end_matches('/');
    let (path, _query) = match rest.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (rest, None),
    };
    let session = path.strip_prefix("session/")?.trim();
    if session.is_empty() {
        return None;
    }
    let port = PORT.get()?;
    Some(format!("http://127.0.0.1:{port}/?session={session}"))
}

fn navigate(app: &tauri::AppHandle, url: &str) {
    if let Some(target) = deep_link_target(url) {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.navigate(target.parse().expect("valid url"));
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(link) = argv.iter().find(|arg| arg.starts_with("studydeck://")) {
                navigate(app, link);
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            let data_dir: PathBuf = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| PathBuf::from("data"));
            let log_dir: PathBuf = app
                .path()
                .app_log_dir()
                .unwrap_or_else(|_| data_dir.join("logs"));

            if let Some(guard) = studydeck_server::init_tracing(Some(log_dir)) {
                Box::leak(Box::new(guard));
            }

            std::fs::create_dir_all(&data_dir).ok();
            tracing::info!(?data_dir, "starting study-deck desktop");

            let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();

            let server_data = data_dir.clone();
            std::thread::spawn(move || {
                let runtime = tokio::runtime::Builder::new_multi_thread()
                    .enable_all()
                    .build()
                    .expect("tokio runtime");
                runtime.block_on(async move {
                    let addr: SocketAddr = "127.0.0.1:0".parse().expect("valid addr");
                    if let Err(err) =
                        studydeck_server::run_with_ready(addr, server_data, Some(ready_tx)).await
                    {
                        tracing::error!("server stopped: {err}");
                    }
                });
            });

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let url = match tokio::time::timeout(Duration::from_secs(15), ready_rx).await {
                    Ok(Ok(addr)) => {
                        tracing::info!(%addr, "server ready");
                        PORT.set(addr.port()).ok();
                        format!("http://{addr}")
                    }
                    Ok(Err(_)) => error_page("服务线程提前退出。"),
                    Err(_) => error_page("等待超过 15 秒仍未就绪。"),
                };

                let parsed = match url.parse() {
                    Ok(value) => value,
                    Err(_) => {
                        tracing::error!("invalid window url");
                        return;
                    }
                };

                if let Err(err) =
                    WebviewWindowBuilder::new(&handle, "main", WebviewUrl::External(parsed))
                        .title("StudyDeck")
                        .inner_size(1320.0, 880.0)
                        .min_inner_size(900.0, 600.0)
                        .build()
                {
                    tracing::error!("window failed: {err}");
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // macOS 的深链走这里（不是 argv）
            if let RunEvent::Opened { urls } = event {
                for url in urls {
                    navigate(app, url.as_str());
                }
            }
        });
}
