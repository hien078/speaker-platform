/**
 * Listing draft/submit actions (Batch 4 Task 4 — spec §4.4/§5.6.2/§6.3) — unit tests.
 *
 * Hợp đồng (plan Task 4 Step 1):
 *  - saveListingDraftAction: draft được phép TRƯỚC verification (spec §4.4 —
 *    KHÔNG gọi seller gate; counting wrapper trên @/src/lib/seller-verification-policy
 *    = 0 assertSellerPublicationAllowed calls), rate-limited, image-ownership-validated
 *    (rule 1/2/3 — 0 ảnh OK), R5-guarded (isModerationLocked), category ∈ allowlist,
 *    city = PROVINCE_CODES[provinceLevelCode] (cột non-null), audit
 *    listing.draft_created/listing.draft_updated.
 *  - submitListingAction: đường draft→pending DUY NHẤT — full gate
 *    assertListingPublishable (seller + category + schema + model + images) với
 *    input XÂY TỪ DB ROW (formData CHỈ mang listingId — trust boundary), CAS
 *    .where({ id, status: "draft" }), audit listing.submitted (policyVersion)
 *    / listing.submit_blocked; redirect NGOÀI catch (Global Constraints).
 *  - IDOR: listingId từ formData → ownership check TRƯỚC mọi read ảnh/category
 *    và mọi write (seller khác → silent return, KHÔNG audit row hé lộ listing).
 *  - ?error= chỉ chứa typed code từ allowlist cố định — giá trị lạ/forged →
 *    CONTENT_INVALID (generic).
 *
 * Cơ chế mock như tests/unit/publication-gate.test.ts (session/rbac/policy GIỮ
 * BẢN THẬT — login qua COOKIE THẬT, gate đọc FRESH từ store mock) + counting
 * wrappers cross-module (Global Constraints — spy cùng registry không works).
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

// ─── db.client mock — in-memory đủ model cho draft/submit actions ─────────────

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

// ─── Counting wrappers (cross-module — Global Constraints recipe) ────────────

const gateState = vi.hoisted(() => ({
  sellerGateCalls: 0,
  publishableCalls: 0,
  contentValidCalls: 0,
  /** Khi ≠ null: wrapper assertListingPublishable THROW giá trị này thay vì chạy thật. */
  failPublishWith: null as string | null,
  /** Side-effect chạy khi assertListingPublishable được gọi (mô phỏng race đổi row). */
  onPublishable: null as null | (() => void),
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
  };
});

/** Side-effect khi assertListingImagesOwned chạy — mô phỏng status đổi giữa
 *  read và CAS của saveListingDraftAction (draft path không gọi publication gate). */
const imagesHook = vi.hoisted(() => ({ onOwned: null as null | (() => void) }));

vi.mock("@/src/lib/listing-images", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/lib/listing-images")>();
  return {
    ...actual,
    assertListingImagesOwned: async (...args: Parameters<typeof actual.assertListingImagesOwned>) => {
      imagesHook.onOwned?.();
      return actual.assertListingImagesOwned(...args);
    },
  };
});

import { resetRateLimits } from "@/src/lib/rate-limit";
import { SESSION_COOKIE } from "@/src/lib/session";
import {
  saveListingDraftAction,
  submitListingAction,
  updateListingAction,
} from "@/src/lib/actions/listings";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (p: string): string => readFileSync(join(root, p), "utf8");
const sha256Hex = (v: string) => createHash("sha256").update(v).digest("hex");
type Row = Record<string, unknown>;

