/**
 * Listing publication gate — end-to-end integration tests (Batch 4 Task 8 —
 * publication-gate gate, spec §2.1/§4.4/§4.5/§5.6.1/§5.6.2/§5.6.4/§6.3/§7.3)
 * — chạy trên scratch DB (scripts/test-integration.sh: container riêng +
 * migrate + dọn). KHÔNG chạy trong `npm test`.
 *
 * Chứng minh CỔNG publication đầy đủ (Batch 2 seller gate + Batch 3
 * account_not_suspended + Batch 4 content: allowlist + regime schema +
 * canonical-model DB check + image ownership) against DB THẬT với action
 * THẬT (saveListingDraftAction / submitListingAction / createListingAction /
 * toggleListingVisibilityAction / approveListingAction — gate + audit + CAS
 * thật toàn bộ; unit tests đã pin logic với db mock):
 *
 *  1. draft → submit → approve happy path: draft TRƯỚC verification (spec
 *     §4.4/§5.6.2 — KHÔNG seller gate) → verify → submit → pending → approve →
 *     approved; structured fields + checklistSlot + city =
 *     PROVINCE_CODES[provinceLevelCode] (canonical 34-unit displayName — FD-1)
 *     round-trip; audit listing.draft_created / listing.submitted
 *     (policyVersion v1) / listing.approved.
 *  2. Revoked seller: submit blocked → /sell/verification, status GIỮ draft,
 *     audit listing.submit_blocked; re-verify → submit passes.
 *  3. Suspended cohort membership (founding_seller): toggle hidden→approved
 *     blocked (Batch 2 invariant qua wrapper — membership đọc FRESH từ DB),
 *     status GIỮ hidden + audit; re-activate → toggle passes.
 *  4. Active UserSuspension (Batch 3 — account_not_suspended, KHÁC membership
 *     suspension): create blocked (đình chỉ text) + submit → /sell/verification
 *     + audit reason SELLER_PUBLICATION_BLOCKED:account_not_suspended + toggle
 *     blocked + approveListingAction → KHÔNG approve + audit
 *     "publication_requirements_unmet" missing=account_not_suspended.
 *  5. Upload ownership end-to-end (spec §5.6.4): ảnh owned → create pass;
 *     storageKey của seller KHÁC → IMAGE_NOT_OWNED (cross-account theft);
 *     scheme URL có basename LÀ upload của CHÍNH seller → IMAGE_URL_INVALID
 *     (rule-1 basename bypass — Review Focus 4).
 *  6. Category allowlist end-to-end (spec §5.6.1): create trong category
 *     legacy → CATEGORY_NOT_PUBLICATION_ALLOWED, KHÔNG row; create trong beta
 *     với input đầy đủ → pass (pending).
 *  7. Canonical model end-to-end (B4 — DB check, không chỉ zod presence):
 *     submit draft với model PENDING → ?error=MODEL_INVALID (draft GIỮ
 *     nguyên — draft path không check model, submit mới check); create với
 *     model sai brand → MODEL_BRAND_MISMATCH.
 *  8. Transaction no-silent-success (item 8): Listing.slug unique violation
 *     (23505) BÊN TRONG tx create — tx khác giữ unique-index entry (MVCC:
 *     pre-check của action KHÔNG thấy) → THROW ra khỏi callback → classify
 *     NGOÀI tx → typed LISTING_SLUG_COLLISION — KHÔNG ListingImage/
 *     PriceHistory partial rows persist (tx rollback toàn bộ).
 *
 *     CAS-vs-content races (submit ?error=CONCURRENT_CHANGE / approve audit
 *     listing_changed_during_review — updatedAt optimistic version) pinned
 *     bởi tests/integration/listing-submit-approve-race.test.ts (row-lock
 *     barrier) — KHÔNG duplicate ở đây.
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
import { slugify } from "../../src/lib/utils";
import {
  saveListingDraftAction,
  submitListingAction,
  createListingAction,
  toggleListingVisibilityAction,
} from "../../src/lib/actions/listings";
import { approveListingAction } from "../../src/lib/actions/admin";

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const PASSWORD_HASH = bcrypt.hashSync("integration-password-123", 10);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let seq = 0;
const uid = (): string => `b4-pub-${Date.now()}-${seq++}`;

/** Đếm riêng cho storageKey upload (hex thường v4 — offset riêng file, không đụng legacy file). */
let keySeq = 0x2000;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

