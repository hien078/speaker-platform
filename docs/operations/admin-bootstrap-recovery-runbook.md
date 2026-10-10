# Runbook — Bootstrap quản trị & khôi phục MFA (Batch 2 Task 11)

> Phạm vi: cấp/quản lý **admin role**, enroll/reset **MFA (TOTP + mã khôi phục)**,
> và các quy trình khôi phục khi admin bị khóa. Mọi lệnh đều **offline maintenance**
> (spec §5.1.1 posture) — KHÔNG bao giờ expose qua HTTP/admin UI; chạy từ terminal
> của operator có quyền truy cập DB production.
>
> Spec: §5.4 (RBAC), §5.4.2 (admin session requirements — "Bootstrap and recovery
> procedures must be documented and tested to avoid permanent administrator
> lockout"), §4.6 (auditability), §4.8 (KHÔNG log secret/mã thô), §7.6 (revocation
> support), §8.5 (adminRole là nguồn quyền duy nhất). Runbook này ĐÃ EXERCISE:
> `tests/integration/admin-bootstrap.test.ts` đi theo từng bước ở §7, và chính các
> lệnh §0/§3/§6 đã được chạy thật (transcript §7).

## 0. Chạy trên server production (db container KHÔNG publish port)

`docker-compose.prod.yml` không expose port nào cho service `db` — KHÔNG có
`localhost:5432` trên host. Script bootstrap chạy qua **compose network** với image
`migrate` (stage `migrate` của Dockerfile có `node_modules` đầy đủ + `tsx`, nhưng
KHÔNG copy `scripts/` + `src/lib` — mount từ repo trên VPS; docs/deployment.md §2
clone đầy đủ repo nên hai thư mục này có sẵn; chuỗi import của script dùng đường
dẫn tương đối nên KHÔNG cần tsconfig.json trong image):

```bash
cd /path/to/loaviet   # thư mục deploy: docker-compose.prod.yml + .env + repo

docker compose -f docker-compose.prod.yml \
  run --rm \
  -v "$PWD/scripts:/app/scripts:ro" \
  -v "$PWD/src:/app/src:ro" \
  migrate npx tsx scripts/admin-bootstrap.ts <subcommand> [flags]
```

Giải thích:

- `run --rm migrate` — container một lần trên network compose, host `db` resolve
  được; `DATABASE_URL` có sẵn trong environment của service `migrate`.
- `ADMIN_MFA_ENCRYPTION_KEY` + `AUTH_SECRET` **nằm trong environment của service
  `migrate`** (compose nội suy từ `.env` ở thư mục deploy) — operator KHÔNG cần
  `set -a; source .env` hay `-e KEY` tay (tránh copy secret ra shell history).
- Script **từ chối chạy** khi thiếu `DATABASE_URL` (trong MÔI TRƯỜNG THẬT — dotenv
  không được là nguồn ngầm định đích) / `ADMIN_MFA_ENCRYPTION_KEY` / `AUTH_SECRET`,
  in **ĐÍCH redacted** (`db:5432/loaviet` — không password) trước khi chạy, và
  `--apply` bắt buộc kèm `--confirm-db <dbname>` khớp dbname trong DATABASE_URL
  (xác nhận đích hai lần — chống chạy nhầm DB).
- Cần psql trực tiếp (§3/§6): `docker exec -it loaviet-db psql -U loaviet -d loaviet`.

Trên máy dev (`.env` trỏ DB dev 5435): `DATABASE_URL=… npx tsx scripts/admin-bootstrap.ts …`
chạy thẳng (script vẫn đòi DATABASE_URL trong env thật + `--confirm-db` khi `--apply`).

> ⚠️ **Secret trên stdout & log driver (minor)**: `mfa-enroll --apply` in secret
> TOTP + 10 mã khôi phục ra stdout của container. stdout của `docker compose run`
> ĐỒNG THỜI được log driver mặc định (json-file) ghi ra file log trên host
> (`/var/lib/docker/containers/…`). Với `--rm` log bị xoá theo container; **tuyệt
> đối KHÔNG chạy `-d`/detached** (log nằm lại vô hạn), KHÔNG pipe/tee output ra
> file, và chỉ chạy ở session SSH của riêng operator. Nếu host có log shipper
> (vector/promtail) đọc docker logs — tắt cho project này hoặc chạy enroll ở
> máy dev rồi chuyển secret qua kênh mật khẩu-manager.

## 1. Bootstrap admin đầu tiên (deploy mới)

