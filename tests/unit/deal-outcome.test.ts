/**
 * markDealOutcomeAction — bilateral confirmation, atomic claims, successful-
 * match analytics (Batch 6 plan Task 5 — spec §5.2 Deal outcome, §5.5 block
 * semantics D10, §4.8 telemetry privacy, §7.1 "Deal mutation" rate limit,
 * §7.3 cross-account Deal modification, §7.8 actor-side guards; corrections
 * 2026-10-08 items 10/12/13/14/22/23/25/26/30).
 *
 * Hợp đồng (plan Task 5 Step 1):
 *  1. BILATERAL (D3/§5.2): mỗi bên đánh dấu MỘT LẦN theo vai của chính mình —
 *     buyer success → buyerOutcomeAt set, deal VẪN open (chưa song phương);
 *     seller success kế tiếp → claim open→completed (ATOMIC) + completedAt +
 *     successful_match ĐÚNG MỘT LẦN. KHÔNG markSold → listing VẪN approved
 *     (D6/S7 — bilateral completion một mình KHÔNG BAO GIỜ bán listing).
 *  2. MARK SOLD (D6/FD-3): CHỈ seller + outcome success + markSold "on" →
 *     claim Listing approved→sold trong CÙNG tx + listing_marked_sold;
 *     buyer submit markSold → bị bỏ qua; listing đã rời approved → claim 0
 *     row → KHÔNG event, marking + completion không ảnh hưởng.
 *  3. IDEMPOTENCY (gate item): re-submit CÙNG giá trị → no-op thành công
 *     (không history row mới, không event, không notify — note prefix
 *     `<role>:<outcome>` CHÍNH XÁC, corrections #23: reason KHÔNG vào note);
 *     re-submit KHÁC giá trị → DEAL_ALREADY_MARKED (D3 — immutable per party).
 *  4. UNILATERAL (D3): no_deal/cancelled → claim open→terminal một mình;
 *     cancellationReason ≤500 (DEAL_CANCELLATION_REASON_MAX) lưu Ở Deal row
 *     (KHÔNG vào history note — corrections #23, KHÔNG vào telemetry — §4.8);
 *     reason trên no_deal → bị bỏ qua; >500 ký tự → validation error.
 *  5. MISMATCH (A1): buyer success + seller no_deal → deal no_deal, KHÔNG
 *     successful_match, CẢ HAI marking ghi trong history (không tự resolve).
 *  6. CONCURRENCY (Review Focus 3 — atomic claim): both-success
 *     (Promise.all) → MỘT completed transition + successful_match đúng một
 *     lần; success vs no_deal (Promise.all) → KHÔNG completed, KHÔNG
 *     successful_match, marking thua claim ghi lại chống trạng thái terminal.
 *  7. IDOR (§7.3 — Review Focus 1): third user / dealId thiếu / buyer của
 *     deal KHÁC → DEAL_FORBIDDEN (S9 — cùng mã, không existence oracle),
 *     zero writes.
 *  8. ACTOR GUARDS (§7.8/D10 — Batch 3 delegation, Q5): suspension chặn MỌI
 *     outcome (ACCOUNT_SUSPENDED); block chặn CHỈ success (CHAT_BLOCKED) —
 *     no_deal/cancelled VẪN ghi được dưới block (§5.5 "where appropriate").
 *  9. §7.1: lần thứ 21 deal mutation trong giờ → RATE_LIMITED.
 * 10. TELEMETRY (§4.8/Q6 + corrections #10): deal_outcome_marked metadata =
 *     { dealId, outcome, role } TYPED — assert ROW ProductEvent tồn tại
 *     (KHÔNG chỉ spy), KHÔNG cancellationReason free text, KHÔNG giá, KHÔNG
 *     markSold flag; successful_match actor = BUYER (corrections #26).
 * 11. S1 (rollback phantom): tx throw SAU completed claim → KHÔNG event
 *     nào, KHÔNG notify (emission chỉ chạy sau `await db.transaction` resolve
 *     — driven bởi flags tx trả về), store rollback (mock khôi phục snapshot).
 * 12. Chưa đăng nhập → auth mock throw NEXT_REDIRECT:/login, ZERO db call.
 * 13. Notify best-effort (corrections #22): notify lỗi db → action VẪN thành
 *     công + captureError("deal", "DEAL_NOTIFY_FAILED", { sqlState }) MÃ
 *     CHUỖI. corrections #14: revalidatePath(`/chat/<convoId>`) SAU commit
 *     (+ `/listings/<slug>` khi soldClaimed); error path KHÔNG revalidate.
 *
 * Cơ chế mock (Global Constraints stubbing recipe): server-only + next/cache
 * + next/navigation (redirect throw) + next/headers + `@/src/lib/auth` fixture
 * + db.client in-memory (Deal/DealStatusHistory/Listing/User/UserSuspension/
 * UserBlock/BetaCohortMembership/Notification/ProductEvent). Transaction mock
 * MÔ PHỎNG Postgres: (a) mutex promise-chain — MỘT tx chạy hết trước tx kế
 * (row-lock serialization của các claim cùng row — không có mutex, store dùng
 * chung cho tx này ĐỌC write CHƯA commit của tx kia, không phải READ
 * COMMITTED thật, và race Promise.all trở thành artifact của microtask
 * scheduling); (b) snapshot/restore — tx throw → store khôi phục như ROLLBACK
 * thật. `@/src/lib/moderation` GIỮ BẢN THẬT bọc spy (delegation pin Q5);
 * `@/src/lib/product-events` GIỮ BẢN THẬT bọc spy — emit core THẬT validate
 * schema (mở rộng ở Task 4) + ghi row vào store mock (corrections #10), spy
 * chụp txCommitted lúc gọi (pin emission SAU tx — S1).
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

// queue: cho các race (Promise.all) — mỗi requireUser call POP một user theo
// thứ tự call (action đầu tiên của Promise.all gọi trước) → hai action đồng
// thời chạy với hai user KHÁC NHAU mà không cần đổi global giữa chừng.
const authState = vi.hoisted(() => ({
  user: null as FixtureUser | null,
  queue: [] as FixtureUser[],
}));

vi.mock("@/src/lib/auth", () => ({
  requireUser: vi.fn(async () => {
    if (authState.queue.length > 0) return authState.queue.shift()!;
    if (authState.user === null) {
      const { redirect } = await import("next/navigation");
      redirect("/login");
    }
    return authState.user!;
  }),
  getCurrentUser: vi.fn(async () => authState.user),
}));

// ─── db.client mock — in-memory 9 model + mutex tx + snapshot rollback ────────

type Row = Record<string, unknown>;

const dbState = vi.hoisted(() => ({
  users: [] as Row[],
  listings: [] as Row[],
  deals: [] as Row[],
  dealHistory: [] as Row[],
  suspensions: [] as Row[],
  blocks: [] as Row[],
  memberships: [] as Row[],
  notifications: [] as Row[],
  events: [] as Row[], // ProductEvent rows — emit core THẬT ghi vào đây
  calls: [] as string[], // mọi terminal op — pin "zero db calls"
  fail: {} as { dealStatusHistoryCreate?: unknown; notificationCreate?: unknown },
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

  const orderBySpec = (
    cb: ((ops: unknown) => unknown) | Array<(ops: unknown) => unknown>,
  ): SortSpec => {
    const spec: SortSpec = [];
    const proxy = new Proxy(
      {},
      {
        get: (_t, field: string) => ({
          asc: () => spec.push({ field, dir: "asc" as const }),
          desc: () => spec.push({ field, dir: "desc" as const }),
        }),
      },
    );
    if (Array.isArray(cb)) {
      for (const fn of cb) fn(proxy);
    } else {
      cb(proxy);
    }
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
        return hit.map((r) => ({ ...r })); // MẢNG row — corrections #12 (.length)
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

  // DealStatusHistory — id monotonic (padStart) để tie-break createdAt desc
  // (createdAt mock là hằng số) cho idempotency "last row by actor" CHÍNH XÁC.
  let dshSeq = 0;
  const dealHistoryDefaults = () => {
    dshSeq += 1;
    return { id: `dsh-${String(dshSeq).padStart(6, "0")}`, createdAt: NOW };
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

  // DealStatusHistory — hook lỗi db cho case S1 (tx throw SAU completed claim).
  const dealHistoryBase = makeModel(dbState.dealHistory, dealHistoryDefaults);
  const dealHistoryModel = {
    ...dealHistoryBase,
    create: async (data: Row) => {
      dbState.calls.push("DealStatusHistory.create");
      if (dbState.fail.dealStatusHistoryCreate !== undefined) {
        throw dbState.fail.dealStatusHistoryCreate;
      }
      const row = { ...dealHistoryDefaults(), ...data };
      dbState.dealHistory.push(row);
      return { ...row };
    },
  };

  const models = {
    User: makeModel(dbState.users),
    Listing: makeModel(dbState.listings, () => ({
      id: `listing-${dbState.listings.length + 1}`,
      slug: `loa-${dbState.listings.length + 1}`,
      createdAt: NOW,
      updatedAt: NOW,
    })),
    Deal: makeModel(dbState.deals, () => ({
      id: globalThis.crypto.randomUUID(),
      createdAt: NOW,
      updatedAt: NOW,
    })),
    DealStatusHistory: dealHistoryModel,
    UserSuspension: makeModel(dbState.suspensions, () => ({
      id: `susp-${dbState.suspensions.length + 1}`,
      status: "active",
      createdAt: NOW,
    })),
    UserBlock: makeModel(dbState.blocks, () => ({
      id: `blk-${dbState.blocks.length + 1}`,
      createdAt: NOW,
    })),
    BetaCohortMembership: makeModel(dbState.memberships, () => ({
      id: `mem-${dbState.memberships.length + 1}`,
      cohort: "internal",
      status: "active",
      expiresAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    })),
    Notification: notificationModel,
    ProductEvent: makeModel(dbState.events, () => ({
      id: `pe-${dbState.events.length + 1}`,
      occurredAt: NOW,
    })),
  };

  // Transaction mock — MÔ PHỎNG Postgres cho các race cùng row:
  //  (a) MUTEX promise-chain: MỘT tx chạy hết (callback await-to-await) trước
  //      tx kế — đúng như row-lock serialization khi hai tx cùng claim MỘT
  //      row Deal. Không mutex: store dùng chung cho tx này đọc write CHƯA
  //      commit của tx kia (không phải READ COMMITTED) → kết quả race là
  //      artifact của microtask scheduling, không phải semantics.
  //  (b) SNAPSHOT/RESTORE: tx throw → store khôi phục (như ROLLBACK thật) —
  //      pin S1: emission + notify chỉ chạy sau resolve, rollback không thể
  //      để lại event ma.
  const STORES: Row[][] = [
    dbState.users,
    dbState.listings,
    dbState.deals,
    dbState.dealHistory,
    dbState.suspensions,
    dbState.blocks,
    dbState.memberships,
    dbState.notifications,
    dbState.events,
  ];
  let txChain: Promise<unknown> = Promise.resolve();

  return {
    db: {
      orm: { public: models },
      transaction: async (fn: (tx: { orm: { public: typeof models } }) => Promise<unknown>) => {
        const prev = txChain;
        let release!: (value: unknown) => void;
        txChain = new Promise((resolve) => {
          release = resolve;
        });
        await prev;
        const snapshot = STORES.map((arr) => arr.map((r) => ({ ...r })));
        try {
          const result = await fn({ orm: { public: { ...models } } });
          dbState.txCommitted = true;
          return result;
        } catch (e) {
          for (const [i, arr] of STORES.entries()) {
            arr.length = 0;
            arr.push(...snapshot[i]!);
          }
          throw e;
        } finally {
          release(undefined);
        }
      },
    },
  };
});

// ─── moderation mock — REAL implementation bọc spy (Q5 delegation pin) ───────
// importOriginal: hành vi thật (isUserSuspended/getBlockState đọc cùng db mock
// ở trên) — spy để assert markDealOutcomeAction DELEGATE actor suspension/block
// cho Batch 3 (qua assertDealOutcomeAllowed của Task 2) thay vì tự viết lại.

vi.mock("@/src/lib/moderation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/lib/moderation")>();
  return {
    ...actual,
    assertCanStartConversation: vi.fn(actual.assertCanStartConversation),
    assertCanSendMessage: vi.fn(actual.assertCanSendMessage),
    isUserSuspended: vi.fn(actual.isUserSuspended),
    getBlockState: vi.fn(actual.getBlockState),
  };
});

// ─── product-events mock — REAL emit core bọc spy (corrections #10 + S1) ──────
// emitProductEvent THẬT chạy (validate schema Task 4 + ghi row vào
// dbState.events — assert ROW, KHÔNG chỉ spy); spy chụp txCommitted LÚC gọi để
// pin emission SAU tx (S1 — KHÔNG bao giờ trong callback).

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
import { getBlockState, isUserSuspended } from "@/src/lib/moderation";
import { emitProductEvent } from "@/src/lib/product-events";
import { captureError } from "@/src/lib/observability";
import { revalidatePath } from "next/cache";
import { markDealOutcomeAction } from "@/src/lib/actions/deals";

const emitSpy = vi.mocked(emitProductEvent);
const captureErrorMock = vi.mocked(captureError);
const revalidatePathMock = vi.mocked(revalidatePath);
const isUserSuspendedSpy = vi.mocked(isUserSuspended);
const getBlockStateSpy = vi.mocked(getBlockState);

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

/** Third user — không phải bên nào của deal (§7.3 IDOR). */
const THIRD: FixtureUser = {
  id: "33333333-3333-4333-8333-333333333333",
  email: "ngoai@loaviet.test",
  name: "Người Ngoài",
  role: "buyer",
  avatarUrl: null,
  isVerifiedSeller: false,
  adminRole: null,
  sessionId: "sess-third",
};

