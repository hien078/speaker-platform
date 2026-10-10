# Batch 6 plan corrections v2 (re-verified against the real post-Batch-5 tree `/tmp/b6prep`, 2026-10-08)

> **MANDATORY — overrides the plan text** (`docs/superpowers/plans/2026-10-06-private-beta-batch-6-chat-deal.md`).
> Supersedes `/tmp/b6prep-corrections.md` (v1, written against a tree without Batch 5). Every file:line below was read in `/tmp/b6prep`.
> Early Batch 8 work (`scripts/ops-alerts.ts`, `tests/unit/copy-safety.test.ts`, `src/content/policies/*`) is **NOT in this tree**. It exists on branch `local/b8-early-integration` and merges later. Items 5 and 18 say what to do when it lands.

## BLOCKING

1. **Task 1 Step 0/3, migration base.** *Plan says:* placeholder `B5_DIR="migrations/app/<ts>_batch5_search_telemetry"`, and the graph is `baseline → batch2 → batch3 → batch4 → batch5`. *Real:* `refs/db.json` and `refs/production.json` both hold hash `1350a596e5d91729f817bb862f0dc4089c7fbb2676d3fc96fe8889a8fce8760e`, which is the `to` of `migrations/app/20261007T2208_batch5_search_telemetry/migration.json`. The graph has 7 dirs: baseline → batch2 → batch3 → `20261006T1902_batch4_listing_quality` → `20261007T1708_batch4_holistic_review_fixes` → `20261007T2007_batch4_round4_approved_content_backfill` (a **self-edge**: from = to = `66d2193a…`, `providedInvariants: ["backfill-listing-approved-content-at"]`) → batch5. *Correction:* use `B5_DIR="migrations/app/20261007T2208_batch5_search_telemetry"`. The plan output's `from:` must be `1350a596…`. The expected `migration list` is that 7-node walk plus `batch6_chat_deal` (8 dirs). Batch 6 adds exactly one edge out of `1350a596…`. Do not apply the plan's "no node with two outgoing edges" literally: `66d2193a…` already has the self-edge plus the batch5 edge, and the Batch 5 verification (§2) accepted that.

2. **Task 1 Step 5, production-ref invariant.** *Plan says:* `npx prisma migration ref set production "$END_HASH"`. *Real:* `ref set` rewrites `refs/production.json` with `invariants: []`, and it has no flag to keep invariants (`prisma migration ref set --help`). The current `refs/production.json` carries `"invariants": ["backfill-listing-approved-content-at"]`. This is Batch 5 verification R11, line 511. *Correction:* after `ref set`, hand-restore `"invariants": ["backfill-listing-approved-content-at"]` in `refs/production.json`, in the same commit. Leave `refs/db.json` with `[]`. This is pinned by `tests/unit/approved-content-backfill-migration.test.ts:108-121`. `scripts/test-integration.sh:58` runs `db migrate --to production`, so the Deal tables only exist in the scratch DB once the ref is advanced.

3. **Task 1, earlier-batch migration pins break when the ref advances.** *Plan says:* the only allowed earlier-test edits are the B1 fixtures. *Real:* two tests pin the head:
   - `tests/unit/approved-content-backfill-migration.test.ts:148-157` asserts the exact 7-dir `--from @empty --to production` path (this runs in `npm test`).
   - `tests/integration/batch5-migration.test.ts:909` asserts `applied == [round4, batch5]`.

   *Correction:* in the Task 1 commit, append `"<ts>_batch6_chat_deal"` to both lists. `:162` and `:910` (end == production hash) stay as they are. Add both files to the Task 1 `git add`. Record them in the verification doc as a permitted earlier-batch pin update; this amends the Global Constraints "only B1" rule.

