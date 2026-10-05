#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# docker-smoke.sh — build production image + up stack compose SMOKE cô lập,
# kiểm health + hành vi bảo mật, rồi down -v CHỈ project mình tạo.
#
# An toàn:
# - Project name sp-smoke-<ts> — mọi container/volume/network mang tiền tố đó;
#   down -v --remove-orphans chỉ đụng đúng project này, không đụng stack khác
# - Env test sinh random (openssl), không credential thật, không in giá trị
# - Port app: SMOKE_PORT (mặc định 3999) bind 127.0.0.1 — không đụng app khác
#
# Cần: docker. Thời gian: build image lần đầu ~ vài phút.
# Usage: SMOKE_PORT=3999 scripts/docker-smoke.sh
# ─────────────────────────────────────────────────────────────────────────────
set -Eeuo pipefail
cd "$(dirname "$0")/.."

PROJECT="sp-smoke-$(date +%s)"
COMPOSE_FILE="tests/docker/docker-compose.smoke.yml"
PORT="${SMOKE_PORT:-3999}"
TMP_DIR=""

cleanup() {
  echo "→ dọn compose project: $PROJECT (down -v — chỉ tài nguyên project này)"
  docker compose -f "$COMPOSE_FILE" -p "$PROJECT" down -v --remove-orphans >/dev/null 2>&1 || true
  if [[ -n "$TMP_DIR" ]]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT
# scratch dir theo TMPDIR của máy — không rơi file tạm vào repo (parity smoke.sh)
TMP_DIR="$(mktemp -d)"

# env test — sinh random, không in
export DB_PASSWORD="smoke-$(openssl rand -hex 16)"
export AUTH_SECRET="smoke-$(openssl rand -hex 32)"
export CRON_SECRET="smoke-$(openssl rand -hex 32)"
export SMOKE_PORT="$PORT"
export REPO_ROOT="$(pwd)"

echo "── docker compose build (image production từ Dockerfile)"
docker compose -f "$COMPOSE_FILE" -p "$PROJECT" build --quiet

echo "── docker compose up -d (db + migrate + app — stack cô lập $PROJECT)"
# --wait-timeout 120: HEALTHCHECK app start-period 20s + interval 30s —
# mặc định ngắn hơn chu kỳ check đầu tiên nên báo unhealthy sai
docker compose -f "$COMPOSE_FILE" -p "$PROJECT" up -d --wait --wait-timeout 120 >/dev/null

declare -a FAILED=()
check() {
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

echo "── smoke checks qua 127.0.0.1:$PORT"
check "GET /api/health → 200" 200 "http://127.0.0.1:$PORT/api/health"
check "GET / → 200" 200 "http://127.0.0.1:$PORT/"
check "GET /login → 200" 200 "http://127.0.0.1:$PORT/login"

# ─── Private beta finance shutdown (spec §4.1/§5.1, plan Task 6) ──────────────
# FINANCIAL_FEATURES_ENABLED=false trong compose smoke: mọi entry point finance
# phải trả unavailable TYPED — không auth/parse/read/mutation vận hành.
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
  "http://127.0.0.1:$PORT/api/cron/auto-release" -X POST -H "Authorization: Bearer wrong"

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

# health phải báo db up (không chỉ HTTP 200)
body=$(curl -s "http://127.0.0.1:$PORT/api/health")
if grep -q '"db":"up"' <<<"$body"; then
  echo "✔ health body db=up"
else
  echo "✘ health body không có db=up: $body" >&2
  FAILED+=("health-db-up")
fi

# migrate phải đã chạy — marker table của Prisma 8 nằm ở schema prisma_contract
# (đã khảo sát: prisma_contract.{contract,ledger,marker}) — kiểm tra trong container db
# của PROJECT mình tạo
migrated=$(docker compose -f "$COMPOSE_FILE" -p "$PROJECT" exec -T db \
  psql -U loaviet -d loaviet -tAc \
  "select count(*) from prisma_contract.marker" 2>/dev/null || true)
if [[ "${migrated//[[:space:]]/}" -ge 1 ]]; then
  echo "✔ prisma_contract.marker có marker — migrate service đã chạy"
else
  echo "✘ prisma_contract.marker trống — migrate có thể chưa chạy" >&2
  FAILED+=("migrate-marker")
fi

if [[ ${#FAILED[@]} -eq 0 ]]; then
  echo "DOCKER SMOKE PASS — image production + compose stack vận hành đúng."
  echo "DOCKER SMOKE PASS — private beta: mọi finance entry point deny typed, page finance 404."
  exit 0
else
  echo "DOCKER SMOKE FAIL — check đỏ: ${FAILED[*]}" >&2
  exit 1
fi
