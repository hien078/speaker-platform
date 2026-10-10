# Monitoring signals + ops alerts (Batch 8 Task 5)

> **Mục tiêu (spec §9 Batch 8 "monitoring exists", §12 "monitoring exists"):** tín
> hiệu vận hành trên đúng seam có sẵn — `/api/health`, JSON log lines
> (`src/lib/observability-core.ts`), `AuditEvent`/`OtpCode` counts,
> `pg_stat_user_tables`, thư mục backup, heartbeat cron — **không thêm nhà cung cấp
> monitoring SaaS nào** (spec không mandate vendor; mọi tích hợp ngoài là
> deploy-time qua seam `captureError`/`captureEvent`).
>
> Script: `scripts/ops-alerts.ts` — **offline maintenance command (spec §5.1.1)**:
> không expose qua HTTP/admin UI, chạy từ cron trên server, in JSON alert lines ra
> stdout, exit code `0` = không CRITICAL, `1` = có CRITICAL. Decision logic là
> hàm thuần unit-test (`tests/unit/ops-alerts.test.ts`); `main()` chỉ wiring IO.

## 0. Cách chạy — 2 đường cron (deploy prerequisite)

**Điều kiện chung:** user cron sở hữu repo + thuộc group `docker` (như backup cron
— docs/backup-restore.md §1); `backups/` ghi được (`chmod 700 backups/`).

### Path A — host CÓ Node (node ≥ 22 + `npm ci` để có node_modules/tsx)

```bash
*/15 * * * * cd /opt/loaviet && touch backups/.ops-alerts-heartbeat && OPS_ALERTS_MODE=docker npx tsx scripts/ops-alerts.ts >> backups/ops-alerts.log 2>&1
#   [FOUNDER DECISION — lịch 15 phút/lần là đề xuất; FD-R35]
```

- `npx tsx` resolve **trong node_modules của repo** (`npm ci` trên host) — KHÔNG
  fetch runtime. Host KHÔNG có node → Path B.
- Script tự làm mọi thứ: query DB qua `docker exec loaviet-db psql`, đọc
  `FINANCIAL_FEATURES_ENABLED` từ container app (`docker exec loaviet-app
  printenv`), đếm error lines qua `docker logs loaviet-app`.

### Path B — host KHÔNG có Node (docker-only) — `scripts/ops-alerts-cron.sh`

```bash
*/15 * * * * cd /opt/loaviet && ./scripts/ops-alerts-cron.sh >> backups/ops-alerts.log 2>&1
```

Wrapper (POSIX bash — chỉ cần docker + bash trên host):

1. `touch backups/.ops-alerts-heartbeat` — heartbeat cho tín hiệu cron-liveness.
2. **Precompute trên host** 2 tín hiệu cần docker CLI (container chạy script
   KHÔNG có docker CLI): `docker logs loaviet-app --since <window>m | grep -c
   '"level":"error"'` → `OPS_ALERTS_ERROR_LINES`; `docker exec loaviet-app
   printenv FINANCIAL_FEATURES_ENABLED` → `OPS_ALERTS_FINANCIAL_FEATURES_ENABLED`
   (container app down → chuỗi rỗng → script bỏ qua env → fail-closed: coi như
   TẮT, boundary check armed).
3. **Logic + query DB chạy trong image `migrate` của repo** (stage `migrate`
   Dockerfile: `node:22-alpine` + node_modules đầy đủ có `tsx` — **pinned bởi git
   qua Dockerfile**, KHÔNG tag nổi, KHÔNG npx fetch runtime) qua compose network —
   pattern runbook §0 (docs/operations/admin-bootstrap-recovery-runbook.md):
   `DATABASE_URL` có sẵn trong environment service migrate (compose nội suy
   `.env` — secret không qua shell history), host `db`/`app` resolve được.
   `OPS_ALERTS_WINDOW_MINUTES` của wrapper (mặc định 15) phải khớp
   `DEFAULT_THRESHOLDS.windowMinutes` — chỉnh ngưỡng thì sửa cả hai, cùng commit.