> ⚠️ **Trên production, MỌI lệnh dạng ngắn `npx tsx …` dưới đây PHẢI chạy qua
> wrapper §0** (compose run — db không publish port; script cần env production).
> §1–§5 viết dạng ngắn cho dễ đọc; thay tiền tố `npx tsx …` bằng khối `docker
> compose … migrate npx tsx …` của §0.

Mục tiêu: tài khoản founder có `super_admin` + MFA hoạt động, đăng nhập được bằng TOTP.

```bash
# 1) Cấp super_admin cho tài khoản founder (đã đăng ký bình thường qua /register)
#    dry-run trước — KHÔNG mutate gì:
npx tsx scripts/admin-bootstrap.ts promote --email founder@loaviet.vn --role super_admin
#    → in ĐÍCH redacted + kế hoạch: user id, role hiện tại (không có) → yêu cầu super_admin

#    chạy thật (--apply bắt buộc --confirm-db <dbname> — D4):
npx tsx scripts/admin-bootstrap.ts promote --email founder@loaviet.vn --role super_admin --apply --confirm-db loaviet
#    → ĐÃ ĐẶT adminRole + User.role="admin" (buyer; seller KHÔNG bị đè — D6);
#      thu hồi mọi session hiện có của user (buộc login lại qua MFA);
#      audit admin.bootstrap.promote (actor=null)

# 2) Enroll MFA — IN SECRET MỘT LẦN, chuẩn bị sẵn authenticator + password manager:
npx tsx scripts/admin-bootstrap.ts mfa-enroll --email founder@loaviet.vn --apply --confirm-db loaviet
#    → in otpauth:// URI (quét vào Google Authenticator/1Password/…),
#      secret base32 (nhập thủ công nếu không quét được), 10 mã khôi phục.
#      LƯU NGAY: DB chỉ lưu secret đã mã hóa (AES-256-GCM, ADMIN_MFA_ENCRYPTION_KEY)
#      + hash mã khôi phục — KHÔNG đọc lại được. Giá trị thô không còn tồn tại đâu
#      ngoài authenticator/password manager của bạn.

# 3) Đăng nhập kiểm tra: mật khẩu + mã TOTP → vào được /admin.
#    (Không nhập mã → form hiện field mã; sai mã → không vào — KHÔNG có session.)
```

Ghi chú:

- **Quy tắc thu hồi session khi đổi role**: MỌI grant/change/gỡ adminRole (UI
  `setAdminRoleAction` lẫn script `promote`) thu hồi TOÀN BỘ session của người
  được đổi trong CÙNG transaction (reason `admin_role_changed`) — session cũ
  không mang quyền role mới, buộc login lại qua MFA (Task 8 review: `isAdmin`
  chỉ được set bởi login path MFA).
- **D6 — role display**: grant KHÔNG đè `User.role` "seller" (seller giữ tính
  hiển thị; adminRole là nguồn quyền duy nhất — spec §8.5); buyer → "admin".
  **GỠ quyền** (`--role none`): adminRole → null + User.role restore từ "admin"
  theo marker (SellerVerification row HOẶC listing → "seller", else "buyer").
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
npx tsx scripts/admin-bootstrap.ts mfa-reset --email admin@loaviet.vn --apply --confirm-db loaviet
#    → admin bị đăng xuất mọi thiết bị; login chỉ mật khẩu bị chặn
#      MFA_ENROLLMENT_REQUIRED (fail closed — không có đường vào không MFA).

