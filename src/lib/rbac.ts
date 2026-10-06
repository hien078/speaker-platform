import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  getSessionFromCookie,
  markSessionSteppedUp,
  stepUpIsFresh,
  type SessionInfo,
  type SessionUser,
} from "@/src/lib/session";
import { verifyAdminMfaCode } from "@/src/lib/admin-mfa";
import { auditEvent } from "@/src/lib/audit-event";
import { checkRateLimit, clientIpFromHeaders, type RateLimitRule } from "@/src/lib/rate-limit";

/**
 * Capability RBAC (Batch 2 Task 4 — spec §5.4/§5.4.1) — thay check role rộng
 * của Batch 1 bằng ma trận capability typed, enforce ở MỌI ranh giới
 * server action / page admin (spec §4.5: hidden nav không phải authorization).
 *
 * Nguồn quyền duy nhất: `User.adminRole` (spec §8.5) — KHÔNG bao giờ đọc
 * `user.role` (chỉ còn display) hay `isVerifiedSeller` (legacy, chỉ hiển thị)
 * để quyết định quyền.
 *
 * Fail closed trên mọi ô ma trận chưa định nghĩa (Ambiguities A2 — spec §5.4.1
 * các ô Scoped / Exceptional + audited / Limited / Explicit permission):
 * Batch 2 chỉ cấp các cell ✓ rõ ràng; `pii.export` KHÔNG cấp cho ai;
 * moderator/support chỉ được những gì ma trận cho.
 *
 * Step-up (Task 8 THÊM — interface HOÀN CHỈNH từ đầu, verifyAdminMfaCode thật,
 * không placeholder): requireCapabilityWithStepUp + STEP_UP_CAPABILITIES bên
 * dưới — hành động nhạy cảm đòi xác thực lại gần đây (spec §5.4.2) hoặc mã
 * MFA hợp lệ trong cùng request.
 */

export type AdminRole = "super_admin" | "operations_admin" | "moderator" | "support" | "analyst";

export type Capability =
  | "admin.access" // vào khu vực admin (layout)
  | "analytics.read"
  | "beta_cohort.manage"
  | "seller.verify" // review + approve/reject seller verification
  | "seller.verification.revoke"
  | "listing.moderate"
  | "report.resolve" // Batch 3 dùng — định nghĩa sẵn trong matrix
  | "user.suspend" // Batch 3 dùng — định nghĩa sẵn trong matrix
  | "user.view_basic" // trang danh sách người dùng (thông tin hỗ trợ cơ bản)
  | "pii.view_sensitive" // step-up (guard thuộc Task 8)
  | "pii.export" // KHÔNG cấp cho ai trong Batch 2 (fail closed — Ambiguities A2)
  | "session.revoke"
  | "admin.role_manage" // step-up (guard thuộc Task 8)
  | "security.config" // step-up (guard thuộc Task 8) — chưa có surface dùng trong Batch 2
  | "audit.read";

/**
 * Ma trận role → capability — ĐÚNG từng ô plan Task 4 (spec §5.4.1).
 * Ô "Scoped"/"Exceptional + audited"/"Limited"/"Explicit permission" của spec
 * fail closed cho tới khi founder định nghĩa semantics (Ambiguities A2):
 * moderator/support `user.suspend` Scoped → không cấp; moderator/support
 * `pii.view_sensitive` Exceptional → không cấp; moderator analytics Limited →
 * không cấp; super_admin `pii.export` Explicit permission → không cấp.
 */
export const ROLE_CAPABILITIES: Record<AdminRole, readonly Capability[]> = {
  super_admin: [
    "admin.access",
    "analytics.read",
    "beta_cohort.manage",
    "seller.verify",
    "seller.verification.revoke",
    "listing.moderate",
    "report.resolve",
    "user.suspend",
    "user.view_basic",
    "pii.view_sensitive",
    "session.revoke",
    "admin.role_manage",
    "security.config",
    "audit.read",
  ],
  operations_admin: [
    "admin.access",
    "analytics.read",
    "beta_cohort.manage",
    "seller.verify",
    "seller.verification.revoke",
    "listing.moderate",
    "report.resolve",
    "user.suspend",
    "user.view_basic",
    "session.revoke",
  ],
  moderator: ["admin.access", "listing.moderate", "report.resolve"],
  support: ["admin.access"],
  analyst: ["admin.access", "analytics.read"],
};

/**
 * Capability của một role — null/undefined → rỗng (fail closed, spec §8.5).
 *
 * Runtime có thể nhận DB string ngoài union (legacy/typo/enum thêm sau này —
 * TS không mô tả được giá trị DB cũ) → fail closed TƯỜNG MINH: chỉ own
 * property của matrix mới được capability (key lạ kể cả key prototype như
 * "constructor" → rỗng), không để `.includes` trên undefined ném TypeError
 * thay vì deny (review follow-up Task 4).
 */
export function capabilitiesOf(role: AdminRole | null | undefined): readonly Capability[] {
  if (role === null || role === undefined) return [];
  return Object.hasOwn(ROLE_CAPABILITIES, role) ? ROLE_CAPABILITIES[role] : [];
}

