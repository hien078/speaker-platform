/**
 * Block enforcement — integration tests (Batch 3 plan Task 3, spec §5.5 +
 * §7.8 actor-side + §7.1) — chạy trên scratch DB (scripts/test-integration.sh:
 * container riêng + `prisma db migrate --to production` + dọn). KHÔNG chạy
 * trong `npm test`.
 *
 * Unit tests (tests/unit/block-actions.test.ts, tests/unit/chat-guard.test.ts)
 * chứng minh logic với db mock; ở đây chứng minh CÙNG hợp đồng against DB
 * THẬT với module THẬT (session, auth, moderation guards, rate limit,
 * blockUserAction/unblockUserAction, startConversationAction, route handlers):
 *
 *  1. Block chặn hội thoại MỚI + tin nhắn THEO CẢ HAI hướng; unblock mở lại
 *     cả hai; GET vẫn đọc lịch sử (spec §5.5 — không silent deletion).
 *  2. Suspension chặn initiator/sender MỖI ACTION với session CÒN SỐNG
 *     (P1/A2: không revoke session — guard đọc FRESH từ DB mỗi action);
 *     counterpart bị đình chỉ vẫn NHẬN tin (actor-side minimal set);
 *     lift → mở lại toàn bộ.
 *  3. Blocking KHÔNG xóa/mutate Conversation/Message — row counts + bodies
 *     deep-equal trước/sau block+unblock (spec §5.5 — evidence/history intact).
 *
 * `next/headers` mock (cookie store điều khiển được — createSession cần
 * cookies() ngoài request scope) + `next/navigation` mock (redirect throw);
 * phần DB/session/auth/moderation/rate-limit là thật toàn bộ.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

// ─── Cookie store điều khiển được (next/headers) — session THẬT ──────────────

const cookieState = vi.hoisted(() => ({ store: new Map<string, string>() }));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers()),
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
}));

import { db } from "../../src/prisma/db.client";
import { SESSION_COOKIE, createSession, getSessionFromCookie } from "../../src/lib/session";
import { resetRateLimits } from "../../src/lib/rate-limit";
import { blockUserAction, unblockUserAction } from "../../src/lib/actions/blocks";
import { startConversationAction } from "../../src/lib/actions/chat";
import { GET, POST } from "../../app/api/chat/[id]/route";

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

let seq = 0;
const uid = () => `b3-blk-${Date.now()}-${seq++}`;

async function mkUser(role: "buyer" | "seller"): Promise<string> {
  const u = await db.orm.public.User.create({
    email: `${uid()}@integration.test`,
    passwordHash: "x",
    name: `B3 ${role} ${seq}`,
    role,
  });
  created.users.push(u.id);
  return u.id;
}

async function mkListing(sellerId: string): Promise<string> {
  const cat = await db.orm.public.Category.create({
    name: `Danh mục ${uid()}`,
    slug: `cat-${uid()}`,
  });
  created.categories.push(cat.id);
  const l = await db.orm.public.Listing.create({
    sellerId,
    categoryId: cat.id,
    title: `Loa ${uid()}`,
    slug: `loa-${uid()}`,
    description: "integration test",
    condition: "good",
    price: 1_000_000,
    status: "approved",
    city: "Hà Nội",
  });
  created.listings.push(l.id);
  return l.id;
}

async function mkConversation(listingId: string, buyerId: string, sellerId: string): Promise<string> {
  const c = await db.orm.public.Conversation.create({ listingId, buyerId, sellerId });
  created.conversations.push(c.id);
  return c.id;
}

async function mkMessage(conversationId: string, senderId: string, body: string): Promise<string> {
  const m = await db.orm.public.Message.create({ conversationId, senderId, body });
  return m.id;
}

/** Session THẬT cho user — trả token cookie để switch giữa các user. */
async function loginAs(userId: string): Promise<string> {
  await createSession(userId);
  const token = cookieState.store.get(SESSION_COOKIE);
  if (!token) throw new Error("createSession không set cookie (mock next/headers?)");
  return token;
}

const setSession = (token: string): void => {
  cookieState.store.set(SESSION_COOKIE, token);
};

const fd = (entries: Record<string, string>): FormData => {
  const form = new FormData();
  for (const [k, v] of Object.entries(entries)) form.set(k, v);
  return form;
};

/** POST /api/chat/[id] — route invocation TRỰC TIẾP. */
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

async function messageCount(convoId: string): Promise<number> {
  const agg = await db.orm.public.Message
    .where({ conversationId: convoId })
    .aggregate((a) => ({ c: a.count() }));
  return agg.c;
}

