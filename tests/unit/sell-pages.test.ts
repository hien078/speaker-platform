/**
 * Sell pages + buyer listing detail + CITIES refresh (Batch 4 Task 5) —
 * source-contract cấu trúc + BEHAVIOR render harness.
 *
 * Review fix LOW-4: các status-gate grep + source-string check yếu nhất được
 * thay bằng behavior test theo textOf pattern của
 * tests/unit/admin-listings-guard.test.ts + tests/unit/appeal-page.test.ts
 * (gọi page function với db in-memory + auth fixture, đi element tree);
 * các structural pin là assertion thật được GIỮ NGUYÊN.
 *
 * Hợp đồng (plan Task 5 Step 1 + review fix MEDIUM-1/LOW-1/LOW-3/LOW-4):
 *  1. app/sell/new: CHỈ category allowlist đến form (behavior — lọc
 *     server-side theo BETA_PUBLICATION_CATEGORIES, spec §5.6.1), verification
 *     check (Batch 2) đọc FRESH truyền cho bước 7, photoSlots (8)/
 *     fulfillmentMethods (4) build từ constants.
 *  2. app/sell/[id]/edit: regime switch theo category slug (beta →
 *     PortableListingForm, legacy → ListingForm — behavior);
 *     MEDIUM-1: listing moderation-locked (isModerationLocked từ
 *     @/src/lib/moderation — KHÔNG hardcode status) → read-only notice
 *     "Tin đã bị gỡ bởi kiểm duyệt" + link /appeal/<caseId> khi case takedown
 *     tồn tại (Batch 3 appeal route), KHÔNG render form; sold → notice đã bán;
 *     draft → form Gửi duyệt (submitListingAction — behavior);
 *     LOW-1: banner ?error= own-property-safe (code lạ/prototype key →
 *     generic, KHÔNG crash); IDOR: tin người khác → notFound.
 *  3. app/sell/my: draft → nút Gửi duyệt (behavior); label/badge qua
 *     constants (R8 — archived; removed từ Batch 3).
 *  4. app/listings/[slug]: render structured fields cho buyer (NULL →
 *     section vắng); legacy `user.role === "admin"` read gate GIỮ NGUYÊN
 *     (follow-up recorded — không đổi trong batch này).
 *  5. CITIES refresh (FD-1): 34 displayName chuẩn của registry + "Khác" —
 *     không còn tên stale pre-merger (Bình Dương/Thừa Thiên Huế vắng;
 *     Huế/TP. Hồ Chí Minh có mặt).
 *  6. listing-form + profile-form: stored city ngoài CITIES → option riêng
 *     (KHÔNG rewrite im lặng khi edit — item 11).
 *  7. app/models/[slug]: LOW-3 — sample < 3 → "Khoảng giá đã thu thập"
 *     (PROVISIONAL — Batch 8 Founder Decision Register); ≥ 3 → "Khoảng giá
 *     thị trường"; giữ card "Mẫu giá thu thập" (sample-size context
 *     §13.6/§5.8.2), KHÔNG thêm claim authoritative.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PROVINCES } from "@/src/lib/provinces";
import {
  CITIES,
  LISTING_STATUS_LABELS,
  LISTING_STATUS_BADGE,
  INVENTORY_CONTEXT_LABELS,
  FULFILLMENT_METHOD_LABELS,
  PHOTO_CHECKLIST_SLOT_LABELS,
} from "@/src/lib/constants";
import {
  PHOTO_CHECKLIST_SLOTS,
  LISTING_FULFILLMENT_METHODS,
} from "@/src/lib/listing-schema";
import { SUBMIT_ERROR_TEXT } from "@/src/lib/listing-error-text";

// ─── Render harness mocks (behavior tests — appeal-page precedent) ───────────

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

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers()),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => undefined,
    delete: () => undefined,
    has: () => false,
    getAll: () => [],
  })),
}));

// Session seam — page đọc qua getCurrentUser (auth thật delegate session;
// ở đây fixture trực tiếp như appeal-page.test.ts).
const authState = vi.hoisted(() => ({
  user: null as Record<string, unknown> | null,
}));

vi.mock("@/src/lib/auth", () => ({
  getCurrentUser: vi.fn(async () => authState.user),
}));

// Session seam thứ hai — app/listings/[slug] đọc getSessionFromCookie MỘT lần
// (user cho owner/wishlist + session.isAdmin cho admin authority của read
// gate — Batch 4 holistic review fix). Fixture trực tiếp như trên.
const sessionState = vi.hoisted(() => ({
  current: null as { session: Record<string, unknown>; user: Record<string, unknown> } | null,
}));

vi.mock("@/src/lib/session", () => ({
  getSessionFromCookie: vi.fn(async () => sessionState.current),
}));

// Action boundary — page import để gắn <form action>; guard của action là
// hợp đồng của listing-draft-actions/publication-gate (không phải ở đây).
vi.mock("@/src/lib/actions/listings", () => ({
  createListingAction: vi.fn(),
  updateListingAction: vi.fn(),
  saveListingDraftAction: vi.fn(),
  submitListingAction: vi.fn(),
  toggleListingVisibilityAction: vi.fn(),
  deleteListingAction: vi.fn(),
}));

// Action boundary của listing detail page (chat/wishlist form action) —
// guard của action là hợp đồng của chat-guard.test.ts, không phải ở đây.
vi.mock("@/src/lib/actions/chat", () => ({
  startConversationAction: vi.fn(),
}));
vi.mock("@/src/lib/actions/wishlist", () => ({
  toggleWishlistAction: vi.fn(),
}));

// Bước 7 verification prop — hàm THẬT đọc 5 bảng workflow; partial mock giữ
// nguyên labels (importOriginal) + stub kết quả (ok/missing là prop hiển thị).
vi.mock("@/src/lib/seller-verification-policy", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/src/lib/seller-verification-policy")>();
  return {
    ...mod,
    checkSellerPublicationRequirements: vi.fn(async () => ({ ok: true, missing: [] })),
  };
});

// ─── db.client mock — in-memory (appeal-page pattern + include/limit) ─────────

type Row = Record<string, unknown>;

const dbState = vi.hoisted(() => ({
  listings: [] as Row[],
  categories: [] as Row[],
  brands: [] as Row[],
  models: [] as Row[],
  actions: [] as Row[],
  priceHistory: [] as Row[],
  wishlist: [] as Row[],
}));

vi.mock("@/src/prisma/db.client", () => {
  type Pred = ((proxy: unknown) => unknown) | Row;

  const fieldOps = (row: Row) =>
    new Proxy(
      {},
      {
        get: (_t, field: string) => ({
          eq: (v: unknown) => row[field] === v,
          neq: (v: unknown) => row[field] !== v,
          in: (arr: readonly unknown[]) => (arr as readonly unknown[]).includes(row[field]),
          isNull: () => row[field] === null,
          isNotNull: () => row[field] !== null,
        }),
      },
    );

  const matches = (row: Row, pred: Pred): boolean =>
    typeof pred === "function"
      ? Boolean(pred(fieldOps(row)))
      : Object.entries(pred).every(([k, v]) => row[k] === v);

  const makeModel = (rows: Row[]) => {
    const query = (preds: Pred[]) => ({
      where: (pred: Pred) => query([...preds, pred]),
      include: () => query(preds),
      select: (..._fields: string[]) => query(preds),
      orderBy: () => query(preds),
      limit: () => query(preds),
      first: async (filter?: Pred) => {
        const all = [...preds, ...(filter ? [filter] : [])];
        const hit = rows.find((r) => all.every((p) => matches(r, p)));
        return hit === undefined ? null : { ...hit };
      },
      all: async () =>
        rows.filter((r) => preds.every((p) => matches(r, p))).map((r) => ({ ...r })),
      // viewCount bump của detail page — no-op trong render harness
      update: async () => null,
      // modelStats avg/count của detail page — fixture trả 0 mẫu
      aggregate: async () => ({ avg: 0, c: 0 }),
    });
    return {
      first: (filter?: Pred) => query([]).first(filter),
      all: () => query([]).all(),
      where: (pred: Pred) => query([pred]),
      orderBy: () => query([]),
    };
  };

  const models = {
    Listing: makeModel(dbState.listings),
    Category: makeModel(dbState.categories),
    Brand: makeModel(dbState.brands),
    ProductModel: makeModel(dbState.models),
    ModerationAction: makeModel(dbState.actions),
    PriceHistory: makeModel(dbState.priceHistory),
    WishlistItem: makeModel(dbState.wishlist),
  };

  return {
    db: {
      orm: { public: models },
      transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ orm: { public: models } }),
    },
  };
});

import * as sellNewPage from "../../app/sell/new/page";
import * as sellEditPage from "../../app/sell/[id]/edit/page";
import * as sellMyPage from "../../app/sell/my/page";
import * as modelPageModule from "../../app/models/[slug]/page";
import * as listingDetailPageModule from "../../app/listings/[slug]/page";
import { PortableListingForm } from "../../src/components/portable-listing-form";
import { ListingForm } from "../../src/components/listing-form";
import { submitListingAction } from "@/src/lib/actions/listings";
import { checkSellerPublicationRequirements } from "@/src/lib/seller-verification-policy";

// ─── Source-contract reads (structural pins giữ nguyên) ───────────────────────

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (p: string) => readFileSync(`${root}/${p}`, "utf8");

const sellNew = read("app/sell/new/page.tsx");
const sellEdit = read("app/sell/[id]/edit/page.tsx");
const listingDetail = read("app/listings/[slug]/page.tsx");
const listingForm = read("src/components/listing-form.tsx");
const profileForm = read("src/components/profile-form.tsx");
const modelPage = read("app/models/[slug]/page.tsx");

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SELLER_ID = "seller-1";
const OTHER_ID = "other-1";

const CATEGORY_BETA: Row = {
  id: "cat-beta",
  name: "Loa Bluetooth di động",
  slug: "portable_bluetooth_speaker",
  isActive: true,
  sortOrder: 1,
  icon: "🔊",
};

const CATEGORY_LEGACY: Row = {
  id: "cat-legacy",
  name: "Loa thùng",
  slug: "loa-thung-pa",
  isActive: true,
  sortOrder: 2,
  icon: "🎸",
};

const BRAND: Row = { id: "brand-jbl", name: "JBL", slug: "jbl" };

const MODEL_ROW: Row = {
  id: "model-1",
  name: "Charge 5",
  slug: "jbl-charge-5",
  brandId: "brand-jbl",
  categoryId: "cat-beta",
  status: "approved",
  releaseYear: 2021,
  description: null,
  specs: {},
  // relations đã "include" sẵn (mock include là pass-through — fixture mang nguyên)
  brand: { ...BRAND },
  category: { ...CATEGORY_BETA },
};

/** Listing row đầy đủ structured fields (Batch 4) + relations đã include sẵn. */
const listingRow = (over: Row = {}): Row => ({
  id: "listing-1",
  sellerId: SELLER_ID,
  title: "JBL Charge 5 đã qua sử dụng",
  slug: "jbl-charge-5",
  description: "Loa bluetooth di động còn tốt, pin trâu.",
  price: 1_800_000,
  status: "approved",
  condition: "good",
  city: "Hà Nội",
  negotiable: true,
  acceptExchange: false,
  viewCount: 3,
  categoryId: "cat-beta",
  brandId: "brand-jbl",
  productModelId: "model-1",
  inventoryContext: "used",
  includedAccessories: null,
  knownDefects: null,
  repairHistory: null,
  fulfillmentMethods: ["meetup"],
  provinceLevelCode: "ha-noi",
  locationDisplayName: "Gần cầu Long Biên",
  rejectionReason: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  images: [{ url: "/uploads/a.webp", checklistSlot: "front" }],
  category: { ...CATEGORY_BETA },
  brand: { ...BRAND },
  ...over,
});

