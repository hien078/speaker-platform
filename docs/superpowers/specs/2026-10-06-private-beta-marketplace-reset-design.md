# Private-Beta Marketplace Reset Design

**Status:** Proposed for implementation review  
**Date:** 2026-10-06  
**Product:** Speaker Platform / LoaViet  
**Decision owner:** Founder

---

# 1. Intent

Reset the current product from an escrow-and-commission marketplace into a controlled private-beta classifieds marketplace whose first job is to prove marketplace liquidity, trust, and repeat usage before LoaViet operates payment infrastructure.

The first successful marketplace loop is:

```text
Discover
→ Search
→ Listing
→ Seller Profile
→ Chat
→ Meet / Deal
→ Mark Outcome
```

The platform does not hold user funds during the first phase.

The private beta focuses operationally on:

- used portable Bluetooth speakers;
- new/open-box portable Bluetooth speakers from small sellers;
- common, recognizable models;
- especially JBL, Marshall, Sony, Bose, Soundcore, and other brands added through the canonical catalog.

The platform architecture continues to support nationwide participation, but cold-start acquisition is intentionally concentrated so early marketplace liquidity is not fragmented across too many cities and categories.

The beta exists to answer:

1. Can LoaViet attract reliable supply?
2. Can buyers find relevant inventory?
3. Do listings generate real conversations?
4. Do seller conversations produce real deals?
5. Do sellers respond reliably?
6. Can the platform maintain trust and moderation quality?
7. Do users return?
8. Can marketplace liquidity improve without relying on subsidies or payment custody?

The beta is **not** intended to prove:

- escrow;
- payments;
- commission monetization;
- wallet infrastructure;
- complex logistics;
- AI pricing;
- recommendation AI;
- community forums;
- public events;
- nationwide scale.

---

# 2. Confirmed Product Decisions

1. The platform does not hold money during the private-beta phase.

2. No wallet, escrow, payout, commission, payment gateway, refund, withdrawal, settlement, or financial-dispute UI is publicly reachable while financial features are disabled.

3. Buyer and seller discover one another, chat, agree independently, perform payment and fulfillment outside LoaViet, and may optionally record the outcome on the platform.

4. LoaViet does not guarantee:
   - payment;
   - delivery;
   - seller trustworthiness;
   - product authenticity;
   - product condition;
   - meetup safety;
   - transaction success.

5. Nationwide listing architecture remains supported.

6. Cold-start operations are intentionally concentrated:
   - **Primary beta market:** Hà Nội.
   - **Secondary observation / limited recruitment:** TP.HCM.
   - **Organic participation:** other supported provinces/cities.
   - Hải Phòng and additional markets may be promoted later based on evidence.

7. Private beta targets approximately:
   - 20–50 invited founding sellers;
   - 100–200 initial buyers/beta participants;
   - 100–300 high-quality real listings.

8. The initial new-listing focus is portable Bluetooth speakers.

9. Trust and security gates precede convenience features.

10. Product instrumentation ships before the beta cohort is invited.

11. P0 excludes:
    - saved-search notifications;
    - public review system;
    - events;
    - price intelligence;
    - AI pricing;
    - community forum;
    - referral rewards;
    - donation;
    - wallet;
    - escrow;
    - platform commission;
    - public paid promotion.

12. Existing finance implementation and historical records are preserved but dormant.

13. Seller verification is a platform-access control and trust signal, not a guarantee of the seller, product, or transaction.

14. Private-beta access restrictions are enforced server-side rather than only through UI visibility.

15. Product expansion after beta must be evidence-driven rather than calendar-driven.

---

## 2.1 Private Beta Access Model

Private beta is enforced through explicit cohort membership.

Hiding UI is not considered access control.

Introduce:

```text
BetaCohortMembership
  id
  userId
  cohort
  status
  invitedBy?
  invitedAt?
  acceptedAt?
  expiresAt?
  notes?
  createdAt
  updatedAt
```

Initial cohort values:

```text
internal
founding_seller
private_beta_buyer
```

Initial membership states:

```text
invited
active
suspended
exited
```

### Public visitor

May:

- open the public site;
- search public listings;
- browse public seller profiles;
- open listing detail pages;
- read public safety guidance.

May not:

- publish listings;
- access privileged seller functionality;
- bypass beta restrictions through direct routes.

### Registered user without active beta membership

May:

- create/manage a basic account;
- complete email/phone verification;
- browse public inventory.

Chat access during the controlled beta is governed by the current beta-access policy.

P0 should support restricting new buyer-to-seller conversation creation to active beta participants if operations requires a tightly controlled test cohort.

### Founding seller

Must have:

```text
active founding_seller cohort membership
+
required authentication state
+
Seller Verification status = verified
+
current seller-policy acceptance
```

before submitting a listing for publication.

### Internal users

Internal testing users must be explicitly identifiable and excluded from product metrics where appropriate.

### Authorization invariant

All private-beta permissions are checked server-side.

The following are not acceptable access controls:

- hidden navigation;
- hidden buttons;
- disabled client components;
- URL obscurity;
- client-owned feature flags.

---

# 3. Scope Boundaries

## 3.1 In Scope

### Marketplace reset

- safe financial shutdown boundary;
- removal of public financial flows;
- preservation of historical financial data;
- lightweight non-financial Deal domain.

### Identity

- email verification;
- phone verification;
- OTP abuse protection;
- session management;
- account recovery;
- identity-linking rules.

### Seller trust

- seller verification workflow;
- seller verification policy;
- seller publication gate;
- founding seller cohort membership;
- verification revocation.

### Admin

- mandatory MFA;
- scoped RBAC;
- privileged-action step-up;
- admin session revocation;
- admin audit;
- PII-access audit.

### Trust and safety

- report;
- block;
- moderation queue;
- moderation cases;
- reason codes;
- action history;
- evidence snapshotting;
- appeal foundation.

### Listing

- portable-speaker-first listing structure;
- canonical brand/model;
- condition;
- accessories;
- defects;
- repair history;
- asking price;
- negotiability;
- location;
- fulfillment methods;
- photo checklist;
- upload validation;
- listing-quality requirements.

### Search

- canonical aliases;
- normalized model search;
- Vietnamese diacritic-insensitive matching;
- empty-result recovery;
- search telemetry.

### Analytics

- first-party product telemetry;
- metric contracts;
- funnel metrics;
- cohort/location/category segmentation;
- privacy-safe analytics.

### Operations

- founding seller invitation flow;
- concierge onboarding;
- founding seller console;
- beta operations gates;
- support and incident runbooks.

### Legal/policy readiness

- Terms;
- Privacy;
- Marketplace Rules;
- Seller Rules;
- Community Rules;
- Safety Guidance;
- policy version acceptance.

