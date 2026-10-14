"use server";

import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { SqlQueryError } from "@prisma/orm-family-sql/errors";
import { db } from "@/src/prisma/db.client";
import { hashPassword } from "@/src/lib/auth";
import { revokeAllUserSessionsTx } from "@/src/lib/session";
import { normalizePhone } from "@/src/lib/otp";
import { requireCapabilityWithStepUp, type AdminContext } from "@/src/lib/rbac";
import { auditEventTx } from "@/src/lib/audit-event";
import { checkRateLimit, clientIpFromHeaders } from "@/src/lib/rate-limit";
import {
  MANUAL_RECOVERY_ACTION_RATE,
  MANUAL_RECOVERY_CONSUME_RATE,
  MANUAL_RECOVERY_COOKIE,
  MANUAL_RECOVERY_COOKIE_PATH,
  MANUAL_RECOVERY_REQUEST_TTL_HOURS,
  MANUAL_RECOVERY_RESET_TOKEN_TTL_MINUTES,
  MANUAL_RECOVERY_TOKEN_RE,
  accountRecoveryPhoneHash,
  accountRecoveryResetTokenHash,
} from "@/src/lib/manual-account-recovery";

/**
 * Manual account recovery actions — Task E (founder FD-R3 2026-10-13).
 * Production KHÔNG có OTP provider (FD-R1/FD-2 — /recover tự phục vụ
 * dead-ends) và hand-set passwordHash BỊ CẤM (account-recovery playbook §4);
 * founder duyệt quy trình HAI NGƯỜI này làm đường chuẩn cho đến FD-R1:
 * user liên hệ support qua email → admin A GỌI số phone ĐÃ XÁC MINH của tài
 * khoản → user trả đúng ≥ 2/3 câu hỏi out-of-band (tiêu đề một tin đăng,
 * tỉnh, tháng đăng ký) → admin B (≠ A, ≠ subject) duyệt → reset token MỘT
 * LẦN (30 phút) hiển thị cho admin B gửi out-of-band (phone/Zalo) → user tự
 * đặt mật khẩu mới qua /recover/manual.
 *
 * TWO-PERSON RULE (spec §5.4.2 hướng đọc nghiêm nhất — mirror
 * manual-contact-verification.ts zero-cost Task A):
 *  - admin A (super/ops, account.recover_manual + step-up) mở request sau khi
 *    gọi điện tới số ĐÃ XÁM MINH và xác nhận ≥ 2/3 câu hỏi;
 *  - admin B (≠ A, ≠ subject) approve/reject — KHÔNG BAO GIỜ một admin tự mở
 *    + tự duyệt (SAME_PERSON_FORBIDDEN / SELF_RECOVERY_FORBIDDEN);
 *  - subject KHÔNG BAO GIỜ là admin account (ADMIN_SUBJECT_FORBIDDEN — admin
 *    lockout/MFA-reset thuộc bootstrap runbook, không phải surface này;
 *    kiểm lúc mở request, RE-CHECK trong tx approve, consume CAS
 *    adminRole IS NULL — review zc-efix #3);
 *  - subject KHÔNG BAO GIỜ là chính admin mở request (SELF_RECOVERY_FORBIDDEN).
 *
 * Audit action registry (disjoint mọi batch trước — spec §4.6):
 *   account.manual_recovery_requested / account.manual_recovery_approved /
 *   account.manual_recovery_rejected / account.manual_recovery_cancelled /
 *   account.manual_recovery_consumed — auditEventTx TRONG cùng tx với write
 *   (sống chết cùng nhau); detail chỉ ids/checks-count — KHÔNG phone thô,
 *   KHÔNG câu trả lời, KHÔNG token thô (spec §4.8).
 *
 * Transaction constraint-violation rule (Global Constraints — Batch 3/6/7):
 * violation (23505) LUÔN throw ra khỏi callback (Postgres abort tx); classify
 * NGOÀI tx theo SqlQueryError + sqlState + constraint PREFIX (tên index render
 * kèm hash suffix); CAS mọi write phụ thuộc giá trị đã đọc (updateAll where);
 * re-read guarded row INSIDE tx; rethrow mọi lỗi khác (fail closed).
 *
 * Expired KHÔNG cron: row requested quá expiresAt bị CAS chặn (expiresAt.gt
 * now) → EXPIRED typed error; row approved-unconsumed có token quá
 * resetTokenExpiresAt bị consume CAS chặn; request MỚI flip CẢ HAI dạng row
 * quá hạn sang 'expired' trong tx của mình (partial unique
 * account_recovery_one_open nếu không sẽ chặn vĩnh viên user sau lần đầu
 * hết hạn).
 *
 * Rate limit (§7.1): MỘT bucket per ADMIN dùng chung bốn action admin
 * (manual-account-recovery:<adminId>) — PROVISIONAL (P5 precedent
 * MANUAL_CONTACT_ACTION_RATE). Consume (public): per IP + per token (bucket
 * keyed bằng HMAC hash — limiter không giữ token thô). Fail open (limiter
 * lỗi → không chặn — cùng posture auth.ts).
 *
 * Step-up: account.recover_manual ∈ STEP_UP_CAPABILITIES (đặt lại mật khẩu
 * user là destructive account action nhạy cảm nhất — cùng nhóm user.suspend
 * A9 + contact.verify_manual A5). Lỗi typed operator sửa được
 * (STEP_UP_REQUIRED / MFA_CODE_INVALID / MFA_RATE_LIMITED) → form state;
 * FORBIDDEN (sai role / session chưa MFA) vẫn ném — guard fail phạt âm
 * (pattern admin-identity.ts).
 *
 * Reset token (approve): randomBytes(32).base64url — 256-bit unguessable;
 * DB lưu CHỈ HMAC keyed (hkdf label RIÊNG "account-recovery-reset-token" —
 * pattern BetaInviteToken.tokenHash Batch 7). URL reset hiển thị cho admin
 * B MỘT LẦN trong state trả về (same once-only pattern inviteUrl Batch 7 —
 * corrections #36: NEXT_PUBLIC_APP_URL check TRƯỚC tx) — KHÔNG bao giờ vào
 * db (chỉ tokenHash)/audit/telemetry/log. Approve thu hồi MỘI session của
 * subject TRONG cùng tx (containment — kẻ chiếm session cũ mất tác quyền
 * NGAY, trước cả khi user đặt được mật khẩu mới); consume thu hồi LẠI trong
 * cùng tx với password write (review zc-efix #2 — session MỚI login bằng
 * mật khẩu cũ trong cửa sổ 30 phút sống sót approve-time revocation, chết
 * theo consume; pattern self-service recovery.ts).
 */

