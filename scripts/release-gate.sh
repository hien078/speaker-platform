#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# release-gate.sh — private-beta release gate (Batch 8 Task 9; spec §12 +
# §12.1 Supply Readiness Gate + §9 Batch 8 Gate + FD register mirror B3).
#
# CHẠY TRÊN WORKSTATION/CI TẠI RELEASE COMMIT (corrections 2026-10-08 item 8):
# host production docker-only KHÔNG có Node (scripts/ops-alerts-cron.sh:5-8) —
# MỌI bước server-side (drill --file production, access review production,
# crontab install, nginx HSTS/limit_req, CSP flip, migrate/seed/backfill,
# uploads volume /app/data/uploads, grant private_beta_buyer) là CHECKLIST ROW
# người deploy (user) chạy + ký trong
# docs/operations/private-beta-release-checklist.md; gate này chỉ kiểm tra
# DOCS (evidence markdown) + suite local (test/script output trên commit).
#
# 9 gate — MỌI gate chạy HẾT, failures accumulate, tổng hợp cuối, exit ≠ 0
# khi có gate đỏ (pattern scripts/preflight.sh):
#   1. preflight          — scripts/preflight.sh (contract drift + lint + tsc
#                            + unit + build + compose + migration graph)
#   2. integration        — scripts/test-integration.sh (scratch container)
#   3. smoke              — scripts/smoke.sh (scratch stack — finance denial)
#   4. dependency-audit   — npm audit --omit=dev: FAIL trên runtime
#                            critical/high (fail-closed khi không đọc được
#                            báo cáo)
#   5. policy-reviews     — scripts/policy-hash.ts --check ×
#                            docs/operations/policy-review-record.md: registry
#                            status REVIEWED + version/hash khớp + Reviewer/
#                            Reviewed-at không trống + Decision == APPROVED
#                            (đúng — PENDING/REJECTED/ô trống KHÔNG qua;
#                            Review Focus 1: stale review = hash lệch = FAIL)
#   6. evidence-files     — mọi evidence doc tồn tại + không rỗng; findings
#                            register của security review: section VẮNG = FAIL
#                            (không được im lặng qua), hàng CRITICAL+OPEN =
#                            FAIL (case-insensitive, fixed-format table)
#   7. release-checklist  — parse private-beta-release-checklist.md: zero
#                            PENDING ở CẢ HAI bảng; hàng FOUNDER chỉ qua với
#                            Sign-off không trống; MỌI hàng FD-mirror cần
#                            Decision ≠ PENDING + Date không trống (B3)
#   8. finance-off        — FINANCIAL_FEATURES_ENABLED="false" ở CẢ BA file
#                            (.env.example, docker-compose.prod.yml,
#                            tests/docker/docker-compose.smoke.yml — item 32;
#                            mọi dòng khai báo phải là "false")
#   9. abuse-matrix       — 4 contract test Batch 8 (abuse-matrix + copy-safety
#                            + policy-registry + release-gate-checklist — kể
#                            cả register-mirror derivation) chạy trong gate
#
# GATE ĐỎ LÀ KẾT QUẢ ĐÚNG khi policy còn DRAFT-NOT-REVIEWED và hàng founder
# blocking chưa ký (FD-3 fail-closed) — KHÔNG yếu hoá check nào để cho qua.
# Founder duyệt 6 policy (FD-R34, kèm FD-R4 bump v1→v2), quyết 28 register
# item blocking (docs/operations/founder-decision-register.md), chạy + ký
# các hàng OPS/SEC — gate xanh sau đó.
#
# Parsing: grep + POSIX awk (KHÔNG rg — portability; corrections item 8 giữ
# grep-only anyway), explicit exit-code handling mọi chỗ.
# ─────────────────────────────────────────────────────────────────────────────
set -Euo pipefail
cd "$(dirname "$0")/.."

