/**
 * R5 — seller-side listing lock + conditional writes (Batch 3 plan Task 6,
 * spec §5.5/§7.8 + §10.1 concurrent update; SHOULD-FIX 3) — unit tests.
 *
 * Hợp đồng (plan Task 6 Step 1):
 *  1. updateListingAction / toggleListingVisibilityAction / deleteListingAction
 *     trên listing `removed` (moderation takedown — R4) → typed error
 *     LISTING_MODERATION_LOCKED, KHÔNG mutation — seller không edit/toggle/delete
 *     để thoát takedown, không un-remove, không phá nguồn của moderation record.
 *  2. Conditional-write race (SHOULD-FIX 3): action đọc approved, takedown đổi
 *     row sang removed TRƯỚC khi write → conditional write
 *     (.where({ id, status: <read status> })) hit 0 rows → typed error, row
 *     GIỮ NGUYÊN removed (check-then-write đơn thuần sẽ thua race — clobber).
 *  3. approveListingAction đọc pending, takedown removes listing TRƯỚC khi
 *     approval write → conditional .where({ id, status: "pending" }) hit 0
 *     rows → KHÔNG approval, KHÔNG resurrection (R5/R7 — admin.ts pending-only).
 *  4. approve/reject trên listing removed → no-op (pending-only) — removed
 *     KHÔNG bao giờ re-enter qua review.
 *  5. Cả ba seller action vẫn hoạt động trên approved/hidden/pending (lock
 *     KHÔNG over-block).
 *  6. Source-contract: cả ba guard dùng isModerationLocked từ
 *     @/src/lib/moderation (KHÔNG hardcode "removed", KHÔNG raw .includes trên
 *     tuple — Batch 4 rewire mở rộng call sites, không mở rộng vocabulary);
 *     admin.ts approve/reject là conditional pending-only writes.
 *
 * Cơ chế mock như tests/unit/publication-gate.test.ts (session/rbac/policy GIỮ
 * BẢN THẬT — login qua COOKIE THẬT, gate đọc FRESH từ store mock) + seam
 * `beforeListingWrite` chạy NGAY TRƯỚC mỗi Listing write (update/updateAll/
 * delete) — mô phỏng takedown đổi row underneath giữa read và write.
 * Listing.delete trả row|null (0 rows → null) — đúng shape ORM thật.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

// ─── db.client mock — in-memory + seam beforeListingWrite ─────────────────────

const dbState = vi.hoisted(() => ({
  users: [] as Array<Record<string, unknown>>,
  sessions: [] as Array<Record<string, unknown>>,
  listings: [] as Array<Record<string, unknown>>,
  images: [] as Array<Record<string, unknown>>,
  cartItems: [] as Array<Record<string, unknown>>,
  orderItems: [] as Array<Record<string, unknown>>,
  categories: [] as Array<Record<string, unknown>>,
  verifications: [] as Array<Record<string, unknown>>,
  acceptances: [] as Array<Record<string, unknown>>,
  memberships: [] as Array<Record<string, unknown>>,
  suspensions: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
  adminAudits: [] as Array<Record<string, unknown>>,
  notifications: [] as Array<Record<string, unknown>>,
  /**
   * Seam SHOULD-FIX 3: chạy NGAY TRƯỚC mỗi Listing write (update/updateAll/
   * delete) — mô phỏng takedown (hoặc duyệt/từ chối) đổi row underneath giữa
   * lúc action đọc và lúc action viết. Set trong test race, clear sau.
   */
  beforeListingWrite: null as null | (() => void),
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
          in: (values: readonly unknown[]) =>
            Array.isArray(values) && values.includes(row[field]),
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
      select: (..._fields: string[]) => query(preds, includeRel),
      orderBy: () => query(preds, includeRel),
      first: async (filter?: Pred) => {
        const all = [...preds, ...(filter ? [filter] : [])];
        const hit = rows.find((r) => all.every((p) => matches(r, p)));
        if (hit === undefined) return null;
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
      // Shape ORM THẬT: delete trả ROW bị xóa | null khi 0 rows (đã verify
      // scratch DB) — deleteListingAction claim check dựa trên null.
      delete: async () => {
        const hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        if (hit.length === 0) return null;
        const first = hit[0]!;
        const i = rows.indexOf(first);
        if (i >= 0) rows.splice(i, 1);
        return { ...first };
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
      select: (...fields: string[]) => query([]).select(...fields),
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
    })),
    CartItem: makeModel(dbState.cartItems, () => ({
      id: `ci-${dbState.cartItems.length + 1}`,
      quantity: 1,
    })),
    OrderItem: makeModel(dbState.orderItems, () => ({
      id: `oi-${dbState.orderItems.length + 1}`,
      quantity: 1,
    })),
    Category: makeModel(dbState.categories, () => ({
      id: `cat-${dbState.categories.length + 1}`,
      commissionRate: 5,
      sortOrder: 0,
      isActive: true,
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
    UserSuspension: makeModel(dbState.suspensions, () => ({
      id: `susp-${dbState.suspensions.length + 1}`,
      status: "active",
      note: null,
      suspendedById: null,
      liftedById: null,
      liftedAt: null,
      liftReasonCode: null,
    })),
    AuditEvent: makeModel(dbState.audits, () => ({
      id: `audit-${dbState.audits.length + 1}`,
      actorId: null,
      subjectId: null,
      resourceType: null,
      resourceId: null,
      reason: null,
      policyVersion: null,
      sessionId: null,
      detail: null,
      ipHash: null,
      createdAt: new Date().toISOString(),
    })),
    AdminAuditLog: makeModel(dbState.adminAudits, () => ({
      id: `aal-${dbState.adminAudits.length + 1}`,
      createdAt: new Date().toISOString(),
    })),
    Notification: makeModel(dbState.notifications, () => ({
      id: `notif-${dbState.notifications.length + 1}`,
      body: null,
      link: null,
      readAt: null,
      createdAt: new Date().toISOString(),
    })),
  };

  // Seam SHOULD-FIX 3: wrap Listing model — MỌI write (update/updateAll/delete,
  // kể cả trong chuỗi .where(...)) chạy dbState.beforeListingWrite TRƯỚC khi
  // thực thi — mô phỏng takedown đổi row giữa read của action và write.
  const wrapListing = (model: (typeof models)["Listing"]) => {
    const wrapQ = (q: {
      where: (pred: Pred) => unknown;
      updateAll: (data: Row) => Promise<Row[]>;
      update: (data: Row) => Promise<Row | null>;
      delete: () => Promise<Row | null>;
    }) => ({
      ...q,
      where: (pred: Pred) => wrapQ(q.where(pred) as never),
      updateAll: async (data: Row) => {
        dbState.beforeListingWrite?.();
        return q.updateAll(data);
      },
      update: async (data: Row) => {
        dbState.beforeListingWrite?.();
        return q.update(data);
      },
      delete: async () => {
        dbState.beforeListingWrite?.();
        return q.delete();
      },
    });
    return {
      ...model,
      where: (pred: Pred) => wrapQ(model.where(pred) as never),
    };
  };

  const orm = { public: { ...models, Listing: wrapListing(models.Listing) } };
  return {
    db: {
      orm,
      transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ orm: { public: orm.public } }),
    },
  };
});

