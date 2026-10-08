/**
 * createDealAction — lightweight Deal creation (Batch 6 plan Task 4 —
 * spec §5.2 creation requirements, §7.1 "Deal mutation" rate limit, §7.3
 * cross-account Deal modification, §7.8 seller-side eligibility, §4.8
 * telemetry privacy; corrections 2026-10-08 items 10/11/14/22/25).
 *
 * Hợp đồng (plan Task 4 Step 1):
 *  1. Happy path: buyer có hội thoại (listing, buyer) tạo Deal open với đúng
 *     field §5.2 (agreedPrice/fulfillmentMethod) + MỘT DealStatusHistory
 *     (status "open", actorId buyer, note "buyer:created") + notify seller
 *     (typed title + link hội thoại) + ProductEvent deal_created SAU tx
 *     (corrections #10: assert ROW tồn tại với metadata — KHÔNG chỉ spy;
 *     payload KHÔNG agreedPrice — §4.8; sessionId THÔ → emit core HMAC).
 *  2. §5.2 creation requirements (mọi check ở ACTION — form giả mạo không
 *     giúp gì): listing approved (LISTING_NOT_DEALABLE), không phải tin của
 *     mình (DEAL_OWN_LISTING), listing tồn tại (LISTING_NOT_FOUND), hội
 *     thoại tương ứng tồn tại (DEAL_CONVERSATION_REQUIRED — kể cả khi buyer
 *     có hội thoại trên listing KHÁC), seller không đình chỉ + verification
 *     verified + membership active (D2 — SELLER_*), buyer không đình chỉ +
 *     không bị block (BATCH 3 REUSE — delegation spy assertCanStartConversation
 *     được gọi (buyer, seller) — Q5).
 *  3. Concurrency (Review Focus 3): partial unique index
 *     deal_one_open_per_listing_buyer — double-create (Promise.all) → MỘT
 *     Deal row, thua DEAL_ALREADY_OPEN (SqlQueryError 23505 + constraint
 *     PREFIX kèm hash suffix render — corrections #11: SqlQueryError.is,
 *     KHÔNG instanceof); lỗi KHÔNG phải index đó (23503 / plain Error /
 *     23505 constraint khác) → RETHROW (fail closed — KHÔNG masquerade).
 *  4. D4: deal terminal (completed/cancelled/no_deal) cùng cặp → buyer tạo
 *     deal MỚI được (các row terminal cộng tồn).
 *  5. Input bounds D5 (bound THẬT của repo — drift-pinned ở deal-domain):
 *     agreedPrice rỗng → null; "500000" → 500000; "abc"/"-1"/"50000"/
 *     vượt max → DEAL_PRICE_INVALID, không row. fulfillmentMethod ∈
 *     DEAL_FULFILLMENT_METHODS; sai → DEAL_FULFILLMENT_INVALID; bỏ trống → null.
 *  6. §7.1: lần thứ 21 deal mutation trong giờ → RATE_LIMITED, không row.
 *  7. Chưa đăng nhập → auth mock throw NEXT_REDIRECT:/login, ZERO db call.
 *  8. Guard-rejected → KHÔNG emit, KHÔNG notify, KHÔNG revalidatePath.
 *  9. Notify payload KHÔNG giá, KHÔNG thông tin liên hệ (Q6 — typed title +
 *     listing title slice(0,60) + link); notify lỗi db → action VẪN thành
 *     công (deal đã commit) + captureError("deal", "DEAL_NOTIFY_FAILED",
 *     { sqlState }) MÃ CHUỖI (corrections #22 — KHÔNG error object).
 * 10. D11/S11: deal row ghi conversationId = id hội thoại (listing, buyer).
 * 11. corrections #14: revalidatePath(`/chat/<convoId>`) SAU commit (để
 *     DealPanel server-rendered thấy deal mới); error path KHÔNG revalidate.
 *
 * Cơ chế mock (Global Constraints stubbing recipe): server-only + next/cache
 * + next/navigation (redirect throw) + next/headers + `@/src/lib/auth` fixture
 * + db.client in-memory (Listing/Conversation/Deal/DealStatusHistory/
 * UserSuspension/UserBlock/SellerVerification/BetaCohortMembership/
 * Notification/ProductEvent/User) với transaction + partial unique index
 * THẬT của Deal.create. `@/src/lib/moderation` (Batch 3 guards) GIỮ BẢN THẬT
 * bọc spy — hành vi thật đọc store mock, call observable (delegation pin).
 * `@/src/lib/product-events` GIỮ BẢN THẬT bọc spy: emit core THẬT validate
 * schema (mở rộng cùng commit) + ghi row vào store mock (corrections #10),
 * spy chụp trạng thái tx lúc gọi (pin emission SAU tx — S1).
 * PRODUCT_EVENT_PSEUDONYM_KEY stub base64 32-byte (product-events.test.ts).
 */
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

