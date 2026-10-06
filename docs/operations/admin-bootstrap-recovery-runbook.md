# Runbook — Bootstrap quản trị & khôi phục MFA (Batch 2 Task 11)

> Phạm vi: cấp/quản lý **admin role**, enroll/reset **MFA (TOTP + mã khôi phục)**,
> và các quy trình khôi phục khi admin bị khóa. Mọi lệnh đều **offline maintenance**
> (spec §5.1.1 posture) — KHÔNG bao giờ expose qua HTTP/admin UI; chạy từ terminal
> của operator có quyền truy cập DB production.
>
> Spec: §5.4 (RBAC), §5.4.2 (admin session requirements — "Bootstrap and recovery
> procedures must be documented and tested to avoid permanent administrator
> lockout"), §4.6 (auditability), §4.8 (KHÔNG log secret/mã thô), §8.5 (adminRole là
> nguồn quyền duy nhất). Runbook này ĐÃ EXERCISE: `tests/integration/admin-bootstrap.test.ts`
> đi theo từng bước ở §7 — lệnh trong runbook chính là các hàm test gọi.

## 0. Chạy trên server production (db container KHÔNG publish port)

`docker-compose.prod.yml` không expose port nào cho service `db` — KHÔNG có
`localhost:5432` trên host. Script bootstrap chạy qua **compose network** với image
`migrate` (đã có `node_modules` đầy đủ + `tsx`; stage `migrate` của Dockerfile
KHÔNG copy `scripts/` + `src/lib` — phải mount từ repo trên server, docs/deployment.md
§2 clone đầy đủ repo lên VPS nên hai thư mục này có sẵn):

```bash
cd /path/to/loaviet            # thư mục deploy: docker-compose.prod.yml + .env + repo
set -a; source .env; set +a    # đưa DB_PASSWORD/AUTH_SECRET/ADMIN_MFA_ENCRYPTION_KEY vào shell

docker compose -f docker-compose.prod.yml run --rm \
  -v "$PWD/scripts:/app/scripts:ro" \
  -v "$PWD/src:/app/src:ro" \
  -e ADMIN_MFA_ENCRYPTION_KEY \
  -e AUTH_SECRET \
  migrate npx tsx scripts/admin-bootstrap.ts <subcommand> [flags]
```

Giải thích:

- `run --rm migrate` — container một lần trên network compose, host `db` resolve
  được; `DATABASE_URL` đã có trong environment của service `migrate`
  (`postgresql://loaviet:${DB_PASSWORD}@db:5432/loaviet`).
- `-e ADMIN_MFA_ENCRYPTION_KEY` / `-e AUTH_SECRET` — truyền từ shell (đã `source .env`);
  **PHẢI là giá trị production**: key mã hóa TOTP secret (envelope `v1:<keyId>:…`) và
  AUTH_SECRET (hash mã khôi phục derive HKDF) — sai key thì secret mã hóa không đọc
  được / mã khôi phục không verify được.
- Script **từ chối chạy** khi thiếu `DATABASE_URL` / `ADMIN_MFA_ENCRYPTION_KEY` /
  `AUTH_SECRET` (fail closed — không chạy mù).
- Cần psql trực tiếp (last resort §6): `docker compose -f docker-compose.prod.yml exec db psql -U loaviet -d loaviet`.

Trên máy dev (`.env` trỏ DB dev 5435): `npx tsx scripts/admin-bootstrap.ts …` chạy thẳng.

## 1. Bootstrap admin đầu tiên (deploy mới)

Mục tiêu: tài khoản founder có `super_admin` + MFA hoạt động, đăng nhập được bằng TOTP.

