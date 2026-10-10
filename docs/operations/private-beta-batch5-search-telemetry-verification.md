# Private Beta Batch 5 — Search, Location, Telemetry, Metric Contracts Gate Verification (Task 11)

**Date:** 2026-10-08
**Plan:** `docs/superpowers/plans/2026-10-06-private-beta-batch-5-search-telemetry.md` (Task 11 + Acceptance Gate + Final Acceptance Commands)
**Corrections (mandatory, applied):** `docs/superpowers/plans/2026-10-08-private-beta-batch-5-plan-corrections.md`
**Sequencing:** `/tmp/loaviet/b5-seq.md` S1–S11
**Spec:** `docs/superpowers/specs/2026-10-06-private-beta-marketplace-reset-design.md` — §9 Batch 5 + Gate, §10/§10.1, §11
**Worktree:** `Speaker Platform-worktrees/batch5-implementation` (branch `opencode/batch5-implementation`)

> ## ✅ OVERALL VERDICT: **GATE PASS**
>
> Every gate suite, source scan, preflight gate (7/7), integration suite, safe smoke,
> migration review, backfill exercise, and the diff/status audit is green on the final
> state (`e1e0900` + this doc). No blocker was found during gate verification. The
> Task 1 review LOW items (L1/L2/L3) are closed **in this task** (§8). Beta-launch
> readiness **additionally** requires the founder-authored items recorded in §10 —
> per FD-3 they are **launch blockers listed in the Batch 8 Founder Decision Register,
> not Batch 5 gate failures**; this doc must say so verbatim (plan Final Acceptance
> Commands): A1 attribution/response window values, A2 match reconciliation rules,
> A3 return window, A4 bot rules, A5 rate denominators + quality-listing definition,
> A6 retention schedule, A7 alias content, A8 commune registry — plus **FD-2's
> deferred production OTP provider (Batch 2 A1)**. **A9 is resolved by FD-1** (§7)
> and is not a launch blocker.

---

## 1. Commits and executor metadata

**Base:** `d0c0602` — `test(batch4): verify listing quality gate` (the merged Batch 4 gate
commit: Batch 4 + holistic-review fixes + the `approvedContentAt` data-backfill migration).
Batch 5 executed on the merged Batch 4 commit per S1 — verified at Task 1 Step 0 (refs
`db`+`production` == the then-head `66d2193a…`, the `to` of
`20261007T2007_batch4_round4_approved_content_backfill`).

**Final state verified:** `e1e0900` + this doc's commit (Task 11).

```
$ git log --oneline d0c0602..HEAD   (at gate verification; + this doc commit after)

e1e0900 fix(telemetry): silent key no-op recorder + race-safe chat first signals (b5-review T8 ×2 LOW)
da0830b fix(search): sidebar sort select giữ relevance mặc định qua refine (b5-review T7 MEDIUM)
506241b merge: Batch 5 Task 8
d0d8478 merge: Batch 5 Task 7
79fa8b4 feat(search): normalized search, recovery & search telemetry
23e9c5f feat(telemetry): wire funnel events into product surfaces
8bcb6ba fix(admin): no invented median on empty seller listing card
1c0c234 merge: Batch 5 Task 10
54b10a8 merge: Batch 5 Task 4
3cf009e feat(search): maintain normalized listing search text
57c4fb7 feat(admin): private-beta analytics dashboard
807500a fix(search): seed-search-aliases retarget update-in-place + AUDIT count … (b5-review T5 ×2)
26499dd fix(metrics): bind click actor vào session actor (CTR + searchToChat …) (b5-review T9 ×2)
ecffd06 test(metrics): pin anchor view đầu của unit listingToChat + multi-credit per-session searchToChat (D3) (b5-review T9)
d4e0b5a test(telemetry)+docs: pin seam emit sessionId thô cho Task 7/8 … (b5-review T6)
bedb259 test(search): seed-search-aliases — pin guard NODE_ENV=production … (b5-review T5 SPLIT)
6c3fcf2 fix(ops): backfill-listing-location guard --allow-production … (b5-review T2 HIGH + SPLIT)
5be44f7 merge: Batch 5 Task 9
713e9b8 merge: Batch 5 Task 6
85831a0 merge: Batch 5 Task 5
7b821a3 merge: Batch 5 Task 2
bb5c756 feat(location): canonical province source with legacy preservation
f0ceb44 feat(telemetry): product event taxonomy with PII rejection
55f01e1 feat(search): alias resolution mechanism
fefe563 feat(metrics): versioned metric contracts with fixture reconciliation
6c66426 fix(ci): restore npm 10 lockfile entries
20a4c0c feat(db): add batch 5 search, location & telemetry contract
285f087 feat(search): diacritic-insensitive normalization module
7972a5c docs(plan): batch 5 corrections from re-review against real code
```

Task feature commits (plan's exact messages): `285f087` (T3, early cherry-pick per the
approved G1 deviation), `20a4c0c` (T1), `bb5c756` (T2), `55f01e1` (T5), `f0ceb44` (T6),
`fefe563` (T9), `3cf009e` (T4), `57c4fb7` (T10), `79fa8b4` (T7), `23e9c5f` (T8) — plus
`7972a5c` (the corrections doc), `6c66426` (CI lockfile fix: restores npm-10-format
lockfile entries so `npm ci` keeps working on Node 22/npm 10 — **no dependency version
changes**: `git diff d0c0602..HEAD -- package.json` is empty; the lockfile diff adds the
nested `node_modules/@prisma/composer/node_modules/@types/node` dev entry npm 10
requires), 8 review-fix commits (§9), and 6 merge commits from the parallel-worktree
integration. Task 11 adds the L1/L2/L3 closure + this doc.

**OpenCode metadata:** model `home-gateway/OneNexus/glm-5.3` (OneNexus GLM 5.3), session
in this worktree — "Batch 5 Task 11: gate verification + verification doc". Task
reports (per-task sessions, all on this branch):
`/tmp/loaviet/batch5-task{1,2,3,4,5,6,7,8,9,10}-report.md`,
`/tmp/loaviet/batch5-fix1-report.md` (Tasks 2/5/6/9 review round),
`/tmp/loaviet/batch5-fix3-report.md` (Tasks 7/8 review round). No push / merge to
main / deploy / subagents at any point; every `git add` listed explicit paths.

---

## 2. Gate-suite results (Step 1 — all green, run 2026-10-08 on `e1e0900`)

The ten Batch 5 gate items (spec §9 Batch 5 Gate) mapped to the plan's named suites:

| # | Gate item (spec §9) | Suite | Result |
|---|---|---|---|
| 1 | Diacritic tests (incl. `đ`/`Đ`, spacing variants) | `tests/unit/search-normalize.test.ts` | **PASS 18/18** |
| 2 | Alias tests (exact/spacing/**compact** B6, catalog fallback S-3, no raw query in output, seed idempotent S9) | `tests/unit/search-resolve.test.ts` | **PASS 31/31** |
| 3 | Location-filter tests (unit; CITIES ⊆ registry drift guard) | `tests/unit/location.test.ts` | **PASS 29/29** |
| 4 | Unknown legacy-location migration tests (integration: backfill cases, Batch-4-row B3, `city` byte-identical) | `tests/integration/listing-location.test.ts` (via `npm run test:integration`) | **PASS** (in the 220 below) |
| 5 | Diacritic/location integration (real `simple` GIN index, "loa do" stopword pin S-1, permuted-province no-boost) | `tests/integration/search.test.ts` (via `npm run test:integration`) | **PASS** (in the 220 below) |
| 6 | Event-schema validation + PII rejection (incl. 1000-random-UUID never-rejected B8) | `tests/unit/product-events.test.ts` | **PASS 44/44** |
| 7 | Zero-result + CTR + listing→chat + response-metrics fixture reconciliation | `tests/unit/metrics-reconciliation.test.ts` | **PASS 34/34** |
| 8 | Metric-contract registry structural gate (8 contracts, pending sentinels, unbounded `search_to_chat_v1` S-16) | `tests/unit/metric-contracts.test.ts` | **PASS 17/17** |
| 9 | Funnel emission + finance-emission source scan (S7) | `tests/unit/telemetry-wiring.test.ts` | **PASS 50/50** |
| 10 | No-boost plan structure + emission/rate-limit/prefetch unit gate; dashboard capability guard + pending-state honesty | `tests/unit/search-query.test.ts` + `tests/unit/search-telemetry.test.ts` + `tests/unit/analytics-dashboard.test.ts` | **PASS 37/37 + 28/28 + 25/25** |

Full-suite context (every earlier batch stays green unchanged — S1/S5):

| Command | Result |
|---|---|
| `npm test` (full unit) | **PASS — 87 files / 1804 tests** (Batch 1 finance shutdown, Batch 2 identity/security, Batch 3 trust/safety, Batch 4 listing quality, all Batch 5 suites; `admin-page-guards.test.ts` green — the new `/admin/analytics` page is enumerated and guarded) |
| `npm run test:integration` (`scripts/test-integration.sh`, scratch container, migrate `--to production`) | **PASS — 26 files / 220 tests** (incl. `batch5-migration` 18 — with the new L1 test, `listing-location`, `search`, `escrow`, `batch2/3/4-migration`, `admin-bootstrap`, block/suspension enforcement, seller verification, report evidence, publication/delete race, catalog seed, legacy compat) |
| `npm run lint` | **PASS** — 0 errors, 0 warnings |
| `npx next typegen` + `npx tsc --noEmit` | **PASS** — clean |
| `npm run build` | **PASS** — exit 0, 15/15 static pages, `/admin/analytics` registered `ƒ (Dynamic)`; **1 pre-existing warning only** (`instrumentation.ts:27` `process.exit` Edge Runtime — Batch 2 commit `b8e1c85`, untouched by Batch 5) |
| `npm run preflight` | **PASS — 7/7 gates** (contract-emit-drift, lint, typecheck, unit-tests, production-build, compose-config, migration-graph) |
| `npm run smoke` | **SMOKE PASS** — production standalone server on scratch DB: health `200 db=up`, every finance entry point denies typed, 9 retired finance pages 404, cron wrong-secret 401 / correct-secret 503 typed, momo return 500 unavailable |
| `npm audit --omit=dev` | **1 pre-existing high** — `next@16.3.7` advisories (6 GHSA ids, worst: GHSA-3w37-wq28-93x7 Draft-Mode `use cache` leak; fix = `next@16.4.0`, outside the pinned range). Batch 5 adds **zero** npm packages and `package.json` is unchanged across `d0c0602..HEAD` — the finding is dependency hygiene inherited from the base, **recorded for the Batch 8 register** (same posture as Batch 2's source-map-js entry; a version bump is an ops decision, not a Batch 5 change) |
| `npx prisma migration list` | **Linear graph, 7 migrations**: `baseline → batch2 → batch3 → batch4_listing_quality → batch4_holistic_review_fixes → batch4_round4_approved_content_backfill (self-edge) → batch5_search_telemetry`; refs `db` + `production` both at the batch5 head `1350a596…`; **no node with two outgoing edges** (S2) |
| `npx prisma db verify` (dev DB, container `speaker-postgres` :5435) | **ok: true, mode: full** — marker + schema match contract `1350a596…` |
| `npx prisma contract emit` → `git status src/prisma/` | **0 drift** (storageHash `1350a596…` unchanged) |
| `git diff --check` + `git status --short` | clean; only the Task 11 files (§8) — no `.claude/settings.json`, no `public/uploads/`, no secrets, no scratch, `package-lock.json` untouched by Task 11 |

---

## 3. Backend-enforcement + privacy source scans (Step 2 — every hit classified)

`rg` (ripgrep) at the repo root, run 2026-10-08 on `e1e0900`.

### 3.1 Finance modules never emit telemetry (S7 — Review Focus 2)

```
rg -n "ProductEvent|emitProductEvent" src/lib/actions/orders.ts src/lib/escrow.ts \
     src/lib/wallet.ts src/lib/ledger.ts src/lib/momo.ts src/lib/mock-payment.ts
→ 0 hits ✅
```

The dormant finance path (`orders.ts` sold transition) emits nothing;
`listing_marked_sold` emission lands with Batch 6's beta sold transition (S7 forward
seam). Pinned permanently by `tests/unit/telemetry-wiring.test.ts` (finance
source-contract case).

### 3.2 Batch 5 telemetry modules write no AuditEvent (S10)

```
rg -n "AuditEvent|auditEvent" src/lib/product-events.ts src/lib/telemetry-recorders.ts \
     src/lib/search-telemetry.ts src/lib/metrics.ts src/lib/metric-contracts.ts
→ 0 hits ✅
```

Product telemetry and security/audit stay separate domains; `ProductEvent` names are
disjoint from the Batch 3/4 audit registries (Task 6 taxonomy, pinned by
`tests/unit/product-events.test.ts`).

### 3.3 Dashboard authorization (spec §4.5)

```
rg -n "requireCapability|requireAdminUser" app/admin/analytics/page.tsx
→ :2 import { requireCapability } from "@/src/lib/rbac";
  :32 guard comment (server-side, before every db read)
  :318 await requireCapability("analytics.read");
```

`requireCapability` **throws `FORBIDDEN`** (corrections #18 — `rbac.ts:141`), it does
not redirect; the call precedes the first `db.orm.` read (pinned by
`tests/unit/analytics-dashboard.test.ts` source-contract guard). Nav filtering in
`app/admin/layout.tsx` is convenience only (`capabilitiesOf`, Batch 2 Task 9 pattern).

### 3.4 Location neutrality — trust language (spec §4.7)

```
rg -n "an toàn|bảo đảm|đảm bảo|guarantee" src/lib/location.ts app/listings/page.tsx \
     app/admin/analytics/page.tsx src/lib/search-query.ts
→ 0 hits ✅
```

No UI copy describes a location as safe/guaranteed/verified; priority-market chips use
the operational label `Khu vực beta trọng điểm` (via `betaMarketLabel()`); no
priority-location relevance boost without buyer preference (structural plan test +
permuted-province integration test, Task 7).

### 3.5 `FINANCIAL_FEATURES_ENABLED` stays `false` (Batch 1 preserved)

```
rg -n "FINANCIAL_FEATURES_ENABLED" .env.example docker-compose.prod.yml scripts
→ .env.example:46 "false" · docker-compose.prod.yml:123 "false" ·
  scripts/smoke.sh:12,116,223 (comment + export "false" + comment) ·
  scripts/docker-smoke.sh:90 (comment "false")
```

All `"false"` ✅. Every Batch 1 finance suite re-ran green in §2 (full unit +
integration + smoke finance checks).

### 3.6 Rejection logging carries no payload (correction #17)

```
rg -n "captureError|captureEvent" src/lib/product-events.ts
→ :383 TELEMETRY_KEY_UNAVAILABLE · :433 TELEMETRY_SCHEMA_REJECTED · :446/:458
  TELEMETRY_PII_REJECTED · :471 TELEMETRY_SCHEMA_REJECTED · :498
  TELEMETRY_INTERNAL_LOOKUP_FAILED · :525 TELEMETRY_EMIT_FAILED · :548
  TELEMETRY_COHORT_READ_FAILED
```

Every call site inspected: payloads are `{ name, rule }` (event name + violated rule)
or `{ name, sqlState }` (db failures log **sqlState only** via `SqlQueryError.is()` —
never `error.message`/stack, which could carry payload data). No `captureEvent` with
event payloads anywhere in the telemetry domain. Pinned by
`tests/unit/product-events.test.ts`.

### 3.7 `server-only` present, `"use server"` never (S-13)

```
rg -n "server-only" src/lib/product-events.ts src/lib/telemetry-recorders.ts \
     src/lib/search-telemetry.ts src/lib/search-query.ts src/lib/search-resolve.ts
→ import "server-only" at line 1 of each ✅

rg -n "use server" <same files + metrics.ts metric-contracts.ts location.ts
     search-normalize.ts product-event-key.ts>
→ 3 hits — ALL comment lines documenting the S-13 rule (product-events.ts:46,
  telemetry-recorders.ts:11, search-telemetry.ts:50) — no directive ✅
```

`src/lib/product-events.ts` is a plain server module (exportable constants + async
functions, no server-action exposure); the offline scripts import only plain
sub-parts (`product-event-key.ts`, `search-normalize.ts`, `provinces.ts`,
`location.ts` — no db, no `server-only`). Pinned by source-contract tests in
`tests/unit/product-events.test.ts` + `tests/unit/search-resolve.test.ts`.

### 3.8 Raw search-query text / PII never persisted (spec §4.8 — Review Focus 1)

```
rg -n "rawQuery|queryText|searchText" src/lib/search-telemetry.ts src/lib/telemetry-recorders.ts
→ 0 hits ✅
```

`search_submitted` metadata carries only structured facets (validated slugs, result
count, `resultListingIds` ≤ 60); `search_zero_result` the demand record; resolution
output (`resolveSearchQuery`) is only id/variant arrays. Pinned by the Task 6 PII
suite (email/phone/OTP/IP-shape rejection in free string fields, denylisted keys,
1000-random-UUID never-rejected B8, no schema has a free-text/query field) + Task 7
key/value scans + this re-scan.

---

## 4. Migration review (Step 4 — additive-only, S2/S3)

- **Graph:** `npx prisma migration list` = the linear 7-migration walk (§2); refs
  `db` + `production` == batch5 `to` `1350a596…`; no node with two outgoing edges.
- **Ops:** `npx prisma migration show migrations/app/20261007T2208_batch5_search_telemetry`
  → **17 operations, ALL `additive` — 0 destructive, 0 data transforms** (re-verified
  at Task 11; also pinned by `tests/integration/batch5-migration.test.ts` "migration ops"
  case which asserts every destructive-class op matches the `Listing_status_check_*`
  pattern — there are none).
- **The `Listing_status_check_*` DROP+ADD pair did NOT render** — correct per S2's
  "expected *if* the planner touches it": Batch 5 adds no `listing_status` values
  (S3), so the enum-adjacent CHECK was not re-rendered. Had it rendered, it would be
  the tolerated additive-in-effect pair; its absence is the expected outcome.
- **S3 ownership verified:** the only `column.*` ops are
  `column.public.Listing.locationSource` + `column.public.Listing.searchTextNormalized`;
  new tables `ProductEvent` + `SearchAlias` (+ back-relations); enums
  `listing_location_source` + `search_alias_target`. No Batch 4 location column, no
  finance model, no Batch 3 moderation table touched.
- **Lock behavior (Task 1 review L3 — runbook note added, §8):** the migration touches
  the live `Listing` table with two write-blocking ops (validated ADD CHECK
  `Listing_locationSource_check` + non-concurrent GIN `listing_search_text_search`);
  fine at beta size, documented for large tables in `docs/runbook.md` §2.
- **`db verify`** clean on dev (§2); the scratch-container run migrates `--to production`
  (7 migrations incl. the round4 self-edge — proven by the L2 test, §8.2).

---

## 5. Backfills + alias seed — dry-run / apply / idempotency (Step 4, dev DB)

Run 2026-10-08 against the dev DB (container `speaker-postgres`, `localhost:5435/
speaker_platform`, marker at `1350a596…`, 12 listings — all `approved`, all legacy
`city` text, no Batch-4-coded rows, 0 aliases). Scripts print the target host/db only,
never the password.

### 5.1 `scripts/backfill-listing-location.ts` (B3 rollback input recorded)

| Run | Output |
|---|---|
| dry-run (default) | `quét (locationSource IS NULL): 12` · `đã xong từ trước: 0` · `legacy_mapped: 12` · `unresolved: 0` · `seller_declared: 0` |
| `--apply` | same counts, written · **`declaredIds (rollback input — B3): (none)`** — dev has no Batch-4-coded rows, so the rollback's second statement is a no-op here |
| second `--apply` (idempotent) | `quét: 0` · `đã xong từ trước: 12` · `legacy_mapped: 0` → **0 rows changed** ✅ |

All 12 dev rows mapped through the FD-1 rule (legacy `city` values that equal registry
legacy names after normalize); `"Khác"`/district/typo → `unresolved` (0 on dev — the
seed's city values are all registry names). **Rollback procedure (B3, documented in the
script header):**
`UPDATE "Listing" SET "provinceLevelCode" = NULL, "locationSource" = NULL WHERE "locationSource" IN ('legacy_mapped', 'unresolved')`
(both fields were backfill-written on those rows) **then**
`UPDATE "Listing" SET "locationSource" = NULL WHERE id IN (<declaredIds>)` —
**locationSource only** on seller-declared rows: their code is Batch 4's data and is
never nulled. Production runs via the migrate service with `--apply
--allow-production` (guard from target + `NODE_ENV` — b5-review T2 HIGH fix `6c3fcf2`).

### 5.2 `scripts/backfill-listing-search-text.ts` (S-4 — derived, no rollback)

| Run | Output |
|---|---|
| dry-run | `quét: 12` · `would-be ghi: 12` · `bỏ qua: 0` |
| `--apply` | `đã ghi: 12` |
| second `--apply` (idempotent) | `quét: 0` · `đã ghi: 0` · `bỏ qua: 12` → **0 rows changed** ✅ |

No rollback needed — the column is derived (`normalizeSearchText(title + brand.name +
model.name)`), always recoverable by re-running the backfill / `--recompute-all`
(staleness procedure after `seed-beta-catalog --apply` or any `/admin/catalog` edit/
merge — `mergeModelAction` leaves text stale — documented in `docs/deployment.md` §2
step 5c + `docs/runbook.md` §2, corrections #14: **mandatory right after migrate** —
rows with NULL text are unsearchable by the Task 7 page which matches
`searchTextNormalized` exclusively).

### 5.3 `scripts/seed-search-aliases.ts` (S9/A7 — empty/founder-reviewed content)

| Run | Output |
|---|---|
| dry-run (no `--aliases`) | `created=0 planned=0 existing=0 retargeted=0` |
| `--apply` (no `--aliases`) | `created=0 planned=0 existing=0 retargeted=0` |

**Content state: EMPTY** — the mechanism ships with a zero-row `SearchAlias` table
(dev verified: 0 rows); the seed accepts only founder-supplied content
(`--aliases <founder.json>`, schema in the script header, ≤ 500 items, validated
fail-closed, update-in-place retarget with AUDIT count — b5-review T5 fix `807500a`).
Alias catalog content belongs to Batch 4's canonical model seed / Batch 8's model-seed
review (**A7 — Batch 8 register**).

### 5.4 Dev DB post-state

`locationSource NULL: 0` · `searchTextNormalized NULL: 0` · `legacy_mapped: 12` ·
`SearchAlias: 0 rows` — dev is fully backfilled and searchable.

---

## 6. Threat-case coverage (spec §10.1 rows applicable to Batch 5)

| Abuse case | Covered by |
|---|---|
| Privilege escalation / Support → admin escalation | `/admin/analytics` `analytics.read` server-side guard (Batch 2 matrix: super_admin/operations_admin/analyst) + `tests/unit/analytics-dashboard.test.ts` source-contract + `admin-page-guards.test.ts` auto-enumeration |
| Listing IDOR | Search/detail surfaces only `SEARCHABLE_LISTING_STATUSES = ["approved"]` listings (S6 drift test enumerates every `listing_status` from the contract); `?ss=` attribution validates existence + result-set membership and grants nothing (S-14) |
| Stored XSS through listing | Search results + recovery UI render listing text through React escaping only; no `dangerouslySetInnerHTML` added (verified in this review — `rg "dangerouslySetInnerHTML" app src` → 0 hits in Batch 5 surfaces); React escaping is the repo posture |
| CSRF state-changing action | Telemetry inserts are append-only analytics rows from page renders/route handlers, not user-visible state; server actions stay POST-only with origin protection (Batch 2 posture, re-recorded here) |
| Suspended-user publication bypass / beta-cohort bypass | Not Batch 5 surfaces — Batch 3's R5 guards + Batch 4's publication wrappers untouched (S5) and their suites re-ran green; Batch 3 decided suspended sellers keep live listings → no suspension filter in search (S6) |
| Blocked-user chat bypass | Batch 3's guards run before Batch 5's emission in `startConversationAction`/chat POST (S5) — the wiring tests assert no emission when the guards reject |
| Financial direct route / API mutation / webhook / cron | Batch 1 suites re-ran green (§2); Batch 5 adds no finance surface; the finance-emission source scan (§3.1 + Task 8 test) proves telemetry never grows a finance path (S7) |
| Historical finance escape-hatch abuse | Untouched; `orders.ts` sold transition explicitly NOT wired to telemetry |

---

## 7. FD-1 / A9 resolution record (spec §8.3 + §8.6)

- **The canonical province registry is the 34 provincial units per NQ 202/2025/QH15**
  (founder-approved source `/tmp/loaviet/provinces-34.md`), shipped as the plain module
  `src/lib/provinces.ts` by **Batch 2 Task 10** (stable slug codes, `displayName`,
  `kind`, merged legacy units). Batch 5 **only consumes it read-only** — never
  creates, edits, or duplicates it (FD-1; file-conflict rules).
- **The legacy mapping rule (bottom of `provinces-34.md`) is authoritative:** a legacy
  free-text value maps only when it equals — after NFC + trim + case-fold +
  diacritic-insensitive compare (incl. `đ`/`Đ`) + whitespace collapse + common-prefix
  strip (`Tỉnh`/`TP.`/`Thành phố`) — one of the registry's **authoritative legacy unit
  names**. Merged legacy names map to the new unit (`"Bình Dương"` → `ho-chi-minh`,
  `"Hải Dương"` → `hai-phong`, `"Quảng Nam"` → `da-nang`, …) — **applying the founder's
  source, not guessing** (spec §8.3 satisfied by the authoritative source). `"Khác"`,
  district/ward names, typos → the explicit `unresolved` state; never fabricated.
- **Implementation:** `resolveLegacyLocation` (`src/lib/location.ts`) **delegates** to
  the registry's `resolveLegacyProvince` (`src/lib/provinces.ts:152`) — the whole
  normalize/compare lives once in the registry (corrections #1); no private normalizer,
  no hand-authored per-city table, no runtime name equality against display names.
  Pinned by `tests/unit/location.test.ts` (every `CITIES` entry's outcome through the
  FD-1 rule; merged-legacy-name table; delegation test) +
  `tests/integration/listing-location.test.ts` (backfill cases: unmatched stays
  `unresolved`, `city` byte-identical before/after, **a Batch-4-created row with a
  valid code is `seller_declared` and never overwritten** — B3).
- **Registry legacy-name gap raised, not patched:** `"Thừa Thiên Huế"` (the pre-2025
  name of Huế) is **not** in the shipped registry's legacy names for `hue` (only
  `"Huế"` matches; `tests/unit/provinces.test.ts:15` pins `null`) — legacy rows with
  that spelling resolve `unresolved`. **Founder data gap → Batch 8 register** (Batch 5
  never patches Batch 2's registry file). The plan's original
  `"Thừa Thiên Huế" → hue` example is superseded by the corrections doc (#1).
- **A9 is RESOLVED by FD-1** and is not a launch blocker. Batch 4 A9 / Batch 5 A9 /
  Batch 5 B4 are resolved by the same decision.

---

## 8. Task 1 review LOW items — closed in this task (L1/L2/L3)

The Task 1 adversarial review left three LOW items assigned to Task 11. All three are
closed by this task's commit:

### 8.1 L1 — pre-Batch-5 row survival integration check ✅

`tests/integration/batch5-migration.test.ts` gains
`"pre-Batch-5 row survives the batch 5 migration (b5-review T1 L1)"` (1 test, green in
the 220): a **second database** (`speaker_b5_l1`) is created inside the same scratch
container (the `speaker` user is the container superuser; raw lane
`CREATE DATABASE`), then:

1. `prisma db migrate --db <l1> --to 20261007T2007_batch4_round4_approved_content_backfill`
   — the **pre-Batch-5 head** (dir-name target: `requiredInvariants` empty → the
   self-edge backfill does **not** run here; marker `66d2193a…`);
2. seed 2 Listings (`approved` + `draft`) via **raw SQL** (the ORM contract is
   batch-5-shaped — columns that don't exist yet at the old head; raw SQL touches only
   old-head columns);
3. capture `row_to_json` (every column) — BEFORE;
4. `prisma db migrate --db <l1> --to production` — the path walk from the
   `66d2193a…` marker **must traverse the round4 self-edge** (the production ref
   declares the invariant the marker lacks) → backfill runs + batch5 applies
   (`applied dirs = [round4, batch5]` — asserted);
5. capture AFTER + the marker.

**Assertions:** `locationSource` NULL + `searchTextNormalized` NULL on both rows (S3);
exactly 2 new keys appear; **every other column byte-identical** — with one asserted
exception: `approvedContentAt` on the `approved` row = its pre-migration `updatedAt`
(**the Batch 4 backfill's intended data op on the self-edge — not a Batch 5 effect**;
the `draft` row is untouched by it, `WHERE status='approved'`). Marker ends at the
production ref hash with the invariant recorded (idempotency mechanism).

### 8.2 L2 — production path from `@empty` includes the backfill self-edge ✅

`tests/unit/approved-content-backfill-migration.test.ts` gains
`"production path từ @empty GỒM self-edge backfill (b5-review Task 1 L2 — path walk
thật)"` (green in the 1804): runs the **CLI's own path walk** —
`npx prisma db migrate --show --from @empty --to production` (offline: graph on disk,
no DB connection — verified to run without `DATABASE_URL`) — and asserts the exact
7-migration path `baseline → batch2 → batch3 → batch4 → holistic → round4 self-edge →
batch5`, the self-edge's `from == to`, and the path's end == the production ref hash.
This pins the deploy-risk **through the real `findPathWithDecision`** (not a
re-implementation): if a future `migration ref set` writes `invariants: []` again (the
exact failure Task 1 §4.4 caught — commit `194f65a` precedent), the round4 backfill
falls out of the path and this test fails immediately. The existing artefact-level
test (invariantId + providedInvariants + ref declaration) remains alongside it.

### 8.3 L3 — runbook lock note ✅

`docs/runbook.md` §2 (Release) gains the lock-behavior note: the Batch 5 migration
touches the live `Listing` table with **two write-blocking ops** — a **validated ADD
CHECK** `Listing_locationSource_check` (full-row validation scan under SHARE lock; the
new column is all-NULL so the scan is fast) and a **non-concurrent GIN index**
`listing_search_text_search` (`CREATE INDEX … USING gin (to_tsvector('simple',
"searchTextNormalized"))` — build blocks writes for its duration). The
`search_alias_target_ids` CHECK is **not** a concern (inside `createTable` of the new
empty `SearchAlias`). Fine at beta size (milliseconds; the migrate service runs before
app start so no request waits); at ~100k+ rows, split into a hand-authored migration
with `CREATE INDEX CONCURRENTLY` + `ADD CONSTRAINT … NOT VALID` then
`VALIDATE CONSTRAINT` (per the prisma-8 migrations reference), off-peak.

---

## 9. Independent reviews — findings → decisions/commits (2-skeptic adversarial verification)

Every Batch 5 task was independently reviewed (2 adversarial verifiers per finding);
review fixes were committed with TDD evidence. **Dispositions:**

### 9.1 Round 1 — Tasks 2/5/6/9 (`/tmp/loaviet/b5-review-findings.md`, 11 findings → `batch5-fix1-report.md`)

| Finding | Disposition | Commit |
|---|---|---|
| T2 HIGH — backfill `--apply` has no production/non-local guard | **FIXED** — ported the `seed-beta-catalog` posture: target-based refusal (`BACKFILL_REFUSED_NONLOCAL`) + `NODE_ENV=production` belt (`BACKFILL_REFUSED_PRODUCTION`), `--allow-production` opens both, dry-run never guarded; docs updated | `6c3fcf2` |
| T2 LOW — seller_declared CAS doesn't re-check the scanned code | **FIXED** — `.where({ provinceLevelCode: row.provinceLevelCode })` added to the CAS (concurrent legacy edit → 0 rows → `alreadyDone`; no `seller_declared` row with NULL code can enter `declaredIds`) | `6c3fcf2` |
| T5 MEDIUM — seed skips an existing `(alias, target)` row pointing at a different target (founder retarget never applies) | **FIXED as update-in-place + AUDIT count** (not conflict-error): A7 says the founder file is reviewed content — the DB must match it after `--apply` (declarative sync); dry-run reports `retargeted=N` **before** any mutate, apply prints an AUDIT line, new target still fail-closed `SEED_ALIAS_TARGET_MISSING` pre-mutate; `(alias, target)` key unchanged → no partial write | `807500a` |
| T5 LOW — no test pins the `NODE_ENV=production` refusal on a local-looking DB | **FIXED** — 3 tests (`SEED_REFUSED_PRODUCTION`, tx uncalled; `{allowProduction:true}` proceeds; dry-run allowed) | `bedb259` |
| T5 LOW — 3 uncapped full-table loads per search | **NO-CHANGE with evidence** — plan L588 explicitly accepts per-search catalog loads at beta scale (noted in code); the alias full load is **required by compact matching** (`compactForm` is computed in TS; the query builder cannot express it; adding a compact column = schema change outside S3); `.take(N)` would silently break resolution on founder-reviewed content; cache TTL = invalidation complexity for a small accepted table. **Pinned** by a source-contract test that requires the scale note + the pointer to this doc | `807500a` |
| T6 LOW — `pseudonymKeyVersion` is a constant, not tied to the key | **NO-CHANGE with evidence** — plan L622/L705 pin exactly this design (`"1" — bump khi rotate key`); the rotate procedure (change env **and** bump KEY_VERSION **in the same deploy**) is documented in the module header + `.env.example` + `docs/deployment.md`; deriving a version from a key fingerprint would be a new design outside plan/corrections. **Pinned** by the existing version-written-per-row test | `d4e0b5a` |
| T6 LOW — emit core takes raw `sessionId` but plan Tasks 7/8 text said `sessionPseudonym` | **NO-CHANGE — seam recorded** — the emit core matches its own contract (plan L650: `sessionId?: string`); the mismatch was only in the plan text for tasks not yet implemented. Seam decision: **Tasks 7/8 must pass the RAW `getCurrentUser().sessionId`** — a precomputed pseudonym would double-HMAC → the same session would have two `sessionPseudonym` values → broken Task 9/10 joins. **Pinned** by a source-contract test (input has `sessionId?`, never `sessionPseudonym?`, exactly one HMAC layer) | `d4e0b5a` |
| T9 MEDIUM — click→session join doesn't bind the click actor (copied `?ss=` inflates CTR/search_to_chat) | **FIXED in the engine** — Review Focus 7's threat includes **copied** ss (emission-side checks only block **fabricated** ss); plan L919's own expectation says forged/copied ss must not manufacture CTR. `searchResultCtr` + `searchToChat` now require `click.actorPseudonym === session.actorPseudonym` (anonymous `null===null` still bound — pseudonymity limit, recorded); contract `inclusionRules` declare the binding; old fixtures (same-actor clicks) unchanged | `26499dd` |
| T9 MEDIUM — `listingToChat` anchors the dedup window at the first view (revisit+late chat dropped) | **NO-CHANGE with evidence** — plan L1104 prescribes exactly the first-view anchor (`conversationStartedAt >= viewedAt && <= viewedAt + windowMs`); spec §5.8.1 fixes only "viewer + listing + attribution window" dedup, not the anchor. Reversible reading — flip together with A1 when the founder picks the production window. **Pinned** by a revisit+out-of-window fixture with plan/spec citations | `ecffd06` |
| T9 MEDIUM — no as-of cutoff (units whose window hasn't closed count in the denominator) | **NO-CHANGE with evidence (4 reasons)** — spec §5.8.1 has no as-of/maturity/censoring concept (adding one = inventing a metric definition, §4.11); A1 keeps the window values `PENDING_FOUNDER_DECISION` so the dashboard renders these two metrics in a named pending state, never a number (the finding's dashboard scenario cannot occur); the engine interface is pinned (`{ windowMs } & MetricOpts` — no `asOf`); maturity semantics belong to the founder's A1 window decision. **Pinned** by immature-unit fixtures with the bias documented in comments | `26499dd` |
| T9 LOW — `searchToChat` multi-credits every clicked session + O(sessions×clicks) join | **NO-CHANGE with evidence** — D3 (plan L1294) counts **per session** ("a search session counts when a click on L is followed by a conversation for the same actor on L"); spec §5.8.1's numerator is session-centric ("sessions that eventually produce…"); 3 refine-sessions + 1 conversation → numerator 3 **is the specified behavior** (no single/last-touch attribution exists in spec/plan). O(s×c) sits inside the accepted P0 full-scan shape (plan L62/L1138). **Pinned** by a 3-session fixture citing D3 + spec, marked reversible to last-touch | `ecffd06` |

### 9.2 Round 2 — Tasks 7/8 (`/tmp/loaviet/b5t78-findings.md`, 3 findings → `batch5-fix3-report.md`)

| Finding | Disposition | Commit |
|---|---|---|
| T7 MEDIUM — sidebar GET form always submits `sort=newest`, silently dropping relevance after any refine | **FIXED** — default option with **empty value** (`"Phù hợp nhất"`) first in the select + `defaultValue = sidebarSortSelectValue(sp.sort)` (new pure helper): the form carries only an **explicitly chosen** sort; empty/`"relevance"`/unknown → `sort=''` → server derives (`hasQuery → relevance`, browsing → newest). Fixes both scenarios the finding named (header-search refine AND direct sidebar keyword). `search_submitted` now records the real sort. Red→green: 9 failing tests first (render test on the real page element tree + helper round-trips) | `da0830b` |
| T8 LOW — `recordSellerFirstListingPublished` logs an error on every approval when the telemetry key is unset (breaks correction #9's silent no-op) | **FIXED** — new `productEventKeyAvailable(eventName)` helper (one source of semantics: outside production → `false` **silent**; production → `false` + one typed `TELEMETRY_KEY_UNAVAILABLE`); the emit core's key gate refactored through the same helper (behavior identical — parity pinned by the 3 existing key tests); the recorder gates **before** computing any pseudonym. Red→green: 2 failing tests (assert `captureError` not called outside production; exactly one typed log in production) | `e1e0900` |
| T8 LOW — two tabs sending concurrently drop `conversation_buyer_first_message` / `message_first_response` entirely (0 events) | **FIXED as position-based detection** (not "tolerate duplicates + dedup in metrics" — the race **drops** events, and a lost conversation can't be recovered by metric dedup; D4's contracts already dedup by conversationId, so residual duplicates can't skew either — two-layer defense, documented in the route): "first" is decided by **position in the total order** (`createdAt asc, id asc` tie-break) — the request holding the first message always sees itself first (single-statement autocommit insert + its own later query), the racing request sees the first message in its READ COMMITTED snapshot → skips → exactly one emit. Red→green: 2 concurrent tests (`Promise.all` double-POST) failing 0-events before | `e1e0900` |

### 9.3 Other in-task review fixes (committed within their task rounds)

- `8bcb6ba` — Task 10 review: no invented median on the empty seller-listing card
  (median of zero listings renders a named empty state, never a fabricated number).
- `d4e0b5a` also carries the `.env.example` rotate-procedure note (key rotation requires
  bumping `KEY_VERSION` in the same deploy).
- Task 1's own review produced the §4.4 production-ref invariant restore (in `20a4c0c`
  lineage) + the stale Batch 4 test-pin update (§4.5 of the Task 1 report) — the LOW
  items L1/L2/L3 are closed by this task (§8).

**Every no-change decision above is pinned by a test** (characterization /
source-contract / fixture with citations) — per the review protocol "fix with a test OR
record a reasoned no-change with plan/spec citations (pinned by a test where it documents
behavior)". All 14 disposition commits re-ran the full gate set green (fix-round reports
§2).

---

## 10. Residual risks (recorded — accepted at P0, revisited post-beta)

| # | Residual risk | Status / mitigation |
|---|---|---|
| R1 | **In-memory rate limiter topology** (search `SEARCH_RATE` 60/60s + the shared `src/lib/rate-limit.ts`): single instance only, restart resets, no cross-instance protection; `TRUST_PROXY_HEADERS=false` (default) → every anonymous visitor shares the `search:ip:local` bucket — **CGNAT puts many real users in one bucket** (under-throttling for abusers, over-throttling for shared-IP victims). Same caveat as every existing limit (Batch 2 R4 posture). | Accepted (repo topology = one instance); recorded in `search-telemetry.ts` header; Batch 8 register |
| R2 | **Render-time emission double-count** (prefetch renders emitting `listing_viewed`/`search_submitted`): `next-router-prefetch` is **stripped by the Next 16 Proxy for RSC requests** (verified `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md` ~L474 — the header check is best-effort only). The **deterministic** anti-double-count guard is `prefetch={false}` on search-result links (`src/components/listing-card.tsx:49` — set exactly when `searchSessionId` is present). Residual: a prefetch that slips through on other surfaces emits a view (over-count) — recorded under A4 | Accepted; pinned by tests (`search-telemetry.test.ts` prefetch cases + source-contract on the card) |
| R3 | **`PRODUCT_EVENT_PSEUDONYM_KEY` rotation breaks cross-version metric joins** — pseudonyms are stable per user **per key version**; rotating the key without bumping `KEY_VERSION` in the same deploy silently splits joins. Detectable via `pseudonymKeyVersion` on every row; the internal exclusion survives via the at-emit `isInternal` flag (no key dependency, S-12). Rotate procedure documented in `.env.example` + `docs/deployment.md` | Accepted (S-11 design); Batch 8 register |
| R4 | **Pseudonymity is defense-in-depth, not anonymity** (S-10): events remain linkable to a user given the key + user table; user-level erasure requires recomputing under a new key version — blocked on A6 (retention/erasure review) | Recorded; Batch 8 register (A6) |
| R5 | **Dashboard full-scan P0 shape**: every `/admin/analytics` request loads every `ProductEvent` row (and all approved `Listing`s, and all ACTIVE memberships per cohort) into memory — accepted P0 shape (plan Scope Decision 10); scaling ceiling documented in the page module comment + pinned by test. Same for `resolveSearchQuery`'s per-search full loads (alias + catalog — §9.1 T5 no-change) | Accepted at beta scale; post-beta review item |
| R6 | **Per-emit / per-view costs**: `isInternalActor` = 2 reads per authenticated emit; `eventsEmitted` = 1 `ProductEvent` read-back per valid search (2 on zero-result) — §4.2 no-misleading-promise requires the read-back; S-19 existence check = 1 read per approve; chat POST = 1 extra messages query. All beta-scale accepted, noted in their modules | Accepted |
| R7 | **`listing_viewed` anonymous throttle bucket** is per-listing shared (`listing-view:anonymous:<id>`) → anonymous demand under-counted; no bot signal defined (A4) → nothing else excluded; every contract records "no bot signal defined — nothing excluded" | Recorded (A4); Batch 8 register |
| R8 | **Duplicate events tolerated (append-only design)**: `beta_membership_activated` (non-atomic action — corrections #15) and `seller_first_listing_published` (S-19 existence check is an idempotency guard, not a CAS) — the dashboard counts DISTINCT `actorPseudonym` for activation, so duplicates don't inflate; no metric engine consumes these for a rate | Recorded |
| R9 | **`websearchToTsquery` operator passthrough**: a normalized query containing websearch syntax (`"`, `-`, `or`) is interpreted as such — same behavior class as the pre-Batch-5 page; `websearchToTsquery` never errors on user input | Recorded |
| R10 | **Vitest file order is not alphabetical** (Task 1 §4.1): integration tests must clean up completely — leftover `role: "admin"` users get promoted by `admin-bootstrap`'s predicate backfill and break its D2/D6 preconditions | Recorded (test-hygiene note for Batch 6+) |
| R11 | **Production-ref invariant is hand-maintained**: `migration ref set` resets `invariants: []`; every future ref advancement must re-add `backfill-listing-approved-content-at` — now **pinned** by the L2 path-walk test (§8.2) so a forgotten re-add fails `npm test` immediately | Mitigated by test; Batch 6+ executors re-verify after advancing refs |
| R12 | **`npm audit --omit=dev` 1 pre-existing high** (`next@16.3.7`, 6 advisories; fix `next@16.4.0` outside the pinned range) — inherited from the base, zero Batch 5 dependency changes | Batch 8 register (dependency hygiene) |
| R13 | **Pre-existing build warning** (`instrumentation.ts:27` `process.exit` Edge Runtime — Batch 2 commit `b8e1c85`, untouched) | Batch 8 register (same as Batch 2 R19) |

---

## 11. Deferred items + forward seams

- **Batch 6 (chat hardening + Deal):** `deal_created`, `deal_outcome_marked`,
  `successful_match`, `listing_marked_sold` schemas ship (Task 6); **emission lands
  with Deal** — never in the dormant finance path (`orders.ts`, S7). Batch 6 must keep
  the chat emissions **after all its guards + successful create** (S5) and keep the
  position-based first-message/first-response detection (b5-fix3 §3.3 — the D4
  invariant, independent of Batch 6's request serialization).
- **Batch 7 (cohort ops):** `seller_invited`, `seller_registered` schemas ship;
  emission lands with the invitation/console flows. `user_returned` emission
  additionally blocked on A3.
- **`communeLevelCode` stays unwritten** (S4 hand-off): the column exists (Batch 4);
  no registry, no UI — blocked on a reviewed commune registry (A8).
- **Telemetry retention/deletion automation** (A6): events accumulate until a
  reviewed retention schedule exists; no product path updates/deletes `ProductEvent`.
- **Saved-search notifications** (spec §5.7.1): P0 interest recording is telemetry
  only. **Elasticsearch/vector/trgm**: not added (the recorded extensions decision —
  pure-TS normalizer + `simple` FTS; revisit only with evidence).
- **Browser E2E remains explicitly deferred** — the repo has **no E2E infrastructure**
  (same posture as Batches 2–4, honored when a runner lands); Batch 5's critical flows
  are covered by the action-level unit tests + real-DB integration tests above
  (including the four publication-gate transitions via the wiring suite and the
  permuted-province search test).

---

## 12. Batch 8 Founder Decision Register — items carried from Batch 5

Per FD-3: execution proceeded on fail-closed defaults; these are **launch blockers**
(needing founder-authored content or decisions), never invented:

| Item | What ships today | Needs |
|---|---|---|
| **A1** attribution/response **window values** (`listing_to_chat_v1`, `seller_response_rate_v1`) + the maturity/as-of question (b5-fix1 §3.10) | Pure engines taking the window as a parameter; fixture-reconciliation with labeled fixture windows; `PENDING_FOUNDER_DECISION` in the registry; dashboard renders the named pending state — never a number | Founder window values (+ maturity semantics); then un-pend the two rates |
| **A2** `successful_match_rate_v1` reconciliation policy / attribution period / duplicate handling | `successful_match` schema + raw count on the dashboard (honest zero until Batch 6 emits); rate stays pending | Founder reconciliation rules + Batch 6 Deal |
| **A3** `repeat_user_rate_v1` return window / eligible-account definition / `user_returned` emission criteria | Schema ships; emission deferred (a "return" cannot be detected without inventing a window) | Founder return-window decision |
| **A4** bot/automated-traffic rules | Nothing excluded under this rule — every contract records "no bot signal defined — nothing excluded"; the `listing_viewed` throttle is anti-inflation mechanics, not a bot rule; residuals recorded (R2/R7) | Founder bot policy |
| **A5** `report rate` / `listing marked sold rate` denominators + §12.2 "quality listing count" definition | Raw counts only (`report_submitted` emitted; `listing_marked_sold` zero until Batch 6) + pending note; **no quality-listing aggregate shipped** (Batch 4's condition/checklist vocabulary is founder-gated) | Founder denominators + quality definition |
| **A6** telemetry retention + access policy | Access = `analytics.read` RBAC; **no deletion automation** — events accumulate; user-level erasure needs key-version recompute (R4) | Reviewed retention schedule |
| **A7** alias catalog content | Mechanism + empty table + idempotent guarded seed (`--aliases <founder.json>`, update-in-place retarget with AUDIT); **zero implementer-authored content** | Founder-supplied alias content (Batch 4 seed / Batch 8 model-seed review) |
| **A8** commune-level registry | `communeLevelCode` unwritten (S4) | Reviewed commune registry |
| **FD-2** production OTP email/SMS provider (Batch 2 A1) | Fail-closed production adapter | Founder provider selection + config — beta-launch prerequisite |
| **FOUNDER DATA GAP** — `"Thừa Thiên Huế"` missing from `hue`'s legacy names (§7) | Rows with that spelling resolve `unresolved` (pinned `null`); Batch 2's registry never patched by Batch 5 | Founder adds the name to `src/lib/provinces.ts` (Batch 2's file) |
| **`SEARCH_RATE`** `{ limit: 60, windowMs: 60_000 }` (spec §7.1) | Tunable ops parameter | Founder may adjust per load evidence |
| **`conversation_buyer_first_message`** (D4) | The one mechanical signal event beyond spec §5.8's 19 (required by `seller_response_rate_v1` eligibility/anchor), schema-versioned `"1"` | Founder visibility; reversible by redefining eligibility on `conversation_started` alone |
| **`METADATA_KEY_DENYLIST` vocabulary + PII shape heuristics** (Task 6) | Implementation vocabulary (email/phone/otp/password/secret/token/ip/address/note/body/message/query/text/name — word match); shape regexes fail-closed (a false positive rejects a telemetry row, never a flow) | Founder may amend additively pre-beta |
| **ops-alerts classification** (per task instructions) | `scripts/ops-alerts.ts` does **not exist in this tree yet** (early Batch 8 work lands later). When it lands, classify in `NON_FINANCE_TABLES`: **`ProductEvent`** (append-only product telemetry) and **`SearchAlias`** (search alias data) — plus the `Listing.locationSource` / `Listing.searchTextNormalized` columns. They must never be treated as finance surfaces by ops alerting | Batch 8 merge action (recorded here + in every task report) |
| **Sort-select UX** (b5-fix3 §3.1) | Default option `"Phù hợp nhất"` (empty value) — server derives relevance/newest; `relevance` is not a visible select value | Reversible UI reading — founder may want the default visible as a 5th option |
| **`resultCount` caps at 60** (page display semantics) | Page display count = fetched rows (≤ 60) | Founder decision if total counts wanted (extra count query) |

Recorded decisions (reversible readings, Batch 2's A5 pattern): **D1** valid search
session = one emitted `search_submitted` (blank/malformed never emitted; every
filter/sort refinement = a new session); **D2** qualified listing view = authenticated
+ non-internal + non-owner (anonymous and owner excluded from numerator *and*
denominator); **D3** `search_to_chat_v1` = unbounded click chain (spec's "eventually");
**D4** `seller_response_rate_v1` eligibility = buyer sent ≥ 1 message (the signal
event), anchor = first buyer message; `median_first_response_time_v1` fully specified
and ships concretely (S-17/S-18).

---

## 13. Verdict

| Acceptance-gate bullet (plan §Acceptance Gate) | Status |
|---|---|
| Sequencing (S1/S2): merged Batch 4 base; linear graph; additive-only migration | ✅ §1/§4 |
| Alias tests (exact/spacing/**compact** B6, catalog fallback S-3, seed idempotent S9) | ✅ 31/31 |
| Diacritic tests (`đ`/`Đ` B5 + "loa do" `simple`-language pin S-1) | ✅ 18/18 + integration |
| Location-filter tests (canonical filter; unresolved only in "all locations"; CITIES drift guard) | ✅ 29/29 + integration |
| Unknown legacy-location migration tests (FD-1 rule only; `city` byte-identical; Batch-4 row never overwritten B3; idempotent + documented rollback) | ✅ integration green + §5.1 |
| Event-schema validation (per-event zod; unknown/wrong/extra rejected, no row written) | ✅ 44/44 |
| PII rejection (free string fields; denylist; 1000 UUIDs never rejected B8; HMAC-only ids S-10/S-11; no raw query text) | ✅ 44/44 + §3.8 |
| Zero-result fixture reconciliation (internal exclusion via at-emit `isInternal` S-12) | ✅ 34/34 |
| CTR fixture reconciliation (session dedup, resultCount>0 denominator, internal exclusion, **actor binding** b5-fix1) | ✅ 34/34 |
| Listing→chat fixture reconciliation (viewer+listing+window dedup, owner/internal/anonymous exclusions, in/out-window attribution) | ✅ 34/34 |
| Response metrics reconciliation (`seller_response_rate_v1` D4 + `median_first_response_time_v1` S-17/S-18) | ✅ 34/34 |
| Metric-contract honesty (8 contracts; 4 pending with named pending state; `search_to_chat_v1` unbounded S-16) | ✅ 17/17 + dashboard tests |
| Location neutrality (no boost without preference — structural + permuted-province; no trust copy) | ✅ tests + §3.4 |
| No finance/identity/moderation/publication regression (Batch 1–4 suites green; `FINANCIAL_FEATURES_ENABLED=false`; finance scan 0; R5 guards + publication wrappers untouched S5) | ✅ §2/§3 |
| Dashboard authorization (`analytics.read` server-side; every rate with numerator/denominator counts) | ✅ §3.3 + 25/25 |
| Preflight (7 gates), integration suite, safe smoke, diff/status audit | ✅ §2 |
| Task 1 review LOW items (L1/L2/L3) | ✅ closed §8 |

**GATE PASS.** Batch 5 is accepted. Beta-launch readiness additionally requires the
founder-authored items in §12 (launch blockers in the Batch 8 Founder Decision Register,
not gate failures — FD-3); A9 is resolved by FD-1 (§7) and is not a launch blocker.