declare -a FAILED=()
gate() { # gate <tên> <lệnh...>
  local name="$1"; shift
  echo ""
  echo "══════ GATE: $name ══════"
  if "$@"; then
    echo "✔ PASS: $name"
  else
    echo "✘ FAIL: $name" >&2
    FAILED+=("$name")
  fi
}

# Ô đã điền: không rỗng, không "—", không "-".
filled() { [[ -n "$1" && "$1" != "—" && "$1" != "-" ]]; }

# ─── Gate 5: policy-reviews ──────────────────────────────────────────────────
gate_policy_reviews() {
  local record="docs/operations/policy-review-record.md"
  if [[ ! -s "$record" ]]; then
    echo "✘ thiếu hoặc rỗng: $record" >&2
    return 1
  fi
  local out parsed n
  # `npm run release:gate` export config npm của user thành env npm_config_* —
  # npmrc global có `allow-scripts=…` → npx in warning stderr (vô nghĩa cho
  # script read-only này). Strip biến đó; capture 2>&1 một lần; CHỈ dòng parse
  # được dạng `<key> <version> <sha256> <status>` được tính — dòng lạ/warning
  # không vào vòng lặp, và thiếu dòng hợp lệ thì fail-closed.
  if ! out="$(env -u npm_config_allow_scripts npx tsx scripts/policy-hash.ts --check 2>&1)"; then
    echo "✘ scripts/policy-hash.ts --check chạy thất bại (content module không import được?):" >&2
    printf '%s\n' "$out" >&2
    return 1
  fi
  parsed="$(printf '%s\n' "$out" | grep -E '^[a-z_]+ v[0-9]+ [0-9a-f]{64} (DRAFT-NOT-REVIEWED|REVIEWED)$' || true)"
  n="$(printf '%s\n' "$parsed" | grep -c . || true)"
  if [[ "$n" -ne 6 ]]; then
    echo "✘ policy-hash --check có $n dòng policy hợp lệ (mong 6) — fail-closed" >&2
    printf '%s\n' "$out" | head -n 10 >&2
    return 1
  fi
  local fail=0 key version hash status row
  while read -r key version hash status; do
    if [[ "$status" != "REVIEWED" ]]; then
      echo "✘ policy \"$key\": registry status \"$status\" ≠ REVIEWED — chưa duyệt (FD-R34)" >&2
      fail=1
      continue
    fi
    row="$(grep -E "^\|[[:space:]]*$key[[:space:]]*\|" "$record" | head -n 1 || true)"
    if [[ -z "$row" ]]; then
      echo "✘ policy \"$key\": không có row trong $record" >&2
      fail=1
      continue
    fi
    # | Policy | Version | sha256 | Reviewer | Reviewed at | Decision | Notes |
    local -a cells
    IFS='|' read -r -a cells <<< "$row"
    local rver rhash reviewer rdate decision
    rver="$(printf '%s' "${cells[2]:-}" | tr -d '[:space:]')"
    rhash="$(printf '%s' "${cells[3]:-}" | tr -d '[:space:]')"
    reviewer="$(printf '%s' "${cells[4]:-}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    rdate="$(printf '%s' "${cells[5]:-}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    decision="$(printf '%s' "${cells[6]:-}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    if [[ "$rver" != "$version" ]]; then
      echo "✘ policy \"$key\": version record \"$rver\" ≠ registry \"$version\"" >&2
      fail=1
    fi
    if [[ "$rhash" != "$hash" ]]; then
      echo "✘ policy \"$key\": hash record \"$rhash\" ≠ hash shipped \"$hash\" — nội dung đổi mà không có row duyệt mới (stale review)" >&2
      fail=1
    fi
    if ! filled "$reviewer"; then
      echo "✘ policy \"$key\": Reviewer trống (\"$reviewer\") — founder-only, chưa duyệt" >&2
      fail=1
    fi
    if ! filled "$rdate"; then
      echo "✘ policy \"$key\": Reviewed-at trống" >&2
      fail=1
    fi
    if [[ "$decision" != "APPROVED" ]]; then
      echo "✘ policy \"$key\": Decision \"$decision\" ≠ APPROVED (PENDING/REJECTED/ô khác không qua)" >&2
      fail=1
    fi
  done < <(printf '%s\n' "$parsed")
  if [[ "$fail" -eq 0 ]]; then
    echo "✔ 6/6 policy: registry REVIEWED + row duyệt APPROVED, hash/version khớp"
  fi
  return "$fail"
}

