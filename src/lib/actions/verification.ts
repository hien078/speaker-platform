"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import { isUniqueConstraintViolation } from "@prisma/orm-family-sql/errors";
import { db } from "@/src/prisma/db.client";
import { requireUser, verifyPassword, hashPassword } from "@/src/lib/auth";
import { checkRateLimit, clientIpFromHeaders } from "@/src/lib/rate-limit";
import {
  requestOtp,
  verifyOtp,
  normalizeEmail,
  normalizePhone,
  OTP_TTL_MINUTES,
  type OtpRequestResult,
} from "@/src/lib/otp";
import { auditEvent } from "@/src/lib/audit-event";
import { getOtpDeliveryAdapter } from "@/src/lib/verification-delivery";
import { captureEvent } from "@/src/lib/observability";
import { notify } from "@/src/lib/notify";

/**
 * Email/phone verification + identity changes (Batch 2 Task 6 — spec §5.3,
 * §5.3.1 — + review fix: đóng step-up bypass, rate limit, revocation trên tx).
 *
 * NGUYÊN TẮC DANH TÍNH (spec §5.3.1 + review fix HIGH + FOLLOW-UP):
 *  - Verification flow (request/confirm) CHỈ xác minh kênh ĐANG LƯU trên tài
 *    khoản: target derive từ DB (row hiện tại), formData bị BỌ QUA; refuse khi
 *    kênh đã verified (ALREADY_VERIFIED) hoặc chưa có gì để xác minh
 *    (PHONE_NOT_ON_FILE). Flow này KHÔNG BAO GIỜ đổi sang kênh khác.
 *  - (FOLLOW-UP) Xác minh MỘT kênh = tạo KÊNH KHÔI PHỤC (Task 7 recovery qua
 *    kênh verified) → confirmEmailVerificationAction /
 *    confirmPhoneVerificationAction LUÔN yêu cầu mật khẩu hiện tại
 *    (verifyCurrentPassword — cùng rate limit per-user + per-IP như login),
 *    KHÔNG ngoại lệ: stolen session không mật khẩu không thể verify phone kể cả
 *    khi attacker đã đặt số của hắn qua profile.ts (được phép khi chưa verified)
 *    và nhận được mã. profile.ts KHÔNG đổi được email nên đường email không
 *    khai thác được qua profile — gate vẫn bật LUÔN cho cả hai (đồng nhất với
 *    change confirm, không phát minh ngoại lệ).
 *  - Đổi sang email/phone KHÁC: CHỈ qua change flow — step-up (mật khẩu hiện
 *    tại) ở request VÀ Ở CONFIRM. OTP row không ghi flow đã tạo nó (không thêm
 *    schema), và kênh đang lưu có thể bị profile.ts đổi giữa request và confirm
 *    (kênh chưa verified) → không thể chứng minh TỪ ROW rằng bước request đã
 *    step-up → theo review: "require the current password again at confirm".
 *    Stolen session không mật khẩu không thể đưa SỐ/EMAIL MỚI tới verified qua
 *    bất kỳ tổ hợp action nào (test stolen-session).
 *  - Collision (spec §5.3.1): email/phone ĐÃ XÁC MINH là duy nhất giữa các tài
 *    khoản active; collision → typed error (EMAIL_TAKEN / PHONE_ALREADY_VERIFIED),
 *    KHÔNG BAO GIỜ merge. Email có unique constraint ở DB (ranh giới cuối,
 *    phân loại 23505); phone KHÔNG có constraint → re-check collision BÊN TRONG
 *    transaction ở confirm. Race song song còn dư (không advisory lock được —
 *    xem ghi chú cuối file) được ghi nhận cho verification doc.
 *  - Uniqueness chỉ áp danh tính ĐÃ xác minh — số giống nhau held unverified ở
 *    tài khoản khác không chặn verify.
 *
 * RATE LIMIT (spec §7.1/§7.2 + review fix MEDIUM):
 *  - MỌI request action (verification + change): per-USER 5/10 phút ĐỘC LẬP
 *    target (chống SMS pumping một tài khoản sang vô hạn số) + per-IP 20/10 phút.
 *    EMAIL_TAKEN pre-check đặt SAU rate limit (hết budget → RATE_LIMITED, không
 *    enumeration qua pre-check).
 *  - Step-up (verify mật khẩu hiện tại): per-USER + per-IP cùng ngưỡng login
 *    (auth.ts AUTH_RULE 10/10 phút) — stolen session không còn password-guessing
 *    oracle.
 *
 * REVOCATION (spec §5.3.1/§7.2 + review fix LOW): hash/password + revocation
 * trong MỘT db.transaction, revocation chạy TRÊN tx qua revokeOtherSessionsTx
 * (local copy predicate session.revokeAllUserSessions — Task 7 branch song song
 * dự kiến thêm tx-variant vào session.ts; khi đó thay helper này, predicate giữ
 * nguyên, dễ reconcile; KHÔNG đụng session.ts trong task này).
 *
 * OTP core (hashed/single-use/TTL/attempt/resend/rate-limit) thuộc src/lib/otp.ts
 * (Task 3); audit action names theo registry Task 5 — không tự chế tên.
 * KHÔNG log raw email/phone/OTP/password ở mọi path (spec §4.8).
 */

