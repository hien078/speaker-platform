# Private Beta Batch 4 — Listing Quality, Images, Canonical Models, Category Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the portable-Bluetooth-speaker listing a structured, quality-gated object: canonical brand/model required and **DB-verified**, inventory context + condition + defects + repair history + accessories + fulfillment + canonical location captured through the 7-step flow (spec §6.3), photos guided by the §5.6.3 checklist, uploads re-encoded server-side with EXIF/GPS stripped and ownership recorded, and every publication transition enforced by the Batch 2 seller publication gate **extended** (never duplicated) with a server-owned beta category allowlist (spec §5.6.1) — while legacy listings keep working unchanged and no finance surface is touched.

**Architecture:** One additive Prisma 8 migration adds the structured listing columns, `ListingImage.checklistSlot`, the `ListingImageUpload` ownership table, the `inventory_context` enum, and the `archived` `listing_status` value — **`removed` belongs to Batch 3's migration (R2)**; Batch 4 starts execution only on the merged Batch 3 commit (R1). A new publication layer composes behind TWO exported functions: `assertListingContentValid` (category allowlist + regime-conditional zod schema + canonical-model DB check + image-URL ownership) and `assertListingPublishable` = Batch 2's `assertSellerPublicationAllowed` (Seller Verification Policy v1 — now 8 requirements incl. Batch 3's `account_not_suspended` — + beta cohort, unchanged, inheritable per R6) + `assertListingContentValid`. All four Batch 2 publication transitions plus the new draft→review submit call `assertListingPublishable`; non-transition updates call `assertListingContentValid`; admin approval calls the non-throwing `checkListingPublication` once (keeping Batch 2's `publication_requirements_unmet` + `missing=` audit on seller-check failure). The validation regime is derived from the listing's category (beta ⇒ full structured validation; legacy ⇒ existing rules only), with `currentCategorySlug` always read from the DB row, never formData. Batch 3's R5 seller-side lock is consumed as-is — `isModerationLocked()` from `@/src/lib/moderation`, typed `LISTING_MODERATION_LOCKED`, no hardcoded `"removed"` — and extended to the new draft/submit actions; **every** listing write stays conditional on the status read (CAS `.where({ id, status: … })`), and multi-row writes run inside one `db.transaction` under the Batch 3 transaction rule. Uploads move from "validate + store original bytes" to "validate + **re-encode to WebP via sharp** (auto-orient, resize-bounded, strips EXIF/GPS, neutralizes polyglots) + record a `ListingImageUpload` ownership row (row before file)"; listing actions then enforce per-URL ownership: an upload row counts only for its exact `/uploads/<storageKey>` URL and must belong to the seller, a row-less URL is accepted only if already attached to *this* listing and matching a strict `/img|/uploads` path pattern, and everything else — including any attached URL with a scheme — is rejected. The 7-step seller form, the buyer-facing listing detail, and the admin review surface render the new fields; an idempotent offline seed script creates the beta category and the spec-§1 focus brands (models are **founder-supplied**, seeded as `pending` for approval via `/admin/catalog` — the implementer never authors a model list). Location uses the founder-approved 34-unit registry `src/lib/provinces.ts` (FD-1 — `PROVINCES`/`PROVINCE_CODES`/`isProvinceCode`/`resolveLegacyProvince`, shipped by Batch 2 Task 10); Batch 4 only consumes it.

**Tech Stack:** Next.js 16.3.7 App Router (typed routes, server actions), React 19, TypeScript strict, Prisma 8 (`@prisma/orm-postgres` rc, contract + migration graph), PostgreSQL ≥ 15 (scratch container via `scripts/test-integration.sh`), Vitest (unit + scratch-container integration), zod, **`sharp` exact-pinned `0.35.5`** (already a runtime dependency, used today for decode validation in `src/lib/image-validate.ts`; Batch 4 extends it to re-encode/strip metadata — see Global Constraints), `node:crypto` (random storage keys), `tsx` (offline seed script).

**Spec:** `docs/superpowers/specs/2026-10-06-private-beta-marketplace-reset-design.md` — Batch 4 is spec §9 "Batch 4", built on §2.1 (founding-seller publication requirements), §3.1 Listing scope, §4.4/§4.5/§4.7/§4.8/§4.11 (invariants), §5.6–§5.6.4 (listing domain, category gate, lifecycle, photo checklist, upload requirements), §6.3 (7-step flow), §7.1/§7.5 (rate limits, upload security), §8 (migration/compat), §9 Batch 4 Gate, §10/§10.1 (verification + abuse matrix), §11/§11.1 (execution protocol + ambiguity stop rule). **Base dependencies:** (1) the **implemented Batch 2** (`src/lib/rbac.ts` `requireCapability`/`listing.moderate`; `src/lib/audit-event.ts` `auditEvent`/`auditEventTx`/`redactDetail` + the dot-namespaced registry; DB sessions `src/lib/session.ts`; `src/lib/seller-verification-policy.ts` `checkSellerPublicationRequirements`/`assertSellerPublicationAllowed`/`formatMissingRequirements`/`SELLER_RULES_POLICY_VERSION` + the 34-unit registry re-export; `src/lib/seller-verification-status.ts` `isVerifiedSellerStatus`; `src/lib/provinces.ts` — FD-1); (2) the **merged Batch 3 commit** — Batch 3 is implemented and passes its gate FIRST (R1); its `src/lib/moderation.ts` (`MODERATION_LOCKED_LISTING_STATUSES`/`isModerationLocked`), its R5 guards + conditional writes already in `listings.ts`/`admin.ts`, and its `account_not_suspended` 8th publication requirement are all present when Batch 4 starts (see *Batch 3 ↔ 4 Reconciliation*).

## Global Constraints

