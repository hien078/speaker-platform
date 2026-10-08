# Playbook khôi phục tài khoản (account recovery) — private beta

> **Phạm vi:** luồng tự phục vụ đặt lại mật khẩu, giới hạn của support, và
> phương án cuối cùng out-of-band khi người dùng mất mọi kênh đã xác minh.
> Batch 8 Task 3 (spec §12 "recovery works" + "support path exists").
>
> **Nguồn sự thật:** `src/lib/actions/recovery.ts`,
> `src/lib/actions/verification.ts`, `src/lib/otp.ts`, `src/lib/rbac.ts`,
> và runbook Batch 2 `docs/operations/admin-bootstrap-recovery-runbook.md`
> (tham chiếu theo mục — KHÔNG duplicate). Mọi tên trích dẫn đã đối chiếu mã
> nguồn đã merge.
>
> **Không phát minh chính sách (spec §4.11):** yêu cầu proofing out-of-band
> của đường thủ công là founder decision `[FOUNDER DECISION — FD-R3 —
> BLOCKING]` — playbook ghi *hình dạng quy trình*, không invent tiêu chí.

## 1. Luồng tự phục vụ (đã ship — `/recover`)

`requestPasswordRecoveryAction` → `confirmPasswordRecoveryAction`
(`src/lib/actions/recovery.ts`):

1. **Identifier:** email HOẶC phone VN (chuẩn hóa `normalizeEmail`/
   `normalizePhone`); sai dạng → lỗi nhập liệu TRƯỚC tra cứu.
2. **Thông báo trung tính DUY NHẤT** cho MỌI outcome (có/không khớp tài khoản,
   kênh chưa xác minh, cooldown, per-target limit, delivery fail) — byte-đối
  -byte như nhau. Work của path matched (gửi OTP + audit) chạy SAU response
   qua `after()` — không oracle qua timing/error.
3. **OTP chỉ tới kênh ĐÃ XÁC MINH** (`findUserByVerifiedIdentifier` — match
   `emailVerifiedAt`/`phoneVerifiedAt`): mất email → nhập phone → mã tới
   phone (và ngược lại). OTP: 6 chữ số, TTL 10 phút (`OTP_TTL_MINUTES`), tối
   đa 5 lần sai (`OTP_MAX_ATTEMPTS`), cooldown gửi 60 giây
   (`OTP_RESEND_COOLDOWN_SEC`), 3 mã/10 phút/đích.
   **Production fail-closed (FD-2/FD-R1 — LAUNCH BLOCKER):** chưa có provider
   email/SMS thật — `OtpDeliveryAdapter` production TỪ CHỐI MỌI lần gửi:
   `sendOtp` throw `OTP_DELIVERY_UNAVAILABLE` **bất kể kênh đã được đánh dấu
   verified hay chưa** (`src/lib/verification-delivery.ts:91-101,118-119`;
   mọi đường xin mã đều qua adapter này — `requestOtp`, `src/lib/otp.ts:166`).
   Hệ quả phải nêu thẳng: **trong production KHÔNG kênh nào (email lẫn phone)
   tự xác minh được, và `/recover` KHÔNG BAO GIỜ gửi được mã cho tới khi
   FD-R1 (provider) land** — đánh dấu kênh verified thủ công (§4) KHÔNG làm
   luồng này chạy được. Người dùng vẫn nhận thông báo trung tính (§1.2) nhưng
   mã không bao giờ tới (throw được `captureError` trong `after()` — response
   không đổi, `src/lib/actions/recovery.ts:217-247`). Tự phục vụ đặt lại mật
   khẩu trong production là **BẤT KHẢ THI** cho tới FD-R1 — xem §4.
4. **Xác nhận:** mã + mật khẩu mới → MỌI failure collapse về cùng một lỗi
   (không phân biệt "không có tài khoản"/"sai mã"/"hết hạn"/"khóa").
   Mật khẩu mới + **thu hồi TOÀN BỘ session** trong CÙNG transaction
   (`revokeAllUserSessionsTx` — không except session hiện tại: stale-session
   reuse sau recovery đóng, RR-4).
5. **Sau hoàn tất:** audit `user.recovery_completed` (reason
   `verified_channel_otp`), notify in-app, security notice tới MỌI kênh đã
   xác minh của user (kẻ chiếm SIM/email đang giữ một kênh — kênh còn lại
   của nạn nhân phải được báo).

