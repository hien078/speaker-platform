/** Nhãn tiếng Việt cho các enum — dùng chung toàn app */
import { PROVINCES } from "@/src/lib/provinces";
import type {
  ReportReasonCode,
  ModerationCaseState,
  ModerationPriority,
  ModerationDecisionReasonCode,
  ModerationAssignmentReasonCode,
  ModerationActionType,
  SuspensionReasonCode,
} from "@/src/lib/moderation-vocab";
// type-only (xoá khi compile) — constants.ts vẫn client-safe; map thiếu key fail typecheck.
import type { InventoryContext, ListingFulfillmentMethod, PhotoChecklistSlot } from "@/src/lib/listing-schema";

export const ROLE_LABELS: Record<string, string> = {
  buyer: "Người mua",
  seller: "Người bán",
  admin: "Quản trị",
};

export const LISTING_STATUS_LABELS: Record<string, string> = {
  draft: "Nháp",
  pending: "Chờ duyệt",
  approved: "Đang bán",
  rejected: "Bị từ chối",
  hidden: "Đã ẩn",
  sold: "Đã bán",
  // R8 (Batch 3 ↔ 4 Reconciliation): moderation takedown (R4) — seller /sell/my
  // + console render trạng thái với nhãn con người; Batch 4 Task 5 chỉ thêm
  // `archived`. KHÔNG dùng cho seller self-hide.
  removed: "Đã gỡ bởi kiểm duyệt",
  // §5.6.2 lifecycle — reserved, chưa có transition nào trong Batch 4 ghi giá trị
  archived: "Đã lưu trữ",
};

export const LISTING_STATUS_BADGE: Record<string, string> = {
  draft: "bg-zinc-700/60 text-zinc-300",
  pending: "bg-amber-500/15 text-amber-400",
  approved: "bg-emerald-500/15 text-emerald-400",
  rejected: "bg-red-500/15 text-red-400",
  hidden: "bg-zinc-700/60 text-zinc-300",
  sold: "bg-sky-500/15 text-sky-400",
  // R8 — badge cho `removed` (moderation takedown)
  removed: "bg-red-500/15 text-red-400",
  // §5.6.2 lifecycle — reserved (Batch 4 Task 5)
  archived: "bg-zinc-700/60 text-zinc-400",
};

export const CONDITION_LABELS: Record<string, string> = {
  new: "Mới nguyên seal",
  open_box: "Mở hộp chưa dùng",
  like_new: "Gần mới",
  excellent: "Rất tốt",
  good: "Còn tốt",
  fair: "Cũ, còn dùng tốt",
  refurbished: "Tái chế / sửa chính hãng",
  for_parts: "Lấy linh kiện",
};

export const ORDER_STATUS_LABELS: Record<string, string> = {
  awaiting_payment: "Chờ thanh toán",
  paid_escrow: "Đã trả tiền (escrow)",
  processing: "Seller chuẩn bị hàng",
  shipped: "Đang giao hàng",
  completed: "Hoàn tất",
  cancelled: "Đã hủy",
  refunded: "Đã hoàn tiền",
  disputed: "Có khiếu nại",
};

export const ORDER_STATUS_BADGE: Record<string, string> = {
  awaiting_payment: "bg-amber-500/15 text-amber-400",
  paid_escrow: "bg-violet-500/15 text-violet-400",
  processing: "bg-sky-500/15 text-sky-400",
  shipped: "bg-blue-500/15 text-blue-400",
  completed: "bg-emerald-500/15 text-emerald-400",
  cancelled: "bg-zinc-700/60 text-zinc-300",
  refunded: "bg-orange-500/15 text-orange-400",
  disputed: "bg-red-500/15 text-red-400",
};

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  escrow: "Qua nền tảng (escrow)",
  direct: "Chuyển khoản trực tiếp",
  cod: "COD — trả khi nhận hàng",
};

export const PAYMENT_STATUS_LABELS: Record<string, string> = {
  pending: "Đang chờ",
  held: "Escrow đang giữ",
  released: "Đã giải ngân",
  refunded: "Đã hoàn tiền",
  failed: "Thất bại",
};

