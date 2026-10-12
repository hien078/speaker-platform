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
| terms | v1 | 87ec10049e20e87831d6443b35b3f50ada8db440417c5330abd401dc27fcf062 | — (chờ founder) | — | PENDING | Bản nháp do Claude soạn theo yêu cầu founder 2026-10-12 — chờ founder duyệt |
| privacy | v1 | 305abfefe737120cb2325ea7058482f97f1c6e3cea257826b225281af3aae764 | — (chờ founder) | — | PENDING | Bản nháp do Claude soạn theo yêu cầu founder 2026-10-12 — chờ founder duyệt |
| marketplace_rules | v1 | c9e62a1f10eef1d72994b0c58362e8b56e865c9041e57370e9caf4ff5a7db878 | — (chờ founder) | — | PENDING | Bản nháp do Claude soạn theo yêu cầu founder 2026-10-12 — chờ founder duyệt |
| seller_rules | v1 | 28445ebefab214c74d634de8adfb491dea46840be419f522bd6632efe6608ce3 | — (chờ founder) | — | PENDING | Bản nháp do Claude soạn theo yêu cầu founder 2026-10-12 — chờ founder duyệt |
| community_rules | v1 | f34afe6452bd422904534c48d052bc26db22ea40c7ff6db1233771071deb8b6b | — (chờ founder) | — | PENDING | Bản nháp do Claude soạn theo yêu cầu founder 2026-10-12 — chờ founder duyệt |
| safety_guidance | v1 | 78ebb1cf5b28e47f90588d123a1d80ad072e908998c1343d9936465e6d88e209 | — (chờ founder) | — | PENDING | Bản nháp do Claude soạn theo yêu cầu founder 2026-10-12 — chờ founder duyệt |

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
