/**
 * Seed dữ liệu mẫu cho LoaViet — CHỈ dành cho môi trường dev/test.
 * Chạy: SEED_PASSWORD=<mật khẩu dev> npx tsx src/prisma/seed.ts
 *
 * Bảo mật:
 * - Từ chối chạy khi NODE_ENV=production (seed dữ liệu mẫu + mật khẩu
 *   biết trước vào DB thật là lỗ bảo mật).
 * - Mật khẩu các tài khoản mẫu lấy từ env SEED_PASSWORD (≥ 8 ký tự) —
 *   không hardcode, không in ra console.
 */
import { db } from "./db.client";
import bcrypt from "bcryptjs";
import { slugify } from "../lib/utils";
import { writeFileSync, mkdirSync } from "node:fs";

if (process.env.NODE_ENV === "production") {
  console.error("✗ SEED_REFUSED: không seed dữ liệu mẫu ở production (NODE_ENV=production).");
  process.exit(1);
}

/** Đọc + validate SEED_PASSWORD (≥ 8 ký tự) — trả về string đã narrow. */
function requireSeedPassword(): string {
  const password = process.env.SEED_PASSWORD;
  if (!password || password.length < 8) {
    console.error(
      "✗ SEED_PASSWORD chưa đặt (hoặc ngắn hơn 8 ký tự) — đặt trong .env: SEED_PASSWORD=<mật khẩu dev ≥ 8 ký tự>.",
    );
    console.error("  Đây là mật khẩu của các tài khoản mẫu (admin/seller/buyer) — không dùng giá trị thật.");
    process.exit(1);
  }
  return password;
}

const seedPassword = requireSeedPassword();


// ─── Ảnh placeholder SVG ───
function makeSvg(label: string, hue: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${hue}, 45%, 16%)"/>
      <stop offset="100%" stop-color="hsl(${(hue + 60) % 360}, 50%, 8%)"/>
    </linearGradient>
  </defs>
  <rect width="800" height="600" fill="url(#g)"/>
  <g transform="translate(400,270)">
    <rect x="-130" y="-150" width="260" height="300" rx="24" fill="hsl(${hue},30%,12%)" stroke="hsl(${hue},40%,28%)" stroke-width="3"/>
    <circle cx="0" cy="-40" r="72" fill="hsl(${hue},15%,20%)" stroke="hsl(${hue},35%,40%)" stroke-width="4"/>
    <circle cx="0" cy="-40" r="26" fill="hsl(${hue},20%,32%)"/>
    <circle cx="0" cy="90" r="34" fill="hsl(${hue},15%,18%)" stroke="hsl(${hue},35%,36%)" stroke-width="3"/>
  </g>
  <text x="400" y="520" font-family="Arial, sans-serif" font-size="34" font-weight="bold" fill="hsl(${hue},70%,72%)" text-anchor="middle">${label}</text>
