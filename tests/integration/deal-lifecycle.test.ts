/**
 * Deal lifecycle — integration tests (Batch 6 plan Task 5 — spec §5.2 Deal
 * outcome, §5.5 block semantics D10, §4.8 telemetry privacy, §7.3 cross-
 * account Deal modification, §7.8 actor-side, §9 Batch 6 Gate "No Deal
 * action creates Payment/Payout/Wallet/Ledger/Escrow"; corrections
 * 2026-10-08 items 4/10/14/22/25/26/30) — chạy trên scratch DB
 * (scripts/test-integration.sh: container riêng + `prisma db migrate --to
 * production` + dọn). KHÔNG chạy trong `npm test`.
 *
 * Unit tests (tests/unit/deal-outcome.test.ts) chứng minh logic action với
 * db mock; ở đây chứng minh CÙNG hợp đồng against DB THẬT — row-lock
 * serialization thật, partial unique index thật, ProductEvent row thật
 * (PRODUCT_EVENT_PSEUDONYM_KEY stub — S6/corrections #25: test-integration.sh
 * chỉ set DATABASE_URL; không stub thì emit core fail-open silent no-op và
 * mọi row-count assertion VÔ HIỆU):
 *
 *  1. Happy path (markSold): create → buyer success → seller success
 *     (markSold) → deal completed + completedAt + ĐÚNG MỘT successful_match
 *     (assert count DƯƠNG — corrections #10, không chỉ "không quá một") +
 *     listing sold + MỘT listing_marked_sold + DealStatusHistory append đúng
 *     thứ tự (open → buyer:success → completed) + seller notified HAI LẦN
 *     (create + outcome) không PII.
 *  2. Finance isolation toàn vòng đời (S5 — §9 Gate nửa lifecycle): count
 *     Order/Payment/Payout/LedgerEntry/WithdrawRequest TRƯỚC = SAU nguyên
 *     flow create→success→success.
 *  3. Bilateral completion KHÔNG markSold → listing VẪN approved, KHÔNG
 *     listing_marked_sold row (D6/S7 — sold là lựa chọn tường minh).
 *  4. Double-create race (Promise.all) → MỘT deal open; thua DEAL_ALREADY_OPEN
 *     (partial unique index thật — Review Focus 3).
 *  5. Both-success race (Promise.all) → MỘT completedAt, MỘT successful_match
 *     (atomic claim + row-lock serialization thật).
 *  6. Success vs no_deal race → KHÔNG completed, KHÔNG successful_match,
 *     mismatch ghi nhận (A1 shape — completion claim thua CAS trên status).
 *  7. Idempotent re-mark → không row history/event mới (gate item).
 *  8. Non-participant → DEAL_FORBIDDEN zero rows; dealId thiếu → DEAL_FORBIDDEN
 *     (S9 — cùng mã, không existence oracle).
 *  9. Blocked pair (UserBlock THẬT): no_deal marking VẪN được phép; success
 *     marking bị từ chối (D10/FD-3).
 * 10. Seller eligibility revoked GIỮA deal → outcome marking VẪN chạy (D2
 *     perimeter: eligibility gate creation + new chat, KHÔNG gate ongoing
 *     deal participation — pinned intentionally); createDealAction sau đó bị
 *     SELLER_NOT_VERIFIED (creation là nơi eligibility sống).
 *
 * Cơ chế mock (Global Constraints stubbing recipe — action boundary):
 * server-only + next/cache + next/navigation (redirect throw) + next/headers +
 * `@/src/lib/auth` fixture (queue cho race — mỗi requireUser call POP một user
 * theo thứ tự call) — DB/session-guards/rate-limit/notify/emitProductEvent
 * THẬT toàn bộ. Cleanup (corrections #4): ProductEvent (theo listingId) →
 * Deal (DealStatusHistory Cascade) → Conversation → Listing → Category →
 * SellerVerification → BetaCohortMembership → UserBlock → UserSuspension →
 * User (Deal.buyer/seller Restrict — Deal PHẢI trước User).
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

// ─── auth fixture — requireUser pop queue (race) hoặc user tĩnh (recipe) ───────

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

import { db } from "../../src/prisma/db.client";
import { resetRateLimits } from "../../src/lib/rate-limit";
import { createDealAction, markDealOutcomeAction } from "../../src/lib/actions/deals";

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

/** Key test hợp lệ — base64 của đúng 32 byte (product-events.test.ts pattern). */
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