# 2) Enroll lại — secret MỚI, in MỘT LẦN:
npx tsx scripts/admin-bootstrap.ts mfa-enroll --email admin@loaviet.vn --apply --confirm-db loaviet

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
2. Từ VPS có quyền DB (§0), chạy **MỘT transaction** (BEGIN…COMMIT qua
   `psql -v ON_ERROR_STOP=1`): resolve user id MỘT LẦN trong DO block — không
   tìm thấy → `RAISE EXCEPTION` → ON_ERROR_STOP abort → **chưa đụng dữ liệu gì**;
   mutation + audit INSERT sống chết cùng tx (audit fail → ROLLBACK toàn bộ —
   không bao giờ "đã xoá MFA mà không có audit"). `AuditEvent.id` KHÔNG có DB
   default → cấp `gen_random_uuid()::text` tường minh:

   ```bash
   docker exec -i loaviet-db psql -U loaviet -d loaviet -v ON_ERROR_STOP=1 <<'SQL'
   BEGIN;
   DO $$
   DECLARE uid text;
   BEGIN
     SELECT "id" INTO uid FROM "User" WHERE "email" = 'super@loaviet.vn';
     IF uid IS NULL THEN
       RAISE EXCEPTION 'USER_NOT_FOUND: không có user với email đã cho — hủy toàn bộ (chưa đụng dữ liệu gì)';
     END IF;
     DELETE FROM "AdminMfa" WHERE "userId" = uid;
     UPDATE "UserSession" SET "revokedAt" = now(), "revokedReason" = 'admin_mfa_reset'
       WHERE "userId" = uid AND "revokedAt" IS NULL;
     INSERT INTO "AuditEvent" ("id","actorId","subjectId","action","resourceType","resourceId","reason","policyVersion","sessionId","detail","ipHash")
       VALUES (gen_random_uuid()::text, NULL, uid, 'admin.mfa_reset_manual', 'User', uid,
               'manual_last_resort', NULL, NULL,
               'mfa deleted via psql by operator (two-person confirmed)', NULL);
   END $$;
   COMMIT;
   SQL
   ```

   (action `admin.mfa_reset_manual` — đã ghi vào audit registry src/lib/audit-event.ts.)

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
`promote`) và **race-safe** (D2): bên trong tx, helper chia sẻ
`assertNotLastSuperAdminTx` (src/lib/admin-role-ops.ts) khoá mọi row super_admin
bằng no-op update rồi đếm từ kết quả đã khoá — hai tx demote chéo song song thì tx
 sau unblock thấy row tx trước ĐÃ demote (Postgres re-eval WHERE) → đúng MỘT thắng
(đã chứng minh bằng test integration: `Promise.all` hai demote chéo → 1 thành công).

Quy trình đúng khi điều chuyển/hạ role:

1. **Promote super_admin thứ hai trước** khi hạ super_admin đầu tiên:

   ```bash
   npx tsx scripts/admin-bootstrap.ts promote --email admin2@loaviet.vn --role super_admin --apply --confirm-db loaviet
   npx tsx scripts/admin-bootstrap.ts mfa-enroll  --email admin2@loaviet.vn --apply --confirm-db loaviet   # nếu admin2 chưa có MFA
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
   TOTP login của mọi admin fail closed (lỗi được captureError, KHÔNG throw ra
   caller); **mã khôi phục VẪN hoạt động** (hash derive từ AUTH_SECRET — không đụng
   key mã hóa) → admin còn mã khôi phục login được, nhưng secret TOTP không đọc lại
   được nên vẫn phải tái enroll.
3. **Tái enroll từng admin** (TOTP secret là payload mã hóa DUY NHẤT — không có
   cách decrypt lại bằng key đã mất):

   ```bash
   npx tsx scripts/admin-bootstrap.ts mfa-reset  --email <từng admin> --apply --confirm-db loaviet
   npx tsx scripts/admin-bootstrap.ts mfa-enroll --email <từng admin> --apply --confirm-db loaviet   # in secret MỚI một lần
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
   (OTP → đặt mật khẩu mới → mọi session bị thu hồi). **MỘT transaction** như §3
   (resolve id một lần, abort khi không tìm thấy, audit sống chết cùng mutation):

   ```bash
   docker exec -i loaviet-db psql -U loaviet -d loaviet -v ON_ERROR_STOP=1 <<'SQL'
   BEGIN;
   DO $$
   DECLARE uid text;
   BEGIN
     SELECT "id" INTO uid FROM "User" WHERE "email" = 'nguoi.dung@loaviet.vn';
     IF uid IS NULL THEN
       RAISE EXCEPTION 'USER_NOT_FOUND: không có user với email đã cho — hủy toàn bộ (chưa đụng dữ liệu gì)';
     END IF;
     UPDATE "User" SET "emailVerifiedAt" = now()
       WHERE "id" = uid AND "emailVerifiedAt" IS NULL;
     INSERT INTO "AuditEvent" ("id","actorId","subjectId","action","resourceType","resourceId","reason","policyVersion","sessionId","detail","ipHash")
       VALUES (gen_random_uuid()::text, NULL, uid, 'user.email_verified_manual', 'User', uid,
               'manual_out_of_band', NULL, NULL,
               'emailVerifiedAt set via psql by operator (two-person confirmed)', NULL);
   END $$;
   COMMIT;
   SQL
   ```

   (action `user.email_verified_manual` — đã ghi vào audit registry src/lib/audit-event.ts.)

