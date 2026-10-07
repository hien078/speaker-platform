/**
 * Publication gate — BỐN transition surfaces (plan Task 10, spec §4.4/§4.9/
 * §7.3 Review Focus 2) — unit tests.
 *
 * MỘT tin đăng không thể chuyển vào duyệt/công khai trừ khi seller thỏa
 * Seller Verification Policy v1 (7 yêu cầu, đọc FRESH từ DB). Cả BỐN đường:
 *  1. createListingAction (seller → pending)
 *  2. updateListingAction (seller content-change approved/rejected → pending)
 *  3. toggleListingVisibilityAction (seller hidden → approved)
 *  4. approveListingAction (ADMIN duyệt pending → approved — defense-in-depth)
 * đều đi qua CÙNG assertSellerPublicationAllowed/checkSellerPublicationRequirements
 * — kể cả khi gọi bởi admin (spec §7.3 revoked-seller publication bypass).
 *
 * Hợp đồng (plan Task 10 Step 1):
 *  - createListingAction: seller chưa xác minh → typed error liệt kê yêu cầu
 *    thiếu, KHÔNG Listing.create (spec §4.4 — không transition vào review).
 *  - updateListingAction: content-change → pending BỊ CHẶN cho seller bị
 *    revoke verification (status + nội dung giữ nguyên).
 *  - toggleListingVisibilityAction: hidden → approved chặn cho seller bị
 *    suspend founding_seller membership (silent return, status unchanged).
 *  - approveListingAction (admin): duyệt tin của seller mất verification →
 *    KHÔNG approve + audit "listing.approve_blocked" (defense-in-depth).
 *  - CẢ BỐN pass khi seller thỏa policy (create→pending, update→pending,
 *    hidden→approved, admin approve→approved + audit "listing.approved").
 *
 * Cơ chế mock như seller-verification-actions.test.ts: session/rbac/policy
 * GIỮ BẢN THẬT (login qua COOKIE THẬT, gate đọc FRESH từ store mock);
 * db.client in-memory đủ model cho 4 action (Listing/ListingImage/Category/
 * SellerVerification/PolicyAcceptance/BetaCohortMembership/AuditEvent/
 * AdminAuditLog/Notification/User/UserSession).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

const headerState = vi.hoisted(() => ({ headers: new Headers() }));
const cookieState = vi.hoisted(() => ({ store: new Map<string, string>() }));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => headerState.headers),
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

// ─── db.client mock — in-memory đủ model cho 4 transition surface ─────────────

const dbState = vi.hoisted(() => ({
  users: [] as Array<Record<string, unknown>>,
  sessions: [] as Array<Record<string, unknown>>,
  listings: [] as Array<Record<string, unknown>>,
  images: [] as Array<Record<string, unknown>>,
  categories: [] as Array<Record<string, unknown>>,
  brands: [] as Array<Record<string, unknown>>,
  models: [] as Array<Record<string, unknown>>,
  uploads: [] as Array<Record<string, unknown>>,
  priceHistory: [] as Array<Record<string, unknown>>,
  verifications: [] as Array<Record<string, unknown>>,
  acceptances: [] as Array<Record<string, unknown>>,
  memberships: [] as Array<Record<string, unknown>>,
  suspensions: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
  adminAudits: [] as Array<Record<string, unknown>>,
  notifications: [] as Array<Record<string, unknown>>,
  orderItems: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/src/prisma/db.client", () => {
  type Row = Record<string, unknown>;
  type Pred = ((proxy: unknown) => unknown) | Row;

  const fieldOps = (row: Row) =>
    new Proxy(
      {},
      {
        get: (_t, field: string) => ({
          eq: (v: unknown) => row[field] === v,
          neq: (v: unknown) => row[field] !== v,
          lt: (v: unknown) => (row[field] as number) < (v as number),
          lte: (v: unknown) => (row[field] as number) <= (v as number),
          gt: (v: unknown) => (row[field] as number) > (v as number),
          gte: (v: unknown) => (row[field] as number) >= (v as number),
          isNull: () => row[field] === null,
          isNotNull: () => row[field] !== null,
        }),
      },
    );

  const matches = (row: Row, pred: Pred): boolean =>
    typeof pred === "function"
      ? Boolean(pred(fieldOps(row)))
      : Object.entries(pred).every(([k, v]) => row[k] === v);

  const makeModel = (rows: Row[], defaults?: () => Row, attach?: (row: Row) => void) => {
    const query = (preds: Pred[], includeRel?: string) => ({
      where: (pred: Pred) => query([...preds, pred], includeRel),
      include: (rel: string) => query(preds, rel),
      orderBy: () => query(preds, includeRel),
      first: async (filter?: Pred) => {
        const all = [...preds, ...(filter ? [filter] : [])];
        const hit = rows.find((r) => all.every((p) => matches(r, p)));
        if (!hit) return null;
        const copy = { ...hit };
        if (includeRel === "user" && attach) attach(copy);
        return copy;
      },
      all: async () =>
        rows
          .filter((r) => preds.every((p) => matches(r, p)))
          .map((r) => {
            const copy = { ...r };
            if (includeRel === "user" && attach) attach(copy);
            return copy;
          }),
      update: async (data: Row) => {
        const hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        if (hit.length === 0) return null;
        Object.assign(hit[0]!, data);
        return { ...hit[0]! };
      },
      updateAll: async (data: Row) => {
        const hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        for (const r of hit) Object.assign(r, data);
        return hit.map((r) => ({ ...r }));
      },
      delete: async () => {
        const hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        for (const r of hit) {
          const i = rows.indexOf(r);
          if (i >= 0) rows.splice(i, 1);
        }
        return hit.map((r) => ({ ...r }));
      },
      deleteAll: async () => {
        // applyImageDiff (listings.ts) xoá ảnh bỏ qua deleteAll — mock fidelity
        const hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        for (const r of hit) {
          const i = rows.indexOf(r);
          if (i >= 0) rows.splice(i, 1);
        }
        return hit.map((r) => ({ ...r }));
      },
      create: async (data: Row) => {
        const row = { ...(defaults?.() ?? { id: `row-${rows.length + 1}` }), ...data };
        rows.push(row);
        return { ...row };
      },
    });
    return {
      first: (filter?: Pred) => query([]).first(filter),
      all: () => query([]).all(),
      where: (pred: Pred) => query([pred]),
      include: (rel: string) => query([], rel),
      orderBy: () => query([]),
      create: (data: Row) => query([]).create(data),
    };
  };

  const models = {
    User: makeModel(dbState.users, () => ({ id: `user-${dbState.users.length + 1}` })),
    UserSession: makeModel(dbState.sessions, () => ({
      id: `sess-${dbState.sessions.length + 1}`,
      createdAt: new Date().toISOString(),
      lastSeenAt: null,
      revokedAt: null,
      revokedReason: null,
      steppedUpAt: null,
      isAdmin: false,
      userAgent: null,
    }), (row) => {
      row["user"] = dbState.users.find((u) => u["id"] === row["userId"]) ?? null;
    }),
    Listing: makeModel(dbState.listings, () => ({
      id: `listing-${dbState.listings.length + 1}`,
      viewCount: 0,
      negotiable: false,
      acceptExchange: false,
      rejectionReason: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
    ListingImage: makeModel(dbState.images, () => ({
      id: `img-${dbState.images.length + 1}`,
      sortOrder: 0,
      checklistSlot: null,
    })),
    Category: makeModel(dbState.categories, () => ({
      id: `cat-${dbState.categories.length + 1}`,
      commissionRate: 5,
      sortOrder: 0,
      isActive: true,
      createdAt: new Date().toISOString(),
    })),
    Brand: makeModel(dbState.brands, () => ({
      id: `brand-${dbState.brands.length + 1}`,
      logoUrl: null,
      createdAt: new Date().toISOString(),
    })),
    ProductModel: makeModel(dbState.models, () => ({
      id: `model-${dbState.models.length + 1}`,
      releaseYear: null,
      description: null,
      specs: null,
      image: null,
      status: "approved",
      mergedIntoId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
    ListingImageUpload: makeModel(dbState.uploads, () => ({
      id: `up-${dbState.uploads.length + 1}`,
      bytes: 1024,
      width: 800,
      height: 600,
      createdAt: new Date().toISOString(),
    })),
    PriceHistory: makeModel(dbState.priceHistory, () => ({
      id: `ph-${dbState.priceHistory.length + 1}`,
      createdAt: new Date().toISOString(),
    })),
    SellerVerification: makeModel(dbState.verifications, () => ({
      id: `sv-${dbState.verifications.length + 1}`,
      method: "operations_review",
      submittedAt: null,
      reviewedAt: null,
      reviewerId: null,
      reasonCode: null,
      note: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
    PolicyAcceptance: makeModel(dbState.acceptances, () => ({
      id: `pa-${dbState.acceptances.length + 1}`,
      acceptedAt: new Date().toISOString(),
    })),
    BetaCohortMembership: makeModel(dbState.memberships, () => ({
      id: `bcm-${dbState.memberships.length + 1}`,
      invitedBy: null,
      invitedAt: null,
      acceptedAt: null,
      expiresAt: null,
      notes: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
    AuditEvent: makeModel(dbState.audits, () => ({
      id: `audit-${dbState.audits.length + 1}`,
      createdAt: new Date().toISOString(),
    })),
    AdminAuditLog: makeModel(dbState.adminAudits, () => ({
      id: `aal-${dbState.adminAudits.length + 1}`,
      createdAt: new Date().toISOString(),
    })),
    Notification: makeModel(dbState.notifications, () => ({
      id: `notif-${dbState.notifications.length + 1}`,
    })),
    UserSuspension: makeModel(dbState.suspensions, () => ({
      id: `susp-${dbState.suspensions.length + 1}`,
      status: "active",
      note: null,
      suspendedById: null,
      liftedById: null,
      liftedAt: null,
      liftReasonCode: null,
    })),
    OrderItem: makeModel(dbState.orderItems, () => ({
      id: `oi-${dbState.orderItems.length + 1}`,
      quantity: 1,
      price: 0,
    })),
  };
  const orm = { public: models };
  return {
    db: {
      orm,
      transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ orm: { public: { ...models } } }),
    },
  };
});

// ─── Counting wrappers (cross-module — Global Constraints recipe) ────────────
// Batch 4 Task 4 (item 1 per-path pins): create/submit/update-into-pending/toggle
// gọi assertListingPublishable ĐÚNG MỘT LẦN; non-transition update gọi
// assertListingContentValid (KHÔNG seller gate); approve gọi checkListingPublication
// MỘT LẦN. Wrapper gọi THẬT (importOriginal) — hành vi giữ nguyên, chỉ đếm.

const gateState = vi.hoisted(() => ({
  sellerGateCalls: 0,
  publishableCalls: 0,
  contentValidCalls: 0,
  checkPublicationCalls: 0,
  /** Khi ≠ null: wrapper assertListingPublishable THROW giá trị này thay vì chạy thật. */
  failPublishWith: null as string | null,
  /** Side-effect chạy khi assertListingPublishable được gọi (mô phỏng race đổi row). */
  onPublishable: null as null | (() => void),
  /** Side-effect chạy khi checkListingPublication được gọi (mô phỏng race đổi row giữa review và claim). */
  onCheckPublication: null as null | (() => void),
  /** Khi ≠ null: wrapper checkListingPublication THROW giá trị này thay vì chạy thật (lỗi infra). */
  failCheckWith: null as string | null,
}));