const UUID_IMG = "00000000-0000-4000-8000-0000000000dd";
const IMG_URL = `/uploads/${UUID_IMG}.webp`;

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
const seedPolicyRows = (sellerId: string, over?: { verificationStatus?: string }): void => {
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
    status: over?.verificationStatus ?? "verified",
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

/** Episode đình chỉ ACTIVE (yêu cầu thứ 8 — spec §7.8). */
const seedSuspension = (userId: string): void => {
  dbState.suspensions.push({
    id: `susp-${dbState.suspensions.length + 1}`,
    userId,
    status: "active",
    reasonCode: "confirmed_abuse",
    note: null,
    suspendedById: null,
    suspendedAt: new Date().toISOString(),
    liftedById: null,
    liftedAt: null,
    liftReasonCode: null,
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

/** Listing fixture (mặc định DRAFT đầy đủ structured beta + 1 ảnh gắn). */
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

/** Form draft/submit HỢP LỆ đầy đủ (beta structured + ảnh owned + slot). */
const betaForm = (over?: Record<string, string | string[]>): FormData =>
  fd({
    title: "Loa JBL Charge 5 chính hãng",
    categoryId: CAT_BETA.id,
    condition: "good",
    price: "1800000",
    description: "Loa bluetooth cũ còn tốt, pin trâu, nghe hay.",
    brandId: BRAND.id,
    productModelId: MODEL.id,
    inventoryContext: "used",
    provinceLevelCode: "ha-noi",
    locationDisplayName: "Khu vực Cầu Giấy",
    fulfillmentMethods: ["meetup"],
    images: [IMG_URL],
    imageSlots: ["front"],
    ...(over ?? {}),
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

const auditsOf = (action: string): Row[] => dbState.audits.filter((r) => r["action"] === action);

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AUTH_SECRET", "unit-test-auth-secret-0123456789abcdef");
  for (const arr of Object.values(dbState)) (arr as unknown[]).length = 0;
  gateState.sellerGateCalls = 0;
  gateState.publishableCalls = 0;
  gateState.contentValidCalls = 0;
  gateState.failPublishWith = null;
  gateState.onPublishable = null;
  imagesHook.onOwned = null;
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

// ─── 1. saveListingDraftAction — draft TRƯỚC verification (spec §4.4) ─────────

/** Tạo draft MỚI: action redirect sang /sell/<id>/edit?saved=draft (NGOÀI try) —
 *  trả url redirect để test assert. b4-holistic round-4: draft UPDATE cũng
 *  redirect ?saved=draft (URL sạch — ?error= của submit lần trước không dính). */
async function createDraftExpectRedirect(form: FormData): Promise<string> {
  try {
    await saveListingDraftAction({}, form);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.startsWith("NEXT_REDIRECT:")) return msg.slice("NEXT_REDIRECT:".length);
    throw e;
  }
  throw new Error("expected NEXT_REDIRECT from draft create");
}

describe("saveListingDraftAction — draft được phép trước verification", () => {
  it("seller CHƯA xác minh VẪN tạo được draft — KHÔNG gọi seller gate (0 assertSellerPublicationAllowed)", async () => {
    const seller = mkUser({ id: "seller-fresh", role: "seller" });
    dbState.users.push(seller);
    seedUpload(seller.id); // ảnh upload thuộc seller — rule (1) pass
    login(seller);

    const url = await createDraftExpectRedirect(betaForm());

    expect(dbState.listings).toHaveLength(1);
    expect(url).toBe(`/sell/${dbState.listings[0]!.id}/edit?saved=draft`);
    expect(dbState.listings[0]).toMatchObject({
      sellerId: seller.id,
      status: "draft",
      categoryId: CAT_BETA.id,
      inventoryContext: "used",
      provinceLevelCode: "ha-noi",
      // city = canonical displayName của province (item 12) — KHÔNG phải text tự do
      city: "Hà Nội",
    });
    expect(dbState.images).toHaveLength(1);
    expect(dbState.images[0]).toMatchObject({ url: IMG_URL, sortOrder: 0, checklistSlot: "front" });
    // draft-behavior gate: KHÔNG seller gate (spec §4.4)
    expect(gateState.sellerGateCalls).toBe(0);
    expect(gateState.publishableCalls).toBe(0);
    // audit listing.draft_created
    expect(auditsOf("listing.draft_created")).toHaveLength(1);
    expect(auditsOf("listing.draft_created")[0]).toMatchObject({
      actorId: seller.id,
      resourceType: "Listing",
      resourceId: dbState.listings[0]!.id,
    });
  });

  it("draft KHÔNG công khai: row status draft + mọi public surface filter approved (source contract)", async () => {
    const seller = mkUser({ id: "seller-fresh", role: "seller" });
    dbState.users.push(seller);
    seedUpload(seller.id);
    login(seller);

    await createDraftExpectRedirect(betaForm());

    // (action-level) draft row mang status "draft" — KHÔNG phải pending/approved
    expect(dbState.listings[0]).toMatchObject({ status: "draft" });
    // (source contract) public listing query lọc approved — RETARGET Batch 5
    // Task 7 (S-21): app/listings/page.tsx giờ chạy qua seam
    // SEARCHABLE_LISTING_STATUSES của src/lib/search-query.ts (không còn
    // .where({ status }) trực tiếp ở trang). Invariant KHÔNG yếu đi: seam pin
    // "chỉ approved searchable" + drift test liệt kê MỌI giá trị listing_status
    // từ contract (tests/unit/search-query.test.ts) + trang tiêu thụ seam đó.
    expect(read("src/lib/search-query.ts")).toContain(
      'export const SEARCHABLE_LISTING_STATUSES = ["approved"] as const',
    );
    expect(read("src/lib/search-query.ts")).toContain("export function isListingSearchable");
    expect(read("src/lib/search-query.ts")).toContain(".where((l) => l.status.in([...plan.statuses]))");
    expect(read("app/listings/page.tsx")).toContain("runSearchWithTelemetry");
    // detail page: chỉ render approved trừ owner/admin (gate hiện có)
    expect(read("app/listings/[slug]/page.tsx")).toContain('listing.status !== "approved"');
    // home / model / compare / related — đều approved-only
    expect(read("app/page.tsx")).toContain('{ status: "approved" }');
    expect(read("app/models/[slug]/page.tsx")).toContain('status: "approved"');
    expect(read("app/compare/page.tsx")).toContain('.where({ status: "approved" })');
    expect(read("app/listings/[slug]/page.tsx")).toContain('.where({ status: "approved", categoryId: listing.category!.id })');
  });

  it("draft MỚI trong category legacy → CATEGORY_NOT_PUBLICATION_ALLOWED, KHÔNG row", async () => {
    const seller = mkUser({ id: "seller-fresh", role: "seller" });
    dbState.users.push(seller);
    login(seller);

    const state = await saveListingDraftAction({}, betaForm({ categoryId: CAT_LEGACY.id }));

    expect(state.error).toContain("CATEGORY_NOT_PUBLICATION_ALLOWED");
    expect(dbState.listings).toHaveLength(0);
    expect(dbState.images).toHaveLength(0);
  });

  it("draft UPDATE: giữ nguyên category beta → pass + audit listing.draft_updated; đổi RA khỏi allowlist → CATEGORY_NOT_PUBLICATION_ALLOWED", async () => {
    const seller = mkUser({ id: "seller-fresh", role: "seller" });
    dbState.users.push(seller);
    seedUpload(seller.id);
    login(seller);
    const draft = seedListing(seller.id, "draft");
    seedImage(draft.id, IMG_URL, "front");

    // giữ nguyên category beta — draft update pass
    // b4-holistic round-4: nhánh update redirect ?saved=draft (URL sạch —
    // ?error= của submit lần trước không dính lại sau lưu nháp thành công).
    const updateUrl = await expectRedirect(() =>
      saveListingDraftAction(
        {},
        betaForm({ listingId: draft.id, title: "Loa JBL Charge 5 chính hãng SỬA NHÁP" }),
      ),
    );
    expect(updateUrl).toBe(`/sell/${draft.id}/edit?saved=draft`);
    expect(draft.title).toBe("Loa JBL Charge 5 chính hãng SỬA NHÁP");
    expect(dbState.listings).toHaveLength(1); // update — KHÔNG tạo draft trùng
    expect(draft.status).toBe("draft");
    expect(auditsOf("listing.draft_updated")).toHaveLength(1);

    // đổi category RA khỏi allowlist → chặn (chỉ được đổi INTO allowlist)
    const state2 = await saveListingDraftAction(
      {},
      betaForm({ listingId: draft.id, categoryId: CAT_LEGACY.id }),
    );
    expect(state2.error).toContain("CATEGORY_NOT_PUBLICATION_ALLOWED");
    expect(draft.categoryId).toBe(CAT_BETA.id); // KHÔNG write
  });

  it("draft UPDATE thua CAS (status đổi giữa read và write) → typed LISTING_CONCURRENT_CHANGE, KHÔNG write, KHÔNG ok", async () => {
    const seller = mkUser({ id: "seller-fresh", role: "seller" });
    dbState.users.push(seller);
    seedUpload(seller.id);
    login(seller);
    const draft = seedListing(seller.id, "draft");
    seedImage(draft.id, IMG_URL, "front");
    imagesHook.onOwned = () => {
      (draft as Row).status = "pending";
    };

    const state = await saveListingDraftAction(
      {},
      betaForm({ listingId: draft.id, title: "Loa JBL Charge 5 chính hãng SỬA NHÁP" }),
    );

    expect(state.error).toContain("LISTING_CONCURRENT_CHANGE");
    expect(state.ok).toBeUndefined();
    expect(draft.title).toBe("Loa JBL Charge 5 chính hãng");
    expect(auditsOf("listing.draft_updated")).toHaveLength(0);
  });

  it("draft UPDATE trên listing của seller KHÁC → silent return (IDOR — không write, không audit)", async () => {
    const other = mkUser({ id: "seller-other", role: "seller" });
    dbState.users.push(other);
    login(other);
    const victim = seedListing("seller-victim", "draft");
    seedImage(victim.id, IMG_URL, "front");

    const state = await saveListingDraftAction(
      {},
      betaForm({ listingId: victim.id, title: "Loa JBL Charge 5 bị đổi tên" }),
    );

    // silent return — KHÔNG error (form state rỗng), KHÔNG write, KHÔNG audit
    expect(state.error).toBeUndefined();
    expect(state.ok).toBeUndefined(); // KHÔNG banner "Đã lưu nháp" giả
    expect(victim.title).toBe("Loa JBL Charge 5 chính hãng");
    expect(auditsOf("listing.draft_updated")).toHaveLength(0);
  });

  it("draft UPDATE trên listing KHÔNG phải draft (approved) → typed form error LISTING_CONCURRENT_CHANGE (b4-holistic — KHÔNG silent drop edits)", async () => {
    const seller = mkUser({ id: "seller-fresh", role: "seller" });
    dbState.users.push(seller);
    login(seller);
    const approved = seedListing(seller.id, "approved");
    seedImage(approved.id, IMG_URL, "front");

    // Trước fix: return {} im lặng — form draft stale (submit ở tab khác) hiện
    // KHÔNG error, KHÔNG banner → edits bị drop âm thầm. Sau fix: typed error
    // hiển thị qua banner state.error của PortableListingForm.
    const state = await saveListingDraftAction(
      {},
      betaForm({ listingId: approved.id, title: "Loa JBL Charge 5 bị đổi tên" }),
    );

    expect(state.error).toContain("LISTING_CONCURRENT_CHANGE");
    expect(state.error).toContain("Tin vừa thay đổi trạng thái");
    expect(state.ok).toBeUndefined();
    expect(approved.status).toBe("approved");
    expect(approved.title).toBe("Loa JBL Charge 5 chính hãng");
    expect(auditsOf("listing.draft_updated")).toHaveLength(0);
  });

  it("draft image URLs theo rule (1)/(2)/(3): URL lạ → typed error không row; scheme URL có basename là upload của CHÍNH seller → IMAGE_URL_INVALID (rule-1 bypass)", async () => {
    const seller = mkUser({ id: "seller-fresh", role: "seller" });
    dbState.users.push(seller);
    seedUpload(seller.id);
    login(seller);

    // (3) URL ngoài chưa gắn → IMAGE_URL_INVALID
    const state1 = await saveListingDraftAction(
      {},
      betaForm({ images: ["https://evil.example/x.jpg"], imageSlots: ["front"] }),
    );
    expect(state1.error).toContain("IMAGE_URL_INVALID");
    expect(dbState.listings).toHaveLength(0);

    // rule-1 basename bypass: scheme URL có basename = upload của chính seller
    const state2 = await saveListingDraftAction(
      {},
      betaForm({ images: [`https://evil.example/x/${UUID_IMG}.webp`], imageSlots: ["front"] }),
    );
    expect(state2.error).toContain("IMAGE_URL_INVALID");
    expect(dbState.listings).toHaveLength(0);
    expect(dbState.images).toHaveLength(0);
  });

  it("draft 0 ảnh HỢP LỆ (≥1 ảnh là rule của submit, không phải của draft)", async () => {
    const seller = mkUser({ id: "seller-fresh", role: "seller" });
    dbState.users.push(seller);
    login(seller);

    await createDraftExpectRedirect(
      betaForm({ images: [] as string[], imageSlots: [] as string[] }),
    );

    expect(dbState.listings).toHaveLength(1);
    expect(dbState.images).toHaveLength(0);
  });

  it("draft thiếu province → PROVINCE_REQUIRED (city derive từ province — cột non-null, item 12)", async () => {
    const seller = mkUser({ id: "seller-fresh", role: "seller" });
    dbState.users.push(seller);
    login(seller);

    const state = await saveListingDraftAction(
      {},
      betaForm({ provinceLevelCode: "" }),
    );

    expect(state.error).toContain("PROVINCE_REQUIRED");
    expect(dbState.listings).toHaveLength(0);
  });

  it("LOW 2 — draft province LẠ (không thuộc 34 mã registry) → typed PROVINCE_INVALID, KHÔNG text không code", async () => {
    const seller = mkUser({ id: "seller-fresh", role: "seller" });
    dbState.users.push(seller);
    login(seller);

    const state = await saveListingDraftAction(
      {},
      betaForm({ provinceLevelCode: "khong-ton-tai" }),
    );

    expect(state.error).toContain("PROVINCE_INVALID");
    expect(dbState.listings).toHaveLength(0);
  });

  it("saveListingDraftAction trên listing bị moderation takedown → typed form error LISTING_MODERATION_LOCKED (R5 — KHÔNG throw ra error boundary)", async () => {
    const seller = mkUser({ id: "seller-fresh", role: "seller" });
    dbState.users.push(seller);
    login(seller);
    const takenDown = seedListing(seller.id, "removed");

    // b4-holistic round-3: useActionState action KHÔNG throw — typed form error
    // hiển thị qua banner state.error (trước fix: error boundary thay cả form).
    const state = await saveListingDraftAction({}, betaForm({ listingId: takenDown.id }));
    expect(state.error).toContain("LISTING_MODERATION_LOCKED");
    expect(takenDown.status).toBe("removed");
  });
});

// ─── 2. submitListingAction — đường draft→pending duy nhất, full gate ─────────

describe("submitListingAction — draft→pending sau full gate (spec §4.4/§5.6.2)", () => {
  it("verified seller + draft đầy đủ → status pending (CAS claim trên draft) + audit listing.submitted kèm policyVersion", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    seedUpload(seller.id);
    const draft = seedListing(seller.id, "draft");
    seedImage(draft.id, IMG_URL, "front");
    login(seller);

    // b4-holistic: submit thành công redirect /sell/my?submitted=1 (confirmation)
    const url = await expectRedirect(() => submitListingAction(fd({ listingId: draft.id })));
    expect(url).toBe("/sell/my?submitted=1");

    expect(draft.status).toBe("pending");
    const evt = auditsOf("listing.submitted")[0]!;
    expect(evt).toMatchObject({
      actorId: seller.id,
      subjectId: seller.id,
      resourceType: "Listing",
      resourceId: draft.id,
      policyVersion: "v1", // SELLER_RULES_POLICY_VERSION (§4.6)
    });
    expect(auditsOf("listing.submit_blocked")).toHaveLength(0);
    // full gate chạy MỘT lần (per-path pin)
    expect(gateState.publishableCalls).toBe(1);
  });

  it("draft của seller KHÁC → silent return (IDOR): status unchanged, KHÔNG audit row hé lộ listing", async () => {
    const other = mkUser({ id: "seller-other", role: "seller" });
    dbState.users.push(other);
    login(other);
    const victim = seedListing("seller-victim", "draft");
    seedImage(victim.id, IMG_URL, "front");

    await submitListingAction(fd({ listingId: victim.id }));

    expect(victim.status).toBe("draft");
    expect(dbState.audits).toHaveLength(0); // KHÔNG audit — không hé lộ existence
  });

  it("seller CHƯA xác minh → redirect /sell/verification, status GIỮ draft, audit listing.submit_blocked — redirect() NGOÀI catch", async () => {
    const seller = mkUser({ id: "seller-fresh", role: "seller" });
    dbState.users.push(seller);
    const draft = seedListing(seller.id, "draft");
    seedImage(draft.id, IMG_URL, "front");
    login(seller);

    const url = await expectRedirect(() => submitListingAction(fd({ listingId: draft.id })));

    expect(url).toBe("/sell/verification");
    expect(draft.status).toBe("draft"); // KHÔNG transition
    const evt = auditsOf("listing.submit_blocked")[0]!;
    expect(evt).toMatchObject({
      actorId: seller.id,
      resourceType: "Listing",
      resourceId: draft.id,
    });
    expect(String(evt.reason)).toContain("SELLER_PUBLICATION_BLOCKED");
    // source contract: catch block chỉ capture + audit — KHÔNG redirect trong catch
    const src = read("src/lib/actions/listings.ts");
    const fnSrc = src.slice(src.indexOf("export async function submitListingAction"));
    const catchIdx = fnSrc.indexOf("} catch (e) {");
    expect(catchIdx).toBeGreaterThan(-1);
    let depth = 0;
    let end = -1;
    for (let i = fnSrc.indexOf("{", catchIdx); i < fnSrc.length; i++) {
      if (fnSrc[i] === "{") depth++;
      else if (fnSrc[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const catchBody = fnSrc.slice(catchIdx, end);
    expect(catchBody).not.toContain("redirect("); // Global Constraints
    expect(catchBody).toContain("auditEvent"); // capture + audit trong catch
  });

  it("seller bị đình chỉ (UserSuspension active — yêu cầu thứ 8) → /sell/verification + audit reason chứa account_not_suspended", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    seedSuspension(seller.id);
    const draft = seedListing(seller.id, "draft");
    seedImage(draft.id, IMG_URL, "front");
    login(seller);

    const url = await expectRedirect(() => submitListingAction(fd({ listingId: draft.id })));

    expect(url).toBe("/sell/verification");
    expect(draft.status).toBe("draft");
    expect(String(auditsOf("listing.submit_blocked")[0]!.reason)).toContain("account_not_suspended");
  });

  it("content failure (MODEL_INVALID — model pending) → redirect /sell/<id>/edit?error=MODEL_INVALID", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    seedUpload(seller.id);
    dbState.models.push({ ...MODEL, id: "model-pending", status: "pending" });
    const draft = seedListing(seller.id, "draft", { productModelId: "model-pending" });
    seedImage(draft.id, IMG_URL, "front");
    login(seller);

    const url = await expectRedirect(() => submitListingAction(fd({ listingId: draft.id })));

    expect(url).toBe(`/sell/${draft.id}/edit?error=MODEL_INVALID`);
    expect(draft.status).toBe("draft");
    expect(String(auditsOf("listing.submit_blocked")[0]!.reason)).toBe("MODEL_INVALID");
  });

  it("LOW 3 — giá trị error lạ/forged (KHÔNG phải policy code) → NÉM TIẾP (fail closed visible): KHÔNG redirect ?error=, KHÔNG audit reason chứa free text", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    const draft = seedListing(seller.id, "draft");
    seedImage(draft.id, IMG_URL, "front");
    login(seller);
    gateState.failPublishWith = "weird driver text with <script>alert(1)</script> and PII x@y.vn";

    // Lỗi lạ (không phải seller-gate/content code) → propagate — KHÔNG
    // masquerade thành redirect CONTENT_INVALID (che khuất lỗi infra).
    await expect(
      submitListingAction(fd({ listingId: draft.id })),
    ).rejects.toThrowError(/weird driver text/);
    expect(draft.status).toBe("draft");
    // KHÔNG audit — free text/PII KHÔNG bao giờ vào reason/detail
    expect(dbState.audits).toHaveLength(0);
  });

  it("input XÂY TỪ DB ROW, KHÔNG tin formData (title/category forged trong formData bị bỏ qua)", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    seedUpload(seller.id);
    // DB row: title 7 ký tự (TITLE_INVALID) + category legacy
    const draft = seedListing(seller.id, "draft", {
      title: "abc",
      categoryId: CAT_LEGACY.id,
      brandId: null,
      productModelId: null,
      inventoryContext: null,
      fulfillmentMethods: null,
      provinceLevelCode: null,
      locationDisplayName: null,
    });
    seedImage(draft.id, IMG_URL, null);
    login(seller);

    // formData forged: title hợp lệ + category beta — bị BỎ QUA (formData chỉ mang listingId)
    const url = await expectRedirect(() =>
      submitListingAction(
        fd({
          listingId: draft.id,
          title: "Loa JBL Charge 5 hợp lệ đầy đủ ký tự",
          categoryId: CAT_BETA.id,
        }),
      ),
    );

    // DB row (title 7 ký tự) được validate → TITLE_INVALID — KHÔNG phải giá trị formData
    expect(url).toBe(`/sell/${draft.id}/edit?error=TITLE_INVALID`);
    expect(draft.status).toBe("draft");
  });

  it("status KHÔNG phải draft (pending/approved) → silent return (không double-submit)", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    seedUpload(seller.id);
    const pending = seedListing(seller.id, "pending");
    seedImage(pending.id, IMG_URL, "front");
    login(seller);

    await submitListingAction(fd({ listingId: pending.id }));

    expect(pending.status).toBe("pending");
    expect(dbState.audits).toHaveLength(0); // KHÔNG audit — không phải block, chỉ no-op
  });

  it("submit trên listing bị moderation takedown → redirect typed code LISTING_MODERATION_LOCKED (R5 — KHÔNG throw ra error boundary)", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    const takenDown = seedListing(seller.id, "removed");
    login(seller);

    // b4-holistic round-3: void form action KHÔNG throw — redirect typed code
    // trong allowlist banner /sell/my (trước fix: generic error page).
    const url = await expectRedirect(() => submitListingAction(fd({ listingId: takenDown.id })));
    expect(url).toBe("/sell/my?error=LISTING_MODERATION_LOCKED");
    expect(takenDown.status).toBe("removed");
  });

  it("racing status change (status đổi tay giữa read và claim) → CAS 0 rows → redirect ?error=CONCURRENT_CHANGE, KHÔNG partial write", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    seedUpload(seller.id);
    const draft = seedListing(seller.id, "draft");
    seedImage(draft.id, IMG_URL, "front");
    login(seller);
    // Race: request khác đổi status NGAY TRONG lúc gate chạy (trước CAS)
    gateState.onPublishable = () => {
      (draft as Row).status = "pending";
    };

    // MEDIUM 1 review fix: CAS 0 rows → THROW ra khỏi callback, classify NGOÀI
    // tx → redirect ?error=CONCURRENT_CHANGE (typed code trong allowlist) —
    // KHÔNG còn néM 500 ra action.
    const url = await expectRedirect(() => submitListingAction(fd({ listingId: draft.id })));
    expect(url).toBe(`/sell/${draft.id}/edit?error=CONCURRENT_CHANGE`);
    // KHÔNG audit submitted — tx throw trước auditEventTx
    expect(auditsOf("listing.submitted")).toHaveLength(0);
  });

  it("MEDIUM 1 — content-swap race: saveListingDraftAction commit content MỚI giữa gate và claim (updatedAt bump) → CAS 0 rows → ?error=CONCURRENT_CHANGE, status GIỮ draft (content mới KHÔNG vào pending ungated)", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    seedUpload(seller.id);
    const draft = seedListing(seller.id, "draft");
    seedImage(draft.id, IMG_URL, "front");
    login(seller);
    // Race: draft-save song song commit content mới (updateAll tự bump
    // updatedAt — execution default onUpdate timestampNow) NGAY TRONG lúc gate
    // chạy → claim theo updatedAt đọc TRƯỚC gate thua.
    gateState.onPublishable = () => {
      (draft as Row).updatedAt = "2026-10-07T01:23:45.678Z";
      (draft as Row).title = "Loa JBL Charge 5 chính hãng CONTENT MỚI CHƯA GATE";
    };

    const url = await expectRedirect(() => submitListingAction(fd({ listingId: draft.id })));

    expect(url).toBe(`/sell/${draft.id}/edit?error=CONCURRENT_CHANGE`);
    // status GIỮ draft — content mới KHÔNG vào pending ungated
    expect(draft.status).toBe("draft");
    expect(draft.title).toBe("Loa JBL Charge 5 chính hãng CONTENT MỚI CHƯA GATE");
    expect(auditsOf("listing.submitted")).toHaveLength(0);
  });

  it("LOW 4 — listingId malformed (không URL-safe) → silent return TRƯỚC rate-limit redirect: KHÔNG redirect phản ánh input, KHÔNG db read, KHÔNG audit", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    const draft = seedListing(seller.id, "draft");
    seedImage(draft.id, IMG_URL, "front");
    login(seller);
    // tiêu hết bucket rate limit — redirect rate-limit là đường PHẢN CHẠNH
    // listingId vào URL; malformed phải bị chặn TRƯỚC đó. (Lần đầu redirect
    // ?submitted=1 — b4-holistic; các lần sau no-op im lặng.)
    for (let i = 0; i < 20; i++) {
      await expectRedirect(() => submitListingAction(fd({ listingId: draft.id })));
    }
    expect(draft.status).toBe("pending");
    dbState.audits.length = 0; // dọn audit của 20 lần setup — chỉ đếm lần malformed

    // malformed listingId — KHÔNG throw NEXT_REDIRECT (silent return)
    const url = await expectRedirect(() =>
      submitListingAction(fd({ listingId: "../../admin\\x?injection#frag" })),
    );
    expect(url).toBe(""); // KHÔNG redirect — input KHÔNG bao giờ vào URL
    expect(dbState.audits).toHaveLength(0); // KHÔNG audit — KHÔNG db read
  });

  it("LOW 3 — lỗi INFRA từ gate (KHÔNG phải policy code) → NÉM TIẾP (fail closed visible), KHÔNG masquerade redirect CONTENT_INVALID + audit submit_blocked", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    seedUpload(seller.id);
    const draft = seedListing(seller.id, "draft");
    seedImage(draft.id, IMG_URL, "front");
    login(seller);
    gateState.failPublishWith = "SqlQueryError: connection terminated (SELECT * FROM ProductModel)";

    // infra error propagate — KHÔNG redirect, KHÔNG audit (SQL text KHÔNG vào
    // audit reason/detail)
    await expect(
      submitListingAction(fd({ listingId: draft.id })),
    ).rejects.toThrowError(/connection terminated/);
    expect(draft.status).toBe("draft");
    expect(auditsOf("listing.submit_blocked")).toHaveLength(0);
    expect(auditsOf("listing.submitted")).toHaveLength(0);
  });

  it("rate limit: lần submit thứ 21 trong giờ → redirect ?error=RATE_LIMITED (KHÔNG row mới)", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    seedUpload(seller.id);
    const draft = seedListing(seller.id, "draft");
    seedImage(draft.id, IMG_URL, "front");
    login(seller);

    // 20 lần đầu tiêu hết bucket (lần 1 thành công → pending + redirect
    // ?submitted=1 — b4-holistic; các lần sau no-op im lặng)
    for (let i = 0; i < 20; i++) {
      await expectRedirect(() => submitListingAction(fd({ listingId: draft.id })));
    }
    expect(draft.status).toBe("pending");

    const url = await expectRedirect(() => submitListingAction(fd({ listingId: draft.id })));
    expect(url).toBe(`/sell/${draft.id}/edit?error=RATE_LIMITED`);
  });
});

