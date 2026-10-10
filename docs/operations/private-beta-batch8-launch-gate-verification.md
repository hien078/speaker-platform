# Private Beta Batch 8 — Operational, Legal, Security Launch Gate Verification (Task 10)

**Date:** 2026-10-10
**Plan:** `docs/superpowers/plans/2026-10-06-private-beta-batch-8-launch-gate.md` (Task 10 + Acceptance Gate)
**Corrections (mandatory, applied — overrides the plan):** `docs/superpowers/plans/2026-10-08-private-beta-batch-8-plan-corrections.md` — mọi item đã áp dụng; các item Task 10: 3 (migration graph), 14 (typegen trước tsc), 18 (dev dry runs), 33 (git grep + classify comment hits)
**Spec:** `docs/superpowers/specs/2026-10-06-private-beta-marketplace-reset-design.md` — §9 Batch 8 + Gate, §12/§12.1/§12.2, §10/§10.1, §4, §5, §7
**Worktree:** `Speaker Platform-worktrees/batch8-implementation` (branch `opencode/batch8-implementation`)
**Executor:** OpenCode — model **OneNexus GLM 5.3** (provider `home-gateway`), session chạy trực tiếp trên worktree (không subagent — plan Global Constraints)

> ## VERDICT — cổng §9 Batch 8 (implementation): **PASS**; cổng release (launch): **ĐÚNG ĐỎ — fail-closed theo thiết kế**
>
> **Per spec §9 Batch 8 Gate:** cả 10 mục gate ("no known critical security
> issue; restore drill successful; admin MFA operational; RBAC operational;
> moderation operational; report/block operational; seller verification
> operational; legal/operations sign-offs recorded; founding seller process
> ready; supply readiness approved") đều **có evidence ghi nhận** (§3 — mapping
> verbatim từng mục). Mọi gate kỹ thuật xanh: unit 2485/2485, integration
> 279/279, preflight 7/7, build, smoke, `npm audit --omit=dev` = 0, migration
> graph **identical Batch 7** (G2), abuse-matrix 29 hàng machine-checked.
>
> **Per spec §12 (Private-Beta Readiness Criteria):** product **chưa**
> beta-ready — và đó là kết quả ĐÚNG của cơ chế fail-closed (FD-3):
> `npm run release:gate` exit 1 với **ĐÚNG 2 gate đỏ — `policy-reviews` +
> `release-checklist`** (mọi gate khác xanh), vì (a) cả 6 policy còn
> `DRAFT-NOT-REVIEWED` (FD-R34 — founder duyệt), (b) cả 28 hàng FD-mirror
> blocking còn `PENDING`, (c) 26 hàng FOUNDER của checklist chưa ký.
> **Batch 8 implementation gate PASS ≠ launch** — xem §7 (LAUNCH BLOCKER
> OTP) + §15 (các bước founder biến gate xanh) + §16 (các bước deploy/sign-off
> người chạy).

---

## 1. Commits và executor metadata

**Base:** `308b7fd` — `test(batch7): verify cohort operations gate` (commit
gate Batch 7; `beta/batch7-cohort-ops` @ `308b7fd` per corrections §A — verified
`308b7fd` là ancestor của HEAD; `git diff 308b7fd -- migrations src/prisma`
**rỗng** — G2 giữ nguyên graph + contract).

**Final state verified:** `0fbbf1a` + commit của doc này (refresh vòng 2 —
review 2026-10-10 vòng 2 của fix Task 9 + doc này; mọi số §2/§5 là re-run
foreground trên tree đó).

```
$ git log --oneline 308b7fd..HEAD   (refresh vòng 2 2026-10-10, tree cuối 0fbbf1a; + commit doc này sau)

0fbbf1a docs(ops): fresh-backup production drill and first-deploy note  ← vòng 2 fix finding 1 (OPS-01/OPS-12 + §16)
541624a fix(gate): restrict fixture overrides to test mode             ← vòng 2 fix finding 5+6 (gate + tests + checklist §3)
6315baf docs(ops): correct release checklist server-side steps         ← Task 9 review fix (checklist)
1481e35 fix(gate): fail-closed release gate checks from review          ← Task 9 review fix (gate script + tests)
a4a983c test(batch8): verify launch gate                               ← Task 10 (doc này, bản đầu)
8cf74ce docs(ops): last doc-accuracy fixes from fix verification      ← Task 10 doc-fix (§11)
fdc7272 feat(gate): private-beta release checklist and release gate   ← Task 9
8ec8b62 merge: batch 8 playbooks and wave-0 review fixes              ← merge playbooks + review fixes
b83b9b2 docs(ops): verbatim scratch drill evidence                    ← Task 6 evidence re-record (review fix)
921c91a fix(ops): run restore drill prisma verify in the migrate image ← Task 6 --file review fix
15781b7 docs(ops): playbook fixes from independent review            ← Task 3/4 review fix
06cb1f2 docs(security): accuracy fixes from independent review        ← Task 8 review fix
612b29a docs(security): self-review fixes to the launch security review doc ← Task 8 self-review fix
980269e test(security): abuse matrix and launch security review       ← Task 8c
4c20b95 docs(ops): factual-accuracy fixes from batch 8 playbook review ← Task 3/4 review fix
c987c74 docs(ops): incident playbook with evidence preservation       ← Task 4
63d8889 test(security): chat and listing surface XSS source contract  ← Task 8b
ec94bb3 feat(security): app-wide browser security headers (report-only CSP) ← Task 8a
71b8d27 docs(ops): moderation, verification, concierge, recovery playbooks ← Task 3
6aa6b66 docs(ops): refresh drill and access-review evidence on the final migration graph ← corrections item 9
7a8f5ac fix(ops): reconcile early batch 8 work with batches 5-7       ← Wave 0 semantic fix (items 2, 11, 16, 17, 20)
4b58a93 docs(plan): batch 8 corrections against the post-Batch-7 tree ← corrections doc
4c68cf9 fix(ops): classify Batch 3/4 models in finance-boundary alerts ← cherry-pick (813cb8a)
0cdfbf6 fix(ops): run admin access review inside the migrate image on production ← Task 7 review fix (d9e1d15)
4e995d9 feat(ops): admin access review with sign-off                 ← Task 7 (d4f8d37)
4a06922 fix(ops): full verification in restore drill file mode        ← Task 6 review fix (4af534b)
592d61d test(ops): scripted backup and restore drill                  ← Task 6 (d05b7ff)
276ff85 fix(ops): accurate finance-boundary signals                  ← Task 5 review fix (d067009)
ca9441f feat(ops): monitoring signals and finance-boundary alerts     ← Task 5 (3b07539)
51f0ca4 fix(policies): neutral review status and stricter content tests ← Task 1/2 review fix (d1fe883)
6d0e6a8 test(copy): permanent no-misleading-promise scan              ← Task 2 (d76c2c5)
85e333e feat(policies): versioned policy pages with review-gated release ← Task 1 (dd0f48d)
```

