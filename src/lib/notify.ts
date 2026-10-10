import "server-only";
import { db } from "@/src/prisma/db.client";

/** Tạo notification in-app (§42) */
export async function notify(
  userId: string,
  kind: string,
  title: string,
  body?: string,
  link?: string,
): Promise<void> {
  await db.orm.public.Notification.create({
    userId,
    kind,
    title,
    body: body ?? null,
    link: link ?? null,
  });
}

/** Đết thông báo chưa đọc */
export async function unreadCount(userId: string): Promise<number> {
  const agg = await db.orm.public.Notification
    .where({ userId })
    .where((n) => n.readAt.isNull())
    .aggregate((a) => ({ c: a.count() }));
  return agg.c;
}
