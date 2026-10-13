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
> **FD-R3 đã quyết 2026-10-13** (founder, qua chat): quy trình hai người ở
> §4b là proofing out-of-band được duyệt cho khôi phục mật khẩu — mọi nhãn
> vận hành trong §4b là PROVISIONAL (FD-3), founder review qua register.

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
   mã không bao giờ tới: `requestOtp` TỰ BẮT throw của adapter — xoá row
   `OtpCode` vừa tạo rồi trả typed `{ok:false, code:"OTP_DELIVERY_UNAVAILABLE"}`
   (`src/lib/otp.ts:166-170`) — và callback `after()` ghi `AuditEvent`
   `user.recovery_requested` với reason `OTP_DELIVERY_UNAVAILABLE`
   (`src/lib/actions/recovery.ts:217-245`, reason tại `:234`). **Operator tra
   đúng reason đó trong `/admin/audit`** (capability `audit.read`) để xác nhận
   lần gửi bị chặn; `captureError("recovery")` (`:238`,`:243`) CHỈ chạy khi có
   throw NGOÀI dự kiến (ghi audit fail / db fail) — KHÔNG phải khi delivery OTP
   bị chặn. Response không đổi (callback chạy sau response). Tự phục vụ đặt lại
   mật khẩu trong production là **BẤT KHẢ THI** cho tới FD-R1 — xem §4.
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

> **2026-10-12 (zero-cost launch Task A):** panel admin "Xác minh liên hệ thủ công"
> (`/admin/users?u=<id>` — two-person rule, audited `contact.manual_verify_*`)
> là đường CHUẨN đánh dấu kênh verified cho MỤC ĐÍCH INVITE/VERIFICATION
> (concierge §4, FD-R69). **Panel KHÔNG khôi phục quyền truy cập:** nó chỉ set
> `emailVerifiedAt`/`phoneVerifiedAt` — `/recover` VẪN không gửi được mã cho tới
> FD-R1 (adapter fail-closed bất kể verified state — §1.3). Mọi cảnh báo "bước 4
> KHÔNG chạy được trong production" bên dưới VẪN ĐÚNG NGUYÊN VẸN với panel.

**Khi nào:** người dùng mất MỌI kênh đã xác minh (email + phone) — recovery
tự phục vụ chỉ chạy qua kênh đã verified (§1.3), nên không còn đường tự phục
vụ. Block §6 cũng là **đường break-glass cho KÊNH EMAIL đã xác minh khi không
vào được admin UI** (đường chuẩn 2026-10-12 là panel — xem
`docs/operations/concierge-onboarding-playbook.md` §4). **Block này set
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
  playbook này tồn tại để chặn. Block khôi phục mật khẩu audited (two-person)
  đã được founder duyệt và ship **2026-10-13** — đó là §4b dưới đây (panel
  admin, KHÔNG psql tay, KHÔNG đặt mật khẩu tay): dùng §4b, KHÔNG tự chế lệnh.
