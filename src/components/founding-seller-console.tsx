import Link from "next/link";
import { cn, formatDateShort } from "@/src/lib/utils";
import { FOUNDING_SELLER_STATUS_BADGE } from "@/src/lib/constants";
import { PROVINCE_CODES } from "@/src/lib/provinces";
import {
  FOUNDING_SELLER_STATUS_LABELS,
  FOUNDING_SELLER_TRANSITION_REASONS,
  MANUALLY_SETTABLE_STATUSES,
  maskContact,
  type FoundingSellerCandidateStatus,
} from "@/src/lib/founding-seller-vocab";
import {
  assignCandidateOperatorAction,
  recordCandidateContactAction,
  revokeInviteAction,
  syncCandidateFunnelAction,
  updateCandidateStatusAction,
  updateQualityListingCountAction,
} from "@/src/lib/actions/founding-sellers";
import { CandidateNotesForm, InviteIssueForm } from "@/src/components/founding-seller-forms";

/**
 * Founding seller console — bảng ứng viên + form hành động (Batch 7 Task 5 —
 * spec §5.10/§5.10.1/§12.1/§12.3, §4.8/§7.6, §4.5/§4.9; corrections
 * 2026-10-08 items 27/33/37).
 *
 * SERVER component (KHÔNG directive use client — plain `<form action={...}>`
 * posts cho các action plain-FormData của Task 4, pattern app/admin/users/page.tsx).
 * Component THUẦN: mọi dữ liệu đến qua props từ page (page tự guard
 * requireCapability("beta_cohort.manage") TRƯỚC khi đọc db — spec §4.5; action
 * tự guard lại — hidden form không phải authorization).
 *
 * PII minimization (§4.8/§7.6 — Review Focus 4): contact render MASK qua
 * maskContact (Task 2 — fixed-width, không bao giờ trả giá trị đầy đủ);
 * KHÔNG có action mở mask PII (ô Scoped của operations_admin chưa được
 * founder định nghĩa — A2 fail closed; operator làm việc từ kênh tuyển của
 * họ). Notes là ops free text — render React text only.
 *
 * Token secrecy (Review Focus 1): bảng KHÔNG render URL/token mời — URL tuyệt
 * đối hiển thị MỘT LẦN trong response state của form mời
 * (founding-seller-forms.tsx); revoke form chỉ mang token ROW id.
 *
 * Membership (Batch 2 ownership): cột membership render READ-ONLY + link
 * /admin/users?u=<id> (corrections #27 — ?q= là ilike email/tên, không tìm
 * được theo id) — grant/suspend là action của Batch 2 trên trang users, console
 * KHÔNG có surface mutation membership thứ hai.
 */

// ─── View-model types (page tính từ live reads — S5: KHÔNG write trong render) ──

/** Một hàng ứng viên founding seller — mọi trường là read đã mask/label sẵn. */
export type CandidateRowView = {
  id: string;
  contactChannel: "email" | "phone" | null;
  /** RAW chỉ đến tay component SERVER này (không qua client boundary) — render luôn qua maskContact. */
  contactReference: string | null;
  source: string;
  /** Slug code tỉnh canonical (FD-1) — display qua PROVINCE_CODES. */
  targetCommunity: string;
  /** STORED status — render BÊSIDE live reads (page không sync trong render — S5). */
  status: FoundingSellerCandidateStatus;
  invitedAt: string | null;
  registeredAt: string | null;
  verifiedAt: string | null;
  firstListingAt: string | null;
  /** Ops-set sau §12.1 manual sampling — hệ thống KHÔNG auto-compute (A3). */
  qualityListingCount: number;
  lastContactAt: string | null;
  notes: string | null;
  assignedOperatorId: string | null;
  assignedOperatorName: string | null;
  userId: string | null;
  linkedUserName: string | null;
  /** BetaCohortMembership(founding_seller) của linked user — READ-ONLY (Batch 2 surface quản lý). */
  membershipStatus: string | null;
  /** SellerVerification.status của linked user — live read. */
  verificationStatus: string | null;
  /** Nhãn tiếng Việt các yêu cầu publication còn thiếu (checkSellerPublicationRequirements.missing). */
  publicationMissing: readonly string[];
  /** Factual count — approvedListingCountOf (KHÔNG phải "quality" — A3). */
  approvedListingCount: number;
  /** updatedAt của Listing mới nhất của seller — "last seller activity" §5.10. */
  lastListingUpdatedAt: string | null;
  /** D2 heuristic (Task 2) — badge ops, KHÔNG phải SLA. */
  needsAssistance: boolean;
  /** Row id của token active (chưa consume/revoke) — revoke form; KHÔNG BAO GIỜ raw token. */
  activeTokenId: string | null;
};