// ─── observability spy — silence console + assert DEAL_NOTIFY_FAILED (#22) ───

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

// ─── db.client mock — in-memory 11 model + transaction + unique index ─────────

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
  calls: [] as string[], // mọi terminal op — pin "zero db calls"
  fail: {} as { dealCreate?: unknown; notificationCreate?: unknown },
  // S1 pin: trạng thái LÚC emitProductEvent được gọi (chụp trong spy wrapper)
  txCommittedAtEmit: null as boolean | null,
  txCommitted: false,
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
        }),
      },
    );

  const matches = (row: Row, pred: Pred): boolean =>
    typeof pred === "function" ? Boolean(pred(fieldOps(row))) : Object.entries(pred).every(([k, v]) => row[k] === v);

  const orderBySpec = (cb: (ops: unknown) => unknown): SortSpec => {
    const spec: SortSpec = [];
    cb(
      new Proxy(
        {},
        {
          get: (_t, field: string) => ({
            asc: () => spec.push({ field, dir: "asc" as const }),
            desc: () => spec.push({ field, dir: "desc" as const }),
          }),
        },
      ),
    );
    return spec;
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
    const query = (
      preds: Pred[],
      sortSpec: SortSpec | null,
      limitN: number | null,
    ) => ({
      where: (pred: Pred) => query([...preds, pred], sortSpec, limitN),
      include: (_rel: string, _cb?: unknown) => query(preds, sortSpec, limitN),
      orderBy: (cb: (ops: unknown) => unknown) => query(preds, orderBySpec(cb), limitN),
      limit: (n: number) => query(preds, sortSpec, n),
      first: async (filter?: Pred) => {
        dbState.calls.push("first");
        const all = [...preds, ...(filter ? [filter] : [])];
        const hit = rows.find((r) => all.every((p) => matches(r, p)));
        if (hit === undefined) return null;
        return { ...hit };
      },
      all: async () => {
        dbState.calls.push("all");
        let hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        if (sortSpec !== null) hit = sortRows(hit, sortSpec);
        if (limitN !== null) hit = hit.slice(0, limitN);
        return hit.map((r) => ({ ...r }));
      },
      updateAll: async (data: Row) => {
        dbState.calls.push("updateAll");
        const hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        for (const r of hit) Object.assign(r, data);
        return hit.map((r) => ({ ...r }));
      },
      create: async (data: Row) => {
        dbState.calls.push("create");
        const row = { ...(defaults?.() ?? { id: `row-${rows.length + 1}` }), ...data };
        rows.push(row);
        return { ...row };
      },
      delete: async () => {
        dbState.calls.push("delete");
        const hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        for (const r of hit) {
          const i = rows.indexOf(r);
          if (i >= 0) rows.splice(i, 1);
        }
        return hit.map((r) => ({ ...r }));
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
  // (Task 1): MỘT deal OPEN duy nhất per (listingId, buyerId). Tên index render
  // kèm hash suffix NHƯ Postgres thật (ops.json batch 6: ..._77dfd57d) — action
  // phải khớp PREFIX, KHÔNG exact (corrections #11).
  const dealBase = makeModel(dbState.deals, () => ({
    id: globalThis.crypto.randomUUID(),
    createdAt: NOW,
    updatedAt: NOW,
  }));
  const dealModel = {
    ...dealBase,
    create: async (data: Row) => {
      dbState.calls.push("Deal.create");
      if (dbState.fail.dealCreate !== undefined) throw dbState.fail.dealCreate;
      if (data.status === "open") {
        const dup = dbState.deals.find(
          (r) =>
            r.listingId === data.listingId &&
            r.buyerId === data.buyerId &&
            r.status === "open",
        );
        if (dup !== undefined) {
          throw new SqlQueryError(
            "mock partial unique index violation (deal_one_open_per_listing_buyer)",
            { sqlState: "23505", constraint: "deal_one_open_per_listing_buyer_77dfd57d" },
          );
        }
      }
      const row = {
        id: globalThis.crypto.randomUUID(),
        createdAt: NOW,
        updatedAt: NOW,
        ...data,
      };
      dbState.deals.push(row);
      return { ...row };
    },
  };

  // Notification — hook lỗi db cho case corrections #22 (notify throw).
  const notificationBase = makeModel(dbState.notifications, () => ({
    id: `notif-${dbState.notifications.length + 1}`,
    readAt: null,
    createdAt: NOW,
  }));
  const notificationModel = {
    ...notificationBase,
    create: async (data: Row) => {
      dbState.calls.push("Notification.create");
      if (dbState.fail.notificationCreate !== undefined) throw dbState.fail.notificationCreate;
      const row = {
        id: `notif-${dbState.notifications.length + 1}`,
        readAt: null,
        createdAt: NOW,
        ...data,
      };
      dbState.notifications.push(row);
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
    Notification: notificationModel,
    ProductEvent: makeModel(dbState.events, () => ({
      id: `pe-${dbState.events.length + 1}`,
      occurredAt: NOW,
    })),
  };

  return {
    db: {
      orm: { public: models },
      // tx mock: callback nhận tx.orm cùng models (store dùng chung); "commit"
      // = sau fn resolve — flag cho S1 pin (emission phải SAU điểm này).
      transaction: async (fn: (tx: { orm: { public: typeof models } }) => Promise<unknown>) => {
        const result = await fn({ orm: { public: { ...models } } });
        dbState.txCommitted = true;
        return result;
      },
    },
  };
});

// ─── moderation mock — REAL implementation bọc spy (Q5 delegation pin) ───────
// importOriginal: hành vi thật (isUserSuspended/getBlockState/assertCanStart
// -Conversation đọc cùng db mock ở trên) — spy để assert createDealAction
// DELEGATE actor suspension/block cho Batch 3 thay vì tự viết lại.

vi.mock("@/src/lib/moderation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/lib/moderation")>();
  return {
    ...actual,
    assertCanStartConversation: vi.fn(actual.assertCanStartConversation),
    isUserSuspended: vi.fn(actual.isUserSuspended),
    getBlockState: vi.fn(actual.getBlockState),
  };
});

// ─── product-events mock — REAL emit core bọc spy (corrections #10 + S1) ──────
// emitProductEvent THẬT chạy (validate schema mở rộng cùng commit + ghi row
// vào dbState.events — assert ROW, KHÔNG chỉ spy); spy chụp txCommitted LÚC
// gọi để pin emission SAU tx (S1 — KHÔNG bao giờ trong callback).

vi.mock("@/src/lib/product-events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/lib/product-events")>();
  return {
    ...actual,
    emitProductEvent: vi.fn(
      async (input: Parameters<typeof actual.emitProductEvent>[0]): Promise<void> => {
        dbState.txCommittedAtEmit = dbState.txCommitted;
        return actual.emitProductEvent(input);
      },
    ),
  };
});

