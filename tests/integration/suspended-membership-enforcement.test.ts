/**
 * Suspended-membership enforcement — integration tests (Batch 7 plan Task 7 —
 * spec §9 Batch 7 Gate "suspended membership enforcement" + "seller cohort +
 * verification publication requirement" end-to-end; Review Focus 3) — chạy trên
 * scratch DB (scripts/test-integration.sh: container riêng + `prisma db
 * migrate --to production` + dọn). KHÔNG chạy trong `npm test`.
 *
 * Unit tests (tests/unit/suspended-membership-enforcement.test.ts) chứng minh
 * logic với db mock; ở đây chứng minh CÙNG hợp đồng against DB THẬT với module
 * THẬT (session, rbac + MFA thật qua createSession isAdmin, publication gate
 * Batch 2/4, chat/Deal guards Batch 3/6 + Task 6, audit, notify,
 * setBetaMembershipAction của Batch 2 — cơ chế suspension duy nhất, tái sử
 * dụng NGUYÊN VẸN, không viết lại):
 *
 *  1. Full happy path → suspend → MỌI cổng đóng → reactivate → MỌI cổng mở lại:
 *     seed verified seller (8 yêu cầu) + listing beta approved sống → gate
 *     { ok: true, missing: [] } → setBetaMembershipAction suspend (ops fixture,
 *     action Batch 2 — audited beta_cohort.membership_set) → gate
 *     { ok: false, missing: ["founding_seller_membership_active"] } →
 *     submitListingAction trên draft → blocked (/sell/verification + audit
 *     listing.submit_blocked) → approveListingAction trên pending → blocked +
 *     audit listing.approve_blocked → startConversationAction (member buyer
 *     trên listing sống của seller) → SELLER_MEMBERSHIP_INACTIVE (Batch 6 D2) →
 *     createDealAction → SELLER_MEMBERSHIP_INACTIVE → seller làm BUYER trên
 *     listing của seller eligible khác → BETA_MEMBERSHIP_REQUIRED (Task 6) →
 *     listing approved sống VẪN searchable công khai (Batch 3 A2 precedent —
 *     suspension chặn publication MỚI, không phải inventory cũ) →
 *     setBetaMembershipAction active → MỌI cổng mở lại (submit → pending, admin
 *     approve → approved, chat + Deal tạo lại được, seller-as-buyer được lại).
 *  2. Suspension audit trail: AuditEvent rows tồn tại cho
 *     beta_cohort.membership_set (Batch 2 action) với actor/subject/session +
 *     detail cohort=founding_seller;status=suspended (và status=active khi
 *     re-activate) — KHÔNG có đường mutation membership nào ngoài cơ chế được
 *     audit (Task 8 source scan sẽ pin thêm: Batch 7 không import
 *     setBetaMembershipAction như một mutation surface thứ hai).
 *
 * `next/headers` mock (cookie store điều khiển được — createSession cần
 * cookies() ngoài request scope) + `next/navigation` mock (redirect throw);
 * phần DB/session/rbac/moderation/rate-limit/policy/wrapper/beta-access/audit
 * là thật toàn bộ. AUTH_SECRET (hkdfKey "ip-hash" của auditEvent) +
 * PRODUCT_EVENT_PSEUDONYM_KEY (emit core — conversation_started/deal_created/
 * seller_first_listing_published/beta_membership_activated) stub trong
 * beforeAll — mọi emission path đều chạy được (Batch 6 S6 pattern).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
  },
}));

// ─── Cookie store điều khiển được (next/headers) — session THẬT ──────────────

const cookieState = vi.hoisted(() => ({ store: new Map<string, string>() }));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers()),
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
}));

import { db } from "../../src/prisma/db.client";
import { SESSION_COOKIE, createSession } from "../../src/lib/session";
import { resetRateLimits } from "../../src/lib/rate-limit";
import { checkSellerPublicationRequirements } from "../../src/lib/seller-verification-policy";
import { isListingSearchable } from "../../src/lib/search-query";
import { setBetaMembershipAction } from "../../src/lib/actions/beta-cohort";
import { submitListingAction } from "../../src/lib/actions/listings";
import { approveListingAction } from "../../src/lib/actions/admin";
import { startConversationAction } from "../../src/lib/actions/chat";
import { createDealAction } from "../../src/lib/actions/deals";

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

/** Key test hợp lệ — base64 của đúng 32 byte (product-events.test.ts pattern). */
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

