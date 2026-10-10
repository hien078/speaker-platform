# Private-Beta Finance Shutdown — Batch 0–1 Verification (Task 6)

**Date:** 2026-10-06
**Plan:** `docs/superpowers/plans/2026-10-06-private-beta-batch-0-1-finance-shutdown.md` (Task 6)
**Spec:** `docs/superpowers/specs/2026-10-06-private-beta-marketplace-reset-design.md`
**Inventory:** `docs/operations/finance-surface-inventory.md`
**Worktree:** `finance-verification` (branch `opencode/finance-verification`)

---

## 1. Commits

| Role | Commit | Message |
|---|---|---|
| Base (Batch 0 inventory + plan amendments) | `54abfa1a5edce15231be503bba6bcee44c531738` | docs(plan): close finance inventory coverage gaps |
| Task 2 — shared capability | `c4469d6` | feat(finance): add server-owned shutdown boundary |
| Task 3 — backend denial (worktree A) | `1606686` | feat(finance): deny dormant finance entry points |
| Task 4 — public UI/copy removal (worktree B) | `7d96e9c` | feat(marketplace): remove beta-facing finance surfaces |
| Task 5 — admin read-only | `0344246` | feat(admin): make historical finance views read-only |
| Task 6 — this verification | *(the commit that adds this document)* | test(finance): verify private-beta shutdown gate |

**OpenCode metadata:** model `OneNexus GLM 5.3` (provider `home-gateway`), agent session in worktree
`finance-verification`, executed autonomously per plan Task 6. No push/merge/deploy performed.

---

## 2. Boundary summary

`FINANCIAL_FEATURES_ENABLED` (server-only, `src/lib/financial-features.ts`):

- omitted/empty → **false**; strict literal `"true"` | `"false"` only; malformed values never truthy
  and are rejected by `validateEnv` (`src/lib/env.ts`) at startup;
- **production is hard-off regardless of the env value** (private beta runs in production mode);
  `"true"` in production is a fail-fast configuration error at server start;
- no `NEXT_PUBLIC_*` variable, query param, cookie, header, request body, or admin UI can enable
  finance (spec §4.10); the only switch is a server env change + restart;
- explicit `FINANCIAL_FEATURES_ENABLED: "false"` is now enumerated in `.env.example`,
  `docker-compose.prod.yml`, `tests/docker/docker-compose.smoke.yml`, and `scripts/smoke.sh`.

---

## 3. Direct-route response contract (finance disabled)

Verified by unit tests (`tests/unit/financial-shutdown-*.test.ts`,
`tests/unit/finance-public-surface.test.ts`, `tests/unit/admin-finance-readonly.test.ts`,
`tests/unit/cron-auto-release-route.test.ts`) **and** live against the production standalone
server on a scratch DB (`scripts/smoke.sh`) and the isolated compose stack
(`scripts/docker-smoke.sh`):

| Entry point | Response while disabled | Ordering guarantee |
|---|---|---|
| `POST /api/payments/momo/create` | `503 {"error":"FINANCIAL_FEATURES_DISABLED"}` | before rate limit, auth, order/offer read, provider request |
| `POST /api/payments/momo/ipn` (any body, incl. validly signed) | `503 {"error":"FINANCIAL_FEATURES_DISABLED"}` | before parse/verify — no parse-then-mutate; provider retry is safe |
| `POST /api/cron/auto-release` — wrong/missing secret | `401` / `503 CRON_SECRET_NOT_CONFIGURED` | fail-closed cron auth unchanged, **before** finance denial (no status leak to unauthenticated callers) |
| `POST /api/cron/auto-release` — correct secret | `503 {"ok":false,"error":"FINANCIAL_FEATURES_DISABLED"}` | before `processAutoReleases` — no payout/ledger |
| `GET /payments/momo/return` (any query) | `500` unavailable (error boundary) | assert throws before verify/mutate; **no redirect into a live finance flow** |
| `GET /cart` `/checkout` `/orders` `/orders/[id]` `/orders/sales` `/wallet` `/offers` `/exchange` `/listings/[slug]/exchange` | `404` (`notFound()`) | before any DB read or session check; underlying dormant code preserved |
| Finance server actions (cart/orders/offers/exchange/withdraw/admin) | throw `FINANCIAL_FEATURES_DISABLED` | before operational finance read and before every mutation |
| Reusable libraries `escrow.ts`, `ledger.ts` (`recordLedgerTx`), `momo.ts` (`createMomoPayment`), `wallet.ts` (`getWalletSummary`), `helpers.ts` (`processAutoReleases`) | defense-in-depth `assertFinancialFeaturesEnabled()` | a future caller cannot bypass the route/action boundary |
| Historical admin views (`/admin/orders`, `/admin/disputes`, `/admin/withdraws`, `/admin/settings`) | readable, labeled **“chỉ đọc” (dormant)** | mutation controls removed from UI; underlying actions still deny server-side |

