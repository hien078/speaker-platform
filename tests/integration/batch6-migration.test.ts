/**
 * Batch 6 migration integration tests — plan Task 1 (batch 6), spec §5.2
 * (Lightweight Deal Outcome — Deal + DealStatusHistory + 2 enum), §8
 * (additive-first — KHÔNG backfill: không có legacy deal data), §9 Batch 6
 * Gate (Deal structurally separate from finance) + §4.3 (historical
 * preservation).
 *
 * Chạy trên scratch DB (scripts/test-integration.sh: container riêng +
 * `prisma db migrate --to production` + dọn). KHÔNG chạy trong `npm test`.
 *
 * Chứng minh migration `batch6_chat_deal` (Task 1):
 *  - ADDITIVE (Q3): Deal + DealStatusHistory nhận create + read round-trip
 *    với đúng field contract §5.2 (status default `open`; mọi cột mới
 *    nullable/defaulted); 2 enum mới nhận đủ giá trị spec §5.2 (4 status +
 *    4 fulfillment method); KHÔNG cột nào bị thêm vào bảng hiện có (chỉ
 *    relation declarations trên User/Listing);
 *  - FK decisions (Legacy Migration Decisions): Deal.listingId SetNull —
 *    deal sống qua listing deletion (D9); DealStatusHistory Cascade theo
 *    Deal (corrections item 4 — seed/test KHÔNG xóa history riêng);
 *  - PARTIAL UNIQUE (D4): một deal OPEN duy nhất per (listing, buyer) —
 *    raw create thứ hai status='open' → 23505 trên deal_one_open_per_listing_
 *    buyer_*; deal completed/cancelled cùng cặp TỒN TẠI (D4 — buyer tạo deal
 *    mới sau khi deal cũ kết thúc);
 *  - Deal structurally separate from finance (§9 Batch 6 Gate — nửa cấu
 *    trúc; nửa code-path là Task 7): seed Order+Payment+Payout+LedgerEntry,
 *    tạo Deal + DealStatusHistory — mọi count finance KHÔNG đổi, không row
 *    finance nào reference deal;
 *  - ops.json: mọi op additive — chỉ create/createIndex (Q2: Batch 6 KHÔNG
 *    thêm giá trị listing_status nào → KHÔNG cặp Listing_status_check_*
 *    DROP+ADD nào được render là ĐÚNG — halt trên mọi op destructive);
 *    không data transform (Legacy Migration Decisions);
 *  - `npx prisma db verify` exit 0 sau migrate;
 *  - bảng finance legacy (Order, Payment, Payout, WithdrawRequest,
 *    LedgerEntry, Dispute) vẫn đọc được + seeded Order+Payment đọc lại
 *    nguyên vẹn (spec §4.3/§8.1);
 *  - Batch 2/3/4/5 (UserSession, AuditEvent, BetaCohortMembership,
 *    SellerVerification, UserBlock, UserSuspension, ModerationCase,
 *    AbuseReport, ListingImageUpload, ProductEvent, SearchAlias) nhận
 *    create + delete round-trip; Listing round-trip provinceLevelCode
 *    (Batch 4) + locationSource/searchTextNormalized (Batch 5) —
 *    migration Batch 6 không làm xáo trộn graph batch trước.
 *
 * Product-flow posture (plan Task 1 Step 1): KHÔNG case nào exercise
 * product-flow delete trên Deal/DealStatusHistory — test chỉ tự dọn fixture
 * row mình tạo (DealStatusHistory đi qua Cascade từ Deal).
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { isUniqueConstraintViolation, SqlQueryError } from "@prisma/orm-family-sql/errors";

import { db } from "../../src/prisma/db.client";

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const execFileAsync = promisify(execFile);

let seq = 0;
const uid = () => `b6-${Date.now()}-${seq++}`;
const isoFuture = () => new Date(Date.now() + 3_600_000).toISOString();

async function mkUser(role: "buyer" | "seller" | "admin" = "buyer"): Promise<string> {
  const u = await db.orm.public.User.create({
    email: `${uid()}@integration.test`,
    passwordHash: "x",
    name: `B6 ${role}`,
    role,
  });
  return u.id;
}

async function mkCategory(): Promise<string> {
  const c = await db.orm.public.Category.create({
    name: `B6 cat ${uid()}`,
    slug: `b6-cat-${uid()}`,
  });
  return c.id;
}

/** Listing tối thiểu — Batch 6 không thêm cột Listing nào (Q3). */
async function mkListing(
  sellerId: string,
  categoryId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const l = await db.orm.public.Listing.create({
    sellerId,
    categoryId,
    title: `Loa B6 ${uid()}`,
    slug: `loa-b6-${uid()}`,
    description: "integration test batch 6",
    condition: "good",
    price: 1_000_000,
    status: "approved",
    city: "Hà Nội",
    ...overrides,
  });
  return l.id;
}

