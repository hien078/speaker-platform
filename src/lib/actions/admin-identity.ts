"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import { db } from "@/src/prisma/db.client";
import { requireCapability, requireAdminUser } from "@/src/lib/rbac";
import {
  revokeSession,
  revokeAllUserSessions,
  markSessionSteppedUp,
} from "@/src/lib/session";
import {
  verifyAdminMfaCode,
  generateRecoveryCodes,
  hashRecoveryCode,
  RECOVERY_CODE_COUNT,
} from "@/src/lib/admin-mfa";
import { auditEvent } from "@/src/lib/audit-event";
import { checkRateLimit, clientIpFromHeaders, type RateLimitRule } from "@/src/lib/rate-limit";

/**
 * Admin identity surfaces (Batch 2 Task 9 — spec §5.4.2 admin session
 * requirements, §4.5 backend authorization, §4.6 auditability).
 *
 * Ba nhóm action cho /admin/security + /admin/users:
 *
 *  1. Thu hồi session (revokeUserSessionAction / revokeAllUserSessionsAction) —
 *     requireCapability("session.revoke") (ma trận §5.4.1: super/ops; ô Scoped
 *     của moderator/support fail closed — Ambiguities A2). Admin thu hồi được
 *     session của BẤT KỲ user nào (kể cả admin khác — spec §5.4.2 "explicit
 *     revocation support"), audit "session.revoked"/"session.revoked_all" với
 *     reason typed. Thu hồi session HIỆN TẠI của chính mình = logout sạch
 *     (lookup request sau fail closed).
 *  2. stepUpAction — xác thực lại (TOTP/mã khôi phục) từ form /admin/security:
 *     requireAdminUser (MỌI adminRole — tự phục vụ, không đòi capability quản
 *     trị ai khác) + verifyAdminMfaCode → markSessionSteppedUp + audit
 *     "admin.step_up". Rate limit CHUNG bucket rbac.requireCapabilityWithStepUp
 *     (stepup:mfa:session/user/ip) — brute-force mã MFA qua form này tiêu cùng
 *     budget, không tạo oracle riêng (review fix #2 Task 8 áp dụng cùng surface).
 *  3. regenerateRecoveryCodesAction — tự phục vụ MFA của CHÍNH MÌNH: bắt buộc
 *     mã MFA đúng (step-up thực — không phải nút bấm suông), xoá 10 mã cũ +
 *     sinh 10 mã mới trong MỘT transaction (không bao giờ tồn tại cả hai bộ),
 *     trả state.recoveryCodes hiển thị MỘT LẦN, audit
 *     "admin.mfa_recovery_codes_regenerated" (registry mở rộng ở Task 9).
 *
 * KHÔNG log mã MFA/mã khôi phục thô ở bất kỳ path nào (spec §4.8); audit detail
 * chỉ chứa count/typed reason. UI (/admin/security) lọc nút theo capability là
 * CONVENIENCE — mọi action ở đây TỰ guard server-side (spec §4.5).
 */

export type AdminSecurityFormState = {
  /** Thông báo lỗi tiếng Việt (user-facing). */
  error?: string;
  /** Thông báo thành công tiếng Việt (user-facing). */
  success?: string;
  /** 10 mã khôi phục MỚI — hiển thị MỘT LẦN ở client (regenerateRecoveryCodesAction). */
  recoveryCodes?: string[];
  /** Báo client highlight ô mã MFA (thiếu mã / step-up chưa tươi). */
  stepUpRequired?: boolean;
};

// ─── Rate limit — CHUNG bucket với rbac.requireCapabilityWithStepUp ──────────

/**
 * Bucket submit mã MFA ở /admin/security — CÙNG key + ngưỡng rbac.ts
 * (stepup:mfa:session/user/ip, 10/10 phút, window trượt): budget DÙNG CHUNG
 * mọi surface step-up, form này không mở oracle brute-force riêng. Đếm MỌI
 * lần submit (kể cả đúng) và KIỂM TRA TRƯỚC verifyAdminMfaCode — đang limited
 * thì KHÔNG verify (mã đúng cũng bị từ chối, không còn oracle "đúng thì vào").
 * Fail open (limiter lỗi → không chặn) — cùng posture rbac.ts/auth.ts.
 */
const MFA_SUBMIT_RULE: RateLimitRule = { limit: 10, windowMs: 10 * 60_000 };

async function mfaSubmitLimited(userId: string, sessionId: string): Promise<number | null> {
  try {
    const ip = clientIpFromHeaders(await headers());
    const keys = [
      `stepup:mfa:session:${sessionId}`,
      `stepup:mfa:user:${userId}`,
      `stepup:mfa:ip:${ip}`,
    ];
    for (const key of keys) {
      const decision = checkRateLimit(key, MFA_SUBMIT_RULE);
      if (!decision.allowed) return decision.retryAfterSec;
    }
    return null;
  } catch {
    return null; // limiter lỗi → không chặn (fail open)
  }
}

