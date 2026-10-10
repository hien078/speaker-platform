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
 * `beforeListingWrite` mô phỏng takedown đổi row underneath giữa read và
 * write của action.
 *
 * MOCK FIDELITY — Prisma 8 two-step semantics (verified
 * node_modules/@prisma/orm-family-sql/dist/orm-client.mjs ~4794/~4892
 * `#findFirstMatchingRowIdentityWhere`): terminal đơn-row `.update()`/
 * `.delete()` SELECT row khớp filter ĐẦU rồi write `WHERE id = <id đó>` —
 * filter KHÔNG nằm trong statement write. `updateAll()`/`deleteAll()` compile
 * TOÀN BỘ filter vào MỘT statement. Mock mô phỏng CHÍNH XÁC hai ngữ nghĩa đó:
 *  - `update`/`delete` (Listing): select-first → SEAM → write-by-id (row đổi
 *    status sau select VẪN bị write — đúng bug gốc);
 *  - `updateAll`/`deleteAll` (Listing): SEAM → statement (filter thấy giá trị
 *    MỚI — Postgres re-check WHERE sau khi row lock thả) → 0 rows khi race.
 * Fidelity này được pin bởi describe "mock fidelity" bên dưới — nó là LÝ DO
 * deleteListingAction phải dùng deleteAll (compare-and-set) chứ KHÔNG .delete().
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
  exchangeOffers: [] as Array<Record<string, unknown>>,
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

  const makeModel = (
    rows: Row[],
    defaults?: () => Row,
    attach?: (row: Row) => void,
    seam?: () => void,
  ) => {
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
      // Prisma 8 FIDELITY — .update(): SELECT row khớp filter ĐẦU, RỒI write
      // THEO ID (filter KHÔNG nằm trong statement write). Seam chạy GIỮA
      // select và write-by-id — row đổi tay trong khoảng đó VẪN bị write.
      update: async (data: Row) => {
        const hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        if (hit.length === 0) return null;
        const target = hit[0]!;
        seam?.();
        Object.assign(target, data); // UPDATE ... WHERE id (bất chấp filter)
        return { ...target };
      },
      // Prisma 8 FIDELITY — .delete(): select-first → SEAM → DELETE WHERE id.
      // Trả ROW bị xóa | null khi select 0 rows (đúng shape ORM thật).
      delete: async () => {
        const hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        if (hit.length === 0) return null;
        const target = hit[0]!;
        seam?.();
        const i = rows.indexOf(target);
        if (i >= 0) rows.splice(i, 1); // DELETE ... WHERE id
        return { ...target };
      },
      // updateAll/deleteAll: MỘT statement với TOÀN BỘ filter — seam chạy
      // TRƯỚC statement (Postgres re-check WHERE sau khi row lock thả) →
      // row đổi tay làm filter trượt → 0 rows (compare-and-set THẮNG race).
      updateAll: async (data: Row) => {
        seam?.();
        const hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        for (const r of hit) Object.assign(r, data);
        return hit.map((r) => ({ ...r }));
      },
      deleteAll: async () => {
        seam?.();
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
    }), undefined, () => {
      // Seam SHOULD-FIX 3 — chạy ĐÚNG VỊ TRÍ theo ngữ nghĩa Prisma 8 của từng
      // terminal (xem makeModel): giữa select và write-by-id với .update()/
      // .delete(), TRƯỚC statement với .updateAll()/.deleteAll().
      dbState.beforeListingWrite?.();
    }),
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
    // b4-holistic-2 (LOW — ExchangeOffer FK): deleteListingAction pre-check
    // myListingId — mock cùng shape các model khác (first/all theo filter).
    ExchangeOffer: makeModel(dbState.exchangeOffers, () => ({
      id: `eo-${dbState.exchangeOffers.length + 1}`,
      status: "proposed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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

  // Seam SHOULD-FIX 3 đã NẰM TRONG Listing model (tham số thứ 4 của makeModel)
  // — chạy đúng vị trí theo ngữ nghĩa từng terminal (xem makeModel), không
  // còn wrapper ngoài (wrapper cũ chạy seam TRƯỚC select của .delete() —
  // sai fidelity: select phải thấy giá trị CŨ rồi write-by-id mới mô phỏng
  // đúng race thật).

  const orm = { public: models };
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
import { db } from "@/src/prisma/db.client";
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

/**
 * Action kết thúc bằng redirect() → throw NEXT_REDIRECT — coi là THÀNH CÔNG.
 * b4-holistic round-4: toggle/delete path thành công giờ redirect /sell/my
 * (URL sạch — banner ?error=/?submitted= của lần trước không dính lại).
 */
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
  dbState.exchangeOffers.length = 0;
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
  it("updateListingAction trên listing removed → typed form error LISTING_MODERATION_LOCKED (KHÔNG throw), KHÔNG mutation", async () => {
    const seller = setupVerifiedSeller();
    const listing = seedListing(seller.id, "removed");

    // b4-holistic round-3: useActionState action KHÔNG throw ra error boundary —
    // typed form error hiển thị qua banner state.error của PortableListingForm.
    const state = await updateListingAction(
      {},
      listingForm({ listingId: listing.id, title: "SỬA SAU TAKEDOWN" }),
    );
    expect(state.error).toContain("LISTING_MODERATION_LOCKED");

    // KHÔNG mutation — seller không edit để thoát takedown
    expect(listingRow(listing.id)).toMatchObject({
      status: "removed",
      title: "Loa JBL Charge 5 chính hãng",
    });
    expect(dbState.images).toHaveLength(0); // ảnh không bị đụng
  });

  it("toggleListingVisibilityAction trên listing removed → redirect typed code LISTING_MODERATION_LOCKED (KHÔNG throw), status GIỮ NGUYÊN removed (không un-remove)", async () => {
    const seller = setupVerifiedSeller();
    const listing = seedListing(seller.id, "removed");

    let redirected = false;
    try {
      await toggleListingVisibilityAction(fd({ listingId: listing.id }));
    } catch (e) {
      const msg = (e as Error).message;
      if (!msg.startsWith("NEXT_REDIRECT:")) throw e;
      redirected = true;
      expect(msg).toBe("NEXT_REDIRECT:/sell/my?error=LISTING_MODERATION_LOCKED");
    }
    expect(redirected).toBe(true);

    expect(listingRow(listing.id)).toMatchObject({ status: "removed" });
  });

  it("deleteListingAction trên listing removed → redirect typed code LISTING_MODERATION_LOCKED (KHÔNG throw), row SỐNG SÓT (nguồn moderation record không bị phá)", async () => {
    const seller = setupVerifiedSeller();
    const listing = seedListing(seller.id, "removed");

    let redirected = false;
    try {
      await deleteListingAction(fd({ listingId: listing.id }));
    } catch (e) {
      const msg = (e as Error).message;
      if (!msg.startsWith("NEXT_REDIRECT:")) throw e;
      redirected = true;
      expect(msg).toBe("NEXT_REDIRECT:/sell/my?error=LISTING_MODERATION_LOCKED");
    }
    expect(redirected).toBe(true);

    // row GIỮ NGUYÊN — moderation record vẫn chỉ vào nguồn sống
    expect(listingRow(listing.id)).toMatchObject({ status: "removed" });
    expect(dbState.listings).toHaveLength(1);
  });
});

// ─── 2. SHOULD-FIX 3 — conditional-write race (takedown đổi row underneath) ──

describe("SHOULD-FIX 3 — conditional write thua race thay vì clobber removed", () => {
  it("updateListingAction đọc approved, takedown đổi row sang removed TRƯỚC write → 0 rows → typed form error LISTING_MODERATION_LOCKED (KHÔNG throw), status GIỮ NGUYÊN removed, ảnh KHÔNG bị đụng", async () => {
    const seller = setupVerifiedSeller();
    const listing = seedListing(seller.id, "approved");
    // ảnh ĐÃ CÓ của listing — nếu action mutate ảnh trước CAS (bug cũ), một
    // listing bị takedown sẽ bị ĐỔI ẢNH dù throw sau đó (item 7 review fix).
    dbState.images.push({ id: "img-race", listingId: listing.id, url: "/uploads/a.jpg", sortOrder: 3 });
    // Takedown (request khác) đổi row sang removed NGAY TRƯỚC khi write của
    // action này chạy — conditional write .where({ id, status: "approved" })
    // hit 0 rows → typed form error (check-then-write sẽ CLOBBER removed).
    dbState.beforeListingWrite = () => {
      listing.status = "removed";
    };

    // b4-holistic round-3: CAS-0-rows nhánh moderation-lock → typed form error
    // (sentinel classify ở catch — KHÔNG throw ra error boundary).
    const state = await updateListingAction(
      {},
      listingForm({ listingId: listing.id, title: "SỬA TRONG RACE" }),
    );
    expect(state.error).toContain("LISTING_MODERATION_LOCKED");

    // row GIỮ NGUYÊN removed — KHÔNG bị clobber về pending/approved
    expect(listingRow(listing.id)).toMatchObject({ status: "removed" });
    // ẢNH GIỮ NGUYÊN (item 7): CAS là write ĐẦU TIÊN trong tx — throw trước
    // mọi image mutation; sortOrder 3 nguyên vẹn (form sẽ ghi 0 nếu lọt qua).
    expect(dbState.images).toHaveLength(1);
    expect(dbState.images[0]).toMatchObject({ url: "/uploads/a.jpg", sortOrder: 3 });
  });

  it("updateListingAction đọc approved, admin TỪ CHỐI thường thắng race → 0 rows → typed form error LISTING_CONCURRENT_CHANGE (b4-holistic — KHÔNG throw ra error boundary), ảnh KHÔNG bị đụng", async () => {
    const seller = setupVerifiedSeller();
    const listing = seedListing(seller.id, "approved");
    dbState.images.push({ id: "img-race", listingId: listing.id, url: "/uploads/a.jpg", sortOrder: 3 });
    // Admin rejectListingAction (không phải moderation) thắng race — seller
    // thấy lỗi "trạng thái đã đổi tay" (form error tiếng Việt + code ổn định)
    // chứ KHÔNG thấy error boundary (b4-holistic form-action-contract).
    dbState.beforeListingWrite = () => {
      listing.status = "rejected";
    };

    const state = await updateListingAction({}, listingForm({ listingId: listing.id, title: "SỬA TRONG RACE" }));

    expect(state.error).toContain("LISTING_CONCURRENT_CHANGE");
    expect(state.error).toContain("Tin vừa thay đổi trạng thái");

    // row GIỮ NGUYÊN rejected — KHÔNG bị clobber
    expect(listingRow(listing.id)).toMatchObject({ status: "rejected", title: "Loa JBL Charge 5 chính hãng" });
    // ảnh KHÔNG bị đụng
    expect(dbState.images[0]).toMatchObject({ url: "/uploads/a.jpg", sortOrder: 3 });
  });

  it("toggleListingVisibilityAction đọc approved, takedown đổi row → 0 rows → redirect CONCURRENT_CHANGE (KHÔNG throw), status GIỮ NGUYÊN removed", async () => {
    const seller = setupVerifiedSeller();
    const listing = seedListing(seller.id, "approved");
    dbState.beforeListingWrite = () => {
      listing.status = "removed";
    };

    // b4-holistic round-3: CAS 0-rows → redirect typed code trung thực
    // (CONCURRENT_CHANGE — row đổi tay), KHÔNG masquerade thành lock, KHÔNG throw.
    let redirected = false;
    try {
      await toggleListingVisibilityAction(fd({ listingId: listing.id }));
    } catch (e) {
      const msg = (e as Error).message;
      if (!msg.startsWith("NEXT_REDIRECT:")) throw e;
      redirected = true;
      expect(msg).toBe("NEXT_REDIRECT:/sell/my?error=CONCURRENT_CHANGE");
    }
    expect(redirected).toBe(true);

    expect(listingRow(listing.id)).toMatchObject({ status: "removed" });
  });

  it("deleteListingAction đọc approved, takedown đổi row → conditional delete 0 rows → redirect CONCURRENT_CHANGE (KHÔNG throw), row SỐNG SÓT removed", async () => {
    const seller = setupVerifiedSeller();
    const listing = seedListing(seller.id, "approved");
    dbState.beforeListingWrite = () => {
      listing.status = "removed";
    };

    let redirected = false;
    try {
      await deleteListingAction(fd({ listingId: listing.id }));
    } catch (e) {
      const msg = (e as Error).message;
      if (!msg.startsWith("NEXT_REDIRECT:")) throw e;
      redirected = true;
      expect(msg).toBe("NEXT_REDIRECT:/sell/my?error=CONCURRENT_CHANGE");
    }
    expect(redirected).toBe(true);

    // row KHÔNG bị xóa — status removed nguyên vẹn
    expect(listingRow(listing.id)).toMatchObject({ status: "removed" });
    expect(dbState.listings).toHaveLength(1);
  });

  it("approveListingAction đọc pending, takedown removes listing TRƯỚC approval write → conditional 0 rows → KHÔNG approval, KHÔNG resurrection", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    const listing = seedListing(seller.id, "pending");
    // (Batch 4 Task 4 fixture) ảnh ĐÃ GẮN — checkListingPublication chạy content
    // stage TRƯỚC CAS; listing không ảnh → IMAGE_REQUIRED → block TRƯỚC khi CAS
    // chạy (seam không bao giờ fire). Ảnh gắn cho content pass → CAS mới chạy.
    dbState.images.push({ id: "img-approve-race", listingId: listing.id, url: "/uploads/a.jpg", sortOrder: 0, checklistSlot: null });
    login(ADMIN_OPS, { isAdmin: true });
    dbState.beforeListingWrite = () => {
      listing.status = "removed";
    };

    // silent return (posture no-op của admin action) — KHÔNG throw, KHÔNG approve
    await approveListingAction(fd({ listingId: listing.id, version: String(listing.updatedAt) }));

    expect(listingRow(listing.id)).toMatchObject({ status: "removed" });
    expect(auditsOf("listing.approved")).toHaveLength(0); // không resurrection audit
    expect(dbState.notifications).toHaveLength(0); // không notify duyệt
  });
});

