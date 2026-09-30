/**
 * Seed Product Models (§5) — tạo catalog chuẩn hóa, link listings hiện có,
 * ghi PriceHistory. Chạy: npx tsx src/prisma/seed-models.ts
 */
import { db } from "./db";
import { slugify } from "../lib/utils";

type ModelSeed = {
  brand: string;
  name: string;
  categorySlug: string;
  releaseYear?: number;
  specs: Record<string, string>;
  description: string;
  matchListingSlug: string; // tin seed tương ứng để link
};

const MODELS: ModelSeed[] = [
  {
    brand: "JBL", name: "EON715", categorySlug: "loa-thung-pa", releaseYear: 2022,
    specs: { "Công suất": "1300W", "Woofer": "15 inch", "Crossover": "DSP built-in", "Kết nối": "Bluetooth 5.0 + XLR", "Trọng lượng": "18.6 kg" },
    description: "Loa thùng active 15 inch dòng EON700 — PA di động cho sự kiện nhỏ và hội trường.",
    matchListingSlug: "loa-thung-jbl-eon715-15-inch-1300w-chinh-hang",
  },
  {
    brand: "Yamaha", name: "Stagepas 600I", categorySlug: "loa-keo", releaseYear: 2019,
    specs: { "Công suất": "630W", "Cấu hình": "2 loa + mixer 10 kênh", "Kết nối": "Bluetooth + USB", "Pin": "Không (điện lưới)", "Trọng lượng": "15.4 kg" },
    description: "Hệ thống PA di động all-in-one của Yamaha — mixer tích hợp, phù hợp hộ gia đình và hội trường nhỏ.",
    matchListingSlug: "loa-keo-yamaha-stagepas-600i-dung-2-nam-con-moi",
  },
  {
    brand: "Bose", name: "S1 Pro+", categorySlug: "loa-bluetooth", releaseYear: 2022,
    specs: { "Công suất": "150W", "Kết nối": "Bluetooth + XLR + RCA", "Pin": "11 giờ", "Kênh": "3 kênh mixer", "Trọng lượng": "6.4 kg" },
    description: "Loa portable cho ca sĩ diễn nhỏ — pin trâu, âm Bose đặc trưng.",
    matchListingSlug: "bose-s1-pro-loa-bluetooth-di-dong-cho-ca-si",
  },
  {
    brand: "Marshall", name: "Stanmore III", categorySlug: "loa-bookshelf", releaseYear: 2022,
    specs: { "Công suất": "80W", "Cấu hình": "2.0 (2 woofer + 1 tweeter)", "Kết nối": "Bluetooth 5.2 + RCA + 3.5mm", "Trọng lượng": "4.2 kg" },
    description: "Loa nghe nhạc thiết kế cổ điển Marshall — âm ấm, treble sáng.",
    matchListingSlug: "loa-marshall-stanmore-iii-hang-hi-fi-nghe-nhac",
  },
  {
    brand: "BMB", name: "PM-1285", categorySlug: "loa-sub", releaseYear: 2020,
    specs: { "Công suất": "450W", "Woofer": "12 inch", "Dòng": "Sub karaoke", "Trở kháng": "8 Ω" },
    description: "Sub karaoke BMB hàng Nhật — bass chắc cho quán nhỏ.",
    matchListingSlug: "sub-bmb-pm-1285-loa-tram-cho-quan-karaoke",
  },
  {
    brand: "Behringer", name: "KM750", categorySlug: "ampli-mixer", releaseYear: 2018,
    specs: { "Công suất": "750W × 2 kênh", "Dòng": "Ampli công suất", "Bảo vệ": "Limitter nhiệt", "Kết nối": "XLR + 1/4 TRS" },
    description: "Ampli công suất 2 kênh giá tốt cho dàn sự kiện.",
    matchListingSlug: "ampli-behringer-km750-750w-cho-dan-su-kien",
  },
  {
    brand: "QSC", name: "KLA12", categorySlug: "loa-thung-pa", releaseYear: 2015,
    specs: { "Công suất": "1000W", "Woofer": "12 inch", "Dòng": "Active line array", "Góc phủ": "75°", "Trọng lượng": "17 kg" },
    description: "Line array active — stack dọc cho sự kiện lớn.",
    matchListingSlug: "loa-line-array-qsc-kla12-hang-su-kien-chuyen-nghiep",
  },
  {
    brand: "Shure", name: "BLX24/SM58", categorySlug: "micro", releaseYear: 2014,
    specs: { "Dòng": "Micro không dây", "Tầm sóng": "60m", "Pin": "14 giờ (AA)", "Kênh": "1 kênh", "Thu": "BLX88" },
    description: "Bộ micro không dây huyền thoại cho ca sĩ và hội nghị.",
    matchListingSlug: "micro-shure-blx24-sm58-khong-day-chinh-hang",
  },
  {
    brand: "Electro-Voice", name: "ZLX-12P", categorySlug: "loa-thung-pa", releaseYear: 2013,
    specs: { "Công suất": "1000W", "Woofer": "12 inch", "DSP": "4 preset", "Trọng lượng": "17 kg" },
    description: "Loa thùng active 12 inch phổ biến cho band và sự kiện.",
    matchListingSlug: "loa-thung-ev-zlx-12p-secondhand-gia-tot-cho-band",
  },
  {
    brand: "Sony", name: "SRS-XP500", categorySlug: "loa-bluetooth", releaseYear: 2021,
    specs: { "Công suất": "80W", "Chống nước": "IP67", "Pin": "20 giờ", "Kết nối": "Bluetooth 5.0 + USB-C", "Trọng lượng": "2.5 kg" },
    description: "Loa bluetooth mega bass chống nước — party di động.",
    matchListingSlug: "loa-bluetooth-sony-srs-xp500-mega-bass",
  },
  {
    brand: "Yamaha", name: "MG12XU", categorySlug: "ampli-mixer", releaseYear: 2014,
    specs: { "Kênh": "12 input", "Hiệu ứng": "SPX built-in", "Ghi âm": "USB 2 track", "Phantom": "48V" },
    description: "Mixer analog 12 kênh cho hội trường và quán.",
    matchListingSlug: "mixer-yamaha-mg12xu-12-kenh-cho-hoi-truong",
  },
  {
    brand: "BMB", name: "DH-302", categorySlug: "loa-bookshelf", releaseYear: 2010,
    specs: { "Cấu hình": "Cặp bookshelf 2 loa", "Dòng": "Karaoke Nhật", "Trở kháng": "6 Ω", "Trọng lượng": "5.5 kg/loa" },
    description: "Cặp loa karaoke Nhật đời cổ — âm ngọt màng.",
    matchListingSlug: "loa-bookshelf-bmb-dh-302-pair-hang-nhat",
  },
];

