#!/usr/bin/env bash
# admin-access-review-prod.sh — chạy scripts/admin-access-review.ts trên host
# production KHÔNG có Node (docker-only), cùng pattern admin-bootstrap
# (docker-compose.prod.yml service migrate) và scripts/ops-alerts-cron.sh.
#
#   cd /opt/loaviet && ./scripts/admin-access-review-prod.sh
#
# Chạy transport ORM bên trong image `migrate` (node_modules + tsx có sẵn) trên
# compose network: DATABASE_URL lấy từ environment của service migrate (compose
# nội suy .env — không đưa secret ra shell/history). READ-ONLY: script không có
# đường mutation nào. scripts/ + src/ mount read-only (image migrate không copy
# hai thư mục này).
set -Eeuo pipefail
cd "$(dirname "$0")/.."

[ "$#" -eq 0 ] || { echo "Usage: $0   (không nhận tham số — luôn transport ORM trong container)" >&2; exit 1; }

exec docker compose -f docker-compose.prod.yml run --rm --no-deps -T \
  --user "$(id -u):$(id -g)" \
  -v "$PWD/scripts:/app/scripts:ro" \
  -v "$PWD/src:/app/src:ro" \
  -e NPM_CONFIG_UPDATE_NOTIFIER=false \
  migrate npx tsx scripts/admin-access-review.ts
