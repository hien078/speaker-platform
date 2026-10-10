import "server-only";
import { db } from "@/src/prisma/db.client";
import { isProvinceCode, PROVINCE_CODES } from "@/src/lib/provinces";

/**
 * Seller Verification Policy v1 (Batch 2 Task 10 — spec §5.3.3, §4.4, §4.9,
 * §2.1) — cổng publication của người bán: MỘT tin đăng không thể chuyển vào
 * trạng thái duyệt/công khai (pending/approved) trừ khi người bán thỏa MÃN
 * yêu cầu hiện hành của chính sách. Đọc FRESH từ DB mỗi lần gọi — KHÔNG tin
 * cache session (spec §4.4; revoked/suspended phải chặn NGAY cả khi session
 * còn sống).
 *
 * Seller verification là "platform-access trust control" — KHÔNG phải bảo
 * đảm sản phẩm hay chứng nhận (spec §5.3.3). Copy công khai dùng đúng câu
 * §6.2: "Đã xác minh thông tin người bán theo yêu cầu hiện tại của LoaViet."
 * — không bao giờ ngôn ngữ bảo đảm/đảm bảo/chứng nhận.
 *
 * Bảy yêu cầu tối thiểu (spec §5.3.3):
 *   verified email + verified phone + declared seller type + canonical
 *   operating location (mã 34 đơn vị — FD-1) + Seller Rules v1 accepted +
 *   active founding_seller membership (controlled beta, spec §2.1/§4.9) +
 *   operations review = verified.
 *
 * Nguồn quyền duy nhất: các bảng workflow (SellerVerification /
 * BetaCohortMembership / PolicyAcceptance / User.emailVerifiedAt…).
 * Legacy `User.isVerifiedSeller` và `User.role` KHÔNG cấp gì (spec §8.2/§8.5)
 * — boolean legacy chỉ hiển thị.
 *
 * Mọi caller (createListingAction / updateListingAction /
 * toggleListingVisibilityAction hidden→approved / admin approveListingAction)
 * đi qua CÙNG hàm này — kể cả admin (defense-in-depth, spec §7.3: revoked-seller
 * publication bypass phải chặn ở MỌI đường, kể cả duyệt bởi admin).
 */

export const SELLER_VERIFICATION_POLICY_VERSION = "v1";
export const SELLER_RULES_POLICY_KEY = "seller_rules";
export const SELLER_RULES_POLICY_VERSION = "v1";

/**
 * Typed reason codes (spec §5.3.3 — KHÔNG dựa vào free text tuỳ ý).
 * `migrated_legacy_verified` chỉ dùng bởi backfill script (Task 10) —
 * reviewer người dùng các mã review còn lại.
 */
export const SELLER_VERIFICATION_REASON_CODES = [
  "requirements_met",
  "duplicate_account_risk",
  "active_suspension",
  "prior_verification_revoked",
  "identity_information_inconsistent",
  "business_claim_needs_evidence",
  "abuse_case_unresolved",
  "manual_risk_review",
  "other_reviewed_reason",
  "migrated_legacy_verified",
] as const;
export type SellerVerificationReasonCode = (typeof SELLER_VERIFICATION_REASON_CODES)[number];

/** Quyết định review có thể ghi (spec §5.3.3). */
export const SELLER_VERIFICATION_DECISIONS = ["verified", "needs_review", "rejected", "revoked"] as const;
export type SellerVerificationDecision = (typeof SELLER_VERIFICATION_DECISIONS)[number];

/**
 * PROVISIONAL (review fix L2 — FD-3 fail-closed default, ghi cho Batch 8
 * register): map quyết định → reason code ĐƯỢC PHÉP kèm theo đó. Plan/spec
 * không định nghĩa độ tương thích decision×reason — map này chặn các cặp vô
 * nghĩa (vd `verified` kèm `duplicate_account_risk`) và các cặp mâu thuẫn
 * (`requirements_met` chỉ dành cho `verified`). `migrated_legacy_verified`
 * KHÔNG thuộc quyết định người nào — CHỈ backfill script được dùng (spec §8.2).
 *
 * Chính sách đã chọn (PROVISIONAL — founder có thể đảo ngược):
 *  - verified: requirements_met | other_reviewed_reason (kết luận dương tính)
 *  - needs_review: tín hiệu cần bổ sung/soi thêm (trừ 2 tín hiệu đinh đóng)
 *  - rejected/revoked: tín hiệu tiêu cực (trừ business_claim_needs_evidence —
 *    khiếu nại doanh nghiệp cần bằng chứng là việc cần SOI THÊM, không phải từ chối)
 */
