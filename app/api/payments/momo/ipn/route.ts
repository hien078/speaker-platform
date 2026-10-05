import { db } from "@/src/prisma/db.client";
import { verifyMomoCallback, type MomoCallbackBody } from "@/src/lib/momo";
import { markEscrowPaid, markExchangeTopupPaid } from "@/src/lib/escrow";
import { rateLimitRequest } from "@/src/lib/rate-limit";
import { captureError } from "@/src/lib/observability";
import {
  FINANCIAL_FEATURES_DISABLED,
  financialFeaturesEnabled,
} from "@/src/lib/financial-features";

/**
 * POST /api/payments/momo/ipn — webhook server-to-server từ MoMo.
 * Nguồn xác nhận chính thức (authoritative) — verify chữ ký, idempotent.
 * MoMo yêu cầu response 204 khi xử lý thành công.
 */
export async function POST(request: Request) {
  // Ranh giới tài chính TRƯỚC mọi thứ: khi tắt, KHÔNG parse payload provider
  // (kể cả hợp lệ) rồi mutate escrow — typed fail closed (spec §4.1, §5.1).
  // 503 + mã ổn định: provider retry an toàn, không ack công việc chưa làm.
  if (!financialFeaturesEnabled()) {
    return Response.json({ error: FINANCIAL_FEATURES_DISABLED }, { status: 503 });
  }

  // MoMo retry khi lỗi — limit rộng, chỉ chặn flood (fail open theo rateLimitRequest)
  const limited = await rateLimitRequest(request, "momo:ipn", {
    limit: 60,
    windowMs: 60_000,
  });
  if (limited) return limited;

  let body: MomoCallbackBody;
  try {
    body = (await request.json()) as MomoCallbackBody;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return new Response(null, { status: 400 });
    }
  } catch {
    // body không phải JSON — 400 thay vì để throw thành 500 unhandled
    return new Response(null, { status: 400 });
  }

  // 1. verify chữ ký — chặn webhook giả mạo
  if (!verifyMomoCallback(body)) {
    // KHÔNG log body — callback chưa xác thực là dữ liệu ngoài, có thể nhồi gì cũng được
    captureError("momo:ipn", new Error("INVALID_SIGNATURE"), {
      orderId: body.orderId,
      resultCode: body.resultCode,
    });
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
    captureError("momo:ipn", e, { orderId: momoOrderId });
    return new Response(null, { status: 500 });
  }

  return new Response(null, { status: 204 });
}
