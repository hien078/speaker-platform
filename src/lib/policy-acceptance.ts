import "server-only";
import { db } from "@/src/prisma/db.client";
import { POLICIES, type PolicyKey } from "@/src/lib/policy-registry";

/**
 * Policy acceptance (terms + privacy) — server-only domain module (zero-cost
 * launch Task D — founder decision 2026-10-12: người dùng phải chấp nhận
 * Điều khoản sử dụng + Chính sách quyền riêng tư trước khi tạo nội dung
 * user-facing; Nghị định 13/2023/NĐ-CP mong đợi explicit consent, còn Terms
 * draft nói "dùng LoaViet = chấp nhận" — consent tường minh ghi tại đăng ký
 * + guard trước mỗi action tạo nội dung).
 *
 * CƠ CHẾ GHI NHẬN: dùng NGUYÊN Batch 2 PolicyAcceptance (spec §3.1 — model
 * `PolicyAcceptance` của migration batch2_identity_security, hằng số chấp
 * nhận của src/lib/seller-verification-policy.ts) — KHÔNG xây cơ chế thứ hai.
 * Row = (userId, policyKey, policyVersion, acceptedAt) với
 * `@@unique([userId, policyKey, policyVersion])` — idempotent theo bộ khóa;
 * version sống trong registry (src/lib/policy-registry.ts) là NGUỒN DUY NHẤT.
 *
 * DRAFT-NOT-REVIEWED (FD-3/FD-R34): terms + privacy hiện là placeholder
 * `DRAFT-NOT-REVIEWED` — acceptance VẪN ghi chuỗi version hiện hành ("v1");
 * khi founder duyệt + bump version (commit của founder, như FD-R4 cho seller
 * rules), guard này tự động chặn lại (đọc version MỚI từ registry) và người
 * dùng re-accept qua /account/policies. KHÔNG backfill consent cho user
 * hiện có — họ chấp nhận trên hành động tiếp theo (release checklist row).
 *
 * Guard đọc FRESH từ DB mỗi call (pattern §4.4/checkSellerPublicationRequirements
 * — KHÔNG tin cache session): version bump hoặc acceptance mới có hiệu lực
 * NGAY LẬP TỨC ở call kế tiếp.
 *
 * KHÔNG "use server" — đây là domain module; action import guard từ đây
 * (B2 hygiene). Client component KHÔNG BAO GIỜ import module này (server-only).
 */

/**
 * Các policy bắt buộc chấp nhận ở cấp tài khoản (founder decision 2026-10-12):
 * terms + privacy. seller_rules KHÔNG nằm ở đây — nó là yêu cầu publication
 * của seller (Batch 2, checkSellerPublicationRequirements), một cơ chế riêng
 * đã có; guard này KHÔNG đụng tới.
 */
export const ACCOUNT_POLICY_KEYS = ["terms", "privacy"] as const satisfies readonly PolicyKey[];

/** Typed error code của guard — form map → thông báo trung tính + link /account/policies. */
export const POLICY_ACCEPTANCE_REQUIRED_ERROR = "POLICY_ACCEPTANCE_REQUIRED";

/** Version hiện hành của một policy theo registry (nguồn duy nhất — bump = quyết định founder). */
export function currentPolicyVersion(key: PolicyKey): string {
  return POLICIES[key].version;
}

/**
 * Các policy (terms/privacy) mà user CHƯA chấp nhận tại version hiện hành của
 * registry — đọc FRESH từ DB (một read mỗi policy, filter userId + policyKey +
  * policyVersion). Trả [] khi đã đủ. User không tồn tại → thiếu cả hai (fail
 * closed — không có đường "ok" nào không qua DB).
 */
export async function missingPolicyAcceptances(userId: string): Promise<PolicyKey[]> {
  const rows = await Promise.all(
    ACCOUNT_POLICY_KEYS.map((key) =>
      db.orm.public.PolicyAcceptance.first({
        userId,
        policyKey: key,
        policyVersion: POLICIES[key].version,
      }),
    ),
  );
  return ACCOUNT_POLICY_KEYS.filter((key, i) => rows[i] === null);
}

/**
 * Guard: throw Error("POLICY_ACCEPTANCE_REQUIRED") khi user còn account-policy
 * (terms/privacy) chưa chấp nhận tại version hiện hành. Caller chịu trách nhiệm
 * phân loại typed error này sang surface của mình (form state / ?error= /
 * 403 JSON) — KHÔNG để ném thẳng thành 500.
 *
 * Áp dụng cho các action TẠO nội dung user-facing (founder decision
 * 2026-10-12): bắt đầu hội thoại MỚI, tạo Deal, create/submit/publish listing
 * (KHÔNG draft autosave), gửi tin nhắn chat. KHÔNG áp dụng: admin console,
 * login, đọc nội dung, markDealOutcome (participation — Batch 6 D10/D2).
 */
export async function assertCurrentPoliciesAccepted(userId: string): Promise<void> {
  if ((await missingPolicyAcceptances(userId)).length > 0) {
    throw new Error(POLICY_ACCEPTANCE_REQUIRED_ERROR);
  }
}

/** Tx context của db.transaction — cùng shape src/lib/actions/listings.ts. */
type TxContext = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Ghi nhận chấp nhận MỘT policy tại version hiện hành — CƠ CHẾ BATCH 2
 * (submitSellerVerificationAction): first-check theo
 * @@unique(userId, policyKey, policyVersion) rồi create nếu thiếu — idempotent
 * trong tx của caller. Concurrent double-create → 23505 trên
 * `PolicyAcceptance_userId_policyKey_policyVersion_key` ném RA KHỎI callback
 * (Postgres abort tx) — caller classify NGOÀI tx (Global Constraints).
 *
 * Gọi TRONG transaction của caller (đăng ký / accept action) — sống chết cùng
 * nghiệp vụ chính; KHÔNG tự mở tx.
 */
export async function recordPolicyAcceptance(
  tx: TxContext,
  userId: string,
  key: PolicyKey,
): Promise<void> {
  const existing = await tx.orm.public.PolicyAcceptance.first({
    userId,
    policyKey: key,
    policyVersion: POLICIES[key].version,
  });
  if (existing === null) {
    await tx.orm.public.PolicyAcceptance.create({
      userId,
      policyKey: key,
      policyVersion: POLICIES[key].version,
    });
  }
}
