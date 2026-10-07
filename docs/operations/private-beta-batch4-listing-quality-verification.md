# Private Beta Batch 4 — Listing Quality Gate Verification (Task 9)

**Date:** 2026-10-08 (Asia/Ho Chi Minh)
**Plan:** `docs/superpowers/plans/2026-10-06-private-beta-batch-4-listing-quality.md` (Task 9 + Acceptance Gate + Final Acceptance Commands)
**Spec:** `docs/superpowers/specs/2026-10-06-private-beta-marketplace-reset-design.md` (§9 Batch 4 + Gate, §10/§10.1)
**Worktree:** `Speaker Platform-worktrees/batch4-implementation` (branch `opencode/batch4-implementation`)
**Founder decisions:** FD-1 (34 provinces per NQ 202/2025/QH15 — `src/lib/provinces.ts`, consumed only), FD-2 (production OTP provider deferred — Batch 8 register), FD-3 (fail-closed defaults; founder-authored content = PROVISIONAL placeholders → Batch 8 register)

> ## ✅ OVERALL VERDICT: **GATE PASS**
>
> Every unit gate suite, the integration suite (real scratch Postgres, `--to production`),
> the backend-enforcement source scan (every hit classified), lint, typegen, typecheck, the
> production build, preflight (7/7), the safe smoke (standalone production parity — incl.
> uploads served **after** start), `npm audit --omit=dev` (0 vulnerabilities), the contract-emit
> drift check, the migration review (additive-only; the one destructive-looking op per Batch 4
> package is the expected `Listing_status_check_*` DROP+ADD pair — additive in effect, R3), and
> the diff/status audit are **green**. One Task 9 finding was caught and fixed during
> verification (§7.4: the dev DB marker lagged the refs — the two holistic migrations had only
> ever run on scratch DBs; `db migrate --to db` applied the pending additive op and `db verify`
> is clean). Recorded residuals (all pre-existing or deliberate fail-closed defaults) are in
> §8/§9 with their Batch 8 register hand-offs; the dormant-finance findings are **re-enable
> blockers**, not Batch 4 failures (§9.3).

---

## 1. Commits

Base: `7271256` (`test(batch3): verify trust & safety gate` — the merged Batch 3 commit; R1
satisfied: Batch 3 passed its gate and was merged before Batch 4 Task 1 started). Task 9
verifies HEAD `2e9f292` (b4-holistic round-4 last commit) plus this Task 9 doc commit.
**47 commits** base→HEAD = 1 plan-revision commit + 8 task commits (Tasks 1–8) + per-task
review-fix commits + the four holistic multi-agent review rounds (§6). No
push/merge-to-main/deploy at any point (the three `merge:` commits are the worktree's own
task-branch merges recorded by the task harness).

```
$ git log --oneline 7271256..HEAD   (47 commits — grouped)
─ Plan ─────────────────────────────────────────────────────────────────
4c2ddd7  docs(plan): update batch 4 plan to reviewed revision
─ Tasks 1–8 ────────────────────────────────────────────────────────────
7c2bb6c  feat(db): add batch 4 listing quality contract                (Task 1)
480e55a  feat(listing): beta category gate and submission schema       (Task 2)
2d4ad07  feat(upload): re-encode uploads, strip EXIF/GPS, record ownership  (Task 3)
5724bcc  fix(listing): bound legacy fields and decode memory           (Task 3 review fix)
4c77824  fix(upload): bound re-encode queue and per-user uploads        (Task 3 review fix)
0d3419b  feat(listing): draft/submit actions behind extended publication gate  (Task 4)
45b4a1d  feat(sell): portable-speaker listing flow                     (Task 5)
154d33e  fix(admin): render-tested review card and safe image sources  (Task 5 review fix)
67ec03c  fix(listing): version-checked claims and hidden-path review bypass  (Task 5 review fix)
f041bfe  fix(sell): moderation-locked edit page and safe error lookup  (Task 5 review fix)
736936d  merge: Batch 4 Task 5 seller and buyer listing UI
9c3bc50  feat(admin): structured listing review surface                (Task 6)
a22d91f  merge: Batch 4 Task 6 admin review UI
eba7c30  feat(catalog): seed beta category and canonical models         (Task 7)
60861a9  fix(catalog): strict seed input and atomic apply              (Task 7 review fix)
ce53ebc  merge: Batch 4 Task 7 beta catalog seed
ebe82b8  fix(listing): single draft per create, honest save banner     (Task 8 review fix)
30bd07b  test(listing): legacy compat and publication gate integration (Task 8)
─ Per-task review fixes (batch-level) ──────────────────────────────────
7370650  fix(authz): listing detail read gate uses session MFA + capability
c574b10  fix(admin): approve/reject CAS on the reviewed version, recusal, audits in one tx
30ed08e  fix(listing): audit every path into review, PriceHistory discipline, Category.isActive
3942b1a  fix(listing): form-action contract — typed errors, honest banners, CRLF/legacy-city
953f84e  test(identity): stub AUTH_SECRET in identity-collision integration suite
60c3938  fix(deps): bump source-map-js to 1.2.2 (GHSA-68fv-2mgg-jv7q — dev transitive)
─ Holistic multi-agent review rounds 1–4 (see §6) ──────────────────────
5ba11c5 709df21 a87a56b 01ed352                       (round 2)
87fb3e1 79df602 37ed05a 930d598 6e90df7 5adcbe2 2997df3 05ced99   (rounds 1+3)
9dadc7a 194f65a b120081 2d89b32 35bd3ed f09843c f3ea52d a2880de cbb7260 2e9f292  (round 4)
```

Whole-batch diff: **115 files, +49,717/−1,040** (emitted contract artefacts dominate).
**Dependency changes:** exactly one runtime pin — `sharp` `^0.35.5` → **`0.35.5` exact**
(Global Constraints dependency policy; lockfile already resolved 0.35.5) — plus the
`source-map-js` 1.2.1→1.2.2 security bump (GHSA-68fv-2mgg-jv7q, dev-transitive only, `60c3938`).
No other runtime dependency added or changed.

**OpenCode metadata:** model `home-gateway/OneNexus/glm-5.3` (OneNexus GLM 5.3), executed via
OpenCode on macOS per spec §11. Per-task execution sessions are documented in the task reports
(`/tmp/loaviet/batch4-task{1..8}-report.md` and the per-task fix reports named inside them; the
four holistic review rounds are documented in `/tmp/loaviet/batch4-holistic-fix-report.md` —
each names its worktree, base commit, and fixing commits). This Task 9 verification ran in the
current session on branch `opencode/batch4-implementation` in worktree
`Speaker Platform-worktrees/batch4-implementation`.

---

## 2. Gate-suite results (Step 1 — all green)

Run 2026-10-08 in the worktree, Node ≥ 22, vitest 4.1.11. The **eight** spec §9 Batch 4 gate
items map to named suites as follows (command → per-file counts):