// ─── Imports (sau mock — vitest hoist vi.mock lên trước) ──────────────────────

import { resetRateLimits } from "@/src/lib/rate-limit";
import { assertCanStartConversation } from "@/src/lib/moderation";
import { emitProductEvent } from "@/src/lib/product-events";
import { captureError } from "@/src/lib/observability";
import { revalidatePath } from "next/cache";
import { createDealAction } from "@/src/lib/actions/deals";

const emitSpy = vi.mocked(emitProductEvent);
const captureErrorMock = vi.mocked(captureError);
const revalidatePathMock = vi.mocked(revalidatePath);
const assertCanStartSpy = vi.mocked(assertCanStartConversation);

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** Key test hợp lệ — base64 của đúng 32 byte (product-events.test.ts pattern). */
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

/** Listing title > 60 ký tự — exercise slice(0, 60) của notify body. */
const LONG_TITLE =
  "Loa JBL Charge 5 chính hãng bảo hành 12 tháng đầy đủ phụ kiện nguyên seal hộp đẹp như mới";

function seedListing(over: Row = {}): Row {
  const row: Row = {
    id: "listing-1",
    sellerId: SELLER.id,
    status: "approved",
    title: LONG_TITLE,
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
    dbState.calls,
  ]) {
    store.length = 0;
  }
  dbState.fail = {};
  dbState.txCommitted = false;
  dbState.txCommittedAtEmit = null;
};