// ─── Imports (SAU mock) ──────────────────────────────────────────────────────

import { resetRateLimits } from "@/src/lib/rate-limit";
import { SESSION_COOKIE } from "@/src/lib/session";
import {
  updateListingAction,
  toggleListingVisibilityAction,
  deleteListingAction,
} from "@/src/lib/actions/listings";
import { approveListingAction, rejectListingAction } from "@/src/lib/actions/admin";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const sha256Hex = (v: string) => createHash("sha256").update(v).digest("hex");
type Row = Record<string, unknown>;

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

/** Seller ĐỦ 8 yêu cầu policy (mặc định) — approveListingAction cần gate pass. */
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
const seedPolicyRows = (sellerId: string): void => {
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
    status: "active",
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
    status: "verified",
    method: "operations_review",
    submittedAt: new Date().toISOString(),
    reviewedAt: new Date().toISOString(),
    reviewerId: ADMIN_OPS.id,
    reasonCode: "requirements_met",
    note: null,
    policyVersion: "v1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
};

const CATEGORY = { id: "cat-1", name: "Loa bluetooth", slug: "loa-bluetooth", commissionRate: 5, sortOrder: 0, isActive: true, createdAt: "2026-09-01T00:00:00.000Z" };

const login = (user: Row, opts?: { isAdmin?: boolean }): string => {
  const id = `sess-${user.id}-${dbState.sessions.length + 1}`;
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

const fd = (entries: Record<string, string>): FormData => {
  const form = new FormData();
  for (const [k, v] of Object.entries(entries)) form.set(k, v);
  return form;
};

/** updateListing formData HỢP LỆ (title/desc/price/city/images). */
const listingForm = (over?: Record<string, string>): FormData => {
  const form = fd({
    title: "Loa JBL Charge 5 chính hãng",
    categoryId: CATEGORY.id,
    condition: "good",
    price: "1800000",
    city: "Hà Nội",
    description: "Loa bluetooth cũ còn tốt, pin trâu, nghe hay.",
  });
  form.set("images", "/uploads/a.jpg");
  if (over) for (const [k, v] of Object.entries(over)) form.set(k, v);
  return form;
};

/** Listing fixture của seller. */
const seedListing = (sellerId: string, status: string): Row & { id: string } => {
  const row: Row & { id: string } = {
    id: `listing-${dbState.listings.length + 1}`,
    sellerId,
    categoryId: CATEGORY.id,
    brandId: null,
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
    productModelId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  dbState.listings.push(row);
  return row;
};

const listingRow = (id: string): Row | undefined =>
  dbState.listings.find((l) => l["id"] === id);

const auditsOf = (action: string): Row[] =>
  dbState.audits.filter((r) => r["action"] === action);

/** Seller đủ policy + đã login. */
const setupVerifiedSeller = (): Row & { id: string } => {
  const seller = mkVerifiedSeller();
  dbState.users.push(seller);
  seedPolicyRows(seller.id);
  login(seller);
  return seller;
};

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AUTH_SECRET", "unit-test-auth-secret-0123456789abcdef");
  dbState.users.length = 0;
  dbState.sessions.length = 0;
  dbState.listings.length = 0;
  dbState.images.length = 0;
  dbState.cartItems.length = 0;
  dbState.orderItems.length = 0;
  dbState.categories.length = 0;
  dbState.verifications.length = 0;
  dbState.acceptances.length = 0;
  dbState.memberships.length = 0;
  dbState.suspensions.length = 0;
  dbState.audits.length = 0;
  dbState.adminAudits.length = 0;
  dbState.notifications.length = 0;
  dbState.beforeListingWrite = null;
  dbState.users.push({ ...ADMIN_OPS });
  dbState.categories.push({ ...CATEGORY });
  cookieState.store.clear();
  headerState.headers = new Headers();
  resetRateLimits();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── 1. R5 — lock guard trên listing removed ────────────────────────────────

describe("R5 — seller-side lock: listing removed KHÔNG được edit/toggle/delete", () => {
  it("updateListingAction trên listing removed → LISTING_MODERATION_LOCKED, KHÔNG mutation", async () => {
    const seller = setupVerifiedSeller();
    const listing = seedListing(seller.id, "removed");

    await expect(
      updateListingAction({}, listingForm({ listingId: listing.id, title: "SỬA SAU TAKEDOWN" })),
    ).rejects.toThrowError(/LISTING_MODERATION_LOCKED/);

    // KHÔNG mutation — seller không edit để thoát takedown
    expect(listingRow(listing.id)).toMatchObject({
      status: "removed",
      title: "Loa JBL Charge 5 chính hãng",
    });
    expect(dbState.images).toHaveLength(0); // ảnh không bị đụng
  });

  it("toggleListingVisibilityAction trên listing removed → LISTING_MODERATION_LOCKED, status GIỮ NGUYÊN removed (không un-remove)", async () => {
    const seller = setupVerifiedSeller();
    const listing = seedListing(seller.id, "removed");

    await expect(
      toggleListingVisibilityAction(fd({ listingId: listing.id })),
    ).rejects.toThrowError(/LISTING_MODERATION_LOCKED/);

    expect(listingRow(listing.id)).toMatchObject({ status: "removed" });
  });

  it("deleteListingAction trên listing removed → LISTING_MODERATION_LOCKED, row SỐNG SÓT (nguồn moderation record không bị phá)", async () => {
    const seller = setupVerifiedSeller();
    const listing = seedListing(seller.id, "removed");

    await expect(
      deleteListingAction(fd({ listingId: listing.id })),
    ).rejects.toThrowError(/LISTING_MODERATION_LOCKED/);

    // row GIỮ NGUYÊN — moderation record vẫn chỉ vào nguồn sống
    expect(listingRow(listing.id)).toMatchObject({ status: "removed" });
    expect(dbState.listings).toHaveLength(1);
  });
});

// ─── 2. SHOULD-FIX 3 — conditional-write race (takedown đổi row underneath) ──

describe("SHOULD-FIX 3 — conditional write thua race thay vì clobber removed", () => {
  it("updateListingAction đọc approved, takedown đổi row sang removed TRƯỚC write → 0 rows → typed error, status GIỮ NGUYÊN removed", async () => {
    const seller = setupVerifiedSeller();
    const listing = seedListing(seller.id, "approved");
    // Takedown (request khác) đổi row sang removed NGAY TRƯỚC khi write của
    // action này chạy — conditional write .where({ id, status: "approved" })
    // hit 0 rows → typed error (check-then-write sẽ CLOBBER removed).
    dbState.beforeListingWrite = () => {
      listing.status = "removed";
    };

    await expect(
      updateListingAction({}, listingForm({ listingId: listing.id, title: "SỬA TRONG RACE" })),
    ).rejects.toThrowError(/LISTING_MODERATION_LOCKED/);

    // row GIỮ NGUYÊN removed — KHÔNG bị clobber về pending/approved
    expect(listingRow(listing.id)).toMatchObject({ status: "removed" });
  });

  it("toggleListingVisibilityAction đọc approved, takedown đổi row → 0 rows → typed error, status GIỮ NGUYÊN removed", async () => {
    const seller = setupVerifiedSeller();
    const listing = seedListing(seller.id, "approved");
    dbState.beforeListingWrite = () => {
      listing.status = "removed";
    };

    await expect(
      toggleListingVisibilityAction(fd({ listingId: listing.id })),
    ).rejects.toThrowError(/LISTING_MODERATION_LOCKED/);

    expect(listingRow(listing.id)).toMatchObject({ status: "removed" });
  });

  it("deleteListingAction đọc approved, takedown đổi row → conditional delete 0 rows → typed error, row SỐNG SÓT removed", async () => {
    const seller = setupVerifiedSeller();
    const listing = seedListing(seller.id, "approved");
    dbState.beforeListingWrite = () => {
      listing.status = "removed";
    };

    await expect(
      deleteListingAction(fd({ listingId: listing.id })),
    ).rejects.toThrowError(/LISTING_MODERATION_LOCKED/);

    // row KHÔNG bị xóa — status removed nguyên vẹn
    expect(listingRow(listing.id)).toMatchObject({ status: "removed" });
    expect(dbState.listings).toHaveLength(1);
  });

  it("approveListingAction đọc pending, takedown removes listing TRƯỚC approval write → conditional 0 rows → KHÔNG approval, KHÔNG resurrection", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    const listing = seedListing(seller.id, "pending");
    login(ADMIN_OPS, { isAdmin: true });
    dbState.beforeListingWrite = () => {
      listing.status = "removed";
    };

    // silent return (posture no-op của admin action) — KHÔNG throw, KHÔNG approve
    await approveListingAction(fd({ listingId: listing.id }));

    expect(listingRow(listing.id)).toMatchObject({ status: "removed" });
    expect(auditsOf("listing.approved")).toHaveLength(0); // không resurrection audit
    expect(dbState.notifications).toHaveLength(0); // không notify duyệt
  });
});

// ─── 3. R5/R7 — approve/reject pending-only (removed không re-enter review) ──

describe("R5/R7 — approveListingAction/rejectListingAction pending-only", () => {
  beforeEach(() => {
    login(ADMIN_OPS, { isAdmin: true });
  });

  it("approve trên listing removed → NO-OP (pending-only — removed không re-enter qua review)", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    const listing = seedListing(seller.id, "removed");

    await approveListingAction(fd({ listingId: listing.id }));

    expect(listingRow(listing.id)).toMatchObject({ status: "removed" });
    expect(auditsOf("listing.approved")).toHaveLength(0);
    expect(auditsOf("listing.approve_blocked")).toHaveLength(0); // pre-check return TRƯỚC gate
    expect(dbState.notifications).toHaveLength(0);
  });

  it("reject trên listing removed → NO-OP, rejectionReason KHÔNG được viết", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    const listing = seedListing(seller.id, "removed");

    await rejectListingAction(fd({ listingId: listing.id, reason: "Nội dung vi phạm" }));

    expect(listingRow(listing.id)).toMatchObject({ status: "removed", rejectionReason: null });
    expect(auditsOf("listing.rejected")).toHaveLength(0);
    expect(dbState.notifications).toHaveLength(0);
  });
});