/** Buyer của deal KHÁC — cross-account Deal modification (§7.3). */
const OTHER_BUYER: FixtureUser = {
  id: "44444444-4444-4444-8444-444444444444",
  email: "muakhac@loaviet.test",
  name: "Người Mua Khác",
  role: "buyer",
  avatarUrl: null,
  isVerifiedSeller: false,
  adminRole: null,
  sessionId: "sess-other-buyer",
};

function seedListing(over: Row = {}): Row {
  const row: Row = {
    id: "listing-1",
    sellerId: SELLER.id,
    status: "approved",
    title: "Loa JBL Charge 5",
    slug: "loa-jbl-charge-5",
    price: 1_800_000,
    ...over,
  };
  dbState.listings.push(row);
  return row;
}

/** Deal id fixture — UUID THẬT (emit core schema dealId: z.uuid() — "deal-1" bị SCHEMA_REJECTED). */
const DEAL_ID = "1e6b8c9a-4d2e-4f5a-9b3c-7d8e9f0a1b2c";

/** Deal của buyer khác — cross-account Deal modification (§7.3). */
const OTHER_DEAL_ID = "2f7c9d8b-5e3f-4a6b-8c4d-9e0f1a2b3c4d";

type SeedDeal = {
  id?: string;
  listingId?: string;
  buyerId?: string;
  sellerId?: string;
  status?: string;
  conversationId?: string;
  buyerOutcomeAt?: string | null;
  sellerOutcomeAt?: string | null;
  completedAt?: string | null;
  cancellationReason?: string | null;
};

