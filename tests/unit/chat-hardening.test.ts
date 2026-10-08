/**
 * Chat hardening — unit tests (Batch 6 plan Task 3, spec §7.1/§7.3/§7.8/§5.8 +
 * corrections 2026-10-08 items 7/8/9/17).
 *
 * Hợp đồng (plan Task 3 Step 1, corrections #7/#9 áp đè):
 *  1. startConversationAction — listing-status gate (D1): mọi giá trị
 *     listing_status NON-approved (draft/pending/rejected/hidden/sold/removed/
 *     archived) → LISTING_NOT_AVAILABLE (corrections #7: code HIỆN CÓ giữ
 *     nguyên — KHÔNG phải LISTING_NOT_CONVERSATIONABLE), KHÔNG tạo Conversation.
 *  2. startConversationAction — §7.8 SELLER-side eligibility (D2, chỉ branch
 *     tạo MỚI): seller bị đình chỉ → SELLER_SUSPENDED; verification revoked →
 *     SELLER_NOT_VERIFIED; membership suspended/expired →
 *     SELLER_MEMBERSHIP_INACTIVE. SUPERSEDE Batch 3 A2 cho NEW chat (spec §9
 *     Batch 6 "suspended/revoked seller checks" — B1; pin gốc bị supersede
 *     sống ở chat-guard.test.ts).
 *  3. Hội thoại CŨ mở lại BẤT KỂ status (redirect branch — KHÔNG check Batch 6,
 *     KHÔNG đốt budget rate limit); block vẫn chặn TRƯỚC redirect (Batch 3).
 *  4. CONVERSATION_START_RATE (§7.1): create thứ 21 trong 10 phút → RATE_LIMITED;
 *     redirect branch KHÔNG tiêu budget.
 *  5. Batch 5 emission sống qua hardening: conversation_started CHỈ trên path
 *     tạo MỚI sau MỌI guard (ProductEvent row THẬT trong db mock — key stubbed,
 *     KHÔNG chỉ spy); guard-rejected → KHÔNG row.
 *  6. POST /api/chat/[id] — body caps (S4): JSON malformed / body.body
 *     non-string / imageUrl non-string → 400 INVALID_BODY (KHÔNG 500);
 *     >2000 ký tự → 400 MESSAGE_TOO_LONG; đúng 2000 → 200.
 *  7. POST imageUrl (S3): chỉ LISTING_IMAGE_URL_PATTERN (/uploads/<uuid>.<ext>)
 *     + ListingImageUpload row ownerUserId === sender; scheme/traversal//img/
 *     ảnh người khác/ảnh rời (row-less) → 400 MESSAGE_IMAGE_INVALID.
 *  8. POST Batch 3 guards giữ nguyên sau edit (block 2 hướng → 403; sender đình
 *     chỉ → 403; tin 31 → 429) + Batch 5 emissions (buyer first message →
 *     conversation_buyer_first_message; seller first reply → message_first_response
 *     với responseMs) + notify D8 (recipient-only, tên sender + preview).
 *  9. GET participant matrix (IDOR + polling auth): 401/404/403/200; read-marking
 *     chỉ update tin CỦA hội thoại này.
 *
 * Cơ chế mock (Global Constraints stubbing recipe): server-only + next/cache +
 * next/navigation (redirect throw) + next/headers + `@/src/lib/auth` fixture +
 * db.client in-memory (User/Listing/Conversation/Message(include sender)/
 * UserBlock/UserSuspension/SellerVerification/BetaCohortMembership/
 * ListingImageUpload/Notification/ProductEvent). `@/src/lib/moderation`,
 * `@/src/lib/deal`, `@/src/lib/rate-limit`, `@/src/lib/listing-images`,
 * `@/src/lib/telemetry-recorders`, `@/src/lib/product-events`, `@/src/lib/notify`
 * GIỮ BẢN THẬT — guard + emission chạy đúng code production đọc store mock;
 * PRODUCT_EVENT_PSEUDONYM_KEY stubbed mỗi beforeEach (row THẬT trong mock);
 * resetRateLimits() mỗi test; observability spy (captureError) — happy path
 * KHÔNG được gọi (bắt mock gap).
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

// observability spy — rejection log KHÔNG BAO GIỀ value/payload (correction #17)
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

// ─── db.client mock — in-memory 11 model (include sender cho GET) ────────────

type Row = Record<string, unknown>;

const dbState = vi.hoisted(() => ({
  users: [] as Row[],
  listings: [] as Row[],
  conversations: [] as Row[],
  messages: [] as Row[],
  blocks: [] as Row[],
  suspensions: [] as Row[],
  verifications: [] as Row[],
  memberships: [] as Row[],
  uploads: [] as Row[],
  notifications: [] as Row[],
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
    typeof pred === "function"
      ? Boolean(pred(fieldOps(row)))
      : Object.entries(pred).every(([k, v]) => row[k] === v);

  const orderBySpec = (cb: (ops: unknown) => unknown): SortSpec => {
    const spec = cb(fieldOps({} as Row));
    return (Array.isArray(spec) ? spec : [spec]) as SortSpec;
  };

  // orderBy nhận MỘT lambda HOẶC array-of-lambdas (queries-postgres.md L153 —
  // route telemetry block dùng array form; mock phải mirror đủ cả hai)
  const orderByArg = (
    cb: ((ops: unknown) => unknown) | Array<(ops: unknown) => unknown>,
  ): SortSpec =>
    Array.isArray(cb)
      ? (cb.map((fn) => fn(fieldOps({} as Row))) as SortSpec)
      : orderBySpec(cb);

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

  /** attach relation `sender` (GET route include) — từ store users. */
  const attachSender = (row: Row): void => {
    if (row.senderId !== undefined) {
      const sender = dbState.users.find((u) => u.id === row.senderId);
      row.sender = sender === undefined ? null : { id: sender.id, name: sender.name };
    }
  };

  const makeModel = (
    rows: Row[],
    attach?: (row: Row) => void,
    defaults?: Row,
  ) => {
    const query = (
      preds: Pred[],
      sortSpec: SortSpec | null,
      limitN: number | null,
    ) => ({
      where: (pred: Pred) => query([...preds, pred], sortSpec, limitN),
      include: (_rel: string, _cb?: unknown) => query(preds, sortSpec, limitN),
      orderBy: (cb: ((ops: unknown) => unknown) | Array<(ops: unknown) => unknown>) =>
        query(preds, orderByArg(cb), limitN),
      limit: (n: number) => query(preds, sortSpec, n),
      first: async (filter?: Pred) => {
        const all = [...preds, ...(filter ? [filter] : [])];
        const hit = rows.find((r) => all.every((p) => matches(r, p)));
        if (hit === undefined) return null;
        const copy = { ...hit };
        attach?.(copy);
        return copy;
      },
      all: async () => {
        let hit = rows.filter((r) => preds.every((p) => matches(r, p)));
        if (sortSpec !== null) hit = sortRows(hit, sortSpec);
        if (limitN !== null) hit = hit.slice(0, limitN);
        return hit.map((r) => {
          const copy = { ...r };
          attach?.(copy);
          return copy;
        });
      },
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
      create: async (data: Row) => {
        // id zero-pad — thứ tự lexicographic == thứ tự insert (tie-break id asc
        // của route telemetry block phụ thuộc điều này)
        const row = {
          id: `row-${String(rows.length + 1).padStart(4, "0")}`,
          createdAt: new Date().toISOString(),
          ...defaults,
          ...data,
        };
        rows.push(row);
        return { ...row };
      },
      delete: async () => {
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
    };
  };

  return {
    db: {
      orm: {
        public: {
          User: makeModel(dbState.users),
          Listing: makeModel(dbState.listings),
          Conversation: makeModel(dbState.conversations),
          Message: makeModel(dbState.messages, attachSender, { imageUrl: null, readAt: null }),
          UserBlock: makeModel(dbState.blocks),
          UserSuspension: makeModel(dbState.suspensions),
          // Batch 6 D2 — §7.8 seller-side eligibility (deal.ts đọc FRESH)
          SellerVerification: makeModel(dbState.verifications),
          BetaCohortMembership: makeModel(dbState.memberships),
          // Batch 4 — chat image ownership (route POST)
          ListingImageUpload: makeModel(dbState.uploads),
          Notification: makeModel(dbState.notifications),
          // Batch 5 — emit core ghi row THẬT vào mock (key stubbed)
          ProductEvent: makeModel(dbState.productEvents),
        },
      },
    },
  };
});

