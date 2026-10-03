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

## 1. Backup định kỳ (crontab trên server)

```bash
# mỗi đêm 2h — backup DB production trong compose stack
0 2 * * * cd /opt/loaviet && ./scripts/backup-db.sh \
  --url "postgresql://loaviet:$DB_PASSWORD@localhost:5432/loaviet" \
  --name loaviet --keep 30 >> backups/backup.log 2>&1
```

- `--keep 30`: giữ 30 bản mới nhất (≈1 tháng), xoá bản cũ hơn. **Không truyền `--keep` = giữ toàn bộ.**
- File backup chứa toàn bộ dữ liệu — chmod thư mục `backups/` cho 600, không commit lên git
  (`.gitignore` đã chặn `backups/`).

## 2. Verify backup (non-destructive — chạy ít nhất 1 lần/tuần)

```bash
./scripts/restore-db.sh --file backups/db-loaviet-<ts>.dump \
  --url "postgresql://speaker:<mật khẩu>@localhost:5432/postgres" --verify
```

Restore vào DB **mới** `<tên>_restore_verify_<ts>` — đếm bảng, so với archive, in kết quả.
DB verify để lại cho người vận hành kiểm tra rồi tự xoá (lệnh in sẵn ở cuối output).

## 3. Restore thật (khi cần)

```bash
# 1) chọn file backup cần restore
ls -t backups/db-loaviet-*.dump | head

# 2) restore vào DB MỚI (tên khác nguồn — script từ chối đè)
./scripts/restore-db.sh --file backups/db-loaviet-<ts>.dump \
  --url "$ADMIN_URL" --into loaviet_restored

# 3) kiểm tra dữ liệu trong loaviet_restored
psql "$ADMIN_URL" -d loaviet_restored -c 'select count(*) from "Order"'

# 4) chuyển đổi (cẩn trọng — thao tác vận hành, làm tay):
#    docker compose -f docker-compose.prod.yml down app
#    đổi DATABASE_URL sang loaviet_restored (hoặc rename DB), up lại
```

## 4. Retention & lưu trữ

- Giữ tối thiểu **30 ngày** bản gần nhất + **1 bản/tháng** lưu riêng (copy ra object storage
  ngoài VPS — rclone/s3 sync) — VPS chết không kéo theo backup.
- Test restore **1 lần sau khi đổi cấu trúc DB lớn** (migration destructive) — verify mode
  ở mục 2 là cách rẻ nhất.
