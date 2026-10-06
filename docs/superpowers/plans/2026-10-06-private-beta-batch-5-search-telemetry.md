# Private Beta Batch 5 — Search, Location, Telemetry, Metric Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make search find the right listings regardless of Vietnamese diacritics (including `đ`), spacing variants and aliases; give every listing an explicit canonical-location *source* state (`seller_declared | legacy_mapped | unresolved`) on top of the Batch 4 location columns while preserving legacy location text verbatim and never guessing an unknown one; stand up the first-party product-telemetry domain (typed event schemas, PII-rejected at write time, keyed-HMAC pseudonymous ids under a dedicated key) with the eight versioned metric contracts from the spec and the required beta dashboard — executing **on the merged Batch 4 commit** (Batch 3 then Batch 4 gates pass first, spec §9), without touching any finance surface and without weakening the Batch 1 finance shutdown or the Batch 2/3/4 invariants.

**Architecture:** One additive Prisma 8 migration adds **only** what S3 allows: the `ProductEvent` and `SearchAlias` tables, the `listing_location_source` + `search_alias_target` enums, `Listing.locationSource`, and `Listing.searchTextNormalized` with its full-text index (language `simple`) — **Batch 4 already owns `provinceLevelCode`/`communeLevelCode`/`locationDisplayName`** (S3), and `city` ≡ `legacyLocationText` (Batch 4 mapping decision). Search stays inside PostgreSQL (spec §5.7): a pure TypeScript normalizer (NFD diacritic strip **including `đ`→`d`**, lowercase, letter↔digit spacing variants) feeds the normalized, `simple`-language full-text-indexed column matched through the typed query builder (`websearchToTsquery` + `fullTextMatches`/`fullTextRank` with `{ language }`); alias resolution adds exact + **compact** (space-stripped) matching against `SearchAlias` rows and the current catalog — no `unaccent`/`pg_trgm` extension dependency (they *are* installable via the Prisma 8 migration workflow; deliberately not used, see Global Constraints). Location: Batch 5 writes only `locationSource` in the listing actions (a valid Batch 4 code ⇒ `seller_declared`; the legacy `ListingForm` path keeps its existing behavior untouched — B2), and the offline backfill writes `provinceLevelCode` only where NULL through the **founder-approved legacy mapping rule** (FD-1: normalized compare against the 34-unit registry's authoritative legacy unit names — merged legacy names map to the new unit per NQ 202/2025/QH15, which is authoritative, not guessing); `"Khác"`, district/ward names, and typos → the explicit `unresolved` state. Telemetry is a new append-only `ProductEvent` table (a separate logical domain from Batch 2's `AuditEvent`, S10) written through one `emitProductEvent` function that validates every event against a per-event zod schema, rejects PII-shaped values in **free string fields only** (schema-typed id/enum fields are exempt — B8), and stores keyed-HMAC pseudonymous actor ids under a **dedicated `PRODUCT_EVENT_PSEUDONYM_KEY`** with a per-row key version and an at-emit `isInternal` flag (S-11/S-12). The eight metric contracts from spec §5.8.1 ship as a typed registry; counting engines are pure functions reconciled against hand-reckoned fixtures; the contracts whose window/parameter values the spec does not define render in a **named pending state** — except `search_to_chat_v1`, whose "eventually" is spec-stated unbounded and ships as the unbounded click-chain (S-16/D3).

**Tech Stack:** Next.js 16.3.7 App Router (typed routes, server actions, server components), React 19, TypeScript strict, Prisma 8 (`@prisma/orm-postgres` rc, contract + migration graph), PostgreSQL ≥ 15, Vitest (unit + scratch-container integration), zod (event schemas), `node:crypto` (HKDF-based pseudonyms under the dedicated key), lucide-react. **No new runtime dependency** (Batch 5 adds zero npm packages).

**Spec:** `docs/superpowers/specs/2026-10-06-private-beta-marketplace-reset-design.md` — Batch 5 is spec §9 "Batch 5", built on §3.1 (Search/Analytics scope), §4.7 (location neutrality), §4.8 (analytics privacy), §4.9, §4.11 (policy non-invention), §5.7 + §5.7.1 (search/aliases + zero-result recovery), §5.8 + §5.8.1 + §5.8.2 (telemetry, metric contracts, required dashboard), §5.9 + §5.9.1 (location model, cold-start markets), §7.1 (endpoint rate limits), §8.3 + §8.6 (location migration, backfill requirements), §9 Batch 5 deliverables + Gate, §10 + §10.1 (verification + abuse matrix), §11 + §11.1 (execution protocol + ambiguity stop rule), §12.2 + §12.3 (success metrics + funnel). The plan argues from the spec; executors read both.

## Batch 5 Sequencing Rules

*Adopted verbatim from `/tmp/loaviet/b5-seq.md`:*

- S1 Order: Batch 5 executes only on the merged Batch 4 commit, after Batch 3 then Batch 4 gates pass (spec §9, R1). Parallel planning ok; parallel execution not.
- S2 Migration graph: before Task 1 confirm db/production refs == Batch 4 `to` hash; plan with --from <batch4 migration dir>; `npx prisma migration list` = baseline → batch2 → batch3 → batch4 → batch5, no node with two outgoing edges; stale base → delete uncommitted package+snapshot, re-emit, re-plan; never hand-merge ops.json/contract.json; expect re-rendered drop+re-add of Listing_status_check_* (additive in effect — do not halt), halt on any other destructive op.
- S3 Schema ownership: Batch 4 owns Listing.provinceLevelCode/communeLevelCode/locationDisplayName and city ≡ legacyLocationText; Batch 3 owns listing_status.removed; Batch 4 owns archived. Batch 5 adds ONLY: enums listing_location_source, search_alias_target; Listing.locationSource; Listing.searchTextNormalized + full-text index (language "simple"); ProductEvent; SearchAlias (+ back-relations). No listing_status values. Exactly one plan may contain each column in its contract diff.
- S4 Location writes: Batch 4 listing-schema/actions are the only writers of provinceLevelCode/locationDisplayName. Batch 5 writes only locationSource in actions; backfill writes provinceLevelCode only where NULL; Batch-4 rows with a valid code → seller_declared, never overwritten. communeLevelCode stays unwritten (blocked on registry — record hand-off as blocked).
- S5 File order: listings.ts B2→B3 (R5 guards)→B4 Task 4→B5 Task 2→B5 Task 4 (hook locationSource/searchTextNormalized into create, update, saveListingDraftAction, submitListingAction; never touch R5 guards or assertListingPublishable). admin.ts B2→B3→B4→B5 Task 8 (emit only after checkListingPublication passes and update succeeds). chat.ts + app/api/chat/[id]/route.ts B3→B5 Task 8→B6 (emit after all guards and successful create). app/listings/[slug]/page.tsx B3→B5 Task 8. app/listings/page.tsx only B5 Task 7 — retarget Batch 4's "draft not publicly visible" source assertion to search-query.ts in the same commit without weakening it. app/admin/layout.tsx B2→B3 Task 6→B5 Task 10 (append nav, keep capabilitiesOf filtering). Add all to the file-conflict rules.
- S6 Searchable seam: SEARCHABLE_LISTING_STATUSES = ["approved"]; drift test enumerating every listing_status value from the contract asserting only approved is searchable; declare isListingSearchable in Task 7 interface; Batch 3 decided suspended sellers keep live listings (B3 A2) → Batch 5 adds NO suspension filter.
- S7 Emission ownership: Batch 5 itself wires report_submitted (Batch 3 src/lib/actions/reports.ts), listing_removed (Batch 3 takeDownListingAction in src/lib/actions/moderation.ts), seller_first_listing_published (Batch 4 rewired approve), seller_verified (Batch 2 verification review action), beta_membership_activated (Batch 2 grant action). Only deal_*, successful_match, listing_marked_sold (Batch 6) and seller_invited/seller_registered (Batch 7) stay forward seams. Never wire orders.ts.
- S8 Category: import BETA_PUBLICATION_CATEGORIES from Batch 4 src/lib/beta-categories.ts; recovery link uses portable_bluetooth_speaker; delete the "loa-bluetooth" fallback.
- S9 Alias content: Batch 5 ships an idempotent offline seed script with empty/founder-reviewed content (A7), or hands to Batch 8.
- S10 Batch 5 writes no AuditEvent; ProductEvent names disjoint from Batch 3/4 audit registries.
- S11 Fallback if Batch 5 must land before Batch 4: Batch 5 owns the three location columns, Batch 4 drops them, and Batch 4 calls emitProductEvent from its rewired paths.

## Global Constraints

