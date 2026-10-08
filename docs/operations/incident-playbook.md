# Playbook sự cố (incident playbook) — private beta

> **Phạm vi:** phân cấp sự cố, truyền thông, bảo toàn bằng chứng (spec §5.5.1),
> xử lý sự cố bảo mật, runbook vi phạm ranh giới tài chính, và template
> post-incident review. Batch 8 Task 4 (spec §12 "incident escalation exists").
>
> **Nguồn sự thật:** `docs/operations/monitoring-signals.md` (catalog tín hiệu
> Task 5 — đọc read-only), `scripts/ops-alerts.ts`, runbook Batch 2
> `docs/operations/admin-bootstrap-recovery-runbook.md` (MFA lockout / key
> rotation — tham chiếu theo mục, KHÔNG duplicate), `docs/backup-restore.md`
> (rollback DB), `src/lib/actions/admin-identity.ts` (các surface thu hồi
> session). Mọi tên trích dẫn đã đối chiếu mã nguồn đã merge.
>
> **Spec KHÔNG định nghĩa thang sự cố** — mọi ngưỡng phân cấp dưới đây là đề
> xuất PROVISIONAL `[FOUNDER DECISION — FD-R38]`.
>
> **Người vận hành production là founder/user** — mọi lệnh server dưới đây là
> bước của operator trên VPS (agent không bao giờ chạy gì chống production).

## 1. Phân cấp sự cố (SEV1–SEV3 — proposed defaults)

Mỗi mức gắn với **nguồn phát hiện** (tín hiệu `scripts/ops-alerts.ts` —
catalog `docs/operations/monitoring-signals.md` §1; cron 15 phút/lần, exit
code `1` = có CRITICAL) và **đường leo thang**. Ngưỡng của các tín hiệu là
PROPOSED DEFAULTS trong `DEFAULT_THRESHOLDS` (FD-R35) — phân cấp SEV là
FOUNDER decision (FD-R38).

| Mức | Định nghĩa (proposed) | Nguồn phát hiện | Leo thang |
|---|---|---|---|
| **SEV1** | Rò rỉ bảo mật / mất dữ liệu / **alert vi phạm ranh giới tài chính** / sập toàn bộ | `finance-boundary-violation` (CRITICAL — mọi ins/upd/row-count đổi trên bảng finance-only khi `FINANCIAL_FEATURES_ENABLED=false`); `health` CRITICAL (unreachable/`ok:false`); `backup-freshness` CRITICAL (không còn bản backup nào) | Gọi founder NGAY (kênh điện thoại — không chờ cron kế tiếp); §5 nếu là finance-boundary; §3 bảo toàn bằng chứng TRƯỚC khắc phục |
| **SEV2** | Suy giảm một phần / hàng đợi kiểm duyệt tràn / backup fail | `error-rate` WARN (> 20 dòng lỗi/15 phút); `auth-abuse-*` WARN (recovery requests > 10/15 phút, MFA failed > 5/15 phút, OTP max-attempts > 5/15 phút); `finance-boundary-cascade-delete` WARN; `cron-liveness` WARN (monitor chết > 1h); backup đêm fail (exit ≠ 0 trong `backups/backup.log`) | Operator on-call xử lý trong ca; quá 2 ca không giải quyết được → nâng lên founder; ghi ticket |
| **SEV3** | Vấn đề của một người dùng / bug nhỏ | Không có tín hiệu riêng — nguồn: kênh hỗ trợ của người dùng (concierge out-of-band), `/admin/moderation`, dashboard | Operator xử lý theo playbook thường nhật (moderation/seller-verification/recovery); không leo thang trừ khi lặp lại thành pattern (nhiều SEV3 giống nhau trong tuần → xem lại như SEV2) |

Ghi nhận về tầm nhìn của monitoring (monitoring-signals.md §3): login mật khẩu
SAI không có AuditEvent (tín hiệu auth-abuse là best-available từ
`AuditEvent` + `OtpCode`); bucket rate-limit in-memory không query được từ
ngoài process (RR-1); heartbeat cron chứng minh cron chạy, KHÔNG chứng minh
script thành công. Một sự cố chỉ thấy qua người dùng (không qua tín hiệu) là
**detection gap** — ghi vào post-incident review §6.

## 2. Truyền thông

- **Kênh nội bộ TRƯỚC:** SEV1 → gọi founder + operator on-call ngay (điện
  thoại/video — kênh chat có thể đã bị quan sát nếu nghi ngờ chiếm tài
  khoản). SEV2 → operator on-call, founder nếu kéo dài. SEV3 → ticket nội
  bộ. `[FOUNDER DECISION — FD-R38: ai là on-call, khung giờ phản hồi]`.
