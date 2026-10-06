# Monitoring signals + ops alerts (Batch 8 Task 5)

> **Mục tiêu (spec §9 Batch 8 "monitoring exists", §12 "monitoring exists"):** tín
> hiệu vận hành trên đúng seam có sẵn — `/api/health`, JSON log lines
> (`src/lib/observability-core.ts`), `AuditEvent`/`OtpCode` counts,
> `pg_stat_user_tables`, thư mục backup, log cron — **không thêm nhà cung cấp
> monitoring SaaS nào** (spec không mandate vendor; mọi tích hợp ngoài là
> deploy-time qua seam `captureError`/`captureEvent`).
>
> Script: `scripts/ops-alerts.ts` — **offline maintenance command (spec §5.1.1)**:
> không expose qua HTTP/admin UI, chạy từ cron trên server, in JSON alert lines ra
> stdout, exit code `0` = không CRITICAL, `1` = có CRITICAL. Decision logic là
> hàm thuần unit-test (`tests/unit/ops-alerts.test.ts`); `main()` chỉ wiring IO.

## 0. Cách chạy

```bash
# Production (cron trên server — user sở hữu repo, cùng pattern backup cron
# docs/backup-restore.md §1; host cần node ≥ 22 + tsx trong node_modules):
*/15 * * * * cd /opt/loaviet && OPS_ALERTS_MODE=docker npx tsx scripts/ops-alerts.ts >> backups/ops-alerts.log 2>&1
#   [FOUNDER DECISION — lịch chạy 15 phút/lần là đề xuất; FD-R35]

# Dev dry run (DB dev qua ORM — DATABASE_URL từ env THẬT, pattern D4
# scripts/admin-bootstrap.ts: `set -a; source .env; set +a` trước):
set -a; source .env; set +a
OPS_ALERTS_HEALTH_URL=http://127.0.0.1:3100/api/health npx tsx scripts/ops-alerts.ts
```

- **Mode tự động:** env thật có `DATABASE_URL` → dev (ORM raw lane); không → docker
  (`docker exec`). Ép rõ: `OPS_ALERTS_MODE=docker|dev`.
- **DB reach (production):** container db **không publish port**
  (`docker-compose.prod.yml`) → mọi query read-only đi qua
  `docker exec loaviet-db psql -U loaviet -d loaviet -tAc "<SQL>"` — **không host pg
  tools, không direct connection**; thứ nặng hơn (backup/restore) là việc
  `scripts/db-ops.sh` (container-on-network, ops/runtime-readiness `de0240f`) —
  script này chỉ đọc.
- **Ghi duy nhất:** `backups/.ops-alerts-state.json` (watermark pg_stat — gitignored,
  `backups/` đã chặn). Không mutation dữ liệu, không cần `--apply`.
- **Cấu hình qua env:** `OPS_ALERTS_MODE`, `OPS_ALERTS_HEALTH_URL` (mặc định
  `http://127.0.0.1:3000/api/health` — app bind loopback, nginx proxy ngoài),
  `OPS_ALERTS_CRON_LOG` (mặc định `backups/ops-alerts.log`), `OPS_DB_CONTAINER` /
  `OPS_DB_USER` / `OPS_DB_NAME` / `OPS_APP_CONTAINER` (mặc định khớp
  `docker-compose.prod.yml`: `loaviet-db`/`loaviet`/`loaviet`/`loaviet-app`).

## 1. Catalog tín hiệu

