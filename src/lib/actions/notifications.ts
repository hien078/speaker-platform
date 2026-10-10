"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/src/prisma/db.client";
import { requireUser } from "@/src/lib/auth";

/** Đánh dấu đã đọc tất cả thông báo của mình */
export async function markAllReadAction(): Promise<void> {
  const user = await requireUser();
  const now = new Date().toISOString();
  // updateAll (KHÔNG .update()): terminal đơn-row chỉ update row khớp ĐẦU
  // (select-first-matching-row rồi write WHERE id) — "mark all read" phải
  // update MỌI row unread của user trong MỘT statement.
  await db.orm.public.Notification
    .where({ userId: user.id })
    .where((n) => n.readAt.isNull())
    .updateAll({ readAt: now });
  revalidatePath("/notifications");
  revalidatePath("/");
}
