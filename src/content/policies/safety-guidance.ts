/**
 * Hướng dẫn an toàn giao dịch (Safety Guidance) — nội dung chính sách,
 * spec §3.1 legal/policy readiness (Batch 8 Task 1).
 *
 * BẢN NHÁP DO CLAUDE SOẠN THEO YÊU CẦU CỦA FOUNDER (2026-10-12) — chờ founder
 * sửa và duyệt (FD-3, FD-R28, FD-R34). Status vẫn DRAFT-NOT-REVIEWED trong
 * registry cho tới khi founder duyệt; mọi chỗ `[... — founder điền]` là dữ
 * kiện chỉ founder cung cấp được. Văn bản PHẢI giữ nguyên văn sáu điểm spec
 * §6.4 + dòng §5.2 (bản dịch Batch 6 — trùng src/components/safety-guidance.tsx);
 * presence được ghim trong tests/unit/policy-registry.test.ts và
 * tests/unit/copy-safety.test.ts. Khi duyệt: hash sha256 của POLICY_TEXT ghi
 * vào docs/operations/policy-review-record.md (Decision == APPROVED) — flip
 * status sang REVIEWED trong src/lib/policy-registry.ts, cùng commit.
 *
 * Plain module (KHÔNG server-only, KHÔNG db) — import được bởi page
 * app/policies/[key] lẫn script tsx offline (scripts/policy-hash.ts).
 * Hash chỉ phủ POLICY_TEXT — status/version sống trong registry, KHÔNG ở
 * đây (S1: flip status không phá hash đã ghi).
 */
export const POLICY_TEXT = `# Hướng dẫn an toàn giao dịch (BẢN NHÁP — chờ founder duyệt)

> Bản nháp do trợ lý soạn theo yêu cầu của founder; chưa có hiệu lực cho tới khi founder duyệt. Nên nhờ người có chuyên môn pháp lý rà soát Điều khoản và Chính sách quyền riêng tư.

Thanh toán và giao nhận hàng diễn ra độc lập ngoài LoaViet.

LoaViet giúp bạn tìm loa và nhắn tin với người bán. LoaViet không giữ tiền, không nhận cọc, không kiểm định sản phẩm và không đứng ra thanh toán hay hoàn tiền. Hướng dẫn này giúp bạn giảm rủi ro, nhưng không phải là một cam kết hay sự bồi hoàn nếu giao dịch gặp vấn đề.

## 1. Sáu nguyên tắc cơ bản

- Thanh toán và giao nhận hàng do bạn và người bán tự thỏa thuận, diễn ra độc lập ngoài LoaViet.
- Kiểm tra kỹ tình trạng sản phẩm trước khi thanh toán.
- Ưu tiên gặp gỡ, kiểm tra thử loa ở nơi công cộng phù hợp.
- Không bao giờ chia sẻ mã OTP hoặc mật khẩu cho bất kỳ ai.
- Cẩn trọng với các đường link thanh toán đáng ngờ.
- Nếu gặp vấn đề, dùng chức năng báo cáo hoặc chặn người dùng.

## 2. Trước khi hẹn gặp

- Trao đổi qua tin nhắn trên LoaViet để có lịch sử rõ ràng. Hỏi kỹ về tình trạng, lỗi, lịch sử sửa chữa, phụ kiện và lý do bán.
- Đối chiếu ảnh trong tin với mô tả; đề nghị người bán chụp thêm ảnh hoặc quay video loa đang phát nếu cần.
- Thống nhất trước giá, cách thanh toán và việc được kiểm tra loa trước khi trả tiền.
- Chọn nơi công cộng, đông người, có camera (ví dụ quán cà phê, sảnh trung tâm thương mại), vào ban ngày. Báo cho người thân biết bạn đi đâu, gặp ai.
- Cẩn trọng với giá rẻ bất thường so với mặt bằng chung, hoặc người bán hối thúc, đòi chốt ngay.

## 3. Khi kiểm tra loa

- Bật nguồn, kết nối Bluetooth với chính điện thoại của bạn và phát nhạc bạn quen.
- Nghe thử ở mức âm lượng nhỏ, vừa và lớn; chú ý tiếng rè, méo, mất kênh, chập chờn.
- Thử mọi nút bấm, cổng sạc, cổng kết nối; sạc thử nếu có thể.
- Hỏi về tình trạng pin; quan sát vỏ, lưới loa, gioăng chống nước (nếu có), vết nứt hoặc dấu hiệu đã mở máy.
- Đối chiếu hãng, mẫu, tem hoặc số serie trên loa với hộp và giấy tờ (nếu có). Kiểm tra đủ phụ kiện như đã ghi trong tin.

## 4. Khi thanh toán

- Không chuyển tiền trước khi đã thấy và kiểm tra hàng, đặc biệt với người bạn chưa từng giao dịch.
- Không đặt cọc để "giữ hàng" cho người lạ.
- Nếu không thể gặp trực tiếp và phải gửi hàng qua đơn vị vận chuyển, hãy thỏa thuận rõ với người bán về cách thanh toán và việc kiểm tra hàng khi nhận; tự đánh giá rủi ro trước khi đồng ý.
- Kiểm tra kỹ tên chủ tài khoản trước khi chuyển khoản; giữ lại biên lai và lịch sử tin nhắn.
- LoaViet không bao giờ yêu cầu bạn chuyển tiền cho LoaViet hay cho bất kỳ ai "để LoaViet giữ". Ai nói như vậy đều là giả mạo.

## 5. Dấu hiệu lừa đảo thường gặp

- Gửi đường link lạ để "nhận tiền", "xác nhận đơn" hoặc "đăng nhập LoaViet".
- Yêu cầu bạn đọc mã OTP hoặc cung cấp mật khẩu.
- Mạo danh quản trị viên LoaViet, ngân hàng hoặc đơn vị vận chuyển.
- Đòi chuyển sang ứng dụng khác ngay từ đầu, từ chối cho xem hàng, đổi người nhận tiền vào phút chót.

## 6. Báo cáo và chặn

- Dùng nút báo cáo trên tin đăng, trên hồ sơ người bán hoặc trong cuộc trò chuyện. Chọn lý do phù hợp và mô tả ngắn gọn sự việc.
- Dùng chức năng chặn để ngừng nhận tin nhắn từ một người dùng. Lịch sử trò chuyện vẫn được giữ làm bằng chứng.
- Báo cáo được quản trị viên xem xét thủ công. Nếu cần trao đổi thêm: [email liên hệ — founder điền].
- Nếu bạn gặp nguy hiểm hoặc bị chiếm đoạt tài sản, hãy liên hệ ngay công an (113) hoặc cơ quan công an nơi gần nhất.
`;