---

## 3.2 Explicitly Out of Scope

P0 does not include:

- processing user payments;
- custodying money;
- wallet balances;
- escrow;
- commission calculation;
- commission collection;
- payout;
- withdrawal;
- settlement;
- reconciliation;
- refund;
- chargeback;
- payment guarantees;
- shipping guarantees;
- logistics guarantees;
- authenticity guarantees;
- product-condition guarantees;
- public reviews before sufficient verified outcomes exist;
- public seller advertising products;
- events;
- saved-search notifications;
- AI recommendations;
- price estimation;
- AI price prediction;
- community forums;
- referral rewards;
- public growth campaigns;
- donation;
- destructive removal of historical finance tables;
- broad marketplace category expansion.

---

# 4. System Invariants

The following are release-blocking requirements.

## 4.1 No Money Path

With:

```text
FINANCIAL_FEATURES_ENABLED=false
```

all of the following are denied server-side:

- checkout;
- payment creation;
- cart-to-order conversion;
- wallet mutation;
- withdrawal;
- payout;
- escrow mutation;
- commission mutation;
- settlement;
- refund;
- financial dispute mutation;
- payment provider callback processing;
- escrow cron processing.

UI hiding is insufficient.

---

## 4.2 No Misleading Promise

Public copy must not claim that LoaViet:

- holds money;
- protects payment;
- guarantees payment;
- guarantees a seller;
- guarantees product authenticity;
- guarantees product quality;
- guarantees product condition;
- guarantees meetup safety;
- guarantees any city/community.

---

## 4.3 Historical Preservation

Existing finance tables and historical records remain preserved.

The beta reset must not perform destructive migration of historical financial data.

---

## 4.4 Verified Seller Publication Gate

A listing cannot transition into review/public status unless the seller satisfies the current Seller Verification Policy.

Draft creation may be allowed before verification.

---

## 4.5 Backend Authorization

Every privileged action checks permissions server-side.

Hidden controls are not authorization.

---

## 4.6 Auditability

Privileged and security-sensitive actions record:

- actor;
- action;
- resource;
- reason;
- timestamp;
- request/security context;
- relevant policy version where appropriate.

---

## 4.7 Location Neutrality

Supported users outside the primary beta market must not be falsely described as unsafe or second-class.

Priority-community labels are operational/acquisition labels only.

Location alone is not a trust signal.

---

## 4.8 Analytics Privacy

Analytics events must not contain:

- raw email;
- raw phone;
- message body;
- full address;
- OTP;
- password;
- authentication secret;
- uploaded identity evidence;
- unrestricted PII.

Use internal identifiers and coarse canonical location identifiers.

---

## 4.9 Private-Beta Authorization

Private-beta seller/publication privileges require active server-side cohort membership.

---

## 4.10 No Finance Escape Hatch

No normal application surface may enable financial functionality through:

- query parameter;
- cookie;
- client feature flag;
- browser request;
- admin UI toggle;
- arbitrary request body;
- user-controlled environment value;
- hidden route.

---

## 4.11 Policy Non-Invention

Implementation agents must not invent semantics for:

- seller verification;
- finance;
- custody;
- identity merging;
- PII access;
- administrator permissions;
- legal acceptance;
- retention;
- moderation sanctions.

Material ambiguity blocks the affected implementation task until reviewed.

---

# 5. Target Architecture

The application remains a Next.js/Prisma modular monolith.

Do not split into microservices for the private beta.

```text
PUBLIC WEB
│
├── Discovery
├── Search
├── Listing
├── Seller Profile
├── Chat
└── Deal Outcome
│
├─────────────────────────────────────
│
TRUST BOUNDARY
│
├── Identity
├── Email Verification
├── Phone Verification
├── Seller Verification
├── Beta Cohort
├── Report
├── Block
├── Moderation
├── Admin MFA
├── RBAC
└── Audit
│
├─────────────────────────────────────
│
MEASUREMENT BOUNDARY
│
├── Product Events
├── Funnel Metrics
├── Metric Contracts
├── Cohort Segments
└── Location Segments
│
├─────────────────────────────────────
│
DORMANT FINANCE BOUNDARY
│
├── Existing Orders
├── Existing Payments
├── Existing Escrow
├── Existing Wallet
├── Existing Payout
├── Existing Ledger
└── Existing Historical Records
```

Dormant finance remains compiled and migration-compatible but unavailable to normal product flows.

---

# 5.1 Financial Feature Boundary

Introduce a server-owned capability:

```ts
financialFeaturesEnabled(): boolean
assertFinancialFeaturesEnabled(): void
```

Default:

```text
false
```

in all beta environments.

The value is:

- server-controlled;
- validated at startup;
- unavailable to client override;
- unavailable as P0 admin toggle.

Public navigation must omit:

- cart;
- checkout;
- payment;
- wallet;
- payout;
- withdrawal;
- order-payment views;
- escrow;
- commission;
- financial dispute.

Direct browser requests to removed finance pages must safely redirect or return unavailable status.

Payment APIs, financial webhooks, and financial cron jobs must refuse operational work while finance is disabled.

Server actions return a typed error such as:

```text
FINANCIAL_FEATURES_DISABLED
```

The finance assertion must run before financial database mutation.

Where practical, it should run before financial state is read for an operation that should not execute during beta.

---

## 5.1.1 Historical Finance Maintenance

Historical financial cleanup must not be exposed through:

- HTTP;
- admin UI;
- query parameters;
- client controls;
- normal application cron.

If historical cleanup is required, use an explicitly named offline maintenance command.

Production maintenance procedure:

```text
dry-run
→ review affected records
→ explicit operator confirmation
→ scoped execution
→ audit
→ reconciliation
```

The maintenance command must not create new commercial transactions.

---

# 5.2 Lightweight Deal Outcome

Do not overload the existing `Order` model.

Order/payment concepts encode assumptions that do not apply to the private beta.

Introduce a separate domain:

```text
Deal
  id
  listingId
  buyerId
  sellerId
  status
  agreedPrice?
  fulfillmentMethod?
  buyerOutcomeAt?
  sellerOutcomeAt?
  completedAt?
  cancellationReason?
  createdAt
  updatedAt
```

Recommended P0 statuses:

```text
open
completed
cancelled
no_deal
```

If UX later proves that intermediate milestones are useful, they may be added through a reviewed state transition design.

Do not recreate a mini-order-management system inside `Deal`.

Possible fulfillment methods:

```text
meetup
seller_delivery
carrier
other
```

`agreedPrice` is optional and is only a user-entered transaction record.

LoaViet never collects this money in P0.

Introduce:

```text
DealStatusHistory
  id
  dealId
  status
  actorId
  note?
  createdAt
```

### Deal creation

Requires:

- live eligible listing;
- authorized buyer;
- seller;
- corresponding allowed conversation relationship;
- seller not suspended;
- buyer not blocked from seller;
- seller verification still valid where required.

### Outcome

Either party may independently mark outcome.

`successful_match` is emitted only when:

- both sides confirm successful completion;

or:

- an explicitly approved operations reconciliation rule resolves the mismatch.

The UI must state:

> Payment and fulfillment happen independently outside LoaViet.

---

# 5.3 Identity and Seller Verification

Authentication may retain password login during migration.

Accounts acquire explicit:

```text
emailVerifiedAt
phoneVerifiedAt
```

states.

OTP requirements:

- hashed at rest;
- single-use;
- short-lived;
- attempt-limited;
- resend-limited;
- rate-limited;
- protected against account enumeration;
- invalidated after successful use;
- never written to analytics/log output.

Provider integrations sit behind adapters.

Development may use a non-production testing adapter.

Production refuses to start verification delivery if required real-provider configuration is invalid.

Admin MFA uses:

```text
TOTP
+
one-time recovery codes
```

SMS is not an admin MFA factor.

---

## 5.3.1 Account Identity and Linking Rules

Verified email addresses are unique among active account identities.

Verified phone numbers are unique among active account identities.

P0 must define and test:

- email verification;
- phone verification;
- email change;
- phone change;
- lost-email recovery;
- lost-phone recovery;
- account recovery;
- adding authentication methods;
- identifier collision;
- identifier reuse after account deletion;
- session invalidation after sensitive identity changes.

A verified email or phone already owned by another account must **not** trigger automatic account merging.

Account merging is excluded from P0 unless separately specified.

Sensitive identity changes require recent authentication or equivalent step-up.

Where appropriate, sensitive changes invalidate active sessions.

When feasible, previous verified channels receive security notifications after sensitive identity changes.

---

## 5.3.2 SellerVerification Domain

Seller verification is a workflow rather than a boolean.

```text
SellerVerification
  id
  userId
  status
  method
  submittedAt?
  reviewedAt?
  reviewerId?
  reasonCode?
  note?
  policyVersion
  createdAt
  updatedAt
```

States:

```text
not_started
pending
verified
rejected
needs_review
revoked
```

Do not collect identity documents “just in case.”

Identity-document collection requires a separately reviewed legal/operations decision.

If later required, evidence must be:

- private;
- access-controlled;
- access-audited;
- encrypted or stored using appropriate private object-storage controls;
- covered by a documented retention schedule.

---

## 5.3.3 Seller Verification Policy v1

Seller verification is:

> a platform-access trust control.

It is **not**:

> a seller guarantee or product certification.

Minimum publication requirements:

```text
verified email
+
verified phone
+
declared seller type
+
canonical seller operating location
+
current Seller Rules accepted
+
active founding_seller membership during controlled beta
+
operations review = verified
```

Seller types:

```text
individual
business
```

Operations review checks at minimum:

- obvious duplicate-account indicators;
- current suspension;
- current ban;
- prior seller-verification revocation;
- abnormal account-creation pattern;
- suspicious phone/account relationships;
- inconsistent seller declaration;
- unresolved serious abuse reports;
- suspicious listing behavior already visible;
- business claims that require additional review.

Possible decisions:

```text
verified
needs_review
rejected
revoked
```

Every manual verification decision records:

- reviewer;
- timestamp;
- policy version;
- typed reason code;
- optional internal note.

Reason codes must not rely only on arbitrary free text.

Examples:

```text
requirements_met
duplicate_account_risk
active_suspension
prior_verification_revoked
identity_information_inconsistent
business_claim_needs_evidence
abuse_case_unresolved
manual_risk_review
other_reviewed_reason
```

Public seller-verification copy must not imply:

- product inspection;
- payment guarantee;
- transaction guarantee;
- platform endorsement.

---

# 5.4 Admin MFA and RBAC

Replace broad `admin` behavior with capability-based authorization.

Initial roles:

```text
super_admin
operations_admin
moderator
support
analyst
```

## super_admin

Responsible for:

- emergency configuration;
- administrator-role management;
- highest-risk security operations.

## operations_admin

Responsible for:

- seller verification;
- beta operations;
- listing operations;
- seller cohort management;
- user operations.

## moderator

Responsible for:

- reports;
- abuse cases;
- listing moderation;
- user moderation;
- block-related support;
- appeals workflow.

## support

Responsible for:

- limited user assistance;
- account-support operations explicitly granted;
- no broad sensitive-data access.

## analyst

Responsible for:

- aggregate marketplace analytics;
- read-only metric access;
- no broad user PII.

---

## 5.4.1 Initial RBAC Permission Matrix

| Capability | Super Admin | Operations Admin | Moderator | Support | Analyst |
|---|---:|---:|---:|---:|---:|
| Aggregate analytics | ✓ | ✓ | Limited | — | ✓ |
| Beta cohort management | ✓ | ✓ | — | — | — |
| Review seller verification | ✓ | ✓ | — | — | — |
| Approve/reject seller | ✓ | ✓ | — | — | — |
| Revoke seller verification | ✓ | ✓ | Scoped | — | — |
| Moderate listing | ✓ | ✓ | ✓ | — | — |
| Resolve reports | ✓ | ✓ | ✓ | — | — |
| Suspend user | ✓ | ✓ | Scoped | — | — |
| View basic user support information | ✓ | ✓ | Scoped | Scoped | — |
| View sensitive PII | Step-up | Scoped + audited | Exceptional + audited | Exceptional + audited | — |
| Export PII | Explicit permission + step-up | — | — | — | — |
| Revoke user sessions | ✓ | ✓ | Scoped | Scoped | — |
| Manage admin roles | Step-up | — | — | — | — |
| Security configuration | Step-up | — | — | — | — |
| View security audit log | ✓ | Scoped | Scoped | — | — |

Implementation should use explicit capability checks rather than scattering role-name comparisons throughout application code.

Example:

```text
seller.verify
listing.moderate
report.resolve
user.suspend
pii.view_sensitive
pii.export
admin.role_manage
session.revoke
analytics.read
beta_cohort.manage
```

---

## 5.4.2 Admin Session Requirements

All admin accounts require MFA enrollment.

Admin sessions use:

- shorter TTL than consumer sessions;
- explicit revocation support;
- session inventory;
- step-up authentication for sensitive actions.

Step-up required for at least:

- admin role modification;
- seller verification decisions where configured;
- PII export;
- destructive account action;
- sensitive security configuration;
- high-risk recovery actions.

