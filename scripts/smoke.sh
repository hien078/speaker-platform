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
# Cần: đã build production (chạy scripts/preflight.sh trước) — script tự build
# nếu thiếu .next/standalone.
#
# Usage: SMOKE_PORT=3210 scripts/smoke.sh
# ─────────────────────────────────────────────────────────────────────────────
set -Eeuo pipefail
cd "$(dirname "$0")/.."

APP_PID=""
CONTAINER=""
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
}
trap cleanup EXIT

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
  DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder" \
    AUTH_SECRET="smoke-build-placeholder" \
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
  code=$(curl -s -o /tmp/opencode/smoke-health.json -w '%{http_code}' "http://127.0.0.1:$PORT/api/health" || true)
  if [[ "$code" == "200" ]] && grep -q '"db":"up"' /tmp/opencode/smoke-health.json; then
    ok=1; break
  fi
  sleep 1
done
[[ -z "$ok" ]] && { echo "FAIL: /api/health không lên 200 db=up sau 60s" >&2; exit 1; }
echo "✔ /api/health → 200 db=up"

declare -a FAILED=()
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

check "GET / (trang chủ)" 200 "http://127.0.0.1:$PORT/"
check "GET /login" 200 "http://127.0.0.1:$PORT/login"
check "POST /api/cron/auto-release sai secret → 401" 401 \
  "http://127.0.0.1:$PORT/api/cron/auto-release" -X POST -H "Authorization: Bearer wrong-secret"
check "POST /api/payments/momo/ipn body rác → 400" 400 \
  "http://127.0.0.1:$PORT/api/payments/momo/ipn" -X POST -H "Content-Type: application/json" -d "not-json"
check "GET /api/chat không đăng nhập → 401" 401 "http://127.0.0.1:$PORT/api/chat/x"

if [[ ${#FAILED[@]} -eq 0 ]]; then
  echo "SMOKE PASS — production server vận hành đúng trên scratch DB."
  exit 0
else
  echo "SMOKE FAIL — check đỏ: ${FAILED[*]}" >&2
  exit 1
fi
