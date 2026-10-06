/**
 * Policy registry — sáu chính sách spec §3.1 legal/policy readiness
 * (Batch 8 Task 1): Terms, Privacy, Marketplace Rules, Seller Rules,
 * Community Rules, Safety Guidance.
 *
 * Mỗi policy gắn với key + version + STATUS + content-hash. Hash chỉ phủ
 * `POLICY_TEXT` (nội dung trong src/content/policies/<key>.ts) — status và
 * version sống Ở ĐÂY, trong registry, KHÔNG trong content module (S1: đổi
 * status không phá hash đã ghi; đổi nội dung thì hash đổi → release gate
 * bắt buộc row duyệt mới).
 *
 * STATUS = "DRAFT-NOT-REVIEWED" cho đến khi founder duyệt văn bản và ghi
 * row vào docs/operations/policy-review-record.md (Decision == APPROVED,
 * hash khớp) — flip status sang "REVIEWED" trong CÙNG commit (FD-3 + spec
 * §4.11 Policy Non-Invention: implementer KHÔNG soạn nội dung pháp lý).
 * Release gate (Batch 8 Task 9) chặn release khi còn policy chưa duyệt —
 * `allPoliciesReviewed()` / `unreviewedPolicies()` là nguồn kiểm tra.
 *
 * Plain module (precedent src/lib/admin-mfa-key.ts / src/lib/provinces.ts):
 * KHÔNG "server-only", KHÔNG db, KHÔNG "use server" — import được bởi cả
 * app/policies/[key]/page.tsx lẫn script tsx offline (scripts/policy-hash.ts).
 *
 * seller_rules: key/version PHẢI khớp hằng số chấp nhận của Batch 2
 * (SELLER_RULES_POLICY_KEY/SELLER_RULES_POLICY_VERSION trong
 * src/lib/seller-verification-policy.ts — PolicyAcceptance ghi theo version
 * đã publish). Module đó import server-only + db nên KHÔNG import được vào
 * đây (script offline không tải nổi) — alignment được ghim bằng test
 * (tests/unit/policy-registry.test.ts import cả hai). FD-R4: bản Seller Rules
 * duyệt ĐẦU TIÊN phải bump version v1 → v2 (commit của founder).
 */
import { createHash } from "node:crypto";

import { POLICY_TEXT as TERMS_TEXT } from "../content/policies/terms";
import { POLICY_TEXT as PRIVACY_TEXT } from "../content/policies/privacy";
import { POLICY_TEXT as MARKETPLACE_RULES_TEXT } from "../content/policies/marketplace-rules";
import { POLICY_TEXT as SELLER_RULES_TEXT } from "../content/policies/seller-rules";
import { POLICY_TEXT as COMMUNITY_RULES_TEXT } from "../content/policies/community-rules";
import { POLICY_TEXT as SAFETY_GUIDANCE_TEXT } from "../content/policies/safety-guidance";

/** Sáu policy spec §3.1 — đủ 6, không thêm bớt. */
export const POLICY_KEYS = [
  "terms",
  "privacy",
  "marketplace_rules",
  "seller_rules",
  "community_rules",
  "safety_guidance",
] as const;

export type PolicyKey = (typeof POLICY_KEYS)[number];

/** REVIEWED chỉ khi bản ghi duyệt khớp hash tồn tại (founder ký). */
export type PolicyStatus = "DRAFT-NOT-REVIEWED" | "REVIEWED";

export type PolicyDefinition = {
  key: PolicyKey;
  /** Tiêu đề hiển thị tiếng Việt. */
  title: string;
  /** "v1" — bump = quyết định sản phẩm đã duyệt + re-acceptance qua Batch 2. */
  version: string;
  /** REVIEWED CHỈ khi bản ghi duyệt khớp hash tồn tại (founder ký). */
  status: PolicyStatus;
  /** ISO date của nội dung hiện tại. */
  updatedAt: string;
};

/** Nội dung shipped của từng policy (placeholder DRAFT-NOT-REVIEWED — FD-3). */
const POLICY_CONTENT: Record<PolicyKey, string> = {
  terms: TERMS_TEXT,
  privacy: PRIVACY_TEXT,
  marketplace_rules: MARKETPLACE_RULES_TEXT,
  seller_rules: SELLER_RULES_TEXT,
  community_rules: COMMUNITY_RULES_TEXT,
  safety_guidance: SAFETY_GUIDANCE_TEXT,
};

/**
 * Registry — status "DRAFT-NOT-REVIEWED" cho đến khi founder duyệt từng văn
 * bản (FD-3). Flip status → "REVIEWED" trong registry (KHÔNG trong content
 * module) cùng commit với row duyệt mới trong policy-review-record.md.
 */
export const POLICIES: Record<PolicyKey, PolicyDefinition> = {
  terms: {
    key: "terms",
    title: "Điều khoản sử dụng",
    version: "v1",
    status: "DRAFT-NOT-REVIEWED",
    updatedAt: "2026-10-06",
  },
  privacy: {
    key: "privacy",
    title: "Chính sách bảo mật",
    version: "v1",
    status: "DRAFT-NOT-REVIEWED",
    updatedAt: "2026-10-06",
  },
  marketplace_rules: {
    key: "marketplace_rules",
    title: "Quy tắc chợ",
    version: "v1",
    status: "DRAFT-NOT-REVIEWED",
    updatedAt: "2026-10-06",
  },
  seller_rules: {
    // key/version khớp SELLER_RULES_POLICY_KEY/VERSION (Batch 2) — ghim bằng test.
    key: "seller_rules",
    title: "Quy tắc người bán",
    version: "v1",
    status: "DRAFT-NOT-REVIEWED",
    updatedAt: "2026-10-06",
  },
  community_rules: {
    key: "community_rules",
    title: "Quy tắc cộng đồng",
    version: "v1",
    status: "DRAFT-NOT-REVIEWED",
    updatedAt: "2026-10-06",
  },
  safety_guidance: {
    key: "safety_guidance",
    title: "Hướng dẫn an toàn giao dịch",
    version: "v1",
    status: "DRAFT-NOT-REVIEWED",
    updatedAt: "2026-10-06",
  },
};

/** Nội dung shipped của policy (từ src/content/policies/<key>.ts). */
export function policyContent(key: PolicyKey): string {
  const text = POLICY_CONTENT[key];
  if (typeof text !== "string") {
    // Fail closed — key lạ không bao giờ render nội dung của policy khác.
    throw new Error(`POLICY_CONTENT_MISSING:${String(key)}`);
  }
  return text;
}

/** sha256(policyContent(key)) hex — hash chỉ phủ POLICY_TEXT (S1). */
export function policyContentHash(key: PolicyKey): string {
  return createHash("sha256").update(policyContent(key), "utf8").digest("hex");
}

/** true khi MỌI status === "REVIEWED" (release gate của Task 9 dùng kèm). */
export function allPoliciesReviewed(): boolean {
  return POLICY_KEYS.every((key) => POLICIES[key].status === "REVIEWED");
}

/** Các policy chưa duyệt — release gate in tên từng policy chưa duyệt. */
export function unreviewedPolicies(): PolicyKey[] {
  return POLICY_KEYS.filter((key) => POLICIES[key].status !== "REVIEWED");
}
