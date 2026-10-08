# Playbook xác minh người bán (seller verification) — private beta

> **Phạm vi:** cách operations review hồ sơ xác minh người bán — checklist,
> quyết định, thu hồi, và truy vấn đối soát phone trùng lặp (RR-3). Batch 8
> Task 3 (spec §9 "seller verification operational", §12 "seller verification
> works").
>
> **Định vị (spec §5.3.3):** seller verification là **platform-access trust
> control** — KHÔNG phải bảo đảm người bán, sản phẩm hay giao dịch. Copy công
> khai dùng đúng câu §6.2 (§6 dưới đây).
>
> **Nguồn sự thật:** `src/lib/actions/seller-verification.ts`,
> `src/lib/seller-verification-policy.ts`, `src/lib/rbac.ts`,
> `src/lib/audit-event.ts` — mọi tên trích dẫn đã đối chiếu mã nguồn đã merge.
>
> **Không phát minh chính sách (spec §4.11):** yêu cầu proofing ngoài checklist
> §5.3.3, ngữ nghĩa `needs_review`, map quyết định×lý do là PROVISIONAL/
> founder `[FOUNDER DECISION — FD-R3/R62]`.

## 1. Luồng hồ sơ (cơ chế đã ship)

1. Seller khai báo: `declareSellerProfileAction` (`src/lib/actions/seller-verification.ts`)
   — seller type (`individual|business`), khu vực hoạt động (mã 34 đơn vị —
   `src/lib/provinces.ts`, FD-1). Đổi khai báo khi đã `verified` → row tự
   chuyển `needs_review` (CAS) + audit `seller_verification.declaration_changed`
   cùng tx — seller phải xin review lại.
2. Seller gửi hồ sơ: `submitSellerVerificationAction` — ghi nhận đồng ý
   Seller Rules (`PolicyAcceptance(seller_rules, v1)` —
   `SELLER_RULES_POLICY_KEY`/`SELLER_RULES_POLICY_VERSION`), tạo/chuyển row
   `SellerVerification` → `pending` (CAS khi gửi lại từ
   `rejected`/`needs_review`/`revoked`), audit `seller_verification.submitted`
   cùng tx. Submit chặn trước nếu thiếu yêu cầu (trừ ops review + rules) hoặc
   tài khoản đang đình chỉ (thông báo riêng).
3. **Operations review:** `reviewSellerVerificationAction` — xem §2–§4.

Trạng thái workflow (`SellerVerificationStatus`): `not_started`, `pending`,
`verified`, `rejected`, `needs_review`, `revoked`.

## 2. Checklist review operations (spec §5.3.3 — verbatim)

Review MỌI hồ sơ kiểm tra tối thiểu (dịch từ spec §5.3.3 "Operations review
checks at minimum"):

1. dấu hiệu tài khoản trùng lặp rõ ràng (obvious duplicate-account indicators);
2. đình chỉ hiện hành (current suspension);
3. cấm hiện hành (current ban);
4. từng bị thu hồi xác minh người bán trước đây (prior seller-verification revocation);
5. mẫu tạo tài khoản bất thường (abnormal account-creation pattern);
6. quan hệ phone/tài khảnan đáng ngờ (suspicious phone/account relationships);
7. khai báo người bán không nhất quán (inconsistent seller declaration);
8. báo cáo lạm dụng nghiêm trọng chưa giải quyết (unresolved serious abuse reports);
9. hành vi listing đáng ngờ đã hiển thị (suspicious listing behavior already visible);
10. tuyên bố doanh nghiệp cần bằng chứng bổ sung (business claims that require additional review).

Công cụ đối soát cho mục (1)/(6): truy vấn phone trùng lặp §5 (RR-3) + case
kiểm duyệt đang active nhắm user (`/admin/moderation`, capability
`report.resolve`).

## 3. Quyết định — step-up, claim atomic, reason code

**Quyền + step-up:** `reviewSellerVerificationAction` đòi capability THEO
QUYẾT ĐỊNH (Ambiguity A5): `verified`/`needs_review`/`rejected` →
`seller.verify`; `revoked` → `seller.verification.revoke` (cả hai capability:
super_admin + operations_admin theo `ROLE_CAPABILITIES`; moderator/support/
analyst fail closed) **+ step-up MFA** — `seller.verify` và
`seller.verification.revoke` đều nằm trong `STEP_UP_CAPABILITIES`
(`src/lib/rbac.ts`): mọi quyết định verification thủ công đòi xác thực lại
trong 15 phút (`STEP_UP_MAX_AGE_MINUTES`) hoặc mã TOTP trong request. Đây là
cách đọc NGHIÊM NHẤT của §5.4.2 "where configured" — founder có thể nới bằng
cách bỏ khỏi danh sách `[FOUNDER DECISION — FD-R5]`.

**Tự duyệt chính mình bị từ chối** (`SELF_REVIEW_FORBIDDEN`, không mutation —
một admin tự xác minh mình là đường leo thang đặc quyền; ghi nhận FD-R61).

**Claim atomic (chống double-review đồng thời):** MỘT `updateAll` có điều
kiện status đọc TRONG tx — `verified`/`rejected` ← status IN
(`pending`,`needs_review`); `needs_review` ← `pending`; `revoked` ←
`verified`. 0 row (reviewer khác đã quyết giữa chừng) →
`Error("VERIFICATION_ALREADY_REVIEWED")` throw ra khỏi callback → tx rollback
(KHÔNG bao giờ ghi đè quyết định trước). Violation constraint LUÔN throw ra
khỏi callback — phân loại NGOÀI tx (quy tắc Global Constraints).

**Bốn quyết định** (`SELLER_VERIFICATION_DECISIONS` — spec §5.3.3):
`verified` | `needs_review` | `rejected` | `revoked`.

**Mỗi quyết định ghi (spec §5.3.3):** reviewer (`actorId`), timestamp
(`reviewedAt`), policy version (`SELLER_VERIFICATION_POLICY_VERSION` =
`v1`), **typed reason code**, note nội bộ tuỳ chọn (qua `redactDetail`).
Audit `seller_verification.reviewed` trong cùng tx.

**Reason codes** (`SELLER_VERIFICATION_REASON_CODES` — typed, không free
text): `requirements_met`, `duplicate_account_risk`, `active_suspension`,
`prior_verification_revoked`, `identity_information_inconsistent`,
`business_claim_needs_evidence`, `abuse_case_unresolved`, `manual_risk_review`,
`other_reviewed_reason`, `migrated_legacy_verified` (CHỈ backfill script
Batch 2 — reviewer không dùng).

**Map quyết định × reason code** (`SELLER_VERIFICATION_DECISION_REASON_CODES`)
là PROVISIONAL (review fix L2 — chặn cặp vô nghĩa như `verified` +
`duplicate_account_risk`): founder phê chuẩn hoặc sửa
`[FOUNDER DECISION — FD-R62 — BLOCKING]`. Ngữ nghĩa `needs_review` (hồ sơ cần
bổ sung/soi thêm — KHÔNG phải "đang xem xét") cùng ngồi quyết định này.

## 4. Thu hồi (revocation)

- Quyết định `revoked` ghi cùng cơ chế §3 nhưng qua capability
  **`seller.verification.revoke`** (khác `seller.verify` — cùng step-up);
  claim atomic từ status `verified`.
- Hiệu lực NGAY (đọc FRESH mỗi lần gọi, không cache): publication gate
  `checkSellerPublicationRequirements` thêm thiếu
  `operations_review_verified`; seller-side perimeter
  `assertListingSellerInteractable` (`src/lib/deal.ts`) chặn hội thoại MỚI/
  Deal MỘT với `SELLER_NOT_VERIFIED` — kể cả admin duyệt listing cũng đi qua
  cùng gate (defense-in-depth §7.3).
- Listing đã công khai của seller bị thu hồi KHÔNG tự unpublish (perimeter
  là NEW interaction) — takedown là quyết định moderation riêng
  (`docs/operations/moderation-playbook.md` §3).
- Tin nhắn hội thoại ĐÃ TỒN TẠI vẫn ghi được (FD-R53 — xem moderation playbook §6).

## 5. RR-3 — truy vấn đối soát phone đã xác minh trùng lặp

**Bối cảnh (RR-3):** không có partial unique index trên phone đã xác minh —
hai tài khoản có thể race tx re-check lúc verify (`confirmPhoneVerificationAction`
re-check trong tx). Biện pháp bù: **ops chạy định kỳ truy vấn đối soát dưới
đây** — theo yêu cầu và **TRƯỚC khi cấp membership `founding_seller`** cho
seller mới (đường cấp: `/admin/users` → `setBetaMembershipAction`, xem
concierge playbook).

Truy vấn READ-ONLY, trả về **số lượng và id nội bộ — KHÔNG BAO GIỜ giá trị
phone** (spec §4.8 — cùng kỷ luật PII như `AuditEvent.detail`):

```bash
# Production (container db không publish port — docs/backup-restore.md):
docker exec loaviet-db psql -U loaviet -d loaviet -tAc \
  'SELECT count(*) AS dup_groups, coalesce(sum(n),0) AS accounts FROM (SELECT count(*) n FROM "User" WHERE "phoneVerifiedAt" IS NOT NULL AND phone IS NOT NULL GROUP BY phone HAVING count(*) > 1) d;'
# → 1 dòng "0|0" khi sạch: 0 nhóm trùng, 0 tài khoản.

# Drill-down id nội bộ (chỉ khi dòng trên ≠ 0|0):
docker exec loaviet-db psql -U loaviet -d loaviet -tAc \
  'SELECT array_agg(id) FROM "User" WHERE "phoneVerifiedAt" IS NOT NULL GROUP BY phone HAVING count(*) > 1;'
# → các id nội bộ (uuid) của nhóm trùng — operator đối chiếu qua /admin/users?u=<id>.

# Dev (DB dev 5435): psql "$DATABASE_URL" -tAc "<cùng hai câu SQL>"
```

**Xử lý khi có trùng lặp:** đây là tín hiệu race RR-3 đã xảy ra — KHÔNG tự
động gộp tài khoản (spec §5.3.1: merging loại khỏi P0). Điều tra thủ công:
xác định tài khoản nào là thật (qua kênh out-of-band với người dùng), ghi
case kiểm duyệt, xử lý theo chính sách founder
`[FOUNDER DECISION — FD-R60 liên quan: uniqueness pre-check match cả row
unverified]`. Ghi nhận kết quả vào security review (Task 8 chạy lại truy
vấn này trên dev DB).

Lưu ý dữ liệu: `User.phone` KHÔNG unique trong contract (chỉ `email` là
`@unique`) — trùng lặp phone giữa các tài khoản chưa xác minh là hợp lệ về
schema; truy vấn trên CHỈ đếm phone ĐÃ xác minh (`phoneVerifiedAt IS NOT NULL`).

## 6. Copy công khai (spec §6.2)

Cho phép (dạng trung tính duy nhất):

> Đã xác minh thông tin người bán theo yêu cầu hiện tại của LoaViet.

Tránh: "Người bán được LoaViet bảo đảm" / "Sản phẩm được LoaViet đảm bảo an
toàn" / "Giao dịch được bảo vệ bởi LoaViet" — và mọi biến thể bảo đảm/
chứng nhận (spec §4.2; guard thường trực: `tests/unit/copy-safety.test.ts`).
Copy thông báo quyết định (`DECISION_NOTIFY` trong
`src/lib/actions/seller-verification.ts`) đã theo dạng trung tính.

## 7. Không thu thập giấy tờ tùy thân (spec §5.3.2)

KHÔNG thu thập identity documents "just in case". Bất kỳ việc thu thập nào
trong tương lai là **quyết định legal/ops riêng, được review riêng** (spec
§5.3.2): evidence phải private, access-controlled, access-audited, mã hóa/
object-storage riêng, kèm lịch retention tài liệu. Không có surface nào
trong P0 nhận giấy tờ — operator KHÔNG yêu cầu người dùng gửi ảnh giấy tờ qua
bất kỳ kênh nào `[FOUNDER DECISION — mở rộng tương lai qua review riêng]`.

## 8. Founder Decision Items (playbook này mang)

| Mục | Ghi chú |
|---|---|
| FD-R3 | Proofing out-of-band cho khôi phục thủ công (liên quan account-recovery playbook) |
| FD-R5 | Step-up trên MỌI quyết định verification (§3) — có thể nới |
| FD-R60 | Pre-check uniqueness match cả row unverified (§5) |
| FD-R61 | Các mặc định FD-3 của Batch 2: `SELF_REVIEW_FORBIDDEN` (§3), display-role restore mapping, taxonomy `ADMIN_ROLE_REASON_CODES` |
| FD-R62 | Map quyết định × reason code + ngữ nghĩa `needs_review` (§3) — BLOCKING |
| FD-R34/FD-R4 | Nội dung + version Seller Rules là founder (cơ chế ở `docs/operations/policy-review-record.md`) |

Liên quan chéo: `docs/operations/moderation-playbook.md` (đình chỉ chặn
publication), `docs/operations/concierge-onboarding-playbook.md` (cấp
`founding_seller` sau khi review sạch §5), `docs/operations/account-recovery-playbook.md`
(đường manual đánh dấu kênh đã xác minh).
