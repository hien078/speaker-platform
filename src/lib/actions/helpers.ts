/**
 * Helper nội bộ dùng chung giữa các server action.
 * KHÔNG có "use server" — module thường, không bị Next.js expose thành endpoint công khai.
 * Mọi hàm ở đây chỉ được import bởi code server, không bao giờ gửi xuống client.
 */
import { db } from "@/src/prisma/db.client";
import { assertFinancialFeaturesEnabled } from "@/src/lib/financial-features";
import type { ListingPublicationInput } from "@/src/lib/listing-publication";

type TxContext = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Ghi log quản trị (§74) — chỉ gọi từ action đã qua rbac.requireCapability/requireAdminUser */
export async function audit(
  adminId: string,
  action: string,
  entity: string,
  entityId?: string,
  detail?: string,
): Promise<void> {
  await db.orm.public.AdminAuditLog.create({
    adminId,
    action,
    entity,
    entityId: entityId ?? null,
    detail: detail ?? null,
  });
}

/**
 * Tx variant của `audit` (Batch 4 holistic review fix — LOW tx-concurrency):
 * state change + audit row sống chết cùng MỘT transaction — audit fail →
 * rollback TOÀN BỘ (không còn "approved nhưng thiếu audit" khi audit lỗi
 * sau commit). Chỉ dùng BÊN TRONG db.transaction callback (tx.orm — KHÔNG
 * bao giờ global db trong callback).
 */
export async function auditTx(
  tx: TxContext,
  adminId: string,
  action: string,
  entity: string,
  entityId?: string,
  detail?: string,
): Promise<void> {
  await tx.orm.public.AdminAuditLog.create({
    adminId,
    action,
    entity,
    entityId: entityId ?? null,
    detail: detail ?? null,
  });
}

/** Ghi lịch sử chuyển trạng thái đơn (§48) */
export async function recordStatusChange(
  tx: TxContext,
  orderId: string,
  status: string,
  note: string | null,
  actorId: string | null,
): Promise<void> {
  await tx.orm.public.OrderStatusHistory.create({
    orderId,
    status: status as "awaiting_payment",
    note,
    actorId,
  });
}

/** Tạo giỏ hàng nếu chưa có — chỉ gọi sau requireUser */
export async function getOrCreateCart(userId: string): Promise<string> {
  const cart = await db.orm.public.Cart.first({ userId });
  if (cart) return cart.id;
  const created = await db.orm.public.Cart.create({ userId });
  return created.id;
}

// ─── Listing publication input từ DB row (Batch 4 Task 4 — trust boundary) ────

/** Row Listing scalars — structural type (nhận output type của contract). */
type ListingPublicationRow = {
  id: string;
  title: string;
  description: string;
  categoryId: string;
  brandId: string | null;
  productModelId: string | null;
  condition: string;
  price: number;
  negotiable: boolean;
  inventoryContext: string | null;
  includedAccessories: string | null;
  knownDefects: string | null;
  repairHistory: string | null;
  /** Json column — array fulfillment hoặc null. */
  fulfillmentMethods: unknown;
  provinceLevelCode: string | null;
  locationDisplayName: string | null;
};

/**
 * Input publication XÂY TỪ DB ROW (Batch 4 Task 4 — trust boundary, spec §4.5):
 * title/description/price/condition/… đọc từ listing row; imageUrls từ
 * ListingImage rows theo sortOrder (imageSlots song song từ checklistSlot);
 * currentCategorySlug từ Category row của listing.categoryId — KHÔNG tin
 * formData cho bất kỳ trường gate. Caller (submitListingAction /
 * toggleListingVisibilityAction / approveListingAction) đã check
 * ownership/admin TRƯỚC khi gọi (IDOR — read ảnh/category chỉ sau ownership).
 */
