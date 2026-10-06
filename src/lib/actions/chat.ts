"use server";

import { redirect } from "next/navigation";
import { db } from "@/src/prisma/db.client";
import { requireUser } from "@/src/lib/auth";
import { assertCanStartConversation } from "@/src/lib/moderation";

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
    redirect(`/chat/${existing.id}`);
  }

  const convo = await db.orm.public.Conversation.create({
    listingId,
    buyerId: user.id,
    sellerId: listing.sellerId,
  });
  redirect(`/chat/${convo.id}`);
}
