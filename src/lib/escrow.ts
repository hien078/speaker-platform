import "server-only";
import { db } from "@/src/prisma/db.client";
import { recordLedgerTx, escrowIn } from "@/src/lib/ledger";
import { notify } from "@/src/lib/notify";

const AUTO_RELEASE_DAYS = Number(process.env.ESCROW_AUTO_RELEASE_DAYS ?? 7);

/**
 * Đánh dấu escrow đã nhận tiền — idempotent + an toàn concurrent.
 * Dùng bởi: IPN MoMo, return page, mock gateway.
 *
 * Race đã chứng minh: check `status` NGOÀI transaction rồi update — 2 callback
 * đồng thời (IPN + return page cùng orderId) cùng đọc awaiting_payment →
 * cùng ghi ledger escrowIn 2 lần → double-credit, phá invariant double-entry.
 * Fix: claim bằng conditional UPDATE (`where status = awaiting_payment`) BÊN
 * TRONG transaction — row lock + recheck sau khi chờ: đúng 1 request thắng.
 *
 * Trả về true nếu lần đầu xử lý, false nếu đã xử lý rồi (hoặc request khác thắng).
 */
export async function markEscrowPaid(
  orderId: string,
  providerTxnId: string,
  provider: string,
): Promise<boolean> {
  const order = await db.orm.public.Order.first({ id: orderId });
  if (!order) return false;
  if (order.status !== "awaiting_payment") return false; // fast path — đã xử lý

  const now = new Date().toISOString();
  const autoReleaseAt = new Date(
    Date.now() + AUTO_RELEASE_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const applied = await db.transaction(async (tx) => {
    // Claim atomic: UPDATE ... WHERE id AND status — 1 statement, row lock +
    // recheck predicate của Postgres. KHÔNG dùng ORM .update() cho claim: nó là
    // select-then-update-by-identity (không recheck status) — 2 request đồng thời
    // cùng thấy row cũ → cùng "thắng" → double-credit ledger.
    const claimed = await tx.orm.public.Order
      .where({ id: orderId, status: "awaiting_payment" })
      .updateAll({ status: "paid_escrow", autoReleaseAt });
    if (claimed.length === 0) return false; // request khác đã xử lý

    const paymentCount = await tx.orm.public.Payment
      .where({ orderId, status: "pending" })
      .updateAndCount({ status: "held", providerTxnId, paidAt: now, provider });
    // Invariant: 1 order escrow = đúng 1 payment pending. Sai cấu trúc → rollback,
    // không bao giờ ghi ledger lên trạng thái mập mờ.
    if (paymentCount !== 1) {
      throw new Error(`ESCROW_PAYMENT_INVARIANT: orderId=${orderId} có ${paymentCount} payment pending`);
    }

    await tx.orm.public.OrderStatusHistory.create({
      orderId,
      status: "paid_escrow",
      note: `Thanh toán escrow qua ${provider} — GD ${providerTxnId}`,
      actorId: order.buyerId,
    });
    await recordLedgerTx(
      tx,
      "payment",
      orderId,
      escrowIn(order.buyerId, order.totalAmount, `Escrow đơn ${order.code} (${provider})`),
    );
    return true;
  });
  if (!applied) return false;

  await notify(order.sellerId, "order", `Đơn ${order.code} đã thanh toán`, `Tiền đã vào escrow qua ${provider} — bạn có thể gửi hàng`, `/orders/${orderId}`);
  return true;
}

/** Đánh dấu tiền bù trao đổi đã vào escrow — idempotent + an toàn concurrent
 * (cùng conditional-UPDATE claim như markEscrowPaid). */
export async function markExchangeTopupPaid(
  offerId: string,
  providerTxnId: string,
  provider: string,
): Promise<boolean> {
  const offer = await db.orm.public.ExchangeOffer.first({ id: offerId });
  if (!offer || offer.status !== "accepted" || offer.cashTopup <= 0) return false;

  const now = new Date().toISOString();
  const applied = await db.transaction(async (tx) => {
    // Claim atomic: UPDATE ... WHERE id AND status='accepted' — xem comment
    // markEscrowPaid vì sao KHÔNG dùng ORM .update() cho claim.
    const claimed = await tx.orm.public.ExchangeOffer
      .where({ id: offerId, status: "accepted" })
      .updateAll({ status: "paid" });
    if (claimed.length === 0) return false;

    const paymentCount = await tx.orm.public.Payment
      .where({ exchangeOfferId: offerId, status: "pending" })
      .updateAndCount({ status: "held", providerTxnId, paidAt: now, provider });
    if (paymentCount !== 1) {
      throw new Error(`ESCROW_PAYMENT_INVARIANT: offerId=${offerId} có ${paymentCount} payment pending`);
    }

    // ledger: escrow nhận tiền bù qua cổng thật
    const { recordLedgerTx, escrowIn } = await import("@/src/lib/ledger");
    await recordLedgerTx(tx, "exchange", offerId, escrowIn(offer.buyerId, offer.cashTopup, `Tiền bù trao đổi (${provider})`));
    return true;
  });
  if (!applied) return false;

  const listing = await db.orm.public.Listing.first({ id: offer.listingId });
  if (listing) {
    await notify(listing.sellerId, "order", `Tiền bù ${offer.cashTopup.toLocaleString("vi-VN")}₫ đã vào escrow`, "Người mua đã nạp tiền bù trao đổi — có thể bắt đầu trao đổi", "/exchange");
  }
  return true;
}
