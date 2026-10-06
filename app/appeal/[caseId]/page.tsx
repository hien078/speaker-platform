import { notFound } from "next/navigation";
import { db } from "@/src/prisma/db.client";
import { requireUser } from "@/src/lib/auth";
import { getCaseSubjectUserId } from "@/src/lib/moderation";
import type { ReportTargetType } from "@/src/lib/moderation-vocab";
import { AppealForm } from "@/src/components/appeal-form";
import { cn, formatDate } from "@/src/lib/utils";
import {
  MODERATION_CASE_STATE_LABELS,
  MODERATION_DECISION_REASON_LABELS,
  REPORT_REASON_LABELS,
  SUSPENSION_REASON_LABELS,
} from "@/src/lib/constants";
import { Scale } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Kháng cáo quyết định kiểm duyệt" };

/**
 * Trang kháng cáo cho subject của case (Batch 3 Task 7 — spec §9 Batch 3
 * "appeal foundation" + §5.5.1 evidence + §7.3 IDOR).
 *
 * IDOR (Review Focus 3 — cùng fail-closed posture như recordAppealAction):
 * subject resolved từ ModerationEvidence.subjectUserId BẤT BIẾN (chụp tại
 * report time — sống qua edit/delete của source, S7), fallback live
 * getCaseSubjectUserId; KHÔNG phải subject → notFound() — CÙNG hiển thị như
 * case không tồn tại (không existence oracle). Trang render CHO SUBJECT
 * DUY NHẤT: KHÔNG reporter identities, KHÔNG moderator identities (spec
 * §4.8 tinh thần — subject thấy context case của chính mình).
 *
 * PLACEHOLDER (FD-3): TOÀN BỘ copy hiển thị trên trang này là placeholder rõ
 * ràng — appeal-rights wording là founder-authored content (Batch 8 Founder
 * Decision Register). Bản hiện tại chỉ nêu MECHANICS (lý do case, biện pháp
 * đã áp dụng, cách gửi lời trình bày); KHÔNG phát minh quyền kháng cáo, thời
 * hạn, hay hệ quả (decision workflow = Ambiguities A4 — KHÔNG xây ở đây).
 *
 * Nội dung untrusted (statement của chính subject) render React text —
 * KHÔNG render HTML thô (spec §7.4 stored XSS).
 */
const CASE_STATE_BADGE: Record<string, string> = {
  open: "bg-amber-500/15 text-amber-400",
  triaged: "bg-sky-500/15 text-sky-400",
  investigating: "bg-violet-500/15 text-violet-400",
  actioned: "bg-emerald-500/15 text-emerald-400",
  dismissed: "bg-zinc-700/60 text-zinc-300",
  appealed: "bg-red-500/15 text-red-400",
  closed: "bg-zinc-700/60 text-zinc-300",
};

/** PROVISIONAL (A8/FD-3) — nhãn trạng thái appeal (mechanics, không policy). */
const APPEAL_STATE_LABELS: Record<string, string> = {
  submitted: "Đã gửi",
  closed: "Đã đóng",
};

