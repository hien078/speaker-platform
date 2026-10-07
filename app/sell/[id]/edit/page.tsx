import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { db } from "@/src/prisma/db.client";
import { getCurrentUser } from "@/src/lib/auth";
import { BETA_PUBLICATION_CATEGORIES, listingRegimeForCategorySlug } from "@/src/lib/beta-categories";
import { LISTING_FULFILLMENT_METHODS, PHOTO_CHECKLIST_SLOTS } from "@/src/lib/listing-schema";
import { PROVINCES } from "@/src/lib/provinces";
import {
  checkSellerPublicationRequirements,
  SELLER_PUBLICATION_REQUIREMENT_LABELS,
} from "@/src/lib/seller-verification-policy";
import { submitListingAction } from "@/src/lib/actions/listings";
import {
  CITIES,
  CONDITION_LABELS,
  FULFILLMENT_METHOD_LABELS,
  INVENTORY_CONTEXT_LABELS,
  PHOTO_CHECKLIST_SLOT_LABELS,
} from "@/src/lib/constants";
import { ListingForm } from "@/src/components/listing-form";
import { PortableListingForm } from "@/src/components/portable-listing-form";
import { ArrowLeft, Pencil, Send } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sửa tin đăng" };

/**
 * ?error= typed code → thông báo tiếng Việt (đích redirect của submitListingAction —
 * Batch 4 Task 4/5). CHỈ cho phép typed code cố định; giá trị lạ → generic (fail
 * closed — KHÔNG phản chiếu query text). CONCURRENT_CHANGE: submit đụng trạng
 * thái đổi tay (claim 0 row — parallel note của Task 4 review-fix).
 */
const SUBMIT_ERROR_TEXT: Record<string, string> = {
  CONCURRENT_CHANGE: "Tin vừa thay đổi trạng thái — tải lại trang và kiểm tra lại",
  RATE_LIMITED: "Bạn thao tác quá nhanh — thử lại sau ít phút",
  CONTENT_INVALID: "Nội dung tin chưa hợp lệ — kiểm tra lại các bước",
  CATEGORY_NOT_PUBLICATION_ALLOWED: "Danh mục chưa mở cho đăng tin trong giai đoạn beta",
  CATEGORY_NOT_FOUND: "Danh mục không hợp lệ",
  CATEGORY_REQUIRED: "Chọn danh mục",
  BRAND_REQUIRED: "Chọn thương hiệu",
  MODEL_REQUIRED: "Chọn model sản phẩm",
  MODEL_INVALID: "Model sản phẩm không hợp lệ",
  MODEL_BRAND_MISMATCH: "Model không thuộc thương hiệu đã chọn",
  IMAGE_REQUIRED: "Thêm ít nhất 1 ảnh sản phẩm",
  IMAGE_TOO_MANY: "Tối đa 8 ảnh",
  IMAGE_NOT_OWNED: "Ảnh không thuộc về bạn — tải ảnh lại từ thiết bị",
  IMAGE_URL_INVALID: "Đường dẫn ảnh không hợp lệ",
  IMAGE_DUPLICATE: "Ảnh bị trùng lặp",
  IMAGE_SLOT_INVALID: "Slot ảnh không hợp lệ",
  IMAGE_SLOT_MISMATCH: "Số ảnh và số slot không khớp",
  TITLE_INVALID: "Tiêu đề từ 8–120 ký tự",
  DESCRIPTION_INVALID: "Mô tả từ 20–4.000 ký tự",
  PRICE_INVALID: "Giá từ 100.000₫ đến 2 tỷ ₫",
  CONDITION_REQUIRED: "Chọn tình trạng sản phẩm",
  CONDITION_INVALID: "Tình trạng sản phẩm không hợp lệ",
  INVENTORY_CONTEXT_REQUIRED: "Chọn nguồn hàng (mới / mở hộp / đã qua sử dụng)",
  INVENTORY_CONTEXT_INVALID: "Nguồn hàng không hợp lệ",
  FREE_TEXT_INVALID: "Nội dung quá dài (tối đa 2.000 ký tự)",
  FULFILLMENT_REQUIRED: "Chọn ít nhất 1 phương thức giao hàng",
  FULFILLMENT_INVALID: "Phương thức giao hàng không hợp lệ",
  FULFILLMENT_DUPLICATE: "Phương thức giao hàng bị trùng",
  PROVINCE_REQUIRED: "Chọn tỉnh/thành phố",
  PROVINCE_INVALID: "Mã tỉnh/thành phố không hợp lệ",
  LOCATION_DISPLAY_REQUIRED: "Nhập khu vực hiển thị (không nhập địa chỉ nhà riêng)",
  LOCATION_DISPLAY_INVALID: "Khu vực hiển thị quá dài (tối đa 120 ký tự)",
};