beforeEach(() => {
  vi.stubEnv("PRODUCT_EVENT_PSEUDONYM_KEY", TEST_KEY);
  vi.stubEnv("NODE_ENV", "test");
  authState.user = BUYER;
  resetStores();
  emitSpy.mockClear();
  captureErrorMock.mockClear();
  revalidatePathMock.mockClear();
  assertCanStartSpy.mockClear();
  resetRateLimits();
  seedListing();
  seedConversation("listing-1", BUYER.id);
  seedSellerEligibility(SELLER.id);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── 1. Happy path — §5.2 đầy đủ + notify + emission SAU tx ──────────────────

describe("createDealAction — happy path (§5.2)", () => {
  it("tạo Deal open + DealStatusHistory 'buyer:created' + notify seller + deal_created SAU tx", async () => {
    const state = await createDealAction({}, dealForm({ agreedPrice: "500000", fulfillmentMethod: "carrier" }));

    expect(state).toEqual({ success: "Đã tạo thỏa thuận." });

    // Deal row — đúng field §5.2 (D11: buyer-only, conversationId = id convo)
    expect(dbState.deals).toHaveLength(1);
    const deal = dbState.deals[0]!;
    expect(deal).toMatchObject({
      listingId: "listing-1",
      conversationId: "convo-1",
      buyerId: BUYER.id,
      sellerId: SELLER.id,
      status: "open",
      agreedPrice: 500_000,
      fulfillmentMethod: "carrier",
    });

    // DealStatusHistory — MỘT row append (status "open", actor buyer, typed note)
    expect(dbState.dealHistory).toHaveLength(1);
    expect(dbState.dealHistory[0]).toMatchObject({
      dealId: deal.id,
      status: "open",
      actorId: BUYER.id,
      note: "buyer:created",
    });

    // Emission SAU tx (S1 — chụp trạng thái trong spy wrapper)
    expect(dbState.txCommittedAtEmit).toBe(true);
    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "deal_created",
        actorId: BUYER.id,
        sessionId: BUYER.sessionId, // sessionId THÔ — emit core tự HMAC (corrections #25)
        conversationId: "convo-1",
        listingId: "listing-1",
        provinceCode: "ha-noi",
      }),
    );

    // corrections #10 — assert ROW ProductEvent tồn tại với metadata TYPED
    // (spy test đơn thuốn sẽ pass khi emit thật bị reject — row là bằng chứng)
    expect(dbState.events).toHaveLength(1);
    const evt = dbState.events[0]!;
    expect(evt.name).toBe("deal_created");
    expect(evt.conversationId).toBe("convo-1");
    expect(evt.listingId).toBe("listing-1");
    expect(evt.provinceCode).toBe("ha-noi");
    expect(evt.metadata).toEqual({ dealId: deal.id, fulfillmentMethod: "carrier" });
    // §4.8 — KHÔNG agreedPrice trong event; pseudonym KHÔNG phải id thô (S-10)
    expect(evt.metadata).not.toHaveProperty("agreedPrice");
    expect(evt.actorPseudonym).not.toBe(BUYER.id);
    expect(evt.sessionPseudonym).not.toBe(BUYER.sessionId);

    // Notify seller — PII-free (Q6): typed title + listing title slice + link
    expect(dbState.notifications).toHaveLength(1);
    expect(dbState.notifications[0]).toMatchObject({
      userId: SELLER.id,
      kind: "deal",
      title: "Thỏa thuận mới",
      body: LONG_TITLE.slice(0, 60),
      link: "/chat/convo-1",
    });

    // corrections #14 — revalidatePath trang hội thoại SAU commit
    expect(revalidatePathMock).toHaveBeenCalledTimes(1);
    expect(revalidatePathMock).toHaveBeenCalledWith("/chat/convo-1");
  });

  it("agreedPrice bỏ trống → null; fulfillmentMethod bỏ trống → null (deal không tiền vẫn tạo)", async () => {
    const state = await createDealAction({}, dealForm());

    expect(state).toEqual({ success: "Đã tạo thỏa thuận." });
    expect(dbState.deals).toHaveLength(1);
    expect(dbState.deals[0]!.agreedPrice).toBeNull();
    expect(dbState.deals[0]!.fulfillmentMethod).toBeNull();
    // metadata fulfillmentMethod null — schema .nullish() chấp nhận
    expect(dbState.events[0]!.metadata).toEqual({ dealId: dbState.deals[0]!.id, fulfillmentMethod: null });
  });
});

