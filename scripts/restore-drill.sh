#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# restore-drill.sh — backup + restore drill (Batch 8 Task 6 — spec §9 Batch 8
# gate "restore drill successful"; FD-R36: ĐO RTO/RPO thực tế, KHÔNG bịa mục tiêu).
#
# Chạy END-TO-END trên stack SCRATCH do script tự tạo + tự dọn — KHÔNG đụng DB
# production, DB dev, hay stack có sẵn (test-integration.sh safety pattern):
#
#   1. Scratch source DB: container postgres:16-alpine riêng (sp-drill-pg-$$),
#      network riêng (sp-drill-net-$$), port random trên 127.0.0.1, password
#      random (KHÔNG in ra — chỉ dùng trong stack throwaway).
#   2. Migrate graph THẬT: npx prisma db migrate --to production (host, qua port
#      scratch — như scripts/test-integration.sh).
#   3. Seed fixture tối thiểu qua tsx + ORM (KHÔNG raw psql — ORM tôn trọng
#      contract, raw SQL có thể drift): 2 User (seller/buyer), 1 Category,
#      1 Listing, finance-preservation fixture 1 Order + 1 OrderItem +
#      1 Payment (chứng minh các bảng finance restore nguyên vẹn).
#   4. Client-tools container (sp-drill-client-$$) cùng network scratch, repo
#      mount /work — backup-db.sh + restore-db.sh chạy BÊN TRONG (pattern
#      scripts/db-ops.sh): pg_dump/pg_restore/psql là tool của chính image
#      postgres:16-alpine (cùng image với server → khớp major version theo
#      cấu trúc) — KHÔNG host pg tools, KHÔNG cài postgresql-client trên host.
#   5. Backup: backup-db.sh --name drill (script thật, in-container — hành vi
#      *.partial → kiểm tra TOC → rename được exercise).
#   6. Restore: restore-db.sh --into drill_restored (script thật, in-container
#      — restore vào DB MỚI, không bao giờ đè).
#   7. Verify (in-container psql + host prisma CLI): table count parity,
#      row counts, seeded rows read back equal, prisma db verify (marker +
#      schema) — in PASS/FAIL TỪNG check.
#   8. Đo: backup duration, restore duration (RTO đo được), dump size, backup
#      freshness (RPO đo được = tuổi bản backup lúc verify) — date +%s + du -h.
#   9. Trap cleanup: DROP DATABASE drill_restored, xoá 2 container + network +
#      dump + file seed tạm.
#
# Usage:
#   bash scripts/restore-drill.sh                            # scratch mode (mặc định)
#   bash scripts/restore-drill.sh --file backups/db-loaviet-<ts>.dump
#                                                            # drill với backup THẬT qua
#                                                            # ./scripts/db-ops.sh verify <file>
#                                                            # (chạy trên server production —
#                                                            # đường dẫn gate evidence khuyến nghị;
#                                                            # scratch mode chỉ chứng minh script)
#
# Evidence: block EVIDENCE ở cuối output được operator paste vào
# docs/operations/restore-drill-evidence.md (mục dated) — G6.
# ─────────────────────────────────────────────────────────────────────────────
set -Eeuo pipefail
cd "$(dirname "$0")/.."

usage() { sed -n '2,45p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

# ─── Config ───────────────────────────────────────────────────────────────────

PG_IMAGE="${PG_IMAGE:-postgres:16-alpine}"
DB_USER="speaker"
DB_NAME="speaker_drill"        # scratch source db (tên mới — server scratch rỗng)
RESTORED_NAME="drill_restored" # đích restore — restore-db.sh chỉ nhận [a-z_][a-z0-9_]*

# ─── Mode dispatch ───────────────────────────────────────────────────────────

MODE="scratch"
FILE=""
case "${1:-}" in
  "") ;;
  --file)
    [ $# -eq 2 ] || usage
    FILE="$2"
    MODE="file"
    ;;
  *) usage ;;
esac

# ─── Cleanup trap (trước mọi thứ khác — luôn dọn phần đã tạo) ──────────────────

