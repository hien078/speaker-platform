import { redirect } from "next/navigation";
import { db } from "@/src/prisma/db.client";
import { getCurrentUser } from "@/src/lib/auth";
import { BETA_PUBLICATION_CATEGORIES } from "@/src/lib/beta-categories";
import { LISTING_FULFILLMENT_METHODS, PHOTO_CHECKLIST_SLOTS } from "@/src/lib/listing-schema";
import { labelOf } from "@/src/lib/listing-error-text";
import { PROVINCES } from "@/src/lib/provinces";
import {
  checkSellerPublicationRequirements,
  SELLER_PUBLICATION_REQUIREMENT_LABELS,
} from "@/src/lib/seller-verification-policy";
import {
  CONDITION_LABELS,
  FULFILLMENT_METHOD_LABELS,
  INVENTORY_CONTEXT_LABELS,
  PHOTO_CHECKLIST_SLOT_LABELS,
} from "@/src/lib/constants";
import { PortableListingForm } from "@/src/components/portable-listing-form";
import { Package } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Đăng bán loa" };

/**
 * Đăng tin mới (Batch 4 Task 5 — spec §5.6.1/§6.3): CHỈ category trong
 * BETA_PUBLICATION_CATEGORIES (server-owned allowlist — lọc server-side,
 * KHÔNG client flag); model = ProductModel approved của các category đó;
 * verification check (Batch 2 — đọc FRESH từ DB) truyền cho bước 7 của form.
 * Mọi label/slot/tỉnh đến từ props — client form KHÔNG import module server.
 */
export default async function SellNewPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  // Category allowlist (spec §5.6.1) — lọc server-side sau query active
  const activeCategories = await db.orm.public.Category
    .where({ isActive: true })
    .orderBy((c) => c.sortOrder.asc())
    .all();
  const categories = activeCategories.filter((c) =>
    (BETA_PUBLICATION_CATEGORIES as readonly string[]).includes(c.slug),
  );
  const categoryIds = categories.map((c) => c.id);

  const [brands, models, verification] = await Promise.all([
    db.orm.public.Brand.orderBy((b) => b.name.asc()).all(),
    // model chuẩn: approved + thuộc các category allowlist (canonical-model gate)
    categoryIds.length > 0
      ? db.orm.public.ProductModel
          .where({ status: "approved" })
          .where((m) => m.categoryId.in(categoryIds))
          .select("id", "name", "brandId")
          .orderBy((m) => m.name.asc())
          .limit(200)
          .all()
      : Promise.resolve([]),
    // Bước 7 — trạng thái từng yêu cầu publication (đọc FRESH từ DB, kể cả suspension)
    checkSellerPublicationRequirements(user.id),
  ]);

  return (
    <main className="mx-auto max-w-2xl px-4 py-10 lg:px-8">
      <h1 className="flex items-center gap-2.5 text-2xl font-extrabold tracking-tight">
        <Package className="size-6 text-[var(--accent)]" />
        Đăng bán loa
      </h1>
      <p className="mt-1.5 text-sm text-[var(--muted)]">
        Tin của bạn sẽ được quản trị duyệt trước khi hiển thị — thường trong 24 giờ.
      </p>

      <div className="card mt-8 p-6">
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
        />
      </div>
    </main>
  );
}