// ─── 4. Lock KHÔNG over-block — ba action vẫn hoạt động ──────────────────────

describe("lock KHÔNG over-block — seller vẫn thao tác trên approved/hidden/pending", () => {
  it("updateListingAction trên approved (content-change) → pending như trước (redirect /sell/my)", async () => {
    const seller = setupVerifiedSeller();
    const listing = seedListing(seller.id, "approved");

    let redirected = false;
    try {
      await updateListingAction({}, listingForm({ listingId: listing.id, title: "Loa JBL ĐỔI TIÊU ĐỀ" }));
    } catch (e) {
      const msg = (e as Error).message;
      if (!msg.startsWith("NEXT_REDIRECT:")) throw e;
      redirected = true;
      expect(msg).toContain("/sell/my?updated=1");
    }
    expect(redirected).toBe(true);

    expect(listingRow(listing.id)).toMatchObject({ status: "pending", title: "Loa JBL ĐỔI TIÊU ĐỀ" });
  });

  it("toggle approved → hidden → approved (gate pass) — luồng ẩn/hiện nguyên vẹn", async () => {
    const seller = setupVerifiedSeller();
    const listing = seedListing(seller.id, "approved");

    await toggleListingVisibilityAction(fd({ listingId: listing.id }));
    expect(listingRow(listing.id)).toMatchObject({ status: "hidden" });

    await toggleListingVisibilityAction(fd({ listingId: listing.id }));
    expect(listingRow(listing.id)).toMatchObject({ status: "approved" });
  });

  it("deleteListingAction trên pending (không có đơn) → row bị xóa như trước", async () => {
    const seller = setupVerifiedSeller();
    const listing = seedListing(seller.id, "pending");
    dbState.images.push({ id: "img-1", listingId: listing.id, url: "/uploads/a.jpg", sortOrder: 0 });

    await deleteListingAction(fd({ listingId: listing.id }));

    expect(listingRow(listing.id)).toBeUndefined(); // row gone
    expect(dbState.images).toHaveLength(0); // ảnh được dọn
  });

  it("deleteListingAction trên listing CÓ đơn → chỉ ẩn (hidden), KHÔNG xóa — conditional write vẫn pass", async () => {
    const seller = setupVerifiedSeller();
    const listing = seedListing(seller.id, "approved");
    dbState.orderItems.push({ id: "oi-1", orderId: "order-1", listingId: listing.id, quantity: 1 });

    await deleteListingAction(fd({ listingId: listing.id }));

    expect(listingRow(listing.id)).toMatchObject({ status: "hidden" });
    expect(dbState.listings).toHaveLength(1); // KHÔNG xóa
  });
});

