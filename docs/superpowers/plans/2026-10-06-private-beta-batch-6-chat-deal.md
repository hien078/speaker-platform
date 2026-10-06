# Private Beta Batch 6 — Chat Hardening and Deal Outcome Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every chat read/write/poll path participant-only and listing-gated (IDOR closed, §7.8 seller-side eligibility enforced on new chat, message length/content limits server-side, polling auth pinned), then ship the §5.2 lightweight Deal — a structurally separate, money-free record with append-only history, concurrency-safe atomic-claim transitions, idempotent per-party outcome marking, and both-party confirmation semantics that emit `successful_match` only on bilateral completion — plus the outcome UI, PII-free notifications, the §6.4 external-payment safety disclaimer, and the four Batch 6 telemetry events wired through Batch 5's `emitProductEvent` — without weakening the Batch 1 finance shutdown or any Batch 2–5 invariant, and without any Deal action creating a `Payment`, `Payout`, `Wallet`, `Ledger`, or `Escrow` record (spec §9 Batch 6 Gate).

**Architecture:** One additive Prisma 8 migration adds **only** the Deal domain: enums `deal_status` + `deal_fulfillment_method`, models `Deal` + `DealStatusHistory`, and relation declarations on `User`/`Listing` — no `listing_status` values (Batch 6 claims the existing `sold` value only via an explicit, seller-chosen `approved → sold` update inside `markDealOutcomeAction`, it does not add enum values), no finance table is touched, and `Deal` carries no money field beyond §5.2's optional user-entered `agreedPrice`. `Deal.conversationId` (nullable, no FK — the Batch 5 `ProductEvent.conversationId` precedent) records the conversation a deal belongs to so deals stay reachable after listing deletion (D9). A client-safe vocabulary module (`src/lib/deal-vocab.ts`) owns the statuses, fulfillment methods, outcome values, rate rules, and the two listing-status seams (`CONVERSATION_STARTABLE_LISTING_STATUSES`, `DEAL_CREATE_LISTING_STATUSES` — both `["approved"]`, drift-tested); a server-only domain module (`src/lib/deal.ts`) owns the §7.8/§5.2 guards and **reuses** Batch 3's moderation guards (`isUserSuspended`, `getBlockState`, `assertCanStartConversation`) instead of duplicating them. Chat hardening edits the two real chat entry points (`startConversationAction`, `POST /api/chat/[id]`) and the wishlist toggle, keeping every Batch 3 guard and every Batch 5 telemetry emission in place (emission stays after all guards and the successful create). Deal actions live in a new `src/lib/actions/deals.ts` ("use server", async-only exports) that never imports a finance module — pinned by a dedicated source-scan + import-graph test (`tests/unit/deal-finance-isolation.test.ts`) proving the §9 gate line "No Deal action creates Payment/Payout/Wallet/Ledger/Escrow". Outcome marking uses per-party atomic claims (`.where({ id, <roleOutcomeAt>: null }).updateAll({...})`, then `.where({ id, status: "open" }).updateAll({...})` for the terminal transition) so concurrent markings resolve deterministically: the transaction returns flags (`{ newMarking, completedClaimed, soldClaimed }`) and **every emission + notification happens after commit** — the bilateral-completion claim winner emits `successful_match` exactly once, a non-success marking by either party transitions the deal unilaterally and never emits a match (mismatched outcomes stay recorded, unresolved — the reconciliation rule is a blocking ambiguity, not invented), and the listing sold transition happens only when the **seller explicitly chooses "đánh dấu tin đã bán"** on their own success marking (D6/FD-3 — never an automatic consequence of bilateral completion).

**Tech Stack:** Next.js 16.3.7 App Router (typed routes, server actions), React 19, TypeScript strict, Prisma 8 (`@prisma/orm-postgres` rc, contract + migration graph), PostgreSQL ≥ 15 (scratch container via `scripts/test-integration.sh`), Vitest (unit + scratch-container integration), zod (deal form validation), `node:crypto` (nothing new — no crypto added in Batch 6). **No new runtime dependency** (Batch 6 adds zero npm packages).

**Spec:** `docs/superpowers/specs/2026-10-06-private-beta-marketplace-reset-design.md` — Batch 6 is spec §9 "Batch 6", built on §2.1 (beta access model — buyer-side chat gating hand-off to Batch 7), §4.1 (No Money Path), §4.2 (No Misleading Promise), §4.5 (Backend Authorization), §4.6 (Auditability), §4.8 (Analytics Privacy), §4.9 (Private-Beta Authorization), §4.10 (No Finance Escape Hatch), §4.11 (Policy Non-Invention), §5.1/§5.1.1 (finance boundary — preserved, untouched), §5.2 (Lightweight Deal Outcome — the Deal contract), §5.5 (blocking semantics — reused from Batch 3), §5.8/§5.8.1 (telemetry events + `successful_match_rate_v1`), §6.1 (public CTA `Tạo thỏa thuận`), §6.4 (Independent Transaction Safety Guidance), §7.1 (endpoint rate limits), §7.3 (authorization abuse), §7.8 (Moderation Enforcement), §8 (migration strategy), §9 Batch 6 deliverables + Gate, §10/§10.1 (verification + abuse matrix), §11/§11.1 (execution protocol + ambiguity stop rule). The plan argues from the spec; executors read both.

**Builds on (all merged before Batch 6 starts):**

- **Batch 1** (`docs/superpowers/plans/2026-10-06-private-beta-batch-0-1-finance-shutdown.md` + `docs/operations/finance-surface-inventory.md`): `src/lib/financial-features.ts` (`assertFinancialFeaturesEnabled`, `FINANCIAL_FEATURES_DISABLED`), the finance shutdown suites (`tests/unit/financial-shutdown-*.test.ts`, `tests/unit/finance-public-surface.test.ts`, `tests/unit/admin-finance-readonly.test.ts`, `tests/integration/escrow.test.ts`), and the inventory's preservation table — `Deal` must be structurally separate from every finance table/action listed there.
- **Batch 2** (`docs/superpowers/plans/2026-10-06-private-beta-batch-2-identity-security.md`): `src/lib/auth.ts` (`requireUser`/`getCurrentUser` — DB-session backed), `SessionUser`, `src/lib/rbac.ts`, `src/lib/session.ts`, `SellerVerification` + `BetaCohortMembership` models (read by the seller-eligibility guard), `src/lib/rate-limit.ts` (`checkRateLimit`), `src/lib/notify.ts` (`notify`), `src/lib/audit-event.ts` (consumed read-only — see Q6 for why Deal actions write no `AuditEvent`).
- **Batch 3** (`docs/superpowers/plans/2026-10-06-private-beta-batch-3-trust-safety.md` — the committed plan; read the latest committed version before executing): `src/lib/moderation.ts` (`assertCanStartConversation`, `assertCanSendMessage`, `getBlockState`, `isUserSuspended`, `MODERATION_LOCKED_LISTING_STATUSES`), `src/lib/moderation-vocab.ts`, `UserBlock`/`UserSuspension` models, the chat guards already wired in `startConversationAction` + `POST /api/chat/[id]`, and its suites (`tests/unit/chat-guard.test.ts`, `tests/unit/block-actions.test.ts`, `tests/integration/block-enforcement.test.ts`, `tests/integration/suspension-enforcement.test.ts`).
- **Batch 4** (`docs/superpowers/plans/2026-10-06-private-beta-batch-4-listing-quality.md` — the committed plan): the extended `listing_status` enum (`removed` Batch 3, `archived` Batch 4), `Listing.provinceLevelCode` (telemetry `provinceCode` source), `src/lib/listing-images.ts` (`LISTING_IMAGE_URL_PATTERN` — reused for the chat imageUrl validation, S3), `ListingImageUpload` (chat image ownership), the publication wrappers Batch 6 never touches, and the recorded hand-off: "`startConversationAction`/`toggleWishlistAction` currently accept non-approved listings — noted in the verification doc as a Batch 6 follow-up (chat/wishlist hardening)" — Batch 6 closes it (Task 3).
- **Batch 5** (`docs/superpowers/plans/2026-10-06-private-beta-batch-5-search-telemetry.md` — the committed plan): `src/lib/product-events.ts` (`emitProductEvent`, `ProductEventName`, `EVENT_SCHEMAS` — Batch 6 extends the four deal-event schemas additively), `src/lib/product-event-key.ts`, `src/lib/telemetry-recorders.ts` (`recordConversationStarted`, `recordBuyerFirstMessage`, `recordFirstResponse` — consumed read-only, emissions must survive the hardening), `ProductEvent`/`SearchAlias` models, `src/lib/search-query.ts` (`SEARCHABLE_LISTING_STATUSES` — a different seam, not reused), and its S7: "Only `deal_*`, `successful_match`, `listing_marked_sold` (Batch 6) … stay forward seams" — Batch 6 wires exactly those.

If an executed batch differs from its plan on a name, adapt the call site to the real name — the capability/guard semantics must not change (Batch 5 rule, kept verbatim).

## Batch 6 Sequencing Rules

*The Batch 6 equivalent of the Batch 3↔4 reconciliation rules (R1–R9) and the Batch 5 sequencing rules (S1–S11) — both are adopted verbatim inside the committed Batch 3/4/5 plans named above; Batch 6 executes last, so its rules also pin the full five-batch order:*

- **Q1 Order:** Batch 6 executes only on the merged Batch 5 commit, after Batch 2, then Batch 3, then Batch 4, then Batch 5 gates pass, in that order (spec §9; R1/S1). Parallel planning ok; parallel execution not. Batch 6 has a **hard dependency** on Batch 5 Task 6 (`emitProductEvent` + `EVENT_SCHEMAS`) because `successful_match` emission is a Batch 6 gate item; if the order must ever flip, Batch 5 Task 6 (the product-event core — it depends only on its own schema) must be extracted and landed first, and Batch 6's Task 4/5 emission calls move behind that commit.
- **Q2 Migration graph:** before Task 1 confirm `migrations/app/refs/db.json` + `refs/production.json` hash **equals Batch 5's migration `to` hash**; plan with the explicit origin — `B5_DIR="migrations/app/<ts>_batch5_search_telemetry"` (the real rendered directory) then `npx prisma migration plan --name batch6_chat_deal --from "$B5_DIR"`; `npx prisma migration list` = `baseline → batch2 → batch3 → batch4 → batch5 → batch6`, no node with two outgoing edges; stale base → delete the uncommitted package + snapshot, re-emit, re-plan; **never hand-merge `ops.json`/`contract.json`/`contract.d.ts`**; Batch 6 adds **no `listing_status` values**, so no `Listing_status_check_*` drop+re-add is expected — **halt on any destructive op**. Never write a bare `<batch5-migration-dir>`/`<ts>_…` placeholder into a runnable command — assign a quoted shell variable (zsh reads `<`/`>` as redirection).
- **Q3 Schema/enum ownership:** Batch 2 owns the identity/security tables; Batch 3 owns `listing_status.removed` + the moderation tables; Batch 4 owns `archived` + the structured listing columns + `ListingImageUpload`; Batch 5 owns `ProductEvent`/`SearchAlias`/`Listing.locationSource`/`Listing.searchTextNormalized` + the location/search enums. **Batch 6 adds ONLY:** enums `deal_status`, `deal_fulfillment_method`; models `Deal` (incl. the nullable `conversationId` column — no FK, the `ProductEvent.conversationId` precedent) + `DealStatusHistory`; `User`/`Listing` relation declarations. No `listing_status` value, no location column, no ProductEvent column, no finance table. Exactly one plan may contain each new column in its contract diff.
- **Q4 File order (every file below carries earlier-batch changes when Batch 6 starts; Batch 6 edits on top of the merged Batch 5 commit and keeps every earlier guard/emission):** `src/lib/actions/chat.ts` + `'app/api/chat/[id]/route.ts'`: **B3 (block/suspension guards) → B5 Task 8 (telemetry emission) → B6 Task 3** (hardening — keep every guard + emission; emission stays after all guards and the successful create). `'app/chat/[id]/page.tsx'`: B3 (block banner + report dialog) → B6 Task 6 (deal panel + safety-guidance mount). `'app/listings/[slug]/page.tsx'`: B3 (report dialog) → B5 Task 8 (view/click emission) → B6 Task 6 (`Tạo thỏa thuận` secondary CTA + seller-eligibility CTA gating). `src/lib/actions/wishlist.ts`: B6 Task 3 only (single owner). `src/lib/product-events.ts`: B5 Task 6 → B6 Task 4 (extend the four deal-event schemas **additively** — typed `dealId` metadata; no existing schema weakened). `src/lib/constants.ts`: B3 (report labels) → B4 (archived + listing labels) → B6 Task 6 (deal labels only, additive). `src/lib/actions/listings.ts`: B2 → B3 (R5 guards) → B4 (Task 4) → B5 (Tasks 2/4) → **Batch 6 never touches it** (the `approved → sold` claim lives in `deals.ts`). **Chat-fixture test files** (B1): `tests/unit/chat-guard.test.ts` + `tests/integration/block-enforcement.test.ts` + `tests/integration/suspension-enforcement.test.ts` (Batch 3) and `tests/unit/telemetry-wiring.test.ts` (Batch 5) are edited **once** by B6 Task 3 — fixture migration to the Batch 4 verified-seller + approved-listing shape + the one superseded pin (see B1/Task 3); no assertion is weakened. All of these go in the file-conflict rules.
- **Q5 Guard reuse, never duplication:** Batch 3's `assertCanStartConversation`/`assertCanSendMessage`/`getBlockState`/`isUserSuspended` and Batch 2's session/RBAC interfaces are **consumed read-only**; Batch 6 adds only the checks Batch 3 explicitly deferred to it (its Scope Decisions: "§7.8 seller-verification-revocation and beta-membership checks on *new chat* (Batch 6 chat hardening … revisit the same §7.8 list)" and "Deal interaction blocking (Batch 6 — no `Deal` model yet)"). Batch 6 never edits `src/lib/moderation.ts`, `src/lib/moderation-vocab.ts`, `src/lib/rbac.ts`, `src/lib/session.ts`, `src/lib/audit-event.ts`, `src/lib/seller-verification-policy.ts`, `src/lib/rate-limit.ts`, `src/lib/notify.ts`, or `src/lib/telemetry-recorders.ts` in any commit.
- **Q6 Telemetry emission ownership (S7 landing):** Batch 6 wires `deal_created`, `deal_outcome_marked`, `successful_match`, `listing_marked_sold` via Batch 5's `emitProductEvent` (schemas shipped in B5 Task 6, extended in B6 Task 4) — **never** writes `ProductEvent` rows directly, **never** emits from a finance module, and **never** puts money semantics (price, agreedPrice) or free text (cancellationReason, message body) in an event payload (§4.8 + B5's "no finance semantics in telemetry"). **`emitProductEvent` writes via `db`, not the action's transaction, and fails open — so every emission and notification happens AFTER the transaction commits**, driven by flags the transaction returns (`{ newMarking, completedClaimed, soldClaimed }`): a rollback can never leave a phantom `successful_match`/`listing_marked_sold` row (S1). `conversation_started` (in `startConversationAction`) and `conversation_buyer_first_message`/`message_first_response` (in the chat POST route) **must survive the hardening** — same call sites, after all guards and the successful create. Batch 6 writes **no `AuditEvent`**: Deal/chat actions are regular-user actions recorded in `DealStatusHistory` (actor, status, note, timestamp); `AuditEvent` stays the privileged-actor domain (Batch 3 Scope Decision precedent — report submission is likewise not audited).
- **Q7 Finance isolation (§4.1/§4.10/§9 Gate):** no Batch 6 file may import or mutate `Order`, `OrderItem`, `Payment`, `Payout`, `WithdrawRequest`, `LedgerEntry`, `Dispute`, `Cart`, `CartItem`, `Offer`, `ExchangeOffer`, or call `recordLedgerTx`/`escrow*`/wallet/momo/mock-payment helpers. The dormant finance path that creates a `Conversation` (`createExchangeOfferAction` in `src/lib/actions/exchange.ts`) stays finance-guarded and untouched. Pinned by `tests/unit/deal-finance-isolation.test.ts` (source scan + import graph) + the Task 8 `rg` scans + the migration test's preservation cases.
- **Q8 Rate limits (§7.1):** keep the existing poll limit (`chat:poll` 120/min/IP) and Batch 3's send limit (`CHAT_SEND_RATE_LIMIT` 30/min/user); Batch 6 adds `CONVERSATION_START_RATE` (new conversations) and `DEAL_MUTATION_RATE` (deal create + outcome) via the existing `checkRateLimit` — same in-memory topology caveats as `src/lib/rate-limit.ts` (single instance), no new limiter.
- **Q9 Copy (§4.2/§6.4/§5.2):** the safety-guidance and deal copy states the §6.4 points and the §5.2 line ("Thanh toán và giao nhận hàng diễn ra độc lập ngoài LoaViet.") with **no** guarantee/escrow/protection/insurance language; Batch 6 ships product copy only — **Batch 8 reviews the final legal text** (do not invent legal text beyond the spec).
- **Q10 Wishlist/conversation listing-status seam:** `CONVERSATION_STARTABLE_LISTING_STATUSES = ["approved"]` and `DEAL_CREATE_LISTING_STATUSES = ["approved"]` are Batch 6-owned constants in `src/lib/deal-vocab.ts`, drift-tested against every `listing_status` value from the contract (the Batch 5 `SEARCHABLE_LISTING_STATUSES` pattern). Batch 5's search seam is untouched.
- **Q11 Fallback if Batch 6 must land before Batch 5:** Batch 6 ships Deal/chat hardening **without** telemetry emission (the four events stay schema-only forward seams; `successful_match` emission moves to a Batch 5 follow-up commit) and the "successful-match analytics" gate item is verified as the raw `ProductEvent` count query + the bilateral-confirmation unit tests instead. The schema (Q3) has no overlap with any earlier batch, so no other fallback exists.

## Global Constraints

