# LoaViet — Nền tảng trung gian mua bán & trao đổi loa

Marketplace chuyên biệt cho loa & thiết bị âm thanh: người bán trưng bày sản phẩm, người mua tham khảo và giao dịch qua cơ chế **escrow** (nền tảng giữ tiền đến khi nhận hàng), nền tảng thu **hoa hồng %** khi giao dịch hoàn tất. Hỗ trợ **trao đổi loa + tiền bù**.

## Stack

- **Next.js 16** (App Router, TypeScript, Tailwind CSS v4) — full-stack, server actions
- **PostgreSQL 16** + **Prisma 8** (contract-first, PSL schema tại `src/prisma/contract.prisma`)
- **Auth**: JWT session (jose) + bcrypt, cookie httpOnly
- **Chat**: polling 3s qua route handler
- **Thanh toán**: MoMo Payment Gateway v2 (verify chữ ký HMAC IPN, escrow tự động) — mock gateway chỉ dùng ở dev (server action tự chặn khi NODE_ENV=production)

**Yêu cầu runtime:** Node ≥ 22 (khớp Docker image `node:22-alpine`), npm ≥ 10.

## Chạy dự án

```bash
# 1. PostgreSQL (Docker)
docker run -d --name speaker-postgres \
  -e POSTGRES_USER=speaker -e POSTGRES_PASSWORD=speaker123 \
  -e POSTGRES_DB=speaker_platform -p 5435:5432 postgres:16-alpine

# 2. Cấu hình
cp .env.example .env   # đặt tối thiểu: DATABASE_URL, AUTH_SECRET, SEED_PASSWORD

# 3. Schema → DB (graph migration — replay được, xem migrations/app/)
npx prisma db migrate

# 4. Dữ liệu mẫu (chỉ dev — cần SEED_PASSWORD ≥ 8 ký tự, từ chối ở production)
SEED_PASSWORD=<mật khẩu dev> npx tsx src/prisma/seed.ts

# 5. Chạy
npm run dev
```

**Tài khoản mẫu** (mật khẩu = giá trị `SEED_PASSWORD` bạn đặt): `admin@loaviet.vn` · `seller1@loaviet.vn` · `buyer@loaviet.vn`

## Luồng escrow (vòng đời giao dịch)

```
Buyer đặt đơn (escrow) → trả tiền vào nền tảng → tiền ĐƯỢC GIỮ
  → Seller gửi hàng (mã vận đơn) → Buyer nhận hàng
  → Buyer xác nhận → nền tảng trừ hoa hồng % → giải ngân cho seller
  → (không xác nhận? tự giải ngân sau 7 ngày — trừ khi có khiếu nại)
```

Phiền bù: hủy đơn hoàn tiền escrow, khiếu nại đóng băng giải ngân, admin xử nghiêng buyer/seller.

## Tính năng

| Nhóm | Chi tiết |
|---|---|
| **Người mua** | Trang chủ, tìm kiếm full-text (Postgres), filter (danh mục/hãng/giá/tình trạng/khu vực), giỏ hàng, checkout 3 hình thức (escrow / chuyển khoản / COD), theo dõi đơn + timeline, xác nhận nhận hàng, đánh giá, khiếu nại, wishlist ❤️ |
| **Người bán** | Đăng tin (upload ảnh, 8 tình trạng sản phẩm), sửa tin, ẩn/xóa, duyệt tin bởi admin, xác nhận nhận tiền, gửi hàng + mã vận đơn, thống kê doanh thu & hoa hồng đã đóng |
| **Trao đổi** | Đề nghị đổi loa lấy loa + tiền bù, chấp nhận/từ chối, tiền bù qua escrow, hoàn tất giải ngân (hoa hồng trên tiền bù) |
| **Chat** | Hội thoại theo tin đăng, polling realtime, đã đọc |
| **Admin** | Dashboard (GMV, hoa hồng, escrow đang giữ), duyệt/từ chối tin, quản lý đơn, xử lý khiếu nại (hoàn tiền / giải ngân), xác minh seller, cấu hình hoa hồng % theo danh mục, audit log |
| **Uy tín** | Đánh giá sau giao dịch, badge xác minh seller |

## Quy tắc dữ liệu (theo master plan)

- Tiền VND = **integer**, không float · Timestamp UTC (text) · ID **UUID**
- **Snapshot** listing trong OrderItem (title/price/image) · **Audit log** mọi thao tác admin
- **OrderStatusHistory** — mọi chuyển trạng thái đơn được ghi vết · Chuyển trạng thái validate trong server action
- Hoa hồng cấu hình **theo danh mục** trong DB, không hardcode

## Cấu trúc

```
app/                    # routes (buyer / seller / admin cùng codebase)
  (auth)/ login, register
  listings/            # duyệt + chi tiết + đề nghị trao đổi
  sell/                # đăng tin, sửa tin, tin của tôi
  cart/ checkout/      # giỏ hàng + thanh toán
  orders/              # đơn mua + đơn bán + chi tiết (timeline escrow)
  exchange/ chat/ wishlist/ profile/
  admin/               # dashboard, duyệt tin, đơn, khiếu nại, users, cấu hình
  api/                 # upload, chat polling, logout
src/
  prisma/              # contract.prisma (schema), db.client.ts (runtime), seed.ts
  lib/                 # auth, utils, constants
    actions/           # server actions theo domain (orders, listings, exchange, ...)
  components/          # UI dùng chung
```

## Vận hành (ops)

| Lệnh | Ý nghĩa |
|---|---|
| `npm run preflight` | 7 gate release: contract drift, lint, tsc, unit tests, build, compose config, migration graph |
| `npm run test:integration` | escrow/ledger invariants trên scratch DB (postgres container tự tạo + tự dọn) |
| `npm run smoke` | production server (standalone) + scratch DB: health, cron 401, IPN 400 |
| `npm run docker:smoke` | build image production + compose stack cô lập end-to-end |

Runbook đầy đủ (release/rollback/migration status/stop gates/backup): **docs/runbook.md** ·
Triển khai: **docs/deployment.md** · Backup/restore: **docs/backup-restore.md**.

> Lưu ý Prisma 8: `prisma contract emit` (chạy trong prebuild) ghi đè `src/prisma/db.ts`
> về scaffold — mọi tuỳ biến runtime nằm ở `src/prisma/db.client.ts`, toàn app import từ đó.

## Kế hoạch tiếp theo (V2 — theo master plan)

- Product Model tách khỏi Listing (catalog chuẩn hóa + specs)
- Cổng thanh toán thật (VNPay/MoMo) + double-entry ledger + reconciliation
- Offer / trả giá, price intelligence, AI Speaker Finder
- Mobile app (React Native) tái dùng API