let seq = 0;
const uid = () => `b6l-${Date.now()}-${seq++}`;

const fixtureFor = (id: string, role: "buyer" | "seller"): FixtureUser => ({
  id,
  email: `b6l-${id.slice(0, 8)}@integration.test`,
  name: `B6L ${role}`,
  role,
  avatarUrl: null,
  isVerifiedSeller: role === "seller",
  adminRole: null,
  sessionId: `sess-b6l-${id.slice(0, 8)}`,
});

async function mkUser(role: "buyer" | "seller"): Promise<string> {
  const u = await db.orm.public.User.create({
    email: `${uid()}@integration.test`,
    passwordHash: "x",
    name: `B6L ${role}`,
    role,
  });
  created.users.push(u.id);
  return u.id;
}

/** Seller đủ §7.8 (D2): SellerVerification verified + founding_seller active. */
async function mkEligibleSeller(): Promise<string> {
  const sellerId = await mkUser("seller");
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
  return sellerId;
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
    title: `Loa B6L ${uid()}`,
    slug: `loa-b6l-${uid()}`,
    description: "integration test batch 6 task 5",
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

const fd = (entries: Record<string, string>): FormData => {
  const form = new FormData();
  for (const [k, v] of Object.entries(entries)) form.set(k, v);
  return form;
};

const login = (u: FixtureUser): void => {
  authState.user = u;
  authState.queue.length = 0;
};

/** Count ProductEvent theo (name, listingId) — scope fixture, assert DƯƠNG. */
async function eventCount(name: string, listingId: string): Promise<number> {
  const rows = await db.orm.public.ProductEvent.where({ name, listingId }).all();
  return rows.length;
}

/** Count finance — §9 Gate lifecycle half (S5). */
async function financeCounts(): Promise<Record<string, number>> {
  const [orders, payments, payouts, ledger, withdraws] = await Promise.all([
    db.orm.public.Order.aggregate((a) => ({ c: a.count() })),
    db.orm.public.Payment.aggregate((a) => ({ c: a.count() })),
    db.orm.public.Payout.aggregate((a) => ({ c: a.count() })),
    db.orm.public.LedgerEntry.aggregate((a) => ({ c: a.count() })),
    db.orm.public.WithdrawRequest.aggregate((a) => ({ c: a.count() })),
  ]);
  return { orders: orders.c, payments: payments.c, payouts: payouts.c, ledger: ledger.c, withdraws: withdraws.c };
}

// dọn đúng dữ liệu test mình tạo (DB scratch — nhưng vẫn dọn sạch theo ref),
// thứ tự ngược FK (corrections #4): ProductEvent (no FK) → Deal (DealStatusHistory
// Cascade theo dealId — KHÔNG xóa history riêng) → Conversation → Listing →
// Category → SellerVerification (user Restrict) → BetaCohortMembership →
// UserBlock → UserSuspension (user Restrict) → User (Notification Cascade).
const created = {
  users: [] as string[],
  categories: [] as string[],
  listings: [] as string[],
  conversations: [] as string[],
  deals: [] as string[],
  sellerVerifications: [] as string[],
  betaMemberships: [] as string[],
  blocks: [] as string[],
  suspensions: [] as string[],
};

afterEach(async () => {
  // ProductEvent do emit core THẬT ghi — mọi event Deal đều mang listingId
  // (deal_created/deal_outcome_marked/successful_match/listing_marked_sold).
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
  for (const id of created.blocks) {
    await db.orm.public.UserBlock.where({ id }).deleteAll();
  }
  for (const id of created.suspensions) {
    await db.orm.public.UserSuspension.where({ id }).deleteAll();
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
  created.blocks.length = 0;
  created.suspensions.length = 0;
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  vi.stubEnv("PRODUCT_EVENT_PSEUDONYM_KEY", TEST_KEY);
  vi.stubEnv("NODE_ENV", "test");
  authState.user = null;
  authState.queue.length = 0;
  resetRateLimits();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── Fixtures trọn gói cho một cặp (buyer, seller) + deal open ────────────────

type SeededPair = {
  buyer: string;
  seller: string;
  listing: string;
  listingTitle: string;
  convo: string;
  dealId: string;
};

/** Seed đủ: seller eligible + listing approved + conversation + deal open (createDealAction THẬT). */
async function seedOpenDeal(): Promise<SeededPair> {
  const seller = await mkEligibleSeller();
  const buyer = await mkUser("buyer");
  const listing = await mkListing(seller);
  const listingRow = await db.orm.public.Listing.first({ id: listing });
  const convo = await mkConversation(listing, buyer, seller);
  login(fixtureFor(buyer, "buyer"));
  await createDealAction({}, fd({ listingId: listing, agreedPrice: "1500000" }));
  const deal = await db.orm.public.Deal.where({ conversationId: convo }).first();
  if (deal === null) throw new Error("createDealAction không tạo Deal (seed fixture hỏng)");
  created.deals.push(deal.id);
  return { buyer, seller, listing, listingTitle: listingRow!.title, convo, dealId: deal.id };
}

d("deal lifecycle trên DB thật", () => {
  // ─── 1. Happy path với markSold ────────────────────────────────────────────

  it("create → buyer success → seller success (markSold): completed + MỘT successful_match + sold + history đúng thứ tự + seller notified 2 lần không PII", async () => {
    const financeBefore = await financeCounts();
    const pair = await seedOpenDeal();

    // Buyer marks success — deal VẪN open (một bên)
    await markDealOutcomeAction({}, fd({ dealId: pair.dealId, outcome: "success" }));
    let dealRow = await db.orm.public.Deal.first({ id: pair.dealId });
    expect(dealRow!.status).toBe("open");
    expect(dealRow!.buyerOutcomeAt).not.toBeNull();

    // Seller marks success + markSold (D6 — lựa chọn tường minh)
    login(fixtureFor(pair.seller, "seller"));
    const sellerState = await markDealOutcomeAction(
      {},
      fd({ dealId: pair.dealId, outcome: "success", markSold: "on" }),
    );
    expect(sellerState).toEqual({ success: expect.stringContaining("Đã ghi") });

    dealRow = await db.orm.public.Deal.first({ id: pair.dealId });
    expect(dealRow!.status).toBe("completed");
    expect(dealRow!.completedAt).not.toBeNull();
    expect(dealRow!.sellerOutcomeAt).not.toBeNull();

    // ĐÚNG MỘT successful_match — count DƯƠNG (corrections #10 — row thật)
    expect(await eventCount("successful_match", pair.listing)).toBe(1);
    expect(await eventCount("listing_marked_sold", pair.listing)).toBe(1);
    expect(await eventCount("deal_created", pair.listing)).toBe(1);
    expect(await eventCount("deal_outcome_marked", pair.listing)).toBe(2);

    // Listing sold — claim approved→sold thắng (D6)
    const listingRow = await db.orm.public.Listing.first({ id: pair.listing });
    expect(listingRow!.status).toBe("sold");

    // History append đúng thứ tự: open (created) → open (buyer:success) → completed (seller:success)
    const history = await db.orm.public.DealStatusHistory
      .where({ dealId: pair.dealId })
      .orderBy([(h) => h.createdAt.asc(), (h) => h.id.asc()])
      .all();
    expect(history.map((h) => h.note)).toEqual(["buyer:created", "buyer:success", "seller:success"]);
    expect(history.map((h) => h.status)).toEqual(["open", "open", "completed"]);

    // Seller notified HAI LẦN (create + buyer outcome) — typed, không PII
    const sellerNotifs = await db.orm.public.Notification.where({ userId: pair.seller }).all();
    expect(sellerNotifs).toHaveLength(2);
    expect(sellerNotifs.map((n) => n.title)).toContain("Thỏa thuận mới");
    expect(sellerNotifs.map((n) => n.title)).toContain("Thỏa thuận có kết quả mới");
    for (const n of sellerNotifs) {
      expect(n.link).toBe(`/chat/${pair.convo}`);
      expect(String(n.body)).not.toContain("1500000"); // KHÔNG giá (Q6)
      expect(String(n.body)).not.toContain("@"); // KHÔNG email
    }
    // Buyer notified MỘT lần (seller outcome)
    const buyerNotifs = await db.orm.public.Notification.where({ userId: pair.buyer }).all();
    expect(buyerNotifs).toHaveLength(1);
    expect(buyerNotifs[0]!.body).toBe("Thỏa thuận thành công"); // typed label

    // ─── 2. Finance isolation toàn vòng đời (S5 — §9 Gate) ───────────────────
    const financeAfter = await financeCounts();
    expect(financeAfter).toEqual(financeBefore); // Order/Payment/Payout/LedgerEntry/WithdrawRequest KHÔNG đổi
  });

  it("bilateral completion KHÔNG markSold → listing VẪN approved, KHÔNG listing_marked_sold row (D6/S7)", async () => {
    const pair = await seedOpenDeal();
    await markDealOutcomeAction({}, fd({ dealId: pair.dealId, outcome: "success" })); // buyer
    login(fixtureFor(pair.seller, "seller"));
    await markDealOutcomeAction({}, fd({ dealId: pair.dealId, outcome: "success" })); // seller — KHÔNG markSold

    const dealRow = await db.orm.public.Deal.first({ id: pair.dealId });
    expect(dealRow!.status).toBe("completed");
    expect(await eventCount("successful_match", pair.listing)).toBe(1);

    // D6 — bilateral completion một mình KHÔNG bán listing
    const listingRow = await db.orm.public.Listing.first({ id: pair.listing });
    expect(listingRow!.status).toBe("approved");
    expect(await eventCount("listing_marked_sold", pair.listing)).toBe(0);
  });

  // ─── 4. Double-create race (partial unique index thật) ──────────────────────

  it("double-create race (Promise.all) → MỘT deal open; thua DEAL_ALREADY_OPEN", async () => {
    const pair = await seedOpenDeal(); // deal open thứ nhất đã có (listing KHÁC)
    // Race thật cần cặp CHƯA có deal: listing + convo mới, cùng buyer.
    const seller = await mkEligibleSeller();
    const listing = await mkListing(seller);
    const convo = await mkConversation(listing, pair.buyer, seller);
    login(fixtureFor(pair.buyer, "buyer"));

    const [a, b] = await Promise.all([
      createDealAction({}, fd({ listingId: listing })),
      createDealAction({}, fd({ listingId: listing })),
    ]);

    // ĐÚNG MỘT deal open cho (listing, buyer) — thua cuộc DEAL_ALREADY_OPEN
    // (qua pre-check hay qua partial unique index 23505 tuỳ scheduling —
    // cùng kết quả quan sát; index là ranh giới thật).
    const openDeals = await db.orm.public.Deal
      .where({ listingId: listing, buyerId: pair.buyer, status: "open" })
      .all();
    expect(openDeals).toHaveLength(1);
    expect([a, b]).toContainEqual({ error: "DEAL_ALREADY_OPEN" });
    expect([a, b]).toContainEqual({ success: "Đã tạo thỏa thuận." });
    created.deals.push(openDeals[0]!.id);
    expect(convo).toBeTruthy();
  });

  // ─── 5/6. Outcome races (atomic claim + row-lock serialization thật) ────────

  it("both-success race (Promise.all) → MỘT completedAt, MỘT successful_match, cả hai outcomeAt set", async () => {
    const pair = await seedOpenDeal();
    authState.queue.push(fixtureFor(pair.buyer, "buyer"), fixtureFor(pair.seller, "seller"));

    const [buyerState, sellerState] = await Promise.all([
      markDealOutcomeAction({}, fd({ dealId: pair.dealId, outcome: "success" })),
      markDealOutcomeAction({}, fd({ dealId: pair.dealId, outcome: "success" })),
    ]);
    expect(buyerState).toEqual({ success: expect.stringContaining("Đã ghi") });
    expect(sellerState).toEqual({ success: expect.stringContaining("Đã ghi") });

    const dealRow = await db.orm.public.Deal.first({ id: pair.dealId });
    expect(dealRow!.status).toBe("completed");
    expect(dealRow!.buyerOutcomeAt).not.toBeNull();
    expect(dealRow!.sellerOutcomeAt).not.toBeNull();
    expect(dealRow!.completedAt).not.toBeNull();

    // MỘT successful_match — atomic claim: tx thua thấy status đã completed → 0 row
    expect(await eventCount("successful_match", pair.listing)).toBe(1);
    expect(await eventCount("deal_outcome_marked", pair.listing)).toBe(2);
  });

  it("success vs no_deal race (Promise.all) → KHÔNG completed, KHÔNG successful_match, mismatch ghi nhận (A1)", async () => {
    const pair = await seedOpenDeal();
    authState.queue.push(fixtureFor(pair.buyer, "buyer"), fixtureFor(pair.seller, "seller"));

    const [buyerState, sellerState] = await Promise.all([
      markDealOutcomeAction({}, fd({ dealId: pair.dealId, outcome: "success" })),
      markDealOutcomeAction({}, fd({ dealId: pair.dealId, outcome: "no_deal" })),
    ]);
    expect(buyerState).toEqual({ success: expect.stringContaining("Đã ghi") });
    expect(sellerState).toEqual({ success: expect.stringContaining("Đã ghi") });

    // no_deal thắng status claim — completion claim thua CAS (0 row) → KHÔNG completed
    const dealRow = await db.orm.public.Deal.first({ id: pair.dealId });
    expect(dealRow!.status).toBe("no_deal");
    expect(dealRow!.completedAt).toBeNull();
    expect(await eventCount("successful_match", pair.listing)).toBe(0);

    // CẢ HAI marking ghi trong history — mismatch hiển thị, không tự resolve (A1).
    // Thứ tự HAI marking row phụ thuộc tx nào commit trước (race) — assert
    // order-independent: đúng 3 row, created đầu, hai marking còn lại đủ cả.
    const history = await db.orm.public.DealStatusHistory
      .where({ dealId: pair.dealId })
      .orderBy([(h) => h.createdAt.asc(), (h) => h.id.asc()])
      .all();
    expect(history).toHaveLength(3);
    expect(history[0]!.note).toBe("buyer:created");
    expect(history.slice(1).map((h) => h.note).sort()).toEqual(["buyer:success", "seller:no_deal"]);
  });

  // ─── 7. Idempotent re-mark ──────────────────────────────────────────────────

  it("idempotent re-mark → không row history/event mới", async () => {
    const pair = await seedOpenDeal();
    await markDealOutcomeAction({}, fd({ dealId: pair.dealId, outcome: "no_deal" }));

    const historyBefore = await db.orm.public.DealStatusHistory.where({ dealId: pair.dealId }).all();
    const eventsBefore = await eventCount("deal_outcome_marked", pair.listing);

    const state = await markDealOutcomeAction({}, fd({ dealId: pair.dealId, outcome: "no_deal" }));
    expect(state).toEqual({ success: expect.stringContaining("Đã ghi") }); // no-op THÀNH CÔNG

    const historyAfter = await db.orm.public.DealStatusHistory.where({ dealId: pair.dealId }).all();
    expect(historyAfter).toHaveLength(historyBefore.length); // KHÔNG row mới
    expect(await eventCount("deal_outcome_marked", pair.listing)).toBe(eventsBefore); // KHÔNG event mới
  });

  // ─── 8. IDOR (§7.3/S9) ──────────────────────────────────────────────────────

  it("non-participant → DEAL_FORBIDDEN zero rows; dealId thiếu → DEAL_FORBIDDEN (S9 — cùng mã)", async () => {
    const pair = await seedOpenDeal();
    const third = await mkUser("buyer");
    login(fixtureFor(third, "buyer"));

    const state = await markDealOutcomeAction({}, fd({ dealId: pair.dealId, outcome: "success" }));
    expect(state).toEqual({ error: "DEAL_FORBIDDEN" });

    const missing = await markDealOutcomeAction({}, fd({ outcome: "success" }));
    expect(missing).toEqual({ error: "DEAL_FORBIDDEN" });

    // Zero writes — deal nguyên vẹn, không history/event mới
    const dealRow = await db.orm.public.Deal.first({ id: pair.dealId });
    expect(dealRow!.status).toBe("open");
    expect(dealRow!.buyerOutcomeAt).toBeNull();
    expect(dealRow!.sellerOutcomeAt).toBeNull();
    const history = await db.orm.public.DealStatusHistory.where({ dealId: pair.dealId }).all();
    expect(history).toHaveLength(1); // chỉ buyer:created
    expect(await eventCount("deal_outcome_marked", pair.listing)).toBe(0);
  });

  // ─── 9. Blocked pair (D10 — UserBlock thật) ─────────────────────────────────

  it("blocked pair: no_deal marking VẪN được phép; success marking bị từ chối (D10/FD-3)", async () => {
    const pair = await seedOpenDeal();
    // Seller chặn buyer — block hai hướng chặn success (§5.5 đối xứng)
    const blk = await db.orm.public.UserBlock.create({
      blockerId: pair.seller,
      blockedId: pair.buyer,
    });
    created.blocks.push(blk.id);

    const successState = await markDealOutcomeAction(
      {},
      fd({ dealId: pair.dealId, outcome: "success" }),
    );
    expect(successState).toEqual({ error: "CHAT_BLOCKED" });

    // no_deal → ALLOWED — block không được làm stranded bản ghi kết quả
    const noDealState = await markDealOutcomeAction(
      {},
      fd({ dealId: pair.dealId, outcome: "no_deal" }),
    );
    expect(noDealState).toEqual({ success: expect.stringContaining("Đã ghi") });
    const dealRow = await db.orm.public.Deal.first({ id: pair.dealId });
    expect(dealRow!.status).toBe("no_deal");
    expect(dealRow!.buyerOutcomeAt).not.toBeNull();
  });

  // ─── 10. D2 perimeter — eligibility gate creation, KHÔNG gate ongoing deal ──

  it("seller eligibility revoked GIỮA deal → outcome marking VẪN chạy (D2 perimeter — pinned intentionally); create sau đó bị SELLER_NOT_VERIFIED", async () => {
    const pair = await seedOpenDeal();
    await markDealOutcomeAction({}, fd({ dealId: pair.dealId, outcome: "success" })); // buyer success

    // Revoke verification của seller MID-DEAL
    await db.orm.public.SellerVerification
      .where({ userId: pair.seller })
      .updateAll({ status: "revoked" });

    // Outcome marking của deal ĐÃ tồn tại VẪN chạy — §7.8 gate Deal mutation
    // theo ACTOR suspension/block, không theo counterpart eligibility (D2/A10:
    // chặn revoked seller xác nhận deal đang mở sẽ stranded bản ghi song phương)
    login(fixtureFor(pair.seller, "seller"));
    const state = await markDealOutcomeAction(
      {},
      fd({ dealId: pair.dealId, outcome: "success", markSold: "on" }),
    );
    expect(state).toEqual({ success: expect.stringContaining("Đã ghi") });
    const dealRow = await db.orm.public.Deal.first({ id: pair.dealId });
    expect(dealRow!.status).toBe("completed");
    expect(dealRow!.completedAt).not.toBeNull();
    expect(await eventCount("successful_match", pair.listing)).toBe(1);
    // markSold vẫn chạy (listing còn approved — eligibility không liên quan sold claim)
    const listingRow = await db.orm.public.Listing.first({ id: pair.listing });
    expect(listingRow!.status).toBe("sold");

    // Creation là nơi eligibility sống — deal MỘI trên listing approved KHÁC
    // của cùng seller bị từ chối (listing cũ đã sold → LISTING_NOT_DEALABLE
    // chặn trước cả eligibility — dùng listing mới để pin đúng SELLER_*).
    const freshListing = await mkListing(pair.seller);
    const freshConvo = await mkConversation(freshListing, pair.buyer, pair.seller);
    login(fixtureFor(pair.buyer, "buyer"));
    const createState = await createDealAction({}, fd({ listingId: freshListing }));
    expect(createState).toEqual({ error: "SELLER_NOT_VERIFIED" });
    expect(freshConvo).toBeTruthy();
  });
});
