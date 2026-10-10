"use server";

import { db } from "@/src/prisma/db.client";
import { requireUser } from "@/src/lib/auth";
import { checkRateLimit } from "@/src/lib/rate-limit";
import { SqlQueryError, isUniqueConstraintViolation } from "@prisma/orm-family-sql/errors";
import type { JsonValue } from "@prisma/orm-postgres/target/codec-types";
import {
  ACTIVE_MODERATION_CASE_STATES,
  REPORT_NOTE_MAX_LENGTH,
  REPORT_RATE_LIMIT,
  REPORT_REASON_CODES,
  REPORT_TARGET_TYPES,
  type ReportReasonCode,
  type ReportTargetType,
} from "@/src/lib/moderation";
import { captureTargetSnapshot } from "@/src/lib/moderation-snapshot";
import { recordReportSubmitted } from "@/src/lib/telemetry-recorders";

/**
 * Báo cáo lạm dụng (Batch 3 Task 4 — spec §5.5 report + §5.5.1 evidence +
 * §7.1 report rate limit + §7.3 cross-account report access).
 *
 * Một submit = MỘT transaction: capture snapshot (BẤT BIẾN — spec §5.5.1) →
 * find-or-create case theo grouping key (targetType, targetId, reasonCategory)
 * trong các state active → AbuseReport → ModerationEvidence → ModerationAction
 * ("evidence.captured" — case-scoped history). Evidence KHÔNG bao giờ được
 * update/delete từ product flow (chỉ create ở đây).
 *
 * Global Constraints — transaction constraint-violation rule: violation
 * (SQLSTATE 23505) LUÔN throw ra khỏi callback (Postgres abort tx — catch bên
 * trong rồi return là silent-success bug: COMMIT thành ROLLBACK), classify
 * NGOÀI tx theo constraint name:
 *  - `moderation_case_one_active_per_target_reason` (partial unique index) →
 *    report cùng target+reason thắng trước → RETRY toàn bộ tx MỘT lần — re-read
 *    trong retry thấy case của người thắng; retry cũng violate → phân loại
 *    theo constraint (xem retryReportTxOnce).
 *  - `AbuseReport_caseId_reporterId_key` → double-submit của chính reporter →
 *    REPORT_ALREADY_SUBMITTED (không retry).
 *
 * Review fix (Task 4):
 *  - M1 (availability): captureTargetSnapshot chạy TRÊN tx.orm — query trên
 *    global client trong tx giữ 1 pool connection + chờ connection thứ hai
 *    → ~10 submit đồng thời deadlock pool (max 10) → snapshot module nhận
 *    orm client (tx.orm); caller ngoài tx dùng mặc định global.
 *  - L1: attach CÓ ĐIỀU KIỆN — case grouping bị ĐÓNG concurrent giữa re-read và
 *    AbuseReport.create (không lock giữa hai bước) → conditional no-op update
 *    (state ∈ active) trả 0 rows → sentinel throw → RETRY tx một lần → re-read
 *    thấy case đã đóng → tạo case active MỚI (report KHÔNG bao giờ attach vào
 *    case đã đóng).
 *  - L2: lỗi RETRY phân loại theo constraint name — AbuseReport_caseId_reporterId_key
 *    → REPORT_ALREADY_SUBMITTED (reporter thật sự đã trên case); race lặp lại
 *    (partial index lần hai) / case mới cũng bị đóng → REPORT_RETRY_FAILED
 *    (nothing persisted — KHÔNG masquerade thành ALREADY_SUBMITTED).
 *
 * KHÔNG AuditEvent — actor là user thường; AbuseReport + ModerationAction đã
 * ghi actor/action/reason/timestamp (Scope Decisions — AuditEvent dành cho
 * privileged actor, spec §4.6). Telemetry `report_submitted` (Batch 5 Task 8 —
 * S7) emit TẠI success point (bên dưới) qua telemetry-recorders — metadata
 * CHỈ targetType/reasonCode typed (corrections #6: KHÔNG targetId — PII khi
 * targetType="user"; đích listing đi cột listingId), KHÔNG note text.
 */

export type ReportFormState = { error?: string; success?: string };

/** Sentinel throw ra khỏi tx callback khi target biến mất giữa validate và tx. */
const TARGET_VANISHED = "REPORT_TARGET_VANISHED";

