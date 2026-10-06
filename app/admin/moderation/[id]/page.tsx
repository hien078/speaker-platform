import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/src/prisma/db.client";
import { requireCapability, capabilitiesOf } from "@/src/lib/rbac";
import { auditEvent } from "@/src/lib/audit-event";
import { getCaseSubjectUserId, getActiveSuspension } from "@/src/lib/moderation";
import {
  MODERATION_ASSIGNMENT_REASON_CODES,
  MODERATION_DECISION_REASON_CODES,
  MODERATION_PRIORITIES,
  MODERATION_TRANSITIONS,
  SUSPENSION_NOTE_MAX_LENGTH,
  SUSPENSION_REASON_CODES,
  type ModerationCaseState,
} from "@/src/lib/moderation-vocab";
import {
  MODERATION_ACTION_TYPE_LABELS,
  MODERATION_ASSIGNMENT_REASON_LABELS,
  MODERATION_CASE_STATE_LABELS,
  MODERATION_DECISION_REASON_LABELS,
  MODERATION_PRIORITY_LABELS,
  REPORT_REASON_LABELS,
  SUSPENSION_REASON_LABELS,
  LISTING_STATUS_LABELS,
} from "@/src/lib/constants";
import {
  assignModerationCaseAction,
  transitionModerationCaseAction,
  takeDownListingAction,
  suspendUserAction,
  liftSuspensionAction,
} from "@/src/lib/actions/moderation";
import { cn, formatDate } from "@/src/lib/utils";
import {
  Flag,
  Gavel,
  Trash2,
  Ban,
  ShieldCheck,
  History,
} from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Quản trị — Case kiểm duyệt" };

/**
 * Case detail (Batch 3 Task 6 — spec §5.5/§5.5.1 + §4.5/§4.8 + §5.4.1).
 * Guard server-side (spec §4.5): report.resolve (super/ops/moderator — ô ✓;
 * analyst/support fail closed A1). MỌI lần xem evidence được audit riêng
 * (moderation.evidence_viewed — spec §5.5.1 "separately audited") TRƯỚC khi
 * render — lỗi audit → trang lỗi, bằng chứng KHÔNG render khi không ghi được vết.
 *
 * PII minimization (spec §4.8 tinh thần + A1 fail closed): moderator KHÔNG giữ
 * user.view_basic — mọi projection User chỉ mang id/name; thông tin danh tính
 * thô KHÔNG được select/render ở trang này. Nội dung untrusted (note reporter,
 * body tin nhắn, mô tả tin) render React text — KHÔNG bao giờ HTML thô.
 *
 * Form suspend/lift chỉ render khi viewer có user.suspend (super/ops) — UI
 * CONVENIENCE; action tự requireCapability/requireCapabilityWithStepUp.
 */

const STATE_BADGE: Record<ModerationCaseState, string> = {
  open: "bg-amber-500/15 text-amber-400",
  triaged: "bg-sky-500/15 text-sky-400",
  investigating: "bg-violet-500/15 text-violet-400",
  actioned: "bg-emerald-500/15 text-emerald-400",
  dismissed: "bg-zinc-700/60 text-zinc-300",
  appealed: "bg-red-500/15 text-red-400",
  closed: "bg-zinc-700/60 text-zinc-300",
};

const PRIORITY_BADGE: Record<string, string> = {
  low: "bg-zinc-700/60 text-zinc-300",
  normal: "bg-[var(--paper-deep)] text-[var(--ink-2)]",
  high: "bg-red-500/15 text-red-400",
};

const TARGET_TYPE_LABELS: Record<string, string> = {
  listing: "Tin đăng",
  user: "Người dùng",
  message: "Tin nhắn",
};

/** Các status listing mà takedown (R4) còn claim được — khớp action. */
const TAKEDOWN_ELIGIBLE_STATUSES = ["approved", "hidden", "pending"];