// ─── 2. §5.2 creation requirements — mọi check ở action ───────────────────────

describe("createDealAction — §5.2 creation requirements", () => {
  it("listing không tồn tại → LISTING_NOT_FOUND, không Deal", async () => {
    const state = await createDealAction({}, dealForm({ listingId: "listing-khong-ton-tai" }));

    expect(state).toEqual({ error: "LISTING_NOT_FOUND" });
    expect(dbState.deals).toHaveLength(0);
  });

  it("tự thỏa thuận với chính mình → DEAL_OWN_LISTING, không Deal", async () => {
    dbState.listings[0]!.sellerId = BUYER.id;

    const state = await createDealAction({}, dealForm());

    expect(state).toEqual({ error: "DEAL_OWN_LISTING" });
    expect(dbState.deals).toHaveLength(0);
  });

  it.each(["draft", "pending", "rejected", "hidden", "sold", "removed", "archived"] as const)(
    "listing %s → LISTING_NOT_DEALABLE, không Deal (§5.2 'live eligible listing')",
    async (status) => {
      dbState.listings[0]!.status = status;

      const state = await createDealAction({}, dealForm());

      expect(state).toEqual({ error: "LISTING_NOT_DEALABLE" });
      expect(dbState.deals).toHaveLength(0);
    },
  );

  it("chưa có hội thoại (listing, buyer) → DEAL_CONVERSATION_REQUIRED, không Deal", async () => {
    dbState.conversations.length = 0;

    const state = await createDealAction({}, dealForm());

    expect(state).toEqual({ error: "DEAL_CONVERSATION_REQUIRED" });
    expect(dbState.deals).toHaveLength(0);
  });

  it("buyer có hội thoại trên listing KHÁC → vẫn DEAL_CONVERSATION_REQUIRED (không mượn quan hệ)", async () => {
    dbState.conversations.length = 0; // listing-1 KHÔNG còn hội thoại nào của buyer
    seedListing({ id: "listing-2", slug: "loa-khac" });
    seedConversation("listing-2", BUYER.id);

    const state = await createDealAction({}, dealForm()); // listing-1 không có convo

    expect(state).toEqual({ error: "DEAL_CONVERSATION_REQUIRED" });
    expect(dbState.deals).toHaveLength(0);
  });

  it("seller bị đình chỉ → SELLER_SUSPENDED (D2 — §7.8 seller-side)", async () => {
    dbState.suspensions.push({ id: "susp-1", userId: SELLER.id, status: "active" });

    const state = await createDealAction({}, dealForm());

    expect(state).toEqual({ error: "SELLER_SUSPENDED" });
    expect(dbState.deals).toHaveLength(0);
  });

  it.each(["revoked", "rejected", "needs_review", "pending", "not_started"] as const)(
    "verification %s → SELLER_NOT_VERIFIED (D2 — §7.8 revocation)",
    async (status) => {
      dbState.verifications[0]!.status = status;

      const state = await createDealAction({}, dealForm());

      expect(state).toEqual({ error: "SELLER_NOT_VERIFIED" });
      expect(dbState.deals).toHaveLength(0);
    },
  );

  it("thiếu row verification → SELLER_NOT_VERIFIED (fail closed)", async () => {
    dbState.verifications.length = 0;

    const state = await createDealAction({}, dealForm());

    expect(state).toEqual({ error: "SELLER_NOT_VERIFIED" });
  });

  it.each(["suspended", "exited", "invited"] as const)(
    "membership founding_seller %s → SELLER_MEMBERSHIP_INACTIVE (D2)",
    async (status) => {
      dbState.memberships[0]!.status = status;

      const state = await createDealAction({}, dealForm());

      expect(state).toEqual({ error: "SELLER_MEMBERSHIP_INACTIVE" });
      expect(dbState.deals).toHaveLength(0);
    },
  );

  it("membership hết hạn → SELLER_MEMBERSHIP_INACTIVE (corrections #6)", async () => {
    dbState.memberships[0]!.expiresAt = "2026-01-01T00:00:00.000Z";

    const state = await createDealAction({}, dealForm());

    expect(state).toEqual({ error: "SELLER_MEMBERSHIP_INACTIVE" });
  });

  it("buyer bị đình chỉ → ACCOUNT_SUSPENDED; block HAI hướng → CHAT_BLOCKED — BATCH 3 delegation spy (Q5)", async () => {
    // Buyer đình chỉ
    dbState.suspensions.push({ id: "susp-1", userId: BUYER.id, status: "active" });
    await expect(createDealAction({}, dealForm())).resolves.toEqual({ error: "ACCOUNT_SUSPENDED" });
    expect(dbState.deals).toHaveLength(0);

    // Block hướng buyer → seller
    dbState.suspensions.length = 0;
    dbState.blocks.push({ id: "blk-1", blockerId: BUYER.id, blockedId: SELLER.id });
    await expect(createDealAction({}, dealForm())).resolves.toEqual({ error: "CHAT_BLOCKED" });
    expect(dbState.deals).toHaveLength(0);

    // Block hướng seller → buyer (enforcement đối xứng §5.5)
    dbState.blocks.length = 0;
    dbState.blocks.push({ id: "blk-2", blockerId: SELLER.id, blockedId: BUYER.id });
    await expect(createDealAction({}, dealForm())).resolves.toEqual({ error: "CHAT_BLOCKED" });
    expect(dbState.deals).toHaveLength(0);

    // Q5 reuse pin — action DELEGATE Batch 3 guard với đúng tham số, KHÔNG tự viết lại
    expect(assertCanStartSpy).toHaveBeenCalledWith(BUYER.id, SELLER.id);
  });
});

