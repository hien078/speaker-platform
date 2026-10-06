/**
 * Hướng dẫn an toàn giao dịch (Safety Guidance) — nội dung chính sách,
 * spec §3.1 legal/policy readiness (Batch 8 Task 1).
 *
 * PLACEHOLDER — DRAFT-NOT-REVIEWED (FD-3): toàn bộ văn bản pháp lý do
 * FOUNDER soạn và duyệt; implementer KHÔNG soạn nội dung (spec §4.11 Policy
 * Non-Invention). Ngoại lệ DUY NHẤT cho placeholder: sáu điểm spec §6.4 +
 * dòng §5.2 (spec-sourced — bản dịch tiếng Việt của văn bản spec, không phải
 * văn bản do implementer bịa; Batch 8 duyệt bản chính thức). Bản duyệt của
 * founder thay thế toàn bộ nội dung này; hash sha256 của POLICY_TEXT ghi
 * vào docs/operations/policy-review-record.md (Decision == APPROVED) — flip
 * status sang REVIEWED trong src/lib/policy-registry.ts, cùng commit.
 *
 * Plain module (KHÔNG server-only, KHÔNG db) — import được bởi page
 * app/policies/[key] lẫn script tsx offline (scripts/policy-hash.ts).
 * Hash chỉ phủ POLICY_TEXT — status/version sống trong registry, KHÔNG ở
 * đây (S1: flip status không phá hash đã ghi).
 */
export const POLICY_TEXT = `# Hướng dẫn an toàn giao dịch (DRAFT-NOT-REVIEWED)

> ⚠️ BẢN DỰ THẢO — CHƯA ĐƯỢC DUYỆT. Nội dung pháp lý do founder soạn và duyệt
> (FD-3, spec §4.11) — bản này chưa có hiệu lực cho phiên bản beta.

[nội dung chờ founder — safety_guidance]

Sáu điểm spec §6.4 (bản dịch tiếng Việt — chờ founder duyệt bản chính thức):
- Thanh toán và giao nhận hàng do bạn và người bán tự thỏa thuận, diễn ra độc lập ngoài LoaViet.
- Kiểm tra kỹ tình trạng sản phẩm trước khi thanh toán.
- Ưu tiên gặp gỡ, kiểm tra thử loa ở nơi công cộng phù hợp.
- Không bao giờ chia sẻ mã OTP hoặc mật khẩu cho bất kỳ ai.
- Cẩn trọng với các đường link thanh toán đáng ngờ.
- Nếu gặp vấn đề, dùng chức năng báo cáo hoặc chặn người dùng.

Thanh toán và giao nhận hàng diễn ra độc lập ngoài LoaViet.
`;