/** Deal open mặc định (listing-1, BUYER, SELLER) — mọi case chỉnh field riêng. */
function seedDeal(over: SeedDeal = {}): Row {
  const row: Row = {
    id: DEAL_ID,
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
  return row;
}

function outcomeForm(over: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("dealId", DEAL_ID);
  fd.set("outcome", "success");
  for (const [k, v] of Object.entries(over)) fd.set(k, v);
  return fd;
}

const resetStores = () => {
  for (const store of [
    dbState.users,
    dbState.listings,
    dbState.deals,
    dbState.dealHistory,
    dbState.suspensions,
    dbState.blocks,
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
  authState.queue.length = 0;
  resetStores();
  emitSpy.mockClear();
  captureErrorMock.mockClear();
  revalidatePathMock.mockClear();
  isUserSuspendedSpy.mockClear();
  getBlockStateSpy.mockClear();
  resetRateLimits();
  seedListing();
  seedDeal();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── 1. Bilateral success (§5.2/D3/D6) ────────────────────────────────────────

describe("markDealOutcomeAction — bilateral success (§5.2/D3)", () => {
  it("buyer marks success → buyerOutcomeAt set, status VẪN open, history (open, 'buyer:success'), deal_outcome_marked SAU tx, seller notified; KHÔNG sold transition (D6)", async () => {
    const state = await markDealOutcomeAction({}, outcomeForm());

    expect(state).toEqual({ success: expect.stringContaining("Đã ghi") });
    const deal = dbState.deals[0]!;
    expect(deal.buyerOutcomeAt).not.toBeNull();
    expect(deal.sellerOutcomeAt).toBeNull();
    expect(deal.status).toBe("open"); // một bên success — chưa song phương
    expect(deal.completedAt).toBeNull();

    // History — MỘT row marking (status deal SAU marking = open)
    expect(dbState.dealHistory).toHaveLength(1);
    expect(dbState.dealHistory[0]).toMatchObject({
      dealId: DEAL_ID,
      status: "open",
      actorId: BUYER.id,
      note: "buyer:success", // typed marker — corrections #23 (KHÔNG reason)
    });

    // Emission SAU tx (S1) — ROW tồn tại (corrections #10), KHÔNG successful_match
    expect(dbState.txCommittedAtEmit).toBe(true);
    expect(dbState.events).toHaveLength(1);
    expect(dbState.events[0]).toMatchObject({ name: "deal_outcome_marked" });
    expect(dbState.events[0]!.metadata).toEqual({
      dealId: DEAL_ID,
      outcome: "success",
      role: "buyer",
    });
    expect(dbState.events.filter((e) => e.name === "successful_match")).toHaveLength(0);

    // Seller notified (counterparty) — typed title + label + link (Q6)
    expect(dbState.notifications).toHaveLength(1);
    expect(dbState.notifications[0]).toMatchObject({
      userId: SELLER.id,
      kind: "deal",
      link: "/chat/convo-1",
    });

    // Listing VẪN approved — markSold là seller-only (D6)
    expect(dbState.listings[0]!.status).toBe("approved");
    // corrections #14 — revalidatePath trang hội thoại SAU commit
    expect(revalidatePathMock).toHaveBeenCalledWith("/chat/convo-1");
  });

  it("seller kế tiếp marks success KHÔNG markSold → completed + completedAt + successful_match ĐÚNG MỘT LẦN; listing VẪN approved — KHÔNG listing_marked_sold (D6/S7)", async () => {
    await markDealOutcomeAction({}, outcomeForm()); // buyer success
    authState.user = SELLER;

    const state = await markDealOutcomeAction({}, outcomeForm());

    expect(state).toEqual({ success: expect.stringContaining("Đã ghi") });
    const deal = dbState.deals[0]!;
    expect(deal).toMatchObject({ status: "completed" });
    expect(deal.buyerOutcomeAt).not.toBeNull();
    expect(deal.sellerOutcomeAt).not.toBeNull();
    expect(deal.completedAt).not.toBeNull();

    // successful_match ĐÚNG MỘT LẦN — bilateral (§5.2), KHÔNG phải từ buyer mark
    const matches = dbState.events.filter((e) => e.name === "successful_match");
    expect(matches).toHaveLength(1);
    expect(matches[0]!.metadata).toEqual({ dealId: DEAL_ID });
    // corrections #26 — successful_match actor = BUYER (metrics fixture shape)
    expect(matches[0]!.actorPseudonym).not.toBe(SELLER.id);

    // Bilateral completion MỘT MÌNH KHÔNG bán listing (D6/S7)
    expect(dbState.listings[0]!.status).toBe("approved");
    expect(dbState.events.filter((e) => e.name === "listing_marked_sold")).toHaveLength(0);

    // History — 2 marking rows, status sau marking đúng (open → completed)
    expect(dbState.dealHistory).toHaveLength(2);
    expect(dbState.dealHistory[1]).toMatchObject({
      status: "completed",
      actorId: SELLER.id,
      note: "seller:success",
    });
  });

  it("seller marks success VỚI markSold → completed + successful_match + listing approved → sold + listing_marked_sold + history rows (D6 — lựa chọn tường minh)", async () => {
    await markDealOutcomeAction({}, outcomeForm()); // buyer success
    authState.user = SELLER;

    const state = await markDealOutcomeAction({}, outcomeForm({ markSold: "on" }));

    expect(state).toEqual({ success: expect.stringContaining("Đã ghi") });
    expect(dbState.deals[0]!.status).toBe("completed");
    expect(dbState.listings[0]!.status).toBe("sold"); // claim approved→sold thắng

    const sold = dbState.events.filter((e) => e.name === "listing_marked_sold");
    expect(sold).toHaveLength(1);
    expect(sold[0]!.metadata).toEqual({ dealId: DEAL_ID });
    expect(dbState.events.filter((e) => e.name === "successful_match")).toHaveLength(1);

    // corrections #14 — revalidatePath cả trang listing khi soldClaimed
    const paths = revalidatePathMock.mock.calls.map((c) => c[0]);
    expect(paths).toContain("/listings/loa-jbl-charge-5");
  });

  it("buyer submit markSold → bị BỎ QUA (không sold transition, không event) — markSold là seller-only (D6)", async () => {
    const state = await markDealOutcomeAction({}, outcomeForm({ markSold: "on" }));

    expect(state).toEqual({ success: expect.stringContaining("Đã ghi") });
    expect(dbState.deals[0]!.status).toBe("open"); // buyer success một mình
    expect(dbState.listings[0]!.status).toBe("approved"); // KHÔNG sold
    expect(dbState.events.filter((e) => e.name === "listing_marked_sold")).toHaveLength(0);
    expect(dbState.events.filter((e) => e.name === "successful_match")).toHaveLength(0);
  });

  it("seller marks success với markSold trên listing ĐÃ sold → claim 0 row → KHÔNG listing_marked_sold, marking + completion không ảnh hưởng", async () => {
    await markDealOutcomeAction({}, outcomeForm()); // buyer success
    dbState.listings[0]!.status = "sold"; // listing đã rời approved (đã bán từ deal khác)
    authState.user = SELLER;

    const state = await markDealOutcomeAction({}, outcomeForm({ markSold: "on" }));

    expect(state).toEqual({ success: expect.stringContaining("Đã ghi") });
    expect(dbState.deals[0]!.status).toBe("completed"); // completion không phụ thuộc sold claim
    expect(dbState.listings[0]!.status).toBe("sold");
    expect(dbState.events.filter((e) => e.name === "successful_match")).toHaveLength(1);
    expect(dbState.events.filter((e) => e.name === "listing_marked_sold")).toHaveLength(0);
  });
});

// ─── 2. Idempotency (D3 — gate item "Deal idempotency") ────────────────────────

describe("markDealOutcomeAction — idempotency (D3)", () => {
  it("re-submit CÙNG giá trị → no-op thành công: không history row mới, không event, không notify", async () => {
    await markDealOutcomeAction({}, outcomeForm({ outcome: "no_deal" }));
    const historyCount = dbState.dealHistory.length;
    const eventCount = dbState.events.length;
    const notifCount = dbState.notifications.length;
    emitSpy.mockClear();
    revalidatePathMock.mockClear();

    const state = await markDealOutcomeAction({}, outcomeForm({ outcome: "no_deal" }));

    expect(state).toEqual({ success: expect.stringContaining("Đã ghi") }); // no-op THÀNH CÔNG
    expect(dbState.dealHistory).toHaveLength(historyCount); // KHÔNG row mới
    expect(dbState.events).toHaveLength(eventCount); // KHÔNG event mới
    expect(dbState.notifications).toHaveLength(notifCount); // KHÔNG notify mới
    expect(emitSpy).not.toHaveBeenCalled();
    expect(revalidatePathMock).not.toHaveBeenCalled(); // không state change
  });

  it("re-submit KHÁC giá trị → DEAL_ALREADY_MARKED, không mutation (per-party immutable — D3)", async () => {
    await markDealOutcomeAction({}, outcomeForm()); // buyer:success
    const historyCount = dbState.dealHistory.length;
    emitSpy.mockClear();

    const state = await markDealOutcomeAction({}, outcomeForm({ outcome: "no_deal" }));

    expect(state).toEqual({ error: "DEAL_ALREADY_MARKED" });
    expect(dbState.dealHistory).toHaveLength(historyCount); // KHÔNG row mới
    expect(emitSpy).not.toHaveBeenCalled();
    // Không mutation — outcomeAt giữ nguyên giá trị marking đầu
    expect(dbState.deals[0]!.buyerOutcomeAt).not.toBeNull();
    expect(dbState.deals[0]!.status).toBe("open");
  });

  it("seller re-submit khác giá trị sau khi đã mark → DEAL_ALREADY_MARKED (per-party immutability cả hai bên)", async () => {
    await markDealOutcomeAction({}, outcomeForm()); // buyer success
    authState.user = SELLER;
    await markDealOutcomeAction({}, outcomeForm({ markSold: "on" })); // seller:success → completed
    const historyCount = dbState.dealHistory.length;
    emitSpy.mockClear();

    const state = await markDealOutcomeAction({}, outcomeForm({ outcome: "cancelled" }));

    expect(state).toEqual({ error: "DEAL_ALREADY_MARKED" });
    expect(dbState.dealHistory).toHaveLength(historyCount);
    expect(emitSpy).not.toHaveBeenCalled();
    expect(dbState.deals[0]!.status).toBe("completed"); // KHÔNG đảo ngược
  });
});

// ─── 3. Unilateral no_deal / cancelled (D3) ───────────────────────────────────

describe("markDealOutcomeAction — no_deal / cancelled (D3 unilateral)", () => {
  it("mark no_deal → status no_deal + history + notify; KHÔNG successful_match", async () => {
    const state = await markDealOutcomeAction({}, outcomeForm({ outcome: "no_deal" }));

    expect(state).toEqual({ success: expect.stringContaining("Đã ghi") });
    expect(dbState.deals[0]!.status).toBe("no_deal");
    expect(dbState.deals[0]!.cancellationReason).toBeNull();
    expect(dbState.dealHistory).toHaveLength(1);
    expect(dbState.dealHistory[0]).toMatchObject({
      status: "no_deal",
      actorId: BUYER.id,
      note: "buyer:no_deal",
    });
    expect(dbState.events.filter((e) => e.name === "successful_match")).toHaveLength(0);
    expect(dbState.events.filter((e) => e.name === "deal_outcome_marked")).toHaveLength(1);
    expect(dbState.notifications).toHaveLength(1); // notify counterpart
  });

  it("mark cancelled với reason → status cancelled + cancellationReason lưu Ở Deal row; reason KHÔNG vào history note (corrections #23)", async () => {
    const state = await markDealOutcomeAction(
      {},
      outcomeForm({ outcome: "cancelled", cancellationReason: "Đổi ý không mua nữa" }),
    );

    expect(state).toEqual({ success: expect.stringContaining("Đã ghi") });
    expect(dbState.deals[0]!.status).toBe("cancelled");
    expect(dbState.deals[0]!.cancellationReason).toBe("Đổi ý không mua nữa");
    expect(dbState.dealHistory[0]!.note).toBe("buyer:cancelled"); // typed marker ONLY
    // Reason KHÔNG vào telemetry (§4.8)
    expect(JSON.stringify(dbState.events)).not.toContain("Đổi ý");
  });

  it("reason > 500 ký tự → validation error, không mutation", async () => {
    const state = await markDealOutcomeAction(
      {},
      outcomeForm({ outcome: "cancelled", cancellationReason: "x".repeat(501) }),
    );

    expect(state).toEqual({ error: "DEAL_REASON_INVALID" });
    expect(dbState.deals[0]!.status).toBe("open");
    expect(dbState.deals[0]!.cancellationReason).toBeNull();
    expect(dbState.dealHistory).toHaveLength(0);
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("reason trên no_deal → bị BỎ QUA (không lưu — reason chỉ dành cho cancelled)", async () => {
    const state = await markDealOutcomeAction(
      {},
      outcomeForm({ outcome: "no_deal", cancellationReason: "lý do bị bỏ qua" }),
    );

    expect(state).toEqual({ success: expect.stringContaining("Đã ghi") });
    expect(dbState.deals[0]!.status).toBe("no_deal");
    expect(dbState.deals[0]!.cancellationReason).toBeNull(); // KHÔNG lưu
  });

  it("outcome ngoài vocabulary → typed validation error, không mutation", async () => {
    const state = await markDealOutcomeAction({}, outcomeForm({ outcome: "refund" }));

    expect(state).toEqual({ error: "DEAL_OUTCOME_INVALID" });
    expect(dbState.deals[0]!.status).toBe("open");
    expect(dbState.dealHistory).toHaveLength(0);
    expect(emitSpy).not.toHaveBeenCalled();
  });
});

// ─── 4. Mismatch (A1 — không tự resolve) ──────────────────────────────────────

describe("markDealOutcomeAction — mismatch (A1)", () => {
  it("buyer success + seller no_deal → deal no_deal, KHÔNG successful_match, CẢ HAI marking ghi trong history", async () => {
    await markDealOutcomeAction({}, outcomeForm()); // buyer:success — deal VẪN open
    authState.user = SELLER;

    const state = await markDealOutcomeAction({}, outcomeForm({ outcome: "no_deal" }));

    expect(state).toEqual({ success: expect.stringContaining("Đã ghi") });
    expect(dbState.deals[0]!.status).toBe("no_deal"); // no_deal thắng status claim
    expect(dbState.deals[0]!.completedAt).toBeNull();
    expect(dbState.events.filter((e) => e.name === "successful_match")).toHaveLength(0);

    // CẢ HAI marking ghi nhận — mismatch hiển thị, KHÔNG tự resolve (A1)
    expect(dbState.dealHistory).toHaveLength(2);
    expect(dbState.dealHistory[0]).toMatchObject({ note: "buyer:success", status: "open" });
    expect(dbState.dealHistory[1]).toMatchObject({ note: "seller:no_deal", status: "no_deal" });
  });

  it("seller no_deal TRƯỚC → buyer success kế tiếp: claim completed thua (0 row), marking ghi lại chống trạng thái terminal", async () => {
    authState.user = SELLER;
    await markDealOutcomeAction({}, outcomeForm({ outcome: "no_deal" })); // deal → no_deal
    authState.user = BUYER;

    const state = await markDealOutcomeAction({}, outcomeForm()); // buyer success

    expect(state).toEqual({ success: expect.stringContaining("Đã ghi") });
    expect(dbState.deals[0]!.status).toBe("no_deal"); // KHÔNG completed
    expect(dbState.deals[0]!.completedAt).toBeNull();
    expect(dbState.events.filter((e) => e.name === "successful_match")).toHaveLength(0);
    // Marking vẫn được ghi — chống trạng thái terminal (§5.2 "emitted only when both sides confirm")
    expect(dbState.dealHistory).toHaveLength(2);
    expect(dbState.dealHistory[1]).toMatchObject({ note: "buyer:success", status: "no_deal" });
  });
});

// ─── 5. Concurrency (Review Focus 3 — atomic claim) ───────────────────────────

describe("markDealOutcomeAction — concurrency (atomic claim, Review Focus 3)", () => {
  it("concurrent both-success (Promise.all) → MỘT completed transition, successful_match ĐÚNG MỘT LẦN, cả hai outcomeAt set, MỘT completedAt", async () => {
    // queue: action đầu (buyer) pop BUYER, action thứ hai (seller) pop SELLER.
    authState.queue.push(BUYER, SELLER);

    const [buyerState, sellerState] = await Promise.all([
      markDealOutcomeAction({}, outcomeForm()), // buyer success
      markDealOutcomeAction({}, outcomeForm()), // seller success
    ]);

    // Cả hai marking thành công — marking là độc lập per party (§5.2)
    expect(buyerState).toEqual({ success: expect.stringContaining("Đã ghi") });
    expect(sellerState).toEqual({ success: expect.stringContaining("Đã ghi") });

    const deal = dbState.deals[0]!;
    expect(deal.buyerOutcomeAt).not.toBeNull();
    expect(deal.sellerOutcomeAt).not.toBeNull();
    expect(deal.status).toBe("completed"); // MỘT completed transition
    expect(deal.completedAt).not.toBeNull();

    // successful_match ĐÚNG MỘT LẦN — claim winner (atomic claim open→completed;
    // tx thua cuộc thấy status đã completed → 0 row → KHÔNG emit thứ hai)
    expect(dbState.events.filter((e) => e.name === "successful_match")).toHaveLength(1);
    // Cả hai marking đều emit deal_outcome_marked
    expect(dbState.events.filter((e) => e.name === "deal_outcome_marked")).toHaveLength(2);
  });

  it("concurrent success vs no_deal (Promise.all) → KHÔNG completed, KHÔNG successful_match, marking thua claim ghi lại chống trạng thái terminal", async () => {
    authState.queue.push(BUYER, SELLER);

    const [buyerState, sellerState] = await Promise.all([
      markDealOutcomeAction({}, outcomeForm()), // buyer success
      markDealOutcomeAction({}, outcomeForm({ outcome: "no_deal" })), // seller no_deal
    ]);

    expect(buyerState).toEqual({ success: expect.stringContaining("Đã ghi") });
    expect(sellerState).toEqual({ success: expect.stringContaining("Đã ghi") });

    const deal = dbState.deals[0]!;
    // no_deal thắng status claim — completion claim thua (0 row) → KHÔNG completed
    // (tx mock mutex mô phỏng row-lock serialization — cùng kết quả mọi thứ tự)
    expect(deal.status).toBe("no_deal");
    expect(deal.completedAt).toBeNull();
    expect(dbState.events.filter((e) => e.name === "successful_match")).toHaveLength(0);
    // CẢ HAI marking ghi trong history (mismatch — A1, không tự resolve)
    expect(dbState.dealHistory).toHaveLength(2);
  });
});

// ─── 6. IDOR (§7.3 — Review Focus 1) ──────────────────────────────────────────

describe("markDealOutcomeAction — IDOR (§7.3/S9)", () => {
  it("third user (non-participant) → DEAL_FORBIDDEN, zero writes", async () => {
    authState.user = THIRD;

    const state = await markDealOutcomeAction({}, outcomeForm());

    expect(state).toEqual({ error: "DEAL_FORBIDDEN" });
    expect(dbState.deals[0]!.buyerOutcomeAt).toBeNull(); // zero writes
    expect(dbState.deals[0]!.sellerOutcomeAt).toBeNull();
    expect(dbState.deals[0]!.status).toBe("open");
    expect(dbState.dealHistory).toHaveLength(0);
    expect(dbState.events).toHaveLength(0);
    expect(dbState.notifications).toHaveLength(0);
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("dealId THIẾU → DEAL_FORBIDDEN (S9 — cùng mã với non-participant, không existence oracle)", async () => {
    const fd = new FormData();
    fd.set("outcome", "success");

    const state = await markDealOutcomeAction({}, fd);

    expect(state).toEqual({ error: "DEAL_FORBIDDEN" });
    expect(dbState.dealHistory).toHaveLength(0);
    expect(dbState.events).toHaveLength(0);
  });

  it("buyer của deal KHÁC → DEAL_FORBIDDEN (cross-account Deal modification — §7.3)", async () => {
    seedDeal({
      id: OTHER_DEAL_ID,
      listingId: "listing-2",
      conversationId: "convo-2",
      buyerId: OTHER_BUYER.id,
    });

    const state = await markDealOutcomeAction({}, outcomeForm({ dealId: OTHER_DEAL_ID }));

    expect(state).toEqual({ error: "DEAL_FORBIDDEN" });
    const other = dbState.deals.find((d) => d.id === OTHER_DEAL_ID)!;
    expect(other.buyerOutcomeAt).toBeNull(); // zero writes trên deal của người khác
    expect(dbState.dealHistory).toHaveLength(0);
    expect(dbState.events).toHaveLength(0);
  });
});

// ─── 7. Actor guards (§7.8/D10 — Batch 3 delegation, Q5) ──────────────────────

describe("markDealOutcomeAction — actor guards (§7.8/D10)", () => {
  it("suspended actor → ACCOUNT_SUSPENDED cho CẢ BA outcome (suspension chặn MỌI marking)", async () => {
    dbState.suspensions.push({ id: "susp-1", userId: BUYER.id, status: "active" });

    for (const outcome of ["success", "no_deal", "cancelled"] as const) {
      const state = await markDealOutcomeAction({}, outcomeForm({ outcome }));
      expect(state).toEqual({ error: "ACCOUNT_SUSPENDED" });
    }

    // Zero writes + delegation spy (Q5 — isUserSuspended của Batch 3 được gọi)
    expect(dbState.deals[0]!.buyerOutcomeAt).toBeNull();
    expect(dbState.dealHistory).toHaveLength(0);
    expect(isUserSuspendedSpy).toHaveBeenCalledWith(BUYER.id);
  });

  it("blocked pair + outcome 'success' → CHAT_BLOCKED; no_deal/cancelled → VẪN ĐƯỢC PHÉP ghi (D10/FD-3 — block không được làm stranded bản ghi kết quả)", async () => {
    dbState.blocks.push({ id: "blk-1", blockerId: SELLER.id, blockedId: BUYER.id });

    // success → CHAT_BLOCKED (buyer bị seller chặn)
    const successState = await markDealOutcomeAction({}, outcomeForm());
    expect(successState).toEqual({ error: "CHAT_BLOCKED" });
    expect(dbState.deals[0]!.buyerOutcomeAt).toBeNull();

    // no_deal → ALLOWED — marking recorded dưới block (D10)
    const noDealState = await markDealOutcomeAction({}, outcomeForm({ outcome: "no_deal" }));
    expect(noDealState).toEqual({ success: expect.stringContaining("Đã ghi") });
    expect(dbState.deals[0]!.status).toBe("no_deal");
    expect(dbState.dealHistory).toHaveLength(1);

    // seller (counterpart — cũng bị block theo hướng ngược) marks cancelled →
    // ALLOWED: marking ghi lại chống trạng thái terminal (deal đã no_deal)
    authState.user = SELLER;
    const cancelledState = await markDealOutcomeAction(
      {},
      outcomeForm({ outcome: "cancelled", cancellationReason: "Không giao nữa" }),
    );
    expect(cancelledState).toEqual({ success: expect.stringContaining("Đã ghi") });
    expect(dbState.dealHistory).toHaveLength(2);
    expect(dbState.dealHistory[1]).toMatchObject({ note: "seller:cancelled", status: "no_deal" });

    // Delegation spy (Q5 — getBlockState của Batch 3 được gọi cho success)
    expect(getBlockStateSpy).toHaveBeenCalledWith(BUYER.id, SELLER.id);
  });
});

// ─── 8. Rate limit (§7.1) ──────────────────────────────────────────────────────

describe("markDealOutcomeAction — rate limit (§7.1 'Deal mutation')", () => {
  it("lần thứ 21 trong giờ → RATE_LIMITED, không mutation", async () => {
    // 20 lần đầu tiêu budget bucket deal:mutation:<userId> (kết quả action bất
    // kỳ — rate limit là bước ĐẦU, chạy trước mọi guard/read).
    for (let i = 0; i < 20; i++) {
      await markDealOutcomeAction({}, outcomeForm({ dealId: "deal-khong-ton-tai" }));
    }
    const historyCount = dbState.dealHistory.length;
    emitSpy.mockClear();

    const state = await markDealOutcomeAction({}, outcomeForm());

    expect(state).toEqual({ error: "RATE_LIMITED" });
    expect(dbState.dealHistory).toHaveLength(historyCount); // KHÔNG row mới
    expect(emitSpy).not.toHaveBeenCalled();
  });
});

// ─── 9. Telemetry privacy (§4.8 — Review Focus 5) ─────────────────────────────

describe("markDealOutcomeAction — telemetry payload (§4.8/Q6)", () => {
  it("deal_outcome_marked metadata = { dealId, outcome, role } TYPED — KHÔNG cancellationReason, KHÔNG giá, KHÔNG markSold flag", async () => {
    await markDealOutcomeAction(
      {},
      outcomeForm({ outcome: "cancelled", cancellationReason: "Gặp loa khác rẻ hơn" }),
    );

    const evt = dbState.events.find((e) => e.name === "deal_outcome_marked")!;
    expect(evt.metadata).toEqual({ dealId: DEAL_ID, outcome: "cancelled", role: "buyer" });
    expect(Object.keys(evt.metadata as Row)).toEqual(["dealId", "outcome", "role"]);
    // §4.8 — KHÔNG free text, KHÔNG giá, KHÔNG markSold trong metadata
    expect(JSON.stringify(evt.metadata)).not.toContain("Gặp loa");
    expect(JSON.stringify(evt.metadata)).not.toContain("markSold");
    expect(JSON.stringify(evt.metadata)).not.toContain("agreedPrice");
    // Pseudonym KHÔNG phải id thô (S-10)
    expect(evt.actorPseudonym).not.toBe(BUYER.id);
    expect(evt.sessionPseudonym).not.toBe(BUYER.sessionId);
  });
});

// ─── 10. S1 — rollback phantom check ───────────────────────────────────────────

describe("markDealOutcomeAction — S1 (emission sau commit, rollback không event ma)", () => {
  it("tx throw SAU completed claim → KHÔNG event nào, KHÔNG notify, store rollback (không successful_match ma)", async () => {
    await markDealOutcomeAction({}, outcomeForm()); // buyer success
    authState.user = SELLER;
    // History create là statement CUỐI trong tx — ném SAU khi completed claim
    // đã chạy (tx abort → MỌI write trong tx bị rollback).
    dbState.fail.dealStatusHistoryCreate = new Error("mock history insert failed");

    await expect(markDealOutcomeAction({}, outcomeForm())).rejects.toThrowError(
      /mock history insert failed/,
    );

    // KHÔNG event ma — emission chỉ chạy sau `await db.transaction` resolve
    // (driven bởi flags tx trả về — tx throw thì không có flags).
    expect(dbState.events.filter((e) => e.name === "successful_match")).toHaveLength(0);
    expect(dbState.events.filter((e) => e.name === "listing_marked_sold")).toHaveLength(0);
    expect(dbState.events.filter((e) => e.name === "deal_outcome_marked")).toHaveLength(1); // của buyer mark ĐẦU
    expect(dbState.notifications).toHaveLength(1); // của buyer mark — KHÔNG thêm
    // Store rollback như ROLLBACK thật — seller marking + completed claim ĐỀU revert
    expect(dbState.deals[0]!.sellerOutcomeAt).toBeNull();
    expect(dbState.deals[0]!.status).toBe("open");
    expect(dbState.deals[0]!.completedAt).toBeNull();
    expect(dbState.dealHistory).toHaveLength(1); // chỉ row của buyer
  });
});

// ─── 11. Chưa đăng nhập ─────────────────────────────────────────────────────────

describe("markDealOutcomeAction — chưa đăng nhập", () => {
  it("auth mock throw NEXT_REDIRECT:/login, ZERO db call", async () => {
    authState.user = null;

    await expect(markDealOutcomeAction({}, outcomeForm())).rejects.toThrowError(
      /NEXT_REDIRECT:\/login/,
    );

    expect(dbState.calls).toHaveLength(0); // KHÔNG read/write nào trước auth
    expect(dbState.dealHistory).toHaveLength(0);
    expect(dbState.events).toHaveLength(0);
  });
});

// ─── 12. Notify best-effort (corrections #22) ──────────────────────────────────

describe("markDealOutcomeAction — notify best-effort (corrections #22)", () => {
  it("notify lỗi db → action VẪN thành công (marking đã commit) + captureError MÃ CHUỖI DEAL_NOTIFY_FAILED", async () => {
    dbState.fail.notificationCreate = new SqlQueryError("mock notification insert failed", {
      sqlState: "53300",
    });

    const state = await markDealOutcomeAction({}, outcomeForm());

    // Marking + history + emission VẪN đầy đủ — notify KHÔNG sống chết với flow
    expect(state).toEqual({ success: expect.stringContaining("Đã ghi") });
    expect(dbState.deals[0]!.buyerOutcomeAt).not.toBeNull();
    expect(dbState.dealHistory).toHaveLength(1);
    expect(dbState.events).toHaveLength(1);

    // corrections #22 — captureError(scope, MÃ CHUỖI, { sqlState }): KHÔNG error object
    expect(captureErrorMock).toHaveBeenCalledWith("deal", "DEAL_NOTIFY_FAILED", {
      sqlState: "53300",
    });
  });
});