export type VerificationFormState = {
  /** Thông báo lỗi tiếng Việt (user-facing). */
  error?: string;
  /** Thông báo thành công tiếng Việt (user-facing). */
  success?: string;
  /** Mã ổn định cho test/client (vd "PHONE_ALREADY_VERIFIED") — không phải prose. */
  code?: string;
};

// ─── Validation schemas + typed error mapping ─────────────────────────────────

const codeSchema = z.string().trim().regex(/^\d{6}$/, "Mã xác minh gồm 6 chữ số");
const newEmailSchema = z.string().trim().email("Email không hợp lệ");
const newPasswordSchema = z
  .string()
  .min(6, "Mật khẩu mới tối thiểu 6 ký tự")
  .max(100, "Mật khẩu mới quá dài");

const INVALID_CODE = { error: "Mã xác minh gồm 6 chữ số", code: "INVALID_CODE" } as const;
const INVALID_PHONE = {
  error: "Số điện thoại không hợp lệ (vd: 0901234567).",
  code: "INVALID_PHONE_FORMAT",
} as const;
const MISSING_CURRENT_PASSWORD = {
  error: "Nhập mật khẩu hiện tại.",
  code: "MISSING_CURRENT_PASSWORD",
} as const;
const USER_NOT_FOUND = {
  error: "Không tìm thấy tài khoản — đăng nhập lại.",
  code: "USER_NOT_FOUND",
} as const;
const WRONG_PASSWORD = { error: "Mật khẩu hiện tại không đúng.", code: "WRONG_PASSWORD" } as const;
const EMAIL_TAKEN = {
  error: "Email này đã được sử dụng bởi tài khoản khác.",
  code: "EMAIL_TAKEN",
} as const;
const PHONE_ALREADY_VERIFIED = {
  error: "Số điện thoại này đã được xác minh bởi tài khoản khác.",
  code: "PHONE_ALREADY_VERIFIED",
} as const;
const ALREADY_VERIFIED_PHONE = {
  error: "Số điện thoại này đã được xác minh rồi.",
  code: "ALREADY_VERIFIED",
} as const;
const ALREADY_VERIFIED_EMAIL = {
  error: "Email này đã được xác minh rồi.",
  code: "ALREADY_VERIFIED",
} as const;
const PHONE_NOT_ON_FILE = {
  error: "Tài khoản chưa có số điện thoại hợp lệ để xác minh — thêm số ở hồ sơ hoặc dùng \"Đổi số điện thoại\".",
  code: "PHONE_NOT_ON_FILE",
} as const;

/** OTP request failure → form error (thông điệp tiếng Việt, không chứa target). */
function otpRequestFailure(result: Extract<OtpRequestResult, { ok: false }>): VerificationFormState {
  if (result.code === "OTP_RATE_LIMITED") {
    return {
      error: `Bạn vừa yêu cầu mã — chờ ${result.retryAfterSec} giây rồi thử lại.`,
      code: "OTP_RATE_LIMITED",
    };
  }
  return {
    error: "Hiện chưa gửi được mã xác minh. Vui lòng thử lại sau ít phút.",
    code: "OTP_DELIVERY_UNAVAILABLE",
  };
}

/** OTP verify failure → form error. */
function otpVerifyFailure(
  code: "OTP_NOT_FOUND" | "OTP_EXPIRED" | "OTP_MAX_ATTEMPTS",
): VerificationFormState {
  switch (code) {
    case "OTP_EXPIRED":
      return { error: "Mã đã hết hạn — yêu cầu mã mới.", code: "OTP_EXPIRED" };
    case "OTP_MAX_ATTEMPTS":
      return { error: "Bạn đã nhập sai quá nhiều lần — yêu cầu mã mới.", code: "OTP_MAX_ATTEMPTS" };
    default:
      return { error: "Mã không đúng hoặc đã hết hiệu lực.", code: "OTP_NOT_FOUND" };
  }
}

