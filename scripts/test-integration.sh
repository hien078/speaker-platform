#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# test-integration.sh — chạy integration tests (tests/integration/) trên
# scratch PostgreSQL container do script TẠO và DỌN.
#
# An toàn:
# - Container/volume mang tên riêng sp-it-pg-<pid> — không đụng DB/stack có sẵn
# - trap EXIT luôn dọn container mình tạo (kể cả khi test fail/Ctrl-C)
# - KHÔNG in secret; DB password sinh random chỉ dùng trong container throwaway
#
# Cần: docker, node, npx (prisma CLI), vitest (devDependencies).
# Usage: scripts/test-integration.sh
# ─────────────────────────────────────────────────────────────────────────────
set -Eeuo pipefail

cd "$(dirname "$0")/.."

CONTAINER=""
cleanup() {
  if [[ -n "$CONTAINER" ]]; then
    echo "→ dọn container scratch: $CONTAINER"
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# port chưa dùng (chọn tự do — không đụng service đang chạy)
pick_port() {
  node -e 'const net=require("node:net");const s=net.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();});'
}

PORT=$(pick_port)
CONTAINER="sp-it-pg-$$"
DB_PASS="it-$(openssl rand -hex 12 2>/dev/null || echo defaultpw123456)"
DB_NAME="speaker_it"
DB_URL="postgresql://speaker:$DB_PASS@127.0.0.1:$PORT/$DB_NAME"

echo "── integration scratch DB: container=$CONTAINER port=$PORT"

docker run -d --rm \
  --name "$CONTAINER" \
  -e POSTGRES_USER=speaker \
  -e POSTGRES_PASSWORD="$DB_PASS" \
  -e POSTGRES_DB="$DB_NAME" \
  -p "127.0.0.1:$PORT:5432" \
  postgres:16-alpine >/dev/null

# đợi postgres sẵn sàng (trong container mình tạo)
for i in $(seq 1 30); do
  if docker exec "$CONTAINER" pg_isready -U speaker -d "$DB_NAME" >/dev/null 2>&1; then
    break
  fi
  sleep 1
  if [[ $i -eq 30 ]]; then echo "FAIL: postgres scratch không sẵn sàng sau 30s" >&2; exit 1; fi
done

echo "── migrate graph → ref 'production' (scratch DB)"
DATABASE_URL="$DB_URL" npx prisma db migrate --to production

echo "── vitest integration"
DATABASE_URL="$DB_URL" npx vitest run --config vitest.integration.config.ts

echo "PASS: integration tests xong — container scratch đã dọn ở trap EXIT"