| # | Spec §9 gate item | Suite(s) | Result |
|---|---|---|---|
| 1 | Draft behavior | `tests/unit/listing-draft-actions.test.ts` | **PASS — 43/43** (drafts creatable **before** verification — no seller-gate call on the draft path; never publicly visible — detail/home/seller/model/compare/related queries filter `approved`; rate-limited 20/h; image-ownership rules 1/2/3 enforced on drafts too (0 images OK); R5-guarded via `isModerationLocked`; draft-only CAS (`status: "draft"`) with 0-rows → typed `LISTING_CONCURRENT_CHANGE`; `submitListingAction` is the only draft→review path and it is fully gated; `updateListingAction` on a draft stays `draft`; single-draft-per-create; `?saved=draft` honest banners) |
| 2 | Publication gate | `tests/unit/publication-gate.test.ts` + `tests/integration/listing-publication.test.ts` (+ `listing-submit-approve-race`, `admin-approve-atomicity`, `listing-visibility-review`) | **PASS — 80 unit + 12+4+1+13 integration** (create/submit/update-into-pending/toggle each call `assertListingPublishable` exactly once via the counting-wrapper contract; non-transition updates call `assertListingContentValid`; admin approve calls `checkListingPublication` once; every structured field, brand/model, image set, and slot set counts as a content change; `hidden` content changes also go to `pending` (B3) — plus the b4-holistic `approvedContentAt` review-version mechanism (hidden+SET → fast path `approved`; hidden+NULL → `pending` + `listing.submitted` audit `via=show_again`); revoked sellers, suspended memberships, and **actively `UserSuspension`-suspended sellers** blocked on every path **including admin approval**; approve/reject CAS on the **reviewed** `updatedAt` version (`listing_changed_during_review`), recusal (`moderator_conflict`), both audits in one tx; R5 `isModerationLocked` guards on update/toggle/delete/draft/submit; CRLF-normalized no-op saves do not re-queue review) |
| 3 | Invalid-category rejection | `tests/unit/beta-categories.test.ts` | **PASS — 10/10** (new listings only in `portable_bluetooth_speaker`; category changes only INTO the allowlist; unchanged legacy categories grandfathered; `assertCategoryActive` server-side — inactive target rejected, kept category passes; slug never through `slugify`) |
| 4 | Conditional fields | `tests/unit/listing-schema.test.ts` | **PASS — 53/53** (beta regime requires brand/canonical model/inventory context/condition/fulfillment/province+display location/≥1 image; legacy regime requires only the existing rules — incl. typed `CONDITION_INVALID` on bogus legacy condition; drafts require the base non-null fields incl. province (structured optional, images 0..8); free-text caps `FREE_TEXT_MAX`/`DESCRIPTION_MAX`; `grandfatherStoredBounds` bypasses exactly the two stored upper bounds on non-content transitions only; title ≥1 letter/digit + empty-slug fallback `tin-<uuid8>`) |
| 5 | Upload validation | `tests/unit/image-validate.test.ts` + `tests/unit/upload-route.test.ts` | **PASS — 15 + 29** (early `Content-Length` rejection; magic bytes + sharp decode cross-check; SVG/HTML never accepted; per-IP and per-user(≤ per-IP) rate limits with `TRUST_PROXY_HEADERS`; 24h/user storage quota `UPLOAD_DAILY_MAX=60` → 429 `UPLOAD_QUOTA` + `Retry-After` without reading the body; busy/in-progress rejections do not burn the rate-limit token; process-wide body bound `uploadBodiesInFlight`; the stored file is the re-encoded buffer, never the upload; the `ListingImageUpload` row precedes the file; `/uploads` served with `nosniff` + CSP `default-src 'none'; sandbox`) |
| 6 | Image security cases | `tests/unit/image-process.test.ts` + `tests/unit/listing-images.test.ts` (+ `uploads-serve-route`) | **PASS — 33 + 25 + 8** (EXIF/GPS stripped — JPEG with GPS IFD → clean WebP, no EXIF marker at all; auto-orient before strip; polyglot neutralized by decode→pixels→encode; decompression bomb capped at the justified 50MP/12kpx with per-format caps (PNG/GIF/WebP 24MP, interlaced/16-bit 12MP); output resize-bounded + size-capped; randomized `crypto.randomUUID()` storage keys with allowlisted extension; per-URL ownership order (1) upload row for the exact `/uploads/<storageKey>` → owner check, (2) row-less + attached → strict path pattern + no `..`, (3) everything else rejected **including attached scheme-URLs even at approve, and a scheme URL whose basename matches the seller's own upload row → `IMAGE_URL_INVALID`**; duplicates and slot-length mismatches rejected; serve route: 200/404/content-type per ext, traversal 404 before touching the filesystem, FileHandle owns the fd — no GC fd leak) |
| 7 | Canonical model selection | `tests/unit/listing-publication.test.ts` + `tests/integration/beta-catalog-seed.test.ts` (+ `catalog-merge-race`) | **PASS — 37 unit + 28 integration (+2 race)** (`assertCanonicalModelValid`: missing/merged/pending/other-category → `MODEL_INVALID`, other-brand → `MODEL_BRAND_MISMATCH`; draft path is existence-only FK check (pre-gate per §4.4) with submit gate as the status/brand/category validation; seed: founder-supplied `--models` file validated fail-closed (caps 1MB/500 items/100 chars, `releaseYear` Int 1990..+1, duplicate-slug typed error with both indices), models seeded `status: "pending"` — approved via `/admin/catalog`, create-if-absent, never reassigns an existing model's category/brand, idempotent, slug never through `slugify`; `mergeModelAction` target-locked CAS — concurrent opposite merges commit at most one) |
| 8 | Legacy listing compatibility | `tests/integration/legacy-listing-compat.test.ts` | **PASS — 9/9 real-DB** (pre-Batch-4 listings render, edit, resubmit, and re-approve unchanged under the legacy regime; kept seed `/img/…` images and **attached** pre-Batch-4 `/uploads/<uuid>.<ext>` files pass; detached pre-Batch-4 uploads rejected with a typed error — documented compat behavior; legacy `rejected` does not resubmit to `pending` on edit (A10 interim — form message directs to a new beta listing); grandfathered stored bounds on non-content transitions let a legacy row valid under the old rules (>8 images / desc >4000) toggle/approve without silent block) |

Supporting gate suites (also run, all green): `portable-listing-form` 13 (7-step flow contract —
no `action` prop, `onSubmit`+`startTransition`, controlled textareas, submitter-carried
`name="intent"`, whole-listing image budget + reservation, props-only trust boundary),
`sell-pages` 48 (copy neutrality + CITIES refresh + edit-page banners), `admin-listings-page` 15
+ `admin-listings-guard` 14 (admin review surface: structured fields rendered, no
`line-clamp` on review text, safe image sources, workflow badge, recusal row), `image-picker` /
`wishlist-*` / `chat-*` / `catalog-actions` / `cleanup-uploads` / `seed-beta-catalog-guard` /
`sell-error-boundary` / `admin-seller-counts` / `finance-dormant-conditional-writes` /
`approved-content-backfill-migration` (b4-holistic suites, §6).

**Integration suite** (`npm run test:integration`, scratch container, migrate `--to production`):
**22 files / 173 tests PASS** — `batch4-migration` 9, `beta-catalog-seed` 28,
`legacy-listing-compat` 9, `listing-publication` 12, `listing-visibility-review` 13,
`listing-approved-content-backfill` 3, `listing-submit-approve-race` 4,
`admin-approve-atomicity` 1, `catalog-merge-race` 2, plus Batch 1 `escrow` 6 and all Batch 2/3
suites green unchanged (`batch2-migration` 13, `batch3-migration` 22, `seller-verification` 7,
`session-lifecycle` 10, `identity-collision` 5, `admin-bootstrap` 7, `admin-mfa-login` 2,
`block-enforcement` 3, `report-evidence` 7, `suspension-enforcement` 2, `listing-delete-race` 2,
`multi-row-writes` 6). Container cleaned by the script trap.

**Full unit suite:** `npm test` → **74 files / 1464 tests PASS** (Batch 1 finance shutdown +
Batch 2 identity/security + Batch 3 trust/safety suites all green unchanged;
`admin-page-guards.test.ts` green — the recursive net auto-covers every admin page touched by
Batch 4).

**Seed dry-run** (Step 1 last command — read-only, dev DB via `DATABASE_URL`, output verbatim):

```
$ DATABASE_URL=postgresql://speaker:…@localhost:5435/speaker_platform npx tsx scripts/seed-beta-catalog.ts
── dry-run (mặc định) — truyền --apply để chạy thật
── chế độ: dry-run
── category "portable_bluetooth_speaker": SẼ TẠO
── brand SẾ TẠO: soundcore
── brand đã có (không đụng): jbl, marshall, sony, bose
── kết quả: category=1 brands=1 models=0
```

**Founder model-list status (A3):** `models=0` — no founder `--models <founder.json>` has been
supplied yet, and the implementer **never authors a model list from training data**. The
mechanism ships: the founder supplies the file, the script upserts every model as
`status: "pending"`, and the founder approves them via `/admin/catalog` — the beta form's
model select only lists **approved** models, so it stays empty until the founder acts.
**Launch blocker → Batch 8 register (§9.1).**

---

## 3. Backend-enforcement + copy source scan (Step 2 — every hit classified)

`rg` (ripgrep 14.x). Expected result stated per the plan; every hit manually classified.

### 3.1 Plan scans

| Scan | Expected | Actual | Classification |
|---|---|---|---|
| `rg -n "BETA_PUBLICATION_CATEGORIES" src app` | definition + call sites — **no client bundle** | `src/lib/beta-categories.ts` (definition, plain module — server-owned constant, §5.6.1) + call sites: `app/sell/new/page.tsx:4,30,45`, `app/sell/[id]/edit/page.tsx:5,107` (both **server** pages filtering the category select), `src/lib/actions/admin.ts`, `src/lib/actions/listings.ts` | ✅ All server-side. The client form `src/components/portable-listing-form.tsx` has **zero** code hits — its 4 matches (L28,30,31,111) are **comments** stating the trust boundary ("component KHÔNG import listing-schema.ts hay beta-categories.ts — spec §4.5 props only"); categories/labels/slots/provinces arrive as props from the server page. |
| `rg -n "assertListingPublishable\|assertListingContentValid\|checkListingPublication" src/lib/actions` | every transition uses the wrapper; approve only `checkListingPublication` | `listings.ts`: `runPublicationGate`→`assertListingPublishable` (L193) called by `createListingAction` (L386) and `updateListingAction` content-change→pending (L995); `runContentValidation`→`assertListingContentValid` (L225) called by non-transition updates (L998); `submitListingAction` (L753) and `toggleListingVisibilityAction` hidden→approved (L1155) call `assertListingPublishable` directly; `admin.ts`: `approveListingAction` calls `checkListingPublication` **once** (L133) | ✅ Exactly the Task 4 rewiring: 4 publication transitions + submit through the full gate; non-transition updates content-only; admin approve through the non-throwing check (input from the DB row, `grandfatherStoredBounds` on the non-content transitions). |
| `rg -n "checkSellerPublicationRequirements" src/lib/actions/admin.ts` | **0 hits** (direct call deleted — subsumed by `checkListingPublication`; spy cannot prove absence — this scan is the evidence) | **1 hit — line 25, inside the `approveListingAction` docblock** ("checkSellerPublicationRequirements ĐÃ XÓA") | ✅ **Comment only** — the rule text itself. **Zero code hits: the Batch 2-era direct call is deleted**; the seller check runs inside `checkListingPublication` (via `assertListingPublishable`'s wrapper), keeping the `listing.approve_blocked` reason `publication_requirements_unmet` + `detail: missing=…` on seller-check failure (pinned by `tests/unit/publication-gate.test.ts`). |
| `rg -n "isModerationLocked" src/lib/actions/listings.ts` | every R5 guard calls the helper from `@/src/lib/moderation` | import (L10) + **6 call sites**: L502 `saveListingDraftAction`, L726 `toggleListingVisibilityAction`, L885 `updateListingAction`, L1034 fresh re-read classifier (CAS 0-rows branch), L1144 `submitListingAction`, L1267 `deleteListingAction` | ✅ All guards consume the Batch 3 helper (never a raw `.includes` on the tuple, never a hardcoded status). Extended to the new draft/submit actions per R5; the 4th site is the fresh re-read classification inside the tx. |
| `rg -n '"removed"' src/lib/actions/listings.ts` | 0 hits outside comments (no hardcoded status — Batch 3 source contract) | **0 hits** | ✅ Clean — no hardcoded `"removed"` anywhere in `listings.ts`. |
| `rg -n "đảm bảo\|bảo đảm\|guarantee" src/components/portable-listing-form.tsx app/sell app/models` | 0 hits **outside comments** | **1 hit** — `app/sell/verification/page.tsx:28`, a **comment** listing the §6.2 avoid-list ("không ngôn ngữ bảo đảm/đảm bảo/chứng nhận") | ✅ **Comment only** — the rule text, not rendered copy (the plan pre-classifies this exact hit). Zero hits in `portable-listing-form.tsx` and `app/models`. |
| `rg -n "an toàn khu vực\|khu vực an toàn\|verified market" src app` | 0 hits (§4.7 location neutrality) | **0 hits** | ✅ Clean — no location-safety claims anywhere. |
| `rg -n "dangerouslySetInnerHTML" src/components app` | 0 hits (stored XSS through listing) | **1 hit** — `src/components/report-dialog.tsx:23`, a **comment** ("hiển thị qua React text, không dangerouslySetInnerHTML — spec §7.4") | ✅ **Comment only** (Batch 3 posture, same classification). Zero code hits — all listing/seller/admin free text renders as React text nodes. |
| `rg -n "FINANCIAL_FEATURES_ENABLED" .env.example docker-compose.prod.yml scripts` | still `"false"` everywhere | `.env.example:35` `"false"`, `docker-compose.prod.yml:118` `"false"`, `scripts/smoke.sh:12,111,218` (comment + `export …="false"` + comment), `scripts/docker-smoke.sh:86` (comment) | ✅ Batch 1 preserved verbatim — **`"false"` everywhere**; no Batch 4 surface weakens it (all finance suites green, §9.2). |
| `rg -n "withMetadata" src/lib/image-process.ts app/api/upload` | 0 hits — re-encode keeps no metadata | **2 hits — both comments** in `src/lib/image-process.ts`: L11 (docblock "KHÔNG bao giờ gọi withMetadata() → output KHÔNG mang EXIF/GPS/ICC/XMP nào") and L251 (inline "withMetadata() KHÔNG bao giờ được gọi ở pipeline này — Task 9 scan pin"); `app/api/upload` — 0 hits | ✅ **Comments only** — the rule text itself. Zero code hits: the pipeline is `.rotate().resize().webp().toBuffer()` — decode→pixels→encode, metadata never re-written (pinned by `image-process.test.ts` "output contains no EXIF marker at all"). |
| `rg -n "nosniff" next.config.ts` | `/uploads` headers present | L12 (comment) + **L31 `X-Content-Type-Options: nosniff`** with L32 `Content-Security-Policy: default-src 'none'; sandbox` on `source: "/uploads/:path*"` | ✅ Present — belt-and-braces layer (the serve route sets the same headers itself; see §7.3 deploy note). |
| `grep -n "Bình Dương\|Thừa Thiên Huế" src/lib/constants.ts` | 0 hits after the CITIES refresh (FD-1 — stale names gone) | **0 hits** | ✅ Clean — `CITIES` is refreshed to the 34 canonical `displayName`s; no stale 63-province names. |
| `PROVINCE_CODES` key count | 34 | `npx tsx -e` → **`PROVINCE_CODES keys: 34`, `PROVINCES entries: 34`**; `resolveLegacyProvince("Thừa Thiên Huế")` → `null`, `resolveLegacyProvince("Bình Dương")` → `ho-chi-minh` | ✅ FD-1 registry intact (A9 resolved); `tests/unit/provinces.test.ts` 20/20 green pins the mapping rule (NQ 202/2025/QH15 — authoritative, not guessing). |

### 3.2 Comment-vs-render classification (§6.2 avoid-list + XSS scans)

The three comment hits above (`app/sell/verification/page.tsx:28`,
`src/components/report-dialog.tsx:23`, `src/lib/image-process.ts:11,251`) are **rule text
inside docblocks**, never rendered to users; the corresponding rendered surfaces are pinned by
source-contract tests (`sell-pages.test.ts` copy-neutrality cases,
`admin-listings-page.test.ts` / `moderation-pages.test.ts` no-`dangerouslySetInnerHTML`
contracts, `image-process.test.ts` no-EXIF cases). The
`checkSellerPublicationRequirements`-absence proof lives **here** (the §3.1 scan), not in
vitest spies — same-module call-absence cannot be proven by spying (Global Constraints).

---

## 4. Full preflight + build + smoke (Step 3 — all green)

| # | Command | Result |
|---|---|---|
| 1 | `npm run lint` | **PASS** — 0 errors, 0 warnings |
| 2 | `npx next typegen` | **PASS** — route types generated (incl. `/uploads/[key]`, `/sell/[id]/edit`) |
| 3 | `npx tsc --noEmit` | **PASS** — exit 0 |
| 4 | `npm test` (full unit) | **PASS — 1464/1464, 74 files** (§2) |
| 5 | `npm run test:integration` | **PASS — 173/173, 22 files** (§2; scratch container migrated `--to production`, cleaned by trap) |
| 6 | `npm run build` | **PASS** — exit 0, compiled successfully; `/sell/new`, `/sell/[id]/edit`, `/uploads/[key]`, `/admin/listings` emitted as dynamic routes; **1 pre-existing warning only** (`instrumentation.ts:27` `process.exit` in Edge Runtime — Batch 0/1 commit `b8e1c85`; `git log 7271256..HEAD -- instrumentation.ts` is **empty** — untouched by Batch 4) |
| 7 | `npm run preflight` | **PREFLIGHT PASS — 7/7 gates**: contract-emit-drift, lint, typecheck, unit-tests, production-build (placeholder env), compose-config, migration-graph |
| 8 | `npm run smoke` | **SMOKE PASS** — standalone production parity (`node server.js`, scratch DB): health `200 db=up`; home/login 200; chat 401; momo create/ipn 503 `FINANCIAL_FEATURES_DISABLED`; cron wrong-secret 401 / correct-secret 503 typed; 9 retired finance pages 404; momo return 500 unavailable; **uploads served after start: real webp written into the uploads dir AFTER boot → `GET /uploads/<key>` → 200 `image/webp` + `nosniff` + CSP `default-src 'none'; sandbox`; bad-format key / traversal / not-yet-uploaded key → 404**; scratch container cleaned |
| 9 | `npm audit --omit=dev` | **PASS — found 0 vulnerabilities** (sharp exact-pinned 0.35.5; the one dev-transitive advisory GHSA-68fv-2mgg-jv7q was bumped in `60c3938`) |
| 10 | `npx prisma contract emit` + `git diff --exit-code -- src/prisma` | **NO DRIFT** — re-emit is byte-identical to the committed artefacts (storageHash `66d2193a…`) |

Nothing was skipped — the full Task 9 command set ran, including the smoke uploads checks added
by the b4-holistic round-3 HIGH fix.

---

## 5. Diff/status audit + migration review (Step 4 — green)

- `git diff --check` → clean. `git status --short` → **empty** (no `.claude/settings.json`, no
  `public/uploads/` runtime files, no secrets, no scratch, no `.superpowers/` staged anywhere in
  the batch; `data/` is gitignored).
- `npx prisma migration list` → **linear graph, 6 nodes** (R3):
  `20261003T0448_baseline` (empty → `7a6d2852…`, 143 ops) → `20261006T0209_batch2_identity_security`
  (→ `0ed42b45…`, 49) → `20261006T1420_batch3_trust_safety` (→ `dbd12d36…`, 54) →
  `20261006T1902_batch4_listing_quality` (→ `177b84a6…`, 17) →
  `20261007T1708_batch4_holistic_review_fixes` (→ `66d2193a…`, 1) →
  `20261007T2007_batch4_round4_approved_content_backfill` (self-edge `66d2193a…` →
  `66d2193a…`, 1, refs `db`+`production`, invariant `backfill-listing-approved-content-at`).
  No node with two outgoing edges; no gaps.
- `npx prisma db verify` (dev DB) → **ok**: "Database marker and schema match contract",
  `mode: full`, contract storageHash == marker storageHash (`66d2193a…`), profileHash match.
  *(Caught + fixed during this Task 9 — see §7.4.)*
- **Migration review — additive-only confirmation:**
  - `20261006T1902_batch4_listing_quality` (17 ops): **16 `additive` + exactly 1
    `destructive`** — the destructive op is
    `dropCheckConstraint.Listing.Listing_status_check_505de324`, the DROP member of the
    expected **`Listing_status_check_*` DROP+ADD pair** (R3): a pg/text enum value lives in a
    CHECK constraint, so appending `archived` re-renders it; the ADD partner
    (`checkConstraint.Listing.Listing_status_check_f81f49ae`, additive) re-creates the CHECK
    with all seven existing values **plus `archived`** — **additive in effect**. `removed`
    belongs to Batch 3's migration (R2 — not re-added). Zero `column.` drops/alters on existing
    tables, zero data transforms in this package (`pendingPlaceholders: false` at plan time).
  - `20261007T1708_batch4_holistic_review_fixes` (1 op): `column.public.Listing.approvedContentAt`
    — **additive** (nullable review-version column, b4-holistic round 2).
  - `20261007T2007_batch4_round4_approved_content_backfill` (1 op):
    `data.backfill-listing-approved-content-at` — **data-only self-edge** (b4-holistic round 4):
    `rawSql` sets `approvedContentAt = updatedAt` for `status='approved' AND approvedContentAt IS
    NULL` rows only (precheck/execute/postcheck), **invariant-routed** (`providedInvariants` +
    the `production` ref declaring it) so the default path walk never selects the self-edge —
    `db migrate --to production` (the compose migrate service) traverses it **exactly once**;
    the marker records the invariant → idempotent. Rows `hidden/pending/rejected/draft` keep
    `NULL` (fail-closed — their content is not known-reviewed).
  - No existing finance table, historical record, or legacy column is dropped or repurposed by
    any Batch 4 package (verified op-by-op via `migration show`).

---

## 6. Holistic multi-agent review summary (rounds 1–4)

Beyond the per-task reviews, the merged Batch 4 line went through a holistic multi-agent review
(**37 confirmed findings** across rounds 1–3) and an independent fix-verification review
(**12 more + 1 split**, round 4). All fixes are committed on this branch; full detail in
`/tmp/loaviet/batch4-holistic-fix-report.md`. Findings by area/severity → fixing commits:

### Round 1 (20 CONFIRMED + 2 UNVERIFIED — 6 round-1 gaps closed in this round's session)

| Area | Sev | Finding (short) | Fix |
|---|---|---|---|
| authz-idor | MEDIUM | non-public listing visible via `user.role === "admin"` display gate | `7370650` (read gate = session.isAdmin + `listing.moderate` capability) |
| authz-idor / tx | MEDIUM | approve read version at click, not at review time; state change + audit outside tx | `c574b10` (approve/reject CAS on reviewed `updatedAt`, recusal, audits in one tx) |
| authz-idor | MEDIUM | draft reprice wrote public `PriceHistory` via `updateListingAction` | `30ed08e` (audit every path into review, PriceHistory discipline) |
| form-action-contract | MEDIUM | **React 19 `requestFormReset` wiped textareas + reverted selects** (silent province/brand/model revert) | `87fb3e1` (no `action` prop; manual dispatch + `startTransition`; controlled textareas) |
| validation-pii-xss | MEDIUM | moderation evidence snapshot lacked the Batch 4 public fields | `87fb3e1` (snapshot + case page render all structured fields + image slots) |
| form-action-contract | LOW ×7 | legacy form category dead-ends; 8 slot pickers vs 1-in-flight lock; 64-image budget; 200-model cap; stale `?error=` banners; LISTING_HAS_ORDERS/LISTING_CONCURRENT_CHANGE thrown to boundary; stale draft silent no-op | `87fb3e1`, `3942b1a` (typed form errors, honest banners) |
| validation | LOW | maxLength CRLF ≠ server length; draft FK brand/model unchecked; legacy city free-text unbound | `3942b1a`, `30ed08e` |
| unverified (fixed anyway) | — | approve recusal (U1); `Category.isActive` UI-only (U2) | `c574b10`, `30ed08e` (`assertCategoryActive` server-side) |

### Round 2 (5 CONFIRMED — 1 MEDIUM + 4 LOW)

| Area | Sev | Finding | Fix |
|---|---|---|---|
| visibility | MEDIUM | wishlist rendered pending/rejected/removed listing title/images to non-sellers | `709df21` (redaction + placeholder + remove-any-status; `toggleWishlistAction` add-only-approved) |
| review bypass | LOW | pre-Batch-4 `hidden` listing with never-reviewed content re-published straight to `approved` on toggle | `5ba11c5` + `a87a56b` (**`approvedContentAt` review-version column** + hidden→pending branch + audit `via=show_again`) |
| tx/FK | LOW | seller hard-delete hit FK 23503 via `ExchangeOffer.myListingId` | `a87a56b` (offer pre-check parallel to `OrderItem`; approved+refs → hide only) |
| review signal | LOW | "Số tin đăng" verification signal counted drafts | `01ed352` (non-draft count + separate draft count) |
| legacy compat | LOW | Batch 4 gate blocked legacy rows valid under old rules (>8 images / desc >4000) — silent toggle block | `a87a56b` (`grandfatherStoredBounds` on non-content transitions only; toggle block no longer silent — typed redirect) |

### Round 3 (1 HIGH + 4 MEDIUM overlap-verified + 15 LOW)

| Area | Sev | Finding | Fix |
|---|---|---|---|
| **uploads/deploy** | **HIGH** | **Next production only serves `public/` files present at boot → every post-restart upload 404 forever** | `79df602` (serve via `app/uploads/[key]` route handler reading disk every request; uploads dir moved **outside** `public/` → `data/uploads` volume; compose/Dockerfile/next.config/smoke/docs) |
| upload DoS | LOW | no per-user storage quota (≈8GB/day/user fill); busy/in-progress rejections burned rate-limit tokens; N concurrent bodies OOM'd the 768m container | `37ed05a` (`UPLOAD_DAILY_MAX=60`/24h → 429 + Retry-After; busy checks before token spend; **process-wide `uploadBodiesInFlight`** bound) |
| listing | LOW | empty slug (`!!!!!`/emoji/CJK titles) → every `/listings/<slug>` link hit the index; typed errors thrown to missing error boundaries | `930d598` (title ≥1 letter/digit; `listingSlug` fallback `tin-<uuid8>`; typed results/redirects; `app/sell/error.tsx`) |
| chat/catalog/admin/finance-dormant | LOW | chat pages leaked unreviewed content after edit→pending; merge cross-locked listings out of the gate; review card `line-clamp` hid phone numbers from moderators; exchange/order completion wrote `sold` unconditionally | `6e90df7` (chat redaction + `startConversationAction` approved-only; merge gate + `Listing.brandId` resync + CAS no-resurrect; full-text review card; conditional `sold` claims + audit in tx — **finance stays hard-off**) |
| deploy/seed | LOW | beta category only exists via seed (undocumented deploy step); `--allow-production` guard never fired on the VPS; 1GB-host advice pointed at a nonexistent runbook | `5adcbe2` (seed step in deployment.md §2 + runbook; guard decides from the **target** host; **2GB minimum**) |
| legacy enum | LOW | legacy edit `condition=bogus` → DB CHECK 500 | `05ced99` (`CONDITION_INVALID` typed) |

### Round 4 (independent fix-verification review — 12 CONFIRMED (10 unique) + 1 SPLIT)

| Area | Sev | Finding | Fix |
|---|---|---|---|
| **uploads runtime** | **HIGH** | serve route passed the **raw fd** to `createReadStream`; FileHandle never closed → GC closed reused fds (DB socket cut / EBADF / Node ≥24 crash) | `9dadc7a` (`handle.createReadStream()` — FileHandle owns the fd; close on every exit path; gc-leak test with `--expose-gc`) |
| deploy-risk | LOW | `approvedContentAt` had no backfill — every pre-deploy approved row fell out of the market on hide→show | `194f65a` (**data-only self-edge migration + invariant routing**; value = `updatedAt`; non-approved rows stay NULL fail-closed) |
| review queue | LOW | CRLF normalization made a no-op save of an old multi-line listing a content change → re-queue review | `b120081` (`nl()` normalization applied to the **stored** side before comparing) |
| form | LOW ×3 | `UPLOAD_QUOTA` raw English code in ImagePicker; whole-listing cap bypassed while slot 1 uploads; stale `?error=`/`?submitted=` banners stuck after later successes | `2d89b32` (quota text + route-message priority + budget reservation at pick time), `35bd3ed` (success paths redirect to bare/clean URLs; draft-save update → `?saved=draft`) |
| ops/deploy | LOW ×2 | cleanup-uploads via the migrate container (no uploads volume) would delete rows then swallow ENOENT → files orphaned forever; seed dry-run refused under the migrate image's `NODE_ENV=production` | `f09843c` (script fail-closed on missing dir; ENOENT = anomaly + exit 1; compose migrate mounts the uploads volume), `f3ea52d` (guard narrowed to `--apply` only) |
| catalog | LOW | concurrent opposite merges A→B + B→A both committed → every listing pointed at a merged model | `a2880de` (target-row CAS lock before source claim — at most one merge commits; race test 3/3 deterministic) |
| error boundary | SPLIT (confirmed) | `reset()` re-rendered the already-failed RSC payload — "Thử lại" did nothing | `cbb7260` (`retry()` — stable 16.3, re-fetches) |

### Recorded decisions from the review (product-visible, each reversible)

1. **Wishlist/chat redaction boundary**: a listing renders its full card only when
   `status ∈ {approved, sold}` **or** the viewer is the seller; anything else renders the
   placeholder "Tin (đăng) không còn hiển thị" (+ a working "Bỏ lưu"). Redaction chosen over
   query filtering so users can clean stale entries.
2. **`approvedContentAt` (review version) instead of a `hidden→pending` backfill UPDATE**:
   no bulk status change of untouched rows; the column distinguishes exactly "current content
   has been reviewed" and defers the transition to the seller's show-again click (lazy
   fail-closed). Backfill value = `updatedAt` (per-row "approved-at" does not exist in old
   data); non-approved rows keep NULL.
3. **`grandfatherStoredBounds`** bypasses exactly the two **stored upper bounds**
   (`DESCRIPTION_MAX`, `LISTING_MAX_IMAGES`) and only on transitions that do not change content
   (toggle hidden→approved/hidden→pending, admin approve) with input built from the DB row —
   the formData path never grandfathers; every lower bound and requiredness stays.
4. **Exchange-offer delete pre-check** treats offers like `OrderItem` (approved → hide only;
   other statuses → typed `LISTING_HAS_ORDERS` banner); hidden + references → deliberate
   silent no-op (already hidden).
5. **Upload quota 60/24h per user** (≈3× the per-listing image cap × a few listings) and the
   **process-wide body bound** (`uploadBodiesInFlight`, conservative double-count) instead of
   accepting a residual — policy numbers recorded for the Batch 8 register alongside A8.
6. **Finance dormant paths: only hardened writes, no new surface** — conditional `sold`/`approved`
   claims + audit-in-tx where the flows are reachable code; `FINANCIAL_FEATURES_ENABLED` stays
   hard-off; every entry point still denies typed.

### Open residuals / follow-ups from the review (registered, non-blocking)

1. **`exchange_mine` FK `onDelete: SetNull`** — deferred to the finance re-enable (the planner
   rejects FK `onDelete` changes → needs a manual `migration new`; the race it guards is
   unreachable today because new offers are denied by `assertFinancialFeaturesEnabled`).
   Comment recorded at `ExchangeOffer` in `src/prisma/contract.prisma`.
2. **`resolveDisputeAction` sold→approved review bypass** — returns a listing to `approved`
   without content review (dormant while finance is off; the `approvedContentAt` mechanism can
   absorb it at re-enable if needed). Same class as the §9.3 dormant paths.
3. **Chat hardening → Batch 6**: the Batch-4-scope leaks (chat page render of unreviewed
   content, `startConversationAction` on non-approved listings) are fixed here (`6e90df7`); the
   remaining Batch 6 chat/deal hardening plan is unchanged and owns the rest.
4. **Upload quota number (60) + orphaned-upload retention (A8)** → Batch 8 Founder Decision
   Register (product-policy numbers, not invented here).
5. **Process-wide upload body bound residual**: `uploadBodiesInFlight` is an in-memory
   process-local counter — a restart resets it and it does not bound across multiple app
   instances (same single-instance topology residual as the in-memory rate limiter, Batch 2 R1).
   Fine at beta single-container scale; revisit at multi-instance scale-out.
6. **`lastIntent && state.ok` form banner** in `PortableListingForm` became dead code after both
   draft-save branches redirect — kept as defensive; cleanup at the next form touch.

---

## 7. Deploy notes (Batch 4 → production)

1. **Two new migrations after the Batch 4 one** (both from the holistic review, both already in
   the graph and refs): `20261007T1708_batch4_holistic_review_fixes` (additive
   `Listing.approvedContentAt` column) and `20261007T2007_batch4_round4_approved_content_backfill`
   (data-only self-edge, **invariant-routed** — the compose `migrate` service's
   `db migrate --to production` runs the backfill exactly once; re-runs are "Already up to
   date"). No operator action beyond the normal `docker compose … up` flow.
2. **Uploads volume is now mounted at `/app/data/uploads`** (was `/app/public/uploads` — same
   volume, only the mount path changed, no data move). Next production serves `public/` files
   that exist **at boot only**, so uploads are served by the **route handler
   `app/uploads/[key]/route.ts`** which reads the disk on every request (key regex-validated
   against the uuid+extension pattern → traversal 404s before touching the filesystem;
   `Content-Type` from the validated extension; `nosniff` + CSP `default-src 'none'; sandbox` +
   immutable cache). The `next.config.ts` `headers()` block stays as belt-and-braces for any
   legacy static path. **If a future deploy serves `/uploads` directly from nginx, the same two
   headers must go into that location block** (production nginx currently proxies `location /`
   to the app per `docs/deployment.md`, so the Next headers reach `/uploads`).
3. **Beta catalog seed is a REQUIRED deploy step** (the `portable_bluetooth_speaker` category
   exists only via the seed — no admin action creates categories): run via the compose
   `migrate` image per `docs/deployment.md` §2 — dry-run first (allowed under the image's
   `NODE_ENV=production`), then `--apply --allow-production` (the guard decides from the
   **target** host; non-local targets require the explicit flag). Models are seeded
   `status: "pending"` and must be **approved via `/admin/catalog`** by the founder before they
   appear in the seller form (A3).
4. **2GB RAM host minimum** (b4-holistic round 3): the app container is `mem_limit: 768m`
   (sharp re-encode worst case ≈550–600MB with the semaphore + queue + process-wide body bound)
   and the db `512m`; a 1GB host is already over-subscribed before nginx + OS. The old
   "drop to 512m + lower the image cap" advice was removed (the cap is a constant in
   `image-process.ts`, not env-configurable).
5. **Cleanup tooling**: `scripts/cleanup-uploads.ts` (dry-run default, `--apply` fail-closed —
   refuses to run without the uploads dir, treats ENOENT as an anomaly) removes **orphaned**
   upload rows/files older than a 7-day grace and never attached to any `ListingImage`; the
   compose `migrate` service mounts the uploads volume so the documented command works verbatim.
   Retention **policy** is A8 (Batch 8 register) — the script is the mechanism, not the policy.

### 7.4 Task 9 verification finding (caught + fixed during this task)

`npx prisma db verify` against the **dev DB** initially failed `CONTRACT.MARKER_MISMATCH`: the
marker sat at `177b84a6…` (the `batch4_listing_quality` end hash) while the contract/refs are
`66d2193a…` — the two holistic migrations had only ever been applied to the throwaway scratch
DBs used by `test-integration.sh`/`smoke.sh`, never to the dev container. Fixed in-place with
`npx prisma db migrate --to db` (applied `20261007T1708_batch4_holistic_review_fixes`, 1 additive
op); `db verify` now clean. The backfill data op is **not** applied to the dev DB — by design:
the `db` ref declares no invariant, so the self-edge is production-routed only; dev rows
`approved` keep `approvedContentAt NULL` → hide→show stays fail-closed (`pending`) locally,
while production gets the backfill via the compose migrate service. No code change; recorded
here as the gate's evidence trail.

---

## 8. Recorded implementation decisions (Scope Decisions — mechanics, not policy)

All from the plan's Scope/Legacy-Migration decisions, verified in code and tests; each
reversible, none invents policy (FD-3):

1. **Regime derived from category** (beta ⇒ full structured validation; legacy ⇒ existing
   rules only), `currentCategorySlug` always read from the DB row — never formData.
2. **Allowlist invariant**: no listing can be created in, or moved into, a non-allowlisted
   category; unchanged legacy categories are grandfathered; category changes only INTO the
   allowlist (then full beta validation of the whole input).
3. **`city` ≡ canonical province `displayName`** (`PROVINCE_CODES[provinceLevelCode]`, FD-1)
   so the existing `/listings` city filter keeps exact-matching the refreshed 34-name
   `CITIES`; `locationDisplayName` is the seller's coarse display text; `communeLevelCode`
   stored but reserved for Batch 5.
4. **Status mapping**: `approved` ≡ spec `published`, `hidden` ≡ `paused`, `pending` ≡
   ready_for_review/under_review, `removed` ≡ takedown (Batch 3); Batch 4 adds **only
   `archived`** (reserved — no Batch 4 transition writes it). `verification_blocked` is not a
   distinct state (A5): a blocked draft stays `draft` with surfaced missing requirements.
5. **Draft behavior** (§4.4/§5.6.2): `saveListingDraftAction` pre-verification (no seller gate),
   `submitListingAction` draft→pending with the full gate; `updateListingAction` never
   transitions a draft; drafts rate-limited 20/h, image-ownership-validated, R5-guarded, never
   public; no autosave (spec: desirable, not release-blocking).
6. **Audit events**: `listing.draft_created`, `listing.draft_updated`, `listing.submitted`
   (with `policyVersion: SELLER_RULES_POLICY_VERSION`), `listing.submit_blocked`,
   `beta_catalog.seeded` appended to the registry; `listing.approve_blocked` reused with the
   two separated reasons (`publication_requirements_unmet` + `missing=` kept verbatim for
   seller-check failures — Batch 2 pin; new typed `listing_content_invalid` + `issues=` for
   content failures); every state change writes its audit **inside the same tx**
   (`auditEventTx`).
7. **Upload hardening** (§5.6.4/§7.5): magic bytes + sharp decode cross-check precede
   re-encode; `Content-Length` and encoded-size/pixel/decompression-bomb caps before full
   decode (50MP/12kpx with per-format caps); storage keys `crypto.randomUUID()`-based with a
   fixed allowlisted extension; the written file is always the re-encoded WebP (EXIF/GPS/ICC/XMP
   stripped, auto-orient, resize-bounded); the `ListingImageUpload` row is written **before**
   the file; per-user rate limit ≤ per-IP; 24h/user storage quota; process-wide body bound.
8. **Image ownership rules** (per URL, in order): (1) upload row for the exact
   `/uploads/<storageKey>` URL → owner check; (2) row-less + attached → strict path pattern +
   no `..`; (3) everything else rejected — **including attached URLs with a scheme, even at
   approve, even when the basename matches the seller's own upload row**.
9. **Legacy compat**: pre-Batch-4 uploaded files stay valid *while attached*; re-attaching a
   detached pre-Batch-4 upload to another listing is rejected (no ownership row — the seller
   re-uploads, which re-encodes); legacy `rejected` listings do not resubmit to `pending` on
   edit (A10 interim); `grandfatherStoredBounds` on non-content transitions only.
10. **Fulfillment values** `meetup | seller_delivery | carrier | other` mapped from spec §5.2
    (A7); **photo checklist**: the 8 §5.6.3 slots verbatim as guidance UI + structured slot
    tag, no slot hard-required beyond ≥1 image (A2); the `label_serial` copy tells the seller to
    cover/blur the serial **before** shooting because slot photos render publicly.
11. **Seed taxonomy** (A11): the beta category slug is the spec's verbatim
    `portable_bluetooth_speaker` (snake_case, never through `slugify`); the seeded
    `loa-bluetooth` category stays active — deactivation/merge is a founder product decision.
12. **CSRF posture**: Next.js 16 server actions are POST-only with built-in origin protection —
    no custom token layer added (Batch 2 posture, spec §10.1 row).

---

## 9. Residual risks, follow-ups & Batch 8 Founder Decision Register hand-off

### 9.1 Batch 8 Founder Decision Register (from this batch — launch blockers per FD-3, NOT gate failures)

| # | Item | Batch 4 posture (fail-closed default shipped) |
|---|---|---|
| A1 | **Condition-grade user-facing definitions** + the `product_condition` ↔ `inventoryContext` overlap (`new`/`open_box` exist in both) | Mechanism ships (existing 8-value enum + labels in the flow, §6.3 Step 2); **no definition copy authored**, no cross-field rule invented. A change needs its own additive migration + re-validation. |
| A2 | **Photo-checklist requiredness per slot/condition** | All 8 slots verbatim as guidance; no slot required beyond the existing ≥1-image rule; `label_serial` carries the blur-serial warning. |
| A3 | **Canonical model list (founder-supplied)** | Seed mechanism ships (`--models <founder.json>` → `status: "pending"` → approve via `/admin/catalog`); the implementer never authored a model list; the beta form's model select stays empty until the founder acts. Dry-run output in §2. |
| A8 | **Orphaned-upload retention/expiry policy** (+ the **upload quota number 60/24h** and the 7-day cleanup grace as recorded product-policy numbers) | No policy invented (deleting files would also break Batch 3 evidence snapshots); `scripts/cleanup-uploads.ts` is the reviewed mechanism (dry-run default, fail-closed apply); orphaned files remain publicly reachable until the policy is decided. |
| A10 | **Legacy-repurposing policy** (grandfathering lets a seller rewrite an old legacy listing's content wholesale while keeping the legacy category) | Fail-closed interim: legacy `rejected` does not resubmit on edit; the full policy (freeze legacy edits / ops review) is the founder's. |
| A11 | **Category taxonomy** (two public speaker categories now exist: seeded `loa-bluetooth` + `portable_bluetooth_speaker`) | Both active; deactivation/merge is a founder product decision. |
| FD-2 | **Production OTP email/SMS provider** (Batch 2 A1) | Deferred — beta-launch prerequisite; the fail-closed production adapter ships (Batch 2). |
| A9 | ~~Province registry~~ | **RESOLVED by FD-1** (34-unit registry per NQ 202/2025/QH15; legacy-name mapping authoritative; "Thừa Thiên Huế" → `null` pinned). |

**Beta-launch readiness additionally requires** the founder-authored content items above
(FD-3: A1 condition definitions, A2 checklist requiredness, A3 model list, A8 retention, A10
legacy-repurposing policy, A11 category taxonomy — plus FD-2's deferred production OTP
provider). **Those block launch content, not this implementation gate** (A9 is resolved by
FD-1).

### 9.2 Accepted residual risks (documented, no action in Batch 4)

| # | Residual risk | Status |
|---|---|---|
| R1 | Pre-Batch-4 **detached** uploads are not re-attachable to another listing (no ownership row) — the seller re-uploads, which re-encodes | Documented compat behavior (§Legacy Migration Decisions); accepted. |
| R2 | **Attached scheme-URLs (`https://…`) are always rejected, even at approve** — a legacy listing whose image row carries an external URL cannot pass the gate until the image is replaced | Documented compat behavior; accepted (fail-closed direction). |
| R3 | **GIF → static WebP**: re-encode drops animation (the first frame renders) | Accepted (§5.6.4 "safe re-encoding where practical"; no animated-image product requirement in P0). |
| R4 | **Drafts have no autosave** and effectively require a province (`city` derives from it — non-null column) | Accepted (spec §6.3: autosave desirable, not release-blocking); draft schema keeps the base non-null columns. |
| R5 | **Orphaned upload files remain publicly reachable** (by design — static storage + no retention policy) until A8 is decided | Accepted; cleanup mechanism + quota bound the growth; policy → Batch 8 register. |
| R6 | **Browser E2E still deferred** — no E2E infrastructure in the repo (same posture as Batch 2/3) | Batch 4's critical flows are covered by action-level unit tests + real-DB integration tests (§2); **browser E2E for the portable-speaker listing flow is a tracked pre-invite prerequisite** (spec §10, §12). |
| R7 | **In-memory rate limiter + process-wide body bound are single-instance** (restart resets; no cross-instance protection) | Carried from Batch 2 R1; revisit at multi-instance scale-out. |
| R8 | **`exchange_mine` FK `SetNull`** deferred to finance re-enable (planner rejects FK `onDelete` change; race unreachable today) | Registered follow-up (§6 open residuals #1). |
| R9 | Form banner `lastIntent && state.ok` dead code (defensive) | Cleanup at next form touch. |

### 9.3 Dormant finance paths (defense-in-depth notes — NOT Batch 4 failures; finance re-enable review items)

Behind `assertFinancialFeaturesEnabled()` (Batch 1 boundary — `FINANCIAL_FEATURES_ENABLED=false`
everywhere, §3.1), unreachable with new data today; recorded for the **finance re-enable
review** (full inventory in the Batch 3 verification doc §8.3 + the b4-holistic reports):

1. `resolveDisputeAction`'s order-completion branch — `src/lib/actions/admin.ts` **L374**
   (the plan cited ~L144; lines shifted with the holistic fixes): unconditional single-row
   `Listing … .update({ status: "approved" })` — returns a listing to on-sale **without the
   publication gate**. Same class: the order-cancel path `src/lib/actions/orders.ts` **L544**
   (plan cited ~L373). Both need conditional writes + the `approvedContentAt`/gate treatment
   before finance re-enables.
2. The b4-holistic round-3 hardening already made the reachable-but-dormant **`sold`** claims
   conditional (`orders.ts` L169 `createOrderAction`, `exchange.ts` completeExchange) with
   audit-in-tx — pinned by `tests/unit/finance-dormant-conditional-writes.test.ts` (source
   contract) and recorded in the re-enable checklist §7 of
   `docs/operations/private-beta-finance-shutdown-verification.md`.
3. `exchange_mine` FK `SetNull` (R8 above) + the dormant `exchange.ts` conversation path
   needing the block/suspension guards (Batch 3 §3.2).

### 9.4 Batch 6 follow-ups (current state — the plan's list, updated by the holistic fixes)

- `startConversationAction` accepting non-approved listings — **FIXED in Batch 4**
  (`6e90df7`): new conversations are `approved`-only (`LISTING_NOT_AVAILABLE`); existing
  conversation history stays open regardless of status.
- `toggleWishlistAction` accepting non-approved listings — **FIXED in Batch 4** (`709df21`):
  add is `approved`-only; remove works for any status (stale-entry cleanup); `/wishlist`
  renders redacted placeholders for non-public listings.
- The listing-detail page's legacy `user.role === "admin"` read gate (`app/listings/[slug]/page.tsx:45`)
  — **FIXED in Batch 4** (`7370650`): admin authority now = `session.isAdmin` (MFA login path)
  **+** `capabilitiesOf(adminRole).includes("listing.moderate")`; drafts stay owner-only.
- **Remaining for Batch 6**: the rest of the chat/deal hardening plan (block enforcement on the
  remaining surfaces, suspended/revoked seller checks in deal flows, lightweight Deal, outcome
  UI) — unchanged, owned by the Batch 6 plan.

### 9.5 Deferred items (pointers)

Batch 5 (search normalization/aliases/diacritic search/location filters/telemetry/metric
contracts — incl. commune-level location dataset; Batch 4 stores `communeLevelCode` only) ·
Batch 6 (chat hardening + Deal — §9.4) · Batch 7 (cohort operations/console) · Batch 8 (legal
text / Seller Rules content, founder decision register resolution — §9.1) · draft autosave ·
browser E2E infrastructure (R6) · price intelligence/AI pricing (§13.6/§13.7 — no new price UI;
the model page's "Giá tham chiếu (median)" keeps its sample-size line) · image CDN/S3 move (the
route keeps local storage with the ownership table abstracting it) · account deletion.

---

## 10. Batch 1 / Batch 2 / Batch 3 preservation (Acceptance Gate)

- **Batch 1 preserved:** all finance shutdown suites green unchanged
  (`financial-shutdown-actions` 34, `financial-shutdown-routes` 13, `finance-public-surface` 49,
  `admin-finance-readonly` 21, `mock-payment-guard` 2, `financial-features` 10, `cron-auth`,
  `cron-auto-release-route`, `ipn-route`, `momo`, `ledger`, + `escrow` integration 6);
  `FINANCIAL_FEATURES_ENABLED` still `"false"` everywhere (§3.1); the migration is additive-only
  (§5); no Batch 4 task enabled, bypassed, or weakened a finance boundary; the dormant
  `approved`-setting finance paths are recorded (§9.3), not changed.
- **Batch 2 preserved:** the seller publication gate stays THE single seller-side gate — Batch 4
  wraps and extends it (`assertListingPublishable` calls `assertSellerPublicationAllowed`),
  never re-implements it; `runPublicationGate`/`formatMissingRequirements` Vietnamese text kept
  verbatim for `SELLER_PUBLICATION_BLOCKED`; all four Batch 2 publication transitions keep
  enforcing it after the rewiring; `approveListingAction`'s direct
  `checkSellerPublicationRequirements` call is deleted (§3.1 scan) with the
  `publication_requirements_unmet` + `missing=` audit reason preserved;
  `seller-verification-policy` 32, `seller-verification-actions` 37, `provinces` 20, `rbac`,
  `session`, `audit-event`, `admin-page-guards` suites all green; admin authority is always
  `session.isAdmin` + capability (`requireCapability*`), never `user.role`/`isVerifiedSeller`.
- **Batch 3 preserved (R1–R9):** `listing_status.removed` belongs to Batch 3's migration
  (Batch 4 added only `archived` — R2); `MODERATION_LOCKED_LISTING_STATUSES`/`isModerationLocked`
  guards kept in update/toggle/delete and **extended** to draft/submit (R5) — no hardcoded
  `"removed"`, no raw `.includes` (§3.1); every conditional write kept (CAS `.where({ id, status })`,
  approve/reject pending-only + version-checked) and the new writes conditional too; Batch 3's
  suspension test cases migrated to beta-category fixtures and green; audit names split per C3
  (`moderation.listing_taken_down` vs Batch 4's `listing.*`); `account_not_suspended` is the 8th
  requirement inside `checkSellerPublicationRequirements` and the wrapper inherits it (R6);
  `moderation` 27, `moderation-actions` 61, `listing-lock` 25 + all Batch 3 integration suites
  green; the graph stayed linear with Batch 4 planning `--from` the batch3 dir (R3).
- **Browser E2E** — explicitly deferred (R6): no E2E infrastructure; Batch 4's critical flows are
  covered by action-level unit tests + real-DB integration tests (§2); tracked pre-invite
  prerequisite per spec §10/§12.

---

## 11. Verdict

| Acceptance-gate bullet (spec §9 Batch 4 Gate) | Status |
|---|---|
| Draft behavior (`listing-draft-actions`) | ✅ 43 unit — pre-verification drafts, never public, rate-limited, ownership-validated, R5-guarded, draft-only CAS |
| Publication gate (`publication-gate` + `listing-publication` integration) | ✅ 80 unit + 12 integration (+ race/atomicity/visibility suites) — every transition gated exactly once; approve via `checkListingPublication`; suspended/revoked/cohort blocked everywhere incl. admin approve |
| Invalid-category rejection (`beta-categories`) | ✅ 10 unit — allowlist-only creation, INTO-allowlist changes, grandfathered legacy |
| Conditional fields (`listing-schema`) | ✅ 53 unit — beta full requiredness, legacy existing-rules-only, draft base+optional, caps + grandfathered stored bounds |
| Upload validation (`image-validate` + `upload-route`) | ✅ 15 + 29 unit — early length rejection, magic+decode, quotas/limits/order, stored = re-encode, row-before-file, `/uploads` headers |
| Image security cases (`image-process` + `listing-images` + `uploads-serve-route`) | ✅ 33 + 25 + serve-route — EXIF/GPS stripped, auto-orient, polyglot neutralized, 50MP/12kpx bomb caps, ownership rules 1/2/3, fd-leak-free serving |
| Canonical model selection (`listing-publication` + `beta-catalog-seed` + `catalog-merge-race`) | ✅ 37 unit + 28 + 2 integration — DB-verified model/brand/category, founder-supplied pending seed, race-safe merges |
| Legacy listing compatibility (`legacy-listing-compat`) | ✅ 9 integration — render/edit/resubmit/re-approve unchanged, attached pre-Batch-4 uploads pass, detached rejected (typed), A10 interim |
| Batch 1 preserved | ✅ all finance suites green; `FINANCIAL_FEATURES_ENABLED=false`; additive-only migrations |
| Batch 2 preserved | ✅ gate called (not duplicated), Vietnamese text verbatim, all identity/security suites green |
| Batch 3 preserved (R1–R9) | ✅ `removed`/guards/conditional writes/audit split intact; only `archived` added; guards extended |
| Copy invariants (source scan) | ✅ §3 — no guarantee language outside comments, no location-safety claims, no `dangerouslySetInnerHTML`, no `withMetadata`, `label_serial` blur copy present |
| Preflight (7 gates), integration suite, safe smoke (incl. uploads after start), `npm audit --omit=dev`, diff/status audit | ✅ §4/§5 — nothing skipped |

**GATE PASS.** Every acceptance bullet is green; every source-scan hit is classified (§3); the
three Batch 4 migration packages are additive-only with the one expected
`Listing_status_check_*` DROP+ADD pair (R3) plus the invariant-routed data backfill; the
transaction rule's no-silent-success behavior is proven against the real DB (Task 8 suites +
the race tests); the holistic review rounds are fully landed (§6) with their open residuals
registered. Recorded residuals and the A1/A2/A3/A8/A10/A11 + FD-2 hand-offs go to the
**Batch 8 Founder Decision Register** (§9.1); the finance re-enable blockers (§9.3) are
dormant-code records, not Batch 4 failures. **Batch 4 is accepted.**