**Rate limits:** request 5/10 phút/IP; confirm 10/10 phút/IP + 5/10 phút/
identifier (bucket keyed bằng HMAC hash — limiter không giữ identifier thô).

## 2. Quy tắc enumeration-safe cho support (spec §7.7)

Support KHÔNG BAO GIỜ xác nhận với người dùng (hay bất kỳ ai) liệu một
identifier có tương ứng tài khoản hay không — kể cả khi người dùng khẳng định
đã từng dùng nền tảng. Câu trả lời chuẩn: hướng dẫn vào `/recover` và nhập
identifier của mình — hệ thống trả thông báo trung tính cho mọi trường hợp.
Điều này chặn kẻ dò danh sách tài khoản qua kênh support. Cùng nguyên tắc:
không đọc/email/phone cho người khác qua kênh hỗ trợ, kể cả để "xác nhận danh
tính" — xác nhận danh tính đi qua kênh out-of-band mà operator đã có với
người dùng (§4), không qua dữ liệu nền tảng.

## 3. Support được gì / không được gì (FD-R2)

Vai trò `support` trong ma trận `ROLE_CAPABILITIES` (`src/lib/rbac.ts`) chỉ
giữ `admin.access` — **không** `user.view_basic`, **không** `pii.*`, **không**
`session.revoke`, **không** `user.suspend`. Ô Scoped của ma trận (moderator/
support `user.view_basic`, `pii.view_sensitive`…) chưa được founder định nghĩa
— fail closed `[FOUNDER DECISION — FD-R2 — BLOCKING]`.

Support có thể: hướng dẫn luồng tự phục vụ, ghi nhận yêu cầu hỗ trợ, chuyển
hand-off sang operations_admin/super_admin cho các thao tác cần quyền.

Support KHÔNG thể (và không có surface nào cho): xem email/phone của user,
đặt lại mật khẩu hộ, thu hồi session hộ, đánh dấu kênh đã xác minh (đó là
đường hai người §4 — chạy bởi operator có quyền DB, không phải vai trò
support).

## 4. Phương án cuối cùng out-of-band (Batch 2 A3 — last resort)

**Khi nào:** người dùng mất MỌI kênh đã xác minh (email + phone) — recovery
tự phục vụ chỉ chạy qua kênh đã verified (§1.3), nên không còn đường tự phục
vụ. Block §6 cũng là **đường production DUY NHẤT để người được mời (invitee)
có KÊNH EMAIL đã xác minh cho tới khi provider OTP land (FD-2/FD-R69)** — xem
`docs/operations/concierge-onboarding-playbook.md` §4. **Block này set
`emailVerifiedAt` thôi** (runbook §6 — `UPDATE "User" SET
"emailVerifiedAt" = now()` chỉ khi đang null): KHÔNG set `phoneVerifiedAt`,
và KHÔNG làm `/recover` gửi được mã (§1.3 — delivery vẫn throw).

**⚠️ LAUNCH BLOCKER — bước 4 dưới đây KHÔNG chạy được trong production cho
tới FD-R1:** adapter OTP production fail-closed (§1.3) → sau block §6,
người dùng vào `/recover` vẫn CHỈ nhận thông báo trung tính, mã không bao giờ
tới. Trong production, cho tới khi provider land:

- **KHÔNG chạy block §6 cho mục đích khôi phục mật khẩu** — nó chỉ flip một
  flag (`emailVerifiedAt`); người dùng vẫn không đặt lại được mật khẩu, trong
  khi mutation + audit đã xảy ra. (Chạy nó cho invite acceptance kênh email —
  concierge §4, FD-R69 — là mục đích khác.)
- **KHÔNG đặt `passwordHash` tay** dưới bất kỳ hình thức nào: đường đó không
  có audit block, không thu hồi session — đúng mutation thủ công unaudited mà
  playbook này tồn tại để chặn. Nếu cần block khôi phục mật khẩu audited
  (two-person), đó là founder decision `[FOUNDER DECISION — FD-R1/FD-R3 —
  BLOCKING]` — chờ block được review + duyệt, KHÔNG tự chế.
- **Route ca mất quyền truy cập về founder** (FD-R1/FD-R3). Trong lúc chờ:
  chứa bằng thu hồi session (`/admin/users` "Thu hồi phiên" —
  `revokeAllUserSessionsAction`, audit `session.revoked_all`) và đình chỉ
  (`suspendUserAction`) theo incident playbook §4a.