/** Context admin sau guard — action/page dùng user.id (audit) + session (step-up Task 8). */
export type AdminContext = { user: SessionUser; session: SessionInfo };

/**
 * Cổng vào /admin — BẤT KỲ adminRole nào (layout + dormant finance pages +
 * các action finance mà ranh giới tài chính đã deny trước đó).
 *
 * Redirect (không throw): chưa đăng nhập → /login; đăng nhập nhưng không có
 * adminRole (kể cả legacy role="admin") → / — đúng hành vi layout cũ, nhưng
 * quyết định đọc adminRole thay vì role (spec §8.5).
 *
 * Review fix #1: adminRole là quyền TIỀM NĂNG của user; `session.isAdmin` là
 * BẰNG CHỨNG session đã qua MFA (login path duy nhất set isAdmin=true —
 * src/lib/session.ts createSession không derive từ adminRole nữa). adminRole
 * set nhưng session consumer (user được promote khi đang giữ session 30 ngày)
 * → coi như NON-ADMIN: redirect / — phải đăng nhập lại qua MFA.
 */
export async function requireAdminUser(): Promise<AdminContext> {
  const current = await getSessionFromCookie();
  if (!current) redirect("/login");
  if (current.user.adminRole == null || !current.session.isAdmin) redirect("/");
  return { user: current.user, session: current.session };
}

/**
 * Đòi capability cụ thể — throw Error("FORBIDDEN") khi thiếu (spec §4.5).
 * Chỉ đọc `user.adminRole` qua ma trận — không bao giờ đọc `user.role`.
 *
 * Review fix #1: CẬP HAI điều kiện — capability qua adminRole VÀ session phải
 * là session MFA (session.isAdmin === true). Thiếu một trong hai → FORBIDDEN.
 */
export async function requireCapability(cap: Capability): Promise<AdminContext> {
  const current = await getSessionFromCookie();
  if (!current) throw new Error("FORBIDDEN");
  if (!current.session.isAdmin) throw new Error("FORBIDDEN"); // session chưa qua MFA
  if (!capabilitiesOf(current.user.adminRole).includes(cap)) {
    throw new Error("FORBIDDEN");
  }
  return { user: current.user, session: current.session };
}

// ─── Step-up (Task 8 — spec §5.4.2) ──────────────────────────────────────────

/**
 * Capability đòi step-up (xác thực lại gần đây) — fail closed:
 * - `pii.view_sensitive`, `admin.role_manage`, `security.config`: spec §5.4.2
 *   "step-up required for at least: PII export; sensitive security
 *   configuration; admin role modification" (PII view cùng nhóm nhạy cảm).
 * - `seller.verify`, `seller.verification.revoke`: Ambiguity A5 — spec §5.4.2
 *   "seller verification decisions where configured" đọc theo hướng NGHIÊM
 *   NHẤT: MỌI quyết định verification thủ công đều cần step-up. Quyết định
 *   có thể đảo ngược bởi founder (bỏ khỏi danh sách này) — không phải mặc
 *   định im lặng.
 * - `user.suspend`: Batch 3 (A9) — spec §5.4.2 "destructive account action":
 *   đình chỉ user chặn platform participation qua actor-side guards (§7.8)
 *   → đòi step-up. LIFT (hướng khôi phục) KHÔNG nằm trong list — recorded
 *   decision (Batch 3 Scope Decisions), reversible by founder ruling.
 * - `pii.export` KHÔNG ở đây vì không được cấp cho ai (A2) — guard sẽ FORBIDDEN
 *   ở requireCapability trước khi đụng step-up.
 */
export const STEP_UP_CAPABILITIES: readonly Capability[] = [
  "pii.view_sensitive",
  "admin.role_manage",
  "security.config",
  "seller.verify",
  "seller.verification.revoke",
  "user.suspend",
];

/**
 * Bucket rate limit cho lần submit mã MFA ở step-up (review fix #2 — spec §7.2):
 * cookie admin bị đánh cắp → brute force 000000-999999 qua surface này. Ba
 * bucket (đều 10 lần / 10 phút, window trượt — không khóa vĩnh viễn):
 * - per-SESSION (stepup:mfa:session:<id>) — đúng session bị đánh cắp;
 * - per-USER (stepup:mfa:user:<id>) — kẻ đổi session token của cùng user;
 * - per-IP (stepup:mfa:ip:<ip>) — kẻ phân tán.
 * Bucket đếm MỌI lần submit mã (kể cả đúng — fail closed) và ĐƯỢC KIỂM TRA
 * TRƯỚC verifyAdminMfaCode: đang limited thì KHÔNG verify — mã đúng cũng bị từ
 * chối (typed MFA_RATE_LIMITED), không còn oracle "đúng thì vào được".
 */
const STEP_UP_MFA_RULE: RateLimitRule = { limit: 10, windowMs: 10 * 60_000 };