4. **Task 1 (seed) + Tasks 3–5 (integration cleanup), FK Restrict.** *Real:* `src/prisma/seed.ts:188-207` wipes tables in FK order and ends with `User.where({}).deleteAll()` at `:206`. `Deal.buyer`/`seller` will be `Restrict`. *Correction:*
   - Add `await db.orm.public.Deal.where({}).deleteAll();` before `Conversation`/`Listing` (`:192-203`) and therefore before `User`, and add `seed.ts` to the Task 1 commit.
   - Do **not** write a `DealStatusHistory` mutation statement anywhere under `src/`. History goes away through `onDelete: Cascade` from `Deal` (see item 24).
   - Always use `deleteAll`, never `.delete()`: `.delete()` removes only the first matching row (`seed.ts:184-186`).
   - Integration suites must delete their Deals (and the `ProductEvent` rows they emit) before their users. Vitest file order is not alphabetical (Batch 5 R10).

5. **Task 1, ops-alerts classification (conditional; blocking at merge).** *Real:* `scripts/ops-alerts.ts` is absent here. On `local/b8-early-integration`:
   - `NON_FINANCE_TABLES` is at `scripts/ops-alerts.ts:128-160`.
   - The drift test is at `tests/unit/ops-alerts.test.ts:546-569`; every contract model must be classified.
   - The doc rows are at `docs/operations/monitoring-signals.md:145` ("27 bảng còn lại") and `:228`.

   *Correction:* whichever of Batch 6 or early Batch 8 merges second adds `Deal` and `DealStatusHistory` to `NON_FINANCE_TABLES` and the doc rows, together with Batch 5's `ProductEvent` and `SearchAlias` (Batch 5 verification line 563). It must also update the count in the `:145` row. If early Batch 8 merges before Batch 6 Task 1, these edits go into the Task 1 commit.

6. **Task 2, `assertListingSellerInteractable` membership expiry and delegation.** *Plan says:* `BetaCohortMembership.where({ userId, cohort: "founding_seller", status: "active" }).first()`. *Real:* the publication policy treats an expired membership as inactive. That logic is `isMembershipActive` in `src/lib/seller-verification-policy.ts:156-163`; it is **not exported**, and Q5 forbids editing the file. `checkSellerPublicationRequirements` (`:213-265`) reads `UserSuspension` itself, which breaks the S10 `isUserSuspended` delegation spy, and it also reads `User` and `PolicyAcceptance`, so every mock would need those models. *Correction:*
   - Keep the plan's direct reads: `isUserSuspended(sellerId)` (`src/lib/moderation.ts:34`), then `SellerVerification.first({ userId })` with `status === "verified"`, then `BetaCohortMembership.first({ userId, cohort: "founding_seller" })`.
   - Treat the membership as active only when `status === "active" && (expiresAt == null || Date.parse(expiresAt) > Date.now())`.
   - Add an expired-membership case (→ `SELLER_MEMBERSHIP_INACTIVE`).
   - Add a parity test: for the same fixtures, the guard and `checkSellerPublicationRequirements` agree on those three requirements.

7. **Task 3, `startConversationAction` already has the approved-only gate.** *Plan says:* add `assertListingStartable` → `LISTING_NOT_CONVERSATIONABLE` on the create branch. *Real:* `src/lib/actions/chat.ts:43-45` already does `if (listing.status !== "approved") throw new Error("LISTING_NOT_AVAILABLE")` after the existing-conversation lookup (`:28-35`). That was b4-holistic round-3. It is pinned by:
   - `tests/unit/chat-pages.test.ts:55-63` (source: the literal `listing.status !== "approved"` must come after `const existing = await db.orm.public.Conversation`, and `"LISTING_NOT_AVAILABLE"` must be present);
   - `tests/unit/chat-guard.test.ts:430-473`;
   - `tests/unit/telemetry-wiring.test.ts:1012-1019`.

   Batch 5 already emits `conversation_started` only on this approved create path (`chat.ts:53-64`). *Correction:*
   - Keep the inline check and the `LISTING_NOT_AVAILABLE` code; do not call `assertListingStartable` in `chat.ts`.
   - Insert, after `:45` and before `Conversation.create` (`:47`): `checkRateLimit("chat:start:"+user.id, CONVERSATION_START_RATE)` → `RATE_LIMITED`, then `assertListingSellerInteractable(listing.sellerId)`.
   - Keep `recordConversationStarted` before `` redirect(`/chat/${convo.id}`) `` (source pin `telemetry-wiring.test.ts:1610-1618`).
   - In `chat-hardening.test.ts`, use `LISTING_NOT_AVAILABLE` for the status table.
   - `CONVERSATION_STARTABLE_LISTING_STATUSES` / `assertListingStartable` may stay in deal-vocab/deal.ts for the drift test (or be dropped). `DEAL_CREATE_LISTING_STATUSES` and `LISTING_NOT_DEALABLE` for Deal creation are unaffected.
   - Rewrite the A2 comment at `chat.ts:20-24`.

