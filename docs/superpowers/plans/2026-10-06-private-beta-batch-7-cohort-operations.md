# Private Beta Batch 7 — Private Beta Cohort and Founding Seller Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the private-beta cohort operations layer — an enumeration-safe, single-use, expiring, hashed-token founding-seller invitation flow bound to a verified contact channel; the founding-seller candidate lifecycle (prospect → invited → registered → … → active_founding_seller) with a ground-truth funnel sync behind an explicit audited action; the operations console (20–50 invited founding sellers, 100–300 quality listings as operational targets) with concierge tracking behind `beta_cohort.manage`; the buyer beta access policy (§2.1) enforced server-side on new conversation **and** Deal creation; and the Batch 5 forward-seam telemetry (`seller_invited`, `seller_registered`, `beta_membership_activated` on the acceptance path) — extending Batch 2's `BetaCohortMembership` model and `setBetaMembershipAction`, never redefining them, with no auto-membership for existing users (§8.4) and no finance surface touched.

**Architecture:** One additive Prisma 8 migration adds exactly two tables (`FoundingSellerCandidate`, `BetaInviteToken`), two enums (`founding_seller_candidate_status`, `beta_invite_channel`), and `User` relation declarations — `BetaCohortMembership`/`beta_cohort`/`beta_membership_status` stay Batch 2's, untouched. A server-only domain module (`src/lib/founding-sellers.ts`) owns the typed vocabularies (the ten §5.10 lifecycle states verbatim, the legal-transition table, the mechanical reason codes — all marked PROVISIONAL per FD-3) and the ground-truth funnel sync; a client-safe vocab module (`src/lib/founding-seller-vocab.ts`, Batch 3's `moderation-vocab.ts` precedent) carries the labels so client components never import the db-backed module. Invite tokens are 256-bit `crypto.randomBytes` values stored only as `HMAC-SHA256(token, hkdfKey("beta-invite-hash"))` — the exact Batch 2 `OtpCode.codeHash` pattern — consumed by an atomic claim **inside a transaction that throws typed sentinels and is classified outside** (the Batch 3/6 transaction rule), never logged, never in analytics. The token reaches the invitee's browser once, is immediately moved into a short-lived HttpOnly cookie (`/invite/[token]` GET → redirect `/invite`), and never rides in `next` or the accept form. Acceptance requires a session **and** a channel binding: the invite's normalized contact must equal the accepting **freshly-read** `User` row's email/phone **and** that channel must be verified (`emailVerifiedAt`/`phoneVerifiedAt`), so a leaked link cannot attach membership to an unrelated account. The buyer access gate is one server-owned constant + one guard function wired into `startConversationAction`'s create branch (after Batch 6's seller-eligibility guard) and into `createDealAction` (buyer-only per Batch 6 D11); the console renders masked contact references only (§4.8/§7.6 minimization) and fails closed on every Scoped/Exceptional RBAC cell (Batch 2 A2).

**Tech Stack:** Next.js 16.3.7 App Router (typed routes, server actions), React 19, TypeScript strict, Prisma 8 (`@prisma/orm-postgres` rc, contract + migration graph), PostgreSQL ≥ 15 (scratch container via `scripts/test-integration.sh`), Vitest (unit + scratch-container integration), zod, `node:crypto` (token generation + the Batch 2 `hkdfKey` HMAC helper), lucide-react. **No new runtime dependency** (Batch 7 adds zero npm packages).

**Spec:** `docs/superpowers/specs/2026-10-06-private-beta-marketplace-reset-design.md` — Batch 7 is spec §9 "Batch 7", built on §2.1 (Private Beta Access Model: public visitor / registered user without membership / founding seller / internal users / authorization invariant), §4.5 (backend authorization), §4.6 (auditability), §4.8 (analytics privacy), §4.9 (private-beta authorization), §4.11 (policy non-invention), §5.3.3 (Seller Verification Policy v1), §5.4/§5.4.1 (RBAC, `beta_cohort.manage`), §5.8/§5.8.1/§5.8.2 (cohort telemetry, metric contracts, dashboard), §5.9.1 (cold-start markets), §5.10/§5.10.1 (Founding Seller Operations, Concierge Onboarding), §7.1 (rate limits — "beta invite acceptance" is a named endpoint), §7.3 (authorization abuse), §7.8 (moderation enforcement), §8.4 (Beta Cohort migration — existing users do **not** automatically become founding sellers), §9 Batch 7 deliverables + Gate, §10/§10.1 (verification + abuse matrix), §11/§11.1 (execution protocol + ambiguity stop rule), §12/§12.1 (readiness + Supply Readiness Gate). The plan argues from the spec; executors read both.

**Builds on (consumed verbatim; never redefined):** `docs/superpowers/plans/2026-10-06-private-beta-batch-2-identity-security.md` (Task 10 `BetaCohortMembership` model + `setBetaMembershipAction` + publication gate + **the 34-unit province registry `src/lib/provinces.ts` per FD-1**; Task 11 admin roles), the merged Batch 3 (`…batch-3-trust-safety.md` @ `68f8778` — actor-side chat guards, the transaction constraint-violation rule), Batch 4 (`…batch-4-listing-quality.md` @ `c7ca1dc`), Batch 5 (`…batch-5-search-telemetry.md` @ `6cf60c8` — `emitProductEvent`, `seller_invited`/`seller_registered` forward seams, dashboard), and **the committed Batch 6** (`…batch-6-chat-deal.md` @ `88d7c2d` — chat hardening, `assertListingSellerInteractable` (D2), `createDealAction`/`markDealOutcomeAction` in `src/lib/actions/deals.ts` (D10/D11), the B1 fixture-migration pattern). Standing founder rulings: `/tmp/loaviet/founder-decisions.md` (FD-1/FD-2/FD-3) + `/tmp/loaviet/provinces-34.md`.

## Batch 7 Sequencing Rules

*Equivalent of `/tmp/loaviet/b34-reconcile.md` (R1–R9) and `/tmp/loaviet/b5-seq.md` (S1–S11); adopted by this plan:*

- **T1 Order:** Batch 7 executes only on the merged Batch 6 commit (`88d7c2d`'s plan is committed; its implementation lands per its own plan), after the Batch 2 → 3 → 4 → 5 → 6 gates pass in order (spec §9: "Do not advance to the next batch until the current gate passes"). Parallel planning ok; parallel execution not.
- **T2 Migration graph:** before Task 1, confirm `migrations/app/refs/db.json` + `refs/production.json` hash **equals Batch 6's migration `to` hash**; plan with `--from <batch6-migration-dir>` if the CLI requires an explicit origin; `npx prisma migration list` must show exactly `baseline → batch2 → batch3 → batch4 → batch5 → batch6 → batch7` with no node holding two outgoing edges. A package authored on a stale base: delete the uncommitted package + snapshot, re-emit, re-plan — **never hand-merge `ops.json`/`contract.json`**. Batch 7 adds no `listing_status` value, so no `Listing_status_check_*` drop+re-add is expected — **halt on any destructive op**.
- **T3 Schema/enum ownership:** `BetaCohortMembership` + `beta_cohort` + `beta_membership_status` belong to **Batch 2** — Batch 7 only adds rows through them. Batch 3 owns `listing_status.removed` + `UserSuspension`; Batch 4 owns `archived` + the structured listing columns; Batch 5 owns `ProductEvent`/`SearchAlias`/`Listing.locationSource`/`searchTextNormalized`; Batch 6 owns `Deal`/`DealStatusHistory` + `deal_*` enums. **Batch 7 adds ONLY:** models `FoundingSellerCandidate`, `BetaInviteToken`; enums `founding_seller_candidate_status`, `beta_invite_channel`; `User` relation declarations (`foundingSellerCandidate`, `betaInvitesIssuedBy`, `foundingCandidatesAssigned` — see Task 1). No `listing_status` values, no `ProductEvent` columns, no `Deal` columns, no `BetaCohortMembership` column changes. Exactly one plan may contain each new table/enum in its contract diff.
- **T4 File order (files earlier batches own; Batch 7 edits on top of the merged Batch 6 commit, keeping every earlier guard):**
  - `src/lib/actions/chat.ts` — B2 (session) → B3 (actor-side guards) → B5 Task 8 (`conversation_started` emission) → B6 Task 3 (hardening: rate limit + `assertListingStartable` + `assertListingSellerInteractable` on the create branch) → **B7 Task 6** (buyer beta access guard, on the create branch after Batch 6's seller-eligibility guard, before `Conversation.create`; never touching the emission or the redirect branch).
  - `src/lib/actions/deals.ts` — **B6 Tasks 4/5 (single owner until now) → B7 Task 6** (add `assertBuyerBetaChatAccess(user.id)` to `createDealAction` after `assertListingSellerInteractable`, before `requireDealConversation`; `markDealOutcomeAction` stays **ungated** by the beta policy — Batch 6 D10/D2 keep outcome marking on actor suspension + block only).
  - `app/admin/layout.tsx` — B2 Task 9 → B3 Task 6 → B5 Task 10 → **B7 Task 5** (append `Beta cohort` nav entry, keep `capabilitiesOf` filtering).
  - `app/admin/users/page.tsx` — B2 Task 10 → B3 Task 5 → **B7 Task 5** (append a `Beta cohort` link per user; keep every existing column/form).
  - `src/lib/constants.ts` — B3/B4/B5/B6 label maps → **B7 Task 4** appends only `FOUNDING_SELLER_STATUS_BADGE` (the status *labels* live in `founding-seller-vocab.ts`, Task 2).
  - `next.config.ts` — B4 Task 3 (the `/uploads` headers block) → **B7 Task 3** (append a `/invite/:path*` `Referrer-Policy: no-referrer` block; Batch 4's block untouched).
  - `src/lib/actions/beta-cohort.ts` — B2 Task 10 → B5 Task 8 (`beta_membership_activated` emission) → **B7: read-only consumption** (`setBetaMembershipAction` is NOT edited; the invitation path lives in its own file).
  - `src/lib/provinces.ts` — **Batch 2 Task 10's** plain module (FD-1: the 34-unit registry per NQ 202/2025/QH15; `PROVINCES`, `PROVINCE_CODES` code→displayName, `isProvinceCode`, `resolveLegacyProvince`) — consumed **read-only** by Batch 7 (`isProvinceCode` for validation, `PROVINCE_CODES[code]` for display; slug codes like `ha-noi`/`ho-chi-minh`, never numeric).
  - `src/lib/seller-verification-policy.ts`, `src/lib/rbac.ts`, `src/lib/audit-event.ts`, `src/lib/session.ts`, `src/lib/otp.ts`, `src/lib/product-events.ts`, `src/lib/telemetry-recorders.ts`, `src/lib/metrics.ts`, `src/lib/moderation.ts` — Batch 2/3/5 interfaces, **consumed read-only by Batch 7; never edited in a Batch 7 commit.**
  - **Chat/Deal fixture test files (the Batch-6 B1 pattern, applied by Batch 7 — see Global Constraints):** `tests/unit/chat-guard.test.ts`, `tests/unit/chat-hardening.test.ts`, `tests/unit/telemetry-wiring.test.ts`, `tests/unit/deal-create.test.ts`, `tests/integration/block-enforcement.test.ts`, `tests/integration/suspension-enforcement.test.ts`, `tests/integration/chat-hardening.test.ts`, `tests/integration/deal-lifecycle.test.ts` — each edited **exactly once**, by the Task 6 commit (buyer fixtures gain an active membership; no assertion weakened).
  - `src/prisma/contract.prisma` is Task 1 only. Everything else Batch 7 touches is single-owner (new files).
- **T5 Telemetry seams Batch 7 wires (S7 forward seams):** `seller_invited` (Task 3, at invite issuance — actor null, the prospect has no account yet), `seller_registered` (Task 3, at invite acceptance — actor = the accepting user), `beta_membership_activated` (Task 3, on the acceptance path — **only when the transaction reports `activated: true`**, Batch 5 S7 semantics: emit only on a transition to active; Batch 5 already wired it into Batch 2's `setBetaMembershipAction`). **Seller activation metrics** (`seller_first_listing_published`, `seller_verified`) are already wired by Batches 4/5 — Batch 7 consumes them read-only (Task 5 console) and re-runs their suites. Batch 7 writes **no** `AuditEvent` action name that Batch 2/3/4/5/6 already registered, and no `ProductEvent` outside the taxonomy (S10).
- **T6 Buyer access vs Batch 6 (resolved — Batch 6 is committed):** the §2.1 buyer-membership gate is Batch 7's (spec §9 Batch 7 "buyer beta access policy"; Batch 6 A2 explicitly left buyer-side gating to Batch 7). It lands in **two** places: `startConversationAction`'s create branch (after Batch 6's seller-eligibility guard) and `createDealAction` (the actor is the buyer per Batch 6 D11). **Outcome marking stays ungated** by the beta policy — Batch 6 D10/D2 already define marking's guards (actor suspension + block; ongoing deal participation is not gated on membership), and Batch 7 adds nothing there.
- **T7 Fallback if Batch 6's implementation is delayed:** nothing in Tasks 1–5 depends on Batch 6's *code* (the console, invitation, lifecycle, and telemetry surfaces do not touch chat or Deal) — only the merged Batch 6 **commit** is required by T1/T2 (the migration graph and the `deals.ts`/`chat.ts` files). If Batch 7 must ever land first, Task 6 rebases per T2/T4 after Batch 6 merges; the two guard insertion points (create branch of `startConversationAction`; `createDealAction` after `assertListingSellerInteractable`) are the only contracts.

## Global Constraints

- Read `AGENTS.md` and the relevant Next.js 16 docs before editing app code. At minimum (paths as used by the Batch 0–6 plans): `node_modules/next/dist/docs/01-app/02-guides/server-actions.md`, `.../01-app/01-getting-started/15-route-handlers.md`, `.../01-app/02-guides/environment-variables.md`, `.../01-app/02-guides/redirecting.md`, `.../01-app/02-guides/testing/vitest.md`, plus the current `cookies()`/`headers()`/`useActionState` API-reference guides under `node_modules/next/dist/docs/`. Heed deprecation notices; this is not the Next.js from training data.
- **Server-action hygiene (Next 16):** a `"use server"` module may export **only async functions** (compiler error E352 otherwise) — no `export const` constants/schemas in `src/lib/actions/*.ts`; constants/schemas/transition tables live in plain modules (`src/lib/founding-sellers.ts`, `src/lib/founding-seller-vocab.ts`). `redirect()` **must never be called inside a `catch` block** — capture the typed error, audit, then `return redirect(...)` outside the `try`. **No non-async exports from `"use server"` files; no `server-only`/db imports in client components or `tsx` scripts** — the console forms (`"use client"`) import only `founding-seller-vocab.ts`, `constants.ts`, and the actions.
- **Quote bracketed paths in every `git add`** — zsh globs `[id]`/`[slug]`/`[token]` as a character class and drops the file from the command (Batch 3/5/6 constraint, kept verbatim). Every `git add` below already quotes them (`'app/invite/[token]/page.tsx'`); keep that form in every commit.
- Prisma 8 contract/migration workflow (`.agents/skills/prisma-8/references/contract.md` + `migrations.md` + `migration-model.md`): edit `src/prisma/contract.prisma` → `npx prisma contract emit` → `npx prisma migration plan --name <snake_slug>` (with `--from <batch6-migration-dir>` per T2) → fill any `placeholder(...)`/data-transform holes in the rendered `migration.ts` → self-emit with `node "$DIR/migration.ts"` → review with `npx prisma migration show "$DIR"` → `npx prisma db migrate --advance-ref db` → advance refs. Never `db update` against a shared/production database; never edit `ops.json`/`contract.json`/`contract.d.ts` by hand; commit contract artefacts + migration package together. Shell commands use quoted `"$DIR"`/`"$END_HASH"` variables, never bare `<dir>`/`<end-hash>` placeholders (zsh reads those as redirections). Batch 7 expects **zero data transforms** — `pendingPlaceholders` must be `false` (there is no legacy candidate/invite data; §8.4 forbids auto-membership backfill by construction).
- **Transaction constraint-violation rule (Postgres — copied from Batch 3 @ `68f8778`, Batch 6 S2).** A unique/constraint violation (SQLSTATE `23505`) **aborts the whole `db.transaction`** — Postgres answers any later statement in that tx with `ROLLBACK`, and the Prisma 8 tx context has no savepoints. **Catching a violation inside the callback and returning normally is a silent-success bug**: the wrapper tries to COMMIT an aborted tx, Postgres rolls it back, and the action reports success with nothing persisted (in `acceptInviteAction` that would burn the token's `consumedAt` claim with **no membership created**). Therefore: (1) on any constraint violation or typed failure, **always throw out of the callback** (a typed sentinel error — never a bare `return`); (2) **classify OUTSIDE the transaction** — catch `SqlQueryError`, branch on `sqlState === "23505"` + the constraint-name prefix (`beta_invite_one_active` / `FoundingSellerCandidate_userId_key` / `BetaCohortMembership_userId_cohort_key` / `BetaInviteToken_tokenHash_key`); (3) map the violation to the typed error (`INVITE_ALREADY_ISSUED` / `INVITE_INVALID`); (4) **re-read the guarded row INSIDE the tx** (the token, the candidate, the membership) — never trust a pre-transaction read for a claim; (5) **rethrow every non-`23505` error** (fail closed — never blanket-map). Pinned by the no-silent-success unit + integration tests in Task 3.
- **Canonical test stubbing** (one recipe, every unit AND integration test that imports an action/page — Batch 3/6's canonical recipe): `vi.mock("server-only", () => ({}))`; `vi.mock("next/cache", () => ({ revalidatePath: () => {} }))`; `vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(\`NEXT_REDIRECT:${url}\`); }, notFound: () => { throw new Error("NEXT_HTTP_ERROR_FALLBACK;404") } }))`; `vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }) }))`; a partial `vi.mock("@/src/lib/auth")` whose `requireUser`/`getCurrentUser` return a fixture `SessionUser` (role-stubbed per test; in integration tests the fixture user is a real scratch-DB row); `vi.mock("@/src/lib/rbac")` with `requireCapability`/`requireCapabilityWithStepUp` returning a fixture `AdminContext` (or throwing `Error("FORBIDDEN")`/`Error("STEP_UP_REQUIRED")` per case). Unit tests additionally mock `@/src/prisma/db.client` with in-memory model maps (the `tests/unit/financial-shutdown-actions.test.ts` style) + `resetRateLimits()` in `beforeEach`; integration tests keep the real db (same `hasDb` guard pattern as `tests/integration/escrow.test.ts`) and **set `AUTH_SECRET` + `PRODUCT_EVENT_PSEUDONYM_KEY` test values in their `beforeAll`** (the `hkdfKey` HMAC and the Batch 5 pseudonym key are both required by the emission paths — the Batch 6 S6 pattern).
- **Additive-only schema (T3).** No drop, rename, or repurpose of any existing column/table/enum value. `User.role`, `User.isVerifiedSeller`, `BetaCohortMembership`, every finance model, Batch 3's moderation tables, Batch 4's listing columns, Batch 5's telemetry tables, and Batch 6's Deal tables stay exactly as their owning batches shipped them. All new columns are nullable or defaulted.
- **Preserve Batch 1.** `FINANCIAL_FEATURES_ENABLED` stays `false`; every existing finance guard and its tests (`tests/unit/financial-shutdown-*.test.ts`, `tests/unit/finance-public-surface.test.ts`, `tests/unit/admin-finance-readonly.test.ts`, `tests/unit/mock-payment-guard.test.ts`, `tests/integration/escrow.test.ts`) must stay green unchanged. No Batch 7 task may enable, bypass, or weaken a finance boundary; Batch 7 touches no finance model, route, action, cron, or webhook.
- **Preserve Batch 2–6 — with the one permitted fixture migration.** Every earlier suite stays green **except** the chat/Deal fixtures the buyer gate necessarily changes (a non-member buyer can no longer create a conversation or a Deal through the actions): **the only permitted edits to earlier-batch test files are the Task 6 fixture migration** (the Batch 6 B1 pattern) — `tests/unit/chat-guard.test.ts`, `tests/unit/chat-hardening.test.ts`, `tests/unit/telemetry-wiring.test.ts`, `tests/unit/deal-create.test.ts`, `tests/integration/block-enforcement.test.ts`, `tests/integration/suspension-enforcement.test.ts`, `tests/integration/chat-hardening.test.ts`, `tests/integration/deal-lifecycle.test.ts`: every fixture that creates a conversation/Deal through `startConversationAction`/`createDealAction` gains an **active buyer membership** (`private_beta_buyer` — or `founding_seller`/`internal`) for the acting buyer, and the Batch 6 verified-seller shape where the action path already requires it; **no assertion is weakened**; the migration is recorded in the verification doc. The pure metrics suites (`metrics-reconciliation`, `metric-contracts`) consume event literals and are unaffected. `src/lib/rbac.ts` is touched by **exactly zero** Batch 7 commits — `beta_cohort.manage` already exists in Batch 2's matrix (super_admin + operations_admin ✓); Batch 7 adds no capability, no role, no matrix cell (spec §4.11: administrator permissions are not implementation territory).
- **Backend authorization only** (spec §4.5, §4.9). Every console action and page checks `requireCapability("beta_cohort.manage")` server-side; the invitation acceptance checks `requireUser()`; nav filtering and hidden forms are convenience. A moderator's missing `beta_cohort.manage` must fail in the action even if the form was never rendered.
- **No step-up invention.** `beta_cohort.manage` is **not** in Batch 2's `STEP_UP_CAPABILITIES` (`["pii.view_sensitive", "admin.role_manage", "security.config", "seller.verify", "seller.verification.revoke"]` + Batch 3's `"user.suspend"`) and spec §5.4.2's step-up list does not name cohort management — Batch 7 actions use plain `requireCapability("beta_cohort.manage")`. Adding step-up would be inventing administrator-permission semantics (§4.11).
- **Fail closed on undefined RBAC cells** (Batch 2 A2, spec §5.4.1). The console renders **masked** contact references only; there is no "reveal full PII" action (that is the `pii.view_sensitive` Scoped/Step-up cell — undefined for operations_admin until the founder defines it — Ambiguities A2). No `pii.export` surface exists.
- **Policy Non-Invention (spec §4.11 + §11.1 + FD-3).** Do not invent: invitation copy beyond the neutral mechanics below; legal acceptance text (Batch 8 records the review; Batch 2's `PolicyAcceptance` recording mechanism is reused as-is); founding-seller incentives/rewards (§2 P0 excludes referral rewards; nothing ships); SLAs beyond the spec; the "quality listing" definition (Batch 4 A1/A2 are themselves founder-gated — Batch 5 A5 already recorded the term as undefined); moderation sanction semantics for membership suspension. Per **FD-3** (`/tmp/loaviet/founder-decisions.md`): on material ambiguity, **proceed with the fail-closed default already chosen in this plan** — do not stop the task waiting for founder input; items that need founder-**authored content** ship as clearly-marked PROVISIONAL/pending mechanisms and are listed in the **Batch 8 Founder Decision Register** as launch blockers — never invented. The plan's *Ambiguities* section lists the known ones with their fail-closed defaults and the Batch 8 register hand-off.
- **No auto-membership (spec §8.4).** Existing users do **not** automatically become founding sellers. There is **no backfill** — no migration data transform, no seed script granting memberships. Membership arises only through: invitation acceptance (this batch — the second, **audited** membership writer beside Batch 2's `setBetaMembershipAction`), Batch 2's `setBetaMembershipAction` (admin operation), or a future reviewed seed/explicit migration. The Task 1 integration test pins that a freshly created user gains nothing.
- **Invite-token secrecy (spec §4.8 + §5.3 OTP posture).** Tokens are 256-bit random, stored **only** as a keyed HMAC (`hkdfKey("beta-invite-hash")` — the Batch 2 helper), single-use (atomic `consumedAt` claim), expiring, revocable, rate-limited at acceptance (spec §7.1 names "beta invite acceptance"), and **never written to logs, analytics, or `captureEvent`/`captureError` payloads in any environment** — the rejection/error paths carry typed codes only. **Honest claim about the URL (S1):** the raw token necessarily appears in the `/invite/<token>` URL on the invitee's **first GET** — that one request is recorded in the invitee's browser history and the nginx access log (a residual risk, recorded in the verification doc and the Batch 8 register). The containment: the first GET immediately moves the token into a short-lived **HttpOnly cookie** and redirects to `/invite` (the token never appears in the accept form, in any `next` param, or in any subsequent URL), `/invite/*` sends `Referrer-Policy: no-referrer` (next.config.ts), and the platform never emails/SMSes the link (there is no production provider — FD-2/Batch 2 A1 — the operator delivers it out-of-band, which is the §5.10.1 concierge reality). The raw token is rendered to the issuing operator exactly **once** (the absolute invite URL at issuance, `NEXT_PUBLIC_APP_URL`-prefixed).
- **PII minimization in console and telemetry** (spec §4.8 + §7.6). `contactReference` (email/phone) is stored for the invite binding but rendered **masked** (`maskContact()`); it never enters `ProductEvent` (the §4.8 denylist forbids raw email/phone — Batch 5's PII guard rejects it at write time anyway); it never enters `AuditEvent.detail` verbatim (typed codes + ids only, `redactDetail` convention); console notes pass through `redactDetail` at write time (Batch 3's belt-and-braces). Console pages render untrusted content (notes) as React text only — no `dangerouslySetInnerHTML`.
- **Audit append-only** (spec §4.6). Every privileged Batch 7 action appends an `AuditEvent` (actor, action, resource, reason, timestamp, session, ipHash) through Batch 2's `auditEvent`/`auditEventTx`; nothing updates or deletes one. Batch 7's audit action registry is disjoint from every earlier batch's: `founding_seller.candidate_created`, `founding_seller.invite_issued`, `founding_seller.invite_revoked`, `founding_seller.invite_accepted`, `founding_seller.status_changed`, `founding_seller.funnel_synced`, `founding_seller.operator_assigned`, `founding_seller.contact_recorded`, `founding_seller.notes_updated`, `founding_seller.quality_count_set`. **Membership suspension/reactivation is not a new audit path** — the console links to `/admin/users`, where Batch 2's `setBetaMembershipAction` (auditing `beta_cohort.membership_set`) already lives; Batch 7 adds no second membership-mutation surface (Task 5 pins this by source scan).
- **Telemetry domain separation** (S10). Batch 7 emits `ProductEvent`s only through Batch 5's `emitProductEvent` (per-event zod schema, PII guard, dedicated-key pseudonyms); it never writes `AuditEvent` for product events and never emits a name outside the Batch 5 taxonomy. `seller_invited`/`seller_registered`/`beta_membership_activated` are the only three Batch 7 wires (T5).
- **Location neutrality** (spec §4.7 + §5.9.1 + FD-1). `targetCommunity` uses canonical **slug** province codes from **Batch 2 Task 10's `src/lib/provinces.ts`** (FD-1: the 34 units per NQ 202/2025/QH15 — `PROVINCE_CODES` maps code→displayName, `isProvinceCode` validates; the obsolete 63-province numeric list is gone); console copy uses operational labels only (`Khu vực beta trọng điểm` — never `Khu vực an toàn`); no location is described as safe/guaranteed/verified; location alone is never a trust signal.
- **No money path, no misleading promise** (spec §4.1, §4.2). No Batch 7 copy claims payment/delivery/authenticity/condition/meetup guarantees; the console and invite pages use neutral copy only. No incentive/reward/commission language (§2 P0 excludes referral rewards; §4.11 forbids inventing incentives).
- OpenCode must not push, merge, deploy, or destructively clean the repository. Commit each task separately with the listed message; never `git add .`. Exclude from commits: `.claude/settings.json`, `public/uploads/`, secrets, local scratch data, unrelated work.
- Browser E2E: the repo has no E2E infrastructure (recorded since Batch 2). Batch 7 again covers its critical flows (invite issue → accept → membership active → publication allowed) with action-level unit tests + real-DB integration tests, and records browser E2E as a tracked pre-invite prerequisite (spec §10, §12).

## Batch 7 Scope Decisions

In scope (spec §9 Batch 7 deliverables, each mapped to its task):

1. **BetaCohortMembership — extension only.** The model, its enums, and `setBetaMembershipAction` are Batch 2's (Task 10); Batch 5 wired `beta_membership_activated` into the grant action. Batch 7 adds the **invitation flow** that ends in a membership row (Task 3 — the second, audited membership writer), the **lifecycle/console/concierge** surfaces around it (Tasks 4–5), and the **suspension enforcement proof** that the Batch 2/3/6 gates hold for suspended memberships on every gated surface (Task 7). Nothing redefines the model or the action.
2. **Invitation flow** (Task 3): candidate creation → invite issuance (single-use, expiring, unguessable, HMAC-hashed token bound to a normalized email/phone `contactReference`) → out-of-band delivery by the operator (the absolute URL is shown once at issuance) → the cookie-carrying invite pages → acceptance (session + channel binding: matching **and verified** email/phone, read from a **fresh `User` row**) → membership `active` + candidate `registered`. Revocation, re-issue, issuance/acceptance rate limits, enumeration-safe failure modes, atomic single-use claim, transaction-sentinel semantics.
3. **Founding seller lifecycle** (Task 4): the ten §5.10 states verbatim as `founding_seller_candidate_status`; a legal-transition table; automatic transitions at invite/acceptance; a ground-truth funnel sync (`registered → verification_pending → verified → first_listing`) that reads `SellerVerification` + approved-listing existence and **only advances** — run at acceptance and behind an **explicit audited operator action** (never during a page render); manual operator transitions (`concierge_onboarding`, `active_founding_seller`, `inactive`, `exited`) with typed reason codes; operator assignment; contact recording (`lastContactAt`); notes.
4. **Founding seller console** (Task 5): `/admin/beta-cohort` behind `beta_cohort.manage` — the §5.10 display list (total candidates, invited, registered, verification state, first-listing state, quality listing count, last seller activity, seller needing assistance, assigned operator, onboarding notes) + the supply-readiness operational targets (20–50 invited founding sellers, 100–300 quality listings — shown as **reference targets with live counts**, never hard-coded gates; spec §2.7/§9 give them as operational targets, and §12.1 makes broader buyer invitations a founder approval, not a code gate). **No write during render** — the page derives its view model from live reads; the funnel sync is the audited action.
5. **Concierge tracking** (Tasks 4–5): `concierge_onboarding` state, `assignedOperatorId`, `lastContactAt`, notes, and the §5.10.1 responsibility split rendered as console guidance — operations may assist with model selection/structured fields/photo checklist/formatting/migration, must **not** silently fabricate seller claims, and the seller retains responsibility for price/condition/defects/repair history/ownership/product claims/publication consent. No concierge *editing* surface for listing content ships (the seller's own flow is the only writer — Batch 4's actions; concierge assistance is human work tracked here, not a proxy-edit feature).
6. **Seller activation tracking** (Tasks 3, 5): `seller_invited`/`seller_registered` emission (Batch 5 forward seams — T5) + the console's activation view consuming Batch 5's already-wired `seller_verified`/`seller_first_listing_published` events and the §12.3 supply funnel counts.
7. **Buyer beta access policy** (Task 6): the §2.1 rule — new buyer→seller conversation creation restricted to active beta participants — as a server-owned constant + guard, wired into `startConversationAction`'s create branch (after every Batch 3/6 guard) **and into `createDealAction`** (the actor is the buyer, Batch 6 D11); outcome marking stays ungated (Batch 6 D10). Browsing stays public (§2.1 public visitor + registered-user rights are unchanged — Batch 7 adds no browse restriction); messages within an existing conversation stay governed by Batch 3/6 guards (the §2.1 restriction is on **new conversation creation**).

Explicitly deferred (do not build here): buyer invitation flow (§12.1 gates *broader private-beta buyer invitations* on supply readiness + founder approval — buyer memberships are granted through Batch 2's `setBetaMembershipAction` admin operation per §8.4, via `/admin/users`; the token mechanism is founding-seller-shaped and a buyer variant is a later additive extension); any "quality listing" computation (A3); invitation email/SMS delivery (A1 — no production provider exists per FD-2; the operator delivers out-of-band); incentives/rewards for founding sellers (§4.11 — none exist in the spec); SLAs (none in the spec); any change to seller verification semantics (Batch 2 owns them); account deletion; retention automation.

## Legacy Migration Decisions (additive, spec §8.4 + §8.6)

- **No backfill, by design.** There is no legacy candidate/invite/cohort-operations data, and §8.4 **forbids** auto-membership: existing users do not become founding sellers through any migration. The §8.6 backfill requirements are satisfied trivially — dry-run = "0 rows", no `--apply` path exists, nothing to roll back; the Task 1 integration test pins that a freshly created user row gains **zero** `BetaCohortMembership` rows (a delta assertion, not a global count — the scratch DB is shared across the suite's test order).
- **No existing column/table/enum value is touched.** `BetaCohortMembership` gains no columns (its Batch 2 shape — `invitedBy`, `invitedAt`, `acceptedAt`, `expiresAt`, `notes` — already carries everything the invitation flow writes). `User` gains relation declarations only. `FoundingSellerCandidate`/`BetaInviteToken` are new tables.
- **`BetaInviteToken` is invite-flow state, not a credential.** It references the candidate (not `User` — the prospect has no account), stores the HMAC of the raw token, the normalized bound channel, and lifecycle timestamps. A token row is never deleted by product flows (revocation is a flag, consumption is a timestamp) — the audit trail survives. `issuedById` is nullable + `SetNull` (the Batch 3 `UserSuspension.suspendedBy` precedent — the row survives a future admin deletion).
- No finance table, historical record, or legacy column is dropped or repurposed.

## Dependency and Parallelization Map

```text
(T1: Batches 2→3→4→5→6 đã merge + pass gate TRƯỚC khi Batch 7 bắt đầu — mọi task chạy trên commit Batch 6)
Task 1  contract + migration (FoundingSellerCandidate, BetaInviteToken, 2 enums, User relations)
        ↓ (schema is the base commit for everything)
Task 2  founding-seller domain module (vocabularies, transition table, funnel sync, maskContact)
        ↓
Task 3  invitation flow (candidate + invite + accept actions, invite pages, telemetry)
        ↓ (same file as Task 4 — sequential)
Task 4  lifecycle actions (manual transitions, funnel sync action, assign, contact, notes, quality count)
        ↓
Task 5  founding seller console (page + supply-readiness view + nav + users-page link)
        ↓
Task 6  buyer beta access policy (guard + chat + Deal wiring + earlier-batch fixture migration)
        ↓
Task 7  suspended-membership enforcement proof (publication/chat/Deal gates re-pinned for suspended memberships)
        ↓
Task 8  batch gate verification + verification doc
```

File-conflict rules (T4 order — every file below carries earlier-batch changes when Batch 7 starts; Batch 7 edits on top of the merged Batch 6 commit and keeps every earlier guard): `src/lib/actions/chat.ts` is Task 6's only edit (after B2→B3→B5→B6 — sequential in that order; the guard is inserted on the create branch after Batch 6's seller-eligibility guard and before `Conversation.create`, never touching the emission or the redirect branch). `src/lib/actions/deals.ts` is Task 6's only edit (after B6 Tasks 4/5 — the buyer guard in `createDealAction` only; `markDealOutcomeAction` untouched). `app/admin/layout.tsx` is Task 5's only edit (append nav, keep `capabilitiesOf` filtering). `app/admin/users/page.tsx` is Task 5's only edit (append link column). `src/lib/constants.ts` is Task 4's only edit (append the `FOUNDING_SELLER_STATUS_BADGE` map only). `next.config.ts` is Task 3's only edit (append the `/invite/:path*` referrer-policy block; Batch 4's `/uploads` block untouched). `src/lib/actions/beta-cohort.ts`, `src/lib/rbac.ts`, `src/lib/session.ts`, `src/lib/otp.ts`, `src/lib/audit-event.ts`, `src/lib/seller-verification-policy.ts`, `src/lib/product-events.ts`, `src/lib/telemetry-recorders.ts`, `src/lib/metrics.ts`, `src/lib/provinces.ts`, `src/lib/moderation.ts` — consumed **read-only**; never edited in a Batch 7 commit. `src/prisma/contract.prisma` is Task 1 only. `src/lib/founding-sellers.ts` + `src/lib/founding-seller-vocab.ts` are Task 2 creations, extended by no other task (Tasks 3–5 only *call* them). `src/lib/actions/founding-sellers.ts` is Task 3's creation, extended by Task 4 (manual transitions + the funnel sync action — sequential). `src/lib/beta-access.ts` is Task 6's creation. The eight earlier-batch chat/Deal fixture files (T4) are edited exactly once, by the Task 6 commit. Everything else is single-owner.

## Batch 6 Interface (committed @ `88d7c2d` — consumed verbatim; the earlier coordination points are resolved)

1. **C1 — chat guard order (RESOLVED).** Batch 6's `startConversationAction` create branch runs: `requireUser` → listing load → self-listing check → Batch 3's `assertCanStartConversation` → existing-conversation **redirect branch** (untouched, budget-free) → `checkRateLimit(chat:start)` → `assertListingStartable` (only `approved`) → `assertListingSellerInteractable` (D2: `SELLER_SUSPENDED`/`SELLER_NOT_VERIFIED`/`SELLER_MEMBERSHIP_INACTIVE`) → `Conversation.create` → the Batch 5 emission. **Batch 7's guard is inserted after `assertListingSellerInteractable`, before `Conversation.create`** — no duplicate beta-membership check exists on the seller side (Batch 6 D2 already owns it), so Batch 7 adds only the buyer-side check.
2. **C2 — Deal mutation (RESOLVED).** Spec §7.8 requires the backend to consider beta-membership status before **Deal mutation**. Batch 6's `createDealAction` (`src/lib/actions/deals.ts`) is **buyer-only** (D11 — the actor is the conversation's buyer), so Batch 7 adds `await assertBuyerBetaChatAccess(user.id)` there, after `assertListingSellerInteractable`, before `requireDealConversation`. **`markDealOutcomeAction` stays ungated by the beta policy** — Batch 6 D10/D2 already define marking's guards (actor suspension always; block only for `success`; ongoing deal participation is deliberately not gated on membership — blocking a member's confirmation would strand the bilateral record), and Batch 7 adds nothing there. The C2 outcome is recorded in the Batch 8 register (S9).
3. **C3 — `listing_marked_sold`.** Batch 6 owns the beta sold transition and its emission (S7). Batch 7's console "listing marked sold" context comes from Batch 5's dashboard; Batch 7 adds no sold-transition surface.
4. **C4 — migration base (RESOLVED).** Batch 6's plan is committed (`88d7c2d`); its implementation lands per its own plan, and T2 requires its merged commit.

## Review Focus

1. **Invite token plaintext leaking into logs/analytics/console re-display** — any path that prints the raw token (issuance response, error path, audit `detail`, `ProductEvent` metadata, a console "view invite link" column), in any environment (spec §4.8, §7.6). Pinned by Task 3: `tests/unit/founding-seller-invite.test.ts` "the persisted row stores an HMAC, never the token" + "inviteCandidateAction/acceptInviteAction never emit the token" (spy `console.log`/`console.error`/`captureError`/`emitProductEvent` payloads) + Task 5: "the console renders no stored invite token or URL" (source-contract).
2. **Membership attachable to the wrong account via a leaked/brute-forced invite link** — an attacker accepting someone else's invite (or a guessed token) and receiving founding-seller membership. Pinned by Task 3: `tests/unit/founding-seller-invite.test.ts` "acceptance with a mismatched account email → INVITE_CHANNEL_MISMATCH, no membership" + "matching but unverified email → INVITE_CHANNEL_UNVERIFIED, no membership" + "second acceptance of a consumed token → INVITE_INVALID" (atomic claim) + "a `suspended`/`exited` membership refuses BEFORE the claim (no consume)" + `tests/integration/founding-seller-invite.test.ts` real-DB end-to-end.
3. **Suspended-membership bypass through any gated surface** — a seller whose `founding_seller` membership is `suspended` still publishing (create/update/toggle/admin-approve), receiving new conversations/Deals on their listings, or appearing as an active participant. Pinned by Task 7: `tests/unit/suspended-membership-enforcement.test.ts` (all four publication surfaces + the Batch 6 seller-side chat/Deal guards + `isActiveBetaParticipant` false) + the Batch 2/3/6 suites re-run green (the gates read membership fresh from the DB — Task 7 only re-proves it).
4. **Console access without `beta_cohort.manage`** — a moderator/support/analyst (or a non-admin) reaching the console, its actions, or unmasked contact references. Pinned by Task 5: `tests/unit/beta-cohort-console.test.ts` (page source-contract guard + per-action FORBIDDEN matrix) + "contactReference renders masked, never full" + "no reveal action exists" (source scan).
5. **Auto-membership for existing users (§8.4 violation)** — any path that grants `founding_seller` membership without an invitation acceptance or an explicit admin operation: a migration transform, a seed, a "grant to all sellers" console action. Pinned by Task 1: `tests/integration/batch7-migration.test.ts` "a freshly created user gains zero memberships (delta)" + Task 3 "acceptance is the only membership-creating user path" + the source scan in Task 8 (`rg "BetaCohortMembership" scripts src/lib/actions src/prisma |` classify — only the acceptance path and Batch 2's action create rows).

---

## Task 1: Contract additions + Batch 7 migration

**Files:**

- Modify: `src/prisma/contract.prisma`
- Create: `migrations/app/<ts>_batch7_cohort_operations/` (rendered by `prisma migration plan`)
- Modify (emitted): `src/prisma/contract.json`, `src/prisma/contract.d.ts`
- Modify: `migrations/app/refs/db.json`, `migrations/app/refs/production.json` (ref advancement)
- Test: `tests/integration/batch7-migration.test.ts`

**Interfaces:**

- Consumes: existing `User`, `BetaCohortMembership` (Batch 2 — untouched), `SellerVerification` (Batch 2), `Listing` (Batch 4 columns), `Deal`/`DealStatusHistory` (Batch 6), finance models (untouched) — **on the merged Batch 6 commit** (T1/T2).
- Produces (used by every later task via `db.orm.public.<Model>`): models `FoundingSellerCandidate`, `BetaInviteToken`; enums `founding_seller_candidate_status`, `beta_invite_channel`; `User` relation declarations only (no new `User` columns).

- [ ] **Step 0: Confirm the Batch 6 base (T2)**

- `migrations/app/refs/db.json` and `refs/production.json` hash **equals Batch 6's migration `to` hash**; `npx prisma migration list` shows `baseline → batch2 → batch3 → batch4 → batch5 → batch6` with no node holding two outgoing edges. If not: stop — do not plan over a stale base (C4).
- Plan with the explicit origin if the CLI requires it: `B6_DIR="migrations/app/<ts>_batch6_chat_deal"` (paste the real rendered directory) then `npx prisma migration plan --name batch7_cohort_operations --from "$B6_DIR"` (per `.agents/skills/prisma-8/references/migration-model.md`). If a Batch 7 package was ever authored on a stale base: delete the uncommitted package + snapshot, re-emit, re-plan — **never hand-merge `ops.json`/`contract.json`**.

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/batch7-migration.test.ts` (runs only via `scripts/test-integration.sh`, scratch DB, same `hasDb` guard pattern as `tests/integration/escrow.test.ts`):

- `applies the batch 7 migration additively`: after the script's migrate step, `FoundingSellerCandidate` and `BetaInviteToken` each accept a create+read round-trip with the fields below; `FoundingSellerCandidate.status` accepts each of the ten §5.10 states (loop create+read); `BetaInviteToken.channel` accepts `email` and `phone`.
- `unique constraints hold (named for the classify rule — Global Constraints)`: a second `BetaInviteToken` with the same `tokenHash` throws (raw duplicate `create` — `BetaInviteToken_tokenHash_key`); a second **active** (non-consumed, non-revoked) token for the same candidate throws **while a consumed one coexists** (the partial unique index `beta_invite_one_active` — the re-invite race guard); a second `FoundingSellerCandidate` with the same non-null `userId` throws (`FoundingSellerCandidate_userId_key` — one candidate per linked seller; multiple NULL `userId` rows coexist — multiple prospects).
- `migration leaves the database consistent`: `npx prisma db verify` exits 0 after migrate.
- `preserves finance and earlier-batch tables`: `Order`, `Payment`, `Payout`, `WithdrawRequest`, `LedgerEntry`, `Dispute` still accept reads and a seeded `Order`+`Payment` row reads back unchanged; `BetaCohortMembership`, `SellerVerification`, `UserSession`, `AuditEvent` (Batch 2), `UserSuspension`, `ModerationCase` (Batch 3), `ListingImageUpload` (Batch 4), `ProductEvent`, `SearchAlias` (Batch 5), `Deal`, `DealStatusHistory` (Batch 6) each accept a create+read round-trip (proves Batch 7's migration did not disturb the earlier graphs).
- **`grants no auto-membership (§8.4 — delta assertion, not a global count)`**: create a fresh `User` via raw `db.orm.public.User.create`, then assert `BetaCohortMembership.where({ userId: thatUser.id }).count() === 0` and the user's `adminRole`/`sellerType` unchanged — no DB trigger, default, or transform auto-grants anything (Review Focus 5; the migration itself is pinned transform-free by `pendingPlaceholders: false` + the zero-`dataTransform` review in Step 4 — a global "table starts empty" count would depend on test order and is deliberately not asserted).

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:integration`
Expected: FAIL — `FoundingSellerCandidate`/`BetaInviteToken` not in contract.

- [ ] **Step 3: Edit the contract, emit, plan the migration**

Add to `src/prisma/contract.prisma` (match existing style: `// use prisma-8` header, `@@type("pg/text@1")` on enums, `TimestamptzString`, `temporal.updatedAtString()`, named relation strings):

```prisma
// ─── Enums (Batch 7 — cohort operations, spec §5.10) ───

enum founding_seller_candidate_status {
  @@type("pg/text@1")
  prospect              = "prospect"               // ứng viên chưa mời (spec §5.10)
  invited               = "invited"                // đã gửi lời mời
  registered            = "registered"             // đã nhận lời mời / có tài khoản
  verification_pending  = "verification_pending"   // đã gửi xác minh (sync từ SellerVerification)
  verified              = "verified"               // xác minh thành công (sync)
  concierge_onboarding  = "concierge_onboarding"   // CS đang hỗ trợ trực tiếp (ops state)
  first_listing         = "first_listing"          // tin đầu tiên đã publish (sync)
  active_founding_seller = "active_founding_seller" // ops đánh dấu sau chất-sample (§12.1)
  inactive              = "inactive"               // ops state
  exited                = "exited"                 // terminal
}

enum beta_invite_channel {
  @@type("pg/text@1")
  email = "email"
  phone = "phone"
}
```

Add to `User` (relation declarations only — additive, no new columns):

```prisma
  // ─── Batch 7 — cohort operations (spec §5.10) ───
  foundingSellerCandidate    FoundingSellerCandidate? @relation("founding_seller_candidate_user")
  betaInvitesIssuedBy        BetaInviteToken[]       @relation("beta_invite_issued_by")
  foundingCandidatesAssigned  FoundingSellerCandidate[] @relation("founding_seller_candidate_operator")
```

New models:

```prisma
// ─── Founding seller operations (Batch 7 — spec §5.10/§5.10.1) ───

model FoundingSellerCandidate {
  id                  String                          @id @default(uuid())
  userId              String?                          @unique // liên kết SAU khi nhận lời mời; null = prospect chưa có tài khoản (FoundingSellerCandidate_userId_key)
  user                User?                            @relation("founding_seller_candidate_user", fields: [userId], references: [id], onDelete: SetNull)
  contactReference    String?                          // email/phone ĐÃ CHUẨN HÓA — chỉ để bind invite; render console luôn MASK (§4.8/§7.6)
  contactChannel      beta_invite_channel?
  source              String                           // kênh tuyển nguồn — ops free text, render React text only
  targetCommunity      String                           // slug code tỉnh canonical (src/lib/provinces.ts — Batch 2 Task 10, FD-1) — KHÔNG bao giờ free text
  status              founding_seller_candidate_status @default(prospect)
  assignedOperatorId  String?
  assignedOperator    User?                            @relation("founding_seller_candidate_operator", fields: [assignedOperatorId], references: [id], onDelete: SetNull)
  invitedAt           TimestamptzString?
  registeredAt        TimestamptzString?
  verifiedAt          TimestamptzString?
  firstListingAt      TimestamptzString?
  qualityListingCount Int                              @default(0) // §12.2 — KHÔNG auto-compute (A3); ops cập nhật thủ công sau sample §12.1
  lastContactAt       TimestamptzString?
  notes               String?                          // ops free text — redactDetail trước khi lưu; KHÔNG PII thô
  createdAt            TimestamptzString              @default(now())
  updatedAt            temporal.updatedAtString()

  inviteTokens BetaInviteToken[]

  @@index([status, updatedAt])
  @@index([assignedOperatorId])
  @@index([targetCommunity])
}

// ─── Invitation tokens (Batch 7 — spec §9 Batch 7 "invitation flow"; §2.1 invited/acceptedAt) ───
// Token thô 256-bit KHÔNG bao giờ lưu — chỉ HMAC keyed (hkdfKey("beta-invite-hash"), cùng pattern
// OtpCode.codeHash của Batch 2). Single-use qua atomic consumedAt claim; revoke = flag; KHÔNG delete.

model BetaInviteToken {
  id            String             @id @default(uuid())
  candidateId   String
  candidate     FoundingSellerCandidate @relation(fields: [candidateId], references: [id])
  channel       beta_invite_channel
  target        String             // email/phone đã chuẩn hóa (normalizeEmail/normalizePhone của Batch 2) — bind kênh
  tokenHash     String             @unique // HMAC-SHA256(token, hkdfKey("beta-invite-hash")) hex (BetaInviteToken_tokenHash_key)
  issuedById     String?           // nullable + SetNull: row sống qua admin deletion (Batch 3 UserSuspension precedent)
  issuedBy      User?              @relation("beta_invite_issued_by", fields: [issuedById], references: [id], onDelete: SetNull)
  expiresAt     TimestamptzString
  consumedAt    TimestamptzString?
  revokedAt     TimestamptzString?
  createdAt     TimestamptzString @default(now())

  @@index([candidateId, createdAt])
  @@index([expiresAt])
  // MỘT token active (chưa consume, chưa revoke) duy nhất per candidate — đóng race re-invite;
  // token đã consume/revoke được GIỮ làm audit trail. where: là SQL string (Batch 6 Deal precedent).
  @@index([candidateId], where: "(\"consumedAt\" IS NULL AND \"revokedAt\" IS NULL)", unique: true, name: "beta_invite_one_active")
}
```

Then:

```bash
npx prisma contract emit
B6_DIR="migrations/app/<ts>_batch6_chat_deal"                    # dán thư mục Batch 6 THẬT trên đĩa
npx prisma migration plan --name batch7_cohort_operations --from "$B6_DIR"
```

- [ ] **Step 4: Review the package, self-emit**

- Define the directory variable first and use it everywhere below (never a bare `<dir>` — zsh reads it as a redirection):

```bash
DIR="migrations/app/<ts>_batch7_cohort_operations"              # thư mục do migration plan tạo — dán giá trị thật
npx prisma migration show "$DIR"
```

- Confirm the plan output's `from:` line names the current graph head (the post-Batch-6 hash that `migrations/app/refs/db.json` + `production.json` point to), not `(baseline)` over a non-empty graph, and `pendingPlaceholders` is `false` (all new columns are nullable/defaulted — a placeholder means an accidental non-null column; fix the contract instead). **No data transform is added** (§8.4 — there is no auto-membership backfill; Review Focus 5).
- `npx prisma migration show "$DIR"` — confirm **zero destructive operations** (additive-only; Batch 7 adds no `listing_status` value so no `Listing_status_check_*` re-render is expected — **halt on any destructive op**).
- Self-emit: `node "$DIR/migration.ts"` (regenerates `ops.json` + `migrationHash`); re-run `npx prisma migration show "$DIR"` — only `create`/`createIndex` operations (the partial unique index `beta_invite_one_active` appears as a `createIndex`).

- [ ] **Step 5: Apply to the dev DB and advance refs**

```bash
DIR="migrations/app/<ts>_batch7_cohort_operations"              # dán giá trị thật (biến đã định nghĩa ở Step 4)
END_HASH="$(node -p "require('./' + process.argv[1] + '/migration.json').to" "$DIR")"   # derive bằng lệnh — KHÔNG dán tay
npx prisma db migrate --advance-ref db                            # dev DB (DATABASE_URL từ .env, container 5435)
npx prisma migration ref set production "$END_HASH"               # docker-compose.prod.yml migrate service chạy --to production
npx prisma db verify
```

`production` ref must be advanced in the same commit (same rule as every earlier batch's Task 1).

- [ ] **Step 6: Run the integration test to verify it passes**

Run: `npm run test:integration`
Expected: PASS (all `batch7-migration` cases + existing `escrow.test.ts` + Batch 2–6 suites green).

- [ ] **Step 7: Commit**

```bash
git add src/prisma/contract.prisma src/prisma/contract.json src/prisma/contract.d.ts migrations/app migrations/snapshots tests/integration/batch7-migration.test.ts
git commit -m "feat(db): add batch 7 cohort operations contract"
```

**Gate:** no destructive op in `migration show`; `db verify` clean; finance + Batch 2–6 integration invariants still green; the §8.4 no-auto-membership delta case passes; graph stays linear (T2).

## Task 2: Founding-seller domain module — vocabularies, transition table, funnel sync, contact masking

**Files:**

- Create: `src/lib/founding-seller-vocab.ts` (client-safe — no db/`server-only` importers; Batch 3's `moderation-vocab.ts` precedent)
- Create: `src/lib/founding-sellers.ts` (server-only domain module — **no `"use server"`**; importable by actions, pages, and the console)
- Test: `tests/unit/founding-sellers.test.ts`

**Interfaces:**

- Consumes: `FoundingSellerCandidate`/`BetaInviteToken` models (Task 1), `SellerVerification` (Batch 2), `Listing` (Batch 4), `isProvinceCode`/`PROVINCE_CODES` (**Batch 2 Task 10's `src/lib/provinces.ts`** — FD-1), `db` from `@/src/prisma/db.client`.
- Produces (used by Tasks 3–7):

```ts
// src/lib/founding-seller-vocab.ts — PLAIN MODULE (client import được — labels cho console UI;
// KHÔNG import db/server-only). Batch 3 moderation-vocab.ts precedent.
// ── FD-3 PROVISIONAL: mọi vocabulary dưới đây là cơ học (không phải policy), đánh dấu PROVISIONAL
//    trong header module; founder mở rộng/sửa qua Batch 8 register — xem S9/Global Constraints. ──
export const FOUNDING_SELLER_CANDIDATE_STATUSES = [
  "prospect", "invited", "registered", "verification_pending", "verified",
  "concierge_onboarding", "first_listing", "active_founding_seller", "inactive", "exited",
] as const;  // spec §5.10 lifecycle — NGUYÊN VĂN, không thêm/bớt (§4.11 non-invention pin)
export type FoundingSellerCandidateStatus = (typeof FOUNDING_SELLER_CANDIDATE_STATUSES)[number];

export const FOUNDING_SELLER_STATUS_LABELS: Record<FoundingSellerCandidateStatus, string>;
//   prospect: "Tiềm năng", invited: "Đã mời", registered: "Đã tham gia",
//   verification_pending: "Chờ xác minh", verified: "Đã xác minh",
//   concierge_onboarding: "Đang hỗ trợ trực tiếp", first_listing: "Tin đầu tiên",
//   active_founding_seller: "Founding seller đang hoạt động", inactive: "Ngừng hoạt động",
//   exited: "Đã rời chương trình"

/** Lý do chuyển trạng thái CÓ KIỂU — vocabulary cơ học PROVISIONAL (không phải policy), founder mở rộng được. */
export const FOUNDING_SELLER_TRANSITION_REASONS = [
  "concierge_started",        // vào concierge_onboarding
  "quality_sample_passed",    // vào active_founding_seller (§12.1 manual sampling)
  "seller_unresponsive",      // vào inactive
  "seller_declined",          // vào inactive/exited
  "policy_review",            // vào exited
  "operator_correction",      // sửa sai thao tác
  "other_reviewed_reason",
] as const;
export type FoundingSellerTransitionReason = (typeof FOUNDING_SELLER_TRANSITION_REASONS)[number];

/** Bảng chuyển trạng thái hợp pháp (spec §5.10 lifecycle là chuỗi tuyến tính + 2 terminal ops states). PROVISIONAL. */
export const FOUNDING_SELLER_TRANSITIONS: Record<FoundingSellerCandidateStatus, readonly FoundingSellerCandidateStatus[]>;
//   prospect               → [invited, exited]
//   invited                → [registered, inactive, exited]
//   registered             → [verification_pending, inactive, exited]
//   verification_pending   → [verified, inactive, exited]
//   verified               → [concierge_onboarding, first_listing, inactive, exited]
//   concierge_onboarding   → [first_listing, inactive, exited]
//   first_listing          → [active_founding_seller, inactive, exited]
//   active_founding_seller → [inactive, exited]
//   inactive               → [exited]        // kích hoạt lại = founder policy — A5, KHÔNG phát minh
//   exited                 → []              // terminal
export function canTransitionCandidate(from: FoundingSellerCandidateStatus, to: FoundingSellerCandidateStatus): boolean;

/** Tập trạng thái operator ĐƯỢC PHÉP tự set (PROVISIONAL) — còn lại thuộc invite/sync, fail closed. */
export const MANUALLY_SETTABLE_STATUSES = [
  "concierge_onboarding", "active_founding_seller", "inactive", "exited",
] as const;
export type ManuallySettableStatus = (typeof MANUALLY_SETTABLE_STATUSES)[number];

export const FOUNDING_SELLER_NOTE_MAX_LENGTH = 4_000;   // PROVISIONAL cap
export const FOUNDING_SELLER_SOURCE_MAX_LENGTH = 200;   // PROVISIONAL cap
export const FOUNDING_SELLER_INVITE_TTL_DAYS = 14;      // tham số ops tunable — giá trị KHÔNG có trong spec (D1)
export const FOUNDING_SELLER_INVITE_RATE = { limit: 20, windowMs: 60 * 60_000 } as const;  // 20 invite/giờ/admin (§7.1) — PROVISIONAL
export const BETA_INVITE_ACCEPT_RATE = { limit: 10, windowMs: 10 * 60_000 } as const;    // 10 lần/10 phút (§7.1 "beta invite acceptance") — PROVISIONAL

/** Mask contact cho console (§4.8/§7.6 minimization) — "lienhe@example.com" → "l***@example.com",
 *  "0901234567" → "09*****67". KHÔNG bao giờ trả về giá trị đầy đủ. */
export function maskContact(channel: "email" | "phone" | null, value: string | null | undefined): string;
```

```ts
// src/lib/founding-sellers.ts — server-only domain module (import "server-only"; KHÔNG "use server").
import "server-only";

export * from "@/src/lib/founding-seller-vocab";

/** Sync trạng thái funnel từ GROUND TRUTH — chỉ TIẾN, không lùi (spec §5.10 lifecycle):
 *  registered → verification_pending (SellerVerification row tồn tại, status pending/needs_review)
 *  verification_pending → verified (SellerVerification.status = "verified") + verifiedAt
 *  verified/concierge_onboarding → first_listing (≥1 Listing status approved của seller) + firstListingAt
 *  Một update duy nhất: nhảy thẳng tới trạng thái furthest mà ground truth cho phép (không walk từng bước).
 *  SKIP hoàn toàn: inactive/exited/active_founding_seller (ops states — sync không bao giờ đụng).
 *  (concierge_onboarding KHÔNG skip: một listing đã publish là first_listing một cách khách quan —
 *   S4: ground truth thắng phase ops; operator chuyển tiếp từ đó.)
 *  Idempotent: chạy lại không đổi gì đã đúng. Trả về trạng thái sau sync; null khi user không phải
 *  ứng viên founding seller. CHỈ được gọi từ acceptInviteAction (sau link) và syncCandidateFunnelAction
 *  (audited) — KHÔNG BAO GIỜ từ page render (S5: render không ghi db). */
export async function syncFoundingSellerFunnel(userId: string): Promise<FoundingSellerCandidateStatus | null>;

/** Đếm listing ĐÃ DUYỆT của seller — factual count (KHÔNG phải "quality" — A3). */
export async function approvedListingCountOf(sellerId: string): Promise<number>;

/** Ứng viên cần hỗ trợ: status ∈ {invited, registered, verification_pending, verified, concierge_onboarding}
 *  && (lastContactAt IS NULL || lastContactAt < now - 7 ngày) — ngưỡng "cần hỗ trợ" là ops heuristic
 *  PROVISIONAL được ghi nhận (D2), KHÔNG phải SLA (spec không định nghĩa). */
export async function candidateNeedsAssistance(candidate: { status: FoundingSellerCandidateStatus; lastContactAt: string | null }): Promise<boolean>;
```

- [ ] **Step 1: Write the failing unit tests**

`tests/unit/founding-sellers.test.ts` (pure vocab tests need no db; the sync/guard tests mock `@/src/prisma/db.client` with in-memory `FoundingSellerCandidate`/`SellerVerification`/`Listing` maps — the finance-test style):

- `FOUNDING_SELLER_CANDIDATE_STATUSES matches the spec §5.10 lifecycle verbatim` — exactly the ten values, in order (non-invention pin).
- `canTransitionCandidate allows every legal pair and denies every illegal one` — table-driven over `FOUNDING_SELLER_TRANSITIONS`: each listed pair true; every unlisted pair false; `exited` has no outgoing transitions (terminal); `inactive → active_founding_seller` is **false** (reactivation is A5 — pinned as intentionally absent).
- `MANUALLY_SETTABLE_STATUSES is exactly the four ops states` (the fail-closed set Task 4 enforces).
- `maskContact masks email and phone and never returns the full value`: `"lienhe@example.com"` → `"l***@example.com"`; `"0901234567"` → `"09*****67"`; `null`/`""` → `"—"`; a 1-char local part → `"***@example.com"` (never the raw value).
- `syncFoundingSellerFunnel advances along ground truth and never backward` — fixture matrix (mock db): no candidate → null; candidate `registered` + `SellerVerification { status: "pending" }` → `verification_pending`; candidate `verification_pending` + `SellerVerification { status: "verified" }` → `verified` + `verifiedAt` set; candidate `verified` + 1 approved listing → `first_listing` + `firstListingAt` set; candidate `concierge_onboarding` + 1 approved listing → `first_listing` (S4 — ground truth wins the ops phase; the operator transitions onward from there); candidate `first_listing` + `SellerVerification { status: "rejected" }` → **unchanged** (sync never regresses); candidate `inactive`/`exited`/`active_founding_seller` → **unchanged** (ops states are never touched by sync); second sync run → identical result (idempotent).
- `syncFoundingSellerFunnel ignores listings that are not approved` — a `pending`/`draft`/`hidden` listing does not advance `verified → first_listing`.
- `approvedListingCountOf counts only approved listings of that seller`.
- `candidateNeedsAssistance: never-contacted active-funnel candidate → true; contacted 8 days ago → true; contacted 2 days ago → false; inactive/exited/active_founding_seller → false` (D2 heuristic pinned).
- `founding-seller-vocab.ts is a plain module` — source-contract: no `server-only`, no `@/src/prisma` import (client components import it); the PROVISIONAL/FD-3 marker is present in the header.

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/unit/founding-sellers.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement both modules**

- `src/lib/founding-seller-vocab.ts`: the constants (PROVISIONAL/FD-3 header marker), labels, transition table, `canTransitionCandidate` (pure lookup), `MANUALLY_SETTABLE_STATUSES`, `maskContact` (string slicing — never reconstruct the full value), per the interface block. No db, no `server-only`.
- `src/lib/founding-sellers.ts`: `import "server-only"`; `export * from "@/src/lib/founding-seller-vocab"`; `syncFoundingSellerFunnel` reads the candidate by `userId` → returns null when absent → otherwise reads `SellerVerification.first({ userId })` and `Listing.where({ sellerId, status: "approved" }).aggregate(count)` and performs **one** `update` advancing to the furthest ground-truth state (per the interface block — never backward, never touching `inactive`/`exited`/`active_founding_seller`); `approvedListingCountOf`; `candidateNeedsAssistance` (pure given the candidate fields). No `"use server"`; no logging of contact data.

- [ ] **Step 4: Run tests until green**

Run: `npm test -- tests/unit/founding-sellers.test.ts` → PASS. Then `npm test` → all existing suites green (no product surface changed yet).

- [ ] **Step 5: Commit**

```bash
git add src/lib/founding-seller-vocab.ts src/lib/founding-sellers.ts tests/unit/founding-sellers.test.ts
git commit -m "feat(cohort): founding seller domain module"
```

## Task 3: Invitation flow — candidate, invite issuance, acceptance, telemetry

**Files:**

- Create: `src/lib/actions/founding-sellers.ts` (`"use server"` — candidate + invite + accept actions; Task 4 extends with the manual lifecycle actions)
- Create: `app/invite/[token]/page.tsx` (the one-time token landing: validates, sets the HttpOnly cookie, redirects to `/invite`)
- Create: `app/invite/page.tsx` (the cookie-carrying invitation page — tokenless URL)
- Create: `src/components/invite-accept-form.tsx` (`"use client"`, `useActionState` — posts no token; the action reads the cookie)
- Modify: `next.config.ts` (append the `/invite/:path*` `Referrer-Policy: no-referrer` block — T4 file order; Batch 4's `/uploads` block untouched)
- Test: `tests/unit/founding-seller-invite.test.ts`
- Test: `tests/integration/founding-seller-invite.test.ts`

**Interfaces:**

- Consumes: `FoundingSellerCandidate`/`BetaInviteToken` models (Task 1), the Task 2 vocab + `syncFoundingSellerFunnel`, `requireCapability` (Batch 2 `src/lib/rbac.ts`), `requireUser` (Batch 2 `src/lib/auth.ts`), `hkdfKey`/`normalizeEmail`/`normalizePhone` (Batch 2 `src/lib/otp.ts`), `isUserSuspended` (Batch 3 `src/lib/moderation.ts` — **delegated, not re-implemented**), `auditEvent`/`auditEventTx`/`redactDetail` (Batch 2 `src/lib/audit-event.ts`), `emitProductEvent` (Batch 5 `src/lib/product-events.ts`), `checkRateLimit`/`clientIpFromHeaders` (existing `src/lib/rate-limit.ts`), `isProvinceCode`/`PROVINCE_CODES` (Batch 2 Task 10's `src/lib/provinces.ts` — FD-1), `notify` (existing), `revalidatePath` (`next/cache`), `cookies()` (`next/headers`), `SqlQueryError` (the Postgres driver error — classify per the Global Constraints transaction rule).
- Produces (used by Tasks 4–7; the only membership-creating user path):

```ts
// src/lib/actions/founding-sellers.ts
"use server";
export type FoundingSellerFormState = { error?: string; success?: string; inviteUrl?: string };

export async function createCandidateAction(_prev: FoundingSellerFormState, formData: FormData): Promise<FoundingSellerFormState>;
//   formData: contactReference, contactChannel (email|phone), source, targetCommunity, notes?
//   1. requireCapability("beta_cohort.manage")            // super_admin + operations_admin (Batch 2 matrix ✓)
//   2. zod: contactChannel ∈ beta_invite_channel; source ≤ 200 ký tự; notes ≤ 4000 → redactDetail;
//      targetCommunity ∈ registry (isProvinceCode — slug code canonical, KHÔNG free text, KHÔNG numeric)
//   3. normalize: email → normalizeEmail; phone → normalizePhone (throw → form error)
//   4. DUPLICATE PRE-CHECK (S7): một candidate KHÁC (id ≠) với cùng (contactChannel, contactReference)
//      và status ∉ {inactive, exited} đã tồn tại → { error: CANDIDATE_CONTACT_EXISTS } (ops tìm row cũ;
//      fail closed — không tạo hai ứng viên cho một người)
//   5. FoundingSellerCandidate.create({ contactReference: normalized, contactChannel, source,
//      targetCommunity, status: "prospect", qualityListingCount: 0 })
//   6. auditEvent("founding_seller.candidate_created", resourceType: "founding_seller_candidate",
//      resourceId: id, detail: redactDetail(`community:${targetCommunity}`))   // KHÔNG contact trong detail
//   → { success } — KHÔNG trả về contact đã chuẩn hóa (PII); console render maskContact.

export async function inviteCandidateAction(_prev: FoundingSellerFormState, formData: FormData): Promise<FoundingSellerFormState>;
//   formData: candidateId
//   1. const ctx = await requireCapability("beta_cohort.manage");
//   2. checkRateLimit(`beta-invite:${ctx.user.id}`, FOUNDING_SELLER_INVITE_RATE) → denied → form error (§7.1)
//   3. candidate = first({ id }) → thiếu → { error: NOT_FOUND }; candidate.contactReference null →
//      { error: CONTACT_REQUIRED } (prospect chưa có contact — phải tạo lại candidate)
//   4. candidate.status ∈ {prospect, invited} → else { error: INVALID_STATE } (đã registered trở đi
//      KHÔNG mời lại — invite chỉ cho pre-registration; PROVISIONAL reading, S9)
//   5. token = crypto.randomBytes(32).toString("base64url")        // 256-bit, unguessable
//      tokenHash = HMAC-SHA256(token, hkdfKey("beta-invite-hash")) hex   // OtpCode.codeHash pattern
//   6. db.transaction — typed sentinel throws, classify NGOÀI (Global Constraints):
//      a. revoke mọi token active của candidate: updateAll({ revokedAt: now })
//         .where({ candidateId, consumedAt: null, revokedAt: null })   // re-invite = revoke cũ (idempotent)
//      b. BetaInviteToken.create({ candidateId, channel: candidate.contactChannel, target:
//         candidate.contactReference, tokenHash, issuedById: ctx.user.id,
//         expiresAt: now + FOUNDING_SELLER_INVITE_TTL_DAYS days })
//      c. candidate.update({ status: "invited", invitedAt: now })
//      d. auditEventTx(tx, { action: "founding_seller.invite_issued", actorId: ctx.user.id,
//         resourceType: "beta_invite_token", resourceId: tokenRow.id, sessionId: ctx.session.id,
//         detail: redactDetail(`candidate:${candidateId}`) })
//   7. NGOÀI tx — classify SqlQueryError: sqlState "23505" + constraint "beta_invite_one_active"
//      → { error: INVITE_ALREADY_ISSUED } (re-invite concurrent — token cũ đã revoke, token mới thua;
//      fail closed); mọi lỗi khác rethrow
//   8. emitProductEvent({ name: "seller_invited", actorId: null,      // prospect CHƯA có tài khoản —
//        provinceCode: candidate.targetCommunity })                    // actor null; KHÔNG contact (§4.8)
//   9. return { success, inviteUrl: `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/invite/${token}` }
//      // URL TUYỆT ĐỐI (operator copy vào tin nhắn riêng của họ); raw token hiển thị MỘT LẦN trong
//      // form state này — KHÔNG vào db (chỉ tokenHash)/audit/telemetry/log; mất link → revoke + mời lại.

export async function revokeInviteAction(formData: FormData): Promise<void>;
//   formData: tokenId — requireCapability("beta_cohort.manage");
//   atomic updateAll({ revokedAt: now }).where({ id, consumedAt: null, revokedAt: null })
//   → 0 rows → no-op thành công (idempotent); audit "founding_seller.invite_revoked" (chỉ khi có thay đổi)

export async function acceptInviteAction(_prev: FoundingSellerFormState, formData: FormData): Promise<FoundingSellerFormState>;
//   formData: KHÔNG mang token (S1 — token đến từ HttpOnly cookie "sp_invite" do /invite/[token] set,
//   đọc qua cookies() từ next/headers; KHÔNG BAO GIỜ tin formData/next/query cho token)
//   1. requireUser() — chưa đăng nhập → redirect("/login?next=/invite")   // TOKENLESS next — redirect NGOÀI catch
//   2. rate limit: checkRateLimit(`beta-invite-accept:${user.id}`, BETA_INVITE_ACCEPT_RATE) +
//      IP bucket (clientIpFromHeaders) → denied → { error: RATE_LIMITED } (§7.1 endpoint được spec nêu tên)
//   3. token = (await cookies()).get("sp_invite")?.value → thiếu → { error: INVITE_INVALID }
//      tokenHash = HMAC(token); row = BetaInviteToken.first({ tokenHash }) → thiếu → { error: INVITE_INVALID }
//      row.revokedAt != null || row.expiresAt <= now → { error: INVITE_INVALID }   // CÙNG thông báo —
//      // enumeration-safe: mọi lý do fail của token đều INVITE_INVALID, không phân biệt revoked/expired/unknown
//   4. CHANNEL BINDING (Review Focus 2) — đọc User FRESH (S3: SessionUser KHÔNG có phone/
//      emailVerifiedAt/phoneVerifiedAt — KHÔNG bao giờ mở rộng session.ts; đọc User.first({ id })):
//      fresh = User.first({ id: sessionUser.id })
//      channel=email → normalizeEmail(fresh.email) === row.target ? else { error: INVITE_CHANNEL_MISMATCH }
//                       fresh.emailVerifiedAt != null ? else { error: INVITE_CHANNEL_UNVERIFIED }
//      channel=phone → normalizePhone(fresh.phone) === row.target ? else { error: INVITE_CHANNEL_MISMATCH }
//                       fresh.phoneVerifiedAt != null ? else { error: INVITE_CHANNEL_UNVERIFIED }
//      // tài khoản đã verify kênh đó (Batch 2) — link bị lộ KHÔNG gắn membership vào tài khoản khác
//   5. await isUserSuspended(user.id)  [BATCH 3 DELEGATION — S10, §7.3 "suspended-user bypass"]
//      → true → { error: INVITE_ACCOUNT_SUSPENDED }   // tài khoản bị đình chỉ không nhận membership
//   6. db.transaction — typed sentinel throws, KHÔNG BAO GIỜ catch-and-return (Global Constraints):
//      a. RE-READ token INSIDE tx; ATOMIC CLAIM: updateAll({ consumedAt: now }).where({ id: row.id, consumedAt: null })
//         → 0 rows → throw sentinel Error("INVITE_CONSUMED_RACE")          // concurrent double-accept (§10.1)
//      b. RE-READ candidate INSIDE tx (không tin row đọc trước tx):
//         candidate null → throw sentinel INVITE_INVALID
//         candidate.userId != null && candidate.userId !== user.id → throw sentinel INVITE_LINKED_ELSEWHERE
//           // token của ứng viên đã liên kết người khác — không tiết lộ gì thêm
//         candidate.status !== "invited" → throw sentinel INVITE_NOT_INVITED
//           // fail closed: inactive/exited/đã registered không nhận lại membership qua token cũ —
//           // re-entry là ops decision (A5); invite flow bảo đảm chỉ có token active khi status == invited
//      c. RE-READ membership INSIDE tx — BetaCohortMembership.first({ userId, cohort: "founding_seller" }):
//         status "suspended" | "exited" → throw sentinel INVITE_MEMBERSHIP_NOT_ACCEPTABLE
//           // (B3) từ chối TRƯỚC claim — token KHÔNG bị burn, không có membership mới; ops quyết qua
//           // /admin/users (Batch 2 action) — acceptance không tự re-activate một membership bị đình chỉ
//      d. upsert theo @@unique(userId, cohort) — sau claim (B3):
//         null        → create({ userId, cohort: "founding_seller", status: "active",
//                       invitedBy: row.issuedById, invitedAt: row.createdAt, acceptedAt: now }) → activated = true
//         "invited"   → update({ status: "active", acceptedAt: now }) → activated = true
//         "active"    → update({ acceptedAt: acceptedAt ?? now }) → activated = false   // đã active (admin-granted
//                       // Batch 2) — KHÔNG duplicate row, KHÔNG hạ status, KHÔNG re-emit
//      e. candidate.update({ userId: user.id, registeredAt: now, status: "registered" })
//      f. auditEventTx(tx, { action: "founding_seller.invite_accepted", actorId: user.id,
//         subjectId: user.id, resourceType: "beta_invite_token", resourceId: row.id })
//      g. return { activated } từ callback
//   7. NGOÀI tx — classify (Global Constraints — SqlQueryError, sqlState "23505" + constraint prefix):
//      "beta_invite_one_active"                    → { error: INVITE_INVALID }   // re-issue concurrent burn token cũ
//      "FoundingSellerCandidate_userId_key"        → { error: INVITE_INVALID }   // concurrent acceptance link account khác
//      "BetaCohortMembership_userId_cohort_key"     → { error: INVITE_INVALID }   // concurrent admin grant
//      "BetaInviteToken_tokenHash_key"             → { error: INVITE_INVALID }   // (thực tế bất khả thi — 256-bit)
//      sentinel errors (INVITE_CONSUMED_RACE / INVITE_LINKED_ELSEWHERE / INVITE_NOT_INVITED /
//        INVITE_MEMBERSHIP_NOT_ACCEPTABLE) → form error theo code
//      MỌI lỗi khác → rethrow (fail closed — KHÔNG map mù)
//   8. SAU tx thành công: xóa cookie "sp_invite" (cookies().delete);
//      if (activated) emitProductEvent({ name: "beta_membership_activated", actorId: user.id,
//        provinceCode: candidate.targetCommunity })   // CHỈ khi activated=true (B3 — Batch 5 S7: emit
//        // chỉ trên transition to active; đường acceptance là đường activation thứ hai, song song với
//        // setBetaMembershipAction của Batch 2 mà Batch 5 đã wire)
//      emitProductEvent({ name: "seller_registered", actorId: user.id,
//        provinceCode: candidate.targetCommunity })   // T5 forward seam — WIRED ở đây (PROVISIONAL reading: "registered"
//        // = invite acceptance — S9)
//      notify(user.id, "cohort", "Chào mừng founding seller", ...) // in-app — kind "cohort" (typed free string,
//        // các kind hiện có là order/offer/dispute/withdraw/listing/counter — KHÔNG dùng "moderation");
//        // copy trung tính, KHÔNG incentive/guarantee (§4.2/§4.11)
//   9. return { success } → redirect("/sell")                        // redirect NGOÀI catch block
```

```tsx
// app/invite/[token]/page.tsx — ONE-TIME token landing (S1). PUBLIC (không requireUser — invitee chưa có tài khoản).
//   GET: token từ params → tokenHash = HMAC(token) → BetaInviteToken.first({ tokenHash })
//     row thiếu || revokedAt != null || expiresAt <= now || consumedAt != null → render "Lời mời không còn
//     hiệu lực" (thông báo chung — enumeration-safe; KHÔNG set cookie, KHÔNG render contact)
//     hợp lệ → cookies().set("sp_invite", token, { httpOnly: true, sameSite: "lax", path: "/",
//       maxAge: 15 * 60, secure: production }) → redirect("/invite")   // token RỜI URL ngay lập tức —
//     KHÔNG BAO GIỜ trong next/query/form; các request sau chỉ mang cookie
//   export const dynamic = "force-dynamic".
// app/invite/page.tsx — TOKENLESS invitation page (S1). Đọc cookie "sp_invite":
//     thiếu → "Lời mời không còn hiệu lực" (cùng thông báo); có → hash-lookup lại (fresh) → hợp lệ →
//     render lời mời trung tính + (đã đăng nhập ? <InviteAcceptForm> : CTA /login?next=/invite — TOKENLESS).
//     Copy: mô tả chương trình founding seller TRUNG TÍNH — KHÔNG incentive, KHÔNG guarantee (§4.2),
//     KHÔNG legal text mới (§4.11 — Batch 8 owns policy text). KHÔNG render contact reference.
// src/components/invite-accept-form.tsx — "use client", useActionState(acceptInviteAction),
//   KHÔNG hidden input token (action đọc cookie), error/success display; success → redirect theo state.
// next.config.ts — append (Task 3 sở hữu; block /uploads của Batch 4 KHÔNG đụng):
//   { source: "/invite/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] }
```

- [ ] **Step 1: Write the failing unit tests**

`tests/unit/founding-seller-invite.test.ts` (mock db with in-memory `FoundingSellerCandidate`/`BetaInviteToken`/`BetaCohortMembership`/`User` maps; role-stubbed `requireCapability`/`requireUser` per the canonical recipe; a controllable `cookies()` mock carrying `sp_invite`; `vi.mock("@/src/lib/moderation")` with an `isUserSuspended` spy; spy on `auditEventTx`, `emitProductEvent`, `notify`; `resetRateLimits()` in `beforeEach`; **the mock `BetaInviteToken.create`/`BetaCohortMembership.create` can be made to throw a `SqlQueryError`-shaped object** — `{ sqlState: "23505", constraint: "<name>" }` — so the classify path is exercised; a plain `Error` would be rethrown, not mapped):

- `createCandidateAction: operations_admin → row created with normalized contact + status prospect + audit; moderator → FORBIDDEN, no row` (Review Focus 4); `analyst/support → FORBIDDEN`; `non-admin → FORBIDDEN`.
- `createCandidateAction: invalid province (isProvinceCode false) → form error, no row` (canonical slug codes — FD-1); `invalid phone format → form error (normalizePhone throw caught), no row`.
- `createCandidateAction: duplicate (contactChannel, contactReference) on a non-exited candidate → CANDIDATE_CONTACT_EXISTS, no row; the same contact on an exited candidate → allowed` (S7).
- `createCandidateAction: audit detail carries no contact string` — spy the persisted `AuditEvent` input: `detail` contains the community code, never the email/phone (§4.8).
- `inviteCandidateAction: prospect → token row stores an HMAC (64-hex), never the token; candidate → invited + invitedAt; audit appended; absolute inviteUrl returned once` (`NEXT_PUBLIC_APP_URL`-prefixed — Review Focus 1).
- `inviteCandidateAction: re-invite revokes the previous active token and issues a new one — exactly one active token` (idempotent re-issue).
- `inviteCandidateAction: rate limit — 21st invite within the hour → form error, no token row` (§7.1).
- `inviteCandidateAction: candidate already registered → INVALID_STATE, no token` (invite is pre-registration only).
- `inviteCandidateAction emits seller_invited with actorId null and NO contact in the event` (spy `emitProductEvent`: `name === "seller_invited"`, `actorId === null`, `provinceCode` only — Review Focus 1).
- `inviteCandidateAction: concurrent re-invite (mock create throws 23505 + "beta_invite_one_active") → INVITE_ALREADY_ISSUED, and the revoke of the old token is NOT persisted` (the tx aborted — no silent success; Global Constraints).
- `revokeInviteAction: active token → revokedAt set + audit; already-consumed token → no-op, no audit churn; moderator → FORBIDDEN`.
- `acceptInviteAction: valid cookie token + matching verified email → membership created {cohort: founding_seller, status: active, acceptedAt set, invitedBy: issuer}, candidate → registered + userId linked, audit appended, cookie cleared` — the happy path (spec §9 Gate "invite acceptance").
- `acceptInviteAction: no cookie → INVITE_INVALID, zero db calls; a token in formData is IGNORED` (S1 — the action reads only the cookie; a forged `formData.token` changes nothing).
- `acceptInviteAction: token consumed by a concurrent second call → INVITE_INVALID` (atomic claim — 0-row updateAll; the sentinel path).
- `acceptInviteAction: expired token → INVITE_INVALID; revoked token → INVITE_INVALID; unknown token → INVITE_INVALID` — **byte-identical error string for all three** (enumeration-safe — Review Focus 2).
- `acceptInviteAction: account email ≠ token target → INVITE_CHANNEL_MISMATCH, no membership, token NOT consumed` (Review Focus 2 — the tx threw before the claim).
- `acceptInviteAction: account email matches but emailVerifiedAt null → INVITE_CHANNEL_UNVERIFIED, no membership, token NOT consumed` (channel binding — the spec's "required authentication state", §2.1/§5.3.1).
- `acceptInviteAction: phone channel — matching verified phone passes; unverified phone → INVITE_CHANNEL_UNVERIFIED; mismatched phone → INVITE_CHANNEL_MISMATCH` (normalizePhone compared on both sides — S3).
- `acceptInviteAction: a user with an ACTIVE UserSuspension → INVITE_ACCOUNT_SUSPENDED, no membership, token NOT consumed` (S10 — §7.3; the `isUserSuspended` delegation spy was called).
- `acceptInviteAction: existing membership status "invited" → set active + acceptedAt + beta_membership_activated EMITTED` (B3).
- `acceptInviteAction: existing membership status "active" (admin-granted, Batch 2) → upsert keeps one row, status stays active, acceptedAt filled if null, beta_membership_activated NOT emitted` (B3 — `activated: false`).
- `acceptInviteAction: existing membership status "suspended"/"exited" → INVITE_MEMBERSHIP_NOT_ACCEPTABLE, no membership change, token NOT consumed` (B3 — refuse before the claim).
- `acceptInviteAction: candidate already linked to ANOTHER user → INVITE_INVALID, no membership` (no existence oracle).
- `acceptInviteAction: candidate in inactive/exited/registered → INVITE_INVALID, no membership` (ops-controlled re-entry — A5).
- `acceptInviteAction: concurrent acceptance (mock BetaCohortMembership.create throws 23505 + "BetaCohortMembership_userId_cohort_key") → INVITE_INVALID, and the token's consumedAt is NOT persisted` (the tx aborted — no silent success; Review Focus 2).
- `acceptInviteAction: a NON-unique driver error inside the tx RETHROWS` (fail closed — a mocked `23503` or plain `Error` surfaces as the thrown error, never as INVITE_INVALID).
- `acceptInviteAction emits seller_registered with the accepting user as actor; beta_membership_activated ONLY on the activated paths; NO contact in either event` (T5/B3 — Review Focus 1).
- `acceptInviteAction: rate limit — 11th attempt within 10 min → RATE_LIMITED, no consume` (§7.1 "beta invite acceptance").
- `acceptInviteAction: no session → redirect to /login?next=/invite (TOKENLESS), zero db calls` (mock `requireUser` throws `NEXT_REDIRECT`).
- `the persisted token row never contains the raw token` — after the full invite+accept flow, scan every in-memory row of `BetaInviteToken`: no value equals the raw token (Review Focus 1).
- `no console.log/captureError/audit payload contains the raw token` — spy them across the flow (Review Focus 1).

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/unit/founding-seller-invite.test.ts`
Expected: FAIL — `src/lib/actions/founding-sellers.ts` missing.

- [ ] **Step 3: Implement actions + invite pages + form**

- `src/lib/actions/founding-sellers.ts` per the interface block. Guard order in `acceptInviteAction`: `requireUser` → rate limit → cookie read + token lookup → fresh `User` read + channel binding → `isUserSuspended` delegation → tx (re-reads → membership refusal check → atomic claim → upsert → candidate link → audit) → **classify outside** → cookie clear → conditional emission + notify → redirect outside the catch. Typed error strings (Vietnamese, user-facing) with stable codes in the message for tests (Batch 2 pattern). No `export const` in this `"use server"` file (Next 16) — constants import from `founding-seller-vocab.ts`.
- `app/invite/[token]/page.tsx` + `app/invite/page.tsx` + `src/components/invite-accept-form.tsx` per the interface block (the cookie flow — S1; plain React form, `useActionState`, no library).
- `next.config.ts`: append the `/invite/:path*` `Referrer-Policy: no-referrer` block beside Batch 4's `/uploads` block (additive; Batch 4's block byte-identical).

- [ ] **Step 4: Write the integration test — the invite-acceptance gate (real DB)**

`tests/integration/founding-seller-invite.test.ts` (real DB; the canonical stubbing recipe for `next/navigation`/`next/headers` — **with a controllable `cookies()` mock carrying `sp_invite`**; `requireUser`/`requireCapability` mocked to fixture users that are real scratch-DB rows; **`AUTH_SECRET` + `PRODUCT_EVENT_PSEUDONYM_KEY` set to test values in `beforeAll`** — the `hkdfKey` HMAC and the Batch 5 pseudonym key are both required; db NOT mocked):

- `end-to-end: candidate → invite → accept → membership active + publication requirements satisfied for the membership leg`: create candidate (ops fixture) → `inviteCandidateAction` → read the token row (assert `tokenHash` ≠ raw token) → seed the invitee `User` with `emailVerifiedAt` set and email === target → set the `sp_invite` cookie mock → `acceptInviteAction` → assert `BetaCohortMembership { userId, cohort: "founding_seller", status: "active", acceptedAt ≠ null }`, candidate `{ userId, status: "registered", registeredAt }`, token `consumedAt ≠ null` — and `checkSellerPublicationRequirements` (Batch 2) now returns `founding_seller_membership_active` **satisfied** (the other requirements still missing — assert exactly that one moved).
- `a second acceptance of the same token → INVITE_INVALID and no second membership` (single-use, real atomic claim).
- `an account with a different verified email → INVITE_CHANNEL_MISMATCH, no membership row — and the token is STILL unconsumed` (the refusal happened before the claim — B3; Review Focus 2, real DB).
- `an account with matching but unverified email → INVITE_CHANNEL_UNVERIFIED, no membership row` — then verify the email (set `emailVerifiedAt`) → acceptance passes (the Batch 2 verification flow is the fix).
- `expired token (expiresAt in the past) → INVITE_INVALID` (real expiry boundary).
- `re-invite after revocation: revoke → inviteCandidateAction again → old token INVITE_INVALID, new token works` (revocation + re-issue).
- `a suspended account (active UserSuspension row) → INVITE_ACCOUNT_SUSPENDED, no membership, token unconsumed` (S10, real DB).
- `seller_invited / seller_registered / beta_membership_activated ProductEvent rows exist with pseudonymized actor (acceptance) and null actor (invite), and NO row contains the contact string` — read `ProductEvent` rows back, scan every column + metadata JSON for the raw email (§4.8 end-to-end).

- [ ] **Step 5: Run until green**

Run: `npm test -- tests/unit/founding-seller-invite.test.ts` → PASS.
Run: `npm run test:integration` → `founding-seller-invite.test.ts` + `batch7-migration.test.ts` + all earlier suites PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/actions/founding-sellers.ts 'app/invite/[token]/page.tsx' app/invite/page.tsx src/components/invite-accept-form.tsx next.config.ts tests/unit/founding-seller-invite.test.ts tests/integration/founding-seller-invite.test.ts
git commit -m "feat(cohort): founding seller invitation flow"
```

## Task 4: Lifecycle actions — manual transitions, funnel sync, operator assignment, contact, notes

**Files:**

- Modify: `src/lib/actions/founding-sellers.ts` (add the manual lifecycle + funnel sync actions — same file as Task 3, sequential per the file-conflict rules)
- Modify: `src/lib/constants.ts` (append `FOUNDING_SELLER_STATUS_BADGE` only — additive; T4 file order)
- Test: `tests/unit/founding-seller-lifecycle.test.ts`

**Interfaces:**

- Consumes: the Task 2 vocab (`FOUNDING_SELLER_TRANSITIONS`/`canTransitionCandidate`/`MANUALLY_SETTABLE_STATUSES`/`FOUNDING_SELLER_TRANSITION_REASONS`/`FOUNDING_SELLER_NOTE_MAX_LENGTH`) + `syncFoundingSellerFunnel` (Task 2), `requireCapability` (Batch 2), `auditEvent`/`redactDetail` (Batch 2), `revalidatePath` (`next/cache`).
- Produces (used by Task 5 console):

```ts
// src/lib/actions/founding-sellers.ts (thêm — "use server" file của Task 3)
export async function syncCandidateFunnelAction(formData: FormData): Promise<void>;
//   formData: candidateId — requireCapability("beta_cohort.manage");
//   await syncFoundingSellerFunnel(candidate.userId)   // null → no-op (chưa link);
//   audit "founding_seller.funnel_synced" (detail = from→to qua redactDetail — ids/codes only)
//   + revalidatePath("/admin/beta-cohort").
//   // S5: đây là ĐƯỜNG DUY NHẤT operator chạy sync — console page KHÔNG sync trong render;
//   // sync cũng chạy tự động trong acceptInviteAction (sau link) để bắt kịp verification/listing
//   // diễn ra TRƯỚC acceptance.

export async function updateCandidateStatusAction(formData: FormData): Promise<void>;
//   formData: candidateId, toStatus, reasonCode, note?
//   1. requireCapability("beta_cohort.manage")            // KHÔNG step-up — beta_cohort.manage không
//      // thuộc STEP_UP_CAPABILITIES (Batch 2) và §5.4.2 không nêu cohort — thêm step-up = phát minh (Global Constraints)
//   2. validate: toStatus ∈ MANUALLY_SETTABLE_STATUSES → else throw Error("STATUS_NOT_MANUALLY_SETTABLE")
//      // (PROVISIONAL set — S9) prospect/invited/registered/verification_pending/verified/first_listing
//      // là của invite/sync — operator không tự set (fail closed chống fake funnel)
//      reasonCode ∈ FOUNDING_SELLER_TRANSITION_REASONS; note ≤ NOTE_MAX → redactDetail trước khi lưu
//   3. candidate tồn tại → else throw NOT_FOUND
//   4. canTransitionCandidate(candidate.status, toStatus) → false → throw Error("INVALID_TRANSITION")
//   5. ATOMIC CLAIM: updateAll({ status: toStatus, updatedAt: now }).where({ id, status: candidate.status })
//      → 0 rows → throw Error("CANDIDATE_ALREADY_MOVED")          // concurrent operator (§10.1)
//   6. auditEvent("founding_seller.status_changed", reason: reasonCode, detail: redactDetail(
//      `${from}→${toStatus}`)) + append note vào candidate.notes (nếu có) qua redactDetail
//   7. toStatus === "active_founding_seller" → KHÔNG tự set qualityListingCount (A3 — count là ops
//      input riêng); revalidatePath("/admin/beta-cohort")

export async function assignCandidateOperatorAction(formData: FormData): Promise<void>;
//   formData: candidateId, operatorId — requireCapability("beta_cohort.manage");
//   operator tồn tại + capabilitiesOf(operator.adminRole).includes("beta_cohort.manage")
//   → else throw Error("ASSIGNEE_NOT_ELIGIBLE")   // analyst làm operator → chặn (Batch 3 assign precedent)
//   + update + audit "founding_seller.operator_assigned"

export async function recordCandidateContactAction(formData: FormData): Promise<void>;
//   formData: candidateId, note? — requireCapability("beta_cohort.manage");
//   update({ lastContactAt: now }) + audit "founding_seller.contact_recorded" (note → redactDetail)

export async function updateCandidateNotesAction(_prev: FoundingSellerFormState, formData: FormData): Promise<FoundingSellerFormState>;
//   formData: candidateId, notes — requireCapability("beta_cohort.manage");
//   notes ≤ FOUNDING_SELLER_NOTE_MAX_LENGTH → redactDetail → candidate.update({ notes });
//   audit "founding_seller.notes_updated" (detail = ids only). Note là ops free text —
//   render React text only ở console (KHÔNG dangerouslySetInnerHTML).

export async function updateQualityListingCountAction(formData: FormData): Promise<void>;
//   formData: candidateId, count — requireCapability("beta_cohort.manage");
//   count ≥ 0 (zod int) → candidate.update({ qualityListingCount: count })
//   + audit "founding_seller.quality_count_set" (detail = ids only).
//   // A3: giá trị do ops đặt sau §12.1 manual sampling — hệ thống KHÔNG auto-compute
//   // (không có định nghĩa "quality listing": Batch 4 A1/A2 founder-gated, Batch 5 A5 đã ghi nhận).
```

- [ ] **Step 1: Write the failing unit tests**

`tests/unit/founding-seller-lifecycle.test.ts` (mock db + role-stubbed `requireCapability`; spy on `auditEvent`, `FoundingSellerCandidate.update`):

- `syncCandidateFunnelAction: linked candidate → sync runs + audit "founding_seller.funnel_synced"; unlinked candidate → no-op, no audit churn; moderator → FORBIDDEN` (S5 — the only operator sync path).
- `updateCandidateStatusAction: operations_admin + legal pair (verified → concierge_onboarding, reason concierge_started) → status updated + audit with typed reason` (spec §5.10 chain).
- `updateCandidateStatusAction: first_listing → active_founding_seller with reason quality_sample_passed → allowed` (§12.1 manual sampling is the operator's call).
- `updateCandidateStatusAction: illegal pairs throw INVALID_TRANSITION` — table-driven over `FOUNDING_SELLER_TRANSITIONS`: every unlisted pair false, including `prospect → verified`, `exited → invited`, and `inactive → active_founding_seller` (A5 reactivation pinned denied).
- `updateCandidateStatusAction: automatic states are not manually settable` — `toStatus ∈ {prospect, invited, registered, verification_pending, verified, first_listing}` → `STATUS_NOT_MANUALLY_SETTABLE` (fail closed against a fake funnel).
- `updateCandidateStatusAction: moderator → FORBIDDEN, no mutation`; `support/analyst → FORBIDDEN` (Review Focus 4).
- `updateCandidateStatusAction: reasonCode outside the vocabulary → typed error, zero writes`; `note over the cap → typed error`.
- `updateCandidateStatusAction: concurrent second move → CANDIDATE_ALREADY_MOVED` (atomic claim — §10.1).
- `updateCandidateStatusAction: NO step-up is required` — the action never calls `requireCapabilityWithStepUp` and succeeds with plain `requireCapability` (Global Constraints pin).
- `assignCandidateOperatorAction: eligible operator (operations_admin) → assigned + audit; analyst as assignee → ASSIGNEE_NOT_ELIGIBLE; moderator → FORBIDDEN`.
- `recordCandidateContactAction: lastContactAt set + audit; note redacted (an email in the note is stored masked in AuditEvent.detail)`.
- `updateCandidateNotesAction: notes stored redacted; over-cap → error; moderator → FORBIDDEN`.
- `updateQualityListingCountAction: count set + audit; negative → error; moderator → FORBIDDEN; the system never auto-computes it` (source-contract: no other writer of `qualityListingCount` — `rg "qualityListingCount" src` shows only this action and the console read).

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/unit/founding-seller-lifecycle.test.ts`
Expected: FAIL — actions missing.

- [ ] **Step 3: Implement**

- Add the six actions to `src/lib/actions/founding-sellers.ts` per the interface block (same file as Task 3 — sequential per the file-conflict rules). Guard order: capability → validation → target checks → atomic claim → audit → revalidate. `updateCandidateStatusAction` and the four plain `FormData` actions follow `suspendUserAction`'s plain-form style (Batch 3); `updateCandidateNotesAction` uses the `useActionState` state signature (the console's client form, Task 5).
- `src/lib/constants.ts`: append **only** `FOUNDING_SELLER_STATUS_BADGE: Record<string, string>` (Tailwind classes, the `LISTING_STATUS_BADGE` pattern) — the status *labels* already live in `founding-seller-vocab.ts` (Task 2); no existing map is touched.

- [ ] **Step 4: Run until green**

Run: `npm test -- tests/unit/founding-seller-lifecycle.test.ts` → PASS. Then `npm test` → full unit suite green (Task 3's suites untouched).

- [ ] **Step 5: Commit**

```bash
git add src/lib/actions/founding-sellers.ts src/lib/constants.ts tests/unit/founding-seller-lifecycle.test.ts
git commit -m "feat(cohort): founding seller lifecycle actions"
```

## Task 5: Founding seller console + concierge tracking + supply-readiness view

**Files:**

- Create: `app/admin/beta-cohort/page.tsx` (console — server component)
- Create: `src/components/founding-seller-console.tsx` (server-rendered table + plain `<form action>` posts)
- Create: `src/components/founding-seller-forms.tsx` (`"use client"`, `useActionState` — the candidate-create, invite-issue, and notes forms that render returned state)
- Modify: `app/admin/layout.tsx` (append nav entry `Beta cohort` → `/admin/beta-cohort`, `beta_cohort.manage`-filtered — T4 file order)
- Modify: `app/admin/users/page.tsx` (append a `Beta cohort` link per user → `/admin/beta-cohort?userId=<id>` — T4 file order)
- Test: `tests/unit/beta-cohort-console.test.ts`

**Interfaces:**

- Consumes: `requireCapability("beta_cohort.manage")` (Batch 2), `capabilitiesOf` (Batch 2), all Task 2–4 functions, `maskContact` (Task 2), `approvedListingCountOf`/`candidateNeedsAssistance` (Task 2), `checkSellerPublicationRequirements` (Batch 2 — per-candidate verification-state display), `PROVINCE_CODES` (Batch 2 Task 10's `src/lib/provinces.ts` — FD-1, `PROVINCE_CODES[code]` for display), `BetaCohortMembership` reads (the linked user's membership status — read-only), `SellerVerification` reads.
- Produces: the spec §5.10 console at `/admin/beta-cohort` (`export const dynamic = "force-dynamic"`), the §12.1 supply-readiness operational-targets view, and the §5.10.1 concierge guidance card. Activation *metrics* stay in Batch 5's `/admin/analytics` (referenced by a link, not duplicated). **No write during render (S5):** the page performs live reads only; every mutation is a Task 3/4 action posted by a form.

- [ ] **Step 1: Write the failing unit/source-contract tests**

`tests/unit/beta-cohort-console.test.ts` (source-contract style of `tests/unit/finance-public-surface.test.ts` — read the page/component source, assert the boundary; plus pure-logic tests on the view-model helpers):

- `the page calls requireCapability("beta_cohort.manage") before any db read` (source assertion on `app/admin/beta-cohort/page.tsx`; super_admin + operations_admin only — Batch 2 matrix; moderator/support/analyst get FORBIDDEN at the action level, pinned by the Task 4 tests).
- `the admin layout nav entry is capability-filtered` (source assertion on `app/admin/layout.tsx` — `capabilitiesOf(...).includes("beta_cohort.manage")`; UI filtering is convenience, the page guard is the control — §4.5).
- `contactReference renders masked, never full` — source assertion: the console component calls `maskContact`, and no template renders `contactReference` directly (Review Focus 4).
- `no reveal-PII action exists` — source scan over `app/admin/beta-cohort` + `src/components/founding-seller-console.tsx` + `src/lib/actions/founding-sellers.ts`: zero occurrences of a reveal/unmask path; `pii.view_sensitive` is never called (the Scoped cell is undefined — A2 fail closed).
- `the console renders no stored invite token or URL` — source assertion: `inviteUrl` appears only in the issue form's returned `FoundingSellerFormState` (one-time response state), never in the candidate table, a "view link" column, or any re-display path; the raw token exists only in that transient state (Review Focus 1).
- `no dangerouslySetInnerHTML anywhere in the console surfaces` (notes are untrusted ops free text — React text only; §10.1 stored-XSS posture).
- `the console displays the §5.10 list`: total candidates, invited, registered, verification state (per-candidate `checkSellerPublicationRequirements` missing list + `SellerVerification.status`), first-listing state (`firstListingAt` + `approvedListingCountOf`), quality listing count (stored field — A3), last seller activity (`lastContactAt` + latest listing `updatedAt`), needs-assistance flag (`candidateNeedsAssistance`), assigned operator, onboarding notes — source assertion that each is rendered.
- `the page performs NO write during render (S5)` — source assertion: the page module contains no `syncFoundingSellerFunnel` call and no `update`/`updateAll`/`create` on `FoundingSellerCandidate`/`BetaInviteToken`; the funnel sync is reachable only through `syncCandidateFunnelAction` (a posted form — Task 4), and the page renders the **stored** status beside the **live** verification/listing reads.
- `supply readiness renders as operational targets with live counts, never a hard gate`: the view helper returns `{ invitedFoundingSellers: number; verifiedFoundingSellers: number; approvedListingsByFoundingSellers: number; targetInvited: "20–50"; targetListings: "100–300" }` — the targets are **display strings** (spec §2.7/§9 operational targets); no code path blocks anything on reaching them (§12.1 makes broader buyer invitations a founder approval, not a code gate — source assertion: no `if (count >= 20)` style logic).
- `quality listing count renders with its pending-definition caveat` — the stored `qualityListingCount` (ops-set per §12.1 sampling) renders beside the factual `approvedListingCountOf` count, labeled distinctly ("tin đã duyệt" vs "tin chất lượng (ops sample)") — no invented auto-computation (A3).
- `concierge guidance renders the §5.10.1 responsibility split` — neutral copy: operations may assist with model selection/structured fields/photo checklist/formatting/migration; must not silently fabricate seller claims; the seller retains responsibility for price/condition/defects/repair history/ownership/product claims/publication consent — source assertion the copy exists and contains no guarantee/incentive language (`rg "đảm bảo|bảo đảm|thưởng|incentive"` → 0 hits).
- `the console renders the linked user's BetaCohortMembership status read-only and links to /admin/users for grant/suspend` — no second membership-mutation surface exists in the console (source scan: `setBetaMembershipAction` is not imported by any Batch 7 file; suspension/reactivation stays Batch 2's audited action on its own page — Global Constraints registry note).
- `the users page link column is additive` — `app/admin/users/page.tsx` keeps every existing column/form (Batch 2 Task 10 + Batch 3 Task 5 surfaces) and appends only the link (source assertion).

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/unit/beta-cohort-console.test.ts`
Expected: FAIL — page/component missing.

- [ ] **Step 3: Implement**

- `app/admin/beta-cohort/page.tsx`: `await requireCapability("beta_cohort.manage")` first; `export const dynamic = "force-dynamic"`; optional `searchParams.userId` filter (the users-page link target). Load candidates (all, ≤ beta scale) → build the view model **from live reads only** (no sync, no writes — S5): per-candidate row (masked contact, source, community display via `PROVINCE_CODES[targetCommunity]`, status badge from the **stored** status, verification state via `checkSellerPublicationRequirements(userId).missing` + `SellerVerification.status`, first-listing state, approved listing count, stored quality count, last contact, needs-assistance badge, assigned operator, notes as React text, the linked user's `BetaCohortMembership` status read-only + a link to `/admin/users?q=<userId>` where Batch 2's grant/suspend forms live) + the §5.10 summary counts + the supply-readiness targets block + the concierge guidance card (§5.10.1 copy) + a link to `/admin/analytics` for the activation metrics (Batch 5's dashboard — not duplicated) + the forms from Tasks 3–4 (candidate create, invite, re-invite, revoke, funnel sync, manual transition, assign, record contact, notes, quality count).
- `src/components/founding-seller-console.tsx`: server component (no `"use client"` — plain `<form action={...}>` posts for the plain-`FormData` actions: revoke, funnel sync, manual transition with a reason select from `FOUNDING_SELLER_TRANSITION_REASONS` + note field, assign, record contact, quality count; the `app/admin/users/page.tsx` pattern).
- `src/components/founding-seller-forms.tsx`: `"use client"`, `useActionState` — the candidate-create, invite-issue (renders the returned absolute `inviteUrl` from `FoundingSellerFormState.inviteUrl` exactly once per response; the raw token never persists anywhere else), and notes forms.
- `app/admin/layout.tsx`: append the nav item behind the existing capability-filtered pattern (Batch 2 Task 9 / Batch 3 Task 6 / Batch 5 Task 10 precedent).
- `app/admin/users/page.tsx`: append the link column; touch nothing else.

- [ ] **Step 4: Run until green**

Run: `npm test -- tests/unit/beta-cohort-console.test.ts` → PASS. Then `npm test` → full unit suite green (Batch 2/3 layout + users-page suites still pass — additive only).

- [ ] **Step 5: Commit**

```bash
git add app/admin/beta-cohort/page.tsx src/components/founding-seller-console.tsx src/components/founding-seller-forms.tsx app/admin/layout.tsx app/admin/users/page.tsx tests/unit/beta-cohort-console.test.ts
git commit -m "feat(admin): founding seller console and concierge tracking"
```

## Task 6: Buyer beta access policy — guard + chat/Deal wiring + earlier-batch fixture migration

**Files:**

- Create: `src/lib/beta-access.ts` (server-only domain module)
- Modify: `src/lib/actions/chat.ts` (insert the guard on the create branch — T4 file order: after Batch 6's `assertListingSellerInteractable`, before `Conversation.create`; never touching the Batch 5 emission or the redirect branch)
- Modify: `src/lib/actions/deals.ts` (insert the guard into `createDealAction` — T4 file order: B6 → B7; after `assertListingSellerInteractable`, before `requireDealConversation`; `markDealOutcomeAction` untouched)
- Test: `tests/unit/beta-access.test.ts`
- Test: `tests/unit/chat-beta-gate.test.ts`
- Test: `tests/unit/deal-beta-gate.test.ts`
- Test: `tests/integration/beta-access-enforcement.test.ts`
- Modify (fixture migration — the eight files, T4): `tests/unit/chat-guard.test.ts`, `tests/unit/chat-hardening.test.ts`, `tests/unit/telemetry-wiring.test.ts`, `tests/unit/deal-create.test.ts`, `tests/integration/block-enforcement.test.ts`, `tests/integration/suspension-enforcement.test.ts`, `tests/integration/chat-hardening.test.ts`, `tests/integration/deal-lifecycle.test.ts`

**Interfaces:**

- Consumes: `BetaCohortMembership` (Batch 2), `requireUser` (Batch 2), `checkRateLimit` (existing), the merged Batch 6 `src/lib/actions/chat.ts` + `src/lib/actions/deals.ts` (C1/C2).
- Produces (used by the chat/Deal wiring, Task 7's enforcement proof, and any future Batch 8 surface):

```ts
// src/lib/beta-access.ts — server-only domain module (import "server-only"; KHÔNG "use server").
import "server-only";

/** Chính sách beta-access của §2.1 — SERVER-OWNED, không phải client flag, không phải env toggle
 *  (§4.9/§4.10 posture). true = restriction ĐANG bật. ⚠️ D3 (S8): đây là MỘT READING của §2.1 —
 *  "P0 should support restricting … IF OPERATIONS REQUIRES a tightly controlled test cohort" —
 *  KHÔNG phải một mặc định spec phát biểu; private beta là cohort có kiểm soát (§2.1 opening) nên
 *  reading fail-closed là BẬT. Giá trị này quyết định LIỆU MỘT BUYER NÀO CÓ THỂ CHAT KHI LAUNCH —
 *  founder phải acknowledge (Batch 8 register, S9); đổi giá trị = product decision qua code review,
 *  KHÔNG qua request/env. Đường cấp membership cho buyer: /admin/users → setBetaMembershipAction
 *  (Batch 2, audited) — không có invitation flow cho buyer trong P0 (A4). */
export const BETA_CHAT_REQUIRES_ACTIVE_MEMBERSHIP = true;

/** Cohort được phép bắt đầu hội thoại/Deal mới trong controlled beta (§2.1) — PROVISIONAL (S9):
 *  internal + founding_seller + private_beta_buyer (mọi cohort active). Buyer mời qua admin
 *  operation (§8.4), founding seller qua invite (Task 3), internal qua seed/admin. */
export const BETA_CHAT_ALLOWED_COHORTS = ["internal", "founding_seller", "private_beta_buyer"] as const;

/** true khi user có ÍT NHẤT một BetaCohortMembership (cohort ∈ BETA_CHAT_ALLOWED_COHORTS, status "active").
 *  Đọc FRESH từ DB (không cache) — suspended/exited membership → false ngay lập tức (§7.8). */
export async function isActiveBetaParticipant(userId: string): Promise<boolean>;

/** Guard cho việc BẮT ĐẦU hội thoại/Deal mới (§2.1 buyer beta access policy + §7.8 beta-membership status).
 *  BETA_CHAT_REQUIRES_ACTIVE_MEMBERSHIP && !isActiveBetaParticipant → throw Error("BETA_MEMBERSHIP_REQUIRED").
 *  Policy tắt → no-op (cơ chế tồn tại, bật/tắt là founder decision — D3). */
export async function assertBuyerBetaChatAccess(userId: string): Promise<void>;
```

```ts
// src/lib/actions/chat.ts — startConversationAction THÊM guard (giữ nguyên mọi chữ ký; T4/C1):
//   trên create branch, SAU guard Batch 6 (assertListingStartable + assertListingSellerInteractable —
//   D2 đã chặn seller-side suspension/revocation/membership), TRƯỚC Conversation.create:
//   await assertBuyerBetaChatAccess(user.id);
//   // throw BETA_MEMBERSHIP_REQUIRED → server action error (fail closed — KHÔNG redirect vào hội thoại chết)
//   // KHÔNG đụng: Batch 5 conversation_started emission (vẫn emit sau create thành công), Batch 3/6
//   // guards, existing-conversation redirect branch (§2.1 chỉ chặn CREATION — pair đã có hội thoại
//   // thì redirect như cũ, không tạo gì).
// src/lib/actions/deals.ts — createDealAction THÊM guard (C2 RESOLVED; giữ nguyên mọi chữ ký):
//   sau assertListingSellerInteractable (bước 5 của Batch 6), TRƯỚC requireDealConversation (bước 6):
//   await assertBuyerBetaChatAccess(user.id);        // actor LÀ buyer (D11) — §7.8 beta-membership status
//   // throw BETA_MEMBERSHIP_REQUIRED → form error theo code. markDealOutcomeAction KHÔNG đụng —
//   // Batch 6 D10/D2 đã định nghĩa guard của marking (actor suspension + block cho success); ongoing
//   // deal participation KHÔNG bị gate trên membership (blocking a member's confirmation would strand
//   // the bilateral record) — Batch 7 không thêm gì ở đó.
```

- [ ] **Step 1: Write the failing unit tests**

`tests/unit/beta-access.test.ts` (mock db with in-memory `BetaCohortMembership`):

- `isActiveBetaParticipant: active founding_seller → true; active private_beta_buyer → true; active internal → true`.
- `isActiveBetaParticipant: suspended founding_seller → false; exited → false; invited (not yet accepted) → false; no membership → false` (§7.8 fresh read).
- `isActiveBetaParticipant: membership in a cohort outside BETA_CHAT_ALLOWED_COHORTS → false` (future cohort values fail closed until allowlisted).
- `assertBuyerBetaChatAccess throws BETA_MEMBERSHIP_REQUIRED for a non-participant; resolves for a participant`.
- `BETA_CHAT_REQUIRES_ACTIVE_MEMBERSHIP is true (the D3 fail-closed reading — pinned; flipping it is a reviewed founder-acknowledged product decision, Batch 8 register)`.
- `beta-access.ts is a plain server module` — source-contract: `server-only` present, no `"use server"`.

`tests/unit/chat-beta-gate.test.ts` (mock db + the canonical stubbing recipe; **fixtures in the Batch 6 verified-seller + approved-listing shape** — the seller satisfies `assertListingSellerInteractable`, the listing is `approved`; spy on `Conversation.create` and the Batch 5 emission recorder):

- `startConversationAction: buyer WITHOUT active membership → BETA_MEMBERSHIP_REQUIRED, no Conversation created, no conversation_started emitted` (§2.1 — the buyer beta access gate; the emission must not fire because the create never runs).
- `startConversationAction: buyer WITH active private_beta_buyer membership → conversation created + emission fires` (the policy admits invited buyers).
- `startConversationAction: founding seller starting a conversation (active membership) → allowed` (sellers are participants too).
- `startConversationAction: buyer whose founding_seller membership was SUSPENDED → BETA_MEMBERSHIP_REQUIRED` (suspended membership enforced on chat — Review Focus 3).
- `the guard runs AFTER the Batch 3/6 guards` — a blocked pair without membership → `CHAT_BLOCKED` (not `BETA_MEMBERSHIP_REQUIRED`); a suspended initiator without membership → `ACCOUNT_SUSPENDED`; a suspended-membership SELLER → `SELLER_MEMBERSHIP_INACTIVE` (Batch 6 D2 fires first — ordering pinned: Batch 3 actor-side → Batch 6 seller-side → Batch 7 buyer-side).
- `the guard runs after the existing-conversation lookup and before Conversation.create` — a non-member buyer **with** an existing conversation for the pair takes the existing redirect branch unchanged (§2.1 restricts **creation** only — no new row, no new access); a non-member buyer **without** one → `BETA_MEMBERSHIP_REQUIRED`, no `Conversation.create` (the precise §2.1 reading, pinned).
- `messages within an existing conversation are NOT gated by the beta policy` — `POST /api/chat/[id]` (Batch 6 hardened route) unchanged: the §2.1 restriction is on **new conversation creation** only (source assertion: `assertBuyerBetaChatAccess` absent from the POST route).

`tests/unit/deal-beta-gate.test.ts` (mock db + the canonical recipe; fixtures in the Batch 6 shape — approved listing, verified+active seller, existing conversation; spy on `Deal.create`):

- `createDealAction: buyer WITHOUT active membership → BETA_MEMBERSHIP_REQUIRED, no Deal, no deal_created emitted` (C2 — §7.8 beta-membership status on Deal creation).
- `createDealAction: buyer WITH active membership → deal created + emission fires` (all other Batch 6 guards satisfied by the fixture).
- `createDealAction: the guard runs after assertListingSellerInteractable` — a suspended-membership seller → `SELLER_MEMBERSHIP_INACTIVE` (Batch 6 D2 first), a suspended-membership buyer → `BETA_MEMBERSHIP_REQUIRED` (Batch 7).
- `markDealOutcomeAction is NOT gated by the beta policy` — a member whose membership was suspended AFTER the deal opened can still mark `no_deal`/`cancelled` (and `success` — Batch 6 D10's own guards apply: actor suspension + block-for-success); source assertion: `assertBuyerBetaChatAccess` absent from `markDealOutcomeAction`.

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/unit/beta-access.test.ts tests/unit/chat-beta-gate.test.ts tests/unit/deal-beta-gate.test.ts`
Expected: FAIL — module missing / guards not wired.

- [ ] **Step 3: Implement + wire**

- `src/lib/beta-access.ts` per the interface block — one fresh `BetaCohortMembership` read, `where({ userId, status: "active" })` + cohort ∈ allowlist.
- `src/lib/actions/chat.ts`: insert `await assertBuyerBetaChatAccess(user.id)` at the C1 point (the merged Batch 6 file's create branch, after `assertListingSellerInteractable`, before `Conversation.create`). Nothing else changes.
- `src/lib/actions/deals.ts`: insert `await assertBuyerBetaChatAccess(user.id)` into `createDealAction` after `assertListingSellerInteractable`, before `requireDealConversation` (C2). `markDealOutcomeAction` untouched.

- [ ] **Step 3b: Migrate the earlier-batch chat/Deal fixtures (the Batch 6 B1 pattern — same commit as Step 3; no assertion weakened)**

  The buyer gate changes `startConversationAction`/`createDealAction`'s observable behavior for a **non-member buyer**, so every earlier-batch fixture that creates a conversation or Deal through those actions needs the buyer to hold an active membership. Each file below is edited **exactly once**, in this commit:

  - **`tests/unit/chat-guard.test.ts` (Batch 3)** — the buyer fixtures in the happy-path/create cases gain an active `private_beta_buyer` (or `founding_seller`) membership row in the mock db; every assertion unchanged (the block/suspension cases already assert the earlier guard fires first — the ordering is re-pinned by `chat-beta-gate.test.ts`).
  - **`tests/unit/chat-hardening.test.ts` (Batch 6)** — same buyer-membership fixture addition for its create cases; assertions unchanged.
  - **`tests/unit/telemetry-wiring.test.ts` (Batch 5 Task 8)** — the `startConversationAction` emission cases' buyer fixtures gain the membership; assertions unchanged.
  - **`tests/unit/deal-create.test.ts` (Batch 6 Task 4)** — the buyer fixtures gain the membership (the new `deal-beta-gate.test.ts` cases cover the negative); assertions unchanged.
  - **`tests/integration/block-enforcement.test.ts` + `tests/integration/suspension-enforcement.test.ts` (Batch 3) + `tests/integration/chat-hardening.test.ts` + `tests/integration/deal-lifecycle.test.ts` (Batch 6)** — every fixture that calls `startConversationAction`/`createDealAction` seeds an active buyer membership (a real `BetaCohortMembership` row) beside the Batch 6 verified-seller shape; assertions unchanged. (Fixtures that create `Conversation`/`Deal` rows directly via `db.orm.public.*.create` bypass the actions and need nothing.)
  - Record the migration in the Task 8 verification doc (the "buyer-gate fixture migration" line — the Batch 6 B1 precedent).

- [ ] **Step 4: Integration test**

`tests/integration/beta-access-enforcement.test.ts` (real DB; the canonical stubbing recipe; **`AUTH_SECRET` + `PRODUCT_EVENT_PSEUDONYM_KEY` set in `beforeAll`**; fixture users as real rows in the Batch 6 verified-seller + approved-listing shape):

- `a non-member buyer cannot start a conversation against a live approved listing; a private_beta_buyer member can` — seed seller (verified + active membership + approved listing) + two buyers; `startConversationAction` → `BETA_MEMBERSHIP_REQUIRED` vs success (the §2.1 gate end-to-end).
- `a non-member buyer cannot create a Deal; a member can` — same fixtures + an existing conversation per buyer; `createDealAction` → `BETA_MEMBERSHIP_REQUIRED` vs success (C2 end-to-end).
- `suspending the buyer's membership blocks new conversations AND new deals immediately (fresh DB read)` — grant → start/create (ok) → `setBetaMembershipAction` suspend (Batch 2 action, ops fixture) → start/create → `BETA_MEMBERSHIP_REQUIRED` (Review Focus 3, real DB).
- `an open Deal stays markable after the buyer's membership is suspended` — Batch 6 D10's guards apply, not the beta policy (the marking succeeds; actor suspension would block it — pinned separately by Batch 6's suites).
- `lifting/reactivating: re-granting active membership restores access` (the admin operation path, §8.4).

- [ ] **Step 5: Run until green**

Run: `npm test -- tests/unit/beta-access.test.ts tests/unit/chat-beta-gate.test.ts tests/unit/deal-beta-gate.test.ts` → PASS.
Run: `npm test` → full unit suite green — **including the eight migrated fixture files (no assertion weakened — Step 3b)**.
Run: `npm run test:integration` → `beta-access-enforcement.test.ts` + all earlier suites PASS (Batch 3's `chat-guard`/`block-enforcement`/`suspension-enforcement`, Batch 6's `chat-hardening`/`deal-*` suites stay green — the guard is additive, the fixtures migrated).

- [ ] **Step 6: Commit**

```bash
git add src/lib/beta-access.ts src/lib/actions/chat.ts src/lib/actions/deals.ts tests/unit/beta-access.test.ts tests/unit/chat-beta-gate.test.ts tests/unit/deal-beta-gate.test.ts tests/integration/beta-access-enforcement.test.ts tests/unit/chat-guard.test.ts tests/unit/chat-hardening.test.ts tests/unit/telemetry-wiring.test.ts tests/unit/deal-create.test.ts tests/integration/block-enforcement.test.ts tests/integration/suspension-enforcement.test.ts tests/integration/chat-hardening.test.ts tests/integration/deal-lifecycle.test.ts
git commit -m "feat(cohort): buyer beta access policy on new conversations and deals"
```

(The last eight paths are the Step 3b fixture-migration files — Batch 3/5/6 test files, edited exactly once by this commit, assertions not weakened.)

## Task 7: Suspended-membership enforcement proof across every gated surface

**Files:**

- Test: `tests/unit/suspended-membership-enforcement.test.ts`
- Test: `tests/integration/suspended-membership-enforcement.test.ts`

**Interfaces:**

- Consumes: `setBetaMembershipAction` (Batch 2 — the suspension *mechanism*, reused as-is), `checkSellerPublicationRequirements`/`assertSellerPublicationAllowed` (Batch 2), `assertListingPublishable`/`checkListingPublication` (Batch 4), `assertListingSellerInteractable` (Batch 6 D2 — the seller-side chat/Deal guard), `assertBuyerBetaChatAccess`/`isActiveBetaParticipant` (Task 6), `assertCanStartConversation` (Batch 3), `createDealAction` (Batch 6 + Task 6), the four listing transitions (Batch 2/4), `approveListingAction` (Batch 2/4/5).
- Produces: no new product code — this task **proves** the spec §9 Batch 7 Gate items "suspended membership enforcement" and "seller cohort + verification publication requirement" end-to-end, and is the batch's defense that Batch 7 did not weaken the Batch 2/3/6 gates it inherited. If any case fails, the fix lands in the **owning** batch's module (Batch 2's policy, Batch 4's wrapper, Batch 6's guard, Task 6's guard) with its own unit test — not in this test file.

- [ ] **Step 1: Write the failing unit tests**

`tests/unit/suspended-membership-enforcement.test.ts` (mock db; a fully-verified seller fixture — the Batch 6 verified-seller shape: `emailVerifiedAt`/`phoneVerifiedAt`/`sellerType`/`sellerOperatingProvinceCode`/`PolicyAcceptance(seller_rules, v1)`/`SellerVerification(verified)`/`BetaCohortMembership(founding_seller, active)` + an `approved` listing; then flip **only** the membership to `suspended`):

- `checkSellerPublicationRequirements: suspended founding_seller membership → missing includes founding_seller_membership_active` (Batch 2 gate — re-pinned for Batch 7's gate).
- `assertListingPublishable: suspended membership → SELLER_PUBLICATION_BLOCKED before any content check` (Batch 4 wrapper inherits the Batch 2 gate — order pinned).
- `createListingAction: suspended-membership seller → typed error, no Listing.create` (spec §4.4/§4.9).
- `updateListingAction: content-change → pending blocked for a suspended-membership seller`.
- `toggleListingVisibilityAction: hidden → approved blocked for a suspended-membership seller` (silent return, status unchanged).
- `approveListingAction (admin): approving a listing whose seller's membership is suspended → no approval + audit "listing.approve_blocked"` (defense-in-depth — Review Focus 3).
- `all four transitions pass when the membership is active` (the guard does not over-block).
- `assertListingSellerInteractable: suspended-membership seller → SELLER_MEMBERSHIP_INACTIVE` (Batch 6 D2 — the seller-side chat/Deal leg, re-pinned; **not re-implemented** — the test calls Batch 6's guard).
- `startConversationAction: a buyer starting a conversation ON a suspended-membership seller's live listing → SELLER_MEMBERSHIP_INACTIVE (Batch 6 D2), no Conversation` — the seller side is Batch 6's; `startConversationAction: a suspended-membership member as BUYER → BETA_MEMBERSHIP_REQUIRED` (Task 6 — the buyer leg).
- `createDealAction: a suspended-membership seller's listing → SELLER_MEMBERSHIP_INACTIVE (Batch 6 D2); a suspended-membership buyer → BETA_MEMBERSHIP_REQUIRED (Task 6)` — both legs of the Deal surface.
- `isActiveBetaParticipant: suspended membership → false` (Task 6's read).
- `the seller's LIVE listings stay live and readable while suspended` — `isListingSearchable("approved")` unchanged, the listing row untouched (suspension blocks **new** publication, not existing inventory — Batch 3 A2 precedent); removal of a suspended seller's live listings is a moderator decision through the Batch 3 takedown, not automatic. **New conversations/Deals on those listings are refused** (Batch 6 D2 — `SELLER_MEMBERSHIP_INACTIVE`), and the listing-page CTAs render Batch 6 D12's neutral copy.

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/unit/suspended-membership-enforcement.test.ts`
Expected: **PASS or FAIL — record which.** These cases exercise already-implemented gates (Batch 2/4/6 + Task 6); a failure means an inherited gate regressed or a Batch 7 task weakened it — fix the owning module with its own unit test, not here. A first-run pass is acceptable and recorded (the Batch 4 Task 8 / Batch 6 Task 7 precedent).

- [ ] **Step 3: Write the integration test — the suspended-membership gate (real DB)**

`tests/integration/suspended-membership-enforcement.test.ts` (real DB; the Batch 6 verified-seller fixture pattern — `tests/integration/chat-hardening.test.ts`'s seller shape; the canonical stubbing recipe; `AUTH_SECRET` + `PRODUCT_EVENT_PSEUDONYM_KEY` set in `beforeAll`):

- `full happy path → suspend → every gate closes → reactivate → every gate opens`: seed the verified seller + beta-category listing (approved) → `checkSellerPublicationRequirements` → `{ ok: true, missing: [] }` → `setBetaMembershipAction` suspend (ops fixture, Batch 2 action — audited `beta_cohort.membership_set`) → `checkSellerPublicationRequirements` → `{ ok: false, missing: ["founding_seller_membership_active"] }` → `submitListingAction` on a draft → blocked → `approveListingAction` on a pending listing → blocked + `listing.approve_blocked` audit → `startConversationAction` (a member buyer on the seller's listing) → `SELLER_MEMBERSHIP_INACTIVE` (Batch 6 D2) → `createDealAction` → `SELLER_MEMBERSHIP_INACTIVE` → the seller as buyer on another seller's listing → `BETA_MEMBERSHIP_REQUIRED` (Task 6) → the live approved listing **still renders publicly** (searchable) → `setBetaMembershipAction` active → every gate reopens (the §9 Batch 7 Gate: "suspended membership enforcement" + "seller cohort + verification publication requirement", end-to-end).
- `the suspension audit trail`: `AuditEvent` rows exist for `beta_cohort.membership_set` (Batch 2's action, with the suspended status in `detail`) with actor/reason/session — nothing in Batch 7 bypasses the audited mechanism (the console links to `/admin/users` where Batch 2's forms live; the Task 8 source scan proves no Batch 7 file imports `setBetaMembershipAction` as a second mutation surface).

- [ ] **Step 4: Run until green**

Run: `npm run test:integration` → `suspended-membership-enforcement.test.ts` + all earlier suites PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/suspended-membership-enforcement.test.ts tests/integration/suspended-membership-enforcement.test.ts
git commit -m "test(cohort): prove suspended membership enforcement across gates"
```

## Task 8: Batch 7 gate verification + verification doc

**Files:**

- Create: `docs/operations/private-beta-batch7-cohort-operations-verification.md`

- [ ] **Step 1: Run every gate suite and record results** (spec §9 Batch 7 Gate → named tests)

```bash
npm test -- tests/unit/founding-sellers.test.ts tests/unit/founding-seller-lifecycle.test.ts   # lifecycle + transitions + masking + funnel sync
npm test -- tests/unit/founding-seller-invite.test.ts                                          # invite acceptance (unit): single-use,
                                                                                               # channel binding, enumeration-safe, rate limits,
                                                                                               # transaction sentinels, membership upsert
npm run test:integration                                                                       # invite acceptance (real DB), suspended
                                                                                               # membership enforcement, beta-access enforcement,
                                                                                               # batch7-migration (§8.4 delta) + Batch 1–6 suites
                                                                                               # (8 fixture files migrated — Task 6 Step 3b)
npm test -- tests/unit/beta-access.test.ts tests/unit/chat-beta-gate.test.ts tests/unit/deal-beta-gate.test.ts   # buyer beta access policy + chat/Deal gates
npm test -- tests/unit/suspended-membership-enforcement.test.ts                                # suspended membership enforcement (unit)
npm test -- tests/unit/beta-cohort-console.test.ts                                             # console authorization + PII minimization + no-write-in-render
npm test -- tests/unit/product-events.test.ts tests/unit/telemetry-wiring.test.ts              # cohort telemetry seams still green
                                                                                               # (seller_invited/seller_registered/beta_membership_activated)
npm test -- tests/unit/rbac.test.ts tests/unit/publication-gate.test.ts tests/unit/seller-verification-policy.test.ts   # Batch 2 gates unchanged
```

- [ ] **Step 2: Backend-enforcement + privacy source scans**

```bash
rg -n "requireCapability" src/lib/actions/founding-sellers.ts app/admin/beta-cohort   # expect: every privileged action/page's first guard
rg -n "beta_cohort.manage" src/lib/rbac.ts                    # expect: Batch 2 matrix unchanged — Batch 7 added no capability
rg -n "STEP_UP_CAPABILITIES" src/lib/rbac.ts                  # expect: unchanged (no cohort step-up invented)
rg -n "contactReference" app/admin src/components/founding-seller-console.tsx   # expect: only maskContact call sites — no raw render
rg -n "token" src/lib/actions/founding-sellers.ts | rg -v "tokenHash|BetaInviteToken|inviteUrl"   # classify every hit — no raw-token log/audit/telemetry
rg -n "sp_invite" src/lib/actions/founding-sellers.ts 'app/invite/[token]/page.tsx' app/invite/page.tsx   # expect: cookie read/clear + the one-time set — never a log/audit/next param
rg -n "BetaCohortMembership" scripts src/lib/actions src/prisma   # expect: creators = acceptInviteAction + setBetaMembershipAction (Batch 2) ONLY — no seed/backfill (§8.4)
rg -n "setBetaMembershipAction" src/lib/actions/founding-sellers.ts src/components/founding-seller-console.tsx app/admin/beta-cohort   # expect: 0 hits — no second membership-mutation surface
rg -n "emitProductEvent" src/lib/actions/founding-sellers.ts                  # expect: exactly seller_invited, seller_registered, beta_membership_activated (the last conditional on activated)
rg -n "assertBuyerBetaChatAccess" src/lib/actions/chat.ts src/lib/actions/deals.ts   # expect: create branch of startConversationAction + createDealAction only — NOT markDealOutcomeAction
rg -n "AuditEvent|auditEvent" src/lib/product-events.ts                        # expect: 0 hits (S10 held)
rg -n "dangerouslySetInnerHTML" app/admin/beta-cohort src/components/founding-seller-console.tsx src/components/founding-seller-forms.tsx src/components/invite-accept-form.tsx   # expect: 0 hits
rg -n "đảm bảo|bảo đảm|guarantee|thưởng|reward" app/admin/beta-cohort src/components/founding-seller-console.tsx 'app/invite/[token]' app/invite   # expect: 0 hits (§4.2 + no invented incentives)
rg -n "an toàn khu vực|khu vực an toàn|verified market" src/lib/founding-sellers.ts src/lib/founding-seller-vocab.ts app/admin/beta-cohort   # expect: 0 hits (§4.7)
rg -n "PROVINCE_CODES|isProvinceCode" src/lib/founding-sellers.ts src/lib/founding-seller-vocab.ts src/lib/actions/founding-sellers.ts app/admin/beta-cohort   # expect: consumed from src/lib/provinces.ts (Batch 2 Task 10, FD-1) — never re-defined
rg -n "FINANCIAL_FEATURES_ENABLED" .env.example docker-compose.prod.yml scripts # expect: still "false" everywhere
```

Manually classify every hit; fix any violation in the owning module with its own test.

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

- `git diff --check`; `git status --short` contains only Batch 7 files; no `.claude/settings.json`, no `public/uploads/`, no secrets, no scratch.
- `npx prisma migration list` shows the linear graph `baseline → batch2 → batch3 → batch4 → batch5 → batch6 → batch7` (T2 — no node with two outgoing edges); `npx prisma db verify` clean.
- Inspect the migration once more: zero destructive ops; zero data transforms (`pendingPlaceholders: false`); the partial unique index `beta_invite_one_active` present; the §8.4 no-auto-membership delta case green.

- [ ] **Step 5: Write the verification doc**

`docs/operations/private-beta-batch7-cohort-operations-verification.md` records: base (merged Batch 6 commit) and final commit hashes; OpenCode model/session metadata; per-gate test results (the five spec §9 Batch 7 gate items → named suites, verbatim mapping: seller cohort authorization → `beta-cohort-console` + `founding-seller-lifecycle` role matrix; invite acceptance → `founding-seller-invite` unit + integration; suspended membership enforcement → `suspended-membership-enforcement` unit + integration; seller cohort + verification publication requirement → `suspended-membership-enforcement` + the Batch 2 `publication-gate`/`seller-verification-policy` suites re-run green; cohort telemetry → `product-events`/`telemetry-wiring` + the Task 3 emission tests); the source-scan classification table; migration review notes (additive-only, zero transforms, §8.4 delta pinned, the partial unique index); **the Task 6 Step 3b fixture-migration record** (the eight files, buyer memberships added, no assertion weakened — the Batch 6 B1 precedent); the operational-targets statement (20–50 / 100–300 rendered as targets, not gates — §12.1 founder approval is the gate); the recorded decisions D1–D4; the C1/C2 outcomes (the buyer gate landed in `startConversationAction`'s create branch and `createDealAction`; `markDealOutcomeAction` deliberately ungated per Batch 6 D10/D2); residual risks (the one-time `/invite/<token>` URL in the invitee's browser history + nginx access log before the cookie redirect — contained by the HttpOnly cookie, the tokenless `next`, and `Referrer-Policy: no-referrer`; invite delivery is out-of-band — a leaked link is revocable but not retroactively for an already-accepted invite; the in-memory rate-limiter topology caveat; the funnel sync is operator-triggered — the stored status can lag ground truth between syncs, the console shows live reads beside it; browser E2E still deferred — tracked pre-invite prerequisite per spec §10/§12); deferred items (buyer invitation flow A4, quality-listing definition A3, invitation email/SMS A1 per FD-2, inactive-reactivation A5, retention); the **Batch 8 Founder Decision Register hand-off list** (every PROVISIONAL item — see *Ambiguities*); and the explicit statement that **beta-launch readiness additionally requires** the founder decisions in *Ambiguities* — those are launch prerequisites, not Batch 7 gate failures.

- [ ] **Step 6: Commit**

```bash
git add docs/operations/private-beta-batch7-cohort-operations-verification.md
git commit -m "test(batch7): verify cohort operations gate"
```

## Acceptance Gate

Batch 7 is accepted only if all of the following are true (spec §9 Batch 7 Gate — every item maps to named tests):

- **Seller cohort authorization** — `tests/unit/beta-cohort-console.test.ts` (page guard + nav filtering + masked contact + no reveal action + no-write-in-render) + `tests/unit/founding-seller-lifecycle.test.ts` + `tests/unit/founding-seller-invite.test.ts` (moderator/support/analyst/non-admin → FORBIDDEN on every action; `beta_cohort.manage` is Batch 2's matrix, unchanged; no step-up invented).
- **Invite acceptance** — `tests/unit/founding-seller-invite.test.ts` + `tests/integration/founding-seller-invite.test.ts`: single-use (atomic claim, concurrent double-accept → `INVITE_INVALID`), expiring, unguessable 256-bit tokens stored only as keyed HMAC, enumeration-safe failure modes (byte-identical `INVITE_INVALID` for unknown/expired/revoked), channel binding (matching **and verified** email/phone, read from a fresh `User` row — mismatch/unverified → typed error, no membership, **token unconsumed**), membership upsert semantics (`invited` → `active` + emission; `active` → `acceptedAt` only, no emission; `suspended`/`exited` → refusal **before** the claim), suspended-account refusal (§7.3), rate limits (§7.1 "beta invite acceptance"), revocation + re-issue, transaction sentinels with **no silent-success commit** (the 23505 classify cases), and the acceptance → `BetaCohortMembership(founding_seller, active, acceptedAt)` → candidate `registered` path.
- **Suspended membership enforcement** — `tests/unit/suspended-membership-enforcement.test.ts` + `tests/integration/suspended-membership-enforcement.test.ts`: a suspended `founding_seller` membership blocks all four publication transitions (create/update/toggle/admin-approve — the last with `listing.approve_blocked` audit), blocks new conversations **and** Deals on the seller's listings (`SELLER_MEMBERSHIP_INACTIVE` — Batch 6 D2, re-proven not re-implemented), blocks the member as buyer (`BETA_MEMBERSHIP_REQUIRED` — Task 6), leaves live listings readable/searchable, and every gate reopens on re-activation — all through the **existing** Batch 2/3/4/6 mechanisms, re-proven, never re-implemented.
- **Seller cohort + verification publication requirement** — the Batch 2 `publication-gate` + `seller-verification-policy` suites re-run green unchanged (the eight-requirement gate including `founding_seller_membership_active` + `account_not_suspended`), plus the integration case proving `founding_seller_membership_active` flips from missing to satisfied exactly at invite acceptance.
- **Cohort telemetry** — `seller_invited` (issuance, actor null), `seller_registered` (acceptance, actor = user), `beta_membership_activated` (**only** on the acceptance paths that report `activated: true` — Batch 5 S7 semantics; Batch 5's `setBetaMembershipAction` wiring unchanged) all emitted through Batch 5's `emitProductEvent` with per-event schema validation, pseudonymized actors, and **zero contact-reference PII in any event** (integration scan); the Batch 5 `product-events`/`telemetry-wiring` suites stay green (fixtures migrated, no assertion weakened).
- **Operations can manage 20–50 invited founding sellers / 100–300 quality listings** — the console renders the §5.10 display list + the supply-readiness **operational targets** with live counts (invited founding sellers, verified founding sellers, approved listings by founding sellers, ops-sampled quality count); no hard-coded gate exists (source assertion); the §12.1 founder-approval gate is documented as the actual control.
- **§8.4 held** — no auto-membership: the migration has zero data transforms, the integration test proves a freshly created user gains zero memberships (delta), and the source scan shows the only membership creators are the invitation acceptance and Batch 2's audited `setBetaMembershipAction`.
- **Batch 1–6 preserved — with the recorded fixture migration** — every finance, identity, moderation, listing, search/telemetry, chat/Deal suite stays green; the **only** earlier-batch test edits are the Task 6 Step 3b fixture migration (eight files, buyer memberships added, no assertion weakened — recorded in the verification doc); `FINANCIAL_FEATURES_ENABLED=false`; `src/lib/rbac.ts`, `beta-cohort.ts`, `session.ts`, `otp.ts`, `audit-event.ts`, `seller-verification-policy.ts`, `product-events.ts`, `provinces.ts`, `moderation.ts` untouched (read-only consumption); the migration is additive-only with a linear graph (T2).
- Preflight (lint, typecheck, unit, build, compose, migration graph), the integration suite, safe smoke, and a clean diff/status audit all pass.

## Threat-Case Coverage Map (spec §10.1 rows applicable to Batch 7)

| Abuse case | Covered by |
|---|---|
| Beta-cohort bypass | Task 3 channel binding + atomic claim + membership-upsert refusal (`founding-seller-invite.test.ts` mismatched/unverified/consumed/suspended-membership cases) + Task 7 suspended-membership suite (all four publication surfaces + the Batch 6 chat/Deal guards + the Task 6 buyer gate) |
| Privilege escalation / Support → admin escalation | Task 3/4 per-action role matrix (moderator/support/analyst → FORBIDDEN) + Task 5 page guard + Task 8 `rbac.ts` unchanged scan |
| Account enumeration | Task 3 enumeration-safe acceptance (byte-identical `INVITE_INVALID`; no existence oracle for other users' candidates) + rate limits on acceptance |
| Invite brute force / flooding | 256-bit unguessable tokens + `BETA_INVITE_ACCEPT_RATE` (10/10 min) + `FOUNDING_SELLER_INVITE_RATE` (20/h/admin) — Task 3 rate tests |
| Session fixation / reuse after recovery | Not a Batch 7 surface — Batch 2 suites re-run green in Task 8; invite acceptance creates no session (requires an existing one) |
| CSRF on state-changing actions | Next.js 16 server actions are POST-only with built-in origin protection (repo posture, re-recorded in the verification doc — no custom token layer, same as Batches 2–6) |
| Stored XSS through console notes / invite copy | React text-only rendering + Task 5/8 `dangerouslySetInnerHTML` source scans (zero hits) |
| PII exposure (contact references) | `maskContact` rendering + no reveal action (A2 fail closed) + `redactDetail` on notes/audit + §4.8 telemetry scan (integration: no contact string in any `ProductEvent`) + the S1 cookie flow (token never in `next`/form/subsequent URLs) |
| Suspended-user publication bypass | Task 7 `suspended-membership-enforcement.test.ts` (Batch 2/4 gates re-proven for membership suspension) |
| Suspended-user chat/Deal bypass | Batch 6 D2 (`SELLER_MEMBERSHIP_INACTIVE` — re-pinned in Task 7) + Task 6 buyer gate (`BETA_MEMBERSHIP_REQUIRED`) + Batch 3's actor-side suites green |
| Concurrent candidate/invite update | Task 3 atomic consume claim + 23505 classify cases (`beta_invite_one_active` / `FoundingSellerCandidate_userId_key` / `BetaCohortMembership_userId_cohort_key`) + Task 4 `CANDIDATE_ALREADY_MOVED` atomic status claim (§10.1 "Concurrent … update") |
| Historical finance escape-hatch abuse | Batch 1 suites re-run in Task 8; no Batch 7 surface touches finance; the source scan proves no finance module gained a cohort/telemetry call |

## Ambiguities and Deployment Prerequisites

Recorded per spec §4.11/§11.1 + **FD-3** (`/tmp/loaviet/founder-decisions.md`): proceed with the fail-closed default each item already has — do not stop execution waiting for founder input; items needing founder-**authored content** or founder **acknowledgment** ship as clearly-marked PROVISIONAL/pending mechanisms and land in the **Batch 8 Founder Decision Register** as launch blockers — never invented. None is silently resolved by implementation:

1. **A1 — launch prerequisite (FD-2): invitation delivery channel.** The spec ships no production email/SMS provider (Batch 2 A1; **FD-2 defers it** — implementation proceeds with the fail-closed adapter) and §5.10.1 concierge onboarding is human work. Batch 7's fail-closed default: the operator delivers the invite URL out-of-band (the concierge conversation is the channel); the platform never emails/SMSes. *Batch 8 register: any platform-delivered invitation (and therefore fully self-serve invitation at beta scale) until a provider lands behind a delivery adapter — the operator workflow is the launch-ready path.*
2. **A2 — launch prerequisite (console PII): the `pii.view_sensitive` Scoped/Step-up cells.** §5.4.1 gives operations_admin "Scoped + audited" sensitive-PII access; the scope is undefined (Batch 2 A2). Batch 7 fails closed: the console renders **masked** contact references only, and **no reveal action exists**. *Batch 8 register: the Scoped semantics (the operator works from their own recruitment-channel contact meanwhile — the §5.10.1 reality).*
3. **A3 — launch prerequisite (metric): "quality listing" definition.** §5.10's `qualityListingCount` and §12.1's "100–300 quality listings" have no definition; Batch 4 A1/A2 (condition definitions, checklist requiredness) are themselves founder-gated, and Batch 5 A5 already recorded the term as undefined. Batch 7 stores the field, renders it, and provides an **ops-set** action (§12.1 "listing quality is manually sampled") — the system never auto-computes it, and the supply-readiness view shows the factual approved-listing count beside it. *Batch 8 register: the definition (Batch 4's vocabulary review is the prerequisite) — until then any automated quality-listing gate or metric is blocked.*
4. **A4 — launch prerequisite (policy): buyer cohort acquisition.** §2.1 defines `private_beta_buyer` but §12.1 gates "broader private-beta buyer invitations" on supply readiness + explicit founder approval, and the spec never defines how buyers are invited. Batch 7 ships the buyer **access policy** (the chat/Deal gate + the membership model) but no buyer invitation flow — buyer memberships are granted through Batch 2's audited `setBetaMembershipAction` (§8.4 admin operation, via `/admin/users`). *Batch 8 register: buyer invitation campaigns until the founder approves supply readiness (§12.1) and specifies the acquisition mechanism.*
5. **A5 — recorded (founder ruling pending): reactivation from `inactive`.** The spec's lifecycle shows `inactive → exited` only; whether an inactive candidate can re-enter (and in which state) is undefined. Batch 7 pins `inactive → exited` as the only legal transition (`canTransitionCandidate` denies `inactive → active_founding_seller`). *A reactivation path is a one-line transition-table addition.*
6. **A6 — recorded (founder ruling pending): membership-suspension sanction semantics.** Suspending a `founding_seller` membership blocks new publication and new conversations/Deals on the seller's listings (proven, Task 7) but does **not** unpublish live listings (Batch 3 A2 precedent — removal is a moderator takedown decision), does not revoke sessions (Batch 3's revised posture — revocation without a login block is sanction policy), does not kill messages inside existing conversations (§2.1 restricts **creation** only; §7.8's message-level beta-membership consideration is recorded here rather than invented — a suspended member's open conversations stay writable until account-level suspension or a block closes them), and has no auto-expiry/duration. *Founder decides sanction policy; the fail-closed manual mechanism ships.*
7. **A7 — recorded (founder ruling pending): `targetCommunity` semantics.** §5.10's `targetCommunity` is read as the canonical **slug** province code (FD-1 registry) of the community the recruitment targets (any valid code — §5.9.1 allows organic participation beyond Hà Nội/TP.HCM; no restriction to the two beta markets is invented). *Founder may want it restricted to the cold-start markets during the controlled beta — a one-line validation change.*

## Batch 8 Founder Decision Register hand-off (FD-3 provisional items — every PROVISIONAL reading this plan ships)

Per FD-3 these ship as the fail-closed default now and are **launch blockers / founder-acknowledgment items in the Batch 8 register**, never invented further:

- The §5.10 **transition table** (`FOUNDING_SELLER_TRANSITIONS`) and the **reason-code vocabulary** (`FOUNDING_SELLER_TRANSITION_REASONS` — PROVISIONAL marker in the module header, the Batch 3 A8 pattern).
- The **manually-settable state set** (`MANUALLY_SETTABLE_STATUSES`).
- **Invite only for `prospect`/`invited`** (pre-registration re-invite reading).
- The **rate values** (`FOUNDING_SELLER_INVITE_RATE` 20/h/admin, `BETA_INVITE_ACCEPT_RATE` 10/10 min) and the **note/source caps**.
- **`BETA_CHAT_ALLOWED_COHORTS` including `internal`** (internal users may start buyer-side conversations).
- **`seller_registered` emitted at acceptance** (the "registered" reading of §5.10).
- The **verified-channel binding** reading (acceptance requires the invite's contact to match a **verified** email/phone of the accepting account — §2.1 "required authentication state").
- The **invite-acceptance-as-§8.4-"admin operation"** reading (acceptance is the second audited membership writer beside Batch 2's action).
- The **C2 outcome**: the buyer gate on `createDealAction` (§7.8 beta-membership status on Deal creation; `markDealOutcomeAction` deliberately ungated per Batch 6 D10/D2).
- **D3** (`BETA_CHAT_REQUIRES_ACTIVE_MEMBERSHIP = true` — the §2.1 "if operations requires" reading that decides whether any buyer can chat at launch) and the **token-in-URL residual risk** (the one-time `/invite/<token>` GET in browser history/nginx logs, contained by the cookie flow).
- A1–A4 above (invitation delivery per FD-2, Scoped-PII semantics, quality-listing definition, buyer acquisition per §12.1).

## Recorded Decisions (reversible readings, the Batch 2 A5 / Batch 5 D1–D4 pattern; per FD-3 each ships as the safe default and is flagged in the verification doc)

- **D1 — `FOUNDING_SELLER_INVITE_TTL_DAYS = 14`.** The spec requires expiring invites but gives no TTL. 14 days fits human-paced concierge recruitment; it is a tunable constant in the vocab module, not an env value (§4.10 posture). Reversible by editing the constant.
- **D2 — "seller needing assistance" = active-funnel candidate with `lastContactAt` null or older than 7 days.** §5.10 requires the console to show "seller needing assistance" without defining it. The 7-day threshold is an ops heuristic rendered as a badge, explicitly **not** an SLA (none exists in the spec). Reversible constant/logic.
- **D3 — `BETA_CHAT_REQUIRES_ACTIVE_MEMBERSHIP = true` — a READING of §2.1, not a spec default (S8).** §2.1 says P0 "should support" restricting new-conversation creation to active beta participants "**if operations requires** a tightly controlled test cohort" — the private beta **is** that cohort (§2.1 opening: "Private beta is enforced through explicit cohort membership"), so the fail-closed reading ships **on**, as a server-owned constant (not env, not client — §4.9/§4.10). **This value decides whether any buyer can chat at launch** — it requires founder acknowledgment (Batch 8 register); flipping it off for a more open beta is a reviewed code change. The buyer-grant path is documented: `/admin/users` → Batch 2's audited `setBetaMembershipAction` (no buyer invitation flow in P0 — A4).
- **D4 — the buyer gate is initiator-only; the seller side is Batch 6 D2's.** `assertBuyerBetaChatAccess` checks the **initiator** (the conversation's buyer / the Deal's buyer per Batch 6 D11); the listing's seller is checked by Batch 6's `assertListingSellerInteractable` (`SELLER_SUSPENDED`/`SELLER_NOT_VERIFIED`/`SELLER_MEMBERSHIP_INACTIVE`), already in place on the create branch — the two guards compose, and Batch 7 adds no counterpart check of its own (the earlier "counterpart-side membership blocking is not enforced" reading is **superseded** by Batch 6 D2 @ `88d7c2d`). Reversible by adding a counterpart check to the Task 6 guard.

## Rollback and Data Backfill

- **Migration** (`batch7_cohort_operations`): additive-only, zero data transforms (verified via `npx prisma migration show` — zero destructive ops, `pendingPlaceholders: false`). Rollback = `git revert` of the Task 1 commit **plus** restore from the pre-migration backup per `docs/backup-restore.md`; no down-migration is authored (the Prisma 8 graph is forward-only). Production applies via the compose `migrate` service `--to production` after the ref advance in Task 1.
- **No backfill, by design (§8.4).** No legacy candidate/invite/cohort data exists; auto-membership is forbidden; the §8.6 requirements are satisfied trivially (dry-run = "0 rows", no `--apply`, nothing to roll back) — pinned by the Task 1 delta case.
- **Invite tokens**: append-only rows; revocation is a flag, consumption a timestamp — no product path deletes a `BetaInviteToken` (the audit trail survives). Rollback of a bad invite = `revokeInviteAction` (audited), never a delete.
- **Cohort memberships**: created only by invitation acceptance (Task 3) or Batch 2's audited `setBetaMembershipAction`; suspension/reactivation goes through the same Batch 2 action (audited `beta_cohort.membership_set`) — Batch 7 adds no second membership-mutation path (the console links to `/admin/users` where Batch 2's forms live; the Task 5 source scan pins it).
- **Per-task rollback**: every task is one focused commit; `git revert <task-commit>` restores the previous behavior for all non-migration tasks. Task 6's `chat.ts`/`deals.ts` revert restores the pre-Batch-7 guard order (Batch 3/6 guards intact — they are never in the same hunk) **and** reverts the eight fixture migrations with it (same commit).

## Final Acceptance Commands

```bash
npm run lint
npx tsc --noEmit
npm test
npm run test:integration
npm run build
npm run preflight
npm run smoke
npx prisma migration list          # graph: baseline → batch2 → batch3 → batch4 → batch5 → batch6 → batch7 (tuyến tính — T2)
npx prisma db verify               # marker + schema khớp contract
git diff --check && git status --short
```

All green + the gate suites in Task 8 Step 1 + a clean diff/status audit = Batch 7 complete. Per **FD-3**, the recorded ambiguities and decisions above ship as their safe/fail-closed defaults now; beta-launch readiness **additionally** requires the founder-authored/acknowledgment items in the **Batch 8 Founder Decision Register** (A1 invitation delivery per FD-2, A2 Scoped-PII semantics, A3 quality-listing definition, A4 buyer acquisition per §12.1, D3 the buyer-chat default, and the PROVISIONAL vocabulary items) — those are launch prerequisites, not Batch 7 gate failures, and the verification doc must say so verbatim.
