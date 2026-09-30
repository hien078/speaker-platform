"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/src/prisma/db";
import { requireAdmin } from "@/src/lib/auth";
import { audit, recordStatusChange } from "@/src/lib/actions/helpers";
import { recordLedgerTx, escrowRelease, escrowRefund } from "@/src/lib/ledger";
import { notify } from "@/src/lib/notify";



/** Duyệt tin đăng */
export async function approveListingAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const listingId = String(formData.get("listingId") ?? "");

  const listing = await db.orm.public.Listing.first({ id: listingId });
  if (!listing || listing.status !== "pending") return;

  await db.orm.public.Listing
    .where({ id: listingId })
    .update({ status: "approved", rejectionReason: null });

  await audit(admin.id, "approve_listing", "Listing", listingId, listing.title);
  const { notify } = await import("@/src/lib/notify");
  await notify(listing.sellerId, "listing", `Tin đã được duyệt: ${listing.title.slice(0, 50)}`, "Tin của bạn đang hiển thị trên chợ", `/listings/${listing.slug}`);
  revalidatePath("/admin/listings");
  revalidatePath("/listings");
}

/** Từ chối tin đăng */
export async function rejectListingAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const listingId = String(formData.get("listingId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim() || "Nội dung không rõ ràng, thiếu thông tin";

  const listing = await db.orm.public.Listing.first({ id: listingId });
  if (!listing || listing.status !== "pending") return;

  await db.orm.public.Listing
    .where({ id: listingId })
    .update({ status: "rejected", rejectionReason: reason });

  await audit(admin.id, "reject_listing", "Listing", listingId, `${listing.title} — lý do: ${reason}`);
  const { notify } = await import("@/src/lib/notify");
  await notify(listing.sellerId, "listing", `Tin bị từ chối: ${listing.title.slice(0, 50)}`, `Lý do: ${reason} — sửa tin để duyệt lại`, "/sell/my");
  revalidatePath("/admin/listings");
}

/** Xử lý khiếu nại: nghiêng về buyer (hoàn tiền) hoặc seller (giải ngân) */
export async function resolveDisputeAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const disputeId = String(formData.get("disputeId") ?? "");
  const resolution = String(formData.get("resolution") ?? "").trim();
  const outcome = String(formData.get("outcome") ?? ""); // resolved_buyer | resolved_seller | closed

  if (resolution.length < 5) return;

  const dispute = await db.orm.public.Dispute.first({ id: disputeId });
  if (!dispute || dispute.status !== "open") return;

  const order = await db.orm.public.Order.first({ id: dispute.orderId });
  if (!order) return;

  const now = new Date().toISOString();

  await db.transaction(async (tx) => {
    await tx.orm.public.Dispute
      .where({ id: disputeId })
      .update({ status: outcome as "resolved_buyer" | "resolved_seller" | "closed", resolution, resolvedAt: now });

    const isEscrowOrder = order.paymentMethod === "escrow";
    if (outcome === "resolved_buyer") {
      await tx.orm.public.Payment
        .where({ orderId: order.id })
        .update({ status: "refunded" });
      await tx.orm.public.Order
        .where({ id: order.id })
        .update({ status: "refunded" });
      await recordStatusChange(tx, order.id, "refunded", `Admin xử lý khiếu nại — nghiêng buyer: ${resolution}`, admin.id);
      if (isEscrowOrder) {
        // CHỈ escrow mới có tiền trong nền tảng để hoàn
        await recordLedgerTx(tx, "refund", order.id, escrowRefund(order.buyerId, order.totalAmount, `Admin hoàn escrow đơn ${order.code}`));
      }
      // trả tin về đang bán
      const items = await tx.orm.public.OrderItem.where({ orderId: order.id }).all();
      for (const item of items) {
        await tx.orm.public.Listing.where({ id: item.listingId }).update({ status: "approved" });
      }
    } else if (outcome === "resolved_seller") {
      await tx.orm.public.Payment
        .where({ orderId: order.id })
        .update({ status: "released", releasedAt: now });
      await tx.orm.public.Order
        .where({ id: order.id })
        .update({ status: "completed", escrowReleasedAt: now });
      if (isEscrowOrder) {
        const existingPayout = await tx.orm.public.Payout.where({ orderId: order.id }).first();
        if (!existingPayout) {
          await tx.orm.public.Payout.create({
            orderId: order.id,
            sellerId: order.sellerId,
            amount: order.sellerPayout,
            status: "released",
          });
        }
        await recordStatusChange(tx, order.id, "completed", `Admin xử lý khiếu nại — giải ngân escrow cho seller: ${resolution}`, admin.id);
        await recordLedgerTx(tx, "payout", order.id, escrowRelease(order.sellerId, order.totalAmount, order.commissionAmount, `Admin giải ngân đơn ${order.code}`));
      } else {
        await recordStatusChange(tx, order.id, "completed", `Admin xử lý khiếu nại — nghiêng seller (giao dịch trực tiếp): ${resolution}`, admin.id);
      }
    } else {
      // đóng băng tiếp tục → trả đơn về shipped để chờ tự giải ngân
      await tx.orm.public.Order
        .where({ id: order.id })
        .update({ status: "shipped" });
      await recordStatusChange(tx, order.id, "shipped", `Admin đóng khiếu nại — đơn tiếp tục chờ xác nhận: ${resolution}`, admin.id);
    }
  });

  await audit(admin.id, "resolve_dispute", "Dispute", disputeId, `Đơn ${order.code}: ${resolution}`);
  await notify(order.buyerId, "dispute", `Khiếu nại đơn ${order.code} đã xử lý`, resolution.slice(0, 120), `/orders/${order.id}`);
  await notify(order.sellerId, "dispute", `Khiếu nại đơn ${order.code} đã xử lý`, resolution.slice(0, 120), `/orders/${order.id}`);
  revalidatePath("/admin/disputes");
  revalidatePath(`/orders/${order.id}`);
}

/** Cập nhật % hoa hồng danh mục */
export async function updateCommissionAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const categoryId = String(formData.get("categoryId") ?? "");
  const commissionRate = Math.min(30, Math.max(0, Number(formData.get("commissionRate") ?? 5)));

  const category = await db.orm.public.Category.first({ id: categoryId });
  if (!category) return;

  await db.orm.public.Category
    .where({ id: categoryId })
    .update({ commissionRate });

  await audit(admin.id, "update_commission", "Category", categoryId, `${category.name}: ${commissionRate}%`);
  revalidatePath("/admin/settings");
}

/** Cấu hình nền tảng (key-value) */
export async function updateSettingAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const key = String(formData.get("key") ?? "");
  const value = String(formData.get("value") ?? "").trim();
  if (!key) return;

  const existing = await db.orm.public.PlatformSetting.first({ key });
  if (existing) {
    await db.orm.public.PlatformSetting.where({ key }).update({ value });
  } else {
    await db.orm.public.PlatformSetting.create({ key, value });
  }

  await audit(admin.id, "update_setting", "PlatformSetting", key, value);
  revalidatePath("/admin/settings");
}

/** Xác minh người bán (KYC) */
export async function toggleSellerVerificationAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const userId = String(formData.get("userId") ?? "");

  const target = await db.orm.public.User.first({ id: userId });
  if (!target || target.role === "admin") return;

  const next = !target.isVerifiedSeller;
  await db.orm.public.User
    .where({ id: userId })
    .update({ isVerifiedSeller: next });

  await audit(admin.id, "toggle_seller_verification", "User", userId, `${target.name}: ${next ? "đã xác minh" : "bỏ xác minh"}`);
  revalidatePath("/admin/users");
}
