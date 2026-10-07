# 📦 Runbook — Release / Rollback / Migration / Stop gates

Runbook vận hành cho nhánh production (docker-compose.prod.yml, 1 VPS, nginx cùng host).
Mọi lệnh chạy trên server (hoặc máy ops có quyền docker + SSH tunnel), KHÔNG từ máy dev
trừ khi ghi rõ.

## 0. Kiến trúc & network assumptions (đã xác minh)

```
Internet ──► Cloudflare (proxy, DDoS) ──► nginx :443 (cùng host)
                                              │ proxy_pass http://127.0.0.1:3000
                                              ▼
                     Docker: app (Next.js standalone :3000, bind 127.0.0.1 ONLY)
                                              │ (compose default bridge network — nội bộ)
                                              ▼
                                            db (postgres:16-alpine, KHÔNG expose port)
```

Xác minh từ `docker-compose.prod.yml` (lệnh: `docker compose -f docker-compose.prod.yml config`):

- **App chỉ bind `127.0.0.1:3000`** — không thể truy cập trực tiếp từ internet.
  `TRUST_PROXY_HEADERS=true` chỉ an toàn với topology này (nginx local đặt `x-real-ip`).
  Nếu đổi topology (app expose trực tiếp / khác host) → đặt `TRUST_PROXY_HEADERS=false`.
- **DB không có `ports:`** — chỉ app + migrate trong network compose kết nối được.
- **Không khai báo networks:** → default bridge của project compose, cô lập theo project name.
- **Migrate chạy trước app** (`depends_on: service_completed_successfully`) — app không bao giờ
  serve request trên schema chưa migrate.
- **Uploads** trong volume `uploads` (bind vào `/app/public/uploads`).

## 1. Stop gates — KHÔNG release khi bất kỳ mục nào đỏ

Chạy trên máy dev/CI (repo sạch):

```bash
scripts/preflight.sh          # 7 gate: contract drift, lint, tsc, unit tests, build,
                              # compose config, migration graph
scripts/test-integration.sh   # escrow/ledger invariants trên scratch DB (docker)
scripts/smoke.sh               # production server + scratch DB: health, cron 401, IPN 400
scripts/docker-smoke.sh       # image production + compose stack cô lập end-to-end
```

Stop gates bổ sung (thủ công, trên server):

- [ ] `.env` production: `DB_PASSWORD`, `AUTH_SECRET`, `CRON_SECRET` (32+ hex), `NEXT_PUBLIC_APP_URL=https://<domain>`, MoMo credentials thật
- [ ] `docker compose -f docker-compose.prod.yml config` không lỗi (compose fail-fast khi thiếu env)
- [ ] Backup đêm đã chạy ít nhất 1 lần (`ls -lt backups/ | head`) và **verify restore** qua `./scripts/db-ops.sh verify <file>` (docs/backup-restore.md)
- [ ] Cron escrow auto-release đã cài (mục 5) và test 401/200
- [ ] `npm audit` đã triage (mục 7) — không có critical chưa xử lý

## 2. Release (deploy mới)