// ─── 2b. Mock fidelity — neo ngữ nghĩa Prisma 8 hai bước của ORM thật ─────────
//
// Root cause (orm-client.mjs ~4794/~4892): .delete()/.update() đơn-row là
// select-first rồi write THEO ID — KHÔNG phải compare-and-set. Ba test này
// pin mock mô phỏng ĐÚNG ngữ nghĩa đó (nếu ORM đổi semantics, ba test đây
// là chuông cảnh báo) và dokument LÝ DO deleteListingAction dùng deleteAll.

describe("mock fidelity — Prisma 8 .delete()/.update() là select-first → write-by-id (KHÔNG compare-and-set)", () => {
  it(".delete() đơn-row THUA race: select thấy approved, row bị takedown đổi sang removed, DELETE WHERE id VẪN xoá row — nguồn moderation record bị phá (vì vậy action dùng deleteAll)", async () => {
    const seller = setupVerifiedSeller();
    const listing = seedListing(seller.id, "approved");
    dbState.beforeListingWrite = () => {
      listing.status = "removed"; // takedown commit giữa select và write
    };

    const deleted = await db.orm.public.Listing
      .where({ id: listing.id, status: "approved" })
      .delete();

    // select thấy approved → identity là id → DELETE WHERE id xoá row
    // vừa bị đổi sang removed — filter status KHÔNG nằm trong DELETE.
    expect(deleted).toMatchObject({ id: listing.id, status: "removed" });
    expect(listingRow(listing.id)).toBeUndefined(); // ROW MẤT — đúng bug gốc
  });

  it(".update() đơn-row cũng write-by-id bất chấp filter: row bị đổi sang removed VẪN bị ghi đè (KHÔNG compare-and-set)", async () => {
    const seller = setupVerifiedSeller();
    const listing = seedListing(seller.id, "approved");
    dbState.beforeListingWrite = () => {
      listing.status = "removed";
    };

    const updated = await db.orm.public.Listing
      .where({ id: listing.id, status: "approved" })
      .update({ title: "BỊ GHI ĐÈ" });

    expect(updated).toMatchObject({ id: listing.id, title: "BỊ GHI ĐÈ" });
    // row bị ghi đè title dù status đã là removed — filter không re-check
    expect(listingRow(listing.id)).toMatchObject({ status: "removed", title: "BỊ GHI ĐÈ" });
  });

  it(".deleteAll() compile filter VÀO statement: row bị đổi sang removed → 0 rows, row SỐNG SÓT (compare-and-set)", async () => {
    const seller = setupVerifiedSeller();
    const listing = seedListing(seller.id, "approved");
    dbState.beforeListingWrite = () => {
      listing.status = "removed";
    };

    const deleted = await db.orm.public.Listing
      .where({ id: listing.id, status: "approved" })
      .deleteAll();

    expect(deleted).toHaveLength(0); // 0 rows — filter thấy removed
    expect(listingRow(listing.id)).toMatchObject({ status: "removed" }); // SỐNG SÓT
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

    await approveListingAction(fd({ listingId: listing.id, version: String(listing.updatedAt) }));

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

    await rejectListingAction(fd({ listingId: listing.id, reason: "Nội dung vi phạm", version: String(listing.updatedAt) }));

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
    // (Batch 4 Task 4 fixture) ảnh form ĐÃ GẮN vào listing — rule (2) attached
    // (ảnh "/uploads/a.jpg" không phải upload uuid của Batch 4, chỉ hợp lệ khi
    // đã gắn; không gắn → IMAGE_URL_INVALID block trước transition).
    dbState.images.push({ id: "img-update-ok", listingId: listing.id, url: "/uploads/a.jpg", sortOrder: 0, checklistSlot: null });

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

  it("toggle approved → hidden → approved (gate pass, approvedContentAt SET — b4-holistic-2) — luồng ẩn/hiện nguyên vẹn", async () => {
    const seller = setupVerifiedSeller();
    const listing = seedListing(seller.id, "approved");
    // (Batch 4 Task 4 fixture) ảnh ĐÃ GẮN — hidden→approved build input TỪ DB
    // ROW (imageUrls từ ListingImage rows); không ảnh → IMAGE_REQUIRED → gate
    // block → silent return (test cũ sẽ fail vì status giữ hidden).
    dbState.images.push({ id: "img-toggle-ok", listingId: listing.id, url: "/uploads/a.jpg", sortOrder: 0, checklistSlot: null });
    // b4-holistic-2: content ĐÃ được admin duyệt (approvedContentAt) — hiện lại
    // thẳng approved; NULL thì chuyển pending (xem describe b4-holistic-2 dưới).
    listing.approvedContentAt = "2026-10-01T00:00:00.000Z";

    await expectRedirect(() => toggleListingVisibilityAction(fd({ listingId: listing.id })));
    expect(listingRow(listing.id)).toMatchObject({ status: "hidden" });

    await expectRedirect(() => toggleListingVisibilityAction(fd({ listingId: listing.id })));
    expect(listingRow(listing.id)).toMatchObject({ status: "approved" });
  });

  it("deleteListingAction trên pending (không có đơn) → row bị xóa như trước", async () => {
    const seller = setupVerifiedSeller();
    const listing = seedListing(seller.id, "pending");
    dbState.images.push({ id: "img-1", listingId: listing.id, url: "/uploads/a.jpg", sortOrder: 0 });

    await expectRedirect(() => deleteListingAction(fd({ listingId: listing.id })));

    expect(listingRow(listing.id)).toBeUndefined(); // row gone
    expect(dbState.images).toHaveLength(0); // ảnh được dọn
  });

  it("deleteListingAction trên listing CÓ đơn → chỉ ẩn (hidden), KHÔNG xóa — conditional write vẫn pass", async () => {
    const seller = setupVerifiedSeller();
    const listing = seedListing(seller.id, "approved");
    dbState.orderItems.push({ id: "oi-1", orderId: "order-1", listingId: listing.id, quantity: 1 });

    await expectRedirect(() => deleteListingAction(fd({ listingId: listing.id })));

    expect(listingRow(listing.id)).toMatchObject({ status: "hidden" });
    expect(dbState.listings).toHaveLength(1); // KHÔNG xóa
  });
});

// ─── 4b. b4-holistic-2 — deleteListingAction vs ExchangeOffer.myListingId FK ──

/**
 * CONFIRMED LOW "Seller hard-delete fails with an unhandled FK violation
 * when the listing is referenced as ExchangeOffer.myListingId": offer cũ
 * (finance đã tắt — chỉ dữ liệu tồn tại) giữ FK NO ACTION → deleteAll Listing
 * đâm 23503 → action crash 500 (raw DB error ra error boundary) thay vì typed
 * code. Pre-check chỉ nhìn OrderItem.
 *
 * Fix (recorded decision — đối xử NHƯ OrderItem): có offer tham chiếu →
 * approved → ẩn (CAS approved→hidden); status khác → redirect typed
 * LISTING_HAS_ORDERS (cùng allowlist banner /sell/my — KHÔNG throw ra error
 * boundary). SetNull FK (migration cùng batch) là belt-and-braces cho race
 * offer-xen-giữa-check-và-DELETE — unreachable hôm nay nhờ flag finance off.
 */
describe("b4-holistic-2 — deleteListingAction pre-check ExchangeOffer.myListingId (LOW)", () => {
  const seedOffer = (myListingId: string): void => {
    dbState.exchangeOffers.push({
      id: `eo-${dbState.exchangeOffers.length + 1}`,
      listingId: "listing-cua-nguoi-khac", // target listing (của seller khác)
      buyerId: "buyer-khac",
      myListingId, // listing CỦA seller này đưa ra đổi
      status: "proposed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  };

  it("approved + ExchangeOffer.myListingId → CHỈ ẨN (hidden), KHÔNG hard-delete (như OrderItem)", async () => {
    const seller = setupVerifiedSeller();
    const listing = seedListing(seller.id, "approved");
    seedOffer(listing.id);

    await expectRedirect(() => deleteListingAction(fd({ listingId: listing.id })));

    expect(listingRow(listing.id)).toMatchObject({ status: "hidden" });
    expect(dbState.listings).toHaveLength(1); // row SỐNG — FK không bị đâm
    expect(dbState.exchangeOffers).toHaveLength(1); // offer nguyên vẹn
  });

  it("hidden + ExchangeOffer.myListingId → NO-OP im lặng (b4-holistic round-3 — tin ĐÃ ẩn, xóa không còn nghĩa gì; KHÔNG hard-delete, KHÔNG throw, KHÔNG banner)", async () => {
    const seller = setupVerifiedSeller();
    const listing = seedListing(seller.id, "hidden");
    seedOffer(listing.id);

    // b4-holistic round-3 (verified fix): hidden + orders/offer → no-op
    // (Batch 3 behavior) — banner LISTING_HAS_ORDERS chỉ cho status CHƯA ẩn
    // (draft/pending/rejected — row sống sót, seller cần biết vì sao).
    await expectRedirect(() => deleteListingAction(fd({ listingId: listing.id })));

    expect(listingRow(listing.id)).toMatchObject({ status: "hidden" }); // GIỮ NGUYÊN
    expect(dbState.exchangeOffers).toHaveLength(1);
  });

  it("pending + ExchangeOffer.myListingId (KHÔNG có đơn) → redirect LISTING_HAS_ORDERS, row SỐNG SÓT", async () => {
    const seller = setupVerifiedSeller();
    const listing = seedListing(seller.id, "pending");
    seedOffer(listing.id);

    let redirected = false;
    try {
      await deleteListingAction(fd({ listingId: listing.id }));
    } catch (e) {
      const msg = (e as Error).message;
      if (!msg.startsWith("NEXT_REDIRECT:")) throw e;
      redirected = true;
      expect(msg).toBe("NEXT_REDIRECT:/sell/my?error=LISTING_HAS_ORDERS");
    }
    expect(redirected).toBe(true);

    expect(listingRow(listing.id)).toMatchObject({ status: "pending" }); // KHÔNG xóa, KHÔNG ẩn
  });

  it("KHÔNG có offer (chỉ dữ liệu mình tạo) → hard-delete như trước — pre-check KHÔNG over-block", async () => {
    const seller = setupVerifiedSeller();
    const listing = seedListing(seller.id, "pending");
    dbState.images.push({ id: "img-1", listingId: listing.id, url: "/uploads/a.jpg", sortOrder: 0 });

    await expectRedirect(() => deleteListingAction(fd({ listingId: listing.id })));

    expect(listingRow(listing.id)).toBeUndefined();
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

  it("CẢ NĂM guard (update/toggle/delete/draft/submit) + classification re-read gọi isModerationLocked — đúng 6 call sites", () => {
    const calls = listingsSrc.match(/isModerationLocked\(/g) ?? [];
    // 3 guard Batch 3 (update/toggle/delete) + 1 call site phân loại typed error
    // trong tx của updateListingAction (item 7 — re-read sau CAS 0 rows: takedown
    // → LISTING_MODERATION_LOCKED, admin duyệt/từ chối → LISTING_CONCURRENT_CHANGE)
    // + 2 guard Batch 4 Task 4 (saveListingDraftAction/submitListingAction — R5:
    // "rewire keeps these guards and adds the same check to saveListingAction
    // and submitListingAction"). Invariant giữ nguyên: mọi guard gọi helper từ
    // @/src/lib/moderation — KHÔNG hardcode status, KHÔNG raw .includes.
    expect(calls).toHaveLength(6);
  });

  it("KHÔNG hardcode chuỗi removed và KHÔNG raw .includes trên tuple trong listings.ts", () => {
    expect(listingsSrc).not.toContain('"removed"');
    expect(listingsSrc).not.toContain("'removed'");
    expect(listingsSrc).not.toContain("MODERATION_LOCKED_LISTING_STATUSES");
  });

  it("admin.ts approve/reject là CONDITIONAL pending-only writes (R5/R7 — .where({ id, status: \"pending\" }))", () => {
    // Batch 4 holistic review: CẢ HAI claim CAS theo `updatedAt: versionRaw` —
    // version ĐÃ REVIEW (hidden input từ review card), KHÔNG còn updatedAt
    // đọc tươi trong action (content đổi giữa render và click → 0 rows).
    const cas =
      adminSrc.match(
        /\.where\(\{ id: listingId, status: "pending", updatedAt: versionRaw \}\)/g,
      ) ?? [];
    expect(cas).toHaveLength(2); // approve + reject
    // KHÔNG còn CAS theo updatedAt đọc tươi trong action
    expect(adminSrc).not.toMatch(/updatedAt: listing\.updatedAt/);
  });
});
