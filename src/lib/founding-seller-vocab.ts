/**
 * Founding-seller vocabularies — PURE, client-safe (Batch 7 Task 2 — spec
 * §5.10/§5.10.1, §4.8/§7.6).
 *
 * Module THUẦN cho client: chỉ hằng số + hàm thuần — KHÔNG import db client,
 * KHÔNG mang import ràng buộc môi trường server (Batch 3
 * moderation-vocab.ts precedent). Client component của console/forms
 * (Task 5) import trực tiếp từ đây; server code import qua
 * `src/lib/founding-sellers.ts` (re-export `export *`).
 *
 * ── FD-3 PROVISIONAL ──────────────────────────────────────────────────────────
 * Mọi vocabulary dưới đây (bảng chuyển trạng thái, reason codes, tập
 * manually-settable, caps, rate values) là CƠ HỌC implementation thỏa spec
 * §5.10 "Possible lifecycle" — KHÔNG phải policy founder phát biểu. Founder
 * mở rộng/sửa qua thay đổi additive (thêm/đổi hằng số) trước beta; mọi mục
 * PROVISIONAL được liệt kê vào Batch 8 Founder Decision Register (plan
 * "Batch 8 Founder Decision Register hand-off"). Giá trị lifecycle
 * FOUNDING_SELLER_CANDIDATE_STATUSES là §5.10 VERBATIM — không thêm/bớt
 * (§4.11 non-invention pin).
 */

// ─── Lifecycle (spec §5.10 verbatim — đúng thứ tự) ────────────────────────────

/** Mười trạng thái ứng viên founding seller — spec §5.10 lifecycle verbatim. */
export const FOUNDING_SELLER_CANDIDATE_STATUSES = [
  "prospect",
  "invited",
  "registered",
  "verification_pending",
  "verified",
  "concierge_onboarding",
  "first_listing",
  "active_founding_seller",
  "inactive",
  "exited",
] as const;
export type FoundingSellerCandidateStatus = (typeof FOUNDING_SELLER_CANDIDATE_STATUSES)[number];

/** Nhãn tiếng Việt cho console + forms — PROVISIONAL (FD-3). */
export const FOUNDING_SELLER_STATUS_LABELS: Record<FoundingSellerCandidateStatus, string> = {
  prospect: "Tiềm năng",
  invited: "Đã mời",
  registered: "Đã tham gia",
  verification_pending: "Chờ xác minh",
  verified: "Đã xác minh",
  concierge_onboarding: "Đang hỗ trợ trực tiếp",
  first_listing: "Tin đầu tiên",
  active_founding_seller: "Founding seller đang hoạt động",
  inactive: "Ngừng hoạt động",
  exited: "Đã rời chương trình",
};

// ─── Reason codes (typed — PROVISIONAL FD-3) ─────────────────────────────────

/**
 * Lý do chuyển trạng thái CÓ KIỂU — vocabulary cơ học PROVISIONAL (FD-3),
 * founder mở rộng được qua Batch 8 register. Mọi manual transition (Task 4)
 * ghi reason code từ tập đóng ở đây — KHÔNG BAO GIỜ free text trần.
 */
export const FOUNDING_SELLER_TRANSITION_REASONS = [
  "concierge_started", // vào concierge_onboarding
  "quality_sample_passed", // vào active_founding_seller (§12.1 manual sampling)
  "seller_unresponsive", // vào inactive
  "seller_declined", // vào inactive/exited
  "policy_review", // vào exited
  "operator_correction", // sửa sai thao tác
  "other_reviewed_reason",
] as const;
export type FoundingSellerTransitionReason = (typeof FOUNDING_SELLER_TRANSITION_REASONS)[number];

// ─── Bảng chuyển trạng thái hợp pháp (PROVISIONAL FD-3) ───────────────────────

/**
 * Bảng chuyển trạng thái hợp pháp MANUAL (spec §5.10 lifecycle là chuỗi tuyến
 * tính + 2 terminal ops states). PROVISIONAL (FD-3) — founder review có thể
 * đổi giá trị qua thay đổi additive; Batch 8 register.
 *
 *  - `exited` terminal — không có chuyển đi.
 *  - `inactive → exited` là đường DUY NHẤT: kích hoạt lại từ inactive là
 *    founder policy (A5) — KHÔNG phát minh ở đây (pin có ý trong test).
 *  - Bảng này CHI PHẌT manual operator moves (updateCandidateStatusAction —
 *    Task 4). Funnel sync (syncFoundingSellerFunnel) dùng thứ tự monotonic
 *    RIÊNG và EXEMPT bảng này — xem src/lib/founding-sellers.ts.
 */
export const FOUNDING_SELLER_TRANSITIONS: Record<
  FoundingSellerCandidateStatus,
  readonly FoundingSellerCandidateStatus[]
> = {
  prospect: ["invited", "exited"],
  invited: ["registered", "inactive", "exited"],
  registered: ["verification_pending", "inactive", "exited"],
  verification_pending: ["verified", "inactive", "exited"],
  verified: ["concierge_onboarding", "first_listing", "inactive", "exited"],
  concierge_onboarding: ["first_listing", "inactive", "exited"],
  first_listing: ["active_founding_seller", "inactive", "exited"],
  active_founding_seller: ["inactive", "exited"],
  inactive: ["exited"],
  exited: [],
};