export const SELLER_VERIFICATION_DECISION_REASON_CODES: Record<
  SellerVerificationDecision,
  readonly SellerVerificationReasonCode[]
> = {
  verified: ["requirements_met", "other_reviewed_reason"],
  needs_review: [
    "duplicate_account_risk",
    "identity_information_inconsistent",
    "business_claim_needs_evidence",
    "abuse_case_unresolved",
    "manual_risk_review",
    "other_reviewed_reason",
  ],
  rejected: [
    "duplicate_account_risk",
    "active_suspension",
    "prior_verification_revoked",
    "identity_information_inconsistent",
    "abuse_case_unresolved",
    "manual_risk_review",
    "other_reviewed_reason",
  ],
  revoked: [
    "duplicate_account_risk",
    "active_suspension",
    "prior_verification_revoked",
    "identity_information_inconsistent",
    "abuse_case_unresolved",
    "manual_risk_review",
    "other_reviewed_reason",
  ],
};

/** Trạng thái workflow (enum seller_verification_status — spec §5.3.2). */
export type SellerVerificationStatus =
  | "not_started"
  | "pending"
  | "verified"
  | "rejected"
  | "needs_review"
  | "revoked";

/** Nhãn tiếng Việt cho trạng thái workflow — dùng chung UI seller + admin. */
export const SELLER_VERIFICATION_STATUS_LABELS: Record<SellerVerificationStatus, string> = {
  not_started: "Chưa bắt đầu",
  pending: "Đang chờ operations review",
  verified: "Đã xác minh",
  rejected: "Chưa được duyệt",
  needs_review: "Cần xem xét thêm",
  revoked: "Đã bị thu hồi",
};

/** Nhãn tiếng Việt cho reason code (spec §5.3.3) — form review + status view. */
export const SELLER_VERIFICATION_REASON_LABELS: Record<SellerVerificationReasonCode, string> = {
  requirements_met: "Đủ yêu cầu hiện hành",
  duplicate_account_risk: "Rủi ro tài khoản trùng lặp",
  active_suspension: "Đang bị đình chỉ hoạt động",
  prior_verification_revoked: "Từng bị thu hồi xác minh trước đây",
  identity_information_inconsistent: "Thông tin khai báo không nhất quán",
  business_claim_needs_evidence: "Tuyên bố doanh nghiệp cần bằng chứng bổ sung",
  abuse_case_unresolved: "Có khiếu nại lạm dụng chưa giải quyết",
  manual_risk_review: "Xem xét rủi ro thủ công",
  other_reviewed_reason: "Lý do khác (đã review)",
  migrated_legacy_verified: "Chuyển đổi từ dữ liệu legacy (batch 2)",
};

/**
 * Mã hành chính VN → tên hiển thị — 34 đơn vị cấp tỉnh hiệu lực 2025-07-01
 * (FD-1: NQ 202/2025/QH15; registry sống ở src/lib/provinces.ts — plain module
 * import được bởi client + script; thay cho danh sách 63 tỉnh cũ của plan).
 */
export { PROVINCE_CODES };

/**
 * founding_seller membership còn hoạt động không? (review fix L4 — spec §2.1)
 * active + CHƯA hết hạn: expiresAt đặt mà đã qua → coi như inactive (gate chặn
 * NGAY — membership hết hạn không còn là điều kiện publication). expiresAt
 * null/undefined = không giới hạn (Batch 7 invitation flow mới đặt hạn).
 */
function isMembershipActive(
  membership: { status: string; expiresAt: string | null | undefined } | null,
): boolean {
  if (membership === null || membership.status !== "active") return false;
  const { expiresAt } = membership;
  if (expiresAt === null || expiresAt === undefined) return true;
  return Date.parse(expiresAt) > Date.now();
}

