/**
 * Search integration (Batch 5 Task 7 — spec §5.7/§5.7.1/§5.9/§4.7) — integration
 * tests trên scratch DB (scripts/test-integration.sh: container riêng + migrate
 * + dọn). KHÔNG chạy trong `npm test`.
 *
 * Cổng (plan Task 7 Step 4):
 *  1. Diacritic-insensitive: cột searchTextNormalized (Task 4) khớp qua index
 *     language "simple" — "LOA JBL CHARGE 4" (hoa) khớp, "charge4" (spacing
 *     variant) khớp, "loa do" tìm "Loa đồ chơi" (S-1 — token "do" là stopword
 *     english nhưng âm tiết tiếng Việt bình thường; simple GIỮ nó);
 *  2. Alias-resolved id match: listing có productModelId = id resolved (Task 5)
 *     được tìm qua arm id KHI text không mang query;
 *  3. Location filter: mã canonical lọc chính xác; row unresolved (code null)
 *     KHÔNG xuất hiện dưới filter tỉnh — chỉ hiện ở "all locations" (KHÔNG đoán);
 *  4. Review Focus 3 — permuted-province NO-BOOST: 4 listing cùng tiêu đề ở 4
 *     tỉnh khác nhau, cùng search không-province chạy 2 lần với province codes
 *     HOÁN VỊ giữa 2 lần → thứ tự kết quả GIỐNG HỆT (relevance = textual +
 *     freshness ONLY — listing primary market KHÔNG tự nổi lên);
 *  5. Non-searchable statuses KHÔNG bao giờ xuất hiện (S6 — hidden/pending/
 *     draft seed vô hình trong mọi search);
 *  6. Search dưới rate limit vẫn trả kết quả + emit thật (runSearchWithTelemetry
 *     full stack: rate limit in-memory + emit core dưới key test + read-back).
 *
 * Seed trực tiếp qua db.orm (KHÔNG qua action — action path pin ở unit suites).
 * Emission chạy EMIT CORE THẬT (stub key test base64 32 byte — corrections #9:
 * test-integration.sh chỉ set DATABASE_URL; key thiếu ngoài production là
 * silent no-op fail-open nên phải stub để assert row thật).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// server-only là alias Next (không có package thật trong node_modules) — stub
// như mọi integration test khác (recipe tests/integration/identity-collision.test.ts).
vi.mock("server-only", () => ({}));

import { db } from "../../src/prisma/db.client";
import { resolveSearchQuery } from "../../src/lib/search-resolve";
import {
  BETA_SPEAKER_CATEGORY_SLUG,
  describeSearchQuery,
  runSearchQuery,
  type SearchQueryParams,
} from "../../src/lib/search-query";
import { runSearchWithTelemetry } from "../../src/lib/search-telemetry";
import type { SearchResolution } from "../../src/lib/search-resolve";

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

/** Key test hợp lệ — base64 của đúng 32 byte (cùng fixture unit product-events). */
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

let seq = 0;
const uid = () => `b5-srch-${Date.now()}-${seq++}`;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

async function mkUser(): Promise<string> {
  const u = await db.orm.public.User.create({
    email: `${uid()}@integration.test`,
    passwordHash: "integration-hash",
    name: "B5 Search Seller",
    role: "seller",
  });
  created.users.push(u.id);
  return u.id;
}

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
 * Listing seed trực tiếp — searchTextNormalized caller đặt (đơn giản hơn chạy
 * backfill Task 4 — cùng chuỗi normalizeSearchText(title + brand + model)).
 */
