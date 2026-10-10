# Private-beta release checklist — cổng phát hành (Batch 8 Task 9)

> **Cơ chế** (spec §12 + §12.1 Supply Readiness Gate + §9 Batch 8 Gate + FD
> register mirror B3; corrections 2026-10-08 items 7, 8, 31, 32): mọi tiêu chí
> §12 / §12.1 / §9 Batch 8 được map tới evidence (test / doc / script /
> user-run) + **Status** + **Sign-off**. `scripts/release-gate.sh` parse file
> này: **zero PENDING** ở cả hai bảng; hàng **FOUNDER** chỉ qua với Sign-off
> không trống; **mọi hàng FD-mirror cần Decision + Date không trống** (gate
> không qua khi còn register item blocking chưa quyết).
>
> **Gate chạy trên workstation/CI tại release commit** (corrections item 8):
> host production docker-only KHÔNG có Node (`scripts/ops-alerts-cron.sh:5-8`)
> — MỌI bước server-side (drill `--file` production, access review production,
> crontab install, nginx HSTS/`limit_req`, CSP flip, secrets dedicated, backup
> pre-migrate, migrate/seed/backfill, uploads volume, grant membership) là
> **hàng FOUNDER người deploy (user) chạy + ký**; gate chỉ kiểm tra DOCS +
> suite local. Output server-side paste vào evidence doc tương ứng (dated,
> redacted) rồi mới ký.
>
> **Status** đúng một trong `PASS` / `PENDING` / `FOUNDER`. **Sign-off là
> founder-only** (spec §4.11 — implementer/agent KHÔNG bao giờ điền; một commit
> implementer tự ký là vi phạm hợp đồng). **Gate ĐỎ là kết quả ĐÚNG** khi policy
> còn `DRAFT-NOT-REVIEWED` và hàng founder blocking chưa ký (FD-3 fail-closed)
> — KHÔNG yếu hoá check nào để cho qua; founder duyệt policy + quyết register
> item + ký checklist là việc làm gate xanh.

## 1. Bảng chính — §12 readiness + §12.1 supply + §9 Batch 8 gate + hàng vận hành

> Các hàng OPS liệt kê theo **thứ tự deploy** (secrets → backup → migrate →
> seed → backfills → verify/ops); **Ref là ID cố định, không phải thứ tự** —
> thứ tự chạy đọc theo chữ (TRƯỚC/SAU) trong mỗi hàng.

