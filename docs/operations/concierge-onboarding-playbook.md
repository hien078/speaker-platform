# Playbook concierge onboarding — founding seller

> **Phạm vi:** quy trình vận hành tuyển và đồng hành founding seller — trách
> nhiệm concierge (spec §5.10.1), giao lời mời out-of-band, cơ chế lifecycle
> operator đi kèm. Batch 8 Task 3 (spec §9 "founding seller process ready").
>
> **Nguồn sự thật:** `src/lib/actions/founding-sellers.ts`,
> `src/lib/founding-sellers.ts`, `src/lib/founding-seller-vocab.ts`,
> `app/invite/[token]/route.ts`, `app/invite/page.tsx`,
> `app/admin/beta-cohort/page.tsx`, `app/admin/users/page.tsx` — mọi tên
> trích dẫn đã đối chiếu mã nguồn đã merge (Batches 2+7).
>
> **Không phát minh chính sách (spec §4.11):** bảng chuyển trạng thái, reason
> codes, tập manually-settable, rate values là cơ chế PROVISIONAL (FD-R48) —
> founder acknowledge/sửa trước beta.

## 1. Phân chia trách nhiệm concierge (spec §5.10.1 — verbatim)

Operations **ĐƯỢC** hỗ trợ founding seller:

- chọn model (model selection);
- các trường cấu trúc của tin đăng (structured listing fields);
- photo checklist;
- định dạng tin đăng (listing formatting);
- di chuyển thông tin tin đăng hiện có (migration of existing listing information).

Operations **KHÔNG được tự ý bịa claim của seller** (must not silently
fabricate seller claims).

Seller **giữ toàn trách nhiệm** cho: giá hỏi (asking price), tình trạng
(condition), lỗi (defects), lịch sử sửa chữa (repair history), quyền sở hữu/
quyền bán (ownership/sale authority), các claim về sản phẩm (product claims),
đồng ý đăng tải (publication consent).

Nguyên tắc vận hành: concierge gõ thay/kèm seller chỉ khi seller xác nhận từng
giá trị; KHÔNG bao giờ điền giá/defect/claim theo phán đoán của operator.

## 2. Giao lời mời out-of-band (FD-R29)

**Không có provider email/SMS production (FD-2 defer)** — nền tảng KHÔNG bao
giờ tự gửi lời mời. Đường giao là **kênh riêng của operator** (cuộc trò chuyện
tuyển dụng — Messenger/Zalo/điện thoại): operator copy invite URL (action in
ra MỘT lần) và dán vào cuộc trò chuyện đó.

Cơ chế đã ship (Batch 7):

1. Tạo ứng viên: `createCandidateAction` (console `/admin/beta-cohort`,
   capability `beta_cohort.manage` — super/ops) — kênh liên hệ
   (`email|phone`) + tham chiếu liên hệ + nguồn tuyển + cộng đồng mục tiêu
   (`targetCommunity` — MỘT mã tỉnh hợp lệ bất kỳ trong 34 đơn vị
   `src/lib/provinces.ts`, không restriction nào được invent
   `[FOUNDER DECISION — FD-R32]`) + note. Contact của CHÍNH operator → từ
   chối (`CANDIDATE_CONTACT_IS_OPERATOR`); ứng viên khác cùng contact còn
   trong funnel → `CANDIDATE_CONTACT_EXISTS` (dedup application-level —
   race có thể xảy ra, RR-26: console hiện cả hai row).
2. Cấp token: `inviteCandidateAction` — token 256-bit (43 ký tự base64url,
   `BETA_INVITE_TOKEN_RE`), DB chỉ lưu HMAC-SHA256(token, HKDF
   `"beta-invite-hash"`) (`betaInviteTokenHash` — `src/lib/hkdf.ts` derive từ
   `AUTH_SECRET`); token cũ của ứng viên bị revoke (re-invite idempotent);
   CAS candidate → `invited`; audit `founding_seller.invite_issued` cùng tx.
   **Token thô chỉ hiện MỘT lần** trong invite URL — không lưu lại đâu khác.