# ─── Gate 6: evidence-files ──────────────────────────────────────────────────
gate_evidence_files() {
  local fail=0 doc
  # Evidence docs (Tasks 1–8 + corrections item 7: founder-decision-register.md
  # là nguồn machine-parsed của blocking set — evidence-files cũng yêu cầu nó).
  for doc in \
    docs/operations/restore-drill-evidence.md \
    docs/operations/admin-access-review.md \
    docs/operations/private-beta-security-review.md \
    docs/operations/monitoring-signals.md \
    docs/operations/founder-decision-register.md \
    docs/operations/moderation-playbook.md \
    docs/operations/seller-verification-playbook.md \
    docs/operations/concierge-onboarding-playbook.md \
    docs/operations/account-recovery-playbook.md \
    docs/operations/founding-seller-onboarding-checklist.md \
    docs/operations/model-seed-review-procedure.md \
    docs/operations/incident-playbook.md \
    docs/operations/private-beta-finance-shutdown-verification.md \
    docs/operations/private-beta-batch2-identity-security-verification.md \
    docs/operations/private-beta-batch3-trust-safety-verification.md \
    docs/operations/private-beta-batch4-listing-quality-verification.md \
    docs/operations/private-beta-batch5-search-telemetry-verification.md \
    docs/operations/private-beta-batch6-chat-deal-verification.md \
    docs/operations/private-beta-batch7-cohort-operations-verification.md \
    ; do
    if [[ ! -s "$doc" ]]; then
      echo "✘ thiếu hoặc rỗng: $doc" >&2
      fail=1
    fi
  done
  # Restore drill: mục dated + lần drill PASS (evidence có ngày)
  if ! grep -Eq '^### [0-9]{4}-[0-9]{2}-[0-9]{2}' docs/operations/restore-drill-evidence.md 2>/dev/null; then
    echo "✘ restore-drill-evidence.md thiếu mục dated (### YYYY-MM-DD …)" >&2
    fail=1
  fi
  if ! grep -q 'DRILL PASS' docs/operations/restore-drill-evidence.md 2>/dev/null; then
    echo "✘ restore-drill-evidence.md không có lần drill PASS nào (DRILL PASS)" >&2
    fail=1
  fi
  # Admin access review: sign-off (founder-only) + mục dated
  if ! grep -Eq '^## .*[Ss]ign-off' docs/operations/admin-access-review.md 2>/dev/null; then
    echo "✘ admin-access-review.md thiếu section Sign-off" >&2
    fail=1
  fi
  if ! grep -Eq '^### [0-9]{4}-[0-9]{2}-[0-9]{2}' docs/operations/admin-access-review.md 2>/dev/null; then
    echo "✘ admin-access-review.md thiếu mục review dated (### YYYY-MM-DD …)" >&2
    fail=1
  fi
  # Security review findings register: section VẮNG = FAIL (không im lặng qua);
  # fixed-format table không được có hàng CRITICAL + OPEN (case-insensitive).
  local sec="docs/operations/private-beta-security-review.md"
  if ! grep -q '^## Findings register' "$sec" 2>/dev/null; then
    echo "✘ $sec thiếu section '## Findings register' — section vắng = gate FAIL (missing findings register không được qua silently)" >&2
    fail=1
  fi
  if grep -Eiq '^[[:space:]]*\|[[:space:]]*critical[[:space:]]*\|.*\|[[:space:]]*open[[:space:]]*\|' "$sec" 2>/dev/null; then
    echo "✘ findings register có hàng CRITICAL + OPEN (§9 'no known critical security issue')" >&2
    fail=1
  fi
  return "$fail"
}

