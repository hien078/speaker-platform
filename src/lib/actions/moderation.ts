"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { SqlQueryError } from "@prisma/orm-family-sql/errors";
import { db } from "@/src/prisma/db.client";
import { requireCapability, requireCapabilityWithStepUp, capabilitiesOf } from "@/src/lib/rbac";
import { auditEventTx, redactDetail } from "@/src/lib/audit-event";
import { notify } from "@/src/lib/notify";
import { captureError } from "@/src/lib/observability";
import { MODERATION_DECISION_REASON_LABELS, SUSPENSION_REASON_LABELS } from "@/src/lib/constants";
import {
  SUSPENSION_REASON_CODES,
  SUSPENSION_NOTE_MAX_LENGTH,
  MODERATION_ASSIGNMENT_REASON_CODES,
  MODERATION_CASE_STATES,
  MODERATION_DECISION_REASON_CODES,
  MODERATION_PRIORITIES,
  ACTIVE_MODERATION_CASE_STATES,
  canTransition,
  getCaseSubjectUserId,
  isCaseViewerConflicted,
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

const assignmentReasonSchema = z.enum(MODERATION_ASSIGNMENT_REASON_CODES, {
  error: () => "Lý do phân công không hợp lệ.",
});

const decisionReasonSchema = z.enum(MODERATION_DECISION_REASON_CODES, {
  error: () => "Lý do quyết định không hợp lệ.",
});

const caseStateSchema = z.enum(MODERATION_CASE_STATES, {
  error: () => "Trạng thái case không hợp lệ.",
});

const prioritySchema = z.enum(MODERATION_PRIORITIES, {
  error: () => "Mức ưu tiên không hợp lệ.",
});

/**
 * PROVISIONAL (A8 — FD-3): nhãn lý do đình chỉ cho notify + form select —
 * CANONICAL từ Task 6: src/lib/constants.ts (map cục bộ trước đây đã thay
 * bằng import — một nguồn duy nhất, không drift).
 */

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
 *
 * Review fix Task 5: note cap server-side SUSPENSION_NOTE_MAX_LENGTH (2000 —
 * cùng maxLength form); notify sau commit là best-effort THẬT (try/catch +
 * captureError — lỗi notify KHÔNG biến sanction đã commit thành 500).
 */
export async function suspendUserAction(formData: FormData): Promise<void> {
  const userId = String(formData.get("userId") ?? "").trim();
  const caseId = String(formData.get("caseId") ?? "").trim() || null;
  const totpCode = String(formData.get("totpCode") ?? "").trim() || undefined;
  const noteRaw = String(formData.get("note") ?? "");

  // 1. super/ops only (fail-closed matrix §5.4.1) + step-up (A9 — §5.4.2
  //    "destructive account action"): stale step-up không mã → STEP_UP_REQUIRED;
  //    mã sai → MFA_CODE_INVALID (Batch 2 guard, fail closed).
  const ctx = await requireCapabilityWithStepUp("user.suspend", totpCode);

  // 2. Typed reason (PROVISIONAL A8) — KHÔNG free text trần; note qua
  //    redactDetail TẠI WRITE TIME (spec §4.8) trước khi lưu vào CẢ
  //    UserSuspension.note LẪN ModerationAction.note LẪN AuditEvent.detail.
  //    Cap note server-side (review fix Task 5): SUSPENSION_NOTE_MAX_LENGTH
  //    (2000 — cùng maxLength form; form chỉ là convenience, forged form
  //    fail closed với typed error).
  const reasonParsed = suspensionReasonSchema.safeParse(
    String(formData.get("reasonCode") ?? ""),
  );
  if (!reasonParsed.success) throw new Error("INVALID_SUSPENSION_REASON");
  const reasonCode: SuspensionReasonCode = reasonParsed.data;
  if (noteRaw.length > SUSPENSION_NOTE_MAX_LENGTH) {
    throw new Error("SUSPENSION_NOTE_TOO_LONG");
  }
  const note = noteRaw.trim() || null;
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

  // 6. Notify user (best-effort — không sống chết với sanction đã commit —
  //    review fix Task 5: try/catch + captureError THẬT như comment claims; lỗi
  //    notify KHÔNG biến sanction đã commit thành 500). Copy là PLACEHOLDER
  //    (FD-3) — sanction-notification wording là founder-authored content
  //    (Batch 8 register). Link /appeal/<caseId> (Task 7): chỉ khi sanction gắn
  //    case — case đã được atomic move sang actioned (S6) nên link trỏ vào case
  //    ĐANG actioned (subject appeal được); không case → không link (không có
  //    case nào để kháng cáo). Meta KHÔNG PII (spec §4.8) — chỉ typed refs.
  try {
    await notify(
      userId,
      "moderation",
      "Tài khoản bị tạm đình chỉ", // PLACEHOLDER (FD-3) — Batch 8 register
      SUSPENSION_REASON_LABELS[reasonCode], // PROVISIONAL (A8)
      caseId !== null ? `/appeal/${caseId}` : undefined,
    );
  } catch (notifyError) {
    captureError("moderation", notifyError, {
      action: "moderation.user_suspended_notify",
      subjectId: userId, // typed ref — KHÔNG PII (spec §4.8)
    });
  }

  revalidatePath("/admin/users");
}

/**
 * Gỡ đình chỉ (spec §7.8 — hướng khôi phục). formData: suspensionId,
 * reasonCode, note?. KHÔNG step-up (Scope Decisions — lift không phải
 * "destructive account action" §5.4.2). Row được đọc BÊN TRONG tx (E2 — cần
 * userId cho ModerationAction.targetId + audit subjectId), claim ATOMIC theo
 * status active (concurrent lift → SUSPENSION_ALREADY_LIFTED).
 *
 * Review fix Task 5: KHÔNG tự gỡ đình chỉ CHÍNH MÌNH (CANNOT_LIFT_SELF —
 * đối xứng CANNOT_SUSPEND_SELF); note cap server-side
 * SUSPENSION_NOTE_MAX_LENGTH (2000 — như suspendUserAction).
 */
export async function liftSuspensionAction(formData: FormData): Promise<void> {
  const suspensionId = String(formData.get("suspensionId") ?? "").trim();
  const noteRaw = String(formData.get("note") ?? "");

  // 1. Cùng capability, KHÔNG step-up (recorded decision — Batch 3 Scope
  //    Decisions; reversible by founder ruling).
  const ctx = await requireCapability("user.suspend");

  // 2. Typed reason (PROVISIONAL A8) + note redact tại write time (spec §4.8).
  //    Cap note server-side (review fix Task 5) — như suspendUserAction.
  const reasonParsed = suspensionReasonSchema.safeParse(
    String(formData.get("reasonCode") ?? ""),
  );
  if (!reasonParsed.success) throw new Error("INVALID_SUSPENSION_REASON");
  const reasonCode: SuspensionReasonCode = reasonParsed.data;
  if (noteRaw.length > SUSPENSION_NOTE_MAX_LENGTH) {
    throw new Error("SUSPENSION_NOTE_TOO_LONG");
  }
  const note = noteRaw.trim() || null;
  const safeNote = note === null ? null : redactDetail(note);

  if (!suspensionId) throw new Error("INVALID_SUSPENSION");

  // 3. tx — đọc row TRƯỚC (E2), claim ATOMIC, action + audit cùng tx.
  await db.transaction(async (tx) => {
    const row = await tx.orm.public.UserSuspension.first({ id: suspensionId });
    if (row === null) throw new Error("SUSPENSION_NOT_FOUND");

    // Review fix Task 5: KHÔNG tự gỡ đình chỉ CHÍNH MÌNH — một admin tự
    // un-suspend mình là đường leo thang đặc quyền (đối xứng CANNOT_SUSPEND_SELF;
    // row này chỉ tồn tại nếu admin bị đình chỉ TRƯỚC khi được phong role —
    // suspendUserAction chặn admin target, A6). Throw RA khỏi callback →
    // tx rollback → row GIỮ NGUYÊN active.
    if (row.userId === ctx.user.id) throw new Error("CANNOT_LIFT_SELF");

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

// ─── Task 6: moderation console — assign / transition / takedown ──────────────

/**
 * Conflict-of-interest (S9 — fail closed; recusal POLICY = Ambiguity A7):
 * admin là SUBJECT hoặc REPORTER của case thì không được ra quyết định trên
 * case đó. Delegation về isCaseViewerConflicted (domain module — CÙNG nguồn
 * truth với recusal-on-views của case page, item 3 review fix Task 6):
 * subject ưu tiên ModerationEvidence.subjectUserId (bất biến — chụp tại
 * report time, sống qua edit/delete của source), fallback live lookup
 * getCaseSubjectUserId; reporter qua AbuseReport existence.
 */
async function assertActorNotConflicted(
  caseRow: { id: string; targetType: string; targetId: string },
  actorId: string,
): Promise<void> {
  if (
    await isCaseViewerConflicted(
      caseRow.id,
      caseRow.targetType as ReportTargetType,
      caseRow.targetId,
      actorId,
    )
  ) {
    throw new Error("MODERATOR_CONFLICT");
  }
}

/**
 * Phân công case (Batch 3 Task 6 — spec §5.5 case assignment + §5.4.1
 * report.resolve ✓ cells + §5.5 typed reasons). formData: caseId, moderatorId,
 * reasonCode.
 *
 * Assignee eligibility: tồn tại + capabilitiesOf(adminRole) có report.resolve
 * (analyst làm assignee → ASSIGNEE_NOT_ELIGIBLE — fail closed). Case closed →
 * CASE_CLOSED (S8). CAS trên (state, assignedModeratorId) vừa đọc FRESH trong
 * tx — concurrent assign thứ hai → CASE_ASSIGNMENT_CONFLICT (0 rows → throw
 * ra khỏi callback → tx rollback, Global Constraints).
 */
export async function assignModerationCaseAction(formData: FormData): Promise<void> {
  const caseId = String(formData.get("caseId") ?? "").trim();
  const moderatorId = String(formData.get("moderatorId") ?? "").trim();

  // 1. super/ops/moderator (ô ✓ report.resolve — analyst/support fail closed A1).
  const ctx = await requireCapability("report.resolve");

  // 2. Typed ASSIGNMENT reason (PROVISIONAL A8 — spec §5.5 "typed reasons").
  const reasonParsed = assignmentReasonSchema.safeParse(
    String(formData.get("reasonCode") ?? ""),
  );
  if (!reasonParsed.success) throw new Error("INVALID_ASSIGNMENT_REASON");

  if (!caseId || !moderatorId) throw new Error("INVALID_CASE_OR_MODERATOR");

  // 3. Assignee eligibility — KHÔNG tin form: analyst id submit lên cũng bị chặn.
  const assignee = await db.orm.public.User.first({ id: moderatorId });
  if (assignee === null) throw new Error("ASSIGNEE_NOT_ELIGIBLE");
  if (!capabilitiesOf(assignee.adminRole).includes("report.resolve")) {
    throw new Error("ASSIGNEE_NOT_ELIGIBLE");
  }

  // 4. Case checks (S8/S9) — mọi lỗi throw TRƯỚC tx (zero writes).
  const caseRow = await db.orm.public.ModerationCase.first({ id: caseId });
  if (caseRow === null) throw new Error("CASE_NOT_FOUND");
  if (caseRow.state === "closed") throw new Error("CASE_CLOSED");
  await assertActorNotConflicted(caseRow, ctx.user.id);

  // 4b. ASSIGNEE_CONFLICT (review fix Task 6 item 6 — "ai gán cho ai" ghi
  // vào A7/A1 register): assignee là SUBJECT hoặc REPORTER của case thì
  // KHÔNG được gán — không ai tự xử lý case về chính mình, reporter không
  // xử lý chính case mình báo cáo (đối xứng MODERATOR_CONFLICT của actor;
  // eligibility check ở bước 3 chỉ chặn role, KHÔNG chặn xung đột).
  if (
    await isCaseViewerConflicted(
      caseId,
      caseRow.targetType as ReportTargetType,
      caseRow.targetId,
      moderatorId,
    )
  ) {
    throw new Error("ASSIGNEE_CONFLICT");
  }

  // 5. tx — CAS trên assignee cũ + state; RE-READ case BÊN TRONG tx
  //    (Global Constraints #5 — không tin read trước tx cho một claim).
  await db.transaction(async (tx) => {
    const fresh = await tx.orm.public.ModerationCase.first({ id: caseId });
    if (fresh === null) throw new Error("CASE_NOT_FOUND");
    const freshState = fresh.state as ModerationCaseState;
    if (freshState === "closed") throw new Error("CASE_CLOSED");

    // CAS trên (state, assignedModeratorId) vừa đọc: NULL khớp qua isNull()
    // (Prisma 8 — KHÔNG qua { field: null }).
    const claimed = await tx.orm.public.ModerationCase
      .where({ id: caseId, state: freshState })
      .where((c) =>
        fresh.assignedModeratorId == null
          ? c.assignedModeratorId.isNull()
          : c.assignedModeratorId.eq(fresh.assignedModeratorId),
      )
      .updateAll({ assignedModeratorId: moderatorId });
    if (claimed.length === 0) throw new Error("CASE_ASSIGNMENT_CONFLICT");

    // Case-scoped history (spec §5.5) — append-only.
    await tx.orm.public.ModerationAction.create({
      caseId,
      actorId: ctx.user.id,
      actionType: "case.assigned",
      targetType: "moderation_case",
      targetId: caseId,
      reasonCode: reasonParsed.data,
      note: null,
    });

    // Audit (spec §4.6) — sống chết cùng tx chính (auditEventTx).
    await auditEventTx(tx, {
      actorId: ctx.user.id,
      action: "moderation.case_assigned",
      resourceType: "moderation_case",
      resourceId: caseId,
      reason: reasonParsed.data,
      sessionId: ctx.session.id,
    });
  });

  revalidatePath("/admin/moderation");
  revalidatePath(`/admin/moderation/${caseId}`);
}

/**
 * Chuyển trạng thái case (Batch 3 Task 6 — spec §5.5 states + §10.1 concurrent
 * update). formData: caseId, toState, reasonCode, note?, priority?.
 *
 * Bảng hợp pháp = MODERATION_TRANSITIONS (moderation-vocab — closed terminal).
 * ATOMIC CLAIM theo state vừa đọc FRESH trong tx → 0 rows = CASE_ALREADY_MOVED
 * (concurrent moderator). appealed → closed ĐÓNG kèm Appeal row (bookkeeping —
 * decision POLICY vẫn là A4). Note qua redactDetail TẠI WRITE TIME vào CẢ
 * ModerationAction.note LẪN AuditEvent.detail (spec §4.8).
 */
export async function transitionModerationCaseAction(formData: FormData): Promise<void> {
  const caseId = String(formData.get("caseId") ?? "").trim();
  const toStateRaw = String(formData.get("toState") ?? "").trim();
  const noteRaw = String(formData.get("note") ?? "");
  const priorityRaw = String(formData.get("priority") ?? "").trim() || undefined;

  // 1. super/ops/moderator (report.resolve).
  const ctx = await requireCapability("report.resolve");

  // 2. Validate — typed, KHÔNG db write khi sai.
  const toParsed = caseStateSchema.safeParse(toStateRaw);
  if (!toParsed.success) throw new Error("INVALID_CASE_STATE");
  const toState = toParsed.data;
  const reasonParsed = decisionReasonSchema.safeParse(
    String(formData.get("reasonCode") ?? ""),
  );
  if (!reasonParsed.success) throw new Error("INVALID_DECISION_REASON");
  let priority: (typeof MODERATION_PRIORITIES)[number] | undefined;
  if (priorityRaw !== undefined) {
    const p = prioritySchema.safeParse(priorityRaw);
    if (!p.success) throw new Error("INVALID_PRIORITY");
    priority = p.data;
  }
  // Note → redactDetail TRƯỚC khi lưu (write-time — spec §4.8).
  const note = noteRaw.trim() || null;
  const safeNote = note === null ? null : redactDetail(note);

  if (!caseId) throw new Error("INVALID_CASE");

  // 3. Case checks: tồn tại → canTransition (bảng §5.5) → actor conflict (S9).
  const caseRow = await db.orm.public.ModerationCase.first({ id: caseId });
  if (caseRow === null) throw new Error("CASE_NOT_FOUND");
  if (!canTransition(caseRow.state as ModerationCaseState, toState)) {
    throw new Error("INVALID_TRANSITION");
  }
  await assertActorNotConflicted(caseRow, ctx.user.id);

  // 4. tx — MỘT tx cho claim + appeal bookkeeping + action + audit (S8).
  await db.transaction(async (tx) => {
    // RE-READ fresh (Global Constraints #5) — re-validate bảng chuyển trạng
    // trên giá trị fresh: state đổi tay sang hướng bất hợp pháp → fail closed.
    const fresh = await tx.orm.public.ModerationCase.first({ id: caseId });
    if (fresh === null) throw new Error("CASE_NOT_FOUND");
    const freshState = fresh.state as ModerationCaseState;
    if (!canTransition(freshState, toState)) throw new Error("INVALID_TRANSITION");

    // ATOMIC CLAIM (spec §10.1 "Concurrent ... update"): 0 rows → case đã đổi
    // tay giữa read và write → throw ra khỏi callback → tx rollback.
    const claimed = await tx.orm.public.ModerationCase
      .where({ id: caseId, state: freshState })
      .updateAll({ state: toState, priority: priority ?? fresh.priority });
    if (claimed.length === 0) throw new Error("CASE_ALREADY_MOVED");

    // appealed → closed: đóng Appeal row (bookkeeping — A4 decision workflow
    // KHÔNG được xây ở đây; 0 rows = không có appeal submitted — no-op an toàn).
    if (toState === "closed" && freshState === "appealed") {
      await tx.orm.public.Appeal
        .where({ caseId, state: "submitted" })
        .updateAll({ state: "closed", closedAt: new Date().toISOString() });
    }

    // Case-scoped history (append-only — spec §5.5).
    await tx.orm.public.ModerationAction.create({
      caseId,
      actorId: ctx.user.id,
      actionType: "case.transitioned",
      targetType: "moderation_case",
      targetId: caseId,
      reasonCode: reasonParsed.data,
      note: safeNote,
    });

    // Audit — detail chỉ typed refs (to-state) + note ĐÃ redact (spec §4.8).
    const detailParts = [`to:${toState}`];
    if (safeNote !== null) detailParts.push(safeNote);
    await auditEventTx(tx, {
      actorId: ctx.user.id,
      action: "moderation.case_transitioned",
      resourceType: "moderation_case",
      resourceId: caseId,
      reason: reasonParsed.data,
      sessionId: ctx.session.id,
      detail: redactDetail(detailParts.join("; ")),
    });
  });

  revalidatePath("/admin/moderation");
  revalidatePath(`/admin/moderation/${caseId}`);
}

/**
 * Moderation takedown (Batch 3 Task 6 — R4/R2: Batch 3 là first writer của
 * `removed`). formData: listingId, reasonCode, note?, caseId?.
 *
 * R4: atomic updateAll({ status: "removed" }) với status ∈ {approved, hidden,
 * pending} — 0 rows → LISTING_NOT_TAKEDOWN_ELIGIBLE. KHÔNG BAO GIỜ viết
 * rejected/rejectionReason — lý do sống trong ModerationAction như TYPED CODE.
 * Claim CẢ hidden (seller tự ẩn để né) LẪN pending (gỡ khỏi hàng duyệt).
 * Seller-side lock (R5) khóa `removed` tại listings.ts — restore là appeal
 * outcome (A4), KHÔNG được xây ở đây. KHÔNG đụng finance (Batch 1 preserved).
 *
 * caseId? (S5/S6): case phải tồn tại, target PHẢI là chính listing này, state
 * ∈ actionable; case pre-action → atomically `actioned` (resolved_by_sanction)
 * trong cùng tx — appeal link người dùng nhận được trỏ vào case ĐANG actioned.
 * previousStatus ghi vào AuditEvent.detail (SHOULD-FIX 5 — cho A4 restore).
 *
 * KHÔNG caseId (review fix Task 6 item 4): conflict check chống CHÍNH listing
 * (seller / reporter trên case active nhắm listing → MODERATOR_CONFLICT);
 * case ACTIVE đang nhắm listing → CASE_REQUIRED_FOR_TAKEDOWN (fail-closed —
 * moderator đi qua case để chạy đủ case checks + atomic actioned).
 */
export async function takeDownListingAction(formData: FormData): Promise<void> {
  const listingId = String(formData.get("listingId") ?? "").trim();
  const caseId = String(formData.get("caseId") ?? "").trim() || null;
  const noteRaw = String(formData.get("note") ?? "");

  // 1. super/ops/moderator (ô ✓ listing.moderate — support/analyst fail closed).
  const ctx = await requireCapability("listing.moderate");

  // 2. Typed decision reason (PROVISIONAL A8) + note redact tại write time.
  const reasonParsed = decisionReasonSchema.safeParse(
    String(formData.get("reasonCode") ?? ""),
  );
  if (!reasonParsed.success) throw new Error("INVALID_DECISION_REASON");
  const note = noteRaw.trim() || null;
  const safeNote = note === null ? null : redactDetail(note);

  if (!listingId) throw new Error("INVALID_LISTING");

  // 3. Case checks (S5/S9) — chỉ khi gắn case; mọi lỗi throw TRƯỚC tx.
  if (caseId !== null) {
    const caseRow = await db.orm.public.ModerationCase.first({ id: caseId });
    if (caseRow === null) throw new Error("CASE_NOT_ACTIONABLE");
    // Target match theo TARGET (khác suspend — match theo SUBJECT): case phải
    // là về CHÍNH listing này.
    if (caseRow.targetType !== "listing" || caseRow.targetId !== listingId) {
      throw new Error("CASE_TARGET_MISMATCH");
    }
    if (!ACTIONABLE_CASE_STATES.includes(caseRow.state as ModerationCaseState)) {
      throw new Error("CASE_NOT_ACTIONABLE");
    }
    await assertActorNotConflicted(caseRow, ctx.user.id);
  } else {
    // Review fix Task 6 (item 4 — recusal gap khi KHÔNG caseId): conflict
    // check chống CHÍNH listing — actor là SELLER (tự takedown listing của
    // mình qua đường moderation = self-target sanction) hoặc REPORTER trên
    // case ACTIVE nhắm listing (tự rút quyết định case mình đã báo cáo) →
    // MODERATOR_CONFLICT (S9 fail closed — recusal policy A7).
    const listing = await db.orm.public.Listing.first({ id: listingId });
    if (listing !== null && listing.sellerId === ctx.user.id) {
      throw new Error("MODERATOR_CONFLICT");
    }
    const activeCase = await db.orm.public.ModerationCase
      .where({ targetType: "listing", targetId: listingId })
      .where((c) => c.state.in([...ACTIVE_MODERATION_CASE_STATES]))
      .first();
    if (activeCase !== null) {
      const reported = await db.orm.public.AbuseReport
        .where({ caseId: activeCase.id, reporterId: ctx.user.id })
        .first();
      if (reported !== null) throw new Error("MODERATOR_CONFLICT");
      // Fail-closed (DECISION — record ở report fix Task 6): case ACTIVE đang
      // nhắm listing + KHÔNG caseId → takedown PHẢI đi qua case (chạy đủ case
      // checks + atomic actioned + bookkeeping S6) — KHÔNG auto-link case
      // moderator chưa review, KHÔNG takedown "mù" bên cạnh case đang điều
      // tra. Case không còn active (actioned/dismissed/appealed/closed) →
      // bookkeeping đã xong/đã đóng → takedown không kèm case được phép.
      throw new Error("CASE_REQUIRED_FOR_TAKEDOWN");
    }
  }

  // 4. tx — đọc listing TRONG tx (SHOULD-FIX 5), atomic claim, case→actioned,
  //    action + audit cùng tx (violation LUÔN throw ra khỏi callback).
  let sellerId = "";
  await db.transaction(async (tx) => {
    const listing = await tx.orm.public.Listing.first({ id: listingId });
    if (listing === null) throw new Error("LISTING_NOT_FOUND");
    sellerId = listing.sellerId;
    // previousStatus → AuditEvent.detail (cho A4 restore tương lai).
    const previousStatus = listing.status;

    // ATOMIC (R4): claim approved|hidden|pending → removed (mệnh đề IN qua
    // callback — như escrow.test.ts). 0 rows → throw ra khỏi callback →
    // tx rollback (KHÔNG silent-success).
    const claimed = await tx.orm.public.Listing
      .where({ id: listingId })
      .where((l) => l.status.in(["approved", "hidden", "pending"]))
      .updateAll({ status: "removed" });
    if (claimed.length === 0) throw new Error("LISTING_NOT_TAKEDOWN_ELIGIBLE");

    if (caseId !== null) {
      // RE-READ case BÊN TRONG tx + CAS theo state fresh (S6 — sanction atomic
      // với actioned; 0 rows → CASE_ALREADY_MOVED → rollback TOÀN BỌ kể cả
      // takedown vừa claim).
      const freshCase = await tx.orm.public.ModerationCase.first({ id: caseId });
      if (freshCase === null) throw new Error("CASE_NOT_ACTIONABLE");
      const freshState = freshCase.state as ModerationCaseState;
      if (PRE_ACTION_CASE_STATES.includes(freshState)) {
        const claimedCase = await tx.orm.public.ModerationCase
          .where({ id: caseId, state: freshState })
          .updateAll({ state: "actioned" });
        if (claimedCase.length === 0) throw new Error("CASE_ALREADY_MOVED");
        await tx.orm.public.ModerationAction.create({
          caseId,
          actorId: ctx.user.id,
          actionType: "case.transitioned",
          targetType: "moderation_case",
          targetId: caseId,
          reasonCode: "resolved_by_sanction",
          note: null,
        });
      } else if (freshState !== "actioned") {
        // Case rời khỏi actionable giữa pre-check và tx → fail closed.
        throw new Error("CASE_NOT_ACTIONABLE");
      }
      // freshState === "actioned": sanction khác đã actioned — chỉ gắn takedown.
    }

    // Case-scoped history (append-only) — typed reason, note ĐÃ redact.
    await tx.orm.public.ModerationAction.create({
      caseId,
      actorId: ctx.user.id,
      actionType: "listing.taken_down",
      targetType: "listing",
      targetId: listingId,
      reasonCode: reasonParsed.data,
      note: safeNote,
    });

    // Audit — detail: prev:<status> (A4 restore) + case ref + note đã redact.
    const detailParts: string[] = [`prev:${previousStatus}`];
    if (caseId !== null) detailParts.push(`case:${caseId}`);
    if (safeNote !== null) detailParts.push(safeNote);
    await auditEventTx(tx, {
      actorId: ctx.user.id,
      subjectId: sellerId,
      action: "moderation.listing_taken_down",
      resourceType: "listing",
      resourceId: listingId,
      reason: reasonParsed.data,
      sessionId: ctx.session.id,
      detail: redactDetail(detailParts.join("; ")),
    });
  });

  // 5. Notify seller (best-effort — KHÔNG sống chết với takedown đã commit —
  //    try/catch + captureError THẬT như suspendUserAction; lỗi notify KHÔNG
  //    biến takedown đã commit thành 500). Copy là PLACEHOLDER (FD-3) —
  //    takedown-notification wording là founder-authored content (Batch 8
  //    register). Link (Task 7): case gắn sanction → /appeal/<caseId> (case
  //    đã atomic actioned — S6 — subject appeal được); không case → /sell/my
  //    (seller xem tin của mình). Meta KHÔNG PII.
  try {
    await notify(
      sellerId,
      "listing",
      "Tin bị gỡ khỏi hiển thị", // PLACEHOLDER (FD-3) — Batch 8 register
      MODERATION_DECISION_REASON_LABELS[reasonParsed.data], // PROVISIONAL (A8)
      caseId !== null ? `/appeal/${caseId}` : "/sell/my",
    );
  } catch (notifyError) {
    captureError("moderation", notifyError, {
      action: "moderation.listing_taken_down_notify",
      subjectId: sellerId, // typed ref — KHÔNG PII (spec §4.8)
    });
  }

  revalidatePath("/admin/listings");
  revalidatePath("/listings");
  if (caseId !== null) revalidatePath(`/admin/moderation/${caseId}`);
}
