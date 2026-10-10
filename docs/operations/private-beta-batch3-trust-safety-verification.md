# Private Beta Batch 3 — Trust & Safety Gate Verification (Task 9)

**Date:** 2026-10-07 (Asia/Ho Chi Minh)
**Plan:** `docs/superpowers/plans/2026-10-06-private-beta-batch-3-trust-safety.md` (Task 9 + Acceptance Gate + Final Acceptance Commands)
**Spec:** `docs/superpowers/specs/2026-10-06-private-beta-marketplace-reset-design.md` (§9 Batch 3 + Gate, §10/§10.1)
**Worktree:** `Speaker Platform-worktrees/batch3-implementation` (branch `opencode/batch3-implementation`)
**Founder decisions:** FD-1 (34 provinces — no Batch 3 reference, verified), FD-2 (OTP provider deferred — n/a), FD-3 (fail-closed defaults; founder-authored content = PROVISIONAL placeholders → Batch 8 register)

> ## ✅ OVERALL VERDICT: **GATE PASS**
>
> Every unit gate suite, the integration suite, the backend-enforcement source scan (every hit
> classified), lint, typegen, typecheck, the production build, preflight (7/7), the safe smoke,
> the docker smoke, the migration review (additive-only; the one destructive-looking op is the
> expected `Listing_status_check_*` DROP+ADD pair — additive in effect, BLOCKING-2), `db verify`,
> and the diff/status audit are **green**. No blocker was found. Recorded residuals (all
> pre-existing or deliberate fail-closed defaults) are in §7/§8 with their Batch 8 register
> hand-offs; the dormant-finance findings are **re-enable blockers**, not Batch 3 failures
> (§3.4/§3.5, §8.3).

---

## 1. Commits

Base: `ae5588e` (`docs(plan): add reviewed private-beta batch 3-8 plans` — Batch 0–2 merged).
Task 9 verifies HEAD `f36b1c4` (Task 8). 12 commits = 8 feature commits (Tasks 1–8) + 4
review/fix commits. No push/merge/deploy at any point.

```
$ git log --oneline ae5588e..HEAD
f36b1c4 feat(audit): moderation audit context and filter            (Task 8)
e4d16ea fix(moderation): atomic conditional deletes and recusal on views  (Task 6 review fix)
4a68be9 fix(db): use updateAll/deleteAll for conditional and multi-row writes  (PR-branch fix, merged)
9a7019f feat(trust): appeal foundation                                (Task 7)
7ad208f feat(admin): moderation console                              (Task 6)
052f8e2 fix(trust): tx-bound snapshots and suspension edge cases     (Task 4+5 review fix)
dbb0017 feat(moderation): user suspension and publication gate        (Task 5)
25172cf feat(trust): abuse reports with evidence snapshots            (Task 4)
0074644 fix(chat): only map typed guard errors to 403                (Task 3 review fix)
921b3a0 feat(trust): user blocking with chat enforcement             (Task 3)
08c1991 feat(moderation): trust & safety domain module               (Task 2)
b14cd98 feat(db): add batch 3 trust & safety contract                 (Task 1)
```

Whole-batch diff: 66 files, +37,290/−2,736 (emitted contract artefacts dominate).
**Zero dependency changes** — `git diff ae5588e..HEAD -- package.json package-lock.json` is
empty (Global Constraints: Batch 3 adds no runtime dependency; `npm audit` therefore adds no
new surface beyond the Batch 2 record).

**OpenCode metadata:** model `home-gateway/OneNexus/glm-5.3` (OneNexus GLM 5.3), executed via
OpenCode on macOS per spec §11. Per-task execution sessions are documented in the task
reports (`/tmp/loaviet/batch3-task{1..8}-report.md`, `batch3-task45-fix-report.md`,
`batch3-task6-fix-report.md`, `pr1-update-fix-report.md` — each names its worktree, branch,
base commit, and commit hash); this Task 9 verification ran in the current session on branch
`opencode/batch3-implementation`. (The `opencode` CLI binary is not on this runner's PATH, so
session IDs could not be enumerated programmatically; the reports are the per-task record.)

---

## 2. Gate-suite results (Step 1 — all green)

Run 2026-10-07 in the worktree, Node ≥ 22, vitest 4.1.11. The seven spec §9 Batch 3 gate
items map to named tests as follows (command → result):

