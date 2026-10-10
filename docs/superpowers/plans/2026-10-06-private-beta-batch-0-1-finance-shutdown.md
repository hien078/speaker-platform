# Private Beta Batch 0–1 Finance Shutdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a reviewed inventory of every financial surface, then make all buyer-, seller-, provider-, cron-, and admin-triggered financial operations unavailable by default while preserving historical data and read-only historical administration.

**Architecture:** Add one server-only finance capability boundary and require every financial entry point to cross it before reading operational state or mutating data. After the shared boundary lands, implement backend denial and public UI/copy removal in isolated worktrees because those tracks do not share application files. Preserve finance models and historical records; do not introduce `Deal` in this batch.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Prisma 8 contract, PostgreSQL, Vitest, shell smoke tests.

**Spec:** `docs/superpowers/specs/2026-10-06-private-beta-marketplace-reset-design.md`

## Global Constraints

- Read `AGENTS.md` and the relevant Next.js 16 documentation before editing. At minimum read:
  - `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`
  - `node_modules/next/dist/docs/01-app/02-guides/server-actions.md`
  - `node_modules/next/dist/docs/01-app/02-guides/environment-variables.md`
  - `node_modules/next/dist/docs/01-app/02-guides/redirecting.md`
  - `node_modules/next/dist/docs/01-app/02-guides/testing/vitest.md`
- Use test-first development for every behavior change: add a failing test, confirm the expected failure, implement the minimum change, and rerun the focused test.
- Do not delete or repurpose `Order`, `Payment`, `Payout`, `WithdrawRequest`, `LedgerEntry`, finance-related `ExchangeOffer` fields, or historical records.
- Do not add a client-controlled finance flag or a P0 admin toggle.
- The default and beta-environment behavior is finance disabled.
- The typed failure code is `FINANCIAL_FEATURES_DISABLED`.
- Check the finance assertion before operational finance reads and before every mutation.
- Historical admin visibility must remain read-only and must not expose actions that change finance state.
- Do not implement `Deal`, identity, RBAC, moderation, listing, search, or telemetry features in this batch.
- Do not modify or stage `.claude/settings.json`, `public/uploads/`, secrets, generated scratch data, or unrelated changes.
- OpenCode must not push, merge, deploy, or destructively clean the repository.
- Commit each task separately with the listed commit intent. Never use `git add .`.

## Dependency and Parallelization Map

```text
Task 1: Batch 0 inventory
        ↓ review gate
Task 2: shared finance capability
        ↓ shared base commit
        ├── Task 3: backend entry-point denial (worktree A)
        └── Task 4: public UI/copy removal (worktree B)
                    ↓ integrate both branches
Task 5: historical admin read-only cleanup
        ↓
Task 6: regression, direct-route, build, smoke, source scan
```

Tasks 3 and 4 may run in parallel only after Task 2 is committed. Task 5 starts only after both are integrated because it overlaps admin surfaces and final copy. All other tasks are sequential.

## Review Focus

1. A financial mutation path missing the central assertion.
2. A direct route, webhook, return URL, or cron path that still performs work when disabled.
3. A client-controlled escape hatch or permissive environment parsing.
4. Destructive schema/data changes or loss of legitimate historical read-only access.
5. Public copy that still promises escrow, protected payment, commission, or platform-held money.

---

## Task 1: Create the Batch 0 financial-surface inventory

**Files:**

- Create: `docs/operations/finance-surface-inventory.md`
- Inspect: `app/**`
- Inspect: `src/components/**`
- Inspect: `src/lib/**`
- Inspect: `src/prisma/contract.prisma`
- Inspect: `scripts/**`
- Inspect: `tests/**`
- Inspect: `README.md`

