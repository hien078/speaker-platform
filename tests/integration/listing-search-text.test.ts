/**
 * Listing search-text backfill + full-text queryability (Batch 5 Task 4 — spec
 * §5.7/§8.6, S-1/S-4 + corrections 2026-10-08 item 13) — integration tests trên
 * scratch DB (scripts/test-integration.sh: container riêng + migrate + dọn).
 * KHÔNG chạy trong `npm test`.
 *
 * Cổng (plan Task 4 Step 4):
 *  1. Backfill dry-run: báo cáo would-be counts, KHÔNG ghi gì (spec §8.6);
 *  2. --apply: fill MỌI row null với normalizeSearchText(title + brand.name +
 *     model.name) — exact string; row ĐÃ có text KHÔNG bị đè; lần 2 idempotent
 *     (0 row mới); mọi write là conditional updateAll (corrections item 13 —
 *     CAS `.where(searchTextNormalized.isNull())`, KHÔNG single-row .update());
 *  3. --recompute-all: tính lại MỌI row — sửa staleness sau brand rename/title
 *     edit (S-4); row đã đúng KHÔNG ghi lại (không bump updatedAt oan); CAS theo
 *     updatedAt đã quét — row bị edit giữa scan và write → skip, KHÔNG clobber;
 *  4. Full-text queryable qua index language "simple" (S-1): "loa do" GIỮ token
 *     "do" (english stopword sẽ làm rớt — test pin lý do), uppercase khớp qua
 *     simple dictionary lowercase, query không khớp → không row;
 *  5. Guard --apply (b5-review T2 posture — seed-beta-catalog /
 *     backfill-listing-location): đích non-local / NODE_ENV=production → từ chối
 *     CÓ CHỦ ĐÍCH (--allow-production mở); dry-run KHÔNG bị guard; thiếu
 *     DATABASE_URL → từ chối TRƯỚC khi nạp db.client.
 *
 * KHÔNG import action nào (action path pin ở tests/unit/listing-search-text.test.ts
 * — listing chỉ seed trực tiếp qua db.orm); script chạy HÀM THẬT (main-module
 * guard — import không chạy side effect).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../../src/prisma/db.client";
import { websearchToTsquery } from "@prisma/orm-postgres/target/full-text";
import { backfillListingSearchText } from "../../scripts/backfill-listing-search-text";

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

let seq = 0;
const uid = () => `b5-st-${Date.now()}-${seq++}`;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** User thường (seed trực tiếp — listing seed không cần policy rows). */
async function mkUser(): Promise<string> {
  const u = await db.orm.public.User.create({
    email: `${uid()}@integration.test`,
    passwordHash: "integration-hash",
    name: "B5 SearchText Seller",
    role: "seller",
  });
  created.users.push(u.id);
  return u.id;
}

/** Category create-if-absent THEO SLUG — chỉ track row MÌNH tạo. */
async function mkCategory(slug: string, name: string): Promise<string> {
  const existing = await db.orm.public.Category.first({ slug });
  if (existing) return existing.id;
  const c = await db.orm.public.Category.create({
    name,
    slug,
    commissionRate: 5,
    sortOrder: 0,
    isActive: true,
  });
  created.categories.push(c.id);
  return c.id;
}

async function mkBrand(name: string): Promise<string> {
  const b = await db.orm.public.Brand.create({ name, slug: `slug-${uid()}` });
  created.brands.push(b.id);
  return b.id;
}

async function mkModel(brandId: string, categoryId: string, name: string): Promise<string> {
  const m = await db.orm.public.ProductModel.create({
    brandId,
    categoryId,
    name,
    slug: `slug-${uid()}`,
    status: "approved",
  });
  created.models.push(m.id);
  return m.id;
}

/**
 * Listing seed trực tiếp (không qua action) — status approved, city free-text,
 * searchTextNormalized caller đặt (mặc định null = chưa backfill).
 */
