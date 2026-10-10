# Private-beta security review (Batch 8 Task 8)

> **Phạm vi (spec §9 Batch 8 "security review" + §10.1 + §12 "no known critical
> security finding remains open"):** tổng hợp bảo mật trước launch — ma trận lạm
> dụng §10.1 machine-checked, dependency audit, headers §7.4, secrets/env, rate
> limits §7.1, các residual risk đã biết (Batch 2–7), tư thế CSRF, findings
> register. **Không re-implement** batch nào (G5) — mọi hàng ma trận map về test
> đã ship của Batches 1–7 + gap-fill của Batch 8.
>
> **Ngày thực thi:** 2026-10-08. **Base:** Wave 0 head `6aa6b66` (cây merge Batch
> 7 + early Batch 8 Tasks 1/2/5/6/7). **Machine-check:**
> `tests/unit/abuse-matrix.test.ts` (parse bảng §1 này — mọi evidence path phải
> resolve trên đĩa VÀ mọi marker `@key` phải xảy ra trong file được cite),
> `tests/unit/security-headers.test.ts` (§3), `tests/unit/chat-surface-xss.test.ts`
> (hàng 13/14). **Release gate (Task 9)** parse §Findings register dưới đây —
> thiếu section header = gate FAIL; hàng `CRITICAL` + `OPEN` = gate FAIL.
>
> **Ghi chú thực thi song song:** Tasks 3/4 (playbooks) chạy ở worktree khác —
> mọi evidence cell machine-checked chỉ cite file có mặt trong cây này; các
> playbook được nhắc ở dạng prose (RR-3 query sống trong seller-verification
> playbook của Task 3 — output dev-DB ghi ở §6).

## 1. Ma trận lạm dụng §10.1 — 29 hàng (machine-checked)

Mỗi hàng: abuse case (verbatim spec §10.1) → batch cover → evidence test (mỗi
item `` `path @key` `` — key là test title / typed error string PHẢI xảy ra
trong file được cite) → status. Corrections item 10 đã sửa các cell sai của plan
(Deal IDOR dùng `@DEAL_CONVERSATION_REQUIRED` cho deal-create vì file đó không
chứa `DEAL_FORBIDDEN`; moderation IDOR dùng `@APPEAL_NOT_AVAILABLE` cho
appeal-actions vì file đó không chứa `FORBIDDEN`; XSS-listing cite
admin-listings-page + chat-surface-xss thay vì sell-pages — file đó không có
assertion XSS; decompression bomb ở image-validate `@TOO_LARGE_DIMENSIONS`
không phải image-process; SVG rejection ở image-validate `@image/svg+xml`).
Mọi cell đã được re-verify bằng `git grep -c -- '<key>' <file>` ở 2026-10-08.

<!-- abuse-matrix-begin -->
| Abuse case (spec §10.1) | Covering batch | Evidence test | Status |
|---|---|---|---|
| Unauthorized listing edit | B4 | `tests/unit/listing-draft-actions.test.ts @IDOR` + `tests/unit/publication-gate.test.ts @ownership` | covered |
| Listing IDOR | B2/B4/B6 | `tests/unit/listing-draft-actions.test.ts @IDOR` + `tests/unit/publication-gate.test.ts @ownership` + `tests/unit/chat-hardening.test.ts @LISTING_NOT_AVAILABLE` | covered |
| Deal IDOR | B6 | `tests/unit/deal-outcome.test.ts @DEAL_FORBIDDEN` + `tests/unit/deal-create.test.ts @DEAL_CONVERSATION_REQUIRED` | covered |
| Moderation-resource IDOR | B3 | `tests/unit/moderation-actions.test.ts @FORBIDDEN` + `tests/unit/moderation-case-page.test.ts @notFound` + `tests/unit/appeal-actions.test.ts @APPEAL_NOT_AVAILABLE` | covered |
| Privilege escalation | B2 | `tests/unit/rbac.test.ts @matrix` | covered |
| Support → admin escalation | B2/B3 | `tests/unit/rbac.test.ts @matrix` + `tests/unit/moderation-actions.test.ts @FORBIDDEN` + `tests/unit/suspension-actions.test.ts @FORBIDDEN` | covered |
| OTP brute force | B2 | `tests/unit/otp.test.ts @OTP_MAX_ATTEMPTS` | covered |
| OTP resend flooding | B2 | `tests/unit/otp.test.ts @OTP_RESEND_COOLDOWN_SEC` | covered |
| Account enumeration | B2/B7 | `tests/unit/recovery-actions.test.ts @neutral` + `tests/unit/founding-seller-invite.test.ts @INVITE_INVALID` | covered |
| Session fixation | B2 | `tests/unit/session.test.ts @session fixation` | covered |
| Session reuse after recovery | B2 | `tests/unit/recovery-actions.test.ts @revoke` + `tests/unit/session.test.ts @revoked` | covered |
| CSRF state-changing action | posture + B8 | `docs/operations/private-beta-security-review.md @CSRF` | covered (framework posture, documented) |
| Stored XSS through listing | B4 + B8 | `tests/unit/admin-listings-page.test.ts @dangerouslySetInnerHTML` + `tests/unit/chat-surface-xss.test.ts @dangerouslySetInnerHTML` + `docs/operations/private-beta-batch4-listing-quality-verification.md @dangerouslySetInnerHTML` | covered |
| Stored XSS through chat | B6 + B8 | `tests/unit/chat-surface-xss.test.ts @dangerouslySetInnerHTML` + `tests/unit/deal-ui.test.ts @dangerouslySetInnerHTML` | covered |
| Stored XSS through report | B3 | `tests/unit/moderation-pages.test.ts @dangerouslySetInnerHTML` + `tests/unit/appeal-page.test.ts @dangerouslySetInnerHTML` | covered |
| Malicious image upload | B4 | `tests/unit/image-process.test.ts @polyglot` + `tests/unit/image-validate.test.ts @image/svg+xml` | covered |
| MIME spoof | B4 | `tests/unit/image-validate.test.ts @magic` + `tests/unit/upload-route.test.ts @MIME_NOT_ALLOWED` | covered |
| Image decompression bomb | B4 | `tests/unit/image-validate.test.ts @TOO_LARGE_DIMENSIONS` | covered |
| Blocked-user chat bypass | B3/B6 | `tests/unit/chat-guard.test.ts @CHAT_BLOCKED` + `tests/integration/block-enforcement.test.ts @CHAT_BLOCKED` + `tests/unit/deal-outcome.test.ts @CHAT_BLOCKED` | covered |
| Suspended-user publication bypass | B3/B4 | `tests/unit/publication-gate.test.ts @account_not_suspended` + `tests/integration/suspension-enforcement.test.ts @account_not_suspended` | covered |
| Revoked-seller publication bypass | B2/B4 | `tests/unit/publication-gate.test.ts @publication_requirements_unmet` + `tests/unit/seller-verification-policy.test.ts @revoked` | covered |
| Beta-cohort bypass | B2/B4/B7 | `tests/unit/seller-verification-policy.test.ts @membership` + `tests/unit/suspended-membership-enforcement.test.ts @SELLER_MEMBERSHIP_INACTIVE` + `tests/unit/founding-seller-invite.test.ts @INVITE_CHANNEL_MISMATCH` + `tests/unit/chat-beta-gate.test.ts @BETA_MEMBERSHIP_REQUIRED` + `tests/unit/deal-beta-gate.test.ts @BETA_MEMBERSHIP_REQUIRED` + `tests/unit/beta-access.test.ts @isActiveBetaParticipant` + `tests/integration/beta-access-enforcement.test.ts @private_beta_buyer` + `tests/integration/suspended-membership-enforcement.test.ts @setBetaMembershipAction` | covered |
| Concurrent seller-verification update | B2 | `tests/unit/seller-verification-actions.test.ts @VERIFICATION_ALREADY_REVIEWED` | covered |
| Concurrent Deal status update | B6 | `tests/unit/deal-outcome.test.ts @DEAL_FORBIDDEN` + `tests/integration/deal-lifecycle.test.ts @Promise.all` | covered |
| Financial direct route | B1 | `tests/unit/finance-public-surface.test.ts @notFound` | covered |
| Financial API mutation | B1 | `tests/unit/financial-shutdown-actions.test.ts @FINANCIAL_FEATURES_DISABLED` + `tests/unit/financial-shutdown-routes.test.ts @503` | covered |
| Financial webhook processing | B1 | `tests/unit/ipn-route.test.ts @503` | covered |
| Financial cron execution | B1 | `tests/unit/cron-auto-release-route.test.ts @503` | covered |
| Historical finance escape-hatch abuse | B1/B6 | `tests/unit/admin-finance-readonly.test.ts @read-only` + `tests/integration/escrow.test.ts @markEscrowPaid` + `tests/unit/deal-finance-isolation.test.ts @denylist` | covered |
<!-- abuse-matrix-end -->

**Ghi chú:**

- **Financial direct route** thêm được xác minh bởi `scripts/smoke.sh`
  (`npm run smoke` — finance denial + retired pages, chạy ở release gate Task 9)
  — script không phải test file nên không vào evidence cell (format violation
  theo hợp đồng parse).
- **Gap-fill Batch 8 sở hữu:** hàng 13/14 (`tests/unit/chat-surface-xss.test.ts`
  — chat + listing surfaces, sink ảnh `m.imageUrl` được phép VÀ ghim bằng route
  validation `LISTING_IMAGE_URL_PATTERN` trước `Message.create`), hàng 12
  (§CSRF posture — mục §CSRF dưới), policy/copy-safety (Task 1/2:
  `tests/unit/policy-registry.test.ts`, `tests/unit/copy-safety.test.ts`),
  headers (Task 8a: `tests/unit/security-headers.test.ts`), finance-boundary
  detection (Task 5: `tests/unit/ops-alerts.test.ts`).
- **Mọi suite được cite chạy green ở thời điểm thực thi** (full unit suite
  2026-10-08: 2437/2437 — 108 file, gồm 29 test Task 8 mới; integration
  279/279 — xem §6 và Task 10 verification doc).

## 2. Dependency audit

**Lệnh (2026-10-08, cây `6aa6b66`+Task 8):**

```text
$ npm audit --omit=dev
found 0 vulnerabilities
```

```text
$ npm audit
18 vulnerabilities (5 moderate, 13 high)
```

**Re-triage 18 findings (đầy đủ):** TẤT CẢ dev-toolchain transitive, KHÔNG có
findings nào trong dependency runtime của image production (stage runner chỉ
copy `.next/standalone` + static — KHÔNG copy `node_modules` stage deps).
**Ngoại lệ image (independent review 2026-10-08):** image `migrate`
(Dockerfile:30-38) copy nguyên vẹn `node_modules` từ stage deps (`npm install`
đầy đủ, gồm dev) nên CẢ 18 findings CÓ mặt trong filesystem của image mà
compose chạy against DB production (docker-compose.prod.yml:44). Khả năng
khai thác THẤP: `prisma db migrate` (Dockerfile:38) không serve HTTP (code
path hono server không chạy) và không chạm `lodash _.template`/`braces` —
code vulnerable có mặt trong image nhưng không được thực thi (ghi nhận ở
hàng dev-toolchain §Findings register):

| Chuỗi transitive | Gói có finding | Ngưỡng vào cây |
|---|---|---|
| prisma CLI (dev) → @prisma/composer-cli → alchemy → @prisma/dev | `@hono/node-server` (2 CVE — bypass serveStatic), `hono` (9 CVE — JSX/SSR XSS, CORS, path traversal), `valibot` | `prisma ^8.0.0-rc.19` (devDependency) |
| @mrleebo/prisma-ast → chevrotain | `lodash` (2 CVE — `_.template` code injection, prototype pollution) | cùng chuỗi prisma CLI |
| eslint-config-next → @next/eslint-plugin-next → fast-glob → micromatch | `braces` (1 CVE — stack-exhaustion DoS) | `eslint-config-next 16.3.8` (devDependency) |

Mọi `fixAvailable` đều **major/breaking** (`npm audit fix --force` sẽ install
`prisma@7.10.0` — downgrade phá Prisma 8 contract/migration). **Không áp dụng**
— chờ upstream (prisma 8 stable) rồi bump theo
`.agents/skills/prisma-8/references/upgrade-app.md`. `docs/runbook.md` §7
(triage 2026-10-05, 13 high/5 moderate) **vẫn chính xác về nội dung** — cùng
18 findings, cùng chuỗi, 0 runtime; chỉ khác ngày (corrections item 13 —
không edit runbook).

**Gate:** `npm audit --omit=dev` = 0 → **không có runtime critical/high** —
điều kiện §9 "no known critical security issue" THỎA về dependency (gate nói
về dependency RUNTIME của app; ngoại lệ image migrate — dev deps có mặt
trong image nhưng code path không thực thi — xem trên). Dev-toolchain
findings được ghi nhận ở §Findings register (LOW, ACCEPTED — không có đường
runtime).

**Pinned-deps inventory (corrections item 13):**

| Package | Version | Pin |
|---|---|---|
| next | 16.3.8 | **exact** (không caret) |
| eslint-config-next | 16.3.8 | **exact** |
| react / react-dom | 19.2.8 | **exact** |
| sharp | 0.35.5 | **exact** |
| otpauth | 9.5.2 | **exact** (Batch 2) |
| zod | ^4.6.5 | caret |
| @prisma/orm-postgres | ^8.0.0-rc.13 | **caret, không exact** — ghi nhận (corrections item 13); rc-track, bump theo upgrade-app.md khi stable |
| prisma (dev) | ^8.0.0-rc.19 | caret |
| bcryptjs / jose / lucide-react / clsx / tailwind-merge / dotenv | ^… | caret |

`package-lock.json` **được commit** (`git ls-files` → có) — install local/CI
qua `npm ci` (`.github/workflows/ci.yml:20`); **Docker deps stage dùng
`npm install --no-audit --no-fund`, KHÔNG phải `npm ci`** (Dockerfile:13 —
chủ ý tương thích npm 10/12, xem comment Dockerfile:12; `npm install` resolve
theo lockfile khi package.json đồng bộ nhưng KHÔNG có bảo đảm immutable như
`npm ci` — claim "mọi install qua npm ci" của bản trước sai, sửa theo
independent review). Lockfile vẫn khoá transitive (kể cả các gói có finding
dev — không drift lên bản CVE mới hơn khi lockfile được tôn trọng). Batch 8
thêm **0 package** (G2/G3 — package.json chỉ đổi ở Task 9, một script entry).

## 3. §7.4 Browser-security headers (B1/B2)

**Audit trước Task 8a:** `next.config.ts` CHỈ có Batch 4 `/uploads/:path*`
(nosniff + CSP `default-src 'none'; sandbox`) và Batch 7 `/invite/:token`
(`Referrer-Policy: no-referrer`) + `/invite` (`X-Robots-Tag: noindex`) —
**KHÔNG có header app-wide nào** (khoảng trống đã biết — G3(b)). Mọi route app
chạy KHÔNG nosniff / KHÔNG HSTS / KHÔNG frame protection / KHÔNG CSP.

**Fix đã ship (Task 8a, commit `ec94bb3`):** entry app-wide **ĐỨNG ĐẦU mảng**
`headers()` với source `"/((?!uploads/).*)"` — Next headers() **last-match-wins**
(`node_modules/next/dist/docs/01-app/03-api-reference/05-config/
01-next-config-js/headers.md:47`): entry sau thắng entry trước trên cùng key,
nên app-wide PHẢI đứng trước để Batch 4/7 (theo sau, nguyên vẹn) giữ key của
mình — đảo thứ tự sẽ mở lại RR-21 (app-wide `Referrer-Policy` đè `no-referrer`
của `/invite/<token>`).

Header app-wide (mọi path trừ `/uploads/*`):

| Header | Giá trị | Ghi chú |
|---|---|---|
| `Content-Security-Policy-Report-Only` | `default-src 'self'; script-src 'self' 'unsafe-inline'['unsafe-eval' chỉ dev]; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: https://res.cloudinary.com; font-src 'self'; worker-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'self'; object-src 'none'` | guide "Without Nonces" đã cài (`node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md`); `img-src` khớp `images.remotePatterns`; `worker-src` cho `public/sw.js` (`src/components/sw-register.tsx`); `connect-src 'self'` (chat poll same-origin `/api/chat/[id]`) |
| `X-Content-Type-Options` | `nosniff` | enforce ngay |
| `Strict-transport-Security` | `max-age=15552000; includeSubDomains` | 180 ngày, **KHÔNG `preload`** (founder decision — preload là one-way door cả domain) |
| `X-Frame-Options` | `DENY` | enforce ngay (song song `frame-ancestors 'none'` trong CSP) |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | app-wide; Batch 7 `/invite/:token` giữ `no-referrer` (thắng nhờ thứ tự) |

**Lựa chọn ghi nhận:** KHÔNG `upgrade-insecure-requests` — deploy production
chạy sau nginx TLS, mọi subresource đều `'self'`/`data:`/`blob:`/cloudinary
(https); thêm directive này không thay đổi gì ở production và có thể gây
nhầm lẫn khi debug local http. Ghi nhận để founder có thể thêm ở lần flip.

**Hiệu lực theo path (machine-checked — `tests/unit/security-headers.test.ts`
tính header HIỆU DỤNG bằng cách iterate toàn bộ mảng với last-match-wins):**

- `/uploads/x` → CHỈ CSP sandbox của Batch 4 + nosniff — KHÔNG Report-Only
  (source app-wide loại trừ `/uploads` — Report-Only là key khác, `/uploads`
  sẽ nhận CẢ HAI nếu không loại);
- `/invite/<token>` → `Referrer-Policy: no-referrer` + `X-Robots-Tag: noindex`;
- `/invite` (tokenless) → `strict-origin-when-cross-origin`, KHÔNG
  `no-referrer` (corrections #8 — `no-referrer` trên `/invite` làm browser gửi
  `Origin: null` trên action POST cùng origin → Next CSRF check reject);
- mọi path app (`/listings/…`, `/policies/…`, `/admin/…`) → đủ bộ app-wide.

**Nonce-based CSP: NGOÀI phạm vi** — cần `proxy.ts` + dynamic rendering
(G3; `/policies/[key]` là static với `generateStaticParams`). Ghi nhận là
lựa chọn hardening post-beta (guide "Subresource Integrity" cũng là experimental).

**Enforcement flip (release-checklist row — Task 9):** CSP ship
**Report-Only**. Sau `npm run docker:smoke` + manual page-load trên stack đã
deploy (RR-14 — không có E2E), OPERATOR đổi tên header
`Content-Security-Policy-Report-Only` → `Content-Security-Policy` trong
`next.config.ts` (một dòng) — KHÔNG phải commit của Batch 8. Trước khi flip:
đọc report endpoint (`Content-Security-Policy-Report-Only` không có
`report-uri` — browser console là nguồn đọc report khi devtools mở).

**HSTS / nginx (corrections item 24):** block nginx hiện tại
(`docs/deployment.md` §3) **KHÔNG có HSTS và không có `limit_req`** — header
app-level ở trên là HSTS DUY NHẤT cho tới khi operator cấu hình nginx. Release
checklist mang row: "nginx `Strict-Transport-Security` + `limit_req` configured
(user)". KHÔNG edit deployment docs trong Batch 8.

## 4. Secrets / env review

**`.env.example` ↔ `src/lib/env.ts` parity (mọi key bắt buộc có cả doc + validation):**

| Key | `.env.example` | `validateEnv` (src/lib/env.ts) |
|---|---|---|
| `DATABASE_URL` | :3 | prefix `postgresql://`/`postgres://` (mọi môi trường) |
| `AUTH_SECRET` | :7 | ≥ 32 ký tự |
| `NEXT_PUBLIC_APP_URL` | :30 | URL http(s) hợp lệ (prod) |
| `CRON_SECRET` | :60 | ≥ 16 ký tự (prod) |
| `ADMIN_MFA_ENCRYPTION_KEY` | :14 | base64 của ĐÚNG 32 byte (`isValidAdminMfaKeyEnv` — Batch 2) |
| `PRODUCT_EVENT_PSEUDONYM_KEY` | :25 | base64 của ĐÚNG 32 byte (`isValidProductEventKeyEnv` — Batch 5) |
| `TRUST_PROXY_HEADERS` | :36 | chỉ nhận `"true"` hoặc `"false"` |
| `FINANCIAL_FEATURES_ENABLED` | :46 | strict `"true"` hoặc `"false"`; **prod = `"true"` là lỗi fail-fast** |
| `ESCROW_AUTO_RELEASE_DAYS` | :50 | nguyên 1–30 |
| MoMo (3 key) | :71-74 | all-or-nothing (thiếu 1/3 → issue từng key) |

Fail-fast: production thiếu/sai key → `instrumentation.ts` `process.exit(1)`
TRƯỚC khi nhận request (chỉ in TÊN key + lý do, không in giá trị).

**Repo scan — committed secrets (2026-10-08):** HAI LỚP — (1) file-name scan
theo tên file nhạy cảm, (2) content scan theo key-shape trên NỘI DUNG toàn bộ
file đang track (secret dán vào `.ts`/`.md`/`.yml` cũng bị bắt, không chỉ tên
file — independent review 2026-10-08):

```text
$ git ls-files | grep -E '\.env$|\.pem$|secret'
(0 kết quả — exit 1)
```

```text
$ git ls-files -z | xargs -0 rg -n --no-heading --color=never \
  -e '-----BEGIN [A-Z ]*PRIVATE KEY( BLOCK)?-----' \
  -e 'AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}' \
  -e 'AIza[0-9A-Za-z_-]{35}' \
  -e '(sk|rk)_live_[0-9a-zA-Z]{20,}' \
  -e 'gh[pousr]_[0-9A-Za-z]{36}' \
  -e 'xox[baprs]-[0-9A-Za-z-]{10,}' \
  -e 'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}' \
  -e 'postgres(ql)?://[^/:@[:space:]]+:[^/@[:space:]]+@' \
  -e '(?i)[A-Z0-9_]*(SECRET|KEY)[A-Z0-9_]*["'\'']?\s*[:=]\s*["'\'']?[0-9a-fA-F]{32,}["'\'']?' \
  -e '(?i)[A-Z0-9_]*(SECRET|KEY)[A-Z0-9_]*["'\'']?\s*[:=]\s*["'\'']?[A-Za-z0-9+/]{40,}={0,2}["'\'']?'
(41 dòng — exit 0; MỌI hit đều là shape postgres URL, xem phân loại dưới)
.agents/skills/prisma-8/references/feedback.md:226:2. **Pasting `DATABASE_URL` or other secrets into the body.** `redact` aggressively. Replace with `postgresql://USER:PASS@HOST/DB` placeholders.
.claude/skills/prisma-8/references/feedback.md:226:2. **Pasting `DATABASE_URL` or other secrets into the body.** `redact` aggressively. Replace with `postgresql://USER:PASS@HOST/DB` placeholders.
.cursor/skills/prisma-8/references/feedback.md:226:2. **Pasting `DATABASE_URL` or other secrets into the body.** `redact` aggressively. Replace with `postgresql://USER:PASS@HOST/DB` placeholders.
.github/workflows/ci.yml:46:          DATABASE_URL: postgresql://placeholder:placeholder@localhost:5432/placeholder
.devin/skills/prisma-8/references/feedback.md:226:2. **Pasting `DATABASE_URL` or other secrets into the body.** `redact` aggressively. Replace with `postgresql://USER:PASS@HOST/DB` placeholders.
.env.example:3:DATABASE_URL="postgresql://speaker:choose-a-dev-password@localhost:5435/speaker_platform?schema=public"
docker-compose.prod.yml:53:      DATABASE_URL: postgresql://loaviet:${DB_PASSWORD}@db:5432/loaviet
docker-compose.prod.yml:105:      DATABASE_URL: postgresql://loaviet:${DB_PASSWORD}@db:5432/loaviet
Dockerfile:20:ENV DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder"
docs/operations/private-beta-batch4-listing-quality-verification.md:132:$ DATABASE_URL=postgresql://speaker:…@localhost:5435/speaker_platform npx tsx scripts/seed-beta-catalog.ts
prisma-8.md:69:DATABASE_URL="postgresql://user:password@localhost:5432/mydb"
scripts/restore-drill.sh:286:        export DATABASE_URL="postgresql://$OPS_DB_USER:$DB_PASSWORD_RESOLVED@$OPS_DB_CONTAINER:5432/$VERIFY_DB"
scripts/restore-drill.sh:365:DB_URL="postgresql://$SCRATCH_USER:$DB_PASS@127.0.0.1:$PORT/$SCRATCH_DB"
scripts/restore-drill.sh:366:RESTORED_HOST_URL="postgresql://$SCRATCH_USER:$DB_PASS@127.0.0.1:$PORT/$RESTORED_NAME"
scripts/preflight.sh:46:  DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder" \
tests/unit/cleanup-uploads.test.ts:110:  vi.stubEnv("DATABASE_URL", "postgresql://test:test@localhost:5432/test");
scripts/test-integration.sh:36:DB_URL="postgresql://speaker:$DB_PASS@127.0.0.1:$PORT/$DB_NAME"
tests/unit/seed-beta-catalog-guard.test.ts:19:    expect(isLocalSeedTarget("postgresql://u:p@localhost:5432/loaviet")).toBe(true);
tests/unit/seed-beta-catalog-guard.test.ts:20:    expect(isLocalSeedTarget("postgresql://u:p@127.0.0.1:5432/loaviet")).toBe(true);
tests/unit/seed-beta-catalog-guard.test.ts:21:    expect(isLocalSeedTarget("postgresql://u:p@[::1]:5432/loaviet")).toBe(true);
tests/unit/seed-beta-catalog-guard.test.ts:25:    expect(isLocalSeedTarget("postgresql://loaviet:pw@db:5432/loaviet")).toBe(false);
tests/unit/seed-beta-catalog-guard.test.ts:26:    expect(isLocalSeedTarget("postgresql://u:p@10.0.0.5:5432/loaviet")).toBe(false);
tests/unit/seed-beta-catalog-guard.test.ts:27:    expect(isLocalSeedTarget("postgresql://u:p@loaviet.internal:5432/loaviet")).toBe(false);
tests/unit/seed-beta-catalog-guard.test.ts:38:    vi.stubEnv("DATABASE_URL", "postgresql://loaviet:pw@db:5432/loaviet");
tests/unit/seed-beta-catalog-guard.test.ts:49:    vi.stubEnv("DATABASE_URL", "postgresql://u:p@127.0.0.1:1/scratch");
tests/unit/seed-beta-catalog-guard.test.ts:74:    vi.stubEnv("DATABASE_URL", "postgresql://u:p@127.0.0.1:1/scratch");
tests/unit/seed-beta-catalog-guard.test.ts:85:    vi.stubEnv("DATABASE_URL", "postgresql://u:p@127.0.0.1:1/scratch");
tests/unit/seed-beta-catalog-guard.test.ts:91:    vi.stubEnv("DATABASE_URL", "postgresql://u:p@127.0.0.1:1/scratch");
scripts/smoke.sh:55:DB_URL="postgresql://speaker:$DB_PASS@127.0.0.1:$DB_PORT/$DB_NAME"
scripts/smoke.sh:65:  DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder" \
tests/unit/backfill-listing-location.test.ts:122:  vi.stubEnv("DATABASE_URL", "postgresql://speaker:pw@127.0.0.1:5435/speaker_platform");
tests/unit/backfill-listing-location.test.ts:142:    vi.stubEnv("DATABASE_URL", "postgresql://loaviet:pw@db:5432/loaviet");
tests/unit/backfill-listing-location.test.ts:162:    vi.stubEnv("DATABASE_URL", "postgresql://loaviet:pw@db:5432/loaviet");
tests/unit/backfill-listing-location.test.ts:175:    vi.stubEnv("DATABASE_URL", "postgresql://loaviet:pw@db:5432/loaviet");
tests/unit/env.test.ts:25:    DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
tests/unit/search-resolve.test.ts:441:    vi.stubEnv("DATABASE_URL", "postgresql://u:p@127.0.0.1:5432/scratch");
tests/unit/search-resolve.test.ts:585:    vi.stubEnv("DATABASE_URL", "postgresql://loaviet:pw@db:5432/loaviet");
tests/docker/docker-compose.smoke.yml:38:      DATABASE_URL: postgresql://loaviet:${DB_PASSWORD}@db:5432/loaviet
tests/docker/docker-compose.smoke.yml:53:      DATABASE_URL: postgresql://loaviet:${DB_PASSWORD}@db:5432/loaviet
tests/integration/listing-search-text.test.ts:329:    vi.stubEnv("DATABASE_URL", "postgresql://loaviet:pw@db:5432/loaviet");
tests/integration/listing-search-text.test.ts:347:    vi.stubEnv("DATABASE_URL", "postgresql://loaviet:pw@db:5432/loaviet");
```

**Phân loại 41 hit — KHÔNG có secret thật (0 real):**

- **11 placeholder/example** trong config template + docs:
  `placeholder:placeholder` (Dockerfile:20, .github/workflows/ci.yml:46,
  scripts/preflight.sh:46, scripts/smoke.sh:65), `choose-a-dev-password`
  (.env.example:3), `user:password` (prisma-8.md:69), `USER:PASS@HOST/DB`
  (4 bản skill reference .agents/.claude/.cursor/.devin
  skills/prisma-8/references/feedback.md:226), `speaker:…` đã redact
  (docs/operations/private-beta-batch4-listing-quality-verification.md:132);
- **9 interpolation** — KHÔNG có password literal: `${DB_PASSWORD}`
  (docker-compose.prod.yml:53/105, tests/docker/docker-compose.smoke.yml:38/53),
  `$DB_PASS`/`$DB_PASSWORD_RESOLVED` (scripts/restore-drill.sh:286/365/366,
  scripts/test-integration.sh:36, scripts/smoke.sh:55);
- **21 test fixture** — credential giả trong test (`u:p`/`pw`/`test:test`/
  `user:pass`): tests/unit/seed-beta-catalog-guard.test.ts (11 hit),
  tests/unit/backfill-listing-location.test.ts (4 hit),
  tests/unit/cleanup-uploads.test.ts:110, tests/unit/env.test.ts:25,
  tests/unit/search-resolve.test.ts:441/585,
  tests/integration/listing-search-text.test.ts:329/347;
- **0 hit** cho private key (PEM/PGP), AWS (`AKIA`/`ASIA`), GCP (`AIza`),
  Stripe (`sk_live`/`rk_live`), GitHub (`ghp_`…), Slack (`xox*`), JWT
  (`eyJ…`), hex/base64 ≥32 ký tự gán `*_SECRET`/`*_KEY`.

**`.env` không track:** `.gitignore:38` `.env*` + `:49` `.env` — worktree
không có `.env` (dev DB reach qua `docker exec`, không cần file).

**Compose fail-fast interpolation (docker-compose.prod.yml):**
`${DB_PASSWORD:?…}` (:25), `${ADMIN_MFA_ENCRYPTION_KEY:?…}` (:62, :111),
`${AUTH_SECRET:?…}` (:63, :106) — compose từ chối start khi thiếu.

**`FINANCIAL_FEATURES_ENABLED=false` re-scan (2026-10-08):**

```text
.env.example:46:FINANCIAL_FEATURES_ENABLED="false"
docker-compose.prod.yml:123:      FINANCIAL_FEATURES_ENABLED: "false"
tests/docker/docker-compose.smoke.yml:66:      FINANCIAL_FEATURES_ENABLED: "false"
```

Batch 1 invariant giữ nguyên (cũng là gate `finance-off` của Task 9 — grep cả
ba file).

## 5. §7.1 Rate-limit inventory

Limiter: `src/lib/rate-limit.ts` — **in-memory, sliding window, single-instance**
(RR-1: restart reset bucket, không chia sẻ giữa instance, bucket CGNAT
shared-IP đếm chung — topology 1 container app trên 1 VPS là đúng; scale-out
cần limiter dùng chung Redis/Postgres). IP từ proxy header CHỈ tin khi
`TRUST_PROXY_HEADERS=true` (mặc định TẮT — client tự đặt được header; tắt thì
mọi client chung bucket `local`, chặt hơn). Fail-open: limiter lỗi nội bộ →
cho qua + log.

| Endpoint (spec §7.1) | Implementation (file + rule) | Covering test |
|---|---|---|
| login | `src/lib/actions/auth.ts` — `AUTH_RULE` 10/10 phút `${scope}:${ip}`; MFA `MFA_ATTEMPT_RULE` 10/10 phút per-IP (`auth:mfa:ip`) + per-account (`auth:mfa:user`) | `tests/unit/admin-mfa-login.test.ts @RATE_LIMITED` |
| verification (OTP/step-up) | `src/lib/actions/verification.ts` — `OTP_REQUEST_PER_USER_RULE` 5/10 phút + `OTP_REQUEST_PER_IP_RULE` 20/10 phút; `STEP_UP_RULE` 10/10 phút per-user + per-IP | `tests/unit/verification-actions.test.ts @OTP request rate limit` |
| OTP request (per-target) | `src/lib/otp.ts` — `OTP_PER_TARGET_RULE` 3 mã/10 phút/(userId,purpose,target) + cooldown 60s | `tests/unit/otp.test.ts @OTP_RESEND_COOLDOWN_SEC` |
| OTP verify | `src/lib/otp.ts` — `OTP_MAX_ATTEMPTS` 5 sai/bucket, fail-closed sau khi chạm | `tests/unit/otp.test.ts @OTP_MAX_ATTEMPTS` |
| password recovery | `src/lib/actions/recovery.ts` — `RECOVERY_REQUEST_RULE` 5/10 phút/IP; `RECOVERY_CONFIRM_RULE` 10/10 phút/IP + `RECOVERY_CONFIRM_PER_IDENTIFIER_RULE` 5/10 phút/identifier | `tests/unit/recovery-actions.test.ts @rate limit` |
| account recovery (§7.7) | **KHÔNG có HTTP surface** — out-of-band là block psql hai người có audit của runbook §6 (`docs/operations/admin-bootstrap-recovery-runbook.md`) — không cần limiter (không phải endpoint) | `tests/integration/admin-bootstrap.test.ts` (cơ chế audit) |
| report | `src/lib/actions/reports.ts` — `REPORT_RATE_LIMIT` 5/10 phút/user | `tests/unit/report-actions.test.ts @RATE_LIMITED` |
| chat | `src/lib/actions/chat.ts` — `CONVERSATION_START_RATE` 20/10 phút/user; route `chat:send` `CHAT_SEND_RATE_LIMIT` 30/phút/user; `chat:poll` 120/phút/IP | `tests/unit/chat-hardening.test.ts @RATE_LIMITED` |
| image upload | `app/api/upload/route.ts` — IP 20/10 phút + per-user 20/10 phút + **quota 60/24h** (`UPLOAD_DAILY_MAX`, đếm `ListingImageUpload`) | `tests/unit/upload-route.test.ts @UPLOAD_QUOTA` |
| search | `src/lib/search-telemetry.ts` — `SEARCH_RATE` 60/60s | `tests/unit/search-telemetry.test.ts @SEARCH_RATE` |
| listing mutation | `src/lib/listing-schema.ts` — `LISTING_MUTATION_RATE` 20/h (create/draft/submit), `LISTING_EDIT_RATE` 60/h (mutation) | `tests/unit/listing-draft-actions.test.ts @RATE_LIMITED` |
| Deal mutation | `src/lib/deal-vocab.ts` — `DEAL_MUTATION_RATE` 20/h/user | `tests/unit/deal-domain.test.ts @DEAL_MUTATION_RATE` |
| beta invite acceptance | `src/lib/founding-seller-vocab.ts` — landing `BETA_INVITE_LANDING_RATE` 30/10 phút/IP; accept `BETA_INVITE_ACCEPT_RATE` 10/10 phút/user + per-IP; issue `FOUNDING_SELLER_INVITE_RATE` 20/h/admin | `tests/unit/founding-sellers.test.ts @BETA_INVITE_ACCEPT_RATE` |
| (ngoài spec) block/unblock | `src/lib/moderation-vocab.ts` — `BLOCK_ACTION_RATE_LIMIT` 20/phút/user | `tests/unit/block-actions.test.ts @BLOCK_ACTION_RATE_LIMIT` |

**Edge layer:** nginx `limit_req` là lớp bù cho RR-1/RR-20 (restart reset,
single-instance) — **chưa cấu hình** trong block nginx hiện tại (corrections
item 24) → release-checklist row "nginx `limit_req` configured (user)".

**Endpoint thiếu limit — findings (ghi nhận, không sửa trong Batch 8 — G3/G5):**

- `src/lib/actions/seller-verification.ts` (`declareSellerProfileAction`,
  `submitSellerVerificationAction`) — KHÔNG có rate limit (surface đã đăng
  nhập; declaration submit là form một-lần, review là admin step-up) →
  §Findings register;
- `src/lib/actions/appeals.ts` (`recordAppealAction`) — KHÔNG có limit
  (B3 R5, accepted — intake thủ công, moderation queue là chặn);
- mọi giá trị trên là **PROVISIONAL** (FD-R65 — founder tune).

## 6. Residual risks đã xác minh (RR register update)

Các rủi ro đã chấp nhận của Batches 2–7, re-verify với output ghi lại
(2026-10-08). **RR register đầy đủ** = các hàng này + các hàng mới
RR-24…RR-32 (corrections §F) + FD register (Task 9
`docs/operations/founder-decision-register.md`).

### 6.1 Re-verify với output

- **RR-1 (in-memory limiter single-instance):** giữ nguyên — header
  `src/lib/rate-limit.ts:7-14` tự ghi nhận; compensating control: 1-instance
  compose + nginx `limit_req` (checklist row). Xem §5.
- **RR-2 (TOTP replay trong cửa sổ ±60s, không có durable consumed column):**
  giữ nguyên — `lastUsedTotpStep` in-process (`src/lib/admin-mfa.ts`), single
  instance; compensating: 30s period ±1 window, step-up freshness 15 phút,
  `MFA_ATTEMPT_RULE` 10/10 phút per-IP + per-account, recovery-code use
  audited, TLS-only. **Durable column = migration mới — ghi nhận ở
  §Findings register, KHÔNG làm trong Batch 8 (G2).**
- **RR-3 (phone-verify race — không có partial unique index trên phone đã
  verify):** query ops duplicate-phone chạy trên dev DB (SQL sống trong
  seller-verification playbook — Task 3, worktree song song; corrections
  item 6):

  ```text
  $ docker exec speaker-postgres psql -U speaker -d speaker_platform -tAc \
      'SELECT count(*) AS dup_groups, coalesce(sum(n),0) AS accounts FROM \
       (SELECT count(*) n FROM "User" WHERE "phoneVerifiedAt" IS NOT NULL \
        AND phone IS NOT NULL GROUP BY phone HAVING count(*) > 1) d;'
  0|0
  $ docker exec speaker-postgres psql -U speaker -d speaker_platform -tAc \
      'SELECT array_agg(id) FROM "User" WHERE "phoneVerifiedAt" IS NOT NULL \
       GROUP BY phone HAVING count(*) > 1;'
  (0 rows)
  ```

  Dev DB sạch (0 nhóm trùng). **Production pre-launch: operator chạy cùng
  query** (release-checklist row — seller-verification playbook). Partial
  unique index = migration mới (G2 — không làm).
- **RR-4 (login-vs-reset race):** giữ nguyên — recovery revoke TOÀN BỘ session
  khi hoàn tất; password cũ vô hiệu ngay sau reset; cửa sổ mili-giây; audit
  trail. Accepted (Batch 2 review instruction).
- **RR-5 (PROVINCE_CODES 63→34):** **RESOLVED + verified** —
  `src/lib/provinces.ts` có ĐÚNG 34 đơn vị (grep `code: "` → 34; 11 không sắp
  xếp + 23 hợp nhất, FD-1/NQ 202/2025/QH15). Scan `PROVINCE_CODES` (2026-10-08):

  ```text
  3 src/components/founding-seller-console.tsx   (display console)
  5 src/lib/actions/listings.ts                 (validate + deriveCity)
  1 src/lib/constants.ts                        (comment filter exact-match)
  3 src/lib/location.ts                         (comment tham chiếu)
  1 src/lib/provinces.ts                        (định nghĩa 34-unit map)
  2 src/lib/seller-verification-policy.ts      (yêu cầu mã 34 đơn vị)
  ```

  Mọi hit là map 34-unit chính đáng — **KHÔNG có di tích 63-unit** (tên tỉnh
  pre-2025 dùng làm code). `tests/unit/provinces.test.ts` green (20/20).
  **FD-R64:** legacy name `"Thừa Thiên Huế"` thiếu trong `legacyNames` của
  `hue` → các row đó resolve `unresolved` (fail-closed) — founder bổ sung.