vi.mock("@/src/lib/seller-verification-policy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/lib/seller-verification-policy")>();
  return {
    ...actual,
    assertSellerPublicationAllowed: async (sellerId: string): Promise<void> => {
      gateState.sellerGateCalls += 1;
      return actual.assertSellerPublicationAllowed(sellerId);
    },
  };
});

vi.mock("@/src/lib/listing-publication", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/lib/listing-publication")>();
  return {
    ...actual,
    assertListingPublishable: async (input: unknown): Promise<void> => {
      gateState.publishableCalls += 1;
      gateState.onPublishable?.();
      if (gateState.failPublishWith !== null) throw new Error(gateState.failPublishWith);
      return actual.assertListingPublishable(input as never);
    },
    assertListingContentValid: async (input: unknown): Promise<void> => {
      gateState.contentValidCalls += 1;
      return actual.assertListingContentValid(input as never);
    },
    checkListingPublication: async (input: unknown): Promise<unknown> => {
      gateState.checkPublicationCalls += 1;
      gateState.onCheckPublication?.();
      if (gateState.failCheckWith !== null) throw new Error(gateState.failCheckWith);
      return actual.checkListingPublication(input as never);
    },
  };
});

import { resetRateLimits } from "@/src/lib/rate-limit";
import { SESSION_COOKIE } from "@/src/lib/session";
import {
  createListingAction,
  updateListingAction,
  toggleListingVisibilityAction,
  deleteListingAction,
  submitListingAction,
} from "@/src/lib/actions/listings";
import { approveListingAction } from "@/src/lib/actions/admin";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const sha256Hex = (v: string) => createHash("sha256").update(v).digest("hex");
type Row = Record<string, unknown>;

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (p: string): string => readFileSync(join(root, p), "utf8");

const mkUser = (over: Partial<Row>): Row & { id: string } => ({
  id: "user-x",
  email: "x@loaviet.test",
  passwordHash: "bcrypt-x",
  name: "X",
  role: "buyer",
  avatarUrl: null,
  phone: null,
  city: null,
  bio: null,
  isVerifiedSeller: false,
  adminRole: null,
  emailVerifiedAt: null,
  phoneVerifiedAt: null,
  sellerType: null,
  sellerOperatingProvinceCode: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  ...over,
});

const ADMIN_OPS = mkUser({ id: "admin-ops", email: "ops@loaviet.test", name: "Ops", role: "admin", adminRole: "operations_admin" });

/** Seller ĐỦ 8 yêu cầu policy v1 (mặc định) — case block bỏ/thay từng mảnh. */
const mkVerifiedSeller = (): Row & { id: string } =>
  mkUser({
    id: "seller-1",
    email: "seller@loaviet.test",
    name: "Seller",
    role: "seller",
    emailVerifiedAt: "2026-10-01T00:00:00.000Z",
    phoneVerifiedAt: "2026-10-01T00:00:00.000Z",
    sellerType: "individual",
    sellerOperatingProvinceCode: "ha-noi",
  });

