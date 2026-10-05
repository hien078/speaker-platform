# Private-Beta Marketplace Reset Design

**Status:** Proposed for implementation review  
**Date:** 2026-10-06  
**Product:** Speaker Platform / LoaViet  
**Decision owner:** Founder

## 1. Intent

Reset the current product from an escrow-and-commission marketplace into a
private-beta classifieds marketplace that proves liquidity before operating
payments. The first successful loop is:

```text
Discover → Search → Listing → Seller profile → Chat → Meet/Deal → Mark outcome
```

The beta remains open to listings from every Vietnamese province. Hà Nội,
TP.HCM, and Hải Phòng are **priority beta communities**, not exclusive markets
and not locations guaranteed to be safer. The product and operations focus on
used portable Bluetooth speakers plus new/open-box inventory from small
sellers, especially common JBL, Marshall, Sony, Bose, and Soundcore models.

## 2. Confirmed Product Decisions

1. The platform does not hold money during the first phase.
2. No wallet, escrow, payout, commission, payment gateway, or refund UI is
   publicly reachable while payment features are disabled.
3. Buyer and seller find one another, chat, agree independently, and optionally
   record the outcome on the platform.
4. Sellers may post from any province. Hà Nội, TP.HCM, and Hải Phòng receive
   concierge onboarding, operations attention, community campaigns, and
   location-segmented telemetry.
5. Private beta targets 20–50 invited founding sellers, 100–200 buyers, and
   100–300 high-quality real listings.
6. Trust and security gates precede convenience features.
7. Instrumentation ships before the beta cohort is invited.
8. Saved search, review, events, price intelligence, donation, and AI pricing
   are excluded from P0.

## 3. Scope Boundaries

### In scope

- A safe feature boundary that disables all financial and custodial behavior.
- A lightweight deal/outcome record independent of payment/order records.
- Verified email and phone states; seller verification workflow.
- Admin MFA, scoped RBAC, session revocation, recovery controls, and audit.
- Report, block, moderation queue, reason codes, and action history.
- Portable-speaker-first listing fields and a stronger listing workflow.
- Canonical model aliases and useful search empty states.
- Privacy-minimized first-party product telemetry.
- Nationwide locations with priority beta-community presentation and metrics.
- Private-beta policy, operations gates, seeded model catalog, and release
  verification.

### Explicitly out of scope

- Processing or custodying user money.
- Commission calculation or collection.
- Wallet balances, withdrawal, payout, reconciliation, refund, or chargeback.
- Shipping/logistics guarantees.
- A claim that the platform guarantees transaction or product safety.
- Public reviews before sufficient verified deal outcomes exist.
- Events, saved-search notifications, price estimation, AI price prediction,
  community forums, referral rewards, and public growth campaigns.
- Deleting historical finance code or tables during the beta reset.

## 4. System Invariants

These are release-blocking requirements.

1. **No money path:** with `FINANCIAL_FEATURES_ENABLED=false`, every payment,
   checkout, cart-to-order, wallet, withdrawal, payout, escrow, commission, and
   financial dispute mutation is denied server-side, not merely hidden.
2. **No misleading promise:** public copy cannot claim that LoaViet holds money,
   protects payment, guarantees a seller, guarantees a product, or guarantees a
   city/community.
3. **Historical preservation:** existing finance tables and records remain
   readable for administrators during the reset; no destructive migration is
   performed.
4. **Verified seller gate:** publishing a listing requires the policy-defined
   minimum seller verification. Drafting may occur before verification.
5. **Backend authorization:** every privileged action checks permissions on the
   server. Hidden buttons are not an authorization control.
6. **Auditability:** privileged access and moderation/security actions record
   actor, action, resource, reason, timestamp, and request/security context.
7. **Location neutrality:** any supported Vietnamese province may publish.
   Priority-city labels cannot imply safety certification or suppress other
   provinces from ordinary search ranking.
8. **Privacy:** analytics events contain stable internal IDs and coarse location
   codes, never raw email, phone, message bodies, full addresses, or uploaded
   identity evidence.

## 5. Target Architecture

The application remains a Next.js/Prisma modular monolith. The reset introduces
clear domain boundaries without splitting services.

```text
Public Web
  ├── Discovery/Search
  ├── Listing/Seller Profile
  ├── Chat
  └── Deal Outcome

Trust Boundary
  ├── Identity & Verification
  ├── Report & Block
  ├── Moderation
  ├── Admin RBAC/MFA
  └── Audit

Measurement Boundary
  ├── Product Events
  ├── Funnel Aggregates
  └── Location Segments

Dormant Finance Boundary
  ├── Existing payment/escrow code and data
  └── Denied unless an explicit future launch process enables it
```

### 5.1 Financial feature boundary