| Ref | Criterion | Evidence type | Evidence | Status | Sign-off |
|---|---|---|---|---|---|
| §12-01 | §12: mọi hành vi tài chính công khai unavailable (§4.1) | test + script | `tests/unit/financial-shutdown-actions.test.ts`, `tests/unit/financial-shutdown-routes.test.ts`, `tests/unit/finance-public-surface.test.ts`, `tests/unit/admin-finance-readonly.test.ts`, `tests/integration/escrow.test.ts`, `scripts/smoke.sh`; `FINANCIAL_FEATURES_ENABLED="false"` ×3 (`.env.example:46`, `docker-compose.prod.yml:123`, `tests/docker/docker-compose.smoke.yml:66`) | PASS | — |
| §12-02 | §12: public copy mô tả chính xác mô hình non-custodial (§4.2/§4.7) | test | `tests/unit/copy-safety.test.ts` (scan §4.2 + §4.7 vĩnh viễn, allowlist negation lines) | PASS | — |
| §12-03 | §12: seller verification hoạt động (§5.3) | test + doc | `tests/unit/seller-verification-actions.test.ts`, `tests/unit/seller-verification-policy.test.ts`, `tests/unit/verification-actions.test.ts`, `tests/integration/seller-verification.test.ts`, `docs/operations/seller-verification-playbook.md` (checklist §5.3.3 + RR-3 duplicate-phone query). **Production tới FD-R1: không seller nào qua được `phone_verified` → verification/publish chặn** (xem mirror FD-R1/FD-R69) | PASS | — |
| §12-04 | §12: publication gate hoạt động (§4.4) | test | `tests/unit/publication-gate.test.ts`, `tests/unit/listing-publication.test.ts`, `tests/integration/listing-publication.test.ts`, `tests/integration/listing-submit-approve-race.test.ts` | PASS | — |
| §12-05 | §12: beta cohort gate hoạt động (§4.9) | test | `tests/unit/beta-access.test.ts`, `tests/unit/chat-beta-gate.test.ts`, `tests/unit/deal-beta-gate.test.ts`, `tests/unit/suspended-membership-enforcement.test.ts`, `tests/integration/beta-access-enforcement.test.ts`, `tests/integration/suspended-membership-enforcement.test.ts` | PASS | — |
| §12-06 | §12: admin MFA hoạt động (§5.4.2) | test + doc | `tests/unit/admin-mfa.test.ts`, `tests/unit/admin-mfa-login.test.ts`, `tests/integration/admin-mfa-login.test.ts`, `tests/integration/admin-bootstrap.test.ts`, `docs/operations/admin-bootstrap-recovery-runbook.md`, `docs/operations/admin-access-review.md` (dev runs dated; production run = hàng OPS-02) | PASS | — |
| §12-07 | §12: RBAC hoạt động (§5.4.1) | test | `tests/unit/rbac.test.ts` (matrix) + per-action FORBIDDEN suites B3–B7 (ma trận §10.1: `docs/operations/private-beta-security-review.md` §1) | PASS | — |
| §12-08 | §12: report/block hoạt động (§7.3) | test | `tests/unit/report-actions.test.ts`, `tests/unit/block-actions.test.ts`, `tests/unit/chat-guard.test.ts`, `tests/integration/block-enforcement.test.ts` | PASS | — |
| §12-09 | §12: moderation hoạt động (§5.5) | test + doc | `tests/unit/moderation.test.ts`, `tests/unit/moderation-actions.test.ts`, `tests/unit/moderation-pages.test.ts`, `tests/unit/appeal-actions.test.ts`, `tests/unit/appeal-page.test.ts`, `tests/unit/suspension-actions.test.ts`, `docs/operations/moderation-playbook.md` | PASS | — |
| §12-10 | §12: recovery hoạt động (§5.7) | test + doc | `tests/unit/recovery-actions.test.ts`, `tests/unit/session.test.ts`, `tests/integration/session-lifecycle.test.ts`, `docs/operations/account-recovery-playbook.md`. **Production tới FD-R1: `/recover` KHÔNG gửi được mã** (adapter fail-closed `OTP_DELIVERY_UNAVAILABLE` — `src/lib/verification-delivery.ts:91-101`); manual fallback = runbook §6 audited two-person (xem mirror FD-R1/FD-R3) | PASS | — |
| §12-11 | §12: audit hoạt động (§4.6) | test | `tests/unit/audit-event.test.ts`, `tests/unit/audit-append.test.ts`, `tests/integration/multi-row-writes.test.ts`, `tests/integration/report-evidence.test.ts` (evidence snapshots §5.5.1) | PASS | — |
| §12-12 | §12: portable-speaker listing flow qua critical E2E (§6.3) | founder | **FD-R59 (BLOCKING)**: repo không có E2E infrastructure (RR-14), Batch 8 không thêm (S8). Coverage hiện tại = action-level unit + real-DB integration: `tests/unit/portable-listing-form.test.ts`, `tests/unit/sell-pages.test.ts`, `tests/integration/listing-publication.test.ts`, `tests/integration/catalog-merge-race.test.ts`. Founder **hoặc** chấp nhận posture này (ký + ngày) **hoặc** commission Playwright batch cho 2 flow trước mời beta | FOUNDER | — |
| §12-13 | §12: search→listing→chat loop qua critical E2E | founder | **FD-R59 (BLOCKING)** — như §12-12. Coverage: `tests/unit/search-query.test.ts`, `tests/integration/search.test.ts`, `tests/unit/chat-hardening.test.ts`, `tests/integration/chat-hardening.test.ts`, `tests/integration/block-enforcement.test.ts` | FOUNDER | — |
| §12-14 | §12: telemetry sinh metric thỏa thuận, không PII thô (§4.8) | test | `tests/unit/product-events.test.ts`, `tests/unit/telemetry-wiring.test.ts`, `tests/unit/metric-contracts.test.ts`, `tests/unit/metrics-reconciliation.test.ts` + PII-guard source scans Batch 5 | PASS | — |
| §12-15 | §12: sáu policy có bản ghi duyệt (§3.1) | founder + script | `docs/operations/policy-review-record.md` (Reviewer/Decision founder-only), `scripts/policy-hash.ts --check`, `tests/unit/policy-registry.test.ts`; gate `policy-reviews` của `scripts/release-gate.sh` chặn khi chưa duyệt (FD-R34 — central blocker; FD-R4 bump v1→v2 trong commit founder) | FOUNDER | — |
| §12-16 | §12: monitoring tồn tại | script + doc | `scripts/ops-alerts.ts`, `docs/operations/monitoring-signals.md`, `tests/unit/ops-alerts.test.ts` (health, error-rate, auth abuse, finance-boundary watermark, cron/backup; no PII); crontab install = hàng OPS-03 | PASS | — |
| §12-17 | §12: incident escalation tồn tại | doc | `docs/operations/incident-playbook.md` (severity SEV1–3 PROVISIONAL FD-R38, comms, evidence preservation §5.5.1) | PASS | — |
| §12-18 | §12: support path tồn tại | doc | `docs/operations/concierge-onboarding-playbook.md` (§5.10.1 responsibility split), `docs/operations/account-recovery-playbook.md`, `docs/operations/moderation-playbook.md` | PASS | — |
| §12-19 | §12: restore drill thành công | script + doc | `bash scripts/restore-drill.sh` scratch PASS (dated 2026-10-08, graph 9 migration, 48 bảng — `docs/operations/restore-drill-evidence.md`); drill `--file` production = hàng OPS-01 | PASS | — |
| §12-20 | §12: không còn critical security finding mở | doc + test | `docs/operations/private-beta-security-review.md` (findings register 0 CRITICAL/OPEN), `tests/unit/abuse-matrix.test.ts`, `tests/unit/security-headers.test.ts`, `tests/unit/chat-surface-xss.test.ts`, `npm audit --omit=dev` = 0 | PASS | — |
| §12.1-01 | §12.1: founding seller workflow operational | test + doc | `tests/unit/founding-seller-invite.test.ts`, `tests/unit/founding-seller-lifecycle.test.ts`, `tests/unit/beta-cohort-console.test.ts`, `tests/integration/founding-seller-invite.test.ts`, `docs/operations/founding-seller-onboarding-checklist.md` | PASS | — |
| §12.1-02 | §12.1: target seller verified đạt hoặc được duyệt rõ ràng (20–50) | founder | `docs/operations/founding-seller-onboarding-checklist.md` (mục tiêu §2.7 — targets, không phải code gate); số liệu console `/admin/beta-cohort`; phê duyệt = founder (FD-R30) | FOUNDER | — |
| §12.1-03 | §12.1: target inventory đạt hoặc được duyệt rõ ràng | founder | console supply-readiness view (`invitedFoundingSellers` ever-invited monotonic — FD-R73); phê duyệt = founder (FD-R30) | FOUNDER | — |
| §12.1-04 | §12.1: ~100–300 quality listings hỗ trợ được | founder | **FD-R23** (định nghĩa "quality listing" = ops-set count — gates chính hàng này); dashboard + console | FOUNDER | — |
| §12.1-05 | §12.1: core model coverage được review thủ công | founder | `docs/operations/model-seed-review-procedure.md` (`/admin/catalog` `listing.moderate`; **FD-R16** — founder cung cấp + duyệt danh sách, implementer không bao giờ soạn) | FOUNDER | — |
| §12.1-06 | §12.1: listing quality được sample thủ công | founder | ops sampling theo `docs/operations/founding-seller-onboarding-checklist.md`; vocabulary FD-R14 (condition-grade) / FD-R15 (photo checklist) | FOUNDER | — |
| §12.1-07 | §12.1: seller response monitoring hoạt động | test | `tests/unit/analytics-dashboard.test.ts`, `tests/unit/metrics-reconciliation.test.ts` (dashboard render named pending states; giá trị rate = **FD-R20** — mirror) | PASS | — |
| §12.1-08 | §12.1: moderation/support capacity tồn tại | founder | attestation capacity của founder/ops (playbooks §0 — hàng đợi moderation + concierge); không có capacity metric nào bị bịa | FOUNDER | — |
| §9-01 | §9 Batch 8 gate: không có critical security issue đã biết | doc + test | `docs/operations/private-beta-security-review.md` findings register (0 CRITICAL, 0 HIGH; 2 MEDIUM ACCEPTED FD-R58, 10 LOW ACCEPTED, 1 LOW OPEN = CSP flip SEC-01) + `tests/unit/abuse-matrix.test.ts` (29 hàng machine-checked) | PASS | — |
| §9-02 | §9 Batch 8 gate: restore drill successful | script + doc | như §12-19 (`docs/operations/restore-drill-evidence.md` dated PASS sections) | PASS | — |
| §9-03 | §9 Batch 8 gate: admin MFA operational | test + doc | như §12-06 (`docs/operations/admin-access-review.md` — findings vocabulary + dev runs dated; production run = OPS-02) | PASS | — |
| §9-04 | §9 Batch 8 gate: RBAC operational | test | như §12-07 (`tests/unit/rbac.test.ts` matrix + mọi capability suite B3–B7 xanh; FD-R58 observations ghi trong security review) | PASS | — |
| §9-05 | §9 Batch 8 gate: moderation operational | test + doc | như §12-09 (`docs/operations/moderation-playbook.md`: queue, hand-off, recusal FD-R11, evidence §5.5.1, appeal intake + notification gap FD-R8, sanction taxonomy PROVISIONAL FD-R12, placeholder copy FD-R50) | PASS | — |
| §9-06 | §9 Batch 8 gate: report/block operational | test | như §12-08 (Batch 3 block/report suites xanh — re-run là evidence) | PASS | — |
| §9-07 | §9 Batch 8 gate: seller verification operational | test + doc | như §12-03 (Batch 2/4 verification + publication-gate suites xanh; playbook §5.3.3 + RR-3 query; production stall `phone_verified` = FD-R1 mirror) | PASS | — |
| §9-08 | §9 Batch 8 gate: legal/operations sign-offs recorded | founder + script | `docs/operations/policy-review-record.md` (6 row Decision == APPROVED + Reviewer/Date founder-only; FD-R4 bump v1→v2 trong commit founder); gate `policy-reviews` + mirror FD-R34 | FOUNDER | — |
| §9-09 | §9 Batch 8 gate: founding seller process ready | doc | `docs/operations/founding-seller-onboarding-checklist.md` + `docs/operations/concierge-onboarding-playbook.md` (invite cookie flow RR-21, §5.10 lifecycle FD-R48) + `docs/operations/model-seed-review-procedure.md`; Batch 7 console suites xanh | PASS | — |
| §9-10 | §9 Batch 8 gate: supply readiness approved | founder | §12.1-01..08 + **FD-R30** (phê duyệt broader buyer invitations là của founder — gate này chính là quyết định đó) | FOUNDER | — |
| SEC-01 | CSP Report-Only → enforce (Task 8 flip) | user-run | flip header `Content-Security-Policy-Report-Only` → `Content-Security-Policy` trong `next.config.ts` (một commit) — CHỈ SAU `npm run docker:smoke` + manual page-load trên stack deploy (RR-14: không E2E); findings register LOW OPEN row trỏ tới hàng này; `tests/unit/security-headers.test.ts` giữ hiệu lực per-path | FOUNDER | — |
| OPS-01 | Production restore drill (`--file` backup thật) | user-run | `bash scripts/restore-drill.sh --file backups/db-loaviet-<ts>.dump` TRÊN SERVER (`scripts/db-ops.sh` container-on-network; KHÔNG host pg tools); paste output dated (redacted) vào `docs/operations/restore-drill-evidence.md` — RPO/RTO thật từ lần này (FD-R36) | FOUNDER | — |
| OPS-02 | Production admin access review | user-run | `scripts/admin-access-review-prod.sh` (chạy trong image `migrate` trên compose network — host không có Node); paste dated vào `docs/operations/admin-access-review.md` + ký sign-off §4 (mọi admin không có MFA = finding) | FOUNDER | — |
| OPS-03 | Crontab installs (ops-alerts + backup) | user-run | `scripts/ops-alerts-cron.sh` (dòng crontab :12-13) + `docs/backup-restore.md` §1 (backup cron); KHÔNG install auto-release cron (xem OPS-04) | FOUNDER | — |
| OPS-04 | Auto-release cron KHÔNG được install trong private beta | user-run | `app/api/cron/auto-release/route.ts` trả 503 khi finance off — cron sẽ log fail mỗi giờ (corrections item 19); KHÔNG cài crontab finance `docs/runbook.md` §5 cho tới khi finance bật lại (plan riêng) | FOUNDER | — |
| OPS-05 | nginx HSTS + `limit_req` cấu hình | user-run | `Strict-Transport-Security` + `limit_req` ở nginx edge (`docs/deployment.md` §3 hiện CHƯA có — corrections item 24); app-level HSTS (`next.config.ts`) là HSTS duy nhất tới khi user cấu hình nginx | FOUNDER | — |
| OPS-11 | Secrets dedicated trong `.env` TRƯỚC lần `up -d --build` đầu tiên | user-run | `ADMIN_MFA_ENCRYPTION_KEY` + `PRODUCT_EVENT_PSEUDONYM_KEY` = `openssl rand -base64 32` mỗi key (base64 của ĐÚNG 32 byte, key DÀNH RIÊNG — KHÔNG derive từ `AUTH_SECRET`; thiếu key → compose từ chối start, `docker-compose.prod.yml:62,111,116`); ghi vào `.env` (`chmod 600`), KHÔNG bao giờ in giá trị thật ra terminal/log/evidence; `AUTH_SECRET`/`DB_PASSWORD`/`CRON_SECRET` theo `docs/deployment.md` §2 bước 2 | FOUNDER | — |
| OPS-12 | Backup production TRƯỚC migrate đầu tiên | user-run | `./scripts/db-ops.sh backup` (container-on-network, KHÔNG host pg tools — `docs/backup-restore.md` §1) TRƯỚC `docker compose -f docker-compose.prod.yml up -d --build`: lệnh up chạy service `migrate` TỰ ĐỘNG (app `depends_on` migrate — `docker-compose.prod.yml:3-5,99-103`) nên KHÔNG có backup tươi thì migration đầu tiên chạy vào DB chưa backup; file backup này dùng lại cho OPS-01 (drill `--file`) | FOUNDER | — |
| OPS-06 | Migrate production qua service `migrate` (graph) | user-run | `docker compose -f docker-compose.prod.yml up -d --build` chạy service `migrate` TỰ ĐỘNG tới ref `production` TRƯỚC khi app start; chạy tay khi cần: `docker compose -f docker-compose.prod.yml run --rm migrate` (idempotent — chạy lại không áp lại); graph 9 migration, head `20261008T1130_batch7_cohort_operations`, marker `656449ac…`, invariant `backfill-listing-approved-content-at`; KHÔNG `migration ref set` (wipes invariant); SAU OPS-12 (backup tươi) + OPS-11 (secrets) | FOUNDER | — |
| OPS-13 | Seed beta catalog BẮT BUỘC sau migrate (category `portable_bluetooth_speaker`) | user-run | dry-run: `docker compose -f docker-compose.prod.yml run --rm -v "$PWD/scripts:/app/scripts:ro" -v "$PWD/src:/app/src:ro" migrate npx tsx scripts/seed-beta-catalog.ts`; apply: cùng lệnh + `--apply --allow-production` (KHÔNG `--models` — `docs/deployment.md` §2 bước 5: category `portable_bluetooth_speaker` CHỈ được tạo qua script này, không admin action nào tạo Category; không seed → `/sell/new` không có danh mục, mọi seller bị chặn đăng tin); `--models /app/founder.json` CHỈ khi founder cung cấp file (FD-R16); SAU bước này chạy OPS-14 | FOUNDER | — |
| OPS-14 | Backfills location + search-text (BẮT BUỘC sau migrate/seed) | user-run | `backfill-listing-location.ts`: dry-run rồi `--apply --allow-production`; `backfill-listing-search-text.ts`: dry-run rồi `--apply --allow-production`; SAU MỌI lần seed (OPS-13) chạy thêm `backfill-listing-search-text.ts --apply --recompute-all --allow-production` (searchTextNormalized nhúng tên brand/model — trôi sau seed/rename/merge model); exact commands `docs/deployment.md` §2 bước 5b/5c (qua service migrate + mount `scripts/`+`src/`); không backfill → listing legacy `unresolved` + KHÔNG tìm được qua ô từ khóa | FOUNDER | — |
| OPS-07 | Demo seed `src/prisma/seed.ts` KHÔNG BAO GIỜ chạy vào production (B2 R15) | user-run | attestation của người deploy: seed dữ liệu MẪU (tài khoản demo `isVerifiedSeller`) KHÔNG chạy ở production (script tự từ chối `NODE_ENV=production` — `docs/deployment.md` §2 note); seed beta catalog (OPS-13) là BẮT BUỘC và KHÔNG phải demo seed; `seed-beta-catalog.ts --models` + `seed-search-aliases.ts --aliases` CHỈ chạy khi founder cung cấp danh sách + duyệt (FD-R16) | FOUNDER | — |
| OPS-08 | Uploads named volume `uploads` mount `/app/data/uploads` | user-run | `docker-compose.prod.yml` dùng NAMED VOLUME `uploads` (compose project-prefixed — `docker-compose.prod.yml:72,141,145`) mount `/app/data/uploads` trên CẢ app + migrate (app đọc qua `UPLOADS_DIR` default = cwd/data/uploads, `src/lib/uploads-storage.ts` — cwd=/app), KHÔNG phải bind mount `./data/uploads`; verify: `docker compose -f docker-compose.prod.yml config` (volume named) / `docker volume inspect <project>_uploads` + GET `/uploads/<key>` trả 200 sau deploy; KHÔNG "sửa" compose sang bind mount — mọi upload cũ trong named volume sẽ 404 | FOUNDER | — |
| OPS-09 | Grant `private_beta_buyer` memberships | user-run | `/admin/users?u=<id>` forms `setBetaMembershipAction` (self-grant forbidden; staff cần `internal` hoặc `private_beta_buyer` do admin KHÁC cấp — FD-R33); broader buyer invitations chỉ SAU §12.1 + FD-R30 | FOUNDER | — |
| OPS-10 | One-time re-login (B2 R1 — session cutover) | user-run | cutover JWT → DB sessions đăng xuất mọi user MỘT LẦN (RR-6, đã qua — Batch 2 verification doc); user xác nhận đã thông báo re-login cho người dùng beta | FOUNDER | — |