import { resetRateLimits } from "@/src/lib/rate-limit";
import { actorPseudonymFor, sessionPseudonymFor } from "@/src/lib/product-events";
import { captureError } from "@/src/lib/observability";
import { startConversationAction } from "@/src/lib/actions/chat";
import { GET, POST } from "../../app/api/chat/[id]/route";

const captureErrorMock = vi.mocked(captureError);

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** Fixture có id kiểu string — truyền thẳng vào action/route không cần cast. */
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

/** User thứ ba — KHÔNG phải participant của hội thoại nào của cặp trên. */
const THIRD: FixtureUser = {
  id: "33333333-3333-4333-8333-333333333333",
  email: "khac@loaviet.test",
  name: "Người Dùng Khác",
  role: "buyer",
  avatarUrl: null,
  isVerifiedSeller: false,
  adminRole: null,
  sessionId: "sess-third",
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

const CONVO: Fixture = {
  id: "convo-1",
  listingId: LISTING.id,
  buyerId: BUYER.id,
  sellerId: SELLER.id,
  createdAt: "2026-10-01T00:00:00.000Z",
  lastMessageAt: null,
};

/** Seller ĐỦ §7.8 (Batch 4 verified-seller fixture shape — corrections #8). */
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

const SELLER_MEMBERSHIP: Fixture = {
  id: "bcm-1",
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

const seedUpload = (ownerUserId: string, storageKey: string): void => {
  dbState.uploads.push({
    id: `up-${dbState.uploads.length + 1}`,
    ownerUserId,
    storageKey,
    bytes: 1024,
    width: 800,
    height: 600,
    createdAt: "2026-10-01T00:00:00.000Z",
  });
};

const fd = (entries: Record<string, string>): FormData => {
  const form = new FormData();
  for (const [k, v] of Object.entries(entries)) form.set(k, v);
  return form;
};

const login = (user: FixtureUser | null): void => {
  authState.user = user === null ? null : { ...user };
};

/** POST /api/chat/[id] — route invocation TRỰC TIẾP (không qua UI). */
const postJson = (convoId: string, payload: unknown): Promise<Response> =>
  POST(
    new Request(`http://local/api/chat/${convoId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
    { params: Promise.resolve({ id: convoId }) } as unknown as Parameters<typeof POST>[1],
  );

/** POST /api/chat/[id] với body THÔ (không JSON.stringify) — case malformed. */
const postRawBody = (convoId: string, raw: string): Promise<Response> =>
  POST(
    new Request(`http://local/api/chat/${convoId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw,
    }),
    { params: Promise.resolve({ id: convoId }) } as unknown as Parameters<typeof POST>[1],
  );

/** GET /api/chat/[id] — route invocation TRỰC TIẾP. */
const getMessages = (convoId: string): Promise<Response> =>
  GET(
    new Request(`http://local/api/chat/${convoId}`),
    { params: Promise.resolve({ id: convoId }) } as unknown as Parameters<typeof GET>[1],
  );

const eventsNamed = (name: string): Row[] =>
  dbState.productEvents.filter((e) => e["name"] === name);

const setListingStatus = (listingId: string, status: string): void => {
  const row = dbState.listings.find((l) => l["id"] === listingId);
  if (row == null) throw new Error(`listing ${listingId} chưa seed`);
  row["status"] = status;
};

const setVerificationStatus = (status: string): void => {
  const row = dbState.verifications.find((v) => v["userId"] === SELLER.id);
  if (row == null) throw new Error("SellerVerification chưa seed");
  row["status"] = status;
};

const setMembership = (over: Row): void => {
  const row = dbState.memberships.find((m) => m["userId"] === SELLER.id);
  if (row == null) throw new Error("BetaCohortMembership chưa seed");
  Object.assign(row, over);
};

const seedBase = (): void => {
  dbState.users.length = 0;
  dbState.listings.length = 0;
  dbState.conversations.length = 0;
  dbState.messages.length = 0;
  dbState.blocks.length = 0;
  dbState.suspensions.length = 0;
  dbState.verifications.length = 0;
  dbState.memberships.length = 0;
  dbState.uploads.length = 0;
  dbState.notifications.length = 0;
  dbState.productEvents.length = 0;
  dbState.users.push({ ...BUYER }, { ...SELLER }, { ...THIRD });
  dbState.listings.push({ ...LISTING }, { ...LISTING2 });
  dbState.conversations.push({ ...CONVO });
  dbState.verifications.push({ ...SELLER_VERIFICATION });
  dbState.memberships.push({ ...SELLER_MEMBERSHIP });
};

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("PRODUCT_EVENT_PSEUDONYM_KEY", TEST_KEY);
  resetRateLimits();
  seedBase();
  login(BUYER);
  captureErrorMock.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── startConversationAction — D1 listing-status + D2 seller eligibility ─────

describe("startConversationAction — listing-status gate (D1) + §7.8 seller-side (D2)", () => {
  it("mọi giá trị listing_status NON-approved → LISTING_NOT_AVAILABLE, KHÔNG Conversation (D1 — table-driven)", async () => {
    // ĐÚNG MỌI giá trị enum trừ "approved" (drift-guard: giá trị mới thêm vào
    // listing_status sau này phải được thêm vào bảng này)
    for (const status of ["draft", "pending", "rejected", "hidden", "sold", "removed", "archived"]) {
      setListingStatus(LISTING2.id, status);
      await expect(startConversationAction(fd({ listingId: LISTING2.id }))).rejects.toThrow(
        "LISTING_NOT_AVAILABLE",
      );
      expect(dbState.conversations.length).toBe(1); // chỉ convo seed — KHÔNG tạo mới
    }
  });

  it("seller verification REVOKED → SELLER_NOT_VERIFIED, KHÔNG Conversation, KHÔNG emit (D2 — §7.8 revocation)", async () => {
    setVerificationStatus("revoked");
    await expect(startConversationAction(fd({ listingId: LISTING2.id }))).rejects.toThrow(
      "SELLER_NOT_VERIFIED",
    );
    expect(dbState.conversations.length).toBe(1);
    expect(eventsNamed("conversation_started")).toHaveLength(0);
  });

  it("seller membership SUSPENDED → SELLER_MEMBERSHIP_INACTIVE (D2 — §7.8 beta-membership)", async () => {
    setMembership({ status: "suspended" });
    await expect(startConversationAction(fd({ listingId: LISTING2.id }))).rejects.toThrow(
      "SELLER_MEMBERSHIP_INACTIVE",
    );
    expect(dbState.conversations.length).toBe(1);
    expect(eventsNamed("conversation_started")).toHaveLength(0);
  });

  it("seller membership EXPIRED → SELLER_MEMBERSHIP_INACTIVE (corrections #6 — hết hạn = inactive)", async () => {
    setMembership({ expiresAt: "2020-01-01T00:00:00.000Z" });
    await expect(startConversationAction(fd({ listingId: LISTING2.id }))).rejects.toThrow(
      "SELLER_MEMBERSHIP_INACTIVE",
    );
    expect(dbState.conversations.length).toBe(1);
  });

  it("seller (counterpart) bị ĐÌNH CHỈ → SELLER_SUSPENDED, KHÔNG Conversation (D2 — SUPERSEDE Batch 3 A2 cho NEW chat, spec §9 Batch 6)", async () => {
    // Batch 3 A2 pin "counterpart suspended → vẫn tạo" bị SUPERSEDE bởi spec
    // §9 Batch 6 "suspended/revoked seller checks" — CHỈ cho hội thoại MỚI
    // (B1; pin gốc rewrite ở chat-guard.test.ts). Message trong hội thoại CŨ
    // không bị ảnh hưởng (case POST bên dưới).
    dbState.suspensions.push(suspension(SELLER.id));
    await expect(startConversationAction(fd({ listingId: LISTING2.id }))).rejects.toThrow(
      "SELLER_SUSPENDED",
    );
    expect(dbState.conversations.length).toBe(1);
    expect(eventsNamed("conversation_started")).toHaveLength(0);
  });

  it("hội thoại CŨ trên listing đã sold → VẪN redirect (reopen ≠ new chat — check Batch 6 chỉ ở create branch)", async () => {
    setListingStatus(LISTING.id, "sold");
    await expect(startConversationAction(fd({ listingId: LISTING.id }))).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    expect(dbState.conversations.length).toBe(1); // KHÔNG tạo mới
  });

  it("cặp bị BLOCK (Batch 3 guard) → CHAT_BLOCKED, KHÔNG Conversation, KHÔNG emit (guard trước mọi check Batch 6)", async () => {
    dbState.blocks.push(block(BUYER.id, SELLER.id));
    await expect(startConversationAction(fd({ listingId: LISTING2.id }))).rejects.toThrow(
      "CHAT_BLOCKED",
    );
    expect(dbState.conversations.length).toBe(1);
    expect(eventsNamed("conversation_started")).toHaveLength(0);
  });

  it("happy path vẫn tạo Conversation + emit conversation_started (Batch 5 emission sống qua hardening — row THẬT)", async () => {
    await expect(startConversationAction(fd({ listingId: LISTING2.id }))).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    expect(dbState.conversations.length).toBe(2);
    expect(dbState.conversations[1]).toMatchObject({
      listingId: LISTING2.id,
      buyerId: BUYER.id,
      sellerId: SELLER.id,
    });

    // ProductEvent row THẬT trong db mock (key stubbed — KHÔNG chỉ spy)
    const evt = eventsNamed("conversation_started")[0]!;
    expect(evt["conversationId"]).toBe(dbState.conversations[1]!["id"]);
    expect(evt["listingId"]).toBe(LISTING2.id);
    expect(evt["provinceCode"]).toBe("ha-noi");
    // pseudonym — KHÔNG BAO GIỜ raw buyer id trong row (S-10)
    expect(evt["actorPseudonym"]).toBe(actorPseudonymFor(BUYER.id));
    expect(evt["sessionPseudonym"]).toBe(sessionPseudonymFor(BUYER.sessionId));
    expect(JSON.stringify(evt)).not.toContain(BUYER.id);
    expect(captureErrorMock).not.toHaveBeenCalled(); // emission KHÔNG fail-open
  });
});

// ─── startConversationAction — CONVERSATION_START_RATE (§7.1) ────────────────

describe("startConversationAction — rate limit hội thoại mới (§7.1)", () => {
  it("create thứ 21 trong 10 phút → RATE_LIMITED, KHÔNG Conversation", async () => {
    for (let i = 1; i <= 21; i++) {
      dbState.listings.push({
        ...LISTING2,
        id: `listing-rate-${i}`,
        slug: `rate-${i}`,
      });
    }
    for (let i = 1; i <= 20; i++) {
      await expect(startConversationAction(fd({ listingId: `listing-rate-${i}` }))).rejects.toThrow(
        "NEXT_REDIRECT",
      );
    }
    expect(dbState.conversations.length).toBe(21); // seed + 20

    await expect(startConversationAction(fd({ listingId: "listing-rate-21" }))).rejects.toThrow(
      "RATE_LIMITED",
    );
    expect(dbState.conversations.length).toBe(21); // KHÔNG row mới
    expect(
      dbState.conversations.some((c) => c["listingId"] === "listing-rate-21"),
    ).toBe(false);
  });

  it("branch redirect (hội thoại cũ) KHÔNG tiêu budget rate limit (limit sống ở create branch)", async () => {
    // 25 lượt mở lại hội thoại cũ (> limit 20) — KHÔNG bao giờ RATE_LIMITED
    for (let i = 0; i < 25; i++) {
      await expect(startConversationAction(fd({ listingId: LISTING.id }))).rejects.toThrow(
        "NEXT_REDIRECT",
      );
    }
    // budget chưa bị đốt: create MỚI vẫn được phép ngay sau 25 lượt redirect
    await expect(startConversationAction(fd({ listingId: LISTING2.id }))).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    expect(dbState.conversations.length).toBe(2);
  });
});

// ─── POST /api/chat/[id] — body caps (S4) + imageUrl validation (S3) ─────────

describe("POST /api/chat/[id] — body caps + imageUrl validation (S3/S4)", () => {
  it("body dài hơn CHAT_MESSAGE_MAX_LENGTH → 400 MESSAGE_TOO_LONG, KHÔNG Message", async () => {
    const res = await postJson(CONVO.id, { body: "x".repeat(2001) });
    expect(res.status).toBe(400);
    expect(await (res.json() as Promise<{ error: string }>)).toMatchObject({
      error: "MESSAGE_TOO_LONG",
    });
    expect(dbState.messages.length).toBe(0);
  });

  it("body đúng 2000 ký tự → 200, Message tạo (bound inclusive — client maxLength chỉ là UX)", async () => {
    const res = await postJson(CONVO.id, { body: "x".repeat(2000) });
    expect(res.status).toBe(200);
    expect(dbState.messages.length).toBe(1);
  });

  it("JSON malformed → 400 INVALID_BODY, KHÔNG Message (S4 — request.json() không thành 500)", async () => {
    const res = await postRawBody(CONVO.id, "{not json");
    expect(res.status).toBe(400);
    expect(await (res.json() as Promise<{ error: string }>)).toMatchObject({
      error: "INVALID_BODY",
    });
    expect(dbState.messages.length).toBe(0);
  });

  it("body.body non-string (number) → 400 INVALID_BODY, KHÔNG Message", async () => {
    const res = await postJson(CONVO.id, { body: 123 });
    expect(res.status).toBe(400);
    expect(await (res.json() as Promise<{ error: string }>)).toMatchObject({
      error: "INVALID_BODY",
    });
    expect(dbState.messages.length).toBe(0);
  });

  it("imageUrl non-string (number) → 400 INVALID_BODY, KHÔNG Message", async () => {
    const res = await postJson(CONVO.id, { body: "xem ảnh", imageUrl: 123 });
    expect(res.status).toBe(400);
    expect(await (res.json() as Promise<{ error: string }>)).toMatchObject({
      error: "INVALID_BODY",
    });
    expect(dbState.messages.length).toBe(0);
  });

  it("imageUrl scheme/traversal//img → 400 MESSAGE_IMAGE_INVALID, KHÔNG Message (S3 — chỉ /uploads/<uuid>.<ext>)", async () => {
    for (const url of [
      "https://evil/x.gif", // scheme https
      "javascript:alert(1)", // scheme javascript
      "/../../etc", // traversal
      "/img/listings/x.jpg", // /img KHÔNG được chấp nhận (S3 — không allowance)
    ]) {
      const res = await postJson(CONVO.id, { body: "xem ảnh", imageUrl: url });
      expect(res.status).toBe(400);
      expect(await (res.json() as Promise<{ error: string }>)).toMatchObject({
        error: "MESSAGE_IMAGE_INVALID",
      });
      expect(dbState.messages.length).toBe(0);
    }
  });

  it("imageUrl /uploads/<uuid>.webp của user KHÁC → 400 MESSAGE_IMAGE_INVALID (cross-account image theft — Batch 4 rule 1)", async () => {
    seedUpload(THIRD.id, "33333333-3333-4333-8333-333333333333.webp");
    const res = await postJson(CONVO.id, {
      body: "ảnh của người khác",
      imageUrl: "/uploads/33333333-3333-4333-8333-333333333333.webp",
    });
    expect(res.status).toBe(400);
    expect(await (res.json() as Promise<{ error: string }>)).toMatchObject({
      error: "MESSAGE_IMAGE_INVALID",
    });
    expect(dbState.messages.length).toBe(0);
  });

  it("imageUrl /uploads/<uuid>.webp KHÔNG có ListingImageUpload row → 400 MESSAGE_IMAGE_INVALID (upload rời — fail closed)", async () => {
    const res = await postJson(CONVO.id, {
      body: "ảnh không tồn tại",
      imageUrl: "/uploads/55555555-5555-4555-8555-555555555555.webp",
    });
    expect(res.status).toBe(400);
    expect(await (res.json() as Promise<{ error: string }>)).toMatchObject({
      error: "MESSAGE_IMAGE_INVALID",
    });
    expect(dbState.messages.length).toBe(0);
  });

  it("imageUrl /uploads/<uuid>.webp do CHÍNH sender upload → 200, Message với imageUrl", async () => {
    seedUpload(BUYER.id, "44444444-4444-4444-8444-444444444444.webp");
    const res = await postJson(CONVO.id, {
      body: "ảnh của tôi",
      imageUrl: "/uploads/44444444-4444-4444-8444-444444444444.webp",
    });
    expect(res.status).toBe(200);
    expect(dbState.messages.length).toBe(1);
    expect(dbState.messages[0]!["imageUrl"]).toBe(
      "/uploads/44444444-4444-4444-8444-444444444444.webp",
    );
  });
});

// ─── POST — Batch 3 guards giữ nguyên + Batch 5 emissions + notify D8 ─────────

describe("POST /api/chat/[id] — Batch 3 guards + Batch 5 emissions + notify (giữ nguyên sau edit)", () => {
  it("block THEO BẤT KỀ hướng nào → 403 CHAT_BLOCKED, KHÔNG Message (Batch 3 re-pin)", async () => {
    dbState.blocks.push(block(BUYER.id, SELLER.id));
    const asBlocker = await postJson(CONVO.id, { body: "bên chặn vẫn cố gửi" });
    expect(asBlocker.status).toBe(403);
    expect(await (asBlocker.json() as Promise<{ error: string }>)).toMatchObject({
      error: "CHAT_BLOCKED",
    });

    login(SELLER);
    const asBlocked = await postJson(CONVO.id, { body: "bên bị chặn cũng cố gửi" });
    expect(asBlocked.status).toBe(403);
    expect(await (asBlocked.json() as Promise<{ error: string }>)).toMatchObject({
      error: "CHAT_BLOCKED",
    });
    expect(dbState.messages.length).toBe(0);
  });

  it("sender bị đình chỉ → 403 ACCOUNT_SUSPENDED, KHÔNG Message (Batch 3 re-pin)", async () => {
    dbState.suspensions.push(suspension(BUYER.id));
    const res = await postJson(CONVO.id, { body: "bị đình chỉ vẫn thử gửi" });
    expect(res.status).toBe(403);
    expect(await (res.json() as Promise<{ error: string }>)).toMatchObject({
      error: "ACCOUNT_SUSPENDED",
    });
    expect(dbState.messages.length).toBe(0);
  });

  it("recipient bị đình chỉ → VẪN gửi được (A2 — D2 KHÔNG với tới message trong hội thoại cũ)", async () => {
    dbState.suspensions.push(suspension(SELLER.id));
    const res = await postJson(CONVO.id, { body: "gửi cho người đang bị đình chỉ" });
    expect(res.status).toBe(200);
    expect(dbState.messages.length).toBe(1);
  });

  it("send rate limit: tin thứ 31 trong một phút → 429 + Retry-After, KHÔNG Message (Batch 3 §7.1 re-pin)", async () => {
    for (let i = 0; i < 30; i++) {
      const res = await postJson(CONVO.id, { body: `tin số ${i + 1}` });
      expect(res.status).toBe(200);
    }
    expect(dbState.messages.length).toBe(30);

    const denied = await postJson(CONVO.id, { body: "tin thứ 31" });
    expect(denied.status).toBe(429);
    expect(denied.headers.get("Retry-After")).toBeTruthy();
    expect(dbState.messages.length).toBe(30);
  });

  it("buyer gửi tin ĐẦU TIÊN → ProductEvent conversation_buyer_first_message (Batch 5 emission sống qua hardening)", async () => {
    const res = await postJson(CONVO.id, { body: "chào bạn, còn hàng không?" });
    expect(res.status).toBe(200);

    const evt = eventsNamed("conversation_buyer_first_message")[0]!;
    expect(evt["conversationId"]).toBe(CONVO.id);
    expect(evt["listingId"]).toBe(LISTING.id);
    expect(evt["actorPseudonym"]).toBe(actorPseudonymFor(BUYER.id));
    expect(JSON.stringify(evt)).not.toContain(BUYER.id);
    expect(captureErrorMock).not.toHaveBeenCalled();
  });

  it("seller trả lời ĐẦU sau tin buyer → ProductEvent message_first_response với responseMs (Batch 5 re-pin)", async () => {
    login(BUYER);
    const buyerMsg = await postJson(CONVO.id, { body: "tin của buyer" });
    expect(buyerMsg.status).toBe(200);

    login(SELLER);
    const sellerMsg = await postJson(CONVO.id, { body: "tin của seller" });
    expect(sellerMsg.status).toBe(200);

    const evt = eventsNamed("message_first_response")[0]!;
    expect(evt["conversationId"]).toBe(CONVO.id);
    expect(evt["actorPseudonym"]).toBe(actorPseudonymFor(SELLER.id));
    const responseMs = evt["metadata"] as Record<string, unknown> | null;
    expect(responseMs).not.toBeNull();
    expect(typeof responseMs!["responseMs"]).toBe("number");
    expect(responseMs!["responseMs"] as number).toBeGreaterThanOrEqual(0);
    expect(captureErrorMock).not.toHaveBeenCalled();
  });

  it("notify đến ĐÚNG recipient với tên sender + preview + link (D8 — KHÔNG notification cho sender)", async () => {
    const res = await postJson(CONVO.id, { body: "chào bạn, còn hàng không?" });
    expect(res.status).toBe(200);

    expect(dbState.notifications.length).toBe(1);
    const notif = dbState.notifications[0]!;
    expect(notif["userId"]).toBe(SELLER.id); // recipient — KHÔNG phải sender
    expect(notif["kind"]).toBe("chat");
    expect(notif["title"]).toBe(`Tin nhắn mới từ ${BUYER.name}`);
    expect(notif["body"]).toBe("chào bạn, còn hàng không?");
    expect(notif["link"]).toBe(`/chat/${CONVO.id}`);
    expect(dbState.notifications.some((n) => n["userId"] === BUYER.id)).toBe(false);
  });
});

// ─── GET /api/chat/[id] — participant matrix (IDOR + polling auth) ────────────

describe("GET /api/chat/[id] — participant matrix + read-marking", () => {
  it("401 chưa đăng nhập / 404 thiếu / 403 non-participant / 200 participant (IDOR + polling auth)", async () => {
    dbState.messages.push({
      id: "msg-seed-1",
      conversationId: CONVO.id,
      senderId: SELLER.id,
      body: "tin cũ",
      imageUrl: null,
      readAt: null,
      createdAt: "2026-10-01T00:00:00.000Z",
    });

    // 401 — chưa đăng nhập
    login(null);
    const unauth = await getMessages(CONVO.id);
    expect(unauth.status).toBe(401);

    // 404 — hội thoại không tồn tại
    login(BUYER);
    const missing = await getMessages("convo-khong-ton-tai");
    expect(missing.status).toBe(404);

    // 403 — user thứ ba KHÔNG phải participant
    login(THIRD);
    const forbidden = await getMessages(CONVO.id);
    expect(forbidden.status).toBe(403);

    // 200 — buyer participant đọc được
    login(BUYER);
    const ok = await getMessages(CONVO.id);
    expect(ok.status).toBe(200);
    const json = (await ok.json()) as { messages: Array<{ body: string }> };
    expect(json.messages.some((m) => m.body === "tin cũ")).toBe(true);
  });

  it("read-marking chỉ update tin CỦA hội thoại này (participant-only write)", async () => {
    // hội thoại thứ hai (buyer THIRD) — tin của SELLER cũng đang unread
    dbState.conversations.push({
      id: "convo-2",
      listingId: LISTING2.id,
      buyerId: THIRD.id,
      sellerId: SELLER.id,
      createdAt: "2026-10-01T00:00:00.000Z",
      lastMessageAt: null,
    });
    dbState.messages.push({
      id: "msg-a",
      conversationId: CONVO.id,
      senderId: SELLER.id,
      body: "tin của hội thoại 1",
      imageUrl: null,
      readAt: null,
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    dbState.messages.push({
      id: "msg-b",
      conversationId: "convo-2",
      senderId: SELLER.id,
      body: "tin của hội thoại 2",
      imageUrl: null,
      readAt: null,
      createdAt: "2026-10-01T00:00:00.000Z",
    });

    const res = await getMessages(CONVO.id);
    expect(res.status).toBe(200);

    const a = dbState.messages.find((m) => m["id"] === "msg-a")!;
    const b = dbState.messages.find((m) => m["id"] === "msg-b")!;
    expect(a["readAt"]).not.toBeNull(); // tin của hội thoại đang mở → đã đọc
    expect(b["readAt"]).toBeNull(); // tin hội thoại KHÁC → KHÔNG bị đụng
  });
});