---

## 4. Commands and results

All commands run in the integration worktree on 2026-10-06 (Node v26.10.0, npm 11.19.1,
dependencies installed locally per plan). Note: on a clean tree, `npx tsc --noEmit` requires
`npx next typegen` first — Next.js 16 generates the global route types (`PageProps`, …) that
`tsconfig.json` includes via `.next/types/**/*.ts`.

| # | Command | Result |
|---|---|---|
| 1 | `git diff --check` (working tree) | **PASS** — no whitespace/conflict artifacts |
| 2 | `npm test -- tests/unit/financial-features.test.ts tests/unit/env.test.ts tests/unit/financial-shutdown-actions.test.ts tests/unit/financial-shutdown-routes.test.ts tests/unit/finance-public-surface.test.ts tests/unit/admin-finance-readonly.test.ts tests/unit/cron-auto-release-route.test.ts tests/unit/ipn-route.test.ts tests/unit/momo.test.ts tests/unit/ledger.test.ts tests/unit/mock-payment-guard.test.ts tests/unit/cron-auth.test.ts` | **PASS** — 12 files / 181 tests (initial run; 183 after the §8 copy-regression assertions) |
| 3 | `npm run lint` | **PASS** — 0 errors, 0 warnings |
| 4 | `npx tsc --noEmit` | **PASS** — exit 0 |
| 5 | `npm test` (full unit suite) | **PASS** — 17 files / 239 tests (initial run); **241 tests on final rerun** on the committed tree after the §8 review fixes (2 new copy-regression assertions) |
| 6 | `npm run build` | **PASS** — exit 0, compiled successfully (see §6 warning) |
| 7 | `npm run smoke` (`scripts/smoke.sh` — production standalone + scratch Postgres, `NODE_ENV=production`, `FINANCIAL_FEATURES_ENABLED=false`) | **SMOKE PASS** — health 200 db=up; home/login 200; chat 401; momo create/ipn 503 typed; cron wrong-secret 401 / correct-secret 503 typed; 9 retired finance pages 404; momo return 500 unavailable |
| 8 | `npm run preflight` (`scripts/preflight.sh`) | **PREFLIGHT PASS** — 7/7 gates: contract-emit-drift, lint, typecheck, unit-tests, production-build, compose-config, migration-graph |
| 9 | `npm run test:integration` (`scripts/test-integration.sh` — scratch Postgres container) | **PASS** — 1 file / 6 tests (legacy escrow idempotency/race/reconciliation invariants; finance explicitly enabled **only** inside this isolated test setup via `vi.stubEnv`, never weakening the boundary) |
| 10 | `SMOKE_PORT=4321 bash scripts/docker-smoke.sh` (isolated compose project `sp-smoke-*`, image built from `Dockerfile`) | **DOCKER SMOKE PASS** — same disabled-mode contract as #7 against the containerized stack (19/19 checks: typed 503s, 404 retired pages, 500 return, health db=up, migrate marker); `down -v` cleanup only its own project. Default port 3999 was occupied by another local process during verification, so an explicit `SMOKE_PORT` was used (the script honors it by design) |
| 11 | `git diff 54abfa1..HEAD --stat -- src/prisma migrations` | **0 lines** — no schema, contract, or migration change in the whole batch |
| 12 | Source scan (see §5) | all hits classified |

