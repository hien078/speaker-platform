"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/src/prisma/db";
import { requireUser } from "@/src/lib/auth";
import { generateOrderCode, computeCommission } from "@/src/lib/utils";
import { recordLedgerTx, escrowIn, escrowRelease, escrowRefund } from "@/src/lib/ledger";
import { recordStatusChange, getOrCreateCart, processAutoReleases, getAutoReleaseDays } from "@/src/lib/actions/helpers";
import { assertMockPaymentsAllowed } from "@/src/lib/mock-payment";
import { notify } from "@/src/lib/notify";

const AUTO_RELEASE_DAYS = Number(process.env.ESCROW_AUTO_RELEASE_DAYS ?? 7);

type TxContext = Parameters<Parameters<typeof db.transaction>[0]>[0];

type CheckoutItem = { listingId: string; quantity: number };

/**
 * Tạo đơn hàng từ giỏ hàng hoặc mua ngay 1 sản phẩm.
 * - escrow: buyer trả vào nền tảng → tiền được giữ
 * - direct/cod: buyer trả seller trực tiếp, nền tảng ghi nhận hóa đơn hoa hồng
 */
export async function createOrderAction(formData: FormData): Promise<void> {
  const user = await requireUser();

  const paymentMethod = String(formData.get("paymentMethod") ?? "escrow") as "escrow" | "direct" | "cod";
  const shippingAddress = String(formData.get("shippingAddress") ?? "").trim();
  const shippingPhone = String(formData.get("shippingPhone") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim() || null;
  const directListingId = String(formData.get("listingId") ?? "") || null;

  if (!shippingAddress || shippingAddress.length < 8) {
    throw new Error("Vui lòng nhập địa chỉ giao hàng đầy đủ");
  }
  if (!/^0\d{8,9}$/.test(shippingPhone.replace(/\s/g, ""))) {
    throw new Error("Số điện thoại không hợp lệ (vd: 0901234567)");
  }

  // ─── Gom items ───
  let items: CheckoutItem[] = [];
  if (directListingId) {
    items = [{ listingId: directListingId, quantity: 1 }];
  } else {
    const cart = await db.orm.public.Cart.first({ userId: user.id });
    if (cart) {
      const cartItems = await db.orm.public.CartItem
        .where({ cartId: cart.id })
        .include("listing", (l) => l.select("id", "status", "sellerId", "price"))
        .all();
      items = cartItems
        .filter((ci) => ci.listing!.status === "approved" && ci.listing!.sellerId !== user.id)
        .map((ci) => ({ listingId: ci.listing!.id, quantity: ci.quantity }));
    }
  }

  if (items.length === 0) {
    throw new Error("Giỏ hàng trống hoặc sản phẩm không còn khả dụng");
  }

  // ─── Tính tiền & hoa hồng theo danh mục ───
  const listings = await Promise.all(
    items.map(async (it) => {
      const l = await db.orm.public.Listing
        .where({ id: it.listingId })
        .include("category", (c) => c.select("commissionRate"))
        .include("images", (i) => i.select("url").orderBy((img) => img.sortOrder.asc()).limit(1))
        .first();
      if (!l || l.status !== "approved") throw new Error("Có sản phẩm không còn bán");
      if (l.sellerId === user.id) throw new Error("Không thể mua tin đăng của chính mình");
      return { item: it, listing: l };
    }),
  );

  // tách theo seller — mỗi seller 1 đơn
  const bySeller = new Map<string, { item: CheckoutItem; listing: typeof listings[number]["listing"] }[]>();
  for (const { item, listing } of listings) {
    const arr = bySeller.get(listing.sellerId) ?? [];
    arr.push({ item, listing });
    bySeller.set(listing.sellerId, arr);
  }

  const createdOrderIds: string[] = [];

  await db.transaction(async (tx) => {
    for (const [sellerId, entries] of bySeller) {
      let total = 0;
      let commission = 0;

      for (const { item, listing } of entries) {
        total += listing.price * item.quantity;
        commission += Math.round((listing.price * item.quantity * listing.category!.commissionRate) / 100);
      }

      // sellerPayout = tổng − hoa hồng tính ĐÚNG TỪNG ITEM (không dùng rate item đầu)
      const sellerPayout = total - commission;

      const order = await tx.orm.public.Order.create({
        code: generateOrderCode(),
        buyerId: user.id,
        sellerId,
        status: "awaiting_payment",
        totalAmount: total,
        commissionRate: entries[0]!.listing.category!.commissionRate,
        commissionAmount: commission,
        sellerPayout,
        paymentMethod,
        shippingAddress,
        shippingPhone,
        note,
      });
      createdOrderIds.push(order.id);
      await recordStatusChange(tx, order.id, "awaiting_payment", "Đơn được tạo", user.id);

      for (const { item, listing } of entries) {
        await tx.orm.public.OrderItem.create({
          orderId: order.id,
          listingId: listing.id,
          title: listing.title,
          price: listing.price,
          imageUrl: listing.images[0]?.url ?? null,
          quantity: item.quantity,
        });
        // đánh dấu đã bán
        await tx.orm.public.Listing
          .where({ id: listing.id })
          .update({ status: "sold" });
      }

      // tạo payment record
      await tx.orm.public.Payment.create({
        orderId: order.id,
        method: paymentMethod,
        status: "pending",
        amount: total,
        provider: paymentMethod === "escrow" ? "mock" : "manual",
      });
    }
  });

  // xóa giỏ nếu đặt từ giỏ
  if (!directListingId) {
    const cart = await db.orm.public.Cart.first({ userId: user.id });
    if (cart) {
      await db.orm.public.CartItem.where({ cartId: cart.id }).delete();
    }
  }

  revalidatePath("/orders");
  // nếu 1 đơn → thẳng trang thanh toán escrow; nhiều đơn → danh sách
  if (createdOrderIds.length === 1) {
    redirect(`/orders/${createdOrderIds[0]}`);
  }
  redirect("/orders");
}

/** Mock thanh toán escrow: mô phỏng cổng VNPay/MoMo trả về thành công */
export async function payEscrowAction(formData: FormData): Promise<void> {
  assertMockPaymentsAllowed(); // guard server-side — UI ẩn nút không đủ (Next: action là entry point công khai)
  const user = await requireUser();
  const orderId = String(formData.get("orderId") ?? "");

  const order = await db.orm.public.Order.first({ id: orderId });
  if (!order || order.buyerId !== user.id) throw new Error("Không tìm thấy đơn");
  if (order.status !== "awaiting_payment") throw new Error("Đơn không ở trạng thái chờ thanh toán");

  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.orm.public.Payment
      .where({ orderId })
      .update({
        status: "held",
        providerTxnId: `MOCK-${Date.now()}`,
        paidAt: now,
      });
    await tx.orm.public.Order
      .where({ id: orderId })
      .update({
        status: "paid_escrow",
        autoReleaseAt: new Date(Date.now() + await getAutoReleaseDays() * 24 * 60 * 60 * 1000).toISOString(),
      });
    await recordStatusChange(tx, orderId, "paid_escrow", "Buyer thanh toán qua escrow — tiền được giữ", user.id);
    await recordLedgerTx(tx, "payment", orderId, escrowIn(user.id, order.totalAmount, `Escrow đơn ${order.code}`));
  });
  await notify(order.sellerId, "order", `Đơn ${order.code} đã thanh toán`, `${order.buyerId === user.id ? "" : ""}Tiền đã vào escrow — bạn có thể gửi hàng`, `/orders/${orderId}`);

  revalidatePath(`/orders/${orderId}`);
  redirect(`/orders/${orderId}?paid=1`);
}

