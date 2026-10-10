"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/src/prisma/db.client";
import { requireUser } from "@/src/lib/auth";
import { getOrCreateCart } from "@/src/lib/actions/helpers";
import { assertFinancialFeaturesEnabled } from "@/src/lib/financial-features";



export async function addToCartAction(formData: FormData): Promise<void> {
  assertFinancialFeaturesEnabled(); // ranh giới tài chính trước mọi read/mutation (spec §4.1)
  const user = await requireUser();
  const listingId = String(formData.get("listingId") ?? "");

  const listing = await db.orm.public.Listing.first({ id: listingId });
  if (!listing || listing.status !== "approved") {
    throw new Error("Sản phẩm không khả dụng");
  }
  if (listing.sellerId === user.id) {
    throw new Error("Không thể thêm tin đăng của chính mình vào giỏ");
  }

  const cartId = await getOrCreateCart(user.id);

  // đã có trong giỏ → tăng số lượng
  const existing = await db.orm.public.CartItem
    .where({ cartId, listingId })
    .first();
  if (existing) {
    await db.orm.public.CartItem
      .where({ id: existing.id })
      .update({ quantity: existing.quantity + 1 });
  } else {
    await db.orm.public.CartItem.create({ cartId, listingId, quantity: 1 });
  }

  revalidatePath("/cart");
  redirect("/cart");
}

export async function updateCartItemAction(formData: FormData): Promise<void> {
  assertFinancialFeaturesEnabled(); // ranh giới tài chính trước mọi read/mutation (spec §4.1)
  const user = await requireUser();
  const itemId = String(formData.get("itemId") ?? "");
  const quantity = Number(formData.get("quantity") ?? 1);

  const item = await db.orm.public.CartItem.first({ id: itemId });
  if (!item) return;
  const cart = await db.orm.public.Cart.first({ id: item.cartId });
  if (!cart || cart.userId !== user.id) return;

  if (quantity <= 0) {
    await db.orm.public.CartItem.where({ id: itemId }).delete();
  } else {
    await db.orm.public.CartItem.where({ id: itemId }).update({ quantity });
  }
  revalidatePath("/cart");
}

export async function removeFromCartAction(formData: FormData): Promise<void> {
  assertFinancialFeaturesEnabled(); // ranh giới tài chính trước mọi read/mutation (spec §4.1)
  const user = await requireUser();
  const itemId = String(formData.get("itemId") ?? "");

  const item = await db.orm.public.CartItem.first({ id: itemId });
  if (!item) return;
  const cart = await db.orm.public.Cart.first({ id: item.cartId });
  if (!cart || cart.userId !== user.id) return;

  await db.orm.public.CartItem.where({ id: itemId }).delete();
  revalidatePath("/cart");
}
