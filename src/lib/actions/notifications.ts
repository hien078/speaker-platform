"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/src/prisma/db.client";
import { requireUser } from "@/src/lib/auth";

/** Đánh dấu đã đọc tất cả thông báo của mình */
export async function markAllReadAction(): Promise<void> {
  const user = await requireUser();
  const now = new Date().toISOString();
  await db.orm.public.Notification
    .where({ userId: user.id })
    .where((n) => n.readAt.isNull())
    .update({ readAt: now });
  revalidatePath("/notifications");
  revalidatePath("/");
}
