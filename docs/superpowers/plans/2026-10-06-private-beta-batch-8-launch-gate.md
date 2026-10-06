# Private Beta Batch 8 — Operational, Legal, Security Launch Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finalize the private-beta launch gate — the versioned policy publishing mechanism with a review-record that **blocks release while any policy is unreviewed** (the founder authors every legal text; the implementer authors none, spec §4.11), the operations/incident playbooks, monitoring + alerts on the existing observability seam (health, error rate, auth abuse, **finance-boundary violation**, cron/backup — no third-party SaaS), the scripted backup + restore drill with recorded evidence, the admin access review with sign-off, the consolidated security review (spec §10.1 abuse matrix → concrete tests across Batches 2–7 + gap-fills, dependency audit, §7.4 headers, secrets/env, §7.1 rate-limit inventory, the known Batch 2 residual risks), and the machine-checkable private-beta release checklist mapping every §12 criterion and §9 Batch 8 gate item to evidence — **verifying and finalizing Batches 1–7, never re-implementing them.**

**Architecture:** Docs + scripts + tests only — **no Prisma migration, no schema change** (G2). The policy registry is a server-owned plain TS module (`src/lib/policy-registry.ts`) binding each of the six spec §3.1 policies to a key/version/**status**/content-hash — the hash covers `POLICY_TEXT` only (the content modules carry no status); content lives in placeholder modules clearly marked `DRAFT-NOT-REVIEWED` (founder-authored text replaces them — FD-3); a public route family `app/policies/[key]` renders the versioned pages with a visible draft banner; `docs/operations/policy-review-record.md` is the sign-off record (who, date, version, sha256, **Decision == APPROVED**) that `scripts/release-gate.sh` verifies via `scripts/policy-hash.ts --check`. Policy *acceptance* is not rebuilt — Batch 2's `PolicyAcceptance(userId, policyKey, policyVersion)` is the recording mechanism and the registry's keys/versions must match its constants (the Seller-Rules version tension is FD-R4). Monitoring is a cron-driven offline script (`scripts/ops-alerts.ts`) over what exists: `/api/health`, the `captureError`/`captureEvent` JSON log lines, `AuditEvent`/`OtpCode` counts, a **`pg_stat_user_tables` tuple-delta watermark** over the finance tables (any insert/update/delete delta while `FINANCIAL_FEATURES_ENABLED=false` — read from the deployed app container's env, not the host — is a CRITICAL boundary-violation alert; the stat counters catch status UPDATEs, DELETEs, and raw SQL that `createdAt`/`updatedAt` watermarks miss, with no schema change), and backup freshness — counts and scopes only, never PII. **No host pg tools, no published port:** the production db publishes nothing (`docker-compose.prod.yml`), so every script's DB reach goes through the `scripts/db-ops.sh` container-on-network pattern (ops/runtime-readiness `de0240f`) — a throwaway `postgres:16-alpine` client container attached to the target db's network, or `docker exec loaviet-db psql` for the read-only query scripts. The restore drill (`scripts/restore-drill.sh`) drives `backup-db.sh`/`restore-db.sh` **inside** that container pattern against a scratch stack and appends dated evidence. The admin access review (`scripts/admin-access-review.ts`) enumerates `adminRole` holders, MFA enrollment, unused recovery-code counts, and session inventory — ids and states only. Browser-security headers ship per the Next 16 "Without Nonces" CSP policy as **`Content-Security-Policy-Report-Only` first** (enforced after a `docker:smoke` + manual page-load check — a release-checklist row), with the app-wide source regex **excluding `/uploads`** so Batch 4's stricter `/uploads` block is never overridden (Next `headers()`: last matching entry wins a repeated key). The security review doc maps all 29 §10.1 rows to named tests; `tests/unit/abuse-matrix.test.ts` makes that mapping machine-checked (keyed titles, not just file existence). `scripts/release-gate.sh` is the launch gate: preflight + integration + smoke + `npm audit` + policy review records (**Decision == APPROVED** + hash match) + evidence files + the release checklist **including its Founder Decision Register mirror** (every Blocking=YES register row needs a dated founder decision) — non-zero exit on any missing evidence, `grep`-based (no `rg` dependency on the server).

**Tech Stack:** Next.js 16.3.7 App Router (typed routes, server components), React 19, TypeScript strict, Vitest, bash + `pg_dump`/`pg_restore`/`psql` (existing `scripts/backup-db.sh`/`restore-db.sh`/`test-integration.sh` patterns), `tsx` for offline TS scripts (Batch 2 `admin-bootstrap.ts` precedent — plain modules only), `node:crypto` (sha256 policy content hashes). **No new runtime dependency** (Batch 8 adds zero npm packages).

**Spec:** `docs/superpowers/specs/2026-10-06-private-beta-marketplace-reset-design.md` — Batch 8 is spec §9 "Batch 8", built on §2.1 (public visitor may read public safety guidance), §3.1 (legal/policy readiness scope), §4 (all invariants — esp. §4.2 No Misleading Promise, §4.6 Auditability, §4.8 Analytics Privacy, §4.11 Policy Non-Invention), §5.1.1 (offline maintenance command posture), §5.4.2 (admin bootstrap/recovery documented and tested), §5.5.1 (evidence lifecycle — incident evidence preservation), §5.10.1 (concierge onboarding responsibility split), §6.2 (seller-verification copy), §6.4 (independent transaction safety guidance), §7 (all security/abuse controls — §7.1 rate limits, §7.4 browser security, §7.6 admin security), §9 Batch 8 deliverables + Gate, §10 + §10.1 (verification + Required Security Abuse Matrix), §11 + §11.1 (execution protocol + ambiguity stop rule), §12 + §12.1 + §12.2 + §12.3 (Private-Beta Readiness Criteria + Supply Readiness Gate), §14 (product decision principles), §15 (what not to do), §16 (strategic summary), §17 (final implementation rule). §13 (post-beta expansion gates) is **out of scope**. The plan argues from the spec; executors read both.

**Builds on (consumed verbatim; never redefined):** the merged Batches 2–7 — Batch 2 (`PolicyAcceptance`, `SELLER_RULES_POLICY_KEY`/`SELLER_RULES_POLICY_VERSION`, `AuditEvent` + `auditEvent` registry, `AdminMfa`/`AdminRecoveryCode`, `UserSession`, `OtpCode`, `admin-bootstrap.ts` + `docs/operations/admin-bootstrap-recovery-runbook.md`, `rbac.ts`, `env.ts` validation), Batch 3 (`ModerationCase`/`ModerationEvidence`/`ModerationAction`, `UserSuspension`, moderation vocabularies, the audit-append source-contract pattern), Batch 4 (`BETA_PUBLICATION_CATEGORIES`, `ListingImageUpload`, the pending-model catalog seed, `/uploads` headers in `next.config.ts`), Batch 5 (`ProductEvent`/`emitProductEvent`, `src/lib/provinces.ts` per FD-1, the PII-guard source-scan pattern), Batch 6 (`Deal`/`DealStatusHistory`, `safety-guidance.tsx` §6.4 copy), Batch 7 (`FoundingSellerCandidate`/`BetaInviteToken`, the console, `src/lib/beta-access.ts`). Batch 8 executes **after** their gates pass (G1) and consumes their shipped interfaces read-only (G4).

## Global Constraints

- Read `AGENTS.md` and the relevant Next.js 16 docs before editing app code. At minimum (paths as used by the Batch 0–7 plans): `node_modules/next/dist/docs/01-app/02-guides/server-actions.md`, `.../01-app/01-getting-started/15-route-handlers.md`, `.../01-app/02-guides/environment-variables.md`, `.../01-app/02-guides/redirecting.md`, `.../01-app/02-guides/testing/vitest.md`, plus the current `cookies()`/`headers()`/`generateStaticParams` API-reference guides under `node_modules/next/dist/docs/`. Heed deprecation notices; this is not the Next.js from training data.
- **Quote bracketed paths in every `git add`** — zsh globs `[id]`/`[slug]`/`[key]` as a character class and drops the file from the command (Batch 3/5/7 constraint, kept verbatim). Every `git add` below already quotes them (`'app/policies/[key]/page.tsx'`); keep that form in every commit.
- **No legal/policy text is authored by the implementer (spec §4.11 + §11.1).** The six policy content modules ship as placeholders whose entire body is a `DRAFT-NOT-REVIEWED` banner plus `[nội dung chờ founder]` markers — no section skeletons, no summary clauses, no acceptance semantics, no retention numbers, no sanction taxonomy. The only spec-*sourced* text allowed in a placeholder is the Safety Guidance page's §6.4 six points + the §5.2 line (verbatim from the spec, already shipped in Batch 6's `safety-guidance.tsx`) — everything else is founder-authored (FD-3). Material ambiguity about policy semantics → record it, ship the placeholder, stop the affected content step.
- **No Prisma migration, no schema change (G2).** Batch 8 adds no table, column, enum value, or data transform. `npx prisma migration list` must show the identical graph before and after the batch. If any task discovers it needs a schema change (e.g. a durable TOTP-consumed column, a partial unique index on verified phone), that is a **finding recorded in the security review + the Residual Risk Register**, and a *new* reviewed plan — never a Batch 8 commit.
- **Preserve Batches 1–7.** `FINANCIAL_FEATURES_ENABLED` stays `false`; every finance guard and its tests (`tests/unit/financial-shutdown-*.test.ts`, `tests/unit/finance-public-surface.test.ts`, `tests/unit/admin-finance-readonly.test.ts`, `tests/integration/escrow.test.ts`) and every Batch 2–7 suite named in those plans' Final Acceptance Commands must stay green unchanged. No Batch 8 task may enable, bypass, or weaken any finance, identity, moderation, publication, search, telemetry, chat/Deal, or cohort boundary. Batch 8 **verifies** those boundaries (the §10.1 matrix, the release gate) — it must not re-implement or duplicate them (G5).
- **Read-only consumption (G4).** `src/lib/rbac.ts`, `session.ts`, `otp.ts`, `audit-event.ts`, `seller-verification-policy.ts`, `product-events.ts`, `telemetry-recorders.ts`, `metrics.ts`, `provinces.ts`, `moderation*.ts`, `deal*.ts`, `founding-seller*.ts`, `beta-access.ts`, `beta-categories.ts`, `financial-features.ts`, `rate-limit.ts`, `observability.ts`, `env.ts` — consumed read-only; **never edited in a Batch 8 commit.** The only app-code files Batch 8 touches: `src/lib/policy-registry.ts` + `src/content/policies/*` + `app/policies/[key]/page.tsx` + `src/components/footer.tsx` (Task 1, new), `next.config.ts` (Task 8, headers gap-fill only — Batch 4's `/uploads` block untouched), `package.json` (Task 9, one script entry).
- **Offline maintenance command posture (spec §5.1.1) + DB reach (no host pg tools, no published port).** `scripts/ops-alerts.ts`, `scripts/admin-access-review.ts`, `scripts/policy-hash.ts` are offline commands: not exposed via HTTP/admin UI, print no secrets, and (where mutation is possible) default to dry-run with an explicit `--apply`. **The production db publishes no port** (`docker-compose.prod.yml` — only app/migrate reach it on the compose network), so a host-run script cannot connect to it: every DB-touching script reaches the database through the **`scripts/db-ops.sh` container-on-network pattern** (ops/runtime-readiness `de0240f` — a throwaway `postgres:16-alpine` client container attached to the target db container's network, `PGPASSWORD` from `.env`) or, for the read-only query scripts, `docker exec loaviet-db psql` invoked from the script's thin IO layer. The restore drill applies the same pattern against its **scratch** stack (client tools are the same `postgres:16-alpine` image as the server — version parity by construction, no host `pg_dump` version preflight). Batch 8 **must not re-fix** the backup/restore docs — `docs/backup-restore.md`, `docs/deployment.md`, `docs/runbook.md` already use `db-ops.sh` and a DB-rename cutover; Batch 8 only references them.
- **Scripts import only plain modules.** `scripts/ops-alerts.ts` and `scripts/admin-access-review.ts` must **not** import `server-only`-importing modules (`src/lib/otp.ts`, `src/lib/financial-features.ts`, `src/lib/env.ts`, `src/lib/observability.ts` — plain-node `tsx` cannot load them): constants they need (the finance-table list, `OTP_MAX_ATTEMPTS`, threshold defaults) are **duplicated locally with a drift test** — `tests/unit/ops-alerts.test.ts` asserts the script's `FINANCE_TABLES` list ⊆ the models in `src/prisma/contract.prisma` (and names the key finance models) so a contract change fails the test. `FINANCIAL_FEATURES_ENABLED` is **read from the deployed app config, not the host env**: `docker exec loaviet-app printenv FINANCIAL_FEATURES_ENABLED` (the running app container's compose-set value) — the host `.env` may differ from what the stack actually runs.
- **Browser-security headers (spec §7.4) — CSP override + Report-Only.** Next `headers()`: when two entries match a path and set the same key, **the last one wins** — so the app-wide entry's source regex **excludes `/uploads`** (`"/((?!uploads/).*)"`), leaving Batch 4's `/uploads/:path*` block (`nosniff` + CSP `default-src 'none'; sandbox`) the only CSP on upload paths. The app-wide CSP follows the Next 16 docs' **"Without Nonces"** policy (nonce-based CSP needs `proxy.ts` + dynamic rendering — outside G3, and `/policies/[key]` is static): `script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: https://res.cloudinary.com` (matches `next.config.ts` `images.remotePatterns`); `worker-src 'self'` (`public/sw.js` via `src/components/sw-register.tsx`); `connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'self'; object-src 'none'` — plus `X-Content-Type-Options: nosniff`, `Strict-Transport-Security: max-age=15552000; includeSubDomains` (no `preload` — that is a founder decision), `X-Frame-Options: DENY`. The CSP ships as **`Content-Security-Policy-Report-Only` first**; enforcement (the one-line header-name flip) happens only after `npm run docker:smoke` + a manual page-load check on the deployed stack, recorded as a release-checklist row. `tests/unit/security-headers.test.ts` verifies the **EFFECTIVE** headers per path by iterating the `headers()` output (last-match-wins), not just source presence.
- **The release gate parses the Founder Decision Register mirror (not just the §12/§9 rows).** `docs/operations/private-beta-release-checklist.md` carries a **register-mirror section**: one row per **Blocking=YES** register item (`| FD | Item | Decision (founder) | Date |`), generated from the register and kept in sync by `tests/unit/release-gate-checklist.test.ts` (which parses the plan's register table and asserts the mirror contains exactly the blocking IDs — counts are **derived mechanically**, never hardcoded). The gate requires a dated founder decision on every mirror row; the security-review findings parse uses a **fixed case-insensitive table format** and **fails when the section is absent** (a missing findings register must not pass silently).
- **No PII in alerts or ops output (spec §4.8 + §7.6).** `ops-alerts` emits counts, scopes, and typed codes — never user ids, emails, phones, IPs, OTP codes, tokens, or message content. `admin-access-review` emits internal user ids, roles, and *states* (MFA enrolled y/n, unused recovery-code **count**, session **count**) — never raw emails (the operator correlates ids via the admin UI), never TOTP secrets, never recovery-code values. Alert lines pass the same redaction discipline as `AuditEvent.detail`.
- **Monitoring uses what exists (no third-party SaaS).** The spec mandates no monitoring vendor; Batch 8 builds on `src/lib/observability.ts` (JSON log lines), `docker compose logs`, cron, `/api/health`, and DB queries. Every threshold the spec does not number is a **named founder-decision item** (Founder Decision Register) shipped as a clearly-marked proposed default in a constants block — never presented as spec policy. The alert *delivery channel* (email/Telegram/etc.) is a deploy-time decision; the script emits structured alert lines to stdout/log and exits non-zero on CRITICAL.
- **Copy-safety (spec §4.2 + §4.7).** No Batch 8 surface (policy pages, playbooks that quote user-facing copy, footer) may contain affirmative guarantee/escrow/payment-protection/insurance language or location-safety claims. The consolidated scan (Task 2) is the permanent gate; the known negation lines ("LoaViet không giữ tiền và không bảo đảm giao dịch") are allowlisted as exact strings.
- **Test-first for every behavior change** (Tasks 1, 2, 5, 7, 8, 9): add the failing test, confirm the expected failure, implement the minimum, rerun the focused test. Contract/source-scan tests that pass immediately are acceptable — record which cases passed on first run (Batch 4 Task 8 precedent). Docs tasks (3, 4, 6, and the doc parts of 7–9) get factual-accuracy verification steps instead: every file path, action name, capability name, and audit name quoted in a playbook must be cross-checked against the merged batch source — a playbook that references a surface that does not exist is a defect in the playbook.
- **Canonical test stubbing** (one recipe, every unit test that imports an action/page — Batch 3's canonical recipe): `vi.mock("server-only", () => ({}))`; `vi.mock("next/cache", () => ({ revalidatePath: () => {} }))`; `vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(\`NEXT_REDIRECT:${url}\`); }, notFound: () => { throw new Error("NEXT_HTTP_ERROR_FALLBACK;404") } }))`; `vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }) }))`. Unit tests mock `@/src/prisma/db.client` with in-memory model maps (the `tests/unit/financial-shutdown-actions.test.ts` style); integration tests keep the real db (`hasDb` guard, `scripts/test-integration.sh`).
- OpenCode must not push, merge, deploy, or destructively clean the repository. Commit each task separately with the listed message; never `git add .`. Exclude from commits: `.claude/settings.json`, `public/uploads/`, `backups/`, secrets, local scratch data, drill output pasted into evidence files is fine but no dump files, unrelated work.
- **Browser E2E:** the repo still has no E2E infrastructure (recorded since Batch 2). Batch 8 does not add any; the release checklist records the posture (critical flows covered by action-level unit + real-DB integration tests) as a tracked pre-invite item the founder signs off (spec §10, §12).

## Batch 8 Sequencing Rules

*Equivalent of `/tmp/loaviet/b34-reconcile.md` (R1–R9), `/tmp/loaviet/b5-seq.md` (S1–S11), and Batch 7's T1–T7; adopted by this plan:*

- **G1 Order:** Batch 8 executes only on the merged Batch 7 commit, after the Batch 2 → 3 → 4 → 5 → 6 → 7 gates pass in order (spec §9: "Do not advance to the next batch until the current gate passes"). Parallel planning ok; parallel execution not. The register below is built from the **committed** revisions — Batch 3 @ `68f8778`, Batch 4 @ `c7ca1dc`, Batch 5 @ `6cf60c8`, Batch 6 @ `88d7c2d`, Batch 7 @ `581a114` (A1–A7, D1–D4, and the S9 provisional hand-off set) — re-verify against the merged versions before execution and append any post-revision ambiguity before the gate runs.
- **G2 No migration:** Batch 8 adds no Prisma migration, no contract change, no enum value, no column, no data transform. `npx prisma migration list` shows `baseline → batch2 → batch3 → batch4 → batch5 → batch6 → batch7` before **and** after Batch 8; `npx prisma db verify` clean. A discovered schema need → record as a finding + new plan (Global Constraints).
- **G3 Code-change perimeter:** the only app-code changes are (a) Task 1's policy registry + content modules + `app/policies/[key]` + footer links, (b) Task 8's `next.config.ts` app-wide §7.4 headers (the gap is known: no app-wide headers exist today — the audit confirms and the Report-Only CSP + `nosniff`/HSTS/frame headers ship; Batch 4's `/uploads` and Batch 7's `/invite` blocks never edited), (c) Task 9's `package.json` `"release:gate"` script entry, and (d) **the founder's Seller-Rules version bump** — `SELLER_RULES_POLICY_VERSION` `"v1"` → `"v2"` in `src/lib/seller-verification-policy.ts`, the one G4 read-only-module exception, made **in the founder's policy-review commit** with the publication-gate/acceptance tests updated in the same commit (FD-R4 — see Task 1 Step 4). Everything else is `docs/`, `scripts/`, `tests/`. Any other `src/`/`app/` edit → out of scope: record it and stop that step (§11.1).
- **G4 File order:** `src/components/footer.tsx` — Task 1 only. `next.config.ts` — Batch 4 Task 3 (`/uploads` headers) → Batch 7 Task 3 (`/invite` `Referrer-Policy: no-referrer`) → **Batch 8 Task 8** (app-wide §7.4 headers with `/uploads` excluded from the source regex; the Batch 4/7 blocks never edited). `package.json` — Task 9 only. Every Batch 2–7 lib module (Global Constraints list) — consumed read-only, never edited in a Batch 8 commit, **except** the FD-R4 `SELLER_RULES_POLICY_VERSION` bump (G3(d)). `src/lib/provinces.ts` is Batch 2 Task 10's FD-1 registry — consumed read-only. `docs/operations/admin-bootstrap-recovery-runbook.md` (Batch 2) — referenced from Batch 8 playbooks, never modified. `scripts/db-ops.sh` + `backup-db.sh`/`restore-db.sh` (ops/runtime-readiness `de0240f`) — consumed as shipped, never edited in a Batch 8 commit.
- **G5 Verification, not re-implementation:** every §10.1 abuse-matrix row maps to an *existing* test shipped by Batches 1–7 (the Threat-Case Coverage Map names them). Batch 8 adds only gap-fill tests: `policy-registry`, `copy-safety`, `ops-alerts`, `admin-access-review`, `security-headers`, `chat-surface-xss`, `abuse-matrix`, `release-gate-checklist`, and the release-gate script. If a mapped test is missing at execution time (a batch deviated from its plan), that is a **finding**: record it in the security review, fix it in the owning module with its own test in a focused commit — never a Batch 8 re-implementation of another batch's domain.
- **G6 Evidence files:** Batch 8's recorded evidence (`policy-review-record.md`, `restore-drill-evidence.md`, `admin-access-review.md` (dated sections), `private-beta-security-review.md`, `private-beta-release-checklist.md` (incl. the FD register mirror), the batch verification docs) lives in `docs/operations/` as git-versioned markdown the release gate parses. Nothing runtime-generated (dumps, scratch DBs, alert state) is committed; operators paste dated, redacted output into the evidence files.
- **G7 Standing founder rulings (from `/tmp/loaviet/founder-decisions.md`, 2026-10-06):** **FD-1** — the province registry is the 34 units per NQ 202/2025/QH15 (`/tmp/loaviet/provinces-34.md`); the obsolete 63-province `PROVINCE_CODES` must be replaced (Batch 4 A9 / Batch 5 A9 RESOLVED — Batch 8 verifies the fix landed, RR-5). **FD-2** — the production OTP email/SMS provider is DEFERRED; it stays a beta-launch prerequisite carried in the Batch 8 Founder Decision Register (implementation proceeds with the fail-closed production adapter). **FD-3** — all other recorded ambiguities across Batches 2–8: PROCEED on the safe/fail-closed default each plan already chose; items needing founder-AUTHORED CONTENT (legal/policy text, condition-grade definitions, model seed list, alias content, metric window values, sanction taxonomy) ship as clearly-marked placeholders/pending mechanisms and are listed in the Batch 8 Founder Decision Register as launch blockers — never invented.
- **G8 Fallback if Batch 8 must land before Batch 7:** only **Tasks 1, 5, 6, 7** are Batch-7-independent (their surfaces don't reference Batch 7 code). Task 2's scan covers Batch 7's invite pages (re-run after merge), Task 3's playbooks reference the Batch 7 console/invite/cookie flow, Task 8's matrix cites Batch 7's test files (`beta-access`, `chat-beta-gate`, `deal-beta-gate`, `founding-seller-*`, `suspended-membership-enforcement`), and Tasks 9–10 reference Batch 7 evidence — those tasks rebase onto the merged Batch 7 commit. Record the split in the verification doc. (Unlikely — G1 is the default.)

## Batch 8 Scope Decisions

In scope (spec §9 Batch 8 deliverables, each mapped to its task):

1. **Terms / Privacy / Marketplace Rules / Seller Rules / Community Rules / Safety Guidance — the publishing mechanism only** (Task 1): versioned public policy pages, a server-owned registry binding key + version + **status** + content hash (**over `POLICY_TEXT` only** — status lives in the registry), placeholders clearly marked `DRAFT-NOT-REVIEWED`, a review/sign-off record template (who, date, version, sha256, **Decision == APPROVED**), and a test + release-gate check that **release is blocked while any policy is unreviewed**. The legal text itself is founder-authored (FD-3; spec §4.11) — the implementer authors none of it.
2. **Policy-version recording** (Task 1): the registry's keys/versions align with Batch 2's `PolicyAcceptance` constants (`seller_rules`/`v1`); acceptance recording is reused, not rebuilt. **The first reviewed Seller Rules bumps the version** (`v1`→`v2` — FD-R4, the one allowed G4 edit, in the founder's review commit); a bump flows through the existing mechanism (re-acceptance) — Batch 8 ships no new acceptance surface.
3. **Copy-safety scans** (Task 2): a permanent, consolidated §4.2 (no guarantee/escrow/protection/payment-promise language in public copy) + §4.7 (no location-safety claims) scan test — the per-batch `rg` scans become one rerunnable gate.
4. **Operations playbooks** (Task 3): moderation, seller verification, concierge onboarding, account recovery (including the Batch 2 A3 manual fallback), the founding seller onboarding checklist, and the model seed review procedure (Batch 4's pending models). Admin MFA lockout is **referenced** from Batch 2's `admin-bootstrap-recovery-runbook.md`, not duplicated.
5. **Incident playbook** (Task 4): severity levels, communications, and evidence preservation per §5.5.1 (evidence survives source edits/deletes; no destructive cleanup during an investigation; `db-ops.sh backup` snapshots).
6. **Monitoring + alerts** (Task 5): health, error rate, auth abuse (the queryable `AuditEvent`/`OtpCode` counts — failed logins/MFA failures have no audit event, recorded as a finding), **finance-boundary violation** (any finance-table insert/update/delete while `FINANCIAL_FEATURES_ENABLED=false` — detected via **`pg_stat_user_tables` tuple-counter deltas**, which catch status UPDATEs, DELETEs, and raw SQL that timestamp watermarks miss; `FINANCIAL_FEATURES_ENABLED` read from the deployed app container), cron/backup failures — via `observability.ts`/logs/cron, **DB reach through the `db-ops.sh` container-on-network pattern / `docker exec loaviet-db psql`** (the production db publishes no port); exact signals specified, thresholds as founder-decision items, no PII.
7. **Backup + restore drill** (Task 6): a scripted drill against a scratch stack — **backup/restore run inside a throwaway `postgres:16-alpine` client container attached to the scratch network** (the `db-ops.sh` pattern; no host pg tools, version parity by construction), seeding via `tsx` + the ORM. RPO/RTO numbers: the spec gives none — the drill *measures* restore duration and backup freshness and records them; targets are a founder decision (Ambiguities). The backup docs are **referenced, never re-fixed** (ops/runtime-readiness `de0240f` already moved them to `db-ops.sh`).
8. **Admin access review** (Task 7): enumerate `adminRole` holders, MFA enrollment, recovery-code status, session inventory — recorded sign-off; DB reach as in item 6.
9. **Security review** (Task 8): the §10.1 abuse matrix → concrete tests across Batches 2–7 + gap-fills (the chat-surface XSS source contract; the CSRF posture doc section); dependency audit (`npm audit`, pinned deps); §7.4 headers — **the app-wide "Without Nonces" CSP ships Report-Only with `/uploads` excluded from the source regex** (last-match-wins), enforced after `docker:smoke` + a manual page-load (a release-checklist row); secrets/env review; §7.1 rate-limit inventory including the single-instance in-memory limiter limitation; the known Batch 2 residual risks (TOTP replay durable column, phone-verify race partial unique index, login-vs-reset race, PROVINCE_CODES 34-unit fix) **and the FD-R58 observations**.
10. **Private-beta release checklist** (Task 9): every §12 readiness criterion and §9 Batch 8 gate item mapped to evidence (test name, doc, sign-off) **plus the Founder Decision Register mirror** (one row per Blocking=YES register item, each requiring a dated founder decision), machine-checkable via `scripts/release-gate.sh` (`grep`-based, fixed-format findings parse, fails on missing evidence **and on unsigned blocking founder decisions**).

Explicitly deferred (do not build here): post-beta expansion gates (spec §13 — out of scope by the batch definition); buyer invitation campaigns (Batch 7 A4 — §12.1 founder approval); retention/erasure automation (FD register — legal review first); E2E infrastructure (tracked prerequisite); any third-party alerting/monitoring SaaS; legal text authoring; sanction taxonomy authoring; metric window values; the TOTP durable-consumed column and the verified-phone partial unique index (recorded findings, new plans); finance re-enable (its own reviewed design, §13/§17 evidence-driven).

## Founder Decision Register

Collected from **every** Ambiguity / recorded-decision / deferred item in the Batches 2–7 plans (and this batch's own), per the task contract. Standing rulings FD-1/FD-2/FD-3 (G7) are the founder's 2026-10-06 decisions; the register below is the launch-gate view of what remains. **Owner is the founder** for every row (the founder is the spec's decision owner); "Verified in" names where the release gate / security review checks it. Items marked **BLOCKING** must be resolved (or explicitly accepted with a dated sign-off in the release checklist) before the private-beta release gate passes — per FD-3 they never block *implementation*.

| # | Item | Source | Blocks launch? | Where recorded / verified |
|---|---|---|---|---|
| FD-R1 | Production OTP email/SMS provider behind `OtpDeliveryAdapter` (production email/phone verification + self-service recovery stay fail-closed until configured) | B2-A1 = FD-2 (deferred) | **YES** | `docs/operations/admin-bootstrap-recovery-runbook.md` prerequisite; release checklist row; ops-alerts cannot monitor delivery until it exists |
| FD-R2 | RBAC `Scoped`/`Exceptional + audited`/`Limited` cells: moderator/support `user.suspend`·`user.view_basic`·`session.revoke`·`audit.read`, moderator `seller.verification.revoke` + analytics, `pii.view_sensitive` (ops "Scoped + audited"), `pii.export` ("Explicit permission + step-up") | B2-A2 = B3-A1 = B7-A2 | **YES** (the capabilities; fail-closed defaults ship) | Security review RBAC inventory; moderation playbook (the moderator→ops_admin suspension hand-off); console renders masked contact only |
| FD-R3 | Out-of-band (admin-assisted) account recovery identity proofing requirements | B2-A3 | **YES** (the manual fallback needs founder acknowledgment) | Account-recovery playbook §manual fallback; release checklist sign-off |
| FD-R4 | Seller Rules legal text review **+ the version tension**: Batch 2 records `PolicyAcceptance(seller_rules, v1)` against the *placeholder* — the first reviewed text **must bump the version** (`v1`→`v2`: the one allowed edit to `SELLER_RULES_POLICY_VERSION` in the founder's review commit, publication-gate tests updated in the same commit — G3(d)); acceptances re-recorded through Batch 2's mechanism; pre-launch v1 acceptances exist only in dev/test (the release gate blocks launch while unreviewed) | B2-A4 + this batch (S2) | **YES** | `docs/operations/policy-review-record.md` (seller_rules row, Decision == APPROVED); release gate policy check; `tests/unit/policy-registry.test.ts` alignment case |
| FD-R5 | Step-up on **every** seller-verification decision (strictest reading of §5.4.2 "where configured") | B2-A5 (recorded decision) | no (reversible) | Security review; founder may relax by removing from `STEP_UP_CAPABILITIES` |
| FD-R6 | Moderation sanction policy: which sanction per violation, durations, escalation, auto-lift; suspended-user session revocation / login block (counterpart-suspension blocking of **new** chat is now resolved — Batch 6 D2's seller-side perimeter; the *existing-conversation message* question is FD-R53) | B3-A2 | **YES** (manual-only mechanisms ship) | Moderation playbook (manual sanctions, indefinite until lifted); release checklist sign-off |
| FD-R7 | Retention & deletion policy across **moderation evidence** (B3-A3), **product telemetry / `ProductEvent`** (B5-A6), and **Deal / `DealStatusHistory`** (B6-A7) — reviewed separately from ordinary user-content deletion; covers the account-deletion interaction (FD-R45) | B3-A3 = B5-A6 = B6-A7 | **YES** (legal) | Security review; Privacy policy review record; incident playbook evidence section |
| FD-R8 | Appeal decision workflow: reviewer, outcomes, timelines, re-appeal **+ listing restore** (the only un-`remove` path) **+ the notification gap** (a case actioned without a linked sanction sends no appeal-link notification — the subject never learns they can appeal) | B3-A4 (revised `68f8778`) | **YES** (manual intake ships) | Moderation playbook §appeals; release checklist |
| FD-R9 | Case priority/triage SLA semantics (`low|normal|high` exist as data) | B3-A5 | no | Moderation playbook (priority field documented, no SLA invented) |
| FD-R10 | Suspending admin accounts via moderation refused (admin lockout = bootstrap runbook domain) | B3-A6 (recorded) | no | Moderation playbook; security review |
| FD-R11 | Moderator conflict-of-interest / recusal policy (deny ships fail-closed) | B3-A7 | **YES** (acknowledge the fail-closed default) | Moderation playbook §recusal; release checklist |
| FD-R12 | The sanction-taxonomy reason vocabularies (`SUSPENSION_REASON_CODES`, `MODERATION_DECISION_REASON_CODES`, `MODERATION_ASSIGNMENT_REASON_CODES`) — **founder-authored content per FD-3: launch blocker**; the constants/labels carry visible `PROVISIONAL (A8)` markers until acknowledged | B3-A8 (revised `68f8778`) | **YES** (founder-authored content) | Moderation playbook lists the vocabularies; security review; release checklist FD mirror |
| FD-R13 | `user.suspend` step-up interpretation ("destructive account action") | B3-A9 (recorded) | no | Security review |
| FD-R14 | Condition-grade user-facing definitions + `product_condition` vs `inventoryContext` (`new`/`open_box`) overlap | B4-A1 | **YES** (content) | Release checklist (listing quality); model-seed review procedure |
| FD-R15 | Photo-checklist requiredness per slot/condition (all 8 ship as guidance; ≥1 image rule only) | B4-A2 | **YES** (policy) | Release checklist |
| FD-R16 | Canonical model list — founder supplies + approves via `/admin/catalog` (implementer never authors one) | B4-A3 | **YES** (ops data) | Model-seed review procedure; release checklist (§12.1 core model coverage) |
| FD-R17 | Orphaned upload retention/expiry (files stay publicly reachable until decided) | B4-A8 | **YES** (broader invites) | Security review; release checklist |
| FD-R18 | Legacy listing repurposing policy (interim: `rejected` legacy listings do not resubmit) | B4-A10 | no (interim fail-closed) | Security review |
| FD-R19 | Seed taxonomy: `loa-bluetooth` category deactivate/merge; `portable_bluetooth_speaker` slug convention | B4-A11 | no | Model-seed review procedure |
| FD-R20 | Attribution/response **window values** for `listing_to_chat_v1`, `seller_response_rate_v1`, `successful_match_rate_v1`, `repeat_user_rate_v1` (dashboard renders named pending states) | B5-A1 = B5-A3 | **YES** (the four rate values) | Release checklist (metrics readiness); dashboard pending states |
| FD-R21 | `successful_match` reconciliation rule for mismatched bilateral outcomes (mismatch stays recorded, unresolved) | B5-A2 = B6-A1 | **YES** (the rate + any resolution feature) | Security review (RR-13); release checklist |
| FD-R22 | Bot/automated-traffic exclusion rules (nothing excluded; recorded in every contract) | B5-A4 | no | Security review |
| FD-R23 | "Quality listing" definition — ops-set count only; **gates §12.1's "100–300 quality listings" readiness row** (Batch 4 A1/A2 vocabulary review is the prerequisite) | B5-A5 = B7-A3 (revised `581a114`) | **YES** (the §12.1 readiness gate) | Release checklist (§12.1 quality sampling); console; model-seed review procedure |
| FD-R24 | Alias catalog content (mechanism ships empty/founder-reviewed) | B5-A7 | **YES** (alias-driven search quality) | Model-seed review procedure (same review sitting) |
| FD-R25 | Commune-level registry (column reserved, unwritten) | B4-A4 = B5-A8 | no | Security review |
| FD-R26 | `cancelled` vs `no_deal` semantics + unilateral non-success marking (recorded reading) | B6-A4 | no | Security review |
| FD-R27 | The only beta `approved → sold` transition is the seller's explicit `markSold` choice on their own success marking (B6 D6 — bilateral completion alone never sells); a seller who sells outside a recorded Deal — or forgets to tick `markSold` (outcomes are immutable, B6 D3) — has **no self-serve sold path** until the founder decides (RR-23) | B6-A6/D6 (revised `88d7c2d`) | no (recorded) | Security review; release checklist |
| FD-R28 | §6.4/§5.2 safety copy legal review (product copy shipped; the policy document awaits review) | B6-A9 | **YES** (beta invites) | `policy-review-record.md` (safety_guidance row); copy-safety test |
| FD-R29 | Invitation delivery channel: no production email/SMS provider (FD-2 defers) — the operator's out-of-band workflow is the launch-ready path; **platform-delivered invitation (and fully self-serve invitation at beta scale) is blocked until a provider lands** | B7-A1 (revised `581a114`) | **YES** (FD-2) | Concierge playbook; cross-ref FD-R1; release checklist FD mirror |
| FD-R30 | Buyer cohort acquisition approval (§12.1: broader buyer invitations gated on supply readiness + explicit approval) | B7-A4 = §12.1 | **YES** (buyer invitations — the gate itself) | Release checklist §12.1 sign-off |
| FD-R31 | `inactive` candidate reactivation (pinned `inactive → exited` only) | B7-A5 | no | Security review |
| FD-R32 | `targetCommunity` semantics (any valid province; no restriction invented) | B7-A7 | no | Concierge playbook |
| FD-R33 | Buyer-side conversation gating default **ON** (`BETA_CHAT_REQUIRES_ACTIVE_MEMBERSHIP = true`, `BETA_CHAT_ALLOWED_COHORTS` incl. `internal`) — the §2.1 "if operations requires" reading that **decides whether any buyer can chat at launch**; flipping it off for a more open beta is a reviewed code change | B6-A2 resolved by B7-D3 (revised `581a114`) | **YES** (founder acknowledgment) | Security review; release checklist FD mirror; concierge playbook |
| FD-R34 | The six policy texts themselves (Terms, Privacy, Marketplace Rules, Seller Rules, Community Rules, Safety Guidance) — founder-authored, hash-recorded | FD-3 + this batch | **YES** — the central launch blocker | `policy-review-record.md`; `scripts/release-gate.sh` policy gate; `tests/unit/policy-registry.test.ts` |
| FD-R35 | Monitoring alert thresholds (auth abuse, error rate, backup freshness) — proposed defaults marked, founder tunes | B8-A2 | no | `docs/operations/monitoring-signals.md`; ops-alerts constants |
| FD-R36 | RPO/RTO targets (spec gives none; the drill measures and records) | B8-A3 | no | `docs/operations/restore-drill-evidence.md`; release checklist |
| FD-R37 | Alert delivery channel (log lines + non-zero exit ship; email/Telegram is deploy-time) | B8-A4 | no | Monitoring-signals doc |
| FD-R38 | Incident severity thresholds (proposed SEV1–3 defaults marked) | B8-A5 | no | Incident playbook |
| FD-R39 | `verification_blocked` as a distinct listing status (mapped onto `draft` + surfaced missing requirements; reversible by a later additive migration) | B4-A5 | no | Security review |
| FD-R40 | Draft retention/cleanup policy (drafts kept indefinitely, rate-limited, never public) | B4-A6 | no | Security review |
| FD-R41 | Fulfillment-method values mapped from spec §5.2 to the listing field (recorded mapping) | B4-A7 | no | Security review |
| FD-R42 | Deal dispute/refund/reputation semantics — **out of scope by policy** (no dispute path; no review/reputation eligibility from `Deal` in P0; §13.4 is post-beta) | B6-A3 | no (policy = do not build) | Security review; release checklist |
| FD-R43 | `agreedPrice` bound reuses the repo's real price bound **`100_000 … 2_000_000_000` VND** (`listings.ts` create validation — B6 D5); empty → null (no cash component recorded). No new pricing policy invented | B6-A5/D5 (revised `88d7c2d`) | no | Security review |
| FD-R44 | Notification delivery is in-app only (no email/push in P0) | B6-A8 | no | Security review |
| FD-R45 | Account deletion + identifier reuse after deletion (P0 enforces "unique among active accounts" only — there are no inactive accounts; a deletion surface is a later batch and must return through FD-R7 retention) | B2 deferred + B3-A3 | no (deferred surface) | Security review; Privacy policy review record |
| FD-R46 | Founding-seller invite TTL = 14 days (tunable constant, not env) | B7-D1 (recorded) | no | Concierge playbook |
| FD-R47 | "Seller needing assistance" = active-funnel candidate with `lastContactAt` null or older than 7 days (ops heuristic badge, explicitly not an SLA) | B7-D2 (recorded) | no | Concierge playbook |
| FD-R48 | The Batch 7 **S9 provisional set** — founder-authored/acknowledgment content per FD-3: the §5.10 transition table (`FOUNDING_SELLER_TRANSITIONS`), the reason-code vocabulary (`FOUNDING_SELLER_TRANSITION_REASONS`, PROVISIONAL-marked), the manually-settable state set, invite-only-for-`prospect`/`invited`, the rate values (`FOUNDING_SELLER_INVITE_RATE` 20/h/admin, `BETA_INVITE_ACCEPT_RATE` 10/10 min), the note/source caps, `BETA_CHAT_ALLOWED_COHORTS` incl. `internal`, `seller_registered`-emitted-at-acceptance, the verified-channel binding reading, and invite-acceptance-as-§8.4-"admin operation" | B7 S9 hand-off (`581a114`) | **YES** (founder-authored/acknowledgment content per FD-3) | Concierge + moderation playbooks; security review; release checklist FD mirror |
| FD-R49 | Invite **token-in-URL residual risk** — the one-time `/invite/<token>` GET lands in browser history/nginx access logs; contained by the HttpOnly `sp_invite` cookie flow + `Referrer-Policy: no-referrer` (RR-21) — founder acknowledgment of the contained risk | B7 S1/S9 (`581a114`) | no (residual risk — RR-21) | Security review; concierge playbook |
| FD-R50 | **Placeholder moderation copy** — the suspend/takedown notification wording, the appeal-page copy, and the reason labels ship as clearly-marked placeholders; founder-authored wording replaces them before beta | B3 FD-3 hand-off (`68f8778`) | **YES** (founder-authored content) | Moderation playbook; policy review record (community_rules/terms adjacency) |
| FD-R51 | Membership-suspension sanction semantics (specific to `founding_seller` membership): no unpublish, no session revoke, no message kill in existing conversations, no auto-expiry — distinct from the account-level FD-R6 | B7-A6 (revised `581a114`) | no (founder ruling pending) | Moderation playbook; security review |
| FD-R52 | Buyer gate is initiator-only; the seller side composes with Batch 6 D2's `assertListingSellerInteractable` (`SELLER_SUSPENDED`/`SELLER_NOT_VERIFIED`/`SELLER_MEMBERSHIP_INACTIVE`) — no second counterpart check | B7-D4 (revised `581a114`) | no | Security review |
| FD-R53 | §7.8 "message" vs the D2 perimeter: a revoked/suspended seller's **existing-conversation replies** are not blocked (only NEW chat/Deal creation is gated) — sanction-adjacent policy recorded for founder ruling alongside FD-R6 | B6-A10 (revised `88d7c2d`) | no (founder ruling pending) | Security review; moderation playbook |
| FD-R54 | Block-under-outcome reading: a blocked pair may still record `no_deal`/`cancelled` (blocking must not strand the outcome record) while `success` marking and Deal creation stay block-denied; suspension blocks every marking | B6-D10 (revised `88d7c2d`) | no (recorded reading) | Security review |
| FD-R55 | Batch 6 recorded readings (reversible): D1 approved-only new conversations; D2 the §7.8 seller-side perimeter (supersedes B3's counterpart reading for NEW chat); D3 per-party outcome immutability (`<role>:<outcome>` history prefix); D4 one open deal per `(listing, buyer)`; D5 the `agreedPrice` bound; D7 `DealStatusHistory` not `AuditEvent` for user actions; D8 chat-notify preview kept; D9 `Deal.listingId` nullable+`SetNull`, `conversationId` nullable no-FK, `DealStatusHistory.actorId` nullable+`SetNull`, `buyer/seller` `Restrict`; D11 buyer-only Deal creation; D12 eligibility-gated CTAs with neutral copy | B6 D1–D5, D7–D9, D11, D12 (`88d7c2d`) | no (recorded readings) | Security review |
| FD-R56 | Batch 5 recorded readings (reversible): D1 "valid search session" = one emitted `search_submitted` (filter/sort changes = new sessions); D2 "qualified listing view" = authenticated + non-internal + non-owner; D3 `search_to_chat_v1` = the unbounded click-chain; D4 `seller_response_rate_v1` eligibility/anchor = `conversation_buyer_first_message` — **plus** the B5-A5 rate denominators (`report rate`, `listing marked sold rate` — raw counts ship, no invented rate) | B5 D1–D4 + A5 (`6cf60c8`) | no (recorded readings) | Security review; dashboard pending states |
| FD-R57 | Batch 2 recorded mappings (reversible): legacy `role="admin"` → `adminRole: "super_admin"` (§8.5 intentional mapping); the admin-page capability mappings (e.g. `/admin/catalog` → `listing.moderate`, dormant finance pages → `requireAdminUser` read-only) | B2 Legacy Migration Decisions + Task 4 | no (recorded mappings) | Security review RBAC inventory |
| FD-R58 | Batch 2 Task 9 review observations: `session.revoke` has **no rank check** — operations_admin can revoke a super_admin's sessions; `regenerateRecoveryCodesAction` accepts a **recovery code** as its proof (`verifyAdminMfaCode` returns `"totp" \| "recovery_code"`) — a single leaked recovery code can regenerate 10 new ones. Both are accepted P0 posture, flagged for founder/security review | B2 Task 9 | no (security-review observations) | Security review findings register; admin access review |
| FD-R59 | **The §12 critical-E2E criteria** ("portable-speaker listing flow passes critical E2E"; "search→listing→chat loop passes critical E2E") — the repo has no E2E infrastructure (RR-14) and Batch 8 does not add any (S8 decision: a minimal Playwright suite is a new test subsystem deserving its own reviewed plan, outside the G3 perimeter and the no-new-dependency posture; coupling it to the launch-gate batch would mix two reviews). The founder must **either** explicitly accept the recorded posture (action-level unit + real-DB integration coverage, dated sign-off) **or** commission the minimal Playwright E2E batch for the two flows as a pre-invite prerequisite — the deviation is founder-owned, never implementer-waved | spec §12 + all batches' E2E deferral | **YES** (founder decision: accept the posture or fund the E2E batch) | Release checklist E2E rows + FD mirror; security review |

**Register size:** 59 rows — **25 blocking for launch** (FD-R1, R2, R3, R4, R6, R7, R8, R11, R12, R14, R15, R16, R17, R20, R21, R23, R24, R28, R29, R30, R33, R34, R48, R50, R59), 34 non-blocking recorded decisions/deferred items. **The counts are derived mechanically, never hardcoded elsewhere**: `tests/unit/release-gate-checklist.test.ts` parses this register table for the `**YES**` rows and asserts the release checklist's FD mirror contains exactly those IDs; the Task 10 verification doc records the count it derived at execution time. Every row is re-verified against the merged Batch 2–7 plans (G1) and any post-revision ambiguity is appended before the gate runs.

## Residual Risk Register

Collected from the Batches 2–7 plans' residual-risk and verification-doc sections. These are **accepted risks with compensating controls**, not open decisions (cross-referenced rows in the Founder Decision Register carry the decision). "Blocking for launch?" = must this be fixed before the release gate passes (no row below is a fix-blocker; the blocking *decisions* live in the FD register).

| # | Risk | Source | Compensating control | Blocking? | Where verified |
|---|---|---|---|---|---|
| RR-1 | In-memory rate limiter: single-instance only, restart resets buckets, CGNAT shared-IP buckets over-count | all batches (`src/lib/rate-limit.ts` header) | 1-instance compose deployment; nginx `limit_req`; documented; scaling requires a shared limiter (Redis/Postgres) | no | Security review §rate-limit inventory |
| RR-2 | **TOTP replay within the validity window** — no durable consumed-code column; a captured 6-digit code is reusable for ~30–90s | Batch 2 (MFA design) | 30s period ±1 window; step-up freshness 15 min; admin login + MFA-failure rate limits; recovery-code use audited; TLS-only transport | no (accepted; durable column = new plan) | Security review §admin MFA; FD-R2 adjacent |
| RR-3 | **Concurrent phone-verification race** — no partial unique index on verified phone; two accounts can race the tx re-check | Batch 2 Task 6 | tx re-check at verify; **ops duplicate-phone review query** in the seller-verification playbook (the actual SQL); single instance | no (accepted) | Seller-verification playbook; security review |
| RR-4 | **Login-vs-reset race** — an in-flight login with the old password could create a session after recovery's revocation sweep | Batch 2 Task 7 | recovery revokes *all* sessions at completion; old password invalid immediately after reset; short windows; audit trail | no (accepted) | Security review |
| RR-5 | **PROVINCE_CODES 63→34 unit fix** — the obsolete 63-province constant must have been replaced by `src/lib/provinces.ts` (34 units per FD-1/NQ 202/2025/QH15; the module legitimately exports a `PROVINCE_CODES` code→displayName map over the 34 slug codes — the scan is for the **obsolete 63-unit list**, e.g. legacy pre-2025 province names used as codes, not for the symbol name) | B4-A9 = B5-A9, RESOLVED by FD-1 | founder-approved source; drift tests in Batches 4/5 | no (resolved — **verification required**) | Security review data check: `src/lib/provinces.ts` exists with exactly 34 units; `rg "PROVINCE_CODES" src` hits classified (the 34-unit map is expected; any 63-unit remnant is a finding) |
| RR-6 | Session cutover logged out every user (JWT → DB sessions, one-time) | Batch 2 | accepted pre-launch; recorded in the Batch 2 verification doc | no (one-time, past) | Batch 2 verification doc |
| RR-7 | Report→case-grouping re-query window race (benign: the loser joins the winner's case) | Batch 3 | partial unique index on active cases; idempotent grouping | no | Security review |
| RR-8 | Orphaned upload files remain publicly reachable until a retention decision | B4-A8 → FD-R17 | `/uploads` served with `nosniff` + CSP `default-src 'none'; sandbox`; files needed by Batch 3 evidence snapshots | no (decision pending FD-R17) | Security review; release checklist |
| RR-9 | Dormant finance paths set `Listing.status = "approved"` without the publication gate (`orders.ts` order-completion, `admin.ts resolveDisputeAction`) | Batch 4 verification doc | unreachable while `FINANCIAL_FEATURES_ENABLED=false` (Batch 1 boundary + tests); defense-in-depth note for the finance re-enable review | no (while finance disabled) | Security review; finance-boundary watermark alert (Task 5) |
| RR-10 | Render-time telemetry double-count mitigated by `prefetch={false}` + a header guard — proxy header stripping must be re-verified per deploy | Batch 5 | the header-guard test; deploy checklist item | no | Security review deploy checklist |
| RR-11 | `PRODUCT_EVENT_PSEUDONYM_KEY` rotation breaks cross-version metric joins | Batch 5 | `pseudonymKeyVersion` per row makes it detectable; internal exclusion survives via `isInternal` | no | Security review |
| RR-12 | Dashboard full-scan scaling ceiling (loads every `ProductEvent` row per request) | Batch 5 | documented P0 shape; post-beta review | no | Security review |
| RR-13 | Mismatched bilateral Deal outcomes have no resolution path (recorded, never auto-resolved) | B6-A1 → FD-R21 | `DealStatusHistory` preserves both markings; no `successful_match` emitted on mismatch | no (decision pending FD-R21) | Security review |
| RR-14 | Browser E2E absent — critical flows covered by action-level unit + real-DB integration tests only | all batches | tracked pre-invite prerequisite; founder sign-off in the release checklist | no (tracked) | Release checklist (§12 E2E rows) |
| RR-15 | Admin MFA encryption-key rotation requires per-admin re-enrollment (no offline re-encrypt command; `v1:` envelope + `keyId` makes wrong-key a typed error) | Batch 2 runbook §5 | runbook procedure; re-enrollment is the safe P0 path | no | Security review; admin-bootstrap runbook |
| RR-16 | Suspension does not revoke sessions or block login (actor-side guards only) | B3-A2 = B7-A6 → FD-R6 | per-action guards read fresh from the DB; audit on suspend/lift | no (policy pending FD-R6) | Security review; moderation playbook |
| RR-17 | Suspended users keep live published listings (removal = moderator takedown decision) | B3 | takedown action + R5 locks; search shows live listings (B3 decision) | no | Moderation playbook |
| RR-18 | Counterpart-suspension/membership does not block messages in *existing* conversations (actor-side minimal set) | B3/6 D2, B7 D4 | new-interaction gates (new chat, Deal creation) enforce both sides; existing threads stay readable (evidence) | no | Security review |
| RR-19 | Dev OTP inbox route exists (`app/api/dev/otp-inbox`) — must stay dead in production | Batch 2 | 404 before any inbox access by construction; pinned by test | no | Security review route inventory (re-run the Batch 2 test) |
| RR-20 | Restart gives brute-force extra rate-limit budget (in-memory buckets reset) | Batch 2/B3 | accepted for MVP; nginx `limit_req` at the edge; single instance | no | Security review |
| RR-21 | **Invite token in URL** — the one-time `/invite/<token>` GET lands in browser history and nginx access logs before the cookie flow takes over | B7 S1 (`581a114`) | HttpOnly `sp_invite` cookie carries the token onward (the accept action reads only the cookie); `Referrer-Policy: no-referrer` on `/invite/*`; single-use atomic claim; 256-bit unguessable token | no (contained; FD-R49 acknowledgment) | Security review; concierge playbook |
| RR-22 | **Wishlist rows on non-approved listings** — the add is approved-only (B6 Task 3), but rows created earlier survive a listing's later transition (`sold`/`removed`/`hidden`) and may render in the wishlist until cleaned | B6 Task 3 | display-only surface; the wishlist view filters or renders read-only; no authorization impact (the listing page/action gates hold) | no (display behavior) | Security review |
| RR-23 | **Forgotten `markSold`** — a seller who completes a deal but does not tick `markSold` (outcomes are immutable, B6 D3) leaves the listing `approved` indefinitely; no auto-sold exists (D6) | B6 D6/A6 (`88d7c2d`) | listing age + `listing_marked_sold` vs `successful_match` counts are visible on the dashboard; ops follow-up via the founding-seller console | no (FD-R27 decision pending) | Security review; concierge playbook |

---

## Dependency and Parallelization Map

```text
(G1: Batches 2→3→4→5→6→7 đã merge + pass gate TRƯỚC khi Batch 8 bắt đầu — mọi task chạy trên commit Batch 7)
Task 1  policy registry + versioned pages + DRAFT block + review-record template
        ↓ (Task 2's scan covers src/content/policies — Task 1's files)
Task 2  consolidated copy-safety scan (§4.2/§4.7)
        ↓
        ├── Task 3  operations playbooks (moderation/seller-verification/concierge/   ┐
        │           recovery/founding-seller checklist/model-seed procedure)           │
        ├── Task 5  monitoring + ops alerts (signals doc + script + unit test)         │ {3, 5, 6, 7} may run
        ├── Task 6  backup + restore drill (db-ops.sh container pattern + evidence)    │ in PARALLEL (all
        └── Task 7  admin access review (same container pattern + sign-off)            ┘ independent new files)
        ↓ (Task 4 cites Task 5's signal catalog — runs after 5)
Task 4  incident playbook (severity/comms/evidence §5.5.1)
        ↓ (Task 8 runs Task 3's RR-3 query, cites Task 1/2's surfaces + the Batch 7 test files)
Task 8  security review (§10.1 matrix doc + abuse-matrix test + headers test +
        dependency audit + secrets/env + rate-limit inventory + RR verification)
        ↓
Task 9  release checklist (§12 + §9 gate → evidence + the FD register mirror) +
        scripts/release-gate.sh + package.json entry
        ↓
Task 10 Batch 8 gate verification + verification doc
```

Why the order: **Task 2 after Task 1** — the copy-safety scan covers `src/content/policies` (Task 1's content modules) and the policy page source. **Task 4 after Task 5** — the incident playbook's severity levels cite the ops-alerts signal catalog as their detection sources. **Task 8 after Tasks 1–5** — the security review runs Task 3's RR-3 duplicate-phone query, records Task 1/2's tests as matrix evidence, cites the monitoring design (RR-9's tripwire), and maps the Batch 7 test files (`beta-access`, `chat-beta-gate`, `deal-beta-gate`, `founding-seller-*`, `suspended-membership-enforcement` — present per G1). **Task 9 after Task 8** — the checklist's security rows and the gate's findings-register parse consume the security review.

File-conflict rules (G4): `src/components/footer.tsx` — Task 1 only. `next.config.ts` — Batch 4's `/uploads` and Batch 7's `/invite` blocks are never edited; Task 8 appends the app-wide §7.4 headers with `/uploads` excluded from the source regex. `package.json` — Task 9 only (one script entry). `src/lib/seller-verification-policy.ts` — read-only except the FD-R4 version bump (G3(d), the founder's commit). `docs/operations/policy-review-record.md` — Task 1 creates the template; the *founder* fills rows (never an implementer commit inventing a review). `docs/operations/restore-drill-evidence.md` — Task 6 creates the template; drill runs append dated evidence. `scripts/db-ops.sh`/`backup-db.sh`/`restore-db.sh` — consumed as shipped (ops/runtime-readiness `de0240f`), never edited. All Batch 2–7 lib modules read-only (Global Constraints). Everything else is single-owner new files.

## Review Focus

1. **Release passing while a policy is unreviewed** — the central §9 Batch 8 gate failure mode: the release-gate script's policy check passing because a record row exists but its hash does not match the shipped content (stale review), because the Decision cell is merely non-empty (a `REJECTED`/`PENDING` row must not pass), or because the check reads the wrong file. Pinned by Task 1: `tests/unit/policy-registry.test.ts` "allPoliciesReviewed is false while any status is DRAFT-NOT-REVIEWED" (status lives in the **registry** — the hashed content module carries `POLICY_TEXT` only) + "policyContentHash is sha256 of the shipped content" and Task 9: the release gate recomputes the hash via `scripts/policy-hash.ts --check` (prints `key version hash status`) and requires the record row's **Decision == APPROVED** + hash match + registry status `REVIEWED` — a content change without a new review row fails the gate.
2. **Legal text smuggled into a placeholder** — an implementer-authored clause (acceptance semantics, retention number, sanction rule) inside a `DRAFT-NOT-REVIEWED` content module (spec §4.11). Pinned by Task 1's test: each content module's body matches the placeholder contract (banner + `[nội dung chờ founder]` markers; only `safety_guidance` may additionally carry the spec-sourced §6.4 points + §5.2 line in Batch 6's Vietnamese translation) and Task 2's copy-safety scan covering `src/content/policies`.
3. **PII in an alert or ops output** — an ops-alerts line or admin-access-review row carrying a user email/phone/IP/OTP/token (spec §4.8). Pinned by Task 5: `tests/unit/ops-alerts.test.ts` "emitted alert lines contain no PII shapes" (the alert formatter passes the same shape scan as Batch 5's PII guard) and Task 7: `tests/unit/admin-access-review.test.ts` "the review output contains ids/counts/states only — no raw email, no recovery-code values, no TOTP secret".
4. **A finance-boundary violation going undetected** — a finance row written while `FINANCIAL_FEATURES_ENABLED=false` but the watermark alert never fires (watermark never persisted, comparison inverted, first-run baseline swallowing the violation). Pinned by Task 5: `tests/unit/ops-alerts.test.ts` "a finance row newer than the watermark while finance is disabled → CRITICAL finance-boundary alert" + "first run establishes the baseline without alerting" + "the watermark state file round-trips".
5. **The abuse-matrix mapping rotting** — the security review doc claiming a test that no longer exists (a batch deviated), a §10.1 row left unmapped, or a cited test file that exists but no longer contains the claimed case. Pinned by Task 8: `tests/unit/abuse-matrix.test.ts` parses the matrix table from the security review doc, asserts all 29 spec rows are present exactly once, asserts every evidence path resolves on disk, **and asserts a keyed test title or typed error string from the matrix's evidence cell exists inside each cited test file** (e.g. the `DEAL_FORBIDDEN` string for the Deal-IDOR row) — file existence alone is not coverage.
6. **The release gate silently passing on missing evidence** — a checklist row left `PENDING`, a blocking Founder Decision Register item with no dated founder decision, a missing drill evidence file, a red `npm audit`, or an absent/empty findings register not failing the gate. Pinned by Task 9: the release-gate script's gates each exit non-zero on failure with the failing item named; the checklist parse covers **both** the §12/§9 rows (zero `PENDING`; `FOUNDER` rows require non-empty sign-off) **and the FD register mirror** (every Blocking=YES register row requires a dated founder decision — `tests/unit/release-gate-checklist.test.ts` derives the blocking set from the plan's register table mechanically); the findings-register parse uses a fixed case-insensitive table format and **fails when the section is absent**; the script uses `grep` with explicit exit-code handling (no `rg` dependency on the server).

---

## Task 1: Policy registry + versioned policy pages + DRAFT-NOT-REVIEWED release block

**Files:**

- Create: `src/lib/policy-registry.ts` (plain module — no `server-only`, no db — importable by `scripts/policy-hash.ts` and the page)
- Create: `src/content/policies/terms.ts`, `src/content/policies/privacy.ts`, `src/content/policies/marketplace-rules.ts`, `src/content/policies/seller-rules.ts`, `src/content/policies/community-rules.ts`, `src/content/policies/safety-guidance.ts`
- Create: `app/policies/[key]/page.tsx`
- Modify: `src/components/footer.tsx` (a "Chính sách" links column)
- Create: `scripts/policy-hash.ts` (offline helper: prints `<key> <version> <sha256>` per policy — the release gate and the founder's review record both use it)
- Create: `docs/operations/policy-review-record.md` (the review/sign-off record template + the initial PENDING rows)
- Test: `tests/unit/policy-registry.test.ts`

**Interfaces:**

- Consumes: Batch 2's `SELLER_RULES_POLICY_KEY`/`SELLER_RULES_POLICY_VERSION` (`src/lib/seller-verification-policy.ts` — read-only import for the alignment assertion), Batch 6's `safety-guidance.tsx` §6.4 strings (reused, not re-authored).
- Produces (used by Tasks 2, 8, 9):

```ts
// src/lib/policy-registry.ts — plain module (Batch 2 admin-mfa-key.ts precedent: importable
// by offline scripts; no "server-only", no db, no "use server").
export const POLICY_KEYS = [
  "terms", "privacy", "marketplace_rules", "seller_rules",
  "community_rules", "safety_guidance",
] as const;                                  // spec §3.1 legal/policy readiness — đủ 6, không thêm bớt
export type PolicyKey = (typeof POLICY_KEYS)[number];

export type PolicyStatus = "DRAFT-NOT-REVIEWED" | "REVIEWED";

export type PolicyDefinition = {
  key: PolicyKey;
  title: string;          // tiêu đề hiển thị tiếng Việt
  version: string;        // "v1" — bump = reviewed product decision + re-acceptance qua Batch 2
  status: PolicyStatus;   // REVIEWED CHỈ khi bản ghi duyệt khớp hash tồn tại (founder ký)
  updatedAt: string;      // ISO date của nội dung hiện tại
};

export const POLICIES: Record<PolicyKey, PolicyDefinition>;
export function policyContent(key: PolicyKey): string;        // từ src/content/policies/<key>.ts
export function policyContentHash(key: PolicyKey): string;     // sha256(policyContent(key)) hex
export function allPoliciesReviewed(): boolean;                 // mọi status === "REVIEWED"
export function unreviewedPolicies(): PolicyKey[];              // release gate in tên các policy chưa duyệt
```

```tsx
// app/policies/[key]/page.tsx — public (§2.1 public visitor: "read public safety guidance").
// generateStaticParams over POLICY_KEYS; unknown key → notFound() (typed route params).
// Renders: title, version ("Phiên bản v1 · cập nhật <date>"), status; khi status === "DRAFT-NOT-REVIEWED"
// → banner hiển thị rõ: "BẢN DỰ THẢO — CHƯA ĐƯỢC DUYỆT. Nội dung này chưa có hiệu lực cho phiên bản beta."
// POLICY_TEXT render dạng văn bản thuần (React text nodes / whitespace-pre-wrap) — KHÔNG
// dangerouslySetInnerHTML, KHÔNG markdown-as-HTML. Không auth (trang chính sách là công khai).
```

- Content-module contract (the §4.11 boundary — Review Focus 2): each `src/content/policies/<key>.ts` exports `POLICY_TEXT: string` whose body is **only**: the `# <title> (DRAFT-NOT-REVIEWED)` heading, the `> ⚠️ BẢN DỰ THẢO — CHƯA ĐƯỢC DUYỆT` banner block naming the mechanism ("nội dung pháp lý do founder soạn và duyệt — FD-3, spec §4.11"), and `[nội dung chờ founder — <key>]` markers. **No section skeletons, no acceptance clauses, no retention numbers, no sanction rules.** The single exception: `safety-guidance.ts` may additionally embed the **spec-sourced §6.4 six points + the §5.2 line in Batch 6's Vietnamese translation** (a faithful translation of spec text, not "spec-verbatim" wording — already shipped in Batch 6's `src/components/safety-guidance.tsx`; import or copy the exact strings; spec-sourced content is not invention) under the same DRAFT banner.

- [ ] **Step 1: Write the failing unit test**

`tests/unit/policy-registry.test.ts` (pure module — no db mock needed; source-contract assertions on the page/footer read files as text like `tests/unit/finance-public-surface.test.ts`):

- `the registry carries exactly the six spec §3.1 policies` — `POLICY_KEYS` deep-equals the six keys; no invented seventh, none missing.
- `seller_rules aligns with Batch 2's acceptance constants` — `POLICIES.seller_rules.key === SELLER_RULES_POLICY_KEY` and `POLICIES.seller_rules.version === SELLER_RULES_POLICY_VERSION` (import both — acceptance recording binds to the published version; a registry drift breaks the test).
- `every policy has a title, version, status, and updatedAt`.
- `allPoliciesReviewed is false while ANY status is DRAFT-NOT-REVIEWED and true only when all six are REVIEWED` — fixture-driven over status combinations (Review Focus 1).
- `unreviewedPolicies lists exactly the DRAFT ones`.
- `policyContentHash is the sha256 hex of the shipped content and is stable across calls`.
- `every content module matches the placeholder contract` — for each key: the body contains the `DRAFT-NOT-REVIEWED` marker and `[nội dung chờ founder` marker; **no content module other than safety_guidance contains §6.4-adjacent authored prose**; `safety-guidance.ts` contains the six §6.4 point strings + the §5.2 line (Review Focus 2 — the §4.11 boundary).
- `the policy page renders the DRAFT banner conditionally and never as raw HTML` — source assertions on `'app/policies/[key]/page.tsx'`: the banner string present; `dangerouslySetInnerHTML` absent; `generateStaticParams` covers `POLICY_KEYS`; unknown key → `notFound()`.
- `the footer links all six policies` — source assertion on `src/components/footer.tsx` (`/policies/<key>` for each).

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/unit/policy-registry.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement registry + content + page + footer + hash helper**

- `src/lib/policy-registry.ts` per the interface block; `policyContentHash` = `crypto.createHash("sha256").update(policyContent(key)).digest("hex")`.
- Six content modules per the placeholder contract (Global Constraints + interface above).
- `'app/policies/[key]/page.tsx'` per the interface block (`export const dynamic` not needed — static params; plain text rendering).
- `src/components/footer.tsx`: append a "Chính sách" column with the six links (keep every existing column; the existing neutral disclaimer lines untouched).
- `scripts/policy-hash.ts`: `npx tsx scripts/policy-hash.ts` prints one `<key> <version> <sha256>` line per policy (the founder's review record consumes this output); **`npx tsx scripts/policy-hash.ts --check`** prints `<key> <version> <sha256> <status>` per policy — the release gate's policy check consumes the `--check` output and requires `status === "REVIEWED"`; the script refuses to run if a content module fails to import. **The hash covers `POLICY_TEXT` only** — status/version live in the registry (`POLICIES[key]`), never in the hashed content module, so flipping a status never invalidates a recorded hash and a content change always does (S1).

- [ ] **Step 4: Write the review-record template**

`docs/operations/policy-review-record.md` — the sign-off record (who, date, version, hash):

- A table with one row per policy: `| Policy | Version | sha256 (scripts/policy-hash.ts) | Reviewer | Reviewed at | Decision | Notes |` — initial rows carry the **current placeholder hash** with `Reviewer: — (chờ founder)`, `Decision: PENDING`. **Decision is exactly one of `APPROVED` / `REJECTED` / `PENDING`** — the release gate requires `APPROVED` (a non-empty cell is not enough).
- The procedure text: (1) the founder reviews the content module for a policy; (2) runs `npx tsx scripts/policy-hash.ts`; (3) records reviewer/date/version/hash/decision (`APPROVED`); (4) flips `status` to `"REVIEWED"` **in the registry** (`POLICIES[key].status` in `src/lib/policy-registry.ts` — never in the hashed content module) **in the same commit**; (5) a version bump = new row + `version` change + re-acceptance via Batch 2's mechanism. The release gate (Task 9) recomputes hashes via `--check` and compares — a content change without a matching new row fails the gate (Review Focus 1).
- **The Seller-Rules version tension (FD-R4/S2):** Batch 2's publication gate records `PolicyAcceptance(seller_rules, v1)` against the *placeholder* — the first reviewed Seller Rules text **must bump the version** (`SELLER_RULES_POLICY_VERSION` `"v1"` → `"v2"` in `src/lib/seller-verification-policy.ts` — the one G4 read-only-module exception, G3(d)) **in the founder's review commit**, with the publication-gate/acceptance tests updated in the same commit and the registry's `seller_rules.version` following (the alignment test pins them together). Pre-launch `v1` acceptances exist only in dev/test — the release gate blocks launch while the policy is unreviewed, so no real seller accepts placeholder text. The alternative (production forbidding acceptances while `status != APPROVED`) would be a Batch 2 action change — out of the G3 perimeter; the version bump is the specified mechanism.
- An explicit note: **no implementer/agent may fill a Reviewer/Decision cell** — those are founder-only fields (§4.11).

- [ ] **Step 5: Run until green + regression**

Run: `npm test -- tests/unit/policy-registry.test.ts` → PASS.
Run: `npm test` → full suite green (no Batch 1–7 suite touched).
Run: `npx tsx scripts/policy-hash.ts` → six lines printed (paste into the record template's initial rows).

- [ ] **Step 6: Commit**

```bash
git add src/lib/policy-registry.ts src/content/policies 'app/policies/[key]/page.tsx' src/components/footer.tsx scripts/policy-hash.ts docs/operations/policy-review-record.md tests/unit/policy-registry.test.ts
git commit -m "feat(policies): versioned policy pages with review-gated release"
```

## Task 2: Consolidated copy-safety scan (§4.2 + §4.7)

**Files:**

- Test: `tests/unit/copy-safety.test.ts`

**Interfaces:**

- Consumes: the repo's public-copy sources as text (`app/**/*.tsx`, `src/components/**/*.tsx`, `src/content/**/*.ts` — the `finance-public-surface.test.ts` source-scan pattern), the known allowlisted negation lines.
- Produces: the permanent §4.2/§4.7 gate — consolidating the per-batch `rg` scans (Batch 1 §8, Batch 4 Task 9, Batch 6 Task 8) into one rerunnable test.

- [ ] **Step 1: Write the test** (a contract test — may pass immediately; record which cases needed fixes)

`tests/unit/copy-safety.test.ts`:

- `no affirmative guarantee/escrow/protection/payment-promise language in public copy` — scan every public-copy source for the patterns `đảm bảo|bảo đảm|bảo hiểm|bảo vệ (thanh toán|giao dịch)|giữ tiền hộ|escrow|guarantee|insurance` (case-insensitive where applicable) with the **exact allowlisted negation strings excluded**: `"LoaViet không giữ tiền và không bảo đảm giao dịch"` (footer + listing disclaimer) and the Batch 6 §5.2 line — assert each allowlisted string **is present** (the negation must stay) and no *other* occurrence exists (Review Focus 2 of Batch 6, made permanent).
- `no location-safety claims (§4.7)` — scan for `khu vực an toàn|an toàn khu vực|chứng nhận an toàn|khu vực được bảo đảm|verified market` → 0 hits; the operational label `Khu vực beta trọng điểm` is the allowed form.
- `the §6.2 seller-verification wording is the neutral form` — the verification surfaces (`app/sell/verification`, `src/components/seller-verification-form.tsx`, admin verification page) contain `Đã xác minh thông tin người bán theo yêu cầu hiện tại của LoaViet` and never `Người bán được LoaViet bảo đảm`.
- `the §5.2/§6.4 lines render near chat/deal flows` — re-assert Batch 6's `safety-guidance.tsx` strings (payment outside LoaViet / verify condition / public meetup / never share OTP / suspicious links / report-block).
- `policy content modules carry no promise language` — `src/content/policies/*` included in the scan (Task 1's placeholders are neutral by construction; the scan keeps them honest as founder text lands).

- [ ] **Step 2: Run and record**

Run: `npm test -- tests/unit/copy-safety.test.ts` → record pass/fail per case; a violation is a defect in the *owning* file (fix it there, never weaken the scan).

- [ ] **Step 3: Commit**

```bash
git add tests/unit/copy-safety.test.ts
git commit -m "test(copy): permanent no-misleading-promise scan"
```

## Task 3: Operations playbooks

**Files (all Create — docs only):**

- `docs/operations/moderation-playbook.md`
- `docs/operations/seller-verification-playbook.md`
- `docs/operations/concierge-onboarding-playbook.md`
- `docs/operations/account-recovery-playbook.md`
- `docs/operations/founding-seller-onboarding-checklist.md`
- `docs/operations/model-seed-review-procedure.md`

**Interfaces:**

- Consumes (read-only, cross-checked by name against the merged source — Global Constraints factual-accuracy rule): Batch 2 `rbac.ts` capabilities + `STEP_UP_CAPABILITIES`, `admin-bootstrap-recovery-runbook.md`, the `AuditEvent` action registry; Batch 3 `moderation-vocab.ts` reason codes + case states + `MODERATION_ACTION_TYPES`; Batch 4 `/admin/catalog` + `BETA_PUBLICATION_CATEGORIES`; Batch 7 console surfaces + `founding-seller-vocab.ts` states.
- Produces: the ops runbooks the §9 Batch 8 gate ("moderation operational", "seller verification operational", "founding seller process ready") and §12 ("support path exists", "incident escalation exists") point at; each playbook ends with a **Founder Decision Items** section pointing at the register rows it carries.

- [ ] **Step 1: Write the playbooks** (each section traceable to a spec § or a shipped surface — no invented policy; every threshold/SLA the spec lacks is marked `[FOUNDER DECISION — FD-R<n>]`)

1. **moderation-playbook.md**: working the queue (states `open→triaged→investigating→actioned→dismissed→appealed→closed`, the `priority` field documented with **no invented SLA** — FD-R9); assignment + the conflict-of-interest recusal rule (fail-closed `MODERATOR_CONFLICT` — FD-R11); takedown vs admin rejection (R4/R5 semantics: `removed` listings are moderation-locked, **the only restore path is an appeal outcome** — FD-R8); **the moderator→operations_admin suspension hand-off** (moderators hold `report.resolve`/`listing.moderate` but not `user.suspend` — FD-R2: the hand-off is case assignment + notification until the Scoped cells are defined); evidence handling per §5.5.1 (immutable, access-restricted, every view audited `moderation.evidence_viewed`, **never delete mutable sources during an active case**); appeal intake (manual: record → `appealed` state → founder decision pending FD-R8 — **including the notification gap**: a case actioned without a linked sanction sends no appeal-link notification, so the playbook tells the operator to notify manually); the **PROVISIONAL sanction-taxonomy reason vocabularies** listed for founder authorship/acknowledgment (FD-R12 — launch blocker per FD-3; the constants carry `PROVISIONAL (A8)` markers) **and the placeholder moderation copy** (suspend/takedown notification wording, appeal-page copy, reason labels — FD-R50); the existing-conversation-reply perimeter (a suspended/revoked seller's replies in existing threads stay writable — FD-R53, actor-side guards only); suspended-user posture (no session revocation/login block — RR-16; live listings stay until takedown — RR-17).
2. **seller-verification-playbook.md**: the §5.3.3 operations-review checklist verbatim (duplicate-account indicators, current suspension/ban, prior revocation, abnormal account-creation pattern, suspicious phone/account relationships, inconsistent seller declaration, unresolved serious abuse reports, suspicious listing behavior, business claims needing evidence); the decision flow (step-up required — FD-R5; atomic claim `VERIFICATION_ALREADY_REVIEWED` on concurrent double-review); decisions → typed reason codes; revocation handling; the §6.2 neutral copy rule; **the RR-3 compensating control: the ops duplicate-phone review query** (the actual SQL: verified phones held by more than one account — run it on demand and before granting `founding_seller`); no identity-document collection (§5.3.2 — any future collection is a separately reviewed legal/ops decision).
3. **concierge-onboarding-playbook.md**: the §5.10.1 responsibility split — operations **may** assist with model selection, structured listing fields, the photo checklist, listing formatting, migration of existing listing info; operations **must not** silently fabricate seller claims; the seller retains asking price, condition, defects, repair history, ownership/sale authority, product claims, publication consent; the out-of-band invite delivery workflow (the operator hands the invite URL over in the recruitment conversation — FD-R29; the **cookie flow** `/invite/[token]` GET → HttpOnly `sp_invite` cookie → tokenless `/invite` acceptance, with the token-in-URL residual risk recorded — FD-R49/RR-21; the platform never emails/SMSes until FD-R1 lands); the founding-seller lifecycle mechanics the operator walks (the §5.10 transition table, reason codes, manually-settable states, invite-only-for-`prospect`/`invited`, the rate values — the FD-R48 provisional set, PROVISIONAL-marked); masked contact in the console + the operator's own channel as the contact source (FD-R2).
4. **account-recovery-playbook.md**: the self-service flow (identifier → neutral message → OTP to a **verified** channel → reset → every session revoked — enumeration-safe rules for support staff: never confirm whether an identifier exists); what support may/may not do (no broad PII — FD-R2 cells); **the Batch 2 A3 manual fallback** (last resort for a user who lost every verified channel): the audited, offline, two-person-rule path via the `admin-bootstrap.ts`-pattern maintenance command, with identity-proofing requirements marked `[FOUNDER DECISION — FD-R3]` — the playbook records the *procedure shape* (who, audit trail, session revocation after), never invents proofing policy.
5. **founding-seller-onboarding-checklist.md**: the §5.10 lifecycle stages (`prospect → invited → registered → verification_pending → verified → concierge_onboarding → first_listing → active_founding_seller → inactive → exited`) with per-stage owner/action/evidence; the §2.7 operational targets (20–50 invited founding sellers, 100–200 buyers, 100–300 quality listings) as **targets, not code gates**; the §12.1 supply-readiness items (verified-seller target reached or explicitly approved, inventory target, core model coverage reviewed, listing quality manually sampled, seller response monitoring works, moderation/support capacity exists) each with a sign-off field; cross-references the Batch 7 console's supply-readiness view.
6. **model-seed-review-procedure.md**: how the founder reviews Batch 4's `pending` canonical models via `/admin/catalog` (`listing.moderate`); the founder-supplied list path (`--models <founder.json>` — the implementer never authors one, FD-R16); core model coverage review (§12.1); the alias-content review sitting (FD-R24 — same session); the `loa-bluetooth` taxonomy decision (FD-R19); the §5.6.3 photo-checklist vocabulary and condition-grade definitions cross-referenced as founder content (FD-R14/R15).

- [ ] **Step 2: Factual-accuracy verification pass**

For each playbook: `rg -n "<quoted symbol>" src app` for every file path, action name, capability name, audit action, and reason code quoted in the doc — every reference must resolve to the merged source (a playbook referencing a non-existent surface is a defect: fix the doc, never the code). Record the check results in the Task 10 verification doc.

- [ ] **Step 3: Commit**

```bash
git add docs/operations/moderation-playbook.md docs/operations/seller-verification-playbook.md docs/operations/concierge-onboarding-playbook.md docs/operations/account-recovery-playbook.md docs/operations/founding-seller-onboarding-checklist.md docs/operations/model-seed-review-procedure.md
git commit -m "docs(ops): moderation, verification, concierge, recovery playbooks"
```

## Task 4: Incident playbook

**Files:**

- Create: `docs/operations/incident-playbook.md`

**Interfaces:**

- Consumes: §5.5.1 (evidence lifecycle), the Batch 2 admin-bootstrap runbook (admin MFA lockout / key rotation — referenced, not duplicated), `docs/backup-restore.md` (DB rollback), the Task 5 monitoring signals.
- Produces: the §12 "incident escalation exists" evidence.

- [ ] **Step 1: Write the playbook**

`docs/operations/incident-playbook.md` sections:

1. **Severity levels** — proposed SEV1 (security breach / data loss / finance-boundary violation alert / full outage), SEV2 (partial degradation, moderation backlog overflow, backup failure), SEV3 (single-user issue, minor bug) — each with a *detection source* (which ops-alerts signal) and an *escalation path*; thresholds marked `[FOUNDER DECISION — FD-R38]` (the spec defines no severity scale).
2. **Communications** — internal channel first (who is notified at each severity — founder + on-call operator), user-facing notice policy (a banner decision is founder-level; never auto-published), what **not** to post (no PII, no exploit detail while a security issue is open).
3. **Evidence preservation (§5.5.1)** — during an incident: do **not** delete or edit the implicated listings/messages/users (moderation evidence snapshots survive source deletes — cite the Batch 3 integration test); do **not** run destructive cleanup; preserve `docker compose logs` output (`docker compose ... logs --no-log-prefix app > incident-<ts>.log`), take a fresh `./scripts/db-ops.sh backup` snapshot **before** remediation where safe (the container-on-network pattern — no host pg tools), and record the timeline in the incident doc; the `ModerationEvidence`/`AuditEvent` append-only guarantees are the system of record.
4. **Security-incident specifics** — suspected account compromise: revoke sessions (`session.revoke` surfaces), force password reset, audit `user.recovery_*` events; suspected admin compromise: Batch 2 runbook §2/§5 (recovery codes → `mfa-reset` → re-enroll; `admin.role_manage` review); key rotation (`ADMIN_MFA_ENCRYPTION_KEY`, `AUTH_SECRET`, `PRODUCT_EVENT_PSEUDONYM_KEY` — each with its runbook section and the RR-11/RR-15 caveats).
5. **Finance-boundary violation runbook** — the Task 5 CRITICAL alert's follow-up: confirm via the watermark query which finance table changed, freeze (stop app), snapshot, investigate the write path (Batch 1 boundary bypass = critical security finding), record in the security review.
6. **Post-incident review** — a template (timeline, detection gap, root cause, fix, follow-ups) appended per incident; the audit trail (`AuditEvent` actions) is the authoritative timeline source.

- [ ] **Step 2: Factual-accuracy verification pass** — same as Task 3 Step 2 (every quoted surface resolves).

- [ ] **Step 3: Commit**

```bash
git add docs/operations/incident-playbook.md
git commit -m "docs(ops): incident playbook with evidence preservation"
```

## Task 5: Monitoring + ops alerts

**Files:**

- Create: `scripts/ops-alerts.ts` (offline cron script — plain modules only)
- Create: `docs/operations/monitoring-signals.md` (the signal catalog)
- Test: `tests/unit/ops-alerts.test.ts`

**Interfaces:**

- Consumes: `/api/health` (HTTP), `docker compose logs` (the `captureError`/`captureEvent` JSON lines — `src/lib/observability.ts` scopes), `AuditEvent` (auth/admin action counts), `OtpCode` (attempt-exhaustion counts), **`pg_stat_user_tables` tuple counters** for the finance tables (read-only), `FINANCIAL_FEATURES_ENABLED` (**read from the deployed app container's env** — `docker exec loaviet-app printenv FINANCIAL_FEATURES_ENABLED` — not the host env), the backup directory listing, the cron log. **DB reach:** the production db publishes no port — every query goes through `docker exec loaviet-db psql` from the script's thin IO layer (read-only; the container-on-network `db-ops.sh` pattern applies to anything heavier). **No `server-only` imports** (`otp.ts`/`financial-features.ts`/`env.ts`/`observability.ts` are unloadable under plain `tsx`): the finance-table list and `OTP_MAX_ATTEMPTS` are local constants with a **drift test** against `src/prisma/contract.prisma`.
- Produces (the alert script's exported pure functions are the unit-tested core; `main()` wires them):

```ts
// scripts/ops-alerts.ts — offline maintenance command (§5.1.1 posture: không expose HTTP/admin UI).
// Cron chạy trên server (docs/operations/monitoring-signals.md § schedule). Output: JSON alert lines
// (captureEvent-shape) ra stdout + exit code: 0 = mọi tín hiệu OK, 1 = có CRITICAL.
// KHÔNG PII: chỉ count/scope/typed-code — không user id, email, phone, IP, OTP, token (Review Focus 3).
export type Alert = { severity: "CRITICAL" | "WARN" | "INFO"; signal: string; detail: Record<string, number | string> };

// ── Pure decision functions (unit-test trực tiếp — fixture rows vào, Alert[] ra) ──
export function evaluateHealth(healthJson: { ok: boolean; db?: string } | null): Alert[];
export function evaluateErrorRate(errorLineCount: number, windowMinutes: number, threshold: number): Alert[];
export function evaluateAuthAbuse(counts: {
  recoveryRequested: number;      // AuditEvent user.recovery_requested trong window
  mfaRecoveryCodeUsed: number;    // AuditEvent admin.mfa_recovery_code_used trong window
  otpMaxAttempts: number;         // OtpCode rows attempts >= OTP_MAX_ATTEMPTS trong window
}, thresholds: AuthAbuseThresholds): Alert[];
// GIỚI HẠN GHI NHẬN TRONG monitoring-signals.md + security review: failed login/MFA KHÔNG
// có AuditEvent (Batch 2 chỉ audit hành động thành công) và bucket rate-limit nội bộ
// KHÔNG query được cross-process (RR-1) → tín hiệu auth-abuse là best-available từ
// AuditEvent + OtpCode; ngưỡng [FOUNDER DECISION — FD-R35]. Việc thêm audit failed-login
// là finding trong security review (code change ngoài perimeter G3 → plan mới).
export function evaluateFinanceBoundary(finance: {
  tableDeltas: Record<string, { inserts: number; updates: number; deletes: number }>;
                                   // pg_stat_user_tables n_tup_ins/n_tup_upd/n_tup_del DELTAS
                                   // per finance table từ lần chạy trước (state file) — query trong main()
  rowCounts: Record<string, number>; // SELECT count(*) per finance table — secondary signal
  watermark: Record<string, { inserts: number; updates: number; deletes: number }> | null;
                                   // counters lần chạy trước (state file); null = lần đầu → baseline
  financialFeaturesEnabled: boolean; // từ docker exec loaviet-app printenv (deployed config)
}): Alert[];
// BẤT KỲ delta > 0 trên BẤT KỲ finance table nào (Order, OrderItem, Payment, Payout,
// WithdrawRequest, LedgerEntry, Dispute, CartItem, Offer, ExchangeOffer, PlatformSetting,
// PriceHistory) khi financialFeaturesEnabled === false → CRITICAL finance-boundary.
// TẠI SAO pg_stat chứ không phải createdAt/updatedAt watermark (S3): Payment/Payout không
// có updatedAt (chỉ createdAt — status UPDATE vô hình); CartItem/OrderItem KHÔNG có
// timestamp nào; DELETE xoá sạch dấu vết; raw SQL bypass ORM timestamps; không có model
// Wallet. pg_stat_user_tables đếm physical row ins/upd/del BẤT KỀNH write path nào —
// không cần schema change. Lưu ý: counters reset khi stats_reset/PG restart → delta so với
// state file có thể "âm" → treat âm = reset → re-baseline (INFO), không CRITICAL giả.
// TimestamptzString là TEXT trong DB — mọi so sánh thời gian trong SQL cast ::timestamptz.
export function evaluateBackupFreshness(newestBackupAgeHours: number | null, maxAgeHours: number): Alert[];
export function evaluateCron(lastCronLogAgeHours: number | null, maxAgeHours: number): Alert[];
export function formatAlertLine(alert: Alert): string;   // JSON 1 dòng — qua PII shape scan (test pin)

export type OpsAlertsThresholds = { ... };               // mọi ngưỡng — proposed defaults, FD-R35
export const DEFAULT_THRESHOLDS: OpsAlertsThresholds;    // đánh dấu rõ "proposed — founder tunes"
```

- The **finance-boundary watermark** (Review Focus 4): a state file `backups/.ops-alerts-state.json` (gitignored — `backups/` already is) records the last-seen `pg_stat_user_tables` counters (`n_tup_ins`/`n_tup_upd`/`n_tup_del`) **per finance table**. Each run: if `financialFeaturesEnabled === false` (read from the deployed app container) and any counter moved since the watermark → **CRITICAL with the table name** (a finance write happened while finance is disabled — Batch 1 boundary violation; the counters catch status UPDATEs, DELETEs, and raw SQL that timestamp watermarks miss). First run (no watermark) establishes the baseline without alerting; a counter *decrease* means a stats reset/PG restart → re-baseline with an INFO line, never a false CRITICAL. The comparison logic is pure and unit-tested.

- [ ] **Step 1: Write the failing unit test**

`tests/unit/ops-alerts.test.ts` (pure functions — no db mock needed; fixtures in, Alerts out):

- `health: db down → CRITICAL; ok → INFO/none`.
- `error rate over threshold → WARN; under → none` (threshold passed explicitly — the default is a founder item).
- `auth abuse: each count over its threshold → WARN; recovery-code use > 0 → INFO (each use is notable); all under → none`.
- `finance boundary: any tuple-counter delta > 0 on any finance table while disabled → CRITICAL with the table name; zero deltas → none; first run (null watermark) → baseline INFO, no CRITICAL` (Review Focus 4); `a counter DECREASE (stats reset/PG restart) → re-baseline INFO, never a false CRITICAL`; `enabled === true → INFO not CRITICAL` (the alert is beta-specific).
- `the finance-table list drifts with the contract` — the script's `FINANCE_TABLES` constant ⊆ the models in `src/prisma/contract.prisma`, and the key finance models (`Order`, `OrderItem`, `Payment`, `Payout`, `WithdrawRequest`, `LedgerEntry`, `Dispute`, `CartItem`, `Offer`, `ExchangeOffer`, `PlatformSetting`, `PriceHistory`) are all present — a contract change (a renamed/added finance model) fails the test (the duplicated-constants drift guard, Global Constraints).
- `backup: newest older than maxAge → CRITICAL (no backup → CRITICAL); fresh → none`.
- `cron: no log line in window → WARN; present → none`.
- `formatAlertLine output contains no PII shapes` — email/phone/6-digit-OTP-shaped strings absent from every emitted line (Review Focus 3 — the same shape scan discipline as Batch 5's PII guard).
- `DEFAULT_THRESHOLDS carries the proposed-default marker` (every threshold documented as founder-tunable).

- [ ] **Step 2: Run to verify failure** → `npm test -- tests/unit/ops-alerts.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement**

- `scripts/ops-alerts.ts` per the interface: `main()` runs the read-only queries through `docker exec loaviet-db psql -U loaviet -d loaviet -tAc "<SQL>"` (child_process; **no direct postgres connection — the db publishes no port**; the SQL is fixed strings from the `FINANCE_TABLES` constant, never interpolated user input), reads `FINANCIAL_FEATURES_ENABLED` via `docker exec loaviet-app printenv FINANCIAL_FEATURES_ENABLED` (the deployed config), loads/saves the watermark state file, evaluates, prints alert lines, exits 1 on CRITICAL. **No `server-only` imports** — plain modules only; the `FINANCE_TABLES`/`OTP_MAX_ATTEMPTS` constants are local with the drift test. In dev (no containers), the same queries run against `DATABASE_URL` via the ORM — the IO layer is one function seam, the decision logic is pure either way.
- `docs/operations/monitoring-signals.md`: the signal catalog — one row per signal: name, source (`/api/health` / log lines / `AuditEvent` / `OtpCode` / **`pg_stat_user_tables` deltas** / backup dir / cron log), query or command, threshold (proposed default + `[FOUNDER DECISION — FD-R35]`), severity, and the **no-PII rule**; the cron schedule proposal (e.g. every 15 min — `[FOUNDER DECISION]`); the delivery-channel note (FD-R37: log lines + exit code ship; email/Telegram is deploy-time); the single-instance caveat (RR-1) **and the auth-abuse blindness note** (failed logins/MFA failures have no `AuditEvent` and the in-memory limiter buckets are not queryable cross-process — the counts are best-available; adding failed-login auditing is a recorded security-review finding, a code change outside G3 → a new plan).

- [ ] **Step 4: Run until green + a real dry run**

Run: `npm test -- tests/unit/ops-alerts.test.ts` → PASS.
Run (dev): `npx tsx scripts/ops-alerts.ts` against the dev DB → prints the signal lines, exit 0 (record the output in the Task 10 verification doc; **no production run in Batch 8** — installing the cron is a deploy step, recorded in the release checklist).

- [ ] **Step 5: Commit**

```bash
git add scripts/ops-alerts.ts docs/operations/monitoring-signals.md tests/unit/ops-alerts.test.ts
git commit -m "feat(ops): monitoring signals and finance-boundary alerts"
```

## Task 6: Backup + restore drill

**Files:**

- Create: `scripts/restore-drill.sh`
- Create: `docs/operations/restore-drill-evidence.md` (the evidence template + the first drill's recorded output)

**Interfaces:**

- Consumes: `scripts/db-ops.sh` (ops/runtime-readiness `de0240f` — the container-on-network pattern: `backup --keep N`, `verify <file>`, `restore <file> <newdb>` run `backup-db.sh`/`restore-db.sh` **inside** a throwaway `postgres:16-alpine` client container attached to the db's network, `PGPASSWORD` from `.env`), `backup-db.sh`'s `*.partial`-then-rename-after-TOC behavior, `scripts/test-integration.sh`'s scratch-container pattern (own container name, trap-cleanup, random port), the ORM for seeding.
- Produces: the §9 Batch 8 "restore drill successful" evidence — a scripted, repeatable drill with recorded output. **No host pg tools anywhere** (the client tools are the same `postgres:16-alpine` image as the server — version parity by construction, no host `pg_dump` version preflight); **no backup-doc edits** (`docs/backup-restore.md`/`deployment.md`/`runbook.md` already use `db-ops.sh` and a DB-rename cutover — referenced, never re-fixed).

- [ ] **Step 1: Write the drill script**

`scripts/restore-drill.sh` (bash, `set -Eeuo pipefail`, the test-integration.sh safety pattern — scratch containers `sp-drill-pg-$$` (server) + `sp-drill-client-$$` (client tools), trap cleanup, no secrets printed):

1. **Scratch source DB**: start a throwaway `postgres:16-alpine` server container; `npx prisma db migrate --to production` (the real graph); seed a minimal verification fixture **via `tsx` + the ORM, not raw `psql`** (a `User`, a `Listing`, a finance-preservation fixture: one `Order`+`OrderItem`+`Payment` — proving the finance tables restore; the ORM respects the contract, raw SQL can drift).
2. **Client-tools container**: start a second throwaway `postgres:16-alpine` container attached to the scratch server's network, with the repo's `scripts/` and a temp backup dir mounted — `backup-db.sh` and `restore-db.sh` run **inside** it (the `db-ops.sh` pattern applied to the scratch stack; `pg_dump`/`pg_restore`/`psql` are the container's own 16-alpine tools).
3. **Backup**: `backup-db.sh --url <scratch-url> --name drill --out <backup-dir>` (the real script, in-container — the `*.partial` → TOC-check → rename behavior exercised).
4. **Restore**: `restore-db.sh --file <dump> --url <admin-url> --into drill_restored` (the real script, in-container — restore into a **new** DB, never overwrite).
5. **Verification queries** (in-container `psql` against `drill_restored`, printed + captured): table count parity vs the source (`information_schema.tables` count equal); row counts for `User`, `Listing`, `Order`, `OrderItem`, `Payment` equal to the source; the seeded rows read back equal; `npx prisma db verify` against the restored URL (marker + schema match) — the drill prints a PASS/FAIL per check.
6. **Timing**: measure backup duration, restore duration, dump size (`date +%s` deltas + `du -h`) — **recorded as measured RTO/RPO evidence** (no invented targets — FD-R36).
7. **Evidence**: append a dated section to `docs/operations/restore-drill-evidence.md` (date, host, durations, sizes, the verification outputs, PASS/FAIL) — the operator pastes the captured output; the template's header explains the cadence (§9 gate: at least once before launch; `docs/backup-restore.md` recommends weekly via `db-ops.sh verify`).
8. **Cleanup**: drop the restored DB, remove both scratch containers + the drill dump (trap).

- `--file <real-backup>` mode: the same verification steps run against a **real** nightly backup via the `db-ops.sh verify <file>` path (the operator's pre-launch drill against production data — recommended path for the gate evidence; the scratch mode proves the script).

- [ ] **Step 2: Run the drill (scratch mode) and record**

Run: `bash scripts/restore-drill.sh` → all verification checks PASS → paste the dated output into `docs/operations/restore-drill-evidence.md`. A FAIL is a defect in the drill script or the backup/restore scripts — fix there, never weaken a check.

- [ ] **Step 3: Commit**

```bash
git add scripts/restore-drill.sh docs/operations/restore-drill-evidence.md
git commit -m "test(ops): scripted backup and restore drill"
```

## Task 7: Admin access review

**Files:**

- Create: `scripts/admin-access-review.ts` (offline script — Batch 2 `admin-bootstrap.ts` posture)
- Create: `docs/operations/admin-access-review.md` (the sign-off template + the first review's recorded output)
- Test: `tests/unit/admin-access-review.test.ts`

**Interfaces:**

- Consumes: `User.adminRole`, `AdminMfa` (`totpConfirmedAt`), `AdminRecoveryCode` (`usedAt`), `UserSession` (`revokedAt`/`expiresAt`), `AuditEvent` (last admin actions) — read-only.
- Produces:

```ts
// scripts/admin-access-review.ts — offline maintenance command (§5.1.1 posture).
// Output: bảng markdown ra stdout — operator paste vào docs/operations/admin-access-review.md
// (mục dated, cùng pattern restore-drill-evidence.md — MỘT file template + các lần review append).
// DB reach: docker exec loaviet-db psql (read-only — db không publish port); dev: DATABASE_URL qua ORM.
// KHÔNG server-only imports (otp.ts/env.ts/... unloadable dưới tsx) — plain modules only.
// KHÔNG PII: internal user id + role + states — KHÔNG raw email, KHÔNG TOTP secret, KHÔNG recovery-code
// value (chỉ count chưa dùng), KHÔNG session token (Review Focus 3).
export type AdminAccessRow = {
  userId: string;              // internal id — operator correlate qua /admin/users
  adminRole: string;
  mfaEnrolled: boolean;        // AdminMfa.totpConfirmedAt != null
  unusedRecoveryCodes: number; // count — never values
  activeSessions: number;      // revokedAt null && expiresAt > now
  lastAdminAuditAction: string | null; // action name + age, từ AuditEvent
  accountAgeDays: number;
};
export function evaluateAdminAccess(rows: AdminAccessRow[]): {
  findings: string[];           // typed findings: "ADMIN_WITHOUT_MFA:<userId>", "NO_UNUSED_RECOVERY_CODES:<userId>",
                                 // "STALE_SESSIONS:<userId>", "LAST_SUPER_ADMIN", "NO_ADMINS"
  tableMarkdown: string;        // the review table (ids/states only)
};
export async function runReview(): Promise<{ rows: AdminAccessRow[]; findings: string[] }>;
```

- [ ] **Step 1: Write the failing unit test**

`tests/unit/admin-access-review.test.ts` (pure `evaluateAdminAccess` over fixture rows):

- `an admin without MFA enrollment → finding ADMIN_WITHOUT_MFA` (fail-closed signal — §5.4.2 "All admin accounts require MFA enrollment").
- `zero unused recovery codes → finding NO_UNUSED_RECOVERY_CODES` (warn).
- `sessions older than the admin TTL → finding STALE_SESSIONS` (info).
- `exactly one super_admin → finding LAST_SUPER_ADMIN` (the last-super-admin guard's operational echo).
- `no admins at all → finding NO_ADMINS` (info — bootstrap needed).
- `the table markdown contains ids/roles/counts only` — no email shape, no 6-digit code shape, no `secret` (Review Focus 3).

- [ ] **Step 2: Run to verify failure** → FAIL (module missing).

- [ ] **Step 3: Implement + run the real review**

- `scripts/admin-access-review.ts` per the interface (read-only queries through the same IO seam as `ops-alerts.ts` — `docker exec loaviet-db psql` in production, the ORM against `DATABASE_URL` in dev; plain modules only).
- `docs/operations/admin-access-review.md`: the sign-off template — the review table (pasted, **dated sections appended per run** — the same one-file pattern as `restore-drill-evidence.md`), the findings + their resolution, **Reviewer / Date / Decision sign-off fields (founder-only — no implementer fills them)**, and the cadence (pre-launch required by §9 Batch 8 "admin MFA operational / RBAC operational"; then per-release or monthly `[FOUNDER DECISION]`). The template also records the FD-R58 observations (`session.revoke` has no rank check; a recovery code regenerates recovery codes) as standing review context.
- Run against dev: `npx tsx scripts/admin-access-review.ts` → paste the output; **the production run is the operator's pre-launch step** (recorded in the release checklist).

- [ ] **Step 4: Run until green** → `npm test -- tests/unit/admin-access-review.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/admin-access-review.ts docs/operations/admin-access-review.md tests/unit/admin-access-review.test.ts
git commit -m "feat(ops): admin access review with sign-off"
```

## Task 8: Security review — §10.1 matrix, dependency audit, headers, secrets/env, rate limits, residual risks

**Files:**

- Create: `docs/operations/private-beta-security-review.md`
- Create: `tests/unit/abuse-matrix.test.ts` (the machine-checked matrix)
- Create: `tests/unit/security-headers.test.ts` (the §7.4 effective-headers contract)
- Create: `tests/unit/chat-surface-xss.test.ts` (the Stored-XSS-through-chat gap-fill source contract — S6)
- Modify: `next.config.ts` (the app-wide §7.4 headers + Report-Only CSP — the gap is known: no app-wide headers exist today; Batch 4's `/uploads` and Batch 7's `/invite` blocks never edited)

**Interfaces:**

- Consumes: every named test from the Batches 1–7 Threat-Case Coverage Maps (the matrix's evidence column), `npm audit`, `next.config.ts` (the `headers()` array — iterated, last-match-wins), `.env.example` + `src/lib/env.ts`, `src/lib/rate-limit.ts` + the §7.1 endpoint list, the RR-2/3/4/5 sources, the FD-R58 observations.
- Produces: the §9 Batch 8 "no known critical security issue" evidence + the §12 "no known critical security finding remains open" row.

- [ ] **Step 1: Write the abuse-matrix test (the machine-checked mapping — Review Focus 5)**

`tests/unit/abuse-matrix.test.ts`:

- Parse the matrix table out of `docs/operations/private-beta-security-review.md` (the doc is written in Step 2 — write the test against the doc's declared table format).
- Assert **all 29 spec §10.1 rows are present exactly once** (the row list is embedded in the test as the spec-verbatim array — `Unauthorized listing edit` … `Historical finance escape-hatch abuse`).
- Assert every **evidence cell resolves on disk**: a cell naming a test file (`tests/unit/<name>.test.ts` / `tests/integration/<name>.test.ts`) must `fs.existsSync`; a cell naming a doc path (`docs/operations/<name>.md` — e.g. a recorded source scan in a batch verification doc) must exist too. A cell naming neither shape is a format violation.
- **Assert a keyed test title or typed error string from the evidence cell exists inside each cited test file** (S6 — file existence alone is not coverage): each matrix row's evidence cell carries a `@<key>` marker (e.g. `tests/unit/deal-outcome.test.ts @DEAL_FORBIDDEN`, `tests/unit/seller-verification-actions.test.ts @VERIFICATION_ALREADY_REVIEWED`, `tests/unit/founding-seller-invite.test.ts @INVITE_CHANNEL_MISMATCH`), and the test asserts that string occurs in the cited file's source.
- Assert every row has a non-empty status (`covered` / `covered (framework posture, documented)` / `gap → new test`).

- [ ] **Step 1b: Write the chat-surface XSS gap-fill test (S6)**

`tests/unit/chat-surface-xss.test.ts` (source-contract, the `finance-public-surface.test.ts` pattern — the "Stored XSS through chat" row previously cited only `deal-ui.test.ts`, which does not scan the chat surfaces):

- Zero `dangerouslySetInnerHTML` in the chat surfaces: `src/components/chat-window.tsx`, `'app/chat/[id]/page.tsx'`, and every `src/components/chat-*.tsx` — message bodies render as React text.
- The message-body render path (the chat window's message list) contains no `dangerouslySetInnerHTML`/`innerHTML`/`insertAdjacentHTML` and no `href={`/`src={` interpolation of message content into an HTML sink (link/image URLs from messages render as text or via validated components).
- The Batch 6 `deal-ui.test.ts` cases stay green (the Deal-side contract is unchanged).

- [ ] **Step 2: Write the security review doc**

`docs/operations/private-beta-security-review.md` — the consolidated review, each section with recorded command output:

1. **§10.1 abuse matrix** — the 29-row table: `| Abuse case (spec §10.1) | Covering batch | Evidence test | Status |` — every row mapped to the named test(s) from the Batches 1–7 coverage maps (see the Threat-Case Coverage Map below for the full mapping this plan asserts; the doc re-verifies each named suite actually runs green at execution time). Gap-fills Batch 8 owns: the CSRF row (explicit posture verification — see below), the copy-safety row (Task 2), the policy row (Task 1).
2. **Dependency audit** — `npm audit --omit=dev` (runtime image) + `npm audit` (full) output recorded; the pinned-deps inventory (`next 16.3.7` exact, `react`/`react-dom` 19.2.8, `sharp`, `zod`, `otpauth 9.5.2` exact from Batch 2, `@prisma/orm-postgres` rc) with the lockfile-committed check; the known dev-toolchain transitive findings (the `docs/runbook.md` §7 triage — 13 high/5 moderate, all dev-transitive, no runtime critical) re-triaged at execution time; **fail the gate on any runtime critical/high**.
3. **§7.4 browser-security headers (B1/B2)** — the audit **knows the gap** (no app-wide headers exist in `next.config.ts` today; only Batch 4's `/uploads` block and Batch 7's `/invite` referrer policy) and this task **ships the fix**: an app-wide `headers()` entry whose source regex **excludes `/uploads`** (`"/((?!uploads/).*)"`) — Next `headers()` last-match-wins means an app-wide `/(.*)` entry would silently override Batch 4's stricter `/uploads` CSP (`default-src 'none'; sandbox`) with the app policy. The app-wide entry carries: **`Content-Security-Policy-Report-Only`** with the Next 16 docs' **"Without Nonces"** policy — `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: https://res.cloudinary.com` (matches `next.config.ts` `images.remotePatterns` — verified); `worker-src 'self'` (`public/sw.js` via `src/components/sw-register.tsx` — verified); `connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'self'; object-src 'none'` — plus enforced-now headers: `X-Content-Type-Options: nosniff`, `Strict-Transport-Security: max-age=15552000; includeSubDomains` (no `preload` — founder decision), `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin` (app-wide; Batch 7's stricter `/invite` block keeps `no-referrer`). **Nonce-based CSP is out of scope**: it needs `proxy.ts` + dynamic rendering (outside G3; `/policies/[key]` is static) — recorded as the post-beta hardening option. **Enforcement flip**: the CSP ships Report-Only; after `npm run docker:smoke` + a manual page-load check on the deployed stack (no E2E exists — RR-14), the operator renames the header to `Content-Security-Policy` in one commit — **recorded as a release-checklist row** (Task 9). `tests/unit/security-headers.test.ts` verifies the **EFFECTIVE** headers per path: import the `headers()` array from `next.config.ts`, iterate it applying last-match-wins, and assert — `/uploads/x` receives Batch 4's `nosniff` + `default-src 'none'; sandbox` CSP and **not** the app policy; `/` and `/policies/terms` receive the Report-Only CSP + `nosniff` + HSTS + `X-Frame-Options: DENY`; `/invite/x` keeps `Referrer-Policy: no-referrer`; **no path receives two conflicting CSP values**; HSTS at nginx (`docs/deployment.md` §3) stays a deploy-checklist item (the app header is defense-in-depth for direct hits).
4. **Secrets/env review** — `.env.example` ↔ `src/lib/env.ts` parity (every required key documented + validated; `ADMIN_MFA_ENCRYPTION_KEY` base64-32 validation from Batch 2; `PRODUCT_EVENT_PSEUDONYM_KEY` from Batch 5); repo scan for committed secrets (`rg` for key shapes in tracked files — `git ls-files` piped); `.env` chmod 600 + gitignored; compose fail-fast interpolation (`${VAR:?…}`) verified; `FINANCIAL_FEATURES_ENABLED=false` scan re-run.
5. **§7.1 rate-limit inventory** — the 13 endpoints (login, verification, OTP request, OTP verify, password recovery, account recovery, report, chat, image upload, search, listing mutation, Deal mutation, beta invite acceptance) → implementation (file + rule constant) + covering test + the **single-instance in-memory limitation** (RR-1: restart resets, no cross-instance, CGNAT buckets) + the nginx `limit_req` edge layer; any endpoint lacking a limit = a finding (fix in the owning module or record).
6. **Known residual risks verified** — RR-2 (TOTP replay: no durable consumed column — record as accepted + the compensating controls; a durable column is a new plan), RR-3 (phone-verify race: the playbook query exists — run it), RR-4 (login-vs-reset race: recorded accepted), RR-5 (**the 34-unit province registry**: `src/lib/provinces.ts` exists with exactly 34 units per FD-1 — `rg "PROVINCE_CODES" src` hits classified: the module legitimately exports a 34-unit `PROVINCE_CODES` code→displayName map, so the scan is for the **obsolete 63-unit list** (pre-2025 legacy province names used as codes), not for the symbol), RR-19 (the dev OTP inbox route dead in production — re-run the Batch 2 test), RR-21 (invite token-in-URL — the cookie flow + `Referrer-Policy` verified), RR-22/RR-23 (wishlist rows on non-approved listings; forgotten `markSold` — recorded display/ops behavior).
7. **CSRF posture (the explicit gap-fill)** — record the repo posture with evidence **in this doc's §CSRF section** (the abuse-matrix row cites `docs/operations/private-beta-security-review.md §CSRF`): Next.js 16 server actions are POST-only with built-in origin protection (the installed framework docs cited, `next` exact-pinned 16.3.7); no custom token layer (consistent with Batches 2–7); the row's status = `covered (framework posture, documented)`.
8. **Findings register** — a **fixed-format** table `| Severity | Status | File | Finding | Recommendation | Blocks launch |` (severity `CRITICAL|HIGH|MEDIUM|LOW`, status `OPEN|RESOLVED|ACCEPTED` — the release gate greps it case-insensitively for `| CRITICAL |` + `| OPEN |` rows and **fails when the section header is absent**); every finding recorded; **critical OPEN findings block the gate** (§9: "no known critical security issue"). Seed findings from the review itself: the FD-R58 observations (`session.revoke` has no rank check — operations_admin can revoke a super_admin's sessions; `regenerateRecoveryCodesAction` accepts a recovery code as proof — a single leaked code regenerates 10), the auth-abuse monitoring blindness (failed logins/MFA failures have no `AuditEvent` — Global Constraints), the Report-Only CSP state, and anything the matrix/audit/scans surface.

- [ ] **Step 3: Run the matrix + headers + XSS tests**

Run: `npm test -- tests/unit/abuse-matrix.test.ts tests/unit/security-headers.test.ts tests/unit/chat-surface-xss.test.ts` → PASS (a FAIL = the doc/test drift, a missing header, or a chat-surface XSS sink — fix the doc/config/owning file, never weaken the test).
Run the recorded commands: `npm audit --omit=dev`, the `rg` scans, the RR-3 query, the Batch 2 dev-inbox test — paste outputs into the doc.

- [ ] **Step 4: Commit**

```bash
git add docs/operations/private-beta-security-review.md tests/unit/abuse-matrix.test.ts tests/unit/security-headers.test.ts tests/unit/chat-surface-xss.test.ts next.config.ts
git commit -m "test(security): abuse matrix, headers, and launch security review"
```

## Task 9: Private-beta release checklist + release gate

**Files:**

- Create: `docs/operations/private-beta-release-checklist.md`
- Create: `scripts/release-gate.sh`
- Modify: `package.json` (one entry: `"release:gate": "bash scripts/release-gate.sh"`)
- Test: `tests/unit/release-gate-checklist.test.ts` (the checklist parse logic — see below)

**Interfaces:**

- Consumes: `scripts/preflight.sh`, `scripts/test-integration.sh`, `scripts/smoke.sh`, `scripts/policy-hash.ts` (Task 1), every evidence file (Tasks 1, 3–8), the batch verification docs.
- Produces: the machine-checkable §12 + §9 Batch 8 gate.

- [ ] **Step 1: Write the release checklist doc**

`docs/operations/private-beta-release-checklist.md` — a table mapping **every §12 readiness criterion and every §9 Batch 8 gate item** to evidence, machine-parseable row format:

```text
| Ref | Criterion | Evidence type | Evidence | Status | Sign-off |
```

- One row per §12 criterion (all public financial behavior unavailable; public copy accurate; seller verification works; publication gate; beta cohort gate; admin MFA; RBAC; report/block; moderation; recovery; audit; portable-speaker listing flow critical-E2E; search→listing→chat loop critical-E2E; telemetry without raw PII; the six policies have recorded reviews; monitoring exists; incident escalation; support path; restore drill; no known critical security finding) + the §12.1 supply-readiness rows (founding-seller workflow operational; seller target reached or approved; inventory target; 100–300 quality listings supportable; core model coverage reviewed; listing quality sampled; seller response monitoring; moderation/support capacity) + the §9 Batch 8 gate rows (no known critical security issue; restore drill successful; admin MFA operational; RBAC operational; moderation operational; report/block operational; seller verification operational; legal/operations sign-offs recorded; founding seller process ready; supply readiness approved) + **the CSP enforcement-flip row** (Report-Only → enforced after `docker:smoke` + manual page-load — Task 8).
- **The Founder Decision Register mirror section** (B3): a second table `| FD | Item | Decision (founder) | Date |` with **one row per Blocking=YES register item** (the current blocking set: FD-R1, R2, R3, R4, R6, R7, R8, R11, R12, R14, R15, R16, R17, R20, R21, R23, R24, R28, R29, R30, R33, R34, R48, R50, R59 — **generated from the plan's register table, never hand-maintained**: `tests/unit/release-gate-checklist.test.ts` parses the plan's register for `**YES**` rows and asserts the mirror contains exactly those IDs, so a register change without a mirror update fails the test). Each mirror row starts `PENDING`; the founder's dated decision/resolution (or explicit acceptance) fills it.
- **Evidence** names the test suite / doc / script output per row (e.g. `tests/unit/financial-shutdown-*.test.ts` + smoke; `docs/operations/policy-review-record.md`; `restore-drill-evidence.md`; the batch verification docs).
- **Status** is exactly one of `PASS` / `PENDING` / `FOUNDER` (a founder-decision row); **Sign-off** is founder-only (never filled by an implementer).
- **The two §12 E2E rows are `FOUNDER` rows carrying FD-R59** (S8): the repo has no E2E infrastructure (RR-14) and Batch 8 does not add one — the founder must **either** explicitly accept the recorded posture (action-level unit + real-DB integration coverage) **or** commission the minimal Playwright E2E batch for the two flows as a pre-invite prerequisite. Signing them off as machine-passed would be a spec deviation — the row makes the deviation founder-owned.

- [ ] **Step 2: Write the release-gate script**

`scripts/release-gate.sh` (`set -Euo pipefail`, the preflight.sh gate pattern — every gate runs, failures accumulate, summary at the end, non-zero exit on any red; **`grep`-based parsing with explicit exit-code handling — no `rg` dependency on the server**):

1. `preflight` — `scripts/preflight.sh` (the 7 existing gates).
2. `integration` — `scripts/test-integration.sh`.
3. `smoke` — `scripts/smoke.sh`.
4. `dependency-audit` — `npm audit --omit=dev` → fail on any critical/high runtime finding.
5. `policy-reviews` — for each of the six policies: `npx tsx scripts/policy-hash.ts --check` prints `<key> <version> <sha256> <status>`; the gate requires `status === "REVIEWED"` **and** a `docs/operations/policy-review-record.md` row with the same version + hash, a non-empty Reviewer/Date, and **Decision == `APPROVED`** (exactly — a `REJECTED`/`PENDING` row must not pass) — **any mismatch/unreviewed policy → FAIL with the policy key** (Review Focus 1 — the §9 "legal/operations sign-offs recorded" gate, machine-checked).
6. `evidence-files` — the required docs exist and are non-empty: `restore-drill-evidence.md` (with a dated PASS section), `admin-access-review.md` (with sign-off), `private-beta-security-review.md` (**the findings register parse**: the `## Findings register` section header must exist — **its absence FAILs the gate** — and the fixed-format table must contain no row matching `\| CRITICAL \| ... \| OPEN \|` case-insensitively), the seven batch verification docs, the playbooks (Tasks 3–4), `monitoring-signals.md`.
7. `release-checklist` — parse `private-beta-release-checklist.md`: **zero `PENDING` rows in both tables**; `FOUNDER` rows allowed only with a non-empty Sign-off cell (the founder's dated acceptance — FD-3's "explicitly accepted" path); **every FD-mirror row requires a non-empty Decision + Date** (B3 — the gate does not pass while any blocking register item is undecided).
8. `finance-off` — `grep -n "FINANCIAL_FEATURES_ENABLED" .env.example docker-compose.prod.yml` → `"false"` everywhere (the Batch 1 invariant, re-checked at the gate).
9. `abuse-matrix` — `npm test -- tests/unit/abuse-matrix.test.ts tests/unit/copy-safety.test.ts tests/unit/policy-registry.test.ts tests/unit/release-gate-checklist.test.ts` (the Batch 8 contract tests — including the register-mirror derivation — run inside the gate).

- [ ] **Step 3: Write the checklist-parse test + wire package.json**

`tests/unit/release-gate-checklist.test.ts`: the row-format parser as a pure function **inside the test file** (a tiny `parseChecklistRows(markdown)` — test-only logic; the bash gate greps the checklist itself, so no `src/lib` module is added) — `PASS` rows pass; `PENDING` rows fail; `FOUNDER` rows pass only with non-empty sign-off (Review Focus 6). **The register-mirror derivation (B3)**: the test also parses `docs/superpowers/plans/2026-10-06-private-beta-batch-8-launch-gate.md`'s register table for `| FD-R<n> |` rows whose Blocks-launch cell is `**YES**`, and asserts the checklist's FD-mirror section contains **exactly** those IDs — the blocking set is derived mechanically, never hardcoded (the register-size sentence in the plan states the derived count and is updated in the same commit whenever the register changes). `package.json` gains `"release:gate": "bash scripts/release-gate.sh"` (scripts block, alphabetical).

- [ ] **Step 4: Run the gate (expect FAIL — policies unreviewed)**

Run: `npm run release:gate` → **expected: FAIL at the `policy-reviews` gate** (the placeholders are DRAFT-NOT-REVIEWED — the gate correctly blocks release; this is the Task 1 blocking test at the script level) **and at the FD-mirror rows** (every blocking register item starts `PENDING`). Record the output in the Task 10 verification doc: **the gate must fail while policies are unreviewed and while blocking founder decisions are unsigned** — that is the designed behavior, and the founder's policy reviews + register decisions + checklist sign-offs are what turn it green.

- [ ] **Step 5: Commit**

```bash
git add docs/operations/private-beta-release-checklist.md scripts/release-gate.sh package.json tests/unit/release-gate-checklist.test.ts
git commit -m "feat(gate): private-beta release checklist and release gate"
```

## Task 10: Batch 8 gate verification + verification doc

**Files:**

- Create: `docs/operations/private-beta-batch8-launch-gate-verification.md`

- [ ] **Step 1: Run every gate suite and record results**

```bash
npm test -- tests/unit/policy-registry.test.ts          # policy mechanism + DRAFT block
npm test -- tests/unit/copy-safety.test.ts              # §4.2/§4.7 permanent scan
npm test -- tests/unit/ops-alerts.test.ts               # monitoring decision logic + no-PII + FINANCE_TABLES drift
npm test -- tests/unit/admin-access-review.test.ts      # access-review findings + no-PII
npm test -- tests/unit/abuse-matrix.test.ts              # §10.1 mapping machine-checked (keyed titles)
npm test -- tests/unit/security-headers.test.ts          # §7.4 EFFECTIVE headers per path (last-match-wins)
npm test -- tests/unit/chat-surface-xss.test.ts          # the chat XSS gap-fill source contract
npm test -- tests/unit/release-gate-checklist.test.ts    # checklist parse + the register-mirror derivation
npm test                                                # full unit suite (Batch 1–7 green)
npm run test:integration                               # every Batch 1–7 integration suite green
bash scripts/restore-drill.sh                           # the drill PASSes (evidence pasted)
npx tsx scripts/ops-alerts.ts                            # dev dry run output recorded
npx tsx scripts/admin-access-review.ts                  # dev review output recorded
npm run release:gate                                    # EXPECTED FAIL at policy-reviews + FD-mirror PENDING (designed block)
```

- [ ] **Step 2: Backend-enforcement + copy source scan** (spec §4.5/§4.2/§4.8 — every line states its expected result)

```bash
rg -n "FINANCIAL_FEATURES_ENABLED" .env.example docker-compose.prod.yml scripts   # expect: "false" everywhere
rg -n "dangerouslySetInnerHTML" 'app/policies/[key]/page.tsx' src/content          # expect: 0 hits
rg -n "đảm bảo|bảo đảm|bảo hiểm|escrow" src/content/policies                      # expect: 0 affirmative hits (negation lines only if quoted)
rg -n "PROVINCE_CODES" src                                                          # expect: only src/lib/provinces.ts's 34-unit
                                                                                     # code→displayName map (FD-1) — classify every hit; any
                                                                                     # pre-2025 legacy-name-as-code remnant is a finding (RR-5)
rg -n "requireCapability|requireAdminUser" scripts                                  # expect: 0 hits (scripts are offline, no HTTP surface)
git ls-files | rg "\.env$|\.pem$|secret"                                             # expect: no tracked secrets
```

Manually classify every hit; fix any violation in its owning file.

- [ ] **Step 3: Full preflight + build + smoke**

```bash
npm run lint
npx tsc --noEmit
npm test
npm run test:integration
npm run build
npm run preflight        # contract-emit drift + lint + typecheck + unit + build + compose + migration graph
npm run smoke            # local safe smoke — finance denial + retired pages unchanged
npm audit --omit=dev     # runtime clean
```

- [ ] **Step 4: Diff/status audit**

- `git diff --check`; `git status --short` contains only Batch 8 files; no `.claude/settings.json`, no `public/uploads/`, no `backups/` dumps, no secrets, no scratch.
- `npx prisma migration list` shows the **identical graph as before Batch 8** (G2 — no migration added); `npx prisma db verify` clean.

- [ ] **Step 5: Write the verification doc**

`docs/operations/private-beta-batch8-launch-gate-verification.md` records: base (merged Batch 7 commit) and final commit hashes; OpenCode model/session metadata; per-gate test results (the ten §9 Batch 8 gate items → the evidence rows, verbatim mapping); the release-gate output **including the expected policy-reviews FAIL and the FD-mirror PENDING rows** (the designed block — with the exact founder steps that turn it green: the six policy reviews + APPROVED record rows + the blocking-register decisions + checklist sign-offs); the Founder Decision Register status — **the row and blocking counts as derived at execution time by `tests/unit/release-gate-checklist.test.ts` from the register table (never a hardcoded number), with each blocking row's resolution-or-acceptance state**; the Residual Risk Register verification (RR-1–RR-23 each re-verified with its command output); the security review summary (matrix status, audit output, the Report-Only CSP state + the enforcement-flip checklist row, findings register); the drill evidence pointer; the admin access review pointer; the monitoring dry-run output; the playbook factual-accuracy pass results; deferred items (§13 out of scope; the post-beta decisions: TOTP durable column, verified-phone index, retention automation, the Playwright E2E batch if FD-R59 chooses it, buyer invitations per §12.1); and the explicit statement that **the Batch 8 implementation gate passing ≠ launch**: launch additionally requires the founder's policy reviews (FD-R34), **every blocking register item resolved or explicitly accepted (the mechanically-derived blocking set — FD-R1…FD-R59's YES rows)**, and the release checklist sign-offs — the release gate stays red until then, by design.

- [ ] **Step 6: Commit**

```bash
git add docs/operations/private-beta-batch8-launch-gate-verification.md
git commit -m "test(batch8): verify launch gate"
```

## Acceptance Gate

Batch 8 is accepted only if all of the following are true (spec §9 Batch 8 Gate — every item maps to named evidence):

- **No known critical security issue** — `docs/operations/private-beta-security-review.md` findings register (fixed format) carries no `CRITICAL`+`OPEN` row; the §10.1 matrix is machine-checked (`tests/unit/abuse-matrix.test.ts` — all 29 rows present, every evidence path resolves, **every `@key` marker occurs in its cited file**); `npm audit --omit=dev` clean of runtime critical/high; the §7.4 **effective**-headers contract passes (`tests/unit/security-headers.test.ts` — `/uploads` keeps Batch 4's CSP, app routes get the Report-Only CSP + `nosniff`/HSTS/frame protection); the chat-surface XSS gap-fill passes (`tests/unit/chat-surface-xss.test.ts`); the RR-2/3/4/5/21/22/23 residual risks are re-verified with recorded output.
- **Restore drill successful** — `bash scripts/restore-drill.sh` PASSes end-to-end (in-container backup → restore-into-new → verification queries → parity — no host pg tools), with dated evidence in `docs/operations/restore-drill-evidence.md`; measured durations recorded (no invented RPO/RTO targets — FD-R36).
- **Admin MFA operational** — `scripts/admin-access-review.ts` (DB reach via `docker exec loaviet-db psql` in production) enumerates every `adminRole` holder with MFA enrollment, unused recovery-code counts, and session inventory; every admin without MFA is a finding; the sign-off template is recorded (`docs/operations/admin-access-review.md`, dated sections); the Batch 2 MFA suites re-run green.
- **RBAC operational** — the Batch 2 `rbac.test.ts` matrix + every Batch 3–7 capability suite re-run green unchanged; the security review's RBAC inventory documents the fail-closed Scoped/Exceptional cells (FD-R2) **and the FD-R58 observations** (`session.revoke` no rank check; recovery-code-as-proof for regeneration).
- **Moderation operational** — the Batch 3 moderation suites re-run green; `docs/operations/moderation-playbook.md` documents the queue, the suspension hand-off, recusal, evidence handling (§5.5.1), appeal intake (+ the notification gap), the PROVISIONAL sanction taxonomy (FD-R12), and the placeholder moderation copy (FD-R50).
- **Report/block operational** — the Batch 3 block/report suites re-run green (nothing in Batch 8 touches them — the re-run is the evidence).
- **Seller verification operational** — the Batch 2/4 verification + publication-gate suites re-run green; `docs/operations/seller-verification-playbook.md` carries the §5.3.3 checklist + the RR-3 duplicate-phone query.
- **Legal/operations sign-offs recorded** — the mechanism ships: six versioned policy pages, the registry (status in the registry, hash over `POLICY_TEXT` only), the review-record template, and **the release gate FAILS while any policy is unreviewed or any record row's Decision != APPROVED** (`npm run release:gate` → policy-reviews red — the designed block; `tests/unit/policy-registry.test.ts` pins the logic). No legal text is implementer-authored (the placeholder-contract test). The founder's actual reviews/sign-offs (incl. the FD-R4 Seller-Rules version bump) are the launch step, not a Batch 8 commit.
- **Founding seller process ready** — `docs/operations/founding-seller-onboarding-checklist.md` + `concierge-onboarding-playbook.md` + `model-seed-review-procedure.md` cover the §5.10 lifecycle, the §5.10.1 responsibility split, the invite cookie flow (RR-21), and the Batch 4 pending-model review; the Batch 7 console suites re-run green.
- **Supply readiness approved** — the release checklist's §12.1 rows exist with evidence + founder sign-off fields; the approval itself is the founder's (FD-R30) — the checklist records it, the gate enforces it is not `PENDING` **and that every blocking FD-mirror row carries a dated founder decision (B3)**.
- **Monitoring exists** — `scripts/ops-alerts.ts` + `docs/operations/monitoring-signals.md` cover health, error rate, auth abuse (with the failed-login blindness recorded), the **`pg_stat_user_tables` tuple-delta finance-boundary watermark** (unit-tested CRITICAL path — catches status UPDATEs, DELETEs, raw SQL; `FINANCIAL_FEATURES_ENABLED` read from the deployed app container), cron/backup freshness; no PII in any alert line (tested); the `FINANCE_TABLES` drift test passes; thresholds are marked founder items; no third-party SaaS added.
- **Incident escalation exists** — `docs/operations/incident-playbook.md` (severity, comms, §5.5.1 evidence preservation with `db-ops.sh backup` snapshots, the finance-boundary runbook).
- **Batches 1–7 preserved** — every earlier suite green unchanged; `FINANCIAL_FEATURES_ENABLED=false`; the migration graph identical (G2); no Batch 2–7 lib module edited (G4 — except the FD-R4 founder-commit bump); `scripts/db-ops.sh`/`backup-db.sh`/`restore-db.sh` consumed as shipped.
- Preflight (lint, typecheck, unit, build, compose, migration graph), the integration suite, safe smoke, `npm audit --omit=dev`, the restore drill, and a clean diff/status audit all pass; the release gate runs and correctly blocks on unreviewed policies **and unsigned blocking founder decisions**.

## Threat-Case Coverage Map (spec §10.1 — the full matrix, mapped to the covering batches' tests)

The §10.1 rows and their covering tests, as the security review doc (Task 8) records them and `tests/unit/abuse-matrix.test.ts` machine-checks. **Every row's test must exist and run green at Batch 8 execution time** — a missing test is a G5 finding (fix in the owning module, never re-implement).

| Abuse case (spec §10.1) | Covering batch | Evidence test |
|---|---|---|
| Unauthorized listing edit | B4 | `tests/unit/listing-draft-actions.test.ts` (submit IDOR) + `publication-gate.test.ts` ownership fixtures |
| Listing IDOR | B2/B4/B6 | `tests/unit/listing-draft-actions.test.ts` (submit/toggle/delete ownership — other-seller draft → silent refusal) + `tests/unit/publication-gate.test.ts` (ownership fixtures on every transition) + `tests/unit/chat-hardening.test.ts` (the listing-status gate on the chat/wishlist entry points — B6 Task 3) |
| Deal IDOR | B6 | `tests/unit/deal-create.test.ts` + `tests/unit/deal-outcome.test.ts` (`DEAL_FORBIDDEN`) |
| Moderation-resource IDOR | B3 | `tests/unit/moderation-pages.test.ts` + `tests/unit/moderation-actions.test.ts` + `tests/unit/appeal-actions.test.ts` |
| Privilege escalation | B2 | `tests/unit/rbac.test.ts` (matrix) + per-action FORBIDDEN tests (B3–B7) |
| Support → admin escalation | B2/B3 | `tests/unit/rbac.test.ts` + `tests/unit/moderation-actions.test.ts` + `tests/unit/suspension-actions.test.ts` |
| OTP brute force | B2 | `tests/unit/otp.test.ts` (attempt limit) |
| OTP resend flooding | B2 | `tests/unit/otp.test.ts` (cooldown + per-target) |
| Account enumeration | B2/B7 | `tests/unit/recovery-actions.test.ts` (neutral message) + `tests/unit/founding-seller-invite.test.ts` (byte-identical `INVITE_INVALID`) |
| Session fixation | B2 | `tests/unit/session.test.ts` (fresh token per login) |
| Session reuse after recovery | B2 | `tests/unit/recovery-actions.test.ts` (revoke all) + `tests/unit/session.test.ts` (revoked lookup) |
| CSRF state-changing action | posture + B8 | `docs/operations/private-beta-security-review.md` §CSRF (the documented posture: Next.js 16 server actions POST-only + origin protection, exact-pinned 16.3.7; no custom token layer — the B2–B7 posture) — the row cites the doc section, not a test file |
| Stored XSS through listing | B4 | `tests/unit/sell-pages.test.ts` (source contract) + the recorded `dangerouslySetInnerHTML` scan in `docs/operations/private-beta-batch4-listing-quality-verification.md` (React text rendering — description never rendered as HTML) |
| Stored XSS through chat | B6 + B8 | `tests/unit/chat-surface-xss.test.ts` (the Batch 8 gap-fill source contract: zero `dangerouslySetInnerHTML`/HTML sinks in `chat-window.tsx`/`'app/chat/[id]/page.tsx'`, message bodies React text) + `tests/unit/deal-ui.test.ts` (the Deal-side contract) |
| Stored XSS through report | B3 | `tests/unit/moderation-pages.test.ts` (zero `dangerouslySetInnerHTML` in console/appeal/report surfaces) |
| Malicious image upload | B4 | `tests/unit/image-process.test.ts` (polyglot neutralized, SVG rejected) |
| MIME spoof | B4 | `tests/unit/image-validate.test.ts` (magic/format cross-check) + `tests/unit/upload-route.test.ts` |
| Image decompression bomb | B4 | `tests/unit/image-process.test.ts` (50MP/12kpx caps) |
| Blocked-user chat bypass | B3/B6 | `tests/unit/chat-guard.test.ts` + `tests/integration/block-enforcement.test.ts` + B6 Deal-path delegation tests |
| Suspended-user publication bypass | B3/B4 | `tests/unit/publication-gate.test.ts` (all four surfaces) + `tests/integration/suspension-enforcement.test.ts` |
| Revoked-seller publication bypass | B2/B4 | `tests/unit/publication-gate.test.ts` + `tests/unit/seller-verification-policy.test.ts` |
| Beta-cohort bypass | B2/B4/B7 | `tests/unit/seller-verification-policy.test.ts` (membership in the publication gate) + `tests/unit/suspended-membership-enforcement.test.ts` (all four publication surfaces) + `tests/unit/founding-seller-invite.test.ts` (channel binding, atomic claim) + **`tests/unit/chat-beta-gate.test.ts` + `tests/unit/deal-beta-gate.test.ts`** (the Batch 7 buyer gate on new chat + Deal creation) + `tests/unit/beta-access.test.ts` (`isActiveBetaParticipant`) |
| Concurrent seller-verification update | B2 | `tests/unit/seller-verification-actions.test.ts` (`VERIFICATION_ALREADY_REVIEWED`) |
| Concurrent Deal status update | B6 | `tests/unit/deal-outcome.test.ts` + `tests/integration/deal-lifecycle.test.ts` (`Promise.all` races) |
| Financial direct route | B1 | `tests/unit/finance-public-surface.test.ts` (retired pages 404) + `scripts/smoke.sh` |
| Financial API mutation | B1 | `tests/unit/financial-shutdown-actions.test.ts` + `financial-shutdown-routes.test.ts` (503 typed) |
| Financial webhook processing | B1 | `tests/unit/ipn-route.test.ts` (503 before parse) |
| Financial cron execution | B1 | `tests/unit/cron-auto-release-route.test.ts` (503 typed before release) |
| Historical finance escape-hatch abuse | B1 | `tests/unit/admin-finance-readonly.test.ts` + `tests/integration/escrow.test.ts` + B6 `deal-finance-isolation.test.ts` |

Batch 8's own additions to the matrix evidence: `tests/unit/policy-registry.test.ts` (the policy mechanism), `tests/unit/copy-safety.test.ts` (§4.2 — the misleading-promise row's permanent guard), `tests/unit/security-headers.test.ts` (§7.4 — the effective-headers contract), `tests/unit/chat-surface-xss.test.ts` (the chat XSS gap-fill), `tests/unit/ops-alerts.test.ts` (the finance-boundary detection), `tests/unit/abuse-matrix.test.ts` (the mapping itself). **Every evidence cell in the doc carries a `@<key>` marker** (a keyed test title or typed error string that must occur in the cited file — S6) so the machine check proves content, not just existence.

## Ambiguities and Deployment Prerequisites

Recorded per spec §4.11 + §11.1 — none is silently resolved by implementation; each is handled fail-closed/marked and needs a founder decision as noted (the full cross-batch register is the **Founder Decision Register** above; these are Batch 8's own):

1. **A1 — BLOCKING (the central gate): the six policy texts are founder-authored.** The mechanism ships with `DRAFT-NOT-REVIEWED` placeholders; the release gate fails until the founder reviews and records each policy (FD-R34). No implementer authors legal text (§4.11) — the placeholder-contract test enforces it.
2. **A2 — Monitoring thresholds are unspecified by the spec.** Proposed defaults ship as clearly-marked constants (`DEFAULT_THRESHOLDS` — FD-R35); the alert logic is threshold-parameterized so a founder tuning is a constant change, never a logic change.
3. **A3 — RPO/RTO targets are unspecified.** The drill *measures* restore duration and backup freshness and records them (FD-R36); no pass/fail target is invented.
4. **A4 — Alert delivery channel is unspecified.** Log lines + non-zero exit ship (FD-R37); email/Telegram/etc. is a deploy-time integration through the `observability.ts` seam (the existing vendor-neutral comment is the integration point).
5. **A5 — Incident severity thresholds are unspecified.** Proposed SEV1–3 defaults marked (FD-R38); the playbook's escalation paths are procedural, the thresholds founder-tunable.
6. **A6 — The §12 critical-E2E criteria are a BLOCKING founder decision, not a silent posture sign-off (S8).** The spec lists "portable-speaker listing flow passes critical E2E" and "search→listing→chat loop passes critical E2E" as readiness criteria; the repo has no E2E infrastructure (RR-14) and Batch 8 does not add one — **the chosen resolution is FD-R59**: a blocking register row (mirrored into the release checklist) forcing the founder to **either** explicitly accept the recorded posture (action-level unit + real-DB integration coverage, dated sign-off) **or** commission the minimal Playwright E2E batch for the two flows as a pre-invite prerequisite. Justification: a Playwright suite is a new test subsystem (browsers, config, CI wiring) deserving its own reviewed plan — coupling it to the launch-gate batch would mix two reviews and breach the G3 perimeter; the deviation from §12 must be founder-owned, never implementer-waved. Batch 8 does not silently mark §12's E2E criteria as machine-passed.

## Rollback and Data Backfill

- **No migration, no backfill (G2).** Batch 8 adds no schema change; `npx prisma migration list` is identical before and after. The §8.6 backfill requirements are satisfied trivially (nothing to backfill).
- **Per-task rollback**: every task is one focused commit; `git revert <task-commit>` removes the surface. Task 1's revert removes the policy pages/registry (Batch 2's `PolicyAcceptance` rows are untouched — they reference keys/versions, not the registry). Task 8's header revert restores the pre-Batch-8 `next.config.ts` (Batch 4's `/uploads` and Batch 7's `/invite` blocks were never edited; the Report-Only CSP goes with it). The FD-R4 `SELLER_RULES_POLICY_VERSION` bump reverts with the founder's review commit (its record row reverts in the same commit). Task 9's revert removes the release gate (no runtime effect).
- **Scripts are non-mutating by design**: `ops-alerts.ts` (read-only queries via `docker exec loaviet-db psql` + a state file under `backups/`), `admin-access-review.ts` (read-only, same IO seam), `policy-hash.ts` (read-only), `restore-drill.sh` (scratch containers + restore-into-new — the `restore-db.sh` never-overwrite principle; production data is never touched by the drill). The only writes are to gitignored state/evidence locations.
- **Evidence files** are docs — a bad entry is a doc edit, never a data operation.
- **Release gate**: a red gate is information, not a state — nothing to roll back; the gate is re-run after the founder's sign-offs.

## Final Acceptance Commands

```bash
npm run lint
npx tsc --noEmit
npm test
npm run test:integration
npm run build
npm run preflight
npm run smoke
npm audit --omit=dev               # runtime sạch — không critical/high
npx prisma migration list          # graph: baseline → … → batch7 — GIỐNG HỆT trước Batch 8 (G2)
npx prisma db verify               # marker + schema khớp contract
bash scripts/restore-drill.sh      # drill PASS — evidence vào restore-drill-evidence.md
npx tsx scripts/ops-alerts.ts      # dry run dev — output ghi vào verification doc
npx tsx scripts/admin-access-review.ts   # dev review — output ghi vào verification doc
npm run release:gate               # EXPECTED: FAIL tại policy-reviews + các FD-mirror row PENDING
                                    # (block thiết kế — §9 "legal sign-offs recorded" + B3)
git diff --check && git status --short
```

All green (with the release gate's policy-reviews FAIL and the unsigned FD-mirror rows being the designed, recorded block) + the ten §9 Batch 8 gate evidence rows in Task 10 Step 1 + a clean diff/status audit = Batch 8 complete. **Batch 8 complete ≠ launch**: launch additionally requires the founder's six policy reviews (FD-R34, Decision == APPROVED + the FD-R4 version bump), **every blocking Founder Decision Register item resolved or explicitly accepted (the mechanically-derived blocking set — FD-R1…FD-R59's YES rows, incl. FD-R59's E2E choice)**, the CSP enforcement flip after `docker:smoke` + manual page-load, and the release checklist sign-offs — after which `npm run release:gate` exits 0. Per spec §17: *Built + Authorized + Secured + Tested + Observable + Operationally Supportable + Policy Reviewed + Recoverable.*