/** Option select gán operator — user có beta_cohort.manage (capabilitiesOf). */
export type OperatorOption = { id: string; name: string };

// ─── Pure view-model helpers (plan Task 5 "pure-logic tests") ──────────────────

/** §5.10 summary counts — đếm theo STORED status (point-in-time funnel). */
export type CohortSummaryView = {
  totalCandidates: number;
  invited: number;
  registered: number;
};

/** Đếm tổng/đã mời/đã tham gia theo status hiện tại (spec §5.10 display list). */
export function summarizeCandidates(
  candidates: readonly { status: FoundingSellerCandidateStatus }[],
): CohortSummaryView {
  return {
    totalCandidates: candidates.length,
    invited: candidates.filter((c) => c.status === "invited").length,
    registered: candidates.filter((c) => c.status === "registered").length,
  };
}

/**
 * Supply readiness (§12.1) — MỤC TIÊU VẬN HÀNH là DISPLAY STRING (spec §2.7/§9
 * "20–50 invited founding sellers / 100–300 quality listings"), KHÔNG phải
 * gate: không code path nào chặn theo count — mở rộng lời mời buyer rộng rãi
 * là quyết định FOUNDER (§12.1 "explicitly approved"), không phải điều kiện
 * hệ thống.
 *
 * Counts là LIVE reads (b7-t8 review fix — milestone lưu KHÔNG đếm được:
 * `verifiedAt` không bao giờ clear khi verification bị revoke, exited/inactive
 * vẫn giữ milestone):
 *  - invitedFoundingSellers: ứng viên ĐÃ TỪNG được mời (invitedAt set — đếm
 *    monotonic theo funnel §12.3, không rụng khi seller tiến sâu hơn);
 *  - verifiedFoundingSellers: LIVE SellerVerification.status === "verified"
 *    AND status ∉ {exited, inactive} — verification revoked/rejected →
 *    KHÔNG đếm; ứng viên rời chương trình → KHÔNG đếm;
 *  - approvedListingsByFoundingSellers: factual count (approved) — CHỈ ứng
 *    viên đang trong chương trình (status ∉ {exited, inactive}) AND membership
 *    founding_seller ACTIVE (suspended → listing không đếm vào mục tiêu).
 *    KHÔNG phải "quality" (A3).
 */
export type SupplyReadinessView = {
  invitedFoundingSellers: number;
  verifiedFoundingSellers: number;
  approvedListingsByFoundingSellers: number;
  targetInvited: string;
  targetListings: string;
};

/** Row view cho supply readiness — LIVE reads (CandidateRowView thỏa cấu trúc). */
export type SupplyReadinessRow = {
  invitedAt: string | null;
  /** STORED status của ứng viên. */
  status: FoundingSellerCandidateStatus;
  /** LIVE SellerVerification.status của linked user (null khi chưa link/chưa có row). */
  verificationStatus: string | null;
  /** BetaCohortMembership(founding_seller).status của linked user — READ-ONLY. */
  membershipStatus: string | null;
  /** Factual approved-listing count (approvedListingCountOf — KHÔNG phải quality, A3). */
  approvedListingCount: number;
};

/** Mục tiêu tham chiếu §12.1 — display string, founder ack qua Batch 8 register. */
export const SUPPLY_TARGET_INVITED = "20–50";
export const SUPPLY_TARGET_LISTINGS = "100–300";