Disabled-mode denial of every operational beta entry point is additionally proven by #2
(actions/routes/public-surface/admin suites run with finance **disabled** by default) and #7/#10
(production server + compose stack with finance disabled).

### 4.1 Fresh-context code review

A fresh-context reviewer session (separate subagent, no shared conversation history) inspected
the complete batch diff `54abfa1..HEAD` plus the working-tree smoke/config changes against the
plan's five Review Focus risks (missing central assertion; live direct-route/webhook/return/cron
work while disabled; client escape hatch or permissive env parsing; destructive schema/data
change or loss of historical read-only access; public escrow/commission/held-money promise).

**Verdict: ACCEPT — zero Critical, zero Important** (5 Minor + 6 Info, all fixed or accepted
in §8). Verified highlights: 24/24 exported finance server actions call
`assertFinancialFeaturesEnabled()` before any read/mutation; 6 defense-in-depth asserts across
the 5 reusable mutation libraries (`escrow.ts` ×2, `ledger.ts`, `momo.ts`, `wallet.ts`,
`helpers.ts`) with `reconcileEscrow` intentionally read-only; cron keeps fail-closed auth
**before** the finance denial (no status leak); 9/9 retired pages `notFound()` before
session/DB; strict literal env parsing with production hard-off and `validateEnv` fail-fast;
zero schema/migration diff; smoke `check_body` cannot pass vacuously (a wrong-cause 503 fails
the typed-code needle); legacy algorithm tests enable finance only inside isolated
`vi.stubEnv` setup. Note-level observations, both accepted: `/listings?exchange=1` filter links
remain on home/listings — a read-only listing-attribute browse (“Đổi chéo sản phẩm — hai bên tự
thỏa thuận qua chat”, no money promise; the escrowed cash-top-up flow itself is 404-guarded) —
intentionally preserved; the MoMo return page surfaces as 500 (error boundary) rather than 503
— documented in §3 and asserted in unit test + smoke.

---

## 5. Final source/copy scan — classification

Scan A (source, exactly as plan Task 1/6):

```bash
rg -n -i 'payment|momo|escrow|commission|wallet|withdraw|payout|order|checkout|cart|dispute|refund|settlement|ledger|cashTopup' app src scripts tests README.md
```

→ 2808 matched lines / 105 files. Every file maps to an inventory row (§1–§6) or a false-positive
category (FP-1 `orderBy`, FP-2 `border*` CSS, FP-3 local `order` var, FP-4 `BRAND_ORDER`,
FP-5 sample paths, FP-6 comments, FP-7 generated contract artifacts) — same reconciliation as
inventory §7, re-verified after Tasks 3–5.

Scan B (public copy, exactly as plan Task 4):

```bash
rg -n -i 'escrow|hoa hồng|commission|giữ tiền|bảo vệ (người mua|thanh toán)|thanh toán qua|ví|rút tiền|payout|checkout' app src README.md
```

→ every remaining match classifies as exactly one of:

1. **Dormant implementation behind a tested server boundary** — retired pages keep their legacy
   copy but return `404` before render (`app/cart`, `app/checkout`, `app/orders/**`, `app/wallet`,
   `app/offers`, `app/exchange`, `app/listings/[slug]/exchange`, `src/components/offer-card.tsx`,
   `escrow-pay-modal`, `checkout-form`, `withdraw-form`, `exchange-*` components); guarded
   libraries (`src/lib/escrow.ts`, `ledger.ts`, `momo.ts`, `wallet.ts`, `actions/*`); guarded
   routes (`app/api/payments/momo/*`, `app/api/cron/auto-release`, `app/payments/momo/return`).
