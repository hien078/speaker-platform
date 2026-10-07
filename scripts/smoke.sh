#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# smoke.sh — smoke test production server (next start) trên scratch DB.
#
# An toàn:
# - Port cấu hình qua SMOKE_PORT (mặc định: tự chọn port chưa dùng)
# - Postgres scratch container riêng tên sp-smoke-pg-<pid>, dọn ở trap EXIT
# - App server (next start) do script start — PID lưu, kill ĐÚNG PID đó ở trap
# - Env là GIÁ TRỊ TEST sinh random (không credential thật), không in ra
#
# Private beta (spec §4.1/§5.1, plan Task 6): smoke chạy NODE_ENV=production với
# FINANCIAL_FEATURES_ENABLED=false (mặc định beta) — mọi entry point finance
# (API/webhook/cron/page) phải assert phản hồi unavailable TYPED, không làm
# việc vận hành (không escrow/payout/ledger/order).
#
# Cần: đã build production (chạy scripts/preflight.sh trước) — script tự build
# nếu thiếu .next/standalone.
#
# Usage: SMOKE_PORT=3210 scripts/smoke.sh
# ─────────────────────────────────────────────────────────────────────────────
set -Eeuo pipefail
cd "$(dirname "$0")/.."

APP_PID=""
CONTAINER=""
TMP_DIR=""
cleanup() {
  if [[ -n "$APP_PID" ]] && kill -0 "$APP_PID" 2>/dev/null; then
    echo "→ dọn app server PID=$APP_PID (do script start)"
    kill "$APP_PID" 2>/dev/null || true
    wait "$APP_PID" 2>/dev/null || true
  fi
  if [[ -n "$CONTAINER" ]]; then
    echo "→ dọn container scratch: $CONTAINER"
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
  if [[ -n "$TMP_DIR" ]]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT
# scratch dir theo TMPDIR của máy (macOS không có /tmp/opencode)
TMP_DIR="$(mktemp -d)"

pick_port() {
  node -e 'const net=require("node:net");const s=net.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();});'
}

PORT="${SMOKE_PORT:-$(pick_port)}"
CONTAINER="sp-smoke-pg-$$"
DB_PASS="smoke-$(openssl rand -hex 12 2>/dev/null || echo defaultpw123456)"
DB_NAME="speaker_smoke"
# DB và app KHÁC port: DB map sang port riêng, app nghe PORT
DB_PORT=$(pick_port)
DB_URL="postgresql://speaker:$DB_PASS@127.0.0.1:$DB_PORT/$DB_NAME"

echo "── smoke: app=127.0.0.1:$PORT db-container=$CONTAINER (db port $DB_PORT)"

# build production nếu chưa có (idempotent — preflight đã build thì nhảy)
if [[ ! -d .next/standalone ]]; then
  echo "── thiếu .next/standalone — build production (placeholder env)"
  # Build KHÔNG chạy instrumentation fail-fast (preflight production-build
  # gate xanh không cần key) — nhưng set ADMIN_MFA_ENCRYPTION_KEY cho đồng bộ:
  # env production hoàn chỉnh, base64 thuần 32 byte nếu build có đọc.
  DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder" \
    AUTH_SECRET="smoke-build-placeholder" \
    ADMIN_MFA_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
    npm run build
fi

# parity production (Dockerfile runner stage): standalone + static + public
echo "── chuẩn bị standalone runtime (giống Dockerfile runner)"
rm -rf .next/standalone/public .next/standalone/.next/static
cp -r public .next/standalone/public
mkdir -p .next/standalone/.next
cp -r .next/static .next/standalone/.next/static

echo "── start postgres scratch"
docker run -d --rm \
  --name "$CONTAINER" \
  -e POSTGRES_USER=speaker \
  -e POSTGRES_PASSWORD="$DB_PASS" \
  -e POSTGRES_DB="$DB_NAME" \
  -p "127.0.0.1:$DB_PORT:5432" \
  postgres:16-alpine >/dev/null

for i in $(seq 1 30); do
  docker exec "$CONTAINER" pg_isready -U speaker -d "$DB_NAME" >/dev/null 2>&1 && break
  sleep 1
  [[ $i -eq 30 ]] && { echo "FAIL: postgres scratch không sẵn sàng" >&2; exit 1; }
done

echo "── migrate graph → ref production (scratch DB)"
DATABASE_URL="$DB_URL" npx prisma db migrate --to production

# env production test — giá trị sinh random, KHÔNG credential thật.
# NODE_ENV=production → instrumentation chạy validateProductionEnv (fail-fast).
export DATABASE_URL="$DB_URL"
export NODE_ENV="production"
export AUTH_SECRET="smoke-$(openssl rand -hex 32)"
export CRON_SECRET="smoke-$(openssl rand -hex 32)"
# Batch 2 (Task 8): ADMIN_MFA_ENCRYPTION_KEY bắt buộc ở production (env.ts
# REQUIRED_KEYS → instrumentation fail-fast exit(1) khi thiếu — blocker B1
# của Task 12 gate). Giá trị TEST sinh random: PHẢI là base64 THUẦN của ĐÚNG
# 32 byte (openssl rand -base64 32) — KHÔNG tiền tố "smoke-" như các key trên:
# admin-mfa-key.ts validate strict RFC 4648 → 32 byte, prefix sẽ fail validation.
export ADMIN_MFA_ENCRYPTION_KEY="$(openssl rand -base64 32)"
# Batch 5 (Task 6): PRODUCT_EVENT_PSEUDONYM_KEY cũng bắt buộc ở production (env.ts
# REQUIRED_KEYS → instrumentation fail-fast exit(1) khi thiếu — corrections #8).
# Giá trị TEST sinh random: base64 THUẦN của ĐÚNG 32 byte (openssl rand -base64 32)
# — product-event-key.ts validate strict RFC 4648 → 32 byte, prefix sẽ fail.
export PRODUCT_EVENT_PSEUDONYM_KEY="$(openssl rand -base64 32)"
# Private beta (spec §4.1/§5.1): tài chính TẮT rõ ràng trong cấu hình beta.
# NODE_ENV=production đã hard-off ở src/lib/financial-features.ts — set
# explicit để hợp đồng beta được liệt kê đầy đủ trong cấu hình smoke.
export FINANCIAL_FEATURES_ENABLED="false"
export NEXT_PUBLIC_APP_URL="https://smoke.invalid"   # https bắt buộc ở production
export TRUST_PROXY_HEADERS="true"
export PORT="$PORT"
export HOSTNAME="127.0.0.1"

echo "── start standalone server (parity Docker: node server.js) — PID được track"
node .next/standalone/server.js &
APP_PID=$!

# đợi health 200 {"db":"up"}
ok=""
for i in $(seq 1 60); do
  code=$(curl -s -o "$TMP_DIR/health.json" -w '%{http_code}' "http://127.0.0.1:$PORT/api/health" || true)
  if [[ "$code" == "200" ]] && grep -q '"db":"up"' "$TMP_DIR/health.json" 2>/dev/null; then
    ok=1; break
  fi
  sleep 1
done
[[ -z "$ok" ]] && { echo "FAIL: /api/health không lên 200 db=up sau 60s" >&2; exit 1; }
echo "✔ /api/health → 200 db=up"

declare -a FAILED=()

# ─── b4-holistic round-3 HIGH — uploads serve qua route handler đọc đĩa ────────
# Trước fix: file upload ghi public/uploads và Next production chỉ serve file
# public/ TỒN TẠI KHI START (scan 1 lần lúc boot) → ảnh upload SAU start 404
# (đã reproduce: file tại boot 200, file sau start 404). Sau fix: file sống ở
# data/uploads (NGOÀI public/) và GET /uploads/<key> đi qua route handler
# app/uploads/[key] đọc đĩa MỌI request. Smoke: ghi file .webp THẬT (sharp)
# vào uploads dir SAU khi server start — GET phải 200 + image/webp.
# LƯU Ý: standalone server.js chạy process.chdir(__dirname) → UPLOADS_DIR
# mặc định (cwd/data/uploads) resolve về .next/standalone/data/uploads —
# parity Docker (cwd=/app, server.js tại /app → /app/data/uploads, volume
# compose mount đúng chỗ đó).
SMOKE_UPLOAD_KEY="99998888-7777-6666-5555-444433332221.webp"
SMOKE_UPLOADS_DIR="$PWD/.next/standalone/data/uploads"
mkdir -p "$SMOKE_UPLOADS_DIR"
node -e '
const sharp = require("sharp");
sharp({ create: { width: 8, height: 8, channels: 3, background: "#884422" } })
  .webp()
  .toFile(process.argv[1])
  .then(() => console.log("webp ok"))
  .catch((e) => { console.error(e); process.exit(1); });
' "$SMOKE_UPLOADS_DIR/$SMOKE_UPLOAD_KEY" || { echo "FAIL: không sinh được webp smoke" >&2; exit 1; }

check_uploads() { # check_uploads <mô tả> <code mong đợi> <content-type mong đợi> <path>
  local desc="$1" expect="$2" want_type="$3" url_path="$4"
  local code ctype
  code=$(curl -s -o "$TMP_DIR/upload.bin" -w '%{http_code}' "http://127.0.0.1:$PORT$url_path" || true)
  ctype=$(curl -sI "http://127.0.0.1:$PORT$url_path" 2>/dev/null | tr -d '\r' | awk 'tolower($1)=="content-type:"{print $2}')
  if [[ "$code" == "$expect" && "$ctype" == "$want_type" ]]; then
    echo "✔ $desc → $code ($ctype)"
  else
    echo "✘ $desc → $code ($ctype) (mong đợi $expect / $want_type)" >&2
    FAILED+=("$desc")
  fi
}
# file ghi SAU start (mô phỏng upload mới) → 200 image/webp qua route handler
check_uploads "GET /uploads/<key> file mới ghi sau start → 200 image/webp" 200 "image/webp" "/uploads/$SMOKE_UPLOAD_KEY"
# key lạ / traversal → 404 (regex chặt trước khi chạm filesystem)
check_uploads "GET /uploads/<key sai định dạng> → 404" 404 "" "/uploads/not-a-uuid.webp"
check_uploads "GET /uploads/<traversal> → 404" 404 "" "/uploads/..%2f..%2fetc%2fpasswd.webp"
# file không tồn tại → 404
check_uploads "GET /uploads/<key chưa upload> → 404" 404 "" "/uploads/00000000-0000-0000-0000-000000000000.webp"
# header bảo mật của route handler (spec §7.5)
sec_headers=$(curl -sI "http://127.0.0.1:$PORT/uploads/$SMOKE_UPLOAD_KEY" 2>/dev/null | tr -d '\r')
echo "$sec_headers" | grep -qi '^x-content-type-options: nosniff$' \
  && echo "✔ /uploads nosniff header" \
  || { echo "✘ /uploads thiếu X-Content-Type-Options: nosniff" >&2; FAILED+=("uploads nosniff"); }
echo "$sec_headers" | grep -qi "^content-security-policy: default-src 'none'; sandbox" \
  && echo "✔ /uploads CSP sandbox header" \
  || { echo "✘ /uploads thiếu CSP default-src 'none'; sandbox" >&2; FAILED+=("uploads CSP"); }
rm -f "$SMOKE_UPLOADS_DIR/$SMOKE_UPLOAD_KEY"

rm -f "$SMOKE_UPLOADS_DIR/$SMOKE_UPLOAD_KEY"

check() { # check <mô tả> <code mong đợi> <url> [curl args...]
  local desc="$1" expect="$2" url="$3"; shift 3
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' "$@" "$url" || true)
  if [[ "$code" == "$expect" ]]; then
    echo "✔ $desc → $code"
  else
    echo "✘ $desc → $code (mong đợi $expect)" >&2
    FAILED+=("$desc")
  fi
}

check_body() { # check_body <mô tả> <code mong đợi> <chuỗi bắt buộc trong body> <url> [curl args...]
  local desc="$1" expect="$2" needle="$3" url="$4"; shift 4
  local code
  code=$(curl -s -o "$TMP_DIR/resp.json" -w '%{http_code}' "$@" "$url" || true)
  if [[ "$code" == "$expect" ]] && grep -q "$needle" "$TMP_DIR/resp.json" 2>/dev/null; then
    echo "✔ $desc → $code (body chứa $needle)"
  else
    echo "✘ $desc → $code (mong đợi $expect, body thiếu $needle)" >&2
    FAILED+=("$desc")
  fi
}

check "GET / (trang chủ)" 200 "http://127.0.0.1:$PORT/"
check "GET /login" 200 "http://127.0.0.1:$PORT/login"
check "GET /api/chat không đăng nhập → 401" 401 "http://127.0.0.1:$PORT/api/chat/x"

# ─── Private beta finance shutdown (spec §4.1/§5.1, plan Task 6) ──────────────
# FINANCIAL_FEATURES_ENABLED=false (mặc định beta): mọi entry point finance
# phải trả unavailable TYPED — không auth/parse/read/mutation vận hành.

# API/webhook/cron: 503 + mã ổn định TRƯỚC auth, rate-limit, parse payload
check_body "POST /api/payments/momo/create (chưa đăng nhập) → 503 typed denial" 503 \
  "FINANCIAL_FEATURES_DISABLED" \
  "http://127.0.0.1:$PORT/api/payments/momo/create" -X POST \
  -H "Content-Type: application/json" -d '{"orderId":"smoke-order"}'
check_body "POST /api/payments/momo/ipn body rác → 503 typed denial (không parse)" 503 \
  "FINANCIAL_FEATURES_DISABLED" \
  "http://127.0.0.1:$PORT/api/payments/momo/ipn" -X POST \
  -H "Content-Type: application/json" -d "not-json"
check_body "POST /api/cron/auto-release secret ĐÚNG → 503 typed denial (không giải ngân)" 503 \
  "FINANCIAL_FEATURES_DISABLED" \
  "http://127.0.0.1:$PORT/api/cron/auto-release" -X POST \
  -H "Authorization: Bearer $CRON_SECRET"
check "POST /api/cron/auto-release sai secret → 401 (fail-closed auth giữ nguyên)" 401 \
  "http://127.0.0.1:$PORT/api/cron/auto-release" -X POST -H "Authorization: Bearer wrong-secret"

# Page finance retire (Task 4): direct request → 404 TRƯỚC mọi read/session
for path in /cart /checkout /orders /orders/sales /wallet /offers /exchange; do
  check "GET $path (finance retire) → 404" 404 "http://127.0.0.1:$PORT$path"
done
check "GET /orders/<id> (finance retire) → 404" 404 "http://127.0.0.1:$PORT/orders/smoke-test-id"
check "GET /listings/<slug>/exchange (finance retire) → 404" 404 \
  "http://127.0.0.1:$PORT/listings/smoke-test-slug/exchange"

# Return URL MoMo: throw typed denial → error boundary 500 "unavailable" —
# KHÔNG mutate escrow, KHÔNG redirect vào flow finance sống (spec §5.1)
check "GET /payments/momo/return (query bất kỳ) → 500 unavailable" 500 \
  "http://127.0.0.1:$PORT/payments/momo/return?orderId=ORDER-smoke&resultCode=0&amount=1"

if [[ ${#FAILED[@]} -eq 0 ]]; then
  echo "SMOKE PASS — production server vận hành đúng trên scratch DB."
  echo "SMOKE PASS — private beta: mọi finance entry point deny typed, page finance 404."
  exit 0
else
  echo "SMOKE FAIL — check đỏ: ${FAILED[*]}" >&2
  exit 1
fi