// ─── 3. Concurrency — partial unique index (Review Focus 3) ───────────────────

describe("createDealAction — concurrency + classification (S2, corrections #11)", () => {
  it("đã có deal OPEN cùng (listing, buyer) → DEAL_ALREADY_OPEN (pre-check), không row thứ hai", async () => {
    await createDealAction({}, dealForm());
    expect(dbState.deals).toHaveLength(1);

    const second = await createDealAction({}, dealForm());

    expect(second).toEqual({ error: "DEAL_ALREADY_OPEN" });
    expect(dbState.deals).toHaveLength(1); // vẫn MỘT
  });

  it("concurrent double-create (Promise.all) → MỘT Deal row, thua DEAL_ALREADY_OPEN (index thắng race)", async () => {
    const [a, b] = await Promise.all([
      createDealAction({}, dealForm()),
      createDealAction({}, dealForm()),
    ]);

    // Đúng MỘT row được persist — thua cuộc nhận DEAL_ALREADY_OPEN (qua
    // pre-check hay qua unique index tuỳ scheduling — cùng kết quả quan sát;
    // assert order-independent: comparator sort 1 chiều dễ sai thứ tự V8).
    expect(dbState.deals).toHaveLength(1);
    expect([a, b]).toContainEqual({ error: "DEAL_ALREADY_OPEN" });
    expect([a, b]).toContainEqual({ success: "Đã tạo thỏa thuận." });
    // History row chỉ của người thắng
    expect(dbState.dealHistory).toHaveLength(1);
  });

  it("lỗi KHÔNG phải unique index (23503 FK) → RETHROW (fail closed — KHÔNG masquerade)", async () => {
    dbState.fail.dealCreate = new SqlQueryError("mock fk violation", { sqlState: "23503" });

    await expect(createDealAction({}, dealForm())).rejects.toThrowError(/fk violation/);
    expect(dbState.deals).toHaveLength(0);
    expect(dbState.dealHistory).toHaveLength(0);
  });

  it("lỗi db thường (plain Error) → RETHROW", async () => {
    dbState.fail.dealCreate = new Error("connection reset");

    await expect(createDealAction({}, dealForm())).rejects.toThrowError(/connection reset/);
    expect(dbState.deals).toHaveLength(0);
  });

  it("23505 với constraint KHÁC → RETHROW (KHÔNG map mù mọi 23505)", async () => {
    dbState.fail.dealCreate = new SqlQueryError("mock other unique violation", {
      sqlState: "23505",
      constraint: "Deal_pkey",
    });

    await expect(createDealAction({}, dealForm())).rejects.toThrowError(/other unique violation/);
    expect(dbState.deals).toHaveLength(0);
  });
});