4. Mounts: `scripts/` + `src/` read-only (image migrate không copy hai thư mục
   này); `backups/` rw cho state file; `--user $(id -u):$(id -g)` để state file
   không root-owned (pattern `scripts/db-ops.sh`). **`--no-deps`** (merge fix
   Wave 0, như `scripts/admin-access-review-prod.sh`): monitor KHÔNG được kéo
   service phụ lên — `db`/`app` đang stop thì phải BÁO CÁO qua tín hiệu health
   unreachable, không phải `docker compose run` khởi động cả stack.
   **Lưu ý mount (merge fix Wave 0):** `scripts/`+`src/` đến từ repo checkout
   trên host, còn `node_modules` nằm TRONG image `migrate` build lúc deploy →
   mỗi lần deploy phải rebuild image migrate
   (`docker compose -f docker-compose.prod.yml build migrate`), nếu không cron
   chạy code mới trên dependency cũ.

**Deploy prerequisite (ghi vào release checklist):** cài MỘT trong hai crontab
trên + build image migrate (`docker compose -f docker-compose.prod.yml build`) —
cron chưa cài thì tín hiệu `cron-liveness` WARN (đúng thiết kế). Đã exercise
containerised runner local (scratch compose + image migrate build từ repo) — xem
§7.

**Cấu hình qua env:** `OPS_ALERTS_MODE` (auto: env thật có `DATABASE_URL` → dev
(ORM raw lane); không → docker), `OPS_ALERTS_HEALTH_URL` (mặc định
`http://127.0.0.1:3000/api/health` — Path A từ host; Path B dùng
`http://app:3000/api/health` trên compose network), `OPS_ALERTS_CRON_HEARTBEAT`
(mặc định `backups/.ops-alerts-heartbeat`), `OPS_DB_CONTAINER`/`OPS_DB_USER`/
`OPS_DB_NAME`/`OPS_APP_CONTAINER` (mặc định khớp `docker-compose.prod.yml`).

**DB reach (production):** container db **không publish port** → mọi query
read-only đi qua `docker exec loaviet-db psql -U loaviet -d loaviet -tAc "<SQL>"`
(Path A) hoặc ORM raw lane trong compose network (Path B) — **không host pg
tools, không direct connection từ ngoài network**; thứ nặng hơn (backup/restore)
là việc `scripts/db-ops.sh` (container-on-network, ops/runtime-readiness
`de0240f`). **Ghi duy nhất:** `backups/.ops-alerts-state.json` (watermark —
gitignored). Không mutation dữ liệu, không cần `--apply`.

## 1. Catalog tín hiệu