- **RR-19 (dev OTP inbox route chết ở production):** re-run Batch 2 test —
  `tests/unit/verification-delivery.test.ts` green (route
  `/api/dev/otp-inbox` trả 404 ở production TRƯỚC khi chạm inbox;
  `DEV_OTP_INBOX_UNAVAILABLE` typed). Route tồn tại nhưng chết theo cấu
  trúc — giữ nguyên.
- **RR-21 (invite token trong URL):** contained — HttpOnly `sp_invite` cookie
  mang token tiếp (accept action chỉ đọc cookie), `Referrer-Policy:
  no-referrer` trên `/invite/:token` (Batch 7 + được bảo vệ thứ tự bởi Task 8a
  — §3), single-use atomic claim, token 256-bit không đoán được. Founder
  acknowledgment = FD-R49.
- **RR-22 (wishlist rows trên listing không-approved):** **CLOSED**
  (corrections §F) — `toggleWishlistAction` approved-only + `/wishlist` redact
  row không công khai (`tests/unit/wishlist-actions.test.ts`,
  `tests/unit/wishlist-page.test.ts`; B6 verification §4). Giữ hàng, đánh
  CLOSED kèm evidence.
- **RR-23 (quên `markSold`):** giữ nguyên — outcome immutable (D3), không
  auto-sold (D6); dashboard + console cho ops follow-up. FD-R27 decision
  pending.

