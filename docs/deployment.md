# 🚀 Triển khai LoaViet lên production

## Kiến trúc triển khai

```
Internet ──► [Nginx/Cloudflare] ──► Docker app (Next.js :3000)
                                        │
                                        ▼
                                  PostgreSQL (Docker volume)

Cron mỗi giờ ──► POST /api/cron/auto-release (Bearer CRON_SECRET) ──► giải ngân escrow quá hạn
```

### Ảnh upload (b4-holistic round-3 HIGH — KHÔNG dùng public/)

File upload sống **ngoài `public/`** — volume `uploads` mount tại `/app/data/uploads`
(`docker-compose.prod.yml`). Next production chỉ serve file `public/` **tồn tại
khi server start** (scan một lần lúc boot), nên ảnh upload sau đó sẽ 404 mãi mãi
nếu lưu trong `public/`. Serving đi qua route handler `app/uploads/[key]/route.ts`
(đọc đĩa **mỗi request**, key regex chặt `uuid.(jpg|png|webp|gif)`, header
`nosniff` + CSP `default-src 'none'; sandbox` + cache immutable) — URL
`/uploads/<key>` giữ nguyên, row `ListingImageUpload.storageKey` không đổi.

**Deploy lần đầu với Batch 4 (bắt buộc):** compose mount volume `uploads` tại
`/app/data/uploads`. Với **deploy đã chạy Batch ≤4 trước đó** (volume cũ mount
tại `/app/public/uploads`): volume đó giữ nguyên dữ liệu, chỉ đổi đường dẫn
mount sang `/app/data/uploads` — không cần di chuyển file. Với deploy non-compose
chạy `next start`/standalone ngoài Docker: chuyển file cũ
`public/uploads/*` → `data/uploads/` (hoặc đặt `UPLOADS_DIR` trỏ tới thư mục cũ)
trước khi bật bản này, nếu không ảnh cũ 404 qua route handler mới.

Dọn ảnh mồ côi (upload chưa gắn vào tin nào): `scripts/cleanup-uploads.ts`
— chạy qua service `migrate` (service đã mount volume `uploads` tại
`/app/data/uploads` — b4-holistic round-4: thiếu volume này thì script
`--apply` TỪ CHỐI fail-closed, không bao giờ xoá row ownership khi không
chạm được file):

```bash
docker compose -f docker-compose.prod.yml run --rm \
  -v "$PWD/scripts:/app/scripts:ro" -v "$PWD/src:/app/src:ro" \
  migrate npx tsx scripts/cleanup-uploads.ts              # dry-run (chỉ đọc DB)
docker compose -f docker-compose.prod.yml run --rm \
  -v "$PWD/scripts:/app/scripts:ro" -v "$PWD/src:/app/src:ro" \
  migrate npx tsx scripts/cleanup-uploads.ts --apply    # xoá thật (file + row)
```

## 1. Yêu cầu server

| Thông số | Tối thiểu | Khuyến nghị |
|---|---|---|
| CPU | 1 vCPU | 2 vCPU |
| RAM | **2 GB** | 2 GB+ (xem budget bên dưới) |
| Disk | 10 GB | 20 GB (ảnh upload + DB) |
| OS | Ubuntu 22.04+ | Ubuntu 24.04 |
| Docker | 24+ | 24+ |

> **2 GB là TỐI THIỂU thực tế** (b4-holistic round-3): budget worst-case dưới
> đã gồm app container ≈ 550-600MB + db 512m — trên host 1 GB, hai container
> này đã vượt RAM trước khi tính nginx + OS (OOM-kill ngẫu nhiên). Không còn
> khuyến nghị "hạ 512m trên host 1 GB": cap ảnh là hằng số trong
> `src/lib/image-process.ts` (không cấu hình qua env) và 512m thấp hơn
> worst-case decode 50MP đã ghi nhận.

### Bộ nhớ (RAM) — budget chi tiết (Batch 4 Task 3 review fix 2 + b4-holistic round-3)

Khuyến nghị **2GB RAM cho production** — budget worst-case của stack
(1 container app + 1 container db + nginx trên cùng host):

| Thành phần | Đỉnh bộ nhớ | Vì sao bounded |
|---|---|---|
| Next.js baseline (server + SSR) | ~250MB | — |
| 1 re-encode ảnh 50MP progressive JPEG + EXIF rotate | ~300MB transient (decode RGBA + buffer xoay) | Semaphore **1 re-encode đồng thời** + hàng chờ **bounded 2** (`REENCODE_MAX_QUEUE` — đầy → 503 ngay) + **1 upload in-flight/user** + **`uploadBodiesInFlight` process-wide** (b4-holistic round-3: N user đồng thời không cùng pass pre-check rồi buffer hết body ~11-15MB/request — budget tính theo body đang giữ, không chỉ queue waiter) (`src/lib/image-process.ts`, `app/api/upload/route.ts`) |
| Body buffer của tối đa 3 request đồng thời (slot + hàng chờ + body) | ~45MB | Cùng ngân sách bounded 3 (CONCURRENT + QUEUE) |
| Container app (`mem_limit: 768m`) | ≈ 550-600MB worst case | OOM-kill land vào container (`restart: unless-stopped`), không lan sang db/host |
| Container db (`mem_limit: 512m`) | ~128MB shared_buffers + working set | Postgres 16 mặc định; bound chặn query lớn kéo host |