| Tín hiệu (signal) | Nguồn | Query / lệnh | Ngưỡng (proposed default) | Severity |
|---|---|---|---|---|
| `health` | `/api/health` | `GET` (fetch, timeout 5s) — null = unreachable (network), `httpStatus` phân biệt 503 | — (ok/false là факт) | CRITICAL khi unreachable / `ok:false`; INFO khi OK |
| `error-rate` | `captureError` JSON lines (stderr container app) | Path A: `docker logs loaviet-app --since <window>m --tail 50000` đếm `"level":"error"`; Path B: wrapper đếm trên host → `OPS_ALERTS_ERROR_LINES` | > 20 dòng / 15 phút `[FOUNDER DECISION — FD-R35]` | WARN |
| `auth-abuse-recovery-requests` | `AuditEvent` | `SELECT action, count(*) FROM "AuditEvent" WHERE action='user.recovery_requested' AND "createdAt" >= now() - interval '<window> minutes' GROUP BY action` | > 10 / 15 phút `[FOUNDER DECISION — FD-R35]` | WARN |
| `auth-abuse-mfa-recovery-code` | `AuditEvent` | như trên, action `admin.mfa_recovery_code_used` | > 2 / 15 phút → WARN; **> 0 → INFO** (mỗi lần dùng mã khôi phục đều đáng chú ý — FD-R58) `[FOUNDER DECISION — FD-R35]` | WARN / INFO |
| `auth-abuse-mfa-failed` | `AuditEvent` | như trên, action `admin.mfa_failed` (Batch 2 review fix Task 8 **có** audit lần sai mã MFA ở login/step-up) | > 5 / 15 phút `[FOUNDER DECISION — FD-R35]` | WARN |
| `auth-abuse-otp-max-attempts` | `OtpCode` | `SELECT count(*) FROM "OtpCode" WHERE attempts >= 5 AND "createdAt" >= now() - interval '<window> minutes'` (5 = `OTP_MAX_ATTEMPTS` `src/lib/otp.ts`) | > 5 rows / 15 phút `[FOUNDER DECISION — FD-R35]` | WARN |
| `finance-boundary-violation` | `pg_stat_user_tables` tuple counters + row count | `SELECT relname, n_tup_ins, n_tup_upd, n_tup_del FROM pg_stat_user_tables WHERE relname IN (<FINANCE_TABLES>)` + `SELECT count(*)` mỗi bảng — so watermark + row count trong state file | **bất kỳ ins/upd > 0 (hoặc row count đổi) trên bảng finance-only khi `FINANCIAL_FEATURES_ENABLED=false` → CRITICAL** (không có "ngưỡng chấp nhận được") | CRITICAL |
| `finance-boundary-cascade-delete` | như trên | như trên | delete delta (hoặc row count đổi) trên bảng **cascade-affected** khi disabled → WARN — xoá listing bình thường cascade, không CRITICAL (alert fatigue) | WARN |
| `backup-freshness` | thư mục `backups/` | file `db-*.dump` mới nhất (backup-db.sh chỉ đổi tên `.partial`→`.dump` khi TOC check xong) | không có bản nào → CRITICAL; tuổi > 26h → CRITICAL `[FOUNDER DECISION — FD-R35]` | CRITICAL |
| `cron-liveness` | heartbeat `backups/.ops-alerts-heartbeat` | mtime của file do crontab/wrapper `touch` **trước mỗi lần chạy** | không có file → WARN; tuổi > 1h → WARN `[FOUNDER DECISION — FD-R35]` | WARN |

Mọi ngưỡng là **PROPOSED DEFAULTS** trong `DEFAULT_THRESHOLDS` (`scripts/ops-alerts.ts`)
— founder chỉnh bằng cách đổi hằng số, logic không đổi (FD-R35; spec §9/§12 không định
mức). Lịch cron 15 phút/lần cũng là đề xuất `[FOUNDER DECISION]`.

### 1b. `captureError` call sites theo scope — nguồn đếm của tín hiệu error-rate

Tín hiệu `error-rate` đếm MỌI dòng `"level":"error"` mà `captureError` ghi ra
stderr JSON (`src/lib/observability-core.ts`), không phân biệt code. Sổ đầy đủ
**34 call site** (grep-verified trên cây Batch 7 merge — merge fix Wave 0,
đóng hand-off Batch 7 `:474,491`):

