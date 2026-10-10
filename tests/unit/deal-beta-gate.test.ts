/**
 * Buyer beta access gate trên createDealAction — unit tests (Batch 7 plan
 * Task 6, spec §2.1 + §7.8 "Deal mutation" beta-membership status; C2
 * RESOLVED — actor LÀ buyer per Batch 6 D11; corrections 2026-10-08 item 11).
 *
 * Hợp đồng (plan Task 6 Step 1 — fixtures ở Batch 6 shape: listing approved,
 * seller verified + founding_seller active, hội thoại (listing, buyer) tồn
 * tại; spy Deal.create qua store + emission recorder THẬT ghi row
 * ProductEvent vào mock):
 *
 *  1. buyer KHÔNG active membership → BETA_MEMBERSHIP_REQUIRED, KHÔNG Deal,
 *     KHÔNG deal_created (C2 — §7.8 beta-membership status trên Deal creation).
 *  2. buyer CÓ active membership → deal tạo + emission fires (mọi guard Batch 6
 *     khác thỏa bởi fixture).
 *  3. Guard chạy SAU assertListingSellerInteractable (C2 order pin):
 *     suspended-membership SELLER → SELLER_MEMBERSHIP_INACTIVE (Batch 6 D2
 *     first); suspended-membership BUYER → BETA_MEMBERSHIP_REQUIRED (Batch 7).
 *  4. markDealOutcomeAction KHÔNG bị gate bởi beta policy (Batch 6 D10/D2 —
 *     marking gate theo actor suspension + block-for-success; ongoing deal
 *     participation KHÔNG gate trên membership — blocking a member's
 *     confirmation would strand the bilateral record): member có membership
 *     bị suspended SAU khi deal mở vẫn mark no_deal/cancelled/success được;
 *     source assertion: assertBuyerBetaChatAccess vắng mặt ở markDealOutcomeAction.
 *
 * Cơ chế mock (Global Constraints stubbing recipe): server-only + next/cache
 * + next/navigation (redirect throw) + next/headers + `@/src/lib/auth` fixture
 * + db.client in-memory (Listing/Conversation/Deal/DealStatusHistory/
 * UserSuspension/UserBlock/SellerVerification/BetaCohortMembership/
 * Notification/ProductEvent/User) với transaction + partial unique index
 * THẬT của Deal.create. `@/src/lib/moderation` GIỮ BẢN THẬT bọc spy (Q5
 * delegation pin); `@/src/lib/product-events` GIỮ BẢN THẬT bọc spy (emit core
 * THẬT validate schema + ghi row vào store mock — assert ROW, KHÔNG chỉ spy).
 * PRODUCT_EVENT_PSEUDONYM_KEY stub base64 32-byte.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqlQueryError } from "@prisma/orm-family-sql/errors";

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

// ─── observability spy — silence console + assert notify path ────────────────

vi.mock("@/src/lib/observability", () => ({
  captureError: vi.fn(),
  captureEvent: vi.fn(),
}));

// ─── auth fixture — requireUser/getCurrentUser trả SessionUser (recipe) ──────

type FixtureUser = {
  id: string;
  email: string;
  name: string;
  role: "buyer" | "seller" | "admin";
  avatarUrl: string | null;
  isVerifiedSeller: boolean;
  adminRole: "super_admin" | "operations_admin" | "moderator" | "support" | "analyst" | null;
  sessionId: string;
};

const authState = vi.hoisted(() => ({ user: null as FixtureUser | null }));

vi.mock("@/src/lib/auth", () => ({
  requireUser: vi.fn(async () => {
    if (authState.user === null) {
      const { redirect } = await import("next/navigation");
      redirect("/login");
    }
    return authState.user!;
  }),
  getCurrentUser: vi.fn(async () => authState.user),
}));

// ─── db.client mock — in-memory + transaction + unique index (deal-create pattern) ──

type Row = Record<string, unknown>;

const dbState = vi.hoisted(() => ({
  users: [] as Row[],
  listings: [] as Row[],
  conversations: [] as Row[],
  deals: [] as Row[],
  dealHistory: [] as Row[],
  suspensions: [] as Row[],
  blocks: [] as Row[],
  verifications: [] as Row[],
  memberships: [] as Row[],
  notifications: [] as Row[],
  events: [] as Row[], // ProductEvent rows — emit core THẬT ghi vào đây
}));

vi.mock("@/src/prisma/db.client", () => {
  type Pred = ((proxy: unknown) => unknown) | Row;
  type SortSpec = Array<{ field: string; dir: "asc" | "desc" }>;

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
          asc: () => ({ field, dir: "asc" as const }),
          desc: () => ({ field, dir: "desc" as const }),
        }),
      },
    );

  const matches = (row: Row, pred: Pred): boolean =>
    typeof pred === "function" ? Boolean(pred(fieldOps(row))) : Object.entries(pred).every(([k, v]) => row[k] === v);

  const orderBySpec = (cb: (ops: unknown) => unknown): SortSpec => {
    const spec = cb(fieldOps({} as Row));
    return (Array.isArray(spec) ? spec : [spec]) as SortSpec;
  };

  const sortRows = (rows: Row[], spec: SortSpec): Row[] =>
    [...rows].sort((a, b) => {
      for (const { field, dir } of spec) {
        const av = a[field] as number | string;
        const bv = b[field] as number | string;
        const cmp = av < bv ? -1 : av > bv ? 1 : 0;
        if (cmp !== 0) return dir === "asc" ? cmp : -cmp;
      }
      return 0;
    });

  const NOW = "2026-10-08T00:00:00.000Z";

  const makeModel = (rows: Row[], defaults?: () => Row) => {
    const query = (preds: Pred[], sortSpec: SortSpec | null, limitN: number | null) => ({
      where: (pred: Pred) => query([...preds, pred], sortSpec, limitN),
      include: (_rel: string, _cb?: unknown) => query(preds, sortSpec, limitN),
      orderBy: (cb: (ops: unknown) => unknown) => query(preds, orderBySpec(cb), limitN),
      limit: (n: number) => query(preds, sortSpec, n),
      first: async (filter?: Pred) => {
        const all = [...preds, ...(filter ? [filter] : [])];
        const hit = rows.find((r) => all.every((p) => matches(r, p)));
        return hit === undefined ? null : { ...hit };
      },
      all: async () => {
        let hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        if (sortSpec !== null) hit = sortRows(hit, sortSpec);
        if (limitN !== null) hit = hit.slice(0, limitN);
        return hit.map((r) => ({ ...r }));
      },
      updateAll: async (data: Row) => {
        const hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        for (const r of hit) Object.assign(r, data);
        return hit.map((r) => ({ ...r }));
      },
      create: async (data: Row) => {
        const row = { ...(defaults?.() ?? { id: `row-${rows.length + 1}` }), ...data };
        rows.push(row);
        return { ...row };
      },
    });
    return {
      first: (filter?: Pred) => query([], null, null).first(filter),
      where: (pred: Pred) => query([pred], null, null),
      all: () => query([], null, null).all(),
      create: (data: Row) => query([], null, null).create(data),
      updateAll: (data: Row) => query([], null, null).updateAll(data),
    };
  };

  // Deal — override create: partial unique index deal_one_open_per_listing_buyer
  // (Batch 6 Task 1) — tên index render kèm hash suffix NHƯ Postgres thật.
  const dealBase = makeModel(dbState.deals, () => ({
    id: globalThis.crypto.randomUUID(),
    createdAt: NOW,
    updatedAt: NOW,
  }));
  const dealModel = {
    ...dealBase,
    create: async (data: Row) => {
      if (data.status === "open") {
        const dup = dbState.deals.find(
          (r) => r.listingId === data.listingId && r.buyerId === data.buyerId && r.status === "open",
        );
        if (dup !== undefined) {
          throw new SqlQueryError(
            "mock partial unique index violation (deal_one_open_per_listing_buyer)",
            { sqlState: "23505", constraint: "deal_one_open_per_listing_buyer_77dfd57d" },
          );
        }
      }
      const row = { id: globalThis.crypto.randomUUID(), createdAt: NOW, updatedAt: NOW, ...data };
      dbState.deals.push(row);
      return { ...row };
    },
  };

  const models = {
    User: makeModel(dbState.users),
    Listing: makeModel(dbState.listings, () => ({
      id: `listing-${dbState.listings.length + 1}`,
      createdAt: NOW,
      updatedAt: NOW,
    })),
    Conversation: makeModel(dbState.conversations, () => ({
      id: `convo-${dbState.conversations.length + 1}`,
      createdAt: NOW,
      lastMessageAt: null,
    })),
    Deal: dealModel,
    DealStatusHistory: makeModel(dbState.dealHistory, () => ({
      id: `dsh-${dbState.dealHistory.length + 1}`,
      createdAt: NOW,
    })),
    UserSuspension: makeModel(dbState.suspensions, () => ({
      id: `susp-${dbState.suspensions.length + 1}`,
      status: "active",
      createdAt: NOW,
    })),
    UserBlock: makeModel(dbState.blocks, () => ({
      id: `blk-${dbState.blocks.length + 1}`,
      createdAt: NOW,
    })),
    SellerVerification: makeModel(dbState.verifications, () => ({
      id: `sv-${dbState.verifications.length + 1}`,
      method: "operations_review",
      policyVersion: "v1",
      createdAt: NOW,
      updatedAt: NOW,
    })),
    BetaCohortMembership: makeModel(dbState.memberships, () => ({
      id: `mem-${dbState.memberships.length + 1}`,
      invitedBy: null,
      invitedAt: null,
      acceptedAt: null,
      expiresAt: null,
      notes: null,
      createdAt: NOW,
      updatedAt: NOW,
    })),
    Notification: makeModel(dbState.notifications, () => ({
      id: `notif-${dbState.notifications.length + 1}`,
      readAt: null,
      createdAt: NOW,
    })),
    ProductEvent: makeModel(dbState.events, () => ({
      id: `pe-${dbState.events.length + 1}`,
      occurredAt: NOW,
    })),
  };

  return {
    db: {
      orm: { public: models },
      transaction: async (fn: (tx: { orm: { public: typeof models } }) => Promise<unknown>) =>
        fn({ orm: { public: { ...models } } }),
    },
  };
});

// ─── moderation mock — REAL implementation bọc spy (Q5 delegation pin) ──────

vi.mock("@/src/lib/moderation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/lib/moderation")>();
  return {
    ...actual,
    assertCanStartConversation: vi.fn(actual.assertCanStartConversation),
    isUserSuspended: vi.fn(actual.isUserSuspended),
    getBlockState: vi.fn(actual.getBlockState),
  };
});

// ─── product-events mock — REAL emit core bọc spy (assert ROW, KHÔNG chỉ spy) ──

vi.mock("@/src/lib/product-events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/lib/product-events")>();
  return {
    ...actual,
    emitProductEvent: vi.fn(
      async (input: Parameters<typeof actual.emitProductEvent>[0]): Promise<void> =>
        actual.emitProductEvent(input),
    ),
  };
});

// ─── Imports (sau mock — vitest hoist vi.mock lên trước) ──────────────────────

import { resetRateLimits } from "@/src/lib/rate-limit";
import { emitProductEvent } from "@/src/lib/product-events";
import { createDealAction, markDealOutcomeAction } from "@/src/lib/actions/deals";

const emitSpy = vi.mocked(emitProductEvent);

// ─── Fixtures — Batch 6 shape (approved listing + verified/active seller + convo) ──

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

const BUYER: FixtureUser = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "mua@loaviet.test",
  name: "Người Mua",
  role: "buyer",
  avatarUrl: null,
  isVerifiedSeller: false,
  adminRole: null,
  sessionId: "sess-buyer",
};

const SELLER: FixtureUser = {
  id: "22222222-2222-4222-8222-222222222222",
  email: "ban@loaviet.test",
  name: "Người Bán",
  role: "seller",
  avatarUrl: null,
  isVerifiedSeller: true,
  adminRole: null,
  sessionId: "sess-seller",
};

function seedListing(over: Row = {}): Row {
  const row: Row = {
    id: "listing-1",
    sellerId: SELLER.id,
    status: "approved",
    title: "Loa JBL Charge 5",
    slug: "loa-jbl-charge-5",
    price: 1_800_000,
    provinceLevelCode: "ha-noi",
    ...over,
  };
  dbState.listings.push(row);
  return row;
}

function seedConversation(listingId: string, buyerId: string): Row {
  const listing = dbState.listings.find((r) => r.id === listingId);
  const row: Row = {
    id: `convo-${dbState.conversations.length + 1}`,
    listingId,
    buyerId,
    sellerId: listing?.sellerId ?? SELLER.id,
  };
  dbState.conversations.push(row);
  return row;
}

/** Seller đủ điều kiện §7.8 (D2): verification verified + membership active. */
function seedSellerEligibility(sellerId: string): void {
  dbState.verifications.push({
    id: `sv-${sellerId}`,
    userId: sellerId,
    status: "verified",
    method: "operations_review",
    policyVersion: "v1",
  });
  dbState.memberships.push({
    id: `mem-${sellerId}`,
    userId: sellerId,
    cohort: "founding_seller",
    status: "active",
    expiresAt: null,
  });
}

