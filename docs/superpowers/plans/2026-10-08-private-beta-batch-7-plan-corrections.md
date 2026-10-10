# Batch 7 plan corrections v2 (re-verified against `beta/batch6-chat-deal` @ `da31a5b`, 2026-10-08)

> **MANDATORY — overrides the plan text** (`docs/superpowers/plans/2026-10-06-private-beta-batch-7-cohort-operations.md`).
> Supersedes `.superpowers/plan-corrections/b7-corrections.md` (v1, written against an older tree that did not include Batches 5–6). Every file:line below was read on branch `beta/batch6-chat-deal` with `git show beta/batch6-chat-deal:<path>`, unless the item says another branch.
> Early Batch 8 work (`scripts/ops-alerts.ts`, `tests/unit/copy-safety.test.ts`, `docs/operations/monitoring-signals.md`) is **NOT in this tree**. It is on `local/b8-early-integration` and merges later. Items 6 and 33 say what to do when it lands.

## Global rules (apply to every task; they override the plan)

- **This document overrides the plan.** Where they conflict, follow this document. A PROVISIONAL item ships with its fail-closed default and goes into the Batch 8 Founder Decision Register. Do not block on it.
- **Staging:** never run `git add .` or `git add -A`. Add the paths listed for the task. Quote bracketed paths (`'app/invite/[token]/route.ts'`).
- **Never stage** `.superpowers/`, `.claude/` (the whole directory, not just `settings.json`), `public/uploads/`, `data/uploads/`, secrets, or scratch files.
- **`package-lock.json`:** never commit it unless dependencies actually change. Batch 7 adds no dependency. If one is ever unavoidable, regenerate the lockfile with **npm 10** and commit it in the same commit as `package.json`.
- **`FINANCIAL_FEATURES_ENABLED` stays `false`.** No Batch 7 file may import a finance module.
- **No new model touches finance tables.** `FoundingSellerCandidate` and `BetaInviteToken` must have no relation to `Order`, `Payment`, `Payout`, `WithdrawRequest`, `LedgerEntry`, `Dispute`, `Cart`, `CartItem`, `Offer`, `ExchangeOffer` or wallet tables. The Task 1 ops test (item 4) pins this.
- **Prisma 8 write rules** (`tests/integration/multi-row-writes.test.ts:1-30`): single-row `.update()`/`.delete()` selects the first match and then writes `WHERE id=`, so they are not compare-and-set. Every conditional or claim write uses `updateAll`/`deleteAll`. `updateAll` returns the **row array**, so check `.length === 0` (`src/lib/actions/beta-cohort.ts:87-90`).
  - NULL matching uses `.where((t) => t.col.isNull())`, never `{ col: null }`. Time bounds use `.gt(nowIso)` (`src/lib/otp.ts:248-251`).
  - Inside `db.transaction`, use only `tx.orm.public.*`. Throw typed sentinels out of the callback. Classify `SqlQueryError` **outside** the tx with `SqlQueryError.is(e) && e.sqlState === "23505" && e.constraint?.startsWith(<prefix>)`, and rethrow everything else (`src/lib/actions/deals.ts:190-200`).
- **Production ref invariant:** `npx prisma migration ref set production` rewrites `refs/production.json` with `invariants: []`. Restore `"invariants": ["backfill-listing-approved-content-at"]` by hand in the same commit (item 2).
- **Next 16.3.8 / React 19 conventions in this repo:**
  - `"use server"` files export only async functions. Types are fine.
  - Never call `redirect()` inside a `catch`.
  - `searchParams` and `params` are Promises: `(await searchParams) as {...}`.
  - Use the global `PageProps<"/route">`, `LayoutProps`, and `RouteContext<"/route/[x]">` helpers (`app/uploads/[key]/route.ts:60-64`).
  - Use `useActionState` from `react`.
  - Cookies can be **set only in a Server Function or a Route Handler**, never during a Server Component render (`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/cookies.md:74,81`).

## BLOCKING

1. **Task 1 Step 0/3, migration base.**
   - *Plan says:* placeholder `B6_DIR="migrations/app/<ts>_batch6_chat_deal"`; graph `baseline → batch2 → … → batch6`; "no node with two outgoing edges".
   - *Real:* `refs/db.json` and `refs/production.json` both hold `292dd3fbd5f0e8543fea2e3e04297f170f53408ac8b348c7c7f3cd4868741277`, the `to` of `migrations/app/20261008T0237_batch6_chat_deal/migration.json` (from `1350a596…`). On-disk graph has 8 dirs: `20261003T0448_baseline → 20261006T0209_batch2_identity_security → 20261006T1420_batch3_trust_safety → 20261006T1902_batch4_listing_quality → 20261007T1708_batch4_holistic_review_fixes → 20261007T2007_batch4_round4_approved_content_backfill` (self-edge `66d2193a…`, provides `backfill-listing-approved-content-at`) `→ 20261007T2208_batch5_search_telemetry → 20261008T0237_batch6_chat_deal`.
   - *Correction:*
     - Use `B6_DIR="migrations/app/20261008T0237_batch6_chat_deal"`. The plan output's `from:` must be `292dd3fb…`.
     - Expect 9 dirs after Batch 7, with exactly one new edge out of `292dd3fb…`.
     - The "two outgoing edges" rule is amended: `66d2193a…` already has the self-edge plus the batch5 edge (Batch 6 verification §4, lines 178-184).
     - The new dir name must sort after `20261008T0237` (head detection sorts names: `tests/unit/approved-content-backfill-migration.test.ts:68-72`).

