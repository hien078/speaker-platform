/**
 * Chat hardening — integration tests (Batch 6 plan Task 3, spec §7.1/§7.3/§7.8 +
 * corrections 2026-10-08 items 7/8/9/17) — chạy trên scratch DB
 * (scripts/test-integration.sh: container riêng + `prisma db migrate --to
 * production` + dọn). KHÔNG chạy trong `npm test`.
 *
 * Unit tests (tests/unit/chat-hardening.test.ts) chứng minh logic với db mock;
 * ở đây chứng minh CÙNG hợp đồng against DB THẬT với module THẬT (session,
 * auth, moderation guards, deal §7.8 seller-side guard, rate limit,
 * startConversationAction, route handlers):
 *
 *  1. Listing-status + seller-eligibility enforced FRESH từ DB: verified+active
 *     seller + approved listing → tạo hội thoại; flip listing sold/draft →
 *     LISTING_NOT_AVAILABLE; revoke SellerVerification → SELLER_NOT_VERIFIED;
 *     suspend seller (UserSuspension) → SELLER_SUSPENDED; suspend
 *     founding_seller membership → SELLER_MEMBERSHIP_INACTIVE; restore từng
 *     thứ → tạo lại được (D1/D2 — đọc FRESH mỗi action, KHÔNG cache).
 *  2. Hội thoại CŨ trên listing đã sold vẫn MỞ LẠI (redirect branch — lịch sử
 *     chat không chết); hội thoại MỚI trên listing đó bị từ chối.
 *  3. POST caps against DB thật: body over-length → 400 KHÔNG row; ảnh
 *     /uploads/<uuid> của user KHÁC → 400 KHÔNG row (cross-account theft);
 *     ảnh do CHÍNH sender upload → message tạo với imageUrl (S3/S4).
 *  4. GET participant matrix against DB thật: 401/404/403/200 (IDOR + polling
 *     auth — spec §7.3).
 *
 * Wishlist KHÔNG ở đây — b4-holistic-2 đã harden `toggleWishlistAction`
 * (corrections #17), pin tại tests/unit/wishlist-actions.test.ts.
 *
 * `next/headers` mock (cookie store điều khiển được — createSession cần
 * cookies() ngoài request scope) + `next/navigation` mock (redirect throw);
 * phần DB/session/auth/moderation/deal/rate-limit là thật toàn bộ.
 * Telemetry fail-open NGOÀI production: test-integration.sh chỉ set
 * DATABASE_URL → emission là silent no-op (corrections #25) — row
 * ProductEvent KHÔNG được tạo, KHÔNG cần dọn.
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
import { SESSION_COOKIE, createSession } from "../../src/lib/session";
import { resetRateLimits } from "../../src/lib/rate-limit";
import { startConversationAction } from "../../src/lib/actions/chat";
import { GET, POST } from "../../app/api/chat/[id]/route";

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

let seq = 0;
const uid = () => `b6-chat-${Date.now()}-${seq++}`;

async function mkUser(role: "buyer" | "seller"): Promise<string> {
  const u = await db.orm.public.User.create({
    email: `${uid()}@integration.test`,
    passwordHash: "x",
    name: `B6 ${role} ${seq}`,
    role,
  });
  created.users.push(u.id);
  return u.id;
}

/** Seller đủ §7.8 (D2): SellerVerification verified + founding_seller active. */
async function seedSellerEligibility(sellerId: string): Promise<void> {
  await db.orm.public.SellerVerification.create({
    userId: sellerId,
    status: "verified",
    method: "operations_review",
    policyVersion: "v1",
  });
  await db.orm.public.BetaCohortMembership.create({
    userId: sellerId,
    cohort: "founding_seller",
    status: "active",
  });
}

/**
 * Buyer là active beta participant (B7 Task 6 fixture migration — corrections
 * #17): create branch của startConversationAction giờ thêm guard buyer-side
 * (assertBuyerBetaChatAccess — §2.1) SAU guard D2. Membership cascade theo
 * user nên cleanup afterEach (delete user) dọn cả row này.
 */
