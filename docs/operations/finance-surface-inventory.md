# Batch 0 — Finance Surface Inventory (LoaViet / Speaker Platform)

**Scope:** every reachable financial surface of the current escrow-and-commission marketplace, as required before the private-beta finance shutdown (Batch 0–1).
**Source documents:** `docs/superpowers/specs/2026-10-06-private-beta-marketplace-reset-design.md` (approved spec) and `docs/superpowers/plans/2026-10-06-private-beta-batch-0-1-finance-shutdown.md` (approved plan).
**Method:** full read of `app/**`, `src/components/**`, `src/lib/**`, `src/prisma/contract.prisma`, `scripts/**`, `tests/**`, `README.md`, plus the reconciliation search in §7. Starting commit/branch/status are recorded in the OpenCode report, not here.

**Terminology**

- **Money-path mutation** — a mutation that creates or changes money-adjacent state: `Order`, `OrderItem`, `Payment`, `Payout`, `WithdrawRequest`, `LedgerEntry`, `Dispute`, escrow/order lifecycle fields, commission configuration, or a provider payment request. All of these must fail closed with `FINANCIAL_FEATURES_DISABLED` while finance is disabled (spec §4.1).
- **Adjacent surface** — touches finance tables/flows but performs no money-path mutation (e.g. cart-row cleanup, order-count reads, trust flags). Classified per row; no finance guard unless the review owner decides otherwise.
- **Guard** — `assertFinancialFeaturesEnabled()` from the shared server-owned capability introduced by plan Task 2 (`src/lib/financial-features.ts`), backed by `FINANCIAL_FEATURES_ENABLED` (default `false`, server-only, validated at startup).

---

## 1. Reachable finance surfaces (main inventory)

Trigger types: `page` · `server action` · `route` · `webhook` · `cron` · `library` · `admin` · `copy` · `test` · `environment`.

### 1.1 Cart domain

| Surface | File + export | Trigger | Current behavior | Authn/Authz today | Planned disabled behavior | Planned guard location | Verification test |
|---|---|---|---|---|---|---|---|
| Add to cart | `src/lib/actions/cart.ts` → `addToCartAction` | server action | Reads `Listing`, gets/creates cart via `getOrCreateCart`, creates/increments `CartItem`, redirects to `/cart` | `requireUser()` (session; redirect to login) | Deny with `FINANCIAL_FEATURES_DISABLED` before the listing read and before any cart mutation | Top of action (Task 3, `cart.ts`) | `tests/unit/financial-shutdown-actions.test.ts` — spy proves no `CartItem.create/update` while disabled |
| Update cart item | `src/lib/actions/cart.ts` → `updateCartItemAction` | server action | Updates or deletes `CartItem` (quantity ≤ 0 → delete) | `requireUser()` + cart ownership re-check | Deny before read/mutation | Top of action | same test file — no `CartItem.update/delete` while disabled |
| Remove cart item | `src/lib/actions/cart.ts` → `removeFromCartAction` | server action | Deletes `CartItem` | `requireUser()` + cart ownership re-check | Deny before read/mutation | Top of action | same test file — no `CartItem.delete` while disabled |
| Cart page | `app/cart/page.tsx` → `CartPage` | page | Reads `Cart`/`CartItem` + listing/seller; renders update/remove forms, `/checkout` CTA, escrow copy (“tiền của bạn được giữ…”) | `getCurrentUser()` → redirect `/login` | Unreachable by direct request (Task 4 consistent choice: `notFound()` or safe redirect); escrow copy removed | Task 4 page retirement; actions guarded server-side regardless | `tests/unit/finance-public-surface.test.ts` — direct request expectation + no cart/checkout CTA |
| Get-or-create cart | `src/lib/actions/helpers.ts` → `getOrCreateCart` | library | Reads/creates `Cart` row | Only called after `requireUser()` (from `addToCartAction`) | Covered by action-level guard; defense-in-depth assert optional | Caller guard (Task 3 `cart.ts`); optional library assert | Covered by action tests |

### 1.2 Checkout & order domain (buyer/seller)

| Surface | File + export | Trigger | Current behavior | Authn/Authz today | Planned disabled behavior | Planned guard location | Verification test |
|---|---|---|---|---|---|---|---|
| **Cart-to-order conversion / direct buy** | `src/lib/actions/orders.ts` → `createOrderAction` | server action | Gathers cart items or direct listing; computes per-category commission; creates `Order` (awaiting_payment) + `OrderItem` + `Payment` (pending, provider `mock`/`manual`); marks `Listing`s sold; deletes cart items; redirects to order page | `requireUser()` | Deny with `FINANCIAL_FEATURES_DISABLED` before the cart/listing read and before any `Order`/`Payment`/`Listing` mutation | Top of action (Task 3, `orders.ts`) | `tests/unit/financial-shutdown-actions.test.ts` — spies: no `Order.create`, no `Payment.create`, no `Listing.update`, no `CartItem.delete` |
| Mock escrow payment | `src/lib/actions/orders.ts` → `payEscrowAction` | server action | `assertMockPaymentsAllowed()`; claims `Order` → `paid_escrow`, `Payment` → held, `OrderStatusHistory`, ledger `escrowIn`, notify | Mock guard (throws in production) + `requireUser()` + buyer ownership | Deny before the mock guard and before order read (finance assertion first) | Top of action, before `assertMockPaymentsAllowed()` | same test file — no ledger write, no `Order.updateAll` while disabled |
| Seller manual-payment confirmation | `src/lib/actions/orders.ts` → `sellerConfirmPaymentAction` | server action | Seller confirms direct/COD money received: `Order` → `processing`, `Payment` → held, sets `autoReleaseAt` (starts escrow clock), notify | `requireUser()` + seller ownership; rejects escrow-method orders | Deny before read/mutation | Top of action | same test file — no `Order`/`Payment` mutation while disabled |
| Ship order | `src/lib/actions/orders.ts` → `shipOrderAction` | server action | `Order` → `shipped`, sets `autoReleaseAt` (escrow auto-release clock), `OrderStatusHistory`, notify | `requireUser()` + seller ownership | Deny (order-lifecycle mutation inside the escrow flow) | Top of action | same test file |
| Confirm receipt → escrow release | `src/lib/actions/orders.ts` → `confirmReceiptAction` | server action | Claims `Order` → `completed`; escrow: `Payment` → released, **`Payout` create**, ledger `escrowRelease` (commission split); direct/COD: payment released only; `PriceHistory` sold rows; notify | `requireUser()` + buyer ownership | Deny before read/mutation — no payout, no ledger, no price-history write | Top of action | same test file — spies: no `Payout.create`, no `recordLedgerTx`, no `Payment.update` |
| Cancel order → escrow refund | `src/lib/actions/orders.ts` → `cancelOrderAction` | server action | Claims `Order` → `cancelled`; if payment held: `Payment` → refunded + ledger `escrowRefund`; returns listings to `approved` | `requireUser()` + buyer/seller state rules | Deny before read/mutation | Top of action | same test file — no refund ledger write while disabled |
| Open dispute (escrow freeze) | `src/lib/actions/orders.ts` → `openDisputeAction` | server action | Creates `Dispute`, `Order` → `disputed` (freezes escrow release), `OrderStatusHistory`, notify | `requireUser()` + order party | Deny (financial-dispute mutation, spec §4.1) | Top of action | same test file — no `Dispute.create` while disabled |
| Sold-price telemetry | `src/lib/actions/orders.ts` → `recordSoldPrices` (internal) | library | Creates `PriceHistory` (kind `sold`) per ordered item with a product model | Only reachable from `confirmReceiptAction` | Covered by caller guard | Caller guard | Covered by `confirmReceiptAction` test |
| Order review | `src/lib/actions/reviews.ts` → `submitReviewAction` | server action | Reads `Order` (must be `completed`), creates `Review` | `requireUser()` + buyer ownership | **Adjacent, non-money-path** (mutates `Review` only). No finance guard; historical reviews preserved. Reviews are a Batch 2 product decision (spec §3.2 excludes public reviews from P0) | None (classified) | Classification note; no focused shutdown test |
| Checkout page | `app/checkout/page.tsx` → `CheckoutPage` | page | Reads cart or direct listing + commission rate; renders `CheckoutForm`; escrow/commission copy | `getCurrentUser()` → redirect `/login` | Unreachable by direct request; copy removed | Task 4 page retirement | `tests/unit/finance-public-surface.test.ts` |
| Checkout form | `src/components/checkout-form.tsx` → `CheckoutForm` | page (client component) | Calls `createOrderAction` with `paymentMethod` = `escrow` \| `direct` \| `cod` | Rendered on checkout page only | Unreachable when page retired; action guarded server-side | Task 4 removal + Task 3 action guard | public-surface test + action test |
| Buyer order list | `app/orders/page.tsx` → `OrdersPage` | page | Reads buyer `Order`s + items/seller | `getCurrentUser()` → redirect `/login` | Unreachable by direct request (Task 4, `app/orders/**`) | Task 4 page retirement | public-surface test |
| Order detail | `app/orders/[id]/page.tsx` → `OrderDetailPage` | page | Reads order + payments + payout + disputes + status history; renders `EscrowPayModal`, `ConfirmReceiptButton`, seller-confirm/ship/cancel/dispute/review forms; escrow copy | `getCurrentUser()` + buyer/seller/admin party check (`notFound()` otherwise) | Unreachable by direct request; all rendered actions remain guarded server-side | Task 4 retirement + Task 3 action guards | public-surface test + action tests |
| Seller sales list | `app/orders/sales/page.tsx` → `SalesPage` | page | Reads seller `Order`s; revenue/commission stats; seller-confirm/ship forms | `getCurrentUser()` → redirect `/login` | Unreachable by direct request | Task 4 page retirement | public-surface test |
| Escrow pay modal | `src/components/escrow-pay-modal.tsx` → `EscrowPayModal` | page (client component) | Calls `payEscrowAction` (mock) and `POST /api/payments/momo/create` (real gateway) | Rendered on order detail for buyer of awaiting escrow order | Unreachable when order pages retire; action + route guarded | Task 4 removal + Task 3 guards | action + route tests |
| Confirm-receipt button | `src/components/confirm-receipt-button.tsx` → `ConfirmReceiptButton` | page (client component) | Calls `confirmReceiptAction` (escrow release) | Rendered on order pages | Unreachable; action guarded | Task 4 removal + Task 3 guard | action test |