3. Người dùng vào `/recover` → nhập email → nhận OTP → đặt mật khẩu mới
   (`confirmPasswordRecoveryAction` thu hồi MỌI session — spec §7.2).

## 7. Exercise checklist (runbook ĐÃ kiểm chứng)

Tự động (chạy mỗi lần đổi code liên quan — scratch DB, KHÔNG đụng production):

```bash
npm run test:integration
# → tests/integration/admin-bootstrap.test.ts đi ĐÚNG các bước §1/§2/§4:
#    promote dry-run → --apply (adminRole + role=admin + thu hồi session + audit)
#    → idempotent → last-super-admin guard → predicate backfill Task 1;
#    mfa-enroll (secret + 10 mã, refuse enroll đè, refuse user không adminRole)
#    → login không mã (mfaRequired) → login TOTP (session 12h) → mã khôi phục
#    single-use qua login thật; mfa-reset (xoá Mfa + thu hồi session + audit)
#    → login bị chặn MFA_ENROLLMENT_REQUIRED → re-enroll → login TOTP mới OK;
#    D2 race: HAI demote chéo song song → đúng MỘT thành công, ≥1 super_admin;
#    D6 gỡ quyền: adminRole null + role restore theo marker + audit to=none.
```

Thủ công (walk-through với output mong đợi — làm trên dev/staging trước production):

- [ ] `promote` dry-run in "── ĐÍCH: … (không in password)" + "dry-run (mặc định)" + kế hoạch.
- [ ] `promote --apply` thiếu `--confirm-db` → exit 1 "cần --confirm-db <dbname>".
- [ ] `--confirm-db` sai tên → exit 1 "≠ dbname trong DATABASE_URL".
- [ ] `promote --apply --confirm-db <dbname>` in "ĐÃ ĐẶT adminRole=…" + số session thu hồi.
- [ ] `mfa-enroll --apply` in khung "MFA ENROLLED — … CHỈ HIỆN MỘT LẦN" (URI + secret + 10 mã).
- [ ] `mfa-enroll --apply` lần hai → exit 1 "ĐÃ enroll MFA — chạy mfa-reset trước".
- [ ] `mfa-reset --apply` in "ĐÃ XOÁ AdminMfa" + số session + "BƯỚC KẾ: mfa-enroll".
- [ ] Đăng nhập web: mật khẩu + TOTP → /admin; sai mã → không vào.

### Transcript đã chạy thật (D1/D3/D4 — secret đã redact)

Stack test: `docker compose -f docker-compose.prod.yml --env-file <env-test-địa-phương>
-p loaviet-runbook-test build migrate` → `run --rm migrate` (2 migrations, marker
`0ed42b45…`) → seed 1 user qua psql → các lệnh dưới → `down -v` (chỉ project
`loaviet-runbook-test`). Env test sinh bằng `openssl rand` — KHÔNG commit.

```text
$ docker compose -f docker-compose.prod.yml --env-file …env -p loaviet-runbook-test \
    run --rm -v "$PWD/scripts:/app/scripts:ro" -v "$PWD/src:/app/src:ro" \
    migrate npx tsx scripts/admin-bootstrap.ts promote --email founder@runbook.test --role super_admin
── dry-run (mặc định) — truyền --apply --confirm-db <dbname> để chạy thật
── ĐÍCH: db:5432/loaviet (không in password)
── user: a5d3f5b2-…   role hiện tại: (không có) → yêu cầu: super_admin

$ … promote --email founder@runbook.test --role super_admin --apply            # thiếu --confirm-db
✗ --apply cần --confirm-db <dbname> — tên DB trong DATABASE_URL (xác nhận đích, …)   [exit 1]

$ … promote … --apply --confirm-db sai-db                                      # sai tên
✗ --confirm-db "sai-db" ≠ dbname trong DATABASE_URL ("loaviet") — đối chiếu lại đích.  [exit 1]

$ … promote … --apply --confirm-db loaviet
── ĐÍCH: db:5432/loaviet (không in password)
── ĐÃ ĐẶT adminRole=super_admin + thu hồi 0 session của user (buộc login lại qua MFA)
── audit: admin.bootstrap.promote (actor=null)

$ … mfa-enroll --email founder@runbook.test                                    # dry-run
── adminRole: super_admin    MFA: chưa enroll — có thể enroll

$ … mfa-enroll --email founder@runbook.test --apply --confirm-db loaviet
  MFA ENROLLED — THÔNG TIN NÀY CHỈ HIỆN MỘT LẦN, LƯU NGAY:
     otpauth://totp/LoaViet:founder%40runbook.test?…secret=<REDACTED>…
     secret base32: <REDACTED>
     · <10 mã khôi phục REDACTED>
── audit: admin.bootstrap.mfa_enrolled (actor=null, detail chỉ count)

$ … mfa-reset --email founder@runbook.test --apply --confirm-db loaviet
── ĐÃ XOÁ AdminMfa (kèm 10 hash mã khôi phục) …  đã thu hồi 0 session (reason admin_mfa_reset)
── BƯỚC KẾ: chạy mfa-enroll --apply lại cho user này, rồi user login bằng TOTP mới.

$ … mfa-enroll … --apply --confirm-db loaviet                                  # re-enroll sau reset
  MFA ENROLLED — … (secret MỚI)                                                 # vòng lặp ĐÓNG

$ docker exec loaviet-db psql -U loaviet -d loaviet -t -c 'SELECT action … FROM "AuditEvent" …'
 admin.bootstrap.promote        | reason=bootstrap_role_set     | detail=from=none to=super_admin;sessionsRevoked=0
 admin.bootstrap.mfa_enrolled   | reason=bootstrap_mfa_enroll   | detail=recoveryCodes=10
 admin.bootstrap.mfa_reset      | reason=bootstrap_mfa_reset    | detail=sessionsRevoked=0
 admin.bootstrap.mfa_enrolled   | reason=bootstrap_mfa_enroll   | detail=recoveryCodes=10
```

