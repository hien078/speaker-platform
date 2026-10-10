/**
 * /wishlist redaction (b4-holistic-2 — CONFIRMED MEDIUM "Wishlist page shows
 * unreviewed (pending), rejected and moderation-removed listing title and
 * image to non-sellers") — RENDER harness unit tests cho app/wishlist/page.tsx.
 *
 * Trước fix: WishlistItem query KHÔNG có status filter — ListingCard render
 * title (h3 + alt text) + ảnh đầu của listing pending/rejected/removed mà
 * seller vừa edit thành content chưa duyệt (updateListingAction ghi đè title/
 * ảnh IN PLACE rồi chuyển pending) hoặc bị moderation takedown. Badge
 * "Chờ duyệt"/"Đã gỡ bởi kiểm duyệt" là tín hiệu duy nhất — content vẫn lộ.
 *
 * Sau fix (recorded decision — fail-closed cho visibility):
 *  - Listing KHÔNG công khai (status ∉ {approved, sold}) và KHÔNG phải của
 *    user → KHÔNG được đưa vào ListingCard (không title/ảnh/link slug) —
 *    render card REDACTED host-level: "Tin không còn hiển thị" + nút Bỏ lưu
 *    (dọn entry stale qua toggleWishlistAction).
 *  - approved + sold → ListingCard đầy đủ (sold vẫn công khai — đã qua duyệt
 *    trước khi bán); listing CỦA CHÍNH user → ListingCard (owner thấy tin mình).
 *
 * Render harness như tests/unit/sell-pages.test.ts: ListingCard là server
 * component — KHÔNG gọi (client Link bên trong không render ngoài React) —
 * chỉ so TYPE REFERENCE + props.listing (đúng ranh giới fix: "Do not pass a
 * redacted listing's title or image URL into ListingCard"). Text host-level
 * (placeholder redacted) collect trực tiếp qua textOf.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

// Session seam — page đọc getCurrentUser (fixture trực tiếp như sell-pages).
const authState = vi.hoisted(() => ({
  user: null as Record<string, unknown> | null,
}));

vi.mock("@/src/lib/auth", () => ({
  getCurrentUser: vi.fn(async () => authState.user),
}));

// ─── db.client mock — in-memory (sell-pages pattern; include = pass-through) ──

type Row = Record<string, unknown>;

const dbState = vi.hoisted(() => ({
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
    });
    return {
      first: (filter?: Pred) => query([]).first(filter),
      all: () => query([]).all(),
      where: (pred: Pred) => query([pred]),
      orderBy: () => query([]),
    };
  };

  return {
    db: {
      orm: { public: { WishlistItem: makeModel(dbState.wishlist) } },
      transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ orm: { public: { WishlistItem: makeModel(dbState.wishlist) } } }),
    },
  };
});

import * as wishlistPageModule from "../../app/wishlist/page";
import { ListingCard } from "@/src/components/listing-card";
import { toggleWishlistAction } from "@/src/lib/actions/wishlist";

type PageFn = (props: Record<string, never>) => Promise<unknown>;
const WishlistPage = wishlistPageModule.default as unknown as PageFn;

// ─── React element tree helpers (sell-pages pattern) ───────────────────────────

type ElementLike = { type?: unknown; props?: Record<string, unknown> | null };

/** Toàn bộ text host-level trong tree (component KHÔNG gọi — chỉ text inline). */
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

/** Props của MỌI element có type === component cho trước (ListingCard). */
function elementsOf(node: unknown, type: unknown): Row[] {
  const out: Row[] = [];
  const walk = (n: unknown): void => {
    if (n == null || typeof n === "boolean" || typeof n === "string" || typeof n === "number") return;
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (typeof n === "object" && n !== null) {
      const el = n as ElementLike;
      if (el.type === type && el.props != null) out.push(el.props);
      walk(el.props?.["children"]);
    }
  };
  walk(node);
  return out;
}

/** Props của MỌI <form> có action === action cho trước. */
function formsWithAction(node: unknown, action: unknown): Row[] {
  const out: Row[] = [];
  const walk = (n: unknown): void => {
    if (n == null || typeof n === "boolean" || typeof n === "string" || typeof n === "number") return;
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (typeof n === "object" && n !== null) {
      const el = n as ElementLike;
      if (el.type === "form" && el.props?.["action"] === action) out.push(el.props ?? {});
      walk(el.props?.["children"]);
    }
  };
  walk(node);
  return out;
}