# ─── Gate 7: release-checklist ────────────────────────────────────────────────
gate_release_checklist() {
  local doc="docs/operations/private-beta-release-checklist.md"
  if [[ ! -s "$doc" ]]; then
    echo "✘ thiếu hoặc rỗng: $doc" >&2
    return 1
  fi
  awk '
    function trim(s) { gsub(/^[ \t]+|[ \t]+$/, "", s); return s }
    BEGIN { fail = 0; n_main = 0; n_founder = 0; n_mirror = 0 }
    /^[[:space:]]*\|/ {
      n = split($0, raw, "|")
      for (i = 1; i <= n; i++) c[i] = trim(raw[i])
      if (c[2] ~ /^FD-R[0-9]+$/) {
        # FD-mirror: | FD | Item | Decision (founder) | Date |
        n_mirror++
        d = c[4]; dt = c[5]
        if (d == "" || d == "—" || d == "-" || tolower(d) == "pending") {
          printf "✘ FD-mirror %s: Decision \"%s\" chưa quyết (PENDING/—/trống)\n", c[2], d > "/dev/stderr"
          fail = 1
        }
        if (dt == "" || dt == "—" || dt == "-") {
          printf "✘ FD-mirror %s: Date trống\n", c[2] > "/dev/stderr"
          fail = 1
        }
      } else if (n >= 8 && c[2] != "" && c[2] != "Ref" && c[2] !~ /^-+$/) {
        # Bảng chính: | Ref | Criterion | Evidence type | Evidence | Status | Sign-off |
        n_main++
        st = c[6]; so = c[7]
        if (st == "PENDING") {
          printf "✘ hàng %s: Status PENDING (evidence chưa có)\n", c[2] > "/dev/stderr"
          fail = 1
        } else if (st == "FOUNDER") {
          n_founder++
          if (so == "" || so == "—" || so == "-") {
            printf "✘ hàng %s: FOUNDER chưa có Sign-off (founder-only)\n", c[2] > "/dev/stderr"
            fail = 1
          }
        } else if (st != "PASS") {
          printf "✘ hàng %s: Status lạ \"%s\" — fail-closed\n", c[2], st > "/dev/stderr"
          fail = 1
        }
      }
    }
    END {
      printf "  (checklist: %d hàng chính [%d FOUNDER], %d hàng FD-mirror)\n", n_main, n_founder, n_mirror > "/dev/stderr"
      if (n_mirror == 0) { printf "✘ không parse được hàng FD-mirror nào\n" > "/dev/stderr"; fail = 1 }
      if (n_main == 0) { printf "✘ không parse được hàng chính nào\n" > "/dev/stderr"; fail = 1 }
      exit fail
    }
  ' "$doc"
}

# ─── Gate 8: finance-off ─────────────────────────────────────────────────────
gate_finance_off() {
  local fail=0 f hits total false_count
  for f in .env.example docker-compose.prod.yml tests/docker/docker-compose.smoke.yml; do
    if [[ ! -f "$f" ]]; then
      echo "✘ thiếu file: $f" >&2
      fail=1
      continue
    fi
    hits="$(grep -n 'FINANCIAL_FEATURES_ENABLED' "$f" || true)"
    if [[ -z "$hits" ]]; then
      echo "✘ $f: không khai báo FINANCIAL_FEATURES_ENABLED (Batch 1 invariant)" >&2
      fail=1
      continue
    fi
    echo "$hits"
    total="$(printf '%s\n' "$hits" | grep -c 'FINANCIAL_FEATURES_ENABLED' || true)"
    false_count="$(printf '%s\n' "$hits" | grep -Ec 'FINANCIAL_FEATURES_ENABLED[=:][[:space:]]*"false"' || true)"
    if [[ "$total" != "$false_count" ]]; then
      echo "✘ $f: MỌI dòng FINANCIAL_FEATURES_ENABLED phải là \"false\" (có $total dòng, chỉ $false_count dòng \"false\")" >&2
      fail=1
    fi
  done
  return "$fail"
}

