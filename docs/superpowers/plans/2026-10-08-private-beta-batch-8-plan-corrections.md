# Batch 8 plan corrections (checked against `beta/batch7-cohort-ops` @ `308b7fd`, 2026-10-08)

> **MANDATORY: this document overrides the plan text** (`docs/superpowers/plans/2026-10-06-private-beta-batch-8-launch-gate.md`).
> Every file:line below was read on `beta/batch7-cohort-ops` (`git show beta/batch7-cohort-ops:<path>`), unless the item names another branch or the **merged tree**.
> **Merged tree** = the result of applying the early Batch 8 work to `308b7fd` (§A). It was simulated with `git merge-tree` (tree `047dafab…`), extracted to a scratch dir, and tested there: full unit suite **2405/2406** (the one failure is item 2), `tsc --noEmit` clean apart from the typegen-only `PageProps`/`LayoutProps`/`RouteContext` names (item 14). Nothing in the repo was checked out, committed or installed.
> Early Batch 8 work lives on `local/b8-early-integration` (Tasks 1, 2, 5, 6, 7) and `local/b8-access-wrapper` (a strict subset of it). §A covers the merge. §B shows what is already done and what remains.

## Global rules (apply to every task; they override the plan)

- **This document overrides the plan.** Where they conflict, follow this document. A PROVISIONAL item ships with its fail-closed default and goes into the Founder Decision Register (§E). Do not block on it.
- **Staging:**
  - Never run `git add .` or `git add -A`. Add only the paths listed for the task.
  - Quote bracketed paths, e.g. `'app/policies/[key]/page.tsx'`.
- **Never stage:**
  - `.superpowers/` and `.claude/` (the whole directories);
  - `public/uploads/`, `data/uploads/`, `backups/` (dumps, `.ops-alerts-state.json`, `.ops-alerts-heartbeat`, `.drill-backup.*`, `ops-alerts.log`);
  - the drill's temporary seed file `scripts/.restore-drill-seed.<pid>.ts` (`scripts/restore-drill.sh:409`; the trap deletes it, but a crashed run can leave it behind);
  - secrets, `.env`, and scratch output.
- **`package-lock.json`:** never commit it unless dependencies actually change. Batch 8 adds **zero** packages; `package.json` changes only by the one `release:gate` script entry (Task 9). If a dependency change ever becomes unavoidable, regenerate the lockfile with **npm 10** (Node 22, `.github/workflows/ci.yml:16`) and commit it together with `package.json`.
  - Set up worktrees with `npm ci`. Never use `npm install`.
- **`FINANCIAL_FEATURES_ENABLED` stays `false`.** It is `false` in `.env.example:46`, `docker-compose.prod.yml:123` and `tests/docker/docker-compose.smoke.yml:66`.
  - No Batch 8 file imports a finance module.
  - No script writes a finance table. The drill's Order/OrderItem/Payment fixture is written only into its own **scratch** container.
- **The user deploys production; agents never do.** No agent runs anything against the production host:
  - no deploy;
  - no `docker compose … up` on the server;
  - no `restore-drill.sh --file` against production backups;
  - no `scripts/admin-access-review-prod.sh`;
  - no crontab install;
  - no CSP enforcement flip on the deployed stack.

  Each of these is a **release-checklist row the user signs** (Task 9). Agents run only:
  - the scratch drill;
  - dev-DB runs;
  - unit and integration suites;
  - `npm run smoke` / `docker:smoke` (isolated `sp-smoke-*` project, `scripts/docker-smoke.sh:18`).
- **No push, no merge to `main`.** Commit each task separately with the plan's message, plus the extra commits listed here.
- **G2 still holds:** no migration, no contract change and no ref edit. See item 3 for the exact graph.
- **G3 perimeter still holds.** App-code edits are limited to:
  - `next.config.ts` (Task 8);
  - `package.json` (Task 9, one line).

  Batch 7's "Batch 8 polish pass" hand-offs are **out of scope** (item 12).

---

## §A. Merge plan for the early Batch 8 branches

**Findings (verified):**

- **Branch relationships:**
  - `local/b8-access-wrapper` (`d9e1d15`) is an **ancestor of** `local/b8-early-integration` (merged at `3eddfe2`). Merging the early-integration branch brings in everything; the wrapper branch adds nothing extra.
  - `merge-base(b8-early-integration, beta/batch7-cohort-ops)` = `ebe82b8`, the old Batch 4 tree, which is already in Batch 7.
- **New non-merge commits** (`git log --no-merges beta/batch7-cohort-ops..local/b8-early-integration`), oldest first:
  - `ae5588e` docs(plan): add reviewed private-beta batch 3-8 plans. **SKIP.** The plans are already on Batch 7 as `209ae29`, with identical blobs for Batches 3, 5, 6, 7 and 8. Its Batch 4 plan blob is an **older** version (`b317422a` vs `188125e1`), so cherry-picking it would only add history noise or a stale-plan conflict.
  - `dd0f48d` feat(policies): versioned policy pages with review-gated release (Task 1)
  - `d76c2c5` test(copy): permanent no-misleading-promise scan (Task 2)
  - `d1fe883` fix(policies): neutral review status and stricter content tests (Task 1/2 review fix)
  - `3b07539` feat(ops): monitoring signals and finance-boundary alerts (Task 5)
  - `d067009` fix(ops): accurate finance-boundary signals (Task 5 review fix)
  - `d05b7ff` test(ops): scripted backup and restore drill (Task 6)
  - `4af534b` fix(ops): full verification in restore drill file mode (Task 6 review fix)
  - `d4f8d37` feat(ops): admin access review with sign-off (Task 7)
  - `d9e1d15` fix(ops): run admin access review inside the migrate image on production (Task 7 review fix)
  - `813cb8a` fix(ops): classify Batch 3/4 models in finance-boundary alerts
- **Textual conflicts: none.** I simulated the cherry-pick sequence below one commit at a time (`git merge-tree --merge-base=<c>^`). Every step was clean, and the final tree equals the plain `git merge` tree (`047dafab…`).
  - The only pre-existing file touched by both sides is `src/components/footer.tsx`, and Batch 7 never changed it after `ebe82b8`.
  - Batch 7 also never changed `next.config.ts`, `package.json`, `scripts/` or `docs/operations/` in ways that overlap these commits.
- **Semantic conflict: exactly one** (item 2). `tests/unit/ops-alerts.test.ts` › "MỌI model trong contract được phân loại…" fails on the merged tree with `model "ProductEvent" chưa được phân loại`. Six Batch 5–7 models are unclassified.
- **Stale-but-green artifacts** need refresh commits:
  - item 11: copy-safety "EARLY EXECUTION" branches;
  - item 9: drill and access-review evidence recorded on the Batch 2 graph;
  - item 16: writer line refs.