Lưu ý ngoài budget trên: **Next image optimizer (`next/image`) dùng sharp
NGOÀI semaphore re-encode** — nếu bật optimization cho ảnh remote/inline thì
cộng thêm bộ nhớ decode của nó vào budget (hiện `/uploads` được serve qua
route handler đọc đĩa, không qua optimizer).

**Quyết định ghi nhận (recorded decision):** cap JPEG giữ **50MP**
(`IMAGE_MAX_PIXELS` — admitting cảm biến 48MP phone). Một decode 50MP
progressive JPEG ~300MB transient là trần CHẤP NHẬN được vì đã bounded bởi
semaphore 1-đồng-thời + hàng chờ bounded + body counter process-wide +
1 in-flight/user trên host 2GB; PNG/GIF/WebP 8-bit 24MP, interlaced/>8-bit
12MP (xem `src/lib/image-process.ts`).

## 2. Các bước triển khai

```bash
# 1. Clone code lên server
git clone <repo> loaviet && cd loaviet

# 2. Tạo .env production
cat > .env << 'EOF'
DB_PASSWORD=<mật khẩu DB mạnh, sinh bằng openssl rand -hex 16>
AUTH_SECRET=<sinh bằng openssl rand -hex 32>
NEXT_PUBLIC_APP_URL=https://loaviet.vn        # domain thật — MoMo IPN cần URL công khai
CRON_SECRET=<sinh bằng openssl rand -hex 32>  # bảo vệ endpoint cron auto-release
MOMO_PARTNER_CODE=<từ business.momo.vn>
MOMO_ACCESS_KEY=<từ business.momo.vn>
MOMO_SECRET_KEY=<từ business.momo.vn>
MOMO_ENDPOINT=https://payment.momo.vn
EOF
chmod 600 .env

# 3. Build + khởi động
#    Service 'migrate' áp migrations theo graph (migrations/app/) tới ref
#    'production' TỰ ĐỘNG trước khi app start (app depends_on migrate).
#    Trước đó chạy preflight trên máy dev/CI: scripts/preflight.sh
#    (+ scripts/smoke.sh, scripts/docker-smoke.sh — xem docs/runbook.md).
docker compose -f docker-compose.prod.yml up -d --build

# 4. (Tuỳ chọn) Chạy tay migration khi cần — idempotent, chạy lại không áp lại
docker compose -f docker-compose.prod.yml run --rm migrate

# 5. Seed beta catalog (BẮT BUỘC lần đầu sau Batch 4 — xem chú ý dưới)
cd /opt/loaviet   # gốc repo trên VPS
docker compose -f docker-compose.prod.yml run --rm \
  -v "$PWD/scripts:/app/scripts:ro" -v "$PWD/src:/app/src:ro" \
  migrate npx tsx scripts/seed-beta-catalog.ts            # dry-run trước (xem plan)
docker compose -f docker-compose.prod.yml run --rm \
  -v "$PWD/scripts:/app/scripts:ro" -v "$PWD/src:/app/src:ro" \
  -v "$PWD/founder.json:/app/founder.json:ro" `# chỉ khi có file model founder` \
  migrate npx tsx scripts/seed-beta-catalog.ts --apply --models /app/founder.json --allow-production