Add a single server-owned capability, defaulting to `false` in all environments:

```ts
financialFeaturesEnabled(): boolean
assertFinancialFeaturesEnabled(): void
```

The value is controlled only by validated server configuration. It is not a
client-provided flag and not an admin toggle in P0. Public navigation and CTAs
omit finance routes. Direct page requests redirect to
`/listings?notice=financial_features_unavailable`; payment API, webhook, and
cron requests return `404` without reading or mutating financial state; server
actions fail with the typed code `FINANCIAL_FEATURES_DISABLED`. All related
server actions and API handlers call the assertion before any database access.

Legacy finance code stays compiled and tested so it does not silently rot, but
its tests must distinguish dormant-code correctness from public availability.
Cron jobs that release escrow and payment webhooks must also refuse work while
disabled, except a deliberately named administrative compatibility mode used
only for historical cleanup.

### 5.2 Lightweight deal outcome

Do not overload `Order`; its statuses and fields encode payment assumptions.
Introduce an independent `Deal` domain:

```text
Deal
  id
  listingId
  buyerId
  sellerId
  status: proposed | agreed | meeting_or_delivery | completed | cancelled | no_deal
  agreedPrice?          # optional user-entered record; never collected by platform
  fulfillmentMethod?   # meetup | seller_delivery | carrier | other
  buyerOutcomeAt?
  sellerOutcomeAt?
  completedAt?
  cancellationReason?
  createdAt / updatedAt

DealStatusHistory
  dealId / status / actorId / note / createdAt
```

Creating a deal requires a live listing and a conversation participant pair.
Only the buyer or seller may update it. A single side may mark its outcome, but
the analytics event `successful_match` requires both parties to confirm or an
operations-approved reconciliation rule. The UI always says that payment and
fulfillment happen outside the platform.

### 5.3 Identity and seller verification

Authentication may retain password login during migration, but accounts acquire
explicit `emailVerifiedAt` and `phoneVerifiedAt` states. OTPs are hashed,
single-use, short-lived, attempt-limited, resend-limited, and protected against
account enumeration.

Provider integrations sit behind email and SMS OTP adapters. Development uses a
non-production test adapter; production refuses to start verification delivery
unless real provider configuration passes environment validation. Admin MFA is
TOTP with one-time recovery codes; SMS is not an admin MFA factor.

Seller verification is a workflow, not one mutable boolean:

```text
SellerVerification
  userId
  status: not_started | pending | verified | rejected | needs_review | revoked
  method
  submittedAt / reviewedAt / reviewerId
  reasonCode / note
  policyVersion
```

The final evidence requirements require legal/operations sign-off before beta.
P0 must not collect identity documents “just in case.” If evidence is required,
it is private, encrypted or placed in private object storage, access-audited,
and governed by an explicit retention schedule.

The initial publication gate is exact: verified email, verified phone, declared
seller type (`individual` or `business`), accepted current seller-policy
version, and an operations review recorded as `verified`. Identity-document
collection is not included unless legal review adds it through a separately
approved specification.

### 5.4 Admin MFA and RBAC

Replace the effective all-powerful `admin` behavior with scoped permissions.
Initial roles are:

- `super_admin`: emergency configuration and role administration;
- `operations_admin`: listings, users, and beta operations;
- `moderator`: reports, blocks, moderation cases, and listing action;
- `support`: limited user assistance without broad PII or security access;
- `analyst`: aggregate read-only telemetry.

Admin sessions require MFA enrollment, shorter TTL, revocation, and step-up for
role changes, seller-verification decisions, exports, and destructive account
actions. Bootstrap/recovery procedures must avoid a permanent lockout and must
be documented in the runbook.

### 5.5 Report, block, and moderation

Reports target a listing, user, or message using a typed reason code. Submission
is rate-limited and snapshots relevant mutable content. A moderation case may
group reports and records assignment, priority, state, actions, and appeal.

Blocking a user prevents new conversations and messages in either direction;
it does not delete evidence or silently erase historical conversations. Admin
actions use explicit reason codes and append audit history.

### 5.6 Listing domain

All existing categories may continue to exist, but beta merchandising,
onboarding, seeded catalog depth, and quality metrics focus on portable
Bluetooth speakers. Listing creation adds or strengthens:

- canonical brand and product model;
- condition with user-facing definitions;
- used/new/open-box seller type context;
- included accessories;
- known defects;
- repair history;
- asking price and negotiability;
- province/city code, optional district, and fulfillment methods;
- photo checklist and upload quality constraints.

Exact addresses are not stored as listing fields. A listing may be drafted
without completed verification but cannot transition to review/publication
until the seller gate passes. Existing non-portable listings remain accessible
and are not automatically demoted or deleted.

### 5.7 Search and aliases