**Procedure (Wave 0, one session, serial). Cherry-pick, don't merge:**

```bash
git worktree add ../b8-launch-gate -b beta/batch8-launch-gate beta/batch7-cohort-ops   # base 308b7fd
cd ../b8-launch-gate && npm ci
git cherry-pick -x dd0f48d d76c2c5 d1fe883 3b07539 d067009 d05b7ff 4af534b d4f8d37 d9e1d15 813cb8a
```

Why cherry-pick:

- it gives a linear history;
- it keeps the plan's task commit messages (with `-x` provenance);
- it does not drag the duplicate `ae5588e` plan commit or the three merge commits rooted at the Batch 4 tree into the Batch 8 branch.

`git merge --no-ff local/b8-early-integration` gives a byte-identical tree and is an acceptable fallback.

Then make **one fix commit** containing items 2, 11, 16 and 20 (the monitoring doc subsection):

```bash
git add scripts/ops-alerts.ts tests/unit/ops-alerts.test.ts docs/operations/monitoring-signals.md tests/unit/copy-safety.test.ts
git commit -m "fix(ops): classify Batch 5-7 models and refresh early-execution references"
```

Gate before Wave 1:

- `npm test` is fully green;
- `npx next typegen && npx tsc --noEmit` is clean;
- `npm run lint` is clean.

Also commit this corrections doc first on the branch (`docs(plan): batch 8 corrections against the post-Batch-7 tree`), as Batch 7 did with `25e99a5`.

## §B. Plan tasks: already done by the early work vs remaining

| Task | Early-work status (merged tree) | Remaining in Batch 8 |
|---|---|---|
| 1 Policy registry + pages + footer + `policy-hash.ts` + review record | **Done** (`dd0f48d`+`d1fe883`). `tests/unit/policy-registry.test.ts` green. The six hashes from `npx tsx scripts/policy-hash.ts` on the merged tree are **byte-identical** to the rows in `docs/operations/policy-review-record.md:23-28` (all `PENDING`). `seller_rules` `v1` matches `SELLER_RULES_POLICY_VERSION` (`src/lib/seller-verification-policy.ts:38`). | Nothing. The FD-R4 `v1→v2` bump and the APPROVED rows remain **founder-only** (never an agent commit). |
| 2 Copy-safety scan | **Done** (`d76c2c5`). Green on the merged tree, including all Batch 6/7 surfaces (the conditional Batch 6 `safety-guidance.tsx` describe auto-activated). | Item 11: remove the early-execution branches. |
| 3 Operations playbooks | Not started | Full task. See items 6, 27–29. |
| 4 Incident playbook | Not started | Full task. See item 30. |
| 5 Monitoring + ops alerts | **Done** (`3b07539`+`d067009`+`813cb8a`), but **red on merge** | Item 2 (blocking), items 15–20. Dev dry run re-recorded on the merged tree. |
| 6 Restore drill | **Done** (`d05b7ff`+`4af534b`); evidence is on graph `baseline→batch2` | Item 9: re-run the scratch drill on the 9-dir graph and append dated evidence. The production `--file` drill is a user checklist row. |
| 7 Admin access review | **Done** (`d4f8d37`+`d9e1d15`); dev run dated 2026-10-06 on the Batch 2 tree | Item 9: re-run on the dev DB of the merged tree. The production run (`scripts/admin-access-review-prod.sh`) is a user checklist row. |
| 8 Security review + headers + XSS + abuse matrix | Not started | Full task. See items 4, 5, 10, 23–26, 35. |
| 9 Release checklist + gate | Not started | Full task. See items 7, 8, 31, 32. |
| 10 Verification doc | Not started | Full task. See items 3, 14, 33. |

---

## BLOCKING

1. **G1 base and register provenance.**
   - *Plan says (L39):* the register was built from the plan revisions `68f8778`/`c7ca1dc`/`6cf60c8`/`88d7c2d`/`581a114`; "Batch 8 executes only on the merged Batch 7 commit".
   - *Real:* the base is `beta/batch7-cohort-ops` @ `308b7fd`; the Batch 7 gate passed on `b3b0871` (`docs/operations/private-beta-batch7-cohort-operations-verification.md:9-27,519`). The **shipped** hand-offs live in the verification docs, not in the plan revisions:
     - Batch 2 §7 (`…batch2…verification.md:381-445`);
     - Batch 3 §8.1–8.3 (`…batch3…:393-456`);
     - Batch 4 §6 + §9 (`…batch4…:299-534`);
     - Batch 5 §10–12 (`…batch5…:497-585`);
     - Batch 6 §8–12 (`…batch6…:322-489`);
     - Batch 7 §9–11 (`…batch7…:392-500`).
   - *Correction:* the register is the plan's 59 rows **plus the §E updates** below (73 rows / 28 blocking). G8 (the land-before-Batch-7 fallback) no longer applies: Batch 7 has merged. Wave 0 (§A) runs first.

2. **Merge: the ops-alerts classification drift test fails on the merged tree.**
   - *Real:* there are 48 contract models; 42 are classified. `ProductEvent`, `SearchAlias` (Batch 5), `Deal`, `DealStatusHistory` (Batch 6), `FoundingSellerCandidate` and `BetaInviteToken` (Batch 7) are missing from `NON_FINANCE_TABLES` (`scripts/ops-alerts.ts:128-160` on the merged tree).
   - These are recorded merge actions:
     - Batch 5 verification `:563`;
     - Batch 6 verification `:472-480`;
     - Batch 7 verification `:480-492`.
   - *Correction (verified: with this edit `tests/unit/ops-alerts.test.ts` passes 49/49):*
     - **(a)** Append the six names after `"ListingImageUpload",` (`scripts/ops-alerts.ts:159`) with a comment, e.g. "Batch 5 telemetry/search, Batch 6 Deal, Batch 7 cohort ops: no FK to any finance table".
       - Evidence: `tests/integration/batch6-migration.test.ts` and `batch7-migration.test.ts` assert no op id matches the finance regex. Batch 7 verification §4 (`:160-171`) says the same.
     - **(b)** Extend the NON-FINANCE writer header comment (`:115-125`). Writers: `emitProductEvent` (`src/lib/product-events.ts`), `seed-search-aliases.ts`, `src/lib/actions/deals.ts`, `src/lib/actions/founding-sellers.ts`.
     - **(c)** In `docs/operations/monitoring-signals.md:145`, change "27 bảng còn lại" to **"33 bảng còn lại"** and add the six names. Totals: 9 finance-only + 3 cascade-affected (= 12 monitored, unchanged) + 36 non-finance = 48.
     - **(d)** Rewrite `monitoring-signals.md` §6 (`:216-231`, "Re-verify sau các batch sau (thực thi sớm)") as a **done** record: the merge commit, plus the rule that every future model must be classified in the batch that adds it.
     - `FINANCE_TABLES.length === 12` stays.

