"use server";

/**
 * Account recovery (Batch 2 Task 7 — spec §7.7, §7.2, §5.3) — đặt lại mật khẩu
 * qua OTP gửi tới MỘT kênh ĐÃ XÁC MINH, enumeration-safe ở mọi phản hồi.
 *
 * Nguyên tắc (plan Task 7 + spec §7.7 "prevent account enumeration"):
 * - MỘT thông báo trung tính duy nhất (RECOVERY_SENT_MESSAGE) cho MỌI outcome
 *   của request: có/không khớp tài khoản, kênh chưa xác minh, cooldown OTP,
 *   per-target limit, delivery fail — byte-đối-byte như nhau, kẻ dò không
 *   phân biệt được gì cả. (Constant KHÔNG export — file "use server" chỉ
 *   export được async function; test pin bằng so sánh giữa các outcome.)
 * - Confirm: mọi failure (identifier không khớp, sai/hết hạn/dùng lại/khóa vì
 *   quá lần thử) COLLAPSE về cùng một lỗi — confirm không thành oracle enumeration.
 * - Tra user theo email/số phone NHƯNG chỉ khớp kênh ĐÃ XÁC MINH
 *   (emailVerifiedAt/phoneVerifiedAt != null) — recovery qua kênh chưa xác
 *   minh là vector chiếm tài khoản (SIM tái sử dụng, email cũ — spec §5.3.1).
 *   Kênh gửi = kênh của identifier: mất email → nhập phone → mã tới phone
 *   (lost-email path) và ngược lại (lost-phone path).
 * - Rate limit: request 5/10 phút/IP (plan Task 7) + confirm 10/10 phút/IP
 *   (spec §7.1 — OTP verify endpoint cũng phải rate limit) + per-identifier
 *   limit bên trong OTP core (3 mã/10 phút/(userId,purpose,target)).
 * - Completion thu hồi MỌI session — revokeAllUserSessions(userId,
 *   "password_recovery") KHÔNG exceptSessionId: session hiện tại (nếu có)
 *   cũng chết, session tạo TRƯỚC reset không còn tác quyền (Review Focus 3 —
 *   stale-session reuse sau recovery, spec §7.2).
 * - Audit "user.recovery_requested"/"user.recovery_completed" (Task 5 registry)
 *   + notify in-app + security notice tới kênh đã xác minh (spec §7.7 "notify
 *   previous verified channels when feasible" — adapter fail-open).
 * - KHÔNG log identifier thô (email/phone), mã OTP, mật khẩu ở bất kỳ path nào
 *   (spec §4.8) — lỗi audit/notify được captureError với meta KHÔNG PII.
 */

import { headers } from "next/headers";
import { z } from "zod";
import { db } from "@/src/prisma/db.client";
import { hashPassword } from "@/src/lib/auth";
import { revokeAllUserSessions } from "@/src/lib/session";
import { normalizeEmail, normalizePhone, requestOtp, verifyOtp, type OtpChannel } from "@/src/lib/otp";
import { auditEvent } from "@/src/lib/audit-event";
import { getOtpDeliveryAdapter } from "@/src/lib/verification-delivery";
import { checkRateLimit, clientIpFromHeaders, type RateLimitRule } from "@/src/lib/rate-limit";
import { captureError } from "@/src/lib/observability";
import { notify } from "@/src/lib/notify";

export type RecoveryFormState = { error?: string; success?: string };

/** 5 request / 10 phút / IP — plan Task 7 (IP rate limit riêng cho request). */
const RECOVERY_REQUEST_RULE: RateLimitRule = { limit: 5, windowMs: 10 * 60_000 };
/** 10 confirm / 10 phút / IP — spec §7.1 (OTP verify endpoint cũng rate limit). */
const RECOVERY_CONFIRM_RULE: RateLimitRule = { limit: 10, windowMs: 10 * 60_000 };

/**
 * Thông báo trung tính DUY NHẤT (spec §7.7 chống enumeration) — mọi outcome của
 * request trả đúng chuỗi này. KHÔNG export ("use server" chỉ export được async
 * function); KHÔNG chứa identifier/mọi thứ động theo tài khoản.
 */
const RECOVERY_SENT_MESSAGE =
  "Nếu thông tin bạn nhập khớp với một kênh đã xác minh của tài khoản, mã đặt lại mật khẩu đã được gửi. Vui lòng kiểm tra email hoặc tin nhắn.";

/**
 * Lỗi collapsed của confirm — identifier không khớp, sai mã, hết hạn, dùng lại,
 * khóa vì quá lần thử → CÙNG chuỗi (không phân biệt được — spec §7.7).
 */
const RECOVERY_CODE_INVALID_MESSAGE =
  "Mã không đúng hoặc đã hết hạn. Vui lòng kiểm tra lại hoặc yêu cầu mã mới.";

