# Private Beta Batch 7 — Cohort + Founding Seller Operations Gate Verification (Task 8)

**Date:** 2026-10-08
**Plan:** `docs/superpowers/plans/2026-10-06-private-beta-batch-7-cohort-operations.md` (Task 8 + Acceptance Gate + Final Acceptance Commands)
**Corrections (mandatory, applied — override the plan):** `docs/superpowers/plans/2026-10-08-private-beta-batch-7-plan-corrections.md` (v2 — every item applied; the conditional items 6/33 activate at the early-Batch-8 merge, recorded in §11)
**Spec:** `docs/superpowers/specs/2026-10-06-private-beta-marketplace-reset-design.md` — §9 Batch 7 + Gate, §2.1, §4.5–§4.11, §5.10/§5.10.1, §7.1/§7.3/§7.6/§7.8, §8.4, §10/§10.1, §12.1/§12.3
**Worktree:** `Speaker Platform-worktrees/batch7-implementation` (branch `opencode/batch7-implementation`)

> ## ✅ OVERALL VERDICT: **GATE PASS**
>
> Every spec §9 Batch 7 gate item, every plan source scan, the full preflight
> (7/7), the integration suite (33 files / 279), safe smoke, the migration
> review, `npm audit --omit=dev` (0), and the diff/status audit are green on
> the final state (`b3b0871` + this doc). The one confirmed Task 5 review
> finding (LOW — supply-readiness counts) is closed **in this task** (§6).
> Per FD-3, the recorded ambiguities and decisions ship as their safe /
> fail-closed defaults now; **beta-launch readiness additionally requires the
> founder-authored/acknowledgment items in the Batch 8 Founder Decision
> Register** (§11) — **P1 above all: production invite acceptance is
> unreachable until the FD-2 OTP provider exists** (or the founder accepts
> token possession + out-of-band delivery as channel proof), A1 invitation
> delivery, A2 Scoped-PII semantics, A3 the quality-listing definition, A4
> buyer acquisition per §12.1, D3 the buyer-chat default, and the PROVISIONAL
> vocabulary — **those are launch prerequisites, not Batch 7 gate failures**
> (plan Final Acceptance Commands, verbatim).

---

## 1. Commits and executor metadata

**Base:** `da31a5b` — `fix(deps): bump next and eslint-config-next to 16.3.8`
(the merged Batch 6 tree; Batch 6 gate commit `5c10813` `test(batch6): verify
chat and deal gate`, verification doc
`docs/operations/private-beta-batch6-chat-deal-verification.md`). Batch 7
executed on the merged Batch 6 commit per T1 — verified at Task 1 Step 0 (both
refs == `292dd3fb…`, the `to` of `20261008T0237_batch6_chat_deal`, corrections
item 1).

**Final state verified:** `b3b0871` + this doc's commit (Task 8).

```
$ git log --oneline da31a5b..HEAD   (at gate verification; + this doc commit after)

b3b0871 fix(admin): live supply-readiness counts on the cohort console   ← Task 8 review fix (§6)
2cc79a9 test(cohort): prove suspended membership enforcement across gates  (T7 — cherry-picked; original 579c999)
85385b5 feat(admin): founding seller console and concierge tracking       (T5)
69a5697 feat(cohort): founding seller lifecycle actions                   (T4)
0c8d333 fix(cohort): fail-open funnel sync after invite acceptance        ← Task 3 review fix (§6)
9b9cd4f feat(cohort): buyer beta access policy on new conversations and deals  (T6)
0753564 feat(cohort): founding seller invitation flow                     (T3)
2d02913 refactor(cohort): typed FoundingSellerCandidate access after task 1 merge  ← Task 2 review fix (§6)
32730e3 feat(cohort): founding seller domain module                       (T2)
4e44bc5 feat(db): add batch 7 cohort operations contract                  (T1)
25e99a5 docs(plan): batch 7 corrections against the post-Batch-6 tree
```