export const EXCHANGE_STATUS_LABELS: Record<string, string> = {
  proposed: "Đã gửi đề nghị",
  accepted: "Đã chấp nhận — chờ cọc",
  paid: "Tiền bù trong escrow",
  completed: "Hoàn tất trao đổi",
  rejected: "Bị từ chối",
  cancelled: "Đã hủy",
};

export const DISPUTE_STATUS_LABELS: Record<string, string> = {
  open: "Đang xử lý",
  resolved_buyer: "Nghiêng về người mua",
  resolved_seller: "Nghiêng về người bán",
  closed: "Đã đóng",
};

/**
 * Khu vực lọc /listings + select form legacy (FD-1 — Batch 4 Task 5 refresh).
 *
 * 34 displayName chuẩn của registry src/lib/provinces.ts (NQ 202/2025/QH15 —
 * derive THẲNG TỪ registry, không copy tay cho không trôi) + "Khác". Tên stale
 * pre-merger của các tỉnh đã sáp nhập KHÔNG còn trong list — tên đơn vị mới
 * ("Huế", "TP. Hồ Chí Minh"…) có mặt. Listing beta ghi city =
 * PROVINCE_CODES[code] nên filter exact-match khớp; listing legacy giữ
 * free-text cũ (filter debt — KHÔNG backfill, spec §8.3; form select render
 * option riêng cho stored value ngoài list — item 11).
 */
export const CITIES = [...PROVINCES.map((p) => p.displayName), "Khác"];

// ─── Batch 4 — structured portable-speaker listing (spec §5.6/§5.6.3/§5.2) ──────

/**
 * PROVISIONAL (A1/FD-3): nhãn inventory context là founder-authored content
 * pending — Batch 8 Founder Decision Register; giá trị hiện tại theo comment
 * enum contract (mới / mở hộp chưa dùng / đã qua sử dụng), founder có thể đổi
 * additive trước beta. Định nghĩa từng grade (và chồng lấn new/open_box với
 * product_condition) = A1 — KHÔNG bịa ở đây.
 */
export const INVENTORY_CONTEXT_LABELS: Record<InventoryContext, string> = {
  new: "Mới / nguyên seal",
  open_box: "Mở hộp chưa dùng",
  used: "Đã qua sử dụng",
};

/**
 * PROVISIONAL (A7/FD-3): mapping §5.2 (Deal fulfillment methods) — recorded
 * decision A7; nhãn tiếng Việt là founder-authored content pending (Batch 8
 * Founder Decision Register).
 */
export const FULFILLMENT_METHOD_LABELS: Record<ListingFulfillmentMethod, string> = {
  meetup: "Gặp trực tiếp",
  seller_delivery: "Người bán giao đến",
  carrier: "Gửi qua đơn vị vận chuyển",
  other: "Khác",
};

/**
 * PROVISIONAL (A2/FD-3): nhãn 8 slot ảnh §5.6.3 — founder-authored content
 * pending (Batch 8 Founder Decision Register); requiredness từng slot = A2
 * (KHÔNG slot nào bắt buộc — chỉ rule ≥1 ảnh hiện có).
 */
export const PHOTO_CHECKLIST_SLOT_LABELS: Record<PhotoChecklistSlot, string> = {
  front: "Mặt trước",
  back: "Mặt sau",
  control_panel: "Bảng điều khiển",
  ports: "Cổng sạc / kết nối",
  damage: "Vết xước / hư hại chính",
  accessories: "Phụ kiện đi kèm",
  box: "Hộp / vỏ (nếu có)",
  label_serial: "Nhãn / serial",
};

/**
 * Nhãn tiếng Việt cho chín lý do báo cáo lạm dụng — spec §5.5 verbatim
 * (Batch 3 Task 4; client-safe: type từ moderation-vocab — KHÔNG import
 * moderation.ts vì module đó đọc db).
 *
 * PROVISIONAL (A8/FD-3): label là founder-authored content pending — Batch 8
 * Founder Decision Register; giá trị hiện tại là placeholder rõ ràng, founder
 * có thể đổi qua thay đổi additive trước beta.
 */
