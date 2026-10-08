"use server";

import { redirect } from "next/navigation";
import { db } from "@/src/prisma/db.client";
import { requireUser } from "@/src/lib/auth";
import { assertCanStartConversation } from "@/src/lib/moderation";
import { checkRateLimit } from "@/src/lib/rate-limit";
import { assertListingSellerInteractable, CONVERSATION_START_RATE } from "@/src/lib/deal";
import { assertBuyerBetaChatAccess } from "@/src/lib/beta-access";
import { recordConversationStarted } from "@/src/lib/telemetry-recorders";

/** Bắt đầu (hoặc mở lại) hội thoại với seller về một tin đăng */
export async function startConversationAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const listingId = String(formData.get("listingId") ?? "");

  const listing = await db.orm.public.Listing.first({ id: listingId });
  if (!listing) throw new Error("Tin đăng không tồn tại");
  if (listing.sellerId === user.id) {
    throw new Error("Đây là tin đăng của chính bạn");
  }

  // Batch 3 Task 3 (spec §5.5/§7.8, actor-side): block theo BẤT KỌ hướng nào
  // → CHAT_BLOCKED; initiator bị đình chỉ → ACCOUNT_SUSPENDED. Fail closed —
  // KHÔNG redirect vào hội thoại chết; user vẫn đọc lịch sử qua /chat/<id>
  // từ danh sách. Chạy TRƯỚC existing-conversation lookup.
  // Batch 6 D2 (spec §9 Batch 6 "suspended/revoked seller checks" — SUPERSEDE
  // Batch 3 A2 cho NEW chat): counterpart-side §7.8 list (suspension/
  // revocation/membership) giờ ĐƯỢC check trên branch tạo MỚI ở dưới — qua
  // assertListingSellerInteractable; message trong hội thoại CŨ vẫn KHÔNG
  // check counterpart (A2 perimeter giữ nguyên ở POST route).
  await assertCanStartConversation(user.id, listing.sellerId);

  // tìm hội thoại cũ (theo listing + buyer)
  const existing = await db.orm.public.Conversation
    .where({ listingId, buyerId: user.id })
    .first();
  if (existing) {
    // Hội thoại CŨ mở lại BẤT KỂ status (b4-holistic round-3): lịch sử chat
    // vẫn đọc được — trang /chat/<id> tự redact listing không còn công khai.
    // KHÔNG check Batch 6, KHÔNG đốt budget rate limit — mở lại hội thoại đã
    // có không phải "new chat" §7.8/D1.
    redirect(`/chat/${existing.id}`);
  }

  // b4-holistic round-3 (LOW — chat leak): hội thoại MỚI chỉ tạo cho listing
  // APPROVED. Trước fix: buyer có hidden listingId (trang detail load khi
  // listing còn approved) vẫn mở hội thoại mới sau khi listing chuyển
  // pending/rejected/removed — seller edit content chưa duyệt rồi buyer thấy
  // title/ảnh/giá MỚI qua chat (trang detail đã 404). Typed error — KHÔNG
  // tạo Conversation cho listing không công khai. (Batch 6 D1 giữ nguyên
  // check + code này — corrections #7: KHÔNG gọi assertListingStartable.)
  if (listing.status !== "approved") {
    throw new Error("LISTING_NOT_AVAILABLE");
  }

  // ─── Branch tạo MỚI — mọi check Batch 6 (Task 3) CHỈ sống ở đây ────────────
  // §7.1 "chat": 20 hội thoại mới / 10 phút / user — chặn spam mở hội thoại
  // hàng loạt với nhiều seller (fail closed, KHÔNG tạo row).
  const startLimited = checkRateLimit(`chat:start:${user.id}`, CONVERSATION_START_RATE);
  if (!startLimited.allowed) {
    throw new Error("RATE_LIMITED");
  }

  // D2 (spec §9 Batch 6 "suspended/revoked seller checks" — §7.8 seller-side):
  // seller của listing còn tương tác được không (đình chỉ / verification bị
  // thu hồi / membership founding_seller hết hạn hoặc suspended)? Guard đọc
  // FRESH từ DB mỗi call — fail closed. KHÔNG checkSellerPublicationRequirements
  // (đó là cổng publication, không phải chat requirements — xem deal.ts).
  await assertListingSellerInteractable(listing.sellerId);

  // B7 Task 6 (spec §2.1 buyer beta access policy + §7.8 beta-membership
  // status — D4 initiator-only): NGƯỜI BẮT ĐẦU hội thoại phải là active beta
  // participant (cohort ∈ BETA_CHAT_ALLOWED_COHORTS). Guard chạy SAU mọi guard
  // Batch 3/6 (block/suspension/seller-side D2 — ordering pin chat-beta-gate)
  // + SAU existing-conversation lookup (§2.1 chỉ chặn CREATION — pair đã có
  // hội thoại thì redirect như cũ ở branch trên), TRƯỚC khi tạo row hội thoại.
  // throw BETA_MEMBERSHIP_REQUIRED → server action error (fail closed — KHÔNG
  // redirect vào hội thoại chết, KHÔNG tạo row). Policy tắt → no-op (D3).
  await assertBuyerBetaChatAccess(user.id);

  const convo = await db.orm.public.Conversation.create({
    listingId,
    buyerId: user.id,
    sellerId: listing.sellerId,
  });

  // Telemetry (Batch 5 Task 8 — S7): conversation_started CHỈ trên path tạo
  // MỘT (branch existing redirect ở trên KHÔNG qua đây), sau MỌI guard Batch 3
  // (block/suspension) + status approved + Conversation.create thành công (S5).
  // Emit TRƯỚC redirect() — KHÔNG BAO GIỜ trong catch nuốt NEXT_REDIRECT
  // (corrections #15). sessionId THÔ từ SessionUser — emit core tự HMAC (S-10).
  // Recorder fail-open — KHÔNG đổi kết quả action.
  await recordConversationStarted({
    convo: { id: convo.id, listingId: convo.listingId },
    listing: { provinceLevelCode: listing.provinceLevelCode },
    buyerId: user.id,
    sessionId: user.sessionId,
  });

  redirect(`/chat/${convo.id}`);
}
