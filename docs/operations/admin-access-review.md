# Admin access review — sign-off & evidence (Batch 8 Task 7)

> Phạm vi: review định kỳ **quyền quản trị** — liệt kê mọi holder `User.adminRole`
> (nguồn quyền duy nhất — spec §8.5; KHÔNG review theo `User.role`/
> `isVerifiedSeller`), trạng thái MFA, mã khôi phục, inventory session, và hành
> động admin gần nhất. Cơ chế đáp ứng mục gate §9 Batch 8 **"admin MFA
> operational / RBAC operational"** (spec §5.4.2 "All admin accounts require MFA
> enrollment", §7.6 admin security: scoped RBAC + session ngắn + revocation +
> step-up + audit truy cập nhạy cảm).
>
> Công cụ: `scripts/admin-access-review.ts` — **offline maintenance command**
> (spec §5.1.1 posture: KHÔNG expose qua HTTP/admin UI; chạy từ terminal
> operator; READ-ONLY hoàn toàn — không có `--apply` vì không tồn tại đường
> mutation nào). Output: bảng markdown + findings typed ra stdout — operator
> paste vào mục dated dưới đây; **sign-off Reviewer/Date/Decision là
> founder-only** (spec §4.11 — không implementer/agent nào được điền).
>
> PII (spec §4.8): output chỉ chứa **id nội bộ + role + states/count** — KHÔNG
> email thô (operator correlate id qua `/admin/users`, capability
> `user.view_basic`), KHÔNG giá trị mã khôi phục (chỉ count chưa dùng), KHÔNG
> secret TOTP, KHÔNG token session. Unit test
> `tests/unit/admin-access-review.test.ts` chặn các hình đó trong bảng.

## 0. Cách chạy

**Dev** (DB dev publish port, ORM qua `DATABASE_URL` trong env thật — cùng D4
pattern `scripts/admin-bootstrap.ts`: `.env` KHÔNG tự dùng làm đích ngầm):

```bash
export DATABASE_URL="postgresql://…@localhost:5435/…"
npx tsx scripts/admin-access-review.ts
```

**Production** (db container KHÔNG publish port — `docker-compose.prod.yml`;
read-only qua `docker exec`, cùng container pattern `scripts/db-ops.sh`, KHÔNG
host pg tools):

```bash
npx tsx scripts/admin-access-review.ts --docker
# mặc định: DB_CONTAINER=loaviet-db  DB_USER=loaviet  DB_NAME=loaviet
# (khớp docker-compose.prod.yml — override qua env cùng tên như db-ops.sh)
```

Hai transport (ORM dev / `docker exec <container> psql --csv` production) cùng
một định nghĩa từng cột — đã kiểm chứng parity trên scratch DB (seed 2 admin:
MFA enrolled + 7/10 mã chưa dùng + session active/stale/revoked + audit events)
ngày 2026-10-06: output hai transport **khớp từng byte** (ch khác dòng ĐÍCH).

Exit code: `0` khi review chạy xong (findings là **tín hiệu cho sign-off** —
quyết định thuộc founder); `1` khi lỗi vận hành (thiếu env, DB/psql lỗi).

## 1. Findings vocabulary + cách xử lý

| Finding | Ý nghĩa | Xử lý |
|---|---|---|
| `ADMIN_WITHOUT_MFA:<userId>` | admin chưa enroll MFA — vi phạm §5.4.2 (fail-closed) | enroll qua `npx tsx scripts/admin-bootstrap.ts mfa-enroll --email <e> --apply --confirm-db <dbname>` (runbook §1); KHÔNG bao giờ bỏ qua |
| `NO_UNUSED_RECOVERY_CODES:<userId>` | admin ĐÃ enroll nhưng hết mã khôi phục chưa dùng — nguy cơ lockout (runbook §2B) | admin tự sinh lại 10 mã tại `/admin/security` (step-up bằng TOTP); đã mất hết mã + authenticator → runbook §2B |
| `STALE_SESSIONS:<userId>` | admin giữ session active (chưa revoke, chưa hết hạn) cũ hơn TTL admin 12h — session consumer 30 ngày của tài khoản admin | cân nhắc thu hồi qua `/admin/security` (inventory + revoke); quy tắc thu hồi khi đổi role: runbook §1 |
| `LAST_SUPER_ADMIN` | đúng MỘT super_admin — tiếng vang operational của last-super-admin guard | promote super_admin thứ hai TRƯỚC khi hạ role hiện tại (runbook §4); luôn ≥ 2 khi > 1 người vận hành |
| `NO_ADMINS` | không có admin nào | bootstrap admin đầu tiên (runbook §1) |

Ghi chú: **0 super_admin khi vẫn còn admin khác** KHÔNG có finding typed (bảng
hiển thị rõ phân bố role) — phục hồi theo runbook §4. Tuổi tương đối của "hành
vi admin gần nhất" lấy từ `AuditEvent` gần nhất có `actorId` = user (mọi action
privileged đều audit — spec §4.6).