/** Lỗi nhập liệu identifier — fixed message, KHÔNG chứa raw input (spec §4.8). */
const IDENTIFIER_INVALID_MESSAGE = "Vui lòng nhập email hoặc số điện thoại hợp lệ.";

/** Thông báo hoàn tất — mọi phiên đã thu hồi, đăng nhập lại bằng mật khẩu mới. */
const RECOVERY_COMPLETED_MESSAGE =
  "Đặt lại mật khẩu thành công. Mọi phiên đăng nhập đã được thu hồi — vui lòng đăng nhập bằng mật khẩu mới.";

// ─── Rate limit (fail open — limiter lỗi không chặn người dùng, như auth.ts) ──

async function recoveryRateLimited(
  scope: string,
  rule: RateLimitRule,
): Promise<RecoveryFormState | null> {
  try {
    const ip = clientIpFromHeaders(await headers());
    const decision = checkRateLimit(`${scope}:${ip}`, rule);
    if (decision.allowed) return null;
    return { error: `Quá nhiều lần thử — chờ ${decision.retryAfterSec} giây rồi thử lại.` };
  } catch {
    return null;
  }
}

// ─── Identifier: email HOẶC phone VN — sai dạng → lỗi nhập liệu trước tra cứu ──

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type ParsedIdentifier = { channel: OtpChannel; target: string };

/**
 * Phân loại identifier: email (có "@", đúng dạng) HOẶC phone VN (normalizePhone
 * — bỏ khoảng cách/dấu chấm, +84→0). Sai cả hai → null → lỗi nhập liệu TRƯỚC
 * khi tra cứu db (không tốn lookup). KHÔNG log raw input ở path nào (spec §4.8).
 */
function parseIdentifier(raw: string): ParsedIdentifier | null {
  const value = raw.trim();
  if (!value) return null;
  if (value.includes("@")) {
    return EMAIL_RE.test(value) ? { channel: "email", target: normalizeEmail(value) } : null;
  }
  try {
    return { channel: "phone", target: normalizePhone(value) };
  } catch {
    return null; // INVALID_PHONE_FORMAT — message cố định, không raw input
  }
}

/**
 * Tra user theo identifier NHƯNG chỉ khớp kênh ĐÃ XÁC MINH — email unique nên
 * phone là nơi có thể trùng chuỗi; verified-phone uniqueness do Task 6 giữ
 * (collision re-check lúc verify), residual race đã ghi nhận trong batch doc.
 */
async function findUserByVerifiedIdentifier(
  channel: OtpChannel,
  target: string,
): Promise<{ id: string } | null> {
  if (channel === "email") {
    return db.orm.public.User.where({ email: target })
      .where((u) => u.emailVerifiedAt.isNotNull())
      .first();
  }
  return db.orm.public.User.where({ phone: target })
    .where((u) => u.phoneVerifiedAt.isNotNull())
    .first();
}

// ─── Bước 1: yêu cầu mã đặt lại ────────────────────────────────────────────────

export async function requestPasswordRecoveryAction(
  _prev: RecoveryFormState,
  formData: FormData,
): Promise<RecoveryFormState> {
  // 1) IP rate limit — 5/10 phút/IP, tiêu tốn cho MỌI request (kể cả identifier
  //    không khớp — bucket theo IP, không theo identifier, không leak existence).
  const limited = await recoveryRateLimited("recovery:request", RECOVERY_REQUEST_RULE);
  if (limited) return limited;

  // 2) Định dạng — email HOẶC phone VN. Sai cả hai → lỗi nhập liệu TRƯỚC tra cứu.
  const parsed = parseIdentifier(String(formData.get("identifier") ?? ""));
  if (!parsed) return { error: IDENTIFIER_INVALID_MESSAGE };
  const { channel, target } = parsed;

  // 3) Tra user — CHỈ khớp kênh ĐÃ XÁC MINH (emailVerifiedAt/phoneVerifiedAt).
  const user = await findUserByVerifiedIdentifier(channel, target);

  // 4) Không khớp → cùng thông báo trung tính, KHÔNG OTP (budget IP đã tốn ở bước 1 —
  //    kẻ dò identifier lạ không mua được thêm budget cho identifier thật).
  if (!user) return { success: RECOVERY_SENT_MESSAGE };

  // 5) Có user → requestOtp(password_recovery, kênh của identifier). Mọi error
  //    code (cooldown, per-target limit, delivery fail) COLLAPSE về cùng thông
  //    báo — không cho kẻ dò phân biệt "tồn tại nhưng bị chặn" vs "không tồn tại".
  const result = await requestOtp({
    userId: user.id,
    purpose: "password_recovery",
    channel,
    target,
  });

  // 6) Audit "user.recovery_requested" — fail-open CÓ Ý THỨC: nếu bảng audit hỏng
  //    mà audit throw, identifier có thật sẽ lỗi còn identifier lạ vẫn trung tính
  //    → oracle enumeration; bắt lỗi để phản hồi không bao giờ phụ thuộc audit.
  try {
    await auditEvent({
      actorId: user.id,
      subjectId: user.id,
      action: "user.recovery_requested",
      resourceType: "User",
      resourceId: user.id,
      reason: result.ok ? "otp_sent" : result.code,
      detail: `channel=${channel}`, // channel là LOẠI kênh — không phải email/phone thô
    });
  } catch (e) {
    captureError("recovery", e, { action: "user.recovery_requested" });
  }

  return { success: RECOVERY_SENT_MESSAGE };
}