/** Seller xác nhận đã nhận tiền (direct/cod) → chuyển sang chuẩn bị hàng */
export async function sellerConfirmPaymentAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const orderId = String(formData.get("orderId") ?? "");

  const order = await db.orm.public.Order.first({ id: orderId });
  if (!order || order.sellerId !== user.id) throw new Error("Không tìm thấy đơn");
  // Escrow: tiền do BUYER trả qua cổng — seller KHÔNG được xác nhận hộ
  if (order.paymentMethod === "escrow") {
    throw new Error("Đơn escrow — tiền do người mua thanh toán qua cổng, không cần xác nhận");
  }
  if (!["awaiting_payment", "paid_escrow"].includes(order.status)) {
    throw new Error("Đơn không ở trạng thái chờ xác nhận");
  }

  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.orm.public.Payment.where({ orderId }).update({ status: "held", paidAt: now });
    await tx.orm.public.Order.where({ id: orderId }).update({
      status: "processing",
      autoReleaseAt: new Date(Date.now() + AUTO_RELEASE_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    });
    await recordStatusChange(tx, orderId, "processing", "Seller xác nhận đã nhận tiền", user.id);
  });
  await notify(order.buyerId, "order", `Đơn ${order.code} đang được chuẩn bị`, "Seller đã xác nhận và chuẩn bị gửi hàng", `/orders/${orderId}`);

  revalidatePath(`/orders/${orderId}`);
}

