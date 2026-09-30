import { redirect } from "next/navigation";
import { db } from "@/src/prisma/db";
import { verifyMomoCallback, type MomoCallbackBody } from "@/src/lib/momo";
import { markEscrowPaid, markExchangeTopupPaid } from "@/src/lib/escrow";

export const dynamic = "force-dynamic";
export const metadata = { title: "Kết quả thanh toán MoMo" };

/**
 * GET /payments/momo/return — MoMo redirect buyer về đây sau khi thanh toán.
 * Verify chữ ký từ query params → đánh dấu escrow (idempotent, IPN đã làm thì bỏ qua)
 * → chuyển về trang đơn hàng.
 */
export default async function MomoReturnPage({
  searchParams,
}: PageProps<"/payments/momo/return">) {
  const sp = (await searchParams) as Record<string, string>;

  const body: MomoCallbackBody = {
    partnerCode: sp.partnerCode,
    orderId: sp.orderId,
    requestId: sp.requestId,
    amount: sp.amount ? Number(sp.amount) : undefined,
    transId: sp.transId,
    resultCode: sp.resultCode !== undefined ? Number(sp.resultCode) : undefined,
    message: sp.message,
    payType: sp.payType,
    responseTime: sp.responseTime ? Number(sp.responseTime) : undefined,
    extraData: sp.extraData,
    orderInfo: sp.orderInfo,
    signature: sp.signature,
  };

  const providerTxnId = `MOMO-${body.transId ?? body.requestId ?? Date.now()}`;
  let target = "/orders";

  // verify chữ ký — chỉ tin query params hợp lệ
  if (verifyMomoCallback(body) && body.resultCode === 0 && body.orderId) {
    if (body.orderId.startsWith("ORDER-")) {
      const orderId = body.orderId.slice("ORDER-".length);
      await markEscrowPaid(orderId, providerTxnId, "momo");
      target = `/orders/${orderId}?paid=1`;
    } else if (body.orderId.startsWith("EXOFFER-")) {
      const offerId = body.orderId.slice("EXOFFER-".length);
      await markExchangeTopupPaid(offerId, providerTxnId, "momo");
      target = "/exchange?paid=1";
    }
  } else {
    console.warn("[momo:return] INVALID_SIGNATURE_OR_FAILED", JSON.stringify(body).slice(0, 200));
    // thất bại → về đơn để xem trạng thái hiện tại
    if (body.orderId?.startsWith("ORDER-")) {
      target = `/orders/${body.orderId.slice(6)}`;
    }
  }

  redirect(target);
}