- [ ] Read the approved spec, repository instructions, and required Next.js docs.
- [ ] Record the clean starting commit, branch, and `git status --short` in the OpenCode report, not in the inventory document.
- [ ] Search case-insensitively for `payment`, `momo`, `escrow`, `commission`, `wallet`, `withdraw`, `payout`, `order`, `checkout`, `cart`, `dispute`, `refund`, `settlement`, `ledger`, `cashTopup`, and provider callbacks.
- [ ] Build a table with one row per reachable finance surface and these columns:
  - surface/domain;
  - exact file and exported handler/action/component;
  - trigger type (`page`, `server action`, `route`, `webhook`, `cron`, `library`, `admin`, `copy`, `test`, `environment`);
  - current read/mutation behavior;
  - authentication/authorization today;
  - planned disabled behavior;
  - planned guard location;
  - verification test.
- [ ] Explicitly inventory indirect mutation chains, including:
  - offer acceptance creating an Order;
  - exchange cash-top-up and completion;
  - payment return and IPN paths;
  - auto-release cron;
  - admin dispute resolution;
  - admin commission changes;
  - seller manual-payment confirmation;
  - wallet/withdrawal processing;
  - mock payment actions;
  - cart-to-order conversion.
- [ ] Add a separate table for public navigation, metadata, manifest, robots/sitemap behavior, README claims, and admin navigation.
- [ ] Add a separate preservation table listing finance models/tables that must remain unchanged.
- [ ] Add an “Unknown/Ambiguous” section. If any mutation path cannot be classified, stop Batch 1 and report it.
- [ ] Confirm every known financial mutation has a planned guard and focused verification test.
- [ ] Run `rg -n -i 'payment|momo|escrow|commission|wallet|withdraw|payout|checkout|cart|dispute|refund|settlement|ledger|cashTopup' app src scripts tests README.md` and reconcile every hit with the inventory or an explicit non-financial false-positive category.
- [ ] Commit only the inventory:

```bash
git add docs/operations/finance-surface-inventory.md
git commit -m "docs(finance): inventory dormant finance surfaces"
```

**Gate:** Do not continue if the inventory has an unresolved mutation surface.

## Task 2: Add the shared server-owned finance capability

**Files:**

- Create: `src/lib/financial-features.ts`
- Create: `tests/unit/financial-features.test.ts`
- Modify: `src/lib/env.ts`
- Modify: `tests/unit/env.test.ts`
- Modify: `.env.example` if present; otherwise modify the repository’s tracked environment example file.

- [ ] Write failing unit tests for:
  - omitted `FINANCIAL_FEATURES_ENABLED` returns `false`;
  - exact server value `false` returns `false`;
  - exact server value `true` returns `true` only outside production/beta unless the approved environment contract explicitly permits it;
  - malformed values fail validation rather than becoming truthy;
  - `assertFinancialFeaturesEnabled()` throws an error whose stable code is `FINANCIAL_FEATURES_DISABLED` when disabled;
  - no `NEXT_PUBLIC_` variable controls this capability.
- [ ] Run `npm test -- tests/unit/financial-features.test.ts tests/unit/env.test.ts` and confirm the new tests fail for missing behavior.
- [ ] Implement a server-only module with:

```ts
export const FINANCIAL_FEATURES_DISABLED = "FINANCIAL_FEATURES_DISABLED" as const;
export function financialFeaturesEnabled(): boolean;
export function assertFinancialFeaturesEnabled(): void;
```

- [ ] Keep parsing strict and centralized. Do not read query parameters, cookies, headers, request bodies, or client state.
- [ ] Validate startup configuration through the existing environment validation path.
- [ ] Document the flag as disabled by default and required to remain false for private beta.
- [ ] Rerun the focused tests and confirm they pass.
- [ ] Run `npm run lint -- src/lib/financial-features.ts tests/unit/financial-features.test.ts src/lib/env.ts tests/unit/env.test.ts` if the script accepts file arguments; otherwise run `npm run lint`.
- [ ] Commit only the shared capability and its tests:

```bash
git add src/lib/financial-features.ts tests/unit/financial-features.test.ts src/lib/env.ts tests/unit/env.test.ts .env.example
git commit -m "feat(finance): add server-owned shutdown boundary"
```

