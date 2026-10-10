import "server-only";
import { cookies } from "next/headers";
import bcrypt from "bcryptjs";
import {
  SESSION_COOKIE,
  getSessionFromCookie,
  revokeSession,
  type SessionUser,
} from "@/src/lib/session";
import { safeNextPath } from "@/src/lib/redirect";

/**
 * Auth — password hashing + ranh giới đăng nhập. Session (token opaque DB-backed,
 * TTL, revocation, inventory) sống ở src/lib/session.ts; module này giữ nguyên
 * chữ ký public của Batch 1 và delegate sang đó:
 *
 * - createSession(userId, opts?) — delegate nguyên signature (thêm opts tùy chọn).
 * - getCurrentUser() — (await getSessionFromCookie())?.user ?? null — MỘT lookup
 *   session + user, không đọc lại DB lần hai.
 * - destroySession() — revoke session hiện tại (reason "logout") + xóa cookie.
 * - hashPassword / verifyPassword / requireUser — giữ nguyên.
 *
 * Check role rộng của Batch 1 đã XÓA (Batch 2 Task 4): authorization admin đọc
 * User.adminRole qua capability matrix src/lib/rbac.ts — requireCapability /
 * requireAdminUser — không còn check role rộng nào (spec §5.4, §8.5).
 *
 * SessionUser ĐỊNH NGHĨA Ở session.ts (tránh import vòng auth↔session) và
 * re-export ở đây cho các import hiện tại (spec §8.5: adminRole là nguồn
 * authorization duy nhất — role chỉ còn display; isVerifiedSeller legacy
 * chỉ hiển thị).
 *
 * JWT/jose đã bỏ (Batch 2 Task 2): cookie mang token opaque random 256-bit,
 * DB lưu SHA-256 — xem src/lib/session.ts. Cookie cũ (JWT) vô hiệu sau deploy
 * — mọi người dùng đăng nhập lại một lần (chấp nhận cho private beta pre-launch).
 */

export type { SessionUser } from "@/src/lib/session";
export { createSession } from "@/src/lib/session";

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/** Đăng xuất: thu hồi session trong DB (revocation thật — token không dùng lại được) + xóa cookie. */
export async function destroySession(): Promise<void> {
  const current = await getSessionFromCookie();
  if (current) {
    await revokeSession(current.session.id, "logout");
  }
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
}

/** Đọc user hiện tại từ session cookie. Trả về null nếu chưa đăng nhập. */
export async function getCurrentUser(): Promise<SessionUser | null> {
  return (await getSessionFromCookie())?.user ?? null;
}

/** Yêu cầu đăng nhập — redirect về /login nếu chưa. Dùng trong server actions. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) {
    // redirect() throw NEXT_REDIRECT — Next xử lý chuyển hướng, không bao giờ return
    const { redirect } = await import("next/navigation");
    const { headers } = await import("next/headers");
    const h = await headers();
    const path = h.get("x-invoke-path") ?? h.get("referer") ?? "";
    const url = new URL(path || "/", "http://local");
    const next = safeNextPath(url.pathname && url.pathname !== "/" ? `${url.pathname}${url.search}` : null);
    redirect(`/login${next ? `?next=${encodeURIComponent(next)}` : ""}`);
  }
  return user!;
}