3. **URL cần `NEXT_PUBLIC_APP_URL`** — chưa cấu hình → `APP_URL_UNCONFIGURED`
   (không issue token khi không có URL để render).
4. Thu hồi nhầm: `revokeInviteAction` (audit
   `founding_seller.invite_revoked`).

**TTL lời mời: 14 ngày** (`FOUNDING_SELLER_INVITE_TTL_DAYS` — tunable
constant, không phải env) `[FOUNDER DECISION — FD-R46]`.

**Rate (PROVISIONAL P5 — FD-R48):** issue 20 invite/giờ/admin
(`FOUNDING_SELLER_INVITE_RATE`); landing 30 GET/10 phút/IP
(`BETA_INVITE_LANDING_RATE`); accept 10 lần/10 phút/user
(`BETA_INVITE_ACCEPT_RATE`).

## 3. Cookie flow lời mời — residual risk token trong URL (FD-R49/RR-21)

Cơ chế đã ship (đối chiếu `app/invite/[token]/route.ts` + `app/invite/page.tsx`):

1. **Landing là Route Handler** `GET /invite/[token]` (KHÔNG phải page —
   Server Component không set cookie được). Token thô xuất hiện trong URL
   đúng MỘT lần ở GET này: response set cookie **HttpOnly `sp_invite`**
   (`BETA_INVITE_COOKIE`, path `/invite`, TTL 15 phút —
   `BETA_INVITE_COOKIE_MAX_AGE_SEC`) rồi redirect **tokenless** `/invite`.
   Token rời URL ngay — không bao giờ trong `next`/query/form.
2. Landing KHÔNG side effect (bot unfurl Messenger/Zalo GET link này — không
   consume/log/audit); rate limit TRƯỚC mọi db read; shape check trước
   lookup; token không hợp lệ → redirect `/invite` không cookie — trang đó
   render thông báo chung "Lời mời không còn hiệu lực" (enumeration-safe).
   Response mang `Referrer-Policy: no-referrer` + `X-Robots-Tag: noindex`
   (belt-and-braces: `next.config.ts` set trên `/invite/:token`).
3. **Chấp nhận tại `/invite` (tokenless):** `acceptInviteAction` đọc token
   TỪ COOKIE (KHÔNG bao giờ tin formData/query). Mọi lý do token fail →
   `INVITE_INVALID` byte-identical (enumeration-safe).

**Residual risk đã ghi nhận (RR-21 — founder acknowledge, FD-R49):** token
một lần GET đó nằm trong browser history + nginx access log trước khi cookie
flow tiếp quản. Biện pháp kèm: cookie HttpOnly mang token tiếp, single-use
atomic claim (predicate đầy đủ trong tx), token 256-bit không đoán được,
`Referrer-Policy: no-referrer`.

## 4. Chấp nhận lời mời — channel binding (FD-R69)

`acceptInviteAction` (từ `/invite`, đã đăng nhập):

- **Tự mời chính mình bị từ chối** (`INVITE_SELF_ISSUED` — issuedById ===
  user.id). Admin trong founding cohort: contact của chính mình từ chối,
  tài khoản admin KHÁC được chấp nhận `[FOUNDER DECISION — FD-R70]`.
- **Channel binding:** user FRESH phải có email/phone **MATCH + ĐÃ XÁC MINH**
  (`emailVerifiedAt`/`phoneVerifiedAt`) trùng kênh lời mời — sai →
  `INVITE_CHANNEL_MISMATCH`; chưa xác minh → `INVITE_CHANNEL_UNVERIFIED`.
  Link lộ KHÔNG gắn membership vào tài khoản khác.
- Tài khoản đình chỉ → `INVITE_ACCOUNT_SUSPENDED` (không consume token).
- Membership `suspended`/`exited` hoặc `active` đã hết hạn →
  `INVITE_MEMBERSHIP_NOT_ACCEPTABLE` (token KHÔNG burn — có thể cấp membership
  hợp lệ rồi thử lại; acceptance không bao giờ tự clear `expiresAt`).