/**
 * Sentinel nội bộ — collision danh tính (spec §5.3.1): throw BÊN TRONG tx để
 * rollback, bắt ở ngoài → typed form error. KHÔNG merge, KHÔNG update.
 */
class IdentityCollisionError extends Error {
  constructor() {
    super("PHONE_ALREADY_VERIFIED");
  }
}

// ─── Rate limits (spec §7.1/§7.2 — review fix MEDIUM) ─────────────────────────

/** Per-USER OTP request: 5/10 phút, ĐỘC LẬP target — chống SMS pumping. */
const OTP_REQUEST_PER_USER_RULE = { limit: 5, windowMs: 10 * 60_000 };
/** Per-IP OTP request: 20/10 phút — dư cho NAT/văn phòng, chặn flooding một IP. */
const OTP_REQUEST_PER_IP_RULE = { limit: 20, windowMs: 10 * 60_000 };
/** Step-up (verify mật khẩu hiện tại) — cùng ngưỡng login (auth.ts AUTH_RULE). */
const STEP_UP_RULE = { limit: 10, windowMs: 10 * 60_000 };

const rateLimited = (retryAfterSec: number): VerificationFormState => ({
  error: `Quá nhiều lần thử — chờ ${retryAfterSec} giây rồi thử lại.`,
  code: "RATE_LIMITED",
});

/**
 * Rate limit MỌI request OTP (verification + change) — bucket DÙNG CHUNG
 * `otp-request` cho cả 4 flow: per-user (độc lập target) + per-IP. Fail open
 * (limiter lỗi → không chặn — cùng posture auth.ts).
 */
async function otpRequestRateLimited(userId: string): Promise<VerificationFormState | null> {
  try {
    const ip = clientIpFromHeaders(await headers());
    const perUser = checkRateLimit(`otp-request:user:${userId}`, OTP_REQUEST_PER_USER_RULE);
    if (!perUser.allowed) return rateLimited(perUser.retryAfterSec);
    const perIp = checkRateLimit(`otp-request:ip:${ip}`, OTP_REQUEST_PER_IP_RULE);
    if (!perIp.allowed) return rateLimited(perIp.retryAfterSec);
    return null;
  } catch {
    return null;
  }
}

/**
 * Step-up consumer (spec §5.3.1): xác thực lại mật khẩu HIỆN TẠI — rate limit
 * per-user + per-IP cùng ngưỡng login (stolen session không có password-guessing
 * oracle — review fix MEDIUM #4). Fail open như auth.ts.
 */
async function verifyCurrentPassword(
  userId: string,
  currentPassword: string,
): Promise<VerificationFormState | null> {
  if (!currentPassword) return { ...MISSING_CURRENT_PASSWORD };
  try {
    const ip = clientIpFromHeaders(await headers());
    const perUser = checkRateLimit(`stepup:user:${userId}`, STEP_UP_RULE);
    if (!perUser.allowed) return rateLimited(perUser.retryAfterSec);
    const perIp = checkRateLimit(`stepup:ip:${ip}`, STEP_UP_RULE);
    if (!perIp.allowed) return rateLimited(perIp.retryAfterSec);
  } catch {
    /* limiter lỗi → không chặn (fail open) */
  }
  const row = await db.orm.public.User.first({ id: userId });
  if (!row) return { ...USER_NOT_FOUND };
  const ok = await verifyPassword(currentPassword, row.passwordHash);
  if (!ok) return { ...WRONG_PASSWORD };
  return null;
}

// ─── Revocation trên tx (review fix LOW #5) ───────────────────────────────────

/** Tx context của db.transaction — cùng shape src/lib/actions/helpers.ts. */
type TxContext = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Thu hồi MỌI session KHÁC của user, chạy TRÊN transaction truyền vào —
 * LOCAL copy predicate của session.revokeAllUserSessions (cùng shape where
 * userId + revokedAt IS NULL + id ≠ except). Task 7 (branch song song) dự kiến
 * thêm tx-variant vào session.ts — khi đó ĐỔI helper này sang gọi sang đó
 * (predicate giữ nguyên, dễ reconcile); không đụng session.ts trong task này.
 */
async function revokeOtherSessionsTx(
  tx: TxContext,
  userId: string,
  reason: string,
  exceptSessionId: string,
): Promise<void> {
  await tx.orm.public.UserSession
    .where({ userId })
    .where((s) => s.revokedAt.isNull())
    .where((s) => s.id.neq(exceptSessionId))
    .updateAll({ revokedAt: new Date().toISOString(), revokedReason: reason });
}