// ─── 4. D4 — deal terminal cùng cặp → tạo deal MỚI được ────────────────────────

describe("createDealAction — D4 (một deal OPEN per cặp, terminal cộng tồn)", () => {
  it.each(["completed", "cancelled", "no_deal"] as const)(
    "deal %s → buyer tạo deal MỚI cùng (listing, buyer) được",
    async (terminal) => {
      await createDealAction({}, dealForm());
      dbState.deals[0]!.status = terminal; // deal cũ kết thúc

      const state = await createDealAction({}, dealForm());

      expect(state).toEqual({ success: "Đã tạo thỏa thuận." });
      expect(dbState.deals).toHaveLength(2); // terminal + open cộng tồn (D4)
      expect(dbState.deals.filter((d) => d.status === "open")).toHaveLength(1);
    },
  );
});

// ─── 5. Input bounds — D5 giá + fulfillment vocabulary ────────────────────────

describe("createDealAction — input validation (D5/D7)", () => {
  it.each(["abc", "-1", "50000", "2000000001", "12.5"])(
    "agreedPrice '%s' → DEAL_PRICE_INVALID, không row (bound THẬT 100_000..2_000_000_000)",
    async (raw) => {
      const state = await createDealAction({}, dealForm({ agreedPrice: raw }));

      expect(state).toEqual({ error: "DEAL_PRICE_INVALID" });
      expect(dbState.deals).toHaveLength(0);
    },
  );

  it("agreedPrice '500000' → 500000 (giá trong bound được ghi)", async () => {
    await createDealAction({}, dealForm({ agreedPrice: "500000" }));

    expect(dbState.deals[0]!.agreedPrice).toBe(500_000);
  });

  it("agreedPrice đúng min/max biên → được ghi", async () => {
    await createDealAction({}, dealForm({ agreedPrice: "100000" }));
    expect(dbState.deals[0]!.agreedPrice).toBe(100_000);

    dbState.deals.length = 0;
    dbState.dealHistory.length = 0;
    dbState.events.length = 0;
    dbState.notifications.length = 0;
    emitSpy.mockClear();
    revalidatePathMock.mockClear();

    await createDealAction({}, dealForm({ agreedPrice: "2000000000" }));
    expect(dbState.deals[0]!.agreedPrice).toBe(2_000_000_000);
  });

  it("fulfillmentMethod hợp lệ → lưu đúng giá trị", async () => {
    await createDealAction({}, dealForm({ fulfillmentMethod: "meetup" }));

    expect(dbState.deals[0]!.fulfillmentMethod).toBe("meetup");
    expect(dbState.events[0]!.metadata).toEqual({
      dealId: dbState.deals[0]!.id,
      fulfillmentMethod: "meetup",
    });
  });

  it("fulfillmentMethod sai → DEAL_FULFILLMENT_INVALID, không row", async () => {
    const state = await createDealAction({}, dealForm({ fulfillmentMethod: "teleport" }));

    expect(state).toEqual({ error: "DEAL_FULFILLMENT_INVALID" });
    expect(dbState.deals).toHaveLength(0);
  });
});

// ─── 6. §7.1 rate limit ───────────────────────────────────────────────────────

describe("createDealAction — rate limit (§7.1 'Deal mutation')", () => {
  it("lần thứ 21 trong giờ → RATE_LIMITED, không row", async () => {
    // 20 lần đầu tiêu budget bucket deal:mutation:<userId> (kết quả action bất kỳ
    // — rate limit là bước ĐẦU, chạy trước mọi guard/read).
    for (let i = 0; i < 20; i++) {
      await createDealAction({}, dealForm());
    }
    const dealsAfter20 = dbState.deals.length;

    const state = await createDealAction({}, dealForm());

    expect(state).toEqual({ error: "RATE_LIMITED" });
    expect(dbState.deals).toHaveLength(dealsAfter20); // KHÔNG row mới
  });
});

// ─── 7. Chưa đăng nhập ─────────────────────────────────────────────────────────

describe("createDealAction — chưa đăng nhập", () => {
  it("auth mock throw NEXT_REDIRECT:/login, ZERO db call", async () => {
    authState.user = null;

    await expect(createDealAction({}, dealForm())).rejects.toThrowError(/NEXT_REDIRECT:\/login/);

    expect(dbState.calls).toHaveLength(0); // KHÔNG read/write nào trước auth
    expect(dbState.deals).toHaveLength(0);
  });
});

