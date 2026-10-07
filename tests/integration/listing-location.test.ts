/**
 * Listing location — integration tests (Batch 5 Task 2 — spec §5.9/§8.3/§8.6,
 * FD-1, S4/B2/B3 + corrections 2026-10-08 items 3–4) — chạy trên scratch DB
 * (scripts/test-integration.sh: container riêng + migrate + dọn). KHÔNG chạy
 * trong `npm test`.
 *
 * Cổng unknown-legacy-location migration (plan Task 2 Step 4 + Acceptance Gate):
 *  1. Backfill dry-run: báo cáo counts theo từng resolution, KHÔNG ghi gì;
 *  2. --apply: legacy rows map CHỈ qua FD-1 rule (registry authoritative —
 *     "Bình Dương" → ho-chi-minh là áp nguồn founder, KHÔNG đoán); "Khác",
 *     tên quận, typo → explicit unresolved; city byte-identical trước/sau
 *     (spec §8.3 preserve — KHÔNG rewrite legacy text);
 *  3. Row Batch-4 (mã hợp lệ, source null) → seller_declared, mã KHÔNG bao giờ
 *     bị đụng (B3); --apply lần 2 = no-op (idempotent — alreadyDone);
 *  4. Rollback nulls ĐÚNG những gì backfill ghi (B3): legacy_mapped/unresolved
 *     mất cả hai trường; declaredIds CHỈ mất locationSource (mã Batch 4 giữ);
 *  5. Action path ghi seller_declared CHỈ từ mã Batch 4 hợp lệ (S4/B2):
 *     create/draft/update beta → seller_declared; submit draft Batch-4-era →
 *     seller_declared;
 *  6. Legacy edit (corrections item 3 — S4 amendment): KHÔNG province + city
 *     GIỮ NGUYÊN → carry forward mã + source (KHÔNG re-queue oan vào pending);
 *     city ĐỔI → re-resolve FD-1 (mapped → mã mới + legacy_mapped; không map →
 *     null + null — backfill sẽ lo);
 *  7. Province filter: CHỈ row mang mã canonical khớp — unresolved row invisible
 *     với bộ lọc tỉnh (không đoán — spec §5.9).
 *
 * Mock recipe (Batch 3 Global Constraints + legacy-listing-compat precedent):
 * `server-only`/`next/cache`/`next/navigation`/`next/headers` mock với
 * vi.hoisted cookie state; AUTH_SECRET + NODE_ENV stub MỌI beforeEach (HKDF
 * ip-hash derive từ AUTH_SECRET — KHÔNG phụ thuộc .env của worktree).
 * Session/rbac/policy/audit/listing actions là THẬT toàn bộ — đăng nhập qua
 * createSession thật trên DB scratch; backfill chạy HÀM THẬT của script
 * (main-module guard — import không chạy side effect).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// ─── Cookie store điều khiển được (next/headers) ──────────────────────────────

const cookieState = vi.hoisted(() => ({ store: new Map<string, string>() }));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => {
      const value = cookieState.store.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string) => {
      cookieState.store.set(name, value);
    },
    delete: (name: string) => {
      cookieState.store.delete(name);
    },
    has: (name: string) => cookieState.store.has(name),
    getAll: () => [...cookieState.store.entries()].map(([name, value]) => ({ name, value })),
  })),
  headers: vi.fn(async () => new Headers()),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
  },
}));

import { db } from "../../src/prisma/db.client";
import { createSession } from "../../src/lib/session";
import { resetRateLimits } from "../../src/lib/rate-limit";
import { PROVINCE_CODES } from "../../src/lib/provinces";
import {
  createListingAction,
  saveListingDraftAction,
  submitListingAction,
  updateListingAction,
} from "../../src/lib/actions/listings";
import { backfillListingLocation } from "../../scripts/backfill-listing-location";

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const PASSWORD_HASH = bcrypt.hashSync("integration-password-123", 10);

let seq = 0;
const uid = () => `b5-loc-${Date.now()}-${seq++}`;

/** Đếm riêng cho storageKey upload (hex thường v4 — offset riêng file). */
let keySeq = 0x3000;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** Seller ĐỦ 8 yêu cầu policy v1 (seed trực tiếp — như legacy-listing-compat.test.ts). */
async function mkVerifiedSeller(): Promise<string> {
  const now = new Date().toISOString();
  const u = await db.orm.public.User.create({
    email: `${uid()}@integration.test`,
    passwordHash: PASSWORD_HASH,
    name: "B5 Loc Seller",
    role: "seller",
    emailVerifiedAt: now,
    phoneVerifiedAt: now,
    sellerType: "individual",
    sellerOperatingProvinceCode: "ha-noi",
  });
  await db.orm.public.PolicyAcceptance.create({
    userId: u.id,
    policyKey: "seller_rules",
    policyVersion: "v1",
    acceptedAt: now,
  });
  await db.orm.public.BetaCohortMembership.create({
    userId: u.id,
    cohort: "founding_seller",
    status: "active",
  });
  await db.orm.public.SellerVerification.create({
    userId: u.id,
    status: "verified",
    method: "operations_review",
    policyVersion: "v1",
    reasonCode: "requirements_met",
    submittedAt: now,
    reviewedAt: now,
  });
  return u.id;
}