**Gate:** Export the resulting commit hash. Both parallel worktrees must be created from exactly this commit.

## Task 3: Deny every backend finance entry point (parallel worktree A)

**Files:**

- Modify: `src/lib/actions/cart.ts`
- Modify: `src/lib/actions/orders.ts`
- Modify: `src/lib/actions/offers.ts`
- Modify: `src/lib/actions/exchange.ts`
- Modify: `src/lib/actions/withdraw.ts`
- Modify: `src/lib/actions/admin.ts`
- Modify: `src/lib/escrow.ts`
- Modify: `src/lib/ledger.ts`
- Modify: `src/lib/momo.ts`
- Modify: `src/lib/wallet.ts`
- Modify: `src/lib/actions/helpers.ts`
- Modify: `app/api/payments/momo/create/route.ts`
- Modify: `app/api/payments/momo/ipn/route.ts`
- Modify: `app/api/cron/auto-release/route.ts`
- Modify: `app/payments/momo/return/page.tsx`
- Modify: focused existing unit/integration tests for these entry points.
- Create: `tests/unit/financial-shutdown-actions.test.ts`
- Create: `tests/unit/financial-shutdown-routes.test.ts`

- [ ] For every mutation row in the inventory, write a focused test proving disabled mode exits with `FINANCIAL_FEATURES_DISABLED` before a database/provider mutation.
- [ ] Add explicit tests for the IPN, payment return, and cron endpoints. They must not parse a successful provider payload and then mutate state while disabled.
- [ ] Add spies/fakes proving these downstream calls do not occur while disabled:
  - database create/update/delete for finance records;
  - ledger recording;
  - provider request creation;
  - escrow release/refund;
  - payout/withdraw processing.
- [ ] Run the focused tests and confirm their expected failure.
- [ ] Insert `assertFinancialFeaturesEnabled()` at the outermost server entry point and retain defense-in-depth in reusable mutation libraries such as escrow/provider helpers.
- [ ] Ensure direct imports/calls to reusable financial libraries are also denied; do not rely only on page or button removal.
- [ ] Add defense-in-depth assertions to `recordLedgerTx()` and `processAutoReleases()` so a future caller cannot bypass the route/action boundary. Keep `reconcileEscrow()` available as a read-only historical reconciliation operation.
- [ ] Leave account/login cart bootstrap and listing-deletion cart cleanup unguarded: they are non-financial data hygiene, cannot create a transaction, and remain unreachable as a commerce flow once cart UI/actions are disabled.
- [ ] Leave legacy review creation and the legacy seller-verification toggle outside the finance guard; their removal/replacement belongs to the later review and seller-verification batches.
- [ ] Choose route responses consistent with Next.js 16 Route Handler APIs and existing API conventions. Keep the stable typed code in the response; do not redirect provider callbacks to a live finance flow.
- [ ] Preserve existing finance implementation behind the boundary. Do not delete historical logic or migrations.
- [ ] Rerun focused tests until green.
- [ ] Run all finance-related existing tests and update assertions only where disabled-by-default behavior intentionally changes them. Where legacy finance algorithm tests remain valuable, enable finance explicitly in isolated test setup rather than weakening the boundary.
- [ ] Commit backend denial only:

```bash
git add src/lib/actions/cart.ts src/lib/actions/orders.ts src/lib/actions/offers.ts src/lib/actions/exchange.ts src/lib/actions/withdraw.ts src/lib/actions/admin.ts src/lib/actions/helpers.ts src/lib/escrow.ts src/lib/ledger.ts src/lib/momo.ts src/lib/wallet.ts app/api/payments/momo/create/route.ts app/api/payments/momo/ipn/route.ts app/api/cron/auto-release/route.ts app/payments/momo/return/page.tsx tests
git commit -m "feat(finance): deny dormant finance entry points"
```

- [ ] Report exact files changed, focused test commands/results, and any inventory row not covered.

## Task 4: Remove beta-facing finance UI and misleading copy (parallel worktree B)