/** Seller gửi hàng — nhập mã vận đơn */
export async function shipOrderAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const orderId = String(formData.get("orderId") ?? "");
  const tracking = String(formData.get("tracking") ?? "").trim();

  const order = await db.orm.public.Order.first({ id: orderId });
  if (!order || order.sellerId !== user.id) throw new Error("Không tìm thấy đơn");
  if (!["paid_escrow", "processing"].includes(order.status)) {
    throw new Error("Đơn chưa sẵn sàng để gửi hàng");
  }

  await db.transaction(async (tx) => {
    await tx.orm.public.Order
      .where({ id: orderId })
      .update({
        status: "shipped",
        note: tracking ? `Mã vận đơn: ${tracking}` : order.note,
        // đồng hồ khiếu nại tính từ lúc GỬI HÀNG — buyer có đủ số ngày admin cấu hình
        autoReleaseAt: new Date(Date.now() + await getAutoReleaseDays() * 24 * 60 * 60 * 1000).toISOString(),
      });
    await recordStatusChange(tx, orderId, "shipped", tracking ? `Mã vận đơn: ${tracking}` : "Seller đã gửi hàng", user.id);
  });
  await notify(order.buyerId, "order", `Đơn ${order.code} đã gửi hàng`, tracking ? `Mã vận đơn: ${tracking}` : "Seller đã gửi hàng cho bạn", `/orders/${orderId}`);
  revalidatePath(`/orders/${orderId}`);
}

/** Ghi giá bán thành công vào PriceHistory cho các item có ProductModel (§12) */
async function recordSoldPrices(orderId: string): Promise<void> {
  const items = await db.orm.public.OrderItem
    .where({ orderId })
    .include("listing", (l) => l.select("productModelId"))
    .all();
  for (const item of items) {
    if (item.listing!.productModelId) {
      await db.orm.public.PriceHistory.create({
        modelId: item.listing!.productModelId,
        listingId: item.listingId,
        price: item.price * item.quantity,
        kind: "sold",
      });
    }
  }
}

/** Buyer xác nhận đã nhận hàng → giải ngân cho seller (trừ hoa hồng) */
export async function confirmReceiptAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const orderId = String(formData.get("orderId") ?? "");

  const order = await db.orm.public.Order.first({ id: orderId });
  if (!order || order.buyerId !== user.id) throw new Error("Không tìm thấy đơn");
  if (!["shipped", "paid_escrow", "processing"].includes(order.status)) {
    throw new Error("Đơn không ở trạng thái có thể xác nhận");
  }

  const now = new Date().toISOString();
  const isEscrow = order.paymentMethod === "escrow";
  await db.transaction(async (tx) => {
    await tx.orm.public.Order
      .where({ id: orderId })
      .update({ status: "completed", escrowReleasedAt: now });
    if (isEscrow) {
      // CHỈ escrow mới có tiền trong nền tảng → giải ngân + ledger
      await tx.orm.public.Payment
        .where({ orderId })
        .update({ status: "released", releasedAt: now });
      await tx.orm.public.Payout.create({
        orderId,
        sellerId: order.sellerId,
        amount: order.sellerPayout,
        status: "released",
      });
      await recordLedgerTx(tx, "payout", orderId, escrowRelease(order.sellerId, order.totalAmount, order.commissionAmount, `Giải ngân đơn ${order.code}`));
    } else {
      // direct/COD: tiền trao tay ngoài nền tảng — chỉ ghi nhận, KHÔNG tạo Payout
      await tx.orm.public.Payment
        .where({ orderId })
        .update({ status: "released", releasedAt: now });
    }
    await recordStatusChange(tx, orderId, "completed", isEscrow
      ? `Buyer xác nhận nhận hàng — giải ngân ${order.sellerPayout}₫ cho seller`
      : `Buyer xác nhận nhận hàng — giao dịch trực tiếp hoàn tất (hoa hồng ${order.commissionAmount}₫ ghi nợ seller)`, user.id);
  });
  await recordSoldPrices(orderId);
  if (isEscrow) {
    await notify(order.sellerId, "order", `Đã giải ngân ${order.sellerPayout.toLocaleString("vi-VN")}₫`, `Đơn ${order.code} hoàn tất — tiền vào ví sau hoa hồng`, `/orders/${orderId}`);
  } else {
    await notify(order.sellerId, "order", `Đơn ${order.code} hoàn tất`, `Giao dịch trực tiếp — hoa hồng ${order.commissionAmount.toLocaleString("vi-VN")}₫ ghi nợ ví`, `/orders/${orderId}`);
  }

  revalidatePath(`/orders/${orderId}`);
  revalidatePath("/orders");
}

