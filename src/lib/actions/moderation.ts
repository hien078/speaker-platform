"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { SqlQueryError } from "@prisma/orm-family-sql/errors";
import { db } from "@/src/prisma/db.client";
import { requireCapability, requireCapabilityWithStepUp } from "@/src/lib/rbac";
import { auditEventTx, redactDetail } from "@/src/lib/audit-event";
import { notify } from "@/src/lib/notify";
import {
  SUSPENSION_REASON_CODES,
  getCaseSubjectUserId,
  type ModerationCaseState,
  type ReportTargetType,
  type SuspensionReasonCode,
} from "@/src/lib/moderation";

/**
 * Moderation actions — suspension + lift (Batch 3 plan Task 5, spec §7.8 +
 * §5.4.2 + §4.5/§4.6/§4.8 + §5.5 typed reasons). Task 6 thêm assign/transition/
 * takedown vào CHÍNH file này (file-conflict rules: sequential).
 *
 * Suspension mechanism (spec §7.8 — minimal set, P1/A2):
 *  - `suspendUserAction`: super_admin/operations_admin THEO fail-closed matrix
 *    (moderator/support ô "Scoped" chưa định nghĩa → FORBIDDEN, Ambiguities A1)
 *    + STEP-UP (A9 — spec §5.4.2 "destructive account action": đình chỉ chặn
 *    platform participation qua actor-side guards). KHÔNG thu hồi session,
 *    KHÔNG chặn login — cả hai là sanction policy ngoài §7.8 minimal set
 *    (A2); guard đọc DB FRESH mỗi action (isUserSuspended) là enforcement.
 *  - `liftSuspensionAction`: cùng capability nhưng KHÔNG step-up — lift là
 *    hướng khôi phục, không "destructive" (recorded decision, Batch 3 Scope
 *    Decisions — reversible by founder ruling).
 *
 * Transaction constraint-violation rule (Global Constraints — Postgres):
 *  MỌI unique/constraint violation (SQLSTATE 23505) ABORT toàn bộ
 *  `db.transaction` — Prisma 8 tx context KHÔNG có savepoint. Nên:
 *   (1) violation LUÔN throw ra khỏi callback (KHÔNG BAO GIỜ catch-and-return
 *       — wrapper COMMIT một tx đã abort = silent ROLLBACK = bug success-trống);
 *   (2) classify NGOÀI tx: SqlQueryError + sqlState "23505" + constraint name
 *       (`user_suspension_one_active` → USER_ALREADY_SUSPENDED);
 *   (3) re-read row được claim BÊN TRONG tx (case) — không tin read trước tx.
 *
 * Audit (spec §4.6 — append-only): mọi action privileged append AuditEvent
 * (auditEventTx — sống chết cùng tx chính) + ModerationAction (case-scoped
 * history). KHÔNG update/delete bất kỳ row nào của hai bảng này.
 *
 * PII (spec §4.8): note admin qua redactDetail TẠI WRITE TIME vào CẢ
 * UserSuspension.note LẪN ModerationAction.note LẪN AuditEvent.detail —
 * belt-and-braces áp trong action, không bỏ cho convention.
 */

const suspensionReasonSchema = z.enum(SUSPENSION_REASON_CODES, {
  error: () => "Lý do đình chỉ không hợp lệ.",
});

/**
 * PROVISIONAL (A8 — FD-3): nhãn lý do đình chỉ cho notify + form select.
 * Vocabulary implementation thỏa yêu cầu "typed reasons" (spec §5.5) — GIÁ TRỊ
 * không phải spec-sourced; founder-acknowledged trước beta (Batch 8 register).
 * (SUSPENSION_REASON_LABELS canonical thuộc Task 6 — src/lib/constants.ts;
 * map cục bộ ở đây vì constants.ts do Task 4/6 sở hữu theo file-conflict rules.)
 */
const SUSPENSION_REASON_LABELS: Record<SuspensionReasonCode, string> = {
  confirmed_abuse: "Lạm dụng đã được xác nhận",
  confirmed_scam: "Lừa đảo đã được xác nhận",
  confirmed_harassment: "Quấy rối đã được xác nhận",
  confirmed_spam: "Spam đã được xác nhận",
  prohibited_content: "Đăng nội dung bị cấm",
  terms_violation: "Vi phạm điều khoản",
  other_reviewed_reason: "Lý do khác (đã review)",
};

