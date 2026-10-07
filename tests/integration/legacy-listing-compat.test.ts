/**
 * Legacy listing compatibility — integration tests (Batch 4 Task 8 — Review
 * Focus 5, spec §8/§8.3/§5.6.1/§5.6.4) — chạy trên scratch DB
 * (scripts/test-integration.sh: container riêng + migrate + dọn). KHÔNG chạy
 * trong `npm test`.
 *
 * Chứng minh hợp đồng legacy-listing compatibility (Legacy Migration Decisions)
 * against DB THẬT với action THẬT (updateListingAction / approveListingAction
 * — gate + audit + CAS thật toàn bộ; unit tests đã pin logic với db mock):
 *
 *  1. Legacy listing (đúng shape src/prisma/seed.ts: category `loa-thung-pa`,
 *     ảnh seed `/img/listings/…`, KHÔNG cột structured nào, city free-text
 *     "Hà Nội") edit dưới regime legacy (KHÔNG model, KHÔNG structured fields)
 *     → content change → pending; ảnh seed giữ nguyên pass ownership rule (2).
 *  2. Legacy re-approval: approveListingAction duyệt lại tin legacy
 *     (category grandfathered — allowlist pass; legacy schema pass).
 *  3. Đổi category legacy → legacy slug KHÁC → CATEGORY_NOT_PUBLICATION_ALLOWED
 *     (allowlist invariant), row GIỮ NGUYÊN.
 *  4. Đổi category legacy → beta slug → full beta validation (BRAND_REQUIRED —
 *     code deterministic ĐẦU TIÊN của beta schema), row GIỮ NGUYÊN.
 *  5. Ảnh `/uploads/<uuid>.jpg` pre-Batch-4 ĐÃ GẮN → edit giữ nguyên pass (B1).
 *  6. Ảnh `/uploads/<uuid>.jpg` pre-Batch-4 KHÔNG gắn (detached) re-attach →
 *     IMAGE_NOT_OWNED (accepted compat behavior — seller re-upload, re-encode).
 *  7. Ảnh `https://…` ĐÃ GẮN (pre-Batch-4) → approveListingAction chặn + audit
 *     `listing.approve_blocked` reason `listing_content_invalid` +
 *     `issues=IMAGE_URL_INVALID` (B1 — scheme URL không bao giờ tin, kể cả
 *     attached, kể cả tại approve).
 *  8. Legacy REJECTED + content edit → GIỮ rejected (A10 interim — KHÔNG
 *     resubmit vào pending), form message hướng dẫn tạo tin mới.
 *  9. Legacy listing đọc lại NULL mọi cột structured (§8.3 — "not captured",
 *     render absent), ảnh legacy KHÔNG slot.
 *
 * CAS race submit/approve (CONCURRENT_CHANGE / listing_changed_during_review)
 * pinned bởi tests/integration/listing-submit-approve-race.test.ts (row-lock
 * barrier) — KHÔNG duplicate ở đây.
 *
 * Mock recipe (Batch 3 Global Constraints + identity-collision precedent):
 * `server-only`/`next/cache`/`next/navigation`/`next/headers` mock với
 * vi.hoisted cookie state; AUTH_SECRET + NODE_ENV stub MỌI beforeEach (HKDF
 * ip-hash derive từ AUTH_SECRET — KHÔNG phụ thuộc .env của worktree).
 * Session/rbac/policy/audit/listing actions là THẬT toàn bộ — đăng nhập qua
 * createSession thật trên DB scratch (precedent listing-submit-approve-race/
 * seller-verification/suspension-enforcement — kế hoạch Task 8 phác mock
 * @/src/lib/auth + @/src/lib/rbac; code hợp nhất dùng session THẬT mạnh hơn,
 * ghi nhận deviation trong report).
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
import { updateListingAction } from "../../src/lib/actions/listings";
import { approveListingAction } from "../../src/lib/actions/admin";

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const PASSWORD_HASH = bcrypt.hashSync("integration-password-123", 10);

let seq = 0;
const uid = () => `b4-leg-${Date.now()}-${seq++}`;

/** Đếm riêng cho URL ảnh /uploads/ pre-Batch-4 (hex thường v4 — offset file). */
let upSeq = 0x1000;
/** URL `/uploads/<uuid>.jpg` pre-Batch-4: khớp LISTING_IMAGE_URL_PATTERN,
 *  KHÔNG có ListingImageUpload row (trước Batch 4 không ghi ownership). */
