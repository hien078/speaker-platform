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
#                            Review Focus 1: stale review = hash lệch = FAIL;
#                            review fix 5: ô placeholder "— (chờ founder)"
#                            KHÔNG tính là đã điền; review fix 6: chọn row
#                            khớp key+version+hash MỚI NHẤT — version bump =
#                            row MỚI [policy-review-record.md bước 5], không
#                            phải row đầu tiên của key)
#   6. evidence-files     — mọi evidence doc tồn tại + không rỗng; findings
#                            register của security review: section VẮNG = FAIL
#                            (không được im lặng qua), hàng CRITICAL+OPEN =
#                            FAIL (case-insensitive; review fix 1: parse THEO
#                            CỘT | Severity | Status | — regex liền hàng không
#                            bao giờ khớp layout thật)
#   7. release-checklist  — parse private-beta-release-checklist.md: zero
#                            PENDING ở CẢ HAI bảng; hàng FOUNDER chỉ qua với
#                            Sign-off không trống (placeholder không là chữ
#                            ký); MỌI hàng FD-mirror cần Decision ≠ PENDING +
#                            Date không trống (B3); review fix 2: tập hàng
#                            founder/user-run bắt buộc được PIN — hàng bị xoá
#                            hay flip sang PASS (không chữ ký) đều FAIL
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
# cd gốc repo khi CHẠY trực tiếp. RELEASE_GATE_SOURCED=1 → script đang được
# SOURCE bởi fixture test (tests/unit/release-gate-checklist.test.ts) — giữ
# cwd của test (hàm đọc path tương đối từ cwd test = gốc repo, hoặc path
# tuyệt đối của fixture override qua env).
if [[ "${RELEASE_GATE_SOURCED:-0}" != "1" ]]; then
  cd "$(dirname "$0")/.."
fi

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

# ─── Fixture test hooks (review 2026-10-10) ───────────────────────────────────
# tests/unit/release-gate-checklist.test.ts SOURCE script này với
# RELEASE_GATE_SOURCED=1 (chỉ định nghĩa hàm — KHÔNG chạy gate) và gọi trực
# tiếp từng check trên fixture file:
#   - check_findings_register <file>                (fix 1 — CRITICAL+OPEN theo cột)
#   - policy_record_row <file> <key> <ver> <sha256> (fix 6 — chọn row duyệt khớp)
#   - filled <ô>                                   (fix 5 — placeholder không là chữ ký)
#   - gate_release_checklist <file>                (fix 2 — pin hàng founder/user-run)
#   - gate_policy_reviews                          (fix 5+6 end-to-end với stub hash)
# Env override CHỈ cho fixture test (mặc định = path/config thật):
#   RELEASE_GATE_POLICY_RECORD, RELEASE_GATE_POLICY_HASH_CMD,
#   RELEASE_GATE_CHECKLIST_DOC, RELEASE_GATE_REQUIRED_FOUNDER_REFS.

# Review fix 2: tập Ref founder/user-run BẮT BUỘC phải có trong checklist.
# Mặc định = mọi hàng Evidence type founder/user-run của checklist thật —
# tests/unit/release-gate-checklist.test.ts drift-pin derive lại từ checklist
# và đối chiếu biến này (thêm/bớt hàng founder/user-run mà quên update = FAIL).
# Hàng bị XOÁ hay FLIP sang PASS (không chữ ký) đều FAIL — gate không thể xanh
# khi thiếu MỘT chữ ký founder/user thật (drill, access review, crontab,
# nginx, CSP flip, secrets, backup, migrate, seed, backfill, uploads, grant).
RELEASE_GATE_REQUIRED_FOUNDER_REFS="${RELEASE_GATE_REQUIRED_FOUNDER_REFS:-§12-12 §12-13 §12-15 §12.1-02 §12.1-03 §12.1-04 §12.1-05 §12.1-06 §12.1-08 §9-08 §9-10 SEC-01 OPS-01 OPS-02 OPS-03 OPS-04 OPS-05 OPS-06 OPS-07 OPS-08 OPS-09 OPS-10 OPS-11 OPS-12 OPS-13 OPS-14}"

# Ô đã điền: không rỗng; KHÔNG placeholder (—, -, "— (chờ founder)",
# chờ/pending/TBD) — review fix 5: ô Reviewer ship là "— (chờ founder)"
# (policy-review-record.md:23-28) và KHÔNG được tính là đã điền — gate
# yêu cầu TÊN founder reviewer, không phải ô đợi founder.
filled() {
  local s="$1"
  [[ -n "$s" ]] || return 1
  case "$s" in
    "—"*) return 1 ;; # bắt đầu bằng em dash (—, "— (chờ founder)")
    "-"*) return 1 ;; # bắt đầu bằng hyphen/dash
  esac
  if printf '%s' "$s" | grep -Eiq 'chờ|pending|tbd'; then
    return 1
  fi
  return 0
}