| # | Spec §9 gate item | Command | Result |
|---|---|---|---|
| 1 | Block enforcement | `npm test -- tests/unit/block-actions.test.ts tests/unit/chat-guard.test.ts` | **PASS** — 23/23 (directional row, idempotent upsert/unblock, `CANNOT_BLOCK_SELF`, shared 20/min block bucket, zero `Message`/`Conversation` mutation tripwires; `startConversationAction` + direct `POST /api/chat/[id]` deny `CHAT_BLOCKED` both directions, `ACCOUNT_SUSPENDED` for suspended initiator/sender, counterpart/recipient suspension deliberately *not* blocked (A2), 31st send/min → 429 + Retry-After, GET still returns history, DB/infra error inside the guard rethrows — never a fake 403) |
| 2 | Blocked chat prevention | `tests/integration/block-enforcement.test.ts` (via `npm run test:integration`) | **PASS** — 3/3 real-DB (block via the real action prevents new conversation + messages in **both** directions, unblock restores, GET history readable, rows deep-equal before/after; suspension denies per-action **with a live session cookie** (P1: no revocation), lift restores) |
| 3 | Moderation transition tests | `npm test -- tests/unit/moderation.test.ts tests/unit/moderation-actions.test.ts tests/unit/listing-lock.test.ts` | **PASS** — 109/109 (transition table: every legal pair allowed, every illegal denied, `closed` terminal, `actioned → appealed` only via the appeal flow; assign/transition/takedown: `INVALID_TRANSITION`, `CASE_CLOSED`, `CASE_ALREADY_MOVED`, `CASE_ASSIGNMENT_CONFLICT`, `ASSIGNEE_NOT_ELIGIBLE`, `ASSIGNEE_CONFLICT`, `MODERATOR_CONFLICT` (subject/reporter actor), takedown-no-caseId recusal + `CASE_REQUIRED_FOR_TAKEDOWN`; R4: takedown writes `removed` from `approved|hidden|pending`, never `rejected`/`rejectionReason`, `prev:<status>` in the audit detail; R5: seller cannot edit/toggle/delete a removed listing, **every seller/admin write conditional on the status read** (0 rows → `LISTING_MODERATION_LOCKED` / `LISTING_CONCURRENT_CHANGE`), approve/reject pending-only so removed never re-enters review — pinned with a Prisma-8-fidelity mock + a real-DB row-lock race test) |
| 4 | Immutable evidence behavior | `tests/integration/report-evidence.test.ts` + the S12 source-contract case in `tests/unit/audit-append.test.ts` | **PASS** — 6/6 real-DB (edit **and** delete the reported listing → `ModerationEvidence.relevantSnapshot` deep-equals the pre-edit capture, case + report still readable, no cascade; message evidence deep-equal after new messages; two-reporter grouping → one case) + S12 per-statement scan (no statement in `src/`+`app/` mutates `ModerationEvidence`/`ModerationAction`/`AuditEvent`) green in §2 line 7 |
| 5 | Report rate limits | `npm test -- tests/unit/report-actions.test.ts` | **PASS** — 25/25 (6th report in 10 min → `RATE_LIMITED`; case-first dedupe → `REPORT_ALREADY_SUBMITTED`; dedupe does not fire after the case leaves active states; second reporter joins the existing case; different reason → separate case; concurrent same-reporter double-submit → 23505 **throws out of the tx**, classified outside by constraint name → one row + `REPORT_ALREADY_SUBMITTED`; concurrent two-reporter same-target-same-reason → partial-index violation throws out → retry re-read joins the winner's case; retry-failure classification by constraint name (`REPORT_RETRY_FAILED` vs `REPORT_ALREADY_SUBMITTED`); nonexistent/non-participant/own-target → typed errors, zero writes; snapshot null inside tx → rollback, `NOT_FOUND`) |
| 6 | Audit append behavior | `npm test -- tests/unit/moderation-pages.test.ts tests/unit/audit-append.test.ts` | **PASS** — 33/33 (every privileged moderation action appends `AuditEvent` **and** `ModerationAction` with actor/action/reason/session; suspend appends exactly one, a failed second appends none; lift appends one; evidence views append `moderation.evidence_viewed` per render (async server component awaited directly in Vitest); admin notes `redactDetail`-masked in **both** `AuditEvent.detail` and `ModerationAction.note`; append-only across the suite — zero `update*`/`delete*` on the three models; page source contracts: `requireCapability("report.resolve")` before any db read, no `dangerouslySetInnerHTML`, no subject email/phone projection, recusal-on-view ordering, appeal-page XSS/IDOR contracts; `report.submitted`/`appeal.recorded` deliberately **not** `AuditEvent`s — source contract) |
| 7 | Moderator permission tests | `npm test -- tests/unit/suspension-actions.test.ts tests/unit/admin-mfa-login.test.ts` (+ `moderation-actions`/`moderation-pages` above) | **PASS** — 69/69 (moderator ✓ `report.resolve`/`listing.moderate`, ✗ `user.suspend` → FORBIDDEN (A1 fail-closed); support/analyst/non-admin ✗ every moderation surface; suspension requires fresh step-up or a valid TOTP in the same request (`STEP_UP_REQUIRED`/`MFA_CODE_INVALID` fail closed — `user.suspend` ∈ `STEP_UP_CAPABILITIES`, A9); lift does **not** require step-up; `ADMIN_ACCOUNT_USE_ROLE_MANAGEMENT` (A6), `CANNOT_SUSPEND_SELF`, `CANNOT_LIFT_SELF`, `USER_ALREADY_SUSPENDED` (partial-index violation thrown out, classified outside), `SUSPENSION_ALREADY_LIFTED`/`SUSPENSION_NOT_FOUND` atomic claims, case subject-match + `CASE_NOT_ACTIONABLE` + `CASE_ALREADY_MOVED` rollback, `MODERATOR_CONFLICT`, note cap `SUSPENSION_NOTE_TOO_LONG`, **zero `revokeAllUserSessions`** — P1 pinned) |

Supporting gate suites (also run): publication gate + seller verification
(`seller-verification-policy` 31, `publication-gate` 18, `seller-verification-actions` 38 →
87/87 — the **eight** requirements incl. `account_not_suspended`, all four listing surfaces
blocked for a suspended seller, suspended submit refused, all pass when unsuspended) and
appeal foundation (`appeal-actions` 18/18 + `appeal-page` — subject resolved from immutable
`ModerationEvidence.subjectUserId`, non-subject → `NOT_FOUND` (no existence oracle),
`actioned`-only appealable, `ALREADY_APPEALED`, `CASE_ALREADY_MOVED` → no Appeal row persisted,
statement cap).

**Integration suite** (`npm run test:integration`, scratch container `sp-it-pg-52286`,
migrate `--to production`): **13 files / 91 tests PASS** — `batch3-migration` (22),
`block-enforcement` (3), `report-evidence` (6), `suspension-enforcement` (2),
`listing-delete-race` (2), `multi-row-writes` (6), plus Batch 1 `escrow` and all Batch 2
suites green unchanged. Container cleaned by the script trap.

**Full unit suite:** `npm test` → **50 files / 961 tests PASS** (Batch 1 finance shutdown +
Batch 2 identity/security suites green unchanged; `admin-page-guards.test.ts` green — the
recursive net auto-covers the two new moderation pages).

---

## 3. Backend-enforcement source scan (Step 2 — every hit classified)

`rg` (ripgrep 14.x). Expected result stated per the plan; every hit manually classified.

### 3.1 Plan scans

| Scan | Expected | Actual | Classification |
|---|---|---|---|
| `rg -n "requireAdmin\b" src app` | 0 hits | **0 hits** ✅ | Batch 2 deleted the broad check; Batch 3 did not resurrect it. All 13 `app/admin/**/page.tsx` guard via `requireCapability*`/`requireAdminUser` (§3.3). |
| `rg -n "requireCapability" …moderation.ts reports.ts blocks.ts appeals.ts` | first guard of every privileged action | moderation.ts: import + **5 call sites** (122 `requireCapabilityWithStepUp("user.suspend")` suspend, 326 `requireCapability("user.suspend")` lift, 435/537 `requireCapability("report.resolve")` assign/transition, 647 `requireCapability("listing.moderate")` takedown); reports/blocks/appeals: **0 hits** | ✅ Every *privileged* action's first statement is the capability guard. `submitReportAction`/`blockUserAction`/`unblockUserAction`/`recordAppealAction` are **user** actions — their first guard is `requireUser` (reports.ts:92, blocks.ts:28/63, appeals.ts:59), exactly per the plan's own interface blocks; they hold no admin surface. |
| `rg -n "requireCapabilityWithStepUp" src/lib/actions/moderation.ts` | exactly `suspendUserAction` | **1 call site** (line 122) + the import (line 7) | ✅ Spec §5.4.2 "destructive account action" = suspension only (A9); lift/assign/transition/takedown use plain `requireCapability`. |
| `rg -n "revokeAllUserSessions" src/lib/actions/moderation.ts` | 0 hits | **0 hits** ✅ | P1 held: suspension never revokes sessions; the guards read fresh from the DB per action (pinned by `suspension-actions.test.ts` + `block-enforcement.test.ts` with a live session cookie). |
| `rg -n "rejected\|rejectionReason" src/lib/actions/moderation.ts` | 0 hits **in code** | 1 hit — line 626, inside the `takeDownListingAction` **docblock** ("KHÔNG BAO GIỜ viết rejected/rejectionReason — lý do sống trong ModerationAction như TYPED CODE") | ✅ **Comment only** — the R4 rule text itself. Zero code hits: the per-statement source contract in `moderation-actions.test.ts` pins the code path clean (takedown writes `removed`, never `rejected`/`rejectionReason`). |
| `rg -n "MODERATION_LOCKED_LISTING_STATUSES" src/lib/actions/listings.ts` | all three seller guards read the constant (no hardcoded `"removed"`) | **0 raw references**; `isModerationLocked` imported from `@/src/lib/moderation` (line 8) and consumed at **4 call sites** (161 update, 229 toggle, 293 fresh re-read classification, 347 delete) | ✅ The guards consume the helper (which reads the constant — the B2 split the plan's R5 wording prescribes: "every server consumer imports it *from* `moderation.ts`"). `rg -n '"removed"' src/lib/actions/listings.ts` → **0 hits** — no hardcoded status string. The 4th call site (293) is the Task 6 fix's fresh re-read classifier, same helper. |
| `rg -n "dangerouslySetInnerHTML" app/admin/moderation app/appeal src/components/report-dialog.tsx src/components/appeal-form.tsx` | 0 hits | 1 hit — `src/components/report-dialog.tsx:23`, a **comment** ("hiển thị qua React text, không dangerouslySetInnerHTML (spec §7.4 stored XSS)") | ✅ **Comment only** — the rule text, not a sink. Zero code hits in all four surfaces; `moderation-pages.test.ts` + `appeal-page.test.ts` source contracts pin zero `dangerouslySetInnerHTML` and React-text-only rendering of untrusted content (report notes, message bodies, statements, snapshots). |
| `rg -n "Conversation\.create\|Message\.create" src app` | exactly 3 sites | **3 code sites** + 2 comment mentions | ✅ Classified below (§3.2). |
| `rg -n "FINANCIAL_FEATURES_ENABLED" .env.example docker-compose.prod.yml scripts` | still `"false"` everywhere | `.env.example:35`, `docker-compose.prod.yml:80`, `scripts/smoke.sh:12,111,163`, `scripts/docker-smoke.sh:86` — **all `"false"`** ✅ | Batch 1 preserved verbatim; no Batch 3 surface weakens it (all finance suites green in §2). |

### 3.2 The three `Conversation.create`/`Message.create` sites (spec §5.5/§7.8 enforcement perimeter)

| Site | Guard | Verdict |
|---|---|---|
| `src/lib/actions/chat.ts:34` (`startConversationAction`) | `requireUser` → listing load → self-listing check → **`assertCanStartConversation(user.id, listing.sellerId)`** (block either direction → `CHAT_BLOCKED`; suspended **initiator** → `ACCOUNT_SUSPENDED`; counterpart suspension deliberately not checked — A2) — runs **before** the existing-conversation lookup (no redirect into a dead conversation) | ✅ guarded |
| `app/api/chat/[id]/route.ts:102` (`POST`) | participant check → per-user `chat:send` rate limit (30/min → 429) → **`assertCanSendMessage(user.id, recipientId)`** (block either direction / suspended **sender**) → typed 403; non-typed errors **rethrow** (never a fake 403 / message leak — Task 3 review fix `0074644`); `GET` untouched (history stays readable for blocked pairs) | ✅ guarded |
| `src/lib/actions/exchange.ts:70` (`createExchangeOfferAction`) | first statement `assertFinancialFeaturesEnabled()` (line 21) — **denied server-side while finance is disabled**, pinned by `tests/unit/financial-shutdown-actions.test.ts` ("deny trước ExchangeOffer.create/Conversation.create") | ✅ finance-guarded, **dormant** (S2) — unreachable while `FINANCIAL_FEATURES_ENABLED=false`; when finance re-enables, this path must gain the same block/suspension guards (recorded §8 re-enable blocker) |

Comment mentions (not code): `src/lib/moderation.ts:97`, `app/api/chat/[id]/route.ts:80` —
docblocks describing the guard placement. **No fourth creation site exists** — the scan
re-proves the only reachable creation paths are the two guarded ones.

### 3.3 `app/admin/**/page.tsx` + moderation/report/appeal action guards (task-instruction scan)

All 13 admin pages import and call a server-side guard **before any db read**
(`admin-page-guards.test.ts` — the recursive net that enumerates every current and future
admin page — is green):

| Page | Guard |
|---|---|
| `app/admin/page.tsx` | `requireCapability("admin.access")` |
| `app/admin/moderation/page.tsx` (new) | `requireCapability("report.resolve")` |
| `app/admin/moderation/[id]/page.tsx` (new) | `requireCapability("report.resolve")` + recusal-on-view (`isCaseViewerConflicted` → `notFound()` **before** the render reads + before the evidence-view audit) |
| `app/admin/audit/page.tsx` | `requireCapability("audit.read")` (super_admin only — A1) — still the first statement after the Task 8 filter |
| `app/admin/users/page.tsx` | `requireCapability("user.view_basic")` |
| `app/admin/listings/page.tsx` | `requireCapability("listing.moderate")` |
| `app/admin/seller-verification/page.tsx` | `requireCapability("seller.verify")` |
| `app/admin/security/page.tsx` | `requireAdminUser()` |
| `app/admin/catalog/page.tsx`, `orders`, `disputes`, `settings`, `withdraws` | `requireCapability`/`requireAdminUser()` (Batch 2 posture, unchanged) |

Actions: the five moderation actions guard via `requireCapability*` (§3.1);
`submitReportAction`/`blockUserAction`/`unblockUserAction`/`recordAppealAction` guard via
`requireUser` + target-authorization/subject checks (§2 items 5/7). The admin layout nav
entry `Báo cáo & kiểm duyệt` is `report.resolve`-filtered (UI convenience; the pages/actions
are the boundary).

### 3.4 `db.transaction` callback scan (task-instruction scan) — **no catch-and-return, no global `db.` inside any callback** ✅

All **35** `db.transaction(` call sites in `src/` (16 files) were extracted
(comment-stripped, brace-balanced) and audited:

- **Try/catch inside a callback: zero.** No callback contains `try`/`catch`. Every
  constraint violation throws out (Postgres aborts the tx; the wrapper's COMMIT cannot
  silently become ROLLBACK); classification happens **outside** — `isUniqueConstraintViolation`
  / `SqlQueryError` `sqlState === "23505"` + constraint-name prefix (`reports.ts`,
  `suspension-actions`, `appeals.ts`, `verification.ts`, `admin-identity.ts`). The catches that
  exist wrap the `db.transaction` **call** (outside the callback — tx already rolled back)
  and re-throw everything unmapped (`verification.ts:422/585/714`,
  `admin-identity.ts:418/547`, `reports.ts` classify block, `appeals.ts` classify block).
- **Global `db.*` inside a callback: one helper class of hits, both in Batch 1 finance code**
  (see §8.3): `getAutoReleaseDays()` (`src/lib/actions/helpers.ts:53`, global
  `db.orm.public.PlatformSetting`) called inside the `payEscrowAction` (orders.ts:177) and
  `shipOrderAction` (orders.ts:256) tx callbacks — **behind `assertFinancialFeaturesEnabled()`
  (dormant), pre-existing Batch 1 code, deliberately not edited by Batch 3** (the plan forbids
  Batch 3 tasks from touching finance surfaces; the fix needs a shared-helper signature change
  + two call-site edits inside finance mutations). Recorded in the merged Task 4+5 review fix
  (`052f8e2`) as the follow-up for the next finance pass; classified here as a **re-enable
  blocker** (pool-pressure/deadlock class), not a Batch 3 failure.
- **Every other helper called inside a callback is tx-bound or pure** (traced to its module):
  `auditEventTx(tx, …)` (audit-event.ts), `recordStatusChange`/`recordLedgerTx` (take `tx`),
  `revokeAllUserSessionsTx`, `assertNotLastSuperAdminTx`, `resolveNonAdminRoleTx` (take `tx`),
  `captureTargetSnapshot(target, targetId, **tx.orm**)` (reports.ts:156 — the M1 fix; a
  tripwire test pins ≥2 queries on the tx client and **0** on the global client),
  `escrowIn`/`escrowRelease`/`escrowRefund` (pure `Entry[]` builders in `src/lib/ledger.ts`),
  `redactDetail`/`canTransition`/`isModerationLocked` (pure). All direct db access inside
  callbacks is `tx.orm.public.*`.

### 3.5 Single-row `.update(`/`.delete(` terminal scan (task-instruction scan) — full inventory at HEAD

Root cause context (verified in ORM source, `node_modules/@prisma/orm-family-sql/dist/orm-client.mjs`):
`.update()`/`.delete()` select the first matching row then write **`WHERE id = <that id>`** —
the filter is *not* in the write statement (non-atomic select→write window) and only **one**
row is affected. Only `updateAll()`/`deleteAll()` compile the whole filter into one statement.
Therefore a terminal is **OK** only when the filter is exactly a unique key **and** the intent
is single-row; anything else is a defect (or — in finance code — a re-enable blocker).

**Batch 3 moderation/report/appeal/block code: zero single-row terminals remain** — every
conditional or multi-row write uses `updateAll`/`deleteAll` (pinned by
`listing-lock.test.ts` fidelity tests + the real-DB `listing-delete-race.test.ts` +
`multi-row-writes.test.ts`).

**Non-finance code — all remaining terminals are unique-key single-row writes → OK:**

| file:line | filter | intent | verdict |
|---|---|---|---|
| `app/api/chat/[id]/route.ts:46` | `Message { id }` (unique) | mark one message read | OK (INFO: per-row loop could be one `updateAll` — style only) |
| `app/api/chat/[id]/route.ts:111` | `Conversation { id }` (unique) | bump lastMessageAt | OK |
| `app/listings/[slug]/page.tsx:54` | `Listing { id }` (unique) | viewCount increment | OK (INFO: read-modify-write counter can lose an increment under concurrency — cosmetic metric, pre-existing) |
| `scripts/admin-bootstrap.ts:330` | `AdminMfa { id }` (unique) | delete MFA (cascade recovery codes) | OK |
| `src/lib/actions/blocks.ts:75` | `UserBlock { blockerId, blockedId }` — **exactly the composite `@@unique`** | unblock own row (single-row by design) | OK — Batch 3 |
| `src/lib/actions/catalog.ts:17,46` | `ProductModel { id }` (unique) | approve / mark merged | OK |
| `src/lib/actions/listings.ts:315` | `ListingImage { id }` (unique) | reorder image | OK |
| `src/lib/actions/wishlist.ts:20` | `WishlistItem { id }` (unique) | remove wishlist row | OK |
| `src/lib/otp.ts:168` | `OtpCode { id }` (unique) | delete unsent OTP | OK |
| `src/lib/actions/verification.ts:318,420,464,580,709` | `User { id: user.id }` (unique) ×5 | verified flags / password / email / phone | OK |
| `src/prisma/seed-models.ts:122` | `Listing { id }` (unique) | seed backfill link | OK (dev seed) |

Non-ORM matches (crypto `createHash`/`createHmac`/`cipher.update`, cookie store, Map) — N/A:
`admin-mfa-key.ts:82`, `admin-mfa.ts:82,99,143`, `audit-event.ts:84`, `momo.ts:26`, `otp.ts:71`,
`session.ts:74`, `auth.ts:55`, `rate-limit.ts:80`, `recovery.ts:154`.

**Finance code (behind `assertFinancialFeaturesEnabled()` — every file spot-verified gated) —
NOT edited per the plan's finance-preservation constraint; every non-unique-filter or
unconditional-status terminal is a recorded re-enable blocker (§3.5/§8.3), not a Batch 3 failure:**

| file:line | filter | verdict at re-enable |
|---|---|---|
| `src/lib/actions/orders.ts:145` | `CartItem { cartId }` **NON-unique, multi-row intent** | **MUST → `deleteAll`** (clear whole cart) |
| `src/lib/actions/orders.ts:183,226,308,320,364` + `admin.ts:132,149` + `helpers.ts:87` | `Payment { orderId }` **NON-unique** (only `@@index`; `exchangeOfferId` is the `@unique` one) | **MUST → `updateAll`** + multiplicity policy |
| `src/lib/actions/orders.ts:127` + `offers.ts:141,202` + `exchange.ts:189,193` | `Listing { id }` → `status: "sold"` — unique key but **unconditional status write** | **blocker** — a `removed` listing would be flipped to `sold` |
| `src/lib/actions/orders.ts:373` + `admin.ts:144` | `Listing { id }` → `status: "approved"` — **unconditional status write** | **blocker — resurrection** (removed → approved) |
| `orders.ts:252,406`, `admin.ts:126,135,152,172,196,212`, `offers.ts:80,89,101,144,205,226`, `exchange.ts:102,107,140,173,185,217`, `cart.ts:34,55,57,72` | unique-key filters (`@id`/`@unique`/`{key}`) | OK semantics (still finance — re-review at re-enable) |

Required before flipping `FINANCIAL_FEATURES_ENABLED`: convert the six unconditional
`Listing.status` writes to conditional `updateAll` with a takedown-aware precondition + typed
0-row error, fix `orders.ts:145` to `deleteAll`, decide the `Payment { orderId }` multiplicity
policy, and add block/suspension guards to the dormant `exchange.ts:70` conversation path
(§3.2). Full inventory lives in `pr1-update-fix-report.md` §3.4 + `batch3-task6-fix-report.md` §8.

---

## 4. Full preflight + build + smoke (Step 3 — all green)

| # | Command | Result |
|---|---|---|
| 1 | `npm run lint` | **PASS** — 0 errors, 0 warnings |
| 2 | `npx next typegen` | **PASS** — route types generated |
| 3 | `npx tsc --noEmit` | **PASS** — exit 0 |
| 4 | `npm test` (full unit) | **PASS** — **961/961, 50 files** (Batch 1 finance + Batch 2 identity/security + Batch 3 suites all green) |
| 5 | `npm run test:integration` | **PASS** — **91/91, 13 files** (§2; scratch container `sp-it-pg-52286` migrated `--to production`, cleaned by trap) |
| 6 | `npm run build` | **PASS** — exit 0, compiled successfully; `/admin/moderation`, `/admin/moderation/[id]`, `/appeal/[caseId]` emitted as dynamic routes; **1 pre-existing warning only** (`instrumentation.ts:27` `process.exit` in Edge Runtime — Batch 0/1 commit `b8e1c85`; `git log ae5588e..HEAD -- instrumentation.ts` is **empty** — untouched by Batch 3) |
| 7 | `npm run preflight` | **PREFLIGHT PASS — 7/7 gates**: contract-emit-drift, lint, typecheck, unit-tests, production-build (placeholder env), compose-config, migration-graph |
| 8 | `npm run smoke` | **SMOKE PASS** — exit 0: health `200 db=up`; home/login 200; chat 401; momo create/ipn 503 `FINANCIAL_FEATURES_DISABLED`; cron wrong-secret 401 / correct-secret 503 typed; 9 retired finance pages 404; momo return 500 unavailable; scratch container cleaned |
| 9 | `npm run docker:smoke` | **DOCKER SMOKE PASS** — exit 0: isolated compose project `sp-smoke-1791311557`; health 200 + body `db=up`; all finance-shutdown checks green; `prisma_contract.marker` present (migrate service ran); teardown `down -v` |

Nothing was skipped — the full command set ran, including docker:smoke (Docker available on
this runner).

---

## 5. Diff/status audit + migration review (Step 4 — green)

- `git diff --check` → clean. `git status --short` → **empty** (no `.claude/settings.json`,
  no `public/uploads/`, no secrets, no scratch, no `.superpowers/` staged anywhere in the batch).
- `npx prisma migration list` → **linear graph**: `20261003T0448_baseline` (empty →
  `7a6d2852…`, 143 ops) → `20261006T0209_batch2_identity_security` (`… → 0ed42b45…`, 49 ops) →
  `20261006T1420_batch3_trust_safety` (`0ed42b45… → dbd12d36…`, 54 ops, refs `db` + `production`).
  No forks, no gaps — R3 satisfied; Batch 4 plans `--from` the batch3 dir against `dbd12d36…`.
- `npx prisma db verify` (dev DB) → **ok**: "Database marker and schema match contract",
  `mode: full`, contract storageHash == marker storageHash (`dbd12d36…`), profileHash match,
  `"Database schema satisfies contract"`, `unclaimed: []`, `warnings: []`.
- `npx prisma migration show 20261006T1420_batch3_trust_safety` → **53 `additive` + exactly 1
  `destructive`**: the destructive op is `dropCheckConstraint.Listing.Listing_status_check_cc925b6c`
  — the DROP member of the expected **`Listing_status_check_*` DROP+ADD pair** (BLOCKING-2):
  a pg/text enum value lives in a CHECK constraint, so adding `removed` re-renders it; the ADD
  partner (`checkConstraint.Listing.Listing_status_check_505de324`, additive) re-creates the
  CHECK with all six existing values **plus** `removed` — **additive in effect**. Zero
  `column.` ops (Batch 3 adds no column to any existing table — `User` gains relation
  declarations only), zero `alter`, **zero data transforms** (no backfill — §8.6 satisfied
  trivially: dry-run = "0 rows", no `--apply` path exists, rollback = `git revert` + backup
  restore per `docs/backup-restore.md`, verification = `batch3-migration.test.ts` + `db verify`).
- **The two partial unique indexes and the races they close:**
  - `moderation_case_one_active_per_target_reason_7f3ba3cd` — `CREATE UNIQUE INDEX … WHERE
    (state IN ('open','triaged','investigating'))` on `(targetType, targetId, reasonCategory)`:
    closes the concurrent find-or-create double-active-case race (two reporters, same target +
    reason → the loser's create throws 23505 **out of the tx**, classified outside, the
    single retry's re-read finds the winner's case → both reports land on ONE case).
  - `user_suspension_one_active_c770076c` — `WHERE (status = 'active')` on `(userId)`: closes the
    concurrent double-suspend race (exactly one active episode; the loser's create throws out,
    classified outside → `USER_ALREADY_SUSPENDED`), while `lifted` episodes coexist as history.
  - Plus the plain uniques: `AbuseReport_caseId_reporterId_key` (one report/reporter/case —
    same-reporter double-submit), `Appeal_caseId_key` (one-to-one appeal), `UserBlock`
    `(blockerId, blockedId)` (idempotent block).
- FK behaviors per plan: `SetNull` (reporter/subject/reporter-user/actor/appellant/
  assignedModerator/suspendedBy/liftedBy — rows survive future account deletion, A3 interim),
  `Cascade` (`UserBlock` both sides), **`Restrict`** (`UserSuspension.userId` — deleting a
  suspended user is blocked; account deletion must come back through A3).

---

## 6. Transaction constraint-violation rule — no-silent-success results (Global Constraints)

**The rule (pinned by the plan):** a SQLSTATE `23505` violation **aborts the whole
`db.transaction`** (Postgres answers any later statement with ROLLBACK; the Prisma 8 tx
context has no savepoints). Catching it inside the callback and returning normally is a
**silent-success bug** — the wrapper would COMMIT an aborted tx. Therefore: violations always
**throw out of the callback**; classification happens **outside** (`SqlQueryError` +
`sqlState === "23505"` + constraint-name prefix); the report flow **retries the whole
transaction once** where the plan says so; guarded rows are **re-read inside the tx**.

**No-silent-success integration results (real DB, all green):**

| Race | Test | Result |
|---|---|---|
| Concurrent same-reporter double-submit | `report-evidence.test.ts` "hai submit GẦN ĐỒNG THỜI của cùng reporter → đúng MỘT report row, loser `REPORT_ALREADY_SUBMITTED` (không silent-success)" | **one persisted report row** read back after both settle — the loser's `AbuseReport_caseId_reporterId_key` violation threw out, was classified outside, and the aborted tx wrote nothing |
| Concurrent two-reporter grouping | `report-evidence.test.ts` "hai submit GẦN ĐỒNG THỜI hai reporter cùng target+reason → MỘT case, hai report" (+ deterministic unit pin in `report-actions.test.ts` — the mock simulates 23505 with true Postgres semantics: throw-out → rollback snapshot/restore → classify outside → retry joins the winner's case) | **one case, two reports, two evidence rows** — the loser's partial-index violation threw out, the retry's in-tx re-read found the winner's case |
| Concurrent double-suspend | `suspension-enforcement.test.ts` "concurrent double-suspend → ĐÚNG MỘT episode active, loser `USER_ALREADY_SUSPENDED` (không silent-success)" | **exactly one active suspension row** — the loser's `user_suspension_one_active` violation threw out and was classified outside |
| Concurrent lift vs lift / case vs transition | `suspension-actions.test.ts` (`SUSPENSION_ALREADY_LIFTED`), `moderation-actions.test.ts` (`CASE_ALREADY_MOVED` — suspension/takedown rolled back with the case claim), `appeal-actions.test.ts` (`CASE_ALREADY_MOVED` — no Appeal row persists) | all compare-and-set on the **in-tx re-read** value; 0 rows → typed error thrown out → full rollback (pinned by the tx-snapshot/restore mock + real-DB tests) |

---

## 7. Recorded implementation decisions (Scope Decisions — each flagged for founder review)

All from the plan's Scope Decisions, verified in code and tests; **mechanics, not policy** —
each reversible, none invents sanction/retention/appeal policy (FD-3):

1. **Takedown writes `removed` from `approved|hidden|pending`** (R4) — atomic
   `updateAll({ status: "removed" })` with an IN-clause; 0 rows →
   `LISTING_NOT_TAKEDOWN_ELIGIBLE`; **never** `rejected`/`rejectionReason` (the reason lives in
   `ModerationAction` as a typed code). Claiming `hidden` (seller self-hide dodge) and
   `pending` (review-queue exit) too.
2. **Seller-side lock + conditional writes** (R5/SHOULD-FIX 3) —
   `MODERATION_LOCKED_LISTING_STATUSES = ["removed"]` via `isModerationLocked` guards
   `updateListingAction`/`toggleListingVisibilityAction`/`deleteListingAction`;
   **every seller/admin write is conditional on the status read** (`.where({ id, status: <read> })`
   → 0 rows → `LISTING_MODERATION_LOCKED` / `LISTING_CONCURRENT_CHANGE`), including the
   conditional **pending-only** `approveListingAction`/`rejectListingAction` in
   `src/lib/actions/admin.ts` (already conditional from Batch 2 — pinned, not changed:
   Task 6 deviation D1) — a racing takedown can never be clobbered or resurrected. Proven
   against the real DB by `listing-delete-race.test.ts` (takedown tx holds the row lock →
   delete's `deleteAll` re-evaluates the predicate → 0 rows → listing survives `removed`,
   images + cart intact).
3. **`previousStatus` recorded in the takedown `AuditEvent.detail`** (`prev:<status>` —
   `moderation.ts:760`) so A4's future restore path has the prior state.
4. **A linked sanction atomically moves its case to `actioned`** (`resolved_by_sanction`) —
   the appeal link the subject receives points at an actually-`actioned` case (S6);
   `dismissed`/`appealed`/`closed` cases fail closed with `CASE_NOT_ACTIONABLE`.
5. **Report submission is not audited** — the actor is a regular user; `AbuseReport` +
   `ModerationAction("evidence.captured")` already record actor/action/reason/timestamp;
   `AuditEvent` is reserved for privileged actors (spec §4.6). Same for appeals
   (`appeal.recorded` is a `ModerationAction`, not an `AuditEvent`) — pinned by the
   `audit-append.test.ts` source contract (no `auditEvent` call in `reports.ts`/`appeals.ts`).
6. **Block is symmetric for enforcement, directional as data** — any block in either pair
   direction prevents new conversations and new messages in both directions; blocking
   yourself and unblocking someone else's block are refused server-side; blocking never
   deletes/mutates `Conversation`/`Message` (history stays readable via GET).
7. **Suspending an admin account via moderation is refused** (`ADMIN_ACCOUNT_USE_ROLE_MANAGEMENT`)
   — admin lockout is the Batch 2 bootstrap runbook's domain (A6).
8. **Suspended users keep existing published listings** — suspension blocks new
   publication/transitions (§7.8) but does not auto-unpublish; removal is a moderator decision
   through the case takedown action (A2).
9. **No session revocation / no login block** — actor-side guards only (initiator of new chat,
   sender of messages, publication gate); the guards read fresh from the DB per action —
   pinned with a **live session cookie** in integration (P1/A2).
10. **Suspend requires step-up; lift does not** — `user.suspend` ∈ `STEP_UP_CAPABILITIES`
    (spec §5.4.2 "destructive account action" — interpretation **A9**); lift is the restorative
    direction and keeps plain `requireCapability`. Reversible by removing the constant after
    founder review.
11. **Moderator conflict-of-interest fails closed** (`MODERATOR_CONFLICT`) — an admin who is
    the case subject or one of its reporters cannot assign/transition/take down/suspend
    (and now cannot even *view* the case evidence — recusal on views, Task 6 fix; assignee
    subject/reporter → `ASSIGNEE_CONFLICT`). The recusal/override *policy* is A7.
12. **Reporters cannot report their own target** (`CANNOT_REPORT_SELF` — own listing/account/
    sent message) and **reported targets must be visible to the reporter** (non-participant
    message report / nonexistent target → `NOT_FOUND`, no probe oracle, no case created).
13. **Takedown without `caseId` on an actively-cased listing** → `CASE_REQUIRED_FOR_TAKEDOWN`
    (fail-closed: the moderator must go through the case so the atomic `actioned` transition +
    bookkeeping run; cases no longer active keep takedown allowed) — Task 6 review fix, recorded.
14. **`actioned → appealed` is only reachable via the appeal flow** (the manual transition
    table closes it) — the subject's CAS writes `appealed`; moderators cannot hand-set it.

**Provisional vocabularies (A8 — launch blocker per FD-3):** `SUSPENSION_REASON_CODES`,
`MODERATION_DECISION_REASON_CODES`, `MODERATION_ASSIGNMENT_REASON_CODES` + every Vietnamese
label map (`REPORT_REASON_LABELS`, `MODERATION_CASE_STATE_LABELS`, `MODERATION_PRIORITY_LABELS`,
`SUSPENSION_REASON_LABELS`, `MODERATION_DECISION_REASON_LABELS`,
`MODERATION_ASSIGNMENT_REASON_LABELS`, `MODERATION_ACTION_TYPE_LABELS`,
`LISTING_STATUS_LABELS.removed`/`LISTING_STATUS_BADGE.removed` (R8)) carry visible
`PROVISIONAL (A8)` markers (`moderation-vocab.ts` ×6, `constants.ts` ×4) — founder-authored
content replaces them before beta.

**Batch 5 telemetry forward seam (recorded, not wired):** Batch 3 calls no `emitProductEvent`
(it does not exist yet) and writes no PII to any analytics path. The agreed future call sites:
`report_submitted` → `submitReportAction`'s success return (seam documented in the file header,
`reports.ts:57-61`), `listing_removed` → `takeDownListingAction`'s success point (after the
tx, around the notify — recorded here and in the plan's Global Constraints; the inline comment
in `moderation.ts` is absent, a minor doc note — Batch 5 adds the emit call without
restructuring either action).

---

## 8. Residual risks, ambiguities & Batch 8 Founder Decision Register hand-off

Collected from **all** Batch 3 task reports (`/tmp/loaviet/batch3-task{1..8}-report.md`,
`batch3-task45-fix-report.md`, `batch3-task6-fix-report.md`) and the PR-branch fix report
(`pr1-update-fix-report.md`, commit `4a68be9` merged into this branch).

### 8.1 Batch 8 Founder Decision Register (from this batch — the plan's hand-off, verbatim scope)

| # | Item | Batch 3 posture (fail-closed default shipped) |
|---|---|---|
| A1 | Scoped/Exceptional/Limited RBAC cells (moderator/support `user.suspend`, `user.view_basic`, `session.revoke`, `audit.read`; moderator analytics; `pii.view_sensitive`; `pii.export`) | Only `super_admin`/`operations_admin` suspend; moderators work cases (`report.resolve`/`listing.moderate` ✓ cells) but cannot suspend, cannot read the audit log, cannot open `/admin/users`; console renders no subject email/phone. **Practical gap:** a moderator who confirms abuse must hand off to an operations_admin for the suspension — manual (case assignment + notification) until A1 resolves. |
| A2 | Sanction policy (which sanction for which violation, durations, escalation) **and** the suspension enforcement perimeter: session revocation, login blocking, counterpart-side chat blocking | Manual mechanisms only: suspend/lift with typed reasons, indefinite until explicitly lifted, no auto-expiry, no automated sanctioning; **no session revocation, no login block** (revocation without a login block is pointless; a login block is sanction policy); counterpart/recipient-side suspension chat blocking **not implemented** (not in §7.8's stated set — pinned as intentionally absent). |
| A3 | Evidence retention & deletion policy (incl. the account-deletion interaction) | Evidence never deleted/updated by any product flow; FK interim: `SetNull` on evidence/report/appeal/actor FKs (rows survive account deletion), **`Restrict`** on `UserSuspension.userId` (deleting a suspended user is blocked). Any retention/purge/deletion feature must come back through A3. |
| A4 | Appeal decision workflow (who rules, outcomes, timelines, re-appeal) **and listing restore** (the only un-remove path) | Foundation only: record + `appealed` state + close bookkeeping (`appealed → closed` closes the `Appeal` row) + subject-facing submission page + admin read-only section. **Gap:** a plain transition to `actioned` **without a linked sanction sends no notification** — only sanction-linked cases notify the subject with the `/appeal/<caseId>` link — so a subject whose case was actioned without a sanction never learns they can appeal; closing that gap is part of A4's founder-authored workflow. |
| A5 | Case priority SLA/escalation semantics | `low|normal|high` exist as data (default `normal`, settable during transition); no SLA/escalation automation. |
| A6 | Suspending admin accounts via moderation | Refused with a typed error — admin lockout is the Batch 2 bootstrap runbook's domain. Reversible by founder ruling. |
| A7 | Moderator recusal/override policy | The deny is the fail-closed default (`MODERATOR_CONFLICT` on assign/transition/takedown/suspend + recusal on views + `ASSIGNEE_CONFLICT`); when recusal is required, whether a supervisor may override, and how conflicts are recorded — pending. |
| A8 | The sanction-taxonomy reason vocabularies | **Launch blocker per FD-3** (founder-authored content): the three PROVISIONAL vocabularies + all label maps carry visible markers until founder-acknowledged; renaming is an additive constant change. |
| A9 | The "destructive account action" step-up interpretation | Suspension in (`user.suspend` ∈ `STEP_UP_CAPABILITIES`), lift out. Same posture as Batch 2's A5 strictest reading. Reversible by removing the constant. |
| FD-3 placeholders | Suspend/takedown notification wording, appeal-page copy, block/banner/report-dialog copy, reason labels, report success message | All ship as clearly-marked placeholders (`PLACEHOLDER (FD-3)` / `PROVISIONAL (A8/FD-3)`); founder-authored wording replaces them before beta. |

### 8.2 Accepted residual risks (documented, no action in Batch 3)

| # | Residual risk | Status |
|---|---|---|
| R1 | **In-memory rate limiter single-instance topology** (`rate-limit.ts`) — restart resets buckets; no cross-instance protection. Affects `report` (5/10 min), `chat:send` (30/min), `block` (20/min), `chat:poll`. | Accepted (repo topology = one container; documented in `rate-limit.ts`, carried from Batch 2). Batch 8 register: revisit at multi-instance scale-out. |
| R2 | **Per-render guard reads** — `getBlockState` (2 reads) + `isUserSuspended` (1 read) per chat-page render and per POST; fresh-from-DB by design (P1: no revocation — the guard *is* the enforcement). | Accepted at beta scale; revisit if chat polling load grows. |
| R3 | **Retry-once semantics in `submitReportAction`** — if the retry also violates the partial index (requires the winner's case to close AND a new active case on the same key between two reads), the action fails closed with `REPORT_RETRY_FAILED`; the reporter can resubmit. | Accepted (fail-closed direction). |
| R4 | **`CASE_ALREADY_MOVED` surfaces as a thrown server-action error** on the appeal path (per plan step 8 — propagate) — the subject hits Next's error boundary in the rare concurrent-transition race; the data invariant (no Appeal persisted) holds. Friendlier copy is founder-authored content (FD-3/A4). | Accepted; Batch 8 register (copy). |
| R5 | **No rate limit on `recordAppealAction`** — per plan (§7.1 lists report, not appeal); the one-appeal-per-case `@unique` + statement cap are the controls. | Accepted. |
| R6 | **Appeal-page discovery** — reachable only via the sanction notification link; no nav entry (intentional — subject-scoped). A subject who loses the link has no in-app path back until A4 ships. | Recorded under A4. |
| R7 | **`other_blocked` is visible to the blocked party** (banner "Người này đã chặn bạn") — deliberate direction-aware UX; reveals only the pair's block state; the blocked party cannot unblock it. | Accepted. |
| R8 | **Re-block after unblock creates a new row** (new `createdAt`) — idempotency applies only while the block exists; the profile label reflects the latest episode. | Cosmetic; accepted. |
| R9 | **Race-window image mutation (pre-existing pattern, narrowed)** — `updateListingAction`'s image diff + `PriceHistory` reprice now run in the **same tx as the CAS listing claim** (Task 6 fix item 7), so a losing edit can no longer mutate a removed listing's images; the pre-tx read of images remains non-atomic with the claim (the claim is the gate). | Accepted (evidence snapshots immutable regardless). |
| R10 | **Queue page limit 100 rows, no pagination** — matches the existing admin pages' pattern. | Accepted; Batch 4+ console polish. |
| R11 | **`SUSPENSION_REASON_LABELS` duplication** remains in `app/admin/users/page.tsx` (Task 5's local map; Task 6 owns `constants.ts`) — cosmetic dedup for a later pass. | Accepted. |
| R12 | **S12 scan is heuristic** — strips comments, splits on `;`; a mutation via the raw SQL builder or across an unscanned boundary would not be caught (none exists today; integration suites pin actual behavior). | Accepted (defense-in-depth, not sole control). |
| R13 | **Audit filter `<a>` navigation** (vs `<Link>` on the moderation queue) — cosmetic inconsistency between admin pages. | Accepted. |
| R14 | **`ACTION_PREFIXES` is a closed static list** — a future audit namespace (Batch 5/6 events) requires adding one line; fail-closed by design. | Accepted; known touch-point. |
| R15 | **Per-message `Báo cáo` affordance renders on every received message** — visual density on long conversations is a UX polish item. | Accepted; founder UX review. |
| R16 | **Pre-existing build warning** — `instrumentation.ts:27` `process.exit` in Edge Runtime (Batch 0/1 commit `b8e1c85`, untouched by Batch 3 — `git log ae5588e..HEAD -- instrumentation.ts` empty). | Recorded (carried from Batch 2 R19). |
| R17 | **`viewCount` read-modify-write race** (`app/listings/[slug]/page.tsx:54`) + per-row mark-read loop (`app/api/chat/[id]/route.ts:46`) — unique-key filters, cosmetic metrics/style only. | Recorded (PR1 fix INFO observations, intentionally unchanged). |

### 8.3 Finance re-enable blockers (dormant code — NOT Batch 3 failures)

All behind `assertFinancialFeaturesEnabled()` (spot-verified in `cart.ts`, `orders.ts`,
`offers.ts`, `exchange.ts`, `admin.ts`, `helpers.ts`); **required before flipping
`FINANCIAL_FEATURES_ENABLED`** (full inventory in §3.5 + the source reports):

1. Convert the **six unconditional `Listing.status` writes** to conditional `updateAll` with a
   takedown-aware precondition + typed 0-row error — `orders.ts:127,373`, `offers.ts:141,202`,
   `exchange.ts:189,193`, `admin.ts:144` (the last two are **resurrection** paths:
   removed → approved/sold).
2. `orders.ts:145` `CartItem { cartId }` `.delete()` → **`deleteAll`** (clear whole cart).
3. `Payment { orderId }` non-unique terminals (`orders.ts:183,226,308,320,364`,
   `admin.ts:132,149`, `helpers.ts:87`) → **`updateAll`** + a one-payment-per-order multiplicity
   policy decision.
4. `getAutoReleaseDays()` global-db-inside-tx (orders.ts:177/256) — the pool-deadlock class
   fixed for `captureTargetSnapshot` in Batch 3 (M1) but **not editable in finance code**;
   pass the tx through in the next finance pass.
5. The dormant `exchange.ts:70` `Conversation.create` path must gain the same
   block/suspension guards as the two live chat paths (§3.2).

---

## 9. Batch 1 / Batch 2 preservation (Acceptance Gate)

- **Batch 1 preserved:** all finance shutdown suites
  (`financial-shutdown-actions`, `financial-shutdown-routes`, `finance-public-surface`,
  `admin-finance-readonly`, `financial-features`, `mock-payment-guard`, `cron-auth`,
  `cron-auto-release-route`, `ipn-route`, `momo`, `ledger`, `escrow` integration) green
  unchanged; `FINANCIAL_FEATURES_ENABLED` still `"false"` everywhere (§3.1); the migration is
  additive-only (§5); takedown writes the new `removed` status and touches no finance model
  (`Order`/`Payment`/`Payout`/`Wallet`/`LedgerEntry`/`Dispute` untouched by any moderation path).
- **Batch 2 preserved:** RBAC matrix, session/OTP/MFA/audit suites green; exactly two Batch 2
  *interfaces* amended in the open with their tests **extended, not weakened**: the publication
  gate (7 → 8 requirements — `account_not_suspended`, spec §7.8) and `STEP_UP_CAPABILITIES`
  (gains `user.suspend`, spec §5.4.2 — A9). No capability, role, or matrix cell changes.
  `src/lib/rbac.ts` carries exactly the one Batch 3 extension; `src/lib/audit-event.ts`,
  `src/lib/session.ts`, `src/lib/otp.ts` are untouched by Batch 3
  (`git log ae5588e..HEAD -- src/lib/audit-event.ts src/lib/session.ts src/lib/otp.ts` empty).
  The `admin.ts` approve/reject conditional-write hardening (R5) changed no interface and
  keeps every existing admin-action test green (the conditional pending-only writes were
  already Batch 2's — pinned by `listing-lock.test.ts`, Task 6 deviation D1).
- **Browser E2E** — explicitly deferred (no E2E infrastructure in the repo; same posture as
  Batch 2): Batch 3's critical flows are covered by action-level unit tests + real-DB
  integration tests (§2). CSRF posture: Next.js 16 server actions are POST-only with built-in
  origin protection; no custom token layer added (repo posture, spec §10.1 row).

---

## 10. Verdict

| Acceptance-gate bullet (spec §9 Batch 3 Gate) | Status |
|---|---|
| Block enforcement (`block-actions` + `block-enforcement`) | ✅ 23 unit + 3 integration |
| Blocked chat prevention (`chat-guard`) | ✅ 13 unit (incl. direct route invocation) + integration |
| Moderation transition tests (`moderation` + `moderation-actions` + `listing-lock`) | ✅ 109 unit + real-DB race test |
| Immutable evidence behavior (`report-evidence` + S12 source contract) | ✅ 6 integration + S12 |
| Report rate limits (`report-actions`) | ✅ 25 unit + integration concurrency pins |
| Audit append behavior (`audit-append`) | ✅ 15 unit (append-only, redaction, evidence-view auditing) |
| Moderator permission tests (`moderation-actions` + `suspension-actions` + `moderation-pages` + `admin-mfa-login`) | ✅ A1 fail-closed matrix + step-up (A9) proven |
| Batch 1 preserved | ✅ all finance suites green; `FINANCIAL_FEATURES_ENABLED=false`; additive-only migration |
| Batch 2 preserved | ✅ two interfaces amended with tests extended, not weakened; no matrix change |
| Preflight (7 gates), integration suite, safe smoke, docker smoke, diff/status audit | ✅ §4/§5 — nothing skipped |

**GATE PASS.** Every acceptance bullet is green; every source-scan hit is classified (§3);
the migration is additive-only with the one expected `Listing_status_check_*` DROP+ADD pair
(BLOCKING-2); the transaction rule's no-silent-success behavior is proven against the real
DB (§6). Recorded residuals and the A1–A9 + FD-3 placeholder hand-offs go to the **Batch 8
Founder Decision Register** (§8); the finance re-enable blockers (§8.3) are dormant-code
records, not Batch 3 failures. **Batch 3 is accepted.**
