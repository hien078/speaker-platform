import { NextResponse } from "next/server";
import { rateLimitRequest } from "@/src/lib/rate-limit";
import {
  BETA_INVITE_COOKIE,
  BETA_INVITE_COOKIE_MAX_AGE_SEC,
  BETA_INVITE_COOKIE_PATH,
  BETA_INVITE_LANDING_RATE,
  BETA_INVITE_TOKEN_RE,
  findActiveInviteToken,
} from "@/src/lib/founding-sellers";

/**
 * GET /invite/[token] — ONE-TIME token landing (Batch 7 Task 3 — S1; spec §9
 * Batch 7 "invitation flow", §2.1; corrections 2026-10-08 items 7/8/12/13).
 *
 * Route Handler (KHÔNG phải page — corrections #7: Server Component không
 * set cookie được, cookies.md:74,81). PUBLIC — invitee chưa có tài khoản.
 *
 * Dòng token:
 *  - Token thô xuất hiện trong URL MỘT LẦN (GET này) — residual risk đã ghi
 *    nhận (browser history + nginx access log); response chuyển token vào
 *    cookie HttpOnly ngắn hạn + redirect /invite (tokenless) — token RỜI URL
 *    ngay, KHÔNG BAO GIỜ trong next/query/form.
 *  - KHÔNG side effect ngoài cookie (corrections #7): Messenger/Zalo
 *    link-unfurl bots GET link này — KHÔNG consume/log/audit; chỉ đọc row để
 *    quyết định set cookie hay không.
 *  - Rate limit TRƯỚC mọi db read (corrections #13): landing là token-
 *    validity oracle không có session — 30 GET/10 phút/IP (PROVISIONAL P5).
 *  - Shape check 43-char base64url TRƯỚC lookup (corrections #12) — garbage
 *    không tốn một query nào (path traversal/encode lạ → redirect thẳng).
 *  - Token không hợp lệ → redirect /invite KHÔNG cookie — trang đó render
 *    thông báo chung "Lời mời không còn hiệu lực" (enumeration-safe).
 *
 * Headers (corrections #8): Referrer-Policy no-referrer CHỈ trên response
 * token (KHÔNG trên /invite — :path* match cả /invite sẽ khiến browser gửi
 * Origin: null trên action POST → Next CSRF check reject). next.config.ts
 * cũng set source "/invite/:token" (belt-and-braces). X-Robots-Tag: noindex —
 * URL mời không được index.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Response redirect /invite — KHÔNG mang token, không cache, không index. */
const redirectToInvite = (request: Request): NextResponse => {
  const res = NextResponse.redirect(new URL("/invite", request.url), 303);
  res.headers.set("Referrer-Policy", "no-referrer");
  res.headers.set("X-Robots-Tag", "noindex");
  res.headers.set("Cache-Control", "no-store");
  return res;
};

export async function GET(
  request: Request,
  ctx: RouteContext<"/invite/[token]">,
): Promise<Response> {
  const { token } = await ctx.params;

  // 1. Rate limit TRƯỚC mọi db read (corrections #13) — fail open (limiter lỗi
  //    → cho qua, không làm sập landing).
  const limited = await rateLimitRequest(request, "invite-landing", BETA_INVITE_LANDING_RATE);
  if (limited !== null) return limited; // 429 + Retry-After

  // 2. Shape check (corrections #12) — garbage không chạm db
  if (typeof token !== "string" || !BETA_INVITE_TOKEN_RE.test(token)) {
    return redirectToInvite(request);
  }

  // 3. Lookup — KHÔNG side effect (bots unfurl GET link này)
  const row = await findActiveInviteToken(token);
  if (row === null) {
    return redirectToInvite(request); // unknown/expired/revoked/consumed — KHÔNG cookie
  }

  // 4. Token hợp lệ → cookie HttpOnly ngắn hạn + redirect /invite (tokenless).
  //    path "/invite" (corrections #35): action POST đến /invite nên path hẹp
  //    vẫn hoạt động, token không đi kèm request khác. secure chỉ production
  //    (dev http://localhost).
  const res = NextResponse.redirect(new URL("/invite", request.url), 303);
  res.cookies.set(BETA_INVITE_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: BETA_INVITE_COOKIE_PATH,
    maxAge: BETA_INVITE_COOKIE_MAX_AGE_SEC,
  });
  res.headers.set("Referrer-Policy", "no-referrer");
  res.headers.set("X-Robots-Tag", "noindex");
  res.headers.set("Cache-Control", "no-store");
  return res;
}
