# Restore drill — evidence (Batch 8 Task 6)

> **Spec §9 Batch 8 gate:** "*restore drill successful*" — mục evidence này là nơi
> ghi kết quả mỗi lần drill. **FD-R36:** spec KHÔNG đặt mục tiêu RPO/RTO — drill
> **đo** (backup duration, restore duration, dump size, backup freshness) và ghi
> lại ở đây; mục tiêu cụ thể (nếu founder muốn) là founder decision — drill không
> bịa, không pass/fail theo target bịa.
>
> **REDACTION:** host/IP trong evidence commit được redact (ghi rõ "(redacted)") —
> output gốc của script in đầy đủ host cho operator; khi paste vào file này thì
> redact. Không commit dump file, không commit dữ liệu thật.

## Cơ chế

- Script: **`scripts/restore-drill.sh`** — chạy end-to-end trên **stack scratch**
  do script tự tạo + tự dọn (2 container `postgres:16-alpine` throwaway
  `sp-drill-pg-$$` + `sp-drill-client-$$`, network riêng, port random trên
  `127.0.0.1`, password random không in ra) — **KHÔNG đụng DB production/dev**
  (`scripts/test-integration.sh` safety pattern).
- **Không host pg tools** (production db không publish port — `docker-compose.prod.yml`):
  backup + restore + verify queries chạy **bên trong** container (pattern
  `scripts/db-ops.sh`) — `pg_dump`/`pg_restore`/`psql` là tool của chính image
  `postgres:16-alpine` (cùng image với server → khớp major version theo cấu trúc,
  không cần preflight version trên host).
- Backup: `scripts/backup-db.sh` (script thật, in-container — hành vi
  `*.partial` → kiểm tra TOC → rename được exercise). Restore:
  `scripts/restore-db.sh` (script thật, in-container — restore vào DB **mới**,
  từ chối đè — nguyên tắc bất biến `docs/backup-restore.md`).
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
| **scratch** (mặc định) | `bash scripts/restore-drill.sh` | Chứng minh script end-to-end trên stack throwaway — chạy được ở mọi máy có docker + node (dev/CI). **Thời gian scratch là thời gian trên fixture nhỏ — KHÔNG phải RPO/RTO production.** |
| **--file** (backup thật) | `bash scripts/restore-drill.sh --file backups/db-loaviet-<ts>.dump` | Drill với backup production: `./scripts/db-ops.sh verify <file>` restore vào DB mới `<tên>_restore_verify_<ts>`, **SAU ĐÓ drill tự chạy ĐẦY ĐỦ các check** (row counts, read-back equal, `prisma db verify`) qua `docker exec <db-container> psql` (local socket — không host pg tools) và node container trên network db cho prisma CLI (host có thể docker-only). **Mismatch → FAIL.** Check không chạy được → in `restore smoke only — NOT gate evidence` + exit ≠ 0 (lần chạy đó KHÔNG dùng làm gate evidence). DB verify được dọn **đúng tên đã sinh** (parse + validate từ output lần chạy đó). File phải nằm TRONG repo (db-ops.sh mount repo tại /work). |

**--file so source (live) vs DB verify** → chạy drill **ngay sau khi lấy backup mới**
(`./scripts/db-ops.sh backup`) để không drift; source đổi sau thời điểm backup →
read-back FAIL → lấy backup mới rồi chạy lại (FAIL không được yếu hoá check).

## Checks (mỗi lần drill phải PASS hết — FAIL là defect của drill/backup/restore scripts, sửa ở đó, KHÔNG yếu hoá check)

| # | Check | Chứng minh |
|---|---|---|
| 1 | table count parity (`information_schema.tables`, schema `public`) — source == restored/verify DB | Restore đủ bảng, không thiếu object |
| 2 | row counts `User`, `Listing`, `Order`, `OrderItem`, `Payment` (+ `Category`) — source == restored/verify DB | Đủ dòng từng bảng (kể cả bảng finance) |
| 3 | rows read back equal — `SELECT *` từng bảng fixture, source == restored/verify DB (byte-equal; --file KHÔNG in nội dung — chỉ số dòng diff) | Dữ liệu đọc lại từ DB restore **nguyên vẹn**, không sai lệch giá trị |
| 4 | `npx prisma db verify` trên DB restore (exit 0) | Marker + schema khớp contract sau restore |

