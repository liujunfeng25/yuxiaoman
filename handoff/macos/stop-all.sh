#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PID_FILE="$ROOT/.runtime/macos-handoff-logs/pids.env"

if [[ -f "$PID_FILE" ]]; then
  while IFS='=' read -r name pid; do
    if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
      echo "停止 ${name}（PID ${pid}）……"
      kill "$pid" 2>/dev/null || true
      for _ in {1..20}; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.25
      done
      if kill -0 "$pid" 2>/dev/null; then
        kill -KILL "$pid" 2>/dev/null || true
      fi
    fi
  done < "$PID_FILE"
  rm -f "$PID_FILE"
fi

if [[ "${KEEP_DATABASE:-0}" != "1" ]] && command -v docker >/dev/null 2>&1; then
  node "$SCRIPT_DIR/prepare-transfer-env.mjs" >/dev/null
  docker compose --env-file "$SCRIPT_DIR/transfer.env" -f "$SCRIPT_DIR/docker-compose.yml" stop db
fi
echo "已停止驭小满本地服务。"
