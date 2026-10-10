#!/usr/bin/env bash
# Chạy backup-db.sh / restore-db.sh với DB production trong compose stack.
#
# Container `db` KHÔNG publish port ra host (docker-compose.prod.yml), nên
# pg_dump/psql trên host không kết nối được localhost:5432. Script này chạy
# chính các script backup/restore bên trong một container tạm dùng cùng image
# với db (postgres:16-alpine — pg_dump/pg_restore khớp major version), gắn vào
# network của container db. Mật khẩu đi qua biến môi trường PGPASSWORD,
# không nằm trong URL và không hiện trong `ps`.
#
# Cách dùng (chạy từ thư mục repo trên server, vd /opt/loaviet):
#   ./scripts/db-ops.sh backup [--keep 30]
#   ./scripts/db-ops.sh verify backups/db-loaviet-<ts>.dump
#   ./scripts/db-ops.sh restore backups/db-loaviet-<ts>.dump <db_mới>
#
# Cấu hình (tuỳ chọn, mặc định khớp docker-compose.prod.yml):
#   DB_CONTAINER=loaviet-db  DB_USER=loaviet  DB_NAME=loaviet  PG_IMAGE=postgres:16-alpine
#   DB_PASSWORD — nếu không đặt, đọc dòng DB_PASSWORD= trong ./.env
set -euo pipefail

usage() { sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

DB_CONTAINER="${DB_CONTAINER:-loaviet-db}"
DB_USER="${DB_USER:-loaviet}"
DB_NAME="${DB_NAME:-loaviet}"
PG_IMAGE="${PG_IMAGE:-postgres:16-alpine}"

cmd="${1:-}"; [ -n "$cmd" ] || usage
shift

command -v docker >/dev/null || { echo "✗ Không tìm thấy docker" >&2; exit 1; }
[ -f scripts/backup-db.sh ] && [ -f scripts/restore-db.sh ] \
  || { echo "✗ Chạy từ thư mục gốc của repo (không thấy scripts/backup-db.sh)" >&2; exit 1; }

if [ -z "${DB_PASSWORD:-}" ]; then
  [ -f .env ] || { echo "✗ Thiếu DB_PASSWORD (không có biến môi trường, không có ./.env)" >&2; exit 1; }
  # Dòng cuối DB_PASSWORD=..., bỏ cặp nháy bao ngoài (cú pháp .env của compose).
  DB_PASSWORD="$(sed -n 's/^DB_PASSWORD=//p' .env | tail -1 | tr -d '\r')"
  case "$DB_PASSWORD" in
    \"*\") DB_PASSWORD="${DB_PASSWORD#\"}"; DB_PASSWORD="${DB_PASSWORD%\"}" ;;
    \'*\') DB_PASSWORD="${DB_PASSWORD#\'}"; DB_PASSWORD="${DB_PASSWORD%\'}" ;;
  esac
fi
[ -n "$DB_PASSWORD" ] || { echo "✗ DB_PASSWORD rỗng" >&2; exit 1; }

state="$(docker inspect -f '{{.State.Running}}' "$DB_CONTAINER" 2>/dev/null || true)"
[ "$state" = "true" ] || { echo "✗ Container $DB_CONTAINER không chạy" >&2; exit 1; }
NETWORK="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$DB_CONTAINER" | awk '{print $1}')"
[ -n "$NETWORK" ] || { echo "✗ Không xác định được network của $DB_CONTAINER" >&2; exit 1; }

# URL KHÔNG chứa mật khẩu — libpq đọc PGPASSWORD.
DB_URL="postgresql://${DB_USER}@${DB_CONTAINER}:5432/${DB_NAME}"
ADMIN_URL="postgresql://${DB_USER}@${DB_CONTAINER}:5432/postgres"

mkdir -p backups

run() {
  # File backup ghi ra ./backups với uid/gid của người chạy (không phải root).
  PGPASSWORD="$DB_PASSWORD" docker run --rm -i \
    --network "$NETWORK" \
    --user "$(id -u):$(id -g)" \
    -e PGPASSWORD -e HOME=/tmp \
    -v "$(pwd):/work" -w /work \
    "$PG_IMAGE" sh "$@"
}

case "$cmd" in
  backup)
    run scripts/backup-db.sh --url "$DB_URL" --name "$DB_NAME" --out /work/backups "$@"
    ;;
  verify)
    [ $# -eq 1 ] || usage
    run scripts/restore-db.sh --file "$1" --url "$ADMIN_URL" --verify
    ;;
  restore)
    [ $# -eq 2 ] || usage
    run scripts/restore-db.sh --file "$1" --url "$ADMIN_URL" --into "$2"
    ;;
  *) usage ;;
esac