/** Bảy yêu cầu publication (spec §5.3.3) — thứ tự ổn định cho thông báo lỗi. */
export type SellerPublicationRequirement =
  | "email_verified"
  | "phone_verified"
  | "seller_type_declared"
  | "operating_location_declared"
  | "seller_rules_accepted"
  | "founding_seller_membership_active"
  | "operations_review_verified";

export type SellerPublicationCheck = {
  ok: boolean;
  missing: SellerPublicationRequirement[];
};

/** Nhãn tiếng Việt cho yêu cầu thiếu — dùng chung submit action + gate listings. */
export const SELLER_PUBLICATION_REQUIREMENT_LABELS: Record<SellerPublicationRequirement, string> = {
  email_verified: "xác minh email",
  phone_verified: "xác minh số điện thoại",
  seller_type_declared: "khai báo loại người bán",
  operating_location_declared: "khai báo khu vực hoạt động",
  seller_rules_accepted: "đồng ý Quy tắc người bán",
  founding_seller_membership_active: "thành viên founding_seller còn hoạt động",
  operations_review_verified: "được operations review xác minh",
};

/** Danh sách missing → text tiếng Việt (dùng trong thông báo lỗi user-facing). */
export function formatMissingRequirements(missing: SellerPublicationRequirement[]): string {
  return missing.map((r) => SELLER_PUBLICATION_REQUIREMENT_LABELS[r]).join(", ");
}

/**
 * Kiểm MỌI yêu cầu publication của một seller — đọc FRESH từ DB (4 lookup
 * song song: User + PolicyAcceptance(seller_rules,v1) +
 * BetaCohortMembership(founding_seller) + SellerVerification).
 *
 * Fail closed: seller không tồn tại → thiếu cả 7 (không có đường "ok" nào
 * không đi qua DB); mã tỉnh không hợp lệ (vd giá trị 63 tỉnh cũ) → coi như
 * chưa khai báo vị trí.
 */
export async function checkSellerPublicationRequirements(
  sellerId: string,
): Promise<SellerPublicationCheck> {
  const [user, rulesAcceptance, foundingMembership, verification] = await Promise.all([
    db.orm.public.User.first({ id: sellerId }),
    db.orm.public.PolicyAcceptance.first({
      userId: sellerId,
      policyKey: SELLER_RULES_POLICY_KEY,
      policyVersion: SELLER_RULES_POLICY_VERSION,
    }),
    db.orm.public.BetaCohortMembership.first({ userId: sellerId, cohort: "founding_seller" }),
    db.orm.public.SellerVerification.first({ userId: sellerId }),
  ]);

  const missing: SellerPublicationRequirement[] = [];
  if (user === null) {
    // seller không tồn tại (hoặc đã bị xoá) — fail closed: chặn toàn bộ
    return { ok: false, missing: [
      "email_verified",
      "phone_verified",
      "seller_type_declared",
      "operating_location_declared",
      "seller_rules_accepted",
      "founding_seller_membership_active",
      "operations_review_verified",
    ] };
  }

  if (user.emailVerifiedAt === null) missing.push("email_verified");
  if (user.phoneVerifiedAt === null) missing.push("phone_verified");
  if (user.sellerType === null) missing.push("seller_type_declared");
  if (user.sellerOperatingProvinceCode === null || !isProvinceCode(user.sellerOperatingProvinceCode)) {
    missing.push("operating_location_declared");
  }
  if (rulesAcceptance === null) missing.push("seller_rules_accepted");
  if (!isMembershipActive(foundingMembership)) {
    missing.push("founding_seller_membership_active");
  }
  if (verification === null || verification.status !== "verified") {
    missing.push("operations_review_verified");
  }

  return { ok: missing.length === 0, missing };
}

/**
 * Throw Error("SELLER_PUBLICATION_BLOCKED:" + missing.join(",")) khi seller
 * chưa thỏa yêu cầu — caller (4 transition surfaces của listings.ts/admin.ts)
 * catch và dịch sang thông báo tiếng Việt / silent return / audit block.
 */
export async function assertSellerPublicationAllowed(sellerId: string): Promise<void> {
  const check = await checkSellerPublicationRequirements(sellerId);
  if (!check.ok) {
    throw new Error(`SELLER_PUBLICATION_BLOCKED:${check.missing.join(",")}`);
  }
}