# Row duyệt khớp key + version + hash MỚI NHẤT (review fix 6): quy trình
# documented policy-review-record.md bước 5 là "version bump = row MỚI" —
# founder GIỮ row v1 PENDING làm history + append row v2 APPROVED.
# `head -n 1` cũ sẽ chọn row v1 cũ và fail sai sau một lần duyệt hợp lệ.
# Row được chọn phải khớp ĐÚNG version + hash của registry output —
# row lệch version/hash (stale review) vẫn FAIL như trước.
policy_record_row() { # <record-md> <key> <version> <sha256> → in row khớp (rỗng = không có)
  awk -F'|' -v key="$2" -v ver="$3" -v hsh="$4" '
    function trim(s) { gsub(/^[ \t]+|[ \t]+$/, "", s); return s }
    index($0, "|") == 1 && trim($2) == key && trim($3) == ver && trim($4) == hsh { sel = $0 }
    END { print sel }
  ' "$1" 2>/dev/null || true
}

# ─── Gate 5: policy-reviews ──────────────────────────────────────────────────
gate_policy_reviews() {
  local record="${RELEASE_GATE_POLICY_RECORD:-docs/operations/policy-review-record.md}"
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
  # (RELEASE_GATE_POLICY_HASH_CMD override chỉ dành cho fixture test.)
  local hash_cmd="${RELEASE_GATE_POLICY_HASH_CMD:-env -u npm_config_allow_scripts npx tsx scripts/policy-hash.ts --check}"
  if ! out="$($hash_cmd 2>&1)"; then
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
    # Review fix 6 (xem policy_record_row): chọn row khớp key + version + hash
    # MỚI NHẤT — không phải row đầu tiên của key (row v1 PENDING giữ làm history).
    row="$(policy_record_row "$record" "$key" "$version" "$hash")"
    if [[ -z "$row" ]]; then
      if ! grep -Eq "^\|[[:space:]]*$key[[:space:]]*\|" "$record" 2>/dev/null; then
        echo "✘ policy \"$key\": không có row nào trong $record" >&2
      else
        echo "✘ policy \"$key\": không có row nào khớp version \"$version\" + hash shipped (stale review — version bump = row MỚI khớp registry, policy-review-record.md bước 5)" >&2
      fi
      fail=1
      continue
    fi
    # | Policy | Version | sha256 | Reviewer | Reviewed at | Decision | Notes |
    local -a cells
    IFS='|' read -r -a cells <<< "$row"
    local reviewer rdate decision
    reviewer="$(printf '%s' "${cells[4]:-}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    rdate="$(printf '%s' "${cells[5]:-}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    decision="$(printf '%s' "${cells[6]:-}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
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

# Findings register của security review: section VẮNG = FAIL (không im lặng
# qua); bảng fixed-format `| Severity | Status | File | … |` — Status NGAY SAU
# Severity. Review fix 1: parse THEO CỘT (awk -F'|', cột 2 = Severity, cột 3 =
# Status) — regex liền hàng `critical\|.*\|open` không bao giờ khớp layout
# thật (không có pipe thứ hai giữa hai ô cạnh nhau) → gate im lặng qua.
# Hàng CRITICAL + OPEN (case-insensitive) = FAIL.
check_findings_register() { # <security-review-md> → 0 sạch / 1 có CRITICAL+OPEN hoặc section vắng
  local sec="$1" fail=0
  if ! grep -q '^## Findings register' "$sec" 2>/dev/null; then
    echo "✘ $sec thiếu section '## Findings register' — section vắng = gate FAIL (missing findings register không được qua silently)" >&2
    fail=1
  fi
  if awk -F'|' '
    function trim(s) { gsub(/^[ \t]+|[ \t]+$/, "", s); return s }
    toupper(trim($2)) == "CRITICAL" && toupper(trim($3)) == "OPEN" { found = 1 }
    END { exit found ? 0 : 1 }
  ' "$sec" 2>/dev/null; then
    echo "✘ findings register có hàng CRITICAL + OPEN (§9 'no known critical security issue')" >&2
    fail=1
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
  # Security review findings register (check riêng — fixture-test được, fix 1).
  local sec="docs/operations/private-beta-security-review.md"
  if ! check_findings_register "$sec"; then
    fail=1
  fi
  return "$fail"
}

# ─── Gate 7: release-checklist ────────────────────────────────────────────────
gate_release_checklist() {
  local doc="${1:-${RELEASE_GATE_CHECKLIST_DOC:-docs/operations/private-beta-release-checklist.md}}"
  if [[ ! -s "$doc" ]]; then
    echo "✘ thiếu hoặc rỗng: $doc" >&2
    return 1
  fi
  awk -v req="$RELEASE_GATE_REQUIRED_FOUNDER_REFS" '
    function trim(s) { gsub(/^[ \t]+|[ \t]+$/, "", s); return s }
    # Ô đã điền (review fix 2/5): không rỗng, không placeholder (—, -,
    # "— (chờ founder)", chờ/pending/tbd) — sign-off placeholder không là chữ ký.
    function filled(s) {
      if (s == "" || s == "—" || s == "-") return 0
      if (index(s, "—") == 1 || index(s, "-") == 1) return 0
      if (tolower(s) ~ /chờ|pending|tbd/) return 0
      return 1
    }
    BEGIN {
      fail = 0; n_main = 0; n_founder = 0; n_mirror = 0
      # Review fix 2: pin TẬP HÀNG founder/user-run bắt buộc (mặc định biến
      # RELEASE_GATE_REQUIRED_FOUNDER_REFS = mọi hàng Evidence type
      # founder/user-run của checklist thật — drift-pin bởi test; fixture
      # test override qua env). Hàng bị XOÁ hay FLIP sang PASS (không chữ ký)
      # đều FAIL — gate không thể xanh nếu thiếu một chữ ký founder/user thật
      # (drill, access review, crontab, nginx, CSP flip, secrets, backup,
      # migrate, seed, backfill, uploads, grant).
      n_req = split(req, reqarr, " ")
      for (i = 1; i <= n_req; i++) required[reqarr[i]] = 0
    }
    /^[[:space:]]*\|/ {
      n = split($0, raw, "|")
      for (i = 1; i <= n; i++) c[i] = trim(raw[i])
      if (c[2] ~ /^FD-R[0-9]+$/) {
        # FD-mirror: | FD | Item | Decision (founder) | Date |
        n_mirror++
        d = c[4]; dt = c[5]
        if (!filled(d)) {
          printf "✘ FD-mirror %s: Decision \"%s\" chưa quyết (PENDING/placeholder/—/trống)\n", c[2], d > "/dev/stderr"
          fail = 1
        }
        if (!filled(dt)) {
          printf "✘ FD-mirror %s: Date trống/placeholder\n", c[2] > "/dev/stderr"
          fail = 1
        }
      } else if (n >= 8 && c[2] != "" && c[2] != "Ref" && c[2] !~ /^-+$/) {
        # Bảng chính: | Ref | Criterion | Evidence type | Evidence | Status | Sign-off |
        n_main++
        st = c[6]; so = c[7]; et = tolower(c[4])
        if (c[2] in required) {
          required[c[2]] = 1
          # Hàng founder/user-run bắt buộc: CHỈ FOUNDER + Sign-off đã ký mới
          # được chấp nhận — PASS không thay được chữ ký (review fix 2).
          if (st != "FOUNDER") {
            printf "✘ hàng %s: hàng founder/user-run bắt buộc phải Status FOUNDER (thấy \"%s\") — PASS/đổi status không thay được chữ ký founder\n", c[2], st > "/dev/stderr"
            fail = 1
          }
        }
        # Bất kỳ hàng nào Evidence type founder/user-run (kể cả Ref mới sau
        # này) cũng phải FOUNDER + ký — không có đường machine-pass nào.
        if (et ~ /founder|user-run/ && st != "FOUNDER") {
          printf "✘ hàng %s: Evidence type \"%s\" là founder/user-run nhưng Status \"%s\" ≠ FOUNDER\n", c[2], c[4], st > "/dev/stderr"
          fail = 1
        }
        if (st == "PENDING") {
          printf "✘ hàng %s: Status PENDING (evidence chưa có)\n", c[2] > "/dev/stderr"
          fail = 1
        } else if (st == "FOUNDER") {
          n_founder++
          if (!filled(so)) {
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
      for (r in required) {
        if (!required[r]) {
          printf "✘ thiếu hàng founder/user-run bắt buộc %s — xoá hàng không làm gate xanh\n", r > "/dev/stderr"
          fail = 1
        }
      }
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
# RELEASE_GATE_SOURCED=1 → script đang được SOURCE (fixture test — xem hook
# ở đầu file): chỉ định nghĩa hàm, KHÔNG chạy gate.
if [[ "${RELEASE_GATE_SOURCED:-0}" == "1" ]]; then
  return 0
fi
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
