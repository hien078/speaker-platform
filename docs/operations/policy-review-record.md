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
| terms | v1 | a571f06b1a5d0db4a09c4e8a690fe0988e7098b624aff2987847f66cd7c99065 | — (chờ founder) | — | PENDING | Bản nháp do Claude soạn theo yêu cầu founder 2026-10-12 — chờ founder duyệt |
| privacy | v1 | fa2d533357b852ec375ae1a477a6c0926c7d5f49321db9039c4eb0f50e234a0d | — (chờ founder) | — | PENDING | Bản nháp do Claude soạn theo yêu cầu founder 2026-10-12 — chờ founder duyệt |
| marketplace_rules | v1 | 45caee175df919cfe9c2a913e3059307eaedf8bbfdcfefc014e45af637ae815e | — (chờ founder) | — | PENDING | Bản nháp do Claude soạn theo yêu cầu founder 2026-10-12 — chờ founder duyệt |
| seller_rules | v1 | cac2e446bb46cb94514d13f5d7b966023ae3984784c6585470e311d3f0238de3 | — (chờ founder) | — | PENDING | Bản nháp do Claude soạn theo yêu cầu founder 2026-10-12 — chờ founder duyệt |
| community_rules | v1 | 55c7092f87bae13e7568aacfed57c03f3285052abc2778c6295fe3bb99777221 | — (chờ founder) | — | PENDING | Bản nháp do Claude soạn theo yêu cầu founder 2026-10-12 — chờ founder duyệt |
| safety_guidance | v1 | ff2ff43685362f9a3d9f6fdb442491f8acf878f441f217e9cc9df7de9f594f46 | — (chờ founder) | — | PENDING | Bản nháp do Claude soạn theo yêu cầu founder 2026-10-12 — chờ founder duyệt |

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
