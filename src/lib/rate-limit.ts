import "server-only";
import { captureError } from "@/src/lib/observability";

/**
 * Rate limiting in-memory — sliding window theo key `<scope>:<client-ip>`.
 *
 * GIỚI HẠN TOPOLOGY (đọc trước khi đổi):
 * - Bộ nhớ trong process, KHÔNG chia sẻ giữa nhiều instance / nhiều host.
 *   Đúng cho deployment hiện tại: 1 container app duy nhất trên 1 VPS
 *   (docker-compose.prod.yml). Nếu scale >1 instance → chuyển sang
 *   limiter dùng chung (Redis / Postgres) — đừng giả bộ in-memory là
 *   phân tán toàn cục.
 * - Restart app reset bộ nhớ (kẻ brute-force có thêm `limit` request —
 *   chấp nhận được cho MVP, ghi nhận ở docs/deployment.md).
 *
 * Identity (clientIpFromHeaders) — CHỈ đọc proxy header khi TRUST_PROXY_HEADERS=true
 * (mặc định TẮT, fail-safe — client tự đặt được header). Bật khi topology đảm bảo
 * app không truy cập được trực tiếp từ internet (compose bind 127.0.0.1 + nginx
 * proxy local theo docs/deployment.md):
 * - Ưu tiên x-real-ip (nginx đặt từ $remote_addr — tin được).
 * - Không có: lấy IP cuối cùng của x-forwarded-for (hop proxy thêm vào —
 *   tin được); các hop TRƯỚC trong chuỗi do client kiểm soát, bỏ qua.
 * - Không có gì (hoặc gate tắt): bucket "local" dùng chung — mọi client
 *   chia một bucket, chặt hơn chứ không lỏng hơn.
 *
 * Fail-safe: limiter lỗi nội bộ → cho qua + log (fail open) — bảo vệ
 * brute-force vẫn hoạt động ở path bình thường, site không sập vì limiter.
 */

export type RateLimitRule = { limit: number; windowMs: number };
export type RateLimitDecision = {
  allowed: boolean;
  /** giây còn lại tới khi hit cũ nhất trượt ra window (chỉ có nghĩa khi denied) */
  retryAfterSec: number;
  remaining: number;
};

/** Giới hạn bộ nhớ: số key tối đa trước khi sweep cưỡng bức */
const MAX_KEYS = 10_000;
/** Mỗi 64 call thì sweep một lần — tránh Map lớn dần vô hạn */
const SWEEP_EVERY = 64;
let callCount = 0;

const hits = new Map<string, number[]>();

/** Cho test reset trạng thái giữa các case */
export function resetRateLimits(): void {
  hits.clear();
  callCount = 0;
}

export function checkRateLimit(key: string, rule: RateLimitRule): RateLimitDecision {
  const now = Date.now();
  const windowStart = now - rule.windowMs;

  const list = hits.get(key)?.filter((t) => t > windowStart) ?? [];
  if (list.length >= rule.limit) {
    const retryAfterMs = list[0]! + rule.windowMs - now;
    hits.set(key, list); // ghi lại list đã prune
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      remaining: 0,
    };
  }

  list.push(now);
  hits.set(key, list);

  callCount++;
  if (callCount % SWEEP_EVERY === 0 || hits.size > MAX_KEYS) sweep(now);

  return { allowed: true, retryAfterSec: 0, remaining: rule.limit - list.length };
}

/** Dọn các key rỗng/quá window — O(total hits), chạy thưa */
function sweep(now: number): void {
  for (const [key, list] of hits) {
    if (list.length === 0 || list.every((t) => t < now - 60 * 60 * 1000)) {
      hits.delete(key);
    }
  }
}

/**
 * IP client từ request headers — xem comment đầu file về quy tắc tin tưởng.
 *
 * TRUST_PROXY_HEADERS gate (mặc định TẮT — fail-safe): header proxy do CLIENT
 * tự đặt được — tin vô điều kiện = kẻ bypass rate limit bằng cách gửi mỗi
 * request một x-real-ip khác. Chỉ bật khi app KHÔNG thể truy cập trực tiếp
 * từ internet (compose bind 127.0.0.1 + nginx proxy local theo
 * docs/deployment.md). Tắt → mọi client chung bucket 'local' (chặt hơn).
 *
 * Trả về chuỗi làm khóa; không bao giờ throw.
 */
export function clientIpFromHeaders(headers: Headers): string {
  if (process.env.TRUST_PROXY_HEADERS !== "true") {
    return "local"; // không tin proxy header — bucket chung, fail-safe
  }
  try {
    const realIp = headers.get("x-real-ip");
    if (realIp) return realIp.trim();

    const xff = headers.get("x-forwarded-for");
    if (xff) {
      const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
      if (parts.length > 0) return parts[parts.length - 1]!;
    }
  } catch {
    // header lạ → bucket local
  }
  return "local";
}

/** Response 429 chuẩn — Retry-After theo giây + body JSON rõ ràng */
export function tooManyRequestsResponse(retryAfterSec: number): Response {
  return Response.json(
    {
      error: "RATE_LIMITED",
      message: `Quá nhiều yêu cầu — thử lại sau ${retryAfterSec}s.`,
    },
    { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
  );
}

/**
 * Kiểm tra + trả response 429 nếu vượt limit — dùng trong ROUTE HANDLER.
 * Fail open: lỗi nội bộ → cho qua (log qua captureError).
 */
export async function rateLimitRequest(
  request: Request,
  scope: string,
  rule: RateLimitRule,
): Promise<Response | null> {
  try {
    const ip = clientIpFromHeaders(request.headers);
    const decision = checkRateLimit(`${scope}:${ip}`, rule);
    if (!decision.allowed) return tooManyRequestsResponse(decision.retryAfterSec);
    return null;
  } catch (e) {
    captureError("rate-limit", e, { scope });
    return null; // fail open
  }
}