8. **Task 3 (B1), fixture migrations, corrected per file.** v1 was wrong about suspension-enforcement.
   - **`tests/unit/chat-guard.test.ts`.** The db mock at `:226-237` has User, Listing, Conversation, Message, UserBlock, UserSuspension and Notification, but **no `SellerVerification` and no `BetaCohortMembership`**. Add both stores and models, and seed verified + active `founding_seller` rows for `SELLER` in `beforeEach` (`:359`). Cases that reach the create branch: `:401-413` (the superseded pin, now `SELLER_SUSPENDED`, no Conversation), `:415-427` (happy path), `:464-472` (approved). Update the header contract at `:16-22`. The POST case "recipient suspended → still delivers" (`:509`) is unchanged.
   - **`tests/unit/telemetry-wiring.test.ts`.** The models already exist (`:428-440`) and so does the helper `seedPolicyRows` (`:603`). Only add `seedPolicyRows(SELLER.id)` to the `startConversationAction` describe's `beforeEach` (`:938-940`).
   - **`tests/integration/block-enforcement.test.ts`.** `mkUser` creates bare users (`:73-82`), and `:278` expects `NEXT_REDIRECT` after unblock, which will fail with `SELLER_NOT_VERIFIED`. Seed `SellerVerification(status "verified", method "operations_review", policyVersion "v1")` and `BetaCohortMembership(founding_seller, active)` for the sellers at `:211`, `:292` and `:354`. In `afterEach` (`:169-190`), delete `SellerVerification` before `User`: its relation has no `onDelete` (`src/prisma/contract.prisma:855`). Membership cascades.
   - **`tests/integration/suspension-enforcement.test.ts`.** Only the actor `sellerX` is seeded (`:271`). The listing owner `sellerY` (`:272`) is bare, so the post-lift create at `:384-386` (`NEXT_REDIRECT`) breaks. Call `seedSevenRequirements(sellerY)` (helper at `:98-123`). `cleanupUser` (`:204-216`) already deletes `SellerVerification` and membership.

9. **Task 3, chat POST must keep Batch 5's position-based detection.** *Real:* `app/api/chat/[id]/route.ts:116-175` decides first-message/first-response by position (`createdAt asc, id asc`) inside its own try/catch (b5-review fix 3, `e1e0900`). It is pinned by the telemetry-wiring D4 describe at `:1026` (includes a concurrent double-POST). The current body parse at `:99-103` is unguarded `request.json()`. *Correction:*
   - Replace only `:99-103` with the S4 parse, the type checks, the 2000-char cap, and the `LISTING_IMAGE_URL_PATTERN` (`src/lib/listing-images.ts:44-45`) + `ListingImageUpload` ownership check.
   - Keep these in their current order: `assertCanSendMessage` → 403 mapping (`:88-97`), then `Message.create` (`:105`).
   - Keep the telemetry block and the dynamic `await import("@/src/lib/notify")` (`:178`) verbatim. GET (`:13-64`) stays unchanged.
   - Recorders take no `sessionId` in this route; leave them as they are.