## 2. FD register mirror — mọi hàng Blocking=YES của `docs/operations/founder-decision-register.md`

> `tests/unit/release-gate-checklist.test.ts` derive blocking set
> mechanically từ `docs/operations/founder-decision-register.md` (73 hàng /
> 28 blocking — corrections §E) và assert bảng dưới chứa **đúng** các ID đó
> (không thừa, không thiếu). Mỗi hàng bắt đầu `PENDING`; founder điền
> **Decision** (resolution / explicit acceptance — FD-3) + **Date**. Gate
> không qua khi còn hàng chưa quyết. **Implementer/agent không điền ô
> Decision/Date** (spec §4.11).

| FD | Item | Decision (founder) | Date |
|---|---|---|---|
| FD-R1 | Provider OTP production (FD-2): tới khi có provider KHÔNG kênh nào verify được trong production → `/recover` không gửi được mã, invite acceptance cần kênh verified (FD-R69), seller kẹt `phone_verified` → không seller nào qua verification/publish được — LAUNCH BLOCKER | PENDING | — |
| FD-R2 | RBAC `Scoped`/`Exceptional + audited`/`Limited` cells (moderator/support/ops capabilities — fail-closed defaults ship) | PENDING | — |
| FD-R3 | Out-of-band (admin-assisted) account recovery identity proofing requirements (manual fallback cần founder acknowledgment) | PENDING | — |
| FD-R4 | Seller Rules review + version tension: bump `v1`→`v2` trong commit duyệt của founder (G3(d)) + row APPROVED trong `policy-review-record.md` | PENDING | — |
| FD-R6 | Moderation sanction policy (manual-only, indefinite until lifted; existing-conversation question = FD-R53) | PENDING | — |
| FD-R7 | Retention & deletion policy (moderation evidence, `ProductEvent`, `Deal`/`DealStatusHistory`; account-deletion interaction FD-R45) | PENDING | — |
| FD-R8 | Appeal decision workflow + listing restore (con đường un-`remove` duy nhất) + notification gap | PENDING | — |
| FD-R11 | Moderator conflict-of-interest / recusal policy (deny ships fail-closed) | PENDING | — |
| FD-R12 | Sanction-taxonomy reason vocabularies (founder-authored — PROVISIONAL (A8) markers) | PENDING | — |
| FD-R14 | Condition-grade user-facing definitions + `product_condition` vs `inventoryContext` overlap | PENDING | — |
| FD-R15 | Photo-checklist requiredness per slot/condition (8 guidance, ≥1 image rule) | PENDING | — |
| FD-R16 | Canonical model list — founder supplies + approves via `/admin/catalog` (implementer không soạn) | PENDING | — |
| FD-R17 | Orphaned upload retention/expiry (quota 60/24h, grace 7 ngày, RR-24) | PENDING | — |
| FD-R20 | Attribution/response window values (`listing_to_chat_v1`, `seller_response_rate_v1`, `successful_match_rate_v1`, `repeat_user_rate_v1`) | PENDING | — |
| FD-R21 | `successful_match` reconciliation rule cho mismatched bilateral outcomes | PENDING | — |
| FD-R23 | "Quality listing" definition (ops-set count — gates §12.1-04) | PENDING | — |
| FD-R24 | Alias catalog content (mechanism ships empty/founder-reviewed) | PENDING | — |
| FD-R28 | §6.4/§5.2 safety copy legal review (policy document `safety_guidance` awaits review) | PENDING | — |
| FD-R29 | Invitation delivery channel (out-of-band; platform delivery blocked tới FD-R1) | PENDING | — |
| FD-R30 | Buyer cohort acquisition approval (§12.1 gate — broader buyer invitations) | PENDING | — |
| FD-R33 | Buyer-side conversation gating default ON (`BETA_CHAT_REQUIRES_ACTIVE_MEMBERSHIP`, `BETA_CHAT_ALLOWED_COHORTS` incl. `internal`) — founder acknowledgment | PENDING | — |
| FD-R34 | Sáu policy texts (Terms, Privacy, Marketplace Rules, Seller Rules, Community Rules, Safety Guidance) — founder-authored, hash-recorded — CENTRAL LAUNCH BLOCKER | PENDING | — |
| FD-R48 | Batch 7 S9 provisional set (transition table, reason codes, rates 20/h + 10/10 min + 30/10 min/IP, cookie TTL 15 min, caps 4000/200, verified-channel binding reading) | PENDING | — |
| FD-R50 | Placeholder moderation copy (suspend/takedown notification wording, appeal-page copy, reason labels) | PENDING | — |
| FD-R59 | §12 critical-E2E: chấp nhận posture (action-level unit + real-DB integration, ký + ngày) HOẶC commission Playwright batch cho 2 flow | PENDING | — |
| FD-R62 | Seller-verification decision×reason-code compatibility map (PROVISIONAL) + `needs_review` semantics | PENDING | — |
| FD-R68 | PROVISIONAL product copy ngoài moderation (deal labels, D12 neutral CTA, buyer-gate copy, invite/console texts, form errors, notify labels, deal price note) | PENDING | — |
| FD-R69 | Verified-channel binding vs FD-2: production invite acceptance unreachable — quyết: đợi provider (FD-R1), hoặc token possession + out-of-band delivery, hoặc runbook §6 per-user (email-only; phone stall tới FD-R1) | PENDING | — |

