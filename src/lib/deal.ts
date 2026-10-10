import "server-only";

import { db } from "@/src/prisma/db.client";
import { getBlockState, isUserSuspended } from "@/src/lib/moderation";
import { CONVERSATION_STARTABLE_LISTING_STATUSES } from "@/src/lib/deal-vocab";
import type { DealOutcome } from "@/src/lib/deal-vocab";

/**
 * Deal domain module — server-only (Batch 6 Task 2, spec §5.2/§7.3/§7.8).
 * KHÔNG phải action file (directive use server chỉ dành cho action — đây là
 * domain module; mọi action của Batch 6 Tasks 3–5 import guard từ đây).
 * Client component KHÔNG BAO GIỜ import module này (import db → server-only
 * marker → client build break) — client import deal-vocab.ts.
 *
 * `export *` re-export toàn bộ vocabulary client-safe — server consumers
 * import mọi thứ từ một nơi (moderation.ts precedent).
 *
 * §7.8 enforcement guards — REUSED từ Batch 3, không duplicate (Q5):
 *  - actor-side suspension/block: assertCanStartConversation /
 *    assertCanSendMessage (Batch 3 — gọi TRỰC TIẾP bởi action, không qua đây).
 *  - isUserSuspended / getBlockState: DELEGATION (S10) — module này KHÔNG tự
 *    đọc lại bảng episode đình chỉ / bảng block; mọi read đi qua
 *    @/src/lib/moderation để hành vi (chỉ episode active chặn, block hai
 *    hướng) sống MỘT chỗ.
 *
 * RECORDED DECISION D2 (§7.8 seller-side perimeter — NEW chat + Deal creation
 * only): guard này áp list §7.8 (suspension / seller-verification revocation /
 * beta-membership) lên seller-of-the-listing nơi MỘT tương tác MỚI bắt đầu.
 * Nó KHÔNG gọi checkSellerPublicationRequirements (Batch 2) — đó là cổng
 * publication (email/phone/type/location/rules — publication requirements,
 * không phải chat requirements); §7.8 chỉ liệt kê suspension/revocation/
 * membership cho chat/Deal — dùng đúng subset, fail closed (parity với
 * policy được pin bằng test). Ongoing deal participation (outcome marking
 * của deal ĐÃ tồn tại) KHÔNG bị gate theo counterpart — chỉ theo actor
 * (assertDealOutcomeAllowed; A10).
 */

export * from "@/src/lib/deal-vocab";

// ─── §7.8 seller-side eligibility — dùng chung bởi startConversationAction (Task 3)
//     + createDealAction (Task 4) ────────────────────────────────────────────────

/**
 * Seller của listing còn tương tác được không (mở hội thoại MỚI / nhận Deal MỚI)?
 * Thứ tự FIXED (order pin — test deal-domain): suspension → verification →
 * membership. Fail closed. Đọc FRESH từ DB mỗi call (không cache — revoked/
 * suspended phải chặn NGAY).
 *
 *  1. isUserSuspended(sellerId) [BATCH 3 DELEGATION — S10] → true →
 *     throw Error("SELLER_SUSPENDED")                    [§7.8 "suspension"]
 *  2. SellerVerification.first({ userId }) thiếu HOẶC status ≠ "verified"
 *     (revoked/rejected/needs_review/pending/not_started) →
 *     throw Error("SELLER_NOT_VERIFIED")        [§7.8 "seller-verification revocation"]
 *  3. BetaCohortMembership.first({ userId, cohort: "founding_seller" }) —
 *     active chỉ khi status === "active" VÀ chưa hết hạn (expiresAt null =
 *     không giới hạn; đã qua = inactive — cùng isMembershipActive semantics
 *     của policy Batch 2, corrections #6) → thiếu/inactive/hết hạn →
 *     throw Error("SELLER_MEMBERSHIP_INACTIVE")       [§7.8 "beta-membership status"]
 */
export async function assertListingSellerInteractable(sellerId: string): Promise<void> {
  // 1. §7.8 "suspension" — delegation Batch 3 (chỉ episode active chặn)
  if (await isUserSuspended(sellerId)) {
    throw new Error("SELLER_SUSPENDED");
  }

  // 2. §7.8 "seller-verification revocation" — row thiếu cũng fail closed
  const verification = await db.orm.public.SellerVerification.first({ userId: sellerId });
  if (verification === null || verification.status !== "verified") {
    throw new Error("SELLER_NOT_VERIFIED");
  }

  // 3. §7.8 "beta-membership status" — active + chưa hết hạn (corrections #6)
  const membership = await db.orm.public.BetaCohortMembership.first({
    userId: sellerId,
    cohort: "founding_seller",
  });
  const membershipActive =
    membership !== null &&
    membership.status === "active" &&
    (membership.expiresAt === null || Date.parse(membership.expiresAt) > Date.now());
  if (!membershipActive) {
    throw new Error("SELLER_MEMBERSHIP_INACTIVE");
  }
}