Bootstrap and recovery procedures must be documented and tested to avoid permanent administrator lockout.

---

# 5.5 Report, Block, and Moderation

Reports may target:

```text
listing
user
message
```

Report requirements:

- typed reason code;
- rate limiting;
- reporter authorization;
- relevant snapshot;
- timestamp;
- moderation-case linkage.

Possible report reason categories include:

```text
suspected_scam
harassment
spam
counterfeit_claim
misleading_listing
prohibited_content
unsafe_behavior
identity_impersonation
other
```

A moderation case may group multiple reports.

```text
ModerationCase
  id
  targetType
  targetId
  state
  priority
  assignedModeratorId?
  reasonCategory
  createdAt
  updatedAt
```

Possible states:

```text
open
triaged
investigating
actioned
dismissed
appealed
closed
```

Blocking prevents:

- new conversations;
- new messages in either direction;
- relevant Deal interaction where appropriate.

Blocking does not:

- destroy existing evidence;
- silently delete chat history;
- remove historical moderation evidence.

Admin actions require typed reasons and append audit history.

---

## 5.5.1 Moderation Evidence Lifecycle

Evidence captured for an active moderation case must remain available even if mutable source content is edited or deleted.

Evidence snapshot stores:

```text
evidenceId
caseId
sourceResourceType
sourceResourceId
capturedAt
relevantSnapshot
subjectUserId?
reporterUserId?
classification
```

Evidence:

- is immutable from ordinary product flows;
- is access-restricted;
- is separately audited;
- has a defined retention policy.

Account deletion must not automatically erase evidence that is legitimately required for:

- active abuse investigation;
- security investigation;
- appeal;
- legal retention;
- fraud prevention.

Retention and deletion policy must be reviewed separately from ordinary user-content deletion.

---

# 5.6 Listing Domain

Existing categories and historical listings remain compatible.

Private-beta merchandising, catalog seeding, onboarding, and quality metrics focus on portable Bluetooth speakers.

Listing fields should include:

```text
id
sellerId
brandId
canonicalModelId
condition
inventoryContext
askingPrice
negotiable
provinceLevelCode
communeLevelCode?
locationDisplayName
legacyLocationText?
legacyDistrictText?
fulfillmentMethods
includedAccessories
knownDefects
repairHistory
description
status
createdAt
updatedAt
```

Inventory context:

```text
new
open_box
used
```

Condition uses user-facing definitions rather than only vague labels such as “95%”.

Exact street address is not stored as a public listing field.

---

## 5.6.1 Beta Category Publication Gate

Legacy category data remains readable and compatible.

New private-beta listing publication is controlled by a server-owned category allowlist.

Example:

```text
BETA_PUBLICATION_CATEGORIES
```

Initial value:

```text
portable_bluetooth_speaker
```

Adding another public beta category requires an explicit product decision.

Legacy code supporting another category does not automatically authorize new public listings in that category.

---

## 5.6.2 Listing Publication State

Recommended lifecycle:

```text
draft
verification_blocked
ready_for_review
under_review
published
paused
sold
rejected
removed
archived
```

A seller may create drafts before verification.

Publication requires:

```text
seller verified
+
active beta seller cohort membership
+
required fields complete
+
listing validation passed
+
policy accepted
+
moderation/review requirement satisfied
```

---

## 5.6.3 Photo Checklist

Portable-speaker listing UI guides the seller to provide:

- front;
- back;
- control panel;
- charging/connection ports;
- major scratches/damage;
- accessories;
- box where available;
- relevant label/serial area where safe.

Do not require public display of sensitive serial information.

---

## 5.6.4 Upload Requirements

Image uploads require:

- allowed format validation;
- MIME sniffing;
- image decode success;
- extension/MIME mismatch handling;
- encoded-size limit;
- pixel-dimension limit;
- decompression-bomb protection;
- metadata stripping;
- GPS/EXIF stripping;
- randomized storage keys;
- ownership authorization;
- safe server-side re-encoding where practical.

Executable SVG must not be accepted unless a reviewed sanitizer is used.

---

# 5.7 Search and Aliases

PostgreSQL remains:

- source of truth;
- initial search engine.

Do not add Elasticsearch/vector search for P0 unless evidence requires it.

Support:

- normalized lowercase form;
- Vietnamese diacritic-insensitive matching;
- brand aliases;
- model aliases;
- common spacing variants;
- obvious common spelling forms.

Examples:

```text
soundlink
sound link

charge4
charge 4

emberton2
emberton 2
```

Ranking considers:

1. textual relevance;
2. valid/published status;
3. listing quality;
4. freshness;
5. explicit buyer location preference.

Priority beta locations do **not** receive automatic relevance boosts when the buyer has not selected location preference.

---

## 5.7.1 Zero-Result Recovery

When search returns no eligible listing:

Offer:

- remove restrictive filters;
- browse selected brand;
- browse portable-speaker inventory;
- record anonymous/authenticated demand interest where policy permits.

P0 interest recording is telemetry.

It is **not** yet a saved-search notification system.

---

# 5.8 Telemetry

Telemetry must exist before inviting the private-beta cohort.

Define a server-owned event taxonomy.

Initial events:

```text
search_submitted
search_zero_result
search_result_clicked
listing_viewed
conversation_started
message_first_response
deal_created
deal_outcome_marked
successful_match
listing_marked_sold
report_submitted
user_returned
```

Recommended beta-operations events:

```text
seller_invited
seller_registered
seller_verified
seller_first_listing_published
listing_rejected
listing_removed
beta_membership_activated
```

Every product event includes:

- event name;
- schema version;
- timestamp;
- internal actor ID where available;
- internal session ID where available;
- relevant listing/model ID;
- coarse location code where appropriate;
- allowlisted metadata.

Product telemetry and security/audit logs are separate logical domains with separate retention/access policies.

---

## 5.8.1 Metric Contracts

Every decision-making metric requires a versioned contract.

```text
MetricContract
  name
  version
  definition
  numerator
  denominator
  deduplicationKey
  attributionWindow
  inclusionRules
  exclusionRules
  botInternalTrafficRules
  supportedSegments
  owner
```

### zero_result_rate_v1

Numerator:

```text
valid search sessions producing zero eligible results
```

Denominator:

```text
all valid submitted search sessions
```

Exclude:

- blank query;
- malformed query;
- test/internal users where configured;
- known automated traffic.

---

### search_result_ctr_v1

Numerator:

```text
eligible search sessions with at least one result click
```

Denominator:

```text
eligible search sessions with at least one displayed result
```

---

### listing_to_chat_v1

Numerator:

```text
qualified unique listing views that generate a new buyer↔seller conversation
within the attribution window
```

