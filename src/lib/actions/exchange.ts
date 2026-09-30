"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/src/prisma/db";
import { requireUser } from "@/src/lib/auth";
import { computeCommission } from "@/src/lib/utils";
import { recordLedgerTx, escrowIn, escrowRelease } from "@/src/lib/ledger";
import { notify } from "@/src/lib/notify";

const AUTO_RELEASE_DAYS = Number(process.env.ESCROW_AUTO_RELEASE_DAYS ?? 7);

export type ExchangeFormState = { error?: string };

/**
 * Buyer gửi đề nghị trao đổi cho một tin đăng:
 * - chọn 1 tin của mình đưa ra đổi, hoặc mô tả sản phẩm
 * - kèm tiền bù (cash topup) — qua escrow nếu > 0
 */
export async function createExchangeOfferAction(
  _prev: ExchangeFormState,
  formData: FormData,
): Promise<ExchangeFormState> {
  const user = await requireUser();

  const listingId = String(formData.get("listingId") ?? "");
  const myListingId = String(formData.get("myListingId") ?? "") || null;
  const myItemDescription = String(formData.get("myItemDescription") ?? "").trim() || null;
  const cashTopup = Math.max(0, Math.round(Number(formData.get("cashTopup") ?? 0)));
  const message = String(formData.get("message") ?? "").trim() || null;

  const listing = await db.orm.public.Listing
    .where({ id: listingId })
    .include("category", (c) => c.select("commissionRate"))
    .first();
  if (!listing || listing.status !== "approved") return { error: "Tin đăng không khả dụng" };
  if (listing.sellerId === user.id) return { error: "Không thể trao đổi với tin của chính mình" };
  if (!listing.acceptExchange) return { error: "Tin này không nhận trao đổi" };
  if (!myListingId && !myItemDescription) {
    return { error: "Chọn sản phẩm của bạn hoặc mô tả sản phẩm đưa ra trao đổi" };
  }

  if (myListingId) {
    const mine = await db.orm.public.Listing.first({ id: myListingId });
    if (!mine || mine.sellerId !== user.id) return { error: "Tin chọn không phải của bạn" };
    if (mine.status !== "approved") return { error: "Tin của bạn phải đang được duyệt để dùng trao đổi" };
  }

  if (cashTopup > 0 && cashTopup < 50_000) {
    return { error: "Tiền bù tối thiểu 50.000₫ (hoặc để 0 nếu không bù tiền)" };
  }

  const offer = await db.orm.public.ExchangeOffer.create({
    listingId,
    buyerId: user.id,
    myListingId,
    myItemDescription,
    cashTopup,
    message,
    status: "proposed",
    commissionRate: listing.category!.commissionRate,
  });

  // mở hội thoại chat nếu chưa có
  const existing = await db.orm.public.Conversation
    .where({ listingId, buyerId: user.id })
    .first();
  if (!existing) {
    await db.orm.public.Conversation.create({
      listingId,
      buyerId: user.id,
      sellerId: listing.sellerId,
    });
  }

  revalidatePath("/exchange");
  redirect(`/exchange?sent=1`);
}

/** Seller chấp nhận / từ chối đề nghị */
export async function respondExchangeOfferAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const offerId = String(formData.get("offerId") ?? "");
  const response = String(formData.get("response") ?? "");

  const offer = await db.orm.public.ExchangeOffer
    .where({ id: offerId })
    .include("listing", (l) => l.select("sellerId", "title"))
    .first();
  if (!offer) return;
  const listing = await db.orm.public.Listing.first({ id: offer.listingId });
  if (!listing || listing.sellerId !== user.id) return;
  if (offer.status !== "proposed") return;
  // chặn chấp nhận trao đổi trên tin đã bán
  if (listing.status !== "approved") return;

  if (response === "accept") {
    await db.orm.public.ExchangeOffer
      .where({ id: offerId })
      .update({ status: "accepted" });
    await notify(offer.buyerId, "offer", `Đề nghị trao đổi được chấp nhận`, `Nạp tiền bù ${offer.cashTopup > 0 ? offer.cashTopup.toLocaleString("vi-VN") + "₫ qua escrow" : "không có"} để bắt đầu trao đổi`, "/exchange");
  } else {
    await db.orm.public.ExchangeOffer
      .where({ id: offerId })
      .update({ status: "rejected" });
    await notify(offer.buyerId, "offer", `Đề nghị trao đổi bị từ chối`, listing.title.slice(0, 50), "/exchange");
  }

  revalidatePath("/exchange");
}