Task feature commits (the plan's exact messages): `4e44bc5` (T1), `32730e3`
(T2), `0753564` (T3), `69a5697` (T4), `85385b5` (T5), `9b9cd4f` (T6),
`2cc79a9` (T7 — cherry-picked from the parallel worktree, original `579c999`)
— plus `25e99a5` (the corrections doc) and the three review-fix commits
`2d02913` + `0c8d333` + `b3b0871` (§6). **Every task was implemented in its
own session/worktree per the corrections parallelism map and independently
reviewed (2-skeptic adversarial verification) before merging here — all
approved; the per-task reports are in `/tmp/loaviet/batch7-task{1..7}-report.md`
+ `/tmp/loaviet/batch7-plan-report.md`.**

**OpenCode metadata:** model `home-gateway/OneNexus/glm-5.3` (OneNexus GLM
5.3), session in this worktree — "Batch 7 Task 8: gate verification +
verification doc". No push / merge to main / deploy / subagents at any point;
every `git add` listed explicit paths (bracketed paths quoted —
`'app/invite/[token]/route.ts'`); nothing staged from `.superpowers/`,
`.claude/`, `public/uploads/`, `data/uploads/`, secrets, or scratch.
`package.json` + `package-lock.json` untouched across the whole batch (Batch 7
adds zero npm packages; the `da31a5b` bump beneath it predates Batch 7).

---

## 2. Gate-suite results (Step 1 — all green, run 2026-10-08 on `b3b0871`)

The five spec §9 Batch 7 gate items mapped to the plan's named suites
(verbatim mapping from Task 8 Step 1):

| # | Gate item (spec §9 Batch 7) | Suite | Result |
|---|---|---|---|
| 1 | **Seller cohort authorization** (page guard + nav filtering + masked contact + no reveal action + no-write-in-render; moderator/support/analyst/non-admin → FORBIDDEN on every action; `beta_cohort.manage` is Batch 2's matrix, unchanged; no step-up invented) | `tests/unit/beta-cohort-console.test.ts` + `tests/unit/founding-seller-lifecycle.test.ts` + `tests/unit/founding-seller-invite.test.ts` | **PASS 45 + 75 + 70** |
| 2 | **Invite acceptance** (single-use atomic claim, expiring, unguessable 256-bit tokens stored only as keyed HMAC, enumeration-safe byte-identical `INVITE_INVALID`, channel binding matching **and verified** email/phone from a fresh `User` row, membership upsert semantics, suspended-account refusal §7.3, rate limits §7.1, revocation + re-issue, transaction sentinels with no silent-success commit, acceptance → `BetaCohortMembership(founding_seller, active, acceptedAt)` → candidate `registered`) | `tests/unit/founding-seller-invite.test.ts` + `tests/integration/founding-seller-invite.test.ts` | **PASS 70 + 8 (real DB)** |
| 3 | **Suspended membership enforcement** (all **five** publication transitions blocked — create/update/toggle/submit/admin-approve with `listing.approve_blocked` audit, corrections #30; new conversations **and** Deals on the seller's listings blocked `SELLER_MEMBERSHIP_INACTIVE` (Batch 6 D2 re-proven); the member as buyer blocked `BETA_MEMBERSHIP_REQUIRED` (Task 6); live listings stay readable/searchable; every gate reopens on re-activation) | `tests/unit/suspended-membership-enforcement.test.ts` + `tests/integration/suspended-membership-enforcement.test.ts` | **PASS 21 + 2 (real DB)** |
| 4 | **Seller cohort + verification publication requirement** (the Batch 2 eight-requirement gate incl. `founding_seller_membership_active` + `account_not_suspended`; the integration case proving the requirement flips from missing to satisfied exactly at invite acceptance) | `tests/unit/publication-gate.test.ts` + `tests/unit/seller-verification-policy.test.ts` + `tests/integration/founding-seller-invite.test.ts` (the flip case) + `tests/integration/suspended-membership-enforcement.test.ts` (suspend → missing exactly that one; reactivate → `{ok:true}`) | **PASS 80 + 32 + integration** |
| 5 | **Cohort telemetry** (`seller_invited` issuance actor null; `seller_registered` acceptance actor = user; `beta_membership_activated` **only** on `activated: true` paths — Batch 5 S7 semantics; all through Batch 5's `emitProductEvent` with per-event schema validation, pseudonymized actors, zero contact-reference PII; the Batch 5 suites stay green with migrated fixtures) | `tests/unit/product-events.test.ts` + `tests/unit/telemetry-wiring.test.ts` + the Task 3 emission cases in `founding-seller-invite.test.ts` + `tests/integration/founding-seller-invite.test.ts` (the §4.8 no-contact-in-`ProductEvent` scan) | **PASS 52 + 50 + emission cases + integration** |

Buyer beta access policy (Task 6, the §2.1 leg of gate items 2–3):
`tests/unit/beta-access.test.ts` **20** + `tests/unit/chat-beta-gate.test.ts`
**11** + `tests/unit/deal-beta-gate.test.ts` **10** +
`tests/integration/beta-access-enforcement.test.ts` **5 (real DB)** — the
guard order (Batch 3 actor-side → Batch 6 seller-side D2 → Batch 7 buyer-side)
pinned, the existing-conversation redirect branch ungated, the POST message
route ungated, `markDealOutcomeAction` deliberately ungated (Batch 6 D10/D2).

Domain module (Task 2): `tests/unit/founding-sellers.test.ts` **38** — the ten
§5.10 statuses verbatim, the transition table (incl. `inactive → exited` only,
A5), `MANUALLY_SETTABLE_STATUSES`, `maskContact` fixed-width (corrections #34),
the funnel-sync ground-truth matrix (only-advance, idempotent, ops-states
skipped, `{from,to,changed}` semantics per corrections #22),
`approvedListingCountOf`, `candidateNeedsAssistance` (D2).

Full-suite context (every earlier batch stays green — Q1/S1):

| Command | Result |
|---|---|
| `npm test` (full unit) | **PASS — 101 files / 2305 tests** (Batch 1 finance shutdown, Batch 2 identity/security — `admin-page-guards.test.ts` auto-enumerates `/admin/beta-cohort` and passes; `rbac.test.ts` 23 green, matrix unchanged — Batch 3 trust/safety, Batch 4 listing quality, Batch 5 search/telemetry, Batch 6 chat/Deal, all Batch 7 suites; 2299 at the pre-Task-8 head + the 6 tests of the §6 fix) |
| `npm run test:integration` (`scripts/test-integration.sh`, scratch container, migrate `--to production`) | **PASS — 33 files / 279 tests** (incl. `batch7-migration` 17 — the §8.4 delta case + the ops-package contract + the partial-index 23505s; `founding-seller-invite` 8; `beta-access-enforcement` 5; `suspended-membership-enforcement` 2; all Batch 1–6 suites incl. `escrow`, the migrated `block-enforcement`/`suspension-enforcement`/`chat-hardening`/`deal-lifecycle`; migration applied 9 migrations `@empty → production`, invariant `backfill-listing-approved-content-at` **satisfied** — the hand-restored `refs/production.json` invariant held through the path walk; container cleaned up) |
| `npm run lint` | **PASS** — 0 errors, 0 warnings |
| `npx next typegen` + `npx tsc --noEmit` | **PASS** — clean |
| `npm run build` | **PASS** — exit 0, `✓ Compiled successfully`, 15/15 static pages, TypeScript clean; `/invite` + `/invite/[token]` + `/admin/beta-cohort` in the route manifest; **1 pre-existing warning only** (`instrumentation.ts:27` `process.exit` Edge Runtime — Batch 2 commit, untouched by Batch 7) |
| `npm run preflight` | **PASS — 7/7 gates** (contract-emit-drift, lint, typecheck, unit-tests, production-build, compose-config, migration-graph) |
| `npm run smoke` | **SMOKE PASS** — production standalone server on scratch DB: health `200 db=up`, `/api/chat` unauthenticated 401, every finance entry point typed-denied (`FINANCIAL_FEATURES_DISABLED`), 9 retired finance pages 404, cron wrong-secret 401 / correct-secret 503 typed, momo return 500 unavailable, uploads headers + traversal 404s |
| `npm audit --omit=dev` | **0 vulnerabilities** (the Batch 6 doc's 1 pre-existing `next@16.3.7` high is resolved by the pre-batch `da31a5b` bump to 16.3.8 — inherited hygiene, no Batch 7 dependency change) |
| `npx prisma migration list` | **Linear graph, 9 migrations**: `baseline → batch2 → batch3 → batch4_listing_quality → batch4_holistic_review_fixes → batch4_round4_approved_content_backfill (self-edge, provides the backfill invariant) → batch5_search_telemetry → batch6_chat_deal → batch7_cohort_operations`; the batch7 head `656449ac…` carries refs `[db, production]`; exactly one edge out of `292dd3fb…` (corrections item 1's expected shape) |
| `npx prisma db verify` (dev DB, container `speaker-postgres` :5435) | **ok: true, mode: full** — marker + schema match contract `656449ac…` |
| `git diff --check` + `git status --short` | clean; only the Task 8 files — no `.claude/settings.json`, no `public/uploads/`, no secrets, no scratch, `package-lock.json` untouched |

---

## 3. Backend-enforcement + privacy source scans (Step 2 — every hit classified)

`rg` (ripgrep) at the repo root, run 2026-10-08 on `b3b0871`. The plan's scans
(paths amended per corrections #7 — the landing is `app/invite/[token]/route.ts`,
not `page.tsx`; the cookie constants live in the domain module per corrections
#12):

| # | Scan | Expected | Actual — classified |
|---|---|---|---|
| S1 | `requireCapability` in `src/lib/actions/founding-sellers.ts` + `app/admin/beta-cohort` | every privileged action/page's first guard | **14 hits, all guards**: the page guard `page.tsx:47` **before any db read** (pinned by test); 9 action call sites (`createCandidateAction`/`inviteCandidateAction`/`revokeInviteAction`/`acceptInviteAction` excluded — it uses `getCurrentUser`, the invitee is not admin/`syncCandidateFunnelAction`/`updateCandidateStatusAction`/`assignCandidateOperatorAction`/`recordCandidateContactAction`/`updateCandidateNotesAction`/`updateQualityListingCountAction`) + import/doc lines. ✅ |
| S2 | `beta_cohort.manage` in `src/lib/rbac.ts` | Batch 2 matrix unchanged — Batch 7 added no capability | **3 hits**: the `Capability` union `:40`, `super_admin` `:66`, `operations_admin` `:82` — byte-identical Batch 2 cells; `rbac.ts` touched by **zero** Batch 7 commits. ✅ |
| S3 | `STEP_UP_CAPABILITIES` in `src/lib/rbac.ts` | unchanged (no cohort step-up invented) | **4 hits**: the definition `:170` (Batch 2/3 list — `beta_cohort.manage` NOT in it) + doc/usage lines. No step-up invented. ✅ |
| S4 | `contactReference` in `app/admin` + console/forms | only maskContact call sites — no raw render | **4 hits**: the client create-form **input field** (`founding-seller-forms.tsx:113` — the form posts it, never renders stored values), the view-model **type field** (`console.tsx:56` — "RAW chỉ đến tay component SERVER này… render luôn qua maskContact"), the **masked render** `maskContact(row.contactChannel, row.contactReference)` (`console.tsx:232`), the page's view-model assignment (`page.tsx:102`). Zero raw render — pinned behaviorally (element-tree: raw contact never appears). ✅ |
| S5 | `token` in `src/lib/actions/founding-sellers.ts` minus `tokenHash\|BetaInviteToken\|inviteUrl` | classify every hit — no raw-token log/audit/telemetry | **~40 hits, all classified**: doc comments (mechanics); the raw `token` variable (`:285` `randomBytes(32)` generation → flows only into `betaInviteTokenHash` HMAC + the one-time `inviteUrl` state; `:453-455` cookie read → `findActiveInviteToken`); `tokenId` = the **row id** in `revokeInviteAction` (`:367-368`, audit detail `token:${tokenId}` — id only). No raw token reaches log/audit/telemetry/notify — pinned by the Task 3 spy tests. ✅ |
| S6 | `sp_invite`/`BETA_INVITE_COOKIE` in the actions + invite pages + route | cookie read/clear + the one-time set — never a log/audit/next param | **set exactly once** (`app/invite/[token]/route.ts:79` — HttpOnly, `sameSite: "lax"`, `secure` production-only, `path: "/invite"`, 15 min); **read** in `app/invite/page.tsx:30` (re-validate) + `founding-sellers.ts:453` (accept); **deleted post-commit** with the same path (`founding-sellers.ts:610` — the object form `{ name, path }`, the RFC 6265 correctness fix pinned by unit test); constants in the domain module (`founding-sellers.ts:49-58`). Never logged/audited/in `next`. ✅ |
| S7 | `BetaCohortMembership` in `scripts src/lib/actions src/prisma` | creators = `acceptInviteAction` + `setBetaMembershipAction` (Batch 2) ONLY — no seed/backfill (§8.4) | **creators exactly 2**: `beta-cohort.ts:74` (`setBetaMembershipAction` — Batch 2, audited `beta_cohort.membership_set`) + `founding-sellers.ts:534` (the acceptance tx create). Everything else: reads (`first`/`where`/`updateAll` upsert legs), emitted contract artefacts (`contract.json`/`contract.d.ts`/`contract.prisma` — the Batch 2 model, untouched). `scripts/` + `seed.ts`: **0 creator hits** (the Task 1 seed edit only deletes). §8.4 held. ✅ |
| S8 | `setBetaMembershipAction` in `src/lib/actions/founding-sellers.ts` + console + `app/admin/beta-cohort` | 0 hits — no second membership-mutation surface | **0 import/call hits** (2 doc-comment mentions naming Batch 2's action as the *other* audited writer — documentation). The console links to `/admin/users?u=<id>`; the buyer grant/suspend forms live on Batch 2's own users page (corrections #19 — that surface already imported the action pre-Batch 7). Pinned by test. ✅ |
| S9 | `emitProductEvent` in `src/lib/actions/founding-sellers.ts` | exactly `seller_invited`, `seller_registered`, `beta_membership_activated` (the last conditional on `activated`) | **3 call sites**: `seller_invited` `:345` (actorId **null** — prospect has no account; provinceCode only, **no metadata** — `z.strictObject({})`); `beta_membership_activated` `:639` (**only** inside `if (activated)`); `seller_registered` `:646` (actor = accepting user, raw `sessionId` in, `provinceCode: candidateAfter?.targetCommunity ?? null` — the fail-open post-review shape). All **after** the committed tx, fail-open, never inside a tx callback. ✅ |
| S10 | `assertBuyerBetaChatAccess` in `chat.ts` + `deals.ts` | create branch of `startConversationAction` + `createDealAction` only — NOT `markDealOutcomeAction` | **chat.ts:80** (create branch, after Batch 6's `assertListingSellerInteractable`, before `Conversation.create`); **deals.ts:156** (inside the existing try, after `assertListingSellerInteractable`, before `requireDealConversation`; `"BETA_MEMBERSHIP_REQUIRED"` appended to `DEAL_CREATE_GUARD_ERROR_CODES` `:84`); definition `beta-access.ts:91`. `markDealOutcomeAction`: **0 hits** — pinned by source assertion. ✅ |
| S11 | `AuditEvent\|auditEvent` in `src/lib/product-events.ts` | 0 hits (S10 telemetry domain separation held) | **0 hits** ✅ |
| S12 | `dangerouslySetInnerHTML` in `app/admin/beta-cohort` + console + forms + invite-accept-form | 0 hits (stored-XSS posture — notes are untrusted ops free text, React text only) | **0 hits** ✅ |
| S13 | `đảm bảo\|bảo đảm\|guarantee\|thưởng\|reward` in `app/admin/beta-cohort` + console + `app/invite/[token]` + `app/invite` + forms + invite-accept-form | 0 hits (§4.2 + no invented incentives) | **1 hit**: `app/invite/page.tsx:17` — a **whole-line JSDoc comment** reading "KHÔNG incentive/reward" (a *negation* documenting the constraint). Rendered copy: 0 hits; `reward` is not in the corrections-#33 copy-safety token list (that list is finance-promise language); whole-line comments are stripped by the copy-safety walker anyway. Classified safe. ✅ |
| S14 | `an toàn khu vực\|khu vực an toàn\|verified market` in the domain/vocab/console | 0 hits (§4.7 location neutrality) | **0 hits** — console copy is "Khu vực beta trọng điểm"/operational labels only; `targetCommunity` renders via `PROVINCE_CODES` display names. ✅ |
| S15 | `PROVINCE_CODES\|isProvinceCode` in the domain/vocab/actions/console | consumed from `src/lib/provinces.ts` (Batch 2 Task 10, FD-1) — never re-defined | **6 hits, all consumption**: `isProvinceCode` validation (`founding-sellers.ts:115` — the zod refine on `targetCommunity`), `PROVINCE_CODES` display (`console.tsx:241`), imports/doc lines. The registry itself is untouched (read-only). ✅ |
| S16 | `FINANCIAL_FEATURES_ENABLED` in `.env.example`/`docker-compose.prod.yml`/`scripts` | still `false` everywhere | **7 hits, all `false`/comments**: `.env.example:46` `"false"`, `docker-compose.prod.yml:123` `"false"`, `scripts/smoke.sh:12,116,223` (export `"false"` + comments), `scripts/docker-smoke.sh:90` (comment). Batch 1 preserved. ✅ |

No hit violates an invariant; nothing was fixed as a result of the scans (the
surfaces were written scan-clean — the Task 3/5/6/7 suites pin S4–S12 as
executable contracts, re-runnable per suite).

---

## 4. Migration review (Step 4 — additive-only, corrections items 1–5)

`npx prisma migration show "migrations/app/20261008T1130_batch7_cohort_operations"`:

- **15 operations, ALL `additive`** (2 `createTable`
  `FoundingSellerCandidate`/`BetaInviteToken`, 7 `createIndex`, 2 `unique`,
  4 `foreignKey`): **zero destructive, zero data transforms, zero
  `placeholder(...)`** (grep on the rendered `migration.ts` = 0 —
  `pendingPlaceholders` false), **zero `Listing_status_check_*` ops** (Batch 7
  adds no `listing_status` value — the plan's "halt on any destructive op"
  never fired). Pinned by the ops-package contract in
  `tests/integration/batch7-migration.test.ts` (corrections item 4): table ops
  exactly `["table.BetaInviteToken","table.FoundingSellerCandidate"]`, zero
  `column.` ops (User gains relations only), exactly one
  `index.BetaInviteToken.beta_invite_one_active_<8hex>` op, no op id matching
  the finance regex.
- **Partial unique index** `beta_invite_one_active_00182012` on
  `("candidateId") WHERE (("consumedAt" IS NULL AND "revokedAt" IS NULL))` —
  one *active* token per candidate (the re-invite race guard);
  consumed/revoked tokens coexist as audit trail. The rendered SQL carries the
  quoted camelCase predicate byte-correctly (corrections item 5 — the
  `active Boolean` fallback was **not** needed); the integration test proves
  the index rejects a second active token while consumed/revoked coexist, and
  the 23505 classify matches by **prefix** (`^beta_invite_one_active_`).
- **FK decisions (Legacy Migration Decisions + corrections #32):**
  `BetaInviteToken.candidate` `Restrict` (declared explicitly — tokens are never
  deleted by product flows; test cleanup deletes tokens before candidates);
  `FoundingSellerCandidate.userId` `@unique` + `SetNull`
  (`FoundingSellerCandidate_userId_key` — one candidate per linked seller,
  multiple NULL-`userId` prospects coexist); `assignedOperatorId` + `issuedById`
  `SetNull` (rows survive a future admin deletion — the Batch 3
  `UserSuspension.suspendedBy` precedent). Recorded seed edit:
  `BetaInviteToken` → `FoundingSellerCandidate` `deleteAll` before `User`
  (re-seeds don't orphan prospects).
- **Graph shape (corrections #1/#3):** 9 dirs — `baseline → batch2 → batch3 →
  20261006T1902_batch4_listing_quality → 20261007T1708_batch4_holistic_review_fixes
  → 20261007T2007_batch4_round4_approved_content_backfill (self-edge, provides
  the backfill invariant) → 20261007T2208_batch5_search_telemetry →
  20261008T0237_batch6_chat_deal → 20261008T1130_batch7_cohort_operations`;
  the plan output's `from:` was `292dd3fb…` (the Batch 6 `to` both refs held);
  Batch 7 adds exactly one edge out of `292dd3fb…`; the new dir sorts after
  `20261008T0237` (head detection).
- **Refs advanced in the Task 1 commit, invariant restored by hand**
  (corrections #2): `migration ref set production` rewrites
  `refs/production.json` with `invariants: []` —
  `"invariants": ["backfill-listing-approved-content-at"]` was hand-restored in
  the same commit; `refs/db.json` stays `[]`. Both refs now hold `656449ac…`.
  Pinned by `tests/unit/approved-content-backfill-migration.test.ts` (the
  batch7 dir appended to the `@empty → production` walk — corrections item 3)
  and `tests/integration/batch5-migration.test.ts` (`BATCH7_DIR` + the applied
  list) — both append-only pin updates, recorded as the Batch 6 §5 precedent.
- **No backfill (§8.4/§8.6):** zero data ops by construction; the integration
  delta case proves a freshly created user gains **zero** `BetaCohortMembership`
  rows (delta, not global count). Rollback = `git revert` of the Task 1 commit
  + restore per `docs/backup-restore.md`; no down-migration (forward-only).
  Production applies via the compose `migrate` service `--to production` after
  the ref advance.
- **`npx prisma db verify`** (dev DB): ok — marker = schema = contract
  `656449ac…`.

---

## 5. Task 6 Step 3b fixture migration (the B1 precedent — no assertion weakened)

The buyer gate changes `startConversationAction`/`createDealAction`'s observable
behavior for a **non-member buyer**, so the earlier-batch fixtures that create
a conversation/Deal through those actions gained an active buyer membership
(`private_beta_buyer`, `expiresAt: null`). Per corrections #17 the plan's
"exactly once" is **"at most once"** — the per-file outcome (recorded, the
Batch 6 B1 pattern):

| File (owning batch) | Batch 7 edit (Task 6 commit `9b9cd4f`) | Nature |
|---|---|---|
| `tests/unit/chat-guard.test.ts` (B3) | `BUYER_MEMBERSHIP` pushed in `seedBase()` **after** `SELLER_MEMBERSHIP` | fixture migration |
| `tests/unit/chat-hardening.test.ts` (B6) | same buyer row; `setMembership` helper already targets `userId === SELLER.id` so seller cases unperturbed | fixture migration |
| `tests/unit/telemetry-wiring.test.ts` (B5) | buyer membership pushed in the `startConversationAction` describe's `beforeEach`, next to `seedPolicyRows(SELLER.id)` | fixture migration |
| `tests/unit/deal-create.test.ts` (B6) | `seedBuyerMembership()` in `beforeEach`; the two seller-row mutations changed to find by `userId === SELLER.id` (corrections-preferred, no assertion change) | fixture migration |
| `tests/unit/sell-pages.test.ts` (B4) | D12 describe `beforeEach` seeds a `private_beta_buyer` row for `D12_BUYER` (corrections #18 — the listing page now reads `isActiveBetaParticipant` for logged-in buyers) | fixture migration (corrections-mandated extra file) |
| `tests/unit/deal-finance-isolation.test.ts` (B6) | **additive** source-order pin extended (corrections #31): the B7 guard sits after D2, before `Conversation.create`, emission after create | pin extension |
| `tests/integration/block-enforcement.test.ts` (B3) | `seedBuyerMembership(buyer)` helper + calls in the two tests whose buyer invokes `startConversationAction` (memberships cascade on user delete) | fixture migration |
| `tests/integration/chat-hardening.test.ts` (B6) | `seedBuyerMembership` for `buyer`/`buyer2` (the create-path actors) | fixture migration |
| `tests/integration/deal-lifecycle.test.ts` (B6) | buyer membership seeded in `seedOpenDeal`, tracked in `created.betaMemberships` (existing cleanup deletes it; covers the re-create case) | fixture migration |
| `tests/integration/suspension-enforcement.test.ts` (B3) | **NO EDIT — as corrections #17 predicted** (the actor `sellerX` holds `founding_seller` active via `seedSevenRequirements`, an allowed cohort). Confirmed by the full integration run, not assumed. | no edit (recorded) |

**Statement (corrections #32/#17):** no assertion was weakened in any of
these edits — every earlier-batch suite re-ran green in the full `npm test`
(101 files / 2305) and full `npm run test:integration` (33 files / 279) above.
The only other earlier-batch test edits in the batch are the two append-only
migration pins (§4) and the Task 1 seed edit — all recorded in their owning
commits.

---

## 6. Task reviews + fixes closed in this task

Every Batch 7 task was implemented in its own session/worktree (corrections
parallelism map: T1 ∥ T2 wave 1; T3 ∥ T6 wave 2; T4 wave 3; T5 ∥ T7 wave 4;
T8 last) and independently reviewed (2-skeptic adversarial verification) before
merging here — **all approved**; the per-task reports are in
`/tmp/loaviet/batch7-task{1..7}-report.md`. The review fixes that landed
**inside** the batch:

1. **`2d02913` — `refactor(cohort): typed FoundingSellerCandidate access after
   task 1 merge`** (Task 2 review fix): Task 2 shipped in a parallel worktree
   without the Task 1 contract, reading the table through a local structural
   cast; after the merge this was replaced with direct typed
   `db.orm.public.FoundingSellerCandidate` access and the structural types
   deleted (the corrections "typecheck against the contract happens after
   merge" follow-up).
2. **`0c8d333` — `fix(cohort): fail-open funnel sync after invite acceptance`**
   (Task 3 review finding, LOW): the post-commit
   `syncFoundingSellerFunnel` read + sync in `acceptInviteAction` is now
   wrapped in try/catch (fail-open) — on a transient DB error after the accept
   tx committed, `captureError("cohort", "COHORT_FUNNEL_SYNC_FAILED",
   { sqlState })` (string code, no error object, no PII), `candidateAfter`
   treated as null (→ `provinceCode: null` in emissions), and the action
   continues to telemetry, notify and `redirect("/sell")` (the redirect stays
   outside any catch). `syncCandidateFunnelAction` is the operator catch-up
   path. TDD: the new unit test was watched failing first.
3. **`b3b0871` — `fix(admin): live supply-readiness counts on the cohort
   console`** (confirmed Task 5 review finding, LOW — closed **in this task**,
   TDD, before this doc):
   - `src/components/founding-seller-console.tsx` — `buildSupplyReadinessView`
     counted `verifiedAt !== null`, a **stored milestone never cleared**: a
     revoked-verification or exited/inactive candidate still counted as a
     "verified founding seller" against the §12.1 targets. Now computed from
     **live rows**: verified = live `SellerVerification.status === "verified"`
     AND status ∉ {exited, inactive}; the approved-listings sum = only
     in-program candidates AND an **active** `founding_seller` membership
     (suspended → listings do not count); invited stays ever-invited
     (monotonic §12.3). New `SupplyReadinessRow` type; the page passes
     `CandidateRowView`s.
   - `app/admin/beta-cohort/page.tsx` — with `?userId=` the §5.10 summary badges
     and the §12.1 supply block were computed from the **filtered** list (one
     user's numbers presented as the program's). Now the page loads the full
     cohort (one query, corrections #37), builds the live view model for **all**
     candidates, and the `?userId=` filter narrows **only the table**; the
     filter notice is clearly labelled.
   - Tests first (RED confirmed — 6 expected failures): 3 new pure-logic cases
     (revoked verification / exited / inactive / suspended / unlinked do not
     count; ever-invited pinned), the updated source-contract pin, and **3 new
     behavioral page-render tests** through real RBAC (UserSession row + real
     cookie — the corrections #21 recipe; the db mock gained `include("user")`,
     controllable cookies, `PolicyAcceptance`/`UserSuspension` models):
     `?userId=` renders full-cohort summary/supply with a one-row table;
     unfiltered renders everything; revoked-verification +
     suspended-membership flips the live counts to 0 while ever-invited holds.
     `beta-cohort-console.test.ts` 39 → **45**.

Verification after the fix: focused 45/45, full `npm test` **101 files / 2305
green**, lint/typegen/tsc clean, build PASS, integration 33/279 green,
preflight 7/7, smoke pass (§2 table).

---

## 7. Telemetry emission map (T5/S7 — every emission AFTER the transaction)

All three Batch 7 events emit via Batch 5's `emitProductEvent` (raw
`sessionId`/`actorId` in, HMAC-pseudonymized by the core; fail-open; never
wrapped in try/catch; **never from inside a `db.transaction` callback**):

| Event | Call site | Payload | After commit |
|---|---|---|---|
| `seller_invited` | `inviteCandidateAction` (`founding-sellers.ts:345`) | `actorId: null` (prospect has no account), `provinceCode: candidate.targetCommunity`, **no metadata** (`z.strictObject({})`) — no contact (§4.8) | ✅ after the issue tx |
| `beta_membership_activated` | `acceptInviteAction` (`:639`) | **only when `activated === true`** (Batch 5 S7 semantics — the `invited → active` transition and the create; the `active`-already path emits nothing), `actorId: user.id`, raw `sessionId`, `provinceCode: candidateAfter?.targetCommunity ?? null` (the fail-open post-sync shape) | ✅ after the accept tx |
| `seller_registered` | `acceptInviteAction` (`:646`) | `actorId: user.id` (the accepting user), raw `sessionId`, `provinceCode` as above — the "registered = invite acceptance" reading (S9, PROVISIONAL) | ✅ after the accept tx |

Batch 5's `setBetaMembershipAction` wiring (`recordBetaMembershipActivated`)
is unchanged; Batch 7 adds no emission name outside the taxonomy (S10), no
`AuditEvent` for product events (S11 scan = 0), and no contact-reference PII
in any event (the integration §4.8 scan reads `ProductEvent` rows back and
finds no contact string in any column). The unit tests assert the
**`ProductEvent` row exists** (not only a spy). Notifications: kind
`"cohort"`, typed neutral copy, best-effort after commit
(`captureError("cohort", "COHORT_NOTIFY_FAILED", { sqlState })` — string code,
no error object, no contact; corrections #25).

---

## 8. Recorded decisions D1–D4 + the operational-targets statement

Each shipped as the safe/fail-closed default; **D3 is a named Batch 8 Founder
Decision Register item** (§11):

- **D1 — `FOUNDING_SELLER_INVITE_TTL_DAYS = 14`.** Spec requires expiring
  invites, gives no TTL; 14 days fits concierge recruitment. Tunable constant
  in the vocab module (not env — §4.10).
- **D2 — "seller needing assistance" = active-funnel candidate with
  `lastContactAt` null or older than 7 days**
  (`FOUNDING_SELLER_ASSISTANCE_AFTER_DAYS`). An ops heuristic rendered as a
  badge, explicitly **not an SLA** (none exists in the spec).
- **D3 — `BETA_CHAT_REQUIRES_ACTIVE_MEMBERSHIP = true`** (a READING of §2.1,
  not a spec default): the private beta **is** the tightly controlled cohort,
  so the fail-closed reading ships **on**, as a server-owned constant (not env,
  not client). **This value decides whether any buyer can chat at launch** —
  founder acknowledgment required (Batch 8 register); flipping it off is a
  reviewed code change. The buyer-grant path: `/admin/users` → Batch 2's
  audited `setBetaMembershipAction` (the Task 5 `private_beta_buyer` grant/
  suspend UI, corrections #19/P2 — the only grant path; no buyer invitation
  flow in P0, A4).
- **D4 — the buyer gate is initiator-only; the seller side is Batch 6 D2's.**
  `assertBuyerBetaChatAccess` checks the initiator (the conversation's buyer /
  the Deal's buyer per Batch 6 D11); the listing's seller is checked by
  `assertListingSellerInteractable` (`SELLER_SUSPENDED`/
  `SELLER_NOT_VERIFIED`/`SELLER_MEMBERSHIP_INACTIVE`), already in place — the
  two guards compose; Batch 7 adds no counterpart check.

**C1/C2 outcomes (the Batch 6 interface, resolved as planned):** the buyer
gate landed in **`startConversationAction`'s create branch** (after Batch 6's
`assertListingSellerInteractable`, before `Conversation.create` — never
touching the Batch 5 emission or the existing-conversation redirect branch)
and in **`createDealAction`** (after `assertListingSellerInteractable`, before
`requireDealConversation`, inside the existing try, `"BETA_MEMBERSHIP_REQUIRED"`
appended to `DEAL_CREATE_GUARD_ERROR_CODES` — corrections #11);
**`markDealOutcomeAction` is deliberately ungated** by the beta policy (Batch 6
D10/D2 own marking's guards — actor suspension + block-for-success; blocking a
member's confirmation would strand the bilateral record). Both insertion points
are pinned by source-order tests (`deal-finance-isolation`, `chat-beta-gate`,
`deal-beta-gate`).

**Operational targets (§12.1/§2.7/§9):** the console renders the §12.1
reference targets **"20–50"** invited founding sellers and **"100–300"**
quality listings as **display strings beside live counts** —
`invitedFoundingSellers` (ever-invited, monotonic §12.3),
`verifiedFoundingSellers` (live verification, in-program),
`approvedListingsByFoundingSellers` (factual approved count of in-program
candidates with active membership) + the ops-sampled
`qualityListingCount` (A3 — never auto-computed). **No code path blocks
anything on reaching them** (source-asserted: no `if (count >= 20)` style
logic; helper is pure) — broader private-beta buyer invitations remain a
**founder approval** (§12.1 "explicitly approved"), never a code gate. The
§12.1 statement is rendered on the page verbatim in spirit: the numbers are
reference targets; the founder approval is the actual control.

---

## 9. Residual risks (recorded — accepted at P0, revisited post-beta)

| # | Residual risk | Status / mitigation |
|---|---|---|
| R1 | **One-time `/invite/<token>` URL** lives in the invitee's browser history + the nginx access log before the cookie redirect (S1 — the honest claim). Contained by: the HttpOnly 15-min `path: "/invite"` cookie, the tokenless `next`, `Referrer-Policy: no-referrer` on the token response only (corrections #8 — `:path*` would break the same-origin action POST), `X-Robots-Tag: noindex`, the landing's no-side-effect GET (bot-unfurl safe), and revocation. A leaked link is revocable, **not retroactively** for an already-accepted invite. | Accepted (spec §4.8 posture); Batch 8 register (token-in-URL) |
| R2 | **P1 — production invite acceptance is unreachable until FD-2**: the OTP delivery adapter is fail-closed in production (`OTP_DELIVERY_UNAVAILABLE`), so no invitee can verify email/phone in production → channel binding always refuses. Interim runbook: the manual psql `user.email_verified_manual` two-person rule (the same blocker that already applies to seller publication). | **Launch blocker** — Batch 8 register (§11 P1) |
| R3 | **Funnel sync is operator-/acceptance-triggered only (S5)** — the stored `status` can lag ground truth between syncs; the acceptance auto-sync is fail-open (`COHORT_FUNNEL_SYNC_FAILED` → the status stays `registered` until an operator runs `syncCandidateFunnelAction`). Nothing security-relevant depends on the candidate status (the membership/publication gates read `BetaCohortMembership` fresh); the console renders live verification/listing reads beside the stored status. | Accepted by design; operator catch-up path shipped |
| R4 | **Task 4 lifecycle actions write the CAS update and then a post-commit `auditEvent` (no tx)** — `updateCandidateStatusAction`/`assignCandidateOperatorAction`/`recordCandidateContactAction`/`updateQualityListingCountAction`/`syncCandidateFunnelAction` follow the Batch 2/3 precedent (plan line 56): a DB failure between the conditional `updateAll` and the audit leaves the change without its audit row (the write itself stays compare-and-set safe). The invite path (Task 3) writes `auditEventTx` **inside** the tx. | Known residual — recorded, deliberately not changed (the plan-specified Batch 2/3 precedent); Batch 8 may unify |
| R5 | **Application-level contact dedup (S7)** — no unique index on `(contactChannel, contactReference)` by design (a PII index would be an enumeration oracle); a concurrent double-create race can produce two candidates for one contact; ops sees both in the console. | Accepted; recorded |
| R6 | **In-memory rate-limiter topology** — the three invite buckets (landing 30/10 min/IP, accept 10/10 min/user + the IP bucket only behind `TRUST_PROXY_HEADERS=true`, invite 20/h/admin) are per-instance; behind N app replicas the effective limit is N× (pre-existing platform caveat). | Accepted (one-instance topology); §7.1 values PROVISIONAL (Batch 8 register) |
| R7 | **Browser E2E remains deferred** (no infrastructure — recorded since Batch 2): the critical flows (invite issue → accept → membership active → publication allowed; suspend → every gate closes → reactivate → reopens) are covered by action-level unit tests + real-DB integration tests. | Tracked pre-invite prerequisite (spec §10/§12) |
| R8 | **Console query density** — ~11 point-queries per linked candidate (corrections #37 blesses the shape at ≤ 300 rows); at the 300-candidate ceiling the page is multi-second. The `?userId=` filter now builds the full-cohort view model (the §6 fix) — same cost as the unfiltered page, still ≤ the blessed shape. | Accepted at beta scale; Batch 8 polish (deferred minor) |
| R9 | **Plain-FormData console actions throw typed errors without inline error state** (the repo's users-page pattern): `INVALID_TRANSITION`, `ASSIGNEE_NOT_ELIGIBLE`, `CANDIDATE_ALREADY_MOVED` surface as Next error pages; all typed, guarded server-side, audited. The `useActionState` forms (create/invite/notes) render inline errors and keep inputs across errors (React 19 manual dispatch). | Accepted (repo pattern); deferred minors recorded in the Task 5 report |
| R10 | **Deferred minors from the Task 5 review** (all polish, none acted on): raw enum values render untranslated in a few console spots; the manual-transition form renders for `exited` rows (every option illegal → typed error); the assign-select shows "Chưa gán" when the stored operator lost the capability while the Operator column still shows the name; `User.where(adminRole.isNotNull())` loads full rows. | Batch 8 polish pass |

**Dropped residual (superseded by the §6 fix):** the Task 5 review's
"revoked-verification / exited / suspended candidates count toward the §12.1
targets" and "?userId= narrows the summary/supply numbers" findings are
**closed** by `b3b0871` (§6) — the counts are live and cohort-wide.

---

## 10. Deferred items + forward seams

- **Buyer invitation flow (A4):** deliberately not built — §12.1 gates broader
  buyer invitations on supply readiness + founder approval; buyer memberships
  are granted through Batch 2's audited `setBetaMembershipAction` (the Task 5
  `/admin/users` UI). A buyer invite variant is a later additive extension of
  the token mechanism.
- **Invitation email/SMS delivery (A1/FD-2):** the platform never emails/SMSes
  the link; the operator delivers out-of-band (the §5.10.1 concierge reality).
  No production provider exists (Batch 2 A1; FD-2 defers it).
- **"Quality listing" definition (A3):** `qualityListingCount` stays ops-set
  after §12.1 manual sampling; the system never auto-computes it (pinned by
  source contract). Batch 4's vocabulary review is the prerequisite.
- **A5 reactivation from `inactive`:** pinned `inactive → exited` only;
  re-entry is a founder ruling (one-line transition-table addition).
- **A6 membership-suspension sanction semantics:** suspension blocks new
  publication + new conversations/Deals (proven, Task 7) but does not unpublish
  live listings (Batch 3 A2 precedent), does not revoke sessions, does not kill
  messages inside existing conversations (§2.1 restricts creation), no
  auto-expiry. Founder decides sanction policy.
- **A7 `targetCommunity` semantics:** any valid canonical slug code (§5.9.1
  allows organic participation beyond the two beta markets); founder may want
  it restricted during the controlled beta (one-line validation change).
- **Scoped PII (A2):** the console renders masked contacts only; **no reveal
  action exists** — the `pii.view_sensitive` Scoped/Step-up cells stay
  undefined until the founder defines them (fail closed).
- **Batch 8:** the Founder Decision Register items (§11), the ops-alerts
  classification + copy-safety re-run (merge actions), the legal review of
  every PROVISIONAL copy string.

---

## 11. Batch 8 Founder Decision Register hand-off (FD-3 — every PROVISIONAL item Batch 7 ships)

Per FD-3 these ship as fail-closed defaults now and are **launch blockers /
founder-acknowledgment items in the Batch 8 register**, never invented further.
Compiled from the plan's hand-off section + every per-task report
(`/tmp/loaviet/batch7-task{1..7}-report.md`):

| Item | What ships today | Needs |
|---|---|---|
| **P1 (most consequential)** Verified-channel binding vs **FD-2** | Acceptance requires the invite's normalized contact to match a **verified** email/phone of the accepting fresh `User` row. In production the OTP adapter is fail-closed → **no invitee can verify a channel → invite acceptance is unreachable in production** until FD-2 lands, or until the founder accepts token possession + out-of-band delivery as channel proof. Interim: the manual psql `user.email_verified_manual` runbook (two-person rule). | **Founder decision — launch blocker** (provider selection or the binding ruling) |
| **P2 / D3** `BETA_CHAT_REQUIRES_ACTIVE_MEMBERSHIP = true` | The §2.1 buyer gate is **ON**: no buyer can chat/create Deals at launch without a membership. The `/admin/users` `private_beta_buyer` grant/suspend UI (reusing Batch 2's audited, self-grant-forbidden action) is the only grant path; staff accounts also need `internal`/`private_beta_buyer` granted by **another** admin. | Founder acknowledgment of the default + the grant workflow |
| **P3** Admin/issuer as founding seller | Self-issue refused (`INVITE_SELF_ISSUED`), operator's own contact refused (`CANDIDATE_CONTACT_IS_OPERATOR`); **other admin accounts may accept an invite** — "admin account as founding seller" recorded. Operator self-**assignment** allowed (concierge tracking metadata, not authority). | Founder ruling on admins in the cohort |
| **P4** Expired-active membership at acceptance | Refused **before the claim** with `INVITE_MEMBERSHIP_NOT_ACCEPTABLE` (same as suspended/exited); acceptance never clears `expiresAt`. | Founder visibility |
| **P5** Rate values | Landing 30/10 min/IP; accept 10/10 min/user (+ IP bucket only behind `TRUST_PROXY_HEADERS=true`); invite 20/h/admin; cookie TTL 15 min; invite token TTL 14 days (D1); note cap 4000; source cap 200. | Founder may adjust additively pre-beta |
| **The §5.10 transition table** `FOUNDING_SELLER_TRANSITIONS` + **reason codes** (7) + **`MANUALLY_SETTABLE_STATUSES`** (4 ops states) | Mechanical vocabularies, PROVISIONAL-marked in the module headers; `inactive → exited` only (A5); the funnel sync is EXEMPT (its own monotonic order, ground-truth-advancing). | Founder review/extension |
| **Invite only for `prospect`/`invited`** (pre-registration re-invite) + **"registered" = invite acceptance** (the `seller_registered` reading) | `inviteCandidateAction` refuses registered-and-beyond (`INVALID_STATE`); re-entry is an ops decision (A5). | Founder confirmation |
| **`BETA_CHAT_ALLOWED_COHORTS` incl. `internal`** | Internal users may start buyer-side conversations; future cohort values fail closed until allowlisted. | Founder visibility |
| **Verified-channel binding reading** (§2.1 "required authentication state") + **invite-acceptance-as-§8.4-"admin operation"** (the second audited membership writer beside Batch 2's action) | As shipped (Task 3); §8.4 held by construction (zero data ops; delta test). | Founder acknowledgment |
| **C2 outcome** | Buyer gate on `createDealAction` (§7.8 Deal-mutation beta-membership status); **`markDealOutcomeAction` deliberately ungated** (Batch 6 D10/D2 — blocking a member's confirmation would strand the bilateral record). | Founder visibility (S9) |
| **D4** initiator-only gate | The two-guard composition (Batch 6 D2 seller-side + Batch 7 buyer-side); no counterpart check added. | Founder visibility |
| **A1** invitation delivery (FD-2) | Out-of-band operator delivery; the platform never emails/SMSes. | Founder provider decision (launch prerequisite) |
| **A2** Scoped-PII semantics | Masked contacts only; no reveal action. | Founder definition of the `pii.view_sensitive` cells |
| **A3** "quality listing" definition | `qualityListingCount` ops-set only; the console shows the factual approved count beside it. | Founder definition (Batch 4 vocabulary review prerequisite) |
| **A4** buyer acquisition | No buyer invitation flow in P0; `/admin/users` grants only. | §12.1 founder approval + the acquisition mechanism |
| **D2** assistance threshold 7 days | Ops heuristic badge, explicitly not an SLA. | Founder visibility |
| **PROVISIONAL copy (FD-3)** | Invite page + accept form + notify + console + form error texts + the D12 listing-page neutral copy ("Tính năng nhắn tin đang giới hạn cho thành viên beta") + the deal-form error text — mechanics-only Vietnamese, no incentive/guarantee language (S13 scan). | Batch 8 copy/legal review (A9 register) |
| **Token-in-URL residual (R1)** | The one-time `/invite/<token>` GET in browser history/nginx logs, contained by the cookie flow. | Founder acknowledgment |
| **The §6 fix reading** | Supply-readiness counts are **live** (verified = live `SellerVerification` + in-program; listings = in-program + active membership); `invitedFoundingSellers` stays **ever-invited monotonic** (§12.3) — an exited candidate still counts as "từng được mời". Founder may want invited to exclude exited/inactive too (one-line change). | Founder visibility |
| **New ops error codes** | `COHORT_FUNNEL_SYNC_FAILED` + `COHORT_NOTIFY_FAILED` (scope `cohort`, fail-open, string codes + `sqlState` only — no error object, no PII). | ops-alerts classification at the early-B8 merge (below) |

**Merge-time actions for the early Batch 8 merge (branch
`local/b8-early-integration` — the files are NOT in this tree; recorded here +
in every task report per corrections #6/#33):**

1. **ops-alerts classification (BLOCKING at merge):** add **`FoundingSellerCandidate`**
   and **`BetaInviteToken`** to `NON_FINANCE_TABLES` in `scripts/ops-alerts.ts`
   (that branch's `:128-160`), the drift-test classification
   (`tests/unit/ops-alerts.test.ts:546-563` — every contract model must be
   classified), and the `docs/operations/monitoring-signals.md` doc rows +
   the "27 bảng còn lại" count — **together with the still-pending Batch 6
   `Deal`/`DealStatusHistory` and Batch 5 `ProductEvent`/`SearchAlias` entries**
   (Batch 6 verification §12 merge action 1). Both new models are **non-finance**:
   no relation/FK to `Order`/`Payment`/`Payout`/`WithdrawRequest`/`LedgerEntry`/
   `Dispute`/`Cart`/`CartItem`/`Offer`/`ExchangeOffer` or wallet tables — pinned
   by the Task 1 ops-package contract (finance regex over every op id) and the
   §3 S7 scan. Also classify the two `cohort` captureError codes above for the
   alert routing.
2. **copy-safety re-run:** `tests/unit/copy-safety.test.ts` walks `app/**.tsx`,
   `src/components/**.tsx`, `src/content/**.ts` (excludes only `app/admin/`,
   strips only whole-line comments). The Batch 7 surfaces it will scan:
   `app/invite/page.tsx`, `src/components/invite-accept-form.tsx`,
   `src/components/founding-seller-console.tsx`,
   `src/components/founding-seller-forms.tsx` — all written to pass (S13; the
   console test pre-pins the identical forbidden-copy regex on the identical
   files, including trailing comments). Re-run after the merge (corrections #33).

---

## 12. Verdict

| Acceptance-gate bullet (plan §Acceptance Gate / spec §9 Batch 7) | Status |
|---|---|
| Seller cohort authorization (page guard + nav filtering + masked contact + no reveal + no-write-in-render; moderator/support/analyst/non-admin FORBIDDEN on every action; Batch 2 matrix unchanged; no step-up) | ✅ §2 #1 + §3 S1–S3, S8 |
| Invite acceptance (single-use atomic claim, expiring, unguessable HMAC-stored tokens, enumeration-safe, channel binding matching **and verified** from a fresh `User` row, membership upsert, §7.3 suspension refusal, §7.1 rate limits, revocation + re-issue, no silent-success commit, acceptance → membership active → candidate registered) | ✅ §2 #2 |
| Suspended membership enforcement (all five publication transitions + `listing.approve_blocked`; new conversations **and** Deals blocked `SELLER_MEMBERSHIP_INACTIVE`; member-as-buyer `BETA_MEMBERSHIP_REQUIRED`; live listings stay searchable; gates reopen on re-activation — all through the existing Batch 2/3/4/6 mechanisms, re-proven) | ✅ §2 #3 |
| Seller cohort + verification publication requirement (Batch 2 suites re-run green; the flip-at-acceptance integration case) | ✅ §2 #4 |
| Cohort telemetry (`seller_invited` actor null; `seller_registered` actor = user; `beta_membership_activated` only on `activated: true`; per-event schema validation, pseudonymized actors, zero contact PII; Batch 5 suites green with migrated fixtures) | ✅ §2 #5 + §7 |
| Operations can manage 20–50 invited founding sellers / 100–300 quality listings (the §5.10 display list + live-count supply-readiness targets, no hard-coded gate, §12.1 founder approval documented as the control) | ✅ §8 + §6 fix |
| §8.4 held (zero data transforms; the fresh-user delta test; only membership creators = acceptance + Batch 2's audited action) | ✅ §3 S7 + §4 |
| Batch 1–6 preserved — with the recorded fixture migration (every earlier suite green; `FINANCIAL_FEATURES_ENABLED=false`; `rbac.ts`/`beta-cohort.ts`/`session.ts`/`otp.ts`/`audit-event.ts`/`seller-verification-policy.ts`/`product-events.ts`/`provinces.ts`/`moderation.ts` untouched; additive-only linear migration) | ✅ §2 table + §5 |
| Preflight (7/7), integration suite, safe smoke, `npm audit --omit=dev` (0), clean diff/status audit | ✅ §2 table |
| Review findings closed before the gate (typed access `2d02913`, fail-open funnel sync `0c8d333`, live supply-readiness counts `b3b0871`) | ✅ §6 |

**GATE PASS.** Batch 7 is complete on `b3b0871` + this doc; the Batch 8 merge
actions (§11) and the founder-authored launch blockers (§11 — P1 above all)
are recorded, not pending implementation here.