- Thành công: token consume (atomic), membership `founding_seller` upsert
  (`invited → active` CAS; đã active chỉ fill `acceptedAt`), candidate link,
  audit `founding_seller.invite_accepted` cùng tx; SAU commit: xóa cookie,
  `syncFoundingSellerFunnel`, emit `seller_registered` + (nếu activate)
  `beta_membership_activated`, notify.

**⚠️ FD-R69 (BLOCKING) — hệ quả của FD-2:** channel binding đòi kênh ĐÃ xác
minh, nhưng production OTP adapter đang fail-closed (chưa có provider) →
**không có đường tự xác minh kênh trong production**. Cho tới khi provider
land (FD-R1), đường DUY NHẤT để người được mời có kênh đã xác minh là **block
psql thủ công per-user của runbook Batch 2 §6** (`user.email_verified_manual`,
two-person rule — xem `docs/operations/account-recovery-playbook.md` §4).
Founder quyết: chờ provider, hoặc chấp nhận token possession + giao out-of-band
là bằng chứng kênh, hoặc chạy block thủ công cho từng người
`[FOUNDER DECISION — FD-R69 — BLOCKING]`.

## 5. Lifecycle founding seller — cơ chế operator đi kèm (FD-R48)

Mười trạng thái (spec §5.10 verbatim — `FOUNDING_SELLER_CANDIDATE_STATUSES`):

```text
prospect → invited → registered → verification_pending → verified
→ concierge_onboarding → first_listing → active_founding_seller
→ inactive → exited
```

**Bảng chuyển MANUAL hợp pháp** (`FOUNDING_SELLER_TRANSITIONS` — PROVISIONAL):

| from | to |
|---|---|
| `prospect` | `invited`, `exited` |
| `invited` | `registered`, `inactive`, `exited` |
| `registered` | `verification_pending`, `inactive`, `exited` |
| `verification_pending` | `verified`, `inactive`, `exited` |
| `verified` | `concierge_onboarding`, `first_listing`, `inactive`, `exited` |
| `concierge_onboarding` | `first_listing`, `inactive`, `exited` |
| `first_listing` | `active_founding_seller`, `inactive`, `exited` |
| `active_founding_seller` | `inactive`, `exited` |
| `inactive` | `exited` (DUY NHẤT — kích hoạt lại là founder policy, A5) |
| `exited` | (terminal) |

- **Tập operator tự set được** (`MANUALLY_SETTABLE_STATUSES` — PROVISIONAL):
  `concierge_onboarding`, `active_founding_seller`, `inactive`, `exited`.
  Còn lại thuộc invite flow + funnel sync — tự set bị
  `STATUS_NOT_MANUALLY_SETTABLE` (fail closed chống fake funnel).
- **Reason codes chuyển trạng thái** (`FOUNDING_SELLER_TRANSITION_REASONS` —
  PROVISIONAL): `concierge_started`, `quality_sample_passed`,
  `seller_unresponsive`, `seller_declined`, `policy_review`,
  `operator_correction`, `other_reviewed_reason` — mọi chuyển manual qua
  `updateCandidateStatusAction` (audit `founding_seller.status_changed`).
- **Funnel sync** (`syncCandidateFunnelAction` — operator bấm; và tự chạy sau
  acceptance): đọc GROUND TRUTH (`SellerVerification` + Listing `approved`),
  CHỈ TIẾN, nhảy thẳng tới trạng thái furthest, EXEMPT bảng manual (thứ tự
  monotonic riêng). Audit `founding_seller.funnel_synced` khi có thay đổi.
- **Mời lại:** chỉ `prospect`/`invited` (`inviteCandidateAction` — khác →
  `INVALID_STATE`); re-entry từ `inactive` là founder policy (A5).