### 1.3 Offer (trả giá) domain

| Surface | File + export | Trigger | Current behavior | Authn/Authz today | Planned disabled behavior | Planned guard location | Verification test |
|---|---|---|---|---|---|---|---|
| Create offer | `src/lib/actions/offers.ts` → `createOfferAction` | server action | Creates `Offer` (proposed, 3-day expiry) on negotiable listing; notify | `requireUser()`; listing/negotiable/own-listing checks | Deny (purchase-intent surface whose acceptance creates orders) | Top of action (Task 3, `offers.ts`) | `tests/unit/financial-shutdown-actions.test.ts` — no `Offer.create` while disabled |
| **Respond to offer → creates Order (indirect)** | `src/lib/actions/offers.ts` → `respondOfferAction` | server action | `accept`: computes commission, **creates `Order` + `OrderItem` + `Payment` (escrow, mock)**, marks `Listing` sold, `Offer` → accepted; `counter`/`reject`: offer state only | `requireUser()` + seller ownership + offer/listing state | Deny before read/mutation — no order creation | Top of action | same test file — spy: no `Order.create`/`Payment.create`/`Listing.update` on `accept` while disabled |
| **Accept counter → creates Order (indirect)** | `src/lib/actions/offers.ts` → `acceptCounterAction` | server action | **Creates `Order` + `OrderItem` + `Payment`** at counter price, marks `Listing` sold, `Offer` → accepted, redirects to order | `requireUser()` + buyer ownership + state checks | Deny before read/mutation | Top of action | same test file — same spies |
| Cancel offer | `src/lib/actions/offers.ts` → `cancelOfferAction` | server action | `Offer` → cancelled | `requireUser()` + buyer ownership | Deny (same file boundary) | Top of action | same test file |
| Offers page | `app/offers/page.tsx` → `OffersPage` | page | Lists received/sent offers via `OfferCard`; copy “chấp nhận là tạo đơn escrow ngay tại giá đã chốt” | `getCurrentUser()` → redirect `/login` | Unreachable by direct request; copy removed | Task 4 retirement | public-surface test |
| Offer form | `src/components/offer-form.tsx` → `OfferForm` | page (client component) | Calls `createOfferAction` | Rendered on listing detail for negotiable listings | Removed from listing detail (Task 4); action guarded | Task 4 + Task 3 | public-surface + action tests |
| Offer card | `src/components/offer-card.tsx` → `OfferCard` | page (server component) | Renders respond/accept-counter/cancel forms; links to created order | Rendered on offers page | Unreachable; actions guarded | Task 4 + Task 3 | public-surface + action tests |

### 1.4 Exchange (trao đổi + tiền bù) domain

| Surface | File + export | Trigger | Current behavior | Authn/Authz today | Planned disabled behavior | Planned guard location | Verification test |
|---|---|---|---|---|---|---|---|
| Create exchange offer | `src/lib/actions/exchange.ts` → `createExchangeOfferAction` | server action | Creates `ExchangeOffer` (`cashTopup`, `commissionRate` snapshot); opens `Conversation` (chat) | `requireUser()`; listing/own-item checks | Deny before mutation (cash-top-up intent surface; conversation creation moves to the normal chat flow) | Top of action (Task 3, `exchange.ts`) | `tests/unit/financial-shutdown-actions.test.ts` — no `ExchangeOffer.create` while disabled |
| Respond to exchange offer | `src/lib/actions/exchange.ts` → `respondExchangeOfferAction` | server action | `accept` → `accepted` (awaits top-up escrow) + notify; `reject` → rejected | `requireUser()` + seller ownership | Deny before mutation | Top of action | same test file |
| **Mock top-up into escrow** | `src/lib/actions/exchange.ts` → `payExchangeTopupAction` | server action | `assertMockPaymentsAllowed()`; creates `Payment` (held), `ExchangeOffer` → paid, ledger `escrowIn` | Mock guard + `requireUser()` + buyer ownership | Deny before mock guard and before mutation | Top of action, before `assertMockPaymentsAllowed()` | same test file — no `Payment.create`, no ledger write |
| **Complete exchange → escrow release** | `src/lib/actions/exchange.ts` → `completeExchangeAction` | server action | If top-up paid: `Payment` → released, **`Payout` create**, ledger `escrowRelease` (commission on top-up); marks both listings sold; offer → completed | `requireUser()` + party checks + state rules | Deny before read/mutation | Top of action | same test file — no `Payout.create`/ledger write |
| Cancel exchange offer | `src/lib/actions/exchange.ts` → `cancelExchangeOfferAction` | server action | `ExchangeOffer` → cancelled (top-up not yet paid at `accepted`, so no refund path exists today) | `requireUser()` + buyer ownership | Deny | Top of action | same test file |
| Exchange list page | `app/exchange/page.tsx` → `ExchangePage` | page | Lists sent/received exchange offers; top-up (`ExchangeTopupButton` + mock form), complete, cancel forms; escrow copy | `getCurrentUser()` → redirect `/login` | Unreachable by direct request; copy removed | Task 4 retirement | public-surface test |
| Exchange offer page | `app/listings/[slug]/exchange/page.tsx` → `ExchangeOfferPage` | page | Renders `ExchangeOfferForm`; escrow/commission copy | `getCurrentUser()` → redirect `/login`; listing checks | Unreachable by direct request; copy removed | Task 4 retirement | public-surface test |
| Exchange offer form | `src/components/exchange-offer-form.tsx` → `ExchangeOfferForm` | page (client component) | Calls `createExchangeOfferAction` (cash top-up field) | Rendered on exchange page | Unreachable; action guarded | Task 4 + Task 3 | public-surface + action tests |
| Exchange top-up button | `src/components/exchange-topup-button.tsx` → `ExchangeTopupButton` | page (client component) | `POST /api/payments/momo/create` with `exchangeOfferId` | Rendered on exchange page | Unreachable; route guarded | Task 4 + Task 3 | route test |