Denominator:

```text
qualified unique listing views
```

Deduplicate by:

```text
viewer + listing + attribution window
```

---

### search_to_chat_v1

Numerator:

```text
qualified search sessions that eventually produce a new buyer↔seller conversation
through a clicked result
```

Denominator:

```text
qualified search sessions
```

---

### seller_response_rate_v1

Numerator:

```text
new buyer conversations receiving a seller response within the defined response window
```

Denominator:

```text
eligible new buyer conversations
```

---

### median_first_response_time_v1

Time from:

```text
first qualified buyer message
```

to:

```text
first seller response
```

excluding internal/test traffic.

---

### successful_match_rate_v1

Definition must specify:

- successful bilateral confirmation;
- reconciliation policy;
- attribution period;
- duplicate handling.

---

### repeat_user_rate_v1

Must specify:

- return window;
- eligible account definition;
- internal/test exclusions.

---

## 5.8.2 Required Beta Dashboard

At minimum expose:

- query volume;
- zero-result rate;
- result CTR;
- listing → chat;
- search → chat;
- seller response rate;
- median first response time;
- median listing age;
- listing marked sold rate;
- successful matches;
- report rate;
- repeat users;
- seller activation;
- seller listing count.

Support segmentation by:

- beta cohort;
- primary/secondary market;
- category;
- brand/model where sample size permits.

Avoid displaying misleading low-sample percentages without context.

---

# 5.9 Location Model and Priority Communities

New location records use canonical administrative identifiers rather than arbitrary free-text city strings.

Recommended new-listing model:

```text
provinceLevelCode
communeLevelCode?
locationDisplayName
```

Legacy migration may preserve:

```text
legacyLocationText
legacyDistrictText
```

Historical district/quận/huyện strings may remain for:

- migration;
- compatibility;
- search;
- historical display.

They must not automatically be treated as the canonical current hierarchy for new records.

Uncertain legacy location mappings must not be fabricated.

---

## 5.9.1 Cold-Start Market Strategy

Architecture:

```text
Nationwide-capable
```

Operations:

```text
locally concentrated
```

### Primary beta market

```text
Hà Nội
```

Receives:

- seller recruitment;
- concierge onboarding;
- operations focus;
- manual liquidity review;
- curated marketplace landing/filter shortcuts.

### Secondary market

```text
TP.HCM
```

Receives:

- limited seller recruitment;
- observational telemetry;
- controlled experimentation.

### Other supported locations

May participate organically where product rules allow.

Do not describe any location as:

- certified safe;
- guaranteed;
- verified market.

Use labels such as:

```text
Khu vực beta trọng điểm
```

rather than:

```text
Khu vực an toàn
```

---

# 5.10 Founding Seller Operations

Cold-start supply is treated as an explicit operational workflow.

Introduce:

```text
FoundingSellerCandidate
  id
  userId?
  contactReference?
  source
  targetCommunity
  status
  assignedOperatorId?
  invitedAt?
  registeredAt?
  verifiedAt?
  firstListingAt?
  qualityListingCount
  lastContactAt?
  notes?
  createdAt
  updatedAt
```

Possible lifecycle:

```text
prospect
→ invited
→ registered
→ verification_pending
→ verified
→ concierge_onboarding
→ first_listing
→ active_founding_seller
→ inactive
→ exited
```

Admin console displays:

- total candidates;
- invited sellers;
- registered sellers;
- verification state;
- first-listing state;
- quality listing count;
- last seller activity;
- seller needing assistance;
- assigned operator;
- onboarding notes.

---

## 5.10.1 Concierge Onboarding

Operations staff may assist a founding seller with:

- model selection;
- structured listing fields;
- photo checklist;
- listing formatting;
- migration of existing listing information.

Operations must not silently fabricate seller claims.

The seller retains responsibility for:

- asking price;
- condition;
- defects;
- repair history;
- ownership/sale authority;
- product claims;
- publication consent.

---

# 6. User Experience Changes

## 6.1 Public Navigation

Remove or hide while finance is disabled:

- cart;
- checkout;
- wallet;
- payout;
- withdrawal;
- commission settings;
- escrow;
- payment-status navigation;
- finance disputes;
- sales/order surfaces tied to payment assumptions.

Replace purchase CTA with:

```text
Nhắn người bán
```

Optional secondary CTA:

```text
Tạo thỏa thuận
```

when Deal is enabled.

---

## 6.2 Seller Verification Copy

Allowed:

> Đã xác minh thông tin người bán theo yêu cầu hiện tại của LoaViet.

Avoid:

> Người bán được LoaViet bảo đảm.

Avoid:

> Sản phẩm được LoaViet đảm bảo an toàn.

Avoid:

> Giao dịch được bảo vệ bởi LoaViet.

---

## 6.3 Portable-Speaker Listing Flow

Use progressive disclosure.

Recommended flow:

### Step 1

```text
Brand
Canonical model
```

### Step 2

```text
New / open-box / used
Condition
```

### Step 3

```text
Asking price
Negotiable?
```

### Step 4

```text
Location
Fulfillment method
```

### Step 5

```text
Photos
```

### Step 6

```text
Accessories
Known defects
Repair history
```

### Step 7

```text
Preview
Seller verification check
Policy acceptance
Submit
```

Draft autosave is desirable but not release-blocking for the first reset batch.

---

## 6.4 Independent Transaction Safety Guidance

Near chat/deal flows clearly state:

- payment occurs outside LoaViet;
- verify product condition before payment;
- prefer appropriate public meetup/testing environments;
- never share OTP/password;
- treat suspicious payment links carefully;
- use report/block if necessary.

Avoid giving the impression that safety guidance equals transaction insurance.

---

# 7. Security and Abuse Controls

Security is part of P0.

---

## 7.1 Endpoint Rate Limits

Apply endpoint-specific rate limiting to:

- login;
- verification;
- OTP request;
- OTP verify;
- password recovery;
- account recovery;
- report;
- chat;
- image upload;
- search;
- listing mutation;
- Deal mutation;
- beta invite acceptance.

Rate limits should consider:

- user;
- session;
- IP/network signal where appropriate;
- target resource;
- abuse pattern.

---

## 7.2 Authentication Abuse

Explicitly protect against:

- OTP brute force;
- OTP resend flooding;
- account enumeration;
- credential stuffing;
- session fixation;
- stale-session reuse after recovery;
- unauthorized email/phone linking;
- recovery abuse.

---

## 7.3 Authorization Abuse

Explicitly test/protect:

- IDOR/BOLA;
- cross-account listing modification;
- cross-account Deal modification;
- cross-account report access;
- privilege escalation;
- support-to-admin escalation;
- seller verification bypass;
- beta-cohort bypass;
- suspended-user bypass;
- revoked-seller publication bypass.