/** Bắt unique violation (23505) — trả error để assert constraint name. */
async function expectUniqueViolation(fn: () => Promise<unknown>): Promise<SqlQueryError> {
  let err: unknown;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeTruthy();
  expect(isUniqueConstraintViolation(err)).toBe(true); // SQLSTATE 23505 chuẩn
  expect(SqlQueryError.is(err)).toBe(true);
  return err as SqlQueryError;
}

// dọn đúng dữ liệu test mình tạo (DB scratch — nhưng vẫn dọn sạch theo ref),
// thứ tự ngược FK để không bị Restrict chặn (Deal.buyer/seller Restrict —
// Deal PHẢI đi trước User; DealStatusHistory Cascade theo Deal).
const created = {
  users: [] as string[],
  categories: [] as string[],
  listings: [] as string[],
  deals: [] as string[],
  productEvents: [] as string[],
  searchAliases: [] as string[],
  imageUploads: [] as string[],
  abuseReports: [] as string[],
  userBlocks: [] as string[],
  userSuspensions: [] as string[],
  moderationCases: [] as string[],
  sellerVerifications: [] as string[],
  betaMemberships: [] as string[],
  auditEvents: [] as string[],
  sessions: [] as string[],
  ledgerEntries: [] as string[],
  payments: [] as string[],
  payouts: [] as string[],
  orders: [] as string[],
};

afterEach(async () => {
  // Deal — DealStatusHistory Cascade theo dealId (KHÔNG xóa history riêng)
  for (const id of created.deals) {
    await db.orm.public.Deal.where({ id }).delete();
  }
  // ProductEvent/SearchAlias — KHÔNG FK (Batch 5 precedent)
  for (const id of created.productEvents) {
    await db.orm.public.ProductEvent.where({ id }).delete();
  }
  for (const id of created.searchAliases) {
    await db.orm.public.SearchAlias.where({ id }).delete();
  }
  for (const id of created.imageUploads) {
    await db.orm.public.ListingImageUpload.where({ id }).delete();
  }
  for (const id of created.abuseReports) {
    await db.orm.public.AbuseReport.where({ id }).delete();
  }
  for (const id of created.moderationCases) {
    await db.orm.public.ModerationCase.where({ id }).delete();
  }
  for (const id of created.userBlocks) {
    await db.orm.public.UserBlock.where({ id }).delete();
  }
  for (const id of created.userSuspensions) {
    await db.orm.public.UserSuspension.where({ id }).delete();
  }
  for (const id of created.listings) {
    await db.orm.public.Listing.where({ id }).delete();
  }
  for (const id of created.categories) {
    await db.orm.public.Category.where({ id }).delete();
  }
  for (const id of created.sellerVerifications) {
    await db.orm.public.SellerVerification.where({ id }).delete();
  }
  for (const id of created.betaMemberships) {
    await db.orm.public.BetaCohortMembership.where({ id }).delete();
  }
  for (const id of created.auditEvents) {
    await db.orm.public.AuditEvent.where({ id }).delete();
  }
  for (const id of created.sessions) {
    await db.orm.public.UserSession.where({ id }).delete();
  }
  for (const id of created.ledgerEntries) {
    await db.orm.public.LedgerEntry.where({ id }).delete();
  }
  for (const id of created.payments) {
    await db.orm.public.Payment.where({ id }).delete();
  }
  for (const id of created.payouts) {
    await db.orm.public.Payout.where({ id }).delete();
  }
  for (const id of created.orders) {
    await db.orm.public.OrderStatusHistory.where({ orderId: id }).delete();
    await db.orm.public.Order.where({ id }).delete();
  }
  for (const id of created.users) {
    await db.orm.public.Notification.where({ userId: id }).delete();
    await db.orm.public.User.where({ id }).delete();
  }
  (Object.keys(created) as (keyof typeof created)[]).forEach((k) => {
    created[k].length = 0;
  });
});

afterAll(async () => {
  await db.close();
});

// ─── 1. Additive: Deal + DealStatusHistory (spec §5.2, Q3) ───

