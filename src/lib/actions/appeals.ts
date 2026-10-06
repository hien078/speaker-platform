"use server";

import { db } from "@/src/prisma/db.client";
import { requireUser } from "@/src/lib/auth";
import { SqlQueryError, isUniqueConstraintViolation } from "@prisma/orm-family-sql/errors";
import {
  APPEAL_STATEMENT_MAX_LENGTH,
  getCaseSubjectUserId,
  type ReportTargetType,
} from "@/src/lib/moderation";

/**
 * Kháng cáo (Batch 3 plan Task 7 — spec §9 Batch 3 "appeal foundation" +
 * §5.5 state `appealed` + §7.3 IDOR + §4.11/A4 fail-closed).
 *
 * FOUNDATION ONLY: ghi nhận appeal + case → `appealed` + close bookkeeping
 * (Task 6 đã wire `appealed → closed` đóng Appeal row). Decision workflow —
 * ai xét, kết quả, thời hạn, re-appeal, restore listing `removed` (R5) —
 * là POLICY ngoài scope (Ambiguities A4, spec §4.11: KHÔNG phát minh).
 *
 * CHỦ TƯỢNG (S7 — Review Focus 3): subject resolved từ
 * ModerationEvidence.subjectUserId BẤT BIẾN (chụp tại report time — sống qua
 * edit/delete của source, spec §5.5.1); live lookup getCaseSubjectUserId chỉ
 * là fallback khi case không có evidence (không xảy ra qua submitReportAction
 * — fail closed thay vì crash). Non-subject nhận CÙNG error như case không
 * tồn tại (NOT_FOUND) — không existence oracle cho case của người khác.
 *
 * Global Constraints — transaction constraint-violation rule: violation
 * (SQLSTATE 23505) LUÔN throw ra khỏi callback (Postgres abort tx — catch bên
 * trong rồi return là silent-success bug: COMMIT thành ROLLBACK), classify
 * NGOÀI tx theo constraint name:
 *  - `Appeal_caseId_key` (@unique caseId — one-to-one, Task 1) → concurrent
 *    double-appeal → ALREADY_APPEALED (không retry — row của người thắng là
 *    row duy nhất được persist).
 *  - Error("CASE_ALREADY_MOVED") (claim 0 rows) → propagate — concurrent
 *    transition nghiêm trọng hơn một form message.
 *
 * KHÔNG AuditEvent — actor là user thường (Scope Decisions — AuditEvent dành
 * cho privileged actor, spec §4.6); Appeal + ModerationAction đã ghi
 * actor/action/timestamp. KHÔNG notify moderator tự động (workflow = A4).
 * KHÔNG telemetry (Batch 5 không wire sự kiện nào vào action này).
 */

export type AppealFormState = { error?: string; success?: string };

/**
 * PLACEHOLDER (FD-3): thông báo thành công — appeal-rights wording là
 * founder-authored content (Batch 8 Founder Decision Register); bản hiện tại
 * chỉ nêu mechanics (đã ghi nhận), KHÔNG phát minh quyền/hệ quả kháng cáo.
 */
const APPEAL_RECORDED_MESSAGE = "Đã ghi nhận kháng cáo của bạn.";