/** Audit fail-open — lỗi audit không chặn response chính (spec §4.6/§4.8). */
async function auditFailOpen(input: Parameters<typeof auditEvent>[0]): Promise<void> {
  try {
    await auditEvent(input);
  } catch {
    /* fail-open: audit lỗi không làm hỏng flow chính */
  }
}

// ─── 1. Thu hồi session — requireCapability("session.revoke") ────────────────

/**
 * Thu hồi MỘT session (id từ formData — session của user đích, có thể là
 * chính admin đó). requireCapability("session.revoke") + audit "session.revoked"
 * (registry Task 5) với reason typed "admin_revoked". Session không tồn tại →
 * no-op im lặng (không oracle, không audit — không có gì đã xảy ra).
 */
export async function revokeUserSessionAction(formData: FormData): Promise<void> {
  const admin = await requireCapability("session.revoke");
  const parsed = z.string().min(1).safeParse(String(formData.get("sessionId") ?? ""));
  if (!parsed.success) return;
  const sessionId = parsed.data;

  // Row để biết CHỦ session cho audit subjectId — không tồn tại → no-op.
  const row = await db.orm.public.UserSession.first({ id: sessionId });
  if (!row) return;

  await revokeSession(sessionId, "admin_revoked");
  await auditEvent({
    actorId: admin.user.id,
    subjectId: row.userId,
    action: "session.revoked",
    resourceType: "UserSession",
    resourceId: sessionId,
    sessionId: admin.session.id,
    reason: "admin_revoked",
  });
  revalidatePath("/admin/security");
  revalidatePath("/admin/users");
}

/**
 * Thu hồi MỌI session active của user đích (form "Thu hồi phiên" ở
 * /admin/users — force logout user) hoặc mọi session KHÁC của chính admin
 * (form "Đăng xuất các thiết bị khác" ở /admin/security truyền thêm
 * exceptSessionId = session hiện tại — plan Task 9 "revoke-all-others").
 * requireCapability("session.revoke") + audit "session.revoked_all" (registry
 * Task 5) với reason typed "admin_revoked_all".
 */
export async function revokeAllUserSessionsAction(formData: FormData): Promise<void> {
  const admin = await requireCapability("session.revoke");
  const userIdParsed = z.string().min(1).safeParse(String(formData.get("userId") ?? ""));
  if (!userIdParsed.success) return;
  // exceptSessionId TÙY CHỌN — chỉ /admin/security truyền (giữ session hiện tại
  // của chính admin); /admin/users không truyền → thu hồi TẤT CẢ.
  const exceptParsed = z.string().min(1).optional().safeParse(
    String(formData.get("exceptSessionId") ?? ""),
  );
  const exceptSessionId = exceptParsed.success ? exceptParsed.data : undefined;

  const revoked = await revokeAllUserSessions(userIdParsed.data, "admin_revoked_all", {
    ...(exceptSessionId !== undefined ? { exceptSessionId } : {}),
  });

  await auditEvent({
    actorId: admin.user.id,
    subjectId: userIdParsed.data,
    action: "session.revoked_all",
    resourceType: "User",
    resourceId: userIdParsed.data,
    sessionId: admin.session.id,
    reason: "admin_revoked_all",
    detail: `count=${revoked}`, // KHÔNG chứa PII thô (spec §4.8)
  });
  revalidatePath("/admin/security");
  revalidatePath("/admin/users");
}

// ─── 2. Step-up từ /admin/security ────────────────────────────────────────────

/**
 * Xác thực lại (step-up) session admin HIỆN TẠI từ form /admin/security —
 * requireAdminUser (MỌI adminRole; đây là tự phục vụ, không phải capability
 * quản trị người khác) + verifyAdminMfaCode(mã) → markSessionSteppedUp +
 * audit "admin.step_up" (reason = factor "totp"|"recovery_code" — registry
 * Task 5). Sau đó requireCapabilityWithStepUp cho các capability nhạy cảm
 * thấy step-up tươi và cho qua (spec §5.4.2).
 */
