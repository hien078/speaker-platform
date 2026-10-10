# Private Beta Batch 3 — Report, Block, Moderation, Evidence, Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the trust-and-safety loop — typed-reason abuse reports with evidence snapshots that survive source edits/deletes, user blocking enforced on every chat mutation path, a moderation-case workflow (grouping, assignment, state transitions, action history) behind the Batch 2 capability RBAC, a suspension mechanism wired into the publication gate and chat, an appeal foundation, and expanded append-only audit — without weakening the Batch 1 finance shutdown or the Batch 2 identity/security invariants.

**Architecture:** One additive Prisma 8 migration adds the trust-and-safety tables (`AbuseReport`, `ModerationCase`, `ModerationEvidence`, `ModerationAction`, `UserBlock`, `UserSuspension`, `Appeal`) plus six enums and relation declarations on `User`, with partial unique indexes (Prisma 8 `@@index(..., where:, unique:)`) closing the concurrent double-active-case / double-active-suspension / double-report races. A client-safe vocabulary module (`src/lib/moderation-vocab.ts`) owns the typed reason codes, case states, and the legal-transition table; a server-only domain module (`src/lib/moderation.ts`) re-exports it and adds the §7.8 enforcement guards (`isUserSuspended`, `getBlockState`, `assertCanStartConversation`, `assertCanSendMessage` — actor-side suspension checks only) and the snapshot module captures immutable JSON evidence at report time. Report submission groups into per-(target, reason-category) cases and captures evidence in one transaction; every admin moderation action re-checks a Batch 2 capability server-side, appends a `ModerationAction` history row and an `AuditEvent`, and never updates or deletes evidence. Blocking and suspension are enforced in the two real chat mutation paths (`startConversationAction`, `POST /api/chat/[id]`) — UI state is convenience only.

**Tech Stack:** Next.js 16.3.7 App Router (typed routes, server actions), React 19, TypeScript strict, Prisma 8 (`@prisma/orm-postgres` rc, contract + migration graph), PostgreSQL ≥ 15, Vitest (unit + scratch-container integration), zod, existing `node:crypto` HKDF helpers from Batch 2 (`hkdfKey` for ip hashing via `auditEvent`). **No new runtime dependencies** — Batch 3 needs none.

**Spec:** `docs/superpowers/specs/2026-10-06-private-beta-marketplace-reset-design.md` — Batch 3 is spec §9 "Batch 3", built on §5.5 (report/block/moderation), §5.5.1 (evidence lifecycle), §5.4/§5.4.1 (roles + RBAC matrix), §2.1 (beta access model), §7.1 (endpoint rate limits), §7.3 (authorization abuse), §7.8 (moderation enforcement), §4.5/§4.6/§4.8/§4.9/§4.11 (invariants), §8 (migration strategy), §9 Batch 3 deliverables + Gate, §10/§10.1 (verification + abuse matrix), §11/§11.1 (execution protocol). The plan argues from the spec; executors read both.

**Builds on:** `docs/superpowers/plans/2026-10-06-private-beta-batch-2-identity-security.md` — Batch 3 consumes its interfaces verbatim and assumes its tasks are complete: `src/lib/rbac.ts` (`Capability` incl. `report.resolve`/`user.suspend`/`listing.moderate`/`user.view_basic`/`audit.read`, `requireCapability`, `requireCapabilityWithStepUp`, `STEP_UP_CAPABILITIES`, `capabilitiesOf`, `AdminContext`), `src/lib/audit-event.ts` (`auditEvent`, `auditEventTx`, `redactDetail`, `AuditEventInput`), `src/lib/session.ts` (`SessionInfo`, `SessionUser` — via `requireUser`; Batch 3 deliberately does **not** use `revokeAllUserSessions`, see P1/A2), `src/lib/seller-verification-policy.ts` (`checkSellerPublicationRequirements`, `assertSellerPublicationAllowed`, `SellerPublicationRequirement`), `src/lib/otp.ts` (`hkdfKey`), the `AuditEvent`/`BetaCohortMembership`/`SellerVerification` models, and the Prisma 8 contract/migration workflow.

## Global Constraints