/** Nạp seller + 3 row policy (acceptance/membership active/verification verified). */
const seedPolicyRows = (sellerId: string, over?: { membershipStatus?: string; verificationStatus?: string }): void => {
  dbState.acceptances.push({
    id: `pa-${dbState.acceptances.length + 1}`,
    userId: sellerId,
    policyKey: "seller_rules",
    policyVersion: "v1",
    acceptedAt: new Date().toISOString(),
  });
  dbState.memberships.push({
    id: `bcm-${dbState.memberships.length + 1}`,
    userId: sellerId,
    cohort: "founding_seller",
    status: over?.membershipStatus ?? "active",
    invitedBy: null,
    invitedAt: null,
    acceptedAt: null,
    expiresAt: null,
    notes: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  dbState.verifications.push({
    id: `sv-${dbState.verifications.length + 1}`,
    userId: sellerId,
    status: over?.verificationStatus ?? "verified",
    method: "operations_review",
    submittedAt: new Date().toISOString(),
    reviewedAt: new Date().toISOString(),
    reviewerId: "admin-ops",
    reasonCode: "requirements_met",
    note: null,
    policyVersion: "v1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
};

// ─── Batch 4 fixtures (Task 4 — fixture migration: happy-path category là BETA) ─

/** Ảnh upload MỚI (Batch 4) — storage key ngẫu nhiên của upload route (Task 3). */
const UUID_IMG = "00000000-0000-4000-8000-0000000000dd";
const UUID_IMG_2 = "10000000-0000-4000-8000-0000000000ee";
const IMG_URL = `/uploads/${UUID_IMG}.webp`;
const IMG_URL_2 = `/uploads/${UUID_IMG_2}.webp`;

/** Category BETA (spec §5.6.1 verbatim) — happy-path fixtures dùng slug này. */
const CATEGORY = {
  id: "cat-1",
  name: "Loa Bluetooth di động",
  slug: "portable_bluetooth_speaker",
  commissionRate: 5,
  sortOrder: 0,
  isActive: true,
  createdAt: "2026-09-01T00:00:00.000Z",
};
/** Category LEGACY (pre-Batch-4) — grandfathered cases (A10/compat). */
const CAT_LEGACY = {
  id: "cat-legacy",
  name: "Loa bluetooth",
  slug: "loa-bluetooth",
  commissionRate: 5,
  sortOrder: 1,
  isActive: true,
  createdAt: "2026-09-01T00:00:00.000Z",
};

const BRAND = { id: "brand-1", name: "JBL", slug: "jbl", logoUrl: null, createdAt: "2026-09-01T00:00:00.000Z" };
const MODEL = {
  id: "model-1",
  brandId: "brand-1",
  categoryId: CATEGORY.id,
  name: "Charge 5",
  slug: "jbl-charge-5",
  releaseYear: null,
  description: null,
  specs: null,
  image: null,
  status: "approved",
  mergedIntoId: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

/** Ảnh upload thuộc seller — rule (1) ownership pass. */
const seedUpload = (ownerUserId: string, storageKey = `${UUID_IMG}.webp`): void => {
  dbState.uploads.push({
    id: `up-${dbState.uploads.length + 1}`,
    ownerUserId,
    storageKey,
    bytes: 1024,
    width: 800,
    height: 600,
    createdAt: new Date().toISOString(),
  });
};

/** Ảnh ĐÃ GẮN vào listing (rule 2 compat + toggle/approve input từ DB row). */
const seedImage = (listingId: string, url: string, checklistSlot: string | null, sortOrder = 0): void => {
  dbState.images.push({
    id: `img-${dbState.images.length + 1}`,
    listingId,
    url,
    sortOrder,
    checklistSlot,
  });
};

/** Episode đình chỉ ACTIVE cho seller (yêu cầu thứ 8 — spec §7.8, Batch 3 Task 5). */
const seedSuspension = (userId: string): void => {
  dbState.suspensions.push({
    id: `susp-${dbState.suspensions.length + 1}`,
    userId,
    status: "active",
    reasonCode: "confirmed_abuse",
    note: null,
    suspendedById: ADMIN_OPS.id,
    suspendedAt: new Date().toISOString(),
    liftedById: null,
    liftedAt: null,
    liftReasonCode: null,
  });
};

/** Listing fixture của seller — structured beta đầy đủ + 1 ảnh gắn (slot front). */
const seedListing = (sellerId: string, status: string, over?: Partial<Row>): Row & { id: string } => {
  const row: Row & { id: string } = {
    id: `listing-${dbState.listings.length + 1}`,
    sellerId,
    categoryId: CATEGORY.id,
    brandId: BRAND.id,
    title: "Loa JBL Charge 5 chính hãng",
    slug: "loa-jbl-charge-5-chinh-hang",
    description: "Loa bluetooth cũ còn tốt, pin trâu, nghe hay.",
    condition: "good",
    price: 1_800_000,
    negotiable: false,
    acceptExchange: false,
    status,
    rejectionReason: null,
    city: "Hà Nội",
    viewCount: 0,
    productModelId: MODEL.id,
    inventoryContext: "used",
    includedAccessories: null,
    knownDefects: null,
    repairHistory: null,
    fulfillmentMethods: ["meetup"],
    provinceLevelCode: "ha-noi",
    communeLevelCode: null,
    locationDisplayName: "Khu vực Cầu Giấy",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
  dbState.listings.push(row);
  seedImage(row.id, IMG_URL, "front");
  return row;
};

const login = (user: Row, opts?: { isAdmin?: boolean }): string => {
  const id = `sess-${user.id}`;
  const token = `token-${id}`;
  dbState.sessions.push({
    id,
    userId: user.id,
    tokenHash: sha256Hex(token),
    isAdmin: opts?.isAdmin ?? false,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    lastSeenAt: null,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    revokedAt: null,
    revokedReason: null,
    steppedUpAt: null,
    userAgent: "unit-test-agent/1.0",
  });
  cookieState.store.set(SESSION_COOKIE, token);
  return id;
};

const fd = (entries: Record<string, string | string[]>): FormData => {
  const form = new FormData();
  for (const [k, v] of Object.entries(entries)) {
    if (Array.isArray(v)) for (const item of v) form.append(k, item);
    else form.set(k, v);
  }
  return form;
};

/**
 * Approve/reject formData — post ĐÚNG `version` (updatedAt) mà review card đã
 * render lúc admin đọc listing (Batch 4 holistic review fix: CAS theo version
 * ĐÃ REVIEW, không phải updatedAt đọc tươi trong action).
 */
const approveFd = (listing: Row, over?: Record<string, string>): FormData =>
  fd({ listingId: String(listing.id), version: String(listing.updatedAt), ...(over ?? {}) });

/**
 * createListing/updateListing formData HỢP LỆ (beta structured đầy đủ —
 * Task 4 fixture migration: brand/model/inventoryContext/fulfillment/province/
 * location + ảnh owned + slot; các case block chỉ đổi từng mảnh).
 */
const listingForm = (over?: Record<string, string | string[]>): FormData => {
  const form = fd({
    title: "Loa JBL Charge 5 chính hãng",
    categoryId: CATEGORY.id,
    condition: "good",
    price: "1800000",
    city: "Hà Nội",
    description: "Loa bluetooth cũ còn tốt, pin trâu, nghe hay.",
    brandId: BRAND.id,
    productModelId: MODEL.id,
    inventoryContext: "used",
    provinceLevelCode: "ha-noi",
    locationDisplayName: "Khu vực Cầu Giấy",
    fulfillmentMethods: ["meetup"],
    images: [IMG_URL],
    imageSlots: ["front"],
  });
  if (over) {
    for (const [k, v] of Object.entries(over)) {
      if (Array.isArray(v)) {
        form.delete(k);
        for (const item of v) form.append(k, item);
      } else form.set(k, v);
    }
  }
  return form;
};

/** Action kết thúc bằng redirect() → throw NEXT_REDIRECT — coi là THÀNH CÔNG. */
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

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AUTH_SECRET", "unit-test-auth-secret-0123456789abcdef");
  for (const arr of Object.values(dbState)) (arr as unknown[]).length = 0;
  gateState.sellerGateCalls = 0;
  gateState.publishableCalls = 0;
  gateState.contentValidCalls = 0;
  gateState.checkPublicationCalls = 0;
  gateState.failPublishWith = null;
  gateState.onPublishable = null;
  gateState.onCheckPublication = null;
  gateState.failCheckWith = null;
  dbState.users.push({ ...ADMIN_OPS });
  dbState.categories.push({ ...CATEGORY }, { ...CAT_LEGACY });
  dbState.brands.push({ ...BRAND });
  dbState.models.push({ ...MODEL });
  cookieState.store.clear();
  headerState.headers = new Headers();
  resetRateLimits();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── 1. createListingAction ──────────────────────────────────────────────────

describe("createListingAction — gate trước Listing.create (spec §4.4)", () => {
  it("seller CHƯA xác minh → typed error liệt kê yêu cầu thiếu, KHÔNG Listing.create", async () => {
    const seller = mkUser({ id: "seller-fresh", role: "seller" }); // không có gì cả
    dbState.users.push(seller);
    login(seller);

    const state = await createListingAction({}, listingForm());

    expect(state.error).toBeTruthy();
    // liệt kê yêu cầu thiếu (7/7) — thông báo tiếng Việt có tên yêu cầu
    expect(state.error).toContain("xác minh email");
    expect(state.error).toContain("operations review");
    expect(dbState.listings).toHaveLength(0); // spec §4.4 — không transition vào review
    expect(dbState.images).toHaveLength(0);
  });

  it("seller bị REVOKE verification → typed error, KHÔNG Listing.create (Review Focus 2)", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id, { verificationStatus: "revoked" });
    login(seller);

    const state = await createListingAction({}, listingForm());

    expect(state.error).toBeTruthy();
    expect(state.error).toContain("operations review");
    expect(dbState.listings).toHaveLength(0);
  });

  it("seller đủ policy → tạo listing status=pending (redirect /sell/my)", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    seedUpload(seller.id); // ảnh upload thuộc seller — rule (1) pass
    login(seller);

    const url = await expectRedirect(() => createListingAction({}, listingForm()));

    expect(url).toContain("/sell/my?created=1");
    expect(dbState.listings).toHaveLength(1);
    expect(dbState.listings[0]).toMatchObject({ sellerId: seller.id, status: "pending" });
    expect(dbState.images).toHaveLength(1);
  });
});

// ─── 2. updateListingAction ──────────────────────────────────────────────────

describe("updateListingAction — gate trước transition vào pending (spec §4.4)", () => {
  it("content-change → pending BỊ CHẶN cho seller bị revoke (status + nội dung giữ nguyên)", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id, { verificationStatus: "revoked" });
    const listing = seedListing(seller.id, "approved");
    login(seller);

    const state = await updateListingAction(
      {},
      listingForm({ title: "Loa JBL Charge 5 chính hãng ĐỔI TIÊU ĐỀ", listingId: listing.id }),
    );

    expect(state.error).toBeTruthy();
    expect(state.error).toContain("operations review");
    // KHÔNG transition, KHÔNG ghi đè nội dung
    expect(listing.status).toBe("approved");
    expect(listing.title).toBe("Loa JBL Charge 5 chính hãng");
  });

  it("content-change → pending pass khi seller đủ policy", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    seedUpload(seller.id);
    const listing = seedListing(seller.id, "approved");
    login(seller);

    const url = await expectRedirect(() =>
      updateListingAction(
        {},
        listingForm({ title: "Loa JBL Charge 5 chính hãng ĐỔI TIÊU ĐỀ", listingId: listing.id }),
      ),
    );

    expect(url).toContain("/sell/my?updated=1");
    expect(listing.status).toBe("pending"); // transition vào review được phép
    expect(listing.title).toBe("Loa JBL Charge 5 chính hãng ĐỔI TIÊU ĐỀ");
  });

  it("sửa KHÔNG đổi trạng thái (pending→pending) không cần gate — revoked seller vẫn sửa được tin đang chờ", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id, { verificationStatus: "revoked" });
    seedUpload(seller.id); // non-transition update vẫn validate content (item 1) — ảnh phải owned
    const listing = seedListing(seller.id, "pending");
    login(seller);

    const url = await expectRedirect(() =>
      updateListingAction(
        {},
        listingForm({ title: "Loa JBL Charge 5 chính hãng ĐỔI TIÊU ĐỀ", listingId: listing.id }),
      ),
    );

    // không transition MỚI vào review (đã ở đó) — gate không áp dụng (spec §4.4)
    expect(url).toContain("/sell/my?updated=1");
    expect(listing.status).toBe("pending");
  });
});

