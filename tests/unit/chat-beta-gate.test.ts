/**
 * Buyer beta access gate trên startConversationAction — unit tests (Batch 7
 * plan Task 6, spec §2.1 buyer beta access policy + §7.8 beta-membership
 * status; T4/C1 guard order; corrections 2026-10-08 items 16/17/18).
 *
 * Hợp đồng (plan Task 6 Step 1 — fixtures ở Batch 6 verified-seller +
 * approved-listing shape: seller thỏa assertListingSellerInteractable, listing
 * approved; spy Conversation.create qua store + emission recorder THẬT ghi row
 * ProductEvent vào mock):
 *
 *  1. buyer KHÔNG active membership → BETA_MEMBERSHIP_REQUIRED, KHÔNG
 *     Conversation, KHÔNG conversation_started (create không chạy → emission
 *     không fire).
 *  2. buyer CÓ active private_beta_buyer → conversation tạo + emission fires
 *     (policy cho phép buyer được mời).
 *  3. founding seller bắt đầu hội thoại (active membership) → allowed
 *     (seller cũng là participant §2.1).
 *  4. buyer membership founding_seller SUSPENDED → BETA_MEMBERSHIP_REQUIRED
 *     (Review Focus 3 — suspended membership enforced trên chat).
 *  5. Guard chạy SAU guard Batch 3/6 (order pin): pair bị block mà không có
 *     membership → CHAT_BLOCKED (KHÔNG phải BETA_MEMBERSHIP_REQUIRED);
 *     initiator bị đình chỉ → ACCOUNT_SUSPENDED; suspended-membership
 *     SELLER → SELLER_MEMBERSHIP_INACTIVE (Batch 6 D2 fires first — ordering:
 *     Batch 3 actor-side → Batch 6 seller-side → Batch 7 buyer-side).
 *  6. Guard chạy SAU existing-conversation lookup + TRƯỚC Conversation.create:
 *     non-member buyer CÓ hội thoại cũ của pair → redirect branch NGUYÊN VẸN
 *     (§2.1 chỉ chặn CREATION); non-member buyer KHÔNG có →
 *     BETA_MEMBERSHIP_REQUIRED, không Conversation.create.
 *  7. Message trong hội thoại CŨ KHÔNG bị gate bởi beta policy — source
 *     assertion: assertBuyerBetaChatAccess vắng mặt ở POST route
 *     (app/api/chat/[id]/route.ts — §2.1 restriction là NEW conversation
 *     creation only).
 *
 * Cơ chế mock (Global Constraints stubbing recipe): server-only + next/cache
 * + next/navigation (redirect throw) + next/headers + `@/src/lib/auth` fixture
 * + db.client in-memory (User/Listing/Conversation/UserBlock/UserSuspension/
 * SellerVerification/BetaCohortMembership/ProductEvent). `@/src/lib/moderation`
 * + `@/src/lib/rate-limit` GIỮ BẢN THẬT (guard chạy code production đọc store
 * mock); emit core THẬT (PRODUCT_EVENT_PSEUDONYM_KEY stubbed) ghi row vào
 * store — assert ROW, KHÔNG chỉ spy. resetRateLimits() mỗi test.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

// ─── observability spy — emission fail-open KHÔNG được gọi trên path chặn ────

vi.mock("@/src/lib/observability", () => ({
  captureError: vi.fn(),
  captureEvent: vi.fn(),
}));

// ─── db.client mock — in-memory (chat-hardening.test.ts pattern) ─────────────

type Row = Record<string, unknown>;

const dbState = vi.hoisted(() => ({
  users: [] as Row[],
  listings: [] as Row[],
  conversations: [] as Row[],
  blocks: [] as Row[],
  suspensions: [] as Row[],
  verifications: [] as Row[],
  memberships: [] as Row[],
  productEvents: [] as Row[],
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
      for (const s of spec) {
        const av = a[s.field] as number;
        const bv = b[s.field] as number;
        const cmp = av === bv ? 0 : av > bv ? 1 : -1;
        if (cmp !== 0) return s.dir === "asc" ? cmp : -cmp;
      }
      return 0;
    });

  const makeModel = (rows: Row[]) => {
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
        const row = { id: `row-${rows.length + 1}`, createdAt: "2026-10-01T00:00:00.000Z", ...data };
        rows.push(row);
        return { ...row };
      },
    });
    return {
      first: (filter?: Pred) => query([], null, null).first(filter),
      where: (pred: Pred) => query([pred], null, null),
      all: () => query([], null, null).all(),
      create: (data: Row) => query([], null, null).create(data),
    };
  };

  return {
    db: {
      orm: {
        public: {
          User: makeModel(dbState.users),
          Listing: makeModel(dbState.listings),
          Conversation: makeModel(dbState.conversations),
          UserBlock: makeModel(dbState.blocks),
          UserSuspension: makeModel(dbState.suspensions),
          // Batch 6 D2 — §7.8 seller-side eligibility (deal.ts đọc FRESH)
          SellerVerification: makeModel(dbState.verifications),
          BetaCohortMembership: makeModel(dbState.memberships),
          // Batch 5 — emit core ghi row THẬT vào mock (key stubbed)
          ProductEvent: makeModel(dbState.productEvents),
        },
      },
    },
  };
});

import { resetRateLimits } from "@/src/lib/rate-limit";
import { startConversationAction } from "@/src/lib/actions/chat";

// ─── Fixtures — Batch 6 verified-seller + approved-listing shape ──────────────

/** Fixture có id kiểu string — truyền thẳng vào action không cần cast. */
type Fixture = Row & { id: string };

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