/** Case state còn có thể gắn sanction (S5) — dismissed/appealed/closed fail closed. */
const ACTIONABLE_CASE_STATES: readonly ModerationCaseState[] = [
  "open",
  "triaged",
  "investigating",
  "actioned",
];

/** Case state CHƯA actioned — sanction chuyển nó sang actioned (S6). */
const PRE_ACTION_CASE_STATES: readonly ModerationCaseState[] = [
  "open",
  "triaged",
  "investigating",
];

/**
 * Đình chỉ một user (spec §7.8). formData: userId, reasonCode, note?, caseId?,
 * totpCode? (step-up — A9). Guard order: capability+step-up → validation →
 * target checks → case checks (S5/S9) → tx (suspension + atomic case→actioned
 * + action + audit) → notify. KHÔNG thu hồi session ở BẤT KỲ đâu (P1).
 */
export async function suspendUserAction(formData: FormData): Promise<void> {
  const userId = String(formData.get("userId") ?? "").trim();
  const caseId = String(formData.get("caseId") ?? "").trim() || null;
  const totpCode = String(formData.get("totpCode") ?? "").trim() || undefined;
  const note = String(formData.get("note") ?? "").trim() || null;

  // 1. super/ops only (fail-closed matrix §5.4.1) + step-up (A9 — §5.4.2
  //    "destructive account action"): stale step-up không mã → STEP_UP_REQUIRED;
  //    mã sai → MFA_CODE_INVALID (Batch 2 guard, fail closed).
  const ctx = await requireCapabilityWithStepUp("user.suspend", totpCode);

  // 2. Typed reason (PROVISIONAL A8) — KHÔNG free text trần; note qua
  //    redactDetail TẠI WRITE TIME (spec §4.8) trước khi lưu vào CẢ
  //    UserSuspension.note LẪN ModerationAction.note LẪN AuditEvent.detail.
  const reasonParsed = suspensionReasonSchema.safeParse(
    String(formData.get("reasonCode") ?? ""),
  );
  if (!reasonParsed.success) throw new Error("INVALID_SUSPENSION_REASON");
  const reasonCode: SuspensionReasonCode = reasonParsed.data;
  const safeNote = note === null ? null : redactDetail(note);

  // 3. Target checks: tồn tại; admin account → runbook Batch 2 (A6); tự treo
  //    mình → typed error (một admin tự đình chỉ mình là đường leo thang).
  if (!userId) throw new Error("INVALID_USER");
  if (userId === ctx.user.id) throw new Error("CANNOT_SUSPEND_SELF");
  const target = await db.orm.public.User.first({ id: userId });
  if (target === null) throw new Error("USER_NOT_FOUND");
  if (target.adminRole != null) {
    // A6: admin lockout thuộc bootstrap runbook Batch 2 (admin.role_manage /
    // mfa-reset) — KHÔNG phải moderation sanction.
    throw new Error("ADMIN_ACCOUNT_USE_ROLE_MANAGEMENT");
  }

  // 4. Case checks (S5/S9) — chỉ khi gắn case; mọi lỗi throw TRƯỚC tx (zero writes).
  if (caseId !== null) {
    const caseRow = await db.orm.public.ModerationCase.first({ id: caseId });
    if (caseRow === null) throw new Error("CASE_NOT_ACTIONABLE");

    // SUBJECT (SHOULD-FIX 2 — không đòi targetType === "user"): evidence
    // subjectUserId chụp tại report time (bất biến — sống qua edit/delete của
    // source); live lookup chỉ là fallback khi case không có evidence.
    const evidence = await db.orm.public.ModerationEvidence
      .where({ caseId })
      .select("subjectUserId")
      .first();
    const subjectUserId =
      evidence?.subjectUserId ??
      (await getCaseSubjectUserId(
        caseRow.targetType as ReportTargetType,
        caseRow.targetId,
      ));

    // Actor conflict (S9 — fail closed): admin là subject HOẶC reporter của
    // case thì không được dùng case đó ra quyết định (recusal policy = A7).
    if (subjectUserId !== null && subjectUserId === ctx.user.id) {
      throw new Error("MODERATOR_CONFLICT");
    }
    const reported = await db.orm.public.AbuseReport
      .where({ caseId, reporterId: ctx.user.id })
      .first();
    if (reported !== null) throw new Error("MODERATOR_CONFLICT");

    // Subject match: sanction phải rơi đúng subject của case (case về
    // listing/message có subject là seller/sender — treo đúng người đó).
    if (subjectUserId === null || subjectUserId !== userId) {
      throw new Error("CASE_SUBJECT_MISMATCH");
    }

    // Actionable states only (S5) — dismissed/appealed/closed fail closed.
    if (!ACTIONABLE_CASE_STATES.includes(caseRow.state as ModerationCaseState)) {
      throw new Error("CASE_NOT_ACTIONABLE");
    }
  }

  // 5. tx — violation LUÔN throw ra khỏi callback (Global Constraints).
  //    KHÔNG catch constraint violation bên trong — Postgres abort tx.
  try {
    await db.transaction(async (tx) => {
      await tx.orm.public.UserSuspension.create({
        userId,
        status: "active",
        reasonCode,
        note: safeNote,
        suspendedById: ctx.user.id,
        suspendedAt: new Date().toISOString(),
      });
      // Concurrent double-suspend → partial index `user_suspension_one_active`
      // (Task 1) vi phạm → SqlQueryError 23505 THROW ra khỏi callback này.

      if (caseId !== null) {
        // RE-READ case BÊN TRONG tx (Global Constraints #5 — không tin read
        // trước tx cho một claim); CAS theo state vừa đọc.
        const freshCase = await tx.orm.public.ModerationCase.first({ id: caseId });
        if (freshCase === null) throw new Error("CASE_NOT_ACTIONABLE");
        const freshState = freshCase.state as ModerationCaseState;
        if (PRE_ACTION_CASE_STATES.includes(freshState)) {
          // S6: sanction atomic với actioned — appeal link người dùng nhận được
          // trỏ vào case ĐANG actioned. 0 rows → case đổi tay giữa chừng →
          // rollback toàn bộ (kể cả suspension vừa tạo).
          const claimed = await tx.orm.public.ModerationCase
            .where({ id: freshCase.id, state: freshState })
            .updateAll({ state: "actioned" });
          if (claimed.length === 0) throw new Error("CASE_ALREADY_MOVED");
          await tx.orm.public.ModerationAction.create({
            caseId: freshCase.id,
            actorId: ctx.user.id,
            actionType: "case.transitioned",
            targetType: "moderation_case",
            targetId: freshCase.id,
            reasonCode: "resolved_by_sanction",
            note: null,
          });
        } else if (freshState !== "actioned") {
          // Đã rời khỏi actionable giữa pre-check và tx (dismissed/appealed/
          // closed) — fail closed, KHÔNG gắn sanction vào case đã đóng.
          throw new Error("CASE_NOT_ACTIONABLE");
        }
        // freshState === "actioned": sanction khác đã actioned case — chỉ gắn.
      }

      // Case-scoped history (spec §5.5) — actor là admin (privileged).
      await tx.orm.public.ModerationAction.create({
        caseId,
        actorId: ctx.user.id,
        actionType: "user.suspended",
        targetType: "user",
        targetId: userId,
        reasonCode,
        note: safeNote,
      });

      // Audit (spec §4.6) — sống chết cùng tx chính (auditEventTx); detail
      // chỉ typed refs + note ĐÃ redact (spec §4.8 — KHÔNG PII thô).
      const detailParts: string[] = [];
      if (caseId !== null) detailParts.push(`case:${caseId}`);
      if (note !== null && note !== "") detailParts.push(note);
      await auditEventTx(tx, {
        actorId: ctx.user.id,
        subjectId: userId,
        action: "moderation.user_suspended",
        resourceType: "user",
        resourceId: userId,
        reason: reasonCode,
        sessionId: ctx.session.id,
        detail: detailParts.length > 0 ? redactDetail(detailParts.join("; ")) : undefined,
      });
    });
  } catch (e) {
    // Classify NGOÀI tx (Global Constraints #2): SqlQueryError + sqlState
    // 23505 + constraint-name PREFIX → typed user-facing error. (Prisma render
    // index name kèm hash suffix `<name>_<8hex>` trên DB thật — khớp PREFIX,
    // không khớp exact.) Lỗi khác ném tiếp (fail closed — KHÔNG masquerade).
    if (
      SqlQueryError.is(e) &&
      e.sqlState === "23505" &&
      e.constraint != null &&
      e.constraint.startsWith("user_suspension_one_active")
    ) {
      throw new Error("USER_ALREADY_SUSPENDED");
    }
    throw e;
  }

  // 6. Notify user (best-effort — không sống chết với sanction đã commit).
  //    Copy là PLACEHOLDER (FD-3) — sanction-notification wording là
  //    founder-authored content (Batch 8 register). Link /appeal/<caseId>
  //    KHÔNG gửi ở task này — page thuộc Task 7; Task 7 thêm link vào
  //    call-site này (không commit nào có dead link).
  await notify(
    userId,
    "moderation",
    "Tài khoản bị tạm đình chỉ", // PLACEHOLDER (FD-3) — Batch 8 register
    SUSPENSION_REASON_LABELS[reasonCode], // PROVISIONAL (A8)
    undefined,
  );

  revalidatePath("/admin/users");
}