- **Route ca mất quyền truy cập về founder** (FD-R1/FD-R3). Trong lúc chờ
  provider (FD-R1): ca cần reset mật khẩu đi §4b (quy trình hai người);
  chứa thêm bằng thu hồi session (`/admin/users` "Thu hồi phiên" —
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

## 4b. Khôi phục mật khẩu thủ công hai người (Task E — FD-R3 2026-10-13)

> **2026-10-13 (founder FD-R3 — đã quyết):** production chưa có OTP provider
> (FD-R1/FD-2 — §1.3) nên `/recover` tự phục vụ KHÔNG gửi được mã, và hand-set
> `passwordHash` BỊ CẤM (§4). Founder duyệt quy trình HAI NGƯỜI dưới đây làm
> đường khôi phục mật khẩu **CHUẨN cho user thường** cho tới khi FD-R1 land:
> mọi bước audited trong tx, KHÔNG psql tay, KHÔNG đặt mật khẩu tay.
> Nguồn sự thật: `src/lib/actions/manual-account-recovery.ts`,
> `src/lib/manual-account-recovery.ts` (TTLs/rates/labels PROVISIONAL FD-3).

**Tiếp nhận:** user liên hệ support qua email (support KHÔNG xác nhận
existence — §2) → ca chuyển cho operations_admin/super_admin giữ
`account.recover_manual` (ma trận §5.4.1 — moderator/support/analyst fail
closed A2).

**Quy trình (bắt buộc theo thứ tự — action tự chặn vi phạm, KHÔNG chỉ quy
trình giấy):**

1. **Admin A mở request** trên `/admin/users?u=<userId>` → panel **"Khôi phục
   tài khoản thủ công"**, SAU KHI:
   - **GỌI ĐIỆN tới số phone ĐÃ XÁC MINH** của tài khoản (`phoneVerifiedAt` ≠
     null — số chưa verified → action refuse `PHONE_NOT_VERIFIED`; cuộc gọi
     phải tới số từng được xác minh, không phải số tự khai báo);
   - hỏi **3 câu out-of-band**: (1) tiêu đề một tin đăng của tài khoản,
     (2) tỉnh/thành của tài khoản, (3) tháng đăng ký tài khoản — user phải
     trả đúng **≥ 2/3** (dưới 2 → `CHECKS_INSUFFICIENT`, không mở được
     request). Operator **TICK** câu đúng (boolean từng câu) — KHÔNG BAO GIỜ
     nhập câu trả lời vào hệ thống (DB chỉ lưu `checksPassed` + 3 boolean);
   - tick **attestation** "Tôi đã gọi đúng số đã xác minh của tài khoản"
     (bắt buộc — `ATTESTATION_REQUIRED`).
   Action lưu: HMAC của phone chuẩn hóa (hkdf label riêng — KHÔNG giá trị
   thô), snapshot `phoneVerifiedAt` (để duyệt so lại — đổi giữa hai bước →
   `CONTACT_CHANGED`), TTL 24h, audit `account.manual_recovery_requested`
   trong cùng tx.
2. **Admin B (≠ A, ≠ subject) duyệt** trên cùng panel (step-up MFA mọi action):
   - **Duyệt** → trong MỘT tx: thu hồi **MỌI session** của subject (kẻ đang
     giữ session cũ mất tác quyền NGAY), sinh **reset token 256-bit MỘT
     LẦN** (hết hạn **30 phút**), audit `account.manual_recovery_approved`.
     Hệ thống hiển thị **URL reset MỘT LẦN** (`/recover/manual/<token>`) cho
     admin B — B copy gửi cho user **out-of-band** (điện thoại/Zalo — chính
     kênh vừa gọi). Token thô KHÔNG tồn tại ở đâu khác (DB chỉ lưu HMAC);
     mất link → chờ hết hạn 30 phút rồi mở request mới.
   - **Từ chối** → không issue link (audit `account.manual_recovery_rejected`).
   - Action tự chặn: A tự duyệt (`SAME_PERSON_FORBIDDEN`), subject là chính
     mình (`SELF_RECOVERY_FORBIDDEN` — cả mở lẫn duyệt), subject là admin
     account (`ADMIN_SUBJECT_FORBIDDEN` — kiểm lúc mở request, RE-CHECK
     trong tx approve: subject được promote admin SAU khi request mở cũng
     bị chặn — xem giới hạn dưới), phone/snapshot
     đổi giữa hai bước (`CONTACT_CHANGED` — tx abort), request quá hạn
     (`EXPIRED`), đã quyết (`ALREADY_DECIDED`).
   - Admin A (người mở) có thể **hủy** request trước khi có quyết định
     (`cancelManualAccountRecoveryAction` — chỉ người mở, `NOT_REQUESTER`
     cho admin khác).
3. **User tự đặt mật khẩu mới** qua link: mở `/recover/manual/<token>` →
   token chuyển vào cookie HttpOnly (15 phút, path-scoped) + redirect trang
   tokenless → nhập mật khẩu mới (cùng chính sách `/recover`: 6..100) →
   **MỘT CAS duy nhất**: row `consumed` + `passwordHash` (CAS
   `adminRole IS NULL` — subject được promote admin giữa approve/consume →
   refuse cùng thông báo chung, KHÔNG đụng mật khẩu admin account) +
   **thu hồi lại MỌI session** + audit `account.manual_recovery_consumed`
   trong cùng tx. Link dùng MỘT lần —
   dùng lại/hết hạn/token rác → CÙNG MỘT thông báo chung (enumeration-safe
   §7.7 — không oracle). Session đăng nhập bằng mật khẩu cũ trong cửa sổ
   30 phút (login SAU lúc duyệt) cũng bị thu hồi theo consume; user đăng
   nhập lại bằng mật khẩu mới.

**Giới hạn (tự chặn trong code):**

- Subject KHÔNG BAO GIỜ là admin account (`ADMIN_SUBJECT_FORBIDDEN`) —
  kiểm lúc mở request, RE-CHECK `adminRole` trong tx approve (subject
  được promote admin SAU khi request mở → quyết định refuse, tx abort) và
  consume CAS `adminRole IS NULL` (promote giữa approve/consume → password
  write 0 row → refuse, claim rollback). Khôi phục admin (lockout MFA / mất
  quyền bootstrap) thuộc
  `docs/operations/admin-bootstrap-recovery-runbook.md` §2/§3 (two-person
  psql), KHÔNG phải surface này.
- MỘT request mở duy nhất per user (partial unique `account_recovery_one_open`
  — requested HOẶC approved-unconsumed); hết hạn được flip trên read (no
  cron) — request mới luôn mở được sau khi row cũ hết hạn.
- Rate limit (PROVISIONAL — FD-3): 20 thao tác/giờ/admin (bucket chung bốn
  action admin); landing 30/10 phút/IP; consume 10/10 phút/IP + per-token
  (bucket keyed bằng HMAC — limiter không giữ token thô).
- Audit (§4.8): detail chỉ checks-count/decision — KHÔNG phone thô, KHÔNG
  câu trả lời, KHÔNG token thô. Tra `/admin/audit` (capability `audit.read`).

**Rủi ro còn lại (chấp nhận — security review §6.7):** operator social
engineering (kẻ giả danh user trả đúng ≥ 2/3 câu) và SIM swap trên số đã
verified — hai người + step-up MFA + verified-phone-only + link một lần
30 phút + thu hồi session + audit là bộ chặn tối đa hiện có.

## 5. Founder Decision Items (playbook này mang)

| Mục | Ghi chú |
|---|---|
| FD-R1 | Provider OTP production — điều kiện để §1 (tự phục vụ) VÀ §4 bước 4 chạy được trong production. Panel two-person (2026-10-12, zero-cost Task A) đã mở đường xác minh kênh (invite/seller — concierge §4), nhưng `/recover` VẪN không gửi được mã cho tới khi provider land (LAUNCH BLOCKER) — BLOCKING (FD-2) |
| FD-R2 | Ô Scoped RBAC cho support/moderator (§3) — BLOCKING |
| FD-R3 | Proofing out-of-band cho đường thủ công §4 — **ĐÃ QUYẾT 2026-10-13** (founder, chat): quy trình hai người §4b (gọi số đã xác minh + ≥ 2/3 câu + admin B ≠ A ≠ subject + link reset một lần 30 phút) là proofing được duyệt cho khôi phục mật khẩu tới FD-R1 — BLOCKING (chờ sign-off release checklist) |
| FD-R69 | Đã quyết (founder 2026-10-12, zero-cost Task A): panel two-person manual contact verification là đường CHUẨN cho CẢ HAI kênh (email + phone — §4 note); block §6 psql chỉ còn break-glass email-only; invite phone + seller verification không còn chặn tới FD-R1 — BLOCKING (chờ sign-off release checklist) |

Liên quan chéo: `docs/operations/concierge-onboarding-playbook.md` §4
(FD-R69), `docs/operations/incident-playbook.md` §4 (nghi ngờ chiếm tài
khoản), `docs/operations/admin-bootstrap-recovery-runbook.md` (runbook gốc —
§0/§2/§3/§6).
