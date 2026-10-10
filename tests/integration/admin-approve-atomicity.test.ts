/**
 * Admin approve/reject — audit ATOMIC với state change (Batch 4 holistic
 * review fix — CONFIRMED LOW tx-concurrency) — REAL-DB integration test.
 * Chạy trên scratch DB (scripts/test-integration.sh) — KHÔNG chạy trong
 * `npm test`.
 *
 * Root cause (trước fix): CAS updateAll commit listing approved TRƯỚC, rồi
 * `audit()` (AdminAuditLog) + `auditEvent()` (AuditEvent listing.approved)
 * chạy SAU commit trên global db — audit fail (transient DB error, pool
 * exhaustion, headers()/HMAC fail) → listing approved KHÔNG có audit row,
 * notify không chạy, admin thấy error page cho action đã thành công. Retry
 * hit `status !== "pending"` → silent return → audit gap VĨNH VIỄN.
 *
 * Fix: claim + AdminAuditLog (auditTx) + AuditEvent (auditEventTx) trong
 * MỘT db.transaction — audit fail → ROLLBACK TOÀN BỘ (không approve). Test
 * này ép audit fail (mock auditEventTx throw) trên DB THẬT và chứng minh
 * rollback: listing GIỮ pending, KHÔNG AdminAuditLog row.
 *
 * Mock: chỉ `@/src/lib/audit-event` (ép auditEventTx throw) — db/session/
 * rbac/policy/publication gate là THẬT như listing-submit-approve-race.test.ts.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// Ép auditEventTx throw — mô phỏng transient audit failure (pool exhaustion /
// headers HMAC fail). auditEvent (non-tx) giữ nguyên — các block path vẫn audit.
vi.mock("@/src/lib/audit-event", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/audit-event")>();
  return {
    ...actual,
    auditEventTx: vi.fn(async () => {
      throw new Error("AUDIT_WRITE_FAILED (simulated transient failure)");
    }),
  };
});

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
import { approveListingAction } from "../../src/lib/actions/admin";

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const PASSWORD_HASH = bcrypt.hashSync("integration-password-123", 10);

let seq = 0;
const uid = (): string => `b4-atomic-${Date.now()}-${seq++}`;

const fd = (entries: Record<string, string>): FormData => {
  const form = new FormData();
  for (const [k, v] of Object.entries(entries)) form.set(k, v);
  return form;
};

const login = async (userId: string, opts?: { isAdmin?: boolean }): Promise<void> => {
  cookieState.store.clear();
  await createSession(userId, opts);
};

const created = {
  users: [] as string[],
  categories: [] as string[],
  brands: [] as string[],
  models: [] as string[],
  listings: [] as string[],
};

async function mkVerifiedSeller(): Promise<string> {
  const now = new Date().toISOString();
  const u = await db.orm.public.User.create({
    email: `${uid()}@integration.test`,
    passwordHash: PASSWORD_HASH,
    name: "B4 Atomic Seller",
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

async function mkAdmin(): Promise<string> {
  const u = await db.orm.public.User.create({
    email: `${uid()}@integration.test`,
    passwordHash: PASSWORD_HASH,
    name: "B4 Atomic Admin",
    role: "admin",
    adminRole: "operations_admin",
  });
  return u.id;
}

async function mkBetaCatalog(): Promise<{ categoryId: string; brandId: string; modelId: string }> {
  const cat = await db.orm.public.Category.create({
    name: `Loa Bluetooth di động ${uid()}`,
    slug: "portable_bluetooth_speaker",
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

async function seedPendingListing(
  sellerId: string,
  cat: { categoryId: string; brandId: string; modelId: string },
): Promise<string> {
  const listing = await db.orm.public.Listing.create({
    sellerId,
    categoryId: cat.categoryId,
    brandId: cat.brandId,
    productModelId: cat.modelId,
    title: "Loa JBL Charge 5 chính hãng",
    slug: `it-atomic-${uid()}`,
    description: "Loa bluetooth cũ còn tốt, pin trâu, nghe hay.",
    condition: "good",
    price: 1_800_000,
    negotiable: false,
    acceptExchange: false,
    status: "pending",
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
  for (const id of created.users) {
    await db.orm.public.AuditEvent.where({ actorId: id }).deleteAll();
    await db.orm.public.AuditEvent.where({ subjectId: id }).deleteAll();
  }
  for (const id of created.users) {
    await db.orm.public.AdminAuditLog.where({ adminId: id }).deleteAll();
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

d("approveListingAction — audit fail trong tx → ROLLBACK toàn bộ (Batch 4 holistic LOW)", () => {
  it("auditEventTx throw SAU claim → tx rollback: listing GIỮ pending, KHÔNG AdminAuditLog, KHÔNG AuditEvent approved", async () => {
    const sellerId = await mkVerifiedSeller();
    const adminId = await mkAdmin();
    created.users.push(sellerId, adminId);
    const cat = await mkBetaCatalog();
    created.categories.push(cat.categoryId);
    created.brands.push(cat.brandId);
    created.models.push(cat.modelId);
    const listingId = await seedPendingListing(sellerId, cat);
    created.listings.push(listingId);

    // Review card đọc version (updatedAt) — post ĐÚNG version (gate pass).
    const cardRow = await db.orm.public.Listing.first({ id: listingId });
    await login(adminId, { isAdmin: true });

    // auditEventTx (mock) throw BÊN TRONG tx — SAU claim, TRƯỚC commit →
    // toàn tx rollback (fail closed VISIBLE — KHÔNG masquerade no-op).
    await expect(
      approveListingAction(fd({ listingId, version: cardRow!.updatedAt })),
    ).rejects.toThrowError(/AUDIT_WRITE_FAILED/);

    // Listing GIỮ pending — approved-missing-audit KHÔNG xảy ra (đã rollback)
    const listing = await db.orm.public.Listing.first({ id: listingId });
    expect(listing!.status).toBe("pending");

    // KHÔNG AdminAuditLog row (auditTx cũng rollback cùng tx)
    const adminLog = await db.orm.public.AdminAuditLog
      .where({ action: "approve_listing", entityId: listingId })
      .all();
    expect(adminLog).toHaveLength(0);

    // KHÔNG AuditEvent listing.approved
    const approved = await db.orm.public.AuditEvent
      .where({ action: "listing.approved", resourceId: listingId })
      .all();
    expect(approved).toHaveLength(0);
  });
});
