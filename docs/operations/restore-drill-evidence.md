# Restore drill — evidence (Batch 8 Task 6)

> **Spec §9 Batch 8 gate:** "*restore drill successful*" — mục evidence này là nơi
> ghi kết quả mỗi lần drill. **FD-R36:** spec KHÔNG đặt mục tiêu RPO/RTO — drill
> **đo** (backup duration, restore duration = RTO đo được, dump size, backup
> freshness = RPO đo được) và ghi lại ở đây; mục tiêu cụ thể (nếu founder muốn)
> là founder decision — drill không bịa, không pass/fail theo target bịa.

## Cơ chế

- Script: **`scripts/restore-drill.sh`** — chạy end-to-end trên **stack scratch**
  do script tự tạo + tự dọn (2 container `postgres:16-alpine` throwaway
  `sp-drill-pg-$$` + `sp-drill-client-$$`, network riêng, port random trên
  `127.0.0.1`, password random không in ra) — **KHÔNG đụng DB production/dev**
  (`scripts/test-integration.sh` safety pattern).
- **Không host pg tools** (production db không publish port — `docker-compose.prod.yml`):
  backup + restore + verify queries chạy **bên trong** client-tools container cùng
  network scratch (pattern `scripts/db-ops.sh`) — `pg_dump`/`pg_restore`/`psql` là
  tool của chính image `postgres:16-alpine` (cùng image với server → khớp major
  version theo cấu trúc, không cần preflight version trên host).
- Backup: `scripts/backup-db.sh` (script thật, in-container — hành vi
  `*.partial` → kiểm tra TOC → rename được exercise). Restore:
  `scripts/restore-db.sh` (script thật, in-container — restore vào DB **mới**
  `drill_restored`, từ chối đè — nguyên tắc bất biến `docs/backup-restore.md`).
- Migrate scratch: `npx prisma db migrate --to production` (graph thật trên disk).
- Seed fixture qua `tsx` + ORM (không raw psql — ORM tôn trọng contract): 2 `User`
  (seller/buyer), 1 `Category` (FK bắt buộc của `Listing`), 1 `Listing`,
  finance-preservation fixture 1 `Order` + 1 `OrderItem` + 1 `Payment` — chứng minh
  các bảng finance (Batch 1 shutdown giữ dữ liệu lịch sử) restore nguyên vẹn.
- Docs backup/restore (`docs/backup-restore.md`, `docs/deployment.md`,
  `docs/runbook.md`) đã dùng `db-ops.sh` + cutover đổi tên DB — drill **tham chiếu,
  không sửa lại**.

## Hai chế độ

| Chế độ | Lệnh | Ý nghĩa |
|---|---|---|
| **scratch** (mặc định) | `bash scripts/restore-drill.sh` | Chứng minh script end-to-end trên stack throwaway — chạy được ở mọi máy có docker (dev/CI). |
| **--file** (backup thật) | `bash scripts/restore-drill.sh --file backups/db-loaviet-<ts>.dump` | Drill với backup production qua `./scripts/db-ops.sh verify <file>` (restore vào DB mới `<tên>_restore_verify_<ts>`, so bảng + dòng `User` với nguồn — in-container). **Chạy trên server production** — đường dẫn gate evidence khuyến nghị trước launch; DB verify để lại cho operator dọn (lệnh in sẵn trong output). |

## Checks (mỗi lần drill phải PASS hết — FAIL là defect của drill/backup/restore scripts, sửa ở đó, KHÔNG yếu hoá check)

| # | Check | Chứng minh |
|---|---|---|
| 1 | table count parity (`information_schema.tables`, schema `public`) — source == restored | Restore đủ bảng, không thiếu object |
| 2 | row counts `User`, `Listing`, `Order`, `OrderItem`, `Payment` (+ `Category`) — source == restored | Đủ dòng từng bảng (kể cả bảng finance) |
| 3 | seeded rows read back equal — `SELECT *` từng bảng fixture, source == restored (byte-equal) | Dữ liệu đọc lại từ DB restore **nguyên vẹn**, không sai lệch giá trị |
| 4 | `npx prisma db verify` trên DB restore (exit 0) | Marker + schema khớp contract sau restore |

Đo đạc kèm mỗi lần: backup duration, restore duration (RTO đo được), dump size
(`du -h`), backup freshness (RPO đo được = tuổi bản backup lúc verify).

## Cadence

- **§9 Batch 8 gate:** ít nhất **1 lần trước launch** (gate evidence — khuyến nghị
  đường dẫn `--file` với backup thật trên server production).
- `docs/backup-restore.md` §2: verify backup **ít nhất 1 lần/tuần** qua
  `./scripts/db-ops.sh verify <file>` (cron `docs/deployment.md`: backup `0 2 * * *`
  `db-ops.sh backup --keep 30`, verify `0 4 * * 0`).
- `docs/backup-restore.md` §4: test restore **sau mỗi migration destructive** lớn.