/** Category create-if-absent THEO SLUG — chỉ track row MÌNH tạo (reuse không xoá). */
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

/** Catalog beta: category (slug §5.6.1 verbatim) + brand + model APPROVED. */
async function mkBetaCatalog(): Promise<{
  categoryId: string;
  brandId: string;
  modelId: string;
}> {
  const categoryId = await mkCategory("portable_bluetooth_speaker", "Loa Bluetooth di động");
  const brand = await db.orm.public.Brand.create({ name: `JBL ${uid()}`, slug: `jbl-${uid()}` });
  created.brands.push(brand.id);
  const model = await db.orm.public.ProductModel.create({
    brandId: brand.id,
    categoryId,
    name: `Charge 5 ${uid()}`,
    slug: `jbl-charge-5-${uid()}`,
    status: "approved",
  });
  created.models.push(model.id);
  return { categoryId, brandId: brand.id, modelId: model.id };
}

/** Row ListingImageUpload (ownership — spec §5.6.4) của owner — storageKey hex v4. */
async function mkUploadRow(ownerUserId: string): Promise<string> {
  keySeq += 1;
  const hex = (n: number, w: number) => n.toString(16).padStart(w, "0");
  const storageKey = `${hex(keySeq, 8)}-0000-4000-8000-${hex(keySeq, 12)}.webp`;
  await db.orm.public.ListingImageUpload.create({
    ownerUserId,
    storageKey,
    bytes: 204_800,
    width: 2560,
    height: 1440,
  });
  return storageKey;
}

/**
 * Listing LEGACY (đúng shape src/prisma/seed.ts): category legacy, KHÔNG cột
 * structured nào, city free-text, 2 ảnh seed gắn (rule 2 attached compat).
 * locationSource/provinceLevelCode caller đặt (mặc định null = pre-backfill).
 */
async function seedLegacyListing(input: {
  sellerId: string;
  categoryId: string;
  status: "approved" | "pending" | "hidden";
  city: string;
  provinceLevelCode?: string | null;
  locationSource?: "seller_declared" | "legacy_mapped" | "unresolved" | null;
}): Promise<string> {
  const l = await db.orm.public.Listing.create({
    sellerId: input.sellerId,
    categoryId: input.categoryId,
    brandId: null,
    title: "Loa thùng PA JBL Eon715 sự kiện",
    slug: `loa-thung-pa-jbl-eon715-${uid()}`,
    description: "Loa thùng PA cũ còn tốt, bass mạnh, dùng sự kiện ổn.",
    condition: "good",
    price: 11_200_000,
    negotiable: true,
    acceptExchange: false,
    status: input.status,
    rejectionReason: null,
    city: input.city,
    viewCount: 0,
    provinceLevelCode: input.provinceLevelCode ?? null,
    locationSource: input.locationSource ?? null,
  });
  for (const [i, url] of ["/img/listings/it-a.svg", "/img/listings/it-b.svg"].entries()) {
    await db.orm.public.ListingImage.create({
      listingId: l.id,
      url,
      sortOrder: i,
      // ảnh legacy KHÔNG slot (checklistSlot là cột Batch 4 — NULL = legacy)
    });
  }
  return l.id;
}

/**
 * Listing BETA đầy đủ (Batch 4 shape — structured + province + locationDisplayName)
 * + 1 ảnh gắn slot front. locationSource caller đặt (mặc định null = Batch-4-era
 * pre-backfill — row do form Batch 4 ghi mã, source chưa có).
 */