- Read `AGENTS.md` and the relevant Next.js 16 docs before editing app code. At minimum (paths as used by the Batch 0–2 plans): `node_modules/next/dist/docs/01-app/02-guides/server-actions.md`, `.../01-app/01-getting-started/15-route-handlers.md`, `.../01-app/02-guides/environment-variables.md`, `.../01-app/02-guides/redirecting.md`, `.../01-app/02-guides/testing/vitest.md`, plus the current `cookies()`/`headers()` API-reference guides under `node_modules/next/dist/docs/`. Heed deprecation notices; this is not the Next.js from training data.
- Prisma 8 contract/migration workflow (`.agents/skills/prisma-8/references/contract.md` + `migrations.md`): edit `src/prisma/contract.prisma` → `npx prisma contract emit` → `npx prisma migration plan --name <snake_slug>` → fill any `placeholder(...)`/data-transform holes in the rendered `migration.ts` → self-emit with `node migrations/app/<dir>/migration.ts` → review with `npx prisma migration show <dir>` → `npx prisma db migrate` → advance refs. Never `db update` against a shared/production database; never edit `ops.json`/`contract.json`/`contract.d.ts` by hand; commit contract artefacts + migration package together; `migration.ts` is framework-rendered — edit only the holes.
- **Additive-only schema.** No drop, rename, or repurpose of any existing column/table/enum value. All new columns are nullable or defaulted. The one existing-enum change is **additive**: `listing_status` gains the `removed` value (R2 — Batch 3 is the first writer; Batch 4 adds only `archived`). **Expected planner artifact (BLOCKING-2):** a pg/text enum value is enforced by a CHECK constraint, so the addition renders as a **DROP + ADD of the `Listing_status_check_*` constraint pair** — that pair is *expected and additive in effect* (classify and continue, same wording as R3); any DROP/ALTER of an existing **column or table** remains a plan violation. Batch 3 adds no data transform and no backfill — there is no legacy report/block/moderation data to migrate (the §8.6 backfill requirements are satisfied trivially: dry-run = "0 rows", no `--apply` exists, nothing to roll back).
- **Preserve Batch 1.** `FINANCIAL_FEATURES_ENABLED` stays `false`; every existing finance guard and its tests (`tests/unit/financial-shutdown-*.test.ts`, `tests/unit/finance-public-surface.test.ts`, `tests/unit/admin-finance-readonly.test.ts`, `tests/integration/escrow.test.ts`) must stay green unchanged. No Batch 3 task may enable, bypass, or weaken a finance boundary. Moderation takedown writes the new `removed` listing status (R4) — it must not touch `Order`/`Payment`/`Payout`/`Wallet`/`LedgerEntry`/`Dispute` in any way.
- **Preserve Batch 2.** The RBAC matrix (`tests/unit/rbac.test.ts`), session/OTP/MFA/audit suites, and the seller publication gate stay green. Batch 3 does **not** invent new capabilities (spec §4.11: administrator permissions are not implementation territory); every Batch 3 surface is gated by an existing capability. `src/lib/rbac.ts` is touched by exactly **one** Batch 3 extension: `"user.suspend"` joins `STEP_UP_CAPABILITIES` (spec §5.4.2 — suspension is a "destructive account action", so it requires step-up), with the Batch 2 step-up test parameterization extended in the same commit. The one Batch 2 *domain* file Batch 3 extends is `src/lib/seller-verification-policy.ts` (suspension becomes the 8th publication requirement, spec §7.8) — its test files are extended in the same Batch 3 commit, never weakened. `src/lib/actions/admin.ts` receives exactly one behavior-preserving hardening (Task 6, R5): the approve/reject writes become conditional pending-only — no interface, guard, or finance-boundary change.
- **Backend authorization only** (spec §4.5, §4.9). Every moderation action and console page checks capability server-side via `requireCapability*`. Hidden buttons, disabled composers, and filtered nav are convenience; the action/route is the boundary. A moderator's missing `user.suspend` must fail in the action even if the form was never rendered.
- **Fail closed on undefined RBAC cells** (Batch 2 Ambiguity A2, spec §5.4.1). Batch 3 uses only the unambiguous ✓ cells: `report.resolve` (super_admin, operations_admin, moderator), `listing.moderate` (same three), `user.suspend` (super_admin, operations_admin **only** — moderator/support "Scoped" is undefined), `audit.read` (super_admin only), `user.view_basic` (super_admin, operations_admin only). Moderator/support `Scoped`/`Exceptional`/`Limited` cells are NOT granted and their semantics are NOT invented — see Ambiguities A1.
- **Policy Non-Invention** (spec §4.11 + §11.1 + **FD-3**). Do not invent semantics for moderation sanctions, retention, appeals, PII access, or administrator permissions. Per founder decision FD-3 (`/tmp/loaviet/founder-decisions.md`): on material ambiguity, **proceed with the fail-closed default already chosen in this plan** — do not stop the affected task waiting for founder input. Items that need founder-**authored content** (sanction taxonomy, legal/policy text) ship as clearly-marked placeholders and are listed in the **Batch 8 Founder Decision Register** as launch blockers — never invented. The plan's *Ambiguities* section lists the known ones with their fail-closed defaults and the Batch 8 register hand-off.
- **Transaction constraint-violation rule (Postgres).** A unique/constraint violation (SQLSTATE `23505`) **aborts the whole `db.transaction`** — Postgres answers any later statement in that tx with `ROLLBACK`, and the Prisma 8 tx context has no savepoints (only `orm`/`sql`/`query`/`execute`). **Catching a violation inside the callback and returning normally is a silent-success bug**: the wrapper tries to COMMIT an aborted tx, Postgres rolls it back, and the action reports success with nothing persisted. Therefore: (1) on any constraint violation, **always throw out of the callback** (let it propagate or re-throw); (2) **classify OUTSIDE** the transaction — catch `SqlQueryError`, branch on `sqlState === "23505"` + the constraint-name prefix (`moderation_case_one_active_per_target_reason` / `AbuseReport_caseId_reporterId_key` / `user_suspension_one_active` / `Appeal_caseId_key`); (3) where retry is the intended semantics (report case find-or-create), **retry the whole transaction once** — the re-read inside the retry finds the winner's case; (4) where the violation is a user-facing duplicate, map it to the typed error (`REPORT_ALREADY_SUBMITTED` / `ALREADY_APPEALED` / `USER_ALREADY_SUSPENDED`) outside the callback; (5) **re-read the guarded row INSIDE the tx** (the active case, the suspension) — never trust a pre-transaction read for a claim. Pinned by the no-silent-success integration tests in Tasks 4/5.
- **Blocking never destroys evidence** (spec §5.5). Block/unblock performs no `Message`/`Conversation` deletion or mutation. A blocked pair's existing chat history stays readable via `GET /api/chat/[id]` (read-only); only new conversations and new messages are prevented.
- **Evidence immutability** (spec §5.5.1). No product flow updates or deletes `ModerationEvidence`. Evidence survives source edits and source deletes (pinned by integration test). FK behavior: `subjectUserId`/`reporterUserId` are `SetNull` so evidence survives a future account deletion (deletion itself is a later batch); `AbuseReport.reporter` is **nullable `SetNull`** (the report row also survives reporter deletion — the retention posture is recorded under A3).
- **PII minimization in evidence and console** (spec §4.8 spirit + §7.6). User-target snapshots capture public profile fields only — **never email/phone** (moderators do not hold `user.view_basic`). Message bodies ARE captured in message evidence — that is the point of evidence (§5.5.1) and it is moderation material, not an analytics event (§4.8). Admin free-text notes pass through `redactDetail` **at write time** before entering `AuditEvent.detail` **and** `ModerationAction.note` (belt-and-braces applied in the action, not left to convention). Console pages render untrusted content (report notes, message bodies, listing descriptions) as React text only — no `dangerouslySetInnerHTML`.
- **Audit append-only** (spec §4.6). Every privileged moderation action appends `AuditEvent` (actor, action, resource, reason, timestamp, session, ipHash) and `ModerationAction` (case-scoped history). Nothing in Batch 3 updates or deletes either — pinned by the append-only spies in `tests/unit/audit-append.test.ts` **and** by its source-contract case (no statement in `src/`/`app/` mutates `ModerationEvidence`/`ModerationAction`/`AuditEvent`). Evidence *views* are audited (`moderation.evidence_viewed`) — evidence is "separately audited" per §5.5.1.
- **Typed reasons everywhere** (spec §5.5). Report reason codes are exactly the nine §5.5 categories, verbatim. Every admin moderation action (transition, takedown, suspend, lift) records a reason code from a closed vocabulary defined in `src/lib/moderation.ts` — never bare free text. Free text exists only as optional `note`.
- **Rate limits** (spec §7.1). Report submission: per-reporter 5 / 10 min via `checkRateLimit` + same-target-same-reason dedupe against active cases. Chat: `GET /api/chat/[id]` keeps its existing per-IP `chat:poll` limit; **`POST` had no send limit and GAINS one** — per-user `chat:send` (30/min) — plus the block/suspension guard (Task 3). Block/unblock: per-user 20/min. In-memory limiter topology caveat (single instance) is documented in `src/lib/rate-limit.ts` and accepted as in Batch 2.
- **Suspension enforcement — the spec-stated minimal set only** (spec §7.8; see Ambiguities A2). The backend considers suspension before: **listing publication/transitions** (via the shared publication gate, `account_not_suspended`), **new chat** (the *initiator* must not be suspended), and **messages sent** (the *sender* must not be suspended). Recipient/counterpart-side suspension blocking and session revocation/login blocking are **not** spec-stated — they are **not implemented** and are recorded under A2 for founder decision (revoking sessions without blocking login is pointless, and a login block is sanction policy). Block guards run in `startConversationAction` and `POST /api/chat/[id]` in both directions (spec §5.5 "new messages in either direction"). Deal mutation checks are **deferred to Batch 6** — the `Deal` model does not exist yet (spec §9 Batch 6); this plan records the hand-off, it does not build Deal. Seller-verification revocation and beta-membership status for *new chat* are likewise **not** enforced by Batch 3 (the listing's own status is the control; a revoked seller's live listing is handled by moderation takedown) — recorded as a Batch 6/7 hand-off under §7.8/§2.1.
- **No product telemetry in Batch 3 — but leave the seam visible.** The `report_submitted` and `listing_removed` product events (spec §5.8) are Batch 5 telemetry deliverables: Batch 3 does **not** call `emitProductEvent` (it does not exist yet) and writes no PII to any analytics path. Forward seam: Batch 5 will wire `report_submitted` into `submitReportAction` (Task 4) and `listing_removed` into `takeDownListingAction` (Task 6) at their success points — those two actions are the agreed future call sites, so Batch 5 must not restructure them, only add the emit call.
- **Canonical test stubbing** (one recipe, used by every unit AND integration test that imports an action/page — the actions import `next/cache`/`next/navigation`/`next/headers` and `requireUser`, all of which throw or misbehave outside a Next request): `vi.mock("server-only", () => ({}))`; `vi.mock("next/cache", () => ({ revalidatePath: () => {} }))`; `vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(\`NEXT_REDIRECT:${url}\`); }, notFound: () => { throw new Error("NEXT_HTTP_ERROR_FALLBACK;404"); } }))`; `vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }) }))`; and a partial `vi.mock("@/src/lib/auth")` whose `requireUser`/`getCurrentUser` return a fixture `SessionUser` (role-stubbed per test; in integration tests the fixture user is a real row created in the scratch DB). Unit tests additionally mock `@/src/prisma/db.client` with in-memory model maps; integration tests keep the real db. Actions that call `redirect()` (e.g. `createListingAction`, `updateListingAction`) are therefore **not** invoked in tests that only need a data mutation — those tests mutate via `db` directly and assert the guards/evidence instead (see Task 4's evidence test).
- **Quote bracketed paths in every `git add`** — zsh globs `[id]`/`[slug]`/`[caseId]` as a character class and drops the file from the command. Every `git add` below already quotes them (e.g. `git add 'app/api/chat/[id]/route.ts' 'app/seller/[id]/page.tsx'`); keep that form in every commit.
- OpenCode must not push, merge, deploy, or destructively clean the repository. Commit each task separately with the listed message; never `git add .`. Exclude from commits: `.claude/settings.json`, `public/uploads/`, secrets, local scratch data, unrelated work.

## Batch 3 Scope Decisions

In scope (spec §9 Batch 3 deliverables, each mapped to its task):

1. **Reports** — `submitReportAction` against `listing|user|message` with the nine typed §5.5 reason codes, optional capped note, per-reporter rate limit, target-existence/participant authorization, and case linkage (Task 4).
2. **Typed reason codes** — closed vocabularies in `src/lib/moderation.ts`: report reasons (spec §5.5 verbatim), suspension reasons, transition decision reasons, moderation action types (Task 2, consumed by 4–7).
3. **Blocking** — `UserBlock` + `blockUserAction`/`unblockUserAction` (rate-limited) + enforcement in `startConversationAction` and `POST /api/chat/[id]` + `getBlockState(viewer, other)` driving the direction-aware UI (banner text + unblock form only when the viewer is the blocker) on seller profile and chat page + "blocked list" management on the profile page (Task 3).
4. **Moderation cases** — `ModerationCase` with the spec §5.5 model fields; grouping key = `(targetType, targetId, reasonCategory)` among active states (`open|triaged|investigating`); the spec's "may group multiple reports" is read as this key (recorded decision, reversible) (Tasks 1, 4).
5. **Case assignment** — `assignModerationCaseAction` with assignee-eligibility check (`report.resolve`) (Task 6).
6. **Moderation evidence snapshots** — `ModerationEvidence` captured in the report transaction; immutable from product flows; access-restricted to case workers; every view audited (Tasks 1, 2, 4, 6).
7. **Moderation action history** — `ModerationAction` appended by every case event (evidence captured, assignment, transition, takedown, suspension, lift, appeal) + subject-scoped history on the case page (Tasks 4–7).
8. **Appeal foundation** — `Appeal` model + `recordAppealAction` (case subject only, `actioned` cases only) + `appealed` case state + close bookkeeping + a minimal user-facing appeal page linked from the actioned-case notification. The *decision workflow* (who rules, outcomes, timelines) is **not** built — Ambiguity A4 (Task 7).
9. **Expanded audit context** — `AuditEvent` rows for every privileged moderation action (with case/resource/reason/session/ipHash) + evidence-view auditing + an action-prefix filter on the Batch 2 audit page (Tasks 5–8).

Plus, required by §7.8 and pre-announced by the Batch 2 plan ("`user.suspend` — Batch 3 dùng"):

10. **User suspension mechanism** — `UserSuspension` + `suspendUserAction`/`liftSuspensionAction` (super_admin/operations_admin only, fail-closed; suspend requires step-up) + `account_not_suspended` as the 8th publication-gate requirement + the §7.8 actor-side chat guards (initiator of new chat, sender of messages). **No session revocation and no login blocking** — both are sanction policy beyond the spec-stated minimal set, deferred to A2 (Task 5).

Recorded implementation decisions (mechanics, not policy — each reversible, flagged for founder review in the verification doc):

- **Moderation takedown writes the new `removed` status** (R2/R4): `takeDownListingAction` = atomic `updateAll({ status: "removed" })` where `status ∈ {approved, hidden, pending}`; 0 rows → `LISTING_NOT_TAKEDOWN_ELIGIBLE`. It **never** writes `rejected`/`rejectionReason` — the reason lives in `ModerationAction` as a typed code. Claiming `hidden` and `pending` (not just `approved`) closes the seller dodge (self-hide to weather a takedown) and lets moderation pull a listing out of the review queue. The seller-side lock (R5): `MODERATION_LOCKED_LISTING_STATUSES = ["removed"]` guards `updateListingAction`, `toggleListingVisibilityAction`, and `deleteListingAction` with typed errors, and `approveListingAction`/`rejectListingAction` stay pending-only — so a removed listing cannot be edited, toggled back, deleted, or re-entered via review. **Restoring a removed listing is an appeal outcome (A4), not built.**
- **A sanction linked to a case moves that case to `actioned` atomically.** `suspendUserAction`/`takeDownListingAction` with a `caseId` validate the case (exists, target matches the sanction target, state in `open|triaged|investigating|actioned`) and — when the case is still pre-action — transition it to `actioned` inside the same transaction (`resolved_by_sanction`), so the appeal link the subject receives points at a case that is actually `actioned`. Linking a sanction to a `dismissed`/`appealed`/`closed` case fails closed with `CASE_NOT_ACTIONABLE`.
- **The other Conversation/Message creation paths are already denied or dormant.** `createExchangeOfferAction` (`src/lib/actions/exchange.ts:70`) creates a `Conversation`, but its first line is `assertFinancialFeaturesEnabled()` — denied server-side while finance is disabled, pinned by `tests/unit/financial-shutdown-actions.test.ts` ("deny trước ExchangeOffer.create/Conversation.create"). `respondExchangeOfferAction`/`payExchangeTopupAction` only notify. Batch 3 does not touch them; Task 9's scan re-proves the only reachable creation sites are the guarded ones.
- **Reporters cannot report their own target.** A listing report where the reporter is the seller, or a message report where the reporter is the sender, is rejected with a typed error (self-reports are noise at best and self-suppression/moderation-pollution at worst). User-target self-reports were already rejected.
- **Moderator conflict-of-interest fails closed.** An admin who is the subject of a case, or one of its reporters, cannot assign/transition/take down/suspend on that case (typed `MODERATOR_CONFLICT`) — the recusal *policy* (when recusal is required, who may override) is Ambiguity A7; the deny is the safe default.
- **Report submission does not write an `AuditEvent`** — the actor is a regular user, and `AbuseReport` + `ModerationAction` already record actor/action/reason/timestamp; `AuditEvent` is reserved for privileged actors (spec §4.6). If abuse investigations later need reporter ipHash, that is a one-line follow-up, not a policy change.
- **Block is symmetric for enforcement, directional as data.** A `UserBlock` row is directional (blocker→blocked), but any block in either pair direction prevents new conversations and new messages in both directions (spec §5.5 "new messages in either direction"). Blocking yourself and blocking via forged forms is rejected server-side.
- **Suspending an admin account via moderation is refused** (typed error) — admin lockout is the Batch 2 bootstrap runbook's domain (`admin.role_manage`/`mfa-reset`), not a moderation sanction (Ambiguity A6).
- **Suspension requires step-up; lift does not.** Spec §5.4.2 lists "destructive account action" among step-up-required actions — suspending a user (blocks platform participation via the actor-side guards) is that action, so `user.suspend` joins `STEP_UP_CAPABILITIES` (the single `src/lib/rbac.ts` extension). Lifting a suspension is the restorative direction and is not in the §5.4.2 list — it keeps plain `requireCapability`. Recorded decision, reversible by founder ruling.
- **Suspended users keep existing published listings** — suspension blocks *new* publication/transitions (§7.8) but does not auto-unpublish; removal of a suspended user's live listings is a moderator decision through the case takedown action, not an automatic sanction (Ambiguity A2).
- **Reported targets must be visible to the reporter** — a report against a nonexistent or non-participant target (e.g. a message in someone else's conversation) fails with a typed error; this is the §7.3 cross-account-report-access control, not a probe oracle (no state is leaked beyond exists/doesn't-exist for targets the reporter can already see).

Explicitly deferred (do not build here): Deal interaction blocking (Batch 6 — no `Deal` model yet); `report_submitted`/`listing_removed` telemetry events (Batch 5 — forward seam recorded in Global Constraints); moderation sanction automation/durations **and the session-revocation/login-block question for suspended users** (A2); recipient/counterpart-side suspension blocking in chat (A2 — not in §7.8's stated set); evidence retention/deletion (A3); appeal decision workflow (A4 — including restoring a removed listing, R5); moderator/support `Scoped` capability grants (A1); moderator recusal/override policy (A7); §7.8 seller-verification-revocation and beta-membership checks on *new chat* (Batch 6 chat hardening / Batch 7 cohort enforcement revisit the same §7.8 list; Batch 3's chat guards cover suspension + block only, and a revoked seller's live listing is handled by moderation takedown); Batch 4 `archived`/`under_review` listing states and the full listing lifecycle (`removed` is **Batch 3's** per R2 — Batch 4 adds only `archived`); public review system (§13.4); any PII export.

## Dependency and Parallelization Map

```text
Task 1  contract + migration (base commit for everything)
        ↓
Task 2  moderation domain module (vocabularies, transition table, guards, snapshots)
        ↓
Task 3  blocking + chat/conversation enforcement
        ↓                                   ┌ {Task 4, Task 5} may run in PARALLEL
        ├── Task 4  reports + case grouping + evidence capture + report UI
        └── Task 5  suspension + publication-gate extension + admin users page
                ↓ (Task 6 mounts Task 5's suspend form on the case page and
                    renders Task 4's cases/evidence)
        Task 6  moderation console (queue, case detail, assignment, transitions, takedown → removed,
                + seller-side listing locks R5)
        ↓
Task 7  appeal foundation (action + user page + case-page section)
        ↓
Task 8  audit expansion (audit-page filter + append-behavior gate)
        ↓
Task 9  batch gate verification + verification doc
```

File-conflict rules (run sequentially unless stated otherwise):

- `app/seller/[id]/page.tsx` — Task 3 (block form) then Task 4 (report dialog): sequential.
- `app/chat/[id]/page.tsx` + `src/components/chat-window.tsx` — Task 3 (block banner + `disabled` prop) then Task 4 (report dialog mounts): sequential.
- `src/lib/actions/moderation.ts` — created by Task 5 (suspend/lift), extended by Task 6 (assign/transition/takedown), touched again by Task 7 (the suspend/takedown `notify` calls gain the `/appeal/<caseId>` link once the page exists — no dead link in any intermediate commit): sequential.
- `app/admin/moderation/[id]/page.tsx` — created by Task 6, extended by Task 7 (appeal section): sequential.
- `src/lib/constants.ts` — Task 4 adds `REPORT_REASON_LABELS`, Task 6 adds case-state/priority/suspension labels: sequential (both additive).
- `src/lib/moderation-vocab.ts` (client-safe vocabularies), `src/lib/moderation.ts` (guards; re-exports vocab), `src/lib/moderation-snapshot.ts` — created by Task 2, consumed read-only by 3–7: single owner. Client components (`report-dialog.tsx`, `appeal-form.tsx`) import **only** `moderation-vocab.ts`/`constants.ts` — never `moderation.ts` (which imports db).
- `src/lib/seller-verification-policy.ts`, `tests/unit/seller-verification-policy.test.ts`, `tests/unit/publication-gate.test.ts` — created by Batch 2 Task 10, extended by Batch 3 Task 5 (8th requirement): run after Batch 2, single Batch 3 owner. Task 5 also extends the other Batch 2 consumers of the requirement union: `src/lib/actions/listings.ts` (missing-requirement label for `account_not_suspended`), `src/lib/actions/seller-verification.ts` (submit refuses suspended users), `app/sell/verification/page.tsx` (checklist copy) — all in the Task 5 commit.
- **R7 file order (Batch 3 first, then Batch 4):** `tests/unit/publication-gate.test.ts`, `src/lib/seller-verification-policy.ts`, `src/lib/actions/listings.ts`, `src/lib/actions/admin.ts` — Batch 3's edits land first (Task 5 gate/label; Task 6 lock guards + **conditional writes** in `listings.ts` and the conditional pending-only approve/reject in `admin.ts`), and Batch 4 builds on the merged result; neither batch rebases over the other's uncommitted work. Within Batch 3, `src/lib/actions/listings.ts` has two owners — Task 5 (label) then Task 6 (lock guards + conditional writes): sequential.
- `app/admin/users/page.tsx` (Batch 2 Task 10 → Task 5), `app/admin/layout.tsx` (Batch 2 Tasks 9/10 → Task 6), `app/admin/audit/page.tsx` (Batch 2 Task 10 → Task 8): each has one Batch 3 owner; run after Batch 2.
- `src/lib/rbac.ts` — Batch 2 Task 8 → Batch 3 Task 5 (exactly one extension: `"user.suspend"` joins `STEP_UP_CAPABILITIES` — the §5.4.2 "destructive account action" interpretation, recorded as Ambiguity A9; no capability or matrix change); `src/lib/audit-event.ts`, `src/lib/session.ts`, `src/lib/otp.ts` — Batch 2 interfaces, consumed read-only by Batch 3. **Never edit the latter three in a Batch 3 commit.**
- Everything else is single-owner. If review prefers smaller commits, the UI mounts inside Tasks 3/4 (shared pages) and Task 6 (console) can be split into follow-on tasks — the action/guard commits are the reviewable core either way.

## Review Focus

1. **Blocked-user chat bypass via direct API call** — `POST /api/chat/[id]` (or `startConversationAction` invoked with a forged formData) still delivering a message after a block in either direction, because the guard lives only in the disabled composer. Pinned by Task 3: `tests/unit/chat-guard.test.ts` "POST with a block in either direction returns 403 CHAT_BLOCKED and creates no Message" + "startConversationAction with a block in either direction throws CHAT_BLOCKED and creates no Conversation" + `tests/integration/block-enforcement.test.ts` against the real DB.
2. **Evidence silently mutated or orphaned when the source changes** — editing or deleting the reported listing/message/user alters the snapshot, cascades the evidence row away, or leaves the case pointing at nothing. Pinned by Task 4: `tests/integration/report-evidence.test.ts` "editing then deleting the reported listing leaves the evidence row deep-equal (jsonb) to the capture and the case readable".
3. **Moderation-resource IDOR** — an analyst/support account (no `report.resolve`) or a non-subject user reaching the case detail/evidence, or appealing someone else's case. Pinned by Task 6: `tests/unit/moderation-pages.test.ts` (page-level `requireCapability("report.resolve")` source-contract) + `tests/unit/moderation-actions.test.ts` (analyst/support → FORBIDDEN) and Task 7: `tests/unit/appeal-actions.test.ts` "non-subject cannot appeal someone else's case".
4. **Report flooding** — repeated reports on one target spamming cases/evidence past the per-user limit, or the dedupe check being bypassable by re-reporting after triage. Pinned by Task 4: `tests/unit/report-actions.test.ts` "6th report within 10 min → RATE_LIMITED" + "same reporter+target+reason with an active case → REPORT_ALREADY_SUBMITTED, no second report/case" + "a second reporter on the same target+reason joins the existing case".
5. **Suspended-user bypass** — a suspended seller still publishing through any of the four listing transitions, or a suspended user still starting conversations / sending messages on a live session (Batch 3 deliberately does not revoke sessions — A2 — so the guards must hold per-action, read fresh from the DB). Pinned by Task 5: `tests/unit/publication-gate.test.ts` suspended-seller cases (all four surfaces), `tests/unit/chat-guard.test.ts` initiator/sender suspension cases, and `tests/integration/suspension-enforcement.test.ts` (chat + publication denied while active **with a live session**, allowed after lift).

---

## Task 1: Contract additions + Batch 3 migration

**Files:**

- Modify: `src/prisma/contract.prisma`
- Create: `migrations/app/<ts>_batch3_trust_safety/` (rendered by `prisma migration plan`)
- Modify (emitted): `src/prisma/contract.json`, `src/prisma/contract.d.ts`
- Modify: `migrations/app/refs/db.json`, `migrations/app/refs/production.json` (ref advancement)
- Test: `tests/integration/batch3-migration.test.ts`

**Interfaces:**

- Consumes: existing `User`, `Listing`, `Message`, `Conversation`, finance models (untouched); Batch 2 models `AuditEvent`, `BetaCohortMembership`, `SellerVerification` (untouched).
- Produces (used by every later task via `db.orm.public.<Model>`): models `AbuseReport`, `ModerationCase`, `ModerationEvidence`, `ModerationAction`, `UserBlock`, `UserSuspension`, `Appeal`; enums `report_target_type`, `report_reason`, `moderation_case_state`, `moderation_priority`, `suspension_status`, `appeal_state`; the **existing `listing_status` enum gains the `removed` value** (R2 — Batch 3 is the first writer; the only existing-enum change, additive); `User` relation declarations only (no new `User` columns).

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/batch3-migration.test.ts` (runs only via `scripts/test-integration.sh`, scratch DB, same `hasDb` guard pattern as `tests/integration/escrow.test.ts`):

- `applies the batch 3 migration additively`: after the script's migrate step, `AbuseReport`, `ModerationCase`, `ModerationEvidence`, `ModerationAction`, `UserBlock`, `UserSuspension`, `Appeal` each accept a create+read round-trip with the fields below (create+**delete** round-trip for all except `ModerationEvidence`, which is create+read only — evidence has no delete path in product flows and the test preserves that posture).
- `enum values match the spec`: a `ModerationCase` row accepts each of the seven §5.5 states and each of the three priorities; an `AbuseReport` accepts each of the nine §5.5 reason codes and each of the three target types (loop creates + reads back).
- `listing_status gains removed (R2)`: a `Listing` row accepts `status: "removed"` (create + read back); the migration diff shows the enum-value addition as **additive in effect** — the `Listing_status_check_*` DROP+ADD pair is present and classified as expected (BLOCKING-2), with no drop/alter of any existing column or table.
- `unique constraints hold`: a second `UserBlock(blockerId, blockedId)` with the same pair throws (raw create); a second `Appeal` for the same `caseId` throws (one-to-one); a second `AbuseReport` with the same `(caseId, reporterId)` throws; a second **active** `ModerationCase` with the same `(targetType, targetId, reasonCategory)` throws **while a `closed` case with the same key coexists** (partial unique index); a second **active** `UserSuspension` for the same user throws **while a `lifted` one coexists** (partial unique index).
- `migration leaves the database consistent`: `npx prisma db verify` exits 0 after migrate.
- `preserves finance and batch 2 tables`: `Order`, `Payment`, `Payout`, `WithdrawRequest`, `LedgerEntry`, `Dispute` still accept reads and a seeded `Order`+`Payment` row reads back unchanged; `UserSession`, `SellerVerification`, `BetaCohortMembership`, `AuditEvent` (Batch 2) still accept create+read.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:integration`
Expected: FAIL — new models/tables do not exist (`AbuseReport` etc. not in contract).

- [ ] **Step 3: Edit the contract, emit, plan the migration**

Add to `src/prisma/contract.prisma` (match existing style: `// use prisma-8` header, `@@type("pg/text@1")` on enums, `TimestamptzString`, `temporal.updatedAtString()`, named relation strings):

```prisma
// Trong enum listing_status HIỆN CÓ — THÊM MỘT value (R2: Batch 3 là first writer của
// `removed`; Batch 4 Task 1 chỉ thêm `archived`, KHÔNG đụng `removed` — additive-only):
//   removed  = "removed"   // moderation takedown (R4) — KHÔNG dùng cho seller self-hide
```

```prisma
// ─── Enums (Batch 3 — trust & safety, spec §5.5/§5.5.1) ───

enum report_target_type {
  @@type("pg/text@1")
  listing = "listing"
  user    = "user"
  message = "message"
}

enum report_reason {
  @@type("pg/text@1")
  suspected_scam          = "suspected_scam"
  harassment              = "harassment"
  spam                    = "spam"
  counterfeit_claim       = "counterfeit_claim"
  misleading_listing      = "misleading_listing"
  prohibited_content      = "prohibited_content"
  unsafe_behavior         = "unsafe_behavior"
  identity_impersonation  = "identity_impersonation"
  other                   = "other"
}

enum moderation_case_state {
  @@type("pg/text@1")
  open          = "open"
  triaged       = "triaged"
  investigating = "investigating"
  actioned      = "actioned"
  dismissed     = "dismissed"
  appealed      = "appealed"
  closed        = "closed"
}

enum moderation_priority {
  @@type("pg/text@1")
  low    = "low"
  normal = "normal"
  high   = "high"
}

enum suspension_status {
  @@type("pg/text@1")
  active = "active"
  lifted = "lifted"
}

enum appeal_state {
  @@type("pg/text@1")
  submitted = "submitted"
  closed    = "closed"
}
```

Add to `User` (relation declarations only — additive, no new columns):

```prisma
  reportsMade          AbuseReport[]        @relation("abuse_report_reporter")
  casesAssigned        ModerationCase[]     @relation("moderation_case_assignee")
  evidenceSubject      ModerationEvidence[] @relation("moderation_evidence_subject")
  evidenceReporter     ModerationEvidence[] @relation("moderation_evidence_reporter")
  moderationActions    ModerationAction[]   @relation("moderation_action_actor")
  blocksMade           UserBlock[]          @relation("user_block_blocker")
  blocksReceived       UserBlock[]          @relation("user_block_blocked")
  suspensions          UserSuspension[]     @relation("user_suspension_user")
  suspensionsActedBy   UserSuspension[]     @relation("user_suspension_actor")
  suspensionsLiftedBy  UserSuspension[]     @relation("user_suspension_lifter")
  appealsFiled         Appeal[]             @relation("appeal_appellant")
```

New models (FK decisions are load-bearing — see Global Constraints; the partial unique indexes close the concurrency races — see Task 4/5):

```prisma
// ─── Trust & safety (Batch 3 — spec §5.5/§5.5.1) ───

model AbuseReport {
  id         String             @id @default(uuid())
  reporterId String?            // nullable + SetNull: report row sống qua account deletion (A3)
  reporter    User?             @relation("abuse_report_reporter", fields: [reporterId], references: [id], onDelete: SetNull)
  targetType report_target_type
  targetId   String
  reasonCode report_reason
  note       String?            // mô tả thêm của người báo cáo — untrusted input, cap ở action layer
  caseId     String
  moderationCase ModerationCase @relation(fields: [caseId], references: [id])
  createdAt  TimestamptzString  @default(now())

  @@unique([caseId, reporterId])   // một report/reporter/case — dedupe race-safe (Task 4)
  @@index([reporterId, createdAt])
  @@index([targetType, targetId])
  @@index([caseId, createdAt])
}

model ModerationCase {
  id                  String                 @id @default(uuid())
  targetType           report_target_type
  targetId            String
  state               moderation_case_state  @default(open)
  priority             moderation_priority    @default(normal)
  assignedModeratorId String?
  assignedModerator   User?                  @relation("moderation_case_assignee", fields: [assignedModeratorId], references: [id], onDelete: SetNull)
  reasonCategory      report_reason
  createdAt           TimestamptzString     @default(now())
  updatedAt           temporal.updatedAtString()

  reports  AbuseReport[]
  evidence ModerationEvidence[]
  actions  ModerationAction[]
  appeal   Appeal?              // one-to-one: Appeal.caseId @unique

  @@index([state, updatedAt])
  @@index([targetType, targetId])
  @@index([assignedModeratorId])
  // một case active duy nhất per (target, reason) — đóng race find-or-create (Task 4);
  // cú pháp where:/unique: theo .agents/skills/prisma-8/references/contract.md §index attributes
  @@index([targetType, targetId, reasonCategory], where: "(state IN ('open', 'triaged', 'investigating'))", unique: true, name: "moderation_case_one_active_per_target_reason")
}

// Evidence (spec §5.5.1) — immutable from product flows; SetNull FKs để evidence
// sống qua account deletion tương lai (A3); KHÔNG BAO GIỜ update/delete từ app flow.
model ModerationEvidence {
  id                 String            @id @default(uuid())
  caseId             String
  moderationCase     ModerationCase    @relation(fields: [caseId], references: [id])
  sourceResourceType String            // "listing" | "user" | "message"
  sourceResourceId   String
  capturedAt         TimestamptzString @default(now())
  relevantSnapshot    Json              // snapshot JSON tại thời điểm báo cáo — immutable
  subjectUserId      String?
  subject            User?             @relation("moderation_evidence_subject", fields: [subjectUserId], references: [id], onDelete: SetNull)
  reporterUserId     String?
  reporter           User?             @relation("moderation_evidence_reporter", fields: [reporterUserId], references: [id], onDelete: SetNull)
  classification     String            // reason category tại thời điểm capture

  @@index([caseId, capturedAt])
  @@index([sourceResourceType, sourceResourceId])
}

// Case-scoped action history (spec §5.5 "append audit history") — mọi case event
// append một row; KHÔNG update/delete. actor có thể là user thường (report/appeal)
// hoặc admin (transition/suspend) — AuditEvent riêng chỉ dành cho privileged actor.
model ModerationAction {
  id         String            @id @default(uuid())
  caseId     String?
  moderationCase ModerationCase? @relation(fields: [caseId], references: [id])
  actorId    String?
  actor      User?             @relation("moderation_action_actor", fields: [actorId], references: [id], onDelete: SetNull)
  actionType String            // typed registry: MODERATION_ACTION_TYPES (src/lib/moderation-vocab.ts)
  targetType String?
  targetId   String?
  reasonCode String?           // bắt buộc với action type là quyết định (transition/takedown/suspend/lift/assign)
  note       String?           // đã qua redactDetail tại write time — KHÔNG chứa PII thô
  createdAt  TimestamptzString @default(now())

  @@index([caseId, createdAt])
  @@index([actorId, createdAt])
  @@index([targetType, targetId, createdAt])
}

// Blocking (spec §5.5) — directional data, symmetric enforcement; KHÔNG xóa
// message/conversation — block chỉ chặn MỚI, không phá evidence.
model UserBlock {
  id        String            @id @default(uuid())
  blockerId String
  blocker    User              @relation("user_block_blocker", fields: [blockerId], references: [id], onDelete: Cascade)
  blockedId String
  blocked    User              @relation("user_block_blocked", fields: [blockedId], references: [id], onDelete: Cascade)
  createdAt TimestamptzString @default(now())

  @@unique([blockerId, blockedId])
  @@index([blockedId])
}

// Suspension (spec §7.8) — một row = một episode; active → lifted qua atomic claim;
// KHÔNG auto-expiry (policy duration = Ambiguity A2 — fail closed: indefinite).
model UserSuspension {
  id             String            @id @default(uuid())
  userId         String
  user           User              @relation("user_suspension_user", fields: [userId], references: [id], onDelete: Restrict) // explicit: xóa user đang bị đình chỉ bị chặn — account deletion là batch sau + quyết định A3
  status         suspension_status @default(active)
  reasonCode     String            // typed — SUSPENSION_REASON_CODES (src/lib/moderation-vocab.ts)
  note           String?           // đã qua redactDetail tại write time
  suspendedById  String?          // nullable + SetNull: row lịch sử sống qua admin deletion (A3)
  suspendedBy    User?             @relation("user_suspension_actor", fields: [suspendedById], references: [id], onDelete: SetNull)
  suspendedAt    TimestamptzString @default(now())
  liftedById     String?
  liftedBy       User?             @relation("user_suspension_lifter", fields: [liftedById], references: [id], onDelete: SetNull)
  liftedAt       TimestamptzString?
  liftReasonCode String?

  @@index([userId, status])
  @@index([status, suspendedAt])
  // một episode active duy nhất per user — đóng race double-suspend (Task 5)
  @@index([userId], where: "(status = 'active')", unique: true, name: "user_suspension_one_active")
}

// Appeal foundation (spec §9 Batch 3) — chỉ ghi nhận + state; decision workflow = A4.
model Appeal {
  id          String            @id @default(uuid())
  caseId      String            @unique
  moderationCase ModerationCase @relation(fields: [caseId], references: [id])
  appellantId String?           // nullable + SetNull: appeal sống qua account deletion (A3)
  appellant   User?             @relation("appeal_appellant", fields: [appellantId], references: [id], onDelete: SetNull)
  statement   String?           // lời trình bày của subject — untrusted input, cap ở action layer
  state       appeal_state      @default(submitted)
  createdAt   TimestamptzString @default(now())
  closedAt    TimestamptzString?
  updatedAt   temporal.updatedAtString()

  @@index([appellantId])
}
```

Then:

```bash
npx prisma contract emit
npx prisma migration plan --name batch3_trust_safety
```

- [ ] **Step 4: Review the package, self-emit**

- Confirm the plan output's `from:` line names the current `db`/`production` ref hash (the Batch 2 end hash), not `(baseline)` over a non-empty graph, and `pendingPlaceholders` is `false` (all new tables/columns are nullable-or-defaulted; the planner must not emit data-transform placeholders — if it does, stop and re-check the contract for accidental non-null columns).
- **R3:** advancing both refs in this commit is what lets Batch 4 plan `--from` this migration dir; `npx prisma migration list` must show exactly `baseline → batch2 → batch3` (linear — no node with two outgoing edges).
- `npx prisma migration show <dir>` — **expected operations**: `create`/`createIndex` for the new tables/indexes, **plus the `Listing_status_check_*` DROP + ADD pair** from the `removed` enum value (BLOCKING-2/R3 wording: a pg/text enum value lives in a CHECK constraint, so adding a value re-renders it — the pair is *additive in effect*; classify and continue). **Any DROP/ALTER of an existing column or table is a plan violation**: fix the contract instead.
- No data transform is added in Batch 3 (no legacy data to migrate).
- Self-emit: `node migrations/app/<dir>/migration.ts` (regenerates `ops.json` + `migrationHash`).
- Re-run `npx prisma migration show <dir>` — classify once more: only creates/createIndexes + the expected `Listing_status_check_*` pair.

- [ ] **Step 5: Apply to the dev DB and advance refs**

```bash
npx prisma db migrate --advance-ref db          # dev DB (DATABASE_URL từ .env, container 5435)
npx prisma migration ref set production <end-hash>   # end-hash = migration.json "to" — deploy target
npx prisma db verify
```

`production` ref must be advanced in the same commit: `docker-compose.prod.yml`'s migrate service applies the graph `--to production` (docs/deployment.md §2), so an unadvanced ref would silently skip the migration in production.

- [ ] **Step 6: Run the integration test to verify it passes**

Run: `npm run test:integration`
Expected: PASS (all `batch3-migration` cases + existing `escrow.test.ts` green).

- [ ] **Step 7: Commit**

```bash
git add src/prisma/contract.prisma src/prisma/contract.json src/prisma/contract.d.ts migrations/app migrations/snapshots tests/integration/batch3-migration.test.ts
git commit -m "feat(db): add batch 3 trust & safety contract"
```

**Gate:** no destructive op in `migration show` beyond the expected `Listing_status_check_*` DROP+ADD pair (additive in effect — BLOCKING-2); `db verify` clean; finance + Batch 2 integration invariants still green.

## Task 2: Moderation domain module — vocabularies, transitions, guards, snapshots

**Files:**

- Create: `src/lib/moderation-vocab.ts` (client-safe — pure vocabularies, zero db/server-only imports)
- Create: `src/lib/moderation.ts` (server-only guards; re-exports the vocab)
- Create: `src/lib/moderation-snapshot.ts`
- Test: `tests/unit/moderation.test.ts`

**Interfaces:**

- Consumes: `UserBlock`, `UserSuspension`, `ModerationCase`, `ModerationEvidence` models (Task 1); `db` from `@/src/prisma/db.client`.
- Produces (used by Tasks 3–7; the client components in Tasks 4/7 import **only** `moderation-vocab.ts`/`constants.ts`):

```ts
// src/lib/moderation-vocab.ts — PURE, client-safe (KHÔNG import db, KHÔNG "server-only",
// KHÔNG import rate-limit — REPORT_RATE_LIMIT dùng structural type). "use client" components
// (report-dialog, appeal-form) import từ đây; moderation.ts re-export cho server code.
export const REPORT_REASON_CODES = [
  "suspected_scam", "harassment", "spam", "counterfeit_claim",
  "misleading_listing", "prohibited_content", "unsafe_behavior",
  "identity_impersonation", "other",
] as const;                                  // spec §5.5 — verbatim, đúng thứ tự
export type ReportReasonCode = (typeof REPORT_REASON_CODES)[number];

export const REPORT_TARGET_TYPES = ["listing", "user", "message"] as const;
export type ReportTargetType = (typeof REPORT_TARGET_TYPES)[number];

export const MODERATION_CASE_STATES = [
  "open", "triaged", "investigating", "actioned", "dismissed", "appealed", "closed",
] as const;                                  // spec §5.5 — verbatim
export type ModerationCaseState = (typeof MODERATION_CASE_STATES)[number];

export const MODERATION_PRIORITIES = ["low", "normal", "high"] as const;
export type ModerationPriority = (typeof MODERATION_PRIORITIES)[number];

// Case còn "đang xử lý" — dùng cho grouping + dedupe (Scope Decisions)
export const ACTIVE_MODERATION_CASE_STATES = ["open", "triaged", "investigating"] as const;

// Bảng chuyển trạng thái hợp pháp (spec §5.5 states; transitions là mechanics —
// sanction/appeal POLICY là thứ không định nghĩa ở đây, xem Ambiguities A2/A4)
export const MODERATION_TRANSITIONS: Record<ModerationCaseState, readonly ModerationCaseState[]>;
//   open          → [triaged, investigating, dismissed, actioned]
//   triaged       → [investigating, actioned, dismissed]
//   investigating → [actioned, dismissed]
//   actioned      → [appealed, closed]
//   appealed      → [closed]
//   dismissed     → [closed]
//   closed        → []  (terminal)
export function canTransition(from: ModerationCaseState, to: ModerationCaseState): boolean;

// Lý do quyết định có kiểu (spec §5.5 "typed reasons") — vocabulary PROVISIONAL (A8):
// founder review có thể đổi giá trị qua thay đổi additive; KHÔNG phải policy.
export const MODERATION_DECISION_REASON_CODES = [
  "no_violation_found", "insufficient_evidence", "policy_violation_confirmed",
  "resolved_by_sanction", "duplicate_case", "appeal_closed", "other_reviewed_reason",
] as const;
export type ModerationDecisionReasonCode = (typeof MODERATION_DECISION_REASON_CODES)[number];

export const MODERATION_ASSIGNMENT_REASON_CODES = [
  "triage_assignment", "reassignment", "other_reviewed_reason",
] as const;                                  // PROVISIONAL (A8) — spec §5.5 đòi typed reason cho mọi admin action

export const SUSPENSION_REASON_CODES = [
  "confirmed_abuse", "confirmed_scam", "confirmed_harassment", "confirmed_spam",
  "prohibited_content", "terms_violation", "other_reviewed_reason",
] as const;                                  // PROVISIONAL (A8)
export type SuspensionReasonCode = (typeof SUSPENSION_REASON_CODES)[number];

export const MODERATION_ACTION_TYPES = [
  "evidence.captured", "case.assigned", "case.transitioned",
  "listing.taken_down", "user.suspended", "user.suspension_lifted", "appeal.recorded",
] as const;
export type ModerationActionType = (typeof MODERATION_ACTION_TYPES)[number];

// R5 — seller-side lock: các status mà seller KHÔNG được edit/toggle/delete
// (guard trong updateListingAction/toggleListingVisibilityAction/deleteListingAction, Task 6).
export const MODERATION_LOCKED_LISTING_STATUSES = ["removed"] as const;
export type ModerationLockedListingStatus = (typeof MODERATION_LOCKED_LISTING_STATUSES)[number];
export function isModerationLocked(status: string): boolean;
//   helper thay cho `.includes` trên readonly tuple — guard gọi isModerationLocked(listing.status);
//   Batch 4 rewire giữ nguyên helper này khi thêm call sites.
// NOTE (FD-3/A8): mọi constant PROVISIONAL ở trên mang marker `// PROVISIONAL (A8)` ngay cạnh
// khai báo — marker hiển thị trong code review; label maps trong src/lib/constants.ts mang
// marker tương tự. Founder-authored copy thay thế trước beta (Batch 8 register).

export const REPORT_RATE_LIMIT = { limit: 5, windowMs: 10 * 60_000 };   // 5 report / 10 phút / reporter
export const BLOCK_ACTION_RATE_LIMIT = { limit: 20, windowMs: 60_000 }; // 20 block/unblock / phút / user
export const CHAT_SEND_RATE_LIMIT = { limit: 30, windowMs: 60_000 };    // 30 tin / phút / user (Task 3)
export const REPORT_NOTE_MAX_LENGTH = 2000;
export const APPEAL_STATEMENT_MAX_LENGTH = 4000;
```

```ts
// src/lib/moderation.ts — server-only domain module (KHÔNG "use server" — không phải action).
// export * from "./moderation-vocab" (server consumers import mọi thứ từ đây cho tiện),
// cộng các guard đọc DB:
export * from "@/src/lib/moderation-vocab";

// ── §7.8 enforcement guards — actor-side, fail closed (P1: minimal set) ──
export async function isUserSuspended(userId: string): Promise<boolean>;
//   UserSuspension.where({ userId, status: "active" }).first() ≠ null
export async function getActiveSuspension(userId: string): Promise<{ id: string; reasonCode: string; suspendedAt: string } | null>;
export type BlockState = "none" | "viewer_blocked" | "other_blocked";
export async function getBlockState(viewerId: string, otherId: string): Promise<BlockState>;
//   viewer_blocked = UserBlock(blockerId: viewer, blockedId: other) tồn tại
//   other_blocked  = UserBlock(blockerId: other, blockedId: viewer) tồn tại
//   none           = không có hướng nào — UI dùng cho banner + nút unblock (chỉ hiện khi viewer_blocked)
export async function assertCanStartConversation(initiatorId: string, counterpartId: string): Promise<void>;
//   throw Error("ACCOUNT_SUSPENDED") nếu INITIATOR đang bị đình chỉ (spec §7.8 — actor)
//   throw Error("CHAT_BLOCKED") nếu có block theo bất kỳ hướng nào (spec §5.5)
//   Counterpart bị đình chỉ KHÔNG được check — không nằm trong §7.8 minimal set (A2)
export async function assertCanSendMessage(senderId: string, recipientId: string): Promise<void>;
//   throw Error("ACCOUNT_SUSPENDED") nếu SENDER đang bị đình chỉ; CHAT_BLOCKED như trên.
//   Recipient bị đình chỉ KHÔNG check (A2).
export async function getCaseSubjectUserId(targetType: ReportTargetType, targetId: string): Promise<string | null>;
//   listing → Listing.sellerId | user → targetId | message → Message.senderId | null nếu target đã biến mất
//   (fallback — Task 7 ưu tiên ModerationEvidence.subjectUserId bất biến khi có)
```

```ts
// src/lib/moderation-snapshot.ts — capture JSON evidence tại thời điểm báo cáo (spec §5.5.1)
export type CapturedSnapshot = {
  snapshot: Record<string, unknown>;   // ghi vào ModerationEvidence.relevantSnapshot (Json)
  subjectUserId: string | null;
};
export async function captureTargetSnapshot(
  targetType: ReportTargetType,
  targetId: string,
): Promise<CapturedSnapshot | null>;
//   null khi target không tồn tại — caller trả typed NOT_FOUND cho reporter.
//   listing → { kind: "listing", id, slug, title, description, price, condition, city,
//               status, categoryId, brandId, sellerId, imageUrls: string[], capturedAt }
//               subjectUserId = sellerId
//   user    → { kind: "user", id, name, bio, city, role, isVerifiedSeller, createdAt, capturedAt }
//               subjectUserId = targetId — KHÔNG email/phone (PII minimization — moderator
//               không có user.view_basic; email/phone chỉ hiện qua /admin/users cho super/ops)
//   message → { kind: "message", id, conversationId, senderId, body, imageUrl, createdAt, capturedAt }
//               subjectUserId = senderId — body LÀ evidence (§5.5.1), không phải analytics (§4.8)
//   capturedAt = new Date().toISOString() trong mọi snapshot.
```

- [ ] **Step 1: Write the failing unit tests**

`tests/unit/moderation.test.ts` (mock `server-only`, `@/src/prisma/db.client` with in-memory maps — same style as `tests/unit/session.test.ts` per Batch 2):

- `REPORT_REASON_CODES matches the spec §5.5 list verbatim` — exactly the nine values, in order.
- `MODERATION_CASE_STATES matches the spec §5.5 list verbatim` — exactly the seven values.
- `MODERATION_LOCKED_LISTING_STATUSES is exactly ["removed"]` (R5 — the seller-side lock vocabulary; Batch 4's rewire keeps this constant and extends only the guard call sites).
- `canTransition allows every legal pair and denies every illegal one` — table-driven over `MODERATION_TRANSITIONS`: each listed pair true; every unlisted pair false; `closed` has no outgoing transitions (terminal).
- `moderation-vocab is client-safe` — source-contract: `src/lib/moderation-vocab.ts` contains no `db.client`, no `server-only`, no `@/src/lib/rate-limit` import (B2 — the client dialog imports it).
- `isUserSuspended reads only active rows` — active row → true; lifted row → false; no row → false.
- `getBlockState reports the direction` — A blocks B → `viewer_blocked` for (A,B), `other_blocked` for (B,A); no rows → `none` (S11).
- `assertCanStartConversation throws ACCOUNT_SUSPENDED for a suspended INITIATOR and resolves for a suspended counterpart` — the actor-side minimal set pinned (P1): initiator suspended → throw; counterpart suspended → resolves (A2); block either direction → `CHAT_BLOCKED`.
- `assertCanSendMessage throws ACCOUNT_SUSPENDED for a suspended SENDER and resolves for a suspended recipient` — same actor-side pinning; block either direction → `CHAT_BLOCKED`.
- `suspension error wins over block error` — suspended initiator + block → `ACCOUNT_SUSPENDED` (ordering pinned).
- `getCaseSubjectUserId maps each target type` — listing → sellerId; user → targetId; message → senderId; missing target → null.
- `captureTargetSnapshot: listing snapshot carries content fields and sellerId, never reporter PII` — assert the JSON keys and `subjectUserId`.
- `captureTargetSnapshot: user snapshot has NO email or phone keys` (PII minimization contract — Review Focus 3 adjacent).
- `captureTargetSnapshot: message snapshot carries body and senderId` (the evidence point).
- `captureTargetSnapshot returns null for a missing target`.

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/unit/moderation.test.ts`
Expected: FAIL — `src/lib/moderation-vocab.ts` does not exist.

- [ ] **Step 3: Implement the three modules**

- `src/lib/moderation-vocab.ts`: every constant + `canTransition` (pure lookup) — **no db import, no `server-only`, no `rate-limit` import** (the rate-limit rules use structural `{ limit, windowMs }` types); this is the module client components import.
- `src/lib/moderation.ts`: `export * from "@/src/lib/moderation-vocab"` + the guard functions (plain `db` reads) + `getCaseSubjectUserId`. No `"use server"`; no client import; no logging of user content.
- `src/lib/moderation-snapshot.ts`: `captureTargetSnapshot` reads the target via `db` (listing includes its images ordered by `sortOrder`; message includes its conversation id; user selects public fields explicitly — never `email`/`phone`), builds the JSON object with `kind` + `capturedAt`, returns `{ snapshot, subjectUserId }` or null.

- [ ] **Step 4: Run tests until green**

Run: `npm test -- tests/unit/moderation.test.ts` → PASS. Then `npm test` → all existing suites green (no product surface changed yet).

- [ ] **Step 5: Commit**

```bash
git add src/lib/moderation-vocab.ts src/lib/moderation.ts src/lib/moderation-snapshot.ts tests/unit/moderation.test.ts
git commit -m "feat(moderation): trust & safety domain module"
```

## Task 3: Blocking + chat/conversation enforcement

**Files:**

- Create: `src/lib/actions/blocks.ts`
- Modify: `src/lib/actions/chat.ts` (guard in `startConversationAction`)
- Modify: `app/api/chat/[id]/route.ts` (guard in `POST`)
- Modify: `app/seller/[id]/page.tsx` (block/unblock form)
- Modify: `app/chat/[id]/page.tsx` (block banner + block/unblock form + `disabled` prop)
- Modify: `src/components/chat-window.tsx` (`disabled` prop on the composer)
- Modify: `app/profile/page.tsx` ("Danh sách chặn" section)
- Test: `tests/unit/block-actions.test.ts`
- Test: `tests/unit/chat-guard.test.ts`
- Test: `tests/integration/block-enforcement.test.ts`

**Interfaces:**

- Consumes: `UserBlock` model (Task 1), `assertCanStartConversation`/`assertCanSendMessage`/`getBlockState`/`isUserSuspended` + `BLOCK_ACTION_RATE_LIMIT`/`CHAT_SEND_RATE_LIMIT` (Task 2), `requireUser` (Batch 2 `src/lib/auth.ts`), `checkRateLimit`/`tooManyRequestsResponse` (existing).
- Produces (used by Task 4 UI and Batch 6 Deal guards):

```ts
// src/lib/actions/blocks.ts
"use server";
export async function blockUserAction(formData: FormData): Promise<void>;
//   formData: userId (người BỊ chặn) — requireUser;
//   rate limit: checkRateLimit(`block:${user.id}`, BLOCK_ACTION_RATE_LIMIT) → throw RATE_LIMITED;
//   userId === user.id → throw Error("CANNOT_BLOCK_SELF");
//   target không tồn tại → throw Error("NOT_FOUND");
//   upsert UserBlock { blockerId: user.id, blockedId: userId } theo @@unique — idempotent
//   (chặn lại khi đã chặn = no-op thành công); revalidatePath("/profile") + trang hiện tại.
export async function unblockUserAction(formData: FormData): Promise<void>;
//   formData: userId — requireUser; cùng rate limit bucket `block:${user.id}`;
//   delete UserBlock.where({ blockerId: user.id, blockedId: userId });
//   không có row → no-op thành công (idempotent); revalidatePath("/profile").
```

```ts
// src/lib/actions/chat.ts — startConversationAction thêm guard (giữ nguyên mọi chữ ký):
//   sau khi load listing + kiểm tra "tin của chính bạn", TRƯỚC existing-conversation lookup:
//   await assertCanStartConversation(user.id, listing.sellerId);
//   // throw CHAT_BLOCKED | ACCOUNT_SUSPENDED (actor-side: INITIATOR) → server action error
//   //   (fail closed — KHÔNG redirect vào hội thoại chết; user vẫn đọc lịch sử qua /chat/<id>
//   //   từ danh sách; counterpart bị đình chỉ KHÔNG bị chặn ở đây — A2)
```

```ts
// app/api/chat/[id]/route.ts — POST thêm send rate limit + guard (GET KHÔNG đổi — lịch sử
// đọc được khi blocked; GET đã có chat:poll limit):
//   sau participant check, trước Message.create:
//   const recipientId = convo.sellerId === user.id ? convo.buyerId : convo.sellerId;
//   const limited = checkRateLimit(`chat:send:${user.id}`, CHAT_SEND_RATE_LIMIT);
//   if (!limited.allowed) return tooManyRequestsResponse(limited.retryAfterSec);   // spec §7.1 "chat"
//   try { await assertCanSendMessage(user.id, recipientId); }
//   catch (e) { return Response.json({ error: e.message }, { status: 403 }); }
//   // e.message === "CHAT_BLOCKED" | "ACCOUNT_SUSPENDED" — typed, client hiển thị banner.
```

- [ ] **Step 1: Write the failing unit tests**

`tests/unit/block-actions.test.ts` (mock db with in-memory `UserBlock` + two user fixtures; `requireUser` fixture per the Global Constraints stubbing recipe; `resetRateLimits()` in `beforeEach`):

- `blockUserAction creates a directional UserBlock row` — `{blockerId: A, blockedId: B}`; blocking again → still exactly one row (idempotent upsert).
- `blocking yourself → CANNOT_BLOCK_SELF, no row`.
- `blocking a nonexistent user → NOT_FOUND, no row`.
- `block/unblock rate limit: 21st action within a minute → RATE_LIMITED, no mutation` (same bucket for both actions).
- `unblockUserAction deletes the row; unblocking when not blocked is a silent no-op`.
- `every action requires a session` — no cookie → redirect to login, no db write.
- `blocking performs no Message/Conversation mutation` — spy on `Message`/`Conversation` models: zero calls (spec §5.5 — blocking never destroys evidence/history).

`tests/unit/chat-guard.test.ts` (mock db: two users, one listing, one conversation; spy on model creates; `resetRateLimits()` in `beforeEach`):

- `startConversationAction with a buyer→seller block throws CHAT_BLOCKED and creates no Conversation` (Review Focus 1).
- `startConversationAction with a seller→buyer block (the conversation starter is the blocked one) also throws CHAT_BLOCKED` — symmetric enforcement.
- `startConversationAction with a suspended INITIATOR (buyer) throws ACCOUNT_SUSPENDED, no Conversation` (spec §7.8 actor-side).
- `startConversationAction with a suspended COUNTERPART (seller) still creates the Conversation` — counterpart-side blocking is NOT in §7.8's minimal set; pinned as intentionally absent (A2).
- `startConversationAction happy path still creates the Conversation` (guard does not over-block).
- `POST /api/chat/[id] with a block in either direction returns 403 CHAT_BLOCKED and creates no Message` (Review Focus 1 — direct route invocation, not the UI).
- `POST with a suspended SENDER returns 403 ACCOUNT_SUSPENDED, no Message`; `POST with a suspended RECIPIENT still delivers` (actor-side, A2).
- `POST send rate limit: 31st message within a minute → 429 with Retry-After, no Message created` (spec §7.1 "chat" — S1).
- `POST happy path still creates the Message and updates lastMessageAt`.
- `GET /api/chat/[id] still returns messages for a blocked pair` — history stays readable (spec §5.5: no silent deletion; read-only).

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/unit/block-actions.test.ts tests/unit/chat-guard.test.ts`
Expected: FAIL — `src/lib/actions/blocks.ts` missing; guards not wired.

- [ ] **Step 3: Implement actions + wire guards + UI**

- `src/lib/actions/blocks.ts` per the interface block; zod-validate `userId` (uuid string); typed error strings; rate limit first.
- `src/lib/actions/chat.ts`: insert `await assertCanStartConversation(user.id, listing.sellerId)` immediately after the self-listing check; nothing else changes.
- `app/api/chat/[id]/route.ts`: send rate limit + guard in `POST` per the interface block; `GET` untouched.
- `app/seller/[id]/page.tsx`: when `getCurrentUser()` is non-null and `user.id !== seller.id` → `getBlockState(user.id, seller.id)` → render `Chặn` (block form) when `none`, `Bỏ chặn` (unblock form) when `viewer_blocked`, nothing when `other_blocked` (you cannot unblock someone else's block). Public visitors see nothing (UI convenience; the actions enforce auth anyway).
- `app/chat/[id]/page.tsx`: `getBlockState(user.id, other.id)` + `isUserSuspended(user.id)` → render the direction-aware banner (`Bạn đã chặn người này` for `viewer_blocked` / `Người này đã chặn bạn` for `other_blocked` / `Tài khoản đang bị đình chỉ` for the suspended viewer) and pass `disabled={blockState !== "none" || suspended}` to `ChatWindow`; render the unblock form in the header **only when `viewer_blocked`**.
- `src/components/chat-window.tsx`: add optional `disabled?: boolean` prop — disables the input + send button and shows `Không thể gửi tin nhắn` in the placeholder. UI-only; the route is the boundary.
- `app/profile/page.tsx`: new "Danh sách chặn" card listing `blocksMade` (include `blocked` user name) with an unblock form per row; empty state copy `Bạn chưa chặn ai`.

- [ ] **Step 4: Run tests until green + integration**

Run: `npm test -- tests/unit/block-actions.test.ts tests/unit/chat-guard.test.ts` → PASS.
Run: `npm test` → full unit suite green (finance + Batch 2 suites untouched).
Run: `npm run test:integration` → `tests/integration/block-enforcement.test.ts` (new, real DB):

- `block prevents new conversation + new messages in both directions, unblock restores both` — seed users + listing + conversation; block buyer→seller; `startConversationAction` (new buyer) throws; `POST` both directions 403; `GET` still returns history; unblock; all allowed again.
- `suspension prevents the suspended user from starting conversations and sending messages — while their session stays alive` — `UserSuspension.create` directly (the admin action ships in Task 5); the suspended buyer's `startConversationAction`/`POST` throw `ACCOUNT_SUSPENDED` **with a valid session cookie** (P1: no revocation — the guard holds per-action); a *counterpart*-suspended conversation still delivers; lift → all allowed again.
- `blocking never deletes or mutates Conversation/Message rows` — row counts + bodies deep-equal before/after block.

- [ ] **Step 5: Commit**

```bash
git add src/lib/actions/blocks.ts src/lib/actions/chat.ts 'app/api/chat/[id]/route.ts' 'app/seller/[id]/page.tsx' 'app/chat/[id]/page.tsx' src/components/chat-window.tsx app/profile/page.tsx tests/unit/block-actions.test.ts tests/unit/chat-guard.test.ts tests/integration/block-enforcement.test.ts
git commit -m "feat(trust): user blocking with chat enforcement"
```

## Task 4: Report submission + case grouping + evidence capture

**Files:**

- Create: `src/lib/actions/reports.ts`
- Create: `src/components/report-dialog.tsx`
- Modify: `src/lib/constants.ts` (add `REPORT_REASON_LABELS`)
- Modify: `app/listings/[slug]/page.tsx` (report-listing dialog)
- Modify: `app/seller/[id]/page.tsx` (report-user dialog)
- Modify: `app/chat/[id]/page.tsx` (report-user dialog in header)
- Modify: `src/components/chat-window.tsx` (report-message dialog per message)
- Test: `tests/unit/report-actions.test.ts`
- Test: `tests/integration/report-evidence.test.ts`

**Interfaces:**

- Consumes: `AbuseReport`/`ModerationCase`/`ModerationEvidence`/`ModerationAction` models (Task 1), `REPORT_REASON_CODES`/`REPORT_RATE_LIMIT`/`REPORT_NOTE_MAX_LENGTH`/`ACTIVE_MODERATION_CASE_STATES` (Task 2), `captureTargetSnapshot` (Task 2), `requireUser` (Batch 2), `checkRateLimit` (existing).
- Produces (used by Task 6 console + Task 7 appeal):

```ts
// src/lib/actions/reports.ts
"use server";
export type ReportFormState = { error?: string; success?: string };

export async function submitReportAction(
  _prev: ReportFormState,
  formData: FormData,
): Promise<ReportFormState>;
//   formData: targetType, targetId, reasonCode, note?
//   1. requireUser (reporter authorization — spec §5.5)
//   2. validate: targetType ∈ REPORT_TARGET_TYPES; reasonCode ∈ REPORT_REASON_CODES;
//      note ≤ REPORT_NOTE_MAX_LENGTH → else typed form error, no db write
//   3. rate limit: checkRateLimit(`report:${user.id}`, REPORT_RATE_LIMIT)
//      → !allowed → { error: RATE_LIMITED } (spec §7.1 — report endpoint limit)
//   4. target authorization (spec §7.3 cross-account report access):
//      listing → tồn tại VÀ reporter ≠ listing.sellerId (tự báo cáo tin của mình → typed error)
//      user    → tồn tại và ≠ reporter
//      message → tồn tại VÀ reporter là participant của conversation (buyerId/sellerId)
//                VÀ reporter ≠ message.senderId (tự báo cáo tin nhắn của mình → typed error)
//      không đạt → { error: NOT_FOUND } — không tiết lộ gì thêm
//   5. dedupe (S3 — case-first, KHÔNG quét AbuseReport mò):
//      activeCase = ModerationCase.where({ targetType, targetId, reasonCategory: reasonCode })
//                   .where(state ∈ ACTIVE_MODERATION_CASE_STATES).first()
//      activeCase ≠ null VÀ AbuseReport.where({ caseId: activeCase.id, reporterId: user.id })
//      .first() ≠ null → { error: REPORT_ALREADY_SUBMITTED }
//   6. db.transaction (xem Global Constraints — Transaction constraint-violation rule:
//      violation LUÔN throw ra khỏi callback, classify NGOÀI tx, KHÔNG BAO GIỜ catch-and-return):
//      a. captureTargetSnapshot(targetType, targetId) TRƯỚC khi tạo bất kỳ row nào —
//         null → throw ra khỏi callback → { error: NOT_FOUND } (target biến mất giữa
//         validate và tx — fail closed)
//      b. RE-READ case grouping TRONG tx (không tin activeCase đọc ở bước 5):
//         ModerationCase.where({ targetType, targetId, reasonCategory: reasonCode })
//         .where(state ∈ ACTIVE_MODERATION_CASE_STATES).first() → có → dùng;
//         không → ModerationCase.create({ targetType, targetId, reasonCategory: reasonCode,
//         state: "open", priority: "normal" }) — concurrent report cùng target+reason thắng
//         trước → partial-index violation THROW ra khỏi callback
//      c. AbuseReport.create({ reporterId, targetType, targetId, reasonCode, note, caseId })
//         — concurrent double-submit của chính reporter → @@unique([caseId, reporterId])
//         violation THROW ra khỏi callback
//      d. ModerationEvidence.create({ caseId, sourceResourceType: targetType,
//         sourceResourceId: targetId, relevantSnapshot: snapshot, subjectUserId,
//         reporterUserId: user.id, classification: reasonCode })
//      e. ModerationAction.create({ caseId, actorId: user.id, actionType: "evidence.captured",
//         targetType, targetId, reasonCode })   // case-scoped history — actor là user thường
//   7. NGOÀI tx — classify (SqlQueryError, sqlState "23505" + constraint name):
//      "moderation_case_one_active_per_target_reason" → RETRY toàn bộ transaction MỘT lần
//        (bước 6b re-read giờ thấy case của người thắng → dùng case đó; nếu retry cũng vi
//        phạm → REPORT_ALREADY_SUBMITTED — fail closed)
//      "AbuseReport_caseId_reporterId_key" → { error: REPORT_ALREADY_SUBMITTED } (không retry)
//   8. return { success: "Đã gửi báo cáo..." } — KHÔNG tiết lộ trạng thái case/định danh
//      moderator cho reporter; KHÔNG auditEvent (Scope Decisions); KHÔNG telemetry (Batch 5).
```

```ts
// src/components/report-dialog.tsx — "use client", useActionState(submitReportAction)
// Props: { targetType: ReportTargetType; targetId: string; triggerLabel?: string; className?: string }
//   dialog: select reason (REPORT_REASON_LABELS từ src/lib/constants.ts), textarea note
//   (maxLength REPORT_NOTE_MAX_LENGTH), submit; hiển thị state.error/state.success;
//   đóng dialog sau success. KHÔNG render nội dung target vào dialog (chỉ label).
//   B2: import CHỈ từ src/lib/moderation-vocab.ts + src/lib/constants.ts — KHÔNG BAO GIỜ
//   import src/lib/moderation.ts (import db → "server-only" → client build break).
```

- [ ] **Step 1: Write the failing unit tests**

`tests/unit/report-actions.test.ts` (mock db with in-memory `AbuseReport`/`ModerationCase`/`ModerationEvidence`/`ModerationAction`/`Listing`/`User`/`Message`/`Conversation` maps; mock `captureTargetSnapshot` with a fixture snapshot; `resetRateLimits()` in `beforeEach`):

- `a valid listing report creates report + case + evidence + action in one tx` — assert all four rows with the exact fields (`reasonCode` verbatim, `classification === reasonCode`, `subjectUserId === sellerId`, `reporterUserId === reporter`).
- `reasonCode outside the enum → validation error, zero db writes`.
- `note longer than 2000 → validation error`.
- `rate limit: 6th report within 10 min → RATE_LIMITED` and no 6th row (Review Focus 4).
- `dedupe: an active case for (target, reason) where THIS reporter already reported → REPORT_ALREADY_SUBMITTED, no second report/case` (Review Focus 4 — case-first lookup, then `(caseId, reporterId)`).
- `dedupe does NOT fire after the case leaves active states` — case `actioned` → same report again → allowed, and grouping creates a NEW case (reporter can re-report after the case moved on).
- `grouping: a second reporter on the same target+reason joins the existing case` — one case, two reports, two evidence rows (spec §5.5 "may group multiple reports").
- `different reason on the same target → a separate case` (grouping key includes reasonCategory).
- `concurrent same-reporter double-submit → the ([caseId, reporterId]) violation THROWS out of the tx callback, is classified OUTSIDE (constraint name), and surfaces as REPORT_ALREADY_SUBMITTED — exactly one report row` (S4 + the Global Constraints transaction rule: the mock db simulates the 23505; a catch-and-return inside the callback would be a silent-success bug).
- `concurrent same-target-same-reason reports by two reporters → both land on ONE case` (the partial-index violation throws out, is classified outside, and the RETRY's re-read finds the winner's case; two reports, two evidence rows).
- `target checks: nonexistent listing/user/message → NOT_FOUND, zero writes` (no case created — not a probe oracle).
- `message report by a NON-participant → NOT_FOUND, zero writes` (spec §7.3 cross-account report access).
- `reporting your own user account / own listing / own sent message → typed error, zero writes` (three cases).
- `no session → redirect, zero db calls`.
- `snapshot null inside the tx → rollback, NOT_FOUND, zero rows` (fail closed on the race — capture happens before any create).

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/unit/report-actions.test.ts` → FAIL — module missing.

- [ ] **Step 3: Implement action + dialog + mounts**

- `src/lib/actions/reports.ts` per the interface block. Dedupe is case-first (S3): find the active case by the grouping key, then `AbuseReport.where({ caseId, reporterId }).first()`. The transaction body (capture → **re-read the active case inside the tx** → find-or-create → report → evidence → action) **never catches a constraint violation** — violations throw out of the callback; the action classifies OUTSIDE by `SqlQueryError.sqlState === "23505"` + constraint name: `moderation_case_one_active_per_target_reason` → retry the whole tx once (the re-read finds the winner's case), `AbuseReport_caseId_reporterId_key` → `REPORT_ALREADY_SUBMITTED` (Global Constraints — Transaction constraint-violation rule).
- `src/lib/constants.ts`: add `REPORT_REASON_LABELS: Record<ReportReasonCode, string>` (type imported from `moderation-vocab.ts` — client-safe) — Vietnamese labels for the nine codes (e.g. `suspected_scam: "Nghi lừa đảo"`, `harassment: "Quấy rối"`, `spam: "Spam"`, `counterfeit_claim: "Nghi hàng giả"`, `misleading_listing: "Tin đăng sai sự thật"`, `prohibited_content: "Nội dung bị cấm"`, `unsafe_behavior: "Hành vi không an toàn"`, `identity_impersonation: "Mạo danh"`, `other: "Khác"`).
- `src/components/report-dialog.tsx` per the interface block (plain React dialog, no library; imports only `moderation-vocab.ts` + `constants.ts`).
- Mounts (render only for a logged-in, non-self user): `app/listings/[slug]/page.tsx` → `targetType="listing" targetId={listing.id}` (hidden from the listing's own seller); `app/seller/[id]/page.tsx` → `targetType="user"`; `app/chat/[id]/page.tsx` header → `targetType="user" targetId={other.id}`; `src/components/chat-window.tsx` → per-message small `Báo cáo` affordance opening `targetType="message" targetId={m.id}` (hidden on the sender's own messages).

- [ ] **Step 4: Run tests until green + integration**

Run: `npm test -- tests/unit/report-actions.test.ts` → PASS. Then `npm test` → suite green.
Run: `npm run test:integration` → `tests/integration/report-evidence.test.ts` (new, real DB — the **immutable-evidence gate**; per the Global Constraints stubbing recipe — `requireUser` fixture, `next/cache`/`next/navigation` mocked):

- `report → edit source → evidence deep-equal`: seed seller+listing → `submitReportAction` → **mutate the listing via `db` directly** (`Listing.where({id}).update({title, price, description})` — NOT `updateListingAction`, which routes through the Batch 2 publication gate and `redirect()`; the evidence invariant is about the source *row* changing, whoever changed it) → assert the listing row actually changed (title differs) → read `ModerationEvidence` → `relevantSnapshot` **deep-equals** the pre-edit capture (jsonb comparison — title/price inside the snapshot unchanged).
- `report → delete source → evidence survives, case readable`: `db.orm.public.Listing.where({id}).delete()` on the reported listing → `ModerationEvidence` row still exists with a deep-equal snapshot; `ModerationCase` + `AbuseReport` still readable (no cascade) (Review Focus 2 — the §5.5.1 immutability gate).
- `message report evidence survives and stays deep-equal after the conversation gains new messages` — new messages do not touch existing evidence.
- `grouping + concurrency against the real DB`: two reporters, same target+reason → one case, two reports, two evidence rows; different reason → second case; two *concurrent* same-reporter submits (Promise.all) → **exactly one persisted report row, read back after both settle** (proves no silent-success/aborted-tx path — the loser's violation was thrown out and classified outside as `REPORT_ALREADY_SUBMITTED`); two *concurrent* same-target-same-reason submits by two reporters (Promise.all) → **one case, two reports** (the loser's case-create violation → retry → the re-read finds the winner's case).

- [ ] **Step 5: Commit**

```bash
git add src/lib/actions/reports.ts src/components/report-dialog.tsx src/lib/constants.ts 'app/listings/[slug]/page.tsx' 'app/seller/[id]/page.tsx' 'app/chat/[id]/page.tsx' src/components/chat-window.tsx tests/unit/report-actions.test.ts tests/integration/report-evidence.test.ts
git commit -m "feat(trust): abuse reports with evidence snapshots"
```

## Task 5: User suspension + publication-gate extension

**Files:**

- Create: `src/lib/actions/moderation.ts`
- Modify: `src/lib/rbac.ts` (add `"user.suspend"` to `STEP_UP_CAPABILITIES` — the one Batch 3 extension, spec §5.4.2 interpretation recorded as A9)
- Modify: `tests/unit/admin-mfa-login.test.ts` (extend the `requireCapabilityWithStepUp` parameterization — Batch 2 file)
- Modify: `src/lib/seller-verification-policy.ts` (8th publication requirement)
- Modify: `src/lib/actions/listings.ts` (missing-requirement label for `account_not_suspended` — Batch 2 gate catch site)
- Modify: `src/lib/actions/seller-verification.ts` (submit refuses suspended users — Batch 2 file)
- Modify: `app/sell/verification/page.tsx` (checklist shows the suspension requirement — Batch 2 file)
- Modify: `tests/unit/seller-verification-policy.test.ts` (extend — Batch 2 file)
- Modify: `tests/unit/publication-gate.test.ts` (extend — Batch 2 file)
- Modify: `tests/unit/seller-verification-actions.test.ts` (extend — Batch 2 file; submit refuses suspended users)
- Modify: `app/admin/users/page.tsx` (suspend/lift forms + active-suspension badge)
- Test: `tests/unit/suspension-actions.test.ts`
- Test: `tests/integration/suspension-enforcement.test.ts`

**Interfaces:**

- Consumes: `UserSuspension`/`ModerationCase`/`ModerationAction` models (Task 1), `SUSPENSION_REASON_CODES`/`isUserSuspended`/`getCaseSubjectUserId` (Task 2), `requireCapability` + `requireCapabilityWithStepUp` + `AdminContext` (Batch 2 `src/lib/rbac.ts`), `auditEventTx` + `redactDetail` (Batch 2 `src/lib/audit-event.ts`), `checkSellerPublicationRequirements` (Batch 2 `src/lib/seller-verification-policy.ts`), `notify` (existing). **No `revokeAllUserSessions`** — P1: session revocation without a login block is pointless and a login block is sanction policy (A2).
- Produces (used by Task 6 console + Batch 6 Deal guards):

```ts
// src/lib/actions/moderation.ts
"use server";
export async function suspendUserAction(formData: FormData): Promise<void>;
//   formData: userId, reasonCode, note?, caseId?, totpCode?
//   1. const ctx = await requireCapabilityWithStepUp("user.suspend", totpCode);
//      // super_admin + operations_admin THEO fail-closed matrix (Batch 2 tests/unit/rbac.test.ts).
//      // moderator/support KHÔNG có capability ("Scoped" chưa định nghĩa — Ambiguities A1) —
//      // action từ chối kể cả khi form chưa render.
//      // STEP-UP (spec §5.4.2 "destructive account action" — interpretation A9): stale
//      // step-up + không totpCode → STEP_UP_REQUIRED; mã sai → MFA_CODE_INVALID (Batch 2 guard).
//   2. validate reasonCode ∈ SUSPENSION_REASON_CODES; note → redactDetail(note) TRƯỚC khi lưu
//      vào cả ModerationAction.note LẪN AuditEvent.detail (write-time redaction).
//   3. target tồn tại; target.adminRole != null → throw Error("ADMIN_ACCOUNT_USE_ROLE_MANAGEMENT")
//      (A6 — admin lockout thuộc runbook Batch 2); target.id === ctx.user.id → CANNOT_SUSPEND_SELF.
//   4. caseId? → load case (S5): case phải tồn tại; SUBJECT MATCH (SHOULD-FIX 2 — không yêu
//      cầu targetType === "user"): subjectUserId = ModerationEvidence.where({ caseId })
//      .select("subjectUserId").first()?.subjectUserId ?? getCaseSubjectUserId(case.targetType,
//      case.targetId) — yêu cầu subjectUserId === userId (case về listing/message có subject
//      là seller/sender — moderator treo đúng người đó); case.state ∈ [open, triaged,
//      investigating, actioned] — dismissed/appealed/closed → throw Error("CASE_NOT_ACTIONABLE").
//      Actor conflict (S9): ctx.user.id là subject hoặc reporter của case → MODERATOR_CONFLICT.
//   5. db.transaction (violation LUÔN throw ra khỏi callback — Global Constraints):
//        UserSuspension.create({ userId, status: "active", reasonCode, note,
//          suspendedById: ctx.user.id, suspendedAt: now })
//          — concurrent double-suspend → partial-index violation (user_suspension_one_active)
//          THROW ra khỏi callback; classify NGOÀI tx (sqlState 23505 + constraint name)
//          → throw Error("USER_ALREADY_SUSPENDED")
//        caseId? && case.state ∈ [open, triaged, investigating] →
//          ModerationCase.updateAll({ state: "actioned" }).where({ id: caseId, state: <đọc được> })
//          → 0 rows → rollback + CASE_ALREADY_MOVED (S6: sanction atomic với actioned —
//          appeal link người dùng nhận được trỏ vào case ĐANG actioned)
//          + ModerationAction(case.transitioned, reasonCode: "resolved_by_sanction")
//        ModerationAction.create({ caseId, actorId: ctx.user.id, actionType: "user.suspended",
//          targetType: "user", targetId: userId, reasonCode })
//        auditEventTx(tx, { actorId: ctx.user.id, subjectId: userId,
//          action: "moderation.user_suspended", resourceType: "user", resourceId: userId,
//          reason: reasonCode, sessionId: ctx.session.id,
//          detail: caseId ? redactDetail(`case:${caseId}`) : undefined })
//      }
//      // KHÔNG revokeAllUserSessions (P1/A2) — guard đọc DB mỗi action là enforcement.
//   6. notify(userId, "moderation", "Tài khoản bị tạm đình chỉ", <reason label>, undefined)
//      // copy là PLACEHOLDER (FD-3) — sanction-notification wording là founder-authored
//      // content (Batch 8 register); label từ SUSPENSION_REASON_LABELS mang marker PROVISIONAL (A8).
//      // link /appeal/<caseId> KHÔNG gửi ở task này — page thuộc Task 7; Task 7 thêm link
//      // vào notify call-site này (không commit nào có dead link).
export async function liftSuspensionAction(formData: FormData): Promise<void>;
//   formData: suspensionId, reasonCode, note?
//   1. requireCapability("user.suspend") — KHÔNG step-up: lift là hướng khôi phục, không
//      "destructive account action" (§5.4.2) — recorded decision (Scope Decisions).
//   2. validate reasonCode ∈ SUSPENSION_REASON_CODES; note → redactDetail như trên.
//   3. db.transaction {
//        ĐỌC suspension row TRƯỚC (E2: cần userId cho ModerationAction.targetId +
//        audit subjectId) — row không tồn tại → throw Error("SUSPENSION_NOT_FOUND")
//        ATOMIC CLAIM: updateAll({ status: "lifted", liftedById: ctx.user.id, liftedAt: now,
//          liftReasonCode: reasonCode }).where({ id: suspensionId, status: "active" })
//          → 0 rows → throw Error("SUSPENSION_ALREADY_LIFTED") (concurrent lift)
//        ModerationAction.create({ actorId, actionType: "user.suspension_lifted",
//          targetType: "user", targetId: row.userId, reasonCode })
//        auditEventTx(tx, ... "moderation.user_suspension_lifted" ...)   // cùng tx với claim
//      }
```

```ts
// src/lib/seller-verification-policy.ts — Batch 2 interface MỞ RỘNG (spec §7.8):
export type SellerPublicationRequirement =
  | "email_verified" | "phone_verified" | "seller_type_declared"
  | "operating_location_declared" | "seller_rules_accepted"
  | "founding_seller_membership_active" | "operations_review_verified"
  | "account_not_suspended";   // MỚI — Batch 3
// checkSellerPublicationRequirements đọc thêm:
//   UserSuspension.where({ userId: sellerId, status: "active" }).first() ≠ null
//   → missing.push("account_not_suspended")
// assertSellerPublicationAllowed giữ nguyên chữ ký — throw SELLER_PUBLICATION_BLOCKED:<missing>
// (Batch 2 tests "seven requirements" → ĐỔI thành eight trong cùng commit này —
//  đây là amendment có chủ đích của Batch 2 plan, ghi rõ trong commit message)
```

- [ ] **Step 1: Write the failing unit tests**

`tests/unit/suspension-actions.test.ts` (mock db + `getSessionFromCookie` per role; spy on `auditEventTx`, `notify`; **no `revokeAllUserSessions` spy — it must never be called**, P1):

- `moderator → FORBIDDEN, no mutation` (no `user.suspend` — **moderator permission gate**, spec §9 Batch 3; Ambiguities A1 fail-closed).
- `support → FORBIDDEN`; `analyst → FORBIDDEN`; non-admin → FORBIDDEN (four cases).
- `operations_admin with a valid TOTP suspends: row + ModerationAction + AuditEvent appended, seller notified, ZERO session revocation` — assert `revokeAllUserSessions` is **not** imported/called (P1 pinned).
- `stale step-up without totpCode → STEP_UP_REQUIRED, no mutation` (spec §5.4.2 destructive account action — **admin step-up gate**; interpretation A9).
- `stale step-up + wrong totpCode → MFA_CODE_INVALID, no mutation`.
- `lift does NOT require step-up` — operations_admin with a stale step-up lifts successfully (recorded decision, Scope Decisions).
- `reasonCode outside SUSPENSION_REASON_CODES → typed error, zero writes`.
- `suspending an admin account → ADMIN_ACCOUNT_USE_ROLE_MANAGEMENT` (A6).
- `suspending yourself → CANNOT_SUSPEND_SELF`.
- `double suspend → USER_ALREADY_SUSPENDED, still one row` (the partial-index violation throws out of the tx callback; classified outside by constraint name — S4 + the Global Constraints transaction rule).
- `suspend with caseId: case SUBJECT mismatch → typed error, zero writes` (S5 — the sanction target must be the case's subject, from `ModerationEvidence.subjectUserId` with live fallback; a case whose subject is someone else cannot be attached).
- `suspend with caseId: case in dismissed/appealed/closed → CASE_NOT_ACTIONABLE` (S5).
- `suspend with caseId on an open case → case atomically becomes actioned + a case.transitioned action (resolved_by_sanction) is appended` (S6).
- `suspend with caseId where the case moved concurrently → CASE_ALREADY_MOVED, suspension rolled back` (atomic claim).
- `actor who is the case subject or a reporter → MODERATOR_CONFLICT, zero writes` (S9 fail-closed).
- `lift: atomic claim succeeds → status lifted + action + audit appended`; `lift on an already-lifted row → SUSPENSION_ALREADY_LIFTED`; `lift on a missing row → SUSPENSION_NOT_FOUND` (E2 — the row is read first for `targetId`).
- `admin note passes through redactDetail into BOTH AuditEvent.detail AND ModerationAction.note` — a note containing an email address is stored masked in both (write-time redaction).

Extend `tests/unit/admin-mfa-login.test.ts` (Batch 2 file — same commit): the `requireCapabilityWithStepUp` parameterization gains `"user.suspend"` — `STEP_UP_CAPABILITIES` includes it; stale step-up without a code → `STEP_UP_REQUIRED`; with a valid code → passes and marks the session stepped-up.

Extend `tests/unit/seller-verification-actions.test.ts` (Batch 2 file — same commit, S10): `submitSellerVerificationAction` for a suspended user → typed error listing `account_not_suspended`, no `SellerVerification` row created (the 8th requirement is a *submit* prerequisite too — a suspended user cannot enter the verification queue).

Extend `tests/unit/seller-verification-policy.test.ts` (Batch 2 file — same commit):

- `check returns ok only when all EIGHT requirements hold` — update the Batch 2 table-driven case: removing any one field → exactly that requirement in `missing`.
- `active suspension → missing account_not_suspended` (spec §7.8).
- `lifted suspension → NOT missing` (only active rows block).

Extend `tests/unit/publication-gate.test.ts` (Batch 2 file — same commit):

- `createListingAction: suspended seller → typed error, no Listing.create` (Review Focus 5).
- `updateListingAction: content-change → pending blocked for a suspended seller`.
- `toggleListingVisibilityAction: hidden → approved blocked for a suspended seller` (silent return, status unchanged).
- `approveListingAction (admin): approving a listing whose seller is suspended → no approval + audit "listing.approve_blocked"` (defense-in-depth).
- `all four pass when the seller is unsuspended` (guard does not over-block).

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/unit/suspension-actions.test.ts tests/unit/seller-verification-policy.test.ts tests/unit/publication-gate.test.ts tests/unit/seller-verification-actions.test.ts`
Expected: FAIL — `src/lib/actions/moderation.ts` missing; policy extension missing; the three extended Batch 2 suites fail red on the new cases (the 8th requirement, the suspended-submit refusal, the suspended-seller gate cases).

- [ ] **Step 3: Implement**

- `src/lib/rbac.ts`: add `"user.suspend"` to `STEP_UP_CAPABILITIES` — the single Batch 3 edit to that file (spec §5.4.2 "destructive account action", interpretation recorded as A9); no capability, role, or matrix change.
- `src/lib/actions/moderation.ts` per the interface block. Guard order in `suspendUserAction`: capability+step-up → validation → target checks → case checks (S5) → tx (suspension + atomic case→actioned + action + audit) → notify. **No session revocation anywhere** (P1).
- `src/lib/seller-verification-policy.ts`: add `account_not_suspended` to the union + the active-suspension read in `checkSellerPublicationRequirements`. **No signature changes** — `assertSellerPublicationAllowed` and the error format stay identical; only the missing-list can gain one value.
- `src/lib/actions/listings.ts` (S10): the Batch 2 gate catch renders the missing requirements in Vietnamese — add the `account_not_suspended` label (`Tài khoản đang bị đình chỉ`) to that label map so the seller sees a readable error.
- `src/lib/actions/seller-verification.ts` (S10): `submitSellerVerificationAction` gains the suspension prerequisite (typed error listing it) — a suspended user cannot enter the verification queue.
- `app/sell/verification/page.tsx` (S10): the requirement checklist gains the suspension line (rendered from the live `isUserSuspended` read).
- `app/admin/users/page.tsx`: per-user active-suspension badge (`Đình chỉ` when an active `UserSuspension` exists) + suspend form (reason select from `SUSPENSION_REASON_CODES`, note, TOTP field for step-up) and lift form (reason select) — rendered only when `capabilitiesOf(user.adminRole).includes("user.suspend")` (super/ops; UI convenience — the action enforces anyway). Replaces nothing; adds a column to the existing table.

- [ ] **Step 4: Run tests until green + integration**

Run: `npm test -- tests/unit/suspension-actions.test.ts tests/unit/seller-verification-actions.test.ts tests/unit/seller-verification-policy.test.ts tests/unit/publication-gate.test.ts tests/unit/admin-mfa-login.test.ts` → PASS.
Run: `npm test` → full suite green (Batch 2 gate tests updated, not weakened — the eight-requirement case replaces seven).
Run: `npm run test:integration` → `tests/integration/suspension-enforcement.test.ts` (new, real DB):

- `suspend → chat denied + publication gate missing account_not_suspended — with a LIVE session` — seed a seller satisfying the **seven Batch 2 requirements** (reuse the Batch 2 integration fixtures pattern); `suspendUserAction` (operations_admin session + valid TOTP) → the seller's `startConversationAction`/`POST` throw `ACCOUNT_SUSPENDED` **while their session cookie stays valid** (P1: no revocation — the guards hold per-action); `checkSellerPublicationRequirements` → `{ ok: false, missing: ["account_not_suspended"] }`; `submitSellerVerificationAction` → typed error.
- `lift → all restored` — chat allowed; gate `{ ok: true, missing: [] }`.
- `suspension is enforced fresh from the DB, not from session state` — a second app-level call after suspension (no cache) denies.
- `concurrent double-suspend → exactly one active suspension row (read back after both settle — no silent-success path), loser gets USER_ALREADY_SUSPENDED` (the partial-index violation throws out of the tx callback and is classified outside — S4 + the Global Constraints transaction rule).

- [ ] **Step 5: Commit**

```bash
git add src/lib/actions/moderation.ts src/lib/rbac.ts src/lib/seller-verification-policy.ts src/lib/actions/listings.ts src/lib/actions/seller-verification.ts app/sell/verification tests/unit/suspension-actions.test.ts tests/unit/admin-mfa-login.test.ts tests/unit/seller-verification-actions.test.ts tests/unit/seller-verification-policy.test.ts tests/unit/publication-gate.test.ts app/admin/users/page.tsx tests/integration/suspension-enforcement.test.ts
git commit -m "feat(moderation): user suspension and publication gate"
```

## Task 6: Moderation console — queue, case detail, assignment, transitions, takedown

**Files:**

- Modify: `src/lib/actions/moderation.ts` (add `assignModerationCaseAction`, `transitionModerationCaseAction`, `takeDownListingAction`)
- Modify: `src/lib/actions/listings.ts` (R5 seller-side lock guards + **conditional writes** in `updateListingAction`, `toggleListingVisibilityAction`, `deleteListingAction`)
- Modify: `src/lib/actions/admin.ts` (R5/R7 — **conditional pending-only writes** in `approveListingAction`/`rejectListingAction`: a just-removed listing can never be resurrected by a racing approval)
- Create: `app/admin/moderation/page.tsx` (case queue)
- Create: `app/admin/moderation/[id]/page.tsx` (case detail)
- Modify: `app/admin/layout.tsx` (nav entry `Báo cáo & kiểm duyệt` — `report.resolve`-filtered)
- Modify: `src/lib/constants.ts` (add `MODERATION_CASE_STATE_LABELS`, `MODERATION_PRIORITY_LABELS`, `SUSPENSION_REASON_LABELS`, `MODERATION_DECISION_REASON_LABELS`, **`LISTING_STATUS_LABELS.removed` + `LISTING_STATUS_BADGE.removed`** — R8)
- Test: `tests/unit/moderation-actions.test.ts`
- Test: `tests/unit/moderation-pages.test.ts`
- Test: `tests/unit/listing-lock.test.ts` (R5)

**Interfaces:**

- Consumes: `ModerationCase`/`ModerationAction`/`ModerationEvidence`/`AbuseReport` models (Task 1), `MODERATION_TRANSITIONS`/`canTransition`/`MODERATION_DECISION_REASON_CODES`/`MODERATION_ASSIGNMENT_REASON_CODES`/`getCaseSubjectUserId` (Task 2), `requireCapability`/`capabilitiesOf` (Batch 2), `auditEventTx`/`redactDetail`/`auditEvent` (Batch 2), `suspendUserAction`/`liftSuspensionAction` (Task 5), `notify` (existing).
- Produces (used by Task 7 appeal section + Task 8 audit filter):

```ts
// src/lib/actions/moderation.ts (thêm)
export async function assignModerationCaseAction(formData: FormData): Promise<void>;
//   formData: caseId, moderatorId, reasonCode
//   1. const ctx = await requireCapability("report.resolve");  // super/ops/moderator ✓
//   2. validate reasonCode ∈ MODERATION_ASSIGNMENT_REASON_CODES (spec §5.5 typed reasons —
//      vocabulary PROVISIONAL A8); assignee tồn tại +
//      capabilitiesOf(assignee.adminRole).includes("report.resolve")
//      → else throw Error("ASSIGNEE_NOT_ELIGIBLE")  // analyst làm assignee → chặn
//   3. đọc case → state === "closed" → throw Error("CASE_CLOSED") (S8 — không assign case đã đóng)
//      actor là subject/reporter của case → throw Error("MODERATOR_CONFLICT") (S9)
//   4. db.transaction {                                    // (S8 — một tx)
//        CAS trên assignee cũ: ModerationCase.updateAll({ assignedModeratorId: moderatorId })
//        .where({ id: caseId, state: case.state })
//        .where((c) => case.assignedModeratorId == null
//          ? c.assignedModeratorId.isNull()          // Prisma 8: NULL khớp qua isNull(), không qua { field: null }
//          : c.assignedModeratorId.eq(case.assignedModeratorId))
//        → 0 rows → throw Error("CASE_ASSIGNMENT_CONFLICT")  // concurrent assign
//        ModerationAction.create({ caseId, actorId: ctx.user.id, actionType: "case.assigned",
//          targetType: "moderation_case", targetId: caseId, reasonCode, note: null })
//        auditEventTx(tx, { action: "moderation.case_assigned", resourceType: "moderation_case",
//          resourceId: caseId, actorId: ctx.user.id, reason: reasonCode, sessionId: ctx.session.id })
//      }

export async function transitionModerationCaseAction(formData: FormData): Promise<void>;
//   formData: caseId, toState, reasonCode, note?, priority?
//   1. const ctx = await requireCapability("report.resolve");
//   2. validate toState ∈ MODERATION_CASE_STATES; reasonCode ∈ MODERATION_DECISION_REASON_CODES;
//      priority? ∈ MODERATION_PRIORITIES; note → redactDetail TRƯỚC khi lưu vào
//      ModerationAction.note LẪN AuditEvent.detail (write-time).
//   3. đọc case → canTransition(case.state, toState) → false → throw Error("INVALID_TRANSITION")
//      (closed → mọi thứ bị chặn; dismissed → chỉ closed; appealed → chỉ closed)
//      actor là subject/reporter của case → throw Error("MODERATOR_CONFLICT") (S9)
//   4. db.transaction {                                    // (S8 — MỘT tx cho 4→6)
//        ATOMIC CLAIM: updateAll({ state: toState, priority: priority ?? case.priority })
//        .where({ id: caseId, state: case.state }) → 0 rows → throw Error("CASE_ALREADY_MOVED")
//        (concurrent moderator — spec §10.1 "Concurrent ... update")
//        toState === "closed" && case.state === "appealed" →
//          Appeal.updateAll({ state: "closed", closedAt: now }).where({ caseId, state: "submitted" })
//          (bookkeeping cho appeal — decision POLICY vẫn là A4)
//        ModerationAction.create({ caseId, actorId, actionType: "case.transitioned",
//          reasonCode, note }) + auditEventTx(... "moderation.case_transitioned" ...)
//      }

export async function takeDownListingAction(formData: FormData): Promise<void>;
//   formData: listingId, reasonCode, note?, caseId?
//   1. const ctx = await requireCapability("listing.moderate");  // super/ops/moderator ✓
//   2. reasonCode ∈ MODERATION_DECISION_REASON_CODES; note → redactDetail (write-time).
//   3. caseId? → load case (S5): tồn tại, case.targetType === "listing" &&
//      case.targetId === listingId, case.state ∈ [open, triaged, investigating, actioned]
//      → else CASE_NOT_ACTIONABLE; actor subject/reporter → MODERATOR_CONFLICT (S9).
//   4. db.transaction {
//        ĐỌC listing TRƯỚC (SHOULD-FIX 5): Listing.where({ id: listingId }).first() →
//        previousStatus = listing.status (ghi vào AuditEvent.detail — "prev:<status>" —
//        cho A4 restore tương lai); row không tồn tại → throw Error("LISTING_NOT_FOUND")
//        ATOMIC (R4): updateAll({ status: "removed" })
//        .where({ id: listingId }).where((l) => l.status.in(["approved", "hidden", "pending"]))
//        // Prisma 8: mệnh đề IN qua callback (l) => l.status.in([...]) — như escrow.test.ts
//        → 0 rows → throw Error("LISTING_NOT_TAKEDOWN_ELIGIBLE")
//        // R4: KHÔNG BAO GIỜ viết rejected/rejectionReason — lý do nằm trong ModerationAction
//        // như typed code. Claim CẢ hidden (seller tự ẩn để né) LẪN pending (gỡ khỏi hàng
//        // duyệt) — KHÔNG chỉ approved. "removed" bị khóa seller-side qua
//        // MODERATION_LOCKED_LISTING_STATUSES (R5, guard ở listings.ts — cùng task này).
//        // KHÔNG đụng finance.
//        caseId? && case.state ∈ [open, triaged, investigating] →
//          ModerationCase.updateAll({ state: "actioned" }).where({ id: caseId, state: <đọc được> })
//          → 0 rows → rollback + CASE_ALREADY_MOVED (S6) + ModerationAction(case.transitioned,
//          "resolved_by_sanction")
//        ModerationAction.create({ caseId, actorId, actionType: "listing.taken_down",
//          targetType: "listing", targetId: listingId, reasonCode, note })
//        + auditEventTx(... "moderation.listing_taken_down" ...,
//          detail: redactDetail(`case:${caseId} prev:${previousStatus}`))   // prev cho A4 restore
//      }
//   5. notify(sellerId, "listing", "Tin bị gỡ khỏi hiển thị", <reason label>, "/sell/my")
//      // copy là PLACEHOLDER (FD-3) — takedown-notification wording là founder-authored
//      // content (Batch 8 register). link /appeal/<caseId> KHÔNG gửi ở task này — Task 7 thêm
//      // (không dead link giữa các commit)
```

- [ ] **Step 1: Write the failing unit tests**

`tests/unit/moderation-actions.test.ts` (mock db + role-stubbed `getSessionFromCookie`; spy on `auditEventTx`, `ModerationAction.create`):

- `assign: moderator (report.resolve) → assigned + action (with typed assignment reason) + audit appended` (**moderator permission gate** — moderator CAN work cases).
- `assign: analyst → FORBIDDEN`; `support → FORBIDDEN`; non-admin → FORBIDDEN` (spec §9 Batch 3 moderator permission tests).
- `assign: ineligible assignee (analyst id) → ASSIGNEE_NOT_ELIGIBLE, no update`.
- `assign: closed case → CASE_CLOSED, no update` (S8).
- `assign: concurrent second assign → CASE_ASSIGNMENT_CONFLICT` (CAS on the previous assignee, S8).
- `assign/transition/takedown by an actor who is the case subject or a reporter → MODERATOR_CONFLICT, zero writes` (S9 fail-closed).
- `transition: legal open → triaged → action + audit appended with reasonCode`.
- `transition: illegal pairs throw INVALID_TRANSITION` — `open → closed`, `closed → triaged`, `dismissed → actioned`, `investigating → triaged` (backwards).
- `transition: concurrent second move → CASE_ALREADY_MOVED` (atomic claim — spec §10.1 concurrent update).
- `transition: appealed → closed also closes the Appeal row` (`state: "closed"`, `closedAt` set).
- `transition: reasonCode outside the closed vocabulary → typed error, zero writes`.
- `takedown: approved → removed atomically + action (typed reason) + audit (with `prev:approved` in the detail — SHOULD-FIX 5) + seller notified — and rejectionReason is NEVER written` (R4).
- `takedown: a HIDDEN listing can be taken down (seller cannot dodge by self-hiding)` and `a PENDING listing can be taken down (leaves the review queue)`.
- `takedown: already-removed listing → LISTING_NOT_TAKEDOWN_ELIGIBLE, no second write`.
- `takedown with caseId: target mismatch → typed error`; `case in dismissed/appealed/closed → CASE_NOT_ACTIONABLE`; `open case → atomically actioned + case.transitioned (resolved_by_sanction) appended` (S5/S6).
- `takedown: support (no listing.moderate) → FORBIDDEN`; `moderator → allowed` (matrix ✓ cell).
- `every action appends — two transitions produce two ModerationAction rows` (append-only, never overwrite).

`tests/unit/moderation-pages.test.ts` (source-contract style of `tests/unit/finance-public-surface.test.ts` — read the page source, assert the boundary):

- `queue and detail pages call requireCapability("report.resolve")` before any db read (source assertion on `app/admin/moderation/page.tsx` + `app/admin/moderation/[id]/page.tsx`).
- `detail page audits every evidence view` — source contains `auditEvent` with action `"moderation.evidence_viewed"` (spec §5.5.1 "separately audited").
- `no dangerouslySetInnerHTML anywhere in the moderation pages` (stored-XSS contract — report notes/message bodies render as React text; spec §10.1 "Stored XSS through report").
- `detail page never selects or renders the subject's email/phone` — source assertion: no `email`/`phone` in the subject/evidence select projections (fail-closed `user.view_basic` — Ambiguities A1).
- `suspend/lift forms render only under a user.suspend capability check` (source assertion on the `capabilitiesOf(...).includes("user.suspend")` guard).
- `admin nav entry "Báo cáo & kiểm duyệt" is capability-filtered by report.resolve` (source assertion on `app/admin/layout.tsx`).

`tests/unit/listing-lock.test.ts` (new — the **R5 seller-side lock gate**; mock db with a `removed` listing fixture):

- `updateListingAction on a removed listing → typed error, no mutation` (the seller cannot edit their way out of a takedown).
- `toggleListingVisibilityAction on a removed listing → typed error (or silent no-op return), status stays removed — never back to approved` (no un-remove via toggle).
- `deleteListingAction on a removed listing → typed error, row survives` (the moderation record's source is not destroyed by its subject).
- **conditional-write race cases (SHOULD-FIX 3)**: `updateListingAction/toggle/delete read approved, takedown flips the row to removed before the write → the conditional write (.where({ id, status: <read status> })) hits 0 rows → typed LISTING_MODERATION_LOCKED/conflict error, status stays removed` (check-then-write alone would lose the race); `approveListingAction reads pending, takedown removes the listing before the approval write → the conditional .where({ id, status: "pending" }) hits 0 rows → no approval, no resurrection` (admin.ts:19-23 today is check-then-write — this task makes the write conditional).
- `approveListingAction / rejectListingAction on a removed listing → no-op (pending-only)` — R5: "removed never re-enters via review" pinned against the admin actions Batch 3 now edits (R7).
- `all three seller actions still work on approved/hidden/pending listings` (the lock does not over-block).
- `isModerationLocked is consumed by all three guards` — source-contract: each guard calls the helper from `@/src/lib/moderation`, no hardcoded `"removed"` string and no raw `.includes` on the tuple in `listings.ts` (Batch 4's rewire extends the call sites, not the vocabulary).

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/unit/moderation-actions.test.ts tests/unit/moderation-pages.test.ts tests/unit/listing-lock.test.ts` → FAIL — actions/pages missing; the lock guards and conditional writes do not exist yet.

- [ ] **Step 3: Implement actions + pages**

- `src/lib/actions/moderation.ts`: add the three actions per the interface block (same file as Task 5 — sequential per the file-conflict rules).
- `src/lib/actions/listings.ts` (R5): add the seller-side lock guards — in `updateListingAction`, `toggleListingVisibilityAction`, and `deleteListingAction`, immediately after the ownership check, `if (isModerationLocked(listing.status)) throw Error("LISTING_MODERATION_LOCKED")` (typed error; the helper is imported from `@/src/lib/moderation` — never a hardcoded `"removed"`). **Every write becomes conditional on the status read (SHOULD-FIX 3)**: `updateListingAction`'s final update and `toggleListingVisibilityAction`'s status flip become `.where({ id, status: listing.status }).updateAll(...)` → 0 rows → `LISTING_MODERATION_LOCKED` (a racing takedown changed the row underneath — the conditional write loses instead of clobbering `removed`); `deleteListingAction`'s delete becomes `.where({ id, status: listing.status }).delete()` → 0 rows → same typed error.
- `src/lib/actions/admin.ts` (R5/R7): make `approveListingAction`/`rejectListingAction` **conditional pending-only writes** — `.where({ id: listingId, status: "pending" }).updateAll(...)` → 0 rows → silent return (their existing no-op posture) — so a racing takedown can never be resurrected by an approval that read `pending` a moment earlier. No other change to that file.
- `app/admin/moderation/page.tsx` (queue): `requireCapability("report.resolve")`; `export const dynamic = "force-dynamic"`; filter tabs by state (`?state=` — default shows `open|triaged|investigating`); table columns: target (`targetType` + short id), `reasonCategory` label, state badge, priority badge, assigned moderator name, report count, `updatedAt`; each row links to `/admin/moderation/<id>`.
- `app/admin/moderation/[id]/page.tsx` (detail): `requireCapability("report.resolve")`; loads case + reports (include reporter `id`/`name` only) + evidence + actions + appeals (Task 7 adds the section) + subject's prior `ModerationAction` history (`where({ targetType: "user", targetId: subjectUserId })`). Sections:
  - **Tổng quan**: state/priority badges, reason category, target reference (listing → link `/admin/listings`; user → link to `/admin/users` **only when** the viewer holds `user.view_basic` — capability-filtered link, else id only), assigned moderator.
  - **Evidence**: each row renders the snapshot's JSON fields as React text (listing title/price/description, message body, user name/bio — never email/phone), `capturedAt`, `classification`, reporter id. Before rendering: `await auditEvent({ actorId: ctx.user.id, action: "moderation.evidence_viewed", resourceType: "moderation_case", resourceId: caseId, sessionId: ctx.session.id })`.
  - **Báo cáo**: reporter id/name, reason label, note (untrusted — React text), createdAt.
  - **Hành động**: `ModerationAction` history (action type label, actor, reason, note, createdAt).
  - **Forms**: assign (select of eligible moderators — query `User` where `adminRole` in the three case-worker roles — **plus a reason select** from `MODERATION_ASSIGNMENT_REASON_CODES`), transition (select of legal next states from `MODERATION_TRANSITIONS[case.state]`, reason select from `MODERATION_DECISION_REASON_CODES`, note, optional priority), takedown (when the target is a listing with `status` in `approved|hidden|pending` — R4), suspend subject (only when `capabilitiesOf(viewer.adminRole).includes("user.suspend")` — suspends the case's **subject** resolved from `ModerationEvidence.subjectUserId` (fallback `getCaseSubjectUserId`) — **any target type**, matching `suspendUserAction`'s subject-match validation (SHOULD-FIX 2) — with `caseId` **and a TOTP field for step-up**, spec §5.4.2), lift suspension (same capability gate, when the subject has an active suspension — no step-up field).
- `app/admin/layout.tsx`: add the nav entry behind the existing capability-filtered nav pattern (Batch 2 Task 9) — `report.resolve`.
- `src/lib/constants.ts`: add the four label maps (Vietnamese, e.g. `open: "Mới"`, `triaged: "Đã phân loại"`, `investigating: "Đang điều tra"`, `actioned: "Đã xử lý"`, `dismissed: "Bỏ qua"`, `appealed: "Đang kháng cáo"`, `closed: "Đã đóng"`) **plus `LISTING_STATUS_LABELS.removed = "Đã gỡ bởi kiểm duyệt"` and a `LISTING_STATUS_BADGE.removed` entry (R8 — the seller's `/sell/my` and the console render the takedown state with a human label; Batch 4 Task 5 adds only `archived`)**.

- [ ] **Step 4: Run tests until green**

Run: `npm test -- tests/unit/moderation-actions.test.ts tests/unit/moderation-pages.test.ts tests/unit/listing-lock.test.ts` → PASS.
Run: `npm test` → full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/actions/moderation.ts src/lib/actions/listings.ts src/lib/actions/admin.ts app/admin/moderation app/admin/layout.tsx src/lib/constants.ts tests/unit/moderation-actions.test.ts tests/unit/moderation-pages.test.ts tests/unit/listing-lock.test.ts
git commit -m "feat(admin): moderation console"
```

(`app/admin/moderation` is added as a directory — its `[id]` segment is safe inside a directory path; individual bracketed *file* paths are always quoted per the Global Constraints.)

## Task 7: Appeal foundation

**Files:**

- Create: `src/lib/actions/appeals.ts`
- Create: `app/appeal/[caseId]/page.tsx`
- Create: `src/components/appeal-form.tsx`
- Modify: `src/lib/actions/moderation.ts` (the Task 5 suspend + Task 6 takedown `notify` call-sites gain the `/appeal/<caseId>` link — the page exists as of this commit, so no intermediate commit ever carries a dead link)
- Modify: `app/admin/moderation/[id]/page.tsx` (appeal section: statement, appellant, state)
- Test: `tests/unit/appeal-actions.test.ts`

**Interfaces:**

- Consumes: `Appeal`/`ModerationEvidence` models (Task 1), `APPEAL_STATEMENT_MAX_LENGTH` (Task 2 `moderation-vocab.ts` — client-safe), `getCaseSubjectUserId` (Task 2 — **fallback only**), `requireUser` (Batch 2), `db.transaction` (existing).
- Produces:

```ts
// src/lib/actions/appeals.ts
"use server";
export type AppealFormState = { error?: string; success?: string };

export async function recordAppealAction(
  _prev: AppealFormState,
  formData: FormData,
): Promise<AppealFormState>;
//   formData: caseId, statement?
//   1. requireUser
//   2. case tồn tại → else { error: NOT_FOUND }
//   3. CHỦ TƯỢNG (S7 — từ evidence BẤT BIẾN, không phải live data):
//      subjectUserId = ModerationEvidence.where({ caseId }).select("subjectUserId").first()
//        ?.subjectUserId ?? await getCaseSubjectUserId(case.targetType, case.targetId)
//      // evidence.subjectUserId chụp tại report time — sống qua edit/delete của source;
//      // getCaseSubjectUserId (live) chỉ là fallback khi case không có evidence (không xảy ra
//      // qua submitReportAction, nhưng fail-closed thay vì crash)
//      user.id === subjectUserId → else { error: NOT_FOUND }
//      // IDOR: không tiết lộ tồn tại case của người khác (Review Focus 3 — non-subject appeal
//      // bị chặn với cùng thông báo như case không tồn tại)
//   4. case.state === "actioned" → else { error: APPEAL_NOT_AVAILABLE }
//      // chỉ appeal sau khi case được actioned — mọi quy tắc khác (thời hạn, re-appeal,
//      // appeal sau dismissed) = POLICY = Ambiguities A4, KHÔNG phát minh
//   5. statement ≤ APPEAL_STATEMENT_MAX_LENGTH
//   6. pre-check nhanh: đã có Appeal cho caseId → { error: ALREADY_APPEALED }
//      (concurrent double-appeal vẫn có thể vượt pre-check — bước 7 xử lý qua violation)
//   7. db.transaction (violation LUÔN throw ra khỏi callback — Global Constraints):
//        Appeal.create({ caseId, appellantId: user.id, statement, state: "submitted" })
//          — concurrent double-appeal → Appeal_caseId_key violation THROW ra khỏi callback
//        ModerationCase.updateAll({ state: "appealed" }).where({ id: caseId, state: "actioned" })
//          → 0 rows → throw Error("CASE_ALREADY_MOVED") ra khỏi callback  // concurrent transition
//        ModerationAction.create({ caseId, actorId: user.id, actionType: "appeal.recorded",
//          targetType: "moderation_case", targetId: caseId, reasonCode: null, note: null })
//   8. NGOÀI tx — classify (SqlQueryError, sqlState "23505" + constraint name):
//      "Appeal_caseId_key" → { error: ALREADY_APPEALED }; Error("CASE_ALREADY_MOVED") → propagate
//   9. return { success } — KHÔNG auditEvent (actor là user thường — Scope Decisions),
//      KHÔNG notify moderator tự động (workflow = A4).
```

- [ ] **Step 1: Write the failing unit tests**

`tests/unit/appeal-actions.test.ts` (mock db: case fixtures in each state + a first-evidence row per case; subject + non-subject users):

- `the case subject can appeal an actioned case` — `Appeal` row created, case → `appealed`, `ModerationAction("appeal.recorded")` appended.
- `the subject is resolved from ModerationEvidence.subjectUserId, not live data` — delete/edit the source listing after the report; the subject can still appeal (S7 — the immutable evidence row carries the subject).
- `a NON-subject user gets NOT_FOUND — same message as a missing case` (Review Focus 3 — no existence oracle for other people's cases).
- `appealing a non-actioned case (open/triaged/investigating/dismissed/closed/appealed) → APPEAL_NOT_AVAILABLE` (A4 fail-closed — table-driven).
- `second appeal for the same case → ALREADY_APPEALED` (pre-check; and the concurrent path — the `Appeal_caseId_key` violation throws out of the tx callback and is classified outside, never caught-and-returned).
- `statement over the cap → validation error, zero writes`.
- `concurrent: case moved off actioned between check and claim → CASE_ALREADY_MOVED, no Appeal row`.
- `no session → redirect, zero db calls`.

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/unit/appeal-actions.test.ts` → FAIL — module missing.

- [ ] **Step 3: Implement**

- `src/lib/actions/appeals.ts` per the interface block.
- `app/appeal/[caseId]/page.tsx`: `requireUser` (redirect to login); load case; resolve the subject from the first `ModerationEvidence` row (fallback `getCaseSubjectUserId`); verify subject (else `notFound()` — same fail-closed posture as the action); render case summary (reason label, state, **no** reporter identities, **no** moderator identities — the subject sees their own case context only), the sanction context (the latest `user.suspended`/`listing.taken_down` `ModerationAction` reason label for their case), and `AppealForm`. `export const dynamic = "force-dynamic"`. **All user-facing copy on this page ships as a clearly-marked placeholder (FD-3)** — appeal-rights wording is founder-authored content (Batch 8 register); the placeholder copy states the mechanics (case reason label, how to submit a statement) without inventing appeal policy.
- `src/components/appeal-form.tsx`: `"use client"`, `useActionState(recordAppealAction)` — statement textarea (cap `APPEAL_STATEMENT_MAX_LENGTH` — imported from `src/lib/moderation-vocab.ts`, **never** `moderation.ts`, B2), submit, error/success display; disabled after success.
- `src/lib/actions/moderation.ts`: the suspend/takedown `notify` calls gain `caseId ? \`/appeal/${caseId}\` : undefined` as the link — the page exists in this commit, so the link is live (and the case is `actioned` by the sanction's atomic move, S6).
- `app/admin/moderation/[id]/page.tsx`: add the **Kháng cáo** section — the case's `Appeal` row (appellant id/name, statement as React text, state badge, createdAt/closedAt) + a note that the decision workflow is pending founder policy (A4) — closing happens through the existing `transitionModerationCaseAction` (`appealed → closed`), which Task 6 already wires to close the `Appeal` row.

- [ ] **Step 4: Run tests until green**

Run: `npm test -- tests/unit/appeal-actions.test.ts` → PASS.
Run: `npm test` → full suite green (incl. `moderation-pages.test.ts` — the appeal section adds no `dangerouslySetInnerHTML`; `suspension-actions.test.ts`/`moderation-actions.test.ts` still pass with the notify link added).

- [ ] **Step 5: Commit**

```bash
git add src/lib/actions/appeals.ts app/appeal src/components/appeal-form.tsx src/lib/actions/moderation.ts 'app/admin/moderation/[id]/page.tsx' tests/unit/appeal-actions.test.ts
git commit -m "feat(trust): appeal foundation"
```

## Task 8: Expanded audit context + audit-page filter

**Files:**

- Modify: `app/admin/audit/page.tsx` (Batch 2 page — add an action-prefix filter)
- Test: `tests/unit/audit-append.test.ts`

**Interfaces:**

- Consumes: `auditEvent`/`auditEventTx`/`redactDetail` (Batch 2 — read-only), the `AuditEvent` model, all Batch 3 privileged actions (Tasks 5–7).
- Produces: no new module — this task verifies the audit wiring and extends the *view*.

Batch 3's audit action registry (all appended via `auditEvent`/`auditEventTx` by Tasks 5–7, listed here as the contract Task 8 verifies): `moderation.user_suspended`, `moderation.user_suspension_lifted`, `moderation.case_assigned`, `moderation.case_transitioned`, `moderation.listing_taken_down`, `moderation.evidence_viewed`. (`report.submitted` and `appeal.recorded` are deliberately NOT `AuditEvent`s — Scope Decisions; their records are `AbuseReport`/`Appeal` + `ModerationAction`.)

- [ ] **Step 1: Write the failing unit tests**

`tests/unit/audit-append.test.ts` (mock db; role-stubbed sessions per the Global Constraints recipe; spy on `AuditEvent.create` + `ModerationAction.create`):

- `suspend appends exactly one AuditEvent; a failed second suspend appends none` — call `suspendUserAction` twice with a **fresh step-up fixture per call** (second → `USER_ALREADY_SUSPENDED`); assert the spy recorded exactly one call **filtered by `action === "moderation.user_suspended"`** after the first, still one after the failed second (never count total spy calls — other actions in the same suite append too); a successful lift appends one `moderation.user_suspension_lifted`. Append-only: zero `update*`/`delete*` invocations on the `AuditEvent` model across the suite (spy).
- `every Batch 3 privileged action appends an AuditEvent` — loop over assign/transition/takedown/suspend/lift with valid fixtures → each produced ≥ 1 `AuditEvent` row with `action` from the registry above, `actorId` = the admin, `sessionId` = the session id.
- `evidence view appends moderation.evidence_viewed` — **how the async server component runs in Vitest (E2)**: `vi.mock` `next/navigation`/`next/cache`/`server-only`/`@/src/prisma/db.client`/`@/src/lib/rbac` (the mock `requireCapability` returns a fixture `AdminContext`), then `import AdminModerationCaseDetail from "../../app/admin/moderation/[id]/page"` and `await AdminModerationCaseDetail({ params: Promise.resolve({ id: fixtureCaseId }) })` — an async server component is just an async function outside Next; awaiting it executes the audit path; assert the `AuditEvent` spy fired once with `action: "moderation.evidence_viewed"`. (A second render appends a second row — views are audited per render.)
- `admin notes are redacted in AuditEvent.detail AND ModerationAction.note` — a note containing an email address and a 6-digit OTP-shaped string is stored masked in both (write-time `redactDetail`).
- `ModerationAction rows are append-only` — two transitions → two rows; zero `update*`/`delete*` calls on `ModerationAction`.
- `no statement in the codebase mutates ModerationEvidence, ModerationAction, or AuditEvent` (S12 — the real no-mutation gate, replacing a fragile one-line grep): read every `.ts`/`.tsx` under `src/` and `app/`, strip block/line comments, split into statements on `;`, and assert **no statement contains both** one of the three model names **and** one of `.update(`, `.updateAll(`, `.delete(`, `.deleteAll(`. Known read/create-only files (`moderation-snapshot.ts`, `audit-event.ts` from Batch 2) pass trivially — the exclusion the old scan needed is gone because the assertion is per-statement, not per-file.
- `audit page filters by action prefix when ?action= is present` — source-contract assertion on `app/admin/audit/page.tsx` (reads `searchParams.action`, filters `AuditEvent` by `ilike("<prefix>.%")`, `requireCapability("audit.read")` still first).

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/unit/audit-append.test.ts` → FAIL — filter missing / assertions unmet.

- [ ] **Step 3: Implement the audit-page filter**

- `app/admin/audit/page.tsx`: read `searchParams.action`; render a small prefix filter (`Tất cả`, `moderation`, `seller_verification`, `session`, `admin`, `user`); when set, query `AuditEvent.where((a) => a.action.ilike(`${prefix}.%`))` keeping the existing order/pagination; the capability guard stays the first statement (super_admin only — fail-closed `audit.read`, Ambiguities A1).

- [ ] **Step 4: Run tests until green**

Run: `npm test -- tests/unit/audit-append.test.ts` → PASS. Then `npm test` → full suite green.

- [ ] **Step 5: Commit**

```bash
git add app/admin/audit/page.tsx tests/unit/audit-append.test.ts
git commit -m "feat(audit): moderation audit context and filter"
```

## Task 9: Batch 3 gate verification + verification doc

**Files:**

- Create: `docs/operations/private-beta-batch3-trust-safety-verification.md`

- [ ] **Step 1: Run every gate suite and record results**

```bash
npm test -- tests/unit/moderation.test.ts tests/unit/moderation-actions.test.ts tests/unit/listing-lock.test.ts   # moderation transitions + moderator permissions + seller-side lock (R5)
npm test -- tests/unit/block-actions.test.ts tests/unit/chat-guard.test.ts        # block enforcement + blocked chat prevention + send rate limit (unit)
npm test -- tests/unit/report-actions.test.ts                                     # report rate limits + dedupe + target authorization
npm test -- tests/unit/suspension-actions.test.ts tests/unit/admin-mfa-login.test.ts   # suspension permissions + step-up (no session revocation — P1)
npm test -- tests/unit/seller-verification-policy.test.ts tests/unit/publication-gate.test.ts tests/unit/seller-verification-actions.test.ts  # publication gate (8 requirements) + suspended submit refused
npm test -- tests/unit/appeal-actions.test.ts                                     # appeal foundation
npm test -- tests/unit/moderation-pages.test.ts tests/unit/audit-append.test.ts   # page guards + audit append + no-mutation source contract
npm run test:integration                                                          # block-enforcement, report-evidence (immutable evidence),
                                                                                   # suspension-enforcement, batch3-migration
```

- [ ] **Step 2: Backend-enforcement source scan** (spec §4.5 — "no privileged action relies only on UI visibility"; every line states its expected result)

```bash
rg -n "requireAdmin\b" src app                    # expect: 0 hits (Batch 2 removed it; Batch 3 must not resurrect it)
rg -n "requireCapability" src/lib/actions/moderation.ts src/lib/actions/reports.ts src/lib/actions/blocks.ts src/lib/actions/appeals.ts  # expect: the first guard of every privileged action
rg -n "requireCapabilityWithStepUp" src/lib/actions/moderation.ts  # expect: exactly suspendUserAction (spec §5.4.2, interpretation A9)
rg -n "revokeAllUserSessions" src/lib/actions/moderation.ts        # expect: 0 hits (P1 — suspension never revokes sessions)
rg -n "rejected|rejectionReason" src/lib/actions/moderation.ts    # expect: 0 hits IN CODE (R4 — takedown writes removed, never rejected; the R4 rule comment in the file mentions the words — classify every hit as comment-or-code, fix any code hit)
rg -n "MODERATION_LOCKED_LISTING_STATUSES" src/lib/actions/listings.ts  # expect: all three seller guards read the constant (R5 — no hardcoded "removed")
rg -n "dangerouslySetInnerHTML" app/admin/moderation app/appeal src/components/report-dialog.tsx src/components/appeal-form.tsx  # expect: 0 hits
rg -n "Conversation\.create|Message\.create" src app  # expect: exactly 3 sites — chat.ts (guarded), api/chat/[id]/route.ts (guarded), exchange.ts (finance-guarded, dormant — S2)
rg -n "FINANCIAL_FEATURES_ENABLED" .env.example docker-compose.prod.yml scripts   # expect: still "false" everywhere
```

The no-mutation guarantee on `ModerationEvidence`/`ModerationAction`/`AuditEvent` is **not** a grep here — it is the per-statement source-contract case in `tests/unit/audit-append.test.ts` (S12), which runs in Step 1. Manually classify every grep hit; fix any that is an authorization read, an unguarded creation site, or an XSS sink.

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

- `git diff --check`; `git status --short` contains only Batch 3 files; no `.claude/settings.json`, no uploads, no secrets, no scratch.
- `npx prisma migration list` shows baseline → batch2 → batch3 linear graph; `npx prisma db verify` clean.
- Inspect the migration once more: only creates/createIndexes + the expected `Listing_status_check_*` DROP+ADD pair (additive in effect — BLOCKING-2); no column/table drop or alter; no data transform.

- [ ] **Step 5: Write the verification doc**

`docs/operations/private-beta-batch3-trust-safety-verification.md` records: base and final commit hashes; OpenCode model/session metadata; per-gate test results (the seven spec §9 Batch 3 gate items, each naming its test files — see Acceptance Gate); the source-scan classification table (including the three `Conversation.create`/`Message.create` sites and why exchange.ts is dormant); migration review notes (additive-only — the `listing_status.removed` value addition included (R2) **with the `Listing_status_check_*` DROP+ADD pair classified as expected/additive-in-effect (BLOCKING-2)** — no backfill, and why that satisfies §8.6 trivially; the two partial unique indexes and what races they close; the linear `baseline → batch2 → batch3` graph per R3); the **transaction constraint-violation rule** (Global Constraints) and its no-silent-success integration results (concurrent double-report → one row; concurrent two-reporter grouping → one case; concurrent double-suspend → one row); the recorded implementation decisions from Scope Decisions (takedown writes `removed` from `approved|hidden|pending` (R4) with the seller-side lock + **conditional writes** (R5/SHOULD-FIX 3, incl. the conditional pending-only approve/reject in `admin.ts`) and **`previousStatus` recorded in the takedown `AuditEvent.detail` for A4's future restore**; a linked sanction atomically moves its case to `actioned`; report submission not audited; symmetric block enforcement; admin suspension refused; suspended listings stay live; **no session revocation / no login block** — actor-side guards only; suspend requires step-up while lift does not; conflict-of-interest denied) each flagged for founder review; the provisional-vocabulary note (A8) and the step-up interpretation (A9); the Batch 5 telemetry forward seam (`report_submitted` → `submitReportAction`, `listing_removed` → `takeDownListingAction`); residual risks (in-memory rate limiter single-instance topology; the constraint races are closed by partial unique indexes + throw-out/classify-outside/retry-once — the remaining accepted window is the retry's re-read, benign: the loser joins the winner's case); deferred items (Batch 4 `archived` status + lifecycle rewire per the reconciliation section, Batch 5 telemetry wiring, Batch 6 Deal guards + §7.8 revocation/membership chat checks); the **Batch 8 Founder Decision Register hand-off** (see Ambiguities): A1 Scoped RBAC cells, A2 sanction policy + session revocation/login block + counterpart suspension, A3 evidence retention, A4 appeal workflow + listing restore (+ the note that a plain transition to `actioned` without a linked sanction sends **no notification**, so the subject never learns they can appeal), A5 priority SLA, A7 recusal policy, A8 sanction-taxonomy vocabularies (**launch blocker**), A9 step-up interpretation — plus the placeholder moderation copy (suspend/takedown notifications, appeal page, reason labels) awaiting founder-authored wording per FD-3; and the explicit note that browser E2E is deferred (no E2E infrastructure in the repo — same posture as Batch 2; critical flows covered by action-level unit tests + real-DB integration tests).

- [ ] **Step 6: Commit**

```bash
git add docs/operations/private-beta-batch3-trust-safety-verification.md
git commit -m "test(batch3): verify trust & safety gate"
```

## Acceptance Gate

Batch 3 is accepted only if all of the following are true (spec §9 Batch 3 Gate — every item maps to named tests):

- **Block enforcement** — `tests/unit/block-actions.test.ts` (directional row, idempotent upsert/unblock, self-block refused, block/unblock rate limit, zero message/conversation mutation) + `tests/integration/block-enforcement.test.ts` (real-DB both-direction prevention, unblock restores, history preserved).
- **Blocked chat prevention** — `tests/unit/chat-guard.test.ts`: `startConversationAction` and `POST /api/chat/[id]` deny with `CHAT_BLOCKED` for a block in **either** direction and with `ACCOUNT_SUSPENDED` for a suspended **initiator/sender** (actor-side — counterpart suspension is A2), create no `Conversation`/`Message`, `POST` enforces the per-user send limit (31st/min → 429), and `GET` still returns history (no silent deletion).
- **Moderation transition tests** — `tests/unit/moderation.test.ts` (the transition table: every legal pair allowed, every illegal pair denied, `closed` terminal) + `tests/unit/moderation-actions.test.ts` (legal transition appends history + audit; illegal → `INVALID_TRANSITION`; concurrent → `CASE_ALREADY_MOVED`; `appealed → closed` closes the `Appeal`; assignment refuses closed cases and conflicts on a concurrent assign; a linked sanction moves the case to `actioned` atomically; takedown writes `removed` from `approved|hidden|pending` — never `rejected`/`rejectionReason` (R4) — and records `previousStatus` in the audit detail) + `tests/unit/listing-lock.test.ts` (R5: the seller cannot edit/toggle/delete a removed listing, **every seller/admin write is conditional on the status read so a racing takedown can never be clobbered or resurrected**, and approve/reject stay pending-only so removed never re-enters review).
- **Immutable evidence behavior** — `tests/integration/report-evidence.test.ts`: editing **and** deleting the reported source leaves `ModerationEvidence.relevantSnapshot` **deep-equal** (jsonb) to the capture and the case readable; the per-statement source-contract case in `tests/unit/audit-append.test.ts` proves no statement in `src/`/`app/` mutates `ModerationEvidence`/`ModerationAction`/`AuditEvent`.
- **Report rate limits** — `tests/unit/report-actions.test.ts`: 6th report in 10 min → `RATE_LIMITED`; an active case for (target, reason) where this reporter already reported → `REPORT_ALREADY_SUBMITTED` (case-first dedupe); a second reporter joins the existing case (grouping); concurrent same-reporter double-submit → the violation throws out of the tx and is classified outside → one row + `REPORT_ALREADY_SUBMITTED` (no silent-success path — also pinned against the real DB in `report-evidence.test.ts`); target-authorization checks (non-participant message report, own-target report → typed errors).
- **Audit append behavior** — `tests/unit/audit-append.test.ts`: every privileged moderation action appends `AuditEvent` (actor/action/reason/session) and `ModerationAction`; nothing updates or deletes either; admin notes pass `redactDetail`; evidence views append `moderation.evidence_viewed`.
- **Moderator permission tests** — `tests/unit/moderation-actions.test.ts` + `tests/unit/suspension-actions.test.ts` + `tests/unit/moderation-pages.test.ts`: moderator ✓ `report.resolve`/`listing.moderate` (works cases, takes down listings), ✗ `user.suspend` (FORBIDDEN — A1 fail-closed); support/analyst ✗ every moderation surface; every console page guards `requireCapability("report.resolve")` server-side; no page renders subject email/phone. Suspension requires fresh step-up or a valid TOTP in the same request (`STEP_UP_REQUIRED`/`MFA_CODE_INVALID` fail closed — spec §5.4.2), proven by `tests/unit/suspension-actions.test.ts` + the extended `tests/unit/admin-mfa-login.test.ts`.
- **Batch 1 preserved** — all finance shutdown suites + `tests/integration/escrow.test.ts` green unchanged; `FINANCIAL_FEATURES_ENABLED=false` everywhere; the migration is additive-only — the only destructive-looking operations are the expected `Listing_status_check_*` DROP+ADD pair (additive in effect, BLOCKING-2/R3), with no column/table drop or alter.
- **Batch 2 preserved** — RBAC matrix, session/OTP/MFA/audit suites green; exactly two Batch 2 *interfaces* are amended in the open with their tests extended, not weakened: the publication gate (7 → 8 requirements, spec §7.8) and `STEP_UP_CAPABILITIES` (gains `user.suspend`, spec §5.4.2). No capability, role, or matrix cell changes. The `admin.ts` approve/reject conditional-write hardening (Task 6, R5) changes no interface and keeps every existing admin-action test green.
- Preflight (lint, typecheck, unit, build, compose, migration graph), the integration suite, safe smoke, and a clean diff/status audit all pass.

## Threat-Case Coverage Map (spec §10.1 rows applicable to Batch 3)

| Abuse case | Covered by |
|---|---|
| Moderation-resource IDOR | Task 6 page guards (`moderation-pages.test.ts`) + action FORBIDDEN tests + Task 7 subject check (`appeal-actions.test.ts` non-subject → NOT_FOUND) |
| Privilege escalation / Support → admin escalation | Task 5/6 capability tests (support/analyst denied on every moderation action); no new capabilities or matrix cells — the single `src/lib/rbac.ts` extension is `user.suspend` joining `STEP_UP_CAPABILITIES` (A9) |
| Moderator conflict-of-interest (self-review) | Task 5/6 `MODERATOR_CONFLICT` tests — an admin who is the case subject or a reporter cannot assign/transition/take down/suspend (S9, policy A7) |
| Cross-account report access | Task 4 target-authorization tests (message report by non-participant → NOT_FOUND; nonexistent target → NOT_FOUND, no case created) |
| Blocked-user chat bypass | Task 3 `chat-guard.test.ts` (direct `startConversationAction` + direct `POST` route invocation) + `block-enforcement.test.ts` |
| Suspended-user publication bypass | Task 5 `publication-gate.test.ts` (all four listing surfaces) + `suspension-enforcement.test.ts` |
| Suspended-user chat/message | Task 3/5 guard tests (`ACCOUNT_SUSPENDED` on new conversation + message send) |
| Concurrent moderation update | Task 6 atomic-claim test (`CASE_ALREADY_MOVED`); Task 5 lift claim (`SUSPENSION_ALREADY_LIFTED`); Task 7 appeal claim (`CASE_ALREADY_MOVED`) |
| Stored XSS through report / chat / listing | React text-only rendering + `moderation-pages.test.ts` source contract (zero `dangerouslySetInnerHTML` in console/appeal/report-dialog surfaces) |
| Report flooding / spam | Task 4 rate limit (5/10 min/reporter) + dedupe (`REPORT_ALREADY_SUBMITTED`) + case grouping |
| CSRF on state-changing actions | Next.js 16 server actions are POST-only with built-in origin protection (repo posture, noted in the verification doc — no custom token layer added, same as Batch 2) |
| Removed-listing seller bypass (un-remove via edit/toggle/delete, or racing approval) | Task 6 `tests/unit/listing-lock.test.ts` — `isModerationLocked` guards all three seller actions, **every seller/admin write is conditional on the status read** (a racing takedown can never be clobbered or resurrected), approve/reject conditional pending-only (R5/SHOULD-FIX 3) |
| Historical finance escape-hatch abuse | Batch 1 suites re-run in Task 9; takedown writes the new `removed` status (R4) and touches no finance model |

## Ambiguities and Deployment Prerequisites

Recorded per spec §4.11/§11.1 + **FD-3** (`/tmp/loaviet/founder-decisions.md`): none of these is silently resolved by implementation, and none of them **stops execution** — per FD-3, each proceeds with the fail-closed default chosen below, and the items needing founder-**authored** content ship as clearly-marked placeholders. Every item below is handed off to the **Batch 8 Founder Decision Register** (mirroring the Batch 4 plan's register hand-off):

**Batch 8 Founder Decision Register hand-off (from this batch):**

- **A1** — Scoped/Exceptional/Limited RBAC cells (moderator/support `user.suspend`, `user.view_basic`, `session.revoke`, `audit.read`; moderator analytics; `pii.view_sensitive`; `pii.export`).
- **A2** — sanction policy (which sanction for which violation, durations, escalation) **and** the suspension enforcement perimeter: session revocation, login blocking, counterpart-side chat blocking.
- **A3** — evidence retention & deletion policy (incl. the account-deletion interaction and the `SetNull`/`Restrict` FK interim).
- **A4** — appeal decision workflow (who rules, outcomes, timelines, re-appeal) **and listing restore** (the only un-remove path). *Note:* a plain case transition to `actioned` **without a linked sanction sends no notification** — only sanction-linked cases notify the subject with the appeal link — so a subject whose case was actioned without a sanction never learns they can appeal; closing that gap is part of A4's founder-authored workflow.
- **A5** — case priority SLA/escalation semantics.
- **A7** — moderator recusal/override policy (the deny is the fail-closed default).
- **A8** — the sanction-taxonomy reason vocabularies (`SUSPENSION_REASON_CODES`, `MODERATION_DECISION_REASON_CODES`, `MODERATION_ASSIGNMENT_REASON_CODES`) — **launch blocker** per FD-3 (founder-authored content); the constants/labels carry visible `PROVISIONAL (A8)` markers until acknowledged.
- **A9** — the "destructive account action" step-up interpretation (suspension in, lift out).
- **Placeholder moderation copy (FD-3)** — the suspend/takedown notification wording, the appeal-page copy, and the reason labels ship as clearly-marked placeholders; founder-authored wording replaces them before beta (Batch 8 register).

1. **A1 — RBAC matrix `Scoped`/`Exceptional + audited`/`Limited` cells are undefined** (carried from Batch 2 Ambiguity A2; spec §5.4.1: moderator/support `user.suspend`, `user.view_basic`, `session.revoke`, `audit.read` "Scoped"; moderator `seller.verification.revoke` "Scoped"; moderator analytics "Limited"; `pii.view_sensitive` "Exceptional + audited"; `pii.export` "Explicit permission + step-up"). Batch 3 fails closed: **only** `super_admin`/`operations_admin` can suspend; moderators work cases (`report.resolve`, `listing.moderate` — the unambiguous ✓ cells, which is also the reading that resolves the Batch 2 plan's A2 wording: only the *Scoped/Exceptional* cells are blocked, the ✓ cells ship) but cannot suspend, cannot read the security audit log, cannot open `/admin/users`, and the console renders **no** subject email/phone. *Blocks: granting those cells before the founder defines scope/exception semantics — the practical gap is that a moderator who confirms abuse must hand off to an operations_admin for the suspension; until A1 is resolved, that hand-off is manual (case assignment + notification).*
2. **A2 — Moderation sanction policy is unspecified, including the suspension enforcement perimeter.** Which sanction for which violation, durations, escalation ladders, auto-lift — and, from this batch's review: **whether a suspended user's sessions are revoked and whether login is blocked** (Batch 3 ships neither — revocation without a login block is pointless, and a login block is sanction policy; the actor-side guards are the spec-stated enforcement), and **whether chat is blocked when the *counterpart* is suspended** (not in §7.8's stated set — not implemented). Batch 3 ships manual mechanisms only: suspend/lift with typed reasons, indefinite until explicitly lifted, no auto-expiry, no automated sanctioning, and suspended users keep existing published listings (removal is a moderator decision through the case takedown action). *Blocks: any automated/escalating sanction feature and both extra enforcement layers.*
3. **A3 — Evidence retention & deletion policy is unspecified.** §5.5.1 requires a defined retention policy reviewed separately from ordinary user-content deletion; none exists. Batch 3: evidence is never deleted or updated by any product flow; the FK posture is the fail-closed interim — `ModerationEvidence.subject/reporter` and `ModerationAction.actor` are nullable `SetNull` (rows survive account deletion), `AbuseReport.reporter` is nullable `SetNull` (the report row survives), `Appeal.appellant` is nullable `SetNull`, and `UserSuspension.user` is **`Restrict`** (deleting a suspended user is blocked — deletion is a later batch and must come back through this ambiguity). *Blocks: any retention/deletion/purge feature — including the account-deletion interaction when that batch ships.*
4. **A4 — Appeal decision workflow is unspecified.** Who reviews appeals, outcomes, timelines, re-appeal rules — **and restoring a `removed` listing** (R5: the only restore path is an appeal outcome; no seller or admin surface un-removes). Batch 3 ships the foundation only: record + `appealed` state + close bookkeeping + a subject-facing submission page. *Blocks: the decision UI, outcome vocabulary, any appeal SLA, and the restore path.*
5. **A5 — Case priority semantics are unspecified.** `low|normal|high` exist as data; no triage SLA or escalation policy is defined. Batch 3 ships the field (default `normal`, manually settable during transition). *Blocks: SLA/escalation automation.*
6. **A6 — Suspending admin accounts via moderation is undefined.** Batch 3 refuses it with a typed error (`ADMIN_ACCOUNT_USE_ROLE_MANAGEMENT`) — admin lockout is the Batch 2 bootstrap runbook's domain. Recorded decision, reversible by founder ruling.
7. **A7 — Moderator conflict-of-interest / recusal policy is unspecified.** Batch 3 fails closed (deny): an admin who is the case subject or one of its reporters cannot assign/transition/take down/suspend on that case (`MODERATOR_CONFLICT`). *Blocks: the recusal policy itself — when recusal is required, whether a supervisor may override, and how conflicts are recorded.*
8. **A8 — The typed reason vocabularies are provisional.** `SUSPENSION_REASON_CODES`, `MODERATION_DECISION_REASON_CODES`, and `MODERATION_ASSIGNMENT_REASON_CODES` are implementation vocabulary satisfying spec §5.5's "typed reasons" requirement — their *values* are not spec-sourced. They are marked provisional: the founder may rename/add values (an additive constant change); the verification doc lists them for review. *Blocks: nothing mechanically — renaming is additive — but the vocabulary should be founder-acknowledged before beta.*
9. **A9 — "Destructive account action" is an interpretation.** Spec §5.4.2 requires step-up for "destructive account action" without enumerating it; Batch 3 reads user suspension as one (it blocks platform participation), so `user.suspend` joins `STEP_UP_CAPABILITIES` and `suspendUserAction` requires step-up. Lift (restorative) does not. Same posture as Batch 2's A5 ("seller verification decisions where configured" → strictest reading). Recorded as an interpretation, reversible by removing `user.suspend` from the constant after founder review.

## Batch 3 ↔ 4 Reconciliation

Adopted verbatim from `/tmp/loaviet/b34-reconcile.md` (both plans MUST adopt these rules verbatim; where a rule names a Batch 4 artifact, it is recorded here as the contract Batch 4's plan must satisfy):

> **R1 Order:** Batch 3 is implemented and passes its gate first; Batch 4 starts execution only on the merged Batch 3 commit (spec §9). Parallel planning is fine; parallel execution is not.
>
> **R2 Enum ownership:** Batch 3's migration adds listing_status.removed (first writer). Batch 4 Task 1 removes `removed` from its diff and adds only `archived` (or nothing).
>
> **R3 Migration graph:** before Task 1, Batch 4 confirms db/production refs equal Batch 3's `to` hash and plans with --from <batch3 migration dir>; `npx prisma migration list` must show exactly baseline → batch2 → batch3 → batch4 (no node with two outgoing edges). If a Batch 4 package was authored on a stale base: delete the uncommitted package + snapshot, re-emit, re-plan; never hand-merge ops.json/contract.json. Expect the Batch 4 diff to drop + re-add Batch 3's Listing_status_check_* constraint (additive in effect — do not halt on it).
>
> **R4 Takedown:** Batch 3 takeDownListingAction = atomic updateAll({status:"removed"}) where status ∈ {approved, hidden, pending}; 0 rows → LISTING_NOT_TAKEDOWN_ELIGIBLE. Never writes rejected/rejectionReason; the reason lives in ModerationAction as a typed code. Delete Batch 3 text about "content-edit → pending → re-approval" recovery and the `rejected` rationale.
>
> **R5 Seller-side lock:** Batch 3 defines MODERATION_LOCKED_LISTING_STATUSES = ["removed"] in src/lib/moderation.ts and adds guards (typed error) to updateListingAction, toggleListingVisibilityAction, deleteListingAction with tests. Batch 4 Task 4 rewire keeps these guards and adds the same check to saveListingDraftAction and submitListingAction; Batch 4 publication-gate suite asserts it. approveListingAction/rejectListingAction stay pending-only, so removed never re-enters via review. Restoring a removed listing = Batch 3 A4 (appeal outcome), not built.
>
> **R6 Gate extension:** Batch 3 may extend only src/lib/seller-verification-policy.ts (account_not_suspended); assertListingPublishable inherits it. Batch 4 C2 rewritten to allow requirement additions there while forbidding changes to the listing wrapper. Batch 4 Task 4 migrates Batch 3's suspension cases in tests/unit/publication-gate.test.ts to beta-category fixtures and keeps them.
>
> **R7 File order:** tests/unit/publication-gate.test.ts, src/lib/seller-verification-policy.ts, src/lib/actions/listings.ts, src/lib/actions/admin.ts are edited by Batch 3 first, then Batch 4 — add to both plans' file-conflict rules.
>
> **R8 Labels/audit:** Batch 3 adds LISTING_STATUS_LABELS.removed + badge in src/lib/constants.ts; Batch 4 Task 5 adds only archived. Audit names: Batch 3 moderation.listing_taken_down; Batch 4 listing.draft_created|draft_updated|submitted|submit_blocked.
>
> **R9 Fallback if Batch 4 must land first:** Batch 4 keeps owning removed + R5 guards and Batch 3 rebases per R3. Exactly one plan may contain `removed` in its contract diff.

**How this plan implements R1–R9** (rule → task):

- **R1** — the Dependency Map already runs Batch 3 as a self-contained chain ending in the Task 9 gate; nothing here blocks on Batch 4, and Batch 4's execution precondition is the merged Batch 3 commit.
- **R2** — Task 1 adds `removed = "removed"` to the existing `listing_status` enum (the only existing-enum change, additive); the migration test pins a `Listing` row accepting `status: "removed"`.
- **R3** — Task 1 advances both refs in the same commit and asserts the linear `baseline → batch2 → batch3` graph; that `to` hash is what Batch 4 plans `--from`.
- **R4** — Task 6's `takeDownListingAction` writes `status: "removed"` from `{approved, hidden, pending}` with `LISTING_NOT_TAKEDOWN_ELIGIBLE` on 0 rows, never `rejected`/`rejectionReason` (Task 9 scan pins 0 hits); the reason is the `ModerationAction` typed code. The pre-reconciliation "takedown uses `rejected`" decision and its "content-edit → pending → re-approval" recovery text are **deleted** (Scope Decisions, Rollback).
- **R5** — `MODERATION_LOCKED_LISTING_STATUSES = ["removed"]` (+ the `isModerationLocked` helper) is defined in the client-safe vocabulary module `src/lib/moderation-vocab.ts` and re-exported by `src/lib/moderation.ts` (the B2 split — every server consumer imports it *from* `moderation.ts`, satisfying the rule's location). Task 6 adds the typed-error guards to `updateListingAction`/`toggleListingVisibilityAction`/`deleteListingAction` with `tests/unit/listing-lock.test.ts` — **and makes every seller/admin write conditional on the status read** (`.where({ id, status: <read> })` → 0 rows → typed error), including the conditional pending-only `approveListingAction`/`rejectListingAction` in `src/lib/actions/admin.ts` (R7 lets Batch 3 edit that file first), so a racing takedown can never be clobbered or resurrected. **Batch 4 rewire requirement (recorded for Batch 4's plan):** Task 4's rewire keeps the guards, the helper, and the conditional-write pattern, and adds the same check to `saveListingDraftAction`/`submitListingAction`; the Batch 4 publication-gate suite asserts it. Restoring a removed listing is A4.
- **R6** — the 8th requirement lives only in `src/lib/seller-verification-policy.ts`; Batch 3 never touches a listing wrapper (none exists yet — Batch 4's `assertListingPublishable` inherits the requirement automatically). Task 5's other files are call-site consumers of the requirement union (label, submit check, checklist), not gate changes.
- **R7** — the four files are in the file-conflict rules with the Batch 3 → Batch 4 order. Batch 3's `admin.ts` edit is exactly the conditional pending-only approve/reject write (R5/SHOULD-FIX 3) — the file-conflict rules name it.
- **R8** — Task 6 adds `LISTING_STATUS_LABELS.removed` + `LISTING_STATUS_BADGE.removed` in `src/lib/constants.ts`; the audit name is `moderation.listing_taken_down` (Task 8's registry).
- **R9** — recorded as the fallback; under the default order this plan owns `removed` and Batch 4's contract diff will not.

**Cross-batch notes:**

- **Batch 5 telemetry seam** — Batch 3 does **not** call `emitProductEvent` (it does not exist yet); Batch 5 wires `report_submitted` into `submitReportAction` (Task 4) and `listing_removed` into `takeDownListingAction` (Task 6) at their success points (Global Constraints).
- **PROVINCE_CODES (Batch 2) is obsolete — resolved by FD-1.** Batch 2's `PROVINCE_CODES` is the pre-2025 63-province list; **FD-1** (`/tmp/loaviet/founder-decisions.md`) decides the fix: the 34 provincial units per NQ 202/2025/QH15, exact table + authoritative legacy mapping in `/tmp/loaviet/provinces-34.md` — the obsolete list **must be replaced** in Batch 2's execution. **Checked: Batch 3 has zero references to `PROVINCE_CODES`** (no dependency — seller-verification declarations are Batch 2's surface), so Batch 3 needs no change; the Batch 2 executor applies FD-1.

## Rollback and Data Backfill

- **Migration** (`batch3_trust_safety`): additive-only (verified via `npx prisma migration show` — the only destructive-looking operations are the expected `Listing_status_check_*` DROP+ADD pair, additive in effect, BLOCKING-2). Rollback = `git revert` of the Task 1 commit **plus** restore from the pre-migration backup per `docs/backup-restore.md`; no down-migration is authored (the Prisma 8 graph is forward-only). **A code revert drops nothing from the database** — the reverted code simply no longer knows the `removed` value; actual schema/data removal happens only via the backup restore. Production applies via the compose `migrate` service `--to production` after the ref advance in Task 1.
- **No backfill.** There is no legacy report/block/moderation/suspension data; §8.6's backfill requirements (dry-run behavior, expected count, idempotency, rollback, post-migration verification) are satisfied trivially — dry-run = "0 rows affected", no `--apply` path exists, rollback = the migration revert above, verification = `tests/integration/batch3-migration.test.ts` + `npx prisma db verify`.
- **No data cutover.** Blocking, reports, cases, evidence, suspensions, and appeals are all new rows written only by the new surfaces; existing `Conversation`/`Message` rows are never mutated by Batch 3. The one existing-row mutation is deliberate and recorded: takedown sets `Listing.status` to the new `removed` value (R4), **recording `previousStatus` in the takedown `AuditEvent.detail`** so A4's future restore path has the prior state — **a code revert changes no data** (removed rows stay removed; `git revert` of the Task 6 commit only removes the *code* that writes `removed`), and nothing writes `rejectionReason` from the moderation path. Restoring a removed listing is an appeal outcome (A4), not built.
- **Per-task rollback**: every task is one focused commit; `git revert <task-commit>` restores the previous behavior for all non-migration tasks. The Task 5 commit amends two Batch 2 interfaces — the publication gate (7 → 8 requirements) and `STEP_UP_CAPABILITIES` (gains `user.suspend`) — reverting it restores both (and must revert their test extensions in the same commit).

## Final Acceptance Commands

```bash
npm run lint
npx tsc --noEmit
npm test
npm run test:integration
npm run build
npm run preflight
npm run smoke
npx prisma migration list          # graph: baseline → batch2_identity_security → batch3_trust_safety
npx prisma db verify               # marker + schema khớp contract
git diff --check && git status --short
```

All green + the seven gate suites in Task 9 Step 1 + a clean diff/status audit = Batch 3 complete.
