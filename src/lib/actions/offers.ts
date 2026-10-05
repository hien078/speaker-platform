"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/src/prisma/db.client";
import { requireUser } from "@/src/lib/auth";
import { generateOrderCode, computeCommission } from "@/src/lib/utils";
import { recordStatusChange } from "@/src/lib/actions/helpers";
import { assertFinancialFeaturesEnabled } from "@/src/lib/financial-features";
import { notify } from "@/src/lib/notify";

const OFFER_EXPIRY_DAYS = 3;

export type OfferFormState = { error?: string };

/** Buyer đề nghị trả giá trên tin cho phép mặc cả */
export async function createOfferAction(
  _prev: OfferFormState,
  formData: FormData,
): Promise<OfferFormState> {
  assertFinancialFeaturesEnabled(); // trả giá = purchase-intent (accept tạo Order) — spec §4.1
  const user = await requireUser();

  const listingId = String(formData.get("listingId") ?? "");
  const amount = Math.round(Number(formData.get("amount") ?? 0));
  const message = String(formData.get("message") ?? "").trim() || null;

  const listing = await db.orm.public.Listing
    .where({ id: listingId })
    .include("category", (c) => c.select("commissionRate"))
    .first();
  if (!listing || listing.status !== "approved") return { error: "Tin không còn bán" };
  if (listing.sellerId === user.id) return { error: "Đây là tin của chính bạn" };
  if (!listing.negotiable) return { error: "Tin này không nhận trả giá" };
  if (!Number.isFinite(amount) || amount < 100_000) return { error: "Đề nghị tối thiểu 100.000₫" };
  if (amount >= listing.price) return { error: `Đề nghị phải thấp hơn giá niêm yết ${listing.price.toLocaleString("vi-VN")}₫` };

  // mỗi buyer chỉ 1 đề nghị đang chờ trên mỗi tin
  const existing = await db.orm.public.Offer
    .where({ listingId, buyerId: user.id, status: "proposed" })
    .first();
  if (existing) return { error: "Bạn đã có đề nghị đang chờ trên tin này" };

  await db.orm.public.Offer.create({
    listingId,
    buyerId: user.id,
    amount,
    message,
    status: "proposed",
    expiresAt: new Date(Date.now() + OFFER_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString(),
  });

  await notify(listing.sellerId, "offer", `Trả giá ${amount.toLocaleString("vi-VN")}₫ trên "${listing.title.slice(0, 40)}"`, message ?? undefined, "/offers");
  revalidatePath("/offers");
  revalidatePath(`/listings/${listing.slug}`);
  redirect("/offers?sent=1");
}

/** Seller phản hồi: accept (tạo đơn escrow) / counter / reject */
export async function respondOfferAction(formData: FormData): Promise<void> {
  assertFinancialFeaturesEnabled(); // accept tạo Order escrow — deny trước read/mutation (spec §4.1)
  const user = await requireUser();
  const offerId = String(formData.get("offerId") ?? "");
  const response = String(formData.get("response") ?? ""); // accept | counter | reject
  const counterAmount = Math.round(Number(formData.get("counterAmount") ?? 0));

  const offer = await db.orm.public.Offer
    .where({ id: offerId })
    .include("listing", (l) => l.select("id", "slug", "sellerId", "price", "status", "categoryId", "title").include("category", (c) => c.select("commissionRate")).include("images", (i) => i.select("url").orderBy((img) => img.sortOrder.asc()).limit(1)))
    .first();
  if (!offer) return;
  const listing = offer.listing!;
  if (listing.sellerId !== user.id) return;
  if (offer.status !== "proposed") return;
  if (listing.status !== "approved") return;
  // offer quá hạn → tự đánh dấu expired, không phản hồi được
  if (offer.expiresAt < new Date().toISOString()) {
    await db.orm.public.Offer
      .where({ id: offerId })
      .update({ status: "expired" });
    return;
  }

  const now = new Date().toISOString();

  if (response === "reject") {
    await db.orm.public.Offer
      .where({ id: offerId })
      .update({ status: "rejected", respondedAt: now });
    await notify(offer.buyerId, "offer", `Đề nghị ${offer.amount.toLocaleString("vi-VN")}₫ bị từ chối`, listing.title.slice(0, 50), "/offers");
    revalidatePath("/offers");
    return;
  }

  if (response === "counter") {
    if (!Number.isFinite(counterAmount) || counterAmount <= offer.amount || counterAmount >= listing.price) {
      return; // phản đề nghị phải nằm giữa đề nghị và giá niêm yết
    }
    await db.orm.public.Offer
      .where({ id: offerId })
      .update({ status: "countered", counterAmount, respondedAt: now });
    await notify(offer.buyerId, "counter", `Seller phản đề nghị ${counterAmount.toLocaleString("vi-VN")}₫`, listing.title.slice(0, 50), "/offers");
    revalidatePath("/offers");
    return;
  }

  if (response === "accept") {
    // tạo đơn escrow ngay tại giá đề nghị
    const { commissionAmount, sellerPayout } = computeCommission(offer.amount, listing.category!.commissionRate);
    const order = await db.orm.public.Order.create({
      code: generateOrderCode(),
      buyerId: offer.buyerId,
      sellerId: listing.sellerId,
      status: "awaiting_payment",
      totalAmount: offer.amount,
      commissionRate: listing.category!.commissionRate,
      commissionAmount,
      sellerPayout,
      paymentMethod: "escrow",
      shippingAddress: "Cập nhật khi thanh toán",
      shippingPhone: "Cập nhật khi thanh toán",
      note: `Đơn từ trả giá — đề nghị ${offer.amount.toLocaleString("vi-VN")}₫ (giá niêm yết ${listing.price.toLocaleString("vi-VN")}₫)`,
    });
    await db.orm.public.OrderItem.create({
      orderId: order.id,
      listingId: listing.id,
      title: listing.title,
      price: offer.amount,
      imageUrl: listing.images[0]?.url ?? null,
      quantity: 1,
    });
    await db.orm.public.Payment.create({
      orderId: order.id,
      method: "escrow",
      status: "pending",
      amount: offer.amount,
      provider: "mock",
    });
    await db.orm.public.Listing
      .where({ id: listing.id })
      .update({ status: "sold" });
    await db.orm.public.Offer
      .where({ id: offerId })
      .update({ status: "accepted", orderId: order.id, respondedAt: now });
    await db.transaction(async (tx) => {
    await recordStatusChange(tx, order.id, "awaiting_payment", `Đơn từ trả giá ${offer.amount.toLocaleString("vi-VN")}₫`, user.id);
  });
    revalidatePath("/offers");
    revalidatePath("/orders");
  }
}

/** Buyer chấp nhận phản đề nghị của seller → đơn escrow tại giá counter */
export async function acceptCounterAction(formData: FormData): Promise<void> {
  assertFinancialFeaturesEnabled(); // counter chấp nhận tạo Order escrow — spec §4.1
  const user = await requireUser();
  const offerId = String(formData.get("offerId") ?? "");

  const offer = await db.orm.public.Offer
    .where({ id: offerId })
    .include("listing", (l) => l.select("id", "slug", "sellerId", "price", "status", "title").include("category", (c) => c.select("commissionRate")).include("images", (i) => i.select("url").orderBy((img) => img.sortOrder.asc()).limit(1)))
    .first();
  if (!offer || offer.buyerId !== user.id) return;
  if (offer.status !== "countered" || !offer.counterAmount) return;
  const listing = offer.listing!;
  if (listing.status !== "approved") return;
  const price = offer.counterAmount; // chốt giá thỏa thuận

  const now = new Date().toISOString();
  const { commissionAmount, sellerPayout } = computeCommission(price, listing.category!.commissionRate);
  const order = await db.orm.public.Order.create({
    code: generateOrderCode(),
    buyerId: offer.buyerId,
    sellerId: listing.sellerId,
    status: "awaiting_payment",
    totalAmount: price,
    commissionRate: listing.category!.commissionRate,
    commissionAmount,
    sellerPayout,
    paymentMethod: "escrow",
    shippingAddress: "Cập nhật khi thanh toán",
    shippingPhone: "Cập nhật khi thanh toán",
    note: `Đơn từ trả giá — thỏa thuận ${price.toLocaleString("vi-VN")}₫`,
  });
  await db.orm.public.OrderItem.create({
    orderId: order.id,
    listingId: listing.id,
    title: listing.title,
    price: price,
    imageUrl: listing.images[0]?.url ?? null,
    quantity: 1,
  });
  await db.orm.public.Payment.create({
    orderId: order.id,
    method: "escrow",
    status: "pending",
    amount: price,
    provider: "mock",
  });
  await db.orm.public.Listing
    .where({ id: listing.id })
    .update({ status: "sold" });
  await db.orm.public.Offer
    .where({ id: offerId })
    .update({ status: "accepted", orderId: order.id, respondedAt: now });
  await db.transaction(async (tx) => {
    await recordStatusChange(tx, order.id, "awaiting_payment", `Đơn từ trả giá ${price.toLocaleString("vi-VN")}₫`, user.id);
  });

  revalidatePath("/offers");
  redirect(`/orders/${order.id}`);
}

/** Buyer rút đề nghị (chưa được phản hồi) */
export async function cancelOfferAction(formData: FormData): Promise<void> {
  assertFinancialFeaturesEnabled(); // cùng ranh giới domain trả giá (spec §4.1)
  const user = await requireUser();
  const offerId = String(formData.get("offerId") ?? "");

  const offer = await db.orm.public.Offer.first({ id: offerId });
  if (!offer || offer.buyerId !== user.id) return;
  if (!["proposed", "countered"].includes(offer.status)) return;

  await db.orm.public.Offer
    .where({ id: offerId })
    .update({ status: "cancelled" });
  revalidatePath("/offers");
}
