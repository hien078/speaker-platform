#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# restore-drill.sh — backup + restore drill (Batch 8 Task 6 — spec §9 Batch 8
# gate "restore drill successful"; FD-R36: ĐO thời gian thực tế, KHÔNG bịa mục tiêu).
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
#   8. Đo: backup duration, restore duration, dump size, backup freshness —
#      date +%s + du -h. SCRATCH timings là thời gian trên fixture nhỏ —
#      KHÔNG phải RPO/RTO production (RPO/RTO thật đo ở chế độ --file).
#   9. Trap cleanup: DROP DATABASE drill_restored, xoá 2 container + network +
#      dump + file seed tạm (chỉ những gì lần chạy này đã tạo).
#
# Usage:
#   bash scripts/restore-drill.sh                            # scratch mode (mặc định)
#   bash scripts/restore-drill.sh --file backups/db-loaviet-<ts>.dump
#                                                            # drill với backup THẬT:
#                                                            # db-ops.sh verify <file>
#                                                            # (restore vào DB mới
#                                                            # <tên>_restore_verify_<ts>)
#                                                            # SAU ĐÓ drill tự chạy ĐẦY ĐỦ
#                                                            # các check (row counts,
#                                                            # read-back equal, prisma db
#                                                            # verify) qua docker exec +
#                                                            # image migrate (compose) —
#                                                            # KHÔNG host pg tools,
#                                                            # KHÔNG đòi hỏi node_modules
#                                                            # trên host (docker-only).
#                                                            # Check KHÔNG chạy được →
#                                                            # "restore smoke only — NOT
#                                                            # gate evidence" + exit ≠ 0.
#                                                            # DB verify được dọn ĐÚNG
#                                                            # theo tên đã sinh.
#
# --file chạy trên server production (stack loaviet-db, DB_PASSWORD từ env/.env
# như db-ops.sh) — đường dẫn gate evidence khuyến nghị; scratch mode chứng minh
# script. File --file phải nằm TRONG repo (db-ops.sh mount repo tại /work).
#
# Evidence: block EVIDENCE ở cuối output được operator paste vào
# docs/operations/restore-drill-evidence.md (mục dated) — G6. REDACT host/IP
# khi paste vào evidence commit.
# ─────────────────────────────────────────────────────────────────────────────
set -Eeuo pipefail
ORIG_PWD="$(pwd)" # resolve --file path TRƯỚC khi cd repo (path của operator)
cd "$(dirname "$0")/.."