/**
 * Gỡ đình chỉ (spec §7.8 — hướng khôi phục). formData: suspensionId,
 * reasonCode, note?. KHÔNG step-up (Scope Decisions — lift không phải
 * "destructive account action" §5.4.2). Row được đọc BÊN TRONG tx (E2 — cần
 * userId cho ModerationAction.targetId + audit subjectId), claim ATOMIC theo
 * status active (concurrent lift → SUSPENSION_ALREADY_LIFTED).
 */
export async function liftSuspensionAction(formData: FormData): Promise<void> {
  const suspensionId = String(formData.get("suspensionId") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim() || null;

  // 1. Cùng capability, KHÔNG step-up (recorded decision — Batch 3 Scope
  //    Decisions; reversible by founder ruling).
  const ctx = await requireCapability("user.suspend");

  // 2. Typed reason (PROVISIONAL A8) + note redact tại write time (spec §4.8).
  const reasonParsed = suspensionReasonSchema.safeParse(
    String(formData.get("reasonCode") ?? ""),
  );
  if (!reasonParsed.success) throw new Error("INVALID_SUSPENSION_REASON");
  const reasonCode: SuspensionReasonCode = reasonParsed.data;
  const safeNote = note === null ? null : redactDetail(note);

  if (!suspensionId) throw new Error("INVALID_SUSPENSION");

  // 3. tx — đọc row TRƯỚC (E2), claim ATOMIC, action + audit cùng tx.
  await db.transaction(async (tx) => {
    const row = await tx.orm.public.UserSuspension.first({ id: suspensionId });
    if (row === null) throw new Error("SUSPENSION_NOT_FOUND");

    // ATOMIC CLAIM: chỉ episode active mới lift được — 0 rows (đã lifted bởi
    // request khác / row biến mất) → throw RA khỏi callback → tx rollback.
    const claimed = await tx.orm.public.UserSuspension
      .where({ id: suspensionId, status: "active" })
      .updateAll({
        status: "lifted",
        liftedById: ctx.user.id,
        liftedAt: new Date().toISOString(),
        liftReasonCode: reasonCode,
      });
    if (claimed.length === 0) throw new Error("SUSPENSION_ALREADY_LIFTED");

    await tx.orm.public.ModerationAction.create({
      caseId: null,
      actorId: ctx.user.id,
      actionType: "user.suspension_lifted",
      targetType: "user",
      targetId: row.userId,
      reasonCode,
      note: safeNote,
    });

    await auditEventTx(tx, {
      actorId: ctx.user.id,
      subjectId: row.userId,
      action: "moderation.user_suspension_lifted",
      resourceType: "user_suspension",
      resourceId: suspensionId,
      reason: reasonCode,
      sessionId: ctx.session.id,
      detail: safeNote ?? undefined, // đã redact — KHÔNG PII thô (spec §4.8)
    });
  });

  revalidatePath("/admin/users");
}
