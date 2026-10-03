#!/usr/bin/env bash
# Backup PostgreSQL cho LoaViet — pg_dump custom format (nén, restore được từng object).
#
# Cách dùng:
#   ./scripts/backup-db.sh --url "$DATABASE_URL" --name loaviet
#   ./scripts/backup-db.sh --url "$DATABASE_URL" --keep 30        # xoá bản cũ hơn 30 (tuỳ chọn)
#
# Yêu cầu: pg_dump >= 15 trên máy chạy script (cùng major version với server).
# KHÔNG xoá backup trừ khi truyền --keep N rõ ràng.
set -euo pipefail

usage() { sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

URL="${BACKUP_DATABASE_URL:-}"
NAME="speaker_platform"
OUT_DIR="$(pwd)/backups"
KEEP=""

while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --out) OUT_DIR="$2"; shift 2 ;;
    --keep) KEEP="$2"; shift 2 ;;
    *) echo "Tham số lạ: $1" >&2; usage ;;
  esac
done

[ -n "$URL" ] || { echo "✗ Thiếu --url (hoặc biến BACKUP_DATABASE_URL)" >&2; usage; }
command -v pg_dump >/dev/null || { echo "✗ Không tìm thấy pg_dump — cài postgresql-client" >&2; exit 1; }

mkdir -p "$OUT_DIR"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$OUT_DIR/db-${NAME}-${TS}.dump"

echo "→ pg_dump custom format → $FILE"
pg_dump "$URL" --format=custom --file="$FILE"

# Kiểm tra tính toàn vẹn KHÔNG phá hủy: đọc table of contents từ archive
echo "→ Verify archive (pg_restore --list):"
pg_restore --list "$FILE" | head -5
echo "  … ($(pg_restore --list "$FILE" | grep -c 'TABLE DATA') bảng dữ liệu trong archive)"
echo "✓ Backup xong: $FILE ($(du -h "$FILE" | cut -f1))"

# Retention — CHỈ khi --keep N truyền vào
if [ -n "$KEEP" ]; then
  echo "→ Retention: giữ $KEEP bản mới nhất của $NAME"
  ls -t "$OUT_DIR"/db-"${NAME}"-*.dump 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
    echo "  xoá: $old"
    rm "$old"
  done
else
  echo "  (không truyền --keep → giữ toàn bộ backup)"
fi
