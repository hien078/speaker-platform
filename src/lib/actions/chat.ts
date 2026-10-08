"use server";

import { redirect } from "next/navigation";
import { db } from "@/src/prisma/db.client";
import { requireUser } from "@/src/lib/auth";
import { assertCanStartConversation } from "@/src/lib/moderation";
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
  // từ danh sách. Counterpart bị đình chỉ KHÔNG được check (A2 — không thuộc
  // §7.8 minimal set). Chạy TRƯỚC existing-conversation lookup.
  await assertCanStartConversation(user.id, listing.sellerId);

  // tìm hội thoại cũ (theo listing + buyer)
  const existing = await db.orm.public.Conversation
    .where({ listingId, buyerId: user.id })
    .first();
  if (existing) {
    // Hội thoại CŨ mở lại BẤT KỂ status (b4-holistic round-3): lịch sử chat
    // vẫn đọc được — trang /chat/<id> tự redact listing không còn công khai.
    redirect(`/chat/${existing.id}`);
  }

  // b4-holistic round-3 (LOW — chat leak): hội thoại MỚI chỉ tạo cho listing
  // APPROVED. Trước fix: buyer có hidden listingId (trang detail load khi
  // listing còn approved) vẫn mở hội thoại mới sau khi listing chuyển
  // pending/rejected/removed — seller edit content chưa duyệt rồi buyer thấy
  // title/ảnh/giá MỚI qua chat (trang detail đã 404). Typed error — KHÔNG
  // tạo Conversation cho listing không công khai.
  if (listing.status !== "approved") {
    throw new Error("LISTING_NOT_AVAILABLE");
  }

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
