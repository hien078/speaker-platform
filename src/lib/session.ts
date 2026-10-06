import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { db } from "@/src/prisma/db.client";
import type { Models } from "@/src/prisma/contract";
import type { Scalars } from "@prisma/orm-postgres/family-contract/types";

/**
 * DB-backed sessions (Batch 2 — spec §5.4.2) — thay cookie JWT stateless bằng
 * token opaque lưu trong bảng `UserSession`, để có:
 *
 * - Inventory + revocation: user (và admin — Task 9) thấy danh sách session
 *   đang hoạt động và thu hồi được từng session hoặc tất cả.
 * - TTL admin ngắn hơn (12h vs 30 ngày) — quyền admin sống ngắn.
 * - Step-up timestamp cho hành động nhạy cảm (Task 8 đọc qua stepUpIsFresh).
 * - Invalidation khi đổi thông tin nhạy cảm (Task 6/7 revoke tất cả).
 *
 * Token: `randomBytes(32)` base64url — 256-bit entropy, KHÔNG phải JWT (không
 * tự xác thực — mọi trạng thái hỏi DB). DB chỉ lưu SHA-256 hex của token:
 * hash để LOOKUP, không phải để giữ bí mật — entropy nằm ở token 256-bit,
 * nên plain SHA-256 là đủ (không cần HMAC pepper). Cookie pre-auth của kẻ tấn
 * công bị bỏ ngay khi login tạo token fresh (chống session fixation).
 *
 * AUTH_SECRET không dùng ở module này — token opaque không cần signing key;
 * env vẫn do src/lib/env.ts validate toàn app (OTP/MFA các Task khác dùng).
 *
 * Fail closed: getSessionFromCookie KHÔNG bao giờ throw — lỗi db/cookie →
 * null (logged-out), giữ nguyên hành vi getCurrentUser cũ.
 */

/** Tên cookie giữ nguyên từ Batch 1 — không bắt người dùng đăng nhập lại vì đổi tên. */
export const SESSION_COOKIE = "sp_session";
/** Consumer 30 ngày — giữ hành vi hiện tại (JWT cũ cũng 30 ngày). */
export const CONSUMER_SESSION_TTL_HOURS = 24 * 30;
/** Admin ngắn hơn (spec §5.4.2). */
export const ADMIN_SESSION_TTL_HOURS = 12;
/** Step-up (xác thực lại gần đây) hợp lệ trong 15 phút (Task 8). */
export const STEP_UP_MAX_AGE_MINUTES = 15;

/** Throttle lastSeenAt — chỉ ghi khi cũ hơn 5 phút (tránh write mỗi request). */
const LAST_SEEN_THROTTLE_MS = 5 * 60_000;

export type SessionInfo = {
  id: string;
  userId: string;
  isAdmin: boolean;
  createdAt: string;
  lastSeenAt: string | null;
  expiresAt: string;
  steppedUpAt: string | null;
  userAgent: string | null;
};

/**
 * SessionUser ĐỊNH NGHĨA Ở ĐÂY (tránh import vòng auth↔session);
 * src/lib/auth.ts re-export cho các import hiện tại.
 */
export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: "buyer" | "seller" | "admin";
  avatarUrl: string | null;
  /** legacy — CHỈ hiển thị; không dùng làm quyền (spec §8.2/§8.5). */
  isVerifiedSeller: boolean;
  /** nguồn duy nhất cho admin authorization (spec §8.5); role chỉ còn display. */
  adminRole: "super_admin" | "operations_admin" | "moderator" | "support" | "analyst" | null;
  /** id session hiện tại — revoke/step-up theo session, không chỉ theo user. */
  sessionId: string;
};

export type CreateSessionOptions = { isAdmin?: boolean; userAgent?: string };

const sha256Hex = (token: string): string => createHash("sha256").update(token).digest("hex");
const nowIso = (): string => new Date().toISOString();

// ─── Map row db → shape công khai (ISO string, không leak gì khác) ─────────────

/** Row UserSession scalars — shape của `.all()` và của `.include("user").first()`. */
type SessionRow = Scalars<Models.public_UserSession>;
/** Row User scalars — quan hệ `user` do include load cùng một query. */
type UserRow = Scalars<Models.public_User>;

function toSessionInfo(row: SessionRow): SessionInfo {
  return {
    id: row.id,
    userId: row.userId,
    isAdmin: row.isAdmin,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    expiresAt: row.expiresAt,
    steppedUpAt: row.steppedUpAt,
    userAgent: row.userAgent,
  };
}

function toSessionUser(user: UserRow, sessionId: string): SessionUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    avatarUrl: user.avatarUrl,
    isVerifiedSeller: user.isVerifiedSeller,
    adminRole: user.adminRole,
    sessionId,
  };
}

// ─── Session lifecycle ─────────────────────────────────────────────────────────

/**
 * Tạo session mới cho user + set cookie. Token fresh random mỗi lần gọi —
 * gọi tại login/register (rotate) để cookie pre-auth không còn giá trị.
 *
 * isAdmin: mặc định derive từ `User.adminRole` (nguồn duy nhất — spec §8.5);
 * opts.isAdmin chỉ là override tường minh cho caller đã biết quyền.
 */