10. **Tasks 4/5, the deal event schemas are empty strict objects today.** *Plan says:* "Batch 5 shipped these schemas minimal — Batch 6 adds typed keys." *Real:* `src/lib/product-events.ts:179-183` defines `deal_created`, `deal_outcome_marked`, `successful_match` and `listing_marked_sold` as `z.strictObject({})`. **Any** metadata key (including `dealId`) is rejected as `TELEMETRY_SCHEMA_REJECTED`, no row is written, and the call fails open silently. *Correction:*
    - Extend all four schemas in the Task 4 commit: `dealId: z.uuid()`, `fulfillmentMethod: z.enum(...).nullish()`, `outcome: z.enum(DEAL_OUTCOMES)`, `role: z.enum(["buyer","seller"])`. Import the vocab from client-safe `deal-vocab.ts` or `listing-schema.ts`.
    - Keys must not match the denylist test (`tests/unit/product-events.test.ts:488-500`) or the banned regex `/query|text|body|message|note|email|phone|address|name/i` (`:547-557`). Never add `note`/`reason`/`price` keys.
    - Do not add event names: the 20-event taxonomy is pinned at `:507-509`.
    - The Task 4/5 unit tests must assert that a `ProductEvent` row exists with that metadata, not just that the spy was called. A spy test would pass while the real emit is rejected.

11. **Task 4, unique-violation classification.** *Plan says:* `e instanceof SqlQueryError && e.sqlState === "23505" && e.constraint?.startsWith("deal_one_open_per_listing_buyer")`. *Real precedent:* `SqlQueryError.is(e)` with `sqlState`/`constraint` prefix (`src/lib/actions/moderation.ts:269-281`), or `isUniqueConstraintViolation(e)` (`src/lib/actions/appeals.ts:5,137-139`). Rendered index names carry a hash suffix (e.g. `user_suspension_one_active_c770076c` in the batch3 `ops.json`). *Correction:*
    - Use `SqlQueryError.is(e)`, not `instanceof`, and keep the **prefix** match.
    - Classify outside `db.transaction` only (Postgres aborts the tx after the violation; never catch inside the callback).
    - Tests throw `new SqlQueryError(msg, { sqlState: "23505", constraint: "deal_one_open_per_listing_buyer_xxxxxxxx" })` (`tests/unit/listing-actions-images.test.ts:804`, `tests/unit/report-actions.test.ts:286`).

12. **Task 5, `updateAll` returns the row array, not a count.** *Plan says:* `claimed === 0`, `completed > 0`, `sold > 0`. *Real:* `const claimed = await tx…updateAll(…); if (claimed.length === 0)` (`src/lib/actions/moderation.ts:486-494`; also `listings.ts:658/902`, `admin.ts:179/305`). *Correction:* use `.length === 0` / `.length > 0` everywhere. Unit mocks' `updateAll` must return arrays (`chat-guard.test.ts:188-192` pattern).

13. **Task 5, NULL matching.** *Plan says:* `.where({ id: dealId, [roleOutcomeAt]: null })`. *Real:* NULL matches only through `isNull()`, and `{ field: null }` is wrong in Prisma 8 (`src/lib/actions/moderation.ts:483-492`). *Correction:* write one branch per role, e.g. `.where({ id: dealId }).where((d) => d.buyerOutcomeAt.isNull()).updateAll({ buyerOutcomeAt: now })`, and the same for the seller. Do not use a computed key.

14. **Tasks 4/5, refreshing the conversation page after an action.** *Plan says:* no revalidation (form-state return only). *Real:* every repo action uses `revalidatePath` from `next/cache`, and every test mock of `next/cache` defines only `revalidatePath`. `refresh()` exists (`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/refresh.md`) but would need every mock changed. *Correction:* after commit, call `` revalidatePath(`/chat/${conversationId}`) `` (plus `` `/listings/${slug}` `` when `soldClaimed`) so the server-rendered DealPanel updates. Only call it after the transaction.