# ─── Gate 4: dependency-audit ────────────────────────────────────────────────
read_audit_report() { # in ra JSON report hoặc FAIL (tool/network lỗi — fail-closed)
  local out
  # `npm run release:gate` export config npm của user thành biến môi trường
  # npm_config_* cho script con — npmrc global có `allow-scripts=…` → npm audit
  # (npm 11.19, resolveAllowScripts) đọc từ nguồn env và từ chối trong project
  # scope (EALLOWSCRIPTS) dù audit KHÔNG chạy script nào. Strip đúng biến đó
  # cho lần gọi audit này — report/check không đổi (không yếu hoá audit).
  out="$(env -u npm_config_allow_scripts npm audit --omit=dev --json 2>&1)" || true
  # fail-closed: phải đọc được báo cáo JSON (auditReportVersion + metadata)
  if ! printf '%s' "$out" | grep -q '"auditReportVersion"'; then
    echo "✘ npm audit --omit=dev --json không đọc được báo cáo (network/tool lỗi?)" >&2
    printf '%s\n' "$out" | head -n 20 >&2
    return 1
  fi
  if ! printf '%s' "$out" | grep -Eq '"total": ?[0-9]+'; then
    echo "✘ npm audit JSON thiếu metadata.vulnerabilities.total — không parse được" >&2
    return 1
  fi
  printf '%s' "$out"
}

gate_dependency_audit() {
  local out
  # Một retry duy nhất cho tool failure nhất thời (quan sát 1 lần: npm 11.19
  # EALLOWSCRIPTS từ allow-scripts npmrc global trong lúc gate chạy — tree sync
  # trước/sau). FINDING thì fail NGAY, không retry; hai lần đọc không được = FAIL
  # (fail-closed giữ nguyên).
  out="$(read_audit_report)" || out="$(read_audit_report)" || return 1
  if printf '%s' "$out" | grep -Eq '"severity": ?"(critical|high)"'; then
    echo "✘ npm audit --omit=dev có lỗ hổng runtime CRITICAL/HIGH (§9 gate — fail trên critical/high)" >&2
    npm audit --omit=dev >&2 || true
    return 1
  fi
  echo "npm audit --omit=dev: 0 lỗ hổng runtime critical/high (metadata$(printf '%s' "$out" | grep -Eo '"total": ?[0-9]+' | head -n 1))"
  return 0
}

# ─── Chạy 9 gate (mọi gate chạy HẾT — failures accumulate) ───────────────────
gate "preflight" bash scripts/preflight.sh
gate "integration" bash scripts/test-integration.sh
gate "smoke" bash scripts/smoke.sh
gate "dependency-audit" gate_dependency_audit
gate "policy-reviews" gate_policy_reviews
gate "evidence-files" gate_evidence_files
gate "release-checklist" gate_release_checklist
gate "finance-off" gate_finance_off
gate "abuse-matrix" npm test -- tests/unit/abuse-matrix.test.ts tests/unit/copy-safety.test.ts tests/unit/policy-registry.test.ts tests/unit/release-gate-checklist.test.ts

# ─── Tổng hợp ────────────────────────────────────────────────────────────────
echo ""
if [[ ${#FAILED[@]} -eq 0 ]]; then
  echo "RELEASE GATE PASS — mọi gate xanh."
  exit 0
else
  echo "RELEASE GATE FAIL — gate đỏ: ${FAILED[*]}" >&2
  echo "(FAIL là ĐÚNG khi policy còn DRAFT-NOT-REVIEWED + hàng founder blocking chưa ký — FD-3 fail-closed. Founder duyệt 6 policy [FD-R34, kèm FD-R4 bump v1→v2], quyết các register item blocking trong docs/operations/founder-decision-register.md, chạy + ký các hàng OPS/SEC trong checklist — gate xanh sau đó.)" >&2
  exit 1
fi
