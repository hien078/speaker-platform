# Checklist onboarding founding seller + supply readiness (§12.1)

> **Phạm vi:** checklist vận hành theo từng giai đoạn lifecycle founding
> seller (spec §5.10) + cổng supply readiness trước khi mời rộng buyer (spec
> §12.1). Batch 8 Task 3 (spec §9 "founding seller process ready", §12.1
> "supply readiness approved").
>
> **Mục tiêu là MỤC TIÊU VẬN HÀNH, không phải code gate** (spec §2.7): hệ
> thống không chặn theo các con số dưới đây — chúng là đích đo lường cho
> founder phê duyệt mở rộng.
>
> **Nguồn sự thật:** `src/lib/founding-seller-vocab.ts`,
> `src/lib/actions/founding-sellers.ts`, `src/lib/founding-sellers.ts`,
  `src/components/founding-seller-console.tsx` (supply-readiness view Batch 7),
`src/lib/seller-verification-policy.ts`. Cơ chế chi tiết: xem
`docs/operations/concierge-onboarding-playbook.md`.

## 1. Mục tiêu vận hành private beta (spec §2.7 — targets, not gates)

| Chỉ số | Mục tiêu spec |
|---|---|
| Founding seller được mời | **20–50** |
| Buyer / người tham gia beta ban đầu | **100–200** |
| Tin đăng thật chất lượng cao | **100–300** |

Các con số này là đích tuyển của concierge, KHÔNG phải điều kiện phần mềm.
"Quality listing" là **định nghĩa ops-set** (đếm thủ công qua
`qualityListingCount` — hệ thống không auto-compute)
`[FOUNDER DECISION — FD-R23 — BLOCKING: gates §12.1 "100–300 quality
listings"]`.

## 2. Checklist theo giai đoạn lifecycle (spec §5.10)

Mười trạng thái (`FOUNDING_SELLER_CANDIDATE_STATUSES` — verbatim). Mỗi hàng:
chủ sở hữu / hành động trên console `/admin/beta-cohort` / bằng chứng ghi
lại. Bằng chứng mặc định là audit `AuditEvent` + row console (live counts).

| # | Giai đoạn | Chủ | Hành động | Bằng chứng |
|---|---|---|---|---|
| 1 | `prospect` | Concierge (super/ops) | `createCandidateAction` — contact + nguồn + `targetCommunity` (mã 34 tỉnh) | audit `founding_seller.candidate_created`; row console |
| 2 | `invited` | Concierge | `inviteCandidateAction` — token 14 ngày (FD-R46), URL giao out-of-band (FD-R29) | audit `founding_seller.invite_issued`; token row (chỉ hash) |
| 3 | `registered` | Người được mời | Đăng ký + xác minh kênh (FD-R69: đường production = runbook §6 thủ công cho tới FD-R1) → mở lại link mời → `acceptInviteAction` tại `/invite` | audit `founding_seller.invite_accepted`; membership `founding_seller` active |
| 4 | `verification_pending` | Seller + Operations | Seller: khai báo (`declareSellerProfileAction`) + gửi hồ sơ (`submitSellerVerificationAction` — kèm chấp nhận Seller Rules v1); Operations: review theo checklist §5.3.3 | audit `seller_verification.submitted`/`reviewed`; row `SellerVerification` |
| 5 | `verified` | Operations | `reviewSellerVerificationAction` → `verified` (step-up + reason code) — xem `docs/operations/seller-verification-playbook.md` | audit `seller_verification.reviewed`; funnel sync tự tiến |
| 6 | `concierge_onboarding` | Concierge | `updateCandidateStatusAction` → `concierge_onboarding` (reason `concierge_started`) — đồng hành §5.10.1 (KHÔNG bịa claim) | audit `founding_seller.status_changed`; note console |
| 7 | `first_listing` | Seller (+ Concierge hỗ trợ) | Đăng tin đầu tiên qua `/sell` (photo checklist §5.6.3, giá/defect do seller), submit → duyệt | Listing `approved`; funnel sync tự tiến + `firstListingAt` |
| 8 | `active_founding_seller` | Concierge | Sau khi mẫu listing đạt chuẩn (manual sampling §12.1): `updateCandidateStatusAction` (reason `quality_sample_passed`) | audit `founding_seller.status_changed`; `qualityListingCount` ≥ 3 (funnel §12.3) |
| 9 | `inactive` | Concierge | Seller không phản hồi (`seller_unresponsive`) / từ chối (`seller_declined`) | audit; badge "cần hỗ trợ" tắt theo trạng thái |
| 10 | `exited` | Concierge | `policy_review` / tiếp tục từ `inactive` (DUY NHẤT đường `inactive → exited`) | audit; terminal |

