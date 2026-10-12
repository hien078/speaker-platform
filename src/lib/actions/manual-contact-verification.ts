"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { SqlQueryError } from "@prisma/orm-family-sql/errors";
import { db } from "@/src/prisma/db.client";
import { requireCapabilityWithStepUp, type AdminContext } from "@/src/lib/rbac";
import { normalizeEmail, normalizePhone } from "@/src/lib/otp";
import { auditEventTx, redactDetail } from "@/src/lib/audit-event";
import { checkRateLimit } from "@/src/lib/rate-limit";
import {
  MANUAL_CONTACT_ACTION_RATE,
  MANUAL_CONTACT_CHANNELS,
  MANUAL_CONTACT_METHODS,
  MANUAL_CONTACT_NOTE_MAX_LENGTH,
  MANUAL_CONTACT_REQUEST_TTL_HOURS,
  manualContactTargetHash,
} from "@/src/lib/manual-contact-verification";

/**
 * Manual contact verification actions — zero-cost launch Task A (founder
 * 2026-10-12, FD-R1/FD-R29: chưa có paid OTP provider; two-person manual
 * contact verification thay block psql runbook §6 cho MỤC ĐÍCH NÀY).
 * KHÔNG đụng src/lib/verification-delivery.ts (OTP adapter production vẫn
 * fail-closed); KHÔNG đụng flow OTP của verification.ts.
 *
 * TWO-PERSON RULE (spec §5.4.2 hướng đọc nghiêm nhất — A5):
 *  - admin A (super/ops, contact.verify_manual + step-up) mở request sau khi
 *    xác nhận out-of-band (gọi điện/gặp mặt/video) với chủ tài khoản;
 *  - admin B (≠ A, ≠ subject) approve/reject — KHÔNG BAO GIỜ một admin tự mở
 *    + tự duyệt (SELF_VERIFICATION_FORBIDDEN / SAME_PERSON_FORBIDDEN);
 *  - approve set emailVerifiedAt/phoneVerifiedAt CHỈ KHI CÒN NULL (conditional
 *    updateAll — không đè timestamp cũ); uniqueness danh tính verified cùng
 *    hợp đồng OTP confirm path (verification.ts — phone re-check trong tx,
 *    email là unique constraint của chính chủ).
 *
 * Audit action registry (disjoint mọi batch trước — spec §4.6):
 *   contact.manual_verify_requested / contact.manual_verify_approved /
 *   contact.manual_verify_rejected / contact.manual_verify_cancelled —
 *   auditEventTx TRONG cùng tx với write (sống chết cùng nhau); detail chỉ
 *   ids/channel/method/decision — KHÔNG raw email/phone/note (spec §4.8).
 *
 * Transaction constraint-violation rule (Global Constraints — Batch 3/6/7):
 * violation (23505) LUÔN throw ra khỏi callback (Postgres abort tx); classify
 * NGOÀI tx theo SqlQueryError + sqlState + constraint PREFIX (tên index render
 * kèm hash suffix); CAS mọi write phụ thuộc giá trị đã đọc (updateAll where);
 * re-read guarded row INSIDE tx; rethrow mọi lỗi khác (fail closed).
 *
 * Expired KHÔNG cron: row requested quá expiresAt bị CAS chặn (expiresAt.gt
 * now) → EXPIRED typed error; request MỚI flip row quá hạn sang 'expired'
 * trong tx của mình (partial unique status='requested' nếu không sẽ chặn
 * vĩnh viễn kênh sau lần đầu hết hạn).
 *
 * Rate limit (§7.1): MỘT bucket per ADMIN dùng chung cả ba action
 * (manual-contact-verify:<adminId>) — PROVISIONAL (P5 precedent). Fail open
 * (limiter lỗi → không chặn — cùng posture auth.ts).
 *
 * Step-up: contact.verify_manual ∈ STEP_UP_CAPABILITIES (A5 — quyết định
 * verification thủ công). Lỗi typed operator sửa được (STEP_UP_REQUIRED /
 * MFA_CODE_INVALID / MFA_RATE_LIMITED) → form state; FORBIDDEN (sai role /
 * session chưa MFA) vẫn ném — guard fail phạt âm (pattern admin-identity.ts).
 */

export type ManualContactFormState = {
  /** Mã lỗi ổn định cho test/client (map sang tiếng Việt ở client) — không prose tự chế. */
  error?: string;
  success?: string;
};

// ─── Validation schemas ──────────────────────────────────────────────────────

