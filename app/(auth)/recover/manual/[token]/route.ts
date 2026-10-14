import { NextResponse } from "next/server";
import { rateLimitRequest } from "@/src/lib/rate-limit";
// Cookie/token constants từ VOCAB module (plain module) — file "use server"
// KHÔNG thể export const (chỉ async function + type — Global Constraints).
import {
  MANUAL_RECOVERY_COOKIE,
  MANUAL_RECOVERY_COOKIE_MAX_AGE_SEC,
  MANUAL_RECOVERY_COOKIE_PATH,
  MANUAL_RECOVERY_LANDING_RATE,
  MANUAL_RECOVERY_TOKEN_RE,
} from "@/src/lib/manual-account-recovery";
import { findValidManualRecoveryToken } from "@/src/lib/actions/manual-account-recovery";

/**
 * GET /recover/manual/[token] — ONE-TIME reset-token landing (Task E — FD-R3
 * founder 2026-10-13; pattern /invite/[token] Batch 7 Task 3 — corrections
 * 2026-10-08 items 7/8/12/13).
 *
 * Route Handler (KHÔNG phải page — corrections #7: Server Component không
 * set cookie được). PUBLIC — user chưa đăng nhập (session đã bị thu hồi ở
 * approve).
 *
 * Dòng token (mirror invite landing):
 *  - Token thô xuất hiện trong URL MỘT LẦN (GET này) — residual risk đã ghi
 *    nhận (browser history + nginx access log — FD-R49 precedent); response
 *    chuyển token vào cookie HttpOnly ngắn hạn + redirect /recover/manual
 *    (tokenless) — token RỜI URL ngay, KHÔNG BAO GIỜ trong next/query/form.
 *  - KHÔNG side effect ngoài cookie (corrections #7): Messenger/Zalo
 *    link-unfurl bots GET link này — KHÔNG consume/log/audit; chỉ đọc row để
 *    quyết định set cookie hay không (consume authoritative sống trong tx
 *    của consume action, không phải read này).
 *  - Rate limit TRƯỚC mọi db read (corrections #13): landing là
 *    token-validity oracle không có session — 30 GET/10 phút/IP
 *    (PROVISIONAL P5).
 *  - Shape check 43-char base64url TRƯỚC lookup (corrections #12) — garbage
 *    không tốn một query nào.
 *  - Token không hợp lệ → redirect /recover/manual KHÔNG cookie — trang đó
 *    render thông báo chung "Liên kết không còn hiệu lực" (enumeration-safe).
 *
 * Headers (corrections #8 — mirror invite): Referrer-Policy no-referrer CHỈ
 * trên response token (KHÔNG trên /recover/manual — :path* match cả trang
 * tokenless sẽ khiến browser gửi Origin: null trên action POST → Next CSRF
 * check reject). next.config.ts cũng set source "/recover/manual/:token"
 * (belt-and-brances — entry đứng SAU app-wide, last-match-wins). X-Robots-Tag:
 * noindex — URL reset không được index.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Response redirect /recover/manual — KHÔNG mang token, không cache, không index. */
const redirectToManual = (request: Request): NextResponse => {
  const res = NextResponse.redirect(new URL("/recover/manual", request.url), 303);
  res.headers.set("Referrer-Policy", "no-referrer");
  res.headers.set("X-Robots-Tag", "noindex");
  res.headers.set("Cache-Control", "no-store");
  return res;
};

export async function GET(
  request: Request,
  ctx: RouteContext<"/recover/manual/[token]">,
): Promise<Response> {
  const { token } = await ctx.params;

  // 1. Rate limit TRƯỚC mọi db read (corrections #13) — fail open (limiter
  //    lỗi → cho qua, không làm sập landing).
  const limited = await rateLimitRequest(request, "manual-recovery-landing", MANUAL_RECOVERY_LANDING_RATE);
  if (limited !== null) return limited; // 429 + Retry-After

  // 2. Shape check (corrections #12) — garbage không chạm db
  if (typeof token !== "string" || !MANUAL_RECOVERY_TOKEN_RE.test(token)) {
    return redirectToManual(request);
  }

  // 3. Lookup — KHÔNG side effect (bots unfurl GET link này)
  const row = await findValidManualRecoveryToken(token);
  if (row === null) {
    return redirectToManual(request); // unknown/expired/consumed — KHÔNG cookie
  }

  // 4. Token hợp lệ → cookie HttpOnly ngắn hạn + redirect /recover/manual
  //    (tokenless). path "/recover/manual" (corrections #35 precedent): action
  //    POST đến /recover/manual nên path hẹp vẫn hoạt động, token không đi
  //    kèm request khác. secure chỉ production (dev http://localhost).
  const res = NextResponse.redirect(new URL("/recover/manual", request.url), 303);
  res.cookies.set(MANUAL_RECOVERY_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: MANUAL_RECOVERY_COOKIE_PATH,
    maxAge: MANUAL_RECOVERY_COOKIE_MAX_AGE_SEC,
  });
  res.headers.set("Referrer-Policy", "no-referrer");
  res.headers.set("X-Robots-Tag", "noindex");
  res.headers.set("Cache-Control", "no-store");
  return res;
}