// ─── 5. Source contract — helper dùng chung, không hardcode ─────────────────

describe("R5 source contract — isModerationLocked consumed bởi cả ba guard", () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const listingsSrc = readFileSync(`${root}/src/lib/actions/listings.ts`, "utf8");
  const adminSrc = readFileSync(`${root}/src/lib/actions/admin.ts`, "utf8");

  it("listings.ts import isModerationLocked từ @/src/lib/moderation (KHÔNG hardcode)", () => {
    expect(listingsSrc).toContain("isModerationLocked");
    expect(listingsSrc).toMatch(/import \{[^}]*isModerationLocked[^}]*\} from "@\/src\/lib\/moderation"/);
  });

  it("CẢ BA guard (update/toggle/delete) gọi isModerationLocked — đúng 3 call sites", () => {
    const calls = listingsSrc.match(/isModerationLocked\(/g) ?? [];
    expect(calls).toHaveLength(3);
  });

  it("KHÔNG hardcode chuỗi removed và KHÔNG raw .includes trên tuple trong listings.ts", () => {
    expect(listingsSrc).not.toContain('"removed"');
    expect(listingsSrc).not.toContain("'removed'");
    expect(listingsSrc).not.toContain("MODERATION_LOCKED_LISTING_STATUSES");
  });

  it("admin.ts approve/reject là CONDITIONAL pending-only writes (R5/R7 — .where({ id, status: \"pending\" }))", () => {
    const conditional = adminSrc.match(/\.where\(\{ id: listingId, status: "pending" \}\)/g) ?? [];
    expect(conditional).toHaveLength(2); // approve + reject
  });
});