// ─── 3. toggleListingVisibilityAction ────────────────────────────────────────

describe("toggleListingVisibilityAction — gate hidden → approved (spec §4.4)", () => {
  it("hidden → approved BỊ CHẶN cho seller membership SUSPENDED (silent return, status unchanged)", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id, { membershipStatus: "suspended" });
    const listing = seedListing(seller.id, "hidden");
    login(seller);

    // silent return — KHÔNG throw, KHÔNG transition
    await toggleListingVisibilityAction(fd({ listingId: listing.id }));

    expect(listing.status).toBe("hidden");
  });

  it("hidden → approved pass khi seller đủ policy", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    seedUpload(seller.id); // input từ DB row — ảnh gắn phải owned
    const listing = seedListing(seller.id, "hidden");
    login(seller);

    await toggleListingVisibilityAction(fd({ listingId: listing.id }));

    expect(listing.status).toBe("approved");
  });

  it("approved → hidden (transition RA khỏi công khai) KHÔNG cần gate — revoked seller vẫn ẩn được tin", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id, { verificationStatus: "revoked" });
    const listing = seedListing(seller.id, "approved");
    login(seller);

    await toggleListingVisibilityAction(fd({ listingId: listing.id }));

    expect(listing.status).toBe("hidden"); // ẩn luôn được phép (gỡ khỏi công khai)
  });
});

// ─── 4. approveListingAction (admin) — defense-in-depth (Review Focus 2) ──────

describe("approveListingAction — gate kể cả khi gọi bởi admin (spec §7.3)", () => {
  it("seller MẤT verification → KHÔNG approve + audit 'listing.approve_blocked'", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id, { verificationStatus: "revoked" });
    const listing = seedListing(seller.id, "pending");
    login(ADMIN_OPS, { isAdmin: true });

    await approveListingAction(approveFd(listing));

    expect(listing.status).toBe("pending"); // KHÔNG approve
    const evt = dbState.audits.find((r) => r.action === "listing.approve_blocked");
    expect(evt).toMatchObject({
      actorId: ADMIN_OPS.id,
      subjectId: seller.id,
      resourceType: "Listing",
      resourceId: listing.id,
      reason: "publication_requirements_unmet",
    });
    expect(evt!.detail).toContain("operations_review_verified");
    // KHÔNG có event approved cho lần này
    expect(dbState.audits.filter((r) => r.action === "listing.approved")).toHaveLength(0);
    expect(dbState.adminAudits).toHaveLength(0); // legacy audit cũng KHÔNG ghi
  });

  it("seller membership SUSPENDED → KHÔNG approve + audit block (beta-cohort bypass đóng)", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id, { membershipStatus: "suspended" });
    const listing = seedListing(seller.id, "pending");
    login(ADMIN_OPS, { isAdmin: true });

    await approveListingAction(approveFd(listing));

    expect(listing.status).toBe("pending");
    const evt = dbState.audits.find((r) => r.action === "listing.approve_blocked");
    expect(evt!.detail).toContain("founding_seller_membership_active");
  });

  it("seller đủ policy → approve + audit 'listing.approved' + legacy audit + notify", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    seedUpload(seller.id); // checkListingPublication chạy content stage — ảnh phải owned
    const listing = seedListing(seller.id, "pending");
    login(ADMIN_OPS, { isAdmin: true });

    await approveListingAction(approveFd(listing));

    expect(listing.status).toBe("approved");
    expect(listing.rejectionReason).toBeNull();
    const evt = dbState.audits.find((r) => r.action === "listing.approved");
    expect(evt).toMatchObject({
      actorId: ADMIN_OPS.id,
      subjectId: seller.id,
      resourceType: "Listing",
      resourceId: listing.id,
    });
    expect(dbState.adminAudits[0]).toMatchObject({ adminId: ADMIN_OPS.id, action: "approve_listing" });
    expect(dbState.notifications.length).toBeGreaterThan(0);
  });

  it("listing không còn pending (đã xử lý) → no-op im lặng, KHÔNG audit block", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    const listing = seedListing(seller.id, "approved"); // đã được duyệt bởi request khác
    login(ADMIN_OPS, { isAdmin: true });

    await approveListingAction(approveFd(listing));

    expect(listing.status).toBe("approved");
    expect(dbState.audits.filter((r) => r.action === "listing.approve_blocked")).toHaveLength(0);
    expect(dbState.audits.filter((r) => r.action === "listing.approved")).toHaveLength(0);
  });
});

// ─── 5. Suspension — yêu cầu publication thứ 8 (Batch 3 Task 5, spec §7.8) ───

describe("publication gate — seller đang bị đình chỉ (spec §7.8, Review Focus 5)", () => {
  it("createListingAction: suspended seller → typed error liệt kê account_not_suspended, KHÔNG Listing.create", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id); // đủ 7 yêu cầu Batch 2
    seedSuspension(seller.id); // ...nhưng đang bị đình chỉ
    login(seller);

    const state = await createListingAction({}, listingForm());

    expect(state.error).toBeTruthy();
    // label tiếng Việt của yêu cầu thứ 8 (SELLER_PUBLICATION_REQUIREMENT_LABELS)
    expect(state.error).toContain("đình chỉ");
    // (Review fix Task 5) đình chỉ KHÔNG phải requirement "fixable" tại trang
    // xác minh — KHÔNG hướng seller sang trang đó như thể gỡ được đình chỉ ở đó.
    expect(state.error).toContain("Tài khoản đang bị đình chỉ — không thể đăng tin");
    expect(state.error).not.toContain("Xác minh người bán");
    expect(dbState.listings).toHaveLength(0); // KHÔNG transition vào review
    expect(dbState.images).toHaveLength(0);
  });

  it("updateListingAction: content-change → pending BỊ CHẶN cho suspended seller (status + nội dung giữ nguyên)", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    seedSuspension(seller.id);
    const listing = seedListing(seller.id, "approved");
    login(seller);

    const state = await updateListingAction(
      {},
      listingForm({ title: "Loa JBL Charge 5 chính hãng ĐỔI TIÊU ĐỀ", listingId: listing.id }),
    );

    expect(state.error).toBeTruthy();
    expect(state.error).toContain("đình chỉ");
    // (Review fix Task 5) special-case như create — KHÔNG hướng sang trang xác minh
    expect(state.error).toContain("Tài khoản đang bị đình chỉ — không thể đăng tin");
    expect(state.error).not.toContain("Xác minh người bán");
    expect(listing.status).toBe("approved"); // KHÔNG transition
    expect(listing.title).toBe("Loa JBL Charge 5 chính hãng"); // KHÔNG ghi đè nội dung
  });

  it("toggleListingVisibilityAction: hidden → approved BỊ CHẶN cho suspended seller (silent return, status unchanged)", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    seedSuspension(seller.id);
    const listing = seedListing(seller.id, "hidden");
    login(seller);

    // silent return — KHÔNG throw, KHÔNG transition (form void không error surface)
    await toggleListingVisibilityAction(fd({ listingId: listing.id }));

    expect(listing.status).toBe("hidden");
  });

  it("approveListingAction (admin): duyệt tin của suspended seller → KHÔNG approve + audit 'listing.approve_blocked' (defense-in-depth)", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    seedSuspension(seller.id);
    const listing = seedListing(seller.id, "pending");
    login(ADMIN_OPS, { isAdmin: true });

    await approveListingAction(approveFd(listing));

    expect(listing.status).toBe("pending"); // KHÔNG approve
    const evt = dbState.audits.find((r) => r.action === "listing.approve_blocked");
    expect(evt).toMatchObject({
      actorId: ADMIN_OPS.id,
      subjectId: seller.id,
      reason: "publication_requirements_unmet",
    });
    // detail liệt kê đúng yêu cầu thứ 8 (typed keys — KHÔNG PII)
    expect(evt!.detail).toContain("account_not_suspended");
    expect(dbState.audits.filter((r) => r.action === "listing.approved")).toHaveLength(0);
  });

  it("CẢ BỐN surface pass khi seller KHÔNG bị đình chỉ (guard không over-block)", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id); // đủ 8 (không có suspension)
    seedUpload(seller.id);
    login(seller);

    // 1. create → pending
    await expectRedirect(() => createListingAction({}, listingForm()));
    const listing = dbState.listings[0]! as Row & { id: string; status: string };
    expect(listing.status).toBe("pending");

    // 2. admin approve → approved
    login(ADMIN_OPS, { isAdmin: true });
    await approveListingAction(approveFd(listing));
    expect(listing.status).toBe("approved");

    // 3. seller content-change → pending (transition vào review được phép)
    login(seller);
    await expectRedirect(() =>
      updateListingAction(
        {},
        listingForm({ title: "Loa JBL Charge 5 chính hãng ĐỔI TIÊU ĐỀ", listingId: listing.id }),
      ),
    );
    expect(listing.status).toBe("pending");

    // 4. admin approve lại → approved; seller toggle approved→hidden→approved
    login(ADMIN_OPS, { isAdmin: true });
    await approveListingAction(approveFd(listing));
    expect(listing.status).toBe("approved");

    login(seller);
    await toggleListingVisibilityAction(fd({ listingId: listing.id }));
    expect(listing.status).toBe("hidden");
    await toggleListingVisibilityAction(fd({ listingId: listing.id }));
    expect(listing.status).toBe("approved");
  });
});

