# Private Beta Batch 2 — Identity, Seller Verification, Admin MFA/RBAC, Sessions, Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every account explicit email/phone verification state, make OTP delivery and account recovery abuse-resistant, move sessions into the database with inventory/revocation and sensitive-change invalidation, replace the broad `admin` check with capability RBAC + mandatory TOTP MFA + step-up, and make seller verification a reviewed workflow that gates listing publication — without weakening the Batch 1 finance shutdown.

**Architecture:** One additive Prisma 8 migration introduces the identity/security tables (sessions, OTP, seller verification, beta cohort, policy acceptance, admin MFA, audit events) plus nullable state columns on `User`. A new server-only session module replaces the stateless JWT cookie with an opaque DB-backed token. OTP, TOTP, and recovery codes are hand-rolled on `node:crypto` behind small pure modules with delivery behind an adapter seam. RBAC is a single typed capability matrix enforced by `requireCapability*` guards at every server-action boundary; the seller publication gate is one shared function called by every listing-status transition, including admin approval as defense-in-depth.

**Tech Stack:** Next.js 16.3.7 App Router (typed routes, server actions), React 19, TypeScript strict, Prisma 8 (`@prisma/orm-postgres` rc, contract + migration graph), PostgreSQL ≥ 15, Vitest (unit + scratch-container integration), zod, `node:crypto` (OTP/recovery-code/ip HMAC hashing), `otpauth` 9.5.2 exact-pinned (TOTP/HOTP/base32/URI — the one new runtime dependency, see Global Constraints).

**Spec:** `docs/superpowers/specs/2026-10-06-private-beta-marketplace-reset-design.md` — Batch 2 is spec §9 "Batch 2", built on §5.3 (identity/seller verification), §5.4 (admin MFA/RBAC), §2.1 (beta access model), §7 (abuse controls), §8 (migration strategy), §4 (invariants), §10 (verification), §11 (execution protocol). The plan argues from the spec; executors read both.

## Global Constraints

- Read `AGENTS.md` and the relevant Next.js 16 docs before editing app code. At minimum (paths as used by the Batch 0–1 plan): `node_modules/next/dist/docs/01-app/02-guides/server-actions.md`, `.../01-app/01-getting-started/15-route-handlers.md`, `.../01-app/02-guides/environment-variables.md`, `.../01-app/02-guides/redirecting.md`, `.../01-app/02-guides/testing/vitest.md`, plus the current auth/cookies API-reference guides under `node_modules/next/dist/docs/` for `cookies()` behavior in server actions. Heed deprecation notices; this is not the Next.js from training data.
- Prisma 8 contract/migration workflow (`.agents/skills/prisma-8/references/contract.md` + `migrations.md`): edit `src/prisma/contract.prisma` → `npx prisma contract emit` → `npx prisma migration plan --name <snake_slug>` → fill any `placeholder(...)`/data-transform holes in the rendered `migration.ts` → self-emit with `node migrations/app/<dir>/migration.ts` → review with `npx prisma migration show <dir>` → `npx prisma db migrate` → advance refs. Never `db update` against a shared/production database; never edit `ops.json`/`contract.json`/`contract.d.ts` by hand; commit contract artefacts + migration package together; `migration.ts` is framework-rendered — edit only the holes and add `this.dataTransform(...)` operations, never rewrite the rendered import line.
- **Dependency policy.** Security-reviewed, pinned dependencies are allowed — and preferred — wherever they replace bespoke crypto. Batch 2 adds exactly one runtime dependency: **`otpauth` pinned exact `9.5.2`** (MIT; maintained HOTP/TOTP per RFC 4226/6238 with base32 + `otpauth://` URI; ESM/CJS Node builds + bundled TypeScript types; published via GitHub-OIDC trusted publishing with SLSA provenance + registry signatures; its single transitive runtime dep is `@noble/hashes` `2.4.0`, exact-pinned by its own lockfile-style manifest). Install step (Task 8): `npm install --save-exact otpauth@9.5.2` — `package.json` must carry `"otpauth": "9.5.2"` with **no `^` range**; commit `package-lock.json` (integrity hashes); `npm audit` must be clean at batch acceptance (recorded in the verification doc). OTP HMAC hashing, recovery-code hashing, and ip hashing remain `node:crypto` HKDF helpers — those are keyed HMACs, not bespoke ciphers.
- Test-first for every behavior change: add the failing test, confirm the expected failure, implement the minimum, rerun the focused test. Unit tests mock `server-only`, `next/cache`, `next/navigation`, and the db client exactly like `tests/unit/financial-shutdown-actions.test.ts` does; integration tests run only via `scripts/test-integration.sh` against the scratch container.
- **Additive-only schema.** No drop, rename, or repurpose of any existing column/table. `User.role` (`buyer|seller|admin`) and `User.isVerifiedSeller` remain in place for compatibility; new authorization reads only the new `User.adminRole` and `SellerVerification` (spec §8.2, §8.5). All new columns are nullable or defaulted.
- **Preserve Batch 1.** `FINANCIAL_FEATURES_ENABLED` stays `false`; every existing finance guard and its tests (`tests/unit/financial-shutdown-*.test.ts`, `tests/unit/finance-public-surface.test.ts`, `tests/unit/admin-finance-readonly.test.ts`) must stay green unchanged. No Batch 2 task may enable, bypass, or weaken a finance boundary.
- **Backend authorization only.** Every privileged action and admin page checks capability server-side (spec §4.5, §4.9). Hidden navigation, disabled buttons, and URL obscurity are not access controls and must not be relied on anywhere.
- **Policy Non-Invention (spec §4.11 + §11.1).** Do not invent semantics for seller verification, identity merging, PII access, administrator permissions, legal acceptance, retention, or moderation sanctions. Material ambiguity → record it, preserve the safer existing behavior, stop the affected task, and request a spec update. The plan's *Ambiguities* section lists the known ones; treat its items as blocking where marked.
- **No account merging.** A verified email/phone owned by another account never triggers a merge (spec §5.3.1); it produces a typed collision error.
- **OTP rules (spec §5.3):** hashed at rest, single-use, short-lived, attempt-limited, resend-limited, rate-limited, enumeration-safe, invalidated after successful use, and **never written to logs or analytics output in ANY environment** (spec §4.8) — there is no console adapter and no dev logging of codes; non-production delivery uses an in-memory inbox with a dev/test-only retrieval seam that is unreachable in production. Production delivery fails closed with a typed error until a real provider adapter is configured.
- **SMS is not an admin MFA factor** (spec §5.3). Admin MFA is TOTP + single-use recovery codes only.
- **`AdminMfa` encryption uses a dedicated key, never `AUTH_SECRET`.** `ADMIN_MFA_ENCRYPTION_KEY` = base64 of exactly 32 random bytes (`openssl rand -base64 32`); server-only, never `NEXT_PUBLIC_*`, never derived from `AUTH_SECRET`. Strict validation in `src/lib/env.ts` (base64 decoding to exactly 32 bytes); **required in production** (fail-fast at startup via `instrumentation.ts` → `validateEnv`), optional-but-validated in dev/test. Ciphertext envelopes are versioned `v1:<keyId>:<base64(iv ‖ tag ‖ ciphertext)>` where `keyId` = first 8 hex of SHA-256(key) — a non-secret identifier that turns wrong-key decryption into a typed `ADMIN_MFA_KEY_MISMATCH` error instead of silent corruption, which is what makes safe future key rotation possible (procedure in the Task 11 runbook).
- **Audit events** record actor, action, resource, reason, timestamp, session/request context, and policy version where appropriate (spec §4.6). `detail` must never contain raw email/phone, OTP codes, passwords, or TOTP secrets (spec §4.8).
- **Seller-verification copy** uses the spec §6.2 wording: `Đã xác minh thông tin người bán theo yêu cầu hiện tại của LoaViet.` — never language implying guarantee/endorsement.
- OpenCode must not push, merge, deploy, or destructively clean the repository. Commit each task separately with the listed message; never `git add .`. Exclude from commits: `.claude/settings.json`, `public/uploads/`, secrets, local scratch data, unrelated work.
- Session cutover note: replacing the JWT cookie invalidates all existing logins (users must log in again). This is accepted for the pre-launch private beta and must be recorded in the batch verification doc.

## Batch 2 Scope Decisions

In scope (spec §9 Batch 2 deliverables):

1. `emailVerifiedAt` / `phoneVerifiedAt` account state + verification actions.
2. OTP core (hash, single-use, TTL, attempt/resend/rate limits) + delivery adapter seam (in-memory dev/test adapter with a dev-only retrieval seam that is unreachable in production and never logs; production fail-closed until a real provider adapter is configured).
3. Identity linking rules: email/phone change with step-up, verified-identifier uniqueness, no merge, session invalidation on sensitive change, security notices to previous channels.
4. Account recovery: enumeration-safe password recovery via OTP to a verified channel (email *or* phone — covers lost-email and lost-phone), revoking all sessions.
5. DB-backed sessions: opaque token, inventory, revocation, shorter admin TTL, step-up timestamp, sensitive-change invalidation.
6. `SellerVerification` workflow (states, reason codes, policy version, reviewer) + Seller Verification Policy v1 gate function.
7. `BetaCohortMembership` model + minimal admin grant/suspend action (the *publication gate* needs it); the full invitation/console/concierge flow is Batch 7.
8. Capability RBAC (`super_admin|operations_admin|moderator|support|analyst` → typed capabilities) replacing `requireAdmin()`; admin role management action.
9. Admin TOTP MFA + single-use recovery codes; mandatory at login for every `adminRole` account; step-up for sensitive admin actions.
10. Audit foundation: typed `AuditEvent` writer wired into every new privileged/security action + admin audit view.
11. Admin bootstrap + MFA-lockout recovery as an offline maintenance script + exercised runbook.

Explicitly deferred (do not build here): Batch 7 cohort operations (invitation flow, founding-seller console, concierge), Batch 3 moderation/report/block/appeals, Batch 4 listing states/drafts/category allowlist/photo checklist, admin-assisted out-of-band recovery tool, PII export, production email/SMS provider adapter, Seller Rules legal text (Batch 8 records the review; Batch 2 ships only the acceptance-recording mechanism), and **account deletion** — consequently *identifier reuse after account deletion* (spec §5.3.1) is enforced only as "unique among active accounts" (there are no inactive accounts in P0); it becomes testable when a deletion surface ships in a later batch.

## Legacy Migration Decisions (additive, spec §8.2 + §8.5)