const channelSchema = z.enum(MANUAL_CONTACT_CHANNELS, {
  error: () => "INVALID_INPUT",
});
const methodSchema = z.enum(MANUAL_CONTACT_METHODS, {
  error: () => "INVALID_INPUT",
});
const decisionSchema = z.enum(["approve", "reject"], {
  error: () => "INVALID_INPUT",
});

// ─── Step-up error mapping (pattern admin-identity.ts toRoleErrorState) ──────

/** Lỗi typed operator SỬA ĐƯỢC (nhập mã rồi gửi lại) — FORBIDDEN vẫn ném. */
const STEP_UP_STATE = new Set(["STEP_UP_REQUIRED", "MFA_CODE_INVALID", "MFA_RATE_LIMITED"]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Giá trị CHUẨN HÓA của kênh trên row user FRESH — throw sentinel khi rác. */
function normalizedChannelValue(
  channel: "email" | "phone",
  subject: { email: string; phone: string | null },
): string {
  if (channel === "email") return normalizeEmail(subject.email);
  if (subject.phone === null) throw new Error("PHONE_NOT_ON_FILE");
  return normalizePhone(subject.phone);
}

/** TOTP từ formData — rỗng → undefined (không đòi mã khi step-up còn tươi). */
const totpFromForm = (formData: FormData): string | undefined =>
  String(formData.get("totpCode") ?? "").trim() || undefined;

// ─── 1. Admin A mở request ────────────────────────────────────────────────────

/**
 * Mở request xác minh thủ công (admin A): lưu hash của giá trị kênh HIỆN TẠI
 * trên tài khoản (derive từ DB — formData bị bỏ qua, cùng nguyên tắc
 * verification.ts), TTL 24h, partial unique manual_contact_one_requested là
 * ranh giới cuối chống double-request (pre-check application-level chỉ là
 * convenience). Note ≤ 1000 qua redactDetail TẠI WRITE TIME.
 */
export async function requestManualContactVerificationAction(
  _prev: ManualContactFormState,
  formData: FormData,
): Promise<ManualContactFormState> {
  // Guard + step-up (A5) — lỗi typed operator sửa được → state; FORBIDDEN ném.
  let ctx: AdminContext;
  try {
    ctx = await requireCapabilityWithStepUp("contact.verify_manual", totpFromForm(formData));
  } catch (e) {
    const key = e instanceof Error ? e.message : String(e);
    if (STEP_UP_STATE.has(key)) return { error: key };
    throw e;
  }
  // Rate limit per admin (§7.1) — fail open (checkRateLimit tự catch lỗi limiter).
  const limited = checkRateLimit(
    `manual-contact-verify:${ctx.user.id}`,
    MANUAL_CONTACT_ACTION_RATE,
  );
  if (!limited.allowed) return { error: "RATE_LIMITED" };

  const userId = String(formData.get("userId") ?? "").trim();
  const channelParsed = channelSchema.safeParse(String(formData.get("channel") ?? ""));
  const methodParsed = methodSchema.safeParse(String(formData.get("method") ?? ""));
  if (!userId || !channelParsed.success || !methodParsed.success) {
    return { error: "INVALID_INPUT" };
  }
  const channel = channelParsed.data;
  const method = methodParsed.data;
  const noteRaw = String(formData.get("note") ?? "").trim();
  if (noteRaw.length > MANUAL_CONTACT_NOTE_MAX_LENGTH) return { error: "NOTE_TOO_LONG" };
  const note = noteRaw === "" ? null : redactDetail(noteRaw);

  // Two-person rule (leg 1): subject ≠ chính mình — tự mở cho mình là đường
  // leo thang đặc quyền (SELF_GRANT_FORBIDDEN precedent Batch 2).
  if (userId === ctx.user.id) return { error: "SELF_VERIFICATION_FORBIDDEN" };

  // Subject FRESH — kênh phải CÓ giá trị + CHƯA verified (cùng hợp đồng
  // requestPhoneVerificationAction của verification.ts).
  const subject = await db.orm.public.User.first({ id: userId });
  if (subject === null) return { error: "USER_NOT_FOUND" };
  if (channel === "email" && subject.emailVerifiedAt !== null) return { error: "ALREADY_VERIFIED" };
  if (channel === "phone" && subject.phoneVerifiedAt !== null) {
    return { error: "ALREADY_VERIFIED" };
  }
  let target: string;
  try {
    target = normalizedChannelValue(channel, subject);
  } catch {
    return { error: "PHONE_NOT_ON_FILE" }; // số rác/legacy không chuẩn hóa được
  }
  const targetHash = manualContactTargetHash(target);

  const nowIso = new Date().toISOString();

  // Pre-check open request (convenience — partial unique là ranh giới cuối).
  // Row requested QUÁ HẠN không tính (expired-on-read, no cron) — request
  // mới được mở lại sau khi tx bên dưới flip nó sang 'expired'.
  const open = await db.orm.public.ManualContactVerification
    .where({ userId, channel })
    .where((v) => v.status.eq("requested"))
    .where((v) => v.expiresAt.gt(nowIso))
    .first();
  if (open !== null) return { error: "OPEN_REQUEST_EXISTS" };

  const expiresAt = new Date(
    Date.now() + MANUAL_CONTACT_REQUEST_TTL_HOURS * 3_600_000,
  ).toISOString();

  try {
    await db.transaction(async (tx) => {
      // Hết hạn trên read (no cron): row requested quá expiresAt chuyển thành
      // 'expired' TRƯỚC khi tạo row mới — không thì partial unique
      // (status='requested') chặn VĨNH VIÊN kênh này sau lần đầu hết hạn.
      // Row được GIỮ làm audit trail (không delete).
      await tx.orm.public.ManualContactVerification
        .where({ userId, channel })
        .where((v) => v.status.eq("requested"))
        .where((v) => v.expiresAt.lte(nowIso))
        .updateAll({ status: "expired" });
      const row = await tx.orm.public.ManualContactVerification.create({
        userId,
        channel,
        targetHash,
        method,
        note,
        status: "requested",
        requestedById: ctx.user.id,
        requestedAt: nowIso,
        expiresAt,
      });
      // Audit sống chết cùng tx — detail ids/channel/method ONLY (§4.8:
      // KHÔNG raw email/phone, KHÔNG note — note là dữ liệu ops nội bộ của
      // row, đã redactDetail, không nhân bản vào audit).
      await auditEventTx(tx, {
        actorId: ctx.user.id,
        subjectId: userId,
        action: "contact.manual_verify_requested",
        resourceType: "ManualContactVerification",
        resourceId: row.id,
        sessionId: ctx.session.id,
        detail: `channel=${channel} method=${method}`,
      });
    });
  } catch (e) {
    // Classify NGOÀI tx (Global Constraints): concurrent double-request đâm
    // partial unique manual_contact_one_requested_<hash> → tx abort (KHÔNG
    // silent success) → typed error.
    if (
      SqlQueryError.is(e) &&
      e.sqlState === "23505" &&
      e.constraint != null &&
      e.constraint.startsWith("manual_contact_one_requested")
    ) {
      return { error: "OPEN_REQUEST_EXISTS" };
    }
    throw e; // fail closed — KHÔNG masquerade lỗi infra thành form error
  }

  revalidatePath("/admin/users");
  return { success: "Đã mở yêu cầu xác minh — chờ admin khác duyệt." };
}

// ─── 2. Admin B quyết định (approve | reject) ─────────────────────────────────

/**
 * Admin B (≠ A, ≠ subject) quyết định request. Approve:
 *  - so lại hash của giá trị HIỆN TẠI — đổi giữa request/decide → CONTACT_CHANGED
 *    (refuse, tx abort — KHÔNG duyệt giá trị chưa từng được xác nhận);
 *  - uniqueness danh tính verified CÙNG hợp đồng OTP confirm path
 *    (confirmPhoneVerificationAction): phone re-check trong tx (tài khoản khác
 *    đã verified cùng số → PHONE_ALREADY_VERIFIED), email là unique constraint
 *    của chính chủ (không thể collision);
 *  - set emailVerifiedAt/phoneVerifiedAt CHỈ KHI CÒN NULL (conditional
 *    updateAll — không đè timestamp cũ, idempotent với quyết định song song).
 * CAS trên status=requested AND expiresAt > now — 0 row → ALREADY_DECIDED /
 * EXPIRED (expired KHÔNG cron — tính lúc đọc).
 */
export async function decideManualContactVerificationAction(
  _prev: ManualContactFormState,
  formData: FormData,
): Promise<ManualContactFormState> {
  // Guard + step-up (A5) — lỗi typed operator sửa được → state; FORBIDDEN ném.
  let ctx: AdminContext;
  try {
    ctx = await requireCapabilityWithStepUp("contact.verify_manual", totpFromForm(formData));
  } catch (e) {
    const key = e instanceof Error ? e.message : String(e);
    if (STEP_UP_STATE.has(key)) return { error: key };
    throw e;
  }
  const limited = checkRateLimit(
    `manual-contact-verify:${ctx.user.id}`,
    MANUAL_CONTACT_ACTION_RATE,
  );
  if (!limited.allowed) return { error: "RATE_LIMITED" };

  const verificationId = String(formData.get("verificationId") ?? "").trim();
  const decisionParsed = decisionSchema.safeParse(String(formData.get("decision") ?? ""));
  if (!verificationId || !decisionParsed.success) return { error: "INVALID_INPUT" };
  const decision = decisionParsed.data;

  // Pre-read (ngoài tx) — two-person rule fail TRƯỚC khi đụng tx:
  // B === requester → tự duyệt request mình mở; B === subject → tự duyệt
  // liên hệ của chính mình. Cả hai đều đường leo thang đặc quyền.
  const row = await db.orm.public.ManualContactVerification.first({ id: verificationId });
  if (row === null) return { error: "NOT_FOUND" };
  if (row.userId === ctx.user.id) return { error: "SELF_VERIFICATION_FORBIDDEN" };
  if (row.requestedById === ctx.user.id) return { error: "SAME_PERSON_FORBIDDEN" };

  const nowIso = new Date().toISOString();

  try {
    await db.transaction(async (tx) => {
      // (a) RE-READ INSIDE tx — không tin row đọc trước tx (Global Constraints).
      const fresh = await tx.orm.public.ManualContactVerification.first({ id: verificationId });
      if (fresh === null) throw new Error("NOT_FOUND");
      if (fresh.userId === ctx.user.id) throw new Error("SELF_VERIFICATION_FORBIDDEN");
      if (fresh.requestedById === ctx.user.id) throw new Error("SAME_PERSON_FORBIDDEN");

      // (b) CAS — status=requested AND chưa hết hạn; 0 row = quyết định song
      // song (ALREADY_DECIDED) hoặc quá hạn (EXPIRED — no cron, tính lúc này).
      const claimed = await tx.orm.public.ManualContactVerification
        .where({ id: verificationId })
        .where((v) => v.status.eq("requested"))
        .where((v) => v.expiresAt.gt(nowIso))
        .updateAll({
          status: decision === "approve" ? "approved" : "rejected",
          decidedById: ctx.user.id,
          decidedAt: nowIso,
        });
      if (claimed.length === 0) {
        if (fresh.status !== "requested") throw new Error("ALREADY_DECIDED");
        throw new Error("EXPIRED");
      }

      // (c) Approve — recompute hash của giá trị HIỆN TẠI (INSIDE tx):
      // đổi giữa request/decide → CONTACT_CHANGED (tx abort — quyết định
      // không gắn với giá trị đã xác nhận là vô nghĩa).
      if (decision === "approve") {
        const subject = await tx.orm.public.User.first({ id: fresh.userId });
        if (subject === null) throw new Error("NOT_FOUND");
        let currentTarget: string;
        try {
          currentTarget = normalizedChannelValue(fresh.channel, subject);
        } catch {
          // số rác/legacy xuất hiện SAU request — giá trị đã đổi hình dạng
          throw new Error("CONTACT_CHANGED");
        }
        if (manualContactTargetHash(currentTarget) !== fresh.targetHash) {
          throw new Error("CONTACT_CHANGED");
        }
        if (fresh.channel === "phone") {
          // Uniqueness danh tính verified — CÙNG hợp đồng OTP confirm path
          // (verification.ts): re-check TRONG tx, KHÔNG merge, KHÔNG update.
          const owner = await tx.orm.public.User
            .where({ phone: currentTarget })
            .where((u) => u.id.neq(subject.id))
            .where((u) => u.phoneVerifiedAt.isNotNull())
            .first();
          if (owner !== null) throw new Error("PHONE_ALREADY_VERIFIED");
          // Set CHỈ khi còn null — không đè timestamp cũ (idempotent).
          await tx.orm.public.User
            .where({ id: subject.id })
            .where((u) => u.phoneVerifiedAt.isNull())
            .updateAll({ phoneVerifiedAt: nowIso });
        } else {
          // Email: unique constraint của chính chủ (User.email) — không thể
          // collision; set CHỈ khi còn null.
          await tx.orm.public.User
            .where({ id: subject.id })
            .where((u) => u.emailVerifiedAt.isNull())
            .updateAll({ emailVerifiedAt: nowIso });
        }
      }

      // (d) Audit sống chết cùng tx — ids/channel/method/decision ONLY (§4.8).
      await auditEventTx(tx, {
        actorId: ctx.user.id,
        subjectId: fresh.userId,
        action:
          decision === "approve"
            ? "contact.manual_verify_approved"
            : "contact.manual_verify_rejected",
        resourceType: "ManualContactVerification",
        resourceId: fresh.id,
        sessionId: ctx.session.id,
        detail: `channel=${fresh.channel} method=${fresh.method} decision=${decision}`,
      });
    });
  } catch (e) {
    // Classify sentinels NGOÀI tx — KHÔNG bao giờ trong callback (Postgres
    // abort tx khi violation; catch trong callback = silent-success bug).
    if (e instanceof Error) {
      switch (e.message) {
        case "NOT_FOUND":
          return { error: "NOT_FOUND" };
        case "SELF_VERIFICATION_FORBIDDEN":
          return { error: "SELF_VERIFICATION_FORBIDDEN" };
        case "SAME_PERSON_FORBIDDEN":
          return { error: "SAME_PERSON_FORBIDDEN" };
        case "ALREADY_DECIDED":
          return { error: "ALREADY_DECIDED" };
        case "EXPIRED":
          return { error: "EXPIRED" };
        case "CONTACT_CHANGED":
          return { error: "CONTACT_CHANGED" };
        case "PHONE_ALREADY_VERIFIED":
          return { error: "PHONE_ALREADY_VERIFIED" };
      }
    }
    throw e; // fail closed — KHÔNG map mù lỗi infra thành form error
  }

  revalidatePath("/admin/users");
  return {
    success:
      decision === "approve"
        ? "Đã duyệt xác minh — kênh được đánh dấu đã xác minh."
        : "Đã từ chối yêu cầu xác minh.",
  };
}

// ─── 3. Requester tự hủy (optional) ──────────────────────────────────────────

/**
 * Admin A (người mở) hủy request của chính mình TRƯỚC khi có quyết định —
 * sai người mở nhầm kênh thì không phải chờ hết hạn. KHÔNG phải admin B hủy
 * giùm (NOT_REQUESTER — quyết định của B là approve/reject, không phải xóa
 * request của người khác). CAS status=requested AND expiresAt > now.
 */
export async function cancelManualContactVerificationAction(
  _prev: ManualContactFormState,
  formData: FormData,
): Promise<ManualContactFormState> {
  // Guard + step-up (A5) — lỗi typed operator sửa được → state; FORBIDDEN ném.
  let ctx: AdminContext;
  try {
    ctx = await requireCapabilityWithStepUp("contact.verify_manual", totpFromForm(formData));
  } catch (e) {
    const key = e instanceof Error ? e.message : String(e);
    if (STEP_UP_STATE.has(key)) return { error: key };
    throw e;
  }
  const limited = checkRateLimit(
    `manual-contact-verify:${ctx.user.id}`,
    MANUAL_CONTACT_ACTION_RATE,
  );
  if (!limited.allowed) return { error: "RATE_LIMITED" };

  const verificationId = String(formData.get("verificationId") ?? "").trim();
  if (!verificationId) return { error: "INVALID_INPUT" };

  const row = await db.orm.public.ManualContactVerification.first({ id: verificationId });
  if (row === null) return { error: "NOT_FOUND" };
  if (row.requestedById !== ctx.user.id) return { error: "NOT_REQUESTER" };

  const nowIso = new Date().toISOString();

  try {
    await db.transaction(async (tx) => {
      // RE-READ INSIDE tx — không tin row đọc trước tx.
      const fresh = await tx.orm.public.ManualContactVerification.first({ id: verificationId });
      if (fresh === null) throw new Error("NOT_FOUND");
      if (fresh.requestedById !== ctx.user.id) throw new Error("NOT_REQUESTER");

      // CAS — status=requested AND chưa hết hạn; 0 row = đã quyết định
      // (ALREADY_DECIDED) hoặc quá hạn (EXPIRED).
      const moved = await tx.orm.public.ManualContactVerification
        .where({ id: verificationId })
        .where((v) => v.status.eq("requested"))
        .where((v) => v.expiresAt.gt(nowIso))
        .updateAll({ status: "cancelled" });
      if (moved.length === 0) {
        if (fresh.status !== "requested") throw new Error("ALREADY_DECIDED");
        throw new Error("EXPIRED");
      }

      // Audit sống chết cùng tx — ids/channel/method ONLY (§4.8).
      await auditEventTx(tx, {
        actorId: ctx.user.id,
        subjectId: fresh.userId,
        action: "contact.manual_verify_cancelled",
        resourceType: "ManualContactVerification",
        resourceId: fresh.id,
        sessionId: ctx.session.id,
        detail: `channel=${fresh.channel} method=${fresh.method}`,
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
  return { success: "Đã hủy yêu cầu xác minh." };
}