const legacyUploadUrl = (): string => {
  upSeq += 1;
  const hex = (n: number, w: number) => n.toString(16).padStart(w, "0");
  return `/uploads/${hex(upSeq, 8)}-0000-4000-8000-${hex(upSeq, 12)}.jpg`;
};

async function mkUser(role: "buyer" | "seller" | "admin", over?: { adminRole?: string }): Promise<string> {
  const u = await db.orm.public.User.create({
    email: `${uid()}@integration.test`,
    passwordHash: PASSWORD_HASH,
    name: `B4 Legacy ${role}`,
    role,
    ...(over?.adminRole ? { adminRole: over.adminRole as "operations_admin" } : {}),
  });
  return u.id;
}

/** Seller ĐỦ 8 yêu cầu policy v1 (seed trực tiếp — như listing-submit-approve-race.test.ts). */
async function mkVerifiedSeller(): Promise<string> {
  const now = new Date().toISOString();
  const u = await db.orm.public.User.create({
    email: `${uid()}@integration.test`,
    passwordHash: PASSWORD_HASH,
    name: "B4 Legacy Seller",
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

/** Admin operations (listing.moderate — KHÔNG cần step-up). */
async function mkAdmin(): Promise<string> {
  return mkUser("admin", { adminRole: "operations_admin" });
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

async function mkBrand(): Promise<string> {
  const b = await db.orm.public.Brand.create({ name: `JBL ${uid()}`, slug: `jbl-${uid()}` });
  created.brands.push(b.id);
  return b.id;
}

/**
 * Listing legacy ĐÚNG shape src/prisma/seed.ts: category legacy, ảnh seed
 * `/img/listings/…` (hoặc ảnh caller đưa), KHÔNG cột structured nào, city
 * free-text "Hà Nội", brandId có (seed set), KHÔNG productModelId.
 */
async function seedLegacyListing(input: {
  sellerId: string;
  categoryId: string;
  brandId?: string | null;
  status: "approved" | "pending" | "rejected";
  images?: string[];
}): Promise<string> {
  const l = await db.orm.public.Listing.create({
    sellerId: input.sellerId,
    categoryId: input.categoryId,
    brandId: input.brandId ?? null,
    title: "Loa thùng PA JBL Eon715 sự kiện",
    slug: `loa-thung-pa-jbl-eon715-${uid()}`,
    description: "Loa thùng PA cũ còn tốt, bass mạnh, dùng sự kiện ổn.",
    condition: "good",
    price: 11_200_000,
    negotiable: true,
    acceptExchange: false,
    status: input.status,
    rejectionReason: input.status === "rejected" ? "Nội dung không rõ ràng, thiếu thông tin" : null,
    city: "Hà Nội",
    viewCount: 20,
  });
  const images = input.images ?? ["/img/listings/it-a.svg", "/img/listings/it-b.svg"];
  for (let i = 0; i < images.length; i++) {
    await db.orm.public.ListingImage.create({
      listingId: l.id,
      url: images[i]!,
      sortOrder: i,
      // ảnh legacy KHÔNG slot (checklistSlot là cột Batch 4 — NULL = legacy)
    });
  }
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

/** Form edit legacy-shaped: KHÔNG model, KHÔNG structured fields — city free-text. */
const legacyEditForm = (listingId: string, categoryId: string, over?: {
  categoryId?: string;
  title?: string;
  images?: string[];
}): FormData =>
  fd({
    listingId,
    title: over?.title ?? "Loa thùng PA JBL Eon715 sự kiện cập nhật",
    description: "Loa thùng PA cũ còn tốt, bass mạnh, dùng sự kiện ổn.",
    categoryId: over?.categoryId ?? categoryId,
    condition: "good",
    price: "11500000",
    negotiable: "on",
    city: "Hà Nội",
    brandId: "",
    productModelId: "",
    images: over?.images ?? ["/img/listings/it-a.svg", "/img/listings/it-b.svg"],
  });

/** Đăng nhập user trên cookie store mock — session thật trong DB scratch. */
const login = async (userId: string, opts?: { isAdmin?: boolean }): Promise<void> => {
  cookieState.store.clear();
  await createSession(userId, opts);
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
  // (cascade ảnh/cart) → ProductModel (cascade PriceHistory) → Brand → Category
  // → SellerVerification (userId Restrict — PHẢI xoá trước User) → User
  // (cascade session/policy-acceptance/membership/notification/AdminAuditLog).
  //
  // Listing xoá THEO SELLER (mọi user mình tạo) — KHÔNG chỉ theo id list:
  // listing do ACTION tạo không có id để track; Listing.productModelId/brandId/
  // categoryId FK Restrict nên listing treo = xoá catalog bị chặn (23503) →
  // afterEach throw → residue leak sang file sau (glob order của vitest theo
  // filesystem, KHÔNG alphabet).
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

// ─── 1. Legacy edit dưới regime legacy (Review Focus 5) ───────────────────────

d("legacy listing compatibility (Batch 4 Task 8 — spec §8/§8.3)", () => {
  it("legacy edit (không model, không structured fields) → pending; ảnh seed giữ nguyên pass rule (2); structured GIỮ NULL", async () => {
    const sellerId = await mkVerifiedSeller();
    created.users.push(sellerId);
    const legacyCat = await mkCategory("loa-thung-pa", "Loa thùng PA");
    const brandId = await mkBrand();
    const listingId = await seedLegacyListing({ sellerId, categoryId: legacyCat, brandId, status: "approved" });
    await login(sellerId);

    const url = await expectRedirect(() =>
      updateListingAction({}, legacyEditForm(listingId, legacyCat, { title: "Loa thùng PA JBL Eon715 sự kiện cập nhật" })),
    );
    expect(url).toBe("/sell/my?updated=1");

    const row = await db.orm.public.Listing.first({ id: listingId });
    expect(row!.status).toBe("pending"); // content change → pending (B3)
    expect(row!.title).toContain("cập nhật");
    // structured fields GIỮ NULL — regime legacy KHÔNG bắt buộc (§8.3)
    expect(row!.inventoryContext).toBeNull();
    expect(row!.provinceLevelCode).toBeNull();
    expect(row!.city).toBe("Hà Nội"); // legacy free-text GIỮ NGUYÊN (không rewrite)
    // ảnh seed /img/… ĐÃ GẮN giữ nguyên — ownership rule (2) pass
    const images = await db.orm.public.ListingImage
      .where({ listingId })
      .orderBy((i) => i.sortOrder.asc())
      .all();
    expect(images.map((i) => i.url)).toEqual(["/img/listings/it-a.svg", "/img/listings/it-b.svg"]);
  });

  // ─── 2. Legacy re-approval (grandfathered category) ────────────────────────

  it("legacy re-approval: approveListingAction duyệt lại tin legacy — KHÔNG legacy breakage", async () => {
    const sellerId = await mkVerifiedSeller();
    const adminId = await mkAdmin();
    created.users.push(sellerId, adminId);
    const legacyCat = await mkCategory("loa-thung-pa", "Loa thùng PA");
    const brandId = await mkBrand();
    const listingId = await seedLegacyListing({ sellerId, categoryId: legacyCat, brandId, status: "pending" });

    await login(adminId, { isAdmin: true });
    await approveListingAction(fd({ listingId }));

    const row = await db.orm.public.Listing.first({ id: listingId });
    expect(row!.status).toBe("approved");
    expect(row!.rejectionReason).toBeNull();
    const evt = await db.orm.public.AuditEvent
      .where({ action: "listing.approved", resourceId: listingId })
      .all();
    expect(evt).toHaveLength(1);
    expect(evt[0]!.actorId).toBe(adminId);
  });

  // ─── 3. Category change legacy → legacy slug khác ─────────────────────────

  it("đổi category legacy → legacy slug KHÁC → CATEGORY_NOT_PUBLICATION_ALLOWED, row GIỮ NGUYÊN", async () => {
    const sellerId = await mkVerifiedSeller();
    created.users.push(sellerId);
    const legacyCat = await mkCategory("loa-thung-pa", "Loa thùng PA");
    const otherCat = await mkCategory(`loa-karaoke-${uid()}`, "Loa karaoke");
    const brandId = await mkBrand();
    const listingId = await seedLegacyListing({ sellerId, categoryId: legacyCat, brandId, status: "approved" });
    await login(sellerId);

    const state = await updateListingAction({}, legacyEditForm(listingId, legacyCat, { categoryId: otherCat }));
    expect(state.error).toContain("CATEGORY_NOT_PUBLICATION_ALLOWED");

    const row = await db.orm.public.Listing.first({ id: listingId });
    expect(row!.status).toBe("approved"); // KHÔNG transition
    expect(row!.categoryId).toBe(legacyCat); // KHÔNG đổi category
  });

  // ─── 4. Category change legacy → beta slug (INTO allowlist) ────────────────

  it("đổi category legacy → beta slug → full beta validation (BRAND_REQUIRED), row GIỮ NGUYÊN", async () => {
    const sellerId = await mkVerifiedSeller();
    created.users.push(sellerId);
    const legacyCat = await mkCategory("loa-thung-pa", "Loa thùng PA");
    const betaCat = await mkCategory("portable_bluetooth_speaker", "Loa Bluetooth di động");
    const brandId = await mkBrand();
    const listingId = await seedLegacyListing({ sellerId, categoryId: legacyCat, brandId, status: "approved" });
    await login(sellerId);

    const state = await updateListingAction({}, legacyEditForm(listingId, legacyCat, { categoryId: betaCat }));
    // allowlist pass (đổi INTO allowlist được phép) → beta schema chạy — code
    // ĐẦU TIÊN sai theo thứ tự deterministic của betaListingSubmissionSchema
    // (brand blank trước model blank) → BRAND_REQUIRED.
    expect(state.error).toContain("BRAND_REQUIRED");
    expect(state.error).not.toContain("CATEGORY_NOT_PUBLICATION_ALLOWED");

    const row = await db.orm.public.Listing.first({ id: listingId });
    expect(row!.status).toBe("approved");
    expect(row!.categoryId).toBe(legacyCat);
  });

  // ─── 5. Ảnh /uploads/ pre-Batch-4 ĐÃ GẮN → edit giữ nguyên pass (B1) ────────

  it("ảnh /uploads/<uuid>.jpg pre-Batch-4 ĐÃ GẮN → edit giữ nguyên pass (B1 compat)", async () => {
    const sellerId = await mkVerifiedSeller();
    created.users.push(sellerId);
    const legacyCat = await mkCategory("loa-thung-pa", "Loa thùng PA");
    const brandId = await mkBrand();
    const attachedUrl = legacyUploadUrl(); // pre-Batch-4: KHÔNG ListingImageUpload row
    const listingId = await seedLegacyListing({
      sellerId, categoryId: legacyCat, brandId, status: "approved", images: [attachedUrl],
    });
    await login(sellerId);

    const url = await expectRedirect(() =>
      updateListingAction({}, legacyEditForm(listingId, legacyCat, { images: [attachedUrl] })),
    );
    expect(url).toBe("/sell/my?updated=1");

    const row = await db.orm.public.Listing.first({ id: listingId });
    expect(row!.status).toBe("pending"); // content change (title) → pending
    const images = await db.orm.public.ListingImage.where({ listingId }).all();
    expect(images.map((i) => i.url)).toEqual([attachedUrl]); // giữ nguyên — rule (2)
  });

  // ─── 6. Ảnh /uploads/ pre-Batch-4 KHÔNG gắn (detached) → IMAGE_NOT_OWNED ────

  it("ảnh /uploads/<uuid>.jpg pre-Batch-4 KHÔNG gắn (detached) re-attach → IMAGE_NOT_OWNED, row GIỮ NGUYÊN", async () => {
    const sellerId = await mkVerifiedSeller();
    created.users.push(sellerId);
    const legacyCat = await mkCategory("loa-thung-pa", "Loa thùng PA");
    const brandId = await mkBrand();
    const listingId = await seedLegacyListing({ sellerId, categoryId: legacyCat, brandId, status: "approved" });
    const detachedUrl = legacyUploadUrl(); // KHÔNG gắn vào listing nào, KHÔNG upload row
    await login(sellerId);

    const state = await updateListingAction(
      {},
      legacyEditForm(listingId, legacyCat, {
        images: ["/img/listings/it-a.svg", "/img/listings/it-b.svg", detachedUrl],
      }),
    );
    expect(state.error).toContain("IMAGE_NOT_OWNED");

    const row = await db.orm.public.Listing.first({ id: listingId });
    expect(row!.status).toBe("approved"); // KHÔNG transition
    const images = await db.orm.public.ListingImage.where({ listingId }).all();
    expect(images.map((i) => i.url)).toEqual(["/img/listings/it-a.svg", "/img/listings/it-b.svg"]);
  });

  // ─── 7. Ảnh https:// ĐÃ GẮN → chặn tại approve (B1) ────────────────────────

  it("ảnh https:// ĐÃ GẮN (pre-Batch-4) → approveListingAction chặn + audit listing_content_invalid issues=IMAGE_URL_INVALID", async () => {
    const sellerId = await mkVerifiedSeller();
    const adminId = await mkAdmin();
    created.users.push(sellerId, adminId);
    const legacyCat = await mkCategory("loa-thung-pa", "Loa thùng PA");
    const brandId = await mkBrand();
    const listingId = await seedLegacyListing({
      sellerId, categoryId: legacyCat, brandId, status: "pending",
      images: ["https://cdn.example.com/loa.jpg"], // pre-Batch-4: URL ngoài ĐÃ gắn
    });

    await login(adminId, { isAdmin: true });
    await approveListingAction(fd({ listingId })); // silent return — KHÔNG approve

    const row = await db.orm.public.Listing.first({ id: listingId });
    expect(row!.status).toBe("pending"); // KHÔNG approve
    const blocked = await db.orm.public.AuditEvent
      .where({ action: "listing.approve_blocked", resourceId: listingId })
      .all();
    expect(blocked).toHaveLength(1);
    // seller ĐỦ yêu cầu → reason là CONTENT (không phải publication_requirements_unmet)
    expect(blocked[0]!.reason).toBe("listing_content_invalid");
    expect(blocked[0]!.detail).toBe("issues=IMAGE_URL_INVALID");
  });

  // ─── 8. Legacy rejected GIỮ rejected trên content edit (A10 interim) ───────

  it("legacy REJECTED + content edit → GIỮ rejected (A10 interim), form message hướng dẫn tạo tin mới", async () => {
    const sellerId = await mkVerifiedSeller();
    created.users.push(sellerId);
    const legacyCat = await mkCategory("loa-thung-pa", "Loa thùng PA");
    const brandId = await mkBrand();
    const listingId = await seedLegacyListing({ sellerId, categoryId: legacyCat, brandId, status: "rejected" });
    await login(sellerId);

    const state = await updateListingAction(
      {},
      legacyEditForm(listingId, legacyCat, { title: "Loa thùng PA JBL Eon715 sự kiện sửa lại" }),
    );
    expect(state.error).toContain("Tin bị từ chối trong danh mục cũ");

    const row = await db.orm.public.Listing.first({ id: listingId });
    expect(row!.status).toBe("rejected"); // KHÔNG resubmit vào pending (fail-closed A10)
  });

  // ─── 9. Legacy listing đọc lại NULL structured fields (§8.3) ───────────────

  it("legacy listing đọc lại NULL mọi cột structured — không lỗi, render absent (§8.3)", async () => {
    const sellerId = await mkVerifiedSeller();
    created.users.push(sellerId);
    const legacyCat = await mkCategory("loa-thung-pa", "Loa thùng PA");
    const brandId = await mkBrand();
    const listingId = await seedLegacyListing({ sellerId, categoryId: legacyCat, brandId, status: "approved" });

    const row = await db.orm.public.Listing.first({ id: listingId });
    expect(row!.inventoryContext).toBeNull();
    expect(row!.includedAccessories).toBeNull();
    expect(row!.knownDefects).toBeNull();
    expect(row!.repairHistory).toBeNull();
    expect(row!.fulfillmentMethods).toBeNull();
    expect(row!.provinceLevelCode).toBeNull();
    expect(row!.communeLevelCode).toBeNull();
    expect(row!.locationDisplayName).toBeNull();
    // legacy fields nguyên vẹn (additive-only — cột cũ KHÔNG bị đụng)
    expect(row!.title).toBe("Loa thùng PA JBL Eon715 sự kiện");
    expect(row!.city).toBe("Hà Nội");
    expect(row!.condition).toBe("good");
    expect(row!.price).toBe(11_200_000);
    const img = await db.orm.public.ListingImage.where({ listingId }).first();
    expect(img!.checklistSlot).toBeNull(); // ảnh legacy KHÔNG slot
  });
});
