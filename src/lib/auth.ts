import "server-only";
import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { db } from "@/src/prisma/db.client";
import { safeNextPath } from "@/src/lib/redirect";

const SESSION_COOKIE = "sp_session";
const SESSION_DAYS = 30;

function getSecret(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET chưa cấu hình trong .env");
  return new TextEncoder().encode(secret);
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export async function createSession(userId: string): Promise<void> {
  const token = await new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DAYS}d`)
    .sign(getSecret());

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}

export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
}

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: "buyer" | "seller" | "admin";
  avatarUrl: string | null;
  isVerifiedSeller: boolean;
};

/** Đọc user hiện tại từ session cookie. Trả về null nếu chưa đăng nhập. */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, getSecret());
    const userId = payload.sub;
    if (!userId) return null;

    const user = await db.orm.public.User.first({ id: userId });
    if (!user) return null;

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      avatarUrl: user.avatarUrl,
      isVerifiedSeller: user.isVerifiedSeller,
    };
  } catch {
    return null;
  }
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

export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== "admin") throw new Error("FORBIDDEN");
  return user;
}