Ghi chú cơ chế: funnel sync (`syncCandidateFunnelAction`) tự tiến các trạng
thái ground-truth (3→5→7) — operator KHÔNG tự set chúng
(`STATUS_NOT_MANUALLY_SETTABLE`); kích hoạt lại từ `inactive` là founder
policy (A5). "Seller cần hỗ trợ" = active-funnel + `lastContactAt` null/cũ
hơn 7 ngày (FD-R47 — heuristic, không SLA).

## 3. Supply readiness gate (spec §12.1 — trước khi mời rộng buyer)

**`CODE READY ≠ MARKET READY`** — readiness kỹ thuật KHÔNG tự động cho phép
mời rộng buyer. Mỗi mục dưới đây cần **ký duyệt (sign-off) có ngày** của
founder trước khi mở rộng; mục nào chưa đạt thì founder ghi rõ "explicitly
approved" (chấp nhận mở rộng với mức hiện tại) — chính sách chấp thuận là
của founder `[FOUNDER DECISION — FD-R30 — BLOCKING: cổng mời buyer]`.

| # | Mục §12.1 | Bằng chứng kiểm tra | Đạt? | Người duyệt | Ngày |
|---|---|---|---|---|---|
| 1 | Founding seller workflow vận hành | Playbooks 3 + checklist §2 đã đi hết ít nhất 1 ứng viên thật; console `/admin/beta-cohort` live | ☐ | | |
| 2 | Số verified founding seller đạt mục tiêu HOẶC được phê duyệt rõ ràng | Console: đếm membership `founding_seller` active + `SellerVerification.verified`; so mục tiêu 20–50 (§1) | ☐ | | |
| 3 | Mục tiêu tồn kho đạt HOẶC được phê duyệt rõ ràng | Console: `firstListingAt`/`active_founding_seller` counts; Listing `approved` trong `portable_bluetooth_speaker` | ☐ | | |
| 4 | Hỗ trợ được ~100–300 listing chất lượng | `qualityListingCount` tổng (ops-set) + mẫu thủ công mục 6 | ☐ | | |
| 5 | Core model coverage được review thủ công | `docs/operations/model-seed-review-procedure.md` đã chạy sitting founder; `/admin/catalog` approved coverage | ☐ | | |
| 6 | Chất lượng listing được lấy mẫu thủ công | Mẫu thủ công theo FD-R23 (định nghĩa quality ops-set); kết quả ghi note console | ☐ | | |
| 7 | Seller response monitoring hoạt động | Dashboard `/admin` (Batch 5): `seller_response_rate_v1` render (hoặc pending state FD-R20); `conversation_buyer_first_message` events chảy | ☐ | | |
| 8 | Năng lực moderation/support tồn tại | Playbook moderation đã đọc + phân vai (ai on-call); hàng đợi `/admin/moderation` có người xử lý | ☐ | | |

**Cách đọc số từ console (Batch 7 supply-readiness view):**
`buildSupplyReadinessView` (`src/components/founding-seller-console.tsx`)
render sẵn các cột §5.10 (tổng ứng viên, invited — ever-invited monotonic
FD-R73, registered, verification state, first-listing state, quality count,
last activity, needs-assistance, operator, notes). `?userId=` chỉ thu hẹp
bảng — summary/readiness luôn tính từ cohort đầy.

**Mời buyer (sau cổng):** buyer KHÔNG qua invite flow — cấp
`private_beta_buyer` trên `/admin/users` (`setBetaMembershipAction`) bởi
operations; cổng chat buyer = `BETA_CHAT_REQUIRES_ACTIVE_MEMBERSHIP` +
`BETA_CHAT_ALLOWED_COHORTS` (`src/lib/beta-access.ts` — FD-R33 founder
acknowledge).

## 4. Founder Decision Items (checklist này mang)

| Mục | Ghi chú |
|---|---|
| FD-R23 | Định nghĩa "quality listing" (ops-set count) — gates hàng "100–300 quality listings" — BLOCKING |
| FD-R30 | Phê duyệt mời rộng buyer cohort (§3) — BLOCKING (chính là cổng) |
| FD-R33 | Buyer gate mặc định BẬT — acknowledge (§3) — BLOCKING |
| FD-R73 | `invitedFoundingSellers` ever-invited monotonic (§3) |
| FD-R20 | Giá trị window các rate dashboard (§3 hàng 7) — BLOCKING (bốn rate values) |

Liên quan chéo: `docs/operations/concierge-onboarding-playbook.md` (cơ chế),
`docs/operations/model-seed-review-procedure.md` (mục 5),
`docs/operations/moderation-playbook.md` (mục 8).