- Read `AGENTS.md` and the relevant Next.js 16 docs before editing app code. At minimum (paths as used by the Batch 0–4 plans): `node_modules/next/dist/docs/01-app/02-guides/server-actions.md`, `.../01-app/01-getting-started/15-route-handlers.md`, `.../01-app/02-guides/environment-variables.md`, `.../01-app/02-guides/redirecting.md`, `.../01-app/02-guides/testing/vitest.md`, plus the current server-components/data-fetching, `headers()`/`cookies()`, and **`proxy.md`** API-reference guides under `node_modules/next/dist/docs/` — Batch 5 emits telemetry from page renders and route handlers, so request-header/prefetch behavior (including whether `next-router-prefetch` is stripped by the proxy layer — S-8) must be read from the installed docs, not from training data. Heed deprecation notices.
- **Quote bracketed paths in every `git add`** — zsh globs `[id]`/`[slug]` as a character class and drops the file from the command (Batch 3 constraint, kept verbatim). Every `git add` below already quotes them (`'app/listings/[slug]/page.tsx'`, `'app/api/chat/[id]/route.ts'`); keep that form in every commit.
- Prisma 8 contract/migration workflow (`.agents/skills/prisma-8/references/contract.md` + `migrations.md` + `migration-model.md`): edit `src/prisma/contract.prisma` → `npx prisma contract emit` → `npx prisma migration plan --name <snake_slug>` → fill any `placeholder(...)`/data-transform holes in the rendered `migration.ts` → self-emit with `node migrations/app/<dir>/migration.ts` → review with `npx prisma migration show <dir>` → `npx prisma db migrate` → advance refs. Never `db update` against a shared/production database; never edit `ops.json`/`contract.json`/`contract.d.ts` by hand; commit contract artefacts + migration package together. Shell commands use quoted `"$DIR"`/`"$END_HASH"` variables, never bare `<dir>`/`<end-hash>` placeholders (zsh reads those as redirections).
- **Postgres extensions decision (recorded).** The Prisma 8 migration workflow *can* install Postgres extensions (`this.installExtension({...})` operation and the `rawSql({...})` escape hatch exist on the Postgres `Migration` base class — `.agents/skills/prisma-8/references/migrations.md` § *Author a migration by hand*). Batch 5 **deliberately does not use `unaccent`/`pg_trgm`**: diacritic-insensitivity is done by a pure TypeScript normalizer into a normalized column (single-sourced, unit-testable, byte-identical across dev DB, scratch test container, and production), and matching stays inside the typed query builder against a contract-declared `@@fullTextIndex`. Extensions would add environment dependencies (scratch container, backup/restore parity, `db verify --strict` extras) and push search semantics into raw SQL outside the contract. Revisit only with evidence (spec §5.7: "Do not add Elasticsearch/vector search for P0 unless evidence requires it" — the same evidence bar applies to search infrastructure generally).
- **Full-text language invariant — `simple` everywhere (S-1).** `@@fullTextIndex` and the `websearchToTsquery`/`fullTextMatches`/`fullTextRank` helpers each carry a text-search `language`. Batch 5 uses **`"simple"`** on the index **and** on every operation built against it: the `english` default would drop stopword tokens that are ordinary Vietnamese syllables (`do`, `to`, `be`, `my`, `on`, `an`, `it` — a query "loa do" would lose `do` and match every "loa …" listing) and its stemmer rewrites tokens; `simple` lowercases and tokenizes only, which is exactly right for text Batch 5 pre-normalizes itself. A mismatch between index and query language is a *silent* sequential scan (`.agents/skills/prisma-8/references/contract.md` § Full-text search indexes) — the invariant is index language === query language === `"simple"`, pinned by the "loa do" test.
- Test-first for every behavior change: add the failing test, confirm the expected failure, implement the minimum, rerun the focused test. Unit tests mock `server-only`, `next/cache`, `next/navigation`, `next/headers`, and the db client exactly like `tests/unit/financial-shutdown-actions.test.ts` does (Batch 3's canonical stubbing recipe, Global Constraints of that plan, applies to every test that imports an action/page); integration tests run only via `scripts/test-integration.sh` against the scratch container (same `hasDb` guard pattern as `tests/integration/escrow.test.ts`).
- **Additive-only schema (S3).** No drop, rename, or repurpose of any existing column/table/index/enum value. `Listing.city` (≡ `legacyLocationText`), `Listing.viewCount`, the existing `@@fullTextIndex` on `title`/`description`, `User.city`, every finance model, Batch 3's moderation tables, and **Batch 4's structured listing columns** stay exactly as their owning batches shipped them. All new columns are nullable; all new tables are additional. Expect the enum-adjacent re-render of `Listing_status_check_*` if the planner touches it — additive in effect, do not halt (S2).
- **Preserve Batch 1 + 2 + 3 + 4.** `FINANCIAL_FEATURES_ENABLED` stays `false`; every existing finance guard and test (`tests/unit/financial-shutdown-*.test.ts`, `tests/unit/finance-public-surface.test.ts`, `tests/unit/admin-finance-readonly.test.ts`, `tests/integration/escrow.test.ts`) must stay green unchanged. Batch 5 executes **after the Batch 3 and Batch 4 gates pass** (S1), so every Batch 2 suite (`rbac`, `session`, `otp`, `audit-event`, `seller-verification`, `publication-gate`, …), every Batch 3 suite (`report-actions`, `chat-guard`, `moderation-actions`, `suspension-actions`, `block-enforcement`, …), and every Batch 4 suite (`listing-draft-actions`, `beta-categories`, `listing-schema`, `listing-images`, `listing-publication`, `image-process`, `upload-route`, `legacy-listing-compat`, …) must also stay green unchanged. No Batch 5 task may enable, bypass, or weaken any finance, identity, moderation, or publication boundary — in particular Batch 3's R5 guards (`MODERATION_LOCKED_LISTING_STATUSES`) and Batch 4's `assertListingPublishable`/`assertListingContentValid`/`checkListingPublication` wrappers are **never touched, re-implemented, or bypassed** (S5).
- **Build on the merged Batch 2/3/4 interfaces as shipped:** `requireCapability("analytics.read")` (Batch 2 `src/lib/rbac.ts`); `getSessionFromCookie()` (Batch 2 `src/lib/session.ts` — DB sessions); `hkdfKey` (Batch 2 `src/lib/otp.ts` — still used for OTP/ip/recovery-code hashing, **not** for product-event pseudonyms, see S-11); **the 34-unit province registry (Batch 2 Task 10's plain `src/lib/provinces.ts` — FD-1: stable slug codes, `displayName`, `kind`, merged legacy units, per NQ 202/2025/QH15; Batch 5 only consumes it, never creates or edits it)**; `BetaCohortMembership` (`cohort: "internal"`, `status: "active"`) + `User.adminRole` as the internal/test-user markers (S-12); Batch 3's `submitReportAction` (`src/lib/actions/reports.ts`), `takeDownListingAction` (`src/lib/actions/moderation.ts`), `MODERATION_LOCKED_LISTING_STATUSES` (`src/lib/moderation.ts`); Batch 4's `BETA_PUBLICATION_CATEGORIES` (`src/lib/beta-categories.ts`), `saveListingDraftAction`/`submitListingAction`/`createListingAction`/`updateListingAction` (`src/lib/actions/listings.ts`), `approveListingAction`/`rejectListingAction` (`src/lib/actions/admin.ts`), `ListingImageUpload`. If an executed batch differs from its plan on a name or export shape, adapt the call site to the real name — the capability/guard semantics and the 34-unit registry content (per `/tmp/loaviet/provinces-34.md`) must not change.
- **Telemetry privacy (spec §4.8).** `ProductEvent` rows must never contain: raw email, raw phone, message body, full/street address, OTP, password, authentication secret, identity evidence, raw IP, precise location, **or raw search-query text** (a query box is free text — the events store only *resolved structured identifiers*: brand/model/category ids, result counts, validated filter facets). Actor identity is stored only as `actorPseudonym` = HMAC-SHA256(userId, dedicated key) — never a raw user id; session identity only as `sessionPseudonym` = HMAC-SHA256(sessionId, dedicated key) — never a raw `UserSession.id` (S-10: a raw session id joins straight back to `userId` via the `UserSession` table). **Pseudonymity is defense-in-depth, not anonymity:** the pseudonym is stable per user per key version, so events remain linkable to a user given the key and the user table; user-level erasure requires recomputing under a new key version (recorded with A6). No third-party analytics SDK (the spec mandates first-party telemetry only, §3.1). Product telemetry and security/audit logs stay separate domains (S10): Batch 5 writes `ProductEvent`, **never** `AuditEvent`, for product events, and never `captureEvent`/`captureError` with event payloads (rejection reasons log the event *name* and the violated rule, never the value).
- **Telemetry must not break product flows.** `emitProductEvent` fails **open** on infrastructure errors (db failure → `captureError`, product flow continues) and fails **closed** on validation violations (schema mismatch or PII-shaped value in a scanned field → **no row written**, typed rejection logged without the payload). Events are append-only: no FK from `ProductEvent` to `Listing`/`Conversation`/`ProductModel` (events survive source deletion), and no product-code path updates or deletes a `ProductEvent`.
- **No finance semantics in telemetry (spec §4.1/§4.8).** No event name, field, or metadata key may encode payment/escrow/wallet/commission/order semantics. The dormant finance path that sets `Listing.status = "sold"` (`src/lib/actions/orders.ts`) must **never** emit telemetry (S7) — `listing_marked_sold` emission lands with the beta sold transition owned by Batch 6.
- **Location neutrality (spec §4.7 + §5.9.1).** No UI copy may describe a location as safe/guaranteed/verified — use `Khu vực beta trọng điểm`, never `Khu vực an toàn`. Priority beta locations receive **no automatic relevance boost** when the buyer has not selected a location preference (spec §5.7 ranking rule 5). Location alone is never a trust signal.
- **Policy Non-Invention (spec §4.11 + §11.1).** Do not invent: metric definitions beyond the spec's numerator/denominator/exclusions; attribution/response **window values**; retention windows; city/province lists **beyond the founder-approved 34-unit registry** (FD-1 resolved the registry content — NQ 202/2025/QH15 per `/tmp/loaviet/provinces-34.md`; anything not in that source stays unmapped/unresolved, never authored from training data); alias catalog content; bot-detection rules. Every gap is recorded in *Ambiguities* and handled fail-closed (pending state on the dashboard), while the unambiguous parts ship — per FD-3, execution **proceeds** on the fail-closed defaults and founder-authored content ships as clearly-marked placeholders listed in the Batch 8 Founder Decision Register. The plan's recorded decisions (D1–D4) are reversible readings, listed there.
- **Backend authorization only (spec §4.5).** The analytics dashboard and every new admin surface checks capability server-side via `requireCapability("analytics.read")`. Nav filtering is convenience.
- **`src/lib/product-events.ts` imports `"server-only"` and never `"use server"`** (S-13): it is a plain server module (exportable constants + async functions, no server-action exposure), importable by pages/actions/routes; the offline seed/backfill scripts import only its plain sub-parts (key derivation lives in a plain `src/lib/product-event-key.ts`, Batch 2 `admin-mfa-key.ts` precedent). Pinned by a source-contract test.
- OpenCode must not push, merge, deploy, or destructively clean the repository. Commit each task separately with the listed message; never `git add .`. Exclude from commits: `.claude/settings.json`, `public/uploads/`, secrets, local scratch data, unrelated work.

## Batch 5 Scope Decisions

In scope (spec §9 Batch 5 deliverables):

1. **Search normalization** — pure normalizer (lowercase, Vietnamese diacritic-insensitive **including `đ`**, whitespace collapse, letter↔digit spacing variants) + a maintained, `simple`-language full-text-indexed `Listing.searchTextNormalized` column + backfill (`--recompute-all` for staleness) for existing listings.
2. **Aliases** — `SearchAlias` table + resolution mechanism (exact + compact matching, normalized alias → brand/model ids) + fallback resolution against the current `Brand`/`ProductModel` catalog. The alias *catalog content* is Batch 4's seed / Batch 8's model-seed review (A7); the mechanism and the spec's spacing-variant forms ship. An idempotent offline seed script ships with **empty/founder-reviewed content** (S9).
3. **Diacritic-insensitive search** — the search page matches the normalized column with one OR-joined tsquery plus resolved ids, ranked textual-relevance-first (spec §5.7 ranking), with the no-auto-location-boost rule.
4. **Empty-state recovery (spec §5.7.1)** — zero-result page offers: remove restrictive filters, browse the resolved brand (when the query resolved), browse the beta speaker category (`portable_bluetooth_speaker` via Batch 4's allowlist — S8), and records demand interest as telemetry (structured, not a saved-search system). The "demand recorded" line renders **only when the event was actually written** (§4.2 no-misleading-promise).
5. **Canonical current location model (spec §5.9)** — `Listing.locationSource` (`seller_declared | legacy_mapped | unresolved`) on top of Batch 4's `provinceLevelCode`/`communeLevelCode?`/`locationDisplayName` columns (S3/S4); canonical codes from the founder-approved 34-unit registry (Batch 2 Task 10's `src/lib/provinces.ts` — FD-1, A9 resolved); Batch 5 writes only `locationSource` in the listing actions; province filter in search.
6. **Legacy location preservation (spec §8.3)** — `Listing.city` (≡ `legacyLocationText`) untouched; offline backfill maps legacy rows only through the **founder-approved legacy mapping rule** (FD-1: normalized compare against the registry's authoritative legacy unit names — merged legacy names map to the new unit per NQ 202/2025/QH15, not guessing); `"Khác"`, district/ward names, typos → explicit `unresolved`; never fabricated; Batch-4-declared codes never overwritten (S4).
7. **Event schemas (spec §5.8)** — the 19-event server-owned taxonomy **plus one mechanical signal event** (`conversation_buyer_first_message`, required by the `seller_response_rate_v1` contract's eligibility rule D4 — flagged for founder visibility, schema-versioned), per-event zod schemas, PII rejection at write time (free string fields only — B8), pseudonymous actor/session ids under the dedicated key, `ProductEvent` table.
8. **Funnel events (S7)** — emission wired by Batch 5 into the **existing** surfaces: `search_submitted`, `search_zero_result`, `search_result_clicked`, `listing_viewed`, `conversation_started`, `conversation_buyer_first_message`, `message_first_response`, `listing_rejected`, `seller_first_listing_published` (Batch 4 rewired approve), `listing_removed` (Batch 3 `takeDownListingAction`), `report_submitted` (Batch 3 `submitReportAction`), `seller_verified` (Batch 2 verification review), `beta_membership_activated` (Batch 2 grant action). Schemas (not emission) ship for the forward seams: `deal_created`, `deal_outcome_marked`, `successful_match`, `listing_marked_sold` (Batch 6), `seller_invited`, `seller_registered` (Batch 7), `user_returned` (blocked on A3).
9. **Metric contracts (spec §5.8.1)** — the eight versioned contracts as a typed registry + pure counting engines + fixture-reconciliation tests; `search_to_chat_v1` ships as the spec-stated **unbounded** click-chain (S-16/D3), the window-unspecified remainder render pending.
10. **Basic aggregates/dashboard (spec §5.8.2)** — `/admin/analytics` behind `analytics.read`: query volume, zero-result rate, result CTR, listing→chat, search→chat, seller response rate, median first response time, median listing age, listing marked sold, successful matches, report count, repeat users, seller activation, seller listing count, active seller count — segmented by beta cohort, primary/secondary market, category, brand/model where sample size permits; every rate renders with its numerator/denominator counts (low-sample context); pending-parameter metrics render a named pending state. Full-table scan over `ProductEvent` is the accepted P0 shape — the scaling limit is recorded in the dashboard module and the verification doc (nit).
11. **Search rate limiting (spec §7.1)** — the search surface gets an endpoint-specific in-memory rate limit applied **only to requests carrying a valid query**, keyed by session/user with IP fallback (same topology caveats as `src/lib/rate-limit.ts`).

Explicitly deferred (do not build here): saved-search notifications (spec §5.7.1 — P0 interest recording is telemetry only), Elasticsearch/vector/trgm infrastructure, the commune-level registry (column exists from Batch 4; stays unwritten — S4 hand-off recorded), telemetry retention/deletion automation (A6), bot-detection beyond the recorded no-rule (A4), moderation/report surfaces themselves (Batch 3 — only the *emission hooks* are Batch 5's, S7), listing publication states/category allowlist/canonical model seed/photo checklist (Batch 4 — only the `locationSource`/`searchTextNormalized` hooks and the approve-path emission are Batch 5's), chat hardening + Deal domain (Batch 6), cohort invitation/console (Batch 7), legal/policy text (Batch 8).

## Legacy Migration Decisions (additive, spec §8.3 + §8.6)

- `Listing.city` **is** the legacy location text (Batch 4 mapping decision: `city ≡ legacyLocationText`) and stays untouched, readable, and used for historical display. Batch 5 adds only `locationSource` beside Batch 4's canonical columns; nothing legacy is repurposed or dropped.
- The legacy→canonical mapping follows the **founder-approved rule at the bottom of `/tmp/loaviet/provinces-34.md` (FD-1)**: a legacy free-text city/province value maps to a new unit **only** when it equals — after NFC + trim + case-fold + diacritic-insensitive compare, with the common prefixes `"Tỉnh"`/`"TP."`/`"Thành phố"` stripped — one of the **legacy unit names carried by the 34-unit registry** (the merged-legacy-units list is authoritative per NQ 202/2025/QH15 — mapping `"Bình Dương"` → `ho-chi-minh` or `"Thừa Thiên Huế"` → `hue` is applying the founder's source, **not guessing**; spec §8.3 is satisfied by the authoritative source, not violated). `"Khác"`, district/ward names, typos, and anything not in the authoritative legacy list → the explicit `unresolved` state. The rule is implemented in `resolveLegacyLocation` (`src/lib/location.ts`) against the registry's legacy-name data — no hand-authored per-city table, no runtime name equality against display names; the unit test pins every `CITIES` entry's outcome (the drift guard: adding a `CITIES` entry without a registry-backed resolution fails the test).
- New listings declare canonical location through **Batch 4's** form/actions (`provinceLevelCode` from the registry select, `city = PROVINCE_CITY_LABELS[code]`). Batch 5's action hook sets `locationSource = "seller_declared"` **only when that submission carried a valid code** (S4); the legacy `ListingForm` path (legacy-regime edits with no province field) keeps its existing behavior and leaves `locationSource` untouched (B2). No `CITIES` guard or code derivation is added to any action.
- `Listing.viewCount` stays as-is (display counter); `listing_viewed` events are the analytics source of truth — the legacy counter is not repurposed, not reset, and not read by metrics.
- The existing `@@fullTextIndex` on `Listing.title`/`description` and `ProductModel.name` stay; the new `searchTextNormalized` index (language `simple`) is added beside them. `searchTextNormalized` is derived data (title + brand name + model name, normalized) — always re-computable, so its backfill is idempotent, `--recompute-all` repairs staleness (brand/model rename, catalog merges, the Batch 4 seed), and its "rollback" is re-running the backfill (S-4).
- `User.city` stays untouched (legacy); Batch 2's `User.sellerOperatingProvinceCode` remains the canonical seller operating location. Batch 5 does not add user-level location columns.

## Dependency and Parallelization Map

```text
(S1: Batch 3 rồi Batch 4 đã merge + pass gate TRƯỚC khi Batch 5 bắt đầu — mọi task chạy trên commit Batch 4)
Task 1  contract + migration (schema is the base commit for everything — S2/S3)
        ↓
        ├── Task 2  location module + legacy backfill + locationSource hook   ┐
        ├── Task 3  search-normalize pure module                              │ {2, 3, 6} may run in parallel
        └── Task 6  product-event taxonomy + emit core                       ┘
        ↓
        ├── Task 4  searchTextNormalized maintenance + backfill   (sau 3; cùng file listings.ts với 2 → chạy sau 2 — S5)
        └── Task 5  alias resolution mechanism                   (sau 1; song song với 4)
        ↓
Task 7  search page integration (cần 2, 3, 4, 5, 6)
        ↓
        ├── Task 8  funnel event wiring vào các surface hiện có  ┐ {8, 9} song song (cả hai chỉ cần 6)
        └── Task 9  metric contracts + engine + fixture tests    ┘
        ↓
Task 10 beta dashboard (cần 9 + Batch 2 rbac)
        ↓
Task 11 batch gate verification + verification doc
```

File-conflict rules (S5 order — every file below carries Batch 2→3→4 changes when Batch 5 starts; Batch 5 edits them **on top of the merged Batch 4 commit** and keeps every earlier guard): `src/lib/actions/listings.ts` is touched by Task 2 (locationSource hook) then Task 4 (searchTextNormalized hook) — sequential in that order; both hook into `createListingAction`, `updateListingAction`, `saveListingDraftAction`, `submitListingAction` and **never touch** Batch 3's R5 guards or Batch 4's `assertListingPublishable`/`assertListingContentValid` calls (S5). `src/lib/actions/admin.ts` is touched by Task 8 only (emission after `checkListingPublication` passes and the update succeeds). `src/lib/actions/chat.ts` + `'app/api/chat/[id]/route.ts'` are touched by Task 8 only (emission after all Batch 3 guards and successful create). `'app/listings/[slug]/page.tsx'` is touched by Task 8 only. `app/listings/page.tsx` is touched by Task 7 only — the same commit retargets Batch 4's "draft not publicly visible" source assertion (in `tests/unit/listing-draft-actions.test.ts`) to `SEARCHABLE_LISTING_STATUSES` in `src/lib/search-query.ts` without weakening it (S5/S-21). `app/admin/layout.tsx` is touched by Task 10 only (append nav, keep `capabilitiesOf` filtering). `src/components/listing-card.tsx` is touched by Task 7 only. `src/prisma/contract.prisma` is Task 1 only. **`src/lib/provinces.ts` is Batch 2 Task 10's file (FD-1) — Batch 5 never creates or edits it, only imports it.** Everything else is single-owner.

## Coordination Points (narrow interfaces; the merged batches own the internals)

Batch 5 executes on the merged Batch 3 + Batch 4 commit (S1) and consumes their shipped interfaces; it must not depend on anything unshipped:

1. **Batch 4 — canonical catalog + location columns + publication flow.** Search resolves a query to brand/model ids through `resolveSearchQuery` (`src/lib/search-resolve.ts`), reading (a) `SearchAlias` rows (Batch 5's table; content seeded by Batch 4's canonical model seed / Batch 8's model-seed review — A7; an idempotent offline seed script ships empty/founder-reviewed — S9) and (b) the current `Brand`/`ProductModel` catalog as fallback. The zero-result recovery "browse portable-speaker inventory" link imports `BETA_PUBLICATION_CATEGORIES` from Batch 4's `src/lib/beta-categories.ts` and targets `portable_bluetooth_speaker` (S8) — no `"loa-bluetooth"` fallback exists. `provinceLevelCode`/`communeLevelCode`/`locationDisplayName`/`city` are Batch 4's writers (S4); Batch 5 writes only `locationSource`. `seller_first_listing_published` emission lives in Batch 4's rewired `approveListingAction`, **after** `checkListingPublication` passes and the update succeeds (S5).
2. **Batch 3 — moderation/report surfaces.** Search filters listings through `SEARCHABLE_LISTING_STATUSES = ["approved"]` + `isListingSearchable()` (`src/lib/search-query.ts`) — the single seam where publication-state filtering lives; a drift test enumerates every `listing_status` value from the contract asserting only `approved` is searchable (S6). Batch 3 decided suspended sellers keep live listings (its A2) → **Batch 5 adds NO suspension filter** (S6). `report_submitted` emission hooks into Batch 3's `submitReportAction` (`src/lib/actions/reports.ts`) after the report transaction succeeds; `listing_removed` hooks into Batch 3's `takeDownListingAction` (`src/lib/actions/moderation.ts`) after the atomic update succeeds (S7). Batch 3's R5 guards in `listings.ts` are never touched (S5).
3. **Batch 6 — chat hardening + Deal (forward seams).** `conversation_started` (in `startConversationAction`) and `conversation_buyer_first_message`/`message_first_response` (in the chat POST route) emission must survive Batch 6's chat authorization hardening — Batch 6 calls the same `emitProductEvent` functions from its hardened paths, after all guards and the successful create (S5). `deal_created`, `deal_outcome_marked`, `successful_match` schemas ship now; emission lands with Deal. `listing_marked_sold` emission lands with the beta sold transition (Batch 6) — **never** in the dormant finance path (`src/lib/actions/orders.ts`).
4. **Batch 7 — cohort operations (forward seams).** `seller_invited`, `seller_registered` schemas ship now; emission lands with the invitation/console flows. `user_returned` emission is additionally blocked on Ambiguity A3.
5. **Batch 2 — base interfaces.** `requireCapability`/`analytics.read`, `getSessionFromCookie` (session id → pseudonymized), `reviewSellerVerificationAction` (`seller_verified` emission — S7), `setBetaMembershipAction` (`beta_membership_activated` emission when status becomes `active` — S7), `BetaCohortMembership` internal cohort + `User.adminRole` (internal exclusion — S-12), `AuditEvent` (stays the security/audit domain — Batch 5 never writes one, S10).
6. **Batch 2 revision (parallel) — the province registry (FD-1).** The canonical registry is **Batch 2 Task 10's** plain `src/lib/provinces.ts` (no db/`server-only` importers): the 34 provincial units per **NQ 202/2025/QH15** (founder-approved source `/tmp/loaviet/provinces-34.md`), with stable slug codes (`ha-noi`, `ho-chi-minh`, …), `displayName`, `kind`, and each unit's **merged legacy units** (the authoritative legacy-name data the mapping rule consumes). Batch 5 **only consumes** it — never creates, edits, or duplicates it; if the shipped export shape differs from what `src/lib/location.ts` expects, adapt the import (the 34-unit content is the contract). A9 is **RESOLVED** by FD-1.

## Review Focus

1. **Raw search-query text or any PII shape reaching `ProductEvent`** (spec §4.8) — a metadata field carrying the raw query, an email/phone/OTP/IP-shaped string in a **free string field**, or a free-text field sneaking into a schema. Pinned by Task 6: `tests/unit/product-events.test.ts` PII-rejection cases + the structural "no schema has a free-text/query field" assertion + the **1000-random-UUID never-rejected** test (B8 — the shape scan must not eat legitimate id fields); Task 11 re-runs the source scan.
2. **Telemetry emission from the dormant finance path** — `src/lib/actions/orders.ts` (or any finance module) gaining a `ProductEvent` write (S7). Pinned by Task 8's source-contract test + Task 11's `rg "ProductEvent|emitProductEvent" src/lib/actions/orders.ts src/lib/escrow.ts src/lib/wallet.ts src/lib/ledger.ts src/lib/momo.ts src/lib/mock-payment.ts` → 0 hits.
3. **Priority-location relevance boost without buyer preference** (spec §5.7 ranking rule 5 + §4.7) — Hà Nội listings silently ranked above others when no location filter was chosen. Pinned by Task 7: the structural no-boost plan test **plus the permuted-province integration test** — seed identical listings across provinces, run the same no-province search with the rows' province codes permuted, assert the result order is identical (nit).
4. **A non-authoritative legacy location mapped to a province** (spec §8.3) — `"Khác"`, a district/ward string, or a typo mapped to a code, **or a legacy name mapped to the wrong unit** (merged legacy names DO map per FD-1 — the guard is that *only* the registry's authoritative legacy names map, through the founder's rule). Pinned by Task 2: `tests/integration/listing-location.test.ts` backfill cases (unmatched stays `unresolved`; `city` byte-identical before/after; **a Batch-4-created row with a valid code is never overwritten** — B3) + `tests/unit/location.test.ts` per-`CITIES` outcome pins (incl. the merged-name cases `Bình Dương` → `ho-chi-minh`, `Thừa Thiên Huế` → `hue`).
5. **Metric fixture reconciliation drift** — the counting engine disagreeing with a hand-reckoned fixture (dedup, window boundaries, exclusions, conversation-level dedup). Pinned by Task 9: `tests/unit/metrics-reconciliation.test.ts` — every gate metric reconciled against hand-computed expected values, including dedup and exclusion edge cases.
6. **Dashboard access without capability** — `/admin/analytics` rendering for a role without `analytics.read` (spec §4.5). Pinned by Task 10: `tests/unit/analytics-dashboard.test.ts` source-contract guard test (same pattern as `tests/unit/finance-public-surface.test.ts`) + Batch 2's `rbac.test.ts` matrix staying green.
7. **`?ss=` attribution forgery** (S-14) — a fabricated or copied `ss` param manufacturing `search_result_clicked` events. Pinned by Task 7/8: the click validates the `search_submitted` row exists **and the clicked listing is in that search's recorded result set**; unknown `ss` → no event.

---

## Task 1: Contract additions + Batch 5 migration

**Files:**

- Modify: `src/prisma/contract.prisma`
- Create: `migrations/app/<ts>_batch5_search_telemetry/` (rendered by `prisma migration plan`)
- Modify (emitted): `src/prisma/contract.json`, `src/prisma/contract.d.ts`
- Modify: `migrations/app/refs/db.json`, `migrations/app/refs/production.json` (ref advancement)
- Test: `tests/integration/batch5-migration.test.ts`

**Interfaces:**

- Consumes: existing `Listing` (incl. **Batch 4's** `provinceLevelCode`/`communeLevelCode`/`locationDisplayName`), `Brand`, `ProductModel`, `Conversation`, `Message`, `ListingImageUpload` (Batch 4), `UserSuspension`/`ModerationCase`/`AbuseReport` (Batch 3), finance models (all untouched) — **on the merged Batch 4 commit** (S1).
- Produces (S3 — exactly this, nothing else): models `ProductEvent`, `SearchAlias`; enums `listing_location_source`, `search_alias_target`; `Listing.locationSource`; `Listing.searchTextNormalized` + its `simple`-language full-text index; back-relations `Brand.searchAliases`, `ProductModel.searchAliases`. **No `listing_status` values. No location columns Batch 4 owns.**

- [ ] **Step 0: Confirm the Batch 4 base (S2)**

- `migrations/app/refs/db.json` and `refs/production.json` hash **equals Batch 4's migration `to` hash**; `npx prisma migration list` shows `baseline → batch2 → batch3 → batch4` with no node holding two outgoing edges. If not: stop — do not plan over a stale base.
- Plan with the explicit origin if the CLI requires it: `npx prisma migration plan --name batch5_search_telemetry --from <batch4-migration-dir>` (per `.agents/skills/prisma-8/references/migration-model.md`). If a Batch 5 package was ever authored on a stale base: delete the uncommitted package + snapshot, re-emit, re-plan — **never hand-merge `ops.json`/`contract.json`**.

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/batch5-migration.test.ts` (runs only via `scripts/test-integration.sh`, scratch DB, same `hasDb` guard pattern as `tests/integration/escrow.test.ts`):

- `applies the batch 5 migration additively`: after the script's migrate step, `db.orm.public.ProductEvent` and `db.orm.public.SearchAlias` each accept a create+read+delete round-trip with the fields below; a `Listing` created with Batch 4's structured columns accepts `update({ locationSource, searchTextNormalized })` and reads them back; `Listing.provinceLevelCode`/`locationDisplayName` already exist from Batch 4 (round-trip one — proves Batch 5 did not re-add them).
- `search alias unique constraint rejects a duplicate (alias, target) row` (raw duplicate `create` throws); `a SearchAlias with target=brand and a null brandId is rejected` (target ⇒ id set check — nit).
- `migration leaves the database consistent`: `npx prisma db verify` exits 0 after migrate.
- `preserves finance tables`: `Order`, `Payment`, `Payout`, `WithdrawRequest`, `LedgerEntry`, `Dispute` still accept reads and a seeded `Order`+`Payment` row reads back unchanged.
- `preserves batch 2/3/4 tables`: `UserSession`, `AuditEvent`, `BetaCohortMembership`, `SellerVerification` (Batch 2), `UserSuspension`, `ModerationCase`, `AbuseReport` (Batch 3), `ListingImageUpload` (Batch 4) each accept a create+delete round-trip (S-22 — proves Batch 5's migration did not disturb the earlier graphs).

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:integration`
Expected: FAIL — `ProductEvent`/`SearchAlias`/`Listing.locationSource`/`Listing.searchTextNormalized` not in contract.

- [ ] **Step 3: Edit the contract, emit, plan the migration**

Add to `src/prisma/contract.prisma` (match existing style: `// use prisma-8` header, `@@type("pg/text@1")` on enums, `TimestamptzString`, `temporal.updatedAtString()`):

```prisma
// ─── Enums (Batch 5 — location source & search alias) ───

enum listing_location_source {
  @@type("pg/text@1")
  seller_declared = "seller_declared" // submission mang mã tỉnh hợp lệ do Batch 4 form ghi (S4)
  legacy_mapped   = "legacy_mapped"   // backfill khớp qua BẢNG ĐÃ DUYỘT (không phải name-equality) — spec §8.3
  unresolved      = "unresolved"      // legacy không nằm trong danh sách tên authoritative của registry → KHÔNG đoán (FD-1)
}

enum search_alias_target {
  @@type("pg/text@1")
  brand = "brand"
  model = "model"
}
```

Add to `Listing` (additive only — **Batch 4 owns the location columns; Batch 5 adds exactly these two** — S3):

```prisma
  // ─── Batch 5 (spec §5.9): nguồn của location canonical — cột mã tỉnh thuộc Batch 4 ───
  locationSource      listing_location_source?  // null = chưa backfill; sau backfill không còn null legacy row

  // ─── Batch 5 (spec §5.7): normalized search text — derived, luôn tính lại được ───
  searchTextNormalized String?                    // normalizeSearchText(title + brand.name + model.name)
  @@fullTextIndex([searchTextNormalized], name: "listing_search_text_search", language: "simple")
  //   language "simple" ở CẢ HAI phía index + query (S-1) — english stopword/stemmer làm hỏng text tiếng Việt
  //   đã pre-normalize ("loa do" mất "do"); verify cú pháp PSL chính xác theo contract.md § Full-text search
```

New models:

```prisma
// ─── Product telemetry (Batch 5, spec §5.8 — domain RIÊNG với AuditEvent của Batch 2, S10) ───

model ProductEvent {
  id             String            @id @default(uuid())
  name           String            // taxonomy (src/lib/product-events.ts) — registry trong code, KHÔNG phải enum DB
  schemaVersion  String            // "1"
  occurredAt     TimestamptzString @default(now())
  actorPseudonym String?           // HMAC-SHA256(userId, PRODUCT_EVENT_PSEUDONYM_KEY) — KHÔNG bao giờ id thô (S-10)
  sessionPseudonym String?         // HMAC-SHA256(UserSession.id, cùng key) — KHÔNG bao giờ session id thô (S-10:
                                   //   session id thô join thẳng về userId qua UserSession)
  pseudonymKeyVersion String       @default("1") // id của key đã ghi — phát hiện rotation (S-11)
  isInternal     Boolean           @default(false) // internal cohort ∪ adminRole ≠ null, tính LÚC emit (S-12) —
                                   //   exclusion không phụ thuộc key ổn định qua rotation
  searchSessionId String?          // uuid do server sinh cho mỗi lần search — khóa join CTR / search→chat
  listingId      String?           // KHÔNG FK: event append-only sống qua vòng đời listing
  productModelId String?           // KHÔNG FK (như trên)
  conversationId String?           // internal id cho join response metrics
  provinceCode   String?           // mã tỉnh canonical — coarse location (spec §4.8), KHÔNG bao giờ địa chỉ chi tiết
  metadata       Json?             // allowlisted theo event schema (zod) — KHÔNG PII, KHÔNG query text thô

  @@index([name, occurredAt])
  @@index([actorPseudonym, occurredAt])
  @@index([searchSessionId])
  @@index([listingId])
  @@index([conversationId])
}

// ─── Search aliases (Batch 5, spec §5.7 — mechanism ở đây, CONTENT thuộc Batch 4/8 seed, A7) ───

model SearchAlias {
  id             String   @id @default(uuid())
  alias          String   // dạng CHUẨN HÓA (normalizeSearchText) — khóa tra cứu, vd "soundlink"
  target         search_alias_target
  brandId        String?
  brand          Brand?       @relation("alias_brand", fields: [brandId], references: [id])
  productModelId String?
  productModel   ProductModel? @relation("alias_model", fields: [productModelId], references: [id])
  note           String?
  createdAt      TimestamptzString @default(now())

  @@unique([alias, target])
  @@index([alias])
}
```

Add the back-relations (additive): `Brand` gains `searchAliases SearchAlias[] @relation("alias_brand")`; `ProductModel` gains `searchAliases SearchAlias[] @relation("alias_model")`.

Then:

```bash
npx prisma contract emit
npx prisma migration plan --name batch5_search_telemetry   # (+ --from <batch4-dir> nếu CLI yêu cầu origin tường minh)
```

- [ ] **Step 4: Review the package, self-emit**

- Confirm the plan output's `from:` line names the current graph head (the post-Batch-4 hash that `migrations/app/refs/db.json` + `production.json` point to), not `(baseline)` over a non-empty graph, and `pendingPlaceholders` is `false` (all new columns are nullable/defaulted — a placeholder means an accidental non-null column; fix the contract instead).
- `npx prisma migration show "$DIR"` — confirm **no destructive operation on data**: a re-rendered DROP+ADD of `Listing_status_check_*` is **expected and additive in effect** (S2) — classify it so and continue; **halt on any other destructive op**. Any drop/alter of an existing *column/table* is a plan violation: fix the contract instead.
- No data transform is added in this task — the location and search-text backfills are offline scripts (Tasks 2 and 4) per spec §8.6 (dry-run/apply/idempotency/rollback) and the Batch 2/4 precedent.
- Self-emit: `node "$DIR/migration.ts"` (regenerates `ops.json` + `migrationHash`); re-run `npx prisma migration show "$DIR"`.

- [ ] **Step 5: Apply to the dev DB and advance refs**

```bash
DIR="migrations/app/<ts>_batch5_search_telemetry"       # thư mục do migration plan tạo
END_HASH="<to-hash của migration.json trong $DIR>"       # dán giá trị — KHÔNG dùng <...> trực tiếp (zsh đọc là redirection)
npx prisma db migrate --advance-ref db                   # dev DB (DATABASE_URL từ .env, container 5435)
npx prisma migration ref set production "$END_HASH"      # docker-compose.prod.yml migrate service chạy --to production
npx prisma db verify
```

`production` ref must be advanced in the same commit (same rule as Batch 2/4 Task 1).

- [ ] **Step 6: Run the integration test to verify it passes**

Run: `npm run test:integration`
Expected: PASS (all `batch5-migration` cases + existing `escrow.test.ts` + Batch 2/3/4 suites green).

- [ ] **Step 7: Commit**

```bash
git add src/prisma/contract.prisma src/prisma/contract.json src/prisma/contract.d.ts migrations/app migrations/snapshots tests/integration/batch5-migration.test.ts
git commit -m "feat(db): add batch 5 search, location & telemetry contract"
```

**Gate:** no destructive op on data in `migration show` (the `Listing_status_check_*` DROP+ADD pair expected and additive in effect — S2); `db verify` clean; finance + Batch 2/3/4 integration invariants still green; graph stays linear (S2).

## Task 2: Location module + legacy-location backfill + locationSource hook

**Files:**

- Create: `src/lib/location.ts` (consumes Batch 2 Task 10's `src/lib/provinces.ts` — FD-1; Batch 5 never creates or edits the registry module)
- Create: `scripts/backfill-listing-location.ts`
- Modify: `src/lib/actions/listings.ts` (locationSource hook in create/update/saveDraft/submit — the only `listings.ts` change in this task; **no CITIES guard, no code derivation** — B2)
- Test: `tests/unit/location.test.ts`
- Test: `tests/integration/listing-location.test.ts`

**Interfaces:**

- Consumes: **the 34-unit province registry (Batch 2 Task 10's plain `src/lib/provinces.ts` — FD-1: stable slug codes, `displayName`, `kind`, merged legacy units, per NQ 202/2025/QH15; consumed read-only)**, `CITIES` (`src/lib/constants.ts`), `Listing.locationSource` + Batch 4's location columns (Task 1), Batch 4's `saveListingDraftAction`/`submitListingAction`/`createListingAction`/`updateListingAction`, `isValidProvinceCode` (registry helper).
- Produces (used by Tasks 7, 10 and by the backfill):

```ts
// src/lib/provinces.ts — DO NOT CREATE (Batch 2 Task 10 sở hữu — FD-1). PLAIN MODULE (không db, không
// server-only). Nội dung: 34 đơn vị cấp tỉnh per NQ 202/2025/QH15 (nguồn founder-approved:
// /tmp/loaviet/provinces-34.md) — stable slug codes ("ha-noi", "ho-chi-minh", …), displayName, kind,
// merged legacy units. Batch 5 CHỈ import; nếu export shape khác ví dụ dưới đây thì adapt import —
// nội dung 34 đơn vị là contract.

// src/lib/location.ts — Batch 5's module (consumes the registry)
export { isValidProvinceCode, provinceName } from "@/src/lib/provinces"; // re-export cho tiện — tên theo module Batch 2 shipped

export const BETA_PRIMARY_MARKET_PROVINCE = "ha-noi";      // Hà Nội (spec §5.9.1 — slug code theo registry FD-1)
export const BETA_SECONDARY_MARKET_PROVINCE = "ho-chi-minh"; // TP. Hồ Chí Minh

/**
 * FD-1 rule (nguyên văn đáy /tmp/loaviet/provinces-34.md): legacy free-text city/province maps to a
 * new unit ONLY khi nó bằng — sau NFC + trim + case-fold + diacritic-insensitive compare, và đã strip
 * các tiền tố phổ biến "Tỉnh"/"TP."/"Thành phố" — MỘT trong các legacy unit names của registry
 * (merged-legacy-units list là AUTHORITATIVE per NQ 202/2025/QH15 — "Bình Dương" → ho-chi-minh,
 * "Thừa Thiên Huế" → hue là áp nguồn của founder, KHÔNG phải đoán). "Khác", district/ward names,
 * typos, và mọi chuỗi không nằm trong danh sách → unresolved. KHÔNG so khớp displayName;
 * KHÔNG hand-author bảng per-city.
 */

export type LegacyLocationResolution =
  | { provinceLevelCode: string; source: "legacy_mapped" }
  | { provinceLevelCode: null; source: "unresolved" };

/** Thực thi FD-1 rule ở trên (so khớp normalized + strip tiền tố, CHỈ với legacy unit names của registry). */
export function resolveLegacyLocation(legacyCity: string | null | undefined): LegacyLocationResolution;

/** Nhãn trung tính — "Khu vực beta trọng điểm", KHÔNG BAO GIỜ ngôn ngữ an toàn/bảo đảm (spec §4.7). */
export function betaMarketLabel(): string;
```

```ts
// src/lib/actions/listings.ts — hook locationSource (S4/B2 — Batch 5 viết DUY NHẤT locationSource):
//   createListingAction / saveListingDraftAction: payload có provinceLevelCode hợp lệ (Batch 4 form) →
//     locationSource: "seller_declared"; không có trường province (legacy regime) → locationSource: null
//     (legacy path giữ nguyên hành vi hiện có — KHÔNG thêm CITIES guard, KHÔNG suy mã từ city — B2)
//   updateListingAction: input mang provinceLevelCode hợp lệ → "seller_declared";
//     input KHÔNG mang province (legacy regime edit) → GIỮ NGUYÊN locationSource hiện có (không đè)
//   submitListingAction: locationSource IS NULL && isValidProvinceCode(row.provinceLevelCode) →
//     "seller_declared" (mã do Batch 4 form ghi lúc tạo draft — seller-declared theo cấu trúc);
//     mã null → để null (backfill lo)
//   KHÔNG BAO GIỜ đụng: R5 guards (Batch 3), assertListingPublishable/assertListingContentValid (Batch 4)
```

```ts
// scripts/backfill-listing-location.ts — offline maintenance command (spec §8.6 + §5.1.1 posture)
// Usage: tsx scripts/backfill-listing-location.ts [--apply]
// main-module guard: chỉ chạy main() khi được gọi trực tiếp (import.meta.url === process.argv[1] resolve) —
// integration test import hàm mà KHÔNG chạy side effect (nit).
export async function backfillListingLocation(isApply: boolean): Promise<{
  scanned: number; mapped: number; unresolved: number; declaredBackfilled: number; alreadyDone: number;
  declaredIds: string[];   // id các row Batch-4-coded mà backfill đánh dấu seller_declared — cho rollback (B3)
}>;
// - dry-run mặc định: in count theo từng resolution + sample id, KHÔNG ghi gì
// - --apply, với mỗi Listing WHERE locationSource IS NULL (S4 — idempotent, không đè gì đã có):
//     1. isValidProvinceCode(provinceLevelCode) → locationSource = "seller_declared" (mã do Batch 4 ghi —
//        KHÔNG đụng mã, KHÔNG đụng city) — record id vào declaredIds (rollback chỉ null locationSource)
//     2. provinceLevelCode NULL → resolveLegacyLocation(city) theo FD-1 rule:
//        mapped     → provinceLevelCode = mã registry + locationSource = "legacy_mapped"
//        unresolved → locationSource = "unresolved" (không ghi mã — KHÔNG đoán)
//     KHÔNG đụng city / locationDisplayName (legacy text giữ nguyên byte — spec §8.3)
// - từ chối chạy khi thiếu DATABASE_URL
```

- [ ] **Step 1: Write the failing unit tests**

`tests/unit/location.test.ts` (pure modules — no db mock needed):

- `resolveLegacyLocation maps every province-named CITIES entry via the FD-1 rule` — table-driven, the **drift guard**: `"Hà Nội"` → `ha-noi`; `"TP. Hồ Chí Minh"` → `ho-chi-minh` (prefix stripped, diacritic-insensitive); `"Đà Nẵng"` → `da-nang`; `"Hải Phòng"` → `hai-phong`; `"Cần Thơ"` → `can-tho`; **`"Bình Dương"` → `ho-chi-minh` (merged legacy unit of TP. Hồ Chí Minh — authoritative per NQ 202/2025/QH15, FD-1)**; `"Đồng Nai"` → `dong-nai`; `"Khánh Hòa"` → `khanh-hoa`; `"Lâm Đồng"` → `lam-dong`; `"Nghệ An"` → `nghe-an`; `"Quảng Ninh"` → `quang-ninh`; **`"Thừa Thiên Huế"` → `hue` (the pre-2025 name of Huế — the 2025 rename, founder-endorsed per FD-1; if the shipped registry's legacy-name data lacks it, the test fails → raise it as a Batch 2 data gap, never patch it silently)**; `"Khác"` → `unresolved`. Adding a `CITIES` entry that does not resolve through the rule fails the test.
- `resolveLegacyLocation rejects the non-authoritative`: a district/ward string → `unresolved`; a typo (`"Ha Noii"`) → `unresolved`; `null`/`""` → `unresolved`; `"Hà Nội "` (trailing whitespace) → maps (NFC + trim — B7); `"Hà  Nội"` (internal double space) → `unresolved` (no internal collapse — non-guessing); `"Tỉnh Hà Nội"` / `"Thành phố Đà Nẵng"` → map (common prefixes stripped per the rule).
- `isValidProvinceCode("ha-noi") true; "khong-ton-tai" false; "" false`; `provinceName` round-trips against the registry fixture.
- `betaMarketLabel() returns "Khu vực beta trọng điểm"` and the module source contains no `an toàn`/`bảo đảm`/`đảm bảo`/`guarantee` trust wording (source-contract assertion, spec §4.7).
- `location.ts does not create or re-declare the registry` — source-contract: `src/lib/location.ts` imports from `@/src/lib/provinces` and contains no inline province table (FD-1 — the registry is Batch 2 Task 10's; the test mocks the registry import with a fixture matching the 34-unit shape).

- [ ] **Step 2: Run to verify failure** → `npm test -- tests/unit/location.test.ts` → FAIL (modules missing).

- [ ] **Step 3: Implement + wire the hook**

- `src/lib/location.ts` per the interface block: `BETA_PRIMARY_MARKET_PROVINCE`/`BETA_SECONDARY_MARKET_PROVINCE` slug constants; `resolveLegacyLocation` implementing the FD-1 rule (private normalized-compare helper: NFC + trim + lowercase + combining-mark strip + `đ`/`Đ` — same semantics as Task 3's `stripDiacritics`, kept private so Task 2 stays independent of Task 3 in the parallel map; prefix strip `"Tỉnh "`/`"TP. "`/`"Thành phố "` on both sides; compare against the registry's legacy unit names only — never display names); `betaMarketLabel`. **The registry itself is Batch 2 Task 10's `src/lib/provinces.ts` — do not create or edit it (FD-1); if its shipped export shape differs, adapt the import.**
- `scripts/backfill-listing-location.ts` per the interface block (dry-run/`--apply`/idempotent/refuse-without-`DATABASE_URL`/main-module guard); documented rollback (B3):
  - `UPDATE … SET locationSource = NULL WHERE locationSource IN ('legacy_mapped', 'unresolved')` **and** `provinceLevelCode = NULL` for the `legacy_mapped` rows (both fields were backfill-written);
  - `UPDATE … SET locationSource = NULL WHERE id IN (<declaredIds>)` — **locationSource only**: the code on those rows is Batch 4's seller-declared data and is never nulled (B3).
- `src/lib/actions/listings.ts`: the locationSource hook per the interface block — in `createListingAction`/`saveListingDraftAction`/`updateListingAction`/`submitListingAction`, reading only what each action already loads; **no CITIES validation, no city→code derivation, no touch of any guard/gate call** (B2/S5).

- [ ] **Step 4: Write the integration test — the unknown-legacy-location migration gate**

`tests/integration/listing-location.test.ts` (real DB; seeds listings directly via `db.orm.public.Listing.create`; per S-22 the action-path cases reuse the Batch 4 verified-seller fixture pattern — `tests/integration/listing-publication.test.ts`'s seller fixture — and mock `listing-publication`/`listing-images`/`audit-event` exactly like the Batch 4 integration stubbing recipe):

- `backfill dry-run reports counts and writes nothing`; `--apply maps rule-matched legacy rows and marks the rest unresolved`: seed one listing per case — `"Hà Nội"` → `provinceLevelCode = "ha-noi"`, `locationSource = "legacy_mapped"`; **`"Bình Dương"` → `provinceLevelCode = "ho-chi-minh"`, `locationSource = "legacy_mapped"` (FD-1 — merged legacy name maps to the new unit, authoritative)**; `"Khác"` → null code + `"unresolved"`; a district string → `"unresolved"`; a typo → `"unresolved"`; `city` reads back **byte-identical** before/after in every case (spec §8.3 preserve).
- `a Batch-4-created row with a valid code is marked seller_declared and its code is never overwritten` (B3): seed a listing with `provinceLevelCode: "ha-noi"`, `locationSource: null` (the pre-backfill Batch 4 shape) → `--apply` → `locationSource = "seller_declared"`, code unchanged, `city` unchanged; a second `--apply` changes nothing (`alreadyDone`).
- `rollback nulls only what the backfill wrote`: run the documented rollback SQL with the recorded `declaredIds` → legacy-mapped rows lose code + source; unresolved rows lose source; declared rows lose **only** `locationSource` (code intact).
- `action path sets seller_declared only from a valid Batch 4 code`: through `createListingAction` with a beta-regime input (province code from the form) → `locationSource = "seller_declared"`; through the **legacy-regime** input (no province field, `city` free text) → `locationSource` stays null and `city` keeps its submitted value (B2 — legacy path unchanged); `submitListingAction` on a Batch-4-era draft (code set, source null) → `"seller_declared"`.
- `province filter query returns only canonical-matching rows`: seed `"ha-noi"`-coded + `"da-nang"`-coded + unresolved listings (approved), query `where({ status: "approved", provinceLevelCode: "ha-noi" })` → only the Hà Nội row (unresolved rows invisible to province filters by design — never guessed).

- [ ] **Step 5: Run until green**

Run: `npm test -- tests/unit/location.test.ts` → PASS.
Run: `npm run test:integration` → `listing-location.test.ts` + `batch5-migration.test.ts` + `escrow.test.ts` + Batch 2/3/4 suites PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/location.ts scripts/backfill-listing-location.ts src/lib/actions/listings.ts tests/unit/location.test.ts tests/integration/listing-location.test.ts
git commit -m "feat(location): canonical province source with legacy preservation"
```

## Task 3: Search normalization module (diacritics incl. đ + spacing variants)

**Files:**

- Create: `src/lib/search-normalize.ts`
- Test: `tests/unit/search-normalize.test.ts`

**Interfaces:**

- Consumes: nothing (pure `node:string` + regex — no dependency).
- Produces (used by Tasks 4, 5, 7):

```ts
// src/lib/search-normalize.ts — pure, không import db/server-only: unit test trực tiếp
export function stripDiacritics(input: string): string;
//   NFD → bỏ combining marks (Unicode \p{Mn}) → đ→d / Đ→D (B5: đ/Đ KHÔNG có canonical decomposition —
//   NFD không tách được, phải replace riêng) → NFC. "Đà Nẵng đỏ" → "Da Nang do".

export function normalizeSearchText(input: string): string;
//   stripDiacritics + lowercase + collapse whitespace + trim. "  LOA  JBL   Charge 4 " → "loa jbl charge 4"

export function spacingVariants(normalized: string): string[];
//   biến thể spacing ở ranh giới CHỮ↔SỐ (spec §5.7 examples — B6):
//   "charge4" → ["charge4", "charge 4"]; "charge 4" → ["charge 4", "charge4"]
//   "emberton2" → ["emberton2", "emberton 2"]; "emberton 2" → ["emberton 2", "emberton2"]
//   KHÔNG sinh biến thể chữ↔chữ ("soundlink"↔"sound link" cần từ điển — B6: việc đó thuộc
//   compact matching của resolveSearchQuery, Task 5)
//   dedup + giữ nguyên chuỗi gốc đầu tiên

export function compactForm(normalized: string): string;
//   dạng bỏ toàn bộ khoảng trắng — "sound link" → "soundlink" — cho compact matching ở Task 5 (B6)

export function isMalformedQuery(raw: string): boolean;
//   blank sau trim | > 120 ký tự | chứa control chars — exclusion "malformed query" (spec §5.8.1)
```

- [ ] **Step 1: Write the failing unit tests** — the **diacritic gate**:

- `stripDiacritics`: `"Đà Nẵng" → "Da Nang"`; `"Hà Nội" → "Ha Noi"`; `"Thừa Thiên Huế" → "Thua Thien Hue"`; **`"đỏ" → "do"` (B5 — đ has no canonical decomposition)**; **`"Đà Nẵng đỏ" → "Da Nang do"`**; `"Điện Biên" → "Dien Bien"`; `"loa" → "loa"` (no-op); **already-NFD input (macOS precomposed vs decomposed) → identical output** (normalize the comparison: `stripDiacritics("ệ".normalize("NFD")) === stripDiacritics("ệ")`).
- `normalizeSearchText`: `"  LOA  JBL   Charge 4 "` → `"loa jbl charge 4"`; `"JBL Flip 6" → "jbl flip 6"`; empty → `""`.
- `spacingVariants` — the spec §5.7 letter↔digit examples verbatim: `"charge4" → ["charge4", "charge 4"]`; `"charge 4" → ["charge 4", "charge4"]`; `"emberton2" → ["emberton2", "emberton 2"]`; `"emberton 2" → ["emberton 2", "emberton2"]`; no digit boundary → single-element array (`["jbl"]`); **`"soundlink" → ["soundlink"]` (B6 — no letter↔letter split; the soundlink↔sound link equivalence is compact matching's job, tested in Task 5)**.
- `compactForm`: `"sound link" → "soundlink"`; `"charge 4" → "charge4"`; `"jbl" → "jbl"`.
- `isMalformedQuery`: `""` true; `"   "` true; 121-char string true; 120-char string false; `"loa\u0000"` true; `"loa jbl"` false.

- [ ] **Step 2: Run to verify failure** → `npm test -- tests/unit/search-normalize.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement**

- `stripDiacritics`: `input.normalize("NFD").replace(/\p{Mn}/gu, "").replace(/đ/g, "d").replace(/Đ/g, "D").normalize("NFC")` (Unicode property escape — Node ≥ 22 supports it; the explicit `đ`/`Đ` replacement is load-bearing — B5).
- `normalizeSearchText`: strip → `toLowerCase()` → `.replace(/\s+/g, " ")` → trim.
- `spacingVariants`: for each token boundary between a letter and an adjacent digit *within* the normalized string, generate the insert-space and remove-space forms; dedup preserving order, original first. Letter↔letter boundaries are **not** touched (B6).
- `compactForm`: `.replace(/\s+/g, "")`.
- `isMalformedQuery`: blank-after-trim, `raw.length > 120`, or `/[\u0000-\u001F\u007F]/` test.

- [ ] **Step 4: Run until green** → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/search-normalize.ts tests/unit/search-normalize.test.ts
git commit -m "feat(search): diacritic-insensitive normalization module"
```

## Task 4: Normalized search text maintenance + backfill

**Files:**

- Modify: `src/lib/actions/listings.ts` (searchTextNormalized hook in create/update/saveDraft/submit — runs after Task 2's change to the same file, S5)
- Create: `scripts/backfill-listing-search-text.ts`
- Test: `tests/unit/listing-search-text.test.ts`
- Test: `tests/integration/listing-search-text.test.ts`

**Interfaces:**

- Consumes: `normalizeSearchText` (Task 3), `Listing.searchTextNormalized` (Task 1), `Brand`/`ProductModel` names, Batch 4's action shapes.
- Produces: every create/update/draft/submit path leaves `searchTextNormalized` = `normalizeSearchText([title, brand?.name ?? "", model?.name ?? ""].join(" "))`; existing rows backfilled; `--recompute-all` repairs staleness (S-4).

```ts
// scripts/backfill-listing-search-text.ts — offline maintenance command (spec §8.6 posture)
// Usage: tsx scripts/backfill-listing-search-text.ts [--apply] [--recompute-all]
// main-module guard như Task 2 (nit). export async function backfillListingSearchText(isApply: boolean, recomputeAll?: boolean): Promise<{ scanned: number; updated: number; alreadyDone: number }>;
// - mặc định: mỗi Listing WHERE searchTextNormalized IS NULL → load + brand.name + productModel.name → normalize → update
// - --recompute-all: MỌI row tính lại (S-4 — sửa staleness sau brand/model rename, catalog merge, seed Batch 4)
// - idempotent (default mode); từ chối khi thiếu DATABASE_URL
// - rollback: KHÔNG cần — cột derived, luôn tính lại được (chạy lại backfill / --recompute-all)
```

- [ ] **Step 1: Write the failing unit tests**

`tests/unit/listing-search-text.test.ts` (mock db with in-memory `Listing`/`Brand`/`ProductModel` fixtures + spies, same style as the finance tests; per S-22 mock `listing-publication`/`listing-images`/`audit-event` so the Batch 4 wrappers don't fire in unit context):

- `createListingAction stores normalized title+brand+model text`: fixture brand `"JBL"`, model `"Charge 5"`, title `"Loa JBL Charge 5 như mới"` → persisted `searchTextNormalized` === `"loa jbl charge 5 nhu moi jbl charge 5"` (assert exact string).
- `saveListingDraftAction stores the same normalized text on a draft` (S5 — the draft path is hooked too).
- `updateListingAction recomputes when title changes` (old normalized text replaced).
- `submitListingAction backfills a null searchTextNormalized from the DB row` (a Batch-4-era draft with null text → submit → text computed from the row's title/brand/model — S5).
- `listing without brand/model normalizes title only`.

- [ ] **Step 2: Run to verify failure** → FAIL (actions don't write the column yet).

- [ ] **Step 3: Implement**

- In `createListingAction`/`saveListingDraftAction`/`updateListingAction`: after the existing brand/model validation loads those rows, compute the normalized text and include `searchTextNormalized` in the `create`/`update` payload. In `submitListingAction`: if `listing.searchTextNormalized == null` → recompute from the DB row's title + brand + model and include it in the status update. **No other behavior change; no guard/gate call touched** (S5).
- `scripts/backfill-listing-search-text.ts` per the interface block: loads each null-text (or, with `--recompute-all`, every) listing with its brand/model names (`.include`), normalizes, updates; exports the function for the integration test; main-module guard. **Staleness procedure (S-4):** `searchTextNormalized` embeds brand/model *names*, so it drifts on brand/model rename, catalog merges, and the Batch 4 seed — the repair is `--recompute-all`, and the procedure (run it after `seed-beta-catalog --apply` and after any `/admin/catalog` model edit) is recorded in the script header and the Task 11 verification doc; no hook into Batch 4's catalog action is added (their file, their call — flagged as a coordination note instead).

- [ ] **Step 4: Write the integration test**

`tests/integration/listing-search-text.test.ts` (real DB):

- `backfill dry-run reports; --apply fills every null row; idempotent second run changes 0`; `--recompute-all rewrites every row` (S-4).
- `normalized text is queryable via the simple-language full-text index`: seed a listing titled `"Loa JBL Charge 4"` → after backfill, `websearchToTsquery("loa jbl charge 4", { language: "simple" })` + `searchTextNormalized.fullTextMatches(tsq, { language: "simple" })` finds it; `"LOA JBL CHARGE 4"` (same after normalization) finds it; **`"loa do"` round-trips** — a listing titled `"Loa đồ chơi"` normalizes to `"loa do choi"` and is found by the query `"loa do"` (S-1 — the `simple` language keeps the `do` token; with `english` it would be a stopword and the test documents why); `"loa nonexistent xyz"` does not.

- [ ] **Step 5: Run until green**

Run: `npm test -- tests/unit/listing-search-text.test.ts` → PASS; `npm run test:integration` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/actions/listings.ts scripts/backfill-listing-search-text.ts tests/unit/listing-search-text.test.ts tests/integration/listing-search-text.test.ts
git commit -m "feat(search): maintain normalized listing search text"
```

## Task 5: Alias resolution mechanism

**Files:**

- Create: `src/lib/search-resolve.ts`
- Create: `scripts/seed-search-aliases.ts` (S9 — idempotent, empty/founder-reviewed content)
- Test: `tests/unit/search-resolve.test.ts`

**Interfaces:**

- Consumes: `SearchAlias` (Task 1), `Brand`/`ProductModel` (current catalog — the Batch 4 fallback seam), `normalizeSearchText`/`spacingVariants`/`compactForm` (Task 3).
- Produces (used by Task 7; extended with content by Batch 4/8):

```ts
// src/lib/search-resolve.ts
export type SearchResolution = {
  textVariants: string[];     // các dạng chuẩn hóa + spacing variants (letter↔digit) để build MỘT tsquery OR-joined
  brandIds: string[];         // từ SearchAlias(target=brand) + fallback catalog match
  productModelIds: string[];  // từ SearchAlias(target=model) + fallback catalog match
};

/** Giải query thô → structured ids. KHÔNG trả về/persist query text (spec §4.8 — query là free text). */
export async function resolveSearchQuery(rawQuery: string): Promise<SearchResolution>;

export const SEARCHABLE_MODEL_STATUSES = ["approved"] as const; // fallback catalog chỉ duyệt approved (seam cho Batch 4)

// Matching (B6/S-3) — WHOLE-QUERY equality, không phải token-subset:
//   1. EXACT: normalizeSearchText(query) === SearchAlias.alias → target ids
//   2. SPACING: mỗi spacingVariants(q) === alias → target ids
//   3. COMPACT (B6): compactForm(q) === compactForm(alias) → "sound link" khớp alias "soundlink"
//   4. FALLBACK CATALOG (S-3): exact/spacing/compact equality của WHOLE normalized query (hoặc một
//      variant) với Brand.name/ProductModel.name (approved) → ids. KHÔNG OR toàn bộ brand listings
//      khi query gọi tên một model — chỉ id của chính brand/model được gọi tên.
//   Optional (nit): prefix match `tsquery\`${lastToken}:*\`` cho token cuối — chỉ khi không resolve gì ở 1–4.
```

```ts
// scripts/seed-search-aliases.ts — S9: offline maintenance command, dry-run mặc định, --apply, idempotent
// (create-if-absent theo (alias, target)), content EMPTY hoặc founder-reviewed (A7) — implementer
// KHÔNG tự biên alias catalog từ training data. main-module guard như Task 2.
export async function seedSearchAliases(isApply: boolean, aliasesFile?: string): Promise<{ created: number }>;
```

- [ ] **Step 1: Write the failing unit tests** — the **alias gate**:

`tests/unit/search-resolve.test.ts` (mock db with fixture `SearchAlias`/`Brand`/`ProductModel` tables):

- `exact normalized alias resolves to its target`: fixture `SearchAlias { alias: "soundlink", target: "model", productModelId: "m1" }` → `resolveSearchQuery("SoundLink")` includes `"m1"` in `productModelIds` (alias stored normalized; query normalized before lookup).
- `spacing variants of the query match`: fixture alias `"charge 4"` → `resolveSearchQuery("charge4")` resolves it (variant `"charge 4"`).
- `compact matching closes the letter↔letter gap (B6)`: fixture alias `"soundlink"` → `resolveSearchQuery("sound link")` resolves it (compactForm `"soundlink"` === compactForm of the query) — **the spec's soundlink↔sound link example lives here, not in spacingVariants**.
- `fallback: catalog name match resolves brand/model ids`: fixture `Brand { name: "JBL" }`, `ProductModel { name: "Charge 5", status: "approved" }` → `resolveSearchQuery("jbl")` → `brandIds` contains the brand; `resolveSearchQuery("charge 5")` → `productModelIds` contains the model; `resolveSearchQuery("sound link")` against a fixture `ProductModel { name: "SoundLink" }` → resolves via compact/normalized equality (B6 test point); a `pending`-status model does NOT resolve (only approved catalog entries).
- `whole-query equality only (S-3)`: a query naming a model (`"charge 5"`) does **not** add the model's brand's *listings* or any other brand to the resolution — only the named ids; a query matching nothing (`"xyz abc"`) → empty ids, textVariants only (search still works via full-text).
- `resolution output contains no raw query text` (structural: the returned object has only the three arrays).
- `seed script: dry-run writes nothing; --apply creates founder-reviewed rows idempotently; second --apply = 0 created` (S9).

- [ ] **Step 2: Run to verify failure** → FAIL (module missing).

- [ ] **Step 3: Implement**

- `resolveSearchQuery`: `normalizeSearchText(rawQuery)` → `spacingVariants` → (1) exact alias lookup, (2) per-variant alias lookup, (3) compact alias lookup (`compactForm` both sides), (4) fallback catalog: load `Brand` rows + `ProductModel.where({ status: "approved" })` (P0 catalog is small; per-search load acceptable at beta scale — noted in code), normalize/compact each name in TS, **whole-query** equality against the query or a variant → ids. Dedup ids. Never return or log the raw/normalized query beyond this function's transient use.
- `scripts/seed-search-aliases.ts` per the interface block (S9): reads an optional founder-supplied `--aliases <file>` (alias, target, brandId/modelModelId) — **the implementer never authors alias content** (A7); create-if-absent by `(alias, target)`; refuses without `DATABASE_URL`; main-module guard.

- [ ] **Step 4: Run until green** → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/search-resolve.ts scripts/seed-search-aliases.ts tests/unit/search-resolve.test.ts
git commit -m "feat(search): alias resolution mechanism"
```

## Task 6: Product-event taxonomy + emit core (schemas, PII guard, dedicated-key pseudonyms)

**Files:**

- Create: `src/lib/product-event-key.ts` (plain module — importable by the offline seed script, Batch 2 `admin-mfa-key.ts` precedent)
- Create: `src/lib/product-events.ts` (`import "server-only"` — S-13)
- Modify: `src/lib/env.ts` (validate `PRODUCT_EVENT_PSEUDONYM_KEY` — S-11)
- Modify: `.env.example`, `docker-compose.prod.yml`, `scripts/preflight.sh` (compose gate placeholder env — Batch 2 Task 8 pattern)
- Test: `tests/unit/product-events.test.ts`

**Interfaces:**

- Consumes: `ProductEvent` model (Task 1), `getSessionFromCookie` (Batch 2), `BetaCohortMembership` + `User.adminRole` (S-12), `captureError` (`src/lib/observability.ts`).
- Produces (used by Tasks 7, 8, 9, 10; by Batch 6/7 emission later):

```ts
// src/lib/product-event-key.ts — PLAIN MODULE (không server-only — seed script import được)
export function getProductEventPseudonymKey(): Buffer;
//   Buffer.from(process.env.PRODUCT_EVENT_PSEUDONYM_KEY, "base64") — throw typed
//   PRODUCT_EVENT_KEY_UNCONFIGURED / PRODUCT_EVENT_KEY_INVALID (không phải base64 của đúng 32 byte).
//   DÀNH RIÊNG — KHÔNG derive từ AUTH_SECRET (S-11: rotation AUTH_SECRET không phá pseudonym/join).
//   Server-only: KHÔNG NEXT_PUBLIC_*, KHÔNG log giá trị.
export function productEventPseudonymKeyVersion(): string; // "1" — bump khi rotate key; ghi vào mỗi row (S-11)
export function productEventPseudonymKeyInfo(info: string): Buffer;
//   HKDF-SHA256 từ dedicated key với info string — "product-event-actor" / "product-event-session"

// src/lib/product-events.ts — import "server-only", KHÔNG BAO GIỜ "use server" (S-13)
export const PRODUCT_EVENT_SCHEMA_VERSION = "1";

export type ProductEventName =
  | "search_submitted" | "search_zero_result" | "search_result_clicked"
  | "listing_viewed" | "conversation_started" | "conversation_buyer_first_message" | "message_first_response"
  | "deal_created" | "deal_outcome_marked" | "successful_match"
  | "listing_marked_sold" | "report_submitted" | "user_returned"
  | "seller_invited" | "seller_registered" | "seller_verified"
  | "seller_first_listing_published" | "listing_rejected" | "listing_removed"
  | "beta_membership_activated";
//   19 event của spec §5.8 + "conversation_buyer_first_message" — MỘT event tín hiệu cơ học do contract
//   seller_response_rate_v1 yêu cầu (D4: eligible = ≥1 buyer message) — flagged cho founder, schema-versioned.

/** Pseudonym actor — HMAC-SHA256(userId, HKDF(dedicated key, "product-event-actor")) hex. Ổn định per user per key version. */
export function actorPseudonymFor(userId: string): string;
/** Pseudonym session — HMAC-SHA256(sessionId, HKDF(dedicated key, "product-event-session")) hex (S-10). */
export function sessionPseudonymFor(sessionId: string): string;
/** internal = BetaCohortMembership(internal, active) ∪ User.adminRole != null — tính LÚC emit (S-12). */
export async function isInternalActor(userId: string): Promise<boolean>;

export type ProductEventInput = {
  name: ProductEventName;
  actorId?: string | null;        // raw user id — emit core tự pseudonymize, KHÔNG lưu id thô
  sessionId?: string | null;      // UserSession.id — tự pseudonymize thành sessionPseudonym (S-10)
  searchSessionId?: string | null;
  listingId?: string | null;
  productModelId?: string | null;
  conversationId?: string | null;
  provinceCode?: string | null;   // mã tỉnh canonical — coarse location
  metadata?: Record<string, unknown>;
};

export async function emitProductEvent(input: ProductEventInput): Promise<void>;
//   1. zod schema per event name (EVENT_SCHEMAS, .strict()) — sai schema → TELEMETRY_SCHEMA_REJECTED,
//      KHÔNG ghi row, captureError("telemetry", ...) CHỈ mang event name + rule, KHÔNG BAO GIỀ payload
//   2. PII guard (B8) — CHỈ quét FREE STRING fields của metadata (schema khai báo kiểu string tự do):
//      email-shape / phone-shape / OTP-6-digit-shape / IP-shape / string > 120 ký tự → TELEMETRY_PII_REJECTED,
//      KHÔNG ghi row, KHÔNG log giá trị. Các field id/enum đã được zod TYPED (z.uuid(), z.enum(...), number,
//      boolean, string[]) MIỄN NHIỄM quét shape — 6 chữ số liên tục trong một uuid hợp lệ KHÔNG bị từ chối.
//      Key denylist: exact/word match (không substring — "ip" không khớp "shipping"/"membership") (nit).
//   3. actorId → actorPseudonymFor; sessionId → sessionPseudonymFor; isInternalActor(actorId) → row.isInternal
//   4. insert ProductEvent với pseudonymKeyVersion; db error → captureError + return (fail-open cho flow)

export async function cohortPseudonyms(cohort: "internal" | "founding_seller" | "private_beta_buyer"): Promise<string[]>;
//   pseudonyms của member active của cohort — cho dashboard segmentation (KHÔNG phải exclusion — exclusion dùng isInternal)
```

Per-event metadata schemas (zod `.strict()`; **no schema has a free-text or query-text field**; id fields are `z.uuid()`-typed, enums are `z.enum(...)` — S-9/B8):

- `search_submitted`: `{ resultCount: z.number().int().min(0), resultListingIds: z.array(z.uuid()).max(60) (S-14 — the recorded result set for click attribution), categorySlug: z.string().min(1).nullish() (emitted ONLY when the param matched a loaded Category row), brandSlug: z.string().min(1).nullish() (same — validated against loaded Brand), conditionFilter: z.enum(["new","open_box","like_new","excellent","good","fair","refurbished","for_parts"]).nullish(), priceMin: z.number().int().nullish(), priceMax: z.number().int().nullish(), sort: z.enum(["newest","price_asc","price_desc","popular","relevance"]).nullish() }` — **no query text**; the buyer's selected province rides the typed `provinceCode` column, not metadata.
- `search_zero_result`: `{ resolvedBrandIds: z.array(z.uuid()), resolvedModelIds: z.array(z.uuid()) }` — the demand-interest record (spec §5.7.1): *what canonical brand/model was wanted*, never the raw text.
- `search_result_clicked`: `{}` (typed columns `searchSessionId` + `listingId` carry everything).
- `listing_viewed`: `{ ownerView: z.boolean(), fromSearch: z.boolean() }`.
- `conversation_started`: `{}` (columns: `conversationId`, `listingId`, `actorPseudonym` = buyer).
- `conversation_buyer_first_message`: `{}` (columns: `conversationId`, `listingId`; actor = buyer — the D4 eligibility signal).
- `message_first_response`: `{ responseMs: z.number().int().min(0) }` (columns: `conversationId`, `listingId`; actor = seller; anchored at the first buyer message — D4).
- `deal_created` / `deal_outcome_marked` / `successful_match` / `listing_marked_sold` / `report_submitted` / `user_returned` / `seller_invited` / `seller_registered` / `seller_verified` / `seller_first_listing_published` / `listing_rejected` / `listing_removed` / `beta_membership_activated`: minimal schemas now (`{}` or the typed columns) — emission lands with the owning batch/task (S7); the schema exists so later batches cannot emit unvalidated payloads.

- [ ] **Step 1: Write the failing unit tests** — the **event-schema validation + PII rejection gate**:

`tests/unit/product-events.test.ts` (mock db with an in-memory `ProductEvent` store; stub `PRODUCT_EVENT_PSEUDONYM_KEY` with a fixed 32-byte base64 test key):

- `actorPseudonymFor: 64-hex, stable per user, differs per user, and !== userId`; `sessionPseudonymFor` same properties and !== the raw session id (S-10).
- `emitProductEvent writes name/schemaVersion/occurredAt/pseudonym/pseudonymKeyVersion/isInternal — never the raw actorId or raw sessionId` (persisted row's `actorPseudonym`/`sessionPseudonym` are the HMACs; no column/metadata value equals the raw ids).
- `isInternalActor: internal-cohort active member → true; adminRole != null → true; regular user → false` (S-12).
- `valid search_submitted passes and stores resultCount + resultListingIds in metadata`.
- `schema validation: unknown event name → rejected, no row`; `search_submitted with resultCount: "many" (wrong type) → rejected, no row`; `extra metadata key → rejected (strict schema)`; `sort: "weird" → rejected (z.enum — S-9)`; `resultListingIds with a non-uuid string → rejected (z.uuid())`.
- `PII rejection — no row written, and the rejection log carries the event name but NEVER the value`: metadata `{ note: "lienhe@example.com" }` → rejected; `{ phone: "0901234567" }` → rejected; `{ code: "123456" }` (OTP shape) → rejected; `{ ip: "10.0.13.37" }` (IP shape) → rejected; `{ body: <121-char string> }` → rejected; spy `console.error`/`captureError` payloads contain the event name + rule but not the offending value (Review Focus 1).
- **`1000 random UUIDs in id-typed fields are never rejected` (B8)** — `crypto.randomUUID()` × 1000 into `resultListingIds` (and as `listingId`) → all pass; the shape scan exempts schema-typed fields.
- `key denylist is exact/word match: a "shipping" key is NOT rejected by the "ip" denylist entry` (nit — no substring matching).
- `structural: no event schema contains a free-text/query field` — iterate `EVENT_SCHEMAS` and assert no key matches `/query|text|body|message|note|email|phone|address|name/i` (the allowlist is structural, not conventional).
- `db failure is swallowed (fail-open)`: mock `ProductEvent.create` to throw → `emitProductEvent` resolves without throwing (telemetry never breaks the product flow).
- `source-contract (S-13): product-events.ts imports "server-only" and contains no "use server" directive; product-event-key.ts is a plain module (no server-only)`.

- [ ] **Step 2: Run to verify failure** → FAIL (modules missing, env cases missing).

- [ ] **Step 3: Implement**

- `src/lib/product-event-key.ts`: `getProductEventPseudonymKey()` decodes and validates `PRODUCT_EVENT_PSEUDONYM_KEY` (base64 → exactly 32 bytes, typed errors, cached per process); `productEventPseudonymKeyInfo(info)` = `crypto.hkdfSync("sha256", key, Buffer.from("speaker-platform-product-event-v1"), Buffer.from(info), 32)` — same HKDF shape as Batch 2's helper but **sourced from the dedicated key, never `AUTH_SECRET`** (S-11); `productEventPseudonymKeyVersion()` returns the current version constant (`"1"`).
- `src/lib/env.ts`: add `PRODUCT_EVENT_PSEUDONYM_KEY` to the production-required set + strict base64-32 validation (all environments, validated when set) — mirror Batch 2's `ADMIN_MFA_ENCRYPTION_KEY` cases in `tests/unit/env.test.ts` (extend that suite in this task's commit).
- `src/lib/product-events.ts`: `import "server-only"`; `EVENT_SCHEMAS` per the interface block; `emitProductEvent` validates → PII-guards **free string fields only** (walk metadata; for values whose schema field is a free `z.string()`, apply the email `/[^\s@]+@[^\s@]+\.[^\s@]/`, phone `/(\+84|0)\d{9,10}/`, OTP `/(^|\D)\d{6}(\D|$)/`, IP `/(\d{1,3}\.){3}\d{1,3}/` + IPv6 shape, and 120-char cap regexes; `z.uuid()`/`z.enum`/`z.number()`/`z.boolean()`/`z.array()`-typed fields are exempt — B8) → computes pseudonyms + `isInternal` → inserts with `pseudonymKeyVersion`. Rejection → `captureError("telemetry", "TELEMETRY_PII_REJECTED" | "TELEMETRY_SCHEMA_REJECTED", { name })` — the value is never logged. Insert wrapped in try/catch → `captureError` on failure (fail-open).
- `.env.example` + `docker-compose.prod.yml`: `PRODUCT_EVENT_PSEUDONYM_KEY` with `openssl rand -base64 32` instructions; compose uses required interpolation `${PRODUCT_EVENT_PSEUDONYM_KEY:?…}` (same pattern as `AUTH_SECRET`); `scripts/preflight.sh` compose-config gate passes a placeholder value for it.

- [ ] **Step 4: Run until green** → PASS; then `npm test` full unit suite green (incl. the extended `env.test.ts`).

- [ ] **Step 5: Commit**

```bash
git add src/lib/product-event-key.ts src/lib/product-events.ts src/lib/env.ts .env.example docker-compose.prod.yml scripts/preflight.sh tests/unit/product-events.test.ts tests/unit/env.test.ts
git commit -m "feat(telemetry): product event taxonomy with PII rejection"
```

## Task 7: Search page integration — normalized search, ranking, location filter, zero-result recovery, rate limit, search telemetry

**Files:**

- Create: `src/lib/search-query.ts`
- Create: `src/lib/search-telemetry.ts` (S-5/S-7 — rate-limit key derivation + `runSearchWithTelemetry`, unit-testable without rendering the page)
- Modify: `app/listings/page.tsx`
- Modify: `src/components/listing-card.tsx` (optional `searchSessionId` prop → `?ss=` + `prefetch={false}` — S-8)
- Modify: `tests/unit/listing-draft-actions.test.ts` (retarget Batch 4's "draft not publicly visible" source assertion to `SEARCHABLE_LISTING_STATUSES` — S-21, same commit, not weakened)
- Test: `tests/unit/search-query.test.ts`
- Test: `tests/unit/search-telemetry.test.ts`
- Test: `tests/integration/search.test.ts`

**Interfaces:**

- Consumes: `normalizeSearchText`/`spacingVariants`/`isMalformedQuery` (Task 3), `resolveSearchQuery` (Task 5), `emitProductEvent` (Task 6), the province registry (Batch 2 Task 10's `src/lib/provinces.ts` — FD-1)/`BETA_PRIMARY_MARKET_PROVINCE`/`BETA_SECONDARY_MARKET_PROVINCE`/`resolveLegacyLocation` (Task 2), `BETA_PUBLICATION_CATEGORIES` (Batch 4 `src/lib/beta-categories.ts` — S8), `checkRateLimit`/`clientIpFromHeaders` (`src/lib/rate-limit.ts`), `getSessionFromCookie` (Batch 2), `websearchToTsquery` (`@prisma/orm-postgres/target/full-text`).
- Produces:

```ts
// src/lib/search-query.ts
export const SEARCHABLE_LISTING_STATUSES = ["approved"] as const;
//   SEAM (S6): tập trạng thái searchable sống ở ĐÂY — Batch 3 đã quyết định suspended sellers giữ
//   listing live (B3 A2) → KHÔNG suspension filter. Drift test liệt kê MỌI giá trị listing_status
//   từ contract, chỉ "approved" searchable.

export function isListingSearchable(status: string): boolean; // status ∈ SEARCHABLE_LISTING_STATUSES

export const BETA_SPEAKER_CATEGORY_SLUG = BETA_PUBLICATION_CATEGORIES[0];
//   "portable_bluetooth_speaker" — import từ Batch 4 (S8), KHÔNG fallback "loa-bluetooth" nữa.

export type SearchQueryPlan = {
  statuses: readonly string[];
  textVariants: string[];        // chuẩn hóa + spacing variants (để build MỘT tsquery OR-joined — S-2)
  brandIds: string[];
  productModelIds: string[];
  provinceFilter: string | null; // mã tỉnh canonical khi buyer chọn — explicit preference (spec §5.7 rule 5)
  categorySlug: string | null;
  condition: string | null;
  minPrice: number | null;
  maxPrice: number | null;
  exchangeOnly: boolean;
  sort: "newest" | "price_asc" | "price_desc" | "popular" | "relevance";
  hasQuery: boolean;
  // KHÔNG có trường priority-location-boost nào — cấu trúc kế hoạch không cho phép boost ngầm (Review Focus 3)
};

export function describeSearchQuery(
  params: { q?: string; category?: string; brand?: string; condition?: string; province?: string; city?: string; min?: string; max?: string; exchange?: string; sort?: string },
  resolution: SearchResolution,
): SearchQueryPlan;   // pure — unit test trực tiếp. `city` param (old links, nit) → resolveLegacyLocation
                      // (FD-1 rule, Task 2): mapped → provinceFilter; unmapped → ignored (all locations) — KHÔNG đoán.

export async function runSearchQuery(plan: SearchQueryPlan): Promise<{
  listings: Array<{ id: string; slug: string; title: string; price: number; condition: string; city: string; status: string; viewCount: number; acceptExchange: boolean; negotiable: boolean; provinceLevelCode: string | null; images: { url: string }[]; category: { name: string } | null; brand: { name: string } | null }>;
  resultCount: number;
}>;  // db — integration test. S-2 ORM form: where status ∈ SEARCHABLE_LISTING_STATUSES
      //   + (hasQuery ? fns.or(l.searchTextNormalized.fullTextMatches(tsq, { language: "simple" }),
      //                         ...brandIds.length ? [l.brandId.in(plan.brandIds)] : [],
      //                         ...modelIds.length ? [l.productModelId.in(plan.productModelIds)] : []) : facets)
      //   với tsq = websearchToTsquery(plan.textVariants.join(" or "), { language: "simple" }) — MỘT tsquery
      //   dùng cho CẢ match VÀ fullTextRank (S-2); `or` import từ @prisma/orm-postgres/orm-client;
      //   verify các chữ ký chính xác theo .agents/skills/prisma-8/references/queries-postgres.md trước khi viết.
      //   Facets: category/brand/condition/province (provinceLevelCode = plan.provinceFilter — canonical only;
      //   unresolved legacy rows chỉ hiện ở "all locations")/price/exchange như hôm nay.
      //   Order: hasQuery → fullTextRank(tsq) desc rồi createdAt desc (spec §5.7 ranking 1 + 4; status là filter,
      //   quality là seam Batch 4 ghi chú trong code); else 4 sort hiện có.
```

```ts
// src/lib/search-telemetry.ts — S-5/S-7: tách khỏi page component để unit test không phải render async page
export const SEARCH_RATE = { limit: 60, windowMs: 60_000 } as const; // tunable ops parameter (§7.1)

export function searchRateLimitKey(input: { userId: string | null; sessionPseudonym: string | null; ip: string }): string;
//   S-5: authed → `search:user:${userId}`; anonymous → `search:ip:${ip}` (TRUST_PROXY_HEADERS=false →
//   clientIpFromHeaders trả "local" → MỘT bucket chung cho mọi anonymous — fail-safe hiện có, documented;
//   CGNAT note: nhiều user thật có thể chung bucket — chấp nhận ở P0, ghi trong verification doc)

export type SearchTelemetryContext = {
  user: { id: string | null; sessionPseudonym: string | null };
  isPrefetch: boolean;          // từ request headers — verify tên header theo docs Next 16 đã cài (S-8)
  provinceFilter: string | null;
  facets: { categorySlug?: string | null; brandSlug?: string | null; conditionFilter?: string | null; priceMin?: number | null; priceMax?: number | null; sort?: string | null };
  resolution: SearchResolution;
};

export async function runSearchWithTelemetry(input: SearchTelemetryContext & {
  params: { q?: string; category?: string; brand?: string; condition?: string; province?: string; city?: string; min?: string; max?: string; exchange?: string; sort?: string };
  loadedCategories: { slug: string }[];   // S-9: chỉ emit slug khớp row đã load
  loadedBrands: { slug: string }[];
}): Promise<{ plan: SearchQueryPlan; listings: …; resultCount: number; searchSessionId: string | null; eventsEmitted: { submitted: boolean; zeroResult: boolean } }>;
//   1. isMalformedQuery(q) → KHÔNG rate limit, KHÔNG emit (browsing) — vẫn chạy search (S-5: limit chỉ áp
//      cho request mang query hợp lệ)
//   2. query hợp lệ → checkRateLimit(searchRateLimitKey(...), SEARCH_RATE) → denied → trả soft-throttle signal
//      (page render state "Bạn đang tìm nhanh quá…"), KHÔNG query, KHÔNG emit
//   3. searchSessionId = crypto.randomUUID(); runSearchQuery(plan)
//   4. !isPrefetch → emitProductEvent search_submitted { searchSessionId, actorId, sessionPseudonym,
//      provinceCode: provinceFilter, metadata: { resultCount, resultListingIds: listings.map(id).slice(0, 60),
//      categorySlug (chỉ khi khớp loadedCategories), brandSlug (chỉ khi khớp loadedBrands), conditionFilter,
//      priceMin, priceMax, sort } } — KHÔNG query text (S-9: sort/condition z.enum, slug validated)
//   5. resultCount === 0 → emit search_zero_result { searchSessionId, metadata: { resolvedBrandIds,
//      resolvedModelIds } } — demand record (spec §5.7.1)
//   6. trả eventsEmitted cho page — dòng "Chúng tôi đã ghi nhận nhu cầu này" render CHỈ KHI
//      eventsEmitted.zeroResult === true (S-6 — §4.2 no-misleading-promise)
```

- [ ] **Step 1: Write the failing unit tests**

`tests/unit/search-query.test.ts` (pure `describeSearchQuery` — no db):

- `normalizes the query and includes spacing variants in the plan`: `q: "Charge4"` → `textVariants` contains `"charge4"` + `"charge 4"`.
- `malformed/blank query → hasQuery: false, empty textVariants` (browsing — excluded from search metrics by construction).
- `province filter maps the canonical code`: `province: "ha-noi"` → `provinceFilter: "ha-noi"`; `province: "atlantis"` → `null`; **old `city` param maps through the FD-1 rule**: `city: "Hà Nội"` → `provinceFilter: "ha-noi"`; `city: "Bình Dương"` → `provinceFilter: "ho-chi-minh"` (merged legacy name — authoritative); `city: "Khác"` → `null` (ignored, all locations — never guessed) (nit).
- `the plan has NO ranking field derived from province when no province filter is set` (Review Focus 3 — structural: the plan type carries no boost term).
- `resolution ids flow into the plan`; `sort validation: unknown sort → "newest"; "relevance" only when hasQuery`.
- `isListingSearchable: only "approved" is searchable` — **the S6 drift test**: enumerate every `listing_status` value from the emitted contract (`contract.d.ts` or the enum literal list) and assert `isListingSearchable(v) === (v === "approved")` (a future `archived`/`removed` value that leaks into search fails here).

`tests/unit/search-telemetry.test.ts` (mock db + emit core spy — S-7):

- `a valid query emits search_submitted with resultCount + resultListingIds and NO query text` (spy the persisted row: metadata keys exclude any query field; `searchSessionId` set).
- `a blank/malformed query emits nothing and consumes no rate-limit budget` (S-5).
- `rate limit: the 61st valid search within 60s → soft-throttle, no query, no emit`; `searchRateLimitKey: authed → user key; anonymous → ip key; TRUST_PROXY_HEADERS=false → the shared "local" bucket` (S-5).
- `prefetch requests skip emission` (S-8: `isPrefetch: true` → no `search_submitted` row).
- `zero-result emits search_zero_result with the resolution ids; eventsEmitted.zeroResult === true` → the page's "demand recorded" line renders only then (S-6).
- `categorySlug/brandSlug are emitted only when they match a loaded row` (S-9): a `categorySlug` not in `loadedCategories` → omitted from metadata (not emitted raw).

- [ ] **Step 2: Run to verify failure** → FAIL (modules missing).

- [ ] **Step 3: Implement + rework `app/listings/page.tsx`**

- `src/lib/search-query.ts` per the interface block (S-2 ORM form; verify `fns.or`/`.in(...)`/`fullTextMatches(q, { language })`/`fullTextRank` signatures against `.agents/skills/prisma-8/references/queries-postgres.md` before writing — the invariant is index language === query language === `"simple"`).
- `src/lib/search-telemetry.ts` per the interface block — the page becomes a thin shell: load categories/brands, resolve session, read the prefetch header (verify the exact header name against `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md` ~L474 — S-8: whether `next-router-prefetch` survives the proxy layer), call `runSearchWithTelemetry`, render.
- `app/listings/page.tsx`:
  - rate-limited soft state per S-5 (only valid queries consume budget);
  - **Zero-result recovery (spec §5.7.1)**: when `resultCount === 0` and a query/filters were used, the empty state offers: "Xóa bộ lọc" (existing link), "Xem loa {brand}" when the resolution found exactly one brand (link `/listings?brand=<slug>`), "Xem loa di động" (link `/listings?category=<BETA_SPEAKER_CATEGORY_SLUG>` — S8), and the demand-recorded line **only when `eventsEmitted.zeroResult`** (S-6). No saved-search/notification system.
  - **Location filter + cold-start shortcuts (spec §5.9.1)**: the "Khu vực" select becomes a province select built from `PROVINCE_CODES` (value = code) with "Tất cả" default; beside it, quick-filter chips for the primary/secondary markets (`Hà Nội` → `ha-noi`, `TP. Hồ Chí Minh` → `ho-chi-minh` — registry displayNames/codes) labeled with `betaMarketLabel()` — operational/acquisition labels only, no trust/safety wording (spec §4.7), and no relevance effect beyond the explicit filter.
  - Result links carry `?ss=<searchSessionId>` via a new optional `searchSessionId` prop on `ListingCard` **with `prefetch={false}`** (S-8 — deterministic anti-double-count regardless of the proxy header question).
- `src/components/listing-card.tsx`: optional `searchSessionId?: string` → `href` gains `?ss=`; `prefetch={false}` when the prop is set (additive; other call sites unchanged).
- `tests/unit/listing-draft-actions.test.ts`: retarget Batch 4's "draft not publicly visible" source assertion from `app/listings/page.tsx` to `SEARCHABLE_LISTING_STATUSES`/`isListingSearchable` in `src/lib/search-query.ts` — same invariant (drafts not publicly visible), new owner, **not weakened** (S-21).

- [ ] **Step 4: Write the integration test**

`tests/integration/search.test.ts` (real DB; seeds approved listings + one hidden + one pending + one draft; per S-22 reuse the Batch 4 verified-seller fixture and the Batch 4 integration stubbing recipe):

- `diacritic-insensitive search finds normalized matches`: seed `"Loa JBL Charge 4"` (backfilled text from Task 4's script or direct column set) → `runSearchQuery(describeSearchQuery({ q: "loa jbl charge 4" }, …))` finds it; `q: "LOA JBL CHARGE 4"` finds it; `q: "charge4"` finds it (spacing variant); **`q: "loa do"` finds a `"Loa đồ chơi"` listing** (S-1 — the `simple` language keeps `do`).
- `alias-resolved id match finds the listing when text does not`: seed a listing whose title lacks the query term but whose `productModelId` is the resolved id → found via the id arm.
- `location filter`: Hà Nội-coded listing found with `province: "ha-noi"`; unresolved listing NOT found with `province: "ha-noi"` but found with no province filter.
- **`no priority-location boost (Review Focus 3 — permuted-province test)`**: seed 4 identical-title listings in 4 different provinces, run the same no-province search twice with the rows' `provinceLevelCode` values permuted between runs → **the result order is identical** (relevance is textual + freshness only — the primary market's listings do not float up).
- `non-searchable statuses never appear`: hidden/pending/draft seeds invisible in every search (S6).
- `search under the rate limit still returns results` (the limit only gates valid-query bursts).

- [ ] **Step 5: Run until green**

Run: `npm test -- tests/unit/search-query.test.ts tests/unit/search-telemetry.test.ts tests/unit/listing-draft-actions.test.ts` → PASS; `npm run test:integration` → `search.test.ts` PASS; `npm test` full unit suite green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/search-query.ts src/lib/search-telemetry.ts app/listings/page.tsx src/components/listing-card.tsx tests/unit/listing-draft-actions.test.ts tests/unit/search-query.test.ts tests/unit/search-telemetry.test.ts tests/integration/search.test.ts
git commit -m "feat(search): normalized search, recovery & search telemetry"
```

## Task 8: Funnel event wiring into current surfaces (S7)

**Files:**

- Create: `src/lib/telemetry-recorders.ts` (S-22 — plain server helpers, unit-testable without rendering async pages)
- Modify: `'app/listings/[slug]/page.tsx'` (`recordListingView` + `recordSearchResultClick`)
- Modify: `src/lib/actions/chat.ts` (`conversation_started`)
- Modify: `'app/api/chat/[id]/route.ts'` (`conversation_buyer_first_message` + `message_first_response`)
- Modify: `src/lib/actions/admin.ts` (`listing_rejected` on reject; `seller_first_listing_published` on approve — after `checkListingPublication` passes and the update succeeds, S5)
- Modify: `src/lib/actions/reports.ts` (`report_submitted` — Batch 3's action)
- Modify: `src/lib/actions/moderation.ts` (`listing_removed` on `takeDownListingAction` — Batch 3's action)
- Modify: `src/lib/actions/seller-verification.ts` (`seller_verified` on review — Batch 2's action)
- Modify: `src/lib/actions/beta-cohort.ts` (`beta_membership_activated` when status becomes `active` — Batch 2's action)
- Test: `tests/unit/telemetry-wiring.test.ts`

**Interfaces:**

- Consumes: `emitProductEvent`/`actorPseudonymFor`/`sessionPseudonymFor` (Task 6), `getSessionFromCookie` (Batch 2), `ProductEvent` reads (attribution validation), the four actions above.
- Produces: the S7 emission set; the remaining taxonomy events stay schema-only (forward seams: `deal_*`, `successful_match`, `listing_marked_sold` → Batch 6; `seller_invited`/`seller_registered` → Batch 7; `user_returned` → A3).

```ts
// src/lib/telemetry-recorders.ts — plain server helpers (S-22), import "server-only", KHÔNG "use server"
export async function recordListingView(input: {
  listing: { id: string; slug: string; status: string; sellerId: string; provinceLevelCode: string | null };
  viewer: { id: string | null; sessionPseudonym: string | null } | null;
  isPrefetch: boolean;
}): Promise<void>;
//   - KHÔNG emit khi listing.status !== "approved" (S-12) và KHÔNG emit khi isPrefetch (S-8)
//   - ownerView = viewer?.id === listing.sellerId
//   - S-15 throttle: checkRateLimit(`listing-view:${viewerKey}:${listing.id}`, { limit: 1, windowMs: 10 * 60_000 })
//     → exceeded → skip emission (view vẫn render; residual inflation risk recorded under A4)

export async function recordSearchResultClick(input: {
  ss: string | null; listing: { id: string; provinceLevelCode: string | null };
  viewer: { id: string | null; sessionPseudonym: string | null } | null;
}): Promise<boolean>;
//   S-14: ss param → ProductEvent.first({ name: "search_submitted", searchSessionId: ss }) tồn tại
//   VÀ listing.id ∈ event.metadata.resultListingIds (the recorded result set) → emit search_result_clicked
//   { searchSessionId: ss, listingId, provinceCode } — unknown ss / listing ngoài result set → NO event
//   (forged/copied ss không chế tạo được CTR — Review Focus 7)

export async function recordConversationStarted(input: { convo: { id: string; listingId: string | null }; listing: { provinceLevelCode: string | null } | null; buyerId: string; sessionPseudonym: string | null }): Promise<void>;
export async function recordBuyerFirstMessage(input: { convo: { id: string; listingId: string | null }; buyerId: string; firstBuyerMessageAt: string }): Promise<void>;
export async function recordFirstResponse(input: { convo: { id: string; listingId: string | null }; sellerId: string; firstBuyerMessageAt: string; sellerRepliedAt: string }): Promise<void>;
//   message_first_response metadata: { responseMs: Date.parse(sellerRepliedAt) - Date.parse(firstBuyerMessageAt) }
//   — anchor = first buyer message (D4)
```

```ts
// Emission contracts (gọi emitProductEvent/recorders — KHÔNG bao giờ ghi ProductEvent trực tiếp):
// conversation_started:      CHỈ khi tạo conversation MỚI (không phải branch redirect vào convo cũ),
//                            sau MỌI guard Batch 3 (block/suspension) và sau Conversation.create thành công (S5)
// conversation_buyer_first_message: khi BUYER gửi tin ĐẦU TIÊN của mình trong convo (0 tin buyer trước đó)
// message_first_response:    khi SELLER gửi tin ĐẦU TIÊN của mình trong convo VÀ đã có ≥1 tin buyer trước đó
//                            (D4 anchor) — responseMs tính từ firstBuyerMessageAt
// listing_rejected:          trong rejectListingAction sau khi update thành công — actor = admin
// seller_first_listing_published: trong approveListingAction SAU checkListingPublication pass + update thành công
//                            (S5) — actor = listing.sellerId (seller được kích hoạt); S-19 re-fire guard:
//                            ProductEvent tồn tại (name=seller_first_listing_published, actorPseudonym=seller) →
//                            skip (event-existence check — append-only nên check này chính xác "lần approve đầu")
// listing_removed:           trong takeDownListingAction (Batch 3) sau updateAll thành công — actor = admin
// report_submitted:          trong submitReportAction (Batch 3) sau transaction thành công — actor = reporter,
//                            targetType/targetId/reasonCode trong metadata (typed codes, KHÔNG note text)
// seller_verified:           trong reviewSellerVerificationAction (Batch 2) khi decision = verified — actor = seller
// beta_membership_activated:  trong setBetaMembershipAction (Batch 2) khi status chuyển thành "active" — actor = user
```

- [ ] **Step 1: Write the failing unit tests**

`tests/unit/telemetry-wiring.test.ts` (mock db per action/route with in-memory fixtures; spy on the emit core's db mock; per S-22 mock `listing-publication`/`listing-images`/`audit-event` and reuse the Batch 4 verified-seller fixture shape so the action paths run with their real guards satisfied):

- `recordListingView emits for an approved listing, skips non-approved (draft/hidden/pending), skips prefetch, throttles repeats` (S-12/S-8/S-15): first view → emitted with `ownerView` correct; second view within 10 min → skipped; seller's own view → `ownerView: true`.
- `recordSearchResultClick validates the ss binding (S-14)`: valid `ss` + listing in the recorded result set → emitted; valid `ss` + listing NOT in the result set → NOT emitted; unknown `ss` → NOT emitted; missing `ss` → NOT emitted (Review Focus 7).
- `startConversationAction emits conversation_started only on NEW conversation` — existing-conversation path (redirect) emits nothing; new path emits with `conversationId` + `listingId` + buyer pseudonym (assert the persisted `actorPseudonym` ≠ raw buyer id); **a blocked/suspended pair (Batch 3 guards) emits nothing** (emission after guards — S5).
- `chat POST emits conversation_buyer_first_message on the buyer's first message` (0 prior buyer messages) and `message_first_response only for the seller's FIRST reply after a buyer message`: first seller message → emitted with `responseMs` = elapsed ms; second seller message → not emitted; buyer message (not first) → not emitted; seller message with no prior buyer message → not emitted.
- `rejectListingAction emits listing_rejected; approveListingAction emits seller_first_listing_published only when no prior event exists for the seller's pseudonym` (S-19): first approval → emitted; second approval of another listing by the same seller → NOT emitted (event-existence check); approval blocked by `checkListingPublication` → NOT emitted (S5 — emission only after the gate passes and the update succeeds).
- `takeDownListingAction emits listing_removed after the atomic update succeeds; a 0-row takedown emits nothing` (S7).
- `submitReportAction emits report_submitted with typed targetType/reasonCode metadata and NO note text` (S7 — the reporter's free-text note never enters telemetry); a rate-limited/deduped report emits nothing.
- `reviewSellerVerificationAction emits seller_verified on decision=verified only` (S7); `setBetaMembershipAction emits beta_membership_activated only on transition to active` (S7).
- `finance modules emit nothing` (Review Focus 2): source-contract assertion — read `src/lib/actions/orders.ts`, `src/lib/escrow.ts`, `src/lib/wallet.ts`, `src/lib/ledger.ts`, `src/lib/momo.ts`, `src/lib/mock-payment.ts` sources and assert zero occurrences of `ProductEvent`/`emitProductEvent` (same source-scan pattern as `tests/unit/finance-public-surface.test.ts`).
- `telemetry-recorders.ts is a plain server module (server-only, no "use server")` (S-13/S-22 source-contract).

- [ ] **Step 2: Run to verify failure** → FAIL (emission not wired).

- [ ] **Step 3: Implement**

- `src/lib/telemetry-recorders.ts` per the interface block (S-22 — the helpers, not the pages, own the emission logic; pages/actions call them).
- `'app/listings/[slug]/page.tsx'`: after the existing `viewCount` increment → `recordListingView({ listing, viewer, isPrefetch })`; when `searchParams.ss` present → `recordSearchResultClick({ ss, listing, viewer })`. All emission wrapped so a telemetry failure never breaks the page (the emit core already fails open on db errors).
- `src/lib/actions/chat.ts`: after `Conversation.create` (not the existing-conversation branch) → `recordConversationStarted` (loads the listing's `provinceLevelCode` — already loaded).
- `'app/api/chat/[id]/route.ts'` POST: after `Message.create` + `lastMessageAt` update — query the conversation's messages ordered by `createdAt`: buyer sender + 0 prior buyer messages → `recordBuyerFirstMessage`; seller sender + ≥1 prior buyer message + 0 prior seller messages → `recordFirstResponse` with `firstBuyerMessageAt` (D4 anchor). (One extra query per message at beta scale — acceptable; noted in the code.)
- `src/lib/actions/admin.ts`: `rejectListingAction` → emit `listing_rejected` after the update; `approveListingAction` → **after `checkListingPublication` passes and the update succeeds** (S5) → S-19 event-existence check → emit `seller_first_listing_published` (actor = seller). Both best-effort (fail open), never altering the action's result.
- `src/lib/actions/reports.ts` (Batch 3): after the report transaction succeeds → emit `report_submitted` with `{ targetType, targetId, reasonCode }` metadata (typed codes; **no note text**).
- `src/lib/actions/moderation.ts` (Batch 3): `takeDownListingAction` → after the atomic `updateAll` succeeds (non-zero rows) → emit `listing_removed`.
- `src/lib/actions/seller-verification.ts` (Batch 2): `reviewSellerVerificationAction` → on `decision === "verified"` after the atomic claim succeeds → emit `seller_verified` (actor = the verified seller).
- `src/lib/actions/beta-cohort.ts` (Batch 2): `setBetaMembershipAction` → when the resulting status is `"active"` (and it wasn't already) → emit `beta_membership_activated` (actor = the member).

- [ ] **Step 4: Run until green** → `npm test -- tests/unit/telemetry-wiring.test.ts` → PASS; `npm test` full suite green (finance + Batch 2/3/4 suites untouched).

- [ ] **Step 5: Commit**

```bash
git add src/lib/telemetry-recorders.ts 'app/listings/[slug]/page.tsx' src/lib/actions/chat.ts 'app/api/chat/[id]/route.ts' src/lib/actions/admin.ts src/lib/actions/reports.ts src/lib/actions/moderation.ts src/lib/actions/seller-verification.ts src/lib/actions/beta-cohort.ts tests/unit/telemetry-wiring.test.ts
git commit -m "feat(telemetry): wire funnel events into product surfaces"
```

## Task 9: Metric contracts + computation engine + fixture reconciliation

**Files:**

- Create: `src/lib/metric-contracts.ts`
- Create: `src/lib/metrics.ts`
- Test: `tests/unit/metric-contracts.test.ts`
- Test: `tests/unit/metrics-reconciliation.test.ts`

**Interfaces:**

- Consumes: `ProductEvent` rows (Tasks 6–8), `Listing` (median listing age / seller listing count).
- Produces (used by Task 10):

```ts
// src/lib/metric-contracts.ts — registry theo ĐÚNG struct spec §5.8.1
export const PENDING_FOUNDER_DECISION = "PENDING_FOUNDER_DECISION" as const;

export type MetricSegment = "beta_cohort" | "primary_secondary_market" | "category" | "brand_model";

export type MetricContract = {
  name: string;              // "zero_result_rate_v1" | ... — đủ 8 contract của spec §5.8.1
  version: string;           // "v1"
  definition: string;        // nguyên văn định nghĩa spec (tiếng Anh) + ghi chú tiếng Việt
  numerator: string;
  denominator: string;
  deduplicationKey: string;
  attributionWindow: string; // giá trị cụ thể, "unbounded_click_chain" (S-16), hoặc PENDING_FOUNDER_DECISION (A1)
  inclusionRules: readonly string[];
  exclusionRules: readonly string[];
  botInternalTrafficRules: string;   // "no bot signal defined — nothing excluded" (A4) cho mọi contract
  supportedSegments: readonly MetricSegment[];
  owner: string;             // "founder"
};

export type MetricName =
  | "zero_result_rate_v1" | "search_result_ctr_v1" | "listing_to_chat_v1" | "search_to_chat_v1"
  | "seller_response_rate_v1" | "median_first_response_time_v1" | "successful_match_rate_v1" | "repeat_user_rate_v1";

export const METRIC_CONTRACTS: Record<MetricName, MetricContract>;
```

```ts
// src/lib/metrics.ts — PURE functions over event arrays (unit-test trực tiếp; dashboard nạp events từ db rồi gọi)
export type ProductEventRow = {   // định nghĩa tường minh (nit) — shape của row ProductEvent mà engine tiêu thụ
  id: string; name: string; occurredAt: string;
  actorPseudonym: string | null; sessionPseudonym: string | null;
  isInternal: boolean;            // S-12: exclusion theo flag tính lúc emit — KHÔNG phụ thuộc key ổn định
  searchSessionId: string | null; listingId: string | null; conversationId: string | null;
  provinceCode: string | null;
  metadata: Record<string, unknown> | null;
};

export type MetricOpts = { excludeInternal?: boolean };   // default true — lọc theo row.isInternal

// zero_result_rate_v1 — numerator: valid search sessions with zero eligible results;
// denominator: all valid submitted search sessions; exclusions: blank/malformed (không emit theo cấu trúc),
// internal (row.isInternal), known automated traffic (A4: none defined). Window: per-session (không cần).
export function zeroResultRate(events: ProductEventRow[], opts?: MetricOpts): { numerator: number; denominator: number; rate: number | null };

// search_result_ctr_v1 — numerator: eligible search sessions with ≥ 1 result click;
// denominator: eligible search sessions with ≥ 1 displayed result (resultCount > 0).
export function searchResultCtr(events: ProductEventRow[], opts?: MetricOpts): { numerator: number; denominator: number; rate: number | null };

// listing_to_chat_v1 — numerator: qualified unique listing views that generate a NEW buyer↔seller conversation
// within the attribution window; denominator: qualified unique listing views; dedup: viewer + listing + window.
// "qualified" (D2): authenticated (actorPseudonym != null) + non-internal + non-owner view.
// windowMs là THAM SỐ — production contract = PENDING (A1).
export function listingToChat(events: ProductEventRow[], opts: { windowMs: number } & MetricOpts): { numerator: number; denominator: number; rate: number | null };

// search_to_chat_v1 (S-16/D3) — numerator: qualified search sessions that eventually produce a new buyer↔seller
// conversation THROUGH A CLICKED RESULT; denominator: qualified search sessions. "eventually" là spec-stated
// UNBOUNDED — ship là click-chain không có time bound: search_result_clicked.listingId → conversation_started
// (cùng actor, cùng listing, SAU click). KHÔNG pending.
export function searchToChat(events: ProductEventRow[], opts?: MetricOpts): { numerator: number; denominator: number; rate: number | null };

// seller_response_rate_v1 (D4) — denominator: eligible new buyer conversations = conversation_buyer_first_message
// events (eligible = ≥1 buyer message, theo cấu trúc) của buyer non-internal; numerator: những conversation có
// message_first_response (cùng conversationId) trong response window. responseWindowMs là THAM SỐ — PENDING (A1).
export function sellerResponseRate(events: ProductEventRow[], opts: { responseWindowMs: number } & MetricOpts): { numerator: number; denominator: number; rate: number | null };

// median_first_response_time_v1 (S-18) — time from first qualified buyer message (anchor = first buyer message,
// D4) to first seller response; dedup theo conversationId (mỗi convo đóng góp MỘT responseMs — event chỉ emit
// một lần nhưng dedup phòng backfill/đếm đôi); exclude internal BUYERS qua join conversation_buyer_first_message
// .isInternal (không phải internal sellers). HOÀN TOÀN spec'd — ship thật.
export function medianFirstResponseTime(events: ProductEventRow[], opts?: MetricOpts): { medianMs: number | null; sample: number };

// successful_match_rate_v1 — chỉ COUNT (rate bị chặn bởi A2 + Deal của Batch 6):
export function successfulMatchCount(events: ProductEventRow[], opts?: MetricOpts): number;
```

- [ ] **Step 1: Write the failing contract-registry test**

`tests/unit/metric-contracts.test.ts`:

- `the registry carries exactly the eight spec contracts with the spec's names` (no invented ninth, none missing).
- `every contract fills every field of the spec §5.8.1 struct` (non-empty definition/numerator/denominator/dedup/attribution/inclusion/exclusion/bot rules/segments/owner).
- `the four window-dependent contracts carry PENDING_FOUNDER_DECISION, not an invented value` (`listing_to_chat_v1`, `seller_response_rate_v1`, `successful_match_rate_v1`, `repeat_user_rate_v1` — A1/A2/A3 enforced *structurally*: an invented window cannot merge).
- **`search_to_chat_v1 carries "unbounded_click_chain", NOT pending` (S-16)** — "eventually" is the spec's own unbounded statement.
- `the three fully-specified contracts carry concrete semantics matching the spec text` (`zero_result_rate_v1`, `search_result_ctr_v1`, `median_first_response_time_v1`).
- `every contract's exclusionRules name the internal/test exclusion and the blank/malformed structural exclusion where the spec lists them` (zero_result_rate_v1's four exclusions verbatim).

- [ ] **Step 2: Write the failing fixture-reconciliation tests** — the **fixture reconciliation gate** (zero-result, CTR, listing→chat, response metrics):

`tests/unit/metrics-reconciliation.test.ts` — a hand-written fixture event array (`ProductEventRow` literals, timestamps as ISO strings) with **hand-reckoned expected values written as literals in the test**, then `expect(metric(fixture, opts)).toEqual(expected)`:

- `zero_result_rate reconciles`: fixture = 6 `search_submitted` (3 with `resultCount: 0`, 3 with results; 1 of the zero-result ones by an internal actor → `isInternal: true`) → expected `{ numerator: 2, denominator: 5, rate: 0.4 }` (internal excluded from both). Blank/malformed never appear in the fixture *by construction* — assert the engine ignores non-`search_submitted` rows.
- `search_result_ctr reconciles`: fixture = 6 sessions with `resultCount > 0`, one of them by an internal **searcher** (`isInternal: true` — excluded → denominator 5); of the remaining 5, two have a `search_result_clicked` (one of them clicked twice → still numerator 1 — session-level dedup by `searchSessionId`) → expected `{ numerator: 2, denominator: 5, rate: 0.4 }`. Hand-reckon the exact fixture you write — the expected literal is computed by hand in a comment, not by the engine.
- `listing_to_chat reconciles (FIXTURE window 24h — labeled, not production policy)`: fixture views + conversations — cases: view→conversation within window (numerator), view→conversation outside window (not), same viewer+listing viewed twice within window (dedup → 1 denominator unit), owner view (excluded, D2), internal view (excluded), anonymous view with null pseudonym (excluded — cannot join), conversation without a prior view (not counted in denominator). Hand-reckoned literals.
- `search_to_chat reconciles (UNBOUNDED — S-16)`: session with click on listing L + conversation_started(same actor, L, after click) → numerator; conversation on a *different* listing than any clicked result → not; conversation *before* the click → not (chain order); a click with no conversation → denominator only. No window parameter anywhere.
- `seller_response_rate reconciles (FIXTURE response window)`: `conversation_buyer_first_message` + `message_first_response` rows — within window → numerator; outside → not; internal buyer's conversation → excluded from denominator (D4 eligibility = the buyer-first-message event).
- `median_first_response_time reconciles (S-18)`: odd-count fixture (median = middle `responseMs`), even-count fixture (median = mean of the two middle values — state the convention in the test comment), **two `message_first_response` rows for the same conversationId → deduped to one**, internal buyer's conversation excluded (via the joined `conversation_buyer_first_message.isInternal`), empty → `{ medianMs: null, sample: 0 }`.
- `successful_match_count counts events` (rate stays pending — A2).

- [ ] **Step 3: Run to verify failure** → FAIL (modules missing).

- [ ] **Step 4: Implement**

- `src/lib/metric-contracts.ts`: the eight records with the spec's numerator/denominator text quoted verbatim (English) + a Vietnamese note; `attributionWindow` per the registry test (concrete for the fully-specified ones — zero_result/CTR are per-session (`"per_search_session"`), median_first_response is a duration metric (`"n/a_duration"`); `search_to_chat_v1` = `"unbounded_click_chain"` (S-16); `PENDING_FOUNDER_DECISION` for the four); `botInternalTrafficRules: "no bot signal defined — nothing excluded (A4)"` everywhere; `owner: "founder"`.
- `src/lib/metrics.ts`: pure functions per the interface block. Implementation notes: session-level dedup via `Set` on `searchSessionId`; internal exclusion via the `isInternal` flag (S-12 — no key dependency); `listingToChat` dedups views by `(actorPseudonym, listingId)` within the window and joins `conversation_started` by `(actorPseudonym, listingId)` with `conversationStartedAt >= viewedAt && <= viewedAt + windowMs`; `searchToChat` walks the unbounded click→conversation chain per session (S-16); `sellerResponseRate` joins `conversation_buyer_first_message` → `message_first_response` by `conversationId` within the window (D4); `medianFirstResponseTime` dedups by `conversationId`, sorts `responseMs` (excluding conversations whose buyer is internal, via the buyer-first-message join), takes the middle / mean-of-middle-two. No function reads the db, imports server-only, or logs.

- [ ] **Step 5: Run until green** → both suites PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/metric-contracts.ts src/lib/metrics.ts tests/unit/metric-contracts.test.ts tests/unit/metrics-reconciliation.test.ts
git commit -m "feat(metrics): versioned metric contracts with fixture reconciliation"
```

## Task 10: Private-beta analytics dashboard

**Files:**

- Create: `app/admin/analytics/page.tsx`
- Modify: `app/admin/layout.tsx` (nav entry `Phân tích beta` → `/admin/analytics`, gated `analytics.read` — appended to Batch 3's capability-filtered nav, S5)
- Test: `tests/unit/analytics-dashboard.test.ts`

**Interfaces:**

- Consumes: `requireCapability("analytics.read")` (Batch 2 `src/lib/rbac.ts`), `metrics.ts` + `METRIC_CONTRACTS` (Task 9), `cohortPseudonyms` (Task 6), `ProductEvent`/`Listing`/`BetaCohortMembership`/`Category`/`Brand` reads, the province registry (Batch 2 Task 10's `src/lib/provinces.ts` — FD-1) + `BETA_PRIMARY_MARKET_PROVINCE`/`BETA_SECONDARY_MARKET_PROVINCE` (Task 2).
- Produces: the spec §5.8.2 dashboard at `/admin/analytics` (server component, `export const dynamic = "force-dynamic"`).

- [ ] **Step 1: Write the failing unit tests** — the **dashboard access + honesty gate**:

`tests/unit/analytics-dashboard.test.ts` (source-contract + pure-logic tests):

- `the page module calls requireCapability("analytics.read") server-side` — source-contract assertion on `app/admin/analytics/page.tsx` (same pattern as `tests/unit/finance-public-surface.test.ts`): the guard call is present and precedes any db read; no client-side-only gating.
- `the admin layout nav entry for /admin/analytics is filtered by capabilitiesOf` (source assertion; UI filtering is convenience — the page guard is the control, spec §4.5).
- `pending metrics render a named pending state, never an invented number`: feed a fixture contract set + fixture aggregates → the render helper returns `"— chờ quyết định: attribution window"` for the four `PENDING_FOUNDER_DECISION` contracts (assert the string names the missing parameter; assert no rate value is produced for them); **`search_to_chat_v1` renders a real value** (unbounded — S-16).
- `every rendered rate carries its numerator/denominator counts` (low-sample context, spec §5.8.2 "Avoid displaying misleading low-sample percentages without context") — the render helper output for `zeroResultRate` includes `n=2/5` style counts.
- `segmentation helpers`: cohort segment = events whose `actorPseudonym` ∈ `cohortPseudonyms(cohort)` (fixture `BetaCohortMembership` rows → pseudonym set → filtered count); market segment = `provinceCode` = `"ha-noi"` vs `"ho-chi-minh"` vs other; category segment = join `listingId` → `Listing.category`; brand/model segment = join `listingId` → `Listing.brandId`/`productModelId` ("where sample size permits" = the counts are always shown, no invented minimum-n threshold).
- `aggregates that need no contract`: query volume = count of `search_submitted`; median listing age over approved `Listing`s; listing marked sold = count of `listing_marked_sold` events (0 until Batch 6 emits — honest zero); report count = count of `report_submitted` (now non-zero — Batch 3 emits, S7); seller activation = distinct `actorPseudonym` in `seller_first_listing_published`; seller listing count = approved listings total + median per seller; **active seller count** = sellers with ≥ 1 approved listing (§12.2 — raw aggregate, no invented "active" definition beyond that, recorded as a decision in the module comment).
- `the dashboard module documents the full-scan scaling limit` (nit — source assertion: a comment noting the P0 shape loads every `ProductEvent` row per request and the scaling ceiling is recorded for the post-beta review).

- [ ] **Step 2: Run to verify failure** → FAIL (page missing).

- [ ] **Step 3: Implement**

- `app/admin/analytics/page.tsx`: `await requireCapability("analytics.read")` first (server-side; throws/redirects for wrong roles — Batch 2's guard semantics); load all `ProductEvent` rows to date (**no invented display window** — the dashboard aggregates everything since telemetry began, with the row count shown; retention policy is Ambiguity A6; the full-scan scaling limit is documented in the module — nit), compute the metric inputs, run the metric functions, render:
  - the §5.8.2 list: query volume, zero-result rate, result CTR, listing→chat, search→chat, seller response rate, median first response time, median listing age, listing marked sold, successful matches, report count, repeat users, seller activation, seller listing count, active seller count;
  - the four pending contracts in the named pending state (`— chờ quyết định: <tên tham số>` per Ambiguity A1/A2/A3) — never an invented value;
  - segmentation controls (cohort / primary-secondary market / category / brand-model) computed as in the unit test;
  - every rate with `n=numerator/denominator` counts beside it;
  - neutral copy only — no location trust language (spec §4.7), no guarantee wording.
- `app/admin/layout.tsx`: append the nav item `Phân tích beta` → `/admin/analytics` behind the `analytics.read` capability check (Batch 3's layout already filters nav by `capabilitiesOf` — follow its pattern; the page guard remains the authorization).

- [ ] **Step 4: Run until green** → `npm test -- tests/unit/analytics-dashboard.test.ts` → PASS; `npm test` full suite green.

- [ ] **Step 5: Commit**

```bash
git add app/admin/analytics/page.tsx app/admin/layout.tsx tests/unit/analytics-dashboard.test.ts
git commit -m "feat(admin): private-beta analytics dashboard"
```

## Task 11: Batch 5 gate verification + verification doc

**Files:**

- Create: `docs/operations/private-beta-batch5-search-telemetry-verification.md`

- [ ] **Step 1: Run every gate suite and record results** (spec §9 Batch 5 Gate → named tests)

```bash
npm test -- tests/unit/search-normalize.test.ts                    # diacritic tests (đ/Đ + spacing variants + "loa do" language pin ở integration)
npm test -- tests/unit/search-resolve.test.ts                     # alias tests (exact/spacing/compact — B6)
npm test -- tests/unit/location.test.ts                           # location-filter tests (unit) + table ⊆ registry drift guard
npm run test:integration                                          # location-filter + unknown-legacy-location migration tests
                                                                  #   (tests/integration/listing-location.test.ts — gồm Batch-4-row case B3),
                                                                  #   diacritic/location integration (tests/integration/search.test.ts — gồm permuted-province no-boost),
                                                                  #   migration additivity (tests/integration/batch5-migration.test.ts)
npm test -- tests/unit/product-events.test.ts                     # event-schema validation + PII rejection (gồm 1000-uuid test B8)
npm test -- tests/unit/metrics-reconciliation.test.ts            # zero-result + CTR + listing→chat + response-metrics fixture reconciliation
npm test -- tests/unit/metric-contracts.test.ts                   # contract registry structural gate (pending sentinels + unbounded search_to_chat)
npm test -- tests/unit/telemetry-wiring.test.ts                   # funnel emission + finance-emission source scan
npm test -- tests/unit/search-query.test.ts tests/unit/search-telemetry.test.ts   # no-boost plan structure + emission/rate-limit/prefetch unit gate
npm test -- tests/unit/analytics-dashboard.test.ts                # dashboard capability guard + pending-state honesty
```

- [ ] **Step 2: Backend-enforcement + privacy source scans**

```bash
rg -n "ProductEvent|emitProductEvent" src/lib/actions/orders.ts src/lib/escrow.ts src/lib/wallet.ts src/lib/ledger.ts src/lib/momo.ts src/lib/mock-payment.ts
#     expect: 0 hits — finance path không bao giờ emit telemetry (S7 — Review Focus 2)
rg -n "AuditEvent|auditEvent" src/lib/product-events.ts src/lib/telemetry-recorders.ts src/lib/search-telemetry.ts src/lib/metrics.ts src/lib/metric-contracts.ts
#     expect: 0 hits — Batch 5 writes no AuditEvent (S10); ProductEvent names disjoint from Batch 3/4 registries
rg -n "requireCapability|requireAdminUser" app/admin/analytics/page.tsx
#     expect: analytics.read guard present, trước mọi db read
rg -n "an toàn|bảo đảm|đảm bảo|guarantee" src/lib/location.ts app/listings/page.tsx app/admin/analytics/page.tsx src/lib/search-query.ts
#     expect: 0 trust-language hits cho location (spec §4.7) — classify từng hit nếu có
rg -n "FINANCIAL_FEATURES_ENABLED" .env.example docker-compose.prod.yml scripts
#     expect: vẫn "false" everywhere (Batch 1 preserved)
rg -n "captureError|captureEvent" src/lib/product-events.ts
#     expect: chỉ rejection reason (event name + rule), KHÔNG BAO GIỀ payload/value
rg -n "server-only" src/lib/product-events.ts src/lib/telemetry-recorders.ts src/lib/search-telemetry.ts
#     expect: có (S-13); và KHÔNG có "use server" trong các module đó
```

Manually classify every hit; fix any violation.

- [ ] **Step 3: Full preflight + build + smoke**

```bash
npm run lint
npx tsc --noEmit
npm test
npm run test:integration
npm run build
npm run preflight        # contract-emit drift + lint + typecheck + unit + build + compose + migration graph
npm run smoke            # local safe smoke
```

- [ ] **Step 4: Diff/status audit + migration review**

- `git diff --check`; `git status --short` contains only Batch 5 files; no `.claude/settings.json`, no uploads, no secrets, no scratch.
- `npx prisma migration list` shows the linear graph **baseline → batch2 → batch3 → batch4 → batch5** (S2 — no node with two outgoing edges); `npx prisma db verify` clean.
- Inspect the migration once more: no destructive op on data (the `Listing_status_check_*` DROP+ADD pair expected and additive in effect — S2); zero data transforms (backfills are offline scripts).
- Run both backfill scripts + the alias seed in dry-run against dev and record the reported counts; run `--apply` on dev; record idempotent second-run output (0 rows) **and the `declaredIds` list** (B3 rollback input).

- [ ] **Step 5: Write the verification doc**

`docs/operations/private-beta-batch5-search-telemetry-verification.md` records: base (merged Batch 4 commit) and final commit hashes; OpenCode model/session metadata; per-gate test results (the ten Batch 5 gate items mapped to the named suites above); the source-scan classification table; migration review notes (additive-only + the expected `Listing_status_check_*` pair); both backfills' dry-run/apply/idempotency output + the `declaredIds` rollback procedure (B3); the alias seed's empty/founder-reviewed content state (S9/A7); the FD-1/A9 **resolution record** (the 34-unit registry per NQ 202/2025/QH15, source cited, consumed read-only from Batch 2 Task 10's `src/lib/provinces.ts`; the merged-legacy-name mapping applied as authoritative — `Bình Dương` → `ho-chi-minh`, `Thừa Thiên Huế` → `hue`; any registry legacy-name gap raised against Batch 2, never patched silently); residual risks (in-memory rate limiter topology + CGNAT shared-bucket note; render-time emission double-count mitigated by `prefetch={false}` + the header guard — the proxy.md header-stripping verification result recorded; single-instance topology assumptions; `PRODUCT_EVENT_PSEUDONYM_KEY` rotation breaks cross-version metric joins — detectable via `pseudonymKeyVersion`, internal exclusion survives via `isInternal`; dashboard full-scan scaling ceiling); deferred items (Batch 6/7 emission forward seams, Ambiguities A1–A9 with their blocking scope); and the explicit statement that browser E2E remains deferred (no E2E infrastructure in the repo — same posture as Batches 2–4, honored when a runner lands).

- [ ] **Step 6: Commit**

```bash
git add docs/operations/private-beta-batch5-search-telemetry-verification.md
git commit -m "test(batch5): verify search & telemetry gate"
```

## Acceptance Gate

Batch 5 is accepted only if all of the following are true (spec §9 Batch 5 Gate):

- **Sequencing (S1/S2)** — executed on the merged Batch 4 commit; `npx prisma migration list` shows `baseline → batch2 → batch3 → batch4 → batch5` with no node holding two outgoing edges; the migration is additive-only (the `Listing_status_check_*` DROP+ADD pair expected and additive in effect).
- **Alias tests pass** — `tests/unit/search-resolve.test.ts`: exact + spacing + **compact** matching (the spec's `soundlink`↔`sound link` example resolves via compactForm — B6), catalog fallback by whole-query equality (S-3), unresolvable queries degrade to text-only, no raw query text in the resolution output; the seed script is idempotent with empty/founder-reviewed content (S9).
- **Diacritic tests pass** — `tests/unit/search-normalize.test.ts` (including **`đ`/`Đ`** — B5 — and the already-NFD input case) + `tests/integration/search.test.ts` (normalized column matches through the real `simple`-language full-text index, including the **"loa do"** stopword pin — S-1).
- **Location-filter tests pass** — `tests/unit/location.test.ts` + `tests/integration/listing-location.test.ts`: canonical province filtering works; unresolved listings appear only in "all locations"; every `CITIES` entry's outcome is pinned through the FD-1 rule (merged legacy names map to the new unit — authoritative).
- **Unknown legacy-location migration tests pass** — the backfill maps only rule-matched legacy rows (merged legacy names map to the new unit per FD-1 — `Bình Dương` → `ho-chi-minh`); `"Khác"`, district strings, and typos become explicit `unresolved`; `city` is byte-identical before/after; **a Batch-4-created row with a valid code is marked `seller_declared` and never overwritten** (B3); the backfill is idempotent with a documented rollback that nulls only what the backfill wrote.
- **Event-schema validation passes** — `tests/unit/product-events.test.ts`: every emitted event validates against its per-event zod schema; unknown names, wrong types, extra keys, and non-enum sort/condition values are rejected with no row written.
- **PII rejection passes** — email/phone/OTP/IP-shaped strings, denylisted keys, and over-length values in **free string fields** are rejected with no row written and no value logged; schema-typed id/enum fields are exempt and **1000 random UUIDs are never rejected** (B8); no schema has a free-text/query field; actor and session ids are stored only as dedicated-key HMACs (S-10/S-11); raw search-query text is never persisted.
- **Zero-result fixture reconciliation passes** — the counting engine reproduces hand-reckoned fixture values including the internal-actor exclusion (via the at-emit `isInternal` flag — S-12).
- **CTR fixture reconciliation passes** — session-level dedup (double click = one), resultCount>0 denominator, internal exclusion.
- **Listing→chat fixture reconciliation passes** — viewer+listing+window dedup, owner-view, internal, and anonymous-view exclusions, in-window vs out-of-window attribution (fixture window, labeled).
- **Response metrics reconciliation passes** — `seller_response_rate_v1` counting (fixture response window, D4 eligibility = `conversation_buyer_first_message`) + `median_first_response_time_v1` (conversationId dedup, internal-buyer exclusion, fully specified, ships concretely — S-17/S-18).
- **Metric-contract honesty** — the registry carries exactly the eight spec contracts; the four window-unspecified ones carry `PENDING_FOUNDER_DECISION` and the dashboard renders a named pending state, never an invented value; **`search_to_chat_v1` ships as the spec-stated unbounded click-chain** (S-16), not pending.
- **Location neutrality** — no priority-location relevance boost without buyer preference (structural plan test + the **permuted-province integration test**); no trust/safety location copy anywhere (source scan).
- **No finance/identity/moderation/publication regression** — every Batch 1 finance suite, every Batch 2/3/4 suite, and the integration invariants stay green unchanged; `FINANCIAL_FEATURES_ENABLED=false`; no finance module emits telemetry (source scan); Batch 3's R5 guards and Batch 4's publication wrappers are untouched (S5).
- **Dashboard authorization** — `/admin/analytics` enforces `analytics.read` server-side; every rate renders with its numerator/denominator counts.
- Preflight (lint, typecheck, unit, build, compose, migration graph), the integration suite, safe smoke, and the diff/status audit all pass.

## Threat-Case Coverage Map (spec §10.1 rows applicable to Batch 5)

| Abuse case | Covered by |
|---|---|
| Privilege escalation / Support → admin escalation | Task 10 `analytics.read` guard (Batch 2 matrix: super_admin/operations_admin/analyst only) + source-contract test |
| Listing IDOR | Search/detail surfaces only `SEARCHABLE_LISTING_STATUSES` listings (S6 drift test); `ss` attribution validates existence + result-set membership, grants nothing (S-14) |
| Stored XSS through listing | Search results + recovery UI render listing text through React escaping only; no `dangerouslySetInnerHTML` added (verified in Task 11 review; React escaping is the repo posture) |
| CSRF state-changing action | Telemetry inserts are append-only analytics rows from page renders/route handlers, not user-visible state; server actions stay POST-only with origin protection (Batch 2 posture note, re-recorded in the verification doc) |
| Suspended-user publication bypass / beta-cohort bypass | Not Batch 5 surfaces — Batch 3's R5 guards + Batch 4's publication wrappers are untouched and their suites re-run green (S5); Batch 3 decided suspended sellers keep live listings → no suspension filter in search (S6) |
| Blocked-user chat bypass | Batch 3's guards run before Batch 5's emission in `startConversationAction`/chat POST (S5) — the wiring tests assert no emission when the guards reject |
| Financial direct route / API mutation / webhook / cron | Batch 1 suites re-run in Task 11; Batch 5 adds no finance surface; the finance-emission source scan (Task 8 test + Task 11 scan) proves telemetry never grows a finance path (S7) |
| Historical finance escape-hatch abuse | Untouched; Batch 1 suites green; `orders.ts` sold transition explicitly NOT wired to telemetry |

## Ambiguities and Deployment Prerequisites

Recorded per spec §4.11/§11.1 — none is silently resolved by implementation; each is handled fail-closed. **Founder decisions (2026-10-06, `/tmp/loaviet/founder-decisions.md`) applied:**

- **FD-1 — RESOLVED (A9):** the canonical province registry is the **34 provincial units per NQ 202/2025/QH15** (founder-approved source `/tmp/loaviet/provinces-34.md`), shipped as the plain module `src/lib/provinces.ts` by **Batch 2 Task 10** — stable slug codes, `displayName`, `kind`, merged legacy units. Batch 5 **only consumes** it. The legacy mapping rule (bottom of `provinces-34.md`) is **authoritative**: merged legacy names map to the new unit (`"Bình Dương"` → `ho-chi-minh`, `"Thừa Thiên Huế"` → `hue`) — applying the founder's source, not guessing. Batch 4 A9 / Batch 5 A9 / Batch 5 B4 are resolved by this.
- **FD-2 — DEFERRED (Batch 2 A1):** the production OTP email/SMS provider stays a **beta-launch prerequisite** (Batch 8 Founder Decision Register); implementation proceeds with the fail-closed production adapter. Not otherwise a Batch 5 surface — listed here for the register.
- **FD-3 — PROCEEDS:** every other recorded ambiguity below proceeds with the **fail-closed default already chosen in this plan** — execution does not stop waiting for founder input. Items needing founder-**authored content** (metric window values, return window, rate denominators, alias content, bot rules, retention schedule, commune registry) ship as clearly-marked placeholders/pending mechanisms and are **launch blockers listed in the Batch 8 Founder Decision Register** — never invented.

The remaining items:

1. **A1 — Attribution/response window values are unspecified.** The spec defines the counting semantics of `listing_to_chat_v1` ("within the attribution window") and `seller_response_rate_v1` ("within the defined response window") but never the *values*. Batch 5 ships the counting engines as pure functions taking the window as a parameter, fixture-reconciliation tests with **explicitly-labeled fixture windows**, and `PENDING_FOUNDER_DECISION` in the contract registry — the dashboard renders these metrics in a named pending state. *Blocks the four rate values (and `repeat_user_rate_v1`'s return window, A3), not the batch.* **PROCEEDS (FD-3)** with the fail-closed default above — execution does not wait; the founder-authored item is a launch blocker in the Batch 8 Founder Decision Register.
2. **A2 — `successful_match_rate_v1` reconciliation policy, attribution period and duplicate handling are unspecified** (the spec only says the definition "must specify" them) **and the Deal domain is Batch 6.** Batch 5 ships the `successful_match` event schema + a raw count on the dashboard (zero until Batch 6 emits); the *rate* stays pending. *Blocks the rate until the founder defines the reconciliation rules and Batch 6 ships Deal.* **PROCEEDS (FD-3)** with the fail-closed default above — execution does not wait; the founder-authored item is a launch blocker in the Batch 8 Founder Decision Register.
3. **A3 — `repeat_user_rate_v1` return window, eligible-account definition, and `user_returned` emission criteria are unspecified.** The event schema ships; emission is deferred (a "return" cannot be detected without inventing a window). *Blocks the metric and the event's emission.* **PROCEEDS (FD-3)** with the fail-closed default above — execution does not wait; the founder-authored item is a launch blocker in the Batch 8 Founder Decision Register.
4. **A4 — Bot/automated-traffic detection rules are unspecified** (`botInternalTrafficRules` field exists; no signal source is defined). Batch 5 excludes nothing under this rule and records `"no bot signal defined — nothing excluded"` in every contract. The `listing_viewed` per-viewer throttle (S-15) is anti-inflation mechanics, not a bot rule; residual inflation (throttled views, un-throttled anonymous bursts) is recorded here. *Blocks stricter exclusions until a bot policy exists.* **PROCEEDS (FD-3)** with the fail-closed default above — execution does not wait; the founder-authored item is a launch blocker in the Batch 8 Founder Decision Register.
5. **A5 — `report rate` and `listing marked sold rate` denominators are unspecified** (§5.8.2 lists them; §5.8.1 defines no contract for either). The dashboard shows raw counts (`report_submitted` — now emitted by Batch 3's action, S7; `listing_marked_sold` — zero until Batch 6), not an invented rate. **Related unspecified definition:** §12.2's "quality listing count" has no P0 definition — "quality" is Batch 4's condition/checklist vocabulary (their A1/A2 are themselves founder-gated), so no quality-listing aggregate ships and the term is recorded here rather than invented. *Blocks the rate forms and the quality-listing aggregate.* **PROCEEDS (FD-3)** with the fail-closed default above — execution does not wait; the founder-authored item is a launch blocker in the Batch 8 Founder Decision Register.
6. **A6 — Telemetry retention and access policy is unspecified** (spec §5.8: "separate retention/access policies"; §4.11 lists *retention* as a non-invention area). Access = `analytics.read` RBAC (Batch 2); retention = **no deletion automation ships** — events accumulate until a reviewed retention schedule exists. **User-level erasure** requires recomputing pseudonyms under a new key version (S-10 defense-in-depth note) — blocked on the same review. *Blocks any retention/erasure job.* **PROCEEDS (FD-3)** with the fail-closed default above — execution does not wait; the founder-authored item is a launch blocker in the Batch 8 Founder Decision Register.
7. **A7 — Alias catalog content is unspecified** (the spec gives only the spacing-variant *examples*). The mechanism ships with an empty/founder-reviewed `SearchAlias` table + catalog-name fallback; the idempotent seed script (S9) takes founder-supplied content; ownership is Batch 4's canonical model seed / Batch 8's model-seed review. *Blocks alias-driven search quality, not the mechanism.* **PROCEEDS (FD-3)** with the fail-closed default above — execution does not wait; the founder-authored item is a launch blocker in the Batch 8 Founder Decision Register.
8. **A8 — Commune-level registry is unspecified.** Batch 4's `communeLevelCode` column stays **unwritten** by Batch 5 (S4 hand-off recorded); no registry, no UI. *Blocks commune-level location until a reviewed registry exists.* **PROCEEDS (FD-3)** with the fail-closed default above — execution does not wait; the founder-authored item is a launch blocker in the Batch 8 Founder Decision Register.
9. **A9 — RESOLVED by FD-1 (was: the canonical province registry is obsolete data — B4).** Batch 2's original `PROVINCE_CODES` was a 63-province list while Vietnam reorganized to **34 provincial units in 2025**; the founder decision adopts the 34-unit registry per **NQ 202/2025/QH15** (`/tmp/loaviet/provinces-34.md`), shipped by **Batch 2 Task 10** as the plain `src/lib/provinces.ts` (slug codes + `displayName` + `kind` + merged legacy units) — Batch 5 consumes it read-only (Task 2). The legacy mapping follows the founder's rule: normalized compare (NFC + trim + case-fold + diacritic-insensitive, common prefixes stripped) against the registry's **authoritative** legacy unit names — merged legacy names map to the new unit (`Bình Dương` → `ho-chi-minh`, `Thừa Thiên Huế` → `hue`), which is applying the source, not guessing (spec §8.3 satisfied); `"Khác"`, district/ward names, typos → `unresolved`. Any legacy-name gap in the shipped registry is **raised against Batch 2**, never patched silently. *No longer blocks anything; recorded as resolved with its source cited.*

Recorded decisions (reversible readings, Batch 2's A5 pattern):

- **D1 — "Valid search session" = one emitted `search_submitted`**: blank and malformed queries are never emitted (structural exclusion, spec §5.8.1 zero_result exclusions), so the denominator is exactly the emitted valid searches. **Filter/sort changes create new search sessions** (each submitted search render = one `searchSessionId` — a refinement click is a new session, not a continuation; recorded so the CTR/zero-result denominators are read correctly).
- **D2 — "Qualified listing view" = authenticated + non-internal + non-owner view**: an anonymous view has no pseudonym to join a conversation to (and conversations require auth), and the seller cannot converse with themselves (`startConversationAction` blocks it) — so both are excluded from numerator *and* denominator, keeping the two on the same population. Reversible by dropping either exclusion.
- **D3 — `search_to_chat_v1` attribution = unbounded click chain (S-16)**: a search session counts when a `search_result_clicked` on listing L is followed by a `conversation_started` for the same actor on the same listing — the spec's own "eventually" wording is unbounded, so the contract ships `"unbounded_click_chain"`, not pending. Reversible by adding a window once A1 is decided.
- **D4 — `seller_response_rate_v1` eligibility + anchor**: an *eligible* new buyer conversation is one in which the buyer sent ≥ 1 message (the `conversation_buyer_first_message` signal event — a mechanical taxonomy extension flagged for founder visibility), and the response-time anchor is the **first** buyer message. `median_first_response_time_v1` dedups by conversationId and excludes internal buyers via the joined signal event. Reversible by redefining eligibility on `conversation_started` alone.

## Rollback and Data Backfill

- **Migration** (`batch5_search_telemetry`): additive-only (verified via `npx prisma migration show` — zero destructive ops on data; the `Listing_status_check_*` DROP+ADD pair expected and additive in effect, S2). Rollback = `git revert` of the Task 1 commit **plus** restore from the pre-migration backup per `docs/backup-restore.md`; no down-migration is authored (the Prisma 8 graph is forward-only). Production applies via the compose `migrate` service `--to production` after the ref advance in Task 1.
- **Listing-location backfill** (`scripts/backfill-listing-location.ts`): dry-run default, `--apply` gated, idempotent (`WHERE locationSource IS NULL` — second run changes 0 rows), expected counts printed by dry-run, **`declaredIds` recorded** (B3). Rollback (documented in the script header):
  - `UPDATE "Listing" SET "provinceLevelCode" = NULL, "locationSource" = NULL WHERE "locationSource" IN ('legacy_mapped', 'unresolved')` — both fields were backfill-written on those rows;
  - `UPDATE "Listing" SET "locationSource" = NULL WHERE id IN (<declaredIds>)` — **locationSource only**: the code on those rows is Batch 4's seller-declared data and is never nulled (B3).
  Post-migration verification = the Task 2 integration test (including the Batch-4-row case) + `npx prisma db verify`.
- **Search-text backfill** (`scripts/backfill-listing-search-text.ts`): dry-run default, `--apply` gated, idempotent (`WHERE searchTextNormalized IS NULL`), `--recompute-all` for staleness (S-4). **No rollback needed** — the column is derived data (title + brand + model, normalized), always recoverable by re-running the backfill; documented in the script header.
- **Alias seed** (`scripts/seed-search-aliases.ts`): dry-run default, `--apply` gated, idempotent (create-if-absent by `(alias, target)`), content empty/founder-reviewed (S9/A7). Rollback = delete the seeded rows by `(alias, target)` list.
- **Telemetry rows**: append-only, no backfill (new table starts empty). No product path updates or deletes `ProductEvent`; a future retention job is blocked on Ambiguity A6.
- **Per-task rollback**: every task is one focused commit; `git revert <task-commit>` restores the previous behavior for all non-migration tasks.

## Final Acceptance Commands

```bash
npm run lint
npx tsc --noEmit
npm test
npm run test:integration
npm run build
npm run preflight
npm run smoke
npx prisma migration list          # graph: baseline → batch2 → batch3 → batch4 → batch5 (tuyến tính — S2)
npx prisma db verify               # marker + schema khớp contract
git diff --check && git status --short
```

All green + the ten gate suites in Task 11 Step 1 + a clean diff/status audit = Batch 5 complete. Beta-launch readiness **additionally** requires the founder-authored items recorded in *Ambiguities* — per FD-3 they are **launch blockers listed in the Batch 8 Founder Decision Register**, not Batch 5 gate failures, and the verification doc must say so verbatim: A1 attribution/response window values, A2 match reconciliation rules, A3 return window, A4 bot rules, A5 rate denominators + quality-listing definition, A6 retention schedule, A7 alias content, A8 commune registry — plus **FD-2's deferred production OTP provider (Batch 2 A1)**. **A9 is resolved by FD-1** (the 34-unit registry per NQ 202/2025/QH15) and is not a launch blocker.
