import "server-only";
import { db } from "@/src/prisma/db";
import { recordLedgerTx, escrowIn } from "@/src/lib/ledger";
import { notify } from "@/src/lib/notify";

const AUTO_RELEASE_DAYS = Number(process.env.ESCROW_AUTO_RELEASE_DAYS ?? 7);

/**
 * Đánh dấu escrow đã nhận tiền — idempotent.
 * Dùng bởi: IPN MoMo, return page, mock gateway.
 * Trả về true nếu lần đầu xử lý, false nếu đã xử lý rồi.
 */
export async function markEscrowPaid(
  orderId: string,
  providerTxnId: string,
  provider: string,
): Promise<boolean> {
  const order = await db.orm.public.Order.first({ id: orderId });
  if (!order) return false;
  if (order.status !== "awaiting_payment") return false; // đã xử lý

  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.orm.public.Payment
      .where({ orderId })
      .update({ status: "held", providerTxnId, paidAt: now, provider });
    await tx.orm.public.Order
      .where({ id: orderId })
      .update({
        status: "paid_escrow",
        autoReleaseAt: new Date(Date.now() + AUTO_RELEASE_DAYS * 24 * 60 * 60 * 1000).toISOString(),
      });
    await tx.orm.public.OrderStatusHistory.create({
      orderId,
      status: "paid_escrow",
      note: `Thanh toán escrow qua ${provider} — GD ${providerTxnId}`,
      actorId: order.buyerId,
    });
    await recordLedgerTx(tx, "payment", orderId, escrowIn(order.buyerId, order.totalAmount, `Escrow đơn ${order.code} (${provider})`));
  });
  await notify(order.sellerId, "order", `Đơn ${order.code} đã thanh toán`, `Tiền đã vào escrow qua ${provider} — bạn có thể gửi hàng`, `/orders/${orderId}`);
  return true;
}

/** Đánh dấu tiền bù trao đổi đã vào escrow — idempotent */
export async function markExchangeTopupPaid(
  offerId: string,
  providerTxnId: string,
  provider: string,
): Promise<boolean> {
  const offer = await db.orm.public.ExchangeOffer.first({ id: offerId });
  if (!offer || offer.status !== "accepted" || offer.cashTopup <= 0) return false;

  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.orm.public.Payment
      .where({ exchangeOfferId: offerId })
      .update({ status: "held", providerTxnId, paidAt: now, provider });
    await tx.orm.public.ExchangeOffer
      .where({ id: offerId })
      .update({ status: "paid" });
    // ledger: escrow nhận tiền bù qua cổng thật
    const { recordLedgerTx, escrowIn } = await import("@/src/lib/ledger");
    await recordLedgerTx(tx, "exchange", offerId, escrowIn(offer.buyerId, offer.cashTopup, `Tiền bù trao đổi (${provider})`));
  });
  const listing = await db.orm.public.Listing.first({ id: offer.listingId });
  if (listing) {
    await notify(listing.sellerId, "order", `Tiền bù ${offer.cashTopup.toLocaleString("vi-VN")}₫ đã vào escrow`, "Người mua đã nạp tiền bù trao đổi — có thể bắt đầu trao đổi", "/exchange");
  }
  return true;
}
