"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/src/prisma/db.client";
import { requireUser } from "@/src/lib/auth";

/** Lưu / bỏ lưu tin đăng (§28 — Wishlist) */
export async function toggleWishlistAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const listingId = String(formData.get("listingId") ?? "");

  const listing = await db.orm.public.Listing.first({ id: listingId });
  if (!listing) return;

  const existing = await db.orm.public.WishlistItem
    .where({ userId: user.id, listingId })
    .first();

  if (existing) {
    await db.orm.public.WishlistItem.where({ id: existing.id }).delete();
  } else {
    await db.orm.public.WishlistItem.create({ userId: user.id, listingId });
  }

  revalidatePath("/wishlist");
  revalidatePath(`/listings/${listing.slug}`);
}