SERVER=""; CLIENT=""; NET=""; DRILL_DIR=""; SEED_FILE=""; WORK_DIR=""
cleanup() {
  # DROP DATABASE restored (nếu đã restore) — server còn chạy mới drop được.
  if [ -n "$SERVER" ] && [ -n "$CLIENT" ]; then
    docker exec "$CLIENT" psql "postgresql://$DB_USER@$SERVER:5432/postgres" \
      -c "DROP DATABASE IF EXISTS \"$RESTORED_NAME\"" >/dev/null 2>&1 || true
  fi
  [ -n "$CLIENT" ] && docker rm -f "$CLIENT" >/dev/null 2>&1 || true
  [ -n "$SERVER" ] && docker rm -f "$SERVER" >/dev/null 2>&1 || true
  [ -n "$NET" ] && docker network rm "$NET" >/dev/null 2>&1 || true
  [ -n "$DRILL_DIR" ] && rm -rf "$DRILL_DIR" || true
  [ -n "$SEED_FILE" ] && rm -f "$SEED_FILE" || true
  [ -n "$WORK_DIR" ] && rm -rf "$WORK_DIR" || true
}
trap cleanup EXIT

# ─── --file mode: drill với backup THẬT qua db-ops.sh verify (production) ──────
# Các bước verify chạy qua chính scripts/db-ops.sh verify <file> (restore vào DB
# mới <tên>_restore_verify_<ts>, đếm bảng + so dòng User với nguồn — in-container,
# không host pg tools). DB verify để lại cho operator tự xoá (lệnh in sẵn trong
# output) — drill KHÔNG tự drop gì trên stack production.

if [ "$MODE" = "file" ]; then
  [ -f "$FILE" ] || { echo "✗ Không thấy file backup: $FILE" >&2; exit 1; }
  [ -f scripts/db-ops.sh ] || { echo "✗ Chạy từ thư mục gốc của repo (không thấy scripts/db-ops.sh)" >&2; exit 1; }
  command -v docker >/dev/null || { echo "✗ Không tìm thấy docker" >&2; exit 1; }

  FILE_SIZE="$(du -h "$FILE" | cut -f1)"
  FILE_MTIME="$(node -e 'const fs=require("node:fs");console.log(Math.round(fs.statSync(process.argv[1]).mtimeMs/1000))' "$FILE")"
  FRESHNESS_SECS=$(( $(date +%s) - FILE_MTIME ))

  echo "── drill --file: verify backup thật qua db-ops.sh (stack production)"
  echo "── file: $FILE ($FILE_SIZE, tuổi ${FRESHNESS_SECS}s)"
  T0="$(date +%s)"
  ./scripts/db-ops.sh verify "$FILE"
  VERIFY_SECS=$(( $(date +%s) - T0 ))

  echo ""
  echo "════ EVIDENCE — paste vào docs/operations/restore-drill-evidence.md ════"
  echo "- Ngày (UTC): $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "- Host: $(hostname)"
  echo "- Mode: --file (backup thật, db-ops.sh verify — production)"
  echo "- File: $FILE ($FILE_SIZE) · backup freshness (RPO đo được): ${FRESHNESS_SECS}s"
  echo "- Verify duration (restore vào DB mới + so bảng): ${VERIFY_SECS}s"
  echo "- DB verify scratch (<tên>_restore_verify_<ts>) ĐỂ LẠI — dọn bằng lệnh in sẵn trong output trên."
  echo "══════════════════════════════════════════════════════════════════════════"
  echo "PASS: drill --file xong (kết quả verify xem trong output db-ops.sh ở trên)."
  exit 0
fi

# ─── Scratch mode ─────────────────────────────────────────────────────────────

[ -f scripts/backup-db.sh ] && [ -f scripts/restore-db.sh ] \
  || { echo "✗ Chạy từ thư mục gốc của repo (không thấy scripts/backup-db.sh)" >&2; exit 1; }
command -v docker >/dev/null || { echo "✗ Không tìm thấy docker" >&2; exit 1; }
command -v node >/dev/null || { echo "✗ Không tìm thấy node (cần node + npx cho prisma CLI/tsx)" >&2; exit 1; }

# port chưa dùng (test-integration.sh pattern — không đụng service đang chạy)
pick_port() {
  node -e 'const net=require("node:net");const s=net.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();});'
}

