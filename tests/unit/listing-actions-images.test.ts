/**
 * Listing actions — image ownership + structured writes (Batch 4 Task 4) — unit tests.
 *
 * Hợp đồng (plan Task 4 Step 1 — Review Focus 4 + item 8 + item 12):
 *  - createListingAction lưu checklistSlot per image (zip images × imageSlots,
 *    sortOrder preserved).
 *  - createListingAction chặn ảnh KHÔNG thuộc seller (rule 1 negative) — KHÔNG
 *    Listing/ListingImage write nào.
 *  - updateListingAction giữ ảnh seed ĐÃ GẮN (rule 2), chặn URL lạ mới thêm;
 *    ảnh /uploads/<uuid>.jpg pre-Batch-4 ĐÃ GẮN pass trên edit (B1 compat).
 *  - createListingAction set city = PROVINCE_CODES[provinceLevelCode] (canonical
 *    34-unit displayName — FD-1) — KHÔNG phải locationDisplayName (item 12).
 *  - createListingAction vẫn viết PriceHistory khi productModelId có (giữ nguyên).
 *  - create chạy trong MỘT db.transaction — Listing.slug 23505 THROW ra khỏi
 *    callback, classify NGOÀI tx (typed slug-collision error), KHÔNG partial
 *    image rows (Global Constraints — KHÔNG catch-and-return trong callback).
 *
 * Cơ chế mock như tests/unit/publication-gate.test.ts + seam beforeListingCreate
 * (mô phỏng unique violation 23505 race giữa pre-check slug và tx create).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { SqlQueryError } from "@prisma/orm-family-sql/errors";

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

// ─── db.client mock — in-memory + seam beforeListingCreate (23505 race) ────────

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
  notifications: [] as Array<Record<string, unknown>>,
  /**
   * Seam: chạy NGAY TRƯỚC Listing.create — mô phỏng unique violation 23505 trên
   * Listing.slug commit giữa pre-check slug và tx create (race hai request).
   */
  beforeListingCreate: null as null | (() => void),
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
      deleteAll: async () => {
        const hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        for (const r of hit) {
          const i = rows.indexOf(r);
          if (i >= 0) rows.splice(i, 1);
        }
        return hit.map((r) => ({ ...r }));
      },
      create: async (data: Row) => {
        if (rows === dbState.listings) dbState.beforeListingCreate?.();
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
    Notification: makeModel(dbState.notifications, () => ({
      id: `notif-${dbState.notifications.length + 1}`,
      body: null,
      link: null,
      readAt: null,
      createdAt: new Date().toISOString(),
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
import { createListingAction, updateListingAction } from "@/src/lib/actions/listings";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const sha256Hex = (v: string) => createHash("sha256").update(v).digest("hex");
type Row = Record<string, unknown>;

const UUID_IMG = "00000000-0000-4000-8000-0000000000dd";
const UUID_IMG_2 = "10000000-0000-4000-8000-0000000000ee";
const UUID_PRE_B4 = "11111111-1111-4111-8111-111111111111";
const IMG_URL = `/uploads/${UUID_IMG}.webp`;
const IMG_URL_2 = `/uploads/${UUID_IMG_2}.webp`;
const PRE_B4_URL = `/uploads/${UUID_PRE_B4}.jpg`; // upload pre-Batch-4 — KHÔNG có ownership row

const CATEGORY = {
  id: "cat-1",
  name: "Loa Bluetooth di động",
  slug: "portable_bluetooth_speaker",
  commissionRate: 5,
  sortOrder: 0,
  isActive: true,
  createdAt: "2026-09-01T00:00:00.000Z",
};
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
    reviewerId: null,
    reasonCode: "requirements_met",
    note: null,
    policyVersion: "v1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
};

const seedUpload = (ownerUserId: string, storageKey: string): void => {
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

const seedImage = (listingId: string, url: string, checklistSlot: string | null, sortOrder = 0): void => {
  dbState.images.push({
    id: `img-${dbState.images.length + 1}`,
    listingId,
    url,
    sortOrder,
    checklistSlot,
  });
};

/** Listing fixture (mặc định beta structured đầy đủ). */
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
  return row;
};

const login = (user: Row): string => {
  const id = `sess-${user.id}-${dbState.sessions.length + 1}`;
  const token = `token-${id}`;
  dbState.sessions.push({
    id,
    userId: user.id,
    tokenHash: sha256Hex(token),
    isAdmin: false,
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

/** Form create/update HỢP LỆ (beta structured + ảnh owned + slot). */
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

/** Seller đủ policy + đã login. */
const setupVerifiedSeller = (): Row & { id: string } => {
  const seller = mkVerifiedSeller();
  dbState.users.push(seller);
  seedPolicyRows(seller.id);
  seedUpload(seller.id, `${UUID_IMG}.webp`);
  login(seller);
  return seller;
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
  for (const arr of Object.values(dbState)) {
    if (Array.isArray(arr)) arr.length = 0;
  }
  dbState.beforeListingCreate = null;
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

// ─── 1. checklistSlot per image (zip theo index) ──────────────────────────────

describe("createListingAction — checklistSlot per image", () => {
  it("lưu checklistSlot theo index (zip images × imageSlots), sortOrder preserved", async () => {
    const seller = setupVerifiedSeller();
    seedUpload(seller.id, `${UUID_IMG_2}.webp`);

    await expectRedirect(() =>
      createListingAction(
        {},
        listingForm({ images: [IMG_URL, IMG_URL_2], imageSlots: ["front", "back"] }),
      ),
    );

    expect(dbState.listings).toHaveLength(1);
    expect(dbState.images).toHaveLength(2);
    expect(dbState.images[0]).toMatchObject({ url: IMG_URL, sortOrder: 0, checklistSlot: "front" });
    expect(dbState.images[1]).toMatchObject({ url: IMG_URL_2, sortOrder: 1, checklistSlot: "back" });
  });

  it("imageSlots vắng mặt → checklistSlot NULL (legacy form không gửi slot)", async () => {
    setupVerifiedSeller();

    await expectRedirect(() =>
      createListingAction(
        {},
        listingForm({ images: [IMG_URL], imageSlots: [] as string[] }),
      ),
    );

    expect(dbState.images).toHaveLength(1);
    expect(dbState.images[0]).toMatchObject({ url: IMG_URL, checklistSlot: null });
  });
});

// ─── 2. Rule (1) negative — ảnh không thuộc seller ───────────────────────────

describe("createListingAction — image ownership (rule 1 negative)", () => {
  it("ảnh /uploads/<uuid>.webp của user KHÁC → IMAGE_NOT_OWNED, KHÔNG Listing/ListingImage write", async () => {
    setupVerifiedSeller();
    // upload row thuộc user KHÁC (cross-account image theft)
    seedUpload("seller-victim", `${UUID_IMG_2}.webp`);

    const state = await createListingAction(
      {},
      listingForm({ images: [IMG_URL_2], imageSlots: ["front"] }),
    );

    expect(state.error).toContain("IMAGE_NOT_OWNED");
    expect(dbState.listings).toHaveLength(0);
    expect(dbState.images).toHaveLength(0);
    expect(dbState.priceHistory).toHaveLength(0);
  });

  it("ảnh /uploads/<uuid>.webp KHÔNG có ownership row (detached pre-Batch-4) → IMAGE_NOT_OWNED, KHÔNG write", async () => {
    setupVerifiedSeller();

    const state = await createListingAction(
      {},
      listingForm({ images: [PRE_B4_URL], imageSlots: ["front"] }),
    );

    expect(state.error).toContain("IMAGE_NOT_OWNED");
    expect(dbState.listings).toHaveLength(0);
    expect(dbState.images).toHaveLength(0);
  });
});

// ─── 3. Rule (2) — ảnh ĐÃ GẮN giữ nguyên trên edit (B1 compat) ────────────────

describe("updateListingAction — ảnh đã gắn (rule 2) + URL lạ mới (rule 3)", () => {
  it("ảnh seed /img/… ĐÃ GẮN được giữ nguyên trên edit legacy (rule 2)", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    login(seller);
    const listing = seedListing(seller.id, "approved", {
      categoryId: CAT_LEGACY.id,
      brandId: null,
      productModelId: null,
      inventoryContext: null,
      fulfillmentMethods: null,
      provinceLevelCode: null,
      locationDisplayName: null,
    });
    seedImage(listing.id, "/img/listings/seed-1.svg", null);

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
          images: ["/img/listings/seed-1.svg"],
          imageSlots: [] as string[],
          title: "Loa JBL Charge 5 chính hãng ĐỔI TIÊU ĐỀ",
        }),
      ),
    );

    expect(url).toContain("/sell/my?updated=1");
    expect(listing.status).toBe("pending"); // content-change → review lại
    expect(dbState.images.filter((i) => i["listingId"] === listing.id)).toHaveLength(1);
    expect(dbState.images[0]).toMatchObject({ url: "/img/listings/seed-1.svg" });
  });

  it("ảnh /uploads/<uuid>.jpg pre-Batch-4 ĐÃ GẮN (không ownership row) pass trên edit (B1 compat)", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    login(seller);
    const listing = seedListing(seller.id, "approved", {
      categoryId: CAT_LEGACY.id,
      brandId: null,
      productModelId: null,
      inventoryContext: null,
      fulfillmentMethods: null,
      provinceLevelCode: null,
      locationDisplayName: null,
    });
    seedImage(listing.id, PRE_B4_URL, null);

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
          images: [PRE_B4_URL],
          imageSlots: [] as string[],
          title: "Loa JBL Charge 5 chính hãng ĐỔI TIÊU ĐỀ",
        }),
      ),
    );

    expect(url).toContain("/sell/my?updated=1");
    expect(dbState.images.filter((i) => i["listingId"] === listing.id)).toHaveLength(1);
    expect(dbState.images[0]).toMatchObject({ url: PRE_B4_URL });
  });

  it("URL lạ MỚI THÊM (https://) → IMAGE_URL_INVALID, KHÔNG write ảnh", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    login(seller);
    const listing = seedListing(seller.id, "approved", {
      categoryId: CAT_LEGACY.id,
      brandId: null,
      productModelId: null,
      inventoryContext: null,
      fulfillmentMethods: null,
      provinceLevelCode: null,
      locationDisplayName: null,
    });
    seedImage(listing.id, "/img/listings/seed-1.svg", null);

    const state = await updateListingAction(
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
        images: ["/img/listings/seed-1.svg", "https://evil.example/x.jpg"],
        imageSlots: [] as string[],
      }),
    );

    expect(state.error).toContain("IMAGE_URL_INVALID");
    expect(listing.status).toBe("approved"); // KHÔNG transition — gate chặn trước tx
    expect(dbState.images.filter((i) => i["listingId"] === listing.id)).toHaveLength(1);
  });
});

