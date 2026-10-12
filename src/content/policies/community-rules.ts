/**
 * Quy tắc cộng đồng (Community Rules) — nội dung chính sách, spec §3.1
 * legal/policy readiness (Batch 8 Task 1).
 *
 * BẢN NHÁP DO CLAUDE SOẠN THEO YÊU CẦU CỦA FOUNDER (2026-10-12) — chờ founder
 * sửa và duyệt (FD-3, FD-R34; sanction policy FD-R6, appeal workflow FD-R8).
 * Status vẫn DRAFT-NOT-REVIEWED trong registry cho tới khi founder duyệt; mọi
 * chỗ `[... — founder điền]` là dữ kiện chỉ founder cung cấp được. Mechanics
 * đối chiếu docs/operations/moderation-playbook.md (sanction thủ công, vô
 * thời hạn cho tới khi lift; appeal ≤ APPEAL_STATEMENT_MAX_LENGTH ký tự, một
 * appeal mỗi case). Khi duyệt: hash sha256 của POLICY_TEXT ghi vào
 * docs/operations/policy-review-record.md (Decision == APPROVED) — flip
 * status sang REVIEWED trong src/lib/policy-registry.ts, cùng commit.
 *
 * Plain module (KHÔNG server-only, KHÔNG db) — import được bởi page
 * app/policies/[key] lẫn script tsx offline (scripts/policy-hash.ts).
 * Hash chỉ phủ POLICY_TEXT — status/version sống trong registry, KHÔNG ở
 * đây (S1: flip status không phá hash đã ghi).
 */
export const POLICY_TEXT = `# Quy tắc cộng đồng (BẢN NHÁP — chờ founder duyệt)

> Bản nháp do trợ lý soạn theo yêu cầu của founder; chưa có hiệu lực cho tới khi founder duyệt. Nên nhờ người có chuyên môn pháp lý rà soát Điều khoản và Chính sách quyền riêng tư.

LoaViet là cộng đồng nhỏ của những người mua bán loa Bluetooth di động. Các quy tắc dưới đây áp dụng cho mọi tin đăng, hồ sơ, tin nhắn, báo cáo và kháng cáo.

## 1. Tôn trọng nhau

- Giao tiếp lịch sự, kể cả khi không đồng ý về giá hay không mua nữa.
- Không xúc phạm, miệt thị, phân biệt đối xử về giới tính, vùng miền, dân tộc, tôn giáo hay bất kỳ đặc điểm cá nhân nào.
- Không quấy rối, đe dọa, đeo bám; khi người kia đã từ chối hoặc chặn bạn, không tìm cách liên hệ bằng tài khoản khác.

## 2. Không lừa đảo, không mạo danh

- Không đăng sản phẩm không có thật, không mô tả sai sự thật, không đổi hàng khi giao.
- Không giả danh người khác, giả danh LoaViet hay quản trị viên LoaViet.
- Không yêu cầu OTP, mật khẩu; không gửi đường link thanh toán lạ; không nói rằng LoaViet giữ tiền hay nhận cọc.

## 3. Không spam

- Không gửi cùng một tin nhắn hàng loạt, không quảng cáo dịch vụ hay sản phẩm khác trong tin nhắn.
- Không đăng trùng tin, không nhồi từ khóa, không dùng tin nhắn để kéo người dùng sang nền tảng khác với mục đích quảng cáo.

## 4. Nội dung đúng chủ đề và hợp pháp

- Nội dung phải liên quan tới việc mua bán loa trên LoaViet.
- Không đăng nội dung khiêu dâm, bạo lực, kích động, vi phạm pháp luật hoặc vi phạm quyền sở hữu trí tuệ.
- Không công khai thông tin cá nhân của người khác (số điện thoại, địa chỉ, giấy tờ) khi họ không đồng ý.

## 5. Báo cáo và chặn

- Bạn có thể báo cáo một tin đăng, một người dùng hoặc một tin nhắn. Lý do báo cáo gồm: nghi lừa đảo, quấy rối, spam, nghi hàng giả, tin đăng sai lệch, nội dung bị cấm, hành vi nguy hiểm, mạo danh, lý do khác.
- Khi bạn gửi báo cáo, LoaViet lưu một bản chụp nội dung bị báo cáo tại thời điểm đó làm bằng chứng. Bằng chứng vẫn được giữ kể cả khi nội dung gốc bị sửa hoặc xóa, và chỉ quản trị viên được phân quyền mới xem được.
- Bạn có thể chặn một người dùng. Chặn sẽ ngăn cuộc trò chuyện mới và tin nhắn mới theo cả hai chiều, và ngăn tạo giao dịch mới giữa hai bên. Chặn không xóa lịch sử trò chuyện hay bằng chứng đã có.
- Không lạm dụng báo cáo để quấy rối người khác. Số lần báo cáo bị giới hạn để chống lạm dụng.

## 6. Xử lý vi phạm

- Báo cáo được quản trị viên xem xét thủ công. Quản trị viên có liên quan trực tiếp tới vụ việc không được xử lý vụ việc đó.
- Tùy mức độ, LoaViet có thể: từ chối hoặc gỡ tin đăng; thu hồi xác minh người bán; tạm dừng tư cách thành viên beta; đình chỉ tài khoản.
- Tài khoản bị đình chỉ không thể đăng tin, mở cuộc trò chuyện mới, gửi tin nhắn mới hay tạo giao dịch mới.
- Trong giai đoạn beta, các biện pháp xử lý không tự hết hạn: chúng có hiệu lực cho tới khi được quản trị viên gỡ bỏ.
- Hành vi có dấu hiệu vi phạm pháp luật có thể được chuyển tới cơ quan có thẩm quyền.
- Mọi quyết định xử lý được ghi lại kèm lý do.

## 7. Kháng cáo

- Nếu bạn là người bị xử lý trong một vụ việc, bạn có thể gửi kháng cáo qua trang kháng cáo trong ứng dụng (đường dẫn được gửi kèm thông báo xử lý, hoặc đội ngũ LoaViet liên hệ để cung cấp).
- Mỗi quyết định được kháng cáo một lần; phần trình bày tối đa 4.000 ký tự. Hãy nêu rõ lý do và thông tin bạn cho là bị bỏ sót.
- Kháng cáo được xem xét thủ công. Thời gian và quy trình xét kháng cáo: [thời hạn và quy trình xét kháng cáo — founder điền].
- Tin đăng bị gỡ do kiểm duyệt chỉ có thể được khôi phục thông qua kết quả kháng cáo.

## 8. Liên hệ

Câu hỏi về quy tắc cộng đồng: [email liên hệ — founder điền].
`;
