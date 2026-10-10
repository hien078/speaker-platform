/**
 * Policy hash helper — offline (Batch 8 Task 1, spec §3.1 legal/policy
 * readiness + §5.1.1 offline maintenance command posture: KHÔNG expose qua
 * HTTP/admin UI; chạy từ terminal, read-only, KHÔNG db, KHÔNG env secret).
 *
 *   npx tsx scripts/policy-hash.ts          → in <key> <version> <sha256> mỗi policy
 *   npx tsx scripts/policy-hash.ts --check  → in <key> <version> <sha256> <status>
 *
 * - Founder chạy bản thường khi duyệt: ghi hash vào
 *   docs/operations/policy-review-record.md (Reviewer/Decision là trường
 *   founder-only — spec §4.11).
 * - Release gate (Batch 8 Task 9, scripts/release-gate.sh) tiêu thụ bản
 *   --check: so hash với row duyệt + yêu cầu status === "REVIEWED" (registry)
 *   + Decision == APPROVED (record) — đổi nội dung mà không có row duyệt mới
 *   → gate fail.
 *
 * Hash chỉ phủ POLICY_TEXT (src/content/policies/<key>.ts) — status/version
 * sống trong registry (src/lib/policy-registry.ts), KHÔNG trong content
 * module (S1: flip status không phá hash đã ghi; đổi nội dung thì luôn phá).
 *
 * Script từ chối chạy khi một content module không import được (static
 * import fail → loader throw, exit non-zero — không in hash sai lệch).
 *
 * Import ĐƯỜNG DẪN TƯƠNG ĐỐI (không alias `@/`) — precedent
 * scripts/admin-bootstrap.ts D1: Dockerfile stage migrate KHÔNG copy
 * tsconfig.json → alias không resolve trong container.
 */
import {
  POLICIES,
  POLICY_KEYS,
  policyContentHash,
} from "../src/lib/policy-registry";

function main(): void {
  const check = process.argv.includes("--check");
  for (const key of POLICY_KEYS) {
    const { version, status } = POLICIES[key];
    const hash = policyContentHash(key);
    console.log(check ? `${key} ${version} ${hash} ${status}` : `${key} ${version} ${hash}`);
  }
}

main();