- **Thông báo người dùng (banner) là quyết định FOUNDER-LEVEL** — KHÔNG BAO
  GIỜ tự động publish banner/thông báo khi có sự cố; hệ thống không có cơ
  chế banner tự động, và việc công bố là quyết định truyền thông của founder.
- **KHÔNG đăng (kể cả nội bộ công khai):** PII của người dùng liên quan
  (email/phone/IP/nội dung tin nhắn — spec §4.8); chi tiết khai thác
  (exploit/vector) khi sự cố bảo mật còn mở — chia sẻ chỉ trong kênh điều
  tra khép kín cho tới khi vá xong; KHÔNG đổ lỗi người dùng công khai.
- Kênh phân phát alert là log lines + exit code (FD-R37) — email/Telegram
  là tích hợp deploy-time qua seam `captureError`/`captureEvent`
  (`src/lib/observability-core.ts`).

## 3. Bảo toàn bằng chứng (spec §5.5.1)

**Trong một sự cố đang điều tra:**

1. **KHÔNG xóa/sửa các listing/tin nhắn/người dùng liên quan.** Evidence
   kiểm duyệt đã chụp (`ModerationEvidence` — snapshot BẤT BIẾN chụp tại
   report time, sống qua edit/delete của nguồn) vẫn an toàn, nhưng xóa nguồn
   làm mất ngữ cảnh điều tra sống. Cơ chế bất biến được exercise bởi
   `tests/integration/report-evidence.test.ts` (Batch 3). Containment đúng
   cách: takedown (`takeDownListingAction` → `removed`), đình chỉ
   (`suspendUserAction`) — KHÔNG phải delete.
2. **KHÔNG chạy cleanup phá hủy** (`scripts/cleanup-uploads.ts --apply`,
   xoá DB thủ công, TRUNCATE, `db-ops.sh restore` đè…). Restore chỉ vào DB
   MỚI (`docs/backup-restore.md` — script từ chối đè đích đã tồn tại).
3. **Bảo toàn log container** trước khi container bị restart/recycle:

   ```bash
   docker compose -f docker-compose.prod.yml logs --no-log-prefix app > incident-<ts>.log
   # (chạy trên VPS — bước operator; <ts> = UTC timestamp của sự cố)
   ```

   Log JSON `captureError`/`captureEvent` (`src/lib/observability-core.ts`)
   là nguồn log cấu trúc; giữ cả `backups/ops-alerts.log` (output cron
   ops-alerts) nếu liên quan.
4. **Chụp snapshot DB TRƯỚC khi khắc phục, khi an toàn** (container-on-network
   pattern — KHÔNG host pg tools, db không publish port):

   ```bash
   ./scripts/db-ops.sh backup --keep 30   # trên VPS — bước operator
   ```

   Snapshot này vừa là bằng chứng (trạng thái tại thời điểm sự cố) vừa là
   điểm rollback. KHÔNG chụp nếu bản thân hành động backup làm trầm trọng
   thêm (vd đĩa đầy — SEV1 đĩa đầy thì dừng app trước).
5. **Ghi timeline vào incident doc** (mỗi sự cố một mục trong file vận hành
   hoặc ticket): thời điểm phát hiện, ai phát hiện (tín hiệu nào), các hành
   động + thời điểm, quyết định của founder. **`AuditEvent` (append-only) là
   nguồn timeline chính thức** — mọi hành động privileged đã ghi actor/action/
   resource/reason/timestamp (spec §4.6); đối chiếu timeline tay với
   `AuditEvent` (tra qua `/admin/audit` — capability `audit.read`, hoặc psql
   runbook §0) trước khi đóng sự cố.

**Bất biến hệ thống của record:** `ModerationEvidence` + `AuditEvent` +
`ModerationAction` là append-only từ product flow (chỉ create) — chúng là
system of record khi các nguồn mutable đã bị sửa/xóa. Retention evidence là
founder policy (FD-R7) — trong sự cố KHÔNG xóa evidence vì "hết hạn" tạm thời.

## 4. Sự cố bảo mật — các tình huống cụ thể

### 4a. Nghi ngờ chiếm tài khoản người dùng

1. **Thu hồi session:** `/admin/security` (operator giữ `session.revoke` —
   super/ops): `revokeUserSessionAction` (từng session, audit
   `session.revoked`) / `revokeAllUserSessionsAction` (toàn bộ, audit
   `session.revoked_all`) — `src/lib/actions/admin-identity.ts`.
2. **Buộc đặt lại mật khẩu:** hướng dẫn người dùng qua `/recover` (OTP tới kênh
   đã xác minh → mật khẩu mới → mọi session thu hồi trong cùng tx). Nếu
   nghi kẻ tấn công đang giữ MỌI kênh đã xác minh → xem §4c đường thủ công
   (two-person rule) — cân nhắc kỹ vì đường này cấp quyền truy cập lại.