### 6.2 Hàng mới (corrections §F — tất cả non-blocking, control bù trong ngoặc)

| # | Risk | Control bù |
|---|---|---|
| RR-24 | `scripts/cleanup-uploads.ts --apply` sẽ xoá upload chỉ được tham chiếu bởi `Message.imageUrl` (B6 R6) | Không có đường sống tạo row đó: POST route validate + `ChatWindow` không gửi imageUrl |
| RR-25 | Batch 7 lifecycle action ghi CAS update rồi audit post-commit — lỗi DB có thể mất hàng audit (B7 R4) | Write vẫn CAS-safe; fix = plan mới (auditEventTx trong tx) |
| RR-26 | Dedup contact candidate cấp-app có thể race (B7 R5) | Console hiển thị cả hai row |
| RR-27 | Funnel status có thể trễ giữa các sync (B7 R3) | Operator sync; các gate đọc membership FRESH |
| RR-28 | `uploadBodiesInFlight` là bound body process-local (B4 §6 #5) | Single instance |
| RR-29 | Per-identifier OTP confirm-bucket DoS (B2 R12) | Fail-closed, tự lành sau 10 phút |
| RR-30 | Pseudonymity ≠ anonymity; user erasure cần recompute theo key-version (B5 R4 → FD-R7) | `pseudonymKeyVersion` ghi mỗi row |
| RR-31 | Build warning `instrumentation.ts:27` `process.exit` trong Edge runtime (B2 R19 — vẫn còn) | Không ảnh hưởng runtime đã deploy; ghi nhận |
| RR-32 | Console query density ở ~300 candidates (B7 R8) | Beta scale chấp nhận; polish = plan mới |

### 6.3 Hand-off "Batch 8 polish" KHÔNG thực thi trong Batch 8 (corrections item 12 — mỗi cái cần edit src/app ngoài G3 hoặc migration)

- B7 R4 (unify lifecycle audit vào tx) → RR-25;
- B7 R8/R10 (console polish) → RR-32 + deferred;
- B2 R5 (durable TOTP consumed column) → RR-2 (migration mới);
- B2 R2 (partial unique index phone verified) → RR-3 (migration mới);
- B3 §8.3 / B4 §9.3 (finance re-enable hardening) → RR-9 family — chỉ relevant
  khi finance bật lại (§13/§17 evidence-driven);
- B4 open residual 6 (dead banner `lastIntent && state.ok` trong
  `PortableListingForm`) → deferred minor (cleanup ở lần chạm form kế).

### 6.4 RR-9 refresh (corrections item 26)

Dormant finance paths ghi `Listing.status = "approved"` không qua publication
gate: `src/lib/actions/admin.ts:399` (`resolveDisputeAction` — dispute resolved
trả tin về đang bán) và `src/lib/actions/orders.ts:544` (dispute/cancel →
approved). Cả hai sau `assertFinancialFeaturesEnabled()` — **unreachable khi
`FINANCIAL_FEATURES_ENABLED=false`** (Batch 1 boundary + tests); defense-in-depth
cho lần finance re-enable review. Thêm từ corrections item 15:
`src/lib/actions/reviews.ts:24` (`submitReviewAction` ghi `Review` không có
finance guard — dormant: cần Order completed, không thể có khi finance off) →
§Findings register (LOW).

## CSRF — tư thế chống giả mạo yêu cầu xuyên site (posture)

**Posture (hàng 12 ma trận — `covered (framework posture, documented)`):**

- **Next.js 16 Server Actions là POST-only + có CSRF check built-in** —
  `node_modules/next/dist/docs/01-app/02-guides/server-actions.md:82`:
  *"**CSRF check.** The request's `Origin` is compared to the `Host` (or
  `X-Forwarded-Host`). Mismatches are rejected."* Mọi state-changing action
  của repo (`"use server"` — Batches 2–7) đi qua cơ chế này;