export function buildSupplyReadinessView(
  rows: readonly SupplyReadinessRow[],
): SupplyReadinessView {
  // Ứng viên đang trong chương trình — exited/inactive rời chương trình, không
  // đếm vào verified/listings của mục tiêu vận hành §12.1.
  const inProgram = rows.filter((r) => r.status !== "exited" && r.status !== "inactive");
  return {
    // ever-invited — monotonic theo funnel §12.3 (không rụng khi tiến sâu hơn)
    invitedFoundingSellers: rows.filter((r) => r.invitedAt !== null).length,
    // LIVE verification (KHÔNG phải milestone verifiedAt) — revoked → không đếm
    verifiedFoundingSellers: inProgram.filter((r) => r.verificationStatus === "verified").length,
    // factual approved count — chỉ ứng viên trong chương trình AND membership active
    approvedListingsByFoundingSellers: inProgram
      .filter((r) => r.membershipStatus === "active")
      .reduce((acc, r) => acc + r.approvedListingCount, 0),
    targetInvited: SUPPLY_TARGET_INVITED,
    targetListings: SUPPLY_TARGET_LISTINGS,
  };
}

// ─── Local UI copy (PROVISIONAL FD-3 — founder review qua Batch 8 register) ───

/**
 * Nhãn lý do chuyển trạng thái cho select — map cục bộ (pattern
 * SUSPENSION_REASON_LABELS của app/admin/users/page.tsx): vocabulary sống ở
 * founding-seller-vocab.ts (Task 2 sở hữu — không mở rộng ở đây), label là
 * copy trung tính PROVISIONAL (FD-3).
 */
const TRANSITION_REASON_LABELS: Record<string, string> = {
  concierge_started: "Bắt đầu hỗ trợ trực tiếp",
  quality_sample_passed: "Sample chất lượng đạt (§12.1)",
  seller_unresponsive: "Người bán không phản hồi",
  seller_declined: "Người bán từ chối tham gia",
  policy_review: "Cần review chính sách",
  operator_correction: "Sửa thao tác sai",
  other_reviewed_reason: "Lý do khác (đã review)",
};

// ─── Component ────────────────────────────────────────────────────────────────