```bash
# 1) Cấp super_admin cho tài khoản founder (đã đăng ký bình thường qua /register)
#    dry-run trước — KHÔNG mutate gì:
npx tsx scripts/admin-bootstrap.ts promote --email founder@loaviet.vn --role super_admin
#    → in kế hoạch: user id, role hiện tại (không có) → yêu cầu super_admin

#    chạy thật:
npx tsx scripts/admin-bootstrap.ts promote --email founder@loaviet.vn --role super_admin --apply
#    → ĐÃ ĐẶT adminRole + User.role="admin"; thu hồi mọi session hiện có của user
#      (buộc login lại qua MFA); audit admin.bootstrap.promote (actor=null)

# 2) Enroll MFA — IN SECRET MỘT LẦN, chuản bị sẵn authenticator + password manager:
npx tsx scripts/admin-bootstrap.ts mfa-enroll --email founder@loaviet.vn --apply
#    → in otpauth:// URI (quét vào Google Authenticator/1Password/…),
#      secret base32 (nhập thủ công nếu không quét được), 10 mã khôi phục.
#      LƯU NGAY: DB chỉ lưu secret đã mã hóa (AES-256-GCM, ADMIN_MFA_ENCRYPTION_KEY)
#      + hash mã khôi phục — KHÔNG đọc lại được. Giá trị thô không còn tồn tại đâu
#      ngoài authenticator/password manager của bạn.

# 3) Đăng nhập kiểm tra: mật khẩu + mã TOTP → vào được /admin.
#    (Không nhập mã → form hiện field mã; sai mã → không vào — KHÔNG có session.)
```

Ghi chú:

- **Quy tắc thu hồi session khi đổi role**: MỌI grant/change adminRole (UI
  `setAdminRoleAction` lẫn script `promote`) thu hồi TOÀN BỘ session của người
  được đổi trong CÙNG transaction (reason `admin_role_changed`) — session cũ
  không mang quyền role mới, buộc login lại qua MFA (Task 8 review: `isAdmin`
  chỉ được set bởi login path MFA).
- Tài khoản legacy `role="admin"` từ trước Batch 2 đã được migration backfill
  thành `super_admin` (data transform `backfill-admin-role`, idempotent) —
  bootstrap §1 chỉ cần khi deploy MỚI hoặc tuyển thêm admin.
- **Luôn có ≥ 2 super_admin** khi nền tảng có > 1 người vận hành (xem §4).

## 2. Khôi phục khi admin bị khóa MFA (lockout)

Triệu chứng: admin mất điện thoại authenticator, còn mật khẩu, còn/mất mã khôi phục.

**Trường hợp A — còn ít nhất một mã khôi phục** (tự phục vụ, không cần operator):

1. Đăng nhập: mật khẩu + **mã khôi phục** thay vì mã TOTP (mã dùng MỘT lần, audit
   `admin.mfa_recovery_code_used`).
2. Vào `/admin/security` → "Sinh lại mã khôi phục" — nhập mã TOTP mới (từ authenticator
   đã khôi phục trên thiết bị mới — quét lại URI từ bản sao lưu, hoặc dùng mã khôi phục
   thứ hai) → 10 mã mới hiển thị MỘT LẦN → lưu vào password manager.

**Trường hợp B — mất hết mã khôi phục + authenticator** (operator can thiệp):

```bash
# 1) Xoá MFA + thu hồi mọi session (reason admin_mfa_reset) + audit:
npx tsx scripts/admin-bootstrap.ts mfa-reset --email admin@loaviet.vn --apply
#    → admin bị đăng xuất mọi thiết bị; login chỉ mật khẩu bị chặn
#      MFA_ENROLLMENT_REQUIRED (fail closed — không có đường vào không MFA).

# 2) Enroll lại — secret MỚI, in MỘT LẦN:
npx tsx scripts/admin-bootstrap.ts mfa-enroll --email admin@loaviet.vn --apply

# 3) Admin đăng nhập bằng mật khẩu + TOTP mới. Vòng lặp lockout → recovery ĐÓNG.
```

Vòng lặp này chính là `tests/integration/admin-bootstrap.test.ts` case 4
(reset → login bị chặn → re-enroll → login TOTP mới OK).

## 3. Mất hoàn toàn quyền bootstrap (last resort — thủ công, audited)

Tình huống: KHÔNG còn super_admin nào login được (mất MFA + mật khẩu + mã khôi phục
của mọi super_admin), hoặc mất cả quyền truy cập server. Đây là phương án **cuối
cùng**, offline, audited — làm ngay tại DB:

1. **Hai người xác nhận** (two-person rule): một người chạy lệnh, một người xác nhận
   danh tính/tính chính đáng của hành động qua kênh ngoài (điện thoại/video) — ghi
   rõ vào ticket/ghi chú vận hành.
