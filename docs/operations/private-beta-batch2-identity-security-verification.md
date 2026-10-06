# Private Beta Batch 2 — Identity & Security Gate Verification (Task 12)

**Date:** 2026-10-06
**Plan:** `docs/superpowers/plans/2026-10-06-private-beta-batch-2-identity-security.md` (Task 12 + Acceptance Gate + Final Acceptance Commands)
**Spec:** `docs/superpowers/specs/2026-10-06-private-beta-marketplace-reset-design.md`
**Worktree:** `batch2-implementation` (branch `opencode/batch2-implementation`)

> ## ⛔ OVERALL VERDICT: **GATE FAIL** — 1 blocker
>
> Every unit/integration gate suite, the source-scan classification, lint, typegen,
> typecheck, build, preflight (7/7), `npm audit`, the migration graph, and the real-DB
> `db verify` are **green**. **`npm run smoke` FAILS** (§5): `scripts/smoke.sh` boots the
> production standalone server without `ADMIN_MFA_ENCRYPTION_KEY`, which Batch 2 Task 8
> made a production-required key with fail-fast `process.exit(1)`
> (`src/lib/env.ts:26` → `instrumentation.ts:27`). The server exits before serving;
> `/api/health` never returns `200 db=up`; smoke exits 1.
>
> Per the Task 12 contract this task **verifies and does not fix**: the defect is recorded
> here as a blocker with evidence (§5) and the remediation is left for a follow-up commit
> (one line in `scripts/smoke.sh`, then re-run `npm run smoke`). **Batch 2 is not accepted
> until the blocker is closed and smoke re-runs green.** No "PASS" is claimed anywhere in
> this document.

---

## 1. Commits

Base: `e13f65e` (Batch 1 complete). Pre-doc HEAD: `effc70b`. This document is committed as
the Task 12 commit (`test(batch2): verify identity & security gate`).

```
$ git log --oneline e13f65e..HEAD
effc70b fix(admin): make bootstrap runbook production-safe
3c46c7d feat(admin): role management, bootstrap, recovery runbook
ec40ef1 fix(seller): close verification workflow gaps
c205f0b feat(seller): verification workflow, policy v1, publication gate
a5e3e6e fix(admin): tighten session revocation and recovery-code audit
d3a4cc3 feat(admin): session inventory and revocation surfaces
2887f0e fix(admin): bind admin authority to MFA sessions and rate-limit step-up
5f88510 feat(admin): TOTP MFA with recovery codes and step-up
ad380e3 fix(identity): require step-up to verify a recovery channel
7546a43 fix(identity): close phone step-up bypass and harden identity changes
3d4d5e0 feat(identity): email/phone verification and identity changes
d46b328 fix(identity): harden account recovery
7f1fdfb feat(identity): enumeration-safe account recovery
65d29a0 fix(rbac): guard admin listings page and unknown roles
565ae8e fix(otp): race-safe attempt limit and PII-free errors
70027ee feat(audit): typed audit event foundation
6f999e1 feat(rbac): capability-based admin authorization
95510eb feat(otp): hashed single-use OTP with delivery adapters
0861f97 feat(auth): database-backed sessions with revocation
42e9639 feat(db): add batch 2 identity & security contract
```

21 commits = Tasks 1–11 (11 feature commits) + 10 independent-review fix commits.
No push/merge/deploy performed at any point.

**OpenCode metadata:** model `home-gateway/OneNexus/glm-5.3#max` (OneNexus GLM 5.3).
Batch 2 agent sessions (`opencode session list`):

| Session | Purpose |
|---|---|
| `ses_ef13c46ddffePz94u3KwnJEtkn` | Private-beta Batch 2 identity security plan |
| `ses_ef1146540ffe3en5T59gtBcI0d` | Batch 2 Task 1: contract + migration + backfill |
| `ses_ef0ddc134ffeU3UI64fJj8flui` | Review commit 42e9639 schema/migration (Task 1) |
| `ses_ef0eadbafffeRT7TcKnkpwGR8G` | Task 1 commit 42e9639 spec compliance review |
| `ses_ef0d1e446ffe0cZBo01vMrC9g0` | DB-backed sessions + auth rewrite (Task 2) |
| `ses_ef0cb7992ffeekvYF7cfZkKk1G` | DB-backed sessions + auth rewrite (Task 2) |
| `ses_ef0bad226ffe0Yx1Vw6fewMkSp` | Task 2: DB session core implementation |
| `ses_ef08ada96ffe38rjDwlLTD8Q7X` | Security review of commit 0861f97 (Task 2) |
| `ses_ef07edc06ffepVqrbBCdrFcRhC` | Task 3: OTP core, delivery adapters, inbox route |
| `ses_eeff59c6bffeTteb070YIVPjE9` | Batch 2 Task 4+5: RBAC + audit foundation |
| `ses_eeff07000ffeX1hwxXSNQfWsYM` | Batch 2 Task 3 review fix: OTP race + PII |
| `ses_eefd6ae42ffezoJjQrkA7DoGKC` | Batch 2 Task 4 follow-up: listings guard |
| `ses_eefd6ad25ffeGTHwiAyrhpJWza` | Batch 2 Task 6: email/phone verification |
| `ses_eefd6ad23ffeHKD6SXtu5K475A` | Batch 2 Task 7: account recovery |
| `ses_eefd6ad26ffezyQJ5GcRu5DIPV` | Batch 2 Task 8: admin MFA |
| `ses_eef55d22effeu8HNs1tfNxRj5y` | Batch 2 Task 9: session inventory + admin layout RBAC |
| `ses_eef0a5714ffeaUlE8JahqfdLTP` | Batch 2 Task 10: seller verification + publication gate |
| `ses_eeee3c2b7ffezTu90avwqoBCKU` | Batch 2 Task 11: admin roles + bootstrap runbook |
| `ses_eee96e518ffedi24tYbcu5A2Zd` | Batch 2 Task 12: gate verification (this session) |