// ─── 6. B3 — content-change MỞ RỘNG: MỌI structured field/brand/model/ảnh/slot ──

describe("updateListingAction — content-change mở rộng (B3): mọi structured field đưa tin về pending", () => {
  const setupApproved = () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    seedUpload(seller.id);
    const listing = seedListing(seller.id, "approved");
    login(seller);
    return { seller, listing };
  };

  it.each([
    ["knownDefects", { knownDefects: "Có trầy xước nhẹ ở góc" }],
    ["includedAccessories", { includedAccessories: "Sạc, cáp USB-C" }],
    ["repairHistory", { repairHistory: "Thay pin tháng 3/2026" }],
    ["inventoryContext", { inventoryContext: "open_box" }],
    ["fulfillmentMethods", { fulfillmentMethods: ["carrier"] }],
    ["provinceLevelCode", { provinceLevelCode: "ho-chi-minh" }],
    ["locationDisplayName", { locationDisplayName: "Khu vực Quận 1" }],
  ])("đổi %s trên approved → pending (B3)", async (_label, over) => {
    const { listing } = setupApproved();

    const url = await expectRedirect(() =>
      updateListingAction({}, listingForm({ listingId: listing.id, ...(over as Record<string, string | string[]>) })),
    );

    expect(url).toContain("/sell/my?updated=1");
    expect(listing.status).toBe("pending");
  });

  it("đổi brandId + productModelId (sang model khác cùng category) trên approved → pending (B3)", async () => {
    const { listing } = setupApproved();
    dbState.brands.push({ ...BRAND, id: "brand-2", name: "Sony", slug: "sony" });
    dbState.models.push({ ...MODEL, id: "model-2", brandId: "brand-2", name: "SRS-XB33", slug: "sony-srs-xb33" });

    const url = await expectRedirect(() =>
      updateListingAction(
        {},
        listingForm({ listingId: listing.id, brandId: "brand-2", productModelId: "model-2" }),
      ),
    );

    expect(url).toContain("/sell/my?updated=1");
    expect(listing.status).toBe("pending");
    expect(listing.brandId).toBe("brand-2");
    expect(listing.productModelId).toBe("model-2");
  });

  it("đổi image set (thêm ảnh mới owned) trên approved → pending (B3)", async () => {
    const { seller, listing } = setupApproved();
    seedUpload(seller.id, `${UUID_IMG_2}.webp`);

    const url = await expectRedirect(() =>
      updateListingAction(
        {},
        listingForm({ listingId: listing.id, images: [IMG_URL, IMG_URL_2], imageSlots: ["front", "back"] }),
      ),
    );

    expect(url).toContain("/sell/my?updated=1");
    expect(listing.status).toBe("pending");
    expect(dbState.images.filter((i) => i["listingId"] === listing.id)).toHaveLength(2);
  });

  it("đổi slot set (front → back) trên approved → pending (B3)", async () => {
    const { listing } = setupApproved();

    const url = await expectRedirect(() =>
      updateListingAction({}, listingForm({ listingId: listing.id, imageSlots: ["back"] })),
    );

    expect(url).toContain("/sell/my?updated=1");
    expect(listing.status).toBe("pending");
    expect(dbState.images[0]).toMatchObject({ checklistSlot: "back" });
  });

  it("content change từ hidden → pending (ẩn cũng phải qua lại review — spec §5.6.2)", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    seedUpload(seller.id);
    const listing = seedListing(seller.id, "hidden");
    login(seller);

    const url = await expectRedirect(() =>
      updateListingAction(
        {},
        listingForm({ listingId: listing.id, title: "Loa JBL Charge 5 chính hãng ĐỔI TIÊU ĐỀ" }),
      ),
    );

    expect(url).toContain("/sell/my?updated=1");
    expect(listing.status).toBe("pending");
  });
});

// ─── 7. A10 interim — legacy rejected KHÔNG resubmit ──────────────────────────

describe("A10 interim — legacy-regime listing bị từ chối KHÔNG resubmit (fail closed)", () => {
  it("content-change trên legacy listing status rejected → form message, status GIỮ rejected (KHÔNG chuyển pending)", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    // listing legacy (pre-Batch-4) — category legacy, structured NULL, ảnh seed gắn
    const listing = seedListing(seller.id, "rejected", {
      categoryId: CAT_LEGACY.id,
      brandId: null,
      productModelId: null,
      inventoryContext: null,
      fulfillmentMethods: null,
      provinceLevelCode: null,
      locationDisplayName: null,
    });
    seedImage(listing.id, "/img/listings/seed-1.svg", null);
    login(seller);

    const state = await updateListingAction(
      {},
      listingForm({
        listingId: listing.id,
        categoryId: CAT_LEGACY.id,
        title: "Loa JBL Charge 5 chính hãng ĐỔI TIÊU ĐỀ",
        brandId: "",
        productModelId: "",
        inventoryContext: "",
        fulfillmentMethods: [] as string[],
        provinceLevelCode: "",
        locationDisplayName: "",
        images: ["/img/listings/seed-1.svg"],
        imageSlots: [] as string[],
      }),
    );

    expect(state.error).toBeTruthy();
    expect(listing.status).toBe("rejected"); // A10 — KHÔNG resubmit vào pending
    expect(listing.title).toBe("Loa JBL Charge 5 chính hãng"); // KHÔNG ghi đè
  });
});

// ─── 8. B1/B4 — approve defense-in-depth qua checkListingPublication ─────────

describe("approveListingAction — content defense-in-depth (B1/B4 qua checkListingPublication)", () => {
  const setupPending = () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    seedUpload(seller.id);
    const listing = seedListing(seller.id, "pending");
    login(ADMIN_OPS, { isAdmin: true });
    return { seller, listing };
  };

  it("listing có ảnh https:// ĐÃ GẮN → KHÔNG approve + audit reason 'listing_content_invalid' + issues= (scheme URL không bao giờ tin — kể cả approve)", async () => {
    const { listing } = setupPending();
    // ảnh scheme ĐÃ gắn từ trước (pre-gate) — rule (3) chặn kể cả khi attached
    dbState.images.push({
      id: `img-${dbState.images.length + 1}`,
      listingId: listing.id,
      url: "https://evil.example/x.jpg",
      sortOrder: 1,
      checklistSlot: null,
    });

    await approveListingAction(approveFd(listing));

    expect(listing.status).toBe("pending"); // KHÔNG approve
    const evt = dbState.audits.find((r) => r.action === "listing.approve_blocked");
    expect(evt).toMatchObject({
      actorId: ADMIN_OPS.id,
      subjectId: listing.sellerId,
      reason: "listing_content_invalid", // reason MỚI (content) — tách bạch với seller gate
    });
    expect(evt!.detail).toContain("issues=");
    expect(evt!.detail).toContain("IMAGE_URL_INVALID");
    expect(dbState.audits.filter((r) => r.action === "listing.approved")).toHaveLength(0);
  });

  it.each([
    ["model status pending", { status: "pending" }],
    ["model status merged", { status: "merged" }],
    ["model thuộc category KHÁC", { categoryId: CAT_LEGACY.id }],
  ])("beta listing với %s → KHÔNG approve + issues chứa MODEL_INVALID (B4)", async (_label, over) => {
    const { listing } = setupPending();
    dbState.models.push({ ...MODEL, id: "model-bad", ...over });
    (listing as Row).productModelId = "model-bad"; // row fixture mutate trực tiếp

    await approveListingAction(approveFd(listing));

    expect(listing.status).toBe("pending");
    const evt = dbState.audits.find((r) => r.action === "listing.approve_blocked");
    expect(evt!.reason).toBe("listing_content_invalid");
    expect(evt!.detail).toContain("MODEL_INVALID");
  });

  it("model thuộc brand KHÁC → MODEL_BRAND_MISMATCH (B4)", async () => {
    const { listing } = setupPending();
    dbState.brands.push({ ...BRAND, id: "brand-2", name: "Sony", slug: "sony" });
    dbState.models.push({ ...MODEL, id: "model-other-brand", brandId: "brand-2" });
    (listing as Row).productModelId = "model-other-brand";

    await approveListingAction(approveFd(listing));

    expect(listing.status).toBe("pending");
    const evt = dbState.audits.find((r) => r.action === "listing.approve_blocked");
    expect(evt!.reason).toBe("listing_content_invalid");
    expect(evt!.detail).toContain("MODEL_BRAND_MISMATCH");
  });
});

