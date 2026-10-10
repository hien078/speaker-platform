"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/src/prisma/db.client";
import { requireUser } from "@/src/lib/auth";

/**
 * Lưu / bỏ lưu tin đăng (§28 — Wishlist).
 *
 * b4-holistic-2 (CONFIRMED MEDIUM — wishlist leak): THÊM MỚI wishlist item
 * chỉ chấp nhận listing `approved` — ranh giới công khai duy nhất mà wishlist
 * được ghi nhận. Trước fix, listing MỌI status (pending/draft/rejected/hidden/
 * removed) đều được thêm: seller edit approved → pending ghi đè title/ảnh
 * IN PLACE (không shadow revision) → buyer wishlist thấy content chưa duyệt;
 * takedown giữ nguyên content vi phạm trong row → lộ qua badge "Đã gỡ bởi
 * kiểm duyệt". Gate ở ACTION (không chỉ UI) vì action ID public trong client
 * bundle qua listing detail page — gọi trực tiếp được.
 *
 * BỎ item HIỆN CÓ: giữ nguyên cho MỌI status — user phải dọn được entry stale
 * (listing bị takedown / seller ẩn / vào review sau edit), nếu không wishlist
 * kẹt mãi item không đọc được (page redact thành placeholder "Tin không còn
 * hiển thị" + nút Bỏ lưu — app/wishlist/page.tsx).
 */
export async function toggleWishlistAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const listingId = String(formData.get("listingId") ?? "");

  const listing = await db.orm.public.Listing.first({ id: listingId });
  if (!listing) return;

  const existing = await db.orm.public.WishlistItem
    .where({ userId: user.id, listingId })
    .first();

  if (existing) {
    // BỎ lưu — MỌI status (dọn entry stale của listing không còn công khai).
    await db.orm.public.WishlistItem.where({ id: existing.id }).delete();
  } else {
    // THÊM MỚI — chỉ approved (fail closed: content chưa duyệt/bị gỡ không
    // được ghi nhận vào wishlist của ai cả).
    if (listing.status !== "approved") return;
    await db.orm.public.WishlistItem.create({ userId: user.id, listingId });
  }

  revalidatePath("/wishlist");
  revalidatePath(`/listings/${listing.slug}`);
}