// ─── 3. Rate limit — create/draft (LISTING_MUTATION_RATE 20/h) ───────────────

describe("rate limit — listing mutation (§7.1)", () => {
  it("lần draft thứ 21 trong giờ → typed form error RATE_LIMITED, KHÔNG row", async () => {
    const seller = mkUser({ id: "seller-fresh", role: "seller" });
    dbState.users.push(seller);
    seedUpload(seller.id);
    login(seller);

    for (let i = 0; i < 20; i++) {
      await createDraftExpectRedirect(betaForm());
    }
    expect(dbState.listings).toHaveLength(20);

    const state = await saveListingDraftAction({}, betaForm());
    expect(state.error).toContain("RATE_LIMITED");
    expect(dbState.listings).toHaveLength(20); // KHÔNG row mới
  });

  it("lần create thứ 21 trong giờ → typed form error RATE_LIMITED, KHÔNG row", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    seedUpload(seller.id);
    login(seller);

    const { createListingAction } = await import("@/src/lib/actions/listings");
    for (let i = 0; i < 20; i++) {
      // create thành công kết thúc bằng redirect() → throw NEXT_REDIRECT
      await expectRedirect(() => createListingAction({}, betaForm()));
    }
    expect(dbState.listings).toHaveLength(20);

    const state = await createListingAction({}, betaForm());
    expect(state.error).toContain("RATE_LIMITED");
    expect(dbState.listings).toHaveLength(20);
  });
});