2. **Historical read-only admin surface** — `app/admin/*` finance views + `dormant-notice.tsx`
   (“Dữ liệu tài chính lịch sử — chỉ đọc (dormant)”) + admin nav “chỉ đọc” badges.
3. **Test fixture/documentation describing disabled legacy behavior** — `tests/unit/*`,
   `tests/integration/*`, `README.md` (rewritten to the classifieds model; dormant code labeled
   historical/disabled; re-enable note), this document.
4. **Accurate non-custodial public copy (not a promise)** — every reachable public hit states the
   *opposite* of an escrow promise: “LoaViet không giữ tiền và không bảo đảm giao dịch”
   (`app/layout.tsx`, `app/page.tsx`, `app/listings/[slug]/page.tsx`, `app/seller/[id]/page.tsx`,
   `app/manifest.ts`, `src/components/footer.tsx`, `src/components/listing-form.tsx`).
   `app/robots.ts` hits are disallow entries for retired routes (harmless; routes 404).
5. **Generated artifacts / dormant config** — `src/prisma/contract.{d.ts,json,prisma}` (FP-7,
   preserved), `src/lib/env.ts` (`ESCROW_AUTO_RELEASE_DAYS` validation, dormant config),
   `src/lib/constants.ts` labels (rendered only by retired/read-only surfaces), `src/prisma/seed.ts`
   (dev/test only, refuses production).

**No public escrow / payment-protection / commission / platform-held-money promise remains.**
No match required correction (no defect found by the scan).

---

## 6. Limitations / residual warnings

- **Pre-existing build warning (out of Batch 0–1 scope):** `npm run build` (Turbopack) prints
  `Warning: A Node.js API is used (process.exit at line: 27) which is not supported in the Edge
  Runtime` for `instrumentation.ts`. The file is untouched by this batch (`git diff 54abfa1..HEAD
  -- instrumentation.ts` → empty); the warning is cosmetic (the register() path runs in the
  Node.js runtime), the build exits 0. Fix belongs to a later hardening batch.
- **`ESCROW_AUTO_RELEASE_DAYS`, `MOMO_*`, `CRON_SECRET` remain in env/config** — dormant once all
  entry points deny (inventory §5 / note E-1). `CRON_SECRET` still protects its route (401 before
  the finance denial, by design).
- **Adjacent unguarded surfaces (classified, intentionally preserved):** cart bootstrap on
  register/login, cart-row cleanup on listing deletion, legacy review creation,
  seller-verification toggle (inventory §8 A-1…A-4) — non-money-path; Batch 2+ will revisit.
- **`src/prisma/seed.ts` is destructive by design to dev/test DBs only** (refuses
  `NODE_ENV=production`, requires `SEED_PASSWORD`) — must never run against the beta database
  (inventory S-1).
- **Docker smoke requires a local Docker daemon** — both smoke harnesses create and clean up
  only their own scratch resources (`sp-smoke-*` / `sp-it-*`); nothing else is touched. During
  verification the default `SMOKE_PORT=3999` was momentarily held by another local process
  (first `docker compose up` failed with “port is already allocated”, no app container started);
  re-ran with an explicit free `SMOKE_PORT` — environment condition, not a product defect.

## 7. Rollback / re-enable notes

- **Rollback of this batch:** revert commits `0344246`, `7d96e9c`, `1606686`, `c4469d6` (and the
  Task 6 commit). No schema/migration/data change needs undoing — the batch is behavior-only.
- **Re-enable finance (future, evidence-driven per spec §13):** set `FINANCIAL_FEATURES_ENABLED`
  to `"true"` **outside production only** (dev/test). In production the capability is hard-off in
  `financialFeaturesEnabled()` and `validateEnv` fail-fasts the configuration at startup; a
  production re-enable requires a reviewed product decision **and** a code change (remove the
  production hard-off), not merely an env edit. Re-enabling restores the preserved dormant flows
  (escrow, MoMo, wallet, commission) as-is; historical data was never deleted.