- Read `AGENTS.md` and the relevant Next.js 16 docs before editing app code. At minimum (paths as used by the Batch 0–3 plans): `node_modules/next/dist/docs/01-app/02-guides/server-actions.md`, `.../01-app/01-getting-started/15-route-handlers.md`, `.../01-app/02-guides/environment-variables.md`, `.../01-app/02-guides/redirecting.md`, `.../01-app/02-guides/testing/vitest.md`, plus the current auth/cookies/`useActionState` API-reference guides under `node_modules/next/dist/docs/`. Heed deprecation notices; this is not the Next.js from training data.
- **Server-action hygiene (Next 16):** a `"use server"` module may export **only async functions** (compiler error E352 otherwise) — no `export const` rate-limit objects or schemas in `src/lib/actions/*.ts`; constants/schemas live in plain modules (`src/lib/listing-schema.ts`). `redirect()` **must never be called inside a `catch` block** — capture the typed error, audit, then `return redirect(...)` outside the `try`; tests mock `next/navigation`'s `redirect` to throw `Error("NEXT_REDIRECT:" + url)` and assert the target.
- **Trust boundary:** `currentCategorySlug` (and every listing field used by a gate) is always resolved from the **DB row** (`listing.categoryId` → `Category`), never from formData; `submitListingAction` builds its whole validation input from the DB row + its `ListingImage` rows — formData carries only the listing id.
- **Transaction constraint-violation rule (Postgres — adopted verbatim from the Batch 3 Global Constraints).** A unique/constraint violation (SQLSTATE `23505`) **aborts the whole `db.transaction`** — Postgres answers any later statement in that tx with `ROLLBACK`, and the Prisma 8 tx context has no savepoints (only `orm`/`sql`/`query`/`execute`). **Catching a violation inside the callback and returning normally is a silent-success bug**: the wrapper tries to COMMIT an aborted tx, Postgres rolls it back, and the action reports success with nothing persisted. Therefore: (1) on any constraint violation, **always throw out of the callback** (let it propagate or re-throw); (2) **classify OUTSIDE** the transaction — catch `SqlQueryError`, branch on `sqlState === "23505"` + the constraint-name prefix (Batch 4's relevant one: `Listing.slug` → typed slug-collision error); (3) **no retry semantics in Batch 4** — a slug collision maps to a typed error outside the callback; (4) **re-read the guarded row INSIDE the tx** — never trust a pre-transaction read for a claim (the CAS `.where({ id, status })` writes re-check inside); (5) a 0-row conditional write **throws out of the callback** and is classified outside (status changed underneath → typed conflict error). Pinned by the no-silent-success integration tests in Task 8.
- Prisma 8 contract/migration workflow (`.agents/skills/prisma-8/references/contract.md` + `migrations.md` + `migration-model.md`): edit `src/prisma/contract.prisma` → `npx prisma contract emit` → `npx prisma migration plan --name <snake_slug> --from <batch3-dir>` → fill any `placeholder(...)`/data-transform holes in the rendered `migration.ts` → self-emit with `node "$DIR/migration.ts"` → review with `npx prisma migration show "$DIR"` → `npx prisma db migrate` → advance refs. Never `db update` against a shared/production database; never edit `ops.json`/`contract.json`/`contract.d.ts` by hand; commit contract artefacts + migration package together. Batch 4 expects **zero data transforms** — `pendingPlaceholders` must be `false` (read it from `npx prisma migration plan … --json`). Shell commands use `"$DIR"`/`"$END_HASH"` variables, never bare `<dir>`/`<end-hash>` placeholders (zsh reads those as redirections). **Quote bracketed paths in every `git add`** (zsh globs `[id]`/`[slug]` as a character class).
- **Dependency policy (Batch 2 precedent).** Security-reviewed, pinned dependencies are preferred over bespoke parsing. Batch 4 adds **no new runtime dependency**: it exact-pins the existing one — `npm install --save-exact sharp@0.35.5` (removes the `^` range; lockfile already resolves 0.35.5). **Justification:** sharp is the standard Node binding to libvips — a maintained, widely-audited decode/encode library — and is already the repo's image validator (`src/lib/image-validate.ts`); Batch 4 reuses it for server-side re-encoding (decode → pixels → encode), which is the spec §5.6.4/§7.5 "safe re-encoding where practical" and the metadata/GPS strip in one step. No hand-rolled EXIF parser, no bespoke format sniffing beyond the existing magic-byte table. `npm audit --omit=dev` must be clean at batch acceptance (recorded in the verification doc).
- **Canonical test stubbing (one recipe — the Batch 3 Global Constraints recipe, used by every unit AND integration test that imports an action/page):** `vi.mock("server-only", () => ({}))`; `vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))`; `vi.mock("next/navigation", () => ({ redirect: (url) => { throw new Error(\`NEXT_REDIRECT:${url}\`); }, notFound: () => { throw new Error("NEXT_HTTP_ERROR_FALLBACK;404"); } }))`; `vi.mock("next/headers", …)` with `vi.hoisted` header/cookie state (see `tests/unit/publication-gate.test.ts` for the exact working form); a partial `vi.mock("@/src/lib/auth")` whose `requireUser`/`getCurrentUser` return a fixture `SessionUser` (in integration tests the fixture user is a **real row** in the scratch DB); `vi.mock("@/src/lib/rbac", …)` whose `requireCapability` returns a `fixtureAdminContext()` whose `user` is a real `User` row (`AuditEvent.actorId` is an FK). Unit tests additionally mock `@/src/prisma/db.client` with in-memory model maps; integration tests keep the real db. **Same-module call spying does not work in vitest** — cross-module assertions use `vi.mock(() => ({ …vi.importOriginal() }))` counting wrappers or order-observable assertions; claims about *absence* of a same-registry call (e.g. "admin.ts makes no direct `checkSellerPublicationRequirements` call") are proven by the Task 9 **source scan**, not by spies.
- **Additive-only schema.** No drop, rename, or repurpose of any existing column/table/enum value. `Listing.city`, `Listing.title`, `Listing.description`, `Listing.price`, `Listing.negotiable`, `Listing.acceptExchange`, `Listing.condition` (`product_condition`), `Listing.productModelId`, `ListingImage.url`, and every finance model stay exactly as they are. All new columns are nullable; new enum values are appended. **Expect the enum append to render as DROP + ADD of the `Listing_status_check_*` constraint** — that pair is additive in effect (R3); classify it so, do not halt on it.
- **Preserve Batch 1.** `FINANCIAL_FEATURES_ENABLED` stays `false`; every existing finance guard and its tests (`tests/unit/financial-shutdown-*.test.ts`, `tests/unit/finance-public-surface.test.ts`, `tests/unit/admin-finance-readonly.test.ts`, `tests/unit/mock-payment-guard.test.ts`, `tests/integration/escrow.test.ts`) must stay green unchanged. No Batch 4 task may enable, bypass, or weaken a finance boundary. Batch 4 touches no finance model, route, action, cron, or webhook. (Known dormant finance paths that set `Listing.status = "approved"` without the publication gate — `resolveDisputeAction`'s order-completion branch in `src/lib/actions/admin.ts` **~L144** and the order-completion path in `src/lib/actions/orders.ts` ~L373 — are unreachable while finance is disabled (Batch 1 boundary); they are recorded in the verification doc as a defense-in-depth note for the finance re-enable review, not changed here.)
- **Preserve Batch 2.** The seller publication gate stays THE single seller-side gate: Batch 4 wraps and extends it (`assertListingPublishable` calls `assertSellerPublicationAllowed`), never re-implements it. Batch 2's `runPublicationGate`/`formatMissingRequirements` Vietnamese missing-requirement text in `listings.ts` is **kept verbatim** for `SELLER_PUBLICATION_BLOCKED` (existing tests expect it). All four Batch 2 publication transitions (`createListingAction`, `updateListingAction` content-change→pending, `toggleListingVisibilityAction` hidden→approved, `approveListingAction`) keep enforcing it after the rewiring — `approveListingAction`'s Batch 2-era **direct `checkSellerPublicationRequirements` call is deleted** and replaced by one `checkListingPublication` call (which includes it), **keeping the `listing.approve_blocked` audit reason `publication_requirements_unmet` + `detail: missing=…` on seller-check failure** (`tests/unit/publication-gate.test.ts` pins it). The Batch 2/3 gate suites (`tests/unit/publication-gate.test.ts`, `tests/unit/seller-verification-policy.test.ts`, `tests/unit/seller-verification-actions.test.ts`, `tests/integration/seller-verification.test.ts`, `tests/unit/provinces.test.ts`) must stay green — Task 4 updates only the *fixtures* those tests need (their category fixture must become the beta category; if `tests/integration/seller-verification.test.ts` creates legacy-category listings, those fixtures migrate too), never their asserted invariants.
- **Preserve Batch 3 (R5).** Batch 3's `MODERATION_LOCKED_LISTING_STATUSES = ["removed"]` + `isModerationLocked(status)` live in `src/lib/moderation.ts`; its guards (typed `LISTING_MODERATION_LOCKED`) already sit in `updateListingAction`, `toggleListingVisibilityAction`, `deleteListingAction` when Batch 4 starts. Task 4's rewire **keeps them** (calling `isModerationLocked(listing.status)` from `@/src/lib/moderation` — **never** a raw `.includes` on the tuple and **never** a hardcoded `"removed"` string in `listings.ts`; Batch 3's source-contract test pins that), adds the same guard to `saveListingDraftAction` and `submitListingAction`, and the publication-gate suite asserts it. **Every existing conditional write is kept** (toggle/update already CAS `.where({ id, status })`; approve/reject are conditional pending-only) and the new writes are conditional too: submit claims `.where({ id, status: "draft" }).updateAll(…)`, the draft update is conditional on `status: "draft"`. `approveListingAction`/`rejectListingAction` stay pending-only, so `removed` never re-enters via review. Batch 3's `account_not_suspended` (active `UserSuspension` blocks publication) is the 8th requirement inside `checkSellerPublicationRequirements` — the wrapper inherits it and Task 4/8 tests exercise it explicitly.
- **Backend authorization only** (spec §4.5, §4.9). Every privileged action checks capability server-side via Batch 2's `requireCapability*`; the category allowlist is a server-owned constant, not client state; hidden form options are convenience, never enforcement. The client form never imports `src/lib/listing-schema.ts` / `src/lib/beta-categories.ts` — categories, labels, slots, provinces arrive as props from the server page.
- **Policy Non-Invention (spec §4.11 + §11.1 + FD-3).** Do not invent semantics for condition-grade definitions, photo-checklist requiredness, pricing policy, retention, or moderation sanctions. Per FD-3: on material ambiguity, **proceed with the fail-closed default already chosen in this plan** — do not stop the affected task waiting for founder input. Items that need founder-**authored content** ship as clearly-marked placeholders/pending mechanisms and are listed in the **Batch 8 Founder Decision Register** as launch blockers — never invented. The plan's *Ambiguities* section lists the known ones.
- **No money path, no misleading promise** (spec §4.1, §4.2). New UI copy must not claim payment/delivery/authenticity/condition/meetup guarantees; the existing neutral form copy ("LoaViet không giữ tiền và không tham gia thanh toán…") is the pattern. No price suggestion/estimation UI is added (spec §13.6/§13.7); the existing model-page "Giá tham chiếu (median)" already displays its sample size ("Mẫu giá thu thập: N điểm giá") — keep it factual, add no authoritative-value language.
- **Location neutrality** (spec §4.7). Location copy uses neutral operational labels only; never "an toàn"/"đảm bảo"/"verified market" wording; no street-address capture (spec §5.6: exact street address is not a public listing field) — the location step collects province code + coarse display name with explicit guidance against entering a home address.
- **Analytics/audit privacy** (spec §4.8). No image bytes, EXIF, file paths, or listing free-text PII into `captureEvent`/`captureError` payloads beyond typed scope strings; audit `detail` goes through Batch 2's `redactDetail` convention and carries only ids/typed codes, never description bodies; `listing.submitted` records `policyVersion: SELLER_RULES_POLICY_VERSION` (§4.6).
- **Upload security baseline (spec §5.6.4 + §7.5).** Never trust filename extension or client MIME alone: magic bytes + sharp decode cross-check (existing `validateImage`) precede re-encode; SVG/HTML never accepted; `Content-Length` and encoded-size, pixel-dimension, and decompression-bomb caps enforced *before* full decode; storage keys are `crypto.randomUUID()`-based with a fixed allowlisted extension; the written file is always the **re-encoded** buffer, never the original upload; the `ListingImageUpload` row is written **before** the file (an orphaned row is harmless — an orphaned publicly-reachable file is not).
- OpenCode must not push, merge, deploy, or destructively clean the repository. Commit each task separately with the listed message; never `git add .`. Exclude from commits: `.claude/settings.json`, `public/uploads/` runtime files, secrets, local scratch data, unrelated work.
- Browser E2E: the repo has no E2E infrastructure (recorded in the Batch 2/3 verification docs). Batch 4 again covers its critical flow with action-level unit tests + real-DB integration tests, and records browser E2E for the portable-speaker listing flow as a tracked pre-invite prerequisite (spec §10, §12) — see *Deferred*.

## Batch 4 Scope Decisions

In scope (spec §9 Batch 4 deliverables):

1. Structured portable-speaker listing fields on `Listing`: `inventoryContext` (new/open_box/used), `includedAccessories`, `knownDefects`, `repairHistory`, `fulfillmentMethods`, canonical location (`provinceLevelCode`, `communeLevelCode?`, `locationDisplayName`), photo-checklist slot on `ListingImage`. `city` is set to the **canonical province `displayName`** from the 34-unit registry (`PROVINCE_CODES[provinceLevelCode]` — FD-1; e.g. `ho-chi-minh` → "TP. Hồ Chí Minh"), and Task 5 refreshes `CITIES` to the same 34 canonical names so the existing `/listings` city filter keeps matching; `locationDisplayName` remains the seller's coarse display text.
2. Canonical brand/model **required and DB-verified** for beta-category submissions (spec §6.3 Step 1): model exists, `status = "approved"`, `model.brandId === brandId`, `model.categoryId ===` the beta category — checked inside the publication layer, not just zod presence; existing `Brand`/`ProductModel`/`Listing.brandId`/`Listing.productModelId` reused, no new catalog tables.
3. Initial model seed: idempotent offline script creating the beta category + the spec §1 focus brands (JBL, Marshall, Sony, Bose, Soundcore). **The implementer never authors a model list from training data** — models are founder-supplied (`--models <founder.json>`), upserted as `status: "pending"` for approval via `/admin/catalog`; upsert is create-if-absent and never reassigns an existing model's category (A3/A11).
4. Condition field: existing `product_condition` enum + labels kept in the flow; richer per-grade definition copy — and its **overlap with `inventoryContext` (`new`/`open_box` exist in both)** — is a founder-content item (A1); no cross-field rule is invented.
5. Price + negotiability: existing columns/validation kept unchanged (no new pricing policy).
6. Fulfillment options: `meetup | seller_delivery | carrier | other` (values mapped from spec §5.2's fulfillment methods — recorded decision A7).
7. Photo checklist: the 8 §5.6.3 slots verbatim as guidance UI + structured slot tag; no slot is hard-required beyond the existing ≥1 image rule (requiredness = A2). The `label_serial` slot copy tells the seller to cover/blur the serial **before** shooting, because slot photos render publicly (§5.6.3 "do not require public display of sensitive serial information").
8. Upload hardening per §7.5: early `Content-Length` rejection, re-encode to WebP (EXIF/GPS strip, auto-orient, resize-bounded output), upload ownership rows (row before file), per-user rate limit ≤ per-IP limit, justified decompression-bomb caps (current caps are 40MP/10k px — Batch 4 moves them to 50MP/12k px), and `/uploads` serving headers (`nosniff` + CSP `default-src 'none'; sandbox`) in `next.config.ts`.
9. Category publication allowlist `BETA_PUBLICATION_CATEGORIES = ["portable_bluetooth_speaker"]` (spec §5.6.1 verbatim value, keyed by category slug) enforced at create/category-change/submit/approve.
10. Draft behavior (spec §4.4, §5.6.2): `saveListingDraftAction` (pre-verification allowed, no seller gate) + `submitListingAction` (draft→pending, full gate) alongside the existing gated create/submit-on-create path. The edit page for a draft offers "Lưu nháp" (`saveListingDraftAction`) and "Gửi duyệt" (`submitListingAction` with the listing id) — `updateListingAction` never transitions a draft (a draft edit via `updateListingAction` stays `draft`; see Task 4).
11. Audit events: `listing.draft_created`, `listing.draft_updated`, `listing.submitted` (with `policyVersion`), `listing.submit_blocked`, and `beta_catalog.seeded` appended to the `src/lib/audit-event.ts` registry comment (same file touched by Task 4); `listing.approve_blocked` reused — **reason `publication_requirements_unmet` + `missing=` kept for seller-check failures** (Batch 2 pin), new typed reason `listing_content_invalid` + `issues=` for content failures.
12. Seller UI: 7-step progressive-disclosure form (spec §6.3) with verification-status step (Batch 2 `seller_rules` acceptance status + link — no new acceptance text), draft save, and submit; sell pages adapted; **buyer-facing listing detail renders the structured fields** (defects, accessories, condition, inventory context, location display; `null` → absent); admin review surface shows the structured fields.
13. `listing_status` addition **`archived` only** (spec §5.6.2 lifecycle value, reserved — no Batch 4 transition writes it). **`removed` is added by Batch 3's migration (R2)**; Batch 4 keeps Batch 3's R5 guards (`isModerationLocked`) and extends them to the draft/submit actions; no Batch 4 transition writes either value.

Explicitly deferred (do not build here): Batch 5 search normalization/aliases/diacritic search/location filters/telemetry/metric contracts (incl. commune-level location dataset — Batch 4 stores the column, Batch 5 populates it); Batch 3 reports/blocks/moderation cases/evidence/appeals (already merged before Batch 4 starts — only the R5 guard extension and coordination interface are Batch 4's); Batch 6 Deal/chat hardening (incl. the noted gap that `startConversationAction`/`toggleWishlistAction` accept non-approved listings — recorded in the verification doc as a Batch 6 follow-up); Batch 7 cohort operations/console; Batch 8 legal text (Seller Rules content is Batch 8; Batch 2's acceptance-*recording* mechanism is reused as-is); draft autosave (spec §6.3: "desirable but not release-blocking"); browser E2E infrastructure; price intelligence/AI pricing (§13.6/§13.7 — no new price UI); any change to `acceptExchange`/exchange flows (column kept for compat; the beta form simply does not offer the checkbox — exchange is a dormant finance-adjacent flow); account deletion; image CDN/S3 move (route keeps local `public/uploads` storage with the ownership table abstracting it); orphaned-upload retention/cleanup (A8 — not invented); replacing the listing-detail page's legacy `user.role === "admin"` read gate (`app/listings/[slug]/page.tsx:45` — a pre-Batch-2 display-only role check for viewing non-approved listings; recorded in the verification doc as a follow-up, not changed here).

## Legacy Migration Decisions (additive, spec §8 + §5.6)

- **Legacy listing (defined):** any `Listing` row created before the Batch 4 deploy. Recognizable by construction: it sits in a category whose slug is *not* in `BETA_PUBLICATION_CATEGORIES`, because post-Batch-4 creation is allowlist-gated (see invariant below). Its new structured columns are `NULL` = "not captured"; its `city` is free text; its images may be seed `/img/listings/…` paths or pre-Batch-4 `/uploads/…` files with **no** `ListingImageUpload` row.
- **Compatibility state (explicit):** legacy listings keep rendering publicly (`approved`), keep their category, remain editable by their seller under the *legacy validation regime* (existing title/description/price/city/≥1-image rules only — no canonical model, no structured fields required), and on content change go `→ pending` and can be re-approved by admin as before. No backfill, no rewrite, no destructive migration. `NULL` structured fields render as absent sections. **Interim (A10):** a legacy-regime listing in status `rejected` does **not** resubmit to `pending` on edit (it stays `rejected` with a form message directing the seller to create a new beta-category listing) — the safer fail-closed behavior until the founder decides the legacy-repurposing policy.
- **Allowlist invariant (the compat rule):** *no listing can be created in, or moved into, a non-allowlisted category; a listing whose category is unchanged is grandfathered.* Therefore any listing in a legacy category predates Batch 4, and the validation regime is derived purely from the category: beta-category ⇒ full structured validation; legacy-category ⇒ legacy validation. Category changes are permitted **only into the allowlist** (and then require full beta validation of the whole input).
- **`city` ≡ `legacyLocationText` (mapping decision):** spec §5.6 lists `legacyLocationText?`/`legacyDistrictText?`; the existing non-null `Listing.city` already *is* the legacy location text, so no duplicate column is added. For new beta listings `city` is populated with the **canonical province `displayName`** (`PROVINCE_CODES[provinceLevelCode]` from the 34-unit registry `src/lib/provinces.ts` — FD-1) so the existing `/listings` city filter (`app/listings/page.tsx` exact-matches `CITIES`, refreshed in Task 5 to the same 34 names) keeps working; `locationDisplayName` is the seller's coarse display text; `provinceLevelCode` (a stable registry slug code) is the canonical machine-readable field. **Legacy mapping rule (FD-1, authoritative per NQ 202/2025/QH15 — not guessing):** a legacy free-text `city`/province value maps to a new unit ONLY when it equals (after NFC + trim + case-fold + diacritic-insensitive compare, with "Tỉnh"/"TP."/"Thành phố" prefixes stripped) one of the legacy unit names in the registry's `legacyNames` ("Bình Dương" → `ho-chi-minh`, "Hải Dương" → `hai-phong`, …); **"Thừa Thiên Huế" is NOT in the table — `resolveLegacyProvince("Thừa Thiên Huế")` returns `null`** (only "Huế" matches `hue`; `tests/unit/provinces.test.ts` pins this); "Khác", district/ward names, and typos stay unresolved. Batch 4 performs **no** legacy mapping/backfill (Batch 5 migrates) — the rule is recorded for any surface that later interprets legacy `city` text.
- **`approved` ≡ spec `published`, `hidden` ≡ `paused`, `pending` ≡ `ready_for_review`/`under_review`, `removed` ≡ moderation takedown (mapping decision):** the spec §5.6.2 lifecycle is a recommendation; Batch 4 maps it onto the existing enum to avoid repurposing statuses (spec §8.1 spirit) and adds only `archived`. `verification_blocked` is **not** added as a distinct state — a draft whose seller fails the gate stays `draft` with the missing requirements surfaced by `checkListingPublication` (recorded as decision A5, reversible).
- **Pre-Batch-4 uploaded files:** remain valid *while attached to a listing* under image-ownership rule (2) — attached + strict `/img|/uploads` path pattern + no `..`; re-attaching a detached pre-Batch-4 upload to another listing is rejected (no ownership row) — the seller re-uploads, which re-encodes it. An attached URL with any scheme (`https://…`) is **always** rejected, even at approve. Documented in the verification doc as accepted compat behavior.
- No existing finance table, historical record, or legacy column is dropped or repurposed.

## Dependency and Parallelization Map

```text
(R1: Batch 3 đã merge + pass gate TRƯỚC khi Batch 4 bắt đầu — mọi task dưới chạy trên commit Batch 3)
Task 1  contract + migration (structured columns, checklistSlot, ListingImageUpload,
        inventory_context, listing_status += archived; removed thuộc Batch 3 — R2)
        ↓ (schema is the base commit for everything)
Task 2  beta-categories + listing-schema + publication wrapper (extends Batch 2 gate)  ┐ {2, 3} parallel
Task 3  upload hardening (re-encode WebP, EXIF/GPS strip, ownership rows, limits, headers) ┘
        ↓
Task 4  listing actions: draft/submit + create/update/toggle/approve rewired through
        assertListingPublishable/assertListingContentValid; image-URL ownership; audit;
        rate limits; R5 guards (isModerationLocked) kept + extended; conditional writes + tx
        ↓
        ├── Task 5  seller + buyer UI: 7-step form, sell pages, listing detail, labels, CITIES refresh ┐ {5, 6, 7} parallel
        ├── Task 6  admin review UI: structured fields + workflow badge on /admin/listings           │  (7 needs only 1+2;
        └── Task 7  beta catalog seed script + seed integration test                                  ┘   its happy-path test
        ↓                                                                                               runs after 4)
Task 8  legacy compat + full publication-gate integration (real DB)
        ↓
Task 9  batch gate verification + verification doc
```

File-conflict rules (R7 order — Batch 3 edits these first, then Batch 4): `tests/unit/publication-gate.test.ts`, `src/lib/seller-verification-policy.ts`, `src/lib/actions/listings.ts`, `src/lib/actions/admin.ts` carry Batch 3's changes when Batch 4 starts; Batch 4 edits them **on top of the merged Batch 3 commit** and keeps Batch 3's guards/cases (R5/R6). `src/prisma/contract.prisma` is Task 1 only. `src/lib/image-validate.ts` + `app/api/upload/route.ts` + `src/lib/image-process.ts` + `next.config.ts` are Task 3 only. `src/lib/beta-categories.ts`/`listing-schema.ts`/`listing-images.ts`/`listing-publication.ts` are Task 2 creations, extended by no other task (Task 4 only *calls* them). `app/sell/new/page.tsx`, `app/sell/[id]/edit/page.tsx`, `app/sell/my/page.tsx`, `src/components/portable-listing-form.tsx`, `src/lib/constants.ts`, `app/models/[slug]/page.tsx`, `app/listings/[slug]/page.tsx`, `src/components/listing-form.tsx`, `src/components/profile-form.tsx` are Task 5 only (constants: Batch 4 adds **only** the `archived` label/badge — `removed` labels come from Batch 3, R8). `app/admin/listings/page.tsx` + `tests/unit/admin-listings-guard.test.ts` are Task 6 only. `scripts/seed-beta-catalog.ts` is Task 7 only. `src/lib/audit-event.ts` (registry comment) is Task 4 only. Everything else is single-owner.

## Review Focus

1. **EXIF/GPS leaking through uploads** — the current `app/api/upload/route.ts` validates the buffer then writes the **original bytes** (`writeFile(path.join(dir, name), buf)`), so GPS/EXIF (and any trailing payload) survive to `public/uploads`. This is the batch's #1 finding (spec §4.7 location neutrality, §4.8 privacy, §5.6.4, §7.5). Pinned by Task 3: `tests/unit/image-process.test.ts` "re-encode strips GPS/EXIF from a JPEG carrying a GPS IFD" + "output contains no EXIF marker at all" + `tests/unit/upload-route.test.ts` "the stored file is the re-encode output, not the upload" + "the upload row is written before the file".
2. **Publication-gate bypass via the new draft/submit path or a content-change update** — `submitListingAction` (draft→pending), a category-change `updateListingAction`, or a `hidden` listing's content edit sneaking a listing into `pending`/`approved` without the seller gate + allowlist + schema + model check. Pinned by Task 4: `tests/unit/publication-gate.test.ts` extended — create/submit/update-into-pending/toggle each call `assertListingPublishable` exactly once (cross-module `vi.mock(() => ({ …vi.importOriginal() }))` counting wrappers); **every** structured field, brand/model, image set, and slot set counts as a content change, and `hidden` content changes also go to `pending` (B3); revoked/suspended sellers **and actively `UserSuspension`-suspended sellers** blocked on every path including admin approval.
3. **Category-allowlist / canonical-model bypass** — creating in (or moving into) a legacy slug to escape beta validation, or submitting against a `pending`/`merged`/wrong-brand/wrong-category model. Pinned by Task 2: `tests/unit/beta-categories.test.ts` + `tests/unit/listing-publication.test.ts` (model DB checks: `MODEL_INVALID`/`MODEL_BRAND_MISMATCH`) + Task 4 action cases.
4. **Arbitrary/foreign image URLs stored via listing actions** — today `createListingAction`/`updateListingAction` persist whatever `images[]` strings arrive in formData (`https://…`, `javascript:`, `/../../etc`). Pinned by Task 4: `tests/unit/listing-images.test.ts` — per-URL order (1) upload row **for its exact `/uploads/<storageKey>` URL** → owner check, (2) row-less + attached → strict path pattern + no `..`, (3) everything else rejected **including attached URLs with a scheme — even when the scheme URL's basename matches the seller's own upload row**; duplicates and slot-length mismatches rejected.
5. **Legacy listing breakage** — new validation rejecting a pre-Batch-4 listing's edit/resubmit (no canonical model, seed `/img/…` images, legacy category). Pinned by Task 8: `tests/integration/legacy-listing-compat.test.ts` — seeded legacy listing edits, resubmits, and re-approves unchanged; kept seed images and **attached pre-Batch-4 `/uploads/<uuid>.jpg`** pass; detached pre-Batch-4 uploads are rejected with a typed error.

---

## Task 1: Contract additions + Batch 4 migration

**Files:**

- Modify: `src/prisma/contract.prisma`
- Create: `migrations/app/<ts>_batch4_listing_quality/` (rendered by `prisma migration plan`)
- Modify (emitted): `src/prisma/contract.json`, `src/prisma/contract.d.ts`
- Modify: `migrations/app/refs/db.json`, `migrations/app/refs/production.json` (ref advancement)
- Test: `tests/integration/batch4-migration.test.ts`

**Interfaces:**

- Consumes: existing `Listing`, `ListingImage`, `User`, `Category`, `Brand`, `ProductModel`, finance models (untouched) — **on the merged Batch 3 commit** (R1), so `listing_status.removed` and Batch 3's moderation tables already exist.
- Produces (used by every later task via `db.orm.public.<Model>`): `Listing` columns `inventoryContext`, `includedAccessories`, `knownDefects`, `repairHistory`, `fulfillmentMethods` (`Json?`), `provinceLevelCode`, `communeLevelCode`, `locationDisplayName`; `ListingImage.checklistSlot`; model `ListingImageUpload` + `User.imageUploads` relation; enums `inventory_context`, and the `listing_status` value `archived` (**only** — R2).

- [ ] **Step 0: Confirm the Batch 3 base (R3)**

- `migrations/app/refs/db.json` and `refs/production.json` hash **equals Batch 3's migration `to` hash** (Batch 3's dir: `migrations/app/20261006T1420_batch3_trust_safety`); `npx prisma migration list` shows `baseline → batch2 → batch3` with no node holding two outgoing edges. If not: stop — do not plan over a stale base.
- If a Batch 4 package was ever authored on a stale base: delete the uncommitted package + snapshot, re-emit, re-plan — **never hand-merge `ops.json`/`contract.json`**.

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/batch4-migration.test.ts` (runs only via `scripts/test-integration.sh`, scratch DB, same `hasDb` guard pattern as `tests/integration/escrow.test.ts`):

- `applies the batch 4 migration additively`: after the script's migrate step, a `Listing` create+read round-trips with every new column set and then null (proves columns exist and stay nullable); `ListingImage` accepts `checklistSlot: "front"` and `null`; `ListingImageUpload` accepts a create+delete round-trip with `ownerUserId`/`storageKey`/`bytes`/`width`/`height`; `Listing.status` accepts `"archived"` (Batch 4's addition) **and** `"removed"` (present from Batch 3's migration — asserted, not added).
- `migration leaves the database consistent`: `npx prisma db verify` exits 0 after migrate.
- `preserves finance tables and legacy listing shape`: `Order`, `Payment`, `Payout`, `WithdrawRequest`, `LedgerEntry`, `Dispute` still accept reads; a `Listing` created with only legacy fields (no structured columns) reads back with `inventoryContext: null` etc.; `Listing.city` still required and populated.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:integration`
Expected: FAIL — new columns/table/enum value do not exist.

- [ ] **Step 3: Edit the contract, emit, plan the migration**

Add to `src/prisma/contract.prisma` (match existing style: `// use prisma-8` header, `@@type("pg/text@1")` on enums, `TimestamptzString`, `temporal.updatedAtString()`):

```prisma
// ─── Enums (Batch 4 — listing quality) ───

enum inventory_context {
  @@type("pg/text@1")
  new      = "new"       // mới / nguyên seal
  open_box = "open_box"  // mở hộp chưa dùng
  used     = "used"      // đã qua sử dụng
}
```

Append to the existing `listing_status` enum (additive — existing values untouched; **`removed` already exists from Batch 3's migration — do not re-add it, R2**):

```prisma
enum listing_status {
  @@type("pg/text@1")
  draft    = "draft"
  pending  = "pending"
  approved = "approved"
  rejected = "rejected"
  hidden   = "hidden"
  sold     = "sold"
  removed  = "removed"   // Batch 3 — đã có từ migration Batch 3; Batch 4 KHÔNG thêm giá trị này
  archived = "archived" // §5.6.2 lifecycle — reserved, chưa có transition trong P0 (Batch 4 thêm)
}
```

Add to `Listing` (additive only — nothing existing is removed or retyped):

```prisma
  // ─── Batch 4 — structured portable-speaker listing (spec §5.6) ───
  inventoryContext    inventory_context? // NULL = legacy "not captured"
  includedAccessories String?           // ≤2000 ký tự (schema)
  knownDefects        String?           // ≤2000 ký tự (schema)
  repairHistory       String?           // ≤2000 ký tự (schema)
  fulfillmentMethods Json?              // ("meetup"|"seller_delivery"|"carrier"|"other")[] — zod-validated tại boundary
  provinceLevelCode   String?           // slug code tỉnh/thành — 34 đơn vị, src/lib/provinces.ts (FD-1: NQ 202/2025/QH15)
  communeLevelCode    String?           // reserved — Batch 5 location model populate
  locationDisplayName String?           // hiển thị thô — KHÔNG phải địa chỉ nhà riêng (spec §5.6)
```

Add to `ListingImage`:

```prisma
  checklistSlot String? // §5.6.3: front|back|control_panel|ports|damage|accessories|box|label_serial — NULL = legacy/không gán slot
```

New model + `User` relation:

```prisma
// ─── Upload ownership (Batch 4 — spec §5.6.4 "ownership authorization") ───

model ListingImageUpload {
  id          String            @id @default(uuid())
  ownerUserId String
  owner       User              @relation("listing_image_upload_owner", fields: [ownerUserId], references: [id], onDelete: Cascade)
  storageKey  String            @unique // "<uuid>.webp" — khóa ngẫu nhiên, KHÔNG dùng tên file của client
  bytes       Int
  width       Int
  height      Int
  createdAt    TimestamptzString @default(now())

  @@index([ownerUserId, createdAt])
}
```

```prisma
  // trong model User (additive):
  imageUploads ListingImageUpload[] @relation("listing_image_upload_owner")
```

Then (the `--from` is **mandatory** per R3 — the Batch 3 dir; `--json` to read `pendingPlaceholders`):

```bash
npx prisma contract emit
npx prisma migration plan --name batch4_listing_quality --from migrations/app/20261006T1420_batch3_trust_safety --json
# đọc pendingPlaceholders từ JSON — phải false
DIR=$(ls -d migrations/app/*_batch4_listing_quality)          # ngay sau khi plan tạo package
END_HASH=$(jq -r .to "$DIR/migration.json")                    # dùng cho Step 5
```

- [ ] **Step 4: Review the package, self-emit**

- Confirm the plan output's `from:` line names the current `db`/`production` ref hash (== Batch 3's `to`), not `(baseline)` over a non-empty graph, and `pendingPlaceholders` is `false` (all new columns nullable/defaulted — a placeholder means an accidental non-null column; fix the contract instead).
- `npx prisma migration show "$DIR"` — confirm **no destructive operation on data**: the enum append renders as a **DROP + ADD pair of `Listing_status_check_*`** (the CHECK constraint rebuild) — that is additive in effect (R3); classify it so and continue. Any drop/alter of an existing *column/table* is a plan violation.
- No data transform is needed (legacy rows keep `NULL`); do not invent one.
- Self-emit: `node "$DIR/migration.ts"` (regenerates `ops.json` + `migrationHash`); re-run `npx prisma migration show "$DIR"`.

- [ ] **Step 5: Apply to the dev DB and advance refs**

```bash
npx prisma db migrate --advance-ref db                   # dev DB (DATABASE_URL từ .env, container 5435)
npx prisma migration ref set production "$END_HASH"    # docker-compose.prod.yml migrate service chạy --to production
npx prisma db verify
```

`production` ref must be advanced in the same commit (same rule as Batch 2 Task 1).

- [ ] **Step 6: Run the integration test to verify it passes**

Run: `npm run test:integration`
Expected: PASS (all `batch4-migration` cases + existing `escrow.test.ts` + Batch 2/3 suites green).

- [ ] **Step 7: Commit**

```bash
git add src/prisma/contract.prisma src/prisma/contract.json src/prisma/contract.d.ts migrations/app migrations/snapshots tests/integration/batch4-migration.test.ts
git commit -m "feat(db): add batch 4 listing quality contract"
```

**Gate:** no destructive op on data in `migration show` (the `Listing_status_check_*` DROP+ADD pair is expected and additive in effect); `db verify` clean; finance integration test still green; graph stays linear (R3).

## Task 2: Beta category allowlist + listing submission schema + publication wrapper

**Files:**

- Create: `src/lib/beta-categories.ts` (**plain module — no `server-only`**, so the offline seed script can import it under `tsx`; Batch 2 `admin-mfa-key.ts` precedent)
- Create: `src/lib/listing-schema.ts` (plain module — **not** a `"use server"` file; holds the rate constants per the Next 16 async-export rule)
- Create: `src/lib/listing-images.ts`
- Create: `src/lib/listing-publication.ts`
- Test: `tests/unit/beta-categories.test.ts`
- Test: `tests/unit/listing-schema.test.ts`
- Test: `tests/unit/listing-images.test.ts`
- Test: `tests/unit/listing-publication.test.ts`

**Interfaces:**

- Consumes: `Category`/`ListingImageUpload`/`ListingImage`/`ProductModel` models (Task 1), Batch 2's `assertSellerPublicationAllowed`/`checkSellerPublicationRequirements`/`SellerPublicationRequirement`/`SELLER_RULES_POLICY_VERSION` (`src/lib/seller-verification-policy.ts` — now 8 requirements incl. Batch 3's `account_not_suspended`), the 34-unit province registry `src/lib/provinces.ts` (FD-1 — plain module, no db/`server-only`, shipped by Batch 2 Task 10; **real API: `PROVINCES` (field `legacyNames`), `PROVINCE_CODES` (`Record<code, displayName>`, 34 entries), `isProvinceCode`, `resolveLegacyProvince`** — Batch 4 only consumes it), `CITIES` (`src/lib/constants.ts` — refreshed in Task 5).
- Produces (used by Tasks 4–8):

```ts
// src/lib/beta-categories.ts — server-owned allowlist (spec §5.6.1) — KHÔNG phải env, KHÔNG client flag.
// PLAIN MODULE (không "server-only") — seed script tsx import được (Batch 2 admin-mfa-key.ts precedent)
export const BETA_PUBLICATION_CATEGORIES = ["portable_bluetooth_speaker"] as const;
// khóa theo Category.slug — giá trị nguyên văn spec §5.6.1; danh mục seed ở Task 7 dùng đúng slug này

export type ListingRegime = "beta" | "legacy";
export function listingRegimeForCategorySlug(slug: string): ListingRegime;
//   slug ∈ BETA_PUBLICATION_CATEGORIES → "beta"; mọi slug khác → "legacy"

export type CategoryPublicationInput = { targetSlug: string; currentSlug?: string };
export function assertCategoryPublicationAllowed(input: CategoryPublicationInput): void;
//   target ∉ allowlist && target !== current → throw Error("CATEGORY_NOT_PUBLICATION_ALLOWED")
//   (tạo mới không có current → phải ∈ allowlist; đổi category chỉ được đổi INTO allowlist;
//    giữ nguyên category legacy = grandfathered — xem Legacy Migration Decisions)
```

```ts
// src/lib/listing-schema.ts — zod + constants. PLAIN MODULE (B2: "use server" chỉ export async —
// export const ở đây là hợp lệ vì file này KHÔNG phải server action).
export const LISTING_FULFILLMENT_METHODS = ["meetup", "seller_delivery", "carrier", "other"] as const;
//   mapping từ §5.2 (Deal fulfillment methods) — recorded decision A7
export const PHOTO_CHECKLIST_SLOTS = [
  "front", "back", "control_panel", "ports", "damage",
  "accessories", "box", "label_serial",
] as const; // §5.6.3 verbatim — 8 slot, KHÔNG thêm/bớt (spec §4.11)

export const LISTING_MUTATION_RATE = { limit: 20, windowMs: 60 * 60_000 }; // 20/h/user — create/draft/submit (§7.1)
export const LISTING_EDIT_RATE     = { limit: 60, windowMs: 60 * 60_000 }; // 60/h/user — bucket CHUNG
//   `listing:mutation:<userId>` cho update/toggle/delete (§7.1 "listing mutation")

export const FREE_TEXT_MAX = 2_000;        // includedAccessories/knownDefects/repairHistory
export const DESCRIPTION_MAX = 4_000;      // description — bound chống unbounded rows (validation addition)

// Location — consume registry thật src/lib/provinces.ts (FD-1), KHÔNG định nghĩa lại:
//   danh sách mã  = PROVINCES.map((p) => p.code)          (34 mã slug)
//   display name = PROVINCE_CODES[code]                  ("ha-noi"→"Hà Nội", "ho-chi-minh"→"TP. Hồ Chí Minh",
//                                                          "hue"→"Huế")
//   legacy map   = resolveLegacyProvince(raw)            ("Bình Dương"→"ho-chi-minh"; "Thừa Thiên Huế"→null —
//                                                          KHÔNG trong bảng; provinces.test.ts pin)
// city của listing beta = PROVINCE_CODES[provinceLevelCode] (item 12: /listings filter exact-match CITIES —
// Task 5 refresh CITIES thành 34 displayName chuẩn).

export type ListingSubmissionInput = {
  title: string; description: string;
  categoryId: string; brandId?: string | null; productModelId?: string | null;
  condition: string; price: number; negotiable: boolean;
  inventoryContext?: string | null;
  includedAccessories?: string | null; knownDefects?: string | null; repairHistory?: string | null;
  fulfillmentMethods?: string[] | null;
  provinceLevelCode?: string | null; locationDisplayName?: string | null;
  imageUrls: string[]; imageSlots?: (string | null)[];
};

export const betaListingSubmissionSchema: z.ZodType<ListingSubmissionInput>;   // regime "beta" — requiredness đầy đủ
export const legacyListingEditSchema: z.ZodType<ListingSubmissionInput>;       // regime "legacy" — chỉ validation hiện có
export const draftListingSchema: z.ZodType<ListingSubmissionInput>;
//   draft — base requiredness (các cột NON-NULL hiện có của Listing: title 8–120, description ≥20
//   (≤4.000), price bounds, condition, category ∈ allowlist, city) + structured fields TUYỆN CHỌN
//   + images 0..8 (≥1 ảnh là rule của SUBMIT, không phải của draft — ListingImage là bảng riêng,
//   draft 0 ảnh hợp lệ ở DB). Draft không thể "partial" trên các cột non-null — giới hạn schema
//   hiện có, giữ nguyên (additive-only). **LƯU Ý (item 12): `city` là cột non-null và được derive
//   từ province → draft HIỆU DỤNG yêu cầu chọn tỉnh** — province thiếu → PROVINCE_REQUIRED
//   (city không có fallback độc lập nào theo contract hiện tại).
export function validateListingSubmission(input: ListingSubmissionInput, regime: ListingRegime): void;
//   throw Error("LISTING_VALIDATION_FAILED:<code>") — code ổn định cho test: MODEL_REQUIRED,
//   BRAND_REQUIRED, INVENTORY_CONTEXT_REQUIRED, CONDITION_REQUIRED, PRICE_INVALID,
//   FULFILLMENT_REQUIRED, PROVINCE_REQUIRED, LOCATION_DISPLAY_REQUIRED, IMAGE_REQUIRED,
//   IMAGE_SLOT_INVALID, IMAGE_DUPLICATE, IMAGE_SLOT_MISMATCH, TITLE_INVALID, DESCRIPTION_INVALID, …
//   beta schema: brand + productModel bắt buộc (§6.3 Step 1), inventoryContext (§5.6),
//   condition, fulfillment ≥1 (§6.3 Step 4), provinceLevelCode ∈ PROVINCES codes (isProvinceCode) +
//   locationDisplayName (§5.9), ≥1 ảnh (rule hiện có), free-text ≤ FREE_TEXT_MAX/DESCRIPTION_MAX.
//   legacy schema: đúng các rule đang chạy trong createListingAction/updateListingAction hôm nay — không thêm.
```

```ts
// src/lib/listing-images.ts — ownership authorization (spec §5.6.4) — THỨ TỰ mỗi URL:
export const LISTING_IMAGE_URL_PATTERN = /^\/uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|gif)$/;
export const ATTACHED_IMAGE_PATH_PATTERN = /^\/(img|uploads)\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
export async function assertListingImagesOwned(input: {
  sellerId: string; listingId?: string; imageUrls: string[];
}): Promise<void>;
//   với mỗi url, THEO THỨ TỰ (B1):
//   (1) url khớp LISTING_IMAGE_URL_PATTERN → tra ListingImageUpload theo storageKey =
//       basename(url); row tồn tại → ownerUserId PHẢI = sellerId (sai → Error("IMAGE_NOT_OWNED")
//       — row của user khác chặn KỂ CẢ khi url đã gắn vào listing này);
//       url PHẢI BẰNG `/uploads/${storageKey}` CHÍNH XÁC — tra theo basename MÀ KHÔN khớp
//       pattern (vd https://evil/x/<uuid-của-chính-seller>.webp) KHÔNG bao giờ đi vào rule (1)
//       → rule (3) IMAGE_URL_INVALID (chống bypass basename)
//   (2) không khớp pattern NHƯNG đã gắn vào listing này (ListingImage row listingId+url tồn tại) →
//       CHỈ chấp nhận khi url khớp ATTACHED_IMAGE_PATH_PATTERN và KHÔNG chứa ".."
//       (ảnh seed /img/… và ảnh /uploads/ pre-Batch-4 ĐÃ GẮN được giữ nguyên) —
//       sai → Error("IMAGE_URL_INVALID")
//   (3) còn lại → Error("IMAGE_URL_INVALID") — kể cả URL có scheme (http/https/javascript)
//       đã gắn vào listing (không bao giờ tin URL ngoài, kể cả tại approve)
//   thêm: url trùng lặp trong input → Error("IMAGE_DUPLICATE");
//   imageSlots.length ≠ imageUrls.length (khi có slots) → Error("IMAGE_SLOT_MISMATCH")
//   mọi url resolve xong mới trả về — fail trước khi ListingImage write nào chạy
```

```ts
// src/lib/listing-publication.ts — HAI hàm xuất, mọi transition dùng chung (extend Batch 2 gate)
export type ListingPublicationInput = ListingSubmissionInput & {
  sellerId: string; listingId?: string; currentCategorySlug?: string;
};
export type ListingPublicationCheck = {
  ok: boolean;
  sellerMissing: SellerPublicationRequirement[]; // từ Batch 2 checkSellerPublicationRequirements
  listingIssues: string[];                        // LISTING_VALIDATION_FAILED / CATEGORY_* / MODEL_* / IMAGE_* codes
};

export async function assertCanonicalModelValid(input: {
  productModelId?: string | null; brandId?: string | null;
  categoryId: string; regime: ListingRegime;
}): Promise<void>;
//   (B4 — DB check, không chỉ zod presence) productModelId cung cấp → ProductModel row PHẢI tồn tại
//   + status "approved" (pending/merged → Error("MODEL_INVALID")); brandId cung cấp →
//   model.brandId PHẢI = brandId (sai → Error("MODEL_BRAND_MISMATCH")); regime "beta" →
//   model.categoryId PHẢI = categoryId (category beta — sai → Error("MODEL_INVALID")).
//   regime "legacy": model check chỉ khi seller cung cấp productModelId (tùy chọn như hôm nay).

export async function assertListingContentValid(input: ListingPublicationInput): Promise<void>;
//   = assertCategoryPublicationAllowed({ targetSlug, currentSlug })
//   + validateListingSubmission(input, regime theo targetSlug)
//   + assertCanonicalModelValid({ productModelId, brandId, categoryId, regime })
//   + assertListingImagesOwned({ sellerId, listingId, imageUrls })
//   throw với code đầu tiên sai — thứ tự cố định: category → schema → model → images

export async function checkListingPublication(input: ListingPublicationInput): Promise<ListingPublicationCheck>;
//   không throw — dùng BỞI approveListingAction (duy nhất) để build danh sách thiếu cho audit
//   (reason publication_requirements_unmet + missing=… khi seller thiếu; listing_content_invalid +
//   issues=… khi content sai) — submitListingAction dùng assertListingPublishable (throw) + code bắt
//   được cho redirect, KHÔNG dùng check này (một cơ chế, một consumer — tránh mơ hồ L398/L645)

export async function assertListingPublishable(input: ListingPublicationInput): Promise<void>;
//   = assertSellerPublicationAllowed(sellerId)      [Batch 2 — KHÔNG đụng internals; Batch 3 đã thêm
//                                                     requirement account_not_suspended vào
//                                                     seller-verification-policy.ts (R6) — wrapper tự kế thừa]
//   + assertListingContentValid(input)
//   throw với code đầu tiên sai — thứ tự cố định: seller → category → schema → model → images
```

- [ ] **Step 1: Write the failing unit tests**

`tests/unit/beta-categories.test.ts` (pure — no db):

- `BETA_PUBLICATION_CATEGORIES is exactly ["portable_bluetooth_speaker"]` (spec §5.6.1 verbatim — a change to this list is a product decision, the test pins it).
- `assertCategoryPublicationAllowed: new listing in a legacy slug → CATEGORY_NOT_PUBLICATION_ALLOWED`; `new listing in the beta slug → passes`; `category change legacy → legacy slug → throws`; `category change legacy → beta slug → passes (into allowlist)`; `unchanged legacy category → passes (grandfathered)`; `unchanged beta category → passes`.
- `listingRegimeForCategorySlug: beta slug → "beta"; every other slug → "legacy"`.
- **No duplicate province-registry tests here** — `tests/unit/provinces.test.ts` (Batch 2) already pins the 34 codes, the `PROVINCE_CODES` mapping, `isProvinceCode`, and `resolveLegacyProvince` (incl. `"Thừa Thiên Huế" → null`); this suite only asserts what Batch 4 itself defines.

`tests/unit/listing-schema.test.ts` (pure; `provinces.ts` is a plain module — no db in the import chain, mock `server-only` only if another import needs it):

- `beta submission requires brand + canonical model` — omit each → `BRAND_REQUIRED` / `MODEL_REQUIRED` (spec §6.3 Step 1) (**conditional-fields gate**: the same input passes under `legacyListingEditSchema`).
- `beta submission requires inventoryContext, condition, ≥1 fulfillment method, province code ∈ PROVINCES codes (isProvinceCode), locationDisplayName, ≥1 image` — omit each → the matching code; `imageSlots` with a value outside `PHOTO_CHECKLIST_SLOTS` → `IMAGE_SLOT_INVALID`; duplicate fulfillment methods rejected; duplicate image URLs → `IMAGE_DUPLICATE`; `imageSlots`/`images` length mismatch → `IMAGE_SLOT_MISMATCH`; free-text fields over `FREE_TEXT_MAX`/description over `DESCRIPTION_MAX` → typed error.
- `legacy edit schema accepts a legacy-shaped input` (no model, no structured fields) and `still enforces the existing rules` (title 8–120, description ≥20, price bounds, ≥1 image).
- `draft schema: base fields required (non-null columns), structured fields optional, images 0..8, province required (city derives from it)` — a draft with no model/no photos passes; a draft with a bad title/price fails; a draft without a province → `PROVINCE_REQUIRED` (item 12 — stated, not hidden); `imageSlots` outside `PHOTO_CHECKLIST_SLOTS` → `IMAGE_SLOT_INVALID`.
- `PHOTO_CHECKLIST_SLOTS has exactly the 8 §5.6.3 slots` (literal array assertion — non-invention pin).

`tests/unit/listing-images.test.ts` (mock db with in-memory `ListingImageUpload`/`ListingImage` maps):

- `an /uploads/<uuid>.webp owned by the seller passes (rule 1)`.
- `an /uploads/<uuid>.webp owned by ANOTHER user → IMAGE_NOT_OWNED — even when the url is already attached to this listing` (**cross-account image theft**).
- `a scheme URL whose basename IS the seller's own upload (https://evil/x/<own-uuid>.webp) → IMAGE_URL_INVALID` (**rule-1 basename bypass — Review Focus 4**).
- `an attached pre-Batch-4 /uploads/<uuid>.jpg with no upload row passes on edit (rule 2)` (**B1 compat pin**).
- `a seed /img/listings/x.svg already attached to the listing passes (rule 2)`; `the same URL on a DIFFERENT listing → IMAGE_URL_INVALID`.
- `an attached https://x URL → IMAGE_URL_INVALID (rule 3 — scheme URLs never trusted, even attached)` (**B1**).
- `https://…, javascript:…, /../../etc/passwd, "" → IMAGE_URL_INVALID` (traversal/foreign URLs).
- `duplicate urls → IMAGE_DUPLICATE`; `imageSlots/images length mismatch → IMAGE_SLOT_MISMATCH`.
- `no db write happens before all urls resolve` (spy).

`tests/unit/listing-publication.test.ts` (mock db + vi.mock Batch 2's `seller-verification-policy`):

- `assertListingPublishable calls assertSellerPublicationAllowed with sellerId, then assertListingContentValid` (extend-not-duplicate pin — composition order pinned via a `vi.mock(() => ({ …vi.importOriginal() }))` counting wrapper on `@/src/lib/seller-verification-policy` + `@/src/lib/listing-images`, cross-module so the spy works).
- `seller gate failure surfaces SELLER_PUBLICATION_BLOCKED before category/schema/model/image checks` (order pin).
- `category not allowed → CATEGORY_NOT_PUBLICATION_ALLOWED even when the seller is fully verified`.
- `beta regime input with a schema violation → LISTING_VALIDATION_FAILED:<code>`; `legacy regime same input → passes`.
- `assertCanonicalModelValid: model missing → MODEL_INVALID; status pending → MODEL_INVALID; status merged → MODEL_INVALID; model in another category (beta regime) → MODEL_INVALID; model.brandId ≠ brandId → MODEL_BRAND_MISMATCH` (**B4**).
- `checkListingPublication returns { ok: false, sellerMissing, listingIssues } without throwing` (approve's audit variant).

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/unit/beta-categories.test.ts tests/unit/listing-schema.test.ts tests/unit/listing-images.test.ts tests/unit/listing-publication.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement the four modules**

- `beta-categories.ts`: **plain module (no `server-only`)** — the constant + the two pure functions exactly per the interface block. No env, no db.
- `listing-schema.ts`: plain module; zod schemas + `LISTING_MUTATION_RATE`/`LISTING_EDIT_RATE`/text caps per the interface; the province registry consumed from `src/lib/provinces.ts` (FD-1 single source — `isProvinceCode`/`PROVINCE_CODES`/`PROVINCES.map((p) => p.code)` re-used, never re-defined); price bounds copied from the current action validation (100_000–2_000_000_000) — **not** tightened (no invented pricing policy); `locationDisplayName` capped (≤120 chars) with no address detection (guidance lives in the UI copy — you cannot reliably validate "not a street address").
- `listing-images.ts`: db-backed per-URL check in the (1)/(2)/(3) order — rule (1) gated on `LISTING_IMAGE_URL_PATTERN` **and** exact `/uploads/${storageKey}` equality — + duplicate/length checks; resolve **all** urls before returning.
- `listing-publication.ts`: `assertCanonicalModelValid` + `assertListingContentValid` + `checkListingPublication` + `assertListingPublishable` per the interface; re-export nothing from Batch 2 except types.

- [ ] **Step 4: Run tests until green**

Run: `npm test -- tests/unit/beta-categories.test.ts tests/unit/listing-schema.test.ts tests/unit/listing-images.test.ts tests/unit/listing-publication.test.ts` → PASS. Then `npm test` → all existing suites green (no action touched yet).

- [ ] **Step 5: Commit**

```bash
git add src/lib/beta-categories.ts src/lib/listing-schema.ts src/lib/listing-images.ts src/lib/listing-publication.ts tests/unit/beta-categories.test.ts tests/unit/listing-schema.test.ts tests/unit/listing-images.test.ts tests/unit/listing-publication.test.ts
git commit -m "feat(listing): beta category gate and submission schema"
```

## Task 3: Upload hardening — re-encode, EXIF/GPS strip, ownership rows, serving headers

**Files:**

- Modify: `package.json` + `package-lock.json` (exact-pin `sharp@0.35.5`)
- Modify: `src/lib/image-validate.ts` (caps from `image-process.ts` — current caps are 40MP/10k px)
- Create: `src/lib/image-process.ts`
- Modify: `app/api/upload/route.ts`
- Modify: `next.config.ts` (`/uploads` serving headers)
- Test: `tests/unit/image-process.test.ts`
- Test: `tests/unit/upload-route.test.ts`
- Test: `tests/unit/image-validate.test.ts` (extend — new caps)

**Interfaces:**

- Consumes: `validateImage` (existing), `ListingImageUpload` model (Task 1), `checkRateLimit`/`rateLimitRequest` (`src/lib/rate-limit.ts`), `getCurrentUser` (Batch 2 session-backed), `captureError` (`src/lib/observability.ts`).
- Produces (used by Task 4's image handling and any future upload consumer):

```ts
// src/lib/image-process.ts
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;          // 5MB encoded — giữ nguyên limit hiện tại
export const IMAGE_MAX_DIM = 12_000;                    // px/cạnh — siết từ 10.000 (hiện tại): đủ cho 50MP 4:3
                                                        // (8165×6124) và 16:9 (9430×5303)
export const IMAGE_MAX_PIXELS = 50_000_000;              // 50MP — siết-tăng từ 40MP (hiện tại): admitting cảm biến
                                                        // 48MP của điện thoại (phổ biến nhất) trong khi bound
                                                        // worst-case decode ≈ 200MB RGBA transient (bounded thêm
                                                        // bởi rate limit + single-instance topology); mode
                                                        // 108/200MP bị từ chối — người dùng downscale (hiếm cho
                                                        // ảnh sản phẩm). Cap cũ 40MP chặn cả 48MP.
export const IMAGE_OUTPUT_MAX_BYTES = 5 * 1024 * 1024;   // cap kích thước SAU re-encode
export const IMAGE_RESIZE_MAX = { width: 2560, height: 2560 }; // resize TRƯỚC encode — output bounded,
                                                               // OUTPUT_TOO_LARGE chỉ cho input bệnh thái

export type ReencodeResult =
  | { ok: true; buffer: Buffer; width: number; height: number }
  | { ok: false; reason: "DECODE_FAILED" | "REENCODE_FAILED" | "OUTPUT_TOO_LARGE" };

export async function reencodeImage(buf: Buffer): Promise<ReencodeResult>;
//   sharp(buf, { limitInputPixels: IMAGE_MAX_PIXELS, pages: 1, failOn: "error" })
//     .rotate()                                  // auto-orient theo EXIF TRƯỚC khi strip — không thì ảnh xoay ngang
//     .resize({ ...IMAGE_RESIZE_MAX, fit: "inside", withoutEnlargement: true })
//     .webp({ quality: 82 })                     // re-encode = decode→pixels→encode: strip TOÀN BỘ metadata
//                                                //   (EXIF/GPS) trừ khi withMetadata() được gọi — không gọi; vô hiệu
//                                                //   hóa polyglot payload; pages:1 = GIF animated → frame đầu (static)
//   output > IMAGE_OUTPUT_MAX_BYTES → OUTPUT_TOO_LARGE (fail closed — hiếm khi xảy ra nhờ resize)
```

```ts
// app/api/upload/route.ts — POST (giữ nguyên chữ ký response)
// 0. Content-Length > IMAGE_MAX_BYTES + 512KB (~5.5MB) → 413 TRƯỚC request.formData() (early body reject)
// 1. rateLimitRequest(request, "upload", { limit: 20, windowMs: 10 * 60_000 })   — IP (hiện có)
// 2. getCurrentUser() → 401 khi chưa đăng nhập (hiện có)
// 3. checkRateLimit(`upload:user:${user.id}`, { limit: 20, windowMs: 10 * 60_000 }) → 429
//    (per-USER ≤ per-IP — một user không vượt được bucket IP của chính mình; §7.1)
// 4. file.size > IMAGE_MAX_BYTES → 400 (trước khi buffer)
// 5. validateImage(buf, file.type, IMAGE_MAX_BYTES) — magic bytes + sharp decode + caps (hiện có, caps mới)
// 6. reencodeImage(buf) → fail → 400 typed (KHÔNG lưu file)
// 7. storageKey = `${randomUUID()}.webp`  (TẠO TRƯỚC — dùng cho cả row lẫn file)
//    ListingImageUpload.create({ ownerUserId: user.id, storageKey, bytes: out.buffer.length, width, height })
//    TRƯỚC writeFile — ROW FIRST (orphan row vô hại vì storageKey unique; orphan FILE mới là vấn đề —
//    publicly reachable không owner). writeFile throw → delete row (best-effort) + 500.
// 8. writeFile(dir/storageKey, out.buffer)  // buffer ĐÃ re-encode, KHÔNG BAO GIỜ buffer gốc
//    (Review Focus 1); mkdir recursive như hiện tại
// 9. Response.json({ url: `/uploads/${storageKey}` })
```

```ts
// next.config.ts — thêm (Task 3 sở hữu):
// async headers() { return [{ source: "/uploads/:path*", headers: [
//   { key: "X-Content-Type-Options", value: "nosniff" },
//   { key: "Content-Security-Policy", value: "default-src 'none'; sandbox" },
// ] }]; }
// Ghi nhận trong verification doc: production nginx (docs/deployment.md) PROXY `location /` về app
// (proxy_pass http://127.0.0.1:3000) — /uploads được Next serve nên header next.config.ts có hiệu lực.
// Nếu deploy sau này serve /uploads trực tiếp từ nginx, CÙNG hai header phải vào location block đó
// (deploy checklist item, không phải code change của batch này).
```

- [ ] **Step 1: Pin the dependency**

```bash
npm install --save-exact sharp@0.35.5
```

Verify `package.json` shows `"sharp": "0.35.5"` (no `^`); `package-lock.json` unchanged in resolution (already 0.35.5) but records the exact spec. Run `npm audit --omit=dev` — must be clean (record in the Task 9 verification doc). No other dependency changes.

- [ ] **Step 2: Write the failing unit tests**

`tests/unit/image-process.test.ts` (real sharp — no db):

- `re-encode strips GPS/EXIF from a JPEG carrying a GPS IFD` — build input via `sharp(create…).withMetadata({ exif: { GPS: { GPSLatitudeRef: "N", GPSLatitude: "21/1,1/1,1/1" } } }).jpeg()`; `reencodeImage` → output `sharp(out.buffer).metadata()` has **no** `exif` (and format `webp`) (**Review Focus 1** — the §4.7/§4.8 privacy pin).
- `output contains no EXIF marker at all` — assert the output buffer has no `Exif` APP segment (scan for the marker bytes) for a JPEG input with rich EXIF.
- `auto-orient applies before strip` — a JPEG with `Orientation: 6` re-encodes to the rotated dimensions (width/height swapped).
- `a polyglot file (GIF header + appended HTML comment) re-encodes to clean pixels` — output contains none of the injected ASCII payload.
- `a 50MP input (8165×6124) decodes and re-encodes fine (cap admits 48MP phone sensors)`; `a 51MP input → DECODE_FAILED/TOO_MANY_PIXELS (cap enforced)` — justifies the chosen cap (the **current** cap is 40MP/10k px, so a 41MP image already fails today; Batch 4 moves the line to 50MP/12k px, not down).
- `resize bounds the output: a large input encodes to ≤2560px WebP well under IMAGE_OUTPUT_MAX_BYTES` (so `OUTPUT_TOO_LARGE` does not reject normal photos); `OUTPUT_TOO_LARGE` fires only for a stubbed pathological output.
- `decode failure (truncated PNG) → DECODE_FAILED` (fail closed, nothing written).
- `GIF input → static WebP first frame` (format webp, single page — `pages: 1`).

`tests/unit/upload-route.test.ts` (mock db + fs + session, following the route-handler style of `tests/unit/cron-auto-release-route.test.ts`):

- `unauthenticated POST → 401 before any file buffering` (existing behavior pinned).
- `Content-Length over ~5.5MB → 413 before request.formData()` (spy: formData not called).
- `the stored file is the re-encode output, not the upload` — spy on `writeFile`: the written buffer equals `reencodeImage`'s output and differs from the request bytes (Review Focus 1).
- `storageKey is generated before both the row and the file; the ListingImageUpload row is created BEFORE the file write; a writeFile failure deletes the row` (row-first ordering).
- `per-user limit: 21st upload within 10 min → 429` — **the test must set `TRUST_PROXY_HEADERS=true` and vary `x-real-ip` per request** (otherwise every request shares the `local` IP bucket and the per-IP limit fires first, masking the per-user bucket); reset via `resetRateLimits`.
- `re-encode failure → 400, no file written, no upload row`.
- `file.size over cap → 400 before buffering` (spy: `arrayBuffer` not called).
- `SVG declared image/svg+xml → rejected by validateImage (MIME_NOT_ALLOWED)` and `SVG bytes declared image/png → MAGIC_MISMATCH` (existing cases, re-pinned at the route).

`tests/unit/image-validate.test.ts` (extend the existing suite):

- `51MP image → TOO_MANY_PIXELS under the 50MP cap`; `50MP (8165×6124) passes` (the current 40MP cap already rejects 41MP — the case set moves with the cap, it does not invent a "25MP fails" case that never existed).
- `12,001px edge → TOO_LARGE_DIMENSIONS under the 12k cap` (current cap 10k px).
- All existing accept-path cases stay green unchanged.

- [ ] **Step 3: Run to verify failure**

Run: `npm test -- tests/unit/image-process.test.ts tests/unit/upload-route.test.ts tests/unit/image-validate.test.ts`
Expected: FAIL — `src/lib/image-process.ts` missing; route still writes the original buffer; caps unchanged (40MP/10k).

- [ ] **Step 4: Implement**

- `src/lib/image-process.ts` per the interface block — thin sharp pipeline (`limitInputPixels`/`pages: 1`/`failOn: "error"` options verbatim), no bespoke parsing, typed reasons, `import "server-only"`.
- `src/lib/image-validate.ts`: import `IMAGE_MAX_DIM`/`IMAGE_MAX_PIXELS` from `image-process.ts` (single source) replacing the local `MAX_DIM`/`MAX_PIXELS` (40MP/10k today); everything else untouched.
- `app/api/upload/route.ts` per the interface block — the ordered pipeline (early `Content-Length` reject; **storageKey generated before the row and the file**; row-before-file); `captureError("upload", …)` scope strings unchanged (no image content in meta — spec §4.8); the response shape `{ url }` unchanged so `ImagePicker` keeps working.
- `next.config.ts`: add the `headers()` entry for `/uploads/:path*` exactly per the interface block.

- [ ] **Step 5: Run tests until green**

Run: `npm test -- tests/unit/image-process.test.ts tests/unit/upload-route.test.ts tests/unit/image-validate.test.ts` → PASS. Then `npm test` → full unit suite green.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/lib/image-process.ts src/lib/image-validate.ts app/api/upload/route.ts next.config.ts tests/unit/image-process.test.ts tests/unit/upload-route.test.ts tests/unit/image-validate.test.ts
git commit -m "feat(upload): re-encode uploads, strip EXIF/GPS, record ownership"
```

## Task 4: Listing actions — draft/submit + gate rewiring + image ownership + audit

**Files:**

- Modify: `src/lib/actions/listings.ts` (create/update/toggle rewired; add draft + submit; keep Batch 3's R5 guards + conditional writes)
- Modify: `src/lib/actions/admin.ts` (approveListingAction: `checkListingPublication` once; delete the direct Batch 2 `checkSellerPublicationRequirements` call)
- Modify: `src/lib/audit-event.ts` (registry comment: append `listing.draft_created`, `listing.draft_updated`, `listing.submitted`, `listing.submit_blocked`, `beta_catalog.seeded`)
- Test: `tests/unit/listing-draft-actions.test.ts`
- Test: `tests/unit/publication-gate.test.ts` (extend — fixtures + new cases; Batch 3's cases kept per R5/R6)
- Test: `tests/unit/listing-actions-images.test.ts`

**Interfaces:**

- Consumes: `assertListingPublishable`/`assertListingContentValid`/`checkListingPublication`/`assertCategoryPublicationAllowed`/`validateListingSubmission`/`assertListingImagesOwned`/`assertCanonicalModelValid` (Task 2), `LISTING_MUTATION_RATE`/`LISTING_EDIT_RATE` (`src/lib/listing-schema.ts`), `PROVINCE_CODES` (`src/lib/provinces.ts` — FD-1), `Listing`/`ListingImage`/`PriceHistory` models, `requireUser` (Batch 2), `requireCapability("listing.moderate")` (Batch 2 rbac), `auditEvent`/`redactDetail`/`SELLER_RULES_POLICY_VERSION` (Batch 2), **Batch 3's `isModerationLocked` (`@/src/lib/moderation`)**, `checkRateLimit` (`src/lib/rate-limit.ts`), `slugify` (`src/lib/utils.ts`), `formatMissingRequirements` (Batch 2 — the existing `runPublicationGate` Vietnamese text stays).
- Produces:

```ts
// src/lib/actions/listings.ts (thêm — chữ ký create/update/toggle/delete giữ nguyên)
export type ListingFormState = { error?: string };  // giữ nguyên

// runPublicationGate + formatMissingRequirements (Batch 2) GIỮ NGUYÊN — text tiếng Việt liệt kê
// yêu cầu thiếu cho SELLER_PUBLICATION_BLOCKED là thứ tests hiện tại pin; wrapper mới bắt lỗi
// typed và Đưa qua cùng helper này (item 17).

export async function saveListingDraftAction(
  _prev: ListingFormState, formData: FormData,
): Promise<ListingFormState>;
//   requireUser → checkRateLimit(`listing:draft:${user.id}`, LISTING_MUTATION_RATE) → zod draftListingSchema
//   → category: tạo mới phải ∈ allowlist; update draft chỉ được đổi category INTO allowlist
//   → update path: listing.sellerId !== user.id → silent return (IDOR);
//     R5 guard: isModerationLocked(listing.status) → throw Error("LISTING_MODERATION_LOCKED")
//     (từ @/src/lib/moderation — KHÔNG hardcoded "removed", KHÔNG raw .includes);
//     listing.status !== "draft" → silent return (chỉ draft được sửa như draft)
//   → assertListingImagesOwned (quy tắc 1/2/3 — draft cũng không nhận URL lạ; 0 ảnh OK)
//   → db.transaction: Listing.create({ status: "draft", … }) / Listing.update
//     (update CONDITIONAL `.where({ id, status: "draft" })` → 0 row → throw ra khỏi callback,
//     classify NGOÀI tx — Global Constraints) + các cột structured + checklistSlot;
//     city = PROVINCE_CODES[provinceLevelCode] (cột non-null)
//   → auditEvent("listing.draft_created" | "listing.draft_updated")
//   KHÔNG gọi seller gate — spec §4.4/§5.6.2: draft được phép trước verification

export async function submitListingAction(formData: FormData): Promise<void>;
//   requireUser → checkRateLimit(`listing:submit:${user.id}`, LISTING_MUTATION_RATE) → 429-style
//   → listing = Listing.first({ id }) → sellerId !== user.id → silent return (IDOR)
//   → R5 guard: isModerationLocked(listing.status) → throw Error("LISTING_MODERATION_LOCKED")
//   → status !== "draft" → silent return (không double-submit)
//   → INPUT ĐƯỢC XÂY TỪ DB ROW (trust boundary): title/description/price/condition/… đọc từ listing row,
//     imageUrls từ ListingImage rows theo sortOrder, currentCategorySlug từ Category row của
//     listing.categoryId — formData CHỈ mang listingId (không tin formData cho bất kỳ trường gate)
//   → let blocked: string | null = null;
//     try { assertListingPublishable(input) } catch (e) { blocked = codeOf(e);
//       auditEvent("listing.submit_blocked", reason = blocked); }   // KHÔNG redirect trong catch
//     blocked mang seller-gate code → return redirect("/sell/verification")
//     blocked mang content code     → return redirect(`/sell/${listing.id}/edit?error=${blocked}`)
//     (rate-limit block → return redirect(`/sell/${listing.id}/edit?error=RATE_LIMITED`))
//   → db.transaction { Listing.updateAll({ status: "pending" }).where({ id, status: "draft" })
//     — CONDITIONAL claim; 0 row → THROW ra khỏi callback, classify NGOÀI tx (status đổi tay) }
//     + auditEvent("listing.submitted", policyVersion: SELLER_RULES_POLICY_VERSION) + revalidatePath

// createListingAction (rewire — vẫn là path "submit ngay"):
//   requireUser → rate limit (listing:create:<userId>, LISTING_MUTATION_RATE) → gom input → resolve category
//   → assertListingPublishable(...) MỘT LẦN (per-path pin) → db.transaction {
//       Listing.create({ status: "pending", …structured, city: PROVINCE_CODES[provinceLevelCode] })
//       + ListingImage (checklistSlot từ imageSlots zipped theo index) + PriceHistory (giữ nguyên hành vi)
//     } — MỘT tx cho cả ba (item 8); Listing.slug unique violation (23505) → THROW ra khỏi callback,
//     classify NGOÀI tx → typed slug-collision error (KHÔNG catch-and-return — silent-success bug)
//   → redirect /sell/my?created=1 (giữ nguyên)
// updateListingAction (rewire):
//   ownership check (hiện có) → R5 guard giữ nguyên (Batch 3: isModerationLocked → LISTING_MODERATION_LOCKED)
//   → resolve target category từ DB → contentChanged MỞ RỘNG (B3): title, description, price,
//     categoryId, condition, negotiable, brandId, productModelId, inventoryContext,
//     includedAccessories, knownDefects, repairHistory, fulfillmentMethods (so sánh JSON stringify),
//     provinceLevelCode, communeLevelCode, locationDisplayName, image set (urls) và slot set
//   → transition: contentChanged && ["approved","rejected","hidden"].includes(status) → "pending"
//     (hidden cũng phải qua lại review — spec §5.6.2)
//   → INTERIM (A10): legacy regime + status "rejected" → KHÔNG chuyển pending — giữ "rejected" +
//     form message hướng dẫn tạo tin mới trong category beta
//   → vào pending → assertListingPublishable MỘT LẦN; KHÔNG vào pending (draft giữ nguyên draft,
//     approved/hidden không đổi nội dung chính…) → assertListingContentValid (item 1: non-transition
//     update vẫn validate content)
//   → db.transaction { image diff (giữ nguyên logic xóa/thêm/sortOrder + thêm checklistSlot)
//     + Listing.updateAll({ … }).where({ id, status: listing.status }) — CAS CONDITIONAL giữ nguyên
//     (Batch 3 đã có); 0 row → THROW ra khỏi callback, classify NGOÀI tx → typed conflict error
//     (giữ nguyên message "Tin vừa thay đổi trạng thái…" của Batch 3) } — MỘT tx (item 8: không
//     còn partial write ảnh khi CAS thua)
//   → PriceHistory reprice (giữ nguyên) → redirect (giữ nguyên)
//   Draft qua updateListingAction: contentChanged nhưng "draft" ∉ transition list → status GIỮ
//   "draft", chỉ assertListingContentValid — hành vi ghi rõ (edit page dùng save+submit riêng — Task 5)
// toggleListingVisibilityAction (rewire):
//   ownership + R5 guard (hiện có) → hidden→approved: assertListingPublishable với input TỪ DB ROW
//   (seller gate + regime schema + model + images) — blocked → silent return + audit "listing.submit_blocked"
//   → CAS .where({ id, status: "hidden" }).updateAll({ status: "approved" }) GIỮ NGUYÊN (Batch 3)
//   approved→hidden: CAS .where({ id, status: "approved" }) GIỮ NGUYÊN — không cần gate (ẩn luôn được)
// deleteListingAction: R5 guard + conditional delete (Batch 3) giữ nguyên; không đụng gì khác
// update/toggle/delete dùng bucket CHUNG checkRateLimit(`listing:mutation:${user.id}`, LISTING_EDIT_RATE)
```

```ts
// src/lib/actions/admin.ts — approveListingAction (sau requireCapability("listing.moderate") của Batch 2)
//   listing.status !== "pending" → return (hiện có)
//   → checkListingPublication({ sellerId: listing.sellerId, …input từ DB row }) MỘT LẦN —
//     defense-in-depth: seller gate (Batch 2, giờ qua checkListingPublication — XÓA call trực tiếp
//     checkSellerPublicationRequirements của Batch 2) + category allowlist + regime schema + model + images
//     → !ok → auditEvent("listing.approve_blocked") — HAI reason tách bạch (item 6):
//       sellerMissing.length > 0 → reason "publication_requirements_unmet",
//                                 detail `missing=${sellerMissing.join(",")}` (Batch 2 pin — giữ nguyên)
//       còn lại (content)   → reason "listing_content_invalid",
//                            detail `issues=${listingIssues.join(",")}` (mới — typed)
//       → return (KHÔNG approve); audit fail-open như Batch 2 (block vẫn chặn)
//   → CAS .where({ id, status: "pending" }).updateAll({ status: "approved", … }) GIỮ NGUYÊN (Batch 3)
//     + auditEvent("listing.approved") (Batch 2 đã wire — giữ nguyên)
// rejectListingAction: KHÔNG đổi (từ chối luôn được phép với listing.moderate; CAS pending-only giữ nguyên)
```

- [ ] **Step 1: Write the failing unit tests**

`tests/unit/listing-draft-actions.test.ts` (mock db + Batch 2/3 modules per the Global Constraints stubbing recipe — `vi.hoisted` state, throwing `redirect`; `next/navigation` mock asserts `NEXT_REDIRECT:<url>`):

- `saveListingDraftAction: unverified seller CAN create a draft` (spec §4.4 — no seller-gate call; counting wrapper on `@/src/lib/seller-verification-policy` shows zero `assertSellerPublicationAllowed` calls) — **draft-behavior gate**.
- `draft is not publicly visible`: source-contract assertion — the draft row has `status: "draft"`; the public listing query (`app/listings/page.tsx` module) filters `status: "approved"`; the detail-page gate (`app/listings/[slug]/page.tsx`) renders only `approved` unless owner/admin; home/seller/model/compare/related queries filter `approved`; sitemap (nếu có) excludes non-approved. **Recorded follow-up:** `startConversationAction`/`toggleWishlistAction` accept non-approved listings — noted in the verification doc as a Batch 6 follow-up (chat/wishlist hardening), not fixed here.
- `saveListingDraftAction: new draft in a legacy category → CATEGORY_NOT_PUBLICATION_ALLOWED, no row` (**invalid-category rejection**).
- `saveListingDraftAction: draft image URLs follow rules (1)/(2)/(3)` — foreign URL → typed error, no row; `a scheme URL whose basename is the seller's own upload → IMAGE_URL_INVALID` (**rule-1 bypass**).
- `saveListingDraftAction / submitListingAction on a removed listing → LISTING_MODERATION_LOCKED (R5 — via isModerationLocked, no hardcoded "removed")`.
- `submitListingAction: draft of ANOTHER seller → silent return, status unchanged` (**Listing IDOR**).
- `submitListingAction: unverified seller → redirect to /sell/verification (mock throws NEXT_REDIRECT:/sell/verification), status stays "draft", audit "listing.submit_blocked"` — **publication-gate gate**; `redirect() is called OUTSIDE the catch` (assert the catch block only captures + audits).
- `submitListingAction: content failure (e.g. MODEL_INVALID) → redirect /sell/<id>/edit?error=MODEL_INVALID`; `rate-limit block → redirect /sell/<id>/edit?error=RATE_LIMITED`.
- `submitListingAction: verified seller + complete beta input → status "pending" (conditional claim on "draft") + audit "listing.submitted" with policyVersion`.
- `submitListingAction: non-draft status (pending/approved) → silent return` (no double-submit); `a racing status change → the conditional claim hits 0 rows → typed conflict error, no partial write`.
- `submitListingAction builds its input from the DB row, not formData` (formData with a forged title/category is ignored — the DB row's values are validated).
- `rate limit: 21st create/draft/submit within the hour → typed form error / RATE_LIMITED redirect, no row`.
- `updateListingAction on a draft: content changes but status stays "draft" (no transition), assertListingContentValid runs, no seller gate` (specified draft behavior).

`tests/unit/publication-gate.test.ts` (extend the suite — keep every existing Batch 2 **and Batch 3** case, migrate fixtures):

- Fixture migration: the mock category fixture used by the happy-path cases gets slug `portable_bluetooth_speaker` (beta regime) so the allowlist passes; Batch 3's suspension cases (R6) migrate to the same beta fixtures and stay. Assert every existing case still passes unchanged in meaning: `createListingAction: unverified seller → typed error, no Listing.create`; `updateListingAction: content-change → pending blocked for a revoked seller`; `toggleListingVisibilityAction: hidden → approved blocked for a suspended-membership seller`; `approveListingAction: approving a listing whose seller lost verification → no approval + audit "listing.approve_blocked" with reason "publication_requirements_unmet" + detail missing=…`; `all four pass when the seller satisfies the policy`.
- New cases (**B3**): `updateListingAction: changing knownDefects (and each other structured field, brandId, productModelId, image set, slot set) on an approved listing → pending`; `content change from hidden → pending`; `legacy rejected listing stays rejected (A10 interim)`.
- New cases (**B1/B4**): `approveListingAction of a listing with an attached https:// image URL → blocked + audit reason "listing_content_invalid"` (defense-in-depth through the wrapper); `approveListingAction of a beta listing against a merged/pending/other-category model → MODEL_INVALID`; other-brand → `MODEL_BRAND_MISMATCH`.
- New cases (**item 1 pins — cross-module counting wrappers, not same-module spies**): `vi.mock("@/src/lib/listing-publication", () => ({ …vi.importOriginal() }))` counting wrappers show `create/submit/update-into-pending/toggle each call assertListingPublishable exactly once`; `non-transition update calls assertListingContentValid (no seller gate)`; `approveListingAction calls checkListingPublication exactly once`. **The "admin.ts makes no direct `checkSellerPublicationRequirements` call" claim is NOT asserted by spy** (same-registry call — indistinguishable through the module mock); it is proven by the Task 9 **source scan**.
- New cases (**R5**): `update/toggle/delete on a removed listing → LISTING_MODERATION_LOCKED/no-op` (Batch 3's guards still enforced after the rewire — source-contract: the guards call `isModerationLocked` from `@/src/lib/moderation`, no hardcoded `"removed"`, no raw `.includes`).
- New cases (**item 14 — account_not_suspended**): `an actively UserSuspension-suspended seller (Batch 3's 8th requirement) → create/submit/toggle blocked with SELLER_PUBLICATION_BLOCKED:account_not_suspended, and approveListingAction → no approval + audit "publication_requirements_unmet" with missing=account_not_suspended` (the wrapper inherits the requirement; distinct from founding_seller membership suspension).

`tests/unit/listing-actions-images.test.ts` (mock db):

- `createListingAction stores checklistSlot per image` (zip `images` × `imageSlots`, sortOrder preserved).
- `createListingAction rejects images not owned by the seller` (rule 1 negative) — no `Listing`/`ListingImage` write.
- `updateListingAction keeps already-attached seed images` (rule 2) and `rejects newly-added foreign URLs`; `an attached pre-Batch-4 /uploads/<uuid>.jpg passes on edit` (**B1**).
- `createListingAction sets city = PROVINCE_CODES[provinceLevelCode] (canonical 34-unit displayName — e.g. ho-chi-minh → "TP. Hồ Chí Minh") — NOT locationDisplayName` (item 12) — and `provinceLevelCode` (a registry slug code) from the form.
- `createListingAction still writes PriceHistory when productModelId is set` (existing behavior pinned).
- `create/update run inside one db.transaction — a Listing.slug 23505 violation throws out of the callback and is classified outside (typed slug-collision error), no partial image rows` (**item 8**).

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/unit/listing-draft-actions.test.ts tests/unit/publication-gate.test.ts tests/unit/listing-actions-images.test.ts`
Expected: FAIL — actions not rewired / missing.

- [ ] **Step 3: Implement**

- Rewire `src/lib/actions/listings.ts` exactly per the interface block. Keep every existing behavior not deliberately changed: slug suffixing, `revalidatePath` targets, redirect targets, `deleteListingAction` otherwise untouched, ownership checks untouched, Batch 3's R5 guards + conditional writes untouched, `runPublicationGate`/`formatMissingRequirements` Vietnamese text untouched (item 17). Form errors stay Vietnamese with stable codes in the message for tests (Batch 2 pattern). No `export const` in this `"use server"` file (B2) — rate constants import from `listing-schema.ts`.
- `submitListingAction` is a plain `FormData` action (button form, not `useActionState`) matching `toggleListingVisibilityAction`'s style; the catch-block-then-redirect pattern per the Global Constraints (never `redirect()` inside `catch`).
- `approveListingAction` in `src/lib/actions/admin.ts`: insert the `checkListingPublication` defense-in-depth after the status check, before the update; **delete the Batch 2-era direct `checkSellerPublicationRequirements` call**; keep the two-reason audit split (`publication_requirements_unmet` + `missing=` / `listing_content_invalid` + `issues=`); keep Batch 2's `auditEvent("listing.approved")` wiring and the CAS pending-only write; `rejectListingAction` untouched.
- `src/lib/audit-event.ts`: append the five new action names to the registry comment (no behavior change — the writer is generic).
- Audit inputs: `actorId: user.id`, `resourceType: "Listing"`, `resourceId`, `reason` = typed code, `policyVersion` on `listing.submitted`, `detail` = ids/counts only via `redactDetail` (no description bodies — spec §4.8).

- [ ] **Step 4: Run tests until green + regression**

Run: `npm test -- tests/unit/listing-draft-actions.test.ts tests/unit/publication-gate.test.ts tests/unit/listing-actions-images.test.ts` → PASS.
Run: `npm test` → full unit suite green — **Batch 2 suites included** (`seller-verification-policy`, `seller-verification-actions`, `rbac`, `session`, `provinces`, finance shutdown) **and Batch 3's moderation suites** (R5 guards intact).
Run: `npm run test:integration` → existing integration suites green; **if `tests/integration/seller-verification.test.ts` creates legacy-category listings, migrate those fixtures to the beta category in the same commit** (same regime as publication-gate).

- [ ] **Step 5: Commit**

```bash
git add src/lib/actions/listings.ts src/lib/actions/admin.ts src/lib/audit-event.ts tests/unit/listing-draft-actions.test.ts tests/unit/publication-gate.test.ts tests/unit/listing-actions-images.test.ts
git commit -m "feat(listing): draft/submit actions behind extended publication gate"
```

## Task 5: Seller + buyer UI — 7-step flow, sell pages, listing detail, labels, CITIES refresh

**Files:**

- Create: `src/components/portable-listing-form.tsx`
- Modify: `src/components/image-picker.tsx` (slot-aware variant props)
- Modify: `app/sell/new/page.tsx`
- Modify: `app/sell/[id]/edit/page.tsx` (regime switch + `.include("category")` for the slug read)
- Modify: `app/sell/my/page.tsx`
- Modify: `app/listings/[slug]/page.tsx` (buyer-facing structured display)
- Modify: `src/lib/constants.ts` (CITIES refresh + labels)
- Modify: `src/components/listing-form.tsx` (legacy select keeps unknown stored city)
- Modify: `src/components/profile-form.tsx` (CITIES consumer — same stored-value handling)
- Modify: `app/models/[slug]/page.tsx` (price-context neutrality check)
- Test: `tests/unit/portable-listing-form.test.ts`
- Test: `tests/unit/sell-pages.test.ts`

**Interfaces:**

- Consumes: `createListingAction`/`updateListingAction`/`saveListingDraftAction`/`submitListingAction` (Task 4), `PHOTO_CHECKLIST_SLOTS`/`LISTING_FULFILLMENT_METHODS` (Task 2 — **values passed as props; the client form never imports `listing-schema.ts`/`beta-categories.ts`**), `PROVINCES`/`PROVINCE_CODES` (`src/lib/provinces.ts` — FD-1 plain module) + `checkSellerPublicationRequirements` (Batch 2 — the step-7 verification prop), `ListingForm` (existing, for the legacy edit regime), `CITIES`/`CONDITION_LABELS` (existing — `CITIES` refreshed in this task).
- Produces:

```tsx
// src/components/portable-listing-form.tsx — "use client", useActionState — 7 bước progressive disclosure (§6.3)
// Step 1: Brand + Canonical model (bắt buộc — select từ approved ProductModel của category beta)
// Step 2: New/open_box/used (inventoryContext) + Condition (CONDITION_LABELS hiện có)
// Step 3: Asking price + Negotiable? (giữ nguyên validation hiện có)
// Step 4: Location (province select từ PROVINCES — 34 đơn vị, FD-1 — neutral copy, KHÔNG nhập địa chỉ
//          nhà riêng) + Fulfillment methods (4 checkbox §5.2)
// Step 5: Photos — 8 slot §5.6.3 (front/back/control_panel/ports/damage/accessories/box/label_serial),
//          mỗi slot một ImagePicker gắn slot; ≥1 ảnh tổng (rule hiện có); copy label_serial:
//          "che/làm mờ serial trước khi chụp — ảnh hiển thị công khai" (§5.6.3: không yêu cầu hiển thị
//          serial nhạy cảm — ảnh slot này render công khai trong gallery)
// Step 6: Accessories / Known defects / Repair history + description (title auto-suggest từ
//          brand+model, editable — description giữ nguyên rule ≥20 ký tự)
// Step 7: Preview + Seller verification check (prop `verification` từ server — Batch 2
//          checkSellerPublicationRequirements(user.id), đọc FRESH từ DB — hiển thị đủ/thiếu từng
//          yêu cầu, KỂ CẢ seller_rules acceptance status + link /sell/verification nơi cơ chế
//          chấp nhận của Batch 2 sống — KHÔNG viết text chấp nhận mới) + nút Submit
//          (createListingAction/updateListingAction) + nút "Lưu nháp" (saveListingDraftAction)
// Props: { categories, brands, models, provinces, fulfillmentMethods, photoSlots,
//          verification: { ok, missing[] }, edit?: {...listing row + imageSlots} }
// Edit page với draft: "Lưu nháp" → saveListingDraftAction; "Gửi duyệt" → submitListingAction
// (listingId) — updateListingAction KHÔNG dùng cho draft (draft→draft, không transition)
```

```ts
// src/lib/constants.ts (thêm — additive; R8: Batch 3 đã thêm removed — Batch 4 CHỈ thêm archived)
export const LISTING_STATUS_LABELS: … += { archived: "Đã lưu trữ" };   // removed đã có từ Batch 3
export const LISTING_STATUS_BADGE:  … += { archived: "bg-zinc-700/60 text-zinc-400" };
export const INVENTORY_CONTEXT_LABELS: Record<string, string>;   // new/open_box/used
export const FULFILLMENT_METHOD_LABELS: Record<string, string>;  // meetup/seller_delivery/carrier/other
export const PHOTO_CHECKLIST_SLOT_LABELS: Record<string, string>; // 8 slot §5.6.3 — nhãn tiếng Việt

// src/lib/constants.ts — CITIES refresh (FD-1): thay 13 mục cũ (có mục stale pre-merger) bằng 34
// displayName chuẩn của registry (+ giữ "Khác"): "Bình Dương" (merged vào TP. Hồ Chí Minh per
// NQ 202/2025/QH15) và "Thừa Thiên Huế" (đơn vị mới là "Huế") KHÔNG còn xuất hiện; "Huế" và
// "TP. Hồ Chí Minh" có mặt. /listings city filter + legacy form select khớp city của listing beta.
// LEGACY-SELECT GUARD (item 11): listing-form.tsx (~L160) dùng defaultValue={edit?.city ?? cities[0]}
// — stored city không có trong options sẽ HIỆN option đầu và LƯU NGẦM giá trị đó (rewrite im lặng
// "Bình Dương" → option đầu khi edit). Fix: render thêm <option> cho stored city khi nó không nằm
// trong CITIES (disabled-không-được-chọn? KHÔNG — chọn được, hiển thị đúng giá trị đang lưu).
// profile-form.tsx (~L33) cũng consume CITIES cho select city hồ sơ — cùng handling: stored value
// không khớp option nào → thêm option riêng (không tự rewrite). Legacy listings giữ nguyên free-text
// city (filter debt recorded — không backfill, spec §8.3).
```

- [ ] **Step 1: Write the failing unit/source-contract tests**

`tests/unit/portable-listing-form.test.ts` (source-contract style — read the component source, assert structure; no jsdom):

- `the form renders the 7 §6.3 steps in order` (brand/model → context/condition → price/negotiable → location/fulfillment → photos → accessories/defects/repair → preview/verification/submit).
- `the photo step renders exactly the 8 §5.6.3 slots` (assert against `PHOTO_CHECKLIST_SLOTS` — non-invention pin).
- `the label_serial slot copy tells the seller to cover/blur the serial because photos render publicly` (§5.6.3).
- `no guarantee language in the component copy` — scan the source for `đảm bảo|bảo đảm|an toàn khu vực|guarantee` (spec §4.2/§4.7) — zero hits.
- `location copy tells the seller not to enter a home address` (§5.6).
- `step 7 renders the seller_rules acceptance status from the verification prop + a /sell/verification link, and authors NO new acceptance text` (§6.3).
- `submit is disabled only by pending state, never by client-side verification` (server is the gate — §4.5).
- `draft button posts saveListingDraftAction; the component imports neither listing-schema.ts nor beta-categories.ts` (props only).
- `the edit page's draft flow offers save + submit (submitListingAction), not updateListingAction`.

`tests/unit/sell-pages.test.ts` (source-contract on the pages):

- `app/sell/new only offers allowlisted categories` — the page queries categories filtered by `BETA_PUBLICATION_CATEGORIES` (assert the filter call in source) and `passes the verification check for step 7`.
- `app/sell/[id]/edit picks the regime by category slug` — beta listing → `PortableListingForm`; legacy listing → existing `ListingForm` (grandfathered); the page `.include("category")` so the slug is readable.
- `app/sell/my renders a submit form for drafts` (`submitListingAction`) and `shows the archived label` via constants (removed label comes from Batch 3).
- `app/listings/[slug] renders the structured fields for buyers` — inventory context, condition, known defects, repair history, accessories, fulfillment methods, canonical location (`locationDisplayName` + province); `null` fields render as absent sections (no "null"/placeholder text); the legacy `user.role === "admin"` read gate at `app/listings/[slug]/page.tsx:45` is left as-is and recorded as a follow-up (not changed in this batch).
- `CITIES is refreshed to the 34 canonical registry displayNames (+ "Khác") — no stale pre-merger names` (Bình Dương and Thừa Thiên Huế absent; Huế and TP. Hồ Chí Minh present — FD-1), so the `/listings` filter options match beta listings' `city` values.
- `the legacy listing-form select renders the stored city as an extra option when it is not in CITIES` (no silent rewrite on edit); `profile-form does the same for the stored profile city` (item 11).
- `app/models/[slug] price block keeps sample-size context` — the "Mẫu giá thu thập: N điểm giá" card stays (§13.6/§5.8.2 low-sample context) and no authoritative "giá thị trường chuẩn" claim is added.

- [ ] **Step 2: Run to verify failure** → `npm test -- tests/unit/portable-listing-form.test.ts tests/unit/sell-pages.test.ts` → FAIL.

- [ ] **Step 3: Implement**

- `portable-listing-form.tsx` per the interface block — reuse the existing form's Tailwind classes/`label`/`input` conventions, `useActionState` for both submit and draft actions, hidden inputs for `imageSlots` parallel to `images`. Accessibility: every control has an associated `<label htmlFor>` (spec §10 accessibility line). All schema/allowlist values arrive as props (no server-module imports).
- `app/sell/new/page.tsx`: categories = `Category.where({ isActive: true })` filtered server-side by `BETA_PUBLICATION_CATEGORIES`; models = approved `ProductModel` in those categories; provinces from `PROVINCES` (34-unit registry — FD-1); `verification` prop = Batch 2's `checkSellerPublicationRequirements(user.id)` result (server-side read, no mutation — the listing-level issues only exist once the form is filled, and those surface as submit errors).
- `app/sell/[id]/edit/page.tsx`: regime switch on `listing.category.slug` (**add `.include("category")` to the listing query** — the current query does not load it); legacy keeps the current `ListingForm` untouched; drafts get "Lưu nháp" + "Gửi duyệt" (`submitListingAction`).
- `app/sell/my/page.tsx`: draft rows get a `Gửi duyệt` form (`submitListingAction`); status labels/badges extended (archived only — removed already handled by Batch 3).
- `app/listings/[slug]/page.tsx`: buyer-facing structured block per the interface (null → absent); no change to the legacy role read gate (follow-up recorded).
- `src/lib/constants.ts`: `CITIES` refresh + additive label maps per the interface block (archived only).
- `src/components/listing-form.tsx` + `src/components/profile-form.tsx`: the stored-value option guard per the interface block.
- `app/models/[slug]/page.tsx`: no functional change expected — only verify/keep the sample-size card; adjust copy only if a guarantee-style word is present (there is none today: "Giá tham chiếu (median)" + "Mẫu giá thu thập" are factual).

- [ ] **Step 4: Run until green** → PASS; then `npm test` full unit suite green.

- [ ] **Step 5: Commit**

```bash
git add src/components/portable-listing-form.tsx src/components/image-picker.tsx app/sell/new/page.tsx 'app/sell/[id]/edit/page.tsx' app/sell/my/page.tsx 'app/listings/[slug]/page.tsx' src/lib/constants.ts src/components/listing-form.tsx src/components/profile-form.tsx 'app/models/[slug]/page.tsx' tests/unit/portable-listing-form.test.ts tests/unit/sell-pages.test.ts
git commit -m "feat(sell): portable-speaker listing flow"
```

## Task 6: Admin review UI — structured fields + workflow badge on /admin/listings

**Files:**

- Modify: `app/admin/listings/page.tsx`
- Modify: `tests/unit/admin-listings-guard.test.ts` (mocks for the new includes)
- Test: `tests/unit/admin-listings-page.test.ts`

**Interfaces:**

- Consumes: `approveListingAction`/`rejectListingAction` (Task 4 state), `INVENTORY_CONTEXT_LABELS`/`FULFILLMENT_METHOD_LABELS`/`PHOTO_CHECKLIST_SLOT_LABELS` (Task 5), `requireCapability("listing.moderate")` page guard (Batch 2), `BETA_PUBLICATION_CATEGORIES` (Task 2), `isVerifiedSellerStatus` (`src/lib/seller-verification-status.ts` — Batch 2).
- Produces: no new actions — display only. The review card gains: beta/legacy category badge, inventory context, condition, known defects, repair history, accessories, fulfillment methods, canonical location (`locationDisplayName` + province), canonical model link, and the photo gallery with slot captions (**all images — drop the `.limit(1)` on the images include**). The seller badge switches from the frozen legacy boolean `l.seller.isVerifiedSeller` to the **live workflow status**: `.include("seller", …)` gains `sellerVerification` (or a nested include) and the badge renders via `isVerifiedSellerStatus(sellerVerification.status)` — a revoked seller loses the badge immediately (Batch 2 review fix; the legacy boolean is display-frozen and must not be the badge source). The card already renders the seller email (existing behavior — kept; the PII note below is corrected accordingly).

- [ ] **Step 1: Write the failing source-contract test**

`tests/unit/admin-listings-page.test.ts`:

- `the review card renders the structured fields` — source asserts presence of `INVENTORY_CONTEXT_LABELS`, `knownDefects`, `repairHistory`, `includedAccessories`, `FULFILLMENT_METHOD_LABELS`, `locationDisplayName`, `PHOTO_CHECKLIST_SLOT_LABELS` usage.
- `beta vs legacy category badge` — the page distinguishes allowlisted categories (badge) from legacy ones (no new validation UI for legacy).
- `the seller badge reads the workflow status via isVerifiedSellerStatus(SellerVerification.status) — NOT the legacy isVerifiedSeller boolean` (source-contract).
- `the images include has no .limit(1) — the gallery shows every image with its slot caption`.
- `the page keeps the Batch 2 capability guard` (`requireCapability("listing.moderate")` call in source).
- `the card renders the seller email as today (existing behavior — no NEW PII is added beyond it; no phone is rendered)`.

- [ ] **Step 2: Update the existing guard test's mocks**

`tests/unit/admin-listings-guard.test.ts` (Batch 2/3 file): extend its db mock for the new includes (`sellerVerification` nested on `seller`, images without `.limit(1)`) so its existing assertions stay green — fixture shape only, no invariant change.

- [ ] **Step 3: Run to verify failure** → FAIL.

- [ ] **Step 4: Implement** — extend the existing card layout (`app/admin/listings/page.tsx` lines ~58–100 pattern) with the structured block + the workflow badge; legacy listings render the block with em-dashes for null fields (compatible by construction). No action changes.

- [ ] **Step 5: Run until green** → PASS; `npm test` green.

- [ ] **Step 6: Commit**

```bash
git add app/admin/listings/page.tsx tests/unit/admin-listings-guard.test.ts tests/unit/admin-listings-page.test.ts
git commit -m "feat(admin): structured listing review surface"
```

## Task 7: Beta catalog seed — category, brands, founder-supplied models

**Files:**

- Create: `scripts/seed-beta-catalog.ts`
- Test: `tests/integration/beta-catalog-seed.test.ts`

**Interfaces:**

- Consumes: `Category`/`Brand`/`ProductModel` models, `BETA_PUBLICATION_CATEGORIES` (`src/lib/beta-categories.ts` — plain module, importable under `tsx`), `PROVINCES` (not needed by the seed — listed for completeness of the plain-module set). **The script imports only plain modules** — `src/lib/audit-event.ts` is `server-only` and **throws under tsx**: follow the `scripts/backfill-seller-verification.ts` precedent verbatim — `DATABASE_URL` must be in the **real env** (`process.env`) *before* the `db.client`/dotenv dynamic import (no top-level import), and the `AuditEvent` row is written **directly via `db.orm.public.AuditEvent.create`** with the same shape `auditEvent` uses (actor null — system; `detail` = counts only, no PII).
- Produces:

```ts
// scripts/seed-beta-catalog.ts — offline maintenance command (Batch 2 backfill-script posture:
// dry-run mặc định, --apply để mutate, idempotent, KHÔNG expose HTTP/admin UI)
// Usage: DATABASE_URL=… npx tsx scripts/seed-beta-catalog.ts [--apply] [--models <founder.json>]
// 1. Category "Loa Bluetooth di động" slug "portable_bluetooth_speaker" — đúng slug trong
//    BETA_PUBLICATION_CATEGORIES (spec §5.6.1 verbatim) — create-if-absent theo slug,
//    KHÔNG đụng category khác (A11: "loa-bluetooth" seed hiện có vẫn active — founder quyết).
//    KHÔNG slugify() slug này — slugify() strip "_" (snake_case → kebab) và làm hỏng khóa allowlist.
// 2. Brands: đảm bảo JBL, Marshall, Sony, Bose, Soundcore tồn tại (Soundcore MỚI — seed hiện
//    chưa có) — create-if-absent theo slug
// 3. --models <founder.json>: danh sách model FOUNDER CUNG CẤP (brand, name, releaseYear?) —
//    upsert create-if-absent theo slug với status "pending" — founder duyệt qua /admin/catalog
//    (requireCapability("listing.moderate") của Batch 2). IMPLEMENTER KHÔNG TỰ VIẾT danh sách model
//    từ training data (A3). KHÔNG BAO GIỜ reassign category/brand của model đã tồn tại —
//    seed-models.ts có sony-srs-xp500/bose-s1-pro approved trong loa-bluetooth, không đụng.
// 4. --apply: AuditEvent ghi TRỰC TIẾP qua db.orm.public.AuditEvent.create (action
//    "beta_catalog.seeded", actorId null, detail = counts — backfill-seller-verification.ts precedent)
export async function seedBetaCatalog(isApply: boolean, modelsFile?: string): Promise<{ category: number; brands: number; models: number }>;
```

- [ ] **Step 1: Write the failing integration test**

`tests/integration/beta-catalog-seed.test.ts` (real DB, `hasDb` pattern; the test creates its **own** approved beta-category model fixture for the selection flow — it does not depend on the founder list):

- `dry-run reports the plan and mutates nothing` (counts printed, zero rows changed).
- `--apply creates the category with the allowlist slug (NOT slugified — underscore intact) and the Soundcore brand` — then `listingRegimeForCategorySlug(category.slug) === "beta"` and a listing created against the test's own approved model fixture round-trips `productModelId` (**canonical-model-selection gate**).
- `--models <file> upserts the founder list as PENDING models (create-if-absent)` — none are `approved` until founder action; `an existing model (sony-srs-xp500 in loa-bluetooth) is untouched` (no category/brand reassignment).
- `the seed's AuditEvent row is written directly via db.orm (actorId null, action "beta_catalog.seeded", detail = counts)` — the script never imports the server-only `audit-event.ts` (source-contract).
- `idempotent: second --apply is a no-op` (create-if-absent, zero duplicates).
- `rollback documented`: deleting the seeded rows by slug list restores the prior state (assert the delete works on the scratch DB and the category is gone).

- [ ] **Step 2: Run to verify failure** → `npm run test:integration` → FAIL (script missing).

- [ ] **Step 3: Implement** — the script per the interface block; refuses to run without `DATABASE_URL` in the real env (dynamic-import pattern per `backfill-seller-verification.ts`); prints the plan (and the founder model list when `--models` is given) in dry-run for review; imports only plain modules (`beta-categories.ts`, `utils.ts`, `db.client.ts` via dynamic import); the category slug is the literal `portable_bluetooth_speaker` (never through `slugify`).

- [ ] **Step 4: Run the real dry-run + until green**

```bash
DATABASE_URL=… npx tsx scripts/seed-beta-catalog.ts     # dry-run thật — output dán vào verification doc
npm run test:integration                                # PASS (all integration suites)
```

- [ ] **Step 5: Commit**

```bash
git add scripts/seed-beta-catalog.ts tests/integration/beta-catalog-seed.test.ts
git commit -m "feat(catalog): seed beta category and canonical models"
```

## Task 8: Legacy compatibility + full publication-gate integration (real DB)

**Files:**

- Test: `tests/integration/legacy-listing-compat.test.ts`
- Test: `tests/integration/listing-publication.test.ts`

**Interfaces:**

- Consumes: everything from Tasks 1–7 + Batch 2's verification helpers (`PolicyAcceptance`, `BetaCohortMembership`, `SellerVerification`, `UserSuspension` rows — Batch 3) to build a fully verified seller fixture. Both files mock the action-boundary modules exactly like the unit suites — **`vi.hoisted` for all mock state** (the Batch 3 Global Constraints recipe):

```ts
// vi.mock bắt buộc ở đầu cả hai file integration (item 4 — Batch 3 recipe):
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error("NEXT_REDIRECT:" + url); }, notFound: () => { throw new Error("NEXT_HTTP_ERROR_FALLBACK;404"); } }));
const headerState = vi.hoisted(() => ({ headers: new Headers() }));
const cookieState = vi.hoisted(() => ({ store: new Map<string, string>() }));
vi.mock("next/headers", () => ({ /* cookies/headers trả về state hoisted — form của publication-gate.test.ts */ }));
vi.mock("@/src/lib/auth", () => ({ requireUser: () => fixtureSeller(), getCurrentUser: () => fixtureSeller() }));
vi.mock("@/src/lib/rbac", () => ({ requireCapability: () => fixtureAdminContext() }));
// fixtureSeller() / fixtureAdminContext(): integration tạo User row THẬT trong scratch DB rồi trả về
// (AuditEvent.actorId là FK — admin fixture PHẢI là User row thật, không phải object suông).
// db client KHÔNG mock — integration chạy trên scratch DB thật (hasDb guard).
```

- [ ] **Step 1: Write the failing integration tests**

`tests/integration/legacy-listing-compat.test.ts` (real DB — **legacy listing compatibility gate**):

- Seed a legacy listing exactly like `src/prisma/seed.ts` does (category `loa-thung-pa`, `/img/listings/…` image, no structured fields, `city: "Hà Nội"`).
- `legacy edit passes under the legacy regime`: `updateListingAction` with a legacy-shaped input (no model, no structured fields) updates the row; content change → `pending`.
- `legacy re-approval works`: `approveListingAction` approves it (grandfathered category — allowlist passes; legacy schema passes) — **no legacy breakage** (Review Focus 5).
- `legacy category change to another legacy slug → typed error`; `to the beta slug → full beta validation required` (model/brand/etc. missing → typed error).
- `kept seed images pass ownership rule (2)`; `kept attached pre-Batch-4 /uploads/<uuid>.jpg passes on edit` (**B1**); `a detached pre-Batch-4 /uploads file re-attached → IMAGE_NOT_OWNED` (accepted compat behavior, pinned); `an attached https:// URL → IMAGE_URL_INVALID at approve` (**B1**).
- `legacy rejected listing stays rejected on content edit (A10 interim)`.
- `legacy listing renders with NULL structured fields` — read back, all null, no error.

`tests/integration/listing-publication.test.ts` (real DB — **publication-gate gate**, end-to-end):

- Build a seller fixture: user → `emailVerifiedAt`/`phoneVerifiedAt` → `sellerType`/`sellerOperatingProvinceCode` (a registry slug code) → `PolicyAcceptance(seller_rules, v1)` → `BetaCohortMembership(founding_seller, active)` → `SellerVerification(verified)` (the Batch 2 Task 10 integration helpers' pattern).
- `draft → submit → approve happy path`: `saveListingDraftAction` (pre-verification draft allowed) → verify the seller → `submitListingAction` → row `pending` → `approveListingAction` → row `approved` → public read passes; structured fields + checklistSlot + `city = PROVINCE_CODES[provinceLevelCode]` (canonical 34-unit displayName) round-trip.
- `revoked seller: submit blocked, status stays draft, audit row exists`; `re-verify → submit passes`.
- `suspended cohort membership: toggle hidden→approved blocked` (Batch 2 invariant through the wrapper).
- `actively UserSuspension-suspended seller (Batch 3's account_not_suspended): create/submit/toggle blocked with SELLER_PUBLICATION_BLOCKED:account_not_suspended; approveListingAction → no approval + audit "publication_requirements_unmet" with missing=account_not_suspended` (**item 14 — distinct from membership suspension**).
- `upload ownership end-to-end`: upload route path (or direct `ListingImageUpload.create`) → image accepted; another seller's storageKey → `IMAGE_NOT_OWNED` through `createListingAction`; `a scheme URL whose basename is the seller's own upload → IMAGE_URL_INVALID`.
- `category allowlist end-to-end`: create in a legacy category → typed error; create in beta category with complete input → passes.
- `canonical model end-to-end`: submit against a `pending` model → `MODEL_INVALID`; wrong-brand model → `MODEL_BRAND_MISMATCH` (**B4**).
- `transaction no-silent-success (item 8)`: `a Listing.slug unique violation inside create's tx throws out and is classified outside — no ListingImage/PriceHistory partial rows persist`; `a racing status change on submit → the conditional claim hits 0 rows → typed conflict, no partial write`.

- [ ] **Step 2: Run — may pass; record**

Run: `npm run test:integration`. These tests exercise behavior already implemented in Tasks 1–7, so cases **may pass immediately** — that is acceptable: record which cases passed on first run and which required fixes (a fix means a Task 1–7 defect: fix it in its owning module with its unit test, not the integration test).

- [ ] **Step 3: Make the tests pass** — see above; no product code should change beyond defect fixes.

- [ ] **Step 4: Run until green** → `npm run test:integration` → PASS (all suites: escrow, batch2-*, batch3-*, batch4-migration, beta-catalog-seed, legacy-listing-compat, listing-publication).

- [ ] **Step 5: Commit**

```bash
git add tests/integration/legacy-listing-compat.test.ts tests/integration/listing-publication.test.ts
git commit -m "test(listing): legacy compat and publication gate integration"
```

## Task 9: Batch 4 gate verification + verification doc

**Files:**

- Create: `docs/operations/private-beta-batch4-listing-quality-verification.md`

- [ ] **Step 1: Run every gate suite and record results**

```bash
npm test -- tests/unit/listing-draft-actions.test.ts                                   # draft behavior
npm test -- tests/unit/publication-gate.test.ts                                        # publication gate (4 transitions + submit + R5 + account_not_suspended)
npm test -- tests/unit/beta-categories.test.ts                                         # invalid-category rejection
npm test -- tests/unit/listing-schema.test.ts                                          # conditional fields (beta vs legacy regime)
npm test -- tests/unit/image-validate.test.ts tests/unit/upload-route.test.ts          # upload validation
npm test -- tests/unit/image-process.test.ts                                           # image security cases (EXIF/GPS/polyglot/bomb)
npm test -- tests/unit/listing-images.test.ts tests/unit/listing-actions-images.test.ts # image ownership (rules 1/2/3)
npm test -- tests/unit/portable-listing-form.test.ts tests/unit/sell-pages.test.ts      # 7-step flow + copy neutrality + CITIES
npm test -- tests/unit/admin-listings-page.test.ts tests/unit/admin-listings-guard.test.ts # admin review surface
npm run test:integration                                                                # batch4-migration, beta-catalog-seed,
                                                                                        # legacy-listing-compat, listing-publication
                                                                                        # + Batch 1/2/3 suites
DATABASE_URL=… npx tsx scripts/seed-beta-catalog.ts                                      # dry-run thật — output vào verification doc
```

- [ ] **Step 2: Backend-enforcement + copy source scan** (spec §4.5, §4.2, §4.7)

```bash
rg -n "BETA_PUBLICATION_CATEGORIES" src app            # expect: beta-categories.ts (definition) + call sites — KHÔNG client bundle
rg -n "assertListingPublishable|assertListingContentValid|checkListingPublication" src/lib/actions   # expect: mọi transition dùng wrapper; approve chỉ checkListingPublication
rg -n "checkSellerPublicationRequirements" src/lib/actions/admin.ts   # expect: 0 hits (direct call deleted — subsumed by checkListingPublication; spy không chứng minh được — scan là bằng chứng)
rg -n "isModerationLocked" src/lib/actions/listings.ts # expect: mọi R5 guard gọi helper từ @/src/lib/moderation
rg -n '"removed"' src/lib/actions/listings.ts          # expect: 0 hits ngoài comment (no hardcoded status — Batch 3 source-contract)
rg -n "đảm bảo|bảo đảm|guarantee" src/components/portable-listing-form.tsx app/sell app/models   # expect: 0 hits NGOÀI COMMENT (app/sell/verification/page.tsx ~L28 có comment liệt kê avoid-list — classify, không phải copy render)
rg -n "an toàn khu vực|khu vực an toàn|verified market" src app     # expect: 0 hits (§4.7 location neutrality)
rg -n "dangerouslySetInnerHTML" src/components app                  # expect: 0 hits (stored XSS through listing)
rg -n "FINANCIAL_FEATURES_ENABLED" .env.example docker-compose.prod.yml scripts   # expect: still "false" everywhere
rg -n "withMetadata" src/lib/image-process.ts app/api/upload        # expect: 0 hits — re-encode KHÔNG giữ metadata
rg -n "nosniff" next.config.ts                                     # expect: /uploads headers có mặt
grep -n "Bình Dương\|Thừa Thiên Huế" src/lib/constants.ts           # expect: 0 hits sau CITIES refresh (FD-1 — stale names gone)
node -e 'const {PROVINCE_CODES} = require("./src/lib/provinces.ts"); console.log(Object.keys(PROVINCE_CODES).length)'  # expect: 34 (hoặc assert qua tests/unit/provinces.test.ts đã green)
```

Manually classify every hit; fix any that violates the invariant.

- [ ] **Step 3: Full preflight + build + smoke**

```bash
npm run lint
npx tsc --noEmit
npm test
npm run test:integration
npm run build
npm run preflight        # contract-emit drift + lint + typecheck + unit + build + compose + migration graph
npm run smoke            # local safe smoke
npm audit --omit=dev     # sharp exact-pinned — phải sạch
```

- [ ] **Step 4: Diff/status audit**

- `git diff --check`; `git status --short` contains only Batch 4 files; no `.claude/settings.json`, no `public/uploads/` runtime files, no secrets, no scratch.
- `npx prisma migration list` shows the linear graph **baseline → batch2 → batch3 → batch4** (R3 — no node with two outgoing edges); `npx prisma db verify` clean.
- Inspect the migration once more: no destructive op on data — the `Listing_status_check_*` DROP+ADD pair (enum constraint rebuild) is **expected and additive in effect** (R3); `archived` appended; zero data transforms.

- [ ] **Step 5: Write the verification doc**

`docs/operations/private-beta-batch4-listing-quality-verification.md` records: base (merged Batch 3 commit) and final commit hashes; OpenCode model/session metadata; per-gate test results (the eight Batch 4 gate items → named suites, verbatim mapping); the source-scan classification table (incl. the comment-vs-render classification for the §6.2 avoid-list scan and the `checkSellerPublicationRequirements`-absence proof living here, not in spies); migration review notes (additive-only confirmation + the expected `Listing_status_check_*` DROP+ADD pair); the seed dry-run output + the founder model-list status (A3 — models seeded `pending`, approved via `/admin/catalog`); the `npm audit` result; the **`/uploads` headers deploy note** (production nginx proxies `location /` to the app per `docs/deployment.md`, so the `next.config.ts` headers reach `/uploads`; if a future deploy serves `/uploads` directly from nginx, the same two headers go into that location block); the **dormant finance paths note** (`resolveDisputeAction`'s order-completion branch `src/lib/actions/admin.ts` **~L144** and the order-completion path `src/lib/actions/orders.ts` ~L373 set `Listing.status = "approved"` without the publication gate — unreachable while `FINANCIAL_FEATURES_ENABLED=false` per the Batch 1 boundary; defense-in-depth note for the finance re-enable review); the **Batch 6 follow-ups** (`startConversationAction`/`toggleWishlistAction` accept non-approved listings; the listing-detail page's legacy `user.role === "admin"` read gate at `app/listings/[slug]/page.tsx:45`); residual risks (pre-Batch-4 detached uploads not re-attachable; attached scheme-URLs rejected even at approve; GIF→static WebP; drafts have no autosave and effectively require a province (city derives from it); orphaned upload files remain publicly reachable until A8 is decided; browser E2E still deferred — tracked pre-invite prerequisite per spec §10/§12); deferred items (Batch 5/6/7/8 pointers); the Batch 3 hand-off state (R1–R9 applied: enum ownership, `isModerationLocked` guards kept + extended, conditional writes kept, fixtures migrated); and the explicit statement that **beta-launch readiness additionally requires** the founder-authored content items listed in *Ambiguities* for the **Batch 8 Founder Decision Register** (FD-3: condition definitions A1, photo-checklist requiredness A2, model list A3, retention A8, legacy-repurposing policy A10, category taxonomy A11 — plus FD-2's deferred production OTP provider from Batch 2 A1) — those block launch content, not the implementation gate (A9 is resolved by FD-1).

- [ ] **Step 6: Commit**

```bash
git add docs/operations/private-beta-batch4-listing-quality-verification.md
git commit -m "test(batch4): verify listing quality gate"
```

## Acceptance Gate

Batch 4 is accepted only if all of the following are true (spec §9 Batch 4 Gate — every item maps to a named suite):

- **Draft behavior** — `tests/unit/listing-draft-actions.test.ts`: drafts creatable before verification (no seller-gate call), never publicly visible (detail/home/seller/model/compare/related queries filter `approved`; conversation/wishlist gap recorded as Batch 6 follow-up), rate-limited, image-ownership-validated, R5-guarded (`isModerationLocked`); `submitListingAction` is the only draft→review path and it is gated; `updateListingAction` on a draft stays `draft` (specified).
- **Publication gate** — `tests/unit/publication-gate.test.ts` (extended) + `tests/integration/listing-publication.test.ts`: create/submit/update-into-pending/toggle each call `assertListingPublishable` exactly once (cross-module counting wrappers) (= Batch 2 seller gate incl. Batch 3's `account_not_suspended` + `assertListingContentValid`: allowlist + regime schema + canonical-model DB check + image ownership); non-transition updates call `assertListingContentValid`; admin approve calls `checkListingPublication` once (the Batch 2-era direct `checkSellerPublicationRequirements` call deleted — proven by source scan); **every** structured field, brand/model, image set, and slot set counts as a content change, and `hidden` content changes also go to `pending` (B3); revoked sellers, suspended memberships, **and actively `UserSuspension`-suspended sellers** blocked on every path including admin approval; Batch 2 **and Batch 3** gate cases stay green with migrated fixtures.
- **Invalid-category rejection** — `tests/unit/beta-categories.test.ts` + publication-gate cases: new listings only in `portable_bluetooth_speaker`; category changes only into the allowlist; unchanged legacy categories grandfathered.
- **Conditional fields** — `tests/unit/listing-schema.test.ts`: beta regime requires brand/canonical model/inventory context/condition/fulfillment/province+display location/≥1 image; legacy regime requires only the existing rules; drafts require the base non-null fields incl. province (structured optional, images 0..8); free-text caps enforced.
- **Upload validation** — `tests/unit/image-validate.test.ts` + `tests/unit/upload-route.test.ts`: early `Content-Length` rejection, magic bytes + decode + caps + auth + per-user(≤ per-IP)/IP rate limits (per-user test sets `TRUST_PROXY_HEADERS` + varies `x-real-ip`); SVG/HTML never accepted; the stored file is the re-encoded buffer; the upload row precedes the file; `/uploads` served with `nosniff` + CSP `default-src 'none'; sandbox`.
- **Image security cases** — `tests/unit/image-process.test.ts` + `tests/unit/listing-images.test.ts`: EXIF/GPS stripped (JPEG with GPS IFD → clean WebP), auto-orient before strip, polyglot neutralized, decompression bomb capped at a **justified** 50MP/12kpx (current 40MP/10k caps reject 41MP today; 48MP phone sensors admitted after the move; output resize-bounded), output-size cap, randomized storage keys, per-URL ownership rules (1)/(2)/(3) enforced at the action boundary (cross-account theft → typed error; **scheme URL whose basename is the seller's own upload → `IMAGE_URL_INVALID`**; attached scheme-URLs rejected even at approve).
- **Canonical model selection** — `tests/unit/listing-publication.test.ts` (`assertCanonicalModelValid`: merged/pending/other-category → `MODEL_INVALID`, other-brand → `MODEL_BRAND_MISMATCH`) + `tests/integration/beta-catalog-seed.test.ts` (founder-supplied models seeded `pending`, create-if-absent, no reassignment, idempotent, slug never through `slugify`).
- **Legacy listing compatibility** — `tests/integration/legacy-listing-compat.test.ts`: pre-Batch-4 listings render, edit, resubmit, and re-approve unchanged under the legacy regime (rejected→pending blocked per the A10 interim); kept seed images and attached pre-Batch-4 uploads pass; detached pre-Batch-4 uploads rejected with a typed error (documented compat behavior).
- **Batch 1 preserved** — all finance shutdown suites, `FINANCIAL_FEATURES_ENABLED=false`, and the escrow integration invariants stay green; the migration is additive-only with zero data transforms (the `Listing_status_check_*` DROP+ADD pair expected and additive in effect).
- **Batch 2 preserved** — seller-verification, rbac, session, audit, and provinces suites stay green; the seller publication gate is called, not duplicated (counting-wrapper-pinned); `runPublicationGate`/`formatMissingRequirements` Vietnamese text unchanged.
- **Batch 3 preserved (R1–R9)** — Batch 3's suites stay green; its `removed` enum value, `isModerationLocked` guards, conditional writes, and audit names are intact (no hardcoded `"removed"`/raw `.includes` in `listings.ts`); Batch 4 added only `archived` and extended the guards to the draft/submit actions.
- **Copy invariants** — source scan shows no guarantee language outside comments (§4.2), no location-safety claims (§4.7), no `dangerouslySetInnerHTML`, no `withMetadata` in the upload path (§4.8), and the `label_serial` copy tells sellers to blur serials (§5.6.3).
- Preflight (lint, typecheck, unit, build, compose, migration graph), integration suite, safe smoke, and `npm audit --omit=dev` all pass; diff/status audit clean.

## Threat-Case Coverage Map (spec §10.1 rows applicable to Batch 4)

| Abuse case | Covered by |
|---|---|
| Unauthorized listing edit | Task 4 ownership checks pinned in `listing-draft-actions.test.ts` (submit IDOR) + existing `updateListingAction` sellerId check re-pinned in publication-gate fixtures |
| Listing IDOR | Task 4 `submitListingAction` other-seller draft → silent return; `toggleListingVisibilityAction`/`deleteListingAction` ownership unchanged and covered by Batch 2 fixtures |
| Malicious image upload | Task 3 `image-process.test.ts` (polyglot neutralized, SVG rejected) + `upload-route.test.ts` (stored = re-encode output, row-before-file) |
| MIME spoof | Task 3 `image-validate.test.ts` existing magic/format cross-check cases re-pinned at the route |
| Image decompression bomb | Task 3 `limitInputPixels` 50MP cap + 12kpx dim cap + resize-bounded output + `TOO_MANY_PIXELS`/`TOO_LARGE_DIMENSIONS` cases |
| Stored XSS through listing | React text-node rendering + Task 9 `dangerouslySetInnerHTML` scan; description never rendered as HTML; `/uploads` served with `nosniff` + CSP `default-src 'none'; sandbox` |
| Suspended-user publication bypass (**`UserSuspension`** — Batch 3's `account_not_suspended`, the 8th gate requirement) | Task 4 publication-gate cases + `tests/integration/listing-publication.test.ts` (active `UserSuspension` blocks create/submit/toggle/approve — read fresh from DB by the Batch 2 gate) |
| Revoked-seller publication bypass | Task 4 publication-gate cases (revoked → create/update/submit/approve blocked) |
| Beta-cohort bypass (**founding_seller membership suspension** — distinct from `UserSuspension`) | Task 4 + `tests/integration/listing-publication.test.ts` (membership status read fresh from DB by the Batch 2 gate) |
| Moderation-locked (`removed`) listing abuse | R5 guards kept in update/toggle/delete + extended to draft/submit via `isModerationLocked`; pinned in `publication-gate.test.ts` |
| CSRF on state-changing actions | Next.js 16 server actions are POST-only with built-in origin protection — noted in the verification doc (Batch 2 posture, no custom token layer added) |
| Financial direct route / API mutation / webhook / cron / escape hatch | Batch 1 suites re-run in Task 9; no Batch 4 surface touches finance; dormant `approved`-setting finance paths (admin.ts ~L144, orders.ts ~L373) noted in the verification doc |

## Ambiguities and Deployment Prerequisites

Recorded per spec §4.11/§11.1 — none is silently resolved by implementation; each is handled fail-closed/neutral. **Founder decisions 2026-10-06 (FD-1..3, `/tmp/loaviet/founder-decisions.md`) applied:** **FD-1** resolves A9 (34-unit registry, below); **FD-2** defers the production OTP email/SMS provider (Batch 2 A1) — it stays a beta-launch prerequisite in the Batch 8 register, implementation proceeds with the fail-closed production adapter; **FD-3: execution PROCEEDS on every other item below with the fail-closed default already chosen** — founder-authored *content* (condition-grade copy, checklist requiredness, model seed list, retention policy, legacy-repurposing policy, category taxonomy) ships as clearly-marked placeholders/pending mechanisms and is listed in the **Batch 8 Founder Decision Register** as launch blockers, never invented:

1. **A1 — PROCEEDS (FD-3); founder-authored content → Batch 8 register: condition-grade user-facing definitions.** Spec §5.6 requires "user-facing definitions rather than only vague labels such as '95%'" but does not state the definition text; it is also unclear whether the existing 8-value `product_condition` enum is the intended grade set for portable speakers, and **`new`/`open_box` overlap between `product_condition` and `inventoryContext`** — the founder must decide how the two fields relate (no cross-field rule is invented). Batch 4 ships the *mechanism* (condition field + labels in the flow, §6.3 Step 2) using the existing enum/labels (already non-percentage, named grades) and **does not author new definition copy**. *Launch blocker (Batch 8 register): the per-grade definition copy and the enum/overlap decision — a change would need its own additive migration + re-validation.*
2. **A2 — PROCEEDS (FD-3); requiredness decision → Batch 8 register: photo-checklist requiredness.** Spec §5.6.3 enumerates the 8 slots (verbatim shipped) but marks several as optional ("box where available", "label/serial where safe") and says the UI "guides" — it never states whether any slot is mandatory (e.g. front photo required for `used`). Batch 4 ships all 8 as guidance slots with the existing ≥1-image rule and no slot required. *Launch blocker (Batch 8 register): requiredness per slot/condition — until then the unambiguous guidance ships.*
3. **A3 — PROCEEDS (FD-3); founder-supplied list → Batch 8 register: canonical model list.** Spec §1 names the focus brands (JBL, Marshall, Sony, Bose, Soundcore) but not the models; §12.1 requires manual review of core model coverage. **The implementer must not author a model list from training data.** Task 7 seeds the category + brands and upserts a **founder-supplied** list (`--models <founder.json>`) as `status: "pending"`, approved via `/admin/catalog` — the beta form's model select stays empty until the founder acts. *Launch blocker (Batch 8 register): the founder supplying and approving the model list.*
4. **A4 — PROCEEDS (FD-3) with the recorded default: commune-level location.** No commune dataset exists in P0; Batch 4 stores `communeLevelCode` (nullable, reserved) and collects province-level only (34-unit registry codes). Batch 5 ("canonical current location model") populates it. Recorded, not invented.
5. **A5 — PROCEEDS (FD-3) with the recorded default: `verification_blocked` as a distinct status.** Spec §5.6.2 *recommends* the lifecycle; Batch 4 maps it onto the existing enum (see Legacy Migration Decisions) and represents the blocked state as `draft` + surfaced missing requirements. Reversible by a later additive migration if the founder wants the explicit state.
6. **A6 — PROCEEDS (FD-3) with the recorded default: draft retention.** Spec is silent on draft cleanup/retention; drafts are kept indefinitely, rate-limited, never public. No retention policy is invented; a later reviewed policy can add cleanup.
7. **A7 — PROCEEDS (FD-3) with the recorded default (mapping): fulfillment-method values.** `meetup | seller_delivery | carrier | other` are mapped from spec §5.2's Deal fulfillment methods to the listing field (§3.1 "fulfillment methods", §6.3 Step 4). Reversible constant.
8. **A8 — PROCEEDS (FD-3) with the recorded default; policy → Batch 8 register (retention, §4.11): orphaned upload files.** `public/uploads` is static: files orphaned by listing deletion (or superseded by re-uploads) remain publicly reachable forever, and no cleanup/retention policy exists. Batch 4 does **not** invent one (deleting files would also break Batch 3 evidence snapshots, which need the files kept). *Launch blocker (Batch 8 register): retention/expiry policy before broader invites; recorded in the verification doc.*
9. **A9 — RESOLVED (FD-1, 2026-10-06): province registry.** The founder approved the **34-unit canonical registry** per **NQ 202/2025/QH15** (source: `https://baochinhphu.vn/nghi-quyet-cua-quoc-hoi-ve-sap-xep-don-vi-hanh-chinh-cap-tinh-102250612191145158.htm`; founder-approved table `/tmp/loaviet/provinces-34.md`): 34 units (28 tỉnh + 6 thành phố trực thuộc trung ương), stable slug codes + `displayName` + `kind` + `legacyNames`, shipped as the plain module `src/lib/provinces.ts` by **Batch 2 Task 10** — Batch 4 only consumes it (`PROVINCES`/`PROVINCE_CODES`/`isProvinceCode`/`resolveLegacyProvince`). The obsolete 63-province list is gone; stale names are gone from `CITIES` after the Task 5 refresh (Bình Dương → `ho-chi-minh` per its `legacyNames`; **"Thừa Thiên Huế" is NOT a legacy name of `hue` — `resolveLegacyProvince("Thừa Thiên Huế")` returns `null`**, only "Huế" matches, pinned by `tests/unit/provinces.test.ts`); the legacy-name mapping rule (merged legacy names → new unit; NFC + trim + case-fold + diacritic-insensitive + prefix-strip) is **authoritative per NQ 202/2025/QH15 — not guessing**. Task 9's checks: no stale names in `src/lib/constants.ts` + `PROVINCE_CODES` has 34 keys (via the green `provinces.test.ts`).
10. **A10 — PROCEEDS (FD-3) with the fail-closed interim; policy → Batch 8 register: legacy repurposing.** Grandfathering keyed only on unchanged category lets a seller rewrite an old legacy listing's content wholesale (bypassing beta structured requirements) while keeping the legacy category — spec §5.6.1 suggests this is founder policy. **Interim (implemented):** legacy-regime listings in status `rejected` do not resubmit to `pending` on edit (fail closed; the seller is directed to create a new beta-category listing). *Launch blocker (Batch 8 register): the full legacy-edit policy (e.g. freeze legacy edits entirely, or allow with ops review).*
11. **A11 — PROCEEDS (FD-3) with the recorded defaults: seed taxonomy.** (a) Two public speaker categories now exist — the seeded `loa-bluetooth` (with live demo listings) and the new `portable_bluetooth_speaker`; whether `loa-bluetooth` is deactivated/merged is a founder product decision (§5.6.1) → Batch 8 register. (b) The beta category slug uses the spec's verbatim `portable_bluetooth_speaker` (snake_case), deviating from the repo's kebab-case slug convention — kept for spec-greppability (and **never passed through `slugify`**, which strips `_`); recorded.

## Batch 3 Coordination Points (narrow interface — Batch 3 is merged before Batch 4 starts per R1)

- **C1 — enum ownership (R2/R9).** Batch 3's migration adds `listing_status.removed` (first writer). Batch 4's diff adds **only `archived`** and must not re-add `removed`. Exactly one plan may contain `removed` in its contract diff; if Batch 4 must land first (R9 fallback), Batch 4 keeps owning `removed` + the R5 guards and Batch 3 rebases per R3.
- **C2 — transition ownership (R6).** Batch 4 owns the publication transitions (`draft→pending` submit, `pending→approved` approve, `approved↔hidden` toggle, content-change→pending) and the gate wrapper `assertListingPublishable`/`assertListingContentValid` — **changes to the listing wrapper are forbidden from Batch 3's side**. Batch 3 may extend **only `src/lib/seller-verification-policy.ts`** (it added `account_not_suspended`); `assertListingPublishable` inherits the addition automatically. Batch 4 Task 4 migrates Batch 3's suspension test cases in `tests/unit/publication-gate.test.ts` to beta-category fixtures and keeps them green.
- **C3 — audit registry split (R8).** Batch 3's moderation takedown audits as **`moderation.listing_taken_down`**; Batch 4 adds `listing.draft_created`, `listing.draft_updated`, `listing.submitted`, `listing.submit_blocked`, and `beta_catalog.seeded` (plus reuses Batch 2's `listing.approved`/`listing.rejected`/`listing.approve_blocked`) through the same `auditEvent` writer — no shared action names, no overlap.
- **C4 — evidence vs deletion.** Batch 3's evidence snapshots read `Listing`/`ListingImage` rows (and need orphaned upload **files kept** — see A8); Batch 4's `deleteListingAction` (seller) deletes rows and Batch 3's R5 guard already blocks deletion of `removed` listings. Any further investigation-hold on deletion is a Batch 3-side check inside `deleteListingAction` — flagged so Batch 3's plan accounts for touching a Batch 4-rewired file.
- **C5 — `rejected`/`rejectionReason` (admin review) vs `removed` (moderation) (R4).** Batch 3's `takeDownListingAction` is an atomic `updateAll({ status: "removed" })` over `{approved, hidden, pending}` and **never writes `rejected`/`rejectionReason`** — the takedown reason lives in `ModerationAction` as a typed code. Batch 4 keeps admin rejection (`rejectListingAction`, pending-only) as-is.

## Batch 3 ↔ 4 Reconciliation

*Adopted verbatim from `/tmp/loaviet/b34-reconcile.md` — both plans MUST carry these rules:*

- **R1 Order:** Batch 3 is implemented and passes its gate first; Batch 4 starts execution only on the merged Batch 3 commit (spec §9). Parallel planning is fine; parallel execution is not.
- **R2 Enum ownership:** Batch 3's migration adds `listing_status.removed` (first writer). Batch 4 Task 1 removes `removed` from its diff and adds only `archived` (or nothing).
- **R3 Migration graph:** before Task 1, Batch 4 confirms db/production refs equal Batch 3's `to` hash and plans with `--from <batch3 migration dir>`; `npx prisma migration list` must show exactly baseline → batch2 → batch3 → batch4 (no node with two outgoing edges). If a Batch 4 package was authored on a stale base: delete the uncommitted package + snapshot, re-emit, re-plan; never hand-merge ops.json/contract.json. Expect the Batch 4 diff to drop + re-add Batch 3's `Listing_status_check_*` constraint (additive in effect — do not halt on it).
- **R4 Takedown:** Batch 3 `takeDownListingAction` = atomic `updateAll({status:"removed"})` where status ∈ {approved, hidden, pending}; 0 rows → `LISTING_NOT_TAKEDOWN_ELIGIBLE`. Never writes rejected/rejectionReason; the reason lives in ModerationAction as a typed code. Delete Batch 3 text about "content-edit → pending → re-approval" recovery and the `rejected` rationale.
- **R5 Seller-side lock:** Batch 3 defines `MODERATION_LOCKED_LISTING_STATUSES = ["removed"]` in `src/lib/moderation.ts` and adds guards (typed error) to `updateListingAction`, `toggleListingVisibilityAction`, `deleteListingAction` with tests. Batch 4 Task 4 rewire keeps these guards and adds the same check to `saveListingDraftAction` and `submitListingAction`; Batch 4 publication-gate suite asserts it. `approveListingAction`/`rejectListingAction` stay pending-only, so removed never re-enters via review. Restoring a removed listing = Batch 3 A4 (appeal outcome), not built.
- **R6 Gate extension:** Batch 3 may extend only `src/lib/seller-verification-policy.ts` (`account_not_suspended`); `assertListingPublishable` inherits it. Batch 4 C2 rewritten to allow requirement additions there while forbidding changes to the listing wrapper. Batch 4 Task 4 migrates Batch 3's suspension cases in `tests/unit/publication-gate.test.ts` to beta-category fixtures and keeps them.
- **R7 File order:** `tests/unit/publication-gate.test.ts`, `src/lib/seller-verification-policy.ts`, `src/lib/actions/listings.ts`, `src/lib/actions/admin.ts` are edited by Batch 3 first, then Batch 4 — add to both plans' file-conflict rules.
- **R8 Labels/audit:** Batch 3 adds `LISTING_STATUS_LABELS.removed` + badge in `src/lib/constants.ts`; Batch 4 Task 5 adds only `archived`. Audit names: Batch 3 `moderation.listing_taken_down`; Batch 4 `listing.draft_created|draft_updated|submitted|submit_blocked`.
- **R9 Fallback if Batch 4 must land first:** Batch 4 keeps owning `removed` + R5 guards and Batch 3 rebases per R3. Exactly one plan may contain `removed` in its contract diff.

## Rollback and Data Backfill

- **Migration** (`batch4_listing_quality`): additive-only, zero data transforms (verified via `npx prisma migration show` — the `Listing_status_check_*` DROP+ADD pair is expected and additive in effect, `pendingPlaceholders: false`). Rollback = `git revert` of the Task 1 commit **plus** restore from the pre-migration backup per `docs/backup-restore.md`; no down-migration is authored (the Prisma 8 graph is forward-only). Production applies via the compose `migrate` service `--to production` after the ref advance in Task 1.
- **No legacy backfill by design**: legacy rows keep `NULL` structured fields ("not captured"); no fabricated data (spec §8.3). Post-migration verification = Task 1 integration test + `npx prisma db verify`.
- **Beta catalog seed** (`scripts/seed-beta-catalog.ts`): dry-run default, `--apply` gated, idempotent (create-if-absent by slug — never reassigns an existing model's category/brand; the category slug is the literal `portable_bluetooth_speaker`, never through `slugify`). Rollback = delete the seeded `ProductModel`s by slug list, the `Soundcore` brand (if unused), and the `portable_bluetooth_speaker` category — exercised on the scratch DB in Task 7's integration test.
- **Upload cutover**: existing uploaded files are untouched on disk; they remain valid while attached to a listing (ownership rule (2)). New uploads are WebP re-encodes with ownership rows (row before file). No file rewrite of old uploads (that would be a destructive backfill); re-attaching a detached pre-Batch-4 upload is rejected — documented compat behavior. Orphaned-file retention is A8 (not invented).
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
npm audit --omit=dev               # sharp exact-pinned — sạch
npx prisma migration list          # graph: baseline → batch2 → batch3 → batch4 (tuyến tính — R3)
npx prisma db verify               # marker + schema khớp contract
git diff --check && git status --short
```

All green + the gate suites in Task 9 Step 1 + a clean diff/status audit = Batch 4 complete. Beta-launch readiness **additionally** requires the founder-authored content items in *Ambiguities* listed for the **Batch 8 Founder Decision Register** (FD-3: A1 condition definitions + condition/inventoryContext overlap, A2 checklist requiredness, A3 model list, A8 retention, A10 legacy-repurposing policy, A11 category taxonomy — plus FD-2's deferred production OTP provider from Batch 2 A1) — those are launch prerequisites, not Batch 4 gate failures (A9 is resolved by FD-1), and the verification doc must say so verbatim.
