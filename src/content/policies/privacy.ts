/**
 * Chính sách bảo mật (Privacy) — nội dung chính sách, spec §3.1 legal/policy
 * readiness (Batch 8 Task 1).
 *
 * BẢN NHÁP DO CLAUDE SOẠN THEO YÊU CẦU CỦA FOUNDER (2026-10-12) — chờ founder
 * sửa và duyệt (FD-3, FD-R34; retention là FD-R7, xóa tài khoản FD-R45).
 * Status vẫn DRAFT-NOT-REVIEWED trong registry cho tới khi founder duyệt; mọi
 * chỗ `[... — founder điền]` là dữ kiện chỉ founder cung cấp được. Danh mục
 * dữ liệu đối chiếu src/prisma/contract.prisma + src/lib/product-events.ts.
 * Nên nhờ người có chuyên môn pháp lý rà soát (Nghị định 13/2023/NĐ-CP). Khi
 * duyệt: hash sha256 của POLICY_TEXT ghi vào
 * docs/operations/policy-review-record.md (Decision == APPROVED) — flip
 * status sang REVIEWED trong src/lib/policy-registry.ts, cùng commit.
 *
 * Plain module (KHÔNG server-only, KHÔNG db) — import được bởi page
 * app/policies/[key] lẫn script tsx offline (scripts/policy-hash.ts).
 * Hash chỉ phủ POLICY_TEXT — status/version sống trong registry, KHÔNG ở
 * đây (S1: flip status không phá hash đã ghi).
 */