**Quy trình đã ship — tham chiếu runbook Batch 2 §6, KHÔNG tự chế lệnh:**
`docs/operations/admin-bootstrap-recovery-runbook.md` §6 ("Khôi phục tài
khoản NGƯỜI DÙNG ngoài band") là **block psql thủ công, audited, two-person
rule** (KHÔNG phải maintenance command):

1. Operator xác minh out-of-band người dùng thật sự sở hữu email trên tài khoản.
   **Mức proofing cụ thể (giấy tờ, video call, người thứ ba) chưa được founder
   định nghĩa — two-person rule + audit là cơ chế tối đa hiện có**
   `[FOUNDER DECISION — FD-R3 — BLOCKING]`.
2. Hai người xác nhận (một chạy lệnh, một xác nhận danh tính/tính chính đáng
   qua kênh ngoài — ghi vào ticket vận hành).
3. Chạy block psql của runbook §6 từ VPS (tiền tố `docker exec -i loaviet-db
   psql -U loaviet -d loaviet -v ON_ERROR_STOP=1` — runbook §0): MỘT
   transaction `BEGIN…DO…COMMIT` resolve user id MỘT LẦN (không thấy →
   `RAISE EXCEPTION` → abort, chưa đụng dữ liệu), set `emailVerifiedAt`
   (chỉ khi đang null), INSERT `AuditEvent` action
   **`user.email_verified_manual`** (reason `manual_out_of_band`, actor null,
   detail "two-person confirmed") — mutation + audit sống chết cùng tx.
4. Người dùng TỰ phục vụ phần còn lại qua `/recover` (OTP → mật khẩu mới →
   **mọi session bị thu hồi** bởi `confirmPasswordRecoveryAction` — §1.4).
   Nghĩa là: quy trình thủ công KHÔNG tự đặt mật khẩu, KHÔNG tự thu hồi
   session — phần thu hồi diễn ra trong luồng tự phục vụ có audit riêng.
   **Bước này KHÔNG chạy được trong production cho tới FD-R1** (§1.3 — OTP
   không bao giờ tới dù kênh đã verified): chỉ chạy trọn §4 trên dev/staging
   hoặc sau khi provider land.

**Hình dạng quy trình (ghi nhận, không invent):** ai (operator có quyền DB +
người xác nhận thứ hai), audit trail (`user.email_verified_manual` trong
`AuditEvent` — tra được qua `/admin/audit`, capability `audit.read`), thu hồi
session sau (tự động ở bước 4). **Đặt `passwordHash` tay BỊ CẤM** — đường tay
không có audit block, không thu hồi session; trong production "không còn cách
nào" giờ LUÔN đúng (§1.3), nên nếu cần block khôi phục mật khẩu audited
(two-person) thì đó là founder decision (FD-R1/FD-R3) — KHÔNG phải mặc định
operator.

**Lockout MFA admin** (khác domain — tham chiếu, không duplicate): runbook
Batch 2 §2 (còn mã khôi phục → tự phục vụ; mất hết → `mfa-reset` → re-enroll)
và §3 (mất hoàn toàn quyền bootstrap → block psql `admin.mfa_reset_manual`,
two-person rule). Support KHÔNG can thiệp MFA admin — xem
`docs/operations/moderation-playbook.md` §6 (FD-R10).

## 5. Founder Decision Items (playbook này mang)

| Mục | Ghi chú |
|---|---|
| FD-R1 | Provider OTP production — điều kiện để §1 (tự phục vụ) VÀ §4 bước 4 chạy được trong production; chưa land thì không kênh nào xác minh được, `/recover` không gửi được mã, seller không qua được `phone_verified` (LAUNCH BLOCKER) — BLOCKING (FD-2) |
| FD-R2 | Ô Scoped RBAC cho support/moderator (§3) — BLOCKING |
| FD-R3 | Proofing out-of-band cho đường thủ công §4 — BLOCKING |
| FD-R69 | Block §6 (email-only) là đường production duy nhất cho KÊNH EMAIL đã xác minh tới khi FD-R1 land (§4); kênh phone không có đường — invite phone + seller verification chặn tới FD-R1 — BLOCKING |

Liên quan chéo: `docs/operations/concierge-onboarding-playbook.md` §4
(FD-R69), `docs/operations/incident-playbook.md` §4 (nghi ngờ chiếm tài
khoản), `docs/operations/admin-bootstrap-recovery-runbook.md` (runbook gốc —
§0/§2/§3/§6).