### 1.5 Escrow / ledger / wallet libraries

| Surface | File + export | Trigger | Current behavior | Authn/Authz today | Planned disabled behavior | Planned guard location | Verification test |
|---|---|---|---|---|---|---|---|
| **Mark escrow paid (order)** | `src/lib/escrow.ts` → `markEscrowPaid` | library | Atomic claim `Order` → `paid_escrow` + `autoReleaseAt`; `Payment` → held (invariant: exactly 1 pending); `OrderStatusHistory`; ledger `escrowIn`; notify | `import "server-only"`; callers: MoMo IPN route, MoMo return page | Deny: entry points guarded **and** defense-in-depth `assertFinancialFeaturesEnabled()` inside `escrow.ts` (Task 3 modifies it) | `escrow.ts` (defense-in-depth) + callers | `tests/unit/financial-shutdown-routes.test.ts` (IPN/return prove no escrow mutation); direct-library test optional |
| **Mark exchange top-up paid** | `src/lib/escrow.ts` → `markExchangeTopupPaid` | library | Atomic claim `ExchangeOffer` → paid; `Payment` → held; ledger `escrowIn`; notify | Same callers as above | Same denial | Same | Same |
| Ledger writer | `src/lib/ledger.ts` → `recordLedgerTx` (+ builders `escrowIn`, `escrowRelease`, `escrowRefund`, `withdrawPaid`) | library | Writes balanced `LedgerEntry` pairs (immutable double-entry) | `server-only`; callers: orders/exchange/withdraw/admin actions, `processAutoReleases`, `escrow.ts` | All current callers are guarded entry points (§1.2–1.4, 1.6, 1.8). **Note:** `ledger.ts` is not in plan Task 3's file list — see §8 note L-1 | Caller guards; optional defense-in-depth assert in a follow-up | Covered by action/route tests (spy on `recordLedgerTx` / `LedgerEntry.create`) |
| Escrow reconciliation | `src/lib/ledger.ts` → `reconcileEscrow` | library | Reads ledger escrow total vs `Payment` held total | `server-only`; used by integration tests | Read-only; no guard needed (historical invariant check) | None (read) | `tests/integration/escrow.test.ts` (legacy algorithm test — run with finance explicitly enabled in isolated setup) |
| Wallet summary | `src/lib/wallet.ts` → `getWalletSummary` | library | Aggregates `Payout` released − `WithdrawRequest` paid/pending | `server-only`; callers: wallet page, withdraw actions | Deny the operational read (assert in `wallet.ts` — Task 3 modifies it) | `wallet.ts` | `tests/unit/financial-shutdown-actions.test.ts` (withdraw actions) — wallet read denied before aggregation |
| Mock-payment guard | `src/lib/mock-payment.ts` → `assertMockPaymentsAllowed` | library | Throws `MOCK_PAYMENT_DISABLED_IN_PRODUCTION` when `NODE_ENV=production` | `server-only` | Unchanged; finance assertion runs first in the calling actions | None (existing guard retained) | `tests/unit/mock-payment-guard.test.ts` (existing, stays green) |
| Commission math | `src/lib/utils.ts` → `computeCommission`, `generateOrderCode` | library | Pure functions (no I/O) | shared module | No guard (pure); callers guarded | None | Covered by caller tests |
| Auto-release engine | `src/lib/actions/helpers.ts` → `processAutoReleases` | library | For each overdue shipped order: claim → `completed`, `Payment` → released, **`Payout` create**, ledger `escrowRelease`, `OrderStatusHistory`, notify | Not exported via `"use server"`; only caller is the cron route (dashboard no longer calls it) | Deny at the cron route before this runs; **note:** `helpers.ts` not in Task 3 file list — see §8 note L-2 | Cron route guard (Task 3) | `tests/unit/cron-auto-release-route.test.ts` (updated) + `tests/unit/financial-shutdown-routes.test.ts` |
| Finance config read | `src/lib/actions/helpers.ts` → `getAutoReleaseDays` | library | Reads `PlatformSetting.escrow_auto_release_days` (fallback 7) | Internal; callers: guarded finance actions | Covered by caller guards | Caller guards | Covered by action tests |
| Order status history | `src/lib/actions/helpers.ts` → `recordStatusChange` | library | Creates `OrderStatusHistory` rows | Internal; callers: guarded finance actions | Covered by caller guards | Caller guards | Covered by action tests |
| Cart bootstrap | `src/lib/actions/helpers.ts` → `getOrCreateCart` | library | See §1.1 | Internal | Covered | Caller guards | Covered |
| Admin audit writer | `src/lib/actions/helpers.ts` → `audit` | library | Creates `AdminAuditLog` rows | Internal; callers: guarded admin actions | Covered by caller guards | Caller guards | Covered by admin tests |

### 1.6 MoMo payment provider

| Surface | File + export | Trigger | Current behavior | Authn/Authz today | Planned disabled behavior | Planned guard location | Verification test |
|---|---|---|---|---|---|---|---|
| **Create MoMo payment** | `app/api/payments/momo/create/route.ts` → `POST` | route | Rate limit → session → reads `Order` (or `ExchangeOffer`) → `createMomoPayment` (HMAC-signed provider request, returns `payUrl`) | Rate limit + `getCurrentUser()` (401) + buyer ownership | Deny with typed `FINANCIAL_FEATURES_DISABLED` response **before** the order/offer read and before any provider request creation | Top of route handler (Task 3) | `tests/unit/financial-shutdown-routes.test.ts` — spy: no `createMomoPayment` call, no `Order` read while disabled |
| **MoMo IPN webhook** | `app/api/payments/momo/ipn/route.ts` → `POST` | webhook | Rate limit → parse JSON → `verifyMomoCallback` (HMAC, timing-safe) → `resultCode` check → amount-match read of `Order`/`ExchangeOffer` → `markEscrowPaid` / `markExchangeTopupPaid` (escrow mutation + ledger) | Provider HMAC signature (no user session); fail-closed 401 when unconfigured | Deny **before** parsing/mutating on a successful provider payload: respond with the stable typed code, no escrow mutation, no redirect into a live finance flow | Top of route handler, before signature verification work that leads to mutation (Task 3) | `tests/unit/financial-shutdown-routes.test.ts` — valid signed payload produces **no** `markEscrowPaid`/`markExchangeTopupPaid` call while disabled; existing `tests/unit/ipn-route.test.ts` hardening cases stay green |
| **MoMo return URL** | `app/payments/momo/return/page.tsx` → `MomoReturnPage` (GET) | page | Verifies callback signature from query params → `markEscrowPaid`/`markExchangeTopupPaid` → redirects to `/orders/[id]?paid=1` or `/exchange?paid=1` | Provider signature only (buyer browser redirect; no session check) | No mutation while disabled; redirect to a non-financial page or render unavailable — never into a live finance flow | Top of page (Task 3 owns this file) | `tests/unit/financial-shutdown-routes.test.ts` — valid signed query produces no escrow mutation and no live-finance redirect |
| Provider client | `src/lib/momo.ts` → `createMomoPayment` | library | Signs and POSTs `/v2/gateway/api/create` to MoMo; fails loud `MOMO_NOT_CONFIGURED` | `server-only`; env credentials | Defense-in-depth assert in `momo.ts` (Task 3 modifies it) + route guard | `momo.ts` + route | Route tests + `tests/unit/momo.test.ts` (existing signature/config cases stay green) |
| Callback verification | `src/lib/momo.ts` → `verifyMomoCallback`, `buildCallbackRawSignature`, `momoConfig`, `isMomoConfigured` | library | HMAC verification (read-only crypto); config presence flag used by pages | `server-only` | Verification itself is not a mutation; entry points guarded; `isMomoConfigured` reads disappear with retired pages | Entry-point guards | Existing `tests/unit/momo.test.ts` |

### 1.7 Cron

