# LoaViet — Chợ loa secondhand & mới (private beta)

Nền tảng classifieds cho loa & thiết bị âm thanh trong giai đoạn **private beta**:
người bán đăng tin, người mua tìm kiếm và **nhắn tin trực tiếp** để hỏi giá, xem hàng
và thỏa thuận. **Thanh toán và giao nhận hàng diễn ra độc lập, ngoài LoaViet** —
nền tảng không giữ tiền, không thu hoa hồng và không bảo đảm giao dịch.

> **Tài chính đang tắt (dormant).** `FINANCIAL_FEATURES_ENABLED` mặc định `false`
> và phải giữ `false` trong suốt private beta. Toàn bộ code tài chính cũ
> (escrow, thanh toán MoMo, ví, rút tiền, payout, ledger, hoa hồng) vẫn còn
> trong codebase ở dạng **historical/dormant** — mọi entry point bị chặn
> server-side bằng `assertFinancialFeaturesEnabled()`, mã lỗi ổn định
> `FINANCIAL_FEATURES_DISABLED`. Không có flag nào điều khiển được từ
> client/query/cookie. Chi tiết bề mặt tài chính: `docs/operations/finance-surface-inventory.md`.

## Vòng lặp private beta

```
Discover → Search → Listing → Seller Profile → Chat → Meet / Deal
```

Người mua và người bán gặp nhau, chat, thỏa thuận độc lập; thanh toán và giao
nhận hàng do hai bên tự quyết ngoài nền tảng. LoaViet không giữ tiền, không bảo
đảm người bán, sản phẩm hay giao dịch.

## Stack

- **Next.js 16** (App Router, TypeScript, Tailwind CSS v4) — full-stack, server actions
- **PostgreSQL 16** + **Prisma 8** (contract-first, PSL schema tại `src/prisma/contract.prisma`)
- **Auth**: JWT session (jose) + bcrypt, cookie httpOnly
- **Chat**: polling 3s qua route handler

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

## Tính năng (private beta)

| Nhóm | Chi tiết |
|---|---|
| **Người mua** | Trang chủ, tìm kiếm full-text (Postgres), filter (danh mục/hãng/giá/tình trạng/khu vực), chi tiết tin đăng, **Nhắn người bán** (chat), wishlist ❤️ |
| **Người bán** | Đăng tin (upload ảnh, 8 tình trạng sản phẩm), sửa tin, ẩn/xóa, duyệt tin bởi admin |
| **Chat** | Hội thoại theo tin đăng, polling realtime, đã đọc |
| **Admin** | Dashboard, duyệt/từ chối tin, quản lý users, catalog model, audit log |
| **Catalog** | Product Model tách khỏi Listing (specs + giá tham chiếu), so sánh loa |

## Tài chính dormant (historical — đã tắt)

Code và dữ liệu tài chính cũ được **giữ nguyên, không xóa** (spec §4.3), nhưng
không còn reachable trong beta:

- Public UI đã bỏ: giỏ hàng, checkout, đơn hàng, ví/rút tiền, trả giá, trao đổi
  + tiền bù. Các route này trả **404** khi tài chính tắt (guard
  `financialFeaturesEnabled()` đứng trước mọi read/mutation).
- Backend (server action/route/webhook/cron) chặn bằng
  `assertFinancialFeaturesEnabled()` → `FINANCIAL_FEATURES_DISABLED`.
- Dữ liệu lịch sử (`Order`, `Payment`, `Payout`, `WithdrawRequest`,
  `LedgerEntry`, `Dispute`…) và schema tương ứng được bảo toàn; admin xem
  read-only (Task 5).
- Bật lại chỉ bằng env server `FINANCIAL_FEATURES_ENABLED=true` (ngoài
  production) + restart — không có escape hatch từ client.

## Khu vực beta trọng điểm

Cold-start tập trung vận hành tại **Hà Nội** (khu vực beta trọng điểm), quan sát
tại **TP.HCM**; các tỉnh/thành khác tham gia bình thường theo quy định sản phẩm.
Đây là nhãn vận hành/tuyển dụng — **không** phải cam kết an toàn hay bảo đảm
cho bất kỳ khu vực, cộng đồng nào.

## Quy tắc dữ liệu (theo master plan)

- Tiền VND = **integer**, không float · Timestamp UTC (text) · ID **UUID**
- **Snapshot** listing trong OrderItem (bảng dorm) · **Audit log** mọi thao tác admin
- **OrderStatusHistory** — vết chuyển trạng thái đơn (dorm) · Chuyển trạng thái validate trong server action
- Cấu hình hoa hồng theo danh mục trong DB (dorm — mutation bị chặn khi tài chính tắt)

## Cấu trúc

```
app/                    # routes (buyer / seller / admin cùng codebase)
  (auth)/ login, register
  listings/            # duyệt + chi tiết (CTA "Nhắn người bán")
  sell/                # đăng tin, sửa tin, tin của tôi
  chat/ wishlist/ profile/ notifications/
  compare/ models/     # so sánh + catalog model
  admin/               # dashboard, duyệt tin, users, catalog
  api/                 # upload, chat polling, logout
  cart/ checkout/ orders/ wallet/ offers/ exchange/   # DORM — 404 khi tài chính tắt
  payments/            # DORM — callback provider (Task 3 chặn server-side)
src/
  prisma/              # contract.prisma (schema), db.client.ts (runtime), seed.ts
  lib/                 # auth, utils, constants, financial-features (ranh giới tắt tài chính)
    actions/           # server actions theo domain (listings, chat, ... + finance dorm)
  components/          # UI dùng chung
```

## Vận hành (ops)

| Lệnh | Ý nghĩa |
|---|---|
| `npm run preflight` | 7 gate release: contract drift, lint, tsc, unit tests, build, compose config, migration graph |
| `npm run test:integration` | escrow/ledger invariants trên scratch DB (postgres container tự tạo + tự dọn) |
| `npm run smoke` | production server (standalone) + scratch DB: health, cron 401, mọi entry point finance deny typed 503 `FINANCIAL_FEATURES_DISABLED`, page finance retire 404 |
| `npm run docker:smoke` | build image production + compose stack cô lập end-to-end (cùng hợp đồng finance-disabled) |

Runbook đầy đủ (release/rollback/migration status/stop gates/backup): **docs/runbook.md** ·
Triển khai: **docs/deployment.md** · Backup/restore: **docs/backup-restore.md**.

> Lưu ý Prisma 8: `prisma contract emit` (chạy trong prebuild) ghi đè `src/prisma/db.ts`
> về scaffold — mọi tuỳ biến runtime nằm ở `src/prisma/db.client.ts`, toàn app import từ đó.

## Kế hoạch tiếp theo (sau beta — theo bằng chứng)

- Deal outcome nhẹ (thỏa thuận + ghi kết quả hai bên) thay cho Order cũ
- Seller verification workflow + cohort membership (Batch 2)
- Mở lại tài chính (escrow/thanh toán) chỉ khi có bằng chứng thị trường — code dormant ở trên là điểm khởi điểm
- Price intelligence, AI Speaker Finder, mobile app tái dùng API
