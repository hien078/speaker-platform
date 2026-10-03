#!/usr/bin/env bash
# Restore PostgreSQL cho LoaViet — CHỈ restore vào database MỚI, không bao giờ đè.
#
# Cách dùng:
#   ./scripts/restore-db.sh --file backups/db-loaviet-20260101T000000Z.dump --url "$ADMIN_URL" --verify
#   ./scripts/restore-db.sh --file backups/db-x.dump --url "$ADMIN_URL" --into loaviet_restored
#
# An toàn:
#   - Từ chối nếu database đích ĐÃ TỒN TẠI (không đè dữ liệu đang có).
#   - Từ chối restore vào database cùng tên nguồn (đích phải là tên mới).
#   - --verify: restore vào scratch DB <tên file>_verify_<ts>, đếm bảng, so với
#     nguồn trong archive, BÁO CÁO — không đụng DB thật. Scratch DB để lại
#     cho người vận hành tự xoá (lệnh in ra cuối).
set -euo pipefail

usage() { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

FILE=""
URL="${RESTORE_ADMIN_DATABASE_URL:-}"
MODE=""
INTO=""

while [ $# -gt 0 ]; do
  case "$1" in
    --file) FILE="$2"; shift 2 ;;
    --url) URL="$2"; shift 2 ;;
    --verify) MODE="verify"; shift ;;
    --into) MODE="into"; INTO="$2"; shift 2 ;;
    *) echo "Tham số lạ: $1" >&2; usage ;;
  esac
done

[ -n "$FILE" ] && [ -n "$URL" ] && [ -n "$MODE" ] || usage
[ -f "$FILE" ] || { echo "✗ Không thấy file backup: $FILE" >&2; exit 1; }
command -v pg_restore >/dev/null || { echo "✗ Không tìm thấy pg_restore" >&2; exit 1; }
command -v psql >/dev/null || { echo "✗ Không tìm thấy psql" >&2; exit 1; }

# Tên database đi vào SQL (pg_database, CREATE DATABASE) — CHỈ nhận charset
# an toàn [a-z_][a-z0-9_]* trước khi chạm bất kỳ query nào (chống injection
# qua --into / tên trong archive).
safe_dbname() {
  case "$1" in
    ''|*[!a-z0-9_]*) return 1 ;;
    [0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

if [ "$MODE" = "into" ]; then
  safe_dbname "$INTO" || { echo "✗ --into chỉ nhận [a-z_][a-z0-9_]* (nhận '$INTO')" >&2; exit 1; }
fi

# Tên nguồn từ header comment của archive ("; dbname: <tên>")
SRC_NAME="$(pg_restore --list "$FILE" | sed -n 's/^;[[:space:]]*dbname:[[:space:]]*//p' | head -1 | tr -d '\r')"
[ -n "$SRC_NAME" ] || { echo "✗ Không đọc được tên database nguồn từ archive" >&2; exit 1; }
safe_dbname "$SRC_NAME" || { echo "✗ Tên database nguồn trong archive không an toàn: '$SRC_NAME'" >&2; exit 1; }
echo "→ Archive nguồn: database '$SRC_NAME' ($(pg_restore --list "$FILE" | grep -c 'TABLE DATA') bảng dữ liệu)"

db_exists() {
  psql "$URL" -tAc "SELECT 1 FROM pg_database WHERE datname='$1'" | grep -q 1
}

create_db() {
  psql "$URL" -c "CREATE DATABASE \"$1\"" >/dev/null
}

if [ "$MODE" = "verify" ]; then
  TARGET="${SRC_NAME}_restore_verify_$(date -u +%Y%m%dT%H%M%SZ)"
else
  TARGET="$INTO"
  [ -n "$TARGET" ] || { echo "✗ --into cần tên database" >&2; usage; }
  [ "$TARGET" != "$SRC_NAME" ] || { echo "✗ Đích phải là tên MỚI (khác nguồn '$SRC_NAME') — không đè DB nguồn" >&2; exit 1; }
fi

if db_exists "$TARGET"; then
  echo "✗ Database '$TARGET' đã tồn tại — từ chối đè. Chọn tên khác." >&2
  exit 1
fi

# URL đích = URL nguồn với segment database thay bằng $TARGET (giữ query params)
base="${URL%%\?*}"
q="${URL#*\?}"; [ "$q" = "$URL" ] && q=""
TARGET_URL="${base%/*}/$TARGET"
[ -n "$q" ] && TARGET_URL="$TARGET_URL?$q"

echo "→ CREATE DATABASE $TARGET (mới — không đè gì đang có)"
create_db "$TARGET"

# Restore: archive custom format chứa DB name gốc — restore qua URL đích
echo "→ pg_restore vào $TARGET…"
pg_restore --no-owner --no-privileges --dbname="$TARGET_URL" "$FILE" || {
  echo "✗ pg_restore lỗi — database $TARGET để lại trạng thái một phần" >&2
  exit 1
}

TABLES="$(psql "$TARGET_URL" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
echo "✓ Restore xong: $TARGET — $TABLES bảng trong schema public"
if [ "$MODE" = "verify" ]; then
  # So sánh best-effort với DB nguồn (nếu còn kết nối được) — không fail verify vì điều này
  SRC_URL="${base%/*}/$SRC_NAME"; [ -n "$q" ] && SRC_URL="$SRC_URL?$q"
  SRC_TABLES="$(psql "$SRC_URL" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" 2>/dev/null || echo '?')"
  SRC_USERS="$(psql "$SRC_URL" -tAc 'SELECT count(*) FROM "User"' 2>/dev/null || echo '?')"
  TGT_USERS="$(psql "$TARGET_URL" -tAc 'SELECT count(*) FROM "User"' 2>/dev/null || echo '?')"
  echo "  So sánh với nguồn: bảng $SRC_TABLES → đích $TABLES · dòng User $SRC_USERS → đích $TGT_USERS"
  echo ""
  echo "Kết quả verify (non-destructive): đã restore vào DB MỚI $TARGET."
  echo "Kiểm tra thêm bằng tay nếu muốn, rồi dọn khi sẵn sàng (KHÔNG in URL có mật khẩu ở đây):"
  echo "  psql \"<URL quản trị>\" -c 'DROP DATABASE \"$TARGET\"'"
fi
