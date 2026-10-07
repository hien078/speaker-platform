/**
 * Listing publication wrapper (Batch 4 Task 2 — spec §5.6.1/§5.6/§4.4) — unit
 * tests. Review Focus 2/3.
 *
 * HAI hàm xuất, mọi transition dùng chung (extend Batch 2 gate — KHÔNG duplicate):
 *  - `assertListingPublishable` = Batch 2 `assertSellerPublicationAllowed`
 *    (Seller Verification Policy v1 — 8 yêu cầu incl. Batch 3
 *    `account_not_suspended`, inheritable per R6) + `assertListingContentValid`.
 *    Thứ tự cố định: seller → category → schema → model → images.
 *  - `assertListingContentValid` = `assertCategoryPublicationAllowed` +
 *    `validateListingSubmission` (regime theo targetSlug) +
 *    `assertCanonicalModelValid` (B4 — DB check) + `assertListingImagesOwned`.
 *  - `checkListingPublication` — KHÔNG throw, dùng BỞI approveListingAction
 *    (duy nhất) để build { sellerMissing, listingIssues } cho audit.
 *
 * Composition order pin qua counting wrapper `vi.mock(() => ({ ...
 * vi.importOriginal() }))` trên `@/src/lib/seller-verification-policy` +
 * `@/src/lib/listing-images` (cross-module — spy cùng registry không works,
 * Global Constraints). db.client mock in-memory (pattern publication-gate.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// ─── db.client mock — in-memory đủ model cho wrapper + Batch 2 gate ────────────

const dbState = vi.hoisted(() => ({
  users: [] as Array<Record<string, unknown>>,
  listings: [] as Array<Record<string, unknown>>,
  images: [] as Array<Record<string, unknown>>,
  categories: [] as Array<Record<string, unknown>>,
  brands: [] as Array<Record<string, unknown>>,
  models: [] as Array<Record<string, unknown>>,
  uploads: [] as Array<Record<string, unknown>>,
  verifications: [] as Array<Record<string, unknown>>,
  acceptances: [] as Array<Record<string, unknown>>,
  memberships: [] as Array<Record<string, unknown>>,
  suspensions: [] as Array<Record<string, unknown>>,
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

  const makeModel = (rows: Row[], defaults?: () => Row) => {
    const query = (preds: Pred[]) => ({
      where: (pred: Pred) => query([...preds, pred]),
      orderBy: () => query(preds),
      first: async (filter?: Pred) => {
        const all = [...preds, ...(filter ? [filter] : [])];
        return rows.find((r) => all.every((p) => matches(r, p))) ?? null;
      },
      all: async () =>
        rows.filter((r) => preds.every((p) => matches(r, p))).map((r) => ({ ...r })),
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
      orderBy: () => query([]),
      create: (data: Row) => query([]).create(data),
    };
  };

  const models = {
    User: makeModel(dbState.users, () => ({ id: `user-${dbState.users.length + 1}` })),
    Listing: makeModel(dbState.listings, () => ({ id: `listing-${dbState.listings.length + 1}` })),
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
    })),
    Brand: makeModel(dbState.brands, () => ({ id: `brand-${dbState.brands.length + 1}` })),
    ProductModel: makeModel(dbState.models, () => ({
      id: `model-${dbState.models.length + 1}`,
      releaseYear: null,
      description: null,
      specs: null,
      image: null,
      mergedIntoId: null,
    })),
    ListingImageUpload: makeModel(dbState.uploads, () => ({
      id: `up-${dbState.uploads.length + 1}`,
      bytes: 1024,
      width: 800,
      height: 600,
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
      policyVersion: "v1",
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
  };
  return {
    db: {
      orm: { public: models },
      transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ orm: { public: { ...models } } }),
    },
  };
});

// ─── Counting wrappers (cross-module — Global Constraints recipe) ─────────────

const spyState = vi.hoisted(() => ({
  order: [] as string[],
  sellerGateCalls: 0,
  lastSellerGateId: undefined as string | undefined,
  imagesCalls: 0,
  /**
   * LOW 3 (review fix): khi ≠ null — wrapper assertListingImagesOwned THROW giá
   * trị này thay vì chạy thật (mô phỏng lỗi infra db từ images stage).
   */
  imagesFailWith: null as string | null,
}));