// ─── 9. Item 1 per-path pins — wrapper gọi ĐÚNG MỘT LẦN (counting wrappers) ─────

describe("per-path gate pins — create/submit/update-into-pending/toggle gọi assertListingPublishable MỘT LẦN", () => {
  it("createListingAction → assertListingPublishable ĐÚNG 1 lần", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    seedUpload(seller.id);
    login(seller);

    await expectRedirect(() => createListingAction({}, listingForm()));

    expect(gateState.publishableCalls).toBe(1);
    expect(gateState.sellerGateCalls).toBe(1); // seller gate chạy BÊN TRONG wrapper
  });

  it("submitListingAction → assertListingPublishable ĐÚNG 1 lần", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    seedUpload(seller.id);
    const draft = seedListing(seller.id, "draft");
    login(seller);

    // b4-holistic: submit thành công redirect /sell/my?submitted=1
    const url = await expectRedirect(() => submitListingAction(fd({ listingId: draft.id })));
    expect(url).toBe("/sell/my?submitted=1");

    expect(gateState.publishableCalls).toBe(1);
    expect(draft.status).toBe("pending");
  });

  it("updateListingAction vào pending → assertListingPublishable ĐÚNG 1 lần", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    seedUpload(seller.id);
    const listing = seedListing(seller.id, "approved");
    login(seller);

    await expectRedirect(() =>
      updateListingAction(
        {},
        listingForm({ listingId: listing.id, title: "Loa JBL Charge 5 chính hãng ĐỔI TIÊU ĐỀ" }),
      ),
    );

    expect(gateState.publishableCalls).toBe(1);
    expect(listing.status).toBe("pending");
  });

  it("toggleListingVisibilityAction hidden→approved → assertListingPublishable ĐÚNG 1 lần", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    seedUpload(seller.id);
    const listing = seedListing(seller.id, "hidden");
    login(seller);

    await toggleListingVisibilityAction(fd({ listingId: listing.id }));

    expect(gateState.publishableCalls).toBe(1);
    expect(listing.status).toBe("approved");
  });

  it("updateListingAction KHÔNG chuyển trạng thái → assertListingContentValid 1 lần, 0 seller gate (item 1)", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    seedUpload(seller.id);
    const listing = seedListing(seller.id, "pending");
    login(seller);

    await expectRedirect(() =>
      updateListingAction(
        {},
        listingForm({ listingId: listing.id, title: "Loa JBL Charge 5 chính hãng ĐỔI TIÊU ĐỀ" }),
      ),
    );

    expect(gateState.contentValidCalls).toBe(1);
    expect(gateState.publishableCalls).toBe(0); // KHÔNG full gate
    expect(gateState.sellerGateCalls).toBe(0); // KHÔNG seller gate
    expect(listing.status).toBe("pending");
  });

  it("approveListingAction → checkListingPublication ĐÚNG 1 lần (direct checkSellerPublicationRequirements call ĐÃ XÓA)", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    seedUpload(seller.id);
    const listing = seedListing(seller.id, "pending");
    login(ADMIN_OPS, { isAdmin: true });

    await approveListingAction(approveFd(listing));

    expect(gateState.checkPublicationCalls).toBe(1);
    expect(gateState.publishableCalls).toBe(0); // approve KHÔNG dùng bản throw
    expect(listing.status).toBe("approved");
  });
});

// ─── 10. R5 — moderation lock giữ nguyên sau rewire + source contract ─────────

describe("R5 — moderation lock sau rewire (Batch 3 guards giữ nguyên)", () => {
  it("updateListingAction trên listing bị takedown → LISTING_MODERATION_LOCKED, KHÔNG mutation", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    const listing = seedListing(seller.id, "removed");
    login(seller);

    await expect(
      updateListingAction(
        {},
        listingForm({ listingId: listing.id, title: "Loa JBL Charge 5 chính hãng SỬA SAU TAKEDOWN" }),
      ),
    ).rejects.toThrowError(/LISTING_MODERATION_LOCKED/);

    expect(listing.status).toBe("removed");
    expect(listing.title).toBe("Loa JBL Charge 5 chính hãng");
  });

  it("toggleListingVisibilityAction trên listing bị takedown → LISTING_MODERATION_LOCKED (không un-remove)", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    const listing = seedListing(seller.id, "removed");
    login(seller);

    await expect(
      toggleListingVisibilityAction(fd({ listingId: listing.id })),
    ).rejects.toThrowError(/LISTING_MODERATION_LOCKED/);
    expect(listing.status).toBe("removed");
  });

  it("deleteListingAction trên listing bị takedown → LISTING_MODERATION_LOCKED, row SỐNG SÓT", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    const listing = seedListing(seller.id, "removed");
    login(seller);

    await expect(
      deleteListingAction(fd({ listingId: listing.id })),
    ).rejects.toThrowError(/LISTING_MODERATION_LOCKED/);
    expect(dbState.listings.find((l) => l["id"] === listing.id)).toBeDefined();
  });

  it("source contract: guard gọi isModerationLocked từ @/src/lib/moderation — KHÔNG hardcode status, KHÔNG raw .includes", () => {
    const src = readFileSync(join(fileURLToPath(new URL("../..", import.meta.url)), "src/lib/actions/listings.ts"), "utf8");
    expect(src).toMatch(/import \{[^}]*isModerationLocked[^}]*\} from "@\/src\/lib\/moderation"/);
    expect(src).not.toContain('"removed"');
    expect(src).not.toContain("'removed'");
    expect(src).not.toContain("MODERATION_LOCKED_LISTING_STATUSES");
  });
});

// ─── 11. Item 14 — account_not_suspended trên đường submit MỚI (Task 4) ────────

describe("item 14 — suspended seller bị chặn trên submitListingAction (đường mới của Task 4)", () => {
  it("submitListingAction: suspended seller → /sell/verification + audit listing.submit_blocked reason chứa account_not_suspended, status GIỮ draft", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    seedSuspension(seller.id);
    seedUpload(seller.id);
    const draft = seedListing(seller.id, "draft");
    login(seller);

    const url = await expectRedirect(() => submitListingAction(fd({ listingId: draft.id })));

    expect(url).toBe("/sell/verification");
    expect(draft.status).toBe("draft");
    const evt = dbState.audits.find((r) => r.action === "listing.submit_blocked");
    expect(evt).toMatchObject({ actorId: seller.id, resourceId: draft.id });
    expect(String(evt!.reason)).toContain("account_not_suspended");
  });

  it("toggleListingVisibilityAction: hidden → approved blocked cho suspended seller → silent return + audit listing.submit_blocked", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    seedSuspension(seller.id);
    seedUpload(seller.id);
    const listing = seedListing(seller.id, "hidden");
    login(seller);

    await toggleListingVisibilityAction(fd({ listingId: listing.id }));

    expect(listing.status).toBe("hidden");
    const evt = dbState.audits.find((r) => r.action === "listing.submit_blocked");
    expect(evt).toMatchObject({ actorId: seller.id, resourceId: listing.id });
    expect(String(evt!.reason)).toContain("account_not_suspended");
  });
});

// ─── 12. MEDIUM 1 (review fix) — approve CAS theo updatedAt (TOCTOU) ─────────