export const REPORT_REASON_LABELS: Record<ReportReasonCode, string> = {
  suspected_scam: "Nghi lừa đảo",
  harassment: "Quấy rối",
  spam: "Spam",
  counterfeit_claim: "Nghi hàng giả",
  misleading_listing: "Tin đăng sai sự thật",
  prohibited_content: "Nội dung bị cấm",
  unsafe_behavior: "Hành vi không an toàn",
  identity_impersonation: "Mạo danh",
  other: "Khác",
};

// ─── Moderation console (Batch 3 Task 6 — spec §5.5) ──────────────────────────

/**
 * PROVISIONAL (A8 — FD-3): các label moderation dưới đây là founder-authored
 * content pending — Batch 8 Founder Decision Register; giá trị hiện tại là
 * placeholder rõ ràng, founder có thể đổi qua thay đổi additive trước beta
 * (vocabulary hằng số sống ở src/lib/moderation-vocab.ts — đổi GIÁ TRỊ là
 * additive; label map theo sau).
 */

/** Bảy trạng thái case — spec §5.5 verbatim (khớp enum moderation_case_state). */
export const MODERATION_CASE_STATE_LABELS: Record<ModerationCaseState, string> = {
  open: "Mới",
  triaged: "Đã phân loại",
  investigating: "Đang điều tra",
  actioned: "Đã xử lý",
  dismissed: "Bỏ qua",
  appealed: "Đang kháng cáo",
  closed: "Đã đóng",
};

/** Mức ưu tiên case — semantics SLA/escalation = Ambiguity A5 (chỉ là data). */
export const MODERATION_PRIORITY_LABELS: Record<ModerationPriority, string> = {
  low: "Thấp",
  normal: "Bình thường",
  high: "Cao",
};

/** Nhãn lý do đình chỉ — canonical (Task 6; thay map cục bộ ở actions/moderation.ts + admin/users). */
export const SUSPENSION_REASON_LABELS: Record<SuspensionReasonCode, string> = {
  confirmed_abuse: "Lạm dụng đã được xác nhận",
  confirmed_scam: "Lừa đảo đã được xác nhận",
  confirmed_harassment: "Quấy rối đã được xác nhận",
  confirmed_spam: "Spam đã được xác nhận",
  prohibited_content: "Đăng nội dung bị cấm",
  terms_violation: "Vi phạm điều khoản",
  other_reviewed_reason: "Lý do khác (đã review)",
};

/** Nhãn lý do quyết định (transition/takedown) — PROVISIONAL (A8). */
export const MODERATION_DECISION_REASON_LABELS: Record<ModerationDecisionReasonCode, string> = {
  no_violation_found: "Không tìm thấy vi phạm",
  insufficient_evidence: "Không đủ bằng chứng",
  policy_violation_confirmed: "Xác nhận vi phạm chính sách",
  resolved_by_sanction: "Đã xử lý bằng biện pháp",
  duplicate_case: "Trùng trường hợp khác",
  appeal_closed: "Kháng cáo đã đóng",
  other_reviewed_reason: "Lý do khác (đã review)",
};

/** Nhãn lý do phân công case — PROVISIONAL (A8). */
export const MODERATION_ASSIGNMENT_REASON_LABELS: Record<ModerationAssignmentReasonCode, string> = {
  triage_assignment: "Phân công phân loại",
  reassignment: "Phân công lại",
  other_reviewed_reason: "Lý do khác (đã review)",
};

/** Nhãn action type cho lịch sử case (section Hành động của case page). */
export const MODERATION_ACTION_TYPE_LABELS: Record<ModerationActionType, string> = {
  "evidence.captured": "Chụp bằng chứng",
  "case.assigned": "Phân công case",
  "case.transitioned": "Chuyển trạng thái",
  "listing.taken_down": "Gỡ tin đăng",
  "user.suspended": "Đình chỉ người dùng",
  "user.suspension_lifted": "Gỡ đình chỉ",
  "appeal.recorded": "Ghi nhận kháng cáo",
};