</svg>`;
}

mkdirSync("public/img/listings", { recursive: true });

const CATEGORIES = [
  // ─── Taxonomy §4.1 — Speakers ───
  { name: "Loa Bluetooth", slug: "loa-bluetooth", icon: "📶", commissionRate: 6, description: "Loa bluetooth mini, portable" },
  { name: "Loa vi tính", slug: "loa-vi-tinh", icon: "🖥️", commissionRate: 6, description: "Loa máy tính 2.0 / 2.1" },
  { name: "Loa Bookshelf", slug: "loa-bookshelf", icon: "🎵", commissionRate: 4, description: "Loa kệ, nghe nhạc dân hi-fi" },
  { name: "Loa Floorstanding", slug: "loa-floorstanding", icon: "🗼", commissionRate: 4, description: "Loa đứng cột cho phòng nghe lớn" },
  { name: "Soundbar", slug: "soundbar", icon: "📺", commissionRate: 5, description: "Loa thanh cho TV, phim" },
  { name: "Loa Karaoke", slug: "loa-karaoke", icon: "🎤", commissionRate: 5, description: "Loa karaoke gia đình, quán" },
  { name: "Loa kéo (PA di động)", slug: "loa-keo", icon: "🛒", commissionRate: 5, description: "Loa kéo di động, hội trường nhỏ" },
  { name: "Loa thùng PA", slug: "loa-thung-pa", icon: "🔊", commissionRate: 5, description: "Loa thùng chuyên nghiệp sự kiện, sân khấu" },
  { name: "Loa Studio Monitor", slug: "loa-studio-monitor", icon: "🎛️", commissionRate: 5, description: "Loa monitor thu âm, mixing" },
  { name: "Loa Smart / Wi-Fi", slug: "loa-smart-wifi", icon: "🛰️", commissionRate: 6, description: "Loa thông minh, đa phòng" },
  { name: "Loa Outdoor", slug: "loa-outdoor", icon: "🏕️", commissionRate: 6, description: "Loa ngoài trời, chống nước" },
  { name: "Loa Home Theater", slug: "loa-home-theater", icon: "🎬", commissionRate: 5, description: "Loa rạp hát tại gia" },
  { name: "Subwoofer", slug: "loa-sub", icon: "📉", commissionRate: 5, description: "Loa trầm, sub cục, sub gầm sàn" },
  { name: "Loa Passive", slug: "loa-passive", icon: "🔌", commissionRate: 5, description: "Loa thụ động cần ampli" },
  { name: "Loa Active", slug: "loa-active", icon: "⚡", commissionRate: 5, description: "Loa tích hợp ampli" },
  { name: "Loa Vintage / Sưu tầm", slug: "loa-vintage", icon: "📻", commissionRate: 4, description: "Loa cổ, hàng sưu tầm, hiếm" },
  { name: "Loa DIY / Custom", slug: "loa-diy-custom", icon: "🛠️", commissionRate: 5, description: "Loa tự chế, custom DIY" },
  // ─── Taxonomy §4.2 — Accessories ───
  { name: "Ampli / Mixer", slug: "ampli-mixer", icon: "🎚️", commissionRate: 6, description: "Ampli, mixer, vang số chuyên nghiệp" },
  { name: "Micro", slug: "micro", icon: "🎙️", commissionRate: 8, description: "Micro có dây, không dây" },
  { name: "Chân đế & Mount", slug: "chan-de-mount", icon: "🏗️", commissionRate: 8, description: "Chân loa, giá treo, mount tường" },
  { name: "Cáp & Jack", slug: "cap-jack", icon: "🧵", commissionRate: 8, description: "Cáp loa, cáp tín hiệu, jack" },
  { name: "DAC / Card âm thanh", slug: "dac", icon: "💠", commissionRate: 6, description: "DAC, interface, card âm thanh" },
  { name: "Phụ kiện khác", slug: "phu-kien-khac", icon: "🧰", commissionRate: 8, description: "Pin, adapter, remote, phụ kiện thay thế" },
];

const BRANDS = [
  "JBL", "Bose", "Yamaha", "Sony", "Marshall", "Behringer",
  "Electro-Voice", "QSC", "dB Technologies", "BMB", "Fender", "Shure",
];

type SeedListing = {
  title: string;
  categorySlug: string;
  brand: string;
  price: number;
  condition: "new" | "like_new" | "good" | "fair";
  city: string;
  sellerEmail: string;
  acceptExchange: boolean;
  negotiable: boolean;
  description: string;
  status?: "approved" | "pending";
};

const LISTINGS: SeedListing[] = [
  {
    title: "Loa thùng JBL EON715 15 inch 1300W chính hãng",
    categorySlug: "loa-thung-pa", brand: "JBL", price: 18500000, condition: "new",
    city: "Hà Nội", sellerEmail: "seller1@loaviet.vn", acceptExchange: false, negotiable: true,
    description: "Loa thùng active JBL EON715 công suất 1300W, mới 100% nguyên seal bảo hành chính hãng 24 tháng. Âm thanh trong trẻo, bass mạnh, phù hợp sân khấu sự kiện, hội trường. Hỗ trợ bluetooth 5.0, màn LCD điều chỉnh. Sản phẩm bán kèm thùng đựng gốc.",
  },
  {
    title: "Loa kéo Yamaha Stagepas 600I dùng 2 năm còn mới",
    categorySlug: "loa-keo", brand: "Yamaha", price: 12500000, condition: "like_new",
    city: "TP. Hồ Chí Minh", sellerEmail: "seller1@loaviet.vn", acceptExchange: true, negotiable: true,
    description: "Loa kéo Yamaha Stagepas 600I, mua 2024 tại Yamaha Việt Nam, còn bảo hành 6 tháng. Máy chạy êm, pin còn trên 80%. Full hộp, sách hướng dẫn. Sẵn sàng trao đổi với loa thùng cùng phân khú + tiền bù.",
  },
  {
    title: "Bose S1 Pro+ loa bluetooth di động cho ca sĩ",
    categorySlug: "loa-bluetooth", brand: "Bose", price: 9800000, condition: "like_new",
    city: "Đà Nẵng", sellerEmail: "seller2@loaviet.vn", acceptExchange: false, negotiable: false,
    description: "Bose S1 Pro+ bản mới nhất, dùng 6 tháng, pin còn tốt chạy liên tục 8 tiếng. Âm Bose đặc trưng, nhẹ 6.5kg dễ mang đi diễn. Full box. Không trao đổi, chỉ bán nhanh.",
  },
  {
    title: "Loa Marshall Stanmore III hàng hi-fi nghe nhạc",
    categorySlug: "loa-bookshelf", brand: "Marshall", price: 7250000, condition: "new",
    city: "Hà Nội", sellerEmail: "seller2@loaviet.vn", acceptExchange: true, negotiable: false,
    description: "Marshall Stanmore III mới nguyên seal, mua về không dùng do dư loa. Âm ấm cổ điển, thiết kế da vân gỗ sang trọng. Sẵn sàng trao đổi với loa bluetooth cao cấp khác.",
  },
  {
    title: "Sub BMB PM-1285 loa trầm cho quán karaoke",
    categorySlug: "loa-sub", brand: "BMB", price: 8900000, condition: "good",
    city: "Hải Phòng", sellerEmail: "seller3@loaviet.vn", acceptExchange: false, negotiable: true,
    description: "Sub BMB PM-1285 hàng Nhật, dùng trong quán 3 năm, còn chạy rất khỏe. Màng loa mới thay 6 tháng trước. Quán nâng cấp lên line array nên bán. Giá thương lượng cho ai lấy nhanh.",
  },
  {
    title: "Ampli Behringer KM750 750W cho dàn sự kiện",
    categorySlug: "ampli-mixer", brand: "Behringer", price: 5600000, condition: "good",
    city: "TP. Hồ Chí Minh", sellerEmail: "seller3@loaviet.vn", acceptExchange: true, negotiable: true,
    description: "Ampli công suất Behringer KM750 2 kênh 750W, chạy ổn định 2 năm không lỗi. Lạnh máy nhanh, bảo vệ nhiệt tốt. Trao đổi với mixer cùng tầm hoặc bán giá tốt.",
  },
  {
    title: "Loa line array QSC KLA12 hàng sự kiện chuyên nghiệp",
    categorySlug: "loa-thung-pa", brand: "QSC", price: 26500000, condition: "like_new",
    city: "TP. Hồ Chí Minh", sellerEmail: "seller1@loaviet.vn", acceptExchange: false, negotiable: true,
    description: "QSC KLA12 active line array, 12 inch, 1000W. Hàng dựng sự kiện 1 năm, còn 95%. Âm phủ xa, treble sáng. Bán nguyên dàn 4 hộp hoặc lẻ. Có hỗ trợ vận chuyển lắp đặt trong TP.HCM.",
  },
  {
    title: "Micro Shure BLX24/SM58 không dây chính hãng",
    categorySlug: "micro", brand: "Shure", price: 4350000, condition: "new",
    city: "Hà Nội", sellerEmail: "seller2@loaviet.vn", acceptExchange: false, negotiable: false,
    description: "Micro không dây Shure BLX24/SM58 mới 100%, full box bảo hành. Dùng cho ca sĩ, hội nghị. Sóng ổn định 60m, pin AA chạy 14 tiếng.",
  },
  {
    title: "Loa thùng EV ZLX-12P secondhand giá tốt cho band",
    categorySlug: "loa-thung-pa", brand: "Electro-Voice", price: 11200000, condition: "good",
    city: "Đà Nẵng", sellerEmail: "seller3@loaviet.vn", acceptExchange: true, negotiable: true,
    description: "Electro-Voice ZLX-12P, dùng diễn band 2 năm, còn rất tốt. DSP built-in 4 preset. Nhận trao đổi với loa kéo + tiền bù. Miễn trung gian, giao dịch qua nền tảng.",
  },
  {
    title: "Loa bluetooth Sony SRS-XP500 mega bass",
    categorySlug: "loa-bluetooth", brand: "Sony", price: 3990000, condition: "new",
    city: "Cần Thơ", sellerEmail: "seller1@loaviet.vn", acceptExchange: false, negotiable: false,
    description: "Sony SRS-XP500 mới seal, chống nước IP67, pin 20 tiếng. Mega bass, đèn LED nhấp nháy theo nhạc. Bảo hành Sony VN 12 tháng.",
  },
  {
    title: "Mixer Yamaha MG12XU 12 kênh cho hội trường",
    categorySlug: "ampli-mixer", brand: "Yamaha", price: 6800000, condition: "like_new",
    city: "Nghệ An", sellerEmail: "seller2@loaviet.vn", acceptExchange: false, negotiable: true,
    description: "Mixer Yamaha MG12XU 12 input, hiệu ứng built-in, USB recording. Mua 2025, ít dùng do quán đóng. Full box. Bán cho ai cần dựng dàn hội trường.",
  },
  {
    title: "Loa bookshelf BMB DH-302 pair hàng Nhật",
    categorySlug: "loa-bookshelf", brand: "BMB", price: 5250000, condition: "fair",
    city: "TP. Hồ Chí Minh", sellerEmail: "seller3@loaviet.vn", acceptExchange: true, negotiable: true,
    description: "Cặp loa karaoke BMB DH-302 hàng Nhật đời cũ nhưng âm rất ngọt. Màng giấy nguyên, gỗ còn chắc. Trao đổi với sub hoặc bán giá tốt cho ae chơi nhạc.",
  },
];

async function main() {
  console.log("🌱 Bắt đầu seed…");

  // ─── Xóa dữ liệu cũ (theo thứ tự FK) ───
  // deleteAll (KHÔNG .delete()): terminal đơn-row chỉ xoá row ĐẦU khớp filter
  // — seed re-run phải SẠCH từng bảng, nếu không create đụng unique constraint
  // (User.email/Cart.userId…) ngay dòng đầu.
  await db.orm.public.AdminAuditLog.where({}).deleteAll();
  await db.orm.public.OrderStatusHistory.where({}).deleteAll();
  await db.orm.public.Dispute.where({}).deleteAll();
  await db.orm.public.Review.where({}).deleteAll();
  // Deal (Batch 6) — DealStatusHistory Cascade theo dealId (KHÔNG xóa history
  // riêng — append-only scan của Batch 6 quét src/); buyer/seller Restrict ⇒
  // PHẢI đứng trước Conversation/Listing/User.
  await db.orm.public.Deal.where({}).deleteAll();
  await db.orm.public.Message.where({}).deleteAll();
  await db.orm.public.Conversation.where({}).deleteAll();
  await db.orm.public.Payment.where({}).deleteAll();
  await db.orm.public.Payout.where({}).deleteAll();
  await db.orm.public.OrderItem.where({}).deleteAll();
  await db.orm.public.Order.where({}).deleteAll();
  await db.orm.public.ExchangeOffer.where({}).deleteAll();
  await db.orm.public.CartItem.where({}).deleteAll();
  await db.orm.public.Cart.where({}).deleteAll();
  await db.orm.public.WishlistItem.where({}).deleteAll();
  await db.orm.public.ListingImage.where({}).deleteAll();
  await db.orm.public.Listing.where({}).deleteAll();
  await db.orm.public.Category.where({}).deleteAll();
  await db.orm.public.Brand.where({}).deleteAll();
  // Batch 7 (cohort operations) — BetaInviteToken TRƯỚC FoundingSellerCandidate
  // (candidate onDelete Restrict — corrections item 32: token row không bao giờ
  // bị product flow xóa, seed tự dọn fixture của mình); candidate trước User
  // để re-seed không đọng prospect mồ côi (userId SetNull chỉ null-hóa, không xóa).
  await db.orm.public.BetaInviteToken.where({}).deleteAll();
  await db.orm.public.FoundingSellerCandidate.where({}).deleteAll();
  await db.orm.public.User.where({}).deleteAll();
  await db.orm.public.PlatformSetting.where({}).deleteAll();

  // ─── Categories ───
  const categories = new Map<string, string>();
  for (let i = 0; i < CATEGORIES.length; i++) {
    const c = CATEGORIES[i]!;
    const cat = await db.orm.public.Category.create({
      name: c.name,
      slug: c.slug,
      icon: c.icon,
      description: c.description,
      commissionRate: c.commissionRate,
      sortOrder: i,
      isActive: true,
    });
    categories.set(c.slug, cat.id);
  }
  console.log(`✓ ${CATEGORIES.length} danh mục`);

  // ─── Brands ───
  const brands = new Map<string, string>();
  for (const name of BRANDS) {
    const b = await db.orm.public.Brand.create({ name, slug: slugify(name) });
    brands.set(name, b.id);
  }
  console.log(`✓ ${BRANDS.length} thương hiệu`);

  // ─── Users ───
  const passwordHash = await bcrypt.hash(seedPassword, 10);
  const admin = await db.orm.public.User.create({
    email: "admin@loaviet.vn", name: "Admin LoaViet", passwordHash, role: "admin", city: "Hà Nội",
  });
  const seller1 = await db.orm.public.User.create({
    email: "seller1@loaviet.vn", name: "Trần Văn Bảy", passwordHash, role: "seller",
    city: "TP. Hồ Chí Minh", phone: "0901111222", isVerifiedSeller: true,
    bio: "Chuyên loa sự kiện 10 năm, uy tín đặt lên hàng đầu.",
  });
  const seller2 = await db.orm.public.User.create({
    email: "seller2@loaviet.vn", name: "Lê Thị Cẩm", passwordHash, role: "seller",
    city: "Đà Nẵng", phone: "0903333444", isVerifiedSeller: true,
  });
  const seller3 = await db.orm.public.User.create({
    email: "seller3@loaviet.vn", name: "Phạm Đức Long", passwordHash, role: "seller",
    city: "Hà Nội", phone: "0905555666", isVerifiedSeller: false,
  });
  const buyer = await db.orm.public.User.create({
    email: "buyer@loaviet.vn", name: "Nguyễn Văn Mua", passwordHash, role: "buyer",
    city: "Hà Nội", phone: "0988888777",
  });
  for (const u of [admin, seller1, seller2, seller3, buyer]) {
    await db.orm.public.Cart.create({ userId: u.id });
  }
  console.log("✓ 5 người dùng (admin@loaviet.vn / seller1-3 / buyer — mật khẩu từ SEED_PASSWORD, không in ra)");

  const sellerByEmail = new Map<string, string>([
    ["seller1@loaviet.vn", seller1.id],
    ["seller2@loaviet.vn", seller2.id],
    ["seller3@loaviet.vn", seller3.id],
  ]);

  // ─── Listings ───
  let imgCount = 0;
  for (const l of LISTINGS) {
    const catId = categories.get(l.categorySlug)!;
    const brandId = brands.get(l.brand)!;
    const sellerId = sellerByEmail.get(l.sellerEmail)!;
    const slug = slugify(l.title);

    const listing = await db.orm.public.Listing.create({
      sellerId,
      categoryId: catId,
      brandId,
      title: l.title,
      slug,
      description: l.description,
      condition: l.condition,
      price: l.price,
      negotiable: l.negotiable,
      acceptExchange: l.acceptExchange,
      status: l.status ?? "approved",
      // b4-holistic round-4 (LOW deploy-risk — backfill): seed row approved ⇒
      // approvedContentAt SET — đúng bất biến production (content đã được
      // admin duyệt; NULL chỉ dành cho row CHƯA qua duyệt). Trước fix: mọi row
      // seed approved giữ NULL → hide→show coi content chưa duyệt → vào
      // pending chờ duyệt lại (mô phỏng sai bất biến sau migration backfill
      // migrations/app/20261007T2007_batch4_round4_approved_content_backfill).
      approvedContentAt: (l.status ?? "approved") === "approved" ? new Date().toISOString() : null,
      city: l.city,
      viewCount: Math.floor(Math.random() * 400) + 20,
    });

    // 2 ảnh placeholder mỗi tin
    for (let i = 0; i < 2; i++) {
      imgCount++;
      const file = `listing-${imgCount}.svg`;
      writeFileSync(`public/img/listings/${file}`, makeSvg(l.brand, (imgCount * 47) % 360));
      await db.orm.public.ListingImage.create({
        listingId: listing.id,
        url: `/img/listings/${file}`,
        sortOrder: i,
      });
    }
  }
  console.log(`✓ ${LISTINGS.length} tin đăng (${imgCount} ảnh)`);

  // ─── Platform settings ───
  await db.orm.public.PlatformSetting.create({
    key: "escrow_auto_release_days",
    value: "7",
  });
  await db.orm.public.PlatformSetting.create({
    key: "default_commission_rate",
    value: "5",
  });

  console.log("🎉 Seed hoàn tất!");
  console.log("   Tài khoản mẫu: admin@loaviet.vn (quản trị) · seller1-3@loaviet.vn (người bán) · buyer@loaviet.vn (người mua)");
  console.log("   Mật khẩu: giá trị SEED_PASSWORD bạn đã đặt (xem .env) — không in ra đây.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .then(() => db.close());