/** Giá trị của mọi <input type="hidden" name="listingId"> trong form props. */
const hiddenListingIds = (formProps: Row): string[] => {
  const out: string[] = [];
  const walk = (n: unknown): void => {
    if (n == null || typeof n === "boolean" || typeof n === "string" || typeof n === "number") return;
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (typeof n === "object" && n !== null) {
      const el = n as ElementLike;
      if (el.type === "input") {
        const p = el.props as Row | null | undefined;
        if (p?.["type"] === "hidden" && p?.["name"] === "listingId") {
          out.push(String(p["value"]));
        }
      }
      walk(el.props?.["children"]);
    }
  };
  walk(formProps["children"]);
  return out;
};

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BUYER: Row = {
  id: "buyer-1",
  email: "buyer@loaviet.test",
  name: "Buyer",
  role: "buyer",
  avatarUrl: null,
  isVerifiedSeller: false,
  adminRole: null,
  sessionId: "sess-1",
};

/** Listing row với relation gắn sẵn (mock include = pass-through). */
const listingRow = (over: Row): Row => ({
  id: "listing-x",
  title: "Loa JBL Charge 5 đã qua sử dụng",
  slug: "jbl-charge-5-da-qua-su-dung",
  price: 1_800_000,
  condition: "good",
  city: "Hà Nội",
  status: "approved",
  viewCount: 3,
  acceptExchange: false,
  negotiable: true,
  sellerId: "seller-1",
  images: [{ url: "/uploads/hinh-anh-cong-khai.webp" }],
  category: { name: "Loa Bluetooth di động" },
  brand: { name: "JBL" },
  ...over,
});

const wishlistItem = (id: string, listing: Row): Row => ({
  id,
  userId: "buyer-1",
  listingId: listing.id as string,
  createdAt: "2026-10-01T00:00:00.000Z",
  listing,
});

/** Id của MỌI listing được đưa vào ListingCard (ranh giới redaction). */
const cardListingIds = (tree: unknown): string[] =>
  elementsOf(tree, ListingCard).map((p) => String((p["listing"] as Row)["id"]));

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AUTH_SECRET", "unit-test-auth-secret-0123456789abcdef");
  dbState.wishlist.length = 0;
  authState.user = { ...BUYER };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── Redaction — content chưa công khai KHÔNG vào ListingCard ─────────────────

describe("/wishlist — redaction listing không công khai (b4-holistic-2 MEDIUM)", () => {
  it("pending (seller vừa edit thành content chưa duyệt) → KHÔNG ListingCard — card redacted + nút Bỏ lưu", async () => {
    const pending = listingRow({
      id: "listing-pending",
      title: "TIÊU ĐỀ LẠ XÂU PENDING CHƯA DUYỆT",
      slug: "tieu-de-la-pending",
      status: "pending",
      images: [{ url: "/uploads/anh-la-pending.webp" }],
    });
    dbState.wishlist.push(wishlistItem("w-pending", pending));

    const tree = await WishlistPage({});

    // KHÔNG đưa title/ảnh/slug của content chưa duyệt vào ListingCard
    expect(cardListingIds(tree)).not.toContain("listing-pending");
    // card redacted host-level: placeholder text cố định (KHÔNG phải title)
    const text = textOf(tree);
    expect(text).toContain("Tin không còn hiển thị");
    expect(text).not.toContain("TIÊU ĐỀ LẠ XÂU PENDING CHƯA DUYỆT");

    // nút BỎ LƯU (dọn entry stale) — form action toggleWishlistAction + listingId
    const forms = formsWithAction(tree, toggleWishlistAction);
    expect(forms).toHaveLength(1);
    expect(hiddenListingIds(forms[0]!)).toEqual(["listing-pending"]);
  });

  it("removed (moderation takedown — content vi phạm giữ nguyên trong row) → KHÔNG ListingCard", async () => {
    const removed = listingRow({
      id: "listing-removed",
      title: "TIÊU ĐỀ BỊ GỠ BỞI KIỂM DUYỆT",
      slug: "tieu-de-bi-go",
      status: "removed",
      images: [{ url: "/uploads/anh-bi-go.webp" }],
    });
    dbState.wishlist.push(wishlistItem("w-removed", removed));

    const tree = await WishlistPage({});

    expect(cardListingIds(tree)).not.toContain("listing-removed");
    expect(textOf(tree)).not.toContain("TIÊU ĐỀ BỊ GỠ BỞI KIỂM DUYỆT");
    expect(textOf(tree)).toContain("Tin không còn hiển thị");
  });

  it("rejected + hidden → cùng redacted (mọi status không công khai)", async () => {
    dbState.wishlist.push(wishlistItem("w-rejected", listingRow({
      id: "listing-rejected",
      title: "TIN BỊ TỪ CHỐI",
      slug: "tin-bi-tu-choi",
      status: "rejected",
    })));
    dbState.wishlist.push(wishlistItem("w-hidden", listingRow({
      id: "listing-hidden",
      title: "TIN BỊ ẨN",
      slug: "tin-bi-an",
      status: "hidden",
    })));

    const tree = await WishlistPage({});

    const ids = cardListingIds(tree);
    expect(ids).not.toContain("listing-rejected");
    expect(ids).not.toContain("listing-hidden");
    expect(textOf(tree)).not.toContain("TIN BỊ TỪ CHỐI");
    expect(textOf(tree)).not.toContain("TIN BỊ ẨN");
  });
});