- Read `AGENTS.md` and the relevant Next.js 16 docs before editing app code. At minimum (paths as used by the Batch 0–5 plans): `node_modules/next/dist/docs/01-app/02-guides/server-actions.md`, `.../01-app/01-getting-started/15-route-handlers.md`, `.../01-app/02-guides/environment-variables.md`, `.../01-app/02-guides/redirecting.md`, `.../01-app/02-guides/testing/vitest.md`, plus the current `cookies()`/`headers()`/`useActionState` API-reference guides under `node_modules/next/dist/docs/`. Heed deprecation notices; this is not the Next.js from training data.
- **Server-action hygiene (Next 16):** a `"use server"` module may export **only async functions** (compiler error E352 otherwise) — no `export const` rate objects or schemas in `src/lib/actions/deals.ts`/`chat.ts`/`wishlist.ts`; constants live in `src/lib/deal-vocab.ts` (plain module). `redirect()` **must never be called inside a `catch` block** — capture the typed error, then `return redirect(...)` outside the `try`. **No non-async exports from `"use server"` files; no `server-only`/db imports in client components or `tsx` scripts** — the deal forms (`"use client"`) import only `deal-vocab.ts`, `constants.ts`, and the actions; `safety-guidance.tsx` is a plain component with zero server imports.
- **Quote bracketed paths in every `git add`** — zsh globs `[id]`/`[slug]` as a character class and drops the file from the command (Batch 3/5 constraint, kept verbatim). Every `git add` below already quotes them (`'app/api/chat/[id]/route.ts'`, `'app/chat/[id]/page.tsx'`, `'app/listings/[slug]/page.tsx'`); keep that form in every commit.
- Prisma 8 contract/migration workflow (`.agents/skills/prisma-8/references/contract.md` + `migrations.md` + `migration-model.md`): edit `src/prisma/contract.prisma` → `npx prisma contract emit` → `npx prisma migration plan --name <snake_slug>` (with `--from <batch5-migration-dir>` per Q2) → fill any `placeholder(...)`/data-transform holes in the rendered `migration.ts` → self-emit with `node "$DIR/migration.ts"` → review with `npx prisma migration show "$DIR"` → `npx prisma db migrate --advance-ref db` → advance refs. Never `db update` against a shared/production database; never edit `ops.json`/`contract.json`/`contract.d.ts` by hand; commit contract artefacts + migration package together. Shell commands use quoted `"$DIR"`/`"$END_HASH"` variables, never bare `<dir>`/`<end-hash>` placeholders (zsh reads those as redirections).
- Test-first for every behavior change: add the failing test, confirm the expected failure, implement the minimum, rerun the focused test. **Canonical stubbing recipe** (one recipe, used by every unit AND integration test that imports an action/page/route — the actions import `next/cache`/`next/navigation`/`next/headers` and `requireUser`, all of which throw or misbehave outside a Next request):

  ```ts
  vi.mock("server-only", () => ({}));
  vi.mock("next/cache", () => ({ revalidatePath: () => ({}) }));
  vi.mock("next/navigation", () => ({
    redirect: (url: string) => { throw new Error("NEXT_REDIRECT:" + url); },
    notFound: () => { throw new Error("NEXT_HTTP_ERROR_FALLBACK;404"); },
  }));
  vi.mock("next/headers", () => ({
    headers: async () => new Headers(),
    cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  }));
  // per-test user/role fixture (Batch 6 has NO admin surface — rbac is mocked only where an
  // import chain reaches it; the auth mock covers the session boundary):
  vi.mock("@/src/lib/auth", () => ({
    requireUser: () => fixtureUser(),
    getCurrentUser: () => fixtureUser(),
  }));
  // no-session cases: the mock's requireUser/getCurrentUser THROWS the redirect error instead —
  //   requireUser: () => { throw new Error("NEXT_REDIRECT:/login"); }  — matching the real
  //   requireUser() behavior (redirect() throws NEXT_REDIRECT; the action never returns).
  // unit tests additionally mock "@/src/prisma/db.client" with in-memory model maps
  // (same style as tests/unit/financial-shutdown-actions.test.ts) + resetRateLimits() in beforeEach;
  // integration tests keep the REAL db (hasDb guard, scripts/test-integration.sh) and mock only the
  // action-boundary modules above. Route tests import GET/POST directly with a stubbed
  // Request + ctx ({ params: Promise.resolve({ id }) }) — tests/unit/cron-auto-release-route.test.ts style.
  ```

