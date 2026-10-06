"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/src/prisma/db.client";
import { requireCapability, requireAdminUser, stepUpMfaLimited } from "@/src/lib/rbac";
import {
  revokeSession,
  revokeAllUserSessions,
  markSessionSteppedUp,
} from "@/src/lib/session";
import { destroySession } from "@/src/lib/auth";
import {
  verifyAdminMfaCode,
  generateRecoveryCodes,
  hashRecoveryCode,
  RECOVERY_CODE_COUNT,
} from "@/src/lib/admin-mfa";
import { auditEvent, auditEventTx } from "@/src/lib/audit-event";

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
 *     reason typed. Review fix #1/#3/#4:
 *     - Giá trị exceptSessionId từ form BỊ BỎ QUA — except duy nhất được phép là
 *       session HIỆN TẠI của CHÍNH admin, derive server-side, và chỉ khi form
 *       có tín hiệu except (form "Đăng xuất các thiết bị khác" /admin/security);
 *       nhắm user khác → thu hồi TẤT CẢ (không giữ sống session đánh cắp, audit
 *       thành thật).
 *     - Tự thu hồi session HIỆN TẠI / TẤT CẢ phiên của chính mình (form
 *       /admin/users không except) → destroySession (reason "logout" + xóa
 *       cookie) + redirect /login — logout sạch, không trạng thái zombie.
 *     - Chỉ audit khi row THẬT SỰ bị thu hồi (revokeSession trả count — 0 row
 *       = đã revoke từ trước → idempotent, không audit).
 *  2. stepUpAction — xác thực lại (TOTP/mã khôi phục) từ form /admin/security:
 *     requireAdminUser (MỌI adminRole — tự phục vụ, không đòi capability quản
 *     trị ai khác) + verifyAdminMfaCode → markSessionSteppedUp + audit
 *     "admin.step_up". Rate limit qua stepUpMfaLimited DÙNG CHUNG bucket rbac
 *     (stepup:mfa:session/user/ip — review fix #5: một nguồn keys/rule duy
 *     nhất, không surface nào là oracle brute-force riêng).
 *  3. regenerateRecoveryCodesAction — tự phục vụ MFA của CHÍNH MÌNH: bắt buộc
 *     mã MFA đúng (step-up thực — không phải nút bấm suông), xoá 10 mã cũ +
 *     sinh 10 mã mới + GHI AUDIT (auditEventTx) trong MỘT transaction (review
 *     fix #2: audit fail → rollback — mã cũ sống, không bao giờ "đã xoá mã mà
 *     không có audit/hiển thị"), trả state.recoveryCodes hiển thị MỘT LẦN.
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
 * (registry Task 5) với reason typed "admin_revoked".
 *
 * Review fix #3: thu hồi session HIỆN TẠI của chính mình = LOGOUT SẠCH —
 * destroySession (revoke reason "logout" + xóa cookie) + redirect /login,
 * không để admin trong trạng thái zombie (cookie trỏ session đã revoke).
 * Review fix #4: chỉ audit khi row THẬT SỰ bị thu hồi (revokeSession trả
 * count; 0 = đã revoke từ trước → idempotent, không audit). Session không
 * tồn tại → no-op im lặng (không oracle, không audit).
 */
export async function revokeUserSessionAction(formData: FormData): Promise<void> {
  const admin = await requireCapability("session.revoke");
  const parsed = z.string().min(1).safeParse(String(formData.get("sessionId") ?? ""));
  if (!parsed.success) return;
  const sessionId = parsed.data;

  // Session HIỆN TẠI của chính mình → logout sạch (review fix #3).
  if (sessionId === admin.session.id) {
    await destroySession(); // revoke reason "logout" + xóa cookie
    await auditEvent({
      actorId: admin.user.id,
      subjectId: admin.user.id,
      action: "session.revoked",
      resourceType: "UserSession",
      resourceId: sessionId,
      sessionId: admin.session.id,
      reason: "logout",
    });
    redirect("/login"); // throw NEXT_REDIRECT — kết thúc sạch
  }

  // Row để biết CHỦ session cho audit subjectId — không tồn tại → no-op.
  const row = await db.orm.public.UserSession.first({ id: sessionId });
  if (!row) return;

  // Fix #4: chỉ audit khi có row THẬT SỰ bị thu hồi (0 = đã revoke từ trước).
  const revokedCount = await revokeSession(sessionId, "admin_revoked");
  if (revokedCount === 0) return;

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
 * (form "Đăng xuất các thiết bị khác" ở /admin/security truyền thêm tín hiệu
 * exceptSessionId — plan Task 9 "revoke-all-others").
 * requireCapability("session.revoke") + audit "session.revoked_all" (registry
 * Task 5) với reason typed "admin_revoked_all".
 *
 * Review fix #1 (LOW-MED): GIÁ TRỊ exceptSessionId từ form BỊ BỎ QUA hoàn toàn
 * — kẻ tấn công trong role có quyền không thể giữ sống session đánh cắp của
 * user đích qua trường này (và audit không còn đọc sai thành force-logout
 * toàn bộ). Except duy nhất được phép: session HIỆN TẠI của CHÍNH admin,
 * derive server-side, và chỉ khi form có tín hiệu except + nhắm chính mình.
 *
 * Review fix #3: tự thu hồi TẤT CẢ (form /admin/users nhắm chính mình — không
 * tín hiệu except) = force-logout chính mình → destroySession (reason
 * "logout" + xóa cookie) + redirect /login — không trạng thái zombie.
 */