```bash
# trên server
cd /opt/loaviet
git pull --ff-only
docker compose -f docker-compose.prod.yml up -d --build
# migrate service tự chạy pending migrations (graph → ref 'production') trước app start

# LẦN ĐẦU sau Batch 4 (bắt buộc): seed beta catalog — category
# portable_bluetooth_speaker + model chuẩn CHỈ tồn tại qua script này
# (không có admin action tạo Category; thiếu → /sell/new không có danh mục,
# mọi seller bị chặn). Dry-run trước (chỉ đọc — KHÔNG cần --allow-production;
# service migrate set NODE_ENV=production nhưng guard chỉ chặn --apply),
# rồi --apply --allow-production (script tự từ chối --apply vào DB non-local
# khi thiếu cờ — guard từ ĐÍCH). Có file model founder → thêm mount
# -v "$PWD/founder.json:/app/founder.json:ro" + --models /app/founder.json
# (CÙNG NHAU — thiếu file thì Docker tạo thư mục tại mount → EISDIR):
docker compose -f docker-compose.prod.yml run --rm \
  -v "$PWD/scripts:/app/scripts:ro" -v "$PWD/src:/app/src:ro" \
  migrate npx tsx scripts/seed-beta-catalog.ts
docker compose -f docker-compose.prod.yml run --rm \
  -v "$PWD/scripts:/app/scripts:ro" -v "$PWD/src:/app/src:ro" \
  migrate npx tsx scripts/seed-beta-catalog.ts --apply --allow-production

# LẦN ĐẦU sau Batch 5 (bắt buộc): backfill location canonical — locationSource
# cho mọi row legacy (FD-1 qua registry; "Khác"/quận/typo → unresolved KHÔNG đoán).
# Dry-run trước (chỉ đọc — KHÔNG cần --allow-production), rồi --apply
# --allow-production (guard từ ĐÍCH như seed ở trên; idempotent):
docker compose -f docker-compose.prod.yml run --rm \
  -v "$PWD/scripts:/app/scripts:ro" -v "$PWD/src:/app/src:ro" \
  migrate npx tsx scripts/backfill-listing-location.ts
docker compose -f docker-compose.prod.yml run --rm \
  -v "$PWD/scripts:/app/scripts:ro" -v "$PWD/src:/app/src:ro" \
  migrate npx tsx scripts/backfill-listing-location.ts --apply --allow-production

# rồi duyệt model pending trong /admin/catalog (model chỉ hiện trong form
# đăng tin sau khi approved) — chi tiết: docs/deployment.md §2.

# xác minh sau release
curl -fsS http://127.0.0.1:3000/api/health          # → {"ok":true,"db":"up",...}
docker compose -f docker-compose.prod.yml logs -f app  # grep '"level":"error"' / scope
```

Rollback nhanh nếu health fail (mục 3). KHÔNG bao giờ `prisma db update` trên production —
chỉ `db migrate --to production` (qua service migrate).

## 3. Rollback

### 3a. Rollback code (schema giữ nguyên — an toàn nhất)

```bash
cd /opt/loaviet
git log --oneline -5                  # chọn commit trước đó
git checkout <commit-trước-release>   # hoặc git revert
docker compose -f docker-compose.prod.yml up -d --build
curl -fsS http://127.0.0.1:3000/api/health
```

Lưu ý: rollback code về TRƯỚC một migration mới mà không rollback schema → app cũ chạy
trên schema mới. Các migration hiện tại đều additive (baseline) nên chấp nhận được;
**migration destructive thì bắt buộc rollback DB (3b) hoặc revert-forward ngay (3c)**.

### 3b. Rollback DB (point-in-time restore) — CHỈ khi dữ liệu hỏng

```bash
# 1) dừng app (KHÔNG dừng db)
docker compose -f docker-compose.prod.yml stop app
# 2) restore backup vào DB MỚI (script từ chối đè — docs/backup-restore.md)
./scripts/db-ops.sh restore backups/db-loaviet-<ts>.dump loaviet_restored
# 3) kiểm tra dữ liệu trong loaviet_restored
docker exec loaviet-db psql -U loaviet -d loaviet_restored -c 'select count(*) from "User"'
# 4) DATABASE_URL trong compose trỏ cố định DB "loaviet" → đổi tên DB (giữ bản cũ), up lại
docker exec loaviet-db psql -U loaviet -d postgres \
  -c 'ALTER DATABASE loaviet RENAME TO loaviet_old_<ts>' \
  -c 'ALTER DATABASE loaviet_restored RENAME TO loaviet'
docker compose -f docker-compose.prod.yml up -d
```

### 3c. Revert-forward (ưu tiên khi chỉ code lỗi)

Fix trên nhánh lỗi → release lại như mục 2. Migration graph chỉ tiến (`db migrate` không
có down) — KHÔNG thử "undo migration" bằng tay trên production.

## 4. Migration status — xem DB đang ở đâu trong graph

```bash
# trạng thái DB production so với ref 'production' (marker trong DB là nguồn thật):
docker compose -f docker-compose.prod.yml run --rm migrate status
# hoặc từ máy ops có tunnel:
DATABASE_URL="$PROD_DB_URL" npx prisma migration status --to production

# xem migrations sẽ chạy khi deploy (preview, không đổi gì):
DATABASE_URL="$PROD_DB_URL" npx prisma db migrate --show --to production
```

