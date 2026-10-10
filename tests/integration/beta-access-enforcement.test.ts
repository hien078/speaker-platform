/**
 * Buyer beta access enforcement — integration tests (Batch 7 plan Task 6 —
 * spec §2.1 buyer beta access policy + §7.8 beta-membership status; C2 Deal
 * wiring; §8.4 admin operation path) — chạy trên scratch DB
 * (scripts/test-integration.sh: container riêng + `prisma db migrate --to
 * production` + dọn). KHÔNG chạy trong `npm test`.
 *
 * Unit tests (tests/unit/beta-access.test.ts, chat-beta-gate.test.ts,
 * deal-beta-gate.test.ts) chứng minh logic với db mock; ở đây chứng minh CÙNG
 * hợp đồng against DB THẬT với module THẬT (session, auth, moderation guards,
 * rate limit, startConversationAction, createDealAction,
 * markDealOutcomeAction, setBetaMembershipAction của Batch 2):
 *
 *  1. §2.1 gate end-to-end: non-member buyer KHÔNG start conversation được
 *     trên listing approved sống; private_beta_buyer member CÓ.
 *  2. C2 end-to-end: non-member buyer KHÔNG tạo Deal được; member CÓ.
 *  3. Suspending membership (qua ACTION Batch 2 — setBetaMembershipAction,
 *     ops fixture) chặn hội thoại MỚI + Deal MỚI NGAY LẬP TỨC (guard đọc
 *     FRESH từ DB mỗi call — Review Focus 3).
 *  4. Deal ĐANG MỞ vẫn mark được sau khi membership bị suspend (Batch 6
 *     D10/D2 — marking gate theo actor suspension + block, KHÔNG theo beta
 *     membership; blocking a member's confirmation would strand the
 *     bilateral record).
 *  5. Re-grant active (admin operation §8.4) mở lại truy cập NGAY.
 *
 * `next/headers` mock (cookie store điều khiển được — createSession cần
 * cookies() ngoài request scope) + `next/navigation` mock (redirect throw);
 * phần DB/session/auth/moderation/rate-limit/beta-access là thật toàn bộ.
 * AUTH_SECRET (hkdfKey "ip-hash" của auditEvent) + PRODUCT_EVENT_PSEUDONYM_KEY
 * (emit core) stub trong beforeAll — mọi emission path đều chạy được.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
import { createDealAction, markDealOutcomeAction } from "../../src/lib/actions/deals";
import { setBetaMembershipAction } from "../../src/lib/actions/beta-cohort";

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

/** Key test hợp lệ — base64 của đúng 32 byte (product-events.test.ts pattern). */
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

let seq = 0;
const uid = () => `b7-ba-${Date.now()}-${seq++}`;

async function mkUser(role: "buyer" | "seller" | "admin", over?: { adminRole?: string }): Promise<string> {
  const u = await db.orm.public.User.create({
    email: `${uid()}@integration.test`,
    passwordHash: "x",
    name: `B7 BA ${role} ${seq}`,
    role,
    ...(over?.adminRole ? { adminRole: over.adminRole as "operations_admin" } : {}),
  });
  created.users.push(u.id);
  return u.id;
}

/** Seller đủ §7.8 (D2 — Batch 6 verified-seller shape): verified + founding_seller active. */
async function seedSellerEligibility(sellerId: string): Promise<void> {
  const sv = await db.orm.public.SellerVerification.create({
    userId: sellerId,
    status: "verified",
    method: "operations_review",
    policyVersion: "v1",
  });
  created.sellerVerifications.push(sv.id);
  const mem = await db.orm.public.BetaCohortMembership.create({
    userId: sellerId,
    cohort: "founding_seller",
    status: "active",
  });
  created.betaMemberships.push(mem.id);
}