/** `from` → `to` có hợp pháp không? (pure lookup — manual transition action Task 4). */
export function canTransitionCandidate(
  from: FoundingSellerCandidateStatus,
  to: FoundingSellerCandidateStatus,
): boolean {
  return FOUNDING_SELLER_TRANSITIONS[from].includes(to);
}

/**
 * Tập trạng thái operator ĐƯỢC PHÉP tự set (PROVISIONAL — FD-3). Còn lại
 * (prospect/invited/registered/verification_pending/verified/first_listing)
 * thuộc invite flow (Task 3) + funnel sync — operator không tự set (fail
 * closed chống fake funnel; Task 4 chặn bằng STATUS_NOT_MANUALLY_SETTABLE).
 */
export const MANUALLY_SETTABLE_STATUSES = [
  "concierge_onboarding",
  "active_founding_seller",
  "inactive",
  "exited",
] as const;
export type ManuallySettableStatus = (typeof MANUALLY_SETTABLE_STATUSES)[number];

// ─── Caps + tunables (PROVISIONAL FD-3 — D1/D2/P5) ────────────────────────────

/** Cap note ops trên ứng viên — untrusted free text, chặn ở action (Task 4). */
export const FOUNDING_SELLER_NOTE_MAX_LENGTH = 4_000;
/** Cap kênh tuyển nguồn (source) — ops free text, render React text only. */
export const FOUNDING_SELLER_SOURCE_MAX_LENGTH = 200;
/**
 * TTL invite token (ngày) — D1: spec yêu cầu invite hết hạn nhưng KHÔNG cho
 * TTL; 14 ngày hợp nhịp concierge recruitment người. Tunable constant,
 * KHÔNG phải env value (§4.10 posture).
 */
export const FOUNDING_SELLER_INVITE_TTL_DAYS = 14;
/** 20 invite / giờ / admin (§7.1) — PROVISIONAL (P5). */
export const FOUNDING_SELLER_INVITE_RATE = { limit: 20, windowMs: 60 * 60_000 } as const;
/** 10 lần / 10 phút / user (§7.1 "beta invite acceptance") — PROVISIONAL (P5). */
export const BETA_INVITE_ACCEPT_RATE = { limit: 10, windowMs: 10 * 60_000 } as const;
/**
 * 30 lần / 10 phút / IP cho landing GET /invite/[token] (corrections #13) —
 * token-validity oracle không giới hạn là lỗi; PROVISIONAL (P5).
 */
export const BETA_INVITE_LANDING_RATE = { limit: 30, windowMs: 10 * 60_000 } as const;
/**
 * Ngưỡng "seller cần hỗ trợ": active-funnel candidate với lastContactAt null
 * hoặc cũ hơn 7 ngày (D2) — ops heuristic render thành badge, KHÔNG phải SLA
 * (spec không định nghĩa SLA). Reversible constant.
 */
export const FOUNDING_SELLER_ASSISTANCE_AFTER_DAYS = 7;

// ─── Contact masking (spec §4.8/§7.6 minimization) ────────────────────────────

/** Dấu thay thế khi không có giá trị contact. */
const MASK_EMPTY = "—";
/** Mask toàn bộ khi không phân loại được kênh / giá trị không hợp cấu trúc. */
const MASK_OPAQUE = "***";
/** Mask phone quá ngắn để cắt đầu/cuối — mask toàn bộ, fixed-width. */
const MASK_PHONE_OPAQUE = "*****";

/**
 * Mask contact cho console (§4.8/§7.6 minimization) — KHÔNG BAO GIỜ trả về
 * giá trị đầy đủ, ở bất kỳ môi trường nào:
 *  - email: ký tự đầu local part + `***@domain` ("lienhe@example.com" →
 *    "l***@example.com"); local part 1 ký tự → `***@domain` (không lộ toàn
 *    bộ local); thiếu "@" → mask toàn bộ (dữ liệu hỏng — fail closed).
 *  - phone: 2 số đầu + `*****` + 2 số cuối ("0901234567" → "09*****67") —
 *    FIXED-WIDTH 9 ký tự cho MỌI độ dài vào (corrections #34: không leak độ
 *    dài thật); dưới 4 ký tự → mask toàn bộ (cắt đầu/cuối sẽ lộ gần hết).
 *  - channel null / giá trị null|rỗng → "—" / mask toàn bộ.
 *
 * Pure string slicing — không bao giờ tái dựng giá trị đầy đủ.
 */
export function maskContact(
  channel: "email" | "phone" | null,
  value: string | null | undefined,
): string {
  if (value === null || value === undefined || value === "") return MASK_EMPTY;
  if (channel === null) return MASK_OPAQUE;

  if (channel === "email") {
    const at = value.indexOf("@");
    if (at <= 0) return MASK_OPAQUE; // không có "@" hoặc local rỗng — fail closed
    const local = value.slice(0, at);
    const domain = value.slice(at + 1);
    const maskedLocal = local.length === 1 ? MASK_OPAQUE : `${local[0]}${MASK_OPAQUE}`;
    return `${maskedLocal}@${domain}`;
  }

  // channel === "phone" — fixed-width, không leak độ dài (corrections #34)
  if (value.length < 4) return MASK_PHONE_OPAQUE;
  return `${value.slice(0, 2)}${MASK_PHONE_OPAQUE}${value.slice(-2)}`;
}