**Provenance cherry-pick `-x`:** mỗi commit Wave 0 mang dòng "(cherry picked
from commit …)" gốc `local/b8-early-integration` (corrections §A — đã verify
ví dụ `85e333e` ← `dd0f48d…`, `4e995d9` ← `d4f8d37…`).

**Mỗi task được review độc lập và mọi confirmed finding đã fix** — các commit
review-fix trong danh sách trên: `51f0ca4` (T1/2), `276ff85` (T5), `4a06922` +
`921c91a` + `b83b9b2` (T6), `0cdfbf6` (T7), `7a8f5ac` (Wave 0 merge), `4c20b95` + `15781b7` (T3/4), `612b29a` + `06cb1f2`
(T8), `8cf74ce` (doc fix verification — §11), **`1481e35` + `6315baf` (T9
review fix — gate script/tests + checklist)**. Task 9 (`fdc7272`) review độc
lập (2026-10-10): **6 confirmed findings** — 1 HIGH (gate `evidence-files` parse
findings-register **fail-open** — regex không khớp layout cột thực), 2 MEDIUM
(gate xanh nếu hàng FOUNDER/user-run bị **xoá** hay **flip `PASS`** không chữ
ký; checklist thiếu hàng server-side deploy — không backup pre-migrate, không
backfills, hàng seed mâu thuẫn seed catalog bắt buộc), 3 LOW (OPS-08 mô tả bind
mount không tồn tại — thực tế **named volume**; ô Reviewer placeholder
`— (chờ founder)` được tính là đã điền; `policy-reviews` dùng row ĐẦU của key
thay vì row khớp version+hash). **Fix bởi commit `1481e35`** (`fix(gate):
fail-closed release gate checks from review` — script + tests) **+ `6315baf`**
(`docs(ops): correct release checklist server-side steps` — checklist), land
sau `a4a983c` — KHÔNG còn working-tree-only. Checklist sau fix: **53 hàng chính
[26 FOUNDER] + 28 FD-mirror** (so với snapshot gate run4 49 [22] trước review
fix — xem §5).

**Review vòng 2 (2026-10-10) của fix Task 9 + doc này — fix bởi `541624a` +
`0fbbf1a` + commit refresh doc này:**

- **Finding 1 (CONFIRMED):** OPS-12 bảo dùng lại backup pre-migrate cho drill
  OPS-01 — drill so sánh DB live với dump nên dump cũ luôn lệch. Fix
  `0fbbf1a`: OPS-01 yêu cầu **backup MỚI ngay trước drill** (sau
  migrate/seed/backfill, không có ghi nào vào DB giữa hai lệnh); OPS-12 bỏ
  "dùng lại cho OPS-01" + thêm note **lần deploy đầu** (server mới chưa có
  container `loaviet-db` → không có gì để backup: `up -d db` rồi backup, hoặc
  ghi chú N/A + ký) — checklist + §16.
- **Finding 5 (SPLIT):** cả hai `filled()` (bash + awk trong
  `scripts/release-gate.sh`) match substring `chờ|pending|tbd` — từ chối
  decision THẬT chứa các từ đó. Fix `541624a`: placeholder **nguyên ô** (trống;
  bắt đầu `—`/`-`; đúng `PENDING`/`TBD`/`chờ` case-insensitive sau trim) —
  "Chờ provider OTP (FD-R1) — chấp nhận" + date giờ qua; `PENDING` + `— (chờ
  founder)` vẫn FAIL (fixture test chứng minh cả ba); quy tắc nêu trong
  checklist header + §3.
- **Finding 6 (REJECTED theo review — harden luôn theo commit plan founder):**
  env override fixture được honour cả khi chạy thật. Fix `541624a`: guard đầu
  script **từ chối chạy** (exit 1 ngay, không gate nào chạy) khi
  `RELEASE_GATE_POLICY_RECORD`/`RELEASE_GATE_POLICY_HASH_CMD`/`RELEASE_GATE_CHECKLIST_DOC`/`RELEASE_GATE_REQUIRED_FOUNDER_REFS`
  bị set ngoài source mode của test; test chứng minh từng biến bị từ chối +
  source mode (test) vẫn cho phép.
- **Finding 2/3/4 (doc này):** commit list + final state (§1), số đếm re-run
  (§2/§3/§6/§9), output gate theo thứ tự chạy thật (§5).

## 2. Acceptance set — kết quả từng lệnh (foreground, exit code ghi từng lệnh; **số dưới đây = refresh vòng 2 2026-10-10 re-run trên tree cuối `0fbbf1a`** — `npm test` / 8 file contract / lint / typegen+tsc / `release:gate` chạy trực tiếp; build + integration + smoke + preflight + audit re-run bên trong `release:gate`; 2 dry-run dev + `prisma migration list` giữ từ bản đầu `8cf74ce` — vòng 2 không đụng code tương ứng)

