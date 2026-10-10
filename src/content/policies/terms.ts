/**
 * Điều khoản sử dụng (Terms) — nội dung chính sách, spec §3.1 legal/policy
 * readiness (Batch 8 Task 1).
 *
 * PLACEHOLDER — DRAFT-NOT-REVIEWED (FD-3): toàn bộ văn bản pháp lý do
 * FOUNDER soạn và duyệt; implementer KHÔNG soạn nội dung (spec §4.11 Policy
 * Non-Invention — không điều khoản chấp nhận, không số liệu lưu trữ, không
 * phân cấp chế tài, không khung mục). Bản duyệt của founder thay thế toàn bộ
 * nội dung này; hash sha256 của POLICY_TEXT ghi vào
 * docs/operations/policy-review-record.md (Decision == APPROVED) — flip
 * status sang REVIEWED trong src/lib/policy-registry.ts, cùng commit.
 *
 * Plain module (KHÔNG server-only, KHÔNG db) — import được bởi page
 * app/policies/[key] lẫn script tsx offline (scripts/policy-hash.ts).
 * Hash chỉ phủ POLICY_TEXT — status/version sống trong registry, KHÔNG ở
 * đây (S1: flip status không phá hash đã ghi).
 */
export const POLICY_TEXT = `# Điều khoản sử dụng (DRAFT-NOT-REVIEWED)

> ⚠️ BẢN DỰ THẢO — CHƯA ĐƯỢC DUYỆT. Nội dung pháp lý do founder soạn và duyệt
> (FD-3, spec §4.11) — bản này chưa có hiệu lực cho phiên bản beta.

[nội dung chờ founder — terms]
`;