describe("approveListingAction — CAS updatedAt: content đổi giữa review và claim (MEDIUM 1)", () => {
  const setupPending = () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    seedUpload(seller.id);
    const listing = seedListing(seller.id, "pending");
    login(ADMIN_OPS, { isAdmin: true });
    return { seller, listing };
  };

  it("seller sửa content (updateListingAction trên pending) giữa review và claim → updatedAt bump → CAS 0 rows → KHÔNG approve + audit reason 'listing_changed_during_review', status GIỮ pending", async () => {
    const { listing } = setupPending();
    // Race: updateListingAction song song commit content mới NGAY TRONG lúc
    // checkListingPublication chạy (trước CAS) — updateAll tự bump updatedAt.
    gateState.onCheckPublication = () => {
      (listing as Row).updatedAt = "2026-10-07T01:23:45.678Z";
      (listing as Row).title = "Loa JBL Charge 5 chính hãng CONTENT MỚI CHƯA REVIEW";
    };

    await approveListingAction(approveFd(listing));

    // KHÔNG approve — admin đã review content CŨ, content MỚI chưa qua review
    expect(listing.status).toBe("pending");
    expect(listing.title).toBe("Loa JBL Charge 5 chính hãng CONTENT MỚI CHƯA REVIEW");
    const evt = dbState.audits.find((r) => r.action === "listing.approve_blocked");
    expect(evt).toMatchObject({
      actorId: ADMIN_OPS.id,
      subjectId: listing.sellerId,
      resourceType: "Listing",
      resourceId: listing.id,
      reason: "listing_changed_during_review",
    });
    expect(dbState.audits.filter((r) => r.action === "listing.approved")).toHaveLength(0);
    expect(dbState.adminAudits).toHaveLength(0); // legacy audit cũng KHÔNG ghi
  });

  it("admin KHÁC duyệt song song (status đổi, KHÔNG phải content) → CAS 0 rows → no-op im lặng, KHÔNG audit listing_changed_during_review", async () => {
    const { listing } = setupPending();
    gateState.onCheckPublication = () => {
      (listing as Row).status = "approved"; // admin khác thắng race
    };

    await approveListingAction(approveFd(listing));

    expect(listing.status).toBe("approved");
    expect(dbState.audits.filter((r) => r.action === "listing.approve_blocked")).toHaveLength(0);
    // event listing.approved của ADMIN KHÁC không phải của lần này — không audit thêm
    expect(dbState.audits.filter((r) => r.action === "listing.approved")).toHaveLength(0);
    expect(dbState.adminAudits).toHaveLength(0);
  });

  it("LOW 3 — lỗi INFRA từ checkListingPublication (KHÔNG phải policy) → NÉM TIẾP (fail closed visible), KHÔNG approve, KHÔNG audit chứa SQL text", async () => {
    const { listing } = setupPending();
    gateState.failCheckWith = "SqlQueryError: connection terminated (SELECT * FROM SellerVerification)";

    await expect(
      approveListingAction(approveFd(listing)),
    ).rejects.toThrowError(/connection terminated/);

    expect(listing.status).toBe("pending"); // KHÔNG approve
    expect(dbState.audits).toHaveLength(0); // KHÔNG audit — SQL text KHÔNG vào issues=
    expect(dbState.adminAudits).toHaveLength(0);
  });
});

// ─── 12b. Batch 4 holistic review — approve version ĐÃ REVIEW + recusal + 1 tx ──

describe("approveListingAction — version ĐÃ REVIEW (hidden input từ review card) + recusal + audit cùng tx", () => {
  const setupPending = () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    seedUpload(seller.id);
    const listing = seedListing(seller.id, "pending");
    login(ADMIN_OPS, { isAdmin: true });
    return { seller, listing };
  };

  it("version THIẾU (form cũ/forged không post version) → KHÔNG approve + audit reason 'listing_version_missing' (typed — KHÔNG free text)", async () => {
    const { listing } = setupPending();

    await approveListingAction(fd({ listingId: listing.id })); // KHÔNG post version

    expect(listing.status).toBe("pending");
    const evt = dbState.audits.find((r) => r.action === "listing.approve_blocked");
    expect(evt).toMatchObject({
      actorId: ADMIN_OPS.id,
      resourceType: "Listing",
      resourceId: listing.id,
      reason: "listing_version_missing",
    });
    expect(dbState.audits.filter((r) => r.action === "listing.approved")).toHaveLength(0);
    expect(dbState.adminAudits).toHaveLength(0);
  });

  it("version MALFORMED (không parse được timestamp) → KHÔNG approve + audit reason 'listing_version_missing'", async () => {
    const { listing } = setupPending();

    await approveListingAction(fd({ listingId: listing.id, version: "not-a-timestamp <script>" }));

    expect(listing.status).toBe("pending");
    expect(
      dbState.audits.find((r) => r.action === "listing.approve_blocked"),
    ).toMatchObject({ reason: "listing_version_missing" });
  });

  it("MEDIUM (b4-holistic) — seller sửa content SAU khi admin mở review card (version stale) → approval TỪ CHỐI: status GIỮ pending + audit 'listing_changed_during_review', KHÔNG approve content chưa review", async () => {
    const { listing } = setupPending();
    // Admin render card tại U0; seller edit content (updateAll tự bump updatedAt U1)
    const reviewedVersion = String(listing.updatedAt);
    (listing as Row).updatedAt = "2026-10-07T09:41:00.000Z";
    (listing as Row).title = "Loa JBL Charge 5 chính hãng CONTENT MỚI CHƯA REVIEW";

    await approveListingAction(fd({ listingId: listing.id, version: reviewedVersion }));

    // KHÔNG approve — admin đã review content CŨ, content MỚI chưa qua review
    expect(listing.status).toBe("pending");
    expect(listing.title).toBe("Loa JBL Charge 5 chính hãng CONTENT MỚI CHƯA REVIEW");
    const evt = dbState.audits.find((r) => r.action === "listing.approve_blocked");
    expect(evt).toMatchObject({
      actorId: ADMIN_OPS.id,
      subjectId: listing.sellerId,
      resourceId: listing.id,
      reason: "listing_changed_during_review",
    });
    expect(dbState.audits.filter((r) => r.action === "listing.approved")).toHaveLength(0);
    expect(dbState.adminAudits).toHaveLength(0);
    expect(dbState.notifications).toHaveLength(0);
  });

  it("recusal (S9 — Batch 3 takedown pattern): moderator LÀ seller của listing → KHÔNG tự duyệt + audit 'moderator_conflict' + redirect ?error=MODERATOR_CONFLICT", async () => {
    const { listing } = setupPending();
    // moderator-seller: admin ops chính là seller của listing
    (listing as Row).sellerId = ADMIN_OPS.id;

    const url = await expectRedirect(() =>
      approveListingAction(approveFd(listing)),
    );

    expect(url).toBe("/admin/listings?error=MODERATOR_CONFLICT");
    expect(listing.status).toBe("pending"); // KHÔNG approve
    expect(
      dbState.audits.find((r) => r.action === "listing.approve_blocked"),
    ).toMatchObject({
      actorId: ADMIN_OPS.id,
      subjectId: ADMIN_OPS.id,
      resourceId: listing.id,
      reason: "moderator_conflict",
    });
    expect(dbState.audits.filter((r) => r.action === "listing.approved")).toHaveLength(0);
    expect(dbState.adminAudits).toHaveLength(0);
  });

  it("approve THÀNH CÔNG ghi CẢ HAI audit (legacy AdminAuditLog + AuditEvent listing.approved) — cùng tx với claim (source contract)", async () => {
    const { listing } = setupPending();

    await approveListingAction(approveFd(listing));

    expect(listing.status).toBe("approved");
    // AuditEvent listing.approved
    expect(dbState.audits.filter((r) => r.action === "listing.approved")).toHaveLength(1);
    // legacy AdminAuditLog (approve_listing)
    expect(dbState.adminAudits).toHaveLength(1);
    expect(dbState.adminAudits[0]).toMatchObject({
      adminId: ADMIN_OPS.id,
      action: "approve_listing",
      entity: "Listing",
      entityId: listing.id,
    });
    // notify seller
    expect(dbState.notifications).toHaveLength(1);

    // Source contract (tx atomicity — LOW b4-holistic): claim + CẢ HAI audit
    // BÊN TRONG MỘT db.transaction — KHÔNG còn audit chạy SAU commit trên
    // global db (approved-missing-audit), KHÔNG global db trong callback.
    const src = read("src/lib/actions/admin.ts");
    const fnSrc = src.slice(src.indexOf("export async function approveListingAction"));
    const txStart = fnSrc.indexOf("await db.transaction(async (tx) => {");
    expect(txStart).toBeGreaterThan(-1);
    let depth = 0;
    let end = -1;
    for (let i = fnSrc.indexOf("{", txStart); i < fnSrc.length; i++) {
      if (fnSrc[i] === "{") depth++;
      else if (fnSrc[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const txBody = fnSrc.slice(txStart, end);
    expect(txBody).toContain("tx.orm.public.Listing"); // claim trong tx
    expect(txBody).toContain("auditTx(tx,"); // legacy AdminAuditLog trong tx
    expect(txBody).toContain("auditEventTx(tx,"); // AuditEvent trong tx
    expect(txBody).not.toMatch(/\baudit\(/); // KHÔNG global audit trong tx
    expect(txBody).not.toContain("db.orm."); // KHÔNG global db trong tx callback
  });

  it("reject THÀNH CÔNG ghi CẢ HAI audit (legacy AdminAuditLog + AuditEvent listing.rejected) — cùng tx với claim; version stale → KHÔNG reject", async () => {
    const { listing } = setupPending();
    const { rejectListingAction } = await import("@/src/lib/actions/admin");

    // version stale (content đổi sau review) → KHÔNG reject với lý do viết cho content cũ
    const reviewedVersion = String(listing.updatedAt);
    (listing as Row).updatedAt = "2026-10-07T09:42:00.000Z";
    await rejectListingAction(fd({ listingId: listing.id, reason: "Nội dung vi phạm", version: reviewedVersion }));
    expect(listing.status).toBe("pending");
    expect(
      dbState.audits.find((r) => r.action === "listing.reject_blocked"),
    ).toMatchObject({ reason: "listing_changed_during_review" });

    // version ĐÚNG → reject + cả hai audit trong cùng tx
    await rejectListingAction(
      fd({ listingId: listing.id, reason: "Nội dung vi phạm", version: String(listing.updatedAt) }),
    );
    expect(listing.status).toBe("rejected");
    expect(dbState.audits.filter((r) => r.action === "listing.rejected")).toHaveLength(1);
    expect(dbState.adminAudits).toHaveLength(1);
    expect(dbState.adminAudits[0]).toMatchObject({ action: "reject_listing", entity: "Listing" });
  });
});

// ─── 13. MEDIUM 2 (review fix) — delete-hide chỉ cho approved ────────────────

describe("deleteListingAction — đường ẩn khi CÓ đơn chỉ áp dụng cho approved (MEDIUM 2)", () => {
  it.each([
    ["rejected", "rejected"],
    ["draft", "draft"],
    ["pending", "pending"],
  ])("listing %s CÓ đơn → redirect ?error=LISTING_HAS_ORDERS (typed — KHÔNG throw ra error boundary), status GIỮ NGUYÊN — KHÔNG hide (không mở đường hidden→approved bypass review)", async (_label, status) => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    const listing = seedListing(seller.id, status);
    dbState.orderItems.push({ id: "oi-1", orderId: "order-1", listingId: listing.id, quantity: 1, price: 1 });
    login(seller);

    // b4-holistic (LOW form-action-contract): void form action KHÔNG throw
    // expected condition ra error boundary — redirect typed code trong allowlist.
    const url = await expectRedirect(() => deleteListingAction(fd({ listingId: listing.id })));
    expect(url).toBe("/sell/my?error=LISTING_HAS_ORDERS");

    // status GIỮ NGUYÊN — KHÔNG bao giờ thành hidden → KHÔNG toggle được lên approved
    expect(listing.status).toBe(status);
    expect(dbState.listings.find((l) => l["id"] === listing.id)).toBeDefined();
  });

  it("listing approved CÓ đơn → hidden (CAS trên approved — hành vi giữ nguyên, không xóa)", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    const listing = seedListing(seller.id, "approved");
    dbState.orderItems.push({ id: "oi-1", orderId: "order-1", listingId: listing.id, quantity: 1, price: 1 });
    login(seller);

    await deleteListingAction(fd({ listingId: listing.id }));

    expect(listing.status).toBe("hidden");
    expect(dbState.listings).toHaveLength(1); // KHÔNG xóa
  });

  it("review-bypass chain ĐÓNG: rejected + đơn → delete bị chặn → toggle hidden→approved KHÔNG thể xảy ra (status không bao giờ thành hidden)", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    seedUpload(seller.id);
    const listing = seedListing(seller.id, "rejected");
    dbState.orderItems.push({ id: "oi-1", orderId: "order-1", listingId: listing.id, quantity: 1, price: 1 });
    login(seller);

    // delete bị chặn — redirect typed code (b4-holistic: KHÔNG throw error boundary)
    const url = await expectRedirect(() => deleteListingAction(fd({ listingId: listing.id })));
    expect(url).toBe("/sell/my?error=LISTING_HAS_ORDERS");
    // toggle trên rejected → KHÔNG phải hidden → không có đường hidden→approved
    await toggleListingVisibilityAction(fd({ listingId: listing.id }));
    expect(listing.status).toBe("rejected"); // vẫn rejected — KHÔNG thể đạt approved
  });
});

