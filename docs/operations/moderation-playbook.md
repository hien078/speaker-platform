# Playbook kiểm duyệt (moderation) — private beta

> **Phạm vi:** cách đội operations làm việc với hàng đợi kiểm duyệt (moderation
> queue) — phân công, xử lý, takedown, đình chỉ, kháng cáo, bảo toàn bằng
> chứng. Batch 8 Task 3 (spec §9 "moderation operational", §12 "moderation
> works" + "support path exists").
>
> **Nguồn sự thật:** mã nguồn đã merge (Batches 2–7). Mọi tên action /
> capability / audit action / reason code trích dẫn dưới đây đều đối chiếu
> `src/lib/actions/moderation.ts`, `src/lib/moderation(-vocab).ts`,
> `src/lib/rbac.ts`, `src/lib/audit-event.ts`, `app/admin/moderation/**`.
> Playbook tham chiếu — KHÔNG thay thế — runbook Batch 2
> `docs/operations/admin-bootstrap-recovery-runbook.md` (MFA lockout admin).
>
> **Không phát minh chính sách (spec §4.11):** mọi ngưỡng/SLA/thuật ngữ sanction
> mà spec không định nghĩa được đánh dấu `[FOUNDER DECISION — FD-R<n>]` và liệt
> kê ở §9. Cơ chế fail-closed đã ship là mặc định vận hành cho tới khi founder
> quyết định.

## 1. Hàng đợi case — trạng thái và phân công

Case kiểm duyệt (`ModerationCase`) nhóm nhiều báo cáo theo khóa
`(targetType, targetId, reasonCategory)` khi còn active — partial unique index
`moderation_case_one_active_per_target_reason` chỉ cho MỘT case active duy nhất
mỗi khóa (race đồng thời: bên thua tự vào case của bên thắng — RR-7, benign).

**Bảy trạng thái (spec §5.5 verbatim — `MODERATION_CASE_STATES`,
`src/lib/moderation-vocab.ts`):**

```text
open → triaged → investigating → actioned → dismissed → appealed → closed
```

**Bảng chuyển trạng thái hợp pháp cho thao tác MANUAL
(`MODERATION_TRANSITIONS`):**

| from | to (được phép) |
|---|---|
| `open` | `triaged`, `investigating`, `dismissed`, `actioned` |
| `triaged` | `investigating`, `actioned`, `dismissed` |
| `investigating` | `actioned`, `dismissed` |
| `actioned` | `closed` |
| `appealed` | `closed` |
| `dismissed` | `closed` |
| `closed` | (terminal — không có chuyển đi) |

Lưu ý cơ chế (pin bằng test Batch 3 Task 6): `actioned → appealed` KHÔNG nằm
trong bảng manual — trạng thái `appealed` CHỈ được ghi qua flow kháng cáo của
chủ thể (`recordAppealAction`, §5). Moderator không tự set `appealed`.

**Trường `priority`** (`low | normal | high` — `MODERATION_PRIORITIES`): là dữ
liệu phân loại, spec KHÔNG định nghĩa ngữ nghĩa ưu tiên hay SLA theo mức —
không invent SLA `[FOUNDER DECISION — FD-R9]`. Operator set khi triage qua
`transitionModerationCaseAction`.

**Phân công:** `assignModerationCaseAction` (capability `report.resolve` —
super_admin/operations_admin/moderator theo ma trận `ROLE_CAPABILITIES`
`src/lib/rbac.ts`; support/analyst fail closed). Lý do gán là typed reason code
từ `MODERATION_ASSIGNMENT_REASON_CODES` (`triage_assignment`, `reassignment`,
`other_reviewed_reason` — PROVISIONAL A8, §8). Audit
`moderation.case_assigned` + `ModerationAction` `case.assigned` (append-only,
cùng tx).

## 2. Xung đột lợi ích — recusal (fail closed)

Cơ chế ship: `isCaseViewerConflicted` / `assertActorNotConflicted`
(`src/lib/moderation.ts` + `src/lib/actions/moderation.ts`):

- **Chủ thể của case** (subject — resolve từ `ModerationEvidence.subjectUserId`
  BẤT BIẾN chụp lúc report, fallback live lookup) và **người báo cáo**
  (reporter — `AbuseReport.reporterId`) KHÔNG được xem evidence của case
  (recusal on views — case page check TRƯỚC mọi read phục vụ render) và
  KHÔNG được quyết định case (`MODERATOR_CONFLICT` throw).
- Takedown không kèm case cũng check: actor là seller của listing
  (self-target) hoặc reporter trên case active nhắm listing đó →
  `MODERATOR_CONFLICT`; case active đang nhắm listing mà không truyền
  `caseId` → `CASE_REQUIRED_FOR_TAKEDOWN` (fail closed — moderator phải đi
  qua case để chạy đủ case checks).

Đây là cơ chế **từ chối mặc định**; chính sách recusal chi tiết (khi nào người
thân, quan hệ kinh doanh với seller…) là của founder
`[FOUNDER DECISION — FD-R11 — BLOCKING: acknowledge mặc định fail-closed]`.

## 3. Takedown listing vs từ chối admin

Hai đường độc lập, KHÔNG thay thế nhau:

- **Takedown kiểm duyệt** — `takeDownListingAction` (capability
  `listing.moderate`; super/ops/moderator): chuyển `Listing.status` →
  `removed` (R4). Status `removed` nằm trong
  `MODERATION_LOCKED_LISTING_STATUSES` (R5): seller KHÔNG được
  edit/toggle/delete listing này nữa (`isModerationLocked` guard trong
  `updateListingAction`/`toggleListingVisibilityAction`/`deleteListingAction`).
  **Đường khôi phục DUY NHẤT là kết quả kháng cáo** (§5) — không có đường
  un-remove từ UI seller `[FOUNDER DECISION — FD-R8]`. `previousStatus` được
  ghi trong `AuditEvent.detail` lúc takedown (để restore sau appeal có căn cứ).
- **Từ chối admin** — `rejectListingAction` (capability `listing.moderate`,
  `src/lib/actions/admin.ts`): chuyển → `rejected`, kèm audit
  `listing.rejected` / chặn thì `listing.reject_blocked` (reason typed:
  `listing_version_missing` / `listing_changed_during_review` /
  `moderator_conflict`). Quy tắc tạm (recorded): listing legacy `rejected`
  không resubmit `[FOUNDER DECISION — FD-R18]`.

Takedown có thể kèm `caseId` (case phải nhắm CHÍNH listing này, state ∈
actionable — `open`/`triaged`/`investigating`/`actioned`); case chưa
actioned được chuyển atomic sang `actioned` (`resolved_by_sanction`) trong
cùng tx — link kháng cáo người dùng nhận trỏ vào case ĐANG actioned.

## 4. Bằng chứng (spec §5.5.1)

- **Bất biến:** `ModerationEvidence` chỉ được TẠO ở `submitReportAction`
  (`captureTargetSnapshot` — `src/lib/moderation-snapshot.ts`) trong cùng tx
  với report; KHÔNG có đường update/delete từ product flow. Snapshot sống qua
  edit/delete của nguồn (`subjectUserId` chụp tại report time). Cơ chế được
  exercise bởi `tests/integration/report-evidence.test.ts`.
- **Hạn chế truy cập:** case page recusal (§2) — subject/reporter không xem
  được evidence của case nhắm mình.
- **Mọi lần xem được audit:** mở case detail trong admin ghi
  `moderation.evidence_viewed` (`app/admin/moderation/[id]/page.tsx` — spec
  §5.5.1 "separately audited").
- **Trong case đang điều tra: KHÔNG xóa/sửa nguồn mutable** (listing/message/
  user). Chỉnh sửa xong sẽ không phá evidence đã chụp, nhưng xóa nguồn làm mất
  ngữ cảnh điều tra sống — takedown (§3) là biện pháp containment đúng, KHÔNG
  phải delete. Nguyên tắc này mở rộng thành quy trình sự cố ở
  `docs/operations/incident-playbook.md` §3.
- **Chính sách retention** evidence (khi nào được xóa, giữ bao lâu, tương tác
  với xóa tài khoản) là quyết định pháp lý founder
  `[FOUNDER DECISION — FD-R7 — BLOCKING]`.

## 5. Kháng cáo (appeal) — intake thủ công

Cơ chế ship (Batch 3 Task 7 — foundation only):

1. Chủ thể case (subject — resolve từ evidence, §2) gọi
   `recordAppealAction` (`src/lib/actions/appeals.ts`): chỉ được appeal khi
   case `actioned` (khác → `APPEAL_NOT_AVAILABLE`); statement ≤ 4000 ký tự
   (`APPEAL_STATEMENT_MAX_LENGTH`); một Appeal per case (`Appeal_caseId_key`).
2. Thành công: `Appeal` (state `submitted`) + case CAS `actioned → appealed` +
   `ModerationAction` `appeal.recorded` — cùng một tx.
3. **Quyết định kháng cáo** (ai xét, kết quả, thời hạn, re-appeal, restore
   listing `removed`) là POLICY — cơ chế chỉ ghi nhận, KHÔNG quyết
   `[FOUNDER DECISION — FD-R8 — BLOCKING]`. `appealed → closed` do wiring
   Batch 3 Task 6 đóng bookkeeping.

**LỖI HỆ THỐNG ĐÃ BIẾT — khoảng trống thông báo (notification gap):** case
được actioned mà KHÔNG kèm sanction liên kết KHÔNG gửi thông báo link kháng
cáo nào cho chủ thể — người dùng không tự biết mình có quyền appeal. **Operator
PHẢI thông báo thủ công** (kênh out-of-band của concierge, xem
`docs/operations/concierge-onboarding-playbook.md`) cho chủ thể mỗi case
actioned ảnh hưởng họ. Khoảng trống này được ghi nhận ở FD-R8 (nguồn B3-A4).

## 6. Đình chỉ tài khoản — hand-off moderator → operations_admin

Ma trận `ROLE_CAPABILITIES` (`src/lib/rbac.ts`):

- **moderator** giữ `listing.moderate` + `report.resolve` — KHÔNG giữ
  `user.suspend`.
- **`user.suspend`** chỉ super_admin + operations_admin, và nằm trong
  `STEP_UP_CAPABILITIES` — mọi suspend đòi step-up MFA (spec §5.4.2
  "destructive account action"; lift KHÔNG đòi — recorded decision Batch 3).

**Quy trình hand-off (đến khi founder định nghĩa ô Scoped —
`[FOUNDER DECISION — FD-R2 — BLOCKING]`):** moderator phát hiện hành vi cần
đình chỉ → (1) gán case cho operations_admin/super_admin
(`assignModerationCaseAction`, reason `reassignment` hoặc
`other_reviewed_reason`) HOẶC thông báo trực tiếp qua kênh nội bộ kèm id case;
(2) operations_admin chạy `suspendUserAction` (userId + reasonCode từ
`SUSPENSION_REASON_CODES` + note ≤ 2000 ký tự qua `redactDetail` + `caseId` +
mã TOTP step-up). Case chưa actioned được chuyển atomic `actioned`
(`resolved_by_sanction`) trong cùng tx. Audit `moderation.user_suspended` +
`ModerationAction` `user.suspended` + notify seller (best-effort,
`moderation.user_suspended_notify`).

**Ngữ nghĩa đình chỉ đã ship (P0 minimal set — spec §7.8):**

- KHÔNG thu hồi session, KHÔNG chặn login (sanction policy ngoài §7.8 minimal
  set — RR-16; guard đọc DB FRESH mỗi action nên lift có hiệu lực NGAY).
- Listing đã công khai của người bị đình chỉ VẪN sống cho tới khi moderator
  quyết định takedown (RR-17) — đình chỉ không tự unpublish.
- Chặn: MỌI transition publication (yêu cầu `account_not_suspended` trong
  `checkSellerPublicationRequirements`), mở hội thoại MỚI / Deal MỘT
  (`assertListingSellerInteractable` → `SELLER_SUSPENDED`;
  `assertCanStartConversation` → `ACCOUNT_SUSPENDED`), gửi tin nhắn MỚI
  trong hội thoại cũ (`assertCanSendMessage` — actor-side), nhận lời mời
  founding seller (`INVITE_ACCOUNT_SUSPENDED`).
- **Tin nhắn trong hội thoại ĐÃ TỒN TẠI của seller bị đình chỉ/thu hồi xác
  minh vẫn ghi được** (perimeter chỉ chặn tương tác MỚI — Batch 6 D2/Batch 7
  D4, actor-side guards) — ghi nhận là hành vi chấp nhận
  `[FOUNDER DECISION — FD-R53, liên quan FD-R6]`.
- Đình chỉ membership founding_seller (khác đình chỉ tài khoản): không
  unpublish, không thu hồi session, không chặn tin nhắn hội thoại cũ, không
  auto-hết hạn — xem FD-R51.

**KHÔNG đình chỉ tài khoản admin qua moderation** (B3-A6): lockout admin là
domain của runbook Batch 2 (`docs/operations/admin-bootstrap-recovery-runbook.md`
§2/§3) — tham chiếu, không duplicate `[FOUNDER DECISION — FD-R10]`.

## 7. Báo cáo + block (ngữ cảnh queue)

- Report: `submitReportAction` — 9 reason category spec §5.5 verbatim
  (`REPORT_REASON_CODES`), target `listing|user|message`, rate 5/10 phút/
  reporter (`REPORT_RATE_LIMIT`), note ≤ 2000 ký tự. Mọi report kèm snapshot
  evidence (§4).
- Block: `blockUserAction`/`unblockUserAction` — 20 lần/phút
  (`BLOCK_ACTION_RATE_LIMIT`); block chặn hội thoại MỚI + tin nhắn HAI chiều +
  Deal interaction, KHÔNG xóa evidence/tin nhắn lịch sử (spec §5.5).

## 8. Từ vựng sanction — PROVISIONAL, chờ founder

Các vocabulary reason sau là **vocabulary implementation** thỏa yêu cầu
"typed reasons" của spec §5.5 — GIÁ TRỊ không phải spec-sourced, mang marker
`PROVISIONAL (A8)` ngay tại khai báo (`src/lib/moderation-vocab.ts`), label
tiếng Việt ở `src/lib/constants.ts`. Founder author/acknowledge TRƯỚC beta
`[FOUNDER DECISION — FD-R12 — BLOCKING: founder-authored content per FD-3]`:

- `SUSPENSION_REASON_CODES`: `confirmed_abuse`, `confirmed_scam`,
  `confirmed_harassment`, `confirmed_spam`, `prohibited_content`,
  `terms_violation`, `other_reviewed_reason`.
- `MODERATION_DECISION_REASON_CODES`: `no_violation_found`,
  `insufficient_evidence`, `policy_violation_confirmed`,
  `resolved_by_sanction`, `duplicate_case`, `appeal_closed`,
  `other_reviewed_reason`.
- `MODERATION_ASSIGNMENT_REASON_CODES`: `triage_assignment`, `reassignment`,
  `other_reviewed_reason`.

**Copy kiểm duyệt hiện là PLACEHOLDER** (FD-R50 — BLOCKING): nội dung thông
báo đình chỉ/takedown, copy trang kháng cáo, nhãn reason — founder thay bằng
wording chính thức trước beta; bản hiện tại chỉ nêu mechanics, không phát minh
quyền/ hệ quả.

**Sanction nào cho vi phạm nào, thời hạn, escalation, auto-lift** — chính
sách sanction tổng thể (kể cả việc đình chỉ có kéo theo thu hồi session hay
không ở tương lai) là founder decision
`[FOUNDER DECISION — FD-R6 — BLOCKING]`. P0: sanction thủ công, vô thời hạn
cho tới khi lift thủ công (`liftSuspensionAction` — audit
`moderation.user_suspension_lifted`).

## 9. Founder Decision Items (playbook này mang)

| Mục | Ghi chú |
|---|---|
| FD-R2 | Ô Scoped của ma trận RBAC (moderator/support `user.suspend`·`user.view_basic`·`session.revoke`·`audit.read`, `pii.*`) — hand-off §6 là cơ chế tạm |
| FD-R6 | Chính sách sanction: sanction nào/thời hạn/escalation/auto-lift; thu hồi session khi đình chỉ |
| FD-R7 | Retention & xóa evidence kiểm duyệt (§4) |
| FD-R8 | Workflow kháng cáo: reviewer, kết quả, thời hạn, re-appeal, restore listing `removed` + notification gap §5 |
| FD-R9 | Ngữ nghĩa `priority` (không SLA — §1) |
| FD-R10 | Đình chỉ admin = domain runbook Batch 2 (§6) |
| FD-R11 | Chính sách recusal chi tiết (§2) |
| FD-R12 | Vocabulary sanction PROVISIONAL (§8) — BLOCKING |
| FD-R18 | Listing legacy `rejected` không resubmit (§3) |
| FD-R50 | Copy kiểm duyệt placeholder (§8) — BLOCKING |
| FD-R51 | Ngữ nghĩa đình chỉ membership founding_seller (§6) |
| FD-R53 | Tin nhắn hội thoại cũ của seller bị đình chỉ vẫn ghi được (§6) |

Liên quan chéo: `docs/operations/incident-playbook.md` (sự cố bảo toàn bằng
chứng), `docs/operations/seller-verification-playbook.md` (đình chỉ chặn
publication), `docs/operations/concierge-onboarding-playbook.md` (kênh
out-of-band thông báo chủ thể).
