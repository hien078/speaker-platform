"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/src/prisma/db.client";
import { hashPassword, verifyPassword, createSession, destroySession } from "@/src/lib/auth";
import { verifyAdminMfaCode } from "@/src/lib/admin-mfa";
import { auditEvent } from "@/src/lib/audit-event";
import { checkRateLimit, clientIpFromHeaders } from "@/src/lib/rate-limit";
import { safeNextPath } from "@/src/lib/redirect";

/** 10 lần / 10 phút / IP cho login + register (chống brute-force / spam tài khoản) */
const AUTH_RULE = { limit: 10, windowMs: 10 * 60_000 };

/**
 * 10 lần / 10 phút cho mỗi lần SUBMIT mã MFA ở login (review fix #3 — spec §7.2).
 * HAI bucket: per-IP (auth:mfa:ip:<ip>) và PER-ACCOUNT (auth:mfa:user:<id>) —
 * kẻ brute-force một tài khoản qua nhiều IP vẫn đụng bucket account. Bucket
 * đếm MỌI lần submit (kể cả mã đúng — fail closed) và ĐƯỢC KIỂM TRA TRƯỚC
 * verifyAdminMfaCode: đang limited thì KHÔNG verify — mã đúng cũng bị từ chối,
 * không còn oracle "đoán đúng thì vào được". Window trượt 10 phút → tự mở lại,
 * KHÔNG khóa vĩnh viễn (backoff qua retryAfterSec trong message).
 */
const MFA_ATTEMPT_RULE = { limit: 10, windowMs: 10 * 60_000 };

/** Giữ rate limit ở action (không phải UI) — action là entry point công khai. Fail open. */
async function authRateLimited(scope: string): Promise<AuthFormState | null> {
  try {
    const ip = clientIpFromHeaders(await headers());
    const decision = checkRateLimit(`${scope}:${ip}`, AUTH_RULE);
    if (decision.allowed) return null;
    return { error: `Quá nhiều lần thử — chờ ${decision.retryAfterSec} giây rồi thử lại.` };
  } catch {
    return null; // limiter lỗi → không chặn người dùng
  }
}

/**
 * Pre-check HAI bucket MFA (per-IP + per-account) — gọi TRƯỚC verifyAdminMfaCode.
 * Fail open như authRateLimited: limiter lỗi → không chặn.
 */
async function mfaAttemptLimited(userId: string): Promise<AuthFormState | null> {
  try {
    const ip = clientIpFromHeaders(await headers());
    const ipDecision = checkRateLimit(`auth:mfa:ip:${ip}`, MFA_ATTEMPT_RULE);
    if (!ipDecision.allowed) {
      return { error: `Quá nhiều lần thử mã xác thực — chờ ${ipDecision.retryAfterSec} giây rồi thử lại.` };
    }
    const userDecision = checkRateLimit(`auth:mfa:user:${userId}`, MFA_ATTEMPT_RULE);
    if (!userDecision.allowed) {
      return { error: `Quá nhiều lần thử mã xác thực — chờ ${userDecision.retryAfterSec} giây rồi thử lại.` };
    }
    return null;
  } catch {
    return null;
  }
}

/** Audit fail-open — audit hỏng không làm hỏng login (spec §4.6/§4.8, không PII/mã thô). */
async function auditMfaEvent(input: {
  actorId: string;
  action: string;
  reason: string;
  resourceType?: string;
  resourceId?: string;
}): Promise<void> {
  try {
    await auditEvent(input);
  } catch {
    /* fail-open: audit lỗi không chặn login */
  }
}

const registerSchema = z.object({
  name: z.string().trim().min(2, "Tên quá ngắn").max(80),
  email: z.string().trim().email("Email không hợp lệ"),
  password: z.string().min(6, "Mật khẩu tối thiểu 6 ký tự").max(100),
  phone: z.string().trim().max(20).optional().or(z.literal("")),
  role: z.enum(["buyer", "seller"]).default("buyer"),
});

export type AuthFormState = { error?: string; mfaRequired?: boolean };

export async function registerAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const limited = await authRateLimited("auth:register");
  if (limited) return limited;

  const parsed = registerSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
    phone: formData.get("phone") || "",
    role: formData.get("role") || "buyer",
  });
  const next = String(formData.get("next") ?? "");

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  }
  const { name, email, password, phone, role } = parsed.data;
  const emailNormalized = email.toLowerCase();

  const existing = await db.orm.public.User.where({ email: emailNormalized }).first();
  if (existing) {
    return { error: "Email này đã được đăng ký. Bạn thử đăng nhập xem." };
  }

  const passwordHash = await hashPassword(password);
  const user = await db.orm.public.User.create({
    name,
    email: emailNormalized,
    passwordHash,
    phone: phone || null,
    role,
  });

  // tạo giỏ hàng riêng cho user
  await db.orm.public.Cart.create({ userId: user.id });

  await createSession(user.id);
  // quay về trang đang xem nếu có ?next= — chỉ path nội bộ (chống open redirect)
  const safe = safeNextPath(next);
  if (safe) redirect(safe);
  redirect("/");
}

