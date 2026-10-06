"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/src/prisma/db.client";
import { requireUser } from "@/src/lib/auth";
import { slugify } from "@/src/lib/utils";
import { isModerationLocked } from "@/src/lib/moderation";
import {
  assertSellerPublicationAllowed,
  formatMissingRequirements,
  type SellerPublicationRequirement,
} from "@/src/lib/seller-verification-policy";

export type ListingFormState = { error?: string };

/**
 * Publication gate (Batch 2 Task 10 — spec §4.4/§4.9): MỌI transition vào
 * duyệt/công khai (pending/approved) của tin đăng đòi seller thỏa Seller
 * Verification Policy v1 — đọc FRESH từ DB qua
 * assertSellerPublicationAllowed (src/lib/seller-verification-policy.ts),
 * kể cả khi seller vừa mới còn quyền (revoked/suspended chặn NGAY).
 * Draft/sửa không chuyển trạng thái thì KHÔNG cần gate (spec §4.4 "Draft
 * creation may be allowed before verification" — ở P0 mọi create vào
 * pending nên create luôn được gate).
 */

/**
 * Chạy publication gate cho MỘT transition — trả form error tiếng Việt khi
 * seller chưa thỏa policy (liệt kê yêu cầu thiếu), null khi cho qua. Lỗi
 * không phải policy (db…) được ném tiếp — fail closed, không masquerade.
 *
 * Review fix Task 5: đình chỉ KHÔNG phải requirement "fixable" tại trang xác
 * minh — seller bị đình chỉ KHÔNG được hướng sang trang đó như thể gỡ được
 * đình chỉ bằng cách hoàn tất hồ sơ. Special-case thông báo riêng.
 */
async function runPublicationGate(sellerId: string): Promise<{ error: string } | null> {
  try {
    await assertSellerPublicationAllowed(sellerId);
    return null;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("SELLER_PUBLICATION_BLOCKED:")) {
      const missing = e.message
        .slice("SELLER_PUBLICATION_BLOCKED:".length)
        .split(",") as SellerPublicationRequirement[];
      // Đình chỉ là sanction của moderation — KHÔNG hoàn tất được tại trang
      // xác minh (chỉ lift bởi admin). Thông báo riêng, KHÔNG kèm hướng dẫn
      // "Hoàn tất tại trang Xác minh người bán" (misleading — review fix Task 5).
      if (missing.includes("account_not_suspended")) {
        return { error: "Tài khoản đang bị đình chỉ — không thể đăng tin." };
      }
      return {
        error: `Chưa đủ điều kiện đăng tin theo chính sách người bán hiện hành — còn thiếu: ${formatMissingRequirements(missing)}. Hoàn tất tại trang Xác minh người bán.`,
      };
    }
    throw e;
  }
}