usage() { sed -n '2,62p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

# ─── Config ───────────────────────────────────────────────────────────────────

PG_IMAGE="${PG_IMAGE:-postgres:16-alpine}"
NODE_IMAGE="${NODE_IMAGE:-node:22-alpine}" # fallback dev/scratch: container prisma CLI cho --file mode (đường chính là image migrate)

# ─── Mode dispatch ───────────────────────────────────────────────────────────

MODE="scratch"
FILE=""
case "${1:-}" in
  "") ;;
  --file)
    [ $# -eq 2 ] || usage
    FILE="$2"
    case "$FILE" in /*) ;; *) FILE="$ORIG_PWD/$FILE" ;; esac # absolute theo cwd operator
    MODE="file"
    ;;
  *) usage ;;
esac

# ─── Cleanup trap (trước mọi thứ khác — luôn dọn PHẦN MÌNH TẠO) ─────────────────

# Tên/flag track chính xác những gì LẦN CHẠY NÀY tạo ra — trap không đụng gì khác.
SERVER=""; CLIENT=""; NET=""
SERVER_CREATED=0; CLIENT_CREATED=0; NET_CREATED=0
DRILL_DIR=""; SEED_FILE=""; WORK_DIR=""
VERIFY_DB=""; OPS_DB_CONTAINER=""; OPS_DB_USER=""
cleanup() {
  # scratch: DROP DATABASE restored (nếu đã restore) — server còn chạy mới drop được.
  if [ "$SERVER_CREATED" = 1 ] && [ "$CLIENT_CREATED" = 1 ]; then
    docker exec "$CLIENT" psql "postgresql://$SCRATCH_USER@$SERVER:5432/postgres" \
      -c "DROP DATABASE IF EXISTS \"$RESTORED_NAME\"" >/dev/null 2>&1 || true
  fi
  [ "$CLIENT_CREATED" = 1 ] && docker rm -f "$CLIENT" >/dev/null 2>&1 || true
  [ "$SERVER_CREATED" = 1 ] && docker rm -f "$SERVER" >/dev/null 2>&1 || true
  [ "$NET_CREATED" = 1 ] && docker network rm "$NET" >/dev/null 2>&1 || true
  # --file: DROP DB verify ĐÚNG TÊN đã sinh lần này (đã validate charset + dạng
  # <src>_restore_verify_<ts> trước khi gán) — không đụng DB nào khác.
  if [ -n "$VERIFY_DB" ] && [ -n "$OPS_DB_CONTAINER" ]; then
    docker exec "$OPS_DB_CONTAINER" psql -U "$OPS_DB_USER" -d postgres \
      -c "DROP DATABASE IF EXISTS \"$VERIFY_DB\"" >/dev/null 2>&1 || true
  fi
  [ -n "$DRILL_DIR" ] && rm -rf "$DRILL_DIR" || true
  [ -n "$SEED_FILE" ] && rm -f "$SEED_FILE" || true
  [ -n "$WORK_DIR" ] && rm -rf "$WORK_DIR" || true
}
trap cleanup EXIT

# ─── Verify helpers (dùng chung 2 mode) ────────────────────────────────────────

PASS_COUNT=0
FAIL_COUNT=0
CANNOT_RUN_COUNT=0
check() {
  if [ "$1" = "PASS" ]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    echo "    ✓ PASS: $2"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    echo "    ✗ FAIL: $2"
  fi
}
cannot_run() {
  CANNOT_RUN_COUNT=$((CANNOT_RUN_COUNT + 1))
  echo "    ⚠ CANNOT RUN: $1"
}

# mtime file (epoch giây) — KHÔNG cần node trên host (server có thể docker-only):
# GNU stat trước, fallback BSD stat (macOS).
file_mtime() {
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"
}

# Tên DB verify do restore-db.sh --verify sinh: <src>_restore_verify_<UTC-ts>
# (ts có T/Z uppercase — date +%Y%m%dT%H%M%SZ). Validate charset [A-Za-z0-9_] +
# dạng <src>_restore_verify_<ts> TRƯỚC khi dùng vào SQL — DROP dùng quoted
# identifier, charset đã chặn " và mọi ký tự lạ (không thể thoát ra ngoài tên).
verify_dbname_ok() {
  case "$1" in
    ''|*[!A-Za-z0-9_]*) return 1 ;;
    [0-9]*) return 1 ;;
    *_restore_verify_20[0-9][0-9][0-9][0-9][0-9][0-9]T[0-9]*) return 0 ;;
    *) return 1 ;;
  esac
}

WORK_DIR="$(mktemp -d)" # file tạm cho log/diff — xoá ở trap

# ─── --file mode: drill với backup THẬT (production) ───────────────────────────
# db-ops.sh verify restore vào DB mới <tên>_restore_verify_<ts> (best-effort:
# đếm bảng + so dòng User). SAU ĐÓ drill tự chạy ĐẦY ĐỦ check của plan NGUYÊN
# văn (row counts User/Listing/Order/OrderItem/Payment/Category, read-back
# equal, prisma db verify marker+schema) — qua docker exec <db-container> psql
# (local socket, không host pg tools) và image `migrate` của repo (docker compose
# run — pattern scripts/admin-access-review-prod.sh) cho prisma CLI: host
# production docker-only KHÔNG có node/node_modules trên host
# (scripts/ops-alerts-cron.sh:5-8), image migrate có sẵn node_modules + prisma
# CLI + graph migrations, container chạy cùng network compose với db (db không
# publish port). Mismatch → FAIL.
# Check không chạy được → "restore smoke only — NOT gate evidence" + exit ≠ 0
# (lần chạy đó KHÔNG dùng làm gate evidence). DB verify dọn đúng tên đã sinh.

if [ "$MODE" = "file" ]; then
  [ -f "$FILE" ] || { echo "✗ Không thấy file backup: $FILE" >&2; exit 1; }
  [ -f scripts/db-ops.sh ] || { echo "✗ Chạy từ thư mục gốc của repo (không thấy scripts/db-ops.sh)" >&2; exit 1; }
  command -v docker >/dev/null || { echo "✗ Không tìm thấy docker" >&2; exit 1; }

  # File phải nằm TRONG repo: db-ops.sh mount repo tại /work trong client container —
  # file ngoài repo không đọc được trong container (đường dẫn /work/...).
  case "$FILE" in
    "$(pwd)"/*) ;;
    *)
      echo "✗ File backup phải nằm TRONG repo (db-ops.sh mount repo tại /work — file ngoài repo không đọc được trong container): $FILE" >&2
      echo "  Copy backup vào trong repo (vd backups/) rồi chạy lại." >&2
      exit 1
      ;;
  esac
  # db-ops.sh chạy restore-db.sh BÊN TRONG client container (repo mount /work) —
  # truyền path TƯƠNG ĐỐI với repo root (tuyệt đối trên host chỉ dùng cho check của drill).
  FILE_REL="${FILE#$(pwd)/}"

  # Cấu hình stack production — cùng biến môi trường/db mặc định như db-ops.sh
  # (DB_CONTAINER/DB_USER/DB_NAME/DB_PASSWORD) để source khớp stack đã verify.
  OPS_DB_CONTAINER="${DB_CONTAINER:-loaviet-db}"
  OPS_DB_USER="${DB_USER:-loaviet}"
  OPS_DB_NAME="${DB_NAME:-loaviet}"

  FILE_SIZE="$(du -h "$FILE" | cut -f1)"
  FILE_MTIME="$(file_mtime "$FILE")"
  FRESHNESS_SECS=$(( $(date +%s) - FILE_MTIME ))

  echo "── drill --file: verify backup thật qua db-ops.sh (stack production: $OPS_DB_CONTAINER/$OPS_DB_NAME)"
  echo "── file: $FILE ($FILE_SIZE, tuổi ${FRESHNESS_SECS}s)"

  # 1) db-ops.sh verify — restore vào DB mới <tên>_restore_verify_<ts> (best-effort counts)
  T0="$(date +%s)"
  if ! ./scripts/db-ops.sh verify "$FILE_REL" 2>&1 | tee "$WORK_DIR/db-ops-verify.log"; then
    echo "✗ db-ops.sh verify lỗi — xem output ở trên." >&2
    exit 1
  fi
  VERIFY_SECS=$(( $(date +%s) - T0 ))

  # 2) parse TÊN CHÍNH XÁC DB verify vừa sinh (từ output restore-db.sh lần chạy này),
  #    validate charset + dạng <src>_restore_verify_<UTC-ts> — chỉ tên ĐÚNG dạng này
  #    mới được dùng (kể cả DROP ở trap).
  VERIFY_DB="$(sed -n 's/^✓ Restore xong: \([A-Za-z_][A-Za-z0-9_]*\) — .* bảng trong schema public$/\1/p' "$WORK_DIR/db-ops-verify.log" | tail -1)"
  if ! verify_dbname_ok "$VERIFY_DB"; then
    echo "✗ Không đọc được/validate tên DB verify từ output db-ops.sh — KHÔNG dọn gì (tên DB in ở trên — operator dọn tay)." >&2
    VERIFY_DB=""
    echo ""
    echo "restore smoke only — NOT gate evidence (không xác định được DB verify để chạy checks). Exit ≠ 0."
    exit 1
  fi
  echo "── DB verify của lần chạy này: $VERIFY_DB"

  # 3) Checks của plan, source (live) vs DB verify — docker exec psql (local socket,
  #    không host pg tools, không password — pattern docs/backup-restore.md §2/§3).
  qf() { docker exec "$OPS_DB_CONTAINER" psql -U "$OPS_DB_USER" -d "$1" -tA -v ON_ERROR_STOP=1 -c "$2"; }

  echo "── verify (file) 1/4: table count parity (schema public) — $OPS_DB_NAME vs $VERIFY_DB"
  s="$(qf "$OPS_DB_NAME" "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
  r="$(qf "$VERIFY_DB" "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
  if [ "$s" = "$r" ]; then
    check PASS "table count parity: $s bảng (public) — source == verify DB"
  else
    check FAIL "table count parity: source=$s verify=$r"
  fi

  echo "── verify (file) 2/4: row counts (source vs verify DB)"
  for t in User Listing Order OrderItem Payment Category; do
    s="$(qf "$OPS_DB_NAME" "SELECT count(*) FROM \"$t\"")"
    r="$(qf "$VERIFY_DB" "SELECT count(*) FROM \"$t\"")"
    if [ "$s" = "$r" ]; then
      check PASS "row count $t: $s == $r"
    else
      check FAIL "row count $t: source=$s verify=$r"
    fi
  done

  # Read-back equal so source LIVE vs DB verify — chạy drill NGAY SAU khi lấy backup
  # mới (db-ops.sh backup) để không drift; source đổi sau thời điểm backup → FAIL →
  # lấy backup mới rồi chạy lại. Diff KHÔNG in nội dung (dữ liệu production — chỉ số dòng).
  echo "── verify (file) 3/4: read back equal (toàn bộ dòng từng bảng, source vs verify DB — KHÔNG in nội dung)"
  for t in User Listing Order OrderItem Payment Category; do
    qf "$OPS_DB_NAME" "SELECT * FROM \"$t\" ORDER BY id" > "$WORK_DIR/fsrc.$t.txt"
    qf "$VERIFY_DB" "SELECT * FROM \"$t\" ORDER BY id" > "$WORK_DIR/ftgt.$t.txt"
    if diff -q "$WORK_DIR/fsrc.$t.txt" "$WORK_DIR/ftgt.$t.txt" >/dev/null; then
      check PASS "read back equal: $t ($(wc -l < "$WORK_DIR/fsrc.$t.txt" | tr -d ' ') dòng byte-equal)"
    else
      DIFF_LINES="$(diff "$WORK_DIR/fsrc.$t.txt" "$WORK_DIR/ftgt.$t.txt" | wc -l | tr -d ' ')"
      check FAIL "read back equal: $t — $DIFF_LINES dòng diff (source đã đổi sau thời điểm backup? lấy backup mới rồi chạy lại)"
    fi
  done

  # prisma db verify (marker + schema) trên DB verify — prisma CLI chạy trong
  # image `migrate` CỦA REPO (docker compose service migrate — node_modules +
  # prisma CLI + graph migrations có sẵn trong image; pattern
  # scripts/admin-access-review-prod.sh): host production docker-only KHÔNG có
  # node/node_modules trên host (scripts/ops-alerts-cron.sh:5-8) nên check
  # KHÔNG đòi hỏi node_modules repo. DATABASE_URL trỏ DB verify (đè DATABASE_URL
  # mặc định của service migrate), truyền THEO TÊN (-e DATABASE_URL) — giá trị
  # không hiện trong ps args. Container migrate chạy trên network compose của
  # stack → $OPS_DB_CONTAINER (db KHÔNG publish port) resolve được + DB verify
  # reachable. Fallback (dev/scratch rig KHÔNG có compose/image migrate):
  # node_modules repo + bare node image trên network db (docker run).
  echo "── verify (file) 4/4: prisma db verify (marker + schema khớp contract) trên $VERIFY_DB — image migrate (compose)"
  DB_PASSWORD_RESOLVED="${DB_PASSWORD:-}"
  if [ -z "$DB_PASSWORD_RESOLVED" ] && [ -f .env ]; then
    DB_PASSWORD_RESOLVED="$(sed -n 's/^DB_PASSWORD=//p' .env | tail -1 | tr -d '\r')"
    case "$DB_PASSWORD_RESOLVED" in
      \"*\") DB_PASSWORD_RESOLVED="${DB_PASSWORD_RESOLVED#\"}"; DB_PASSWORD_RESOLVED="${DB_PASSWORD_RESOLVED%\"}" ;;
      \'*\') DB_PASSWORD_RESOLVED="${DB_PASSWORD_RESOLVED#\'}"; DB_PASSWORD_RESOLVED="${DB_PASSWORD_RESOLVED%\'}" ;;
    esac
  fi
  if [ -z "$DB_PASSWORD_RESOLVED" ]; then
    cannot_run "prisma db verify: thiếu DB_PASSWORD (không có env, không có ./.env)"
  else
    # URL có mật khẩu — KHÔNG in; export theo tên cho compose run -e DATABASE_URL.
    export DATABASE_URL="postgresql://$OPS_DB_USER:$DB_PASSWORD_RESOLVED@$OPS_DB_CONTAINER:5432/$VERIFY_DB"
    set +e
    docker compose -f docker-compose.prod.yml run --rm --no-deps -T \
      -e DATABASE_URL migrate npx prisma db verify >"$WORK_DIR/file-db-verify.log" 2>&1
    DBV_RC=$?
    set -e
    unset DATABASE_URL
    if [ "$DBV_RC" -eq 0 ]; then
      check PASS "prisma db verify (image migrate): marker + schema khớp contract (exit 0)"
    elif [ "$DBV_RC" -eq 4 ]; then
      check FAIL "prisma db verify: drift/marker mismatch (exit 4):"
      sed -n '1,10p' "$WORK_DIR/file-db-verify.log" || true
    elif [ ! -x node_modules/.bin/prisma ]; then
      cannot_run "prisma db verify: image migrate không chạy được (exit $DBV_RC — xem $WORK_DIR/file-db-verify.log) và repo thiếu node_modules/prisma cho fallback (host docker-only?)"
    else
      # Fallback dev/scratch: node_modules repo + bare node image trên network db
      # (docker run) — cho rig không có compose/image migrate.
      OPS_NET="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$OPS_DB_CONTAINER" | awk '{print $1}')"
      if [ -z "$OPS_NET" ]; then
        cannot_run "prisma db verify: không xác định được network của $OPS_DB_CONTAINER (image migrate exit $DBV_RC)"
      else
        export DATABASE_URL="postgresql://$OPS_DB_USER:$DB_PASSWORD_RESOLVED@$OPS_DB_CONTAINER:5432/$VERIFY_DB"
        set +e
        docker run --rm --network "$OPS_NET" \
          -v "$(pwd):/work" -w /work \
          -e DATABASE_URL -e HOME=/tmp \
          "$NODE_IMAGE" npx prisma db verify >"$WORK_DIR/file-db-verify-node.log" 2>&1
        DBV_RC=$?
        set -e
        unset DATABASE_URL
        if [ "$DBV_RC" -eq 0 ]; then
          check PASS "prisma db verify (node container — fallback): marker + schema khớp contract (exit 0)"
        elif [ "$DBV_RC" -eq 4 ]; then
          check FAIL "prisma db verify: drift/marker mismatch (exit 4):"
          sed -n '1,10p' "$WORK_DIR/file-db-verify-node.log" || true
        else
          cannot_run "prisma db verify (image migrate exit ≠ 0, node container exit $DBV_RC — image/network/node_modules? xem $WORK_DIR/file-db-verify*.log)"
        fi
      fi
    fi
  fi

  # 4) Dọn DB verify — ĐÚNG tên đã sinh (validate ở trên), chỉ khi còn tồn tại.
  VERIFY_DB_NAME="$VERIFY_DB" # tên cho dòng evidence (VERIFY_DB clear ngay dưới)
  EXISTS="$(docker exec "$OPS_DB_CONTAINER" psql -U "$OPS_DB_USER" -d postgres -tA -v ON_ERROR_STOP=1 -c "SELECT 1 FROM pg_database WHERE datname='$VERIFY_DB'")"
  if [ "$EXISTS" = "1" ]; then
    docker exec "$OPS_DB_CONTAINER" psql -U "$OPS_DB_USER" -d postgres -v ON_ERROR_STOP=1 \
      -c "DROP DATABASE \"$VERIFY_DB\"" >/dev/null
    echo "── dọn: DROP DATABASE $VERIFY_DB (DB verify của lần chạy này)"
    VERIFY_DB="" # trap không drop lại
  fi

  # 5) Evidence + verdict.
  echo ""
  echo "════ EVIDENCE — paste vào docs/operations/restore-drill-evidence.md (REDACT host/IP) ════"
  echo "- Ngày (UTC): $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "- Host: $(hostname) (docker $(docker --version | cut -d' ' -f3 | tr -d ',')) — REDACT khi paste"
  echo "- Mode: --file (backup thật, stack production $OPS_DB_CONTAINER/$OPS_DB_NAME)"
  echo "- File: $FILE ($FILE_SIZE) · backup freshness (RPO đo được): ${FRESHNESS_SECS}s"
  echo "- Verify duration (restore vào DB mới + checks): ${VERIFY_SECS}s (mẫu RTO đo được)"
  echo "- Checks: $PASS_COUNT PASS / $FAIL_COUNT FAIL / $CANNOT_RUN_COUNT CANNOT RUN (table parity · row counts · read-back equal · prisma db verify)"
  echo "- DB verify $VERIFY_DB_NAME đã DROP (dọn đúng tên lần chạy này)."
  echo "══════════════════════════════════════════════════════════════════════════"
  if [ "$FAIL_COUNT" -gt 0 ]; then
    echo ""
    echo "FAIL: $FAIL_COUNT check FAIL — backup/restore hoặc dữ liệu nguồn có vấn đề (source đổi sau backup? xem từng dòng FAIL). KHÔNG dùng làm gate evidence."
    exit 1
  fi
  if [ "$CANNOT_RUN_COUNT" -gt 0 ]; then
    echo ""
    echo "restore smoke only — NOT gate evidence ($CANNOT_RUN_COUNT check không chạy được). Exit ≠ 0 cho gate."
    exit 1
  fi
  echo ""
  echo "PASS: drill --file xong — mọi check PASS (gate evidence)."
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
SCRATCH_USER="speaker"
SCRATCH_DB="speaker_drill"   # scratch source db (tên mới — server scratch rỗng)
RESTORED_NAME="drill_restored" # đích restore — restore-db.sh chỉ nhận [a-z_][a-z0-9_]*
DB_PASS="drill-$(openssl rand -hex 12 2>/dev/null || echo defaultpw123456)" # KHÔNG in ra

# URL có mật khẩu (host — migrate/seed/db-verify): KHÔNG bao giờ echo.
DB_URL="postgresql://$SCRATCH_USER:$DB_PASS@127.0.0.1:$PORT/$SCRATCH_DB"
RESTORED_HOST_URL="postgresql://$SCRATCH_USER:$DB_PASS@127.0.0.1:$PORT/$RESTORED_NAME"
# URL in-container (KHÔNG chứa mật khẩu — libpq đọc PGPASSWORD, db-ops.sh pattern):
SRC_URL_IN="postgresql://$SCRATCH_USER@$SERVER:5432/$SCRATCH_DB"
ADMIN_URL_IN="postgresql://$SCRATCH_USER@$SERVER:5432/postgres"
RESTORED_URL_IN="postgresql://$SCRATCH_USER@$SERVER:5432/$RESTORED_NAME"

# backup dir tạm dưới backups/ (gitignored) — mount qua repo /work; dump KHÔNG commit.
mkdir -p backups
DRILL_DIR="$(mktemp -d "$(pwd)/backups/.drill-backup.XXXXXX")"
BACKUP_OUT_IN="/work/backups/$(basename "$DRILL_DIR")" # đường dẫn trong client container

echo "── restore drill (scratch): server=$SERVER client=$CLIENT network=$NET port=$PORT"

# ─── 1. Scratch source DB ─────────────────────────────────────────────────────

docker network create "$NET" >/dev/null && NET_CREATED=1
# Mật khẩu container truyền THEO TÊN (export + -e POSTGRES_PASSWORD) — không nằm
# trong ps args của docker run.
export POSTGRES_PASSWORD="$DB_PASS" PGPASSWORD="$DB_PASS"
docker run -d --rm --name "$SERVER" --network "$NET" \
  -e POSTGRES_USER="$SCRATCH_USER" -e POSTGRES_PASSWORD -e POSTGRES_DB="$SCRATCH_DB" \
  -p "127.0.0.1:$PORT:5432" \
  "$PG_IMAGE" >/dev/null && SERVER_CREATED=1

# đợi postgres sẵn sàng (trong container mình tạo — test-integration.sh pattern)
for i in $(seq 1 30); do
  if docker exec "$SERVER" pg_isready -U "$SCRATCH_USER" -d "$SCRATCH_DB" >/dev/null 2>&1; then break; fi
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

# PGPASSWORD truyền THEO TÊN (export ở trên + -e PGPASSWORD) — giá trị không
# nằm trong ps args của docker run (finding: env by name).
docker run -d --rm --name "$CLIENT" --network "$NET" \
  --user "$(id -u):$(id -g)" \
  -e PGPASSWORD -e HOME=/tmp \
  -v "$(pwd):/work" -w /work \
  "$PG_IMAGE" tail -f /dev/null >/dev/null && CLIENT_CREATED=1

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
DUMP_MTIME="$(file_mtime "$DUMP")"

# ─── 6. Restore (script thật, in-container — vào DB MỚI, không đè) ─────────────

echo "── restore: restore-db.sh --into $RESTORED_NAME (in-container, DB mới)"
T2="$(date +%s)"
docker exec "$CLIENT" sh scripts/restore-db.sh --file "$BACKUP_OUT_IN/$DUMP_NAME" --url "$ADMIN_URL_IN" --into "$RESTORED_NAME"
RESTORE_SECS=$(( $(date +%s) - T2 ))

# ─── 7. Verification — PASS/FAIL từng check ────────────────────────────────────

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
    check FAIL "read back equal: $t — diff (fixture giả, in được):"
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
echo "════ EVIDENCE — paste vào docs/operations/restore-drill-evidence.md (REDACT host/IP) ════"
echo "- Ngày (UTC): $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "- Host: $(hostname) (docker $(docker --version | cut -d' ' -f3 | tr -d ',')) — REDACT khi paste"
echo "- Mode: scratch (server=$SERVER client=$CLIENT network=$NET — stack throwaway, đã dọn ở trap)"
echo "- Migrate: prisma db migrate --to production — graph: $(ls migrations/app | grep -v '^refs$' | tr '\n' ' ')"
echo "- Backup: backup-db.sh in-container — ${BACKUP_SECS}s · dump $DUMP_NAME ($DUMP_SIZE)"
echo "- Restore: restore-db.sh --into $RESTORED_NAME (DB mới, không đè) — ${RESTORE_SECS}s"
echo "- SCRATCH timings (fixture nhỏ — KHÔNG phải RPO/RTO production): backup ${BACKUP_SECS}s · restore ${RESTORE_SECS}s · freshness ${FRESHNESS_SECS}s · dump $DUMP_SIZE"
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
