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
| terms | v1 | b8b16950e4cb209350244bbeed9d617e22e7b7d7a63a9f99f5b87d97d142232a | — (chờ founder) | — | PENDING | Placeholder DRAFT-NOT-REVIEWED (FD-3) |
| privacy | v1 | 195d6ac7b14d3350ccf076444b6527fa3edf75b9492db90bd93d2799436f963b | — (chờ founder) | — | PENDING | Placeholder DRAFT-NOT-REVIEWED (FD-3) |
| marketplace_rules | v1 | d023f8cca085e1fdd0e9e708e94f85a5642fad158089bf4f6fa1f2d17b479efd | — (chờ founder) | — | PENDING | Placeholder DRAFT-NOT-REVIEWED (FD-3) |
| seller_rules | v1 | 5c3e784d11caa9909a17c172a9c976c886a17894a5d422345a93064ea09c8691 | — (chờ founder) | — | PENDING | Placeholder DRAFT-NOT-REVIEWED (FD-3) — xem FD-R4 |
| community_rules | v1 | 0570418e45d1aa5c4d26dca10307b9dc250da1dbd0adf5f65b5659910b927c24 | — (chờ founder) | — | PENDING | Placeholder DRAFT-NOT-REVIEWED (FD-3) |
| safety_guidance | v1 | bf0b4e905853a6a09d53884b3d47de83638e5a9d2a5621ce3ceb113b2aa1b6b8 | — (chờ founder) | — | PENDING | Placeholder DRAFT-NOT-REVIEWED (FD-3) — 6 điểm §6.4 + dòng §5.2 (spec-sourced) |

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