/** Founding seller thứ hai — đóng vai trò NGƯỜI BẮT ĐẦU hội thoại (case seller). */
const SELLER2: FixtureUser = {
  id: "44444444-4444-4444-8444-444444444444",
  email: "ban2@loaviet.test",
  name: "Người Bán Hai",
  role: "seller",
  avatarUrl: null,
  isVerifiedSeller: true,
  adminRole: null,
  sessionId: "sess-seller2",
};

const LISTING: Fixture = {
  id: "listing-1",
  sellerId: SELLER.id,
  categoryId: "cat-1",
  title: "JBL Charge 5",
  slug: "jbl-charge-5",
  status: "approved",
  provinceLevelCode: "ha-noi",
};

/** Listing thứ hai của seller — KHÔNG có hội thoại nào của buyer (path "tạo mới"). */
const LISTING2: Fixture = {
  id: "listing-2",
  sellerId: SELLER.id,
  categoryId: "cat-1",
  title: "Marshall Stanmore",
  slug: "marshall-stanmore",
  status: "approved",
  provinceLevelCode: "ha-noi",
};

/** Hội thoại CŨ của (LISTING, BUYER) — path redirect branch. */
const CONVO: Fixture = {
  id: "convo-1",
  listingId: LISTING.id,
  buyerId: BUYER.id,
  sellerId: SELLER.id,
  createdAt: "2026-10-01T00:00:00.000Z",
  lastMessageAt: null,
};