---

## 7.4 Browser Security

State-changing browser actions must receive appropriate protection against:

- CSRF;
- replay where relevant;
- untrusted redirects;
- stored XSS;
- reflected XSS.

Listing descriptions, messages, reports, seller profile text, and internal moderation-visible user content are untrusted input.

---

## 7.5 Upload Security

Require:

- MIME sniffing;
- image decoding;
- encoded size limit;
- pixel dimension limit;
- decompression-bomb protection;
- metadata stripping;
- GPS stripping;
- random storage keys;
- authorization checks;
- safe re-encoding where practical.

Do not trust filename extension alone.

---

## 7.6 Admin Security

Admin:

- requires MFA;
- uses scoped RBAC;
- has shorter sessions;
- supports revocation;
- requires step-up for high-risk actions;
- logs sensitive access.

PII access is independently audited.

Admin search/export minimizes exposed PII.

---

## 7.7 Account Recovery

Recovery must:

- prevent account enumeration;
- protect against recovery abuse;
- invalidate appropriate existing sessions;
- record security events;
- notify previous verified channels when feasible.

---

## 7.8 Moderation Enforcement

Before allowing:

- listing publication;
- new chat;
- message;
- Deal mutation;

the backend must consider relevant:

- suspension;
- block;
- seller-verification revocation;
- beta-membership status.

---

# 8. Migration and Compatibility Strategy

Migration is additive-first.

---

## 8.1 Finance

1. Add the financial boundary before removing public UI.

2. Preserve:
   - Order;
   - Payment;
   - Payout;
   - Wallet;
   - Ledger;
   - Withdrawal;
   - existing finance records.

3. Do not repurpose finance statuses for Deal.

---

## 8.2 Seller Verification

Map:

```text
User.isVerifiedSeller
```

into the new SellerVerification workflow where a confident migration rule exists.

After migration, SellerVerification becomes canonical.

The legacy boolean remains temporarily for compatibility.

Remove it only through a later explicit migration.

---

## 8.3 Location

Map legacy location text only where confident.

Preserve original legacy strings.

Do not fabricate uncertain administrative matches.

---

## 8.4 Beta Cohort

Beta membership is additive.

Existing users do not automatically become founding sellers.

Trusted/internal users may receive cohort membership only through:

- reviewed seed;
- explicit migration;
- admin operation.

---

## 8.5 Admin Roles

Existing broad administrator accounts must be mapped intentionally into new roles.

Do not treat old:

```text
admin = true
```

as permanent authorization for every new capability.

---

## 8.6 Backfill Requirements

Every backfill defines:

- dry-run behavior;
- expected affected row count;
- idempotency;
- rollback/recovery;
- post-migration verification.

---

## 8.7 Route Compatibility

A route removed from navigation still receives:

- direct-request tests;
- authorization checks;
- feature-boundary checks.

---

# 9. Delivery Batches and Gates

Every batch must be independently reviewable and independently committable.

Do not advance to the next batch until the current gate passes.

---

# Batch 0 — Repository and Surface Inventory

Before changing behavior, inventory the current repository.

Identify:

- finance routes;
- server actions;
- payment APIs;
- webhook handlers;
- cron/background finance jobs;
- wallet logic;
- order logic;
- escrow logic;
- payout logic;
- withdrawal logic;
- commission logic;
- payment provider integration;
- finance environment variables;
- finance database models;
- finance UI routes;
- authorization middleware;
- admin surfaces;
- listing publication entry points;
- chat mutation entry points;
- analytics entry points;
- existing seller verification logic;
- existing admin-role logic.

No product behavior changes in Batch 0.

### Gate

A reviewed inventory exists.

Every known financial mutation surface has:

- source location;
- route/action/job identity;
- planned shutdown defense.

Unknown or ambiguous finance behavior blocks Batch 1.

---

# Batch 1 — Financial Shutdown Boundary

Deliver:

- server-owned finance capability;
- finance route denial;
- webhook denial;
- cron denial;
- UI/navigation removal;
- copy cleanup;
- zero beta-facing fees;
- historical admin visibility.

### Gate

Automated tests prove:

- no payment mutation;
- no payout mutation;
- no wallet mutation;
- no escrow mutation;
- no commission mutation;
- no financial dispute mutation.

Source/copy scan finds no public escrow/payment-protection/commission promise.

Preflight passes:

- lint;
- typecheck;
- tests;
- build;
- smoke.

---

# Batch 2 — Identity, Seller Verification, Admin MFA/RBAC, Sessions, Recovery

Deliver:

- email verification state;
- phone verification state;
- OTP controls;
- identity-linking rules;
- seller verification workflow;
- Seller Verification Policy v1;
- admin roles;
- capability-based RBAC;
- admin MFA;
- step-up;
- session list;
- session revocation;
- recovery safeguards;
- audit foundation.

### Gate

Pass:

- authorization matrix tests;
- OTP abuse tests;
- identity-collision tests;
- recovery abuse tests;
- session invalidation tests;
- seller publication-gate tests;
- MFA tests;
- admin step-up tests.

No privileged action relies only on UI visibility.

Admin bootstrap/recovery runbook is exercised.

---

# Batch 3 — Report, Block, Moderation, Evidence, Audit

Deliver:

- reports;
- typed reason codes;
- blocking;
- moderation cases;
- case assignment;
- moderation evidence snapshots;
- moderation action history;
- appeal foundation;
- expanded audit context.

### Gate

Pass:

- block enforcement;
- blocked chat prevention;
- moderation transition tests;
- immutable evidence behavior;
- report rate limits;
- audit append behavior;
- moderator permission tests.

---

# Batch 4 — Listing Quality, Images, Canonical Models, Category Gate

Deliver:

- portable-speaker structured listing;
- canonical brand/model;
- initial model seed;
- condition definitions;
- defects;
- repair history;
- accessories;
- price;
- negotiability;
- fulfillment options;
- photo checklist;
- upload hardening;
- category publication allowlist;
- seller verification gate.

### Gate

Pass:

- draft behavior;
- publication gate;
- invalid-category rejection;
- conditional fields;
- upload validation;
- image security cases;
- canonical model selection;
- legacy listing compatibility.

---

# Batch 5 — Search, Location, Telemetry, Metric Contracts

Deliver:

- search normalization;
- aliases;
- diacritic-insensitive search;
- empty-state recovery;
- canonical current location model;
- legacy location preservation;
- event schemas;
- funnel events;
- metric contracts;
- basic aggregates/dashboard.

### Gate

Pass:

- alias tests;
- diacritic tests;
- location-filter tests;
- unknown legacy-location migration tests;
- event-schema validation;
- PII rejection;
- zero-result fixture reconciliation;
- CTR fixture reconciliation;
- listing→chat fixture reconciliation;
- response metrics reconciliation.

---

# Batch 6 — Chat Hardening and Deal Outcome

Deliver:

- chat authorization hardening;
- block enforcement;
- suspended/revoked seller checks;
- lightweight Deal;
- Deal history;
- outcome UI;
- notifications where required;
- external-payment safety disclaimer.

### Gate

Pass:

- buyer/seller ownership;
- blocked-user behavior;
- suspended-user behavior;
- Deal concurrency;
- Deal idempotency;
- Deal authorization;
- successful-match analytics.

No Deal action creates:

- Payment;
- Payout;
- Wallet;
- Ledger;
- Escrow transaction.

---

# Batch 7 — Private Beta Cohort and Founding Seller Operations

Deliver:

- BetaCohortMembership;
- invitation flow;
- founding seller lifecycle;
- founding seller console;
- concierge tracking;
- seller activation tracking;
- buyer beta access policy.

### Gate

Pass:

- seller cohort authorization;
- invite acceptance;
- suspended membership enforcement;
- seller cohort + verification publication requirement;
- cohort telemetry.

Operations can manage:

- 20–50 invited founding sellers;
- 100–300 quality listings.

---

# Batch 8 — Operational, Legal, Security Launch Gate

Finalize:

- Terms;
- Privacy;
- Marketplace Rules;
- Seller Rules;
- Community Rules;
- Safety Guidance;
- policy-version recording;
- operations playbooks;
- incident playbook;
- founding seller onboarding;
- model seed;
- monitoring;
- alerts;
- backup;
- restore drill;
- admin access review;
- security review;
- private-beta release checklist.

### Gate

Required:

- no known critical security issue;
- restore drill successful;
- admin MFA operational;
- RBAC operational;
- moderation operational;
- report/block operational;
- seller verification operational;
- legal/operations sign-offs recorded;
- founding seller process ready;
- supply readiness approved.

---

# 10. Verification Strategy

Every batch is:

- test-first where practical;
- independently reviewable;
- independently committable.

Required verification includes:

- unit tests;
- validation tests;
- permission tests;
- state-transition tests;
- database integration tests;
- route/action contract tests;
- direct unauthorized-route tests;
- browser E2E for critical flows;
- accessibility checks;
- migration review;
- security-abuse tests;
- production build;
- safe smoke test.

Required commands include repository-appropriate equivalents of:

```text
npm run lint
npx tsc --noEmit
npm test
production build
repository preflight
```

Perform explicit diff/status audit.

Exclude from commits:

- runtime uploads;
- local secrets;
- local settings;
- generated scratch data;
- unrelated work.

---

# 10.1 Required Security Abuse Matrix

Applicable tests include:

```text
Unauthorized listing edit
Listing IDOR
Deal IDOR
Moderation-resource IDOR
Privilege escalation
Support → admin escalation
OTP brute force
OTP resend flooding
Account enumeration
Session fixation
Session reuse after recovery
CSRF state-changing action
Stored XSS through listing
Stored XSS through chat
Stored XSS through report
Malicious image upload
MIME spoof
Image decompression bomb
Blocked-user chat bypass
Suspended-user publication bypass
Revoked-seller publication bypass
Beta-cohort bypass
Concurrent seller-verification update
Concurrent Deal status update
Financial direct route
Financial API mutation
Financial webhook processing
Financial cron execution
Historical finance escape-hatch abuse
```

Critical/high cases applicable to a batch must pass before acceptance.

---

# 11. OpenCode-on-Mac Execution Protocol

Implementation is performed batch-by-batch by OpenCode on the Mac using GLM 5.3.

For every batch:

1. Synchronize to the reviewed base commit.

2. Confirm the worktree is clean except explicitly known local-only files.

3. Give OpenCode only:
   - approved specification;
   - approved batch plan;
   - relevant repository instructions;
   - required verification commands.

4. Require focused reviewable commits.

5. Require a clean batch checkpoint.

6. OpenCode must not:
   - push;
   - merge;
   - deploy;
   - perform destructive cleanup;
   - stage unrelated files.

7. Export OpenCode session metadata showing:
   - selected model;
   - session;
   - outcome.

8. Review the diff locally.

9. Inspect:
   - migrations;
   - authorization;
   - direct-route defenses;
   - feature boundaries;
   - schema changes.

10. Independently rerun risk-proportional verification.

11. If review fails:
   - continue the same session where practical;
   - provide concrete findings;
   - do not advance to the next batch.

12. Record:
   - commits;
   - checks;
   - residual risks;
   - deferred requirements.

---

## 11.1 Implementation Ambiguity Stop Rule

OpenCode must not invent product/security/legal policy when material ambiguity affects:

- payment;
- custody;
- finance;
- seller verification;
- identity linking;
- administrator authorization;
- PII access;
- retention;
- legal acceptance;
- moderation sanctions;
- account merging.

When encountered:

```text
1. Record the ambiguity.
2. Identify the blocked implementation task.
3. Preserve the safer existing behavior.
4. Stop that task.
5. Request/rely on a reviewed specification update before continuing.
```

Implementation convenience is not authorization to redefine policy.

---

# 12. Private-Beta Readiness Criteria

The product is technically beta-ready only when:

- all public financial behavior is unavailable;
- public copy accurately describes the non-custodial model;
- seller verification works;
- seller publication gate works;
- beta cohort gate works;
- admin MFA works;
- RBAC works;
- report/block works;
- moderation works;
- recovery works;
- audit works;
- portable-speaker listing flow passes critical E2E;
- search→listing→chat loop passes critical E2E;
- telemetry produces agreed metrics without raw PII;
- Terms/Privacy/Marketplace/Seller/Community policies have recorded reviews;
- monitoring exists;
- incident escalation exists;
- support path exists;
- restore drill succeeds;
- no known critical security finding remains open.

---

## 12.1 Supply Readiness Gate

Technical readiness does not automatically authorize buyer acquisition.

```text
CODE READY
≠
MARKET READY
```

Before broader private-beta buyer invitations:

- founding seller workflow is operational;
- target number of verified founding sellers is reached or explicitly approved;
- target inventory is reached or explicitly approved;
- approximately 100–300 quality listings can be supported;
- core model coverage is manually reviewed;
- listing quality is manually sampled;
- seller response monitoring works;
- moderation/support capacity exists.

---

## 12.2 Private-Beta Success Metrics

Post-launch success is evaluated primarily through liquidity and trust.

Do not use raw account registration as the main success metric.

Track:

```text
search volume
zero-result rate
search result CTR
listing → chat
search → chat
seller response rate
median first response time
listing age
listing marked sold
successful match
report rate
repeat usage
seller activation
active seller count
quality listing count
```

---

## 12.3 Marketplace Funnel

Primary funnel:

```text
Search
  ↓
Eligible Result
  ↓
Listing View
  ↓
Conversation
  ↓
Seller Response
  ↓
Deal
  ↓
Successful Match
```

Secondary supply funnel:

```text
Seller Prospect
  ↓
Invite
  ↓
Registration
  ↓
Verification
  ↓
First Listing
  ↓
3+ Quality Listings
  ↓
Active Seller
```

---

# 13. Post-Beta Expansion Gates

Expansion is evidence-driven.

Do not unlock major roadmap items only because a target date has passed.

---

## 13.1 Add Another Active City

Promote a secondary market only when the primary market demonstrates sufficient:

- supply density;
- buyer demand;
- search success;
- seller response;
- search→chat conversion;
- operations capacity;
- moderation capacity.

Expansion should not materially damage the primary market's liquidity.

---

## 13.2 Add Another Speaker Category

Require evidence of:

- repeated demand;
- supply availability;
- category-specific listing requirements;
- understood moderation/trust risks;
- sufficient operations capacity.

Example future categories may include:

- computer speakers;
- bookshelf speakers;
- soundbars;
- karaoke speakers.

They are not automatically enabled.

---

## 13.3 Saved Search

Prioritize when:

- meaningful repeated searches have zero inventory;
- buyer demand is being lost because supply arrives later;
- notifications can materially improve demand/supply matching.

Saved search may be introduced before marketplace liquidity is fully mature if it directly repairs zero-result leakage.

---

## 13.4 Public Review System

Enable only when:

- Deal outcome integrity is adequate;
- sufficient real completed outcomes exist;
- review eligibility can be tied to valid marketplace interaction;
- moderation/abuse rules exist;
- retaliation/spam risks are understood.

---

## 13.5 Events

Enable when:

- user density justifies coordination;
- operations can manage the event;
- moderation capacity exists.

Possible future event types:

```text
JBL Weekend
Swap Sunday
Portable Speaker Week
Used Speaker Market
Họp Chợ Loa
```

Events are a post-liquidity tool, not a substitute for basic marketplace health.

---

## 13.6 Price Intelligence

Enable only after sufficient clean data exists.

Requirements include:

- canonical model normalization;
- normalized condition;
- enough comparable listings;
- meaningful sold/outcome records;
- outlier handling;
- minimum sample size;
- data freshness rules;
- confidence representation.

Low-confidence estimates must not be presented as authoritative market value.

P0 must not ask AI to invent market prices.

---

## 13.7 AI Pricing

AI pricing remains disabled until:

- price-data quality is demonstrated;
- deterministic/statistical baseline exists;
- evaluation dataset exists;
- confidence/fallback rules exist.

AI output must not override insufficient data.

Correct behavior when evidence is insufficient:

```text
Not enough reliable data yet.
```

not:

```text
Estimated fair price: 1,932,421 VND
```

without evidence.

---

## 13.8 Wanted Market

A reverse marketplace may be introduced when zero-result demand becomes meaningful.

Future flow:

```text
Buyer searches
↓
No suitable inventory
↓
Buyer records wanted request
↓
Matching sellers are notified
↓
Seller submits offer
```

This should be driven by observed demand rather than launched purely as a roadmap feature.

---

## 13.9 Trade / Swap

Trade/swap may be enabled when:

- core marketplace flows are stable;
- Deal model can represent non-standard exchange;
- moderation risks are understood.

Do not overload the P0 Deal model prematurely.

---

# 14. Product Decision Principles

Before adding a feature, ask:

```text
Does it improve liquidity?
Does it improve trust?
Does it reduce user friction?
Does it improve retention?
Can it be measured?
Can it be abused?
Can operations support it?
Is it legally/policy safe?
```

A feature should ideally reduce at least one of:

```text
number of steps
time
uncertainty
risk
```

If it does none of these, do not prioritize it.

---

# 15. What Not To Do During Private Beta

Do not:

- chase raw signup numbers;
- open all categories;
- expand cities too quickly;
- launch complex payment infrastructure;
- turn Deal into Order V2;
- claim seller verification is a guarantee;
- collect identity documents without need;
- launch price AI without data;
- add Elasticsearch/vector infrastructure without evidence;
- build native apps before web retention is understood;
- pay for broad acquisition before supply quality exists;
- fake marketplace liquidity;
- promote fake discounts;
- overbuild community features;
- use donation as hidden fee;
- use admin UI visibility as authorization;
- let coding agents invent security policy.

---

# 16. Private-Beta Strategic Summary

The private beta is deliberately simple:

```text
LoaViet
=
specialized speaker classifieds
+
high-quality listings
+
structured search
+
chat
+
lightweight deal outcome
+
seller verification
+
trust & safety
+
strong administration
+
measurement
```

The first marketplace objective is:

```text
Trusted Sellers
↓
Quality Listings
↓
Better Search Success
↓
Buyer Conversations
↓
Seller Responses
↓
Successful Deals
↓
Repeat Usage
↓
More Supply
```

The platform should prove:

```text
Supply
↕
Demand
```

before adding:

```text
Payments
Escrow
Commission
Price Intelligence
Events
Reviews
AI
Advanced Monetization
```

The long-term Speaker Platform vision remains broader.

The purpose of this reset is not to abandon that vision.

It is to build the smallest safe marketplace capable of proving that the vision has real user demand.

---

# 17. Final Implementation Rule

The private-beta implementation is complete only when:

```text
Built
+
Authorized
+
Secured
+
Tested
+
Observable
+
Operationally Supportable
+
Policy Reviewed
+
Recoverable
```

A feature that merely renders successfully in the UI is not complete.

The final P0 priority order is:

```text
1. Inventory current system surfaces
2. Disable finance safely
3. Secure identity and seller verification
4. Secure admin access and authorization
5. Establish moderation/report/block
6. Improve listing quality
7. Improve images
8. Improve search
9. Add trustworthy telemetry
10. Harden chat
11. Add lightweight Deal outcome
12. Establish beta cohort controls
13. Seed founding sellers
14. Reach supply readiness
15. Invite controlled buyer cohort
16. Observe real marketplace behavior
17. Expand only from evidence
```

The private-beta north-star question is:

> **Can a real buyer looking for a real speaker reliably find a trustworthy-enough seller, start a conversation, reach a real deal, and have enough confidence to return to LoaViet again?**

If the answer becomes consistently yes, LoaViet has earned the right to build the next layer.