// ─── Bước 2: nhập mã + mật khẩu mới ───────────────────────────────────────────

const confirmSchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/, "Mã gồm 6 chữ số"),
  newPassword: z.string().min(6, "Mật khẩu tối thiểu 6 ký tự").max(100, "Mật khẩu tối đa 100 ký tự"),
});

export async function confirmPasswordRecoveryAction(
  _prev: RecoveryFormState,
  formData: FormData,
): Promise<RecoveryFormState> {
  // 1) IP rate limit riêng cho confirm (spec §7.1 — OTP verify endpoint).
  const limited = await recoveryRateLimited("recovery:confirm", RECOVERY_CONFIRM_RULE);
  if (limited) return limited;

  // 2) Validate — identifier + mã 6 chữ số + mật khẩu mới (trước khi đụng OTP).
  const parsed = parseIdentifier(String(formData.get("identifier") ?? ""));
  if (!parsed) return { error: IDENTIFIER_INVALID_MESSAGE };
  const creds = confirmSchema.safeParse({
    code: String(formData.get("code") ?? "").trim(),
    newPassword: String(formData.get("newPassword") ?? ""),
  });
  if (!creds.success) {
    return { error: creds.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  }
  const { channel, target } = parsed;
  const { code, newPassword } = creds.data;

  // 3) Tra user theo kênh ĐÃ XÁC MINH — không khớp → CÙNG lỗi collapsed với sai mã
  //    (không phân biệt "không có tài khoản" vs "mã sai" — spec §7.7).
  const user = await findUserByVerifiedIdentifier(channel, target);
  if (!user) return { error: RECOVERY_CODE_INVALID_MESSAGE };

  // 4) verifyOtp — mọi failure code (OTP_NOT_FOUND/OTP_EXPIRED/OTP_MAX_ATTEMPTS)
  //    collapse về CÙNG lỗi (không leak "có mã nhưng hết hạn" — spec §7.7).
  const verified = await verifyOtp({
    userId: user.id,
    purpose: "password_recovery",
    channel,
    target,
    code,
  });
  if (!verified.ok) return { error: RECOVERY_CODE_INVALID_MESSAGE };

  // 5) Mật khẩu mới + thu hồi MỌI session — revokeAllUserSessions ĐÚNG 2 tham số,
  //    KHÔNG exceptSessionId: session hiện tại (nếu có) cũng chết (Review Focus 3).
  const passwordHash = await hashPassword(newPassword);
  await db.orm.public.User.where({ id: user.id }).updateAll({ passwordHash });
  await revokeAllUserSessions(user.id, "password_recovery");

  // 6) Audit + notify + security notice — fail-open: completion không phụ thuộc
  //    bảng audit/hệ thống notice (và trạng thái hỏng không thành oracle enumeration).
  try {
    await auditEvent({
      actorId: user.id,
      subjectId: user.id,
      action: "user.recovery_completed",
      resourceType: "User",
      resourceId: user.id,
      reason: "verified_channel_otp",
      detail: `channel=${channel}`,
    });
  } catch (e) {
    captureError("recovery", e, { action: "user.recovery_completed" });
  }
  try {
    await notify(
      user.id,
      "security",
      "Mật khẩu đã được đặt lại",
      "Bạn vừa đặt lại mật khẩu qua mã xác minh. Mọi phiên đăng nhập đã được thu hồi. Nếu không phải bạn, hãy liên hệ hỗ trợ ngay.",
      "/login",
    );
  } catch (e) {
    captureError("recovery", e, { action: "recovery_completed_notify" });
  }
  try {
    // spec §7.7 "notify previous verified channels when feasible" — kênh đã
    // xác minh vừa dùng; adapter tự fail-open (sendSecurityNotice không throw,
    // KHÔNG log body/target — spec §4.8).
    await getOtpDeliveryAdapter().sendSecurityNotice({
      to: target,
      channel,
      subjectKey: "password_reset",
    });
  } catch {
    // belt & suspenders — notice không bao giờ chặn completion
  }

  return { success: RECOVERY_COMPLETED_MESSAGE };
}