Task 6/7/8/9/10/11 review fixes were executed inside their task sessions (their reports
carry "Review fix" sections); Task 3's fix and Task 4's follow-up ran in dedicated sessions.

---

## 2. Gate-suite results (Step 1 — all green)

Run 2026-10-06 in the worktree, Node ≥ 22, vitest 4.1.11.

| # | Gate (plan Task 12 Step 1) | Command | Result |
|---|---|---|---|
| 1 | Authorization matrix | `npm test -- tests/unit/rbac.test.ts` | **PASS** — 23/23 (matrix cell-by-cell, legacy `role="admin"` grants nothing, unknown-role fail-closed, `admin.role_manage` coverage) |
| 2 | OTP abuse | `npm test -- tests/unit/otp.test.ts tests/unit/verification-delivery.test.ts` | **PASS** — 32/32 (attempt limit incl. 20-wrong concurrent CAS, cooldown, per-target limit, single-use, expiry, target binding, no plaintext in any log sink incl. `console.warn/info/debug`, dev inbox never logs, seam 404 in production) |
| 3 | Identity collision (unit) | `npm test -- tests/unit/verification-actions.test.ts` | **PASS** — 44/44 (typed collision errors, no merge, step-up at request **and** confirm, CAS profile phone update, tx revocation) |
| 4 | Recovery abuse | `npm test -- tests/unit/recovery-actions.test.ts` | **PASS** — 31/31 (byte-equal neutral messages, verified-channel-only matching, revoke-all-sessions in tx, per-identifier HMAC-keyed limit, timing-oracle closure via `after()`) |
| 5 | Session invalidation (unit) | `npm test -- tests/unit/session.test.ts` | **PASS** — 28/28 (revoked/expired/garbage fail lookup, fresh token per login, TTLs, throttled touch, tx-variant with `exceptSessionId`) |
| 6 | Seller publication gate | `npm test -- tests/unit/seller-verification-policy.test.ts tests/unit/publication-gate.test.ts` | **PASS** — 41/41 (seven requirements fresh from DB, all four transitions incl. admin approve blocked, legacy boolean grants nothing, membership expiry honoured) |
| 7 | MFA + MFA key validation | `npm test -- tests/unit/totp.test.ts tests/unit/admin-mfa.test.ts tests/unit/admin-mfa-login.test.ts tests/unit/env.test.ts` | **PASS** — 98/98 (RFC 4226 Appendix D + RFC 6238 Appendix B vectors through pinned `otpauth`, envelope `v1:<keyId>:` + AAD bind + wrong-key typed error, replay protection, login impossible without MFA, recovery single-use, step-up rate limit, env base64-32 strict) |
| 8 | Admin step-up | `npm test -- tests/unit/admin-session-actions.test.ts tests/unit/admin-role-actions.test.ts tests/unit/seller-verification-actions.test.ts` | **PASS** — 101/101 (step-up on role manage + seller decisions, shared step-up limiter across surfaces, last-super-admin row-lock guard, self-review/self-grant denied, atomic claim) |
| 9 | Backend enforcement (real DB) | `npm run test:integration` | **PASS** — **50/50, 7 files** (`batch2-migration`, `escrow`, `session-lifecycle`, `identity-collision`, `admin-mfa-login`, `seller-verification`, `admin-bootstrap` = the exercised runbook gate). Scratch container `sp-it-pg-46066`, migrate `--to production` applied 2 migrations / 191 operations, container cleaned by trap. |

Unit gate total: 398 tests across the 8 unit gate suites; full suite 682/682 (38 files) — §4.

---

## 3. Backend-enforcement source scan (Step 2 — green, every hit classified)

`rg` (ripgrep 14.x) at `/usr/local/bin/rg`. Every hit classified manually; **no Batch 2
authorization read of `role`/`isVerifiedSeller` exists**.

### 3.1 `rg -n "requireAdmin\b" src app` → **0 hits** ✅

The broad check is deleted (`src/lib/auth.ts`, Task 4); every admin surface gates through
`requireCapability*`/`requireAdminUser` (`src/lib/rbac.ts`). All 11 `app/admin/**/page.tsx`
carry a server-side guard (verified per-file; pinned permanently by
`tests/unit/admin-page-guards.test.ts`, which enumerates every current and future admin page).

### 3.2 `rg -n "toggleSellerVerification" src app` → **0 hits** ✅

Deleted in Task 10 (`ec40ef1`); the workflow (`SellerVerification`) is canonical (spec §8.2).

### 3.3 `rg -n 'role === "admin"|role !== "admin"' src app` → 6 hits — all classified

| File:Line | Read type | Authorization read? | Justification |
|---|---|---|---|
| `app/orders/[id]/page.tsx:67` | `user.role !== "admin"` view triad (buyer/seller/admin) on the consumer order-detail page | **No** (view-visibility only) | Pre-existing Batch 1 dormant-finance page (orders cannot be created with `FINANCIAL_FEATURES_ENABLED=false`); grants no mutation — the admin mutations behind it (`resolveDisputeAction`) are guarded by `assertFinancialFeaturesEnabled()` **first** + `requireAdminUser()`. Untouched by Batch 2 (`git log e13f65e..HEAD -- app/orders/[id]/page.tsx` empty). |
| `app/listings/[slug]/page.tsx:45` | `user?.role !== "admin"` — admin may preview non-approved listings | **No** (view-visibility only) | Pre-existing Batch 1 preview rule; every listing-status *transition* (the privileged surface) is gated by the publication gate + capability guards in the actions (Task 10, pinned by `publication-gate.test.ts`). Untouched by Batch 2. |
| `app/admin/users/page.tsx:131` | `u.role === "admin"` badge color | **No** (display) | Row badge styling only; the page guards with `requireCapability("user.view_basic")`, actions guard themselves. |
| `src/lib/actions/admin-identity.ts:522` | `target.role === "admin"` display-role restore decision (Task 11 review fix D6) | **No** (display write-path) | Decides the **display** `User.role` value when admin rights are removed (restore from seller marker); authorization is `requireCapabilityWithStepUp("admin.role_manage")` — `adminRole` is the only authority source (spec §8.5). |
| `src/lib/admin-role-ops.ts:53` | comment mentioning `User.role === "admin"` | **No** (comment) | Documentation of the D6 restore rule. |
| `src/components/header-user-menu.tsx:70` | `user.role === "admin"` — header shows the admin link | **No** (display) | Navigation convenience only; `/admin` layout guards with `requireAdminUser()` (spec §4.5). |