async function seedBetaListing(input: {
  sellerId: string;
  cat: { categoryId: string; brandId: string; modelId: string };
  status: "draft" | "pending" | "approved";
  provinceLevelCode: string;
  locationSource?: "seller_declared" | "legacy_mapped" | "unresolved" | null;
}): Promise<string> {
  const l = await db.orm.public.Listing.create({
    sellerId: input.sellerId,
    categoryId: input.cat.categoryId,
    brandId: input.cat.brandId,
    productModelId: input.cat.modelId,
    title: "Loa JBL Charge 5 chính hãng",
    slug: `it-listing-${uid()}`,
    description: "Loa bluetooth cũ còn tốt, pin trâu, nghe hay.",
    condition: "good",
    price: 1_800_000,
    negotiable: false,
    acceptExchange: false,
    status: input.status,
    city: PROVINCE_CODES[input.provinceLevelCode]!,
    inventoryContext: "used",
    includedAccessories: null,
    knownDefects: null,
    repairHistory: null,
    fulfillmentMethods: ["meetup"],
    provinceLevelCode: input.provinceLevelCode,
    communeLevelCode: null,
    locationDisplayName: "Khu vực Quận 1",
    locationSource: input.locationSource ?? null,
  });
  await db.orm.public.ListingImage.create({
    listingId: l.id,
    url: "/img/listings/it-pub.svg",
    sortOrder: 0,
    checklistSlot: "front",
  });
  return l.id;
}

// ─── Form helpers ─────────────────────────────────────────────────────────────

const fd = (entries: Record<string, string | string[]>): FormData => {
  const form = new FormData();
  for (const [k, v] of Object.entries(entries)) {
    if (Array.isArray(v)) {
      for (const item of v) form.append(k, item);
    } else {
      form.set(k, v);
    }
  }
  return form;
};

/** Form beta đầy đủ (§6.3): brand/model/condition/inventory/fulfillment/province/location + ảnh. */
const betaForm = (
  cat: { categoryId: string; brandId: string; modelId: string },
  over?: {
    listingId?: string;
    provinceLevelCode?: string;
    images?: string[];
    imageSlots?: string[];
  },
): FormData =>
  fd({
    ...(over?.listingId ? { listingId: over.listingId } : {}),
    title: "Loa JBL Charge 5 chính hãng",
    description: "Loa bluetooth cũ còn tốt, pin trâu, nghe hay.",
    categoryId: cat.categoryId,
    brandId: cat.brandId,
    productModelId: cat.modelId,
    condition: "good",
    price: "1800000",
    negotiable: "on",
    inventoryContext: "used",
    fulfillmentMethods: ["meetup"],
    provinceLevelCode: over?.provinceLevelCode ?? "ho-chi-minh",
    locationDisplayName: "Khu vực Quận 1",
    images: over?.images ?? [],
    imageSlots: over?.imageSlots ?? [],
  });

/**
 * Form edit legacy-shaped (corrections item 3): KHÔNG trường province, city
 * free-text (select CITIES của legacy form). Mặc định = ĐÚNG giá trị seed của
 * seedLegacyListing → KHÔNG content change (case carry-forward); over.city
 * đổi → case re-resolve.
 */
const legacyEditForm = (listingId: string, categoryId: string, over?: { city?: string }): FormData =>
  fd({
    listingId,
    title: "Loa thùng PA JBL Eon715 sự kiện",
    description: "Loa thùng PA cũ còn tốt, bass mạnh, dùng sự kiện ổn.",
    categoryId,
    condition: "good",
    price: "11200000",
    negotiable: "on",
    city: over?.city ?? "Hà Nội",
    brandId: "",
    productModelId: "",
    images: ["/img/listings/it-a.svg", "/img/listings/it-b.svg"],
  });

/** Đăng nhập user trên cookie store mock — session thật trong DB scratch. */
const login = async (userId: string): Promise<void> => {
  cookieState.store.clear();
  await createSession(userId);
};

/** Action kết thúc bằng redirect() → throw NEXT_REDIRECT — coi là THÀNH CÔNG/redirect. */
const expectRedirect = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.startsWith("NEXT_REDIRECT:")) return msg.slice("NEXT_REDIRECT:".length);
    throw e;
  }
  return "";
};