- `next` **exact-pinned 16.3.8** (§2) — không thể drift lên bản có hành vi
  khác;
- **KHÔNG có custom token layer** — nhất quán với toàn bộ Batches 2–7 (không
  batch nào thêm token; thêm layer = surface mới, plan mới);
- Route handlers POST (`/api/chat/[id]`, `/api/upload`, `/api/auth/logout`,
  `/api/cron/*`, `/api/payments/*`) KHÔNG có origin check của framework.
  **Control CSRF cho các route `/api/*` POST này là `sameSite: "lax"` trên
  session cookie** (`src/lib/session.ts:146`), KHÔNG phải guard per-route
  (independent review 2026-10-08): request giả mạo cross-site mang THEO
  cookie của chính nạn nhân nên participant check (chat) + rate limit, auth +
  quota (upload) đều pass — form POST cross-site `enctype=text/plain` (body
  craftable thành JSON) được `request.json()` parse bình thường
  (`app/api/chat/[id]/route.ts:107` — route không kiểm tra Content-Type);
  logout cũng chỉ đọc cookie (`app/api/auth/logout/route.ts:3` →
  `destroySession`). Lax không gắn cookie vào cross-site POST nên request giả
  mạo đến route là 401 UNAUTHENTICATED (logout không có cookie → không có gì
  để revoke). Được ghim bởi `tests/unit/session.test.ts:231`
  (`toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" })`) — nếu
  cookie từng đổi sang `SameSite=None`, route-handler CSRF sẽ mở;