async function seedListing(input: {
  sellerId: string;
  categoryId: string;
  title: string;
  status?: "draft" | "pending" | "approved" | "hidden";
  brandId?: string | null;
  productModelId?: string | null;
  searchTextNormalized?: string | null;
  provinceLevelCode?: string | null;
  city?: string;
  createdAt?: string;
  viewCount?: number;
  price?: number;
}): Promise<string> {
  const l = await db.orm.public.Listing.create({
    sellerId: input.sellerId,
    categoryId: input.categoryId,
    brandId: input.brandId ?? null,
    productModelId: input.productModelId ?? null,
    title: input.title,
    slug: `it-srch-${uid()}`,
    description: "Loa bluetooth cũ còn tốt, pin trâu, nghe hay.",
    condition: "good",
    price: input.price ?? 1_800_000,
    negotiable: false,
    acceptExchange: false,
    status: input.status ?? "approved",
    rejectionReason: null,
    city: input.city ?? "Hà Nội",
    viewCount: input.viewCount ?? 0,
    searchTextNormalized: input.searchTextNormalized ?? null,
    provinceLevelCode: input.provinceLevelCode ?? null,
    ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
  });
  created.listings.push(l.id);
  return l.id;
}

/** Resolution rỗng — search text-only. */
const EMPTY: SearchResolution = { textVariants: [], brandIds: [], productModelIds: [] };

/** Chạy search text-only qua plan thật. */
const searchIds = async (params: SearchQueryParams, resolution: SearchResolution = EMPTY): Promise<string[]> => {
  const { listings } = await runSearchQuery(describeSearchQuery(params, resolution));
  return listings.map((l) => l.id);
};

// ─── Dọn dẹp — FK-safe (thứ tự ngược Restrict) ────────────────────────────────

const created = {
  users: [] as string[],
  categories: [] as string[],
  brands: [] as string[],
  models: [] as string[],
  listings: [] as string[],
  events: [] as string[], // ProductEvent test — xóa theo searchSessionId
};

const cleanupAll = async (): Promise<void> => {
  for (const id of created.events) {
    await db.orm.public.ProductEvent.where({ id }).deleteAll();
  }
  for (const id of created.listings) {
    await db.orm.public.Listing.where({ id }).deleteAll();
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
  created.events.length = 0;
  created.listings.length = 0;
  created.models.length = 0;
  created.brands.length = 0;
  created.categories.length = 0;
  created.users.length = 0;
};

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("PRODUCT_EVENT_PSEUDONYM_KEY", TEST_KEY);
});

afterEach(async () => {
  await cleanupAll();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.close();
});

// ─── 1. Diacritic-insensitive (S-1/S-2) ───────────────────────────────────────

d("diacritic-insensitive search (spec §5.7, S-1/S-2)", () => {
  it("query thường / HOA / spacing variant đều tìm listing normalized", async () => {
    const sellerId = await mkUser();
    const catId = await mkCategory("loa-thung-pa", "Loa thùng PA");
    const brandId = await mkBrand("JBL");
    const modelId = await mkModel(brandId, catId, "Charge 4");

    const a = await seedListing({
      sellerId, categoryId: catId, title: "Loa JBL Charge 4",
      brandId, productModelId: modelId,
      searchTextNormalized: "loa jbl charge 4 jbl charge 4",
    });
    const b = await seedListing({
      sellerId, categoryId: catId, title: "Loa đồ chơi",
      searchTextNormalized: "loa do choi",
    });

    // query thường
    expect(await searchIds({ q: "loa jbl charge 4" })).toContain(a);
    // HOA — normalize lowercase hai phía
    expect(await searchIds({ q: "LOA JBL CHARGE 4" })).toContain(a);
    // spacing variant chữ↔số — "charge4" → tsquery OR-joined "charge4 or charge 4"
    expect(await searchIds({ q: "charge4" })).toContain(a);
    // S-1: "loa do" — token "do" là STOPWORD của english nhưng âm tiết tiếng Việt
    // bình thường; language simple GIỮ nó → khớp "loa do choi" (english sẽ rớt)
    const loaDo = await searchIds({ q: "loa do" });
    expect(loaDo).toContain(b);
    expect(loaDo).not.toContain(a);
    // không khớp → không row
    expect(await searchIds({ q: "loa nonexistent xyz" })).not.toContain(a);
  });

  it("query có dấu tiếng Việt khớp qua stripDiacritics (đ→d — B5)", async () => {
    const sellerId = await mkUser();
    const catId = await mkCategory("loa-thung-pa", "Loa thùng PA");

    const a = await seedListing({
      sellerId, categoryId: catId, title: "Loa đồ chơi trẻ em",
      searchTextNormalized: "loa do choi tre em",
    });

    // "đồ" → "do" (đ KHÔNG có canonical decomposition — B5), "trẻ" → "tre"
    expect(await searchIds({ q: "loa đồ trẻ" })).toContain(a);
  });
});