export async function recordAppealAction(
  _prev: AppealFormState,
  formData: FormData,
): Promise<AppealFormState> {
  // 1. Authorization (spec §5.5 reporter/subject authorization) — requireUser
  //    redirect khi chưa đăng nhập.
  const user = await requireUser();

  const caseId = String(formData.get("caseId") ?? "").trim();
  const statementRaw = String(formData.get("statement") ?? "");

  // 2. Case tồn tại → else NOT_FOUND (không tiết lộ gì thêm).
  const caseRow = await db.orm.public.ModerationCase.first({ id: caseId });
  if (caseRow === null) return { error: "NOT_FOUND" };

  // 3. CHỦ TƯỢNG (S7): evidence BẤT BIẾN trước, live fallback sau — null khi
  //    cả hai đường đều mất (fail closed). Non-subject → CÙNG NOT_FOUND như
  //    case không tồn tại (IDOR — Review Focus 3, không probe oracle).
  const evidence = await db.orm.public.ModerationEvidence
    .where({ caseId })
    .select("subjectUserId")
    .first();
  const subjectUserId =
    evidence?.subjectUserId ??
    (await getCaseSubjectUserId(caseRow.targetType as ReportTargetType, caseRow.targetId));
  if (user.id !== subjectUserId) return { error: "NOT_FOUND" };

  // 4. Chỉ appeal sau khi case được actioned — mọi quy tắc khác (thời hạn,
  //    re-appeal, appeal sau dismissed) = POLICY = A4, KHÔNG phát minh.
  if (caseRow.state !== "actioned") return { error: "APPEAL_NOT_AVAILABLE" };

  // 5. Statement cap — untrusted input, chặn ở action layer (form maxLength
  //    chỉ là convenience; forged form vượt cap fail closed với typed error).
  if (statementRaw.length > APPEAL_STATEMENT_MAX_LENGTH) {
    return { error: "STATEMENT_TOO_LONG" };
  }
  const statement = statementRaw.trim() || null;

  // 6. Pre-check nhanh: đã có Appeal cho case → ALREADY_APPEALED (concurrent
  //    double-appeal vẫn có thể vượt pre-check — bước 7 xử lý qua violation).
  const existing = await db.orm.public.Appeal.where({ caseId }).first();
  if (existing !== null) return { error: "ALREADY_APPEALED" };

  // 7. MỘT transaction (violation LUÔN throw ra khỏi callback — Global
  //    Constraints; KHÔNG BAO GIỜ catch-and-return trong callback).
  try {
    await db.transaction(async (tx) => {
      // a. Appeal — concurrent double-appeal → Appeal_caseId_key violation
      //    THROW ra khỏi callback (Postgres abort tx từ điểm này).
      await tx.orm.public.Appeal.create({
        caseId,
        appellantId: user.id,
        statement,
        state: "submitted",
      });

      // b. ATOMIC CLAIM (compare-and-set trên giá trị đã đọc "actioned"):
      //    case đổi tay giữa check và write (moderator transition concurrent —
      //    spec §10.1) → 0 rows → throw ra khỏi callback → tx rollback
      //    (kể cả Appeal vừa create) — KHÔNG silent-success.
      const claimed = await tx.orm.public.ModerationCase
        .where({ id: caseId, state: "actioned" })
        .updateAll({ state: "appealed" });
      if (claimed.length === 0) throw new Error("CASE_ALREADY_MOVED");

      // c. Case-scoped history (spec §5.5 — append-only) — actor là user
      //    thường; KHÔNG typed decision reason (workflow = A4), note null.
      await tx.orm.public.ModerationAction.create({
        caseId,
        actorId: user.id,
        actionType: "appeal.recorded",
        targetType: "moderation_case",
        targetId: caseId,
        reasonCode: null,
        note: null,
      });
    });
  } catch (e) {
    // 8. Classify NGOÀI tx (Global Constraints): SqlQueryError + sqlState
    //    "23505" + constraint name → typed user-facing error. Lỗi khác ném
    //    tiếp (CASE_ALREADY_MOVED propagate — fail closed, KHÔNG masquerade).
    if (isUniqueConstraintViolation(e)) {
      const constraint = (e as SqlQueryError).constraint ?? "";
      if (constraint === "Appeal_caseId_key") {
        // Concurrent double-appeal — row của người thắng là row duy nhất được
        // persist (tx của mình đã bị Postgres abort từ khi violation ném ra).
        return { error: "ALREADY_APPEALED" };
      }
    }
    throw e;
  }

  // 9. Thành công — KHÔNG auditEvent (Scope Decisions), KHÔNG notify moderator
  //    (decision workflow = A4), KHÔNG telemetry.
  return { success: APPEAL_RECORDED_MESSAGE };
}
