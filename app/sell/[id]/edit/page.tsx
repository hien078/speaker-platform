import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { db } from "@/src/prisma/db.client";
import { getCurrentUser } from "@/src/lib/auth";
import { BETA_PUBLICATION_CATEGORIES, listingRegimeForCategorySlug } from "@/src/lib/beta-categories";
import {
  LISTING_FULFILLMENT_METHODS,
  LISTING_MAX_IMAGES,
  PHOTO_CHECKLIST_SLOTS,
} from "@/src/lib/listing-schema";
import { labelOf, submitErrorText } from "@/src/lib/listing-error-text";
import { isModerationLocked } from "@/src/lib/moderation";
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
  const sp = (await searchParams) as { error?: string; saved?: string };
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const listing = await db.orm.public.Listing
    .where({ id })
    .include("images", (i) =>
      i.select("url", "checklistSlot").orderBy((img) => img.sortOrder.asc()))
    .include("category", (c) => c.select("id", "name", "slug"))
    .first();

  if (!listing || listing.sellerId !== user.id) notFound();

  // ─── R5 — moderation lock (review fix MEDIUM-1): tin bị moderation takedown
  // thì seller KHÔNG được sửa — guard qua isModerationLocked (Batch 3 helper
  // từ @/src/lib/moderation — KHÔNG hardcode status). Action đã guard
  // (LISTING_MODERATION_LOCKED — listings.ts); đây là read-only notice thay
  // cho form. Link kháng cáo: case gắn sanction takedown (Batch 3 appeal
  // route /appeal/[caseId] — case đã atomic actioned tại takedown S6 nên
  // subject appeal được; takedown không qua case → không có link).
  if (isModerationLocked(listing.status)) {
    const takedown = await db.orm.public.ModerationAction
      .where({ targetType: "listing", targetId: listing.id, actionType: "listing.taken_down" })
      .orderBy((a) => a.createdAt.desc())
      .first();
    return (
      <main className="mx-auto max-w-2xl px-4 py-16 text-center lg:px-8">
        <p className="text-lg font-bold">Tin đã bị gỡ bởi kiểm duyệt</p>
        <p className="mt-2 text-sm text-[var(--muted)]">
          Tin đang bị khóa bởi quyết định kiểm duyệt và không thể chỉnh sửa tại đây.
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <Link href="/sell/my" className="btn-secondary text-sm">Quay lại tin của tôi</Link>
          {takedown?.caseId != null && (
            <Link href={`/appeal/${takedown.caseId}`} className="btn-ghost text-sm">
              Xem quyết định kiểm duyệt
            </Link>
          )}
        </div>
      </main>
    );
  }

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
    // b4-holistic (round-1 LOW): KHÔNG .limit(200) — model là field BẮT BUỘC của
    // beta (MODEL_REQUIRED); cap 200 chặn model #201+ (seed cho phép ~500) và
    // LÀM TRỐNG select của listing đang giữ model đó (controlled select không
    // có option khớp → React chọn placeholder → save gửi productModelId="" →
    // MODEL_REQUIRED, blanking model của tin đang sửa).
    categoryIds.length > 0
      ? db.orm.public.ProductModel
          .where({ status: "approved" })
          .where((m) => m.categoryId.in(categoryIds))
          .select("id", "name", "brandId")
          .orderBy((m) => m.name.asc())
          .all()
      : Promise.resolve([]),
    // Bước 7 — trạng thái từng yêu cầu publication (đọc FRESH từ DB)
    checkSellerPublicationRequirements(user.id),
    // legacy regime (b4-holistic round-1 LOW): CHỈ category HIỆN TẠI của tin —
    // ListingForm không có input structured (inventoryContext/fulfillment/
    // province/location) nên chọn category khác là ngõ cụt vĩnh viễn: beta →
    // các code REQUIRED cho field form không có; legacy khác → CATEGORY_NOT_
    // PUBLICATION_ALLOWED. Chuyển danh mục = tạo tin mới (A10). Server vẫn
    // assertCategoryPublicationAllowed (allowlist hoặc giữ nguyên category).
    regime === "legacy"
      ? db.orm.public.Category.where({ id: listing.categoryId }).all()
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

  // b4-holistic (round-1 LOW): model của tin ĐANG SỬA mà không nằm trong danh
  // sách loaded (không còn approved — pending/merged) → fetch riêng và APPEND
  // — controlled select có option khớp, save không blanking model; badge
  // "Model chờ duyệt/đã gộp" ở /admin/listings vẫn cảnh báo moderator.
  if (
    regime === "beta" &&
    listing.productModelId != null &&
    !models.some((m) => m.id === listing.productModelId)
  ) {
    const own = await db.orm.public.ProductModel
      .where({ id: listing.productModelId })
      .select("id", "name", "brandId")
      .first();
    if (own !== null) models.push(own);
  }

  // b4-holistic (LOW form-action-contract): banner ?error= CHỈ hiển thị khi
  // listing VẪN là draft — ?error= là đích redirect của submitListingAction
  // (submit bị chặn → listing GIỮ draft). Listing đã pending/approved thì
  // banner là STALE (submit ở tab khác đã thành công) → KHÔNG render — seller
  // không còn thấy "Thêm ít nhất 1 ảnh" đỏ sau khi submit thành công.
  const submitError = listing.status === "draft" && sp.error != null && sp.error !== "" ? sp.error : null;
  // ?saved=draft — saveListingDraftAction redirect sau khi TẠO draft (so sánh
  // literal, không echo query); chỉ hiện khi tin vẫn là draft.
  const draftJustSaved = sp.saved === "draft" && listing.status === "draft" && submitError === null;

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
          {/* LOW-1: lookup own-property-safe — code lạ/prototype key (?error=__proto__)
              → generic, KHÔNG crash (map + helper sống ở src/lib/listing-error-text.ts) */}
          {submitErrorText(submitError)}
        </div>
      )}

      {draftJustSaved && (
        <div className="mt-5 rounded-xl border border-[var(--green)]/35 bg-[var(--green-soft)] px-4 py-3 text-sm text-[var(--green)]">
          ✓ Đã lưu nháp — tiếp tục hoàn thiện rồi gửi duyệt khi sẵn sàng.
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
              label: labelOf(FULFILLMENT_METHOD_LABELS, value, value),
            }))}
            photoSlots={PHOTO_CHECKLIST_SLOTS.map((value) => ({
              value,
              label: labelOf(PHOTO_CHECKLIST_SLOT_LABELS, value, value),
            }))}
            requirementLabels={SELLER_PUBLICATION_REQUIREMENT_LABELS}
            verification={{ ok: verification.ok, missing: verification.missing }}
            maxImages={LISTING_MAX_IMAGES}
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