3. **Đối soát audit:** tra `user.recovery_requested` / `user.recovery_completed`
   (recovery có phải người dùng thật không), `session.revoked*`,
   `user.email_changed`/`user.phone_changed`/`user.password_changed`,
   `beta_cohort.membership_set` (membership có bị đổi không). Grep mẫu:
   runbook §8 (bảng audit trail).
4. Đình chỉ tài khoản (`suspendUserAction` — step-up) nếu cần phong tỏa trong
   khi điều tra; ghi case kiểm duyệt.

### 4b. Nghi ngờ chiếm tài khoản admin

Tham chiếu runbook Batch 2 (KHÔNG duplicate): **§2** — còn mã khôi phục →
tự phục vụ qua `/admin/security`; mất hết → `mfa-reset` (thu hồi mọi session
của admin đó) → re-enroll TOTP. **§3** — mất hoàn toàn quyền bootstrap →
block psql `admin.mfa_reset_manual` (two-person rule). Sau khi lấy lại quyền:

- **Rà soát `admin.role_manage`:** `setAdminRoleAction` (super_admin +
  step-up) — kiểm tra `admin.role_set` audit gần đây có thay đổi role bất
  thường không; thu hồi role nghi ngờ (giữ bất biến ≥ 2 super_admin — runbook
  §4 last-super-admin guard).
- **Rà soát hành động của admin nghi ngờ:** mọi action privileged đã có
  AuditEvent (actor/action/reason) — đối chiếu khung thời gian nghi ngờ.
- Ghi nhận FD-R58 (security review): `session.revoke` không có rank check
  (operations_admin thu hồi được session super_admin — hữu ích khi phong tỏa
  nhưng cũng là mặt tiền nếu ops bị chiếm); `regenerateRecoveryCodesAction`
  chấp nhận mã khôi phục làm bằng chứng.

### 4c. Key rotation (tham chiếu runbook — KHÔNG duplicate)

| Key | Quy trình | Hệ quả bắt buộc đọc trước |
|---|---|---|
| `ADMIN_MFA_ENCRYPTION_KEY` | runbook Batch 2 **§5** | Mọi secret TOTP hiện có fail decrypt (typed `ADMIN_MFA_KEY_MISMATCH`) — **tái enroll từng admin** (mã khôi phục vẫn hoạt động vì hash từ `AUTH_SECRET`); RR-15: không có lệnh re-encrypt offline |
| `AUTH_SECRET` | runbook Batch 2 **§5b** | Mã khôi phục admin + hash OTP + ip-hash audit đều hết verify (HKDF từ `AUTH_SECRET`); **+ Batch 7: MỌI invite token đang sống cũng chết** (HMAC `"beta-invite-hash"` — `betaInviteTokenHash`/`src/lib/hkdf.ts`) → các lời mời chưa consume phải issue lại; TOTP vẫn hoạt động (key riêng) |
| `PRODUCT_EVENT_PSEUDONYM_KEY` | `.env.example` + `docs/deployment.md` (key riêng, không derive từ `AUTH_SECRET`) | RR-11: metric join qua version cũ gãy — `pseudonymKeyVersion` per row làm điều này PHÁT HIỆN ĐƯỢC; erasure user đòi recompute dưới key version mới (FD-R7/RR-30) |

## 5. Runbook vi phạm ranh giới tài chính (theo alert CRITICAL của Task 5)

**Ý nghĩa alert:** có ins/upd (hoặc row count đổi) trên bảng finance-only
khi `FINANCIAL_FEATURES_ENABLED=false` (đọc từ container app —
`docker exec loaviet-app printenv`). Trong beta, KHÔNG có luồng hợp lệ nào
ghi các bảng này → **mọi alert CRITICAL này là nghi ngờ bypass ranh giới
Batch 1 = critical security finding.**

1. **Xác nhận:** chạy lại watermark query (read-only — operator trên VPS):

   ```bash
   docker exec loaviet-db psql -U loaviet -d loaviet -tAc \
     'SELECT relname, n_tup_ins, n_tup_upd, n_tup_del FROM pg_stat_user_tables WHERE relname IN ('"'"'Order'"'"','"'"'OrderItem'"'"','"'"'Payment'"'"','"'"'Payout'"'"','"'"'WithdrawRequest'"'"','"'"'LedgerEntry'"'"','"'"'Dispute'"'"','"'"'OrderStatusHistory'"'"','"'"'PlatformSetting'"'"','"'"'CartItem'"'"','"'"'Offer'"'"','"'"'ExchangeOffer'"'"') ORDER BY relname;'
   ```

   So với watermark `backups/.ops-alerts-state.json` (counters + rowCounts
   mỗi bảng) — bảng nào đổi, chiều nào (ins/upd/del). Lưu ý phân loại
   (monitoring-signals.md §2): 9 bảng finance-only → CRITICAL trên mọi
   delta; 3 bảng cascade-affected (`CartItem`/`Offer`/`ExchangeOffer`) →
   delete là đợi mong từ xoá listing (WARN), ins/upd là CRITICAL.
   Counter giảm/stats reset → `finance-boundary-rebaseline` WARN (không
   CRITICAL giả) — đối chiếu `docker exec loaviet-db psql … pg_stat_reset`
   có ai chạy không.
