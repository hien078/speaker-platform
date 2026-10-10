/**
 * Chat/conversation enforcement guards — unit tests (Batch 3 plan Task 3,
 * spec §5.5 block + §7.8 suspension actor-side + §7.1 send rate limit).
 *
 * Review Focus 1 (blocked-user chat bypass via direct API call): guard phải
 * sống trong ACTION/ROUTE — KHÔNG phải chỉ trong composer disabled. Mọi case
 * dưới đây gọi TRỰC TIẾP startConversationAction / POST /api/chat/[id] /
 * GET /api/chat/[id] (route invocation, không qua UI).
 *
 * Hợp đồng (plan Task 3 Step 1):
 *  1. startConversationAction + block THEO BẤT KỂ hướng nào → CHAT_BLOCKED,
 *     KHÔNG tạo Conversation (chặn cả khi đã có hội thoại cũ — guard chạy
 *     TRƯỚC existing-conversation lookup).
 *  2. startConversationAction + initiator BỊ ĐÌNH CHỈ → ACCOUNT_SUSPENDED,
 *     không Conversation (spec §7.8 actor-side).
 *  3. startConversationAction + counterpart (seller) bị đình chỉ → VẪN tạo
 *     Conversation (A2 — counterpart-side KHÔNG nằm trong §7.8 minimal set,
 *     pinned là intentionally absent).
 *  4. Happy path vẫn tạo Conversation (guard không over-block).
 *  5. POST + block hai hướng → 403 CHAT_BLOCKED, không Message.
 *  6. POST + sender bị đình chỉ → 403 ACCOUNT_SUSPENDED, không Message;
 *     POST + recipient bị đình chỉ → VẪN gửi (A2).
 *  7. POST send rate limit 30/phút/user (spec §7.1 "chat") — tin thứ 31 →
 *     429 + Retry-After, không Message.
 *  8. POST happy path vẫn tạo Message + cập nhật lastMessageAt.
 *  9. GET vẫn trả lịch sử cho cặp bị chặn (spec §5.5 — không silent deletion).
 *
 * Cơ chế mock (Global Constraints stubbing recipe): server-only + next/cache +
 * next/navigation (redirect throw) + next/headers + `@/src/lib/auth` fixture +
 * db.client in-memory (User/Listing/Conversation/Message(include sender)/
 * UserBlock/UserSuspension/Notification). `@/src/lib/moderation` (guards) và
 * `@/src/lib/rate-limit` GIỮ BẢN THẬT — guard chạy đúng code production đọc
 * store mock; resetRateLimits() mỗi test.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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

// ─── db.client mock — in-memory 7 model (include sender cho GET) ─────────────

type Row = Record<string, unknown>;

const dbState = vi.hoisted(() => ({
  users: [] as Row[],
  listings: [] as Row[],
  conversations: [] as Row[],
  messages: [] as Row[],
  blocks: [] as Row[],
  suspensions: [] as Row[],
  notifications: [] as Row[],
  /**
   * Khi ≠ null: MỌI read trên UserBlock/UserSuspension (model của moderation
   * guard) ném Error(message) — mô phỏng lỗi DB/infra nổ ra TRONG guard, dùng
   * cho hợp đồng "route KHÔNG đúm bọc lỗi infra thành 403 / KHÔNG leak message".
   */
  guardDbError: null as string | null,
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

  const makeModel = (rows: Row[], attach?: (row: Row) => void, fail?: () => string | null) => {
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
        const errMsg = fail?.() ?? null;
        if (errMsg !== null) throw new Error(errMsg);
        const all = [...preds, ...(filter ? [filter] : [])];
        const hit = rows.find((r) => all.every((p) => matches(r, p)));
        if (hit === undefined) return null;
        const copy = { ...hit };
        attach?.(copy);
        return copy;
      },
      all: async () => {
        const errMsg = fail?.() ?? null;
        if (errMsg !== null) throw new Error(errMsg);
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
        const row = { id: `row-${rows.length + 1}`, createdAt: "2026-10-01T00:00:00.000Z", ...data };
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
          Message: makeModel(dbState.messages, attachSender),
          // Model của moderation guard — fail() móc lỗi DB/infra mô phỏng
          UserBlock: makeModel(dbState.blocks, undefined, () => dbState.guardDbError),
          UserSuspension: makeModel(dbState.suspensions, undefined, () => dbState.guardDbError),
          Notification: makeModel(dbState.notifications),
        },
      },
    },
  };
});