d("applies the batch 6 migration additively", () => {
  it("Deal — create + read round-trip với đủ field contract §5.2", async () => {
    const sellerId = await mkUser("seller");
    const buyerId = await mkUser("buyer");
    created.users.push(sellerId, buyerId);
    const categoryId = await mkCategory();
    created.categories.push(categoryId);
    const listingId = await mkListing(sellerId, categoryId);
    created.listings.push(listingId);
    const conversationId = randomUUID(); // KHÔNG FK (ProductEvent.conversationId precedent — D9)

    // full field contract §5.2
    const deal = await db.orm.public.Deal.create({
      listingId,
      conversationId,
      buyerId,
      sellerId,
      status: "open",
      agreedPrice: 1_500_000,
      fulfillmentMethod: "meetup",
      buyerOutcomeAt: null,
      sellerOutcomeAt: null,
      completedAt: null,
      cancellationReason: null,
    });
    created.deals.push(deal.id);

    const row = await db.orm.public.Deal.first({ id: deal.id });
    expect(row!.listingId).toBe(listingId);
    expect(row!.conversationId).toBe(conversationId);
    expect(row!.buyerId).toBe(buyerId);
    expect(row!.sellerId).toBe(sellerId);
    expect(row!.status).toBe("open");
    expect(row!.agreedPrice).toBe(1_500_000);
    expect(row!.fulfillmentMethod).toBe("meetup");
    expect(row!.buyerOutcomeAt).toBeNull();
    expect(row!.sellerOutcomeAt).toBeNull();
    expect(row!.completedAt).toBeNull();
    expect(row!.cancellationReason).toBeNull();
    expect(row!.createdAt).toBeTruthy();
    expect(row!.updatedAt).toBeTruthy();

    // status default `open` + mọi cột nullable nhận null (create tối thiểu)
    const minimal = await db.orm.public.Deal.create({ buyerId, sellerId });
    created.deals.push(minimal.id);
    const minRow = await db.orm.public.Deal.first({ id: minimal.id });
    expect(minRow!.status).toBe("open"); // @default(open)
    expect(minRow!.listingId).toBeNull(); // nullable + SetNull (D9)
    expect(minRow!.conversationId).toBeNull(); // nullable, KHÔNG FK (D9)
    expect(minRow!.agreedPrice).toBeNull();
    expect(minRow!.fulfillmentMethod).toBeNull();
  });

  it("DealStatusHistory — create + read round-trip (status, actorId nullable, note, createdAt)", async () => {
    const sellerId = await mkUser("seller");
    const buyerId = await mkUser("buyer");
    created.users.push(sellerId, buyerId);
    const deal = await db.orm.public.Deal.create({ buyerId, sellerId });
    created.deals.push(deal.id);

    const h = await db.orm.public.DealStatusHistory.create({
      dealId: deal.id,
      status: "open",
      actorId: buyerId,
      note: "buyer:created", // typed marker — KHÔNG PII (corrections item 23)
    });
    const row = await db.orm.public.DealStatusHistory.first({ id: h.id });
    expect(row!.dealId).toBe(deal.id);
    expect(row!.status).toBe("open");
    expect(row!.actorId).toBe(buyerId);
    expect(row!.note).toBe("buyer:created");
    expect(row!.createdAt).toBeTruthy();

    // actorId nullable + SetNull (Batch 3 ModerationAction precedent — D9):
    // history row sống qua account deletion tương lai
    const sysRow = await db.orm.public.DealStatusHistory.create({
      dealId: deal.id,
      status: "no_deal",
      actorId: null,
      note: null,
    });
    const sysBack = await db.orm.public.DealStatusHistory.first({ id: sysRow.id });
    expect(sysBack!.actorId).toBeNull();
    expect(sysBack!.note).toBeNull();
  });

  it("Deal sống qua listing deletion — listingId SetNull (D9); history Cascade theo Deal", async () => {
    const sellerId = await mkUser("seller");
    const buyerId = await mkUser("buyer");
    created.users.push(sellerId, buyerId);
    const categoryId = await mkCategory();
    created.categories.push(categoryId);
    const listingId = await mkListing(sellerId, categoryId);
    created.listings.push(listingId);
    const conversationId = randomUUID();

    const deal = await db.orm.public.Deal.create({
      listingId,
      conversationId,
      buyerId,
      sellerId,
    });
    created.deals.push(deal.id);
    await db.orm.public.DealStatusHistory.create({
      dealId: deal.id,
      status: "open",
      actorId: buyerId,
    });

    // test TỰ DỌN fixture listing (KHÔNG phải product flow — plan Task 1 Step 1):
    // SetNull ⇒ deal sống sót, trở thành listing-less nhưng vẫn reachable qua
    // conversationId (D9/S11 — panel + telemetry key off conversationId)
    await db.orm.public.Listing.where({ id: listingId }).delete();
    const row = await db.orm.public.Deal.first({ id: deal.id });
    expect(row).toBeTruthy();
    expect(row!.listingId).toBeNull(); // SetNull
    expect(row!.conversationId).toBe(conversationId); // vẫn reachable (D9)
    expect(row!.buyerId).toBe(buyerId);
    expect(row!.sellerId).toBe(sellerId);

    // Cascade: history đi theo Deal — corrections item 4 dựa vào đây (seed/test
    // KHÔNG viết statement DealStatusHistory delete riêng)
    expect(await db.orm.public.DealStatusHistory.where({ dealId: deal.id }).all()).toHaveLength(1);
    await db.orm.public.Deal.where({ id: deal.id }).delete(); // dọn fixture mình tạo
    expect(await db.orm.public.DealStatusHistory.where({ dealId: deal.id }).all()).toHaveLength(0);
  });

  it("enum values match spec §5.2 — 4 deal_status + 4 deal_fulfillment_method", async () => {
    const sellerId = await mkUser("seller");
    const buyerId = await mkUser("buyer");
    created.users.push(sellerId, buyerId);
    const categoryId = await mkCategory();
    created.categories.push(categoryId);
    const listingId = await mkListing(sellerId, categoryId);
    created.listings.push(listingId);

    // 4 status — cùng (listing, buyer): chỉ MỘT open (partial unique), 3
    // terminal cùng cặp được phép tồn tại (D4)
    for (const status of ["open", "completed", "cancelled", "no_deal"] as const) {
      const deal = await db.orm.public.Deal.create({ listingId, buyerId, sellerId, status });
      created.deals.push(deal.id);
      expect((await db.orm.public.Deal.first({ id: deal.id }))!.status).toBe(status);
    }

    // 4 fulfillment method — buyer KHÁC nhau, mỗi người một open deal trên
    // cùng listing (partial unique là per (listing, buyer) — D4)
    for (const method of ["meetup", "seller_delivery", "carrier", "other"] as const) {
      const otherBuyerId = await mkUser("buyer");
      created.users.push(otherBuyerId);
      const deal = await db.orm.public.Deal.create({
        listingId,
        buyerId: otherBuyerId,
        sellerId,
        fulfillmentMethod: method,
      });
      created.deals.push(deal.id);
      const row = await db.orm.public.Deal.first({ id: deal.id });
      expect(row!.fulfillmentMethod).toBe(method);
      expect(row!.status).toBe("open");
    }
  });

  it("migration ops: mọi op additive — chỉ create, KHÔNG đụng bảng/cột đang có (Q2/Q3)", async () => {
    // đọc ops.json của package batch6 — nguồn chân thực planner render
    const migrationsAppDir = fileURLToPath(new URL("../../migrations/app/", import.meta.url));
    const dirName = readdirSync(migrationsAppDir).find((e) => /_batch6_chat_deal$/.test(e));
    expect(dirName).toBeTruthy(); // package chưa render → fail (đúng ở Step 2 TDD)
    const ops = JSON.parse(
      readFileSync(join(migrationsAppDir, dirName!, "ops.json"), "utf8"),
    ) as Array<{ id: string; label: string; operationClass: string }>;

    // 2 bảng mới — toàn bộ op "table." là CREATE (không drop bảng nào)
    const tableOps = ops.filter((o) => o.id.startsWith("table."));
    expect(tableOps.map((o) => o.id).sort()).toEqual(["table.Deal", "table.DealStatusHistory"].sort());
    expect(tableOps.filter((o) => /drop|alter/i.test(o.label))).toEqual([]);

    // KHÔNG cột nào bị thêm vào bảng hiện có (Q3 — User/Listing chỉ nhận
    // relation declarations, KHÔNG cột mới)
    expect(ops.filter((o) => o.id.startsWith("column."))).toEqual([]);

    // Q2 — halt trên MỌI op destructive: Batch 6 không thêm giá trị listing_status
    // nào nên KHÔNG cặp Listing_status_check_* DROP+ADD nào được render là ĐÚNG
    expect(ops.filter((o) => o.operationClass === "destructive")).toEqual([]);
    expect(ops.filter((o) => /drop|alter/i.test(o.label))).toEqual([]);
    expect(ops.filter((o) => /listing_status_check/i.test(o.id))).toEqual([]);

    // không data transform (Legacy Migration Decisions — không legacy deal data)
    expect(ops.filter((o) => o.operationClass === "data")).toEqual([]);

    // partial unique index D4 render (tên wire + hash suffix — corrections item 11)
    expect(
      ops.filter((o) => /^index\.deal\.deal_one_open_per_listing_buyer_/i.test(o.id)),
    ).toHaveLength(1);

    // KHÔNG op nào chạm bảng finance (§9 Batch 6 Gate — nửa cấu trúc)
    const FINANCE_TABLES = /Order|Payment|Payout|WithdrawRequest|LedgerEntry|Dispute|Cart|CartItem|Offer|ExchangeOffer|Wallet/i;
    for (const op of ops) {
      expect(op.id, `op finance: ${op.id}`).not.toMatch(FINANCE_TABLES);
    }
  });
});