2. **Task 1 Step 5, production-ref invariant.**
   - *Plan says:* `npx prisma migration ref set production "$END_HASH"` and nothing else.
   - *Real:* `refs/production.json` carries `"invariants": ["backfill-listing-approved-content-at"]`, and `ref set` wipes it (Batch 6 verification lines 185-193).
   - *Correction:*
     - After `ref set`, hand-restore that `invariants` array in `refs/production.json` in the same commit. Keep `refs/db.json` at `[]`.
     - Pinned by `tests/unit/approved-content-backfill-migration.test.ts:108-121` and the path-walk test `:123-177`. The scratch DB migrates `--to production` (`scripts/test-integration.sh:58`), so the Batch 7 tables only exist in integration runs once the ref is advanced.

3. **Task 1, earlier-batch migration pins must be appended** (the plan's "only Task 6 fixtures" rule is amended here).
   - `tests/unit/approved-content-backfill-migration.test.ts:162-171`: append `"<ts>_batch7_cohort_operations"` to the `@empty → production` dir list. Leave `:176` (end == production hash) as is.
   - `tests/integration/batch5-migration.test.ts:802,913`: add `const BATCH7_DIR = "<ts>_batch7_cohort_operations"` and make `applied` equal `[PRE_B5_HEAD_DIR, BATCH5_DIR, BATCH6_DIR, BATCH7_DIR]`.
   - Add both files to the Task 1 `git add`. Record them in the verification doc as append-only pin updates (the Batch 6 §5 precedent).

4. **Task 1 Step 1, the migration test must include the ops-package contract.** Mirror `tests/integration/batch6-migration.test.ts:380-422` in `batch7-migration.test.ts`. Find the dir with `/_batch7_cohort_operations$/` and assert:
   - table ops are exactly `["table.BetaInviteToken","table.FoundingSellerCandidate"]`;
   - zero `column.` ops (User gains relations only);
   - zero `destructive`, zero `data` ops, no `listing_status_check`;
   - exactly one `index.*beta_invite_one_active_*` op (hash-suffixed name);
   - no op id matching the finance regex at `:416`.

   This is the executable form of "zero data transforms (§8.4)" and "no finance table".

5. **Task 1 Step 3, the partial-index predicate cannot use bare camelCase columns.**
   - *Plan says:* `where: "(\"consumedAt\" IS NULL AND \"revokedAt\" IS NULL)"`.
   - *Real:* every existing predicate uses lowercase, unquoted columns: `contract.prisma:1025,1110,1247` render as `WHERE ((status = 'active'))` in `migrations/app/20261006T1420_batch3_trust_safety/ops.json`. Unquoted `consumedAt` folds to `consumedat` in Postgres and fails. No precedent shows escaped quotes inside a PSL `where:` string.
   - *Correction:*
     - After `contract emit` + `migration plan`, read the rendered `CREATE UNIQUE INDEX` SQL in `ops.json`. It must contain `"consumedAt" IS NULL AND "revokedAt" IS NULL`, and the batch7-migration test must prove the index rejects a second active token.
     - If PSL rejects the escaped quotes or renders them wrongly, fall back to a lowercase column: add a defaulted `active Boolean @default(true)` column, set it to `false` in the same `updateAll` that consumes or revokes, and use `where: "(active = true)"`. Record the deviation.
     - Do **not** hand-edit `ops.json`.

6. **Task 1, ops-alerts classification (conditional; blocking at merge).**
   - `NON_FINANCE_TABLES` lives at `scripts/ops-alerts.ts:128-160` on `local/b8-early-integration`. The drift test at `tests/unit/ops-alerts.test.ts:546-563` requires every contract model to be classified. The doc row is `docs/operations/monitoring-signals.md:145` ("27 bảng còn lại").
   - Whichever of Batch 7 and the early-B8 merge lands second adds `FoundingSellerCandidate` and `BetaInviteToken`. Batch 6's pending `Deal`/`DealStatusHistory` and Batch 5's `ProductEvent`/`SearchAlias` go in at the same time (Batch 6 verification §12 merge actions 1, lines 472-480). Update the table count too.
   - If early B8 has merged before Batch 7 Task 1, these edits go into the Task 1 commit.

7. **Task 3, the token landing must be a Route Handler, not a page.**
   - *Plan says:* `app/invite/[token]/page.tsx` sets the cookie and redirects.
   - *Real:* a Server Component cannot set cookies (cookies.md:74,81).
   - *Correction:*
     - Create `app/invite/[token]/route.ts` with `export async function GET(request: Request, ctx: RouteContext<"/invite/[token]">)`. Use `const { token } = await ctx.params`, then validate the token (item 12).
     - On a valid token: set the cookie and return `NextResponse.redirect(new URL("/invite", request.url), 303)`. On an invalid one: redirect to `/invite` **without** a cookie, so the page renders the generic "Lời mời không còn hiệu lực".
     - The GET must have **no side effect except the cookie**. Messenger/Zalo link-unfurl bots will GET it; it must never consume, log, or audit.
     - Fix the Task 3 file list and `git add` (`'app/invite/[token]/route.ts'`), and the Task 8 `rg` paths.

8. **Task 3, `Referrer-Policy: no-referrer` on `/invite/:path*` breaks the accept action.**
   - `:path*` also matches `/invite`. With `no-referrer`, the browser sends `Origin: null` on the same-origin action POST.
   - Next's CSRF check then rejects it ("Invalid Server Actions request", `node_modules/next/dist/server/app-render/action-handler.js:427-460`; `originHost === 'null'` ≠ host).
   - *Correction:* set `Referrer-Policy: no-referrer` only on the token response: in the route handler's redirect headers **and** in `next.config.ts` with `source: "/invite/:token"`. Do not set it on `/invite`. Optionally add `X-Robots-Tag: noindex` for both.
   - Keep the `/uploads/:path*` block (`next.config.ts:26-36`) byte-identical. `tests/unit/upload-route.test.ts:791-806` evaluates `headers()` output and must stay green.

9. **Task 3, `inviteCandidateAction` writes must be conditional.**
   - Inside the tx:
     - (a) revoke with `tx.orm.public.BetaInviteToken.where({ candidateId }).where((t) => t.consumedAt.isNull()).where((t) => t.revokedAt.isNull()).updateAll({ revokedAt: nowIso })`. The plan's `{ consumedAt: null, revokedAt: null }` is wrong (Global rules).
     - (b) create the token.
     - (c) **`tx.orm.public.FoundingSellerCandidate.where({ id, status: <status read before the tx> }).updateAll({ status: "invited", invitedAt })`**, and throw sentinel `CANDIDATE_ALREADY_MOVED` when `.length === 0`. Also re-assert that the status is `prospect` or `invited`.
     - (d) `auditEventTx`.
   - Classify `beta_invite_one_active` by **prefix** outside the tx (the rendered name is `beta_invite_one_active_<8hex>`, cf. `deal_one_open_per_listing_buyer_77dfd57d` in the batch6 `ops.json`).
   - Emit `seller_invited` only after commit.

10. **Task 3, `acceptInviteAction` claim and writes must be conditional, and the guard order is fixed.** Corrected order:
    1. `getCurrentUser()`. If there is no user, `redirect("/login?next=/invite")` outside any try. Do not use `requireUser()`: it derives `next` from `Referer` (`src/lib/auth.ts:64-74`).
    2. Rate limit (item 15).
    3. Read the cookie, compute the HMAC, and look up the token row (items 12 and 13).
    4. Self-issue refusal (item 20).
    5. Fresh `User.first({ id })` + channel binding (item 14).
    6. `isUserSuspended`.
    7. `db.transaction`, which re-reads candidate and membership and throws the refusal sentinels **before** the claim:
       - **Claim:** `tx.orm.public.BetaInviteToken.where({ id: row.id }).where(t => t.consumedAt.isNull()).where(t => t.revokedAt.isNull()).where(t => t.expiresAt.gt(nowIso)).updateAll({ consumedAt: nowIso })`. On 0 rows, throw `INVITE_CONSUMED_RACE`. The plan's claim only checked `consumedAt`, so a token revoked or expired between the pre-read and the tx would be consumed.
       - **Membership:** `invited → active` uses `where({ id, status: "invited" }).updateAll(...)`. `active` only fills `acceptedAt` when it is null (`where(m => m.acceptedAt.isNull())`).
       - **Candidate link:** `where({ id, status: "invited" }).where(c => c.userId.isNull()).updateAll({ userId, registeredAt, status: "registered" })`. On 0 rows, throw `INVITE_LINKED_ELSEWHERE`.
       - Then `auditEventTx`.
    8. Classify outside the tx.
    9. After commit: delete the cookie, run `syncFoundingSellerFunnel` (global db; item 22), emit, notify (item 25), then `redirect("/sell")` outside any try.
    - Map `INVITE_CONSUMED_RACE`, `INVITE_LINKED_ELSEWHERE`, `INVITE_NOT_INVITED` and every 23505 to the **byte-identical `INVITE_INVALID`** string. That is what the plan's own tests at plan lines 613/622/623 expect; plan step 7's "form error theo code" is wrong. Only `INVITE_MEMBERSHIP_NOT_ACCEPTABLE`, `INVITE_CHANNEL_*`, `INVITE_ACCOUNT_SUSPENDED`, `INVITE_SELF_ISSUED` and `RATE_LIMITED` are distinct.

11. **Task 6, `createDealAction` maps only listed guard codes; anything else becomes a 500.**
    - *Real:* `src/lib/actions/deals.ts:77-84` is the allowlist `DEAL_CREATE_GUARD_ERROR_CODES`; `:143-156` rethrows anything outside it.
    - *Correction:*
      - Insert `await assertBuyerBetaChatAccess(user.id);` **inside** the existing try at `:144-148`, after `assertListingSellerInteractable(listing.sellerId)` (`:146`) and before `requireDealConversation` (`:147`).
      - Append `"BETA_MEMBERSHIP_REQUIRED"` to the allowlist.
      - Add `BETA_MEMBERSHIP_REQUIRED: "Bạn cần là thành viên beta để tạo thỏa thuận mới"` (PROVISIONAL copy) to `DEAL_CREATE_ERROR_TEXT` in `src/components/deal-create-form.tsx:41-56`. Add that file to the Task 6 file list and commit.
      - `markDealOutcomeAction` stays untouched.

12. **Task 3, token lookup and HMAC.**
    - `hkdfKey` lives in `src/lib/hkdf.ts:30` (plain module); `src/lib/otp.ts:67` re-exports it.
    - Compute `tokenHash = createHmac("sha256", hkdfKey("beta-invite-hash")).update(token).digest("hex")` in the server-only domain module. Do not put it in the `"use server"` file as a non-async export.
    - Before any lookup, reject cookie or path values that are not 43-char base64url (`/^[A-Za-z0-9_-]{43}$/`). No db call happens for garbage.
    - After `first({ tokenHash })`, compare with `timingSafeEqual` (the `hashEquals` pattern in `src/lib/otp.ts:79-83`; the helper is private, so copy it).
    - `AUTH_SECRET` is required (`hkdf.ts:34`). Integration tests must `vi.stubEnv("AUTH_SECRET", …)` (`tests/integration/chat-hardening.test.ts:229`).

13. **Task 3, rate limit and oracle on the unauthenticated GET landing.** The landing is a token-validity oracle with no limit. In the route handler, call `rateLimitRequest(request, "invite-landing", BETA_INVITE_LANDING_RATE)` (`src/lib/rate-limit.ts:130-144`; it returns a 429 Response) before any db read. `BETA_INVITE_LANDING_RATE` is PROVISIONAL (default `{ limit: 30, windowMs: 10 * 60_000 }`), defined in `founding-seller-vocab.ts`.

14. **Task 3, channel binding details.**
    - `User.phone` is nullable (`contract.prisma:251`). `normalizePhone` throws on bad format (`otp.ts:101-110`). Treat null or throw as `INVITE_CHANNEL_MISMATCH`; never let it escape as a 500.
    - Email is compared with `normalizeEmail(fresh.email)` (`otp.ts:88-90`).
    - `SessionUser` has no phone or verification fields (`src/lib/session.ts:58-70`), so the fresh `User.first({ id })` read is mandatory, as the plan says.

15. **Task 3, the acceptance IP bucket collapses to one global bucket.** `clientIpFromHeaders` returns `"local"` unless `TRUST_PROXY_HEADERS=true` (`rate-limit.ts:96-99`), so 10 failures would lock out every invitee. Keep the per-user bucket `beta-invite-accept:<userId>` (10/10 min). Add the IP bucket **only when** `process.env.TRUST_PROXY_HEADERS === "true"`, and test both branches.

16. **Task 6, `isActiveBetaParticipant` must honor `expiresAt` and stay mock-compatible.**
    - Real precedents: `isMembershipActive` (`src/lib/seller-verification-policy.ts:156-163`, not exported, and the file is read-only) and `src/lib/deal.ts:73-80`.
    - Implement it as `BetaCohortMembership.where({ userId, status: "active" }).all()`, then filter in JS by cohort ∈ `BETA_CHAT_ALLOWED_COHORTS` and `expiresAt == null || Date.parse(expiresAt) > Date.now()`.
    - Use plain-object `where` only. Every unit mock (e.g. `tests/unit/chat-guard.test.ts:168-238`) supports object predicates, not closure ops like `.in()`.
    - Add an expired-membership test.

17. **Task 6 Step 3b, the fixture migration as it really applies on this tree.** The plan's "each of eight files edited exactly once" becomes **"at most once"**. All Batch 6 files already seed *seller* eligibility; Batch 7 adds only the *acting buyer's* membership (`private_beta_buyer`, `active`, `expiresAt: null`):
    - `tests/unit/chat-guard.test.ts`: `BUYER` at `:263`. Push the buyer membership in the reset at `:399-407`, **after** `SELLER_MEMBERSHIP`.
    - `tests/unit/chat-hardening.test.ts`: `BUYER` at `:292`; reset at `:485-493`. The seller lookup at `:472` is by userId, so it is safe.
    - `tests/unit/telemetry-wiring.test.ts`: in the `startConversationAction` describe's `beforeEach` (`:938-944`), push a buyer membership next to `seedPolicyRows(SELLER.id)`.
    - `tests/unit/deal-create.test.ts`: `:709` and `:719` mutate **`dbState.memberships[0]`**, assuming the seller row is first. Push the buyer row **after** the seller's (`:484-490`), or change those lines to find by `userId === SELLER.id` (preferred, no assertion change).
    - `tests/integration/block-enforcement.test.ts`: the actor `buyer` is from bare `mkUser("buyer")` (`:73-82`), calls at `:254-339`. Add a `seedBuyerMembership(buyer)` helper. Memberships cascade on user delete (`contract.prisma:899`).
    - `tests/integration/chat-hardening.test.ts`: `buyer`/`buyer2` at `:240-241` need memberships.
    - `tests/integration/deal-lifecycle.test.ts`: buyers in `seedOpenDeal` (`:305-312`) and at `:582`. Track and delete their memberships like `:255`, or rely on the cascade.
    - `tests/integration/suspension-enforcement.test.ts`: the actor `sellerX` already holds `founding_seller` active through `seedSevenRequirements` (`:98-123`, `:270`), which is an allowed cohort. **Expected: no edit.** Edit it only if a run proves otherwise, and record that.

    Record the exact per-file outcome in the verification doc.

18. **Task 6, the listing page must not render a dead chat CTA for non-member buyers.**
    - *Real:* `app/listings/[slug]/page.tsx:413-425` renders "Nhắn người bán" whenever `sellerEligible`. There is no `app/error.tsx`, so a non-member's click throws `BETA_MEMBERSHIP_REQUIRED` into Next's default error page.
    - *Correction:*
      - Add `app/listings/[slug]/page.tsx` to Task 6. Compute `buyerBetaEligible` only for a **logged-in** non-owner when `ctaVisible`: `user === null || buyerConvo !== null || await isActiveBetaParticipant(user.id)`.
      - Anonymous visitors keep the CTA; `requireUser` sends them to login (Batch 6 corrections #16).
      - A buyer with an existing conversation keeps the CTA, because the redirect branch is ungated.
      - Otherwise render neutral copy "Tính năng nhắn tin đang giới hạn cho thành viên beta" (PROVISIONAL) in place of the form, using the D12 `<p>` pattern at `:430-435`.
      - Keep these pins: `finance-public-surface.test.ts:146,178-186`, `sell-pages.test.ts:1089-1128` (extend the existing `BetaCohortMembership` mock at `:217` with a buyer row where the test logs in), and the disclaimer `:436-437`.
      - Add `tests/unit/sell-pages.test.ts` to the Task 6 commit as a recorded fixture edit.

19. **Task 5 / D3, there is no UI to grant `private_beta_buyer`, so the default-ON gate locks every buyer out.**
    - *Real:* `/admin/users` only renders `founding_seller` grant/suspend forms (hidden `cohort=founding_seller` at `app/admin/users/page.tsx:233-256`) and only reads the founding membership (`:98,:107`).
    - *Correction:*
      - In Task 5, add a "private_beta_buyer" column and grant/suspend forms to `app/admin/users/page.tsx`, reusing **Batch 2's `setBetaMembershipAction`** with `cohort=private_beta_buyer`. This is not a second mutation surface; it is audited `beta_cohort.membership_set`, self-grant forbidden at `beta-cohort.ts:55-60`. Gate the forms on `canManageCohort` (`:54`).
      - Add read-only display of the buyer membership.
      - Update the plan's Task 5 source scan, which forbids `setBetaMembershipAction` only in Batch 7 *console* files. The users page is Batch 2's surface and already imports it at `:6`.
      - See PROVISIONAL P2.

20. **Task 3, self-grant bypass through the invite flow.**
    - `setBetaMembershipAction` forbids self-grant (`src/lib/actions/beta-cohort.ts:55-60`, `SELF_GRANT_FORBIDDEN`).
    - `acceptInviteAction` must refuse with `INVITE_SELF_ISSUED`, before the tx and without consuming, when `row.issuedById === user.id`.
    - `createCandidateAction` and `inviteCandidateAction` must refuse when the normalized contact equals the operator's own fresh `User.email`/`User.phone` (`CANDIDATE_CONTACT_IS_OPERATOR`).
    - Test both. Record "admin account as founding seller" in the Batch 8 register.

21. **Task 3/5 tests, admin FORBIDDEN cases must run real RBAC (MFA proof).**
    - Do **not** `vi.mock("@/src/lib/rbac")` for the role matrix. `requireCapability` also requires `session.isAdmin` (`src/lib/rbac.ts:141-149`).
    - Use the `tests/unit/beta-cohort.test.ts:209-290` recipe: mock the `UserSession` rows plus `login(user, { isAdmin })`.
    - Cases: moderator/support/analyst → FORBIDDEN; operations_admin with `isAdmin: false` → FORBIDDEN; operations_admin and super_admin with `isAdmin: true` → allowed (matrix at `rbac.ts:62-94`).

22. **Task 2/4, `syncFoundingSellerFunnel` semantics and call sites.**
    - Use a conditional write: `where({ id, status: <read status> }).updateAll({ status, verifiedAt?, firstListingAt? })`. On 0 rows, return `{ from, to: from, changed: false }`; never retry blindly.
    - Return `{ from, to, changed }`, not a bare status. The `founding_seller.funnel_synced` audit needs `from→to`, and an unchanged sync writes **no** audit.
    - Mapping from `SellerVerification.status` (enum at `contract.prisma:106-114`):
      - `pending|needs_review` → at least `verification_pending`;
      - `verified` → at least `verified`;
      - `not_started|rejected|revoked` → no advance.
    - ≥1 `Listing.where({ sellerId, status: "approved" })` together with `verified` → `first_listing`.
    - The sync uses its own monotonic order. It is **exempt from `canTransitionCandidate`**, which only governs manual moves. State this in the module.
    - Call it only with the global `db`, **after** a committed tx (from `acceptInviteAction` and `syncCandidateFunnelAction`). Never call it inside a tx callback or during render.

23. **Task 4, every lifecycle write is a conditional `updateAll`.** This covers `assignCandidateOperatorAction`, `recordCandidateContactAction`, `updateCandidateNotesAction` and `updateQualityListingCountAction`.
    - Use `where({ id }).updateAll(...)`; `.length === 0` → `NOT_FOUND`.
    - `updateCandidateStatusAction` uses `where({ id, status: from }).updateAll({ status: to })` → `CANDIDATE_ALREADY_MOVED`.
    - Do **not** append the transition note to `candidate.notes`; that read-modify-write loses concurrent notes edits. The note goes only into the `founding_seller.status_changed` `AuditEvent.detail` through `redactDetail` (`src/lib/audit-event.ts:163-168`). `notes` is written only by `updateCandidateNotesAction`.
    - Do not set `updatedAt` by hand; `temporal.updatedAtString()` maintains it.
    - `assignCandidateOperatorAction`: an empty `operatorId` means unassign (`null`) and is audited. Eligibility is `capabilitiesOf(op.adminRole).includes("beta_cohort.manage")` (`rbac.ts:105-108`).

## NON-BLOCKING

24. **23505 tests.** Throw a real `new SqlQueryError(msg, { sqlState: "23505", constraint: "beta_invite_one_active_deadbeef" })` from `@prisma/orm-family-sql/errors` (`tests/unit/deal-create.test.ts:267`, `appeal-actions.test.ts:227`), not a shaped object. Exact constraint names that are not hash-suffixed: `BetaCohortMembership_userId_cohort_key` (batch2 `ops.json`), `FoundingSellerCandidate_userId_key`, and `BetaInviteToken_tokenHash_key` (same `@unique` rendering as `UserSession_tokenHash_key`). Still match by prefix.

25. **Notify after commit.** `notify` (`src/lib/notify.ts:5-19`) throws on db error. Wrap it in try/catch and log `captureError("cohort", "COHORT_NOTIFY_FAILED", { sqlState })` (the `src/lib/actions/moderation.ts:292-305` pattern) with no error object and no contact. Kind `"cohort"` falls back to the Bell icon (`app/notifications/page.tsx:12,72`); that is acceptable.

26. **Telemetry API confirmed.**
    - `seller_invited`, `seller_registered` and `beta_membership_activated` are `z.strictObject({})` (`src/lib/product-events.ts:213-219`), so pass **no `metadata`**.
    - `provinceCode` is a typed top-level input column (`:430,:538`), which is fine.
    - Pass the raw `user.sessionId` as `sessionId` for `seller_registered`/`beta_membership_activated` (`:411-433`).
    - `emitProductEvent` is fail-open and never throws. Call it only after commit and do not wrap it.
    - Nothing in `metrics.ts` or the dashboard consumes `seller_invited`/`seller_registered` today (git grep shows only `product-events.test.ts:532-533`), so the console counts come from candidate rows, not events.
    - Integration tests must `vi.stubEnv("PRODUCT_EVENT_PSEUDONYM_KEY", …)` (`tests/integration/deal-lifecycle.test.ts:282`). `test-integration.sh` sets only `DATABASE_URL`.
    - Calling `emitProductEvent` directly is fine (`telemetry-recorders.ts` stays read-only; `recordBetaMembershipActivated` at `:370-379` takes no province).

27. **`/admin/users?q=<userId>` finds nothing.**
    - *Real:* `q` is an email/name `ilike` (`app/admin/users/page.tsx:67-83`).
    - *Correction:* in Task 5, add an exact `?u=<userId>` filter (`where({ id })`, no `ilike`) and point the console link at `/admin/users?u=<id>`. Keep `q` unchanged and put no email or phone in any URL.

28. **Task 5 nav test.** Assert `href: "/admin/beta-cohort"` plus `capability: "beta_cohort.manage"` inside `NAV` (`app/admin/layout.tsx:37-60`) and that filtering still goes through `caps.includes(item.capability)` (`:71-72`). Do not assert the literal `capabilitiesOf(...).includes("beta_cohort.manage")`. Existing pins `admin-session-actions.test.ts:916-929` and `analytics-dashboard.test.ts:129-137` stay green. The new page is enumerated automatically by `tests/unit/admin-page-guards.test.ts:35-46`.

29. **Audit naming and filter.**
    - Keep `src/lib/audit-event.ts` **untouched**. Batch 6 did not edit its registry comment (`:14-68`) either. List the ten `founding_seller.*` names in the `src/lib/actions/founding-sellers.ts` header and in the verification doc.
    - Add `{ value: "founding_seller", label: "Founding seller" }` and `{ value: "beta_cohort", label: "Beta cohort" }` to `ACTION_PREFIXES` in `app/admin/audit/page.tsx:35-41`, which is additive. The pin `audit-append.test.ts:906-912` uses `toContain`. Add the file to Task 5.
    - `resourceType` follows the majority model-name convention: `"FoundingSellerCandidate"` and `"BetaInviteToken"` (cf. `"BetaCohortMembership"` at `beta-cohort.ts:105`).

30. **Task 7, there are five publication transitions, not four.** They are `createListingAction` (`listings.ts:403`), `updateListingAction` (`:933`), `toggleListingVisibilityAction` (`:780`), `submitListingAction` (`:1238`) and `approveListingAction` (`src/lib/actions/admin.ts:57`). Approve needs the `version` form field (`:63`, = `listing.updatedAt`). `isListingSearchable` is at `src/lib/search-query.ts:52`. `saveListingDraftAction` (`:531`) stays ungated (§4.4); assert that explicitly.

31. **Task 6 import-graph pin.** `tests/unit/deal-finance-isolation.test.ts:309-343` runs a BFS from `chat.ts`/`deals.ts`. `src/lib/beta-access.ts` may import only `server-only` and `@/src/prisma/db.client`. The source-order pin `:396-409` stays green as long as `assertBuyerBetaChatAccess(` sits between `chat.ts:69` and `:71`. Optionally extend that test in Task 6 with the buyer-guard index, which is additive.

32. **Integration cleanup order and seed.**
    - `BetaInviteToken.candidate` has no `onDelete` in the plan, so it renders as NoAction. Declare `onDelete: Restrict` explicitly to document "tokens are never deleted by product flows", and delete tokens before candidates in test cleanup.
    - `FoundingSellerCandidate.userId`/`assignedOperatorId` and `BetaInviteToken.issuedById` are SetNull, so `src/prisma/seed.ts:188-210` (`User.where({}).deleteAll()`) is not blocked. Optionally add `BetaInviteToken` then `FoundingSellerCandidate` `deleteAll` before `User` so re-seeds don't leave orphaned candidates. This is a recorded seed edit; `multi-row-writes` runs seed twice.
    - Integration suites share one scratch DB serially (`vitest.integration.config.ts`: `fileParallelism: false`). Use a unique contact per test, because the S7 duplicate pre-check is global.

33. **copy-safety (conditional; activates after the early-B8 merge).** `tests/unit/copy-safety.test.ts` (`local/b8-early-integration`) walks `app/**.tsx`, `src/components/**.tsx` and `src/content/**.ts` (`:76-79`). It excludes only `app/admin/` (`:133-135`) and strips only whole-line comments (`:150-156`).
    - `app/invite/page.tsx`, `src/components/invite-accept-form.tsx`, `src/components/founding-seller-console.tsx` and `src/components/founding-seller-forms.tsx` **are scanned**, including trailing comments.
    - They must contain no `đảm bảo|bảo đảm|bảo hiểm|bảo vệ (thanh toán|giao dịch)|giữ tiền hộ|escrow|guarantee|insurance` (`:171-180`).
    - The §5.10.1 concierge card must say "không tự ý tạo thông tin thay người bán", not anything with "bảo đảm".
    - Re-run after the merge.

34. **Task 2 `maskContact` spec is internally inconsistent.** `"0901234567"` → `"09*****67"` has 9 characters for a 10-digit input. Pin a **fixed-width** rule: first 2 digits + `*****` + last 2. For email: first char + `***@domain`, or `***@domain` when the local part is 1 char. The fixed width avoids leaking length.

35. **Task 3 cookie attributes.**
    - `sp_invite`: `httpOnly: true`, `sameSite: "lax"`, `secure: process.env.NODE_ENV === "production"`, **`path: "/invite"`** (the action POSTs to `/invite`, so the narrower path still works and the token never rides other requests), `maxAge: 15 * 60`.
    - Delete it with the same path.
    - The register page does not carry `next` (`app/(auth)/register/page.tsx` has no `searchParams`; only login does, at `app/(auth)/login/page.tsx:9,21`). The `/invite` copy must tell a new invitee to reopen the original link after registering and verifying. Re-GET re-sets the cookie while the token is unconsumed. Do not edit the auth pages.

36. **Task 3 invite URL.** `NEXT_PUBLIC_APP_URL` is required in production (`src/lib/env.ts:25,76`; `docker-compose.prod.yml:117`). If it is unset, return `{ error: "APP_URL_UNCONFIGURED" }` instead of the plan's `?? ""` relative URL, and roll back nothing (check it **before** the tx).

37. **Task 5 console reads.** `checkSellerPublicationRequirements(userId)` returns `{ ok, missing }` (`seller-verification-policy.ts:176-216`). It runs about 5 queries per linked candidate, which is acceptable at ≤ 300 rows; load candidates with one query. The page is a server component guarded by `requireCapability("beta_cohort.manage")` before any read. `force-dynamic` is consistent with the other admin pages.

38. **Version note.** `package.json:30` pins `next` at `16.3.8`, not the 16.3.7 the plan names. The local `node_modules` docs (16.3.7) still apply; the doc paths in the plan exist.

39. **Spec reading recorded.** §5.10 calls the lifecycle a "Possible lifecycle" (spec lines 1755-1768). The transition table stays PROVISIONAL (FD-3), as the plan says. `contactReference?` is optional in §5.10 (`:1739`) but required by the invite flow; `createCandidateAction` requires it, and the model keeps it nullable.

## PROVISIONAL founder decisions (ship the fail-closed default; Batch 8 register)

- **P1. Verified-channel binding versus FD-2 (most consequential).**
  - In production the OTP adapter is fail-closed (`src/lib/verification-delivery.ts` header: `NODE_ENV === "production"` → `OTP_DELIVERY_UNAVAILABLE`), so **no invitee can verify email or phone in production**, and so no one can accept an invite.
  - Default: keep requiring a verified channel; do not weaken it. The only production path until a provider lands is the manual psql `user.email_verified_manual` runbook (registry `audit-event.ts:34-38`, two-person rule), which is the same blocker that already applies to seller publication.
  - Register: "invite acceptance is unreachable in production until FD-2, or until the founder accepts token possession plus out-of-band delivery as channel proof."
- **P2. D3 buyer gate ON.** Ship `BETA_CHAT_REQUIRES_ACTIVE_MEMBERSHIP = true` **plus** the item 19 buyer-grant UI. Without that UI, ON means no buyer can chat at launch. Staff accounts also need an `internal` or `private_beta_buyer` membership granted by *another* admin (self-grant forbidden).
- **P3. Admin or issuer as founding seller.** Default: refuse when issuer == acceptor or the contact equals the operator (item 20). Other admin accounts may accept, and that is recorded.
- **P4. Existing `active` membership that has expired** (`expiresAt` in the past) at acceptance. Default: refuse before the claim with `INVITE_MEMBERSHIP_NOT_ACCEPTABLE`, the same as `suspended`/`exited`. The acceptance path never clears `expiresAt`.
- **P5. Rate values.** Landing 30/10 min/IP (item 13); accept 10/10 min/user plus the IP bucket only behind a trusted proxy (item 15); invite 20/h/admin. Cookie TTL is 15 minutes.

## v1 → v2 mapping

- v1#1 → item 7 (and the GET must be side-effect-free).
- v1#2 → item 8 (verified at `action-handler.js:427-460`).
- v1#3 → item 13.
- v1#4 → item 6 (conditional; files are absent from this tree).
- v1#5 → item 9 / Global rules (prefix match).
- v1#6 → item 20.
- v1#7 → items 9, 10, 22, 23 (plus `isNull` idiom).
- v1#8 → item 21.
- v1#9 → item 24.
- v1#10 → item 12 (`hashEquals`, `otp.ts:79-83`).
- v1#11 → item 15.
- v1#12 → items 10, 14.
- v1#13 → item 16.
- v1#14 → item 27 (`?u=`).
- v1#15 → item 28.
- v1#16 → item 29 (revised: keep `audit-event.ts` untouched).
- v1#17 → item 33 (conditional).
- v1#18 → item 30.
- v1#19 → items 11 and 18.
- v1#20 → item 26 (verified: no metadata).
- v1#21 → items 22, 23.
- v1#22 → items 1–3 (concrete head `292dd3fb…`).
- New in v2: items 4, 5, 17, 19, 25, 31, 32, 34–39 and P1–P5.

## Parallelism map (file-disjoint)

- **Wave 1 — T1:** `src/prisma/contract.prisma`, `contract.json`, `contract.d.ts`, `migrations/app/<ts>_batch7_cohort_operations`, `migrations/snapshots`, `migrations/app/refs/{db,production}.json` (invariant restore), `tests/integration/batch7-migration.test.ts`, `tests/unit/approved-content-backfill-migration.test.ts`, `tests/integration/batch5-migration.test.ts`, optionally `src/prisma/seed.ts`. It also takes `scripts/ops-alerts.ts` + `docs/operations/monitoring-signals.md` + `tests/unit/ops-alerts.test.ts` only if early B8 has merged.
  - **∥ T2:** `src/lib/founding-seller-vocab.ts`, `src/lib/founding-sellers.ts`, `tests/unit/founding-sellers.test.ts`. Typecheck after T1.
- **Wave 2 (after T1 + T2):**
  - **T3:** `src/lib/actions/founding-sellers.ts`, `app/invite/[token]/route.ts`, `app/invite/page.tsx`, `src/components/invite-accept-form.tsx`, `next.config.ts`, and its tests.
  - **∥ T6:** `src/lib/beta-access.ts`, `src/lib/actions/chat.ts`, `src/lib/actions/deals.ts`, `src/components/deal-create-form.tsx`, `app/listings/[slug]/page.tsx`, the new beta-gate tests, the item 17 fixture files and `tests/unit/sell-pages.test.ts`.
- **Wave 3:** T4 (`src/lib/actions/founding-sellers.ts` again, `src/lib/constants.ts`, `tests/unit/founding-seller-lifecycle.test.ts`), strictly after T3 because it is the same file.
- **Wave 4:** T5 (`app/admin/beta-cohort/page.tsx`, `src/components/founding-seller-console.tsx`, `src/components/founding-seller-forms.tsx`, `app/admin/layout.tsx`, `app/admin/users/page.tsx` (`?u=` + buyer grant), `app/admin/audit/page.tsx`, `tests/unit/beta-cohort-console.test.ts`).
  - **∥ T7** (tests only; after T3 + T6).
- **Then** T8 (verification doc). After the early-B8 merge, re-run copy-safety and ops-alerts (items 6 and 33).
- **Shared-file serialization:**
  - `founding-sellers.ts` actions: T3 → T4.
  - `app/admin/users/page.tsx`: T5 only.
  - `app/listings/[slug]/page.tsx` + `sell-pages.test.ts`: T6 only.
  - Integration suites share the scratch DB, so run `npm run test:integration` serially per wave.
