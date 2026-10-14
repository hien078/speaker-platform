# Policy review record — ghi duyệt nội dung chính sách (Batch 8 Task 1)

> Cơ chế (spec §3.1 legal/policy readiness + §4.11 Policy Non-Invention,
> FD-3): sáu chính sách (Terms, Privacy, Marketplace Rules, Seller Rules,
> Community Rules, Safety Guidance) publish qua registry
> `src/lib/policy-registry.ts` (key + version + **status** + content-hash).
> **Toàn bộ văn bản pháp lý do FOUNDER soạn và duyệt** — implementer không
> soạn nội dung (spec §4.11). Hash sha256 chỉ phủ `POLICY_TEXT`
> (`src/content/policies/<key>.ts`); status/version sống trong registry —
> flip status không phá hash đã ghi, đổi nội dung thì hash luôn đổi.
>
> **Release gate (Batch 8 Task 9) chặn release khi còn policy chưa duyệt**:
> `scripts/release-gate.sh` chạy `npx tsx scripts/policy-hash.ts --check`
> (in `<key> <version> <sha256> <status>`), so hash với row dưới đây, yêu cầu
> **Decision == APPROVED** + hash khớp + registry status `REVIEWED`. Ô
> Decision khác `APPROVED` (kể cả `PENDING`, `REJECTED`, ô trống) không qua
> gate. Đổi nội dung mà không có row duyệt mới → gate fail.

## Bảng ghi duyệt

| Policy | Version | sha256 (scripts/policy-hash.ts) | Reviewer | Reviewed at | Decision | Notes |
|---|---|---|---|---|---|---|
| terms | v1 | 7bf688726ee2e7f740184cd515dd6dc93b9eb82944e6c551915e9cc5c6da0315 | Hoàng Ngọc Hiện | 2026-10-14 | APPROVED | Founder duyệt 2026-10-14 (chat) |
| privacy | v1 | dbf2a923015a384c1d7040966c181a4e3dabca3bc9f6e30f2b8ddb0b2d3a5637 | Hoàng Ngọc Hiện | 2026-10-14 | APPROVED | Founder duyệt 2026-10-14 (chat) |
| marketplace_rules | v1 | 094354e8b344400ddcd9ff96b5082034b6a71e669794365d5584093fe34bbc4a | Hoàng Ngọc Hiện | 2026-10-14 | APPROVED | Founder duyệt 2026-10-14 (chat) |
| seller_rules | v1 | cac2e446bb46cb94514d13f5d7b966023ae3984784c6585470e311d3f0238de3 | — (chờ founder) | — | PENDING | Bản nháp do Claude soạn theo yêu cầu founder 2026-10-12 — chờ founder duyệt (history v1 — FD-R4 bump v1→v2 ngày 2026-10-14) |
| seller_rules | v2 | 71eb7a13883cb3c4ef1d4e9249d84cf14cc6564cca9b64ad476ddfae57d44e70 | Hoàng Ngọc Hiện | 2026-10-14 | APPROVED | Founder duyệt 2026-10-14 (chat) |
| community_rules | v1 | be19878b17bbd6685ac90c0766047de5e1fb0db46525fb0226c9215e00f13a54 | Hoàng Ngọc Hiện | 2026-10-14 | APPROVED | Founder duyệt 2026-10-14 (chat) |
| safety_guidance | v1 | 5740ccbaa4f639a53438370d95299c108c004c0dab89f570f8cc7ecc74ebb87c | Hoàng Ngọc Hiện | 2026-10-14 | APPROVED | Founder duyệt 2026-10-14 (chat) |

**Decision là đúng một trong** `APPROVED` / `REJECTED` / `PENDING` — release
gate yêu cầu `APPROVED` (ô không trống là chưa đủ).

## Quy trình duyệt (founder)

1. Founder review nội dung content module của policy
   (`src/content/policies/<key>.ts`) — thay văn bản placeholder bằng văn bản
   founder soạn.
2. Chạy `npx tsx scripts/policy-hash.ts` — in `<key> <version> <sha256>` mỗi
   policy.
3. Ghi vào bảng trên: Reviewer (tên founder), Reviewed at (ngày),
   Version, sha256, **Decision** (`APPROVED`).
4. Flip `status` sang `"REVIEWED"` **trong registry**
   (`POLICIES[key].status` trong `src/lib/policy-registry.ts` — KHÔNG trong
   content module được hash) **trong cùng commit** với row duyệt mới.
5. Version bump = row mới + đổi `version` + re-acceptance qua cơ chế Batch 2
   (`PolicyAcceptance` ghi theo version mới — không xây surface chấp nhận mới).

## Seller Rules — version tension (FD-R4)

Batch 2 ghi `PolicyAcceptance(seller_rules, v1)` chống **chính placeholder
này**. Bản Seller Rules duyệt **đầu tiên** phải bump version `v1` → `v2`
(`SELLER_RULES_POLICY_VERSION` trong `src/lib/seller-verification-policy.ts`
— ngoại lệ read-only duy nhất của G4, **trong commit duyệt của founder**),
kèm update test publication-gate/acceptance trong cùng commit;
`POLICIES.seller_rules.version` theo (test alignment ghim chúng lại). Các
acceptance v1 pre-launch chỉ tồn tại trong dev/test — release gate chặn
launch khi policy chưa duyệt nên không seller thật nào chấp nhận văn bản
placeholder.

## Trường founder-only

**Implementer/agent KHÔNG được điền ô Reviewer/Decision** — những trường đó
là founder-only (spec §4.11). Một commit của implementer tự ghi "APPROVED"
là vi phạm hợp đồng — release gate đối chiếu hash + status trong registry,
mọi flip status phải đi kèm row duyệt có chữ ký founder trong cùng commit.