import { resetRateLimits } from "@/src/lib/rate-limit";
import { startConversationAction } from "@/src/lib/actions/chat";
import { GET, POST } from "../../app/api/chat/[id]/route";

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

const LISTING: Fixture = {
  id: "listing-1",
  sellerId: SELLER.id,
  categoryId: "cat-1",
  title: "JBL Charge 5",
  slug: "jbl-charge-5",
  status: "approved",
};

/** Listing thứ hai của seller — KHÔNG có hội thoại nào của buyer (path "tạo mới"). */
const LISTING2: Fixture = {
  id: "listing-2",
  sellerId: SELLER.id,
  categoryId: "cat-1",
  title: "Marshall Stanmore",
  slug: "marshall-stanmore",
  status: "approved",
};

const CONVO: Fixture = {
  id: "convo-1",
  listingId: LISTING.id,
  buyerId: BUYER.id,
  sellerId: SELLER.id,
  createdAt: "2026-10-01T00:00:00.000Z",
  lastMessageAt: null,
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

const fd = (entries: Record<string, string>): FormData => {
  const form = new FormData();
  for (const [k, v] of Object.entries(entries)) form.set(k, v);
  return form;
};

const login = (user: FixtureUser): void => {
  authState.user = { ...user };
};

/** POST /api/chat/[id] — route invocation TRỰC TIẾP (không qua UI). */
const postMessage = (convoId: string, body: string): Promise<Response> =>
  POST(
    new Request(`http://local/api/chat/${convoId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    }),
    { params: Promise.resolve({ id: convoId }) } as unknown as Parameters<typeof POST>[1],
  );

/** GET /api/chat/[id] — route invocation TRỰC TIẾP. */
const getMessages = (convoId: string): Promise<Response> =>
  GET(
    new Request(`http://local/api/chat/${convoId}`),
    { params: Promise.resolve({ id: convoId }) } as unknown as Parameters<typeof GET>[1],
  );

const seedBase = (): void => {
  dbState.users.length = 0;
  dbState.listings.length = 0;
  dbState.conversations.length = 0;
  dbState.messages.length = 0;
  dbState.blocks.length = 0;
  dbState.suspensions.length = 0;
  dbState.notifications.length = 0;
  dbState.guardDbError = null;
  dbState.users.push({ ...BUYER }, { ...SELLER });
  dbState.listings.push({ ...LISTING }, { ...LISTING2 });
  dbState.conversations.push({ ...CONVO });
};

beforeEach(() => {
  resetRateLimits();
  seedBase();
  login(BUYER);
});

// ─── startConversationAction — guard hội thoại MỚI (spec §5.5/§7.8) ──────────

describe("startConversationAction — block hai hướng + đình chỉ actor-side", () => {
  it("buyer→seller block → CHAT_BLOCKED, KHÔNG tạo Conversation (Review Focus 1)", async () => {
    dbState.blocks.push(block(BUYER.id, SELLER.id));
    await expect(startConversationAction(fd({ listingId: LISTING.id }))).rejects.toThrow(
      "CHAT_BLOCKED",
    );
    expect(dbState.conversations.length).toBe(1); // chỉ convo seed — không row mới
  });

  it("seller→buyer block (initiator là người BỊ chặn) → CŨNG CHAT_BLOCKED (enforcement đối xứng)", async () => {
    dbState.blocks.push(block(SELLER.id, BUYER.id));
    await expect(startConversationAction(fd({ listingId: LISTING.id }))).rejects.toThrow(
      "CHAT_BLOCKED",
    );
    expect(dbState.conversations.length).toBe(1);
  });

  it("block + đã có hội thoại cũ → VẪN CHAT_BLOCKED (guard chạy TRƯỚC existing-lookup, không redirect vào hội thoại chết)", async () => {
    // CONVO seed chính là hội thoại cũ của (listing-1, buyer) — nếu guard đặt
    // SAU existing-lookup thì action đã redirect (NEXT_REDIRECT) thay vì chặn.
    dbState.blocks.push(block(BUYER.id, SELLER.id));
    await expect(startConversationAction(fd({ listingId: LISTING.id }))).rejects.toThrow(
      "CHAT_BLOCKED",
    );
  });

  it("initiator BỊ ĐÌNH CHỈ → ACCOUNT_SUSPENDED, không Conversation (spec §7.8 actor)", async () => {
    dbState.suspensions.push(suspension(BUYER.id));
    await expect(startConversationAction(fd({ listingId: LISTING.id }))).rejects.toThrow(
      "ACCOUNT_SUSPENDED",
    );
    expect(dbState.conversations.length).toBe(1);
  });

  it("counterpart (seller) bị đình chỉ → VẪN tạo Conversation (A2 — counterpart-side không thuộc §7.8 minimal set)", async () => {
    dbState.suspensions.push(suspension(SELLER.id));
    // redirect() throw NEXT_REDIRECT — hội thoại ĐÃ tạo trước đó
    await expect(startConversationAction(fd({ listingId: LISTING2.id }))).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    expect(dbState.conversations.length).toBe(2);
    expect(dbState.conversations[1]).toMatchObject({
      listingId: LISTING2.id,
      buyerId: BUYER.id,
      sellerId: SELLER.id,
    });
  });

  it("happy path vẫn tạo Conversation (guard không over-block)", async () => {
    await expect(startConversationAction(fd({ listingId: LISTING2.id }))).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    expect(dbState.conversations.length).toBe(2);
    expect(dbState.conversations[1]).toMatchObject({
      listingId: LISTING2.id,
      buyerId: BUYER.id,
      sellerId: SELLER.id,
    });
  });
});

// ─── b4-holistic round-3 — hội thoại MỚI chỉ cho listing APPROVED (chat leak) ──

describe("startConversationAction — status gate hội thoại mới (b4-holistic round-3)", () => {
  /** Đổi status listing TRONG dbState (seed là COPY của fixture — mutate fixture không ăn). */
  const setStatus = (listingId: string, status: string): void => {
    const row = dbState.listings.find((l) => l["id"] === listingId);
    if (row == null) throw new Error(`listing ${listingId} chưa seed`);
    row["status"] = status;
  };

  it("listing PENDING (seller edit in-place) → LISTING_NOT_AVAILABLE, KHÔNG tạo Conversation", async () => {
    setStatus(LISTING2.id, "pending");
    await expect(startConversationAction(fd({ listingId: LISTING2.id }))).rejects.toThrow(
      "LISTING_NOT_AVAILABLE",
    );
    expect(dbState.conversations.length).toBe(1); // chỉ convo seed
  });

  it("listing REMOVED (moderation takedown) → LISTING_NOT_AVAILABLE, KHÔNG tạo Conversation", async () => {
    setStatus(LISTING2.id, "removed");
    await expect(startConversationAction(fd({ listingId: LISTING2.id }))).rejects.toThrow(
      "LISTING_NOT_AVAILABLE",
    );
    expect(dbState.conversations.length).toBe(1);
  });

  it("hội thoại CŨ mở lại BẤT KỂ status (lịch sử chat vẫn đọc được — redirect working)", async () => {
    // CONVO seed là hội thoại cũ của (listing-1, buyer); listing-1 bị takedown
    // sau khi buyer đã chat — redirect vào hội thoại cũ vẫn chạy.
    setStatus(LISTING.id, "removed");
    await expect(startConversationAction(fd({ listingId: LISTING.id }))).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    expect(dbState.conversations.length).toBe(1); // KHÔNG tạo mới
  });

  it("approved → tạo Conversation bình thường (gate không over-block)", async () => {
    setStatus(LISTING2.id, "approved");
    await expect(startConversationAction(fd({ listingId: LISTING2.id }))).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    expect(dbState.conversations.length).toBe(2);
  });
});

// ─── POST /api/chat/[id] — guard tin nhắn (spec §5.5/§7.8) ────────────────────

describe("POST /api/chat/[id] — block hai hướng + đình chỉ sender-side", () => {
  it("block THEO BẤT KỂ hướng nào → 403 CHAT_BLOCKED, không Message (Review Focus 1)", async () => {
    dbState.blocks.push(block(BUYER.id, SELLER.id));

    // buyer gửi (buyer là blocker)
    login(BUYER);
    const asBlocker = await postMessage(CONVO.id as string, "xin chào");
    expect(asBlocker.status).toBe(403);
    expect(await (asBlocker.json() as Promise<{ error: string }>)).toMatchObject({
      error: "CHAT_BLOCKED",
    });

    // seller gửi (seller là người BỊ chặn) — enforcement đối xứng
    login(SELLER);
    const asBlocked = await postMessage(CONVO.id as string, "vẫn cố gửi");
    expect(asBlocked.status).toBe(403);
    expect(await (asBlocked.json() as Promise<{ error: string }>)).toMatchObject({
      error: "CHAT_BLOCKED",
    });

    expect(dbState.messages.length).toBe(0);
  });

  it("sender BỊ ĐÌNH CHỈ → 403 ACCOUNT_SUSPENDED, không Message", async () => {
    dbState.suspensions.push(suspension(BUYER.id));
    login(BUYER);
    const res = await postMessage(CONVO.id as string, "bị đình chỉ vẫn thử gửi");
    expect(res.status).toBe(403);
    expect(await (res.json() as Promise<{ error: string }>)).toMatchObject({
      error: "ACCOUNT_SUSPENDED",
    });
    expect(dbState.messages.length).toBe(0);
  });

  it("recipient bị đình chỉ → VẪN gửi được (A2 — actor-side minimal set)", async () => {
    dbState.suspensions.push(suspension(SELLER.id));
    login(BUYER);
    const res = await postMessage(CONVO.id as string, "gửi cho người bị đình chỉ");
    expect(res.status).toBe(200);
    expect(dbState.messages.length).toBe(1);
  });

  it("send rate limit: tin thứ 31 trong một phút → 429 + Retry-After, không Message (spec §7.1)", async () => {
    login(BUYER);
    for (let i = 0; i < 30; i++) {
      const res = await postMessage(CONVO.id as string, `tin số ${i + 1}`);
      expect(res.status).toBe(200);
    }
    expect(dbState.messages.length).toBe(30);

    const denied = await postMessage(CONVO.id as string, "tin thứ 31");
    expect(denied.status).toBe(429);
    expect(denied.headers.get("Retry-After")).toBeTruthy();
    expect(dbState.messages.length).toBe(30); // không Message nào được tạo thêm
  });

  it("lỗi DB/infra TRONG guard → rethrow, KHÔNG đúm bọc 403, KHÔNG leak message (review fix)", async () => {
    // Guard read (UserSuspension/UserBlock) ném lỗi infra — route PHẢI rethrow
    // để Next trả 500 + observability bắt, KHÔNG trả 403 kèm message nội bộ.
    dbState.guardDbError = "ECONNRESET: connection terminated";
    login(BUYER);
    await expect(postMessage(CONVO.id as string, "chào")).rejects.toThrow(
      "ECONNRESET: connection terminated",
    );
    expect(dbState.messages.length).toBe(0); // không Message nào được tạo
  });

  it("happy path vẫn tạo Message + cập nhật lastMessageAt", async () => {
    login(BUYER);
    const res = await postMessage(CONVO.id as string, "chào bạn, còn hàng không?");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; id: string };
    expect(json.ok).toBe(true);

    expect(dbState.messages.length).toBe(1);
    expect(dbState.messages[0]).toMatchObject({
      conversationId: CONVO.id,
      senderId: BUYER.id,
      body: "chào bạn, còn hàng không?",
    });
    expect(dbState.conversations[0]!.lastMessageAt).not.toBeNull();
  });
});

// ─── GET /api/chat/[id] — lịch sử vẫn đọc được khi blocked (spec §5.5) ────────

describe("GET /api/chat/[id] — lịch sử đọc được cho cặp bị chặn", () => {
  it("block hai hướng → GET vẫn 200 + trả messages (không silent deletion)", async () => {
    dbState.messages.push({
      id: "msg-1",
      conversationId: CONVO.id,
      senderId: SELLER.id,
      body: "tin cũ trước khi bị chặn",
      imageUrl: null,
      readAt: null,
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    dbState.blocks.push(block(BUYER.id, SELLER.id));

    login(BUYER);
    const res = await getMessages(CONVO.id as string);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { messages: Array<{ body: string }> };
    expect(json.messages.length).toBe(1);
    expect(json.messages[0]!.body).toBe("tin cũ trước khi bị chặn");
  });
});