// ─── Security notice (spec §5.3.1 "when feasible" — fail-open) ────────────────

/**
 * Notice bảo mật tới kênh CŨ ĐÃ XÁC MINH sau thay đổi nhạy cảm (spec §5.3.1
 * "when feasible" — review fix LOW #6: chỉ kênh cũ VERIFIED mới nhận notice) —
 * fail-open CÓ Ý THỨC: notice không bao giờ làm hỏng flow chính. KHÔNG log
 * error message (message của provider có thể chứa target/nội dung — spec §4.8);
 * log cố định chỉ subjectKey.
 */
async function sendSecurityNotice(
  to: string,
  channel: "email" | "phone",
  subjectKey: string,
): Promise<void> {
  try {
    await getOtpDeliveryAdapter().sendSecurityNotice({ to, channel, subjectKey });
  } catch {
    captureEvent("verification", "security_notice_delivery_failed", { subjectKey });
  }
}

// ─── Email verification — CHỈ email đang lưu ──────────────────────────────────

export async function requestEmailVerificationAction(
  _prev: VerificationFormState,
  _formData: FormData,
): Promise<VerificationFormState> {
  const user = await requireUser();
  const row = await db.orm.public.User.first({ id: user.id });
  if (!row) return { ...USER_NOT_FOUND };
  // Chỉ xác minh email ĐANG LƯU — đã verified thì không gửi lại (review fix HIGH)
  if (row.emailVerifiedAt !== null) return { ...ALREADY_VERIFIED_EMAIL };
  const target = normalizeEmail(row.email);

  const limited = await otpRequestRateLimited(user.id);
  if (limited) return limited;

  const result = await requestOtp({
    userId: user.id,
    purpose: "email_verification",
    channel: "email",
    target,
  });
  if (!result.ok) return otpRequestFailure(result);
  return {
    success: `Đã gửi mã xác minh tới email của bạn. Mã có hiệu lực ${OTP_TTL_MINUTES} phút.`,
  };
}

export async function confirmEmailVerificationAction(
  _prev: VerificationFormState,
  formData: FormData,
): Promise<VerificationFormState> {
  const user = await requireUser();
  const parsed = codeSchema.safeParse(formData.get("code"));
  if (!parsed.success) return { ...INVALID_CODE };

  // Step-up tại confirm (FOLLOW-UP FIX): xác minh email làm nó trở thành KÊNH
  // KHÔI PHỤC (Task 7 recovery qua kênh verified) — yêu cầu mật khẩu hiện tại,
  // LUÔN, không ngoại lệ (review: "do not invent exceptions: always require it").
  // Cùng verifyCurrentPassword (rate limit per-user + per-IP như login).
  const stepUpFailure = await verifyCurrentPassword(
    user.id,
    String(formData.get("currentPassword") ?? ""),
  );
  if (stepUpFailure) return stepUpFailure;

  const row = await db.orm.public.User.first({ id: user.id });
  if (!row) return { ...USER_NOT_FOUND };
  // Chỉ xác minh email ĐANG LƯU — đã verified thì từ chối (review fix HIGH)
  if (row.emailVerifiedAt !== null) return { ...ALREADY_VERIFIED_EMAIL };
  const target = normalizeEmail(row.email);

  const verified = await verifyOtp({
    userId: user.id,
    purpose: "email_verification",
    channel: "email",
    target,
    code: parsed.data,
  });
  if (!verified.ok) return otpVerifyFailure(verified.code);

  // Email của chính user — không thể collision (unique constraint + là chủ sở
  // hữu); set trực tiếp không cần tx.
  await db.orm.public.User
    .where({ id: user.id })
    .update({ emailVerifiedAt: new Date().toISOString() });

  await auditEvent({
    actorId: user.id,
    subjectId: user.id,
    action: "user.email_verified",
    resourceType: "User",
    resourceId: user.id,
    sessionId: user.sessionId,
    detail: "channel=email", // KHÔNG chứa email thô (spec §4.8)
  });
  revalidatePath("/profile");
  return { success: "Đã xác minh email." };
}

// ─── Phone verification — CHỈ số đang lưu (review fix HIGH) ───────────────────