/**
 * Kết thúc login thành công: giỏ hàng + session + redirect. Redirect throw
 * NEXT_REDIRECT nên hàm không bao giờ return — dùng chung cho admin (sau MFA)
 * và user thường.
 */
async function finishLogin(userId: string, next: string, isAdmin: boolean): Promise<never> {
  // đảm bảo có giỏ hàng
  const cart = await db.orm.public.Cart.first({ userId });
  if (!cart) await db.orm.public.Cart.create({ userId });

  // admin: session 12h (ADMIN_SESSION_TTL_HOURS trong session.ts — spec §5.4.2)
  if (isAdmin) {
    await createSession(userId, { isAdmin: true });
  } else {
    await createSession(userId);
  }

  // quay về trang đang xem nếu có ?next= — chỉ path nội bộ (chống open redirect)
  const safe = safeNextPath(next);
  if (safe) redirect(safe);
  redirect("/");
}

export async function loginAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const limited = await authRateLimited("auth:login");
  if (limited) return limited;

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "");

  if (!email || !password) {
    return { error: "Vui lòng nhập email và mật khẩu" };
  }

  const user = await db.orm.public.User.where({ email }).first();
  if (!user) {
    return { error: "Email hoặc mật khẩu không đúng" };
  }

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    return { error: "Email hoặc mật khẩu không đúng" };
  }

  // ─── Admin MFA (Batch 2 Task 8 — spec §5.3/§5.4.2) ──────────────────────
  // MFA BẮT BUỘC với mọi tài khoản adminRole (spec §5.4.2 "All admin accounts
  // require MFA enrollment"). Factor chỉ là TOTP hoặc mã khôi phục — SMS
  // KHÔNG bao giờ là factor admin (spec §5.3), không có code path nào gửi tin
  // nhắn ở đây. Chưa enroll → KHÔNG tạo session (fail closed — enrollment qua
  // bootstrap script offline, Task 11; không có đường enroll qua web).
  if (user.adminRole != null) {
    const mfa = await db.orm.public.AdminMfa.first({ userId: user.id });
    if (!mfa) {
      return {
        error:
          "MFA_ENROLLMENT_REQUIRED: tài khoản quản trị chưa kích hoạt MFA (TOTP) — " +
          "cần kích hoạt qua bootstrap script (xem runbook) rồi đăng nhập lại.",
      };
    }

    const mfaCode = String(formData.get("mfaCode") ?? "").trim();
    if (!mfaCode) {
      // Đúng mật khẩu + thiếu mã → trả mfaRequired để form hiện field mã
      // (src/components/auth-form.tsx) — KHÔNG tạo session.
      return { mfaRequired: true };
    }

    // Review fix #3: rate limit KIỂM TRA TRƯỚC verify (per-IP + per-account) —
    // đang limited thì KHÔNG verify, mã đúng cũng bị từ chối (fail closed).
    const limited = await mfaAttemptLimited(user.id);
    if (limited) return limited;

    const factor = await verifyAdminMfaCode(user.id, mfaCode);
    if (factor === null) {
      // Sai mã — KHÔNG session; audit "admin.mfa_failed" (fail-open, KHÔNG chứa
      // mã thô — spec §4.8). verifyAdminMfaCode không khóa tài khoản (chống
      // lockout vĩnh viễn — spec §5.4.2) — rate limit là ranh giới duy nhất.
      await auditMfaEvent({
        actorId: user.id,
        action: "admin.mfa_failed",
        reason: "login_invalid_code",
        resourceType: "AdminMfa",
        resourceId: mfa.id,
      });
      return {
        error: "Mã xác thực không đúng. Dùng mã TOTP (6 chữ số) hoặc một mã khôi phục chưa dùng.",
      };
    }

    // Audit login admin thành công (review minor) — reason = factor, KHÔNG PII.
    await auditMfaEvent({
      actorId: user.id,
      action: "admin.login",
      reason: factor, // "totp" | "recovery_code"
      resourceType: "AdminMfa",
      resourceId: mfa.id,
    });

    if (factor === "recovery_code") {
      // Mã khôi phục đã dùng MỘT LẦN — audit (spec §4.6); detail KHÔNG chứa mã
      // thô (spec §4.8 — auditEvent chỉ nhận typed reason, không PII).
      await auditEvent({
        actorId: user.id,
        action: "admin.mfa_recovery_code_used",
        resourceType: "AdminMfa",
        resourceId: mfa.id,
        reason: "login_recovery_code",
      });
    }

    return finishLogin(user.id, next, true);
  }

  // ─── User thường — MFA không áp dụng (field mfaCode bỏ qua hoàn toàn) ─────
  return finishLogin(user.id, next, false);
}

export async function logoutAction(): Promise<void> {
  await destroySession();
  redirect("/login");
}