export default async function AppealPage({
  params,
}: PageProps<"/appeal/[caseId]">) {
  // Authorization (spec §4.5): requireUser redirect /login khi chưa đăng nhập.
  const user = await requireUser();
  const { caseId } = await params;

  const caseRow = await db.orm.public.ModerationCase.first({ id: caseId });
  if (caseRow === null) notFound();

  // Subject (S7) — evidence BẤT BIẾN trước, live fallback sau; không phải
  // subject (hoặc cả hai đường đều mất) → notFound() — cùng posture như action.
  const evidence = await db.orm.public.ModerationEvidence
    .where({ caseId })
    .orderBy((e) => e.capturedAt.asc())
    .first();
  const subjectUserId =
    evidence?.subjectUserId ??
    (await getCaseSubjectUserId(caseRow.targetType as ReportTargetType, caseRow.targetId));
  if (subjectUserId === null || subjectUserId !== user.id) notFound();

  // Appeal hiện có (một / case — @unique caseId) + sanction context: hành động
  // user.suspended / listing.taken_down MỚI NHẤT trên case này (reason label).
  const [existingAppeal, sanctionActions] = await Promise.all([
    db.orm.public.Appeal.where({ caseId }).first(),
    db.orm.public.ModerationAction
      .where({ caseId })
      .where((a) => a.actionType.in(["user.suspended", "listing.taken_down"]))
      .orderBy((a) => a.createdAt.desc())
      .all(),
  ]);
  const latestSanction = sanctionActions[0] ?? null;
  const sanctionLabel =
    latestSanction === null
      ? null
      : latestSanction.actionType === "user.suspended"
        ? SUSPENSION_REASON_LABELS[latestSanction.reasonCode as keyof typeof SUSPENSION_REASON_LABELS] ??
          latestSanction.reasonCode
        : MODERATION_DECISION_REASON_LABELS[
            latestSanction.reasonCode as keyof typeof MODERATION_DECISION_REASON_LABELS
          ] ?? latestSanction.reasonCode;

  const canAppeal = caseRow.state === "actioned" && existingAppeal === null;

  return (
    <main className="mx-auto max-w-2xl px-4 py-10 lg:px-8">
      <h1 className="flex items-center gap-2.5 text-2xl font-extrabold tracking-tight">
        <Scale className="size-6 text-[var(--accent)]" />
        Kháng cáo quyết định kiểm duyệt
      </h1>

      {/* ─── Tổng quan case (context của CHÍNH subject — không ai khác) ─── */}
      <div className="card mt-6 p-5">
        <h2 className="text-sm font-bold uppercase tracking-wider text-[var(--muted)]">
          Hồ sơ case của bạn
        </h2>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className={cn("badge", CASE_STATE_BADGE[caseRow.state] ?? "")}>
            {MODERATION_CASE_STATE_LABELS[caseRow.state as keyof typeof MODERATION_CASE_STATE_LABELS] ??
              caseRow.state}
          </span>
          <span className="badge bg-[var(--accent-soft)] text-[var(--accent)]">
            {REPORT_REASON_LABELS[caseRow.reasonCategory as keyof typeof REPORT_REASON_LABELS] ??
              caseRow.reasonCategory}
          </span>
        </div>
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-[var(--muted)]">Ngày mở case</dt>
            <dd className="mt-0.5 text-xs">{formatDate(caseRow.createdAt)}</dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--muted)]">Biện pháp đã áp dụng</dt>
            {/* PLACEHOLDER (FD-3) — sanction label PROVISIONAL (A8) */}
            <dd className="mt-0.5 text-xs">{sanctionLabel ?? "Chưa có biện pháp nào"}</dd>
          </div>
        </dl>
      </div>

      {/* ─── Form / trạng thái kháng cáo ─── */}
      <div className="card mt-5 p-5">
        {canAppeal ? (
          <>
            <h2 className="text-sm font-bold uppercase tracking-wider text-[var(--muted)]">
              Gửi kháng cáo
            </h2>
            {/* PLACEHOLDER (FD-3): chỉ nêu mechanics gửi lời trình bày — quyền
                kháng cáo/thời hạn/hệ quả là founder-authored (Batch 8 register). */}
            <p className="mt-1 text-xs text-[var(--muted)]">
              Bạn có thể gửi lời trình bày để đội kiểm duyệt xem lại quyết định
              của case này.
            </p>
            <div className="mt-4">
              <AppealForm caseId={caseId} />
            </div>
          </>
        ) : existingAppeal !== null ? (
          <>
            <h2 className="text-sm font-bold uppercase tracking-wider text-[var(--muted)]">
              Kháng cáo của bạn
            </h2>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
              <span
                className={cn(
                  "badge",
                  existingAppeal.state === "submitted"
                    ? "bg-emerald-500/15 text-emerald-400"
                    : "bg-zinc-700/60 text-zinc-300",
                )}
              >
                {APPEAL_STATE_LABELS[existingAppeal.state] ?? existingAppeal.state}
              </span>
              <span className="text-xs text-[var(--muted)]">
                Gửi {formatDate(existingAppeal.createdAt)}
                {existingAppeal.closedAt !== null
                  ? ` · đóng ${formatDate(existingAppeal.closedAt)}`
                  : ""}
              </span>
            </div>
            {existingAppeal.statement !== null && (
              // Statement của CHÍNH subject — React text (spec §7.4)
              <p className="mt-3 whitespace-pre-wrap rounded-lg border border-[var(--line)] bg-[var(--paper)]/40 p-3 text-sm">
                {existingAppeal.statement}
              </p>
            )}
          </>
        ) : (
          // Mechanics note — nêu lại rule của action (APPEAL_NOT_AVAILABLE),
          // KHÔNG phát minh policy (A4).
          <>
            <h2 className="text-sm font-bold uppercase tracking-wider text-[var(--muted)]">
              Gửi kháng cáo
            </h2>
            <p className="mt-3 text-sm text-[var(--muted)]">
              Kháng cáo chỉ khả dụng khi case đã được xử lý. Case của bạn hiện
              ở trạng thái{" "}
              <span className="font-semibold text-[var(--ink-2)]">
                {MODERATION_CASE_STATE_LABELS[
                  caseRow.state as keyof typeof MODERATION_CASE_STATE_LABELS
                ] ?? caseRow.state}
              </span>
              .
            </p>
          </>
        )}
      </div>
    </main>
  );
}
