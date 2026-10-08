# Quy trình review model seed + alias (founder) — private beta

> **Phạm vi:** cách founder cung cấp + duyệt danh sách model chuẩn hóa
> (canonical models) và alias tìm kiếm cho beta — NGUYÊN TẮC: **người thực
> thi KHÔNG BAO GIỜ tự viết danh sách model/alias** (FD-16/FD-R24 — spec
> §4.11 non-invention). Batch 8 Task 3 (spec §9 "founding seller process
> ready" + §12.1 "core model coverage is manually reviewed").
>
> **Nguồn sự thật:** `scripts/seed-beta-catalog.ts`,
> `scripts/seed-search-aliases.ts`, `src/lib/beta-categories.ts`,
> `app/admin/catalog/page.tsx`, `src/lib/actions/catalog.ts` — mọi lệnh/tên
> trích dẫn đã đối chiếu mã nguồn đã merge.

## 1. Vị trí review: `/admin/catalog`

Trang admin `/admin/catalog` (`app/admin/catalog/page.tsx`) — guard
`requireCapability("listing.moderate")` (super_admin + operations_admin +
moderator theo `ROLE_CAPABILITIES`; support/analyst fail closed). Hiển thị
model theo status (`approved` / `pending` / `merged`), brand, category, số
specs. Hành động trên trang:

- **Duyệt model `pending`** → `approveModelAction` (CAS `pending → approved`;
  audit `model.approved` trong cùng tx — Batch 4 b4-holistic round-3).
- **Gộp model trùng** → `mergeModelAction` (claim + chuyển listing/price
  history + resync brandId; audit `model.merged` cùng tx).
- **Tạo model mới** → `createModelAction` (từ form admin).

Model seed với status `pending` là kết quả của seed script (§2) — founder
duyệt từng model tại đây. **Đây là sitting review của founder** (không phải
của moderator): việc duyệt model vào catalog chuẩn hóa là quyết định nội
dung mà FD-R16 gán cho founder.

## 2. Seed model từ danh sách founder (FD-R16)

**Founder cung cấp file JSON** (`--models <founder.json>`): các mục
`{ "brand": "…", "name": "…", "releaseYear": 2023 }` (brand/name ≤ 100 ký tự
sau trim; releaseYear Int 1990..năm hiện tại + 1; file ≤ 1MB, ≤ 500 mục).
Script validate FAIL CLOSED trước khi chạm DB; mọi lỗi chỉ mang index mục +
tên khóa/slug — không echo giá trị thô.

```bash
# Dev (DB dev 5435 — DATABASE_URL từ env thật, KHÔNG từ .env ngầm định):
DATABASE_URL=… npx tsx scripts/seed-beta-catalog.ts --apply --models founder.json

# Production (host không có Node; qua image migrate trên compose network —
# pattern runbook §0 docs/operations/admin-bootstrap-recovery-runbook.md):
docker compose -f docker-compose.prod.yml run --rm \
  -v "$PWD/scripts:/app/scripts:ro" -v "$PWD/src:/app/src:ro" \
  migrate npx tsx scripts/seed-beta-catalog.ts --apply --allow-production --models founder.json
```

Hành vi seed (`scripts/seed-beta-catalog.ts`):

- **Dry-run mặc định** — `--apply` mới mutate; `--allow-production` bắt buộc
  cho đích non-local/`NODE_ENV=production` (guard từ ĐÍCH — fail closed).
- Idempotent: create-if-absent theo slug (`slugify("<brand> <name>")`), status
  **`pending`** — founder duyệt tiếp qua `/admin/catalog` (§1).
- KHÔNG BAO GIỜ reassign category/brand/status của model đã tồn tại.
- Cùng tx: toàn bộ creates + audit `beta_catalog.seeded` (actor null, detail
  chỉ counts — không PII); lỗi giữa chừng → rollback toàn bộ.
- Category beta: `portable_bluetooth_speaker`
  (`BETA_PUBLICATION_CATEGORIES` — `src/lib/beta-categories.ts`, spec §5.6.1
  verbatim, snake_case nguyên văn) + 5 brand focus (JBL, Marshall, Sony, Bose,
  Soundcore — spec §1) được tạo nếu thiếu (create-if-absent theo slug).
- Rollback: script in danh sách slug run tạo ở cuối mỗi lần `--apply` — chỉ
  xoá theo danh sách đó, không heuristic.

## 3. Review alias (FD-R24 — cùng sitting)

Alias tìm kiếm (`SearchAlias`) cũng là **founder-supplied content** — cơ chế
ship EMPTY (không file → không tạo gì). Cùng sitting review với model:

```bash
# Dev:
DATABASE_URL=… npx tsx scripts/seed-search-aliases.ts --apply --aliases founder-aliases.json
# Mục: { "alias": "soundlink", "target": "model", "productModelId": "<uuid>" }
#      { "alias": "loa jbl",  "target": "brand", "brandId": "<uuid>" }
# Production: tiền tố docker compose run migrate như §2 (--allow-production).
```

Hành vi (`scripts/seed-search-aliases.ts`): dry-run mặc định; idempotent
create-if-absent theo (alias chuẩn hóa, target); row có sẵn trỏ đích KHÁC
file → **RETARGET** update-in-place (file founder là source of truth) + audit
count; alias lưu dạng chuẩn hóa (`normalizeSearchText` — khóa tra cứu của
`resolveSearchQuery`); check constraint `search_alias_target_ids` bắt ở DB
đích phải set đúng một catalog entity. Alias chất lượng tìm kiếm là điều
kiện launch `[FOUNDER DECISION — FD-R24 — BLOCKING]`.

## 4. Quyết định taxonomy `loa-bluetooth` (FD-R19)

Seed KHÔNG đụng category legacy: category `loa-bluetooth` hiện có giữ
**active** (grandfathered — listing legacy đọc được, nhưng publication mới
bị chặn ngoài allowlist §2). Quyết định deactivate/merge `loa-bluetooth` vào
`portable_bluetooth_speaker` (và slug convention) là của founder
`[FOUNDER DECISION — FD-R19]` — không có hành động nào trong quy trình này
tự động thay đổi.

## 5. Photo checklist + condition grade (founder content — FD-R14/R15)

Hai vocabulary liên quan chất lượng listing mà founder phải author/duyệt
trước beta (cross-reference — không re-author ở đây):

- **Condition-grade definitions** (FD-R14 — BLOCKING): định nghĩa user-facing
  cho `condition` (spec §5.6: "user-facing definitions rather than only
  vague labels such as '95%'") + chồng lấn `product_condition` vs
  `inventoryContext` (`new`/`open_box`/`used`). Xem
  `docs/superpowers/specs/2026-10-06-private-beta-marketplace-reset-design.md` §5.6.
- **Photo-checklist requiredness** (FD-R15 — BLOCKING): 8 slot spec §5.6.3
  (front, back, control panel, charging/connection ports, major
  scratches/damage, accessories, box where available, relevant label/serial
  area where safe) hiện ship toàn bộ dạng HƯỚNG DẪN; quy tắc bắt buộc theo
  slot/condition (≥1 ảnh là rule code duy nhất) là founder policy. KHÔNG yêu
  cầu hiển thị serial nhạy cảm công khai (spec §5.6.3).

## 6. Core model coverage (§12.1)

Trước khi mở rộng mời buyer (cổng supply readiness —
`docs/operations/founding-seller-onboarding-checklist.md` §3 mục 5): founder
xác nhận danh sách model `approved` trong `/admin/catalog` **phủ các model
thực tế người bán sẽ đăng** trong beta (đích: không tin đăng nào rơi vào
"model không có trong catalog"). Bằng chứng: sitting review §1–§3 hoàn tất +
số model approved ghi vào checklist §12.1.

## 7. Founder Decision Items (quy trình này mang)

| Mục | Ghi chú |
|---|---|
| FD-R14 | Condition-grade definitions + `product_condition`/`inventoryContext` overlap (§5) — BLOCKING (content) |
| FD-R15 | Photo-checklist requiredness theo slot/condition (§5) — BLOCKING (policy) |
| FD-R16 | Danh sách model canonical: founder cung cấp + duyệt (§1–§2) — BLOCKING (ops data) |
| FD-R19 | Taxonomy `loa-bluetooth` deactivate/merge + slug convention (§4) |
| FD-R24 | Alias content (§3) — BLOCKING (alias-driven search quality) |

Liên quan chéo: `docs/operations/founding-seller-onboarding-checklist.md`
(§3 mục 5–6), `docs/operations/concierge-onboarding-playbook.md` §1 (concierge
hỗ trợ chọn model — KHÔNG bịa claim).