// ─── 2. Alias-resolved id match (Task 5 → arm id của Task 7) ──────────────────

d("alias-resolved id match (spec §5.7 — resolution ids)", () => {
  it("listing có productModelId = id resolved được tìm KHI text không mang query", async () => {
    const sellerId = await mkUser();
    const catId = await mkCategory("loa-thung-pa", "Loa thùng PA");
    const brandId = await mkBrand("Bose");
    const modelId = await mkModel(brandId, catId, "SoundLink");

    // Listing title KHÔNG chứa "soundlink" — chỉ tìm được qua arm id
    const a = await seedListing({
      sellerId, categoryId: catId, title: "Bass cực mạnh pin trâu",
      brandId, productModelId: modelId,
      searchTextNormalized: "bass cuc manh pin trau bose",
    });

    const resolution = await resolveSearchQuery("soundlink");
    expect(resolution.productModelIds).toContain(modelId);

    const hits = await searchIds({ q: "soundlink" }, resolution);
    expect(hits).toContain(a);
    // text-only (KHÔNG resolution) KHÔNG tìm thấy — chứng minh arm id là nguồn
    expect(await searchIds({ q: "soundlink" })).not.toContain(a);
  });
});

// ─── 3. Location filter (spec §5.9 — canonical only) ─────────────────────────

d("location filter (spec §5.9 — canonical, KHÔNG đoán)", () => {
  it("province canonical lọc chính xác; unresolved chỉ hiện ở all locations", async () => {
    const sellerId = await mkUser();
    const catId = await mkCategory("loa-thung-pa", "Loa thùng PA");

    const haNoi = await seedListing({
      sellerId, categoryId: catId, title: "Loa Hà Nội",
      searchTextNormalized: "loa ha noi", provinceLevelCode: "ha-noi",
    });
    const daNang = await seedListing({
      sellerId, categoryId: catId, title: "Loa Đà Nẵng",
      searchTextNormalized: "loa da nang", provinceLevelCode: "da-nang",
    });
    const unresolved = await seedListing({
      sellerId, categoryId: catId, title: "Loa khu khác",
      searchTextNormalized: "loa khu khac", provinceLevelCode: null, city: "Khác",
    });

    // filter canonical
    const haNoiOnly = await searchIds({ q: "loa", province: "ha-noi" });
    expect(haNoiOnly).toContain(haNoi);
    expect(haNoiOnly).not.toContain(daNang);
    // unresolved KHÔNG xuất hiện dưới filter tỉnh (KHÔNG đoán mã)
    expect(haNoiOnly).not.toContain(unresolved);

    // không filter → mọi khu vực (unresolved hiện lên)
    const all = await searchIds({ q: "loa" });
    expect(all).toContain(unresolved);
    expect(all).toContain(daNang);

    // param city cũ (link legacy) map qua FD-1 rule: "Hà Nội" → ha-noi
    const viaCity = await searchIds({ q: "loa", city: "Hà Nội" });
    expect(viaCity).toContain(haNoi);
    expect(viaCity).not.toContain(daNang);
    expect(viaCity).not.toContain(unresolved);
    // "Khác" → KHÔNG filter (mọi khu vực — KHÔNG đoán)
    const viaKhac = await searchIds({ q: "loa", city: "Khác" });
    expect(viaKhac).toContain(unresolved);
  });
});

