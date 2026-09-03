#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TRANSFER_ENV="$SCRIPT_DIR/transfer.env"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
RUNTIME_DUMP="$ROOT/database/yuxiaoman_dev.pgdump"
TEST_DUMP="$ROOT/database/yuxiaoman_test.pgdump"

node "$SCRIPT_DIR/prepare-transfer-env.mjs"
set -a
# shellcheck disable=SC1090
source "$TRANSFER_ENV"
set +a

for value in "$POSTGRES_USER" "$POSTGRES_DB" "$POSTGRES_TEST_DB"; do
  if [[ ! "$value" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]]; then
    echo "数据库标识符不安全，已停止。" >&2
    exit 1
  fi
done

if [[ ! -f "$RUNTIME_DUMP" ]]; then
  echo "缺少数据库快照：$RUNTIME_DUMP" >&2
  exit 1
fi

compose=(docker compose --env-file "$TRANSFER_ENV" -f "$COMPOSE_FILE")
"${compose[@]}" up -d db >/dev/null

for _ in {1..60}; do
  if "${compose[@]}" exec -T db pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
"${compose[@]}" exec -T db pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null

database_exists() {
  "${compose[@]}" exec -T db psql -X -U "$POSTGRES_USER" -d postgres -tAc \
    "SELECT count(*) FROM pg_database WHERE datname = '$1';" | tr -d '[:space:]'
}

table_count() {
  "${compose[@]}" exec -T db psql -X -U "$POSTGRES_USER" -d "$1" -tAc \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type='BASE TABLE';" | tr -d '[:space:]'
}

recreate_database() {
  local database="$1"
  "${compose[@]}" exec -T db psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$database' AND pid <> pg_backend_pid();" >/dev/null
  "${compose[@]}" exec -T db psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -c \
    "DROP DATABASE IF EXISTS \"$database\";" >/dev/null
  "${compose[@]}" exec -T db psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -c \
    "CREATE DATABASE \"$database\" OWNER \"$POSTGRES_USER\";" >/dev/null
}

restore_if_empty() {
  local database="$1"
  local dump="$2"
  local label="$3"
  if [[ "$(database_exists "$database")" == "0" ]]; then
    "${compose[@]}" exec -T db createdb -U "$POSTGRES_USER" -O "$POSTGRES_USER" "$database"
  fi
  local count
  count="$(table_count "$database")"
  if [[ "${FORCE_RESTORE:-0}" == "1" ]]; then
    recreate_database "$database"
    count="0"
  fi
  if [[ "$count" == "0" && -f "$dump" ]]; then
    echo "正在恢复 $label 快照……"
    "${compose[@]}" exec -T db pg_restore --exit-on-error --no-owner --no-privileges \
      -U "$POSTGRES_USER" -d "$database" < "$dump"
  elif [[ "$count" != "0" ]]; then
    echo "$label 已有 $count 张业务表，跳过覆盖恢复。"
  fi
}

restore_if_empty "$POSTGRES_DB" "$RUNTIME_DUMP" "运行数据库"
restore_if_empty "$POSTGRES_TEST_DB" "$TEST_DUMP" "测试数据库"

runtime_count="$(table_count "$POSTGRES_DB")"
test_count="$(table_count "$POSTGRES_TEST_DB")"
if [[ "$runtime_count" == "0" ]]; then
  echo "运行数据库恢复后没有业务表，已停止。" >&2
  exit 1
fi
echo "数据库可用：运行库 $runtime_count 张业务表，测试库 $test_count 张业务表。"