// ─── 2. Một deal OPEN duy nhất per (listing, buyer) — D4 ───

d("one OPEN deal per (listing, buyer)", () => {
  it("open thứ 2 cùng cặp → 23505 deal_one_open_per_listing_buyer; terminal cùng cặp vẫn sống (D4)", async () => {
    const sellerId = await mkUser("seller");
    const buyerId = await mkUser("buyer");
    created.users.push(sellerId, buyerId);
    const categoryId = await mkCategory();
    created.categories.push(categoryId);
    const listingId = await mkListing(sellerId, categoryId);
    created.listings.push(listingId);

    // deal terminal TRƯỚC — cùng cặp (listing, buyer) chưa có open nào
    const completed = await db.orm.public.Deal.create({
      listingId,
      buyerId,
      sellerId,
      status: "completed",
    });
    created.deals.push(completed.id);

    // open deal MỚI cùng cặp — ĐƯỢC (D4: "a completed deal with the same pair
    // coexists with a new open one" — index chỉ cover status='open')
    const openDeal = await db.orm.public.Deal.create({ listingId, buyerId, sellerId });
    created.deals.push(openDeal.id);
    expect((await db.orm.public.Deal.first({ id: openDeal.id }))!.status).toBe("open");

    // open THỨ HAI cùng cặp → 23505 (raw create — partial unique index)
    const err = await expectUniqueViolation(() =>
      db.orm.public.Deal.create({ listingId, buyerId, sellerId, status: "open" }),
    );
    // tên wire + hash suffix (corrections item 11 — prefix match)
    expect(err.constraint).toMatch(/^deal_one_open_per_listing_buyer_/);
    expect(err.table).toBe("Deal");

    // cancelled cùng cặp cũng tồn tại (D4 — nhiều deal terminal cùng cặp)
    const cancelled = await db.orm.public.Deal.create({
      listingId,
      buyerId,
      sellerId,
      status: "cancelled",
    });
    created.deals.push(cancelled.id);
    expect((await db.orm.public.Deal.first({ id: cancelled.id }))!.status).toBe("cancelled");
  });
});

