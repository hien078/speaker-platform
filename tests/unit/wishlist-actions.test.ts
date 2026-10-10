/**
 * Wishlist gate (b4-holistic-2 — CONFIRMED MEDIUM "Wishlist page shows
 * unreviewed/rejected/removed listing content") — unit tests cho
 * toggleWishlistAction (src/lib/actions/wishlist.ts).
 *
 * Hợp đồng (recorded decision — fail-closed cho visibility):
 *  - THÊM MỚI wishlist item: CHỈ khi listing status === "approved". Đây là
 *    ranh giới công khai duy nhất mà wishlist được ghi nhận — pending/draft/
 *    rejected/hidden/removed/sold KHÔNG bao giờ được thêm (chặn cả action call
 *    trực tiếp — action ID public trong client bundle qua listing detail page).
 *  - BỎ wishlist item HIỆN CÓ: hoạt động với MỌI status — user phải dọn được
 *    entry stale (listing bị takedown/seller ẩn/sau khi edit vào review),
 *    nếu không wishlist của họ kẹt mãi item không đọc được.
 *  - Listing KHÔNG tồn tại → no-op im lặng (giữ nguyên hành vi cũ).
 *
 * Mock recipe như tests/unit/listing-lock.test.ts: session THẬT qua cookie
 * store mock (createSession không dùng — push UserSession row + set cookie),
 * db.client mock in-memory. KHÔNG cần policy rows (wishlist KHÔNG qua
 * publication gate).
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

const cookieState = vi.hoisted(() => ({ store: new Map<string, string>() }));

vi.mock("next/headers", () => ({
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
  headers: vi.fn(async () => new Headers()),
}));

// ─── db.client mock — in-memory (listing-lock pattern, tối giản cho wishlist) ──

const dbState = vi.hoisted(() => ({
  users: [] as Array<Record<string, unknown>>,
  sessions: [] as Array<Record<string, unknown>>,
  listings: [] as Array<Record<string, unknown>>,
  wishlistItems: [] as Array<Record<string, unknown>>,
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
      delete: async () => {
        const hit = rows.find((r) => preds.every((p) => matches(r, p)));
        if (hit === undefined) return null;
        const i = rows.indexOf(hit);
        if (i >= 0) rows.splice(i, 1);
        return { ...hit };
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
      orderBy: () => query([]),
      include: (rel: string) => query([], rel),
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
      // include("user") — session.ts getSessionFromCookie đọc row.user
      row["user"] = dbState.users.find((u) => u["id"] === row["userId"]) ?? null;
    }),
    Listing: makeModel(dbState.listings, () => ({
      id: `listing-${dbState.listings.length + 1}`,
      status: "approved",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
    WishlistItem: makeModel(dbState.wishlistItems, () => ({
      id: `wi-${dbState.wishlistItems.length + 1}`,
      createdAt: new Date().toISOString(),
    })),
  };

  return {
    db: {
      orm: { public: models },
      transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ orm: { public: models } }),
    },
  };
});

import { SESSION_COOKIE } from "@/src/lib/session";
import { toggleWishlistAction } from "@/src/lib/actions/wishlist";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const sha256Hex = (v: string) => createHash("sha256").update(v).digest("hex");
type Row = Record<string, unknown>;

const BUYER: Row = {
  id: "buyer-1",
  email: "buyer@loaviet.test",
  passwordHash: "bcrypt-x",
  name: "Buyer",
  role: "buyer",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

const login = (user: Row): void => {
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
};

const seedListing = (id: string, status: string): Row => {
  const row: Row = { id, sellerId: "seller-other", title: `Loa ${id}`, slug: `loa-${id}`, status };
  dbState.listings.push(row);
  return row;
};

const fd = (listingId: string): FormData => {
  const form = new FormData();
  form.set("listingId", listingId);
  return form;
};

const wishlistOf = (userId: string, listingId: string): Row | undefined =>
  dbState.wishlistItems.find(
    (w) => w["userId"] === userId && w["listingId"] === listingId,
  );

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AUTH_SECRET", "unit-test-auth-secret-0123456789abcdef");
  dbState.users.length = 0;
  dbState.sessions.length = 0;
  dbState.listings.length = 0;
  dbState.wishlistItems.length = 0;
  dbState.users.push({ ...BUYER });
  cookieState.store.clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── 1. THÊM wishlist — chỉ approved (fail-closed visibility) ─────────────────

describe("toggleWishlistAction — THÊM MỚI chỉ khi listing approved (b4-holistic-2 MEDIUM)", () => {
  it("approved → WishlistItem được tạo", async () => {
    login(BUYER);
    seedListing("l-approved", "approved");

    await toggleWishlistAction(fd("l-approved"));

    expect(wishlistOf("buyer-1", "l-approved")).toBeTruthy();
  });

  // Mọi status không công khai — KHÔNG được thêm (chặn cả gọi action trực tiếp
  // trên listing private mà buyer không thấy được trên UI).
  for (const status of ["pending", "draft", "rejected", "hidden", "removed", "sold"]) {
    it(`status ${status} → KHÔNG tạo WishlistItem (fail closed)`, async () => {
      login(BUYER);
      seedListing(`l-${status}`, status);

      await toggleWishlistAction(fd(`l-${status}`));

      expect(dbState.wishlistItems).toHaveLength(0);
    });
  }

  it("listing KHÔNG tồn tại → no-op im lặng (giữ hành vi cũ)", async () => {
    login(BUYER);

    await toggleWishlistAction(fd("l-khong-ton-tai"));

    expect(dbState.wishlistItems).toHaveLength(0);
  });
});

// ─── 2. BỎ wishlist — MỌI status (dọn entry stale) ───────────────────────────

describe("toggleWishlistAction — BỎ item hiện có hoạt động với MỌI status", () => {
  const seedWishlist = (listingId: string): void => {
    dbState.wishlistItems.push({
      id: `wi-${dbState.wishlistItems.length + 1}`,
      userId: "buyer-1",
      listingId,
      createdAt: new Date().toISOString(),
    });
  };

  it("approved → bỏ lưu được (toggle nguyên vẹn)", async () => {
    login(BUYER);
    seedListing("l-approved", "approved");
    seedWishlist("l-approved");

    await toggleWishlistAction(fd("l-approved"));

    expect(wishlistOf("buyer-1", "l-approved")).toBeUndefined();
  });

  // Entry stale (listing bị takedown / seller ẩn / vào review sau edit) PHẢI
  // dọn được — nếu chặn theo status, wishlist user kẹt mãi item không đọc được.
  for (const status of ["pending", "draft", "rejected", "hidden", "removed", "sold"]) {
    it(`status ${status} (item ĐÃ có) → bỏ lưu được — dọn entry stale`, async () => {
      login(BUYER);
      seedListing(`l-${status}`, status);
      seedWishlist(`l-${status}`);

      await toggleWishlistAction(fd(`l-${status}`));

      expect(wishlistOf("buyer-1", `l-${status}`)).toBeUndefined();
    });
  }
});
