import { db } from "@/src/prisma/db";
import { verifyMomoCallback, type MomoCallbackBody } from "@/src/lib/momo";
import { markEscrowPaid, markExchangeTopupPaid } from "@/src/lib/escrow";

/**
 * POST /api/payments/momo/ipn — webhook server-to-server từ MoMo.
 * Nguồn xác nhận chính thức (authoritative) — verify chữ ký, idempotent.
 * MoMo yêu cầu response 204 khi xử lý thành công.
 */
export async function POST(request: Request) {
  const body = (await request.json()) as MomoCallbackBody;

  // 1. verify chữ ký — chặn webhook giả mạo
  if (!verifyMomoCallback(body)) {
    console.warn("[momo:ipn] INVALID_SIGNATURE", JSON.stringify(body).slice(0, 300));
    return new Response(null, { status: 401 });
  }

  // 2. resultCode 0 = thành công
  if (body.resultCode !== 0) {
    console.log("[momo:ipn] FAILED", body.resultCode, body.message);
    return new Response(null, { status: 204 }); // MoMo chỉ cần ack
  }

  // 3. phân tích orderId phía mình: ORDER-<uuid> | EXOFFER-<uuid>
  const momoOrderId = body.orderId ?? "";
  const providerTxnId = `MOMO-${body.transId ?? body.requestId ?? Date.now()}`;

  try {
    if (momoOrderId.startsWith("ORDER-")) {
      const orderId = momoOrderId.slice("ORDER-".length);
      // verify amount khớp đơn — chống sửa tiền
      const order = await db.orm.public.Order.first({ id: orderId });
      if (!order || order.totalAmount !== body.amount) {
        console.warn("[momo:ipn] AMOUNT_MISMATCH", momoOrderId, body.amount);
        return new Response(null, { status: 204 });
      }
      await markEscrowPaid(orderId, providerTxnId, "momo");
    } else if (momoOrderId.startsWith("EXOFFER-")) {
      const offerId = momoOrderId.slice("EXOFFER-".length);
      const offer = await db.orm.public.ExchangeOffer.first({ id: offerId });
      if (!offer || offer.cashTopup !== body.amount) {
        console.warn("[momo:ipn] AMOUNT_MISMATCH", momoOrderId, body.amount);
        return new Response(null, { status: 204 });
      }
      await markExchangeTopupPaid(offerId, providerTxnId, "momo");
    }
  } catch (e) {
    console.error("[momo:ipn] PROCESS_ERROR", e);
    return new Response(null, { status: 500 });
  }

  return new Response(null, { status: 204 });
}
