"use server";

import { redirect } from "next/navigation";
import { db } from "@/src/prisma/db";
import { requireUser } from "@/src/lib/auth";

/** Bắt đầu (hoặc mở lại) hội thoại với seller về một tin đăng */
export async function startConversationAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const listingId = String(formData.get("listingId") ?? "");

  const listing = await db.orm.public.Listing.first({ id: listingId });
  if (!listing) throw new Error("Tin đăng không tồn tại");
  if (listing.sellerId === user.id) {
    throw new Error("Đây là tin đăng của chính bạn");
  }

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
