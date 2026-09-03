#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOG_DIR="$ROOT/.runtime/macos-handoff-logs"
PID_FILE="$LOG_DIR/pids.env"

for command_name in node npm docker curl; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "缺少命令：$command_name" >&2
    exit 1
  fi
done

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$node_major" != "24" ]]; then
  echo "需要 Node.js 24.x，当前为 $(node --version)。" >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "Docker Desktop 尚未启动，请先打开并等待引擎就绪。" >&2
  exit 1
fi

cd "$ROOT"
node "$SCRIPT_DIR/prepare-transfer-env.mjs"
if [[ -n "${LAN_IP:-}" ]]; then
  node "$SCRIPT_DIR/configure-lan.mjs" "$LAN_IP"
else
  node "$SCRIPT_DIR/configure-lan.mjs"
fi

if [[ "${SKIP_RESTORE:-0}" != "1" ]]; then
  bash "$SCRIPT_DIR/restore-database.sh"
else
  compose=(docker compose --env-file "$SCRIPT_DIR/transfer.env" -f "$SCRIPT_DIR/docker-compose.yml")
  "${compose[@]}" up -d db >/dev/null
fi

if [[ "${SKIP_INSTALL:-0}" != "1" ]]; then
  echo "正在按锁文件安装 macOS 依赖……"
  npm ci
  npm --prefix wechat-miniprogram ci
fi

mkdir -p "$LOG_DIR"
if [[ -f "$PID_FILE" ]]; then
  while IFS='=' read -r _ pid; do
    if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
      echo "已有服务进程仍在运行（PID $pid）；请先运行 stop-all.sh。" >&2
      exit 1
    fi
  done < "$PID_FILE"
fi

nohup node --import tsx scripts/start-mini-api.mjs >"$LOG_DIR/api.log" 2>&1 &
api_pid=$!
(
  cd "$ROOT/admin"
  nohup node ../node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5174 --strictPort \
    >"$LOG_DIR/admin.log" 2>&1 &
  echo "$!" > "$LOG_DIR/admin.pid"
)
admin_pid="$(cat "$LOG_DIR/admin.pid")"
printf 'API_PID=%s\nADMIN_PID=%s\n' "$api_pid" "$admin_pid" > "$PID_FILE"

ready=0
for _ in {1..90}; do
  if curl -fsS http://127.0.0.1:8792/api/health >/dev/null 2>&1 \
    && curl -fsS http://127.0.0.1:5174/ >/dev/null 2>&1; then
    ready=1
    break
  fi
  if ! kill -0 "$api_pid" 2>/dev/null || ! kill -0 "$admin_pid" 2>/dev/null; then
    break
  fi
  sleep 1
done

if [[ "$ready" != "1" ]]; then
  echo "服务未能正常启动。最近日志：" >&2
  tail -n 30 "$LOG_DIR/api.log" "$LOG_DIR/admin.log" >&2 || true
  exit 1
fi

echo
echo "驭小满已启动："
echo "- 运营后台：http://127.0.0.1:5174"
echo "- API 健康检查：http://127.0.0.1:8792/api/health"
echo "- 微信开发者工具导入：$ROOT/wechat-miniprogram"
echo "停止服务：bash handoff/macos/stop-all.sh"