# 6. Duyệt model pending trong /admin/catalog (founder) — seed tạo model ở
#    status "pending"; model CHỈ hiện trong form đăng tin sau khi được duyệt.
# 7. Kiểm tra sức khoẻ
curl http://localhost:3000/api/health
# → {"ok":true,"db":"up",...}
```

> ⚠️ **KHÔNG chạy `prisma db update` trên DB production** — nó diff trực tiếp
> và không để lại lịch sử migration. Luôn đi qua graph: `db migrate --to production`.
> Seed dữ liệu MẪU (tài khoản demo) KHÔNG chạy ở production (script tự từ chối);
> seed **beta catalog** thì BẮT BUỘC (bước 5 trên): category
> `portable_bluetooth_speaker` + model chuẩn CHỈ được tạo qua
> `scripts/seed-beta-catalog.ts` — không có admin action nào tạo Category, và
> admin UI chỉ sửa hoa hồng trên category đã có. Không seed → `/sell/new`
> không có danh mục, mọi seller bị chặn đăng tin. Script tự từ chối `--apply`
> vào DB non-local khi thiếu `--allow-production` (guard quyết từ ĐÍCH —
> migrate container giờ set `NODE_ENV=production` làm belt-and-braces).
> Rollback: script in ra danh sách slug đã tạo — chỉ xoá những slug đó.

## 3. Nginx reverse-proxy + SSL (Let's Encrypt)

```nginx
server {
    server_name loaviet.vn;
    client_max_body_size 10M;   # upload ảnh

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
# SSL miễn phí
sudo apt install certbot python3-certbot-nginx -y
sudo certbot --nginx -d loaviet.vn
```

## 4. MoMo production — checklist

- [ ] Đăng ký merchant tại **business.momo.vn** → nhận `partnerCode / accessKey / secretKey` thật
- [ ] Điền 3 credentials vào `.env` + `MOMO_ENDPOINT=https://payment.momo.vn`
- [ ] `NEXT_PUBLIC_APP_URL` phải là **HTTPS domain công khai** — MoMo gọi IPN về:
  `https://loaviet.vn/api/payments/momo/ipn`
- [ ] Test 1 giao dịch nhỏ thật (ví dụ 10.000₫) trước khi mở bán

## 5. Backup database

Chi tiết đầy đủ (verify/restore/retention): **docs/backup-restore.md** · Runbook tổng:
**docs/runbook.md** (release/rollback/migration status/stop gates).

```bash
# backup mỗi đêm 2h, giữ 30 bản gần nhất — crontab của user sở hữu /opt/loaviet
# (db không publish port; scripts/db-ops.sh chạy pg_dump trong container tạm cùng network):
0 2 * * * cd /opt/loaviet && ./scripts/db-ops.sh backup --keep 30 >> backups/backup.log 2>&1

# verify restore (non-destructive) 1 lần/tuần:
0 4 * * 0 cd /opt/loaviet && ./scripts/db-ops.sh verify "$(ls -t backups/db-loaviet-*.dump | head -1)" >> backups/verify.log 2>&1
```

## 6. Vận hành thường ngày

```bash
# xem log
docker compose -f docker-compose.prod.yml logs -f app
# Lỗi ghi qua seam src/lib/observability.ts — 1 dòng JSON có scope
# (grep '"scope":"cron:auto-release"' v.v.). Gắn Sentry/GlitchTip/OTel
# sau = thay thân captureError, call-site không đổi (gate tích hợp ngoài).

# cập nhật code mới
git pull && docker compose -f docker-compose.prod.yml up -d --build
# (migrate service tự chạy pending migrations trước khi app start lại)

# vào DB
docker compose -f docker-compose.prod.yml exec db psql -U loaviet
```

### Escrow auto-release — cron mỗi giờ (BẮT BUỘC)

Đơn shipped quá hạn `autoReleaseAt` (mặc định 7 ngày) mà không có khiếu nại
phải tự giải ngân. Việc này KHÔNG chạy theo page load nữa — chạy qua endpoint
cron (idempotent, chỉ xử lý đơn quá hạn):

```bash
# crontab trên server (hoặc cron-job.org / Cloudflare Worker cron):
0 * * * * curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" \
  https://loaviet.vn/api/cron/auto-release
```

Hành vi:
- `200 {"ok":true,"released":N}` — N=0 là bình thường (không có đơn quá hạn).
- `401` sai/thiếu secret · `503` chưa đặt `CRON_SECRET` (fail closed).
- `500` lỗi xử lý (DB down…) — scheduler thử lại chu kỳ kế tiếp; đơn quá hạn
  không mất, vẫn nằm trong tập hợp cho tới khi xử lý được.
- Chạy 2 lần liên tiếp không giải ngân 2 lần (idempotent).

## 7. Chi phí vận hành (tham khảo 2026)

| Dịch vụ | Nhà cung cấp VN | Chi phí/tháng |
|---|---|---|
| VPS 2 vCPU/2GB | Vultr/Hetzner | ~320k–480k₫ |
| VPS 2 vCPU/2GB | Viettel Cloud | ~600k₫ |
| Domain .vn | | ~800k₫/năm (~67k/tháng) |
| SSL | Let's Encrypt | 0₫ |
| MoMo | phí giao dịch | ~1–1.5% mỗi GD (tính vào hoa hồng) |
| **Tổng MVP** | | **~400–700k₫/tháng** |

## 8. Bảo mật — checklist trước khi mở

- [ ] `AUTH_SECRET` mạnh (32+ hex), không dùng giá trị dev
- [ ] `CRON_SECRET` mạnh (32+ hex) — endpoint auto-release fail closed nếu thiếu
- [ ] `.env` chmod 600, không commit lên git
- [ ] DB không expose port ra internet
- [ ] Seed KHÔNG chạy ở production (script tự từ chối NODE_ENV=production; mật khẩu tài khoản mẫu chỉ tồn tại ở dev qua SEED_PASSWORD)
- [ ] Bật rate limit ở Nginx cho `/api/` (limit_req)
- [ ] Rate limit app (in-memory, 1 instance): login/register 10 lần/10 phút/IP, upload 20/10 phút, payment 10/phút, chat 120/phút — KHÔNG có tác dụng nếu scale >1 app instance (bộ nhớ không chia sẻ); khi scale thì chuyển limiter dùng chung (Redis/Postgres)
- [ ] `TRUST_PROXY_HEADERS=true` chỉ khi app KHÔNG expose trực tiếp (compose bind `127.0.0.1:3000`, nginx cùng host proxy sang) — client tự đặt được proxy header; tin sai = bypass rate limit bằng identity giả
- [ ] Cloudflare DNS + proxy (chặn DDoS tầng mạng, ẩn IP server)
- [ ] Cấu hình backup DB tự động + test restore 1 lần