3. **G2 migration graph wording (Task 10 Step 4 and Final Acceptance Commands).**
   - *Plan says:* `baseline → batch2 → … → batch7`.
   - *Real:* there are **9 dirs**: `20261003T0448_baseline`, `20261006T0209_batch2_identity_security`, `20261006T1420_batch3_trust_safety`, `20261006T1902_batch4_listing_quality`, `20261007T1708_batch4_holistic_review_fixes`, `20261007T2007_batch4_round4_approved_content_backfill` (self-edge, provides `backfill-listing-approved-content-at`), `20261007T2208_batch5_search_telemetry`, `20261008T0237_batch6_chat_deal`, `20261008T1130_batch7_cohort_operations`.
     - `migrations/app/refs/db.json` and `refs/production.json` both hold `656449ac938c323b314580d07a280025d021e4694f6158f1b086ec2edf7b0fec`.
     - `production.json` carries `"invariants": ["backfill-listing-approved-content-at"]` (Batch 7 verification `:190-206`).
   - *Correction:*
     - Capture `npx prisma migration list` output **before** Wave 0 and at Task 10, and diff them: they must be identical.
     - Never run `migration ref set`. Batch 8 has no reason to; doing so wipes the invariant (pinned by `tests/unit/approved-content-backfill-migration.test.ts`).
     - `git diff 308b7fd -- migrations src/prisma` must be empty at Task 10.

