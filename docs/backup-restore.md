# Backup & Restore — PostgreSQL runbook

## Kiến trúc

```
pg_dump (custom format, nén) ──► backups/db-<tên>-<UTC-ts>.dump
                                     │
pg_restore --verify ─────────────────┘  (restore vào DB MỚI, không bao giờ đè)
```

- **Custom format** (`pg_dump -Fc`): nén sẵn, restore từng object, xem được table of contents.
- **Nguyên tắc bất biến**: restore chỉ vào database **MỚI** (`--verify` hoặc `--into`) — script
  **từ chối** nếu đích đã tồn tại hoặc trùng tên nguồn. Không bao giờ restore đè `speaker_platform`
  hay database production.
- **Production**: container `db` (`loaviet-db`) **không publish port ra host**
  (`docker-compose.prod.yml`), nên `pg_dump`/`psql` trên host không kết nối được `localhost:5432`.
  Mọi lệnh dưới đây đi qua `scripts/db-ops.sh`: script chạy `backup-db.sh` / `restore-db.sh`
  trong một container tạm `postgres:16-alpine` (cùng image với db → pg_dump khớp major version),
  gắn vào network của `loaviet-db`. Mật khẩu lấy từ `DB_PASSWORD` trong `.env` và truyền qua
  `PGPASSWORD` — không nằm trong URL, không hiện trong `ps`, không cần cài postgresql-client
  trên host.
- Backup lỗi (sai mật khẩu, db dừng…) trả exit code ≠ 0 và **không để lại file `.dump`** — dump
  ghi vào `*.partial`, chỉ đổi tên khi xong và đọc được TOC, nên `--keep` không bao giờ đếm file hỏng.

## 1. Backup định kỳ (crontab trên server)

```bash
# mỗi đêm 2h — backup DB production, giữ 30 bản gần nhất
0 2 * * * cd /opt/loaviet && ./scripts/db-ops.sh backup --keep 30 >> backups/backup.log 2>&1
```

- Chạy cron bằng user sở hữu thư mục repo (đọc được `.env`, thuộc group `docker`). File backup
  ghi ra `backups/` với uid/gid của user đó.
- `--keep 30`: giữ 30 bản mới nhất (≈1 tháng), xoá bản cũ hơn. **Không truyền `--keep` = giữ toàn bộ.**
- File backup chứa toàn bộ dữ liệu — `chmod 700 backups/`, không commit lên git
  (`.gitignore` đã chặn `backups/`).
- Kiểm tra cron thật sự chạy: `ls -lt backups/ | head` phải thấy file mới mỗi ngày, và
  `tail backups/backup.log` kết thúc bằng `✓ Backup xong`.
- Cấu hình khác mặc định (tên container/user/db): đặt `DB_CONTAINER`, `DB_USER`, `DB_NAME`
  trước lệnh — xem đầu file `scripts/db-ops.sh`.

## 2. Verify backup (non-destructive — chạy ít nhất 1 lần/tuần)

```bash
cd /opt/loaviet
./scripts/db-ops.sh verify backups/db-loaviet-<ts>.dump
```

Restore vào DB **mới** `<tên>_restore_verify_<ts>` — đếm bảng, so số bảng và số dòng `User`
với DB nguồn, in kết quả. DB verify để lại cho người vận hành kiểm tra rồi tự xoá:

```bash
docker exec loaviet-db psql -U loaviet -d postgres -c 'DROP DATABASE "loaviet_restore_verify_<ts>"'
```

## 3. Restore thật (khi cần)

```bash
cd /opt/loaviet

# 1) chọn file backup cần restore
ls -t backups/db-loaviet-*.dump | head

# 2) restore vào DB MỚI (tên khác nguồn — script từ chối đè)
./scripts/db-ops.sh restore backups/db-loaviet-<ts>.dump loaviet_restored

# 3) kiểm tra dữ liệu trong loaviet_restored
docker exec loaviet-db psql -U loaviet -d loaviet_restored -c 'select count(*) from "User"'

# 4) chuyển đổi (cẩn trọng — thao tác vận hành, làm tay). DATABASE_URL trong
#    docker-compose.prod.yml trỏ cố định tới database "loaviet", nên đổi bằng cách
#    đổi tên database (giữ bản cũ để quay lại được), không sửa .env:
docker compose -f docker-compose.prod.yml stop app
docker exec loaviet-db psql -U loaviet -d postgres \
  -c 'ALTER DATABASE loaviet RENAME TO loaviet_old_<ts>' \
  -c 'ALTER DATABASE loaviet_restored RENAME TO loaviet'
docker compose -f docker-compose.prod.yml up -d app
```

`ALTER DATABASE … RENAME` thất bại nếu còn kết nối vào database đó — dừng `app` trước (bước 4),
và không mở `psql` vào `loaviet` trong lúc đổi tên.

## 4. Retention & lưu trữ

- Giữ tối thiểu **30 ngày** bản gần nhất + **1 bản/tháng** lưu riêng (copy ra object storage
  ngoài VPS — rclone/s3 sync) — VPS chết không kéo theo backup.
- Test restore **1 lần sau khi đổi cấu trúc DB lớn** (migration destructive) — verify mode
  ở mục 2 là cách rẻ nhất.