export async function requestPhoneVerificationAction(
  _prev: VerificationFormState,
  _formData: FormData,
): Promise<VerificationFormState> {
  const user = await requireUser();
  const row = await db.orm.public.User.first({ id: user.id });
  if (!row) return { ...USER_NOT_FOUND };
  // Chỉ xác minh SỐ ĐANG LƯU — đã verified thì không gửi lại (review fix HIGH)
  if (row.phoneVerifiedAt !== null) return { ...ALREADY_VERIFIED_PHONE };
  // Không có số lưu / số legacy không chuẩn hóa được → không có gì để xác minh
  if (row.phone === null) return { ...PHONE_NOT_ON_FILE };
  let target: string;
  try {
    target = normalizePhone(row.phone);
  } catch {
    return { ...PHONE_NOT_ON_FILE };
  }

  const limited = await otpRequestRateLimited(user.id);
  if (limited) return limited;

  const result = await requestOtp({
    userId: user.id,
    purpose: "phone_verification",
    channel: "phone",
    target,
  });
  if (!result.ok) return otpRequestFailure(result);
  return {
    success: `Đã gửi mã xác minh tới số điện thoại. Mã có hiệu lực ${OTP_TTL_MINUTES} phút.`,
  };
}

export async function confirmPhoneVerificationAction(
  _prev: VerificationFormState,
  formData: FormData,
): Promise<VerificationFormState> {
  const user = await requireUser();
  const parsed = codeSchema.safeParse(formData.get("code"));
  if (!parsed.success) return { ...INVALID_CODE };

  // Step-up tại confirm (FOLLOW-UP FIX): xác minh phone làm nó trở thành KÊNH
  // KHÔI PHỤC (Task 7) — stolen session không mật khẩu không thể verify kể cả số
  // do chính hắn đặt qua profile (được phép khi chưa verified). LUÔN yêu cầu
  // mật khẩu, không ngoại lệ (review); cùng verifyCurrentPassword (rate limit).
  const stepUpFailure = await verifyCurrentPassword(
    user.id,
    String(formData.get("currentPassword") ?? ""),
  );
  if (stepUpFailure) return stepUpFailure;

  const row = await db.orm.public.User.first({ id: user.id });
  if (!row) return { ...USER_NOT_FOUND };
  // Chỉ xác minh SỐ ĐANG LƯU — đã verified thì từ chối (review fix HIGH)
  if (row.phoneVerifiedAt !== null) return { ...ALREADY_VERIFIED_PHONE };
  if (row.phone === null) return { ...PHONE_NOT_ON_FILE };
  let target: string;
  try {
    target = normalizePhone(row.phone);
  } catch {
    return { ...PHONE_NOT_ON_FILE };
  }

  const verified = await verifyOtp({
    userId: user.id,
    purpose: "phone_verification",
    channel: "phone",
    target,
    code: parsed.data,
  });
  if (!verified.ok) return otpVerifyFailure(verified.code);

  // Collision re-check TRONG tx (spec §5.3.1): số ĐANG LƯU đã được xác minh bởi
  // tài khoản khác → typed error, rollback, KHÔNG merge, KHÔNG update.
  // (phone: target = normalizePhone(stored) — cùng số, chỉ canonical form.)
  try {
    await db.transaction(async (tx) => {
      const owner = await tx.orm.public.User
        .where({ phone: target })
        .where((u) => u.id.neq(user.id))
        .where((u) => u.phoneVerifiedAt.isNotNull())
        .first();
      if (owner) throw new IdentityCollisionError();
      await tx.orm.public.User
        .where({ id: user.id })
        .update({ phone: target, phoneVerifiedAt: new Date().toISOString() });
    });
  } catch (e) {
    if (e instanceof IdentityCollisionError) return { ...PHONE_ALREADY_VERIFIED };
    throw e; // lỗi khác (db…) → fail closed, không masquerade thành collision
  }

  await auditEvent({
    actorId: user.id,
    subjectId: user.id,
    action: "user.phone_verified",
    resourceType: "User",
    resourceId: user.id,
    sessionId: user.sessionId,
    detail: "channel=phone", // KHÔNG chứa số thô (spec §4.8)
  });
  revalidatePath("/profile");
  return { success: "Đã xác minh số điện thoại." };
}

// ─── Đổi mật khẩu (step-up + tx revocation — Review Focus 3) ──────────────────

