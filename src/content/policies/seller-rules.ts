/**
 * Quy tắc người bán (Seller Rules) — nội dung chính sách, spec §3.1
 * legal/policy readiness (Batch 8 Task 1).
 *
 * BẢN NHÁP DO CLAUDE SOẠN THEO YÊU CẦU CỦA FOUNDER (2026-10-12) — chờ founder
 * sửa và duyệt (FD-3, FD-R34). Status vẫn DRAFT-NOT-REVIEWED trong registry
 * cho tới khi founder duyệt; mọi chỗ `[... — founder điền]` là dữ kiện chỉ
 * founder cung cấp được. Danh sách yêu cầu xác minh đối chiếu
 * checkSellerPublicationRequirements (src/lib/seller-verification-policy.ts);
 * số ảnh tối đa = LISTING_MAX_IMAGES, độ dài mô tả = DESCRIPTION_MAX
 * (src/lib/listing-schema.ts). Khi duyệt: hash sha256 của POLICY_TEXT ghi vào
 * docs/operations/policy-review-record.md (Decision == APPROVED) — flip
 * status sang REVIEWED trong src/lib/policy-registry.ts, cùng commit.
 *
 * FD-R4 (version tension): Batch 2 ghi PolicyAcceptance(seller_rules, v1)
 * chống CHÍNH placeholder trước đây — bản Seller Rules duyệt ĐẦU TIÊN phải
 * bump version v1 → v2 (SELLER_RULES_POLICY_VERSION trong
 * src/lib/seller-verification-policy.ts — commit của founder, kèm update
 * test publication-gate/acceptance; registry seller_rules.version theo).
 * Bản nháp này KHÔNG bump version. Pre-launch v1 acceptances chỉ tồn tại
 * trong dev/test.
 *
 * Plain module (KHÔNG server-only, KHÔNG db) — import được bởi page
 * app/policies/[key] lẫn script tsx offline (scripts/policy-hash.ts).
 * Hash chỉ phủ POLICY_TEXT — status/version sống trong registry, KHÔNG ở
 * đây (S1: flip status không phá hash đã ghi).
 */