// ─── 3. Deal structurally separate from finance (§9 Batch 6 Gate) ───

d("Deal is structurally separate from finance", () => {
  it("tạo Deal + DealStatusHistory KHÔNG đụng finance — count không đổi, không reference", async () => {
    const buyerId = await mkUser("buyer");
    const sellerId = await mkUser("seller");
    created.users.push(buyerId, sellerId);

    // seed finance: Order + Payment + Payout + LedgerEntry
    const order = await db.orm.public.Order.create({
      code: `B6-${uid()}`,
      buyerId,
      sellerId,
      status: "awaiting_payment",
      totalAmount: 500_000,
      commissionRate: 5,
      commissionAmount: 25_000,
      sellerPayout: 475_000,
      paymentMethod: "escrow",
      shippingAddress: "123 Đường Test, TP Test",
      shippingPhone: "0901234567",
    });
    created.orders.push(order.id);
    const payment = await db.orm.public.Payment.create({
      orderId: order.id,
      method: "escrow",
      status: "pending",
      amount: 500_000,
      provider: "momo",
    });
    created.payments.push(payment.id);
    const payout = await db.orm.public.Payout.create({
      orderId: order.id,
      sellerId,
      amount: 475_000,
    });
    created.payouts.push(payout.id);
    const ledger = await db.orm.public.LedgerEntry.create({
      txId: `b6-tx-${uid()}`,
      account: "escrow",
      amount: 500_000,
      refType: "order",
      refId: order.id,
    });
    created.ledgerEntries.push(ledger.id);

    // count finance TRƯỚC (suite serial — không writer khác giữa 2 lần đếm)
    const countFinance = async () => ({
      orders: (await db.orm.public.Order.where({}).all()).length,
      payments: (await db.orm.public.Payment.where({}).all()).length,
      payouts: (await db.orm.public.Payout.where({}).all()).length,
      ledger: (await db.orm.public.LedgerEntry.where({}).all()).length,
    });
    const before = await countFinance();

    // tạo Deal + DealStatusHistory (§5.2)
    const deal = await db.orm.public.Deal.create({
      buyerId,
      sellerId,
      agreedPrice: 1_500_000,
      fulfillmentMethod: "meetup",
    });
    created.deals.push(deal.id);
    const history = await db.orm.public.DealStatusHistory.create({
      dealId: deal.id,
      status: "open",
      actorId: buyerId,
      note: "buyer:created",
    });
    expect((await db.orm.public.Deal.first({ id: deal.id }))!.id).toBe(deal.id);
    expect((await db.orm.public.DealStatusHistory.first({ id: history.id }))!.dealId).toBe(deal.id);

    // count finance SAU — KHÔNG đổi (§9 Batch 6 Gate: không Deal action nào
    // tạo Payment/Payout/Wallet/Ledger/Escrow)
    const after = await countFinance();
    expect(after).toEqual(before);

    // không row finance nào reference deal (Deal KHÔNG có FK sang finance,
    // finance KHÔNG có cột nào trỏ deal)
    expect(await db.orm.public.LedgerEntry.where({ refId: deal.id }).all()).toEqual([]);
    expect(await db.orm.public.Payment.where({ orderId: deal.id }).all()).toEqual([]);
    expect(await db.orm.public.Payout.where({ orderId: deal.id }).all()).toEqual([]);
  });
});

