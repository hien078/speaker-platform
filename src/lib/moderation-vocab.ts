/**
 * Moderation vocabularies — PURE, client-safe (Batch 3 Task 2 — spec §5.5).
 *
 * Module THUẦN cho client: chỉ hằng số + hàm thuần — KHÔNG import db client,
 * KHÔNG mang import ràng buộc môi trường server, KHÔNG import module
 * rate-limit (hợp đồng client-safe pin bằng source-contract test — client
 * component report-dialog/appeal-form Task 4/7 import trực tiếp từ đây).
 * Server code import qua `src/lib/moderation.ts` (re-export `export *`).
 * Rate-limit rules dùng structural type `{ limit, windowMs }` — không cần
 * import gì từ module limiter.
 *
 * Typed reasons everywhere (spec §5.5): reason code báo cáo là đúng CHÍN
 * category §5.5 verbatim; mọi admin moderation action ghi reason code từ
 * vocabulary đóng ở đây — KHÔNG BAO GIỜ free text trần. Free text chỉ tồn
 * tại dạng `note` tùy chọn (đã qua redactDetail tại write time).
 *
 * PROVISIONAL (A8 — FD-3): các vocabulary sanction (decision/assignment/
 * suspension reasons) là vocabulary IMPLEMENTATION thỏa yêu cầu "typed
 * reasons" của §5.5 — GIÁ TRỊ không phải spec-sourced. Founder có thể đổi
 * giá trị qua thay đổi additive (thêm/đổi hằng số) trước beta — Batch 8
 * Founder Decision Register. Mọi hằng số PROVISIONAL mang marker cạnh khai
 * báo; label maps trong src/lib/constants.ts mang marker tương tự.
 */

// ─── Report (spec §5.5 — verbatim, đúng thứ tự) ───────────────────────────────

/** Chín category lý do báo cáo lạm dụng — spec §5.5 verbatim. */
export const REPORT_REASON_CODES = [
  "suspected_scam",
  "harassment",
  "spam",
  "counterfeit_claim",
  "misleading_listing",
  "prohibited_content",
  "unsafe_behavior",
  "identity_impersonation",
  "other",
] as const;
export type ReportReasonCode = (typeof REPORT_REASON_CODES)[number];

/** Loại đích báo cáo — khớp enum report_target_type (Task 1). */
export const REPORT_TARGET_TYPES = ["listing", "user", "message"] as const;
export type ReportTargetType = (typeof REPORT_TARGET_TYPES)[number];

// ─── Moderation case (spec §5.5 — verbatim) ────────────────────────────────────

/** Bảy trạng thái case — spec §5.5 verbatim, khớp enum moderation_case_state. */
export const MODERATION_CASE_STATES = [
  "open",
  "triaged",
  "investigating",
  "actioned",
  "dismissed",
  "appealed",
  "closed",
] as const;
export type ModerationCaseState = (typeof MODERATION_CASE_STATES)[number];

/** Mức ưu tiên case — khớp enum moderation_priority (semantics = Ambiguity A5). */
export const MODERATION_PRIORITIES = ["low", "normal", "high"] as const;
export type ModerationPriority = (typeof MODERATION_PRIORITIES)[number];

/**
 * Case còn "đang xử lý" — dùng cho grouping key (target, reason) + dedupe
 * (Scope Decisions): case active duy nhất per key được đóng bằng partial
 * unique index `moderation_case_one_active_per_target_reason` (Task 1).
 */
export const ACTIVE_MODERATION_CASE_STATES = ["open", "triaged", "investigating"] as const;

/**
 * Bảng chuyển trạng thái hợp pháp MANUAL (spec §5.5 states; transitions là
 * MECHANICS — sanction/appeal POLICY là thứ không định nghĩa ở đây, xem
 * Ambiguities A2/A4). `closed` terminal — không có chuyển đi nào.
 *
 * Review fix Task 6 (item 5): `actioned → appealed` KHÔNG còn ở bảng manual —
 * `appealed` CHỈ được ghi qua appeal flow (recordAppealAction, Task 7 — CAS
 * .where({ id, state: "actioned" }) → appealed, actor là subject). Moderator
 * không tự ghi `appealed` qua transitionModerationCaseAction (bảng này là
 * nguồn quyền duy nhất của action đó); case-page dropdown đọc từ đây nên
 * "appealed" tự rời khỏi option.
 */
export const MODERATION_TRANSITIONS: Record<ModerationCaseState, readonly ModerationCaseState[]> = {
  open: ["triaged", "investigating", "dismissed", "actioned"],
  triaged: ["investigating", "actioned", "dismissed"],
  investigating: ["actioned", "dismissed"],
  actioned: ["closed"],
  appealed: ["closed"],
  dismissed: ["closed"],
  closed: [],
};

