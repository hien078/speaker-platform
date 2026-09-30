"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/src/prisma/db";
import { requireUser } from "@/src/lib/auth";
import { slugify } from "@/src/lib/utils";

export type ListingFormState = { error?: string };

export async function createListingAction(
  _prev: ListingFormState,
  formData: FormData,
): Promise<ListingFormState> {
  const user = await requireUser();

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

  if (listing.status === "approved") {
    await db.orm.public.Listing.where({ id: listingId }).update({ status: "hidden" });
  } else if (listing.status === "hidden") {
    await db.orm.public.Listing.where({ id: listingId }).update({ status: "approved" });
  }

  revalidatePath("/sell/my");
}

/** Sửa tin đăng (chỉ khi chưa bán / chưa có đơn) */
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

  // cập nhật ảnh: xóa ảnh cũ không còn, thêm ảnh mới
  const oldImages = await db.orm.public.ListingImage
    .where({ listingId })
    .orderBy((i) => i.sortOrder.asc())
    .all();
  const oldUrls = oldImages.map((i) => i.url);
  const removed = oldUrls.filter((u) => !images.includes(u));
  for (const url of removed) {
    await db.orm.public.ListingImage.where({ listingId, url }).delete();
  }
  let sort = 0;
  for (const url of images) {
    const exists = oldImages.find((i) => i.url === url);
    if (exists) {
      await db.orm.public.ListingImage.where({ id: exists.id }).update({ sortOrder: sort });
    } else {
      await db.orm.public.ListingImage.create({ listingId, url, sortOrder: sort });
    }
    sort++;
  }

  // nội dung thay đổi → quay về chờ duyệt nếu đang ẩn/đã duyệt
  const contentChanged =
    listing.title !== title ||
    listing.description !== description ||
    listing.price !== price ||
    listing.categoryId !== categoryId ||
    listing.condition !== condition;

  await db.orm.public.Listing.where({ id: listingId }).update({
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
    status: contentChanged && listing.status === "approved" ? "pending" : listing.status,
  });
  const finalModelId = productModelId ?? listing.productModelId;
  if (finalModelId && listing.price !== Math.round(price)) {
    await db.orm.public.PriceHistory.create({
      modelId: finalModelId,
      listingId: listing.id,
      price: Math.round(price),
      kind: "reprice",
    });
  }

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
  if (listing.status === "sold") return;

  const orderItems = await db.orm.public.OrderItem.where({ listingId }).all();
  if (orderItems.length > 0) {
    // đã nằm trong đơn — chỉ cho ẩn
    await db.orm.public.Listing.where({ id: listingId }).update({ status: "hidden" });
  } else {
    await db.orm.public.ListingImage.where({ listingId }).delete();
    await db.orm.public.CartItem.where({ listingId }).delete();
    await db.orm.public.Listing.where({ id: listingId }).delete();
  }

  revalidatePath("/sell/my");
}
