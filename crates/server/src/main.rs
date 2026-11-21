//! CLI 入口：读环境变量，启动 HTTP 服务。

use std::{net::SocketAddr, path::PathBuf};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _guard = studydeck_server::init_tracing(None);

    let addr: SocketAddr = std::env::var("STUDYDECK_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:8787".to_string())
        .parse()?;
    let data_dir = PathBuf::from(std::env::var("STUDYDECK_DATA").unwrap_or_else(|_| "data".into()));

    studydeck_server::run(addr, data_dir).await
}