| Surface | File + export | Trigger | Current behavior | Authn/Authz today | Planned disabled behavior | Planned guard location | Verification test |
|---|---|---|---|---|---|---|---|
| **Escrow auto-release cron** | `app/api/cron/auto-release/route.ts` → `POST` | cron | `CRON_SECRET` fail-closed (503 unconfigured / 401 wrong) → `processAutoReleases()` (escrow release, `Payout` create, ledger, notify) | Bearer `CRON_SECRET`, timing-safe | Deny operational work: respond `{ok:false, error:"FINANCIAL_FEATURES_DISABLED"}` **before** `processAutoReleases`; no payout/ledger mutation | Top of route handler, after/with existing fail-closed checks (Task 3) | `tests/unit/financial-shutdown-routes.test.ts` — correct secret + disabled → no `processAutoReleases` call; `tests/unit/cron-auto-release-route.test.ts` (updated expectations) |
| Cron auth | `src/lib/cron-auth.ts` → `verifyCronAuth` | library | Timing-safe bearer comparison, fail closed | `server-only` | Unchanged | None | `tests/unit/cron-auth.test.ts` (existing, stays green) |

### 1.8 Wallet & withdrawal domain

| Surface | File + export | Trigger | Current behavior | Authn/Authz today | Planned disabled behavior | Planned guard location | Verification test |
|---|---|---|---|---|---|---|---|
| **Seller withdraw request** | `src/lib/actions/withdraw.ts` → `createWithdrawRequestAction` | server action | Validates bank/amount; reads `getWalletSummary`; creates `WithdrawRequest` (requested) | `requireUser()` | Deny before the wallet read and before `WithdrawRequest.create` | Top of action (Task 3, `withdraw.ts`) | `tests/unit/financial-shutdown-actions.test.ts` — no `WithdrawRequest.create`, no wallet aggregation while disabled |
| **Admin withdraw processing** | `src/lib/actions/withdraw.ts` → `processWithdrawAction` | admin (server action) | `requireAdmin()`; atomic claim `WithdrawRequest` → processing/paid/rejected; on paid: balance re-check + ledger `withdrawPaid`; audit; notify | `requireAdmin()` | Deny before read/mutation — no status transition, no ledger debit | Top of action (Task 3); Task 5 also removes the admin controls | same test file — no `WithdrawRequest.updateAll`, no ledger write; Task 5 admin test proves controls absent |
| Wallet page | `app/wallet/page.tsx` → `WalletPage` | page | Reads `getWalletSummary` + withdraw history; renders `WithdrawForm` | `getCurrentUser()` → redirect `/login` | Unreachable by direct request | Task 4 retirement | public-surface test |
| Withdraw form | `src/components/withdraw-form.tsx` → `WithdrawForm` | page (client component) | Calls `createWithdrawRequestAction` | Rendered on wallet page | Unreachable; action guarded | Task 4 + Task 3 | public-surface + action tests |

### 1.9 Admin domain

| Surface | File + export | Trigger | Current behavior | Authn/Authz today | Planned disabled behavior | Planned guard location | Verification test |
|---|---|---|---|---|---|---|---|
| **Admin dispute resolution** | `src/lib/actions/admin.ts` → `resolveDisputeAction` | admin (server action) | `resolved_buyer`: `Payment` → refunded, `Order` → refunded, ledger `escrowRefund`, listings back to approved; `resolved_seller`: `Payment` → released, `Order` → completed, **`Payout` create** (if none), ledger `escrowRelease`; `closed`: order back to shipped (awaits auto-release) | `requireAdmin()` | Deny before read/mutation — no refund, no release, no payout, no ledger | Top of action (Task 3, `admin.ts`); Task 5 removes the resolution controls | `tests/unit/financial-shutdown-actions.test.ts` — all three outcomes mutate nothing while disabled; Task 5 admin test proves controls absent but records readable |
| **Admin commission change** | `src/lib/actions/admin.ts` → `updateCommissionAction` | admin (server action) | Mutates `Category.commissionRate` (0–30) + audit | `requireAdmin()` | Deny (commission mutation, spec §4.1) | Top of action; Task 5 removes the config UI | same test file — no `Category.update` while disabled |
| **Admin platform settings** | `src/lib/actions/admin.ts` → `updateSettingAction` | admin (server action) | Upserts `PlatformSetting` by arbitrary key; UI today exposes finance keys `escrow_auto_release_days` and `default_commission_rate` | `requireAdmin()` | Deny for finance settings (action guarded; Task 5 removes the finance settings forms). No non-finance settings exist in the UI today | Top of action; Task 5 UI removal | same test file — no `PlatformSetting` upsert while disabled |
| Seller verification toggle | `src/lib/actions/admin.ts` → `toggleSellerVerificationAction` | admin (server action) | Toggles `User.isVerifiedSeller` (schema comment: “đã xác minh để nhận giải ngân”); audit | `requireAdmin()`; refuses admins as targets | **Adjacent, non-money-path** (trust/eligibility flag; not enforced by payout/withdraw code — only displayed). Seller verification is a Batch 2 domain (spec §5.3). No finance guard this batch | None (classified; Batch 2) | Classification note; Task 5 admin tests must not broaden permissions |
| Listing moderation | `src/lib/actions/admin.ts` → `approveListingAction`, `rejectListingAction` | admin (server action) | Listing approve/reject + audit + notify | `requireAdmin()` | Unchanged (non-finance) | None | Existing behavior; not a shutdown target |
| Admin navigation | `app/admin/layout.tsx` → `AdminLayout` | admin (page) | Sidebar/mobile nav links: orders, disputes, withdraws, settings (“Hoa hồng & cấu hình”) | `getCurrentUser()` + role=admin else redirect | Keep historical finance views reachable read-only, clearly labeled dormant/read-only (Task 5); no mutation controls | Task 5 labeling | Task 5 focused admin test |
| Admin dashboard | `app/admin/page.tsx` → `AdminDashboardPage` | admin (page) | Reads GMV, commission total, escrow held (`Payment` held), completed count, pending withdraws, recent orders | Admin layout guard | Read-only retained; labeled dormant (Task 5). No `processAutoReleases` on page load (already removed) | Task 5 labeling | Task 5 admin test |
| Admin orders view | `app/admin/orders/page.tsx` | admin (page) | Order table read + escrow-held sum + links to order detail | Admin layout guard | Read-only retained (Task 5) | Task 5 | Task 5 admin test |
| Admin disputes view | `app/admin/disputes/page.tsx` | admin (page) | Dispute list read + `resolveDisputeAction` forms | Admin layout guard | Records readable; resolution controls removed/denied (Task 5) + action guard (Task 3) | Task 5 + Task 3 | Task 5 admin test + shutdown action test |
| Admin withdraws view | `app/admin/withdraws/page.tsx` | admin (page) | Withdraw list read + `processWithdrawAction` forms | Admin layout guard | Records readable; processing controls removed/denied (Task 5) + action guard | Task 5 + Task 3 | Task 5 admin test + shutdown action test |
| Admin settings view | `app/admin/settings/page.tsx` | admin (page) | Commission-per-category forms + finance settings forms + audit log read | Admin layout guard | Commission/settings forms removed/denied (Task 5); audit log stays readable | Task 5 + Task 3 action guards | Task 5 admin test + shutdown action test |
| Admin users view | `app/admin/users/page.tsx` | admin (page) | User list + completed-sales `Order` count read + seller-verification toggle forms | Admin layout guard | Order counts stay readable (historical); seller verification is Batch 2 (non-money-path, see above) | None this batch (classified) | Task 5 admin test (read-only finance) |

---

## 2. Indirect mutation chains (explicit checklist)

Every chain from plan Task 1, with the entry point that must deny first and the defense-in-depth layer:

| # | Chain | Path today | Denial point | Defense-in-depth |
|---|---|---|---|---|
| 1 | Offer acceptance creating an `Order` | `OfferCard`/`respondOfferAction(accept)` and `acceptCounterAction` → `Order` + `OrderItem` + `Payment` + `Listing.sold` | Guard at top of both actions (Task 3) | Optional `Order`-level helper assert not required — actions are the outermost entry points |
| 2 | Exchange cash top-up and completion | `createExchangeOfferAction` (top-up intent) → `respondExchangeOfferAction(accept)` → `payExchangeTopupAction` (mock escrow) or `POST /api/payments/momo/create` → `markExchangeTopupPaid` (IPN/return) → `completeExchangeAction` (payout + ledger) | Guards on all three actions + momo create route + IPN/return pages | `escrow.ts` assert (Task 3) |
| 3 | Payment return and IPN paths | MoMo → `POST /api/payments/momo/ipn` and `GET /payments/momo/return` → `verifyMomoCallback` → `markEscrowPaid`/`markExchangeTopupPaid` (escrow claim + `Payment` held + ledger) | Route/page guards before any successful-payload processing (Task 3) | `escrow.ts` assert |
| 4 | Auto-release cron | Scheduler → `POST /api/cron/auto-release` (`CRON_SECRET`) → `processAutoReleases` (payout + ledger per overdue order) | Route guard before `processAutoReleases` (Task 3) | — |
| 5 | Admin dispute resolution | `app/admin/disputes` → `resolveDisputeAction` → refund/release + `Payout` + ledger | Action guard (Task 3) + controls removed (Task 5) | — |
| 6 | Admin commission changes | `app/admin/settings` → `updateCommissionAction` → `Category.commissionRate` | Action guard (Task 3) + forms removed (Task 5) | — |
| 7 | Seller manual-payment confirmation | Order detail/sales → `sellerConfirmPaymentAction` → `Payment` held + escrow clock | Action guard (Task 3) | — |
| 8 | Wallet/withdrawal processing | `app/wallet` → `createWithdrawRequestAction` → admin `processWithdrawAction` → ledger `withdrawPaid` | Guards on both actions (Task 3); wallet read denied in `wallet.ts` | `wallet.ts` assert |
| 9 | Mock payment actions | `EscrowPayModal` → `payEscrowAction`; exchange page → `payExchangeTopupAction` (both behind `assertMockPaymentsAllowed`) | Finance assertion **before** the mock guard at the top of each action (Task 3) | `mock-payment.ts` guard retained |
| 10 | Cart-to-order conversion | `app/cart` → `/checkout` → `CheckoutForm` → `createOrderAction` (multi-seller order split, commission snapshot, cart clear) | Action guard before cart/listing reads (Task 3) | — |