| Scope | Số site | Typed codes / vị trí |
|---|---|---|
| `telemetry` | 11 | `TELEMETRY_RECORDER_FAILED` ×2 (`app/api/chat/[id]/route.ts:217`, `src/lib/telemetry-recorders.ts:54`), `TELEMETRY_KEY_UNAVAILABLE`, `TELEMETRY_SCHEMA_REJECTED` ×2, `TELEMETRY_PII_REJECTED` ×2, `TELEMETRY_INTERNAL_LOOKUP_FAILED`, `TELEMETRY_EMIT_FAILED`, `TELEMETRY_COHORT_READ_FAILED` (`src/lib/product-events.ts:402-567`), `SEARCH_EVENT_READBACK_FAILED` (`src/lib/search-telemetry.ts:99`) |
| `upload` | 6 | `app/api/upload/route.ts:209/227/247/273/287/296` — error object + meta `{ userId, storageKey }` |
| `recovery` | 4 | `src/lib/actions/recovery.ts:238/243/336/347` — error object + action name |
| `cohort` | 2 | `COHORT_FUNNEL_SYNC_FAILED` (`src/lib/actions/founding-sellers.ts:631`), `COHORT_NOTIFY_FAILED` (`:667`) — Batch 7 |
| `deal` | 2 | `DEAL_NOTIFY_FAILED` ×2 (`src/lib/actions/deals.ts:230/532`) — Batch 6 |
| `moderation` | 2 | `src/lib/actions/moderation.ts:301/803` — notifyError + meta |
| `momo:ipn` | 2 | `INVALID_SIGNATURE` (`app/api/payments/momo/ipn/route.ts:45`) + error object (`:82`) |
| `admin-mfa` | 1 | `src/lib/admin-mfa.ts:287` — error object |
| `rate-limit` | 1 | `src/lib/rate-limit.ts:141` — error object + scope |
| `cron:auto-release` | 1 | `app/api/cron/auto-release/route.ts:52` — error object |
| `exchange.complete` | 1 | `src/lib/actions/exchange.ts:230` — error object + offerId |
| `uploads.serve` | 1 | `app/uploads/[key]/route.ts:111` — error object + key (uuid server-side) |

**Phân loại (merge fix Wave 0):** mọi site **fail-open** (luồng chính không bị
chặn vì lỗi telemetry/notify), được đếm chung trong error-rate WARN khi vượt
ngưỡng — **không có alert theo từng code, không PII** (chỉ typed code +
`sqlState`/meta id nội bộ, cùng kỷ luật redact `AuditEvent.detail`).
Ops-alerts **không** thay đổi code theo mục này.

## 2. Finance-boundary watermark — phân loại table theo WRITER THẬT