| Lệnh | Kết quả | Exit |
|---|---|---|
| `npm test` (full unit) | **109 files / 2485 tests PASS** (Duration ~17s) | 0 |
| `npm test --` 8 file contract Batch 8 (`policy-registry`, `copy-safety`, `ops-alerts`, `admin-access-review`, `abuse-matrix`, `security-headers`, `chat-surface-xss`, `release-gate-checklist`) | **8 files / 180 tests PASS** (`release-gate-checklist.test.ts` = **48 test**: 10 bản đầu → 33 sau `1481e35` → 48 sau `541624a` vòng 2) | 0 |
| `npm run lint` | eslint clean (0 error) | 0 |
| `npx next typegen` + `npx tsc --noEmit` | typegen "Types generated successfully"; tsc **0 error** (corrections item 14 — typegen trước) | 0 |
| `npm run build` | Next 16.3.8 build PASS (21 static pages; 1 warning đã biết `instrumentation.ts:27` Edge `process.exit` — RR-31, pre-existing) | 0 |
| `bash scripts/test-integration.sh` | **33 files / 279 tests PASS** (scratch DB `sp-it-pg-*` dọn ở trap EXIT) | 0 |
| `npm run smoke` | **SMOKE PASS** — mọi finance entry point deny typed (`FINANCIAL_FEATURES_DISABLED`), page finance 404, `/uploads` headers đúng | 0 |
| `npm run preflight` | **PREFLIGHT PASS 7/7**: contract-emit-drift, lint, typecheck, unit-tests, production-build, compose-config, migration-graph | 0 |
| `npx prisma migration list` | **9 dirs, head `20261008T1130_batch7_cohort_operations`** (refs `[db, production]`), invariant `backfill-listing-approved-content-at` trên self-edge batch4_round4 — **identical Batch 7, KHÔNG có migration Batch 8** (G2; §9) | 0 |
| `npm audit --omit=dev` | **0 vulnerabilities** runtime | 0 |
| `npm run release:gate` | **exit 1 — ĐÚNG theo thiết kế**: **7/9 gate xanh** (preflight 7/7 sub-steps) + **2 gate đỏ `policy-reviews` + `release-checklist`** (§5 — trích dòng kết quả nguyên văn theo thứ tự chạy; chạy trên tree cuối `0fbbf1a`: fix Task 9 đã commit `1481e35`/`6315baf`, vòng 2 `541624a`/`0fbbf1a`) | 1 |
| `npx tsx scripts/ops-alerts.ts` (dev dry run, corrections item 18) | mode `docker` (không `.env` trong worktree — auto mode): 3 CRITICAL + 3 WARN — **tất cả expected dev-without-stack** (§10) | 1 (CRITICAL → exit ≠ 0 by design) |
| `npx tsx scripts/admin-access-review.ts` (dev dry run) | **fail-closed typed**: `DATABASE_URL chưa đặt trong MÔI TRƯỜNG THẬT` — guard đúng; evidence run dated 2026-10-08 đã ghi (§10) | 1 (typed refusal) |
| `npx tsx scripts/policy-hash.ts --check` | 6 dòng `<key> v1 <sha256> DRAFT-NOT-REVIEWED` — hash **byte-identical** với 6 row `docs/operations/policy-review-record.md` (Decision `PENDING`) | 0 |

## 3. Spec §9 Batch 8 Gate — 10 mục → evidence (mapping verbatim từ `docs/operations/private-beta-release-checklist.md` §9-01..§9-10)

| §9 Batch 8 gate item | Evidence | Trạng thái |
|---|---|---|
| 1. no known critical security issue | `docs/operations/private-beta-security-review.md` findings register: **0 CRITICAL, 0 HIGH**, 2 MEDIUM ACCEPTED (FD-R58), 10 LOW ACCEPTED, 1 LOW OPEN (CSP flip = checklist row SEC-01, không phải defect code) — 13 hàng; `tests/unit/abuse-matrix.test.ts` 29 hàng machine-checked (mọi evidence path resolve + `@key` marker nằm trong file test); `npm audit --omit=dev` = 0 | **PASS** (§9-01) |
| 2. restore drill successful | `docs/operations/restore-drill-evidence.md`: 2026-10-08 scratch **14 PASS / 0 FAIL — DRILL PASS (exit 0)** trên graph 9 migration / 48 bảng; 2026-10-08 `--file` test-rig **14 PASS / 0 FAIL / 0 CANNOT RUN** (check 4/4 qua image migrate); 2026-10-06 (graph batch2) giữ làm history. Production `--file` = hàng OPS-01 (user) | **PASS** (§9-02) |
| 3. admin MFA operational | `tests/unit/admin-mfa.test.ts`, `admin-mfa-login.test.ts`, `tests/integration/admin-mfa-login.test.ts`, `admin-bootstrap.test.ts` xanh trong suite 2485; `docs/operations/admin-access-review.md` (findings vocabulary + dev runs dated 2026-10-06/2026-10-08; production run = OPS-02) | **PASS** (§9-03) |
| 4. RBAC operational | `tests/unit/rbac.test.ts` (matrix) + mọi capability suite B3–B7 xanh; FD-R58 observations ghi trong security review §5/§6 | **PASS** (§9-04) |
| 5. moderation operational | Batch 3 moderation suites xanh; `docs/operations/moderation-playbook.md` (queue, hand-off, recusal FD-R11, evidence §5.5.1, appeal intake + notification gap FD-R8, taxonomy PROVISIONAL FD-R12, placeholder copy FD-R50) | **PASS** (§9-05) |
| 6. report/block operational | Batch 3 block/report suites xanh (`report-actions`, `block-actions`, `chat-guard`, `block-enforcement`) — re-run là evidence | **PASS** (§9-06) |
| 7. seller verification operational | Batch 2/4 verification + publication-gate suites xanh; `docs/operations/seller-verification-playbook.md` (checklist §5.3.3 + RR-3 duplicate-phone query — corrections item 6: playbook TÁC GIẢ query, counts + internal ids only). **Production tới FD-R1: không seller nào qua `phone_verified`** (§7) | **PASS** (§9-07) |
| 8. legal/operations sign-offs recorded | Cơ chế ship: 6 policy pages versioned + registry (status trong registry, hash phủ `POLICY_TEXT` only) + review-record template + gate `policy-reviews` chặn khi chưa duyệt. **Founder reviews = bước launch, không phải commit Batch 8** (FD-R34/FD-R4) | **MECHANISM PASS — sign-off FOUNDER PENDING** (§9-08) |
| 9. founding seller process ready | `docs/operations/founding-seller-onboarding-checklist.md` + `concierge-onboarding-playbook.md` (invite cookie flow RR-21, §5.10 lifecycle FD-R48) + `model-seed-review-procedure.md`; Batch 7 console suites xanh | **PASS** (§9-09) |
| 10. supply readiness approved | Checklist §12.1-01..08 có evidence + sign-off fields; **phê duyệt là của founder (FD-R30)** — gate enforce không PENDING + mọi FD-mirror blocking có dated decision | **FOUNDER PENDING** (§9-10) |

## 4. Spec §12 readiness — trạng thái từng criterion

20 hàng §12 của checklist: **17 PASS** (mọi criterion kỹ thuật — finance off,
copy non-custodial, verification, publication gate, cohort gate, MFA, RBAC,
report/block, moderation, recovery, audit, telemetry, monitoring, incident,
support path, restore drill, security findings) + **3 FOUNDER** (§12-12/§12-13
critical E2E — FD-R59: chấp nhận posture hay commission Playwright; §12-15
sáu policy reviews — FD-R34). §12.1: 2 PASS + 6 FOUNDER (target seller/
inventory/quality listings/model coverage/listing sampling/capacity —
FD-R30/FD-R23/FD-R16/FD-R14). **§12 "technically beta-ready" chưa đạt cho tới
founder ký các hàng đó** — đúng thiết kế FD-3 fail-closed.

