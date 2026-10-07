/**
 * Batch 4 holistic (round 2) — CONFIRMED findings end-to-end trên scratch DB
 * (scripts/test-integration.sh: container riêng + migrate + dọn). KHÔNG chạy
 * trong `npm test`.
 *
 *  1. [LOW] Hidden pre-Batch-4 republished without review — approvedContentAt
 *     review backfill: row hidden seed trực tiếp (KHÔNG qua approve — mô phỏng
 *     dữ liệu Batch ≤3 edit-while-hidden / hidden từ pending-rejected-draft)
 *     → toggle hiện lại → PENDING + audit listing.submitted (policyVersion),
 *     KHÔNG thẳng approved. Admin approve → approved + approvedContentAt SET
 *     → hide/show lại → approved (fast path).
 *  2. [LOW] Batch 4 gate blocks legacy rows (>8 ảnh / desc >4000) — grandfather
 *     stored bounds trên transition KHÔNG đổi content: hidden legacy 9 ảnh +
 *     4.001 ký tự → hiện lại vào pending (KHÔNG IMAGE_TOO_MANY silent-block);
 *     admin approve legacy pending 4.001 ký tự → approved (KHÔNG kẹt mãi);
 *     edit qua updateListingAction vẫn IMAGE_TOO_MANY (formData KHÔNG grandfather).
 *  3. [LOW] Seller hard-delete FK violation qua ExchangeOffer.myListingId —
 *     pre-check: approved + offer → ẩn; hidden/pending + offer → redirect
 *     LISTING_HAS_ORDERS (typed), row SỐNG SÓT (KHÔNG 23503 crash).
 *  4. [MEDIUM] Wishlist gate — add chỉ approved; remove mọi status (dọn stale).
 *
 * Mock recipe như tests/integration/legacy-listing-compat.test.ts: cookie store
 * điều khiển được (next/headers), session THẬT trên DB scratch, action THẬT
 * toàn bộ (gate + audit + CAS thật).
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
import {
  toggleListingVisibilityAction,
  deleteListingAction,
  updateListingAction,
} from "../../src/lib/actions/listings";
import { approveListingAction } from "../../src/lib/actions/admin";
import { toggleWishlistAction } from "../../src/lib/actions/wishlist";

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const PASSWORD_HASH = bcrypt.hashSync("integration-password-123", 10);

let seq = 0;
const uid = () => `b4h2-${Date.now()}-${seq++}`;

async function mkUser(role: "buyer" | "seller" | "admin", over?: { adminRole?: string }): Promise<string> {
  const u = await db.orm.public.User.create({
    email: `${uid()}@integration.test`,
    passwordHash: PASSWORD_HASH,
    name: `B4H2 ${role}`,
    role,
    ...(over?.adminRole ? { adminRole: over.adminRole as "operations_admin" } : {}),
  });
  return u.id;
}

/** Seller ĐỦ 8 yêu cầu policy v1 (seed trực tiếp — như legacy-listing-compat). */
async function mkVerifiedSeller(): Promise<string> {
  const now = new Date().toISOString();
  const u = await db.orm.public.User.create({
    email: `${uid()}@integration.test`,
    passwordHash: PASSWORD_HASH,
    name: "B4H2 Seller",
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

/**
 * Listing legacy ĐÚNG shape pre-Batch-4: category legacy, ảnh seed /img/…,
 * KHÔNG structured field, city free-text — seed TRỰC TIẾP (KHÔNG qua action)
 * để mô phỏng row Batch ≤3 (approvedContentAt NULL mặc định).
 */
async function seedLegacyListing(input: {
  sellerId: string;
  categoryId: string;
  status: "approved" | "pending" | "hidden" | "rejected";
  images?: string[];
  description?: string;
}): Promise<string> {
  const l = await db.orm.public.Listing.create({
    sellerId: input.sellerId,
    categoryId: input.categoryId,
    brandId: null,
    title: "Loa thùng PA JBL Eon715 sự kiện",
    slug: `loa-thung-pa-jbl-eon715-${uid()}`,
    description: input.description ?? "Loa thùng PA cũ còn tốt, bass mạnh, dùng sự kiện ổn.",
    condition: "good",
    price: 11_200_000,
    negotiable: true,
    acceptExchange: false,
    status: input.status,
    rejectionReason: null,
    city: "Hà Nội",
    viewCount: 0,
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
  title?: string;
  images?: string[];
  description?: string;
}): FormData =>
  fd({
    listingId,
    title: over?.title ?? "Loa thùng PA JBL Eon715 sự kiện cập nhật",
    description: over?.description ?? "Loa thùng PA cũ còn tốt, bass mạnh, dùng sự kiện ổn.",
    categoryId,
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
  listings: [] as string[],
  offers: [] as string[],
  wishlist: [] as string[],
};

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  // HKDF (src/lib/hkdf.ts) derive từ AUTH_SECRET — KHÔNG phụ thuộc .env của worktree.
  vi.stubEnv("AUTH_SECRET", "integration-test-auth-secret-0123456789abcdef");
  resetRateLimits();
  cookieState.store.clear();
});

afterEach(async () => {
  // ExchangeOffer TRƯỚC Listing (myListingId/listingId FK Restrict — xoá listing
  // trước sẽ 23503). WishlistItem cascade theo Listing nhưng xoá sạch theo id
  // mình tạo cho chắc. AuditEvent (SetNull) → Listing → catalog → verification → User.
  for (const id of created.offers) {
    await db.orm.public.ExchangeOffer.where({ id }).delete();
  }
  for (const id of created.wishlist) {
    await db.orm.public.WishlistItem.where({ id }).delete();
  }
  for (const id of created.users) {
    await db.orm.public.AuditEvent.where({ actorId: id }).deleteAll();
    await db.orm.public.AuditEvent.where({ subjectId: id }).deleteAll();
  }
  for (const id of created.users) {
    await db.orm.public.Listing.where({ sellerId: id }).deleteAll();
  }
  for (const id of created.listings) {
    await db.orm.public.Listing.where({ id }).deleteAll();
  }
  for (const id of created.users) {
    await db.orm.public.SellerVerification.where({ userId: id }).deleteAll();
  }
  for (const id of created.users) {
    await db.orm.public.User.where({ id }).deleteAll();
  }
  for (const id of created.categories) {
    await db.orm.public.Category.where({ id }).deleteAll();
  }
  created.users.length = 0;
  created.categories.length = 0;
  created.listings.length = 0;
  created.offers.length = 0;
  created.wishlist.length = 0;
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.close();
});

// ─── 1. Review backfill — approvedContentAt (b4-holistic-2 LOW) ──────────────

d("toggle hidden→show — review backfill approvedContentAt (b4-holistic-2 LOW)", () => {
  it("hidden legacy (approvedContentAt NULL — row Batch ≤3) → hiện lại → PENDING + audit listing.submitted, KHÔNG thẳng approved", async () => {
    const sellerId = await mkVerifiedSeller();
    created.users.push(sellerId);
    const legacyCat = await mkCategory("loa-thung-pa", "Loa thùng PA");
    const listingId = await seedLegacyListing({ sellerId, categoryId: legacyCat, status: "hidden" });
    await login(sellerId);

    const url = await expectRedirect(() => toggleListingVisibilityAction(fd({ listingId })));

    // seller thấy "đã gửi duyệt" — KHÔNG im lặng, KHÔNG thẳng approved
    expect(url).toBe("/sell/my?submitted=1");
    const row = await db.orm.public.Listing.first({ id: listingId });
    expect(row!.status).toBe("pending"); // vào review — admin duyệt lại một lần
    expect(row!.approvedContentAt).toBeNull(); // chưa ai duyệt content này
    const evt = await db.orm.public.AuditEvent
      .where({ action: "listing.submitted", resourceId: listingId })
      .all();
    expect(evt).toHaveLength(1);
    expect(evt[0]!.policyVersion).toBeTruthy(); // §4.6 — cùng event mọi đường vào review
    expect(String(evt[0]!.detail)).toContain("via=show_again"); // typed value
  });

  it("admin approve → approved + approvedContentAt SET; hide → hiện lại → approved (fast path — content đã duyệt)", async () => {
    const sellerId = await mkVerifiedSeller();
    const adminId = await mkAdmin();
    created.users.push(sellerId, adminId);
    const legacyCat = await mkCategory("loa-thung-pa", "Loa thùng PA");
    const listingId = await seedLegacyListing({ sellerId, categoryId: legacyCat, status: "pending" });

    // admin approve — version (updatedAt) như review card post
    await login(adminId, { isAdmin: true });
    const cardRow = await db.orm.public.Listing.first({ id: listingId });
    await approveListingAction(fd({ listingId, version: cardRow!.updatedAt }));

    const approved = await db.orm.public.Listing.first({ id: listingId });
    expect(approved!.status).toBe("approved");
    expect(approved!.approvedContentAt).toBeTruthy(); // review version của content

    // hide → hiện lại: fast path approved (KHÔNG vào review lặp)
    await login(sellerId);
    await toggleListingVisibilityAction(fd({ listingId }));
    expect((await db.orm.public.Listing.first({ id: listingId }))!.status).toBe("hidden");
    await toggleListingVisibilityAction(fd({ listingId }));
    const reshowed = await db.orm.public.Listing.first({ id: listingId });
    expect(reshowed!.status).toBe("approved"); // fast path
    // approvedContentAt KHÔNG bị đụng bởi hide/show
    expect(reshowed!.approvedContentAt).toBe(approved!.approvedContentAt);
    // KHÔNG audit submit nào cho vòng hide/show không đổi content
    const submits = await db.orm.public.AuditEvent
      .where({ action: "listing.submitted", resourceId: listingId })
      .all();
    expect(submits).toHaveLength(0);
  });
});

// ─── 2. Grandfather stored bounds (b4-holistic-2 LOW) ─────────────────────────

d("grandfather stored bounds — legacy row >8 ảnh / desc >4000 (b4-holistic-2 LOW)", () => {
  /** 9 ảnh seed /img/… (rule 2 attached) + description 4.001 ký tự — hợp lệ dưới luật cũ. */
  const LEGACY_IMAGES = Array.from({ length: 9 }, (_, i) => `/img/listings/it-${i}.svg`);
  const LONG_DESC = "L".repeat(4_001);

  it("hidden legacy 9 ảnh + desc 4.001 ký tự (approvedContentAt NULL) → hiện lại → PENDING (gate PASS nhờ grandfather — KHÔNG IMAGE_TOO_MANY)", async () => {
    const sellerId = await mkVerifiedSeller();
    created.users.push(sellerId);
    const legacyCat = await mkCategory("loa-thung-pa", "Loa thùng PA");
    const listingId = await seedLegacyListing({
      sellerId, categoryId: legacyCat, status: "hidden",
      images: LEGACY_IMAGES, description: LONG_DESC,
    });
    await login(sellerId);

    const url = await expectRedirect(() => toggleListingVisibilityAction(fd({ listingId })));

    expect(url).toBe("/sell/my?submitted=1");
    const row = await db.orm.public.Listing.first({ id: listingId });
    // Trước fix: gate throw IMAGE_TOO_MANY/DESCRIPTION_INVALID → silent return —
    // tin kẹt hidden mãi mãi KHÔNG lý do. Giờ: grandfather cho qua → vào review.
    expect(row!.status).toBe("pending");
    expect(row!.description).toBe(LONG_DESC); // content GIỮ NGUYÊN — không bị đụng
  });

  it("admin approve legacy PENDING 9 ảnh + desc 4.001 ký tự → APPROVED (grandfather tại approve — row KHÔNG kẹt approve_blocked mãi mãi)", async () => {
    const sellerId = await mkVerifiedSeller();
    const adminId = await mkAdmin();
    created.users.push(sellerId, adminId);
    const legacyCat = await mkCategory("loa-thung-pa", "Loa thùng PA");
    const listingId = await seedLegacyListing({
      sellerId, categoryId: legacyCat, status: "pending",
      images: LEGACY_IMAGES, description: LONG_DESC,
    });

    await login(adminId, { isAdmin: true });
    const cardRow = await db.orm.public.Listing.first({ id: listingId });
    await approveListingAction(fd({ listingId, version: cardRow!.updatedAt }));

    const row = await db.orm.public.Listing.first({ id: listingId });
    expect(row!.status).toBe("approved"); // bounds không còn chặn duyệt legacy
    expect(row!.approvedContentAt).toBeTruthy();
    const blocked = await db.orm.public.AuditEvent
      .where({ action: "listing.approve_blocked", resourceId: listingId })
      .all();
    expect(blocked).toHaveLength(0);
  });

  it("edit qua updateListingAction (formData) 9 ảnh → IMAGE_TOO_MANY — KHÔNG grandfather (edit buộc vào compliance)", async () => {
    const sellerId = await mkVerifiedSeller();
    created.users.push(sellerId);
    const legacyCat = await mkCategory("loa-thung-pa", "Loa thùng PA");
    const listingId = await seedLegacyListing({
      sellerId, categoryId: legacyCat, status: "approved",
      images: LEGACY_IMAGES, description: LONG_DESC,
    });
    await login(sellerId);

    // form giữ NGUYÊN 9 ảnh (không thêm) nhưng đổi title — content-change →
    // gate chạy schema legacy KHÔNG grandfather → IMAGE_TOO_MANY (formData
    // KHÔNG bao giờ grandfather — mọi edit buộc seller vào compliance).
    const state = await updateListingAction(
      {},
      legacyEditForm(listingId, legacyCat, {
        title: "Loa thùng PA JBL Eon715 sự kiện sửa lại",
        images: LEGACY_IMAGES,
        description: "Loa thùng PA cũ còn tốt, bass mạnh, dùng sự kiện ổn.", // desc HỢP LỆ — isolate image bound
      }),
    );

    expect(String(state.error)).toContain("IMAGE_TOO_MANY");
    const row = await db.orm.public.Listing.first({ id: listingId });
    expect(row!.status).toBe("approved"); // KHÔNG transition — edit phải vào compliance
  });
});

// ─── 3. deleteListingAction vs ExchangeOffer.myListingId (b4-holistic-2 LOW) ──

d("deleteListingAction pre-check ExchangeOffer.myListingId (b4-holistic-2 LOW)", () => {
  /**
   * Offer cũ (finance off — chỉ dữ liệu tồn tại pre-Batch-4) tham chiếu listing
   * của seller này: ExchangeOffer.listingId = tin mục tiêu (của seller KHÁC),
   * buyerId = seller này (buyer trao đổi), myListingId = tin CỦA seller này
   * đưa ra đổi — chính là tin họ bấm Xóa trên /sell/my.
   */
  const seedOffer = async (myListingId: string, buyerId: string): Promise<string> => {
    const targetSellerId = await mkVerifiedSeller();
    created.users.push(targetSellerId);
    const legacyCat = await mkCategory("loa-thung-pa", "Loa thùng PA");
    const target = await db.orm.public.Listing.create({
      sellerId: targetSellerId,
      categoryId: legacyCat,
      title: "Tin mục tiêu trao đổi",
      slug: `trao-doi-muc-tieu-${uid()}`,
      description: "Tin mục tiêu của offer trao đổi",
      condition: "good",
      price: 5_000_000,
      status: "approved",
      city: "Hà Nội",
    });
    created.listings.push(target.id);
    const offer = await db.orm.public.ExchangeOffer.create({
      listingId: target.id, // tin người bán — mục tiêu trao đổi
      buyerId, // buyer = seller của myListingId (người đưa tin mình ra đổi)
      myListingId, // tin CỦA buyer — seller của nó bấm Xóa
      myItemDescription: null,
      cashTopup: 0,
      status: "proposed",
    });
    created.offers.push(offer.id);
    return offer.id;
  };

  it("approved + offer → CHỈ ẨN (hidden), KHÔNG hard-delete — offer nguyên vẹn", async () => {
    const sellerId = await mkVerifiedSeller();
    const buyerId = await mkUser("buyer");
    created.users.push(sellerId, buyerId);
    const legacyCat = await mkCategory("loa-thung-pa", "Loa thùng PA");
    const listingId = await seedLegacyListing({ sellerId, categoryId: legacyCat, status: "approved" });
    await seedOffer(listingId, buyerId);
    await login(sellerId);

    await deleteListingAction(fd({ listingId }));

    const row = await db.orm.public.Listing.first({ id: listingId });
    expect(row!.status).toBe("hidden"); // ẩn như đường OrderItem — KHÔNG 23503 crash
    expect(await db.orm.public.ExchangeOffer.where({ myListingId: listingId }).first()).not.toBeNull();
  });

  it("hidden + offer → redirect LISTING_HAS_ORDERS (typed), row GIỮ NGUYÊN hidden — KHÔNG crash 23503", async () => {
    const sellerId = await mkVerifiedSeller();
    const buyerId = await mkUser("buyer");
    created.users.push(sellerId, buyerId);
    const legacyCat = await mkCategory("loa-thung-pa", "Loa thùng PA");
    const listingId = await seedLegacyListing({ sellerId, categoryId: legacyCat, status: "hidden" });
    await seedOffer(listingId, buyerId);
    await login(sellerId);

    const url = await expectRedirect(() => deleteListingAction(fd({ listingId })));

    expect(url).toBe("/sell/my?error=LISTING_HAS_ORDERS"); // typed banner — KHÔNG error boundary
    const row = await db.orm.public.Listing.first({ id: listingId });
    expect(row!.status).toBe("hidden"); // GIỮ NGUYÊN — offer vẫn tham chiếu sống
  });

  it("pending + offer (KHÔNG có đơn) → redirect LISTING_HAS_ORDERS, row SỐNG SÓT pending", async () => {
    const sellerId = await mkVerifiedSeller();
    const buyerId = await mkUser("buyer");
    created.users.push(sellerId, buyerId);
    const legacyCat = await mkCategory("loa-thung-pa", "Loa thùng PA");
    const listingId = await seedLegacyListing({ sellerId, categoryId: legacyCat, status: "pending" });
    await seedOffer(listingId, buyerId);
    await login(sellerId);

    const url = await expectRedirect(() => deleteListingAction(fd({ listingId })));

    expect(url).toBe("/sell/my?error=LISTING_HAS_ORDERS");
    expect((await db.orm.public.Listing.first({ id: listingId }))!.status).toBe("pending");
  });
});

// ─── 4. Wishlist gate (b4-holistic-2 MEDIUM) ───────────────────────────────────

d("toggleWishlistAction — add chỉ approved, remove mọi status (b4-holistic-2 MEDIUM)", () => {
  it("add approved → WishlistItem tạo; add pending → KHÔNG; remove entry pending → XOÁ được (dọn stale)", async () => {
    const sellerId = await mkVerifiedSeller();
    const buyerId = await mkUser("buyer");
    created.users.push(sellerId, buyerId);
    const legacyCat = await mkCategory("loa-thung-pa", "Loa thùng PA");
    const approvedId = await seedLegacyListing({ sellerId, categoryId: legacyCat, status: "approved" });
    const pendingId = await seedLegacyListing({ sellerId, categoryId: legacyCat, status: "pending" });
    await login(buyerId);

    // add approved → tạo
    await toggleWishlistAction(fd({ listingId: approvedId }));
    const savedApproved = await db.orm.public.WishlistItem
      .where({ userId: buyerId, listingId: approvedId })
      .first();
    expect(savedApproved).not.toBeNull();
    created.wishlist.push(savedApproved!.id);

    // add pending → KHÔNG tạo (fail closed — content chưa duyệt không vào wishlist)
    await toggleWishlistAction(fd({ listingId: pendingId }));
    expect(await db.orm.public.WishlistItem
      .where({ userId: buyerId, listingId: pendingId })
      .first()).toBeNull();

    // entry stale (listing chuyển pending sau khi đã lưu) → remove ĐƯỢC
    const stale = await db.orm.public.WishlistItem.create({ userId: buyerId, listingId: pendingId });
    created.wishlist.push(stale.id);
    await toggleWishlistAction(fd({ listingId: pendingId }));
    expect(await db.orm.public.WishlistItem
      .where({ userId: buyerId, listingId: pendingId })
      .first()).toBeNull();
  });
});