**Files:**

- Modify: `src/components/header.tsx`
- Modify: `src/components/header-user-menu.tsx`
- Modify: `src/components/footer.tsx`
- Modify: `src/components/listing-form.tsx`
- Modify: `app/listings/[slug]/page.tsx`
- Modify: `app/manifest.ts`
- Modify: `app/robots.ts`
- Modify: `README.md`
- Modify or remove reachability from: `app/cart/page.tsx`
- Modify or remove reachability from: `app/checkout/page.tsx`
- Modify or remove reachability from: `app/orders/**`
- Modify or remove reachability from: `app/wallet/page.tsx`
- Modify or remove reachability from: `app/offers/page.tsx`
- Modify or remove reachability from: `app/exchange/page.tsx`
- Modify or remove reachability from: `app/listings/[slug]/exchange/page.tsx`
- Modify or remove reachability from: `app/payments/momo/return/page.tsx` only if Task 3 ownership is reassigned before work starts; otherwise do not touch it in this worktree.
- Create: `tests/unit/finance-public-surface.test.ts`
- Modify: relevant component/page tests if they exist.

- [ ] Write failing tests or source-contract assertions proving public navigation and listing detail expose no cart, checkout, wallet, order-payment, payout, withdrawal, escrow, commission, or payment-protection CTA when finance is disabled.
- [ ] Add direct-request expectations for retired pages. Select one consistent behavior:
  - `notFound()` for public finance-only pages; or
  - redirect to a relevant non-financial page with no state change.
- [ ] Run focused tests and confirm failure before implementation.
- [ ] Remove cart/finance links from desktop and mobile navigation, user menu, footer, manifest description, and public metadata/copy.
- [ ] Replace purchase/payment CTAs on listing detail with `Nhắn người bán` linking into the existing allowed conversation flow.
- [ ] Add nearby accurate Vietnamese copy: payment and fulfillment happen independently outside LoaViet; LoaViet does not hold funds or guarantee the transaction.
- [ ] Make finance-only pages unavailable by direct request without deleting underlying finance code or data.
- [ ] Keep historical finance access out of public/seller/buyer navigation.
- [ ] Rewrite README product claims and route overview to describe the private-beta classifieds model. Clearly label dormant finance code as historical/disabled.
- [ ] Do not claim Hà Nội, TP.HCM, Hải Phòng, or any community is safe/guaranteed. Use `Khu vực beta trọng điểm` only where relevant.
- [ ] Run the focused tests until green.
- [ ] Run a public-copy scan and manually classify remaining occurrences:

```bash
rg -n -i 'escrow|hoa hồng|commission|giữ tiền|bảo vệ (người mua|thanh toán)|thanh toán qua|ví|rút tiền|payout|checkout' app src README.md
```

- [ ] Commit only public surface/copy changes:

```bash
git add src/components/header.tsx src/components/header-user-menu.tsx src/components/footer.tsx src/components/listing-form.tsx app README.md tests/unit/finance-public-surface.test.ts
git commit -m "feat(marketplace): remove beta-facing finance surfaces"
```

- [ ] Report exact direct-route behavior and every remaining public-copy scan hit.

## Task 5: Preserve read-only historical finance administration

**Files:**

- Modify: `app/admin/layout.tsx`
- Modify: `app/admin/page.tsx`
- Modify: `app/admin/orders/page.tsx`
- Modify: `app/admin/disputes/page.tsx`
- Modify: `app/admin/withdraws/page.tsx`
- Modify: `app/admin/settings/page.tsx`
- Modify: `src/lib/actions/admin.ts`
- Modify: `src/lib/actions/withdraw.ts`
- Create or modify: focused admin finance tests.