/** Buyer là active beta participant (§2.1) — row thật, track để dọn. */
async function seedBuyerMembership(buyerId: string, status: "active" | "suspended" = "active"): Promise<void> {
  const mem = await db.orm.public.BetaCohortMembership.create({
    userId: buyerId,
    cohort: "private_beta_buyer",
    status,
  });
  created.betaMemberships.push(mem.id);
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
    description: "integration test batch 7 task 6",
    condition: "good",
    price: 1_800_000,
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
async function loginAs(userId: string, opts?: { isAdmin?: boolean }): Promise<string> {
  await createSession(userId, opts);
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

// dọn đúng dữ liệu test mình tạo (DB scratch — nhưng vẫn dọn sạch theo ref),
// thứ tự ngược FK: ProductEvent (no FK) → Deal (DealStatusHistory Cascade) →
// Conversation → Listing → Category → SellerVerification (user Restrict) →
// BetaCohortMembership → AuditEvent (SetNull theo actor/subject) → User
// (Notification/UserSession Cascade theo user).
const created = {
  users: [] as string[],
  categories: [] as string[],
  listings: [] as string[],
  conversations: [] as string[],
  deals: [] as string[],
  sellerVerifications: [] as string[],
  betaMemberships: [] as string[],
};

afterEach(async () => {
  // ProductEvent do emit core THẬT ghi — mọi event của fixture này mang listingId
  for (const listingId of created.listings) {
    await db.orm.public.ProductEvent.where({ listingId }).deleteAll();
  }
  for (const id of created.deals) {
    await db.orm.public.Deal.where({ id }).deleteAll();
  }
  for (const id of created.conversations) {
    await db.orm.public.Conversation.where({ id }).deleteAll();
  }
  for (const id of created.listings) {
    await db.orm.public.Listing.where({ id }).deleteAll();
  }
  for (const id of created.categories) {
    await db.orm.public.Category.where({ id }).deleteAll();
  }
  for (const id of created.sellerVerifications) {
    await db.orm.public.SellerVerification.where({ id }).deleteAll();
  }
  for (const id of created.betaMemberships) {
    await db.orm.public.BetaCohortMembership.where({ id }).deleteAll();
  }
  for (const id of created.users) {
    await db.orm.public.AuditEvent.where({ actorId: id }).deleteAll();
    await db.orm.public.AuditEvent.where({ subjectId: id }).deleteAll();
  }
  for (const id of created.users) {
    await db.orm.public.User.where({ id }).deleteAll();
  }
  created.users.length = 0;
  created.categories.length = 0;
  created.listings.length = 0;
  created.conversations.length = 0;
  created.deals.length = 0;
  created.sellerVerifications.length = 0;
  created.betaMemberships.length = 0;
  cookieState.store.clear();
});

beforeAll(() => {
  // Mọi emission path (conversation_started/deal_created/beta_membership_
  // activated) + audit ipHash đều cần key — stub TRƯỚC test đầu tiên (plan
  // Task 6 Step 4; Batch 6 S6 pattern).
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AUTH_SECRET", "integration-test-auth-secret-0123456789abcdef");
  vi.stubEnv("PRODUCT_EVENT_PSEUDONYM_KEY", TEST_KEY);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await db.close();
});

beforeEach(() => {
  resetRateLimits();
});

// ─── 1/2. §2.1 + C2 end-to-end trên DB thật ───────────────────────────────────

d("buyer beta access enforcement trên DB thật (spec §2.1 + §7.8)", () => {
  it("non-member buyer KHÔNG start conversation được; private_beta_buyer member CÓ (§2.1 gate)", async () => {
    const seller = await mkUser("seller");
    await seedSellerEligibility(seller); // D2 — seller đủ §7.8
    const listing = await mkListing(seller); // approved — live
    const nonMember = await mkUser("buyer");
    const member = await mkUser("buyer");
    await seedBuyerMembership(member); // §2.1 active participant

    // non-member → BETA_MEMBERSHIP_REQUIRED, KHÔNG Conversation row
    const nonMemberTok = await loginAs(nonMember);
    setSession(nonMemberTok);
    await expect(startConversationAction(fd({ listingId: listing }))).rejects.toThrow(
      "BETA_MEMBERSHIP_REQUIRED",
    );
    expect(
      await db.orm.public.Conversation.where({ listingId: listing, buyerId: nonMember }).first(),
    ).toBeNull();

    // member → tạo hội thoại thành công (redirect sau create)
    const memberTok = await loginAs(member);
    setSession(memberTok);
    await expect(startConversationAction(fd({ listingId: listing }))).rejects.toThrow(
      "NEXT_REDIRECT", // tạo thành công → redirect /chat/<id>
    );
    const convo = await db.orm.public.Conversation
      .where({ listingId: listing, buyerId: member })
      .first();
    expect(convo).not.toBeNull();
  });

  it("non-member buyer KHÔNG tạo Deal được; member CÓ (C2 — §7.8 Deal mutation)", async () => {
    const seller = await mkUser("seller");
    await seedSellerEligibility(seller);
    const listing = await mkListing(seller);
    const nonMember = await mkUser("buyer");
    const member = await mkUser("buyer");
    await seedBuyerMembership(member);
    // hội thoại tương ứng (§5.2 — Deal chỉ tạo trong hội thoại đã tồn tại)
    await mkConversation(listing, nonMember, seller);
    await mkConversation(listing, member, seller);

    // non-member → form error BETA_MEMBERSHIP_REQUIRED, KHÔNG Deal
    const nonMemberTok = await loginAs(nonMember);
    setSession(nonMemberTok);
    const denied = await createDealAction({}, fd({ listingId: listing, agreedPrice: "1500000" }));
    expect(denied).toEqual({ error: "BETA_MEMBERSHIP_REQUIRED" });
    expect(await db.orm.public.Deal.where({ listingId: listing, buyerId: nonMember }).first()).toBeNull();

    // member → Deal open tạo thành công
    const memberTok = await loginAs(member);
    setSession(memberTok);
    const ok = await createDealAction({}, fd({ listingId: listing, agreedPrice: "1500000" }));
    expect(ok).toEqual({ success: "Đã tạo thỏa thuận." });
    const deal = await db.orm.public.Deal.where({ listingId: listing, buyerId: member }).first();
    expect(deal).toMatchObject({ status: "open", agreedPrice: 1_500_000 });
    created.deals.push(deal!.id);
  });

  // ─── 3. Suspend qua ACTION Batch 2 → chặn NGAY (fresh read) ───────────────

  it("suspend membership (setBetaMembershipAction) chặn hội thoại MỚI + Deal MỚI ngay (fresh DB read)", async () => {
    const ops = await mkUser("admin", { adminRole: "operations_admin" });
    const seller = await mkUser("seller");
    await seedSellerEligibility(seller);
    const listingA = await mkListing(seller);
    const listingB = await mkListing(seller);
    const buyer = await mkUser("buyer");

    // grant qua ACTION Batch 2 (§8.4 admin operation — audited; ops ≠ buyer:
    // self-grant forbidden)
    const opsTok = await loginAs(ops, { isAdmin: true });
    setSession(opsTok);
    await setBetaMembershipAction(
      fd({ userId: buyer, cohort: "private_beta_buyer", status: "active" }),
    );
    const granted = await db.orm.public.BetaCohortMembership
      .where({ userId: buyer, cohort: "private_beta_buyer" })
      .first();
    expect(granted).toMatchObject({ status: "active" });
    created.betaMemberships.push(granted!.id);

    // member: start + create đều được
    const buyerTok = await loginAs(buyer);
    setSession(buyerTok);
    await expect(startConversationAction(fd({ listingId: listingA }))).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    const convoA = await db.orm.public.Conversation
      .where({ listingId: listingA, buyerId: buyer })
      .first();
    expect(convoA).not.toBeNull();
    const created1 = await createDealAction({}, fd({ listingId: listingA }));
    expect(created1).toEqual({ success: "Đã tạo thỏa thuận." });
    const dealA = await db.orm.public.Deal.where({ listingId: listingA, buyerId: buyer }).first();
    created.deals.push(dealA!.id);

    // suspend qua ACTION Batch 2 (session buyer còn sống — guard đọc FRESH)
    setSession(opsTok);
    await setBetaMembershipAction(
      fd({ userId: buyer, cohort: "private_beta_buyer", status: "suspended" }),
    );

    // cùng session cũ → hội thoại MỚI bị chặn NGAY (§7.8 fresh read)
    setSession(buyerTok);
    await expect(startConversationAction(fd({ listingId: listingB }))).rejects.toThrow(
      "BETA_MEMBERSHIP_REQUIRED",
    );
    expect(
      await db.orm.public.Conversation.where({ listingId: listingB, buyerId: buyer }).first(),
    ).toBeNull();

    // Deal MỚI (listing khác, hội thoại đã có) cũng bị chặn
    await mkConversation(listingB, buyer, seller);
    const denied = await createDealAction({}, fd({ listingId: listingB }));
    expect(denied).toEqual({ error: "BETA_MEMBERSHIP_REQUIRED" });
    expect(await db.orm.public.Deal.where({ listingId: listingB, buyerId: buyer }).first()).toBeNull();
  });

  // ─── 4. Deal đang mở vẫn mark được sau suspend (D10/D2 — KHÔNG beta gate) ──

  it("Deal ĐANG MỞ vẫn mark outcome được sau khi membership bị suspend (D10 — ongoing participation)", async () => {
    const seller = await mkUser("seller");
    await seedSellerEligibility(seller);
    const listing = await mkListing(seller);
    const buyer = await mkUser("buyer");
    await seedBuyerMembership(buyer); // member lúc mở deal
    await mkConversation(listing, buyer, seller);

    const buyerTok = await loginAs(buyer);
    setSession(buyerTok);
    const ok = await createDealAction({}, fd({ listingId: listing }));
    expect(ok).toEqual({ success: "Đã tạo thỏa thuận." });
    const deal = await db.orm.public.Deal.where({ listingId: listing, buyerId: buyer }).first();
    expect(deal).toMatchObject({ status: "open" });
    created.deals.push(deal!.id);

    // suspend membership (trực tiếp — marking KHÔNG đọc membership, điểm của
    // case này là guard beta KHÔNG sống ở marking)
    await db.orm.public.BetaCohortMembership
      .where({ userId: buyer, cohort: "private_beta_buyer" })
      .updateAll({ status: "suspended" });

    // marking no_deal VẪN chạy — Batch 6 D10 guards (actor suspension + block)
    // áp, KHÔNG phải beta policy; chặn marking của member sẽ stranded bản ghi
    // song phương.
    const marked = await markDealOutcomeAction({}, fd({ dealId: deal!.id, outcome: "no_deal" }));
    expect(marked).toEqual({ success: expect.stringContaining("Đã ghi") });
    const after = await db.orm.public.Deal.first({ id: deal!.id });
    expect(after).toMatchObject({ status: "no_deal" });
    expect(after!.buyerOutcomeAt).not.toBeNull();
  });

  // ─── 5. Re-grant active mở lại truy cập (§8.4 admin operation) ─────────────

  it("re-grant active membership mở lại hội thoại NGAY (admin operation §8.4)", async () => {
    const ops = await mkUser("admin", { adminRole: "operations_admin" });
    const seller = await mkUser("seller");
    await seedSellerEligibility(seller);
    const listing = await mkListing(seller);
    const buyer = await mkUser("buyer");
    await seedBuyerMembership(buyer, "suspended"); // đang suspended

    const buyerTok = await loginAs(buyer);
    setSession(buyerTok);
    await expect(startConversationAction(fd({ listingId: listing }))).rejects.toThrow(
      "BETA_MEMBERSHIP_REQUIRED",
    );

    // ops re-grant active qua ACTION Batch 2
    const opsTok = await loginAs(ops, { isAdmin: true });
    setSession(opsTok);
    await setBetaMembershipAction(
      fd({ userId: buyer, cohort: "private_beta_buyer", status: "active" }),
    );

    // cùng session cũ → truy cập mở lại NGAY (fresh read)
    setSession(buyerTok);
    await expect(startConversationAction(fd({ listingId: listing }))).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    const convo = await db.orm.public.Conversation
      .where({ listingId: listing, buyerId: buyer })
      .first();
    expect(convo).not.toBeNull();
  });
});
