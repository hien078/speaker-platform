import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { db } from "@/src/prisma/db";
import { getCurrentUser } from "@/src/lib/auth";
import { ListingForm } from "@/src/components/listing-form";
import { CITIES, CONDITION_LABELS } from "@/src/lib/constants";
import { ArrowLeft, Pencil } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sửa tin đăng" };

export default async function EditListingPage({
  params,
}: PageProps<"/sell/[id]/edit">) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const listing = await db.orm.public.Listing
    .where({ id })
    .include("images", (i) => i.select("url").orderBy((img) => img.sortOrder.asc()))
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

  const [categories, brands, models] = await Promise.all([
    db.orm.public.Category.where({ isActive: true }).orderBy((c) => c.sortOrder.asc()).all(),
    db.orm.public.Brand.orderBy((b) => b.name.asc()).all(),
    db.orm.public.ProductModel
      .where({ status: "approved" })
      .select("id", "name", "brandId")
      .orderBy((m) => m.name.asc())
      .limit(200)
      .all(),
  ]);

  return (
    <main className="mx-auto max-w-2xl px-4 py-10 lg:px-8">
      <Link href="/sell/my" className="btn-ghost mb-5 h-9 px-3 text-sm">
        <ArrowLeft className="size-4" />
        Về tin của tôi
      </Link>

      <h1 className="flex items-center gap-2.5 text-2xl font-extrabold tracking-tight">
        <Pencil className="size-6 text-amber-400" />
        Sửa tin đăng
      </h1>
      <p className="mt-1.5 text-sm text-zinc-500">
        Thay đổi nội dung chính (tiêu đề, giá, mô tả…) sẽ đưa tin quay lại hàng chờ duyệt.
      </p>

      <div className="card mt-8 p-6">
        <ListingForm
          categories={categories.map((c) => ({ id: c.id, name: c.name, commissionRate: c.commissionRate }))}
          brands={brands.map((b) => ({ id: b.id, name: b.name }))}
          cities={CITIES}
          models={models.map((m) => ({ id: m.id, name: m.name, brandId: m.brandId }))}
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
      </div>
    </main>
  );
}
