import type { OtpChannel, OtpPurpose } from "@/src/lib/otp";
import { peekDevOtpInbox } from "@/src/lib/verification-delivery";

/**
 * GET /api/dev/otp-inbox?target=&purpose=&channel= — seam truy xuất mã OTP cho
 * dev thủ công (curl), dùng peekDevOtpInbox của adapter in-memory.
 *
 * DEV/TEST ONLY — unreachable in production BY CONSTRUCTION: NODE_ENV ===
 * "production" → 404 với body rỗng TRƯỚC khi chạm inbox (peekDevOtpInbox cũng
 * throw DEV_OTP_INBOX_UNAVAILABLE ở production — hai lớp, không phải convention).
 * Không có env flag riêng để bật route này ở production (cùng posture với
 * src/lib/financial-features.ts — không query/cookie/header nào điều khiển được).
 *
 * KHÔNG log mã (spec §4.8) — response trả cho chính dev đang curl, không qua log.
 */
export async function GET(request: Request): Promise<Response> {
  // Production: route chết — 404 TRƯỚC mọi inbox access.
  if (process.env.NODE_ENV === "production") {
    return new Response(null, { status: 404 });
  }

  const url = new URL(request.url);
  const target = url.searchParams.get("target");
  const purpose = url.searchParams.get("purpose");
  const channel = url.searchParams.get("channel");

  if (!target || !purpose || !channel) {
    return Response.json(
      { error: "MISSING_QUERY", message: "cần đủ ?target=&purpose=&channel=" },
      { status: 400 },
    );
  }

  const code = peekDevOtpInbox(
    target,
    purpose as OtpPurpose,
    channel as OtpChannel,
  );
  return Response.json({ code });
}