async function seedListing(input: {
  sellerId: string;
  categoryId: string;
  title: string;
  brandId?: string | null;
  productModelId?: string | null;
  searchTextNormalized?: string | null;
}): Promise<string> {
  const l = await db.orm.public.Listing.create({
    sellerId: input.sellerId,
    categoryId: input.categoryId,
    brandId: input.brandId ?? null,
    productModelId: input.productModelId ?? null,
    title: input.title,
    slug: `it-search-${uid()}`,
    description: "Loa bluetooth cũ còn tốt, pin trâu, nghe hay.",
    condition: "good",
    price: 1_800_000,
    negotiable: false,
    acceptExchange: false,
    status: "approved",
    rejectionReason: null,
    city: "Hà Nội",
    viewCount: 0,
    searchTextNormalized: input.searchTextNormalized ?? null,
  });
  return l.id;
}

const rowOf = async (id: string) => db.orm.public.Listing.first({ id });

// ─── Dọn dẹp — FK-safe (thứ tự ngược Restrict) ────────────────────────────────

const created = {
  users: [] as string[],
  categories: [] as string[],
  brands: [] as string[],
  models: [] as string[],
};

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
});

afterEach(async () => {
  // Listing (cascade ảnh/cart) → ProductModel (cascade PriceHistory) → Brand →
  // Category → User (cascade session/policy/membership/notification/upload).
  for (const id of created.users) {
    await db.orm.public.Listing.where({ sellerId: id }).deleteAll();
  }
  for (const id of created.models) {
    await db.orm.public.ProductModel.where({ id }).deleteAll();
  }
  for (const id of created.brands) {
    await db.orm.public.Brand.where({ id }).deleteAll();
  }
  for (const id of created.categories) {
    await db.orm.public.Category.where({ id }).deleteAll();
  }
  for (const id of created.users) {
    await db.orm.public.User.where({ id }).deleteAll();
  }
  created.users.length = 0;
  created.categories.length = 0;
  created.brands.length = 0;
  created.models.length = 0;
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.close();
});

// ─── 1–2. Backfill dry-run + apply + idempotent (spec §8.6) ───────────────────