Additional indirect chains found during inspection (not on the plan's list, classified):

- **Listing deletion clears cart rows** — `deleteListingAction` (`src/lib/actions/listings.ts:218-226`) deletes `CartItem` rows for never-ordered listings. **Adjacent, non-money-path** (row cleanup; not cart-to-order conversion). No guard planned; flagged in §8 note A-1.
- **Register/login bootstraps a cart** — `registerAction`/`loginAction` (`src/lib/actions/auth.ts:73,108-109`) create a `Cart` row per user. **Adjacent, non-money-path.** No guard planned; §8 note A-2.
- **Order-completion price telemetry** — `recordSoldPrices` writes `PriceHistory` from `confirmReceiptAction`; covered by the action guard.
- **Notifications on finance events** — `notify()` calls inside finance actions create `Notification` rows; covered by the action guards (no independent entry point).

---

## 3. Public navigation, metadata, manifest, robots/sitemap, README, admin navigation

| Surface | File | Kind | Current content | Planned disabled behavior | Owner |
|---|---|---|---|---|---|
| Desktop/mobile header | `src/components/header.tsx` | navigation | Cart icon + badge linking `/cart` (reads `Cart`/`CartItem` count); “Trao đổi” nav link → `/listings?exchange=1` | Remove cart icon + cart-count read; exchange link per Task 4 copy decision | Task 4 |
| User menu | `src/components/header-user-menu.tsx` | navigation | Links: `/wallet` (“Ví & rút tiền”), `/offers`, `/orders`, `/orders/sales` | Remove wallet/orders/offers links (historical finance stays out of public/seller/buyer nav) | Task 4 |
| Footer | `src/components/footer.tsx` | copy + navigation | Escrow promise (“Tiền của người mua được giữ hộ…”, “giữ tiền giao dịch”), commission claim; links `/orders`, `/wallet`, `/orders/sales` | Rewrite to classifieds copy with no escrow/commission/holding promise; remove finance links | Task 4 |
| Listing detail CTAs | `app/listings/[slug]/page.tsx` | page + copy | “Mua ngay” → `/checkout?listing=…`; “Thêm vào giỏ” form (`addToCartAction`); exchange CTA; escrow promise box (“tiền vẫn đang được giữ”); commission panel (“Hoa hồng nền tảng… LoaViet thu…”) | Replace purchase/payment CTAs with “Nhắn người bán” into the existing chat flow + accurate non-custodial copy; remove commission panel | Task 4 |
| Home page copy | `app/page.tsx` | copy | 3-step escrow/MoMo explainer (“Bạn trả tiền vào nền tảng…”, “tiền trừ hoa hồng chuyển cho người bán”), “hoa hồng chỉ trừ khi bán được hàng” | Rewrite to beta-classifieds copy; no escrow/commission/holding promise. **Not in Task 4's explicit file list but under its `git add app` + copy scan — see §8 note C-1** | Task 4 |
| Seller profile copy | `app/seller/[id]/page.tsx` | copy + read | “Giao dịch với người bán này qua LoaViet để được escrow bảo vệ — nền tảng giữ tiền…”; completed-sales `Order` count read | Remove escrow-protection promise; historical count read may remain (read-only). **§8 note C-1** | Task 4 |
| Seller listing form copy | `src/components/listing-form.tsx` | copy | “Hoa hồng X% chỉ thu khi giao dịch hoàn tất”, “sau hoa hồng X%”, payout example | Remove/replace commission copy. **File is under `src/` and NOT in Task 4's file list or its `git add` — see §8 note C-2 (plan-coverage gap)** | Task 4 (amend) |
| Sell pages | `app/sell/new/page.tsx`, `app/sell/[id]/edit/page.tsx`, `app/sell/my/page.tsx` | copy + navigation | Pass `commissionRate` into `ListingForm`; `sell/my` links to `/exchange` for pending exchange offers | Drop commission payload/copy; `/exchange` link removed with exchange retirement. **§8 note C-1** | Task 4 |
| Cart page copy | `app/cart/page.tsx` | copy | “Khi thanh toán qua nền tảng (escrow), tiền của bạn được giữ…” | Page retired (§1.1) | Task 4 |
| Checkout page copy | `app/checkout/page.tsx` | copy | “Escrow: tiền được giữ đến khi bạn xác nhận nhận hàng”, “Hoa hồng X% thu từ người bán” | Page retired (§1.2) | Task 4 |
| Orders/wallet/offers/exchange copy | `app/orders/**`, `app/wallet/page.tsx`, `app/offers/page.tsx`, `app/exchange/page.tsx`, `app/listings/[slug]/exchange/page.tsx` | copy | Escrow/commission/payout statements inside finance pages | Pages retired; copy goes with them | Task 4 |
| Status label constants | `src/lib/constants.ts` | copy (constants) | `ORDER_STATUS_LABELS`, `PAYMENT_METHOD_LABELS`, `PAYMENT_STATUS_LABELS`, `EXCHANGE_STATUS_LABELS`, `DISPUTE_STATUS_LABELS` | Dormant — only rendered by retired pages and read-only admin views; keep unchanged (historical labels) | None (dormant) |
| Notification icons | `app/notifications/page.tsx` | copy (display) | Icons for `order`/`dispute`/`withdraw` notification kinds | Dormant display; historical notifications may render; no finance promise made | None (dormant) |
| PWA manifest | `app/manifest.ts` | metadata | Description: “Escrow bảo vệ người mua, hoa hồng minh bạch cho người bán.” | Rewrite description without escrow/commission promise | Task 4 |
| robots | `app/robots.ts` | metadata | Disallows `/cart`, `/checkout`, `/orders`, `/wallet`, `/offers`, `/exchange` (plus admin/api/private) | Keep disallow entries (harmless once routes 404); optionally prune retired paths | Task 4 |
| sitemap | `app/sitemap.ts` | metadata | No finance URLs; includes `/listings?exchange=1` static entry | Remove/keep exchange filter entry per Task 4 copy decision; no finance route is advertised | Task 4 |
| README | `README.md` | copy | Escrow marketplace positioning, escrow lifecycle diagram, commission/MoMo feature table, finance route overview | Rewrite to private-beta classifieds model; label dormant finance code as historical/disabled; no city/community safety claims; use “Khu vực beta trọng điểm” if relevant | Task 4 |
| Admin navigation | `app/admin/layout.tsx` | admin navigation | Nav: Đơn hàng, Khiếu nại, Rút tiền, “Hoa hồng & cấu hình” | Keep as read-only historical views, labeled dormant (Task 5); mutation controls removed from the pages themselves | Task 5 |
| Profile order counts | `app/profile/page.tsx` | read | Completed sales/purchases `Order` counts on own profile | Read-only historical; unchanged | None (dormant) |

---

## 4. Preservation table — finance models/tables that must remain unchanged

No schema/migration change in Batch 0–1 may delete, drop, or repurpose any of these (spec §4.3, plan global constraints):

| Model / artifact | Role | Disposition |
|---|---|---|
| `Order` (+ enum `order_status`) | Buyer/seller transaction record, escrow lifecycle, commission snapshot | Preserve + historical read-only admin |
| `OrderItem` | Line-item snapshots tied to orders | Preserve |
| `Payment` (+ enums `payment_method`, `payment_status`) | Provider/escrow money state per order or exchange offer | Preserve |
| `Payout` | Seller release records | Preserve |
| `WithdrawRequest` (+ enum `withdraw_status`) | Seller withdrawal requests + admin processing state | Preserve |
| `LedgerEntry` | Immutable double-entry ledger | Preserve |
| `Dispute` (+ enum `dispute_status`) | Financial dispute records + resolutions | Preserve (read-only admin) |
| `OrderStatusHistory` | Order lifecycle audit trail | Preserve |
| `ExchangeOffer` finance fields (`cashTopup`, `commissionRate`, `payment` relation; enum `exchange_status`) | Exchange top-up escrow state | Preserve (finance-related fields explicitly protected) |
| `Offer` (+ enum `offer_status`, `orderId` link) | Price-negotiation records that created orders | Preserve |
| `Cart` / `CartItem` | Cart state | Preserve (rows dormant; no destructive cleanup) |
| `Category.commissionRate` | Commission configuration | Preserve (mutation denied while disabled) |
| `PlatformSetting` finance keys (`escrow_auto_release_days`, `default_commission_rate`) | Finance configuration | Preserve (mutation denied while disabled) |
| `User.isVerifiedSeller` | Payout-eligibility trust flag | Preserve (Batch 2 verification domain) |
| `Review` (`orderId`) | Historical order reviews | Preserve |
| `AdminAuditLog` | Finance action audit history | Preserve |
| `Notification` finance kinds (`order`, `dispute`, `withdraw`, `offer`, `counter`) | Historical user notifications | Preserve |
| `src/prisma/contract.prisma` | Source of truth for all above | No destructive change |
| `src/prisma/contract.d.ts`, `src/prisma/contract.json` | Generated contract artifacts (mirror the schema) | Regenerate only via `prisma contract emit`; no hand edits |
| `migrations/**` (graph + snapshots) | Replayable migration history | No destructive migration; new migrations must not drop finance data |

---

## 5. Environment surfaces

| Surface | File | Current state | Planned change |
|---|---|---|---|
| Finance capability flag | *(new)* `FINANCIAL_FEATURES_ENABLED` | Does not exist yet | Task 2: server-only, default `false`, strict parsing, validated via `src/lib/env.ts` + `instrumentation.ts`; documented in `.env.example` as disabled-by-default for private beta; never `NEXT_PUBLIC_*` |
| Escrow window | `.env.example` `ESCROW_AUTO_RELEASE_DAYS=7`; validated 1–30 in `src/lib/env.ts` | Dormant once escrow actions/cron deny | Unchanged (dormant config) |
| MoMo credentials | `.env.example` `MOMO_PARTNER_CODE/ACCESS_KEY/SECRET_KEY/ENDPOINT`; all-or-nothing validation in `src/lib/env.ts` | Provider client fails loud when unconfigured | Unchanged (dormant provider config) |
| Cron secret | `.env.example` `CRON_SECRET`; fail-closed route | Required for cron route | Unchanged; cron additionally denied by finance flag |
| Startup validation | `instrumentation.ts` → `validateEnv` (fail-fast in production) | Validates DB/auth/app/cron/MoMo keys | Task 2 adds `FINANCIAL_FEATURES_ENABLED` validation here |
| Production compose | `docker-compose.prod.yml` (`ESCROW_AUTO_RELEASE_DAYS`, `CRON_SECRET`, `MOMO_*`) | Enumerates finance env | Task 6 sets `FINANCIAL_FEATURES_ENABLED=false` explicitly where configuration is enumerated |
| Smoke compose | `tests/docker/docker-compose.smoke.yml` (`ESCROW_AUTO_RELEASE_DAYS: "7"`, empty MoMo) | Smoke stack env | Task 6 adds explicit `FINANCIAL_FEATURES_ENABLED=false` + updated endpoint expectations |
| Dev seed | `src/prisma/seed.ts` | Dev/test only; refuses `NODE_ENV=production` and missing `SEED_PASSWORD`; wipes + reseeds finance tables on dev DBs | Unchanged; offline dev tool, no HTTP/admin/cron exposure (spec §5.1.1 compliance note: it is destructive **by design** to dev databases only) |
| Ops scripts | `scripts/backup-db.sh`, `scripts/restore-db.sh` | Offline pg_dump/pg_restore; restore refuses to overwrite existing DBs | Unchanged; these are the sanctioned offline maintenance path (spec §5.1.1) |

---

## 6. Test surfaces

| Test file | Covers | Disposition in Batch 1 |
|---|---|---|
| `tests/unit/momo.test.ts` | MoMo config/signing fail-loud behavior | Keep green; provider client gains defense-in-depth assert (Task 3) |
| `tests/unit/ipn-route.test.ts` | IPN hardening (400/401 before DB) | Keep green; add disabled-mode case in `financial-shutdown-routes.test.ts` |
| `tests/unit/ledger.test.ts` | Double-entry invariants (pure) | Keep green (pure functions unchanged) |
| `tests/unit/mock-payment-guard.test.ts` | Mock-payment production guard | Keep green; finance assertion precedes it in actions |
| `tests/unit/cron-auto-release-route.test.ts` | Cron fail-closed/auth/idempotency | Update: correct-secret + disabled → typed denial, no release work |
| `tests/unit/cron-auth.test.ts` | Timing-safe cron auth | Keep green |
| `tests/unit/env.test.ts` | Env validation | Task 2 extends with `FINANCIAL_FEATURES_ENABLED` cases |
| `tests/unit/redirect.test.ts` | Open-redirect safety (uses `/orders` as sample path) | Non-finance; unchanged |
| `tests/unit/featured-speakers.test.ts` | Home merchandising (`BRAND_ORDER` fixture) | Non-finance; unchanged |
| `tests/unit/image-validate.test.ts`, `tests/unit/rate-limit.test.ts`, `tests/unit/secondhand-models.test.ts` | Upload/rate-limit/merchandising | Non-finance; unchanged |
| `tests/integration/escrow.test.ts` | Escrow idempotency/race/reconciliation invariants on scratch DB | Legacy algorithm tests — run with finance explicitly enabled in isolated test setup (plan Task 3/6), never weakening the boundary |
| `tests/docker/docker-compose.smoke.yml` | Smoke stack | Task 6 updates |
| `scripts/smoke.sh`, `scripts/docker-smoke.sh` | Smoke checks incl. cron 401 + IPN 400 | Task 6 updates disabled-mode expectations |
| `scripts/preflight.sh` | Release gates (incl. empty-MoMo compose config) | Task 6 runs safe gates only |
| *(new)* `tests/unit/financial-shutdown-actions.test.ts` | Every action-level denial in §1 | Task 3 |
| *(new)* `tests/unit/financial-shutdown-routes.test.ts` | Route/webhook/cron/return denials in §1.6–1.7 | Task 3 |
| *(new)* `tests/unit/finance-public-surface.test.ts` | Public navigation/copy/direct-route contract in §3 | Task 4 |
| *(new/modified)* focused admin finance tests | Read-only historical admin (§1.9) | Task 5 |

---

## 7. Search reconciliation

Command (exactly as prescribed by plan Task 1):

```bash
rg -n -i 'payment|momo|escrow|commission|wallet|withdraw|payout|order|checkout|cart|dispute|refund|settlement|ledger|cashTopup' app src scripts tests README.md
```

Result: **2440 matching lines across 100 files** (a line with multiple matches counts once, matching the command's line output). Every file is classified below either to an inventory row (§1–§6) or to a false-positive category.

False-positive categories (explicitly non-financial):

- **FP-1 `orderBy`/`sortOrder`** — Prisma query-builder tokens matching the `order` keyword (sorting, not the `Order` model).
- **FP-2 `border*` CSS** — Tailwind/`globals.css` class names containing the substring `order` in `border`.
- **FP-3 local `order` variable** — sort-priority map in `app/admin/withdraws/page.tsx:31`.
- **FP-4 `BRAND_ORDER`** — merchandising fixture constant in `tests/unit/featured-speakers.test.ts`.
- **FP-5 sample paths** — `safeNextPath("/orders")` examples in `tests/unit/redirect.test.ts` (path-safety tests).
- **FP-6 comments** — docstrings describing finance scopes (`src/lib/cron-auth.ts`, `src/lib/observability.ts`, cron test headers).
- **FP-7 generated artifacts** — `src/prisma/contract.d.ts`, `src/prisma/contract.json` mirror `contract.prisma`; preserved (§4), never hand-edited.

| File | Hits | Classification |
|---|---|---|
| `src/prisma/contract.d.ts` | 521 | FP-7 / preservation §4 |
| `src/prisma/contract.json` | 344 | FP-7 / preservation §4 |
| `src/lib/actions/orders.ts` | 151 | §1.2 (all seven actions) |
| `app/orders/[id]/page.tsx` | 98 | §1.2 order detail |
| `src/prisma/contract.prisma` | 91 | §4 preservation |
| `tests/integration/escrow.test.ts` | 68 | §6 tests |
| `tests/unit/momo.test.ts` | 51 | §6 tests |
| `src/lib/actions/admin.ts` | 48 | §1.9 admin actions |
| `src/lib/escrow.ts` | 43 | §1.5 escrow library |
| `src/lib/momo.ts` | 39 | §1.6 provider library |
| `src/lib/actions/offers.ts` | 39 | §1.3 offer actions |
| `src/prisma/seed.ts` | 37 | §5 dev seed |
| `app/admin/page.tsx` | 37 | §1.9 admin dashboard reads |
| `src/lib/ledger.ts` | 36 | §1.5 ledger library |
| `src/lib/actions/withdraw.ts` | 34 | §1.8 withdraw actions |
| `app/orders/sales/page.tsx` | 32 | §1.2 sales page |
| `src/lib/actions/exchange.ts` | 30 | §1.4 exchange actions |
| `src/components/escrow-pay-modal.tsx` | 29 | §1.2 escrow modal |
| `src/lib/actions/helpers.ts` | 28 | §1.5 helper library |
| `app/api/payments/momo/ipn/route.ts` | 28 | §1.6 IPN webhook |
| `tests/unit/ledger.test.ts` | 27 | §6 tests |
| `app/api/payments/momo/create/route.ts` | 27 | §1.6 create route |
| `app/admin/orders/page.tsx` | 26 | §1.9 admin orders |
| `app/admin/disputes/page.tsx` | 26 | §1.9 admin disputes |
| `app/payments/momo/return/page.tsx` | 23 | §1.6 return page |
| `src/lib/actions/cart.ts` | 22 | §1.1 cart actions |
| `app/orders/page.tsx` | 22 | §1.2 order list |
| `app/listings/[slug]/page.tsx` | 19 | §1.2/§3 listing CTAs + copy |
| `tests/unit/ipn-route.test.ts` | 18 | §6 tests |
| `app/checkout/page.tsx` | 18 | §1.2 checkout page |
| `src/lib/constants.ts` | 17 | §3 label constants (dormant) |
| `app/exchange/page.tsx` | 17 | §1.4 exchange page |
| `app/cart/page.tsx` | 17 | §1.1 cart page |
| `app/wallet/page.tsx` | 16 | §1.8 wallet page |
| `src/components/exchange-offer-form.tsx` | 15 | §1.4 form |
| `src/components/checkout-form.tsx` | 15 | §1.2 checkout form |
| `README.md` | 15 | §3 README claims |
| `tests/unit/env.test.ts` | 14 | §6 tests |
| `src/lib/wallet.ts` | 14 | §1.5 wallet library |
| `app/admin/settings/page.tsx` | 14 | §1.9 admin settings |
| `src/components/header.tsx` | 11 | §3 navigation |
| `app/globals.css` | 11 | FP-2 |
| `src/lib/env.ts` | 10 | §5 environment |
| `src/components/withdraw-form.tsx` | 10 | §1.8 withdraw form |
| `src/components/exchange-topup-button.tsx` | 10 | §1.4 top-up button |
| `app/admin/withdraws/page.tsx` | 10 | §1.9 admin withdraws (1 hit FP-3) |
| `tests/unit/mock-payment-guard.test.ts` | 9 | §6 tests |
| `src/components/listing-form.tsx` | 9 | §3 commission copy (§8 C-2) |
| `src/lib/actions/reviews.ts` | 8 | §1.2 review action (adjacent) |
| `src/components/offer-card.tsx` | 8 | §1.3 offer card |
| `app/page.tsx` | 8 | §3 home copy (§8 C-1) |
| `src/lib/actions/listings.ts` | 7 | §2 cart-row cleanup (adjacent, §8 A-1) |
| `src/components/header-user-menu.tsx` | 7 | §3 navigation |
| `app/seller/[id]/page.tsx` | 7 | §3 seller copy + read (§8 C-1) |
| `app/listings/page.tsx` | 7 | FP-1 |
| `tests/docker/docker-compose.smoke.yml` | 6 | §5/§6 smoke env |
| `src/components/offer-form.tsx` | 6 | §1.3 offer form |
| `src/components/listing-card.tsx` | 6 | FP-1/FP-2 |
| `app/sell/my/page.tsx` | 6 | §3 commission select + `/exchange` link (§8 C-1) |
| `app/notifications/page.tsx` | 6 | §3 notification icons (dormant) |
| `app/listings/[slug]/exchange/page.tsx` | 6 | §1.4 exchange offer page |
| `src/lib/utils.ts` | 5 | §1.5 commission math (pure) |
| `src/lib/mock-payment.ts` | 5 | §1.5 mock guard |
| `src/components/confirm-receipt-button.tsx` | 5 | §1.2 receipt button |
| `app/sell/[id]/edit/page.tsx` | 5 | §3 commission payload (§8 C-1) |
| `app/chat/page.tsx` | 5 | FP-1/FP-2 |
| `app/admin/layout.tsx` | 5 | §1.9/§3 admin navigation |
| `tests/unit/redirect.test.ts` | 4 | FP-5 |
| `src/components/footer.tsx` | 4 | §3 footer copy + links |
| `app/sell/new/page.tsx` | 4 | §3 commission payload (§8 C-1) |
| `app/offers/page.tsx` | 4 | §1.3 offers page |
| `app/models/[slug]/page.tsx` | 4 | FP-1/FP-2 |
| `app/chat/[id]/page.tsx` | 4 | FP-1/FP-2 |
| `app/admin/users/page.tsx` | 4 | §1.9 admin users (read + Batch 2 toggle) |
| `app/admin/catalog/page.tsx` | 4 | FP-1 |
| `src/lib/actions/auth.ts` | 3 | §2 cart bootstrap (adjacent, §8 A-2) |
| `src/components/listing-gallery.tsx` | 3 | FP-2 |
| `src/components/featured-speakers.tsx` | 3 | FP-2 |
| `src/components/auth-form.tsx` | 3 | FP-2 |
| `scripts/docker-smoke.sh` | 3 | §6 smoke checks |
| `app/admin/listings/page.tsx` | 3 | FP-1/FP-2 |
| `tests/unit/featured-speakers.test.ts` | 2 | FP-4 |
| `src/components/secondhand-models.tsx` | 2 | FP-2 |
| `src/components/profile-form.tsx` | 2 | FP-2 |
| `src/components/image-picker.tsx` | 2 | FP-2 |
| `scripts/smoke.sh` | 2 | §6 smoke checks |
| `app/wishlist/page.tsx` | 2 | FP-1 |
| `app/profile/page.tsx` | 2 | §3 historical order-count read (dormant) |
| `tests/unit/cron-auto-release-route.test.ts` | 1 | §6 tests |
| `tests/unit/cron-auth.test.ts` | 1 | FP-6/§6 |
| `src/lib/observability.ts` | 1 | FP-6 |
| `src/lib/cron-auth.ts` | 1 | FP-6/§1.7 |
| `src/components/chat-window.tsx` | 1 | FP-2 |
| `scripts/preflight.sh` | 1 | §5/§6 env gate |
| `app/sitemap.ts` | 1 | FP-1 (§3 exchange entry noted) |
| `app/robots.ts` | 1 | §3 robots disallow list |
| `app/manifest.ts` | 1 | §3 manifest description |
| `app/compare/page.tsx` | 1 | FP-2 |
| `app/api/cron/auto-release/route.ts` | 1 | §1.7 cron route |
| `app/api/chat/[id]/route.ts` | 1 | FP-1 |

**Total: 100 files / 2440 lines — fully reconciled.** Files with zero hits (e.g. `src/lib/actions/catalog.ts`, `chat.ts`, `notifications.ts`, `profile.ts`, `wishlist.ts`, `src/lib/rate-limit.ts`, `src/lib/redirect.ts`, `app/api/upload|health|auth routes`, `src/components/sw-register.tsx`, `src/prisma/db.client.ts`, `scripts/make-icons.ts`) were also inspected and contain no finance surfaces.

---

## 8. Unknown / Ambiguous

**No mutation path was found that cannot be classified.** All money-path mutations in §1 have a planned guard and a focused verification test (§9). The following are classified judgment calls and plan-coverage observations, listed for reviewer confirmation before/during Batch 1 — none of them blocks Task 2 (the shared capability), and none is an unclassifiable mutation surface:

- **A-1 (adjacent)** `deleteListingAction` deletes `CartItem` rows (`src/lib/actions/listings.ts:224`). Classified non-money-path cleanup, no guard. If the review owner prefers a strict “no cart-row mutation while disabled” rule, add an assert here and amend plan Task 3's file list.
- **A-2 (adjacent)** `registerAction`/`loginAction` create a `Cart` row per user (`src/lib/actions/auth.ts:73,108-109`). Classified non-money-path; no guard. Same option as A-1.
- **A-3 (adjacent)** `toggleSellerVerificationAction` mutates `User.isVerifiedSeller` — a trust/eligibility flag not enforced by payout/withdraw code (display only). Classified non-money-path; Batch 2 seller-verification domain; no finance guard this batch.
- **A-4 (adjacent)** `submitReviewAction` reads `Order` and mutates `Review` only. Classified non-money-path; historical reviews preserved; review system is a Batch 2 decision.
- **L-1 (library coverage)** `src/lib/ledger.ts` is a reusable finance mutation library but is **not** in plan Task 3's modify/commit file list. All of its current callers are guarded entry points (§1.2–1.4, §1.8, `processAutoReleases` via the guarded cron route, `escrow.ts` via guarded IPN/return). Recommendation: add a defense-in-depth `assertFinancialFeaturesEnabled()` in `recordLedgerTx` and amend the Task 3 commit file list, or explicitly accept caller-only guarding.
- **L-2 (library coverage)** `processAutoReleases` lives in `src/lib/actions/helpers.ts`, also outside Task 3's file list; its only caller is the guarded cron route (the dashboard no longer calls it). Same recommendation shape as L-1.
- **C-1 (copy coverage)** Public escrow/commission copy exists in `app/page.tsx`, `app/seller/[id]/page.tsx`, `app/sell/my|new|edit` — files not named in plan Task 4's explicit list but inside its `git add app` scope and its public-copy scan. Task 4 must sweep them via the scan; the inventory rows in §3 already cover them.
- **C-2 (copy coverage gap)** `src/components/listing-form.tsx` carries seller-facing commission copy (“Hoa hồng X% chỉ thu khi giao dịch hoàn tất”, payout example). It is under `src/`, so **neither Task 4's file list nor its `git add` command covers it.** Removing/rewriting this copy requires amending plan Task 4's file list and commit command (or a follow-up commit). Flagged to the review owner.
- **C-3 (copy, dormant)** `src/lib/constants.ts` finance labels and `app/notifications/page.tsx` finance-kind icons only render on retired pages or historical read-only views; classified dormant, kept unchanged.
- **E-1 (environment)** `ESCROW_AUTO_RELEASE_DAYS`, `MOMO_*`, `CRON_SECRET` remain in env/config after shutdown; all are dormant once entry points deny. Task 6 sets `FINANCIAL_FEATURES_ENABLED=false` explicitly in smoke/beta config where enumerated.
- **S-1 (seed)** `src/prisma/seed.ts` destructively wipes finance tables **by design on dev/test databases only** (refuses `NODE_ENV=production`, requires `SEED_PASSWORD`). It has no HTTP/admin/cron surface, satisfying spec §5.1.1's offline-only rule. Beta operations must never run it against the beta database.

---

## 9. Coverage confirmation — every financial mutation has a guard + focused test

| Mutation (grouped) | Guard (Task 2 capability) | Focused verification test |
|---|---|---|
| `addToCartAction`, `updateCartItemAction`, `removeFromCartAction` | Top of each action (`cart.ts`) | `tests/unit/financial-shutdown-actions.test.ts` |
| `createOrderAction` (cart-to-order + direct buy) | Top of action (`orders.ts`) | same — spies on `Order`/`Payment`/`Listing`/`CartItem` |
| `payEscrowAction` (mock escrow) | Top of action, before mock guard | same — spy on ledger + `Order.updateAll` |
| `sellerConfirmPaymentAction`, `shipOrderAction`, `confirmReceiptAction`, `cancelOrderAction`, `openDisputeAction` | Top of each action | same — spies per §1.2 |
| `createOfferAction`, `respondOfferAction`, `acceptCounterAction`, `cancelOfferAction` | Top of each action (`offers.ts`) | same — spy: no `Order.create` on accept/counter |
| `createExchangeOfferAction`, `respondExchangeOfferAction`, `payExchangeTopupAction`, `completeExchangeAction`, `cancelExchangeOfferAction` | Top of each action (`exchange.ts`) | same — spies on `Payment`/`Payout`/ledger |
| `createWithdrawRequestAction`, `processWithdrawAction` | Top of each action (`withdraw.ts`); wallet read denied in `wallet.ts` | same — no `WithdrawRequest` mutation, no ledger `withdrawPaid` |
| `resolveDisputeAction`, `updateCommissionAction`, `updateSettingAction` | Top of each action (`admin.ts`) | same — no refund/release/payout/commission/settings mutation |
| `POST /api/payments/momo/create` | Top of route handler | `tests/unit/financial-shutdown-routes.test.ts` — no provider request creation |
| `POST /api/payments/momo/ipn` | Top of route handler before successful-payload processing | same — valid signed payload mutates nothing |
| `GET /payments/momo/return` | Top of page | same — no escrow mutation, no live-finance redirect |
| `POST /api/cron/auto-release` | Top of route handler (with fail-closed cron auth) | same + updated `tests/unit/cron-auto-release-route.test.ts` |
| `markEscrowPaid`, `markExchangeTopupPaid` (`escrow.ts`) | Defense-in-depth assert in library + guarded callers | route tests (no escrow claim while disabled) |
| `createMomoPayment` (`momo.ts`) | Defense-in-depth assert in library + guarded route | route tests + existing `tests/unit/momo.test.ts` |
| `getWalletSummary` (`wallet.ts`) | Assert in library (operational read denial) | action tests (withdraw actions) |
| Public pages/CTAs/copy (§3) | Page retirement (Task 4 consistent direct-route behavior) | `tests/unit/finance-public-surface.test.ts` |
| Historical admin views (§1.9) | Controls removed (Task 5) + action guards retained | Task 5 focused admin finance tests |

**Gate check:** no unresolved mutation surface. Batch 1 may proceed to Task 2 after review of the §8 notes (in particular L-1/L-2 and C-2, which ask for small plan amendments rather than blocking ambiguity).