// ─── 4. updateListingAction trên draft — BỊ CHẶN (b4-holistic MEDIUM) ────────

describe("updateListingAction trên draft — typed LISTING_DRAFT_NOT_EDITABLE (b4-holistic)", () => {
  it("MEDIUM b4-holistic: draft KHÔNG sửa qua updateListingAction — typed error, KHÔNG write, KHÔNG PriceHistory, KHÔNG gate call", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id, { verificationStatus: "revoked" }); // revoked — kẻ viết của finding
    seedUpload(seller.id);
    const draft = seedListing(seller.id, "draft");
    seedImage(draft.id, IMG_URL, "front");
    login(seller);

    // Trước fix: draft ∉ transition list → chỉ content validation → CAS
    // status draft match → PriceHistory reprice row viết cho MỌI lần đổi giá
    // (public price stats — /models, /compare, listing detail) mà KHÔNG qua
    // publication gate. Sau fix: typed error, drafts đi saveListingDraftAction
    // (không PriceHistory) + submitListingAction (full gate).
    const state = await updateListingAction(
      {},
      betaForm({ listingId: draft.id, price: "990000", title: "Loa JBL Charge 5 chính hãng ĐỔI GIÁ NHÁP" }),
    );

    expect(state.error).toContain("LISTING_DRAFT_NOT_EDITABLE");
    expect(draft.price).toBe(1_800_000); // KHÔNG write
    expect(draft.title).toBe("Loa JBL Charge 5 chính hãng"); // KHÔNG write
    expect(dbState.priceHistory).toHaveLength(0); // KHÔNG public price row
    expect(gateState.contentValidCalls).toBe(0); // chặn TRƯỚC gate
    expect(gateState.publishableCalls).toBe(0);
    expect(gateState.sellerGateCalls).toBe(0);
  });
});