## 5. Release gate — output run refresh vòng 2 (2026-10-10, `npm run release:gate` trên `0fbbf1a`, exit 1)

**Kết quả 9 gate theo ĐÚNG thứ tự chạy của script** (`scripts/release-gate.sh`:
preflight → integration → smoke → dependency-audit → policy-reviews →
evidence-files → release-checklist → finance-off → abuse-matrix). Các dòng
kết quả dưới đây **trích nguyên văn từ log run** — output chi tiết của từng
gate con (build log, test output, JSON migration graph…) được lược: đây là
tóm tắt theo dòng kết quả, KHÔNG phải toàn bộ output verbatim.

```
✔ PASS: preflight
✔ PASS: integration
✔ PASS: smoke
✔ PASS: dependency-audit
✘ FAIL: policy-reviews
✔ PASS: evidence-files
✘ FAIL: release-checklist
✔ PASS: finance-off
✔ PASS: abuse-matrix

RELEASE GATE FAIL — gate đỏ: policy-reviews release-checklist
(FAIL là ĐÚNG khi policy còn DRAFT-NOT-REVIEWED + hàng founder blocking chưa ký —
FD-3 fail-closed. Founder duyệt 6 policy [FD-R34, kèm FD-R4 bump v1→v2], quyết
các register item blocking trong docs/operations/founder-decision-register.md,
chạy + ký các hàng OPS/SEC trong checklist — gate xanh sau đó.)
```

(preflight = **7/7 sub-steps**: contract-emit-drift, lint, typecheck,
unit-tests [109 files / 2485], production-build [21 static pages],
compose-config, migration-graph [identical Batch 7]; abuse-matrix = **4 file
contract / 90 tests**.)

