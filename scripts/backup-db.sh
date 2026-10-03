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

# Validate đầu vào TRƯỚC khi chạm filesystem (tên đi vào tên file + ls pipeline)
safe_name() {
  case "$1" in
    ''|*[!A-Za-z0-9._-]*) return 1 ;;
    *) return 0 ;;
  esac
}
safe_name "$NAME" || { echo "✗ --name chỉ chứa chữ/số/._- (nhận '$NAME')" >&2; exit 1; }
if [ -n "$KEEP" ]; then
  case "$KEEP" in
    ''|*[!0-9]*) echo "✗ --keep phải là số nguyên không âm (nhận '$KEEP')" >&2; exit 1 ;;
  esac
fi

mkdir -p "$OUT_DIR"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$OUT_DIR/db-${NAME}-${TS}.dump"

echo "→ pg_dump custom format → $FILE"
pg_dump "$URL" --format=custom --file="$FILE"

# Kiểm tra tính toàn vẹn KHÔNG phá hủy: đọc TOC từ archive.
# sed -n '1,5p' đọc TOÀN BỘ input (không đóng pipe sớm như head —
# pg_restore bị SIGPIPE dưới 'set -o pipefail' sẽ giết script ở đây).
TOC="$(pg_restore --list "$FILE")"
echo "→ Verify archive (pg_restore --list):"
printf '%s\n' "$TOC" | sed -n '1,5p'
echo "  … ($(printf '%s\n' "$TOC" | grep -c 'TABLE DATA') bảng dữ liệu trong archive)"
echo "✓ Backup xong: $FILE ($(du -h "$FILE" | cut -f1))"

# Retention — CHỈ khi --keep N truyền vào (đã validate số nguyên không âm)
if [ -n "$KEEP" ]; then
  echo "→ Retention: giữ $KEEP bản mới nhất của $NAME"
  # tên file đã an toàn charset (NAME validated) → ls parse được
  ls -t "$OUT_DIR"/db-"$NAME"-*.dump 2>/dev/null | tail -n "+$((KEEP + 1))" | while read -r old; do
    echo "  xoá: $old"
    rm "$old"
  done
else
  echo "  (không truyền --keep → giữ toàn bộ backup)"
fi