/** Buyer nạp tiền bù vào escrow (mock cổng) */
export async function payExchangeTopupAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const offerId = String(formData.get("offerId") ?? "");

  const offer = await db.orm.public.ExchangeOffer.first({ id: offerId });
  if (!offer || offer.buyerId !== user.id) return;
  if (offer.status !== "accepted") return;
  if (offer.cashTopup <= 0) return;

  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.orm.public.Payment.create({
      orderId: null,
      exchangeOfferId: offerId,
      method: "escrow",
      status: "held",
      amount: offer.cashTopup,
      provider: "mock",
      providerTxnId: `MOCK-EX-${Date.now()}`,
      paidAt: now,
    });
    await tx.orm.public.ExchangeOffer
      .where({ id: offerId })
      .update({ status: "paid" });
    // ledger: escrow nhận tiền bù, buyer ghi nợ
    await recordLedgerTx(tx, "exchange", offerId, escrowIn(offer.buyerId, offer.cashTopup, `Tiền bù trao đổi offer ${offerId.slice(0, 8)}`));
  });

  revalidatePath("/exchange");
}

/** Hoàn tất trao đổi — giải ngân tiền bù cho seller (trừ hoa hồng trên tiền bù) */
export async function completeExchangeAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const offerId = String(formData.get("offerId") ?? "");

  const offer = await db.orm.public.ExchangeOffer.first({ id: offerId });
  if (!offer) return;
  const listing = await db.orm.public.Listing.first({ id: offer.listingId });
  if (!listing) return;

  const isBuyer = offer.buyerId === user.id;
  const isSeller = listing.sellerId === user.id;
  if (!isBuyer && !isSeller) return;
  // có tiền bù → BẮT BUỘC đã nạp (paid) mới được hoàn tất
  if (offer.cashTopup > 0 && offer.status !== "paid") return;
  // không có tiền bù → accepted là đủ
  if (offer.cashTopup === 0 && offer.status !== "accepted") return;

  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    if (offer.cashTopup > 0 && offer.status === "paid") {
      const { commissionAmount, sellerPayout } = computeCommission(offer.cashTopup, offer.commissionRate);
      await tx.orm.public.Payment
        .where({ exchangeOfferId: offerId })
        .update({ status: "released", releasedAt: now });
      await tx.orm.public.Payout.create({
        orderId: null,
        sellerId: listing.sellerId,
        amount: sellerPayout,
        status: "released",
      });
      // ledger: escrow trả tiền bù — seller nhận sau hoa hồng, platform thu hoa hồng
      await recordLedgerTx(tx, "exchange", offerId, escrowRelease(listing.sellerId, offer.cashTopup, commissionAmount, `Giải ngân tiền bù trao đổi offer ${offerId.slice(0, 8)}`));
    }
    await tx.orm.public.ExchangeOffer
      .where({ id: offerId })
      .update({ status: "completed" });
    // đánh dấu 2 tin đã đổi chủ
    await tx.orm.public.Listing
      .where({ id: offer.listingId })
      .update({ status: "sold" });
    if (offer.myListingId) {
      await tx.orm.public.Listing
        .where({ id: offer.myListingId })
        .update({ status: "sold" });
    }
  });

  revalidatePath("/exchange");
}

/** Hủy đề nghị (buyer rút trước khi chấp nhận) */
export async function cancelExchangeOfferAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const offerId = String(formData.get("offerId") ?? "");

  const offer = await db.orm.public.ExchangeOffer.first({ id: offerId });
  if (!offer || offer.buyerId !== user.id) return;
  if (!["proposed", "accepted"].includes(offer.status)) return;

  // hoàn tiền bù nếu đã nạp
  if (offer.status === "accepted" && offer.cashTopup > 0) {
    // tiền chưa nạp (chỉ accepted mới chờ nạp) — không có gì để hoàn
  }

  await db.orm.public.ExchangeOffer
    .where({ id: offerId })
    .update({ status: "cancelled" });
  revalidatePath("/exchange");
}