/** ModerationAction listing.taken_down — case gắn sanction takedown (Batch 3). */
const takedownAction = (caseId: string | null): Row => ({
  id: "act-takedown",
  caseId,
  actorId: "admin-ops",
  actionType: "listing.taken_down",
  targetType: "listing",
  targetId: "listing-1",
  reasonCode: "policy_violation_confirmed",
  note: null,
  createdAt: "2026-10-02T00:00:00.000Z",
});

const priceRow = (id: string, price: number, kind: string): Row => ({
  id,
  modelId: "model-1",
  listingId: null,
  price,
  kind,
  createdAt: "2026-10-01T00:00:00.000Z",
});

/** Seed dữ liệu chung cho render đầy đủ của edit/new (cats + brands + models). */
const seedCatalog = (): void => {
  dbState.categories.push({ ...CATEGORY_BETA }, { ...CATEGORY_LEGACY });
  dbState.brands.push({ ...BRAND });
  dbState.models.push({ ...MODEL_ROW });
};

// ─── Page call helpers ────────────────────────────────────────────────────────

type SearchParams = Record<string, string | string[] | undefined>;
type EditPageFn = (props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) => Promise<unknown>;
type MyPageFn = (props: { searchParams: Promise<SearchParams> }) => Promise<unknown>;
type ModelPageFn = (props: { params: Promise<{ slug: string }> }) => Promise<unknown>;
type NewPageFn = () => Promise<unknown>;