| Tín hiệu (signal) | Nguồn | Query / lệnh | Ngưỡng (proposed default) | Severity |
|---|---|---|---|---|
| `health` | `/api/health` | `GET` (fetch, timeout 5s) | — (ok/false là факт, không ngưỡng) | CRITICAL khi không gọi được / `ok:false`; INFO khi OK |
| `error-rate` | `captureError` JSON lines (stderr container app) | `docker logs loaviet-app --since <window>m` đếm dòng `"level":"error"` | > 20 dòng / 15 phút `[FOUNDER DECISION — FD-R35]` | WARN |
| `auth-abuse-recovery-requests` | `AuditEvent` | `SELECT action, count(*) FROM "AuditEvent" WHERE action='user.recovery_requested' AND "createdAt" >= now() - interval '<window> minutes' GROUP BY action` | > 10 / 15 phút `[FOUNDER DECISION — FD-R35]` | WARN |
| `auth-abuse-mfa-recovery-code` | `AuditEvent` | như trên, action `admin.mfa_recovery_code_used` | > 2 / 15 phút → WARN; **> 0 → INFO** (mỗi lần dùng mã khôi phục đều đáng chú ý — FD-R58) `[FOUNDER DECISION — FD-R35]` | WARN / INFO |
| `auth-abuse-mfa-failed` | `AuditEvent` | như trên, action `admin.mfa_failed` (Batch 2 review fix Task 8 **có** audit lần sai mã MFA ở login/step-up) | > 5 / 15 phút `[FOUNDER DECISION — FD-R35]` | WARN |
| `auth-abuse-otp-max-attempts` | `OtpCode` | `SELECT count(*) FROM "OtpCode" WHERE attempts >= 5 AND "createdAt" >= now() - interval '<window> minutes'` (5 = `OTP_MAX_ATTEMPTS` `src/lib/otp.ts`) | > 5 rows / 15 phút `[FOUNDER DECISION — FD-R35]` | WARN |
| `finance-boundary-violation` | `pg_stat_user_tables` tuple counters | `SELECT relname, n_tup_ins, n_tup_upd, n_tup_del FROM pg_stat_user_tables WHERE relname IN (<FINANCE_TABLES>)` — so watermark | **bất kỳ delta > 0 khi `FINANCIAL_FEATURES_ENABLED=false` → CRITICAL** (không có "ngưỡng chấp nhận được") | CRITICAL |
| `backup-freshness` | thư mục `backups/` | file `db-*.dump` mới nhất (backup-db.sh chỉ đổi tên `.partial`→`.dump` khi TOC check xong) | không có bản nào → CRITICAL; tuổi > 26h → CRITICAL `[FOUNDER DECISION — FD-R35]` | CRITICAL |
| `cron-liveness` | log cron (`backups/ops-alerts.log`) | mtime của file log (cron redirect output script này) | không có file → WARN; tuổi > 1h → WARN `[FOUNDER DECISION — FD-R35]` | WARN |

Mọi ngưỡng là **PROPOSED DEFAULTS** trong `DEFAULT_THRESHOLDS` (`scripts/ops-alerts.ts`)
— founder chỉnh bằng cách đổi hằng số, logic không đổi (FD-R35; spec §9/§12 không định
mức). Lịch cron 15 phút/lần cũng là đề xuất `[FOUNDER DECISION]`.

## 2. Finance-boundary watermark — chi tiết

**Bất kỳ** insert/update/delete trên bất kỳ finance table nào (`Order`, `OrderItem`,
`Payment`, `Payout`, `WithdrawRequest`, `LedgerEntry`, `Dispute`, `CartItem`, `Offer`,
`ExchangeOffer`, `PlatformSetting`, `PriceHistory`) khi tài chính đang TẮT là vi phạm
ranh giới Batch 1 (spec §4.1/§4.10) → **CRITICAL** kèm tên table + delta + row count.

- **Tại sao `pg_stat_user_tables` chứ không phải watermark `createdAt`/`updatedAt`:**
  `Payment`/`Payout` không có `updatedAt` (status UPDATE vô hình với watermark
  createdAt); `CartItem`/`OrderItem` không có timestamp nào; DELETE xoá sạch dấu vết;
  raw SQL bypass ORM timestamps. `pg_stat_user_tables` đếm physical row
  ins/upd/del **bất kể write path nào** — không cần schema change (G2), bắt được cả
  status UPDATE, DELETE, và raw SQL.
- **Watermark:** `backups/.ops-alerts-state.json` lưu counters (`n_tup_ins`/
  `n_tup_upd`/`n_tup_del`) mỗi finance table từ lần chạy trước. Mỗi lần chạy: đọc
  counters hiện tại → tính delta so watermark → đánh giá → **ghi lại counters hiện
  tại** (watermark tiến lên kể cả khi không có alert — nếu watermark không persist,
  mọi lần chạy đều "lần đầu" và nuốt hết vi phạm; round-trip được unit-test).
- **Lần đầu** (chưa có file state): dựng baseline, INFO `finance-boundary-baseline`,
  không CRITICAL.
- **Counter GIẢM** (stats_reset / PG restart): so watermark vô nghĩa → INFO
  `finance-boundary-rebaseline` (kèm tên table + counter bị reset), **không bao giờ
  CRITICAL giả**. Lưu ý chấp nhận: hoạt động xảy ra TRƯỚC lần chạy đầu sau reset có
  thể bị nuốt bởi lần re-baseline đó.