PORT="$(pick_port)"
SERVER="sp-drill-pg-$$"
CLIENT="sp-drill-client-$$"
NET="sp-drill-net-$$"
DB_PASS="drill-$(openssl rand -hex 12 2>/dev/null || echo defaultpw123456)" # KHÔNG in ra

# URL có mật khẩu (host — migrate/seed/db-verify): KHÔNG bao giờ echo.
DB_URL="postgresql://$DB_USER:$DB_PASS@127.0.0.1:$PORT/$DB_NAME"
RESTORED_HOST_URL="postgresql://$DB_USER:$DB_PASS@127.0.0.1:$PORT/$RESTORED_NAME"
# URL in-container (KHÔNG chứa mật khẩu — libpq đọc PGPASSWORD, db-ops.sh pattern):
SRC_URL_IN="postgresql://$DB_USER@$SERVER:5432/$DB_NAME"
ADMIN_URL_IN="postgresql://$DB_USER@$SERVER:5432/postgres"
RESTORED_URL_IN="postgresql://$DB_USER@$SERVER:5432/$RESTORED_NAME"

# backup dir tạm dưới backups/ (gitignored) — mount qua repo /work; dump KHÔNG commit.
mkdir -p backups
DRILL_DIR="$(mktemp -d "$(pwd)/backups/.drill-backup.XXXXXX")"
BACKUP_OUT_IN="/work/backups/$(basename "$DRILL_DIR")" # đường dẫn trong client container
WORK_DIR="$(mktemp -d)" # file tạm cho verify diff — xoá ở trap

echo "── restore drill (scratch): server=$SERVER client=$CLIENT network=$NET port=$PORT"

# ─── 1. Scratch source DB ─────────────────────────────────────────────────────

docker network create "$NET" >/dev/null
docker run -d --rm --name "$SERVER" --network "$NET" \
  -e POSTGRES_USER="$DB_USER" -e POSTGRES_PASSWORD="$DB_PASS" -e POSTGRES_DB="$DB_NAME" \
  -p "127.0.0.1:$PORT:5432" \
  "$PG_IMAGE" >/dev/null

# đợi postgres sẵn sàng (trong container mình tạo — test-integration.sh pattern)
for i in $(seq 1 30); do
  if docker exec "$SERVER" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then break; fi
  sleep 1
  if [ "$i" -eq 30 ]; then echo "FAIL: postgres scratch không sẵn sàng sau 30s" >&2; exit 1; fi
done

# ─── 2. Migrate graph thật → ref 'production' (host, qua port scratch) ─────────

echo "── migrate graph → ref 'production' (scratch DB)"
if ! DATABASE_URL="$DB_URL" npx prisma db migrate --to production >"$WORK_DIR/migrate.log" 2>&1; then
  echo "✗ prisma db migrate lỗi:" >&2
  sed -n '1,30p' "$WORK_DIR/migrate.log" >&2 || true
  exit 1
fi
echo "    ✓ migrate xong: $(ls migrations/app | grep -v '^refs$' | tr '\n' ' ')"

# ─── 3. Seed fixture qua tsx + ORM (KHÔNG raw psql) ────────────────────────────