// ─── 4. Review Focus 3 — permuted-province NO-BOOST ───────────────────────────

d("no priority-location boost (Review Focus 3 — permuted-province)", () => {
  it("cùng search không-province, province codes hoán vị → thứ tự kết quả GIỐNG HỆT", async () => {
    const sellerId = await mkUser();
    const catId = await mkCategory("loa-thung-pa", "Loa thùng PA");

    // 4 listing cùng tiêu đề (cùng rank textual) ở 4 tỉnh, createdAt KHÁC NHAU
    // (freshness tiebreak deterministic). Primary market = ha-noi.
    const base = Date.now() - 4 * 60_000;
    const rows = [
      { code: "ha-noi", offsetMin: 4 }, // MỚI NHẤT — primary market
      { code: "ho-chi-minh", offsetMin: 3 },
      { code: "da-nang", offsetMin: 2 },
      { code: "hue", offsetMin: 1 },
    ];
    const ids: string[] = [];
    for (const r of rows) {
      ids.push(
        await seedListing({
          sellerId, categoryId: catId, title: "Loa bass deep",
          searchTextNormalized: "loa bass deep",
          provinceLevelCode: r.code,
          createdAt: new Date(base + r.offsetMin * 60_000).toISOString(),
        }),
      );
    }

    // LẦN 1 — thứ tự theo code gốc
    const order1 = await searchIds({ q: "loa bass deep" });
    expect(order1).toEqual(ids); // rank bằng nhau → createdAt desc

    // HOÁN VỊ code giữa các row (đảo ngược) — cùng search, KHÔNG province filter
    const permuted = [rows[3]!.code, rows[2]!.code, rows[1]!.code, rows[0]!.code];
    for (let i = 0; i < ids.length; i++) {
      await db.orm.public.Listing.where({ id: ids[i] }).update({
        provinceLevelCode: permuted[i],
      });
    }

    const order2 = await searchIds({ q: "loa bass deep" });
    // THỨ TỰ GIỐNG HỆT — relevance là textual + freshness ONLY; listing primary
    // market (giờ ở hue) KHÔNG tự nổi lên (spec §5.7 rule 5 + §4.7)
    expect(order2).toEqual(order1);
    expect(order2).toEqual(ids);
  });
});

// ─── 5. Non-searchable statuses (S6) ──────────────────────────────────────────

d("non-searchable statuses KHÔNG bao giờ xuất hiện (S6)", () => {
  it("hidden/pending/draft vô hình trong mọi search", async () => {
    const sellerId = await mkUser();
    const catId = await mkCategory("loa-thung-pa", "Loa thùng PA");

    const approved = await seedListing({
      sellerId, categoryId: catId, title: "Loa hiển thị",
      status: "approved", searchTextNormalized: "loa hien thi",
    });
    const hidden = await seedListing({
      sellerId, categoryId: catId, title: "Loa đã ẩn",
      status: "hidden", searchTextNormalized: "loa hien thi",
    });
    const pending = await seedListing({
      sellerId, categoryId: catId, title: "Loa chờ duyệt",
      status: "pending", searchTextNormalized: "loa hien thi",
    });
    const draft = await seedListing({
      sellerId, categoryId: catId, title: "Loa nháp",
      status: "draft", searchTextNormalized: "loa hien thi",
    });

    const hits = await searchIds({ q: "loa hien thi" });
    expect(hits).toContain(approved);
    expect(hits).not.toContain(hidden);
    expect(hits).not.toContain(pending);
    expect(hits).not.toContain(draft);

    // browsing (không query) cũng KHÔNG bao giờ lộ
    const browse = await runSearchQuery(describeSearchQuery({}, EMPTY));
    expect(browse.listings.map((l) => l.id)).not.toContain(hidden);
    expect(browse.listings.map((l) => l.id)).not.toContain(pending);
    expect(browse.listings.map((l) => l.id)).not.toContain(draft);
  });
});