/** Buyer hủy đơn (chưa gửi hàng & chưa trả escrow) */
export async function cancelOrderAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const orderId = String(formData.get("orderId") ?? "");

  const order = await db.orm.public.Order.first({ id: orderId });
  if (!order) throw new Error("Không tìm thấy đơn");
  const canCancel =
    (order.buyerId === user.id && ["awaiting_payment", "paid_escrow"].includes(order.status)) ||
    (order.sellerId === user.id && ["awaiting_payment", "paid_escrow", "processing"].includes(order.status));
  if (!canCancel) throw new Error("Không thể hủy đơn ở trạng thái này");

  const payment = await db.orm.public.Payment.where({ orderId }).first();
  const wasHeld = payment?.status === "held";

  await db.transaction(async (tx) => {
    // hoàn tiền escrow về "tài khoản" buyer (mock: đánh dấu refunded)
    if (wasHeld) {
      await tx.orm.public.Payment.where({ orderId }).update({ status: "refunded" });
    }
    await tx.orm.public.Order.where({ id: orderId }).update({ status: "cancelled" });
    await recordStatusChange(tx, orderId, "cancelled", wasHeld ? "Hủy đơn — hoàn tiền escrow cho buyer" : "Hủy đơn", user.id);
    if (wasHeld) {
      await recordLedgerTx(tx, "refund", orderId, escrowRefund(order.buyerId, order.totalAmount, `Hoàn escrow đơn ${order.code}`));
    }
    // trả tin đăng về đang bán
    const items = await tx.orm.public.OrderItem.where({ orderId }).all();
    for (const item of items) {
      await tx.orm.public.Listing.where({ id: item.listingId }).update({ status: "approved" });
    }
  });

  revalidatePath(`/orders/${orderId}`);
  revalidatePath("/orders");
}

/** Mở khiếu nại — đóng băng giải ngân tự động */
export async function openDisputeAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const orderId = String(formData.get("orderId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (reason.length < 10) throw new Error("Vui lòng mô tả rõ vấn đề (tối thiểu 10 ký tự)");

  const order = await db.orm.public.Order.first({ id: orderId });
  if (!order || (order.buyerId !== user.id && order.sellerId !== user.id)) {
    throw new Error("Không tìm thấy đơn");
  }
  if (!["paid_escrow", "processing", "shipped"].includes(order.status)) {
    throw new Error("Đơn không ở trạng thái có thể khiếu nại");
  }

  await db.transaction(async (tx) => {
    await tx.orm.public.Dispute.create({
      orderId,
      openedById: user.id,
      reason,
      status: "open",
    });
    await tx.orm.public.Order.where({ id: orderId }).update({ status: "disputed" });
    await recordStatusChange(tx, orderId, "disputed", `Khiếu nại mở: ${reason.slice(0, 100)}`, user.id);
  });
  await notify(order.sellerId, "dispute", `Khiếu nại trên đơn ${order.code}`, reason.slice(0, 120), `/orders/${orderId}`);

  revalidatePath(`/orders/${orderId}`);
}