let seq = 0;
const uid = (): string => `b7-sm-${Date.now()}-${seq++}`;

async function mkUser(role: "buyer" | "seller" | "admin", over?: { adminRole?: string }): Promise<string> {
  const u = await db.orm.public.User.create({
    email: `${uid()}@integration.test`,
    passwordHash: "x",
    name: `B7 SM ${role} ${seq}`,
    role,
    ...(over?.adminRole ? { adminRole: over.adminRole as "operations_admin" } : {}),
  });
  created.users.push(u.id);
  return u.id;
}

/** Ghi đủ 8 yêu cầu policy v1 lên user (user → timestamps → khai báo → rules → membership → verification). */
async function grantVerification(userId: string): Promise<void> {
  const now = new Date().toISOString();
  await db.orm.public.User.where({ id: userId }).update({
    emailVerifiedAt: now,
    phoneVerifiedAt: now,
    sellerType: "individual",
    sellerOperatingProvinceCode: "ho-chi-minh",
  });
  await db.orm.public.PolicyAcceptance.create({
    userId,
    policyKey: "seller_rules",
    policyVersion: "v1",
    acceptedAt: now,
  });
  await db.orm.public.BetaCohortMembership.create({
    userId,
    cohort: "founding_seller",
    status: "active",
  });
  await db.orm.public.SellerVerification.create({
    userId,
    status: "verified",
    method: "operations_review",
    policyVersion: "v1",
    reasonCode: "requirements_met",
    submittedAt: now,
    reviewedAt: now,
  });
}

/** Buyer là active private_beta_buyer member (§2.1 participant). */
async function seedBuyerMembership(buyerId: string): Promise<void> {
  await db.orm.public.BetaCohortMembership.create({
    userId: buyerId,
    cohort: "private_beta_buyer",
    status: "active",
  });
}

/** Catalog beta: category (slug §5.6.1 verbatim — create-if-absent, listing-publication.test.ts mkCategory precedent) + brand + model APPROVED. */
async function mkBetaCatalog(): Promise<{
  categoryId: string;
  brandId: string;
  modelId: string;
}> {
  const BETA_SLUG = "portable_bluetooth_speaker";
  let categoryId: string;
  const existing = await db.orm.public.Category.first({ slug: BETA_SLUG });
  if (existing) {
    categoryId = existing.id; // reuse — KHÔNG track (không xoá row của file khác)
  } else {
    const cat = await db.orm.public.Category.create({
      name: "Loa Bluetooth di động",
      slug: BETA_SLUG,
      commissionRate: 5,
      sortOrder: 0,
      isActive: true,
    });
    created.categories.push(cat.id);
    categoryId = cat.id;
  }
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

/**
 * Listing structured beta đầy đủ (status caller đặt) + 1 ảnh gắn (/img/ seed —
 * rule 2 attached compat, listing-publication.test.ts pattern). Content ĐỦ
 * để submit/approve chạy qua content stage khi seller gate mở lại.
 */
async function seedBetaListing(input: {
  sellerId: string;
  cat: { categoryId: string; brandId: string; modelId: string };
  status: "draft" | "pending" | "approved";
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
    city: "TP. Hồ Chí Minh",
    inventoryContext: "used",
    includedAccessories: null,
    knownDefects: null,
    repairHistory: null,
    fulfillmentMethods: ["meetup"],
    provinceLevelCode: "ho-chi-minh",
    communeLevelCode: null,
    locationDisplayName: "Khu vực Quận 1",
  });
  created.listings.push(l.id);
  await db.orm.public.ListingImage.create({
    listingId: l.id,
    url: "/img/listings/it-sm.svg",
    sortOrder: 0,
    checklistSlot: "front",
  });
  return l.id;
}

/** Session THẬT cho user — trả token cookie để switch giữa các user. */
async function loginAs(userId: string, opts?: { isAdmin?: boolean }): Promise<string> {
  cookieState.store.clear();
  await createSession(userId, opts);
  const token = cookieState.store.get(SESSION_COOKIE);
  if (!token) throw new Error("createSession không set cookie (mock next/headers?)");
  return token;
}

const setSession = (token: string): void => {
  cookieState.store.clear();
  cookieState.store.set(SESSION_COOKIE, token);
};