export async function listingPublicationInputFromRow(
  listing: ListingPublicationRow,
  sellerId: string,
): Promise<ListingPublicationInput> {
  const [images, category] = await Promise.all([
    db.orm.public.ListingImage
      .where({ listingId: listing.id })
      .orderBy((i) => i.sortOrder.asc())
      .all(),
    db.orm.public.Category.first({ id: listing.categoryId }),
  ]);
  return {
    title: listing.title,
    description: listing.description,
    categoryId: listing.categoryId,
    brandId: listing.brandId,
    productModelId: listing.productModelId,
    condition: listing.condition,
    price: listing.price,
    negotiable: listing.negotiable,
    inventoryContext: listing.inventoryContext,
    includedAccessories: listing.includedAccessories,
    knownDefects: listing.knownDefects,
    repairHistory: listing.repairHistory,
    fulfillmentMethods: Array.isArray(listing.fulfillmentMethods)
      ? (listing.fulfillmentMethods as string[])
      : null,
    provinceLevelCode: listing.provinceLevelCode,
    locationDisplayName: listing.locationDisplayName,
    imageUrls: images.map((i) => i.url),
    imageSlots: images.map((i) => i.checklistSlot ?? null),
    sellerId,
    listingId: listing.id,
    currentCategorySlug: category?.slug,
  };
}

/** Đọc số ngày tự giải ngân từ PlatformSetting — admin cấu hình được (§73) */
export async function getAutoReleaseDays(): Promise<number> {
  const setting = await db.orm.public.PlatformSetting.first({ key: "escrow_auto_release_days" });
  const days = Number(setting?.value);
  return Number.isFinite(days) && days >= 1 && days <= 30 ? days : 7;
}

/**
 * Giải ngân tự động các đơn shipped quá hạn (escrow auto-release).
 * Chỉ được gọi từ admin dashboard / cron — KHÔNG expose như server action.
 * Trả về số đơn đã xử lý.
 */
export async function processAutoReleases(): Promise<number> {
  // Defense-in-depth: cron route đã guard, nhưng hàm này là engine giải ngân
  // reusable — caller tương lai không bypass được ranh giới (plan Task 3, spec §4.1)
  assertFinancialFeaturesEnabled();
  const now = new Date().toISOString();
  const overdue = await db.orm.public.Order
    .where((o) => o.status.eq("shipped"))
    .where((o) => o.autoReleaseAt.lte(now))
    .all();

  let released = 0;
  for (const order of overdue) {
    const applied = await db.transaction(async (tx) => {
      // Claim atomic: chỉ chuyển shipped → completed được nếu vẫn shipped —
      // 2 cron instance chồng nhau (hoặc buyer confirm cùng lúc) không double payout
      // (UPDATE ... WHERE id AND status — 1 statement atomic)
      const claimed = await tx.orm.public.Order
        .where({ id: order.id, status: "shipped" })
        .updateAll({ status: "completed", escrowReleasedAt: now });
      if (claimed.length === 0) return false;

      await tx.orm.public.Payment
        .where({ orderId: order.id })
        .update({ status: "released", releasedAt: now });
      await tx.orm.public.Payout.create({
        orderId: order.id,
        sellerId: order.sellerId,
        amount: order.sellerPayout,
        status: "released",
      });
      await recordStatusChange(tx, order.id, "completed", "Tự giải ngân sau thời gian khiếu nại (không có khiếu nại)", null);
      // ledger giải ngân — escrowRelease
      const { recordLedgerTx, escrowRelease } = await import("@/src/lib/ledger");
      await recordLedgerTx(tx, "payout", order.id, escrowRelease(order.sellerId, order.totalAmount, order.commissionAmount, `Tự giải ngân đơn ${order.code}`));
      return true;
    });
    if (!applied) continue; // đơn đã được xử lý bởi request khác — bỏ qua
    released++;
    // notify cả 2 bên — tiền tự di chuyển phải có vết + báo
    const { notify } = await import("@/src/lib/notify");
    await notify(order.sellerId, "order", `Tự giải ngân ${order.sellerPayout.toLocaleString("vi-VN")}₫`, `Đơn ${order.code} quá hạn khiếu nại — tiền vào ví`, `/orders/${order.id}`);
    await notify(order.buyerId, "order", `Đơn ${order.code} đã hoàn tất`, "Quá hạn khiếu nại 7 ngày — escrow đã giải ngân cho người bán", `/orders/${order.id}`);
  }
  return released;
}