Chẩn đoán (xem .agents/skills/prisma-8/references/migration-review.md):

| Triệu chứng | Ý nghĩa | Hành động |
|---|---|---|
| `N migration(s) behind ref 'production'` | DB tụt sau ref | `db migrate --to production` (service migrate tự chạy lúc up) |
| `MIGRATION.MARKER_NOT_IN_HISTORY` | DB bị đổi ngoài hệ thống (SQL tay) | `db verify` khảo sát → quyết định `db sign` / `contract infer` — KHÔNG tự ý `ref set` |
| `MIGRATION.MARKER_MISMATCH` khi migrate | Marker không phải node trong graph | Điều tra out-of-band apply trước khi làm gì |
| Ref lệch DB sau rollback/restore | DB ở hash cũ | Hoặc migrate-forward lại, hoặc `migration ref set production <hash-db>` (chọn có ý thức, commit) |

## 5. Cron escrow auto-release (BẮT BUỘC cài)

```bash
# crontab trên server:
0 * * * * curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" \
  http://127.0.0.1:3000/api/cron/auto-release || echo "auto-release failed $(date)" >> /var/log/loaviet-cron.log
```

- `200 {"ok":true,"released":N}` — N=0 bình thường · `401` sai secret · `503` thiếu `CRON_SECRET` (fail closed) · `500` DB lỗi — chu kỳ sau tự thử lại, đơn quá hạn không mất.
- Idempotent + an toàn concurrent: claim `UPDATE ... WHERE status='shipped'` — 2 cron chồng nhau không double payout (có integration test).

## 6. Backup — thiết kế lịch (đã xác minh)

```
0 2 * * *  backup + prune  (db-ops.sh backup --keep 30)  ──► backups/db-loaviet-<UTC>.dump
0 4 * * 0  verify          (db-ops.sh verify <mới nhất>) ──► restore vào DB mới, 1 lần/tuần
0 5 1 * *  copy            (rclone/s3 sync 1 bản/tháng ra object storage ngoài VPS)
```

- Cron chạy **trên host** qua `scripts/db-ops.sh` (docs/backup-restore.md): db không publish
  port, nên script chạy `backup-db.sh`/`restore-db.sh` trong container tạm `postgres:16-alpine`
  cùng network với `loaviet-db`. Không dùng `--url ...@localhost:5432` trên production.
- **VPS chết không kéo theo backup**: bắt buộc có bản sao ngoài VPS (rclone/S3).
- Test restore sau mỗi migration destructive (verify mode rẻ: `db-ops.sh verify`).

## 7. npm audit — triage hiện tại (2026-10-05)

`npm audit`: 18 findings (13 high, 5 moderate, 0 critical) — **tất cả trong dev-toolchain
transitive** (prisma CLI rc → @hono/node-server, chevrotain/lodash; eslint-config-next →
fast-glob/braces), **không có findings trong dependency runtime của image production**
(next, react, prisma runtime, sharp, jose, bcryptjs, zod đều sạch).

Mọi `fixAvailable` đều là **major/breaking** (prisma → 7.10.0 downgrade, eslint-config-next →
14.x downgrade) — theo nguyên tắc batch này KHÔNG áp dụng major không cần thiết. Chờ
upstream (prisma 8 stable) phát hành bản vá rồi bump theo
`.agents/skills/prisma-8/references/upgrade-app.md`.

Lệnh kiểm lại: `npm audit --omit=dev` (runtime-only) · `npm audit` (đầy đủ).

## 8. Observability

- Lỗi: 1 dòng JSON stderr qua `src/lib/observability.ts` — `grep '"scope":"cron:auto-release"'`.
- Slow query: `{"scope":"db:slow-query","latencyMs":...}` khi query ≥ `SLOW_QUERY_MS` (mặc định 500ms) — KHÔNG log SQL/params (PII).
- Env thiếu lúc start: server từ chối start với `PRODUCTION_ENV_INVALID: <tên-key>` (chỉ tên key, không in giá trị).
- Gắn Sentry/OTel sau: thay thân `captureError` — call-site không đổi.
