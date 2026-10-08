/**
 * Listing searchTextNormalized maintenance (Batch 5 Task 4 — spec §5.7, S-4/S-5
 * + corrections 2026-10-08 item 13) — unit tests.
 *
 * Hợp đồng (plan Task 4 Step 1):
 *  - createListingAction / saveListingDraftAction (create + update draft) /
 *    updateListingAction ghi searchTextNormalized =
 *    normalizeSearchText(title + brand.name + model.name) — cột derived,
 *    luôn tính lại được (S-4); tên brand/model load CHỈ khi id non-null
 *    (corrections item 13 — đường legacy không brand/model KHÔNG đụng
 *    Brand/ProductModel: mock listing-lock.test.ts không có hai model đó);
 *  - submitListingAction backfill text TỪ DB ROW khi cột còn null (draft
 *    Batch-4-era) — tính TRƯỚC tx (corrections item 13), ghi cùng statement
 *    CAS với status/updatedAt; đã có text → KHÔNG đè;
 *  - listing không brand/model → title-only;
 *  - KHÔNG guard/gate nào bị đụng (S5): R5 isModerationLocked /
 *    assertListingPublishable / assertListingContentValid giữ nguyên — các
 *    suite Batch 2/3/4 (listing-draft-actions / listing-lock /
 *    publication-gate / listing-actions-images) pin lại hành vi đó.
 *
 * Cơ chế mock như tests/unit/listing-draft-actions.test.ts (Batch 4 recipe —
 * corrections item 12): session/rbac/policy/publication/images/audit GIỮ BẢN
 * THẬT, đăng nhập qua COOKIE THẬT trên store mock; db.client mock in-memory
 * đủ model cho 4 action paths. Expected values là literal TÍNH TAY (không
 * gọi normalizeSearchText trong test — cùng kiểu metrics-reconciliation).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

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

// ─── db.client mock — in-memory đủ model cho create/draft/update/submit ────────

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
import {
  createListingAction,
  saveListingDraftAction,
  submitListingAction,
  updateListingAction,
} from "@/src/lib/actions/listings";

// ─── Fixtures ────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

const UUID_IMG = "00000000-0000-4000-8000-0000000000dd";
const IMG_URL = `/uploads/${UUID_IMG}.webp`;
/** Ảnh seed /img/… đã GẮN (rule 2 attached compat) — cho form legacy. */
const LEGACY_IMG = "/img/listings/it-a.svg";

const CAT_BETA = {
  id: "cat-beta",
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
  categoryId: CAT_BETA.id,
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

/** Seller ĐỦ 8 yêu cầu policy v1 (mặc định) — case block bỏ từng mảnh. */
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
    reviewerId: null,
    reasonCode: "requirements_met",
    note: null,
    policyVersion: "v1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
};

/** Ảnh upload MỚI (Batch 4) thuộc seller — rule (1) pass. */
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