d("backfill listing search text (Batch 5 Task 4 — spec §8.6, S-4)", () => {
  it("dry-run: báo cáo would-be counts, KHÔNG ghi gì", async () => {
    const sellerId = await mkUser();
    const catId = await mkCategory("loa-thung-pa", "Loa thùng PA");
    const brandId = await mkBrand("JBL");
    const modelId = await mkModel(brandId, catId, "Charge 4");

    const a = await seedListing({ sellerId, categoryId: catId, title: "Loa JBL Charge 4", brandId, productModelId: modelId });
    const b = await seedListing({ sellerId, categoryId: catId, title: "Loa đồ chơi" });
    const c = await seedListing({ sellerId, categoryId: catId, title: "Loa Marshall Emberton 2" });
    // row ĐÃ có text từ trước — predicate scan bỏ qua (alreadyDone)
    const e = await seedListing({ sellerId, categoryId: catId, title: "Loa có sẵn text", searchTextNormalized: "co san text" });

    const before = await db.orm.public.Listing.select("id", "searchTextNormalized").all();
    const report = await backfillListingSearchText(false);

    expect(report.mode).toBe("dry-run");
    expect(report.recomputeAll).toBe(false);
    expect(report.scanned).toBe(3); // a + b + c (null-text)
    expect(report.updated).toBe(3); // would-be
    expect(report.alreadyDone).toBe(1); // e đã có text

    // KHÔNG ghi gì — mọi row nguyên vẹn (sort theo id cho so sánh ổn định)
    const byId = (rows: Array<{ id: string }>) =>
      [...rows].sort((x, y) => (x.id < y.id ? -1 : 1));
    const after = await db.orm.public.Listing.select("id", "searchTextNormalized").all();
    expect(byId(after)).toEqual(byId(before));
    for (const id of [a, b, c]) {
      expect((await rowOf(id))!.searchTextNormalized).toBeNull();
    }
    expect((await rowOf(e))!.searchTextNormalized).toBe("co san text");
  });

  it("--apply: fill MỌI null row (exact string); row đã có KHÔNG đè; lần 2 idempotent (0 row mới)", async () => {
    const sellerId = await mkUser();
    const catId = await mkCategory("loa-thung-pa", "Loa thùng PA");
    const brandId = await mkBrand("JBL");
    const modelId = await mkModel(brandId, catId, "Charge 4");

    const a = await seedListing({ sellerId, categoryId: catId, title: "Loa JBL Charge 4", brandId, productModelId: modelId });
    const b = await seedListing({ sellerId, categoryId: catId, title: "Loa đồ chơi" });
    const e = await seedListing({ sellerId, categoryId: catId, title: "Loa có sẵn text", searchTextNormalized: "co san text" });

    const r1 = await backfillListingSearchText(true);
    expect(r1.mode).toBe("apply");
    expect(r1.scanned).toBe(2); // a + b
    expect(r1.updated).toBe(2);
    expect(r1.alreadyDone).toBe(1); // e

    // exact string — tính tay normalizeSearchText(title + brand.name + model.name):
    //   a: "Loa JBL Charge 4" + "JBL" + "Charge 4" → "loa jbl charge 4 jbl charge 4"
    //   b: title-only (không brand/model) → "loa do choi" (đ→d — B5)
    expect((await rowOf(a))!.searchTextNormalized).toBe("loa jbl charge 4 jbl charge 4");
    expect((await rowOf(b))!.searchTextNormalized).toBe("loa do choi");
    // row đã có text KHÔNG bị đè
    expect((await rowOf(e))!.searchTextNormalized).toBe("co san text");

    // idempotent: predicate scan searchTextNormalized IS NULL không còn khớp —
    // 0 row mới; row đã xong đếm vào alreadyDone.
    const r2 = await backfillListingSearchText(true);
    expect(r2.scanned).toBe(0);
    expect(r2.updated).toBe(0);
    expect(r2.alreadyDone).toBe(3);
    expect((await rowOf(a))!.searchTextNormalized).toBe("loa jbl charge 4 jbl charge 4");
  });

  // ─── 3. --recompute-all — sửa staleness (S-4) ───────────────────────────────

  it("--recompute-all: tính lại MỌI row — sửa staleness sau brand rename + title edit; row đã đúng KHÔNG ghi lại", async () => {
    const sellerId = await mkUser();
    const catId = await mkCategory("loa-thung-pa", "Loa thùng PA");
    const brandId = await mkBrand("JBL");
    const modelId = await mkModel(brandId, catId, "Charge 4");
    const brand2Id = await mkBrand("Marshall");
    const model2Id = await mkModel(brand2Id, catId, "Emberton 2");

    const a = await seedListing({ sellerId, categoryId: catId, title: "Loa JBL Charge 4", brandId, productModelId: modelId });
    const b = await seedListing({ sellerId, categoryId: catId, title: "Loa đồ chơi" });
    // row ĐÃ đúng text (giả lập đã backfill đúng) — recompute-all phải skip (không ghi lại)
    const e = await seedListing({
      sellerId,
      categoryId: catId,
      title: "Loa Marshall Emberton 2",
      brandId: brand2Id,
      productModelId: model2Id,
      searchTextNormalized: "loa marshall emberton 2 marshall emberton 2",
    });

    // fill null rows trước
    await backfillListingSearchText(true);
    expect((await rowOf(a))!.searchTextNormalized).toBe("loa jbl charge 4 jbl charge 4");

    // STALENESS (S-4): brand rename + title edit trực tiếp — text cũ trôi
    await db.orm.public.Brand.where({ id: brandId }).update({ name: "JBL Harman" });
    await db.orm.public.Listing.where({ id: b }).update({ title: "Loa đồ chơi trẻ em" });

    const r = await backfillListingSearchText(true, { recomputeAll: true });
    expect(r.mode).toBe("apply");
    expect(r.recomputeAll).toBe(true);
    expect(r.scanned).toBe(3); // MỌI row
    expect(r.updated).toBe(2); // a (brand mới) + b (title mới) — e đã đúng → skip
    expect(r.alreadyDone).toBe(1); // e text ĐÚNG rồi — KHÔNG ghi lại (không bump updatedAt oan)

    // staleness được sửa — text theo tên brand MỚI + title MỚI:
    expect((await rowOf(a))!.searchTextNormalized).toBe("loa jbl charge 4 jbl harman charge 4");
    expect((await rowOf(b))!.searchTextNormalized).toBe("loa do choi tre em");
    // row đã đúng giữ nguyên byte
    expect((await rowOf(e))!.searchTextNormalized).toBe("loa marshall emberton 2 marshall emberton 2");
  });

  // ─── 4. Full-text queryable qua index language "simple" (S-1) ──────────────

  it("normalized text queryable qua full-text index language 'simple' — 'loa do' GIỮ token do (S-1)", async () => {
    const sellerId = await mkUser();
    const catId = await mkCategory("loa-thung-pa", "Loa thùng PA");
    const brandId = await mkBrand("JBL");
    const modelId = await mkModel(brandId, catId, "Charge 4");

    const a = await seedListing({ sellerId, categoryId: catId, title: "Loa JBL Charge 4", brandId, productModelId: modelId });
    const b = await seedListing({ sellerId, categoryId: catId, title: "Loa đồ chơi" });

    await backfillListingSearchText(true);

    // MỘT tsquery dùng cho match — index language === query language === "simple"
    // (S-1: mismatch = silent sequential scan; pin bởi batch5-migration expression)
    const findIds = async (rawQuery: string): Promise<string[]> => {
      const tsq = websearchToTsquery(rawQuery, { language: "simple" });
      const rows = await db.orm.public.Listing
        .where((l) => l.searchTextNormalized.fullTextMatches(tsq, { language: "simple" }))
        .select("id")
        .all();
      return rows.map((r) => r.id);
    };

    // text thường — mọi token phải có (websearch AND)
    const hits1 = await findIds("loa jbl charge 4");
    expect(hits1).toContain(a);
    expect(hits1).not.toContain(b);

    // uppercase — simple dictionary lowercase query-side (không stemmer)
    const hits2 = await findIds("LOA JBL CHARGE 4");
    expect(hits2).toContain(a);

    // S-1 pin: "loa do" — token "do" là STOPWORD của config english nhưng là
    // âm tiết tiếng Việt bình thường; config simple giữ nó → khớp "loa do choi"
    // (với english tsquery chỉ còn 'loa' → sẽ khớp cả a — test sẽ FAIL).
    const hits3 = await findIds("loa do");
    expect(hits3).toContain(b);
    expect(hits3).not.toContain(a);

    // query không khớp → không row
    const hits4 = await findIds("loa nonexistent xyz");
    expect(hits4).not.toContain(a);
    expect(hits4).not.toContain(b);
  });

  // ─── 5. Guard --apply (b5-review T2 posture) ───────────────────────────────

  it("guard: --apply vào đích NON-LOCAL (không --allow-production) → BACKFILL_REFUSED_NONLOCAL, KHÔNG ghi", async () => {
    const sellerId = await mkUser();
    const catId = await mkCategory("loa-thung-pa", "Loa thùng PA");
    const a = await seedListing({ sellerId, categoryId: catId, title: "Loa JBL Charge 4" });
    // compose migrate → db:5432 (host "db") — guard quyết TỪ ĐÍCH
    vi.stubEnv("DATABASE_URL", "postgresql://loaviet:pw@db:5432/loaviet");

    await expect(backfillListingSearchText(true)).rejects.toThrow(/BACKFILL_REFUSED_NONLOCAL/);
    expect((await rowOf(a))!.searchTextNormalized).toBeNull(); // KHÔNG chạm db
  });

  it("guard: --apply khi NODE_ENV=production (DB local-looking) → BACKFILL_REFUSED_PRODUCTION (belt-and-braces)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const sellerId = await mkUser();
    const catId = await mkCategory("loa-thung-pa", "Loa thùng PA");
    const a = await seedListing({ sellerId, categoryId: catId, title: "Loa JBL Charge 4" });

    await expect(backfillListingSearchText(true)).rejects.toThrow(/BACKFILL_REFUSED_PRODUCTION/);
    expect((await rowOf(a))!.searchTextNormalized).toBeNull();
  });

  it("guard: dry-run KHÔNG bị guard (NODE_ENV=production + đích non-local → vẫn chỉ đọc)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "postgresql://loaviet:pw@db:5432/loaviet");
    const sellerId = await mkUser();
    const catId = await mkCategory("loa-thung-pa", "Loa thùng PA");
    await seedListing({ sellerId, categoryId: catId, title: "Loa JBL Charge 4" });

    const report = await backfillListingSearchText(false);
    expect(report.mode).toBe("dry-run");
    expect(report.scanned).toBe(1); // would-be count — đọc thật, KHÔNG ghi
  });

  it("guard: thiếu DATABASE_URL → từ chối TRƯỚC khi nạp db.client", async () => {
    vi.stubEnv("DATABASE_URL", "");
    await expect(backfillListingSearchText(true)).rejects.toThrow(/DATABASE_URL/);
  });
});
