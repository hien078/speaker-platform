"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { isUniqueConstraintViolation } from "@prisma/orm-family-sql/errors";
import { db } from "@/src/prisma/db.client";
import { requireUser, verifyPassword, hashPassword } from "@/src/lib/auth";
import { revokeAllUserSessions } from "@/src/lib/session";
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
 * §5.3.1). Mọi action:
 *
 *  1. `requireUser()` TRƯỚC — không session → redirect /login, không chạm db.
 *  2. zod-validate formData — input là untrusted (server action = POST công khai).
 *  3. Thông báo lỗi tiếng Việt (user-facing) + `code` ổn định trong state cho
 *     test/client — KHÔNG bao giờ chứa raw email/phone/OTP/password (spec §4.8).
 *
 * Quy tắc danh tính (spec §5.3.1):
 *  - Email/phone ĐÃ XÁC MINH là duy nhất giữa các tài khoản active; collision →
 *    typed error (EMAIL_TAKEN / PHONE_ALREADY_VERIFIED), KHÔNG BAO GIỜ merge.
 *    Email có unique constraint ở DB (ranh giới cuối, phân loại 23505); phone
 *    KHÔNG có constraint → re-check collision BÊN TRONG transaction ở confirm
 *    (race còn dư giữa hai confirm song song được chấp nhận + ghi nhận trong
 *    verification doc: single app instance, ops review query có trong runbook).
 *  - Uniqueness chỉ áp cho danh tính ĐÃ xác minh — số giống nhau held unverified
 *    bởi tài khoản khác không chặn verify (chỉ chủ verified mới giữ badge).
 *  - Đổi email/phone đòi step-up (xác thực lại mật khẩu hiện tại) ở request +
 *    OTP tới kênh MỚI ở confirm; đổi xong reset verifiedAt (= now cho kênh mới),
 *    thu hồi MỌI session khác (session hiện tại sống), gửi security notice tới
 *    kênh CŨ ("when feasible" — fail-open, spec §5.3.1) + notify in-app.
 *  - Đổi mật khẩu: xác thực lại mật khẩu hiện tại, thu hồi session khác.
 *
 * OTP core (hashed/single-use/TTL/attempt/resend/rate-limit) thuộc src/lib/otp.ts
 * (Task 3); audit action names theo registry Task 5 — không tự chế tên.
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

/**
 * Notice bảo mật tới kênh CŨ sau thay đổi nhạy cảm (spec §5.3.1 "when
 * feasible") — fail-open CÓ Ý THỨC: notice không bao giờ làm hỏng flow chính
 * (danh tính đã đổi rồi). KHÔNG log error message (message của provider có thể
 * chứa target/nội dung — spec §4.8); log cố định chỉ subjectKey.
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

/** Step-up consumer (spec §5.3.1): xác thực lại mật khẩu HIỆN TẠI. */
async function verifyCurrentPassword(
  userId: string,
  currentPassword: string,
): Promise<VerificationFormState | null> {
  if (!currentPassword) return { ...MISSING_CURRENT_PASSWORD };
  const row = await db.orm.public.User.first({ id: userId });
  if (!row) return { ...USER_NOT_FOUND };
  const ok = await verifyPassword(currentPassword, row.passwordHash);
  if (!ok) return { ...WRONG_PASSWORD };
  return null;
}

// ─── Email verification ───────────────────────────────────────────────────────