- **`FINANCIAL_FEATURES_ENABLED` đọc từ container app đang chạy**
  (`docker exec loaviet-app printenv FINANCIAL_FEATURES_ENABLED`) — cấu hình **đã
  deploy**, không phải env host (env host có thể lệch stack thật). Strict: chỉ literal
  `"true"` mới tính là bật (cùng parse `src/lib/financial-features.ts`); đọc không
  được (container down) → coi như TẮT — fail-closed, boundary check luôn armed. Lưu ý
  thêm: production hard-off qua `NODE_ENV=production` trong chính
  `financialFeaturesEnabled()` — defense-in-depth, không phụ thuộc env var.
- Finance đang BẬT (sau này, qua reviewed product decision): delta là hoạt động hợp lệ
  → INFO `finance-boundary-activity`, không CRITICAL — alert này là beta-specific.
- **Finance model mới** xuất hiện trong `FINANCE_TABLES` mà chưa có watermark → delta 0
  lần chạy đó (baseline lại), không CRITICAL giả. Drift test
  (`tests/unit/ops-alerts.test.ts`) assert `FINANCE_TABLES` ⊆ model trong
  `src/prisma/contract.prisma` — đổi contract mà quên script thì test fail.

## 3. Giới hạn ghi nhận (auth-abuse blindness)

- **`admin.mfa_failed` CÓ AuditEvent** (Batch 2 review fix Task 8 — lần sai mã MFA ở
  login/step-up được audit, fail-open, không chứa mã thô) → script theo dõi được
  count này (`auth-abuse-mfa-failed`).
- **Login thường bằng mật khẩu SAI KHÔNG có AuditEvent** (Batch 2 chỉ audit hành động
  thành công) → count này không tồn tại; tín hiệu auth-abuse là **best-available**
  từ `AuditEvent` + `OtpCode`. Việc thêm audit failed-login là **finding trong
  security review** (code change ngoài perimeter G3 → plan mới), không phải việc
  Batch 8.
- **Bucket rate-limit in-memory KHÔNG query được cross-process** (RR-1 —
  `src/lib/rate-limit.ts` header: bộ nhớ trong process, restart reset, không chia sẻ
  giữa instance) → không thể đếm "đang bị rate-limit bao nhiêu key" từ ngoài.
- Đơn-instance: deployment 1 container app (compose) — nếu scale >1 instance thì
  error-rate (docker logs 1 container) và rate-limit đều phải thiết kế lại (RR-1).

## 4. Không PII (spec §4.8 + §7.6)

Mọi alert line chỉ mang **count / scope / typed-code** — không user id, email, phone,
IP, mã OTP, token, session, nội dung tin nhắn. Unit-test quét shape PII (email /
phone VN / mã OTP 6 chữ số — cùng bộ shape `redactDetail` `src/lib/audit-event.ts`)
trên mọi dòng output của bộ fixture đại diện mọi signal. Query chỉ là `count(*)`
aggregate — không row người dùng nào được đọc. Lỗi IO in ra stderr cho log cron,
không vào alert line.

## 5. Kênh phân phát (FD-R37)

Log lines + exit code là kênh ship: cron redirect stdout vào `backups/ops-alerts.log`
(đồng thời là nguồn tín hiệu `cron-liveness`), exit `1` khi có CRITICAL để cron mail
hoặc wrapper alert ngoài. Email/Telegram/OTel là tích hợp **deploy-time** qua seam
`captureError`/`captureEvent` (`src/lib/observability-core.ts` — thay thân hàm,
call-site không đổi) — không hardcode ở đây. `[FOUNDER DECISION — FD-R37]`

## 6. Re-verify sau các batch sau (thực thi sớm)

Tài liệu này được viết khi Batch 8 Task 5 thực thi trên cây chỉ có **Batch 0–2**
(early execution — xem report Batch 8). Các tham chiếu cần đối chiếu lại khi
Batch 3–7 merge (Task 10 của Batch 8 re-verify):

- Batch 5 PII-guard source-scan (nếu tồn tại sau merge) — ops-alerts dùng cùng bộ
  shape scan trong test riêng; nếu Batch 5 xuất một module shape-scan dùng chung,
  cân nhắc import thay duplicate.
- Batch 3 `ModerationCase`/`ModerationEvidence` — không liên quan tín hiệu này
  (không query), chỉ ghi nhận để tránh nhầm là đã cover.
- Batch 7 invite/console — không có tín hiệu nào đọc các bảng đó (ngoài phạm vi
  monitoring P0 này).