/** Membership của NGƯỜI MUA (buyer-side gate đọc FRESH mỗi call). */
function seedBuyerMembership(over: Row = {}): void {
  dbState.memberships.push({
    id: `mem-buyer-${dbState.memberships.length + 1}`,
    userId: BUYER.id,
    cohort: "private_beta_buyer",
    status: "active",
    expiresAt: null,
    ...over,
  });
}

/** Deal open đã tồn tại (seed trực tiếp — marking KHÔNG qua createDealAction). */
function seedOpenDeal(over: Row = {}): Row {
  const row: Row = {
    id: `deal-${dbState.deals.length + 1}`,
    listingId: "listing-1",
    conversationId: "convo-1",
    buyerId: BUYER.id,
    sellerId: SELLER.id,
    status: "open",
    agreedPrice: null,
    fulfillmentMethod: null,
    buyerOutcomeAt: null,
    sellerOutcomeAt: null,
    completedAt: null,
    cancellationReason: null,
    ...over,
  };
  dbState.deals.push(row);
  dbState.dealHistory.push({
    id: `dsh-${dbState.dealHistory.length + 1}`,
    dealId: row.id,
    status: "open",
    actorId: BUYER.id,
    note: "buyer:created",
    createdAt: "2026-10-08T00:00:00.000Z",
  });
  return row;
}