export async function requestEmailVerificationAction(
  _prev: VerificationFormState,
  _formData: FormData,
): Promise<VerificationFormState> {
  const user = await requireUser();
  const target = normalizeEmail(user.email);

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
  const target = normalizeEmail(user.email);

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

// ─── Phone verification ───────────────────────────────────────────────────────

export async function requestPhoneVerificationAction(
  _prev: VerificationFormState,
  formData: FormData,
): Promise<VerificationFormState> {
  const user = await requireUser();
  let target: string;
  try {
    target = normalizePhone(String(formData.get("phone") ?? ""));
  } catch {
    return { ...INVALID_PHONE };
  }

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
  let target: string;
  try {
    target = normalizePhone(String(formData.get("phone") ?? ""));
  } catch {
    return { ...INVALID_PHONE };
  }

  const verified = await verifyOtp({
    userId: user.id,
    purpose: "phone_verification",
    channel: "phone",
    target,
    code: parsed.data,
  });
  if (!verified.ok) return otpVerifyFailure(verified.code);

  // Collision re-check TRONG tx (spec §5.3.1): phone ĐÃ ĐƯỢC XÁC MINH bởi tài
  // khoản khác → typed error, rollback, KHÔNG merge, KHÔNG update. Uniqueness
  // chỉ áp cho danh tính ĐÃ xác minh — số held unverified ở tài khoản khác
  // không chặn (không có row phoneVerifiedAt != null nào khớp).
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

// ─── Đổi mật khẩu (step-up + session invalidation — Review Focus 3) ───────────

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

  // Step-up (spec §5.3.1): xác thực lại mật khẩu HIỆN TẠI trước khi đổi.
  const stepUpFailure = await verifyCurrentPassword(user.id, currentPassword);
  if (stepUpFailure) return stepUpFailure;

  const passwordHash = await hashPassword(newPassword);
  await db.orm.public.User.where({ id: user.id }).update({ passwordHash });

  // Session invalidation (spec §5.3.1/§7.2): thu hồi MỌI session KHÁC —
  // session hiện tại sống để user không bị đá ra giữa chừng.
  await revokeAllUserSessions(user.id, "password_change", {
    exceptSessionId: user.sessionId,
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

// ─── Đổi email (step-up + OTP tới email mới + notice tới email CŨ) ─────────────

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

  // Step-up (spec §5.3.1): đổi email là thay đổi nhạy cảm — xác thực lại.
  const stepUpFailure = await verifyCurrentPassword(
    user.id,
    String(formData.get("currentPassword") ?? ""),
  );
  if (stepUpFailure) return stepUpFailure;

  // Pre-check uniqueness (ranh giới ACTION; DB unique constraint là ranh giới
  // cuối ở confirm). Thông điệp enumeration-safe: actor đã đăng nhập, chỉ biết
  // "email đã có người dùng" — không biết của ai, không thêm gì khác.
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
  const oldEmail = normalizeEmail(user.email);

  const verified = await verifyOtp({
    userId: user.id,
    purpose: "email_verification",
    channel: "email",
    target: newEmail,
    code: codeParsed.data,
  });
  if (!verified.ok) return otpVerifyFailure(verified.code);

  // tx: swap email + emailVerifiedAt + thu hồi session khác. Unique constraint
  // của User.email là ranh giới CUỐI (race giữa pre-check ở request và confirm):
  // 23505 → typed EMAIL_TAKEN; lỗi khác ném tiếp (fail closed).
  try {
    await db.transaction(async (tx) => {
      await tx.orm.public.User
        .where({ id: user.id })
        .update({ email: newEmail, emailVerifiedAt: new Date().toISOString() });
      await revokeAllUserSessions(user.id, "email_change", {
        exceptSessionId: user.sessionId,
      });
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
  // Security notice tới kênh CŨ (spec §5.3.1 "when feasible") — fail-open.
  await sendSecurityNotice(oldEmail, "email", "email_changed");
  await notify(
    user.id,
    "security",
    "Đã đổi email đăng nhập",
    "Email đăng nhập của bạn đã được thay đổi và xác minh. Nếu không phải bạn thực hiện, hãy khôi phục mật khẩu ngay.",
  );
  revalidatePath("/profile");
  return { success: "Đã đổi email đăng nhập. Các thiết bị khác đã bị đăng xuất." };
}

// ─── Đổi số điện thoại (tương tự email + collision re-check trong tx) ─────────

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

  // Step-up (spec §5.3.1): xác thực lại mật khẩu hiện tại.
  const stepUpFailure = await verifyCurrentPassword(
    user.id,
    String(formData.get("currentPassword") ?? ""),
  );
  if (stepUpFailure) return stepUpFailure;

  // Pre-check collision ("tương tự email" — plan Task 6): số đã ĐƯỢC XÁC MINH
  // bởi tài khoản khác → chặn TRƯỚC khi tốn một SMS. Re-check trong tx ở
  // confirm vẫn là ranh giới enforcement (race giữa request và confirm).
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

  // Phone CŨ (cho security notice — spec §5.3.1): SessionUser không mang phone,
  // đọc từ row TRƯỚC khi swap.
  const row = await db.orm.public.User.first({ id: user.id });
  if (!row) return { ...USER_NOT_FOUND };
  const oldPhone = row.phone;

  const verified = await verifyOtp({
    userId: user.id,
    purpose: "phone_verification",
    channel: "phone",
    target: newPhone,
    code: codeParsed.data,
  });
  if (!verified.ok) return otpVerifyFailure(verified.code);

  // tx: collision re-check + swap + thu hồi session khác (spec §5.3.1).
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
      await revokeAllUserSessions(user.id, "phone_change", {
        exceptSessionId: user.sessionId,
      });
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
  // Notice tới kênh CŨ — chỉ khi từng có số cũ ("when feasible", fail-open).
  if (oldPhone !== null) {
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