2. Từ VPS có quyền DB (§0), reset MFA của super_admin cần cứu:

   ```bash
   docker compose -f docker-compose.prod.yml exec db psql -U loaviet -d loaviet
   ```

   ```sql
   -- xoá MFA (cascade 10 hash mã khôi phục) + thu hồi mọi session
   DELETE FROM "AdminMfa" WHERE "userId" = (SELECT "id" FROM "User" WHERE "email" = 'super@loaviet.vn');
   UPDATE "UserSession" SET "revokedAt" = now(), "revokedReason" = 'admin_mfa_reset'
     WHERE "userId" = (SELECT "id" FROM "User" WHERE "email" = 'super@loaviet.vn') AND "revokedAt" IS NULL;
   -- GHI AUDIT thủ công (spec §4.6 — không được phép thao tác mà không có vết):
   INSERT INTO "AuditEvent" ("actorId","subjectId","action","resourceType","resourceId","reason","detail")
     VALUES (NULL, (SELECT "id" FROM "User" WHERE "email" = 'super@loaviet.vn'),
             'admin.bootstrap.mfa_reset', 'User',
             (SELECT "id" FROM "User" WHERE "email" = 'super@loaviet.vn'),
             'manual_last_resort', 'mfa deleted via psql by operator (two-person confirmed)');
   ```

3. Chạy lại `mfa-enroll --apply` (§2B) cho admin đó → đăng nhập bằng TOTP mới.
4. Đặt lại mật khẩu nếu cần: dùng §6 (đặt `emailVerifiedAt` rồi tự phục vụ qua
   `/recover`) — KHÔNG đặt `passwordHash` tay trừ khi không còn cách nào.

> Ghi chú A3 (founder decision còn treo): quy trình **proofing** (chứng minh danh
> tính out-of-band) cho các hành động khôi phục thủ công CHƯA được founder định
> nghĩa — two-person rule + audit ở trên là cơ chế tối thiểu; mức proofing cụ thể
> (giấy tờ, video call, người thứ ba) thuộc Batch 8 Founder Decision Register.

## 4. Khôi phục role — last-super-admin guard

Bất biến: **không bao giờ để về 0 super_admin** (spec §5.4.2 — tránh khóa admin
vĩnh viễn). Guard này fail closed ở CẢ HAI đường (UI `setAdminRoleAction` + script
`promote`): hạ role của super_admin cuối cùng → typed error `LAST_SUPER_ADMIN`,
KHÔNG mutation (kể cả tự hạ chính mình — guard đếm super_admin KHÁC user đích).

Quy trình đúng khi điều chuyển/ha role:

1. **Promote super_admin thứ hai trước** khi hạ super_admin đầu tiên:

   ```bash
   npx tsx scripts/admin-bootstrap.ts promote --email admin2@loaviet.vn --role super_admin --apply
   npx tsx scripts/admin-bootstrap.ts mfa-enroll  --email admin2@loaviet.vn --apply   # nếu admin2 chưa có MFA
   ```

2. Hạ role cũ (qua UI `/admin/security` "Vai trò quản trị" — cần step-up/mã TOTP —
   hoặc script `promote --role operations_admin …`). Mọi thay đổi thu hồi toàn bộ
   session của người bị đổi (§1).
3. Nếu lỡ về 0 super_admin (không thể qua guard — chỉ khi mất cả quyền truy cập):
   dùng §3 để cứu một tài khoản, rồi `promote --role super_admin --apply` lại.

Lỗi `ADMIN_ROLE_CONFLICT` khi đổi role = request khác đã đổi role đó giữa chừng
(compare-and-set trên adminRole trước đó) — đọc lại trạng thái rồi chạy lại, KHÔNG
ghi đè.

## 5. Rotate `ADMIN_MFA_ENCRYPTION_KEY` (key mã hóa TOTP secret)

Key này DÀNH RIÊNG cho MFA (base64 của đúng 32 byte — `openssl rand -base64 32`),
KHÔNG derive từ AUTH_SECRET. Envelope secret là `v1:<keyId>:<base64(iv‖tag‖ct)>`
trong đó `keyId` = 8 hex đầu của SHA-256(key) — định danh KHÔNG bí mật.

