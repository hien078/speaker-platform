import { db } from "@/src/prisma/db.client";
import { getCurrentUser } from "@/src/lib/auth";
import { createMomoPayment } from "@/src/lib/momo";
import { rateLimitRequest } from "@/src/lib/rate-limit";
import {
  FINANCIAL_FEATURES_DISABLED,
  financialFeaturesEnabled,
} from "@/src/lib/financial-features";

function appUrl(): string {
  // Dev default khớp .env.example (port 3000); production đặt NEXT_PUBLIC_APP_URL
  // thành HTTPS domain công khai — MoMo IPN cần URL công khai.
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

/**
 * POST /api/payments/momo/create
 * Body: { orderId: string } hoặc { exchangeOfferId: string }
 * → tạo thanh toán MoMo, trả { payUrl } để client redirect.
 */
export async function POST(request: Request) {
  // Ranh giới tài chính TRƯỚC mọi thứ: không rate-limit/auth/đọc đơn/tạo
  // provider request khi tài chính tắt — typed fail closed (spec §4.1, §5.1)
  if (!financialFeaturesEnabled()) {
    return Response.json({ error: FINANCIAL_FEATURES_DISABLED }, { status: 503 });
  }

  // tạo thanh toán = endpoint nhạy cảm tiền — rate limit/IP trước mọi xử lý
  const limited = await rateLimitRequest(request, "payment:create", {
    limit: 10,
    windowMs: 60_000,
  });
  if (limited) return limited;

  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "UNAUTHENTICATED" }, { status: 401 });

  const body = (await request.json()) as { orderId?: string; exchangeOfferId?: string };

  try {
    if (body.orderId) {
      // ─── Thanh toán escrow cho đơn ───
      const order = await db.orm.public.Order.first({ id: body.orderId });
      if (!order || order.buyerId !== user.id) {
        return Response.json({ error: "NOT_FOUND" }, { status: 404 });
      }
      if (order.status !== "awaiting_payment") {
        return Response.json({ error: "ALREADY_PAID" }, { status: 400 });
      }

      const result = await createMomoPayment({
        orderId: `ORDER-${order.id}`, // mã duy nhất phía MoMo
        amount: order.totalAmount,
        orderInfo: `LoaViet escrow — đơn ${order.code}`,
        redirectUrl: `${appUrl()}/payments/momo/return`,
        ipnUrl: `${appUrl()}/api/payments/momo/ipn`,
      });
      return Response.json({ payUrl: result.payUrl, requestId: result.requestId });
    }

    if (body.exchangeOfferId) {
      // ─── Nạp tiền bù trao đổi ───
      const offer = await db.orm.public.ExchangeOffer.first({ id: body.exchangeOfferId });
      if (!offer || offer.buyerId !== user.id) {
        return Response.json({ error: "NOT_FOUND" }, { status: 404 });
      }
      if (offer.status !== "accepted" || offer.cashTopup <= 0) {
        return Response.json({ error: "INVALID_STATE" }, { status: 400 });
      }

      const result = await createMomoPayment({
        orderId: `EXOFFER-${offer.id}`,
        amount: offer.cashTopup,
        orderInfo: `LoaViet tiền bù trao đổi — offer ${offer.id.slice(0, 8)}`,
        redirectUrl: `${appUrl()}/payments/momo/return`,
        ipnUrl: `${appUrl()}/api/payments/momo/ipn`,
      });
      return Response.json({ payUrl: result.payUrl, requestId: result.requestId });
    }

    return Response.json({ error: "MISSING_TARGET" }, { status: 400 });
  } catch (e) {
    console.error("[momo:create]", e);
    return Response.json(
      { error: "MOMO_ERROR", message: e instanceof Error ? e.message : "unknown" },
      { status: 502 },
    );
  }
}
