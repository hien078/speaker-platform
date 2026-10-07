/**
 * Admin listings page — server-side guard (review follow-up Batch 2 Task 4,
 * spec §4.5/§4.9 + Acceptance Gate "every admin page/action guarded
 * server-side") + RENDER hợp đồng review card (Batch 4 Task 6 review fix).
 *
 * Trang moderation queue phải TỰ guard `listing.moderate` — requireAdminUser
 * ở layout chỉ là cổng vào /admin (mọi adminRole đều qua được), KHÔNG phải
 * quyền xem queue; action approve/reject đã guard riêng
 * (src/lib/actions/admin.ts — defense-in-depth: control vắng mặt ≠ quyền).
 *
 * Hợp đồng guard:
 *  1. support/analyst (chỉ admin.access) → FORBIDDEN — và guard chạy TRƯỚC
 *     mọi data read (db không bị chạm).
 *  2. moderator/operations_admin (có listing.moderate) → render queue.
 *  3. Chưa đăng nhập → FORBIDDEN.
 *
 * RENDER hợp đồng (review fix M1/M2/L5 — source-string test bare match cả
 * comment: badge điều kiện ĐẢO NGƯỢC vẫn xanh hết. Render qua textOf chứng
 * minh moderator THẤY GÌ trên card thật):
 *  (a) legacy fixture → "Danh mục legacy" + "—" (NULL = not captured,
 *      spec §8.3) + badge verified khi SellerVerification.status "verified".
 *  (b) status "revoked" → KHÔNG badge verified (workflow sống — spec §8.2:
 *      thu hồi mất badge NGAY, boolean legacy đóng băng không phải nguồn).
 *  (c) beta fixture đầy đủ structured → labels + province display name
 *      (FD-1 registry) + link /models/<slug> + badge model chưa canonical
 *      (L3) + caption slot §5.6.3 — ĐÚNG THỨ TỰ đọc.
 *  (M2) url ảnh path same-origin sạch → <img src>; url có scheme
 *      (https://… — pre-Batch-4 row) → placeholder "URL ảnh không hợp lệ",
 *      KHÔNG <img src>, KHÔNG <a href> tới nó (moderator IP/UA leak).
 *  (L5) mọi query của page LOẠI "draft" (seller-private — spec §4.4) khỏi
 *      CẢ HAI tab (Chờ duyệt = pending; Tất cả = status ≠ draft).
 *
 * Cơ chế mock như admin-finance-readonly.test.ts: session seam điều khiển
 * được, guard thật chạy qua rbac thật; db fixture qua dbState.rows (render
 * test đổi fixture), where arg ghi lại cho assert L5.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

// Session seam — guard đọc qua getSessionFromCookie (rbac thật)
const sessionState = vi.hoisted(() => ({
  current: null as { session: Record<string, unknown>; user: Record<string, unknown> } | null,
}));

vi.mock("@/src/lib/session", () => ({
  getSessionFromCookie: vi.fn(async () => sessionState.current),
}));

// Page import action để gắn <form action> — stub là đủ; guard của action
// assert ở rbac.test.ts + financial-shutdown-actions.test.ts.
vi.mock("@/src/lib/actions/admin", () => ({
  approveListingAction: vi.fn(),
  rejectListingAction: vi.fn(),
}));

// db fixture — chainable query builder; đếm lần .all() để assert guard-before-read
const dbState = vi.hoisted(() => ({
  allCalls: 0,
  /** Arg của .where(...) lần cuối — assert L5 (loại draft khỏi mọi tab). */
  lastWhere: null as unknown,
  /** Rows trả về từ .all() — render test đổi fixture qua đây. */
  rows: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/src/prisma/db.client", () => {
  // Fixture shape theo query Batch 4 Task 6 (fixture shape only — invariant
  // guard không đổi): seller (name/email) + nested sellerVerification (badge
  // đọc workflow — spec §8.2), category (name + slug — badge regime §5.6.1),
  // brand, productModel (name/slug/status — L3), images KHÔNG .limit(1)
  // (id/url/checklistSlot), structured fields NULL = legacy "not captured"
  // (spec §8.3).
  const chain = {
    where: (arg: unknown) => {
      dbState.lastWhere = arg;
      return chain;
    },
    include: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    all: async () => {
      dbState.allCalls += 1;
      return dbState.rows;
    },
  };
  return { db: { orm: { public: { Listing: chain } } } };
});

import * as listingsPage from "../../app/admin/listings/page";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SESSION = {
  id: "sess-1",
  userId: "user-1",
  isAdmin: true,
  createdAt: "2026-10-06T08:00:00.000Z",
  lastSeenAt: null,
  expiresAt: "2026-10-06T20:00:00.000Z",
  steppedUpAt: null,
  userAgent: null,
} as const;