export async function createSession(
  userId: string,
  opts?: CreateSessionOptions,
): Promise<void> {
  // isAdmin mặc định derive từ User.adminRole (nguồn duy nhất — spec §8.5);
  // opts.isAdmin là override tường minh cho caller đã biết quyền.
  let isAdmin = opts?.isAdmin;
  if (isAdmin === undefined) {
    const user = await db.orm.public.User.first({ id: userId });
    isAdmin = (user?.adminRole ?? null) !== null;
  }
  const ttlHours = isAdmin ? ADMIN_SESSION_TTL_HOURS : CONSUMER_SESSION_TTL_HOURS;

  // Token opaque 256-bit — DB chỉ lưu SHA-256 (lookup, không phải secrecy).
  const token = randomBytes(32).toString("base64url");

  await db.orm.public.UserSession.create({
    userId,
    tokenHash: sha256Hex(token),
    isAdmin,
    expiresAt: new Date(Date.now() + ttlHours * 3_600_000).toISOString(),
    userAgent: opts?.userAgent ?? null,
  });

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: ttlHours * 3_600,
  });
}

/**
 * Đọc session hiện tại từ cookie — MỘT lookup duy nhất (session row + User
 * qua include). Trả null khi: không có cookie / token không khớp / đã revoke /
 * hết hạn / db lỗi. KHÔNG bao giờ throw (fail closed về logged-out).
 * getCurrentUser (auth.ts) dùng lại kết quả này.
 */
export async function getSessionFromCookie(): Promise<{
  session: SessionInfo;
  user: SessionUser;
} | null> {
  // Row sau include("user") — session scalars + user scalars từ cùng một query.
  let row: (SessionRow & { user: UserRow }) | null;
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get(SESSION_COOKIE)?.value;
    if (!token) return null;
    row = await db.orm.public.UserSession.where({ tokenHash: sha256Hex(token) })
      .include("user")
      .first();
  } catch {
    return null; // fail closed — logged-out, như getCurrentUser cũ
  }
  if (!row) return null;
  if (row.revokedAt !== null) return null;
  if (Date.parse(row.expiresAt) <= Date.now()) return null;
  if (row.user == null) return null; // FK cascade không cho xảy ra — belt & suspenders

  // lastSeenAt throttle — best effort: lỗi touch KHÔNG làm logout
  try {
    await touchSessionLastSeen(row.id);
  } catch {
    /* best effort */
  }

  return { session: toSessionInfo(row), user: toSessionUser(row.user, row.id) };
}

/** Thu hồi một session (idempotent — session đã revoke không bị ghi đè reason). */
export async function revokeSession(sessionId: string, reason: string): Promise<void> {
  await db.orm.public.UserSession.where({ id: sessionId })
    .where((s) => s.revokedAt.isNull())
    .updateAll({ revokedAt: nowIso(), revokedReason: reason });
}

/**
 * Thu hồi mọi session active của user — MỘT updateAll với predicate loại trừ
 * tùy chọn. Trả về số session vừa thu hồi (chưa từng revoke trước đó).
 * Task 6/7 gọi sau đổi email/phone/password (invalidation — spec §7.2).
 */
export async function revokeAllUserSessions(
  userId: string,
  reason: string,
  opts?: { exceptSessionId?: string },
): Promise<number> {
  const data = { revokedAt: nowIso(), revokedReason: reason };
  const except = opts?.exceptSessionId;
  // MỘT updateAll — predicate loại trừ tùy chọn AND-compose với các mệnh đề trước
  let query = db.orm.public.UserSession
    .where({ userId })
    .where((s) => s.revokedAt.isNull());
  if (except !== undefined) {
    query = query.where((s) => s.id.neq(except));
  }
  const revoked = await query.updateAll(data);
  return revoked.length;
}

/**
 * Inventory session active của user (chưa revoke, chưa hết hạn), mới nhất trước.
 * Task 9 render danh sách này cho user; admin view dùng cho user khác.
 */
export async function listUserSessions(userId: string): Promise<SessionInfo[]> {
  const rows = await db.orm.public.UserSession
    .where({ userId })
    .where((s) => s.revokedAt.isNull())
    .where((s) => s.expiresAt.gt(nowIso()))
    .orderBy((s) => s.createdAt.desc())
    .all();
  return rows.map(toSessionInfo);
}

/** Đánh dấu session vừa step-up (xác thực lại) — Task 8 gọi sau verify TOTP. */
export async function markSessionSteppedUp(sessionId: string): Promise<void> {
  await db.orm.public.UserSession.where({ id: sessionId }).updateAll({
    steppedUpAt: nowIso(),
  });
}

/**
 * Cập nhật lastSeenAt — throttle: chỉ ghi khi giá trị cũ null hoặc cũ hơn
 * 5 phút (session sống 30 ngày → ~8640 write/session thay vì ~triệu).
 */
export async function touchSessionLastSeen(sessionId: string): Promise<void> {
  const row = await db.orm.public.UserSession.first({ id: sessionId });
  if (!row) return;
  const lastSeenMs = row.lastSeenAt === null ? null : Date.parse(row.lastSeenAt);
  if (lastSeenMs !== null && Date.now() - lastSeenMs < LAST_SEEN_THROTTLE_MS) return;
  await db.orm.public.UserSession.where({ id: sessionId }).updateAll({
    lastSeenAt: nowIso(),
  });
}

/** Step-up còn tươi không (trong STEP_UP_MAX_AGE_MINUTES)? null = chưa step-up. */
export function stepUpIsFresh(steppedUpAt: string | null): boolean {
  if (steppedUpAt === null) return false;
  return Date.now() - Date.parse(steppedUpAt) <= STEP_UP_MAX_AGE_MINUTES * 60_000;
}