// ─── 5. b4-holistic — listing.submitted audit MỌI đường vào review + PriceHistory ──

describe("b4-holistic — listing.submitted audit trên MỌI đường vào review + PriceHistory discipline", () => {
  it("LOW b4-holistic: createListingAction (submit-ngay) → audit listing.submitted kèm policyVersion v1 (via=create)", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    seedUpload(seller.id);
    login(seller);

    const { createListingAction } = await import("@/src/lib/actions/listings");
    await expectRedirect(() => createListingAction({}, betaForm()));

    expect(dbState.listings).toHaveLength(1);
    const evt = auditsOf("listing.submitted")[0]!;
    expect(evt).toMatchObject({
      actorId: seller.id,
      subjectId: seller.id,
      resourceType: "Listing",
      resourceId: dbState.listings[0]!.id,
      policyVersion: "v1", // SELLER_RULES_POLICY_VERSION (§4.6)
      detail: "via=create", // typed value — KHÔNG free text (spec §4.8)
    });
  });

  it("LOW b4-holistic: updateListingAction content-change approved→pending → audit listing.submitted (via=edit_resubmit)", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    seedUpload(seller.id);
    const approved = seedListing(seller.id, "approved");
    seedImage(approved.id, IMG_URL, "front");
    login(seller);

    await expectRedirect(() =>
      updateListingAction(
        {},
        betaForm({ listingId: approved.id, title: "Loa JBL Charge 5 chính hãng ĐỔI TIÊU ĐỀ" }),
      ),
    );

    expect(approved.status).toBe("pending");
    const evt = auditsOf("listing.submitted")[0]!;
    expect(evt).toMatchObject({
      actorId: seller.id,
      subjectId: seller.id,
      resourceType: "Listing",
      resourceId: approved.id,
      policyVersion: "v1",
      detail: "via=edit_resubmit",
    });
  });

  it("LOW b4-holistic: updateListingAction KHÔNG vào review (approved không đổi content) → KHÔNG audit listing.submitted", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    seedUpload(seller.id);
    const approved = seedListing(seller.id, "approved");
    seedImage(approved.id, IMG_URL, "front");
    login(seller);

    // form GIỮ NGUYÊN mọi giá trị → contentChanged false → status GIỮ approved
    await expectRedirect(() => updateListingAction({}, betaForm({ listingId: approved.id })));

    expect(approved.status).toBe("approved");
    expect(auditsOf("listing.submitted")).toHaveLength(0);
  });

  it("LOW b4-holistic: submitListingAction draft→pending → PriceHistory 'listed' row (ĐÚNG 1) — như direct create", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    seedUpload(seller.id);
    const draft = seedListing(seller.id, "draft");
    seedImage(draft.id, IMG_URL, "front");
    login(seller);

    await expectRedirect(() => submitListingAction(fd({ listingId: draft.id })));

    expect(draft.status).toBe("pending");
    expect(dbState.priceHistory).toHaveLength(1);
    expect(dbState.priceHistory[0]).toMatchObject({
      modelId: MODEL.id,
      listingId: draft.id,
      price: 1_800_000,
      kind: "listed",
    });
  });

  it("MEDIUM b4-holistic: updateListingAction reprice trên listing ĐÃ QUA gate (approved→pending) → PriceHistory reprice row VẪN viết (hành vi giữ nguyên)", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    seedUpload(seller.id);
    const approved = seedListing(seller.id, "approved");
    seedImage(approved.id, IMG_URL, "front");
    login(seller);

    await expectRedirect(() =>
      updateListingAction(
        {},
        betaForm({ listingId: approved.id, price: "2200000", title: "Loa JBL Charge 5 chính hãng ĐỔI GIÁ" }),
      ),
    );

    expect(approved.status).toBe("pending");
    expect(dbState.priceHistory).toHaveLength(1);
    expect(dbState.priceHistory[0]).toMatchObject({
      modelId: MODEL.id,
      listingId: approved.id,
      price: 2_200_000,
      kind: "reprice",
    });
  });

  it("isActive (unverified-b REAL) — draft MỚI trong category beta INACTIVE → CATEGORY_NOT_PUBLICATION_ALLOWED, KHÔNG row", async () => {
    dbState.categories.push({ ...CAT_BETA, id: "cat-beta-off", isActive: false });
    const seller = mkUser({ id: "seller-fresh", role: "seller" });
    dbState.users.push(seller);
    login(seller);

    const state = await saveListingDraftAction({}, betaForm({ categoryId: "cat-beta-off" }));

    expect(state.error).toContain("CATEGORY_NOT_PUBLICATION_ALLOWED");
    expect(dbState.listings).toHaveLength(0);
  });

  it("isActive (unverified-b REAL) — draft UPDATE GIỮ NGUYÊN category inactive → PASS (grandfathered)", async () => {
    (dbState.categories[0] as Row).isActive = false; // CAT_BETA inactive
    const seller = mkUser({ id: "seller-fresh", role: "seller" });
    dbState.users.push(seller);
    seedUpload(seller.id);
    const draft = seedListing(seller.id, "draft");
    seedImage(draft.id, IMG_URL, "front");
    login(seller);

    // b4-holistic round-4: nhánh update redirect ?saved=draft (URL sạch)
    const updateUrl = await expectRedirect(() =>
      saveListingDraftAction(
        {},
        betaForm({ listingId: draft.id, title: "Loa JBL Charge 5 chính hãng SỬA NHÁP" }),
      ),
    );

    expect(updateUrl).toBe(`/sell/${draft.id}/edit?saved=draft`);
    expect(draft.title).toBe("Loa JBL Charge 5 chính hãng SỬA NHÁP");
  });

  // Ghi chú (không test được ở action-draft): "ĐỔI category sang inactive" —
  // Category.slug UNIQUE nên category beta inactive chính là category hiện tại
  // của draft (unchanged → grandfathered); đổi sang category legacy khác bị
  // assertCategoryPublicationAllowed chặn TRƯỚC. Case đổi-into-inactive với
  // current ≠ target (listing legacy đổi sang beta inactive) pin ở
  // tests/unit/listing-publication.test.ts (assertCategoryActive describe).

  it("LOW b4-holistic (validation): draft brandId KHÔNG tồn tại → typed BRAND_INVALID, KHÔNG row (KHÔNG FK 23503 crash)", async () => {
    const seller = mkUser({ id: "seller-fresh", role: "seller" });
    dbState.users.push(seller);
    seedUpload(seller.id);
    login(seller);

    const state = await saveListingDraftAction({}, betaForm({ brandId: "brand-khong-ton-tai" }));

    expect(state.error).toContain("BRAND_INVALID");
    expect(dbState.listings).toHaveLength(0);
  });

  it("LOW b4-holistic (validation): draft productModelId KHÔNG tồn tại → typed MODEL_INVALID, KHÔNG row (KHÔNG FK 23503 crash)", async () => {
    const seller = mkUser({ id: "seller-fresh", role: "seller" });
    dbState.users.push(seller);
    seedUpload(seller.id);
    login(seller);

    const state = await saveListingDraftAction({}, betaForm({ productModelId: "model-khong-ton-tai" }));

    expect(state.error).toContain("MODEL_INVALID");
    expect(dbState.listings).toHaveLength(0);
  });

  it("LOW b4-holistic (validation): CRLF line breaks normalize TRƯỚC validate — description 3.990 ký tự + 15 dòng (CRLF) PASS (browser maxLength đếm LF = 1 ký tự)", async () => {
    const seller = mkUser({ id: "seller-fresh", role: "seller" });
    dbState.users.push(seller);
    seedUpload(seller.id);
    login(seller);

    // 3.990 ký tự + 15 \r\n = 4.020 byte multipart — TRƯỚC fix: server thấy
    // 4.020 > DESCRIPTION_MAX → DESCRIPTION_INVALID dù counter browser chưa
    // bao giờ vượt 4.000. Sau fix: normalize \r\n → \n (4.005 ≤ 4.000? KHÔNG —
    // 3.990 + 15 = 4.005... dựng chính xác: 3.985 + 15 dòng = 4.000).
    const lines = 15;
    const body = "a".repeat(3_985);
    const description = `${body}${"\r\n".repeat(lines)}`; // 3.985 + 15×2 = 4.015 byte CRLF, 4.000 ký tự LF
    expect(description.replace(/\r\n?/g, "\n").length).toBe(4_000);

    const url = await createDraftExpectRedirect(betaForm({ description }));
    expect(url).toMatch(/\/sell\/.+\/edit\?saved=draft$/);
    expect(dbState.listings).toHaveLength(1);
    // stored text dùng LF nhất quán (KHÔNG CRLF)
    expect(String(dbState.listings[0]!.description)).not.toContain("\r");
  });

  it("LOW b4-holistic (validation): description 4.001 ký tự LF (THẬT quá dài) → VẪN DESCRIPTION_INVALID (bound giữ nguyên — KHÔNG nới vì CRLF)", async () => {
    const seller = mkUser({ id: "seller-fresh", role: "seller" });
    dbState.users.push(seller);
    login(seller);

    const description = "a".repeat(4_001);
    const state = await saveListingDraftAction({}, betaForm({ description }));

    expect(state.error).toContain("DESCRIPTION_INVALID");
    expect(dbState.listings).toHaveLength(0);
  });

  it("LOW b4-holistic (validation): legacy free-text city — updateListingAction KHÔNG province + city 10.000 ký tự → typed PROVINCE_INVALID, KHÔNG write", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    seedUpload(seller.id);
    // listing LEGACY (category legacy — regime legacy, không đòi province)
    const legacy = seedListing(seller.id, "approved", { categoryId: CAT_LEGACY.id });
    seedImage(legacy.id, IMG_URL, null);
    login(seller);

    const { updateListingAction } = await import("@/src/lib/actions/listings");
    const state = await updateListingAction(
      {},
      betaForm({
        listingId: legacy.id,
        categoryId: CAT_LEGACY.id,
        brandId: "",
        productModelId: "",
        city: "X".repeat(10_000),
        provinceLevelCode: "",
        inventoryContext: "",
        fulfillmentMethods: [] as string[],
        locationDisplayName: "",
      }),
    );

    expect(state.error).toContain("PROVINCE_INVALID");
    expect(legacy.city).toBe("Hà Nội"); // KHÔNG write
  });

  it("LOW b4-holistic (validation): legacy city NGOÀI CITIES nhưng BẰNG city đang lưu → grandfathered PASS (sửa tiếp được)", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    seedUpload(seller.id);
    // legacy pre-Batch-4 free-text city không nằm trong CITIES
    const legacy = seedListing(seller.id, "approved", { categoryId: CAT_LEGACY.id, city: "Bình Dương cũ" });
    seedImage(legacy.id, IMG_URL, null);
    login(seller);

    const { updateListingAction } = await import("@/src/lib/actions/listings");
    const url = await expectRedirect(() =>
      updateListingAction(
        {},
        betaForm({
          listingId: legacy.id,
          categoryId: CAT_LEGACY.id,
          brandId: "",
          productModelId: "",
          city: "Bình Dương cũ", // GIỮ NGUYÊN — grandfathered
          provinceLevelCode: "",
          inventoryContext: "",
          fulfillmentMethods: [] as string[],
          locationDisplayName: "",
        }),
      ),
    );

    expect(url).toContain("/sell/my?updated=1");
    expect(legacy.city).toBe("Bình Dương cũ");
  });

  it("LOW b4-holistic (validation): legacy city NGOÀI CITIES và KHÁC city đang lưu → PROVINCE_INVALID (số điện thoại/URL/rác không lọt)", async () => {
    const seller = mkVerifiedSeller();
    dbState.users.push(seller);
    seedPolicyRows(seller.id);
    seedUpload(seller.id);
    const legacy = seedListing(seller.id, "approved", { categoryId: CAT_LEGACY.id, city: "Bình Dương cũ" });
    seedImage(legacy.id, IMG_URL, null);
    login(seller);

    const { updateListingAction } = await import("@/src/lib/actions/listings");
    const state = await updateListingAction(
      {},
      betaForm({
        listingId: legacy.id,
        categoryId: CAT_LEGACY.id,
        brandId: "",
        productModelId: "",
        city: "0900000001 gọi ngay",
        provinceLevelCode: "",
        inventoryContext: "",
        fulfillmentMethods: [] as string[],
        locationDisplayName: "",
      }),
    );

    expect(state.error).toContain("PROVINCE_INVALID");
    expect(legacy.city).toBe("Bình Dương cũ"); // KHÔNG write
  });
});