/** SessionUser fixture — adminRole là nguồn quyền duy nhất (spec §8.5). */
const userWith = (adminRole: string | null) => ({
  id: "user-1",
  email: "u@loaviet.test",
  name: "U",
  role: "buyer",
  avatarUrl: null,
  isVerifiedSeller: false,
  adminRole,
  sessionId: "sess-1",
});

const login = (adminRole: string | null): void => {
  sessionState.current = { session: { ...SESSION }, user: userWith(adminRole) };
};

type PageFn = (props: { searchParams: Promise<{ tab?: string }> }) => Promise<unknown>;
const AdminListingsPage = listingsPage.default as unknown as PageFn;
const call = (tab?: string): Promise<unknown> =>
  AdminListingsPage({ searchParams: Promise.resolve(tab === undefined ? {} : { tab }) });

/** Listing legacy (category slug ngoài allowlist) — structured NULL, ảnh seed. */
const LEGACY_LISTING = {
  id: "listing-1",
  title: "Loa JBL Charge 5 cũ",
  price: 1_800_000,
  status: "pending",
  condition: "used",
  city: "Hà Nội",
  description: "Loa bluetooth cũ còn tốt",
  createdAt: "2026-10-06T08:00:00.000Z",
  inventoryContext: null,
  includedAccessories: null,
  knownDefects: null,
  repairHistory: null,
  fulfillmentMethods: null,
  provinceLevelCode: null,
  locationDisplayName: null,
  images: [{ id: "img-1", url: "/img/listings/loa.jpg", checklistSlot: null }],
  seller: {
    name: "Trần Bán",
    email: "ban@loaviet.test",
    sellerVerification: { status: "verified" },
  },
  category: { name: "Loa bluetooth", slug: "loa-bluetooth" },
  brand: null,
  productModel: null,
};

/** Listing beta (slug allowlist §5.6.1) — ĐẦY ĐỦ mọi trường structured. */
const BETA_LISTING = {
  id: "listing-beta",
  title: "Loa JBL Charge 5 like new",
  price: 2_500_000,
  status: "pending",
  condition: "good",
  city: "TP. Hồ Chí Minh",
  description: "Loa bluetooth JBL Charge 5 còn bảo hành 3 tháng",
  createdAt: "2026-10-06T09:00:00.000Z",
  inventoryContext: "used",
  includedAccessories: "Cáp sạc, hộp",
  knownDefects: "Vết xước nhẹ ở mặt dưới",
  repairHistory: "Đã thay pin tháng 3",
  fulfillmentMethods: ["meetup", "carrier"],
  provinceLevelCode: "ho-chi-minh",
  locationDisplayName: "Quận 1",
  images: [
    {
      id: "img-front",
      url: "/uploads/01234567-89ab-cdef-0123-456789abcdef.webp",
      checklistSlot: "front",
    },
    { id: "img-back", url: "/img/listings/charge5-back.jpg", checklistSlot: "back" },
    {
      id: "img-serial",
      url: "/uploads/01234567-89ab-cdef-0123-456789abcdef.png",
      checklistSlot: "label_serial",
    },
  ],
  seller: {
    name: "Lê Beta",
    email: "beta@loaviet.test",
    sellerVerification: { status: "verified" },
  },
  category: { name: "Loa Bluetooth di động", slug: "portable_bluetooth_speaker" },
  brand: { name: "JBL" },
  productModel: { name: "Charge 5", slug: "jbl-charge-5", status: "pending" },
};

/** Listing để test M2: 2 ảnh path sạch + 1 url scheme + 1 traversal. */
const IMAGE_URL_LISTING = {
  ...LEGACY_LISTING,
  id: "listing-img",
  images: [
    { id: "img-ok", url: "/uploads/01234567-89ab-cdef-0123-456789abcdef.webp", checklistSlot: null },
    { id: "img-seed", url: "/img/listings/seed.jpg", checklistSlot: null },
    { id: "img-evil", url: "https://tracker.example/pixel.jpg", checklistSlot: null },
    { id: "img-traversal", url: "/uploads/../secrets.jpg", checklistSlot: null },
  ],
};

// ─── React element tree helpers (async server component return value) ───────

type ElementLike = {
  type?: unknown;
  props?: ({ children?: unknown; src?: unknown; href?: unknown } | null) | undefined;
};

/** Đệ quy duyệt element tree — không render, chỉ inspect cấu trúc tĩnh. */
function walk(node: unknown, visit: (el: ElementLike) => void): void {
  if (node == null || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node === "object" && node !== null) {
    const el = node as ElementLike;
    if (el.type !== undefined) {
      visit(el);
      walk(el.props?.children, visit);
    }
  }
}