// ─── 4. Marker + schema khớp contract sau migrate ───

d("migration leaves the database consistent", () => {
  it("npx prisma db verify exit 0 (marker + schema khớp contract)", async () => {
    // exit code != 0 → promisified execFile reject (lỗi kèm stdout/stderr)
    const { stdout } = await execFileAsync("npx", ["prisma", "db", "verify"], {
      env: process.env,
    });
    expect(stdout).toContain('"ok":true');
  });
});

// ─── 5. Finance legacy giữ nguyên (spec §4.3 + §8.1) ───

d("preserves finance tables", () => {
  it("Order/Payment/Payout/WithdrawRequest/LedgerEntry/Dispute vẫn đọc được", async () => {
    // đọc từng bảng — bảng mất/thêm cột sẽ fail ngay ở đây
    expect(await db.orm.public.Order.where({ id: "nope-0000" }).all()).toEqual([]);
    expect(await db.orm.public.Payment.where({ id: "nope-0000" }).all()).toEqual([]);
    expect(await db.orm.public.Payout.where({ id: "nope-0000" }).all()).toEqual([]);
    expect(await db.orm.public.WithdrawRequest.where({ id: "nope-0000" }).all()).toEqual([]);
    expect(await db.orm.public.LedgerEntry.where({ id: "nope-0000" }).all()).toEqual([]);
    expect(await db.orm.public.Dispute.where({ id: "nope-0000" }).all()).toEqual([]);
  });

  it("Order + Payment seeded đọc lại nguyên vẹn", async () => {
    const buyerId = await mkUser("buyer");
    const sellerId = await mkUser("seller");
    created.users.push(buyerId, sellerId);
    const o = await db.orm.public.Order.create({
      code: `B6-${uid()}`,
      buyerId,
      sellerId,
      status: "awaiting_payment",
      totalAmount: 500_000,
      commissionRate: 5,
      commissionAmount: 25_000,
      sellerPayout: 475_000,
      paymentMethod: "escrow",
      shippingAddress: "123 Đường Test, TP Test",
      shippingPhone: "0901234567",
    });
    created.orders.push(o.id);
    const p = await db.orm.public.Payment.create({
      orderId: o.id,
      method: "escrow",
      status: "pending",
      amount: 500_000,
      provider: "momo",
    });
    created.payments.push(p.id);

    const order = await db.orm.public.Order.first({ id: o.id });
    expect(order!.code).toBe(o.code);
    expect(order!.status).toBe("awaiting_payment");
    expect(order!.totalAmount).toBe(500_000);
    expect(order!.commissionRate).toBe(5);
    expect(order!.commissionAmount).toBe(25_000);
    expect(order!.sellerPayout).toBe(475_000);
    expect(order!.paymentMethod).toBe("escrow");
    const payment = await db.orm.public.Payment.first({ id: p.id });
    expect(payment!.orderId).toBe(o.id);
    expect(payment!.method).toBe("escrow");
    expect(payment!.status).toBe("pending");
    expect(payment!.amount).toBe(500_000);
    expect(payment!.provider).toBe("momo");
  });
});