Đo đạc kèm mỗi lần: backup duration, restore duration, dump size (`du -h`),
backup freshness (tuổi bản backup lúc verify). **Scratch:** thời gian fixture nhỏ —
không phải RPO/RTO production. **--file:** freshness = RPO đo được, verify duration =
mẫu RTO đo được (trên dữ liệu thật).

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

Stack scratch throwaway (server + client `postgres:16-alpine`, network riêng),
migrate graph `baseline → batch2` (ref `production`), seed ORM 2 User + 1 Category +
1 Listing + 1 Order + 1 OrderItem + 1 Payment. **Kết quả: 14 PASS / 0 FAIL —
DRILL PASS (exit 0).** Scratch stack + dump đã dọn ở trap EXIT (verify sau chạy:
không còn container/network/dump/file seed).

```text
── restore drill (scratch): server=sp-drill-pg-82853 client=sp-drill-client-82853 network=sp-drill-net-82853 port=52269
── migrate graph → ref 'production' (scratch DB)
    ✓ migrate xong: 20261003T0448_baseline 20261006T0209_batch2_identity_security
── seed fixture (tsx + ORM)
seed: User=2 Category=1 Listing=1 Order=1 OrderItem=1 Payment=1 (order=2a2217e1-… payment=818c5d1c-…)
── backup: backup-db.sh (in-container, pg_dump custom format)
→ pg_dump custom format → /work/backups/.drill-backup.IVrnPV/db-drill-20261006T151642Z.dump
→ Verify archive (pg_restore --list):
;
; Archive created at 2026-10-06 15:16:42 UTC
;     dbname: speaker_drill
;     TOC Entries: 269
;     Compression: gzip
  … (37 bảng dữ liệu trong archive)
✓ Backup xong: /work/backups/.drill-backup.IVrnPV/db-drill-20261006T151642Z.dump (192.0K)
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

════ EVIDENCE — paste vào docs/operations/restore-drill-evidence.md (REDACT host/IP) ════
- Ngày (UTC): 2026-10-06T15:16:56Z
- Host: (redacted — máy dev, docker 27.5.1)
- Mode: scratch (server=sp-drill-pg-82853 client=sp-drill-client-82853 network=sp-drill-net-82853 — stack throwaway, đã dọn ở trap)
- Migrate: prisma db migrate --to production — graph: 20261003T0448_baseline 20261006T0209_batch2_identity_security
- Backup: backup-db.sh in-container — 3s · dump db-drill-20261006T151642Z.dump (192K)
- Restore: restore-db.sh --into drill_restored (DB mới, không đè) — 4s
- SCRATCH timings (fixture nhỏ — KHÔNG phải RPO/RTO production): backup 3s · restore 4s · freshness 12s · dump 192K
- Checks: 14 PASS / 0 FAIL (table parity · row counts · read-back equal · prisma db verify)
══════════════════════════════════════════════════════════════════════════

PASS: restore drill xong — mọi check PASS. Scratch stack + dump dọn ở trap EXIT.
```

Ghi chú: dữ liệu trong output là **fixture giả** trên stack scratch (email
`drill-*@example.com`, `passwordHash` giả) — không phải dữ liệu thật; password
scratch không bao giờ in ra; uuid cắt ngắn khi paste.

### 2026-10-06 — --file (backup thật qua db-ops.sh — TEST RIG, không phải server production)

**Bối cảnh:** `--file` mode được exercise trên **test rig** — container throwaway
đặt tên đúng cấu hình production mặc định của `db-ops.sh` (`loaviet-db`, user/db
`loaviet`, network riêng kiểu compose, KHÔNG phụ thuộc port host cho các bước
db-ops.sh), migrate graph thật + seed fixture qua ORM, rồi lấy backup bằng chính
`./scripts/db-ops.sh backup` (đường dẫn db-ops.sh thật). Drill chạy
`--file` với dump đó: `db-ops.sh verify` restore vào DB mới
`loaviet_restore_verify_<ts>`, drill parse đúng tên, chạy ĐẦY ĐỦ 4 nhóm check
(source vs DB verify qua `docker exec loaviet-db psql` — local socket, không host
pg tools; `prisma db verify` trong node container trên network db), rồi DROP DB
verify đúng tên. **Kết quả: 14 PASS / 0 FAIL / 0 CANNOT RUN — PASS (exit 0).**