export async function createListingAction(
  _prev: ListingFormState,
  formData: FormData,
): Promise<ListingFormState> {
  const user = await requireUser();

  // ─── Publication gate (spec §4.4) — TRƯỚC mọi read/mutation ───
  const blocked = await runPublicationGate(user.id);
  if (blocked) return blocked;

  const title = String(formData.get("title") ?? "").trim();
  const categoryId = String(formData.get("categoryId") ?? "");
  const brandId = String(formData.get("brandId") ?? "") || null;
  const condition = String(formData.get("condition") ?? "good");
  const price = Number(formData.get("price") ?? 0);
  const city = String(formData.get("city") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const negotiable = formData.get("negotiable") === "on";
  const acceptExchange = formData.get("acceptExchange") === "on";
  const images = formData.getAll("images").map(String).filter(Boolean);
  const productModelId = String(formData.get("productModelId") ?? "") || null;

  // ─── Validate ───
  if (title.length < 8 || title.length > 120) {
    return { error: "Tiêu đề từ 8–120 ký tự" };
  }
  if (description.length < 20) {
    return { error: "Mô tả tối thiểu 20 ký tự để người mua hiểu rõ sản phẩm" };
  }
  if (!Number.isFinite(price) || price < 100_000 || price > 2_000_000_000) {
    return { error: "Giá từ 100.000₫ đến 2 tỷ ₫" };
  }
  if (!city) return { error: "Chọn khu vực" };
  if (images.length === 0) return { error: "Thêm ít nhất 1 ảnh sản phẩm" };
  if (images.length > 8) return { error: "Tối đa 8 ảnh" };

  const category = await db.orm.public.Category.first({ id: categoryId });
  if (!category) return { error: "Chọn danh mục" };
  if (brandId) {
    const brand = await db.orm.public.Brand.first({ id: brandId });
    if (!brand) return { error: "Thương hiệu không hợp lệ" };
  }

  // slug duy nhất — thêm suffix nếu trùng
  let slug = slugify(title);
  const slugTaken = await db.orm.public.Listing.where({ slug }).first();
  if (slugTaken) slug = `${slug}-${Date.now().toString(36)}`;

  if (productModelId) {
    const model = await db.orm.public.ProductModel.first({ id: productModelId });
    if (!model || model.status !== "approved") return { error: "Model sản phẩm không hợp lệ" };
  }

  const listing = await db.orm.public.Listing.create({
    sellerId: user.id,
    categoryId: category.id,
    brandId,
    title,
    slug,
    description,
    condition: condition as "new" | "like_new" | "good" | "fair",
    price: Math.round(price),
    negotiable,
    acceptExchange,
    status: "pending", // chờ admin duyệt
    city,
    productModelId,
  });
  if (productModelId) {
    await db.orm.public.PriceHistory.create({
      modelId: productModelId,
      listingId: listing.id,
      price: Math.round(price),
      kind: "listed",
    });
  }

  for (let i = 0; i < images.length; i++) {
    await db.orm.public.ListingImage.create({
      listingId: listing.id,
      url: images[i]!,
      sortOrder: i,
    });
  }

  revalidatePath("/sell/my");
  revalidatePath("/admin/listings");
  redirect("/sell/my?created=1");
}

/** Ẩn / hiện lại tin */
export async function toggleListingVisibilityAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const listingId = String(formData.get("listingId") ?? "");

  const listing = await db.orm.public.Listing.first({ id: listingId });
  if (!listing || listing.sellerId !== user.id) return;

  // R5 — moderation lock (Batch 3 Task 6): tin bị moderation takedown thì
  // seller KHÔNG được toggle (không un-remove qua nút hiện lại); helper từ
  // moderation vocab — KHÔNG hardcode chuỗi status.
  if (isModerationLocked(listing.status)) {
    throw new Error("LISTING_MODERATION_LOCKED");
  }

  if (listing.status === "approved") {
    // Ẩn tin = transition RA khỏi công khai — luôn được phép (gỡ tin khỏi chợ
    // không cần gate; hiện lại mới là transition vào công khai).
    // CAS theo status đã đọc — duyệt/ẩn song song không ghi đè nhau;
    // SHOULD-FIX 3: takedown đổi row underneath giữa read và write →
    // conditional write hit 0 rows → typed error (thua thay vì clobber).
    const claimed = await db.orm.public.Listing
      .where({ id: listingId, status: "approved" })
      .updateAll({ status: "hidden" });
    if (claimed.length === 0) throw new Error("LISTING_MODERATION_LOCKED");
  } else if (listing.status === "hidden") {
    // Hiện lại = transition vào CÔNG KHAI — publication gate (spec §4.4, Task 10):
    // seller bị revoke verification / suspend membership không tự đưa tin
    // trở lại công khai. Silent return on block (form void không có error
    // surface — seller thấy tin không hiện lại).
    const blocked = await runPublicationGate(user.id);
    if (blocked) return;
    // CAS như trên — 0 rows → typed error (row đổi tay giữa read và write).
    const claimed = await db.orm.public.Listing
      .where({ id: listingId, status: "hidden" })
      .updateAll({ status: "approved" });
    if (claimed.length === 0) throw new Error("LISTING_MODERATION_LOCKED");
  }

  revalidatePath("/sell/my");
}

/**
 * Sửa tin đăng (chỉ khi chưa bán / không có đơn).
 *
 * Review fix Task 6 (item 7): conditional status write (CAS theo status đã
 * đọc) là write ĐẦU TIÊN trong MỘT tx cùng image diff + PriceHistory —
 * listing bị takedown giữa chừng → 0 rows → typed error → rollback → ảnh
 * của listing đã removed KHÔNG bị đổi. 0 rows được PHÂN LOẠI qua re-read:
 * moderation lock (takedown) → LISTING_MODERATION_LOCKED; admin duyệt/từ
 * chối thường → LISTING_CONCURRENT_CHANGE (distinct typed error — không
 * masquerade).
 */