- Integration tests run only via `scripts/test-integration.sh` against the scratch container (same `hasDb` guard pattern as `tests/integration/escrow.test.ts`).
- **Additive-only schema (Q3).** No drop, rename, or repurpose of any existing column/table/index/enum value. Every finance model, every Batch 2/3/4/5 table, `Listing.city`, `Conversation`, `Message`, and the `Conversation.@@unique([listingId, buyerId])` constraint stay exactly as their owning batches shipped them. All new columns are nullable or defaulted.
- **Preserve Batch 1.** `FINANCIAL_FEATURES_ENABLED` stays `false`; every existing finance guard and test (`tests/unit/financial-shutdown-*.test.ts`, `tests/unit/finance-public-surface.test.ts`, `tests/unit/admin-finance-readonly.test.ts`, `tests/unit/mock-payment-guard.test.ts`, `tests/integration/escrow.test.ts`) must stay green unchanged. No Batch 6 task may enable, bypass, or weaken a finance boundary — and per the §9 Batch 6 Gate, **no Deal action may create a `Payment`, `Payout`, `Wallet`/withdrawal, `LedgerEntry`, or `Escrow` mutation** (Q7, pinned by `tests/unit/deal-finance-isolation.test.ts`).
- **Preserve Batch 2 + 3 + 4 + 5.** Batch 6 executes after all their gates pass (Q1), so every earlier suite (`rbac`, `session`, `otp`, `publication-gate`, `chat-guard`, `block-actions`, `report-actions`, `suspension-actions`, `moderation-*`, `listing-draft-actions`, `beta-categories`, `listing-*`, `image-*`, `product-events`, `telemetry-wiring`, `metrics-*`, …) must stay green. **The only permitted edits to earlier-batch test files are the Task 3 fixture migration + the one superseded pin (B1):** Batch 3/5 chat fixtures gain the Batch 4 verified-seller + approved-listing shape (no assertion weakened), and the single Batch 3 pin "startConversationAction with a suspended COUNTERPART (seller) still creates the Conversation" (its A2) is superseded by D2 — spec §9 Batch 6 "suspended/revoked seller checks" is the authority that resolves Batch 3 A2 for NEW chat; the supersession is recorded in the verification doc. Batch 3's R5 guards, Batch 4's publication wrappers, and Batch 5's emission call sites are **never touched, re-implemented, or bypassed** (Q4/Q5); Batch 6's edits to `chat.ts`/the chat route keep every guard and emission and are re-pinned by Batch 6's own suites.
- **Backend authorization only (spec §4.5, §4.9).** Every chat/deal read and write path checks participation server-side: `GET`/`POST /api/chat/[id]` (401 unauthenticated / 403 non-participant / 404 missing), `app/chat/[id]/page.tsx` (`notFound()` for non-participants), `startConversationAction`, `createDealAction`, `markDealOutcomeAction` (typed `DEAL_FORBIDDEN` for non-participants). Hidden buttons and disabled composers are convenience; the action/route is the boundary.
- **Policy Non-Invention (spec §4.11 + §11.1 + FD-3).** Do not invent semantics for: dispute/refund/reputation on Deal outcomes; the operations reconciliation rule for mismatched bilateral outcomes; moderation sanctions; retention; buyer beta-cohort gating of conversations (Batch 7's "buyer beta access policy"); legal acceptance text (Batch 8). Per **FD-3** (founder decisions 2026-10-06): proceed with the safe/fail-closed default already chosen for every recorded ambiguity, implement everything unambiguous, and route items needing founder-authored content into the **Batch 8 Founder Decision Register** as launch blockers — never invent them, never block execution waiting for founder input. Material ambiguity → record it, preserve the safer existing behavior, stop the affected task, request a spec update. The plan's *Ambiguities* section lists the known ones; treat blocking items as blocking.
- **Telemetry privacy (spec §4.8 + Q6).** Deal/chat events carry only internal ids, typed enum values, and coarse `provinceCode` — never message bodies, never `agreedPrice`, never `cancellationReason` free text, never raw actor/session ids (`emitProductEvent` pseudonymizes). Notifications created by Batch 6 surfaces carry typed Vietnamese titles/labels + link only — no contact details, no message bodies, no prices (the existing chat-message notify keeps its current sender-name + 80-char preview behavior to the recipient — a participant; recorded as decision D8).
- **No misleading promise (spec §4.2 + §6.4 + Q9).** New copy must not claim LoaViet holds money, protects payment, guarantees payment/seller/authenticity/condition/meetup safety, or that safety guidance is transaction insurance. The §6.4 disclaimer states the six spec points + the §5.2 line; nothing more.
- OpenCode must not push, merge, deploy, or destructively clean the repository. Commit each task separately with the listed message; never `git add .`. Exclude from commits: `.claude/settings.json`, `public/uploads/`, secrets, local scratch data, unrelated work.
- Browser E2E: the repo has no E2E infrastructure (recorded in the Batch 2/3/4 verification docs). Batch 6 again covers its critical flows with action-level unit tests + real-DB integration tests (including the concurrency races), and records browser E2E for the chat→deal→outcome loop as a tracked pre-invite prerequisite (spec §10, §12).

## Batch 6 Scope Decisions

In scope (spec §9 Batch 6 deliverables, each mapped to its task):

1. **Chat authorization hardening** — participant-only access on every read/write/poll path (IDOR), listing-status gate for starting conversations (only publicly visible listings; draft/pending/rejected/hidden/sold/removed/archived refused), §7.8 seller-side eligibility for new chat, server-enforced message length/content limits, conversation-start rate limit, polling auth pinned (Task 3).
2. **Block enforcement** — **reused** from Batch 3 (guards stay in place, suites stay green); the new Deal paths call the same guards rather than duplicating them (Tasks 2, 4, 5).
3. **Suspended/revoked seller checks** — the §7.8 list applied to the listing's seller on new chat + Deal creation: no active suspension, `SellerVerification.status = "verified"`, active `founding_seller` membership (Task 2 guard, wired in Tasks 3/4).
4. **Lightweight Deal** — the §5.2 model verbatim (no money fields beyond optional user-entered `agreedPrice`), statuses `open|completed|cancelled|no_deal`, fulfillment methods `meetup|seller_delivery|carrier|other`, `conversationId` recorded at creation (D9), creation guarded by the full §5.2 requirement list, **buyer-only creation** (D11) (Tasks 1, 4).
5. **Deal history** — append-only `DealStatusHistory` (status, actor, note, timestamp); no product flow updates or deletes it (Tasks 1, 4, 5).
6. **Outcome UI** — deal panel on the conversation page (status + per-party outcome forms + the seller's optional "đánh dấu tin đã bán" checkbox, default off — D6/FD-3), `Tạo thỏa thuận` secondary CTA on the listing page (§6.1), labels (Task 6).
7. **Notifications where required** — `deal_created` → seller, `deal_outcome_marked` → counterparty; PII-free typed copy; **all notifications + emissions after the transaction commits** (S1) (Tasks 4, 5).
8. **External-payment safety disclaimer** — the §6.4 guidance component near chat/deal flows + the §5.2 line in the deal panel (Task 6).
9. **Telemetry (S7 forward seams land here)** — `deal_created`, `deal_outcome_marked`, `successful_match`, `listing_marked_sold` wired via `emitProductEvent` after all guards and the successful write; `conversation_started`/`conversation_buyer_first_message`/`message_first_response` survive the hardening (Tasks 3, 4, 5).
10. **Finance-boundary proof** — source-scan + import-graph test proving no Deal action creates Payment/Payout/Wallet/Ledger/Escrow (Task 7).
11. **Wishlist listing-status hardening** — `toggleWishlistAction` refuses non-approved listings for the *add* branch (the Batch 4 verification-doc hand-off: "chat/wishlist hardening") (Task 3).
12. **Block-aware outcome marking (D10/FD-3)** — a blocked pair may still record `no_deal`/`cancelled` (§5.5 "where appropriate" — blocking must not strand the outcome record); `success` marking and Deal creation stay block-denied (Task 5).
13. **Listing-page CTA eligibility gating (D12)** — the "Nhắn người bán"/"Tạo thỏa thuận" CTAs render neutral copy ("Người bán hiện không nhận tin nhắn mới") instead of a dead button when the listing's seller fails the §7.8 eligibility check — UI convenience only; the actions enforce (Task 6).

Explicitly deferred (do not build here): the operations **reconciliation rule** for mismatched bilateral outcomes (blocking Ambiguity A1 — no resolution UI/action ships; per FD-3 the fail-closed default proceeds and the rule is a Batch 8 register item); **dispute/refund/reputation** semantics on Deal (§4.11/§15 — A3); **buyer beta-cohort gating** of new conversations (§2.1 — Batch 7's "buyer beta access policy" — A2); a standalone seller "mark sold" action (the seller's explicit per-deal `markSold` choice on their success marking is the only beta sold transition — D6/FD-3, Batch 8 register item); admin/ops Deal surfaces (none in §9 Batch 6); Deal retention/cleanup (A7); email/push notification delivery (in-app only, A8); browser E2E infrastructure; any change to `src/lib/actions/listings.ts`, finance modules, or moderation modules (Q4/Q5/Q7).

## Legacy Migration Decisions (additive, spec §8)

- **No backfill.** There is no legacy deal data; §8.6's backfill requirements (dry-run behavior, expected count, idempotency, rollback, post-migration verification) are satisfied trivially — dry-run = "0 rows", no `--apply` path exists, rollback = the migration revert, verification = `tests/integration/batch6-migration.test.ts` + `npx prisma db verify` (Batch 3 precedent).
- **`Deal.listingId` is nullable + `SetNull`** (the existing `Conversation.listing` precedent in the same contract): listing deletion is a **live** seller surface (`deleteListingAction`), and an outcome record must survive it — the deal becomes listing-less, the panel renders status-only, and the analytics events already survive via Batch 5's no-FK `ProductEvent` design. The spec §5.2 sketch shows `listingId` without `?`; the repo's own `Conversation` precedent (§4.3 preservation spirit) wins — recorded as decision D9.
- **`Deal.buyerId`/`sellerId` are required + `Restrict`**: account deletion does not exist in P0 (Batch 2 deferred it), and deleting a user who has deals must come back through the retention ambiguity — the Batch 3 `UserSuspension.user @ onDelete: Restrict` posture, adopted verbatim (A7).
- **`DealStatusHistory.actorId` is nullable + `SetNull`** (the Batch 3 `ModerationAction.actor` precedent): history rows survive a future account deletion; participant checks fail closed on null.
- **One OPEN deal per `(listingId, buyerId)`** via a partial unique index (`where: "(status = 'open')"`): closes the concurrent double-create race; a buyer may create a **new** deal after the previous one reached a terminal status (`completed`/`cancelled`/`no_deal` rows coexist) — recorded as decision D4.
- **No `listing_status` value is added.** `sold` exists from the baseline contract; Batch 6 claims it with an atomic `Listing.where({ id, status: "approved" }).updateAll({ status: "sold" })` inside `markDealOutcomeAction` — **only when the seller explicitly ticks "đánh dấu tin đã bán" (default off) on their own success marking** (D6/FD-3 — the safer default; bilateral completion alone never sells the listing: `sold` is irreversible and a listing can transact with multiple buyers). 0 rows → the listing already moved — no-op, no event. `removed` (Batch 3) and `archived` (Batch 4) are never written by Batch 6.
- **`agreedPrice`** is `Int?` (VND), a user-entered transaction record only — LoaViet never collects it (§5.2); validated against the repo's **real existing price bound `100_000 … 2_000_000_000`** (the `listings.ts` create-validation bound — D5; empty → null, no zero-price record: a deal without a cash component simply leaves the field empty); never read by any finance code, never in telemetry.
- **`Deal.conversationId`** is nullable, **no FK** (the Batch 5 `ProductEvent.conversationId` precedent — "internal id for join"): set at creation from `requireDealConversation`, indexed for the panel lookup, and it keeps deals reachable after listing deletion (D9/S11). `Conversation` rows have no product-flow delete path, so no FK behavior is needed.
- No existing finance table, historical record, legacy column, `Conversation`/`Message` shape, or earlier-batch table is dropped or repurposed.

## Dependency and Parallelization Map

```text
(Q1: Batch 2 → 3 → 4 → 5 đã merge + pass gate TRƯỚC khi Batch 6 bắt đầu — mọi task chạy trên commit Batch 5)
Task 1  contract + migration (Deal, DealStatusHistory, enums — schema is the base commit for everything, Q2/Q3)
        ↓
Task 2  deal domain module (deal-vocab.ts client-safe + deal.ts server guards — §7.8/§5.2 eligibility)
        ↓
        ├── Task 3  chat hardening (startConversation, POST caps, GET IDOR, wishlist, notify)  ┐ {3, 4} may run
        └── Task 4  createDealAction (+ deal schemas in product-events.ts, + notify, + deal_created)  ┘ in parallel after 2
                ↓ (5 consumes 4's action + Task 2's guards; 6 mounts forms from 4+5)
        Task 5  markDealOutcomeAction (bilateral confirmation, atomic claims, successful_match,
                seller-chosen markSold transition, deal_outcome_marked) + real-DB lifecycle/concurrency integration
        ↓
Task 6  deal/outcome UI + §6.4 safety guidance + §6.1 secondary CTA + labels
        ↓
Task 7  finance-boundary isolation proof (source scan + import graph — covers every deal surface)
        ↓
Task 8  batch gate verification + verification doc
```

File-conflict rules (Q4 order — run sequentially unless stated otherwise):

- `src/lib/actions/chat.ts` + `'app/api/chat/[id]/route.ts'` — B3 (guards) → B5 Task 8 (emission) → **B6 Task 3** (hardening; keep every guard + emission). Sequential.
- `'app/chat/[id]/page.tsx'` — B3 (block banner + report dialog) → **B6 Task 6** (deal panel + safety guidance). Sequential.
- `'app/listings/[slug]/page.tsx'` — B3 (report dialog) → B5 Task 8 (view/click emission) → **B6 Task 6** (`Tạo thỏa thuận` CTA). Sequential.
- `src/lib/product-events.ts` — B5 Task 6 → **B6 Task 4** (extend the four deal-event schemas additively; no existing schema weakened; the extension lands in the same commit as the first emission that needs it). Sequential.
- `src/lib/constants.ts` — B3 → B4 → **B6 Task 6** (deal labels only, additive). Sequential.
- `src/lib/actions/wishlist.ts` — **B6 Task 3** only (single owner).
- **Chat-fixture test files (B1)** — `tests/unit/chat-guard.test.ts` (B3) → **B6 Task 3** (fixture migration + the one superseded counterpart-suspension pin); `tests/integration/block-enforcement.test.ts` + `tests/integration/suspension-enforcement.test.ts` (B3) → **B6 Task 3** (fixture migration only — no assertion weakened); `tests/unit/telemetry-wiring.test.ts` (B5 Task 8) → **B6 Task 3** (fixture migration only). Each is edited exactly once by Batch 6, in the Task 3 commit.
- `src/prisma/contract.prisma` — Task 1 only. `src/lib/deal-vocab.ts`, `src/lib/deal.ts`, `src/lib/actions/deals.ts`, `src/components/deal-panel.tsx`, `src/components/deal-create-form.tsx`, `src/components/deal-outcome-form.tsx`, `src/components/safety-guidance.tsx` — created by Batch 6, single-owner per task.
- **Never edited in a Batch 6 commit** (Q5): `src/lib/moderation.ts`, `src/lib/moderation-vocab.ts`, `src/lib/moderation-snapshot.ts`, `src/lib/rbac.ts`, `src/lib/session.ts`, `src/lib/auth.ts`, `src/lib/audit-event.ts`, `src/lib/seller-verification-policy.ts`, `src/lib/rate-limit.ts`, `src/lib/notify.ts`, `src/lib/telemetry-recorders.ts`, `src/lib/actions/listings.ts`, `src/lib/actions/admin.ts`, `src/lib/actions/moderation.ts`, `src/lib/actions/reports.ts`, `src/lib/actions/blocks.ts`, `src/lib/actions/exchange.ts`, `src/lib/actions/offers.ts`, `src/lib/actions/orders.ts`, every finance module, `src/lib/search-query.ts`.
- Everything else is single-owner. If review prefers smaller commits, the UI mounts inside Task 6 can be split (panel vs forms vs listing CTA) — the action/guard commits (Tasks 2–5) are the reviewable core either way.

## Review Focus

1. **Deal IDOR / cross-account Deal modification** — a non-participant (third user, or the buyer of a *different* deal) invoking `createDealAction`/`markDealOutcomeAction` with a forged `dealId`/`listingId`, or reading another pair's conversation via `GET /api/chat/[id]` (spec §7.3, §10.1 "Deal IDOR", "Cross-account Deal modification"). Pinned by Task 4/5: `tests/unit/deal-create.test.ts` + `tests/unit/deal-outcome.test.ts` (non-participant → `DEAL_FORBIDDEN`, zero writes) and Task 3: `tests/unit/chat-hardening.test.ts` (GET 401/403/404 matrix).
2. **Blocked/suspended pair reaching a Deal or new conversation via direct action invocation** — the Deal path must **call** Batch 3's guards, not re-implement them (Q5), and a blocked pair must not create a Deal even though the composer is disabled. Pinned by Task 4: `tests/unit/deal-create.test.ts` (block either direction → `CHAT_BLOCKED`, no `Deal` row; delegation spy on `assertCanStartConversation`) + Batch 3's suites staying green.
3. **Concurrent Deal status update / double-create** — two concurrent creates for `(listing, buyer)`; both parties marking outcome simultaneously; a completion claim racing a cancellation claim (spec §10.1 "Concurrent Deal status update"). Pinned by Task 4 (partial unique index → `DEAL_ALREADY_OPEN`) + Task 5: `tests/unit/deal-outcome.test.ts` atomic-claim cases + `tests/integration/deal-lifecycle.test.ts` real-DB `Promise.all` races (exactly one `successful_match`, one `completedAt`, one `markSold` sold transition when the seller ticked it).
4. **Finance leakage through Deal** — any Deal path importing/mutating a finance model, or money semantics reaching telemetry (§4.1/§4.8/§9 Gate). Pinned by Task 7: `tests/unit/deal-finance-isolation.test.ts` (source scan + import graph) + Task 8's `rg` scans + the migration preservation cases.
5. **PII/guarantee leakage in new copy, notifications, and telemetry** — guarantee/insurance language in the disclaimer (§4.2/§6.4), message bodies or prices in events (§4.8), contact details in notifications. Pinned by Task 6: `tests/unit/deal-ui.test.ts` copy source-contract + Task 4/5 notification/telemetry payload assertions.

---

## Task 1: Contract additions + Batch 6 migration

**Files:**

- Modify: `src/prisma/contract.prisma`
- Create: `migrations/app/<ts>_batch6_chat_deal/` (rendered by `prisma migration plan`)
- Modify (emitted): `src/prisma/contract.json`, `src/prisma/contract.d.ts`
- Modify: `migrations/app/refs/db.json`, `migrations/app/refs/production.json` (ref advancement)
- Test: `tests/integration/batch6-migration.test.ts`

**Interfaces:**

- Consumes: existing `User`, `Listing`, `Conversation`, `Message`, every finance model (untouched), and — **on the merged Batch 5 commit** (Q1) — the Batch 2–5 tables (`UserSession`, `SellerVerification`, `BetaCohortMembership`, `UserBlock`, `UserSuspension`, `ModerationCase`, `ListingImageUpload`, `ProductEvent`, `SearchAlias`, the structured `Listing` columns).
- Produces (used by every later task via `db.orm.public.<Model>`): models `Deal` (incl. nullable `conversationId` — no FK), `DealStatusHistory`; enums `deal_status`, `deal_fulfillment_method`; `User` relations `dealsAsBuyer`/`dealsAsSeller`/`dealHistoryActions`; `Listing` relation `deals`. **No `listing_status` value. No finance table. No location/search column (Q3).**

- [ ] **Step 0: Confirm the Batch 5 base (Q2)**

- `migrations/app/refs/db.json` + `refs/production.json` hash **equals Batch 5's migration `to` hash**; `npx prisma migration list` shows `baseline → batch2 → batch3 → batch4 → batch5` with no node holding two outgoing edges. If not: stop — do not plan over a stale base.
- Plan with the explicit origin (per `.agents/skills/prisma-8/references/migration-model.md`):

  ```bash
  B5_DIR="migrations/app/<ts>_batch5_search_telemetry"   # thư mục Batch 5 THẬT trên đĩa — dán giá trị thật
  npx prisma migration plan --name batch6_chat_deal --from "$B5_DIR"
  ```

  If a Batch 6 package was ever authored on a stale base: delete the uncommitted package + snapshot, re-emit, re-plan — **never hand-merge `ops.json`/`contract.json`**.

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/batch6-migration.test.ts` (runs only via `scripts/test-integration.sh`, scratch DB, same `hasDb` guard pattern as `tests/integration/escrow.test.ts`):

- `applies the batch 6 migration additively`: after the script's migrate step, `db.orm.public.Deal` accepts a create+read round-trip with every §5.2 field (status defaulting `open`; `agreedPrice`/`fulfillmentMethod`/`buyerOutcomeAt`/`sellerOutcomeAt`/`completedAt`/`cancellationReason`/`conversationId` nullable) and `DealStatusHistory` accepts a create+read round-trip (`status`, `actorId` nullable, `note`, `createdAt`). **Product-flow posture:** no product flow deletes either row — the test may delete its own fixture rows for cleanup, but no case exercises a product-flow delete.
- `enum values match the spec §5.2`: a `Deal` row accepts each of the four statuses (`open`, `completed`, `cancelled`, `no_deal`) and each of the four fulfillment methods (`meetup`, `seller_delivery`, `carrier`, `other`) — loop creates + reads back.
- `one OPEN deal per (listing, buyer)`: a second `Deal` with the same `(listingId, buyerId)` and `status: "open"` throws (raw create — the partial unique index); a `completed` deal with the same pair **coexists** with a new `open` one (D4).
- `Deal is structurally separate from finance`: seed `Order`+`Payment`+`Payout`+`LedgerEntry` rows, create a `Deal` + `DealStatusHistory` — assert every finance row count is **unchanged** and no finance row references the deal (the §9 Batch 6 Gate's structural half; the code-path half is Task 7, and the full create→outcome lifecycle finance snapshot lives in `tests/integration/deal-lifecycle.test.ts` — Task 5, S5).
- `migration leaves the database consistent`: `npx prisma db verify` exits 0 after migrate.
- `preserves finance tables`: `Order`, `Payment`, `Payout`, `WithdrawRequest`, `LedgerEntry`, `Dispute` still accept reads and a seeded `Order`+`Payment` row reads back unchanged.
- `preserves batch 2–5 tables`: `UserSession`, `AuditEvent`, `BetaCohortMembership`, `SellerVerification` (Batch 2), `UserBlock`, `UserSuspension`, `ModerationCase`, `AbuseReport` (Batch 3), `ListingImageUpload` (Batch 4), `ProductEvent`, `SearchAlias` (Batch 5) each accept a create+delete round-trip; a `Listing` round-trips Batch 4's `provinceLevelCode` + Batch 5's `locationSource`/`searchTextNormalized` unchanged (proves Batch 6's migration did not disturb the earlier graphs).

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:integration`
Expected: FAIL — `Deal`/`DealStatusHistory`/enums not in contract.

- [ ] **Step 3: Edit the contract, emit, plan the migration**

Add to `src/prisma/contract.prisma` (match existing style: `// use prisma-8` header, `@@type("pg/text@1")` on enums, `TimestamptzString`, `temporal.updatedAtString()`, named relation strings):

```prisma
// ─── Enums (Batch 6 — Deal, spec §5.2) ───

enum deal_status {
  @@type("pg/text@1")
  open      = "open"       // thỏa thuận đã tạo, chưa có kết quả song phương
  completed = "completed"  // CẢ HAI bên xác nhận thành công (bilateral — §5.2)
  cancelled = "cancelled"  // thỏa thuận bị hủy sau khi đã thống nhất
  no_deal   = "no_deal"    // không đạt thỏa thuận
}

enum deal_fulfillment_method {
  @@type("pg/text@1")
  meetup          = "meetup"           // gặp trực tiếp
  seller_delivery = "seller_delivery"   // người bán giao đến
  carrier         = "carrier"           // chuyển phát
  other           = "other"             // khác
}
```

Add to `User` (relation declarations only — additive, no new columns):

```prisma
  dealsAsBuyer        Deal[]             @relation("deal_buyer")
  dealsAsSeller       Deal[]             @relation("deal_seller")
  dealHistoryActions  DealStatusHistory[] @relation("deal_history_actor")
```

Add to `Listing` (relation declaration only):

```prisma
  deals Deal[] @relation("deal_listing")
```

New models (FK decisions are load-bearing — see Legacy Migration Decisions; the partial unique index closes the Task 4 double-create race):

```prisma
// ─── Lightweight Deal (Batch 6, spec §5.2 — KHÔNG phải Order V2, KHÔNG đụng finance) ───
// agreedPrice là bản ghi người dùng tự nhập — LoaViet KHÔNG bao giờ thu tiền này trong P0.
// KHÔNG có trường tiền nào khác (không commission/escrow/payout/ledger — §9 Batch 6 Gate).

model Deal {
  id                 String                    @id @default(uuid())
  listingId          String?                   // nullable + SetNull theo precedent Conversation — deal sống qua listing deletion (D9)
  listing            Listing?                  @relation("deal_listing", fields: [listingId], references: [id], onDelete: SetNull)
  conversationId     String?                   // KHÔNG FK (ProductEvent.conversationId precedent) — deal reachable sau listing deletion (D9/S11)
  buyerId            String
  buyer              User                      @relation("deal_buyer", fields: [buyerId], references: [id], onDelete: Restrict) // không có account deletion trong P0 — batch sau quay lại qua retention (A7)
  sellerId           String
  seller             User                      @relation("deal_seller", fields: [sellerId], references: [id], onDelete: Restrict)
  status             deal_status               @default(open)
  agreedPrice        Int?                      // VND — bản ghi tự nhập, bound 100_000..2_000_000_000 (listings.ts — D5)
  fulfillmentMethod  deal_fulfillment_method?
  buyerOutcomeAt     TimestamptzString?       // buyer đã đánh dấu kết quả (giá trị sống trong DealStatusHistory.note)
  sellerOutcomeAt    TimestamptzString?
  completedAt        TimestamptzString?       // đặt khi claim open→completed thành công (bilateral)
  cancellationReason String?                   // ≤500 ký tự — untrusted input, render React text; KHÔNG vào telemetry
  createdAt           TimestamptzString         @default(now())
  updatedAt           temporal.updatedAtString()

  statusHistory DealStatusHistory[]

  @@index([listingId])
  @@index([conversationId])                     // panel lookup theo hội thoại — sống qua listing deletion (S11)
  @@index([buyerId, createdAt])
  @@index([sellerId, createdAt])
  @@index([status, updatedAt])
  // MỘT deal OPEN duy nhất per (listing, buyer) — đóng race double-create (Task 4);
  // deal completed/cancelled/no_deal cùng cặp được phép tồn tại → buyer tạo deal MỚI sau khi deal cũ kết thúc (D4)
  @@index([listingId, buyerId], where: "(status = 'open')", unique: true, name: "deal_one_open_per_listing_buyer")
}

// Lịch sử trạng thái Deal (spec §5.2 DealStatusHistory) — APPEND-ONLY:
// không product flow nào update/delete; actor nullable + SetNull sống qua account deletion tương lai
// (Batch 3 ModerationAction precedent). note mang typed marker "buyer:success" / "seller:no_deal" + reason.
model DealStatusHistory {
  id        String            @id @default(uuid())
  dealId    String
  deal      Deal              @relation(fields: [dealId], references: [id], onDelete: Cascade)
  status    deal_status       // trạng thái deal SAU marking này
  actorId   String?
  actor     User?             @relation("deal_history_actor", fields: [actorId], references: [id], onDelete: SetNull)
  note      String?           // typed marker per party + cancellationReason — KHÔNG PII
  createdAt TimestamptzString @default(now())

  @@index([dealId, createdAt])
  @@index([actorId, createdAt])
}
```

Then:

```bash
npx prisma contract emit
B5_DIR="migrations/app/<ts>_batch5_search_telemetry"   # dán thư mục Batch 5 thật
npx prisma migration plan --name batch6_chat_deal --from "$B5_DIR"
```

- [ ] **Step 4: Review the package, self-emit**

- Confirm the plan output's `from:` line names the current graph head (the post-Batch-5 hash that `migrations/app/refs/db.json` + `production.json` point to), not `(baseline)` over a non-empty graph, and `pendingPlaceholders` is `false` (all new columns are nullable/defaulted — a placeholder means an accidental non-null column; fix the contract instead).
- `npx prisma migration show "$DIR"` — confirm **zero destructive operations** (Q2: Batch 6 adds no enum value to `listing_status`, so no `Listing_status_check_*` drop+add is expected either — **halt on any destructive op**). Any drop/alter of an existing column/table is a plan violation: fix the contract instead.
- No data transform is added (no legacy deal data — Legacy Migration Decisions).
- Self-emit: `node "$DIR/migration.ts"` (regenerates `ops.json` + `migrationHash`); re-run `npx prisma migration show "$DIR"` — only `create`/`createIndex` operations.

- [ ] **Step 5: Apply to the dev DB and advance refs**

```bash
DIR="migrations/app/<ts>_batch6_chat_deal"          # thư mục do migration plan tạo
END_HASH="<to-hash của migration.json trong $DIR>"  # dán giá trị — KHÔNG dùng <...> trực tiếp (zsh đọc là redirection)
npx prisma db migrate --advance-ref db              # dev DB (DATABASE_URL từ .env, container 5435)
npx prisma migration ref set production "$END_HASH"  # docker-compose.prod.yml migrate service chạy --to production
npx prisma db verify
```

`production` ref must be advanced in the same commit (same rule as every earlier batch's Task 1).

- [ ] **Step 6: Run the integration test to verify it passes**

Run: `npm run test:integration`
Expected: PASS (all `batch6-migration` cases + `escrow.test.ts` + every Batch 2–5 integration suite green).

- [ ] **Step 7: Commit**

```bash
git add src/prisma/contract.prisma src/prisma/contract.json src/prisma/contract.d.ts migrations/app migrations/snapshots tests/integration/batch6-migration.test.ts
git commit -m "feat(db): add batch 6 deal contract"
```

**Gate:** no destructive op in `migration show`; `db verify` clean; finance + Batch 2–5 integration invariants still green; graph stays linear (Q2).

## Task 2: Deal domain module — vocabularies, §7.8/§5.2 guards

**Files:**

- Create: `src/lib/deal-vocab.ts` (client-safe — pure vocabularies, zero db/`server-only`/rate-limit imports)
- Create: `src/lib/deal.ts` (server-only domain module — `import "server-only"`, **never** `"use server"`)
- Test: `tests/unit/deal-domain.test.ts`

**Interfaces:**

- Consumes: `Deal`/`DealStatusHistory` models (Task 1), `Conversation` (`@@unique([listingId, buyerId])`), Batch 3's `isUserSuspended`/`getBlockState`/`assertCanStartConversation` (`src/lib/moderation.ts` — **reused, not duplicated**, Q5), `SellerVerification`/`BetaCohortMembership` (Batch 2 models), `db` from `@/src/prisma/db.client`.
- Produces (used by Tasks 3–6; the client forms in Task 6 import **only** `deal-vocab.ts`/`constants.ts`):

```ts
// src/lib/deal-vocab.ts — PURE, client-safe (KHÔNG import db, KHÔNG "server-only",
// KHÔNG import rate-limit — các rule dùng structural type { limit, windowMs } — B3 precedent).
export const DEAL_STATUSES = ["open", "completed", "cancelled", "no_deal"] as const;   // spec §5.2 verbatim
export type DealStatus = (typeof DEAL_STATUSES)[number];

export const DEAL_FULFILLMENT_METHODS = ["meetup", "seller_delivery", "carrier", "other"] as const; // spec §5.2 verbatim
export type DealFulfillmentMethod = (typeof DEAL_FULFILLMENT_METHODS)[number];

// Giá trị marking per party — RECORDED DECISION D3 (không phải trạng thái deal):
// "success"    = bên này xác nhận hoàn tất thành công → góp phần hoàn tất song phương
// "no_deal"    = bên này ghi nhận không đạt thỏa thuận
// "cancelled"  = bên này ghi nhận thỏa thuận đã hủy
export const DEAL_OUTCOMES = ["success", "no_deal", "cancelled"] as const;
export type DealOutcome = (typeof DEAL_OUTCOMES)[number];

export const TERMINAL_DEAL_STATUSES = ["completed", "cancelled", "no_deal"] as const;
export function isTerminalDealStatus(s: DealStatus): boolean;

// ── Listing-status seams (Q10 — drift-tested, Batch 5 SEARCHABLE_LISTING_STATUSES pattern) ──
export const CONVERSATION_STARTABLE_LISTING_STATUSES = ["approved"] as const; // D1 — chỉ listing công khai mới mở hội thoại MỚI
export const DEAL_CREATE_LISTING_STATUSES = ["approved"] as const;            // §5.2 "live eligible listing"

// ── Rate rules (§7.1 — structural, dùng với checkRateLimit) ──
export const CONVERSATION_START_RATE = { limit: 20, windowMs: 10 * 60_000 };  // 20 hội thoại mới / 10 phút / user
export const DEAL_MUTATION_RATE = { limit: 20, windowMs: 60 * 60_000 };        // 20 create+outcome / giờ / user (§7.1 "Deal mutation")

// ── Message limits (server-enforced — Task 3) ──
export const CHAT_MESSAGE_MAX_LENGTH = 2_000;          // khớp maxLength input client hiện có — giờ enforce ở server
// KHÔNG có CHAT_IMAGE_URL_PATTERN ở đây — chat imageUrl validation REUSE LISTING_IMAGE_URL_PATTERN
// từ src/lib/listing-images.ts của Batch 4 (S3: uuid-upload strict, không tự chế pattern mới, không /img allowance)

// ── Deal input bounds ──
export const DEAL_AGREED_PRICE_MIN = 100_000;          // bound giá THẬT của repo (listings.ts create-validation) — D5
export const DEAL_AGREED_PRICE_MAX = 2_000_000_000;    // cùng nguồn — không phát minh policy
export const DEAL_CANCELLATION_REASON_MAX = 500;
```

```ts
// src/lib/deal.ts — server-only domain module (import "server-only"; KHÔNG "use server" — không phải action).
export * from "@/src/lib/deal-vocab";

// ── §7.8 seller-side eligibility — dùng chung bởi startConversationAction (Task 3) + createDealAction (Task 4) ──
// RECORDED DECISION D2: Batch 3 A2 quyết KHÔNG chặn counterpart-side suspension cho *message trong hội thoại cũ*;
// Batch 6 mở rộng perimeter CHỈ cho NEW chat + Deal creation (§7.8 list áp lên seller-of-the-listing).
// KHÔNG gọi checkSellerPublicationRequirements (Batch 2) — đó là publication gate (email/phone/type/location/rules);
// §7.8 chỉ liệt kê suspension/revocation/membership cho chat/Deal — dùng đúng subset, fail closed.
export async function assertListingSellerInteractable(sellerId: string): Promise<void>;
//   1. await isUserSuspended(sellerId)  [BATCH 3 DELEGATION — S10: KHONG tự đọc UserSuspension lại]
//      → true → throw Error("SELLER_SUSPENDED")                    [§7.8 "suspension"]
//   2. SellerVerification.where({ userId: sellerId }).first():
//      row thiếu HOẶC status ≠ "verified" (revoked/rejected/needs_review/pending/not_started)
//      → throw Error("SELLER_NOT_VERIFIED")                 [§7.8 "seller-verification revocation" — D2]
//   3. BetaCohortMembership.where({ userId: sellerId, cohort: "founding_seller", status: "active" }).first() thiếu
//      → throw Error("SELLER_MEMBERSHIP_INACTIVE")          [§7.8 "beta-membership status" — D2]
//   Thứ tự cố định: suspension → verification → membership. Fail closed. Đọc FRESH từ DB mỗi call.

// ── §5.2 "corresponding allowed conversation relationship" ──
export async function requireDealConversation(listingId: string, buyerId: string): Promise<{ id: string }>;
//   Conversation.where({ listingId, buyerId }).first() — unique constraint hiện có bảo (listing, buyer) duy nhất.
//   Không có → throw Error("DEAL_CONVERSATION_REQUIRED") — Deal chỉ tạo trong hội thoại đã tồn tại
//   (seller của convo = seller của listing theo cấu trúc tạo convo). Trả về convo id — caller ghi vào
//   Deal.conversationId (D9) dùng cho panel lookup + notify link + telemetry.

// ── Participant/IDOR guard (spec §7.3 "cross-account Deal modification") ──
export async function assertDealParticipant(
  deal: { buyerId: string; sellerId: string },
  actorId: string,
): Promise<"buyer" | "seller">;
//   actorId === deal.buyerId → "buyer"; === deal.sellerId → "seller";
//   khác → throw Error("DEAL_FORBIDDEN"). Caller dùng CÙNG mã DEAL_FORBIDDEN cho deal không tồn tại
//   (S9 — không existence oracle: probe dealId không phân biệt tồn tại/không).

// ── §7.8 actor-side guards — REUSE Batch 3, không duplicate (Q5) ──
// CREATION không cần guard mới: createDealAction gọi TRỰC TIẾP Batch 3's
// assertCanStartConversation(buyerId, sellerId) — actor suspension + block (§5.2 "buyer not blocked
// from seller") — delegation, không viết lại.

export async function assertDealOutcomeAllowed(
  actorId: string,
  counterpartId: string,
  outcome: DealOutcome,
): Promise<void>;
//   OUTCOME MARKING (D10/FD-3 — §5.5 "where appropriate"):
//   isUserSuspended(actorId) → ACCOUNT_SUSPENDED [delegation — suspension chặn MỌI marking]
//   getBlockState(actorId, counterpartId) ≠ "none" → CHAT_BLOCKED CHỈ KHI outcome === "success"
//   [delegation] — no_deal/cancelled ĐƯỢC PHÉP dưới block: chặn không được làm stranded bản ghi kết quả
//   (một cặp block vẫn ghi nhận được "không đạt thỏa thuận"); success + creation vẫn chặn
//   (creation qua assertCanStartConversation ở trên).

// ── Listing-status seam (D1/Q10) ──
export async function assertListingStartable(listing: { id: string; sellerId: string; status: string }): Promise<void>;
//   listing.status ∈ CONVERSATION_STARTABLE_LISTING_STATUSES → resolve;
//   khác → throw Error("LISTING_NOT_CONVERSATIONABLE") — draft/pending/rejected/hidden/sold/removed/archived đều từ chối
//   hội thoại MỚI (drift test liệt kê MỌI giá trị listing_status từ contract — chỉ "approved" được).
```

- [ ] **Step 1: Write the failing unit tests**

`tests/unit/deal-domain.test.ts` (mock `server-only`, `@/src/prisma/db.client` with in-memory `UserSuspension`/`SellerVerification`/`BetaCohortMembership`/`Conversation`/`Listing` maps — same style as `tests/unit/session.test.ts`; `resetRateLimits()` in `beforeEach`):

- `DEAL_STATUSES / DEAL_FULFILLMENT_METHODS match spec §5.2 verbatim` — exactly the four values, in order (non-invention pin).
- `DEAL_OUTCOMES is exactly ["success", "no_deal", "cancelled"]` (D3 pin).
- `isTerminalDealStatus: open → false; completed/cancelled/no_deal → true`.
- `deal-vocab is client-safe` — source-contract: `src/lib/deal-vocab.ts` contains no `db.client`, no `server-only`, no `@/src/lib/rate-limit` import (the client forms import it).
- `CONVERSATION_STARTABLE_LISTING_STATUSES === ["approved"] and DEAL_CREATE_LISTING_STATUSES === ["approved"]` (Q10 pin).
- `assertListingStartable: a table-driven case over EVERY listing_status value from the contract` (draft, pending, approved, rejected, hidden, sold, removed, archived) — only `approved` resolves, every other value → `LISTING_NOT_CONVERSATIONABLE` (the drift guard).
- `assertListingSellerInteractable: fully eligible seller resolves` (no active suspension + `SellerVerification.status = "verified"` + active `founding_seller`).
- `suspended seller → SELLER_SUSPENDED` (§7.8); `lifted suspension → resolves` (only active rows block) — **and the suspension read DELEGATES**: spy on the mocked `@/src/lib/moderation` module and assert `isUserSuspended(sellerId)` was called (S10 — no re-implemented `UserSuspension` read in `deal.ts`).
- `revoked / rejected / needs_review / pending / not_started (missing row) verification → SELLER_NOT_VERIFIED` (table-driven — the §7.8 revocation check, D2).
- `suspended / exited / missing founding_seller membership → SELLER_MEMBERSHIP_INACTIVE` (table-driven).
- `order pin: suspension wins over verification wins over membership` (a seller with all three problems → `SELLER_SUSPENDED`).
- `requireDealConversation returns the existing conversation; missing → DEAL_CONVERSATION_REQUIRED` (§5.2 relationship).
- `assertDealParticipant: buyer → "buyer"; seller → "seller"; third user → DEAL_FORBIDDEN` (Review Focus 1).
- `assertDealOutcomeAllowed (D10): suspended actor → ACCOUNT_SUSPENDED for ALL three outcomes; block either direction + outcome "success" → CHAT_BLOCKED; block either direction + outcome "no_deal"/"cancelled" → RESOLVES (a blocked pair can still record that the deal fell through — §5.5 "where appropriate"); clean pair → resolves for all three` — delegation spy on `isUserSuspended` + `getBlockState` (Q5 reuse pin — creation needs no new guard: it calls Batch 3's `assertCanStartConversation` directly, pinned in Task 4).

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/unit/deal-domain.test.ts`
Expected: FAIL — `src/lib/deal-vocab.ts` does not exist.

- [ ] **Step 3: Implement the two modules**

- `src/lib/deal-vocab.ts`: every constant + `isTerminalDealStatus` (pure lookup) — **no db import, no `server-only`, no rate-limit import** (structural `{ limit, windowMs }` types); this is the module the client forms import.
- `src/lib/deal.ts`: `import "server-only"` + `export * from "@/src/lib/deal-vocab"` + the guard functions per the interface block — plain `db` reads, delegation to `@/src/lib/moderation` for `isUserSuspended`/`getBlockState` (S10/D10), no `"use server"`, no client import, no logging of user content.

- [ ] **Step 4: Run tests until green**

Run: `npm test -- tests/unit/deal-domain.test.ts` → PASS. Then `npm test` → all existing suites green (no product surface changed yet).

- [ ] **Step 5: Commit**

```bash
git add src/lib/deal-vocab.ts src/lib/deal.ts tests/unit/deal-domain.test.ts
git commit -m "feat(deal): trust domain module for chat and deal guards"
```

## Task 3: Chat hardening — conversation gate, message limits, polling auth, wishlist

**Files:**

- Modify: `src/lib/actions/chat.ts` (harden `startConversationAction`; keep Batch 3 guard + Batch 5 emission)
- Modify: `'app/api/chat/[id]/route.ts'` (POST message limits + imageUrl validation; keep Batch 3 guards + Batch 5 emissions; GET participant matrix pinned)
- Modify: `src/lib/actions/wishlist.ts` (approved-only add branch — the Batch 4 hand-off)
- Test: `tests/unit/chat-hardening.test.ts`
- Test: `tests/integration/chat-hardening.test.ts`

**Interfaces:**

- Consumes: `assertListingStartable`/`assertListingSellerInteractable`/`CONVERSATION_START_RATE`/`CHAT_MESSAGE_MAX_LENGTH` (Task 2), **`LISTING_IMAGE_URL_PATTERN` from `@/src/lib/listing-images` (Batch 4 — S3: the chat imageUrl validation reuses the strict uuid-upload pattern, no new pattern invented)**, Batch 3's `assertCanStartConversation` (already in place in `chat.ts` — **kept verbatim in its pinned position**), Batch 5's `recordConversationStarted` (in `chat.ts`) + `recordBuyerFirstMessage`/`recordFirstResponse` (in the POST route) — **kept verbatim after all guards and the successful create**, `requireUser`/`getCurrentUser` (Batch 2), `checkRateLimit`/`rateLimitRequest` (existing), `ListingImageUpload` (Batch 4 — chat image ownership), `notify` (existing).
- Produces (used by Task 6 UI and Batch 7's buyer-gating revisit):

```ts
// src/lib/actions/chat.ts — startConversationAction (giữ nguyên chữ ký — FormData → void):
//   requireUser
//   → listing = Listing.first({ id }) → !listing → throw (hiện có "Tin đăng không tồn tại")
//   → listing.sellerId === user.id → throw (hiện có "Đây là tin đăng của chính bạn")
//   → await assertCanStartConversation(user.id, listing.sellerId)   [BATCH 3 — GIỮ NGUYÊN vị trí đã pin:
//       sau self-listing check, TRƯỚC existing-conversation lookup — actor suspension + block]
//   → existing = Conversation.where({ listingId, buyerId: user.id }).first()
//     → existing → redirect(`/chat/${existing.id}`)   [branch CŨ — KHÔNG check mới, KHÔNG rate limit:
//       mở lại hội thoại đã có không phải "new chat" §7.8 (không đốt budget rate limit bằng redirect);
//       §5.5 blocking không phá history — blocked pair vẫn bị chặn ở guard trên]
//   → [branch tạo MỚI — mọi check Batch 6 chỉ ở đây]:
//       checkRateLimit(`chat:start:${user.id}`, CONVERSATION_START_RATE) → !allowed → throw Error("RATE_LIMITED")  [§7.1 "chat"]
//       await assertListingStartable(listing)                      [D1 — chỉ "approved"]
//       await assertListingSellerInteractable(listing.sellerId)   [D2 — §7.8 seller-side: suspension/revocation/membership]
//   → Conversation.create (hiện có) → recordConversationStarted (BATCH 5 — GIỮ NGUYÊN: sau MỌI guard +
//     create thành công) → redirect(`/chat/${convo.id}`)
//   MỌI error là typed Error với code ổn định — server action error (fail closed, KHÔNG redirect vào hội thoại chết).

// app/api/chat/[id]/route.ts — POST (giữ nguyên chữ ký; các guard Batch 3 + emission Batch 5 GIỮ NGUYÊN):
//   [hiện có theo Batch 3] getCurrentUser → 401; participant check → 403/404;
//   checkRateLimit(`chat:send:${user.id}`, CHAT_SEND_RATE_LIMIT) → 429; assertCanSendMessage → 403 typed
//   [MỚI — sau các guard trên, TRƯỚC Message.create]:
//   let body: { body?: unknown; imageUrl?: unknown };
//   try { body = await request.json() } catch { return 400 INVALID_BODY }        [S4 — JSON malformed không thành 500]
//   typeof body.body !== "string" && body.body !== undefined → 400 INVALID_BODY
//   text = (body.body ?? "").trim()
//   text.length > CHAT_MESSAGE_MAX_LENGTH → 400 MESSAGE_TOO_LONG          [server-enforced — client maxLength chỉ là UX]
//   body.imageUrl !== undefined && typeof body.imageUrl !== "string" → 400 INVALID_BODY
//   body.imageUrl?: LISTING_IMAGE_URL_PATTERN.test (import từ @/src/lib/listing-images — Batch 4, S3:
//     strict /uploads/<uuid>.<ext>, KHÔNG tự chế pattern mới, KHÔNG /img allowance — ChatWindow không gửi
//     imageUrl và không có upload legacy nào trong chat) → sai → 400 MESSAGE_IMAGE_INVALID
//     (chặn scheme URL https:/javascript: + traversal ".." — Review Focus 5 adjacent)
//     khớp → ListingImageUpload row (storageKey = basename(url)) PHẢI tồn tại VÀ ownerUserId === user.id
//       → sai → 400 MESSAGE_IMAGE_INVALID                                  [cross-account image theft — Batch 4 rule (1)]
//   !text && !imageUrl → 400 EMPTY (hiện có)
//   [hiện có] Message.create + lastMessageAt update
//   [hiện có — BATCH 5, GIỮ NGUYÊN] recordBuyerFirstMessage / recordFirstResponse (sau create thành công)
//   [hiện có] notify(recipientId, "chat", `Tin nhắn mới từ ${user.name}`, preview 80 ký tự, `/chat/${id}`)
//     — preview là nội dung người GỬI tự chọn chia sẻ với recipient (participant) — D8, giữ nguyên hành vi.

// app/api/chat/[id]/route.ts — GET (KHÔNG đổi logic; participant matrix được PIN bằng test):
//   rateLimitRequest "chat:poll" 120/phút/IP (hiện có) → getCurrentUser → 401 khi chưa đăng nhập
//   → Conversation.first → 404 missing → 403 non-participant → messages + read-marking (participant-only write).

// src/lib/actions/wishlist.ts — toggleWishlistAction (Batch 4 hand-off):
//   sau listing load: existing = WishlistItem.where({ userId, listingId }).first()
//   → existing → delete (un-save luôn được — kể cả listing đã sold/removed)
//   → !existing && listing.status !== "approved" → silent return (KHÔNG tạo row cho listing không công khai —
//     chặn leak tiêu đề draft qua trang wishlist; idempotent, không error)
//   → !existing && approved → create (hiện có)
```

- [ ] **Step 1: Write the failing unit tests**

`tests/unit/chat-hardening.test.ts` (mock db with in-memory `Listing`/`Conversation`/`Message`/`UserSuspension`/`SellerVerification`/`BetaCohortMembership`/`UserBlock`/`WishlistItem`/`ListingImageUpload` maps; `vi.mock("@/src/lib/auth")` fixture user; `resetRateLimits()` in `beforeEach`; `next/navigation` mock throws `NEXT_REDIRECT:`; spy on the Batch 5 recorder module `@/src/lib/telemetry-recorders`):

- `startConversationAction on a draft/pending/rejected/hidden/sold/removed/archived listing → typed LISTING_NOT_CONVERSATIONABLE, no Conversation` (table-driven over every non-approved `listing_status` value — D1; Review Focus 1 adjacent).
- `startConversationAction with a REVOKED seller → SELLER_NOT_VERIFIED, no Conversation`; `suspended-membership seller → SELLER_MEMBERSHIP_INACTIVE`; `suspended seller → SELLER_SUSPENDED` (D2 — §7.8 seller-side; Review Focus 2).
- `startConversationAction with an EXISTING conversation on a now-non-approved listing still redirects` (reopen ≠ new chat — the guard order pin: Batch 6 checks live only on the create branch).
- `conversation-start rate limit: 21st CREATE within 10 min → RATE_LIMITED, no Conversation` (§7.1); `the redirect branch (existing conversation) does NOT consume the rate-limit budget` (the limit lives on the create branch only).
- `startConversationAction happy path still creates the Conversation AND still emits conversation_started` (Batch 5 emission survives the hardening — recorder spy called once with the new convo id + listing id).
- `a blocked pair (Batch 3 guard) still throws CHAT_BLOCKED and emits NOTHING` (emission after guards — re-pinned after this task's edit).
- `SUPERSEDED PIN (B1/D2): startConversationAction with a suspended COUNTERPART (seller) now throws SELLER_SUSPENDED, no Conversation` — the Batch 3 A2 pin ("counterpart suspended → still creates") is **superseded by spec §9 Batch 6 "suspended/revoked seller checks"**, the authority that resolves Batch 3 A2 for NEW chat only; the supersession is recorded in the verification doc. `POST with a suspended RECIPIENT still delivers` stays UNCHANGED (messages in existing conversations are outside D2 — Batch 3 A2 perimeter intact there).
- `POST body over CHAT_MESSAGE_MAX_LENGTH → 400 MESSAGE_TOO_LONG, no Message created`; `exactly 2000 chars → 201/ok, Message created`.
- `POST malformed JSON ("{not json") → 400 INVALID_BODY, no Message` (S4 — `request.json()` never surfaces a 500); `non-string body.body (number) → 400 INVALID_BODY`; `non-string imageUrl (number) → 400 INVALID_BODY`.
- `POST imageUrl "https://evil/x.gif" / "javascript:alert(1)" / "/../../etc" / "/img/listings/x.jpg" → 400 MESSAGE_IMAGE_INVALID, no Message` (scheme/traversal/**any non-upload path** — S3: only strict `LISTING_IMAGE_URL_PATTERN` uploads are accepted, no `/img` allowance).
- `POST imageUrl "/uploads/<uuid>.webp" owned by ANOTHER user → 400 MESSAGE_IMAGE_INVALID` (cross-account image theft); `owned by the sender → ok, Message created`.
- `POST Batch 3 guards still hold after the edit: block either direction → 403 CHAT_BLOCKED; suspended sender → 403 ACCOUNT_SUSPENDED; 31st message/min → 429` (re-pinned — the file was edited).
- `POST Batch 5 emissions still fire: buyer's first message → recordBuyerFirstMessage; seller's first reply after a buyer message → recordFirstResponse with responseMs` (re-pinned).
- `GET: 401 unauthenticated; 404 missing conversation; 403 non-participant (buyer/seller of another convo); participant → 200 with messages` (the IDOR/polling-auth matrix — Review Focus 1).
- `GET read-marking updates only THIS conversation's messages` (participant-only write pin).
- `toggleWishlistAction: add on approved → row created; add on draft/sold/removed → silent, no row; remove an existing row on a sold listing → row deleted` (Batch 4 hand-off).
- `chat notify goes to the RECIPIENT only, with sender name + preview` (spy on `notify` — D8 pin: no other-party contact details).

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/unit/chat-hardening.test.ts`
Expected: FAIL — guards/limits not wired.

- [ ] **Step 3: Implement**

- `src/lib/actions/chat.ts` per the interface block — keep Batch 3's `assertCanStartConversation` in its pinned position (after the self-listing check, before the existing-conversation lookup); add the rate limit + `assertListingStartable` + `assertListingSellerInteractable` **only on the create branch** (after the existing-conversation lookup returns null — the redirect branch stays untouched and budget-free), keep `recordConversationStarted` after the successful create. No `export const` in this `"use server"` file (the rate rule lives in `deal-vocab.ts`).
- `'app/api/chat/[id]/route.ts'` POST per the interface block — the `request.json()` try/catch + typeof/pattern/ownership validation after the existing guards and before `Message.create`; GET untouched.
- `src/lib/actions/wishlist.ts` per the interface block.

- [ ] **Step 3b: Supersede the Batch 3 counterpart-suspension pin + migrate the Batch 3/5 chat fixtures (B1 — same commit as Step 3)**

  D2 changes `startConversationAction`'s observable behavior for a suspended/revoked/inactive-membership **listing seller**, so three groups of earlier-batch tests need this one commit's touch — **no assertion is weakened**:

  - **`tests/unit/chat-guard.test.ts` (Batch 3)** — the single pinned case `startConversationAction with a suspended COUNTERPART (seller) still creates the Conversation` (Batch 3 A2: "counterpart-side blocking is NOT in §7.8's minimal set; pinned as intentionally absent") is **superseded**: rewrite it to assert `SELLER_SUSPENDED, no Conversation`, with a test comment citing **spec §9 Batch 6 "suspended/revoked seller checks"** as the authority that resolves Batch 3 A2 **for NEW chat only**. The `POST with a suspended RECIPIENT still delivers` case is untouched (D2 does not reach messages). Every other case in the file keeps its assertion; the fixtures gain the verified-seller shape below.
  - **`tests/integration/block-enforcement.test.ts` + `tests/integration/suspension-enforcement.test.ts` (Batch 3)** — the chat fixtures ("unblock; all allowed again", "lift → all allowed again", the happy-path creates) currently seed bare users + listings with no `SellerVerification`/`BetaCohortMembership` rows, so the new seller-eligibility guard would fail them with `SELLER_NOT_VERIFIED`/`SELLER_MEMBERSHIP_INACTIVE`. Migrate the fixtures to the **Batch 4 verified-seller + approved-listing shape** (the `tests/integration/listing-publication.test.ts` seller-fixture pattern: `emailVerifiedAt`/`phoneVerifiedAt` set, `SellerVerification(status: "verified", policyVersion)`, `BetaCohortMembership(founding_seller, active)`, `Listing(status: "approved")`) — assertions unchanged.
  - **`tests/unit/telemetry-wiring.test.ts` (Batch 5 Task 8)** — the `startConversationAction` emission cases reuse the same verified-seller fixture shape (Batch 5's own S-22 note already points at the Batch 4 fixture pattern); assertions unchanged.
  - Record the supersession + the fixture migration in the Task 8 verification doc (the "one pin superseded by D2" line).

- [ ] **Step 4: Run tests until green + integration**

Run: `npm test -- tests/unit/chat-hardening.test.ts` → PASS.
Run: `npm test` → full unit suite green — **including the migrated `chat-guard.test.ts`/`telemetry-wiring.test.ts` (one pin superseded, fixtures migrated — B1) and Batch 3's `block-actions.test.ts`** (the guards/emissions were kept, not moved).
Run: `npm run test:integration` → `tests/integration/chat-hardening.test.ts` (new, real DB; the Global Constraints stubbing recipe for the action boundary, real db) **+ the migrated `block-enforcement.test.ts`/`suspension-enforcement.test.ts` green**:

- `listing-status + seller-eligibility enforced fresh from the DB`: seed a verified+active seller with an `approved` listing → `startConversationAction` creates; flip the listing to `sold` → typed error; flip to `draft` → typed error; revoke the `SellerVerification` (status `revoked`) on the approved listing → `SELLER_NOT_VERIFIED`; suspend the seller (`UserSuspension` row) → `SELLER_SUSPENDED`; suspend the `founding_seller` membership → `SELLER_MEMBERSHIP_INACTIVE`; restore each → allowed again.
- `existing conversation on a sold listing still reopens (redirect), new conversation on it is refused`.
- `POST caps against the real DB`: over-length body → 400 no row; foreign imageUrl → 400 no row; sender-owned upload → message created.
- `GET participant matrix against the real DB`: 401/404/403/200.
- `wishlist add refused on a draft listing; remove works on a sold one`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/actions/chat.ts 'app/api/chat/[id]/route.ts' src/lib/actions/wishlist.ts tests/unit/chat-hardening.test.ts tests/integration/chat-hardening.test.ts tests/unit/chat-guard.test.ts tests/integration/block-enforcement.test.ts tests/integration/suspension-enforcement.test.ts tests/unit/telemetry-wiring.test.ts
git commit -m "feat(chat): harden conversation and message entry points"
```

(The last four paths are the B1 fixture-migration + superseded-pin files — Batch 3/5 test files, edited exactly once by this commit, assertions not weakened.)

## Task 4: `createDealAction` — lightweight Deal creation

**Files:**

- Create: `src/lib/actions/deals.ts` (`"use server"` — async-only exports)
- Modify: `src/lib/product-events.ts` (Batch 5 file — extend the four deal-event schemas **additively**, Q4)
- Test: `tests/unit/deal-create.test.ts`

**Interfaces:**

- Consumes: `Deal`/`DealStatusHistory` models (Task 1), `assertListingSellerInteractable` + `requireDealConversation` + `DEAL_CREATE_LISTING_STATUSES`/`DEAL_MUTATION_RATE`/`DEAL_AGREED_PRICE_MIN`/`DEAL_AGREED_PRICE_MAX`/`DEAL_FULFILLMENT_METHODS` (Task 2), Batch 3's `assertCanStartConversation` (actor suspension + block — called directly, no new creation guard), `requireUser` (Batch 2), `emitProductEvent` (Batch 5), `notify` (existing), `checkRateLimit` (existing), zod.
- Produces (used by Task 5 in the same file, Task 6 forms, Batch 7's buyer-gating revisit):

```ts
// src/lib/actions/deals.ts
"use server";
export type DealFormState = { error?: string; success?: string };

export async function createDealAction(
  _prev: DealFormState,
  formData: FormData,
): Promise<DealFormState>;
//   formData: listingId, agreedPrice? (chuỗi số, rỗng → null), fulfillmentMethod? (select | "")
//   1. requireUser → checkRateLimit(`deal:mutation:${user.id}`, DEAL_MUTATION_RATE)
//      → !allowed → { error: RATE_LIMITED }                                [§7.1 "Deal mutation"]
//   2. zod validate: agreedPrice rỗng → null; có → integer DEAL_AGREED_PRICE_MIN..DEAL_AGREED_PRICE_MAX
//      (bound 100_000..2_000_000_000 của listings.ts — D5) → sai → { error: DEAL_PRICE_INVALID };
//      fulfillmentMethod ∈ DEAL_FULFILLMENT_METHODS | null → sai → { error: DEAL_FULFILLMENT_INVALID }
//   3. listing = Listing.first({ id }) → thiếu → { error: LISTING_NOT_FOUND }
//      listing.sellerId === user.id → { error: DEAL_OWN_LISTING }          [tự thỏa thuận với chính mình]
//      listing.status ∉ DEAL_CREATE_LISTING_STATUSES → { error: LISTING_NOT_DEALABLE }  [§5.2 "live eligible listing"]
//   4. await assertCanStartConversation(user.id, listing.sellerId)          [BATCH 3 REUSE — actor suspension + block;
//      throw → form error theo code (ACCOUNT_SUSPENDED / CHAT_BLOCKED)]     [§5.2 "buyer not blocked from seller"]
//   5. await assertListingSellerInteractable(listing.sellerId)              [D2 — §5.2 "seller not suspended" +
//      "seller verification still valid where required" — throw → form error]
//   6. convo = await requireDealConversation(listing.id, user.id)          [§5.2 "corresponding allowed conversation
//      relationship" — throw DEAL_CONVERSATION_REQUIRED → form error "Hãy nhắn người bán trước"].
//      CHỈ BUYER tạo Deal (D11): bước 4-6 đều khóa theo user.id = buyer của convo — seller không có đường
//      khởi tạo (§5.2 liệt kê "authorized buyer", không có seller-initiation).
//   7. existing = Deal.where({ listingId, buyerId: user.id, status: "open" }).first()
//      → có → { error: DEAL_ALREADY_OPEN }                                  [pre-check; race đóng bằng partial unique index]
//   8. let deal;
//      try {
//        deal = await db.transaction(async (tx) => {
//          const d = await tx.orm.public.Deal.create({ listingId, conversationId: convo.id,
//            buyerId: user.id, sellerId: listing.sellerId, status: "open", agreedPrice, fulfillmentMethod });
//          await tx.orm.public.DealStatusHistory.create({ dealId: d.id, status: "open",
//            actorId: user.id, note: "buyer:created" });
//          return d;
//        });
//      } catch (e) {                                                        [S2 — catch NGOÀI db.transaction:
//        if (e instanceof SqlQueryError && e.sqlState === "23505"           // unique violation
//            && e.constraint?.startsWith("deal_one_open_per_listing_buyer"))
//          return { error: DEAL_ALREADY_OPEN };                            // concurrent double-create — race đã đóng
//        throw e;                                                           // mọi lỗi khác rethrow (fail closed)
//      }
//      (SqlQueryError từ driver Postgres — route trên sqlState + constraint theo
//       .agents/skills/prisma-8/references/debug.md § SQL driver errors; KHÔNG map mù mọi 23505.)
//   9. notify(listing.sellerId, "deal", "Thỏa thuận mới", listing.title.slice(0, 60), `/chat/${convo.id}`)
//      — PII-free: tiêu đề typed + link; KHÔNG giá, KHÔNG thông tin liên hệ (Q6/§4.8)
//  10. await emitProductEvent({ name: "deal_created", actorId: user.id, sessionId: user.sessionId,
//        conversationId: convo.id, listingId: listing.id,
//        provinceCode: listing.provinceLevelCode ?? null,
//        metadata: { dealId: deal.id, fulfillmentMethod } })   [SAU tx thành công — fail-open; schema đã mở rộng ở bước 11]
//  11. (cùng commit) src/lib/product-events.ts — EVENT_SCHEMAS mở rộng ADDITIVE cho 4 event Deal (Q4/Q6):
//        deal_created          → metadata { dealId: z.uuid(), fulfillmentMethod: z.enum(DEAL_FULFILLMENT_METHODS).nullish() }
//        deal_outcome_marked   → metadata { dealId: z.uuid(), outcome: z.enum(DEAL_OUTCOMES), role: z.enum(["buyer","seller"]) }
//        successful_match      → metadata { dealId: z.uuid() }
//        listing_marked_sold  → metadata { dealId: z.uuid() }
//      KHÔNG schema hiện có bị yếu đi; KHÔNG field free-text; KHÔNG giá tiền trong metadata (§4.8 — agreedPrice
//      KHÔNG BAO GIỜ vào event). Batch 5 đã ship các schema này ở dạng minimal — Batch 6 chỉ thêm key typed.
```

- [ ] **Step 1: Write the failing unit tests**

`tests/unit/deal-create.test.ts` (mock db with in-memory `Deal`/`DealStatusHistory`/`Listing`/`Conversation`/`UserSuspension`/`SellerVerification`/`BetaCohortMembership`/`UserBlock` maps; the Global Constraints stubbing recipe; spy on `emitProductEvent` (mock `@/src/lib/product-events`) + `notify`; `resetRateLimits()` in `beforeEach`):

- `happy path: buyer with an existing conversation creates an open Deal` — row with the exact §5.2 fields (`status: "open"`, `agreedPrice`, `fulfillmentMethod`), one `DealStatusHistory` row (`status: "open"`, `actorId: buyer`, `note: "buyer:created"`), seller notified with the conversation link, `deal_created` emitted **after** the tx with `conversationId` + `listingId` + `metadata.dealId` (Review Focus 4 adjacent: assert the payload has **no** `agreedPrice`).
- `no conversation → DEAL_CONVERSATION_REQUIRED, no Deal` (§5.2 relationship — Review Focus 1: a buyer with a conversation on a DIFFERENT listing also fails here).
- `listing not approved (draft/sold/…) → LISTING_NOT_DEALABLE, no Deal` (§5.2 "live eligible listing").
- `own listing → DEAL_OWN_LISTING, no Deal`.
- `seller suspended → form error SELLER_SUSPENDED; revoked verification → SELLER_NOT_VERIFIED; inactive membership → SELLER_MEMBERSHIP_INACTIVE` (§5.2 creation requirements — Review Focus 2).
- `buyer suspended → ACCOUNT_SUSPENDED; block either direction → CHAT_BLOCKED` — **delegation spy**: `assertCanStartConversation` (the Batch 3 module) was called with `(buyer, seller)` (Q5 reuse pin).
- `existing OPEN deal → DEAL_ALREADY_OPEN (pre-check), no second row`.
- `concurrent double-create (Promise.all, both pass the pre-check) → exactly ONE Deal row; the loser gets DEAL_ALREADY_OPEN` (partial unique index — Review Focus 3; **the unit mock's in-memory `Deal.create` throws a `SqlQueryError`-shaped object** — `{ sqlState: "23505", constraint: "deal_one_open_per_listing_buyer" }` — so the S2 catch path is exercised; a plain `Error` would be rethrown, not mapped).
- `a NON-unique driver error inside the tx RETHROWS` (fail closed — e.g. a mocked `23503` FK violation or a plain `Error` surfaces as the thrown error, never as `DEAL_ALREADY_OPEN`).
- `a NEW deal after the previous one reached completed/cancelled/no_deal → allowed` (D4 — terminal rows coexist).
- `agreedPrice: empty → null; "500000" → 500000; "abc"/"-1"/"50000" (under the 100_000 min)/"> 2_000_000_000" → DEAL_PRICE_INVALID, no row` (D5 — the real `listings.ts` bound).
- `fulfillmentMethod: valid → stored; invalid → DEAL_FULFILLMENT_INVALID; omitted → null`.
- `rate limit: 21st deal mutation within the hour → RATE_LIMITED, no row` (§7.1).
- `no session → the auth mock throws NEXT_REDIRECT:/login, zero db calls` (the Global Constraints no-session recipe).
- `guard-rejected create emits NOTHING` (emission after guards — spy not called on the error paths).
- `notify payload carries no price and no contact details` (title + listing title slice + link only — Q6).
- `buyer-only creation (D11): the deal row records conversationId = the (listing, buyer) conversation's id` (S11 — the panel/notify/emissions key).

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/unit/deal-create.test.ts`
Expected: FAIL — `src/lib/actions/deals.ts` missing.

- [ ] **Step 3: Implement**

- `src/lib/actions/deals.ts` per the interface block — zod validation, the §5.2 guard order (validation → listing → actor guards (Batch 3 reuse) → seller eligibility → conversation relationship → pre-check → tx), the **S2 catch outside `db.transaction`** (map only `SqlQueryError` `sqlState === "23505"` + `constraint` starting `deal_one_open_per_listing_buyer` → `DEAL_ALREADY_OPEN`; rethrow everything else), notify + emission after the tx. Only async exports; `DealFormState` is a type export (erased at compile — the `offers.ts` precedent).
- `src/lib/product-events.ts`: extend the four deal-event schemas additively per the interface block (Q4 — this is the one Batch 5 file Batch 6 edits; no existing schema weakened; the extension lands in this commit because `deal_created` needs `dealId`).

- [ ] **Step 4: Run tests until green**

Run: `npm test -- tests/unit/deal-create.test.ts` → PASS.
Run: `npm test` → full unit suite green — **including Batch 5's `product-events.test.ts`** (the schema extension is additive; if its strict-schema cases need the new keys reflected, extend that suite's cases in this commit without weakening any assertion).

- [ ] **Step 5: Commit**

```bash
git add src/lib/actions/deals.ts src/lib/product-events.ts tests/unit/deal-create.test.ts
git commit -m "feat(deal): lightweight deal creation"
```

## Task 5: `markDealOutcomeAction` — bilateral confirmation, atomic claims, successful-match analytics

**Files:**

- Modify: `src/lib/actions/deals.ts` (add `markDealOutcomeAction`)
- Test: `tests/unit/deal-outcome.test.ts`
- Test: `tests/integration/deal-lifecycle.test.ts`

**Interfaces:**

- Consumes: everything from Task 4 + `assertDealParticipant`/`assertDealOutcomeAllowed`/`DEAL_OUTCOMES`/`DEAL_CANCELLATION_REASON_MAX` (Task 2), `emitProductEvent` (Batch 5), `notify` (existing).
- Produces (used by Task 6 forms; the semantics are the recorded decisions D3 — read them before implementing):

```ts
// src/lib/actions/deals.ts (thêm)
export async function markDealOutcomeAction(
  _prev: DealFormState,
  formData: FormData,
): Promise<DealFormState>;
//   formData: dealId, outcome ("success" | "no_deal" | "cancelled"), cancellationReason? (chỉ "cancelled"),
//             markSold? ("on" — CHỈ có nghĩa khi role === "seller" && outcome === "success"; default off — D6/FD-3)
//
//   SEMANTICS (D3 — recorded, reversible; §5.2 "Either party may independently mark outcome"):
//   Mỗi bên đánh dấu kết quả MỘT LẦN, bất kỳ lúc nào, theo vai của chính mình (buyerOutcomeAt / sellerOutcomeAt):
//     - "success"   → set outcomeAt của bên gọi. Nếu SAU đó CẢ HAI outcomeAt đã set VÀ deal còn "open"
//                     → claim open→completed + completedAt (bilateral confirmation — §5.2).
//                     Nếu deal đã terminal (bên kia đã mark no_deal/cancelled trước) → KHÔNG transition,
//                       KHÔNG successful_match — mismatch được ghi nhận trong history (A1 — không tự resolve).
//     - "no_deal"   → set outcomeAt của bên gọi + claim open→no_deal (unilateral — D3).
//     - "cancelled"→ set outcomeAt của bên gọi + claim open→cancelled + cancellationReason (≤500).
//   MARK SOLD (D6/FD-3 — S7): KHÔNG tự động. Chỉ khi role === "seller" && outcome === "success" &&
//   markSold === true → claim Listing approved→sold trong CÙNG tx. Bilateral completion một mình
//   KHÔNG bán listing (sold là không thể hoàn tác; một listing có thể giao dịch với nhiều buyer —
//   bán tự động là policy bị chế; lựa chọn tường minh của seller là default an toàn theo FD-3).
//   IDEMPOTENCY (gate item "Deal idempotency"):
//     - re-submit CÙNG giá trị sau khi đã mark → no-op thành công (không history row mới, không event, không notify)
//     - re-submit KHÁC giá trị → { error: DEAL_ALREADY_MARKED } — kết quả per party là immutable (fail closed;
//       đường sửa sai = ops reconciliation A1, không phải self-service)
//   CONCURRENCY (gate item "Deal concurrency" — mọi transition là ATOMIC CLAIM, builder order .where().updateAll()):
//     1. requireUser → checkRateLimit(`deal:mutation:${user.id}`, DEAL_MUTATION_RATE) → RATE_LIMITED
//     2. deal = Deal.first({ id }) → thiếu → { error: DEAL_FORBIDDEN }   [S9 — CÙNG mã với non-participant:
//        probe dealId không phân biệt tồn tại/không — không existence oracle]
//     3. role = assertDealParticipant(deal, user.id) → khác → { error: DEAL_FORBIDDEN }   [IDOR — Review Focus 1]
//     4. await assertDealOutcomeAllowed(user.id, counterpartId, outcome)   [D10 — §7.8 "Deal mutation":
//        suspension → ACCOUNT_SUSPENDED cho MỌI outcome; block → CHAT_BLOCKED CHỈ cho "success";
//        no_deal/cancelled ĐƯỢC PHÉP dưới block — chặn không được làm stranded bản ghi kết quả (§5.5)]
//     5. const result = await db.transaction(async (tx) => {
//          // ATOMIC CLAIM per party:
//          const claimed = await tx.orm.public.Deal
//            .where({ id: dealId, [roleOutcomeAt]: null })
//            .updateAll({ [roleOutcomeAt]: now });            // 1 row → marking mới
//          if (claimed === 0) {
//            // bên này ĐÃ mark — idempotency qua DealStatusHistory note prefix CHÍNH XÁC `<role>:<outcome>`:
//            const last = await tx.orm.public.DealStatusHistory
//              .where({ dealId, actorId: user.id }).orderBy(createdAt desc).first();
//            if (last?.note?.startsWith(`${role}:${outcome}`)) return { noop: true };   // cùng giá trị → no-op
//            throw new Error("DEAL_ALREADY_MARKED");                                    // khác giá trị → fail closed
//          }
//          let completedClaimed = false, soldClaimed = false;
//          if (outcome === "success") {
//            const fresh = await tx.orm.public.Deal.first({ id: dealId });               // re-read trong tx
//            if (fresh.buyerOutcomeAt && fresh.sellerOutcomeAt) {
//              const completed = await tx.orm.public.Deal
//                .where({ id: dealId, status: "open" })
//                .updateAll({ status: "completed", completedAt: now });                 // ATOMIC CLAIM
//              completedClaimed = completed > 0;   // 0 row → deal đã terminal bởi bên kia (mismatch) — KHÔNG completed
//            }
//            // MARK SOLD (D6): chỉ seller + markSold + listing còn approved — trong CÙNG tx
//            if (role === "seller" && markSold && deal.listingId) {
//              const sold = await tx.orm.public.Listing
//                .where({ id: deal.listingId, status: "approved" })
//                .updateAll({ status: "sold" });                                        // ATOMIC CLAIM
//              soldClaimed = sold > 0;             // 0 row → listing đã đổi trạng thái — KHÔNG sold, KHÔNG event
//            }
//          } else {
//            const reason = outcome === "cancelled" ? cancellationReason : null;         // ≤ DEAL_CANCELLATION_REASON_MAX
//            const moved = await tx.orm.public.Deal
//              .where({ id: dealId, status: "open" })
//              .updateAll({ status: outcome, cancellationReason: reason ?? null });      // ATOMIC CLAIM (unilateral — D3)
//            // moved === 0 → deal đã terminal → marking vẫn được ghi (history), không transition
//          }
//          // history row cho marking này — status = trạng thái deal SAU marking (re-read), note = `<role>:<outcome>` (+ reason)
//          await tx.orm.public.DealStatusHistory.create({ dealId, status: <status after>,
//            actorId: user.id, note: `${role}:${outcome}` + (reason ? ` ${reason}` : "") });
//          return { noop: false, completedClaimed, soldClaimed, outcome, role };
//        });   // tx COMMIT ở đây — mọi emission + notify SAU commit (S1: emitProductEvent ghi qua db,
//              // KHÔNG qua tx, fail-open → emission trong tx có thể tạo phantom successful_match khi rollback)
//     6. SAU commit (S1):
//        if (!result.noop) {
//          notify(counterpartId, "deal", "Thỏa thuận có kết quả mới", <typed label>,
//                 deal.conversationId ? `/chat/${deal.conversationId}` : "/chat")   [PII-free — Q6]
//          await emitProductEvent({ name: "deal_outcome_marked", actorId: user.id,
//            sessionId: user.sessionId, conversationId: deal.conversationId, listingId: deal.listingId,
//            metadata: { dealId, outcome, role } })   [KHÔNG cancellationReason free-text, KHÔNG giá — §4.8]
//        }
//        if (result.completedClaimed) await emitProductEvent({ name: "successful_match",
//          actorId: user.id, sessionId: user.sessionId, conversationId: deal.conversationId,
//          listingId: deal.listingId, metadata: { dealId } })   [chỉ khi claim approved→sold thắng — D6]
//        if (result.soldClaimed) await emitProductEvent({ name: "listing_marked_sold",
//          actorId: user.id, sessionId: user.sessionId, listingId: deal.listingId,
//          metadata: { dealId } })   [chỉ khi claim approved→sold thắng — D6]
//        (mọi emission fail-open — telemetry không bao giờ làm hỏng marking; KHÔNG emission khi noop)
```

- [ ] **Step 1: Write the failing unit tests**

`tests/unit/deal-outcome.test.ts` (mock db with in-memory `Deal`/`DealStatusHistory`/`Listing`/`Conversation` maps + the Batch 3 guard mocks; spy on `emitProductEvent` + `notify`; `resetRateLimits()` in `beforeEach`):

- `buyer marks success → buyerOutcomeAt set, status STAYS open, history row (open, "buyer:success"), deal_outcome_marked emitted AFTER commit, seller notified; NO sold transition (markSold is seller-only — D6)` (§5.2 independence).
- `seller then marks success WITHOUT markSold → sellerOutcomeAt set + status → completed + completedAt + successful_match emitted EXACTLY ONCE; listing STAYS approved — NO listing_marked_sold` (bilateral completion alone never sells — D6/S7).
- `seller marks success WITH markSold → completed + successful_match + listing approved → sold + listing_marked_sold emitted + history rows` (the explicit seller choice — D6).
- `buyer submits markSold → ignored (no sold transition, no event)` (markSold is seller-only — the form never offers it to the buyer, the action ignores it).
- `seller marks success with markSold on a listing already sold/removed → sold claim 0 rows → NO listing_marked_sold, marking + completion unaffected`.
- `re-marking the SAME outcome → idempotent no-op`: no new history row, no event, no notify, success state (gate item "Deal idempotency" — the history-note `<role>:<outcome>` prefix match).
- `re-marking a DIFFERENT outcome → DEAL_ALREADY_MARKED, no mutation` (per-party immutability — D3).
- `mark no_deal → status → no_deal + history + notify; NO successful_match` (D3 unilateral).
- `mark cancelled with a reason → status → cancelled + cancellationReason stored; reason over 500 chars → validation error, no mutation; reason on "no_deal" → ignored/not stored` (D3).
- `mismatch: buyer success + seller no_deal → deal no_deal, NO successful_match, BOTH markings recorded in history` (the A1 mismatch shape — §5.2 "emitted only when both sides confirm").
- `concurrent both-success (Promise.all) → ONE completed transition, successful_match emitted exactly once (the claim winner), both outcomeAt set, one completedAt` (Review Focus 3 — atomic claim).
- `concurrent success vs no_deal (Promise.all) → NO completed transition, NO successful_match, one marking wins the status claim, the other records against the terminal status` (claim order).
- `non-participant third user → DEAL_FORBIDDEN, zero writes; MISSING dealId → DEAL_FORBIDDEN too` (S9 — same code, no existence oracle; Review Focus 1 — Deal IDOR).
- `buyer acting on ANOTHER buyer's deal → DEAL_FORBIDDEN` (cross-account Deal modification — §7.3).
- `suspended actor → ACCOUNT_SUSPENDED for all three outcomes` (delegation spy on `isUserSuspended`).
- `blocked pair: outcome "success" → CHAT_BLOCKED; outcome "no_deal"/"cancelled" → ALLOWED, marking recorded` (D10/FD-3 — a blocked pair can still record that the deal fell through; delegation spy on `getBlockState`).
- `rate limit: 21st mutation in the hour → RATE_LIMITED`.
- `telemetry payload: deal_outcome_marked metadata = { dealId, outcome, role } typed — NO cancellationReason free text, NO price, NO markSold flag` (§4.8 — Review Focus 5).
- `rollback phantom check (S1)`: mock the tx to throw AFTER the completed claim → assert NO successful_match/listing_marked_sold/deal_outcome_marked row and NO notify (emissions are after commit, driven by the returned flags — a rolled-back tx returns nothing).
- `no session → the auth mock throws NEXT_REDIRECT:/login, zero db calls`.

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/unit/deal-outcome.test.ts`
Expected: FAIL — action missing.

- [ ] **Step 3: Implement**

- `markDealOutcomeAction` per the interface block — the per-party atomic claim, the bilateral-completed claim, the seller-chosen `markSold` sold claim (D6), history appends, and the **flags-returning transaction** (`{ noop, completedClaimed, soldClaimed }`) with **every notify + emission after commit** (S1). Guard order pinned: rate limit → load (`DEAL_FORBIDDEN` for missing — S9) → participant → `assertDealOutcomeAllowed` (D10) → tx. `redirect()` never inside `catch` (this action returns form state, no redirect).

- [ ] **Step 4: Write the real-DB lifecycle/concurrency integration test**

`tests/integration/deal-lifecycle.test.ts` (real DB; the Global Constraints stubbing recipe for the action boundary — `requireUser` fixture, `next/cache`/`next/navigation` mocked, db REAL; seed a verified+active seller + approved listing + conversation per the Batch 4 verified-seller fixture pattern; **`vi.stubEnv("PRODUCT_EVENT_PSEUDONYM_KEY", <fixed 32-byte base64 test key>)`** so `emitProductEvent` does not fail open and the row-count assertions below are non-vacuous — S6):

- `create → buyer success → seller success (markSold) happy path`: `createDealAction` → `markDealOutcomeAction(success)` × 2 (seller's with `markSold`) → deal `completed`, `completedAt` set, exactly ONE `successful_match` `ProductEvent` row (query `ProductEvent` where name — **assert positive counts**, not just "no more than one"), listing `sold`, one `listing_marked_sold` row, `DealStatusHistory` rows appended in order (open → buyer:success → completed), seller notified twice (create + outcome) with no PII.
- `finance isolation over the full lifecycle (S5)`: snapshot counts of `Order`, `Payment`, `Payout`, `LedgerEntry`, `WithdrawRequest` before and after the whole create→success→success flow — **identical** (the §9 gate's lifecycle half; Task 1 covers the structural half, Task 7 the source/import half).
- `bilateral completion WITHOUT markSold → listing STAYS approved, NO listing_marked_sold row` (D6 — sold is an explicit seller choice, never automatic).
- `double-create race (Promise.all) → one open Deal; loser DEAL_ALREADY_OPEN` (partial unique index against the real DB — Review Focus 3).
- `both-success race (Promise.all) → one completedAt, one successful_match event` (atomic claim against the real DB).
- `success vs no_deal race → no completed, no successful_match, mismatch recorded` (A1 shape).
- `idempotent re-mark → no new history/event rows`.
- `non-participant marking → DEAL_FORBIDDEN, zero rows; missing dealId → DEAL_FORBIDDEN` (S9).
- `blocked pair: no_deal marking still allowed; success marking refused` (D10 — real `UserBlock` rows).
- `seller eligibility enforced fresh from the DB`: revoke the seller's `SellerVerification` mid-deal → `markDealOutcomeAction` still works for the EXISTING deal (§7.8 gates *Deal mutation* on actor suspension/block — the deal row already exists; creation is where eligibility lives) — **pinned intentionally** (D2 perimeter: eligibility gates creation + new chat, not ongoing deal participation).

- [ ] **Step 5: Run until green**

Run: `npm test -- tests/unit/deal-outcome.test.ts` → PASS.
Run: `npm run test:integration` → `deal-lifecycle.test.ts` + every earlier integration suite green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/actions/deals.ts tests/unit/deal-outcome.test.ts tests/integration/deal-lifecycle.test.ts
git commit -m "feat(deal): bilateral deal outcome with successful-match analytics"
```

## Task 6: Deal/outcome UI + §6.4 external-payment safety guidance + §6.1 secondary CTA

**Files:**

- Create: `src/components/safety-guidance.tsx` (plain component — zero server imports)
- Create: `src/components/deal-panel.tsx` (server component — props in, React out)
- Create: `src/components/deal-create-form.tsx` (`"use client"`, `useActionState(createDealAction)`)
- Create: `src/components/deal-outcome-form.tsx` (`"use client"`, `useActionState(markDealOutcomeAction)`)
- Modify: `'app/chat/[id]/page.tsx'` (mount `DealPanel` + `SafetyGuidance` — Batch 3's block banner + report dialog stay)
- Modify: `'app/listings/[slug]/page.tsx'` (secondary CTA `Tạo thỏa thuận` per §6.1 — Batch 3's report dialog + Batch 5's view/click emission stay)
- Modify: `src/lib/constants.ts` (additive: `DEAL_STATUS_LABELS`, `DEAL_FULFILLMENT_METHOD_LABELS`, `DEAL_OUTCOME_LABELS`)
- Test: `tests/unit/deal-ui.test.ts`

**Interfaces:**

- Consumes: `createDealAction`/`markDealOutcomeAction`/`DealFormState` (Tasks 4/5), `DEAL_STATUSES`/`DEAL_FULFILLMENT_METHODS`/`DEAL_OUTCOMES`/`DEAL_CANCELLATION_REASON_MAX` (`src/lib/deal-vocab.ts` — **the only server module the client forms import besides `constants.ts` and the actions**), `getCurrentUser` (Batch 2), `db`.
- Produces:

```tsx
// src/components/safety-guidance.tsx — plain component (KHÔNG "use client", KHÔNG db — render thuần).
// §6.4 Independent Transaction Safety Guidance — 6 điểm nguyên văn spec (dịch tiếng Việt, Batch 8 duyệt văn bản):
//   1. "Thanh toán và giao nhận hàng do bạn và người bán tự thỏa thuận, diễn ra độc lập ngoài LoaViet."
//   2. "Kiểm tra kỹ tình trạng sản phẩm trước khi thanh toán."
//   3. "Ưu tiên gặp gỡ, kiểm tra thử loa ở nơi công cộng phù hợp."
//   4. "Không bao giờ chia sẻ mã OTP hoặc mật khẩu cho bất kỳ ai."
//   5. "Cẩn trọng với các đường link thanh toán đáng ngờ."
//   6. "Nếu gặp vấn đề, dùng chức năng báo cáo hoặc chặn người dùng."
// + dòng §5.2 (BẮT BUỘC trong UI — spec §5.2 "The UI must state"):
//   "Thanh toán và giao nhận hàng diễn ra độc lập ngoài LoaViet."
// + dòng trung tính hiện có (Batch 1): "LoaViet không giữ tiền và không bảo đảm giao dịch."
// KHÔNG ngôn ngữ đảm bảo/bảo hiểm/bảo vệ thanh toán (§4.2/§6.4 — KHÔNG phát minh văn bản pháp lý — Batch 8 duyệt).

// src/components/deal-panel.tsx — server component. Props:
//   { deal: { id; status; agreedPrice; fulfillmentMethod; buyerOutcomeAt; sellerOutcomeAt;
//             cancellationReason; createdAt } | null;
//     listing: { id; title; status } | null;
//     viewerRole: "buyer" | "seller" }
//   - deal === null || isTerminalDealStatus(deal.status)   [S11 — deal terminal → buyer được tạo deal MỚI]
//     && listing?.status === "approved" && viewerRole === "buyer" → DealCreateForm (§6.1)
//     (deal terminal vẫn hiển thị trạng thái cuối ở trên + form tạo mới ở dưới)
//   - deal ≠ null → trạng thái (DEAL_STATUS_LABELS) + agreedPrice (formatVND, "giá thỏa thuận đã ghi —
//     tự nhập, LoaViet không thu") + fulfillment label + §5.2 line
//   - deal?.status === "open" && outcomeAt của viewer chưa set → DealOutcomeForm
//   - viewer đã mark → "Bạn đã đánh dấu kết quả" + chờ counterpart (không form)
//   - listing === null (listing đã xóa — SetNull) → status-only, không create form
//     (deal VẪN hiển thị vì panel tra theo conversationId — S11)
//   KHÔNG dangerouslySetInnerHTML — cancellationReason render React text (stored-XSS contract).
//   KHÔNG render SafetyGuidance ở trong panel — trang hội thoại mount nó MỘT LẦN (tránh render đôi).

// src/components/deal-create-form.tsx — "use client", useActionState(createDealAction):
//   agreedPrice input (optional, number), fulfillmentMethod select (DEAL_FULFILLMENT_METHODS + "—"),
//   submit "Tạo thỏa thuận". Props: { listingId: string; variant?: "full" | "compact" } —
//   "compact" (listing page §6.1) render chỉ nút submit (agreedPrice/fulfillmentMethod → null);
//   "full" (deal panel) render đủ hai trường. Import CHỈ từ deal-vocab.ts + constants.ts +
//   actions/deals.ts (B2 hygiene — createDealAction có chữ ký useActionState nên KHÔNG gọi được
//   từ <form action> thô; mọi mount đều qua component này).

// src/components/deal-outcome-form.tsx — "use client", useActionState(markDealOutcomeAction):
//   3 nút radio/select: success ("Thỏa thuận thành công") / no_deal ("Không đạt thỏa thuận") /
//   cancelled ("Đã hủy thỏa thuận") + textarea cancellationReason (chỉ hiện khi chọn cancelled,
//   maxLength DEAL_CANCELLATION_REASON_MAX) + submit.
//   + markSold checkbox "Đánh dấu tin đã bán" — CHỈ render khi viewerRole === "seller" &&
//     chọn "success" (default OFF — D6/FD-3; buyer không thấy; action bỏ qua markSold từ buyer).
//   Import như DealCreateForm.

// app/chat/[id]/page.tsx — sau ChatWindow (giữ nguyên block banner + report dialog của Batch 3):
//   load deal = Deal.where({ conversationId: convo.id })     [S11 — tra theo HỘI THOẠI, không theo
//     .orderBy(createdAt desc).first()                        (listingId, buyerId): deal sống qua
//                                                              listing deletion nhờ Deal.conversationId]
//   → <DealPanel deal={deal} listing={convo.listing ? {…} : null}
//       viewerRole={user.id === convo.buyerId ? "buyer" : "seller"} />
//   → <SafetyGuidance />   (§6.4 "near chat/deal flows" — MỘT LẦN, sau panel)

// app/listings/[slug]/page.tsx — trong khối CTA (giữ nguyên disclaimer Batch 1 + report dialog
// Batch 3 + emission Batch 5):
//   sellerEligible = await assertListingSellerInteractable(listing.sellerId) resolve/catch   [D12]
//   listing.status === "approved" && !isOwner && user && sellerEligible
//     → form "Nhắn người bán" (hiện có) + <DealCreateForm listingId={…} variant="compact" /> (§6.1)
//   listing.status === "approved" && !isOwner && user && !sellerEligible
//     → copy trung tính "Người bán hiện không nhận tin nhắn mới" THAY vì CTA chết
//     (action vẫn enforce — UI chỉ là convenience, §4.5; legacy approved listing của seller
//     chưa xác minh vẫn searchable nhưng new chat bị chặn ở action — D12)
//   Lỗi DEAL_CONVERSATION_REQUIRED hiển thị state.error ("Hãy nhắn người bán trước khi tạo thỏa thuận").

// src/lib/constants.ts (thêm — additive):
//   DEAL_STATUS_LABELS: Record<DealStatus, string>          // open "Đang mở" / completed "Hoàn tất" / cancelled "Đã hủy" / no_deal "Không đạt"
//   DEAL_FULFILLMENT_METHOD_LABELS: Record<DealFulfillmentMethod, string>
//   DEAL_OUTCOME_LABELS: Record<DealOutcome, string>
```

- [ ] **Step 1: Write the failing source-contract tests**

`tests/unit/deal-ui.test.ts` (source-contract style of `tests/unit/finance-public-surface.test.ts` — read the component/page source, assert the boundary; no jsdom):

- `SafetyGuidance states the six §6.4 points and the §5.2 line` — source asserts each Vietnamese string (payment outside LoaViet / verify condition before payment / public meetup-testing / never share OTP-password / suspicious payment links / report-block).
- `no guarantee/insurance/escrow language in any Batch 6 component` — scan `safety-guidance.tsx`, `deal-panel.tsx`, `deal-create-form.tsx`, `deal-outcome-form.tsx` for `đảm bảo|bảo đảm|bảo hiểm|bảo vệ thanh toán|giữ tiền hộ|escrow|guarantee|insurance` → **0 hits** (§4.2/§6.4 — Review Focus 5; the neutral "không giữ tiền và không bảo đảm giao dịch" line is the *negation* and is asserted present, the scan is for *affirmative* promise wording — classify carefully: the negation contains "bảo đảm" inside "không bảo đảm"; the test asserts the exact negation string present and no *other* occurrence).
- `deal-panel renders the §5.2 line + DEAL_STATUS_LABELS + formatVND for agreedPrice; mounts DealCreateForm for buyer+approved when deal is null OR terminal (S11 — a terminal latest deal does not block a new create); DealOutcomeForm only while open and unmarked; renders NO SafetyGuidance of its own` (source assertions).
- `deal-outcome-form renders the markSold checkbox only for the seller + success selection, default off` (D6 — source assertion).
- `SafetyGuidance is mounted exactly ONCE on the conversation page` (source assertion on `'app/chat/[id]/page.tsx'` — the panel must not duplicate it).
- `no dangerouslySetInnerHTML in any Batch 6 component` (cancellationReason renders as React text — stored-XSS contract).
- `the client forms import only deal-vocab.ts + constants.ts + the actions` — source assertion: no `db.client`, no `server-only`, and **no import statement whose module specifier resolves exactly to `@/src/lib/deal`** (exact-module match — a substring scan would false-positive on `@/src/lib/deal-vocab`) in `deal-create-form.tsx`/`deal-outcome-form.tsx` (B2 hygiene).
- `the conversation page loads the deal by conversationId (not (listingId, buyerId)) and keeps Batch 3's block banner/report dialog` (source assertion on `'app/chat/[id]/page.tsx'` — S11).
- `the listing page gates both CTAs on seller eligibility (D12): eligible → Nhắn người bán + Tạo thỏa thuận; ineligible → neutral copy "Người bán hiện không nhận tin nhắn mới" instead of dead buttons; keeps the Batch 1 disclaimer line` (source assertion on `'app/listings/[slug]/page.tsx'`).
- `DEAL_STATUS_LABELS / DEAL_FULFILLMENT_METHOD_LABELS / DEAL_OUTCOME_LABELS keys ⊆ the vocab arrays` (drift — every label key is a valid vocab value, every vocab value has a label).

- [ ] **Step 2: Run to verify failure** → `npm test -- tests/unit/deal-ui.test.ts` → FAIL (components missing).

- [ ] **Step 3: Implement**

- The four components + the two page mounts + the label maps per the interface blocks. Reuse the existing Tailwind class conventions (`card`, `btn-primary`, `input`, `label`); every control has an associated `<label htmlFor>` (spec §10 accessibility line). `deal-panel.tsx` loads nothing itself — the conversation page passes the loaded deal (one query by `conversationId`, `orderBy createdAt desc`, `first()` — S11).

- [ ] **Step 4: Run until green**

Run: `npm test -- tests/unit/deal-ui.test.ts` → PASS. Then `npm test` → full unit suite green (Batch 3's `moderation-pages.test.ts`/`chat-guard` suites and Batch 5's `telemetry-wiring.test.ts` untouched — the mounts are additive).

- [ ] **Step 5: Commit**

```bash
git add src/components/safety-guidance.tsx src/components/deal-panel.tsx src/components/deal-create-form.tsx src/components/deal-outcome-form.tsx 'app/chat/[id]/page.tsx' 'app/listings/[slug]/page.tsx' src/lib/constants.ts tests/unit/deal-ui.test.ts
git commit -m "feat(deal): outcome UI and external-payment safety guidance"
```

## Task 7: Finance-boundary isolation proof — source scan + import graph

**Files:**

- Test: `tests/unit/deal-finance-isolation.test.ts`

**Interfaces:**

- Consumes: the Batch 6 source files (read as text — the `finance-public-surface.test.ts` source-scan pattern) + the repo's import graph.
- Produces: the §9 Batch 6 Gate proof — **"No Deal action creates Payment / Payout / Wallet / Ledger / Escrow transaction"** as a named, rerunnable test.

- [ ] **Step 1: Write the failing test** (it may pass immediately once the surfaces exist — that is acceptable for a contract test; record which cases needed fixes)

`tests/unit/deal-finance-isolation.test.ts`:

- **Source scan** — read the source of every Batch 6 deal/chat surface (`src/lib/actions/deals.ts`, `src/lib/deal.ts`, `src/lib/deal-vocab.ts`, `src/lib/actions/chat.ts`, `src/lib/actions/wishlist.ts`, `'app/api/chat/[id]/route.ts'`, `src/components/deal-panel.tsx`, `src/components/deal-create-form.tsx`, `src/components/deal-outcome-form.tsx`, `src/components/safety-guidance.tsx`) and assert **zero word-boundary occurrences** of the finance models and helpers: `Order`, `OrderItem`, `Payment`, `Payout`, `WithdrawRequest`, `LedgerEntry`, `Dispute`, `Cart`, `CartItem`, `Offer`, `ExchangeOffer`, `recordLedgerTx`, `escrowIn`, `escrowRelease`, `escrowRefund`, `computeCommission`, `generateOrderCode`, `assertFinancialFeaturesEnabled`, `assertMockPaymentsAllowed` (word boundaries so `orderBy`/`sortOrder`/`border`/`offers` do not false-positive — the Batch 0 inventory FP-1/FP-2 lesson).
- **Raw-SQL forbid (S5)** — the same source scan asserts **zero occurrences** of `db.raw|db.sql|tx.sql|tx.execute|executeRaw|queryRaw|\$queryRaw` in the Batch 6 deal files: raw SQL could reach a finance table in any casing the model-name scan misses, so the deal surfaces are simply **not allowed raw SQL at all** (stronger and simpler than a case-insensitive table-name scan).
- **Import graph** — walk the import graph from `src/lib/actions/deals.ts`, `src/lib/actions/chat.ts`, `src/lib/actions/wishlist.ts`, `'app/api/chat/[id]/route.ts'`, and the four components and assert **no reachable node is a finance module**: `src/lib/escrow.ts`, `src/lib/ledger.ts`, `src/lib/wallet.ts`, `src/lib/momo.ts`, `src/lib/mock-payment.ts`, `src/lib/financial-features.ts`, `src/lib/actions/orders.ts`, `src/lib/actions/offers.ts`, `src/lib/actions/exchange.ts`, `src/lib/actions/cart.ts`, `src/lib/actions/withdraw.ts`, `src/lib/actions/helpers.ts`, `src/lib/actions/reviews.ts` (Q7 — `helpers.ts` is excluded because it imports `financial-features` + `recordLedgerTx`; `utils.ts` is NOT on the denylist — its `computeCommission` is a pure function and the shared `formatVND`/`timeAgo`/`slugify` are legitimately imported; the *source scan* above still forbids `computeCommission`/`generateOrderCode` *call references* in Batch 6 files). **The walker must follow every import form the repo uses** (S5): static `import … from "…"`, dynamic `await import("…")`, side-effect `import "…"`, **and re-exports `export * from "…"` / `export { … } from "…"`** (a bare `export * from` chain would otherwise hide a finance module behind a re-exporting intermediary); resolve `@/` → repo root, relative → dirname, and try `.ts`/`.tsx`/`/index.ts` suffixes when the literal path has no extension; BFS with a visited set; skip `next/*`/`server-only`/`react`/`lucide-react`/`zod`.
- **No direct `ProductEvent` writes** — source scan: zero occurrences of `ProductEvent.create|ProductEvent.update|ProductEvent.delete|ProductEvent.updateAll|ProductEvent.deleteAll` in the Batch 6 files (Q6 — emission only via `emitProductEvent`).
- **No `AuditEvent` writes from Deal actions** — source scan: zero `auditEvent|AuditEvent` references in `src/lib/actions/deals.ts` (Q6 — `DealStatusHistory` is the user-action record; `AuditEvent` stays privileged-actor domain).
- **The dormant finance conversation-creator stays finance-guarded** — source assertion on `src/lib/actions/exchange.ts`: `createExchangeOfferAction` still calls `assertFinancialFeaturesEnabled()` **before** its `Conversation.create` (the Batch 1 boundary unchanged by Batch 6). There are exactly **TWO** `Conversation.create` sites in the repo (S5): `src/lib/actions/chat.ts` (guarded by the Batch 3/6 chat guards) and `src/lib/actions/exchange.ts` (finance-guarded, dormant) — the test enumerates them and asserts both keep their guards.

- [ ] **Step 2: Run** → `npm test -- tests/unit/deal-finance-isolation.test.ts` → record pass/fail per case; fix any violation in its owning file (a violation is a defect, not a test change).

- [ ] **Step 3: Commit**

```bash
git add tests/unit/deal-finance-isolation.test.ts
git commit -m "test(deal): prove finance isolation of deal surfaces"
```

## Task 8: Batch 6 gate verification + verification doc

**Files:**

- Create: `docs/operations/private-beta-batch6-chat-deal-verification.md`

- [ ] **Step 1: Run every gate suite and record results** (spec §9 Batch 6 Gate — every item maps to named tests)

```bash
npm test -- tests/unit/chat-hardening.test.ts tests/unit/deal-domain.test.ts        # chat authorization hardening + §7.8 seller checks + IDOR/polling matrix
npm test -- tests/unit/chat-guard.test.ts tests/unit/block-actions.test.ts          # Batch 3 block enforcement — reused, stays green (gate "blocked-user behavior";
                                                                                    # chat-guard.test.ts = fixtures migrated + ONE pin superseded by D2 — B1)
npm test -- tests/unit/deal-create.test.ts                                           # Deal authorization + creation requirements (gate "Deal authorization")
npm test -- tests/unit/deal-outcome.test.ts                                         # Deal concurrency + idempotency + bilateral confirmation + markSold (gates)
npm test -- tests/unit/deal-finance-isolation.test.ts                                # "No Deal action creates Payment/Payout/Wallet/Ledger/Escrow"
npm test -- tests/unit/deal-ui.test.ts                                               # outcome UI + §6.4 disclaimer copy contracts
npm test -- tests/unit/product-events.test.ts tests/unit/telemetry-wiring.test.ts    # Batch 5 schemas (extended additively) + emissions survived the hardening
                                                                                    # (telemetry-wiring.test.ts = fixtures migrated — B1)
npm run test:integration                                                            # batch6-migration, chat-hardening, deal-lifecycle
                                                                                    # + every Batch 1–5 integration suite
                                                                                    # (block-enforcement/suspension-enforcement = fixtures migrated — B1)
```

- [ ] **Step 2: Backend-enforcement + copy source scan** (spec §4.5/§4.2/§4.8 — every line states its expected result)

```bash
rg -n "assertCanStartConversation|assertCanSendMessage|getBlockState|isUserSuspended" src/lib/actions/deals.ts src/lib/actions/chat.ts src/lib/deal.ts   # expect: reuse/delegation of the Batch 3 guards (Q5/S10)
rg -n "MODERATION_LOCKED_LISTING_STATUSES" src/lib/actions/listings.ts   # expect: Batch 3 R5 guards intact (untouched by Batch 6)
rg -n "\bOrder\b|\bOrderItem\b|\bPayment\b|\bPayout\b|\bWithdrawRequest\b|\bLedgerEntry\b|\bDispute\b|\bCart\b|\bCartItem\b|\bOffer\b|\bExchangeOffer\b|recordLedgerTx|\bescrow\b" src/lib/actions/deals.ts src/lib/deal.ts src/lib/deal-vocab.ts   # expect: 0 hits (Q7 — word boundaries + Cart/Offer added, orderBy/sortOrder không false-positive)
rg -n "db\.raw|db\.sql|tx\.sql|tx\.execute|executeRaw|queryRaw" src/lib/actions/deals.ts src/lib/deal.ts src/lib/deal-vocab.ts   # expect: 0 hits (S5 — no raw SQL in the deal surfaces)
rg -n "ProductEvent" src/lib/actions/orders.ts src/lib/escrow.ts src/lib/wallet.ts src/lib/ledger.ts src/lib/momo.ts src/lib/mock-payment.ts   # expect: 0 hits (B5 scan re-run — no finance module emits)
rg -n "FINANCIAL_FEATURES_ENABLED" .env.example docker-compose.prod.yml scripts   # expect: still "false" everywhere
rg -n "đảm bảo|bảo đảm|bảo hiểm|bảo vệ thanh toán|giữ tiền hộ|\bescrow\b" src/components/safety-guidance.tsx src/components/deal-panel.tsx   # expect: only the exact negation line "không giữ tiền và không bảo đảm giao dịch" — classify every hit
rg -n "dangerouslySetInnerHTML" src/components/deal-panel.tsx src/components/deal-create-form.tsx src/components/deal-outcome-form.tsx src/components/safety-guidance.tsx   # expect: 0 hits
rg -n "emitProductEvent" src/lib/actions/deals.ts   # expect: the deal emissions — AFTER the transaction commit (S1), after guards
rg -n "AuditEvent|auditEvent" src/lib/actions/deals.ts   # expect: 0 hits (Q6 — DealStatusHistory is the user-action record)
```

Manually classify every hit; fix any that violates an invariant.

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

- [ ] **Step 4: Diff/status audit**

- `git diff --check`; `git status --short` contains only Batch 6 files; no `.claude/settings.json`, no `public/uploads/`, no secrets, no scratch.
- `npx prisma migration list` shows `baseline → batch2 → batch3 → batch4 → batch5 → batch6` linear (Q2); `npx prisma db verify` clean.
- Inspect the migration once more: zero destructive ops; no data transform; the partial unique index present.

- [ ] **Step 5: Write the verification doc**

`docs/operations/private-beta-batch6-chat-deal-verification.md` records: base (merged Batch 5 commit) and final commit hashes; OpenCode model/session metadata; per-gate test results (the seven spec §9 Batch 6 gate items + the no-finance-creation line, each naming its test files — see Acceptance Gate); **the B1 supersession record** (the one Batch 3 pin "startConversationAction with a suspended COUNTERPART still creates" superseded by D2 under spec §9 Batch 6 "suspended/revoked seller checks" — NEW chat only — plus the list of migrated Batch 3/5 chat fixtures and the statement that no assertion was weakened); the source-scan classification table; migration review notes (additive-only; the `Deal` FK decisions D9/Restrict and why; `Deal.conversationId` no-FK and why; the partial unique index and which race it closes); the recorded decisions D1–D12 (each flagged for founder review per FD-3, with D6 `markSold` and the D10 block-under-outcome reading named for the **Batch 8 Founder Decision Register**); the telemetry emission map (the four Batch 6 events + the three surviving Batch 5 chat events, with payload examples — all after commit); the §6.4 copy as shipped (flagged for Batch 8 legal review); residual risks (in-memory rate-limiter single-instance topology; the mismatched-outcome records have no resolution path until A1; buyer-side conversation gating absent until Batch 7/A2; **pre-existing wishlist rows on now-non-approved listings remain visible on `/wishlist` and removable, but no new add is possible** — the Task 3 wishlist guard's accepted edge; a seller who forgets to tick `markSold` at marking time has no later self-serve sold path — D6 recorded limitation; browser E2E still deferred — tracked pre-invite prerequisite per spec §10/§12); deferred items (Batch 7/8 pointers); and the explicit statement that **beta-launch readiness additionally requires** the founder decisions in *Ambiguities* (A1 reconciliation rule, A2 buyer gating, A3 dispute semantics — per FD-3 these proceed fail-closed now and sit in the Batch 8 Founder Decision Register as launch blockers) — those are launch prerequisites, not Batch 6 gate failures, and the doc must say so verbatim.

- [ ] **Step 6: Commit**

```bash
git add docs/operations/private-beta-batch6-chat-deal-verification.md
git commit -m "test(batch6): verify chat and deal gate"
```

## Acceptance Gate

Batch 6 is accepted only if all of the following are true (spec §9 Batch 6 Gate — every item maps to named tests):

- **Buyer/seller ownership** — `tests/unit/chat-hardening.test.ts`: `GET`/`POST /api/chat/[id]` return 401 unauthenticated / 404 missing / 403 non-participant, 200/ok for participants; `'app/chat/[id]/page.tsx'` renders only for participants (Batch 3's `notFound()` untouched); `tests/unit/deal-create.test.ts` + `tests/unit/deal-outcome.test.ts`: `createDealAction`/`markDealOutcomeAction` refuse non-participants **and missing deals** with the same `DEAL_FORBIDDEN` (no existence oracle — S9) and zero writes (Deal IDOR / cross-account Deal modification closed).
- **Blocked-user behavior** — Batch 3's suites (`chat-guard.test.ts`, `block-actions.test.ts`, `tests/integration/block-enforcement.test.ts`) stay green, **fixtures migrated; one pin superseded by D2** (B1 — the suspended-counterpart case now asserts `SELLER_SUSPENDED` per spec §9 Batch 6; guards **reused**, not duplicated — Q5 delegation spies in `deal-domain.test.ts`/`deal-create.test.ts`), and the new Deal paths call the same guards: block in either direction → `CHAT_BLOCKED` for creation and success marking, while `no_deal`/`cancelled` markings stay recordable under a block (D10 — a blocked pair can still close its outcome record).
- **Suspended-user behavior** — `tests/unit/chat-hardening.test.ts` + `tests/integration/chat-hardening.test.ts`: a suspended **initiator** cannot start a conversation or send a message (Batch 3, kept), and a suspended/revoked/inactive-membership **listing seller** cannot receive NEW conversations (D2 — §7.8 seller-side, enforced fresh from the DB); `tests/unit/deal-create.test.ts`: a suspended buyer or a seller failing any §5.2 creation requirement cannot create a Deal; `tests/unit/deal-outcome.test.ts`: a suspended actor cannot mark any outcome.
- **Deal concurrency** — `tests/unit/deal-outcome.test.ts` + `tests/integration/deal-lifecycle.test.ts`: concurrent double-create → exactly one open `Deal` (partial unique index); concurrent both-success markings → exactly one `completed` transition, one `completedAt`, one `successful_match` event (atomic claim winner); a completion claim racing a cancellation claim never completes.
- **Deal idempotency** — `tests/unit/deal-outcome.test.ts`: re-submitting the same per-party outcome is a no-op success (no new history row, event, or notification); re-submitting a different outcome fails closed with `DEAL_ALREADY_MARKED`; `createDealAction` on an existing open deal → `DEAL_ALREADY_OPEN`.
- **Deal authorization** — every §5.2 creation requirement is enforced server-side (live approved listing, authorized buyer, own-listing refusal, existing conversation relationship, seller not suspended, buyer not blocked, seller verification valid, active membership) and every outcome marking checks participation + §7.8 actor state — proven by `tests/unit/deal-create.test.ts` + `tests/unit/deal-outcome.test.ts`.
- **Successful-match analytics** — `successful_match` is emitted **only** on bilateral confirmation (both parties marked success and the `open → completed` claim won) — never on a mismatch, never twice, **never from inside the transaction** (S1 — emissions after commit, driven by the returned flags, so a rollback can never leave a phantom event); `listing_marked_sold` only when the **seller explicitly ticked `markSold`** and the `approved → sold` claim won (D6 — bilateral completion alone never sells); `conversation_started`/`conversation_buyer_first_message`/`message_first_response` still emit from the hardened chat paths after all guards (`tests/unit/deal-outcome.test.ts` + `tests/unit/chat-hardening.test.ts` + `tests/integration/deal-lifecycle.test.ts` (with `PRODUCT_EVENT_PSEUDONYM_KEY` stubbed — S6) + Batch 5's `telemetry-wiring.test.ts` green).
- **No Deal action creates Payment / Payout / Wallet / Ledger / Escrow** — `tests/unit/deal-finance-isolation.test.ts` (source scan incl. the raw-SQL forbid + import graph incl. re-export following: zero finance-model references, zero finance modules reachable) + `tests/integration/batch6-migration.test.ts` (finance tables unchanged, `Deal` structurally separate) + `tests/integration/deal-lifecycle.test.ts` (finance row counts identical across the full lifecycle — S5) + the Task 8 `rg` scans.
- **External-payment safety disclaimer** — `tests/unit/deal-ui.test.ts`: the §6.4 six points + the §5.2 line render near chat/deal flows with zero affirmative guarantee/escrow/insurance language (§4.2); the copy is flagged for Batch 8 legal review, not invented beyond the spec.
- **Batch 1 preserved** — all finance shutdown suites + `tests/integration/escrow.test.ts` green unchanged; `FINANCIAL_FEATURES_ENABLED=false` everywhere; the migration is additive-only with zero destructive ops.
- **Batch 2–5 preserved** — every earlier suite green, **fixtures migrated; one pin superseded by D2** (B1 — recorded in the verification doc); Batch 3's R5 guards, Batch 4's publication wrappers, and Batch 5's emission call sites untouched (Q4/Q5); the one Batch 5 file edited (`product-events.ts` — four deal-event schemas extended additively) has its suite extended, not weakened.
- Preflight (lint, typecheck, unit, build, compose, migration graph), the integration suite, safe smoke, and a clean diff/status audit all pass.

## Threat-Case Coverage Map (spec §10.1 rows applicable to Batch 6)

| Abuse case | Covered by |
|---|---|
| Deal IDOR / Cross-account Deal modification | Task 4/5 `assertDealParticipant` + `DEAL_FORBIDDEN` tests (non-participant, other buyer's deal) |
| Listing IDOR (chat/wishlist entry points) | Task 3 listing-status gate (`LISTING_NOT_CONVERSATIONABLE`, wishlist silent refusal) + GET/POST/page participant matrix |
| Blocked-user chat bypass | Batch 3 suites re-run green (guards reused in place; fixtures migrated — B1) + Task 4/5 Deal-path delegation tests; D10 keeps non-success outcome marking recordable under a block (recorded, not stranded) |
| Suspended-user bypass (chat/Deal) | Task 3 actor-side (Batch 3, kept) + seller-side D2 eligibility + Task 4 §5.2 creation requirements |
| Concurrent Deal status update | Task 5 atomic-claim unit cases + `tests/integration/deal-lifecycle.test.ts` real-DB `Promise.all` races |
| Stored XSS through chat | Message bodies render as React text (existing) + `cancellationReason` React text + Task 6/8 `dangerouslySetInnerHTML` scans |
| CSRF on state-changing actions | Next.js 16 server actions are POST-only with built-in origin protection (repo posture, re-recorded in the verification doc — no custom token layer added) |
| Financial direct route / API mutation / webhook / cron / escape hatch | Batch 1 suites re-run in Task 8; `deal-finance-isolation.test.ts` proves Deal adds no finance path; the dormant `exchange.ts` conversation-creator stays finance-guarded (asserted) |
| Privilege escalation / Support → admin | No new admin surface ships in Batch 6 (none in §9 Batch 6 deliverables); Batch 2 RBAC suites re-run green |
| Report flooding / rate abuse on new surfaces | `CONVERSATION_START_RATE` + `DEAL_MUTATION_RATE` via the existing limiter (§7.1) + message caps |

## Ambiguities and Deployment Prerequisites

Recorded per spec §4.11 + §11.1 + **FD-3** (founder decisions 2026-10-06: proceed with the safe/fail-closed default for every recorded ambiguity; items needing founder-authored content ship as clearly-marked pending mechanisms and land in the **Batch 8 Founder Decision Register** as launch blockers — never invented, never blocking execution). None of these is silently resolved by implementation; each is handled fail-closed:

1. **A1 — BLOCKING: the operations reconciliation rule for mismatched bilateral outcomes does not exist.** §5.2: `successful_match` is emitted only on bilateral confirmation **or** "an explicitly approved operations reconciliation rule resolves the mismatch" — no rule is specified (carried from Batch 5 A2, which also leaves the **duplicate handling and attribution period** for `successful_match_rate_v1` unspecified). Batch 6: a mismatch (one `success` + one `no_deal`/`cancelled`, in either order) leaves both markings recorded in `DealStatusHistory`, the deal in the non-success status, **no** `successful_match`, and **no resolution UI/action** — the safer existing behavior is preserved (nothing auto-resolves). *Per FD-3: the fail-closed default ships now; the reconciliation rule (and with it the `successful_match_rate_v1` rate, its dedup/attribution rules, and any admin Deal surface) is a Batch 8 Founder Decision Register item.*
2. **A2 — BLOCKING: buyer-side beta-cohort gating of new conversations is unspecified.** §2.1: "P0 should support restricting new buyer-to-seller conversation creation to active beta participants if operations requires" and "Chat access during the controlled beta is governed by the current beta-access policy" — the policy is Batch 7's "buyer beta access policy" deliverable. Batch 6 does **not** gate buyer-side conversations on cohort membership (any authenticated, non-blocked, non-suspended user may start conversations); the check is one guard away once Batch 7 lands the policy. *Blocks: the buyer-side restriction until Batch 7/founder decides.*
3. **A3 — BLOCKING: Deal dispute/refund/reputation semantics are out of scope by policy.** §4.11/§15: a regretted or contested outcome has no dispute path; no review/reputation eligibility derives from `Deal` in P0 (public reviews are §13.4, post-beta, gated on "Deal outcome integrity"). *Blocks: any dispute/refund/reputation feature — do not build.*
4. **A4 — `cancelled` vs `no_deal` semantics and the unilateral non-success marking are readings, not spec text.** §5.2 gives the statuses and "either party may independently mark outcome" but not who may mark which value or whether one party's non-success marking transitions the deal unilaterally. Batch 6's recorded reading (D3): either party may mark any of the three outcomes; `success` contributes to bilateral completion; `no_deal`/`cancelled` transition the deal unilaterally (the counterpart can still record their own marking — the mismatch is visible, unresolved per A1). Reversible by founder ruling.
5. **A5 — `agreedPrice` bounds reuse the repo's real existing price bound** (`100_000 … 2_000_000_000` VND, the `listings.ts` create-validation bound — D5): empty → null (a deal without a cash component records no price), below-min/above-max → typed error. No new pricing policy is invented; the field is a user-entered record LoaViet never collects (§5.2). Non-blocking.
6. **A6 — a standalone seller "mark sold" action is not built.** §9 Batch 6 lists no such deliverable; the only beta `approved → sold` transition is the seller's explicit `markSold` choice on their own success marking (D6). A seller who sells outside a recorded Deal — or who forgets to tick `markSold` at marking time (outcomes are immutable, D3) — has no self-serve sold path until the founder decides. Non-blocking, recorded; **Batch 8 register item per FD-3.**
7. **A7 — Deal/DealStatusHistory retention is unspecified.** Rows are append-only with no cleanup (the Batch 3 A3 / Batch 5 A6 posture); `Deal.buyer/seller` are `Restrict` so a future account-deletion batch must return through this ambiguity. *Blocks any retention/deletion job.*
8. **A8 — notification delivery is in-app only.** The existing `notify` (Notification table) satisfies "notifications where required"; no email/push ships. Non-blocking.
9. **A9 — the §6.4/§5.2 copy is a faithful translation, not legal text.** Batch 8 reviews Terms/Privacy/Safety Guidance; Batch 6 ships product copy only and must not invent legal language beyond the spec (Q9). Non-blocking for the gate, blocking for beta invites per Batch 8.
10. **A10 — §7.8 "message" vs the D2 perimeter.** §7.8 lists "message" among the actions that must consider "seller-verification revocation; beta-membership status", but D2 (carrying Batch 3 A2) excludes counterpart-side revocation/membership from **messages in existing conversations** — a revoked seller can still reply inside an existing conversation (only their NEW chat/Deal creation is gated). Whether a revoked seller's existing-conversation replies should also be blocked is sanction-adjacent policy §4.11 forbids inventing; the fail-closed-for-trust default (no extra block — history/participation preserved, §5.5 spirit) ships, and the question is recorded for founder ruling alongside Batch 3 A2.

**Recorded decisions (reversible readings, the Batch 2 A5 / Batch 5 D1–D4 pattern; per FD-3 each ships as the safe default and is flagged in the verification doc — D6 and D10 are named Batch 8 register items):**

- **D1 — new conversations require `listing.status === "approved"`** (`CONVERSATION_STARTABLE_LISTING_STATUSES`): matches the listing-page CTA today and Batch 5's search seam; `sold` listings refuse NEW conversations (existing ones reopen — the redirect branch is not "new chat" under §7.8). Extending the constant is a one-line additive change.
- **D2 — the §7.8 seller-side perimeter covers NEW chat + Deal creation only.** Batch 3 A2 keeps counterpart-side suspension out of *messages in existing conversations*; Batch 6 applies the §7.8 list (suspension/revocation/membership) to the listing's seller only where a NEW interaction starts — **this supersedes Batch 3's pinned "suspended counterpart still creates" case for NEW chat, on the authority of spec §9 Batch 6 "suspended/revoked seller checks" (B1; recorded in the verification doc)**. **Ongoing deal participation (outcome marking of an existing deal) is NOT gated on the counterpart's revocation/membership** — only on the actor's own suspension + block (the §7.8 "relevant" reading; blocking a revoked seller from confirming an existing deal would strand the bilateral record — see A10 for the message-side question). The guard reads the §7.8 subset — it deliberately does **not** call `checkSellerPublicationRequirements` (that is the publication gate: email/phone/type/location/rules — publication requirements, not chat requirements).
- **D3 — per-party outcome values are `success | no_deal | cancelled`, immutable once marked** (idempotent same-value re-mark via the exact `<role>:<outcome>` history-note prefix; different-value → `DEAL_ALREADY_MARKED`); the deal status transitions only from `open` via atomic claims. See A4.
- **D4 — one OPEN deal per `(listing, buyer)`; a new deal may follow a terminal one.** The partial unique index enforces the open-deal invariant; nothing in §5.2 forbids a second deal after `no_deal`. The panel shows the create form again once the latest deal is terminal (S11).
- **D5 — `agreedPrice` bound = the repo's real price bound** `100_000 … 2_000_000_000` (`listings.ts` create validation — see A5); empty → null.
- **D6 — the only beta `approved → sold` transition is the seller's explicit `markSold` choice on their own success marking (checkbox, default off).** Bilateral completion alone never sells the listing (S7/FD-3: auto-selling is invented policy — `sold` is irreversible and a listing can transact with multiple buyers; the spec keeps `listing_marked_sold` a separate event from `successful_match`). **Batch 8 register item.**
- **D7 — `DealStatusHistory` is the user-action record; Deal/chat actions write no `AuditEvent`** (Batch 3's report-submission precedent: `AuditEvent` is the privileged-actor domain, §4.6).
- **D8 — the existing chat-message notification keeps its sender-name + 80-char preview** to the recipient (a participant who sees the same content in the conversation); Batch 6's new notifications are typed-label-only. No PII is added anywhere.
- **D9 — `Deal.listingId` is nullable + `SetNull` and `Deal.conversationId` is nullable with no FK** (the `Conversation`/`ProductEvent` precedents): listing deletion is a live surface and outcome records must survive it — the panel, notify links, and telemetry key off `conversationId` so a listing-less deal stays reachable (S11). `DealStatusHistory.actorId` is likewise nullable + `SetNull` (the spec sketch shows it without `?`; the Batch 3 `ModerationAction.actor` precedent wins — history rows survive a future account deletion). `Deal.buyer/seller` are `Restrict` (A7).
- **D10 — outcome marking under a block: non-success markings allowed, success + creation denied** (S8/FD-3). §5.5 says blocking prevents "relevant Deal interaction where appropriate" — the safe reading: a blocked pair may still record `no_deal`/`cancelled` (blocking must not strand the outcome record), while `success` marking and Deal creation stay block-denied. Suspension still blocks every marking (§7.8). **Batch 8 register item.**
- **D11 — only the buyer may create a Deal** (S8). §5.2 lists "authorized buyer" among the creation requirements and gives no seller-initiation path; every creation guard keys off the actor as the conversation's buyer (`requireDealConversation(listing.id, user.id)`). The seller's Deal surface is outcome marking (+ `markSold`) only.
- **D12 — the listing-page CTAs are eligibility-gated with neutral copy** (S8). A legacy `approved` listing whose seller fails the §7.8 check stays searchable (Batch 5's seam) but its "Nhắn người bán"/"Tạo thỏa thuận" CTAs render "Người bán hiện không nhận tin nhắn mới" instead of dead buttons — UI convenience; the actions enforce (§4.5).

## Rollback and Data Backfill

- **Migration** (`batch6_chat_deal`): additive-only (verified via `npx prisma migration show` — zero destructive ops, Q2). Rollback = `git revert` of the Task 1 commit **plus** restore from the pre-migration backup per `docs/backup-restore.md`; no down-migration is authored (the Prisma 8 graph is forward-only). Production applies via the compose `migrate` service `--to production` after the ref advance in Task 1.
- **No backfill.** No legacy deal data exists (Legacy Migration Decisions); §8.6 is satisfied trivially. Post-migration verification = `tests/integration/batch6-migration.test.ts` + `npx prisma db verify`.
- **No data cutover.** `Conversation`/`Message`/`Listing` rows are never mutated by Batch 6 except the atomic `approved → sold` claim inside `markDealOutcomeAction` — **only on the seller's explicit `markSold` choice** (D6; reversible per-deal by an ops `UPDATE` documented in the verification doc; no product flow un-sells).
- **Per-task rollback**: every task is one focused commit; `git revert <task-commit>` restores the previous behavior for all non-migration tasks. The Task 4 commit amends one Batch 5 interface (`product-events.ts` deal-event schemas — additive keys); reverting it reverts the schema extension and the `deal_created` emission together.

## Final Acceptance Commands

```bash
npm run lint
npx tsc --noEmit
npm test
npm run test:integration
npm run build
npm run preflight
npm run smoke
npx prisma migration list          # graph: baseline → batch2 → batch3 → batch4 → batch5 → batch6 (tuyến tính — Q2)
npx prisma db verify               # marker + schema khớp contract
git diff --check && git status --short
```

All green + the gate suites in Task 8 Step 1 + a clean diff/status audit = Batch 6 complete. Per **FD-3**, the recorded ambiguities and decisions above ship as their safe/fail-closed defaults now; beta-launch readiness **additionally** requires the founder-authored items in the **Batch 8 Founder Decision Register** (A1 the mismatch reconciliation rule + `successful_match_rate_v1` dedup/attribution, A2 the buyer-side conversation gating policy from Batch 7, A3 dispute/refund/reputation policy, D6 the `markSold` default, D10 the block-under-outcome reading, the Batch 8 legal review of the §6.4 copy) — those are launch prerequisites, not Batch 6 gate failures, and the verification doc must say so verbatim.