// ─── 4. city = PROVINCE_CODES[provinceLevelCode] (item 12 — FD-1) ─────────────

describe("createListingAction — city canonical từ province registry (item 12)", () => {
  it("city = PROVINCE_CODES[provinceLevelCode] ('ho-chi-minh' → 'TP. Hồ Chí Minh') — KHÔNG phải locationDisplayName", async () => {
    setupVerifiedSeller();

    await expectRedirect(() =>
      createListingAction(
        {},
        listingForm({ provinceLevelCode: "ho-chi-minh", locationDisplayName: "Khu vực Quận 1" }),
      ),
    );

    expect(dbState.listings).toHaveLength(1);
    expect(dbState.listings[0]).toMatchObject({
      city: "TP. Hồ Chí Minh", // canonical displayName 34-unit registry (FD-1)
      provinceLevelCode: "ho-chi-minh",
      locationDisplayName: "Khu vực Quận 1", // hiển thị thô của seller — riêng cột khác
    });
  });
});

// ─── 5. PriceHistory giữ nguyên (existing behavior pin) ────────────────────────

describe("createListingAction — PriceHistory (giữ nguyên hành vi)", () => {
  it("productModelId có → viết PriceHistory kind 'listed' với giá listing", async () => {
    setupVerifiedSeller();

    await expectRedirect(() => createListingAction({}, listingForm()));

    expect(dbState.priceHistory).toHaveLength(1);
    expect(dbState.priceHistory[0]).toMatchObject({
      modelId: MODEL.id,
      listingId: dbState.listings[0]!.id,
      price: 1_800_000,
      kind: "listed",
    });
  });
});

