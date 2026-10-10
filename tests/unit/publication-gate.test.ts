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
  verifications: [] as Array<Record<string, unknown>>,
  acceptances: [] as Array<Record<string, unknown>>,
  memberships: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
  adminAudits: [] as Array<Record<string, unknown>>,
  notifications: [] as Array<Record<string, unknown>>,
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

import { resetRateLimits } from "@/src/lib/rate-limit";
import { SESSION_COOKIE } from "@/src/lib/session";
import {
  createListingAction,
  updateListingAction,
  toggleListingVisibilityAction,
} from "@/src/lib/actions/listings";
import { approveListingAction } from "@/src/lib/actions/admin";

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

/** Seller ĐỦ 7 yêu cầu policy v1 (mặc định) — case block bỏ/thay từng mảnh. */
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

const CATEGORY = { id: "cat-1", name: "Loa bluetooth", slug: "loa-bluetooth", commissionRate: 5, sortOrder: 0, isActive: true, createdAt: "2026-09-01T00:00:00.000Z" };

/** Listing fixture của seller. */
const seedListing = (sellerId: string, status: string, over?: Partial<Row>): Row & { id: string } => {
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
    ...over,
  };
  dbState.listings.push(row);
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

const fd = (entries: Record<string, string>): FormData => {
  const form = new FormData();
  for (const [k, v] of Object.entries(entries)) form.set(k, v);
  return form;
};

/** createListing/updateListing formData HỢP LỆ (title/desc/price/city/images). */
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
  dbState.users.length = 0;
  dbState.sessions.length = 0;
  dbState.listings.length = 0;
  dbState.images.length = 0;
  dbState.categories.length = 0;
  dbState.verifications.length = 0;
  dbState.acceptances.length = 0;
  dbState.memberships.length = 0;
  dbState.audits.length = 0;
  dbState.adminAudits.length = 0;
  dbState.notifications.length = 0;
  dbState.users.push({ ...ADMIN_OPS });
  dbState.categories.push({ ...CATEGORY });
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

    await approveListingAction(fd({ listingId: listing.id }));

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

    await approveListingAction(fd({ listingId: listing.id }));

    expect(listing.status).toBe("pending");
    const evt = dbState.audits.find((r) => r.action === "listing.approve_blocked");
    expect(evt!.detail).toContain("founding_seller_membership_active");
  });

  it("seller đủ policy → approve + audit 'listing.approved' + legacy audit + notify", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    const listing = seedListing(seller.id, "pending");
    login(ADMIN_OPS, { isAdmin: true });

    await approveListingAction(fd({ listingId: listing.id }));

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

    await approveListingAction(fd({ listingId: listing.id }));

    expect(listing.status).toBe("approved");
    expect(dbState.audits.filter((r) => r.action === "listing.approve_blocked")).toHaveLength(0);
    expect(dbState.audits.filter((r) => r.action === "listing.approved")).toHaveLength(0);
  });
});