/** `from` → `to` có hợp pháp không? (pure lookup — Task 6 transition action). */
export function canTransition(from: ModerationCaseState, to: ModerationCaseState): boolean {
  return MODERATION_TRANSITIONS[from].includes(to);
}

// ─── Typed reason vocabularies — PROVISIONAL (A8) ─────────────────────────────

/**
 * Lý do quyết định có kiểu (spec §5.5 "typed reasons") — dùng cho transition
 * + takedown. PROVISIONAL (A8): founder review có thể đổi giá trị qua thay
 * đổi additive; KHÔNG phải policy.
 */
export const MODERATION_DECISION_REASON_CODES = [
  "no_violation_found",
  "insufficient_evidence",
  "policy_violation_confirmed",
  "resolved_by_sanction",
  "duplicate_case",
  "appeal_closed",
  "other_reviewed_reason",
] as const;
export type ModerationDecisionReasonCode = (typeof MODERATION_DECISION_REASON_CODES)[number];

/** Lý do gán case — PROVISIONAL (A8) — spec §5.5 đòi typed reason cho mọi admin action. */
export const MODERATION_ASSIGNMENT_REASON_CODES = [
  "triage_assignment",
  "reassignment",
  "other_reviewed_reason",
] as const;
export type ModerationAssignmentReasonCode =
  (typeof MODERATION_ASSIGNMENT_REASON_CODES)[number];

/** Lý do đình chỉ — PROVISIONAL (A8). */
export const SUSPENSION_REASON_CODES = [
  "confirmed_abuse",
  "confirmed_scam",
  "confirmed_harassment",
  "confirmed_spam",
  "prohibited_content",
  "terms_violation",
  "other_reviewed_reason",
] as const;
export type SuspensionReasonCode = (typeof SUSPENSION_REASON_CODES)[number];

/** Registry action type của ModerationAction (case-scoped history — Task 4–7). */
export const MODERATION_ACTION_TYPES = [
  "evidence.captured",
  "case.assigned",
  "case.transitioned",
  "listing.taken_down",
  "user.suspended",
  "user.suspension_lifted",
  "appeal.recorded",
] as const;
export type ModerationActionType = (typeof MODERATION_ACTION_TYPES)[number];

// ─── R5 — seller-side lock ────────────────────────────────────────────────────

/**
 * R5 — seller-side lock: các listing status mà seller KHÔNG được
 * edit/toggle/delete (guard trong updateListingAction/toggleListingVisibilityAction/
 * deleteListingAction — Task 6). `removed` là moderation takedown (R4) — KHÔNG
 * dùng cho seller self-hide. Batch 4 rewire giữ nguyên hằng số + helper này khi
 * thêm call sites (chỉ `archived` thêm sau — Batch 4 Task 1).
 */
export const MODERATION_LOCKED_LISTING_STATUSES = ["removed"] as const;
export type ModerationLockedListingStatus = (typeof MODERATION_LOCKED_LISTING_STATUSES)[number];

/**
 * Helper thay cho `.includes` trên readonly tuple — guard gọi
 * `isModerationLocked(listing.status)`; Batch 4 rewire giữ nguyên helper này
 * khi thêm call sites (source-contract test Task 6: không hardcode "removed"
 * trong listings.ts).
 */
export function isModerationLocked(status: string): boolean {
  return (MODERATION_LOCKED_LISTING_STATUSES as readonly string[]).includes(status);
}

// ─── Rate limits (spec §7.1) + caps — structural, không import rate-limit ──────

/** 5 report / 10 phút / reporter (spec §7.1 — report submission). */
export const REPORT_RATE_LIMIT = { limit: 5, windowMs: 10 * 60_000 };
/** 20 block/unblock / phút / user (spec §7.1 — block action). */
export const BLOCK_ACTION_RATE_LIMIT = { limit: 20, windowMs: 60_000 };
/** 30 tin nhắn / phút / user (spec §7.1 "chat" — POST send limit, Task 3). */
export const CHAT_SEND_RATE_LIMIT = { limit: 30, windowMs: 60_000 };
/** Cap note của reporter — untrusted input, chặn ở action layer (Task 4). */
export const REPORT_NOTE_MAX_LENGTH = 2000;
/** Cap lời trình bày kháng cáo — untrusted input (Task 7). */
export const APPEAL_STATEMENT_MAX_LENGTH = 4000;
/**
 * Cap note đình chỉ của admin (review fix Task 5) — CÙNG 2000 với maxLength
 * form (app/admin/users); action chặn server-side (form chỉ là convenience —
 * forged form vượt maxLength phải fail closed với typed error).
 */
export const SUSPENSION_NOTE_MAX_LENGTH = 2000;