// ─── 8. Guard-rejected → KHÔNG side-effect (emission/notify/revalidate) ───────

describe("createDealAction — guard-rejected không side-effect", () => {
  it("block hai hướng → CHAT_BLOCKED, KHÔNG emit + KHÔNG notify + KHÔNG revalidatePath", async () => {
    dbState.blocks.push({ id: "blk-1", blockerId: BUYER.id, blockedId: SELLER.id });

    const state = await createDealAction({}, dealForm());

    expect(state).toEqual({ error: "CHAT_BLOCKED" });
    expect(emitSpy).not.toHaveBeenCalled();
    expect(dbState.events).toHaveLength(0);
    expect(dbState.notifications).toHaveLength(0);
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("seller không eligible → KHÔNG emit, KHÔNG notify", async () => {
    dbState.verifications.length = 0; // SELLER_NOT_VERIFIED

    await createDealAction({}, dealForm());

    expect(emitSpy).not.toHaveBeenCalled();
    expect(dbState.events).toHaveLength(0);
    expect(dbState.notifications).toHaveLength(0);
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("rate-limited → KHÔNG emit", async () => {
    for (let i = 0; i < 20; i++) {
      await createDealAction({}, dealForm());
    }
    emitSpy.mockClear();

    await createDealAction({}, dealForm());

    expect(emitSpy).not.toHaveBeenCalled();
  });
});

// ─── 9. Notify — PII-free + best-effort (Q6 + corrections #22) ─────────────────

describe("createDealAction — notify (Q6/§4.8 + corrections #22)", () => {
  it("payload KHÔNG giá, KHÔNG thông tin liên hệ — typed title + title slice + link", async () => {
    await createDealAction({}, dealForm({ agreedPrice: "123456" }));

    const n = dbState.notifications[0]!;
    expect(n.userId).toBe(SELLER.id);
    expect(n.kind).toBe("deal");
    expect(n.title).toBe("Thỏa thuận mới");
    expect(n.body).toBe(LONG_TITLE.slice(0, 60)); // 60 ký tự đầu — KHÔNG hơn
    expect(n.link).toBe("/chat/convo-1");
    // Giá thỏa thuận KHÔNG vào notification (Q6)
    expect(String(n.body)).not.toContain("123456");
    expect(String(n.title)).not.toContain("123456");
  });

  it("notify lỗi db → action VẪN thành công (deal đã commit) + captureError MÃ CHUỖI DEAL_NOTIFY_FAILED", async () => {
    dbState.fail.notificationCreate = new SqlQueryError("mock notification insert failed", {
      sqlState: "53300",
    });

    const state = await createDealAction({}, dealForm());

    // Deal + history + emission VẪN đầy đủ — notify KHÔNG sống chết với flow
    expect(state).toEqual({ success: "Đã tạo thỏa thuận." });
    expect(dbState.deals).toHaveLength(1);
    expect(dbState.dealHistory).toHaveLength(1);
    expect(dbState.events).toHaveLength(1);

    // corrections #22 — captureError(scope, MÃ CHUỖI, { sqlState }): KHÔNG error
    // object (observability-core ghi error.message + stack — correction #17)
    expect(captureErrorMock).toHaveBeenCalledWith("deal", "DEAL_NOTIFY_FAILED", {
      sqlState: "53300",
    });
  });
});

// ─── 10. D11/S11 — conversationId ghi từ hội thoại (listing, buyer) ───────────

describe("createDealAction — D11/S11 (buyer-only, conversationId)", () => {
  it("deal row ghi conversationId = id hội thoại (listing, buyer) — khóa panel/notify/emission", async () => {
    await createDealAction({}, dealForm());

    const deal = dbState.deals[0]!;
    const convo = dbState.conversations.find((c) => c.listingId === "listing-1" && c.buyerId === BUYER.id);
    expect(deal.conversationId).toBe(convo!.id);
    // Emission + notify cùng khóa conversationId (S11 — sống qua listing deletion)
    expect(dbState.events[0]!.conversationId).toBe(convo!.id);
    expect(dbState.notifications[0]!.link).toBe(`/chat/${convo!.id}`);
  });
});