15. **Task 6, the DealPanel must respect chat-page redaction, and the select is pinned.** *Real:* `app/chat/[id]/page.tsx:43-48` computes `listingVisible` (seller, or status approved/hidden/sold) and redacts title/image/price otherwise. `tests/unit/chat-pages.test.ts:30-43` pins the exact select `l.select("id", "title", "slug", "price", "status", "acceptExchange")` (`:25-27`), `{listing && listingVisible && (` and the placeholder. *Correction:*
    - Do not change that select.
    - Pass DealPanel `listing = listingVisible ? { id, title, status } : null`. A non-visible listing renders status-only, with no title.
    - Show the create form only when the viewer is the buyer and `listing.status === "approved"`.
    - Use `convo.buyerId`/`convo.sellerId` for `viewerRole`.
    - Load the deal with `Deal.where({ conversationId: convo.id }).orderBy((d) => d.createdAt.desc()).first()` (S11).

16. **Task 6, listing-page CTA: anonymous visitors, the behavioral render test, and pins.** *Plan says:* gate the CTAs on `user && sellerEligible`. *Real:* `app/listings/[slug]/page.tsx:366` is `listing.status === "approved" && !isOwner`, so anonymous visitors see "Nhắn người bán". `tests/unit/sell-pages.test.ts:948-954` **renders** an approved listing for an anonymous visitor with a db mock (`:148-210`) that has no `UserSuspension`, `SellerVerification` or `BetaCohortMembership`; a D12 eligibility call would throw a TypeError. *Correction:*
    - Do not add `&& user`.
    - Compute eligibility with try/catch that maps **only** the typed `SELLER_*` codes to "ineligible" and rethrows anything else. A bare catch-all would hide infra errors.
    - Extend `sell-pages.test.ts`'s db mock with those three models (plus eligible seller rows) and add the file to the Task 6 commit as a recorded earlier-batch fixture edit.
    - Keep these pins:
      - `finance-public-surface.test.ts:146,178-186,231` ("Nhắn người bán", `startConversationAction`, "không giữ tiền");
      - `listing-draft-actions.test.ts:705,710`;
      - `telemetry-wiring.test.ts:1602-1608`;
      - the safety hint at `:327-329` and the disclaimer at `:375-378`, both pinned by copy-safety after the Batch 8 merge.

## NON-BLOCKING

17. **Task 3, the wishlist part is already done.** `src/lib/actions/wishlist.ts:24-47` (b4-holistic-2) already refuses adds on non-approved listings and allows removal in any status. This is pinned by `tests/unit/wishlist-actions.test.ts:246-310`. `app/wishlist/page.tsx` redacts non-public rows (`tests/unit/wishlist-page.test.ts:263-372`). Drop `wishlist.ts` and the wishlist tests from Task 3 files and commit. Drop v1 item 18 and the plan's Task 8 residual "pre-existing wishlist rows … remain visible" (they now render as a placeholder).

18. **Task 6, copy-safety (absent here; activates after the early-Batch-8 merge).** `tests/unit/copy-safety.test.ts` on `local/b8-early-integration`:
    - `SAFETY_64_POINTS` (`:331-338`) and `SAFETY_52_LINE` (`:341`) are byte-identical to the plan's Task 6 strings. Copy them verbatim.
    - The component check auto-activates when `src/components/safety-guidance.tsx` exists (`:366-385`).
    - The scope walk covers every `app/**.tsx`, `src/components/**.tsx` and `src/content/**.ts` (`:76-79`) with `PROMISE_PATTERNS` (`:171-180`). Only two negations are allowlisted (`:188-206`, e.g. the exact `LoaViet không giữ tiền và không bảo đảm giao dịch`).
    - Only whole-line comments are stripped (`:150-156`). So no new `.tsx` (deal-panel, the forms, safety-guidance) may contain `đảm bảo|bảo đảm|bảo hiểm|bảo vệ thanh toán|bảo vệ giao dịch|escrow|guarantee|insurance` outside that exact negation, and that includes trailing comments.
    - Do not create `src/content/policies/safety-guidance.ts`; Batch 8 owns it.
    - Keep the plan's `deal-ui.test.ts` scan; it is the only copy scan until the merge.
    - Re-run copy-safety after the merge.

