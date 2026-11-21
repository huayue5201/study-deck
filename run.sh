#!/usr/bin/env bash
# 生产式启动：先构建前端，再由 Rust 服务托管静态文件
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] && { set -a; . ./.env; set +a; }

if [ ! -d apps/web/dist ]; then
  echo "==> 构建前端"
  ( cd apps/web && npm install && npm run build )
fi

echo "==> 启动服务 http://${STUDYDECK_ADDR:-127.0.0.1:8787}"
exec cargo run -p server --release