/** Seller ĐỦ §7.8 (Batch 4 verified-seller fixture shape — D2). */
const SELLER_VERIFICATION: Fixture = {
  id: "sv-1",
  userId: SELLER.id,
  status: "verified",
  method: "operations_review",
  submittedAt: "2026-10-01T00:00:00.000Z",
  reviewedAt: "2026-10-01T00:00:00.000Z",
  reviewerId: null,
  reasonCode: "requirements_met",
  note: null,
  policyVersion: "v1",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

/** Membership founding_seller active của SELLER (D2 seller-side). */
const SELLER_MEMBERSHIP: Fixture = {
  id: "bcm-seller",
  userId: SELLER.id,
  cohort: "founding_seller",
  status: "active",
  invitedBy: null,
  invitedAt: null,
  acceptedAt: null,
  expiresAt: null,
  notes: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const block = (blockerId: string, blockedId: string): Row => ({
  id: `blk-${blockerId}-${blockedId}`,
  blockerId,
  blockedId,
  createdAt: "2026-10-01T00:00:00.000Z",
});

const suspension = (userId: string): Row => ({
  id: `susp-${userId}`,
  userId,
  status: "active",
  reasonCode: "confirmed_abuse",
  suspendedById: null,
  suspendedAt: "2026-10-01T00:00:00.000Z",
  liftedById: null,
  liftedAt: null,
  liftReasonCode: null,
});

/** Membership của NGƯỜI BẮT ĐẦU hội thoại (buyer-side gate đọc FRESH). */
const buyerMembership = (over: Row = {}): Row => ({
  id: `bcm-buyer-${dbState.memberships.length + 1}`,
  userId: BUYER.id,
  cohort: "private_beta_buyer",
  status: "active",
  invitedBy: null,
  invitedAt: null,
  acceptedAt: null,
  expiresAt: null,
  notes: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...over,
});

const fd = (entries: Record<string, string>): FormData => {
  const form = new FormData();
  for (const [k, v] of Object.entries(entries)) form.set(k, v);
  return form;
};

const login = (user: FixtureUser): void => {
  authState.user = { ...user };
};

const eventsNamed = (name: string): Row[] => dbState.productEvents.filter((e) => e["name"] === name);

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

const seedBase = (): void => {
  dbState.users.length = 0;
  dbState.listings.length = 0;
  dbState.conversations.length = 0;
  dbState.blocks.length = 0;
  dbState.suspensions.length = 0;
  dbState.verifications.length = 0;
  dbState.memberships.length = 0;
  dbState.productEvents.length = 0;
  dbState.users.push({ ...BUYER }, { ...SELLER }, { ...SELLER2 });
  dbState.listings.push({ ...LISTING }, { ...LISTING2 });
  dbState.conversations.push({ ...CONVO });
  // Seller ĐỦ §7.8 mặc định (D2) — happy path/create branch đi qua guard Batch 6.
  dbState.verifications.push({ ...SELLER_VERIFICATION });
  dbState.memberships.push({ ...SELLER_MEMBERSHIP });
  // BUYER KHÔNG có membership mặc định — mỗi case tự seed (gate là đối tượng test).
};

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("PRODUCT_EVENT_PSEUDONYM_KEY", TEST_KEY);
  resetRateLimits();
  seedBase();
  login(BUYER);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── 1/2/3/4 — gate + policy admits participants ─────────────────────────────

describe("startConversationAction — buyer beta access gate (§2.1)", () => {
  it("buyer KHÔNG active membership → BETA_MEMBERSHIP_REQUIRED, KHÔNG Conversation, KHÔNG emit", async () => {
    await expect(startConversationAction(fd({ listingId: LISTING2.id }))).rejects.toThrow(
      "BETA_MEMBERSHIP_REQUIRED",
    );
    expect(dbState.conversations.length).toBe(1); // chỉ convo seed — KHÔNG row mới
    expect(eventsNamed("conversation_started")).toHaveLength(0); // create không chạy → không emit
  });

  it("buyer CÓ active private_beta_buyer → conversation tạo + emission fires (policy cho phép buyer được mời)", async () => {
    dbState.memberships.push(buyerMembership());
    await expect(startConversationAction(fd({ listingId: LISTING2.id }))).rejects.toThrow(
      "NEXT_REDIRECT", // tạo thành công → redirect
    );
    expect(dbState.conversations.length).toBe(2);
    expect(dbState.conversations[1]).toMatchObject({
      listingId: LISTING2.id,
      buyerId: BUYER.id,
      sellerId: SELLER.id,
    });
    // ProductEvent row THẬT trong db mock (key stubbed — KHÔNG chỉ spy)
    expect(eventsNamed("conversation_started")).toHaveLength(1);
  });

  it("founding seller bắt đầu hội thoại (active membership) → allowed (seller cũng là participant)", async () => {
    // SELLER2 (founding seller active) nhắn SELLER — actor có founding_seller
    // active ∈ BETA_CHAT_ALLOWED_COHORTS.
    dbState.memberships.push(
      buyerMembership({ id: "bcm-seller2", userId: SELLER2.id, cohort: "founding_seller" }),
    );
    login(SELLER2);
    await expect(startConversationAction(fd({ listingId: LISTING.id }))).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    expect(dbState.conversations.length).toBe(2);
    expect(dbState.conversations[1]).toMatchObject({
      listingId: LISTING.id,
      buyerId: SELLER2.id,
      sellerId: SELLER.id,
    });
  });

  it("buyer membership founding_seller SUSPENDED → BETA_MEMBERSHIP_REQUIRED (Review Focus 3 — suspended enforced trên chat)", async () => {
    dbState.memberships.push(
      buyerMembership({ id: "bcm-susp", cohort: "founding_seller", status: "suspended" }),
    );
    await expect(startConversationAction(fd({ listingId: LISTING2.id }))).rejects.toThrow(
      "BETA_MEMBERSHIP_REQUIRED",
    );
    expect(dbState.conversations.length).toBe(1);
    expect(eventsNamed("conversation_started")).toHaveLength(0);
  });

  it("buyer membership active nhưng HẾT HẠN → BETA_MEMBERSHIP_REQUIRED (corrections #16)", async () => {
    dbState.memberships.push(
      buyerMembership({ id: "bcm-exp", cohort: "private_beta_buyer", expiresAt: "2020-01-01T00:00:00.000Z" }),
    );
    await expect(startConversationAction(fd({ listingId: LISTING2.id }))).rejects.toThrow(
      "BETA_MEMBERSHIP_REQUIRED",
    );
    expect(dbState.conversations.length).toBe(1);
  });
});

// ─── 5 — guard order: Batch 3 actor → Batch 6 seller → Batch 7 buyer ──────────

describe("startConversationAction — guard order (Batch 3 → Batch 6 → Batch 7)", () => {
  it("pair bị BLOCK mà KHÔNG membership → CHAT_BLOCKED (KHÔNG phải BETA_MEMBERSHIP_REQUIRED)", async () => {
    dbState.blocks.push(block(BUYER.id, SELLER.id));
    await expect(startConversationAction(fd({ listingId: LISTING2.id }))).rejects.toThrow(
      "CHAT_BLOCKED",
    );
    expect(dbState.conversations.length).toBe(1);
  });

  it("initiator bị ĐÌNH CHỈ mà không membership → ACCOUNT_SUSPENDED (Batch 3 actor-side trước)", async () => {
    dbState.suspensions.push(suspension(BUYER.id));
    await expect(startConversationAction(fd({ listingId: LISTING2.id }))).rejects.toThrow(
      "ACCOUNT_SUSPENDED",
    );
    expect(dbState.conversations.length).toBe(1);
  });

  it("suspended-membership SELLER → SELLER_MEMBERSHIP_INACTIVE (Batch 6 D2 fires TRƯỚC buyer gate)", async () => {
    // Buyer KHÔNG có membership — nếu buyer gate chạy TRƯỚC D2 thì lỗi sẽ là
    // BETA_MEMBERSHIP_REQUIRED; pin đúng thứ tự: D2 seller-side TRƯỚC.
    const sellerMembership = dbState.memberships.find((m) => m["userId"] === SELLER.id);
    sellerMembership!["status"] = "suspended";
    await expect(startConversationAction(fd({ listingId: LISTING2.id }))).rejects.toThrow(
      "SELLER_MEMBERSHIP_INACTIVE",
    );
    expect(dbState.conversations.length).toBe(1);
  });
});

// ─── 6 — guard SAU existing-lookup, TRƯỚC Conversation.create (§2.1 creation only) ──

describe("startConversationAction — existing-conversation redirect branch KHÔNG bị gate (§2.1 chỉ chặn CREATION)", () => {
  it("non-member buyer CÓ hội thoại cũ của pair → redirect branch NGUYÊN VẸN (không row mới)", async () => {
    // CONVO seed là hội thoại cũ của (LISTING, BUYER) — buyer không có membership
    // nhưng §2.1 chỉ chặn CREATION: mở lại hội thoại cũ vẫn redirect như cũ.
    await expect(startConversationAction(fd({ listingId: LISTING.id }))).rejects.toThrow(
      "NEXT_REDIRECT:/chat/convo-1",
    );
    expect(dbState.conversations.length).toBe(1); // KHÔNG tạo mới
    expect(eventsNamed("conversation_started")).toHaveLength(0); // redirect branch không emit
  });

  it("non-member buyer KHÔNG có hội thoại → BETA_MEMBERSHIP_REQUIRED, KHÔNG Conversation.create", async () => {
    await expect(startConversationAction(fd({ listingId: LISTING2.id }))).rejects.toThrow(
      "BETA_MEMBERSHIP_REQUIRED",
    );
    expect(
      dbState.conversations.some((c) => c["listingId"] === LISTING2.id),
    ).toBe(false); // không row nào của listing-2
  });
});

// ─── 7 — message trong hội thoại CŨ KHÔNG bị gate (source assertion) ───────────

describe("POST /api/chat/[id] — message KHÔNG bị gate bởi beta policy (§2.1 creation only)", () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const read = (p: string) => readFileSync(`${root}/${p}`, "utf8");

  it("assertBuyerBetaChatAccess vắng mặt ở POST route (source-contract)", () => {
    const src = read("app/api/chat/[id]/route.ts");
    expect(src).not.toContain("assertBuyerBetaChatAccess");
    expect(src).not.toContain("beta-access");
  });
});