/** Toàn bộ text trong tree — assert nội dung render ra cho role được phép. */
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
      collect((n as ElementLike).props?.children);
    }
  };
  collect(node);
  return parts.join(" ");
}

/** src của mọi <img> trong tree — assert ảnh nào ĐƯỢC render (M2). */
function srcsOf(node: unknown): string[] {
  const srcs: string[] = [];
  walk(node, (el) => {
    if (el.type === "img" && typeof el.props?.src === "string") srcs.push(el.props.src);
  });
  return srcs;
}

/** href của mọi <a> trong tree — assert link model chuẩn (c) + KHÔNG link url bị chặn (M2). */
function hrefsOf(node: unknown): string[] {
  const hrefs: string[] = [];
  walk(node, (el) => {
    if (el.type === "a" && typeof el.props?.href === "string") hrefs.push(el.props.href);
  });
  return hrefs;
}

/**
 * Gọi where-lambda page ghi lại với field proxy stub — đọc op mà page build
 * (L5: assert NEQ draft / EQ pending, không tin comment).
 */
const applyWhere = (fn: unknown): { op: string; value: string } => {
  expect(typeof fn).toBe("function");
  const proxy = {
    status: {
      eq: (value: string) => ({ op: "eq", value }),
      neq: (value: string) => ({ op: "neq", value }),
    },
  };
  return (fn as (l: typeof proxy) => { op: string; value: string })(proxy);
};