- [ ] Write failing tests proving historical finance records remain readable by the existing authorized admin boundary but mutation controls/actions are absent or denied.
- [ ] Confirm the tests fail before implementation.
- [ ] Label historical finance views clearly as dormant/read-only while finance is disabled.
- [ ] Remove or disable dispute resolution, withdrawal processing, commission configuration, and any other finance mutation control.
- [ ] Retain server-side assertions in the underlying actions even when controls are absent.
- [ ] Do not broaden current admin permissions in this batch; comprehensive MFA/RBAC belongs to Batch 2.
- [ ] Rerun focused tests until green.
- [ ] Commit the admin read-only changes:

```bash
git add app/admin src/lib/actions/admin.ts src/lib/actions/withdraw.ts tests
git commit -m "feat(admin): make historical finance views read-only"
```

## Task 6: Integrate and verify Batch 1

**Files:**

- Modify if required: `scripts/smoke.sh`
- Modify if required: `scripts/docker-smoke.sh`
- Modify if required: `tests/docker/docker-compose.smoke.yml`
- Create: `docs/operations/private-beta-finance-shutdown-verification.md`

- [ ] Integrate Task 3 and Task 4 commits onto the Task 2 base in a dedicated integration worktree. Resolve conflicts by preserving the central boundary and direct-route denial; never resolve by dropping a guard/test.
- [ ] Run `git diff --check` and inspect the complete diff against the Batch 0 inventory.
- [ ] Update smoke tests so disabled finance endpoints/pages assert their intended unavailable response instead of legacy payment behavior.
- [ ] Set `FINANCIAL_FEATURES_ENABLED=false` explicitly in smoke/beta configuration where configuration is enumerated.
- [ ] Run focused unit tests for finance boundary, actions, routes, public surface, cron, IPN, environment parsing, mock payments, ledger, and MoMo.
- [ ] Run `npm run lint`.
- [ ] Run `npx tsc --noEmit`.
- [ ] Run `npm test`.
- [ ] Run `npm run build`.
- [ ] Run `npm run smoke` against the repository’s safe local test setup.
- [ ] Run `npm run preflight` if it does not perform an external deployment or destructive action; otherwise run its safe constituent checks and document why.
- [ ] Run `npm run test:integration` with finance explicitly enabled only for legacy algorithm/invariant tests, then separately prove all operational beta entry points deny finance when disabled.
- [ ] Run the final source/copy scan and reconcile every result with one of:
  - dormant implementation behind a tested server boundary;
  - historical read-only admin surface;
  - test fixture/documentation explicitly describing disabled legacy behavior;
  - defect requiring correction before acceptance.
- [ ] Verify no tracked schema or migration deletes/repurposes historical finance data.
- [ ] Verify `git status --short` contains only intentional Batch 0–1 changes and known excluded local-only paths.
- [ ] Record in `docs/operations/private-beta-finance-shutdown-verification.md`:
  - base and final commit hashes;
  - OpenCode model/session metadata;
  - inventory coverage summary;
  - commands and pass/fail results;
  - direct-route response contract;
  - residual risks and deferred Batch 2 work.
- [ ] Commit verification artifacts and any smoke changes:

```bash
git add scripts/smoke.sh scripts/docker-smoke.sh tests/docker/docker-compose.smoke.yml docs/operations/private-beta-finance-shutdown-verification.md
git commit -m "test(finance): verify private-beta shutdown gate"
```

## Acceptance Gate

Batch 1 is accepted only if all of the following are true:

- `FINANCIAL_FEATURES_ENABLED` defaults to false and cannot be controlled by the browser.
- Every inventoried financial mutation entry point fails closed with `FINANCIAL_FEATURES_DISABLED` before mutation.
- Provider callback, return, and cron paths perform no operational finance work while disabled.
- Public navigation and direct public routes expose no live finance workflow.
- Listing detail leads to chat, not purchase/payment.
- Public copy makes no escrow/payment-protection/commission promise.
- Historical finance models and records are preserved.
- Historical admin views are read-only.
- Focused tests, full unit suite, lint, typecheck, production build, and safe smoke pass.
- Diff/status audit finds no unrelated or local-only files staged.
- The review owner has independently inspected the diff and rerun risk-proportional verification.