**`policy-reviews` đỏ (6 hàng — thiết kế §9 "legal/operations sign-offs
recorded" machine-checked):**

```
✘ policy "terms": registry status "DRAFT-NOT-REVIEWED" ≠ REVIEWED — chưa duyệt (FD-R34)
✘ policy "privacy": registry status "DRAFT-NOT-REVIEWED" ≠ REVIEWED — chưa duyệt (FD-R34)
✘ policy "marketplace_rules": registry status "DRAFT-NOT-REVIEWED" ≠ REVIEWED — chưa duyệt (FD-R34)
✘ policy "seller_rules": registry status "DRAFT-NOT-REVIEWED" ≠ REVIEWED — chưa duyệt (FD-R34)
✘ policy "community_rules": registry status "DRAFT-NOT-REVIEWED" ≠ REVIEWED — chưa duyệt (FD-R34)
✘ policy "safety_guidance": registry status "DRAFT-NOT-REVIEWED" ≠ REVIEWED — chưa duyệt (FD-R34)
✘ FAIL: policy-reviews
```

**`release-checklist` đỏ (checklist: 53 hàng chính [26 FOUNDER], 28 hàng
FD-mirror):** 26 hàng FOUNDER chưa Sign-off (§12-12, §12-13, §12-15,
§12.1-02..06, §12.1-08, §9-08, §9-10, SEC-01, OPS-01..14) + mỗi hàng
FD-mirror 28/28 in `Decision "PENDING" chưa quyết` + `Date trống`
(FD-R1, R2, R3, R4, R6, R7, R8, R11, R12, R14, R15, R16, R17, R20, R21, R23,
R24, R28, R29, R30, R33, R34, R48, R50, R59, R62, R68, R69).

**Không check nào bị yếu hoá để làm gate xanh** — FAIL này là output ĐÚNG của
cơ chế (Task 9 Step 4: "the gate must fail while policies are unreviewed and
while blocking founder decisions are unsigned — that is the designed
behavior"). So sánh với run Task 9 (`.superpowers/sdd/…/release-gate-run4.log`,
49 hàng [22 FOUNDER] — snapshot **trước** review fix): review fix Task 9 thêm
4 hàng OPS-11..14 (secrets/backup-before-migrate/seed/backfills) + harden gate
→ **53 [26]**; cùng tập gate đỏ. **Gate re-run (refresh vòng 2, 2026-10-10)
chạy trên tree cuối `0fbbf1a`** — fix Task 9 đã commit (`1481e35` +
`6315baf`), vòng 2 fix thêm (`541624a` + `0fbbf1a`): cùng tập gate đỏ, cùng
**53 hàng chính [26 FOUNDER] + 28 FD-mirror** — các vòng fix chỉ harden
(whole-cell placeholder, guard fixture override, fresh-backup drill), KHÔNG
đổi kết quả gate.

## 6. Founder Decision Register — trạng thái tại thời điểm thực thi

**Nguồn machine-parsed:** `docs/operations/founder-decision-register.md`
(corrections item 7 — test parse file NÀY, không parse plan). Số derive tại
Task 10 bởi `tests/unit/release-gate-checklist.test.ts` (chạy xanh trong
`npm test` 2485 + gate `abuse-matrix` 90/90): **73 hàng — 28 blocking**
(FD-R1, R2, R3, R4, R6, R7, R8, R11, R12, R14, R15, R16, R17, R20, R21, R23,
R24, R28, R29, R30, R33, R34, R48, R50, R59, R62, R68, R69), 45 non-blocking —
khớp dòng "Register size" của register (test ghim drift).

**Trạng thái từng hàng blocking (28/28):** `PENDING` — Decision + Date trống
trong FD-mirror của checklist (gate in từng hàng — §5). **Không hàng nào được
implementer/agent điền** (spec §4.11 — ô Decision/Date là founder-only). Mọi
hàng blocking có cơ chế fail-closed tương ứng đã ship + nơi ghi nhận
(register cột cuối): policy reviews (FD-R34 → `policy-review-record.md` +
gate `policy-reviews`), Scoped RBAC (FD-R2 → ma trận fail-closed + security
review), manual recovery proofing (FD-R3 → runbook §6 two-person + playbook
§4), Seller Rules bump (FD-R4 → commit duyệt founder), sanction policy (FD-R6),
retention (FD-R7), appeals (FD-R8), recusal (FD-R11), taxonomy PROVISIONAL
(FD-R12), condition-grade (FD-R14), photo checklist (FD-R15), model list
(FD-R16), upload retention (FD-R17), metric windows (FD-R20), match
reconciliation (FD-R21), quality-listing definition (FD-R23), alias content
(FD-R24), safety copy review (FD-R28), invitation channel (FD-R29), buyer
acquisition (FD-R30), buyer-gate default (FD-R33), six policy texts (FD-R34),
Batch 7 provisional set (FD-R48), placeholder moderation copy (FD-R50), E2E
posture (FD-R59), verification reason-code map (FD-R62), PROVISIONAL product
copy (FD-R68), verified-channel binding (FD-R69).

## 7. LAUNCH BLOCKER — production OTP fail-closed (FD-2/FD-R1/FD-R69)

**Provider OTP email/SMS production chưa tồn tại** (FD-2 — founder decision
2026-10-06: DEFERRED). Hệ quả fail-closed trong production cho tới khi provider
land (FD-R1 — BLOCKING):

1. **Không kênh nào (email lẫn phone) tự xác minh được** —
   `OtpDeliveryAdapter` production throw `OTP_DELIVERY_UNAVAILABLE` với MỌI
   lần gửi, bất kể kênh đã được đánh dấu verified hay chưa
   (`src/lib/verification-delivery.ts:91-101,118-119`).
2. **Không seller nào qua được `phone_verified`** → seller verification +
   publication **blocked trong production**
   (`src/lib/seller-verification-policy.ts:245`) — checklist §12-03/§9-07
   PASS ở mức cơ chế test, nhưng luồng production đứng ở bước này.
3. **Invite acceptance cần kênh đã verified** (FD-R69 — BLOCKING): token
   invite không đủ; phone-channel candidates `INVITE_CHANNEL_UNVERIFIED`
   (`src/lib/actions/founding-sellers.ts:477`); đường production duy nhất cho
   KÊNH EMAIL là runbook §6 per-user audited two-person psql block (set
   `emailVerifiedAt` ONLY — không set `phoneVerifiedAt`, không làm `/recover`
   gửi được mã). Founder quyết: đợi provider (FD-R1), hoặc chấp nhận token
   possession + out-of-band delivery, hoặc chạy runbook §6 per-user.
4. **`/recover` không bao giờ gửi được mã** — self-service password recovery
   **BẤT KHẢ THI** trong production (account-recovery playbook §1.3/§4: KHÔNG
   chạy block §6 cho mục đích recovery; KHÔNG đặt `passwordHash` tay; chứa
   bằng thu hồi session + đình chỉ theo incident playbook §4a; route ca về
   founder FD-R1/FD-R3). Lần gửi bị chặn ghi `AuditEvent`
   `user.recovery_requested` reason `OTP_DELIVERY_UNAVAILABLE` — operator
   tra `/admin/audit` (playbook §1.3, fix 2026-10-10 trong `8cf74ce`).

**Đây là blocker lớn nhất của private beta** (Q1 corrections §G): mọi con
số beta (seller verified, listing, invite) phụ thuộc FD-R1 land hoặc founder
chấp nhận đường thủ công per-user.

## 8. Residual Risk Register — verification

RR-1..RR-23 (plan) + RR-24..RR-32 (corrections §F) — **re-verify với output
ghi trong `docs/operations/private-beta-security-review.md` §6** (Task 8,
review độc lập + fix `612b29a`/`06cb1f2`):

- **RR-5 RESOLVED + verified tại Task 10:** `src/lib/provinces.ts` có ĐÚNG
  **34 đơn vị** (verify mới 2026-10-10: `npx tsx -e` import → `units: 34`;
  awk đếm 34 object `{ code:`). Scan `git grep -n "PROVINCE_CODES" -- src`
  (§10 bảng) — mọi hit là map 34-unit chính đáng, **0 di tích 63-unit**.
- **RR-22 CLOSED** (corrections §F): `toggleWishlistAction` approved-only +
  `/wishlist` redact (`wishlist-actions.test.ts`, `wishlist-page.test.ts`).
- **RR-9 refresh:** dormant finance `approved` writes =
  `src/lib/actions/admin.ts:399` (`resolveDisputeAction`) +
  `src/lib/actions/orders.ts:544` — unreachable khi finance off (Batch 1
  boundary + tests); finance-boundary watermark alert (Task 5) là tripwire.
- Dependency hygiene (B5 R12/B6 R8) **closed** bởi `da31a5b` (next 16.3.8,
  audit 0) — `npm audit --omit=dev` = 0 xác nhận lại tại Task 10.
- Các hàng còn lại (RR-1..4, 6..21, 23 + RR-24..32): giữ nguyên trạng thái
  accepted/recorded với control bù — chi tiết + output từng query trong
  security review §6.1/§6.2 (RR-3 duplicate-phone query: dev DB `0|0` — query
  sống trong seller-verification playbook; production pre-launch = operator).

## 9. Security review — summary (Task 8, commits `ec94bb3`/`63d8889`/`980269e` + fixes `612b29a`/`06cb1f2`)

- **§10.1 abuse matrix:** 29/29 hàng present exactly once, mọi evidence path
  resolve, mọi `@key` marker nằm trong cited file — machine-checked bởi
  `tests/unit/abuse-matrix.test.ts` (trong 180 contract tests + gate
  `abuse-matrix` 90/90).
- **Dependency audit:** `npm audit --omit=dev` **0** runtime (18 findings
  dev-transitive đã ghi trong findings register — image `migrate` carries
  them; code path không được `prisma db migrate` thực thi — LOW ACCEPTED).
- **§7.4 headers:** app-wide CSP **Report-Only** (`Content-Security-Policy-Report-Only`)
  + `nosniff` + HSTS (no preload) + `X-Frame-Options: DENY` + `Referrer-Policy:
  strict-origin-when-cross-origin` — entry app-wide **ĐẦU array** (corrections
  item 4) nên `/invite/:token` giữ `no-referrer` (RR-21), `/uploads` giữ CSP
  Batch 4 (không Report-Only) — `tests/unit/security-headers.test.ts` verify
  EFFECTIVE headers per path (last-match-wins). **Enforcement flip = SEC-01**
  (user-run, sau `docker:smoke` + manual page-load) — findings register LOW OPEN.
- **Secrets/env:** `git ls-files | grep -E '\.env$|\.pem$|secret'` → **0**;
  `requireCapability|requireAdminUser` trong `scripts/` → **0** (scripts
  offline, không HTTP surface).
- **§7.1 rate-limit inventory:** bảng concrete map (security review §5) —
  mọi giá trị PROVISIONAL (FD-R65); findings: seller declaration submit +
  appeals không limit (LOW ACCEPTED), block 20/min tồn tại.
- **Findings register (fixed format, gate parse):** 13 hàng — **0 CRITICAL,
  0 HIGH**, 2 MEDIUM ACCEPTED (FD-R58: `session.revoke` no rank check;
  recovery-code-as-proof cho regeneration), 10 LOW ACCEPTED, 1 LOW OPEN (CSP
  flip SEC-01). §9 "no known critical security issue" **THỎA**.

## 10. Drill + access review + monitoring — evidence pointer

- **Restore drill:** `docs/operations/restore-drill-evidence.md` — 2026-10-08
  scratch (graph 9 migration, 48 bảng) **14 PASS / 0 FAIL — DRILL PASS**;
  2026-10-08 `--file` test-rig **14 PASS / 0 FAIL / 0 CANNOT RUN** (check 4/4
  qua image `migrate` — fix `921c91a`); block verbatim, caveat TEST RIG nằm
  ở ghi chú prose (fix `8cf74ce` — §11). **Production `--file` = OPS-01** (user).
- **Admin access review:** `docs/operations/admin-access-review.md` — dev
  runs dated 2026-10-06 + 2026-10-08 (graph 9 migration, scratch DB
  `sp-review-pg-*`): 1 `super_admin` scratch chưa enroll MFA →
  `ADMIN_WITHOUT_MFA` + `LAST_SUPER_ADMIN` (fail-closed signals, dữ liệu
  scratch KHÔNG phải production); queries resolve trên schema 48 bảng.
  **Production run = OPS-02** (user, `scripts/admin-access-review-prod.sh`).
- **Monitoring dry run (corrections item 18, chạy 2026-10-10):** worktree
  không có `.env` → auto mode `docker`; không có stack loaviet local:

  ```text
  ops-alerts: IO lỗi ở tín hiệu error-rate: … No such container: loaviet-app
  ops-alerts: IO lỗi ở tín hiệu auth-abuse: … No such container: loaviet-db
  ops-alerts: IO lỗi ở tín hiệu finance-boundary: … No such container: loaviet-db
  {"…","event":"health","severity":"CRITICAL","detail":{"db":"unknown","httpStatus":401}}
  {"…","event":"error-rate-io","severity":"WARN","detail":{"io":"failed"}}
  {"…","event":"auth-abuse-io","severity":"WARN","detail":{"io":"failed"}}
  {"…","event":"finance-boundary-io","severity":"CRITICAL","detail":{"io":"failed"}}
  {"…","event":"backup-freshness","severity":"CRITICAL","detail":{"backups":0}}
  {"…","event":"cron-liveness","severity":"WARN","detail":{"heartbeat":"missing"}}
  {"…","event":"ops-alerts-run","severity":"INFO","detail":{"critical":3,"warn":3,"info":0,"mode":"docker"}}
  ```

  **Classify (đều expected dev-without-stack):** health CRITICAL (không có
  app container — corrections item 18 "A health CRITICAL in dev with no app
  running is expected"); 3 tín hiệu IO-failed (không có `loaviet-app`/
  `loaviet-db` — typed `OPS_ALERTS_IO`, không phải defect script);
  backup-freshness CRITICAL (0 backup local — production backup là việc
  OPS-03/OPS-12); cron-liveness WARN (chưa cài crontab — OPS-03). **Không
  dòng nào chứa PII** (counts + typed codes only — spec §4.8). Exit 1 khi có
  CRITICAL = by design. `admin-access-review.ts` dry run: typed refusal
  `DATABASE_URL chưa đặt trong MÔI TRƯỜNG THẬT` — guard fail-closed đúng;
  evidence run đầy đủ đã ghi dated 2026-10-08.

## 11. Playbook factual-accuracy pass — doc-accuracy fixes (`8cf74ce`)

Fix verification cuối (confirmed LOW findings, mọi line number đối chiếu mã
nguồn trước khi sửa — commit `docs(ops): last doc-accuracy fixes from fix
verification`):

1. **`docs/operations/account-recovery-playbook.md` §1.3 (trước :42-43):**
  sai khi nói production OTP failure "throw được `captureError` trong
  `after()`". Đúng: `requestOtp` TỰ BẮT throw của adapter — xoá row `OtpCode`
  vừa tạo, trả typed `{ok:false, code:"OTP_DELIVERY_UNAVAILABLE"}`
  (`src/lib/otp.ts:166-170`) — rồi callback `after()` ghi `AuditEvent`
  `user.recovery_requested` reason `OTP_DELIVERY_UNAVAILABLE`
  (`src/lib/actions/recovery.ts:217-245`, reason `:234`). Playbook giờ bảo
  operator tra reason đó trong `/admin/audit`; `captureError("recovery")`
  (`:238`,`:243`) CHỈ chạy khi có throw ngoài dự kiến (audit/db).
2. **`docs/operations/restore-drill-evidence.md` (2026-10-08 `--file` block
  ~:363):** dòng `Mode` bị hand-edit trong block có nhãn verbatim — đã
  restore nguyên văn output script (`scripts/restore-drill.sh:346` với
  default `:194-196`): `- Mode: --file (backup thật, stack production
  loaviet-db/loaviet)`; caveat "TEST RIG throwaway, không phải server
  production, không phải gate evidence production" chuyển vào ghi chú prose
  dưới block. Block 2026-10-06 (~:188) check tương tự: restore nguyên văn
  (caveat đã có trong header mục + bối cảnh + ghi chú prose mới khai báo các
  redaction host/IP + path).

Các playbook (Tasks 3/4) đã qua factual-accuracy pass trước đó
(`4c20b95`, `15781b7` — mọi path/action/capability/audit name đối chiếu mã
nguồn merged).

## 12. Source scans (plan Task 10 Step 2 — `git grep`, corrections item 33; mọi hit classified)

| Scan | Kết quả | Phân loại |
|---|---|---|
| `FINANCIAL_FEATURES_ENABLED` trong `.env.example:46`, `docker-compose.prod.yml:123`, `tests/docker/docker-compose.smoke.yml:66` | `"false"` ×3 | **PASS** (Batch 1 invariant; gate `finance-off` xanh). Hits trong `scripts/`: comments + readers (ops-alerts đọc từ container app; smoke export `"false"` cho standalone server; release-gate là chính gate) — **0 chỗ nào set `"true"`** |
| `dangerouslySetInnerHTML` trong `'app/policies/[key]/page.tsx'` + `src/content` | 2 hits, cả hai **comment** (`:9` doc comment "KHÔNG dangerouslySetInnerHTML", `:57` JSX comment) | **0 code hits — PASS** (corrections item 33: kỳ vọng 0 code hits, không phải 0 hits) |
| `đảm bảo\|bảo đảm\|bảo hiểm\|escrow` trong `src/content/policies` | **0 hits** | **PASS** — placeholder policy không có promise language (§4.2) |
| `PROVINCE_CODES` trong `src` | 15 hits / 6 files | **Mọi hit là map 34-unit chính đáng** (import/re-export/display lookup/comment — bảng §8 RR-5); **0 remnant 63-unit** — RR-5 RESOLVED |
| `requireCapability\|requireAdminUser` trong `scripts/` | **0 hits** | **PASS** — scripts offline, không HTTP surface |
| `git ls-files \| grep -E '\.env$\|\.pem$\|secret'` | **0 hits** | **PASS** — không secret nào được track |

## 13. Migration review (G2 — corrections item 3)

`npx prisma migration list` tại Task 10 (2026-10-10): **9 dirs** —
`20261003T0448_baseline`, `20261006T0209_batch2_identity_security`,
`20261006T1420_batch3_trust_safety`, `20261006T1902_batch4_listing_quality`,
`20261007T1708_batch4_holistic_review_fixes`,
`20261007T2007_batch4_round4_approved_content_backfill` (self-edge, provides
`backfill-listing-approved-content-at`),
`20261007T2208_batch5_search_telemetry`, `20261008T0237_batch6_chat_deal`,
**head `20261008T1130_batch7_cohort_operations`** (refs `[db, production]`,
marker `656449ac…`). **Identical Batch 7 — KHÔNG có migration Batch 8**
(G2). `git diff 308b7fd -- migrations src/prisma` **rỗng**. KHÔNG chạy
`migration ref set` (wipes invariant — pinned bởi
`tests/unit/approved-content-backfill-migration.test.ts`).

## 14. Deferred items (không thực thi trong Batch 8 — mỗi cái cần plan riêng)

- **§13 post-beta expansion gates** — out of scope theo batch definition.
- **TOTP durable consumed column** (RR-2) + **verified-phone partial unique
  index** (RR-3) — migration mới, ghi trong findings register; ops query là
  control hiện tại.
- **Retention/erasure automation** (FD-R7) — legal review trước.
- **Playwright E2E batch** cho 2 flow §12 critical — chỉ nếu FD-R59 chọn
  commission (mặc định: founder chấp nhận posture action-level unit +
  real-DB integration, ký + ngày).
- **Buyer invitations** theo §12.1 — chỉ sau supply readiness + FD-R30.
- **Batch 7 "Batch 8 polish" hand-offs** (corrections item 12: B7 R4/R8/R10,
  B2 R5/R2, B3 §8.3/B4 §9.3 finance hardening, B4 dead banner) — mỗi cái
  cần edit src/app ngoài G3 hoặc migration → plan riêng.
- **Finance re-enable** — design riêng (§13/§17 evidence-driven).
- **CSP enforcement** — SEC-01 (user flip sau docker:smoke + manual
  page-load).

## 15. Implementation gate ≠ launch (tuyên bố tường minh)

**Batch 8 implementation gate PASS ≠ private-beta launch.** Launch thêm vào
đòi hỏi (theo đúng thiết kế fail-closed FD-3 — release gate ĐỎ cho tới khi):

1. **Founder duyệt 6 policy** (FD-R34): thay placeholder bằng văn bản founder,
   chạy `npx tsx scripts/policy-hash.ts`, ghi row `APPROVED` (Reviewer/Date)
   trong `docs/operations/policy-review-record.md`, flip `status` →
   `"REVIEWED"` trong registry **cùng commit**; Seller Rules bump `v1`→`v2`
   (FD-R4 — `SELLER_RULES_POLICY_VERSION` trong commit duyệt founder).
2. **Founder quyết 28 hàng register blocking** (§6): Decision (resolution/
   explicit acceptance) + Date trong FD-mirror của checklist — derive
   mechanically từ `docs/operations/founder-decision-register.md`.
3. **Founder chạy + ký các hàng OPS/SEC** (§16) + các hàng FOUNDER còn lại
   (§12-12/13 E2E posture FD-R59, §12-15, §12.1-02..08, §9-08, §9-10).

## 16. Các bước deploy + sign-off NGƯỜI CHẠY (user-run — từ `docs/operations/private-beta-release-checklist.md` **sau review fix Task 9 + refresh vòng 2** — các hàng OPS-11..14 là phần thêm của review fix; bước 2 + 7 (OPS-12/OPS-01) refresh vòng 2 finding 1: backup MỚI ngay trước drill + note lần deploy đầu, §1; agent không bao giờ chạy)

**Thứ tự deploy (lần đầu trên server production):**

1. **OPS-11 — Secrets dedicated trong `.env` TRƯỚC lần `up -d --build` đầu
   tiên:** `ADMIN_MFA_ENCRYPTION_KEY` + `PRODUCT_EVENT_PSEUDONYM_KEY` =
   `openssl rand -base64 32` mỗi key (key DÀNH RIÊNG, không derive từ
   `AUTH_SECRET`; thiếu key → compose từ chối start); `chmod 600`; không in
   giá trị thật. `AUTH_SECRET`/`DB_PASSWORD`/`CRON_SECRET` theo
   `docs/deployment.md` §2 bước 2.
2. **OPS-12 — Backup production TRƯỚC migrate đầu tiên:**
   `./scripts/db-ops.sh backup` (container-on-network, không host pg tools)
   — lệnh `up` chạy service `migrate` tự động nên không backup tươi =
   migration chạy vào DB chưa backup. **Lần deploy đầu trên server mới:**
   chưa có container `loaviet-db`/dữ liệu cũ → `db-ops.sh` từ chối ("Container
   loaviet-db không chạy") và không có gì để backup — hoặc `docker compose -f
   docker-compose.prod.yml up -d db` rồi backup, hoặc ghi chú "N/A lần đầu"
   + ngày trong Sign-off (Status vẫn FOUNDER). Backup này là snapshot
   pre-migrate — KHÔNG dùng lại cho OPS-01 (drill ở đó cần backup MỚI sau
   migrate/seed/backfill).
3. **OPS-06 — Migrate qua service `migrate`:** `docker compose -f
   docker-compose.prod.yml up -d --build` (migrate tự chạy tới ref
   `production` trước app start); chạy tay khi cần `docker compose -f
   docker-compose.prod.yml run --rm migrate` (idempotent). Graph 9, head
   `20261008T1130_batch7_cohort_operations`, invariant
   `backfill-listing-approved-content-at`. **KHÔNG `migration ref set`.**
4. **OPS-13 — Seed beta catalog BẮT BUỘC sau migrate** (category
   `portable_bluetooth_speaker` — không seed → `/sell/new` không có danh mục,
   mọi seller bị chặn): dry-run rồi `--apply --allow-production` qua service
   migrate + mount `scripts/`+`src/`; `--models` CHỈ khi founder cung cấp
   file (FD-R16).
5. **OPS-14 — Backfills location + search-text:** `backfill-listing-location.ts`
   + `backfill-listing-search-text.ts` (dry-run rồi `--apply
   --allow-production`); SAU mỗi lần seed chạy thêm `--recompute-all`
   (searchTextNormalized trôi theo seed/rename/merge). Không backfill →
   listing legacy `unresolved` + không tìm được qua ô từ khóa.
6. **OPS-08 — Uploads named volume `uploads`** mount `/app/data/uploads` trên
   app + migrate (KHÔNG bind mount — "sửa" sang bind mount làm mọi upload cũ
   404); verify `docker compose … config` + GET `/uploads/<key>` 200 sau deploy.

**Sign-off vận hành (paste output dated + redacted vào evidence doc rồi ký):**

7. **OPS-01 — Production restore drill `--file`:** SAU migrate/seed/backfill
   (bước 3–5), lấy **backup MỚI** `./scripts/db-ops.sh backup` rồi **ngay sau
   đó** `bash scripts/restore-drill.sh --file backups/db-loaviet-<ts-mới>.dump`
   TRÊN SERVER — không có ghi nào vào DB giữa backup và drill (drill so sánh
   DB live với dump: table parity + row counts + read-back equal + `prisma db
   verify` — dump cũ/pre-migrate luôn lệch); paste vào
   `docs/operations/restore-drill-evidence.md` — RPO/RTO thật từ lần này
   (FD-R36).
8. **OPS-02 — Production admin access review:** `scripts/admin-access-review-prod.sh`
   (image migrate trên compose network); paste dated vào
   `docs/operations/admin-access-review.md` + ký §4 (mọi admin không có MFA
   = finding).
9. **OPS-03 — Crontab installs (ops-alerts + backup):** dòng crontab trong
   `scripts/ops-alerts-cron.sh:12-13` + `docs/backup-restore.md` §1.
10. **OPS-04 — Auto-release cron KHÔNG install trong private beta** (route
    trả 503 khi finance off — cron sẽ log fail mỗi giờ).
11. **OPS-05 — nginx HSTS + `limit_req`** ở edge (`docs/deployment.md` §3
    hiện chưa có — app-level HSTS là HSTS duy nhất tới khi cấu hình nginx).
12. **SEC-01 — CSP flip Report-Only → enforce** (một commit đổi tên header
    trong `next.config.ts`) — CHỈ SAU `npm run docker:smoke` + manual
    page-load trên stack deploy.
13. **OPS-09 — Grant `private_beta_buyer` memberships** qua
    `/admin/users?u=<id>` (self-grant forbidden; staff cần `internal`/
    `private_beta_buyer` do admin KHÁC cấp — FD-R33); broader buyer
    invitations chỉ SAU §12.1 + FD-R30.
14. **OPS-10 — One-time re-login:** xác nhận đã thông báo re-login cho người
    dùng beta (session cutover Batch 2 — RR-6, đã qua).
15. **OPS-07 — Demo seed `src/prisma/seed.ts` KHÔNG BAO GIỜ chạy vào
    production** (B2 R15) — attestation của người deploy.

**Founder-only (không phải việc deploy):** duyệt 6 policy (FD-R34/FD-R4),
quyết 28 hàng FD-mirror, ký 26 hàng FOUNDER của checklist (§12-12/13/15,
§12.1-02..06/08, §9-08, §9-10 + các hàng OPS/SEC trên sau khi chạy).

## 17. Deviations ghi nhận (corrections doc — chấp nhận, không phải vi phạm)

- **Item 15:** finance-table set theo shipped writer-verified classification
  (9 finance-only CRITICAL + 3 cascade-affected delete→WARN; `PriceHistory`/
  `Cart`/`Review` non-finance) — không theo danh sách 12 bảng của plan.
- **Item 17:** DB reach production qua image `migrate` trên compose network
  (không `docker exec loaviet-db psql` trực tiếp) — cùng intent, không port.
- **Item 19:** cron liveness qua heartbeat file mtime (không parse log);
  auto-release cron KHÔNG install (OPS-04).
- **Item 22:** copy-safety có allowlist negation thứ 3 (Batch 2 §6.2
  explainer) — ghi trong security review copy section.
- **Item 35:** admin-access-review ship 2 transports (ORM + psql) +
  production wrapper — finding codes đúng plan.
- **Task 10:** drill scratch KHÔNG re-run tại Task 10 (evidence dated
  2026-10-08 đã ghi trên graph cuối — corrections item 9; không có gì trong
  Batch 8 sau đó đụng drill/backup scripts hay schema); dry run ops-alerts
  chạy mode docker (worktree không có `.env` — auto mode, corrections item 18
  posture); `rg` thay bằng `git grep` (item 33).
- **Song song (không phải deviation của corrections):** session review-fix
  Task 9 chạy cùng worktree trong lúc Task 10 chạy acceptance set bản đầu —
  các fix của nó (checklist + gate script + test) land sau đó trong `1481e35`
  + `6315baf` (KHÔNG còn working-tree-only); doc này refresh vòng 2 ghi lại
  đúng trạng thái cuối của tree (§1, §5) — gate re-run trên tree đó cho cùng
  tập gate đỏ.

## 18. Verdict cuối

**Cổng §9 Batch 8 (implementation): PASS** — mọi deliverable Task 1–9 trong
tree, mọi suite xanh (refresh vòng 2 re-run: **2485 unit / 180 contract / gate
abuse-matrix 90**), mọi scan classified, migration graph identical, mọi
task review độc lập + confirmed findings đã fix, **review vòng 2 của fix
Task 9 + doc này đã fix (§1 — `541624a` + `0fbbf1a` + commit này)**. **Cổng release
(private-beta launch): ĐỎ — ĐÚNG THEO THIẾT KẾ** — `npm run release:gate`
exit 1 với đúng `policy-reviews` + `release-checklist` đỏ (founder sign-off
pending, FD-3 fail-closed); **LAUNCH BLOCKER lớn nhất: production OTP
fail-closed tới khi có provider SMS/email (FD-2/FD-R1)** — không phone
verification ⇒ không seller verification/publication, invite acceptance cần
kênh verified (FD-R69), `/recover` không gửi được mã (§7). Gate xanh khi
founder hoàn thành §15.1–15.3; deploy production theo thứ tự §16.