// dọn đúng dữ liệu test mình tạo (DB scratch — nhưng vẫn dọn sạch theo ref).
// UserSuspension.user là Restrict → xóa suspension TRƯỚC user; còn lại cascade.
const created = {
  users: [] as string[],
  categories: [] as string[],
  listings: [] as string[],
  conversations: [] as string[],
  suspensions: [] as string[],
};

afterEach(async () => {
  for (const id of created.suspensions) {
    await db.orm.public.UserSuspension.where({ id }).delete();
  }
  for (const id of created.conversations) {
    await db.orm.public.Conversation.where({ id }).delete();
  }
  for (const id of created.listings) {
    await db.orm.public.Listing.where({ id }).delete();
  }
  for (const id of created.categories) {
    await db.orm.public.Category.where({ id }).delete();
  }
  for (const id of created.users) {
    await db.orm.public.User.where({ id }).delete();
  }
  created.suspensions.length = 0;
  created.conversations.length = 0;
  created.listings.length = 0;
  created.categories.length = 0;
  created.users.length = 0;
  cookieState.store.clear();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  resetRateLimits();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── 1. Block hai hướng + unblock + GET lịch sử ──────────────────────────────

d("block enforcement trên DB thật", () => {
  it("block chặn hội thoại mới + tin nhắn CẢ HAI hướng; unblock mở lại; GET vẫn đọc lịch sử", async () => {
    const buyer = await mkUser("buyer");
    const seller = await mkUser("seller");
    const listing = await mkListing(seller); // có sẵn hội thoại
    const listing2 = await mkListing(seller); // chưa có hội thoại — path "mới"
    const convo = await mkConversation(listing, buyer, seller);
    await mkMessage(convo, seller, "tin cũ trước khi bị chặn");

    const buyerTok = await loginAs(buyer);
    const sellerTok = await loginAs(seller);

    // block qua ACTION THẬT (buyer chặn seller)
    setSession(buyerTok);
    await blockUserAction(fd({ userId: seller }));
    const blk = await db.orm.public.UserBlock.where({ blockerId: buyer, blockedId: seller }).first();
    expect(blk).not.toBeNull();

    // hội thoại MỚI bị chặn — kể cả khi đã có hội thoại cũ trên listing khác
    // (guard chạy trước existing-lookup: KHÔNG redirect vào hội thoại chết)
    await expect(startConversationAction(fd({ listingId: listing }))).rejects.toThrow(
      "CHAT_BLOCKED",
    );
    await expect(startConversationAction(fd({ listingId: listing2 }))).rejects.toThrow(
      "CHAT_BLOCKED",
    );
    expect(
      await db.orm.public.Conversation.where({ listingId: listing2, buyerId: buyer }).first(),
    ).toBeNull();

    // tin nhắn bị chặn CẢ HAI hướng (block buyer→seller: buyer là blocker,
    // seller là người bị chặn — spec §5.5 "either direction")
    setSession(buyerTok);
    const buyerRes = await postMessage(convo, "bên chặn vẫn không gửi được");
    expect(buyerRes.status).toBe(403);
    expect(await (buyerRes.json() as Promise<{ error: string }>)).toMatchObject({
      error: "CHAT_BLOCKED",
    });

    setSession(sellerTok);
    const sellerRes = await postMessage(convo, "bên bị chặn cũng không gửi được");
    expect(sellerRes.status).toBe(403);
    expect(await (sellerRes.json() as Promise<{ error: string }>)).toMatchObject({
      error: "CHAT_BLOCKED",
    });
    expect(await messageCount(convo)).toBe(1); // chỉ tin seed — không tin mới

    // GET vẫn đọc được lịch sử (spec §5.5 — không silent deletion)
    setSession(buyerTok);
    const got = await getMessages(convo);
    expect(got.status).toBe(200);
    const history = (await got.json()) as { messages: Array<{ body: string }> };
    expect(history.messages.some((m) => m.body === "tin cũ trước khi bị chặn")).toBe(true);

    // unblock qua ACTION THẬT → mọi thứ mở lại
    setSession(buyerTok);
    await unblockUserAction(fd({ userId: seller }));
    expect(
      await db.orm.public.UserBlock.where({ blockerId: buyer, blockedId: seller }).first(),
    ).toBeNull();

    setSession(buyerTok);
    const okBuyer = await postMessage(convo, "sau khi bỏ chặn");
    expect(okBuyer.status).toBe(200);

    setSession(sellerTok);
    const okSeller = await postMessage(convo, "seller cũng gửi lại được");
    expect(okSeller.status).toBe(200);

    setSession(buyerTok);
    await expect(startConversationAction(fd({ listingId: listing2 }))).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    const newConvo = await db.orm.public.Conversation
      .where({ listingId: listing2, buyerId: buyer })
      .first();
    expect(newConvo).not.toBeNull();
    created.conversations.push(newConvo!.id);
  });

  // ─── 2. Suspension — actor-side, session còn sống (P1/A2) ──────────────────

  it("suspension chặn initiator/sender MỖI ACTION với session còn sống; counterpart bị đình chỉ vẫn nhận tin; lift mở lại", async () => {
    const buyer = await mkUser("buyer");
    const seller = await mkUser("seller");
    const listing2 = await mkListing(seller);
    const listing3 = await mkListing(seller);
    const convo = await mkConversation(listing2, buyer, seller);

    const buyerTok = await loginAs(buyer);

    // đình chỉ buyer TRỰC TIẾP (suspendUserAction thuộc Task 5)
    const susp = await db.orm.public.UserSuspension.create({
      userId: buyer,
      status: "active",
      reasonCode: "confirmed_abuse",
    });
    created.suspensions.push(susp.id);

    // session VẪN SỐNG (P1 — Batch 3 KHÔNG revoke session): getSessionFromCookie
    // non-null, nhưng guard đọc FRESH từ DB mỗi action → vẫn chặn
    setSession(buyerTok);
    expect(await getSessionFromCookie()).not.toBeNull();

    await expect(startConversationAction(fd({ listingId: listing3 }))).rejects.toThrow(
      "ACCOUNT_SUSPENDED",
    );
    expect(
      await db.orm.public.Conversation.where({ listingId: listing3, buyerId: buyer }).first(),
    ).toBeNull();

    const denied = await postMessage(convo, "bị đình chỉ vẫn thử gửi");
    expect(denied.status).toBe(403);
    expect(await (denied.json() as Promise<{ error: string }>)).toMatchObject({
      error: "ACCOUNT_SUSPENDED",
    });
    expect(await messageCount(convo)).toBe(0);

    // lift (qua db — liftSuspensionAction thuộc Task 5) → chat mở lại
    await db.orm.public.UserSuspension.where({ id: susp.id }).update({
      status: "lifted",
      liftedAt: new Date().toISOString(),
      liftReasonCode: "other_reviewed_reason",
    });
    setSession(buyerTok);
    const afterLift = await postMessage(convo, "sau khi được gỡ đình chỉ");
    expect(afterLift.status).toBe(200);

    // counterpart bị đình chỉ KHÔNG chặn người gửi (A2 — actor-side minimal
    // set: chỉ initiator/sender được check)
    const suspSeller = await db.orm.public.UserSuspension.create({
      userId: seller,
      status: "active",
      reasonCode: "confirmed_spam",
    });
    created.suspensions.push(suspSeller.id);
    setSession(buyerTok);
    const delivered = await postMessage(convo, "gửi cho người đang bị đình chỉ");
    expect(delivered.status).toBe(200);
    expect(await messageCount(convo)).toBe(2);
  });

  // ─── 3. Blocking không phá Conversation/Message (spec §5.5) ────────────────

  it("block KHÔNG xóa/mutate Conversation/Message — rows deep-equal trước/sau block+unblock", async () => {
    const buyer = await mkUser("buyer");
    const seller = await mkUser("seller");
    const listing = await mkListing(seller);
    const convo = await mkConversation(listing, buyer, seller);
    await mkMessage(convo, buyer, "tin của buyer");
    await mkMessage(convo, seller, "tin của seller");

    const snapshot = async () => {
      const c = await db.orm.public.Conversation.where({ id: convo }).first();
      const msgs = await db.orm.public.Message
        .where({ conversationId: convo })
        .orderBy((m) => m.createdAt.asc())
        .all();
      return {
        conversation:
          c === null
            ? null
            : {
                id: c.id,
                listingId: c.listingId,
                buyerId: c.buyerId,
                sellerId: c.sellerId,
                createdAt: c.createdAt,
                lastMessageAt: c.lastMessageAt,
              },
        messages: msgs.map((m) => ({
          id: m.id,
          senderId: m.senderId,
          body: m.body,
          imageUrl: m.imageUrl,
          readAt: m.readAt,
          createdAt: m.createdAt,
        })),
      };
    };

    const before = await snapshot();
    expect(before.conversation).not.toBeNull();
    expect(before.messages.length).toBe(2);

    const buyerTok = await loginAs(buyer);
    setSession(buyerTok);
    await blockUserAction(fd({ userId: seller }));
    expect(await snapshot()).toEqual(before);

    await unblockUserAction(fd({ userId: seller }));
    expect(await snapshot()).toEqual(before);
  });
});