vi.mock("@/src/lib/seller-verification-policy", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/src/lib/seller-verification-policy")>();
  return {
    ...actual,
    assertSellerPublicationAllowed: async (sellerId: string): Promise<void> => {
      spyState.sellerGateCalls += 1;
      spyState.lastSellerGateId = sellerId;
      spyState.order.push("seller-gate");
      return actual.assertSellerPublicationAllowed(sellerId);
    },
  };
});

vi.mock("@/src/lib/listing-images", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/lib/listing-images")>();
  return {
    ...actual,
    assertListingImagesOwned: async (input: {
      sellerId: string;
      listingId?: string;
      imageUrls: string[];
      imageSlots?: (string | null)[];
    }): Promise<void> => {
      spyState.imagesCalls += 1;
      spyState.order.push("images");
      if (spyState.imagesFailWith !== null) throw new Error(spyState.imagesFailWith);
      return actual.assertListingImagesOwned(input);
    },
  };
});

import {
  assertCanonicalModelValid,
  assertListingContentValid,
  assertListingPublishable,
  checkListingPublication,
  type ListingPublicationInput,
} from "@/src/lib/listing-publication";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SELLER = "seller-1";
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
  sortOrder: 0,
  isActive: true,
  createdAt: "2026-09-01T00:00:00.000Z",
};

const seedUser = (over?: Record<string, unknown>): void => {
  dbState.users.push({
    id: SELLER,
    email: "seller@loaviet.test",
    passwordHash: "bcrypt-x",
    name: "Seller",
    role: "seller",
    avatarUrl: null,
    phone: null,
    city: null,
    bio: null,
    isVerifiedSeller: false,
    adminRole: null,
    emailVerifiedAt: "2026-10-01T00:00:00.000Z",
    phoneVerifiedAt: "2026-10-01T00:00:00.000Z",
    sellerType: "individual",
    sellerOperatingProvinceCode: "ha-noi",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...over,
  });
};