// ─── KHÔNG over-block — approved/sold/own vẫn vào ListingCard ──────────────────

describe("/wishlist — approved/sold/own listing vẫn render đầy đủ (không over-block)", () => {
  it("approved → ListingCard với listing đầy đủ (title/ảnh/slug đi qua card)", async () => {
    dbState.wishlist.push(wishlistItem("w-approved", listingRow({ id: "listing-approved" })));

    const tree = await WishlistPage({});

    const cards = elementsOf(tree, ListingCard);
    expect(cards).toHaveLength(1);
    expect((cards[0]!["listing"] as Row)["id"]).toBe("listing-approved");
    expect((cards[0]!["listing"] as Row)["title"]).toBe("Loa JBL Charge 5 đã qua sử dụng");
    expect((cards[0]!["listing"] as Row)["images"]).toEqual([
      { url: "/uploads/hinh-anh-cong-khai.webp" },
    ]);
    expect(textOf(tree)).not.toContain("Tin không còn hiển thị");
  });

  it("sold → vẫn hiển thị (đã qua duyệt trước khi bán — KHÔNG redact)", async () => {
    dbState.wishlist.push(wishlistItem("w-sold", listingRow({
      id: "listing-sold",
      status: "sold",
    })));

    const tree = await WishlistPage({});

    expect(cardListingIds(tree)).toContain("listing-sold");
  });

  it("listing CỦA CHÍNH user (draft) → owner thấy đầy đủ (không redact tin của mình)", async () => {
    dbState.wishlist.push(wishlistItem("w-own", listingRow({
      id: "listing-own",
      title: "NHÁP CỦA CHÍNH TÔI",
      slug: "nhap-cua-toi",
      status: "draft",
      sellerId: "buyer-1",
    })));

    const tree = await WishlistPage({});

    expect(cardListingIds(tree)).toContain("listing-own");
  });

  it("trộn approved + pending → approved vào ListingCard, pending redacted, CÙNG grid", async () => {
    dbState.wishlist.push(wishlistItem("w-mix-approved", listingRow({ id: "listing-mix-approved" })));
    dbState.wishlist.push(wishlistItem("w-mix-pending", listingRow({
      id: "listing-mix-pending",
      title: "PENDING LẠ XÂU",
      slug: "pending-la-xau",
      status: "pending",
    })));

    const tree = await WishlistPage({});

    const ids = cardListingIds(tree);
    expect(ids).toContain("listing-mix-approved");
    expect(ids).not.toContain("listing-mix-pending");
    expect(textOf(tree)).not.toContain("PENDING LẠ XÂU");
  });
});

// ─── Empty state ──────────────────────────────────────────────────────────────

describe("/wishlist — empty state", () => {
  it("chưa lưu tin nào → empty state (KHÔNG grid)", async () => {
    const tree = await WishlistPage({});
    expect(textOf(tree)).toContain("Chưa lưu tin nào");
  });

  it("chưa đăng nhập → redirect /login", async () => {
    authState.user = null;
    await expect(WishlistPage({})).rejects.toThrowError(/NEXT_REDIRECT:\/login/);
  });
});