PostgreSQL remains the source and initial search engine. Add normalized search
terms and aliases for common brand/model spellings (for example `sound link`,
`soundlink`, `charge4`, `charge 4`) and Vietnamese diacritic-insensitive input.

An empty result offers actionable recovery: remove restrictive filters, browse
the selected brand/category, or record interest. Recording interest is telemetry
in P0, not a saved-search notification feature.

Ranking considers textual relevance, listing validity/quality, freshness, and
the buyer's explicit location preference. It does not globally boost priority
cities when the buyer has not chosen a location.

### 5.8 Telemetry

Define a server-owned event taxonomy before private beta:

- `search_submitted`;
- `search_zero_result`;
- `search_result_clicked`;
- `listing_viewed`;
- `conversation_started`;
- `message_first_response`;
- `deal_created`;
- `deal_outcome_marked`;
- `successful_match`;
- `listing_marked_sold`;
- `report_submitted`;
- `user_returned`.

Every event has a version, timestamp, internal actor/session ID when available,
coarse location code, listing/model IDs when applicable, and an allowlisted
metadata schema. Product events and security/audit logs are separate stores or
logical domains with different access and retention.

Funnel definitions are versioned. At minimum, dashboards expose search query
volume, zero-result rate, result CTR, listing→chat, search→chat, seller response
rate, median first response time, listing age, marked sold, successful match,
report rate, and repeat users, segmented by beta community and category.

### 5.9 Nationwide location and priority communities

Use canonical Vietnamese administrative codes and display names rather than
free-text city strings for new records. Migration preserves legacy text and maps
known values without fabricating uncertain matches.

Hà Nội, TP.HCM, and Hải Phòng are configured as priority communities for:

- founding-seller cohort management;
- concierge onboarding;
- curated landing/filter shortcuts;
- operations and moderation reporting;
- location-segmented analytics;
- later meetup safety guidance.

The label is `Khu vực beta trọng điểm` or equivalent. It must not say `được bảo
đảm`, `an toàn hơn`, or imply verified transactions merely because of location.

## 6. User Experience Changes

### Navigation and public surfaces

- Remove cart, checkout, wallet, orders/sales, withdrawals, commission settings,
  and financial dispute links while finance is disabled.
- Replace purchase CTAs with `Nhắn người bán` and an optional `Tạo thỏa thuận`.
- Seller pages show verification state using carefully scoped copy; verification
  is not a product-quality guarantee.
- Remove commission math and escrow promises from listing forms, listing detail,
  home, footer, onboarding, metadata, and documentation.
- Retain explicit safety guidance for independent payment and in-person meetup.

### Portable-speaker listing flow

Use progressive disclosure:

1. Brand and canonical model.
2. Condition and new/open-box/used context.
3. Asking price and negotiability.
4. Province/city and fulfillment methods.
5. Photos using a checklist.
6. Accessories, known defects, and repair history.
7. Preview, verification gate, and submit for moderation.

Draft autosave is desirable but not a prerequisite for the first reset batch.

## 7. Security and Abuse Controls

- Verification, login, report, chat, upload, search, and deal mutations receive
  endpoint-specific rate limits.
- Upload validation retains type/size checks and strips unnecessary metadata.
- Message/report content is treated as untrusted input at every render surface.
- Admin search and exports minimize PII; PII access is separately audited.
- Account recovery invalidates applicable sessions and notifies old channels
  when feasible.
- Blocking, suspension, and verification revocation are evaluated server-side
  before listing publication, new chat, and deal mutation.
- Policy/version acceptance is recorded where legal review determines it is
  required.

## 8. Migration and Compatibility Strategy

1. Add the financial feature boundary before any public UI removal.
2. Make database changes additive first; emit and review Prisma migration plans.
3. Preserve Order/Payment/Payout/Wallet/Ledger/Withdrawal data and admin-only
   inspection during private beta.
4. Do not repurpose finance statuses for `Deal`; create separate tables/types.
5. Map legacy `User.isVerifiedSeller` into the new verification workflow, then
   treat the workflow as canonical. Remove the boolean only in a later migration.
6. Map legacy `Listing.city` to administrative codes where confidently possible;
   retain the original string during migration.
7. Update seeds, tests, documentation, smoke tests, and route maps with each
   batch. A route hidden from navigation still requires direct-request tests.

## 9. Delivery Batches and Gates

### Batch 1 — Financial shutdown boundary

Deliver the server feature boundary, deny mutations/routes, remove public
navigation and copy, set all beta-facing fees to zero, and preserve historical
admin visibility.

**Gate:** automated route/action tests prove no money mutation can occur while
disabled; source/copy scan finds no public escrow or commission promise; full
preflight, integration, build, and smoke pass.

### Batch 2 — Lightweight deal outcome