export const POLICY_TEXT = `# Chính sách bảo mật (BẢN NHÁP — chờ founder duyệt)

> Bản nháp do trợ lý soạn theo yêu cầu của founder; chưa có hiệu lực cho tới khi founder duyệt. Nên nhờ người có chuyên môn pháp lý rà soát Điều khoản và Chính sách quyền riêng tư.

Ngày hiệu lực: 14/10/2026

## 1. Phạm vi

Chính sách này giải thích cách Hoàng Ngọc Hiện ("LoaViet") thu thập, sử dụng và bảo vệ dữ liệu cá nhân của bạn khi bạn dùng LoaViet, theo Nghị định 13/2023/NĐ-CP về bảo vệ dữ liệu cá nhân. LoaViet là bên kiểm soát và xử lý các dữ liệu cá nhân được mô tả dưới đây.

## 2. Dữ liệu chúng tôi thu thập

1. Tài khoản: họ tên, email, số điện thoại, mật khẩu (chỉ lưu dạng băm, không lưu bản gốc), ảnh đại diện, thành phố và phần giới thiệu nếu bạn cung cấp; trạng thái và thời điểm xác minh email, số điện thoại.
2. Người bán: loại người bán (cá nhân hoặc doanh nghiệp), tỉnh/thành hoạt động, hồ sơ xét duyệt xác minh (trạng thái, mã lý do, ghi chú nội bộ, người xét, thời điểm), lịch sử đồng ý Quy tắc người bán theo phiên bản, tư cách thành viên beta. Với người bán được mời, LoaViet lưu kênh liên hệ dùng để gửi lời mời, nguồn giới thiệu và ghi chú vận hành. LoaViet hiện không thu thập giấy tờ tùy thân.
3. Tin đăng và hình ảnh: hãng, mẫu, tình trạng, giá, phụ kiện, lỗi đã biết, lịch sử sửa chữa, mô tả, tỉnh/thành, hình thức giao nhận và ảnh sản phẩm. Ảnh tin đăng được chuyển định dạng và loại bỏ siêu dữ liệu, kể cả vị trí GPS. Tin đăng không lưu địa chỉ đường phố.
4. Tin nhắn: nội dung, ảnh gửi trong cuộc trò chuyện, thời điểm gửi và đọc.
5. Ghi nhận giao dịch: kết quả do mỗi bên tự khai báo, giá thỏa thuận và hình thức giao nhận nếu bạn nhập, lịch sử thay đổi trạng thái.
6. Báo cáo, chặn và kiểm duyệt: báo cáo bạn gửi hoặc liên quan tới bạn, lý do, bản chụp bằng chứng nội dung bị báo cáo tại thời điểm báo cáo, quyết định xử lý, đình chỉ, kháng cáo và danh sách người bạn đã chặn.
7. Bảo mật và nhật ký quản trị: phiên đăng nhập (thời điểm, thông tin trình duyệt), mã OTP (chỉ lưu dạng băm, dùng một lần, hết hạn nhanh), nhật ký kiểm toán các hành động quản trị và hành động nhạy cảm (ai thực hiện, hành động gì, lúc nào, lý do). Địa chỉ IP trong nhật ký kiểm toán chỉ lưu dưới dạng mã băm có khóa.
8. Sự kiện sử dụng sản phẩm: các sự kiện như tìm kiếm, xem tin, bắt đầu trò chuyện, ghi nhận giao dịch, gửi báo cáo. Định danh tài khoản và phiên được thay bằng mã giả danh tạo bằng khóa riêng. Các sự kiện này không chứa email, số điện thoại, nội dung tin nhắn, nội dung từ khóa tìm kiếm, địa chỉ chi tiết, mật khẩu hay OTP; vị trí chỉ ở cấp tỉnh/thành. Mã giả danh không phải là ẩn danh hoàn toàn: LoaViet vẫn có thể liên kết lại với tài khoản khi cần.
9. Thông báo trong ứng dụng gửi tới bạn.

## 3. Mục đích sử dụng

- Tạo và quản lý tài khoản, đăng nhập, khôi phục tài khoản.
- Hiển thị tin đăng, tìm kiếm, kết nối người mua và người bán qua tin nhắn.
- Xác minh người bán và kiểm soát quyền truy cập beta.
- Ngăn chặn lừa đảo, lạm dụng; xử lý báo cáo, kiểm duyệt và kháng cáo.
- Bảo mật hệ thống và điều tra sự cố.
- Thống kê việc sử dụng để cải thiện sản phẩm.
- Tuân thủ nghĩa vụ pháp lý.

LoaViet không bán dữ liệu cá nhân của bạn và hiện không dùng dữ liệu của bạn cho quảng cáo của bên thứ ba.

## 4. Dữ liệu hiển thị công khai

Tin đăng (kể cả ảnh, giá, tỉnh/thành), tên hiển thị và hồ sơ người bán công khai, trạng thái xác minh người bán có thể được bất kỳ ai xem. Tin nhắn chỉ hiển thị cho những người trong cuộc trò chuyện.

## 5. Chia sẻ dữ liệu

LoaViet chỉ chia sẻ dữ liệu khi:

- bạn chủ động gửi cho người dùng khác (ví dụ tin nhắn);
- cần thiết cho nhà cung cấp hạ tầng vận hành dịch vụ thay LoaViet: máy chủ do LoaViet tự vận hành (không chia sẻ dữ liệu với nhà cung cấp hạ tầng bên thứ ba);
- cơ quan nhà nước có thẩm quyền yêu cầu theo quy định pháp luật.

Dữ liệu được lưu trữ tại: Việt Nam.

## 6. Ai trong LoaViet được truy cập

- Quản trị viên chỉ truy cập dữ liệu theo vai trò được phân quyền và bắt buộc xác thực hai lớp.
- Hành động quản trị, mỗi lần xem bằng chứng kiểm duyệt và truy cập thông tin nhạy cảm đều được ghi nhật ký kiểm toán. Thông tin liên hệ hiển thị trong bảng điều khiển được che bớt.
- Bảng điều khiển quản trị không có chức năng đọc tự do các cuộc trò chuyện; nội dung tin nhắn được xem xét qua bản chụp bằng chứng khi có báo cáo.
- Nhân sự kỹ thuật có thể truy cập cơ sở dữ liệu khi bảo trì hoặc xử lý sự cố.

## 7. Lưu giữ dữ liệu

Thời hạn lưu giữ cụ thể cho từng loại dữ liệu đang được hoàn thiện trong giai đoạn beta. Cho tới khi đó, LoaViet lưu dữ liệu trong thời gian cần thiết để vận hành dịch vụ, giữ an toàn cho cộng đồng người dùng và thực hiện nghĩa vụ pháp lý. Bằng chứng kiểm duyệt, hồ sơ kháng cáo và nhật ký kiểm toán có thể được giữ lại sau khi tài khoản bị xóa nếu cần cho điều tra lạm dụng, kháng cáo, phòng chống gian lận hoặc nghĩa vụ pháp lý.

## 8. Quyền của bạn

Theo Nghị định 13/2023/NĐ-CP, bạn có quyền:

- được biết về việc xử lý dữ liệu cá nhân của mình;
- truy cập và yêu cầu cung cấp dữ liệu của mình;
- chỉnh sửa dữ liệu (một số thông tin hồ sơ có thể tự sửa trong trang cá nhân);
- yêu cầu xóa dữ liệu và xóa tài khoản;
- rút lại sự đồng ý, yêu cầu hạn chế hoặc phản đối việc xử lý;
- khiếu nại, tố cáo, khởi kiện theo quy định pháp luật.

Hiện chưa có chức năng tự xóa tài khoản: yêu cầu xóa được bộ phận hỗ trợ xử lý thủ công. Gửi yêu cầu qua hnhien0708@gmail.com; LoaViet sẽ phản hồi trong 72 giờ. Việc rút lại sự đồng ý hoặc xóa dữ liệu có thể khiến bạn không dùng được một số tính năng, và không ảnh hưởng tới phần dữ liệu cần giữ lại theo mục 7.

## 9. Biện pháp bảo vệ

LoaViet áp dụng các biện pháp như băm mật khẩu và OTP, giới hạn tần suất thao tác, xác thực hai lớp và phân quyền cho quản trị viên, ghi nhật ký truy cập. Không biện pháp kỹ thuật nào loại bỏ được hoàn toàn rủi ro; nếu xảy ra sự cố ảnh hưởng tới dữ liệu của bạn, LoaViet sẽ thông báo theo quy định pháp luật.

## 10. Người chưa đủ tuổi

LoaViet không dành cho người dưới 16 tuổi.

## 11. Thay đổi và liên hệ

Khi chính sách thay đổi, số phiên bản và ngày cập nhật ở đầu trang sẽ thay đổi theo. Mọi câu hỏi về dữ liệu cá nhân xin gửi tới Hoàng Ngọc Hiện, email: hnhien0708@gmail.com.
`;
