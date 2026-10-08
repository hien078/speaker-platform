# Private Beta Batch 6 — Chat Hardening + Deal Outcome Gate Verification (Task 8)

**Date:** 2026-10-08
**Plan:** `docs/superpowers/plans/2026-10-06-private-beta-batch-6-chat-deal.md` (Task 8 + Acceptance Gate + Final Acceptance Commands)
**Corrections (mandatory, applied):** `docs/superpowers/plans/2026-10-08-private-beta-batch-6-plan-corrections.md` (v2 — every item applied; the merge-time items 5/18 are recorded in §12)
**Spec:** `docs/superpowers/specs/2026-10-06-private-beta-marketplace-reset-design.md` — §9 Batch 6 + Gate, §10/§10.1, §11/§11.1
**Worktree:** `Speaker Platform-worktrees/batch6-implementation` (branch `opencode/batch6-implementation`)

> ## ✅ OVERALL VERDICT: **GATE PASS**
>
> Every spec §9 Batch 6 gate item, every plan source scan, the full preflight
> (7/7), the integration suite, safe smoke, the migration review, and the
> diff/status audit are green on the final state (`391c9a6` + this doc). The
> three 2-skeptic review leftovers are closed **in this task** (§6). Per FD-3,
> the recorded ambiguities and decisions ship as their safe/fail-closed
> defaults now; **beta-launch readiness additionally requires the
> founder-authored items in the Batch 8 Founder Decision Register** (§12) —
> A1 the mismatch reconciliation rule + `successful_match_rate_v1`
> dedup/attribution, A2 the buyer-side conversation gating policy from Batch 7,
> A3 dispute/refund/reputation policy, D6 the `markSold` default, D10 the
> block-under-outcome reading, the Batch 8 legal review of the §6.4 copy —
> **those are launch prerequisites, not Batch 6 gate failures** (plan Final
> Acceptance Commands, verbatim).

---

## 1. Commits and executor metadata

**Base:** `e0406b1` — `docs(plan): batch 6 corrections from re-review against real code`
(the merged Batch 5 head in this tree; the Batch 5 gate commit itself is `367e6c9`
`test(batch5): verify search & telemetry gate`). Batch 6 executed on the merged
Batch 5 commit per Q1 — verified at Task 1 Step 0 (both refs == `1350a596…`, the
`to` of `20261007T2208_batch5_search_telemetry`, corrections item 1).

**Final state verified:** `391c9a6` + this doc's commit (Task 8).

```
$ git log --oneline 367e6c9..HEAD   (at gate verification; + this doc commit after)

391c9a6 test(migration): generous timeout for prisma path-walk subprocess (b6-review flake)
a1b64ea fix(deal): keep deal form inputs across action errors
9e53aeb merge: Batch 6 Task 7
fd0bebd merge: Batch 6 Task 6b
ff4527f test(deal): prove finance isolation of deal surfaces
f8ebe28 feat(deal): deal panel, outcome forms and secondary chat CTA
22a87a6 merge: Batch 6 Task 5
206d88b feat(deal): bilateral deal outcome with successful-match analytics
a8f6109 fix(chat): non-object JSON body returns 400 INVALID_BODY
31cd55b merge: Batch 6 Task 6a
b1cc0f5 merge: Batch 6 Task 4
f630f72 merge: Batch 6 Task 3
f06b10f feat(deal): lightweight deal creation
14bf895 feat(chat): harden conversation and message entry points
3c31cf4 feat(deal): external-payment safety guidance component
bfeb60f merge: Batch 6 Task 2
8fb3264 merge: Batch 6 Task 1
a0fc6ad feat(db): add batch 6 deal contract
38e4b3e feat(deal): trust domain module for chat and deal guards
e0406b1 docs(plan): batch 6 corrections from re-review against real code
```

Task feature commits (plan's exact messages): `a0fc6ad` (T1), `38e4b3e` (T2),
`14bf895` (T3), `f06b10f` (T4), `3c31cf4` (T6a), `206d88b` (T5), `f8ebe28`
(T6b), `ff4527f` (T7) — plus `e0406b1` (the corrections doc), `a8f6109`
(Task 3 review fix), the two Task 8 review-leftover fixes `a1b64ea` + `391c9a6`
(§6), and 6 merge commits from the parallel-worktree integration (the
corrections parallelism map: T1 ∥ T2 wave 1; T3 ∥ T4 ∥ T6a wave 2; T5 wave 3;
T6b wave 4; T7 → T8).

**OpenCode metadata:** model `home-gateway/OneNexus/glm-5.3` (OneNexus GLM 5.3),
session in this worktree — "Batch 6 Task 8: gate verification + verification
doc". Per-task reports (separate sessions on the parallel branches, all merged
here): `/tmp/loaviet/batch6-task{1,2,3,4,5,6a,6b,7}-report.md` +
`/tmp/loaviet/batch6-plan-report.md`. No push / merge to main / deploy /
subagents at any point; every `git add` listed explicit paths (bracketed paths
quoted); nothing staged from `.superpowers/`, `.claude/`, `public/uploads/`,
secrets, or scratch. `package.json` + `package-lock.json` untouched across the
whole batch (Batch 6 adds zero npm packages).

---

## 2. Gate-suite results (Step 1 — all green, run 2026-10-08 on `391c9a6`)

The spec §9 Batch 6 gate items mapped to the plan's named suites:

| # | Gate item (spec §9 Batch 6) | Suite | Result |
|---|---|---|---|
| 1 | **Buyer/seller ownership** (GET/POST `/api/chat/[id]` 401/404/403/200 matrix; page `notFound()`; Deal IDOR → same `DEAL_FORBIDDEN` for missing + non-participant, zero writes) | `tests/unit/chat-hardening.test.ts` + `tests/unit/deal-create.test.ts` + `tests/unit/deal-outcome.test.ts` | **PASS 32 + 50 + 27** |
| 2 | **Blocked-user behavior** (Batch 3 suites green, fixtures migrated, one pin superseded by D2; Deal paths call the same guards; `no_deal`/`cancelled` recordable under a block — D10) | `tests/unit/chat-guard.test.ts` + `tests/unit/block-actions.test.ts` + `tests/unit/deal-create.test.ts` + `tests/unit/deal-outcome.test.ts` + `tests/integration/block-enforcement.test.ts` | **PASS 17 + 10 + 50 + 27 + integration** |
| 3 | **Suspended-user behavior** (suspended initiator blocked, kept from Batch 3; suspended/revoked/inactive-membership **listing seller** cannot receive NEW conversations — D2; suspended buyer/seller cannot Deal-create/mark) | `tests/unit/chat-hardening.test.ts` + `tests/integration/chat-hardening.test.ts` + `tests/unit/deal-create.test.ts` + `tests/unit/deal-outcome.test.ts` + `tests/integration/suspension-enforcement.test.ts` | **PASS 32 + integration** |
| 4 | **Deal concurrency** (double-create → one open Deal via the partial unique index; both-success race → one `completed`, one `completedAt`, one `successful_match`; completion-vs-cancellation never completes) | `tests/unit/deal-outcome.test.ts` + `tests/integration/deal-lifecycle.test.ts` (real-DB `Promise.all`) | **PASS 27 + integration** |
| 5 | **Deal idempotency** (same-value re-mark = no-op success, no new history row/event/notification; different value → `DEAL_ALREADY_MARKED`; existing open → `DEAL_ALREADY_OPEN`) | `tests/unit/deal-outcome.test.ts` + `tests/unit/deal-create.test.ts` | **PASS 27 + 50** |
| 6 | **Deal authorization** (every §5.2 creation requirement server-side: live approved listing, authorized buyer, own-listing refusal, existing conversation, seller eligibility §7.8, block, suspension; outcome marking checks participation + actor state) | `tests/unit/deal-create.test.ts` + `tests/unit/deal-outcome.test.ts` | **PASS 50 + 27** |
| 7 | **Successful-match analytics** (`successful_match` only on bilateral confirmation, never on mismatch, never twice, never from inside the tx; `listing_marked_sold` only on the seller's explicit `markSold` + won claim; the three Batch 5 chat events survive the hardening) | `tests/unit/deal-outcome.test.ts` + `tests/unit/chat-hardening.test.ts` + `tests/integration/deal-lifecycle.test.ts` + `tests/unit/telemetry-wiring.test.ts` | **PASS 27 + 32 + integration + 50** |
| 8 | **No Deal action creates Payment / Payout / Wallet / Ledger / Escrow** (source scan + raw-SQL forbid + import graph incl. re-exports + dynamic imports; finance tables unchanged; finance row counts identical across the lifecycle) | `tests/unit/deal-finance-isolation.test.ts` + `tests/integration/batch6-migration.test.ts` + `tests/integration/deal-lifecycle.test.ts` + the Task 8 `rg` scans (§3) | **PASS 13 + integration + scans clean** |
| 9 | **External-payment safety disclaimer** (§6.4 six points + §5.2 line near chat/deal flows, zero affirmative guarantee language) | `tests/unit/deal-ui.test.ts` | **PASS 39/39** |
| 10 | **Batch 1 preserved** (finance shutdown + escrow integration green unchanged; `FINANCIAL_FEATURES_ENABLED=false`; additive-only migration) | `tests/unit/financial-shutdown-*.test.ts` + `tests/unit/finance-public-surface.test.ts` + `tests/unit/admin-finance-readonly.test.ts` + `tests/unit/mock-payment-guard.test.ts` + `tests/integration/escrow.test.ts` | **PASS (in the full runs below)** |
| 11 | **Batch 2–5 preserved** (every earlier suite green; fixtures migrated, one pin superseded — §5; the one Batch 5 file edited — `product-events.ts` — extended additively, its suite extended not weakened) | full `npm test` + full `npm run test:integration` | **PASS (below)** |

Full-suite context (every earlier batch stays green unchanged — Q1/S1):

| Command | Result |
|---|---|
| `npm test` (full unit) | **PASS — 93 files / 2014 tests** (Batch 1 finance shutdown, Batch 2 identity/security — `admin-page-guards.test.ts` green, no new admin surface — Batch 3 trust/safety, Batch 4 listing quality, Batch 5 search/telemetry/metrics, all Batch 6 suites) |
| `npm run test:integration` (`scripts/test-integration.sh`, scratch container, `db migrate --to production`) | **PASS — 29 files / 247 tests** (incl. `batch6-migration` 15, `chat-hardening`, `deal-lifecycle` 10, `escrow`, `block-enforcement`/`suspension-enforcement` migrated, `batch5-migration` with the appended batch6 pin; migration applied 8 migrations / 299 ops, invariant `backfill-listing-approved-content-at` satisfied, head `292dd3fb…`) |
| `npm run lint` | **PASS** — 0 errors, 0 warnings |
| `npx next typegen` + `npx tsc --noEmit` | **PASS** — clean |
| `npm run build` | **PASS** — exit 0, `✓ Compiled successfully`, 15/15 static pages, TypeScript clean; **1 pre-existing warning only** (`instrumentation.ts:27` `process.exit` Edge Runtime — Batch 2 commit, Batch 5 R13, untouched by Batch 6) |
| `npm run preflight` | **PASS — 7/7 gates** (contract-emit-drift, lint, typecheck, unit-tests, production-build, compose-config, migration-graph) |
| `npm run smoke` | **SMOKE PASS** — production standalone server on scratch DB: health `200 db=up`, `/api/chat` unauthenticated 401, every finance entry point typed-denied (`FINANCIAL_FEATURES_DISABLED`), 9 retired finance pages 404, cron wrong-secret 401 / correct-secret 503 typed, momo return 500 unavailable, uploads headers + traversal/traversal-format 404s |
| `npm audit --omit=dev` | **1 pre-existing high** — `next@16.3.7` advisories (fix = `next@16.4.0`, outside the pinned range). Batch 6 adds **zero** npm packages and `package.json` is unchanged across the whole batch — inherited dependency hygiene, **Batch 8 register item** (same posture as Batch 5 R12) |
| `npx prisma migration list` | **Linear graph, 8 migrations**: `baseline → batch2 → batch3 → batch4_listing_quality → batch4_holistic_review_fixes → batch4_round4_approved_content_backfill (self-edge, provides the backfill invariant) → batch5_search_telemetry → batch6_chat_deal`; batch6 head carries refs `[db, production]`; exactly one edge out of `1350a596…` (corrections item 1's expected shape — the plan's "no node with two outgoing edges" is amended by the accepted `66d2193a…` self-edge + batch5 edge, Batch 5 verification §2) |
| `npx prisma db verify` (dev DB, container `speaker-postgres` :5435) | **ok: true, mode: full** — marker + schema match contract `292dd3fb…` |
| `npx prisma contract emit` → `git status src/prisma/` | **0 drift** (storageHash `292dd3fb…` unchanged — preflight gate 1) |
| `git diff --check` + `git status --short` | clean; only the Task 8 files (§6) — no `.claude/settings.json`, no `public/uploads/`, no secrets, no scratch, `package-lock.json` untouched |

---

## 3. Backend-enforcement + copy source scans (Step 2 — every hit classified)

`rg` (ripgrep) at the repo root, run 2026-10-08 on `391c9a6`. Ten scans, each
with its expected result (plan Task 8 Step 2):

| # | Scan | Expected | Actual — classified |
|---|---|---|---|
| S1 | `assertCanStartConversation\|assertCanSendMessage\|getBlockState\|isUserSuspended` in `deals.ts`/`chat.ts`/`deal.ts` | reuse/delegation of the Batch 3 guards (Q5/S10) | **18 hits, all reuse** — `chat.ts:6,31` (import + call before create); `deals.ts:9,145` (import + call in `createDealAction`), `:42,78,79` (doc comments); `deal.ts:4,62,143` (imports + **delegated calls** in `assertListingSellerInteractable`/`assertDealOutcomeAllowed`), `:19-21,49,129,131,135` (doc comments naming the delegation). Zero re-implementation — the guards are imported from `@/src/lib/moderation` and called; pinned by the delegation spies in `deal-domain.test.ts`/`deal-create.test.ts` |
| S2 | `MODERATION_LOCKED_LISTING_STATUSES` in `src/lib/actions/listings.ts` | **0 hits** (corrections #19 — the R5 guard is `isModerationLocked` from `moderation-vocab.ts`; absence pinned at `listing-lock.test.ts:1026` + `publication-gate.test.ts:1433`) | **0 hits** ✅ |
| S3 | finance models/helpers (`\bOrder\b`…`\bExchangeOffer\b`, `recordLedgerTx`, `\bescrow\b`) in `deals.ts`/`deal.ts`/`deal-vocab.ts` | **0 hits** (Q7 — word boundaries so `orderBy`/`sortOrder`/`border`/`offers` cannot false-positive) | **0 hits** ✅ |
| S4 | raw SQL (`db\.raw\|db\.sql\|tx\.sql\|tx\.execute\|executeRaw\|queryRaw`) in `deals.ts`/`deal.ts`/`deal-vocab.ts` | **0 hits** (S5 — deal surfaces are not allowed raw SQL at all) | **0 hits** ✅ |
| S5 | `ProductEvent` in `orders.ts`/`escrow.ts`/`wallet.ts`/`ledger.ts`/`momo.ts`/`mock-payment.ts` | **0 hits** (B5 scan re-run — no finance module emits) | **0 hits** ✅ |
| S6 | `FINANCIAL_FEATURES_ENABLED` in `.env.example`/`docker-compose.prod.yml`/`scripts` | still `false` everywhere | **7 hits, all `false`/comments**: `.env.example:46` `"false"`, `docker-compose.prod.yml:123` `"false"`, `scripts/smoke.sh:116` `export …="false"` (+ `:12,:223` comments), `scripts/docker-smoke.sh:90` comment. Batch 1 preserved ✅ |
| S7 | promise language (`đảm bảo\|bảo đảm\|bảo hiểm\|bảo vệ thanh toán\|giữ tiền hộ\|\bescrow\b`) in `safety-guidance.tsx`/`deal-panel.tsx` | only the exact negation line | **1 hit**: `safety-guidance.tsx:30` `const NEUTRAL_LINE = "LoaViet không giữ tiền và không bảo đảm giao dịch."` — the single allowlisted neutral negation (copy-safety allowlist + `deal-ui.test.ts` §4.2 contract, which scans comments too). `deal-panel.tsx`: 0. ✅ |
| S8 | `dangerouslySetInnerHTML` in `deal-panel.tsx`/`deal-create-form.tsx`/`deal-outcome-form.tsx`/`safety-guidance.tsx` | **0 hits** (stored-XSS contract — `cancellationReason` renders as React text) | **0 hits** ✅ |
| S9 | `emitProductEvent` in `deals.ts` | the deal emissions — AFTER the transaction commit (S1), after guards | **7 hits**: import `:25`; `deal_created` `:229` (after the tx at `:171`); `deal_outcome_marked` `:531`, `successful_match` `:546`, `listing_marked_sold` `:558` (all after the tx at `:418`, driven by the returned `{noop, completedClaimed, soldClaimed}` flags); `:59,338` doc comments. No emission inside any `db.transaction` callback; no try/catch around the emits (fail-open core). ✅ |
| S10 | `AuditEvent\|auditEvent` in `deals.ts` | **0 hits** (Q6/D7 — `DealStatusHistory` is the user-action record; `AuditEvent` stays privileged-actor domain) | **0 hits** ✅ |

No hit violates an invariant; nothing was fixed as a result of the scans (the
surfaces were written scan-clean — the Task 7 proof test additionally pins all
of S3/S4/S8/S10 plus the import graph, rerunnable as
`npm test -- tests/unit/deal-finance-isolation.test.ts`).

---

## 4. Migration review (Step 4 — additive-only, Q2/Q3)

`npx prisma migration show "migrations/app/20261008T0237_batch6_chat_deal"`:

- **19 operations, ALL `additive`** (2 `createTable` `Deal`/`DealStatusHistory`,
  12 `createIndex`, 5 `addForeignKey`): **zero destructive, zero data
  transforms, zero `placeholder(...)`** (grep on the rendered `migration.ts` =
  0), **zero `Listing_status_check_*` ops** — Batch 6 adds no `listing_status`
  value (Q2's "halt on any destructive op" never fired; the `sold` value is
  claimed only by the explicit, seller-chosen `approved → sold` CAS inside
  `markDealOutcomeAction`, never by the migration).
- **`Deal` FK decisions (Legacy Migration Decisions):** `listingId` nullable +
  `SetNull` (D9 — listing deletion is a live seller surface; the deal survives
  listing-less, reachable via `conversationId`); `buyerId`/`sellerId` required +
  `Restrict` (A7 — a user with deals has no P0 deletion path; retention must
  come back through the ambiguity); `DealStatusHistory.dealId` `Cascade`
  (history goes away with its deal — **no `src/` statement ever mutates
  `DealStatusHistory`**, the append-only scan in `deal-domain.test.ts` §8 /
  corrections #24); `DealStatusHistory.actorId` nullable + `SetNull` (D9 —
  history rows survive a future account deletion; participant checks fail
  closed on null).
- **`Deal.conversationId` nullable, NO FK** (D9/S11 — the Batch 5
  `ProductEvent.conversationId` precedent): recorded at creation from
  `requireDealConversation`, indexed for the panel lookup
  (`Deal_conversationId_idx`), keeps deals reachable after listing deletion.
- **Partial unique index `deal_one_open_per_listing_buyer_77dfd57d` on
  (`listingId`,`buyerId`) WHERE ((status = 'open'))** (D4): closes the
  concurrent double-create race at the DB level — a buyer may create a new deal
  after the previous one reached a terminal status (terminal rows coexist);
  the 23505 is classified **outside** the transaction via
  `SqlQueryError.is(e) && sqlState === "23505" && constraint prefix` →
  `DEAL_ALREADY_OPEN` (corrections #11 — the violation always throws out of
  the callback; Postgres aborts the tx, catch-and-return would be a
  silent-ROLLBACK bug).
- **Graph shape (corrections #1/#2):** 8 dirs — `baseline → batch2 → batch3 →
  20261006T1902_batch4_listing_quality → 20261007T1708_batch4_holistic_review_fixes
  → 20261007T2007_batch4_round4_approved_content_backfill (self-edge, provides
  the backfill invariant) → 20261007T2208_batch5_search_telemetry →
  20261008T0237_batch6_chat_deal`; the plan output's `from:` was
  `1350a596…` (the Batch 5 `to` both refs held); Batch 6 adds exactly one edge
  out of `1350a596…`.
- **Refs advanced in the Task 1 commit, invariant restored by hand**
  (corrections #2): `migration ref set production` rewrites
  `refs/production.json` with `invariants: []` and has no flag to keep them —
  `"invariants": ["backfill-listing-approved-content-at"]` was hand-restored in
  the same commit (Batch 5 verification R11; pinned by
  `tests/unit/approved-content-backfill-migration.test.ts:108-121` and the L2
  path-walk test `:123` — the `@empty → production` walk covers all 8 dirs and
  fails if the ref ever loses the invariant). `refs/db.json` stays `[]`.
- **No backfill** (§8.6 trivially satisfied — no legacy deal data exists);
  rollback = `git revert` of the Task 1 commit + restore per
  `docs/backup-restore.md`; no down-migration (forward-only graph). Production
  applies via the compose `migrate` service `--to production` after the ref
  advance (same rule as every batch's Task 1).
- **`npx prisma db verify`** (dev DB): ok — marker = schema = contract
  `292dd3fb…`.

---

## 5. B1 supersession + earlier-batch test edits (no assertion weakened)

**The one superseded pin (B1/D2):** `tests/unit/chat-guard.test.ts` — Batch 3's
A2 case "startConversationAction with a suspended COUNTERPART (seller) still
creates the Conversation" now asserts **`SELLER_SUSPENDED`, no `Conversation`**,
per spec §9 Batch 6 "suspended/revoked seller checks" — the authority that
resolves Batch 3 A2 **for NEW chat only**. The POST case "recipient suspended →
still delivers" is UNCHANGED (D2 does not reach messages in existing
conversations; A10 perimeter intact there). Recorded as the single permitted
supersession; no other assertion was weakened anywhere in the batch.

**Earlier-batch test files edited by Batch 6 (each exactly once, in its owning
task's commit; every edit additive — a fixture gains the Batch 4 verified-seller
+ approved-listing shape, or a graph pin gains the new dir):**

| File (owning batch) | Batch 6 edit (task) | Nature |
|---|---|---|
| `tests/unit/approved-content-backfill-migration.test.ts` (B4/B5) | `@empty → production` path list appended with `20261008T0237_batch6_chat_deal` (8 dirs); end==production-hash untouched (T1, corrections #3) | pin update — append only |
| `tests/integration/batch5-migration.test.ts` (B5) | `applied == [round4, batch5, batch6]`; `:910` end==production-hash untouched (T1, corrections #3) | pin update — append only |
| `tests/unit/chat-guard.test.ts` (B3) | `SellerVerification`/`BetaCohortMembership` stores+models+seed; the one superseded pin; header contract (T3, corrections #8) | fixture migration + the B1 supersession |
| `tests/unit/telemetry-wiring.test.ts` (B5) | `seedPolicyRows(SELLER.id)` in the `startConversationAction` describe `beforeEach` only (T3, corrections #8) | fixture migration |
| `tests/integration/block-enforcement.test.ts` (B3) | `seedSellerEligibility()` ×3 sellers; `afterEach` deletes `SellerVerification` before `User` (Restrict FK) (T3, corrections #8) | fixture migration |
| `tests/integration/suspension-enforcement.test.ts` (B3) | `seedSevenRequirements(sellerY)` for the listing owner (T3, corrections #8) | fixture migration |
| `tests/unit/sell-pages.test.ts` (B4) | db mock extended with `UserSuspension`/`SellerVerification`/`BetaCohortMembership`/`Conversation` + `seedEligibleSeller`; new describe "4c. D12 CTA gating" (7 behavior tests) (T6b, corrections #16/#31) | fixture migration + additive describe |
| `tests/unit/product-events.test.ts` (B5) | +8 deal-schema cases (the denylist/banned-regex/taxonomy structural cases automatically cover the new keys) (T4, corrections #10) | extend only |
| `tests/unit/approved-content-backfill-migration.test.ts` (again, Task 8) | generous per-test timeout on the prisma CLI path-walk subprocess test (§6 leftover 3) | test-infra robustness — no pin changed |

**Statement (corrections #32):** no assertion was weakened in any of these
edits — every earlier-batch suite re-ran green in the full `npm test` (93 files
/ 2014) and full `npm run test:integration` (29 files / 247) above.

---

## 6. Task reviews + fixes closed in this task (2-skeptic verification)

Every Batch 6 task (incl. 6a/6b) was implemented in its own worktree and
independently reviewed (2-skeptic adversarial verification) before merging
here; the per-task reports are in `/tmp/loaviet/batch6-task*-report.md`. The
review fixes that landed **inside** the batch: `a8f6109`
(`fix(chat): non-object JSON body returns 400 INVALID_BODY` — Task 3 review;
`body.imageUrl: null` / `body.body: null` are not strings and previously
crashed the route instead of the typed 400).

The **three review leftovers** the gate required fixing first (TDD, before this
doc) — closed in this task:

1. **[CONFIRMED LOW] `src/components/deal-outcome-form.tsx` — React 19
   automatic form reset** (`a1b64ea`): React 19 calls `requestFormReset` on
   EVERY form action that does not throw — including one returning `{error}` —
   so the `action={formAction}` prop made `form.reset()` clear the controlled
   radio + `markSold` + `cancellationReason` in the DOM while `useState` kept
   the old outcome → a retry posted no outcome (`DEAL_OUTCOME_INVALID`) or
   silently lost `markSold`. **Fix:** the Batch 4 `PortableListingForm`
   pattern — no `action` prop, dispatch via `onSubmit` + `preventDefault()` +
   `startTransition(() => { void formAction(fd) })` (no `requestFormReset`;
   `useActionState`'s `pending` still tracks correctly inside the transition).
   **Test first (red confirmed):** `tests/unit/deal-ui.test.ts` §4b — the new
   source-contract cases failed 3× against the old source, green after the fix
   (the repo has no jsdom/E2E infra — recorded since Batch 2 — so the contract
   is source-level, exactly the `portable-listing-form.test.ts:159-179`
   precedent).
2. **[SPLIT LOW] `src/components/deal-create-form.tsx` (full variant)** — same
   reset wiped `agreedPrice`/`fulfillmentMethod` on error; same fix + test
   (`a1b64ea`, same §4b describe).
3. **Flaky `tests/unit/approved-content-backfill-migration.test.ts:123`**
   (`391c9a6`): the test spawns `npx prisma db migrate --show` (the authentic
   CLI path walk, ~3s idle) and failed once under full-suite parallel load —
   vitest's default 5s per-test timeout was exceeded while many workers ran.
   **Fix:** a generous per-test `{ timeout: 120_000 }` — no pin changed, the
   subprocess kept (an in-process replacement would need
   `@prisma/orm-toolchain` internal chunks not in the package's public exports
   map — `executeMigrateShowPlan`/`buildReadAggregate` — plus a hand-rolled
   aggregate loader, which would weaken the pin rather than strengthen it).

Verification after the fixes: focused `deal-ui` 39/39 + the migration test
green, full `npm test` **93 files / 2014 green**, lint/typegen/tsc clean,
integration 29/247 green, preflight 7/7, smoke pass (§2 table).

---

## 7. Telemetry emission map (Q6/S1 — every emission AFTER the transaction)

All seven events emit via Batch 5's `emitProductEvent` (raw `sessionId`/`actorId`
in, HMAC-pseudonymized by the core; fail-open; never wrapped in try/catch) —
**never from inside a `db.transaction` callback**: the Deal actions' emissions
run after `await db.transaction(...)` resolves, driven by the flags the tx
returns (`{ noop, completedClaimed, soldClaimed }`), so a rollback can never
leave a phantom event (S1 — pinned by the rollback test in
`deal-outcome.test.ts`).

| Event | Call site | Payload (columns + metadata) | After commit |
|---|---|---|---|
| `deal_created` | `createDealAction` (`deals.ts:229`) | `actorId` = buyer, `sessionId` raw, `conversationId`, `listingId`, `provinceCode` (coarse), metadata `{ dealId: uuid, fulfillmentMethod: enum\|null }` — **no `agreedPrice`** (§4.8) | ✅ after the create tx |
| `deal_outcome_marked` | `markDealOutcomeAction` (`deals.ts:531`) | metadata `{ dealId, outcome: enum, role: "buyer"\|"seller" }` — **no `cancellationReason` free text** (the reason lives only in `Deal.cancellationReason`; history note is the typed `<role>:<outcome>`, corrections #23) | ✅ (skipped on the idempotent no-op) |
| `successful_match` | `markDealOutcomeAction` (`deals.ts:546`) | `actorId` = **buyer** (D13 — the metrics fixture shape; `sessionId` only when the caller IS the buyer, else null), metadata `{ dealId }` | ✅ only when `completedClaimed` (bilateral claim won) |
| `listing_marked_sold` | `markDealOutcomeAction` (`deals.ts:558`) | metadata `{ dealId }` | ✅ only when `soldClaimed` (the seller explicitly ticked `markSold` AND the `approved → sold` CAS won — D6) |
| `conversation_started` | `startConversationAction` (`chat.ts:83` → `recordConversationStarted`) | Batch 5 shape, unchanged | ✅ after all guards + the successful create, before `redirect()` (pin `telemetry-wiring.test.ts`) |
| `conversation_buyer_first_message` | `POST /api/chat/[id]` (`route.ts:192`) | Batch 5 shape + `responseMs`-style position-based detection, unchanged | ✅ after `Message.create` |
| `message_first_response` | `POST /api/chat/[id]` (`route.ts:206`) | Batch 5 shape, unchanged | ✅ after `Message.create` |

Schema note (corrections #10): the four deal-event schemas in
`src/lib/product-events.ts` were extended **additively** from Batch 5's
`z.strictObject({})` minimal form to the typed keys above — no existing schema
weakened, no event name added (the 20-event taxonomy is pinned), no key matches
`METADATA_KEY_DENYLIST` or the banned regex
`/query|text|body|message|note|email|phone|address|name/i`. The unit tests
assert the **`ProductEvent` row exists** with that metadata (not just a spy —
a spy-only test passes while the real emit is schema-rejected).

Notifications (Q6/§4.8): `deal_created` → seller, `deal_outcome_marked` →
counterparty — typed Vietnamese titles + typed labels + a `/chat/<id>` link
only; no contact details, no message bodies, no prices; best-effort
(`captureError("deal", "DEAL_NOTIFY_FAILED", { sqlState })` with a **string
code**, corrections #22 — a committed deal is never turned into a 500 by a
notify failure). The existing chat-message notify keeps its sender-name +
80-char preview to the recipient (a participant — D8, unchanged).

---

## 8. §6.4/§5.2 copy as shipped (flagged for Batch 8 legal review — A9)

`src/components/safety-guidance.tsx` renders, near the chat/deal flows (mounted
once on `app/chat/[id]/page.tsx` after `DealPanel`):

- the six §6.4 points (byte-identical with the plan Task 6 strings = copy-safety
  `SAFETY_64_POINTS` on `local/b8-early-integration`): thanh toán/giao nhận
  độc lập ngoài LoaViet; kiểm tra tình trạng trước khi thanh toán; ưu tiên gặp
  gỡ nơi công cộng; không bao giờ chia sẻ OTP/mật khẩu; cẩn trọng link thanh
  toán đáng ngờ; dùng báo cáo/chặn khi gặp vấn đề;
- the §5.2 line (`SAFETY_52_LINE`): "Thanh toán và giao nhận hàng diễn ra độc
  lập ngoài LoaViet.";
- the Batch 1 neutral negation (`NEUTRAL_LINE`): "LoaViet không giữ tiền và
  không bảo đảm giao dịch."

Zero affirmative guarantee/escrow/insurance language anywhere in the new
surfaces (S7 scan + `deal-ui.test.ts` §4.2, which scans comments too — stricter
than copy-safety's whole-line-comment stripping on purpose). The deal panel
adds the price note "(do hai bên tự nhập — LoaViet không thu tiền này)". All of
it is a faithful product translation, **not legal text — Batch 8 reviews the
final Terms/Privacy/Safety Guidance** (A9; blocking for beta invites, not for
this gate). The deal status/outcome labels, D12 neutral CTA copy
("Người bán hiện không nhận tin nhắn mới"), form error texts, and notify labels
are PROVISIONAL product copy in the same register (FD-3).

---

## 9. Recorded decisions D1–D13 (reversible readings — flagged per FD-3)

Each shipped as the safe/fail-closed default; **D6 and D10 are named Batch 8
Founder Decision Register items** (§12):

- **D1** — new conversations require `listing.status === "approved"`
  (`CONVERSATION_STARTABLE_LISTING_STATUSES`; the existing inline check +
  `LISTING_NOT_AVAILABLE` code kept per corrections #7 — same semantics, the
  already-pinned error name; `sold` listings refuse NEW conversations, old
  ones reopen).
- **D2** — the §7.8 seller-side perimeter (suspension → verification → active
  `founding_seller` membership, expiry-aware per corrections #6) covers **NEW
  chat + Deal creation only**; messages in existing conversations and outcome
  marking of existing deals are NOT gated on the counterpart (A10); this
  supersedes Batch 3's pinned counterpart-suspension case for NEW chat (§5).
- **D3** — per-party outcomes `success | no_deal | cancelled`, immutable once
  marked (same-value re-mark = no-op via the exact `<role>:<outcome>` history
  prefix; different value → `DEAL_ALREADY_MARKED`); `no_deal`/`cancelled`
  transition unilaterally, `success` contributes to bilateral completion.
- **D4** — one OPEN deal per `(listing, buyer)` (the partial unique index); a
  new deal may follow a terminal one.
- **D5** — `agreedPrice` bound = the repo's real price bound
  `100_000 … 2_000_000_000` (`PRICE_MIN/PRICE_MAX` in `listing-schema.ts`,
  drift-pinned); empty → null.
- **D6** — the only beta `approved → sold` transition is the seller's explicit
  `markSold` choice on their own success marking (checkbox, default off);
  bilateral completion alone never sells. **Batch 8 register item.**
- **D7** — `DealStatusHistory` is the user-action record; Deal/chat actions
  write no `AuditEvent`.
- **D8** — the existing chat-message notification keeps its sender-name +
  80-char preview to the recipient (a participant); Batch 6's new notifications
  are typed-label-only.
- **D9** — `Deal.listingId` nullable + `SetNull`; `Deal.conversationId`
  nullable, no FK; `DealStatusHistory.actorId` nullable + `SetNull`;
  `Deal.buyer/seller` `Restrict` (§4).
- **D10** — outcome marking under a block: non-success markings allowed,
  `success` + Deal creation denied (suspension still blocks every marking).
  **Batch 8 register item.**
- **D11** — only the buyer may create a Deal (every creation guard keys off
  the actor as the conversation's buyer; the seller's surface is outcome
  marking + `markSold` only).
- **D12** — the listing-page CTAs are eligibility-gated with neutral copy
  ("Người bán hiện không nhận tin nhắn mới") when the seller fails §7.8 — UI
  convenience; the actions enforce (§4.5). Anonymous visitors keep "Nhắn người
  bán" (corrections #16); the compact `Tạo thỏa thuận` form renders only for a
  logged-in non-owner with an existing conversation (corrections #31).
- **D13** (Task 5, adopted from corrections #26) — `successful_match` emits
  with `actorId = deal.buyerId` (the metrics fixture shape) and `sessionId`
  only when the emitting caller is the buyer; once-per-deal comes from the
  atomic claim, not the payload.

---

## 10. Residual risks (recorded — accepted at P0, revisited post-beta)

| # | Residual risk | Status / mitigation |
|---|---|---|
| R1 | **In-memory rate limiter topology** (`CONVERSATION_START_RATE` 20/10 min/user, `DEAL_MUTATION_RATE` 20/h/user via the existing `checkRateLimit`): single instance, restart resets, no cross-instance protection — same caveat as every existing limit (Batch 2 R4 / Batch 5 R1 posture) | Accepted (repo topology = one instance); recorded in the module headers; §7.1 values are PROVISIONAL (Batch 8 register) |
| R2 | **Mismatched bilateral outcomes have no resolution path until A1** — one `success` + one `no_deal`/`cancelled` leaves both markings in `DealStatusHistory`, the deal in the non-success status, no `successful_match`, nothing auto-resolves; the only correction path is the (unshipped) ops reconciliation rule | Fail-closed by design (A1 — Batch 8 register); pinned by unit + integration mismatch cases |
| R3 | **Buyer-side conversation gating absent until Batch 7/A2** — any authenticated, non-blocked, non-suspended user may start conversations; the cohort check is one guard away once Batch 7 lands the policy | Recorded (A2); Batch 7 owns it |
| R4 | **A10 — a revoked/unverified seller can still reply inside an existing conversation** (D2 gates NEW interactions only); whether existing-conversation replies should also be blocked is sanction-adjacent policy §4.11 forbids inventing | Recorded for founder ruling alongside Batch 3 A2 |
| R5 | **A seller who forgets to tick `markSold` at marking time has no later self-serve sold path** (outcomes are immutable, D3; no standalone mark-sold action — A6) | Recorded (D6/A6 — Batch 8 register) |
| R6 | **`scripts/cleanup-uploads.ts` treats only `ListingImage.url` as attached** (corrections #29) — an upload referenced only by `Message.imageUrl` would be deleted by `--apply`; `ChatWindow` never sends `imageUrl` today, and the POST route now validates ownership, so no live path creates such a row | Recorded residual — no code change (Batch 8 register) |
| R7 | **Browser E2E for the chat→deal→outcome loop remains deferred** — the repo has no E2E infrastructure (recorded since Batch 2); the critical flows are covered by action-level unit tests + real-DB integration tests (incl. the concurrency races) | Tracked pre-invite prerequisite (spec §10/§12) |
| R8 | **`npm audit --omit=dev` 1 pre-existing high** (`next@16.3.7`; fix `next@16.4.0` outside the pinned range) + the pre-existing `instrumentation.ts:27` build warning — both inherited, zero Batch 6 dependency changes | Batch 8 register (Batch 5 R12/R13) |
| R9 | **Static-analysis limits of the Task 7 proof** — the import walker follows literal-string imports (static/dynamic/side-effect/re-export); a finance module reached via a computed specifier would evade it (none exists); the raw-SQL forbid + token scan narrow the gap | Inherent to a source-scan proof; recorded in `deal-finance-isolation.test.ts` |
| R10 | **UI is convenience only** (§4.5) — a blocked pair still sees the DealCreateForm on the chat page (the panel has no block-state prop); submission returns the typed `CHAT_BLOCKED` error text; the actions enforce | Accepted; pinned by the action tests |

**Dropped residual (corrections #17):** the plan's Task 8 residual
"pre-existing wishlist rows on now-non-approved listings remain visible" is
**dropped** — `toggleWishlistAction` was already hardened by b4-holistic-2
(approved-only add, removal in any status; pinned by
`wishlist-actions.test.ts:246-310`) and `/wishlist` redacts non-public rows to a
placeholder (`wishlist-page.test.ts:263-372`). No wishlist edit shipped in
Batch 6.

---

## 11. Deferred items + forward seams

- **Batch 7 (cohort ops):** the buyer beta access policy (A2) gates new
  conversations; `seller_invited`/`seller_registered` emissions land with the
  invitation/console flows.
- **Batch 8:** the legal review of the §6.4/§5.2 copy (A9), the Founder
  Decision Register items (§12), the ops-alerts classification + copy-safety
  re-run (merge actions), the `next` version bump decision (R8).
- **Deal retention/cleanup (A7):** rows are append-only with no cleanup;
  `Deal.buyer/seller` are `Restrict` so a future account-deletion batch must
  return through the ambiguity.
- **`successful_match_rate_v1`** stays PENDING (A2/A1) — the raw
  `successfulMatchCount` becomes live with Batch 6's emissions (honest counts,
  no invented denominators); `listingMarkedSoldCount` likewise.
- **No admin/ops Deal surface ships** (none in §9 Batch 6) — any future one
  goes through `requireCapability` + `tests/unit/admin-page-guards.test.ts`
  enumeration (Batch 2 posture).

---

## 12. Batch 8 Founder Decision Register — items carried from Batch 6

Per FD-3: execution proceeded on fail-closed defaults; these are **launch
blockers** (needing founder-authored content or decisions), never invented:

| Item | What ships today | Needs |
|---|---|---|
| **A1** mismatched-outcome **reconciliation rule** (+ `successful_match_rate_v1` dedup/attribution) | Both markings recorded, deal stays in the non-success status, no `successful_match`, no resolution UI/action (R2) | Founder-authored ops rule; then the rate can un-pend |
| **A2** buyer-side conversation gating | Not gated (R3) — one guard away | Batch 7 policy + founder decision |
| **A3** dispute/refund/reputation on Deal | Nothing (§4.11/§15 — out of scope by policy) | Founder policy (post-beta §13.4 reviews gated on "Deal outcome integrity") |
| **D6** `markSold` default-off | The seller's explicit per-deal checkbox is the only beta `approved → sold` path (R5) | Founder ruling on the default / a later self-serve path |
| **D10** block-under-outcome reading | `no_deal`/`cancelled` recordable under a block; `success` + creation denied | Founder ruling (§5.5 "where appropriate") |
| **A9** §6.4/§5.2 legal copy | The faithful translation in §8 | Batch 8 legal review (blocking for invites) |
| **A10** revoked-seller existing-conversation replies | Not blocked (D2 perimeter; R4) | Founder ruling alongside Batch 3 A2 |
| **§7.1 rate values** | `CONVERSATION_START_RATE` 20/10 min/user, `DEAL_MUTATION_RATE` 20/h/user (PROVISIONAL, R1) | Founder may adjust additively pre-beta |
| **D13** `successful_match` actor/attribution | `actorId` = buyer, `sessionId` only for the buyer caller (§7) | Founder visibility with A1 |
| **Product copy** — deal status/outcome labels, D12 neutral CTA copy, form error texts, notify labels, success messages | PROVISIONAL mechanics-only Vietnamese (§8) | Batch 8 copy review (A9 register) |
| **FD-2** production OTP email/SMS provider (carried from Batch 2) | Fail-closed production adapter | Founder provider selection — beta-launch prerequisite |
| **FD-R27/RR-23** (corrections #27) | The plan's "reversible per-deal by an ops `UPDATE`" rollback wording bypasses §4.6 audit — **not documented as a procedure anywhere**; `sold` is irreversible in the product flow (D6) | Batch 8 register: any ops correction path must go through §4.6 audit + `AuditEvent` |
| **R8** dependency hygiene | `next@16.3.7` audit high + `instrumentation.ts` warning, both pre-existing | Batch 8 ops decision (version bump) |

**Merge-time actions for the early Batch 8 merge (branch
`local/b8-early-integration` — the files are NOT in this tree; recorded here +
in every task report per corrections #5/#18):**

1. **ops-alerts classification (BLOCKING at merge):** add **`Deal`** (lightweight
   deal outcome — user-entered record, non-finance) and **`DealStatusHistory`**
   (append-only deal history) to `NON_FINANCE_TABLES` in `scripts/ops-alerts.ts`
   (that branch's `:128-160`), the drift-test classification
   (`tests/unit/ops-alerts.test.ts:546-569` — every contract model must be
   classified), and the `docs/operations/monitoring-signals.md` doc rows + the
   "27 bảng còn lại" count — **together with Batch 5's `ProductEvent` +
   `SearchAlias`** (Batch 5 verification line 563) if not yet done. They must
   never be treated as finance surfaces by ops alerting.
2. **copy-safety re-run:** `tests/unit/copy-safety.test.ts` auto-activates its
   component check on `src/components/safety-guidance.tsx` and walks every
   `app/**.tsx` + `src/components/**.tsx` + `src/content/**.ts` with
   `PROMISE_PATTERNS` — the Batch 6 files were written to pass it (§8; the
   strings are byte-identical with `SAFETY_64_POINTS`/`SAFETY_52_LINE`), but
   the scan must be re-run after the merge (corrections #18);
   `src/content/policies/safety-guidance.ts` stays Batch 8's.

---

## 13. Verdict

| Acceptance-gate bullet (plan §Acceptance Gate / spec §9 Batch 6) | Status |
|---|---|
| Buyer/seller ownership (chat matrix + Deal IDOR `DEAL_FORBIDDEN`, zero writes) | ✅ §2 #1 |
| Blocked-user behavior (Batch 3 suites green, fixtures migrated, one pin superseded by D2; guards reused — Q5 delegation spies; D10 non-success recordable under block) | ✅ §2 #2 + §5 |
| Suspended-user behavior (actor-side kept; seller-side D2 fresh from DB; suspended buyer/seller cannot Deal) | ✅ §2 #3 |
| Deal concurrency (partial unique index; atomic claims; races pinned on real Postgres) | ✅ §2 #4 + §4 |
| Deal idempotency (same-value no-op; different-value `DEAL_ALREADY_MARKED`; `DEAL_ALREADY_OPEN`) | ✅ §2 #5 |
| Deal authorization (every §5.2 requirement server-side) | ✅ §2 #6 |
| Successful-match analytics (bilateral only, never twice, never inside the tx; `markSold` explicit only; Batch 5 chat events survive) | ✅ §2 #7 + §7 |
| No Deal action creates Payment/Payout/Wallet/Ledger/Escrow (source scan + raw-SQL forbid + import graph + migration + lifecycle row counts + rg scans) | ✅ §2 #8 + §3 |
| External-payment safety disclaimer (§6.4 six points + §5.2 line, zero promise language) | ✅ §2 #9 + §8 |
| Batch 1 preserved (shutdown suites + escrow green; `FINANCIAL_FEATURES_ENABLED=false`; additive-only migration) | ✅ §2 #10 + §3 S6 + §4 |
| Batch 2–5 preserved (every earlier suite green; fixtures migrated, one pin superseded; `product-events.ts` extended additively) | ✅ §2 #11 + §5 |
| Preflight (lint, typecheck, unit, build, compose, migration graph), integration suite, safe smoke, clean diff/status audit | ✅ §2 table |
| Review leftovers closed before the gate (forms ×2 + flaky test) | ✅ §6 |

**GATE PASS.** Batch 6 is complete on `391c9a6` + this doc; the Batch 8 merge
actions (§12) and the founder-authored launch blockers (§12) are recorded, not
pending implementation here.
