/**
 * Deal vocabularies — PURE, client-safe (Batch 6 Task 2 — spec §5.2/§7.1).
 *
 * Module THUẦN cho client: chỉ hằng số + hàm thuần — KHÔNG import db client,
 * KHÔNG mang import ràng buộc môi trường server, KHÔNG import module limiter
 * (hợp đồng client-safe pin bằng source-contract test — form Deal Task 6
 * import trực tiếp từ đây). Server code import qua `src/lib/deal.ts`
 * (re-export `export *` — moderation.ts precedent). Rate rules dùng
 * structural type `{ limit, windowMs }` (khớp RateLimitRule của limiter
 * hiện có) — không cần import gì từ module limiter (B3 precedent).
 *
 * Non-invention pins (spec §4.11): DEAL_STATUSES / DEAL_FULFILLMENT_METHODS
 * là §5.2 VERBATIM; DEAL_OUTCOMES là recorded decision D3 (giá trị marking
 * per party — KHÔNG phải trạng thái deal); hai seam listing-status là Q10
 * (drift-test liệt kê mọi giá trị listing_status từ contract — chỉ
 * "approved" được). Bounds giá D5: bound THẬT của repo (PRICE_MIN/PRICE_MAX
 * trong listing-schema.ts — nguồn create-validation; drift-test giữ đồng bộ,
 * corrections #21 — KHÔNG phát minh policy giá).
 *
 * KHÔNG có CHAT_IMAGE_URL_PATTERN ở đây — chat imageUrl validation REUSE
 * LISTING_IMAGE_URL_PATTERN từ src/lib/listing-images.ts của Batch 4 (S3:
 * uuid-upload strict, không tự chế pattern mới, không /img allowance).
 */

// ─── Deal status (spec §5.2 verbatim — đúng 4 giá trị, đúng thứ tự) ────────────

/** Bốn trạng thái Deal — spec §5.2 verbatim (khớp enum deal_status, Task 1). */
export const DEAL_STATUSES = ["open", "completed", "cancelled", "no_deal"] as const;
export type DealStatus = (typeof DEAL_STATUSES)[number];

// ─── Fulfillment method (spec §5.2 verbatim — drift với listing-schema) ────────

/**
 * Bốn phương thức giao nhận — spec §5.2 verbatim (khớp enum
 * deal_fulfillment_method, Task 1). Drift-test bằng với
 * LISTING_FULFILLMENT_METHODS của src/lib/listing-schema.ts (corrections #20
 * — cùng vocabulary §5.2/A7; label hiển thị dùng FULFILLMENT_METHOD_LABELS
 * của src/lib/constants.ts, KHÔNG map riêng cho Deal).
 */
export const DEAL_FULFILLMENT_METHODS = [
  "meetup",
  "seller_delivery",
  "carrier",
  "other",
] as const;
export type DealFulfillmentMethod = (typeof DEAL_FULFILLMENT_METHODS)[number];

// ─── Outcome per party (RECORDED DECISION D3 — không phải trạng thái deal) ────

/**
 * Giá trị marking per party — RECORDED DECISION D3:
 *  - "success"   = bên này xác nhận hoàn tất thành công → góp phần hoàn tất
 *                  song phương (successful_match chỉ khi CẢ HAI success)
 *  - "no_deal"   = bên này ghi nhận không đạt thỏa thuận
 *  - "cancelled" = bên này ghi nhận thỏa thuận đã hủy
 * Immutable một khi đã mark (re-submit cùng giá trị = no-op; khác giá trị =
 * DEAL_ALREADY_MARKED — đường sửa sai là ops reconciliation A1, Batch 8).
 */
export const DEAL_OUTCOMES = ["success", "no_deal", "cancelled"] as const;
export type DealOutcome = (typeof DEAL_OUTCOMES)[number];

/** Trạng thái kết thúc — deal terminal thì buyer được tạo deal MỚI (D4/S11). */
export const TERMINAL_DEAL_STATUSES = ["completed", "cancelled", "no_deal"] as const;

/** Trạng thái Deal có phải terminal không (pure lookup). */
export function isTerminalDealStatus(s: DealStatus): boolean {
  return (TERMINAL_DEAL_STATUSES as readonly string[]).includes(s);
}

// ─── Listing-status seams (Q10 — drift-tested, SEARCHABLE_LISTING_STATUSES pattern) ──

/**
 * D1 — chỉ listing CÔNG KHAI mở hội thoại MỚI. Drift-test liệt kê MỌI giá trị
 * listing_status từ contract: draft/pending/rejected/hidden/sold/removed/
 * archived đều từ chối (chỉ "approved" resolve). Hội thoại CŨ mở lại BẤT KỂ
 * status (redirect branch của startConversationAction — không phải "new chat"
 * §7.8, không đốt budget rate limit).
 */
export const CONVERSATION_STARTABLE_LISTING_STATUSES = ["approved"] as const;

/** §5.2 "live eligible listing" — Deal chỉ tạo trên listing đang công khai. */
export const DEAL_CREATE_LISTING_STATUSES = ["approved"] as const;

// ─── Rate rules (§7.1 — structural, dùng với checkRateLimit của limiter hiện có) ──

/** 20 hội thoại mới / 10 phút / user (§7.1 "chat" — Task 3 wired). */
export const CONVERSATION_START_RATE = { limit: 20, windowMs: 10 * 60_000 } as const;

/** 20 create + outcome / giờ / user (§7.1 "Deal mutation" — Tasks 4/5 wired). */
export const DEAL_MUTATION_RATE = { limit: 20, windowMs: 60 * 60_000 } as const;

// ─── Message limits (server-enforced — Task 3) ────────────────────────────────

/**
 * Giới hạn chiều dài tin nhắn — khớp maxLength input client hiện có, giờ
 * enforce ở server (POST /api/chat/[id] — client maxLength chỉ là UX).
 */
export const CHAT_MESSAGE_MAX_LENGTH = 2_000;

// ─── Deal input bounds (D5 — bound THẬT của repo, không phát minh policy) ─────

/**
 * Bound giá thỏa thuận = bound giá create-validation THẬT của repo
 * (PRICE_MIN/PRICE_MAX trong src/lib/listing-schema.ts — D5, corrections #21;
 * drift-test giữ đồng bộ). agreedPrice là bản ghi người dùng TỰ NHẬP —
 * LoaViet KHÔNG bao giờ thu tiền này trong P0 (§5.2); rỗng → null (deal
 * không có thành phần tiền thì bỏ trống).
 */
export const DEAL_AGREED_PRICE_MIN = 100_000;
export const DEAL_AGREED_PRICE_MAX = 2_000_000_000;

/** cancellationReason ≤500 ký tự — untrusted input, KHÔNG vào telemetry (§4.8). */
export const DEAL_CANCELLATION_REASON_MAX = 500;