SEED_FILE="$(pwd)/scripts/.restore-drill-seed.$$.ts" # xoá ở trap
cat > "$SEED_FILE" <<'SEED_EOF'
// Seed fixture drill — tsx + ORM (KHÔNG raw psql: ORM tôn trọng contract, raw
// SQL có thể drift). DATABASE_URL phải có trong env THẬT trước khi nạp
// db.client (D4 — pattern scripts/admin-bootstrap.ts; dotenv chỉ bổ sung config).
if (!process.env.DATABASE_URL) {
  console.error("✗ DATABASE_URL chưa đặt — drill seed cần DB scratch rõ ràng");
  process.exit(1);
}
const { db } = await import("../src/prisma/db.client");
try {
  // 2 User (Order cần cả buyerId + sellerId — fixture tối thiểu, dữ liệu giả).
  const seller = await db.orm.public.User.create({
    email: "drill-seller@example.com",
    passwordHash: "drill-fixture-not-a-real-hash",
    name: "Drill Seller",
    role: "seller",
    city: "drill-city",
  });
  const buyer = await db.orm.public.User.create({
    email: "drill-buyer@example.com",
    passwordHash: "drill-fixture-not-a-real-hash",
    name: "Drill Buyer",
    role: "buyer",
    city: "drill-city",
  });
  // Category (FK bắt buộc của Listing).
  const category = await db.orm.public.Category.create({
    name: "Drill Category",
    slug: "drill-category",
    commissionRate: 5,
  });
  const listing = await db.orm.public.Listing.create({
    sellerId: seller.id,
    categoryId: category.id,
    title: "Drill Portable Speaker",
    slug: "drill-portable-speaker",
    description: "drill fixture listing (scratch)",
    condition: "good",
    price: 1000000,
    city: "drill-city",
  });
  // Finance-preservation fixture: 1 Order + 1 OrderItem + 1 Payment — chứng minh
  // các bảng finance (Batch 1 shutdown giữ dữ liệu lịch sử) restore nguyên vẹn.
  const order = await db.orm.public.Order.create({
    code: "DRILL-0001",
    buyerId: buyer.id,
    sellerId: seller.id,
    status: "awaiting_payment",
    totalAmount: 1000000,
    commissionRate: 5,
    commissionAmount: 50000,
    sellerPayout: 950000,
    paymentMethod: "escrow",
    shippingAddress: "drill-shipping-address",
    shippingPhone: "0900000000",
  });
  const orderItem = await db.orm.public.OrderItem.create({
    orderId: order.id,
    listingId: listing.id,
    title: "Drill Portable Speaker",
    price: 1000000,
    quantity: 1,
  });
  const payment = await db.orm.public.Payment.create({
    orderId: order.id,
    method: "escrow",
    status: "pending",
    amount: 1000000,
    provider: "mock",
  });
  console.log(
    "seed: User=2 Category=1 Listing=1 Order=1 OrderItem=1 Payment=1 " +
      `(order=${order.id} payment=${payment.id})`,
  );
} finally {
  await db.close();
}
SEED_EOF
echo "── seed fixture (tsx + ORM)"
DATABASE_URL="$DB_URL" npx tsx "$SEED_FILE"

# ─── 4. Client-tools container (db-ops.sh pattern — pg tools trong container) ──

docker run -d --rm --name "$CLIENT" --network "$NET" \
  --user "$(id -u):$(id -g)" \
  -e PGPASSWORD="$DB_PASS" -e HOME=/tmp \
  -v "$(pwd):/work" -w /work \
  "$PG_IMAGE" tail -f /dev/null >/dev/null

# psql in-container: unaligned tuples, fail-fast trên SQL error.
q() { docker exec "$CLIENT" psql "$1" -tA -v ON_ERROR_STOP=1 -c "$2"; }

# ─── 5. Backup (script thật, in-container) ────────────────────────────────────

echo "── backup: backup-db.sh (in-container, pg_dump custom format)"
T0="$(date +%s)"
docker exec "$CLIENT" sh scripts/backup-db.sh --url "$SRC_URL_IN" --name drill --out "$BACKUP_OUT_IN"
BACKUP_SECS=$(( $(date +%s) - T0 ))

DUMP="$(ls -t "$DRILL_DIR"/db-drill-*.dump 2>/dev/null | head -1 || true)"
[ -n "$DUMP" ] && [ -f "$DUMP" ] || { echo "✗ Không thấy dump trong $DRILL_DIR (backup lỗi?)" >&2; exit 1; }
DUMP_NAME="$(basename "$DUMP")"
DUMP_SIZE="$(du -h "$DUMP" | cut -f1)"
DUMP_MTIME="$(node -e 'const fs=require("node:fs");console.log(Math.round(fs.statSync(process.argv[1]).mtimeMs/1000))' "$DUMP")"

# ─── 6. Restore (script thật, in-container — vào DB MỚI, không đè) ─────────────

echo "── restore: restore-db.sh --into $RESTORED_NAME (in-container, DB mới)"
T2="$(date +%s)"
docker exec "$CLIENT" sh scripts/restore-db.sh --file "$BACKUP_OUT_IN/$DUMP_NAME" --url "$ADMIN_URL_IN" --into "$RESTORED_NAME"
RESTORE_SECS=$(( $(date +%s) - T2 ))

# ─── 7. Verification — PASS/FAIL từng check ────────────────────────────────────

PASS_COUNT=0
FAIL_COUNT=0
check() {
  if [ "$1" = "PASS" ]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    echo "    ✓ PASS: $2"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    echo "    ✗ FAIL: $2"
  fi
}