const fd = (entries: Record<string, string>): FormData => {
  const form = new FormData();
  for (const [k, v] of Object.entries(entries)) form.set(k, v);
  return form;
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

// dọn đúng dữ liệu test mình tạo (DB scratch — nhưng vẫn dọn sạch theo ref),
// thứ tự ngược FK: ProductEvent (no FK — theo listingId) → Deal
// (DealStatusHistory Cascade) → Conversation → Listing (cascade ảnh/price
// history) → ProductModel (cascade PriceHistory) → Brand → Category →
// SellerVerification (user Restrict) → User (cascade session/policy/
// membership/notification/AdminAuditLog). AuditEvent (SetNull theo actor/
// subject) xoá theo actor/subject mình tạo TRƯỚC khi xoá user.
// Ghi chú: ProductEvent beta_membership_activated (không cột listingId —
// actorPseudonym keyed) không scope được theo fixture — để lại (append-only
// telemetry, không test nào assert global count — cùng tiền lệ
// beta-access-enforcement.test.ts).
const created = {
  users: [] as string[],
  categories: [] as string[],
  brands: [] as string[],
  models: [] as string[],
  listings: [] as string[],
};

afterEach(async () => {
  for (const listingId of created.listings) {
    await db.orm.public.ProductEvent.where({ listingId }).deleteAll();
    await db.orm.public.Deal.where({ listingId }).deleteAll();
    await db.orm.public.Conversation.where({ listingId }).deleteAll();
    await db.orm.public.Listing.where({ id: listingId }).deleteAll();
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
    await db.orm.public.AuditEvent.where({ actorId: id }).deleteAll();
    await db.orm.public.AuditEvent.where({ subjectId: id }).deleteAll();
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
  created.listings.length = 0;
  cookieState.store.clear();
});

beforeAll(() => {
  // Mọi emission path (conversation_started/deal_created/
  // seller_first_listing_published/beta_membership_activated) + audit ipHash
  // đều cần key — stub TRƯỚC test đầu tiên (Batch 6 S6 pattern).
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AUTH_SECRET", "integration-test-auth-secret-0123456789abcdef");
  vi.stubEnv("PRODUCT_EVENT_PSEUDONYM_KEY", TEST_KEY);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await db.close();
});

beforeEach(() => {
  resetRateLimits();
});

// ─── 1. Full happy path → suspend → mọi cổng đóng → reactivate → mở lại ─────

d("suspended-membership enforcement trên DB thật (spec §9 Batch 7 Gate)", () => {
  it("happy path → suspend (setBetaMembershipAction) → MỌI cổng đóng → reactivate → MỌI cổng mở lại", async () => {
    // ─── Seed: ops admin + verified seller (8 yêu cầu) + seller2 eligible +
    //     member buyer + catalog beta + 3 listing của seller (sống/draft/pending)
    //     + listing của seller2 (chân seller-as-buyer) ────────────────────────
    const ops = await mkUser("admin", { adminRole: "operations_admin" });
    const seller = await mkUser("seller");
    const seller2 = await mkUser("seller");
    const buyer = await mkUser("buyer");
    await grantVerification(seller);
    await grantVerification(seller2); // D2 — seller2 đủ §7.8 cho chân buyer của seller
    await seedBuyerMembership(buyer);
    const cat = await mkBetaCatalog();
    const liveListing = await seedBetaListing({ sellerId: seller, cat, status: "approved" });
    const draftListing = await seedBetaListing({ sellerId: seller, cat, status: "draft" });
    const pendingListing = await seedBetaListing({ sellerId: seller, cat, status: "pending" });
    const listing2 = await seedBetaListing({ sellerId: seller2, cat, status: "approved" });

    const sellerTok = await loginAs(seller);
    const buyerTok = await loginAs(buyer);
    const opsTok = await loginAs(ops, { isAdmin: true });

    // ─── Happy path: gate mở (đủ 8 — chưa có gì thiếu) ────────────────────────
    const before = await checkSellerPublicationRequirements(seller);
    expect(before).toEqual({ ok: true, missing: [] });

    // ─── Suspend qua ACTION Batch 2 (ops fixture — audited; ops ≠ seller:
    //     self-grant forbidden) ───────────────────────────────────────────────
    setSession(opsTok);
    await setBetaMembershipAction(
      fd({ userId: seller, cohort: "founding_seller", status: "suspended" }),
    );

    // ─── Gate Batch 2 đóng NGAY (đọc FRESH — session seller còn sống) ────────
    const gated = await checkSellerPublicationRequirements(seller);
    expect(gated).toEqual({ ok: false, missing: ["founding_seller_membership_active"] });

    // ─── submitListingAction (draft → pending) blocked → /sell/verification
    //     + audit submit_blocked (transition thứ 5 — corrections #30) ────────
    setSession(sellerTok);
    const submitBlockedUrl = await expectRedirect(() =>
      submitListingAction(fd({ listingId: draftListing })),
    );
    expect(submitBlockedUrl).toBe("/sell/verification");
    const draftRow = await db.orm.public.Listing.first({ id: draftListing });
    expect(draftRow!.status).toBe("draft"); // KHÔNG transition vào review
    const submitBlockedAudit = await db.orm.public.AuditEvent
      .where({ action: "listing.submit_blocked", resourceId: draftListing })
      .first();
    expect(submitBlockedAudit).not.toBeNull();
    expect(submitBlockedAudit!.reason).toBe(
      "SELLER_PUBLICATION_BLOCKED:founding_seller_membership_active",
    );

    // ─── approveListingAction (admin) blocked + audit approve_blocked ────────
    //     (defense-in-depth — kể cả admin duyệt cũng bị gate chặn)
    setSession(opsTok);
    const pendingRowBefore = await db.orm.public.Listing.first({ id: pendingListing });
    await approveListingAction(
      fd({ listingId: pendingListing, version: pendingRowBefore!.updatedAt }),
    );
    const pendingRow = await db.orm.public.Listing.first({ id: pendingListing });
    expect(pendingRow!.status).toBe("pending"); // KHÔNG approve
    const approveBlocked = await db.orm.public.AuditEvent
      .where({ action: "listing.approve_blocked", resourceId: pendingListing })
      .first();
    expect(approveBlocked).not.toBeNull();
    expect(approveBlocked!.actorId).toBe(ops);
    expect(approveBlocked!.subjectId).toBe(seller);
    expect(approveBlocked!.reason).toBe("publication_requirements_unmet");
    expect(approveBlocked!.detail).toContain("founding_seller_membership_active");

    // ─── Chat: member buyer trên listing SỐNG của seller → SELLER_MEMBERSHIP_INACTIVE
    //     (Batch 6 D2 — guard đọc FRESH, KHÔNG Conversation) ──────────────────
    setSession(buyerTok);
    await expect(startConversationAction(fd({ listingId: liveListing }))).rejects.toThrow(
      "SELLER_MEMBERSHIP_INACTIVE",
    );
    expect(
      await db.orm.public.Conversation.where({ listingId: liveListing, buyerId: buyer }).first(),
    ).toBeNull();

    // ─── Deal: cùng listing → SELLER_MEMBERSHIP_INACTIVE (C2 — D2 chạy
    //     TRƯỚC requireDealConversation nên KHÔNG cần hội thoại) ──────────────
    const dealDenied = await createDealAction({}, fd({ listingId: liveListing, agreedPrice: "1500000" }));
    expect(dealDenied).toEqual({ error: "SELLER_MEMBERSHIP_INACTIVE" });
    expect(await db.orm.public.Deal.where({ listingId: liveListing, buyerId: buyer }).first()).toBeNull();

    // ─── Chân buyer: seller (membership suspended) làm BUYER trên listing của
    //     seller2 eligible → BETA_MEMBERSHIP_REQUIRED (Task 6 — D2 của seller2
    //     pass trước, buyer gate chặn sau) ────────────────────────────────────
    setSession(sellerTok);
    await expect(startConversationAction(fd({ listingId: listing2 }))).rejects.toThrow(
      "BETA_MEMBERSHIP_REQUIRED",
    );
    expect(
      await db.orm.public.Conversation.where({ listingId: listing2, buyerId: seller }).first(),
    ).toBeNull();

    // ─── Listing sống VẪN công khai (Batch 3 A2 precedent — suspension chặn
    //     publication MỚI, KHÔNG phải inventory cũ; removal là moderator
    //     decision qua Batch 3 takedown) ──────────────────────────────────────
    const liveRow = await db.orm.public.Listing.first({ id: liveListing });
    expect(liveRow!.status).toBe("approved");
    expect(isListingSearchable(liveRow!.status)).toBe(true);

    // ─── Reactivate qua ACTION Batch 2 → MỌI cổng mở lại NGAY ────────────────
    setSession(opsTok);
    await setBetaMembershipAction(
      fd({ userId: seller, cohort: "founding_seller", status: "active" }),
    );

    const reopened = await checkSellerPublicationRequirements(seller);
    expect(reopened).toEqual({ ok: true, missing: [] });

    // submit draft → pending (gate mở lại — CAS claim + audit listing.submitted)
    setSession(sellerTok);
    const submitUrl = await expectRedirect(() => submitListingAction(fd({ listingId: draftListing })));
    expect(submitUrl).toBe("/sell/my?submitted=1");
    const draftAfter = await db.orm.public.Listing.first({ id: draftListing });
    expect(draftAfter!.status).toBe("pending");

    // admin approve pending → approved + audit listing.approved
    setSession(opsTok);
    const pendingRow2 = await db.orm.public.Listing.first({ id: pendingListing });
    await approveListingAction(
      fd({ listingId: pendingListing, version: pendingRow2!.updatedAt }),
    );
    const approvedRow = await db.orm.public.Listing.first({ id: pendingListing });
    expect(approvedRow!.status).toBe("approved");
    const approvedAudit = await db.orm.public.AuditEvent
      .where({ action: "listing.approved", resourceId: pendingListing })
      .first();
    expect(approvedAudit).not.toBeNull();
    expect(approvedAudit!.actorId).toBe(ops);

    // chat mở lại: member buyer tạo hội thoại trên listing sống (redirect sau create)
    setSession(buyerTok);
    await expect(startConversationAction(fd({ listingId: liveListing }))).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    const convo = await db.orm.public.Conversation
      .where({ listingId: liveListing, buyerId: buyer })
      .first();
    expect(convo).not.toBeNull();

    // Deal mở lại: buyer tạo Deal trong hội thoại vừa mở
    const dealOk = await createDealAction({}, fd({ listingId: liveListing, agreedPrice: "1500000" }));
    expect(dealOk).toEqual({ success: "Đã tạo thỏa thuận." });
    const deal = await db.orm.public.Deal.where({ listingId: liveListing, buyerId: buyer }).first();
    expect(deal).toMatchObject({ status: "open", agreedPrice: 1_500_000 });

    // seller-as-buyer mở lại: founding_seller active ∈ BETA_CHAT_ALLOWED_COHORTS
    setSession(sellerTok);
    await expect(startConversationAction(fd({ listingId: listing2 }))).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    const convo2 = await db.orm.public.Conversation
      .where({ listingId: listing2, buyerId: seller })
      .first();
    expect(convo2).not.toBeNull();
  });

  // ─── 2. Suspension audit trail — mọi mutation membership đi qua cơ chế được audit ──

  it("AuditEvent beta_cohort.membership_set tồn tại với actor/subject/session + status trong detail (cơ chế Batch 2, KHÔNG bypass)", async () => {
    const ops = await mkUser("admin", { adminRole: "operations_admin" });
    const seller = await mkUser("seller");
    await grantVerification(seller);

    const opsTok = await loginAs(ops, { isAdmin: true });
    setSession(opsTok);
    await setBetaMembershipAction(
      fd({ userId: seller, cohort: "founding_seller", status: "suspended" }),
    );
    await setBetaMembershipAction(
      fd({ userId: seller, cohort: "founding_seller", status: "active" }),
    );

    // Cả hai lần set đều ghi audit — actor = ops (không phải seller), subject =
    // seller, session = session ops thật, detail mang cohort + status TYPED
    // (KHÔNG PII — spec §4.8).
    const rows = await db.orm.public.AuditEvent
      .where({ action: "beta_cohort.membership_set", subjectId: seller })
      .orderBy((a) => a.createdAt.asc())
      .all();
    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({
      actorId: ops,
      subjectId: seller,
      resourceType: "BetaCohortMembership",
    });
    expect(rows[0]!.detail).toContain("cohort=founding_seller");
    expect(rows[0]!.detail).toContain("status=suspended");
    expect(rows[1]!.detail).toContain("status=active");
    // session của AUDIT là session ops (bằng chứng MFA thật — non-null)
    expect(rows[0]!.sessionId).not.toBeNull();
    expect(rows[0]!.sessionId).toBe(rows[1]!.sessionId);

    // Membership row DUY NHẤT (upsert theo @@unique(userId, cohort)) — không nhân bản
    const memberships = await db.orm.public.BetaCohortMembership
      .where({ userId: seller, cohort: "founding_seller" })
      .all();
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.status).toBe("active");
  });
});