export type ManualRecoveryFormState = {
  /** Mã lỗi ổn định cho test/client (map sang tiếng Việt ở client) — không prose tự chế. */
  error?: string;
  success?: string;
  /**
   * URL reset MỘT LẦN sau approve (admin B copy gửi out-of-band — phone/Zalo).
   * Token thô — KHÔNG bao giờ lưu/log/audit; mất link → chờ hết hạn 30 phút
   * rồi mở request mới.
   */
  resetUrl?: string;
};

// ─── Validation schemas ──────────────────────────────────────────────────────

const decisionSchema = z.enum(["approve", "reject"], {
  error: () => "INVALID_INPUT",
});

/** Mật khẩu mới — CÙNG chính sách self-service recovery (recovery.ts). */
const newPasswordSchema = z.string()
  .min(6, "Mật khẩu tối thiểu 6 ký tự")
  .max(100, "Mật khẩu tối đa 100 ký tự");

// ─── Step-up error mapping (pattern manual-contact-verification.ts) ─────────

/** Lỗi typed operator SỬA ĐƯỢC (nhập mã rồi gửi lại) — FORBIDDEN vẫn ném. */
const STEP_UP_STATE = new Set(["STEP_UP_REQUIRED", "MFA_CODE_INVALID", "MFA_RATE_LIMITED"]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** TOTP từ formData — rỗng → undefined (không đòi mã khi step-up còn tươi). */
const totpFromForm = (formData: FormData): string | undefined =>
  String(formData.get("totpCode") ?? "").trim() || undefined;

/** Checkbox formData → boolean (client tick "on"; thiếu/false → false). */
const checked = (formData: FormData, name: string): boolean => {
  const raw = formData.get(name);
  return raw === "on" || raw === "true";
};

/**
 * Thông báo collapsed của consume — identifier không khớp, token sai/hết hạn/
 * dùng lại/không có cookie → CÙNG chuỗi (spec §7.7 — consume không thành
 * oracle phân biệt "token đúng nhưng hết hạn" vs "token rác").
 */
const RECOVERY_LINK_INVALID_MESSAGE =
  "Liên kết không còn hiệu lực — đã hết hạn, đã được sử dụng hoặc không tồn tại. Liên hệ hỗ trợ để nhận liên kết mới.";

// ─── Token lookup (dùng chung route handler + page + consume) ────────────────

/**
 * Row AccountRecoveryRequest scalars cho một reset token hợp lệ — KHÔNG side
 * effect nào (không consume/log/audit): route handler landing dùng để quyết
 * định set cookie (bots unfurl GET link — corrections #7 precedent), page
 * dùng để render form, consume action tự CAS trong tx (read này KHÔNG phải
 * claim authoritative).
 *
 * Shape check TRƯỚC mọi db call (corrections #12 precedent) — garbage không
 * tốn một query nào. Mọi lý do fail đều như nhau ở phía caller
 * (enumeration-safe): null.
 */
export async function findValidManualRecoveryToken(
  token: string,
): Promise<{ id: string; userId: string; resetTokenExpiresAt: string } | null> {
  if (!MANUAL_RECOVERY_TOKEN_RE.test(token)) return null; // garbage — zero db call
  const tokenHash = accountRecoveryResetTokenHash(token);
  // resetTokenHash là cột NULLABLE (chỉ set lúc approve) — shorthand filter
  // `{ tokenHash }` không hỗ trợ equality trên nullable field; dùng callback
  // .eq() tường minh (pattern Batch 7 BetaInviteToken.tokenHash là NOT NULL
  // nên shorthand được ở đó — cột này KHÔNG).
  const row = await db.orm.public.AccountRecoveryRequest
    .where((r) => r.resetTokenHash.eq(tokenHash))
    .first();
  if (row === null) return null;
  // approved-unconsumed-còn-hạn MỚI hợp lệ — mọi lý do khác collapse về null
  if (row.status !== "approved") return null;
  if (row.consumedAt !== null) return null; // single-use — đã burn
  if (row.resetTokenExpiresAt === null) return null; // belt-and-suspenders
  if (Date.parse(row.resetTokenExpiresAt) <= Date.now()) return null;
  return { id: row.id, userId: row.userId, resetTokenExpiresAt: row.resetTokenExpiresAt };
}

// ─── 1. Admin A mở request ───────────────────────────────────────────────────

/**
 * Mở request khôi phục (admin A): sau khi GỌI số phone ĐÃ XÁM MINH của chủ
 * tài khoản và user trả đúng ≥ 2/3 câu hỏi. Operator TICK câu đúng (boolean
 * từng câu — KHÔNG BAO GIỜ nhập câu trả lời) + attestation đã gọi đúng số
 * đã xác minh. Lưu snapshot phoneVerifiedAt + HMAC phone (label RIÊNG —
 * KHÔNG giá trị thô), TTL 24h, partial unique account_recovery_one_open là
 * ranh giới cuối chống double-request (pre-check application-level chỉ là
 * convenience).
 */
export async function requestManualAccountRecoveryAction(
  _prev: ManualRecoveryFormState,
  formData: FormData,
): Promise<ManualRecoveryFormState> {
  // Guard + step-up — lỗi typed operator sửa được → state; FORBIDDEN ném.
  let ctx: AdminContext;
  try {
    ctx = await requireCapabilityWithStepUp("account.recover_manual", totpFromForm(formData));
  } catch (e) {
    const key = e instanceof Error ? e.message : String(e);
    if (STEP_UP_STATE.has(key)) return { error: key };
    throw e;
  }
  // Rate limit per admin (§7.1) — fail open (checkRateLimit tự catch lỗi limiter).
  const limited = checkRateLimit(
    `manual-account-recovery:${ctx.user.id}`,
    MANUAL_RECOVERY_ACTION_RATE,
  );
  if (!limited.allowed) return { error: "RATE_LIMITED" };

  const userId = String(formData.get("userId") ?? "").trim();
  if (!userId) return { error: "INVALID_INPUT" };

  // Checks out-of-band — operator tick câu ĐÚNG (boolean, không câu trả lời).
  // Form field name = `check_${check}` (check ∈ MANUAL_RECOVERY_CHECKS — client
  // render checkbox từ CHÍNH vocab constant đó) — action đọc ĐÚNG tên này cho
  // từng câu (lock bằng unit test — name mismatch hai bên là bug im lặng).
  const checkListingTitle = checked(formData, "check_listing_title");
  const checkProvince = checked(formData, "check_province");
  const checkRegistrationMonth = checked(formData, "check_registration_month");
  const checksPassed = [checkListingTitle, checkProvince, checkRegistrationMonth]
    .filter(Boolean).length;
  // Founder FD-R3 2026-10-13: ≥ 2/3 câu đúng — dưới 2 là từ chối MỞ request.
  if (checksPassed < 2) return { error: "CHECKS_INSUFFICIENT" };
  // Attestation bắt buộc: operator khẳng định ĐÃ GỌI đúng số ĐÃ XÁM MINH của
  // tài khoản (checkbox — không phải free text).
  if (!checked(formData, "attestedCall")) return { error: "ATTESTATION_REQUIRED" };

  // Two-person rule (leg 1): subject ≠ chính mình — tự mở khôi phục cho mình
  // là đường leo thang đặc quyền (SELF_GRANT_FORBIDDEN precedent Batch 2).
  if (userId === ctx.user.id) return { error: "SELF_RECOVERY_FORBIDDEN" };

  // Subject FRESH — cuộc gọi PHẢI tới số ĐÃ XÁM MINH (phoneVerifiedAt != null):
  // số chưa xác minh là vector chiếm tài khoản (SIM tái sử dụng — spec §5.3.1,
  // cùng hợp đồng findUserByVerifiedIdentifier của recovery.ts). Refuse kèm
  // typed error nói rõ procedure KHÔNG dùng được cho tài khoản này.
  const subject = await db.orm.public.User.first({ id: userId });
  if (subject === null) return { error: "USER_NOT_FOUND" };
  if (subject.phone === null || subject.phoneVerifiedAt === null) {
    return { error: "PHONE_NOT_VERIFIED" };
  }
  // Subject KHÔNG BAO GIỜ là admin account — admin lockout/MFA-reset thuộc
  // bootstrap runbook (§2/§3, two-person psql), KHÔNG phải surface này: khôi
  // phục admin qua đây = đường chiếm quyền admin không qua MFA reset.
  if (subject.adminRole !== null) return { error: "ADMIN_SUBJECT_FORBIDDEN" };

  // Snapshot + HMAC của phone CHUẨN HÓA (derive từ DB — formData bị bỏ qua,
  // cùng nguyên tắc manual-contact-verification.ts). Số rác/legacy không
  // chuẩn hóa được → procedure không dùng được (typed error, KHÔNG log thô).
  let normalizedPhone: string;
  try {
    normalizedPhone = normalizePhone(subject.phone);
  } catch {
    return { error: "PHONE_NOT_VERIFIED" };
  }
  const phoneHash = accountRecoveryPhoneHash(normalizedPhone);
  const phoneVerifiedAtSnapshot = subject.phoneVerifiedAt;

  const nowIso = new Date().toISOString();
  const expiresAt = new Date(
    Date.now() + MANUAL_RECOVERY_REQUEST_TTL_HOURS * 3_600_000,
  ).toISOString();

  // Pre-check open request (convenience — partial unique là ranh giới cuối).
  // Row requested QUÁ HẠN không tính (expired-on-read, no cron) — request mới
  // được mở lại sau khi tx bên dưới flip nó sang 'expired'. Row
  // approved-unconsumed còn token sống CŨNG chiếm slot (một link reset sống
  // tối đa per user).
  const openRequested = await db.orm.public.AccountRecoveryRequest
    .where({ userId })
    .where((r) => r.status.eq("requested"))
    .where((r) => r.expiresAt.gt(nowIso))
    .first();
  const openApproved = await db.orm.public.AccountRecoveryRequest
    .where({ userId })
    .where((r) => r.status.eq("approved"))
    .where((r) => r.consumedAt.isNull())
    .where((r) => r.resetTokenExpiresAt.gt(nowIso))
    .first();
  if (openRequested !== null || openApproved !== null) return { error: "OPEN_REQUEST_EXISTS" };

  try {
    await db.transaction(async (tx) => {
      // Hết hạn trên read (no cron): row requested quá expiresAt + row
      // approved-unconsumed có token quá resetTokenExpiresAt chuyển thành
      // 'expired' TRƯỚC khi tạo row mới — không thì partial unique
      // account_recovery_one_open chặn VĨNH VIÊN user này sau lần đầu hết hạn.
      // Row được GIỮ làm audit trail (không delete).
      await tx.orm.public.AccountRecoveryRequest
        .where({ userId })
        .where((r) => r.status.eq("requested"))
        .where((r) => r.expiresAt.lte(nowIso))
        .updateAll({ status: "expired" });
      await tx.orm.public.AccountRecoveryRequest
        .where({ userId })
        .where((r) => r.status.eq("approved"))
        .where((r) => r.consumedAt.isNull())
        .where((r) => r.resetTokenExpiresAt.lte(nowIso))
        .updateAll({ status: "expired" });
      const row = await tx.orm.public.AccountRecoveryRequest.create({
        userId,
        checksPassed,
        checkListingTitle,
        checkProvince,
        checkRegistrationMonth,
        phoneVerifiedAtSnapshot,
        phoneHash,
        status: "requested",
        requestedById: ctx.user.id,
        requestedAt: nowIso,
        expiresAt,
      });
      // Audit sống chết cùng tx — detail checks-count ONLY (§4.8: KHÔNG phone
      // thô, KHÔNG câu trả lời — booleans đã ở row, KHÔNG nhân bản vào audit).
      await auditEventTx(tx, {
        actorId: ctx.user.id,
        subjectId: userId,
        action: "account.manual_recovery_requested",
        resourceType: "AccountRecoveryRequest",
        resourceId: row.id,
        sessionId: ctx.session.id,
        detail: `checks=${checksPassed}`,
      });
    });
  } catch (e) {
    // Classify NGOÀI tx (Global Constraints): concurrent double-request đâm
    // partial unique account_recovery_one_open_<hash> → tx abort (KHÔNG
    // silent success) → typed error.
    if (
      SqlQueryError.is(e) &&
      e.sqlState === "23505" &&
      e.constraint != null &&
      e.constraint.startsWith("account_recovery_one_open")
    ) {
      return { error: "OPEN_REQUEST_EXISTS" };
    }
    throw e; // fail closed — KHÔNG masquerade lỗi infra thành form error
  }

  revalidatePath("/admin/users");
  return { success: "Đã mở yêu cầu khôi phục — chờ admin khác duyệt." };
}

// ─── 2. Admin B quyết định (approve | reject) ─────────────────────────────────

/**
 * Admin B (≠ A, ≠ subject) quyết định request.
 *
 * Approve:
 *  - CAS status=requested AND expiresAt > now → 0 row = quyết định song song
 *    (ALREADY_DECIDED) hoặc quá hạn (EXPIRED — no cron, tính lúc đọc);
 *  - so lại phoneHash + phoneVerifiedAtSnapshot với giá trị HIỆN TẠI đọc
 *    TRONG tx (INSIDE): đổi giữa request/decide → CONTACT_CHANGED (tx abort —
 *    quyết định không gắn với số chưa từng được out-of-band);
 *  - RE-CHECK adminRole TRONG tx (review zc-efix #3): subject được promote
 *    admin SAU request → ADMIN_SUBJECT_FORBIDDEN (tx abort — KHÔNG issue
 *    token cho admin account; admin recovery thuộc bootstrap runbook);
 *  - sinh reset token MỘT LẦN (randomBytes(32) base64url), lưu CHỈ HMAC +
 *    resetTokenExpiresAt = approval + 30 phút;
 *  - thu hồi MỌI session của subject TRONG cùng tx (containment — kẻ đang
 *    giữ session cũ mất tác quyền NGAY; user tự đăng nhập lại bằng mật khẩu
 *    mới sau consume);
 *  - audit trong cùng tx; URL reset thô trả về MỘT LẦN trong state.resetUrl
 *    (admin B gửi out-of-band — phone/Zalo) — KHÔNG bao giờ db/audit/log.
 *
 * Reject: CAS như trên → status=rejected, KHÔNG issue token.
 */
export async function decideManualAccountRecoveryAction(
  _prev: ManualRecoveryFormState,
  formData: FormData,
): Promise<ManualRecoveryFormState> {
  // Guard + step-up — lỗi typed operator sửa được → state; FORBIDDEN ném.
  let ctx: AdminContext;
  try {
    ctx = await requireCapabilityWithStepUp("account.recover_manual", totpFromForm(formData));
  } catch (e) {
    const key = e instanceof Error ? e.message : String(e);
    if (STEP_UP_STATE.has(key)) return { error: key };
    throw e;
  }
  const limited = checkRateLimit(
    `manual-account-recovery:${ctx.user.id}`,
    MANUAL_RECOVERY_ACTION_RATE,
  );
  if (!limited.allowed) return { error: "RATE_LIMITED" };

  const requestId = String(formData.get("requestId") ?? "").trim();
  const decisionParsed = decisionSchema.safeParse(String(formData.get("decision") ?? ""));
  if (!requestId || !decisionParsed.success) return { error: "INVALID_INPUT" };
  const decision = decisionParsed.data;

  // corrections #36 precedent — check TRƯỚC mọi tx: không URL thì không issue
  // token (approve cần render URL cho admin B).
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (decision === "approve" && !appUrl) return { error: "APP_URL_UNCONFIGURED" };

  // Pre-read (ngoài tx) — two-person rule fail TRƯỚC khi đụng tx:
  // B === requester → tự duyệt request mình mở; B === subject → tự duyệt
  // khôi phục cho chính mình. Cả hai đều đường leo thang đặc quyền.
  const row = await db.orm.public.AccountRecoveryRequest.first({ id: requestId });
  if (row === null) return { error: "NOT_FOUND" };
  if (row.userId === ctx.user.id) return { error: "SELF_RECOVERY_FORBIDDEN" };
  if (row.requestedById === ctx.user.id) return { error: "SAME_PERSON_FORBIDDEN" };

  const nowIso = new Date().toISOString();

  // Token sinh NGOÀI tx (không giữ tx cho CSPRNG) — CHỈ hash vào tx.
  const token = randomBytes(32).toString("base64url");
  const resetTokenHash = accountRecoveryResetTokenHash(token);
  const resetTokenExpiresAt = new Date(
    Date.now() + MANUAL_RECOVERY_RESET_TOKEN_TTL_MINUTES * 60_000,
  ).toISOString();

  try {
    await db.transaction(async (tx) => {
      // (a) RE-READ INSIDE tx — không tin row đọc trước tx (Global Constraints).
      const fresh = await tx.orm.public.AccountRecoveryRequest.first({ id: requestId });
      if (fresh === null) throw new Error("NOT_FOUND");
      if (fresh.userId === ctx.user.id) throw new Error("SELF_RECOVERY_FORBIDDEN");
      if (fresh.requestedById === ctx.user.id) throw new Error("SAME_PERSON_FORBIDDEN");

      // (b) CAS — status=requested AND chưa hết hạn; 0 row = quyết định song
      // song (ALREADY_DECIDED) hoặc quá hạn (EXPIRED — no cron, tính lúc này).
      const claimed = await tx.orm.public.AccountRecoveryRequest
        .where({ id: requestId })
        .where((r) => r.status.eq("requested"))
        .where((r) => r.expiresAt.gt(nowIso))
        .updateAll({
          status: decision === "approve" ? "approved" : "rejected",
          decidedById: ctx.user.id,
          decidedAt: nowIso,
          ...(decision === "approve" ? { resetTokenHash, resetTokenExpiresAt } : {}),
        });
      if (claimed.length === 0) {
        if (fresh.status !== "requested") throw new Error("ALREADY_DECIDED");
        throw new Error("EXPIRED");
      }

      // (c) Approve — recompute hash của phone HIỆN TẠI (INSIDE tx) + so
      // phoneVerifiedAtSnapshot: đổi giữa request/decide → CONTACT_CHANGED
      // (tx abort — quyết định không gắn với số chưa từng được out-of-band).
      if (decision === "approve") {
        const subject = await tx.orm.public.User.first({ id: fresh.userId });
        if (subject === null) throw new Error("NOT_FOUND");
        // RE-CHECK adminRole INSIDE tx (review zc-efix #3): request-side chặn
        // lúc mở, nhưng subject có thể được promote adminRole SAU request
        // (setAdminRoleAction CAS) trong cửa sổ 24h — quyết định phải chết ở
        // đây: KHÔNG issue token cho admin account (admin lockout/MFA-reset
        // thuộc bootstrap runbook, KHÔNG phải surface này).
        if (subject.adminRole !== null) throw new Error("ADMIN_SUBJECT_FORBIDDEN");
        if (subject.phone === null || subject.phoneVerifiedAt === null) {
          // số đã bị mất/xác minh bị gỡ giữa request/decide — giá trị đã đổi
          throw new Error("CONTACT_CHANGED");
        }
        let currentPhone: string;
        try {
          currentPhone = normalizePhone(subject.phone);
        } catch {
          // số rác/legacy xuất hiện SAU request — giá trị đã đổi hình dạng
          throw new Error("CONTACT_CHANGED");
        }
        if (
          accountRecoveryPhoneHash(currentPhone) !== fresh.phoneHash ||
          subject.phoneVerifiedAt !== fresh.phoneVerifiedAtSnapshot
        ) {
          throw new Error("CONTACT_CHANGED");
        }
        // Thu hồi MỌI session của subject TRONG cùng tx (containment —
        // KHÔNG exceptSessionId: admin B không phải subject, session của
        // subject chết hết; kẻ đang giữ session cũ mất tác quyền NGAY).
        await revokeAllUserSessionsTx(tx, fresh.userId, "manual_account_recovery");
      }

      // (d) Audit sống chết cùng tx — ids/decision/checks ONLY (§4.8 — KHÔNG
      // phone thô, KHÔNG token thô, KHÔNG câu trả lời).
      await auditEventTx(tx, {
        actorId: ctx.user.id,
        subjectId: fresh.userId,
        action:
          decision === "approve"
            ? "account.manual_recovery_approved"
            : "account.manual_recovery_rejected",
        resourceType: "AccountRecoveryRequest",
        resourceId: fresh.id,
        sessionId: ctx.session.id,
        detail: `decision=${decision} checks=${fresh.checksPassed}`,
      });
    });
  } catch (e) {
    // Classify sentinels NGOÀI tx — KHÔNG bao giờ trong callback (Postgres
    // abort tx khi violation; catch trong callback = silent-success bug).
    if (e instanceof Error) {
      switch (e.message) {
        case "NOT_FOUND":
          return { error: "NOT_FOUND" };
        case "SELF_RECOVERY_FORBIDDEN":
          return { error: "SELF_RECOVERY_FORBIDDEN" };
        case "SAME_PERSON_FORBIDDEN":
          return { error: "SAME_PERSON_FORBIDDEN" };
        case "ALREADY_DECIDED":
          return { error: "ALREADY_DECIDED" };
        case "EXPIRED":
          return { error: "EXPIRED" };
        case "CONTACT_CHANGED":
          return { error: "CONTACT_CHANGED" };
        case "ADMIN_SUBJECT_FORBIDDEN":
          // subject promote admin SAU request — re-check trong tx chặn
          // (review zc-efix #3); map ở ĐÂY (ngoài tx), KHÔNG trong callback.
          return { error: "ADMIN_SUBJECT_FORBIDDEN" };
      }
    }
    throw e; // fail closed — KHÔNG map mù lỗi infra thành form error
  }

  revalidatePath("/admin/users");
  if (decision === "reject") {
    return { success: "Đã từ chối yêu cầu khôi phục." };
  }
  // URL reset TUYỆT ĐỐI — token thô hiển thị MỘT LẦN trong state này (admin B
  // copy gửi out-of-band — phone/Zalo); mất link → chờ hết hạn 30 phút rồi
  // mở request mới. KHÔNG vào db (chỉ tokenHash)/audit/telemetry/log.
  return {
    success: "Đã duyệt khôi phục — gửi link dưới đây cho người dùng qua kênh riêng (điện thoại/Zalo). Link chỉ hiện MỘT lần và hết hạn sau 30 phút.",
    resetUrl: `${appUrl}/recover/manual/${token}`,
  };
}

// ─── 3. Requester tự hủy (optional) ───────────────────────────────────────────

/**
 * Admin A (người mở) hủy request của chính mình TRƯỚC khi có quyết định —
 * gọi nhầm người thì không phải chờ hết hạn. KHÔNG phải admin B hủy giùm
 * (NOT_REQUESTER — quyết định của B là approve/reject, không phải xóa
 * request của người khác). CAS status=requested AND expiresAt > now.
 */
export async function cancelManualAccountRecoveryAction(
  _prev: ManualRecoveryFormState,
  formData: FormData,
): Promise<ManualRecoveryFormState> {
  // Guard + step-up — lỗi typed operator sửa được → state; FORBIDDEN ném.
  let ctx: AdminContext;
  try {
    ctx = await requireCapabilityWithStepUp("account.recover_manual", totpFromForm(formData));
  } catch (e) {
    const key = e instanceof Error ? e.message : String(e);
    if (STEP_UP_STATE.has(key)) return { error: key };
    throw e;
  }
  const limited = checkRateLimit(
    `manual-account-recovery:${ctx.user.id}`,
    MANUAL_RECOVERY_ACTION_RATE,
  );
  if (!limited.allowed) return { error: "RATE_LIMITED" };

  const requestId = String(formData.get("requestId") ?? "").trim();
  if (!requestId) return { error: "INVALID_INPUT" };

  const row = await db.orm.public.AccountRecoveryRequest.first({ id: requestId });
  if (row === null) return { error: "NOT_FOUND" };
  if (row.requestedById !== ctx.user.id) return { error: "NOT_REQUESTER" };

  const nowIso = new Date().toISOString();

  try {
    await db.transaction(async (tx) => {
      // RE-READ INSIDE tx — không tin row đọc trước tx.
      const fresh = await tx.orm.public.AccountRecoveryRequest.first({ id: requestId });
      if (fresh === null) throw new Error("NOT_FOUND");
      if (fresh.requestedById !== ctx.user.id) throw new Error("NOT_REQUESTER");

      // CAS — status=requested AND chưa hết hạn; 0 row = đã quyết định
      // (ALREADY_DECIDED) hoặc quá hạn (EXPIRED). Row approved KHÔNG hủy
      // được (token đã issue — chỉ chờ consume hoặc hết hạn 30 phút).
      const moved = await tx.orm.public.AccountRecoveryRequest
        .where({ id: requestId })
        .where((r) => r.status.eq("requested"))
        .where((r) => r.expiresAt.gt(nowIso))
        .updateAll({ status: "cancelled" });
      if (moved.length === 0) {
        if (fresh.status !== "requested") throw new Error("ALREADY_DECIDED");
        throw new Error("EXPIRED");
      }

      // Audit sống chết cùng tx — ids/checks ONLY (§4.8).
      await auditEventTx(tx, {
        actorId: ctx.user.id,
        subjectId: fresh.userId,
        action: "account.manual_recovery_cancelled",
        resourceType: "AccountRecoveryRequest",
        resourceId: fresh.id,
        sessionId: ctx.session.id,
        detail: `checks=${fresh.checksPassed}`,
      });
    });
  } catch (e) {
    if (e instanceof Error) {
      switch (e.message) {
        case "NOT_FOUND":
          return { error: "NOT_FOUND" };
        case "NOT_REQUESTER":
          return { error: "NOT_REQUESTER" };
        case "ALREADY_DECIDED":
          return { error: "ALREADY_DECIDED" };
        case "EXPIRED":
          return { error: "EXPIRED" };
      }
    }
    throw e; // fail closed
  }

  revalidatePath("/admin/users");
  return { success: "Đã hủy yêu cầu khôi phục." };
}

// ─── 4. User consume link (public — KHÔNG capability) ─────────────────────────

/**
 * User đặt mật khẩu mới qua link reset (public action — token sống trong
 * cookie HttpOnly sp_manual_recovery do route handler /recover/manual/[token]
 * set; KHÔNG bao giờ trong next/query/form). Mật khẩu mới CÙNG chính sách
 * self-service recovery (recovery.ts: 6..100).
 *
 * Consume là MỘT CAS duy nhất: status=approved AND consumedAt IS NULL AND
 * resetTokenExpiresAt > now → status=consumed + consumedAt. 0 row = đã dùng
 * lại / hết hạn / token rác → CÙNG lỗi collapsed (spec §7.7 — consume không
 * thành oracle). Mật khẩu mới ghi trong CÙNG tx với claim (hashPassword
 * NGOÀI tx — bcrypt chậm, không giữ tx) — password write CAS adminRole IS
 * NULL (review zc-efix #3: subject promote admin giữa approve/consume →
 * 0 row → LINK_INVALID, claim rollback — KHÔNG bao giờ đụng mật khẩu admin
 * account qua surface này). Session của subject bị thu hồi LẠI trong CÙNG
 * tx với password write (review zc-efix #2 — pattern self-service
 * recovery.ts): thu hồi lúc approve KHÔNG chặn session MỚI — attacker biết
 * mật khẩu cũ login lại trong cửa sổ 30 phút thì session đó chết THEO
 * consume, không sống sót qua reset (idempotent với session đã revoke ở
 * approve).
 *
 * Rate limit: per IP (mirror RECOVERY_CONFIRM_RULE) + per token (bucket keyed
 * bằng HMAC hash — limiter KHÔNG giữ token thô, spec §4.8). Fail open.
 */
export async function consumeManualAccountRecoveryAction(
  _prev: ManualRecoveryFormState,
  formData: FormData,
): Promise<ManualRecoveryFormState> {
  // 1) Token từ cookie HttpOnly (KHÔNG từ formData — token không bao giờ rides
  //    trong form/next/query; route handler đã shape-check khi set).
  const token = (await cookies()).get(MANUAL_RECOVERY_COOKIE)?.value ?? null;
  if (token === null) return { error: RECOVERY_LINK_INVALID_MESSAGE };

  // 2) Rate limit per IP (§7.1) — fail open.
  try {
    const ip = clientIpFromHeaders(await headers());
    const ipDecision = checkRateLimit(`manual-recovery:consume:${ip}`, MANUAL_RECOVERY_CONSUME_RATE);
    if (!ipDecision.allowed) {
      return { error: `Quá nhiều lần thử — chờ ${ipDecision.retryAfterSec} giây rồi thử lại.` };
    }
    // 3) Per token — bucket keyed bằng HMAC hash (limiter không giữ token thô,
    //    spec §4.8). Trả CÙNG lỗi collapsed: kẻ dò không phân biệt "token bị
    //    khóa" vs "token sai".
    const tokenDecision = checkRateLimit(
      `manual-recovery:consume-token:${accountRecoveryResetTokenHash(token)}`,
      MANUAL_RECOVERY_CONSUME_RATE,
    );
    if (!tokenDecision.allowed) return { error: RECOVERY_LINK_INVALID_MESSAGE };
  } catch {
    /* limiter lỗi → không chặn (fail open, như auth.ts) */
  }

  // 4) Validate mật khẩu mới (sau bucket — mọi attempt đều phải đếm).
  const parsed = newPasswordSchema.safeParse(String(formData.get("newPassword") ?? ""));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  }
  const newPassword = parsed.data;

  // 5) Lookup token (shape check bên trong helper — garbage không tốn query).
  const valid = await findValidManualRecoveryToken(token);
  if (valid === null) return { error: RECOVERY_LINK_INVALID_MESSAGE };

  // 6) hashPassword NGOÀI tx (bcrypt chậm — không giữ tx), CAS + ghi mật khẩu
  //    + audit trong CÙNG tx (sống chết cùng nhau — hai statement rời để lại
  //    row consumed mà mật khẩu chưa đổi, hoặc mật khẩu đổi mà token còn dùng
  //    lại được).
  const passwordHash = await hashPassword(newPassword);
  const nowIso = new Date().toISOString();
  try {
    await db.transaction(async (tx) => {
      // CAS — approved + chưa consume + còn hạn; 0 row = dùng lại song song
      // (consume đồng thời) hoặc token vừa hết hạn giữa read và claim.
      const claimed = await tx.orm.public.AccountRecoveryRequest
        .where({ id: valid.id })
        .where((r) => r.status.eq("approved"))
        .where((r) => r.consumedAt.isNull())
        .where((r) => r.resetTokenExpiresAt.gt(nowIso))
        .updateAll({ status: "consumed", consumedAt: nowIso });
      if (claimed.length === 0) throw new Error("LINK_INVALID");

      // Password write CAS adminRole IS NULL (review zc-efix #3): subject
      // được promote admin SAU approve → 0 row → LINK_INVALID (claim rollback
      // — KHÔNG bao giờ đụng mật khẩu admin account qua surface này; admin
      // recovery thuộc bootstrap runbook).
      const updated = await tx.orm.public.User
        .where({ id: valid.userId })
        .where((u) => u.adminRole.isNull())
        .updateAll({ passwordHash });
      if (updated.length === 0) throw new Error("LINK_INVALID");

      // Thu hồi MỌI session TRONG cùng tx với password write (review zc-efix
      // #2 — pattern self-service recovery.ts): thu hồi lúc approve KHÔNG
      // chặn session MỚI — attacker biết mật khẩu cũ login lại trong cửa sổ
      // 30 phút thì session đó chết THEO consume, không sống sót qua reset
      // (idempotent với session đã revoke ở approve; KHÔNG exceptSessionId —
      // consume là public, user không giữ session nào).
      await revokeAllUserSessionsTx(tx, valid.userId, "manual_account_recovery");

      // Audit sống chết cùng tx — ids ONLY (§4.8 — KHÔNG token thô, KHÔNG PII).
      await auditEventTx(tx, {
        actorId: valid.userId,
        subjectId: valid.userId,
        action: "account.manual_recovery_consumed",
        resourceType: "AccountRecoveryRequest",
        resourceId: valid.id,
        reason: "manual_two_person_link",
      });
    });
  } catch (e) {
    if (e instanceof Error && e.message === "LINK_INVALID") {
      return { error: RECOVERY_LINK_INVALID_MESSAGE };
    }
    throw e; // fail closed
  }

  // 7) Xóa cookie (path-scoped — corrections #35 precedent: delete mặc định
  //    Path=/ là MỘT cookie khác, không đụng được cookie path hẹp) — token
  //    đã consume, belt-and-suspenders chống retry từ cùng cookie.
  try {
    (await cookies()).delete({ name: MANUAL_RECOVERY_COOKIE, path: MANUAL_RECOVERY_COOKIE_PATH });
  } catch {
    /* best effort — cookie đã consume, CAS chặn dùng lại */
  }

  return {
    success:
      "Đặt lại mật khẩu thành công. Mọi phiên đăng nhập trước đó đã được thu hồi — vui lòng đăng nhập bằng mật khẩu mới.",
  };
}