/**
 * Kiểm tra cả 3 bucket step-up — trả retryAfterSec khi bị chặn, null khi cho
 * qua. Fail open (limiter lỗi → không chặn).
 *
 * Task 9 review fix #5: EXPORT dùng chung cho admin-identity.ts
 * (stepUpAction / regenerateRecoveryCodesAction) — MỘT nguồn duy nhất cho
 * keys + rule; budget stepup:mfa:* DÙNG CHUNG mọi surface submit mã MFA
 * (guard rbac lẫn form /admin/security), không surface nào là oracle
 * brute-force riêng.
 */
export async function stepUpMfaLimited(userId: string, sessionId: string): Promise<number | null> {
  try {
    const ip = clientIpFromHeaders(await headers());
    const keys = [
      `stepup:mfa:session:${sessionId}`,
      `stepup:mfa:user:${userId}`,
      `stepup:mfa:ip:${ip}`,
    ];
    for (const key of keys) {
      const decision = checkRateLimit(key, STEP_UP_MFA_RULE);
      if (!decision.allowed) return decision.retryAfterSec;
    }
    return null;
  } catch {
    return null; // limiter lỗi → không chặn (fail open, như auth.ts)
  }
}

/** Audit fail-open — audit hỏng không làm hỏng flow chính (spec §4.6/§4.8). */
async function auditMfaEvent(input: {
  actorId: string;
  action: string;
  reason: string;
  sessionId?: string;
  resourceType?: string;
  resourceId?: string;
}): Promise<void> {
  try {
    await auditEvent(input);
  } catch {
    /* fail-open: audit lỗi không chặn hành động chính */
  }
}

/**
 * Đòi capability + step-up cho hành động nhạy cảm (spec §5.4.2). Thứ tự fail
 * closed (đúng interface plan Task 8 + review fix #1/#2):
 *  1. requireCapability(cap) — sai role / session chưa MFA / chưa đăng nhập →
 *     FORBIDDEN (trước khi đụng MFA — không leak thông tin gì).
 *  2. cap ∉ STEP_UP_CAPABILITIES → return ngay (không đòi step-up).
 *  3. stepUpIsFresh(session.steppedUpAt) (≤ 15 phút) → return.
 *  4. KHÔNG totpCode → Error("STEP_UP_REQUIRED") — caller render form mã
 *     (Task 10 review form) rồi submit lại kèm totpCode.
 *  5. CÓ totpCode → rate limit 3 bucket KIỂM TRA TRƯỚC (review fix #2) —
 *     đang limited → Error("MFA_RATE_LIMITED") (KHÔNG verify);
 *     verifyAdminMfaCode(user.id, code):
 *     - hợp lệ → markSessionSteppedUp + audit "admin.step_up" (recovery code
 *       thì audit thêm "admin.mfa_recovery_code_used" — review minor) → return;
 *     - sai → audit "admin.mfa_failed" (fail-open, không mã thô) +
 *       Error("MFA_CODE_INVALID").
 *
 * Lưu ý: context trả về mang steppedUpAt TRƯỚC khi đánh dấu (đối tượng đọc ở
 * đầu guard) — DB đã được markSessionSteppedUp cập nhật; caller cần giá trị
 * tươi thì đọc lại session, không tin đối tượng cũ.
 */
export async function requireCapabilityWithStepUp(
  cap: Capability,
  totpCode?: string,
): Promise<AdminContext> {
  const { user, session } = await requireCapability(cap); // 1. sai role/session → FORBIDDEN

  if (!STEP_UP_CAPABILITIES.includes(cap)) return { user, session }; // 2.
  if (stepUpIsFresh(session.steppedUpAt)) return { user, session }; // 3.

  const code = totpCode?.trim();
  if (!code) throw new Error("STEP_UP_REQUIRED"); // 4. không code → fail closed

  // 5. Rate limit TRƯỚC verify — đang limited thì mã đúng cũng bị từ chối
  const limitedSec = await stepUpMfaLimited(user.id, session.id);
  if (limitedSec !== null) throw new Error("MFA_RATE_LIMITED");

  const factor = await verifyAdminMfaCode(user.id, code);
  if (factor === null) {
    // audit fail-open, KHÔNG chứa mã thô (spec §4.8) — reason typed
    await auditMfaEvent({
      actorId: user.id,
      action: "admin.mfa_failed",
      reason: "step_up_invalid_code",
      sessionId: session.id,
    });
    throw new Error("MFA_CODE_INVALID");
  }

  if (factor === "recovery_code") {
    // mã khôi phục dùng ở step-up cũng được audit như ở login (review minor)
    await auditMfaEvent({
      actorId: user.id,
      action: "admin.mfa_recovery_code_used",
      reason: "step_up_recovery_code",
      sessionId: session.id,
      resourceType: "AdminMfa",
    });
  }

  await markSessionSteppedUp(session.id);
  await auditEvent({
    actorId: user.id,
    action: "admin.step_up",
    resourceType: "UserSession",
    resourceId: session.id,
    sessionId: session.id,
    reason: factor, // "totp" | "recovery_code" — typed reason code
  });
  return { user, session };
}