/**
 * Sentinel L1 (review fix Task 4): case grouping bị ĐÓNG concurrent giữa
 * re-read và attach — throw ra khỏi tx callback → classify NGOÀI → RETRY toàn
 * bộ tx MỘT lần (re-read trong retry thấy case đã đóng → tạo case active MỚI).
 */
const CASE_CLOSED_RACE = "REPORT_CASE_CLOSED_RACE";

/** Thông báo thành công — KHÔNG tiết lộ trạng thái case/định danh moderator. */
const REPORT_SUBMITTED_MESSAGE =
  "Đã gửi báo cáo đến đội kiểm duyệt — cảm ơn bạn đã giúp cộng đồng an toàn.";

/** Case grouping key — case active duy nhất per key (partial unique index Task 1). */
function activeCaseQuery(targetType: ReportTargetType, targetId: string, reasonCode: ReportReasonCode) {
  return db.orm.public.ModerationCase
    .where({ targetType, targetId, reasonCategory: reasonCode })
    .where((c) => c.state.in([...ACTIVE_MODERATION_CASE_STATES]));
}

export async function submitReportAction(
  _prev: ReportFormState,
  formData: FormData,
): Promise<ReportFormState> {
  // 1. Reporter authorization (spec §5.5) — requireUser redirect khi chưa đăng nhập.
  const user = await requireUser();

  const targetType = String(formData.get("targetType") ?? "");
  const targetId = String(formData.get("targetId") ?? "");
  const reasonCode = String(formData.get("reasonCode") ?? "");
  const noteRaw = String(formData.get("note") ?? "");

  // 2. Validate — typed form error, KHÔNG db write (reason codes là đúng CHÍN
  // category §5.5 verbatim — closed vocabulary, không free text). Sau check,
  // narrow sang literal union của contract (cast an toàn: đã qua membership).
  if (!(REPORT_TARGET_TYPES as readonly string[]).includes(targetType)) {
    return { error: "INVALID_TARGET_TYPE" };
  }
  if (!(REPORT_REASON_CODES as readonly string[]).includes(reasonCode)) {
    return { error: "INVALID_REASON_CODE" };
  }
  const target = targetType as ReportTargetType;
  const reason = reasonCode as ReportReasonCode;
  if (noteRaw.length > REPORT_NOTE_MAX_LENGTH) {
    return { error: "NOTE_TOO_LONG" };
  }
  const note = noteRaw.trim() || null;

  // 3. Rate limit 5 report / 10 phút / reporter (spec §7.1 "report") — TRƯỚC
  // mọi read/mutation (không dùng report để dò trạng thái DB).
  const limited = checkRateLimit(`report:${user.id}`, REPORT_RATE_LIMIT);
  if (!limited.allowed) return { error: "RATE_LIMITED" };

  // 4. Target authorization (spec §7.3 cross-account report access) — chỉ
  // exists/doesn't-exist cho target reporter VẪN THẤY được; không probe oracle.
  if (target === "listing") {
    const listing = await db.orm.public.Listing.first({ id: targetId });
    if (listing === null) return { error: "NOT_FOUND" };
    // tự báo cáo tin của mình → typed error (self-report = noise + self-suppression)
    if (listing.sellerId === user.id) return { error: "CANNOT_REPORT_SELF" };
  } else if (target === "user") {
    const targetUser = await db.orm.public.User.first({ id: targetId });
    if (targetUser === null) return { error: "NOT_FOUND" };
    if (targetUser.id === user.id) return { error: "CANNOT_REPORT_SELF" };
  } else {
    // target === "message" — reporter phải là participant của conversation
    // VÀ không phải sender của chính tin đó.
    const message = await db.orm.public.Message.first({ id: targetId });
    if (message === null) return { error: "NOT_FOUND" };
    const convo = await db.orm.public.Conversation.first({ id: message.conversationId });
    if (convo === null || (convo.buyerId !== user.id && convo.sellerId !== user.id)) {
      return { error: "NOT_FOUND" };
    }
    if (message.senderId === user.id) return { error: "CANNOT_REPORT_SELF" };
  }

  // 5. Dedupe CASE-FIRST (S3 — không quét AbuseReport mò): tìm case active
  // theo grouping key, rồi xem reporter này đã báo cáo case đó chưa.
  const activeCase = await activeCaseQuery(target, targetId, reason).first();
  if (activeCase !== null) {
    const already = await db.orm.public.AbuseReport
      .where({ caseId: activeCase.id, reporterId: user.id })
      .first();
    if (already !== null) return { error: "REPORT_ALREADY_SUBMITTED" };
  }

  // 6. MỘT transaction cho cả bốn row (xem header — Global Constraints:
  // violation LUÔN throw ra khỏi callback, KHÔNG BAO GIỜ catch-and-return).
  const runReportTx = (): Promise<void> =>
    db.transaction(async (tx) => {
      // a. Capture TRƯỚC khi tạo bất kỳ row nào — target biến mất giữa validate
      //    và tx → sentinel throw ra khỏi callback → classify ngoài → NOT_FOUND
      //    (fail closed; tx rollback — chưa có row nào được tạo).
      //    M1 (review fix): capture chạy TRÊN tx.orm — query trên global client
      //    trong tx giữ 1 pool connection + chờ connection thứ hai → deadlock
      //    pool (~10 submit đồng thời, max 10).
      const captured = await captureTargetSnapshot(target, targetId, tx.orm);
      if (captured === null) throw new Error(TARGET_VANISHED);

      // b. RE-READ case grouping TRONG tx — không tin read ở bước 5 (concurrent
      //    report cùng target+reason thắng trước → partial-index violation
      //    THROW ra khỏi callback, classify + retry NGOÀI tx).
      let caseId: string;
      const existingCase = await tx.orm.public.ModerationCase
        .where({ targetType: target, targetId, reasonCategory: reason })
        .where((c) => c.state.in([...ACTIVE_MODERATION_CASE_STATES]))
        .first();
      if (existingCase !== null) {
        caseId = existingCase.id;
      } else {
        const created = await tx.orm.public.ModerationCase.create({
          targetType: target,
          targetId,
          reasonCategory: reason,
          state: "open",
          priority: "normal",
        });
        caseId = created.id;
      }

      // c. Report — concurrent double-submit của chính reporter →
      //    @@unique([caseId, reporterId]) violation THROW ra khỏi callback.
      await tx.orm.public.AbuseReport.create({
        reporterId: user.id,
        targetType: target,
        targetId,
        reasonCode: reason,
        note,
        caseId,
      });

      // c2. L1 (review fix): attach CÓ ĐIỀU KIỆN — KHÔNG lock nào giữa re-read
      //     (bước b) và AbuseReport.create, moderator có thể transition case
      //     sang dismissed/closed NGAY giữa hai bước. Conditional no-op update
      //     khẳng định case VẪN active (row lock + recheck predicate của
      //     Postgres — như atomic claim): 0 rows → case đã bị đóng concurrent
      //     → sentinel throw ra khỏi callback → tx rollback (report chưa kịp
      //     attach đi đâu) → classify NGOÀI → RETRY (re-read thấy case đã
      //     đóng → tạo case active MỚI). Case do CHÍNH tx này vừa tạo luôn
      //     khớp (state open — không concurrent tx nào thấy được row chưa commit).
      const stillActive = await tx.orm.public.ModerationCase
        .where({ id: caseId })
        .where((c) => c.state.in([...ACTIVE_MODERATION_CASE_STATES]))
        .updateAll({ updatedAt: new Date().toISOString() });
      if (stillActive.length === 0) throw new Error(CASE_CLOSED_RACE);

      // d. Evidence — snapshot bất biến tại report time (spec §5.5.1); sống
      //    qua source edit/delete (SetNull FK — A3); KHÔNG bao giờ update/delete.
      //    (cast: CapturedSnapshot.snapshot khai báo Record<string, unknown> —
      //    module Task 2; runtime luôn là JSON value theo cấu trúc capture.)
      await tx.orm.public.ModerationEvidence.create({
        caseId,
        sourceResourceType: target,
        sourceResourceId: targetId,
        relevantSnapshot: captured.snapshot as JsonValue,
        subjectUserId: captured.subjectUserId,
        reporterUserId: user.id,
        classification: reason,
      });

      // e. Case-scoped history — actor là user thường (AuditEvent chỉ dành cho
      //    privileged actor — Scope Decisions; report.submitted KHÔNG phải AuditEvent).
      await tx.orm.public.ModerationAction.create({
        caseId,
        actorId: user.id,
        actionType: "evidence.captured",
        targetType: target,
        targetId,
        reasonCode: reason,
      });
    });

  /**
   * RETRY toàn bộ tx MỘT lần + classify lỗi retry (L2 — review fix): lỗi của
   * lần thử thứ hai KHÔNG masquerade thành REPORT_ALREADY_SUBMITTED —
   * phân loại theo constraint name:
   *  - `AbuseReport_caseId_reporterId_key` → reporter THẬT SỰ đã trên case
   *    (row của người thắng persist) → REPORT_ALREADY_SUBMITTED là đúng semantics.
   *  - Race lặp lại (partial index lần hai) / case mới cũng bị đóng concurrent
   *    → KHÔNG có gì của reporter persist → REPORT_RETRY_FAILED (thử lại) —
   *    báo ALREADY_SUBMITTED là SAI (misleading).
   */
  const retryReportTxOnce = async (): Promise<ReportFormState> => {
    try {
      await runReportTx();
      return { success: REPORT_SUBMITTED_MESSAGE };
    } catch (retry) {
      if (retry instanceof Error && retry.message === TARGET_VANISHED) {
        return { error: "NOT_FOUND" };
      }
      if (isUniqueConstraintViolation(retry)) {
        const retryConstraint = (retry as SqlQueryError).constraint ?? "";
        if (retryConstraint === "AbuseReport_caseId_reporterId_key") {
          return { error: "REPORT_ALREADY_SUBMITTED" };
        }
        // Partial-index violation lần HAI (creator khác lại thắng) — nothing
        // persisted → distinct typed error (L2), KHÔNG REPORT_ALREADY_SUBMITTED.
        return { error: "REPORT_RETRY_FAILED" };
      }
      if (retry instanceof Error && retry.message === CASE_CLOSED_RACE) {
        // Case MỚI cũng bị đóng concurrent — nothing persisted (L2).
        return { error: "REPORT_RETRY_FAILED" };
      }
      throw retry;
    }
  };

  // 6b. HAI success path gộp về MỘT biến outcome (corrections #7 — compute
  //     result once, emit once): path chính + path retry của retryReportTxOnce.
  let outcome: ReportFormState;
  try {
    await runReportTx();
    outcome = { success: REPORT_SUBMITTED_MESSAGE };
  } catch (e) {
    // Capture fail-closed sentinel — tx đã rollback, chưa row nào được viết.
    if (e instanceof Error && e.message === TARGET_VANISHED) {
      return { error: "NOT_FOUND" };
    }

    // L1 (review fix): case bị đóng concurrent giữa re-read và attach →
    // retry (re-read trong retry thấy case đã đóng → tạo case active mới).
    if (e instanceof Error && e.message === CASE_CLOSED_RACE) {
      outcome = await retryReportTxOnce();
    } else if (isUniqueConstraintViolation(e)) {
      // 7. Classify constraint violations NGOÀI tx (sqlState 23505 + constraint
      //    name — Global Constraints; tx đã bị Postgres abort từ khi violation
      //    ném ra, KHÔNG có savepoint trong Prisma 8 tx context).
      const constraint = (e as SqlQueryError).constraint ?? "";
      if (constraint.startsWith("moderation_case_one_active_per_target_reason")) {
        // Concurrent report cùng (target, reason) thắng case create — RETRY
        // toàn bộ tx MỘT lần: re-read trong retry thấy case của người thắng.
        outcome = await retryReportTxOnce();
      } else if (constraint === "AbuseReport_caseId_reporterId_key") {
        // Concurrent double-submit của chính reporter — tx abort; row của người
        // thắng là row duy nhất được persist (không retry).
        return { error: "REPORT_ALREADY_SUBMITTED" };
      } else {
        throw e;
      }
    } else {
      // Lỗi DB/infra khác — rethrow (server action error 500, observability bắt).
      throw e;
    }
  }

  // 8. Thành công (chính hoặc qua retry — HAI success path đã gộp về MỘT biến
  //    outcome, corrections #7: compute result once, emit once). KHÔNG tiết lộ
  //    trạng thái case/định danh moderator cho reporter; KHÔNG auditEvent
  //    (Scope Decisions). Telemetry (Batch 5 Task 8 — S7): report_submitted với
  //    targetType/reasonCode TYPED (KHÔNG note text; corrections #6: KHÔNG
  //    targetId trong metadata — đích listing đi cột listingId). Recorder
  //    fail-open — KHÔNG đổi kết quả action.
  if (outcome.success) {
    await recordReportSubmitted({
      reporterId: user.id,
      sessionId: user.sessionId,
      targetType: target,
      targetId,
      reasonCode: reason,
    });
  }
  return outcome;
}