/**
 * Sửa tin (Batch 4 Task 5): regime switch THEO CATEGORY SLUG của listing
 * (listingRegimeForCategorySlug — category include để đọc slug từ DB row):
 *  - beta  → PortableListingForm (7 bước §6.3, structured fields);
 *  - legacy → ListingForm hiện tại GIỮ NGUYÊN (grandfathered — spec §8/§8.3).
 * Draft: form "Lưu nháp" (saveListingDraftAction, trong PortableListingForm) +
 * form "Gửi duyệt" (submitListingAction — đọc DB row, KHÔNG updateListingAction:
 * draft→draft không transition).
 */
export default async function EditListingPage({
  params,
  searchParams,
}: PageProps<"/sell/[id]/edit">) {
  const { id } = await params;
  const sp = (await searchParams) as { error?: string };
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const listing = await db.orm.public.Listing
    .where({ id })
    .include("images", (i) =>
      i.select("url", "checklistSlot").orderBy((img) => img.sortOrder.asc()))
    .include("category", (c) => c.select("id", "name", "slug"))
    .first();

  if (!listing || listing.sellerId !== user.id) notFound();
  if (listing.status === "sold") {
    return (
      <main className="mx-auto max-w-2xl px-4 py-16 text-center lg:px-8">
        <p className="text-lg font-bold">Tin đã bán — không thể chỉnh sửa</p>
        <Link href="/sell/my" className="btn-secondary mt-4 text-sm">Quay lại tin của tôi</Link>
      </main>
    );
  }

  // Regime derive TỪ DB row (category slug) — KHÔNG tin formData/client
  const regime = listingRegimeForCategorySlug(listing.category!.slug);

  // ─── Dữ liệu chung cho form beta (categories allowlist + models + verification) ───
  const activeCategories = regime === "beta"
    ? await db.orm.public.Category.where({ isActive: true }).orderBy((c) => c.sortOrder.asc()).all()
    : [];
  const categories = activeCategories.filter((c) =>
    (BETA_PUBLICATION_CATEGORIES as readonly string[]).includes(c.slug),
  );
  const categoryIds = categories.map((c) => c.id);

  const [brands, models, verification, legacyCategories, legacyModels] = await Promise.all([
    db.orm.public.Brand.orderBy((b) => b.name.asc()).all(),
    categoryIds.length > 0
      ? db.orm.public.ProductModel
          .where({ status: "approved" })
          .where((m) => m.categoryId.in(categoryIds))
          .select("id", "name", "brandId")
          .orderBy((m) => m.name.asc())
          .limit(200)
          .all()
      : Promise.resolve([]),
    // Bước 7 — trạng thái từng yêu cầu publication (đọc FRESH từ DB)
    checkSellerPublicationRequirements(user.id),
    // legacy regime: giữ nguyên dữ liệu form hiện tại (grandfathered)
    regime === "legacy"
      ? db.orm.public.Category.where({ isActive: true }).orderBy((c) => c.sortOrder.asc()).all()
      : Promise.resolve([]),
    regime === "legacy"
      ? db.orm.public.ProductModel
          .where({ status: "approved" })
          .select("id", "name", "brandId")
          .orderBy((m) => m.name.asc())
          .limit(200)
          .all()
      : Promise.resolve([]),
  ]);

  const submitError = sp.error != null && sp.error !== "" ? sp.error : null;

  return (
    <main className="mx-auto max-w-2xl px-4 py-10 lg:px-8">
      <Link href="/sell/my" className="btn-ghost mb-5 h-9 px-3 text-sm">
        <ArrowLeft className="size-4" />
        Về tin của tôi
      </Link>

      <h1 className="flex items-center gap-2.5 text-2xl font-extrabold tracking-tight">
        <Pencil className="size-6 text-[var(--accent)]" />
        Sửa tin đăng
      </h1>
      <p className="mt-1.5 text-sm text-[var(--muted)]">
        {regime === "beta"
          ? "Thay đổi nội dung sẽ đưa tin quay lại hàng chờ duyệt."
          : "Thay đổi nội dung chính (tiêu đề, giá, mô tả…) sẽ đưa tin quay lại hàng chờ duyệt."}
      </p>

      {submitError !== null && (
        <div className="mt-5 rounded-xl border border-[var(--red)]/35 bg-[var(--red-soft)] px-4 py-3 text-sm text-[var(--red)]">
          {SUBMIT_ERROR_TEXT[submitError] ?? SUBMIT_ERROR_TEXT.CONTENT_INVALID}
        </div>
      )}

      <div className="card mt-8 p-6">
        {regime === "beta" ? (
          <PortableListingForm
            categories={categories.map((c) => ({ id: c.id, name: c.name }))}
            brands={brands.map((b) => ({ id: b.id, name: b.name }))}
            models={models.map((m) => ({ id: m.id, name: m.name, brandId: m.brandId }))}
            provinces={PROVINCES.map((p) => ({ code: p.code, displayName: p.displayName }))}
            conditions={Object.entries(CONDITION_LABELS).map(([value, label]) => ({ value, label }))}
            inventoryContexts={Object.entries(INVENTORY_CONTEXT_LABELS).map(([value, label]) => ({ value, label }))}
            fulfillmentMethods={LISTING_FULFILLMENT_METHODS.map((value) => ({
              value,
              label: FULFILLMENT_METHOD_LABELS[value] ?? value,
            }))}
            photoSlots={PHOTO_CHECKLIST_SLOTS.map((value) => ({
              value,
              label: PHOTO_CHECKLIST_SLOT_LABELS[value] ?? value,
            }))}
            requirementLabels={SELLER_PUBLICATION_REQUIREMENT_LABELS}
            verification={{ ok: verification.ok, missing: verification.missing }}
            edit={{
              listingId: listing.id,
              status: listing.status,
              title: listing.title,
              description: listing.description,
              price: listing.price,
              categoryId: listing.categoryId,
              brandId: listing.brandId,
              productModelId: listing.productModelId,
              condition: listing.condition,
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
              imageUrls: listing.images.map((i) => i.url),
              imageSlots: listing.images.map((i) => i.checklistSlot ?? null),
            }}
          />
        ) : (
          <ListingForm
            categories={legacyCategories.map((c) => ({ id: c.id, name: c.name }))}
            brands={brands.map((b) => ({ id: b.id, name: b.name }))}
            cities={CITIES}
            models={legacyModels.map((m) => ({ id: m.id, name: m.name, brandId: m.brandId }))}
            conditions={Object.entries(CONDITION_LABELS).map(([value, label]) => ({ value, label }))}
            edit={{
              listingId: listing.id,
              title: listing.title,
              description: listing.description,
              price: listing.price,
              categoryId: listing.categoryId,
              brandId: listing.brandId,
              condition: listing.condition,
              city: listing.city,
              negotiable: listing.negotiable,
              acceptExchange: listing.acceptExchange,
              imageUrls: listing.images.map((i) => i.url),
              productModelId: listing.productModelId,
            }}
          />
        )}
      </div>

      {/* Draft → Gửi duyệt (spec §5.6.2): submitListingAction đọc DB row (trust
          boundary — formData chỉ mang listingId), KHÔNG dùng updateListingAction
          cho draft (draft→draft, không transition). Nội dung gửi = nội dung ĐÃ
          LƯU (Lưu nháp) — lưu trước rồi gửi. */}
      {listing.status === "draft" && (
        <form action={submitListingAction} className="card mt-4 flex items-center justify-between gap-4 p-5">
          <input type="hidden" name="listingId" value={listing.id} />
          <p className="text-sm text-[var(--muted)]">
            Gửi duyệt dùng nội dung đã lưu — bấm <b>Lưu nháp</b> trước nếu bạn vừa chỉnh sửa.
          </p>
          <button type="submit" className="btn-primary h-10 shrink-0 px-4 text-sm">
            <Send className="size-4" />
            Gửi duyệt
          </button>
        </form>
      )}
    </main>
  );
}