/** Seller ĐỦ 8 yêu cầu policy v1 (mặc định) — case block bỏ từng mảnh. */
const seedVerifiedSeller = (): void => {
  seedUser();
  dbState.acceptances.push({
    id: `pa-${dbState.acceptances.length + 1}`,
    userId: SELLER,
    policyKey: "seller_rules",
    policyVersion: "v1",
    acceptedAt: new Date().toISOString(),
  });
  dbState.memberships.push({
    id: `bcm-${dbState.memberships.length + 1}`,
    userId: SELLER,
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
    userId: SELLER,
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

const seedUpload = (): void => {
  dbState.uploads.push({
    id: `up-${dbState.uploads.length + 1}`,
    ownerUserId: SELLER,
    storageKey: `${UUID_IMG}.webp`,
    bytes: 1024,
    width: 800,
    height: 600,
    createdAt: new Date().toISOString(),
  });
};

const seedModel = (over: Record<string, unknown>): void => {
  dbState.models.push({
    id: "model-x",
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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  });
};

/** Input publication beta ĐỦ — category beta, model approved, ảnh owned. */
const publicationInput = (
  over?: Partial<ListingPublicationInput>,
): ListingPublicationInput => ({
  title: "Loa JBL Charge 5 chính hãng",
  description: "Loa bluetooth cũ còn tốt, pin trâu, nghe hay.",
  categoryId: CAT_BETA.id,
  brandId: "brand-1",
  productModelId: "model-charge-5",
  condition: "good",
  price: 1_800_000,
  negotiable: false,
  inventoryContext: "used",
  includedAccessories: null,
  knownDefects: null,
  repairHistory: null,
  fulfillmentMethods: ["meetup"],
  provinceLevelCode: "ha-noi",
  locationDisplayName: "Khu vực Cầu Giấy",
  imageUrls: [IMG_URL],
  imageSlots: ["front"],
  sellerId: SELLER,
  listingId: "listing-1",
  currentCategorySlug: CAT_BETA.slug,
  ...over,
});

const expectPublishError = async (
  input: ListingPublicationInput,
  code: string,
): Promise<void> => {
  await expect(assertListingPublishable(input)).rejects.toThrowError(code);
};

beforeEach(() => {
  for (const arr of [
    dbState.users,
    dbState.listings,
    dbState.images,
    dbState.categories,
    dbState.brands,
    dbState.models,
    dbState.uploads,
    dbState.verifications,
    dbState.acceptances,
    dbState.memberships,
    dbState.suspensions,
  ]) {
    arr.length = 0;
  }
  spyState.order.length = 0;
  spyState.sellerGateCalls = 0;
  spyState.lastSellerGateId = undefined;
  spyState.imagesCalls = 0;
  spyState.imagesFailWith = null;
  dbState.categories.push({ ...CAT_BETA }, { ...CAT_LEGACY });
  seedModel({ id: "model-charge-5", brandId: "brand-1", categoryId: CAT_BETA.id, status: "approved" });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── 1. assertListingPublishable — composition + order ────────────────────────

describe("assertListingPublishable — extend Batch 2 gate (composition order)", () => {
  it("gọi assertSellerPublicationAllowed(sellerId) RỒI MỚI assertListingContentValid (images stage)", async () => {
    seedVerifiedSeller();
    seedUpload();
    await expect(
      assertListingPublishable(publicationInput()),
    ).resolves.toBeUndefined();
    expect(spyState.sellerGateCalls).toBe(1);
    expect(spyState.lastSellerGateId).toBe(SELLER);
    expect(spyState.imagesCalls).toBe(1);
    // seller gate chạy TRƯỚC content stage (images là stage cuối của content)
    expect(spyState.order.indexOf("seller-gate")).toBeLessThan(
      spyState.order.indexOf("images"),
    );
  });

  it("seller gate failure → SELLER_PUBLICATION_BLOCKED TRƯỚC mọi content check (images chưa được gọi)", async () => {
    seedUser({ emailVerifiedAt: null }); // thiếu email_verified
    seedUpload();
    await expectPublishError(publicationInput(), "SELLER_PUBLICATION_BLOCKED");
    expect(spyState.imagesCalls).toBe(0); // content stage KHÔNG chạy
  });

  it("seller bị đình chỉ (Batch 3 — account_not_suspended) → blocked qua wrapper (R6 inherit)", async () => {
    seedVerifiedSeller();
    dbState.suspensions.push({
      id: "susp-1",
      userId: SELLER,
      status: "active",
      reasonCode: "confirmed_abuse",
      note: null,
      suspendedById: null,
      suspendedAt: new Date().toISOString(),
      liftedById: null,
      liftedAt: null,
      liftReasonCode: null,
    });
    seedUpload();
    await expectPublishError(publicationInput(), "SELLER_PUBLICATION_BLOCKED:account_not_suspended");
    expect(spyState.imagesCalls).toBe(0);
  });
});

// ─── 2. assertListingContentValid — category → schema → model → images ────────

describe("assertListingContentValid — category allowlist + regime schema", () => {
  it("category không thuộc allowlist → CATEGORY_NOT_PUBLICATION_ALLOWED kể cả khi seller ĐỦ điều kiện", async () => {
    seedVerifiedSeller();
    seedUpload();
    // target legacy ≠ current beta → không được đổi RA khỏi allowlist
    await expect(
      assertListingContentValid(
        publicationInput({ categoryId: CAT_LEGACY.id, currentCategorySlug: CAT_BETA.slug }),
      ),
    ).rejects.toThrowError("CATEGORY_NOT_PUBLICATION_ALLOWED");
  });

  it("category KHÔNG tồn tại trong DB → CATEGORY_NOT_FOUND (fail closed)", async () => {
    seedVerifiedSeller();
    seedUpload();
    await expect(
      assertListingContentValid(publicationInput({ categoryId: "cat-khong-ton-tai" })),
    ).rejects.toThrowError("CATEGORY_NOT_FOUND");
  });

  it("regime beta + input thiếu structured → LISTING_VALIDATION_FAILED:<code>", async () => {
    seedUpload();
    await expect(
      assertListingContentValid(publicationInput({ inventoryContext: null })),
    ).rejects.toThrowError("LISTING_VALIDATION_FAILED:INVENTORY_CONTEXT_REQUIRED");
  });

  it("regime legacy + CÙNG input thiếu structured → passes (grandfathered)", async () => {
    seedUpload();
    // listing legacy giữ nguyên category legacy — schema legacy không đòi structured
    await expect(
      assertListingContentValid(
        publicationInput({
          categoryId: CAT_LEGACY.id,
          currentCategorySlug: CAT_LEGACY.slug,
          brandId: null,
          productModelId: null,
          inventoryContext: null,
          fulfillmentMethods: null,
          provinceLevelCode: null,
          locationDisplayName: null,
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it("ảnh không owned → IMAGE_NOT_OWNED (content stage chặn trước khi action write)", async () => {
    seedVerifiedSeller();
    // KHÔNG seed upload — url /uploads/<uuid>.webp không có ownership row
    await expect(
      assertListingContentValid(publicationInput()),
    ).rejects.toThrowError("IMAGE_NOT_OWNED");
  });
});

// ─── 2b. b4-holistic (unverified-b REAL) — Category.isActive enforce SERVER-side ──

describe("assertCategoryActive — Category.isActive enforce server-side (b4-holistic unverified-b)", () => {
  it("category ĐÍCH inactive + TẠO MỚI (không current) → CATEGORY_NOT_PUBLICATION_ALLOWED", async () => {
    seedVerifiedSeller();
    seedUpload();
    dbState.categories.push({ ...CAT_BETA, id: "cat-beta-off", isActive: false });
    await expect(
      assertListingContentValid(publicationInput({ categoryId: "cat-beta-off", currentCategorySlug: undefined })),
    ).rejects.toThrowError("CATEGORY_NOT_PUBLICATION_ALLOWED");
  });

  it("category ĐÍCH inactive + ĐỔI category (current khác) → CATEGORY_NOT_PUBLICATION_ALLOWED", async () => {
    seedVerifiedSeller();
    seedUpload();
    dbState.categories.push({ ...CAT_BETA, id: "cat-beta-off", isActive: false });
    await expect(
      assertListingContentValid(
        publicationInput({ categoryId: "cat-beta-off", currentCategorySlug: CAT_LEGACY.slug }),
      ),
    ).rejects.toThrowError("CATEGORY_NOT_PUBLICATION_ALLOWED");
  });

  it("category inactive NHƯNG GIỮ NGUYÊN category (grandfathered) → PASS", async () => {
    seedVerifiedSeller();
    seedUpload();
    // category beta inactive — listing đã ở trong đó, KHÔNG đổi category
    dbState.categories.length = 0;
    dbState.categories.push({ ...CAT_BETA, isActive: false });
    await expect(
      assertListingContentValid(publicationInput({ currentCategorySlug: CAT_BETA.slug })),
    ).resolves.toBeUndefined();
  });

  it("checkListingPublication thu isActive violation vào listingIssues (approve audit variant)", async () => {
    seedVerifiedSeller();
    seedUpload();
    dbState.categories.push({ ...CAT_BETA, id: "cat-beta-off", isActive: false });
    const check = await checkListingPublication(
      publicationInput({ categoryId: "cat-beta-off", currentCategorySlug: undefined }),
    );
    expect(check.ok).toBe(false);
    expect(check.listingIssues).toContain("CATEGORY_NOT_PUBLICATION_ALLOWED");
  });
});

// ─── 3. assertCanonicalModelValid — B4 DB checks ───────────────────────────────

describe("assertCanonicalModelValid — canonical model DB check (B4)", () => {
  it("model KHÔNG tồn tại → MODEL_INVALID", async () => {
    await expect(
      assertCanonicalModelValid({
        productModelId: "model-khong-ton-tai",
        brandId: "brand-1",
        categoryId: CAT_BETA.id,
        regime: "beta",
      }),
    ).rejects.toThrowError("MODEL_INVALID");
  });

  it("model status pending → MODEL_INVALID", async () => {
    seedModel({ id: "model-pending", status: "pending" });
    await expect(
      assertCanonicalModelValid({
        productModelId: "model-pending",
        brandId: "brand-1",
        categoryId: CAT_BETA.id,
        regime: "beta",
      }),
    ).rejects.toThrowError("MODEL_INVALID");
  });

  it("model status merged → MODEL_INVALID", async () => {
    seedModel({ id: "model-merged", status: "merged" });
    await expect(
      assertCanonicalModelValid({
        productModelId: "model-merged",
        brandId: "brand-1",
        categoryId: CAT_BETA.id,
        regime: "beta",
      }),
    ).rejects.toThrowError("MODEL_INVALID");
  });

  it("model thuộc category KHÁC (regime beta) → MODEL_INVALID", async () => {
    seedModel({ id: "model-other-cat", categoryId: CAT_LEGACY.id, status: "approved" });
    await expect(
      assertCanonicalModelValid({
        productModelId: "model-other-cat",
        brandId: "brand-1",
        categoryId: CAT_BETA.id,
        regime: "beta",
      }),
    ).rejects.toThrowError("MODEL_INVALID");
  });

  it("model.brandId ≠ brandId → MODEL_BRAND_MISMATCH", async () => {
    seedModel({ id: "model-other-brand", brandId: "brand-2", status: "approved" });
    await expect(
      assertCanonicalModelValid({
        productModelId: "model-other-brand",
        brandId: "brand-1",
        categoryId: CAT_BETA.id,
        regime: "beta",
      }),
    ).rejects.toThrowError("MODEL_BRAND_MISMATCH");
  });

  it("model approved + đúng brand + đúng category (beta) → passes", async () => {
    await expect(
      assertCanonicalModelValid({
        productModelId: "model-charge-5",
        brandId: "brand-1",
        categoryId: CAT_BETA.id,
        regime: "beta",
      }),
    ).resolves.toBeUndefined();
  });

  it("regime legacy: KHÔNG cung cấp productModelId → không check (tùy chọn như hôm nay)", async () => {
    await expect(
      assertCanonicalModelValid({
        productModelId: null,
        brandId: "brand-1",
        categoryId: CAT_LEGACY.id,
        regime: "legacy",
      }),
    ).resolves.toBeUndefined();
  });

  it("regime legacy: model category KHÔNG được so (chỉ status + brand)", async () => {
    // model approved của category beta dùng trong listing legacy (hôm nay cho phép)
    await expect(
      assertCanonicalModelValid({
        productModelId: "model-charge-5",
        brandId: "brand-1",
        categoryId: CAT_LEGACY.id,
        regime: "legacy",
      }),
    ).resolves.toBeUndefined();
  });
});

// ─── 4. checkListingPublication — non-throwing (approve's audit variant) ───────

describe("checkListingPublication — không throw (approve audit variant)", () => {
  it("seller thiếu + content sai → { ok: false, sellerMissing, listingIssues } KHÔNG throw", async () => {
    seedUser({ emailVerifiedAt: null, phoneVerifiedAt: null }); // thiếu 2 yêu cầu
    // ảnh không owned → content cũng sai
    const check = await checkListingPublication(publicationInput());
    expect(check.ok).toBe(false);
    expect(check.sellerMissing).toContain("email_verified");
    expect(check.sellerMissing).toContain("phone_verified");
    expect(check.sellerMissing).not.toContain("account_not_suspended");
    expect(check.listingIssues.length).toBeGreaterThan(0);
    expect(check.listingIssues).toContain("IMAGE_NOT_OWNED");
  });

  it("seller Đủ + content Đủ → { ok: true, sellerMissing: [], listingIssues: [] }", async () => {
    seedVerifiedSeller();
    seedUpload();
    const check = await checkListingPublication(publicationInput());
    expect(check.ok).toBe(true);
    expect(check.sellerMissing).toEqual([]);
    expect(check.listingIssues).toEqual([]);
  });

  it("seller bị đình chỉ (Batch 3) → sellerMissing có account_not_suspended (R6 inherit)", async () => {
    seedVerifiedSeller();
    dbState.suspensions.push({
      id: "susp-1",
      userId: SELLER,
      status: "active",
      reasonCode: "confirmed_abuse",
      note: null,
      suspendedById: null,
      suspendedAt: new Date().toISOString(),
      liftedById: null,
      liftedAt: null,
      liftReasonCode: null,
    });
    seedUpload();
    const check = await checkListingPublication(publicationInput());
    expect(check.ok).toBe(false);
    expect(check.sellerMissing).toContain("account_not_suspended");
    expect(check.listingIssues).toEqual([]);
  });

  it("content sai → listingIssues mang TỪNG stage (category/schema/model/images)", async () => {
    seedVerifiedSeller();
    // category legacy ≠ current beta → CATEGORY_NOT_PUBLICATION_ALLOWED
    const check = await checkListingPublication(
      publicationInput({ categoryId: CAT_LEGACY.id, currentCategorySlug: CAT_BETA.slug }),
    );
    expect(check.ok).toBe(false);
    expect(check.sellerMissing).toEqual([]);
    expect(check.listingIssues).toContain("CATEGORY_NOT_PUBLICATION_ALLOWED");
  });
});

// ─── 5. LOW 3 (review fix) — lỗi infra KHÔNG vào listingIssues (rethrow) ──────

describe("LOW 3 — lỗi infra (db/network) được NÉM TIẾP, KHÔNG masquerade thành policy issue", () => {
  it("checkListingPublication: images stage gặp SqlQueryError (kèm SQL text) → THROW (fail closed visible), SQL text KHÔNG vào listingIssues/issues=", async () => {
    seedVerifiedSeller();
    seedUpload();
    spyState.imagesFailWith =
      "SqlQueryError: connection terminated (SELECT * FROM ListingImageUpload WHERE storageKey = $1)";

    // KHÔNG resolve với issues chứa SQL text — PHẢI reject để caller
    // (approveListingAction) fail closed VISIBLE.
    await expect(
      checkListingPublication(publicationInput()),
    ).rejects.toThrowError(/connection terminated/);
  });

  it("assertListingContentValid: lỗi infra → THROW (KHÔNG masquerade LISTING_VALIDATION_FAILED)", async () => {
    seedVerifiedSeller();
    seedUpload();
    spyState.imagesFailWith = "ECONNREFUSED 127.0.0.1:5432";

    await expect(
      assertListingContentValid(publicationInput()),
    ).rejects.toThrowError(/ECONNREFUSED/);
  });

  it("assertListingPublishable: lỗi infra từ content stage → THROW xuyên qua (seller gate pass, images stage fail infra)", async () => {
    seedVerifiedSeller();
    seedUpload();
    spyState.imagesFailWith = "SqlQueryError: SSL connection has been closed unexpectedly";

    await expect(
      assertListingPublishable(publicationInput()),
    ).rejects.toThrowError(/SSL connection/);
    // seller gate đã chạy (policy error được phân loại ĐÚNG — infra KHÔNG đè)
    expect(spyState.sellerGateCalls).toBe(1);
  });

  it("policy error VẪN được thu (không rethrow) — IMAGE_NOT_OWNED vào listingIssues như trước", async () => {
    seedVerifiedSeller();
    // KHÔNG seed upload → ảnh /uploads/<uuid>.webp không ownership row →
    // IMAGE_NOT_OWNED (policy code) — được THU, không rethrow.
    const check = await checkListingPublication(publicationInput());
    expect(check.ok).toBe(false);
    expect(check.listingIssues).toContain("IMAGE_NOT_OWNED");
    expect(check.listingIssues.every((c) => !c.includes("SELECT"))).toBe(true);
  });
});