2. **Đóng băng:** `docker compose -f docker-compose.prod.yml stop app` (dừng
   app — chặn write tiếp; db giữ nguyên cho điều tra). Đây là SEV1 — gọi
   founder.
3. **Chụp snapshot** (§3.4): `./scripts/db-ops.sh backup` — bằng chứng + rollback.
4. **Điều tra write path:** bảng đổi + khung thời gian (watermark lần chạy
   trước ↔ lần này) → `AuditEvent` trong khung đó (mọi action app đều audit);
   log app (`§3.3`); nếu không có audit tương ứng → nghi raw SQL/psql tay →
   đối chiếu session psql của operator. RR-9 ghi nhận: hai đường dormant
   (`resolveDisputeAction`, order-completion) set `approved` không qua gate —
   unreachable khi finance off, nhưng nếu bảng finance có delta thì kiểm tra
   cả hai.
5. **Khắc phục + ghi nhận:** vá lỗ bypass (nếu là code → security review +
   plan riêng — KHÔNG hot-fix trong Batch 8 perimeter); nếu là thao tác tay
   hợp lệ (vd operator chạy seed `PlatformSetting` trong lúc maintenance) →
   ghi nhận quy trình phải qua `--apply` có chủ đích. **Mọi trường hợp ghi
   vào `docs/operations/private-beta-security-review.md` (findings register)
   — alert không được phép "im lặng giải thích".**
6. **Re-baseline watermark:** sau khi xử lý, lần chạy ops-alerts kế tiếp tự
   ghi watermark mới (delta từ snapshot sạch); xác nhận bằng một lần chạy
   thủ công: `OPS_ALERTS_MODE=docker npx tsx scripts/ops-alerts.ts` (hoặc
   wrapper cron Path B) → exit 0.

## 6. Post-incident review (template — append mỗi sự cố)

Sau khi sự cố đóng (SEV1/SEV2 bắt buộc; SEV3 khi lặp lại), append một mục
theo template này vào file vận hành (ticket/doc sự cố):

```text
## Incident <ts> — <tóm tắt một dòng> (SEV<n>)
- Thời gian: phát hiện <ts> — đóng <ts> (múi giờ UTC).
- Phát hiện qua: <tín hiệu ops-alerts | kênh người dùng | operator> — nếu
  KHÔNG phải tín hiệu: detection gap gì đã làm chậm?
- Timeline: <các bước + thời điểm — nguồn chính thức: AuditEvent (§4.6),
  đối chiếu log container + watermark ops-alerts>.
- Ảnh hưởng: <số người dùng/tin đăng/bảng bị chạm — KHÔNG PII trong doc>.
- Nguyên nhân gốc: <technical root cause>.
- Khắc phục: <đã làm gì — commit/hash nếu là code>.
- Còn nợ (follow-ups): <mục + owner + hạn> — mỗi mục mở ticket; mục nào cần
  code change ngoài perimeter Batch 8 → plan riêng được review.
- Bài học monitoring: <tín hiệu nào thiếu — có nên thêm vào
  monitoring-signals.md không (sửa qua batch/plan riêng, không hot-fix)>.
```

Nguyên tắc: review ghi **fact + hành động**, không ghi PII (spec §4.8);
timeline đối chiếu `AuditEvent` trước khi đóng (§3.5); mọi follow-up có owner.

## 7. Founder Decision Items (playbook này mang)

| Mục | Ghi chú |
|---|---|
| FD-R35 | Ngưỡng các tín hiệu (§1 — DEFAULT_THRESHOLDS ops-alerts) |
| FD-R37 | Kênh phân phát alert (§2) |
| FD-R38 | Thang sự cố SEV1–3 + on-call/leo thang (§1–§2) |
| FD-R7 | Retention evidence trong điều tra (§3) |

Liên quan chéo: `docs/operations/monitoring-signals.md` (catalog tín hiệu —
read-only), `docs/operations/moderation-playbook.md` (takedown/đình chỉ là
containment), `docs/operations/account-recovery-playbook.md` (§4a buộc reset),
`docs/operations/admin-bootstrap-recovery-runbook.md` (§2/§3/§5/§5b/§8),
`docs/backup-restore.md` (snapshot/rollback).