export async function changePasswordAction(
  _prev: VerificationFormState,
  formData: FormData,
): Promise<VerificationFormState> {
  const user = await requireUser();
  const currentPassword = String(formData.get("currentPassword") ?? "");
  const newPassword = String(formData.get("newPassword") ?? "");
  const parsed = newPasswordSchema.safeParse(newPassword);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Mật khẩu không hợp lệ", code: "INVALID_PASSWORD" };
  }

  // Step-up (spec §5.3.1) — rate-limited (review fix MEDIUM #4).
  const stepUpFailure = await verifyCurrentPassword(user.id, currentPassword);
  if (stepUpFailure) return stepUpFailure;

  const passwordHash = await hashPassword(newPassword);

  // MỘT transaction (review fix LOW #5): hash + revocation sống chết cùng nhau —
  // không bao giờ đổi hash mà chưa thu hồi session khác (và ngược lại).
  // Session hiện tại sống để user không bị đá ra giữa chừng.
  await db.transaction(async (tx) => {
    await tx.orm.public.User.where({ id: user.id }).update({ passwordHash });
    await revokeOtherSessionsTx(tx, user.id, "password_change", user.sessionId);
  });

  await auditEvent({
    actorId: user.id,
    subjectId: user.id,
    action: "user.password_changed",
    resourceType: "User",
    resourceId: user.id,
    sessionId: user.sessionId,
  });
  await notify(
    user.id,
    "security",
    "Đã đổi mật khẩu",
    "Mật khẩu của bạn đã được thay đổi. Nếu không phải bạn thực hiện, hãy khôi phục mật khẩu ngay.",
  );
  revalidatePath("/profile");
  return { success: "Đã đổi mật khẩu. Các thiết bị khác đã bị đăng xuất." };
}

// ─── Đổi email (step-up ở request VÀ confirm + OTP tới email mới) ─────────────

export async function requestEmailChangeAction(
  _prev: VerificationFormState,
  formData: FormData,
): Promise<VerificationFormState> {
  const user = await requireUser();
  const emailParsed = newEmailSchema.safeParse(String(formData.get("newEmail") ?? ""));
  if (!emailParsed.success) {
    return { error: emailParsed.error.issues[0]?.message ?? "Email không hợp lệ", code: "INVALID_EMAIL" };
  }
  const newEmail = normalizeEmail(emailParsed.data);

  // Step-up (spec §5.3.1) — rate-limited.
  const stepUpFailure = await verifyCurrentPassword(
    user.id,
    String(formData.get("currentPassword") ?? ""),
  );
  if (stepUpFailure) return stepUpFailure;

  // Rate limit TRƯỚC pre-check (review fix MEDIUM #3): hết budget → RATE_LIMITED,
  // EMAIL_TAKEN pre-check không chạy (không enumeration qua pre-check sau limit).
  const limited = await otpRequestRateLimited(user.id);
  if (limited) return limited;

  // Pre-check uniqueness (ranh giới ACTION; DB unique constraint là ranh giới
  // cuối ở confirm). Thông điệp enumeration-safe: actor đã đăng nhập, chỉ biết
  // "email đã có người dùng" — không biết của ai.
  const existing = await db.orm.public.User.where({ email: newEmail }).first();
  if (existing) {
    if (existing.id === user.id) {
      return { error: "Email mới phải khác email hiện tại của bạn.", code: "EMAIL_SAME" };
    }
    return { ...EMAIL_TAKEN };
  }

  const result = await requestOtp({
    userId: user.id,
    purpose: "email_verification",
    channel: "email",
    target: newEmail,
  });
  if (!result.ok) return otpRequestFailure(result);
  return {
    success: `Đã gửi mã xác minh tới email mới. Mã có hiệu lực ${OTP_TTL_MINUTES} phút.`,
  };
}