19. **Task 8 Step 2 rg.** `rg MODERATION_LOCKED_LISTING_STATUSES src/lib/actions/listings.ts` must return **0** hits. Absence is pinned at `tests/unit/listing-lock.test.ts:1026` and `tests/unit/publication-gate.test.ts:1433`. The R5 guard is `isModerationLocked` (`src/lib/moderation-vocab.ts:166`).

20. **Tasks 2/6, fulfillment vocabulary.** Reuse `LISTING_FULFILLMENT_METHODS` (`src/lib/listing-schema.ts:42-47`; client-safe: zod + provinces + type import) and `FULFILLMENT_METHOD_LABELS` (`src/lib/constants.ts:145-150`). Drift-test that `DEAL_FULFILLMENT_METHODS` equals it. Drop `DEAL_FULFILLMENT_METHOD_LABELS` from the Task 6 constants.

21. **Task 2 / D5, source of the price bound.** The real bound is `PRICE_MIN = 100_000` / `PRICE_MAX = 2_000_000_000` in `src/lib/listing-schema.ts:91-92` (unexported), not `listings.ts`. Duplicate the values in `deal-vocab.ts` with a source-regex drift test. Do not edit `listing-schema.ts`. Fix the D5/A5 wording.

22. **Tasks 4/5, notifications.** `notify` (`src/lib/notify.ts:5-19`) throws on db error. After commit, wrap it in try/catch following `src/lib/actions/moderation.ts:292-305`. Pass a **string code**, not the error object: `captureError` logs `error.message` + stack (`src/lib/observability-core.ts:18-31`; Batch 5 correction #17), so use `captureError("deal", "DEAL_NOTIFY_FAILED", { sqlState })`.

23. **Task 5, PII in history.** Never copy free-text `cancellationReason` into `DealStatusHistory.note`; keep the typed `<role>:<outcome>`. The reason lives only in `Deal.cancellationReason`. If text must be kept, use `redactDetail` (`src/lib/audit-event.ts:163`). This also keeps the idempotency prefix match exact.

24. **Tasks 1/7, append-only proof for `DealStatusHistory`.** `tests/unit/audit-append.test.ts:838-882` (per-statement scan of `src/` + `app/`) is an earlier-batch file; do not edit it. Copy the algorithm into a Batch 6 test (`deal-finance-isolation.test.ts` or `deal-domain.test.ts`) with `MODELS = ["DealStatusHistory"]` and ops `.update( .updateAll( .delete( .deleteAll(`. This works only if `seed.ts` does not delete `DealStatusHistory` explicitly (item 4: rely on Cascade).

25. **Tasks 4/5, emission API confirmed.**
    - `emitProductEvent(input: ProductEventInput)` (`src/lib/product-events.ts:392-414, 430-530`) takes the **raw** `sessionId` (`SessionUser.sessionId`, `src/lib/session.ts:69`), never a pseudonym. `actorId` is raw too; the core HMACs both.
    - It never throws (schema/PII → reject + log; key/db → fail-open; a missing key outside production is a silent no-op).
    - Call it only after `await db.transaction(…)` resolves (`src/lib/telemetry-recorders.ts:21-24`). Do not wrap it in try/catch.
    - Calling it directly from `deals.ts` is fine. Q5 forbids editing `telemetry-recorders.ts`, and the current call sites are `product-events.ts`, `search-telemetry.ts` and `telemetry-recorders.ts`.
    - `deal-lifecycle` must `vi.stubEnv("PRODUCT_EVENT_PSEUDONYM_KEY", …)` because `scripts/test-integration.sh:58-61` sets only `DATABASE_URL`. The key cache is keyed by the raw value (`src/lib/product-event-key.ts:48,77`), so stubbing is safe.

26. **Tasks 5/8, metrics expectations and the `successful_match` actor.**
    - The engines read only `name` and `isInternal`, never deal metadata. `successfulMatchCount` is at `src/lib/metrics.ts:392-398`; `listingMarkedSoldCount` is at `app/admin/analytics/page.tsx:250-252` and does not exclude internal actors.
    - `successful_match_rate_v1` stays PENDING (A2) in `src/lib/metric-contracts.ts:257-281`.
    - No change to `metrics.ts`, `metric-contracts.ts` or the dashboard. The honest-zero counts simply become live. `analytics-dashboard.test.ts:334-340` and `metrics-reconciliation.test.ts:628-660` stay green.
    - Fixtures model the `successful_match` actor as the **buyer** (`metrics-reconciliation.test.ts:638-640`), and internal exclusion keys off the emitting actor. Recommended: emit `successful_match` with `actorId: deal.buyerId`, and pass `sessionId` only when the caller is the buyer (otherwise null). Record this as a decision; once-per-deal comes from the atomic claim.

27. **Rollback text.** The plan's "reversible per-deal by an ops `UPDATE` documented in the verification doc" bypasses §4.6 audit. Record it as a Batch 8 register item (FD-R27 / RR-23); do not document it as a procedure.

28. **Task 7, facts confirmed.**
    - A BFS over static, dynamic and re-export imports from `chat.ts`, `app/api/chat/[id]/route.ts`, `wishlist.ts`, `auth.ts`, `seller-verification-policy.ts`, `product-events.ts`, `listing-images.ts`, `utils.ts`, `constants.ts`, `moderation.ts`, `app/chat/[id]/page.tsx` and `app/listings/[slug]/page.tsx` reaches **no** finance module today.
    - The denylist files all exist (`src/lib/actions/{helpers,withdraw,cart,reviews,orders,offers,exchange}.ts`).
    - There are exactly two `Conversation.create` sites: `src/lib/actions/chat.ts:47` and `src/lib/actions/exchange.ts:72` (guarded at `:26`).
    - The route's notify is a dynamic `await import(...)` (`route.ts:178`), so the walker must parse dynamic imports.

29. **Task 3/8, residual for chat images.** `scripts/cleanup-uploads.ts:16,92-95` treats only `ListingImage.url` as "attached". An upload referenced only by `Message.imageUrl` would be deleted by `--apply`. `ChatWindow` never sends `imageUrl` (`src/components/chat-window.tsx:71`). Record this as a residual in the verification doc; no code change.

30. **Prisma 8 / Next 16 details for Tasks 4–6.**
    - Inside `db.transaction`, use only `tx.orm.public.*`. All guards (`isUserSuspended`, `getBlockState`, `assertCanStartConversation`, `assertListingSellerInteractable`), `notify` and `emitProductEvent` use the global `db`, so call them only outside the tx.
    - `orderBy` syntax is `.orderBy((h) => h.createdAt.desc())`; add an `id` tie-break for "latest history row by actor".
    - Run no guards inside the tx and catch no constraint errors inside it.
    - `deals.ts` is `"use server"` with async-only exports; `DealFormState` is a type export.
    - `redirect()` must never be called inside a catch.
    - The chat page is `force-dynamic` (`app/chat/[id]/page.tsx:12`).

31. **Task 6 / D12, compact create CTA.** On the listing page, `createDealAction` returns `DEAL_CONVERSATION_REQUIRED` when no conversation exists, which makes the compact button useless until then. Render `<DealCreateForm variant="compact">` only for a logged-in non-owner who has an existing `Conversation.where({ listingId, buyerId: user.id }).first()`. "Nhắn người bán" stays for everyone, including anonymous visitors (item 16).

32. **Task 8 verification doc.** It must record:
    - the 8-dir `migration list` shape and the production-ref invariant restore (items 1–2);
    - the earlier-batch test edits (items 3, 8, 16) with the statement that no assertion was weakened;
    - the D2 supersession;
    - the items 26 and 29 residuals;
    - the dropped wishlist residual (item 17);
    - the ops-alerts and copy-safety merge actions (items 5 and 18).

## v1 → v2 mapping
- v1#1 → item 5 (file not in tree; merge-time).
- v1#2 → item 12 (refs refreshed).
- v1#3 → item 13.
- v1#4 → item 11 (now `.is()` + hash-suffix prefix).
- v1#5 → item 6 (delegation-safe variant).
- v1#6 → item 8 (suspension-enforcement claim was wrong; per-file fixes).
- v1#7 → item 16 (plus the sell-pages render test).
- v1#8 → item 18 (non-blocking; test not in tree).
- v1#9 → item 14 (`revalidatePath`, not `refresh`).
- v1#10 → item 19 (refs refreshed).
- v1#11 → item 20.
- v1#12 → item 22.
- v1#13 → item 23 (`redactDetail` moved to :163).
- v1#14 → item 4 (Cascade, no DealStatusHistory statement).
- v1#15 → item 24 (own test; audit-append untouched).
- v1#16 → items 7 + 8 (approved-only already in code; telemetry-wiring models already present).
- v1#17 → item 27.
- v1#18 → dropped (item 17).
- v1#19 → item 1 (real head `1350a596…`, real dir).

## Parallelism map (file-disjoint)

- **Wave 1.**
  - **T1:** `src/prisma/contract.prisma`, `contract.json`, `contract.d.ts`, `migrations/app/<ts>_batch6_chat_deal`, `migrations/snapshots`, `migrations/app/refs/{db,production}.json` (invariant restore), `src/prisma/seed.ts`, `tests/integration/batch6-migration.test.ts`, `tests/unit/approved-content-backfill-migration.test.ts`, `tests/integration/batch5-migration.test.ts`. It also takes `scripts/ops-alerts.ts` + `docs/operations/monitoring-signals.md` only if early Batch 8 has merged.
  - **∥ T2:** `src/lib/deal-vocab.ts`, `src/lib/deal.ts`, `tests/unit/deal-domain.test.ts` (can include the item 24 scan). T2 does not reference the Deal tables, so it may run before T1 lands. Typecheck after both.
- **Wave 2** (after T2; T4 also needs T1):
  - **T3:** `src/lib/actions/chat.ts`, `app/api/chat/[id]/route.ts`, `tests/unit/chat-hardening.test.ts`, `tests/integration/chat-hardening.test.ts`, `tests/unit/chat-guard.test.ts`, `tests/integration/block-enforcement.test.ts`, `tests/integration/suspension-enforcement.test.ts`, `tests/unit/telemetry-wiring.test.ts`. No `wishlist.ts`.
  - **∥ T4:** `src/lib/actions/deals.ts`, `src/lib/product-events.ts`, `tests/unit/deal-create.test.ts`, `tests/unit/product-events.test.ts` (extend only).
  - **∥ T6a:** `src/components/safety-guidance.tsx`, `src/lib/constants.ts` (deal status/outcome labels only).
- **Wave 3.** T5 (`deals.ts`, `tests/unit/deal-outcome.test.ts`, `tests/integration/deal-lifecycle.test.ts`; after T4) ∥ T3/T6a if still running.
- **Wave 4.** T6b (after T4 + T5 + T6a): `src/components/deal-panel.tsx`, `deal-create-form.tsx`, `deal-outcome-form.tsx`, `app/chat/[id]/page.tsx`, `app/listings/[slug]/page.tsx`, `tests/unit/sell-pages.test.ts`, `tests/unit/deal-ui.test.ts`.
- **Then** T7 (`tests/unit/deal-finance-isolation.test.ts`) → T8 (verification doc). After the early-Batch-8 merge: re-run copy-safety + ops-alerts (items 5 and 18).
- **Shared-file serialization:**
  - `deals.ts`: T4 → T5.
  - `product-events.ts`: T4 only (all four schemas).
  - `constants.ts`: T6a only.
  - `telemetry-wiring.test.ts`: T3 only.
  - `sell-pages.test.ts`: T6b only.
  - Integration suites share the scratch DB, so run `npm run test:integration` serially per wave.