- **Historical finance maintenance** (spec §5.1.1) stays offline-only: `scripts/backup-db.sh` /
  `restore-db.sh` (restore refuses to overwrite); no HTTP/admin/cron surface exists for it.

## 8. Fresh-context code review (Task 6)

An independent reviewer session re-read the entire batch (all guarded files, every finance
mutation site, all retired pages, admin views, public components, smoke scripts) against the
plan's five review-focus areas. **Verdict: 0 Critical, 0 Important.** All five risk areas clean
(central assertion coverage, direct-route/webhook/cron/return denial, no client escape hatch,
zero schema/data loss + read-only admin preserved, no reachable escrow/commission promise).

Minor/Info findings and their resolution:

| Finding | Resolution |
|---|---|
| M-1 `app/notifications/page.tsx` empty state mentioned retired finance flows (“Trả giá, đơn hàng, khiếu nại…”) | **Fixed** (reachable copy): now “Thông báo về tin đăng và tài khoản của bạn sẽ hiện tại đây.” + regression assertion in `finance-public-surface.test.ts` |
| I-5 `app/chat/page.tsx` empty state referenced old CTA label “Chat với người bán” | **Fixed** (label drift): now “Nhắn người bán” + regression assertion |
| I-3 `scripts/docker-smoke.sh` `check_body` wrote its response file into the repo root | **Fixed**: uses `mktemp -d` scratch dir (parity with `smoke.sh`), cleaned in trap |
| M-3 `deleteListingAction` cart-row cleanup, M-4 register/login cart bootstrap | accepted as classified (inventory §8 A-1/A-2, non-money-path) — see §6 |
| M-5 `submitReviewAction` (reads `Order`, writes `Review`) unguarded | accepted as classified (inventory §8 A-4) — **Batch 2** |
| M-2 historical finance notification links dead-end at the intended 404 | **Batch 2** UX decision (strip links or explain on 404) |
| I-1 no `error.tsx` boundary → typed code invisible on throw paths (500 generic) | **Batch 2** UX polish; route handlers already return typed 503 JSON |
| I-2 `reconcileEscrow()` unguarded read, no production caller | accepted (inventory §1.5: read-only historical invariant check) |
| I-6 buyer/seller self-service historical order access intentionally gone (admin read-only only) | on record as the reviewed product decision |

## 9. Deferred to Batch 2+

Per spec §9 and inventory §8: seller-verification domain (A-3), review system (A-4 +
`submitReviewAction` eligibility re-check), admin MFA/RBAC/step-up (current broad `role=admin`
boundary intentionally unchanged), report/block/moderation, beta cohort, telemetry, error
boundary for typed denial UX (§8 I-1), historical-notification link handling (§8 M-2).
The finance boundary itself needs no Batch 2 change.

---

## 10. Acceptance gate checklist (plan Task 6 / spec Batch 1)

- [x] `FINANCIAL_FEATURES_ENABLED` defaults to false; browser cannot control it (no `NEXT_PUBLIC_*`)
- [x] Every inventoried financial mutation entry point fails closed with `FINANCIAL_FEATURES_DISABLED` before mutation (§3, tests + smoke)
- [x] Provider callback, return, and cron paths perform no operational finance work while disabled
- [x] Public navigation and direct public routes expose no live finance workflow (404/503/500 contracts)
- [x] Listing detail leads to chat (“Nhắn người bán”), not purchase/payment
- [x] Public copy makes no escrow/payment-protection/commission promise (§5 scan B)
- [x] Historical finance models and records preserved (zero schema/migration diff; scratch migrate applies 143 additive ops)
- [x] Historical admin views read-only, labeled dormant; actions still deny server-side
- [x] Focused tests, full unit suite, lint, typecheck, production build, smoke, docker smoke, preflight, integration pass
- [x] Diff/status audit: only intentional Batch 0–1 changes; no local-only/unrelated files staged