### 3.4 `rg -n "isVerifiedSeller" src app` → 44 hits — all classified

| File:Line(s) | Read type | Authorization read? | Justification |
|---|---|---|---|
| `app/admin/listings/page.tsx:22,88` | select + badge render | **No** (display) | Moderation-queue "đã xác minh" badge; page guards `requireCapability("listing.moderate")` (Task 4 follow-up `65d29a0`). |
| `app/admin/users/page.tsx:15,36,53,142` | select + `legacy` badge render | **No** (display) | Read-only legacy column with explicit `legacy` badge; the mutate toggle was deleted in Task 10. |
| `app/admin/withdraws/page.tsx:29,92` | select + badge render | **No** (display) | Dormant finance page (Batch 1 posture), guarded `requireAdminUser()`. |
| `app/listings/[slug]/page.tsx:11,39,266,271` | **workflow** badge via `isVerifiedSellerStatus(sellerVerification.status)` | **No** (display, reads the workflow) | The public verified badge reads `SellerVerification.status` through `src/lib/seller-verification-status.ts` (Task 10 review fix) — the legacy boolean is no longer the badge source; lines 11/39 are the import + a comment. |
| `app/profile/page.tsx:7,26,57` | same workflow badge pattern | **No** (display, reads the workflow) | As above. |
| `app/seller/[id]/page.tsx:7,19,71` | same workflow badge pattern | **No** (display, reads the workflow) | As above. |
| `src/lib/actions/admin.ts:16,224` | comments | **No** (comment) | Document that the legacy boolean is display-only and no admin mutate path remains. |
| `src/lib/auth.ts:29`, `src/lib/rbac.ts:21`, `src/lib/seller-verification-policy.ts:26` | comments | **No** (comment) | Document that `role`/`isVerifiedSeller` grant nothing (spec §8.2/§8.5). |
| `src/lib/seller-verification-status.ts:5,13,29` | helper **named** `isVerifiedSellerStatus` — reads `SellerVerification.status`, never the boolean | **No** (display, reads the workflow) | The §6.2-exact badge helper; the name matches the scan pattern but the read is the workflow status. |
| `src/lib/session.ts:65,104` | `SessionUser.isVerifiedSeller` mapping | **No** (display) | Legacy field carried on the session user type for UI compatibility; `rbac.ts` never reads it; the publication gate never reads it. |
| `src/prisma/contract.prisma:157`, `contract.d.ts` (8), `contract.json` (4) | schema/emitted artefacts | **No** (schema) | The column definition itself (additive-only contract, spec §8.2). |
| `src/prisma/seed.ts:238,243,247` | seed demo data | **No** (seed) | Demo accounts; grants nothing under the gate (documented residual — seeded sellers still need the backfill + all seven requirements). |

### 3.5 `rg -n "FINANCIAL_FEATURES_ENABLED" .env.example docker-compose.prod.yml scripts` → all `"false"` ✅

`.env.example:35` `"false"` · `docker-compose.prod.yml:80` `"false"` · `scripts/smoke.sh:12,101,153`
`"false"` (comment + export + comment) · `scripts/docker-smoke.sh:80` comment `"false"`.
Batch 1's finance shutdown is preserved verbatim; no Batch 2 surface weakens it
(all finance suites green in §4).

### 3.6 Transaction-callback try/catch classification (addition) — **no catch inside any `db.transaction` callback** ✅

Files containing `db.transaction(async …)`: `catalog.ts`, `verification.ts`, `recovery.ts`,
`admin-identity.ts`, `exchange.ts`, `helpers.ts`, `orders.ts`, `escrow.ts`,
`seller-verification.ts`, `admin.ts`, `offers.ts`, `admin-mfa.ts`. Of these,
**`catalog.ts`, `exchange.ts`, `helpers.ts`, `orders.ts`, `escrow.ts`, `seller-verification.ts`,
`offers.ts` contain zero try/catch** — their callbacks throw out by construction
(throw-out rule; Postgres aborts the tx on constraint violation, COMMIT cannot silently
become ROLLBACK). The four files with both:

| File:Line | Catch location vs tx | Classification |
|---|---|---|
| `src/lib/actions/admin-identity.ts:347` (regenerate codes) | callback 347–366, **no try/catch inside** | Audit + delete/create live/die in the tx (review fix #2); errors propagate → rollback. |
| `src/lib/actions/admin-identity.ts:505–549` (setAdminRole) | `try` **wraps** `db.transaction` (506); catch at 547 is **outside** the callback | Callback (506–546) has no catch. `toRoleErrorState` maps only the four typed operator errors (`STEP_UP_REQUIRED`/`MFA_CODE_INVALID`/`MFA_RATE_LIMITED`/`LAST_SUPER_ADMIN`) to form state and **re-throws everything else** (`admin-identity.ts:418`) — a constraint violation (SQLSTATE 23505) propagates; and the tx has already rolled back when the catch runs. |
| `src/lib/actions/admin.ts:38–51` | fail-open audit **before** the tx at 123; callback 123–175 has **no try/catch** | `listing.approve_blocked` audit failure must not open the approve path; the dispute tx throws out (dormant finance path, finance assert first). |
| `src/lib/actions/recovery.ts:318–321` | callback is two statements, **no try/catch inside** | Password update + `revokeAllUserSessionsTx` atomic (review fix #3); the surrounding try/catch blocks (325+, 338+, 359+) are **after** the tx — fail-open audit/notify/security-notice. |
| `src/lib/actions/verification.ts:410–425` (phone verify confirm) | `try` **wraps** the tx (411); catch at 422 **outside** the callback | `IdentityCollisionError` → typed `PHONE_ALREADY_VERIFIED` **after rollback**; `throw e` re-throws everything else (fail closed, comment at 424). |
| `src/lib/actions/verification.ts:463–468` (change password) | callback, **no try/catch** | Hash + revocation atomic on the tx. |
| `src/lib/actions/verification.ts:576–588` (email change confirm) | `try` **wraps** the tx (577); catch at 585 **outside** | `isUniqueConstraintViolation` (23505) → typed `EMAIL_TAKEN` **after rollback** (the DB unique constraint is the final race boundary); `throw e` otherwise. |
| `src/lib/actions/verification.ts:699–717` (phone change confirm) | `try` **wraps** the tx (700); catch at 714 **outside** | Same pattern: collision → typed error after rollback; re-throw otherwise. |
| `src/lib/admin-mfa.ts:218` | one-line tx wrapping `enrollAdminMfaTx` (168–206, **no try/catch inside**) | Enrollment is atomic; the try at 284 wraps `decryptTotpSecret`+`verifyTotpStep` **outside any tx** (typed, secret-free `captureError`, fail closed to `null`). |

**Conclusion:** no transaction callback swallows a constraint violation and returns
normally; every catch either sits outside the callback (tx already rolled back) or wraps
non-transactional fail-open/fail-closed helpers.

### 3.7 PII scan (addition): no raw email/phone/OTP/TOTP secret in logs or `AuditEvent.detail` ✅

`console.*` in `src/` + `app/` (non-test): **zero hits in any Batch 2 identity/admin module**
(`otp.ts`, `verification-delivery.ts`, `verification.ts`, `recovery.ts`, `session.ts`,
`admin-mfa.ts`, `admin-mfa-key.ts`, `totp.ts`, `rbac.ts`, `audit-event.ts`,
`seller-verification.ts`, `beta-cohort.ts`, `admin-identity.ts`). The remaining hits are
pre-existing and classified: momo payment routes (Batch 1 finance, order ids/amounts only),
`observability-core.ts` (the structured sink itself — callers' payloads are pinned by the
no-log spy tests), `db.client.ts:35` (slow-query warn — explicitly no SQL/params, metrics
only), `sw-register.tsx` (client), seed/regen scripts (offline, demo data, passwords never
printed). `src/lib/verification-delivery.ts:16` is a comment documenting the no-log rule.

`captureEvent`/`captureError` call sites in identity/admin code carry **action names and
typed keys only**: `recovery.ts:238,243,336,347` (`{ action: … }`), `verification.ts:249`
(`{ subjectKey }`), `verification-delivery.ts:85,107` (`{ channel, subjectKey }`),
`admin-mfa.ts:287` (typed decrypt errors; keyId is non-secret by design),
`rate-limit.ts:141` (`{ scope }`). The Task 3 fix removed the raw phone from
`normalizePhone`'s error message; timing-safe hash comparison added.

`AuditEvent.detail` values (all call sites): `count=N`, `channel=email|phone`,
`cohort=<enum>;status=<enum>`, `sellerType=<enum>;province=<code>`, `decision=<enum>`,
`missing=<typed requirement keys>`, `from=<role> to=<role>` — **no raw email/phone/OTP/
TOTP secret anywhere**. Offline scripts match: backfill `detail: count=N` (actor null);
bootstrap `from=/to=<role>;sessionsRevoked=N`, `recoveryCodes=10` (count only),
`sessionsRevoked=N`. The bootstrap script prints the TOTP secret + recovery codes to the
terminal **exactly once** by design (enrollment output, never via `captureEvent`/audit;
runbook §7 documents the docker-log-driver caution). `redactDetail`
(`src/lib/audit-event.ts`) exists as the belt-and-braces masking helper; the convention is
enforced by review + this scan.

---

## 4. Full preflight + build + smoke (Step 3)

| # | Command | Result |
|---|---|---|
| 1 | `npm run lint` | **PASS** — 0 errors, 0 warnings |
| 2 | `npx next typegen` | **PASS** — route types generated (required before tsc; `.next/types` is gitignored) |
| 3 | `npx tsc --noEmit` | **PASS** — exit 0, no errors |
| 4 | `npm test` (full unit) | **PASS** — **682/682, 38 files** (Batch 1 finance suites + all Batch 2 suites green) |
| 5 | `npm run test:integration` | **PASS** — 50/50, 7 files (§2 gate 9; scratch container cleaned) |
| 6 | `npm run build` | **PASS** — exit 0; routes `/recover`, `/sell/verification`, `/admin/security`, `/admin/seller-verification`, `/admin/audit` present; **1 pre-existing warning only** (`instrumentation.ts:27` `process.exit` in Edge Runtime — from Batch 0/1 commit `b8e1c85`, untouched by Batch 2: `git log e13f65e..HEAD -- instrumentation.ts` is empty) |
| 7 | `npm run preflight` | **PREFLIGHT PASS — 7/7 gates**: contract-emit-drift, lint, typecheck, unit-tests, production-build (placeholder env), compose-config (incl. `ADMIN_MFA_ENCRYPTION_KEY` placeholder), migration-graph |
| 8 | `npm run smoke` | ❌ **FAIL — BLOCKER** (§5) |
| 9 | `npm audit --omit=dev` | **Recorded** — `otpauth`/`@noble/hashes` add **no findings**; 1 pre-existing high (`source-map-js@1.2.1`, GHSA-68fv-2mgg-jv7q, event-loop DoS) via dev toolchains only (`@prisma/cli-engine`→c12→magicast, `@tailwindcss/*`, `next`→postcss) — present before Batch 2 (verified in Task 8 by stashing), **not** reachable from `otpauth`; dev-only chain, no runtime path from Batch 2 code |

**Dependency pinning (Global Constraints):** `package.json:31` `"otpauth": "9.5.2"`
(exact, **no `^`**) ✅; `package-lock.json` resolves `node_modules/otpauth` → `9.5.2` and
`node_modules/@noble/hashes` → `2.4.0` with integrity hashes ✅. `npm audit` clean for the
new dependency.

---

## 5. ⛔ Blocker: `npm run smoke` FAILS — production boot env missing `ADMIN_MFA_ENCRYPTION_KEY`

**Evidence** (`scripts/smoke.sh` run of 2026-10-06 20:41, log `/tmp/loaviet/batch2-task12-smoke.log`):

```
── start standalone server (parity Docker: node server.js) — PID được track
▲ Next.js 16.3.7
- Local:         http://127.0.0.1:64881
✓ Ready in 0ms
ENV_VALIDATION_FAILED (1 issue):
  ✗ ADMIN_MFA_ENCRYPTION_KEY: thiếu (chưa đặt trong .env)
FAIL: /api/health không lên 200 db=up sau 60s
→ dọn container scratch: sp-smoke-pg-48173
```

**Chain of cause (all file:line verified):**

1. Task 8 added `ADMIN_MFA_ENCRYPTION_KEY` to the production-required set —
   `src/lib/env.ts:21-27` (`REQUIRED_KEYS`), validated base64-of-exactly-32-bytes
   (`src/lib/env.ts:98-109`).
2. `instrumentation.ts:24-27` fail-fasts in production: missing key → `console.error` +
   `process.exit(1)` **before the first request**.
3. `scripts/smoke.sh:94-105` boots the standalone server with `NODE_ENV=production` and
   exports `DATABASE_URL`, `AUTH_SECRET`, `CRON_SECRET`, `FINANCIAL_FEATURES_ENABLED`,
   `NEXT_PUBLIC_APP_URL`, `TRUST_PROXY_HEADERS`, `PORT`, `HOSTNAME` — **but not
   `ADMIN_MFA_ENCRYPTION_KEY`** (repo `.env` also lacks it; standalone does not load repo
   env files).
4. The server exits during instrumentation startup → the health loop never sees
   `200 {"db":"up"}` → `SMOKE FAIL` exit 1.

**Scope of the defect:** `scripts/smoke.sh` was last touched in Batch 1
(`git log e13f65e..HEAD -- scripts/smoke.sh` is empty). The plan's Task 8 Files list named
`.env.example`, `docker-compose.prod.yml`, `scripts/preflight.sh` — **not** `scripts/smoke.sh`;
the preflight compose gate got its placeholder, the smoke production boot did not. This is a
plan-level omission that the Task 12 gate exists to catch. The fail-fast itself is **correct
production behavior** (a production deploy without the key must refuse to start); only the
smoke harness env is wrong.

**Remediation (NOT applied here — this task verifies and must not fix):** one follow-up
commit adding a random test value to `scripts/smoke.sh`'s export block, mirroring the
`AUTH_SECRET`/`CRON_SECRET` pattern:

```bash
export ADMIN_MFA_ENCRYPTION_KEY="smoke-$(openssl rand -base64 32 | tr -d '\n')"
```

…then re-run `npm run smoke` (expected: health 200 db=up; the finance-shutdown checks
re-verified green) and re-record this section. Until then **the Batch 2 acceptance gate is
FAIL**.

---

## 6. Diff/status audit + migration review (Step 4 — green)

- `git diff --check` → clean (no whitespace/conflict artifacts).
- `git status --short` → only `?? .superpowers/` (untracked local skill state, never staged).
  No `.claude/settings.json`, no `public/uploads/`, no secrets, no scratch data in the tree.
- `npx prisma migration list` (offline) → **linear graph**: `20261003T0448_baseline`
  (`empty → 7a6d2852…`, 143 ops) → `20261006T0209_batch2_identity_security`
  (`7a6d2852… → 0ed42b45…`, 49 ops, refs `db` + `production`). No forks, no gaps.
- **Real-DB verification** (scratch container started the same way
  `scripts/test-integration.sh` does — own name `sp-it-pg-<pid>`, random password, free port,
  torn down after):
  - `DATABASE_URL=… npx prisma db migrate --to production` → `migrationsApplied: 2`,
    `markerHash: 0ed42b4563bdd21ef0c4fd0af28cd764edfcf464e419207721dbb15fd12b8e64`.
  - `DATABASE_URL=… npx prisma db verify` → **ok**: `"Database marker and schema match
    contract"`, `mode: full`, contract storageHash == marker storageHash
    (`0ed42b45…`), profileHash match (`3916f444…`), `"Database schema satisfies
    contract"`, `unclaimed: []`, `warnings: []`, exit 0.
  - `DATABASE_URL=… npx prisma migration list` → both migrations present on the real DB.
- `npx prisma migration show 20261006T0209_batch2_identity_security` → **48 `additive`
  operations + 1 `data` operation, zero `destructive`**: 19 create-index, 9 add-foreign-key,
  8 create-table (`UserSession`, `OtpCode`, `SellerVerification`, `BetaCohortMembership`,
  `PolicyAcceptance`, `AdminMfa`, `AdminRecoveryCode`, `AuditEvent`), 5 add-unique-constraint,
  5 add-column (`User.emailVerifiedAt/phoneVerifiedAt/adminRole/sellerType/
  sellerOperatingProvinceCode`), 2 add-check-constraint, and the data transform
  **`backfill-admin-role`** (`migrations/app/20261006T0209_batch2_identity_security/migration.ts:539-549`):
  `check` = `role='admin' AND adminRole IS NULL` limit 1; `run` = `UPDATE … SET adminRole =
  'super_admin' WHERE role='admin' AND adminRole IS NULL` — the intentional legacy mapping
  (spec §8.5), idempotent by predicate. Additive-only confirmed; no existing finance table,
  historical record, or legacy column dropped/renamed/retyped.

### 6.1 SellerVerification backfill — dry-run/apply/idempotence/rollback exercised (real DB)

Run 2026-10-06 against a fresh scratch container (migrated `--to production`), seeded with
one legacy verified seller + one plain buyer:

```
── DRY RUN:  ── ứng viên (isVerifiedSeller=true, chưa có row): 1
   · u-leg-1
── APPLY:     ── đã tạo: 1 row (reasonCode=migrated_legacy_verified)
── rollback nếu cần: DELETE FROM "SellerVerification" WHERE "reasonCode" = 'migrated_legacy_verified';
── APPLY lại: ── ứng viên: 0 / đã tạo: 0 row   (idempotent)
── AuditEvent: seller_verification.backfill reason=migrated_legacy_verified detail=count=1 actor=null
               seller_verification.backfill reason=migrated_legacy_verified detail=count=0 actor=null
── Rollback exercise: DELETE 1   (row removed; dry-run would re-report the candidate)
```

Refusal without `DATABASE_URL` in the real process env (exit 1) and the `--apply` target
print (host:port/db, never the password) were re-verified in the Task 10 review fix
(`ec40ef1`) and pinned by `tests/integration/seller-verification.test.ts` (green in §2
gate 9). A migrated `verified` row alone does **not** satisfy the publication gate
(integration case). Rollback procedure: the `DELETE` above (documented in the script header).

---

## 7. Residual risks, decisions & ambiguities (collected from ALL Batch 2 task reports)

Each item: status + hand-off. "Batch 8 register" = the Founder Decision Register /
residual-risk register to be maintained by Batch 8 (launch gate).

### 7.1 Accepted residual risks (documented, no action in Batch 2)

| # | Residual risk | Status | Hand-off |
|---|---|---|---|
| R1 | **Session cutover logs everyone out** — replacing the JWT cookie with DB sessions invalidates all existing logins (one-time, on deploy). | Accepted (pre-launch private beta; plan Global Constraints) | Recorded here; Batch 8 launch checklist mentions the one-time re-login. |
| R2 | **Concurrent phone-verify race** — two parallel confirms of the same phone can both pass the in-tx re-check (no advisory lock: `tx.raw` undefined in the tx context, `db.raw.sql` only on the pool client, no isolation-level option in rc.13). Single app instance; cross-account invariants unaffected. | Accepted (plan-sanctioned); probed against the real dev DB in the Task 6 review | **Batch 8 register + follow-up migration**: partial unique index `ON "User"("phone") WHERE "phoneVerifiedAt" IS NOT NULL`, or a Prisma 8 release exposing the raw lane inside tx. Ops duplicate-phone review query lives in the runbook. |
| R3 | **Login-vs-reset race** — a concurrent `loginAction` reading the old `passwordHash` before the recovery tx commits can create one session after `revokeAllUserSessionsTx` ran. Milliseconds window; the session belongs to someone who just proved the old password. | Accepted (review instruction: no schema change) | Batch 8 register; schema-level fix (session invalidation epoch) if the threat model grows. |
| R4 | **In-memory rate limiters / TOTP replay store are single-instance** (`rate-limit.ts`, dev OTP inbox, `lastUsedTotpStep`) — restart resets; no cross-instance protection. | Accepted (repo topology = one instance) | Batch 8 register; revisit at multi-instance scale-out. |
| R5 | **TOTP replay protection is in-process only** (`admin-mfa.ts` monotonic `lastUsedStep` + `claimTotpStep`, RFC 6238 §5.2) — durable/cross-instance needs an additive `AdminMfa.lastUsedStep` column. | Accepted (window ±60s; single instance) | **Batch 8 register + follow-up migration** (additive column; no schema change was allowed in the review fix). |
| R6 | **Revocation/suspension does not unpublish existing approved listings** — the spec gates *transitions* into review/public only (§4.4); already-public listings stay public until the seller hides them or Batch 3 moderation acts. | Accepted (spec-literal) | Batch 3 (moderation) + Batch 8 register. |
| R7 | **Dormant finance paths write `approved` without the publication gate** — `admin.ts:144` (dispute resolved_buyer → items back to approved) and `orders.ts:373` (dispute/cancel → approved). Both behind `assertFinancialFeaturesEnabled()` (finance hard-off) and restore pre-escrow state rather than publish new content. | Classified dormant-finance residual, not a live bypass | Revisit if/when finance re-enables (Batch 8 register). |
| R8 | **Unverified account holding an email blocks the real owner** — the email-change pre-check and DB unique constraint match *unverified* rows too; spec §5.3.1 defines uniqueness for verified identities only. Current behavior is stricter than spec. | Recorded (loosening needs founder decision) | Batch 8 register. |
| R9 | **Same-account clobber window** — verification/change confirms read the row then update `where({id})`; a concurrent same-account profile edit between read and write can be reverted by the confirm. Cross-account invariants unaffected (collision re-check runs in-tx on current state); profile side is CAS-protected. | Minor, noted | Batch 8 register. |
| R10 | **Recovery timing side channel narrowed, not eliminated** — both request paths return after one DB query; the remaining differentiator is the `after()` scheduling call (sub-µs). Confirm path does more work post-`verifyOtp` but requires a valid code (existence already proven to the caller). | Accepted | Batch 8 register. |
| R11 | **Post-response OTP creation** — with `after()`, the `OtpCode` row is written after the response streams; a confirm inside that milliseconds window gets the collapsed error and succeeds on retry. | Accepted | — |
| R12 | **Per-identifier confirm-limit DoS** — an attacker can lock a victim identifier's confirm bucket for 10 min (5/10 min); fail-closed direction, self-healing. | Accepted for private beta | Batch 8 register. |
| R13 | **TOCTOU between the fresh gate read and the listing write** (milliseconds) — a listing that slips into `pending` cannot reach `approved` without the admin gate, which re-checks fresh. | Accepted (defense-in-depth per spec §7.3) | — |
| R14 | **`requestEmailVerificationAction` does not short-circuit when already verified** — a resend is harmless (same target, hashed, rate-limited); UI hides the form when verified. | Noted | — |
| R15 | **Seed still seeds demo sellers with `isVerifiedSeller: true`** — grants nothing under the gate; those users need the backfill + all seven requirements like everyone else (spec §8.2/§8.4). | Noted (seed changes out of Batch 2 scope) | Batch 8 launch checklist (seed is dev-only). |
| R16 | **Dead `sp_session` cookie after recovery** — the browser may hold a revoked cookie until the next login overwrites it; lookup fails closed to logged-out. | Harmless | — |
| R17 | **`redactDetail` over-redacts standalone 6-digit tokens** (money amounts without separators, order-code date segments) — deliberately safe direction. | Accepted | — |
| R18 | **Pre-existing `source-map-js` high in `npm audit --omit=dev`** — dev toolchain only (`@prisma/cli-engine`, Tailwind, next→postcss); no runtime path from Batch 2 code; present before Batch 2. | Recorded (Task 8 verified pre-existing by stashing) | Batch 8 register / dependency hygiene. |
| R19 | **Pre-existing build warning** — `instrumentation.ts:27` `process.exit` in Edge Runtime (Batch 0/1 commit `b8e1c85`, untouched by Batch 2). | Recorded | Batch 8 register. |

### 7.2 Founder decisions applied during Batch 2 (FD register)

| # | Decision | Status | Hand-off |
|---|---|---|---|
| FD-1 | **34-province registry (NQ 202/2025/QH15)** replaces the plan's 63-province `PROVINCE_CODES` — `src/lib/provinces.ts` (11 not-rearranged + 23 merged units, legacy-name resolution, diacritic/đ-insensitive folding, fail-closed on unknowns/abbreviations like `HCM`/`Sài Gòn`). Founder-approved 2026-10-06, overrides the plan. | Applied + tested (17 unit cases) | Batch 8 register: confirm the registry at launch; legislative changes flow through it. |
| FD-3 | **Fail-closed defaults for every spec-silent policy choice** (applied across Tasks 9–11): self-review (`SELF_REVIEW_FORBIDDEN`) and self-grant (`SELF_GRANT_FORBIDDEN`) denied; `operations_admin` can revoke `super_admin` sessions (no rank check — matrix grants both `session.revoke`); `regenerateRecoveryCodesAction` accepts a recovery code as proof (burns one to mint ten — the documented lockout self-recovery path); declaration change after verification auto-transitions `verified → needs_review` (reason `identity_information_inconsistent`, human review preserved); removal restores display role from the seller marker, grant preserves `role="seller"`; `ADMIN_ROLE_REASON_CODES` taxonomy (onboarding/responsibility_change/offboarding/security_response/correction). | Applied + tested | **Batch 8 register — founder review of each default**; reversible per item. |
| A5 | **Step-up on every seller decision** — `seller.verify` + `seller.verification.revoke` in `STEP_UP_CAPABILITIES` (strictest reading of spec §5.4.2 "where configured"). | Applied | Batch 8 register: reversible by removing them from the constant after founder review. |

### 7.3 Ambiguities blocking future batches (spec §4.11/§11.1 — fail-closed, need founder policy)

| # | Ambiguity | Batch 2 handling | Hand-off |
|---|---|---|---|
| A1 | **Production OTP delivery provider unspecified.** Batch 2 ships the adapter seam, the in-memory dev/test adapter (never logs; dev-only retrieval seam 404 in production), and the fail-closed production adapter (`OTP_DELIVERY_UNAVAILABLE`). **Gate-scope distinction (verbatim from the plan's Acceptance Gate):** "everything above is the *implementation* gate and passes in every environment (dev, test, production build) **without** a production OTP provider: the adapter seam, the in-memory dev/test inbox, and the fail-closed production delivery are all tested behavior. **Beta launch additionally requires** a configured production email/SMS provider behind `OtpDeliveryAdapter` (Ambiguity A1) — until the founder selects one, production OTP delivery (email/phone verification, self-service recovery) is unavailable by design. That is a launch prerequisite, not a Batch 2 gate failure, and the verification doc must say so verbatim." | Implemented fail-closed; all delivery tests green | **Beta-launch prerequisite** (Batch 8 register): founder picks + configures a real email/SMS provider behind `OtpDeliveryAdapter`. |
| A2 | **RBAC `Scoped`/`Exceptional + audited`/`Limited`/`Explicit permission` cells undefined** (moderator/support `user.suspend`, moderator/support `pii.view_sensitive`, moderator analytics, super_admin `pii.export`). Batch 2 implements only the unambiguous ✓ cells and fails closed on the rest (`pii.export` granted to **no one**; support/moderator get only `admin.access`). | Fail-closed matrix green | **Blocks Batch 3** (moderation) surfaces until the founder defines the semantics; Batch 8 register. |
| A3 | **Admin-assisted (out-of-band) recovery identity proofing unspecified.** Self-service recovery only; a user who lost every verified channel cannot self-recover. The manual fallback is now **transactional + audited** (runbook §3/§6: one `BEGIN…COMMIT` psql block with `ON_ERROR_STOP`, DO-block user resolution, mutation + audit INSERT atomic, `gen_random_uuid()` ids, action names `admin.mfa_reset_manual` / `user.email_verified_manual` in the audit registry) — exercised on a real stack in the Task 11 review fix. | Fail-closed + runbook | Batch 8 register: founder specifies proofing requirements before any admin-assisted UI ships. |
| A4 | **Seller Rules legal text not yet written/reviewed** (Batch 8 deliverable). Batch 2 ships the acceptance-*recording* mechanism against `seller_rules`/`v1` with the §6.2-neutral placeholder summary, explicitly marked pending Batch 8 legal review; no guarantee language anywhere. | Mechanism shipped + tested | **Blocks beta invites** until the founder reviews the text and decides whether `v1` stands or bumps (a bump forces re-acceptance through the existing mechanism); Batch 8. |
| — | **PROVISIONAL decision×reason-code compatibility map** (spec/plan silent; FD-3 fail-closed default): `verified` ← `requirements_met`, `other_reviewed_reason`; `needs_review` ← `duplicate_account_risk`, `identity_information_inconsistent`, `business_claim_needs_evidence`, `abuse_case_unresolved`, `manual_risk_review`, `other_reviewed_reason`; `rejected`/`revoked` ← the terminal-negative set. Incompatible pairs throw `REASON_CODE_INCOMPATIBLE`; `migrated_legacy_verified` rejected from every human decision (backfill-only). UX follow-up: per-decision option filtering in the admin select (currently the typed error surfaces). | Applied + tested | Batch 8 register: founder ratifies or amends the map. |
| — | **needs_review semantics** (Task 10 review fix M1): `needs_review` is a real decision claimable from `pending`; final decisions claim from `pending` **or** `needs_review`; re-marking needs_review→needs_review blocked (`VERIFICATION_ALREADY_REVIEWED`); seller notification for needs_review states it is a decision requiring follow-up. | Applied + tested (unit + real DB) | Batch 8 register. |
| — | **Public verified badge now reads the workflow** (`seller-verification-status.ts`, §6.2-exact label) — `app/listings/[slug]`, `app/seller/[id]`, `app/profile` no longer read the frozen legacy boolean; revoked/pending sellers lose the badge, newly verified sellers gain it. | Applied + tested | — (closes a pre-existing §4.2/§8.2 issue). |

### 7.4 Deferred items (pointers)

- **Batch 3** — moderation/report/block/appeals (also blocked on A2 cells); unpublishing
  revoked sellers' live listings (R6).
- **Batch 4** — listing states/drafts/category allowlist/photo checklist; browser E2E for
  Batch 4/6 critical flows when the repo gains an E2E runner.
- **Batch 7** — cohort operations: invitation flow, founding-seller console, concierge;
  `BetaCohortMembership.acceptedAt` belongs to the invitation-acceptance flow (the admin
  grant sets `invitedBy`/`invitedAt` only).
- **Batch 8** — Seller Rules legal text review (A4); the Founder Decision Register
  (§7.2/§7.3 hand-offs); launch prerequisites (A1 provider).
- Also deferred from the plan: admin-assisted out-of-band recovery UI (A3), PII export
  (`pii.export` granted to no one), account deletion (identifier reuse enforced as
  "unique among active accounts" until a deletion surface ships).

---

## 8. Runbook exercise result (green)

`tests/integration/admin-bootstrap.test.ts` (real DB, part of gate 9's 50/50) walks the
runbook loop: promote dry-run → `--apply` (adminRole + `role="admin"` + revoke-all-sessions
`admin_role_changed` + audit actor null) → idempotent → **last-super-admin guard** (incl.
the Task 1 migration's backfill predicate on a legacy `role="admin"` row) → mfa-enroll
(encrypted secret `v1:<keyId>:…` + 10 hashes, second enroll → null) → login without code
(`mfaRequired`, no session) → TOTP login (`isAdmin: true`, 12h TTL) → recovery-code login
(marked used + audited) → reuse fails → **mfa-reset** (deletes MFA + cascades + revokes
sessions + audits) → password-only login blocked `MFA_ENROLLMENT_REQUIRED` → re-enroll →
TOTP login OK — **lockout → recovery loop closed**. The Task 11 review fix additionally
exercised the **production §0 wrapper on a real throwaway compose stack** (build migrate →
run → promote/enroll/reset with `--confirm-db` guards → audit trail → `down -v`) and the
D2 cross-demote race (row-lock + WHERE re-eval: exactly one of two parallel demotes wins)
plus D3 transactional+audited manual SQL (abort path included). Commands:
`docs/operations/admin-bootstrap-recovery-runbook.md` (§0–§8).

---

## 9. Browser E2E — explicitly deferred

The repo has **no E2E infrastructure**; Batch 2's critical flows are covered by
action-level unit tests plus real-DB integration tests (the ten gate suites in §2 —
including the four publication-gate transitions, the recovery/revoke-all loop, and the
exercised bootstrap runbook). Spec §10's E2E line is honored when the repo gains an E2E
runner — tracked for Batch 4/6 critical flows. CSRF posture (spec §10.1 row): Next.js 16
server actions are POST-only with built-in origin protection; no custom token layer added
(matches repo posture).

---

## 10. Verdict

| Acceptance-gate bullet | Status |
|---|---|
| Authorization matrix tests | ✅ 23/23 |
| OTP abuse tests (incl. no plaintext in any log path, any environment) | ✅ 32/32 |
| Identity-collision tests | ✅ 44 unit + integration green |
| Recovery abuse tests | ✅ 31/31 |
| Session invalidation tests | ✅ 28/28 + integration |
| Seller publication-gate tests (4 surfaces) | ✅ 41/41 + integration |
| MFA tests (RFC vectors, encrypted at rest, dedicated key, no SMS factor) | ✅ 98/98 + integration |
| Admin step-up tests | ✅ 101/101 |
| Backend enforcement (source scan) | ✅ §3 — zero authorization reads of `role`/`isVerifiedSeller`; every admin page/action guarded |
| Admin bootstrap/recovery runbook exercised | ✅ §8 |
| Batch 1 preserved (finance shutdown + additive migration) | ✅ all finance suites green; `FINANCIAL_FEATURES_ENABLED=false` everywhere; 0 destructive ops |
| Gate scope explicit (A1 verbatim) | ✅ §7.3 |
| Preflight (7 gates), integration suite, `npm audit` (new dep clean) | ✅ §4 |
| **Safe smoke** | ❌ **FAIL — §5 blocker** |
| Diff/status audit clean | ✅ §6 |

**GATE FAIL — one blocker (`npm run smoke`, §5).** All other acceptance bullets pass.
Batch 2 is **not accepted** until the smoke harness env is fixed (one line in
`scripts/smoke.sh`, follow-up commit) and `npm run smoke` re-runs green; this document must
then be amended with the re-run result. Nothing in this task changed product code: the only
commit is this document.