export function FoundingSellerConsole({
  rows,
  operators,
}: {
  rows: readonly CandidateRowView[];
  operators: readonly OperatorOption[];
}) {
  if (rows.length === 0) {
    return (
      <p className="mt-5 text-sm text-[var(--muted)]">Chưa có ứng viên founding seller nào.</p>
    );
  }

  return (
    <div className="table-wrap mt-5">
      <table className="table-base">
        <thead>
          <tr>
            <th>Ứng viên</th>
            <th>Cộng đồng</th>
            <th>Trạng thái</th>
            <th>Xác minh</th>
            <th>Tin đăng</th>
            <th>Hoạt động</th>
            <th>Operator</th>
            <th>Ghi chú</th>
            <th>Hành động</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              {/* Ứng viên — contact MASK (§4.8/§7.6), source là ops free text → React text */}
              <td>
                <p className="text-sm font-semibold">{maskContact(row.contactChannel, row.contactReference)}</p>
                <p className="text-xs text-[var(--muted)]">{row.source}</p>
                {row.linkedUserName !== null && (
                  <p className="text-xs text-[var(--muted)]">TK: {row.linkedUserName}</p>
                )}
              </td>

              {/* Cộng đồng mục tiêu — slug code canonical → display (FD-1, §4.7 location neutrality) */}
              <td className="text-xs text-[var(--ink-2)]">
                {PROVINCE_CODES[row.targetCommunity] ?? row.targetCommunity}
              </td>

              {/* Trạng thái STORED + milestone §5.10 + badge cần hỗ trợ (D2 — ops heuristic) */}
              <td>
                <span className={cn("badge", FOUNDING_SELLER_STATUS_BADGE[row.status] ?? "")}>
                  {FOUNDING_SELLER_STATUS_LABELS[row.status]}
                </span>
                {row.needsAssistance && (
                  <span className="badge ml-1 bg-amber-500/15 text-amber-600" title="lastContactAt null hoặc cũ hơn 7 ngày (D2 — ops heuristic, không phải SLA)">
                    Cần hỗ trợ
                  </span>
                )}
                <div className="mt-1 space-y-0.5 text-[11px] text-[var(--muted)]">
                  <p>mời: {formatDateShort(row.invitedAt)}</p>
                  <p>tham gia: {formatDateShort(row.registeredAt)}</p>
                  <p>xác minh: {formatDateShort(row.verifiedAt)}</p>
                  <p>tin đầu: {formatDateShort(row.firstListingAt)}</p>
                </div>
              </td>

              {/* Xác minh — SellerVerification.status live + yêu cầu publication còn thiếu + membership READ-ONLY */}
              <td className="text-xs">
                <p>
                  <span className="font-semibold">{row.verificationStatus ?? "—"}</span>
                  <span className="text-[var(--muted)]"> (verification)</span>
                </p>
                {row.publicationMissing.length > 0 ? (
                  <p className="mt-0.5 text-[var(--muted)]">Thiếu: {row.publicationMissing.join(", ")}</p>
                ) : (
                  <p className="mt-0.5 text-[var(--muted)]">Đủ yêu cầu publication</p>
                )}
                <p className="mt-1">
                  <span className="font-semibold">{row.membershipStatus ?? "—"}</span>
                  <span className="text-[var(--muted)]"> (founding_seller)</span>
                </p>
                {row.userId !== null && (
                  <Link
                    href={`/admin/users?u=${row.userId}`}
                    className="mt-0.5 inline-block font-semibold text-[var(--accent)] hover:underline"
                    title="Grant/suspend membership là action của Batch 2 trên trang users (audited) — console chỉ đọc + link"
                  >
                    Quản lý membership
                  </Link>
                )}
              </td>

              {/* Tin đăng — factual "tin đã duyệt" ≠ ops sample "tin chất lượng" (A3 pending-definition) */}
              <td className="text-xs">
                <p>
                  <span className="font-semibold">{row.approvedListingCount}</span>{" "}
                  <span className="text-[var(--muted)]">tin đã duyệt</span>
                </p>
                <p>
                  <span className="font-semibold">{row.qualityListingCount}</span>{" "}
                  <span className="text-[var(--muted)]">tin chất lượng (ops sample)</span>
                </p>
                <p className="mt-0.5 text-[var(--muted)]">
                  tin mới nhất: {formatDateShort(row.lastListingUpdatedAt)}
                </p>
              </td>

              {/* Last seller activity — lastContactAt (ops) */}
              <td className="whitespace-nowrap text-xs text-[var(--muted)]">
                {formatDateShort(row.lastContactAt)}
              </td>

              {/* Operator phụ trách */}
              <td className="text-xs text-[var(--ink-2)]">{row.assignedOperatorName ?? "—"}</td>

              {/* Ghi chú ops — React text only (KHÔNG bao giờ HTML thô — stored-XSS posture §10.1) */}
              <td className="max-w-56 text-xs text-[var(--ink-2)]">
                <p className="line-clamp-3">{row.notes ?? "—"}</p>
              </td>

              {/* Hành động — mọi mutation là action Task 3/4 (tự guard beta_cohort.manage) */}
              <td>
                <div className="flex flex-col gap-1.5">
                  {/* Mời / mời lại — CHỈ pre-registration (invite là pre-registration only — S9) */}
                  {(row.status === "prospect" || row.status === "invited") && (
                    <InviteIssueForm candidateId={row.id} />
                  )}

                  {/* Thu hồi lời mời — token ROW id (raw token không bao giờ render) */}
                  {row.activeTokenId !== null && (
                    <form action={revokeInviteAction}>
                      <input type="hidden" name="tokenId" value={row.activeTokenId} />
                      <button
                        type="submit"
                        className="btn h-8 bg-[var(--paper-deep)] px-3 text-xs text-[var(--ink-2)] hover:bg-zinc-600"
                        title="Thu hồi token active (idempotent — token đã consume/revoke là no-op)"
                      >
                        Thu hồi lời mời
                      </button>
                    </form>
                  )}

                  {/* Funnel sync — ĐƯỜNG DUY NHẤT operator chạy sync (S5 — audited action Task 4) */}
                  {row.userId !== null && (
                    <form action={syncCandidateFunnelAction}>
                      <input type="hidden" name="candidateId" value={row.id} />
                      <button
                        type="submit"
                        className="btn-secondary h-8 px-3 text-xs"
                        title="Đồng bộ trạng thái từ ground truth (SellerVerification + listing approved) — chỉ TIẾN, audited"
                      >
                        Sync funnel
                      </button>
                    </form>
                  )}

                  {/* Chuyển trạng thái thủ công — toStatus ∈ MANUALLY_SETTABLE + reason TYPED (PROVISIONAL FD-3) */}
                  <form action={updateCandidateStatusAction} className="flex flex-col gap-1">
                    <input type="hidden" name="candidateId" value={row.id} />
                    <select name="toStatus" required aria-label="Trạng thái mới" className="input h-8 px-2 text-xs">
                      {MANUALLY_SETTABLE_STATUSES.map((s) => (
                        <option key={s} value={s}>{FOUNDING_SELLER_STATUS_LABELS[s]}</option>
                      ))}
                    </select>
                    <select name="reasonCode" required aria-label="Lý do chuyển trạng thái" className="input h-8 px-2 text-xs">
                      {FOUNDING_SELLER_TRANSITION_REASONS.map((r) => (
                        <option key={r} value={r}>{TRANSITION_REASON_LABELS[r] ?? r}</option>
                      ))}
                    </select>
                    <input name="note" className="input h-8 px-2 text-xs" placeholder="Ghi chú (tuỳ chọn — đã redact PII)" />
                    <button
                      type="submit"
                      className="btn h-8 bg-[var(--accent)] px-3 text-xs text-white hover:opacity-90"
                      title="Chuyển trạng thái thủ công — bảng transition hợp pháp kiểm tra ở action (fail closed)"
                    >
                      Chuyển trạng thái
                    </button>
                  </form>

                  {/* Gán operator — eligibility beta_cohort.manage kiểm tra ở action (Batch 3 assign precedent) */}
                  <form action={assignCandidateOperatorAction} className="flex flex-col gap-1">
                    <input type="hidden" name="candidateId" value={row.id} />
                    <select
                      name="operatorId"
                      defaultValue={row.assignedOperatorId ?? ""}
                      aria-label="Operator phụ trách"
                      className="input h-8 px-2 text-xs"
                    >
                      <option value="">— Chưa gán (gán rỗng = bỏ gán) —</option>
                      {operators.map((op) => (
                        <option key={op.id} value={op.id}>{op.name}</option>
                      ))}
                    </select>
                    <button
                      type="submit"
                      className="btn-secondary h-8 px-3 text-xs"
                      title="Gán/gỡ operator phụ trách — operator phải có beta_cohort.manage (audited)"
                    >
                      Gán operator
                    </button>
                  </form>

                  {/* Ghi nhận đã liên hệ — cập nhật lastContactAt (input cho D2) */}
                  <form action={recordCandidateContactAction} className="flex flex-col gap-1">
                    <input type="hidden" name="candidateId" value={row.id} />
                    <input name="note" className="input h-8 px-2 text-xs" placeholder="Ghi chú lần liên hệ (tuỳ chọn)" />
                    <button
                      type="submit"
                      className="btn-secondary h-8 px-3 text-xs"
                      title="Đánh dấu đã liên hệ ứng viên (lastContactAt = now) — audited"
                    >
                      Ghi nhận liên hệ
                    </button>
                  </form>

                  {/* Số listing "chất lượng" — OPS SET sau §12.1 manual sampling (A3 — hệ thống không tự tính) */}
                  <form action={updateQualityListingCountAction} className="flex flex-col gap-1">
                    <input type="hidden" name="candidateId" value={row.id} />
                    <input
                      type="number"
                      name="count"
                      min={0}
                      required
                      defaultValue={row.qualityListingCount}
                      aria-label="Số tin chất lượng (ops sample)"
                      className="input h-8 px-2 text-xs"
                    />
                    <button
                      type="submit"
                      className="btn-secondary h-8 px-3 text-xs"
                      title="Cập nhật số tin chất lượng theo sample thủ công §12.1 — định nghĩa quality đang chờ founder (A3)"
                    >
                      Cập nhật số sample
                    </button>
                  </form>

                  {/* Ghi chú ops — writer duy nhất của candidate.notes (Task 4) */}
                  <CandidateNotesForm candidateId={row.id} notes={row.notes} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
