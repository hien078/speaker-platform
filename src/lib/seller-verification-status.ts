/**
 * Public "verified seller" badge (review fix Task 10 — spec §4.2 không hứa
 * sai, §8.2 workflow canonical, §6.2 copy, §4.8 không PII).
 *
 * Legacy `User.isVerifiedSeller` KHÔNG còn nguồn cho badge công khai: boolean
 * đã ĐÓNG BĂNG (không còn đường mutate từ Task 10 — revoked seller giữ mãi
 * badge cũ, seller verified mới không bao giờ có) → badge đọc từ workflow
 * `SellerVerification.status === "verified"` (trạng thái SỐNG — thu hồi là
 * badge tắt ngay).
 *
 * Plain module (KHÔNG db, KHÔNG server-only): caller (server component) tự
 * query status — include lồng (`seller → sellerVerification`) hoặc
 * `SellerVerification.first({ userId })` — rồi gọi `isVerifiedSellerStatus`.
 * KHÔNG PII: chỉ đọc status (enum), không đụng email/phone.
 *
 * Copy §6.2: nhãn hiển thị dùng ĐÚNG câu trung tính
 * "Đã xác minh thông tin người bán theo yêu cầu hiện tại của LoaViet." —
 * không bao giờ ngôn ngữ bảo đảm/đảm bảo/chứng nhận (spec §6.2 avoid-list).
 */

/** Nhãn badge §6.2 — dùng nguyên văn, KHÔNG rút gọn thành hứa hẹn. */
export const SELLER_VERIFIED_BADGE_LABEL =
  "Đã xác minh thông tin người bán theo yêu cầu hiện tại của LoaViet.";

/**
 * Trạng thái workflow có phải "đã xác minh người bán" không? (spec §8.2 —
 * SellerVerification là canonical; chỉ `verified` được badge công khai.)
 */
export function isVerifiedSellerStatus(status: string | null | undefined): boolean {
  return status === "verified";
}