// ─── 14. LOW 1 (review fix) — contentChanged += acceptExchange + city ────────

describe("updateListingAction — contentChanged mở rộng thêm acceptExchange + city (LOW 1)", () => {
  it("đổi acceptExchange trên approved → pending (content công khai, phải qua lại review)", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    seedUpload(seller.id);
    const listing = seedListing(seller.id, "approved");
    login(seller);

    const url = await expectRedirect(() =>
      updateListingAction({}, listingForm({ listingId: listing.id, acceptExchange: "on" })),
    );

    expect(url).toContain("/sell/my?updated=1");
    expect(listing.status).toBe("pending");
    expect(listing.acceptExchange).toBe(true);
  });

  it("đổi city (legacy free-text — không province) trên approved → pending", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    // listing legacy: category legacy, structured NULL, ảnh seed gắn (rule 2)
    const listing = seedListing(seller.id, "approved", {
      categoryId: CAT_LEGACY.id,
      brandId: null,
      productModelId: null,
      inventoryContext: null,
      fulfillmentMethods: null,
      provinceLevelCode: null,
      locationDisplayName: null,
      city: "Hà Nội",
    });
    seedImage(listing.id, "/img/listings/seed-1.svg", null);
    login(seller);

    const url = await expectRedirect(() =>
      updateListingAction(
        {},
        listingForm({
          listingId: listing.id,
          categoryId: CAT_LEGACY.id,
          brandId: "",
          productModelId: "",
          inventoryContext: "",
          fulfillmentMethods: [] as string[],
          provinceLevelCode: "",
          locationDisplayName: "",
          city: "Đà Nẵng",
          images: ["/img/listings/seed-1.svg"],
          imageSlots: [] as string[],
        }),
      ),
    );

    expect(url).toContain("/sell/my?updated=1");
    expect(listing.status).toBe("pending"); // city đổi → qua lại review
    expect(listing.city).toBe("Đà Nẵng");
  });

  it("KHÔNG đổi acceptExchange/city (cùng giá trị) → KHÔNG vào pending oan (guard không over-block)", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    seedUpload(seller.id);
    const listing = seedListing(seller.id, "approved");
    login(seller);

    // form giữ nguyên mọi giá trị (acceptExchange vắng = false, city derive từ
    // province ha-noi = "Hà Nội" = stored) → KHÔNG content change → GIỮ approved
    const url = await expectRedirect(() =>
      updateListingAction({}, listingForm({ listingId: listing.id })),
    );

    expect(url).toContain("/sell/my?updated=1");
    expect(listing.status).toBe("approved");
  });
});

// ─── 15. LOW 2 (review fix) — province typed error trên create/update ────────

describe("create/update — province lạ/thiếu → typed PROVINCE_INVALID/PROVINCE_REQUIRED (LOW 2)", () => {
  it("createListingAction với provinceLevelCode LẠ → typed PROVINCE_INVALID (KHÔNG text không code), KHÔNG row", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    seedUpload(seller.id);
    login(seller);

    const state = await createListingAction(
      {},
      listingForm({ provinceLevelCode: "khong-ton-tai" }),
    );

    expect(state.error).toContain("PROVINCE_INVALID");
    expect(state.error).not.toContain("Chọn khu vực");
    expect(dbState.listings).toHaveLength(0);
  });

  it("createListingAction thiếu province VÀ city → typed PROVINCE_REQUIRED, KHÔNG row", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    seedUpload(seller.id);
    login(seller);

    const state = await createListingAction(
      {},
      listingForm({ provinceLevelCode: "", city: "" }),
    );

    expect(state.error).toContain("PROVINCE_REQUIRED");
    expect(dbState.listings).toHaveLength(0);
  });

  it("updateListingAction với provinceLevelCode LẠ → typed PROVINCE_INVALID, KHÔNG write", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    seedUpload(seller.id);
    const listing = seedListing(seller.id, "approved");
    login(seller);

    const state = await updateListingAction(
      {},
      listingForm({ listingId: listing.id, provinceLevelCode: "khong-ton-tai" }),
    );

    expect(state.error).toContain("PROVINCE_INVALID");
    expect(listing.status).toBe("approved"); // KHÔNG transition
    expect(listing.provinceLevelCode).toBe("ha-noi"); // KHÔNG write
  });
});