1. Sinh key mới: `openssl rand -base64 32` → cập nhật `.env`
   (`ADMIN_MFA_ENCRYPTION_KEY`) → `docker compose -f docker-compose.prod.yml up -d`
   (app restart với key mới; compose từ chối start nếu thiếu key).
2. Hệ quả: mọi row `AdminMfa` hiện có được mã hóa bằng key CŨ → `keyId` trong
   envelope KHÔNG khớp key mới → decrypt raise typed `ADMIN_MFA_KEY_MISMATCH`
   (phát hiện được, KHÔNG bao giờ corrupt im lặng — đó là lý do envelope có keyId).
   TOTP login của mọi admin fail closed (và rơi sang mã khôi phục — cũng fail vì
   hash vẫn đúng nhưng TOTP path chết; admin còn mã khôi phục dùng được).
3. **Tái enroll từng admin** (TOTP secret là payload mã hóa DUY NHẤT — không có
   cách decrypt lại bằng key đã mất):

   ```bash
   npx tsx scripts/admin-bootstrap.ts mfa-reset  --email <từng admin> --apply
   npx tsx scripts/admin-bootstrap.ts mfa-enroll --email <từng admin> --apply   # in secret MỚI một lần
   ```

   Admin quét lại authenticator + lưu bộ mã khôi phục mới.
4. Tiền tố `v1:` của envelope tồn tại để format/key tương lai version được mà
   không mơ hồ — một lệnh re-encrypt offline sau này có thể rút ngắn quy trình
   này; tái enroll là đường an toàn P0 hiện tại.

## 5b. Rotate `AUTH_SECRET` (ảnh hưởng ngược — ĐỌC TRƯỚC KHI rotate)

`AUTH_SECRET` KHÔNG dùng mã hóa MFA (key riêng §5) nhưng là input HKDF của:

- **hash mã khôi phục admin** (`hkdfKey("recovery-code-hash")`) — rotate AUTH_SECRET
  → MỌI mã khôi phục hiện có **ngừng verify** (hash trong DB tính bằng key cũ);
- hash OTP (`otp-hash`) — mọi OTP đang sống chết hết (người dùng xin mã mới);
- hash IP trong audit (`ip-hash`) — IP hash cũ không còn so khớp được với IP mới.

Sau khi rotate AUTH_SECRET (và restart): TOTP **vẫn hoạt động** (secret mã hóa bằng
ADMIN_MFA_ENCRYPTION_KEY, không đụng AUTH_SECRET) → mỗi admin đăng nhập bằng TOTP
rồi vào `/admin/security` → "Sinh lại mã khôi phục" (step-up bằng TOTP) → bộ mã mới
hash bằng key mới. KHÔNG cần reset MFA.

## 6. Khôi phục tài khoản NGƯỜI DÙNG ngoài band (Ambiguity A3 — last resort)

Người dùng mất MỌI kênh đã xác minh (email + phone) không thể tự phục vụ —
recovery chỉ chạy qua kênh đã verified (spec §7.7, chống chiếm tài khoản qua SIM
tái sử dụng/email cũ). Phương án cuối cùng (audited, two-person rule — proofing
cụ thể là founder decision, xem ghi chú A3 ở §3):

1. Operator xác minh out-of-band người dùng thật sự sở hữu email trên tài khoản.
2. Đánh dấu kênh đó đã verified — người dùng TỰ phục vụ phần còn lại qua `/recover`
   (OTP → đặt mật khẩu mới → mọi session bị thu hồi):

   ```sql
   UPDATE "User" SET "emailVerifiedAt" = now()
     WHERE "email" = 'nguoi.dung@loaviet.vn' AND "emailVerifiedAt" IS NULL;
   INSERT INTO "AuditEvent" ("actorId","subjectId","action","resourceType","resourceId","reason","detail")
     VALUES (NULL, (SELECT "id" FROM "User" WHERE "email" = 'nguoi.dung@loaviet.vn'),
             'user.recovery_completed', 'User',
             (SELECT "id" FROM "User" WHERE "email" = 'nguoi.dung@loaviet.vn'),
             'manual_out_of_band', 'emailVerifiedAt set via psql by operator (two-person confirmed)');
   ```