```text
── drill --file: verify backup thật qua db-ops.sh (stack production: loaviet-db/loaviet)
── file: …/backups/db-loaviet-20261006T152047Z.dump (140K, tuổi 5s)
→ Archive nguồn: database 'loaviet' (37 bảng dữ liệu)
→ CREATE DATABASE loaviet_restore_verify_20261006T152052Z (mới — không đè gì đang có)
→ pg_restore vào loaviet_restore_verify_20261006T152052Z…
✓ Restore xong: loaviet_restore_verify_20261006T152052Z — 34 bảng trong schema public
  So sánh với nguồn: bảng 34 → đích 34 · dòng User 2 → đích 2
── DB verify của lần chạy này: loaviet_restore_verify_20261006T152052Z
── verify (file) 1/4: table count parity (schema public) — loaviet vs loaviet_restore_verify_20261006T152052Z
    ✓ PASS: table count parity: 34 bảng (public) — source == verify DB
── verify (file) 2/4: row counts (source vs verify DB)
    ✓ PASS: row count User: 2 == 2
    ✓ PASS: row count Listing: 1 == 1
    ✓ PASS: row count Order: 1 == 1
    ✓ PASS: row count OrderItem: 1 == 1
    ✓ PASS: row count Payment: 1 == 1
    ✓ PASS: row count Category: 1 == 1
── verify (file) 3/4: read back equal (toàn bộ dòng từng bảng, source vs verify DB — KHÔNG in nội dung)
    ✓ PASS: read back equal: User (2 dòng byte-equal)
    ✓ PASS: read back equal: Listing (1 dòng byte-equal)
    ✓ PASS: read back equal: Order (1 dòng byte-equal)
    ✓ PASS: read back equal: OrderItem (1 dòng byte-equal)
    ✓ PASS: read back equal: Payment (1 dòng byte-equal)
    ✓ PASS: read back equal: Category (1 dòng byte-equal)
── verify (file) 4/4: prisma db verify (marker + schema khớp contract) trên loaviet_restore_verify_20261006T152052Z — node container
    ✓ PASS: prisma db verify (node container): marker + schema khớp contract (exit 0)
── dọn: DROP DATABASE loaviet_restore_verify_20261006T152052Z (DB verify của lần chạy này)

════ EVIDENCE — paste vào docs/operations/restore-drill-evidence.md (REDACT host/IP) ════
- Ngày (UTC): 2026-10-06T15:21:04Z
- Host: (redacted — máy dev, docker 27.5.1)
- Mode: --file (backup thật, stack loaviet-db/loaviet — TEST RIG throwaway, không phải server production)
- File: …/backups/db-loaviet-20261006T152047Z.dump (140K) · backup freshness (RPO đo được): 5s
- Verify duration (restore vào DB mới + checks): 2s (mẫu RTO đo được)
- Checks: 14 PASS / 0 FAIL / 0 CANNOT RUN (table parity · row counts · read-back equal · prisma db verify)
- DB verify loaviet_restore_verify_20261006T152052Z đã DROP (dọn đúng tên lần chạy này).
══════════════════════════════════════════════════════════════════════════

PASS: drill --file xong — mọi check PASS (gate evidence).
```

**Fallback smoke-only đã exercise** (cùng rig, giấu tạm `node_modules/.bin/prisma` để
giả host docker-only): `13 PASS / 0 FAIL / 1 CANNOT RUN` → script in đúng
`restore smoke only — NOT gate evidence` + **exit 1** (lần chạy đó không dùng làm
gate evidence), DB verify vẫn được DROP đúng tên. Khôi phục lại prisma bin sau test.

Ghi chú lần chạy này:

- Rig tear-down đầy đủ sau test (container + network + dump đã xoá, không còn
  `loaviet-*`).
- **Lần chạy `--file` trên server production THẬT** (stack `loaviet-db` thật,
  `DB_PASSWORD` từ env/.env) vẫn là **bước pre-launch của operator** — ghi mục
  dated mới sau khi chạy trên server; các con số RPO/RTO thật lấy từ lần đó.