const EditPage = sellEditPage.default as unknown as EditPageFn;
const MyPage = sellMyPage.default as unknown as MyPageFn;
const ModelPage = modelPageModule.default as unknown as ModelPageFn;
const NewPage = sellNewPage.default as unknown as NewPageFn;

type DetailPageFn = (props: { params: Promise<{ slug: string }> }) => Promise<unknown>;
const DetailPage = listingDetailPageModule.default as unknown as DetailPageFn;
const callDetail = (slug: string): Promise<unknown> =>
  DetailPage({ params: Promise.resolve({ slug }) });

const callEdit = (id: string, error?: string): Promise<unknown> =>
  EditPage({
    params: Promise.resolve({ id }),
    searchParams: Promise.resolve(error === undefined ? {} : { error }),
  });
const callMy = (): Promise<unknown> => MyPage({ searchParams: Promise.resolve({}) });
const callModel = (slug: string): Promise<unknown> =>
  ModelPage({ params: Promise.resolve({ slug }) });
const callNew = (): Promise<unknown> => NewPage();

// ─── React element tree helpers (async server component return value) ────────

type ElementLike = { type?: unknown; props?: Record<string, unknown> | null };

/** Toàn bộ text trong tree — assert nội dung render ra cho fixture được phép thấy. */
function textOf(node: unknown): string {
  const parts: string[] = [];
  const collect = (n: unknown): void => {
    if (n == null || typeof n === "boolean") return;
    if (typeof n === "string" || typeof n === "number") {
      parts.push(String(n));
      return;
    }
    if (Array.isArray(n)) {
      n.forEach(collect);
      return;
    }
    if (typeof n === "object" && n !== null) {
      collect((n as ElementLike).props?.["children"]);
    }
  };
  collect(node);
  return parts.join(" ");
}

/** Element có type === component cho trước có trong tree không (client component KHÔNG render — chỉ so type reference). */
function hasElement(node: unknown, type: unknown): boolean {
  let found = false;
  const walk = (n: unknown): void => {
    if (found || n == null || typeof n === "boolean") return;
    if (typeof n === "string" || typeof n === "number") return;
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (typeof n === "object" && n !== null) {
      const el = n as ElementLike;
      if (el.type === type) {
        found = true;
        return;
      }
      walk(el.props?.["children"]);
    }
  };
  walk(node);
  return found;
}

