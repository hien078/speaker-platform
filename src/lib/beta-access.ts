import "server-only";
import { db } from "@/src/prisma/db.client";

/**
 * Buyer beta access policy — server-only domain module (Batch 7 Task 6 —
 * spec §2.1 "Private Beta Access Model" + §7.8 beta-membership status +
 * §4.9 private-beta authorization).
 *
 * KHÔNG phải action file (directive use server chỉ dành cho action — B2
 * hygiene; module này là domain module mà action import guard từ).
 * Client component KHÔNG BAO GIỜ import module này (import db → server-only
 * marker → client build break). Import CHỈ server-only + db.client
 * (corrections #31 import-graph pin — BFS từ chat.ts/deals.ts phải thấy đúng
 * hai import này).
 *
 * §2.1 buyer-side reading (D4 — Recorded Decisions): guard này check NGƯỜI
 * BẮT ĐẦU hội thoại/Deal (initiator/buyer — Batch 6 D11: actor của
 * createDealAction LÀ buyer). Seller-of-the-listing do Batch 6 D2
 * assertListingSellerInteractable sở hữu (SELLER_SUSPENDED /
 * SELLER_NOT_VERIFIED / SELLER_MEMBERSHIP_INACTIVE) — hai guard compose,
 * Batch 7 KHÔNG viết lại counterpart check.
 *
 * Browsing stays public (§2.1 public visitor + registered-user rights —
 * KHÔNG có browse restriction nào ở đây); message trong hội thoại CŨ do
 * guard Batch 3/6 sở hữu (§2.1 restriction là NEW conversation/Deal
 * CREATION only); outcome marking KHÔNG bị gate (Batch 6 D10/D2 — ongoing
 * deal participation, xem deals.ts).
 */

/**
 * Chính sách beta-access của §2.1 — SERVER-OWNED, không phải client flag,
 * không phải env toggle (§4.9/§4.10 posture). true = restriction ĐANG bật.
 * ⚠️ D3 (S8): đây là MỘT READING của §2.1 — "P0 should support restricting …
 * IF OPERATIONS REQUIRES a tightly controlled test cohort" — KHÔNG phải một
 * mặc định spec phát biểu; private beta là cohort có kiểm soát (§2.1 opening)
 * nên reading fail-closed là BẬT. Giá trị này quyết định LIỆU MỘT BUYER NÀO
 * CÓ THỂ CHAT KHI LAUNCH — founder phải acknowledge (Batch 8 register, S9);
 * đổi giá trị = product decision qua code review, KHÔNG qua request/env.
 * Đường cấp membership cho buyer: /admin/users → setBetaMembershipAction
 * (Batch 2, audited) — không có invitation flow cho buyer trong P0 (A4).
 */
export const BETA_CHAT_REQUIRES_ACTIVE_MEMBERSHIP = true;

/**
 * Cohort được phép bắt đầu hội thoại/Deal mới trong controlled beta (§2.1) —
 * PROVISIONAL (S9): internal + founding_seller + private_beta_buyer (mọi
 * cohort active). Buyer mời qua admin operation (§8.4), founding seller qua
 * invite (Task 3), internal qua seed/admin. Giá trị cohort TƯƠNG LAI fail
 * closed cho tới khi được allowlist (§4.11 — mở rộng là reviewed change).
 */
export const BETA_CHAT_ALLOWED_COHORTS = ["internal", "founding_seller", "private_beta_buyer"] as const;

/**
 * true khi user có ÍT NHẤT một BetaCohortMembership (cohort ∈
 * BETA_CHAT_ALLOWED_COHORTS, status "active", chưa hết hạn). Đọc FRESH từ
 * DB (không cache) — suspended/exited/hết hạn → false NGAY LẬP TỨC (§7.8).
 *
 * Cùng isMembershipActive semantics của Batch 2
 * (seller-verification-policy.ts): expiresAt null = không giới hạn; đã qua =
 * inactive. Filter cohort + expiresAt Ở JS (corrections #16 — mọi unit mock
 * hỗ trợ object predicate, KHÔNG closure op như .in(); where chỉ
 * { userId, status: "active" }).
 */
export async function isActiveBetaParticipant(userId: string): Promise<boolean> {
  const rows = await db.orm.public.BetaCohortMembership.where({
    userId,
    status: "active",
  }).all();
  return rows.some((m) => {
    if (!(BETA_CHAT_ALLOWED_COHORTS as readonly string[]).includes(m.cohort)) return false;
    if (m.expiresAt == null) return true; // null/undefined = không giới hạn
    // Date.parse NaN (giá trị rác) > Date.now() = false → fail closed (hết hạn)
    return Date.parse(m.expiresAt) > Date.now();
  });
}

/**
 * Guard cho việc BẮT ĐẦU hội thoại/Deal mới (§2.1 buyer beta access policy +
 * §7.8 beta-membership status). BETA_CHAT_REQUIRES_ACTIVE_MEMBERSHIP &&
 * !isActiveBetaParticipant → throw Error("BETA_MEMBERSHIP_REQUIRED").
 * Policy tắt → no-op (cơ chế tồn tại, bật/tắt là founder decision — D3).
 *
 * Caller (T4/C1 + C2): startConversationAction create branch — SAU guard
 * Batch 6 (assertListingStartable + assertListingSellerInteractable — D2 đã
 * chặn seller-side), TRƯỚC Conversation.create; createDealAction — SAU
 * assertListingSellerInteractable, TRƯỚC requireDealConversation (actor LÀ
 * buyer, D11). KHÔNG gọi ở: existing-conversation redirect branch (§2.1 chỉ
 * chặn CREATION), POST message route (Batch 3/6 guards),
 * markDealOutcomeAction (Batch 6 D10/D2 — ongoing participation).
 */
export async function assertBuyerBetaChatAccess(userId: string): Promise<void> {
  if (!BETA_CHAT_REQUIRES_ACTIVE_MEMBERSHIP) return; // D3 — policy tắt → no-op
  if (!(await isActiveBetaParticipant(userId))) {
    throw new Error("BETA_MEMBERSHIP_REQUIRED");
  }
}
