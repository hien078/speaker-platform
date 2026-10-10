"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/src/prisma/db.client";
import { requireUser } from "@/src/lib/auth";

/** Buyer đánh giá seller sau khi đơn hoàn tất */
export async function submitReviewAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const orderId = String(formData.get("orderId") ?? "");
  const rating = Math.min(5, Math.max(1, Number(formData.get("rating") ?? 5)));
  const comment = String(formData.get("comment") ?? "").trim() || null;

  const order = await db.orm.public.Order.first({ id: orderId });
  if (!order || order.buyerId !== user.id) throw new Error("Không tìm thấy đơn");
  if (order.status !== "completed") throw new Error("Chỉ đánh giá được khi đơn đã hoàn tất");

  const existing = await db.orm.public.Review.where({ orderId }).first();
  if (existing) throw new Error("Bạn đã đánh giá đơn này rồi");

  await db.orm.public.Review.create({
    orderId,
    authorId: user.id,
    targetUserId: order.sellerId,
    rating,
    comment,
  });

  revalidatePath(`/orders/${orderId}`);
}