// ─── §5.2 "corresponding allowed conversation relationship" ──────────────────

/**
 * Hội thoại (listing, buyer) tương ứng — Deal chỉ tạo trong hội thoại đã tồn
 * tại (§5.2). Constraint @@unique([listingId, buyerId]) của Conversation bảo
 * (listing, buyer) duy nhất; seller của convo = seller của listing theo cấu
 * trúc tạo convo. Không có → throw Error("DEAL_CONVERSATION_REQUIRED").
 * Trả về convo id — caller ghi vào Deal.conversationId (D9) dùng cho panel
 * lookup + notify link + telemetry (deal sống qua listing deletion, S11).
 */
export async function requireDealConversation(
  listingId: string,
  buyerId: string,
): Promise<{ id: string }> {
  const convo = await db.orm.public.Conversation.where({ listingId, buyerId }).first();
  if (convo === null) {
    throw new Error("DEAL_CONVERSATION_REQUIRED");
  }
  return { id: convo.id };
}

// ─── Participant/IDOR guard (spec §7.3 "cross-account Deal modification") ──────

/**
 * Actor là bên nào của deal? buyer → "buyer"; seller → "seller"; khác →
 * throw Error("DEAL_FORBIDDEN"). Caller dùng CÙNG mã DEAL_FORBIDDEN cho deal
 * không tồn tại (S9 — không existence oracle: probe dealId không phân biệt
 * tồn tại/không).
 */
export async function assertDealParticipant(
  deal: { buyerId: string; sellerId: string },
  actorId: string,
): Promise<"buyer" | "seller"> {
  if (actorId === deal.buyerId) return "buyer";
  if (actorId === deal.sellerId) return "seller";
  throw new Error("DEAL_FORBIDDEN");
}

// ─── §7.8 actor-side guards — REUSE Batch 3, không duplicate (Q5) ──────────────

/**
 * Actor được phép đánh dấu outcome này không? (D10/FD-3 — §5.5 "where
 * appropriate"):
 *  - isUserSuspended(actorId) [BATCH 3 DELEGATION] → throw Error("ACCOUNT_SUSPENDED")
 *    — suspension chặn MỌI marking (kể cả no_deal/cancelled).
 *  - getBlockState(actorId, counterpartId) [BATCH 3 DELEGATION] ≠ "none" →
 *    throw Error("CHAT_BLOCKED") CHỈ KHI outcome === "success" — no_deal/
 *    cancelled ĐƯỢC PHÉP dưới block: chặn không được làm stranded bản ghi kết
 *    quả (một cặp block vẫn ghi nhận được "không đạt thỏa thuận"); success
 *    marking + Deal creation vẫn chặn (creation qua assertCanStartConversation
 *    gọi trực tiếp bởi action — không guard mới ở đây).
 */
export async function assertDealOutcomeAllowed(
  actorId: string,
  counterpartId: string,
  outcome: DealOutcome,
): Promise<void> {
  if (await isUserSuspended(actorId)) {
    throw new Error("ACCOUNT_SUSPENDED");
  }
  if (outcome === "success" && (await getBlockState(actorId, counterpartId)) !== "none") {
    throw new Error("CHAT_BLOCKED");
  }
}

// ─── Listing-status seam (D1/Q10) ──────────────────────────────────────────────

/**
 * Listing còn mở hội thoại MỚI không? listing.status ∈
 * CONVERSATION_STARTABLE_LISTING_STATUSES → resolve; khác → throw
 * Error("LISTING_NOT_CONVERSATIONABLE") — draft/pending/rejected/hidden/sold/
 * removed/archived đều từ chối hội thoại mới (drift test liệt kê MỌI giá trị
 * listing_status từ contract — chỉ "approved" được; D1). Hội thoại CŨ mở lại
 * qua redirect branch của action — không qua guard này.
 */
export async function assertListingStartable(listing: {
  id: string;
  sellerId: string;
  status: string;
}): Promise<void> {
  if (!(CONVERSATION_STARTABLE_LISTING_STATUSES as readonly string[]).includes(listing.status)) {
    throw new Error("LISTING_NOT_CONVERSATIONABLE");
  }
}