echo "── verify 1/4: table count parity (schema public)"
SRC_TABLES="$(q "$SRC_URL_IN" "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
TGT_TABLES="$(q "$RESTORED_URL_IN" "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
if [ "$SRC_TABLES" = "$TGT_TABLES" ]; then
  check PASS "table count parity: $SRC_TABLES bảng (public) — source == restored"
else
  check FAIL "table count parity: source=$SRC_TABLES restored=$TGT_TABLES"
fi

echo "── verify 2/4: row counts (fixture tables)"
for t in User Listing Order OrderItem Payment Category; do
  s="$(q "$SRC_URL_IN" "SELECT count(*) FROM \"$t\"")"
  r="$(q "$RESTORED_URL_IN" "SELECT count(*) FROM \"$t\"")"
  if [ "$s" = "$r" ]; then
    check PASS "row count $t: $s == $r"
  else
    check FAIL "row count $t: source=$s restored=$r"
  fi
done

echo "── verify 3/4: seeded rows read back equal (toàn bộ dòng từng bảng, source vs restored)"
for t in User Listing Order OrderItem Payment Category; do
  q "$SRC_URL_IN" "SELECT * FROM \"$t\" ORDER BY id" > "$WORK_DIR/src.$t.txt"
  q "$RESTORED_URL_IN" "SELECT * FROM \"$t\" ORDER BY id" > "$WORK_DIR/tgt.$t.txt"
  if diff -q "$WORK_DIR/src.$t.txt" "$WORK_DIR/tgt.$t.txt" >/dev/null; then
    check PASS "read back equal: $t ($(wc -l < "$WORK_DIR/src.$t.txt" | tr -d ' ') dòng byte-equal)"
  else
    check FAIL "read back equal: $t — diff:"
    diff -u "$WORK_DIR/src.$t.txt" "$WORK_DIR/tgt.$t.txt" | sed -n '1,20p' || true
  fi
done

echo "── verify 4/4: prisma db verify (marker + schema khớp contract) trên $RESTORED_NAME"
if DATABASE_URL="$RESTORED_HOST_URL" npx prisma db verify >"$WORK_DIR/db-verify.log" 2>&1; then
  check PASS "prisma db verify: marker + schema khớp contract (exit 0)"
else
  check FAIL "prisma db verify — exit ≠ 0:"
  sed -n '1,20p' "$WORK_DIR/db-verify.log" || true
fi

FRESHNESS_SECS=$(( $(date +%s) - DUMP_MTIME ))

# ─── 8. Evidence block (operator paste vào restore-drill-evidence.md) ─────────

echo ""
echo "════ EVIDENCE — paste vào docs/operations/restore-drill-evidence.md ════"
echo "- Ngày (UTC): $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "- Host: $(hostname) (docker $(docker --version | cut -d' ' -f3 | tr -d ','))"
echo "- Mode: scratch (server=$SERVER client=$CLIENT network=$NET — stack throwaway, đã dọn ở trap)"
echo "- Migrate: prisma db migrate --to production — graph: $(ls migrations/app | grep -v '^refs$' | tr '\n' ' ')"
echo "- Backup: backup-db.sh in-container — ${BACKUP_SECS}s · dump $DUMP_NAME ($DUMP_SIZE)"
echo "- Restore: restore-db.sh --into $RESTORED_NAME (DB mới, không đè) — ${RESTORE_SECS}s"
echo "- RTO đo được (restore): ${RESTORE_SECS}s · RPO đo được (backup freshness lúc verify): ${FRESHNESS_SECS}s"
echo "- Checks: $PASS_COUNT PASS / $FAIL_COUNT FAIL (table parity · row counts · read-back equal · prisma db verify)"
echo "══════════════════════════════════════════════════════════════════════════"

if [ "$FAIL_COUNT" -eq 0 ]; then
  echo ""
  echo "PASS: restore drill xong — mọi check PASS. Scratch stack + dump dọn ở trap EXIT."
else
  echo ""
  echo "FAIL: $FAIL_COUNT check FAIL — defect nằm trong drill script hoặc backup/restore scripts — sửa ở đó, KHÔNG yếu hoá check."
  exit 1
fi
