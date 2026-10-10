#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# preflight.sh — release preflight DETERMINISTIC: mọi gate chạy hết rồi tổng hợp.
# Trả exit 0 chỉ khi TẤT CẢ gate pass. Không gate nào bị skip âm thầm.
#
# Gates:
#   1. contract emit + drift check (artefacts phải khớp contract.prisma)
#   2. lint (0 error, 0 warning)
#   3. typecheck (tsc --noEmit)
#   4. unit tests (tests/unit/)
#   5. production build (placeholder env — build không kết nối DB)
#   6. docker compose config hợp lệ (không up container gì)
#   7. migration graph offline hợp lệ (prisma migration list)
#
# Usage: scripts/preflight.sh
# ─────────────────────────────────────────────────────────────────────────────
set -Euo pipefail
cd "$(dirname "$0")/.."

declare -a FAILED=()
gate() { # gate <tên> <lệnh...>
  local name="$1"; shift
  echo ""
  echo "══════ GATE: $name ══════"
  if "$@"; then
    echo "✔ PASS: $name"
  else
    echo "✘ FAIL: $name" >&2
    FAILED+=("$name")
  fi
}

gate "contract-emit-drift" bash -c '
  npx prisma contract emit
  if ! git diff --exit-code -- src/prisma; then
    echo "::error::contract artefacts drift — chạy \"npx prisma contract emit\" rồi commit" >&2
    exit 1
  fi
'

gate "lint" npm run lint
gate "typecheck" npx tsc --noEmit
gate "unit-tests" npm test

gate "production-build" env \
  DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder" \
  AUTH_SECRET="preflight-placeholder" \
  npm run build

gate "compose-config" env \
  DB_PASSWORD="preflight-placeholder" \
  AUTH_SECRET="preflight-placeholder" \
  CRON_SECRET="preflight-placeholder" \
  NEXT_PUBLIC_APP_URL="https://preflight.invalid" \
  ADMIN_MFA_ENCRYPTION_KEY="preflight-placeholder" \
  MOMO_PARTNER_CODE="" MOMO_ACCESS_KEY="" MOMO_SECRET_KEY="" \
  docker compose -f docker-compose.prod.yml config --quiet
gate "migration-graph" npx prisma migration list

echo ""
if [[ ${#FAILED[@]} -eq 0 ]]; then
  echo "PREFLIGHT PASS — mọi gate xanh."
  exit 0
else
  echo "PREFLIGHT FAIL — gate đỏ: ${FAILED[*]}" >&2
  exit 1
fi