/** Props của element ĐẦU TIÊN có type === component cho trước. */
function propsOf(node: unknown, type: unknown): Record<string, unknown> | null {
  let found: Record<string, unknown> | null = null;
  const walk = (n: unknown): void => {
    if (found !== null || n == null || typeof n === "boolean") return;
    if (typeof n === "string" || typeof n === "number") return;
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (typeof n === "object" && n !== null) {
      const el = n as ElementLike;
      if (el.type === type && el.props != null) {
        found = el.props;
        return;
      }
      walk(el.props?.["children"]);
    }
  };
  walk(node);
  return found;
}

/** Mọi href trong tree (Link elements — assert đích redirect/notice). */
function hrefsOf(node: unknown): string[] {
  const out: string[] = [];
  const walk = (n: unknown): void => {
    if (n == null || typeof n === "boolean" || typeof n === "string" || typeof n === "number") return;
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (typeof n === "object" && n !== null) {
      const el = n as ElementLike;
      const href = el.props?.["href"];
      if (typeof href === "string") out.push(href);
      walk(el.props?.["children"]);
    }
  };
  walk(node);
  return out;
}

/** <form action={fn}> có trong tree không (server form — action là function reference). */
function hasFormWithAction(node: unknown, action: unknown): boolean {
  let found = false;
  const walk = (n: unknown): void => {
    if (found || n == null || typeof n === "boolean") return;
    if (typeof n === "string" || typeof n === "number") return;
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (typeof n === "object" && n !== null) {
      const el = n as ElementLike;
      if (el.type === "form" && el.props?.["action"] === action) {
        found = true;
        return;
      }
      walk(el.props?.["children"]);
    }
  };
  walk(node);
  return found;
}

const NOT_FOUND = /NEXT_HTTP_ERROR_FALLBACK;404/;