// ─── 6. Batch 2/3/4/5 tables nhận create + delete round-trip ───

d("preserves batch 2-5 tables", () => {
  it("Batch 2: UserSession/AuditEvent/BetaCohortMembership/SellerVerification round-trip", async () => {
    const userId = await mkUser();
    created.users.push(userId);

    const s = await db.orm.public.UserSession.create({
      userId,
      tokenHash: `hash-${uid()}`,
      expiresAt: isoFuture(),
    });
    created.sessions.push(s.id);
    expect((await db.orm.public.UserSession.first({ id: s.id }))!.tokenHash).toBe(s.tokenHash);

    const ae = await db.orm.public.AuditEvent.create({
      actorId: userId,
      action: "session.revoked",
      reason: "typed_reason_code",
    });
    created.auditEvents.push(ae.id);
    expect((await db.orm.public.AuditEvent.first({ id: ae.id }))!.action).toBe("session.revoked");

    const bm = await db.orm.public.BetaCohortMembership.create({
      userId,
      cohort: "internal",
      status: "active",
    });
    created.betaMemberships.push(bm.id);
    const bmRow = await db.orm.public.BetaCohortMembership.first({ id: bm.id });
    expect(bmRow!.cohort).toBe("internal");
    expect(bmRow!.status).toBe("active");

    const sv = await db.orm.public.SellerVerification.create({
      userId,
      policyVersion: "v1",
    });
    created.sellerVerifications.push(sv.id);
    const svRow = await db.orm.public.SellerVerification.first({ id: sv.id });
    expect(svRow!.status).toBe("pending"); // default
    expect(svRow!.policyVersion).toBe("v1");

    // delete round-trip — migration Batch 6 không làm xáo trộn graph Batch 2
    await db.orm.public.UserSession.where({ id: s.id }).delete();
    expect(await db.orm.public.UserSession.first({ id: s.id })).toBeNull();
    await db.orm.public.AuditEvent.where({ id: ae.id }).delete();
    expect(await db.orm.public.AuditEvent.first({ id: ae.id })).toBeNull();
    await db.orm.public.BetaCohortMembership.where({ id: bm.id }).delete();
    expect(await db.orm.public.BetaCohortMembership.first({ id: bm.id })).toBeNull();
    await db.orm.public.SellerVerification.where({ id: sv.id }).delete();
    expect(await db.orm.public.SellerVerification.first({ id: sv.id })).toBeNull();
  });

  it("Batch 3: UserBlock/UserSuspension/ModerationCase/AbuseReport round-trip", async () => {
    const userId = await mkUser("seller");
    const counterpartId = await mkUser("buyer");
    const actorId = await mkUser("admin");
    created.users.push(userId, counterpartId, actorId);

    const blk = await db.orm.public.UserBlock.create({
      blockerId: userId,
      blockedId: counterpartId,
    });
    created.userBlocks.push(blk.id);
    const blkRow = await db.orm.public.UserBlock.first({ id: blk.id });
    expect(blkRow!.blockerId).toBe(userId);
    expect(blkRow!.blockedId).toBe(counterpartId);

    const sus = await db.orm.public.UserSuspension.create({
      userId,
      reasonCode: "confirmed_abuse",
      suspendedById: actorId,
    });
    created.userSuspensions.push(sus.id);
    const susRow = await db.orm.public.UserSuspension.first({ id: sus.id });
    expect(susRow!.status).toBe("active"); // default
    expect(susRow!.reasonCode).toBe("confirmed_abuse");

    const mc = await db.orm.public.ModerationCase.create({
      targetType: "listing",
      targetId: `listing-${uid()}`,
      reasonCategory: "suspected_scam",
    });
    created.moderationCases.push(mc.id);
    const mcRow = await db.orm.public.ModerationCase.first({ id: mc.id });
    expect(mcRow!.state).toBe("open"); // default
    expect(mcRow!.reasonCategory).toBe("suspected_scam");

    const ar = await db.orm.public.AbuseReport.create({
      reporterId: userId,
      targetType: "listing",
      targetId: `listing-${uid()}`,
      reasonCode: "suspected_scam",
      caseId: mc.id,
    });
    created.abuseReports.push(ar.id);
    expect((await db.orm.public.AbuseReport.first({ id: ar.id }))!.reasonCode).toBe(
      "suspected_scam",
    );

    // delete round-trip (thứ tự ngược FK: report → case → suspension → block)
    await db.orm.public.AbuseReport.where({ id: ar.id }).delete();
    expect(await db.orm.public.AbuseReport.first({ id: ar.id })).toBeNull();
    await db.orm.public.ModerationCase.where({ id: mc.id }).delete();
    expect(await db.orm.public.ModerationCase.first({ id: mc.id })).toBeNull();
    await db.orm.public.UserSuspension.where({ id: sus.id }).delete();
    expect(await db.orm.public.UserSuspension.first({ id: sus.id })).toBeNull();
    await db.orm.public.UserBlock.where({ id: blk.id }).delete();
    expect(await db.orm.public.UserBlock.first({ id: blk.id })).toBeNull();
  });

  it("Batch 4: ListingImageUpload round-trip", async () => {
    const ownerUserId = await mkUser("seller");
    created.users.push(ownerUserId);
    const up = await db.orm.public.ListingImageUpload.create({
      ownerUserId,
      storageKey: `${uid()}.webp`,
      bytes: 204_800,
      width: 2560,
      height: 1440,
    });
    created.imageUploads.push(up.id);
    const row = await db.orm.public.ListingImageUpload.first({ id: up.id });
    expect(row!.ownerUserId).toBe(ownerUserId);
    expect(row!.bytes).toBe(204_800);
    await db.orm.public.ListingImageUpload.where({ id: up.id }).delete();
    expect(await db.orm.public.ListingImageUpload.first({ id: up.id })).toBeNull();
  });

  it("Batch 5: ProductEvent/SearchAlias round-trip", async () => {
    const sellerId = await mkUser("seller");
    created.users.push(sellerId);
    const categoryId = await mkCategory();
    created.categories.push(categoryId);
    const listingId = await mkListing(sellerId, categoryId);
    created.listings.push(listingId);

    const ev = await db.orm.public.ProductEvent.create({
      name: "listing_viewed",
      schemaVersion: "1",
      listingId,
      metadata: { ownerView: false, fromSearch: true },
    });
    created.productEvents.push(ev.id);
    const evRow = await db.orm.public.ProductEvent.first({ id: ev.id });
    expect(evRow!.name).toBe("listing_viewed");
    expect(evRow!.pseudonymKeyVersion).toBe("1");
    expect(evRow!.isInternal).toBe(false);

    // target=brand ⇒ brandId set (CHECK search_alias_target_ids — Batch 5)
    const brand = await db.orm.public.Brand.create({
      name: `B6 brand ${uid()}`,
      slug: `b6-brand-${uid()}`,
    });
    const alias = await db.orm.public.SearchAlias.create({
      alias: `b6-${uid()}`,
      target: "brand",
      brandId: brand.id,
    });
    created.searchAliases.push(alias.id);
    expect((await db.orm.public.SearchAlias.first({ id: alias.id }))!.target).toBe("brand");

    await db.orm.public.ProductEvent.where({ id: ev.id }).delete();
    expect(await db.orm.public.ProductEvent.first({ id: ev.id })).toBeNull();
    await db.orm.public.SearchAlias.where({ id: alias.id }).delete();
    expect(await db.orm.public.SearchAlias.first({ id: alias.id })).toBeNull();
    await db.orm.public.Brand.where({ id: brand.id }).delete();
    expect(await db.orm.public.Brand.first({ id: brand.id })).toBeNull();
  });

  it("Listing round-trip cột Batch 4 + Batch 5 nguyên vẹn (provinceLevelCode/locationSource/searchTextNormalized)", async () => {
    const sellerId = await mkUser("seller");
    created.users.push(sellerId);
    const categoryId = await mkCategory();
    created.categories.push(categoryId);

    const listingId = await mkListing(sellerId, categoryId, {
      provinceLevelCode: "ha-noi", // Batch 4 (FD-1: 34 đơn vị)
      locationDisplayName: "Gần Cầu Giấy",
      locationSource: "seller_declared", // Batch 5
      searchTextNormalized: "loa jbl charge 5 nhu moi", // Batch 5
    });
    created.listings.push(listingId);

    const row = await db.orm.public.Listing.first({ id: listingId });
    expect(row!.provinceLevelCode).toBe("ha-noi");
    expect(row!.locationDisplayName).toBe("Gần Cầu Giấy");
    expect(row!.locationSource).toBe("seller_declared");
    expect(row!.searchTextNormalized).toBe("loa jbl charge 5 nhu moi");
    // legacy fields không bị đụng (additive-only)
    expect(row!.city).toBe("Hà Nội");
    expect(row!.title).toBeTruthy();
  });
});
