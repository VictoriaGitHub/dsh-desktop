#!/usr/bin/env bash
# 构建 DSH Desktop（含更新签名）
# 用法: ./scripts/build.sh [tauri build 额外参数]
set -euo pipefail
cd "$(dirname "$0")/.."

KEY_PATH="${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/.tauri/dsh-desktop.key}"
# tauri build 只认 TAURI_SIGNING_PRIVATE_KEY（私钥内容），不认 PATH 变量
export TAURI_SIGNING_PRIVATE_KEY="${TAURI_SIGNING_PRIVATE_KEY:-$(cat "$KEY_PATH")}"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${DSH_UPDATE_KEY_PASSWORD:-dsh-desktop-update-2026}"

echo "[build] 使用更新签名密钥: $KEY_PATH"
pnpm tauri build "$@"