/** saveListingDraftAction CREATE redirect /sell/<id>/edit?saved=draft — parse id. */
const DRAFT_REDIRECT_RE = /^\/sell\/([^/]+)\/edit\?saved=draft$/;
const parseDraftId = (url: string): string => {
  const m = DRAFT_REDIRECT_RE.exec(url);
  if (!m) throw new Error(`draft redirect không đúng dạng: ${url}`);
  return m[1]!;
};

// ─── Dọn dẹp — FK-safe (thứ tự ngược Restrict) ────────────────────────────────

const created = {
  users: [] as string[],
  categories: [] as string[], // chỉ category MÌNH tạo (create-if-absent reuse không xoá)
  brands: [] as string[],
  models: [] as string[],
};

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  // HKDF (src/lib/hkdf.ts) derive từ AUTH_SECRET — KHÔNG phụ thuộc .env của worktree.
  vi.stubEnv("AUTH_SECRET", "integration-test-auth-secret-0123456789abcdef");
  resetRateLimits();
  cookieState.store.clear();
});

afterEach(async () => {
  // AuditEvent (SetNull nhưng xoá sạch theo actor/subject mình tạo) → Listing
  // (cascade ảnh/cart — xoá THEO SELLER vì listing do ACTION tạo không có id)
  // → ProductModel (cascade PriceHistory) → Brand → Category →
  // SellerVerification (userId Restrict — PHẢI xoá trước User) → User
  // (cascade session/policy-acceptance/membership/notification/upload).
  for (const id of created.users) {
    await db.orm.public.AuditEvent.where({ actorId: id }).deleteAll();
    await db.orm.public.AuditEvent.where({ subjectId: id }).deleteAll();
  }
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
    await db.orm.public.SellerVerification.where({ userId: id }).deleteAll();
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

// ─── 1–2. Backfill dry-run + apply (spec §8.3/§8.6 — FD-1 rule) ──────────────

d("backfill listing location (Batch 5 Task 2 — spec §8.3/§8.6, FD-1)", () => {
  it("dry-run: báo cáo counts theo từng resolution, KHÔNG ghi gì", async () => {
    const sellerId = await mkVerifiedSeller();
    created.users.push(sellerId);
    const legacyCat = await mkCategory("loa-thung-pa", "Loa thùng PA");

    const haNoiId = await seedLegacyListing({ sellerId, categoryId: legacyCat, status: "approved", city: "Hà Nội" });
    const binhDuongId = await seedLegacyListing({ sellerId, categoryId: legacyCat, status: "approved", city: "Bình Dương" });
    const khacId = await seedLegacyListing({ sellerId, categoryId: legacyCat, status: "approved", city: "Khác" });
    const districtId = await seedLegacyListing({ sellerId, categoryId: legacyCat, status: "approved", city: "Quận 1" });
    const typoId = await seedLegacyListing({ sellerId, categoryId: legacyCat, status: "approved", city: "Ha Noii" });
    const declaredId = await seedBetaListing({ sellerId, cat: await mkBetaCatalog(), status: "approved", provinceLevelCode: "ha-noi" });

    const before = await db.orm.public.Listing.select("id", "city", "provinceLevelCode", "locationSource").all();
    const report = await backfillListingLocation(false);

    expect(report.mode).toBe("dry-run");
    expect(report.scanned).toBe(6);
    expect(report.mapped).toBe(2); // "Hà Nội" + "Bình Dương" (FD-1 — merged legacy name authoritative)
    expect(report.unresolved).toBe(3); // "Khác" + "Quận 1" + "Ha Noii"
    expect(report.declaredBackfilled).toBe(1); // row Batch-4 mang mã ha-noi
    expect(report.declaredIds).toEqual([]); // dry-run KHÔNG đánh dấu gì
    expect(report.alreadyDone).toBe(0);

    // KHÔNG ghi gì — mọi row nguyên vẹn byte (city + mã + source); sort theo id
    // cho so sánh ổn định (thứ tự all() không đảm bảo).
    const byId = (rows: Array<{ id: string }>) =>
      [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
    const after = await db.orm.public.Listing.select("id", "city", "provinceLevelCode", "locationSource").all();
    expect(byId(after)).toEqual(byId(before));
    for (const row of after) {
      expect(row.locationSource).toBeNull();
    }
    // per-case: row legacy KHÔNG bị ghi mã, row Batch-4 KHÔNG bị đụng mã
    expect((await db.orm.public.Listing.first({ id: haNoiId }))!.provinceLevelCode).toBeNull();
    expect((await db.orm.public.Listing.first({ id: binhDuongId }))!.provinceLevelCode).toBeNull();
    for (const id of [khacId, districtId, typoId]) {
      const seeded = await db.orm.public.Listing.first({ id });
      expect(seeded!.provinceLevelCode).toBeNull();
      expect(seeded!.locationSource).toBeNull();
    }
    expect((await db.orm.public.Listing.first({ id: declaredId }))!.provinceLevelCode).toBe("ha-noi");
  });

  it("--apply: legacy rows map CHỈ qua FD-1 rule; phần còn lại unresolved; city byte-identical (spec §8.3)", async () => {
    const sellerId = await mkVerifiedSeller();
    created.users.push(sellerId);
    const legacyCat = await mkCategory("loa-thung-pa", "Loa thùng PA");

    const haNoiId = await seedLegacyListing({ sellerId, categoryId: legacyCat, status: "approved", city: "Hà Nội" });
    const binhDuongId = await seedLegacyListing({ sellerId, categoryId: legacyCat, status: "approved", city: "Bình Dương" });
    const khacId = await seedLegacyListing({ sellerId, categoryId: legacyCat, status: "approved", city: "Khác" });
    const districtId = await seedLegacyListing({ sellerId, categoryId: legacyCat, status: "approved", city: "Thủ Đức" });
    const typoId = await seedLegacyListing({ sellerId, categoryId: legacyCat, status: "approved", city: "Ha Noii" });

    const citiesBefore = await Promise.all(
      [haNoiId, binhDuongId, khacId, districtId, typoId].map(
        async (id) => (await db.orm.public.Listing.first({ id }))!.city,
      ),
    );

    const report = await backfillListingLocation(true);
    expect(report.mode).toBe("apply");
    expect(report.scanned).toBe(5);
    expect(report.mapped).toBe(2);
    expect(report.unresolved).toBe(3);
    expect(report.declaredBackfilled).toBe(0);

    // "Hà Nội" → ha-noi + legacy_mapped (FD-1 rule qua registry)
    const haNoi = await db.orm.public.Listing.first({ id: haNoiId });
    expect(haNoi!.provinceLevelCode).toBe("ha-noi");
    expect(haNoi!.locationSource).toBe("legacy_mapped");
    // "Bình Dương" → ho-chi-minh (merged legacy unit — AUTHORITATIVE per NQ
    // 202/2025/QH15, áp nguồn founder — KHÔNG đoán)
    const binhDuong = await db.orm.public.Listing.first({ id: binhDuongId });
    expect(binhDuong!.provinceLevelCode).toBe("ho-chi-minh");
    expect(binhDuong!.locationSource).toBe("legacy_mapped");
    // "Khác" / district / typo → explicit unresolved — KHÔNG ghi mã (KHÔNG đoán)
    for (const id of [khacId, districtId, typoId]) {
      const row = await db.orm.public.Listing.first({ id });
      expect(row!.provinceLevelCode).toBeNull();
      expect(row!.locationSource).toBe("unresolved");
    }
    // city byte-identical trước/sau trong MỌI case (spec §8.3 preserve)
    const citiesAfter = await Promise.all(
      [haNoiId, binhDuongId, khacId, districtId, typoId].map(
        async (id) => (await db.orm.public.Listing.first({ id }))!.city,
      ),
    );
    expect(citiesAfter).toEqual(citiesBefore);
  });

  // ─── 3. Row Batch-4 → seller_declared, mã không bị đụng (B3) + idempotent ──

  it("row Batch-4 (mã hợp lệ, source null) → seller_declared; mã KHÔNG bị đụng; --apply lần 2 = no-op (B3)", async () => {
    const sellerId = await mkVerifiedSeller();
    created.users.push(sellerId);
    const declaredId = await seedBetaListing({ sellerId, cat: await mkBetaCatalog(), status: "approved", provinceLevelCode: "ha-noi" });

    const r1 = await backfillListingLocation(true);
    expect(r1.scanned).toBe(1);
    expect(r1.declaredBackfilled).toBe(1);
    expect(r1.declaredIds).toEqual([declaredId]); // rollback input (B3)

    const row1 = await db.orm.public.Listing.first({ id: declaredId });
    expect(row1!.locationSource).toBe("seller_declared");
    expect(row1!.provinceLevelCode).toBe("ha-noi"); // mã Batch 4 nguyên vẹn
    expect(row1!.city).toBe("Hà Nội"); // city nguyên vẹn

    // --apply lần 2: predicate scan locationSource IS NULL không còn khớp — 0 row
    // mới (idempotent), row đã xong đếm vào alreadyDone.
    const r2 = await backfillListingLocation(true);
    expect(r2.scanned).toBe(0);
    expect(r2.mapped).toBe(0);
    expect(r2.unresolved).toBe(0);
    expect(r2.declaredBackfilled).toBe(0);
    expect(r2.declaredIds).toEqual([]);
    expect(r2.alreadyDone).toBe(1);

    const row2 = await db.orm.public.Listing.first({ id: declaredId });
    expect(row2!.locationSource).toBe("seller_declared");
    expect(row2!.provinceLevelCode).toBe("ha-noi");
  });

  // ─── 4. Rollback nulls ĐÚNG những gì backfill ghi (B3) ─────────────────────

  it("rollback nulls CHỈ những gì backfill ghi: mapped/unresolved mất 2 trường; declaredIds CHỈ mất locationSource (mã Batch 4 giữ)", async () => {
    const sellerId = await mkVerifiedSeller();
    created.users.push(sellerId);
    const legacyCat = await mkCategory("loa-thung-pa", "Loa thùng PA");

    const mappedId = await seedLegacyListing({ sellerId, categoryId: legacyCat, status: "approved", city: "Hà Nội" });
    const unresolvedId = await seedLegacyListing({ sellerId, categoryId: legacyCat, status: "approved", city: "Khác" });
    const declaredId = await seedBetaListing({ sellerId, cat: await mkBetaCatalog(), status: "approved", provinceLevelCode: "da-nang" });

    const report = await backfillListingLocation(true);
    expect(report.mapped).toBe(1);
    expect(report.unresolved).toBe(1);
    expect(report.declaredBackfilled).toBe(1);
    expect(report.declaredIds).toEqual([declaredId]);

    // Rollback documented (header script — B3), chạy qua typed ORM (cùng
    // predicate + payload như SQL):
    //   bước 1: locationSource IN ('legacy_mapped','unresolved') → null CẢ HAI
    //   trường (cả hai đều do backfill ghi trên các row đó);
    const step1 = await db.orm.public.Listing
      .where((l) => l.locationSource.in(["legacy_mapped", "unresolved"]))
      .updateAll({ provinceLevelCode: null, locationSource: null });
    expect(step1.length).toBe(2);
    //   bước 2: declaredIds → CHỈ locationSource (mã trên các row đó là data
    //   seller-declared của Batch 4 — KHÔNG bao giờ bị null, B3).
    const step2 = await db.orm.public.Listing
      .where((l) => l.id.in(report.declaredIds))
      .updateAll({ locationSource: null });
    expect(step2.length).toBe(1);

    const mapped = await db.orm.public.Listing.first({ id: mappedId });
    expect(mapped!.provinceLevelCode).toBeNull();
    expect(mapped!.locationSource).toBeNull();
    expect(mapped!.city).toBe("Hà Nội"); // legacy text vẫn nguyên vẹn byte
    const unresolved = await db.orm.public.Listing.first({ id: unresolvedId });
    expect(unresolved!.provinceLevelCode).toBeNull();
    expect(unresolved!.locationSource).toBeNull();
    const declared = await db.orm.public.Listing.first({ id: declaredId });
    expect(declared!.locationSource).toBeNull(); // CHỈ locationSource bị null
    expect(declared!.provinceLevelCode).toBe("da-nang"); // mã Batch 4 GIỮ NGUYÊN (B3)
  });

  // ─── 5. Action path — seller_declared CHỈ từ mã Batch 4 hợp lệ (S4/B2) ─────

  it("createListingAction (form beta, province hợp lệ) → locationSource = seller_declared", async () => {
    const sellerId = await mkVerifiedSeller();
    created.users.push(sellerId);
    const cat = await mkBetaCatalog();
    const storageKey = await mkUploadRow(sellerId);
    await login(sellerId);

    const url = await expectRedirect(() =>
      createListingAction({}, betaForm(cat, {
        images: [`/uploads/${storageKey}`],
        imageSlots: ["front"],
      })),
    );
    expect(url).toBe("/sell/my?created=1");

    const row = await db.orm.public.Listing.first({ sellerId });
    expect(row!.status).toBe("pending");
    expect(row!.provinceLevelCode).toBe("ho-chi-minh");
    expect(row!.locationSource).toBe("seller_declared");
    expect(row!.city).toBe("TP. Hồ Chí Minh"); // city derive từ province (Batch 4)
  });

  it("saveListingDraftAction (form beta) → draft mang seller_declared ngay từ lúc tạo", async () => {
    const sellerId = await mkVerifiedSeller();
    created.users.push(sellerId);
    const cat = await mkBetaCatalog();
    await login(sellerId);

    const url = await expectRedirect(() => saveListingDraftAction({}, betaForm(cat)));
    const draftId = parseDraftId(url);

    const row = await db.orm.public.Listing.first({ id: draftId });
    expect(row!.status).toBe("draft");
    expect(row!.provinceLevelCode).toBe("ho-chi-minh");
    expect(row!.locationSource).toBe("seller_declared");
  });

  it("updateListingAction (form beta, province hợp lệ) → seller_declared; đổi province là content change → pending", async () => {
    const sellerId = await mkVerifiedSeller();
    created.users.push(sellerId);
    const cat = await mkBetaCatalog();
    // row Batch-4-era: mã ho-chi-minh, source null (pre-Batch-5 shape)
    const listingId = await seedBetaListing({ sellerId, cat, status: "approved", provinceLevelCode: "ho-chi-minh" });
    await login(sellerId);

    const url = await expectRedirect(() =>
      updateListingAction({}, betaForm(cat, {
        listingId,
        provinceLevelCode: "ha-noi",
        images: ["/img/listings/it-pub.svg"], // ảnh seed ĐÃ GẮN — rule (2) pass
        imageSlots: ["front"],
      })),
    );
    expect(url).toBe("/sell/my?updated=1");

    const row = await db.orm.public.Listing.first({ id: listingId });
    expect(row!.status).toBe("pending"); // đổi province = content change → review lại (B3)
    expect(row!.provinceLevelCode).toBe("ha-noi");
    expect(row!.locationSource).toBe("seller_declared");
    expect(row!.city).toBe("Hà Nội");
  });

  it("submitListingAction trên draft Batch-4-era (mã đã ghi, source null) → seller_declared theo cấu trúc", async () => {
    const sellerId = await mkVerifiedSeller();
    created.users.push(sellerId);
    const cat = await mkBetaCatalog();
    // draft Batch-4-era: mã do form ghi lúc tạo draft, locationSource null
    const draftId = await seedBetaListing({ sellerId, cat, status: "draft", provinceLevelCode: "ho-chi-minh" });
    await login(sellerId);

    const url = await expectRedirect(() => submitListingAction(fd({ listingId: draftId })));
    expect(url).toBe("/sell/my?submitted=1");

    const row = await db.orm.public.Listing.first({ id: draftId });
    expect(row!.status).toBe("pending");
    expect(row!.locationSource).toBe("seller_declared");
    expect(row!.provinceLevelCode).toBe("ho-chi-minh"); // mã KHÔNG bị đụng
  });

  // ─── 6. Legacy edit — carry-forward + re-resolve (corrections item 3) ──────

  it("legacy edit KHÔNG province + city GIỮ NGUYÊN → carry forward mã + source, KHÔNG re-queue oan (corrections item 3)", async () => {
    const sellerId = await mkVerifiedSeller();
    created.users.push(sellerId);
    const legacyCat = await mkCategory("loa-thung-pa", "Loa thùng PA");
    // legacy listing ĐÃ backfill: mã ha-noi + legacy_mapped (dữ liệu backfill)
    const listingId = await seedLegacyListing({ sellerId, categoryId: legacyCat, status: "approved", city: "Hà Nội" });
    await backfillListingLocation(true);
    const backfilled = await db.orm.public.Listing.first({ id: listingId });
    expect(backfilled!.provinceLevelCode).toBe("ha-noi");
    expect(backfilled!.locationSource).toBe("legacy_mapped");

    await login(sellerId);
    // form legacy: KHÔNG trường province, city giữ nguyên, KHÔNG đổi content gì
    // — trước fix (corrections item 3) write null mã + contentChanged re-queue
    // oan vào pending; sau fix: carry forward, status GIỮ approved.
    const url = await expectRedirect(() => updateListingAction({}, legacyEditForm(listingId, legacyCat)));
    expect(url).toBe("/sell/my?updated=1");

    const row = await db.orm.public.Listing.first({ id: listingId });
    expect(row!.status).toBe("approved"); // KHÔNG re-queue oan
    expect(row!.provinceLevelCode).toBe("ha-noi"); // carry forward
    expect(row!.locationSource).toBe("legacy_mapped"); // carry forward
    expect(row!.city).toBe("Hà Nội"); // legacy free-text GIỮ NGUYÊN (B2)
  });

  it("legacy edit city ĐỔI (map được) → re-resolve FD-1: mã mới + legacy_mapped; city là content → pending", async () => {
    const sellerId = await mkVerifiedSeller();
    created.users.push(sellerId);
    const legacyCat = await mkCategory("loa-thung-pa", "Loa thùng PA");
    const listingId = await seedLegacyListing({ sellerId, categoryId: legacyCat, status: "approved", city: "Hà Nội" });
    await backfillListingLocation(true); // → ha-noi + legacy_mapped

    await login(sellerId);
    // "Đà Nẵng" là displayName ∈ CITIES (select của legacy form) VÀ là legacy
    // name của đơn vị da-nang → re-resolve map được.
    const url = await expectRedirect(() =>
      updateListingAction({}, legacyEditForm(listingId, legacyCat, { city: "Đà Nẵng" })),
    );
    expect(url).toBe("/sell/my?updated=1");

    const row = await db.orm.public.Listing.first({ id: listingId });
    expect(row!.status).toBe("pending"); // city là content công khai → qua lại review (LOW 1)
    expect(row!.city).toBe("Đà Nẵng"); // text mới lưu verbatim (B2)
    expect(row!.provinceLevelCode).toBe("da-nang"); // re-resolve FD-1
    expect(row!.locationSource).toBe("legacy_mapped");
  });

  it("legacy edit city ĐỔI (không map được) → mã null + source null (backfill sẽ lo) — KHÔNG đoán", async () => {
    const sellerId = await mkVerifiedSeller();
    created.users.push(sellerId);
    const legacyCat = await mkCategory("loa-thung-pa", "Loa thùng PA");
    const listingId = await seedLegacyListing({ sellerId, categoryId: legacyCat, status: "approved", city: "Hà Nội" });
    await backfillListingLocation(true); // → ha-noi + legacy_mapped

    await login(sellerId);
    const url = await expectRedirect(() =>
      updateListingAction({}, legacyEditForm(listingId, legacyCat, { city: "Khác" })),
    );
    expect(url).toBe("/sell/my?updated=1");

    const row = await db.orm.public.Listing.first({ id: listingId });
    expect(row!.status).toBe("pending");
    expect(row!.city).toBe("Khác");
    expect(row!.provinceLevelCode).toBeNull(); // KHÔNG đoán mã cho text không authoritative
    expect(row!.locationSource).toBeNull(); // backfill sẽ mark unresolved ở lần chạy sau
  });

  // ─── 7. Province filter — canonical only (spec §5.9) ──────────────────────

  it("province filter trả CHỈ row mang mã canonical khớp — unresolved invisible với bộ lọc tỉnh", async () => {
    const sellerId = await mkVerifiedSeller();
    created.users.push(sellerId);
    const cat = await mkBetaCatalog();
    const legacyCat = await mkCategory("loa-thung-pa", "Loa thùng PA");

    const haNoiId = await seedBetaListing({ sellerId, cat, status: "approved", provinceLevelCode: "ha-noi" });
    const daNangId = await seedBetaListing({ sellerId, cat, status: "approved", provinceLevelCode: "da-nang" });
    const unresolvedId = await seedLegacyListing({ sellerId, categoryId: legacyCat, status: "approved", city: "Khác" });
    await backfillListingLocation(true); // "Khác" → unresolved (mã null)

    const rows = await db.orm.public.Listing
      .where({ status: "approved", provinceLevelCode: "ha-noi" })
      .select("id")
      .all();
    expect(rows.map((r) => r.id)).toEqual([haNoiId]); // CHỈ row Hà Nội
    expect(rows.map((r) => r.id)).not.toContain(daNangId);
    expect(rows.map((r) => r.id)).not.toContain(unresolvedId); // unresolved invisible (không đoán)

    // không bộ lọc tỉnh → mọi row approved hiển thị (all locations)
    const all = await db.orm.public.Listing
      .where({ status: "approved", sellerId })
      .select("id")
      .all();
    expect(all.map((r) => r.id).sort()).toEqual([haNoiId, daNangId, unresolvedId].sort());
  });
});
