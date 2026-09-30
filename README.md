# LoaViet — Nền tảng trung gian mua bán & trao đổi loa

Marketplace chuyên biệt cho loa & thiết bị âm thanh: người bán trưng bày sản phẩm, người mua tham khảo và giao dịch qua cơ chế **escrow** (nền tảng giữ tiền đến khi nhận hàng), nền tảng thu **hoa hồng %** khi giao dịch hoàn tất. Hỗ trợ **trao đổi loa + tiền bù**.

## Stack

- **Next.js 16** (App Router, TypeScript, Tailwind CSS v4) — full-stack, server actions
- **PostgreSQL 16** + **Prisma 8** (contract-first, PSL schema tại `src/prisma/contract.prisma`)
- **Auth**: JWT session (jose) + bcrypt, cookie httpOnly
- **Chat**: polling 3s qua route handler
- **Thanh toán**: mock gateway (sẵn sàng cắm VNPay/MoMo)

## Chạy dự án

```bash
# 1. PostgreSQL (Docker)
docker run -d --name speaker-postgres \
  -e POSTGRES_USER=speaker -e POSTGRES_PASSWORD=speaker123 \
  -e POSTGRES_DB=speaker_platform -p 5435:5432 postgres:16-alpine

# 2. Cấu hình
cp .env.example .env   # đã có sẵn .env mặc định cho dev

# 3. Schema → DB
npx prisma contract emit
npx prisma db update --yes

# 4. Dữ liệu mẫu
npx tsx src/prisma/seed.ts

# 5. Chạy
npm run dev
```

**Tài khoản mẫu** (mật khẩu `123456`): `admin@loaviet.vn` · `seller1@loaviet.vn` · `buyer@loaviet.vn`

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
  prisma/              # contract.prisma (schema), db.ts, seed.ts
  lib/                 # auth, utils, constants
    actions/           # server actions theo domain (orders, listings, exchange, ...)
  components/          # UI dùng chung
```

## Kế hoạch tiếp theo (V2 — theo master plan)

- Product Model tách khỏi Listing (catalog chuẩn hóa + specs)
- Cổng thanh toán thật (VNPay/MoMo) + double-entry ledger + reconciliation
- Offer / trả giá, price intelligence, AI Speaker Finder
- Mobile app (React Native) tái dùng API
