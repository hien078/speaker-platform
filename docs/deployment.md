# 🚀 Triển khai LoaViet lên production

## Kiến trúc triển khai

```
Internet ──► [Nginx/Cloudflare] ──► Docker app (Next.js :3000)
                                        │
                                        ▼
                                  PostgreSQL (Docker volume)

Cron mỗi giờ ──► POST /api/cron/auto-release (Bearer CRON_SECRET) ──► giải ngân escrow quá hạn
```

## 1. Yêu cầu server

| Thông số | Tối thiểu | Khuyến nghị |
|---|---|---|
| CPU | 1 vCPU | 2 vCPU |
| RAM | 1 GB | 2 GB |
| Disk | 10 GB | 20 GB (ảnh upload + DB) |
| OS | Ubuntu 22.04+ | Ubuntu 24.04 |
| Docker | 24+ | 24+ |

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
docker compose -f docker-compose.prod.yml up -d --build

# 4. (Tuỳ chọn) Chạy tay migration khi cần — idempotent, chạy lại không áp lại
docker compose -f docker-compose.prod.yml run --rm migrate

# 5. Kiểm tra sức khoẻ
curl http://localhost:3000/api/health
# → {"ok":true,"db":"up",...}
```

> ⚠️ **KHÔNG chạy `prisma db update` trên DB production** — nó diff trực tiếp
> và không để lại lịch sử migration. Luôn đi qua graph: `db migrate --to production`.
> Seed dữ liệu mẫu cũng KHÔNG chạy ở production (script tự từ chối khi
> NODE_ENV=production) — danh mục/hoa hồng cấu hình qua admin UI.

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

```bash
# backup mỗi đêm 2h — crontab:
0 2 * * * docker exec $(docker ps -qf name=loaviet-db) \
  pg_dump -U loaviet loaviet | gzip > /backup/db-$(date +\%F).sql.gz

# giữ 30 bản gần nhất:
0 3 * * * find /backup -name "db-*.sql.gz" -mtime +30 -delete
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
- [ ] Cloudflare DNS + proxy (chặn DDoS tầng mạng, ẩn IP server)
- [ ] Cấu hình backup DB tự động + test restore 1 lần