export async function stepUpAction(
  _prev: AdminSecurityFormState,
  formData: FormData,
): Promise<AdminSecurityFormState> {
  const admin = await requireAdminUser();
  const code = String(formData.get("mfaCode") ?? "").trim();
  if (!code) {
    return { error: "Nhập mã xác thực (TOTP hoặc mã khôi phục).", stepUpRequired: true };
  }

  // Rate limit TRƯỚC verify — cùng bucket rbac step-up (xem MFA_SUBMIT_RULE).
  const limitedSec = await mfaSubmitLimited(admin.user.id, admin.session.id);
  if (limitedSec !== null) {
    return {
      error: `Quá nhiều lần thử mã xác thực — chờ ${limitedSec} giây rồi thử lại.`,
      stepUpRequired: true,
    };
  }

  const factor = await verifyAdminMfaCode(admin.user.id, code);
  if (factor === null) {
    // audit fail-open, KHÔNG chứa mã thô (spec §4.8) — reason typed như rbac.ts
    await auditFailOpen({
      actorId: admin.user.id,
      action: "admin.mfa_failed",
      reason: "step_up_invalid_code",
      sessionId: admin.session.id,
    });
    return { error: "Mã xác thực không đúng.", stepUpRequired: true };
  }

  if (factor === "recovery_code") {
    // mã khôi phục dùng ở step-up cũng được audit như ở login/rbac (review minor)
    await auditFailOpen({
      actorId: admin.user.id,
      action: "admin.mfa_recovery_code_used",
      reason: "step_up_recovery_code",
      sessionId: admin.session.id,
      resourceType: "AdminMfa",
    });
  }

  await markSessionSteppedUp(admin.session.id);
  await auditEvent({
    actorId: admin.user.id,
    action: "admin.step_up",
    resourceType: "UserSession",
    resourceId: admin.session.id,
    sessionId: admin.session.id,
    reason: factor, // "totp" | "recovery_code" — typed reason code
  });
  return { success: "Đã xác thực lại — step-up có hiệu lực 15 phút cho các hành động nhạy cảm." };
}

// ─── 3. Sinh lại mã khôi phục — tự phục vụ MFA của chính mình ─────────────────

/**
 * Sinh lại 10 mã khôi phục của CHÍNH MÌNH (không phải capability quản trị ai
 * khác — requireAdminUser). Bắt buộc mã MFA ĐÚNG trong cùng request (step-up
 * thực — kẻ cắp session không thể sinh mã mới chỉ bằng cách bấm nút). Xoá 10
 * mã cũ + tạo 10 mã mới trong MỘT transaction: thất bại giữa chừng → rollback
 * (mã cũ sống), thành công → mã cũ chết NGAY (không bao giờ cả hai bộ cùng
 * tồn tại). state.recoveryCodes hiển thị MỘT LẦN ở client — DB chỉ lưu hash
 * (HMAC hkdfKey("recovery-code-hash") — src/lib/admin-mfa.ts).
 */
export async function regenerateRecoveryCodesAction(
  _prev: AdminSecurityFormState,
  formData: FormData,
): Promise<AdminSecurityFormState> {
  const admin = await requireAdminUser();
  const code = String(formData.get("mfaCode") ?? "").trim();
  if (!code) {
    return { error: "Nhập mã xác thực (TOTP hoặc mã khôi phục) để sinh lại mã.", stepUpRequired: true };
  }

  // Chưa enroll MFA → không có gì để sinh lại (fail closed, thông báo rõ —
  // enroll qua bootstrap script offline, Task 11).
  const mfa = await db.orm.public.AdminMfa.first({ userId: admin.user.id });
  if (!mfa) {
    return { error: "Tài khoản chưa có MFA — liên hệ quản trị để enroll." };
  }

  // Rate limit TRƯỚC verify — cùng bucket rbac step-up (brute-force mã để sinh
  // bộ mã khôi phục mới cho session đánh cắp = persistence → phải tiêu budget).
  const limitedSec = await mfaSubmitLimited(admin.user.id, admin.session.id);
  if (limitedSec !== null) {
    return {
      error: `Quá nhiều lần thử mã xác thực — chờ ${limitedSec} giây rồi thử lại.`,
      stepUpRequired: true,
    };
  }

  const factor = await verifyAdminMfaCode(admin.user.id, code);
  if (factor === null) {
    await auditFailOpen({
      actorId: admin.user.id,
      action: "admin.mfa_failed",
      reason: "recovery_codes_invalid_code",
      sessionId: admin.session.id,
    });
    return { error: "Mã xác thực không đúng.", stepUpRequired: true };
  }

  // MỘT transaction: xoá mã cũ + tạo mã mới — không bao giờ dư/mất bộ mã.
  const newCodes = generateRecoveryCodes();
  await db.transaction(async (tx) => {
    await tx.orm.public.AdminRecoveryCode.where({ mfaId: mfa.id }).delete();
    for (const one of newCodes) {
      await tx.orm.public.AdminRecoveryCode.create({
        mfaId: mfa.id,
        codeHash: hashRecoveryCode(one),
        usedAt: null, // explicit — single-use: chưa dùng
      });
    }
  });

  await auditEvent({
    actorId: admin.user.id,
    subjectId: admin.user.id,
    action: "admin.mfa_recovery_codes_regenerated",
    resourceType: "AdminMfa",
    resourceId: mfa.id,
    sessionId: admin.session.id,
    reason: factor, // "totp" | "recovery_code" — typed reason code
    detail: `count=${RECOVERY_CODE_COUNT}`, // KHÔNG chứa mã thô (spec §4.8)
  });
  revalidatePath("/admin/security");
  return {
    recoveryCodes: newCodes, // hiển thị MỘT LẦN — client không lưu lại
    success: "Đã sinh lại 10 mã khôi phục — lưu ngay, chỉ hiển thị một lần.",
  };
}