---

## Các lần drill

### 2026-10-06 — scratch (lần đầu — chứng minh script)

Stack scratch throwaway (server `sp-drill-pg-65953` + client `sp-drill-client-65953`,
network `sp-drill-net-65953`), migrate graph `baseline → batch2` (ref `production`),
seed ORM 2 User + 1 Category + 1 Listing + 1 Order + 1 OrderItem + 1 Payment.
**Kết quả: 14 PASS / 0 FAIL — DRILL PASS.** Scratch stack + dump đã dọn ở trap EXIT
(verify sau chạy: không còn container/network/dump/file seed).

```text
── restore drill (scratch): server=sp-drill-pg-65953 client=sp-drill-client-65953 network=sp-drill-net-65953 port=50803
── migrate graph → ref 'production' (scratch DB)
    ✓ migrate xong: 20261003T0448_baseline 20261006T0209_batch2_identity_security
── seed fixture (tsx + ORM)
seed: User=2 Category=1 Listing=1 Order=1 OrderItem=1 Payment=1 (order=95d519aa-9332-446d-a1c8-244e91231bf5 payment=aa087e5a-39b4-4454-bcea-035a400717d5)
── backup: backup-db.sh (in-container, pg_dump custom format)
→ pg_dump custom format → /work/backups/.drill-backup.46VPJv/db-drill-20261006T143819Z.dump
→ Verify archive (pg_restore --list):
;
; Archive created at 2026-10-06 14:38:19 UTC
;     dbname: speaker_drill
;     TOC Entries: 269
;     Compression: gzip
  … (37 bảng dữ liệu trong archive)
✓ Backup xong: /work/backups/.drill-backup.46VPJv/db-drill-20261006T143819Z.dump (140.0K)
  (không truyền --keep → giữ toàn bộ backup)
── restore: restore-db.sh --into drill_restored (in-container, DB mới)
→ Archive nguồn: database 'speaker_drill' (37 bảng dữ liệu)
→ CREATE DATABASE drill_restored (mới — không đè gì đang có)
→ pg_restore vào drill_restored…
✓ Restore xong: drill_restored — 34 bảng trong schema public
── verify 1/4: table count parity (schema public)
    ✓ PASS: table count parity: 34 bảng (public) — source == restored
── verify 2/4: row counts (fixture tables)
    ✓ PASS: row count User: 2 == 2
    ✓ PASS: row count Listing: 1 == 1
    ✓ PASS: row count Order: 1 == 1
    ✓ PASS: row count OrderItem: 1 == 1
    ✓ PASS: row count Payment: 1 == 1
    ✓ PASS: row count Category: 1 == 1
── verify 3/4: seeded rows read back equal (toàn bộ dòng từng bảng, source vs restored)
    ✓ PASS: read back equal: User (2 dòng byte-equal)
    ✓ PASS: read back equal: Listing (1 dòng byte-equal)
    ✓ PASS: read back equal: Order (1 dòng byte-equal)
    ✓ PASS: read back equal: OrderItem (1 dòng byte-equal)
    ✓ PASS: read back equal: Payment (1 dòng byte-equal)
    ✓ PASS: read back equal: Category (1 dòng byte-equal)
── verify 4/4: prisma db verify (marker + schema khớp contract) trên drill_restored
    ✓ PASS: prisma db verify: marker + schema khớp contract (exit 0)

════ EVIDENCE — paste vào docs/operations/restore-drill-evidence.md ════
- Ngày (UTC): 2026-10-06T14:38:27Z
- Host: 192.168.102.14 (docker 27.5.1)
- Mode: scratch (server=sp-drill-pg-65953 client=sp-drill-client-65953 network=sp-drill-net-65953 — stack throwaway, đã dọn ở trap)
- Migrate: prisma db migrate --to production — graph: 20261003T0448_baseline 20261006T0209_batch2_identity_security
- Backup: backup-db.sh in-container — 1s · dump db-drill-20261006T143819Z.dump (140K)
- Restore: restore-db.sh --into drill_restored (DB mới, không đè) — 1s
- RTO đo được (restore): 1s · RPO đo được (backup freshness lúc verify): 7s
- Checks: 14 PASS / 0 FAIL (table parity · row counts · read-back equal · prisma db verify)
══════════════════════════════════════════════════════════════════════════

PASS: restore drill xong — mọi check PASS. Scratch stack + dump dọn ở trap EXIT.
```

Ghi chú lần chạy này:

- Dữ liệu trong output là **fixture giả** trên stack scratch (email `drill-*@example.com`,
  `passwordHash` giả) — không phải dữ liệu thật; password scratch không bao giờ in ra.
- `--file` (backup thật trên server production) là **bước pre-launch của operator** —
  chưa chạy ở đây (máy dev không có stack production `loaviet-db`); ghi lại mục dated
  mới sau khi chạy trên server.