3. Người dùng vào `/recover` → nhập email → nhận OTP → đặt mật khẩu mới
   (`confirmPasswordRecoveryAction` thu hồi MỌI session — spec §7.2).

## 7. Exercise checklist (runbook ĐÃ kiểm chứng)

Tự động (chạy mỗi lần đổi code liên quan — scratch DB, KHÔNG đụng production):

```bash
npm run test:integration
# → tests/integration/admin-bootstrap.test.ts đi ĐÚNG các bước §1/§2/§4:
#    promote dry-run → --apply (adminRole + role=admin + thu hồi session + audit)
#    → idempotent → last-super-admin guard → predicate backfill Task 1;
#    mfa-enroll (secret + 10 mã, refuse enroll đè) → login không mã (mfaRequired)
#    → login TOTP (session 12h) → mã khôi phục single-use qua login thật;
#    mfa-reset (xoá Mfa + thu hồi session + audit) → login bị chặn
#    MFA_ENROLLMENT_REQUIRED → re-enroll → login TOTP mới OK.
```

Thủ công (walk-through với output mong đợi — làm trên dev/staging trước production):

- [ ] `promote` dry-run in "dry-run (mặc định) — truyền --apply để chạy thật" + kế hoạch.
- [ ] `promote --apply` in "ĐÃ ĐẶT adminRole=… + User.role=\"admin\"" + số session thu hồi.
- [ ] `mfa-enroll --apply` in khung "MFA ENROLLED — THÔNG TIN NÀY CHỈ HIỆN MỘT LẦN" (URI + secret + 10 mã).
- [ ] `mfa-enroll --apply` lần hai → exit 1 "ĐÃ enroll MFA — chạy mfa-reset trước".
- [ ] `mfa-reset --apply` in "ĐÃ XOÁ AdminMfa" + số session + "BƯỚC KẾ: mfa-enroll".
- [ ] Đăng nhập web: mật khẩu + TOTP → /admin; sai mã → không vào.

## 8. Audit trail — grep sau mỗi thao tác

Mọi lệnh script ghi `AuditEvent` với **actor null** (system/offline — operator xác
nhận ngoài band); UI ghi actor = admin thực hiện. Tra vết (psql §0 hoặc UI
`/admin/audit` — capability `audit.read`, super_admin):

```sql
SELECT "createdAt", "action", "reason", "detail"
  FROM "AuditEvent"
 WHERE "action" LIKE 'admin.%'
 ORDER BY "createdAt" DESC LIMIT 50;
```

| Thao tác | Action | Reason | Ghi chú |
|---|---|---|---|
| `promote --apply` (script) | `admin.bootstrap.promote` | `bootstrap_role_set` | detail `from=… to=…;sessionsRevoked=N` (actor null) |
| `mfa-enroll --apply` (script) | `admin.bootstrap.mfa_enrolled` | `bootstrap_mfa_enroll` | detail `recoveryCodes=10` — CHỈ count, không mã thô |
| `mfa-reset --apply` (script) | `admin.bootstrap.mfa_reset` | `bootstrap_mfa_reset` | detail `sessionsRevoked=N` |
| Đổi role qua UI | `admin.role_set` | reason code operator chọn | detail `from=… to=…`; sống chết cùng tx thu hồi session |
| Login admin bằng mã khôi phục | `admin.mfa_recovery_code_used` | `login_recovery_code` / `step_up_recovery_code` | mã đánh dấu `usedAt` (single-use) |
| Sinh lại mã khôi phục (UI) | `admin.mfa_recovery_codes_regenerated` | factor | detail `count=10` |
| Step-up | `admin.step_up` | factor (`totp`/`recovery_code`) | |
| Thu hồi session khi đổi role | `UserSession.revokedReason` | — | reason `admin_role_changed` / `admin_mfa_reset` |

**KHÔNG BAO GIỜ** có secret TOTP/mã khôi phục/mã OTP trong audit `detail` hay bất kỳ
log nào (spec §4.8) — script chỉ in ra terminal của operator MỘT LẦN (§1).
