/**
 * Điều khoản sử dụng (Terms) — nội dung chính sách, spec §3.1 legal/policy
 * readiness (Batch 8 Task 1).
 *
 * Văn bản do Claude soạn theo yêu cầu của founder (nháp 2026-10-12) — founder
 * đã đọc và DUYỆT ngày 2026-10-14 (FD-3, FD-R34 — chat). Status REVIEWED
 * trong registry; hash sha256 của POLICY_TEXT ghi trong
 * docs/operations/policy-review-record.md (Decision == APPROVED) — flip
 * status sang REVIEWED trong src/lib/policy-registry.ts, cùng commit.
 *
 * Plain module (KHÔNG server-only, KHÔNG db) — import được bởi page
 * app/policies/[key] lẫn script tsx offline (scripts/policy-hash.ts).
 * Hash chỉ phủ POLICY_TEXT — status/version sống trong registry, KHÔNG ở
 * đây (S1: flip status không phá hash đã ghi).
 */
export const POLICY_TEXT = `# Điều khoản sử dụng

Ngày hiệu lực: 14/10/2026

## 1. Giới thiệu

LoaViet là nền tảng đăng tin và nhắn tin giúp người mua và người bán loa Bluetooth di động tìm thấy nhau. LoaViet do Hoàng Ngọc Hiện, địa chỉ 413 Hoàng Quốc Việt, Hà Nội, vận hành.

Khi tạo tài khoản hoặc sử dụng LoaViet, bạn đồng ý với Điều khoản này và các văn bản liên quan: Chính sách quyền riêng tư, Quy tắc chợ, Quy tắc người bán, Quy tắc cộng đồng và Hướng dẫn an toàn giao dịch.

## 2. Giai đoạn beta riêng tư

- LoaViet đang trong giai đoạn beta riêng tư. Quyền đăng tin chỉ dành cho người bán sáng lập được LoaViet mời. Quyền bắt đầu trò chuyện với người bán hiện dành cho thành viên beta đang hoạt động.
- Tư cách thành viên beta do LoaViet cấp theo lời mời; tư cách này có thể hết hạn, bị tạm dừng hoặc chấm dứt.
- Khách chưa đăng nhập vẫn có thể xem tin đăng công khai, hồ sơ người bán công khai và hướng dẫn an toàn.
- Vì đây là bản beta, tính năng, giao diện và quy trình có thể thay đổi, tạm ngưng hoặc ngừng; dịch vụ có thể gián đoạn hoặc có lỗi.

## 3. Điều kiện sử dụng

- Bạn phải từ 16 tuổi trở lên và có năng lực hành vi dân sự để tự thực hiện giao dịch mua bán theo pháp luật Việt Nam.
- Thông tin bạn cung cấp (họ tên, email, số điện thoại, khu vực hoạt động) phải chính xác và được cập nhật khi thay đổi.
- Không tạo hoặc dùng nhiều tài khoản để né tránh hạn chế hay biện pháp xử lý vi phạm; không dùng tài khoản của người khác.

## 4. Tài khoản và bảo mật

- Bạn tự chịu trách nhiệm giữ bí mật mật khẩu và mã xác minh (OTP). LoaViet không bao giờ hỏi mật khẩu hay mã OTP của bạn.
- Một số tính năng yêu cầu email và số điện thoại đã xác minh. Trong giai đoạn beta, khi kênh gửi mã tự động chưa sẵn sàng, việc xác minh có thể do quản trị viên thực hiện thủ công sau khi liên hệ trực tiếp với bạn, có hai người cùng xác nhận và được ghi nhật ký.
- Hãy báo ngay qua hnhien0708@gmail.com nếu bạn nghi ngờ tài khoản bị truy cập trái phép.

## 5. Vai trò của LoaViet

- LoaViet cung cấp công cụ đăng tin, tìm kiếm, nhắn tin và ghi nhận kết quả giao dịch.
- LoaViet không xử lý thanh toán, không giữ tiền, không có ví, không làm trung gian thanh toán, không chi trả tiền cho người bán và không hoàn tiền. Người mua và người bán tự thỏa thuận và tự thực hiện việc thanh toán, giao nhận bên ngoài LoaViet.
- LoaViet không phải là một bên của hợp đồng mua bán giữa người dùng, không phải người bán và không đại diện cho người bán hay người mua.
- LoaViet không kiểm định sản phẩm và không cam kết về nguồn gốc, tình trạng, chất lượng sản phẩm, về độ tin cậy của người dùng hay về kết quả giao dịch. Nhãn xác minh của người bán chỉ cho biết người bán đã đáp ứng yêu cầu xác minh thông tin hiện tại của LoaViet.
- Chức năng ghi nhận giao dịch chỉ lưu kết quả do chính người dùng khai báo. LoaViet không giải quyết tranh chấp về tiền hoặc hàng giữa người dùng.

## 6. Nội dung của người dùng

- Bạn giữ quyền đối với nội dung bạn đăng: tin đăng, mô tả, hình ảnh, tin nhắn.
- Bạn cấp cho LoaViet quyền không độc quyền, miễn phí, chỉ trong phạm vi cần thiết để vận hành dịch vụ: lưu trữ, hiển thị, xử lý kỹ thuật (ví dụ chuyển định dạng ảnh, loại bỏ siêu dữ liệu), lập chỉ mục tìm kiếm và kiểm duyệt nội dung.
- Quyền này chấm dứt khi nội dung bị xóa, trừ phần LoaViet cần lưu giữ theo Chính sách quyền riêng tư (ví dụ bằng chứng kiểm duyệt, nghĩa vụ pháp lý).
- Bạn xác nhận mình có quyền đăng nội dung đó và nội dung không vi phạm quyền của người khác.

## 7. Hành vi bị cấm

- Lừa đảo, mạo danh, đăng sản phẩm không có thật, hàng giả, hàng nhái hoặc hàng bị cấm.
- Quấy rối, đe dọa, spam, quảng cáo không liên quan.
- Yêu cầu người khác cung cấp OTP, mật khẩu; gửi đường link thanh toán giả mạo.
- Tự xưng là LoaViet hoặc nói rằng LoaViet giữ tiền, nhận cọc hay đứng ra thanh toán.
- Thu thập dữ liệu tự động, dò quét, vượt qua kiểm soát truy cập, gây quá tải hoặc tấn công hệ thống.
- Bất kỳ hành vi nào vi phạm pháp luật Việt Nam.

## 8. Xử lý vi phạm, tạm ngưng và chấm dứt

- Khi có vi phạm hoặc rủi ro cho người dùng khác, LoaViet có thể từ chối hoặc gỡ tin đăng, thu hồi xác minh người bán, tạm dừng tư cách thành viên beta hoặc đình chỉ tài khoản.
- Trong giai đoạn beta, các biện pháp này do quản trị viên xem xét thủ công và có thể kéo dài không thời hạn cho tới khi được gỡ bỏ.
- Bạn có thể kháng cáo quyết định xử lý qua trang kháng cáo trong ứng dụng, như mô tả trong Quy tắc cộng đồng.
- Bạn có thể ngừng sử dụng LoaViet bất kỳ lúc nào. Hiện chưa có chức năng tự xóa tài khoản; hãy gửi yêu cầu xóa qua hnhien0708@gmail.com.

## 9. Giới hạn trách nhiệm

- Trong giai đoạn beta, dịch vụ được cung cấp theo hiện trạng.
- Trong phạm vi pháp luật cho phép, LoaViet không chịu trách nhiệm về thiệt hại phát sinh từ giao dịch giữa người dùng, bao gồm việc thanh toán, giao nhận, tình trạng sản phẩm hay việc gặp mặt.
- Điều khoản này không loại trừ trách nhiệm mà pháp luật Việt Nam không cho phép loại trừ.

## 10. Thay đổi Điều khoản

Mỗi văn bản chính sách hiển thị số phiên bản và ngày cập nhật ở đầu trang. Khi thay đổi đáng kể, LoaViet sẽ tăng số phiên bản và thông báo trong ứng dụng trước 7 ngày khi áp dụng. Với một số văn bản (ví dụ Quy tắc người bán), bạn có thể phải đồng ý lại phiên bản mới để tiếp tục dùng tính năng liên quan.

## 11. Luật áp dụng

Điều khoản này chịu sự điều chỉnh của pháp luật Việt Nam. Tranh chấp giữa bạn và LoaViet trước hết được giải quyết bằng thương lượng; nếu không thành, tranh chấp được đưa ra Tòa án có thẩm quyền tại Hà Nội.

## 12. Liên hệ

Hoàng Ngọc Hiện — email: hnhien0708@gmail.com.
`;
