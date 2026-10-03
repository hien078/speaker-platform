import "server-only";
import { timingSafeEqual } from "node:crypto";

/**
 * Auth cho các endpoint cron (scheduler gọi định kỳ).
 *
 * Endpoint cron di chuyển tiền thật (escrow auto-release) phải:
 * - fail closed: chưa cấu hình CRON_SECRET → từ chối mọi request
 * - so sánh timing-safe: không leak secret qua thời gian phản hồi
 *
 * Scheduler gửi:  Authorization: Bearer <CRON_SECRET>
 */
export function verifyCronAuth(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed — chưa cấu hình thì không chạy

  const authorization = request.headers.get("authorization");
  if (!authorization) return false;
  if (!authorization.startsWith("Bearer ")) return false;

  return timingSafeEqualStr(authorization.slice("Bearer ".length), secret);
}

/** So sánh chuỗi timing-safe; độ dài khác nhau → false ngay (không so nội dung) */
function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