- `User.role = "admin"` → **`User.adminRole = "super_admin"`** via a data transform inside the Batch 2 migration (intentional mapping of the existing broad-admin accounts; the founder's own account is the only one today). After Batch 2, `role` is display-only; `adminRole` is the only admin authorization source. `role` keeps the value `"admin"` for UI compatibility.
- `User.isVerifiedSeller = true` → a `SellerVerification` row (`status: "verified"`, `method: "operations_review"`, `reasonCode: "migrated_legacy_verified"`, `policyVersion: "v1"`, `reviewedAt: now`, `reviewerId: null`) via an idempotent offline backfill script (Task 10). The legacy boolean stays readable for existing UI but grants nothing; the publication gate reads only the workflow. A migrated `verified` row alone does **not** satisfy the publication gate — the seller still needs verified email/phone, declaration, rules acceptance, and active `founding_seller` membership (spec §2.1, §8.4: existing users do not automatically become founding sellers).
- No existing finance table, historical record, or legacy column is dropped or repurposed.

## Dependency and Parallelization Map

```text
Task 1  contract + migration + adminRole backfill
        ↓ (schema is the base commit for everything)
Task 2  DB-backed sessions + auth.ts rewrite
        ↓
        ├── Task 3  OTP core + delivery adapters      ┐
        ├── Task 4  RBAC engine + re-gate admin       │ {3, 4, 5} may run in parallel
        └── Task 5  audit event foundation            ┘
        ↓
        ├── Task 6  email/phone verification + identity changes   ┐ {6, 7} parallel after 3+5;
        │                                                        │  8 after 4+5
        ├── Task 7  account recovery                              │
        └── Task 8  admin MFA (TOTP + recovery codes + login + step-up)
        ↓
Task 9  admin session inventory/revocation UI + admin layout RBAC + user session list
        ↓
Task 10 SellerVerification workflow + Policy v1 + beta cohort + publication gate + backfill
        ↓
Task 11 admin role management + bootstrap script + runbook (exercised)
        ↓
Task 12 batch gate verification + verification doc
```

File-conflict rules: `src/lib/auth.ts` is touched by Task 2 (session rewrite) and Task 4 (delete `requireAdmin`) — run sequentially. `src/lib/actions/admin.ts` is touched by Task 4 (call-site migration) and Task 10 (publication-gate + legacy toggle removal) — run sequentially. `src/lib/actions/auth.ts` is touched by Task 8 (MFA login) only. `app/admin/users/page.tsx` is touched by Task 9 (session revoke) and Task 10 (toggle → cohort/verification links) — sequentially. `src/lib/rbac.ts` is created by Task 4 and extended by Task 8 (step-up guard) — sequentially. Everything else is single-owner.

## Review Focus

1. **OTP plaintext leaking into logs/analytics** — any delivery/error path that prints the raw code, in any environment including dev (spec §4.8, §5.3). Pinned by Task 3: `tests/unit/verification-delivery.test.ts` "in-memory adapter stores but never logs the code" + "the dev retrieval seam is unreachable in production" + `tests/unit/otp.test.ts` "requestOtp/verifyOtp never emit the plaintext code" (spy on `console.log/error` and `captureEvent` payloads).
2. **Revoked-seller publication bypass** — a seller whose verification was revoked (or membership suspended) still publishing via `createListingAction`, `updateListingAction`, `toggleListingVisibilityAction` (hidden→approved), or admin `approveListingAction` (spec §7.3). Pinned by Task 10: `tests/unit/publication-gate.test.ts` — all four transitions deny after revocation/suspension, including when called by an admin.
3. **Stale-session reuse after recovery** — a session created before a password reset (or email/phone change) still authorizes afterwards (spec §7.2). Pinned by Task 7: `tests/unit/recovery-actions.test.ts` "confirmPasswordRecoveryAction revokes every session including the current one" and Task 2: `tests/unit/session.test.ts` "a revoked session fails lookup on the next request".
4. **Support→admin / moderator→cohort escalation via direct action invocation** — a non-granted role calling a privileged server action directly (not through the UI) succeeds (spec §7.3). Pinned by Task 4: `tests/unit/rbac.test.ts` "every admin action denies roles without the capability" (parameterized over the action registry) and Task 10: `tests/unit/seller-verification-actions.test.ts` "moderator/support cannot review or grant cohort".
5. **Concurrent seller-verification double-decision** — two admins reviewing the same verification simultaneously both succeed (spec §10.1). Pinned by Task 10: `tests/unit/seller-verification-actions.test.ts` "second decision on an already-reviewed row fails with VERIFICATION_ALREADY_REVIEWED" (atomic status-claim update).

---

## Task 1: Contract additions + Batch 2 migration + adminRole backfill

**Files:**

- Modify: `src/prisma/contract.prisma`
- Create: `migrations/app/<ts>_batch2_identity_security/` (rendered by `prisma migration plan`, then hand-edited for the data transform)
- Modify (emitted): `src/prisma/contract.json`, `src/prisma/contract.d.ts`
- Modify: `migrations/app/refs/db.json`, `migrations/app/refs/production.json` (ref advancement)
- Test: `tests/integration/batch2-migration.test.ts`

**Interfaces:**

- Consumes: existing `User`, `AdminAuditLog`, finance models (untouched).
- Produces (used by every later task via `db.orm.public.<Model>`): models `UserSession`, `OtpCode`, `SellerVerification`, `BetaCohortMembership`, `PolicyAcceptance`, `AdminMfa`, `AdminRecoveryCode`, `AuditEvent`; enums `admin_role`, `seller_type`, `seller_verification_status`, `seller_verification_method`, `otp_purpose`, `otp_channel`, `beta_cohort`, `beta_membership_status`; new `User` columns `emailVerifiedAt`, `phoneVerifiedAt`, `adminRole`, `sellerType`, `sellerOperatingProvinceCode`.

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/batch2-migration.test.ts` (runs only via `scripts/test-integration.sh`, scratch DB, same `hasDb` guard pattern as `tests/integration/escrow.test.ts`):

- `applies the batch 2 migration additively`: after the script's migrate step, `db.orm.public.UserSession`, `OtpCode`, `SellerVerification`, `BetaCohortMembership`, `PolicyAcceptance`, `AdminMfa`, `AdminRecoveryCode`, `AuditEvent` each accept a create+delete round-trip with the fields below (proves tables/columns exist).
- `backfill predicate compiles against the real schema`: create a user with `role: "admin"` and `adminRole: null`, then run the exact UPDATE the data transform performs (`User.update({ adminRole: "super_admin" }).where(role = "admin", adminRole null)`) and assert the row changed — proving the column and predicate the migration will use. The end-to-end backfill of a *pre-existing* admin row is exercised in Task 11's bootstrap test against the baseline contract.
- `migration leaves the database consistent`: `npx prisma db verify` exits 0 after migrate (schema + marker satisfy the contract).
- `preserves finance tables`: `Order`, `Payment`, `Payout`, `WithdrawRequest`, `LedgerEntry`, `Dispute` still accept reads and a seeded `Order`+`Payment` row reads back unchanged (create one and read it).

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:integration`
Expected: FAIL — new models/tables do not exist (`UserSession` etc. not in contract).

- [ ] **Step 3: Edit the contract, emit, plan the migration**

Add to `src/prisma/contract.prisma` (match existing style: `// use prisma-8` header already present, `@@type("pg/text@1")` on enums, `TimestamptzString`, `temporal.updatedAtString()`):

```prisma
// ─── Enums (Batch 2 — identity & security) ───

enum admin_role {
  @@type("pg/text@1")
  super_admin      = "super_admin"
  operations_admin = "operations_admin"
  moderator        = "moderator"
  support          = "support"
  analyst          = "analyst"
}

enum seller_type {
  @@type("pg/text@1")
  individual = "individual"
  business   = "business"
}

enum seller_verification_status {
  @@type("pg/text@1")
  not_started  = "not_started"
  pending      = "pending"
  verified     = "verified"
  rejected     = "rejected"
  needs_review = "needs_review"
  revoked      = "revoked"
}

enum seller_verification_method {
  @@type("pg/text@1")
  operations_review = "operations_review"
}

enum otp_purpose {
  @@type("pg/text@1")
  email_verification = "email_verification"
  phone_verification  = "phone_verification"
  password_recovery    = "password_recovery"
}

enum otp_channel {
  @@type("pg/text@1")
  email = "email"
  phone = "phone"
}

enum beta_cohort {
  @@type("pg/text@1")
  internal           = "internal"
  founding_seller    = "founding_seller"
  private_beta_buyer = "private_beta_buyer"
}

enum beta_membership_status {
  @@type("pg/text@1")
  invited   = "invited"
  active    = "active"
  suspended = "suspended"
  exited    = "exited"
}
```

Add to `User` (additive only — nothing existing is removed or retyped):

```prisma
  emailVerifiedAt             TimestamptzString?
  phoneVerifiedAt             TimestamptzString?
  adminRole                   admin_role?
  sellerType                  seller_type?
  sellerOperatingProvinceCode String?

  sessions                    UserSession[]         @relation("session_user")
  otpCodes                    OtpCode[]             @relation("otp_user")
  sellerVerification          SellerVerification?   @relation("seller_verification_user")
  betaMemberships             BetaCohortMembership[] @relation("beta_membership_user")
  policyAcceptances           PolicyAcceptance[]     @relation("policy_acceptance_user")
  adminMfa                    AdminMfa?             @relation("admin_mfa_user")
  auditEventsActor            AuditEvent[]          @relation("audit_event_actor")
  auditEventsSubject          AuditEvent[]          @relation("audit_event_subject")
```

New models:

```prisma
// ─── Session (Batch 2 — DB-backed, spec §5.4.2) ───

model UserSession {
  id           String             @id @default(uuid())
  userId        String
  user          User               @relation("session_user", fields: [userId], references: [id], onDelete: Cascade)
  tokenHash     String             @unique
  isAdmin       Boolean            @default(false)
  createdAt     TimestamptzString  @default(now())
  lastSeenAt    TimestamptzString?
  expiresAt     TimestamptzString
  revokedAt     TimestamptzString?
  revokedReason String?
  steppedUpAt   TimestamptzString?
  userAgent     String?

  @@index([userId, createdAt])
  @@index([expiresAt])
}

// ─── OTP (Batch 2 — spec §5.3: hashed, single-use, short-lived) ───

model OtpCode {
  id         String            @id @default(uuid())
  userId      String
  user        User              @relation("otp_user", fields: [userId], references: [id], onDelete: Cascade)
  purpose     otp_purpose
  channel     otp_channel
  target      String            // email/phone đã chuẩn hóa — mã chỉ hợp lệ cho đúng target
  codeHash    String            // HMAC-SHA256 keyed — không lưu mã thô
  attempts    Int               @default(0)
  expiresAt   TimestamptzString
  consumedAt  TimestamptzString?
  createdAt   TimestamptzString @default(now())

  @@index([userId, purpose, createdAt])
  @@index([target, purpose, createdAt])
  @@index([expiresAt])
}

// ─── Seller verification (spec §5.3.2 — workflow, không phải boolean) ───

model SellerVerification {
  id            String                        @id @default(uuid())
  userId        String                        @unique
  user          User                          @relation("seller_verification_user", fields: [userId], references: [id])
  status        seller_verification_status    @default(pending)
  method        seller_verification_method    @default(operations_review)
  submittedAt   TimestamptzString?
  reviewedAt    TimestamptzString?
  reviewerId    String?
  reasonCode    String?
  note          String?
  policyVersion String
  createdAt     TimestamptzString             @default(now())
  updatedAt     temporal.updatedAtString()

  @@index([status, updatedAt])
}

// ─── Beta cohort (spec §2.1 — membership là điều kiện publication) ───

model BetaCohortMembership {
  id         String                 @id @default(uuid())
  userId     String
  user       User                   @relation("beta_membership_user", fields: [userId], references: [id], onDelete: Cascade)
  cohort     beta_cohort
  status     beta_membership_status @default(invited)
  invitedBy  String?
  invitedAt  TimestamptzString?
  acceptedAt TimestamptzString?
  expiresAt  TimestamptzString?
  notes      String?
  createdAt  TimestamptzString      @default(now())
  updatedAt  temporal.updatedAtString()

  @@unique([userId, cohort])
  @@index([cohort, status])
}

// ─── Policy acceptance (spec §3.1 legal — cơ chế ghi nhận, văn bản thuộc Batch 8) ───

model PolicyAcceptance {
  id            String            @id @default(uuid())
  userId        String
  user          User              @relation("policy_acceptance_user", fields: [userId], references: [id], onDelete: Cascade)
  policyKey     String            // "seller_rules"
  policyVersion String            // "v1"
  acceptedAt    TimestamptzString  @default(now())

  @@unique([userId, policyKey, policyVersion])
  @@index([userId, policyKey])
}

// ─── Admin MFA (spec §5.3/§5.4.2 — TOTP + mã khôi phục dùng một lần) ───

model AdminMfa {
  id              String               @id @default(uuid())
  userId          String              @unique
  user            User                @relation("admin_mfa_user", fields: [userId], references: [id], onDelete: Cascade)
  totpSecretEnc   String              // AES-256-GCM envelope "v1:<keyId>:<iv‖tag‖ct>"; key = ADMIN_MFA_ENCRYPTION_KEY (env riêng, không phải AUTH_SECRET)
  totpConfirmedAt TimestamptzString?
  createdAt       TimestamptzString   @default(now())
  updatedAt       temporal.updatedAtString()

  recoveryCodes   AdminRecoveryCode[]
}

model AdminRecoveryCode {
  id        String            @id @default(uuid())
  mfaId     String
  mfa       AdminMfa          @relation(fields: [mfaId], references: [id], onDelete: Cascade)
  codeHash  String
  usedAt    TimestamptzString?
  createdAt TimestamptzString @default(now())

  @@index([mfaId, usedAt])
}

// ─── Audit foundation (spec §4.6 — actor/action/resource/reason/context/policy) ───

model AuditEvent {
  id            String            @id @default(uuid())
  actorId       String?
  actor         User?             @relation("audit_event_actor", fields: [actorId], references: [id], onDelete: SetNull)
  subjectId     String?
  subject       User?             @relation("audit_event_subject", fields: [subjectId], references: [id], onDelete: SetNull)
  action        String            // typed, dot-namespaced: "seller_verification.reviewed" | "session.revoked" | ...
  resourceType  String?
  resourceId    String?
  reason        String?           // typed reason code
  policyVersion String?
  sessionId     String?
  ipHash        String?
  detail        String?            // KHÔNG chứa PII thô/OTP/secret (spec §4.8)
  createdAt     TimestamptzString  @default(now())

  @@index([actorId, createdAt])
  @@index([subjectId, createdAt])
  @@index([action, createdAt])
}
```

Then:

```bash
npx prisma contract emit
npx prisma migration plan --name batch2_identity_security
```

- [ ] **Step 4: Review the package, add the adminRole backfill, self-emit**

- Confirm the plan output's `from:` line names the baseline hash `7a6d2852…` (the current `db`/`production` ref), not `(baseline)` over a non-empty graph, and `pendingPlaceholders` is `false` (all new columns are nullable/defaulted — the planner must not emit data-transform placeholders; if it does, stop and re-check the contract for accidental non-null columns).
- `npx prisma migration show <dir>` — confirm **zero `destructive` operations** (additive-only). Any drop/alter of an existing column is a plan violation: fix the contract instead.
- Hand-add one data transform to the rendered `operations` array (this is the intentional legacy mapping, spec §8.5), following the exact pattern in `.agents/skills/prisma-8/references/migrations.md` § *Fill a placeholder* (build the query builder from `endContract` at module scope):

```ts
this.dataTransform(endContract, 'backfill-admin-role', {
  check: () => db.public.User.select('id')
    .where((f, fns) => fns.and(fns.eq(f.role, 'admin'), fns.isNull(f.adminRole)))
    .limit(1),
  run: () => db.public.User.update({ adminRole: 'super_admin' })
    .where((f, fns) => fns.and(fns.eq(f.role, 'admin'), fns.isNull(f.adminRole))),
}),
```

- Self-emit: `node migrations/app/<dir>/migration.ts` (regenerates `ops.json` + `migrationHash`).
- Re-run `npx prisma migration show <dir>` — the transform appears as a `data` operation.

- [ ] **Step 5: Apply to the dev DB and advance refs**

```bash
npx prisma db migrate --advance-ref db          # dev DB (DATABASE_URL từ .env, container 5435)
npx prisma migration ref set production <end-hash>   # end-hash = migration.json "to" — deploy target cho stack production
npx prisma db verify                            # diagnostic: marker + schema khớp contract
```

`production` ref must be advanced in the same commit: `docker-compose.prod.yml`'s migrate service applies the graph `--to production` (docs/deployment.md §2), so an unadvanced ref would silently skip the migration in production.

- [ ] **Step 6: Run the integration test to verify it passes**

Run: `npm run test:integration`
Expected: PASS (all `batch2-migration` cases + existing `escrow.test.ts` green).

- [ ] **Step 7: Commit**

```bash
git add src/prisma/contract.prisma src/prisma/contract.json src/prisma/contract.d.ts migrations/app migrations/snapshots tests/integration/batch2-migration.test.ts
git commit -m "feat(db): add batch 2 identity & security contract"
```

**Gate:** no destructive op in `migration show`; `db verify` clean; finance integration test still green.

## Task 2: DB-backed sessions + auth rewrite

**Files:**

- Create: `src/lib/session.ts`
- Modify: `src/lib/auth.ts`
- Test: `tests/unit/session.test.ts`
- Test: `tests/integration/session-lifecycle.test.ts`

**Interfaces:**

- Consumes: `UserSession` model (Task 1), `AUTH_SECRET` env, `cookies()` from `next/headers`.
- Produces (used by Tasks 4, 6, 7, 8, 9, 10):

```ts
// src/lib/session.ts
export const SESSION_COOKIE = "sp_session";            // giữ nguyên tên cookie
export const CONSUMER_SESSION_TTL_HOURS = 24 * 30;      // 30 ngày — giữ hành vi hiện tại
export const ADMIN_SESSION_TTL_HOURS = 12;              // admin ngắn hơn (spec §5.4.2)
export const STEP_UP_MAX_AGE_MINUTES = 15;

export type SessionInfo = {
  id: string; userId: string; isAdmin: boolean;
  createdAt: string; lastSeenAt: string | null; expiresAt: string;
  steppedUpAt: string | null; userAgent: string | null;
};

export async function createSession(userId: string, opts?: { isAdmin?: boolean; userAgent?: string }): Promise<void>;
export async function getSessionFromCookie(): Promise<{ session: SessionInfo; user: SessionUser } | null>;
//   một lookup duy nhất: session row + User → SessionUser (getCurrentUser dùng lại kết quả này)
export async function revokeSession(sessionId: string, reason: string): Promise<void>;
export async function revokeAllUserSessions(userId: string, reason: string, opts?: { exceptSessionId?: string }): Promise<number>;
export async function listUserSessions(userId: string): Promise<SessionInfo[]>;
export async function markSessionSteppedUp(sessionId: string): Promise<void>;
export async function touchSessionLastSeen(sessionId: string): Promise<void>; // throttle: chỉ ghi khi > 5 phút
export function stepUpIsFresh(steppedUpAt: string | null): boolean;
```

```ts
// src/lib/session.ts — SessionUser ĐỊNH NGHĨA Ở ĐÂY (tránh import vòng auth↔session);
// src/lib/auth.ts re-export `export type { SessionUser }` cho các import hiện tại.
export type SessionUser = {
  id: string; email: string; name: string;
  role: "buyer" | "seller" | "admin";
  avatarUrl: string | null;
  isVerifiedSeller: boolean;   // legacy — CHỈ hiển thị; không dùng làm quyền
  adminRole: "super_admin" | "operations_admin" | "moderator" | "support" | "analyst" | null;
  sessionId: string;
};
// src/lib/auth.ts: hashPassword / verifyPassword / requireUser / destroySession giữ nguyên chữ ký.
// createSession(userId, opts?) / getCurrentUser() giữ nguyên chữ ký — đổi internals (delegate sang session.ts).
// requireAdmin() bị XÓA (Task 4 thay bằng rbac.requireCapability*).
```

- [ ] **Step 1: Write the failing unit tests**

`tests/unit/session.test.ts` (mock `server-only`, `next/headers` with a controllable cookie store, `@/src/prisma/db.client` with an in-memory `UserSession` map + `User` fixture — same mock style as the finance tests):

- `createSession stores a sha256 tokenHash, not the token`: the persisted row's `tokenHash` is 64-hex and differs from the raw cookie value; cookie is set `httpOnly`, `sameSite: "lax"`, `path: "/"`, `secure` in production.
- `consumer TTL is 30 days, admin TTL is 12 hours`: `expiresAt` per `isAdmin`.
- `getSessionFromCookie returns null for unknown/revoked/expired/garbage tokens` (four cases).
- `a revoked session fails lookup on the next request` (Review Focus 3).
- `revokeAllUserSessions keeps the excepted session and revokes the rest, returning the count`.
- `stepUpIsFresh: true within 15 minutes, false when older, false when null`.
- `session fixation: two consecutive createSession calls produce different tokens` (Review Focus 3 — fresh random token per login).
- `touchSessionLastSeen is throttled`: only writes when `lastSeenAt` is > 5 minutes old.

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/unit/session.test.ts`
Expected: FAIL — `src/lib/session.ts` does not exist.

- [ ] **Step 3: Implement `src/lib/session.ts` and rewrite `src/lib/auth.ts`**

- Token: `crypto.randomBytes(32).toString("base64url")`; `tokenHash = sha256(token).digest("hex")` (plain SHA-256 is fine here — the token itself is 256-bit random, the hash is lookup, not secrecy).
- `createSession` inserts the row, then sets the cookie with `maxAge` = TTL.
- `getSessionFromCookie`: read cookie → hash → `UserSession.first({ tokenHash })` → reject when `revokedAt != null` or `expiresAt <= now` → load `User` → return `{ session, user }`; update `lastSeenAt` via the throttled touch; never throws (fail closed to logged-out, matching current `getCurrentUser` behavior).
- `revokeSession` sets `revokedAt` + `revokedReason` (idempotent).
- `revokeAllUserSessions` uses one `updateAll` with the optional exclusion predicate and returns the affected count.
- `src/lib/auth.ts`: `getCurrentUser()` = `(await getSessionFromCookie())?.user ?? null` (the session module loads the `User` in the same lookup); `destroySession()` = revoke current session (`reason: "logout"`) + delete cookie; `requireUser()` unchanged behavior; re-export `SessionUser`. **Leave `requireAdmin()` and its call sites (`src/lib/actions/admin.ts`, `src/lib/actions/withdraw.ts`, `app/admin/layout.tsx`) untouched in this task** — the legacy check still compiles and works against the new `SessionUser` (it reads `user.role`, which is unchanged); Task 4 migrates every call site to `requireCapability*`/`requireAdminUser()` and deletes `requireAdmin()` in the same commit, so no temporary or transitional guard ever exists.

- [ ] **Step 4: Run tests until green, then the regression suites**

Run: `npm test -- tests/unit/session.test.ts` → PASS.
Run: `npm test` → all existing suites green (`requireAdmin()` still exists and works in this task — the finance tests that mock `@/src/lib/auth` keep passing unchanged; Task 4 migrates the callers and deletes it).
Run: `npm run test:integration` → `tests/integration/session-lifecycle.test.ts` (new): create → get → revoke → get null; revokeAll except one; expiry boundary — all against the real DB.

- [ ] **Step 5: Commit**

```bash
git add src/lib/session.ts src/lib/auth.ts tests/unit/session.test.ts tests/integration/session-lifecycle.test.ts
git commit -m "feat(auth): database-backed sessions with revocation"
```

## Task 3: OTP core + delivery adapters

**Files:**

- Create: `src/lib/otp.ts`
- Create: `src/lib/verification-delivery.ts`
- Create: `app/api/dev/otp-inbox/route.ts` (dev/test-only retrieval seam — 404 in production)
- Test: `tests/unit/otp.test.ts`
- Test: `tests/unit/verification-delivery.test.ts`

**Interfaces:**

- Consumes: `OtpCode` model (Task 1), `AUTH_SECRET`, `checkRateLimit` from `src/lib/rate-limit.ts`.
- Produces (used by Tasks 6, 7):

```ts
// src/lib/otp.ts
export type OtpPurpose = "email_verification" | "phone_verification" | "password_recovery";
export type OtpChannel = "email" | "phone";

export const OTP_TTL_MINUTES = 10;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_SEC = 60;
export const OTP_PER_TARGET_RULE = { limit: 3, windowMs: 10 * 60_000 }; // 3 mã / 10 phút / (userId,purpose,target)

export type OtpRequestResult =
  | { ok: true; resendAfterSec: number }
  | { ok: false; code: "OTP_RATE_LIMITED"; retryAfterSec: number }
  | { ok: false; code: "OTP_DELIVERY_UNAVAILABLE" };

export async function requestOtp(params: { userId: string; purpose: OtpPurpose; channel: OtpChannel; target: string }): Promise<OtpRequestResult>;

export type OtpVerifyResult =
  | { ok: true }
  | { ok: false; code: "OTP_NOT_FOUND" | "OTP_EXPIRED" | "OTP_MAX_ATTEMPTS" };

export async function verifyOtp(params: { userId: string; purpose: OtpPurpose; channel: OtpChannel; target: string; code: string }): Promise<OtpVerifyResult>;

export function normalizeEmail(raw: string): string;   // trim + lowercase
export function normalizePhone(raw: string): string;   // bỏ khoảng cách/dấu chấm, +84→0, validate /^0\d{9,10}$/ — throw khi sai format
export function hkdfKey(info: string): Buffer;          // HKDF-SHA256 từ AUTH_SECRET — dùng chung: OTP hash, recovery-code hash,
                                                        // ip hash (Tasks 5/8). KHÔNG dùng cho mã hóa AdminMfa — key đó là
                                                        // ADMIN_MFA_ENCRYPTION_KEY riêng (Task 8), không derive từ AUTH_SECRET
```

```ts
// src/lib/verification-delivery.ts
export type OtpDeliveryParams = { to: string; code: string; purpose: OtpPurpose; channel: OtpChannel };
export type SecurityNoticeParams = { to: string; channel: OtpChannel; subjectKey: string };

export interface OtpDeliveryAdapter {
  readonly name: string;
  sendOtp(params: OtpDeliveryParams): Promise<void>;          // KHÔNG log mã thô — không môi trường nào (spec §4.8)
  sendSecurityNotice(params: SecurityNoticeParams): Promise<void>; // "when feasible" (spec §5.3.1) — fail-open có log
}

export function getOtpDeliveryAdapter(): OtpDeliveryAdapter;
// NODE_ENV !== "production" → in-memory adapter: sendOtp lưu mã vào inbox module-level
//   (Map theo `${channel}:${to}:${purpose}`) — KHÔNG BAO GIỜ console.log/in mã (spec §4.8 áp dụng
//   cả dev/test); sendSecurityNotice lưu vào inbox tương tự.
// NODE_ENV === "production"  → fail-closed adapter: sendOtp throw typed OTP_DELIVERY_UNAVAILABLE
//   (spec §5.3: production refuses delivery without valid provider config — xem Ambiguities A1)

export function peekDevOtpInbox(target: string, purpose: OtpPurpose, channel: OtpChannel): string | null;
//   seam truy xuất test/dev: trả mã cuối cho (channel,target,purpose) từ inbox in-memory.
//   NODE_ENV === "production" → throw typed DEV_OTP_INBOX_UNAVAILABLE (unreachable by construction).
//   KHÔNG log. Route dev-only app/api/dev/otp-inbox dùng seam này cho dev thủ công.
```

- [ ] **Step 1: Write the failing unit tests**

`tests/unit/otp.test.ts` (mock db with an in-memory `OtpCode` store; mock the delivery adapter with a spy):

- `requestOtp stores an HMAC hash, never the plaintext code` — persisted `codeHash` is 64-hex and `!== code`; `expiresAt` = now + 10 min.
- `resend cooldown: a second request within 60s returns OTP_RATE_LIMITED with retryAfterSec` (Review Focus 1 adjacent: the rate-limited path must not have sent a second delivery — assert the adapter spy was called once).
- `per-target limit: 4th request within 10 min returns OTP_RATE_LIMITED`.
- `verifyOtp: correct code → ok and the row is consumed (consumedAt set)`.
- `single-use: reusing the same code returns OTP_NOT_FOUND` (spec §5.3 "invalidated after successful use").
- `wrong code increments attempts; 5th wrong attempt → OTP_MAX_ATTEMPTS; further attempts keep failing`.
- `expired code → OTP_EXPIRED`.
- `code for a different target/purpose/user does not verify` (target binding).
- `requestOtp/verifyOtp never emit the plaintext code` (Review Focus 1): spy `console.log`, `console.error`, `captureEvent` — no argument string contains the 6-digit code.
- `normalizePhone: "+84 901 234 567" → "0901234567"; "0901.234.567" → "0901234567"; "12345" throws`.
- `delivery failure: adapter throws → row is deleted and OTP_DELIVERY_UNAVAILABLE returned` (no orphaned unusable code).

`tests/unit/verification-delivery.test.ts`:

- `in-memory adapter stores the code in the inbox and never logs` — spy `console.log`, `console.error`, `captureEvent`: no argument contains the code after `sendOtp`; `peekDevOtpInbox` returns it (Review Focus 1 — no environment logs OTP).
- `peekDevOtpInbox returns the last code per (channel,target,purpose) in dev and throws DEV_OTP_INBOX_UNAVAILABLE in production` (stub `NODE_ENV`).
- `dev route /api/dev/otp-inbox returns 404 in production (before touching the inbox) and the code in dev` — route handler test with stubbed `NODE_ENV` (the seam is unreachable in production by construction, not by convention).
- `fail-closed adapter (production) throws the typed OTP_DELIVERY_UNAVAILABLE and names the missing deployment prerequisite in the message`.
- `sendSecurityNotice never throws` (fail-open, logged via `captureEvent` without the notice body).

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/unit/otp.test.ts tests/unit/verification-delivery.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement**

- Code: 6 digits from `crypto.randomInt(0, 1_000_000)` zero-padded.
- `codeHash = HMAC-SHA256(code, hkdfKey("otp-hash"))` hex, where `hkdfKey(info) = crypto.hkdfSync("sha256", Buffer.from(process.env.AUTH_SECRET!), Buffer.from("speaker-platform-otp-v1"), Buffer.from(info), 32)` — one helper, reused by Task 5 (`"ip-hash"`) and Task 8 (`"recovery-code-hash"`). **Not** used for `AdminMfa` encryption — that key is the dedicated `ADMIN_MFA_ENCRYPTION_KEY` (Task 8), never derived from `AUTH_SECRET`.
- `requestOtp`: cooldown check (latest row for `(userId,purpose,target)` younger than 60s) → `checkRateLimit(\`otp:${userId}:${purpose}:${target}\`, OTP_PER_TARGET_RULE)` → create row → `adapter.sendOtp` → on throw: delete row, return `OTP_DELIVERY_UNAVAILABLE`.
- `verifyOtp`: `OtpCode.where({ userId, purpose, channel, target }).orderBy(createdAt desc).first()` → expired → `OTP_EXPIRED`; `attempts >= OTP_MAX_ATTEMPTS` → `OTP_MAX_ATTEMPTS`; hash mismatch → `attempts += 1` (update) → `OTP_NOT_FOUND`; match → **atomic consume**: `updateAll({ consumedAt: now }).where({ id, consumedAt: null })` — 0 rows → `OTP_NOT_FOUND` (closes concurrent double-verify).
- Adapter selection by `NODE_ENV` only — no env flag, no client-controllable input (same posture as `financial-features.ts`). The in-memory inbox is a module-level `Map` (same single-instance topology caveat as `src/lib/rate-limit.ts`, documented there); nothing in the module calls `console.*` with delivery content. `app/api/dev/otp-inbox/route.ts`: `GET ?target=&purpose=&channel=` → `if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 })` **before** any inbox access → otherwise `Response.json({ code: peekDevOtpInbox(...) })`. The route exists so a developer can retrieve codes with curl; tests prove it is dead in production.

- [ ] **Step 4: Run tests until green**

Run: `npm test -- tests/unit/otp.test.ts tests/unit/verification-delivery.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/otp.ts src/lib/verification-delivery.ts app/api/dev/otp-inbox/route.ts tests/unit/otp.test.ts tests/unit/verification-delivery.test.ts
git commit -m "feat(otp): hashed single-use OTP with delivery adapters"
```

## Task 4: Capability RBAC engine + re-gate every admin surface

**Files:**

- Create: `src/lib/rbac.ts`
- Modify: `src/lib/auth.ts` (delete `requireAdmin()` — every caller migrates in this task)
- Modify: `src/lib/actions/admin.ts` (migrate `requireAdmin` → `requireCapability`/`requireAdminUser`)
- Modify: `src/lib/actions/withdraw.ts`
- Modify: `app/admin/layout.tsx`
- Modify: `app/admin/page.tsx`, `app/admin/users/page.tsx`, `app/admin/catalog/page.tsx` (page-level capability guards)
- Test: `tests/unit/rbac.test.ts`

**Interfaces:**

- Consumes: `SessionUser`/`SessionInfo` (Task 2), `User.adminRole` (Task 1).
- Produces (used by Tasks 8, 9, 10, 11):

```ts
// src/lib/rbac.ts
export type AdminRole = "super_admin" | "operations_admin" | "moderator" | "support" | "analyst";

export type Capability =
  | "admin.access"                  // vào khu vực admin (layout)
  | "analytics.read"
  | "beta_cohort.manage"
  | "seller.verify"                  // review + approve/reject seller verification
  | "seller.verification.revoke"
  | "listing.moderate"
  | "report.resolve"                // Batch 3 dùng — định nghĩa sẵn trong matrix
  | "user.suspend"                  // Batch 3 dùng — định nghĩa sẵn trong matrix
  | "user.view_basic"               // trang danh sách người dùng (thông tin hỗ trợ cơ bản)
  | "pii.view_sensitive"            // step-up (guard thuộc Task 8)
  | "pii.export"                    // KHÔNG cấp cho ai trong Batch 2 (fail closed — xem Ambiguities)
  | "session.revoke"
  | "admin.role_manage"              // step-up (guard thuộc Task 8)
  | "security.config"                // step-up (guard thuộc Task 8) — chưa có surface dùng trong Batch 2
  | "audit.read";

export const ROLE_CAPABILITIES: Record<AdminRole, readonly Capability[]>;

export function capabilitiesOf(role: AdminRole | null | undefined): readonly Capability[];

export type AdminContext = { user: SessionUser; session: SessionInfo };
export async function requireAdminUser(): Promise<AdminContext>;     // bất kỳ adminRole nào — cổng vào /admin
export async function requireCapability(cap: Capability): Promise<AdminContext>;  // throw Error("FORBIDDEN")
// KHÔNG có guard step-up trong task này — requireCapabilityWithStepUp + STEP_UP_CAPABILITIES
// được Task 8 THÊM vào rbac.ts như một interface HOÀN CHỈNH (verifyAdminMfaCode thật, không placeholder),
// cùng commit với chính module MFA. Task 4 chỉ ship capability check thuần.
```

- [ ] **Step 1: Write the failing matrix test**

`tests/unit/rbac.test.ts` — the **authorization matrix gate** (spec §5.4.1, fail-closed on every `Scoped`/`Exceptional`/`Limited`/`Explicit permission` cell — see *Ambiguities* A2):

- `ROLE_CAPABILITIES` asserted cell-by-cell as data:

| Capability | super | ops | moderator | support | analyst |
|---|---|---|---|---|---|
| admin.access | ✓ | ✓ | ✓ | ✓ | ✓ |
| analytics.read | ✓ | ✓ | — | — | ✓ |
| beta_cohort.manage | ✓ | ✓ | — | — | — |
| seller.verify | ✓ | ✓ | — | — | — |
| seller.verification.revoke | ✓ | ✓ | — | — | — |
| listing.moderate | ✓ | ✓ | ✓ | — | — |
| report.resolve | ✓ | ✓ | ✓ | — | — |
| user.suspend | ✓ | ✓ | — | — | — |
| user.view_basic | ✓ | ✓ | — | — | — |
| pii.view_sensitive | ✓ | — | — | — | — |
| pii.export | — | — | — | — | — |
| session.revoke | ✓ | ✓ | — | — | — |
| admin.role_manage | ✓ | — | — | — | — |
| security.config | ✓ | — | — | — | — |
| audit.read | ✓ | — | — | — | — |

- `requireCapability denies non-admin, wrong-role, and null adminRole` (mocked `getSessionFromCookie`): buyer → FORBIDDEN; `support` calling `seller.verify` → FORBIDDEN (Review Focus 4); `analyst` calling `beta_cohort.manage` → FORBIDDEN.
- `requireCapability grants the right role and returns session context`.
- `legacy role="admin" with adminRole=null grants nothing` (spec §8.5: old boolean is not permanent authorization).

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/unit/rbac.test.ts` → FAIL — module missing.

- [ ] **Step 3: Implement `src/lib/rbac.ts` and re-gate surfaces**

- `requireCapability`: `getSessionFromCookie()` → null → FORBIDDEN; `capabilitiesOf(user.adminRole).includes(cap)` → false → FORBIDDEN; else return `{ user, session }`. Never reads `user.role`.
- Migrate the call sites and **delete `requireAdmin()` from `src/lib/auth.ts` in the same commit** (Task 2 left it working; this task removes it so no broad-role check survives): `app/admin/layout.tsx` → `requireAdminUser()` (redirect non-admins to `/`); `src/lib/actions/admin.ts` `approveListingAction`/`rejectListingAction` → `requireCapability("listing.moderate")`; `toggleSellerVerificationAction` → `requireCapability("seller.verify")` (transitional — Task 10 deletes it); `resolveDisputeAction`/`updateCommissionAction`/`updateSettingAction` → `requireAdminUser()` (finance boundary already denies them — keep the guard order: `assertFinancialFeaturesEnabled()` stays the first line, the shutdown tests assert the throw happens before auth); `src/lib/actions/withdraw.ts` `processWithdrawAction` → `requireAdminUser()` (same order).
- Add page-level guards to the admin pages that lack them: `app/admin/page.tsx` → `requireCapability("analytics.read")`; `app/admin/users/page.tsx` → `requireCapability("user.view_basic")`; `app/admin/catalog/page.tsx` → `requireCapability("listing.moderate")` (catalog model approval is listing-quality operations — recorded mapping decision); dormant finance pages (`orders`, `disputes`, `withdraws`, `settings`) → `requireAdminUser()` (read-only historical, Batch 1 posture). Guards throw/redirect server-side — nav filtering (Task 9) is convenience only.

- [ ] **Step 4: Run tests until green + regression**

Run: `npm test -- tests/unit/rbac.test.ts` → PASS.
Run: `npm test` → finance shutdown suites still green (guard order preserved: finance assert before auth).

- [ ] **Step 5: Commit**

```bash
git add src/lib/rbac.ts src/lib/auth.ts src/lib/actions/admin.ts src/lib/actions/withdraw.ts app/admin/layout.tsx app/admin/page.tsx app/admin/users/page.tsx app/admin/catalog/page.tsx tests/unit/rbac.test.ts
git commit -m "feat(rbac): capability-based admin authorization"
```

## Task 5: Audit event foundation

**Files:**

- Create: `src/lib/audit-event.ts`
- Test: `tests/unit/audit-event.test.ts`

**Interfaces:**

- Consumes: `AuditEvent` model (Task 1), `clientIpFromHeaders` from `src/lib/rate-limit.ts`.
- Produces (used by Tasks 6–11):

```ts
export type AuditEventInput = {
  actorId?: string | null;        // null = system/offline script
  subjectId?: string | null;
  action: string;                 // "user.email_verified" | "seller_verification.reviewed" | ...
  resourceType?: string;
  resourceId?: string;
  reason?: string;                // typed reason code
  policyVersion?: string;
  sessionId?: string;
  detail?: string;                 // KHÔNG chứa PII thô/OTP/secret
};

export async function auditEvent(input: AuditEventInput): Promise<void>;
export async function auditEventTx(tx: TxContext, input: AuditEventInput): Promise<void>;  // TxContext như src/lib/actions/helpers.ts
```

Action-name registry (dot-namespaced, used by all later tasks): `user.email_verified`, `user.phone_verified`, `user.password_changed`, `user.email_changed`, `user.phone_changed`, `user.recovery_requested`, `user.recovery_completed`, `session.revoked`, `session.revoked_all`, `admin.mfa_enrolled`, `admin.mfa_reset`, `admin.mfa_recovery_code_used`, `admin.step_up`, `admin.role_set`, `seller_profile.declared`, `seller_verification.submitted`, `seller_verification.reviewed`, `seller_verification.backfill`, `beta_cohort.membership_set`, `listing.approved`, `listing.rejected`, `listing.approve_blocked`.

- [ ] **Step 1: Write the failing unit test**

`tests/unit/audit-event.test.ts` (mock db):

- `auditEvent writes actor/subject/action/reason/policyVersion/sessionId and a hashed ip`: `ipHash` is HMAC-SHA256 hex (never the raw IP — spec §4.8), read from `headers()` when available.
- `auditEventTx writes inside the passed transaction`.
- `detail is stored verbatim but the helper documents the PII rule` — assert a redaction helper `redactDetail(value: string): string` exists and masks anything matching an email/phone/6-digit-OTP pattern (used by callers as a belt-and-braces; the convention is enforced by review + Task 12 scan).

- [ ] **Step 2: Run to verify failure** → `npm test -- tests/unit/audit-event.test.ts` → FAIL.

- [ ] **Step 3: Implement** — plain `AuditEvent.create` (+ tx variant); `ipHash` via the shared `hkdfKey("ip-hash")` helper from `src/lib/otp.ts` (Task 3 exports it); `redactDetail` masks email/phone/6-digit-OTP-shaped substrings before `detail` is stored.

- [ ] **Step 4: Run until green** → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/audit-event.ts src/lib/otp.ts tests/unit/audit-event.test.ts
git commit -m "feat(audit): typed audit event foundation"
```

## Task 6: Email/phone verification + identity changes

**Files:**

- Create: `src/lib/actions/verification.ts`
- Modify: `src/lib/actions/profile.ts` (phone change resets `phoneVerifiedAt`)
- Create: `src/components/verification-panel.tsx`
- Modify: `app/profile/page.tsx`
- Test: `tests/unit/verification-actions.test.ts`
- Test: `tests/integration/identity-collision.test.ts`

**Interfaces:**

- Consumes: `requestOtp`/`verifyOtp`/`normalizeEmail`/`normalizePhone` (Task 3), `revokeAllUserSessions` (Task 2), `auditEvent` (Task 5), `notify` (existing).
- Produces:

```ts
"use server";
export type VerificationFormState = { error?: string; success?: string };

export async function requestEmailVerificationAction(_prev: VerificationFormState, formData: FormData): Promise<VerificationFormState>;
export async function confirmEmailVerificationAction(_prev: VerificationFormState, formData: FormData): Promise<VerificationFormState>;
//   formData: code → verifyOtp(email_verification) → User.emailVerifiedAt = now → audit "user.email_verified"

export async function requestPhoneVerificationAction(_prev: VerificationFormState, formData: FormData): Promise<VerificationFormState>;
//   formData: phone (cho phép đặt/đổi số trước khi verify) → normalizePhone → requestOtp(phone_verification)
export async function confirmPhoneVerificationAction(_prev: VerificationFormState, formData: FormData): Promise<VerificationFormState>;
//   verifyOtp → tx { collision re-check; User.phone = target, phoneVerifiedAt = now } → audit "user.phone_verified"

export async function changePasswordAction(_prev: VerificationFormState, formData: FormData): Promise<VerificationFormState>;
//   formData: currentPassword, newPassword → verify current (step-up) → update hash → revokeAllUserSessions(except current, "password_change") → audit "user.password_changed" + notify

export async function requestEmailChangeAction(_prev: VerificationFormState, formData: FormData): Promise<VerificationFormState>;
//   formData: newEmail, currentPassword → step-up → newEmail không trùng User.email nào → requestOtp(email_verification, target=newEmail)
export async function confirmEmailChangeAction(_prev: VerificationFormState, formData: FormData): Promise<VerificationFormState>;
//   formData: newEmail (hidden), code → verifyOtp(target=newEmail) → tx { User.email = newEmail, emailVerifiedAt = now; revokeAllUserSessions(except current, "email_change") } → audit "user.email_changed" + security notice tới email CŨ + notify

export async function requestPhoneChangeAction(_prev: VerificationFormState, formData: FormData): Promise<VerificationFormState>;
export async function confirmPhoneChangeAction(_prev: VerificationFormState, formData: FormData): Promise<VerificationFormState>;
//   tương tự email: collision re-check trong tx, phoneVerifiedAt = now, revoke others, audit "user.phone_changed", notice tới phone cũ
```

- [ ] **Step 1: Write the failing unit tests**

`tests/unit/verification-actions.test.ts` (mock db with fixtures: two users, one with `phoneVerifiedAt` set):

- `confirmEmailVerificationAction sets emailVerifiedAt and audits` (assert `AuditEvent.create` called with `action: "user.email_verified"`, no raw email in `detail`).
- `confirmPhoneVerificationAction: target phone already verified by ANOTHER account → typed error PHONE_ALREADY_VERIFIED, no merge, no update` (**identity-collision rule**, spec §5.3.1 — no automatic merging).
- `confirmPhoneVerificationAction: same phone held unverified by another account → verification succeeds` (uniqueness applies to *verified* identities only).
- `changePasswordAction: wrong current password → error, no mutation`; `correct → hash updated, other sessions revoked with reason "password_change", current session kept` (Review Focus 3).
- `requestEmailChangeAction: new email already used by another account → typed error EMAIL_TAKEN (unique constraint respected, enumeration-safe message)`.
- `confirmEmailChangeAction: email swapped, emailVerifiedAt set, other sessions revoked, security notice sent to the OLD address` (adapter spy), audit `user.email_changed`.
- `requestPhoneChangeAction cooldown/rate-limit errors surface as form errors` (OTP_RATE_LIMITED → Vietnamese message).
- `every action requires a session` (no cookie → redirect/throw, no db touch).

`tests/integration/identity-collision.test.ts` (real DB — the **identity-collision gate**):

- `User.email unique constraint rejects a duplicate email insert` (raw `create` throws).
- `two accounts cannot both hold the same verified phone through the action path`: user A verifies phone P → user B's `confirmPhoneVerificationAction(P)` returns `PHONE_ALREADY_VERIFIED` and B's `phoneVerifiedAt` stays null.
- `email change to a taken address fails at the action boundary` (pre-check) `and at the DB boundary` (constraint) — both asserted.

- [ ] **Step 2: Run to verify failure** → `npm test -- tests/unit/verification-actions.test.ts` → FAIL.

- [ ] **Step 3: Implement actions + UI**

- All actions: `requireUser()` first; zod-validate formData; typed error strings (Vietnamese, user-facing) + stable codes in state for tests.
- Phone collision re-check inside `db.transaction`: `User.where({ phone: target }).where(id ≠ user.id).where(phoneVerifiedAt != null).first()` → exists → rollback + typed error. (Residual concurrent-verification race is accepted and documented in the batch verification doc: single app instance, ops duplicate-phone review query provided in the runbook.)
- `updateProfileAction` (existing file): when the submitted phone differs from the stored one → set `phoneVerifiedAt: null` (an edited phone is no longer verified).
- UI: `src/components/verification-panel.tsx` ("use client", `useActionState`) — three sections: (1) trạng thái xác minh email/phone + "Gửi mã"/"Nhập mã" forms; (2) đổi mật khẩu; (3) đổi email/đổi số điện thoại (two-step: request → confirm). Mount in `app/profile/page.tsx`. Copy follows §6.2-style neutrality; no guarantee language.

- [ ] **Step 4: Run until green + integration**

Run: `npm test -- tests/unit/verification-actions.test.ts` → PASS.
Run: `npm run test:integration` → `identity-collision.test.ts` PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/actions/verification.ts src/lib/actions/profile.ts src/components/verification-panel.tsx app/profile/page.tsx tests/unit/verification-actions.test.ts tests/integration/identity-collision.test.ts
git commit -m "feat(identity): email/phone verification and identity changes"
```

## Task 7: Account recovery (enumeration-safe)

**Files:**

- Create: `src/lib/actions/recovery.ts`
- Create: `app/(auth)/recover/page.tsx`
- Create: `src/components/recovery-form.tsx`
- Modify: `src/components/auth-form.tsx` (link `/recover`)
- Test: `tests/unit/recovery-actions.test.ts`

**Interfaces:**

- Consumes: `requestOtp`/`verifyOtp`/`normalizeEmail`/`normalizePhone` (Task 3), `revokeAllUserSessions` (Task 2), `auditEvent` (Task 5), `checkRateLimit`/`clientIpFromHeaders` (existing).
- Produces:

```ts
"use server";
export type RecoveryFormState = { error?: string; success?: string };

export async function requestPasswordRecoveryAction(_prev: RecoveryFormState, formData: FormData): Promise<RecoveryFormState>;
//   formData: identifier (email HOẶC phone — mất email thì nhập phone, mất phone thì nhập email)
//   → tra user theo email/số phone NHƯNG chỉ khớp kênh ĐÃ XÁC MINH (emailVerifiedAt/phoneVerifiedAt != null)
//     — recovery qua kênh chưa xác minh là vector chiếm tài khoản (SIM tái sử dụng, email cũ)
//   → LUÔN trả cùng thông báo trung tính kể cả khi không khớp (chống enumeration, spec §7.7)
//   → nếu có user: requestOtp(password_recovery, channel tương ứng) + audit "user.recovery_requested"
//   → IP rate limit riêng (5 / 10 phút / IP) + per-identifier limit của OTP

export async function confirmPasswordRecoveryAction(_prev: RecoveryFormState, formData: FormData): Promise<RecoveryFormState>;
//   formData: identifier, code, newPassword → tra user → verifyOtp(password_recovery)
//   → update passwordHash → revokeAllUserSessions(userId, "password_recovery") — TẤT CẢ, kể cả session hiện tại nếu có
//   → audit "user.recovery_completed" + notify in-app + security notice tới verified channel
```

- [ ] **Step 1: Write the failing unit tests** — the **recovery-abuse gate** (spec §7.2, §7.7):

- `requestPasswordRecoveryAction returns the identical neutral message for existing and unknown identifiers` (byte-equal `success` string; no timing-relevant db difference asserted at unit level).
- `unknown identifier performs no OTP delivery` (adapter spy not called) `but still consumes the IP rate-limit budget`.
- `confirmPasswordRecoveryAction with a valid code sets the new hash and revokes EVERY session` — assert `revokeAllUserSessions` called **without** `exceptSessionId` (Review Focus 3: stale-session reuse after recovery).
- `wrong/expired/reused code → typed error, password unchanged`.
- `recovery for an account with a VERIFIED phone sends channel=phone` (lost-email path) and vice versa.
- `identifier matching an UNVERIFIED channel → identical neutral message, no OTP sent` (recovery only via verified channels — abuse vector closed).
- `user with no verified channel at all → identical neutral message, no OTP sent` (out-of-band path is the runbook's manual fallback, Ambiguity A3).
- `IP rate limit: 6th request within 10 min → RATE_LIMITED form error`.
- `identifier that matches neither email nor phone format → validation error before any lookup`.

- [ ] **Step 2: Run to verify failure** → FAIL.

- [ ] **Step 3: Implement** — two-step form in `recovery-form.tsx` (request → enter code + new password); page at `/recover` (`PageProps<"/recover">`); login form gains `Quên mật khẩu?` link. Enumeration safety: single shared message constant `RECOVERY_SENT_MESSAGE`; unknown identifier → no-op besides rate limit.

- [ ] **Step 4: Run until green** → PASS; then `npm test` full unit suite green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/actions/recovery.ts app/(auth)/recover src/components/recovery-form.tsx src/components/auth-form.tsx tests/unit/recovery-actions.test.ts
git commit -m "feat(identity): enumeration-safe account recovery"
```

## Task 8: Admin MFA — TOTP + recovery codes + login + step-up

**Files:**

- Modify: `package.json` + `package-lock.json` (add `otpauth` exact `9.5.2`)
- Create: `src/lib/totp.ts` (thin wrapper over `otpauth` — pure module, no `"use server"`, no `"server-only"`)
- Create: `src/lib/admin-mfa-key.ts` (dedicated MFA encryption key — plain server-side module, `helpers.ts` precedent)
- Create: `src/lib/admin-mfa.ts` (plain server-side module — importable by the offline bootstrap script, Task 11)
- Modify: `src/lib/env.ts` (validate `ADMIN_MFA_ENCRYPTION_KEY`)
- Modify: `src/lib/actions/auth.ts` (login MFA challenge)
- Modify: `src/lib/rbac.ts` (add `requireCapabilityWithStepUp` + `STEP_UP_CAPABILITIES` — complete implementation)
- Modify: `.env.example`, `docker-compose.prod.yml`, `scripts/preflight.sh` (compose gate placeholder env)
- Modify: `src/components/auth-form.tsx` (MFA code field)
- Test: `tests/unit/totp.test.ts`
- Test: `tests/unit/admin-mfa.test.ts`
- Test: `tests/unit/admin-mfa-login.test.ts`
- Test: `tests/unit/env.test.ts` (new `ADMIN_MFA_ENCRYPTION_KEY` cases)
- Test: `tests/integration/admin-mfa-login.test.ts`

**Interfaces:**

- Consumes: `AdminMfa`/`AdminRecoveryCode` models (Task 1), `hkdfKey` (Task 3 — recovery-code hash only), `createSession` (Task 2), `auditEvent` (Task 5), `stepUpIsFresh`/`markSessionSteppedUp` (Task 2).
- Produces (used by Tasks 9, 10, 11):

```ts
// src/lib/totp.ts — wrapper mỏng quanh otpauth@9.5.2 (KHÔNG hand-roll crypto)
import { HOTP, TOTP, Secret } from "otpauth";

export function generateTotpSecret(): string;   // new Secret({ size: 20 }).base32
export function totpUri(secretBase32: string, account: string, issuer: string): string;
//   new TOTP({ issuer, label: account, algorithm: "SHA1", digits: 6, period: 30,
//              secret: Secret.fromBase32(secretBase32) }).uri()
export function verifyTotp(secretBase32: string, code: string, atMs?: number, window?: number): boolean;
//   TOTP.verify({ token: code, window: window ?? 1 }).match — atMs chỉ dùng trong test (mock Date.now)
export function hotpCode(secretBase32: string, counter: number): string;
//   HOTP.generate(counter) — tồn tại để test vector RFC 4226 qua thư viện

// src/lib/admin-mfa-key.ts — key mã hóa MFA DÀNH RIÊNG (không derive từ AUTH_SECRET)
export function getAdminMfaEncryptionKey(): Buffer;
//   Buffer.from(process.env.ADMIN_MFA_ENCRYPTION_KEY, "base64") — throw typed
//   ADMIN_MFA_KEY_UNCONFIGURED (thiếu) / ADMIN_MFA_KEY_INVALID (không phải base64 của đúng 32 byte).
//   Server-only: KHÔNG NEXT_PUBLIC_*, KHÔNG log giá trị.
export function adminMfaKeyId(key: Buffer): string;
//   sha256(key).slice(0, 8) hex — định danh KHÔNG bí mật, ghi vào envelope để phát hiện sai key khi rotate

// src/lib/admin-mfa.ts
export const RECOVERY_CODE_COUNT = 10;
export function generateRecoveryCodes(): string[];                    // "XXXX-XXXX", alphabet không có I/O/0/1
export function hashRecoveryCode(code: string): string;              // HMAC hkdfKey("recovery-code-hash") — node:crypto
export function encryptTotpSecret(secretBase32: string): string;
//   AES-256-GCM với key = getAdminMfaEncryptionKey(); envelope "v1:<keyId>:<base64(iv ‖ tag ‖ ct)>"
//   (iv 12 byte ngẫu nhiên, tag 16 byte) — version + keyId cho rotation an toàn tương lai
export function decryptTotpSecret(enc: string): string;
//   sai keyId so với key hiện tại → throw typed ADMIN_MFA_KEY_MISMATCH (không corrupt im lặng)
export async function enrollAdminMfa(userId: string): Promise<{ secretBase32: string; uri: string; recoveryCodes: string[] }>;
//   refuse nếu đã có AdminMfa (trả null — reset qua bootstrap script, Task 11)
export async function verifyAdminMfaCode(userId: string, code: string): Promise<"totp" | "recovery_code" | null>;
//   TOTP window ±1; recovery code: tìm hash khớp chưa dùng → đánh dấu usedAt (một lần) → "recovery_code"
```

```ts
// src/lib/actions/auth.ts — login state mở rộng
export type AuthFormState = { error?: string; mfaRequired?: boolean };
// loginAction: password đúng + user.adminRole != null:
//   - chưa có AdminMfa            → { error: MFA_ENROLLMENT_REQUIRED } (fail closed — bootstrap, Task 11)
//   - có AdminMfa + thiếu mfaCode  → { mfaRequired: true } — KHÔNG tạo session
//   - có AdminMfa + mfaCode sai   → { error: "Mã không đúng" } — KHÔNG tạo session, rate limit
//   - đúng (TOTP hoặc recovery)   → createSession(userId, { isAdmin: true }) + audit khi dùng recovery code
// user thường: createSession như hiện tại (isAdmin: false)
```

```ts
// src/lib/rbac.ts — Task 8 THÊM (interface HOÀN CHỈNH từ ngày đầu, không placeholder)
export const STEP_UP_CAPABILITIES: readonly Capability[];
//   ["pii.view_sensitive", "admin.role_manage", "security.config", "seller.verify", "seller.verification.revoke"]
export async function requireCapabilityWithStepUp(cap: Capability, totpCode?: string): Promise<AdminContext>;
//   1. requireCapability(cap) — sai role → FORBIDDEN
//   2. cap ∉ STEP_UP_CAPABILITIES → return (không cần step-up)
//   3. stepUpIsFresh(session.steppedUpAt) → return
//   4. totpCode → verifyAdminMfaCode(user.id, totpCode):
//        truthy → markSessionSteppedUp(session.id) + auditEvent("admin.step_up") → return
//        falsy  → throw Error("MFA_CODE_INVALID")
//   5. không totpCode → throw Error("STEP_UP_REQUIRED")
```

- [ ] **Step 1: Add the pinned dependency**

```bash
npm install --save-exact otpauth@9.5.2
```

- Verify `package.json` shows `"otpauth": "9.5.2"` (no `^` range) and `package-lock.json` records `@noble/hashes` `2.4.0` with integrity hashes. Run `npm audit` — must be clean (record in the Task 12 verification doc). Supply-chain note: `otpauth` publishes via GitHub-OIDC trusted publishing with SLSA provenance + npm registry signatures; its only transitive runtime dep is `@noble/hashes` (audited noble-crypto family), exact-pinned by its own manifest.

- [ ] **Step 2: Write the failing unit tests** — the **MFA gate**:

`tests/unit/totp.test.ts` (pure — proves the library is wired to RFC-conformant behavior):

- `hotpCode matches all ten RFC 4226 Appendix D vectors` for secret `GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ` (base32 of `12345678901234567890`): counters 0–9 → `755224, 287082, 359152, 969429, 338314, 254676, 287922, 162583, 399871, 520489`.
- `verifyTotp at a fixed timestamp accepts hotpCode at floor(ts/30000)` (mock `Date.now` with `vi.useFakeTimers`).
- `verifyTotp accepts the code from the previous/next 30s window (window=1) and rejects ±2 windows`.
- `generateTotpSecret produces base32 that Secret.fromBase32 accepts; totpUri starts with otpauth://totp/`.

`tests/unit/admin-mfa.test.ts` (mock db; stub `ADMIN_MFA_ENCRYPTION_KEY` with a fixed 32-byte base64 test key):

- `getAdminMfaEncryptionKey: valid key decodes to 32 bytes; unset env → ADMIN_MFA_KEY_UNCONFIGURED; non-base64 → ADMIN_MFA_KEY_INVALID; base64 of 31 bytes → ADMIN_MFA_KEY_INVALID` (strict length).
- `enrollAdminMfa stores the secret encrypted (ciphertext ≠ plaintext, decrypt round-trips) and 10 recovery-code hashes, never the codes`.
- `envelope format: "v1:<keyId>:<payload>" — keyId = first 8 hex of sha256(key); decrypt with a DIFFERENT key → typed ADMIN_MFA_KEY_MISMATCH (rotation detection), not silent garbage`.
- `verifyAdminMfaCode: valid TOTP → "totp"; valid recovery code → "recovery_code" and the row is marked used; the SAME recovery code a second time → null` (single-use).
- `wrong TOTP 5 times in a row does not lock the account but consumes the login rate limit` (rate limit lives in the action).

`tests/unit/env.test.ts` (extend the existing suite):

- `ADMIN_MFA_ENCRYPTION_KEY: valid base64-32 passes; not-base64 → issue; wrong byte length → issue; production + unset → issue (fail-fast); dev + unset → no issue`.

`tests/unit/admin-mfa-login.test.ts` (mock db + session):

- `admin without MFA cannot log in — MFA_ENROLLMENT_REQUIRED, no session created` (fail closed).
- `admin with MFA: password-only submit → mfaRequired, no session`; `+ correct TOTP → session created with isAdmin=true and 12h TTL`; `+ wrong TOTP → error, no session`.
- `recovery-code login creates the session and audits "admin.mfa_recovery_code_used"`.
- `non-admin login ignores the MFA field entirely`.
- `requireCapabilityWithStepUp (moved here from Task 4): fresh step-up passes; stale without code → STEP_UP_REQUIRED; stale + valid code → session marked stepped-up + passes; invalid code → MFA_CODE_INVALID; non-step-up capability never requires step-up` (**admin step-up gate**).

- [ ] **Step 3: Run to verify failure** → FAIL (modules missing, env cases missing).

- [ ] **Step 4: Implement**

- `src/lib/totp.ts`: thin wrapper over `otpauth` — `HOTP`/`TOTP`/`Secret` per the interface block; no hand-rolled HMAC, no base32 implementation.
- `src/lib/admin-mfa-key.ts`: `getAdminMfaEncryptionKey()` decodes and validates `ADMIN_MFA_ENCRYPTION_KEY` (base64 → exactly 32 bytes, typed errors, cached per process); `adminMfaKeyId(key)` = first 8 hex of `sha256(key)`. Plain module (no `"server-only"` import — the offline bootstrap script must import it; same posture as `src/lib/actions/helpers.ts`); never logs the key; never reads any `NEXT_PUBLIC_*` variable.
- `src/lib/admin-mfa.ts`: `encryptTotpSecret` → AES-256-GCM (12-byte random IV, 16-byte tag) with the dedicated key, envelope `v1:<keyId>:<base64(iv ‖ tag ‖ ct)>`; `decryptTotpSecret` → parse envelope, compare `keyId` against the current key's id → mismatch → typed `ADMIN_MFA_KEY_MISMATCH`; recovery codes from `crypto.randomBytes` mapped over the 31-char unambiguous alphabet, formatted `XXXX-XXXX`, hashed with `hkdfKey("recovery-code-hash")` (node:crypto HMAC — allowed to remain).
- `src/lib/env.ts`: add `ADMIN_MFA_ENCRYPTION_KEY` to the production-required set + the strict base64-32 validation (all environments, validated when set).
- `loginAction`: after password verify, branch on `user.adminRole`; `mfaCode` read from formData; rate limit via the existing `authRateLimited("auth:login")` plus a dedicated `auth:mfa` bucket for failed MFA attempts (10/10 min/IP).
- `src/lib/rbac.ts`: add `STEP_UP_CAPABILITIES` + `requireCapabilityWithStepUp` exactly per the interface block above — complete, fail-closed, no transitional markers.
- `.env.example` + `docker-compose.prod.yml`: add `ADMIN_MFA_ENCRYPTION_KEY` with `openssl rand -base64 32` instructions; compose uses required interpolation `${ADMIN_MFA_ENCRYPTION_KEY:?đặt ... trong .env}` (same pattern as `AUTH_SECRET`); `scripts/preflight.sh` compose-config gate passes a placeholder value for it.
- `src/components/auth-form.tsx`: render a `Mã TOTP / mã khôi phục` input **only when `state.mfaRequired` is true** (the field appears after the first submit returns `mfaRequired`; the resubmit includes `mfaCode` in formData).

- [ ] **Step 5: Run until green + integration**

Run: `npm test -- tests/unit/totp.test.ts tests/unit/admin-mfa.test.ts tests/unit/admin-mfa-login.test.ts tests/unit/env.test.ts` → PASS.
Run: `npm run test:integration` → `tests/integration/admin-mfa-login.test.ts`: full flow against real DB — enroll → login without code (no session) → login with TOTP (session row `isAdmin: true`, 12h) → recovery-code login marks the code used → second use fails.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/lib/totp.ts src/lib/admin-mfa-key.ts src/lib/admin-mfa.ts src/lib/env.ts src/lib/actions/auth.ts src/lib/rbac.ts src/components/auth-form.tsx .env.example docker-compose.prod.yml scripts/preflight.sh tests/unit/totp.test.ts tests/unit/admin-mfa.test.ts tests/unit/admin-mfa-login.test.ts tests/unit/env.test.ts tests/integration/admin-mfa-login.test.ts
git commit -m "feat(admin): TOTP MFA with recovery codes and step-up"
```

## Task 9: Admin session inventory, revocation surfaces, admin layout RBAC

**Files:**

- Create: `src/lib/actions/admin-identity.ts`
- Create: `app/admin/security/page.tsx`
- Modify: `app/admin/layout.tsx` (capability-filtered nav + `/admin/security` entry)
- Modify: `app/admin/users/page.tsx` (per-user session revoke forms)
- Modify: `app/profile/page.tsx` + `src/components/verification-panel.tsx` (user-facing "phiên đang đăng nhập" + revoke-all-others)
- Modify: `src/lib/actions/verification.ts` (add `revokeMyOtherSessionsAction`)
- Test: `tests/unit/admin-session-actions.test.ts`

**Interfaces:**

- Consumes: `listUserSessions`/`revokeSession`/`revokeAllUserSessions` (Task 2), `requireCapability`/`requireCapabilityWithStepUp` (Tasks 4/8), `auditEvent` (Task 5).
- Produces:

```ts
// src/lib/actions/admin-identity.ts
"use server";
export async function revokeUserSessionAction(formData: FormData): Promise<void>;
//   formData: sessionId (thuộc user đích) — requireCapability("session.revoke") + audit "session.revoked"
export async function revokeAllUserSessionsAction(formData: FormData): Promise<void>;
//   formData: userId — requireCapability("session.revoke") + audit "session.revoked_all"
export type AdminSecurityFormState = { error?: string; success?: string; recoveryCodes?: string[]; stepUpRequired?: boolean };
export async function stepUpAction(_prev: AdminSecurityFormState, formData: FormData): Promise<AdminSecurityFormState>;
//   requireAdminUser() + verifyAdminMfaCode(formData.mfaCode) → markSessionSteppedUp + audit "admin.step_up" → { success }
export async function regenerateRecoveryCodesAction(_prev: AdminSecurityFormState, formData: FormData): Promise<AdminSecurityFormState>;
//   TỰ-Phục vụ trên MFA của CHÍNH MÌNH — không cần capability quản trị ai khác:
//   requireAdminUser() + verifyAdminMfaCode(formData.mfaCode) (bắt buộc mã đúng — step-up thực)
//   → xoá 10 mã cũ, sinh 10 mã mới, trả state.recoveryCodes (hiển thị MỘT LẦN)
//   + audit "admin.mfa_recovery_codes_regenerated"
```

- [ ] **Step 1: Write the failing unit tests** — the **session-invalidation gate**:

- `revokeUserSessionAction: moderator/support (no session.revoke) → FORBIDDEN, no mutation` (Review Focus 4); `operations_admin → revokes + audits`.
- `revokeAllUserSessionsAction revokes every session of the target user and audits "session.revoked_all"`.
- `revoking another admin's session requires session.revoke and still works for super_admin` (admin session revocation, spec §5.4.2).
- `stepUpAction with a valid TOTP marks the session stepped-up; invalid → error; non-admin → FORBIDDEN`.
- `revokeMyOtherSessionsAction (user self-service): requireUser + revokes all other sessions with reason "user_self_revocation" + audit; current session survives`.
- `regenerateRecoveryCodesAction: valid MFA code → 10 new codes returned once, old codes dead; wrong code → error, no mutation; non-admin → FORBIDDEN`.
- `admin security page renders own sessions from listUserSessions and hides revoke buttons for roles without session.revoke` (source-contract assertion on the page module like `tests/unit/finance-public-surface.test.ts` does).

- [ ] **Step 2: Run to verify failure** → FAIL.

- [ ] **Step 3: Implement**

- `app/admin/security/page.tsx`: `requireAdminUser()`; own session inventory (device UA truncated, created/last-seen, expiry, step-up age) + revoke-one/revoke-all-others forms + step-up form + recovery-code regeneration. `export const dynamic = "force-dynamic"`.
- `app/admin/layout.tsx`: nav gains `Bảo mật & phiên` (`/admin/security`, all admins) — links filtered by `capabilitiesOf(user.adminRole)`; **pages still enforce their own capability** (UI filtering is convenience, spec §4.5). The `Xác minh người bán` and `Nhật ký audit` nav entries land in Task 10 together with the pages they point to (no dead links in between).
- User profile: session list + `Đăng xuất các thiết bị khác` calling a new `revokeMyOtherSessionsAction` in `src/lib/actions/verification.ts` (requireUser + revokeAllUserSessions(except current, "user_self_revocation") + audit).

- [ ] **Step 4: Run until green** → PASS; `npm test` full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/actions/admin-identity.ts app/admin/security app/admin/layout.tsx app/admin/users/page.tsx app/profile/page.tsx src/components/verification-panel.tsx src/lib/actions/verification.ts tests/unit/admin-session-actions.test.ts
git commit -m "feat(admin): session inventory and revocation surfaces"
```

## Task 10: SellerVerification workflow + Policy v1 + beta cohort + publication gate

**Files:**

- Create: `src/lib/seller-verification-policy.ts`
- Create: `src/lib/actions/seller-verification.ts`
- Create: `src/lib/actions/beta-cohort.ts`
- Create: `scripts/backfill-seller-verification.ts`
- Create: `app/sell/verification/page.tsx` + `src/components/seller-verification-form.tsx`
- Create: `app/admin/seller-verification/page.tsx`
- Create: `app/admin/audit/page.tsx`
- Modify: `app/admin/layout.tsx` (nav entries `Xác minh người bán` — `seller.verify`, `Nhật ký audit` — `audit.read`)
- Modify: `src/lib/actions/listings.ts` (gate on create/update/toggle)
- Modify: `src/lib/actions/admin.ts` (gate on approve; delete `toggleSellerVerificationAction`; wire `auditEvent` into approve/reject)
- Modify: `app/admin/users/page.tsx` (replace toggle with cohort grant + verification link)
- Test: `tests/unit/seller-verification-policy.test.ts`
- Test: `tests/unit/seller-verification-actions.test.ts`
- Test: `tests/unit/publication-gate.test.ts`
- Test: `tests/unit/beta-cohort.test.ts`
- Test: `tests/integration/seller-verification.test.ts`

**Interfaces:**

- Consumes: `requireUser` (Task 2), `requireCapability`/`requireCapabilityWithStepUp` (Tasks 4/8), `auditEvent` (Task 5), `PROVINCE_CODES` (new constant below).
- Produces:

```ts
// src/lib/seller-verification-policy.ts
export const SELLER_VERIFICATION_POLICY_VERSION = "v1";
export const SELLER_RULES_POLICY_KEY = "seller_rules";
export const SELLER_RULES_POLICY_VERSION = "v1";

export const SELLER_VERIFICATION_REASON_CODES = [
  "requirements_met", "duplicate_account_risk", "active_suspension",
  "prior_verification_revoked", "identity_information_inconsistent",
  "business_claim_needs_evidence", "abuse_case_unresolved",
  "manual_risk_review", "other_reviewed_reason", "migrated_legacy_verified",
] as const;
export type SellerVerificationReasonCode = (typeof SELLER_VERIFICATION_REASON_CODES)[number];

export const SELLER_VERIFICATION_DECISIONS = ["verified", "needs_review", "rejected", "revoked"] as const;
export type SellerVerificationDecision = (typeof SELLER_VERIFICATION_DECISIONS)[number];

export const PROVINCE_CODES: Record<string, string>;   // mã hành chính VN → tên, vd "01": "Hà Nội", "79": "TP.HCM" — danh sách đầy đủ 63 tỉnh/thành

export type SellerPublicationRequirement =
  | "email_verified" | "phone_verified" | "seller_type_declared"
  | "operating_location_declared" | "seller_rules_accepted"
  | "founding_seller_membership_active" | "operations_review_verified";
export type SellerPublicationCheck = { ok: boolean; missing: SellerPublicationRequirement[] };

export async function checkSellerPublicationRequirements(sellerId: string): Promise<SellerPublicationCheck>;
//   đọc FRESH từ DB (không tin session cache): User.emailVerifiedAt/phoneVerifiedAt/sellerType/
//   sellerOperatingProvinceCode + PolicyAcceptance(seller_rules, v1) +
//   BetaCohortMembership(founding_seller, active) + SellerVerification(status=verified)
export async function assertSellerPublicationAllowed(sellerId: string): Promise<void>;
//   throw Error("SELLER_PUBLICATION_BLOCKED:" + missing.join(","))
```

```ts
// src/lib/actions/seller-verification.ts
"use server";
export type SellerVerificationFormState = { error?: string; success?: string };

export async function declareSellerProfileAction(_prev: SellerVerificationFormState, formData: FormData): Promise<SellerVerificationFormState>;
//   formData: sellerType (individual|business), operatingProvinceCode — requireUser, validate theo PROVINCE_CODES,
//   update User.sellerType/sellerOperatingProvinceCode + audit "seller_profile.declared"

export async function submitSellerVerificationAction(_prev: SellerVerificationFormState, formData: FormData): Promise<SellerVerificationFormState>;
//   formData: acceptSellerRules ("on") — requireUser; check mọi requirement TRỪ operations_review_verified;
//   thiếu → error liệt kê; đủ → tạo/cập nhật SellerVerification (status=pending, submittedAt, policyVersion=v1)
//   + PolicyAcceptance(seller_rules, v1) trong cùng tx + audit "seller_verification.submitted"

export async function reviewSellerVerificationAction(formData: FormData): Promise<void>;
//   formData: userId, decision, reasonCode, note?, totpCode?
//   decision=verified|needs_review|rejected → requireCapabilityWithStepUp("seller.verify", totpCode)
//   decision=revoked                → requireCapabilityWithStepUp("seller.verification.revoke", totpCode)
//   ATOMIC CLAIM: updateAll({ status: decision, reviewedAt, reviewerId, reasonCode, note, policyVersion })
//                 .where({ userId, status: expectedCurrent })   // pending → decision; verified → revoked
//   0 row → Error("VERIFICATION_ALREADY_REVIEWED")  (Review Focus 5 — concurrent update)
//   + audit "seller_verification.reviewed" (reasonCode + policyVersion) + notify seller
```

```ts
// src/lib/actions/beta-cohort.ts
"use server";
export async function setBetaMembershipAction(formData: FormData): Promise<void>;
//   formData: userId, cohort, status (active|suspended|exited|invited), notes?
//   requireCapability("beta_cohort.manage") — upsert theo @@unique(userId, cohort)
//   + audit "beta_cohort.membership_set" (cohort + status trong detail, KHÔNG PII)
```

- [ ] **Step 1: Write the failing unit tests** — the **seller publication-gate gate**:

`tests/unit/seller-verification-policy.test.ts` (mock db fixtures):

- `check returns ok only when all seven requirements hold` — table-driven: remove one fixture field at a time → exactly that requirement in `missing`.
- `suspended founding_seller membership → missing founding_seller_membership_active` (**beta-cohort bypass**, spec §7.3).
- `revoked SellerVerification → missing operations_review_verified` (**revoked-seller bypass**).
- `assertSellerPublicationAllowed throws SELLER_PUBLICATION_BLOCKED with the missing list`.

`tests/unit/publication-gate.test.ts` (mock db; the four transition surfaces):

- `createListingAction: unverified seller → typed error, no Listing.create` (spec §4.4 — no transition into review/public).
- `updateListingAction: content-change → pending transition blocked for a revoked seller`.
- `toggleListingVisibilityAction: hidden → approved blocked for a suspended-membership seller` (silent return, status unchanged).
- `approveListingAction (admin): approving a listing whose seller lost verification → no approval + audit "listing.approve_blocked"` (**defense-in-depth**, Review Focus 2).
- `all four pass when the seller satisfies the policy`.

`tests/unit/seller-verification-actions.test.ts`:

- `submitSellerVerificationAction: missing prerequisites → error enumerating them; no row created`.
- `submit with all prerequisites → row status=pending + PolicyAcceptance(seller_rules, v1) + audit`.
- `reviewSellerVerificationAction: operations_admin + step-up code → status=verified + audit with reasonCode + notify`.
- `moderator → FORBIDDEN` (no `seller.verify`) (Review Focus 4); `support → FORBIDDEN`.
- `decision=revoked requires seller.verification.revoke` — operations_admin has it, moderator does not.
- `second concurrent decision → VERIFICATION_ALREADY_REVIEWED` (atomic claim, Review Focus 5).
- `stale step-up without totpCode → STEP_UP_REQUIRED, no mutation` (**admin step-up gate**).

`tests/unit/beta-cohort.test.ts`:

- `setBetaMembershipAction: analyst/moderator/support → FORBIDDEN`; `operations_admin → upsert + audit`; `status transitions recorded`.

- [ ] **Step 2: Run to verify failure** → FAIL.

- [ ] **Step 3: Implement**

- `PROVINCE_CODES`: full 63-province Vietnamese administrative code map (standard TCVN codes, e.g. `"01": "Hà Nội"`, `"79": "TP. Hồ Chí Minh"`) as a server-owned constant — canonical identifiers, not free text (spec §5.9).
- Gate integration in `src/lib/actions/listings.ts`: `createListingAction` → `await assertSellerPublicationAllowed(user.id)` before `Listing.create`, catch → `{ error: "..." }` listing the missing requirements in Vietnamese; `updateListingAction` → same before the status transition; `toggleListingVisibilityAction` → same before `hidden → approved` (silent return on block). `deleteListingAction` untouched.
- `src/lib/actions/admin.ts`: `approveListingAction` → after `requireCapability("listing.moderate")`, run `checkSellerPublicationRequirements(listing.sellerId)` → blocked → audit `listing.approve_blocked` + return (no approval); approve/reject also write `auditEvent("listing.approved"|"listing.rejected")` in addition to the legacy `audit()` line (foundation wiring); **delete `toggleSellerVerificationAction`** and its import/use in `app/admin/users/page.tsx` (replaced by the workflow — spec §8.2: SellerVerification becomes canonical).
- `app/admin/users/page.tsx`: replace the toggle column with `founding_seller` membership grant/suspend forms (`setBetaMembershipAction`) + a link to `/admin/seller-verification?q=<userId>`; keep `isVerifiedSeller` display column (legacy, read-only) with a `legacy` badge.
- `app/sell/verification/page.tsx` + form: declaration (seller type + province select from `PROVINCE_CODES`), rules acceptance checkbox with §6.2-compliant summary copy (`Đã xác minh thông tin người bán theo yêu cầu hiện tại của LoaViet.` — never guarantee language), submit; status view (`not_started/pending/verified/rejected/needs_review/revoked` + reason code label).
- `app/admin/seller-verification/page.tsx`: `requireCapability("seller.verify")`; queue of pending rows + per-user decision forms (decision select, reason-code select from `SELLER_VERIFICATION_REASON_CODES`, note, TOTP field for step-up); history via `AuditEvent` where `action = "seller_verification.reviewed"`. Each review row surfaces the reviewer context the §5.3.3 operations checklist needs: account age, declared seller type + operating province, verified email/phone state, listing count, prior verification decisions (from `AuditEvent`), and current `founding_seller` membership status — the human reviewer checks duplicate indicators/suspension/revocation history against these signals and records the outcome as a typed reason code. No identity-document collection anywhere (spec §5.3.2).
- `app/admin/audit/page.tsx`: `requireCapability("audit.read")`; paginated `AuditEvent` list (action, actor, subject, resource, reason, policy version, timestamp) — no raw PII rendering beyond what `detail` already (non-)contains.

- [ ] **Step 4: Backfill script + integration test**

`scripts/backfill-seller-verification.ts` (offline maintenance command, spec §8.6 + §5.1.1 posture — never exposed via HTTP/admin UI):

- Default **dry-run**: prints the count and ids of users with `isVerifiedSeller = true` and no `SellerVerification` row.
- `--apply`: creates rows `{ status: "verified", method: "operations_review", reviewedAt: now, reviewerId: null, reasonCode: "migrated_legacy_verified", note: "migrated from legacy isVerifiedSeller (batch 2)", policyVersion: "v1" }`; idempotent (skips users with an existing row); writes `auditEvent("seller_verification.backfill")` with actor null; refuses to run without `DATABASE_URL`.
- Documented rollback: `DELETE FROM "SellerVerification" WHERE "reasonCode" = 'migrated_legacy_verified'`.

`tests/integration/seller-verification.test.ts` (real DB):

- `backfill dry-run reports, --apply creates rows idempotently` (run the script's exported `backfill(isApply: boolean)` function directly).
- `full happy path`: seed user → verify email/phone (set timestamps) → declare → grant `founding_seller` active → submit → review (verified) → `checkSellerPublicationRequirements` → `{ ok: true, missing: [] }`.
- `revoke → gate blocks → re-verify → gate passes`.

- [ ] **Step 5: Run until green**

Run: `npm test -- tests/unit/seller-verification-policy.test.ts tests/unit/seller-verification-actions.test.ts tests/unit/publication-gate.test.ts tests/unit/beta-cohort.test.ts` → PASS.
Run: `npm run test:integration` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/seller-verification-policy.ts src/lib/actions/seller-verification.ts src/lib/actions/beta-cohort.ts scripts/backfill-seller-verification.ts app/sell/verification app/admin/seller-verification app/admin/audit app/admin/layout.tsx app/admin/users/page.tsx src/lib/actions/listings.ts src/lib/actions/admin.ts tests
git commit -m "feat(seller): verification workflow, policy v1, publication gate"
```

## Task 11: Admin role management + bootstrap + recovery runbook (exercised)

**Files:**

- Create: `scripts/admin-bootstrap.ts`
- Create: `docs/operations/admin-bootstrap-recovery-runbook.md`
- Modify: `src/lib/actions/admin-identity.ts` (add `setAdminRoleAction`)
- Modify: `app/admin/security/page.tsx` (role management section)
- Test: `tests/unit/admin-role-actions.test.ts`
- Test: `tests/integration/admin-bootstrap.test.ts`

**Interfaces:**

- Consumes: `requireCapabilityWithStepUp` (Tasks 4/8), `enrollAdminMfa`/`verifyAdminMfaCode` (Task 8), `revokeAllUserSessions` (Task 2), `auditEvent` (Task 5).
- Produces:

```ts
// src/lib/actions/admin-identity.ts (thêm)
export async function setAdminRoleAction(formData: FormData): Promise<void>;
//   formData: userId, role (AdminRole), totpCode?
//   requireCapabilityWithStepUp("admin.role_manage", totpCode) — CHỈ super_admin
//   + không được tự hạ role của chính mình nếu là super_admin cuối cùng (guard: count super_admin > 1)
//   + revokeAllUserSessions(target, "admin_role_changed") + audit "admin.role_set"
```

```ts
// scripts/admin-bootstrap.ts — offline maintenance command (spec §5.1.1 posture: không expose HTTP/admin UI)
// Usage (tsx):
//   tsx scripts/admin-bootstrap.ts promote --email <e> --role <super_admin|operations_admin|moderator|support|analyst> [--apply]
//   tsx scripts/admin-bootstrap.ts mfa-enroll --email <e> [--apply]     → in secret base32 + otpauth:// URI + 10 mã khôi phục (MỘT LẦN)
//   tsx scripts/admin-bootstrap.ts mfa-reset --email <e> [--apply]     → xoá AdminMfa + thu hồi mọi session + audit
// Dry-run mặc định (không --apply → chỉ in kế hoạch); mọi lệnh ghi AuditEvent actor=null ("admin.bootstrap.*").
export async function promoteUser(email: string, role: AdminRole, isApply: boolean): Promise<void>;
export async function enrollMfa(email: string, isApply: boolean): Promise<{ secretBase32: string; uri: string; recoveryCodes: string[] } | null>;
export async function resetMfa(email: string, isApply: boolean): Promise<void>;
```

- [ ] **Step 1: Write the failing unit test**

`tests/unit/admin-role-actions.test.ts`:

- `setAdminRoleAction: operations_admin → FORBIDDEN` (only super_admin has `admin.role_manage`); `support → FORBIDDEN` (Review Focus 4).
- `super_admin without fresh step-up and without totpCode → STEP_UP_REQUIRED, no mutation` (**admin step-up gate**).
- `super_admin + step-up → role set + target's sessions revoked + audit "admin.role_set"`.
- `last-super-admin guard: demoting the only super_admin → typed error LAST_SUPER_ADMIN`.

- [ ] **Step 2: Run to verify failure** → FAIL.

- [ ] **Step 3: Implement actions + script + runbook**

- `setAdminRoleAction` per the interface; last-super-admin guard counts `User.where({ adminRole: "super_admin" })` excluding the target.
- `scripts/admin-bootstrap.ts`: exports the three functions (used by the integration test) + a `main()` CLI that parses argv, refuses without `DATABASE_URL`, defaults to dry-run, requires `--apply` for mutation, prints secrets exactly once to the terminal (never logs them via `captureEvent`).
- `docs/operations/admin-bootstrap-recovery-runbook.md` — the **exercised runbook** (spec §5.4.2: avoid permanent administrator lockout). Sections:
  1. *First admin bootstrap* (fresh deploy): `promote --email <founder> --role super_admin --apply` → `mfa-enroll --apply` → scan URI into an authenticator → store recovery codes in the password manager → log in with TOTP.
  2. *MFA lockout recovery*: use a recovery code at login (single-use, audited) → `/admin/security` → regenerate codes with step-up; **or** if all codes are lost: `mfa-reset --apply` (revokes all sessions) → `mfa-enroll --apply` → new codes.
  3. *Lost bootstrap access entirely*: run `mfa-reset` from the VPS with DB access (documented as the manual fallback of last resort — offline, audited, two-person rule note).
  4. *Role recovery*: `promote` a second super_admin before demoting anyone; the last-super-admin guard.
  5. *MFA encryption key rotation* (`ADMIN_MFA_ENCRYPTION_KEY`): generate a new key (`openssl rand -base64 32`) → update `.env`/compose → restart. Existing `AdminMfa` rows were encrypted under the old key; their envelope `keyId` no longer matches the current key, so decryption raises typed `ADMIN_MFA_KEY_MISMATCH` (detectable, never silent corruption) → run `mfa-reset --apply` + `mfa-enroll --apply` per admin (re-enrollment; the TOTP secret is the only encrypted payload). The `v1:` envelope prefix exists so a future format/key change can be versioned without ambiguity; a future offline re-encrypt command can shorten this procedure, but re-enrollment is the safe P0 path.
  6. *Exercise checklist*: the exact integration-test sequence (below) run against a scratch DB, plus the manual command walk-through with expected outputs.
  7. *Audit trail*: every command's `AuditEvent` action names to grep afterwards.

- [ ] **Step 4: Write the integration exercise** — the **exercised bootstrap/recovery runbook gate**:

`tests/integration/admin-bootstrap.test.ts` (real DB; imports the script's exported functions):

- `promote dry-run reports, --apply sets adminRole and role=admin, idempotent` (also asserts the Task 1 migration's backfill predicate: a pre-existing `role="admin"` row created before the promote gets `adminRole` from the transform path — create the user with `role: "admin"` and `adminRole: null`, run the transform's exact UPDATE, assert `super_admin`).
- `mfa-enroll --apply returns secret + 10 recovery codes; second enroll without reset → null (refuse)`.
- `login path: enrolled admin passes TOTP (Task 8 helpers) and fails without MFA`.
- `mfa-reset --apply deletes AdminMfa, revokes all sessions, audits; re-enroll works afterwards` (lockout → recovery loop closed).
- `recovery-code single-use through the real login path`.

- [ ] **Step 5: Run until green**

Run: `npm test -- tests/unit/admin-role-actions.test.ts` → PASS.
Run: `npm run test:integration` → `admin-bootstrap.test.ts` PASS (this is the runbook exercise).

- [ ] **Step 6: Commit**

```bash
git add scripts/admin-bootstrap.ts docs/operations/admin-bootstrap-recovery-runbook.md src/lib/actions/admin-identity.ts app/admin/security/page.tsx tests/unit/admin-role-actions.test.ts tests/integration/admin-bootstrap.test.ts
git commit -m "feat(admin): role management, bootstrap, recovery runbook"
```

## Task 12: Batch 2 gate verification + verification doc

**Files:**

- Create: `docs/operations/private-beta-batch2-identity-security-verification.md`

- [ ] **Step 1: Run every gate suite and record results**

```bash
npm test -- tests/unit/rbac.test.ts                                            # authorization matrix
npm test -- tests/unit/otp.test.ts tests/unit/verification-delivery.test.ts   # OTP abuse
npm test -- tests/unit/verification-actions.test.ts                           # identity collision (unit)
npm test -- tests/unit/recovery-actions.test.ts                               # recovery abuse
npm test -- tests/unit/session.test.ts                                        # session invalidation (unit)
npm test -- tests/unit/seller-verification-policy.test.ts tests/unit/publication-gate.test.ts  # seller publication gate
npm test -- tests/unit/totp.test.ts tests/unit/admin-mfa.test.ts tests/unit/admin-mfa-login.test.ts tests/unit/env.test.ts  # MFA + MFA key validation
npm test -- tests/unit/admin-session-actions.test.ts tests/unit/admin-role-actions.test.ts tests/unit/seller-verification-actions.test.ts  # admin step-up
npm run test:integration                                                       # backend enforcement: identity-collision, session-lifecycle,
                                                                               # admin-mfa-login, seller-verification, admin-bootstrap (runbook exercise)
```

- [ ] **Step 2: Backend-enforcement source scan** (spec §4.5 — "no privileged action relies only on UI visibility")

```bash
rg -n "requireAdmin\b" src app            # expect: 0 hits (replaced by requireCapability*/requireAdminUser)
rg -n "isVerifiedSeller" src app          # expect: display-only reads (SessionUser mapping, admin users page badge) — no authorization use
rg -n "role === \"admin\"|role !== \"admin\"" src app   # expect: 0 authorization hits (display-only allowed)
rg -n "toggleSellerVerification" src app  # expect: 0 hits (workflow is canonical)
rg -n "FINANCIAL_FEATURES_ENABLED" .env.example docker-compose.prod.yml scripts  # expect: still "false" everywhere
```

Manually classify every hit; fix any that is an authorization read.

- [ ] **Step 3: Full preflight + build + smoke**

```bash
npm run lint
npx tsc --noEmit
npm test
npm run test:integration
npm run build
npm run preflight        # contract-emit drift + lint + typecheck + unit + build + compose + migration graph
npm run smoke            # local safe smoke
npm audit --omit=dev     # dependency posture của otpauth/@noble/hashes — phải sạch (Global Constraints)
```

- [ ] **Step 4: Diff/status audit**

- `git diff --check`; `git status --short` contains only Batch 2 files; no `.claude/settings.json`, no uploads, no secrets, no scratch.
- `npx prisma migration list` shows baseline → batch2 linear graph; `npx prisma db verify` clean.
- Inspect the migration once more: zero destructive ops; the adminRole data transform present.

- [ ] **Step 5: Write the verification doc**

`docs/operations/private-beta-batch2-identity-security-verification.md` records: base and final commit hashes; OpenCode model/session metadata; per-gate test results (the ten Batch 2 gates); the source-scan classification table; migration review notes (additive-only confirmation); the backfill dry-run/apply output and rollback procedure; the `npm audit` result for the new dependency; residual risks (session cutover logs everyone out; concurrent phone-verification race accepted; Scoped/Exceptional matrix cells pending founder policy); deferred items (Batch 3/4/7/8 pointers); the runbook exercise result; and the explicit note that browser E2E is deferred — the repo has no E2E infrastructure, and Batch 2's critical flows are covered by action-level unit tests plus real-DB integration tests (spec §10's E2E line is honored when the repo gains an E2E runner, tracked for Batch 4/6 critical flows). It also states the **gate-scope distinction explicitly**: the Batch 2 gate proves the *implementation* (adapter seam + fail-closed delivery + all tests above) in every environment; **beta-launch readiness additionally requires** a configured production OTP provider (Ambiguity A1) — until then production OTP delivery (email/phone verification, self-service recovery) is unavailable *by design*, which is a launch prerequisite, not a Batch 2 test failure.

- [ ] **Step 6: Commit**

```bash
git add docs/operations/private-beta-batch2-identity-security-verification.md
git commit -m "test(batch2): verify identity & security gate"
```

## Acceptance Gate

Batch 2 is accepted only if all of the following are true (spec §9 Batch 2 Gate):

- **Authorization matrix tests pass** — every capability × role cell asserted; no role gains a `Scoped`/`Exceptional` cell without founder policy; legacy `role="admin"` without `adminRole` grants nothing.
- **OTP abuse tests pass** — brute force (attempt limit), resend flooding (cooldown + per-target limit), single-use, expiry, target binding, enumeration-safe responses, and no plaintext code in any log/analytics path **in any environment** (the in-memory dev/test adapter stores but never logs; the retrieval seam is unreachable in production).
- **Identity-collision tests pass** — verified email/phone unique among active accounts; collision produces a typed error, never a merge; email change respects the unique constraint at both action and DB boundaries.
- **Recovery abuse tests pass** — enumeration-neutral responses, IP + identifier rate limits, all-session invalidation on completion, security notices to previous channels.
- **Session invalidation tests pass** — revoked/expired sessions fail lookup; sensitive changes (password/email/phone) revoke other sessions; recovery revokes all.
- **Seller publication-gate tests pass** — all four listing-status transitions (create, update→pending, hidden→approved, admin approve) enforce the seven requirements fresh from the DB; revoked/suspended sellers cannot publish through any path including admin approval.
- **MFA tests pass** — RFC 4226/6238 vectors through the pinned `otpauth` library; admin login impossible without MFA; recovery codes single-use; TOTP secret encrypted at rest under the dedicated `ADMIN_MFA_ENCRYPTION_KEY` (envelope `v1:<keyId>:…`, never derived from `AUTH_SECRET`, wrong-key decryption is a typed error); SMS never an admin factor.
- **Admin step-up tests pass** — role management and seller-verification decisions require fresh step-up (or a valid TOTP/recovery code supplied in the same request); recovery-code regeneration requires a valid MFA code on the admin's own enrollment; stale step-up without a code fails closed with `STEP_UP_REQUIRED`.
- **Backend enforcement** — source scan shows zero authorization reads of `role`/`isVerifiedSeller`; every admin page/action guarded server-side.
- **Admin bootstrap/recovery runbook exercised** — the integration test walks promote → enroll → login → lockout → reset → re-enroll against a real DB, and the runbook documents the exact commands.
- **Batch 1 preserved** — all finance shutdown suites, `FINANCIAL_FEATURES_ENABLED=false`, and the finance integration invariants stay green; the migration is additive-only.
- **Gate scope is explicit** — everything above is the *implementation* gate and passes in every environment (dev, test, production build) **without** a production OTP provider: the adapter seam, the in-memory dev/test inbox, and the fail-closed production delivery are all tested behavior. **Beta launch additionally requires** a configured production email/SMS provider behind `OtpDeliveryAdapter` (Ambiguity A1) — until the founder selects one, production OTP delivery (email/phone verification, self-service recovery) is unavailable by design. That is a launch prerequisite, not a Batch 2 gate failure, and the verification doc must say so verbatim.
- Preflight (lint, typecheck, unit, build, compose, migration graph), integration suite, safe smoke, and `npm audit` all pass; diff/status audit clean.

## Threat-Case Coverage Map (spec §10.1 rows applicable to Batch 2)

| Abuse case | Covered by |
|---|---|
| Privilege escalation / Support → admin escalation | Task 4 matrix + Task 9/10/11 per-action role tests |
| OTP brute force / resend flooding | Task 3 `otp.test.ts` |
| Account enumeration | Task 7 neutral-message tests + Task 6 email-change message |
| Session fixation | Task 2 fresh-token-per-login test |
| Session reuse after recovery | Task 7 revoke-all + Task 2 revoked-lookup tests |
| Revoked-seller publication bypass | Task 10 `publication-gate.test.ts` (4 surfaces) |
| Suspended-user / beta-cohort bypass | Task 10 policy tests (membership status in gate) |
| Concurrent seller-verification update | Task 10 atomic-claim test |
| CSRF on state-changing actions | Next.js 16 server actions are POST-only with built-in origin protection; noted in Task 12 verification doc (no custom token layer added — matches repo posture) |
| Historical finance escape-hatch abuse | Batch 1 suites re-run in Task 12; no Batch 2 surface touches finance |

## Ambiguities and Deployment Prerequisites

Recorded per spec §4.11/§11.1 — none of these is silently resolved by implementation; each is handled fail-closed and needs a founder decision as noted:

1. **A1 — Production OTP delivery provider is unspecified** (spec §5.3 only says "adapters" + "production refuses when config invalid"). Batch 2 ships the adapter seam, the in-memory dev/test adapter (never logs; dev-only retrieval seam), and a **fail-closed production adapter**. The Batch 2 *implementation gate* — adapter seam + fail-closed tests — passes in every environment without a provider. What A1 blocks is **beta launch**, not implementation: production OTP delivery (and therefore production email/phone verification and self-service recovery) stays unavailable by design until the founder picks and configures a real email/SMS provider behind `OtpDeliveryAdapter`. Recorded in the runbook as a beta-launch prerequisite.
2. **A2 — RBAC matrix `Scoped` / `Exceptional + audited` / `Limited` / `Explicit permission` cells are undefined** (spec §5.4.1: moderator/support `user.suspend` "Scoped", moderator/support `pii.view_sensitive` "Exceptional + audited", moderator analytics "Limited", super_admin `pii.export` "Explicit permission + step-up", etc.). Batch 2 implements only the unambiguous ✓ cells and **fails closed** on the rest (`pii.export` granted to no one; support/moderator get only `admin.access`). *Blocks granting those capabilities until the founder defines the scope/exception/explicit-permission semantics — required before Batch 3 (moderation) ships those surfaces.*
3. **A3 — Admin-assisted (out-of-band) account recovery identity proofing is unspecified.** Batch 2 ships self-service recovery only; a user who lost every verified channel cannot self-recover. *Blocks the "high-risk recovery actions" step-up surface until the founder specifies proofing requirements; the runbook documents the manual, audited, last-resort DB fallback.*
4. **A4 — Seller Rules legal text is not yet written/reviewed** (Batch 8 deliverable). Batch 2 ships the acceptance-*recording* mechanism against version `v1` with neutral summary copy. *Blocks beta invites until the founder reviews the actual text and decides whether `v1` stands or bumps (a bump forces re-acceptance through the existing mechanism).*
5. **A5 — "Seller verification decisions where configured" (spec §5.4.2)** — Batch 2 takes the strictest reading: **every** manual verification decision requires step-up (`seller.verify` and `seller.verification.revoke` are in `STEP_UP_CAPABILITIES`). Recorded as a decision, reversible by removing them from the constant after founder review.

## Rollback and Data Backfill

- **Migration** (`batch2_identity_security`): additive-only (verified via `npx prisma migration show` — zero destructive ops). Rollback = `git revert` of the Task 1 commit **plus** restore from the pre-migration backup per `docs/backup-restore.md`; no down-migration is authored (the Prisma 8 graph is forward-only). Production applies via the compose `migrate` service `--to production` after the ref advance in Task 1.
- **adminRole backfill** (in-migration data transform): idempotent (`WHERE role='admin' AND adminRole IS NULL`); re-running the migration is a no-op. Rollback = restore from backup (or manual `UPDATE "User" SET "adminRole" = NULL` — documented, removes all admin access, fail-closed direction).
- **SellerVerification backfill** (`scripts/backfill-seller-verification.ts`): dry-run default, `--apply` gated, idempotent (skips existing rows), expected count = `count(isVerifiedSeller = true)` printed by dry-run. Rollback = `DELETE FROM "SellerVerification" WHERE "reasonCode" = 'migrated_legacy_verified'`. Post-migration verification = the Task 10 integration test + `npx prisma db verify`.
- **Session cutover**: no data backfill — existing JWT cookies become invalid on deploy (all users logged out once). Accepted for pre-launch; recorded in the verification doc.
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
npm audit --omit=dev               # otpauth/@noble/hashes sạch
npx prisma migration list          # graph: baseline → batch2_identity_security
npx prisma db verify               # marker + schema khớp contract
git diff --check && git status --short
```

All green + the ten gate suites in Task 12 Step 1 + a clean diff/status audit = Batch 2 complete.