## 2. Standing review context — quan sát FD-R58 (Batch 2 Task 9)

Hai quan sát được ghi nhận là **posture P0 được chấp nhận**, flag cho founder/
security review (Batch 8 Task 8) — mỗi lần review đều đối chiếu lại:

1. **`session.revoke` KHÔNG có rank check** — `operations_admin` có
   `session.revoke` trong ma trận (`src/lib/rbac.ts` `ROLE_CAPABILITIES`) nên
   thu hồi được session của `super_admin` qua `revokeUserSessionAction`/
   `revokeAllUserSessionsAction` (`src/lib/actions/admin-identity.ts`, audit
   `session.revoked`/`session.revoked_all`). Chấp nhận P0: mọi thu hồi đều
   được audit; super_admin login lại bằng MFA.
2. **Một mã khôi phục đủ để sinh lại 10 mã mới** —
   `regenerateRecoveryCodesAction` (`src/lib/actions/admin-identity.ts`) nhận
   mã MFA qua `verifyAdminMfaCode` trả `"totp" | "recovery_code" | null`
   (`src/lib/admin-mfa.ts`) — recovery code là "proof" hợp lệ: mã được đánh
   dấu `usedAt` ngay ở bước verify (atomic single-use — burn một mã để mint
   mười: đường tự phục vụ lockout được ghi nhận), rồi MỘT transaction xoá 10
   mã cũ + tạo 10 mã mới. MỘT mã bị lộ ⇒ kẻ cắp sinh được bộ 10 mã MỚI (các
   mã cũ của chủ tài khoản chết cùng lúc). Chấp nhận P0: rate limit 3 bucket
   `stepup:mfa:*` (`src/lib/rbac.ts` `stepUpMfaLimited`), audit
   `admin.mfa_recovery_codes_regenerated`, mã mới hiển thị MỘT lần.

## 3. Nhịp review (cadence)

- **Pre-launch: BẮT BUỘC** (§9 Batch 8 gate "admin MFA operational / RBAC
  operational") — chạy production (`--docker`), paste output vào mục dated,
  founder ký sign-off.
- Sau đó: **per-release hoặc monthly — `[FOUNDER DECISION]`** (chưa có số
  spec; ghi nhận Founder Decision Register Batch 8). Đề xuất mặc định: mỗi
  lần release + monthly.

## 4. Sign-off (FOUNDER-ONLY — spec §4.11)

> KHÔNG implementer/agent nào được điền Reviewer/Date/Decision. Các ô dưới đây
> chỉ founder điền sau khi đọc output review gần nhất + xử lý/xác nhận mọi
> finding.

| Lần review (mục dated) | Reviewer | Date | Decision (APPROVED / REJECTED / PENDING) | Ghi chú finding |
|---|---|---|---|---|
| 2026-10-06 — dev run (§5.1) | — (chờ founder) | — | PENDING | dev scratch DB: 1 super_admin chưa enroll MFA (dữ liệu dev, không phải production) |
| (production pre-launch run — operator paste tại đây) | | | | |

## 5. Evidence — các lần review (mỗi lần append một mục dated)

> Pattern: MỘT file template + các lần review append (cùng pattern
> `docs/operations/restore-drill-evidence.md` — Batch 8 Task 6 tạo file đó;
> cùng cơ chế dated-sections). KHÔNG paste dump/secret — chỉ output review
> (id nội bộ + role + states/count).

### 2026-10-06 — dev run (Batch 8 Task 7, bước "Run against dev")

Stack: dev DB `localhost:5435/speaker_platform` (container `speaker-postgres`,
scratch). Lệnh: `npx tsx scripts/admin-access-review.ts` (transport ORM).

```text
── ĐÍCH: localhost:5435/speaker_platform (không in password)

| userId | adminRole | MFA | Mã khôi phục chưa dùng | Session active | Session quá TTL | Hành động admin gần nhất | Tuổi tài khoản (ngày) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| e101fe3f-3afc-4b28-98bd-c4636b3927e1 | super_admin | CHƯA enroll | 0 | 0 | 0 | — | 3 |

── Findings:
   · ADMIN_WITHOUT_MFA:e101fe3f-3afc-4b28-98bd-c4636b3927e1
   · LAST_SUPER_ADMIN
── Paste output này vào docs/operations/admin-access-review.md (mục dated) — sign-off founder-only.
── Review hoàn tất (findings là tín hiệu cho sign-off, KHÔNG phải lỗi chạy).
```

Đọc kết quả: dev DB chỉ có 1 user `super_admin` (dữ liệu seed dev — KHÔNG phải
production): chưa enroll MFA → `ADMIN_WITHOUT_MFA` (đúng §5.4.2 fail-closed —
dev không bắt buộc MFA để test) + `LAST_SUPER_ADMIN` (đúng guard runbook §4).
**Production pre-launch run là bước của operator** — chạy `--docker` trên
server, paste mục dated mới tại đây; release checklist (Batch 8 Task 9) mang
dòng sign-off tương ứng.

### (mục dated tiếp theo — append tại đây)