export async function confirmEmailChangeAction(
  _prev: VerificationFormState,
  formData: FormData,
): Promise<VerificationFormState> {
  const user = await requireUser();
  const codeParsed = codeSchema.safeParse(formData.get("code"));
  if (!codeParsed.success) return { ...INVALID_CODE };
  const emailParsed = newEmailSchema.safeParse(String(formData.get("newEmail") ?? ""));
  if (!emailParsed.success) {
    return { error: emailParsed.error.issues[0]?.message ?? "Email không hợp lệ", code: "INVALID_EMAIL" };
  }
  const newEmail = normalizeEmail(emailParsed.data);

  // Step-up TẠI CONFIRM (review fix HIGH): OTP row không ghi flow đã tạo nó —
  // không thể chứng minh TỪ ROW rằng bước request đã step-up → yêu cầu mật khẩu
  // lại tại điểm thay đổi thật (đúng spec §5.3.1 "recent authentication").
  const stepUpFailure = await verifyCurrentPassword(
    user.id,
    String(formData.get("currentPassword") ?? ""),
  );
  if (stepUpFailure) return stepUpFailure;

  const row = await db.orm.public.User.first({ id: user.id });
  if (!row) return { ...USER_NOT_FOUND };
  const oldEmail = normalizeEmail(row.email);
  const oldEmailVerified = row.emailVerifiedAt !== null;

  const verified = await verifyOtp({
    userId: user.id,
    purpose: "email_verification",
    channel: "email",
    target: newEmail,
    code: codeParsed.data,
  });
  if (!verified.ok) return otpVerifyFailure(verified.code);

  // tx: swap email + emailVerifiedAt + thu hồi session khác (TRÊN tx — review
  // fix LOW #5). Unique constraint của User.email là ranh giới CUỐI (race giữa
  // pre-check ở request và confirm): 23505 → typed EMAIL_TAKEN; lỗi khác ném
  // tiếp (fail closed).
  try {
    await db.transaction(async (tx) => {
      await tx.orm.public.User
        .where({ id: user.id })
        .update({ email: newEmail, emailVerifiedAt: new Date().toISOString() });
      await revokeOtherSessionsTx(tx, user.id, "email_change", user.sessionId);
    });
  } catch (e) {
    if (isUniqueConstraintViolation(e)) return { ...EMAIL_TAKEN };
    throw e;
  }

  await auditEvent({
    actorId: user.id,
    subjectId: user.id,
    action: "user.email_changed",
    resourceType: "User",
    resourceId: user.id,
    sessionId: user.sessionId,
    detail: "channel=email", // KHÔNG chứa email thô cũ/mới (spec §4.8)
  });
  // Security notice CHỈ tới kênh CŨ ĐÃ VERIFIED (review fix LOW #6) — fail-open.
  if (oldEmailVerified) {
    await sendSecurityNotice(oldEmail, "email", "email_changed");
  }
  await notify(
    user.id,
    "security",
    "Đã đổi email đăng nhập",
    "Email đăng nhập của bạn đã được thay đổi và xác minh. Nếu không phải bạn thực hiện, hãy khôi phục mật khẩu ngay.",
  );
  revalidatePath("/profile");
  return { success: "Đã đổi email đăng nhập. Các thiết bị khác đã bị đăng xuất." };
}

// ─── Đổi số điện thoại (step-up ở request VÀ confirm + collision trong tx) ────

export async function requestPhoneChangeAction(
  _prev: VerificationFormState,
  formData: FormData,
): Promise<VerificationFormState> {
  const user = await requireUser();
  let newPhone: string;
  try {
    newPhone = normalizePhone(String(formData.get("newPhone") ?? ""));
  } catch {
    return { ...INVALID_PHONE };
  }

  // Step-up (spec §5.3.1) — rate-limited.
  const stepUpFailure = await verifyCurrentPassword(
    user.id,
    String(formData.get("currentPassword") ?? ""),
  );
  if (stepUpFailure) return stepUpFailure;

  // Rate limit TRƯỚC pre-check (review fix MEDIUM #3).
  const limited = await otpRequestRateLimited(user.id);
  if (limited) return limited;

  // Pre-check collision: số đã ĐƯỢC XÁC MINH bởi tài khoản khác → chặn TRƯỚC
  // khi tốn một SMS. Re-check trong tx ở confirm vẫn là ranh giới enforcement.
  const owner = await db.orm.public.User
    .where({ phone: newPhone })
    .where((u) => u.id.neq(user.id))
    .where((u) => u.phoneVerifiedAt.isNotNull())
    .first();
  if (owner) return { ...PHONE_ALREADY_VERIFIED };

  const result = await requestOtp({
    userId: user.id,
    purpose: "phone_verification",
    channel: "phone",
    target: newPhone,
  });
  if (!result.ok) return otpRequestFailure(result);
  return {
    success: `Đã gửi mã xác minh tới số điện thoại mới. Mã có hiệu lực ${OTP_TTL_MINUTES} phút.`,
  };
}