Add `Deal` and history, participant authorization, outcome UI, notifications,
and safety disclaimer.

**Gate:** buyer/seller ownership, transition, concurrency/idempotency, and
successful-match analytics tests pass without creating Payment/Payout/Ledger
records.

### Batch 3 — Identity, admin MFA, RBAC, sessions, recovery

Add verification states, OTP controls, seller publication gate, admin roles,
MFA, step-up, session list/revocation, and recovery safeguards.

**Gate:** authorization matrix and recovery abuse tests pass; no admin page or
action is protected only by UI; bootstrap/recovery runbook is exercised.

### Batch 4 — Report, block, moderation, and audit

Add reports, user blocking, moderation cases, snapshots, reason codes, queues,
appeals foundation, and expanded audit context.

**Gate:** block enforcement works for new chats/messages; moderation transitions
and audit append behavior have integration tests; report abuse is rate-limited.

### Batch 5 — Portable-speaker listing quality

Implement canonical fields, validation, progressive listing UI, verification
gate, photo checklist, model seed depth, and legacy compatibility.

**Gate:** draft/publish behavior, conditional fields, upload validation, model
selection, and non-portable legacy listings pass end-to-end tests.

### Batch 6 — Search and funnel telemetry

Add aliases, normalization, empty-state recovery, event contracts, funnel
events, aggregates, and privacy checks.

**Gate:** alias/diacritic/filter tests pass; event schemas reject raw PII;
zero-result, CTR, chat conversion, response, and match metrics reconcile against
fixture data.

### Batch 7 — Nationwide location and beta communities

Add canonical location data, migration, filters, priority-community surfaces,
and segmentation without location-based safety claims.

**Gate:** every supported province can draft/publish; legacy locations survive;
ranking is neutral absent an explicit buyer location; copy scan rejects guarantee
phrases.

### Batch 8 — Private-beta launch gate

Finalize Terms/Privacy/Marketplace/Seller/Community rules, operations playbooks,
founding-seller cohort tools, seed catalog, observability alerts, backup restore,
access review, security review, and beta release checklist.

**Gate:** no known critical security issue; restore drill succeeds; admin MFA and
moderation are operational; legal/operations sign-offs are recorded; 20–50
invited seller slots and the 100–300-listing quality process are ready.

## 10. Verification Strategy

Each batch is test-first and independently committable. Required verification
is proportional to the touched risk surface and includes:

- unit tests for validators, permissions, transitions, search normalization, and
  event schemas;
- database integration tests for finance denial, deals, RBAC, moderation, audit,
  and migrations;
- route/action contract tests for direct unauthorized requests;
- critical browser flows for listing, chat, deal outcome, report/block, and
  admin MFA;
- accessibility checks on new forms and moderation UI;
- `npm run lint`, `npx tsc --noEmit`, `npm test`, production build, safe smoke,
  and the repository preflight gates;
- an explicit diff/status audit that excludes runtime uploads, local settings,
  secrets, generated scratch data, and unrelated user work.

## 11. OpenCode-on-Mac Execution Protocol

Implementation is performed batch-by-batch by OpenCode on the Mac using GLM 5.3.

For every batch:

1. Synchronize to the reviewed base commit and confirm the Mac worktree is clean
   except known local-only files.
2. Give OpenCode only the approved spec, the batch plan, relevant repository
   instructions, and exact verification commands.
3. Require one focused commit per reviewable task and a clean batch checkpoint;
   no push, merge, deploy, destructive cleanup, or staging of unrelated files.
4. Export the OpenCode session metadata to prove the selected GLM 5.3 model and
   outcome.
5. Review the diff locally against this spec, inspect migrations and direct-route
   defenses, and rerun risk-proportional checks independently.
6. If review fails, continue the same OpenCode session with concrete findings;
   do not advance to the next batch until the gate passes.
7. Record commits, checks, residual risks, and any deferred requirement.

## 12. Success Criteria for Private-Beta Readiness

The beta is ready to invite users only when:

- financial behavior is unavailable and public copy is non-custodial;
- verified sellers can publish nationwide;
- admin MFA/RBAC, moderation, report/block, recovery, and audit gates pass;
- the portable-speaker listing and search-to-chat loop passes critical E2E;
- telemetry can calculate the agreed funnel without raw PII;
- Terms, Privacy, marketplace rules, seller rules, and safety guidance have
  recorded reviews;
- backup restore, monitoring, incident escalation, and support paths are tested;
- the founding-seller onboarding process can sustain 100–300 quality listings;
- no known critical security finding remains open.

Post-launch success is evaluated using liquidity and trust rather than raw
signup counts: zero-result rate, search/result CTR, listing→chat, search→chat,
seller response, first-response latency, listing age, marked sold, successful
match, report rate, and repeat use.