export default async function AdminModerationCasePage({
  params,
}: PageProps<"/admin/moderation/[id]">) {
  // Guard server-side (spec §4.5) — TRƯỚC mọi db read (Review Focus 3).
  const ctx = await requireCapability("report.resolve");
  const { id } = await params;

  const caseRow = await db.orm.public.ModerationCase.first({ id });
  if (caseRow === null) notFound();

  const [reports, evidence, actions] = await Promise.all([
    db.orm.public.AbuseReport
      .where({ caseId: id })
      .include("reporter", (r) => r.select("id", "name"))
      .orderBy((r) => r.createdAt.desc())
      .all(),
    db.orm.public.ModerationEvidence
      .where({ caseId: id })
      .orderBy((e) => e.capturedAt.asc())
      .all(),
    db.orm.public.ModerationAction
      .where({ caseId: id })
      .include("actor", (a) => a.select("id", "name"))
      .orderBy((a) => a.createdAt.desc())
      .all(),
  ]);

  // Subject (người bị báo cáo) — ưu tiên ModerationEvidence.subjectUserId BẤT
  // BIẾN (chụp tại report time, sống qua edit/delete của source — S7), fallback
  // live lookup. Dùng cho: form suspend (SHOULD-FIX 2 — mọi target type), lịch
  // sử subject, conflict hiển thị.
  const subjectUserId =
    evidence[0]?.subjectUserId ??
    (await getCaseSubjectUserId(caseRow.targetType, caseRow.targetId));

  // Audit MỌI lần xem bằng chứng (spec §5.5.1) — TRƯỚC khi render section
  // Evidence bên dưới (mỗi render = một vết xem).
  await auditEvent({
    actorId: ctx.user.id,
    action: "moderation.evidence_viewed",
    resourceType: "moderation_case",
    resourceId: id,
    sessionId: ctx.session.id,
  });

  // Subject-scoped history (spec §5.5) — hành động moderation trước đây trên
  // chính subject này (kể cả case khác).
  const subjectHistory =
    subjectUserId !== null
      ? await db.orm.public.ModerationAction
          .where({ targetType: "user", targetId: subjectUserId })
          .orderBy((a) => a.createdAt.desc())
          .limit(20)
          .all()
      : [];

  // Assign form: moderator đủ eligibility = role có report.resolve (ô ✓ —
  // analyst/support KHÔNG xuất hiện trong select; action tự check lại).
  const eligibleModerators = await db.orm.public.User
    .where((u) => u.adminRole.in(["super_admin", "operations_admin", "moderator"]))
    .select("id", "name")
    .orderBy((u) => u.name.asc())
    .all();

  // Takedown chỉ áp dụng lên đích listing còn trong trạng thái claim được (R4).
  const targetListing =
    caseRow.targetType === "listing"
      ? await db.orm.public.Listing
          .select("id", "status", "title")
          .first({ id: caseRow.targetId })
      : null;
  const takedownEligible =
    targetListing !== null && TAKEDOWN_ELIGIBLE_STATUSES.includes(targetListing.status);

  // UI convenience (spec §4.5): form suspend/lift chỉ render khi viewer có
  // user.suspend (super/ops); link /admin/users chỉ khi có user.view_basic —
  // action/đích tự guard.
  const canSuspend = capabilitiesOf(ctx.user.adminRole).includes("user.suspend");
  const canViewBasic = capabilitiesOf(ctx.user.adminRole).includes("user.view_basic");
  const activeSuspension =
    canSuspend && subjectUserId !== null ? await getActiveSuspension(subjectUserId) : null;

  const legalNextStates = MODERATION_TRANSITIONS[caseRow.state];

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2.5">
        <Link href="/admin/moderation" className="btn-secondary h-8 px-3 text-xs">
          ← Hàng đợi
        </Link>
        <h1 className="flex items-center gap-2.5 text-2xl font-extrabold tracking-tight">
          <Flag className="size-6 text-[var(--accent)]" />
          Case <span className="font-mono text-base text-[var(--muted)]">#{id.slice(0, 8)}</span>
        </h1>
      </div>

      {/* ─── Tổng quan ─── */}
      <div className="card mt-5 p-5">
        <h2 className="text-sm font-bold uppercase tracking-wider text-[var(--muted)]">Tổng quan</h2>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className={cn("badge", STATE_BADGE[caseRow.state])}>
            {MODERATION_CASE_STATE_LABELS[caseRow.state]}
          </span>
          <span className={cn("badge", PRIORITY_BADGE[caseRow.priority])}>
            Ưu tiên: {MODERATION_PRIORITY_LABELS[caseRow.priority]}
          </span>
          <span className="badge bg-[var(--accent-soft)] text-[var(--accent)]">
            {REPORT_REASON_LABELS[caseRow.reasonCategory] ?? caseRow.reasonCategory}
          </span>
        </div>
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-[var(--muted)]">Đích báo cáo</dt>
            <dd className="mt-0.5">
              {TARGET_TYPE_LABELS[caseRow.targetType] ?? caseRow.targetType}{" "}
              <span className="font-mono text-xs text-[var(--muted)]">#{caseRow.targetId.slice(0, 8)}</span>
              {caseRow.targetType === "listing" && (
                <Link href="/admin/listings?tab=all" className="ml-2 text-xs text-[var(--accent)] hover:underline">
                  Xem trong hàng duyệt tin →
                </Link>
              )}
              {caseRow.targetType === "user" && canViewBasic && (
                <Link href="/admin/users" className="ml-2 text-xs text-[var(--accent)] hover:underline">
                  Hồ sơ người dùng →
                </Link>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--muted)]">Người bị báo cáo (subject)</dt>
            <dd className="mt-0.5 font-mono text-xs">
              {subjectUserId ?? "—"}
              {activeSuspension && (
                <span className="badge ml-2 bg-[var(--red-soft)] text-[var(--red)]">Đang bị đình chỉ</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--muted)]">Người xử lý</dt>
            <dd className="mt-0.5">
              {caseRow.assignedModeratorId
                ? eligibleModerators.find((m) => m.id === caseRow.assignedModeratorId)?.name ??
                  caseRow.assignedModeratorId
                : "Chưa gán"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--muted)]">Tạo / cập nhật</dt>
            <dd className="mt-0.5 text-xs text-[var(--muted)]">
              {formatDate(caseRow.createdAt)} · {formatDate(caseRow.updatedAt)}
            </dd>
          </div>
        </dl>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        {/* ─── Evidence (spec §5.5.1 — snapshot bất biến tại report time) ─── */}
        <div className="card p-5">
          <h2 className="text-sm font-bold uppercase tracking-wider text-[var(--muted)]">Evidence</h2>
          <p className="mt-1 text-xs text-[var(--muted)]">
            Snapshot bất biến tại thời điểm báo cáo — sống qua chỉnh sửa/xóa của nguồn.
          </p>
          <div className="mt-3 space-y-3">
            {evidence.length === 0 && (
              <p className="text-sm text-[var(--muted)]">Case không có bằng chứng.</p>
            )}
            {evidence.map((ev) => {
              const snap = (ev.relevantSnapshot ?? {}) as Record<string, unknown>;
              const kind = String(snap["kind"] ?? ev.sourceResourceType);
              return (
                <div key={ev.id} className="rounded-lg border border-[var(--line)] bg-[var(--paper)]/40 p-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
                    <span className="badge bg-[var(--paper-deep)] text-[var(--ink-2)]">{kind}</span>
                    <span>chụp {formatDate(ev.capturedAt)}</span>
                    <span>· phân loại: {(REPORT_REASON_LABELS as Record<string, string>)[ev.classification] ?? ev.classification}</span>
                    <span>· reporter <span className="font-mono">{ev.reporterUserId ?? "—"}</span></span>
                  </div>
                  {/* Nội dung snapshot — React text only (spec §10.1 stored XSS) */}
                  {kind === "listing" && (
                    <div className="mt-2 space-y-0.5 text-sm">
                      <p className="font-semibold">{String(snap["title"] ?? "—")}</p>
                      <p className="text-xs text-[var(--muted)]">{String(snap["description"] ?? "")}</p>
                      <p className="text-xs">
                        Giá: {String(snap["price"] ?? "—")}₫ · Tình trạng: {String(snap["condition"] ?? "—")} · Khu vực: {String(snap["city"] ?? "—")}
                      </p>
                    </div>
                  )}
                  {kind === "user" && (
                    <div className="mt-2 space-y-0.5 text-sm">
                      <p className="font-semibold">{String(snap["name"] ?? "—")}</p>
                      <p className="text-xs text-[var(--muted)]">{String(snap["bio"] ?? "")}</p>
                      <p className="text-xs">Khu vực: {String(snap["city"] ?? "—")}</p>
                    </div>
                  )}
                  {kind === "message" && (
                    <div className="mt-2 space-y-0.5 text-sm">
                      <p className="whitespace-pre-wrap rounded bg-[var(--paper-deep)]/60 p-2 text-xs">
                        {String(snap["body"] ?? "—")}
                      </p>
                      <p className="text-xs text-[var(--muted)]">
                        Trong hội thoại <span className="font-mono">{String(snap["conversationId"] ?? "—")}</span>
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* ─── Báo cáo ─── */}
        <div className="card p-5">
          <h2 className="text-sm font-bold uppercase tracking-wider text-[var(--muted)]">Báo cáo</h2>
          <div className="mt-3 space-y-3">
            {reports.length === 0 && (
              <p className="text-sm text-[var(--muted)]">Không có báo cáo nào.</p>
            )}
            {reports.map((r) => (
              <div key={r.id} className="rounded-lg border border-[var(--line)] bg-[var(--paper)]/40 p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
                  <span className="font-semibold text-[var(--ink-2)]">
                    {r.reporter ? r.reporter.name : "(đã xóa)"}
                  </span>
                  <span className="font-mono">{r.reporterId ?? "—"}</span>
                  <span>· {REPORT_REASON_LABELS[r.reasonCode] ?? r.reasonCode}</span>
                  <span>· {formatDate(r.createdAt)}</span>
                </div>
                {r.note && (
                  // Note của reporter — UNTRUSTED, render React text (spec §10.1)
                  <p className="mt-1.5 whitespace-pre-wrap text-xs text-[var(--ink-2)]">{r.note}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ─── Hành động (case-scoped history — append-only) ─── */}
      <div className="card mt-5 p-5">
        <h2 className="flex items-center gap-1.5 text-sm font-bold uppercase tracking-wider text-[var(--muted)]">
          <History className="size-3.5" />
          Hành động trên case
        </h2>
        <div className="table-wrap mt-3">
          <table className="table-base">
            <thead>
              <tr>
                <th>Hành động</th>
                <th>Người thực hiện</th>
                <th>Lý do</th>
                <th>Ghi chú</th>
                <th>Thời điểm</th>
              </tr>
            </thead>
            <tbody>
              {actions.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-sm text-[var(--muted)]">Chưa có</td>
                </tr>
              ) : (
                actions.map((a) => (
                  <tr key={a.id}>
                    <td className="text-sm">{MODERATION_ACTION_TYPE_LABELS[a.actionType as keyof typeof MODERATION_ACTION_TYPE_LABELS] ?? a.actionType}</td>
                    <td className="text-sm">
                      {a.actor ? a.actor.name : <span className="font-mono text-xs">{a.actorId ?? "system"}</span>}
                    </td>
                    <td className="text-xs">
                      {a.reasonCode
                        ? MODERATION_DECISION_REASON_LABELS[a.reasonCode as keyof typeof MODERATION_DECISION_REASON_LABELS] ??
                          SUSPENSION_REASON_LABELS[a.reasonCode as keyof typeof SUSPENSION_REASON_LABELS] ??
                          a.reasonCode
                        : "—"}
                    </td>
                    <td className="max-w-64 text-xs text-[var(--muted)]">{a.note ?? "—"}</td>
                    <td className="whitespace-nowrap text-xs text-[var(--muted)]">{formatDate(a.createdAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {subjectHistory.length > 0 && (
          <p className="mt-3 text-xs text-[var(--muted)]">
            Subject còn có {subjectHistory.length} hành động moderation khác (toàn bộ lịch sử
            theo subject, kể cả case khác).
          </p>
        )}
      </div>

      {/* ─── Forms — action tự guard, form chỉ là CONVENIENCE (spec §4.5) ─── */}
      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        {/* Phân công */}
        <div className="card p-5">
          <h2 className="flex items-center gap-1.5 text-sm font-bold uppercase tracking-wider text-[var(--muted)]">
            <Gavel className="size-3.5" />
            Phân công case
          </h2>
          <form action={assignModerationCaseAction} className="mt-3 flex flex-col gap-2">
            <input type="hidden" name="caseId" value={id} />
            <select name="moderatorId" required className="input text-sm" aria-label="Người xử lý">
              {eligibleModerators.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
            <select name="reasonCode" required className="input text-sm" aria-label="Lý do phân công">
              {MODERATION_ASSIGNMENT_REASON_CODES.map((code) => (
                <option key={code} value={code}>{MODERATION_ASSIGNMENT_REASON_LABELS[code]}</option>
              ))}
            </select>
            <button type="submit" className="btn-primary px-4 text-sm">Phân công</button>
          </form>
        </div>

        {/* Chuyển trạng thái */}
        <div className="card p-5">
          <h2 className="text-sm font-bold uppercase tracking-wider text-[var(--muted)]">Chuyển trạng thái</h2>
          {legalNextStates.length === 0 ? (
            <p className="mt-3 text-sm text-[var(--muted)]">
              Case đã đóng (terminal) — không có chuyển trạng thái hợp lệ.
            </p>
          ) : (
            <form action={transitionModerationCaseAction} className="mt-3 flex flex-col gap-2">
              <input type="hidden" name="caseId" value={id} />
              <select name="toState" required className="input text-sm" aria-label="Trạng thái mới">
                {legalNextStates.map((s) => (
                  <option key={s} value={s}>{MODERATION_CASE_STATE_LABELS[s]}</option>
                ))}
              </select>
              <select name="reasonCode" required className="input text-sm" aria-label="Lý do quyết định">
                {MODERATION_DECISION_REASON_CODES.map((code) => (
                  <option key={code} value={code}>{MODERATION_DECISION_REASON_LABELS[code]}</option>
                ))}
              </select>
              <select name="priority" className="input text-sm" aria-label="Ưu tiên (tuỳ chọn)">
                <option value="">Ưu tiên: giữ nguyên</option>
                {MODERATION_PRIORITIES.map((p) => (
                  <option key={p} value={p}>{MODERATION_PRIORITY_LABELS[p]}</option>
                ))}
              </select>
              <input
                name="note"
                className="input text-sm"
                placeholder="Ghi chú (tuỳ chọn — đã redact PII)"
                maxLength={2000}
              />
              <button type="submit" className="btn-primary px-4 text-sm">Chuyển trạng thái</button>
            </form>
          )}
        </div>

        {/* Takedown (R4) — chỉ khi đích là listing còn claim được */}
        {takedownEligible && targetListing && (
          <div className="card border-[var(--red)]/40 p-5">
            <h2 className="flex items-center gap-1.5 text-sm font-bold uppercase tracking-wider text-[var(--red)]">
              <Trash2 className="size-3.5" />
              Gỡ tin đăng (kiểm duyệt)
            </h2>
            <p className="mt-1 text-xs text-[var(--muted)]">
              «{targetListing.title}» (hiện trạng thái: {LISTING_STATUS_LABELS[targetListing.status] ?? targetListing.status}) →
              gỡ khỏi hiển thị, khóa seller-side. Lý do ghi có kiểu vào lịch sử case.
            </p>
            <form action={takeDownListingAction} className="mt-3 flex flex-col gap-2">
              <input type="hidden" name="listingId" value={targetListing.id} />
              <input type="hidden" name="caseId" value={id} />
              <select name="reasonCode" required className="input text-sm" aria-label="Lý do gỡ tin">
                {MODERATION_DECISION_REASON_CODES.map((code) => (
                  <option key={code} value={code}>{MODERATION_DECISION_REASON_LABELS[code]}</option>
                ))}
              </select>
              <input
                name="note"
                className="input text-sm"
                placeholder="Ghi chú (tuỳ chọn — đã redact PII)"
                maxLength={2000}
              />
              <button type="submit" className="btn h-10 bg-[var(--red)] px-4 text-sm text-white hover:opacity-90">
                Gỡ tin khỏi hiển thị
              </button>
            </form>
          </div>
        )}

        {/* Suspend subject — chỉ render khi viewer có user.suspend (super/ops) */}
        {canSuspend && subjectUserId !== null && !activeSuspension && (
          <div className="card border-[var(--red)]/40 p-5">
            <h2 className="flex items-center gap-1.5 text-sm font-bold uppercase tracking-wider text-[var(--red)]">
              <Ban className="size-3.5" />
              Đình chỉ subject
            </h2>
            <p className="mt-1 text-xs text-[var(--muted)]">
              Đình chỉ <span className="font-mono">{subjectUserId}</span> — chặn publication + chat
              (spec §7.8). Đòi step-up (mã TOTP) — hành động phá hủy tài khoản (§5.4.2).
            </p>
            <form action={suspendUserAction} className="mt-3 flex flex-col gap-2">
              <input type="hidden" name="userId" value={subjectUserId} />
              <input type="hidden" name="caseId" value={id} />
              <select name="reasonCode" required className="input text-sm" aria-label="Lý do đình chỉ">
                {SUSPENSION_REASON_CODES.map((code) => (
                  <option key={code} value={code}>{SUSPENSION_REASON_LABELS[code]}</option>
                ))}
              </select>
              <input
                name="note"
                className="input text-sm"
                placeholder="Ghi chú (tuỳ chọn — đã redact PII)"
                maxLength={SUSPENSION_NOTE_MAX_LENGTH}
              />
              <input
                name="totpCode"
                className="input text-sm"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="Mã TOTP (step-up)"
              />
              <button type="submit" className="btn h-10 bg-[var(--red)] px-4 text-sm text-white hover:opacity-90">
                Đình chỉ
              </button>
            </form>
          </div>
        )}

        {/* Lift suspension — cùng capability gate, KHÔNG step-up (hướng khôi phục) */}
        {canSuspend && activeSuspension && (
          <div className="card p-5">
            <h2 className="flex items-center gap-1.5 text-sm font-bold uppercase tracking-wider text-[var(--muted)]">
              <ShieldCheck className="size-3.5" />
              Gỡ đình chỉ subject
            </h2>
            <p className="mt-1 text-xs text-[var(--muted)]">
              Subject đang bị đình chỉ từ {formatDate(activeSuspension.suspendedAt)} — gỡ để mở lại
              publication + chat (spec §7.8).
            </p>
            <form action={liftSuspensionAction} className="mt-3 flex flex-col gap-2">
              <input type="hidden" name="suspensionId" value={activeSuspension.id} />
              <select name="reasonCode" required className="input text-sm" aria-label="Lý do gỡ đình chỉ">
                {SUSPENSION_REASON_CODES.map((code) => (
                  <option key={code} value={code}>{SUSPENSION_REASON_LABELS[code]}</option>
                ))}
              </select>
              <button type="submit" className="btn h-10 bg-[var(--green)] px-4 text-sm text-white hover:opacity-90">
                Gỡ đình chỉ
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