Block §3 (email không tồn tại → abort, MFA còn nguyên; rồi chạy thật — `BEGIN → DO → COMMIT`,
audit `admin.mfa_reset_manual` xuất hiện) và block §6 (`user.email_verified_manual`,
`emailVerifiedAt` set) đều đã chạy thật trên stack này — output khớp §3/§6.

## 8. Audit trail — grep sau mỗi thao tác

Mọi lệnh script ghi `AuditEvent` với **actor null** (system/offline — operator xác
nhận ngoài band); UI ghi actor = admin thực hiện. Tra vết (psql §0 hoặc UI
`/admin/audit` — capability `audit.read`, super_admin):

```sql
SELECT "createdAt", "action", "reason", "detail"
  FROM "AuditEvent"
 WHERE "action" LIKE 'admin.%' OR "action" LIKE 'user.%'
 ORDER BY "createdAt" DESC LIMIT 50;
```

| Thao tác | Action | Reason | Ghi chú |
|---|---|---|---|
| `promote --apply` (script) | `admin.bootstrap.promote` | `bootstrap_role_set` | detail `from=… to=…;sessionsRevoked=N` (actor null); `--role none` → `to=none` |
| `mfa-enroll --apply` (script) | `admin.bootstrap.mfa_enrolled` | `bootstrap_mfa_enroll` | detail `recoveryCodes=10` — CHỈ count, không mã thô; cùng tx enrollment (D5) |
| `mfa-reset --apply` (script) | `admin.bootstrap.mfa_reset` | `bootstrap_mfa_reset` | detail `sessionsRevoked=N` |
| Đổi/gỡ role qua UI | `admin.role_set` | reason code operator chọn | detail `from=… to=…` (`to=none` = gỡ); sống chết cùng tx thu hồi session |
| Xoá MFA qua psql (§3) | `admin.mfa_reset_manual` | `manual_last_resort` | ghi tay TRONG tx mutation (two-person) |
| Verified email qua psql (§6) | `user.email_verified_manual` | `manual_out_of_band` | ghi tay TRONG tx mutation (two-person) |
| Login admin bằng mã khôi phục | `admin.mfa_recovery_code_used` | `login_recovery_code` / `step_up_recovery_code` | mã đánh dấu `usedAt` (single-use) |
| Sinh lại mã khôi phục (UI) | `admin.mfa_recovery_codes_regenerated` | factor | detail `count=10` |
| Step-up | `admin.step_up` | factor (`totp`/`recovery_code`) | |
| Thu hồi session khi đổi role | `UserSession.revokedReason` | — | reason `admin_role_changed` / `admin_mfa_reset` |

**KHÔNG BAO GIỜ** có secret TOTP/mã khôi phục/mã OTP trong audit `detail` hay bất kỳ
log nào (spec §4.8) — script chỉ in ra terminal của operator MỘT LẦN (§1, xem cảnh
giới log driver ở §0).