async function mkUser(role: "buyer" | "seller" | "admin", over?: { adminRole?: string }): Promise<string> {
  const u = await db.orm.public.User.create({
    email: `${uid()}@integration.test`,
    passwordHash: PASSWORD_HASH,
    name: `B4 Pub ${role}`,
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
    name: "B4 Pub Seller",
    role: "seller",
    emailVerifiedAt: now,
    phoneVerifiedAt: now,
    sellerType: "individual",
    sellerOperatingProvinceCode: "ho-chi-minh",
  });
  await grantVerification(u.id, now);
  return u.id;
}

/** Ghi đủ 8 yêu cầu policy v1 lên user HIỆN CÓ (user → timestamps → khai báo → rules → membership → verification). */
async function grantVerification(userId: string, now = new Date().toISOString()): Promise<void> {
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

/**
 * Row ListingImageUpload (ownership — spec §5.6.4) của owner — đường trực tiếp
 * (plan Task 8 cho phép "upload route path (or direct ListingImageUpload.create)";
 * route tự nó đã được upload-route.test.ts pin — ở đây chứng minh enforcement
 * ownership tại ranh giới listing action). storageKey hex thường v4 + ".webp"
 * khớp LISTING_IMAGE_URL_PATTERN.
 */
async function mkUploadRow(ownerUserId: string): Promise<string> {
  keySeq += 1;
  const hex = (n: number, w: number) => n.toString(16).padStart(w, "0");
  const storageKey = `${hex(keySeq, 8)}-0000-4000-8000-${hex(keySeq, 12)}.webp`;
  const row = await db.orm.public.ListingImageUpload.create({
    ownerUserId,
    storageKey,
    bytes: 204_800,
    width: 2560,
    height: 1440,
  });
  created.uploads.push(row.id);
  return storageKey;
}

/** Listing structured beta đầy đủ (status caller đặt) + 1 ảnh gắn (mặc định /img/ seed — rule 2 attached compat). */
async function seedBetaListing(input: {
  sellerId: string;
  cat: { categoryId: string; brandId: string; modelId: string };
  status: "draft" | "pending" | "approved" | "hidden";
  imageUrls?: string[];
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
  const urls = input.imageUrls ?? ["/img/listings/it-pub.svg"];
  for (let i = 0; i < urls.length; i++) {
    await db.orm.public.ListingImage.create({
      listingId: l.id,
      url: urls[i]!,
      sortOrder: i,
      checklistSlot: i === 0 ? "front" : null,
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

/** Form beta đầy đủ (§6.3): brand/model/condition/inventory/fulfillment/province/location + ảnh owned + slot. */
const betaForm = (cat: { categoryId: string; brandId: string; modelId: string }, over?: {
  title?: string;
  categoryId?: string;
  brandId?: string;
  productModelId?: string;
  images?: string[];
  imageSlots?: string[];
}): FormData =>
  fd({
    title: over?.title ?? "Loa JBL Charge 5 chính hãng",
    description: "Loa bluetooth cũ còn tốt, pin trâu, nghe hay.",
    categoryId: over?.categoryId ?? cat.categoryId,
    brandId: over?.brandId ?? cat.brandId,
    productModelId: over?.productModelId ?? cat.modelId,
    condition: "good",
    price: "1800000",
    negotiable: "on",
    inventoryContext: "used",
    fulfillmentMethods: ["meetup"],
    provinceLevelCode: "ho-chi-minh",
    locationDisplayName: "Khu vực Quận 1",
    images: over?.images ?? [],
    imageSlots: over?.imageSlots ?? [],
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
  uploads: [] as string[], // ListingImageUpload ids
  suspensions: [] as string[], // UserSuspension ids
};

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  // HKDF (src/lib/hkdf.ts) derive từ AUTH_SECRET — KHÔNG phụ thuộc .env của worktree.
  vi.stubEnv("AUTH_SECRET", "integration-test-auth-secret-0123456789abcdef");
  resetRateLimits();
  cookieState.store.clear();
});

afterEach(async () => {
  // AuditEvent (SetNull nhưng xoá sạch theo actor/subject mình tạo) →
  // ListingImageUpload → Listing (cascade ảnh/cart) → ProductModel (cascade
  // PriceHistory) → Brand → Category → UserSuspension (userId Restrict —
  // PHẢI xoá trước User) → SellerVerification (userId Restrict) → User
  // (cascade session/policy-acceptance/membership/notification/AdminAuditLog).
  //
  // Listing xoá THEO SELLER (mọi user mình tạo) — KHÔNG theo id list: draft/
  // listing do ACTION tạo (saveListingDraftAction/createListingAction redirect
  // không trả id) không có id để track; Listing.productModelId/brandId/categoryId
  // FK Restrict nên listing treo = xoá catalog bị chặn (23503) → afterEach
  // throw → residue (category beta) leak sang file sau (glob order của vitest
  // theo filesystem, KHÔNG alphabet — file sau bare-create slug beta → 23505).
  for (const id of created.users) {
    await db.orm.public.AuditEvent.where({ actorId: id }).deleteAll();
    await db.orm.public.AuditEvent.where({ subjectId: id }).deleteAll();
  }
  for (const id of created.uploads) {
    await db.orm.public.ListingImageUpload.where({ id }).deleteAll();
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
  for (const id of created.suspensions) {
    await db.orm.public.UserSuspension.where({ id }).deleteAll();
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
  created.uploads.length = 0;
  created.suspensions.length = 0;
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.close();
});

// ─── 1. draft → submit → approve happy path (spec §4.4/§5.6.2) ───────────────

d("listing publication gate end-to-end (Batch 4 Task 8)", () => {
  it("draft TRƯỚC verification → verify → submit → pending → approve → approved; structured + slot + city canonical round-trip", async () => {
    const sellerId = await mkUser("seller"); // CHƯA verify — draft được phép (spec §4.4)
    created.users.push(sellerId);
    const adminId = await mkAdmin();
    created.users.push(adminId);
    const cat = await mkBetaCatalog();
    const storageKey = await mkUploadRow(sellerId);

    // draft TRƯỚC verification — saveListingDraftAction KHÔNG gọi seller gate
    await login(sellerId);
    const draftUrl = await expectRedirect(() =>
      saveListingDraftAction({}, betaForm(cat, {
        images: [`/uploads/${storageKey}`],
        imageSlots: ["front"],
      })),
    );
    expect(draftUrl).toMatch(DRAFT_REDIRECT_RE);
    const draftId = parseDraftId(draftUrl);

    let row = await db.orm.public.Listing.first({ id: draftId });
    expect(row!.status).toBe("draft");
    // city (cột non-null) = PROVINCE_CODES[provinceLevelCode] — canonical 34-unit displayName (FD-1)
    expect(row!.city).toBe("TP. Hồ Chí Minh");
    const draftAudit = await db.orm.public.AuditEvent
      .where({ action: "listing.draft_created", resourceId: draftId })
      .all();
    expect(draftAudit).toHaveLength(1);

    // verify seller (8 yêu cầu — seed trực tiếp)
    await grantVerification(sellerId);

    // submit → pending + audit listing.submitted (policyVersion §4.6)
    await submitListingAction(fd({ listingId: draftId }));
    row = await db.orm.public.Listing.first({ id: draftId });
    expect(row!.status).toBe("pending");
    const submitted = await db.orm.public.AuditEvent
      .where({ action: "listing.submitted", resourceId: draftId })
      .all();
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.policyVersion).toBe("v1"); // SELLER_RULES_POLICY_VERSION

    // approve → approved (admin qua checkListingPublication — defense-in-depth)
    await login(adminId, { isAdmin: true });
    await approveListingAction(fd({ listingId: draftId }));
    row = await db.orm.public.Listing.first({ id: draftId });
    expect(row!.status).toBe("approved");
    expect(row!.rejectionReason).toBeNull();

    // public read — structured + checklistSlot + city canonical round-trip
    expect(row!.inventoryContext).toBe("used");
    expect(row!.fulfillmentMethods).toEqual(["meetup"]); // jsonb deep-equal
    expect(row!.provinceLevelCode).toBe("ho-chi-minh");
    expect(row!.locationDisplayName).toBe("Khu vực Quận 1");
    expect(row!.city).toBe("TP. Hồ Chí Minh");
    const images = await db.orm.public.ListingImage
      .where({ listingId: draftId })
      .orderBy((i) => i.sortOrder.asc())
      .all();
    expect(images).toHaveLength(1);
    expect(images[0]!.url).toBe(`/uploads/${storageKey}`);
    expect(images[0]!.checklistSlot).toBe("front");
    const approvedEvt = await db.orm.public.AuditEvent
      .where({ action: "listing.approved", resourceId: draftId })
      .all();
    expect(approvedEvt).toHaveLength(1);
  });

  // ─── 2. Revoked seller → submit blocked → re-verify → pass ────────────────

  it("revoked seller: submit blocked → /sell/verification, status GIỮ draft, audit submit_blocked; re-verify → submit passes", async () => {
    const sellerId = await mkVerifiedSeller();
    created.users.push(sellerId);
    const cat = await mkBetaCatalog();
    const storageKey = await mkUploadRow(sellerId);

    await login(sellerId);
    const draftId = parseDraftId(await expectRedirect(() =>
      saveListingDraftAction({}, betaForm(cat, {
        images: [`/uploads/${storageKey}`],
        imageSlots: ["front"],
      })),
    ));

    // REVOKE (operations review thu hồi — đọc FRESH từ DB mỗi lần gate chạy)
    await db.orm.public.SellerVerification.where({ userId: sellerId }).updateAll({ status: "revoked" });

    const url = await expectRedirect(() => submitListingAction(fd({ listingId: draftId })));
    expect(url).toBe("/sell/verification");
    expect((await db.orm.public.Listing.first({ id: draftId }))!.status).toBe("draft");
    const blocked = await db.orm.public.AuditEvent
      .where({ action: "listing.submit_blocked", resourceId: draftId })
      .all();
    expect(blocked).toHaveLength(1);
    expect(String(blocked[0]!.reason)).toContain("operations_review_verified");

    // RE-VERIFY → submit passes (vòng thu hồi/tái xác minh)
    await db.orm.public.SellerVerification.where({ userId: sellerId }).updateAll({ status: "verified" });
    await submitListingAction(fd({ listingId: draftId }));
    expect((await db.orm.public.Listing.first({ id: draftId }))!.status).toBe("pending");
  });

  // ─── 3. Suspended cohort membership → toggle hidden→approved blocked ──────

  it("suspended founding_seller membership: toggle hidden→approved blocked (silent), status GIỮ hidden + audit; re-activate → toggle passes", async () => {
    const sellerId = await mkVerifiedSeller();
    created.users.push(sellerId);
    const cat = await mkBetaCatalog();
    const listingId = await seedBetaListing({ sellerId, cat, status: "approved" });
    await login(sellerId);

    // approved → hidden (transition RA khỏi công khai — luôn được phép, KHÔNG gate)
    await toggleListingVisibilityAction(fd({ listingId }));
    expect((await db.orm.public.Listing.first({ id: listingId }))!.status).toBe("hidden");

    // SUSPEND membership (founding_seller — KHÁC UserSuspension)
    await db.orm.public.BetaCohortMembership
      .where({ userId: sellerId, cohort: "founding_seller" })
      .updateAll({ status: "suspended" });

    // hidden → approved: BLOCKED qua wrapper — silent return (form void), status GIỮ hidden
    await toggleListingVisibilityAction(fd({ listingId }));
    expect((await db.orm.public.Listing.first({ id: listingId }))!.status).toBe("hidden");
    const blocked = await db.orm.public.AuditEvent
      .where({ action: "listing.submit_blocked", resourceId: listingId })
      .all();
    expect(blocked).toHaveLength(1);
    expect(String(blocked[0]!.reason)).toContain("founding_seller_membership_active");

    // re-activate → toggle passes (membership là điều kiện — đọc FRESH từ DB)
    await db.orm.public.BetaCohortMembership
      .where({ userId: sellerId, cohort: "founding_seller" })
      .updateAll({ status: "active" });
    await toggleListingVisibilityAction(fd({ listingId }));
    expect((await db.orm.public.Listing.first({ id: listingId }))!.status).toBe("approved");
  });

  // ─── 4. Active UserSuspension (Batch 3 — account_not_suspended) ───────────

  it("active UserSuspension: create/submit/toggle blocked (account_not_suspended); approve → KHÔNG approve + audit missing=account_not_suspended", async () => {
    const sellerId = await mkVerifiedSeller();
    const adminId = await mkAdmin();
    created.users.push(sellerId, adminId);
    const cat = await mkBetaCatalog();
    const storageKey = await mkUploadRow(sellerId);

    // draft + hidden listing + pending listing của seller
    await login(sellerId);
    const draftId = parseDraftId(await expectRedirect(() =>
      saveListingDraftAction({}, betaForm(cat, {
        images: [`/uploads/${storageKey}`],
        imageSlots: ["front"],
      })),
    ));
    const hiddenId = await seedBetaListing({ sellerId, cat, status: "approved" });
    await toggleListingVisibilityAction(fd({ listingId: hiddenId })); // → hidden
    expect((await db.orm.public.Listing.first({ id: hiddenId }))!.status).toBe("hidden");
    const pendingId = await seedBetaListing({ sellerId, cat, status: "pending" });

    // SUSPEND (Batch 3 — episode active; KHÁC membership suspension ở case 3)
    const susp = await db.orm.public.UserSuspension.create({
      userId: sellerId,
      status: "active",
      reasonCode: "confirmed_abuse",
    });
    created.suspensions.push(susp.id);

    // create → blocked (suspension là sanction của moderation — text riêng, KHÔNG hướng dẫn hoàn tất verification)
    const createState = await createListingAction({}, betaForm(cat, {
      images: [`/uploads/${storageKey}`],
      imageSlots: ["front"],
    }));
    expect(createState.error).toContain("đình chỉ");
    expect(await db.orm.public.Listing.where({ sellerId }).all()).toHaveLength(3); // draft + hidden + pending — KHÔNG row mới

    // submit → /sell/verification + audit reason account_not_suspended + draft GIỮ NGUYÊN
    const submitUrl = await expectRedirect(() => submitListingAction(fd({ listingId: draftId })));
    expect(submitUrl).toBe("/sell/verification");
    expect((await db.orm.public.Listing.first({ id: draftId }))!.status).toBe("draft");
    const submitBlocked = await db.orm.public.AuditEvent
      .where({ action: "listing.submit_blocked", resourceId: draftId })
      .all();
    expect(submitBlocked).toHaveLength(1);
    expect(String(submitBlocked[0]!.reason)).toContain("account_not_suspended");

    // toggle hidden→approved → silent block, status GIỮ hidden
    await toggleListingVisibilityAction(fd({ listingId: hiddenId }));
    expect((await db.orm.public.Listing.first({ id: hiddenId }))!.status).toBe("hidden");
    const toggleBlocked = await db.orm.public.AuditEvent
      .where({ action: "listing.submit_blocked", resourceId: hiddenId })
      .all();
    expect(toggleBlocked).toHaveLength(1);
    expect(String(toggleBlocked[0]!.reason)).toContain("account_not_suspended");

    // approve (admin) → KHÔNG approve + audit publication_requirements_unmet missing=account_not_suspended
    // (defense-in-depth — spec §7.3: admin duyệt KHÔNG phải escape hatch)
    await login(adminId, { isAdmin: true });
    await approveListingAction(fd({ listingId: pendingId }));
    expect((await db.orm.public.Listing.first({ id: pendingId }))!.status).toBe("pending");
    const approveBlocked = await db.orm.public.AuditEvent
      .where({ action: "listing.approve_blocked", resourceId: pendingId })
      .all();
    expect(approveBlocked).toHaveLength(1);
    expect(approveBlocked[0]!.reason).toBe("publication_requirements_unmet");
    expect(approveBlocked[0]!.detail).toBe("missing=account_not_suspended");
  });

  // ─── 5. Upload ownership end-to-end (spec §5.6.4 — Review Focus 4) ─────────

  it("upload ownership: ảnh owned → create pass; storageKey seller KHÁC → IMAGE_NOT_OWNED; scheme URL basename của CHÍNH seller → IMAGE_URL_INVALID", async () => {
    const sellerA = await mkVerifiedSeller();
    const sellerB = await mkUser("buyer"); // B chỉ giữ upload row — KHÔNG cần verification
    created.users.push(sellerA, sellerB);
    const cat = await mkBetaCatalog();
    const keyA = await mkUploadRow(sellerA);
    const keyB = await mkUploadRow(sellerB);
    await login(sellerA);

    // (1) ảnh owned → create pass
    const url = await expectRedirect(() =>
      createListingAction({}, betaForm(cat, {
        images: [`/uploads/${keyA}`],
        imageSlots: ["front"],
      })),
    );
    expect(url).toBe("/sell/my?created=1");
    expect(await db.orm.public.Listing.where({ sellerId: sellerA }).all()).toHaveLength(1);

    // (2) storageKey của seller B → IMAGE_NOT_OWNED (cross-account theft), KHÔNG row mới
    const state2 = await createListingAction({}, betaForm(cat, {
      images: [`/uploads/${keyB}`],
      imageSlots: ["front"],
    }));
    expect(state2.error).toContain("IMAGE_NOT_OWNED");
    expect(await db.orm.public.Listing.where({ sellerId: sellerA }).all()).toHaveLength(1);

    // (3) scheme URL có basename LÀ upload của CHÍNH seller A → IMAGE_URL_INVALID
    //     (rule-1 basename bypass — pattern gate TRƯỚC lookup nên URL có scheme
    //     KHÔNG bao giờ đi vào rule (1) kể cả khi basename trúng storageKey)
    const state3 = await createListingAction({}, betaForm(cat, {
      images: [`https://evil.example/x/${keyA}`],
      imageSlots: ["front"],
    }));
    expect(state3.error).toContain("IMAGE_URL_INVALID");
    expect(await db.orm.public.Listing.where({ sellerId: sellerA }).all()).toHaveLength(1);
  });

  // ─── 6. Category allowlist end-to-end (spec §5.6.1) ───────────────────────

  it("category allowlist: create trong category legacy → CATEGORY_NOT_PUBLICATION_ALLOWED (KHÔNG row); create trong beta → pass (pending)", async () => {
    const sellerId = await mkVerifiedSeller();
    created.users.push(sellerId);
    const cat = await mkBetaCatalog();
    const legacyCat = await mkCategory(`it-legacy-${uid()}`, "Danh mục legacy IT");
    const storageKey = await mkUploadRow(sellerId);
    await login(sellerId);

    // legacy → typed error, KHÔNG row (allowlist invariant — tạo mới phải ∈ allowlist)
    const state = await createListingAction({}, betaForm(cat, {
      categoryId: legacyCat,
      images: [`/uploads/${storageKey}`],
      imageSlots: ["front"],
    }));
    expect(state.error).toContain("CATEGORY_NOT_PUBLICATION_ALLOWED");
    expect(await db.orm.public.Listing.where({ sellerId }).all()).toHaveLength(0);

    // beta → pass (pending — chờ admin duyệt)
    const url = await expectRedirect(() =>
      createListingAction({}, betaForm(cat, {
        images: [`/uploads/${storageKey}`],
        imageSlots: ["front"],
      })),
    );
    expect(url).toBe("/sell/my?created=1");
    const rows = await db.orm.public.Listing.where({ sellerId }).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("pending");
    expect(rows[0]!.categoryId).toBe(cat.categoryId);
  });

  // ─── 7. Canonical model end-to-end (B4 — DB check) ─────────────────────────

  it("canonical model: model PENDING → submit ?error=MODEL_INVALID (draft GIỮ nguyên); model sai brand → MODEL_BRAND_MISMATCH (create)", async () => {
    const sellerId = await mkVerifiedSeller();
    created.users.push(sellerId);
    const cat = await mkBetaCatalog();
    const storageKey = await mkUploadRow(sellerId);

    // model PENDING trong category beta (fixture CỦA TEST — founder duyệt qua /admin/catalog)
    const pendingModel = await db.orm.public.ProductModel.create({
      brandId: cat.brandId,
      categoryId: cat.categoryId,
      name: `Charge 6 pending ${uid()}`,
      slug: `jbl-charge-6-${uid()}`,
      status: "pending",
    });
    created.models.push(pendingModel.id);

    // draft với model pending — draft path KHÔNG check model (chỉ submit mới check)
    await login(sellerId);
    const draftId = parseDraftId(await expectRedirect(() =>
      saveListingDraftAction({}, betaForm(cat, {
        productModelId: pendingModel.id,
        images: [`/uploads/${storageKey}`],
        imageSlots: ["front"],
      })),
    ));

    // submit → MODEL_INVALID (B4 DB check: status pending ≠ approved) → redirect ?error= typed code
    const url = await expectRedirect(() => submitListingAction(fd({ listingId: draftId })));
    expect(url).toBe(`/sell/${draftId}/edit?error=MODEL_INVALID`);
    expect((await db.orm.public.Listing.first({ id: draftId }))!.status).toBe("draft");

    // model sai brand: model của brand khác + brandId form = brand khác → MODEL_BRAND_MISMATCH
    const otherBrand = await db.orm.public.Brand.create({ name: `Bose ${uid()}`, slug: `bose-${uid()}` });
    created.brands.push(otherBrand.id);
    const state = await createListingAction({}, betaForm(cat, {
      brandId: otherBrand.id, // productModelId = cat.modelId (brand JBL) ≠ Bose
      images: [`/uploads/${storageKey}`],
      imageSlots: ["front"],
    }));
    expect(state.error).toContain("MODEL_BRAND_MISMATCH");
    expect(await db.orm.public.Listing.where({ sellerId }).all()).toHaveLength(1); // chỉ draft
  });

  // ─── 8. Transaction no-silent-success (item 8 — 23505 classify NGOÀI tx) ──

  it("Listing.slug 23505 BÊN TRONG tx create → THROW ra khỏi callback, classify NGOÀI — typed LISTING_SLUG_COLLISION, KHÔNG partial rows", async () => {
    const sellerId = await mkVerifiedSeller();
    const blockerSellerId = await mkUser("seller"); // chủ row slug-blocker (tx T2)
    created.users.push(sellerId, blockerSellerId);
    const cat = await mkBetaCatalog();
    const storageKey = await mkUploadRow(sellerId);

    // Tiêu đề UNIQUE mỗi run (uid) — slug S độc lập với residue của case khác/
    // file khác (pre-assert slug sạch không phụ thuộc thứ tự dọn của ai).
    const title = `Loa JBL Charge 5 chính hãng ${uid()}`;
    const slugS = slugify(title); // cùng hàm action dùng
    expect(await db.orm.public.Listing.first({ slug: slugS })).toBeNull(); // slug sạch

    // T2 = tx giữ unique-index entry slug S (CHƯA commit — MVCC: pre-check slug
    // của action KHÔNG thấy row, unique index THẤY → INSERT của action block
    // trên entry của T2 → T2 commit → 23505). Barrier pattern như
    // listing-submit-approve-race.test.ts.
    let signalLockTaken!: () => void;
    const lockTaken = new Promise<void>((r) => {
      signalLockTaken = r;
    });
    let commitT2!: () => void;
    let blockerListingId = "";
    const t2 = db.transaction(async (tx) => {
      const blocker = await tx.orm.public.Listing.create({
        sellerId: blockerSellerId,
        categoryId: cat.categoryId,
        title,
        slug: slugS,
        description: "row slug-blocker của tx T2",
        condition: "good",
        price: 1,
        status: "draft",
        city: "Hà Nội",
      });
      blockerListingId = blocker.id;
      signalLockTaken(); // unique-index entry đã giữ, tx vẫn mở
      await new Promise<void>((r) => {
        commitT2 = r;
      });
    });
    await lockTaken;

    // Flow = createListingAction của seller: pre-check slug (MVCC — KHÔNG thấy
    // T2) → gate pass (seller verified + content hợp lệ) → tx: Listing.create
    // (slug S) BLOCK trên unique index của T2.
    await login(sellerId);
    const flow = createListingAction({}, betaForm(cat, {
      title,
      images: [`/uploads/${storageKey}`],
      imageSlots: ["front"],
    }));
    await sleep(600); // cho flow qua pre-check + gate, chạm INSERT đang block
    commitT2();
    await t2;

    // 23505 → THROW ra khỏi callback (Postgres abort tx) → wrapper COMMIT =
    // ROLLBACK → classify NGOÀI tx (isListingSlugCollision) → typed form error
    // — KHÔNG catch-and-return trong callback (silent-success bug).
    const state = await flow;
    expect(state.error).toContain("LISTING_SLUG_COLLISION");

    // T2 commit → row slug-blocker là row DUY NHẤT slug S; action KHÔNG tạo listing nào
    const mine = await db.orm.public.Listing.where({ sellerId }).all();
    expect(mine).toHaveLength(0);
    const blocker = await db.orm.public.Listing.first({ slug: slugS });
    expect(blocker).not.toBeNull();
    expect(blocker!.sellerId).toBe(blockerSellerId);

    // KHÔNG partial rows: ListingImage (FK listingId — cascade) không thể tồn
    // tại không có listing; PriceHistory (modelId) — action sẽ ghi kind
    // "listed" nếu tx KHÔNG rollback → 0 row chứng minh rollback toàn bộ.
    const images = await db.orm.public.ListingImage.where({ listingId: blockerListingId }).all();
    expect(images).toHaveLength(0);
    const priceRows = await db.orm.public.PriceHistory.where({ modelId: cat.modelId }).all();
    expect(priceRows).toHaveLength(0);
  });
});