// ─── 6. MỘT tx — 23505 Listing.slug classify NGOÀI (item 8) ───────────────────

describe("createListingAction — MỘT db.transaction, 23505 classify NGOÀI tx (Global Constraints)", () => {
  it("Listing.slug unique violation (23505) THROW ra khỏi callback → typed slug-collision form error, KHÔNG partial image rows", async () => {
    setupVerifiedSeller();
    // Race: request khác chèn slug trùng GIỮA pre-check slug và tx create
    dbState.beforeListingCreate = () => {
      throw new SqlQueryError("mock unique violation (Listing_slug_key)", {
        sqlState: "23505",
        constraint: "Listing_slug_key",
      });
    };

    const state = await createListingAction({}, listingForm());

    // classify NGOÀI tx → typed slug-collision error (KHÔNG silent-success)
    expect(state.error).toContain("LISTING_SLUG_COLLISION");
    // KHÔNG partial write — tx abort, ảnh/PriceHistory KHÔNG được viết
    expect(dbState.listings).toHaveLength(0);
    expect(dbState.images).toHaveLength(0);
    expect(dbState.priceHistory).toHaveLength(0);
  });

  it("lỗi KHÔNG phải 23505 (vd connection) → ném tiếp (fail closed — KHÔNG masquerade)", async () => {
    setupVerifiedSeller();
    dbState.beforeListingCreate = () => {
      throw new SqlQueryError("mock connection reset", { sqlState: "57P01" });
    };

    await expect(createListingAction({}, listingForm())).rejects.toThrowError(/connection reset/);
    expect(dbState.listings).toHaveLength(0);
  });
});