export const POLICY_TEXT = `# Quy tắc người bán (BẢN NHÁP — chờ founder duyệt)

> Bản nháp do trợ lý soạn theo yêu cầu của founder; chưa có hiệu lực cho tới khi founder duyệt. Nên nhờ người có chuyên môn pháp lý rà soát Điều khoản và Chính sách quyền riêng tư.

## 1. Ai được bán trên LoaViet

Trong giai đoạn beta, chỉ người bán sáng lập được LoaViet mời mới được gửi tin đăng để hiển thị công khai. Bạn có thể soạn tin nháp trước khi được xác minh, nhưng tin chỉ được gửi duyệt và hiển thị khi bạn đáp ứng đủ các yêu cầu sau:

1. Email đã xác minh.
2. Số điện thoại đã xác minh.
3. Đã khai báo loại người bán: cá nhân hoặc doanh nghiệp.
4. Đã khai báo tỉnh/thành hoạt động.
5. Đã đồng ý phiên bản hiện hành của Quy tắc người bán.
6. Là thành viên người bán sáng lập đang hoạt động (chưa hết hạn, chưa bị tạm dừng).
7. Được đội ngũ vận hành LoaViet xét duyệt và xác minh.
8. Tài khoản không bị đình chỉ.

Các yêu cầu này được kiểm tra lại mỗi lần bạn gửi hoặc hiển thị lại tin. Nếu một yêu cầu không còn đáp ứng, bạn sẽ không đăng tin mới được cho tới khi khắc phục.

## 2. Ý nghĩa của xác minh

Nhãn xác minh có nghĩa: "Đã xác minh thông tin người bán theo yêu cầu hiện tại của LoaViet." Đây là biện pháp kiểm soát quyền truy cập nền tảng, không phải là chứng nhận sản phẩm, không phải xác nhận chất lượng hàng và không phải cam kết về giao dịch. Bạn không được quảng cáo nhãn này theo cách khác.

Khi xét duyệt, đội ngũ vận hành có thể xem xét các dấu hiệu như tài khoản trùng lặp, thông tin khai báo không nhất quán, báo cáo lạm dụng chưa giải quyết hoặc lịch sử bị thu hồi xác minh. Nếu bạn khai là doanh nghiệp, LoaViet có thể đề nghị bổ sung thông tin. Kết quả có thể là đã xác minh, cần xem xét thêm, chưa được duyệt hoặc bị thu hồi.

## 3. Tin đăng trung thực

- Ghi đúng hãng và mẫu loa.
- Chọn đúng mức tình trạng (ví dụ mới nguyên seal, mở hộp chưa dùng, gần mới, rất tốt, còn tốt, cũ còn dùng tốt, đã tân trang, bán lấy linh kiện).
- Khai rõ mọi lỗi đã biết (rè, mất kênh, pin chai, nứt vỡ, mất chống nước…) và lịch sử sửa chữa, thay linh kiện.
- Liệt kê đúng phụ kiện đi kèm; không liệt kê thứ không có.
- Mô tả tối đa 4.000 ký tự, viết rõ ràng, không nhồi từ khóa.

## 4. Ảnh thật

- Dùng ảnh tự chụp chính chiếc loa đang bán; không dùng ảnh mạng hay ảnh quảng cáo của hãng.
- Mỗi tin tối đa 8 ảnh. Nên có: mặt trước, mặt sau, bảng nút điều khiển, cổng sạc/kết nối, các vết xước hoặc hư hỏng lớn, phụ kiện, hộp (nếu có).
- Có thể chụp vùng tem/số serie nếu thấy phù hợp, nhưng không bắt buộc công khai số serie đầy đủ.
- Không chèn số điện thoại, đường link hay thông tin cá nhân vào ảnh.

## 5. Một sản phẩm một tin

Mỗi tin đăng tương ứng với một chiếc loa cụ thể. Không đăng trùng cùng một sản phẩm nhiều lần, không dùng một tin để bán nhiều sản phẩm khác nhau. Không đăng sản phẩm bị cấm theo Quy tắc chợ.

## 6. Giá và giao dịch

- Giá ghi bằng VND, là giá thật cho đúng sản phẩm, ghi rõ có thương lượng hay không.
- Thanh toán và giao nhận do bạn và người mua tự thỏa thuận bên ngoài LoaViet. Không nói hoặc ngụ ý rằng LoaViet giữ tiền, nhận cọc hay đứng ra thanh toán.
- Không yêu cầu người mua chuyển tiền trước khi họ có cơ hội xem hàng, trừ khi người mua tự nguyện đồng ý sau khi được thông tin đầy đủ.
- Không gửi đường link thanh toán, không yêu cầu OTP hay mật khẩu.

## 7. Phản hồi người mua

- Trả lời tin nhắn của người mua trong thời gian hợp lý, nên trong vòng 24 giờ.
- Lịch sự, trả lời đúng câu hỏi, không gây áp lực.
- Nếu không còn muốn bán hoặc sản phẩm đã bán, hãy báo cho người đang hỏi.

## 8. Cập nhật trạng thái tin

- Khi bán thành công qua một giao dịch đã ghi nhận trên LoaViet, hãy chọn đánh dấu tin là đã bán khi bạn xác nhận kết quả thành công.
- Nếu bán ở nơi khác hoặc không còn bán, hãy ẩn hoặc xóa tin ngay; liên hệ hỗ trợ qua hnhien0708@gmail.com nếu cần đánh dấu đã bán.
- Không để tin của sản phẩm đã bán tiếp tục hiển thị.

## 9. Vi phạm

Khi vi phạm các quy tắc này, LoaViet có thể từ chối hoặc gỡ tin, thu hồi xác minh, tạm dừng tư cách người bán sáng lập hoặc đình chỉ tài khoản. Các biện pháp do quản trị viên xem xét thủ công và có thể kéo dài cho tới khi được gỡ bỏ. Bạn có thể kháng cáo theo Quy tắc cộng đồng.

## 10. Phiên bản

Khi Quy tắc người bán có phiên bản mới, bạn cần đồng ý lại phiên bản đó trước khi tiếp tục gửi tin đăng.
`;
