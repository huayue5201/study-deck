#!/usr/bin/env bash
# 开发模式：Rust 服务 + Vite HMR（两个进程，Ctrl+C 一起退出）
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] && { set -a; . ./.env; set +a; }
trap 'kill 0' EXIT

( cd apps/web && npm install --silent && npm run dev ) &
cargo run -p server