beforeEach(() => {
  sessionState.current = null;
  dbState.allCalls = 0;
  dbState.lastWhere = null;
  dbState.rows = [LEGACY_LISTING];
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── Guard listing.moderate — deny sai role TRƯỚC khi đọc db (spec §4.5) ─────

describe("admin listings page — guard listing.moderate server-side (spec §4.5/§4.9)", () => {
  it("support (chỉ admin.access) → FORBIDDEN, db KHÔNG bị chạm", async () => {
    login("support");
    await expect(call()).rejects.toThrowError(/^FORBIDDEN$/);
    expect(dbState.allCalls).toBe(0);
  });

  it("analyst (admin.access + analytics.read) → FORBIDDEN, db KHÔNG bị chạm", async () => {
    login("analyst");
    await expect(call()).rejects.toThrowError(/^FORBIDDEN$/);
    expect(dbState.allCalls).toBe(0);
  });

  it("chưa đăng nhập → FORBIDDEN (fail closed)", async () => {
    await expect(call()).rejects.toThrowError(/^FORBIDDEN$/);
    expect(dbState.allCalls).toBe(0);
  });

  it("moderator (listing.moderate) → render queue", async () => {
    login("moderator");
    const tree = await call();
    expect(textOf(tree)).toContain("Loa JBL Charge 5 cũ");
    expect(dbState.allCalls).toBe(1);
  });

  it("operations_admin (listing.moderate) → render queue", async () => {
    login("operations_admin");
    const tree = await call();
    expect(textOf(tree)).toContain("Loa JBL Charge 5 cũ");
    expect(dbState.allCalls).toBe(1);
  });
});

// ─── Render (M1) — legacy fixture: regime badge + "—" + verified badge ───────

describe("admin listings review card — render legacy fixture (M1a — spec §8.3/§8.2)", () => {
  it("(a) 'Danh mục legacy' + '—' cho NULL + badge verified khi status = verified", async () => {
    login("moderator");
    dbState.rows = [LEGACY_LISTING];
    const tree = await call();
    const text = textOf(tree);
    // regime badge derive từ category slug (§5.6.1) — legacy = grandfathered
    expect(text).toContain("Danh mục legacy");
    expect(text).not.toContain("Danh mục beta");
    // NULL structured = legacy "not captured" (spec §8.3) → "—", KHÔNG backfill
    expect(text).toContain("—");
    // badge verified đọc WORKFLOW SỐNG (fixture: status "verified")
    expect(text).toContain("đã xác minh");
    // ảnh seed legacy vẫn render <img> (path same-origin sạch)
    expect(srcsOf(tree)).toContain("/img/listings/loa.jpg");
  });

  it("(b) status 'revoked' → KHÔNG badge verified (thu hồi mất badge NGAY)", async () => {
    login("moderator");
    dbState.rows = [
      {
        ...LEGACY_LISTING,
        seller: {
          ...LEGACY_LISTING.seller,
          sellerVerification: { status: "revoked" },
        },
      },
    ];
    const tree = await call();
    expect(textOf(tree)).not.toContain("đã xác minh");
  });
});

// ─── Render (M1) — beta fixture: structured fields + model + slots ──────────

describe("admin listings review card — render beta fixture (M1c — spec §5.6/§5.6.3)", () => {
  it("(c) labels + province display + link /models/<slug> + badge model + caption slot, đúng thứ tự", async () => {
    login("moderator");
    dbState.rows = [BETA_LISTING];
    const tree = await call();
    const text = textOf(tree);

    // regime badge beta (slug allowlist §5.6.1)
    expect(text).toContain("Danh mục beta");
    expect(text).not.toContain("Danh mục legacy");

    // labels structured (spec §5.6) — moderator đọc label TRƯỚC giá trị
    for (const label of [
      "Nguồn hàng",
      "Model chuẩn",
      "Vị trí",
      "Cách giao hàng",
      "Phụ kiện kèm theo",
      "Vết lỗi đã biết",
      "Lịch sử sửa chữa",
    ]) {
      expect(text).toContain(label);
    }

    // giá trị structured theo label maps (L1) — đúng thứ tự đọc
    expect(text.indexOf("Nguồn hàng")).toBeLessThan(text.indexOf("Đã qua sử dụng"));
    expect(text.indexOf("Cách giao hàng")).toBeLessThan(
      text.indexOf("Gặp trực tiếp · Đơn vị vận chuyển"),
    );
    expect(text.indexOf("Vị trí")).toBeLessThan(text.indexOf("Quận 1 · TP. Hồ Chí Minh"));
    expect(text).toContain("Cáp sạc, hộp");
    expect(text).toContain("Vết xước nhẹ ở mặt dưới");
    expect(text).toContain("Đã thay pin tháng 3");

    // province display name từ registry FD-1 (PROVINCE_CODES["ho-chi-minh"])
    // + seller coarse display — join " · " đúng thứ tự locationParts
    expect(text).toContain("Quận 1 · TP. Hồ Chí Minh");

    // link model chuẩn /models/<slug> (§6.3 Step 1)
    expect(hrefsOf(tree)).toContain("/models/jbl-charge-5");

    // badge model CHƯA canonical (L3 — status "pending" ≠ "approved")
    expect(text).toContain("Model chờ duyệt");

    // caption slot §5.6.3 theo thứ tự ảnh (Mặt trước → Mặt sau → Nhãn / serial)
    expect(text.indexOf("Mặt trước")).toBeLessThan(text.indexOf("Mặt sau"));
    expect(text.indexOf("Mặt sau")).toBeLessThan(text.indexOf("Nhãn / serial"));

    // mọi ảnh render <img> (gallery KHÔNG cắt ở ảnh đầu — ảnh 1/2/3 đều có)
    const srcs = srcsOf(tree);
    expect(srcs).toContain("/uploads/01234567-89ab-cdef-0123-456789abcdef.webp");
    expect(srcs).toContain("/img/listings/charge5-back.jpg");
    expect(srcs).toContain("/uploads/01234567-89ab-cdef-0123-456789abcdef.png");
  });
});

// ─── Render (M2) — img src chỉ path same-origin sạch ─────────────────────────

describe("admin listings review card — img src an toàn (M2 — review fix)", () => {
  it("path sạch → <img src>; url scheme/traversal → placeholder, KHÔNG img/link tới nó", async () => {
    login("moderator");
    dbState.rows = [IMAGE_URL_LISTING];
    const tree = await call();
    const srcs = srcsOf(tree);

    // path same-origin sạch ĐƯỢC render (ảnh upload + ảnh seed multi-segment)
    expect(srcs).toContain("/uploads/01234567-89ab-cdef-0123-456789abcdef.webp");
    expect(srcs).toContain("/img/listings/seed.jpg");

    // url có scheme KHÔNG bao giờ vào <img src> — browser moderator request
    // nó thì leak IP/UA về server attacker (tracking pixel)
    expect(srcs).not.toContain("https://tracker.example/pixel.jpg");
    // traversal cũng chặn (path pattern sạch nhưng có "..")
    expect(srcs).not.toContain("/uploads/../secrets.jpg");

    // placeholder text thay ảnh bị chặn — KHÔNG link tới url bị chặn
    const text = textOf(tree);
    expect(text).toContain("URL ảnh không hợp lệ");
    expect(hrefsOf(tree).join(" ")).not.toContain("tracker.example");
  });
});

// ─── Query (L5) — draft là seller-private, loại khỏi MỌI tab ─────────────────

describe("admin listings page — query loại draft (L5 — spec §4.4)", () => {
  it("tab 'Chờ duyệt' → status = pending; tab 'Tất cả' → status ≠ draft", async () => {
    login("moderator");
    dbState.rows = [];

    await call(); // searchParams {} → tab mặc định "pending"
    expect(applyWhere(dbState.lastWhere)).toEqual({ op: "eq", value: "pending" });

    await call("all");
    expect(applyWhere(dbState.lastWhere)).toEqual({ op: "neq", value: "draft" });
  });
});
