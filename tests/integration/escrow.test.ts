/**
 * Escrow integration tests — chạy trên scratch DB (script scripts/test-integration.sh
 * tạo postgres container riêng + migrate + dọn). KHÔNG chạy trong `npm test` mặc định.
 *
 * Bảo vệ financial invariants:
 * - markEscrowPaid idempotent: gọi lại không ghi ledger lần 2
 * - concurrent (IPN + return page cùng lúc): đúng 1 ledger credit
 * - markExchangeTopupPaid idempotent tương tự
 * - reconcileEscrow: tổng ledger escrow khớp tổng Payment held
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { db } from "../../src/prisma/db.client";
import { markEscrowPaid, markExchangeTopupPaid } from "../../src/lib/escrow";
import { reconcileEscrow } from "../../src/lib/ledger";

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

let seq = 0;
const uid = () => `it-${Date.now()}-${seq++}`;

async function mkUser(role: "buyer" | "seller"): Promise<string> {
  const u = await db.orm.public.User.create({
    email: `${uid()}@integration.test`,
    passwordHash: "x",
    name: `IT ${role}`,
    role,
  });
  return u.id;
}

async function mkOrder(buyerId: string, sellerId: string, total: number): Promise<string> {
  const o = await db.orm.public.Order.create({
    code: `IT-${uid()}`,
    buyerId,
    sellerId,
    status: "awaiting_payment",
    totalAmount: total,
    commissionRate: 5,
    commissionAmount: Math.round(total * 0.05),
    sellerPayout: total - Math.round(total * 0.05),
    paymentMethod: "escrow",
    shippingAddress: "123 Đường Test, TP Test",
    shippingPhone: "0901234567",
  });
  await db.orm.public.Payment.create({
    orderId: o.id,
    method: "escrow",
    status: "pending",
    amount: total,
    provider: "momo",
  });
  return o.id;
}

async function ledgerEscrowFor(refId: string): Promise<number> {
  const agg = await db.orm.public.LedgerEntry
    .where({ account: "escrow", refId })
    .aggregate((a) => ({ total: a.sum("amount") }));
  return agg.total ?? 0;
}

async function mkExchangeOffer(buyerId: string, sellerId: string, topup: number): Promise<{
  offerId: string; listingId: string; categoryId: string;
}> {
  const cat = await db.orm.public.Category.create({
    name: `IT cat ${uid()}`,
    slug: `it-cat-${uid()}`,
  });
  const listing = await db.orm.public.Listing.create({
    sellerId,
    categoryId: cat.id,
    title: `Loa IT ${uid()}`,
    slug: `loa-it-${uid()}`,
    description: "integration test",
    condition: "good",
    price: 1_000_000,
    status: "approved",
    city: "Hà Nội",
  });
  const offer = await db.orm.public.ExchangeOffer.create({
    listingId: listing.id,
    buyerId,
    cashTopup: topup,
    status: "accepted",
  });
  await db.orm.public.Payment.create({
    exchangeOfferId: offer.id,
    method: "escrow",
    status: "pending",
    amount: topup,
    provider: "momo",
  });
  return { offerId: offer.id, listingId: listing.id, categoryId: cat.id };
}

// dọn đúng dữ liệu test mình tạo (DB scratch — nhưng vẫn dọn sạch theo ref)
const created = {
  users: [] as string[],
  orders: [] as string[],
  offers: [] as { offerId: string; listingId: string; categoryId: string }[],
};

afterEach(async () => {
  for (const id of created.orders) {
    await db.orm.public.LedgerEntry.where({ refId: id }).delete();
    await db.orm.public.OrderStatusHistory.where({ orderId: id }).delete();
    await db.orm.public.Payment.where({ orderId: id }).delete();
    await db.orm.public.Payout.where({ orderId: id }).delete();
    await db.orm.public.Order.where({ id }).delete();
  }
  for (const { offerId, listingId, categoryId } of created.offers) {
    await db.orm.public.LedgerEntry.where({ refId: offerId }).delete();
    await db.orm.public.Payment.where({ exchangeOfferId: offerId }).delete();
    await db.orm.public.ExchangeOffer.where({ id: offerId }).delete();
    await db.orm.public.Listing.where({ id: listingId }).delete();
    await db.orm.public.Category.where({ id: categoryId }).delete();
  }
  for (const id of created.users) {
    await db.orm.public.Notification.where({ userId: id }).delete();
    await db.orm.public.User.where({ id }).delete();
  }
  created.orders.length = 0;
  created.offers.length = 0;
  created.users.length = 0;
});

afterAll(async () => {
  await db.close();
});

d("markEscrowPaid — idempotency & race", () => {
  it("lần 1 true, lần 2 false — ledger chỉ 1 credit", async () => {
    const buyer = await mkUser("buyer");
    const seller = await mkUser("seller");
    created.users.push(buyer, seller);
    const orderId = await mkOrder(buyer, seller, 500_000);
    created.orders.push(orderId);

    const first = await markEscrowPaid(orderId, "MOMO-1", "momo");
    const second = await markEscrowPaid(orderId, "MOMO-2", "momo");

    expect(first).toBe(true);
    expect(second).toBe(false); // idempotent — không ghi ledger lần 2

    const order = await db.orm.public.Order.first({ id: orderId });
    expect(order!.status).toBe("paid_escrow");
    const payment = await db.orm.public.Payment.where({ orderId }).first();
    expect(payment!.status).toBe("held");
    expect(payment!.providerTxnId).toBe("MOMO-1"); // txn của lần thắng giữ nguyên

    expect(await ledgerEscrowFor(orderId)).toBe(500_000); // đúng 1 escrowIn
  });

  it("concurrent: 2 markEscrowPaid đồng thời → đúng 1 thắng, ledger 1 credit", async () => {
    const buyer = await mkUser("buyer");
    const seller = await mkUser("seller");
    created.users.push(buyer, seller);
    const orderId = await mkOrder(buyer, seller, 300_000);
    created.orders.push(orderId);

    const results = await Promise.all([
      markEscrowPaid(orderId, "MOMO-A", "momo"),
      markEscrowPaid(orderId, "MOMO-B", "momo"),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1); // đúng 1 thắng
    expect(await ledgerEscrowFor(orderId)).toBe(300_000); // KHÔNG double-credit
  });

  it("order không tồn tại → false, không đụng ledger", async () => {
    const res = await markEscrowPaid("khong-ton-tai-0000", "MOMO-X", "momo");
    expect(res).toBe(false);
  });
});

d("markExchangeTopupPaid — idempotency", () => {
  it("lần 1 true, lần 2 false — ledger 1 credit", async () => {
    const buyer = await mkUser("buyer");
    const seller = await mkUser("seller");
    created.users.push(buyer, seller);
    const { offerId, listingId, categoryId } = await mkExchangeOffer(buyer, seller, 200_000);
    created.offers.push({ offerId, listingId, categoryId });

    const first = await markExchangeTopupPaid(offerId, "MOMO-1", "momo");
    const second = await markExchangeTopupPaid(offerId, "MOMO-2", "momo");
    expect(first).toBe(true);
    expect(second).toBe(false);

    const offer = await db.orm.public.ExchangeOffer.first({ id: offerId });
    expect(offer!.status).toBe("paid");
    expect(await ledgerEscrowFor(offerId)).toBe(200_000);
  });

  it("concurrent → đúng 1 thắng", async () => {
    const buyer = await mkUser("buyer");
    const seller = await mkUser("seller");
    created.users.push(buyer, seller);
    const { offerId, listingId, categoryId } = await mkExchangeOffer(buyer, seller, 150_000);
    created.offers.push({ offerId, listingId, categoryId });

    const results = await Promise.all([
      markExchangeTopupPaid(offerId, "MOMO-A", "momo"),
      markExchangeTopupPaid(offerId, "MOMO-B", "momo"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await ledgerEscrowFor(offerId)).toBe(150_000);
  });
});

d("reconcileEscrow — đối chiếu ledger vs Payment held", () => {
  it("cân bằng sau escrow in", async () => {
    const buyer = await mkUser("buyer");
    const seller = await mkUser("seller");
    created.users.push(buyer, seller);
    const orderId = await mkOrder(buyer, seller, 777_000);
    created.orders.push(orderId);

    await markEscrowPaid(orderId, "MOMO-R", "momo");
    const r = await reconcileEscrow();
    expect(r.balanced).toBe(true);
  });
});