/** Listing fixture (mặc định BETA đầy đủ structured + 1 ảnh gắn slot front). */
const seedListing = (sellerId: string, status: string, over?: Partial<Row>): Row & { id: string } => {
  const row: Row & { id: string } = {
    id: `listing-${dbState.listings.length + 1}`,
    sellerId,
    categoryId: CAT_BETA.id,
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
    // Batch 5 cột derived/source — mặc định Batch-4-era (null = chưa có)
    searchTextNormalized: null,
    locationSource: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
  dbState.listings.push(row);
  return row;
};

/** Ảnh ĐÃ GẮN vào listing (rule 2 compat + rule 1 owned). */
const seedImage = (listingId: string, url: string, checklistSlot: string | null, sortOrder = 0): void => {
  dbState.images.push({
    id: `img-${dbState.images.length + 1}`,
    listingId,
    url,
    sortOrder,
    checklistSlot,
  });
};

const login = (user: Row, opts?: { isAdmin?: boolean }): string => {
  const id = `sess-${user.id}-${dbState.sessions.length + 1}`;
  const token = `token-${id}`;
  dbState.sessions.push({
    id,
    userId: user.id,
    tokenHash: createHash("sha256").update(token).digest("hex"),
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
 * Form beta HỢP LỆ đầy đủ (title fixture của plan Task 4 Step 1: brand "JBL",
 * model "Charge 5", title "Loa JBL Charge 5 như mới" → text
 * "loa jbl charge 5 nhu moi jbl charge 5").
 */
const betaForm = (over?: Record<string, string | string[]>): FormData =>
  fd({
    title: "Loa JBL Charge 5 như mới",
    description: "Loa bluetooth cũ còn tốt, pin trâu, nghe hay.",
    categoryId: CAT_BETA.id,
    brandId: BRAND.id,
    productModelId: MODEL.id,
    condition: "good",
    price: "1800000",
    negotiable: "on",
    inventoryContext: "used",
    provinceLevelCode: "ha-noi",
    locationDisplayName: "Khu vực Cầu Giấy",
    fulfillmentMethods: ["meetup"],
    images: [IMG_URL],
    imageSlots: ["front"],
    ...(over ?? {}),
  });

/**
 * Form edit legacy-shaped (corrections item 3): KHÔNG trường province, KHÔNG
 * brand/model, city free-text — mặc định ĐÚNG giá trị seed legacy → KHÔNG
 * content change (case carry-forward + title-only text).
 */
const legacyEditForm = (listingId: string, categoryId: string): FormData =>
  fd({
    listingId,
    title: "Loa thùng PA JBL Eon715 sự kiện",
    description: "Loa thùng PA cũ còn tốt, bass mạnh, dùng sự kiện ổn.",
    categoryId,
    condition: "good",
    price: "11200000",
    negotiable: "on",
    city: "Hà Nội",
    brandId: "",
    productModelId: "",
    images: [LEGACY_IMG],
  });

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

/** saveListingDraftAction CREATE redirect /sell/<id>/edit?saved=draft — parse id. */
const DRAFT_REDIRECT_RE = /^\/sell\/([^/]+)\/edit\?saved=draft$/;
async function createDraftExpectRedirect(form: FormData): Promise<string> {
  try {
    await saveListingDraftAction({}, form);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.startsWith("NEXT_REDIRECT:")) {
      const url = msg.slice("NEXT_REDIRECT:".length);
      const m = DRAFT_REDIRECT_RE.exec(url);
      if (!m) throw new Error(`draft redirect không đúng dạng: ${url}`);
      return m[1]!;
    }
    throw e;
  }
  throw new Error("expected NEXT_REDIRECT from draft create");
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AUTH_SECRET", "unit-test-auth-secret-0123456789abcdef");
  for (const arr of Object.values(dbState)) (arr as unknown[]).length = 0;
  dbState.categories.push({ ...CAT_BETA }, { ...CAT_LEGACY });
  dbState.brands.push({ ...BRAND });
  dbState.models.push({ ...MODEL });
  cookieState.store.clear();
  headerState.headers = new Headers();
  resetRateLimits();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── 1. createListingAction — normalized title+brand+model (plan Step 1) ────

describe("createListingAction — searchTextNormalized (Batch 5 Task 4, S-4)", () => {
  it("stores normalized title+brand+model text (exact string)", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    seedUpload(seller.id);
    login(seller);

    const url = await expectRedirect(() => createListingAction({}, betaForm()));
    expect(url).toBe("/sell/my?created=1");

    expect(dbState.listings).toHaveLength(1);
    // Tính tay: normalizeSearchText("Loa JBL Charge 5 như mới" + " " + "JBL" + " "
    // + "Charge 5") — stripDiacritics ("như"→nhu, "mới"→moi, đ→d riêng — B5) +
    // lowercase + collapse whitespace:
    expect(dbState.listings[0]).toMatchObject({
      status: "pending",
      searchTextNormalized: "loa jbl charge 5 nhu moi jbl charge 5",
    });
  });
});

// ─── 2. saveListingDraftAction — draft path hooked (S5) ───────────────────────

describe("saveListingDraftAction — draft path hooked (S5)", () => {
  it("stores the same normalized text on a NEW draft", async () => {
    const seller = mkUser({ id: "seller-fresh", role: "seller" });
    dbState.users.push(seller);
    seedUpload(seller.id);
    login(seller);

    await createDraftExpectRedirect(betaForm());

    expect(dbState.listings).toHaveLength(1);
    expect(dbState.listings[0]).toMatchObject({
      status: "draft",
      // cùng công thức với create path — title + brand.name + model.name
      searchTextNormalized: "loa jbl charge 5 nhu moi jbl charge 5",
    });
  });

  it("draft UPDATE đổi title → text mới THAY text cũ (cả hai nhánh được hook)", async () => {
    const seller = mkUser({ id: "seller-fresh", role: "seller" });
    dbState.users.push(seller);
    seedUpload(seller.id);
    login(seller);
    const draft = seedListing(seller.id, "draft", {
      title: "Loa JBL Charge 5 như mới",
      searchTextNormalized: "text cu cua lan ghi truoc",
    });
    seedImage(draft.id, IMG_URL, "front");

    const url = await expectRedirect(() =>
      saveListingDraftAction({}, betaForm({ listingId: draft.id })),
    );
    expect(url).toBe(`/sell/${draft.id}/edit?saved=draft`);

    expect(draft.status).toBe("draft");
    expect(draft.searchTextNormalized).toBe("loa jbl charge 5 nhu moi jbl charge 5");
  });
});

// ─── 3. updateListingAction — recompute khi content đổi (S-4) ─────────────────

describe("updateListingAction — recompute normalized text (S-4)", () => {
  it("title đổi → text mới THAY text cũ (approved → pending review — hành vi B3 giữ nguyên)", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    seedUpload(seller.id);
    const listing = seedListing(seller.id, "approved", {
      title: "Loa JBL Charge 5 chính hãng",
      searchTextNormalized: "stale text cua lan ghi cu",
    });
    seedImage(listing.id, IMG_URL, "front");
    login(seller);

    const url = await expectRedirect(() =>
      updateListingAction({}, betaForm({ listingId: listing.id })),
    );
    expect(url).toBe("/sell/my?updated=1");

    // content change → vào lại review (B3 — KHÔNG phải hành vi của Task 4)
    expect(listing.status).toBe("pending");
    // text mới theo title MỚI + brand/model của form
    expect(listing.searchTextNormalized).toBe("loa jbl charge 5 nhu moi jbl charge 5");
  });

  it("legacy edit KHÔNG brand/model → title-only text; carry-forward location GIỮ NGUYÊN (corrections item 3 không bị phá)", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    const listing = seedListing(seller.id, "approved", {
      categoryId: CAT_LEGACY.id,
      brandId: null,
      productModelId: null,
      title: "Loa thùng PA JBL Eon715 sự kiện",
      slug: "loa-thung-pa-jbl-eon715-su-kien",
      description: "Loa thùng PA cũ còn tốt, bass mạnh, dùng sự kiện ổn.",
      price: 11_200_000,
      negotiable: true,
      city: "Hà Nội",
      inventoryContext: null,
      fulfillmentMethods: null,
      provinceLevelCode: null,
      locationDisplayName: null,
      searchTextNormalized: null,
    });
    seedImage(listing.id, LEGACY_IMG, null);
    login(seller);

    const url = await expectRedirect(() =>
      updateListingAction({}, legacyEditForm(listing.id, CAT_LEGACY.id)),
    );
    expect(url).toBe("/sell/my?updated=1");

    // KHÔNG content change → KHÔNG re-queue oan (corrections item 3 — carry forward)
    expect(listing.status).toBe("approved");
    expect(listing.provinceLevelCode).toBeNull();
    expect(listing.locationSource).toBeNull();
    // KHÔNG brand/model → title-only: tính tay
    // normalizeSearchText("Loa thùng PA JBL Eon715 sự kiện") — "thùng"→thung,
    // "sự kiện"→su kien (đ→d riêng — B5 không áp dụng ở đây, không có đ):
    expect(listing.searchTextNormalized).toBe("loa thung pa jbl eon715 su kien");
  });
});

// ─── 4. submitListingAction — backfill text từ DB row (S-4/corrections 13) ────

describe("submitListingAction — backfill searchTextNormalized từ DB row (S-4)", () => {
  it("draft Batch-4-era (text NULL) → text tính TỪ row title+brand+model, ghi cùng CAS claim", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    seedUpload(seller.id);
    // draft Batch-4-era: title/brand/model do form Batch 4 ghi, cột Batch 5 còn null
    const draft = seedListing(seller.id, "draft", {
      title: "Loa JBL Charge 5 chính hãng",
      searchTextNormalized: null,
    });
    seedImage(draft.id, IMG_URL, "front");
    login(seller);

    const url = await expectRedirect(() => submitListingAction(fd({ listingId: draft.id })));
    expect(url).toBe("/sell/my?submitted=1");

    expect(draft.status).toBe("pending");
    // tính tay TỪ DB ROW: normalizeSearchText("Loa JBL Charge 5 chính hãng JBL Charge 5")
    // — "chính hãng"→chinh hang:
    expect(draft.searchTextNormalized).toBe("loa jbl charge 5 chinh hang jbl charge 5");
  });

  it("draft ĐÃ có text → KHÔNG đè (null-guard — text do saveListingDraftAction ghi giữ nguyên)", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    seedUpload(seller.id);
    const draft = seedListing(seller.id, "draft", {
      searchTextNormalized: "giu nguyen text nay",
    });
    seedImage(draft.id, IMG_URL, "front");
    login(seller);

    const url = await expectRedirect(() => submitListingAction(fd({ listingId: draft.id })));
    expect(url).toBe("/sell/my?submitted=1");

    expect(draft.status).toBe("pending");
    // null-guard: submit KHÔNG tính lại text đã có (S-4 — staleness do
    // --recompute-all lo, không phải submit)
    expect(draft.searchTextNormalized).toBe("giu nguyen text nay");
  });
});

// ─── 5. Listing không brand/model → title-only (plan Step 1 case cuối) ────────

describe("listing không brand/model → title-only (S-4)", () => {
  it("saveListingDraftAction form không brand/model → normalizeSearchText(title) — KHÔNG đụng Brand/ProductModel", async () => {
    const seller = mkUser({ id: "seller-fresh", role: "seller" });
    dbState.users.push(seller);
    seedUpload(seller.id);
    login(seller);

    await createDraftExpectRedirect(betaForm({ brandId: "", productModelId: "" }));

    expect(dbState.listings).toHaveLength(1);
    expect(dbState.listings[0]).toMatchObject({
      status: "draft",
      brandId: null,
      productModelId: null,
      // title-only: normalizeSearchText("Loa JBL Charge 5 như mới")
      searchTextNormalized: "loa jbl charge 5 nhu moi",
    });
  });
});