## 3. Cách gate đọc file này

- `scripts/release-gate.sh` → gate `release-checklist`: **zero PENDING** ở cả
  hai bảng (bảng chính: cột Status; mirror: cột Decision); hàng **FOUNDER**
  chỉ qua với Sign-off không trống (ô placeholder `—`/`-`/`— (chờ founder)`/
  `chờ`/`pending` KHÔNG tính là đã ký); **mọi hàng mirror cần Decision ≠
  PENDING + Date không trống**.
- Gate pin **tập hàng founder/user-run bắt buộc** (các hàng Evidence type
  `founder`/`user-run`: §12-12/§12-13/§12-15, §12.1-02..06/08, §9-08/§9-10,
  SEC-01, OPS-01..14): hàng bị **xoá** hay **flip sang PASS** (không chữ ký)
  đều FAIL — không có đường nào làm gate xanh mà thiếu một chữ ký
  founder/user thật.
- Gate `policy-reviews` đối chiếu `scripts/policy-hash.ts --check` với
  `docs/operations/policy-review-record.md` (Decision == APPROVED + hash khớp
  + registry status REVIEWED) — chọn **row khớp key + version + hash mới
  nhất** (version bump = row MỚI, `policy-review-record.md` bước 5), ô
  Reviewer/Reviewed-at phải đã điền thật (placeholder `— (chờ founder)`
  không qua).
- Gate `evidence-files` yêu cầu mọi doc evidence tồn tại + findings register
  của security review không có hàng CRITICAL+OPEN (parse **theo cột**
  `| Severity | Status | … |` — không regex liền hàng).
- Gate `finance-off` re-check `FINANCIAL_FEATURES_ENABLED="false"` ×3 file.
- Gate chạy ĐẦY ĐỦ rồi tổng hợp (pattern `scripts/preflight.sh`) — exit ≠ 0
  khi có gate đỏ. **FAIL hiện tại là ĐÚNG** (policy DRAFT-NOT-REVIEWED + 28
  mirror PENDING + các hàng FOUNDER chưa ký): founder duyệt 6 policy
  (FD-R34, kèm FD-R4 bump), quyết mọi register item blocking, chạy + ký các
  hàng OPS/SEC — rồi gate xanh.