export async function confirmPhoneChangeAction(
  _prev: VerificationFormState,
  formData: FormData,
): Promise<VerificationFormState> {
  const user = await requireUser();
  const codeParsed = codeSchema.safeParse(formData.get("code"));
  if (!codeParsed.success) return { ...INVALID_CODE };
  let newPhone: string;
  try {
    newPhone = normalizePhone(String(formData.get("newPhone") ?? ""));
  } catch {
    return { ...INVALID_PHONE };
  }

  // Step-up TẠI CONFIRM (review fix HIGH — xem confirmEmailChangeAction): OTP
  // row không phân biệt flow đã tạo nó; kênh đang lưu có thể bị profile đổi
  // giữa request và confirm → yêu cầu mật khẩu lại tại điểm thay đổi thật.
  const stepUpFailure = await verifyCurrentPassword(
    user.id,
    String(formData.get("currentPassword") ?? ""),
  );
  if (stepUpFailure) return stepUpFailure;

  // Phone CŨ (cho security notice): đọc từ row TRƯỚC khi swap.
  const row = await db.orm.public.User.first({ id: user.id });
  if (!row) return { ...USER_NOT_FOUND };
  const oldPhone = row.phone;
  const oldPhoneVerified = row.phoneVerifiedAt !== null;

  const verified = await verifyOtp({
    userId: user.id,
    purpose: "phone_verification",
    channel: "phone",
    target: newPhone,
    code: codeParsed.data,
  });
  if (!verified.ok) return otpVerifyFailure(verified.code);

  // tx: collision re-check + swap + thu hồi session khác TRÊN tx (review fix
  // LOW #5). Race song song còn dư (không advisory lock — xem ghi chú cuối file).
  try {
    await db.transaction(async (tx) => {
      const owner = await tx.orm.public.User
        .where({ phone: newPhone })
        .where((u) => u.id.neq(user.id))
        .where((u) => u.phoneVerifiedAt.isNotNull())
        .first();
      if (owner) throw new IdentityCollisionError();
      await tx.orm.public.User
        .where({ id: user.id })
        .update({ phone: newPhone, phoneVerifiedAt: new Date().toISOString() });
      await revokeOtherSessionsTx(tx, user.id, "phone_change", user.sessionId);
    });
  } catch (e) {
    if (e instanceof IdentityCollisionError) return { ...PHONE_ALREADY_VERIFIED };
    throw e;
  }

  await auditEvent({
    actorId: user.id,
    subjectId: user.id,
    action: "user.phone_changed",
    resourceType: "User",
    resourceId: user.id,
    sessionId: user.sessionId,
    detail: "channel=phone", // KHÔNG chứa số thô cũ/mới (spec §4.8)
  });
  // Notice CHỈ tới kênh CŨ ĐÃ VERIFIED (review fix LOW #6) — fail-open.
  if (oldPhone !== null && oldPhoneVerified) {
    await sendSecurityNotice(oldPhone, "phone", "phone_changed");
  }
  await notify(
    user.id,
    "security",
    "Đã đổi số điện thoại",
    "Số điện thoại của bạn đã được thay đổi và xác minh. Nếu không phải bạn thực hiện, hãy khôi phục mật khẩu ngay.",
  );
  revalidatePath("/profile");
  return { success: "Đã đổi số điện thoại. Các thiết bị khác đã bị đăng xuất." };
}

/*
 * GHI CHÚ RESIDUAL (cho verification doc Task 12 — review fix #8):
 *
 * 1. Race song song cross-account khi confirm phone: hai tài khoản confirm cùng
 *    một số trong hai tx khác nhau đều qua re-check (READ COMMITTED) → cả hai
 *    verified. KHÔNG thể đóng bằng pg_advisory_xact_lock(hashtext(phone)) trong
 *    confirm tx: Prisma 8 rc.13 KHÔNG expose raw SQL trong transaction context
 *    (tx chỉ có sql/orm/enums/nativeEnums — đã probe thực tế: tx.raw undefined);
 *    db.raw.sql template tag chỉ tồn tại trên pool client (chạy trên connection
 *    KHÁC — advisory xact lock vô dụng), và db.transaction không có option
 *    isolation level. Đóng được khi: (a) partial unique index
 *    `ON User(phone) WHERE phoneVerifiedAt IS NOT NULL` (schema — bị cấm trong
 *    fix này), hoặc (b) Prisma 8 expose raw lane trong tx. Ghi nhận cho Task 12;
 *    ops duplicate-phone review query thuộc runbook Task 11.
 *
 * 2. Unverified account giữ email chặn chủ thật: requestEmailChangeAction
 *    pre-check `where({ email })` bắt CẢ row chưa verified → email đang held
 *    unverified bởi một tài khoản khác chặn đổi email của chủ thật (chỉ đổi được
 *    khi tài khoản kia đổi đi). Unique constraint DB cũng vậy. Ghi nhận cho
 *    Task 12 (spec §5.3.1 chỉ định nghĩa uniqueness cho danh tính ĐÃ xác minh —
 *    pre-check hiện tại thắt chặt hơn spec; nới lỏng cần founder decision).
 */
