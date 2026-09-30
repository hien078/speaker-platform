# 🚀 Triển khai LoaViet lên production

## Kiến trúc triển khai

```
Internet ──► [Nginx/Cloudflare] ──► Docker app (Next.js :3000)
                                        │
                                        ▼
                                  PostgreSQL (Docker volume)
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
MOMO_PARTNER_CODE=<từ business.momo.vn>
MOMO_ACCESS_KEY=<từ business.momo.vn>
MOMO_SECRET_KEY=<từ business.momo.vn>
MOMO_ENDPOINT=https://payment.momo.vn
EOF
chmod 600 .env

# 3. Build + khởi động
docker compose -f docker-compose.prod.yml up -d --build

# 4. Tạo schema DB (lần đầu)
docker compose -f docker-compose.prod.yml exec app npx prisma db update --yes

# 5. Seed danh mục + dữ liệu mẫu (tuỳ chọn)
docker compose -f docker-compose.prod.yml exec app npx tsx src/prisma/seed.ts

# 6. Kiểm tra sức khoẻ
curl http://localhost:3000/api/health
# → {"ok":true,"db":"up",...}
```

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

# cập nhật code mới
git pull && docker compose -f docker-compose.prod.yml up -d --build

# giải ngân escrow quá hạn (nên cron mỗi giờ — gọi từ cron trong container hoặc hệ thống ngoài)
curl -X POST https://loaviet.vn/api/cron/auto-release   # nếu có
# hoặc chạy thủ công: exec app npx tsx scripts/auto-release.ts

# vào DB
docker compose -f docker-compose.prod.yml exec db psql -U loaviet
```

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
- [ ] `.env` chmod 600, không commit lên git
- [ ] DB không expose port ra internet
- [ ] Đổi mật khẩu các tài khoản seed (admin@loaviet.vn…)
- [ ] Bật rate limit ở Nginx cho `/api/` (limit_req)
- [ ] Cloudflare DNS + proxy (chặn DDoS tầng mạng, ẩn IP server)
- [ ] Cấu hình backup DB tự động + test restore 1 lần