**Phân loại bằng grep từng bảng** (review fix — không giả định "tên nghe tài
chính = ranh giới"). Mỗi model contract phải nằm đúng một lớp — drift test
(`tests/unit/ops-alerts.test.ts`) assert đủ 3 lớp phủ mọi model, model mới không
thể bị bỏ sót silently.

### (a) Finance-only — CRITICAL trên BẤT KỲ ins/upd/del khi disabled (9 bảng)

Mọi writer đều sau `assertFinancialFeaturesEnabled()` (hoặc guard ở thân thư
viện) — khi `FINANCIAL_FEATURES_ENABLED=false` không có luồng hợp lệ nào ghi:

| Table | Writer (file:line — grep-verified trên cây Batch 7 merge, đều đã finance-guard) |
|---|---|
| `Order` | orders.ts:128 (createOrderAction), orders.ts:238/306/357/418/509/579 (status update/claim), offers.ts:110/171 (create), src/lib/escrow.ts:43 (markEscrowPaid — guard :28), helpers.ts:174 (processAutoReleases :158) |
| `OrderItem` | orders.ts:152 (createOrderAction), offers.ts:124/185 (respondOffer/acceptCounter) |
| `Payment` | orders.ts:184 (payEscrowAction :221), orders.ts:249/317/426/449/517 (update), offers.ts:132/193, exchange.ts:130, src/lib/escrow.ts:48, helpers.ts:179 (processAutoReleases) |
| `Payout` | orders.ts:430 (confirmReceiptAction :401), exchange.ts:184, helpers.ts:182 (processAutoReleases), admin.ts:411 (resolveDisputeAction :361) |
| `WithdrawRequest` | withdraw.ts:54 (create), withdraw.ts:91 (updateAll claim) |
| `LedgerEntry` | src/lib/ledger.ts:45 (recordLedgerTx :28 — guard :36 ở thân thư viện) |
| `Dispute` | orders.ts:573 (openDisputeAction :556), admin.ts:379 (resolveDisputeAction :361) |
| `OrderStatusHistory` | src/lib/escrow.ts:57 (markEscrowPaid :21 — guard :28), helpers.ts:61 (recordStatusChange :54 — mọi caller orders/offers/admin đã guard) |
| `PlatformSetting` | admin.ts:467/469 (updateSettingAction :458) + src/prisma/seed.ts:323/327 (dev/test — seed.ts:16 từ chối ở NODE_ENV=production) |

### (b) Cascade-affected — CRITICAL ins/upd; delete → WARN (3 bảng)

ins/upd của writer đã finance-guard, NHƯNG delete đến từ **luồng xoá listing
bình thường (KHÔNG finance guard)**: `deleteListingAction`
(src/lib/actions/listings.ts:1393) — `Listing.deleteAll()` có điều kiện status
(listings.ts:1461-1463) cascade FK `onDelete: Cascade` (contract:
`Offer.listing`, `ExchangeOffer.listing`, `CartItem.listing`) + `CartItem`
deleteAll trực tiếp (listings.ts:1468 — belt-and-suspenders sau cascade) →
`n_tup_del` trên các bảng này là đợi mong → WARN, không CRITICAL:

| Table | ins/upd writer (finance-guard) | delete đến từ |
|---|---|---|
| `CartItem` | cart.ts:36 (addToCartAction :12), cart.ts:57 (updateCartItemAction :43) | deleteListingAction listings.ts:1393 — FK Cascade (Listing.deleteAll :1461-1463) + CartItem deleteAll :1468 |
| `Offer` | offers.ts:110/132 (createOfferAction :17), offers.ts:171/193 (respondOffer :60) | FK Cascade từ xoá Listing |
| `ExchangeOffer` | exchange.ts:130 (createExchangeOfferAction :22), exchange.ts:184 (completeExchangeAction :151) | FK Cascade từ xoá Listing |

### (c) Non-finance — KHÔNG monitored (writer không guard / domain phi tài chính)

| Table | Bằng chứng writer không finance-guard |
|---|---|
| `PriceHistory` | **createListingAction** listings.ts:491, **updateListingAction** reprice listings.ts:1187, submit/publish listings.ts:1349, **mergeModelAction** catalog.ts:132 — luồng listing/catalog bình thường → CRITICAL mỗi lần đăng tin = alert fatigue (review fix 1); writer finance: orders.ts:390 recordSoldPrices :384 (đã guard) |
| `Cart` | **registerAction** auth.ts:122, **finishLogin** auth.ts:139 — luồng auth (mỗi user mới 1 Cart) |
| `Review` | **submitReviewAction** reviews.ts:21 — KHÔNG finance guard (ghi Review cho đơn completed) — **finding cho security review Task 8** |
| 33 bảng còn lại | User, Category, Brand, Listing, ListingImage, Conversation, Message, AdminAuditLog, WishlistItem, ProductModel, Notification, UserSession, OtpCode, SellerVerification, BetaCohortMembership, PolicyAcceptance, AdminMfa, AdminRecoveryCode, AuditEvent — domain identity/catalog/moderation/audit (Batch 2); AbuseReport, ModerationCase, ModerationEvidence, ModerationAction, UserBlock, UserSuspension, Appeal (Batch 3 trust & safety), ListingImageUpload (Batch 4 upload ownership); ProductEvent, SearchAlias (Batch 5 telemetry/search — emitProductEvent src/lib/product-events.ts, seed-search-aliases.ts), Deal, DealStatusHistory (Batch 6 Deal — src/lib/actions/deals.ts), FoundingSellerCandidate, BetaInviteToken (Batch 7 cohort ops — src/lib/actions/founding-sellers.ts) — không FK tới bảng finance, không phải ranh giới tài chính |

Tổng (merge fix Wave 0): **9 finance-only + 3 cascade-affected (= 12 monitored,
không đổi) + 36 non-finance = 48 model contract** — drift test
(`tests/unit/ops-alerts.test.ts`) assert đủ 3 lớp phủ mọi model.

### Cơ chế watermark

- **Tại sao `pg_stat_user_tables` chứ không phải watermark `createdAt`/`updatedAt`:**
  `Payment`/`Payout` không có `updatedAt` (status UPDATE vô hình), `CartItem`/
  `OrderItem` không có timestamp nào, DELETE xoá sạch dấu vết, raw SQL bypass ORM
  timestamps. `pg_stat` đếm physical row ins/upd/del **bất kể write path nào** —
  không cần schema change (G2).
- **TRUNCATE vô hình với `n_tup_*`** (review fix 4): state file **v2** lưu thêm
  **row count mỗi monitored table**; row count đổi khi tuple delta = 0 = operation
  counters không thấy (TRUNCATE / stats lag) → CRITICAL (finance-only) / WARN
  (cascade-affected). Table mới vào monitored set (chưa có row count lần trước)
  → bỏ qua so sánh lần đó — không CRITICAL giả.
- **Watermark:** `backups/.ops-alerts-state.json` (v2: counters + rowCounts mỗi
  bảng). Mỗi lần chạy: đọc hiện tại → tính delta so watermark → so row count →
  đánh giá → **ghi lại hiện tại kể cả khi sạch** (watermark không persist = mọi
  lần chạy đều "lần đầu" = nuốt hết vi phạm; round-trip được unit-test).
- **Lần đầu** (chưa có file): INFO `finance-boundary-baseline`, không CRITICAL.
- **Counter GIẢM** (stats_reset / PG restart) hoặc **state file hỏng** ở lần
  không phải đầu: **WARN** `finance-boundary-rebaseline` (review fix 6 — không
  phải INFO: monitoring continuity bị đứt), không bao giờ CRITICAL giả. Lưu ý
  chấp nhận: hoạt động trước lần chạy đầu sau reset có thể bị nuốt bởi re-baseline.
- **`FINANCIAL_FEATURES_ENABLED` đọc từ cấu hình ĐÃ DEPLOY** — Path A:
  `docker exec loaviet-app printenv` (không phải env host); Path B: wrapper đọc
  rồi inject. Strict: chỉ literal `"true"` mới tính là bật (cùng parse
  `src/lib/financial-features.ts`); đọc không được → coi như TẮT — fail-closed,
  boundary check luôn armed. Production còn hard-off qua `NODE_ENV=production`
  trong chính `financialFeaturesEnabled()` — defense-in-depth.
- Finance đang BẬT (sau này, qua reviewed product decision): delta là hoạt động
  hợp lệ → INFO `finance-boundary-activity`, không CRITICAL — alert beta-specific.

## 3. Giới hạn ghi nhận (auth-abuse blindness)

- **`admin.mfa_failed` CÓ AuditEvent** (Batch 2 review fix Task 8 — lần sai mã MFA
  ở login/step-up được audit, fail-open, không chứa mã thô) → script theo dõi
  được count này (`auth-abuse-mfa-failed`).
- **Login thường bằng mật khẩu SAI KHÔNG có AuditEvent** (Batch 2 chỉ audit hành
  động thành công) → count này không tồn tại; tín hiệu auth-abuse là
  **best-available** từ `AuditEvent` + `OtpCode`. Việc thêm audit failed-login là
  **finding trong security review** (code change ngoài perimeter G3 → plan mới),
  không phải việc Batch 8.
- **Bucket rate-limit in-memory KHÔNG query được cross-process** (RR-1 —
  `src/lib/rate-limit.ts` header: bộ nhớ trong process, restart reset, không chia
  sẻ giữa instance) → không thể đếm "đang bị rate-limit bao nhiêu key" từ ngoài.
- **`submitReviewAction` ghi `Review` cho đơn completed KHÔNG finance guard**
  (reviews.ts:21) — finding cho security review Task 8 (Review classified
  non-finance, không monitored).
- Đơn-instance: deployment 1 container app (compose) — nếu scale >1 instance thì
  error-rate (docker logs 1 container) và rate-limit đều phải thiết kế lại (RR-1).
- **Cron-liveness heartbeat = "cron đang chạy"** (crontab entry còn + daemon
  sống), KHÔNG chứng minh script thành công — crash của script thấy qua thiếu dòng
  `ops-alerts-run` + stderr trong `backups/ops-alerts.log`.

## 4. Không PII (spec §4.8 + §7.6)

Mọi alert line chỉ mang **count / scope / typed-code** — không user id, email,
phone, IP, mã OTP, token, session, nội dung tin nhắn. Unit-test quét shape PII
(email / phone VN / mã OTP 6 chữ số — cùng bộ shape `redactDetail`
`src/lib/audit-event.ts`) trên mọi dòng output của bộ fixture đại diện mọi
signal. Query chỉ là `count(*)` aggregate — không row người dùng nào được đọc.
Lỗi IO in ra stderr cho log cron, không vào alert line.

## 5. Kênh phân phát (FD-R37)

Log lines + exit code là kênh ship: cron redirect stdout vào
`backups/ops-alerts.log`, exit `1` khi có CRITICAL để cron mail hoặc wrapper
alert ngoài. Email/Telegram/OTel là tích hợp **deploy-time** qua seam
`captureError`/`captureEvent` (`src/lib/observability-core.ts` — thay thân hàm,
call-site không đổi) — không hardcode ở đây. `[FOUNDER DECISION — FD-R37]`

## 6. Phân loại model mới — quy tắc thường trực (merge fix Wave 0: DONE)

Tài liệu này được viết khi Task 5 thực thi sớm trên cây chỉ có **Batch 0–2**;
các nhánh "re-verify after Batch N" đã được đóng trên cây merge Batch 5–7
(commit `fix(ops): reconcile early batch 8 work with batches 5-7`):

- **Quy tắc thường trực: mọi model contract mới phải được phân loại
  (finance-only / cascade-affected / non-finance) trong CHÍNH batch thêm nó** —
  drift test (`tests/unit/ops-alerts.test.ts`) chặn model chưa phân loại, nhưng
  việc phân loại ĐÚNG là của batch thêm model (evidence writer grep kèm commit
  đó).
- Đã phân loại khi merge: Batch 3 (7 bảng trust & safety), Batch 4
  `ListingImageUpload`, Batch 5 `ProductEvent`/`SearchAlias`, Batch 6
  `Deal`/`DealStatusHistory`, Batch 7 `FoundingSellerCandidate`/`BetaInviteToken`
  — sáu model Batch 5–7 đều **non-finance** (không FK tới bảng finance; evidence:
  `tests/integration/batch6-migration.test.ts` +
  `batch7-migration.test.ts` assert không op id nào khớp finance regex).
- Batch 5 PII-guard source-scan: Batch 5 không xuất module shape-scan dùng
  chung — ops-alerts giữ bộ shape scan riêng trong test (duplicate có drift
  pin, không import được module server-only — Global Constraints).
- Batch 7 invite/console: không có tín hiệu nào đọc các bảng đó (ngoài phạm vi
  monitoring P0 này).

## 7. Exercise containerised runner (Path B) — đã chạy local

Đã exercise cơ chế Path B local (scratch compose project + image migrate build
từ repo — KHÔNG chạm stack production): build `--target migrate`, scratch
postgres 16-alpine, `prisma db migrate --to production`, chạy
`npx tsx scripts/ops-alerts.ts` trong container migrate với mounts + env inject
như wrapper. Output ghi trong report Batch 8 Task 5 (§Review fix). Health
CRITICAL đúng thiết kế trong scratch stack (không có container app).
