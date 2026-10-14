/**
 * Quy tắc chợ (Marketplace Rules) — nội dung chính sách, spec §3.1
 * legal/policy readiness (Batch 8 Task 1).
 *
 * BẢN NHÁP DO CLAUDE SOẠN THEO YÊU CẦU CỦA FOUNDER (2026-10-12) — chờ founder
 * sửa và duyệt (FD-3, FD-R34). Status vẫn DRAFT-NOT-REVIEWED trong registry
 * cho tới khi founder duyệt; mọi chỗ `[... — founder điền]` là dữ kiện chỉ
 * founder cung cấp được. Số liệu trích từ hằng số thật: khoảng giá
 * PRICE_MIN/PRICE_MAX (src/lib/listing-schema.ts). Khi duyệt: hash sha256 của
 * POLICY_TEXT ghi vào docs/operations/policy-review-record.md (Decision ==
 * APPROVED) — flip status sang REVIEWED trong src/lib/policy-registry.ts,
 * cùng commit.
 *
 * Plain module (KHÔNG server-only, KHÔNG db) — import được bởi page
 * app/policies/[key] lẫn script tsx offline (scripts/policy-hash.ts).
 * Hash chỉ phủ POLICY_TEXT — status/version sống trong registry, KHÔNG ở
 * đây (S1: flip status không phá hash đã ghi).
 */
export const POLICY_TEXT = `# Quy tắc chợ (BẢN NHÁP — chờ founder duyệt)

> Bản nháp do trợ lý soạn theo yêu cầu của founder; chưa có hiệu lực cho tới khi founder duyệt. Nên nhờ người có chuyên môn pháp lý rà soát Điều khoản và Chính sách quyền riêng tư.

## 1. LoaViet hoạt động như thế nào

LoaViet là nơi đăng tin và nhắn tin để mua bán loa Bluetooth di động. Người mua tìm tin, nhắn tin cho người bán, hai bên tự thỏa thuận giá, cách thanh toán và cách giao nhận. Mọi khoản tiền được trả trực tiếp giữa người mua và người bán, bên ngoài LoaViet. LoaViet không giữ tiền, không nhận đặt cọc, không thu hộ và không hoàn tiền.

## 2. Sản phẩm được đăng

- Trong giai đoạn beta, tin đăng mới chỉ được mở cho danh mục loa Bluetooth di động.
- Mỗi tin có thể ghi kèm phụ kiện đi theo sản phẩm (sạc, cáp, dây đeo, hộp, giấy tờ mua hàng).
- Việc mở thêm danh mục khác hoặc cho đăng riêng phụ kiện sẽ được LoaViet thông báo khi có quyết định.

## 3. Sản phẩm và tin đăng bị cấm

- Hàng giả, hàng nhái, hàng giả mạo nhãn hiệu hoặc mô tả sai về hãng, mẫu.
- Hàng do trộm cắp, chiếm đoạt hoặc không rõ quyền sở hữu.
- Hàng hóa mà pháp luật Việt Nam cấm kinh doanh.
- Sản phẩm không có thật, không còn trong tay người bán, hoặc tin đăng chỉ để thu hút liên hệ.
- Tin không phải để bán một chiếc loa cụ thể (ví dụ tin tuyển dụng, quảng cáo dịch vụ, tin tìm mua, rao trao đổi).
- Nội dung chứa thông tin cá nhân của người khác hoặc đường link thanh toán.

## 4. Giá

- Giá ghi bằng đồng Việt Nam (VND), là giá thật cho đúng sản phẩm trong tin.
- Giá trong tin phải nằm trong khoảng từ 100.000 ₫ đến 2.000.000.000 ₫.
- Ghi rõ giá có thương lượng hay không. Không đăng giá ảo, giá mồi thấp bất thường để kéo khách rồi đòi giá khác.
- LoaViet hiện không thu phí đăng tin hay hoa hồng trên giao dịch trong giai đoạn beta.

## 5. Mua bán công bằng

- Người bán mô tả trung thực tình trạng, lỗi, lịch sử sửa chữa và phụ kiện.
- Hai bên thống nhất rõ giá, cách thanh toán, cách giao nhận trước khi gặp hoặc gửi hàng.
- Giữ đúng hẹn; nếu thay đổi, báo trước cho bên kia.
- Người mua được quyền kiểm tra sản phẩm trước khi trả tiền; người bán nên tạo điều kiện cho việc này.
- Không gây áp lực, hối thúc hay đe dọa để ép giao dịch.

## 6. Ghi nhận kết quả giao dịch

- Từ cuộc trò chuyện, người mua có thể tạo một bản ghi giao dịch để hai bên cùng ghi nhận kết quả.
- Mỗi bên tự đánh dấu kết quả của mình (thành công, không thành, đã hủy). Kết quả đã đánh dấu không sửa lại được, vì vậy hãy đánh dấu trung thực.
- Giá thỏa thuận và hình thức giao nhận (gặp trực tiếp, người bán giao, gửi qua đơn vị vận chuyển, khác) chỉ là ghi chép do người dùng tự nhập. LoaViet không thu khoản tiền này và không xác nhận giao dịch đã diễn ra như ghi chép.
- Khi hai bên ghi nhận khác nhau, LoaViet lưu nguyên cả hai và không phân xử.

## 7. Duyệt và gỡ tin

- Tin đăng phải đủ thông tin bắt buộc và có thể được xem xét trước khi hiển thị công khai.
- LoaViet có thể từ chối hoặc gỡ tin vi phạm Quy tắc chợ, Quy tắc người bán hoặc Quy tắc cộng đồng. Tin bị gỡ do kiểm duyệt chỉ được khôi phục thông qua kháng cáo.

## 8. Giới hạn vai trò của LoaViet

LoaViet không kiểm định sản phẩm, không xác nhận nguồn gốc, tình trạng hay chất lượng sản phẩm, và không cam kết kết quả của bất kỳ giao dịch nào. Thông tin trong tin đăng là do người bán cung cấp. Hãy đọc Hướng dẫn an toàn giao dịch trước khi gặp mặt hoặc trả tiền.

## 9. Báo cáo

Nếu thấy tin đăng hoặc người dùng vi phạm, hãy dùng chức năng báo cáo trên tin đăng, hồ sơ người dùng hoặc trong cuộc trò chuyện. Báo cáo được quản trị viên xem xét thủ công.
`;
