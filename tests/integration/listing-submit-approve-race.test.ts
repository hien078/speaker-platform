/**
 * Listing submit/approve — gate-then-claim TOCTOU (MEDIUM 1 review fix) —
 * REAL-DB race integration test. Chạy trên scratch DB
 * (scripts/test-integration.sh) — KHÔNG chạy trong `npm test`.
 *
 * Root cause (trước fix): submit/approve gate trên content C0 đọc NGOÀI tx,
 * rồi claim `.where({ id, status })` — saveListingDraftAction (draft) /
 * updateListingAction (pending) commit content C1 lenient GIỮA read và claim,
 * status không đổi → claim vẫn match → C1 vào pending/approved UNGATED
 * (content chưa bao giờ được review).
 *
 * Fix: claim CAS thêm `updatedAt` (optimistic version) đọc TRƯỚC gate.
 * Verification (node_modules/@prisma/orm-family-sql + contract.json +
 * probe trên DB thật):
 *  - `Listing.updatedAt` có execution default `onUpdate: timestampNow`
 *    (contract.json execution/mutations/defaults) → MỌI Listing
 *    update/updateAll tự bump updatedAt — hai đường content write
 *    (draft save, update) đều chạy Listing.updateAll trong cùng tx nên
 *    image-only change cũng bump (ListingImage write KHÔNG bump cha —
 *    không trigger, nhưng luôn đi kèm Listing.updateAll).
 *  - Codec `pg/timestamptz-string@1`: input/output ĐỀU string — giá trị đọc
 *    từ row (text Postgres, vd "2026-10-07 13:57:15.538+00") round-trip
 *    CHÍNH XÁC qua WHERE equality (DB cast text→timestamptz cùng instant) —
 *    KHÔNG so sánh JS Date, KHÔNG vấn đề precision µs vs ms → KHÔNG cần
 *    cột version mới (không migration).
 *
 * Chứng minh NGỮ ĐÓ against DB THẬT + ORM THẬT với hai connection (tx đổi
 * content giữ row lock + action) và barrier row lock (pattern
 * listing-delete-race.test.ts):
 *
 *  1. SUBMIT RACE: draft-save tx giữ row lock (content swap, chưa commit) →
 *     submitListingAction đọc draft CŨ (MVCC) → gate pass → CAS
 *     `.where({ id, status: "draft", updatedAt: U0 })` chờ lock → tx commit
 *     (updatedAt bump U1) → CAS re-evaluate → 0 rows → redirect
 *     ?error=CONCURRENT_CHANGE → listing GIỮ draft, content MỚI KHÔNG vào
 *     pending ungated, KHÔNG audit listing.submitted.
 *  2. APPROVE RACE: update tx giữ row lock trên listing pending (content
 *     swap, status giữ pending) → approveListingAction đọc CŨ (MVCC) →
 *     checkListingPublication pass → CAS chờ lock → tx commit → 0 rows →
 *     KHÔNG approve + audit listing.approve_blocked reason
 *     "listing_changed_during_review" → listing GIỮ pending.
 *  3. HAPPY PATH (round-trip proof): không race → CAS theo updatedAt đọc
 *     trước gate MATCH (string Postgres cast lại cùng instant) → submit
 *     draft→pending + approve pending→approved nguyên vẹn.
 *
 * next/headers mock (cookie store điều khiển được — requireUser cần cookies()
 * ngoài request scope); next/cache mock (revalidatePath); next/navigation mock
 * (redirect throw NEXT_REDIRECT). Phần DB/session/rbac/policy/audit là thật.
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
}));

import { db } from "../../src/prisma/db.client";
import { createSession } from "../../src/lib/session";
import { resetRateLimits } from "../../src/lib/rate-limit";
import { submitListingAction } from "../../src/lib/actions/listings";
import { approveListingAction } from "../../src/lib/actions/admin";

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const PASSWORD_HASH = bcrypt.hashSync("integration-password-123", 10);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let seq = 0;
const uid = (): string => `b4-race-${Date.now()}-${seq++}`;

const fd = (entries: Record<string, string>): FormData => {
  const form = new FormData();
  for (const [k, v] of Object.entries(entries)) form.set(k, v);
  return form;
};

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

const created = {
  users: [] as string[],
  categories: [] as string[],
  brands: [] as string[],
  models: [] as string[],
  listings: [] as string[],
};

/** Seller ĐỦ 8 yêu cầu policy v1 (seed trực tiếp — không qua action verification). */
async function mkVerifiedSeller(): Promise<string> {
  const now = new Date().toISOString();
  const u = await db.orm.public.User.create({
    email: `${uid()}@integration.test`,
    passwordHash: PASSWORD_HASH,
    name: "B4 Race Seller",
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
  const u = await db.orm.public.User.create({
    email: `${uid()}@integration.test`,
    passwordHash: PASSWORD_HASH,
    name: "B4 Race Admin",
    role: "admin",
    adminRole: "operations_admin",
  });
  return u.id;
}

/** Catalog beta: category (slug §5.6.1 verbatim) + brand + model approved. */
async function mkBetaCatalog(): Promise<{ categoryId: string; brandId: string; modelId: string }> {
  const cat = await db.orm.public.Category.create({
    name: `Loa Bluetooth di động ${uid()}`,
    slug: "portable_bluetooth_speaker", // BETA_PUBLICATION_CATEGORIES — slug CHUẨN, KHÔNG suffix
    commissionRate: 5,
    sortOrder: 0,
    isActive: true,
  });
  const brand = await db.orm.public.Brand.create({
    name: `JBL ${uid()}`,
    slug: `jbl-${uid()}`,
  });
  const model = await db.orm.public.ProductModel.create({
    brandId: brand.id,
    categoryId: cat.id,
    name: `Charge 5 ${uid()}`,
    slug: `jbl-charge-5-${uid()}`,
    status: "approved",
  });
  return { categoryId: cat.id, brandId: brand.id, modelId: model.id };
}

/**
 * Listing structured beta đầy đủ (status caller đặt) + 1 ảnh gắn
 * (/uploads/<không-uuid>.jpg — rule 2 attached compat, pattern path sạch).
 */
async function seedListing(
  sellerId: string,
  status: "draft" | "pending",
  cat: { categoryId: string; brandId: string; modelId: string },
): Promise<string> {
  const listing = await db.orm.public.Listing.create({
    sellerId,
    categoryId: cat.categoryId,
    brandId: cat.brandId,
    productModelId: cat.modelId,
    title: "Loa JBL Charge 5 chính hãng",
    slug: `it-listing-${uid()}`,
    description: "Loa bluetooth cũ còn tốt, pin trâu, nghe hay.",
    condition: "good",
    price: 1_800_000,
    negotiable: false,
    acceptExchange: false,
    status,
    city: "Hà Nội",
    inventoryContext: "used",
    includedAccessories: null,
    knownDefects: null,
    repairHistory: null,
    fulfillmentMethods: ["meetup"],
    provinceLevelCode: "ha-noi",
    communeLevelCode: null,
    locationDisplayName: "Khu vực Cầu Giấy",
  });
  await db.orm.public.ListingImage.create({
    listingId: listing.id,
    url: `/uploads/it-${uid()}.jpg`,
    sortOrder: 0,
    checklistSlot: "front",
  });
  return listing.id;
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AUTH_SECRET", "integration-auth-secret-0123456789abcdef");
  resetRateLimits();
  cookieState.store.clear();
});

afterEach(async () => {
  // Dọn FK-safe: AuditEvent (SetNull nhưng xoá sạch) → Listing (cascade ảnh)
  // → ProductModel/Brand/Category → SellerVerification (FK Restrict — PHẢI
  // xoá trước User) → User (cascade session/policy-acceptance/membership/
  // notification).
  for (const id of created.users) {
    await db.orm.public.AuditEvent.where({ actorId: id }).deleteAll();
    await db.orm.public.AuditEvent.where({ subjectId: id }).deleteAll();
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
    // SellerVerification.userId FK Restrict (contract) — xoá TRƯỚC User
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
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.close();
});

// ─── 1. SUBMIT RACE — draft-save tx giữ row lock, submit chạy song song ──────

d("submitListingAction vs concurrent draft-save — REAL-DB race (MEDIUM 1)", () => {
  it("content swap commit GIỮA gate và claim → CAS updatedAt 0 rows → ?error=CONCURRENT_CHANGE, listing GIỮ draft, KHÔNG audit submitted", async () => {
    const sellerId = await mkVerifiedSeller();
    created.users.push(sellerId);
    const cat = await mkBetaCatalog();
    created.categories.push(cat.categoryId);
    created.brands.push(cat.brandId);
    created.models.push(cat.modelId);
    const listingId = await seedListing(sellerId, "draft", cat);
    created.listings.push(listingId);
    await login(sellerId);

    // T2 = draft-save tx (hiệu ứng DB: content swap — updateAll TỰ BUMP
    // updatedAt theo execution default onUpdate timestampNow) — mở tx, UPDATE
    // lấy row lock, CHƯA commit → tx giữ lock park lại.
    let signalLockTaken!: () => void;
    const lockTaken = new Promise<void>((r) => {
      signalLockTaken = r;
    });
    let commitT2!: () => void;
    const t2 = db.transaction(async (tx) => {
      await tx.orm.public.Listing
        .where({ id: listingId })
        .updateAll({ title: "Loa JBL Charge 5 chính hãng CONTENT MỚI CHƯA GATE" });
      signalLockTaken(); // lock đang giữ, tx vẫn mở
      await new Promise<void>((r) => {
        commitT2 = r;
      });
    });
    await lockTaken;

    // Flow = submitListingAction của seller: đọc draft (MVCC — T2 chưa commit
    // → thấy content CŨ + updatedAt U0), gate pass (content cũ hợp lệ), CAS
    // `.where({ id, status: "draft", updatedAt: U0 })` BLOCK trên row lock.
    const flow = expectRedirect(() => submitListingAction(fd({ listingId })));
    // cho flow kịp chạm write — nó KHÔNG THỂ qua được lock của T2, sau sleep
    // chắc chắn đang block (select của nó đã thấy draft + U0 cũ).
    await sleep(500);
    // T2 commit TRƯỚC khi await flow — flow đang block TRÊN row lock của T2.
    commitT2();
    await t2;

    // CAS re-evaluate WHERE sau khi lock thả → updatedAt đã bump ≠ U0 → 0 rows
    // → LISTING_CONCURRENT_CHANGE → classify NGOÀI tx → redirect typed code.
    const url = await flow;
    expect(url).toBe(`/sell/${listingId}/edit?error=CONCURRENT_CHANGE`);

    // Listing GIỮ draft — content MỚI (T2) KHÔNG vào pending ungated
    const listing = await db.orm.public.Listing.first({ id: listingId });
    expect(listing!.status).toBe("draft");
    expect(listing!.title).toBe("Loa JBL Charge 5 chính hãng CONTENT MỚI CHƯA GATE");

    // KHÔNG audit listing.submitted — tx throw trước auditEventTx
    const submitted = await db.orm.public.AuditEvent
      .where({ action: "listing.submitted", resourceId: listingId })
      .all();
    expect(submitted).toHaveLength(0);
  });
});

// ─── 2. APPROVE RACE — update tx giữ row lock trên pending ───────────────────

d("approveListingAction vs concurrent content update — REAL-DB race (MEDIUM 1)", () => {
  it("content swap commit GIỮA review và claim → CAS updatedAt 0 rows → KHÔNG approve + audit reason 'listing_changed_during_review', listing GIỮ pending", async () => {
    const sellerId = await mkVerifiedSeller();
    const adminId = await mkAdmin();
    created.users.push(sellerId, adminId);
    const cat = await mkBetaCatalog();
    created.categories.push(cat.categoryId);
    created.brands.push(cat.brandId);
    created.models.push(cat.modelId);
    const listingId = await seedListing(sellerId, "pending", cat);
    created.listings.push(listingId);

    // T2 = updateListingAction tx (hiệu ứng DB: content swap trên pending,
    // status GIỮ pending — updateAll tự bump updatedAt).
    let signalLockTaken!: () => void;
    const lockTaken = new Promise<void>((r) => {
      signalLockTaken = r;
    });
    let commitT2!: () => void;
    const t2 = db.transaction(async (tx) => {
      await tx.orm.public.Listing
        .where({ id: listingId })
        .updateAll({ title: "Loa JBL Charge 5 chính hãng CONTENT MỚI CHƯA REVIEW" });
      signalLockTaken();
      await new Promise<void>((r) => {
        commitT2 = r;
      });
    });
    await lockTaken;

    // Flow = approveListingAction của admin: đọc pending (MVCC — content CŨ),
    // checkListingPublication pass (content cũ hợp lệ), CAS
    // `.where({ id, status: "pending", updatedAt: U0 })` BLOCK trên row lock.
    await login(adminId, { isAdmin: true });
    const flow = (async () => {
      await approveListingAction(fd({ listingId }));
    })();
    await sleep(500);
    commitT2();
    await t2;
    await flow;

    // CAS 0 rows → re-read: row VẪN pending (chỉ content đổi) → KHÔNG approve
    // + audit listing.approve_blocked reason listing_changed_during_review.
    const listing = await db.orm.public.Listing.first({ id: listingId });
    expect(listing!.status).toBe("pending"); // KHÔNG approve content chưa review
    expect(listing!.title).toBe("Loa JBL Charge 5 chính hãng CONTENT MỚI CHƯA REVIEW");

    const blocked = await db.orm.public.AuditEvent
      .where({ action: "listing.approve_blocked", resourceId: listingId })
      .all();
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.reason).toBe("listing_changed_during_review");
    expect(blocked[0]!.actorId).toBe(adminId);

    // KHÔNG có event approved cho lần này
    const approved = await db.orm.public.AuditEvent
      .where({ action: "listing.approved", resourceId: listingId })
      .all();
    expect(approved).toHaveLength(0);
  });
});

// ─── 3. HAPPY PATH — CAS updatedAt round-trip khi KHÔNG race ─────────────────

d("submit + approve happy path — CAS updatedAt MATCH khi không race (round-trip proof)", () => {
  it("submit draft→pending (CAS match) + approve pending→approved (CAS match) — updatedAt string Postgres cast lại CÙNG instant", async () => {
    const sellerId = await mkVerifiedSeller();
    const adminId = await mkAdmin();
    created.users.push(sellerId, adminId);
    const cat = await mkBetaCatalog();
    created.categories.push(cat.categoryId);
    created.brands.push(cat.brandId);
    created.models.push(cat.modelId);
    const listingId = await seedListing(sellerId, "draft", cat);
    created.listings.push(listingId);

    // submit: đọc row (updatedAt U0 dạng text Postgres) → gate → CAS
    // `.where({ id, status: "draft", updatedAt: U0 })` — không ai viết giữa
    // chừng → string U0 cast lại CÙNG instant → MATCH → pending.
    await login(sellerId);
    await submitListingAction(fd({ listingId }));

    let listing = await db.orm.public.Listing.first({ id: listingId });
    expect(listing!.status).toBe("pending");
    const submitted = await db.orm.public.AuditEvent
      .where({ action: "listing.submitted", resourceId: listingId })
      .all();
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.policyVersion).toBe("v1"); // SELLER_RULES_POLICY_VERSION

    // approve: đọc pending (updatedAt U1) → checkListingPublication → CAS
    // `.where({ id, status: "pending", updatedAt: U1 })` → MATCH → approved.
    await login(adminId, { isAdmin: true });
    await approveListingAction(fd({ listingId }));

    listing = await db.orm.public.Listing.first({ id: listingId });
    expect(listing!.status).toBe("approved");
    expect(listing!.rejectionReason).toBeNull();
    const approvedEvt = await db.orm.public.AuditEvent
      .where({ action: "listing.approved", resourceId: listingId })
      .all();
    expect(approvedEvt).toHaveLength(1);
  });
});