function dealForm(over: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("listingId", "listing-1");
  for (const [k, v] of Object.entries(over)) fd.set(k, v);
  return fd;
}

const resetStores = () => {
  for (const store of [
    dbState.users,
    dbState.listings,
    dbState.conversations,
    dbState.deals,
    dbState.dealHistory,
    dbState.suspensions,
    dbState.blocks,
    dbState.verifications,
    dbState.memberships,
    dbState.notifications,
    dbState.events,
  ]) {
    store.length = 0;
  }
};

beforeEach(() => {
  vi.stubEnv("PRODUCT_EVENT_PSEUDONYM_KEY", TEST_KEY);
  vi.stubEnv("NODE_ENV", "test");
  authState.user = BUYER;
  resetStores();
  emitSpy.mockClear();
  resetRateLimits();
  seedListing();
  seedConversation("listing-1", BUYER.id);
  seedSellerEligibility(SELLER.id);
  // BUYER KHÔNG có membership mặc định — mỗi case tự seed (gate là đối tượng test).
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── 1/2 — gate trên createDealAction (C2 — §7.8 Deal mutation) ───────────────

describe("createDealAction — buyer beta access gate (C2)", () => {
  it("buyer KHÔNG active membership → BETA_MEMBERSHIP_REQUIRED, KHÔNG Deal, KHÔNG deal_created", async () => {
    const state = await createDealAction({}, dealForm({ agreedPrice: "500000" }));

    expect(state).toEqual({ error: "BETA_MEMBERSHIP_REQUIRED" });
    expect(dbState.deals).toHaveLength(0);
    expect(dbState.dealHistory).toHaveLength(0);
    expect(dbState.events.filter((e) => e["name"] === "deal_created")).toHaveLength(0);
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("buyer CÓ active membership → deal tạo + deal_created emitted (mọi guard Batch 6 khác thỏa)", async () => {
    seedBuyerMembership();
    const state = await createDealAction({}, dealForm({ agreedPrice: "500000", fulfillmentMethod: "carrier" }));

    expect(state).toEqual({ success: "Đã tạo thỏa thuận." });
    expect(dbState.deals).toHaveLength(1);
    expect(dbState.deals[0]).toMatchObject({
      listingId: "listing-1",
      buyerId: BUYER.id,
      sellerId: SELLER.id,
      status: "open",
      agreedPrice: 500_000,
      fulfillmentMethod: "carrier",
    });
    // ProductEvent row THẬT trong db mock (key stubbed — KHÔNG chỉ spy)
    const dealCreated = dbState.events.filter((e) => e["name"] === "deal_created");
    expect(dealCreated).toHaveLength(1);
    expect(dealCreated[0]!["listingId"]).toBe("listing-1");
  });

  it("buyer membership active nhưng HẾT HẠN → BETA_MEMBERSHIP_REQUIRED (corrections #16)", async () => {
    seedBuyerMembership({ cohort: "private_beta_buyer", expiresAt: "2020-01-01T00:00:00.000Z" });
    const state = await createDealAction({}, dealForm());

    expect(state).toEqual({ error: "BETA_MEMBERSHIP_REQUIRED" });
    expect(dbState.deals).toHaveLength(0);
  });
});

// ─── 3 — guard order: Batch 6 D2 seller-side TRƯỚC Batch 7 buyer-side ─────────

describe("createDealAction — guard order (sau assertListingSellerInteractable)", () => {
  it("suspended-membership SELLER → SELLER_MEMBERSHIP_INACTIVE (Batch 6 D2 first — buyer cũng không có membership)", async () => {
    // Buyer KHÔNG có membership — nếu buyer gate chạy TRƯỚC D2 thì lỗi sẽ là
    // BETA_MEMBERSHIP_REQUIRED; pin đúng thứ tự C2: D2 seller-side TRƯỚC.
    const sellerMembership = dbState.memberships.find((m) => m["userId"] === SELLER.id);
    sellerMembership!["status"] = "suspended";

    const state = await createDealAction({}, dealForm());

    expect(state).toEqual({ error: "SELLER_MEMBERSHIP_INACTIVE" });
    expect(dbState.deals).toHaveLength(0);
  });

  it("suspended-membership BUYER → BETA_MEMBERSHIP_REQUIRED (Batch 7 — seller vẫn eligible)", async () => {
    seedBuyerMembership({ cohort: "private_beta_buyer", status: "suspended" });

    const state = await createDealAction({}, dealForm());

    expect(state).toEqual({ error: "BETA_MEMBERSHIP_REQUIRED" });
    expect(dbState.deals).toHaveLength(0);
  });
});

// ─── 4 — markDealOutcomeAction KHÔNG bị gate (Batch 6 D10/D2) ─────────────────

describe("markDealOutcomeAction — KHÔNG bị gate bởi beta policy (D10/D2)", () => {
  it.each(["no_deal", "cancelled", "success"] as const)(
    "membership suspended SAU khi deal mở → marking %s VẪN chạy (ongoing participation không gate)",
    async (outcome) => {
      // Deal mở lúc buyer còn là member; membership bị suspend sau đó.
      const deal = seedOpenDeal();
      seedBuyerMembership({ cohort: "private_beta_buyer", status: "suspended" });

      const state = await markDealOutcomeAction(
        {},
        (() => {
          const fd = new FormData();
          fd.set("dealId", String(deal.id));
          fd.set("outcome", outcome);
          return fd;
        })(),
      );

      expect(state).toEqual({ success: expect.stringContaining("Đã ghi") });
      const dealRow = dbState.deals.find((r) => r.id === deal.id)!;
      expect(dealRow["buyerOutcomeAt"]).not.toBeNull();
      if (outcome !== "success") {
        expect(dealRow["status"]).toBe(outcome); // unilateral claim chạy
      }
    },
  );

  it("buyer KHÔNG có membership gì cả → marking vẫn chạy (gate chỉ sống ở creation)", async () => {
    const deal = seedOpenDeal();

    const fd = new FormData();
    fd.set("dealId", String(deal.id));
    fd.set("outcome", "no_deal");
    const state = await markDealOutcomeAction({}, fd);

    expect(state).toEqual({ success: expect.stringContaining("Đã ghi") });
  });
});

// ─── Source-contract — markDealOutcomeAction vắng buyer gate ─────────────────

describe("markDealOutcomeAction — source-contract (KHÔNG đụng bởi Batch 7)", () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const read = (p: string) => readFileSync(`${root}/${p}`, "utf8");

  it("assertBuyerBetaChatAccess vắng mặt ở markDealOutcomeAction (D10 — marking gate là actor suspension + block)", () => {
    const src = read("src/lib/actions/deals.ts");
    const markIdx = src.indexOf("export async function markDealOutcomeAction");
    expect(markIdx).toBeGreaterThanOrEqual(0);
    const markSlice = src.slice(markIdx);
    expect(markSlice).not.toContain("assertBuyerBetaChatAccess");
    // createDealAction CÓ guard (C2) — phần trước markDealOutcomeAction chứa nó
    const createSlice = src.slice(0, markIdx);
    expect(createSlice).toContain("assertBuyerBetaChatAccess");
  });
});