- Route KHÔNG xác thực bằng cookie thì guard per-route vẫn đúng nghĩa (CSRF
  không thay thế được secret): cron = `CRON_SECRET` (fail-closed 503); MoMo
  IPN = HMAC chữ ký (fail-closed); momo create = finance shutdown 503. Các
  guard này là per-route tests đã cite ở ma trận (hàng 26/27/28);
- **Tương tác header đã ghi nhận (corrections #8):** `Referrer-Policy:
  no-referrer` CHỈ trên `/invite/:token` — KHÔNG trên `/invite` (tokenless),
  vì no-referrer làm browser gửi `Origin: null` trên action POST cùng origin →
  Next CSRF check reject. Được ghim bởi `tests/unit/security-headers.test.ts`
  (hiệu lực `/invite` = `strict-origin-when-cross-origin`) và comment
  `next.config.ts`.

## Findings register

> Format cố định (release gate Task 9 grep case-insensitive): severity
> `CRITICAL|HIGH|MEDIUM|LOW`, status `OPEN|RESOLVED|ACCEPTED`. **Gate FAIL
> khi có hàng `CRITICAL` + `OPEN`** (§9 "no known critical security issue").
> Không có hàng CRITICAL nào dưới đây.

| Severity | Status | File | Finding | Recommendation | Blocks launch |
|---|---|---|---|---|---|
| MEDIUM | ACCEPTED | src/lib/actions/admin-identity.ts | FD-R58: `session.revoke` KHÔNG có rank check — operations_admin có thể thu hồi session của super_admin (ma trận §5.4.1 cấp cả hai) | Founder review (FD register); rank check = plan mới nếu cần | no |
| MEDIUM | ACCEPTED | src/lib/actions/admin-identity.ts:302 | FD-R58: `regenerateRecoveryCodesAction` chấp nhận MỘT recovery code làm proof (`verifyAdminMfaCode` trả `"totp"` hoặc `"recovery_code"`) — một code lộ có thể mint 10 code mới | Founder review; yêu cầu TOTP cho regeneration = plan mới | no |
| LOW | ACCEPTED | src/lib/actions/auth.ts | Failed login / MFA failure KHÔNG ghi AuditEvent — auth-abuse monitoring mù ở seam AuditEvent (ops-alerts chỉ đếm được OTP/audit có sẵn) | Rate limit + nginx log bù; audit event trên failure = plan mới (Batch 2 action change, ngoài G3) | no |
| LOW | OPEN | next.config.ts | CSP ship **Report-Only** — chưa enforce cho tới khi operator flip header | Release-checklist row: flip `Content-Security-Policy-Report-Only` → `Content-Security-Policy` sau `docker:smoke` + manual page-load (Task 9) | no |
| LOW | ACCEPTED | src/lib/actions/reviews.ts:24 | `submitReviewAction` ghi `Review` không có finance guard (dormant — cần Order completed; finance off) | Revisit ở finance re-enable review (RR-9 family) | no |
| LOW | ACCEPTED | src/lib/actions/seller-verification.ts | Seller declaration submit KHÔNG có rate limit (surface đã đăng nhập) | Thêm limit ở plan mới nếu quan sát abuse; FD-R65 tune | no |
| LOW | ACCEPTED | src/lib/actions/appeals.ts | `recordAppealAction` KHÔNG có rate limit (B3 R5) | Accepted — intake thủ công, moderation queue là chặn | no |
| LOW | ACCEPTED | dev-toolchain (prisma CLI rc / eslint-config-next) | `npm audit` đầy đủ: 18 findings (13 high/5 moderate) — TẤT CẢ dev-transitive, 0 runtime app (`--omit=dev` = 0). Image `migrate` (Dockerfile:32) copy full `node_modules` deps (gồm dev) → 18 findings CÓ mặt trong image chạy against DB production; code path khai thác (hono server, `lodash _.template`) không được `prisma db migrate` thực thi | Bump khi prisma 8 stable (upgrade-app.md); KHÔNG `audit fix --force` (major downgrade); thu hẹp node_modules image migrate (omit dev) = plan mới nếu muốn | no |
| LOW | ACCEPTED | src/lib/rate-limit.ts | RR-1/RR-20: limiter in-memory single-instance — restart reset bucket, CGNAT bucket chung | 1-instance compose + nginx `limit_req` (checklist row); shared limiter khi scale-out | no |
| LOW | ACCEPTED | src/lib/admin-mfa.ts | RR-2: TOTP replay trong cửa sổ ±60s — không durable consumed column | Durable column = migration mới (G2 — plan riêng); compensating controls §6.1 | no |
| LOW | ACCEPTED | src/prisma/contract.prisma (User.phone) | RR-3: phone-verify race — không partial unique index trên phone đã verify | Index = migration mới (G2); ops query §6.1 là control hiện tại | no |
| LOW | ACCEPTED | src/lib/provinces.ts | FD-R64: legacy name `"Thừa Thiên Huế"` thiếu trong `legacyNames` của `hue` → resolve `unresolved` (fail-closed) | Founder bổ sung vào registry (FD register) | no |
| LOW | ACCEPTED | instrumentation.ts:27 | RR-31: build warning `process.exit` trong Edge runtime (pre-existing, B2 R19) | Ghi nhận; không ảnh hưởng runtime đã deploy | no |

**Tổng:** 0 CRITICAL, 0 HIGH, 2 MEDIUM ACCEPTED (FD-R58), 10 LOW ACCEPTED,
1 LOW OPEN (CSP flip — checklist row của operator, không phải defect code) —
13 hàng. §9 "no known critical security issue" **THỎA** ở thời điểm 2026-10-08.