// ─── 6. Full stack dưới rate limit (S-5/S-6/S-14) ─────────────────────────────

d("runSearchWithTelemetry full stack (rate limit + emission + ?ss=)", () => {
  it("search dưới limit trả kết quả + emit search_submitted thật (read-back)", async () => {
    const sellerId = await mkUser();
    const catId = await mkCategory("loa-thung-pa", "Loa thùng PA");
    const target = await seedListing({
      sellerId, categoryId: catId, title: "Loa JBL Charge 4",
      searchTextNormalized: "loa jbl charge 4",
    });

    const run = await runSearchWithTelemetry({
      user: { id: null, sessionId: null },
      isPrefetch: false,
      ip: "203.0.113.7",
      resolution: EMPTY,
      params: { q: "loa jbl charge 4" },
      loadedCategories: [{ slug: "loa-thung-pa" }],
      loadedBrands: [],
    });

    expect(run.throttled).toBe(false);
    expect(run.resultCount).toBe(1);
    expect(run.listings[0]!.id).toBe(target);
    expect(run.searchSessionId).toMatch(/^[0-9a-f-]{36}$/);
    // event THẬT được ghi (read-back §4.2) — ?ss= của link kết quả trỏ tới row
    expect(run.eventsEmitted.submitted).toBe(true);
    const row = await db.orm.public.ProductEvent.first({
      name: "search_submitted",
      searchSessionId: run.searchSessionId,
    });
    expect(row).not.toBeNull();
    const metadata = row!.metadata as Record<string, unknown>;
    expect(metadata["resultCount"]).toBe(1);
    expect(metadata["resultListingIds"]).toEqual([target]);
    // dọn row test (append-only là luật PRODUCT path — test dọn theo id)
    created.events.push(row!.id);
  });

  it("zero-result: demand record thật + eventsEmitted.zeroResult true (S-6)", async () => {
    await mkUser();
    await mkCategory("loa-thung-pa", "Loa thùng PA");

    const run = await runSearchWithTelemetry({
      user: { id: null, sessionId: null },
      isPrefetch: false,
      ip: "203.0.113.7",
      resolution: EMPTY,
      params: { q: "khong ton tai xyz" },
      loadedCategories: [],
      loadedBrands: [],
    });

    expect(run.resultCount).toBe(0);
    expect(run.eventsEmitted).toEqual({ submitted: true, zeroResult: true });
    const zero = await db.orm.public.ProductEvent.first({
      name: "search_zero_result",
      searchSessionId: run.searchSessionId,
    });
    expect(zero).not.toBeNull();
    expect(zero!.metadata).toMatchObject({
      resolvedBrandIds: [],
      resolvedModelIds: [],
    });
    created.events.push(zero!.id);
    const submitted = await db.orm.public.ProductEvent.first({
      name: "search_submitted",
      searchSessionId: run.searchSessionId,
    });
    created.events.push(submitted!.id);
  });

  it("BETA_SPEAKER_CATEGORY_SLUG là slug Batch 4 (S8) — category row seed được tìm", async () => {
    // S8: slug nguyên văn allowlist — KHÔNG fallback cũ
    expect(BETA_SPEAKER_CATEGORY_SLUG).toBe("portable_bluetooth_speaker");
    const sellerId = await mkUser();
    const catId = await mkCategory(BETA_SPEAKER_CATEGORY_SLUG, "Loa Bluetooth di động");
    const a = await seedListing({
      sellerId, categoryId: catId, title: "Loa di động nhỏ",
      searchTextNormalized: "loa di dong nho",
    });
    const hits = await searchIds({ q: "loa di dong nho", category: BETA_SPEAKER_CATEGORY_SLUG });
    expect(hits).toContain(a);
  });
});