async function main() {
  console.log("📦 Seed Product Models…");

  for (const m of MODELS) {
    const brand = await db.orm.public.Brand.where({ name: m.brand }).first();
    const category = await db.orm.public.Category.where({ slug: m.categorySlug }).first();
    if (!brand || !category) {
      console.log(`⚠ bỏ qua ${m.brand} ${m.name} — thiếu brand/category`);
      continue;
    }

    const slug = slugify(`${m.brand} ${m.name}`);
    const existing = await db.orm.public.ProductModel.where({ slug }).first();
    const model = existing ?? await db.orm.public.ProductModel.create({
      brandId: brand.id,
      categoryId: category.id,
      name: m.name,
      slug,
      releaseYear: m.releaseYear ?? null,
      description: m.description,
      specs: m.specs,
      status: "approved",
    });

    // link listing tương ứng + ghi giá listed
    const listing = await db.orm.public.Listing.where({ slug: m.matchListingSlug }).first();
    if (listing) {
      await db.orm.public.Listing
        .where({ id: listing.id })
        .update({ productModelId: model.id });
      const hasHistory = await db.orm.public.PriceHistory
        .where({ modelId: model.id, listingId: listing.id })
        .first();
      if (!hasHistory) {
        await db.orm.public.PriceHistory.create({
          modelId: model.id,
          listingId: listing.id,
          price: listing.price,
          kind: "listed",
        });
      }
      console.log(`✓ ${m.brand} ${m.name} → link "${listing.title.slice(0, 40)}…"`);
    } else {
      console.log(`✓ ${m.brand} ${m.name} (không có listing match)`);
    }
  }

  const count = await db.orm.public.ProductModel.aggregate((a) => ({ c: a.count() }));
  console.log(`🎉 Hoàn tất — ${count.c} models trong catalog`);
}

main().catch(console.error).then(() => db.close());