async function seedBuyerMembership(buyerId: string): Promise<void> {
  await db.orm.public.BetaCohortMembership.create({
    userId: buyerId,
    cohort: "private_beta_buyer",
    status: "active",
  });
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
const postJson = (convoId: string, payload: unknown): Promise<Response> =>
  POST(
    new Request(`http://local/api/chat/${convoId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof payload === "string" ? payload : JSON.stringify(payload),
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
// UserSuspension.user là Restrict → xóa suspension TRƯỚC user;
// SellerVerification.user KHÔNG có onDelete (Restrict) → xóa TRƯỚC user
// (corrections #8); BetaCohortMembership/Notification/ListingImageUpload/
// UserSession cascade theo user; Conversation/Message/Listing cascade theo
// thứ tự xóa dưới đây.
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
    // Restrict FKs trước user: SellerVerification (không onDelete) — membership
    // + notification + upload + session cascade.
    await db.orm.public.SellerVerification.where({ userId: id }).delete();
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
  vi.stubEnv("AUTH_SECRET", "integration-test-auth-secret-0123456789abcdef");
  resetRateLimits();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── 1. Listing-status + seller-eligibility FRESH từ DB (D1/D2) ───────────────

d("chat hardening trên DB thật (Batch 6 Task 3 — D1/D2/§7.1/S3/S4)", () => {
  it("listing-status + seller-eligibility enforced fresh từ DB — flip từng thứ → typed error; restore → mở lại", async () => {
    const buyer = await mkUser("buyer");
    const buyer2 = await mkUser("buyer"); // chưa có hội thoại — path "tạo mới"
    const seller = await mkUser("seller");
    await seedSellerEligibility(seller);
    await seedBuyerMembership(buyer); // B7 Task 6 migration — guard §2.1 buyer-side
    await seedBuyerMembership(buyer2); // B7 Task 6 migration — guard §2.1 buyer-side
    const listing = await mkListing(seller); // approved
    const buyerTok = await loginAs(buyer);
    const buyer2Tok = await loginAs(buyer2);

    // happy path: tạo hội thoại MỚI (redirect sau create)
    setSession(buyerTok);
    await expect(startConversationAction(fd({ listingId: listing }))).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    expect(
      await db.orm.public.Conversation.where({ listingId: listing, buyerId: buyer }).first(),
    ).not.toBeNull();

    // flip listing → sold: buyer (đã có hội thoại) vẫn MỞ LẠI được (redirect
    // branch — lịch sử không chết); buyer2 (chưa có) bị từ chối
    await db.orm.public.Listing.where({ id: listing }).update({ status: "sold" });
    setSession(buyerTok);
    await expect(startConversationAction(fd({ listingId: listing }))).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    setSession(buyer2Tok);
    await expect(startConversationAction(fd({ listingId: listing }))).rejects.toThrow(
      "LISTING_NOT_AVAILABLE",
    );
    expect(
      await db.orm.public.Conversation.where({ listingId: listing, buyerId: buyer2 }).first(),
    ).toBeNull();

    // flip → draft: cũng từ chối (mọi giá trị non-approved)
    await db.orm.public.Listing.where({ id: listing }).update({ status: "draft" });
    await expect(startConversationAction(fd({ listingId: listing }))).rejects.toThrow(
      "LISTING_NOT_AVAILABLE",
    );
    await db.orm.public.Listing.where({ id: listing }).update({ status: "approved" });

    // revoke SellerVerification → SELLER_NOT_VERIFIED (§7.8 revocation — D2)
    await db.orm.public.SellerVerification.where({ userId: seller }).update({ status: "revoked" });
    setSession(buyer2Tok);
    await expect(startConversationAction(fd({ listingId: listing }))).rejects.toThrow(
      "SELLER_NOT_VERIFIED",
    );
    await db.orm.public.SellerVerification.where({ userId: seller }).update({ status: "verified" });

    // suspend seller (UserSuspension active) → SELLER_SUSPENDED (§7.8 suspension —
    // D2; thứ tự guard: suspension thắng verification/membership)
    const susp = await db.orm.public.UserSuspension.create({
      userId: seller,
      status: "active",
      reasonCode: "confirmed_abuse",
    });
    created.suspensions.push(susp.id);
    await expect(startConversationAction(fd({ listingId: listing }))).rejects.toThrow(
      "SELLER_SUSPENDED",
    );
    await db.orm.public.UserSuspension.where({ id: susp.id }).update({
      status: "lifted",
      liftedAt: new Date().toISOString(),
      liftReasonCode: "other_reviewed_reason",
    });

    // suspend founding_seller membership → SELLER_MEMBERSHIP_INACTIVE (§7.8
    // beta-membership — D2)
    await db.orm.public.BetaCohortMembership
      .where({ userId: seller, cohort: "founding_seller" })
      .update({ status: "suspended" });
    await expect(startConversationAction(fd({ listingId: listing }))).rejects.toThrow(
      "SELLER_MEMBERSHIP_INACTIVE",
    );
    await db.orm.public.BetaCohortMembership
      .where({ userId: seller, cohort: "founding_seller" })
      .update({ status: "active" });

    // restore từng thứ → tạo lại được (đọc FRESH mỗi action — KHÔNG cache)
    setSession(buyer2Tok);
    await expect(startConversationAction(fd({ listingId: listing }))).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    const newConvo = await db.orm.public.Conversation
      .where({ listingId: listing, buyerId: buyer2 })
      .first();
    expect(newConvo).not.toBeNull();
    created.conversations.push(newConvo!.id);
  });

  // ─── 2. POST caps against DB thật (S3/S4) ─────────────────────────────────

  it("POST caps trên DB thật: over-length → 400 không row; ảnh người khác → 400 không row; ảnh của sender → message tạo", async () => {
    const buyer = await mkUser("buyer");
    const seller = await mkUser("seller");
    const other = await mkUser("buyer"); // chủ upload "ảnh người khác"
    const listing = await mkListing(seller);
    const convo = await mkConversation(listing, buyer, seller);
    const buyerTok = await loginAs(buyer);
    setSession(buyerTok);

    // body over-length → 400 MESSAGE_TOO_LONG, KHÔNG row
    const tooLong = await postJson(convo, { body: "x".repeat(2001) });
    expect(tooLong.status).toBe(400);
    expect(await (tooLong.json() as Promise<{ error: string }>)).toMatchObject({
      error: "MESSAGE_TOO_LONG",
    });
    expect(await messageCount(convo)).toBe(0);

    // JSON malformed → 400 INVALID_BODY (S4 — không 500)
    const malformed = await postJson(convo, "{not json");
    expect(malformed.status).toBe(400);
    expect(await (malformed.json() as Promise<{ error: string }>)).toMatchObject({
      error: "INVALID_BODY",
    });
    expect(await messageCount(convo)).toBe(0);

    // ảnh /uploads/<uuid>.webp của user KHÁC → 400 MESSAGE_IMAGE_INVALID (cross-account theft)
    const foreignKey = `${crypto.randomUUID()}.webp`;
    await db.orm.public.ListingImageUpload.create({
      ownerUserId: other,
      storageKey: foreignKey,
      bytes: 1024,
      width: 800,
      height: 600,
    });
    const foreign = await postJson(convo, { body: "ảnh", imageUrl: `/uploads/${foreignKey}` });
    expect(foreign.status).toBe(400);
    expect(await (foreign.json() as Promise<{ error: string }>)).toMatchObject({
      error: "MESSAGE_IMAGE_INVALID",
    });
    expect(await messageCount(convo)).toBe(0);

    // ảnh do CHÍNH sender upload → message tạo với imageUrl
    const ownKey = `${crypto.randomUUID()}.webp`;
    await db.orm.public.ListingImageUpload.create({
      ownerUserId: buyer,
      storageKey: ownKey,
      bytes: 1024,
      width: 800,
      height: 600,
    });
    const ok = await postJson(convo, { body: "ảnh của tôi", imageUrl: `/uploads/${ownKey}` });
    expect(ok.status).toBe(200);
    expect(await messageCount(convo)).toBe(1);
    const msg = await db.orm.public.Message.where({ conversationId: convo }).first();
    expect(msg!.imageUrl).toBe(`/uploads/${ownKey}`);
  });

  // ─── 3. GET participant matrix against DB thật (IDOR + polling auth) ───────

  it("GET participant matrix trên DB thật: 401 / 404 / 403 / 200", async () => {
    const buyer = await mkUser("buyer");
    const seller = await mkUser("seller");
    const third = await mkUser("buyer"); // non-participant
    const listing = await mkListing(seller);
    const convo = await mkConversation(listing, buyer, seller);
    await db.orm.public.Message.create({
      conversationId: convo,
      senderId: seller,
      body: "tin cũ",
    });

    // 401 — chưa đăng nhập (KHÔNG session cookie)
    cookieState.store.clear();
    const unauth = await getMessages(convo);
    expect(unauth.status).toBe(401);

    // 404 — hội thoại không tồn tại
    const buyerTok = await loginAs(buyer);
    setSession(buyerTok);
    const missing = await getMessages("00000000-0000-0000-0000-000000000000");
    expect(missing.status).toBe(404);

    // 403 — user thứ ba KHÔNG phải participant (IDOR — spec §7.3)
    const thirdTok = await loginAs(third);
    setSession(thirdTok);
    const forbidden = await getMessages(convo);
    expect(forbidden.status).toBe(403);

    // 200 — participant đọc được lịch sử
    setSession(buyerTok);
    const ok = await getMessages(convo);
    expect(ok.status).toBe(200);
    const json = (await ok.json()) as { messages: Array<{ body: string }> };
    expect(json.messages.some((m) => m.body === "tin cũ")).toBe(true);
  });
});