beforeEach(() => {
  dbState.listings.length = 0;
  dbState.categories.length = 0;
  dbState.brands.length = 0;
  dbState.models.length = 0;
  dbState.actions.length = 0;
  dbState.priceHistory.length = 0;
  dbState.wishlist.length = 0;
  sessionState.current = null;
  authState.user = {
    id: SELLER_ID,
    email: "seller@loaviet.test",
    name: "Người Bán",
    role: "seller",
    adminRole: null,
    sessionId: "sess-1",
    avatarUrl: null,
    isVerifiedSeller: true,
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── 1. app/sell/new — allowlist + verification + props (behavior) ───────────

describe("app/sell/new — chỉ category allowlist (spec §5.6.1)", () => {
  it("behavior: db CÓ category legacy active nhưng form chỉ nhận category beta", async () => {
    seedCatalog(); // cat-beta + cat-legacy đều isActive: true
    const tree = await callNew();
    const props = propsOf(tree, PortableListingForm);
    expect(props).not.toBeNull();
    expect(props!.categories).toEqual([
      { id: "cat-beta", name: "Loa Bluetooth di động" },
    ]);
    // allowlist là HẰNG SỐ dùng chung (không copy riêng cho page)
    expect(sellNew).toContain("BETA_PUBLICATION_CATEGORIES");
  });

  it("behavior: verification check đọc FRESH (checkSellerPublicationRequirements(user.id)) truyền cho bước 7", async () => {
    seedCatalog();
    const tree = await callNew();
    const props = propsOf(tree, PortableListingForm);
    expect(props).not.toBeNull();
    expect(checkSellerPublicationRequirements).toHaveBeenCalledWith(SELLER_ID);
    expect(props!.verification).toEqual({ ok: true, missing: [] });
  });

  it("behavior: photoSlots đủ 8 slot §5.6.3 + fulfillmentMethods đủ 4 giá trị §5.2 (từ constants)", async () => {
    seedCatalog();
    const tree = await callNew();
    const props = propsOf(tree, PortableListingForm);
    expect(props).not.toBeNull();
    expect(PHOTO_CHECKLIST_SLOTS).toHaveLength(8);
    expect(LISTING_FULFILLMENT_METHODS).toHaveLength(4);
    expect(props!.photoSlots).toHaveLength(8);
    expect(props!.fulfillmentMethods).toHaveLength(4);
    // provinces từ registry 34 đơn vị (FD-1) — KHÔNG định nghĩa lại
    expect(sellNew).toContain("PROVINCES.map");
  });
});

// ─── 2. app/sell/[id]/edit — moderation lock (MEDIUM-1) ──────────────────────

describe("app/sell/[id]/edit — moderation lock R5 (review fix MEDIUM-1)", () => {
  it("listing removed → read-only notice 'Tin đã bị gỡ bởi kiểm duyệt', KHÔNG render form", async () => {
    dbState.listings.push(listingRow({ status: "removed" }));
    dbState.actions.push(takedownAction("case-1"));
    const tree = await callEdit("listing-1");
    const text = textOf(tree);

    expect(text).toContain("Tin đã bị gỡ bởi kiểm duyệt");
    // form KHÔNG render — kể cả nút submit/draft của page
    expect(hasElement(tree, PortableListingForm)).toBe(false);
    expect(hasElement(tree, ListingForm)).toBe(false);
    expect(text).not.toContain("Gửi duyệt");
    expect(text).not.toContain("Sửa tin đăng");
  });

  it("case gắn takedown tồn tại → notice có link /appeal/<caseId> (Batch 3 appeal route)", async () => {
    dbState.listings.push(listingRow({ status: "removed" }));
    dbState.actions.push(takedownAction("case-1"));
    const tree = await callEdit("listing-1");
    expect(hrefsOf(tree)).toContain("/appeal/case-1");
    expect(hrefsOf(tree)).toContain("/sell/my");
  });

  it("takedown KHÔNG qua case (caseId null) → notice, KHÔNG link appeal (không mò caseId)", async () => {
    dbState.listings.push(listingRow({ status: "removed" }));
    dbState.actions.push(takedownAction(null));
    const tree = await callEdit("listing-1");
    expect(textOf(tree)).toContain("Tin đã bị gỡ bởi kiểm duyệt");
    expect(hrefsOf(tree).some((h) => h.startsWith("/appeal/"))).toBe(false);
  });

  it("gate dùng isModerationLocked từ @/src/lib/moderation — KHÔNG hardcode status (source pin)", () => {
    expect(sellEdit).toContain("isModerationLocked");
    expect(sellEdit).not.toMatch(/status === "removed"/);
  });

  it("listing removed của NGƯỜI KHÁC → notFound (IDOR — ownership check TRƯỚC lock notice)", async () => {
    dbState.listings.push(listingRow({ status: "removed" }));
    authState.user = { id: OTHER_ID, role: "buyer", adminRole: null, sessionId: "sess-2" };
    await expect(callEdit("listing-1")).rejects.toThrowError(NOT_FOUND);
  });

  it("chưa đăng nhập → redirect /login", async () => {
    dbState.listings.push(listingRow({ status: "removed" }));
    authState.user = null;
    await expect(callEdit("listing-1")).rejects.toThrowError(/NEXT_REDIRECT:\/login/);
  });
});

// ─── 2b. app/sell/[id]/edit — sold branch + regime switch + draft (behavior) ──

describe("app/sell/[id]/edit — sold + regime switch + draft flow (behavior)", () => {
  it("listing sold → notice đã bán, KHÔNG form (pin hành vi nhánh sold hiện có)", async () => {
    dbState.listings.push(listingRow({ status: "sold" }));
    const tree = await callEdit("listing-1");
    const text = textOf(tree);
    expect(text).toContain("Tin đã bán — không thể chỉnh sửa");
    expect(hasElement(tree, PortableListingForm)).toBe(false);
    expect(hasElement(tree, ListingForm)).toBe(false);
  });

  it("beta listing → PortableListingForm; legacy listing → ListingForm (grandfathered)", async () => {
    seedCatalog();
    dbState.listings.push(listingRow({}));
    const betaTree = await callEdit("listing-1");
    expect(hasElement(betaTree, PortableListingForm)).toBe(true);
    expect(hasElement(betaTree, ListingForm)).toBe(false);

    dbState.listings.length = 0;
    dbState.listings.push(
      listingRow({ categoryId: "cat-legacy", category: { ...CATEGORY_LEGACY } }),
    );
    const legacyTree = await callEdit("listing-1");
    expect(hasElement(legacyTree, ListingForm)).toBe(true);
    expect(hasElement(legacyTree, PortableListingForm)).toBe(false);
  });

  it("draft → form Gửi duyệt gắn submitListingAction (KHÔNG updateListingAction cho draft)", async () => {
    seedCatalog();
    dbState.listings.push(listingRow({ status: "draft" }));
    const tree = await callEdit("listing-1");
    expect(textOf(tree)).toContain("Gửi duyệt");
    expect(hasFormWithAction(tree, submitListingAction)).toBe(true);
  });

  it("?saved=draft trên draft → banner 'Đã lưu nháp'; trên approved hoặc giá trị khác → không banner", async () => {
    seedCatalog();
    dbState.listings.push(listingRow({ status: "draft" }));
    const saved = await EditPage({
      params: Promise.resolve({ id: "listing-1" }),
      searchParams: Promise.resolve({ saved: "draft" }),
    });
    expect(textOf(saved)).toContain("Đã lưu nháp");
    const forged = await EditPage({
      params: Promise.resolve({ id: "listing-1" }),
      searchParams: Promise.resolve({ saved: "<b>x</b>" }),
    });
    expect(textOf(forged)).not.toContain("Đã lưu nháp");
    expect(textOf(forged)).not.toContain("<b>x</b>");
    dbState.listings[0]!.status = "approved";
    const approved = await EditPage({
      params: Promise.resolve({ id: "listing-1" }),
      searchParams: Promise.resolve({ saved: "draft" }),
    });
    expect(textOf(approved)).not.toContain("Đã lưu nháp");
  });

  it("approved → KHÔNG form Gửi duyệt (chỉ draft có submit)", async () => {
    seedCatalog();
    dbState.listings.push(listingRow({ status: "approved" }));
    const tree = await callEdit("listing-1");
    expect(textOf(tree)).not.toContain("Gửi duyệt");
    expect(hasFormWithAction(tree, submitListingAction)).toBe(false);
  });

  it("structural: regime derive TỪ DB row (.include(\"category\") + listingRegimeForCategorySlug)", () => {
    expect(sellEdit).toContain(`.include("category"`);
    expect(sellEdit).toContain("listingRegimeForCategorySlug");
  });
});

// ─── 2c. app/sell/[id]/edit — ?error= banner (LOW-1 — own-property-safe) ──────

describe("app/sell/[id]/edit — banner ?error= (review fix LOW-1)", () => {
  it("?error=CONCURRENT_CHANGE → text tiếng Việt của code (parallel note Task 4)", async () => {
    seedCatalog();
    dbState.listings.push(listingRow({}));
    const tree = await callEdit("listing-1", "CONCURRENT_CHANGE");
    expect(textOf(tree)).toContain("Tin vừa thay đổi trạng thái — tải lại trang và kiểm tra lại");
  });

  it("?error=RATE_LIMITED → text rate limit", async () => {
    seedCatalog();
    dbState.listings.push(listingRow({}));
    const tree = await callEdit("listing-1", "RATE_LIMITED");
    expect(textOf(tree)).toContain("Bạn thao tác quá nhanh — thử lại sau ít phút");
  });

  it("?error=__proto__ → generic fallback, KHÔNG crash (prototype key không resolve)", async () => {
    seedCatalog();
    dbState.listings.push(listingRow({}));
    const tree = await callEdit("listing-1", "__proto__");
    const text = textOf(tree);
    expect(text).toContain(SUBMIT_ERROR_TEXT.CONTENT_INVALID!);
    expect(text).toContain("Sửa tin đăng"); // page vẫn render form bình thường
  });

  it("?error=constructor → generic fallback (KHÔNG trả function)", async () => {
    seedCatalog();
    dbState.listings.push(listingRow({}));
    const tree = await callEdit("listing-1", "constructor");
    expect(textOf(tree)).toContain(SUBMIT_ERROR_TEXT.CONTENT_INVALID!);
  });

  it("?error=<code lạ> → generic fallback (fail closed — KHÔNG phản chiếu query text)", async () => {
    seedCatalog();
    dbState.listings.push(listingRow({}));
    const tree = await callEdit("listing-1", "SOMETHING_EVIL");
    const text = textOf(tree);
    expect(text).toContain(SUBMIT_ERROR_TEXT.CONTENT_INVALID!);
    expect(text).not.toContain("SOMETHING_EVIL");
  });

  it("không có ?error= → KHÔNG banner", async () => {
    seedCatalog();
    dbState.listings.push(listingRow({}));
    const tree = await callEdit("listing-1");
    expect(textOf(tree)).not.toContain(SUBMIT_ERROR_TEXT.CONTENT_INVALID!);
  });
});

// ─── 3. app/sell/my — draft submit + status labels (behavior) ─────────────────

describe("app/sell/my — draft submit + status labels (R8)", () => {
  it("draft → nút Gửi duyệt (form submitListingAction); approved → nút Ẩn, KHÔNG Gửi duyệt", async () => {
    dbState.listings.push(listingRow({ id: "l-draft", status: "draft" }));
    dbState.listings.push(listingRow({ id: "l-live", status: "approved" }));
    const tree = await callMy();
    const text = textOf(tree);

    expect(text).toContain("Gửi duyệt");
    expect(hasFormWithAction(tree, submitListingAction)).toBe(true);
    expect(text).toContain("Ẩn"); // approved → toggle visibility
  });

  it("chỉ listing approved → KHÔNG nút Gửi duyệt", async () => {
    dbState.listings.push(listingRow({ id: "l-live", status: "approved" }));
    const tree = await callMy();
    expect(textOf(tree)).not.toContain("Gửi duyệt");
    expect(hasFormWithAction(tree, submitListingAction)).toBe(false);
  });

  it("label qua constants: removed → 'Đã gỡ bởi kiểm duyệt' (Batch 3), archived → 'Đã lưu trữ' (R8)", async () => {
    dbState.listings.push(listingRow({ id: "l-removed", status: "removed" }));
    dbState.listings.push(listingRow({ id: "l-archived", status: "archived" }));
    const tree = await callMy();
    const text = textOf(tree);
    expect(text).toContain("Đã gỡ bởi kiểm duyệt");
    expect(text).toContain("Đã lưu trữ");
    expect(LISTING_STATUS_LABELS.removed).toBeTruthy();
    expect(LISTING_STATUS_BADGE.archived).toBeTruthy();
  });
});

// ─── 4. app/listings/[slug] — structured fields cho buyer (spec §5.6) ────────

describe("app/listings/[slug] — structured fields cho buyer", () => {
  it("render inventory context / defects / repair / accessories / fulfillment / location", () => {
    expect(listingDetail).toContain("INVENTORY_CONTEXT_LABELS");
    expect(listingDetail).toContain("listing.knownDefects");
    expect(listingDetail).toContain("listing.repairHistory");
    expect(listingDetail).toContain("listing.includedAccessories");
    expect(listingDetail).toContain("FULFILLMENT_METHOD_LABELS");
    expect(listingDetail).toContain("listing.fulfillmentMethods");
    expect(listingDetail).toContain("listing.locationDisplayName");
  });

  it("NULL → section vắng (conditional render — KHÔNG text 'null'/placeholder)", () => {
    expect(listingDetail).toMatch(/listing\.knownDefects != null/);
    expect(listingDetail).toMatch(/listing\.inventoryContext != null/);
    expect(listingDetail).toMatch(/listing\.repairHistory != null/);
    expect(listingDetail).toMatch(/listing\.includedAccessories != null/);
  });

  it("read gate: admin authority từ session MFA + capability — KHÔNG BAO GIỜ user.role (Batch 4 holistic fix)", () => {
    // Legacy `user?.role !== "admin"` (display role — setAdminRoleAction gán
    // role='admin' cho buyer được promote support/analyst) ĐÃ XÓA.
    expect(listingDetail).not.toContain(`user?.role !== "admin"`);
    expect(listingDetail).not.toMatch(/\.role === "admin"/);
    // Nguồn quyền mới: session.isAdmin (bằng chứng MFA) + capability matrix
    // listing.moderate qua capabilitiesOf (rbac helpers — non-throwing).
    expect(listingDetail).toContain("getSessionFromCookie");
    expect(listingDetail).toContain("capabilitiesOf");
    expect(listingDetail).toContain("session.isAdmin");
    expect(listingDetail).toContain(`"listing.moderate"`);
    // draft owner-only (L5 — /admin/listings cũng loại draft khỏi queue).
    expect(listingDetail).toMatch(/listing\.status !== "draft"/);
  });

  it("label lookup own-property-safe (LOW-1 — keyed bởi DB data qua labelOf)", () => {
    expect(listingDetail).toContain("labelOf(");
    expect(listingDetail).not.toMatch(/CONDITION_LABELS\[listing\.condition\]/);
    expect(listingDetail).not.toMatch(/INVENTORY_CONTEXT_LABELS\[listing\.inventoryContext\]/);
    expect(listingDetail).not.toMatch(/FULFILLMENT_METHOD_LABELS\[m\]/);
  });
});

// ─── 4b. app/listings/[slug] — read gate behavior (Batch 4 holistic fix) ─────
//
// CONFIRMED MEDIUM (b4-holistic): non-public listing hiển thị cho BẤT KÌ ai
// có display User.role='admin' — không MFA, không capability. Buyer được
// promote adminRole support/analyst (setAdminRoleAction vẫn gán role='admin')
// xem được draft/pending của seller khác nguyên vẹn (knownDefects, chat,
// wishlist, report). Admin authority phải là session.isAdmin (MFA) +
// capabilitiesOf(adminRole) có listing.moderate — KHÔNG BAO GIỜ user.role.

describe("app/listings/[slug] — read gate: admin authority session MFA + capability (behavior)", () => {
  const DETAIL_SELLER = "seller-detail-owner";
  const DETAIL_SLUG = "loa-detail-pending";

  /** Listing non-public của seller khác (relations gắn sẵn — mock include pass-through). */
  const detailListing = (over: Row = {}): Row =>
    listingRow({
      id: "listing-detail",
      sellerId: DETAIL_SELLER,
      slug: DETAIL_SLUG,
      status: "pending",
      productModelId: null, // bỏ modelStats (aggregate fixture 0)
      images: [],
      seller: {
        id: DETAIL_SELLER,
        name: "Người Bán Khác",
        city: "Hà Nội",
        createdAt: "2026-10-01T00:00:00.000Z",
        avatarUrl: null,
        sellerVerification: null,
      },
      ...over,
    });

  /** Session fixture — điều khiển isAdmin (bằng chứng MFA) + adminRole. */
  const detailSession = (over: {
    userId?: string;
    isAdmin?: boolean;
    adminRole?: string | null;
    role?: string;
  } = {}) => ({
    session: {
      id: "sess-detail",
      userId: over.userId ?? "user-viewer",
      isAdmin: over.isAdmin ?? false,
      createdAt: "2026-10-06T08:00:00.000Z",
      lastSeenAt: null,
      expiresAt: "2026-10-07T08:00:00.000Z",
      steppedUpAt: null,
      userAgent: null,
    },
    user: {
      id: over.userId ?? "user-viewer",
      email: "viewer@loaviet.test",
      name: "Viewer",
      role: over.role ?? "buyer",
      avatarUrl: null,
      isVerifiedSeller: false,
      adminRole: over.adminRole ?? null,
      sessionId: "sess-detail",
    },
  });

  beforeEach(() => {
    dbState.listings.push(detailListing());
  });

  it("display role 'admin' (adminRole null) → notFound — role KHÔNG là nguồn quyền", async () => {
    sessionState.current = detailSession({ role: "admin", adminRole: null, isAdmin: true });
    await expect(callDetail(DETAIL_SLUG)).rejects.toThrowError(NOT_FOUND);
  });

  it("adminRole support/analyst (KHÔNG có listing.moderate) + session MFA → notFound", async () => {
    sessionState.current = detailSession({ isAdmin: true, adminRole: "analyst", role: "admin" });
    await expect(callDetail(DETAIL_SLUG)).rejects.toThrowError(NOT_FOUND);
    sessionState.current = detailSession({ isAdmin: true, adminRole: "support", role: "admin" });
    await expect(callDetail(DETAIL_SLUG)).rejects.toThrowError(NOT_FOUND);
  });

  it("moderator + session MFA (isAdmin=true) → RENDER pending của seller khác", async () => {
    sessionState.current = detailSession({ isAdmin: true, adminRole: "moderator", role: "admin" });
    const tree = await callDetail(DETAIL_SLUG);
    expect(textOf(tree)).toContain("JBL Charge 5 đã qua sử dụng");
  });

  it("moderator + session THƯỜNG (isAdmin=false — chưa qua MFA) → notFound", async () => {
    sessionState.current = detailSession({ isAdmin: false, adminRole: "moderator", role: "admin" });
    await expect(callDetail(DETAIL_SLUG)).rejects.toThrowError(NOT_FOUND);
  });

  it("draft owner-only (L5): moderator MFA → notFound; owner → render", async () => {
    dbState.listings.length = 0;
    dbState.listings.push(detailListing({ status: "draft" }));

    sessionState.current = detailSession({ isAdmin: true, adminRole: "moderator", role: "admin" });
    await expect(callDetail(DETAIL_SLUG)).rejects.toThrowError(NOT_FOUND);

    sessionState.current = detailSession({ userId: DETAIL_SELLER, role: "seller" });
    const tree = await callDetail(DETAIL_SLUG);
    expect(textOf(tree)).toContain("JBL Charge 5 đã qua sử dụng");
  });

  it("owner xem pending của chính mình → render (không cần moderator)", async () => {
    sessionState.current = detailSession({ userId: DETAIL_SELLER, role: "seller" });
    const tree = await callDetail(DETAIL_SLUG);
    expect(textOf(tree)).toContain("JBL Charge 5 đã qua sử dụng");
  });

  it("approved → render cho khách chưa đăng nhập (không session)", async () => {
    dbState.listings.length = 0;
    dbState.listings.push(detailListing({ status: "approved" }));
    sessionState.current = null;
    const tree = await callDetail(DETAIL_SLUG);
    expect(textOf(tree)).toContain("JBL Charge 5 đã qua sử dụng");
  });
});

// ─── 5. CITIES refresh (FD-1) + label maps mới ────────────────────────────────

describe("CITIES refresh (FD-1 — 34 đơn vị NQ 202/2025/QH15)", () => {
  it("34 displayName chuẩn của registry + 'Khác', đúng thứ tự registry", () => {
    expect(CITIES).toEqual([...PROVINCES.map((p) => p.displayName), "Khác"]);
    expect(CITIES).toHaveLength(35);
  });

  it("KHÔNG còn tên stale pre-merger; Huế + TP. Hồ Chí Minh có mặt", () => {
    expect(CITIES).not.toContain("Bình Dương");
    expect(CITIES).not.toContain("Thừa Thiên Huế");
    expect(CITIES).toContain("Huế");
    expect(CITIES).toContain("TP. Hồ Chí Minh");
  });

  it("label maps mới đủ đúng khóa (PROVISIONAL — founder content, Batch 8 register)", () => {
    expect(Object.keys(INVENTORY_CONTEXT_LABELS).sort()).toEqual(["new", "open_box", "used"]);
    expect(Object.keys(FULFILLMENT_METHOD_LABELS).sort()).toEqual([
      "carrier",
      "meetup",
      "other",
      "seller_delivery",
    ]);
    expect(Object.keys(PHOTO_CHECKLIST_SLOT_LABELS).sort()).toEqual([...PHOTO_CHECKLIST_SLOTS].sort());
  });
});

// ─── 6. Legacy select guard (item 11 — stored city KHÔNG bị rewrite im lặng) ─

describe("legacy select guard — stored city ngoài CITIES (item 11)", () => {
  it("listing-form render option riêng cho stored city không nằm trong CITIES", () => {
    expect(listingForm).toMatch(/!cities\.includes\(/);
    expect(listingForm).toMatch(/extraCity/);
  });

  it("profile-form render option riêng cho stored profile city", () => {
    expect(profileForm).toMatch(/!CITIES\.includes\(/);
  });
});

// ─── 7. app/models/[slug] — price context (LOW-3 + §13.6/§5.8.2) ─────────────

describe("app/models/[slug] — price context (review fix LOW-3)", () => {
  it("behavior: 2 mẫu giá (<3) → 'Khoảng giá đã thu thập' (PROVISIONAL — Batch 8 register) + card 'Mẫu giá thu thập'", async () => {
    dbState.models.push({ ...MODEL_ROW });
    dbState.priceHistory.push(priceRow("p-1", 1_700_000, "listed"), priceRow("p-2", 1_900_000, "sold"));
    const tree = await callModel("jbl-charge-5");
    const text = textOf(tree);
    expect(text).toContain("Khoảng giá đã thu thập");
    expect(text).not.toContain("Khoảng giá thị trường");
    expect(text).toContain("Mẫu giá thu thập");
  });

  it("behavior: 3 mẫu giá (≥3) → 'Khoảng giá thị trường'", async () => {
    dbState.models.push({ ...MODEL_ROW });
    dbState.priceHistory.push(
      priceRow("p-1", 1_700_000, "listed"),
      priceRow("p-2", 1_900_000, "sold"),
      priceRow("p-3", 2_100_000, "listed"),
    );
    const tree = await callModel("jbl-charge-5");
    const text = textOf(tree);
    expect(text).toContain("Khoảng giá thị trường");
    expect(text).not.toContain("Khoảng giá đã thu thập");
  });

  it("behavior: 0 mẫu giá → KHÔNG price block (stats null)", async () => {
    dbState.models.push({ ...MODEL_ROW });
    const tree = await callModel("jbl-charge-5");
    const text = textOf(tree);
    expect(text).not.toContain("Mẫu giá thu thập");
    expect(text).not.toContain("Khoảng giá");
  });

  it("copy: KHÔNG thêm claim authoritative (§13.6/§13.7 — source pin giữ nguyên)", () => {
    expect(modelPage).not.toContain("giá thị trường chuẩn");
  });
});