4. **Task 8, the app-wide headers entry must come FIRST, not be appended.**
   - *Plan says:* "Task 8 appends the app-wide §7.4 headers", including `Referrer-Policy: strict-origin-when-cross-origin`. It also says `/invite/x` keeps `no-referrer`.
   - *Real:* "If two headers match the same path and set the same header key, the last header key will override the first" (`node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/headers.md:47`).
     - Appended after the Batch 7 `{ source: "/invite/:token", … Referrer-Policy: no-referrer }` block (`next.config.ts` on Batch 7, ~`:45-52`), an app-wide `Referrer-Policy` **overrides `no-referrer` on the token URL**. That reopens RR-21 and fails the plan's own effective-headers assertion.
   - *Correction:*
     - **Prepend** the app-wide entry as element `[0]` of the `headers()` array, with source `"/((?!uploads/).*)"`. The Batch 4 `/uploads/:path*` block and both Batch 7 `/invite` blocks then follow it unedited and win on their keys.
     - Keep the `/uploads` exclusion. CSP-Report-Only is a different key from `Content-Security-Policy`, so without the exclusion `/uploads` would receive **both**.
     - `tests/unit/security-headers.test.ts` must compute effective headers with last-match-wins across the whole array, and assert:
       - `/invite/AAAA…` → `Referrer-Policy: no-referrer` + `X-Robots-Tag: noindex`;
       - `/invite` → `strict-origin-when-cross-origin`, **not** `no-referrer` (Batch 7 corrections #8: `no-referrer` on `/invite` breaks the action POST origin check);
       - `/uploads/x` → only Batch 4's CSP, no Report-Only.
     - Existing pins stay green:
       - `tests/unit/upload-route.test.ts:791-806` finds by `source`, so it is order-independent;
       - `tests/unit/founding-seller-invite.test.ts:1936-1945` checks string presence.

5. **Task 8 Step 1b, the chat XSS contract as written fails on a safe, validated sink.**
   - *Plan says:* no `src={` interpolation of message content into an HTML sink.
   - *Real:*
     - `src/components/chat-window.tsx:121` renders `<img src={m.imageUrl} …>`. Message bodies are React text at `:123`.
     - The POST route validates `imageUrl` against `LISTING_IMAGE_URL_PATTERN` (`app/api/chat/[id]/route.ts:9,101-140`). `ChatWindow` never sends `imageUrl` (Batch 6 R6).
     - `src/components/chat-*.tsx` matches only `chat-window.tsx`.
   - *Correction:*
     - The test allows exactly that `m.imageUrl` image sink.
     - It **pins the route validation** by source-asserting that `LISTING_IMAGE_URL_PATTERN` is imported and used in the POST handler before `Message.create`.
     - It forbids `dangerouslySetInnerHTML`, `innerHTML` and `insertAdjacentHTML`, plus any `href={`/`src={` built from `m.body`, in `chat-window.tsx`, `app/chat/[id]/page.tsx`, `app/chat/page.tsx` and `src/components/deal-*.tsx`.
     - Add a **listing surfaces** describe, for the item 10 "Stored XSS through listing" gap: `app/listings/[slug]/page.tsx`, `app/seller/[id]/page.tsx`, `src/components/listing-card.tsx`, `src/components/portable-listing-form.tsx`. Assert zero HTML sinks in code lines, so comment hits don't count.

6. **Task 3 (seller-verification playbook) and Task 8 §6, the RR-3 "ops duplicate-phone review query" does not exist anywhere.**
   - *Plan says:* "run the playbook query"; Batch 2 verification `:391` says it "lives in the runbook".
   - *Real:* `git grep -n "HAVING\|duplicate-phone"` finds it in no runbook and no ops doc. Only the plans mention it.
   - *Correction:* the seller-verification playbook **authors** the query. It is read-only and run via `docker exec loaviet-db psql -U loaviet -d loaviet -tAc` (dev: `psql "$DATABASE_URL"`). It returns **counts and internal ids only, never phone values** (§4.8):
     `SELECT count(*) AS dup_groups, coalesce(sum(n),0) AS accounts FROM (SELECT count(*) n FROM "User" WHERE "phoneVerifiedAt" IS NOT NULL AND phone IS NOT NULL GROUP BY phone HAVING count(*) > 1) d;`
     plus a drill-down `SELECT array_agg(id) FROM "User" WHERE "phoneVerifiedAt" IS NOT NULL GROUP BY phone HAVING count(*) > 1;`.
     - Task 8 runs both on the dev DB and records the output.
     - `User.phone` is not unique (contract `User` model); email is `@unique`.

7. **Task 9, the register-mirror test must not parse the plan file.**
   - *Plan says:* `tests/unit/release-gate-checklist.test.ts` parses the plan's register table, and the plan's register-size sentence is "updated in the same commit".
   - *Real:* this corrections doc changes the register (§E). Editing the reviewed plan file is not allowed, and a test parsing the stale plan would derive the wrong blocking set (25 instead of 28).
   - *Correction:*
     - Task 9 creates **`docs/operations/founder-decision-register.md`**: the plan's register table plus every §E change, in the same `| FD-R<n> | Item | Source | Blocks launch? | Where recorded / verified |` format with `**YES**` markers.
     - The test parses that file and asserts the checklist's FD-mirror contains exactly its `**YES**` IDs.
     - The derived count is recorded in Task 10, never hardcoded.
     - Add the file to the Task 9 `git add`. The `evidence-files` gate also requires it to exist.

8. **Task 9, where the release gate runs.**
   - *Plan says:* "`grep`-based (no `rg` dependency on the server)", which implies running it on the server.
   - *Real:* the production host is **docker-only, without Node** (`scripts/ops-alerts-cron.sh:5-8`, `scripts/admin-access-review-prod.sh:2-3`). `preflight.sh`, `test-integration.sh`, `smoke.sh`, `npm audit` and `tsx` all need Node and a dev toolchain.
   - *Correction:*
     - `scripts/release-gate.sh` runs on the operator workstation or CI, against the **release commit**. Keep it grep-only anyway, for portability.
     - Server-side evidence is produced **by the user** and pasted into the evidence docs as dated, redacted sections:
       - the production `--file` drill;
       - the production access review;
       - the crontab installs (ops-alerts + backup);
       - nginx HSTS/`limit_req`;
       - the CSP enforcement flip.
     - The gate checks only the docs. State this in the script header and the checklist.

9. **Tasks 6/7, the recorded evidence predates Batches 3–7.**
   - *Real:*
     - `docs/operations/restore-drill-evidence.md:79-136` records graph `baseline → batch2`, 34 tables, 14 PASS.
     - `docs/operations/admin-access-review.md:115-151` records a 2026-10-06 dev run on the Batch 2 tree.
   - *Correction (Wave 1, lane E):*
     - Re-run `bash scripts/restore-drill.sh` (scratch mode) on the merged tree and **append** a new dated section (keep the old one as history). Expect the 9-dir graph and more tables; record the measured count. Any FAIL is a drill or backup script defect (fix it there).
     - Re-run `npx tsx scripts/admin-access-review.ts` against the dev DB (item 18) and append a dated section.
     - Commits:
       - `test(ops): restore drill evidence on the post-Batch-7 graph` (`docs/operations/restore-drill-evidence.md`);
       - `docs(ops): admin access review dev run on the post-Batch-7 tree` (`docs/operations/admin-access-review.md`).
     - The Sign-off/Decision cells stay founder-only.

10. **Task 8 abuse matrix, `@key` markers verified against the real test files.**
    - *Real:* several evidence cells in the plan's Threat-Case Coverage Map would fail the "key occurs in the cited file" check.
    - *Correction:* use these cells (each key was verified to appear in the file):

      | Row | Evidence cells |
      |---|---|
      | Deal IDOR | `tests/unit/deal-outcome.test.ts @DEAL_FORBIDDEN` + `tests/unit/deal-create.test.ts @DEAL_CONVERSATION_REQUIRED`. `deal-create.test.ts` contains **no** `DEAL_FORBIDDEN`. |
      | Moderation-resource IDOR | `moderation-actions.test.ts @FORBIDDEN` + `moderation-case-page.test.ts` + `appeal-actions.test.ts @APPEAL_NOT_AVAILABLE`. `appeal-actions` contains no `FORBIDDEN`. |
      | Stored XSS through listing | `tests/unit/admin-listings-page.test.ts @dangerouslySetInnerHTML` + the item 5 listing-surfaces describe. `sell-pages.test.ts` contains **no** XSS assertion. Also `docs/operations/private-beta-batch4-listing-quality-verification.md:165` (recorded scan). |
      | Stored XSS through report | `moderation-pages.test.ts @dangerouslySetInnerHTML` + `appeal-page.test.ts @dangerouslySetInnerHTML`. |
      | Malicious image upload | `image-process.test.ts @polyglot` + `image-validate.test.ts @image/svg+xml`. The SVG rejection lives in image-validate, not image-process. |
      | Image decompression bomb | `image-validate.test.ts @TOO_LARGE_DIMENSIONS` (`:100,130-138`). The plan cites image-process. |
      | OTP resend flooding | `otp.test.ts @OTP_RESEND_COOLDOWN_SEC` |
      | Session fixation | `session.test.ts @session fixation` |
      | Beta-cohort bypass | also cite `tests/integration/beta-access-enforcement.test.ts` and `tests/integration/suspended-membership-enforcement.test.ts` (both exist). |

    - All other cited files exist and carry their keys, e.g. `seller-verification-actions @VERIFICATION_ALREADY_REVIEWED`, `founding-seller-invite @INVITE_INVALID`/`@INVITE_CHANNEL_MISMATCH`, `chat-guard @CHAT_BLOCKED`, `deal-lifecycle @Promise.all`, `ipn-route`/`cron-auto-release-route @503`, `chat-beta-gate`/`deal-beta-gate @BETA_MEMBERSHIP_REQUIRED`, `suspended-membership-enforcement @SELLER_MEMBERSHIP_INACTIVE`.
    - The executor re-verifies every cell with `git grep -c -- '<key>' <file>`.

11. **Task 2 / merge, copy-safety early-execution branches must become unconditional.**
    - *Real:* `src/components/safety-guidance.tsx` exists and is mounted on `app/chat/[id]/page.tsx` (the only importer).
      - `tests/unit/copy-safety.test.ts:365-385` still wraps its check in `(safetyComponentInTree ? describe : describe.skip)`, so a deleted component would **skip**, not fail.
      - The header `:36-48` and `:353-355` say "EARLY EXECUTION … re-verify after Batch 6".
    - *Correction (Wave 0 fix commit):*
      - Make the describe unconditional.
      - Add an assertion that `app/chat/[id]/page.tsx` imports and renders `<SafetyGuidance`.
      - Rewrite the stale comments as a done record.
      - This also provides the drift pin between `src/content/policies/safety-guidance.ts` and the component: both carry the identical `SAFETY_64_POINTS` / `SAFETY_52_LINE` strings, and both are now asserted unconditionally.

12. **G3, Batch 7 / earlier "Batch 8" hand-offs that are NOT executed in Batch 8.** Each needs `src/`/`app/` edits outside the perimeter or a migration:
    - B7 R4 (unify the lifecycle audit into the tx);
    - B7 R8/R10 (console polish);
    - B2 R5 (durable TOTP column) and R2 (verified-phone partial index);
    - B3 §8.3 / B4 §9.3 finance re-enable hardening;
    - B4 open residual 6 (dead banner).

    Record each in the security review (findings or deferred) and the RR register (§F). Do not implement any of them. A real fix gets its own reviewed plan.

## NON-BLOCKING

13. **Versions.**
    - `next` / `eslint-config-next` are **16.3.8** (`package.json`), not 16.3.7.
    - `npm audit --omit=dev` is **0** (Batch 7 verification `:117`). This resolves B5 R12 / B6 R8.
    - The docs paths in the plan exist in the installed `node_modules/next/dist/docs/`.
    - Task 8 §2 inventory: `next 16.3.8`, `react`/`react-dom 19.2.8`, `sharp 0.35.5`, `otpauth 9.5.2` (exact); `zod ^4.6.5`; `@prisma/orm-postgres ^8.0.0-rc.13` (**caret, not exact**; record it); `prisma ^8.0.0-rc.19`.
    - `docs/runbook.md` §7 (the 18-finding triage dated 2026-10-05) is stale. Re-triage in the security review; do not edit the runbook.

14. **Typecheck in a fresh worktree needs typegen.** `npx tsc --noEmit` alone reports `Cannot find name 'PageProps'/'LayoutProps'/'RouteContext'` (verified on the merged tree; no other errors). Run `npx next typegen && npx tsc --noEmit`, as CI does (`.github/workflows/ci.yml` "Typecheck" step). `npm run preflight` is fine after a build.

15. **Task 5, the finance-table set follows the shipped writer-verified classification, not the plan's list.**
    - *Plan:* any delta on 12 tables including `PriceHistory` → CRITICAL; the drift test names `PriceHistory` as a key finance model.
    - *Real (merged tree):*
      - `FINANCE_ONLY_TABLES` (9: Order, OrderItem, Payment, Payout, WithdrawRequest, LedgerEntry, Dispute, **OrderStatusHistory**, PlatformSetting) → CRITICAL;
      - `CASCADE_AFFECTED_TABLES` (CartItem, Offer, ExchangeOffer) → deletes are WARN (listing-delete FK cascade);
      - `PriceHistory`/`Cart`/`Review` are non-finance (normal listing, catalog and auth writers).
    - Adopt the shipped design and record the deviation in Task 10.
    - `submitReviewAction` still writes `Review` with no finance guard (`src/lib/actions/reviews.ts:21`). Seed it as a security-review finding (LOW, dormant: needs a completed Order).

16. **Writer evidence line refs are stale** in the `scripts/ops-alerts.ts` header (`:73-125`) and `monitoring-signals.md` §2 (`:120-145`).
    - "deleteListingAction xoá CartItem trực tiếp (listings.ts:294)" is wrong. On Batch 7, `deleteListingAction` is at `src/lib/actions/listings.ts:1393`, and CartItem goes only via the FK cascade from the conditional `Listing … deleteAll()` (`:1461-1463`).
    - `PriceHistory` writers are `listings.ts:491,1187,1349`, `catalog.ts:132`, `orders.ts:390`. "listings.ts:118/267, catalog.ts:39" are stale.
    - Refresh every ref with `git grep -n` in the Wave 0 fix commit. The classification itself is unchanged.

17. **DB reach deviation (Tasks 5, 7).**
    - *Plan:* `docker exec loaviet-db psql`.
    - *Shipped:* production runs the logic inside the repo's `migrate` image on the compose network (`OPS_ALERTS_MODE=dev`, `DATABASE_URL` from the service env). Host-only signals (`docker logs`, `docker exec loaviet-app printenv FINANCIAL_FEATURES_ENABLED`) are injected via env (`scripts/ops-alerts-cron.sh:41-63`; `scripts/admin-access-review-prod.sh:17-22`). The `docker exec` mode still exists (`ops-alerts.ts:764-771`).
    - Accept this: no published port, no host pg tools, same intent.
    - Two follow-ups for the Wave 0 fix commit:
      - add `--no-deps` to `ops-alerts-cron.sh`'s `docker compose run`, as the access-review wrapper has. A monitor must not start a stopped `db`; it must report it.
      - note in `monitoring-signals.md` §0 that the mounted `scripts/`+`src/` come from the repo checkout while `node_modules` comes from the image built at deploy, so the user rebuilds `migrate` on each deploy.

18. **Dev runs need `DATABASE_URL` in the real env.** Auto mode picks `docker` when it is absent (`scripts/ops-alerts.ts:956-960`, D4 pattern). Run `set -a; . ./.env; set +a; npx tsx scripts/ops-alerts.ts`, and the same for `admin-access-review.ts`. Record the outputs in Task 10. A health CRITICAL in dev with no app running is expected; classify it.

19. **Cron signals.** The plan's `evaluateCron(lastCronLogAgeHours)` is implemented as heartbeat-file mtime (`backups/.ops-alerts-heartbeat`, `ops-alerts.ts:529-545`); accept this. The repo has **no crontab file**: the lines live in `scripts/ops-alerts-cron.sh:12-13` and `docs/backup-restore.md` §1. Installing both crontabs is a user release-checklist row.
    - The finance cron in `docs/runbook.md` §5 ("BẮT BUỘC cài") would return 503 every hour while finance is off (`app/api/cron/auto-release/route.ts:39-44`), and `curl -f` would log a failure each time.
    - Add a checklist row: **do not install the auto-release cron during the private beta.** No doc edit.

20. **captureError codes (Batch 7 hand-off `:474,491`).**
    - The error-rate signal counts every `"level":"error"` line (`ops-alerts-cron.sh:41-42`).
    - Add a `monitoring-signals.md` subsection (Wave 0 fix commit) listing the **35 `captureError` call sites by scope** with their typed codes:
      - `cohort`: COHORT_FUNNEL_SYNC_FAILED, COHORT_NOTIFY_FAILED;
      - `deal`: DEAL_NOTIFY_FAILED ×2;
      - `telemetry`: 11 (TELEMETRY_* / SEARCH_EVENT_READBACK_FAILED);
      - `upload` 6, `recovery` 4, `admin-mfa`, `moderation` 2, `rate-limit`, `cron:auto-release`, `momo:ipn` 2, `exchange.complete`, `uploads.serve`.
    - Classify all of them as **fail-open, counted in error-rate WARN, no per-code alert, no PII** (codes + `sqlState` only).
    - No ops-alerts code change.

21. **Task 1 is complete and consistent on the merged tree.** It needs only a Task 10 re-run: `npx tsx scripts/policy-hash.ts --check` prints six `DRAFT-NOT-REVIEWED` lines. The page is static (`generateStaticParams`, `notFound()`), and the repo has no `proxy.ts`/`middleware.ts` that could gate `/policies`.

22. **Task 2 allowlist deviation recorded.** A third allowlisted negation (the Batch 2 §6.2 explainer "không phải bảo đảm sản phẩm hay chứng nhận giao dịch", `copy-safety.test.ts:188-205`) ships beyond the plan's two. Accept it and list it in the security review copy section.

23. **Task 8 CSP value.**
    - Follow the installed guide (`node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md:417-452`):
      - add `font-src 'self'`;
      - append `'unsafe-eval'` to `script-src` **only** when `NODE_ENV === "development"`;
      - `upgrade-insecure-requests` is optional (record the choice).
    - `img-src` keeps `https://res.cloudinary.com` (`next.config.ts:8-10`).
    - `connect-src 'self'` is correct: chat polls same-origin `/api/chat/[id]`, and `public/sw.js` is registered by `src/components/sw-register.tsx`.
    - Ship as `Content-Security-Policy-Report-Only`. The flip is a user checklist row after `docker:smoke` plus a manual page-load.

24. **HSTS / nginx.**
    - *Plan:* "HSTS at nginx (`docs/deployment.md` §3) stays a deploy-checklist item".
    - *Real:* the §3 nginx block (`docs/deployment.md:197-212`) has **no HSTS and no `limit_req`**; only checklist §8 `:296` mentions `limit_req`.
    - *Correction:* the app-level HSTS header is the only HSTS until the user configures nginx. Add checklist rows "nginx `Strict-Transport-Security` + `limit_req` configured (user)". Record it in the security review §3/§5. Do not edit the deployment docs.

25. **§7.1 rate-limit inventory, concrete map** (`git grep -n "checkRateLimit\|rateLimitRequest"`):

    | Endpoint | Implementation |
    |---|---|
    | login | `auth.ts` `${scope}:${ip}` + `auth:mfa:ip/user` |
    | OTP request | `verification.ts` `otp-request:ip/user`; `otp.ts` per-target cooldown |
    | OTP verify | `otp.ts` attempts |
    | step-up | `verification.ts` `stepup:ip/user` |
    | recovery | `recovery.ts` |
    | report | `reports.ts` `report:` |
    | chat | `chat:start` (`CONVERSATION_START_RATE` 20/10 min), `chat:send`, `chat:poll` |
    | image upload | `upload` IP + `upload:user` (quota 60/24h) |
    | search | `SEARCH_RATE` 60/60 s |
    | listing mutation | `listing:create/draft/mutation/submit` (`LISTING_MUTATION_RATE` 20/h, `LISTING_EDIT_RATE` 60/h) |
    | Deal mutation | `deal:mutation` 20/h |
    | beta invite | landing 30/10 min/IP, accept 10/10 min/user (+ IP behind `TRUST_PROXY_HEADERS`), issue 20/h/admin |

    Classify the "verification" row as OTP/step-up verification. **Record as findings or accepted:**
    - `src/lib/actions/seller-verification.ts` (the seller declaration submit) has no limit;
    - `src/lib/actions/appeals.ts` has none (B3 R5, accepted);
    - `block` 20/min exists.

    Every value is PROVISIONAL (FD-R65).

26. **Task 8 §6 residual-risk sources.**
    - RR-9 dormant finance `approved` writes are now `src/lib/actions/admin.ts:399` (`resolveDisputeAction`) and `src/lib/actions/orders.ts:544`. The plan's ~L144/L373 are stale.
    - RR-5: `src/lib/provinces.ts` has exactly 34 entries. The "Thừa Thiên Huế" legacy-name gap is FD-R64.
    - RR-22 is **closed** (item F).

27. **Task 3, account-recovery playbook.**
    - *Plan:* the manual fallback is "the `admin-bootstrap.ts`-pattern maintenance command".
    - *Real:* it is the **audited two-person psql block** in `docs/operations/admin-bootstrap-recovery-runbook.md` §6 (`:259-296`, action `user.email_verified_manual`). Admin MFA lockout is §2/§3 (`admin.mfa_reset_manual`).
    - Cite these by section; do not invent a command. This is also the **only** production path for invitees and sellers to get a verified channel until FD-2 (FD-R69).

28. **Task 3, concierge playbook surfaces as shipped.**
    - The invite landing is a **Route Handler** `app/invite/[token]/route.ts` (no page).
    - Acceptance happens at `/invite` with the HttpOnly `sp_invite` cookie (`path: "/invite"`, 15 min).
    - The console is `/admin/beta-cohort`.
    - Buyer memberships are granted on `/admin/users` via the `private_beta_buyer` forms (Batch 2 `setBetaMembershipAction`, self-grant forbidden). The exact user filter is `/admin/users?u=<id>`.
    - The invite URL needs `NEXT_PUBLIC_APP_URL` (`APP_URL_UNCONFIGURED` otherwise).
    - Invited counts are ever-invited monotonic (FD-R73).

29. **Task 3, model-seed procedure commands.**
    - Models: `DATABASE_URL=… npx tsx scripts/seed-beta-catalog.ts --apply --models <founder.json>` (`scripts/seed-beta-catalog.ts:68`; production via the `migrate` service mount, as in runbook §0).
    - Aliases: `scripts/seed-search-aliases.ts --apply --aliases <founder.json>`.
    - `BETA_PUBLICATION_CATEGORIES = ["portable_bluetooth_speaker"]` (`src/lib/beta-categories.ts:24`).
    - Review via `/admin/catalog` (`requireCapability("listing.moderate")`, `app/admin/catalog/page.tsx:23`).

30. **Task 4, key rotation specifics.** Cite runbook §5 (`ADMIN_MFA_ENCRYPTION_KEY`) and §5b (`AUTH_SECRET`). Note that rotating `AUTH_SECRET` also invalidates every outstanding **invite token** (HKDF `"beta-invite-hash"`, `src/lib/hkdf.ts`) and recovery-code hashes. `PRODUCT_EVENT_PSEUDONYM_KEY` rotation is in `.env.example` + `docs/deployment.md` (RR-11). Cite evidence snapshots via `tests/integration/report-evidence.test.ts`.

31. **Task 9 checklist and gate details.**
    - The "seven batch verification docs" are named exactly:
      - `private-beta-finance-shutdown-verification.md`
      - `private-beta-batch2-identity-security-verification.md`
      - `…batch3-trust-safety…`
      - `…batch4-listing-quality…`
      - `…batch5-search-telemetry…`
      - `…batch6-chat-deal…`
      - `…batch7-cohort-operations-verification.md`
    - `evidence-files` also requires `founder-decision-register.md` (item 7).
    - The `package.json` scripts block is **not** alphabetical. Insert `"release:gate": "bash scripts/release-gate.sh",` after `"docker:smoke"` and do not reorder anything else.
    - Add **user** checklist rows (Status `FOUNDER`, Sign-off by the user):
      - prod `--file` drill;
      - prod access review;
      - crontab installs;
      - nginx HSTS/`limit_req`;
      - CSP flip;
      - auto-release cron NOT installed;
      - one-time re-login (B2 R1);
      - seed never run in production (B2 R15).

32. **Task 9 `finance-off` gate.** Also grep `tests/docker/docker-compose.smoke.yml`. Expect `"false"` in all three files.

33. **Task 10 scans.**
    - `dangerouslySetInnerHTML` has **2 comment hits** in `app/policies/[key]/page.tsx` (`:9`, `:57`). Classify them; the expectation is 0 code hits, not 0 hits.
    - Use `git grep -n`, not `rg`, for portability.
    - `requireCapability|requireAdminUser` in `scripts/` → 0 hits (verified).
    - `git ls-files | grep -E '\.env$|\.pem$|secret'` → 0 (verified).

34. **FD-R43 citation.** The price bound is `PRICE_MIN/PRICE_MAX` in `src/lib/listing-schema.ts:91-92`, not `listings.ts`.

35. **Task 7 interface deviation recorded.** It ships two transports (ORM + psql), shown byte-identical in the 2026-10-06 run (`admin-access-review.md:56`), plus the production `migrate`-image wrapper. Finding codes are `ADMIN_WITHOUT_MFA` / `NO_UNUSED_RECOVERY_CODES` / `STALE_SESSIONS` / `LAST_SUPER_ADMIN` / `NO_ADMINS`, as the plan specifies.

---

## §E. Founder Decision Register update (59/25 → **73 rows / 28 blocking**)

Compiled from every PROVISIONAL / founder-decision / register hand-off in the seven verification docs on Batch 7 (§1 item 1 sources). Standing rulings:

- **FD-1:** 34 provinces (applied).
- **FD-2:** OTP provider deferred.
- **FD-3:** proceed fail-closed; founder content stays PROVISIONAL placeholders.

**Text updates to existing rows:**

- **FD-R1:** add "made more consequential by FD-R69: no production user can verify a channel → no invite acceptance, no new seller verification without the manual runbook §6 block per user". **Batch 8 independent-review fix (2026-10-08):** the runbook §6 block sets **`emailVerifiedAt` only** (never `phoneVerifiedAt`), and it does **not** make `/recover` deliver a code — the production adapter throws `OTP_DELIVERY_UNAVAILABLE` regardless of verified state (`src/lib/verification-delivery.ts:91-101,118-119`). Until FD-R1 lands: (a) self-service recovery is impossible in production (account-recovery playbook §4 step 4 dead-ends — do not run §6 for recovery purposes; hand-set `passwordHash` is forbidden pending a founder-approved audited block); (b) phone-channel invites can never be accepted (`INVITE_CHANNEL_UNVERIFIED` — `src/lib/actions/founding-sellers.ts:477`); (c) **no seller can pass `phone_verified`** (`src/lib/seller-verification-policy.ts:245`) → seller verification + publication blocked in production — **launch blocker**.
- **FD-R17:** add the upload quota **60/24h**, the 7-day cleanup grace, and RR-24 (`cleanup-uploads.ts` treats only `ListingImage.url` as attached).
- **FD-R27:** add "any ops correction of `sold` must go through §4.6 audit (`AuditEvent`); no raw-UPDATE procedure is documented" (B6 §12).
- **FD-R33:** the grant path exists (`/admin/users` `private_beta_buyer`). Staff accounts need `internal` or `private_beta_buyer` granted by **another** admin.
- **FD-R43:** fix the citation (item 34).
- **FD-R48:** add the landing rate 30/10 min/IP, the cookie TTL 15 min, and the note/source caps 4000/200.
- **FD-R55:** D13 moves to FD-R72.

**New rows** (Source → Blocks launch?):

| # | Item | Source | Blocks launch? | Where recorded / verified |
|---|---|---|---|---|
| FD-R60 | Unverified-identifier squatting: the email/phone uniqueness pre-checks match **unverified** rows (stricter than §5.3.1). Loosening is a founder call. | B2 R8 | no | Security review |
| FD-R61 | Batch 2 FD-3 defaults: `SELF_REVIEW_FORBIDDEN`, `SELF_GRANT_FORBIDDEN`, declaration change → auto `needs_review`, display-role restore mapping, the `ADMIN_ROLE_REASON_CODES` taxonomy | B2 §7.2 | no | Security review RBAC inventory |
| FD-R62 | **Seller-verification decision×reason-code compatibility map** (PROVISIONAL) + `needs_review` semantics: founder ratifies or amends | B2 §7.3 | **YES** | Seller-verification playbook; checklist FD mirror |
| FD-R63 | Batch 4 recorded review decisions: wishlist/chat redaction boundary, `approvedContentAt` lazy re-review, `grandfatherStoredBounds`, exchange-offer delete pre-check | B4 §6 | no | Security review |
| FD-R64 | Province data gap: `"Thừa Thiên Huế"` missing from `hue` legacy names → those rows resolve `unresolved` (fail-closed). Founder adds it to `src/lib/provinces.ts`. | B5 §12 | no | Security review RR-5 |
| FD-R65 | Consolidated PROVISIONAL §7.1 rate values (item 25 table; invite rates stay in FD-R48) | B5/B6/B4 | no | Security review §rate limits |
| FD-R66 | Telemetry `METADATA_KEY_DENYLIST` vocabulary + PII shape heuristics | B5 §12 | no | Security review |
| FD-R67 | Search UX readings: default sort option "Phù hợp nhất", `resultCount` capped at 60 | B5 §12 | no | — |
| FD-R68 | **PROVISIONAL product copy outside moderation:** deal status/outcome labels, D12 neutral CTA, the buyer-gate copy "Tính năng nhắn tin đang giới hạn cho thành viên beta", invite page/accept form/console texts, form error texts, notify labels, the deal price note. Founder or legal review before invites. | B6 §8/§12, B7 §11 | **YES** | Copy-safety test; checklist FD mirror |
| FD-R69 | **Verified-channel binding vs FD-2 (B7 P1):** production invite acceptance is unreachable (the OTP adapter is fail-closed). Decide: wait for the provider (FD-R1), **or** accept token possession + out-of-band delivery as channel proof, **or** run the per-user manual psql runbook §6 — **email-only** (sets `emailVerifiedAt`, never `phoneVerifiedAt`; phone-channel candidates stay unaccept-able and sellers stall at `phone_verified`, checklist stage 4 onward, until FD-R1 or a founder-approved audited phone block — Batch 8 independent-review fix 2026-10-08) | B7 P1 | **YES** | Concierge playbook; checklist FD mirror |
| FD-R70 | Admins in the founding cohort: self-issue/own-contact refused; **other** admin accounts may accept | B7 P3 | no | Concierge playbook |
| FD-R71 | Expired-`active` membership refused at acceptance (`INVITE_MEMBERSHIP_NOT_ACCEPTABLE`); acceptance never clears `expiresAt` | B7 P4 | no | — |
| FD-R72 | `markDealOutcomeAction` deliberately not buyer-gated (C2); D13 `successful_match` actor = buyer, `sessionId` only for the buyer caller | B7 §11, B6 D13 | no | Security review |
| FD-R73 | Supply-readiness reading: counts are live; `invitedFoundingSellers` is ever-invited monotonic (exited candidates still count) | B7 §6/§11 | no | Founding-seller checklist |

**Blocking set (28):** FD-R1, R2, R3, R4, R6, R7, R8, R11, R12, R14, R15, R16, R17, R20, R21, R23, R24, R28, R29, R30, R33, R34, R48, R50, R59, **R62, R68, R69**. The remaining 45 rows are non-blocking. This is derived mechanically by item 7's test from `docs/operations/founder-decision-register.md`.

## §F. Residual Risk Register update

- **RR-22 closed:**
  - `toggleWishlistAction` is approved-only;
  - `/wishlist` redacts non-public rows (`wishlist-actions.test.ts:246-310`, `wishlist-page.test.ts:263-372`);
  - B6 verification `:414-420`.

  Keep the row, marked CLOSED with evidence.
- **RR-9:** refresh the lines (item 26).
- **Dependency hygiene** (B5 R12 / B6 R8) is resolved by `da31a5b` (next 16.3.8, audit 0). Record it as closed.
- **New rows** (all non-blocking, compensating control in parentheses):
  - **RR-24:** `scripts/cleanup-uploads.ts --apply` would delete an upload referenced only by `Message.imageUrl` (B6 R6). (No live path creates such rows: the POST route validates and `ChatWindow` sends none.)
  - **RR-25:** Batch 7 lifecycle actions write a CAS update and then a post-commit audit, so an audit row can be lost on a DB fault (B7 R4). (The write stays CAS-safe; any fix is a new plan.)
  - **RR-26:** application-level candidate contact dedup can race (B7 R5). (The console shows both rows.)
  - **RR-27:** the funnel status can lag between syncs (B7 R3). (Operator sync; gates read memberships fresh.)
  - **RR-28:** `uploadBodiesInFlight` is a process-local body bound (B4 §6 #5). (Single instance.)
  - **RR-29:** per-identifier OTP confirm-bucket DoS (B2 R12). (Fail-closed, self-healing in 10 min.)
  - **RR-30:** pseudonymity is not anonymity, and user erasure needs a key-version recompute (B5 R4 → FD-R7).
  - **RR-31:** the build warning `instrumentation.ts:27` `process.exit` in the Edge runtime (B2 R19, still present).
  - **RR-32:** console query density at ~300 candidates (B7 R8).

## §G. PROVISIONAL founder questions (fail-closed defaults ship; never block execution)

- **Q1 (most consequential), FD-R69 / FD-2.** Should a held invite token plus operator out-of-band delivery count as channel proof, or does invite acceptance wait for a production OTP provider?
  - **Default:** keep the verified-channel requirement. Production acceptance stays unreachable except through the per-user audited manual psql runbook §6 (two-person rule).
- **Q2, FD-R59.** Should the founder accept the no-browser-E2E posture for the two §12 E2E criteria, or commission a Playwright batch?
  - **Default:** both rows stay `FOUNDER`/PENDING, so the release gate stays red.

## Parallelism map (file-disjoint)

- **Wave 0 (serial, one session):** §A cherry-picks, then the fix commit (items 2, 11, 16, 17, 20). Files: `scripts/ops-alerts.ts`, `scripts/ops-alerts-cron.sh`, `tests/unit/ops-alerts.test.ts`, `tests/unit/copy-safety.test.ts`, `docs/operations/monitoring-signals.md`. Gate: full `npm test`, typegen + tsc, lint.
- **Wave 1 (parallel lanes):**
  - **A, Task 3:** six playbook docs (items 6, 27–29).
  - **B, Task 4:** `docs/operations/incident-playbook.md` (item 30; reads `monitoring-signals.md` read-only).
  - **C, Task 8a:** `next.config.ts` + `tests/unit/security-headers.test.ts` (items 4, 23). Commit: `feat(security): app-wide browser security headers (report-only CSP)`.
  - **D, Task 8b:** `tests/unit/chat-surface-xss.test.ts` (item 5).
  - **E, evidence refresh:** `restore-drill-evidence.md` and `admin-access-review.md` re-runs (item 9). The drill uses its own `sp-drill-*` containers; do not run it concurrently with `npm run test:integration` on a low-memory host.
- **Wave 2 (after A, C, D):** Task 8c, `docs/operations/private-beta-security-review.md` + `tests/unit/abuse-matrix.test.ts` (items 10, 12, 13, 15, 24–26). Commit: `test(security): abuse matrix and launch security review`. It runs lane A's RR-3 query.
- **Wave 3:** Task 9, `docs/operations/founder-decision-register.md`, `docs/operations/private-beta-release-checklist.md`, `scripts/release-gate.sh`, `package.json`, `tests/unit/release-gate-checklist.test.ts` (items 7, 8, 31, 32). The expected run is FAIL (policy-reviews + 28 FD-mirror rows PENDING).
- **Wave 4:** Task 10, `docs/operations/private-beta-batch8-launch-gate-verification.md` (items 3, 14, 18, 33). It records:
  - the Wave 0 merge (the commit list plus `-x` provenance);
  - the semantic fix;
  - the derived register count;
  - every deviation accepted here (items 15, 17, 19, 22, 35).
- **Shared-file serialization:**
  - `monitoring-signals.md`: Wave 0 only.
  - `next.config.ts`: lane C only.
  - `private-beta-security-review.md`: Wave 2 only.
  - `package.json`: Wave 3 only.
  - Integration suites share one scratch DB, so run `npm run test:integration` serially, once per wave.