- Các action console còn lại: `assignCandidateOperatorAction`
  (`founding_seller.operator_assigned`), `recordCandidateContactAction`
  (`founding_seller.contact_recorded` — cập nhật `lastContactAt`),
  `updateCandidateNotesAction` (`founding_seller.notes_updated`; note ≤ 4000,
  source ≤ 200 ký tự — caps PROVISIONAL FD-R48), `updateCandidateStatusAction`,
  và set `qualityListingCount` (audit `founding_seller.quality_count_set` —
  ops input thủ công, hệ thống KHÔNG auto-compute "quality" — FD-R23).

## 6. Console + nguồn contact (FD-R2)

- **Console:** `/admin/beta-cohort` (capability `beta_cohort.manage` —
  super_admin + operations_admin; moderator/support/analyst fail closed).
  Hiển thị: tổng số ứng viên, invited/registered/verification state/
  first-listing state, quality listing count, hoạt động bán cuối
  (Listing `updatedAt`), badge "cần hỗ trợ", operator gán, notes — và
  **supply-readiness view** (`buildSupplyReadinessView` — xem
  `docs/operations/founding-seller-onboarding-checklist.md`).
- **Contact MASK trong console** (`maskContact` — `src/lib/founding-seller-vocab.ts`):
  email `l***@domain`, phone `09*****67` fixed-width — KHÔNG bao giờ giá trị
  đầy đủ, KHÔNG có action mở mask (ô Scoped `pii.view_sensitive` chưa được
  founder định nghĩa — fail closed). **Nguồn contact đầy đủ là kênh riêng của
  operator** (cuộc trò chuyện tuyển dụng — nơi họ lấy contact ban đầu)
  `[FOUNDER DECISION — FD-R2]`.
- **Badge "seller cần hỗ trợ"** (D2): ứng viên active-funnel với
  `lastContactAt` null hoặc cũ hơn 7 ngày
  (`FOUNDING_SELLER_ASSISTANCE_AFTER_DAYS`) — ops heuristic, KHÔNG phải SLA
  `[FOUNDER DECISION — FD-R47]`.
- **Membership buyer** (`private_beta_buyer`) KHÔNG qua invite — cấp trên
  `/admin/users` qua form `setBetaMembershipAction` (self-grant
  `SELF_GRANT_FORBIDDEN`); tra cứu user exact: `/admin/users?u=<id>`; link
  ngược từ console: `/admin/beta-cohort?userId=<id>`.
- **Số liệu console là live counts; `invitedFoundingSellers` là ever-invited
  monotonic** (ứng viên exited vẫn tính) `[FOUNDER DECISION — FD-R73]`.

## 7. Founder Decision Items (playbook này mang)

| Mục | Ghi chú |
|---|---|
| FD-R29 | Kênh giao lời mời out-of-band (§2) — BLOCKING (FD-2) |
| FD-R32 | Ngữ nghĩa `targetCommunity` (§2) |
| FD-R46 | TTL invite 14 ngày (§2) |
| FD-R47 | Ngưỡng badge "cần hỗ trợ" 7 ngày (§6) |
| FD-R48 | Bộ PROVISIONAL: bảng chuyển, reason codes, manually-settable, rate values, caps (§5) — BLOCKING (founder-authored/acknowledgment per FD-3) |
| FD-R49 | Acknowledge residual risk token trong URL (§3) |
| FD-R69 | Channel binding vs FD-2 — đường production cho kênh đã xác minh (§4) — BLOCKING |
| FD-R70 | Admin trong founding cohort: tự mời bị từ chối, admin khác được (§4) |
| FD-R73 | `invitedFoundingSellers` ever-invited monotonic (§6) |

Liên quan chéo: `docs/operations/founding-seller-onboarding-checklist.md`
(checklist theo giai đoạn + supply readiness), `docs/operations/seller-verification-playbook.md`
(verification sau đăng ký), `docs/operations/account-recovery-playbook.md`
(đường manual kênh đã xác minh), `docs/operations/moderation-playbook.md`.
