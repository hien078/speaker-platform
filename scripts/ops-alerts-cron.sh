#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# ops-alerts-cron.sh — wrapper cron cho host KHÔNG có Node (docker-only).
# (Batch 8 Task 5 review fix 5 — docs/operations/monitoring-signals.md §0)
#
# Host chỉ cần: docker + bash + repo (git clone đầy đủ — docs/deployment.md §2)
# + .env của compose project. KHÔNG cần node/tsx trên host, KHÔNG npx fetch
# runtime (image `migrate` của repo đã có node_modules + tsx — runbook §0).
#
# Chạy tay (dry-run như cron sẽ chạy):
#   ./scripts/ops-alerts-cron.sh
# Crontab (monitoring-signals.md §0 — output redirect do crontab đảm nhận):
#   */15 * * * * cd /opt/loaviet && ./scripts/ops-alerts-cron.sh >> backups/ops-alerts.log 2>&1
#
# Cơ chế:
#   1. touch heartbeat — tín hiệu cron-liveness (ops-alerts đọc mtime file này;
#      heartbeat = "cron đang chạy", KHÔNG phải "script thành công").
#   2. 2 tín hiệu cần docker CLI (docker logs / docker exec printenv) đếm/đọc
#      TRÊN HOST rồi inject qua env — container migrate KHÔNG có docker CLI.
#   3. Phần còn lại (query DB qua ORM raw lane + toàn bộ decision logic) chạy
#      trong image `migrate` (node:22-alpine + node_modules của repo — pinned
#      bởi git qua Dockerfile) trên compose network: DATABASE_URL có sẵn trong
#      environment service migrate (compose nội suy .env — KHÔNG copy secret
#      ra shell history), host `db`/`app` resolve được.
#   4. backups/ mount rw — state file watermark + heartbeat sống trên host.
#
# KHÔNG in secret: DATABASE_URL chỉ nằm trong environment của container;
# wrapper không echo giá trị nào của .env.
# ─────────────────────────────────────────────────────────────────────────────
set -Eeuo pipefail
cd "$(dirname "$0")/.."

APP_CONTAINER="${OPS_APP_CONTAINER:-loaviet-app}"
# Phải khớp DEFAULT_THRESHOLDS.windowMinutes trong scripts/ops-alerts.ts (FD-R35
# — chỉnh ngưỡng thì sửa cả hai, cùng commit).
WINDOW_MINUTES="${OPS_ALERTS_WINDOW_MINUTES:-15}"

mkdir -p backups
touch backups/.ops-alerts-heartbeat

# ── 2 tín hiệu cần docker CLI — precompute trên host, inject qua env ──────────
# grep -c in "0" và exit 1 khi không khớp — `|| true` giữ exit code, output vẫn là số.
ERROR_LINES="$(docker logs "$APP_CONTAINER" --since "${WINDOW_MINUTES}m" --tail 50000 2>&1 \
  | grep -c '"level":"error"' || true)"
# Container app down → printenv fail → chuỗi rỗng → script bỏ qua env (fail-closed:
# đọc nội bộ không được → coi như TẮT — boundary check armed).
FIN_ENABLED="$(docker exec "$APP_CONTAINER" printenv FINANCIAL_FEATURES_ENABLED 2>/dev/null || true)"

# ── Chạy logic trong image migrate (repo-pinned) trên compose network ─────────
# --user: state file/heartbeat ghi với uid/gid của user chạy cron (pattern
# scripts/db-ops.sh) — không để file root-owned trên host.
# Mounts: scripts/ + src/ read-only (image migrate không copy hai thư mục này —
# runbook §0); backups/ rw cho state file.
exec docker compose -f docker-compose.prod.yml run --rm \
  --user "$(id -u):$(id -g)" \
  -v "$PWD/scripts:/app/scripts:ro" \
  -v "$PWD/src:/app/src:ro" \
  -v "$PWD/backups:/app/backups" \
  -e OPS_ALERTS_MODE=dev \
  -e OPS_ALERTS_HEALTH_URL="${OPS_ALERTS_HEALTH_URL:-http://app:3000/api/health}" \
  -e OPS_ALERTS_ERROR_LINES="$ERROR_LINES" \
  -e OPS_ALERTS_FINANCIAL_FEATURES_ENABLED="$FIN_ENABLED" \
  migrate npx tsx scripts/ops-alerts.ts