export async function updateListingAction(
  _prev: ListingFormState,
  formData: FormData,
): Promise<ListingFormState> {
  const user = await requireUser();

  const listingId = String(formData.get("listingId") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  const categoryId = String(formData.get("categoryId") ?? "");
  const brandId = String(formData.get("brandId") ?? "") || null;
  const condition = String(formData.get("condition") ?? "good");
  const price = Number(formData.get("price") ?? 0);
  const city = String(formData.get("city") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const negotiable = formData.get("negotiable") === "on";
  const acceptExchange = formData.get("acceptExchange") === "on";
  const images = formData.getAll("images").map(String).filter(Boolean);
  const productModelId = String(formData.get("productModelId") ?? "") || null;

  const listing = await db.orm.public.Listing.first({ id: listingId });
  if (!listing || listing.sellerId !== user.id) {
    return { error: "Không tìm thấy tin đăng" };
  }
  // R5 — moderation lock (Batch 3 Task 6): tin bị moderation takedown thì
  // seller KHÔNG được sửa (không edit để thoát takedown); helper từ moderation
  // vocab — KHÔNG hardcode chuỗi status.
  if (isModerationLocked(listing.status)) {
    throw new Error("LISTING_MODERATION_LOCKED");
  }
  if (listing.status === "sold") {
    return { error: "Không thể sửa tin đã bán" };
  }

  if (title.length < 8 || title.length > 120) return { error: "Tiêu đề từ 8–120 ký tự" };
  if (description.length < 20) return { error: "Mô tả tối thiểu 20 ký tự" };
  if (!Number.isFinite(price) || price < 100_000 || price > 2_000_000_000) {
    return { error: "Giá từ 100.000₫ đến 2 tỷ ₫" };
  }
  if (!city) return { error: "Chọn khu vực" };
  if (images.length === 0) return { error: "Tin cần ít nhất 1 ảnh" };

  const category = await db.orm.public.Category.first({ id: categoryId });
  if (!category) return { error: "Chọn danh mục" };

  // nội dung thay đổi → quay về chờ duyệt nếu đang ẩn/đã duyệt
  const contentChanged =
    listing.title !== title ||
    listing.description !== description ||
    listing.price !== price ||
    listing.categoryId !== categoryId ||
    listing.condition !== condition;

  // ─── Publication gate (spec §4.4) — TRƯỚC transition vào pending ───
  // Chỉ transition vào duyệt (content-change trên approved/rejected) cần
  // gate; sửa tin đang pending/hidden không chuyển trạng thái mới.
  if (contentChanged && ["approved", "rejected"].includes(listing.status)) {
    const blocked = await runPublicationGate(user.id);
    if (blocked) return blocked; // KHÔNG mutation ảnh/video nào xảy ra trước điểm này
  }

  // ─── MỘT tx: CAS TRƯỚC, image diff SAU (review fix Task 6 item 7) ───────────
  // CAS theo status đã đọc là write ĐẦU TIÊN trong tx — listing bị takedown
  // (hoặc admin duyệt/từ chối) đổi row giữa read và write → 0 rows → typed
  // error → tx rollback → ảnh KHÔNG bao giờ bị đổi tay trên listing đã đổi
  // trạng thái (code cũ mutate ảnh TRƯỚC CAS: listing bị takedown vẫn bị ĐỔI
  // ẢNH dù action throw ngay sau đó).
  await db.transaction(async (tx) => {
    const claimed = await tx.orm.public.Listing
      .where({ id: listingId, status: listing.status })
      .updateAll({
        title,
        categoryId: category.id,
        brandId,
        condition: condition as "new" | "open_box" | "like_new" | "excellent" | "good" | "fair" | "refurbished" | "for_parts",
        price: Math.round(price),
        city,
        description,
        negotiable,
        acceptExchange,
        productModelId,
        status: contentChanged && ["approved", "rejected"].includes(listing.status) ? "pending" : listing.status,
      });
    if (claimed.length === 0) {
      // Phân loại typed error (item 7): moderation lock (takedown) KHÔNG phải
      // lỗi "trạng thái đổi tay" của admin duyệt/từ chối thường — hai lỗi
      // RIÊNG, KHÔNG masquerade (seller bị reject thấy đúng lỗi, không hiểu
      // lầm listing bị moderation takedown). Re-read fresh trong tx —
      // statement sau lock wait thấy commit của bên thắng race (READ
      // COMMITTED); row biến mất → concurrent change.
      const fresh = await tx.orm.public.Listing.first({ id: listingId });
      if (fresh !== null && isModerationLocked(fresh.status)) {
        throw new Error("LISTING_MODERATION_LOCKED");
      }
      throw new Error("LISTING_CONCURRENT_CHANGE");
    }

    // cập nhật ảnh: xóa ảnh cũ không còn, thêm ảnh mới — SAU claim, cùng tx
    const oldImages = await tx.orm.public.ListingImage
      .where({ listingId })
      .orderBy((i) => i.sortOrder.asc())
      .all();
    const oldUrls = oldImages.map((i) => i.url);
    const removed = oldUrls.filter((u) => !images.includes(u));
    for (const url of removed) {
      // deleteAll (KHÔNG .delete()): (listingId, url) KHÔNG có unique constraint —
      // nhiều row có thể cùng url; terminal đơn-row chỉ xoá row ĐẦU.
      await tx.orm.public.ListingImage.where({ listingId, url }).deleteAll();
    }
    let sort = 0;
    for (const url of images) {
      const exists = oldImages.find((i) => i.url === url);
      if (exists) {
        await tx.orm.public.ListingImage.where({ id: exists.id }).update({ sortOrder: sort });
      } else {
        await tx.orm.public.ListingImage.create({ listingId, url, sortOrder: sort });
      }
      sort++;
    }

    const finalModelId = productModelId ?? listing.productModelId;
    if (finalModelId && listing.price !== Math.round(price)) {
      await tx.orm.public.PriceHistory.create({
        modelId: finalModelId,
        listingId: listing.id,
        price: Math.round(price),
        kind: "reprice",
      });
    }
  });

  revalidatePath("/sell/my");
  revalidatePath(`/listings/${listing.slug}`);
  redirect("/sell/my?updated=1");
}
/** Xóa tin (chỉ khi chưa bán / không có đơn) */
export async function deleteListingAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const listingId = String(formData.get("listingId") ?? "");

  const listing = await db.orm.public.Listing.first({ id: listingId });
  if (!listing || listing.sellerId !== user.id) return;
  // R5 — moderation lock (Batch 3 Task 6): tin bị moderation takedown thì
  // seller KHÔNG được xóa — nguồn của moderation record không bị phá bởi
  // chính subject của nó; helper từ moderation vocab.
  if (isModerationLocked(listing.status)) {
    throw new Error("LISTING_MODERATION_LOCKED");
  }
  if (listing.status === "sold") return;

  const orderItems = await db.orm.public.OrderItem.where({ listingId }).all();
  if (orderItems.length > 0) {
    // đã nằm trong đơn — chỉ cho ẩn. CAS theo status đã đọc (SHOULD-FIX 3):
    // 0 rows = row đổi tay giữa read và write → typed error, KHÔNG clobber.
    const claimed = await db.orm.public.Listing
      .where({ id: listingId, status: listing.status })
      .updateAll({ status: "hidden" });
    if (claimed.length === 0) throw new Error("LISTING_MODERATION_LOCKED");
  } else {
    // Xóa CÓ ĐIỀU KIỆN theo status đã đọc (SHOULD-FIX 3) — deleteAll compile
    // điều kiện status VÀO câu DELETE (Prisma 8 .delete() đơn-row select rồi
    // xoá theo id → KHÔNG atomic, takedown song song bị xoá mất). 0 rows = row
    // đổi tay (moderation takedown) → typed error, row SỐNG SÓT.
    const claimed = await db.orm.public.Listing
      .where({ id: listingId, status: listing.status })
      .deleteAll();
    if (claimed.length === 0) throw new Error("LISTING_MODERATION_LOCKED");
    // FK cascade đã xoá ảnh/cart theo Listing; deleteAll giữ đúng nghĩa nếu
    // cascade đổi sau này.
    await db.orm.public.ListingImage.where({ listingId }).deleteAll();
    await db.orm.public.CartItem.where({ listingId }).deleteAll();
  }

  revalidatePath("/sell/my");
}