export async function revokeAllUserSessionsAction(formData: FormData): Promise<void> {
  const admin = await requireCapability("session.revoke");
  const userIdParsed = z.string().min(1).safeParse(String(formData.get("userId") ?? ""));
  if (!userIdParsed.success) return;
  const userId = userIdParsed.data;
  const isSelf = userId === admin.user.id;

  // Fix #1: chỉ dùng TÍN HIỆU có trường exceptSessionId — GIÁ TRỊ bị bỏ qua;
  // except luôn derive = session HIỆN TẠI của admin, và chỉ khi nhắm chính mình.
  const wantsExceptCurrent = String(formData.get("exceptSessionId") ?? "") !== "";
  const exceptSessionId = isSelf && wantsExceptCurrent ? admin.session.id : undefined;

  // Fix #3: tự thu hồi TẤT CẢ phiên của chính mình (không except) = logout sạch.
  if (isSelf && !wantsExceptCurrent) {
    const revokedOthers = await revokeAllUserSessions(userId, "admin_revoked_all", {
      exceptSessionId: admin.session.id,
    });
    await destroySession(); // session hiện tại: reason "logout" + xóa cookie
    await auditEvent({
      actorId: admin.user.id,
      subjectId: userId,
      action: "session.revoked_all",
      resourceType: "User",
      resourceId: userId,
      sessionId: admin.session.id,
      reason: "admin_revoked_all",
      detail: `count=${revokedOthers + 1}`, // mọi session kể cả hiện tại (spec §4.8 — chỉ count)
    });
    redirect("/login"); // throw NEXT_REDIRECT — kết thúc sạch
  }

  // Còn lại: user KHÁC (thu hồi TẤT CẢ — except crafted đã bị bỏ qua) hoặc
  // chính mình + tín hiệu except (đăng xuất thiết bị khác — session hiện tại sống).
  const revoked = await revokeAllUserSessions(
    userId,
    "admin_revoked_all",
    exceptSessionId !== undefined ? { exceptSessionId } : {},
  );

  await auditEvent({
    actorId: admin.user.id,
    subjectId: userId,
    action: "session.revoked_all",
    resourceType: "User",
    resourceId: userId,
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

  // Rate limit TRƯỚC verify — stepUpMfaLimited DÙNG CHUNG bucket rbac (fix #5).
  const limitedSec = await stepUpMfaLimited(admin.user.id, admin.session.id);
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

  // Rate limit TRƯỚC verify — stepUpMfaLimited DÙNG CHUNG bucket rbac (fix #5;
  // brute-force mã để sinh bộ mã khôi phục mới cho session đánh cắp =
  // persistence → phải tiêu cùng budget, không oracle riêng).
  const limitedSec = await stepUpMfaLimited(admin.user.id, admin.session.id);
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

  // MỘT transaction: xoá mã cũ + tạo mã mới + GHI AUDIT (review fix #2) —
  // auditEventTx sống chết cùng mutation: audit fail → rollback → mã cũ
  // sống (fail closed an toàn), không bao giờ "đã xoá mã cũ mà không có
  // audit/hiển thị mã mới". Throw-out rule: KHÔNG catch trong tx — lỗi lan
  // ra để rollback toàn bộ.
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
    await auditEventTx(tx, {
      actorId: admin.user.id,
      subjectId: admin.user.id,
      action: "admin.mfa_recovery_codes_regenerated",
      resourceType: "AdminMfa",
      resourceId: mfa.id,
      sessionId: admin.session.id,
      reason: factor, // "totp" | "recovery_code" — typed reason code
      detail: `count=${RECOVERY_CODE_COUNT}`, // KHÔNG chứa mã thô (spec §4.8)
    });
  });

  revalidatePath("/admin/security");
  return {
    recoveryCodes: newCodes, // hiển thị MỘT LẦN — client không lưu lại
    success: "Đã sinh lại 10 mã khôi phục — lưu ngay, chỉ hiển thị một lần.",
  };
}
